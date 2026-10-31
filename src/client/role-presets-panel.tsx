import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { newId, type RolePreset } from '../shared/types.ts'
import { rolePresetsForWorkflow } from '../shared/role-presets.ts'
import { Field, Select } from './controls.tsx'
import { Glyph } from './icons.tsx'
import { useLocale } from './i18n.ts'
import { useWorkflowStore, type WorkflowStore } from './store.ts'

type Scope='all'|'global'|'workflow'
/** Presets are a library; using one copies its role into a workflow-owned agent snapshot. */
export function RolePresetsPanel({store}:{store:WorkflowStore}) {
  const state=useWorkflowStore(store),flow=state.workflow!,{t}=useLocale(),[query,setQuery]=useState(''),[scope,setScope]=useState<Scope>('all'),[draft,setDraft]=useState<RolePreset>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[feedback,setFeedback]=useState(''),pending=useRef(false),generation=useRef(0)
  useEffect(()=>{setDraft(undefined);setError('');setFeedback('');generation.current++},[flow.id])
  useEffect(()=>{
    let active=true;const request=generation.current
    if(typeof store.api.presets==='function')void store.refreshPresets().catch(error=>{if(active&&request===generation.current)setError(error instanceof Error?error.message:String(error))})
    return()=>{active=false}
  },[store])
  const available=rolePresetsForWorkflow(state.library.presets,flow.id),visible=available.filter(preset=>(scope==='all'||(preset.scope??'global')===scope)&&`${preset.name} ${preset.summary??''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const edit=(preset?:RolePreset)=>{if(busy)return;setDraft(preset?{...preset}:{id:newId(),name:'',summary:'',prompt:'',revision:0,scope:'workflow',workflowId:flow.id});setError('');setFeedback('')}
  const persist=async(remove=false)=>{
    if(!draft||pending.current)return
    const workflowId=flow.id,request:RolePreset={...draft,name:draft.name.trim(),summary:draft.summary?.trim()??'',scope:draft.scope??'global',...(draft.scope==='workflow'?{workflowId}:{})}
    if(request.scope!=='workflow')delete request.workflowId
    if(!remove&&(!request.name||!request.prompt.trim())){setError(t('请填写智能体名称和角色提示词。','Enter an agent name and role prompt.'));return}
    pending.current=true;const requestGeneration=++generation.current;setBusy(true);setError('');setFeedback('')
    try{
      await store.flush()
      if(store.getSnapshot().workflow?.id!==workflowId||requestGeneration!==generation.current)throw new Error(t('当前工作流已变化，请重新打开预设。','The current workflow changed. Reopen the preset.'))
      const presets=remove?await store.api.deletePreset(request.id):await store.api.savePreset(JSON.stringify(request))
      const current=store.getSnapshot();store.update({library:{...current.library,presets}})
      if(current.workflow?.id===workflowId&&requestGeneration===generation.current){setDraft(undefined);setFeedback(remove?t('预设已删除，已有智能体保留原角色。','Preset deleted. Existing agents keep their saved roles.'):t('预设已保存，可在节点中选择。','Preset saved. You can select it in a node.'))}
    }catch(error){if(store.getSnapshot().workflow?.id===workflowId&&requestGeneration===generation.current)setError(error instanceof Error?error.message:String(error))}
    finally{pending.current=false;setBusy(false)}
  }
  return <section className="vdw-role-presets-panel" aria-label={t('智能体预设管理','Agent preset manager')}>
    {draft?<form className="vdw-role-preset-editor" onSubmit={event=>{event.preventDefault();void persist()}}>
      <Button type="button" className="vdw-role-preset-back" disabled={busy} onClick={()=>{setDraft(undefined);setError('')}}><Glyph name="back"/>{t('返回预设','Back to presets')}</Button>
      <div className="vdw-between"><strong>{draft.revision?t('编辑智能体','Edit agent'):t('新增智能体','New agent')}</strong><small>{t('定义职责、方法与工作边界','Define its role, methods and boundaries')}</small></div>
      <Field label={t('智能体名称','Agent name')}><Input aria-label={t('智能体名称','Agent name')} value={draft.name} maxLength={100} disabled={busy} onChange={event=>setDraft({...draft,name:event.target.value})} placeholder={t('例如：逻辑审稿人','For example: Logic reviewer')}/></Field>
      <Field label={t('概述','Summary')}><Input aria-label={t('智能体概述','Agent summary')} value={draft.summary??''} maxLength={240} disabled={busy} onChange={event=>setDraft({...draft,summary:event.target.value})} placeholder={t('用一句话描述擅长的任务','Describe its specialty in one sentence')}/></Field>
      <Field label={t('作用域','Scope')}><Select label={t('预设作用域','Preset scope')} value={draft.scope??'global'} disabled={busy} options={[{id:'global',label:t('全局','Global')},{id:'workflow',label:t('当前工作流','Current workflow')}]} onChange={value=>setDraft({...draft,scope:value as 'global'|'workflow',...(value==='workflow'?{workflowId:flow.id}:{workflowId:undefined})})}/></Field>
      <Field label={t('角色提示词','Role prompt')}><textarea aria-label={t('角色提示词','Role prompt')} rows={8} maxLength={100000} value={draft.prompt} disabled={busy} onChange={event=>setDraft({...draft,prompt:event.target.value})} placeholder={t('描述角色、工作方式与输出要求…','Describe its role, methods and output requirements…')}/></Field>
      <div className="vdw-role-preset-editor-actions">{!!draft.revision&&<Button type="button" disabled={busy} onClick={()=>void persist(true)}>{t('删除预设','Delete preset')}</Button>}<span/><Button type="button" disabled={busy} onClick={()=>{setDraft(undefined);setError('')}}>{t('取消','Cancel')}</Button><Button type="submit" variant="primary" disabled={busy}>{busy?t('保存中…','Saving…'):t('保存预设','Save preset')}</Button></div>
    </form>:<>
      <div className="vdw-role-presets-toolbar"><Input className="vdw-role-presets-search" icon={<Glyph name="search"/>} aria-label={t('搜索智能体预设','Search agent presets')} type="search" placeholder={t('搜索名称或概述','Search name or summary')} value={query} onChange={event=>setQuery(event.target.value)}/><Select label={t('筛选预设作用域','Filter preset scope')} value={scope} options={[{id:'all',label:t('全部作用域','All scopes')},{id:'global',label:t('全局','Global')},{id:'workflow',label:t('当前工作流','Current workflow')}]} onChange={value=>setScope(value as Scope)}/></div>
      <Button className="vdw-role-presets-new" variant="primary" icon={<Glyph name="plus"/>} disabled={busy} onClick={()=>edit()}>{t('新增预设','New preset')}</Button>
      <div className="vdw-role-presets-grid">{visible.map(preset=><button type="button" key={preset.id} className="vdw-role-preset-card" aria-label={t('编辑预设 {name}','Edit preset {name}',{name:preset.name})} disabled={busy} onClick={()=>edit(preset)}><span><strong>{preset.name}</strong><small>{preset.scope==='workflow'?t('当前工作流','Current workflow'):t('全局','Global')}</small><Glyph name="chevron-right"/></span><p>{preset.summary||t('未填写概述','No summary')}</p></button>)}</div>
      {!visible.length&&<p className="vdw-muted">{available.length?t('没有匹配的预设。','No matching presets.'):t('还没有预设，添加一个智能体角色吧。','No presets yet. Add an agent role.')}</p>}
    </>}
    {error&&<p className="vdw-error" role="alert">{error}</p>}{feedback&&<p className="vdw-muted" role="status">{feedback}</p>}
  </section>
}
