import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

it('connects the native command, scoped canvas and real publication journal without budget APIs',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/planning-entry-host-fixture.ts',import.meta.url).pathname],{timeout:30_000})
  expect(JSON.parse(stdout.trim())).toEqual({ok:true,nativeCommand:true,currentScope:true,dirtyDenied:true,staleDenied:true,liveRoot:true,noBudgetApi:true,noBudgetQuestions:true,commandHandoffAndToolPublication:true,templateCreate:true,proposalOnly:true,chainReadStableAnchor:true,chainExplicitBoundaries:true,chainReadAuthorization:true,chainInputBounds:true,chainSpliceAcceptance:true,chainSpliceIdempotent:true,chainV3Plan:true,chainZeroChild:true,chainStaleRejected:true,chainOriginalReview:true,externalCalls:0,workflowRuns:0})
},35_000)
