import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkflowStore } from './store.ts'
import type { CanvasAnnotation } from './canvas.tsx'
import { Glyph } from './icons.tsx'
import { useLocale } from './i18n.ts'
import { TemplateDialog } from './workflow-templates.tsx'
import { WorkflowImportContent } from './workflow-transfer.tsx'
import { useWorkflowPanelDismiss, workflowLibraryStyles } from './workflow-library-style.ts'

const TABS=[{id:'templates',label:'工作流模板'},{id:'import',label:'导入'}] as const
export function WorkflowLibraryPanel({store,annotations,initialTab='templates',onClose,presentation='canvas'}:{store:WorkflowStore;presentation?:'canvas'|'home';annotations?:readonly CanvasAnnotation[];initialTab?:'templates'|'import';onClose:()=>void}){
  const {t}=useLocale()
  const [tab,setTab]=useState(initialTab),[busy,setBusy]=useState(false),ref=useRef<HTMLElement>(null)
  useWorkflowPanelDismiss(ref,onClose,busy,presentation==='canvas')
  useEffect(()=>{if(!busy)setTab(initialTab)},[initialTab])
  const content=<>
    <style>{workflowLibraryStyles}</style>
    <div className="vdw-picker-heading"><div className="vdw-picker-tabs" role="tablist" aria-label={t('工作流模板与导入目录','Workflow template and import tabs')} onKeyDown={event=>{if(busy)return;const index=TABS.findIndex(item=>item.id===tab),next=event.key==='ArrowRight'?(index+1)%TABS.length:event.key==='ArrowLeft'?(index+TABS.length-1)%TABS.length:event.key==='Home'?0:event.key==='End'?TABS.length-1:-1;if(next<0)return;event.preventDefault();setTab(TABS[next]!.id);event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus()}}>{TABS.map(item=><button type="button" role="tab" aria-selected={tab===item.id} tabIndex={tab===item.id?0:-1} key={item.id} disabled={busy} onClick={()=>setTab(item.id)}>{item.id==='templates'?t('工作流模板','Workflow templates'):t('导入','Import')}</button>)}</div><Button size="sm" className="vdw-icon-button" aria-label={t('关闭工作流模板与导入','Close workflow templates and import')} disabled={busy} onClick={onClose}><Glyph name="close"/></Button></div>
    {tab==='templates'?<TemplateDialog store={store} onClose={onClose} onBusyChange={setBusy}/>:<WorkflowImportContent store={store} annotations={annotations} onClose={onClose} onBusyChange={setBusy}/>}
  </>
  return presentation==='home'?<Modal open headless title={t('工作流模板与导入','Workflow templates and import')} className={`vdw-modal vdw-workflow-library vdw-home-workflow-modal vdw-library-view-${tab}`} onClose={()=>{if(!busy)onClose()}}>{content}</Modal>:<section ref={ref} className="vdw-node-picker vdw-workflow-library" data-vdw-view={tab} aria-label={t('工作流模板与导入','Workflow templates and import')} onPointerDown={event=>event.stopPropagation()}>{content}</section>
}
