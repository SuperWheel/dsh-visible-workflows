import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// T12 (2026-10-26, user decision): new tasks default to template-fill;
// compact-repair stays selectable as the rollback.
it('defaults new planning tasks to template-fill and keeps compact-repair selectable',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/planning-default-mode-fixture.ts',import.meta.url).pathname],{timeout:20_000})
  expect(JSON.parse(stdout.trim())).toEqual({defaultMode:'template-fill',rollbackMode:'compact-repair'})
},25_000)
