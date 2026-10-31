import { planningChainStateSchema, type PlanningChainState } from '../../shared/planning-chain-contract.ts'
import { authorPrompt, commandIntakePrompt, distillPrompt, optimizationPrompt, requiredCoverageIds } from './service-prompts.ts'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { NodeKind, Workflow, WorkflowProposal } from '../../shared/types.ts'
import { workflowVisibleInWorkspace } from '../../shared/workflow-scope.ts'
import type { WorkflowReadiness } from '../../shared/workflow-import.ts'
import type { PlanningContext, PlanningRequest, PlannerOutput } from '../../shared/planning-types.ts'
import { parsePlanningRequest, parsePlannerOutput } from '../../shared/planning-schema.ts'
import { planningCandidateIssues, projectWorkflow } from '../../shared/planning-projection.ts'
import { type compileOptimizationEdits, planningNodeRefs } from '../../shared/planning-edits.ts'
import { allNodes, parseWorkflow } from '../../shared/workflow-validation.ts'
import { ModelAdmission } from '../run-usage.ts'
import { PlanningStore, type PlanningStoreLimits } from './store.ts'
import { planningCommitSchema, planningReceiptSchema, type PlanningCommit, type PlanningReceipt } from './receipt.ts'
import { PlanningAgentError, type createPlanningAgent } from './agent.ts'
import { parseRetrospectiveOutput, parseTaskProcedure, taskSpecificationRefs, taskProcedureSchema, type TaskProcedure } from '../../shared/retrospective.ts'
import { validateConversationEvidence } from './conversation-evidence.ts'
import { optimizationReportSchema, type PlanningOptimizationReport, type OptimizationAttempt } from '../../shared/planning-optimization.ts'
import { optimizationStats, evaluateOptimizationTarget, optimizationReplacementIssues, selectOptimizationCandidate, optimizableNode } from './optimization.ts'
import { runPlanningRegression } from './regression.ts'
import { PLANNING_ENGINE_VERSION, type PlanningEngineVersion } from './version.ts'
import { graphonRuntimeDirectory } from '../graphon.ts'
import { planningTrialSpecSchema, trialVerificationReportSchema } from '../../shared/planning-trial.ts'
import { ARTIFACT_PROBE_EXCLUSION, artifactProbeRefs, buildTrialSkeleton, withDraftIssues, type TrialSkeleton } from './trial-skeleton.ts'
import { validateTrialVerificationReport } from './trial-verification.ts'
import { WorkflowAuthoringCompiler, type CompiledAuthoring, type AuthoringOptions } from '../../shared/planning-authoring.ts'
import { TemplateFillingCompiler } from '../../shared/planning-template-compiler.ts'
import { templateBindingSchema, validateTemplateBinding, type PlanningTemplateBinding } from '../../shared/planning-node-templates.ts'
import { planningTemplateCatalog, prefetchedTemplateIds, REHEARSAL_TEMPLATE_KINDS, templateGraphContext, queryPlanningTemplates } from './template-catalog.ts'
import { PlanningContextReader } from '../../shared/planning-context-reader.ts'
import { authoringGraphContext } from '../../shared/planning-authoring-context.ts'
import { createProcedureCompiler } from '../../shared/planning-procedure-compiler.ts'
import { createOptimizationCompiler } from '../../shared/planning-optimization-compiler.ts'
import { compilerJson, CompilerError, type RepairSession, type SubmissionCompiler } from '../../shared/planning-repair.ts'
import { planningCompilerModeSchema, planningCompilerSelectionSchema, selectPlanningCompiler, type PlanningCompilerSelection } from './compiler-selection.ts'
import { planningToolOutputSnapshotSchema, validatePlanningToolOutputs } from '../../shared/planning-tool-outputs.ts'
import { toolOperationContractSchema, validateToolOperation } from '../../shared/tool-operation-contract.ts'
import { planningContextSelectionSchema } from '../../shared/planning-context-slice.ts'
import { handoffCompletionPlan, completionCandidateIssues } from '../../shared/planning-completion.ts'
import { compileHandoffChanges, handoffCandidateIssues, handoffSelection } from '../../shared/planning-handoff.ts'
import { businessModuleStoredParametersDigest, compileBusinessModule, updateBusinessModule } from '../../shared/planning-business-modules.ts'
import { planningMetricSchema, PLANNING_METRIC_LIMIT, type PlanningMetric } from './metrics.ts'
import { registerPlanningBackground, planningBackgroundEnvelopeSchema, interruptPlanningBackgroundEnvelope, type PlanningBackgroundEnvelope, type PlanningBackgroundRuntime, type PlanningActiveOperation } from './background.ts'
import { hostRepairCheckpointSchema, type HostRepairCheckpoint } from '../../shared/planning-continuation.ts'
import { PlanningAnswerError, planningInputState, type PlanningInputState } from './input-state.ts'
import { CommandIntakeCompiler, commandIntakeSchema, type CommandIntake, type CommandIntakeResult } from './command-intake.ts'

export const planningDigest=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const firstRunSchema=z.object({
  requestId:z.string().min(1).max(160),status:z.enum(['starting','recorded','failed','interrupted']),
  runId:z.string().min(1).max(160).optional(),error:z.string().max(4000).optional(),
}).strict()
const designCheckSchema=z.enum(['candidate-schema','references-and-scope','authority','tool-preconditions','REVIEW_BEFORE_EFFECT','requirement-coverage','source-provenance','optimization'])
const designChecksSchema=z.object({version:z.literal(1),candidateDigest:z.string().regex(/^[a-f0-9]{64}$/).optional(),checksPassed:z.array(designCheckSchema).max(8)}).strict()
type State='returned'|'handed_off'|'collecting'|'queued'|'distilling'|'authoring'|'validating'|'repairing'|'optimizing'|'regressing'
  |'awaiting_input'|'ready'|'publishing'|'published'|'conflict'|'blocked'|'cancelling'|'cancelled'|'interrupted'|'failed'
export interface PlanningCaller {
  parent:Agent;sessionId:string;workspaceId:string;signal:AbortSignal
  /** Host-only entry provenance, never accepted from model request JSON. */
  modelSource?:'request'|'selection'|'background'
  modelSelection?:{provider:string;model:string;reasoningEffort?:string}
}
interface Diagnostic {code:string;message:string;nodeId?:string;path?:string}
export interface PlanningSourceMapping {stepId:string;nodeIds:string[];evidenceRefs:string[]}
export interface PlanningTask {
  engineVersion:PlanningEngineVersion
  firstRun?:z.infer<typeof firstRunSchema>
  id:string;request:PlanningRequest;requestDigest:string;workspaceId:string;sessionId:string;preview:boolean
  state:State;revision:number;createdAt:string;updatedAt:string;context?:PlanningContext;candidate?:Workflow;candidateDigest?:string
  output?:PlannerOutput;diagnostics:Diagnostic[];readiness?:WorkflowReadiness;receipt?:PlanningReceipt;commit?:PlanningCommit
  childAttempts:number;steps:number;spentTokens:number;unknownTokens:number;reservedTokens:number;candidateAttempts:number;questionRounds:number
  /** v1 unknown/reservedTokens are historical mixed-unit estimates, not billed Token usage. */
  usageAccountingVersion:1|2;observedInputBytes:number;unknownUsageCalls:number;pendingUsageCalls:number
  /** Host-validated human batches; historical tasks may have only flat answers. */
  answeredQuestions?:{taskId:string;revision:number;source:'native'|'manual';questions:{id:string;question:string;options:string[];answer:string}[]}[]
  answers:{questionId:string;answer:string}[];events:{sequence:number;state:State;at:string;message:string}[];childId?:string
  distillationAttempts?:number;distillationSource?:'submitted-by-trial'|'model';procedure?:TaskProcedure;sourceMap?:PlanningSourceMapping[];provenanceDigest?:string
  optimization?:PlanningOptimizationReport;optimizationDigest?:string
  compilerMode?:'compact-repair'|'template-fill'
  /** Host-only entry decision. Absence denotes a historical, already frozen mode. */
  compilerSelection?:PlanningCompilerSelection
  templateBinding?:PlanningTemplateBinding
  compilerDraft?:{format?:'compact-v1'|'template-fill-v1'|'procedure-v1'|'optimization-v1';purpose:'author'|'distill'|'optimize';baseDigest:string;revision:number;document:unknown;issues:Diagnostic[];checkpoint?:HostRepairCheckpoint}
  compilerMetrics?:PlanningMetric[]
  handoffState?:{version:1;route:'edit'|'module'|'partial'|'chain';decisionDigest:string;contextDigest:string}
  chainState?:PlanningChainState
  moduleProvenance?:{moduleId:string;version:string;instanceKey:string;implementationDigest:string;parametersDigest:string;nodeIds:string[]}
  commandIntake?:CommandIntake
  /** Opt-in for new tasks only; checks bind to the exact candidate, never to a stored receipt. */
  designChecks?:z.infer<typeof designChecksSchema>
  /** New tasks only. Missing publication endpoint means comparison is unavailable (e.g. crash recovery). */
  workspaceSnapshot?:{accepted:Record<string,number>;published?:Record<string,number>}
  delivery?:{protocolVersion:1;mode:'background';acceptedAt:string;recovered?:boolean}
}
interface Options {
  retentionLimits?:PlanningStoreLimits
  compilerMode?:'legacy'|'compact-repair'|'template-fill'
  commandRequest?(task:PlanningTask,value:unknown,caller:PlanningCaller):Record<string,unknown>
  commandSubmit?(request:Record<string,unknown>,caller:PlanningCaller):Promise<{taskId:string}>
  directory:string;driver:ReturnType<typeof createPlanningAgent>;admission:ModelAdmission
  context(request:PlanningRequest,caller:PlanningCaller):Promise<PlanningContext>
  authorize(task:PlanningTask,caller:PlanningCaller,write:boolean):void
  readiness(candidate:Workflow,caller:PlanningCaller):Promise<WorkflowReadiness>
  publish(candidate:Workflow,task:PlanningTask,caller:PlanningCaller,commit:PlanningCommit):Promise<void>
  runCreated?(task:PlanningTask,caller:PlanningCaller,started:(runId:string)=>void):Promise<void>
  receipt(key:string):PlanningReceipt|undefined
  retainReceiptBase?(receipt:PlanningReceipt):boolean
  workspaceRevisions?(caller:PlanningCaller):Record<string,number>
  onUpdate?(task:PlanningTask):void
  backgroundRuntime?:PlanningBackgroundRuntime
  /** Host-native human questions; never accept an Agent-generated answer here. */
  askQuestions?(task:PlanningTask,caller:PlanningCaller):Promise<{questionId:string;answer:string}[]|undefined>
}
const terminal=new Set<State>(['returned','handed_off','published','failed','cancelled','interrupted','conflict','blocked'])
const states=new Set<State>([...terminal,'collecting','queued','distilling','authoring','validating','repairing','optimizing','regressing','awaiting_input','ready','publishing','cancelling'])
const MAX_STEPS=24,MAX_CHILDREN=8,MAX_CHILD_STEPS=8,TASK_DEADLINE_MS=1_200_000
const message=(error:unknown)=>error instanceof Error?error.message:String(error)
const code=(error:unknown):string=>error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:''
const identity=z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/),count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),digestSchema=z.string().regex(/^[a-f0-9]{64}$/)
const stateSchema=z.custom<State>(value=>typeof value==='string'&&states.has(value as State))
const diagnosticSchema=z.object({code:z.string().min(1).max(160),message:z.string().max(4000),nodeId:z.string().optional(),path:z.string().optional()}).strict()
const contextToolSchema=z.object({
  id:z.string().min(1).max(512),name:z.string().min(1),description:z.string(),providerId:z.string(),providerName:z.string(),author:z.string().optional(),
  category:z.enum(['plugin','swagger','workflow','mcp']),inputSchema:z.record(z.string(),z.unknown()),
  available:z.boolean(),unavailableReason:z.string().optional(),operationContract:toolOperationContractSchema.optional(),
}).strict()
const trialBindingSchema=z.object({
  trialId:identity,rootSessionId:identity,childSessionId:identity,workspaceId:z.string().min(1).max(4000),
  specDigest:digestSchema,verificationDigest:digestSchema,evidenceDigest:digestSchema,receiptDigest:digestSchema,
}).strict()
const contextSchema=z.object({
  workflow:z.unknown().transform(parseWorkflow),operation:z.enum(['create','revise']),
  targetNodeIds:z.array(identity).max(500),nodeIds:z.array(identity).max(500),subagentIds:z.array(identity).max(500),environmentIds:z.array(identity).max(500),
  tools:z.array(contextToolSchema).max(5000),
  toolOutputs:planningToolOutputSnapshotSchema.optional(),
  contextSelection:planningContextSelectionSchema.optional(),
  model:z.object({provider:z.string().min(1),model:z.string().min(1)}).strict(),effort:z.string().optional(),
  conversation:z.unknown().transform(validateConversationEvidence).optional(),
  trial:trialBindingSchema.optional(),
  trialReport:z.object({verification:trialVerificationReportSchema,summary:z.string().max(10000),summarySource:z.literal('agent-claim')}).strict().optional(),
  trialProcedure:z.unknown().transform(value=>compilerJson(value)).optional(),
  trialTask:z.object({task:planningTrialSpecSchema.shape.task,inputs:planningTrialSpecSchema.shape.inputs,artifacts:planningTrialSpecSchema.shape.artifacts,reviewItems:planningTrialSpecSchema.shape.reviewItems}).strict().optional(),
}).strict()
const readinessSchema=z.object({workflowId:identity,revision:count,canRun:z.boolean(),issues:z.array(z.object({
  id:z.string(),nodeId:z.string().optional(),workflowId:z.string().optional(),field:z.string().optional(),
  kind:z.enum(['configuration','model','tool','workflow','file','role','environment','secret']),message:z.string(),
  action:z.enum(['node','environment','dependency']),dependencyId:z.string().optional(),
}).strict()).max(2000)}).strict()
const answeredBatchSchema=z.object({taskId:identity,revision:count.min(1),source:z.enum(['native','manual']),questions:z.array(z.object({
  id:identity,question:z.string().min(1).max(4000),options:z.array(z.string().min(1).max(1000)).max(8),answer:z.string().min(1).max(10_000),
}).strict()).min(1).max(3)}).strict()
const eventSchema=z.object({sequence:count.min(1),state:stateSchema,at:z.string().datetime(),message:z.string().max(1200)}).strict()
const sourceMappingSchema=z.object({stepId:identity,nodeIds:z.array(identity).max(500),evidenceRefs:z.array(identity).max(500)}).strict()
const compilerDraftSchema=z.object({
  format:z.enum(['compact-v1','template-fill-v1','procedure-v1','optimization-v1']).optional(),purpose:z.enum(['author','distill','optimize']),
  baseDigest:digestSchema,revision:count,document:z.unknown().transform(v=>compilerJson(v)),issues:z.array(diagnosticSchema).max(1000),checkpoint:hostRepairCheckpointSchema.optional(),
}).strict()
const storedTaskSchema=z.object({
  firstRun:firstRunSchema.optional(),
  engineVersion:z.enum(['0.0.1','0.0.2']).default('0.0.1'),
  id:identity,request:z.unknown().transform(parsePlanningRequest),requestDigest:digestSchema,workspaceId:z.string().min(1).max(4000),sessionId:identity,preview:z.boolean(),
  state:stateSchema,revision:count.min(1),createdAt:z.string().datetime(),updatedAt:z.string().datetime(),
  context:contextSchema.optional(),candidate:z.unknown().transform(parseWorkflow).optional(),candidateDigest:digestSchema.optional(),output:z.unknown().transform(parsePlannerOutput).optional(),
  diagnostics:z.array(diagnosticSchema).max(1000),readiness:readinessSchema.optional(),receipt:planningReceiptSchema.optional(),commit:planningCommitSchema.optional(),
  childAttempts:count.max(MAX_CHILDREN),steps:count.max(MAX_STEPS),spentTokens:count,unknownTokens:count,reservedTokens:count,candidateAttempts:count.max(3),questionRounds:count.max(3),
  usageAccountingVersion:z.union([z.literal(1),z.literal(2)]).default(1),observedInputBytes:count.default(0),unknownUsageCalls:count.default(0),pendingUsageCalls:count.default(0),
  answeredQuestions:z.array(answeredBatchSchema).min(1).max(2).optional(),
  answers:z.array(z.object({questionId:identity,answer:z.string().min(1).max(10_000)}).strict()).max(6),events:z.array(eventSchema).max(120),childId:identity.optional(),
  distillationSource:z.enum(['submitted-by-trial','model']).optional(),distillationAttempts:count.max(2).optional(),procedure:taskProcedureSchema.optional(),
  sourceMap:z.array(sourceMappingSchema).max(100).optional(),provenanceDigest:digestSchema.optional(),
  optimization:optimizationReportSchema.optional(),optimizationDigest:digestSchema.optional(),
  compilerMode:z.enum(['compact-repair','template-fill']).optional(),
  compilerSelection:planningCompilerSelectionSchema.optional(),
  templateBinding:templateBindingSchema.optional(),
  compilerDraft:compilerDraftSchema.optional(),
  compilerMetrics:z.array(planningMetricSchema).max(PLANNING_METRIC_LIMIT).optional(),
  handoffState:z.object({version:z.literal(1),route:z.enum(['edit','module','partial','chain']),decisionDigest:digestSchema,contextDigest:digestSchema}).strict().optional(),
  chainState:planningChainStateSchema.optional(),
  moduleProvenance:z.object({moduleId:identity,version:z.string().min(1).max(100),instanceKey:identity,implementationDigest:digestSchema,parametersDigest:digestSchema,nodeIds:z.array(identity).max(500)}).strict().optional(),
  commandIntake:commandIntakeSchema.optional(),
  designChecks:designChecksSchema.optional(),
  workspaceSnapshot:z.object({accepted:z.record(identity,count),published:z.record(identity,count).optional()}).strict().optional(),
  delivery:z.object({protocolVersion:z.literal(1),mode:z.literal('background'),acceptedAt:z.string().datetime(),recovered:z.boolean().optional()}).strict().optional(),
}).strict()
class PlanningPublicationError extends Error {readonly code='PUBLISH_UNCERTAIN';constructor(cause:unknown){super(`发布结果未确认，禁止自动重试：${message(cause)}`,{cause})}}
const isCleanupFailure=(error:unknown)=>code(error)==='PLANNER_CLEANUP_FAILED'||/清理失败|dispose failed/i.test(message(error))
const isConflict=(error:unknown)=>/CONFLICT/.test(code(error))||/版本|REVISION|CONFLICT|摘要冲突/.test(message(error))
const isPermissionFailure=(error:unknown)=>code(error)!=='COMPILER_COMMIT_REJECTED'
  &&(/权限|只读|计划模式|规划模式|UNAUTHORIZED|FORBIDDEN|READ_ONLY/.test(message(error))||/FORBIDDEN|FIXED_NODE|TARGET_SCOPE|HOST_METADATA|SECRET/.test(code(error)))
