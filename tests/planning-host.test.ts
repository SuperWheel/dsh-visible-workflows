import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

it('routes actual registered planning tools through Host permissions, current graph validation and atomic publication',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/planning-host-fixture.ts',import.meta.url).pathname],{timeout:30_000})
  expect(JSON.parse(stdout.trim())).toEqual({ok:true,registeredPlanningTools:5,noBudgetBeforeDriver:true,atomicReceipt:true,proposalDoesNotOverwrite:true,previewWrites:0,idempotent:true,crossSessionDenied:true,fixedAndOldRoleRejected:true,unknownModelOffline:true,catalogDriftRejected:true,permissionLossBeforeCommit:true,answerAndCancel:true,workflowRuns:0,externalCalls:0})
},35_000)
