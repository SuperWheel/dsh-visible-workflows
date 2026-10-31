import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Button, Input, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { Glyph } from './icons.tsx'
import { useLocale } from './i18n.ts'
import { Select } from './controls.tsx'
import { WorkflowManagementHelp } from './workflow-management-help.tsx'

export type WorkflowManagementScope='workspace'|'global'

export interface WorkflowManagementDetails {
  workflowId:string
  title:string
  description?:string
  workspaceName?:string
  workspaceId?:string
  scope?:WorkflowManagementScope
  revision?:number
  nodeCount:number
  edgeCount:number
  updatedAt?:string|number
  onSaveDetails:(title:string,description:string,scope?:WorkflowManagementScope)=>Promise<void>
  onExport:()=>void
}

interface WorkflowManagementContentProps {
  details:WorkflowManagementDetails
  revision:number
  saving:boolean
  onClose:(restoreFocus?:boolean)=>void
  onBusyChange:(busy:boolean)=>void
  onSaveAs?:()=>void
  showSaveFeedback?:boolean
}

/** The same drafts and validation back both canvas and home management surfaces. */
export function WorkflowManagementContent({details,revision,saving,onClose,onBusyChange,onSaveAs,showSaveFeedback=false}:WorkflowManagementContentProps){
  const {t,locale}=useLocale(),fieldId=useId()
  const [title,setTitle]=useState(details.title),[description,setDescription]=useState(details.description??'')
  const [scope,setScope]=useState<WorkflowManagementScope>(details.scope??'workspace')
  const [baseline,setBaseline]=useState({title:details.title,description:details.description??'',scope:details.scope??'workspace'})
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[copyState,setCopyState]=useState<'copied'|'failed'|''>('')
  const [saved,setSaved]=useState(false),pending=useRef(false),locked=useRef(false)
  locked.current=busy||saving
  const changed=title!==baseline.title||description!==baseline.description||scope!==baseline.scope
  const dismiss=(restoreFocus=false)=>{if(!locked.current)onClose(restoreFocus)}

  const save=async()=>{
    if(pending.current||locked.current||!changed)return
    const normalizedTitle=title.trim()
    if(!normalizedTitle){setError(t('名称不能为空。','A workflow name is required.'));return}
    pending.current=true;locked.current=true;setBusy(true);onBusyChange(true);setError('');setSaved(false)
    try{await details.onSaveDetails(normalizedTitle,description,scope);setTitle(normalizedTitle);setBaseline({title:normalizedTitle,description,scope});setSaved(true)}
    catch(cause){setError(cause instanceof Error?cause.message:t('无法保存工作流信息，请重试。','Could not save workflow details. Try again.'))}
    finally{pending.current=false;setBusy(false);onBusyChange(false)}
  }
  const copyId=async()=>{
    try{if(!globalThis.navigator?.clipboard?.writeText)throw new Error();await navigator.clipboard.writeText(details.workflowId);setCopyState('copied')}
    catch{setCopyState('failed')}
  }
  const timestamp=details.updatedAt===undefined?NaN:new Date(details.updatedAt).getTime()
  const updatedAt=Number.isFinite(timestamp)?new Intl.DateTimeFormat(locale==='en'?'en':'zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(timestamp):t('未记录','Not recorded')
  return <>
      <div className="vdw-workflow-management-heading"><div><small id={`${fieldId}-heading`}>{t('工作流信息','Workflow details')}</small><strong>{details.title}</strong></div><Tooltip label={t('关闭工作流信息','Close workflow details')} portal side="bottom" maxWidth={300}><Button type="button" size="sm" className="vdw-management-icon" aria-label={t('关闭工作流信息','Close workflow details')} disabled={busy||saving} onClick={()=>dismiss(true)}><Glyph name="close"/></Button></Tooltip></div>
      <form className="vdw-workflow-management-form" aria-busy={busy} onSubmit={event=>{event.preventDefault();void save()}}>
        <div className="vdw-management-field"><label>{t('工作流编号','Workflow ID')}</label><div className="vdw-management-identity"><code>{details.workflowId}</code><Tooltip label={t('复制工作流编号','Copy workflow ID')} portal side="bottom" maxWidth={300}><Button type="button" size="sm" className="vdw-management-icon" aria-label={t('复制工作流编号','Copy workflow ID')} onClick={()=>void copyId()}><Glyph name="copy"/></Button></Tooltip></div>{copyState&&<small role="status">{copyState==='copied'?t('已复制工作流编号','Workflow ID copied'):t('复制失败，请选择编号复制。','Copy failed. Select the workflow ID to copy it.')}</small>}</div>
        <div className="vdw-management-primary-fields">
        <div className="vdw-management-field"><label htmlFor={`${fieldId}-name`}>{t('名称','Name')}</label><Input id={`${fieldId}-name`} aria-label={t('工作流名称','Workflow name')} data-modal-autofocus value={title} disabled={busy||saving} aria-invalid={!title.trim()} onChange={event=>{if(locked.current)return;setTitle(event.target.value);setError('');setSaved(false)}}/>{!title.trim()&&<small className="vdw-error">{t('名称不能为空。','A workflow name is required.')}</small>}</div>
        <div className="vdw-management-field"><div className="vdw-management-field-label"><label>{t('使用范围','Availability')}</label><WorkflowManagementHelp text={scope==='global'?t('可在所有工作区使用，所属工作区保持不变。','Available in all workspaces. The owner workspace remains unchanged.'):t('仅在所属工作区显示。','Visible only in its owner workspace.')}/></div><Select label={t('工作流使用范围','Workflow availability')} value={scope} disabled={busy||saving} options={[{id:'workspace',label:t('当前工作区','Current workspace')},{id:'global',label:t('全局','Global')}]} onChange={next=>{if(locked.current||(next!=='workspace'&&next!=='global'))return;setScope(next);setError('');setSaved(false)}}/></div>
        </div>
        <div className="vdw-management-field"><label htmlFor={`${fieldId}-description`}>{t('说明','Description')}</label><textarea id={`${fieldId}-description`} aria-label={t('工作流说明','Workflow description')} rows={3} value={description} disabled={busy||saving} onChange={event=>{if(locked.current)return;setDescription(event.target.value);setError('');setSaved(false)}}/></div>
        <dl className="vdw-workflow-management-facts"><div><dt>{t('所属工作区','Owner workspace')}</dt><dd>{details.workspaceName||details.workspaceId||t('未指定','Not specified')}</dd></div><div><dt>{t('版本','Version')}</dt><dd>v{details.revision??revision}</dd></div><div><dt>{t('节点数','Nodes')}</dt><dd>{details.nodeCount}</dd></div><div><dt>{t('连线数','Connections')}</dt><dd>{details.edgeCount}</dd></div><div className="vdw-management-updated"><dt>{t('最后更新','Last updated')}</dt><dd>{updatedAt}</dd></div></dl>
        {error&&<p role="alert" className="vdw-management-error">{error}</p>}
        {showSaveFeedback&&saved&&!changed&&<small role="status" className="vdw-management-saved">{t('已保存','Saved')}</small>}
        <div className="vdw-management-save-actions"><Button type="button" variant="outline" size="sm" disabled={busy||saving} onClick={()=>dismiss(true)}>{t('取消','Cancel')}</Button><Button type="submit" variant="primary" size="sm" disabled={busy||saving||!changed||!title.trim()}>{busy?t('正在保存','Saving'):t('保存修改','Save changes')}</Button></div>
      </form>
      <div className="vdw-workflow-management-actions"><Button type="button" variant="outline" size="sm" disabled={busy||saving} onClick={()=>{dismiss();details.onExport()}}><Glyph name="download"/>{t('导出','Export')}</Button>{onSaveAs&&<Button type="button" variant="outline" size="sm" disabled={busy||saving} onClick={()=>{dismiss();onSaveAs()}}><Glyph name="save-as"/>{t('另存为','Save as')}</Button>}</div>
  </>
}

interface WorkflowManagementProps extends Omit<WorkflowManagementContentProps,'showSaveFeedback'> {
  id:string
  triggerRef:RefObject<HTMLButtonElement>
  feedback?:ReactNode
}

/** A nonmodal details popover. Its absolute stack never changes canvas chrome. */
export function WorkflowManagement({id,details,revision,saving,triggerRef,onClose,onBusyChange,onSaveAs,feedback}:WorkflowManagementProps){
  const {t}=useLocale(),[busy,setBusy]=useState(false),[availableHeight,setAvailableHeight]=useState<number>()
  const stack=useRef<HTMLDivElement>(null),panel=useRef<HTMLElement>(null),locked=useRef(false),close=useRef(onClose)
  close.current=onClose;locked.current=busy||saving
  const dismiss=(restoreFocus=false)=>{if(!locked.current)close.current(restoreFocus)}
  useEffect(()=>{
    if(typeof document==='undefined')return
    panel.current?.querySelector<HTMLInputElement>('input')?.focus({preventScroll:true})
    const outside=(event:PointerEvent)=>{
      const target=event.target as Element|null
      if(!target||target.closest?.('[role=menu],[role=listbox]'))return
      if(!stack.current?.contains(target)&&!triggerRef.current?.contains(target))dismiss()
    }
    const key=(event:KeyboardEvent)=>{
      if(event.key!=='Escape'||event.defaultPrevented||locked.current)return
      const nested=(event.target as Element|null)?.closest?.('[role=dialog],[role=menu],[role=listbox]')
      if(nested&&nested!==panel.current)return
      event.preventDefault();event.stopPropagation();dismiss(true)
    }
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',key)
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',key)}
  },[triggerRef])
  useLayoutEffect(()=>{
    const body=stack.current?.closest('.vdw-editor-body'),heading=stack.current?.closest('header')
    if(!body||!stack.current)return
    const measure=()=>{if(stack.current)setAvailableHeight(Math.min(640,Math.max(0,body.getBoundingClientRect().bottom-stack.current.getBoundingClientRect().top-12)))}
    measure()
    const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(measure)
    observer?.observe(body);if(heading)observer?.observe(heading)
    window.addEventListener('resize',measure)
    return()=>{observer?.disconnect();window.removeEventListener('resize',measure)}
  },[])
  return <div ref={stack} className="vdw-workflow-management-stack" style={availableHeight===undefined?undefined:{maxHeight:availableHeight}} onPointerDown={event=>event.stopPropagation()}>
    <section ref={panel} id={id} role="dialog" aria-modal="false" aria-label={t('工作流信息','Workflow details')} className="vdw-workflow-management"><WorkflowManagementContent details={details} revision={revision} saving={saving} onClose={dismiss} onBusyChange={next=>{locked.current=next||saving;setBusy(next);onBusyChange(next)}} onSaveAs={onSaveAs}/></section>
    {feedback}
  </div>
}
