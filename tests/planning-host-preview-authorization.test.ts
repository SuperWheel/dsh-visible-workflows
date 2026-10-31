import { expect,it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

it('rechecks preview metadata and cache reads against live Host visibility/revision/digest without granting write permission',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/planning-host-preview-authorization-fixture.ts',import.meta.url).pathname],{timeout:15_000,maxBuffer:1_000_000})
  expect(JSON.parse(stdout.trim())).toEqual({ok:true,readonlyPreview:true,deletedDenied:true,movedDenied:true,revisionDenied:true,digestDenied:true,writeMutableGate:true,modelContractSemanticsPreserved:true,historicalReceiptReads:true,callbackChecks:9,cacheReads:14,modelCalls:0,workflowRuns:0})
},20_000)
