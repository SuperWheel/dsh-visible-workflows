import { useState, type ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkflowExecutionPolicy } from '../shared/types.ts'
import { Field, Select } from './controls.tsx'
import { useWorkflowStore, type WorkflowStore } from './store.ts'
import { useLocale } from './i18n.ts'

const fields:{key:Exclude<keyof WorkflowExecutionPolicy,'repairMode'|'httpCacheImmediateCleanup'|'httpCacheLimitMB'>;label:string;english:string;help:string;englishHelp:string;min:number;max:number}[]=[
  {key:'maxConcurrentAgents',label:'Agent 并发上限',english:'Concurrent agents',help:'默认 3；Agent 与模型调用共享并发槽',englishHelp:'Default: 3. Agents and model calls share concurrency slots.',min:1,max:8},
  {key:'maxRepairAttempts',label:'最大修复轮次',english:'Maximum repair attempts',help:'默认最多 2 轮输出修复；0 表示关闭',englishHelp:'Default: up to 2 output repairs. Set 0 to disable.',min:0,max:2},
]
function ExecutionPolicyForm({store,onSaved,render}:{store:WorkflowStore;onSaved?:()=>void;render:(body:ReactNode,actions:ReactNode,working:boolean)=>ReactNode}) {
  const state=useWorkflowStore(store),flow=state.workflow!,{t}=useLocale(),[draft,setDraft]=useState<Partial<Record<keyof WorkflowExecutionPolicy,string>>>(Object.fromEntries(fields.map(field=>[field.key,String(flow.executionPolicy?.[field.key]??'')]))),[repairMode,setRepairMode]=useState<'confirm'|'auto'>(flow.executionPolicy?.repairMode??'confirm'),[error,setError]=useState(''),[feedback,setFeedback]=useState(''),[working,setWorking]=useState(false)
  const save=async()=>{setError('');setFeedback('');setWorking(true);try{const current=store.getSnapshot().workflow;if(!current||current.id!==flow.id)throw new Error(t('当前工作流已变化，请重新打开执行策略。','The current workflow changed. Reopen execution policy settings.'));const policy:WorkflowExecutionPolicy={...current.executionPolicy,repairMode};delete policy.httpCacheLimitMB;delete policy.httpCacheImmediateCleanup;for(const field of fields){delete policy[field.key];const value=draft[field.key]?.trim();if(!value)continue;const number=Number(value);if(!Number.isInteger(number)||number<field.min||number>field.max)throw new Error(t('{label}须为 {min}–{max} 的整数','{label} must be an integer from {min} to {max}',{label:t(field.label,field.english),min:field.min,max:field.max}));policy[field.key]=number}store.edit({...current,executionPolicy:policy});await store.save();if(store.getSnapshot().workflow?.id===current.id){setFeedback(t('已保存','Saved'));onSaved?.()}}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setWorking(false)}}
  const reset=()=>{setDraft({});setRepairMode('confirm');setError('');setFeedback('')}
  const body=<><p className="vdw-muted">{t('配置用于后续新运行。并发与修复轮次限制继续生效。','Applies to future runs. Concurrency and repair-attempt limits remain in effect.')}</p><div className="vdw-policy-fields"><Field label={t('输出修复策略','Output repair policy')} help={t('独立运行默认先确认；自动修复仅在宿主确认 Agent 参与或用户授权排查时生效。修改画布配置不能授予自动修复权限。','Standalone runs ask first. Automatic repair requires host confirmation of agent involvement or explicit diagnostics authorization. This setting does not grant that authorization.')}><Select label={t('输出修复策略','Output repair policy')} value={repairMode} options={[{id:'confirm',label:t('A · 先确认再修复','A · Confirm before repair')},{id:'auto',label:t('B · 授权范围内自动修复','B · Repair within authorization')}]} onChange={value=>{setRepairMode(value as 'confirm'|'auto');setFeedback('')}}/></Field>{fields.map(field=><Field key={field.key} label={t(field.label,field.english)} help={t(field.help,field.englishHelp)}><Input aria-label={t(field.label,field.english)} type="number" min={field.min} max={field.max} step={1} placeholder={t('使用默认策略','Use default')} value={draft[field.key]??''} onChange={e=>{setDraft({...draft,[field.key]:e.target.value});setFeedback('')}}/></Field>)}</div>{error&&<p role="alert" className="vdw-error">{error}</p>}{feedback&&<p role="status" className="vdw-muted">{feedback}</p>}</>
  return render(body,<><Button disabled={working} onClick={reset}>{t('重置','Reset')}</Button><Button variant="primary" disabled={working} onClick={()=>void save()}>{working?t('保存中…','Saving…'):t('保存','Save')}</Button></>,working)
}
export function ExecutionPolicyPanel({store}:{store:WorkflowStore}) {
  const {t}=useLocale(),state=useWorkflowStore(store)
  return <ExecutionPolicyForm key={state.workflow?.id} store={store} render={(body,actions)=><section className="vdw-execution-policy-panel" aria-label={t('执行策略设置','Execution policy settings')}>{body}<div className="vdw-actions vdw-policy-actions">{actions}</div></section>}/>
}
export function ExecutionPolicyDialog({store,onClose}:{store:WorkflowStore;onClose:()=>void}) {
  const {t}=useLocale(),state=useWorkflowStore(store)
  return <ExecutionPolicyForm key={state.workflow?.id} store={store} onSaved={onClose} render={(body,actions,working)=><Modal open title={t('执行策略','Execution policy')} closeLabel={t('关闭执行策略','Close execution policy')} className="vdw-modal" onClose={()=>!working&&onClose()} footer={<><Button disabled={working} onClick={onClose}>{t('取消','Cancel')}</Button>{actions}</>}>{body}</Modal>}/>
}
