import { expect,it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

it('keeps Host output declarations scoped, historical bindings compatible and process projections owned by the exact run',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/planning-host-output-contracts-fixture.ts',import.meta.url).pathname],{timeout:15000,maxBuffer:1_000_000})
  expect(JSON.parse(stdout.trim())).toEqual({ok:true,currentCallerSchema:true,samplesRemainObservations:true,usedSchemaConflict:true,oldTaskCompatibility:true,exactRunProjection:true,unknownWorkspaceDenied:true,modelCalls:0,workflowRuns:0})
},20000)
