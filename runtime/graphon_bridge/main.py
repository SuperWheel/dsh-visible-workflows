"""Private JSONL bridge to the unmodified Graphon 0.7.0 graph engine.

DSH owns node implementations, scopes, permissions and durable run snapshots.
Graphon owns edge activation, dependency readiness and skipped-path propagation.
The protocol never evaluates Python supplied by a workflow or imports built-in
model/document nodes. Each graph uses one worker; independent/nested graphs can
run concurrently. A paused graph is released: the host replays *cached results*
into a fresh graph when resuming, never the side effects themselves.
"""

from __future__ import annotations

import hashlib
from importlib.metadata import version as installed_version
import json
import logging
import os
import queue
import sys
import threading
import time
import uuid
from collections import defaultdict
from collections.abc import Callable, Generator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from graphon.entities.base_node_data import BaseNodeData
from graphon.entities.graph_init_params import GraphInitParams
from graphon.entities.pause_reason import SchedulingPause
from graphon.enums import NodeExecutionType, NodeState, WorkflowNodeExecutionStatus
from graphon.graph.edge import Edge
from graphon.graph.graph import Graph
from graphon.graph.validation import get_graph_validator
from graphon.graph_engine.command_channels.in_memory_channel import InMemoryChannel
from graphon.graph_engine.config import GraphEngineConfig
from graphon.graph_engine.graph_engine import GraphEngine
from graphon.graph_events.graph import (
    GraphRunAbortedEvent,
    GraphRunFailedEvent,
    GraphRunPausedEvent,
    GraphRunSucceededEvent,
)
from graphon.node_events.base import NodeEventBase, NodeRunResult
from graphon.node_events.node import PauseRequestedEvent, StreamCompletedEvent
from graphon.nodes.base.node import Node
from graphon.runtime.graph_runtime_state import GraphRuntimeState
from graphon.runtime.variable_pool import VariablePool

PROTOCOL = 1
ENGINE_VERSION = "0.7.0"
MAX_MESSAGE_BYTES = 16 * 1024 * 1024
MAX_GRAPHS = 128
BRANCH_KINDS = frozenset(("if", "classifier", "human"))
ACTIVE_HANDLE = "dsh:active"
INACTIVE_HANDLE = "dsh:inactive"


@dataclass
class PendingCall:
    run_id: str
    response: queue.Queue[dict[str, Any]] = field(default_factory=lambda: queue.Queue(maxsize=1))


@dataclass
class Execution:
    id: str
    cancelled: threading.Event = field(default_factory=threading.Event)
    engine: GraphEngine | None = None
    graph: Graph | None = None
    control: str | None = None
    original_ports: dict[str, str] = field(default_factory=dict)
    thread: threading.Thread | None = None


class BridgeNode(Node[BaseNodeData]):
    """An explicit extension node; no Graphon built-in node registry bootstrap."""

    node_type = "dsh:bridge"

    @classmethod
    def version(cls) -> str:
        return "1"

    def _run(self) -> Generator[NodeEventBase, None, None]:
        service: BridgeService = self.require_run_context_value("bridge")
        run: Execution = self.require_run_context_value("execution")
        response = service.call(run, self.id)
        if response.get("error") is not None:
            yield StreamCompletedEvent(node_run_result=NodeRunResult(
                status=WorkflowNodeExecutionStatus.FAILED,
                error=str(response["error"]), error_type="DSHNodeError",
            ))
            return
        control = response.get("control")
        if control in ("pause", "exit_loop"):
            run.control = control
            yield PauseRequestedEvent(reason=SchedulingPause(message=f"DSH {control}"))
            return
        if control is not None:
            raise ValueError(f"Unsupported node control: {control}")
        data = response.get("data", {})
        if not isinstance(data, dict):
            raise ValueError("Node result data must be a JSON object")
        if self.execution_type == NodeExecutionType.BRANCH:
            # Graphon selects one handle. Map the host's port set to a single
            # active handle in this private graph, retaining Graphon's traversal.
            active_ports = response.get("activePorts")
            selected = response.get("selectedPort")
            if active_ports is None:
                active_ports = [selected] if selected is not None else None
                if self.node_data.get("kind") == "human" and selected != "timeout":
                    active_ports = [*(active_ports or []), "default"]
            if active_ports is not None and (
                not isinstance(active_ports, list)
                or any(not isinstance(port, str) for port in active_ports)
            ):
                raise ValueError("activePorts must be a list of strings")
            assert run.graph is not None
            for edge in run.graph.get_outgoing_edges(self.id):
                edge.source_handle = (
                    ACTIVE_HANDLE
                    if active_ports is None or run.original_ports[edge.id] in active_ports
                    else INACTIVE_HANDLE
                )
        yield StreamCompletedEvent(node_run_result=NodeRunResult(
            status=WorkflowNodeExecutionStatus.SUCCEEDED,
            outputs=data,
            edge_source_handle=ACTIVE_HANDLE,
        ))


