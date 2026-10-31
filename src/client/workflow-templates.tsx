import { useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkflowTemplate } from '../shared/types.ts'
import { Field, Select } from './controls.tsx'
import { Glyph } from './icons.tsx'
import { useLocale } from './i18n.ts'
import { useWorkflowStore, type WorkflowStore } from './store.ts'
import { WorkflowThumbnail } from './workflow-thumbnail.tsx'

/** Personal-template tab content; the shared library owns the floating shell. */
export function TemplateDialog({store,onClose,onBusyChange}:{store:WorkflowStore;onClose:()=>void;onBusyChange?:(busy:boolean)=>void}){
  const {t}=useLocale()
  const state=useWorkflowStore(store),[templates,setTemplates]=useState<WorkflowTemplate[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(''),[error,setError]=useState(''),[feedback,setFeedback]=useState(''),[workspaceId,setWorkspaceId]=useState(state.workflow?.workspaceId??state.library.workspaces[0]?.id??''),[renaming,setRenaming]=useState<{template:WorkflowTemplate;title:string}>(),[search,setSearch]=useState('')
  useEffect(()=>{let active=true;void (async()=>{try{if(!store.api.templates)throw new Error(t("当前宿主尚未提供模板库","The host does not provide a template library yet"));const result=await store.api.templates();if(active)setTemplates(result)}catch(error){if(active)setError(String(error))}finally{if(active)setLoading(false)}})();return()=>{active=false}},[store])
  useEffect(()=>{onBusyChange?.(!!busy)},[busy,onBusyChange])
  useEffect(()=>()=>onBusyChange?.(false),[onBusyChange])
  const refresh=async()=>setTemplates(await store.api.templates!())
  const action=async(key:string,run:()=>Promise<void>)=>{setBusy(key);setError('');setFeedback('');try{await run()}catch(error){setError(error instanceof Error?error.message:String(error))}finally{setBusy('')}}
  const use=(template:WorkflowTemplate)=>action(template.id,async()=>{
    if(!store.api.useTemplate)throw new Error(t("当前宿主不能使用模板","The host cannot use templates"))
    const before=store.getSnapshot();await store.flush();const persisted=store.getSnapshot()
    if(persisted.workflow?.id!==before.workflow?.id||persisted.sessionId!==before.sessionId)throw new Error(t('画布或对话已变化，请重新使用模板。','The canvas or conversation changed. Select the template again.'))
    const flow=await store.api.useTemplate(template.id,workspaceId)
    await store.refreshImportedAssets()
    const latest=store.getSnapshot(),library={...latest.library,workflows:[flow,...latest.library.workflows.filter(item=>item.id!==flow.id)]}
    if(latest.workflow!==persisted.workflow||latest.sessionId!==persisted.sessionId){store.update({library});setFeedback(t('模板副本已创建，当前修改已保留；可在主页打开副本。','The template copy was created and current edits were preserved. Open the copy from the workflow home.'));return}
    store.update({workflow:flow,library,page:'canvas',configId:'',logs:false,annotationDraft:undefined,generateDraft:undefined,selected:[],scopePath:flow.editor?.scopePath??[],undo:[],redo:[],saveState:'saved',error:'',run:undefined,viewport:flow.editor?.viewport??{x:32,y:40,scale:1}})
    await store.open(flow.id);onClose()
  })
  const rename=()=>action('rename',async()=>{if(!renaming||!store.api.renameTemplate)throw new Error(t("当前宿主不能重命名模板","The host cannot rename templates"));await store.api.renameTemplate(renaming.template.id,renaming.title.trim(),renaming.template.revision);setRenaming(undefined);await refresh()})
  const remove=(template:WorkflowTemplate)=>action(template.id,async()=>{if(!store.api.removeTemplate)throw new Error(t("当前宿主不能归档模板","The host cannot archive templates"));await store.api.removeTemplate(template.id,template.revision);await refresh();setFeedback(t("模板已归档。","Template archived."))})
  const filtered=templates.filter(template=>template.scope==='personal'&&`${template.title} ${template.description}`.toLowerCase().includes(search.trim().toLowerCase()))
  return <div className="vdw-library-content" role="tabpanel" aria-label={t("工作流模板","Workflow templates")}>
    <Field label={t("目标工作区","Target workspace")}><Select label={t("模板目标工作区","Template target workspace")} value={workspaceId} disabled={!!busy} options={state.library.workspaces.map(workspace=>({id:workspace.id,label:workspace.name}))} onChange={setWorkspaceId}/></Field>
    <div className="vdw-library-search"><Input aria-label={t("搜索模板","Search templates")} icon={<Glyph name="search"/>} placeholder={t("搜索模板名称或说明","Search template names or descriptions")} value={search} onChange={event=>setSearch(event.target.value)}/></div>
    {loading?<p role="status">{t("正在读取模板…","Loading templates\u2026")}</p>:<section className="vdw-template-grid" aria-label={t("个人模板","Personal templates")}>{filtered.map(template=><article className="vdw-template-tile" key={template.id}>
      {renaming?.template.id===template.id?<div className="vdw-template-rename"><Input aria-label={t("新模板名称","New template name")} value={renaming.title} maxLength={200} disabled={!!busy} onChange={event=>setRenaming({...renaming,title:event.target.value})}/><div className="vdw-actions"><Button size="sm" disabled={!!busy||!renaming.title.trim()} onClick={()=>void rename()}>{t("保存名称","Save name")}</Button><Button size="sm" disabled={!!busy} onClick={()=>setRenaming(undefined)}>{t("取消","Cancel")}</Button></div></div>:<button type="button" className="vdw-template-use" aria-label={t('使用模板：{title}','Use template: {title}',{title:template.title})} title={template.description||template.title} disabled={!!busy||!workspaceId||!store.api.useTemplate} onClick={()=>void use(template)}><strong>{template.title}</strong><WorkflowThumbnail graph={template.thumbnail} label={t('{title}缩略图','{title} preview',{title:template.title})}/></button>}
      <div className="vdw-template-actions"><Button size="sm" disabled={!!busy||!store.api.renameTemplate} onClick={()=>setRenaming({template,title:template.title})}>{t("重命名","Rename")}</Button><Button size="sm" disabled={!!busy||!store.api.removeTemplate} onClick={()=>void remove(template)}>{t("归档","Archive")}</Button></div>
    </article>)}</section>}
    {!loading&&!filtered.length&&<p className="vdw-muted">{search.trim()?t('没有匹配的个人模板。','No matching personal templates.'):t('还没有个人模板。在画布中多选节点，右键创建模板。','No personal templates yet. Select nodes on a canvas, then right-click to create a template.')}</p>}
    {feedback&&<p role="status">{feedback}</p>}{error&&<p role="alert" className="vdw-error">{error}</p>}
  </div>
}
