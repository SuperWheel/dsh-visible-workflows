import { useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Workflow, WorkflowRun, WorkflowRunRevisionPlan } from '../shared/types.ts'
import { useWorkflowStore, type WorkflowStore } from './store.ts'
import { DataViewer } from './data-viewer.tsx'

const actionLabels={reuse:'保留并复用',rerun:'继续后重新执行',blocked:'无法应用'}
/** candidate is captured when the user opens this dialog, never read again from the canvas. */
export function RunRevisionPreview({store,run,candidate,sessionId,onClose,onApplied}:{store:WorkflowStore;run:WorkflowRun;candidate:Workflow;sessionId?:string;onClose:()=>void;onApplied:()=>void}){
  const state=useWorkflowStore(store),[plan,setPlan]=useState<WorkflowRunRevisionPlan>(),[loading,setLoading]=useState(true),[working,setWorking]=useState(false),[error,setError]=useState(''),[reload,setReload]=useState(0)
  const current=state.library.runs.find(item=>item.id===run.id)??run,editable=current.status==='paused'&&!current.executions.some(execution=>execution.repair?.waiting)
  useEffect(()=>{
    let mounted=true;setLoading(true);setPlan(undefined);setError('')
    void store.previewRunRevision(run.id,candidate,sessionId).then(value=>{if(mounted)setPlan(value)}).catch(error=>{if(mounted)setError(error instanceof Error?error.message:String(error))}).finally(()=>{if(mounted)setLoading(false)})
    return()=>{mounted=false}
  },[store,run.id,candidate,sessionId,reload])
  const allowed=editable&&!!plan?.allowed&&!!plan.planDigest&&!plan.blockedReasons.length&&!plan.items.some(item=>item.action==='blocked')
  const confirm=async()=>{
    if(!allowed||loading||working||!plan)return
    setWorking(true);setError('')
    try{await store.applyRunRevision(run.id,candidate,plan.planDigest,sessionId);onApplied();onClose()}catch(error){setError(error instanceof Error?error.message:String(error))}finally{setWorking(false)}
  }
  return <Modal open title="应用本次运行修订" closeLabel="关闭运行修订预览" className="vdw-modal" onClose={()=>{if(!working)onClose()}} footer={<><Button disabled={working} onClick={onClose}>取消</Button><Button variant="primary" disabled={loading||working||!allowed} onClick={()=>void confirm()}>{working?'正在应用…':'确认应用并保持暂停'}</Button></>}>
    <p>{run.workflowTitle} · 运行 <code>{run.id}</code></p>
    <p className="vdw-muted">预览使用打开此窗口时的画布内容。窗口打开后的画布修改不会混入本次修订；如需使用新修改，请取消后重新打开。</p>
    <p>确认后只更新本次运行的执行快照，保持暂停。结果的保留与失效由宿主核验，随后由你决定何时继续。</p>
    {loading&&<p role="status">正在核验本次运行修订…</p>}
    {plan&&<>
      <p className="vdw-muted">运行修订 v{plan.baseRevision} → v{plan.targetRevision} · {plan.changes.length} 项变化 · {plan.invalidNodeIds.length} 个节点结果失效</p>
      {!!plan.blockedReasons.length&&<section aria-label="运行修订阻塞原因"><strong>暂时无法应用</strong><ul>{plan.blockedReasons.map((reason,index)=><li key={index}>{reason}</li>)}</ul></section>}
      <section className="vdw-recovery-items" aria-label="本次运行变化"><strong>画布变化</strong>{plan.changes.map((change,index)=><details className="vdw-config-group" key={`${change.nodeId}/${index}`}><summary>{change.title}</summary><DataViewer title="修订前" value={change.before}/><DataViewer title="修订后" value={change.after}/></details>)}{!plan.changes.length&&<p className="vdw-muted">宿主未发现节点内容变化。</p>}</section>
      <section className="vdw-recovery-items" aria-label="运行修订结果处理"><strong>已有执行结果</strong>{plan.items.map((item,index)=><article className="vdw-config-group" key={`${item.executionId}/${index}`}><div className="vdw-actions"><strong>{item.title}</strong><span data-recovery-action={item.action}>{actionLabels[item.action]}</span></div><p>{item.reason}</p><small className="vdw-muted">执行实例：{item.executionId}</small></article>)}{!plan.items.length&&<p className="vdw-muted">没有历史执行结果需要处理。</p>}</section>
      {!plan.allowed&&!plan.blockedReasons.length&&<p className="vdw-error">宿主未允许应用这次修订。</p>}
    </>}
    {!editable&&<p className="vdw-error" role="alert">当前运行已不满足修订条件，需要处于暂停状态且没有待修正的 Agent 输出。</p>}
    {!loading&&<Button size="sm" disabled={working||!editable} onClick={()=>setReload(value=>value+1)}>重新核验同一修订</Button>}
    {error&&<p className="vdw-error" role="alert">{error}</p>}
  </Modal>
}