def build_graph(payload: Any, run: Execution, service: BridgeService) -> tuple[Graph, GraphRuntimeState]:
    if not isinstance(payload, dict) or not isinstance(payload.get("nodes"), list) or not isinstance(payload.get("edges"), list):
        raise ValueError("graph must contain nodes and edges arrays")
    configs = payload["nodes"]
    if not configs or len(configs) > 2000 or len(payload["edges"]) > 10000:
        raise ValueError("Graph must have 1..2000 nodes and at most 10000 edges")
    state = GraphRuntimeState(variable_pool=VariablePool(), start_at=time.monotonic())
    params = GraphInitParams(workflow_id=run.id, graph_config={}, run_context={"bridge": service, "execution": run}, call_depth=0)
    nodes: dict[str, BridgeNode] = {}
    roots: list[BridgeNode] = []
    for config in configs:
        if not isinstance(config, dict) or not isinstance(config.get("id"), str) or not config["id"] or not isinstance(config.get("kind"), str):
            raise ValueError("Each node needs a nonempty id and kind")
        node_id, kind = config["id"], config["kind"]
        if node_id in nodes:
            raise ValueError(f"Duplicate node id: {node_id}")
        node = BridgeNode(node_id, BaseNodeData(type="dsh:bridge", title=node_id, kind=kind), graph_init_params=params, graph_runtime_state=state)
        if kind == "input":
            node.execution_type = NodeExecutionType.ROOT
            roots.append(node)
        elif kind in BRANCH_KINDS:
            node.execution_type = NodeExecutionType.BRANCH
        nodes[node_id] = node
    if len(roots) != 1:
        raise ValueError("Each graph must have exactly one input node")
    edges: dict[str, Edge] = {}
    incoming: dict[str, list[str]] = defaultdict(list)
    outgoing: dict[str, list[str]] = defaultdict(list)
    for config in payload["edges"]:
        if not isinstance(config, dict) or any(not isinstance(config.get(key), str) or not config[key] for key in ("id", "source", "target")):
            raise ValueError("Each edge needs nonempty id, source and target")
        edge_id = config["id"]
        if edge_id in edges:
            raise ValueError(f"Duplicate edge id: {edge_id}")
        port = config.get("port") or "default"
        if not isinstance(port, str):
            raise ValueError("Edge port must be a string")
        edge = Edge(id=edge_id, tail=config["source"], head=config["target"], source_handle=port)
        edges[edge_id] = edge
        run.original_ports[edge_id] = port
        incoming[edge.head].append(edge_id)
        outgoing[edge.tail].append(edge_id)
    if incoming.get(roots[0].id):
        raise ValueError("Input node cannot have incoming edges")
    graph = Graph(nodes=nodes, edges=edges, in_edges=dict(incoming), out_edges=dict(outgoing), root_node=roots[0])
    get_graph_validator().validate(graph)
    # Host validates the graph before dispatch. Reject cycles and disconnected
    # nodes here too; this is validation, never an execution order or scheduler.
    visited: set[str] = set()
    visiting: set[str] = set()

    def visit(node_id: str) -> None:
        if node_id in visiting:
            raise ValueError("Cycle detected; loops must use an explicit container")
        if node_id in visited:
            return
        visiting.add(node_id)
        for edge_id in outgoing.get(node_id, []):
            visit(edges[edge_id].head)
        visiting.remove(node_id)
        visited.add(node_id)

    visit(roots[0].id)
    if len(visited) != len(nodes):
        raise ValueError("All executable nodes must be reachable from the input")
    run.graph = graph
    return graph, state


