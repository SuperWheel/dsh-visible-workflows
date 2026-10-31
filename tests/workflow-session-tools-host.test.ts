import {expect,it} from 'vitest'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

it('registers real SDK session tools, excludes node duplicates and enforces Host permissions',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/workflow-session-tools-host-fixture.ts',import.meta.url).pathname],{timeout:30_000})
  expect(JSON.parse(stdout.trim())).toEqual({ok:true,registration:true,nativeExclusion:true,plannerExclusion:true,trialAdmission:true,readOnly:true,planMode:true,networkCalls:2})
},35_000)
