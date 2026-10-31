import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { trialAgentOutputSchema } from '../src/host/planning/trial-agent.ts'
import { trialCallIndex, trialConversationEvidence, trialProcedureRefs, verifyTrialPath } from '../src/host/planning/trial-evidence.ts'
import { WorkflowTrialService, type TrialRequest } from '../src/host/planning/trial-service.ts'
import { WorkflowPlanningService, type PlanningCaller, type PlanningTask } from '../src/host/planning/service.ts'
import { ModelAdmission } from '../src/host/run-usage.ts'
import { makeWorkflow } from '../src/shared/types.ts'
import type { TrialPath, TrialPublicEvent } from '../src/shared/planning-trial.ts'
import type { ConversationEvidence, TaskProcedure } from '../src/shared/retrospective.ts'
import { fixturePlanningEdits, fixturePlanningPrompt, fixtureSubmit } from './fixtures/planning-edits.ts'

const cleanups:(()=>Promise<void>)[]=[]
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup()})
function events(count=4):TrialPublicEvent[]{
  const rows:TrialPublicEvent[]=[{seq:0,type:'turn/start',turn:1}]
  for(let i=1;i<=count;i++)rows.push({seq:2*i-1,type:'tool/call',turn:1,callId:`opaque-${i}`,toolName:i===count?'write':'workflow_http_request',text:JSON.stringify({attempt:i}),truncated:false},{seq:2*i,type:'tool/result',turn:1,callId:`opaque-${i}`,text:i===1?'失败尝试':`result-${i}`,truncated:false,isError:i===1})
  rows.push({seq:2*count+1,type:'assistant/message',turn:1,text:'不应送往生成的绕路说明',interrupted:false,truncated:false},{seq:2*count+2,type:'turn/end',turn:1,completed:true})
  return rows
}
const path:TrialPath=[{call:3,tool:'workflow_http_request',label:'取得输入',status:'success'},{call:4,tool:'write',label:'写入结果',status:'success'}]
const evidence=(rows=events(),declaration:unknown=path,onDiagnostic=vi.fn())=>trialConversationEvidence({childSessionId:'child',events:rows,path:declaration,evidenceIncomplete:false,reviewed:false,onDiagnostic})
const procedure=(source:Pick<ConversationEvidence,'records'>,reviewItems:string[]=[]):TaskProcedure=>({goal:'根据输入生成报告',parameters:[{name:'text',description:'本次输入'}],rules:['不复制旧产物'],steps:[{id:'S1',title:'生成报告',instruction:'读取本次输入并生成报告',dependsOn:[],evidenceRefs:source.records.map(row=>row.id),requiresReview:false,specRefs:['trialTask.task']}],excluded:[],reviewItems})

