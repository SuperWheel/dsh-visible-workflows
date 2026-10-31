import { expect,it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

it('compiles through the configured Host, rechecks contracts, publishes and parses native tool wrappers on Graphon',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/template-fill-host-fixture.ts',import.meta.url).pathname],{timeout:30000,maxBuffer:2_000_000})
  expect(JSON.parse(stdout.trim())).toMatchObject({ok:true,templateHostConfig:true,contractConflict:true,outputSchemaConflict:true,publication:true,nativeWrapper:true,graphonInputs:2,nativeCalls:2,modelCalls:0})
},35000)
