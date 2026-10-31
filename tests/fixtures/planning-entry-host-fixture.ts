import {moduleCheck} from './planning-module-check.ts'
// Real Cordis Host, native command registry, tools, canvas hints and storage.
// Human answers, Agent followup and the planning model driver are task doubles.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import VisibleWorkflowService from '../../src/host/index.ts'
import { makeWorkflow, type Workflow } from '../../src/shared/types.ts'
import type { PlanningAgentInput } from '../../src/host/planning/agent.ts'
import { fixturePlanningEdits, fixturePlanningPrompt } from './planning-edits.ts'

const require=createRequire(import.meta.url),sdkRequire=createRequire(require.resolve('@deepseek-ai/dsh-plan-mode'))
const {default:CommandRuntime}=await import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-commands')).href)
const directory=mkdtempSync(join(tmpdir(),'workflow-planning-entry-host-')),foreignDirectory=join(directory,'foreign')
mkdirSync(foreignDirectory)
const ctx=new Context(),definitions=new Map<string,any>(),logs:any[]=[],questions:any[]=[],followups:any[]=[]
const agent=(id:string,cwd=directory,parent?:string):any=>({id,ctx,followup:(message:any)=>followups.push({id,message}),session:{id,header:{cwd,...(parent?{origin:'subagent',parentSession:parent}:{})},requestHeader:()=>({config:{provider:'fixture',model:'offline',reasoningEffort:'none'}}),append:(type:string,data:any)=>{logs.push({sessionId:id,type,data});return logs.length-1}},options:{provider:'fixture',model:'offline',reasoningEffort:'none'}})
const main=agent('main'),other=agent('other'),previewRoot=agent('preview-root'),foreign=agent('foreign',foreignDirectory),child=agent('child',directory,'main'),agents=[main,other,previewRoot,foreign,child]
let mainLive=true,externalCalls=0,driverCalls=0,readonly=false
const provisions=[
  ctx.provide('agents',{get:(id:string)=>id==='main'&&!mainLive?undefined:agents.find(value=>value.id===id),list:()=>agents.filter(value=>value!==main||mainLive),roots:()=>[main,other,previewRoot,foreign].filter(value=>value!==main||mainLive),isOwnedBy:(id:string,owner:any)=>id==='child'&&owner===main,withInitiator:async(_parent:any,operation:()=>Promise<unknown>)=>operation()}),
  ctx.provide('workspaceRegistry',{list:()=>[{id:'workspace',title:'Current',path:directory,sessionIds:['main','other','preview-root','not-started']},{id:'foreign-workspace',title:'Other',path:foreignDirectory,sessionIds:['foreign']}]}),
  ctx.provide('llm',{listProviders:()=>[{id:'fixture',name:'Offline'}],listModels:async()=>[{id:'offline',name:'Offline'}],resolveModelInfo:async()=>({reasoning:{efforts:[{id:'none'}]}}),stream:async function*(){externalCalls++;throw new Error('External model calls are forbidden')}}),
  ctx.provide('tools',{register:(definition:any)=>{definitions.set(definition.name,definition);return()=>{definitions.delete(definition.name)}},schemas:()=>[]}),
  ctx.provide('systemPrompt',{section:()=>()=>{}}),ctx.provide('typert',{}),ctx.provide('planMode',{get:()=>({active:readonly})}),
  ctx.provide('userQuestions',{ask:async(request:any)=>{
    questions.push(request)
    if(request.questions[0]?.id==='workflow-target')return {answers:[{id:'workflow-target',selected:[request.questions[0].options[0].label]}]}
    throw Error('Unexpected question: this fixture already supplies all business requirements')
  }}),
]
const registry=ctx.plugin(CommandRuntime);await registry
const fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:directory,planningCompiler:'compact-repair',commandEarlyHandoff:false});await fiber
assert.equal(fiber.state,2)
await new Promise(resolve=>setTimeout(resolve,0))
const service=fiber.ctx.get('visibleWorkflows')!,planner=(service as any).planner,commands=registry.ctx.get('commands') as any
planner.options.driver.generate=async(input:PlanningAgentInput)=>{
  input.signal.throwIfAborted();input.beforeStep?.(30,100);input.onTask?.(`offline-entry-${++driverCalls}`)
  const prompt=fixturePlanningPrompt(input),graph=structuredClone(prompt.graph);graph.description=`Planner candidate ${driverCalls}`
  return {steps:1,usage:{totalTokens:10},output:fixturePlanningEdits(input,{outcome:'candidate',graphJson:JSON.stringify(graph),summary:'离线入口验证',assumptions:[],questions:[],requirementCoverage:[{requirementId:'R1',nodeIds:[graph.nodes.at(-1).id],note:'Reviewed output'}]})}
}
let backgroundAdmissions=0
const tool=async(name:string,args:unknown={},caller=main)=>{
  const result=JSON.parse(await definitions.get(name).execute(args,{agent:caller,signal:new AbortController().signal}))
  if(['visible_workflow_plan','visible_workflow_edit','visible_workflow_splice','visible_workflow_plan_answer'].includes(name)&&result.delivery?.mode==='background'){
    if(result.state==='queued'){
      backgroundAdmissions++;assert.equal(result.delivery.protocolVersion,1)
      assert.equal(result.receipt,undefined);assert.equal(result.candidate,undefined)
    }
    await planner.active.get(result.taskId)?.done
    return JSON.parse(await definitions.get('visible_workflow_plan_get').execute({task_id:result.taskId,include_candidates:true},{agent:caller,signal:new AbortController().signal}))
  }
  return result
}
// T31.5: the request goes as an object; other fixtures keep the request_json text form.
const plan=(request:Record<string,unknown>,caller=main)=>tool('visible_workflow_plan',{request:({...request,...(request.operation==='create'&&!request.source&&!request.handoff?{moduleCheck}:{}),...(request.operation==='create'&&!request.source&&request.execution===undefined?{execution:{mode:'design-only'}}:{})})},caller)
const stored=async(id:string)=>JSON.parse(await service.get(id)) as Workflow
const proposals=async(id:string)=>JSON.parse(await service.proposals(id)) as any[]
const context=(sessionId:string,clientId:string,sequence:number,flow?:Workflow,dirty=false)=>service.setPlanningContext(sessionId,JSON.stringify({clientId,sequence,...(flow?{workflowId:flow.id,revision:flow.revision}:{}),dirty}))
try{
  assert.ok(commands.find(main,'dsh-visible-workflows'),'production Host must register its optional native command')
  for(const name of ['visible_workflow_current','visible_workflow_plan'])assert.ok(definitions.has(name),name)
  for(const name of ['visible_workflow_budget','visible_workflow_prepare'])assert.equal(definitions.has(name),false,name)
  await assert.rejects(tool('visible_workflow_plan',{request:{requestId:'both'},request_json:'{}'}),/只传一个/)
  await assert.rejects(tool('visible_workflow_plan',{}),/缺少 request/)
  // T31: the create entry asks for a save location before anything is admitted.
  await assert.rejects(tool('visible_workflow_create',{title:'统计',request:'统计每个 csv 的行数'}),/CREATE_ARTIFACT_UNKNOWN：/)
  assert.equal(typeof (service as any).increaseBudget,'undefined')
  let flow=JSON.parse(await service.save(JSON.stringify(makeWorkflow('workspace','Current workflow',true)),0)) as Workflow
  const otherFlow=JSON.parse(await service.save(JSON.stringify(makeWorkflow('workspace','Other workflow',true)),0)) as Workflow
  const privateFlow=JSON.parse(await service.save(JSON.stringify(makeWorkflow('foreign-workspace','Foreign workflow',true)),0)) as Workflow
  await context('not-started','early',1,flow)
  assert.deepEqual(JSON.parse(await service.planningUpdates('not-started',0,'')).items,[],'a canvas may mount before its Agent exists')
  assert.equal((await tool('visible_workflow_current')).target,null)
  await context('main','canvas',1,flow)
  assert.deepEqual((await tool('visible_workflow_current')).target,{workflowId:flow.id,title:flow.title,revision:flow.revision,dirty:false})
  assert.equal((await tool('visible_workflow_current',{},other)).target,null,'no fallback to another main conversation')
  await context('main','canvas',2,flow,true)
  assert.equal((await tool('visible_workflow_current')).target.dirty,true)
  const dirty=await plan({requestId:'dirty-denied',operation:'revise',instruction:'Optimize',targetWorkflowId:flow.id,expectedRevision:flow.revision,preview:true})
  assert.ok(['blocked','failed','conflict'].includes(dirty.state),JSON.stringify(dirty));assert.match(JSON.stringify(dirty.diagnostics),/未保存/);assert.equal(driverCalls,0)
  await context('main','canvas',3,{...flow,revision:flow.revision+1})
  await assert.rejects(tool('visible_workflow_current'),/版本/)
  await context('main','canvas',4,privateFlow)
  await assert.rejects(tool('visible_workflow_current'),/当前对话|工作区|范围/)
  await context('main','canvas',5,flow)
  await context('main','second-window',1,otherFlow)
  await assert.rejects(tool('visible_workflow_current'),/多个窗口|明确选择/)
  await context('main','second-window',2)
  assert.equal((await tool('visible_workflow_current')).target.workflowId,flow.id)
  await assert.rejects(tool('visible_workflow_current',{},child),/主对话/)
  mainLive=false;await assert.rejects(tool('visible_workflow_current'),/主对话/);mainLive=true

  const firstProposal=await tool('visible_workflow_save',{json:JSON.stringify({...flow,description:'Main edit'}),expected_revision:flow.revision})
  assert.deepEqual(firstProposal.candidate,{...flow,description:'Main edit'})
  const secondProposal=await tool('visible_workflow_save',{json:JSON.stringify({...flow,description:'Other main edit'}),expected_revision:flow.revision},other)
  assert.deepEqual(secondProposal.candidate,{...flow,description:'Other main edit'})
  assert.equal(questions.length,0);assert.deepEqual(await stored(flow.id),flow,'proposals must not overwrite the saved graph')

  const optimize={requestId:'main-optimize',operation:'revise',instruction:'帮我优化这个 workflow',targetWorkflowId:flow.id,expectedRevision:flow.revision}
  const optimized=await plan(optimize)
  assert.equal(optimized.state,'published',JSON.stringify(optimized));assert.equal(optimized.receipt.kind,'proposed');assert.equal(questions.length,0)
  assert.equal(driverCalls,1)
  assert.equal(optimized.receipt.verification.requirementCoverage[0].requirementId,'R1')
  assert(optimized.receipt.verification.checksPassed.includes('authority'))
  assert(!optimized.receipt.verification.checksPassed.includes('module-provenance-and-fixed-implementation'))
  const publications=JSON.parse(await service.planningUpdates('main',0,''))
  assert.equal(publications.items.length,1);assert.equal(publications.items[0].taskId,optimized.taskId);assert.equal(publications.items[0].proposalId,optimized.receipt.proposalId)
  assert.equal(JSON.parse(await service.planningUpdates('other',0,'')).items.length,0)
  await plan(optimize);assert.equal(driverCalls,1);assert.equal(JSON.parse(await service.planningUpdates('main',0,'')).items.length,1)
  const command=await commands.execute(main,'/dsh-visible-workflows 优化当前流程的说明',[],new AbortController().signal)
  assert.deepEqual(command.result,{kind:'success'});assert.equal(driverCalls,1);assert.equal(questions.length,0)
  assert.equal(logs.at(-1).type,'command/done');assert.equal(logs.at(-1).data.text,undefined)
  assert.equal(followups.length,1);assert.equal(followups[0].id,'main')
  assert.equal(followups[0].message.content[0].text,'/dsh-visible-workflows 优化当前流程的说明');assert.equal(followups[0].message.content.length,1);assert.deepEqual(followups[0].message.source,{kind:'user'})
  assert.equal(JSON.parse(await service.planningUpdates('main',publications.cursor,publications.epoch)).items.length,0,'handoff alone is not a planning publication')
  // Simulate the later main-Agent tool invocation, not a model decision or fake native event.
  // T37.7: one chat keeps one pending proposal per revision, so the user rejects the first before the second is made.
  await assert.rejects(plan({...optimize,requestId:'command-followup-tool',instruction:'优化当前流程的说明'}),/REVISION_PENDING/)
  await service.resolveProposal(optimized.receipt.proposalId,'reject',flow.revision)
  const fromTurn=await plan({...optimize,requestId:'command-followup-tool',instruction:'优化当前流程的说明'})
  assert.equal(fromTurn.receipt.kind,'proposed');assert.equal(driverCalls,2);assert.equal(questions.length,0)
  assert.equal(JSON.parse(await service.planningUpdates('main',publications.cursor,publications.epoch)).items.length,1,'the actual tool publication reaches the exact-session journal')

  // Reviewed graph publication remains explicit and version bound.
  const previousRevision=flow.revision
  await service.resolveProposal(firstProposal.id,'accept',flow.revision)
  flow=await stored(flow.id);await context('main','canvas',6,flow)
  assert.equal(flow.description,'Main edit');assert.equal(flow.revision,previousRevision+1)
  await assert.rejects(service.resolveProposal(secondProposal.id,'accept',previousRevision),/版本|修改/)
  const beforePreviewQuestions=questions.length;readonly=true
  const preview=await plan({requestId:'preview-new-conversation',operation:'revise',instruction:'Only preview',targetWorkflowId:flow.id,expectedRevision:flow.revision},previewRoot)
  assert.equal(preview.state,'ready',JSON.stringify(preview));assert.equal(preview.preview,true);assert.equal(preview.receipt,undefined)
  assert.equal(questions.length,beforePreviewQuestions)
  const beforeForeignDriver=driverCalls,beforeForeignTasks=[...planner.tasks.values()].map((task:any)=>[task.id,task.state,task.revision])
  await assert.rejects(plan({requestId:'foreign-preview',operation:'revise',instruction:'Only preview',targetWorkflowId:flow.id,expectedRevision:flow.revision},foreign),/当前对话工作区/)
  assert.equal(driverCalls,beforeForeignDriver,'foreign preview must be rejected before invoking the planning driver')
  assert.deepEqual([...planner.tasks.values()].map((task:any)=>[task.id,task.state,task.revision]),beforeForeignTasks,'rejected foreign preview must not add or mutate task state')
  readonly=false
  const publishedPreview=await tool('visible_workflow_plan_publish',{task_id:preview.taskId,revision:preview.revision,candidate_digest:preview.candidateDigest},previewRoot)
  assert.equal(publishedPreview.state,'published',JSON.stringify(publishedPreview));assert.equal(publishedPreview.receipt.kind,'proposed');assert.equal(questions.length,beforePreviewQuestions)
  planner.options.compilerMode='template-fill'
  planner.options.driver.generate=async(input:PlanningAgentInput)=>{
    input.beforeStep?.(120,undefined);input.beforeSubmission?.();assert.ok(input.compiler);assert.ok(input.templateQuery)
    assert.equal((input.templateQuery(['input','output']) as any).entries.length,2)
    const result=input.compiler.submit({submission:{mode:'create',title:'模板入口预览',forms:[
      {key:'start',template:'input',values:{fields:[{name:'text',label:'输入',required:true}]}},
      {key:'result',template:'output',values:{text:'{{input.text}}',outputName:'result'}},
    ],chains:[{key:'main',nodes:['start','result']}],coverage:{R1:['result']}}})
    assert.equal(result.ok,true,JSON.stringify(result));if(!result.ok)throw Error('template compile failed')
    return {output:result.value,steps:1,usage:{totalTokens:10}}
  }
  readonly=true
  const templatePreview=await plan({requestId:'template-create',operation:'create',instruction:'创建输入原文输出的流程',preview:true},previewRoot)
  assert.equal(templatePreview.state,'ready',JSON.stringify(templatePreview));assert.equal(templatePreview.receipt,undefined)
  assert.equal(templatePreview.candidate.nodes.length,2);assert.equal(templatePreview.usage.childAttempts,1)
  assert.equal(questions.length,beforePreviewQuestions);readonly=false
  // Exercise the registered chain tools through the real Host. Submit reversed
  // storage order and unusual display numbering, then bind to the saved graph.
  planner.options.driver.generate=async()=>{driverCalls++;throw Error('Determined chain edits must not invoke a planning driver')}
  for(const name of ['visible_workflow_chain','visible_workflow_splice'])assert.ok(definitions.has(name),name)
  const chainDraft=makeWorkflow('workspace','链入口独立验收',true),chainOrder=chainDraft.nodes.map(node=>node.id)
  const anchor=chainDraft.nodes[1]!,entryEdge=chainDraft.edges[0]!,exitEdge=chainDraft.edges[1]!
  anchor.number='strange-99';chainDraft.nodes.reverse()
  const chainFlow=JSON.parse(await service.save(JSON.stringify(chainDraft),0)) as Workflow
  const chainArgs={workflow_id:chainFlow.id,expected_revision:chainFlow.revision,anchor_node_id:anchor.id}
  const driverBeforeChain=driverCalls,chainTasksBefore=planner.tasks.size
  const chainView=await tool('visible_workflow_chain',{...chainArgs,chain_key:'piece',template_ids:['template','code']})
  assert.deepEqual(chainView.nodes.map((node:any)=>node.nodeId),chainOrder,'stable UUID edges determine order, never storage position')
  assert.deepEqual(chainView.nodes.map((node:any)=>node.alias),['piece-1','piece-2','piece-3'])
  const savedAnchor=chainFlow.nodes.find(node=>node.id===anchor.id)!
  assert.equal(chainView.nodes[1].actualNumber,savedAnchor.number);assert.equal(chainView.anchorNodeId,anchor.id)
  assert.deepEqual(chainView.templateCatalog.templates.map((value:any)=>value.id),['template','code'])
  assert.equal(planner.tasks.size,chainTasksBefore,'read-chain must not admit a planning task')
  assert.deepEqual(await tool('visible_workflow_chain',{...chainArgs,chain_key:'piece',template_ids:['template','code']}),chainView,'cached read retains exact binding')
  const bounded=await tool('visible_workflow_chain',{...chainArgs,entry_edge_id:entryEdge.id,exit_edge_id:exitEdge.id})
  assert.deepEqual(bounded.nodes.map((node:any)=>node.nodeId),[anchor.id]);assert.equal(bounded.nodes[0].alias,'a-1')
  assert.deepEqual(bounded.boundary,{entryEdgeId:entryEdge.id,exitEdgeId:exitEdge.id})
  await assert.rejects(tool('visible_workflow_chain',{...chainArgs,entry_edge_id:'missing-edge'}),/边界|edgeId/)
  await assert.rejects(tool('visible_workflow_chain',{...chainArgs,anchor_node_id:savedAnchor.number}),/不存在/,'a display number is not a stable anchor')
  await assert.rejects(tool('visible_workflow_chain',{...chainArgs,expected_revision:chainFlow.revision-1}),/REVISION_CONFLICT/)
  await assert.rejects(tool('visible_workflow_chain',{...chainArgs,template_ids:Array(6).fill('template')}),/5|Too big/)
  await assert.rejects(tool('visible_workflow_chain',{...chainArgs,template_ids:['template','template']}),/不同模板/)
  await assert.rejects(tool('visible_workflow_chain',{...chainArgs,template_ids:['native:invented-tool']}),/不存在模板/)
  await assert.rejects(tool('visible_workflow_chain',chainArgs,child),/主对话/)
  await assert.rejects(tool('visible_workflow_chain',chainArgs,foreign),/当前对话工作区/)
  await context('main','chain-canvas',1,chainFlow,true)
  await assert.rejects(tool('visible_workflow_chain',chainArgs),/未保存/,'a warm cached read must still recheck the current canvas')
  await context('main','chain-canvas',2,chainFlow)
  assert.deepEqual(await tool('visible_workflow_chain',{...chainArgs,entry_edge_id:entryEdge.id,exit_edge_id:exitEdge.id}),bounded)
  const chainRequest={version:bounded.version,baseDigest:bounded.baseDigest,baseRevision:bounded.baseRevision,chainKey:bounded.chainKey,anchorNodeId:bounded.anchorNodeId,scope:bounded.scope,boundary:bounded.boundary,
    operations:[{op:'insert',draftRevision:0,target:'a-1',position:'after',nodes:[{key:'inserted',template:'template',values:{text:'新增顺序节点'}}]}],exports:[]}
  const spliceArgs={request_id:'chain-splice-preview',workflow_id:chainFlow.id,expected_revision:chainFlow.revision,instruction:'在明确边界内保留原节点并后插已确定模板，不执行业务',chain_json:JSON.stringify(chainRequest),preview:true,target_node_ids:[anchor.id]}
  const beforeMalformed=planner.tasks.size
  await assert.rejects(tool('visible_workflow_splice',{...spliceArgs,request_id:'oversize-splice',chain_json:' '.repeat(160_001)}),/过大|字节|长度|超过/)
  await assert.rejects(tool('visible_workflow_splice',{...spliceArgs,request_id:'echoed-chain',chain_json:JSON.stringify({...chainRequest,nodes:bounded.nodes})}),/nodes|Unrecognized/)
  await assert.rejects(tool('visible_workflow_splice',spliceArgs,child),/主对话/)
  await assert.rejects(tool('visible_workflow_splice',spliceArgs,foreign),/当前对话工作区/)
  assert.equal(planner.tasks.size,beforeMalformed,'invalid payload and foreign ownership must not create tasks')
  const acceptedChain=JSON.parse(await definitions.get('visible_workflow_splice').execute(spliceArgs,{agent:main,signal:new AbortController().signal}))
  assert.equal(acceptedChain.delivery.protocolVersion,1);assert.ok(acceptedChain.taskId)
  assert.equal(acceptedChain.receipt,undefined);assert.equal(acceptedChain.candidate,undefined,'acceptance is not a ready candidate')
  await planner.active.get(acceptedChain.taskId)?.done
  const chainPreview=await tool('visible_workflow_plan_get',{task_id:acceptedChain.taskId,include_candidates:true})
  assert.equal(chainPreview.state,'ready',JSON.stringify(chainPreview));assert.equal(chainPreview.preview,true)
  assert.equal(chainPreview.usage.childAttempts,0);assert.equal(driverCalls,driverBeforeChain)
  assert.equal(chainPreview.handoff.route,'chain');assert.equal(chainPreview.chain.mapping.length,2)
  assert.equal(chainPreview.chain.mapping.find((row:any)=>row.nodeId===anchor.id).actualNumber,savedAnchor.number)
  assert.deepEqual(chainPreview.candidate.nodes.find((node:any)=>node.id===anchor.id),chainFlow.nodes.find(node=>node.id===anchor.id))
  assert.equal(chainPreview.candidate.nodes.length,chainFlow.nodes.length+1)
  assert.equal(chainPreview.candidate.edges.find((edge:any)=>edge.id===entryEdge.id).target,anchor.id,'unmodified entry boundary retains its edge ID')
  assert.deepEqual(await stored(chainFlow.id),chainFlow);assert.equal((await proposals(chainFlow.id)).length,0)
  const chainRepeat=await tool('visible_workflow_splice',spliceArgs)
  assert.equal(chainRepeat.taskId,acceptedChain.taskId);assert.equal(driverCalls,driverBeforeChain)
  await assert.rejects(tool('visible_workflow_splice',{...spliceArgs,instruction:'Different content with the same request'}),/REQUEST_ID_CONFLICT/)
  const directChain=await plan({requestId:'chain-v3-plan',operation:'revise',instruction:spliceArgs.instruction,targetWorkflowId:chainFlow.id,expectedRevision:chainFlow.revision,targetNodeIds:[anchor.id],preview:true,handoff:{version:3,mode:'chain',chain:chainRequest}})
  assert.equal(directChain.state,'ready',JSON.stringify(directChain));assert.ok(directChain.taskId)
  assert.equal(directChain.usage.childAttempts,0);assert.deepEqual(directChain.chain.mapping.map((row:any)=>row.temporaryAlias),chainPreview.chain.mapping.map((row:any)=>row.temporaryAlias))
  const staleChain=await tool('visible_workflow_splice',{...spliceArgs,request_id:'chain-old-digest',chain_json:JSON.stringify({...chainRequest,baseDigest:'f'.repeat(64)})})
  assert.ok(['failed','blocked','conflict'].includes(staleChain.state),JSON.stringify(staleChain));assert.match(JSON.stringify(staleChain.diagnostics),/CHAIN_BASE_CONFLICT|旧工作流版本/)
  assert.equal(staleChain.usage.childAttempts,0);assert.equal(driverCalls,driverBeforeChain)
  const chainPublished=await tool('visible_workflow_plan_publish',{task_id:chainPreview.taskId,revision:chainPreview.revision,candidate_digest:chainPreview.candidateDigest})
  assert.equal(chainPublished.state,'published',JSON.stringify(chainPublished));assert.equal(chainPublished.receipt.kind,'proposed')
  const chainProposal=(await proposals(chainFlow.id)).find(value=>value.id===chainPublished.receipt.proposalId)
  assert.equal(chainProposal.status,'pending');assert.deepEqual(await stored(chainFlow.id),chainFlow,'publication uses the original review mechanism without overwriting the graph')
  const rejectedChain=JSON.parse(await service.resolveProposal(chainProposal.id,'reject',chainFlow.revision))
  assert.equal(rejectedChain.status,'rejected');assert.deepEqual(await stored(chainFlow.id),chainFlow)
  const chainAdvanced=JSON.parse(await service.save(JSON.stringify({...chainFlow,description:'Independent revision invalidates the old chain'}),chainFlow.revision)) as Workflow
  assert.equal(chainAdvanced.revision,chainFlow.revision+1)
  await context('main','chain-canvas',3,chainAdvanced)
  await assert.rejects(tool('visible_workflow_chain',chainArgs),/REVISION_CONFLICT/,'a previously cached chain cannot cross a saved revision')
  await assert.rejects(tool('visible_workflow_splice',{...spliceArgs,request_id:'chain-old-revision'}),/REVISION_CONFLICT|版本/)
  assert.equal(driverCalls,driverBeforeChain)
  assert.equal(JSON.parse(await service.list('workspace')).runs.length,0);assert.equal(externalCalls,0);assert.equal(questions.length,0)
  assert.ok(backgroundAdmissions>0,'queued acceptance is tested separately from settled planning')
  console.log(JSON.stringify({ok:true,nativeCommand:true,currentScope:true,dirtyDenied:true,staleDenied:true,liveRoot:true,noBudgetApi:true,noBudgetQuestions:true,commandHandoffAndToolPublication:true,templateCreate:true,proposalOnly:true,chainReadStableAnchor:true,chainExplicitBoundaries:true,chainReadAuthorization:true,chainInputBounds:true,chainSpliceAcceptance:true,chainSpliceIdempotent:true,chainV3Plan:true,chainZeroChild:true,chainStaleRejected:true,chainOriginalReview:true,externalCalls,workflowRuns:0}))
}finally{await fiber.dispose();await registry.dispose();for(const dispose of provisions.reverse())await dispose();rmSync(directory,{recursive:true,force:true})}
