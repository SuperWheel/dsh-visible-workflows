import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { newId, type AgentNativeTaskView, type AgentProcessView, type JsonValue, type NodeExecution } from '../shared/types.ts'
import type { WorkflowStore } from './store.ts'
import { DataViewer } from './data-viewer.tsx'
import { Field } from './controls.tsx'
import { t } from './i18n.ts'

const eventLabels={status:'状态',step:'步骤',tool:'工具',message:'消息',error:'错误'}
function NativeTaskLifecycle({tasks,executionId}:{tasks:AgentNativeTaskView[]|undefined;executionId:string}){
  const observed=tasks?.slice(0,3)??[]
  const receipt=(value:boolean|undefined)=>value===true?t('已确认','Confirmed'):value===false?t('未成功','Unsuccessful'):t('未知','Unknown')
  const registry=(value:boolean|undefined)=>value===false?t('无残留','No remaining entry'):value===true?t('仍有残留','Entry remains'):t('未知','Unknown')
  return <section aria-label={t('原生任务生命周期','Native task lifecycle')}>
    <strong>{t('资源与结束回执','Resource and termination receipts')}</strong>
    {!observed.length&&<p className="vdw-muted">{t('资源清理：未确认。宿主未提供生命周期记录，任务结束不代表资源已释放。','Resource cleanup: unconfirmed. The host did not provide lifecycle records; an ended task does not prove resource release.')}</p>}
    {observed.map(task=>{
      const lifecycle=task.lifecycle,activation=lifecycle?.activation
      const parentObserved=lifecycle?.ownedParentDisposed!==undefined||lifecycle?.ownedParentRegisteredAfterCleanup!==undefined
      const failed=lifecycle?.cleanup==='failed'||lifecycle?.activationDisposed===false||lifecycle?.ownedParentDisposed===false||!!lifecycle?.errors?.length
      const confirmed=lifecycle?.cleanup==='completed'&&lifecycle.activationDisposed===true&&lifecycle.childRegisteredAfterCleanup===false&&(!parentObserved||lifecycle.ownedParentDisposed===true&&lifecycle.ownedParentRegisteredAfterCleanup===false)
      const aligned=!!activation?.runId&&!!activation.startedAt&&!!activation.endedAt&&!!activation.stopReason
      const label=task.executionId===executionId?t('原任务','Original task'):task.executionId.startsWith(executionId+'/repair/')?t('输出修复任务','Output repair task'):t('任务关系未知','Task relationship unknown')
      return <article className="vdw-agent-event" key={task.taskId} aria-label={label}>
        <strong>{label}</strong><p className="vdw-muted">{t('任务','Task')}：<code>{task.taskId}</code> · {task.status}</p>
        <p className={failed?'vdw-error':undefined}>{t('资源清理','Resource cleanup')}：{failed?t('失败','Failed'):confirmed?t('已确认（子任务）','Confirmed (child task)'):t('未确认','Unconfirmed')}</p>
        <p className="vdw-muted">{t('子任务释放回执','Child disposal receipt')}：{receipt(lifecycle?.activationDisposed)} · {t('注册表','Registry')}：{registry(lifecycle?.childRegisteredAfterCleanup)}</p>
        <p className="vdw-muted">{t('自有父任务释放回执','Owned parent disposal receipt')}：{receipt(lifecycle?.ownedParentDisposed)} · {t('注册表','Registry')}：{registry(lifecycle?.ownedParentRegisteredAfterCleanup)}</p>
        <p className="vdw-muted">SDK start/end：{aligned?t('已对齐','Matched'):activation?.startedAt?t('未确认结束回执','End receipt unconfirmed'):t('未知','Unknown')}{activation?.stopReason&&<> · {t('结束原因','Stop reason')}：{activation.stopReason}</>}</p>
        {activation?.runId&&<p className="vdw-muted">{t('激活身份','Activation identity')}：<code>{activation.runId}</code></p>}
        <p className="vdw-muted">{t('已报告 Token 总量','Reported total tokens')}：{task.usage?.totalTokens??t('未知','Unknown')}</p>
        {lifecycle?.errors?.slice(0,8).map((message,index)=><p className="vdw-error" key={index}>{message}</p>)}
      </article>
    })}
    {!!observed.length&&<p className="vdw-muted">{t('只显示宿主回执。未提供的父任务或注册表数据保持未知，任务完成不等于资源释放。','Only host receipts are shown. Missing parent or registry data remains unknown; task completion does not imply resource release.')}</p>}
  </section>
}
export function AgentExecutionActions({store,runId,execution}:{store:WorkflowStore;runId:string;execution:NodeExecution}){
  const[open,setOpen]=useState(false),[stopping,setStopping]=useState(false),[error,setError]=useState('')
  if(!execution.executionId)return null
  const executionId=execution.executionId,canStop=(execution.status==='running'||execution.repair?.waiting)&&!!store.api.stopNode
  return <section className="vdw-agent-actions" aria-label="Agent 运行操作">
    <div className="vdw-actions"><Button disabled={!store.api.agentProcess} onClick={()=>setOpen(value=>!value)}>{open?'收起 Agent 过程':'查看 Agent 过程'}</Button>{canStop&&<Button disabled={stopping} onClick={()=>{setStopping(true);setError('');void store.stopExecution(runId,executionId).catch(error=>setError(String(error))).finally(()=>setStopping(false))}}>停止此 Agent</Button>}</div>
    {!store.api.agentProcess&&<p className="vdw-muted">当前宿主未提供 Agent 过程查询。</p>}
    {canStop&&<p className="vdw-muted">停止此任务后，依赖其结果的后续节点也会停止。</p>}
    {error&&<p className="vdw-error" role="alert">{error}</p>}
    {open&&<AgentProcessPanel key={`process:${runId}/${executionId}`} store={store} runId={runId} executionId={executionId}/>}
    {execution.repair&&<RepairOutputEditor key={`repair:${runId}/${executionId}`} store={store} runId={runId} execution={execution}/>}
  </section>
}

