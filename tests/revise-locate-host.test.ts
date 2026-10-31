import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

it('locates the node a revise names with real run data, and replays a splice before it becomes a proposal (T37)',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/revise-locate-host-fixture.ts',import.meta.url).pathname],{timeout:30_000})
  expect(JSON.parse(stdout.trim())).toEqual({ok:true})
},35_000)
