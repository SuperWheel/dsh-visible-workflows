import { useRef, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Workflow } from '../shared/types.ts'
import { SECRET_UNAVAILABLE_REASON } from '../shared/workflow-variables.ts'
import { Field } from './controls.tsx'
import { useWorkflowStore, type WorkflowStore } from './store.ts'
import { parseSecretBoundaryReport } from '../shared/secret-boundary.ts'

export const missingRunEnvironment=(flow:Workflow,deferSecretCheck=false)=>(flow.environmentVariables??[]).filter(variable=>variable.required&&(variable.type==='secret'?!deferSecretCheck:variable.value===undefined))
/** This only defers presence checking to the Host; it never asserts a binding or grant. */
export function canDeferRunSecretCheck(store:WorkflowStore):boolean {
  const state=store.getSnapshot()
  if(!store.api.openSecretManager||state.secretBoundaryState!=='ready')return false
  try{const report=parseSecretBoundaryReport(state.secretBoundaryReport);return (report.schemaVersion===2||report.schemaVersion===4)&&report.available}catch{return false}
}
export async function prepareRunEnvironment(store:WorkflowStore,intent:{workflowId:string;sessionId?:string}){
  const unchanged=()=>{const current=store.getSnapshot();if(current.workflow?.id!==intent.workflowId||current.sessionId!==intent.sessionId)throw new Error('流程或对话已变化，请重新运行');return current.workflow}
  unchanged();await store.flush();const workflow=unchanged(),workspaceId=workflow.workspaceId
  if(workflow.environmentVariables?.some(variable=>variable.required&&variable.type==='secret'))await store.refreshSecretBoundary()
  const latest=unchanged()
  if(latest!==workflow||latest.workspaceId!==workspaceId)throw new Error('流程配置已变化，请重新运行')
  const deferSecretCheck=canDeferRunSecretCheck(store)
  return {workflow,sessionId:intent.sessionId,intent,deferSecretCheck,missing:missingRunEnvironment(workflow,deferSecretCheck)}
}
/** Ordinary settings only. This form must never accept or persist Secret values. */
export function fillRunEnvironment(flow:Workflow,values:Record<string,string>,deferSecretCheck=false):Workflow {
  const missing=missingRunEnvironment(flow,deferSecretCheck)
  if(missing.some(variable=>variable.type==='secret'))throw new Error(SECRET_UNAVAILABLE_REASON)
  const next=structuredClone(flow)
  for(const variable of next.environmentVariables??[]){
    if(!missing.some(item=>item.id===variable.id)||variable.type==='secret')continue
    if(!Object.hasOwn(values,variable.id))throw new Error(`请填写 ${variable.name}`)
    const value=values[variable.id]!
    if(variable.type==='number'){
      if(!value.trim()||!Number.isFinite(Number(value)))throw new Error(`${variable.name} 必须为有限数值`)
      variable.value=Number(value)
    }else variable.value=value
    variable.revision=(variable.revision??0)+1
  }
  return next
}

export function RunEnvironmentDialog({store,workflow,sessionId,onClose,onStarted}:{store:WorkflowStore;workflow:Workflow;sessionId?:string;onClose:()=>void;onStarted:()=>void}) {
  const state=useWorkflowStore(store)
  const [values,setValues]=useState<Record<string,string>>({}),[error,setError]=useState(''),[busy,setBusy]=useState(false),locked=useRef(false)
  const deferSecretCheck=canDeferRunSecretCheck(store),missing=missingRunEnvironment(workflow,deferSecretCheck),blocked=missing.some(variable=>variable.type==='secret'),hasSecret=workflow.environmentVariables?.some(variable=>variable.required&&variable.type==='secret')
  const save=async()=>{
    if(locked.current)return
    locked.current=true;setBusy(true);setError('')
    try{
      const current=store.getSnapshot()
      if(current.workflow?.id!==workflow.id||current.workflow.revision!==workflow.revision||current.sessionId!==sessionId)throw new Error('流程或对话已变化，请取消后重新运行')
      const checked=await prepareRunEnvironment(store,{workflowId:workflow.id,sessionId})
      store.edit(fillRunEnvironment(checked.workflow,values,checked.deferSecretCheck))
      if(hasSecret&&!canDeferRunSecretCheck(store))throw new Error(SECRET_UNAVAILABLE_REASON)
      await store.execute({},{workflowId:workflow.id,sessionId});onStarted();onClose()
    }catch(error){setError(error instanceof Error?error.message:String(error))}finally{locked.current=false;setBusy(false)}
  }
  return <Modal open title="补齐运行配置" closeLabel="取消本次运行" className="vdw-modal" onClose={()=>!busy&&onClose()} footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={busy||blocked} onClick={()=>void save()}>{busy?'正在继续…':'保存并继续运行'}</Button></>}>
    <p>补齐以下配置后继续本次运行。当前尚未创建运行记录。</p>
    <p className="vdw-muted">普通配置可被 Agent 读取，请勿填写密钥或密码。</p>
    {hasSecret&&<><p className="vdw-muted">{deferSecretCheck?'Secret 配置与自动使用授权由宿主在运行前检查；有效授权期间无需重复认证。':'Secret 代理尚未通过启动检查，不能继续运行。'}</p><Button size="sm" disabled={busy||state.secretBoundaryState==='loading'} onClick={()=>void store.refreshSecretBoundary()}>{state.secretBoundaryState==='loading'?'检查中…':'重新检查 Secret 可用性'}</Button></>}
    {missing.map(variable=>variable.type==='secret'?<p role="note" key={variable.id}>{variable.name}：{SECRET_UNAVAILABLE_REASON}</p>:<Field key={variable.id} label={variable.name} help={variable.description}><Input aria-label={`运行配置 ${variable.name}`} type={variable.type==='number'?'number':'text'} value={values[variable.id]??''} disabled={busy} onChange={event=>setValues(previous=>({...previous,[variable.id]:event.target.value}))}/>{variable.type==='string'&&!Object.hasOwn(values,variable.id)&&<Button size="sm" onClick={()=>setValues(previous=>({...previous,[variable.id]:''}))}>使用空字符串</Button>}</Field>)}
    {error&&<p role="alert" className="vdw-error">{error}</p>}
  </Modal>
}
