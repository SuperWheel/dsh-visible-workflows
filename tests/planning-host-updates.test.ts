import { expect,it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

it('revalidates the exact live root and workspace after a Host journal long poll',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/planning-host-updates-fixture.ts',import.meta.url).pathname],{timeout:15_000,maxBuffer:1_000_000})
  expect(JSON.parse(stdout.trim())).toEqual({ok:true,unownedQuiet:true,childDenied:true,legacyImmediate:true,eventWake:true,closedOwnerDenied:true,replacedOwnerDenied:true,movedWorkspaceDenied:true,disposedWaitDenied:true,modelCalls:0})
},20_000)
