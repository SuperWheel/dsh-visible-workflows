import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

it('executes and independently verifies frozen trial artifacts through the production Host before creating and running a durable workflow once',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/trial-host-fixture.ts',import.meta.url).pathname],{timeout:30_000})
  expect(JSON.parse(stdout.trim())).toEqual({ok:true,explicitCreateMode:true,actualArtifactVerification:true,verifiedSource:true,templateFreshTrial:true,postSaveRun:true,softTargetRetainsCandidate:true,inputIntegrity:true,idempotent:true,ownership:true,incompleteEvidenceBlocked:true,finalReviewNotes:true,cancelAndNoReplay:true,durableRecovery:true,budgetQuestions:0,externalCalls:0,workflowRuns:10})
},35_000)
