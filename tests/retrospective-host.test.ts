import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

it('extracts only the current root history through the real Host and returns a provenance-backed preview without business effects',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/retrospective-host-fixture.ts',import.meta.url).pathname],{timeout:30_000})
  expect(JSON.parse(stdout.trim())).toEqual({ok:true,registeredTool:true,eventToProcedureToPreview:true,sourceMapping:true,currentTurnExcluded:true,crossSessionDenied:true,ownerLossDenied:true,queryUnavailableExplained:true,genericRouteGuarded:true,idempotent:true,clarificationAndCancel:true,previewWrites:0,workflowRuns:0,externalCalls:0,budgetQuestions:0})
},35_000)
