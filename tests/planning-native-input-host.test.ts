import {expect,it} from 'vitest'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
it('routes real registered Host question tools, wait and stop notices without duplicate human questions',async()=>{
 const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/planning-native-input-host-fixture.ts',import.meta.url).pathname],{timeout:20_000})
 expect(JSON.parse(stdout.trim())).toEqual({ok:true,registeredTools:true,actualNativeProvider:true,exactAndGuessedRevisionRefused:true,originalHostAnswerResumesSameTask:true,answerBatchBound:true,manualFallback:true,actualJoinNotice:true,noPublication:true,modelRequests:0})
},25_000)
