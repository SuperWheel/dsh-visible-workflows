import { useId } from 'react'
import { Button, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { Glyph } from './icons.tsx'
import { useLocale } from './i18n.ts'
import { workflowRequestDialogStyles } from './workflow-request-dialog-style.ts'

export interface WorkflowRequestTarget { title:string;id:string;workspaceId:string }
export interface WorkflowRequestDialogProps {
  open:boolean
  target?:WorkflowRequestTarget
  value:string
  working?:boolean
  error?:string
  submitted?:boolean
  onChange:(value:string)=>void
  onClose:()=>void
  onSubmit:()=>void|Promise<void>
}

/** Only edits and submits a chat draft. The caller owns its target and lifecycle. */
export function WorkflowRequestDialog({open,target,value,working=false,error,submitted=false,onChange,onClose,onSubmit}:WorkflowRequestDialogProps){
  const {t}=useLocale(),id=useId(),count=Array.from(value).length
  if(!open)return null
  const close=()=>{if(!working)onClose()}
  const submit=()=>{if(!working&&value.trim())void onSubmit()}
  const targetLabel=target?t('目标工作流：{title}（编号：{id}）','Target workflow: {title} (ID: {id})',{title:target.title,id:target.id}):t('新建工作流','New workflow')
  return <Modal open headless title={t('交给 Agent','Ask Agent')} className="vdw-modal vdw-workflow-request-dialog" onClose={close}>
    <style>{workflowRequestDialogStyles}</style>
    <form className="vdw-workflow-request-form" aria-busy={working} onSubmit={event=>{event.preventDefault();submit()}}>
      <header className="vdw-workflow-request-heading"><h2>{t('交给 Agent','Ask Agent')}</h2><Tooltip label={t('关闭需求输入','Close requirements input')} portal side="bottom" maxWidth={300}><Button type="button" size="sm" className="vdw-request-close" aria-label={t('关闭需求输入','Close requirements input')} disabled={working} onClick={close}><Glyph name="close"/></Button></Tooltip></header>
      <div className="vdw-workflow-request-context"><span>{t('目标','Target')}</span>{target?<Tooltip label={`${target.title}\n${t('工作流编号：{id}','Workflow ID: {id}',{id:target.id})}\n${t('工作区：{workspace}','Workspace: {workspace}',{workspace:target.workspaceId})}`} portal side="bottom" maxWidth={300}><span className="vdw-workflow-request-target" tabIndex={0} aria-label={targetLabel}><span aria-hidden="true">@</span><span>{target.title}</span></span></Tooltip>:<span className="vdw-workflow-request-target">{targetLabel}</span>}</div>
      <section className="vdw-prompt-editor vdw-workflow-request-editor" aria-label={t('工作流设计需求','Workflow requirements')}>
        <div className="vdw-prompt-header vdw-workflow-request-editor-heading"><label htmlFor={`${id}-request`}>{t('需求','Requirements')}</label><small aria-label={t('{count} 个字符','{count} characters',{count})}>{count} {t('字符','characters')}</small></div>
        <textarea id={`${id}-request`} className="vdw-prompt-body" data-modal-autofocus aria-label={t('工作流设计需求','Workflow requirements')} aria-describedby={`${id}-hint${error?` ${id}-error`:''}`} aria-invalid={!!error} rows={8} value={value} disabled={working} placeholder={target?t('描述希望怎样调整这个工作流…','Describe how you would like to change this workflow…'):t('描述工作流的输入、处理步骤和预期结果…','Describe the inputs, steps and expected results of your workflow…')} onChange={event=>{if(!working)onChange(event.target.value)}}/>
      </section>
      {error&&<p id={`${id}-error`} role="alert" className="vdw-workflow-request-error">{error}</p>}
      <footer className="vdw-workflow-request-footer"><p id={`${id}-hint`}>{t('内容仅同步到聊天草稿，由你确认后发送。','This content is added to the chat draft for you to review and send.')}</p><div><Button type="button" variant="outline" size="sm" disabled={working} onClick={close}>{t('取消','Cancel')}</Button><Button type="submit" variant="primary" size="sm" disabled={working||!value.trim()} aria-busy={working}>{working?t('正在提交…','Adding to draft…'):submitted?t('更新聊天草稿','Update chat draft'):t('提交到聊天草稿','Add to chat draft')}</Button></div></footer>
    </form>
  </Modal>
}
