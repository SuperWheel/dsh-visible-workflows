import {expect,it} from 'vitest'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

it('removes registered budget gates while preserving reviewed old metadata',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/budget-removal-host-fixture.ts',import.meta.url).pathname],{timeout:20_000})
  expect(JSON.parse(stdout.trim())).toEqual({ok:true,noBudgetTools:true,noBudgetQuestions:true,exactLegacyCandidate:true,legacyRecordsUntouched:true,newGraphHasNoQuota:true,executionSafetyPreserved:true,driverCalls:0})
},25_000)