type DraftFormat=NonNullable<NonNullable<PlanningTask['compilerDraft']>['format']>
type ModuleHandoff=Extract<NonNullable<PlanningRequest['handoff']>,{mode:'module'}>
const draftFormat=(task:PlanningTask,purpose:'author'|'distill'|'optimize'):DraftFormat=>
  purpose==='author'?(task.compilerMode==='template-fill'?'template-fill-v1':'compact-v1'):purpose==='distill'?'procedure-v1':'optimization-v1'
/** Created graphs the Host runs once after saving: a verified trial's, and a module the create entry instantiated (Desktop r59 D). */
export function runsOnceAfterSave(request:PlanningRequest):boolean{return request.operation==='create'&&(request.source?.kind==='verified-trial'||request.runAfterSave===true)}
const interruptedFirstRun=(id:string):z.infer<typeof firstRunSchema>=>({requestId:`trial-first-${id}`,status:'interrupted',error:'恢复的保存回执没有首次运行记录；不自动补跑。'})
const markHandoffInvalid=(task:PlanningTask,error:unknown):void=>{
  task.diagnostics=[...task.diagnostics.filter(issue=>issue.code!=='HANDOFF_CANDIDATE_INVALID'),{code:'HANDOFF_CANDIDATE_INVALID',message:message(error).slice(0,2000)}]
}
const settlePendingUsage=(task:PlanningTask):void=>{
  if(task.pendingUsageCalls){task.unknownUsageCalls+=task.pendingUsageCalls;if(!Number.isSafeInteger(task.unknownUsageCalls))throw new Error('规划未知调用次数无效');task.pendingUsageCalls=0}
}
const countUnknownUsageCall=(task:PlanningTask):void=>{
  if(!Number.isSafeInteger(task.unknownUsageCalls+1))throw new PlanningAgentError('PLANNING_ACCOUNTING_INVALID','规划未知调用次数无法继续安全累计');task.unknownUsageCalls++
}
const freshCounters=()=>({
  childAttempts:0,steps:0,spentTokens:0,unknownTokens:0,reservedTokens:0,
  usageAccountingVersion:2 as const,observedInputBytes:0,unknownUsageCalls:0,pendingUsageCalls:0,candidateAttempts:0,questionRounds:0,
  answers:[] as PlanningTask['answers'],events:[] as PlanningTask['events'],
})
const restoredBackgroundRow=(value:unknown)=>{
  const row=z.object({id:identity,preview:z.literal(false)}).passthrough().parse(value)
  const {id,preview,...rest}=row,envelope=interruptPlanningBackgroundEnvelope(rest)
  if(envelope.taskId!==id)throw new Error('后台受理身份不一致')
  return {...envelope,id,preview}
}
const expiredPreviewTask=(receipt:PlanningBackgroundEnvelope&{id:string}):PlanningTask=>({
  engineVersion:PLANNING_ENGINE_VERSION,id:receipt.id,
  request:{requestId:receipt.requestId,operation:'create',instruction:'Host 重启后保留的后台预览受理记录',preview:true},requestDigest:receipt.requestDigest,
  workspaceId:receipt.workspaceId,sessionId:receipt.sessionId,preview:true,state:'interrupted',revision:1,createdAt:receipt.acceptedAt,updatedAt:receipt.interruptedAt!,
  diagnostics:[{code:'PREVIEW_EXPIRED',message:'预览内容未持久化，重启后只保留受理身份；没有自动重跑或发布。原调用用量不可从此回执恢复。'}],
  ...freshCounters(),
  delivery:{protocolVersion:1,mode:'background',acceptedAt:receipt.acceptedAt,recovered:true},
})
const acceptedOptimizationCandidates=(report:PlanningOptimizationReport)=>
  [report.baseline.candidate,...report.attempts.filter(attempt=>attempt.accepted&&attempt.candidate).map(attempt=>attempt.candidate!)]
const storedCandidateIssues=(task:PlanningTask)=>task.context?[
  ...(task.candidate?planningCandidateIssues(task.candidate,task.context):[]),
  ...(task.optimization?acceptedOptimizationCandidates(task.optimization).flatMap(candidate=>planningCandidateIssues(candidate,task.context!)):[]),
]:[]
const issueLabel=(issue:{code:string;nodeId?:string;path?:string})=>`${issue.code}${issue.nodeId?` (${issue.nodeId})`:''}${issue.path?` ${issue.path}`:''}`
const contractChangedDiagnostic=(issues:readonly {code:string;nodeId?:string;path?:string}[])=>
  ({code:'STORED_CANDIDATE_CONTRACT_CHANGED',message:`历史候选不满足当前内容契约：${issues.map(issueLabel).join('；')}`.slice(0,2000)})
/** Before b9b976c an uncommitted candidate was digested in compiler key order, which
 * parseWorkflow reorders when it has module instances. Re-stamp only a verified raw match. */
function restampLegacyDigest(task:PlanningTask,raw:unknown):void{
  const stored=(raw as {candidate?:unknown}|null)?.candidate,old=task.candidateDigest
  if(task.candidate&&stored&&!task.commit&&!task.receipt&&old===planningDigest(stored)&&old!==planningDigest(task.candidate)){
    task.candidateDigest=planningDigest(task.candidate)
    if(task.designChecks?.candidateDigest===old)task.designChecks.candidateDigest=task.candidateDigest
  }
}
function validateStoredAnswers(task:PlanningTask):void{
  if(!task.answeredQuestions)return
  let prior=0
  for(const batch of task.answeredQuestions){
    if(batch.taskId!==task.id||batch.revision<=prior||batch.revision>=task.revision||new Set(batch.questions.map(q=>q.id)).size!==batch.questions.length)throw new Error('真人回答批次绑定无效')
    prior=batch.revision
  }
  const bound=task.answeredQuestions.flatMap(batch=>batch.questions.map(q=>({questionId:q.id,answer:q.answer})))
  if(JSON.stringify(task.answers.slice(-bound.length))!==JSON.stringify(bound))throw new Error('真人回答批次与回答记录不一致')
}
function validateStoredIntake(task:PlanningTask):void{
  const intake=task.commandIntake
  if(!intake)return
  if(intake.rawRequirement.trim()!==task.request.instruction||task.request.operation!=='create'||task.request.source||task.request.handoff)throw new Error('命令受理原始需求或入口不匹配')
  if(intake.linkedTaskId&&(!intake.decision||intake.returned)
    ||intake.decision&&(intake.decision.requestId!==task.request.requestId+'-plan'||intake.decision.instruction!==task.request.instruction||intake.decision.operation!=='create'))
    throw new Error('命令受理路由决定或任务身份不匹配')
  if(task.state==='handed_off'&&!intake.linkedTaskId||task.state==='returned'&&!intake.returned)throw new Error('命令受理缺少交接结果')
}
const modelProgress=(task:PlanningTask)=>!!(task.childAttempts||task.candidateAttempts||task.distillationAttempts||task.steps||task.questionRounds||task.answers.length)
const usageRecorded=(task:PlanningTask)=>
  !!(task.spentTokens||task.unknownTokens||task.reservedTokens||task.observedInputBytes||task.unknownUsageCalls||task.pendingUsageCalls||task.compilerMetrics?.length)
const derivedArtifacts=(task:PlanningTask)=>!!(task.childId||task.compilerDraft||task.output||task.candidate||task.candidateDigest||task.readiness
  ||task.procedure||task.sourceMap||task.provenanceDigest||task.optimization||task.optimizationDigest||task.commit||task.receipt)
function validateStoredSelection(task:PlanningTask):void{
  if(!task.compilerSelection&&task.compilerMode==='template-fill'&&task.context&&!task.templateBinding){
    // Older Hosts assigned context before validating it or freezing templates.
    // Check recovery eligibility before inspecting that incomplete context;
    // any child or derived artifact still requires a genuine frozen binding.
    if(task.state!=='failed'||modelProgress(task)||derivedArtifacts(task))throw new Error('模板任务缺少冻结快照')
    delete task.context
  }
  if(task.compilerSelection?.state==='pending'){
    if(task.compilerMode||task.context||task.templateBinding||modelProgress(task)||usageRecorded(task)||derivedArtifacts(task))
      throw new Error('待选择模式的任务不能包含冻结上下文或派生产物')
  }else if(task.compilerSelection){
    if(!task.context||(task.compilerMode??'legacy')!==task.compilerSelection.effectiveMode)throw new Error('冻结模式选择与任务上下文不匹配')
    if(task.compilerMode==='template-fill'&&!task.templateBinding)throw new Error('模板任务缺少冻结快照')
    if(task.compilerSelection.reason==='baseline-tool-template-unavailable'){
      const expected=selectPlanningCompiler(task.compilerSelection.requestedMode,task.context)
      if(JSON.stringify(expected)!==JSON.stringify(task.compilerSelection))throw new Error('回退模式选择与冻结基线不匹配')
    }
  }
}
const staleHandoffState=(task:PlanningTask)=>{
  const state=task.handoffState,handoff=task.request.handoff
  return !!state&&(!handoff||state.route!==handoff.mode||state.decisionDigest!==planningDigest(handoff)||!task.context||state.contextDigest!==planningDigest(task.context))
}
const semanticDigest=(workflow:Workflow)=>{
  const value=structuredClone(workflow);delete (value as Partial<Workflow>).updatedAt
  const ordered=(item:any):any=>Array.isArray(item)?item.map(ordered):item&&typeof item==='object'?Object.fromEntries(Object.keys(item).sort().map(key=>[key,ordered(item[key])])):item
  return planningDigest(ordered(value))
}
const sortedProvenanceDigest=(provenance:{nodeIds:string[]})=>planningDigest({...provenance,nodeIds:[...provenance.nodeIds].sort()})
const moduleProvenanceConflict=(provenance:PlanningTask['moduleProvenance'],request:ModuleHandoff['module'],candidate:Workflow)=>!provenance
  ||provenance.moduleId!==request.moduleId||provenance.version!==request.version||provenance.instanceKey!==request.instanceKey||provenance.parametersDigest!==planningDigest(request.parameters)
  ||!provenance.nodeIds.length||new Set(provenance.nodeIds).size!==provenance.nodeIds.length||provenance.nodeIds.some(id=>!allNodes(candidate).some(node=>node.id===id))
