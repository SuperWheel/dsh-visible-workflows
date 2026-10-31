import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const execute = promisify(execFile)

describe('template-fill complex production Host paths with explicit offline providers', () => {
  for (const group of ['multi-tool', 'http-structured', 'subworkflow', 'deep-subworkflow', 'dynamic-child-recovery', 'desktop-recovery-rehearsal', 'verified-trial-human']) {
    it(`${group} executes independent samples and preserves its rejection boundary`, async () => {
      const { stdout } = await execute(process.execPath, ['--import', 'tsx', 'tests/fixtures/template-fill-complex-host-fixture.ts', group], { timeout: 90_000, maxBuffer: 4_000_000 })
      const result = JSON.parse(stdout.trim())
      expect(result).toMatchObject({ passed: true, group, externalModelCalls: 0, networkConnections: 0 })
      expect(result.observations.some((row: any) => row.label === 'primary' && row.status === 'success')).toBe(true)
      expect(result.observations.some((row: any) => row.label === 'holdout' && row.status === 'success')).toBe(true)
      expect(result.observations.some((row: any) => row.status === 'failed')).toBe(true)
      if (process.env.T05_COMPLEX_EVIDENCE_DIR) {
        const directory = resolve(process.env.T05_COMPLEX_EVIDENCE_DIR)
        mkdirSync(directory, { recursive: true })
        writeFileSync(resolve(directory, `${group}.json`), JSON.stringify(result, null, 2) + '\n')
      }
    }, 95_000)
  }
})
