import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLocale } from './i18n.ts'
import { workflowLeaveDialogStyles } from './workflow-leave-dialog-style.ts'

export interface WorkflowLeaveDialogProps {
  workflowTitle?:string
  working?:boolean
  error?:string
  onCancel:()=>void
  onDiscard:()=>void
  onSave:()=>void
}
/** This surface only confirms intent; the caller owns saving and navigation. */
export function WorkflowLeaveDialog({workflowTitle,working=false,error,onCancel,onDiscard,onSave}:WorkflowLeaveDialogProps){
  const {t}=useLocale()
  return <Modal open title={t('保存工作流更改？','Save workflow changes?')} closeLabel={t('取消返回主页','Cancel returning home')} className="vdw-modal vdw-leave-dialog" onClose={()=>{if(!working)onCancel()}} footer={<>
    <Button disabled={working} onClick={onCancel}>{t('取消','Cancel')}</Button>
    <Button disabled={working} onClick={onDiscard}>{t('不保存并返回','Discard and return')}</Button>
    <Button variant="primary" disabled={working} aria-busy={working} onClick={onSave}>{t('保存并返回','Save and return')}</Button>
  </>}>
    <style>{workflowLeaveDialogStyles}</style>
    <p className="vdw-leave-message">{workflowTitle&&<strong className="vdw-leave-workflow-title">{workflowTitle}</strong>}{t('返回主页前，是否保存当前画布的未保存更改？','Save the unsaved changes on this canvas before returning home?')}</p>
    {error&&<p className="vdw-error vdw-leave-error" role="alert">{error}</p>}
  </Modal>
}
