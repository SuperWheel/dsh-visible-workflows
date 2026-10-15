# Graphon bridge protocol 1

`main.py` is the private, local JSONL adapter between the DSH TypeScript host and
**unmodified Graphon 0.7.0**. It uses `GraphEngine` for dependency readiness,
edge activation, branch skipping and joins. Node work is requested from DSH so
existing models, tools, file permissions and node implementations stay in the
host. This module does not import Graphon's built-in document/model nodes.

Production starts the prepared environment's Python with `-I -u main.py`.
Only protocol JSON goes to stdout; diagnostics go to stderr. No TCP listener,
remote code loading or workflow-provided Python evaluation is used.

## Messages

On successful startup:

```json
{"type":"ready","engine":"graphon","version":"0.7.0","protocol":1}
```

Host starts one graph scope. Every graph has exactly one `input` node; nodes
and edges retain their stable IDs. Nested loop/iteration scopes submit their own
execute requests, with unique execute IDs.

```json
{"type":"execute","id":"run/scope","graph":{"nodes":[{"id":"input","kind":"input"},{"id":"output","kind":"output"}],"edges":[{"id":"edge","source":"input","target":"output"}]}}
```

The engine requests each ready node:

```json
{"type":"call","id":"run/scope","callId":"globally-unique-uuid","nodeId":"input"}
```

Host returns exactly one result. `data` is a JSON object. `selectedPort` selects
a branch. `activePorts`, when provided, explicitly determines the active port
set. An omitted edge port is `default`. Human actions include the default port
unless the selected action is `timeout`; explicit `activePorts` takes precedence.
Ordinary executable nodes activate all outgoing edges.

```json
{"type":"result","callId":"globally-unique-uuid","data":{"text":"example"},"selectedPort":"approve","activePorts":["approve","default"]}
```

Alternative results:

```json
{"type":"result","callId":"globally-unique-uuid","error":"Tool unavailable"}
{"type":"result","callId":"globally-unique-uuid","control":"pause"}
{"type":"result","callId":"globally-unique-uuid","control":"exit_loop"}
```

Both control results use Graphon's native pause event to prevent downstream
dispatch. `exit_loop` tells the TS container scope to finish the loop; it does
not implement Graphon's native loop container. Node errors use Graphon's failure
path. Actual node retry policy remains owned by the host.

The engine emits skipped node states and one terminal result:

```json
{"type":"skipped","id":"run/scope","nodeId":"unselected-node"}
{"type":"complete","id":"run/scope","status":"success"}
```

Terminal statuses are `success`, `paused`, `exit_loop`, `failed`. Errors include
`error`. Host cancellation uses `{"type":"cancel","id":"run/scope"}` and
finishes as `failed` with `cancelled:true`. Cancellation releases pending RPCs;
late/duplicate replies cannot execute a node a second time. DSH must separately
cancel the actual tool/model operation and report any non-cancellable effects.

## Resume and concurrency boundaries

One graph has one Graphon worker, preserving the current deterministic scope
mutation and human-input behavior. Independent execute requests can overlap;
the parent scope may wait for a TS container while its child graphs run. This
does **not** claim Graphon-native loop/iteration execution or ordinary graph
branch parallelism.

On pause, the Python execution is released. DSH retains the durable graph/run
snapshot and successful node results. Resume submits a fresh graph and answers
already successful node RPCs from the host cache. The host must not reissue their
external effects. This adapter does not claim to persist/resume Graphon frames.

## Offline token estimate

```json
{"type":"count_tokens","id":"estimate","text":"hello world"}
{"type":"tokens","id":"estimate","count":2,"encoding":"cl100k_base","estimated":true}
```

Only bundled `cl100k_base` is supported. `TIKTOKEN_CACHE_DIR` must contain the
official vocabulary at SHA-1(URL) filename with its pinned SHA-256 checksum.
Missing/corrupt vocabulary returns a `tokens` message with `error`; the adapter
does not download a vocabulary or fall back to Transformers. The count is an
estimate for the selected DSH model, not a provider's actual billable usage.

## Verification

Run `python -m pytest tests/graphon-python/test_bridge.py -q` from the plugin root
using an environment with Graphon 0.7.0 and core dependencies installed. Or set
`GRAPHON_BRIDGE_PYTHON` to the prepared runtime's Python while using a separate
test environment with pytest. Set `TIKTOKEN_CACHE_DIR` to the prepared payload's
vocabulary directory to include the offline token test. Tests launch the actual
engine with isolated Python (`-I`) as a child process; no real model call or
external tool effect is required.
