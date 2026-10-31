import { useId, useRef, useState, type ReactNode } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { Glyph } from './icons.tsx'
import { useLocale } from './i18n.ts'
import { WorkflowManagement, type WorkflowManagementDetails } from './workflow-management.tsx'

export interface EditorHeadingProps {
  title:string
  revision:number
  saveState:'saved'|'dirty'|'saving'|'error'
  onSave?:()=>void
  onSaveAs?:()=>void
  savedAt?:number
  onBack:()=>void
  onReturnToChat?:()=>void
  breadcrumb?:ReactNode
  management?:WorkflowManagementDetails
}
const saveLabels={saved:'已保存',dirty:'有未保存的修改',saving:'正在保存',error:'保存失败'} as const

/** Independent floating controls; measuring the header includes its breadcrumb. */
export function EditorHeading({title,revision,saveState,onBack,onReturnToChat,breadcrumb,onSave,onSaveAs,savedAt,management}:EditorHeadingProps){
  const {t}=useLocale()
  const managementId=useId(),trigger=useRef<HTMLButtonElement>(null)
  const [openManagementId,setOpenManagementId]=useState<string|null>(null),[managementBusy,setManagementBusy]=useState(false)
  const managementOpen=!!management&&openManagementId===management.workflowId
  const closeManagement=(restoreFocus=false)=>{setOpenManagementId(null);if(restoreFocus)trigger.current?.focus({preventScroll:true})}
  const status=`${t(saveLabels[saveState])} · v${revision}`
  const feedback=(saveState==='saving'||savedAt&&saveState==='saved')?<span key={saveState==='saving'?'saving':savedAt} className="vdw-save-feedback" data-state={saveState} aria-hidden="true">{saveState==='saving'&&<span className="vdw-save-spinner"><Glyph name="loop" size={14}/></span>}{t(saveState==='saving'?'正在保存':'已保存')}</span>:undefined
  const name=<strong className="vdw-editor-name" title={title}>{title}</strong>
  return <header className="vdw-editor-heading vdw-editor-heading-floating" data-management-open={managementOpen||undefined} aria-label={t('工作流导航','Workflow navigation')}>
    <div className="vdw-editor-heading-row">
      <Tooltip label={t('返回工作流主页','Back to workflows')} portal side="bottom"><Button type="button" size="sm" className="vdw-editor-back" aria-label={t('返回工作流主页','Back to workflows')} icon={<Glyph name="back" size={16}/>} onClick={onBack}/></Tooltip>
      <div className="vdw-editor-title-card" data-management={!!management||undefined}>
        {management?<button ref={trigger} type="button" className="vdw-editor-title-trigger" aria-label={t('工作流信息：{title}','Workflow details: {title}',{title})} aria-haspopup="dialog" aria-expanded={managementOpen} aria-controls={managementOpen?managementId:undefined} aria-describedby={`${managementId}-status`} disabled={managementBusy} onClick={()=>setOpenManagementId(managementOpen?null:management.workflowId)}>{name}<Tooltip label={status} portal side="bottom"><span className="vdw-editor-status-indicator" aria-hidden="true"><span className="vdw-editor-status-dot" data-state={saveState}/></span></Tooltip></button>:<>{name}<Tooltip label={status} portal side="bottom"><span className="vdw-editor-status-indicator" role="img" aria-label={status} tabIndex={0}><span className="vdw-editor-status-dot" data-state={saveState} aria-hidden="true"/></span></Tooltip></>}
        <small id={`${managementId}-status`} className="vdw-editor-save-state" data-state={saveState} role="status" aria-live="polite" aria-atomic="true">{status}</small>
      </div>
      {(onSave||onSaveAs)&&<div className="vdw-editor-save-actions" role="group" aria-label={t('保存操作','Save actions')}>
        {onSave&&<Tooltip label={t('保存（⌘S / Ctrl+S）','Save (⌘S / Ctrl+S)')} portal side="bottom"><Button type="button" size="sm" className="vdw-editor-save" aria-label={t('保存工作流','Save workflow')} aria-busy={saveState==='saving'} disabled={saveState==='saving'} onClick={onSave}><span className={saveState==='saving'?'vdw-save-spinner':undefined}><Glyph name={saveState==='saving'?'loop':'save'} size={16}/></span></Button></Tooltip>}
        {onSaveAs&&<Tooltip label={t('另存为（⌘⇧S / Ctrl+Shift+S）','Save as (⌘⇧S / Ctrl+Shift+S)')} portal side="bottom"><Button type="button" size="sm" className="vdw-editor-save" aria-label={t('工作流另存为','Save workflow as')} disabled={saveState==='saving'} onClick={onSaveAs}><Glyph name="save-as" size={16}/></Button></Tooltip>}
      </div>}
      {onReturnToChat&&<Tooltip label={t('返回对话','Back to conversation')} portal side="bottom"><Button type="button" size="sm" className="vdw-editor-conversation" aria-label={t('返回对话','Back to conversation')} icon={<Glyph name="comment" size={16}/>} onClick={onReturnToChat}/></Tooltip>}
    </div>
    {breadcrumb&&<nav className="vdw-editor-heading-path" aria-label={t('工作流路径','Workflow path')}>{breadcrumb}</nav>}
    {managementOpen?<WorkflowManagement key={management.workflowId} id={managementId} details={management} revision={revision} saving={saveState==='saving'} triggerRef={trigger} onClose={closeManagement} onBusyChange={setManagementBusy} onSaveAs={onSaveAs} feedback={feedback}/>:feedback}
  </header>
}
