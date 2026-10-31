import {describe,it,expect,vi} from 'vitest'
import {cases,contextFor} from '../scripts/benchmarks/workflow-compiler.ts'
import {freezePair,pairedSchedule,runPaired,reportedTokens,type PairConfig,type PairProvider} from '../scripts/benchmarks/template-fill-paired.ts'
import {greetingSubmission} from '../scripts/benchmarks/template-fill-paired-self-test.ts'
import {main} from '../scripts/benchmarks/template-fill-paired-cli.ts'
import {spawn} from 'node:child_process'
vi.mock('node:child_process',async original=>({...await original<typeof import('node:child_process')>(),spawn:vi.fn(()=>{throw Error('A test attempted to start an external process')})}))
const configuration=(patch:Partial<PairConfig>={}):PairConfig=>{
 const item=cases.find(item=>item.id==='greeting')!
 return {repeats:1,model:{provider:'fixture-only',model:'no-real-model',reasoningEffort:'high',temperature:0.2,maxOutputTokens:8192},limits:{maxModelRequests:3,maxSubmissions:3,maxCatalogCalls:3},cases:[{id:item.id,instruction:item.instruction,context:contextFor(item),samples:item.samples}],implementationHashes:{fixture:'a'.repeat(64)},...patch}
}
const successProvider:PairProvider={async request(_body,slot){return {message:{role:'assistant',tool_calls:[{id:slot.arm,function:{name:'structured_output',arguments:JSON.stringify(greetingSubmission(slot.arm))}}]},usage:null}}}

