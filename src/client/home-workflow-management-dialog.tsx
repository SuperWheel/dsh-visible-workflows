import { useRef, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLocale } from './i18n.ts'
import { WorkflowManagementContent, type WorkflowManagementDetails } from './workflow-management.tsx'
import { workflowManagementStyles } from './workflow-management-style.ts'

export interface HomeWorkflowManagementDialogProps {
  open:boolean
  details:WorkflowManagementDetails
  revision?:number
  saving?:boolean
  onClose:()=>void
  onSaveAs?:()=>void
}

/** Home edits a selected definition independently from the active canvas. */
export function HomeWorkflowManagementDialog({open,details,revision=details.revision??0,saving=false,onClose,onSaveAs}:HomeWorkflowManagementDialogProps){
  const {t}=useLocale(),[busy,setBusy]=useState(false),locked=useRef(false)
  locked.current=busy||saving
  if(!open)return null
  const close=()=>{if(!locked.current)onClose()}
  return <Modal open headless title={t('管理工作流','Manage workflow')} className="vdw-modal vdw-workflow-management vdw-home-workflow-management" onClose={close}>
    <style>{workflowManagementStyles}</style>
    <WorkflowManagementContent key={details.workflowId} details={details} revision={revision} saving={saving} onClose={close} onBusyChange={next=>{locked.current=next||saving;setBusy(next)}} onSaveAs={onSaveAs} showSaveFeedback/>
  </Modal>
}
