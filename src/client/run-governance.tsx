import { executionPolicyWarnings } from '../shared/workflow-validation.ts'
import { useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Workflow, WorkflowRun } from '../shared/types.ts'
import { ACTIVE_RUN_STATUSES, type WorkflowStore, useWorkflowStore } from './store.ts'
import { Glyph } from './icons.tsx'
import { ActionTooltip as Tooltip } from './action-tooltip.tsx'
import { useLocale } from './i18n.ts'
import { RecoveryPreview } from './recovery-preview.tsx'
import { RunRevisionPreview } from './run-revision-preview.tsx'

export function RunToolbar({store,working,onExecute,onAction}:{store:WorkflowStore;working:boolean;onExecute:()=>void;onAction:(action:()=>Promise<unknown>)=>void}) {
  const {t,locale}=useLocale()
  const state=useWorkflowStore(store),active=state.library.runs.find(run=>run.workflowId===state.workflow?.id&&ACTIVE_RUN_STATUSES.includes(run.status))
  const [checking,setChecking]=useState(false),[blocked,setBlocked]=useState<{count?:number;error?:string}>(),locked=useRef(false)
  const execute=async()=>{
    if(locked.current||working)return
    locked.current=true;setChecking(true);setBlocked(undefined)
    const intent={workflowId:state.workflow?.id,sessionId:state.sessionId}
    const unchanged=()=>{const current=store.getSnapshot();if(current.workflow?.id!==intent.workflowId||current.sessionId!==intent.sessionId||current.page!=='canvas')throw new Error(t("工作流或对话已变化，请在当前画布重新点击执行","The workflow or conversation changed. Run again from the current canvas."));if(current.library.runs.some(run=>run.workflowId===intent.workflowId&&ACTIVE_RUN_STATUSES.includes(run.status)))throw new Error(t("此流程已有运行，请查看运行状态","This workflow already has an active run. Check its status."))}
    try{
      unchanged();const report=await store.save();unchanged()
      if(!report)throw new Error(t("当前宿主尚不支持配置检查，请更新插件后运行","This host does not support configuration checks. Update the plugin before running."))
      if(!report.canRun||report.issues.length){setBlocked({count:report.issues.length});return}
      onExecute()
    }catch(error){setBlocked({error:error instanceof Error?error.message:String(error)})}
    finally{locked.current=false;setChecking(false)}
  }
  const goProcess=()=>{setBlocked(undefined);const current=store.getSnapshot();store.update({logs:false,configId:'',variablePanel:undefined,readinessFocus:(current.readinessFocus??0)+1})}
  if(!active)return <><Tooltip label={t('先保存并检查配置；有缺失项时提示处理','Save and check configuration before running')} portal side="bottom" maxWidth={300}><Button variant="primary" size="sm" icon={<Glyph name="play"/>} aria-label={t('执行','Run')} disabled={working||checking} onClick={()=>void execute()}><span className="vdw-control-label">{checking?t('检查中…','Checking…'):t('执行','Run')}</span></Button></Tooltip>
    {blocked&&<Modal open title={blocked.error?t('运行前检查未完成','Pre-run check incomplete'):t('请先处理缺失配置','Resolve configuration issues first')} closeLabel={t('关闭运行提示','Close run notice')} className="vdw-modal" onClose={()=>setBlocked(undefined)} footer={<><Button onClick={()=>setBlocked(undefined)}>{t('关闭','Close')}</Button><Button variant="primary" onClick={goProcess}>{t('去处理','Resolve issues')}</Button></>}>
      <p>{blocked.count?t('当前有 {count} 项待处理配置。','There are {count} configuration issues. ',{count:blocked.count}):''}{t('请先按照画布右侧待处理清单的指示补齐缺失值，再点击执行。','Follow the issue list on the right to resolve missing values, then run again.')}</p>
      {blocked.error&&<p className="vdw-error" role="alert">{blocked.error}</p>}
      <p className="vdw-muted">{t('工作流可以继续保存，本次尚未启动运行。','You can keep saving the workflow. This run has not started.')}</p>
    </Modal>}</>
  const paused=active.status==='paused'||active.status==='budget_waiting',repairWaiting=active.executions.some(execution=>execution.repair?.waiting)
  return <>
    {paused?<Tooltip label={repairWaiting?t("输出不合格，须先在运行详情修正并确认；不能直接继续原动作","Correct and confirm the output in run details before resuming."):store.api.resume?t("按原快照继续运行","Resume from the original snapshot"):t("当前宿主不支持继续运行","This host does not support resuming runs")} portal side="bottom" maxWidth={300}><Button size="sm" icon={<Glyph name="play"/>} aria-label={t('继续运行','Resume run')} disabled={working||!store.api.resume||repairWaiting} onClick={()=>onAction(()=>store.control('resume',active.id))}><span className="vdw-control-label">{repairWaiting?t('待修正','Needs correction'):t('继续','Resume')}</span></Button></Tooltip>:<Tooltip label={active.status==='pausing'?t("已停止准入，等待在途任务结束","New calls are paused. Waiting for in-progress tasks."):t("暂停后续调度；在途任务继续完成","Pause new calls while in-progress tasks finish")} portal side="bottom" maxWidth={300}><Button size="sm" icon={<Glyph name="pause"/>} aria-label={t('暂停后续调度','Pause scheduling')} disabled={working||!store.api.pause||active.status==='pausing'||active.status==='waiting'} onClick={()=>onAction(()=>store.control('pause',active.id))}><span className="vdw-control-label">{active.status==='pausing'?t('暂停中','Pausing'):t('暂停','Pause')}</span></Button></Tooltip>}
    <Button size="sm" icon={<Glyph name="stop"/>} aria-label={t('停止','Stop')} disabled={working} onClick={()=>onAction(()=>store.cancel())}><span className="vdw-control-label">{t('停止','Stop')}</span></Button>
  </>
}
export function RunGovernance({store,run}:{store:WorkflowStore;run:WorkflowRun}) {
  const {t,locale}=useLocale()
  const state=useWorkflowStore(store),[preview,setPreview]=useState<'recover'|'rerun'>(),[revision,setRevision]=useState<{workflow:Workflow;sessionId?:string}>(),[feedback,setFeedback]=useState('')
  const active=ACTIVE_RUN_STATUSES.includes(run.status),anotherActive=state.library.runs.some(item=>item.workflowId===run.workflowId&&ACTIVE_RUN_STATUSES.includes(item.status)),usage=run.usage
  const pendingUsageReceipts=Object.values(usage?.allocations??{}).filter(allocation=>allocation?.status==='reserved').length
  const repairWaiting=run.executions.some(execution=>execution.repair?.waiting),hasRevision=run.activeRevision!==undefined||!!run.revisionHistory?.length
  const canRecover=!active&&['failed','interrupted','cancelled'].includes(run.status)

  return <div className="vdw-run-governance">
    {executionPolicyWarnings(run.graph).map(notice=><p key={notice.message} className="vdw-muted" role="status">{notice.message}</p>)}
    {(run.sourceRunId||active||hasRevision)&&<div className="vdw-run-provenance">
      {run.sourceRunId&&<p className="vdw-muted">{t('来源运行：','Source run: ')}<code>{run.sourceRunId}</code></p>}
      {active&&<p className="vdw-muted">{t('当前运行使用 v{version} 快照。画布修改需在暂停后预览并应用，才会影响本次运行。','This run uses snapshot v{version}. Pause, preview and apply canvas changes to update this run.',{version:run.activeRevision??run.sourceRevision})}</p>}
      {hasRevision&&<p className="vdw-muted">{t('当前运行修订：v{version} · 修订历史 {count} 条 · 启动源版本 v{source}','Current revision: v{version} · {count} revisions · Started from v{source}',{version:run.activeRevision??run.sourceRevision,count:run.revisionHistory?.length??0,source:run.sourceRevision})}</p>}
    </div>}
    {run.status==='paused'&&!repairWaiting&&<div className="vdw-run-revision-actions">
      <Button disabled={!state.workflow||state.workflow.id!==run.workflowId||!store.api.previewRunRevision||!store.api.applyRunRevision} onClick={()=>{if(state.workflow){setFeedback('');setRevision({workflow:structuredClone(state.workflow),sessionId:state.sessionId})}}}>{t("将当前画布应用到本次运行","Apply the current canvas to this run")}</Button>
      {(!store.api.previewRunRevision||!store.api.applyRunRevision)&&<p className="vdw-muted">{t("当前宿主尚不支持暂停后的运行修订。","This host does not support revising paused runs.")}</p>}
    </div>}
    {feedback&&<p role="status">{feedback}</p>}
    {repairWaiting&&<p className="vdw-error" role="status">{t("Agent 输出不合格，已暂停后续调度。展开对应节点，查看修复记录并确认修正后的输出，或停止运行。","Agent output needs correction, so scheduling is paused. Open the node to review repairs and confirm corrected output, or stop the run.")}</p>}
    {run.status==='budget_waiting'&&<p className="vdw-muted" role="status">{t('此旧运行已暂停。可以停止运行，或在宿主支持时继续。','This legacy run is paused. Stop it, or resume when supported by the host.')}</p>}
    {usage&&<section className="vdw-config-group vdw-run-ledger" aria-label={t('Token 用量统计','Token usage statistics')}>
      <strong className="vdw-run-ledger-title">{t('Token 用量','Token usage')}</strong>
      <dl className="vdw-usage-ledger">
        <dt>{t('已报告实际用量','Reported actual usage')}</dt><dd>{usage.spentTokens.toLocaleString(locale)}</dd>
        <dt>{t('未知用量调用','Calls with unknown usage')}</dt><dd>{usage.unknownCalls.toLocaleString(locale)}</dd>
        {pendingUsageReceipts>0&&<><dt>{t('待返回用量回执','Pending usage receipts')}</dt><dd>{pendingUsageReceipts.toLocaleString(locale)}</dd></>}
        <dt>{t('调用 / Agent 任务','Calls / Agent tasks')}</dt><dd>{usage.calls} / {usage.agentTasks}</dd>
      </dl>
      <p className="vdw-muted vdw-run-ledger-note">{t('仅统计已报告的实际 Token；未知用量不按零计算。','Only reported actual tokens are counted; unknown usage is not treated as zero.')}</p>
    </section>}
    {canRecover&&<div className="vdw-actions vdw-run-actions">
      <Tooltip label={store.api.recover&&store.api.recoveryPlan?t("先核验复用与重跑计划，确认后创建新运行","Review reuse and rerun plans before creating a new run"):t("当前宿主不支持恢复运行","This host does not support recovery runs")} portal side="bottom" maxWidth={300}>
        <Button variant="outline" size="sm" disabled={anotherActive||!store.api.recover||!store.api.recoveryPlan} onClick={()=>setPreview('recover')}>{t("创建恢复运行","Create recovery run")}</Button>
      </Tooltip>
    </div>}
    {revision&&<RunRevisionPreview store={store} run={run} candidate={revision.workflow} sessionId={revision.sessionId} onClose={()=>setRevision(undefined)} onApplied={()=>setFeedback(t("修订已应用，本次运行仍暂停。确认准备就绪后再继续。","Revision applied. The run is still paused; resume when ready."))}/>}
    {preview&&<RecoveryPreview store={store} run={run} mode={preview} onClose={()=>setPreview(undefined)}/>}
  </div>
}
