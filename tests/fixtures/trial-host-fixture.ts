import {moduleCheck} from './planning-module-check.ts'
// Production Host routes, durable journals, artifact verifier and extraction pipeline.
// The execution/model drivers are explicit offline doubles; only temporary files are changed.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import VisibleWorkflowService from '../../src/host/index.ts'
import type { PlanningAgentInput } from '../../src/host/planning/agent.ts'
import type { TrialAgentInput, TrialAgentResult } from '../../src/host/planning/trial-agent.ts'
import type { TrialPublicEvent } from '../../src/shared/planning-trial.ts'
import type { TaskProcedure } from '../../src/shared/retrospective.ts'
import { fixturePlanningEdits, fixturePlanningPrompt } from './planning-edits.ts'

const directory=mkdtempSync(join(tmpdir(),'workflow-trial-host-'))
writeFileSync(join(directory,'input.json'),JSON.stringify({name:'Ada'}))
let executions=0,externalCalls=0,budgetQuestions=0,readonly=false
const prompts:{purpose:string|undefined;prompt:any}[]=[]
let executionMode:'success'|'declared'|'wrong'|'wait'|'incomplete'|'needs-input'|'mutate-input'='success'
let started:((input:TrialAgentInput)=>void)|undefined

async function harness(){
  const ctx=new Context(),definitions=new Map<string,any>()
  const sessionTools=['write','web_fetch','read','run_code','ask_user_question','structured_output','subagent','visible_workflow_run','send_message','set_sandbox']
  const trialAdmissions:string[][]=[]
  const agent=(id:string,parent?:string):any=>({id,ctx,session:{id,header:{cwd:directory,...(parent?{origin:'subagent',parentSession:parent}:{})},requestHeader:()=>({config:{provider:'fixture',model:'offline',reasoningEffort:'none'}})},options:{provider:'fixture',model:'offline',reasoningEffort:'none'}})
  const main=agent('main'),other=agent('other'),child=agent('child','main'),agents=[main,other,child]
  const provisions=[
    ctx.provide('agents',{get:(id:string)=>agents.find(value=>value.id===id),list:()=>agents,roots:()=>[main,other],isOwnedBy:(id:string,owner:any)=>id==='child'&&owner===main,withInitiator:(_agent:unknown,operation:()=>unknown)=>operation()}),
    ctx.provide('workspaceRegistry',{list:()=>[{id:'workspace',title:'Offline trial integration',path:directory,sessionIds:['main','other']}]}),
    ctx.provide('llm',{listProviders:()=>[{id:'fixture',name:'Offline'}],listModels:async()=>[{id:'offline',name:'Offline'}],resolveModelInfo:async()=>({reasoning:{efforts:[{id:'none'}]}}),stream:async function*(){externalCalls++;throw new Error('Real model calls are forbidden in this fixture')}}),
    ctx.provide('tools',{register:(definition:any)=>{definitions.set(definition.name,definition);return()=>{definitions.delete(definition.name)}},schemas:()=>sessionTools.map(name=>({name,description:name,parameters:{type:'object',properties:{}}})),get:(name:string)=>sessionTools.includes(name)?{name}:undefined}),
    ctx.provide('systemPrompt',{section:()=>()=>{}}),ctx.provide('typert',{}),ctx.provide('planMode',{get:()=>({active:readonly})}),
    ctx.provide('userQuestions',{ask:async()=>{budgetQuestions++;throw new Error('No mid-rehearsal review allowed')}}),
  ]
  const fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:directory,planningCompiler:'compact-repair'});await fiber
  assert.equal(fiber.state,2,'Production Host must start with journal recovery enabled')
  const service=fiber.ctx.get('visibleWorkflows')!,planner=(service as any).planner,trials=(service as any).trials
  const start=trials.start.bind(trials)
  trials.start=(request:any,...args:any[])=>{trialAdmissions.push([...request.spec.tools]);return start(request,...args)}
  planner.options.driver.generate=async(input:PlanningAgentInput)=>{
    input.signal.throwIfAborted();input.beforeStep?.(30,100);input.onTask?.(`offline-plan-${prompts.length+1}`)
    const prompt=fixturePlanningPrompt(input);prompts.push({purpose:input.purpose,prompt})
    if(input.purpose==='distill'){
      assert.equal(prompt.source.kind,'verified-trial');assert.ok(prompt.trial.receiptDigest)
      assert.notEqual(prompt.conversation.sessionId,'main','Verified trial evidence belongs to the managed child, not a fabricated root turn')
      assert.ok(prompt.conversation.records.some((record:any)=>record.kind==='tool-result'&&record.status==='reported-success'))
      const reviewItems=prompt.trialTask?.reviewItems??[]
      const procedure:TaskProcedure={goal:'根据可变姓名生成问候报告',parameters:[{name:'name',description:'本次姓名输入'}],rules:['依据当次输入生成结果'],steps:[{id:'S1',title:'生成问候报告',instruction:'读取姓名并生成报告，按冻结规则核对输出。',dependsOn:[],evidenceRefs:prompt.conversation.records.map((record:any)=>record.id),requiresReview:prompt.requirement.text==='用户明确要求每次运行人工审核'}],excluded:[],reviewItems}
      return {steps:1,usage:{totalTokens:10},output:fixturePlanningEdits(input,{outcome:'procedure',procedureJson:JSON.stringify(procedure),summary:'提炼已验收任务的方法',questions:[]})}
    }
    if(input.purpose==='optimize')return {steps:1,usage:{totalTokens:10},output:fixturePlanningEdits(input,{protocolVersion:1,baseDigest:prompt.baseDigest,outcome:'unchanged',summary:'当前没有可由历史样本验证的确定性替换'})}
    const graph=structuredClone(prompt.graph);graph.title='离线试做方法'
    if(!prompt.requirement.text.startsWith('retain-over-target'))graph.nodes[0].config.fields[0].defaultValue='Hello Ada'
    if(prompt.requirement.text.startsWith('retain-over-target')){
      graph.nodes.splice(1,0,{id:'fixture-added-node',kind:'llm',title:'生成报告',config:{prompt:'{{input.text}}',model:input.model}})
      graph.edges=[{source:graph.nodes[0].id,target:'fixture-added-node'},{source:'fixture-added-node',target:graph.nodes.at(-1).id}]
      graph.nodes.at(-1).config.text='{{fixture-added-node.text}}'
    }
    if(prompt.procedure?.steps.some((step:any)=>step.requiresReview)){
      graph.nodes.splice(1,0,{id:'fixture-review',kind:'human',title:'核对称呼',config:{prompt:prompt.procedure.reviewItems.join('\n'),fields:[],actions:[{id:'continue',label:'确认'}]}})
      graph.edges=[{source:graph.nodes[0].id,target:'fixture-review'},{source:'fixture-review',target:graph.nodes.at(-1).id,port:'continue'}]
    }
    if(prompt.requirement.text==='检查失败报告'){
      graph.nodes.splice(1,0,{id:'automatic-check',kind:'code',title:'检查数量',config:{language:'javascript',code:'function main(){throw new Error("数量不符")}',inputs:{}}})
      graph.edges=[{source:graph.nodes[0].id,target:'automatic-check'},{source:'automatic-check',target:graph.nodes.at(-1).id}]
    }
    const ids=['R1',...(prompt.procedure?.steps??[]).map((step:any)=>step.id)]
    return {steps:1,usage:{totalTokens:10},output:fixturePlanningEdits(input,{outcome:'candidate',graphJson:JSON.stringify(graph),summary:'方法候选',assumptions:[],questions:[],requirementCoverage:ids.map(requirementId=>({requirementId,nodeIds:[graph.nodes.find((node:any)=>node.kind==='human'||node.kind==='llm')?.id??graph.nodes.at(-1).id],note:'离线结构覆盖'}))})}
  }
  trials.options.driver.run=async(input:TrialAgentInput):Promise<TrialAgentResult>=>{
    assert.deepEqual(input.tools,trialAdmissions.at(-1),'Admission must preserve session tool names through execution')
    executions++;input.authorize();input.onPrepared?.({toolDigest:'a'.repeat(64),tools:[...input.tools]});input.onStep?.();started?.(input)
    if(executionMode==='wait')return new Promise((_,reject)=>{
      const abort=()=>reject(input.signal.reason??new Error('Cancelled'))
      input.signal.addEventListener('abort',abort,{once:true});if(input.signal.aborted)abort()
    })
    const prompt=JSON.parse(input.prompt),path=prompt.artifacts[0].path
    if(executionMode==='needs-input')return {childId:input.childId,stopReason:'completed',outcome:'needs-input',summary:'缺少用户确认',questions:['请确认报告格式'],events:[],steps:1,evidenceIncomplete:false}
    const name=JSON.parse(readFileSync(join(directory,'input.json'),'utf8')).name
    const result={text:executionMode==='wrong'?'WRONG':`Hello ${name}`},file=join(directory,path)
    mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(result))
    if(executionMode==='mutate-input')writeFileSync(join(directory,'input.json'),JSON.stringify({name:'Changed'}))
    const events:TrialPublicEvent[]=[
      {seq:0,type:'turn/start',turn:0},
      {seq:1,type:'user/message',source:'host',text:'执行冻结的问候报告任务',truncated:false},
      {seq:2,type:'tool/call',turn:0,callId:'write-1',toolName:'write',text:JSON.stringify({path,content:result}),truncated:false},
      {seq:3,type:'tool/result',turn:0,callId:'write-1',text:JSON.stringify(result),truncated:false,isError:false},
      {seq:4,type:'assistant/message',turn:0,text:'已生成报告，等待 Host 独立核验。',truncated:false,interrupted:false},
      {seq:5,type:'turn/end',turn:0,completed:true},
    ]
    for(const event of events)input.onEvent?.(event)
    // r30: a trial that declares its path and submits its procedure must reach authoring unchanged.
    const declared=executionMode==='declared'?{path:[{call:1,tool:'write',label:'写入问候报告',status:'success'}],procedure:{goal:'按输入姓名生成问候报告',parameters:[{name:'name',description:'问候对象姓名'}],rules:['报告只来自本次输入'],steps:[{id:'s1',title:'写入问候报告',instruction:'读取 input.json 的姓名并写入 JSON 问候报告',dependsOn:[],evidenceRefs:['c1'],requiresReview:false,specRefs:[]}],excluded:[],reviewItems:[]}}:{}
    return {childId:input.childId,stopReason:'completed',outcome:'completed',summary:'已写入报告',questions:[],events,steps:1,usage:{totalTokens:12},evidenceIncomplete:executionMode==='incomplete',...declared}
  }
  const tool=async(name:string,args:unknown={},caller=main)=>JSON.parse(await definitions.get(name).execute(args,{agent:caller,signal:new AbortController().signal}))
  const planAccepted=(request:unknown,caller=main)=>tool('visible_workflow_plan',{request_json:JSON.stringify(request)},caller)
  // Test-only draining for the existing content/oracle matrix. The production
  // tool returns its acceptance immediately; this harness explicitly awaits
  // the owning service operation without model polling or another execution.
  const settle=async(receipt:any,caller=main)=>{
    if(!receipt.taskId)return receipt
    const operation=(receipt.taskId.startsWith('trial-')?trials:planner).active.get(receipt.taskId)
    if(operation)await operation.done
    return tool('visible_workflow_plan_get',{task_id:receipt.taskId,include_candidates:true},caller)
  }
  return {main,other,child,service,hasTool:(name:string)=>definitions.has(name),tool,planAccepted,settle,trialAdmissions,plan:async(request:unknown,caller=main)=>settle(await planAccepted(request,caller),caller),close:async()=>{await fiber.dispose();for(const dispose of provisions.reverse())await dispose()}}
}
const request=(id:string,reviewItems:string[]=[])=>({requestId:id,operation:'create',moduleCheck,instruction:'把刚完成的问候报告任务提炼为可复用流程',execution:{mode:'execute-first',task:'读取 input.json 的姓名，生成 JSON 问候报告',tools:['read','write'],inputs:['input.json'],artifacts:[{path:`out/${id}.json`,format:'json',checks:[{kind:'json-equals',pointer:'/text',value:'Hello Ada'}],requireChanged:true}],reviewItems},optimizationTarget:{maxModelCalls:0,maxAgentCalls:0}})
const trialFile=join(directory,'trials','planning','tasks.json'),planningFile=join(directory,'planning','tasks.json')
const journal=()=>JSON.parse(readFileSync(trialFile,'utf8'))
let host=await harness()
try{
  await assert.rejects(host.plan({requestId:'missing-spec',operation:'create',moduleCheck,instruction:'创建工作流'}),/EXECUTION_SPEC_REQUIRED/)
  await assert.rejects(host.plan({...request('illegal-source'),source:{kind:'current-conversation'}}))
  await assert.rejects(host.plan({...request('child-denied')},host.child),/主对话/)
  assert.equal(executions,0);assert.equal(prompts.length,0)
  for(const tools of [['native:web_fetch','builtin:html.select','native:write','native:read'],['unknown_tool'],...['run_code','ask_user_question','structured_output','subagent','visible_workflow_run','send_message','set_sandbox'].map(name=>[name])]){
    const invalid=request('invalid-tools');invalid.execution.tools=tools
    await assert.rejects(host.planAccepted(invalid),(error:any)=>{
      assert.equal(error.code,'TRIAL_TOOLS_INVALID');assert.match(error.message,/试做由 Agent 用当前会话工具真实执行/)
      const detail=JSON.parse(error.message.slice(error.message.indexOf('{')))
      assert.deepEqual(detail.invalidTools,tools.filter(name=>!name.startsWith('native:')));assert.deepEqual(detail.allowedSessionTools,['read','web_fetch','write']);assert.equal(detail.allowedSessionToolsTruncated,false)
      return true
    })
    assert.equal(existsSync(trialFile),false);assert.equal(host.trialAdmissions.length,0);assert.equal(executions,0);assert.equal(prompts.length,0);assert.equal(externalCalls,0)
  }
  const design=await host.plan({requestId:'design-only',operation:'create',moduleCheck,instruction:'用户明确只设计',preview:true,execution:{mode:'design-only'}})
  assert.equal(design.state,'ready',JSON.stringify(design));assert.equal(executions,0);assert.equal(prompts.length,1)
  assert.equal(existsSync(trialFile),false,'Design-only must not persist trial receipts')

  const acceptance=await host.planAccepted(request('success'))
  assert.equal(acceptance.trialState,'preparing',JSON.stringify(acceptance));assert.equal(acceptance.execution,undefined)
  const success=await host.settle(acceptance)
  assert.equal(success.trialState,'ready',JSON.stringify(success));assert.equal(success.state,'published',JSON.stringify(success))
  assert.match(success.taskId,/^trial-/);assert.equal(success.execution.outcome,'completed');assert.equal(success.verification.verdict,'passed')
  assert.equal(success.planning.preview,false);assert.equal(success.planning.receipt.kind,'created');assert.ok(success.planning.candidate)
  assert.equal(success.planning.optimization.stopReason,'already_deterministic')
  assert.equal(success.planning.optimization.selected.targetEvaluation.status,'within_target')
  assert.deepEqual(prompts.map(value=>value.purpose),['author','distill','author']);assert.equal(executions,1)
  assert.equal(success.planning.source.kind,'verified-trial');assert.equal(success.planning.source.trial.trialId,success.taskId)
  assert.ok(existsSync(trialFile)&&existsSync(planningFile),'Verified trial and its preview require durable recovery records')
  assert.equal(journal().tasks.find((row:any)=>row.id===success.taskId).verified.binding.rootSessionId,'main')
  assert.deepEqual(host.trialAdmissions[0],['read','write']);assert.deepEqual(journal().tasks.find((row:any)=>row.id===success.taskId).request.spec.tools,['read','write'])
  assert.ok(JSON.parse(readFileSync(planningFile,'utf8')).tasks.some((row:any)=>row.id===success.planningTaskId&&!row.preview))
  assert.equal(success.planning.firstRun.run.status,'success',JSON.stringify(success.planning.firstRun))
  assert.ok(success.planning.firstRun.run.nodes.every((node:any)=>node.status==='success'))
  assert.equal(success.planning.trialReport.summarySource,'agent-claim')
  assert.equal(host.hasTool('visible_workflow_trial_review'),false)
  assert.equal((await host.plan(request('success'))).planning.firstRun.runId,success.planning.firstRun.runId);
  assert.equal((await host.plan(request('success'))).taskId,success.taskId);assert.equal(executions,1);assert.equal(prompts.length,3)
  await assert.rejects(host.plan({...request('success'),instruction:'changed'}),/REQUEST_ID_CONFLICT/)
  assert.equal((await host.tool('visible_workflow_plan_get',{task_id:success.taskId})).planningTaskId,success.planningTaskId)
  await assert.rejects(host.tool('visible_workflow_plan_get',{task_id:success.taskId},host.other),/不属于当前主对话/)
  await assert.rejects(host.tool('visible_workflow_plan_cancel',{task_id:success.taskId},host.other),/不属于当前主对话/)
  await assert.rejects(host.plan({requestId:'other-source',operation:'create',instruction:'复用',preview:true,source:{kind:'verified-trial',trialId:success.taskId}},host.other),/不属于当前主对话/)
  await assert.rejects(host.plan({requestId:'forged-source',operation:'create',instruction:'复用',preview:true,source:{kind:'verified-trial',trialId:'trial-fabricated'}}),/不存在|不属于/)
  await assert.rejects(host.plan({requestId:'raw-source',operation:'create',instruction:'复用',preview:true,source:{kind:'verified-trial',trialId:success.taskId,evidence:{records:[]}}}))

  const soft=await host.plan({...request('over-target'),instruction:'retain-over-target：保留完整候选并评估零模型目标'})
  assert.equal(soft.state,'published',JSON.stringify(soft));assert.ok(soft.planning.candidate)
  assert.equal(soft.planning.optimization.selection,'baseline');assert.equal(soft.planning.optimization.selected.targetEvaluation.status,'over_target')
  assert.equal(soft.planning.firstRun.run.status,'waiting');assert.equal(soft.planning.firstRun.run.waiting.missingFields[0].name,'text')
  assert.ok(soft.planning.optimization.attempts.length,'An over-target baseline must reach optimization rather than fail planning')
  assert.ok(!soft.planning.diagnostics.some((item:any)=>item.code==='BUDGET_EXHAUSTED'))

  let count=executions
  const absent=request('missing-input');absent.execution.inputs=['absent.json']
  const missing=await host.plan(absent)
  assert.equal(missing.trialState,'failed');assert.ok(missing.diagnostics.some((item:any)=>item.code==='TRIAL_INPUT_UNAVAILABLE'));assert.equal(executions,count)
  const unsafe=request('unsafe-path');unsafe.execution.artifacts[0]!.path='../outside.json'
  await assert.rejects(host.plan(unsafe));assert.equal(executions,count)

  executionMode='wrong';let before=prompts.length
  const wrong=await host.plan(request('wrong'))
  assert.equal(wrong.trialState,'ready');assert.equal(wrong.execution.outcome,'completed');assert.equal(wrong.verification.verdict,'failed')
  assert.ok(wrong.diagnostics.some((item:any)=>item.code==='TRIAL_CHECK_WARNINGS'));assert.equal(prompts.length,before+2);assert.ok(wrong.planningTaskId);assert.equal(wrong.planning.trialReport.verification.verdict,'failed');before=prompts.length
  executionMode='incomplete'
  const incomplete=await host.plan(request('incomplete'))
  assert.equal(incomplete.trialState,'failed');assert.equal(incomplete.verification.verdict,'passed');assert.equal(prompts.length,before)
  assert.ok(incomplete.diagnostics.some((item:any)=>item.code==='TRIAL_EVIDENCE_INCOMPLETE'))
  assert.equal(incomplete.planningTaskId,undefined,'Passing files without complete execution evidence must not become a trusted source')
  executionMode='mutate-input'
  const mutated=await host.plan(request('mutated-input'))
  assert.equal(mutated.trialState,'ready');assert.equal(mutated.verification.verdict,'failed')
  assert.equal(mutated.verification.inputs[0].status,'failed');assert.equal(prompts.length,before+2);before=prompts.length
  writeFileSync(join(directory,'input.json'),JSON.stringify({name:'Ada'}))
  executionMode='needs-input'
  const needing=await host.plan(request('needs-input'))
  assert.equal(needing.trialState,'needs_input');assert.deepEqual(needing.execution.questions,['请确认报告格式']);assert.equal(prompts.length,before)
  const priorExecutions=executions
  assert.equal((await host.plan(request('needs-input'))).taskId,needing.taskId);assert.equal(executions,priorExecutions)

  executionMode='success'
  const reviewed=await host.plan(request('review-notes',['请人工核对称呼是否合适']))
  assert.equal(reviewed.state,'published',JSON.stringify(reviewed));assert.equal(reviewed.humanReview,undefined)
  assert.deepEqual(reviewed.planning.procedure.reviewItems,['请人工核对称呼是否合适'])
  assert.ok(!reviewed.planning.candidate.nodes.some((node:any)=>node.kind==='human'))
  assert.equal(reviewed.planning.firstRun.run.status,'success');assert.equal(budgetQuestions,0)
  const failedRun=await host.plan({...request('run-failed'),instruction:'检查失败报告'})
  assert.equal(failedRun.state,'published');assert.equal(failedRun.planning.firstRun.run.status,'failed',JSON.stringify(failedRun.planning.firstRun))
  assert.ok(failedRun.planning.firstRun.run.nodes.some((node:any)=>node.status==='failed'&&node.error.includes('数量不符')))
  const humanRun=await host.plan({...request('runtime-human',['未来每次运行人工审核']),instruction:'用户明确要求每次运行人工审核'})
  assert.equal(humanRun.state,'published');assert.equal(humanRun.planning.firstRun.run.status,'waiting')
  assert.equal(humanRun.planning.firstRun.run.waiting.actions[0].label,'确认');assert.equal(budgetQuestions,0)
  // Read a surviving trial after its ended planning detail has expired.
  const retainedPlanner=(host.service as any).planner,forgotten=retainedPlanner.tasks.get(reviewed.planningTaskId)
  retainedPlanner.tasks.delete(reviewed.planningTaskId)
  const expired=await host.tool('visible_workflow_plan_get',{task_id:reviewed.taskId})
  assert.equal(expired.planning,undefined);assert.match(expired.planningUnavailable,/已清理/)
  await assert.rejects(host.tool('visible_workflow_plan_get',{task_id:reviewed.planningTaskId}),/已清理/)
  retainedPlanner.tasks.set(forgotten.id,forgotten)


  executionMode='wait'
  let releaseStarted!:(input:TrialAgentInput)=>void
  const entered=new Promise<TrialAgentInput>(resolve=>{releaseStarted=resolve});started=releaseStarted
  const pending=host.plan(request('cancelled')),active=await entered;started=undefined
  assert.equal((await host.tool('visible_workflow_plan_get',{task_id:active.trialId})).trialState,'executing')
  await assert.rejects(host.plan(request('overlap')),/WORKSPACE_TRIAL_BUSY：本对话在同一工作区的试做正在试做业务步骤.*完成后自动释放；这不是遗留任务/)
  const cancelled=await host.tool('visible_workflow_plan_cancel',{task_id:active.trialId})
  assert.equal(cancelled.trialState,'cancelled');assert.equal((await pending).trialState,'cancelled')
  const afterCancel=executions;await host.plan(request('cancelled'));assert.equal(executions,afterCancel,'Retrying cancellation must never replay execution')

  // Simulate process loss after the already journaled executing state. Restoring
  // this durable row must mark it interrupted, without activating any driver.
  await host.close()
  const saved=journal(),crashed=saved.tasks.find((row:any)=>row.id===active.trialId)
  crashed.state='executing';crashed.diagnostics=[];writeFileSync(trialFile,JSON.stringify(saved))
  const beforeRestartExecutions=executions,beforeRestartModels=prompts.length
  host=await harness();executionMode='success'
  const restored=await host.tool('visible_workflow_plan_get',{task_id:success.taskId,include_candidates:true})
  assert.equal(restored.state,'published',JSON.stringify(restored));assert.equal(restored.planning.candidateDigest,success.planning.candidateDigest)
  assert.equal((await host.plan(request('success'))).taskId,success.taskId)
  const interrupted=await host.tool('visible_workflow_plan_get',{task_id:active.trialId})
  assert.equal(interrupted.trialState,'interrupted');assert.ok(interrupted.diagnostics.some((item:any)=>item.code==='TRIAL_INTERRUPTED'))
  assert.equal((await host.plan(request('cancelled'))).trialState,'interrupted')
  assert.equal(executions,beforeRestartExecutions);assert.equal(prompts.length,beforeRestartModels)
  const library=JSON.parse(await host.service.list('workspace'));assert.equal(library.workflows.length,7);assert.equal(library.runs.length,7)
  assert.equal(budgetQuestions,0);assert.equal(externalCalls,0)
  // Fresh R7 trials flow through typed distillation and both author compilers.
  const compilerPlanner=(host.service as any).planner,originalGenerate=compilerPlanner.options.driver.generate;compilerPlanner.options.compilerMode='compact-repair'
  compilerPlanner.options.driver.generate=async(input:PlanningAgentInput)=>{
    input.beforeStep?.(120,undefined);input.beforeSubmission?.();assert.ok(input.compiler)
    const prompt=JSON.parse(input.prompt)
    const value=input.purpose==='distill'?{submission:{mode:'distill',procedure:{goal:'可复用问候',parameters:[{name:'name',description:'姓名'}],rules:['根据本次姓名生成'],steps:[{id:'S1',title:'问候',instruction:'按本次姓名生成问候报告',dependsOn:[],evidenceRefs:prompt.conversation.records.map((r:any)=>r.id),requiresReview:false,specRefs:['trialTask.task']}],excluded:[],reviewItems:[]}}}:{submission:{mode:'create',title:'编译后的试做方法',nodes:[{key:'start',kind:'input',config:{fields:[{name:'name',label:'姓名',required:true}]}},{key:'result',kind:'output',config:{text:'Hello {{input.name}}',outputName:'result'}}],chains:[{key:'main',nodes:['start','result']}],coverage:{R1:['result'],S1:['result']}}}
    if(input.templateQuery){
      const submission=value.submission as any
      assert.equal((input.templateQuery(['input','output']) as any).entries.length,2)
      submission.forms=submission.nodes.map(({kind,config,...node}:any)=>({...node,template:kind,values:config}));delete submission.nodes
    }
    const result=input.compiler.submit(value);assert.equal(result.ok,true,JSON.stringify(result));if(!result.ok)throw Error('compile failed')
    return {output:result.value,steps:1,usage:{totalTokens:10}}
  }
  const compiledTrial=await host.plan(request('compiler-trial'))
  assert.equal(compiledTrial.state,'published',JSON.stringify(compiledTrial));assert.ok(compiledTrial.planning.provenanceDigest)
  assert.equal(compiledTrial.planning.usage.childAttempts,2);assert.equal(budgetQuestions,0);assert.equal(externalCalls,0)
  compilerPlanner.options.compilerMode='template-fill'
  const beforeTemplate=executions,templateTrial=await host.plan(request('template-trial'))
  assert.equal(templateTrial.state,'published',JSON.stringify(templateTrial));assert.equal(templateTrial.verification.verdict,'passed')
  assert.equal(templateTrial.planning.source.kind,'verified-trial');assert.ok(templateTrial.planning.provenanceDigest)
  assert.equal(templateTrial.planning.usage.childAttempts,2);assert.equal(templateTrial.planning.receipt.kind,'created');assert.equal(templateTrial.planning.firstRun.run.status,'waiting')
  assert.equal(executions,beforeTemplate+1);assert.equal((await host.plan(request('template-trial'))).taskId,templateTrial.taskId)
  assert.equal(executions,beforeTemplate+1,'Retrying a template workflow must not replay its business trial')
  const sessionRequest=request('valid-session-tools');sessionRequest.execution.tools=['web_fetch','write','read']
  const sessionAccepted=await host.planAccepted(sessionRequest)
  assert.equal(sessionAccepted.trialState,'preparing');assert.deepEqual(host.trialAdmissions.at(-1),sessionRequest.execution.tools)
  assert.equal((await host.settle(sessionAccepted)).verification.verdict,'passed')
  assert.deepEqual(journal().tasks.find((row:any)=>row.id===sessionAccepted.taskId).request.spec.tools,sessionRequest.execution.tools)
  const beforeReadonlyExecutions=executions,beforeReadonlyAdmissions=host.trialAdmissions.length,beforeReadonlyJournal=readFileSync(trialFile,'utf8')
  compilerPlanner.options.compilerMode='compact-repair';compilerPlanner.options.driver.generate=originalGenerate
  readonly=true
  const readonlyRequest=request('readonly-invalid-tools');readonlyRequest.execution.tools=['native:web_fetch','builtin:html.select','unknown_tool','run_code']
  const readonlyAccepted=await host.planAccepted(readonlyRequest)
  assert.equal(readonlyAccepted.executionMode,'design-only')
  const readonlyPreview=await host.settle(readonlyAccepted);readonly=false
  assert.equal(readonlyPreview.preview,true);assert.equal(readonlyPreview.state,'ready')
  assert.equal(executions,beforeReadonlyExecutions);assert.equal(host.trialAdmissions.length,beforeReadonlyAdmissions);assert.equal(readFileSync(trialFile,'utf8'),beforeReadonlyJournal)
  assert.equal(budgetQuestions,0);assert.equal(externalCalls,0)
  assert.equal(JSON.parse(await host.service.list('workspace')).runs.length,10)
  {
    executionMode='declared';const before=prompts.length
    const declared=await host.plan(request('declared'))
    assert.equal(declared.state,'published',JSON.stringify(declared));assert.equal(declared.planning.distillationSource,'submitted-by-trial',JSON.stringify(declared.planning.diagnostics))
    assert.deepEqual(prompts.slice(before).map(value=>value.purpose),['author'],'A submitted procedure skips the distill model call')
    executionMode='success'
  }
  console.log(JSON.stringify({ok:true,explicitCreateMode:true,actualArtifactVerification:true,verifiedSource:true,templateFreshTrial:true,postSaveRun:true,softTargetRetainsCandidate:true,inputIntegrity:true,idempotent:true,ownership:true,incompleteEvidenceBlocked:true,finalReviewNotes:true,cancelAndNoReplay:true,durableRecovery:true,budgetQuestions,externalCalls,workflowRuns:10}))
}finally{await host.close();rmSync(directory,{recursive:true,force:true})}
