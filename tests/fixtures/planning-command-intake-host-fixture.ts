import {r16Fixture,r16Tools} from './planning-compiler/r16.ts'
import {templateIdForTool} from '../../src/shared/planning-node-templates.ts'
import {PlanningAgentError} from '../../src/host/planning/agent.ts'
import {moduleCheck} from './planning-module-check.ts'
// Real Host/registry/storage/background lifecycle with deterministic planner doubles.
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import VisibleWorkflowService from '../../src/host/index.ts'
import {makeWorkflow} from '../../src/shared/types.ts'
import {allNodes} from '../../src/shared/workflow-validation.ts'
import {BUSINESS_MODULE_INSTANCE_KEY_RULE} from '../../src/shared/planning-business-module-contract.ts'
import {MAIN_CHAT_GUIDE} from '../../src/host/planning/main-guide.ts'
import {CREATE_TOOL_DESCRIPTION} from '../../src/host/planning/create-entry.ts'
import {PLANNING_WORKFLOW_INDEX_GUIDANCE,PLANNING_RECEIPT_GUIDANCE,PLANNING_ROUTE_GUIDANCE,PLANNING_MODULE_HINT_GUIDANCE} from '../../src/host/planning/command-brief.ts'

const require=createRequire(import.meta.url),sdkRequire=createRequire(require.resolve('@deepseek-ai/dsh-plan-mode'))
const {default:CommandRuntime}=await import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-commands')).href)
const directory=mkdtempSync(join(tmpdir(),'planning-command-intake-')),ctx=new Context(),definitions=new Map<string,any>(),followups:any[]=[],notices:any[]=[],guides:string[]=[],sessionToolGuides:string[]=[],briefSections=new Map<string,any>()
const compilerMode=process.argv[2]==='template-fill'?'template-fill':'compact-repair'
let readonly=false,live=true,calls=0,route='module'
const owner:any={id:'root',ctx,session:{id:'root',append:()=>0,header:{cwd:directory},requestHeader:()=>({config:{provider:'fixture',model:'offline',reasoningEffort:'max'}})},options:{provider:'fixture',model:'offline',reasoningEffort:'max'},inbox:{nextStep:[],nextTurn:[]},followup:(message:any)=>followups.push(message),steer:(message:any)=>notices.push(message)}
const foreign:any={...owner,id:'foreign',session:{...owner.session,id:'foreign'}}
const provisions=[
  ctx.provide('agents',{get:(id:string)=>id===owner.id&&live?owner:id===foreign.id?foreign:undefined,list:()=>[owner,foreign],roots:()=>[owner,foreign],isOwnedBy:()=>false,withInitiator:async(_parent:any,work:()=>Promise<unknown>)=>work()}),
  ctx.provide('workspaceRegistry',{list:()=>[{id:'workspace',path:directory,title:'Fixture',sessionIds:['root','foreign']}]}),
  ctx.provide('llm',{listProviders:()=>[],listModels:()=>[],resolveModelInfo:async()=>({}),stream:()=>{throw Error('Real model calls forbidden')}}),
  ctx.provide('tools',{register:(definition:any)=>{definitions.set(definition.name,definition);return()=>definitions.delete(definition.name)},schemas:()=>[{name:'write',description:'Offline session write',parameters:{type:'object',properties:{}}}],get:(name:string)=>name==='write'?{name}:definitions.get(name)}),
  ctx.provide('systemPrompt',{section:(section:any)=>{if(section.name==='visible-workflows:session-tools')sessionToolGuides.push(section.text);else if(typeof section.text==='string')guides.push(section.text);else briefSections.set(section.name,section);return()=>briefSections.delete(section.name)}}),ctx.provide('typert',{}),ctx.provide('planMode',{get:()=>({active:readonly})}),
]
const registry=ctx.plugin(CommandRuntime);await registry
let fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:directory,planningCompiler:compilerMode,commandEarlyHandoff:true});await fiber;assert.equal(fiber.state,2)
let host:any=fiber.ctx.get('visibleWorkflows'),planner=host.planner
const commands:any=registry.ctx.get('commands')
const tool=async(name:string,args:any,agent=owner)=>JSON.parse(await definitions.get(name).execute(args,{agent,signal:new AbortController().signal}))
const design={mode:'create',title:'指定设计名',nodes:[{key:'start',kind:'input',config:{fields:[]}},{key:'text',kind:'template',config:{text:'设计正文'}},{key:'end',kind:'output',config:{text:'{{text.text}}',outputName:'result'}}],chains:[{key:'main',nodes:['start','text','end']}],coverage:{R1:['text','end']}}
if(compilerMode==='template-fill'){
  const value=design as any
  value.forms=value.nodes.map((node:any)=>({key:node.key,template:node.kind,values:node.config}));delete value.nodes
}
const module={version:1,mode:'module',module:{moduleId:'structured-result-table',version:'1.0.0',instanceKey:'report',parameters:{title:'表格正文标题',columns:[{key:'name',label:'姓名'}]}}}
const driver=async(input:any)=>{
  calls++;assert.equal(input.effort,'max');assert.deepEqual(input.model,{provider:'fixture',model:'offline'})
  input.beforeStep?.(100,undefined,{turn:1,step:1});input.onTask?.('fixture-child-'+calls)
  const prompt=JSON.parse(input.prompt)
  assert(prompt.requirement);assert.match(prompt.brief.source,/Host/);assert.equal(prompt.brief.workspaceId,'workspace')
  assert(!JSON.stringify(prompt.brief).includes('"nodes":'))
  let submission:any
  if(route==='module')submission={mode:'request',request:{execution:{mode:'design-only'},title:'用户工作流标题',handoff:module}}
  else if(route==='design')submission={mode:'design',moduleCheck,plan:design}
  else if(route==='input')submission={mode:'needs-input',questions:[{id:'path',question:'目标文件路径？',options:[]}],summary:'请真人补充'}
  else if(route==='trial')submission={mode:'request',request:{moduleCheck,execution:{mode:'execute-first',task:'生成报告',tools:['write'],inputs:[],artifacts:[{path:'report.txt',format:'text',checks:[{kind:'text-includes',value:'正文'}]}],reviewItems:[]}}}
  else submission={mode:'return-to-main',reason:'这是修改已有工作流，沿用主 Agent 的目标定位和 S02 partial'}
  const compiled=input.compiler.submit({submission});assert.equal(compiled.ok,true,JSON.stringify(compiled))
  return {output:compiled.value,steps:1,usage:{totalTokens:5}}
}
planner.options.driver.generate=driver
async function command(requirement:string){
  const before=followups.length
  const control=new AbortController()
  const result=await commands.execute(owner,'/dsh-visible-workflows '+requirement,[],control.signal)
  assert.equal(result.result.kind,'success');assert.equal(followups.length,before+1)
  const message=followups.at(-1),match=message.content[1].text.match(/\{"taskId":"([^"]+)"\}/)
  assert(match);assert.equal(message.source.kind,'visible-workflow-command')
  assert.equal(JSON.parse(message.content[0].text).requirement,' '+requirement)
  control.abort(new Error('command RPC ended'))
  return match[1]
}
async function settle(id:string){await planner.active.get(id)?.done;return tool('visible_workflow_plan_wait',{task_id:id,wait_ms:1000})}
try{
  await assert.rejects(tool('visible_workflow_plan',{request_json:JSON.stringify({requestId:'bad-key',operation:'create',instruction:'只设计',execution:{mode:'design-only'},handoff:{...module,module:{...module.module,instanceKey:'t20-review-file-write-r15'}}})}),error=>{
    assert.equal((error as Error).message,`handoff.module.instanceKey：${BUSINESS_MODULE_INSTANCE_KEY_RULE}。`);return true
  })
  assert.equal(calls,0,'invalid module must be rejected before planning or publication')
  const original=JSON.parse(await host.save(JSON.stringify(makeWorkflow('workspace','原有流程',true)),0))
  const moduleId=await command('只设计一个结构化表格，工作流叫用户工作流标题')
  host.planningJoin.begin(owner,1)
  const moduleView=await settle(moduleId)
  assert.equal(moduleView.state,'published',JSON.stringify(moduleView));assert.equal(calls,1)
  assert.equal(moduleView.receipt.kind,'created');assert.equal(moduleView.receipt.verification.module,'structured-result-table@1.0.0')
  assert(moduleView.receipt.verification.checksPassed.includes('REVIEW_BEFORE_EFFECT'))
  assert.deepEqual(moduleView.receipt.verification.workspaceChanges.taskWorkflow,{workflowId:moduleView.receipt.workflowId,action:'created',revision:1})
  assert.deepEqual(moduleView.receipt.verification.workspaceChanges.otherWorkflows,[{workflowId:original.id,acceptedRevision:1,publishedRevision:1,unchanged:true}])
  assert.equal(moduleView.receipt.verification.workspaceChanges.existingWorkflowsUnchanged,true)
  const saved=JSON.parse(await host.get(moduleView.receipt.workflowId));assert.equal(saved.title,'用户工作流标题')
  assert.deepEqual(moduleView.receipt.verification.graph,{workflowId:saved.id,revision:saved.revision,status:'saved',candidateDigest:moduleView.candidateDigest,nodeCount:allNodes(saved).length,nodeSummary:allNodes(saved).map(({title,kind})=>({title,kind}))})
  assert.equal(moduleView.receipt.verification.reporting,PLANNING_RECEIPT_GUIDANCE)
  assert.equal(saved.nodes.find((node:any)=>node.kind==='code').config.inputs.specification.title,'表格正文标题')
  const repeat=await tool('visible_workflow_plan_wait',{task_id:moduleId,wait_ms:0,event_cursor:moduleView.event_cursor})
  assert.deepEqual(repeat.events,[]);assert.notEqual(repeat.event_cursor,moduleView.event_cursor)
  assert.match(definitions.get('visible_workflow_plan_wait').parameters.properties.event_cursor.description,/省略、空字符串或纯空白/)
  const noCursor=await tool('visible_workflow_plan_wait',{task_id:moduleId,wait_ms:0})
  for(const event_cursor of ['',' \t\n ']){
    const blank=await tool('visible_workflow_plan_wait',{task_id:moduleId,wait_ms:0,event_cursor})
    assert.deepEqual({...blank,event_cursor:undefined},{...noCursor,event_cursor:undefined})
  }
  await assert.rejects(tool('visible_workflow_plan_wait',{task_id:moduleId,wait_ms:0,event_cursor:'%%%'}),/游标无效.*不带 event_cursor 重新调用/)
  await ctx.serial('agent/turn-stopping',{agent:owner,turn:1,signal:new AbortController().signal})
  assert(notices.length===1,'command task joins the first followup turn even without a tool observation')
  assert.match(notices[0].content[0].text,/published/)
  await assert.rejects(tool('visible_workflow_plan_wait',{task_id:moduleId,wait_ms:0},foreign),/不属于当前主对话/)
  const request=planner.get(moduleId,host.planningCaller({agent:owner,signal:new AbortController().signal})).request
  const duplicate=await planner.start(request,host.backgroundPlanningCaller(host.planningCaller({agent:owner,signal:new AbortController().signal},'selection')),{background:true,commandIntake:{brief:'{}',rawRequirement:'changed brief',readOnly:false}})
  assert.equal(duplicate.id,moduleId);assert.equal(calls,1)

  route='design';const designId=await command('只设计：指定设计名，输出设计正文')
  const designed=await settle(designId);assert.equal(designed.state,'published',JSON.stringify(designed));assert.equal(calls,2,'intake and full design share one activation')
  assert.equal(JSON.parse(await host.get(designed.receipt.workflowId)).title,'指定设计名')
  assert.equal(designed.receipt.verification.requirementCoverage[0].requirementId,'R1')
  assert(designed.receipt.verification.checksPassed.includes('requirement-coverage'))
  assert(!designed.receipt.verification.checksPassed.includes('module-provenance-and-fixed-implementation'))
  assert.deepEqual(designed.receipt.verification.assumptions,[])
  assert.deepEqual(designed.receipt.verification.unresolvedItems,[])
  assert.equal(designed.receipt.verification.workspaceChanges.existingWorkflowsUnchanged,true)
  assert.equal(designed.receipt.verification.workspaceChanges.otherWorkflows.length,2)
  const designGet=await tool('visible_workflow_plan_get',{task_id:designId})
  assert.deepEqual(designGet.receipt.verification,designed.receipt.verification)
  assert.equal(designGet.candidate,undefined)
  const designRecord=planner.get(designId,host.planningCaller({agent:owner,signal:new AbortController().signal}))
  const designSaved=JSON.parse(await host.get(designed.receipt.workflowId))
  assert.deepEqual(designed.receipt.verification.graph,{workflowId:designSaved.id,revision:designSaved.revision,status:'saved',candidateDigest:designRecord.candidateDigest,nodeCount:allNodes(designSaved).length,nodeSummary:allNodes(designSaved).map(({title,kind})=>({title,kind}))})
  assert.equal(designRecord.receipt.verification,undefined,'verification must not change stored receipt shape')
  assert.deepEqual(designRecord.commandIntake.moduleCheck,moduleCheck)

  readonly=true;const previewId=await command('生成一个流程，输出设计正文')
  const preview=await settle(previewId);assert.equal(preview.state,'ready',JSON.stringify(preview));assert.equal(preview.preview,true);assert.equal(preview.receipt,undefined);readonly=false

  route='input';const inputId=await command('只设计，但缺少目标路径')
  const pending=await settle(inputId);assert.equal(pending.state,'awaiting_input');assert.equal(pending.input.manualAnswerAllowed,true)
  route='design';await tool('visible_workflow_plan_answer',{task_id:inputId,revision:pending.revision,answers_json:JSON.stringify([{questionId:'path',answer:'result.txt'}])})
  assert.equal((await settle(inputId)).state,'published')

  route='fallback';const returned=await settle(await command('修改已有流程，但还没有指定目标'))
  assert.equal(returned.state,'returned');assert.match(returned.command.returned,/修改已有/)
  // T31.6: the brief counts saved workflows instead of listing them.
  assert.equal(returned.command.brief.workflows,undefined);assert.ok(returned.command.brief.workflowCount>=1)
  assert.deepEqual(JSON.parse(await host.get(original.id)),original)

  // Stop at the existing trial's needs-input boundary; no business action/model call.
  let trialCalls=0
  host.trials.options.driver.run=async(input:any)=>{trialCalls++;assert.equal(input.effort,'max');return {childId:input.childId,stopReason:'structured',outcome:'needs-input',summary:'离线替身停止',questions:['确认输入'],events:[],steps:0,evidenceIncomplete:false}}
  route='trial';const trialId=await command('生成报告并验收后形成工作流')
  await planner.active.get(trialId)?.done
  const linked=planner.get(trialId,host.planningCaller({agent:owner,signal:new AbortController().signal})).commandIntake.linkedTaskId
  assert(linked.startsWith('trial-'));await host.trials.active.get(linked)?.done
  const trial=await tool('visible_workflow_plan_wait',{task_id:trialId,wait_ms:0})
  assert.equal(trial.trialState,'needs_input');assert.equal(trialCalls,1)
  assert.equal(host.trials.get(linked,host.planningCaller({agent:owner,signal:new AbortController().signal})).request.spec.task,'生成报告')

  // Restart loads new intake rows and pre-T23 ordinary records without new fields.
  const legacy=await tool('visible_workflow_plan',{request_json:JSON.stringify({requestId:'legacy-without-t23',operation:'create',instruction:'旧模块请求',execution:{mode:'design-only'},handoff:module})})
  await planner.active.get(legacy.taskId)?.done
  const historical=planner.get(legacy.taskId,host.planningCaller({agent:owner,signal:new AbortController().signal}))
  assert.equal(historical.commandIntake,undefined);assert.equal(historical.request.title,undefined);assert.equal(historical.state,'published')
  await fiber.dispose()
  const diskBefore=readFileSync(join(directory,'planning','tasks.json'),'utf8')
  fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:directory,planningCompiler:compilerMode});await fiber;assert.equal(fiber.state,2)
  host=fiber.ctx.get('visibleWorkflows');planner=host.planner
  const loaded=planner.get(legacy.taskId,host.planningCaller({agent:owner,signal:new AbortController().signal}))
  assert.equal(loaded.state,'published');assert.deepEqual(loaded.receipt,historical.receipt)
  assert.equal(readFileSync(join(directory,'planning','tasks.json'),'utf8'),diskBefore)
  assert.deepEqual((await tool('visible_workflow_plan_get',{task_id:designId})).receipt.verification,designed.receipt.verification)
  const count=followups.length,callsBefore=calls
  await commands.execute(owner,'/dsh-visible-workflows 回退原路径',[],new AbortController().signal)
  assert.equal(followups.length,count+1);assert.equal(followups.at(-1).content[0].text,'/dsh-visible-workflows 回退原路径');assert.equal(followups.at(-1).source.kind,'user')
  assert.equal(followups.at(-1).content.length,1)
  const briefSignal=new AbortController().signal,briefMessage=followups.at(-1)
  await ctx.waterfall('agent/pre-step',{agent:owner,messages:[briefMessage],turn:5,step:1,signal:briefSignal},async()=>({kind:'enter',messages:[briefMessage]}))
  assert.equal(briefSections.size,1)
  const mainBrief=JSON.parse([...briefSections.values()][0].text({agent:owner,scope:owner,signal:briefSignal}))
  assert.match(mainBrief.source,/Host/);assert(mainBrief.createRequestSkeletons.module.handoff.module)
  await ctx.serial('agent/turn-stopping',{agent:owner,turn:5,signal:briefSignal})
  assert.equal(briefSections.size,0)
  assert.equal(calls,callsBefore,'default command must not start intake or select a model')
  await commands.execute(owner,'/dsh-visible-workflows',[],new AbortController().signal)
  assert.deepEqual(followups.at(-1).content,[{type:'text',text:'/dsh-visible-workflows'}])
  // Default main-agent routing uses the ordinary author, not command intake.
  planner.options.driver.generate=async(input:any)=>{
    calls++;assert.equal(input.effort,'max');assert.deepEqual(input.model,{provider:'fixture',model:'offline'})
    input.beforeStep?.(100,undefined,{turn:1,step:1});input.onTask?.('ordinary-child-'+calls)
    const compiled=input.compiler.submit({submission:{...design,assumptions:['正文由用户输入']}})
    assert.equal(compiled.ok,true,JSON.stringify(compiled));return {output:compiled.value,steps:1,usage:{totalTokens:5}}
  }
  const ordinary=await tool('visible_workflow_plan',{request_json:JSON.stringify({requestId:'ordinary-preview',operation:'create',moduleCheck,instruction:'只设计：输出设计正文',execution:{mode:'design-only'},preview:true})})
  const ready=await settle(ordinary.taskId);assert.equal(ready.state,'ready');assert.equal(ready.receipt,undefined)
  const changedOriginal=JSON.parse(await host.save(JSON.stringify({...original,title:'其他操作修改的原有流程'}),original.revision))
  const published=await tool('visible_workflow_plan_publish',{task_id:ordinary.taskId,revision:ready.revision,candidate_digest:ready.candidateDigest})
  assert.equal(published.state,'published');assert.equal(published.receipt.kind,'created')
  assert.deepEqual(published.receipt.verification.assumptions,['正文由用户输入'])
  assert.equal(published.receipt.verification.requirementCoverage[0].requirementId,'R1')
  assert(published.receipt.verification.checksPassed.includes('REVIEW_BEFORE_EFFECT'))
  assert(!published.receipt.verification.checksPassed.includes('source-provenance'))
  assert(!published.receipt.verification.checksPassed.includes('optimization'))
  const changes=published.receipt.verification.workspaceChanges
  assert.equal(changes.existingWorkflowsUnchanged,false)
  assert.deepEqual(changes.changedWorkflowIds,[original.id])
  assert.deepEqual(changes.otherWorkflows.find((row:any)=>row.workflowId===original.id),{workflowId:original.id,acceptedRevision:original.revision,publishedRevision:changedOriginal.revision,unchanged:false})
  assert.match(changes.source,/不归因于本任务/)
  assert.deepEqual((await tool('visible_workflow_plan_wait',{task_id:ordinary.taskId,wait_ms:0})).receipt,published.receipt)
  assert.deepEqual((await tool('visible_workflow_plan_get',{task_id:ordinary.taskId})).receipt,published.receipt)
  assert.equal(planner.get(ordinary.taskId,host.planningCaller({agent:owner,signal:new AbortController().signal})).receipt.verification,undefined)
  const archived=host.storage.save(makeWorkflow('workspace','已归档流程',true),0)
  host.storage.remove(archived.id,archived.revision)
  const foreignFlow=host.storage.save(makeWorkflow('other-workspace','不可见流程',true),0)
  const sharedFlow=host.storage.save({...makeWorkflow('other-workspace','全局可见流程',true),scope:'global'},0)
  // T23.18: compare the actual command-time brief with the actual list tool,
  // including globals, archived exclusions, foreign private graphs and same-name creation.
  const sameName=host.storage.save(makeWorkflow('workspace',sharedFlow.title,true),0)
  assert.notEqual(sameName.id,sharedFlow.id)
  assert.deepEqual(host.storage.get(sharedFlow.id),sharedFlow)
  await commands.execute(owner,'/dsh-visible-workflows 只设计同名流程',[],new AbortController().signal)
  const indexSignal=new AbortController().signal,indexMessage=followups.at(-1)
  await ctx.waterfall('agent/pre-step',{agent:owner,messages:[indexMessage],turn:6,step:1,signal:indexSignal},async()=>({kind:'enter',messages:[indexMessage]}))
  const indexBrief=JSON.parse([...briefSections.values()][0].text({agent:owner,scope:owner,signal:indexSignal})),listed=await tool('visible_workflow_list',{})
  // T31.6: the brief only counts what the list tool returns; the list keeps the visibility rules.
  assert.equal(indexBrief.workflows,undefined);assert.equal(indexBrief.workflowCount,listed.workflows.length)
  assert(listed.workflows.some((flow:any)=>flow.id===sharedFlow.id))
  assert.equal(listed.workflows.filter((flow:any)=>flow.title===sharedFlow.title).length,2)
  assert(!listed.workflows.some((flow:any)=>[archived.id,foreignFlow.id].includes(flow.id)))
  assert.equal(indexBrief.workflowIndex,PLANNING_WORKFLOW_INDEX_GUIDANCE)
  assert.equal(indexBrief.verificationReceipt,PLANNING_RECEIPT_GUIDANCE)
  // T31.6: the index rule arrives with the command brief only; the standing guide keeps the receipt rule.
  assert(guides.every(text=>!text.includes(PLANNING_WORKFLOW_INDEX_GUIDANCE)&&text.includes(PLANNING_RECEIPT_GUIDANCE)))
  // Session tools and their guidance arrive with the command, never in the global guide.
  assert(sessionToolGuides.length>0&&sessionToolGuides.every(text=>text.includes('workflow_http_request')))
  assert(guides.every(text=>!text.includes('workflow_http_request')))
  await ctx.serial('agent/turn-stopping',{agent:owner,turn:6,signal:indexSignal})
  const scopedSnapshot=host.planningWorkspaceRevisions('workspace')
  assert.equal(scopedSnapshot[archived.id],2)
  assert.equal(scopedSnapshot[foreignFlow.id],undefined)
  assert.equal(scopedSnapshot[sharedFlow.id],1)
  assert(guides.every(text=>text===MAIN_CHAT_GUIDE&&(text.match(/receipt\.verification/g)??[]).length===1))
  live=false;await assert.rejects(commands.execute(owner,'/dsh-visible-workflows 无效主对话',[],new AbortController().signal),/主对话/);live=true
  assert(guides.some(text=>text.includes('receipt.verification')))
  // T31.6: routing and module hints sit on visible_workflow_plan; the default create entry needs neither.
  assert(definitions.get('visible_workflow_plan').description.includes(PLANNING_ROUTE_GUIDANCE+PLANNING_MODULE_HINT_GUIDANCE))
  assert(definitions.get('visible_workflow_create').description===CREATE_TOOL_DESCRIPTION)
  // T23.19: actual registered get/wait views of a failed design task, using the
  // production compiler and verbatim r16 submissions. No fake task injection.
  planner.options.compilerMode='template-fill'
  host.catalog.list=()=>r16Tools()
  for(const failureCode of ['PLANNING_REPAIR_LIMIT','PLANNING_DEADLINE_EXCEEDED','PLANNING_FAILED']){
    planner.options.driver.generate=async(input:any)=>{
      assert.equal(input.effort,'max')
      assert(!input.prompt.includes('moduleCheck'));assert(!input.prompt.includes(moduleCheck.notApplicable))
      if(failureCode!=='PLANNING_FAILED'){
        input.compiler.queryTemplates(['input','output','template','if','loop','human','assigner',...r16Tools().map(tool=>templateIdForTool(tool.id))])
        for(const name of ['initial-args','repair-args',...(failureCode==='PLANNING_REPAIR_LIMIT'?['last-repair-args']:[])] as const){
          const result=input.compiler.submit(r16Fixture(name as any));assert.equal(result.ok,false)
        }
      }
      throw new PlanningAgentError(failureCode,'离线失败终态回放')
    }
    const accepted=await tool('visible_workflow_plan',{request_json:JSON.stringify({requestId:'failed-'+failureCode,operation:'create',instruction:'审核后写文件的失败回放',moduleCheck,execution:{mode:'design-only'}})})
    const waited=await settle(accepted.taskId),got=await tool('visible_workflow_plan_get',{task_id:accepted.taskId})
    assert.equal(got.state,'failed',JSON.stringify(got.diagnostics));assert.equal(got.diagnostics.at(-1).code,failureCode,JSON.stringify(got.diagnostics))
    assert.deepEqual(got.moduleHint,waited.moduleHint)
    assert.deepEqual(planner.get(accepted.taskId,host.planningCaller({agent:owner,signal:new AbortController().signal})).request.moduleCheck,moduleCheck)
    if(failureCode==='PLANNING_FAILED')assert.equal(got.moduleHint,undefined)
    else{
      assert.equal(got.moduleHint.module,'reviewed-file-write@1.0.0')
      assert.equal(got.moduleHint.reason,'这些诊断对应模块已固化的结构')
      assert.equal(got.moduleHint.skeleton.handoff.module.instanceKey,'review')
    }
  }
  console.log(JSON.stringify({ok:true,moduleZeroExtraDesign:true,sameSessionDesign:true,readOnlyPreview:true,needsInput:true,fallbackBrief:true,executeFirst:true,cursor:true,commandJoin:true,legacyStartup:true,rollbackExact:true,realModelCalls:0}))
}finally{await fiber.dispose();await registry.dispose();for(const dispose of provisions.reverse())await dispose();rmSync(directory,{recursive:true,force:true})}