describe('paired compact/template benchmark isolation and evidence boundaries',()=>{
 it('freezes case, oracle, identities, model controls and limits; alternates serial AB/BA order',()=>{
  const config=configuration({repeats:2}),frozen=freezePair(config),digest=frozen.digest
  config.cases[0]!.instruction='later edit';config.cases[0]!.context.tools.push({id:'changed'} as any)
  expect(frozen.digest).toBe(digest);expect(frozen.definition.cases[0]!.instruction).not.toBe('later edit');expect(frozen.definition.cases[0]!.context.tools).toEqual([])
  expect(frozen.definition.cases[0]!.context.model).toEqual({provider:'fixture-only',model:'no-real-model'})
  expect(pairedSchedule(frozen).map(slot=>slot.arm)).toEqual(['compact-repair','template-fill','template-fill','compact-repair'])
  const changed=configuration();changed.limits.maxSubmissions=2;expect(freezePair(changed).digest).not.toBe(digest)
 })
 it('rejects invalid repeat/limits before provider construction',()=>{
  expect(()=>freezePair(configuration({repeats:0}))).toThrow()
  expect(()=>freezePair(configuration({limits:{maxModelRequests:3,maxSubmissions:NaN,maxCatalogCalls:3}}))).toThrow()
  expect(()=>freezePair(configuration({cases:[]}))).toThrow()
 })
 it('compiles each frontend with one shared oracle and preserves unknown usage/timing as null',async()=>{
  const observed:any[]=[],frozen=freezePair(configuration()),report=await runPaired(frozen,successProvider,async(flow,item)=>{observed.push({flow,item});return {passed:true}},result=>{expect(result.usage.reportedTokens).toBeNull()})
  expect(report.results.map(row=>row.status)).toEqual(['success','success']);expect(observed).toHaveLength(2)
  expect(observed[0].item).toEqual(observed[1].item);expect(observed[0].flow.nodes).toEqual(observed[1].flow.nodes)
  for(const result of report.results){expect(result.usage).toEqual({reportedTokens:null,knownCalls:0,unknownCalls:1});expect(result.timing.modelGenerationMs).toBeNull();expect(result.timing.sdkStartupMs).toBeNull();expect(result.calls[0]).toMatchObject({providerRequestMs:null,providerFirstDeltaMs:null});expect(result.timing.totalWallMs).toBeGreaterThanOrEqual(result.timing.designWallMs!)}
  expect(report.summary.completeSchedule).toBe(true);expect(report.summary.pairedSuccessfulCases).toBe(1)
 })
 it('repairs both modes under the same submission cap, keeping initial rejection and unknown calls',async()=>{
  const counts=new Map<string,number>(),provider:PairProvider={async request(body,slot){
   const n=(counts.get(slot.arm)??0)+1;counts.set(slot.arm,n)
   const feedback=(body.messages as any[]).findLast(message=>message.role==='tool')
   const args=n===1?greetingSubmission(slot.arm,true):{submission:{mode:'repair',draftRevision:JSON.parse(feedback.content).draftRevision,patches:[{op:'add',path:'/title',value:'fixed'}]}}
   return {message:{role:'assistant',reasoning_content:'fixture reasoning must stay memory-only',tool_calls:[{id:slot.arm+n,function:{name:'structured_output',arguments:JSON.stringify(args)}}]},usage:n===1?null:{total_tokens:0},firstDeltaMs:Infinity}
  }}
  const report=await runPaired(freezePair(configuration()),provider,async()=>({passed:true}))
  for(const row of report.results){expect(row.status).toBe('success');expect(row.submissions).toBe(2);expect(row.feedback).toHaveLength(1);expect(row.usage).toEqual({reportedTokens:0,knownCalls:1,unknownCalls:1});expect(row.calls[0]!.providerFirstDeltaMs).toBeNull()}
  expect(JSON.stringify(report)).not.toContain('fixture reasoning must stay memory-only')
 })
 it('retains failed attempts and their wall time; gives neither arm a new repair allowance',async()=>{
  const report=await runPaired(freezePair(configuration({limits:{maxModelRequests:4,maxSubmissions:1,maxCatalogCalls:3}})),{async request(_body,slot){return {message:{role:'assistant',tool_calls:[{id:'bad',function:{name:'structured_output',arguments:JSON.stringify(greetingSubmission(slot.arm,true))}}]},usage:null}}},async()=>{throw Error('Oracle must not run without a candidate')})
  expect(report.results.map(row=>[row.status,row.requests,row.submissions])).toEqual([['failed',1,1],['failed',1,1]])
  expect(report.summary.groups.every(group=>group.failed===1&&group.designWallMsPerSuccessIncludingFailures===null&&group.unknownUsageCalls===1)).toBe(true)
  expect(report.summary.pairedMedianDesignWallRatio).toBeNull()
 })
 it('enforces the shared request ceiling even when the model never submits',async()=>{
  const report=await runPaired(freezePair(configuration({limits:{maxModelRequests:2,maxSubmissions:3,maxCatalogCalls:3}})),{async request(){return {message:{role:'assistant',content:'still thinking'},usage:null}}},async()=>({passed:true}))
  expect(report.results.every(row=>row.status==='failed'&&row.requests===2&&row.submissions===0&&row.usage.unknownCalls===2)).toBe(true)
 })
 it('retains auth/provider failure and marks remaining planned arms not-run without retry or invented duration',async()=>{
  const request=vi.fn(async()=>({error:'Authentication rejected',status:401})),report=await runPaired(freezePair(configuration()),{request},async()=>({passed:true}))
  expect(request).toHaveBeenCalledTimes(1);expect(report.results.map(row=>row.status)).toEqual(['failed','not-run']);expect(report.results[1]!.timing.totalWallMs).toBeNull();expect(report.results[0]!.usage.unknownCalls).toBe(1);expect(report.summary.completeSchedule).toBe(false)
 })
 it('records shared oracle rejection as a failure instead of silently discarding the pair',async()=>{
  const report=await runPaired(freezePair(configuration()),successProvider,async()=>({passed:false,results:[{passed:false}]}))
  expect(report.results.every(row=>row.status==='failed'&&row.candidate!==null&&row.oracle?.passed===false)).toBe(true);expect(report.summary.pairedSuccessfulCases).toBe(0)
 })
 it('records separated serialized input sizes and leaves unobserved provider internals and valid content timings unknown',async()=>{
  const payloads:any[]=[]
  const provider:PairProvider={async request(body,slot){payloads.push({messageBytes:Buffer.byteLength(JSON.stringify(body.messages)),schemaBytes:Buffer.byteLength(JSON.stringify(body.tools)),inputBytes:Buffer.byteLength(JSON.stringify(body))});return {...await successProvider.request(body,slot),firstDeltaMs:1}}}
  const report=await runPaired(freezePair(configuration()),provider,async()=>({passed:true}))
  report.results.forEach((row,index)=>expect(row.calls[0]).toMatchObject({...payloads[index],providerFirstDeltaMs:1,providerFirstValidTextMs:null,providerFirstValidToolArgumentsMs:null,providerQueueMs:null,providerPrefillMs:null,repeatedContentRatio:0}))
 })
 it('includes failed authoring time in cost per successful case and pairs only joint successes',async()=>{
  let checks=0
  const report=await runPaired(freezePair(configuration({repeats:2})),successProvider,async()=>({passed:++checks!==1}))
  const compact=report.results.filter(row=>row.arm==='compact-repair'),summary=report.summary.groups.find(group=>group.arm==='compact-repair')!
  expect(summary).toMatchObject({attempted:2,succeeded:1,failed:1,unknownUsageCalls:2})
  expect(summary.designWallMsPerSuccessIncludingFailures).toBe(compact.reduce((sum,row)=>sum+row.timing.designWallMs!,0))
  expect(summary.totalWallMsPerSuccessIncludingFailures).toBe(compact.reduce((sum,row)=>sum+row.timing.totalWallMs!,0))
  expect(report.summary.pairedSuccessfulCases).toBe(1)
 })
 it('keeps reported zero distinct from missing or malformed token totals',()=>{
  expect(reportedTokens({total_tokens:0})).toBe(0)
  for(const value of [null,undefined,{},[],{total_tokens:-1},{total_tokens:NaN},{total_tokens:'12'},{total_tokens:1.5}])expect(reportedTokens(value)).toBeNull()
 })
 it('default CLI and invalid opt-in never spawn a provider or read credentials',async()=>{
  const log=vi.spyOn(console,'log').mockImplementation(()=>{})
  try{await main([]);await expect(main(['--run'])).rejects.toThrow('explicit --out');expect(spawn).not.toHaveBeenCalled()}finally{log.mockRestore()}
 })
})
