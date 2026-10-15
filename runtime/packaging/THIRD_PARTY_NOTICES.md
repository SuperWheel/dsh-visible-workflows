# Third-party runtime notices

This plugin includes a private application runtime assembled from the official
assets pinned in `runtime-lock.json`. Upstream licenses and copyright notices
are retained in the payload; Graphon source and wheel metadata are unchanged.
The dependency subset and DSH adapters are application-specific. This is not a
standalone lean Graphon package and does not claim that the original full
Graphon wheel dependency metadata passes `pip check`.

## Interpreter and tokenizer data

- CPython 3.12.15: Python Software Foundation and contributors; official Astral
  python-build-standalone release 20261013. The distribution contains Python
  and bundled-library license files, retained under the payload Python tree.
  Source: https://github.com/astral-sh/python-build-standalone/releases/tag/20261013
- Graphon 0.7.0: LangGenius and contributors; Apache-2.0. The upstream license
  is also copied to `licenses/Graphon-APACHE-2.0.txt`. The adjacent `NOTICE.txt`
  is our packaging notice, not an upstream NOTICE file.
- cl100k_base encoding data is pinned to the SHA-256 in the official tiktoken
  0.13.0 constructor. The upstream tiktoken license is retained with its wheel.
  Source: https://github.com/openai/tiktoken/tree/0.13.0

## Python package metadata

The labels below are copied from each locked wheel's license metadata. Full
license terms and copyright notices are in the corresponding `.dist-info`
directory and/or included package files in the runtime.

| Package | Version | Upstream license metadata |
|---|---|---|
| annotated-types | 0.7.0 | OSI Approved :: MIT License |
| anyio | 4.14.2 | MIT |
| attrs | 26.1.0 | MIT |
| certifi | 2026.6.17 | MPL-2.0 |
| charset-normalizer | 3.4.9 | MIT |
| graphon | 0.7.0 | Apache-2.0 |
| h11 | 0.16.0 | MIT |
| httpcore | 1.0.9 | BSD-3-Clause |
| httpx | 0.28.1 | BSD-3-Clause |
| idna | 3.18 | BSD-3-Clause |
| jinja2 | 3.1.6 | OSI Approved :: BSD License |
| json-repair | 0.61.7 | MIT |
| jsonschema | 4.26.0 | MIT |
| jsonschema-specifications | 2025.9.1 | MIT |
| markupsafe | 3.0.3 | BSD-3-Clause |
| orjson | 3.11.9 | MPL-2.0 AND (Apache-2.0 OR MIT) |
| pydantic | 2.13.4 | MIT |
| pydantic-core | 2.46.4 | MIT |
| pydantic-extra-types | 2.11.1 | MIT |
| pyyaml | 6.0.3 | MIT |
| referencing | 0.37.0 | MIT |
| regex | 2026.7.19 | Apache-2.0 AND CNRI-Python |
| requests | 2.34.2 | Apache-2.0 |
| rpds-py | 2026.6.3 | MIT |
| tiktoken | 0.13.0 | MIT License |
| typing-extensions | 4.16.0 | PSF-2.0 |
| typing-inspection | 0.4.2 | MIT |
| urllib3 | 2.7.0 | MIT |

## Delivery status

The default npm package includes the macOS ARM64 payload. Windows x64 has a
separate cross-build/static validation path; native Windows execution remains
unverified until tested on that platform.