def count_tokens(text: Any, encoding: str = "cl100k_base") -> dict[str, Any]:
    if not isinstance(text, str):
        raise ValueError("text must be a string")
    if encoding != "cl100k_base":
        raise ValueError("Only bundled cl100k_base token estimation is supported")
    cache_dir = os.environ.get("TIKTOKEN_CACHE_DIR")
    if not cache_dir:
        raise RuntimeError("TIKTOKEN_CACHE_DIR is not configured; offline vocabulary is required")
    url = "https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken"
    vocab = Path(cache_dir) / hashlib.sha1(url.encode(), usedforsecurity=False).hexdigest()
    if not vocab.is_file():
        raise RuntimeError("Bundled cl100k_base vocabulary is missing; no network fallback is allowed")
    expected = "223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7"
    if hashlib.sha256(vocab.read_bytes()).hexdigest() != expected:
        raise RuntimeError("Bundled cl100k_base vocabulary failed checksum verification")
    import tiktoken

    counter = tiktoken.get_encoding(encoding)
    return {"count": len(counter.encode(text, disallowed_special=())), "encoding": encoding, "estimated": True}


class BridgeService:
    def __init__(self, emit: Callable[[dict[str, Any]], None]) -> None:
        self.emit = emit
        self.lock = threading.RLock()
        self.executions: dict[str, Execution] = {}
        self.pending: dict[str, PendingCall] = {}

    def call(self, run: Execution, node_id: str) -> dict[str, Any]:
        call_id = uuid.uuid4().hex
        call = PendingCall(run_id=run.id)
        with self.lock:
            if run.cancelled.is_set():
                return {"error": "Workflow cancelled"}
            self.pending[call_id] = call
            self.emit({"type": "call", "id": run.id, "callId": call_id, "nodeId": node_id})
        try:
            while not run.cancelled.is_set():
                try:
                    return call.response.get(timeout=0.25)
                except queue.Empty:
                    continue
            return {"error": "Workflow cancelled"}
        finally:
            with self.lock:
                self.pending.pop(call_id, None)

    def execute(self, message: dict[str, Any]) -> None:
        run_id = require_id(message)
        with self.lock:
            if run_id in self.executions:
                raise ValueError("Duplicate active execute id")
            if len(self.executions) >= MAX_GRAPHS:
                raise ValueError("Too many active graph executions")
            run = Execution(run_id)
            self.executions[run_id] = run
            run.thread = threading.Thread(target=self._execute, args=(run, message.get("graph")), daemon=True, name=f"DSHGraph-{run_id[:32]}")
            run.thread.start()

    def _execute(self, run: Execution, payload: Any) -> None:
        status, error = "failed", None
        skipped: set[str] = set()
        try:
            graph, state = build_graph(payload, run, self)
            run.engine = GraphEngine(workflow_id=run.id, graph=graph, graph_runtime_state=state, command_channel=InMemoryChannel(), config=GraphEngineConfig(min_workers=1, max_workers=1))
            if run.cancelled.is_set():
                run.engine.request_abort("Workflow cancelled")
            for event in run.engine.run():
                for node_id, node in graph.nodes.items():
                    if node.state == NodeState.SKIPPED and node_id not in skipped:
                        skipped.add(node_id)
                        self.emit({"type": "skipped", "id": run.id, "nodeId": node_id})
                if isinstance(event, GraphRunSucceededEvent):
                    status = "success"
                elif isinstance(event, GraphRunPausedEvent):
                    status = "exit_loop" if run.control == "exit_loop" else "paused"
                elif isinstance(event, GraphRunFailedEvent):
                    status, error = "failed", event.error
                elif isinstance(event, GraphRunAbortedEvent):
                    status, error = "failed", event.reason
        except Exception as exc:
            error = str(exc)
            logging.getLogger(__name__).debug("Graph execution failed", exc_info=True)
        finally:
            if run.cancelled.is_set():
                status, error = "failed", "Workflow cancelled"
            with self.lock:
                for call_id, call in list(self.pending.items()):
                    if call.run_id == run.id:
                        self.pending.pop(call_id, None)
                self.executions.pop(run.id, None)
            result: dict[str, Any] = {"type": "complete", "id": run.id, "status": status}
            if error:
                result["error"] = error
            if run.cancelled.is_set():
                result["cancelled"] = True
            self.emit(result)

    def handle(self, message: Any) -> None:
        if not isinstance(message, dict):
            raise ValueError("Protocol message must be an object")
        kind = message.get("type")
        if kind == "execute":
            self.execute(message)
        elif kind == "result":
            call_id = message.get("callId")
            if not isinstance(call_id, str):
                raise ValueError("result requires callId")
            with self.lock:
                call = self.pending.get(call_id)
                if call is not None:
                    try:
                        call.response.put_nowait(message)
                    except queue.Full:
                        pass  # Late/duplicate replies must never repeat a node.
        elif kind == "cancel":
            self.cancel(require_id(message))
        elif kind == "count_tokens":
            request_id = require_id(message)
            try:
                self.emit({"type": "tokens", "id": request_id, **count_tokens(message.get("text"), message.get("encoding", "cl100k_base"))})
            except Exception as exc:
                self.emit({"type": "tokens", "id": request_id, "error": str(exc)})
        else:
            raise ValueError(f"Unknown protocol message type: {kind}")

    def cancel(self, run_id: str) -> None:
        with self.lock:
            run = self.executions.get(run_id)
            if run is None:
                return
            run.cancelled.set()
            if run.engine is not None:
                run.engine.request_abort("Workflow cancelled")

    def close(self) -> None:
        with self.lock:
            runs = list(self.executions.values())
        for run in runs:
            self.cancel(run.id)
        deadline = time.monotonic() + 5
        for run in runs:
            if run.thread is not None:
                run.thread.join(max(0, deadline - time.monotonic()))


