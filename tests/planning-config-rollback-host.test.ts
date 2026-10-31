import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

async function rehearse(scenario:string){
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/planning-config-rollback-host-fixture.ts',import.meta.url).pathname,scenario],{timeout:30_000,maxBuffer:2_000_000})
  return JSON.parse(stdout.trim())
}
it.each(['template-fill','compact-repair'])('%s: config rollback preserves protocols and identities without replay',async mode=>{
  expect(await rehearse(mode)).toEqual({ok:true,scenario:mode,switches:2,reloadedWithoutActions:true,duplicateWithoutWork:true,clarificationsResumed:true,externalCalls:0,businessCalls:0})
},35_000)
it('legacy-task: Host reads missing fields and rejects future protocols',async()=>{
  expect(await rehearse('legacy-task')).toEqual({ok:true,scenario:'legacy-task',legacyReadable:true,futureProtocolsRejected:2,externalCalls:0,businessCalls:0})
},35_000)

it('legacy-config: Host accepts the old config value and exposes its retired-protocol mapping',async()=>{
  expect(await rehearse('legacy-config')).toEqual({ok:true,scenario:'legacy-config',legacyConfigMapped:true,externalCalls:0,businessCalls:0})
},35_000)
