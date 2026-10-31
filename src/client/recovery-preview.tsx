import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkflowRecoveryPlan, WorkflowRun } from '../shared/types.ts'
import { ACTIVE_RUN_STATUSES, type WorkflowStore, useWorkflowStore } from './store.ts'
import { Field } from './controls.tsx'
import { Glyph } from './icons.tsx'
import type { RecoveryDecision, RecoveryReview } from '../shared/recovery-review.ts'

const actionLabels={reuse:'复用结果',rerun:'重新执行',blocked:'阻止恢复'}
type DecisionDraft={action:RecoveryDecision['action']|'';evidence:string;output:string}
type ReviewStatus='pending'|'checking'|'passed'|'blocked'|'error'
const reviewLabels:Record<ReviewStatus,string>={pending:'待核验',checking:'核验中…',passed:'核验通过',blocked:'核验未通过',error:'核验未通过'}
const planAllowsRecovery=(plan:WorkflowRecoveryPlan|undefined)=>!!plan?.allowed&&!!plan.planDigest&&!plan.blockedReasons.length&&!plan.items.some(item=>item.action==='blocked')

export function RecoveryPreview({store,run,mode,onClose}:{store:WorkflowStore;run:WorkflowRun;mode:'recover'|'rerun';onClose:()=>void}){
  const state=useWorkflowStore(store),[plan,setPlan]=useState<WorkflowRecoveryPlan>(),[loading,setLoading]=useState(mode==='recover'),[operation,setOperation]=useState<'checking'|'creating'>(),[error,setError]=useState(''),[reload,setReload]=useState(0)
  const [baseDigest,setBaseDigest]=useState(''),[decisions,setDecisions]=useState<Record<string,DecisionDraft>>({}),[review,setReview]=useState<RecoveryReview>(),[reviewDirty,setReviewDirty]=useState(false),[reviewStatus,setReviewStatus]=useState<ReviewStatus>('pending')
  const reviewGeneration=useRef(0),workingRef=useRef(false),working=operation!==undefined
  const anotherActive=state.library.runs.some(item=>item.workflowId===run.workflowId&&ACTIVE_RUN_STATUSES.includes(item.status))
  useEffect(()=>{
    if(mode!=='recover')return
    let current=true;reviewGeneration.current++;setLoading(true);setPlan(undefined);setError('');setReview(undefined);setDecisions({});setReviewDirty(false);setReviewStatus('pending')
    void store.recoveryPlan(run.id).then(value=>{if(current){setPlan(value);setBaseDigest(value.planDigest)}}).catch(error=>{if(current)setError(error instanceof Error?error.message:String(error))}).finally(()=>{if(current)setLoading(false)})
    return()=>{current=false;reviewGeneration.current++}
  },[store,run.id,mode,reload])
  const allowed=mode==='rerun'||!reviewDirty&&planAllowsRecovery(plan)
  const reviewItems=plan?.items.filter(item=>item.reviewable)??[]
  const changeDecision=(id:string,patch:Partial<DecisionDraft>)=>{
    if(workingRef.current)return
    reviewGeneration.current++;setDecisions(current=>({...current,[id]:{...(current[id]??{action:'',evidence:'',output:'{}'}),...patch}}));setReviewDirty(true);setReviewStatus('pending');setError('')
  }
  const inspectReview=async()=>{
    if(workingRef.current)return
    workingRef.current=true;const generation=++reviewGeneration.current;setOperation('checking');setReviewStatus('checking');setError('')
    try{
      const value:RecoveryReview={baseDigest,decisions:Object.entries(decisions).map(([executionId,decision])=>{
        if(!decision.action)throw new Error('请选择处理决定，再检查核验结果。')
        if(decision.evidence.trim().length>4000)throw new Error('回执或核验说明不能超过 4000 个字符。')
        let output:unknown
        if(decision.action==='completed'){
          try{output=JSON.parse(decision.output)}catch{throw new Error('已核实的输出不是有效 JSON，请检查引号、逗号和括号。')}
          if(!output||typeof output!=='object'||Array.isArray(output))throw new Error('请提供已核实的 JSON 对象输出。')
        }
        return{executionId,action:decision.action,...(decision.evidence.trim()?{evidence:decision.evidence}:{}),...(decision.action==='completed'?{output:output as RecoveryDecision['output']}:{})}
      })}
      const next=await store.recoveryPlan(run.id,value)
      if(generation!==reviewGeneration.current)return
      setPlan(next);setReview(value);setReviewDirty(false);setReviewStatus(planAllowsRecovery(next)?'passed':'blocked')
    }catch(error){if(generation===reviewGeneration.current){setError(error instanceof Error?error.message:String(error));setReviewStatus('error')}}finally{workingRef.current=false;setOperation(undefined)}
  }
  const confirm=async()=>{
    if(loading||workingRef.current||anotherActive||!allowed)return
    workingRef.current=true;setOperation('creating');setError('')
    try{if(review)await store.control(mode,run.id,plan?.planDigest,review);else await store.control(mode,run.id,mode==='recover'?plan?.planDigest:undefined);onClose()}catch(error){setError(error instanceof Error?error.message:String(error))}finally{workingRef.current=false;setOperation(undefined)}
  }
  return <Modal open title={mode==='recover'?'恢复运行预览':'按快照重新运行'} closeLabel="关闭运行预览" className="vdw-modal vdw-recovery-modal" onClose={()=>{if(!working)onClose()}} footer={<><Button variant="outline" disabled={working} onClick={onClose}>取消</Button><Button variant="primary" disabled={loading||working||anotherActive||!allowed} onClick={()=>void confirm()}>{operation==='creating'?'正在创建…':mode==='recover'?'确认创建恢复运行':'确认全部重新执行'}</Button></>}>
    <div className="vdw-recovery-content">
      <div className="vdw-recovery-source"><p>{run.workflowTitle} · 源版本 v{run.sourceRevision}</p><p className="vdw-muted">来源运行：<code>{run.id}</code></p></div>
      {mode==='rerun'?<p>按这次运行的旧快照创建新运行，全部节点重新执行，不复用历史结果。外部操作可能再次发生，请确认后继续。</p>:<>
        <p className="vdw-recovery-description">以下计划由宿主根据快照、历史结果和当前执行条件核验。确认后创建新运行；正式恢复时会再次核验。</p>
        {loading&&<p role="status">正在核验恢复计划…</p>}
        {plan&&<>
          {!!plan.blockedReasons.length&&<section className="vdw-recovery-blocked" aria-label="恢复阻塞原因"><strong>暂时无法恢复</strong><ul>{plan.blockedReasons.map((reason,index)=><li key={index}>{reason}</li>)}</ul></section>}
          <section className="vdw-recovery-plan" aria-label="节点恢复计划">
            <header className="vdw-between"><strong>节点恢复计划</strong><small>{plan.items.length} 个节点</small></header>
            <div className="vdw-recovery-items">{plan.items.map((item,index)=><article className="vdw-config-group" key={`${item.executionId}/${index}`}><div className="vdw-between"><strong>{item.title}</strong><span className="vdw-recovery-action" data-recovery-action={item.action}>{actionLabels[item.action]}</span></div><p>{item.reason}</p><small className="vdw-muted">执行实例：{item.executionId}</small></article>)}</div>
            {!plan.items.length&&<p className="vdw-muted">没有可复用的执行实例。是否允许恢复以宿主核验结果为准。</p>}
          </section>
          {!!reviewItems.length&&<section className="vdw-recovery-review" aria-label="外部动作核验">
            <div className="vdw-recovery-section-heading"><strong>核验外部动作</strong><p className="vdw-recovery-description">先检查外部服务回执或文件，再逐项决定。选择“已完成”须提供可用输出，结果会标记为用户核验；选择“允许重做”可能再次产生外部操作。</p></div>
            {reviewItems.map(item=><div className="vdw-config-group vdw-recovery-review-card" key={item.executionId}>
              <strong>{item.title}</strong>
              <Field label="处理决定"><div className="vdw-recovery-select"><select aria-label={`核验决定 ${item.executionId}`} value={decisions[item.executionId]?.action??''} disabled={working} onChange={event=>changeDecision(item.executionId,{action:event.target.value as RecoveryDecision['action']})}>
                <option value="" disabled>尚未决定</option>
                {item.reviewCanComplete!==false&&<option value="completed">已完成，采用核实输出</option>}
                <option value="redo">允许重做</option><option value="abandon">放弃恢复</option>
              </select><Glyph name="chevron-down"/></div></Field>
              <Field label="回执或核验说明（选填）"><textarea disabled={working} aria-label={`核验说明 ${item.executionId}`} placeholder="填写已核对的回执、文件或允许重做的依据" value={decisions[item.executionId]?.evidence??''} onChange={event=>changeDecision(item.executionId,{evidence:event.target.value})}/></Field>
              {decisions[item.executionId]?.action==='completed'&&<Field label="已核实的 JSON 输出"><textarea disabled={working} aria-label={`核验输出 ${item.executionId}`} value={decisions[item.executionId]?.output??'{}'} onChange={event=>changeDecision(item.executionId,{output:event.target.value})}/></Field>}
            </div>)}
          </section>}
          {!plan.allowed&&!plan.blockedReasons.length&&<p className="vdw-error">宿主未允许恢复这次运行。</p>}
        </>}
        {!loading&&<div className="vdw-recovery-checks">
          <div className="vdw-actions vdw-recovery-actions">{!!reviewItems.length&&<Button variant="outline" size="sm" disabled={working||!reviewDirty} onClick={()=>void inspectReview()}>{operation==='checking'?'核验中…':'检查核验决定'}</Button>}<Button variant="outline" size="sm" disabled={working} onClick={()=>setReload(value=>value+1)}>重新核验</Button></div>
          {!!reviewItems.length&&<div className="vdw-recovery-feedback" data-review-status={reviewStatus} role="status" aria-live="polite"><strong>{reviewLabels[reviewStatus]}</strong><p>{reviewStatus==='passed'?'当前决定已通过检查，可以确认创建恢复运行。':reviewStatus==='checking'?'正在检查当前决定及核验说明。':reviewStatus==='blocked'?'仍有阻塞项，请查看原因并修改处理决定。':reviewStatus==='error'?'请处理下方错误后重新检查。':reviewDirty?'决定或说明已修改，请检查核验决定。':'选择处理决定后检查核验结果；说明可选填。'}</p></div>}
        </div>}
      </>}
      {anotherActive&&<p className="vdw-error" role="alert">该工作流已有活动运行，请先处理后再创建新运行。</p>}
      {error&&<p className="vdw-error" role="alert">{error}</p>}
    </div>
  </Modal>
}
