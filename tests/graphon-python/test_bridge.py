"""Process-level tests against the real Graphon engine, without model calls."""

import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading

import pytest


ENTRY = Path(__file__).resolve().parents[2] / "runtime" / "graphon_bridge" / "main.py"


class Client:
    def __init__(self, env=None):
        self.process = subprocess.Popen(
            [os.environ.get("GRAPHON_BRIDGE_PYTHON", sys.executable), "-I", "-u", str(ENTRY)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=env or os.environ.copy(),
        )
        self.messages = queue.Queue()
        self.stderr = []
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=lambda: self.stderr.extend(self.process.stderr), daemon=True).start()
        assert self.next() == {"type": "ready", "engine": "graphon", "version": "0.7.0", "protocol": 1}

    def _read(self):
        for line in self.process.stdout:
            self.messages.put(json.loads(line))

    def send(self, message):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def next(self):
        try:
            return self.messages.get(timeout=8)
        except queue.Empty:
            raise AssertionError(f"Bridge did not respond. stderr={''.join(self.stderr)}")

    def reply(self, call, **result):
        self.send({"type": "result", "callId": call["callId"], "data": {}, **result})

    def execute(self, nodes, edges, run_id="run"):
        self.send({"type": "execute", "id": run_id, "graph": {
            "nodes": [{"id": name, "kind": kind} for name, kind in nodes],
            "edges": [{"id": f"e{i}", "source": edge[0], "target": edge[1], **({"port": edge[2]} if len(edge) > 2 else {})} for i, edge in enumerate(edges)],
        }})

    def drive(self, responses=None):
        responses = responses or {}
        events = []
        while True:
            event = self.next()
            events.append(event)
            if event["type"] == "call":
                self.reply(event, **responses.get(event["nodeId"], {}))
            elif event["type"] == "complete":
                return events

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()


@pytest.fixture
def client():
    value = Client()
    try:
        yield value
    finally:
        value.close()


def called(events):
    return [event["nodeId"] for event in events if event["type"] == "call"]


def test_dependency_order_and_diamond_merge(client):
    # Array order is deliberately non-topological: Graphon must schedule it.
    client.execute([("join", "output"), ("right", "tool"), ("start", "input"), ("left", "template")],
                   [("start", "left"), ("start", "right"), ("left", "join"), ("right", "join")])
    events = client.drive({"left": {"data": {"value": {"items": [1, False, None]}}}})
    assert called(events)[0] == "start"
    assert set(called(events)[1:3]) == {"left", "right"}
    assert called(events)[3:] == ["join"]
    assert events[-1]["status"] == "success"


def test_arbitrary_branch_ports_and_skipped_merge(client):
    client.execute([("start", "input"), ("choose", "classifier"), ("yes", "template"), ("no", "template"), ("join", "output")],
                   [("start", "choose"), ("choose", "yes", "自定义:a-1"), ("choose", "no", "other"), ("yes", "join"), ("no", "join")])
    events = client.drive({"choose": {"selectedPort": "自定义:a-1"}})
    assert called(events) == ["start", "choose", "yes", "join"]
    assert {event["nodeId"] for event in events if event["type"] == "skipped"} == {"no"}
    assert events[-1]["status"] == "success"


@pytest.mark.parametrize("response,expected", [
    ({"selectedPort": "approve"}, {"chosen", "default"}),
    ({"selectedPort": "timeout"}, {"timeout"}),
    ({"activePorts": ["approve", "default"]}, {"chosen", "default"}),
])
def test_human_action_and_default_ports(client, response, expected):
    client.execute([("start", "input"), ("human", "human"), ("chosen", "output"), ("default", "output"), ("timeout", "output")],
                   [("start", "human"), ("human", "chosen", "approve"), ("human", "default"), ("human", "timeout", "timeout")])
    events = client.drive({"human": response})
    assert set(called(events)[2:]) == expected
    assert events[-1]["status"] == "success"


