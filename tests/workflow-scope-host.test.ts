import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

it('shares exact workflow definitions while executing only in caller project permissions',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/global-workflow-host-fixture.ts',import.meta.url).pathname],{timeout:30_000})
  expect(JSON.parse(stdout.trim())).toEqual({ok:true,exactId:true,globalReadPlanRun:true,callerResourceBoundary:true,privateDependenciesDenied:true,explicitScopeOnly:true,noBudgetQuestions:true,modelCalls:0})
},35_000)
