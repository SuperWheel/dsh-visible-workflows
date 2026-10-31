import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({ test: {
  include: ['tests/**/*.test.{ts,tsx}'],
  setupFiles: ['./tests/setup.ts'],
  testTimeout: 20_000,
  hookTimeout: 20_000,
  maxWorkers: 4,
  env: { DSH_WORKFLOW_RUNTIME_DIRECTORY: resolve('.cache/graphon-test-runtime') },
} })
