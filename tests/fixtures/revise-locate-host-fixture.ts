// T37 through the real Host: locate runs a workflow with no run record once, hands back real rows and a bound
// chain; a splice built from it is replayed on that run before the proposal exists. No model, no network.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import VisibleWorkflowService from '../../src/host/index.ts'
import { makeWorkflow, type Workflow, type WorkflowNode } from '../../src/shared/types.ts'

const directory=mkdtempSync(join(tmpdir(),'workflow-revise-locate-host-'))
const ctx=new Context(),definitions=new Map<string,any>()
const main:any={id:'main',ctx,followup:()=>{},session:{id:'main',header:{cwd:directory},requestHeader:()=>({config:{provider:'fixture',model:'offline',reasoningEffort:'none'}}),append:()=>{}}}
const provisions=[
  ctx.provide('agents',{get:(id:string)=>id==='main'?main:undefined,list:()=>[main],roots:()=>[main],isOwnedBy:()=>false,withInitiator:async(_parent:any,run:any)=>run()}),
  ctx.provide('workspaceRegistry',{list:()=>[{id:'workspace',title:'Current',path:directory,sessionIds:['main']}]}),
  ctx.provide('llm',{listProviders:()=>[{id:'fixture',name:'Offline'}],listModels:async()=>[{id:'offline',name:'Offline'}],resolveModelInfo:async()=>({reasoning:{efforts:[{id:'none'}]}}),stream:async function*(){throw new Error('External model calls are forbidden')}}),
  ctx.provide('tools',{register:(definition:any)=>{definitions.set(definition.name,definition);return()=>{definitions.delete(definition.name)}},schemas:()=>[]}),
  ctx.provide('systemPrompt',{section:()=>()=>{}}),ctx.provide('typert',{}),ctx.provide('planMode',{get:()=>({active:false})}),
]
const fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:directory,planningCompiler:'compact-repair',commandEarlyHandoff:false});await fiber
assert.equal(fiber.state,2)
await new Promise(resolve=>setTimeout(resolve,0))
const service=fiber.ctx.get('visibleWorkflows')!,planner=(service as any).planner
planner.options.driver.generate=async()=>{throw Error('A decided chain must not start a planning model')}
const call=async(name:string,args:unknown)=>JSON.parse(await definitions.get(name).execute(args,{agent:main,signal:new AbortController().signal}))
const node=(id:string,kind:WorkflowNode['kind'],title:string,config:WorkflowNode['config']):WorkflowNode=>({id,kind,config,number:id,title,fixed:false,x:0,y:0})
const rowsCode=(body:string,inputs:Record<string,string>={})=>({language:'javascript' as const,code:`function main(inputs){${body}}`,inputs,outputSchema:[{name:'rows',type:'array' as const,required:true}]})
try{
  const draft={...makeWorkflow('workspace'),title:'CSV 统计 locate',nodes:[
    node('start','input','开始',{fields:[]}),
    node('stat','code','逐个统计文件',rowsCode("return {rows:[{name:'a.csv',bytes:10},{name:'notes',bytes:3}]}")),
    node('table','template','整理报告正文',{text:'| 文件名 | 字节数 |\n| --- | --- |\n{% for item in stat.rows %}| {{item.name}} | {{item.bytes}} |\n{% endfor %}'}),
    node('out','output','结果',{text:'{{table.text}}',outputName:'result'}),
  ],edges:[{id:'e1',source:'start',target:'stat'},{id:'e2',source:'stat',target:'table'},{id:'e3',source:'table',target:'out'}]}
  const flow=JSON.parse(await service.save(JSON.stringify(draft),0)) as Workflow
  const listed=await call('visible_workflow_list',{})
  assert.deepEqual(Object.keys(listed.workflows[0]).sort(),['id','nodeCount','revision','scope','title','updatedAt'],'the list carries no graphs')

  const located=await call('visible_workflow_locate',{workflow:'CSV 统计 locate',request:'修改已保存的工作流「CSV 统计 locate」：Markdown 表格在「字节数」后面增加一列「扩展名」'})
  assert.equal(located.workflow.id,flow.id);assert.deepEqual(located.quotes,['字节数','扩展名'])
  assert.deepEqual(located.targets.map((row:any)=>[row.nodeId,row.matched,row.alias]),[['table',['字节数'],located.chainNodes.find((row:any)=>row.nodeId==='table').alias]],'a target in the chain carries its alias')
  assert.equal(located.run.ranNow,true,'no run record: Host ran the workflow once');assert.equal(located.run.status,'success')
  const stat=located.samples.find((row:any)=>row.nodeId==='stat'),table=located.samples.find((row:any)=>row.nodeId==='table')
  assert.deepEqual(stat.output,{rows:[{name:'a.csv',bytes:10},{name:'notes',bytes:3}]},'real rows show there is no ext field')
  assert.match(table.output.text,/\| a\.csv \| 10 \|/)
  assert.equal(located.codeTemplate.id,'code');assert.equal(located.chain,undefined,'the Host keeps the binding; the main chat sends operations only')
  assert.ok(located.nodes.nodes.some((row:any)=>row.key===located.targets[0].key))
  const again=await call('visible_workflow_locate',{workflow:flow.id,request:'表格加「扩展名」列，在「字节数」后'})
  assert.equal(again.run.runId,located.run.runId);assert.equal(again.run.ranNow,false,'a run record is reused, not run again')

  const alias=located.chainNodes.find((row:any)=>row.nodeId==='table').alias
  const splice=(ext:string,requestId:string,flat=false)=>({request_id:requestId,workflow_id:flow.id,expected_revision:flow.revision,instruction:'表格在字节数后加扩展名列',
    // Desktop r61 E passed chain as JSON text; the Host reads it as an object.
    // Only operations: the Host fills the binding from this locate (T37.5). Desktop r62 E also copied the alias list and rules in; the Host drops them.
    chain:JSON.stringify({chainNodes:located.chainNodes,chainRules:located.chainRules,operations:[
      // Desktop r64 E wrote the new node's fields on the insert itself; the Host moves them into nodes (T37.6).
      // Desktop r65 E left out every draftRevision; the Host numbers them in order (T37.7).
      flat?{op:'insert',target:alias,position:'before',key:'extRow',template:'code',title:'提取扩展名',values:rowsCode(ext,{rows:`{{${stat.key}.rows}}`})}
        :{op:'insert',draftRevision:0,target:alias,position:'before',nodes:[{key:'extRow',template:'code',title:'提取扩展名',values:rowsCode(ext,{rows:`{{${stat.key}.rows}}`})}]},
      {op:'update',...flat?{}:{draftRevision:1},target:alias,values:{text:'| 文件名 | 字节数 | 扩展名 |\n| --- | --- | --- |\n{% for item in extRow.rows %}| {{item.name}} | {{item.bytes}} | {{item.ext}} |\n{% endfor %}'}},
    ]})})
  const tasksBefore=planner.tasks.size
  await assert.rejects(call('visible_workflow_splice',{...splice('return {rows:[]}','bad-json'),chain:'{"operations":[{"op":"update","target":"a-1","values":{"text":"x"}}}'}),/chain 是 JSON 文本，解析失败.*出错位置附近.*直接传对象/,'Desktop r65 E: a JSON text chain that lost a bracket says where')
  const other=JSON.parse(await service.save(JSON.stringify({...draft,id:makeWorkflow('workspace').id,title:'未定位的工作流'}),0)) as Workflow
  await assert.rejects(call('visible_workflow_splice',{...splice('return {rows:[]}','not-located'),workflow_id:other.id,expected_revision:other.revision}),/anchorNodeId|baseDigest/,'no locate of this workflow: nothing to fill')
  const broken=await call('visible_workflow_splice',splice("throw new Error('ext broke')",'locate-broken'))
  assert.equal(broken.state,'replay-failed');assert.equal(broken.replay.runId,located.run.runId)
  assert.deepEqual(broken.replay.steps.map((step:any)=>step.status),['failed','not-replayed'])
  assert.equal(planner.tasks.size,tasksBefore,'a failed replay makes no task and no proposal')

  const accepted=await call('visible_workflow_splice',splice("return {rows:inputs.rows.map(function(row){var dot=row.name.lastIndexOf('.');return Object.assign({},row,{ext:dot>0?row.name.slice(dot+1):''})})}",'locate-ok',true))
  assert.deepEqual(accepted.replay.steps.map((step:any)=>step.status),['success','success','success'])
  assert.match(accepted.replay.steps[1].output.text,/\| a\.csv \| 10 \| csv \|\n\| notes \| 3 \|  \|/)
  await planner.active.get(accepted.taskId)?.done
  const published=await call('visible_workflow_plan_get',{task_id:accepted.taskId})
  assert.equal(published.state,'published',JSON.stringify(published));assert.equal(published.receipt.kind,'proposed')
  await assert.rejects(call('visible_workflow_splice',splice("return {rows:inputs.rows}",'locate-second',true)),
    new RegExp(`REVISION_PENDING：本对话已在这个工作流 v${flow.revision} 上交过修改，提案 ${published.receipt.proposalId} 待用户接受.*只能接受一个`),'Desktop r65 E: a second proposal on the same revision from the same chat goes back')
  assert.equal(JSON.parse(await service.list('workspace')).runs.length,1,'replays are never saved as runs')
  console.log(JSON.stringify({ok:true}))
}finally{await fiber.dispose();for(const dispose of provisions.reverse())await dispose();rmSync(directory,{recursive:true,force:true})}
