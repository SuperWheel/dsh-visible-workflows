import { WORKFLOW_SESSION_TOOL_GUIDANCE } from '../../shared/workflow-session-tools.ts'
import { taskSpecificationRefs } from '../../shared/retrospective.ts'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { PlanningContext, PlanningRequest } from '../../shared/planning-types.ts'
import { planningModuleCheckSchema } from '../../shared/planning-schema.ts'
import { optimizationTargetSchema } from '../../shared/planning-optimization.ts'
import { TRIAL_LIMITS, trialSubmissionSchema, planningTrialSpecSchema, trialFileSnapshotSchema, trialPublicEventSchema, trialVerificationReportSchema, verifiedTrialEvidenceSchema, type TrialPublicEvent } from '../../shared/planning-trial.ts'
import { captureTrialFiles, verifyTrialArtifacts, planningTrialSpecDigest, validateTrialVerificationReport } from './trial-verification.ts'
import { buildTrialEvidence, trialCallIndex, trialProcedureRefs, verifyTrialPath, validateVerifiedTrialEvidence } from './trial-evidence.ts'
import { type createTrialAgent } from './trial-agent.ts'
import { planningDigest, type PlanningCaller, type PlanningTask } from './service.ts'
import { PlanningStore, type PlanningStoreLimits } from './store.ts'
import type { ModelAdmission } from '../run-usage.ts'
import { registerPlanningBackground, type PlanningActiveOperation, type PlanningBackgroundRuntime } from './background.ts'

