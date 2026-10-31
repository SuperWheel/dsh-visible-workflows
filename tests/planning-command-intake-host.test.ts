import {it,expect} from 'vitest'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

it.each(['compact-repair','template-fill'])('T23 %s uses the real Host entry, isolated intake, join, receipt, cursor, rollback and historical startup',async mode=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/planning-command-intake-host-fixture.ts',import.meta.url).pathname,mode],{timeout:30_000})
  expect(JSON.parse(stdout.trim())).toEqual({ok:true,moduleZeroExtraDesign:true,sameSessionDesign:true,readOnlyPreview:true,needsInput:true,fallbackBrief:true,executeFirst:true,cursor:true,commandJoin:true,legacyStartup:true,rollbackExact:true,realModelCalls:0})
},35_000)
