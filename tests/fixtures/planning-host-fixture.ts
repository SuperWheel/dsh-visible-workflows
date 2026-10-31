import {moduleCheck} from './planning-module-check.ts'
import { PlanningStore } from '../../src/host/planning/store.ts'
// Production Cordis Host, registered tools, schemas, business clarification and storage.
// Only the planner's model driver and Harness catalogs/questions are explicit
// offline doubles. No workflow execution or external model/network is permitted.
import { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import VisibleWorkflowService from '../../src/host/index.ts'
import type { PlanningAgentInput } from '../../src/host/planning/agent.ts'
import { fixturePlanningEdits, fixturePlanningPrompt } from './planning-edits.ts'
import type { PlanningProjection, PlanningRequest } from '../../src/shared/planning-types.ts'
import type { Workflow } from '../../src/shared/types.ts'
import { queryWorkflowSemantics } from '../../src/shared/workflow-semantics.ts'
import { arrangeNodes } from '../../src/shared/canvas-layout.ts'
import { planningDigest } from '../../src/host/planning/service.ts'

const directory=mkdtempSync(join(tmpdir(),'workflow-planning-host-')),ctx=new Context(),definitions=new Map<string,any>()
const agent=(id:string,parent?:string):any=>({id,ctx,session:{id,header:{cwd:directory,...(parent?{origin:'subagent',parentSession:parent}:{})},requestHeader:()=>({config:{provider:'fixture',model:'offline',reasoningEffort:'none'}})},options:{provider:'fixture',model:'offline',reasoningEffort:'none'}})
const main=agent('main'),other=agent('other'),child=agent('child','main'),agents=[main,other,child],events:string[]=[],questions:any[]=[],driverPrompts:any[]=[]
let readonly=false,externalCalls=0
let nativeSchemas:any[]=[]
let mainLive=true,revokeOnPublishResolution=false,publishResolutions=0
const provisions=[
  ctx.provide('agents',{get:(id:string)=>id==='main'&&!mainLive?undefined:agents.find(item=>item.id===id),list:()=>agents,roots:()=>[main,other],isOwnedBy:(id:string,owner:any)=>id==='child'&&owner===main,withInitiator:async(_parent:any,operation:()=>Promise<unknown>)=>operation()}),
  ctx.provide('workspaceRegistry',{list:()=>[{id:'workspace',title:'Planning fixture',path:directory,sessionIds:['main','other']}]}),
  ctx.provide('llm',{
    listProviders:()=>[{id:'fixture',name:'Offline fixture'}],listModels:async()=>[{id:'offline',name:'Offline model'}],
    resolveModelInfo:async(provider:string,model:string)=>{assert.equal(provider,'fixture','unknown provider must not be resolved');assert.equal(model,'offline','unknown model must not be resolved');if(revokeOnPublishResolution&&++publishResolutions===2)mainLive=false;return {reasoning:{efforts:[{id:'none'}]}}},
    stream:async function*(){externalCalls++;throw new Error('No model request is permitted')},
  }),
  ctx.provide('tools',{register:(definition:any)=>{definitions.set(definition.name,definition);return()=>{}},schemas:()=>nativeSchemas,get:(name:string)=>nativeSchemas.find(tool=>tool.name===name)??definitions.get(name)}),
  ctx.provide('systemPrompt',{section:()=>()=>{}}),ctx.provide('typert',{}),
  ctx.provide('planMode',{get:()=>({active:readonly})}),
  ctx.provide('userQuestions',{ask:async(request:any)=>{assert.equal(request.agent,main);questions.push(request);if(request.questions[0]?.id==='format'){events.push('human-clarification');return {answers:[{id:'format',selected:['文本']}]}}throw Error('Unexpected non-business question')}}),
]
const fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:directory,planningCompiler:'compact-repair'});await fiber
assert.equal(fiber.state,2)
const service=fiber.ctx.get('visibleWorkflows')!,planner=(service as any).planner
planner.options.driver.generate=async(input:PlanningAgentInput)=>{
  input.signal.throwIfAborted();events.push('driver');input.beforeStep?.(30,100);input.onTask?.(`offline-planning-${driverPrompts.length+1}`)
  const prompt=fixturePlanningPrompt(input),graph=structuredClone(prompt.graph) as PlanningProjection
  driverPrompts.push(prompt)
  if(prompt.requirement.text==='clarify'&&!prompt.answers.length)return {steps:1,usage:{totalTokens:10},output:fixturePlanningEdits(input,{outcome:'needs-input',graphJson:'',summary:'需要补充',assumptions:[],questions:[{id:'format',question:'输出采用什么格式？',options:['文本','JSON']}],requirementCoverage:[]})}
  if(prompt.requirement.text!=='change-fixed')graph.title=prompt.operation==='revise'?'Revised fixture':'Generated fixture'
  if(prompt.requirement.text==='change-fixed')graph.nodes.find(node=>prompt.fixedNodeRefs.includes(node.id))!.title='Forbidden fixed edit'
  if(prompt.requirement.text==='legacy-role'){
    const node=graph.nodes.at(-1)!;node.kind='agent';node.config={prompt:'Task',rolePresetId:'old-role',tools:[]}
  }
  if(['unknown-model','current-model'].includes(prompt.requirement.text)){
    const inputNode=graph.nodes[0]!,outputNode=graph.nodes.at(-1)!,id=prompt.nodeIds.find((value:string)=>!graph.nodes.some(node=>node.id===value))!
    graph.nodes.splice(1,0,{id,kind:'llm',title:'Model fixture',config:{prompt:'{{input.text}}',model:prompt.requirement.text==='current-model'?{provider:'fixture',model:'offline'}:{provider:'unknown',model:'unavailable'}}})
    graph.edges=[{source:inputNode.id,target:id},{source:id,target:outputNode.id}]
  }
  if(prompt.requirement.text==='catalog-drift'){
    const inputNode=graph.nodes[0]!,outputNode=graph.nodes.at(-1)!,id=prompt.nodeIds.find((value:string)=>!graph.nodes.some(node=>node.id===value))!
    graph.nodes.splice(1,0,{id,kind:'tool',title:'Catalog tool',config:{toolId:'native:lookup',inputs:{query:'test'}}})
    graph.edges=[{source:inputNode.id,target:id},{source:id,target:outputNode.id}]
  }
  return {steps:1,usage:{totalTokens:10},output:fixturePlanningEdits(input,{outcome:'candidate',graphJson:JSON.stringify(graph),summary:'离线测试候选',assumptions:[],questions:[],requirementCoverage:[{requirementId:'R1',nodeIds:[graph.nodes.at(-1)!.id],note:'结构覆盖测试'}]})}
}
let backgroundAdmissions=0
const tool=async(name:string,args:unknown,caller=main)=>{
  const result=JSON.parse(await definitions.get(name).execute(args,{agent:caller,signal:new AbortController().signal}))
  if(['visible_workflow_plan','visible_workflow_edit','visible_workflow_plan_answer'].includes(name)&&result.delivery?.mode==='background'){
    if(result.state==='queued'){
      backgroundAdmissions++;assert.equal(result.delivery.protocolVersion,1)
      assert.equal(result.receipt,undefined);assert.equal(result.candidate,undefined,'acceptance does not expose a completed candidate')
    }
    await planner.active.get(result.taskId)?.done
    return JSON.parse(await definitions.get('visible_workflow_plan_get').execute({task_id:result.taskId,include_candidates:true},{agent:caller,signal:new AbortController().signal}))
  }
  return result
}
const plan=(request:PlanningRequest,caller=main)=>tool('visible_workflow_plan',{request_json:JSON.stringify({...request,...(request.operation==='create'&&!request.source&&!request.handoff?{moduleCheck}:{}),...(request.operation==='create'&&!request.source?{execution:{mode:'design-only'}}:{})})},caller)
const list=async()=>JSON.parse(await service.list('workspace'))
const snapshot=()=>{const files:Record<string,string>={};const visit=(path:string)=>{for(const item of readdirSync(path,{withFileTypes:true})){const file=join(path,item.name);if(item.isDirectory())visit(file);else if(item.isFile())files[relative(directory,file)]=readFileSync(file).toString('base64')}};visit(directory);return files}
const assertPreviewIdentityOnly=(before:Record<string,string>)=>{
  const after=snapshot(),metadata='planning/background.json'
  for(const name of new Set([...Object.keys(before),...Object.keys(after)]))if(name!==metadata&&name!=='planning/background.journal')assert.equal(after[name],before[name],`read-only preview changed ${name}`)
  const envelope=new PlanningStore<{id:string;preview:boolean}>(directory,()=>true,'background.json').readRaw()
  assert.equal(envelope.version,1)
  const allowed=new Set(['protocolVersion','taskId','requestId','requestDigest','sessionId','workspaceId','acceptedAt','state','interruptedAt','reason','id','preview'])
  // Inspect both snapshots and journal rows: allowing the log must never allow
  // private source/context payloads to escape the compact recovery envelope.
  const journal=after['planning/background.journal']?Buffer.from(after['planning/background.journal'],'base64').toString('utf8').trim().split('\n').slice(1).map(line=>JSON.parse(line)):[]
  for(const task of [...envelope.tasks,...journal])for(const key of Object.keys(task as object))assert.ok(allowed.has(key),`background metadata contains forbidden business payload field ${key}`)
  assert.ok(!/"(?:request|source|history|candidate|context|output)"/.test(JSON.stringify([envelope,journal])))
}
try{
  const dictionaryQuery={kinds:['input','template','output'],topics:['references'],includeSchema:true}
  assert.deepEqual(await tool('visible_workflow_dictionary',{query_json:JSON.stringify(dictionaryQuery)}),queryWorkflowSemantics(dictionaryQuery))
  assert.deepEqual(await tool('visible_workflow_dictionary',{}),queryWorkflowSemantics())
  await assert.rejects(tool('visible_workflow_dictionary',{query_json:'{"kinds":["invented"]}'}))
  assert.equal(questions.length,0,'semantic lookup must not ask for a budget or start model generation')
  assert.equal(driverPrompts.length,0)
  for(const name of ['visible_workflow_plan','visible_workflow_plan_get','visible_workflow_plan_answer','visible_workflow_plan_cancel','visible_workflow_plan_publish'])assert.ok(definitions.has(name),`${name} must be registered by production Host`)
  const create:PlanningRequest={requestId:'create-1',operation:'create',instruction:'Create an editable text workflow',targetWorkflowId:'reserved-workflow'}
  const created=await plan(create)
  assert.equal(created.state,'published',JSON.stringify(created));assert.equal(created.workflowId,'reserved-workflow');assert.equal(created.receipt.kind,'created')
  assert.deepEqual(events.slice(0,1),['driver']);assert.equal(questions.length,0)
  assert.equal(existsSync(join(directory,'creation-budgets')),false)
  assert.equal((await list()).runs.length,0);assert.equal((await list()).workflows.length,1)
  const original=JSON.parse(await service.get(created.workflowId)) as Workflow
  assert.deepEqual(original.nodes,arrangeNodes(original),'T27 persists arranged coordinates')
  assert.deepEqual(original.nodes,created.candidate.nodes,'saved coordinates equal the digested candidate')
  assert.equal(created.candidateDigest,planningDigest(created.candidate))
  assert.equal(created.receipt.digest,created.candidateDigest)
  assert.equal(original.budgetDecision,undefined)
  const library=JSON.parse(readFileSync(join(directory,'library.json'),'utf8'))
  const {verification,...storedReceipt}=created.receipt
  assert(verification.checksPassed.includes('requirement-coverage'));assert.equal(verification.requirementCoverage[0].requirementId,'R1')
  assert.deepEqual(library.planningReceipts,[storedReceipt]);assert.equal(library.workflows[0].id,created.workflowId)
  const calls=driverPrompts.length,repeated=await plan(create)
  assert.equal(repeated.taskId,created.taskId);assert.equal(driverPrompts.length,calls);assert.equal(questions.length,0)
  await assert.rejects(plan({...create,instruction:'Changed content'}),/REQUEST_ID_CONFLICT/)
  assert.equal((await tool('visible_workflow_plan_get',{task_id:created.taskId})).receipt.key,created.receipt.key)
  await assert.rejects(tool('visible_workflow_plan_get',{task_id:created.taskId},other),/不属于当前主对话/)
  await assert.rejects(plan({...create,requestId:'child-plan'},child),/主对话发起/)

  const revised=await plan({requestId:'revise-1',operation:'revise',instruction:'Revise the title',targetWorkflowId:original.id,expectedRevision:original.revision})
  assert.equal(revised.state,'published',JSON.stringify(revised));assert.equal(revised.receipt.kind,'proposed');assert.equal(questions.length,0,'editing never asks for a budget')
  assert.deepEqual(JSON.parse(await service.get(original.id)),original,'a proposal must not overwrite its workflow')
  assert.equal(JSON.parse(await service.proposals(original.id)).length,1)

  // Newly registered Host tools execute through the same real permission and
  // background entry boundary. Metadata reads and decided edits use no driver.
  for(const name of ['visible_workflow_edit','visible_workflow_nodes','visible_workflow_modules'])assert.ok(definitions.has(name),name)
  const beforeDirectCalls=driverPrompts.length,beforeDirectQuestions=questions.length
  const modules=await tool('visible_workflow_modules',{})
  assert.equal(modules[0].id,'structured-result-table');assert.equal(modules[0].version,'1.0.0')
  assert.equal(modules[1].id,'reviewed-file-write');assert.equal(modules[1].version,'1.0.0')
  assert.ok(modules[1].title.includes('审核'))
  assert.equal(modules[0].verification.status,'runtime-fixture-verified')
  const outputNode=original.nodes.find(node=>node.kind==='output')!
  const found=await tool('visible_workflow_nodes',{workflow_id:original.id,expected_revision:original.revision,node_id:outputNode.id})
  assert.equal(found.identity.revision,original.revision);assert.equal(found.ambiguous,false);assert.deepEqual(found.candidates.map((node:any)=>node.nodeId),[outputNode.id])
  const batch=await tool('visible_workflow_nodes',{workflow_id:original.id,expected_revision:original.revision,node_ids:[outputNode.id],fields:['text']})
  assert.ok(batch.nodes.some((node:any)=>node.kind==='output'));assert.equal(batch.identity.workflowId,original.id)
  const single=await tool('visible_workflow_nodes',{workflow_id:original.id,expected_revision:original.revision,node_id:outputNode.id,fields:['text']})
  assert.deepEqual(single,batch,'single-ID field reads must use the same dependency and semantic read path')
  assert.equal(single.semanticContracts[0].kind,'output');assert.equal(single.semanticContracts[0].editField,'text')
  assert.deepEqual(Object.keys(single.nodes.find((node:any)=>node.kind==='output').config),['text'])
  await assert.rejects(tool('visible_workflow_nodes',{workflow_id:original.id,expected_revision:original.revision+1,node_id:outputNode.id}),/REVISION_CONFLICT/)
  await assert.rejects(tool('visible_workflow_modules',{},child),/主对话/)
  const exactEditArgs={request_id:'host-determined-edit',workflow_id:original.id,expected_revision:original.revision,instruction:'已确定：只改输出正文',preview:true,target_node_ids:[outputNode.id],changes:[{op:'set-config',nodeId:outputNode.id,field:'config.text',value:'已确定的输出'}]}
  const exactEdit=await tool('visible_workflow_edit',exactEditArgs)
  assert.equal(exactEdit.state,'ready',JSON.stringify(exactEdit));assert.equal(exactEdit.usage.childAttempts,0)
  assert.equal(exactEdit.candidate.nodes.find((node:any)=>node.id===outputNode.id).config.text,'已确定的输出')
  const canonicalEdit=await tool('visible_workflow_edit',{...exactEditArgs,changes:[{...exactEditArgs.changes[0],field:'text'}]})
  assert.equal(canonicalEdit.taskId,exactEdit.taskId,'the tool alias is canonical before request identity is computed')
  assert.deepEqual(canonicalEdit.candidate,exactEdit.candidate);assert.equal(exactEditArgs.changes[0]!.field,'config.text','caller arguments stay unchanged')
  assert.deepEqual(exactEdit.candidate.edges,original.edges);assert.deepEqual(JSON.parse(await service.get(original.id)),original)
  const modulePreview=await plan({requestId:'host-module-preview',operation:'create',instruction:'已确定：使用结构化结果渲染模块',preview:true,handoff:{version:1,mode:'module',module:{moduleId:'structured-result-table',version:'1.0.0',instanceKey:'summary',parameters:{title:'核对结果',columns:[{key:'name',label:'名称'}],emptyText:'暂无结果'}},constraints:[],evidenceRefs:[]}})
  assert.equal(modulePreview.state,'ready',JSON.stringify(modulePreview));assert.equal(modulePreview.usage.childAttempts,0)
  assert.equal(modulePreview.moduleProvenance.moduleId,'structured-result-table');assert.equal(modulePreview.candidate.nodes.length,3)
  assert.equal(driverPrompts.length,beforeDirectCalls);assert.equal(questions.length,beforeDirectQuestions)

  readonly=true
  const beforePreview=snapshot(),previewCalls=driverPrompts.length,preview=await plan({requestId:'readonly-preview',operation:'create',instruction:'Preview only'})
  assert.equal(preview.state,'ready',JSON.stringify(preview));assert.equal(preview.preview,true);assert.equal(preview.receipt,undefined);assert.ok(preview.candidate)
  assert.equal(driverPrompts.length,previewCalls+1);assert.equal(questions.length,0);assertPreviewIdentityOnly(beforePreview)
  const deniedPublish=await tool('visible_workflow_plan_publish',{task_id:preview.taskId,revision:preview.revision,candidate_digest:preview.candidateDigest})
  assert.equal(deniedPublish.state,'blocked');assert.equal(deniedPublish.receipt,undefined);assert.match(JSON.stringify(deniedPublish.diagnostics),/规划模式/)
  assertPreviewIdentityOnly(beforePreview)
  const publishable=await plan({requestId:'publishable-preview',operation:'create',instruction:'Save after preview'})
  assert.equal(publishable.state,'ready',JSON.stringify(publishable));assertPreviewIdentityOnly(beforePreview)
  readonly=false

  const beforePublishCalls=driverPrompts.length,published=await tool('visible_workflow_plan_publish',{task_id:publishable.taskId,revision:publishable.revision,candidate_digest:publishable.candidateDigest})
  assert.equal(published.state,'published',JSON.stringify(published));assert.equal(published.receipt.kind,'created');assert.equal(questions.length,0,'publishing no longer asks for a budget')
  assert.equal(driverPrompts.length,beforePublishCalls);assert.equal((await list()).runs.length,0)

  const fixedFlow=structuredClone(original);fixedFlow.nodes[0]!.fixed=true
  const fixed=JSON.parse(await service.save(JSON.stringify(fixedFlow),original.revision)) as Workflow
  const fixedResult=await plan({requestId:'fixed-edit',operation:'revise',instruction:'change-fixed',targetWorkflowId:fixed.id,expectedRevision:fixed.revision,targetNodeIds:fixed.nodes.map(node=>node.id)})
  assert.equal(fixedResult.state,'blocked');assert.match(JSON.stringify(fixedResult.diagnostics),/固定/);assert.deepEqual(JSON.parse(await service.get(fixed.id)),fixed)
  const oldRole=await plan({requestId:'old-role',operation:'create',instruction:'legacy-role',preview:true})
  assert.equal(oldRole.state,'failed');assert.match(JSON.stringify(oldRole.diagnostics),/rolePresetId/);assert.equal(oldRole.receipt,undefined)
  const unknown=await plan({requestId:'unknown-model',operation:'create',instruction:'unknown-model',preview:true})
  assert.equal(unknown.state,'ready',JSON.stringify(unknown));assert.equal(unknown.readiness.canRun,false);assert.match(JSON.stringify(unknown.readiness.issues),/模型/)
  assert.equal(unknown.receipt,undefined);assert.equal(externalCalls,0)
  const beforeMissingModel=driverPrompts.length,priorHeader=main.session.requestHeader;main.session.requestHeader=()=>({config:{provider:'fixture',model:''}})
  await assert.rejects(plan({requestId:'missing-parent-model',operation:'create',instruction:'Missing model',preview:true}),/模型/)
  assert.equal(driverPrompts.length,beforeMissingModel,'acceptance cannot freeze an absent initiating model')
  main.session.requestHeader=priorHeader

  nativeSchemas=[{name:'lookup',description:'Offline registered lookup',parameters:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}}]
  const catalogPreview=await plan({requestId:'catalog-drift',operation:'create',instruction:'catalog-drift',preview:true})
  assert.equal(catalogPreview.state,'ready',JSON.stringify(catalogPreview));assert.equal(catalogPreview.readiness.canRun,true)
  const beforeDriftPublish=snapshot(),driftCalls=driverPrompts.length,driftQuestions=questions.length
  nativeSchemas[0].parameters={type:'object',properties:{query:{type:'string'},mode:{type:'string'}},required:['query','mode'],additionalProperties:false}
  const driftResult=await tool('visible_workflow_plan_publish',{task_id:catalogPreview.taskId,revision:catalogPreview.revision,candidate_digest:catalogPreview.candidateDigest})
  assert.equal(driftResult.state,'conflict',JSON.stringify(driftResult));assert.match(JSON.stringify(driftResult.diagnostics),/TOOL_CATALOG_CONFLICT/)
  assert.equal(driverPrompts.length,driftCalls);assert.equal(questions.length,driftQuestions);assert.deepEqual(snapshot(),beforeDriftPublish)
  nativeSchemas=[]

  // Preserve the separate explicit-answer compatibility branch. Native automatic
  // questions are verified immediately below with the production callback.
  const nativeAskQuestions=planner.options.askQuestions
  delete planner.options.askQuestions
  const awaiting=await plan({requestId:'clarify-1',operation:'revise',instruction:'clarify',targetWorkflowId:fixed.id,expectedRevision:fixed.revision,preview:true})
  assert.equal(awaiting.state,'awaiting_input',JSON.stringify(awaiting))
  const answered=await tool('visible_workflow_plan_answer',{task_id:awaiting.taskId,revision:awaiting.revision,answers_json:JSON.stringify([{questionId:'format',answer:'文本'}])})
  assert.equal(answered.state,'ready',JSON.stringify(answered));assert.equal(answered.preview,true)
  const cancelled=await tool('visible_workflow_plan_cancel',{task_id:answered.taskId})
  assert.equal(cancelled.state,'cancelled');assert.equal((await list()).runs.length,0);assert.equal(externalCalls,0)
  planner.options.askQuestions=nativeAskQuestions
  const auto=await plan({requestId:'clarify-native',operation:'revise',instruction:'clarify',targetWorkflowId:fixed.id,expectedRevision:fixed.revision,preview:true})
  assert.equal(auto.state,'ready',JSON.stringify(auto));assert.ok(events.includes('human-clarification'))
  assert.deepEqual(driverPrompts.at(-1).answers,[{questionId:'format',answer:'文本'}])
  assert.equal(questions.filter(question=>question.questions[0]?.id==='format').length,1,'Only the native question callback supplied the automatic answer')
  const permissionPreview=await plan({requestId:'permission-loss',operation:'create',instruction:'current-model',preview:true})
  assert.equal(permissionPreview.state,'ready',JSON.stringify(permissionPreview));assert.equal(permissionPreview.readiness.canRun,true)
  const priorLibrary=readFileSync(join(directory,'library.json'),'utf8'),priorEditor=readFileSync(join(directory,'editor-state.json'),'utf8'),priorCalls=driverPrompts.length
  revokeOnPublishResolution=true;publishResolutions=0
  try{
    const lostPermission=await tool('visible_workflow_plan_publish',{task_id:permissionPreview.taskId,revision:permissionPreview.revision,candidate_digest:permissionPreview.candidateDigest})
    assert.equal(publishResolutions,2,'revoke the live owner during the second resolution, inside agentSave')
    assert.equal(mainLive,false);assert.equal(lostPermission.state,'blocked',JSON.stringify(lostPermission));assert.equal(lostPermission.receipt,undefined)
    assert.equal(driverPrompts.length,priorCalls);assert.equal(readFileSync(join(directory,'library.json'),'utf8'),priorLibrary);assert.equal(readFileSync(join(directory,'editor-state.json'),'utf8'),priorEditor)
    assert.equal((await list()).runs.length,0);assert.equal(externalCalls,0)
  }finally{mainLive=true;revokeOnPublishResolution=false}
  // Historic cases above pin the legacy transport. Exercise the production compiler separately.
  planner.options.compilerMode='compact-repair'
  planner.options.driver.generate=async(input:PlanningAgentInput)=>{
    input.beforeStep?.(100,undefined);input.beforeSubmission?.()
    assert.ok(input.compiler)
    const first=input.compiler.submit({submission:{mode:'create',title:'专用编译器',nodes:[
      {key:'start',kind:'input',config:{fields:[{name:'text',label:'文本',required:true}]}},
      {key:'result',kind:'output',config:{text:'{{missing.text}}',outputName:'result'}},
    ],chains:[{key:'main',nodes:['start','result']}],coverage:{R1:['result']}}})
    assert.equal(first.ok,false);if(first.ok)throw Error('expected repair')
    input.beforeStep?.(120,undefined);input.beforeSubmission?.()
    const fixed=input.compiler.submit({submission:{mode:'repair',draftRevision:first.feedback.draftRevision,patches:[{op:'replace',path:'/nodesByKey/result/config/text',value:'完成 {{input.text}}'}]}})
    assert.equal(fixed.ok,true);if(!fixed.ok)throw Error(JSON.stringify(fixed.feedback))
    return {steps:2,usage:{totalTokens:20},output:fixed.value}
  }
  const compiled=await plan({requestId:'compiler-host',operation:'create',instruction:'输入文字生成完成结果'})
  assert.equal(compiled.state,'published',JSON.stringify(compiled));assert.ok(compiled.receipt)
  assert.equal(compiled.usage.childAttempts,1);assert.equal(compiled.usage.steps,2);assert.equal(externalCalls,0)
  assert.ok(backgroundAdmissions>0,'initial queued delivery was verified separately from terminal results')
  console.log(JSON.stringify({ok:true,registeredPlanningTools:5,noBudgetBeforeDriver:true,atomicReceipt:true,proposalDoesNotOverwrite:true,previewWrites:0,idempotent:true,crossSessionDenied:true,fixedAndOldRoleRejected:true,unknownModelOffline:true,catalogDriftRejected:true,permissionLossBeforeCommit:true,answerAndCancel:true,workflowRuns:0,externalCalls}))
}finally{await fiber.dispose();for(const dispose of provisions.reverse())await dispose();rmSync(directory,{recursive:true,force:true})}