const identity=z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/),digest=z.string().regex(/^[a-f0-9]{64}$/)
export const trialRequestSchema=z.object({
  requestId:identity,title:z.string().trim().min(1).max(160).optional(),instruction:z.string().trim().min(1).max(100_000),spec:planningTrialSpecSchema,
  moduleCheck:planningModuleCheckSchema.optional(),
  targetWorkflowId:identity.optional(),optimizationTarget:optimizationTargetSchema.optional(),
}).strict().refine(value=>value.instruction.length+JSON.stringify(value.spec).length+200<100_000,'任务与冻结验收资料合计超过规划输入范围，请在执行前缩小范围')
export type TrialRequest=z.infer<typeof trialRequestSchema>
const phase=z.enum(['preparing','executing','verifying','needs_input','needs_review','verified','planning','ready','failed','cancelled','interrupted'])
const humanReviewSchema=z.object({accepted:z.literal(true),questionId:identity,answeredAt:z.string().datetime()}).strict()
// T30.1: the fresh child that carried on after the first one stopped; its records start at fromSeq.
const continuationSchema=z.object({
  childId:identity,fromSeq:z.number().int().nonnegative().safe(),fromCall:z.number().int().positive().max(TRIAL_LIMITS.events+1),
  failure:z.object({code:z.string().max(160),message:z.string().max(4000)}).strict(),at:z.string().datetime(),
}).strict()
const trialRecordSchema=z.object({
  version:z.literal(1),receiptVersion:z.literal(2).optional(),id:identity,preview:z.literal(false),request:trialRequestSchema,requestDigest:digest,
  rootSessionId:identity,workspaceId:z.string().min(1).max(4000),workspaceRoot:z.string().min(1).max(4000),
  model:z.object({provider:z.string().min(1),model:z.string().min(1)}).strict(),effort:z.string().optional(),policyDigest:digest,
  childId:identity,state:phase,revision:z.number().int().positive(),createdAt:z.string().datetime(),updatedAt:z.string().datetime(),
  toolDigest:digest.optional(),steps:z.number().int().nonnegative().max(80),spentTokens:z.number().int().nonnegative().safe().optional(),
  unknownUsageCalls:z.number().int().nonnegative().safe().optional(),
  events:z.array(trialPublicEventSchema).max(200),evidenceIncomplete:z.boolean(),
  before:trialFileSnapshotSchema.optional(),verification:trialVerificationReportSchema.optional(),
  // Field order matches the stored construction: the receipt digest hashes this object as serialized.
  execution:z.object({
    outcome:z.enum(['completed','needs-input','failed']),stopReason:z.string().max(400),summary:z.string().max(10_000),questions:z.array(z.string().max(4000)).max(3),
    path:trialSubmissionSchema.optional(),procedure:trialSubmissionSchema.optional(),
  }).strict().optional(),
  humanReview:humanReviewSchema.optional(),verified:verifiedTrialEvidenceSchema.optional(),receiptDigest:digest.optional(),
  planningTaskId:identity.optional(),diagnostics:z.array(z.object({code:z.string().max(160),message:z.string().max(4000)}).strict()).max(100),
  delivery:z.object({protocolVersion:z.literal(1),mode:z.literal('background'),acceptedAt:z.string().datetime(),recovered:z.boolean().optional()}).strict().optional(),
  continuations:z.array(continuationSchema).max(1).optional(),
}).strict()
export type PlanningTrial=z.infer<typeof trialRecordSchema>
type Continuation=z.infer<typeof continuationSchema>
export interface TrialEnvironment {workspaceRoot:string;model:{provider:string;model:string};effort?:string;policyDigest:string}
interface Options {
  directory:string
  retentionLimits?:PlanningStoreLimits
  admission:ModelAdmission
  driver:ReturnType<typeof createTrialAgent>
  resolve(caller:PlanningCaller):TrialEnvironment|Promise<TrialEnvironment>
  authorize(trial:PlanningTrial,caller:PlanningCaller,execute:boolean):void
  plan(request:PlanningRequest,caller:PlanningCaller):Promise<PlanningTask>
  backgroundRuntime?:PlanningBackgroundRuntime
  onUpdate?(trial:PlanningTrial):void
}
type DriverInput=Parameters<Options['driver']['run']>[0]
const errorMessage=(error:unknown)=>error instanceof Error?error.message:String(error)
const errorCode=(error:unknown)=>error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:'TRIAL_FAILED'
// Stops a fresh child can carry on from; cancellation, deadlines, quota, permission and identity failures end the trial.
const CONTINUABLE=new Set(['TRIAL_STEP_LIMIT','TRIAL_IDLE_TIMEOUT','TRIAL_OUTPUT_INVALID','TRIAL_PROVIDER_ERROR'])
const terminal=new Set<PlanningTrial['state']>(['needs_input','needs_review','ready','failed','cancelled','interrupted'])
// T30.2 (Desktop r51: A waited out B's generation): only these states and a first run hold the workspace.
const business=new Set<PlanningTrial['state']>(['preparing','executing','verifying'])
const planningPending=['collecting','queued','distilling','authoring','validating','repairing','optimizing','regressing','publishing','cancelling']
const TRIAL_INSTRUCTION='这是你自己的流程演练：在授权工具和当前工作区内尝试跑通每个业务步骤，为后续拆解工作流积累记录；输入文件只读。不生成工作流、不委派子Agent。'+
  '按冻结检查条件尝试产物，不改标准、不编造成功。缺少用户信息或授权时用needs-input提问；取消、超时或清理失败必须停止。'+
  '某一步工具失败或结果不完整时，在安全且有输入的情况下继续其余步骤；演练结束用completed报告，不把completed当成业务成功。'+
  'summary逐步说明跑通和未跑通之处、实际工具、地址及原因，不能把缺口说成已完成。'+
  WORKFLOW_SESSION_TOOL_GUIDANCE+
  '先用指定地址，内容不完整时最多再换两个公开镜像或替代地址；这只是演练时的应急做法，没换过地址就不要把它写进procedure的rules或步骤。不要保证工作流HTTP一定能取得完整内容。reviewItems只是最终报告备注，不要求中途人工复核。'+
  // Desktop r57 C: the trial spent 203 s comparing its own table character by character.
  '写入后回读一次，确认写成功、行数或条数对得上即可；产物与数据是否逐字一致由Host核验和工作流的写入模块、核对节点负责，不要在思考里逐行逐字手工比对。'+
  '公开记录有100条、24 KB上限，避免不必要试探。结束后用structured_output同时返回path和procedure。'+
  'path的call是你本次试做发起的第N次工具调用（从1起按发起顺序，不含structured_output），并写明tool；按执行顺序只保留最终采用的调用；'+
  '只保留到卡住步骤，并以该步骤最后失败调用结束。手工拼装网页、复制输入或旧产物替代必须标记workaround及reason，算未跑通；不得以复制旧产物代替失败步骤。'+
  'procedure的evidenceRefs用c加调用编号（如c3）引用path中的调用，Host映射到调用和结果，并覆盖path全部调用；仅从实际路径提炼，参数化可变输入，不硬编码本次答案。'+
  '逐字保留冻结reviewItems，并补充失败和绕行缺口；requiresReview仅用于用户明确要求未来运行人工审核的步骤。整个提交保持20 KB内。'
const sameRequest=(row:PlanningTrial,caller:PlanningCaller,requestId:string)=>row.rootSessionId===caller.sessionId&&row.workspaceId===caller.workspaceId&&row.request.requestId===requestId
const markInterrupted=(record:PlanningTrial)=>{record.state='interrupted';record.revision++;record.updatedAt=new Date().toISOString()}
const REQUEST_SCOPE='request是用户对工作流的需求原文，只用来确定演练的处理范围和步骤，不要创建或保存工作流；task写的是本次具体做法。'+
  'request要处理目录下全部或每个文件而task只列了当前文件名时，按request的范围演练（先列出目录再逐个处理）。'
