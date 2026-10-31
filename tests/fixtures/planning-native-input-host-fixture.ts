// Real Cordis Host/tools/planner/journal; explicit compiler doubles only.
// No model, Desktop, profile, business run or network.
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import VisibleWorkflowService from '../../src/host/index.ts'
import {makeWorkflow} from '../../src/shared/types.ts'

const directory=mkdtempSync(join(tmpdir(),'planning-task-join-host-')),ctx=new Context(),definitions=new Map<string,any>()
const notices:any[]=[],owner:any={id:'root',ctx,session:{id:'root',header:{cwd:directory},requestHeader:()=>({config:{provider:'fixture',model:'offline'}})},options:{provider:'fixture',model:'offline'},inbox:{nextStep:[],nextTurn:[]},steer:(message:any)=>notices.push(message)}
const foreign:any={...owner,id:'foreign',session:{...owner.session,id:'foreign'}},agents=[owner,foreign]
const provisions=[
  ctx.provide('agents',{get:(id:string)=>agents.find(a=>a.id===id),list:()=>agents,roots:()=>agents,isOwnedBy:()=>false,withInitiator:async(_agent:any,work:()=>Promise<unknown>)=>work()}),
  ctx.provide('workspaceRegistry',{list:()=>[{id:'workspace',path:directory,title:'Join fixture',sessionIds:agents.map(a=>a.id)}]}),
  ctx.provide('llm',{listProviders:()=>[],listModels:()=>[],resolveModelInfo:async()=>({})}),
  ctx.provide('tools',{register:(definition:any)=>{definitions.set(definition.name,definition);return()=>{}},schemas:()=>[]}),
  ctx.provide('systemPrompt',{section:()=>()=>{}}),ctx.provide('typert',{}),
]
const fiber=ctx.plugin(VisibleWorkflowService,{stateDirectory:directory,planningCompiler:'compact-repair'});await fiber
assert.equal(fiber.state,2)
const host=fiber.ctx.get('visibleWorkflows')! as any,planner=host.planner
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve}}
let driverCalls=0
const entered=deferred<any>(),human=deferred<any>(),questionProvider=ctx.provide('userQuestions',{ask:async(request:any)=>{entered.resolve(request);return human.promise}})
const prompts:any[]=[]
planner.options.driver.generate=async(input:any)=>{
  driverCalls++;prompts.push(JSON.parse(input.prompt))
  const payload=driverCalls===1?{submission:{mode:'needs-input',questions:[{id:'style',question:'Select the actual greeting style',options:['Text','JSON']}]}}:{submission:{mode:'edit',updates:{n2:{set:{text:'Human selected text'}}},coverage:{R1:['n2']}}}
  const value=input.compiler.submit(payload)
  assert.equal(value.ok,true,JSON.stringify(value));return {output:value.value,steps:1,usage:{totalTokens:5}}
}
const tool=async(name:string,args:any,agent=owner,signal=new AbortController().signal)=>JSON.parse(await definitions.get(name).execute(args,{agent,signal}))
try{
  const flow=JSON.parse(await host.save(JSON.stringify(makeWorkflow('workspace','Native input target',true)),0)),target=flow.nodes.find((node:any)=>node.kind==='template')
  assert(target);host.planningJoin.begin(owner,1)
  const request={requestId:'native-input-route',operation:'revise',instruction:'First ask a human about the greeting, then use the selected style without repeating that question.',targetWorkflowId:flow.id,expectedRevision:flow.revision,preview:true,targetNodeIds:[target.id],handoff:{version:2,constraints:[],evidenceRefs:[],mode:'partial',changes:[],unresolved:[{nodeId:target.id,fields:['text'],question:'Use the selected text'}],completion:[{nodeId:target.id,field:'text',require:'changed'}]}}
  const accepted=await tool('visible_workflow_plan',{request_json:JSON.stringify(request)})
  const ask=await entered.promise
  assert.equal(ask.agent,owner);assert.deepEqual(ask.questions,[{id:'style',header:'工作流规划',question:'Select the actual greeting style',options:[{label:'Text'},{label:'JSON'}]}])
  // Official stop hook must deliver actual native routing before the human answers.
  await ctx.serial('agent/turn-stopping',{agent:owner,turn:1,signal:new AbortController().signal})
  assert.equal(notices.length,1);assert.match(notices[0].content[0].text,/native-pending/);assert.match(notices[0].content[0].text,/不复制ask_user_question/)
  const pending=await tool('visible_workflow_plan_get',{task_id:accepted.taskId})
  assert.equal(pending.state,'awaiting_input');assert.equal(pending.input.mode,'native-pending');assert.equal(pending.input.manualAnswerAllowed,false);assert.equal(pending.input.revision,pending.revision)
  const waited=await tool('visible_workflow_plan_wait',{task_id:accepted.taskId,wait_ms:0})
  assert.equal(waited.wait.outcome,'needs-input');assert.equal(waited.input.nativeQuestionPending,true);assert.match(waited.wait.instruction,/不要再调用 ask_user_question/)
  for(const revision of [pending.revision,pending.revision+1]){
    const refusal=await tool('visible_workflow_plan_answer',{task_id:accepted.taskId,revision,answers_json:JSON.stringify([{questionId:'style',answer:'Text'}])})
    assert.equal(refusal.answer.accepted,false);assert.equal(refusal.answer.code,'PLANNING_NATIVE_QUESTION_PENDING');assert.equal(refusal.answer.retryable,false);assert.equal(refusal.answer.nextAction,'wait-for-host-question');assert.equal(refusal.state,'awaiting_input');assert.equal(refusal.revision,pending.revision)
  }
  await assert.rejects(tool('visible_workflow_plan_answer',{task_id:accepted.taskId,revision:pending.revision,answers_json:'[]'},foreign),/不属于当前主对话/)
  assert.equal(driverCalls,1)
  human.resolve({answers:[{id:'style',selected:['Text']}]});await planner.active.get(accepted.taskId).done
  const ready=await tool('visible_workflow_plan_wait',{task_id:accepted.taskId,wait_ms:0})
  assert.equal(ready.wait.outcome,'ready');assert.equal(ready.taskId,accepted.taskId);assert.equal(ready.input,undefined);assert.equal(driverCalls,2)
  assert.deepEqual(planner.get(accepted.taskId,host.planningCaller({agent:owner,signal:new AbortController().signal})).request,request)
  assert.equal(prompts[1].humanAnswerContext.taskId,accepted.taskId);assert.equal(prompts[1].humanAnswerContext.phase,'resumed-after-human-answer')
  assert.deepEqual(prompts[1].humanAnswerContext.batches,[{taskId:accepted.taskId,revision:pending.revision,source:'native',questions:[{id:'style',question:'Select the actual greeting style',options:['Text','JSON'],answer:'Text'}]}])
  // No optional native service: first event settles, then wait observes manual-ready.
  await questionProvider();driverCalls=0
  const manual=await tool('visible_workflow_plan',{request_json:JSON.stringify({...request,requestId:'manual-input-route'})})
  await planner.active.get(manual.taskId)?.done
  const manualView=await tool('visible_workflow_plan_wait',{task_id:manual.taskId,wait_ms:0})
  assert.equal(manualView.wait.outcome,'needs-input');assert.equal(manualView.input.mode,'manual');assert.equal(manualView.input.manualAnswerAllowed,true)
  const resumed=await tool('visible_workflow_plan_answer',{task_id:manual.taskId,revision:manualView.revision,answers_json:JSON.stringify([{questionId:'style',answer:'Text'}])})
  assert.equal(resumed.taskId,manual.taskId);await planner.active.get(manual.taskId)?.done
  const manualReady=await tool('visible_workflow_plan_get',{task_id:manual.taskId});assert.equal(manualReady.state,'ready')
  assert.equal(host.planningUI.waiterCount,0);assert.deepEqual(JSON.parse(await host.get(flow.id)),flow);assert.deepEqual(JSON.parse(await host.proposals(flow.id)),[])
  console.log(JSON.stringify({ok:true,registeredTools:true,actualNativeProvider:true,exactAndGuessedRevisionRefused:true,originalHostAnswerResumesSameTask:true,answerBatchBound:true,manualFallback:true,actualJoinNotice:true,noPublication:true,modelRequests:0}))
}finally{await fiber.dispose();for(const dispose of provisions.reverse())await dispose();rmSync(directory,{recursive:true,force:true})}