export function AgentProcessPanel({store,runId,executionId}:{store:WorkflowStore;runId:string;executionId:string}){
  const[process,setProcess]=useState<AgentProcessView>(),[loading,setLoading]=useState(true),[working,setWorking]=useState(false),[error,setError]=useState(''),[prompt,setPrompt]=useState(''),[feedback,setFeedback]=useState(''),[refresh,setRefresh]=useState(0)
  const submission=useRef<{text:string;id:string}>()
  useEffect(()=>{
    let current=true;setLoading(true);setError('')
    const method=store.api.agentProcess
    void (method?method.call(store.api,runId,executionId):Promise.reject(new Error('当前宿主未提供 Agent 过程查询'))).then(value=>{if(current)setProcess(value)}).catch(error=>{if(current)setError(String(error))}).finally(()=>{if(current)setLoading(false)})
    return()=>{current=false}
  },[store,runId,executionId,refresh])
  const send=async()=>{
    if(!process?.canSteer||!store.api.followupAgent||loading||working||!prompt.trim())return
    const text=prompt.trim()
    if(submission.current?.text!==text)submission.current={text,id:newId()}
    setWorking(true);setError('');setFeedback('')
    try{await store.followupAgent(runId,executionId,text,submission.current.id);setPrompt('');submission.current=undefined;setFeedback('补充指令已提交，实际接收结果见宿主记录。');setRefresh(value=>value+1)}catch(error){setError(error instanceof Error?error.message:String(error))}finally{setWorking(false)}
  }
  return <section className="vdw-config-group" aria-label="Agent 过程">
    <div className="vdw-actions"><strong>Agent 过程</strong><Button size="sm" disabled={loading||working} onClick={()=>setRefresh(value=>value+1)}>刷新过程</Button></div>
    <p className="vdw-muted">展示宿主提供的事件记录。点击刷新可读取后续进展。</p>
    {loading&&<p role="status">正在读取 Agent 过程…</p>}
    {process&&<>
      <p className="vdw-muted">任务：<code>{process.taskId||'未提供'}</code> · {process.status}</p>
      <NativeTaskLifecycle tasks={process.nativeTasks} executionId={executionId}/>
      <div className="vdw-agent-events">{process.events.map(event=><article className="vdw-agent-event" key={event.id}><small>{eventLabels[event.kind]} · {new Date(event.at).toLocaleString('zh-CN')}</small><p>{event.summary}</p></article>)}</div>
      {!process.events.length&&<p className="vdw-muted">宿主尚未提供可展示的过程事件。</p>}
      {!!process.messages.length&&<section aria-label="补充指令记录"><strong>补充指令记录</strong>{process.messages.map(message=><article className="vdw-agent-event" key={message.id}><small>{message.status==='accepted'?'已接收':'未接收'} · {new Date(message.createdAt).toLocaleString('zh-CN')}</small><p>{message.text}</p>{message.error&&<p className="vdw-error">{message.error}</p>}</article>)}</section>}
      <Field label="补充指令"><textarea aria-label="Agent 补充指令" rows={4} maxLength={20000} value={prompt} disabled={working||!process.canSteer||!store.api.followupAgent} onChange={event=>{setPrompt(event.target.value);setFeedback('')}} placeholder="为当前 Agent 补充约束或信息"/></Field>
      {!process.canSteer&&<p className="vdw-muted">{process.unavailableReason||'当前任务不能接收补充指令。'}</p>}
      {process.canSteer&&!store.api.followupAgent&&<p className="vdw-muted">当前宿主未提供补充指令接口。</p>}
      <Button disabled={loading||working||!process.canSteer||!store.api.followupAgent||!prompt.trim()} onClick={()=>void send()}>{working?'正在提交…':'发送补充指令'}</Button>
    </>}
    {feedback&&<p role="status">{feedback}</p>}{error&&<p className="vdw-error" role="alert">{error}</p>}
  </section>
}

