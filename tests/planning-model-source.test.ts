import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

it('defers command model selection and keeps the actual tool request through budget questions',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/planning-model-source-fixture.ts',import.meta.url).pathname],{timeout:30_000})
  expect(JSON.parse(stdout.trim())).toEqual({ok:true,commandDefersModel:true,activeToolHeader:true,frozenPublication:true,budgetKeepsActiveRequest:true,noConstructionFallback:true,externalCalls:0})
},35_000)
