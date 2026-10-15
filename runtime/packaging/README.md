# Private Graphon core runtime

The desktop plugin ships a prebuilt runtime archive in `runtime-assets/`. Users
do not install Python, pip, uv, Transformers, or document parsing libraries.
The host executes the bundled, versioned Python with `-I -B`; no system Python
fallback or startup package download exists.

## Controlled distribution

`runtime-lock.json` pins the official CPython 3.12.15 standalone archive, the
Graphon 0.7.0 wheel, 27 other wheels, and the `cl100k_base` tokenizer data by
SHA-256. The closure was calculated from Graphon v0.7.0's `uv.lock`, with Jinja2
explicitly retained. The same 28 package names are enforced by the host.

This is a vendored application runtime, **not a separately published lean
Graphon wheel**. The full upstream Graphon source and `.dist-info` metadata are
retained for provenance. That upstream metadata still declares the full parser
and Transformers dependency set. The intentionally reduced runtime is described
by `core-dependencies.json`; an unrestricted `pip install graphon` or `pip check`
does not describe this application-specific configuration.

The graph engine, nested iteration/loop, branching, pause/resume and model-node
protocols remain. Document extraction is delegated to authorized host/MCP
adapters, and LLM/tool execution uses the DSH bridge. The default Slim factory
and Transformers fallback must not be invoked in this distribution. Full Jinja2
templates remain available.

## Build

Use build-machine Python 3.12 or newer:

```sh
python3 scripts/build-graphon-runtime.py --platform macos-arm64
python3 scripts/build-graphon-runtime.py --platform windows-x64 --output .cache/graphon-runtime/windows-static
```

The builder verifies every download, extracts only the selected interpreter and
wheels into a private staging directory, and retains upstream licenses. It does
not install into the system Python or use pip/uv. PBS interpreter convenience
symlinks are omitted from the final archive; the real versioned interpreter and
all required libraries remain. This avoids packaging multiple copies of the
same static executable. The final archive uses regular-file USTAR entries only.

On the native target, the builder verifies actual Python/Graphon versions,
core imports, full Jinja2 and tiktoken with socket connections disabled. A
cross-built Windows archive receives PE-signature and static wheel checks, and
its manifest says `static-only` / `executed: false`. That is not Windows runtime
acceptance. Do not publish it as Windows-tested until a native test passes.

Downloads are cached under `.cache/graphon-runtime/downloads`; these caches are
not npm-package contents. The `--skip-native-probe` option is for diagnosis only
and explicitly marks the payload unexecuted.

## Installation and isolation

`ensureGraphonEnvironment()` locates the plugin root from the current module,
validates the platform manifest, and checks the archive SHA-256. It extracts into
a private temporary directory with strict entry/path/size validation, verifies
the interpreter/dependency/tokenizer hashes, and executes an offline import
probe. A ready marker and the complete directory become visible atomically.
Concurrent callers share an installation lock; an aborted install leaves no
ready runtime. User state directory symlinks and runtime links are rejected.

Use the returned `python` path and the complete sanitized `env` directly.
Do not merge ambient `PYTHONPATH`, `PYTHONHOME`, or dynamic-loader injection
variables back in. The environment is not a code sandbox; node executors must
continue to apply host permissions and their own execution confinement.

`cl100k_base` is packaged at its upstream cache key and verified against the
official data hash. It is an estimate for models with other tokenizers and is not
a universal billing/context counter. No first-run tokenizer download is needed.

## Licenses and provenance

The payload retains Python's bundled licenses and each wheel's metadata/license
files. `licenses/Graphon-APACHE-2.0.txt` is the upstream Graphon license;
`licenses/NOTICE.txt` is this project's distribution notice, not a claimed
upstream NOTICE file. The original source URLs and hashes are in the lock.

The actual macOS archive size and content size are recorded in
`runtime-assets/macos-arm64.json`. These are measured build outputs, separate
from earlier download-component estimates and filesystem allocated-disk usage.