export function parseRepairOutput(text:string):Record<string,JsonValue>{
  let value:JsonValue
  try{value=JSON.parse(text) as JsonValue}catch{throw new Error('请填写有效的 JSON 对象')}
  if(value===null||Array.isArray(value)||typeof value!=='object')throw new Error('修正后的输出须为 JSON 对象')
  return value
}
export function RepairOutputEditor({store,runId,execution}:{store:WorkflowStore;runId:string;execution:NodeExecution}){
  const repair=execution.repair,candidateText=JSON.stringify(repair?.candidate??{},null,2),[text,setText]=useState(()=>candidateText),[working,setWorking]=useState(false),[error,setError]=useState('')
  useEffect(()=>{setText(candidateText)},[candidateText,runId,execution.executionId])
  if(!repair||!execution.executionId)return null
  const used=execution.repairAttemptsUsed??repair.usedAttempts??repair.attempts.length
  const modelRepair=async()=>{
    if(!repair.waiting||execution.status!=='waiting'||working||!store.api.confirmRepairOutput||used>=repair.limit)return
    setWorking(true);setError('')
    try{await store.confirmRepairOutput(runId,execution.executionId!,used)}catch(error){setError(error instanceof Error?error.message:String(error))}finally{setWorking(false)}
  }
  const confirm=async()=>{
    if(!repair.waiting||execution.status!=='waiting'||working||!store.api.acceptRepairOutput)return
    setWorking(true);setError('')
    try{const output=parseRepairOutput(text);await store.acceptRepairOutput(runId,execution.executionId!,output)}catch(error){setError(error instanceof Error?error.message:String(error))}finally{setWorking(false)}
  }
  return <section className="vdw-config-group" aria-label="Agent 输出修正">
    <strong>{repair.waiting?'输出未通过验证，等待确认':'输出修正记录'}</strong>
    {repair.reason&&<p>{{confirmation:'等待用户确认输出修复',disabled:'此运行已关闭模型修复',budget:'旧运行修复已暂停',limit:'模型修复轮次已用完',unavailable:'模型修复未完成，保留已有候选'}[repair.reason]??repair.reason}</p>}
    <p className="vdw-muted">已使用模型修复 {used} / {repair.limit} 次。每次确认沿用同一修复轮次，不会重置已用次数。</p>
    {repair.attempts.map((attempt,index)=><details key={`${attempt.taskId??'attempt'}/${index}`}><summary>第 {index+1} 次尝试：{attempt.error}</summary>{attempt.taskId&&<p className="vdw-muted">任务：<code>{attempt.taskId}</code></p>}{attempt.candidate!==undefined&&<DataViewer title={`第 ${index+1} 次候选输出`} value={attempt.candidate}/>}</details>)}
    <DataViewer title={repair.waiting?'待修正的候选输出':'修正前的候选输出'} value={repair.candidate}/>
    {repair.waiting&&<>
      <p className="vdw-muted">允许一次模型修复只处理已有候选，工具为空；修复后仍暂停，由你继续根运行。</p>
      <Button disabled={working||execution.status!=='waiting'||!store.api.confirmRepairOutput||used>=repair.limit} onClick={()=>void modelRepair()}>允许一次模型修复</Button>
      {used>=repair.limit&&<p className="vdw-muted">本次节点的模型修复轮次已用完，可人工修正输出。</p>}
      <p className="vdw-muted">修正结构化输出并确认后，宿主会再次验证。验证通过才复用此节点结果并继续；不会重新执行原 Agent 动作。</p>
      <Field label="修正后的输出 JSON"><textarea aria-label="修正后的输出 JSON" rows={8} value={text} disabled={working||execution.status!=='waiting'||!store.api.acceptRepairOutput} onChange={event=>setText(event.target.value)}/></Field>
      <Button variant="primary" disabled={working||execution.status!=='waiting'||!store.api.acceptRepairOutput||!text.trim()} onClick={()=>void confirm()}>{working?'正在验证…':'确认修正输出并继续'}</Button>
      {!store.api.acceptRepairOutput&&<p className="vdw-muted">当前宿主尚不支持人工确认修正输出，可停止这次运行。</p>}
    </>}
    {error&&<p className="vdw-error" role="alert">{error}</p>}
  </section>
}
