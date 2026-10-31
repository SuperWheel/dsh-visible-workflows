import { useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Workflow } from '../shared/types.ts'
import type { WorkflowStore } from './store.ts'

export function WorkflowArchive({store,onClose}:{store:WorkflowStore;onClose:()=>void}) {
  const [flows,setFlows]=useState<Workflow[]>([]),[loading,setLoading]=useState(true),[working,setWorking]=useState(''),[error,setError]=useState('')
  useEffect(()=>{let live=true;void store.api.archived?.('').then(items=>{if(live)setFlows(items)}).catch(e=>{if(live)setError(String(e))}).finally(()=>{if(live)setLoading(false)});return()=>{live=false}},[store])
  const restore=async(flow:Workflow)=>{setWorking(flow.id);setError('');try{if(!store.api.restore)throw new Error('当前宿主不支持恢复归档');await store.api.restore(flow.id);setFlows(items=>items.filter(item=>item.id!==flow.id));await store.load()}catch(e){setError(String(e))}finally{setWorking('')}}
  return <Modal open title="已归档工作流" closeLabel="关闭归档列表" className="vdw-modal" onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}><p className="vdw-muted">恢复流程定义和归属。原有运行记录保留；不会恢复已撤销的凭据授权，也不会更改外部文件。</p>{loading?<p>正在读取归档…</p>:flows.length?<div className="vdw-archive-list">{flows.map(flow=><article key={flow.id} className="vdw-json-summary"><strong>{flow.title}</strong><p className="vdw-muted">{new Date(flow.updatedAt).toLocaleString('zh-CN')} · {flow.nodes.length} 个主图节点</p><Button disabled={!!working} onClick={()=>void restore(flow)}>{working===flow.id?'恢复中…':'恢复工作流'}</Button></article>)}</div>:<p>没有已归档的工作流。</p>}{error&&<p className="vdw-error" role="alert">{error}</p>}</Modal>
}