def require_id(message: dict[str, Any]) -> str:
    value = message.get("id")
    if not isinstance(value, str) or not value or len(value) > 512:
        raise ValueError("Protocol id must be a nonempty string of at most 512 characters")
    return value


def main() -> None:
    logging.basicConfig(stream=sys.stderr, level=logging.ERROR)
    if installed_version("graphon") != ENGINE_VERSION:
        raise RuntimeError(f"Graphon {ENGINE_VERSION} is required for protocol {PROTOCOL}")
    output_lock = threading.Lock()

    def emit(message: dict[str, Any]) -> None:
        payload = json.dumps(message, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        with output_lock:
            sys.stdout.write(payload + "\n")
            sys.stdout.flush()

    service = BridgeService(emit)
    emit({"type": "ready", "engine": "graphon", "version": ENGINE_VERSION, "protocol": PROTOCOL})
    try:
        while True:
            raw = sys.stdin.buffer.readline(MAX_MESSAGE_BYTES + 1)
            if not raw:
                break
            if len(raw) > MAX_MESSAGE_BYTES:
                emit({"type": "error", "error": "Protocol message exceeds 16 MiB"})
                break
            message: Any = None
            try:
                message = json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"Invalid JSON number: {value}")))
                service.handle(message)
            except Exception as exc:
                emit({"type": "error", "id": message.get("id") if isinstance(message, dict) else None, "error": str(exc)})
    finally:
        service.close()


if __name__ == "__main__":
    main()
