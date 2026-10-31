import { useState } from 'react'
import { Button, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Workflow } from '../shared/types.ts'
import { Glyph, WorkflowIcon } from './icons.tsx'
import { useLocale } from './i18n.ts'

/** The ellipsis and context click intentionally open the same actions and handlers. */
export function WorkflowHomeCard({workflow,workspaceName,status,onOpen,onCopy,onExport,onArchive,onManage}:{workflow:Workflow;workspaceName:string;status:string;onOpen:()=>void;onCopy:()=>void;onExport:()=>void;onArchive:()=>void;onManage?:()=>void}){
  const {t,locale}=useLocale(),[open,setOpen]=useState(false),[point,setPoint]=useState<{x:number;y:number}>()
  const englishStatus:Record<string,string>={'等待输入':'Awaiting input','运行中':'Running','已暂停':'Paused','暂停中':'Pausing','旧运行已暂停':'Legacy run paused','已完成':'Completed','失败':'Failed','已取消':'Cancelled','已中断':'Interrupted','等待执行':'Pending','已跳过':'Skipped'}
  return <article className="vdw-flow-card" data-workflow-id={workflow.id} onContextMenu={event=>{event.preventDefault();event.stopPropagation();setPoint({x:event.clientX,y:event.clientY});setOpen(true)}}>
    <button className="vdw-card-open" onClick={onOpen}><span className="vdw-card-icon"><WorkflowIcon size={23}/></span><strong>{workflow.title}</strong><p>{workflow.description||t('可编辑、复用的工作流','An editable, reusable workflow')}</p><div><span>{workspaceName}</span><span>{t(status,englishStatus[status])}</span></div><small>{t('{date} 更新 · {count} 个节点','Updated {date} · {count} nodes',{date:new Date(workflow.updatedAt).toLocaleString(locale,{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}),count:workflow.nodes.length})}</small></button>
    <Menu className="vdw-card-menu" listClassName="vdw-menu" portal align="end" open={open} onClose={()=>{setOpen(false);setPoint(undefined)}} {...(point?{getAnchorRect:()=>new DOMRect(point.x,point.y,1,1)}:{})} anchor={<Tooltip label={t('工作流更多操作','More workflow actions')} portal side="bottom"><Button size="sm" aria-label={t('工作流更多操作','More workflow actions')} aria-haspopup="menu" aria-expanded={open} onClick={()=>{setPoint(undefined);setOpen(!open)}}><Glyph name="more"/></Button></Tooltip>} items={[...(onManage?[{id:'manage',label:t('管理工作流','Manage workflow')}]:[]),{id:'copy',label:t('复制工作流','Duplicate workflow')},{id:'export',label:t('导出工作流','Export workflow')},{id:'delete',label:t('归档工作流','Archive workflow'),danger:true}]} onSelect={id=>{setOpen(false);setPoint(undefined);if(id==='manage')onManage?.();else if(id==='copy')onCopy();else if(id==='export')onExport();else if(id==='delete')onArchive()}}/>
  </article>
}
