import {expect,it} from 'vitest'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

it('joins the actual Host task journal and official turn-stop hook without model polling',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/planning-task-join-host-fixture.ts',import.meta.url).pathname],{timeout:20_000})
  expect(JSON.parse(stdout.trim())).toEqual({ok:true,fastAcceptance:true,waitingNotSuccess:true,foreignDenied:true,cancelWaitDoesNotCancelTask:true,turnStopHeldUntilReady:true,actualHostNotice:true,noticeDeduplicated:true,noPublication:true,modelRequests:0,driverCalls:1})
},25_000)
