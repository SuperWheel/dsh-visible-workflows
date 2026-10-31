// Narrow production Host method checks. No Host construction, model, business
// execution, filesystem state, native task or real profile is created here.
import assert from 'node:assert/strict'
import VisibleWorkflowService from '../../src/host/index.ts'
import { createTemplateBinding } from '../../src/shared/planning-node-templates.ts'
import { buildPlanningToolOutputs } from '../../src/shared/planning-tool-outputs.ts'
import { conversationEvidenceDigest } from '../../src/host/planning/conversation-evidence.ts'
import type { ConversationEvidence } from '../../src/shared/retrospective.ts'
import type { ToolChoice } from '../../src/shared/types.ts'
import { templateContext } from './planning-compiler/template.ts'

const host=Object.create(VisibleWorkflowService.prototype) as any
const owner={id:'root'},foreign={id:'foreign-root'},lookups:{name:string;agent:unknown}[]=[]
const declaration={output:{schema:{type:'string'}}},foreignDeclaration={output:{schema:{type:'number'}}}
const tool:ToolChoice={id:'native:lookup',name:'lookup',description:'lookup',providerId:'native:host',providerName:'host',category:'plugin',available:true,inputSchema:{type:'object'}}
Object.defineProperty(host,'ctx',{value:{tools:{get:(name:string,agent:unknown)=>{lookups.push({name,agent});return agent===owner?name==='lookup'?declaration:undefined:foreignDeclaration}},workspaceRegistry:{list:()=>[{id:'workspace'}]}}})
const tools=[tool,{...tool,id:'native:missing',name:'missing'},{...tool,id:'native:unavailable',available:false},{...tool,id:'swagger:other'}]
const schemas=host.planningOutputSchemas(tools,owner)
assert.deepEqual(schemas,[{toolId:tool.id,sourceId:'native-tool:lookup',version:'sdk-canonical-output-v1',valuePath:'value',schema:{type:'string'}}])
assert.ok(lookups.every(call=>call.agent===owner));assert.deepEqual(lookups.map(call=>call.name),['lookup','missing'])
assert.equal(host.planningOutputSchemas([tool],foreign)[0].schema.type,'number')

const evidenceBody:Omit<ConversationEvidence,'digest'>={version:1,sessionId:'root',fromSeq:1,throughSeq:3,records:[
  {id:'e1',seq:1,kind:'user',text:'lookup',status:'statement',truncated:false},
  {id:'e2',seq:2,kind:'tool-call',toolName:'lookup',callId:'call',text:'{}',status:'reported-success',truncated:false},
  {id:'e3',seq:3,kind:'tool-result',toolName:'lookup',callId:'call',text:'{"renderedOnly":true}',status:'reported-success',truncated:false},
],warnings:[]}
const conversation={...evidenceBody,digest:conversationEvidenceDigest(evidenceBody)},context=templateContext()
context.tools=tools;context.conversation=conversation;context.toolOutputs=buildPlanningToolOutputs(tools,{schemas,conversation})
const frozenOutputs=JSON.stringify(context.toolOutputs)
const caller={parent:owner,sessionId:'root',workspaceId:'workspace',signal:new AbortController().signal}
host.planningCaller=({agent}:any)=>({...caller,parent:agent,sessionId:agent.id});host.assertMutable=()=>{};host.planningModel=()=>context.model
host.catalog={list:(workspaceId:string,sessionId:string)=>{assert.equal(workspaceId,'workspace');assert.equal(sessionId,'root');return tools}}
host.storage={workflows:()=>[],archived:()=>[]}
const task={id:'task',sessionId:'root',workspaceId:'workspace',request:{operation:'create',source:{kind:'current-conversation'}},compilerMode:'template-fill',context,templateBinding:createTemplateBinding(tools,context.toolOutputs),candidate:{...context.workflow,nodes:[{...context.workflow.nodes[0],kind:'tool',config:{toolId:tool.id}}]}}
host.authorizePlanning(task,caller,true)
assert.equal(JSON.stringify(context.toolOutputs),frozenOutputs)
assert.equal(context.toolOutputs.contracts.find(item=>item.toolId===tool.id)!.guarantee.schema!.schema.type,'string')
assert.equal(context.toolOutputs.contracts.find(item=>item.toolId===tool.id)!.observations[0]!.scope,'this-call-only')
declaration.output.schema.type='object'
assert.throws(()=>host.authorizePlanning(task,caller,true),(error:any)=>error.code==='TOOL_OUTPUT_CONTRACT_CONFLICT')
// Historical records claim no canonical output schema. New metadata is not
// silently attached to their old binding during publication authorization.
const oldContext={...context};delete oldContext.toolOutputs
host.authorizePlanning({...task,context:oldContext,templateBinding:createTemplateBinding(tools)},caller,true)
assert.equal(oldContext.toolOutputs,undefined)
assert.throws(()=>host.authorizePlanning(task,{...caller,parent:foreign,sessionId:'foreign-root'},true),/权限上下文/)

const record={nodeId:'node',executionId:'node',status:'running',subagentId:'owned',repairTaskIds:['owned-repair','other-run','other-execution'],agentEvents:[{summary:'owned stored event'}],agentMessages:[]}
const run={id:'run',workspaceId:'workspace',status:'running',executions:[record]}
const taskView=(taskId:string,runId:string,executionId:string)=>({taskId,runId,executionId,nodeId:'node',parentId:'root',status:'running',startedAt:'2026-10-19T00:00:00Z',steps:1,usage:{totalTokens:2},canSteer:true,events:[{summary:'not part of public projection'}],lifecycle:{cleanup:'pending',errors:[]}})
const native=new Map([
  ['owned',taskView('owned','run','node')],['owned-repair',taskView('owned-repair','run','node/repair/1')],
  ['other-run',taskView('other-run','foreign-run','node')],['other-execution',taskView('other-execution','run','node-other/repair/1')],
])
host.storage={run:(id:string)=>{assert.equal(id,'run');return run}}
host.nativeAgent={inspect:(id:string)=>native.get(id)}
const process=JSON.parse(await host.agentProcess('run','node'))
assert.deepEqual(process.nativeTasks.map((item:any)=>item.taskId),['owned-repair','owned'])
assert.equal(process.taskId,'owned-repair');assert.equal(process.canSteer,true)
assert.ok(process.nativeTasks.every((item:any)=>item.events===undefined&&item.parentId===undefined))
assert.deepEqual(process.events,record.agentEvents)
native.delete('owned-repair');native.delete('owned')
const noOwned=JSON.parse(await host.agentProcess('run','node'))
assert.deepEqual(noOwned.nativeTasks,[]);assert.equal(noOwned.canSteer,false)
await assert.rejects(host.agentProcess('run','missing-execution'),/运行实例不存在/)
run.workspaceId='unknown-workspace'
await assert.rejects(host.agentProcess('run','node'),/工作区不存在/)

console.log(JSON.stringify({ok:true,currentCallerSchema:true,samplesRemainObservations:true,usedSchemaConflict:true,oldTaskCompatibility:true,exactRunProjection:true,unknownWorkspaceDenied:true,modelCalls:0,workflowRuns:0}))
