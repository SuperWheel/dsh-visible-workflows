// Native SDK contract fixtures run in child Node processes and inherit this path.
// Only the immutable, verified runtime is shared; every test keeps its own store.
import { resolve } from 'node:path'
process.env.DSH_WORKFLOW_RUNTIME_DIRECTORY ??= resolve('.cache/graphon-test-runtime')