describe('trial declared path evidence',()=>{
  it('keeps only declared full call/result excerpts and counts excluded attempts',()=>{
    const rows=events(),before=structuredClone(rows),result=evidence(rows)
    expect(result.records.map(row=>row.id)).toEqual(['e5','e6','e7','e8'])
    expect(result.records.map(row=>row.text)).toEqual(['{"attempt":3}','result-3','{"attempt":4}','result-4'])
    expect(result.warnings).toContain('另有 2 次尝试已排除（workflow_http_request×2）')
    expect(JSON.stringify(result)).not.toContain('绕路说明');expect(rows).toEqual(before)
    expect(trialCallIndex(rows).map(row=>[row.number,row.call.callId,row.result?.seq])).toEqual([[1,'opaque-1',2],[2,'opaque-2',4],[3,'opaque-3',6],[4,'opaque-4',8]])
  })
  it.each([
    [{call:99,tool:'write',label:'不存在',status:'success'}],
    [{call:3,tool:'write',label:'编号与工具不符',status:'success'}],
    [...path].reverse(),
    [path[0],path[0]],
    [{call:1,tool:'workflow_http_request',label:'错误调用',status:'success'}],
    [{call:3,tool:'workflow_http_request',label:'无原因绕行',status:'success',workaround:true}],
  ])('falls back with a diagnostic for invalid path %j',declaration=>{
    const diagnostic=vi.fn(),result=evidence(events(),declaration,diagnostic)
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({code:'TRIAL_PATH_INVALID'}))
    expect(result.records).toHaveLength(9);expect(result.warnings.join(' ')).toContain('TRIAL_PATH_INVALID')
  })
  it('accepts truncated successful excerpts but rejects unknown and structured output references',()=>{
    const truncated=events();Object.assign(truncated[6]!,{truncated:true})
    expect(verifyTrialPath(truncated,path).selected.size).toBe(2)
    const unknown=events();Object.assign(unknown[6]!,{text:'{"outcome":"unknown"}'})
    // Only the step whose call is unknown is realigned to that tool's earlier success; the rest stays.
    expect(verifyTrialPath(unknown,path)).toMatchObject({entries:[{call:2},{call:4}],renumbered:new Map([[3,2]])})
    const rows=events();Object.assign(rows[7]!,{toolName:'structured_output'})
    expect(trialCallIndex(rows)).toHaveLength(3)
    const kept=verifyTrialPath(rows,path);expect(kept.entries.map(entry=>entry.call)).toEqual([3]);expect(kept.warnings.join(' ')).toContain('#4 write 对不上实际调用')
    expect(()=>verifyTrialPath(rows,[path[1]!])).toThrow('没有一步')
  })
  it('preserves workaround gaps and the last failure at the end of a stuck path',()=>{
    const rows=events();Object.assign(rows[8]!,{isError:true,text:'write failed'})
    const declared:TrialPath=[{...path[0]!,workaround:true,reason:'由Range片段手工拼装HTML'},{...path[1]!,status:'failed'}]
    const result=evidence(rows,declared)
    expect(result.records.slice(-2).map(row=>row.status)).toEqual(['failed','failed'])
    expect(result.warnings.join(' ')).toContain('未跑通：取得输入');expect(result.warnings.join(' ')).toContain('最后一次尝试失败')
    const newer=events();Object.assign(newer[6]!,{isError:true})
    // A stuck step cites that tool's last failure; a stuck step before the end is dropped alone.
    expect(verifyTrialPath(newer,[{call:1,tool:'workflow_http_request',label:'过期失败',status:'failed'}]).entries).toMatchObject([{call:3}])
    const early=verifyTrialPath(rows,[{...path[1]!,status:'failed'},path[0]!]);expect(early.entries).toEqual([path[0]]);expect(early.warnings.join(' ')).toContain('只去掉这几步')
  })
  it('realigns a path numbered past an off-path call by tool, and the procedure refs with it (Desktop r56 C)',()=>{
    const tools=['workflow_http_request','glob','workflow_html_select','write','read','workflow_file_stat'],rows:TrialPublicEvent[]=[{seq:0,type:'turn/start',turn:1}]
    tools.forEach((toolName,i)=>rows.push({seq:2*i+1,type:'tool/call',turn:1,callId:`c-${i}`,toolName,text:'{}',truncated:false},{seq:2*i+2,type:'tool/result',turn:1,callId:`c-${i}`,text:'ok',truncated:false,isError:false}))
    rows.push({seq:13,type:'turn/end',turn:1,completed:true})
    const declared:TrialPath=tools.filter(tool=>tool!=='glob').map((tool,i)=>({call:i+1,tool,label:tool,status:'success'}))
    const result=verifyTrialPath(rows,declared)
    expect(result.entries.map(entry=>entry.call)).toEqual([1,3,4,5,6]);expect([...result.renumbered]).toEqual([[2,3],[3,4],[4,5],[5,6]])
    expect(result.selected.has('c-1')).toBe(false);expect(result.warnings.join(' ')).toContain('按工具名对齐：#2→#3')
    const refs=trialProcedureRefs(rows,{steps:[{evidenceRefs:['c2']}],excluded:[{evidenceRefs:['c1']}]},result.selected,undefined,result.renumbered) as {steps:{evidenceRefs:string[]}[];excluded:{evidenceRefs:string[]}[]}
    expect(refs.steps[0]!.evidenceRefs).toEqual(['e5','e6']);expect(refs.excluded[0]!.evidenceRefs).toEqual(['e1','e2'])
    const onDiagnostic=vi.fn();expect(evidence(rows,declared,onDiagnostic).records.map(row=>row.toolName)).not.toContain('glob');expect(onDiagnostic).not.toHaveBeenCalled()
  })
  it('keeps an expected-failure check on the path, counting a normally answered probe as success (Desktop r34 A, r35 A)',()=>{
    const rows=events();Object.assign(rows[6]!,{isError:true,text:'Error: cannot read result.txt: not found'})
    const declared:TrialPath=[{...path[0]!,label:'写前读取确认文件不存在',status:'expected-failure'},path[1]!]
    const result=evidence(rows,declared)
    expect(result.records.map(row=>row.status)).toEqual(['failed','failed','reported-success','reported-success'])
    expect(result.warnings.join(' ')).toContain('预期失败的检查：写前读取确认文件不存在')
    const answered=verifyTrialPath(events(),declared)
    expect(answered.selected.size).toBe(2);expect(answered.warnings.join(' ')).toContain('检查按成功计入：写前读取确认文件不存在（调用 #3）')
  })
  it('compacts oversized declared paths without exceeding evidence caps',()=>{
    const rows=events(55)
    for(const row of rows)if(row.type==='tool/call'||row.type==='tool/result'){row.text='数据'.repeat(1800);if(row.type==='tool/result')row.isError=false}
    const declared=Array.from({length:55},(_,i)=>({call:i+1,tool:i===54?'write':'workflow_http_request',label:'读取',status:'success' as const}))
    const result=evidence(rows,declared)
    expect(result.records.length).toBeLessThanOrEqual(100);expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(24000)
    expect(result.warnings.join(' ')).toContain('超过');expect(result.records.some(row=>row.truncated)).toBe(true)
  })
  it('accepts the shared native output schema and retains legacy output compatibility',()=>{
    expect(()=>assertObjectJsonSchema(trialAgentOutputSchema)).not.toThrow()
    const base={outcome:'completed',summary:'完成',questions:[]}
    expect(validateJsonSchemaValue(trialAgentOutputSchema,base)).toEqual([])
    expect(validateJsonSchemaValue(trialAgentOutputSchema,{...base,path,procedure:procedure(evidence())})).toEqual([])
  })
})