function submittedTrialProcedure(task:PlanningTask):{procedure:TaskProcedure;hostExcluded:string[]}|undefined{
  const context=task.context!
  const accept=(procedure:unknown):TaskProcedure|undefined=>{
    try{
      const submitted=createProcedureCompiler(context.conversation!,context.trialTask).submit({submission:{mode:'distill',procedure}})
      if(submitted.ok&&submitted.value.outcome==='procedure')return JSON.parse(submitted.value.procedureJson)
    }catch{}
    return undefined
  }
  const direct=accept(context.trialProcedure)
  if(direct)return {procedure:direct,hostExcluded:[]}
  // Desktop r52: the only gap was a look at the target before writing it.
  // Host files exactly those records under a stated reason; anything else stays a gap.
  const submitted=context.trialProcedure as {steps?:unknown;excluded?:unknown}|undefined
  if(!submitted||!Array.isArray(submitted.steps)||!Array.isArray(submitted.excluded))return undefined
  const covered=new Set([...submitted.steps,...submitted.excluded].flatMap((item:any)=>Array.isArray(item?.evidenceRefs)?item.evidenceRefs:[]))
  const missing=context.conversation!.records.map(row=>row.id).filter(id=>!covered.has(id)),probes=new Set(artifactProbeRefs(context))
  if(!missing.length||missing.some(id=>!probes.has(id)))return undefined
  const repaired=accept({...submitted,excluded:[...submitted.excluded,{evidenceRefs:missing,reason:ARTIFACT_PROBE_EXCLUSION}]})
  return repaired?{procedure:repaired,hostExcluded:missing}:undefined
}
function assertAnswerBatch(task:PlanningTask,answers:unknown):asserts answers is {questionId:string;answer:string}[]{
  if(!Array.isArray(answers)||answers.length!==task.output?.questions.length)throw new Error('请回答本批次所有问题')
  const ids=new Set<string>()
  for(const item of answers){
    if(!item||typeof item!=='object'||Object.keys(item).some(key=>!['questionId','answer'].includes(key))||typeof item.questionId!=='string'||typeof item.answer!=='string'
      ||!item.answer.trim()||item.answer.length>10000||ids.has(item.questionId)||!task.output?.questions.some(q=>q.id===item.questionId))throw new Error('问题回答格式或身份无效')
    ids.add(item.questionId)
  }
}
const baselineOptimizationReport=(baseline:Workflow,stats:ReturnType<typeof optimizationStats>,target:PlanningRequest['optimizationTarget']):PlanningOptimizationReport=>({
  engineVersion:PLANNING_ENGINE_VERSION,
  baseline:{candidate:baseline,stats,targetEvaluation:evaluateOptimizationTarget(stats,target)},
  selected:{stats,targetEvaluation:evaluateOptimizationTarget(stats,target)},
  ...(target?{target}:{}),selection:'baseline',attempts:[],stopReason:'',
})
const replacementNodeIds=(report:PlanningOptimizationReport,replacements:readonly {nodeId:string}[])=>
  [...new Set([...report.attempts.filter(item=>item.accepted).flatMap(item=>item.replacements.map(replacement=>replacement.nodeId)),...replacements.map(item=>item.nodeId)])]
const readinessKey=(issue:WorkflowReadiness['issues'][number])=>JSON.stringify([issue.nodeId,issue.field,issue.kind,issue.dependencyId])
const invokeState=(purpose:'distill'|'author'|'optimize',repairing:boolean):State=>
  purpose==='optimize'?'optimizing':repairing?'repairing':purpose==='distill'?'distilling':'authoring'
const invokeMessage=(purpose:'distill'|'author'|'optimize',repairing:boolean)=>
  purpose==='optimize'?'保留已验证候选，寻找确定性替换':purpose==='distill'?(repairing?'根据证据诊断修正提炼结果':'从当前对话提炼可复用步骤'):(repairing?'根据诊断修正候选':'生成节点图')
const submissionMessage=(issues:readonly Diagnostic[],snapshot:{revision:number;repairSummary?:string})=>
  issues.some(issue=>issue.code==='COMPILER_TOOL_SCHEMA_INVALID')?'工具参数未通过工具 Schema 校验，向同一子 Agent 返回更正诊断'
    :issues.length?snapshot.revision?'草稿已保留，向同一子 Agent 返回局部修复诊断':'尚无可修复草稿，向同一子 Agent 返回初始参数更正诊断'
    :snapshot.repairSummary?`${snapshot.repairSummary} 编译通过，等待原生工具提交结果`:'编译通过，等待原生工具提交结果'
const failureDiagnosticCode=(state:State,failureCode:string,cleanup:boolean,uncertain:boolean,timeout:boolean):string=>
  cleanup?'PLANNER_CLEANUP_FAILED':uncertain?'PUBLISH_UNCERTAIN':state==='cancelled'?'CANCELLED'
    :state==='conflict'?(failureCode.endsWith('CONFLICT')?failureCode:'REVISION_CONFLICT'):state==='blocked'?'PERMISSION_BLOCKED'
    :failureCode==='COMPILER_COMMIT_REJECTED'||failureCode.startsWith('PLANNING_')||failureCode.startsWith('CHAIN_')?failureCode:timeout?'PLANNING_TIMEOUT':'PLANNING_FAILED'
type AuthorScope={handoff:PlanningRequest['handoff'];decided:Workflow|undefined;completion:ReturnType<typeof handoffCompletionPlan>}
function chooseCompiler(task:PlanningTask,context:PlanningContext){
  const pending=task.compilerSelection?.state==='pending'?task.compilerSelection:undefined
  const requestedMode=pending?.requestedMode??task.compilerMode??'legacy'
  // Validate the requested template snapshot before considering eligibility;
  // malformed or future contracts are failures, never fallback signals.
  const binding=requestedMode==='template-fill'?planningTemplateCatalog(context):undefined
  return {binding,selection:selectPlanningCompiler(requestedMode,context)}
}
const passedDesignChecks=(task:PlanningTask,candidateDigest:string):z.infer<typeof designChecksSchema>=>({version:1,candidateDigest,
  checksPassed:['candidate-schema','references-and-scope','authority','tool-preconditions','REVIEW_BEFORE_EFFECT','requirement-coverage',...(task.procedure?['source-provenance' as const]:[]),...(task.optimization?['optimization' as const]:[])]})