@pytest.mark.parametrize("control,status", [("pause", "paused"), ("exit_loop", "exit_loop")])
def test_control_stops_downstream(client, control, status):
    client.execute([("start", "input"), ("gate", "human"), ("later", "output")], [("start", "gate"), ("gate", "later")])
    events = client.drive({"gate": {"control": control}})
    assert called(events) == ["start", "gate"]
    assert events[-1]["status"] == status
    # The same service is reusable after freeing the paused run.
    client.execute([("fresh", "input")], [], run_id="another")
    assert client.drive()[-1]["status"] == "success"


def test_failure_stops_downstream(client):
    client.execute([("start", "input"), ("broken", "tool"), ("later", "output")], [("start", "broken"), ("broken", "later")])
    events = client.drive({"broken": {"error": "工具不可用"}})
    assert called(events) == ["start", "broken"]
    assert events[-1]["status"] == "failed"
    assert "工具不可用" in events[-1]["error"]


def test_cancel_unblocks_pending_call_and_late_result(client):
    client.execute([("start", "input"), ("later", "output")], [("start", "later")])
    pending = client.next()
    assert pending["nodeId"] == "start"
    client.send({"type": "cancel", "id": "run"})
    result = client.next()
    assert result["type"] == "complete"
    assert result["status"] == "failed" and result["cancelled"] is True
    client.reply(pending, data={"late": True})
    client.execute([("fresh", "input")], [], run_id="fresh-run")
    events = client.drive()
    assert called(events) == ["fresh"]
    assert events[-1]["status"] == "success"


def test_nested_execute_while_parent_call_waits(client):
    client.execute([("start", "input"), ("container", "loop"), ("output", "output")], [("start", "container"), ("container", "output")], run_id="parent")
    client.reply(client.next())
    parent_call = client.next()
    assert parent_call["nodeId"] == "container"
    client.execute([("child-start", "input"), ("child-end", "output")], [("child-start", "child-end")], run_id="child")
    child_events = client.drive()
    assert called(child_events) == ["child-start", "child-end"]
    assert child_events[-1]["status"] == "success"
    assert parent_call["callId"] not in {event["callId"] for event in child_events if event["type"] == "call"}
    client.reply(parent_call)
    assert called(client.drive()) == ["output"]


def test_invalid_graph_does_not_call_host(client):
    client.execute([("start", "input"), ("a", "tool"), ("b", "tool")], [("start", "a"), ("a", "b"), ("b", "a")])
    result = client.next()
    assert result["type"] == "complete" and result["status"] == "failed"
    assert "Cycle" in result["error"]


def test_missing_offline_vocabulary_fails_without_network(tmp_path):
    env = {**os.environ, "TIKTOKEN_CACHE_DIR": str(tmp_path)}
    value = Client(env=env)
    try:
        value.send({"type": "count_tokens", "id": "token-estimate", "text": "测试"})
        result = value.next()
        assert result["type"] == "tokens" and "missing" in result["error"]
        assert list(tmp_path.iterdir()) == []
    finally:
        value.close()


def test_corrupt_offline_vocabulary_fails_without_network(tmp_path):
    url = "https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken"
    vocab = tmp_path / hashlib.sha1(url.encode(), usedforsecurity=False).hexdigest()
    vocab.write_text("corrupt vocabulary")
    value = Client(env={**os.environ, "TIKTOKEN_CACHE_DIR": str(tmp_path)})
    try:
        value.send({"type": "count_tokens", "id": "estimate", "text": "hello"})
        result = value.next()
        assert result["type"] == "tokens" and "checksum" in result["error"]
        assert vocab.read_text() == "corrupt vocabulary"
    finally:
        value.close()


@pytest.mark.skipif(not os.environ.get("TIKTOKEN_CACHE_DIR"), reason="requires prepared offline tokenizer payload")
def test_real_offline_token_estimation(client):
    client.send({"type": "count_tokens", "id": "estimate", "text": "hello world"})
    assert client.next() == {"type": "tokens", "id": "estimate", "count": 2, "encoding": "cl100k_base", "estimated": True}