async function integration(declaration:unknown=path,submitted:unknown=procedure(evidence()),trialEvents:()=>TrialPublicEvent[]=events){
  const directory=mkdtempSync(join(tmpdir(),'trial-path-')),admission=new ModelAdmission(2,2)
  const caller:PlanningCaller={parent:{id:'root'} as Agent,sessionId:'root',workspaceId:'workspace',signal:new AbortController().signal}
  const base=makeWorkflow('workspace'),requests:unknown[]=[],prompts:{purpose:string;value:any}[]=[],updates:PlanningTask[]=[]
  let trialService:WorkflowTrialService
  const options:ConstructorParameters<typeof WorkflowPlanningService>[0]={directory,admission,
    context:async(request,owner)=>({workflow:structuredClone(base),operation:'create',targetNodeIds:[],nodeIds:[],subagentIds:[],environmentIds:[],tools:[],model:{provider:'offline',model:'fixture'},effort:'high',...trialService.resolveEvidence((request.source as {trialId:string}).trialId,owner)}),
    authorize:()=>{},readiness:async flow=>({workflowId:flow.id,revision:flow.revision,canRun:true,issues:[]}),publish:async()=>{},receipt:()=>undefined,onUpdate:task=>updates.push(structuredClone(task)),
    driver:{generate:vi.fn(async input=>{
      const prompt=fixturePlanningPrompt(input);prompts.push({purpose:input.purpose,value:prompt});input.beforeStep?.(100,undefined)
      let output:unknown
      const fresh=input.purpose==='distill'?{procedure:procedure(prompt.conversation,['失败尝试仅作记录，未证明跑通'])}:undefined
      // A seeded trial method is repaired at the diagnosed paths only (Desktop r52).
      if(input.purpose==='distill'&&prompt.continuation?.hasDraft){
        const feedback=prompt.continuation.feedback,at=(path:string)=>path.split('/').slice(1).reduce((item:any,key)=>item?.[key],fresh)
        output={submission:{mode:'repair',draftRevision:feedback.draftRevision,patches:feedback.issues.map((issue:any)=>{const target=issue.code==='UNCOVERED_EVIDENCE'?'/procedure/steps':issue.path;return {op:'replace',path:target,value:at(target)}})}}
      }
      else if(input.purpose==='distill')output={outcome:'procedure',procedureJson:JSON.stringify(fresh!.procedure),summary:'回退提炼',questions:[]}
      else if(input.purpose==='optimize')output={outcome:'unchanged',graphJson:'',summary:'无需优化',replacements:[],regressionCases:[]}
      else output={outcome:'candidate',graphJson:JSON.stringify(prompt.graph),summary:'候选',assumptions:[],questions:[],requirementCoverage:['R1','S1'].map(requirementId=>({requirementId,nodeIds:[prompt.graph.nodes.at(-1).id],note:'离线覆盖'}))}
      return {output:(output as any)?.submission?fixtureSubmit(input,output):fixturePlanningEdits(input,output),steps:1,usage:{totalTokens:10}}
    })},
  }
  const planner=new WorkflowPlanningService(options)
  const trialOptions:ConstructorParameters<typeof WorkflowTrialService>[0]={directory,admission,resolve:()=>({workspaceRoot:directory,model:{provider:'offline',model:'fixture'},effort:'high',policyDigest:'a'.repeat(64)}),authorize:()=>{},
    driver:{close:async()=>{},run:async input=>{
      input.onPrepared?.({toolDigest:'b'.repeat(64),tools:input.tools});input.onStep?.()
      const rows=trialEvents();for(const row of rows)input.onEvent?.(row)
      writeFileSync(join(directory,'result.txt'),'ok')
      return {childId:input.childId,stopReason:'completed',outcome:'completed',summary:'绕路详情留在trial',questions:[],events:rows,steps:1,evidenceIncomplete:false,...(declaration==null?{}:{path:declaration}),...(submitted==null?{}:{procedure:submitted})}
    }},plan:async(request,owner)=>{requests.push(request);return planner.start({...request,preview:true},owner)},
  }
  trialService=new WorkflowTrialService(trialOptions)
  cleanups.push(async()=>{await trialService.close();await planner.close();rmSync(directory,{recursive:true,force:true})})
  const request:TrialRequest={requestId:'trial-path',instruction:'生成可复用报告',spec:{task:'生成报告',tools:['workflow_http_request','write'],inputs:[],artifacts:[{path:'result.txt',format:'text',checks:[{kind:'text-includes',value:'ok'}],requireChanged:true}],reviewItems:[]}}
  const trial=await trialService.start(request,caller)
  expect(trial.state,JSON.stringify(trial.diagnostics)).toBe('ready')
  const task=planner.get(trial.planningTaskId!,caller)
  expect(task.state,JSON.stringify(task.diagnostics)).toBe('ready')
  return {trial,task,trialService,options,trialOptions,caller,prompts,updates,requests}
}