function validateEvidenceSource(task:PlanningTask,context:PlanningContext,evidence:ReturnType<typeof validateConversationEvidence>):void{
  const source=task.request.source!
  if(source.kind==='verified-trial'){
    const trial=context.trial
    if(!trial||!context.trialTask||trial.trialId!==source.trialId||trial.rootSessionId!==task.sessionId||trial.workspaceId!==task.workspaceId
      ||trial.childSessionId!==evidence.sessionId||trial.evidenceDigest!==evidence.digest)throw new Error('试做证据归属或验收回执无效')
    if(context.trialReport){const report=validateTrialVerificationReport(context.trialReport.verification);if(report.digest!==trial.verificationDigest||report.specDigest!==trial.specDigest)throw new Error('试做检查报告与绑定不一致')}
  }else if(context.trial||context.trialReport||context.trialTask||context.trialProcedure!==undefined||evidence.sessionId!==task.sessionId
    ||(source.fromSeq!==undefined&&source.fromSeq!==evidence.fromSeq)||(source.throughSeq!==undefined&&source.throughSeq!==evidence.throughSeq))throw new Error('当前对话证据归属或截面范围无效')
}
/** Designs definitions and replays bounded pure transformations. Never executes the business graph. */
export class WorkflowPlanningService {
  private readonly tasks=new Map<string,PlanningTask>()
  private readonly active=new Map<string,PlanningActiveOperation<PlanningTask>>()
  /** Runtime-only; a restored parked question must never revive a native waiter. */
  private readonly nativeQuestions=new Map<string,number>()
  private readonly inputAvailabilityPending=new Set<string>()
  private readonly planningAdmission=new ModelAdmission(2,1)
  private readonly lifetime=new AbortController()
  private readonly store:PlanningStore<PlanningTask>
  private readonly backgroundStore:PlanningStore<PlanningBackgroundEnvelope&{id:string;preview:false}>
  private readonly backgroundReceipts=new Map<string,PlanningBackgroundEnvelope&{id:string;preview:false}>()
  /** Runtime-only journal timing, flushed as one aggregated span so events do not crowd model metrics. */
  private readonly persistTiming=new Map<string,{count:number;durationMs:number}>()
  /** Restore review evidence only for the exact candidate and committed proposal. */
  proposalBase(proposal:WorkflowProposal):Workflow|undefined{
    for(const task of this.tasks.values()){
      const base=task.context?.workflow
      if(task.request.operation!=='revise'||!base||base.id!==proposal.workflowId||base.revision!==proposal.baseRevision||task.candidateDigest!==planningDigest(proposal.candidate)||!task.commit)continue
      const receipt=this.lookupReceipt(task,task.commit)
      if(receipt?.kind==='proposed'&&receipt.proposalId===proposal.id&&receipt.workflowId===proposal.workflowId&&receipt.revision===proposal.baseRevision)return structuredClone(base)
    }
  }
  constructor(private readonly options:Options){
    this.store=new PlanningStore(options.directory,task=>!task.preview||task.request.source?.kind==='verified-trial','tasks.json',{
      ...options.retentionLimits,createdAt:task=>task.createdAt,canEvict:(task,retained)=>this.canEvict(task,retained),
      beforeEvict:ids=>this.removeBackgroundReceipts(ids),onEvict:ids=>{for(const id of ids)this.dropTask(id)},
    })
    this.backgroundStore=new PlanningStore(options.directory,()=>true,'background.json',{
      ...options.retentionLimits,createdAt:row=>row.acceptedAt,
      canEvict:row=>{const task=this.tasks.get(row.id);return !task||this.canEvict(task,[...this.tasks.values()])},
      onEvict:ids=>{for(const id of ids){this.backgroundReceipts.delete(id);const task=this.tasks.get(id);if(task?.preview&&task.request.source?.kind!=='verified-trial')this.dropTask(id)}},
    })
    for(const receipt of this.backgroundStore.read(restoredBackgroundRow))this.backgroundReceipts.set(receipt.id,receipt)
    let changed=false
    const originalRows=new Map<string,{raw:PlanningTask;parsed:PlanningTask;recovered:boolean}>()
    const loaded=this.store.read(raw=>{
      const task=this.parseStored(raw)
      const recovered=!!raw&&typeof raw==='object'&&(('context'in raw&&!task.context)||('state'in raw&&raw.state!==task.state))
      if(recovered)changed=true
      originalRows.set(task.id,{raw:raw as PlanningTask,parsed:structuredClone(task),recovered})
      return task
    })
    if(new Set(loaded.map(task=>JSON.stringify([task.workspaceId,task.sessionId,task.request.requestId]))).size!==loaded.length)throw new Error('规划请求身份重复')
    for(const task of loaded)this.tasks.set(task.id,task)
    for(const task of loaded)if(this.recoverTask(task))changed=true
    if(changed)this.store.write([...this.tasks.values()].map(task=>{
      const original=originalRows.get(task.id)
      // The file is an array: persisting a genuinely interrupted sibling must
      // not materialize defaults or migrate an unchanged historical row.
      return original&&!original.recovered&&isDeepStrictEqual(task,original.parsed)?original.raw:task
    }))
    for(const receipt of this.backgroundReceipts.values()){
      if(this.tasks.has(receipt.id))continue
      // Ordinary previews retain identity only, never historical source text or a replayable graph.
      const task=expiredPreviewTask(receipt)
      this.tasks.set(task.id,task)
    }
    for(const task of this.tasks.values())this.options.onUpdate?.(structuredClone(task))
  }
  private recoverTask(task:PlanningTask):boolean{
    let changed=false
    if(task.firstRun?.status==='starting'){task.firstRun.status='interrupted';task.firstRun.error='Host 重启；首次运行受理状态不确定，不自动重发。';changed=true}
    // All source tasks are indexed now, so restored module updates can verify
    // their earlier committed lineage without depending on file row order.
    if(task.candidate&&(task.request.handoff||task.moduleProvenance))try{this.validateHandoffCandidate(task)}catch(error){
      markHandoffInvalid(task,error)
      if(task.state!=='blocked'){this.touch(task,'blocked','恢复候选与已确定交接不一致，保留原回执证据并禁止再次发布',false);changed=true}
    }
    // Legacy mixed-unit estimates remain inert historical values. Restarting
    // cannot relabel a reservation as provider-reported or unknown Token use.
    const receipt=task.commit&&this.lookupReceipt(task,task.commit)
    // Only a crash between save and the first-run record leaves a publishing task;
    // tasks saved before first runs existed keep their history unchanged.
    if(receipt?.kind==='created'&&runsOnceAfterSave(task.request)&&!task.firstRun&&task.state==='publishing'){task.firstRun=interruptedFirstRun(task.id);changed=true}
    // Historical candidates are evidence, not new submissions. Verify the
    // atomic receipt first; newer content contracts cannot invalidate it.
    const issues=storedCandidateIssues(task)
    // A handoff integrity failure already blocks the task and remains its
    // primary diagnostic rather than being obscured by content-contract drift.
    if(issues.length&&!task.diagnostics.some(issue=>issue.code==='HANDOFF_CANDIDATE_INVALID')){
      const diagnostic=contractChangedDiagnostic(issues)
      if(!task.diagnostics.some(issue=>isDeepStrictEqual(issue,diagnostic))){task.diagnostics=[...task.diagnostics.filter(issue=>issue.code!==diagnostic.code).slice(0,999),diagnostic];changed=true}
    }
    if(receipt){task.receipt=receipt;if(task.state!=='published'&&!task.diagnostics.some(issue=>issue.code==='HANDOFF_CANDIDATE_INVALID')){this.touch(task,'published','从原子提交回执恢复完成状态',false);changed=true}}
    else if(task.state==='published'||task.state==='publishing'){
      task.diagnostics=task.diagnostics.slice(-999)
      task.diagnostics.push({code:'PUBLISH_UNCERTAIN',message:'重启后缺少原子提交回执，禁止自动再次提交'})
      this.touch(task,'blocked','提交结果需要核查',false);changed=true
    }else if(task.state==='ready'&&issues.length){
      this.touch(task,'blocked','历史候选不满足当前内容契约，请重新规划',false);changed=true
    }else if(this.retireLegacy(task,false)){changed=true
    }else if(!terminal.has(task.state)&&!['ready','awaiting_input'].includes(task.state)){
      // Only an actually interrupted live call loses its receipt at this
      // boundary. Terminal/parked usage history is never rewritten on boot.
      settlePendingUsage(task)
      this.touch(task,'interrupted','Host 重启，规划任务不自动重跑',false);changed=true
    }
    return changed
  }
  private dropTask(id:string):void{
    this.tasks.delete(id);this.persistTiming.delete(id);this.nativeQuestions.delete(id);this.inputAvailabilityPending.delete(id)
  }
  private removeBackgroundReceipts(ids:readonly string[]):void{
    if(!ids.some(id=>this.backgroundReceipts.has(id)))return
    // Remove envelopes first: a crash must not resurrect an evicted detail row.
    this.backgroundStore.write([...this.backgroundReceipts.values()].filter(row=>!ids.includes(row.id)))
    for(const id of ids)this.backgroundReceipts.delete(id)
  }
  private canEvict(task:PlanningTask,retained:readonly PlanningTask[]):boolean{
    if(!terminal.has(task.state)||this.active.has(task.id))return false
    const receipt=task.commit&&this.options.retainReceiptBase?this.lookupReceipt(task,task.commit):undefined
    if(receipt&&this.options.retainReceiptBase?.(receipt))return false
    return !retained.some(other=>{
      if(other.id===task.id)return false
      if(other.commandIntake?.linkedTaskId===task.id)return true
      const handoff=other.request.handoff,source=task.moduleProvenance
      // Keep all potential committed sources, including their transitive lineage.
      // No missing-ancestor exception is introduced into integrity validation.
      return handoff?.mode==='module'&&other.request.operation==='revise'&&!!source&&!!task.commit&&
        task.candidate?.id===(other.context?.workflow.id??other.request.targetWorkflowId)&&
        task.candidate!.revision<(other.context?.workflow.revision??other.request.expectedRevision??0)&&
        source.moduleId===handoff.module.moduleId&&source.version===handoff.module.version&&source.instanceKey===handoff.module.instanceKey
    })
  }
  private parseStored(raw:unknown):PlanningTask{
    const task=storedTaskSchema.parse(raw) as PlanningTask
    restampLegacyDigest(task,raw)
    if(task.firstRun&&(!runsOnceAfterSave(task.request)||task.receipt?.kind!=='created'||task.firstRun.requestId!==`trial-first-${task.id}`))
      throw new Error('首次运行与创建回执绑定无效')
    validateStoredAnswers(task)
    if(task.preview&&task.request.source?.kind!=='verified-trial')throw new Error('普通规划预览不可从持久化记录恢复')
    if(task.requestDigest!==planningDigest(task.request))throw new Error('规划请求摘要无效')
    validateStoredIntake(task)
    validateStoredSelection(task)
    if(task.context)this.validateContext(task,task.context)
    if(!task.candidate&&staleHandoffState(task))throw new Error('交接决定与冻结上下文不匹配')
    if(task.compilerSelection?.state==='frozen'&&task.compilerSelection.reason==='typed-partial-handoff'&&task.request.handoff?.mode!=='partial')throw new Error('局部补全模式缺少类型化交接')
    if(task.compilerDraft&&(!task.compilerMode||!task.context||task.compilerDraft.baseDigest!==planningDigest(task.context)))throw new Error('编译草稿与冻结上下文不匹配')
    if(task.templateBinding){
      validateTemplateBinding(task.templateBinding)
      if(task.compilerMode!=='template-fill'||!task.context)throw new Error('模板快照与任务模式不匹配')
    }
    if(task.compilerDraft?.format&&task.compilerDraft.format!==draftFormat(task,task.compilerDraft.purpose))throw new Error('编译草稿格式与阶段不匹配')
    if(task.candidate){
      if(!task.context||task.candidate.id!==task.context.workflow.id||task.candidate.workspaceId!==task.context.workflow.workspaceId||task.candidateDigest!==planningDigest(task.candidate))
        throw new Error('规划候选归属或摘要无效')
      if(task.request.handoff||task.moduleProvenance)try{this.validateHandoffCandidate(task,false)}catch(error){
        markHandoffInvalid(task,error)
        this.touch(task,'blocked','恢复候选与已确定交接不一致，禁止发布',false)
      }
    }else if(task.candidateDigest||task.commit||task.receipt||['ready','publishing','published'].includes(task.state))throw new Error('规划记录缺少候选')
    this.validateProvenance(task)
    this.validateOptimization(task,false)
    if(task.commit&&(task.commit.digest!==task.candidateDigest||task.commit.key!==this.commitKey(task)))throw new Error('规划提交身份无效')
    if(task.receipt&&(!task.commit||task.receipt.key!==task.commit.key||task.receipt.digest!==task.commit.digest||task.receipt.workflowId!==task.candidate?.id))throw new Error('规划回执归属无效')
    if(task.state==='awaiting_input'&&task.output?.outcome!=='needs-input')throw new Error('规划记录缺少待答问题')
    if(task.events.some((event,index)=>index>0&&event.sequence<=task.events[index-1]!.sequence))throw new Error('规划事件序号无效')
    return task
  }
  private resolveModuleSource(task:PlanningTask,ancestors=new Set<string>()):PlanningTask{
    const handoff=task.request.handoff,context=task.context
    if(handoff?.mode!=='module'||!context||task.request.operation!=='revise')throw new CompilerError('MODULE_INSTANCE_UNVERIFIED','模块更新缺少原始交接或冻结基线')
    for(const prior of [...this.tasks.values()].reverse()){
      if(prior.id===task.id||ancestors.has(prior.id)||prior.request.handoff?.mode!=='module'||!prior.moduleProvenance||!prior.candidate||!prior.commit||prior.diagnostics.some(issue=>issue.code==='HANDOFF_CANDIDATE_INVALID'))continue
      const provenance=prior.moduleProvenance
      // Accepted creation/update increments the saved graph revision. Requiring
      // an earlier baseline also makes provenance replay strictly acyclic.
      if(prior.candidate.id!==context.workflow.id||prior.candidate.revision>=context.workflow.revision
        ||provenance.moduleId!==handoff.module.moduleId||provenance.version!==handoff.module.version||provenance.instanceKey!==handoff.module.instanceKey)continue
      try{
        if(provenance.parametersDigest!==businessModuleStoredParametersDigest(context.workflow,provenance,prior.candidate))continue
        if(!this.lookupReceipt(prior,prior.commit))continue
        this.validateHandoffCandidate(prior,true,ancestors)
        return prior
      }catch{/* A malformed source cannot authorize an update; consider older genuine sources. */}
    }
    throw new CompilerError('MODULE_INSTANCE_UNVERIFIED','当前实例缺少匹配的已发布模块来源；不能猜测固定实现或覆盖修改')
  }
  /** Replay decided operations at generation, restoration and publication. */
  private validateHandoffCandidate(task:PlanningTask,resolveSources=true,ancestors=new Set<string>()):void{
    const handoff=task.request.handoff
    if(!handoff){
      if(task.chainState)throw new CompilerError('CHAIN_STATE_CONFLICT','普通规划不能声明顺序片段别名映射')
      if(task.moduleProvenance)throw new CompilerError('MODULE_PROVENANCE_CONFLICT','普通规划不能声明模块实例来源')
      return
    }
    if(!task.candidate)return
    const context=task.context,state=task.handoffState
    if(!context||!state||state.route!==handoff.mode||state.decisionDigest!==planningDigest(handoff)||state.contextDigest!==planningDigest(context))throw new CompilerError('HANDOFF_DECISION_CONFLICT','交接决定与冻结上下文不匹配')
    if(ancestors.has(task.id))throw new CompilerError('MODULE_PROVENANCE_CONFLICT','模块来源不能形成循环')
    const visited=new Set([...ancestors,task.id])
    if(handoff.mode!=='chain'&&task.chainState)throw new CompilerError('CHAIN_STATE_CONFLICT','非顺序片段交接不能声明链映射')
    if(handoff.mode==='module'){
      const provenance=task.moduleProvenance,request=handoff.module
      if(moduleProvenanceConflict(provenance,request,task.candidate))throw new CompilerError('MODULE_PROVENANCE_CONFLICT','模块请求、参数或实例节点来源不匹配')
      if(task.request.operation==='revise'&&!resolveSources)return
      const source=task.request.operation==='revise'?this.resolveModuleSource(task,visited):undefined
      const expected=source
        ?updateBusinessModule(request,context,source.candidate!,source.moduleProvenance! as Parameters<typeof updateBusinessModule>[3])
        :compileBusinessModule(request,context,{},task.request.title)
      if(expected.issues.length||!expected.candidate||semanticDigest(expected.candidate)!==semanticDigest(task.candidate)||sortedProvenanceDigest(expected.provenance)!==sortedProvenanceDigest(provenance!))
        throw new CompilerError('MODULE_PROVENANCE_CONFLICT','模块候选与固定实现、连接或参数槽位不一致')
      return
    }
    if(task.moduleProvenance)throw new CompilerError('MODULE_PROVENANCE_CONFLICT','字段交接不能声明模块来源')
    const expected=compileHandoffChanges(handoff,context)
    if(handoff.mode==='chain'&&(!('chain' in expected)||planningDigest(expected.chain)!==planningDigest(task.chainState)))throw new CompilerError('CHAIN_STATE_CONFLICT','链别名映射与冻结操作及候选不一致')
    if(expected.issues.length||!expected.candidate)throw new CompilerError('HANDOFF_DECISION_CONFLICT','已确定交接无法在当前授权基线上重新编译')
    if(handoff.mode==='partial'){
      const completionIssues=completionCandidateIssues(handoffCompletionPlan(handoff,context,expected.candidate),task.candidate)
      if(completionIssues.length)throw new CompilerError(completionIssues[0]!.code,completionIssues[0]!.message)
      if(handoffCandidateIssues(handoff,expected.candidate,task.candidate).length)throw new CompilerError('HANDOFF_DECISION_CONFLICT','候选修改了已确定决定或未决字段范围之外的内容')
    }else if(semanticDigest(expected.candidate)!==semanticDigest(task.candidate))throw new CompilerError('HANDOFF_DECISION_CONFLICT','候选与已确定字段修改不一致')
  }
  private validateContext(task:PlanningTask,context:PlanningContext):void{
    const visible=task.request.operation==='revise'?workflowVisibleInWorkspace(context.workflow,task.workspaceId):context.workflow.workspaceId===task.workspaceId
    if(context.operation!==task.request.operation||!visible||(task.request.targetWorkflowId!==undefined&&context.workflow.id!==task.request.targetWorkflowId)
      ||(task.request.operation==='revise'&&context.workflow.revision!==task.request.expectedRevision))throw new Error('规划上下文归属或基线版本无效')
    for(const pool of [context.targetNodeIds,context.nodeIds,context.subagentIds,context.environmentIds])if(new Set(pool).size!==pool.length)throw new Error('规划身份池包含重复身份')
    if(JSON.stringify([...context.targetNodeIds].sort())!==JSON.stringify([...(task.request.targetNodeIds??[])].sort()))throw new Error('规划上下文修改范围与请求不符')
    if(!!task.request.source!==!!context.conversation)throw new Error('规划请求与当前对话证据不匹配')
    if(context.conversation)validateEvidenceSource(task,context,validateConversationEvidence(context.conversation))
    if((context.trial||context.trialTask||context.trialReport||context.trialProcedure!==undefined)&&task.request.source?.kind!=='verified-trial')throw new Error('普通规划不能携带试做回执')
    if(context.toolOutputs)validatePlanningToolOutputs(context.toolOutputs,context.tools,context.conversation)
    for(const tool of context.tools)if(tool.operationContract)validateToolOperation(tool.operationContract,tool.id)
  }
  /** Doc 26 §7: the draft is compiled by the same compiler and coverage checks first. One that
   * fails keeps its accepted parts: the author gets it with the issues found, not a blank page. */
  private trialSkeleton(task:PlanningTask,context:PlanningContext){
    const skeleton=buildTrialSkeleton(task.context!,{procedure:task.procedure,title:task.request.title})
    if(!skeleton?.draft)return skeleton
    try{
      const compiler=new TemplateFillingCompiler(context,{binding:task.templateBinding,requiredCoverageIds:requiredCoverageIds(task),...(task.request.title!==undefined?{requestedTitle:task.request.title}:{}),
        validate:(candidate,output)=>this.coverageIssues(task,candidate,output),prefetch:[...new Set(skeleton.draft.forms.map(form=>form.template))]})
      const result=compiler.submit({submission:skeleton.draft})
      if(result.ok)return skeleton
      return withDraftIssues(skeleton,result.feedback.issues.map(({code,message,path})=>({code,message:message.slice(0,600),...(path?{path}:{})})))
    }catch(error){return withDraftIssues(skeleton,[{code:'SKELETON_COMPILE',message:(error instanceof Error?error.message:String(error)).slice(0,600)}])}
  }
  private coverageIssues(task:PlanningTask,candidate:Workflow,output:PlannerOutput):Diagnostic[]{
    const nodes=allNodes(candidate),nodeIds=new Set(nodes.map(node=>node.id)),required=new Set(requiredCoverageIds(task))
    const covered=(id:string)=>output.requirementCoverage.some(item=>item.requirementId===id&&item.nodeIds.length)
    const invalid=(item:PlannerOutput['requirementCoverage'][number])=>!required.has(item.requirementId)||new Set(item.nodeIds).size!==item.nodeIds.length||item.nodeIds.some(id=>!nodeIds.has(id))
    if([...required].some(id=>!covered(id))||output.requirementCoverage.some(invalid))return [{code:'REQUIREMENT_COVERAGE',message:'需求 R1 与每个提炼步骤必须关联候选中的真实节点；覆盖声明不是业务效果验证'}]
    const human=(id:string)=>nodes.some(node=>node.id===id&&node.kind==='human')
    if(task.procedure?.steps.some(step=>step.requiresReview&&!output.requirementCoverage.find(item=>item.requirementId===step.id)!.nodeIds.some(human)))
      return [{code:'REVIEW_REQUIRED',message:'待复核步骤必须映射到图中真实的 human 人工确认节点，保留用户核对环节'}]
    return []
  }
  private makeSourceMap(task:PlanningTask):PlanningSourceMapping[]{
    return task.procedure!.steps.map(step=>({stepId:step.id,nodeIds:task.output!.requirementCoverage.find(item=>item.requirementId===step.id)!.nodeIds,evidenceRefs:step.evidenceRefs}))
  }
  private provenanceDigest(task:PlanningTask):string{
    const context=task.context!
    return planningDigest([context.conversation!.digest,task.procedure,task.sourceMap,...(context.trial?[context.trial,context.trialTask,...(context.trialReport?[context.trialReport]:[])]:[])])
  }
  private validateProvenance(task:PlanningTask):void{
    if(!task.request.source){if(task.procedure||task.sourceMap||task.provenanceDigest||task.distillationAttempts!==undefined||task.distillationSource!==undefined)throw new Error('普通规划不能携带任务提炼来源');return}
    if(task.distillationSource==='submitted-by-trial'){
      if(task.request.source.kind!=='verified-trial'||!task.context?.trialTask||task.context.trialProcedure===undefined||task.distillationAttempts!==0||!task.procedure)throw new Error('试做直接提交方法的来源或计数无效')
      // The same deterministic acceptance, Host exclusions included, must reproduce the stored method.
      const submitted=submittedTrialProcedure(task)
      if(!submitted||planningDigest(submitted.procedure)!==planningDigest(task.procedure))throw new Error('试做直接提交方法未通过恢复校验')
    }
    if(task.context)this.validateContext(task,task.context)
    if(task.procedure){
      if(!task.context?.conversation)throw new Error('提炼结果缺少当前对话证据')
      parseTaskProcedure(task.procedure,task.context.conversation,taskSpecificationRefs(task.context.trialTask),!!task.context.trialTask)
    }
    if(task.candidate){
      if(!task.procedure||!task.output||this.coverageIssues(task,task.candidate,task.output).length
        ||JSON.stringify(task.sourceMap)!==JSON.stringify(this.makeSourceMap(task))||task.provenanceDigest!==this.provenanceDigest(task))throw new Error('候选来源映射或提炼摘要无效')
    }else if(task.sourceMap||task.provenanceDigest)throw new Error('来源映射缺少候选')
  }
  private validateOptimization(task:PlanningTask,validateContracts=true):void{
    if(!task.optimization){if(task.optimizationDigest)throw new Error('优化摘要缺少报告');return}
    if(task.engineVersion!==PLANNING_ENGINE_VERSION||!task.procedure||!task.context?.conversation||!task.candidate||!task.output)throw new Error('优化报告缺少 v0.0.2 任务和来源候选')
    const report=optimizationReportSchema.parse(task.optimization)
    if(task.optimizationDigest!==planningDigest(report)||planningDigest(report.target??null)!==planningDigest(task.request.optimizationTarget??null))throw new Error('优化报告摘要或目标不匹配')
    let selected=report.baseline.candidate
    if((validateContracts&&planningCandidateIssues(selected,task.context).length)||this.coverageIssues(task,selected,task.output).length)throw new Error('优化基线不满足原需求和图契约')
    if(planningDigest(report.baseline.stats)!==planningDigest(optimizationStats(selected))
      ||planningDigest(report.baseline.targetEvaluation)!==planningDigest(evaluateOptimizationTarget(report.baseline.stats,report.target)))throw new Error('优化基线统计无效')
    for(const [index,attempt] of report.attempts.entries()){
      if(attempt.round!==index+1)throw new Error('优化轮次无效')
      if(!attempt.accepted)continue
      if(!attempt.candidate||(validateContracts&&planningCandidateIssues(attempt.candidate,task.context).length)
        ||!selectOptimizationCandidate(selected,attempt.candidate,attempt.replacements,attempt.regression,report.target).accepted)throw new Error('优化记录缺少通过验证的替换')
      const samples=attempt.regressionCases??[],results=attempt.regression?.cases??[]
      if(!samples.length||samples.length!==results.length||samples.some(sample=>!results.some(result=>result.id===sample.id&&result.nodeId===sample.nodeId)))throw new Error('优化记录缺少可重现的样本引用')
      for(const sample of samples){
        const allowed=new Set((task.sourceMap??[]).filter(item=>item.nodeIds.includes(sample.nodeId)).flatMap(item=>item.evidenceRefs))
        const expected=task.context.conversation.records.find(record=>record.id===sample.expected.evidenceId)
        const refs=[sample.expected,...(sample.workflowInputs?[sample.workflowInputs]:[]),...Object.values(sample.upstreamOutputs??{})]
        if(sample.expected.pointer!==''||Object.values(sample.upstreamOutputs??{}).some(ref=>ref.pointer!==''))throw new Error('优化样本必须保留完整结果根引用')
        const replayable=(ref:{evidenceId:string})=>task.context!.conversation!.records.some(record=>
          record.id===ref.evidenceId&&record.status==='reported-success'&&!record.truncated&&(record.kind==='tool-call'||record.kind==='tool-result'))
        if(!allowed.has(sample.expected.evidenceId)||expected?.kind!=='tool-result'||refs.some(ref=>!replayable(ref)))throw new Error('优化样本引用与冻结方法证据不一致')
      }
      selected=attempt.candidate
    }
    if(planningDigest(selected)!==task.candidateDigest||planningDigest(report.selected.stats)!==planningDigest(optimizationStats(selected))
      ||planningDigest(report.selected.targetEvaluation)!==planningDigest(evaluateOptimizationTarget(report.selected.stats,report.target))
      ||report.selection!==(report.attempts.some(item=>item.accepted)?'optimized':'baseline'))throw new Error('优化选择结果与当前候选不一致')
  }
  private commitKey(task:PlanningTask):string{return planningDigest([task.id,task.candidateDigest,task.request.operation,...(task.request.source?[task.provenanceDigest]:[])])}
  private touch(task:PlanningTask,state:State,text:string,persist=true):void{
    task.state=state;task.revision++;task.updatedAt=new Date().toISOString()
    const sequence=(task.events.at(-1)?.sequence??0)+1
    task.events=[...task.events,{sequence,state,at:task.updatedAt,message:text.slice(0,1200)}].slice(-120)
    // Hot-path events journal only this task's row. A resting state compacts
    // the snapshot, so a parked or finished task is fully in tasks.json.
    if(persist&&(!task.preview||task.request.source?.kind==='verified-trial')){
      const started=performance.now()
      try{if(terminal.has(state)||state==='ready'||state==='awaiting_input')this.store.write([...this.tasks.values()],task.id);else this.store.append(task,()=>[...this.tasks.values()])}
      finally{
        const timing=this.persistTiming.get(task.id)??{count:0,durationMs:0}
        timing.count++;timing.durationMs+=performance.now()-started;this.persistTiming.set(task.id,timing)
      }
    }
    this.options.onUpdate?.(structuredClone(task))
  }
  private metric(task:PlanningTask,metric:PlanningMetric):void{task.compilerMetrics=[...(task.compilerMetrics??[]),metric].slice(-PLANNING_METRIC_LIMIT)}
  /** Emit accumulated journal time; the row carrying it is persisted by the next event. */
  private flushPersistTiming(task:PlanningTask):void{
    const timing=this.persistTiming.get(task.id)
    this.persistTiming.delete(task.id)
    // A task still awaiting its compiler selection carries no derived metrics.
    if(!timing?.count||task.compilerSelection?.state==='pending')return
    this.metric(task,{phase:'span:persist',at:Date.now(),durationMs:timing.durationMs,count:timing.count,status:'success'})
  }
  /** Independent wall-clock span for a Host stage; timings only, never values. */
  private async span<T>(task:PlanningTask,phase:string,signal:AbortSignal,run:()=>T|Promise<T>):Promise<T>{
    const started=performance.now()
    let status:'success'|'failed'|'cancelled'='success'
    try{return await run()}
    catch(error){status=signal.aborted?'cancelled':'failed';throw error}
    finally{this.metric(task,{phase:'span:'+phase,at:Date.now(),durationMs:performance.now()-started,status});this.flushPersistTiming(task)}
  }
  private owned(id:string,caller:PlanningCaller):PlanningTask{
    const task=this.tasks.get(id)
    if(!task||task.sessionId!==caller.sessionId||task.workspaceId!==caller.workspaceId)throw new Error('规划任务不存在、已清理或不属于当前主对话')
    this.options.authorize(task,caller,false);return task
  }
  get(id:string,caller:PlanningCaller):PlanningTask{return structuredClone(this.owned(id,caller))}
  /** T37.7: revise tasks one chat started on one workflow revision that are still running or have published. */
  revisions(sessionId:string,workflowId:string,revision:number):PlanningTask[]{
    return [...this.tasks.values()].filter(task=>task.sessionId===sessionId&&!task.preview&&task.request.operation==='revise'&&task.request.targetWorkflowId===workflowId&&task.request.expectedRevision===revision&&(task.state==='published'||!terminal.has(task.state))).map(task=>structuredClone(task))
  }
  isActive(id:string,caller:PlanningCaller):boolean{this.owned(id,caller);return this.active.has(id)}
  /** Called by the Host only with a task obtained through an authorized entry. */
  inputState(task:PlanningTask):PlanningInputState|undefined{
    const current=this.tasks.get(task.id)
    if(!current||current.workspaceId!==task.workspaceId||current.sessionId!==task.sessionId)throw new Error('规划问题归属不一致')
    if(current.state!=='awaiting_input')return undefined
    return planningInputState(current.revision,this.nativeQuestions.get(current.id)===current.revision,this.active.has(current.id))
  }
  private finishInputAvailability(task:PlanningTask):void{
    if(!this.inputAvailabilityPending.delete(task.id))return
    this.nativeQuestions.delete(task.id)
    if(task.state!=='awaiting_input'||this.active.has(task.id))return
    // The manual route becomes usable only after activation cleanup. A new
    // journal revision makes this routing transition observable to wait/get.
    this.touch(task,'awaiting_input','原生问答未接管当前批次；手动回答入口已就绪，请读取当前 revision')
  }
  findRequest(requestId:string,caller:PlanningCaller):PlanningTask|undefined{
    const task=[...this.tasks.values()].find(item=>item.request.requestId===requestId&&item.sessionId===caller.sessionId&&item.workspaceId===caller.workspaceId)
    return task?this.get(task.id,caller):undefined
  }
  private assertQueueCapacity(workspaceId:string):void{
    if([...this.active.keys()].filter(id=>this.tasks.get(id)?.workspaceId===workspaceId).length>=6)throw new Error('PLANNER_BUSY：该工作区已有一个运行和五个排队规划任务')
  }
  async start(value:unknown,caller:PlanningCaller,delivery?:{background:true;commandIntake?:CommandIntake}):Promise<PlanningTask>{
    this.lifetime.signal.throwIfAborted();caller.signal.throwIfAborted()
    const request=parsePlanningRequest(value),digest=planningDigest(request)
    const prior=[...this.tasks.values()].find(task=>task.workspaceId===caller.workspaceId&&task.sessionId===caller.sessionId&&task.request.requestId===request.requestId)
    if(prior){
      this.owned(prior.id,caller)
      if(prior.requestDigest!==digest)throw new Error('REQUEST_ID_CONFLICT：相同请求身份对应不同内容')
      return structuredClone(delivery?.background||prior.delivery?prior:await (this.active.get(prior.id)?.done??prior))
    }
    this.assertQueueCapacity(caller.workspaceId)
    const requestedMode=planningCompilerModeSchema.parse(this.options.compilerMode??'legacy')
    const at=new Date().toISOString(),task:PlanningTask={
      engineVersion:PLANNING_ENGINE_VERSION,id:randomUUID(),request,requestDigest:digest,workspaceId:caller.workspaceId,sessionId:caller.sessionId,preview:!!request.preview,
      state:'collecting',revision:1,createdAt:at,updatedAt:at,diagnostics:[],
      ...freshCounters(),
      compilerSelection:{protocolVersion:1,state:'pending',requestedMode},
      ...(request.source?{distillationAttempts:0}:{}),
      ...(delivery?.commandIntake?{commandIntake:commandIntakeSchema.parse(delivery.commandIntake)}:{}),
    }
    if(!request.handoff||request.handoff.mode==='partial')task.designChecks={version:1,checksPassed:[]}
    this.options.authorize(task,caller,!task.preview)
    if(request.operation==='create'&&this.options.workspaceRevisions)task.workspaceSnapshot={accepted:structuredClone(this.options.workspaceRevisions(caller))}
    if(delivery?.background&&!this.options.backgroundRuntime)throw new Error('Host 未提供受管理的后台任务生命周期')
    this.tasks.set(task.id,task)
    try{if(this.tasks.size>this.store.maxRows)this.store.write([...this.tasks.values()],task.id)}catch(error){this.tasks.delete(task.id);throw error}
    return delivery?.background?this.launchBackground(task,caller):this.launch(task,caller)
  }
  async answer(id:string,revision:number,answers:unknown,caller:PlanningCaller):Promise<PlanningTask>{
    this.lifetime.signal.throwIfAborted();caller.signal.throwIfAborted()
    const task=this.owned(id,caller)
    if(this.retireLegacy(task))return structuredClone(task)
    if(task.state!=='awaiting_input')throw new PlanningAnswerError('PLANNING_NOT_AWAITING_INPUT','任务不在待答状态；不要重试回答或猜 revision，请读取当前状态','read-latest-task')
    const input=this.inputState(task)!
    if(input.nativeQuestionPending)
      throw new PlanningAnswerError('PLANNING_NATIVE_QUESTION_PENDING','Host 正在处理本批原生真人问题；请回答原 Host 问题，不要复制提问、重试 plan_answer 或猜 revision',input.nextAction,input)
    if(this.active.has(id))throw new PlanningAnswerError('PLANNING_ANSWER_ACTIVATION_ACTIVE','当前 activation 尚未清理，手动回答不可用；等待同 task 状态更新，不重试回答或猜 revision',input.nextAction,input)
    if(task.revision!==revision)throw new PlanningAnswerError('PLANNING_QUESTION_REVISION_CHANGED','问题批次已变化，请读取最新规划状态并核对问题；不要猜 revision','read-latest-task',input)
    assertAnswerBatch(task,answers)
    this.assertQueueCapacity(caller.workspaceId)
    const previous={answers:structuredClone(task.answers),answeredQuestions:structuredClone(task.answeredQuestions),state:task.state,revision:task.revision,updatedAt:task.updatedAt,events:structuredClone(task.events)}
    try{
      this.recordHumanAnswers(task,revision,answers,'manual')
      // The queued journal write below atomically includes these answers. Do
      // not persist an intermediate collecting state without an owned worker.
      this.touch(task,'collecting','已收到补充信息',!task.delivery)
      return task.delivery?this.launchBackground(task,caller,true):this.launch(task,caller)
    }catch(error){
      if(!task.delivery)throw error
      Object.assign(task,previous)
      task.diagnostics=[...task.diagnostics,{code:'PLANNING_RESUME_ACCEPTANCE_FAILED',message:'续接受理失败，回答尚未应用，可在原问题批次重试：'+message(error).slice(0,1600)}].slice(-1000)
      try{this.touch(task,'awaiting_input','续接受理失败，保留原问题与回答空位')}catch{
        // The old durable journal is still a safe recovery point when storage
        // remains unavailable. Never dispatch work to compensate for IO errors.
        try{this.options.onUpdate?.(structuredClone(task))}catch{}
      }
      return structuredClone(task)
    }
  }
  private launchBackground(task:PlanningTask,caller:PlanningCaller,resuming=false):PlanningTask{
    const runtime=this.options.backgroundRuntime
    if(!runtime)throw new Error('Host 未提供受管理的后台任务生命周期')
    const acceptedAt=task.delivery?.acceptedAt??new Date().toISOString()
    const envelope=planningBackgroundEnvelopeSchema.parse({
      protocolVersion:1,taskId:task.id,requestId:task.request.requestId,requestDigest:task.requestDigest,
      sessionId:task.sessionId,workspaceId:task.workspaceId,acceptedAt,state:'accepted',
    })
    const previousReceipt=this.backgroundReceipts.get(task.id),previousDelivery=task.delivery
    let durable=false
    try{
      task.delivery={protocolVersion:1,mode:'background',acceptedAt}
      this.backgroundReceipts.set(task.id,{...envelope,id:task.id,preview:false})
      // Durable identity and queued state both precede dispatch.
      this.backgroundStore.append(this.backgroundReceipts.get(task.id)!,()=>[...this.backgroundReceipts.values()]);durable=true
      this.touch(task,'queued','规划已受理，后台执行；受理不代表候选生成或发布成功')
      // A synchronous Host observer may cancel immediately on admission.
      if(task.state!=='queued')return structuredClone(task)
      const operation=registerPlanningBackground({active:this.active,taskId:task.id,owner:caller,callSignal:caller.signal,hostSignal:this.lifetime.signal,runtime,deadlineMs:TASK_DEADLINE_MS,
        run:async(signal,externalSignal)=>this.generate(task,{...caller,signal},externalSignal),
        onFailure:(error,signal,externalSignal)=>this.fail(task,error,externalSignal.aborted?externalSignal:signal),
      })
      // registerPlanningBackground releases the active Map before done settles.
      // This observer cannot launch work and contains journal/observer failures.
      void operation.done.then(()=>this.finishInputAvailability(task)).catch(error=>{
        if(task.state==='awaiting_input'){
          task.diagnostics=[...task.diagnostics,{code:'PLANNING_INPUT_ROUTE_UPDATE_FAILED',message:'手动问题交接状态未能完整记录，请读取当前状态：'+message(error).slice(0,1600)}].slice(-1000)
          try{this.touch(task,'blocked','问题交接状态记录失败，未启动新的规划')}catch{try{this.options.onUpdate?.(structuredClone(task))}catch{}}
        }
      })
      return structuredClone(task)
    }catch(error){
      if(!durable){
        // A storage adapter may fail after committing. Check the exact receipt
        // before deciding that retrying admission is safe. Unknown stays closed.
        try{durable=this.backgroundReceiptCommitted(task)}catch{durable=true}
      }
      if(!durable){
        if(previousReceipt)this.backgroundReceipts.set(task.id,previousReceipt);else this.backgroundReceipts.delete(task.id)
      }
      if(resuming){task.delivery=previousDelivery;throw error}
      if(!durable){
        this.tasks.delete(task.id);task.delivery=previousDelivery
        throw error
      }
      task.diagnostics=[...task.diagnostics,{code:'PLANNING_ACCEPTANCE_FAILED',message:'受理日志或后台登记失败，未启动生成；保留任务身份且不自动重跑：'+message(error).slice(0,1600)}].slice(-1000)
      try{this.touch(task,'interrupted','受理未完成，后台工作未启动，不自动重跑')}catch{try{this.options.onUpdate?.(structuredClone(task))}catch{}}
      return structuredClone(task)
    }
  }
  private backgroundReceiptCommitted(task:PlanningTask):boolean{
    return this.backgroundStore.read(value=>{
      const row=z.object({id:identity,preview:z.literal(false)}).passthrough().parse(value),{id,preview,...rest}=row
      const accepted=planningBackgroundEnvelopeSchema.parse(rest)
      return {...accepted,id,preview}
    }).some(row=>row.id===task.id&&row.taskId===task.id&&row.requestDigest===task.requestDigest)
  }
  private launch(task:PlanningTask,caller:PlanningCaller):Promise<PlanningTask>{
    const controller=new AbortController(),deadline=new AbortController(),signal=AbortSignal.any([caller.signal,controller.signal,this.lifetime.signal,deadline.signal])
    const timer=setTimeout(()=>deadline.abort(new PlanningAgentError('PLANNING_DEADLINE_EXCEEDED','规划达到 20 分钟总时长保护，已停止，请缩小需求或检查模型服务后重试')),TASK_DEADLINE_MS)
    timer.unref?.()
    const externalSignal=AbortSignal.any([caller.signal,controller.signal,this.lifetime.signal])
    const done=Promise.resolve().then(()=>this.generate(task,{...caller,signal},externalSignal)).finally(()=>{clearTimeout(timer);this.active.delete(task.id);this.finishInputAvailability(task)})
    this.active.set(task.id,{controller,done});return done.then(()=>structuredClone(task))
  }
  private optimizationIssues(task:PlanningTask,candidate:Workflow,output:ReturnType<typeof compileOptimizationEdits>['output']):Diagnostic[]{
    const issues=[...this.coverageIssues(task,candidate,task.output!),...optimizationReplacementIssues(task.candidate!,candidate,output.replacements)]
    for(const sample of output.regressionCases){
      const allowed=new Set((task.sourceMap??[]).filter(item=>item.nodeIds.includes(sample.nodeId)).flatMap(item=>item.evidenceRefs))
      if(!allowed.has(sample.expected.evidenceId))issues.push({code:'REGRESSION_PROVENANCE_MISMATCH',nodeId:sample.nodeId,message:'回归期望必须来自该节点对应方法步骤的证据，不能借用无关任务结果'})
    }
    return issues
  }
  private async optimize(task:PlanningTask,caller:PlanningCaller):Promise<void>{
    if(task.engineVersion!==PLANNING_ENGINE_VERSION||!task.procedure||!task.context?.conversation||!task.candidate)return
    const baseline=structuredClone(task.candidate),stats=optimizationStats(baseline),target=task.request.optimizationTarget
    const report=baselineOptimizationReport(baseline,stats,target)
    task.optimization=report
    try{
      if(!stats.modelNodes){report.stopReason='already_deterministic';return}
      // Desktop r53 B: 79 s of optimizer thinking to conclude an Agent node is kept by rule.
      if(!baseline.nodes.some(optimizableNode)){report.stopReason='no_replaceable_node';return}
      if(!task.context.conversation.records.some(record=>record.kind==='tool-result'&&record.status==='reported-success'&&!record.truncated)){
        report.stopReason='missing_replay_evidence';return
      }
      let optimizerSubmissions=0
      for(let round=1;round<=2;round++){
        if(optimizerSubmissions>=2){report.stopReason='round_limit';break}
        const attempt:OptimizationAttempt={round,replacements:[],summary:'',accepted:false,diagnostics:[]}
        try{
          caller.signal.throwIfAborted();this.options.authorize(task,caller,false)
          const compiler=this.optimizationCompiler(task,attempt,2-optimizerSubmissions,()=>{optimizerSubmissions++})
          const raw=await this.invoke(task,caller,'optimize',optimizationPrompt(task),compiler)
          const compiled:ReturnType<typeof compileOptimizationEdits>=raw as ReturnType<typeof compileOptimizationEdits>
          const output=compiled.output
          attempt.summary=output.summary;attempt.replacements=output.replacements;attempt.regressionCases=output.regressionCases
          if(output.outcome==='unchanged'){report.attempts.push(attempt);report.stopReason='no_supported_replacement';break}
          const candidate=compiled.candidate!
          attempt.candidate=candidate;attempt.stats=optimizationStats(candidate);attempt.targetEvaluation=evaluateOptimizationTarget(attempt.stats,target)
          attempt.diagnostics=[...compiled.issues,...this.optimizationIssues(task,candidate,output)]
          if(!attempt.diagnostics.length){
            this.touch(task,'regressing',`第 ${round} 轮：使用 Graphon 回放证据样本，不调用模型或业务工具`)
            const evidence=task.context.conversation
            attempt.regression=await this.span(task,'graphon-regression',caller.signal,()=>runPlanningRegression({
              baseline,workflow:candidate,replacementNodeIds:replacementNodeIds(report,output.replacements),evidence,cases:output.regressionCases,
              signal:caller.signal,runtimeDirectory:graphonRuntimeDirectory(this.options.directory),
            }))
            caller.signal.throwIfAborted();this.options.authorize(task,caller,false)
            const selection=selectOptimizationCandidate(task.candidate!,candidate,output.replacements,attempt.regression,target)
            attempt.diagnostics=selection.diagnostics
            if(selection.accepted){
              const readiness=await this.span(task,'optimization-readiness',caller.signal,()=>this.options.readiness(candidate,caller))
              caller.signal.throwIfAborted();this.options.authorize(task,caller,false)
              // A cheaper graph must not introduce new configuration blockers.
              const existing=new Set(task.readiness?.issues.map(readinessKey)??[])
              if(readiness.issues.some(issue=>!existing.has(readinessKey(issue))))attempt.diagnostics.push({code:'OPTIMIZATION_READINESS_REGRESSION',message:'替换引入新的运行依赖缺口，保留原候选'})
              else this.acceptOptimization(task,report,attempt,candidate,readiness,selection,output.summary)
            }
          }
          attempt.diagnostics=attempt.diagnostics.slice(0,1000)
          report.attempts.push(attempt)
          if(attempt.accepted&&report.selected.targetEvaluation.status==='within_target'){report.stopReason='target_met';break}
          if(attempt.accepted&&!report.selected.stats.modelNodes){report.stopReason='already_deterministic';break}
          if(round===2)report.stopReason='round_limit'
        }catch(error){
          attempt.diagnostics=attempt.diagnostics.slice(0,999)
          attempt.diagnostics.push({code:code(error)||'OPTIMIZATION_INCOMPLETE',message:message(error).slice(0,2000)})
          if(!report.attempts.includes(attempt))report.attempts.push(attempt)
          report.stopReason='optimization_interrupted_candidate_retained'
          if(isCleanupFailure(error)||isPermissionFailure(error)||isConflict(error))throw error
          if(caller.signal.aborted){
            if(code(caller.signal.reason)!=='PLANNING_DEADLINE_EXCEEDED')throw error
            report.stopReason='optimization_deadline_candidate_retained';break
          }
          // Invalid proposals get one bounded correction. Infrastructure/resource
          // failures keep the already valid candidate instead of failing planning.
          if(error instanceof CompilerError&&error.code==='COMPILER_OBSERVER_FAILED')throw error
          if(error instanceof PlanningAgentError||error instanceof CompilerError&&error.fatal||round===2)break
        }
      }
    }finally{
      report.stopReason||='round_limit'
      for(const attempt of report.attempts)attempt.diagnostics=attempt.diagnostics.slice(0,1000).map(item=>({...item,code:item.code.slice(0,160),message:item.message.slice(0,4000)}))
      task.optimization=optimizationReportSchema.parse(report)
      task.optimizationDigest=planningDigest(task.optimization)
    }
  }
  private optimizationCompiler(task:PlanningTask,attempt:OptimizationAttempt,maxSubmissions:number,submitted:()=>void){
    const refs=new Map([...planningNodeRefs(task.candidate!)].map(([id,ref])=>[ref,id]))
    return createOptimizationCompiler(task.context!,task.candidate!,{maxSubmissions,onSubmission:snapshot=>{
      submitted();this.observeCompiler(task,'optimize')(snapshot)
      const document=snapshot.document as {summary?:unknown;replacements?:{node?:unknown;reason?:unknown}[]}|undefined
      if(typeof document?.summary==='string')attempt.summary=document.summary.slice(0,10_000)
      if(Array.isArray(document?.replacements))attempt.replacements=document.replacements
        .filter(item=>typeof item?.node==='string'&&refs.has(item.node)&&typeof item.reason==='string').slice(0,500)
        .map(item=>({nodeId:refs.get(item.node as string)!,reason:(item.reason as string).slice(0,4000)}))
    },validate:result=>{const issues=result.candidate?this.optimizationIssues(task,result.candidate,result.output):[];attempt.diagnostics=[...result.issues,...issues];return issues}})
  }
  private acceptOptimization(task:PlanningTask,report:PlanningOptimizationReport,attempt:OptimizationAttempt,candidate:Workflow,readiness:WorkflowReadiness,
    selection:ReturnType<typeof selectOptimizationCandidate>,summary:string):void{
    attempt.accepted=true;task.candidate=parseWorkflow(candidate);task.candidateDigest=planningDigest(task.candidate);task.readiness=readiness
    task.output={...task.output!,graphJson:JSON.stringify(projectWorkflow(candidate)),summary:`${task.output!.summary}\n${summary}`.slice(0,10_000)}
    report.selected={stats:selection.stats,targetEvaluation:selection.targetEvaluation};report.selection='optimized'
  }
  private observeCompiler(task:PlanningTask,purpose:'author'|'distill'|'optimize'):NonNullable<ConstructorParameters<typeof RepairSession>[1]['onSubmission']>{
    return snapshot=>{
      if(purpose==='author'&&(snapshot.document as any)?.mode!=='needs-input')task.candidateAttempts++
      if(purpose==='distill'&&(snapshot.document as any)?.mode!=='needs-input')task.distillationAttempts=(task.distillationAttempts??0)+1
      const issues=snapshot.issues.map(({code,message,nodeId,path})=>({code,message:message.slice(0,4000),...(nodeId?{nodeId}:{}),...(path?{path}:{})}))
      task.compilerDraft={
        purpose,format:draftFormat(task,purpose),baseDigest:planningDigest(task.context),revision:snapshot.revision,
        document:compilerJson(snapshot.document),issues,...(snapshot.checkpoint?{checkpoint:snapshot.checkpoint}:{}),
      }
      this.metric(task,{phase:purpose+(snapshot.patch?':patch':':submit'),at:Date.now(),durationMs:snapshot.elapsedMs,bytes:Buffer.byteLength(JSON.stringify(snapshot.document))})
      task.diagnostics=issues
      this.touch(task,issues.length?'repairing':'validating',submissionMessage(issues,snapshot))
    }
  }
  private async invoke(task:PlanningTask,caller:PlanningCaller,purpose:'distill'|'author'|'optimize',prompt:string,compiler:SubmissionCompiler,authorContext=task.context!):Promise<unknown>{
    if(task.childAttempts>=MAX_CHILDREN)throw new PlanningAgentError('PLANNING_CHILD_LIMIT',`规划已达到 ${MAX_CHILDREN} 个子任务的循环保护，请收窄需求后重新规划`)
    if(task.steps>=MAX_STEPS)throw new PlanningAgentError('PLANNING_STEP_LIMIT',`规划已达到 ${MAX_STEPS} 步的循环保护，请收窄需求后重新规划`)
    this.touch(task,'queued','等待模型并发空位')
    const releasePlanning=await this.planningAdmission.acquire(task.id,1,caller.signal,task.workspaceId)
    let release:(()=>void)|undefined,receiptsSeen=false
    const reservations:{key?:string;settled:boolean}[]=[],seenReceipts=new Set<number>()
    const addKnown=(usage:{totalTokens:number}|undefined):boolean=>{
      if(!usage||!Number.isSafeInteger(usage.totalTokens)||usage.totalTokens<0||!Number.isSafeInteger(task.spentTokens+usage.totalTokens))return false
      task.spentTokens+=usage.totalTokens;return true
    }
    try{
      release=await this.options.admission.acquire(task.id,1,caller.signal,task.workspaceId)
      caller.signal.throwIfAborted()
      this.options.authorize(task,caller,!task.preview)
      task.childAttempts++
      const repairing=purpose==='distill'?(task.distillationAttempts??0)>0:task.candidateAttempts>0
      this.touch(task,invokeState(purpose,repairing),invokeMessage(purpose,repairing))
      const authorizeRead=()=>{caller.signal.throwIfAborted();this.options.authorize(task,caller,!task.preview)}
      const graphAccess=this.authorGraphAccess(task,purpose,compiler,authorContext,authorizeRead)
      const templateCompiler=compiler instanceof CommandIntakeCompiler?compiler.author:compiler
      const result=await this.options.driver.generate({
        purpose,parent:caller.parent,model:task.context!.model,effort:task.context!.effort,prompt,signal:caller.signal,tools:task.context!.tools,
        maxSteps:Math.min(MAX_CHILD_STEPS,MAX_STEPS-task.steps),
        beforeSubmission:authorizeRead,
        // A first clarification can resume without a draft: its Host prompt is
        // still the full initial payload. The agent separately verifies exact
        // contracts; an actual draft-repair delta must never get this marker.
        ...(compiler instanceof TemplateFillingCompiler&&!compiler.continuation()?.hasDraft?{promptContractSource:'host-template-initial-v1' as const}:{}),
        compiler,...(templateCompiler instanceof TemplateFillingCompiler?{templateQuery:(ids:readonly string[])=>queryPlanningTemplates(templateCompiler,ids)}:{}),
        ...graphAccess,
        onMetric:metric=>{this.metric(task,metric)},
        beforeStep:(inputBytes,_legacyOutputLimit,identity)=>{
          caller.signal.throwIfAborted();this.options.authorize(task,caller,!task.preview)
          if(task.steps>=MAX_STEPS)throw new PlanningAgentError('PLANNING_STEP_LIMIT',`规划已达到 ${MAX_STEPS} 步的循环保护`)
          if(!Number.isSafeInteger(inputBytes)||inputBytes<0||!Number.isSafeInteger(task.observedInputBytes+inputBytes)||!Number.isSafeInteger(task.pendingUsageCalls+1))
            throw new PlanningAgentError('PLANNING_ACCOUNTING_INVALID','规划输入体积或调用次数记录无效')
          task.steps++;task.observedInputBytes+=inputBytes;task.pendingUsageCalls++
          reservations.push({...(identity?{key:JSON.stringify([identity.turn,identity.step])}:{}),settled:false})
          this.touch(task,task.state,'模型步骤已开始；记录输入字节及待到达的用量回执')
        },
        onUsage:receipt=>{
          if(!Number.isSafeInteger(receipt.sequence)||receipt.sequence<0||!Number.isSafeInteger(receipt.turn)||receipt.turn<1
            ||!Number.isSafeInteger(receipt.step)||receipt.step<1)throw new Error('规划用量回执身份无效')
          if(seenReceipts.has(receipt.sequence))return
          seenReceipts.add(receipt.sequence);receiptsSeen=true
          const key=JSON.stringify([receipt.turn,receipt.step]),entry=reservations.find(item=>item.key===key)??reservations.find(item=>item.key===undefined&&!item.settled)
          if(!entry)throw new Error('规划用量回执没有对应的已开始调用')
          if(!entry.settled){task.pendingUsageCalls--;entry.settled=true}
          // A durable receipt settles this call even when the child later fails
          // or is cancelled. Missing usage is a call count, never invented Tokens.
          // Different attempt seq values are distinct calls, never deduped by step.
          if(!addKnown(receipt.usage))countUnknownUsageCall(task)
          this.touch(task,task.state,receipt.usage?'记录本轮已报告 Token 用量':'本轮用量未知，保留未知调用标记')
        },
        onTask:childId=>{task.childId=childId;this.touch(task,task.state,'规划子任务已启动')}})
      // Legacy/offline drivers may only report a complete aggregate result.
      // Native per-call receipts already own accounting and must not be added twice.
      if(!receiptsSeen&&addKnown(result.usage)){for(const entry of reservations)if(!entry.settled){entry.settled=true;task.pendingUsageCalls--}}
      caller.signal.throwIfAborted()
      return result.output
    }finally{
      try{for(const entry of reservations)if(!entry.settled){entry.settled=true;task.pendingUsageCalls--;countUnknownUsageCall(task)}}
      finally{release?.();releasePlanning()}
    }
  }
  private authorGraphAccess(task:PlanningTask,purpose:'distill'|'author'|'optimize',compiler:SubmissionCompiler,authorContext:PlanningContext,authorizeRead:()=>void){
    const graphContext=compiler&&purpose==='author'&&authorContext.operation==='revise'?(compiler instanceof TemplateFillingCompiler?templateGraphContext(authorContext):authoringGraphContext(authorContext)):undefined
    const reader=graphContext?new PlanningContextReader(authorContext,{scopeIdentity:JSON.stringify([task.workspaceId,task.sessionId,task.id,'author']),assertCurrent:authorizeRead}):undefined
    const graphContextRead=reader&&graphContext?(keys:readonly string[])=>{
      const view=reader.read({keys,selection:authorContext.contextSelection})
      if(!(compiler instanceof TemplateFillingCompiler))return view
      return {...view,nodes:view.nodes.map(({kind,config,...node})=>({
        ...node,template:(graphContext.find(row=>row.key===node.key) as {template:string}).template,
        values:Object.fromEntries(Object.entries(config as Record<string,unknown>).filter(([key])=>kind!=='tool'||key!=='toolId')),
      }))}
    }:undefined
    return graphContext&&graphContextRead?{graphContext,graphContextRead}:{}
  }
  private awaitInput(task:PlanningTask,output:PlannerOutput):void{
    task.output=output
    if(++task.questionRounds>2)throw new PlanningAgentError('PLANNING_QUESTION_LIMIT','澄清轮次达到上限，请完善需求后另起规划任务')
    this.inputAvailabilityPending.add(task.id)
    if(task.delivery&&this.options.askQuestions)this.nativeQuestions.set(task.id,task.revision+1)
    this.touch(task,'awaiting_input','需要用户补充设计信息')
  }
  private async receiveBackgroundAnswers(task:PlanningTask,caller:PlanningCaller):Promise<boolean>{
    if(!task.delivery||!this.options.askQuestions)return false
    const revision=task.revision,questions=task.output?.questions??[]
    let answers:{questionId:string;answer:string}[]|undefined
    try{answers=await this.options.askQuestions(structuredClone(task),caller)}
    finally{this.nativeQuestions.delete(task.id)}
    caller.signal.throwIfAborted();this.options.authorize(task,caller,!task.preview)
    if(task.state!=='awaiting_input'||task.revision!==revision)throw new Error('问题批次已变化，未应用过期回答')
    if(answers===undefined)return false
    const parsed=z.array(z.object({questionId:identity,answer:z.string().trim().min(1).max(10_000)}).strict()).max(3).parse(answers)
    if(parsed.length!==questions.length||new Set(parsed.map(item=>item.questionId)).size!==parsed.length||parsed.some(item=>!questions.some(question=>question.id===item.questionId)))throw new Error('真人回答与当前问题批次不匹配')
    this.recordHumanAnswers(task,revision,parsed,'native');this.touch(task,'collecting','已收到真人回答，继续同一任务的未决部分')
    return true
  }
  private recordHumanAnswers(task:PlanningTask,revision:number,answers:{questionId:string;answer:string}[],source:'native'|'manual'):void{
    // Only call after ownership, liveness, revision and complete batch validation.
    // The model's question text is data: it grants no tools, scope or permission.
    const questions=(task.output?.questions??[]).map(question=>({...structuredClone(question),answer:answers.find(item=>item.questionId===question.id)!.answer}))
    task.answeredQuestions=[...(task.answeredQuestions??[]),{taskId:task.id,revision,source,questions}]
    task.answers.push(...structuredClone(answers))
  }
  /**
   * Procedure compiler bound to this task's Host checkpoint scope. The shared
   * factory owns the wire schema and validators; the Host only adds the same
   * resume binding the author stage uses, so a clarification keeps the failed
   * draft and its repair slots instead of reopening a full rewrite.
   */
  private procedureCompiler(task:PlanningTask,resume?:HostRepairCheckpoint,seed?:{active:boolean}):ReturnType<typeof createProcedureCompiler>{
    // Clarifications never counted as distillation attempts; reserve their
    // slots so a clarified draft can still be repaired, while the guard below
    // keeps actual procedure submissions within the stored two-attempt bound.
    const context=task.context!,maxSubmissions=resume?resume.maxSubmissions:Math.max(1,2-(task.distillationAttempts??0)+2-task.questionRounds)+(seed?.active?1:0)
    const observe=this.observeCompiler(task,'distill')
    const compiler=createProcedureCompiler(context.conversation!,context.trialTask,{
      maxSubmissions,onSubmission:snapshot=>{
        const attempts=task.distillationAttempts;observe(snapshot)
        if(seed?.active)task.distillationAttempts=attempts
      },
      resumeScope:JSON.stringify([task.workspaceId,task.sessionId,task.id,'distill']),
      contractDigest:planningDigest({protocolVersion:1,frontend:'procedure-v1',conversation:context.conversation,trialTask:context.trialTask??null}),
      ...(resume?{resume}:{}),
    })
    // Only clarifications may use the reserved slots: repairUnique also routes
    // through this instance method, so procedure submissions stay within two.
    const submit=compiler.submit.bind(compiler)
    compiler.submit=value=>{
      const wire=value&&typeof value==='object'&&'submission'in value?value.submission:undefined
      const mode=wire&&typeof wire==='object'&&'mode'in wire?wire.mode:undefined
      if(mode!=='needs-input'&&(task.distillationAttempts??0)>=2)throw new CompilerError('PLANNING_REPAIR_LIMIT','任务提炼已达两次实际提交上限，已保留草稿与诊断',undefined,true)
      return submit(value)
    }
    return compiler
  }
  private async distill(task:PlanningTask,caller:PlanningCaller):Promise<boolean>{
    const trialMethod=task.request.source?.kind==='verified-trial'&&task.context?.trialProcedure!==undefined&&task.distillationSource===undefined
    if(trialMethod){
      caller.signal.throwIfAborted();this.options.authorize(task,caller,!task.preview)
      const submitted=submittedTrialProcedure(task)
      if(submitted){
        task.procedure=submitted.procedure;task.distillationSource='submitted-by-trial'
        task.output=undefined;task.diagnostics=[]
        this.touch(task,'collecting',submitted.hostExcluded.length
          ?`试做提交的方法漏归 ${submitted.hostExcluded.join('、')}（写入前查看目标文件），Host 归入排除后通过同一编译器校验，直接生成节点图`
          :'试做提交的方法已通过同一编译器校验，直接生成节点图')
        return true
      }
      task.diagnostics=[...task.diagnostics,{code:'TRIAL_PROCEDURE_INVALID',message:'试做提交的方法未通过来源、覆盖或依赖检查；保留路径证据，回退既有提炼。'}]
    }
    task.distillationSource='model'
    const resume=task.compilerDraft?.purpose==='distill'&&task.compilerDraft.checkpoint?.state==='clarification'?task.compilerDraft.checkpoint:undefined
    // Desktop r52: the trial's own method becomes the draft, so the model repairs
    // only the diagnosed paths instead of distilling anew. The seed is not one of its attempts.
    const seed={active:trialMethod&&!resume}
    const compiler=this.procedureCompiler(task,resume,seed)
    if(seed.active){
      const prior=task.diagnostics
      try{compiler.submit({submission:{mode:'distill',procedure:task.context!.trialProcedure}})}catch{}
      seed.active=false;task.diagnostics=[...prior,...task.diagnostics.filter(issue=>!prior.includes(issue))]
    }
    const seeded=trialMethod&&!resume&&!!compiler.continuation()?.hasDraft
    if(seeded)this.touch(task,'repairing','试做提交的方法有局部问题，交给模型只按诊断修补这几处')
    const continuation=resume||seeded?compiler?.continuation():undefined
    if(continuation?.remainingSubmissions===0)throw new PlanningAgentError('PLANNING_REPAIR_LIMIT','同一提炼草稿的提交次数已达上限，已保留草稿与诊断；没有再次启动规划模型')
    const raw=await this.invoke(task,caller,'distill',distillPrompt(task,continuation,seeded),compiler)
    const output=parseRetrospectiveOutput(raw)
    if(output.outcome==='needs-input'){
      this.awaitInput(task,{outcome:'needs-input',graphJson:'',summary:output.summary,questions:output.questions,assumptions:[],requirementCoverage:[]})
      return false
    }
    this.touch(task,'validating','校验提炼步骤、来源引用和依赖关系')
    const context=task.context!
    const procedure=parseTaskProcedure(JSON.parse(output.procedureJson),context.conversation!,taskSpecificationRefs(context.trialTask),!!context.trialTask)
    task.procedure=procedure
    task.output=undefined;task.diagnostics=[]
    this.touch(task,'collecting','任务方法已提炼，准备生成当前标准节点图')
    return true
  }
  private retireLegacy(task:PlanningTask,persist=true):boolean{
    if(!task.context||task.compilerMode||terminal.has(task.state))return false
    if(!['ready','awaiting_input'].includes(task.state))settlePendingUsage(task)
    task.diagnostics=[...task.diagnostics,{code:'PLANNING_LEGACY_RETIRED',message:'旧生成协议已退役，请重新发起该请求'}].slice(-1000)
    this.touch(task,'failed','旧生成协议已退役，请重新发起该请求',persist);return true
  }
  private async generate(task:PlanningTask,caller:PlanningCaller,externalSignal=caller.signal):Promise<PlanningTask>{
    try{
      this.options.authorize(task,caller,!task.preview)
      if(this.retireLegacy(task))return structuredClone(task)
      if(!task.context){
        this.touch(task,'collecting','冻结当前图、模型及目录')
        this.freezeContext(task,caller,await this.options.context(task.request,caller))
      }
      caller.signal.throwIfAborted()
      if(task.context!.conversation&&!task.procedure&&!await this.distill(task,caller))return await this.receiveBackgroundAnswers(task,caller)?this.generate(task,caller,externalSignal):structuredClone(task)
      const handoff=task.request.handoff
      const {direct,decided,authorContext}=this.routeHandoff(task,handoff)
      const author=this.prepareAuthor(task,caller,handoff,direct,decided,authorContext)
      const {authorCompiler,authorKinds,skeleton,continuation}=author
      const prompt=commandIntakePrompt(task,authorPrompt(task,{handoff,authorContext,authorCompiler,authorKinds,skeleton,continuation}),authorCompiler instanceof TemplateFillingCompiler)
      let rawOutput=direct??await this.invoke(task,caller,'author',prompt,author.compiler!,authorContext)
      if(task.commandIntake){
        const routed=rawOutput as CommandIntakeResult
        if(routed.kind!=='command-design')return await this.settleCommandRoute(task,caller,routed)
        rawOutput=routed.compiled
      }
      const compiled=rawOutput as CompiledAuthoring
      const output=compiled.output
      task.output=output
      if(output.outcome==='needs-input'){
        this.awaitInput(task,output);return await this.receiveBackgroundAnswers(task,caller)?this.generate(task,caller,externalSignal):structuredClone(task)
      }
      if(direct)task.candidateAttempts++;this.touch(task,'validating','检查当前 JSON、图引用、权限和依赖')
      const candidate=compiled.candidate!
      await this.validateCandidate(task,caller,compiled,candidate,{handoff,decided,completion:author.completion})
      return await this.finishCandidate(task,caller,externalSignal,candidate)
    }catch(error){return this.fail(task,error,externalSignal.aborted?externalSignal:caller.signal)}
  }
  private freezeContext(task:PlanningTask,caller:PlanningCaller,resolved:PlanningContext):void{
    const context=contextSchema.parse({...resolved,...(task.request.handoff?{contextSelection:handoffSelection(task.request.handoff)}:{})}) as PlanningContext
    this.validateContext(task,context)
    const {binding,selection}=chooseCompiler(task,context)
    const effectiveMode=selection.effectiveMode
    caller.signal.throwIfAborted()
    this.options.authorize(task,caller,!task.preview)
    task.context=context
    if(selection){
      task.compilerSelection=selection
      if(effectiveMode!=='legacy'){task.compilerMode=effectiveMode;task.compilerMetrics=[]}
    }
    if(effectiveMode==='template-fill')task.templateBinding=binding
  }
  private routeHandoff(task:PlanningTask,handoff:PlanningRequest['handoff']):{direct?:CompiledAuthoring;decided?:Workflow;authorContext:PlanningContext}{
    const context=task.context!
    let direct:CompiledAuthoring|undefined,decided:Workflow|undefined
    let authorContext=context
    if(!handoff)return {direct,decided,authorContext}
    task.handoffState={version:1,route:handoff.mode,decisionDigest:planningDigest(handoff),contextDigest:planningDigest(context)}
    const started=Date.now()
    if(handoff.mode==='module'){
      const source=task.request.operation==='revise'?this.resolveModuleSource(task):undefined
      const result=source
        ?updateBusinessModule(handoff.module,context,source.candidate!,source.moduleProvenance! as Parameters<typeof updateBusinessModule>[3])
        :compileBusinessModule(handoff.module,context,{},task.request.title)
      direct=result;task.moduleProvenance=result.provenance
    }else{
      const result=compileHandoffChanges(handoff,context)
      if(handoff.mode==='chain'&&'chain' in result)task.chainState=result.chain as PlanningChainState
      if(result.issues.length)throw new CompilerError('HANDOFF_INVALID',result.issues.map(issue=>issue.message).join('；'))
      if(handoff.mode==='edit'||handoff.mode==='chain')direct=result
      else{
        decided=result.candidate!
        authorContext={...context,workflow:decided,contextSelection:handoffSelection(handoff)}
      }
    }
    this.metric(task,{phase:'handoff:'+handoff.mode,at:Date.now(),durationMs:Date.now()-started,bytes:Buffer.byteLength(JSON.stringify(handoff))})
    this.touch(task,'validating',direct?'已按确定的字段或模块参数直接编译，无需规划子 Agent':'已保留主 Agent 决定，仅补全指定的未决字段')
    return {direct,decided,authorContext}
  }
  private prepareAuthor(task:PlanningTask,caller:PlanningCaller,handoff:PlanningRequest['handoff'],direct:CompiledAuthoring|undefined,decided:Workflow|undefined,authorContext:PlanningContext){
    const completion=decided?handoffCompletionPlan(handoff,task.context!,decided):undefined
    const rehearsalKinds=task.request.source?.kind==='verified-trial'?REHEARSAL_TEMPLATE_KINDS:[]
    // Doc 26: the verified trial path, already mapped to nodes, is the author's starting point.
    const skeleton=task.compilerMode==='template-fill'&&!handoff&&task.request.source?.kind==='verified-trial'?this.trialSkeleton(task,authorContext):undefined
    const authorKinds=skeleton?.forms.some(form=>form.template==='http')?[...rehearsalKinds,'http' as const]:rehearsalKinds
    if(task.candidateAttempts>=3)throw new PlanningAgentError('PLANNING_REPAIR_LIMIT','同一草稿的提交次数已达上限，已保留草稿与诊断；没有再次启动规划模型')
    const resume=task.compilerDraft?.purpose==='author'&&task.compilerDraft.checkpoint?.state==='clarification'?task.compilerDraft.checkpoint:undefined
    const authorCompiler=direct?undefined:this.authorCompiler(task,{handoff,decided,completion},resume,authorContext,authorKinds,skeleton)
    const compiler=task.commandIntake&&authorCompiler?new CommandIntakeCompiler(authorCompiler,value=>{
      if(!this.options.commandRequest)throw new Error('Host 未配置命令受理校验')
      return this.options.commandRequest(task,value,caller)
    },task.commandIntake.readOnly):authorCompiler
    const continuation=resume?authorCompiler?.continuation():undefined
    if(continuation?.remainingSubmissions===0)throw new PlanningAgentError('PLANNING_REPAIR_LIMIT','同一草稿的提交次数已达上限，已保留草稿与诊断；没有再次启动规划模型')
    return {completion,skeleton,authorKinds,authorCompiler,compiler,continuation}
  }
  private authorCompiler(task:PlanningTask,{handoff,decided,completion}:AuthorScope,resume:HostRepairCheckpoint|undefined,authorContext:PlanningContext,authorKinds:readonly NodeKind[],skeleton:TrialSkeleton|undefined){
    const options:AuthoringOptions&{resume?:HostRepairCheckpoint;resumeScope:string}={
      ...(task.request.operation==='create'&&task.request.title!==undefined?{requestedTitle:task.request.title}:{}),
      completion,requiredCoverageIds:requiredCoverageIds(task),
      validate:(candidate,output)=>[...this.coverageIssues(task,candidate,output),...handoffCandidateIssues(handoff,decided,candidate),...completionCandidateIssues(completion,candidate)],
      maxSubmissions:resume?Math.min(resume.maxSubmissions,3):3-task.candidateAttempts,onSubmission:this.observeCompiler(task,'author'),
      resumeScope:JSON.stringify([task.workspaceId,task.sessionId,task.id,'author']),...(resume?{resume}:{}),
    }
    if(task.compilerMode!=='template-fill')return new WorkflowAuthoringCompiler(authorContext,options)
    // T29: a draft under review needs only its own templates; others are queried on demand.
    const prefetch=[...new Set([
      ...(skeleton?.draft?[]:prefetchedTemplateIds(task.templateBinding!,authorContext,task.request.instruction,authorKinds)),
      ...((skeleton?.draft?.forms??skeleton?.forms)?.map(form=>form.template)??[]),
    ])]
    return new TemplateFillingCompiler(authorContext,{...options,binding:task.templateBinding,prefetch})
  }
  private async settleCommandRoute(task:PlanningTask,caller:PlanningCaller,routed:Exclude<CommandIntakeResult,{kind:'command-design'}>):Promise<PlanningTask>{
    const intake=task.commandIntake!
    if(routed.kind==='command-return'){
      intake.returned=routed.reason
      this.touch(task,'returned','交回主 Agent：'+routed.reason);return structuredClone(task)
    }
    if(routed.kind==='command-request'){
      if(!this.options.commandSubmit)throw new Error('Host 未配置命令受理提交')
      intake.decision=routed.request
      this.touch(task,'validating','已冻结路由决定，沿用标准规划请求入口')
      const submitted=await this.options.commandSubmit(routed.request,caller)
      intake.linkedTaskId=submitted.taskId
      this.touch(task,'handed_off','已交标准规划／试做任务 '+submitted.taskId);return structuredClone(task)
    }
    throw new Error('命令受理输出无效')
  }
  private async validateCandidate(task:PlanningTask,caller:PlanningCaller,compiled:CompiledAuthoring,candidate:Workflow,{handoff,decided,completion}:AuthorScope):Promise<void>{
    await this.span(task,'final-validation',caller.signal,()=>{
      task.diagnostics=compiled.issues
      task.diagnostics.push(...this.coverageIssues(task,candidate,compiled.output))
      task.diagnostics.push(...handoffCandidateIssues(handoff,decided,candidate),...completionCandidateIssues(completion,candidate))
    })
    if(task.diagnostics.some(issue=>/FIXED|SCOPE|FORBIDDEN|HOST_FIELD/.test(issue.code)))throw new Error(`FORBIDDEN: ${task.diagnostics.map(issue=>issue.message).join('；')}`)
    if(task.diagnostics.length)throw new Error('编译器接受结果未通过最终一致性校验')
    // Persisted and report copies are parseWorkflow-ordered; the digest must use that key order.
    task.candidate=parseWorkflow(candidate);task.candidateDigest=planningDigest(task.candidate)
    await this.span(task,'provenance-validation',caller.signal,()=>{
      this.validateHandoffCandidate(task)
      if(task.procedure){task.sourceMap=this.makeSourceMap(task);task.provenanceDigest=this.provenanceDigest(task);this.validateProvenance(task)}
    })
  }
  private async finishCandidate(task:PlanningTask,caller:PlanningCaller,externalSignal:AbortSignal,candidate:Workflow):Promise<PlanningTask>{
    // Readiness and publication failures are infrastructure or authority failures,
    // never candidate-repair feedback that could spend another model call.
    task.readiness=await this.span(task,'readiness',caller.signal,()=>this.options.readiness(candidate,caller));caller.signal.throwIfAborted()
    await this.span(task,'optimization',caller.signal,()=>this.optimize(task,caller))
    if(task.optimization&&caller.signal.aborted&&code(caller.signal.reason)==='PLANNING_DEADLINE_EXCEEDED'){
      // A finished baseline survives the optimizer's internal deadline. User
      // cancellation, Host shutdown and revoked authority still take priority.
      externalSignal.throwIfAborted()
    }else caller.signal.throwIfAborted()
    this.options.authorize(task,{...caller,signal:caller.signal.aborted?externalSignal:caller.signal},false)
    await this.span(task,'optimization-validation',externalSignal,()=>this.validateOptimization(task))
    this.touch(task,'ready',task.optimization?'已保留候选并完成优化比较；片段回放不代表业务全流程验收':'候选已通过结构检查；业务流程尚未执行')
    if(!task.preview&&!caller.signal.aborted)await this.publishTask(task,caller,externalSignal)
    return structuredClone(task)
  }
  private fail(task:PlanningTask,error:unknown,signal:AbortSignal):PlanningTask{
    const failure=signal.aborted&&!isCleanupFailure(error)&&!isPermissionFailure(error)?signal.reason??error:error
    const text=message(failure),failureCode=code(failure),cleanup=isCleanupFailure(error),uncertain=failureCode==='PUBLISH_UNCERTAIN'
    const timeout=failureCode==='PLANNING_DEADLINE_EXCEEDED'||failureCode==='PLANNING_IDLE_TIMEOUT'||(failure instanceof Error&&failure.name==='TimeoutError')
    const state:State=cleanup||uncertain||isPermissionFailure(failure)?'blocked':isConflict(failure)?'conflict':signal.aborted&&!timeout?'cancelled':'failed'
    this.flushPersistTiming(task)
    task.diagnostics=task.diagnostics.slice(0,999)
    task.diagnostics.push({code:failureDiagnosticCode(state,failureCode,cleanup,uncertain,timeout),message:text.slice(0,2000)})
    this.touch(task,state,text);return structuredClone(task)
  }
  private lookupReceipt(task:PlanningTask,commit:PlanningCommit):PlanningReceipt|undefined{
    const raw=this.options.receipt(commit.key)
    if(!raw)return undefined
    const receipt=planningReceiptSchema.parse(raw)
    if(receipt.key!==commit.key||receipt.digest!==commit.digest||receipt.workflowId!==task.candidate?.id||receipt.kind!==(task.request.operation==='create'?'created':'proposed'))throw new Error('规划回执归属或摘要冲突')
    return receipt
  }
  /** The first run is a workflow run, not planning: it ends with user cancellation,
   * parent disposal or Host shutdown (runSignal), never the planning deadline. */
  private async publishTask(task:PlanningTask,caller:PlanningCaller,runSignal=caller.signal):Promise<void>{
    if(!task.candidate||!task.candidateDigest)throw new Error('没有可发布候选')
    this.validateHandoffCandidate(task)
    this.validateProvenance(task)
    this.validateOptimization(task)
    const commit={key:this.commitKey(task),digest:task.candidateDigest}
    const recovered=this.lookupReceipt(task,commit)
    if(recovered){this.restorePublished(task,commit,recovered);return}
    this.options.authorize(task,caller,true);caller.signal.throwIfAborted()
    const issues=task.context?planningCandidateIssues(task.candidate,task.context):[{code:'INVALID_CANDIDATE',message:'候选缺少规划上下文'}]
    if(task.designChecks&&task.output)issues.push(...this.coverageIssues(task,task.candidate,task.output))
    if(issues.length){task.diagnostics=issues.slice(0,1000);this.touch(task,'blocked','候选不满足当前契约，请重新规划');return}
    task.readiness=await this.span(task,'publish-readiness',caller.signal,()=>this.options.readiness(task.candidate!,caller))
    this.options.authorize(task,caller,true);caller.signal.throwIfAborted()
    this.validateProvenance(task)
    if(task.designChecks&&task.output?.outcome==='candidate'&&task.childAttempts>0)task.designChecks=passedDesignChecks(task,task.candidateDigest)
    task.preview=false;task.commit=commit;this.touch(task,'publishing','提交可编辑图或修改提案')
    let publishError:unknown
    try{await this.span(task,'publish',caller.signal,()=>this.options.publish(structuredClone(task.candidate!),task,caller,commit))}catch(error){publishError=error}
    // The same atomic write owns the graph/proposal and this receipt. An exception
    // after commit is success on recovery, even if cancellation won the next await.
    const receipt=this.lookupReceipt(task,commit)
    if(!receipt){
      if(publishError!==undefined&&(isConflict(publishError)||isPermissionFailure(publishError)))throw publishError
      throw new PlanningPublicationError(publishError??new Error('发布回执缺失'))
    }
    if(task.workspaceSnapshot&&!task.workspaceSnapshot.published&&this.options.workspaceRevisions)task.workspaceSnapshot.published=structuredClone(this.options.workspaceRevisions(caller))
    task.receipt=receipt
    await this.runCreatedOnce(task,{...caller,signal:runSignal})
    this.touch(task,'published',receipt.kind==='created'?(task.firstRun?'已保存工作流；首次运行已记录，请查看运行结果':'已保存可编辑工作流，尚未执行'):'已提交修改提案，等待接受')
  }
  private restorePublished(task:PlanningTask,commit:PlanningCommit,recovered:PlanningReceipt):void{
    task.preview=false;task.commit=commit;task.receipt=recovered
    if(recovered.kind==='created'&&runsOnceAfterSave(task.request)&&!task.firstRun)task.firstRun=interruptedFirstRun(task.id)
    this.touch(task,'published','已恢复原提交回执')
  }
  private async runCreatedOnce(task:PlanningTask,caller:PlanningCaller):Promise<void>{
    if(task.receipt?.kind!=='created'||!runsOnceAfterSave(task.request)||task.firstRun)return
    task.firstRun={requestId:`trial-first-${task.id}`,status:'starting'}
    this.touch(task,'publishing','新图已保存，正在执行首次运行')
    try{
      caller.signal.throwIfAborted();this.options.authorize(task,caller,true)
      if(!this.options.runCreated)throw new Error('Host 未提供首次运行服务')
      await this.options.runCreated(task,caller,runId=>{task.firstRun!.runId=runId;this.touch(task,'publishing','首次运行已受理，等待结果或所需输入')})
      if(!task.firstRun.runId)throw new Error('首次运行缺少运行身份')
      task.firstRun.status='recorded'
    }catch(error){
      task.firstRun.status=caller.signal.aborted?'interrupted':'failed'
      task.firstRun.error=message(error).slice(0,4000)
      task.diagnostics.push({code:'FIRST_RUN_FAILED',message:'工作流已保存，首次运行未完成：'+task.firstRun.error})
    }
  }
  async publish(id:string,revision:number,digest:string,caller:PlanningCaller):Promise<PlanningTask>{
    this.lifetime.signal.throwIfAborted();caller.signal.throwIfAborted()
    const task=this.owned(id,caller)
    if(task.state==='published')return structuredClone(task)
    if(task.state!=='ready'||task.revision!==revision||task.candidateDigest!==digest||this.active.has(id))throw new Error('候选或规划版本已变化')
    const controller=new AbortController(),signal=AbortSignal.any([caller.signal,controller.signal,this.lifetime.signal])
    const done=Promise.resolve().then(()=>this.publishTask(task,{...caller,signal})).then(()=>structuredClone(task),error=>this.fail(task,error,signal)).finally(()=>this.active.delete(id))
    this.active.set(id,{controller,done});return done
  }
  async cancel(id:string,caller:PlanningCaller):Promise<PlanningTask>{
    const task=this.owned(id,caller),active=this.active.get(id)
    if(terminal.has(task.state)){if(active)await active.done;return structuredClone(task)}
    if(active){
      // Stopping the child must never depend on the journal: abort even when the
      // cancelling event cannot be persisted, then report that failure separately.
      let journalFailure:unknown
      try{this.touch(task,'cancelling','正在停止规划子任务')}catch(error){journalFailure=error}
      finally{active.controller.abort(new Error('用户取消规划'))}
      try{await active.done}catch(error){journalFailure??=error}
      if(journalFailure!==undefined){
        task.diagnostics=[...task.diagnostics,{code:'PLANNING_CANCEL_JOURNAL_FAILED',message:'已发出停止信号并等待子任务清理，但取消状态未能完整落盘：'+message(journalFailure).slice(0,1600)}].slice(-1000)
        // Best effort only: the failure is already reported and cancellation already sent.
        try{this.store.append(task,()=>[...this.tasks.values()])}catch{}
        try{this.options.onUpdate?.(structuredClone(task))}catch{}
      }
    }
    else this.touch(task,'cancelled','规划已取消')
    return structuredClone(task)
  }
  async close():Promise<void>{this.lifetime.abort(new Error('Host 已关闭'));await Promise.allSettled([...this.active.values()].map(task=>task.done))}
}