const CONTINUE_INSTRUCTION='这是同一次试做的续做：上一段因 stopped 写的原因中途停止，它发起的工具调用及结果列在 previousCalls（call 即调用编号）。'+
  '不要重做其中报告成功的写入或其他有副作用的调用；结果未知的调用可先只读核对再决定。从还没完成的步骤接着做，结束后照常用structured_output同时返回path和procedure。'+
  '本段第一次工具调用编号是 nextCall，之后依次加一；path 和 procedure 的 evidenceRefs 可以引用上一段的编号（如 c1）和本段的编号，path 仍按执行顺序只保留最终采用的调用。'
function trialPrompt(request:TrialRequest,continuation?:unknown):string{
  const spec=request.spec
  return JSON.stringify({request:request.instruction,task:spec.task,inputs:spec.inputs,artifacts:spec.artifacts,reviewItems:spec.reviewItems,instruction:REQUEST_SCOPE+TRIAL_INSTRUCTION,
    ...(continuation?{continuation}:{})})
}
function continuationPrompt(trial:PlanningTrial,segment:Continuation){
  const calls=trialCallIndex(trial.events.filter(event=>event.seq<segment.fromSeq))
  return {stopped:`${segment.failure.code}：${segment.failure.message}`.slice(0,1000),nextCall:segment.fromCall,instruction:CONTINUE_INSTRUCTION,
    previousCalls:calls.map(row=>({call:row.number,tool:row.call.toolName,arguments:row.call.text.slice(0,1000),
      ...(row.result?{status:row.result.isError?'failed':'reported-success',result:row.result.text.slice(0,1000)}:{status:'unknown'}),
      ...(row.call.truncated||row.result?.truncated?{truncated:true}:{})}))}
}
/** Continuation records join the trial's stream: seq, turn and call identity carry on after the stopped segment. */
function rebased(event:TrialPublicEvent,fromSeq:number,turns:number):TrialPublicEvent{
  const next={...event,seq:fromSeq+event.seq}
  if('turn' in next)next.turn+=turns
  if('callId' in next)next.callId=`r1-${next.callId}`
  return next
}
function assertTrialStartable(trial:PlanningTrial):void{
  if(trial.request.spec.inputs.some(path=>trial.before!.files[path]?.status!=='present'))throw Object.assign(new Error('试做输入不存在或无法安全读取；没有启动业务动作'),{code:'TRIAL_INPUT_UNAVAILABLE'})
  if(trial.request.spec.artifacts.some(item=>trial.before!.files[item.path]?.status==='unverified'))throw Object.assign(new Error('试做产物目标在启动前无法安全验证；没有启动业务动作'),{code:'TRIAL_ARTIFACT_UNSAFE'})
}
function trialPathSummary(path:ReturnType<typeof verifyTrialPath>):string{
  return path.entries.map(entry=>`${entry.label}：${entry.status==='failed'||entry.workaround?'未跑通':entry.status==='expected-failure'?'预期失败的检查':'调用报告成功'}`).join('；')
}
function trialPlanRequest(trial:PlanningTrial):PlanningRequest{
  const request=trial.request
  return {
    requestId:`trial-plan-${trial.id.slice(6)}`,operation:'create',instruction:request.instruction,
    ...(request.moduleCheck?{moduleCheck:request.moduleCheck}:{}),...(request.title?{title:request.title}:{}),
    preview:false,source:{kind:'verified-trial',trialId:trial.id},
    ...(request.targetWorkflowId?{targetWorkflowId:request.targetWorkflowId}:{}),...(request.optimizationTarget?{optimizationTarget:request.optimizationTarget}:{}),
  }
}

/** Executes one explicitly scoped task, verifies it, then delegates graph design.
 * Journaling precedes native activation. A duplicate/restart never repeats effects. */
