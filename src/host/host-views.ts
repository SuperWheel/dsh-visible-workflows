import type { WorkflowRun } from '../shared/types.ts'
import { allNodes } from './validation.ts'
import { planningDigest, type PlanningTask } from './planning/service.ts'
import type { PlanningTrial } from './planning/trial-service.ts'
import { planningModuleHint } from './planning/module-hint.ts'
import { planningWaitDelta } from './planning/wait-cursor.ts'
import { planningJoinDisposition, type PlanningJoinView } from './planning/task-join.ts'
import type { CurrentPlanningTarget } from './planning/command.ts'
import type { designVerificationReceipt, moduleVerificationReceipt, workspaceChangeVerification } from './planning/command-brief.ts'

type PlanningVerification=ReturnType<typeof moduleVerificationReceipt>|ReturnType<typeof designVerificationReceipt>
type PlanningEvidence=NonNullable<PlanningTask['context']>['conversation']
export interface PlanningSubviews {
  input:unknown;firstRun:unknown;evidence:PlanningEvidence
  optimization:ReturnType<typeof planningOptimizationView>
  verification:PlanningVerification;workspaceChanges:ReturnType<typeof workspaceChangeVerification>
}

export function planningOptimizationView(report:PlanningTask['optimization'],includeCandidates:boolean){
  return report&&{...report,
    baseline:{stats:report.baseline.stats,targetEvaluation:report.baseline.targetEvaluation,candidateDigest:planningDigest(report.baseline.candidate),...(includeCandidates?{candidate:report.baseline.candidate}:{})},
    attempts:report.attempts.map(({candidate,...attempt})=>({...attempt,...(candidate?{candidateDigest:planningDigest(candidate),...(includeCandidates?{candidate}:{})}:{})})),
    note:'比较为图级计划调用及历史样本的节点变换回放；不是金额、实际Token节省或业务全流程验收。超目标保留候选，不改变执行策略。'}
}
export function planningReceiptView(task:PlanningTask,verification:PlanningVerification,workspaceChanges:PlanningSubviews['workspaceChanges']){
  if(!task.receipt)return undefined
  return {...task.receipt,...(task.state==='published'?{verification:verification||workspaceChanges?{...verification,...(workspaceChanges?{workspaceChanges}:{})}:undefined}:{})}
}
export function planningCommandView(task:PlanningTask){
  const intake=task.commandIntake
  if(!intake)return undefined
  return {linkedTaskId:intake.linkedTaskId,returned:intake.returned,...(intake.returned?{brief:JSON.parse(intake.brief)}:{})}
}
export function planningUsageView(task:PlanningTask){
  const recovered=task.delivery?.recovered
  return {scope:'planning',unit:'tokens',recoveredWithoutUsage:!!recovered,
    steps:recovered?null:task.steps,childAttempts:recovered?null:task.childAttempts,spentTokens:recovered?null:task.spentTokens,usageAccountingVersion:task.usageAccountingVersion??1,
    observedInputBytes:recovered?null:task.observedInputBytes,unknownUsageCalls:recovered?null:task.unknownUsageCalls,pendingUsageCalls:recovered?null:task.pendingUsageCalls,
    legacyEstimates:recovered?null:{unknownTokens:task.unknownTokens,reservedTokens:task.reservedTokens},
    note:'spentTokens仅为已报告用量；observedInputBytes为字节体积。未知调用不是零，历史估计不是实际Token；这些统计不设规划用量硬上限，也不表示金额。'}
}
export function planningSourceView(task:PlanningTask,evidence:PlanningEvidence){
  if(!evidence)return {}
  return {source:{kind:task.request.source?.kind??'current-conversation',...(task.context?.trial?{trial:task.context.trial}:{}),
      fromSeq:evidence.fromSeq,throughSeq:evidence.throughSeq,digest:evidence.digest,recordCount:evidence.records.length,warnings:evidence.warnings},
    distillationSource:task.distillationSource,distillationAttempts:task.distillationAttempts,procedure:task.procedure,sourceMap:task.sourceMap,provenanceDigest:task.provenanceDigest}
}
export function planningTaskView(task:PlanningTask,views:PlanningSubviews,includeCandidates:boolean,includeMetrics:boolean):Record<string,unknown>{
  return {input:views.input,firstRun:views.firstRun,trialReport:task.context?.trialReport,delivery:task.delivery,handoff:task.handoffState,chain:task.chainState,
    ...(includeMetrics?{compilerMetrics:task.compilerMetrics??[]}:{}),
    moduleProvenance:task.moduleProvenance,compilerMode:task.compilerMode,compilerSelection:task.compilerSelection,engineVersion:task.engineVersion,
    optimization:views.optimization,optimizationDigest:task.optimizationDigest,
    taskId:task.id,requestId:task.request.requestId,state:task.state,revision:task.revision,preview:task.preview,workflowId:task.context?.workflow.id,candidateDigest:task.candidateDigest,
    summary:task.output?.summary,assumptions:task.output?.assumptions,questions:task.output?.questions,diagnostics:task.diagnostics,moduleHint:planningModuleHint(task),readiness:task.readiness,
    receipt:planningReceiptView(task,views.verification,views.workspaceChanges),
    command:planningCommandView(task),
    usage:planningUsageView(task),
    ...(includeCandidates&&task.candidate?{candidate:task.candidate}:{}),
    ...planningSourceView(task,views.evidence),
    events:task.events.slice(-8)}
}
export const trialUsageView=(trial:PlanningTrial)=>({scope:'trial',steps:trial.steps,reportedTokens:trial.spentTokens??null,note:'试做实耗与图级优化目标分开；未知用量不是零，不以估算Token停止设计。'})
export function trialInstruction(trial:PlanningTrial,planned:boolean):string {
  if(planned)return '试做记录及冻结检查报告已保留，包括失败或无法核验项。按 planning 报告画布、firstRun 的真实结果及试做未跑通步骤，最后邀请用户审阅；不要重复试做或重复首次运行。后续澄清/发布使用 planningTaskId 和 planning 的 revision/digest。'
  if(trial.state==='needs_input')return '试做尚未完成，execution.questions说明缺少的信息或权限。通过原生问答澄清并明确告知本次执行已停止；回答不会自动续跑该子任务。用户明确选择后，可在正常对话仅完成剩余动作，再从当前对话提炼；不得换requestId自动重做已发生动作。'
  return '已保留执行回执；以 verification 和 diagnostics 为准，不把模型声明当成验证成功，不自动重试业务动作。'
}
export function firstRunNodes(run:WorkflowRun){
  return allNodes(run.graph).flatMap(node=>{
    const rows=run.executions.filter(row=>row.nodeId===node.id)
    return rows.length?rows.map(({nodeId,title,status,error,executionId})=>({nodeId,title,status,error,executionId})):[{nodeId:node.id,title:node.title,status:'pending' as const,error:undefined,executionId:undefined}]
  })
}
export function firstRunRunView(run:WorkflowRun){
  return {runId:run.id,status:run.status,outputs:run.outputs,error:run.error,
    nodes:firstRunNodes(run),
    waiting:run.status==='waiting'?{missingFields:run.missingFields,nodeId:run.waitingNodeId,prompt:run.humanPrompt,actions:run.humanActions}:undefined}
}
export function planningWaitView(view:PlanningJoinView,scope:Parameters<typeof planningWaitDelta>[1],cursor:string|undefined){
  const {joinActive:_,...task}=view
  return {...planningWaitDelta(task,scope,cursor),wait:{outcome:planningJoinDisposition(view)??'waiting',
    instruction:(view.input??view.planning?.input)?.instruction??(planningJoinDisposition(view)?'核对真实状态后总结；不自动发布、接受或运行':'任务尚未完成，继续同task事件等待，不能提前报告成功')}}
}
export function currentTargetView(target:CurrentPlanningTarget|undefined){
  const instruction=target?.dirty?'画布有未保存修改，请先保存或还原。':
    target?'局部任务按返回身份与版本用visible_workflow_nodes定位并批读必要字段，全图任务才用visible_workflow_get；版本过期须重新核对原要求。确定字段新值用visible_workflow_edit，未决逻辑用visible_workflow_plan的partial合同。':
    '当前没有选中的画布，请用visible_workflow_list让用户选择或@工作流。'
  return {target:target??null,instruction}
}
