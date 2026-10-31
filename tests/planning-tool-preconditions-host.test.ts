import { expect,it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

it('T18 Host collects only current scoped registration metadata and rejects operation-version drift while preserving old tasks',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/t18-host.ts',import.meta.url).pathname],{timeout:15000,maxBuffer:100000})
  expect(JSON.parse(stdout.trim())).toEqual({scopedRegistration:true,missingSourceUnknown:true,publicationDriftRejected:true,historicalBindingUnchanged:true,modelCalls:0,businessCalls:0})
},20000)