describe('trial path to planning integration',()=>{
  it('uses the submitted procedure with no distill call, retains provenance and restores it',async()=>{
    const f=await integration()
    expect(f.prompts.map(row=>row.purpose)).not.toContain('distill')
    expect(f.task.distillationSource).toBe('submitted-by-trial');expect(f.task.distillationAttempts).toBe(0)
    expect(f.task.procedure).toEqual(procedure(evidence()));expect(f.task.sourceMap?.[0]?.evidenceRefs).toEqual(['e5','e6','e7','e8']);expect(f.task.provenanceDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(f.task.context?.conversation?.records).toHaveLength(4);expect(f.trial.events).toHaveLength(11)
    expect(f.prompts.find(row=>row.purpose==='author')?.value.trialEvidence.records).toHaveLength(4)
    const restoredTrial=new WorkflowTrialService(f.trialOptions),restoredPlan=new WorkflowPlanningService(f.options)
    cleanups.push(async()=>{await restoredTrial.close();await restoredPlan.close()})
    expect(restoredTrial.resolveEvidence(f.trial.id,f.caller).trialProcedure).toEqual(f.task.procedure)
    expect(restoredPlan.get(f.task.id,f.caller).provenanceDigest).toBe(f.task.provenanceDigest)
  })
  it.each([[{call:99,tool:'write',label:'bad',status:'success'}],[...path].reverse(),[{call:1,tool:'workflow_http_request',label:'error',status:'success'}],[{call:3,tool:'read',label:'miscounted',status:'success'},path[1]]])('falls back to distillation for invalid declaration %j',async declaration=>{
    const f=await integration(declaration)
    expect(f.trial.diagnostics).toContainEqual(expect.objectContaining({code:'TRIAL_PATH_INVALID'}))
    expect(f.prompts.filter(row=>row.purpose==='distill')).toHaveLength(1);expect(f.task.distillationSource).toBe('model');expect(f.task.distillationAttempts).toBe(1)
  })
  it('maps procedure call references cN to the call and result records',async()=>{
    const cited=procedure(evidence());cited.steps[0]!.evidenceRefs=['c3','c4']
    const f=await integration(path,cited)
    expect(f.prompts.map(row=>row.purpose)).not.toContain('distill');expect(f.task.distillationSource).toBe('submitted-by-trial')
    expect(f.task.procedure?.steps[0]?.evidenceRefs).toEqual(['e5','e6','e7','e8'])
  })
  it('drops excluded notes about off-path attempts and invented spec names instead of voiding the submitted procedure (Desktop r32 B, r34 A)',async()=>{
    const cited=procedure(evidence());cited.steps[0]!.evidenceRefs=['c3','c4']
    cited.excluded=[{evidenceRefs:['c1'],reason:'首次解析失败，已被修正调用取代'},{evidenceRefs:['c2','c4'],reason:'混合引用只保留路径调用'}]
    cited.steps[0]!.specRefs=['artifact:result.txt:text-includes:ok','trialTask.task']
    const f=await integration(path,cited)
    expect(f.prompts.map(row=>row.purpose)).not.toContain('distill');expect(f.task.distillationSource).toBe('submitted-by-trial')
    expect(f.task.procedure?.excluded).toEqual([{evidenceRefs:['e7','e8'],reason:'混合引用只保留路径调用'}])
    expect(f.task.procedure?.steps[0]?.specRefs).toEqual(['trialTask.task'])
  })
  it('files a look at the target before writing it under a stated Host exclusion instead of distilling again (Desktop r52 A)',async()=>{
    const call=(i:number,toolName:string,args:unknown,result:string,isError=false):TrialPublicEvent[]=>[
      {seq:2*i-1,type:'tool/call',turn:1,callId:`opaque-${i}`,toolName,text:JSON.stringify(args),truncated:false},{seq:2*i,type:'tool/result',turn:1,callId:`opaque-${i}`,text:result,truncated:false,isError}]
    const rows=()=>[{seq:0,type:'turn/start',turn:1},...call(1,'workflow_http_request',{attempt:1},'失败尝试',true),...call(2,'workflow_http_request',{attempt:2},'result-2'),
      ...call(3,'read',{file_path:'result.txt'},'旧内容'),...call(4,'write',{file_path:'result.txt',content:'ok'},'written'),...call(5,'read',{file_path:'result.txt'},'ok'),
      {seq:11,type:'turn/end',turn:1,completed:true}] as TrialPublicEvent[]
    const declared:TrialPath=[{call:2,tool:'workflow_http_request',label:'取得输入',status:'success'},{call:3,tool:'read',label:'写前查看目标',status:'success'},
      {call:4,tool:'write',label:'写入结果',status:'success'},{call:5,tool:'read',label:'回读',status:'success'}]
    const submitted=procedure({records:[]});submitted.steps[0]!.evidenceRefs=['c2','c4','c5']
    const f=await integration(declared,submitted,rows)
    expect(f.prompts.map(row=>row.purpose)).not.toContain('distill')
    expect(f.task.distillationSource).toBe('submitted-by-trial');expect(f.task.distillationAttempts).toBe(0)
    const probe=f.task.context!.conversation!.records.filter(row=>row.callId==='opaque-3').map(row=>row.id)
    expect(probe).toHaveLength(2)
    expect(f.task.procedure?.excluded).toEqual([{evidenceRefs:probe,reason:'Host 归入排除：写入前查看目标文件，写入模块已含写前探测，不另建步骤。'}])
    expect(f.updates.flatMap(task=>task.events.map(event=>event.message))).toContainEqual(expect.stringContaining(`试做提交的方法漏归 ${probe.join('、')}`))
  })
  it('leaves a missed read-back to the model: only a look before the first write is Host-excludable',async()=>{
    const call=(i:number,toolName:string,args:unknown,result:string):TrialPublicEvent[]=>[
      {seq:2*i-1,type:'tool/call',turn:1,callId:`opaque-${i}`,toolName,text:JSON.stringify(args),truncated:false},{seq:2*i,type:'tool/result',turn:1,callId:`opaque-${i}`,text:result,truncated:false,isError:false}]
    const rows=()=>[{seq:0,type:'turn/start',turn:1},...call(1,'workflow_http_request',{attempt:1},'result-1'),...call(2,'write',{file_path:'result.txt',content:'ok'},'written'),
      ...call(3,'read',{file_path:'result.txt'},'ok'),{seq:7,type:'turn/end',turn:1,completed:true}] as TrialPublicEvent[]
    const declared:TrialPath=[{call:1,tool:'workflow_http_request',label:'取得输入',status:'success'},{call:2,tool:'write',label:'写入结果',status:'success'},{call:3,tool:'read',label:'回读',status:'success'}]
    const submitted=procedure({records:[]});submitted.steps[0]!.evidenceRefs=['c1','c2']
    const f=await integration(declared,submitted,rows)
    const distill=f.prompts.find(row=>row.purpose==='distill')!
    expect(distill.value.continuation.feedback.issues).toEqual([expect.objectContaining({code:'UNCOVERED_EVIDENCE',path:'/procedure/excluded'})])
    expect(distill.value.continuation.feedback.issues[0].message).toContain('read：{"file_path":"result.txt"}')
  })
  it('repairs an invalid submitted procedure at the diagnosed path, with only path evidence in view (Desktop r52)',async()=>{
    const invalid=procedure(evidence());invalid.steps[0]!.evidenceRefs=['e1']
    const f=await integration(path,invalid)
    const distill=f.prompts.find(row=>row.purpose==='distill')!
    expect(distill.value.conversation.records.map((row:any)=>row.id)).toEqual(['e5','e6','e7','e8'])
    expect(distill.value.diagnostics).toContainEqual(expect.objectContaining({code:'TRIAL_PROCEDURE_INVALID'}))
    expect(distill.value.instruction).toContain('只按 continuation 的局部诊断提交 repair')
    expect(distill.value.continuation.feedback.issues).toEqual([expect.objectContaining({code:'INVALID_EVIDENCE_REFS',path:'/procedure/steps/0/evidenceRefs'})])
    // The seed is not one of the model's attempts; the repair is.
    expect(f.task.distillationSource).toBe('model');expect(f.task.distillationAttempts).toBe(1)
    expect(f.task.procedure?.steps[0]?.evidenceRefs).toEqual(['e5','e6','e7','e8'])
  })
  it('restores legacy trials without a path and still distills',async()=>{
    // Explicit null disables the default helper values; absence is the legacy wire shape.
    const f=await integration(null,null)
    expect(f.task.distillationSource).toBe('model')
    const restored=new WorkflowTrialService(f.trialOptions);cleanups.push(()=>restored.close())
    expect(restored.resolveEvidence(f.trial.id,f.caller).conversation.digest).toBe(f.task.context?.conversation?.digest)
  })
})
