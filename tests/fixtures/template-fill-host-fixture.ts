import {moduleCheck} from './planning-module-check.ts'
// Real Host, publication, native-result wrapping and Graphon. Only planning and
// the native read tool are offline doubles; all state lives in a temporary folder.
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import VisibleWorkflowService from '../../src/host/index.ts'
import { templateIdForTool } from '../../src/shared/planning-node-templates.ts'
import type { PlanningAgentInput } from '../../src/host/planning/agent.ts'

const directory=mkdtempSync(join(tmpdir(),'template-host-')),ctx=new Context(),definitions=new Map<string,any>()
const main:any={id:'main',ctx,session:{id:'main',header:{cwd:directory},requestHeader:()=>({config:{provider:'fixture',model:'offline',reasoningEffort:'none'}})},options:{provider:'fixture',model:'offline',reasoningEffort:'none'}}
let nativeCalls=0,modelCalls=0,budgetQuestions=0
const read={name:'fixture_read',description:'Returns a text field containing a JSON document.',parameters:{type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false},output:{schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}}
const provisions=[
  ctx.provide('agents',{get:(id:string)=>id==='main'?main:undefined,list:()=>[main],roots:()=>[main],withInitiator:async(_parent:any,operation:()=>Promise<unknown>)=>operation()}),
  ctx.provide('workspaceRegistry',{list:()=>[{id:'workspace',title:'Template test',path:directory,sessionIds:['main']}]}),
  ctx.provide('llm',{listProviders:()=>[{id:'fixture',name:'Offline'}],listModels:async()=>[{id:'offline',name:'Offline'}],resolveModelInfo:async()=>({reasoning:{efforts:[{id:'none'}]}}),stream:async function*(){modelCalls++;throw Error('No external models')}}),
  ctx.provide('tools',{
    register:(definition:any)=>{definitions.set(definition.name,definition);return()=>definitions.delete(definition.name)},
    schemas:()=>[read],get:(name:string)=>name===read.name?read:definitions.get(name),
    execute:async(exec:any)=>{assert.equal(exec.name,read.name);assert.equal(exec.agent,main);nativeCalls++;return {isError:false,value:{text:JSON.stringify({name:exec.arguments.name})}}},
  }),
  ctx.provide('systemPrompt',{section:()=>()=>{}}),ctx.provide('typert',{}),ctx.provide('planMode',{get:()=>({active:false})}),
  ctx.provide('userQuestions',{ask:async(request:any)=>{budgetQuestions++;assert.equal(request.agent,main);assert.equal(request.questions[0].id,'budget-mode');return {answers:[{id:'budget-mode',selected:['否，不设预算上限']}]}}}),
]
const fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:directory,planningCompiler:'template-fill'});await fiber
assert.equal(fiber.state,2)
const service=fiber.ctx.get('visibleWorkflows')!,planner=(service as any).planner
planner.options.driver.generate=async(input:PlanningAgentInput)=>{
  input.beforeStep?.(120,undefined);input.beforeSubmission?.();assert.ok(input.compiler);assert.ok(input.templateQuery)
  const id=templateIdForTool('native:fixture_read'),query=input.templateQuery([id,'code','template','if','iteration']) as any,entries=query.entries
  assert.deepEqual(query.runtimeSemantics.nodes.map((node:any)=>node.kind),['tool','code','template','if','iteration'])
  assert.ok(query.runtimeSemantics.nodes.find((node:any)=>node.kind==='template').syntax.filters.default)
  assert.ok(query.runtimeSemantics.nodes.every((node:any)=>!Object.hasOwn(node,'schema')))
  assert.equal(entries[0].outputs.status,'partial');assert.ok(entries[0].outputs.fields.value)
  assert.equal(entries[0].outputs.fields.result,undefined,'A native wrapper must not invent internal result fields')
  assert.deepEqual(entries[0].outputs.contract.guarantee.schema.schema,read.output.schema)
  assert.equal(entries[0].outputs.contract.guarantee.schema.source,'host-tool-definition')
  assert.equal(entries[0].outputs.contract.guarantee.schema.valuePath,'value')
  assert.deepEqual(entries[0].outputs.contract.observations,[])
  const result=input.compiler.submit({submission:{mode:'create',title:'Native wrapper parser',forms:[
    {key:'start',template:'input',values:{fields:[{name:'name',label:'姓名',required:true}]}},
    {key:'read',template:id,values:{inputs:{name:'{{input.name}}'}}},
    {key:'parse',template:'code',values:{language:'javascript',inputs:{raw:'{{read.value}}'},code:'function main(inputs){return {text: "Hello " + JSON.parse(inputs.raw.text).name}}',outputSchema:[{name:'text',type:'string'}]}},
    {key:'result',template:'output',values:{text:'{{parse.text}}',outputName:'result'}},
  ],chains:[{key:'main',nodes:['start','read','parse','result']}],coverage:{R1:['read','parse','result']}}})
  assert.equal(result.ok,true,JSON.stringify(result));if(!result.ok)throw Error('template compilation failed')
  return {output:result.value,steps:1,usage:{totalTokens:10}}
}
const tool=async(name:string,args:unknown)=>{
  const result=JSON.parse(await definitions.get(name).execute(args,{agent:main,signal:new AbortController().signal}))
  if(name==='visible_workflow_plan'&&result.delivery?.mode==='background'){
    assert.equal(result.state,'queued');assert.equal(result.delivery.protocolVersion,1);assert.equal(result.candidate,undefined)
    await planner.active.get(result.taskId)?.done
    return JSON.parse(await definitions.get('visible_workflow_plan_get').execute({task_id:result.taskId,include_candidates:true},{agent:main,signal:new AbortController().signal}))
  }
  return result
}
const preview=(id:string)=>tool('visible_workflow_plan',{request_json:JSON.stringify({requestId:id,operation:'create',moduleCheck,instruction:'读取姓名 JSON，解析原生工具 value 中的 text，输出 Hello 姓名',preview:true,execution:{mode:'design-only'}})})
const publish=(task:any)=>tool('visible_workflow_plan_publish',{task_id:task.taskId,revision:task.revision,candidate_digest:task.candidateDigest})
try{
  const stale=await preview('stale');assert.equal(stale.state,'ready',JSON.stringify(stale));assert.equal(nativeCalls,0)
  const original=read.description;read.description+=' Changed contract.'
  const rejected=await publish(stale)
  assert.ok(['blocked','conflict','failed'].includes(rejected.state),JSON.stringify(rejected))
  assert.match(JSON.stringify(rejected.diagnostics),/TEMPLATE_CONTRACT_CONFLICT/)
  assert.equal(JSON.parse(await service.list('workspace')).workflows.length,0);read.description=original
  const staleOutput=await preview('stale-output');assert.equal(staleOutput.state,'ready',JSON.stringify(staleOutput))
  const originalSchema=structuredClone(read.output.schema);read.output.schema.properties.text.type='number'
  const outputRejected=await publish(staleOutput)
  assert.ok(['blocked','conflict','failed'].includes(outputRejected.state),JSON.stringify(outputRejected))
  assert.match(JSON.stringify(outputRejected.diagnostics),/TOOL_OUTPUT_CONTRACT_CONFLICT/)
  assert.equal(JSON.parse(await service.list('workspace')).workflows.length,0)
  read.output.schema=originalSchema
  const fresh=await preview('fresh');assert.equal(fresh.state,'ready',JSON.stringify(fresh))
  const published=await publish(fresh);assert.equal(published.state,'published',JSON.stringify(published))
  assert.equal(published.receipt.kind,'created');assert.equal(JSON.parse(await service.list('workspace')).workflows.length,1)
  assert.equal(nativeCalls,0,'Planning, template queries and publication must not execute business tools')
  for(const name of ['Ada','小明']){
    const run=JSON.parse(await service.start(published.receipt.workflowId,JSON.stringify({name}),'main'))
    const settled=await (service as any).runtime.settle(run.id)
    assert.equal(settled.status,'success',JSON.stringify(settled));assert.deepEqual(settled.outputs,{result:'Hello '+name})
    const readResult=settled.executions.find((node:any)=>node.nodeId===settled.graph.nodes.find((node:any)=>node.kind==='tool').id)
    assert.deepEqual(readResult.data.value,{text:JSON.stringify({name})})
  }
  assert.equal(nativeCalls,2);assert.equal(modelCalls,0)
  console.log(JSON.stringify({ok:true,templateHostConfig:true,contractConflict:true,outputSchemaConflict:true,publication:true,nativeWrapper:true,graphonInputs:2,nativeCalls,modelCalls,budgetQuestions}))
}finally{await fiber.dispose();for(const dispose of provisions.reverse())await dispose();rmSync(directory,{recursive:true,force:true})}