export class WorkflowTrialService {
  private readonly records=new Map<string,PlanningTrial>()
  private readonly active=new Map<string,PlanningActiveOperation<PlanningTrial>>()
  private readonly store:PlanningStore<PlanningTrial>
  private readonly lifetime=new AbortController()
  private readonly firstRuns=new Map<string,{rootSessionId:string;startedAt:string}>()
  private waiters:(()=>void)[]=[]
  constructor(private readonly options:Options){
    this.store=new PlanningStore(join(options.directory,'trials'),()=>true,'tasks.json',{
      ...options.retentionLimits,createdAt:trial=>trial.createdAt,
      canEvict:trial=>terminal.has(trial.state)&&!['needs_input','needs_review'].includes(trial.state)&&!this.active.has(trial.id),
      onEvict:ids=>{for(const id of ids)this.records.delete(id)},
    })
    const restored=this.store.read(raw=>this.validateStored(raw))
    const keys=restored.map(row=>JSON.stringify([row.workspaceId,row.rootSessionId,row.request.requestId]))
    const children=restored.flatMap(row=>[row.childId,...(row.continuations??[]).map(item=>item.childId)])
    if(new Set(keys).size!==keys.length||new Set(children).size!==children.length)throw new Error('试做请求或子任务身份重复')
    for(const record of restored){
      this.records.set(record.id,record)
      this.recover(record)
    }
    if(restored.length)this.persist()
    for(const record of restored)this.options.onUpdate?.(structuredClone(record))
  }
  private recover(record:PlanningTrial):void{
    if(record.state==='needs_review'){
      markInterrupted(record)
      record.diagnostics=[...record.diagnostics.slice(-99),{code:'TRIAL_LEGACY_REVIEW_ENDED',message:'旧版试做复核已结束；保留历史记录，不自动执行或生成。可根据已有记录另行请求设计。'}]
    }else if(!terminal.has(record.state)){
      markInterrupted(record)
      record.diagnostics.push({code:'TRIAL_INTERRUPTED',message:'Host 重启；已保留执行回执与候选，禁止自动重做原任务。'})
      if(record.delivery)record.delivery.recovered=true
    }
  }
  private receipt(trial:PlanningTrial):string{return planningDigest({
    requestDigest:trial.requestDigest,rootSessionId:trial.rootSessionId,workspaceId:trial.workspaceId,childId:trial.childId,
    ...(trial.receiptVersion===2?{execution:trial.execution}:{}),...(trial.continuations?{continuations:trial.continuations}:{}),toolDigest:trial.toolDigest,
    verification:trial.verification?.digest,evidence:trial.verified?.evidence.digest,humanReview:trial.humanReview??null,
  })}
  private validateStored(raw:unknown):PlanningTrial{
    const trial=trialRecordSchema.parse(raw)
    if(!trial.id.startsWith('trial-')||trial.requestDigest!==planningDigest(trial.request))throw new Error('试做请求摘要无效')
    if(trial.before&&trial.before.specDigest!==planningTrialSpecDigest(trial.request.spec))throw new Error('试做执行前快照不匹配')
    if(trial.verification){validateTrialVerificationReport(trial.verification);if(trial.verification.specDigest!==planningTrialSpecDigest(trial.request.spec))throw new Error('试做验收规范已改变')}
    if(trial.verified){
      validateVerifiedTrialEvidence(trial.verified)
      const bound=trial.verified.binding
      if(!trial.verification||trial.execution?.outcome!=='completed'||
        bound.trialId!==trial.id||bound.childSessionId!==trial.childId||bound.rootSessionId!==trial.rootSessionId||bound.workspaceId!==trial.workspaceId||
        bound.specDigest!==planningTrialSpecDigest(trial.request.spec)||bound.verificationDigest!==trial.verification.digest||
        planningDigest(bound.humanReview??null)!==planningDigest(trial.humanReview??null)||trial.receiptDigest!==this.receipt(trial))throw new Error('试做证据归属或回执摘要无效')
    }else if(trial.receiptDigest||trial.planningTaskId)throw new Error('试做记录缺少可信证据')
    return trial
  }
  private persist(trial?:PlanningTrial):void{
    if(!trial||terminal.has(trial.state))this.store.write([...this.records.values()],trial?.id)
    else this.store.append(trial,()=>[...this.records.values()])
    if(trial)this.options.onUpdate?.(structuredClone(trial))
  }
  private touch(trial:PlanningTrial,state:PlanningTrial['state']):void{
    trial.state=state;trial.revision++;trial.updatedAt=new Date().toISOString();this.persist(trial)
    if(!business.has(state))this.wake()
  }
  private wake():void{const waiting=this.waiters;this.waiters=[];for(const resolve of waiting)resolve()}
  /** Names only the holder's stage and start time; another conversation's task content stays private. */
  private workspaceBusy(workspaceId:string,sessionId:string):string|undefined{
    const trial=[...this.active.keys()].map(id=>this.records.get(id)).find(row=>row?.workspaceId===workspaceId&&business.has(row.state))
    const run=this.firstRuns.get(workspaceId),holder=trial??run
    if(!holder)return undefined
    const stage=trial?`的试做正在试做业务步骤（${trial.createdAt.slice(11,16)}`:`正在首跑新生成的工作流（${run!.startedAt.slice(11,16)}`
    return `WORKSPACE_TRIAL_BUSY：${holder.rootSessionId===sessionId?'本对话':'另一个对话'}在同一工作区${stage} UTC 开始），完成后自动释放；这不是遗留任务。请等它结束后用同一请求重试，不要取消它，也不必询问用户。`
  }
  /** A first run waits for trial steps already running in its workspace, then holds the workspace until released. */
  async holdFirstRun(workspaceId:string,rootSessionId:string,signal:AbortSignal):Promise<()=>void>{
    const stop=AbortSignal.any([signal,this.lifetime.signal])
    while(this.workspaceBusy(workspaceId,rootSessionId)){
      stop.throwIfAborted()
      await new Promise<void>((resolve,reject)=>{
        const abort=()=>reject(stop.reason)
        stop.addEventListener('abort',abort,{once:true})
        this.waiters.push(()=>{stop.removeEventListener('abort',abort);resolve()})
      })
    }
    stop.throwIfAborted()
    const holder={rootSessionId,startedAt:new Date().toISOString()}
    this.firstRuns.set(workspaceId,holder)
    return ()=>{if(this.firstRuns.get(workspaceId)===holder){this.firstRuns.delete(workspaceId);this.wake()}}
  }
  isKnownChild(childId:string):boolean{return [...this.records.values()].some(row=>row.childId===childId||!!row.continuations?.some(item=>item.childId===childId))}
  private owned(id:string,caller:PlanningCaller):PlanningTrial{
    const trial=this.records.get(id)
    if(!trial||trial.rootSessionId!==caller.sessionId||trial.workspaceId!==caller.workspaceId)throw new Error('试做任务不存在、已清理或不属于当前主对话')
    this.options.authorize(trial,caller,false);return trial
  }
  get(id:string,caller:PlanningCaller):PlanningTrial{return structuredClone(this.owned(id,caller))}
  resolveEvidence(id:string,caller:PlanningCaller):{
    conversation:NonNullable<PlanningContext['conversation']>;trial:NonNullable<PlanningContext['trial']>
    trialTask:NonNullable<PlanningContext['trialTask']>;trialReport:NonNullable<PlanningContext['trialReport']>;trialProcedure?:unknown
  }{
    const trial=this.owned(id,caller)
    this.validateStored(trial)
    if(!trial.verified||!trial.receiptDigest)throw new Error('TRIAL_NOT_VERIFIED：试做没有可用的完整记录，不能反推工作流')
    const bound=trial.verified.binding
    const binding={trialId:bound.trialId,rootSessionId:bound.rootSessionId,childSessionId:bound.childSessionId,workspaceId:bound.workspaceId,specDigest:bound.specDigest,verificationDigest:bound.verificationDigest,evidenceDigest:bound.evidenceDigest}
    const {task,inputs,artifacts,reviewItems}=trial.request.spec
    let path:ReturnType<typeof verifyTrialPath>|undefined
    if(trial.execution?.path!==undefined)try{path=verifyTrialPath(trial.events,trial.execution.path,trial.evidenceIncomplete,trial.continuations?.[0]?.fromSeq)}catch{}
    const summary=path?trialPathSummary(path):trial.execution!.summary
    const procedure=path&&trial.execution?.procedure!==undefined?{trialProcedure:trialProcedureRefs(trial.events,trial.execution.procedure,path.selected,taskSpecificationRefs(trial.request.spec),path.renumbered)}:{}
    return {
      ...procedure,conversation:structuredClone(trial.verified.evidence),trial:{...binding,receiptDigest:trial.receiptDigest},
      trialTask:structuredClone({task,inputs,artifacts,reviewItems}),trialReport:{verification:structuredClone(trial.verification!),summary,summarySource:'agent-claim'},
    }
  }
  async start(value:unknown,caller:PlanningCaller,delivery?:{background:true}):Promise<PlanningTrial>{
    this.lifetime.signal.throwIfAborted();caller.signal.throwIfAborted()
    const request=trialRequestSchema.parse(value),requestDigest=planningDigest(request)
    // Desktop r52: a match pattern passed the path schema and failed only as a missing file once queued.
    const patterns=[...request.spec.inputs,...request.spec.artifacts.map(item=>item.path)].filter(path=>/[*?[]/.test(path))
    if(patterns.length)throw Object.assign(new Error(`TRIAL_INPUT_PATTERN：试做 inputs 和 artifacts 只写具体文件路径，${patterns.join('、')} 是匹配模式。目录和匹配模式写进 task，tools 加 glob；inputs 列当前要处理的具体文件或留空。`),{code:'TRIAL_INPUT_PATTERN'})
    const prior=[...this.records.values()].find(row=>sameRequest(row,caller,request.requestId))
    if(prior){
      this.owned(prior.id,caller)
      if(prior.requestDigest!==requestDigest)throw new Error('REQUEST_ID_CONFLICT：同一试做请求身份的内容已改变')
      return structuredClone(delivery?.background||prior.delivery?prior:await(this.active.get(prior.id)?.done??prior))
    }
    if(delivery?.background&&!this.options.backgroundRuntime)throw new Error('Host 未提供受管理的后台试做生命周期')
    const busy=this.workspaceBusy(caller.workspaceId,caller.sessionId);if(busy)throw Object.assign(new Error(busy),{code:'WORKSPACE_TRIAL_BUSY'})
    const environment=await this.options.resolve(caller),at=new Date().toISOString()
    this.lifetime.signal.throwIfAborted();caller.signal.throwIfAborted()
    // Recheck after the asynchronous model/workspace lookup, before journaling.
    if([...this.records.values()].some(row=>sameRequest(row,caller,request.requestId)))return this.start(request,caller,delivery)
    const nowBusy=this.workspaceBusy(caller.workspaceId,caller.sessionId);if(nowBusy)throw Object.assign(new Error(nowBusy),{code:'WORKSPACE_TRIAL_BUSY'})
    const trial:PlanningTrial={
      version:1,receiptVersion:2,id:`trial-${randomUUID()}`,preview:false,request,requestDigest,rootSessionId:caller.sessionId,workspaceId:caller.workspaceId,...environment,
      childId:randomUUID(),state:'preparing',revision:1,createdAt:at,updatedAt:at,steps:0,events:[],evidenceIncomplete:false,diagnostics:[],
      ...(delivery?.background?{delivery:{protocolVersion:1,mode:'background',acceptedAt:at}}:{}),
    }
    this.options.authorize(trial,caller,true)
    this.records.set(trial.id,trial)
    try{this.persist(trial)}catch(error){return this.acceptanceFailed(trial,error)}
    if(delivery?.background){
      try{registerPlanningBackground({
        active:this.active,taskId:trial.id,owner:caller,callSignal:caller.signal,hostSignal:this.lifetime.signal,runtime:this.options.backgroundRuntime!,deadlineMs:1_200_000,
        run:(signal,externalSignal)=>this.execute(trial,{...caller,signal},externalSignal),
        onFailure:(error,signal,externalSignal)=>this.fail(trial,error,externalSignal.aborted?externalSignal:signal),
      })}catch(error){return structuredClone(this.fail(trial,error,caller.signal))}
      return structuredClone(trial)
    }
    const controller=new AbortController(),deadline=new AbortController(),signal=AbortSignal.any([caller.signal,controller.signal,deadline.signal,this.lifetime.signal])
    const timer=setTimeout(()=>deadline.abort(Object.assign(new Error('试做达到20分钟时长保护；保留回执，不自动重试'),{code:'TRIAL_DEADLINE'})),1_200_000)
    timer.unref?.()
    const done=Promise.resolve().then(()=>this.execute(trial,{...caller,signal},AbortSignal.any([caller.signal,controller.signal,this.lifetime.signal]))).finally(()=>{clearTimeout(timer);this.active.delete(trial.id)})
    this.active.set(trial.id,{controller,done});return structuredClone(await done)
  }
  private acceptanceFailed(trial:PlanningTrial,error:unknown):PlanningTrial{
    let durable=true
    try{durable=this.store.read(raw=>this.validateStored(raw)).some(row=>row.id===trial.id&&row.requestDigest===trial.requestDigest)}catch{/* Unreadable storage cannot prove that retrying admission is safe. */}
    if(!durable){this.records.delete(trial.id);throw error}
    trial.diagnostics.push({code:'TRIAL_ACCEPTANCE_FAILED',message:'受理日志写入失败，未启动业务动作；保留身份且不自动重跑：'+errorMessage(error).slice(0,3000)})
    try{this.touch(trial,'interrupted')}catch{try{this.options.onUpdate?.(structuredClone(trial))}catch{}}
    return structuredClone(trial)
  }
  /**
   * The 20-minute trial deadline covers execution and verification only. `untimed`
   * keeps cancellation, parent disposal and Host shutdown but drops that deadline:
   * planning keeps its own 20-minute guard.
   */
  private async execute(trial:PlanningTrial,timed:PlanningCaller,untimed:AbortSignal):Promise<PlanningTrial>{
    let caller=timed
    const authorize=()=>{caller.signal.throwIfAborted();this.options.authorize(trial,caller,true)}
    try{
      authorize()
      trial.before=await captureTrialFiles({workspaceRoot:trial.workspaceRoot,spec:trial.request.spec,signal:caller.signal,authorize})
      assertTrialStartable(trial)
      this.touch(trial,'executing')
      const release=await this.options.admission.acquire(trial.id,1,caller.signal,caller.workspaceId)
      const usageReceipts=new Set<number>()
      let result:Awaited<ReturnType<Options['driver']['run']>>
      try{result=await this.runSegments(trial,caller,authorize,usageReceipts)}finally{release()}
      authorize()
      trial.execution={outcome:result.outcome,stopReason:result.stopReason,summary:result.summary,questions:result.questions,...(result.path!==undefined?{path:result.path}:{}),...(result.procedure!==undefined?{procedure:result.procedure}:{})}
      trial.evidenceIncomplete ||= result.evidenceIncomplete
      if(!usageReceipts.size&&result.usage)trial.spentTokens=(trial.spentTokens??0)+result.usage.totalTokens
      if(result.outcome!=='completed'){
        trial.diagnostics.push({code:result.outcome==='needs-input'?'TRIAL_NEEDS_INPUT':'TRIAL_EXECUTION_FAILED',message:'试做未确认完成；已保留实际回执，不进入验证后的反推，也不会自动重做。'})
        this.touch(trial,result.outcome==='needs-input'?'needs_input':'failed');return trial
      }
      this.touch(trial,'verifying')
      const after=await captureTrialFiles({workspaceRoot:trial.workspaceRoot,spec:trial.request.spec,signal:caller.signal,authorize})
      trial.verification=verifyTrialArtifacts({spec:trial.request.spec,before:trial.before,after})
      this.persist(trial)
      caller={...timed,signal:untimed}
      return await this.finishVerified(trial,caller,authorize)
    }catch(error){return this.fail(trial,error,caller.signal)}
  }
  /** T30.1: a child that stopped mid-way is carried on once by a fresh child seeded with its calls; succeeded calls are not redone. */
  private async runSegments(trial:PlanningTrial,caller:PlanningCaller,authorize:()=>void,usageReceipts:Set<number>):Promise<Awaited<ReturnType<Options['driver']['run']>>>{
    let stopped:Continuation['failure']
    try{
      const result=await this.options.driver.run(this.driverInput(trial,caller,authorize,usageReceipts))
      if(result.submitted!==false||!this.continuable(trial,caller,result.evidenceIncomplete))return result
      if(!usageReceipts.size&&result.usage)trial.spentTokens=(trial.spentTokens??0)+result.usage.totalTokens
      stopped={code:'TRIAL_NOT_SUBMITTED',message:`试做子会话没有提交结构化结果就停止了（${result.stopReason}）`}
    }catch(error){
      if(!CONTINUABLE.has(errorCode(error))||!this.continuable(trial,caller,!!(error as {evidenceIncomplete?:unknown}).evidenceIncomplete))throw error
      stopped={code:errorCode(error),message:errorMessage(error).slice(0,3000)}
    }
    authorize()
    const calls=trialCallIndex(trial.events).length
    trial.continuations=[{childId:randomUUID(),fromSeq:(trial.events.at(-1)?.seq??-1)+1,fromCall:calls+1,failure:stopped,at:new Date().toISOString()}]
    trial.diagnostics=[...trial.diagnostics.slice(-99),{code:'TRIAL_CONTINUED',message:`试做在第 ${calls} 次工具调用后停止（${stopped.code}）；保留前面的记录，新开子会话从未完成的步骤接着做一次，不重做已成功的写入。`}]
    this.persist(trial)
    return this.options.driver.run(this.driverInput(trial,caller,authorize,usageReceipts))
  }
  private continuable(trial:PlanningTrial,caller:PlanningCaller,evidenceIncomplete:boolean):boolean{
    return !trial.continuations&&!evidenceIncomplete&&!trial.evidenceIncomplete&&!caller.signal.aborted&&!this.lifetime.signal.aborted&&trial.events.length<=TRIAL_LIMITS.events-20
  }
  private driverInput(trial:PlanningTrial,caller:PlanningCaller,authorize:()=>void,usageReceipts:Set<number>):DriverInput{
    const segment=trial.continuations?.at(-1),turns=segment?Math.max(0,...trial.events.map(event=>'turn' in event?event.turn:0)):0
    return {
      trialId:trial.id,childId:segment?.childId??trial.childId,parent:caller.parent,model:trial.model,effort:trial.effort,prompt:trialPrompt(trial.request,segment&&continuationPrompt(trial,segment)),
      signal:caller.signal,tools:trial.request.spec.tools,maxSteps:32,authorize,
      onPrepared:manifest=>{
        if(segment&&manifest.toolDigest!==trial.toolDigest)throw Object.assign(new Error('续做前执行工具定义已变化，不再续做'),{code:'TRIAL_TOOL_CHANGED'})
        trial.toolDigest=manifest.toolDigest;this.persist(trial)
      },
      onStep:()=>{trial.steps++;this.persist(trial)},
      onUsage:({seq,totalTokens})=>{
        const key=(segment?.fromSeq??0)+seq
        if(usageReceipts.has(key))return
        usageReceipts.add(key)
        if(totalTokens===undefined)trial.unknownUsageCalls=(trial.unknownUsageCalls??0)+1
        else trial.spentTokens=(trial.spentTokens??0)+totalTokens
        this.persist(trial)
      },
      onEvent:(event:TrialPublicEvent)=>{if(segment)event=rebased(event,segment.fromSeq,turns);if(trial.events.length>=200){trial.evidenceIncomplete=true;this.persist(trial);return}trial.events.push(event);this.persist(trial)},
    }
  }
  private fail(trial:PlanningTrial,error:unknown,signal:AbortSignal):PlanningTrial{
    const failure=signal.aborted&&errorCode(error)!=='TRIAL_CLEANUP_FAILED'?signal.reason??error:error
    const failureCode=errorCode(failure),timeout=['TRIAL_DEADLINE','PLANNING_DEADLINE_EXCEEDED'].includes(failureCode)
    trial.diagnostics=trial.diagnostics.slice(0,99)
    trial.diagnostics.push({code:failureCode,message:errorMessage(failure).slice(0,4000)})
    this.touch(trial,failureCode==='TRIAL_INTERRUPTED'?'interrupted':(signal.aborted||failureCode==='PLANNING_PARENT_DISPOSED')&&!timeout&&failureCode!=='TRIAL_CLEANUP_FAILED'?'cancelled':'failed')
    return trial
  }
  private async finishVerified(trial:PlanningTrial,caller:PlanningCaller,authorize:()=>void):Promise<PlanningTrial>{
    if(!trial.verification||trial.execution?.outcome!=='completed')throw new Error('TRIAL_NOT_COMPLETE：原任务尚未确认完成，不能仅靠回答继续反推')
    if(trial.evidenceIncomplete)throw Object.assign(new Error('试做公开记录不完整，无法可靠提炼；保留产物，不自动重做。'),{code:'TRIAL_EVIDENCE_INCOMPLETE'})
    if(trial.verification.verdict!=='passed')trial.diagnostics.push({code:'TRIAL_CHECK_WARNINGS',message:'演练已结束，部分冻结检查失败、无法核验或有最终审阅备注；继续生成，具体缺口见 verification。'})
    trial.verified=buildTrialEvidence({
      trialId:trial.id,workspaceId:trial.workspaceId,rootSessionId:trial.rootSessionId,childSessionId:trial.childId,specDigest:planningTrialSpecDigest(trial.request.spec),
      verification:trial.verification,events:trial.events,evidenceIncomplete:trial.evidenceIncomplete,path:trial.execution.path,
      onDiagnostic:diagnostic=>trial.diagnostics.push(diagnostic),...(trial.humanReview?{humanReview:trial.humanReview}:{}),resumedFrom:trial.continuations?.[0]?.fromSeq,
    })
    trial.receiptDigest=this.receipt(trial)
    this.touch(trial,'verified');authorize()
    this.touch(trial,'planning')
    const planned=await this.options.plan(trialPlanRequest(trial),caller)
    trial.planningTaskId=planned.id
    caller.signal.throwIfAborted();this.options.authorize(trial,caller,false)
    if(planningPending.includes(planned.state))throw Object.assign(new Error('规划仅返回受理身份，尚未完成当前生成阶段；没有把 trial.ready 当作受理成功'),{code:'TRIAL_PLANNING_INCOMPLETE'})
    // Planning may need questions or retain an over-target candidate; never rerun the trial.
    this.touch(trial,'ready');return trial
  }
  async cancel(id:string,caller:PlanningCaller):Promise<PlanningTrial>{
    const trial=this.owned(id,caller),active=this.active.get(id)
    if(active){active.controller.abort(Object.assign(new Error('用户取消试做闭环，保留已完成动作和现有候选'),{code:'TRIAL_CANCELLED'}));await active.done}
    else if(['needs_review','needs_input','interrupted'].includes(trial.state)){
      trial.diagnostics=trial.diagnostics.slice(0,99)
      trial.diagnostics.push({code:'TRIAL_CANCELLED',message:'用户取消试做闭环，保留已完成动作和现有候选'})
      this.touch(trial,'cancelled')
    }
    return structuredClone(trial)
  }
  async close():Promise<void>{
    this.lifetime.abort(Object.assign(new Error('Host 正在关闭，不自动重放试做'),{code:'TRIAL_INTERRUPTED'}))
    await Promise.allSettled([...this.active.values()].map(value=>value.done))
    await this.options.driver.close()
  }
}
