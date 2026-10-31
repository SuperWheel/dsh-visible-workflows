import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { exportWorkflowJson, exportWorkflowMarkdown, importWorkflowJson, WORKFLOW_PACKAGE_MAX_BYTES } from '../shared/workflow-format.ts'
import type { Workflow } from '../shared/types.ts'
import { useLocale } from './i18n.ts'
import type { WorkflowImportMapping, WorkflowImportOptions, WorkflowImportPreview } from '../shared/workflow-import.ts'
import { Field, Select } from './controls.tsx'
import { useWorkflowStore, type WorkflowStore } from './store.ts'
import { svgForWorkflow, type CanvasAnnotation } from './canvas.tsx'
import { WorkflowLibraryPanel } from './workflow-library-panel.tsx'
import { WorkflowThumbnail } from './workflow-thumbnail.tsx'
import { useWorkflowPanelDismiss, workflowLibraryStyles } from './workflow-library-style.ts'
import { Glyph } from './icons.tsx'
import { CodeEditor } from './code-editor.tsx'

type TransferProps={store:WorkflowStore;annotations?:readonly CanvasAnnotation[];onClose:()=>void}
type ExportProps=TransferProps&{sourceWorkflow?:Workflow;presentation?:'canvas'|'home'}
function download(name:string,content:BlobPart,type:string){
  const url=URL.createObjectURL(new Blob([content],{type})),anchor=document.createElement('a')
  anchor.href=url;anchor.download=name.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_');anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
export function WorkflowTransfer({store,annotations,initialMode='export',onClose,sourceWorkflow,presentation='canvas'}:ExportProps&{initialMode?:'import'|'export'}){
  const state=useWorkflowStore(store)
  return initialMode==='import'||!state.workflow&&!sourceWorkflow?<WorkflowLibraryPanel store={store} annotations={annotations} initialTab="import" presentation={presentation} onClose={onClose}/>:<WorkflowExportPanel store={store} annotations={annotations} sourceWorkflow={sourceWorkflow} presentation={presentation} onClose={onClose}/>
}

/** File-only import content shared with the personal-template directory. */
export function WorkflowImportContent({store,onClose,onBusyChange}:TransferProps&{onBusyChange?:(busy:boolean)=>void}){
  const {t}=useLocale()
  const state=useWorkflowStore(store),flow=state.workflow
  const [text,setText]=useState(''),[workspace,setWorkspace]=useState(flow?.workspaceId??state.library.workspaces[0]?.id??''),[preview,setPreview]=useState<WorkflowImportPreview>(),[error,setError]=useState(''),[feedback,setFeedback]=useState(''),[working,setWorking]=useState(false),[saving,setSaving]=useState(false),[preparingDestination,setPreparingDestination]=useState(false),[dragging,setDragging]=useState(false),[filename,setFilename]=useState('')
  const [archive,setArchive]=useState<{name:string;base64:string}>(),[options,setOptions]=useState<WorkflowImportOptions>({}),[checked,setChecked]=useState(false),[confirmed,setConfirmed]=useState(false),epoch=useRef(0),fileInput=useRef<HTMLInputElement>(null)
  const blocked=saving||preparingDestination
  useEffect(()=>{onBusyChange?.(blocked)},[blocked,onBusyChange])
  useEffect(()=>()=>onBusyChange?.(false),[onBusyChange])
  const localGraph=useMemo(()=>{if(!text)return undefined;try{return importWorkflowJson(text,workspace).workflow}catch{return undefined}},[text,workspace])
  const invalidate=()=>{epoch.current++;setChecked(false);setConfirmed(false);setError('');setFeedback('')}
  useEffect(()=>()=>{epoch.current++},[])
  const inspect=async()=>{
    const current=++epoch.current;setError('');setWorking(true);setChecked(false);setConfirmed(false)
    try{
      let value:WorkflowImportPreview
      if(archive){if(!store.api.previewArchive)throw new Error(t("当前宿主尚不支持完整流程包，请更新插件后导入","The host does not support complete workflow packages yet. Update the plugin before importing."));value=await store.api.previewArchive(archive.base64,workspace,options,state.sessionId)}
      else if(store.api.previewImport)value=await store.api.previewImport(text,workspace,options,state.sessionId)
      else{const imported=importWorkflowJson(text,workspace);value={title:imported.workflow.title,nodeCount:imported.workflow.nodes.length,edgeCount:imported.workflow.edges.length,environmentCount:imported.workflow.environmentVariables?.length??0,canImport:imported.dependencies.length===0&&!options.overwrite,dependencies:[],warnings:imported.warnings,errors:imported.dependencies.length?[t("宿主尚未提供依赖映射，请更新插件后导入","The host does not provide dependency mapping yet. Update the plugin before importing.")]:[]}}
      if(epoch.current===current){setPreview(value);setChecked(true)}
    }catch(error){if(epoch.current===current)setError(error instanceof Error?error.message:String(error))}finally{if(epoch.current===current)setWorking(false)}
  }
  // A selected file or changed mapping is checked automatically. Responses from an
  // earlier file, workspace or mapping cannot enable a later import.
  useEffect(()=>{if(workspace&&(text.trim()||archive))void inspect()},[text,archive,workspace,options,state.sessionId])
  const clearFile=()=>{if(blocked)return;invalidate();setFilename('');setText('');setArchive(undefined);setPreview(undefined);setWorking(false);setOptions(previous=>({...previous,mappings:[]}));if(fileInput.current)fileInput.current.value=''}
  const readFile=async(file:File)=>{
    if(blocked)return
    invalidate();setPreview(undefined);setArchive(undefined);setText('');setFilename('');setOptions(previous=>({...previous,mappings:[]}));const current=epoch.current,isZip=file.name.toLowerCase().endsWith('.zip')||file.type==='application/zip'
    if(file.size>(isZip?32_000_000:WORKFLOW_PACKAGE_MAX_BYTES)){setWorking(false);setError(isZip?t("完整流程包不能超过 32 MB","Complete workflow packages must not exceed 32 MB"):t("工作流 JSON 不能超过 8 MB","Workflow JSON must not exceed 8 MB"));return}
    setWorking(true)
    try{
      if(isZip){const bytes=new Uint8Array(await file.arrayBuffer()),chunks:string[]=[];for(let offset=0;offset<bytes.length;offset+=32768)chunks.push(String.fromCharCode(...bytes.subarray(offset,offset+32768)));if(epoch.current===current){setArchive({name:file.name,base64:btoa(chunks.join(''))});setFilename(file.name)}}
      else{const value=await file.text();if(epoch.current===current){setText(value);setFilename(file.name);if(!value.trim())setError(t("所选文件为空，请选择工作流 JSON 或 ZIP 文件。","The file is empty. Select a workflow JSON or ZIP file."))}}
    }catch(error){if(epoch.current===current)setError(t('读取文件失败：{error}','File could not be read: {error}',{error:String(error)}))}finally{if(epoch.current===current)setWorking(false)}
  }
  const mapDependency=(mapping:WorkflowImportMapping|undefined,kind:string,id:string)=>{if(blocked)return;invalidate();setOptions(previous=>({...previous,mappings:[...(previous.mappings??[]).filter(item=>item.kind!==kind||item.id!==id),...(mapping?[mapping]:[])]}))}
  const destination=async(value:string)=>{
    if(blocked||working)return
    const before=store.getSnapshot(),current=before.workflow
    if(value==='current'&&(!current||current.workspaceId!==workspace)){setError(t("请先选择当前画布所在的工作区。","Select the workspace containing the current canvas first."));return}
    invalidate();setPreview(undefined)
    if(value!=='current'){setOptions(previous=>({...previous,overwrite:undefined}));return}
    const request=epoch.current;setPreparingDestination(true)
    try{
      // Confirm the persisted revision, including edits that were still local
      // when this destination was selected, before checking a replacement.
      await store.flush()
      const latest=store.getSnapshot()
      if(request!==epoch.current)return
      if(latest.workflow?.id!==current!.id||latest.sessionId!==before.sessionId)throw new Error(t("画布或对话已变化，请重新选择导入方式。","The canvas or conversation changed. Select the import destination again."))
      setOptions(previous=>({...previous,overwrite:{workflowId:latest.workflow!.id,expectedRevision:latest.workflow!.revision}}))
    }catch(error){if(request===epoch.current)setError(t('保存当前画布失败，尚未开始导入：{error}','The current canvas could not be saved. Nothing was imported: {error}',{error:error instanceof Error?error.message:String(error)}))}finally{setPreparingDestination(false)}
  }
  const save=async()=>{
    if(blocked||working||!preview?.canImport||!checked||(options.overwrite&&!confirmed))return
    const request=epoch.current,before=store.getSnapshot()
    setSaving(true);setError('');setFeedback('')
    try{
      const method=archive?store.api.importArchive:store.api.importPackage
      if(!method)throw new Error(t("宿主尚未提供此格式的原子导入，请更新插件后重试","The host does not support atomic import for this format yet. Update the plugin and retry."))
      // Preserve the current canvas before any Host write. In particular, never
      // let open() try saving an old dirty definition after a successful replace.
      await store.flush()
      const persisted=store.getSnapshot()
      if(request!==epoch.current||persisted.workflow?.id!==before.workflow?.id||persisted.sessionId!==before.sessionId)throw new Error(t("画布或对话已变化，尚未开始导入，请重新检查文件。","The canvas or conversation changed. Nothing was imported. Check the file again."))
      if(options.overwrite){
        if(persisted.workflow?.id!==options.overwrite.workflowId)throw new Error(t("当前画布已变化，请重新选择导入方式。","The current canvas changed. Select the import destination again."))
        if(persisted.workflow.revision!==options.overwrite.expectedRevision){
          invalidate();setPreview(undefined)
          setOptions(previous=>({...previous,overwrite:{workflowId:persisted.workflow!.id,expectedRevision:persisted.workflow!.revision}}))
          setFeedback(t("当前画布已更新，正在按最新版本重新检查；请再次确认替换。","The canvas was updated. Checking its latest revision; confirm replacement again."))
          return
        }
      }
      const saved=await method(archive?.base64??text,workspace,options,persisted.sessionId)
      await store.refreshImportedAssets()
      const latest=store.getSnapshot()
      const library={...latest.library,workflows:[saved,...latest.library.workflows.filter(item=>item.id!==saved.id)]}
      if(latest.workflow!==persisted.workflow||latest.sessionId!==persisted.sessionId){
        // The user may keep editing the canvas while a remote import is pending.
        // Keep those edits and register the successful import instead of silently
        // flushing them over its result or reporting a successful write as failed.
        store.update({library});invalidate()
        setFeedback(options.overwrite?t("导入已完成。等待期间产生的当前修改仍已保留；请先将这些修改另存为，再从工作流主页打开导入结果。","Import completed. Edits made while waiting were preserved. Save those edits as a copy before opening the imported result from the workflow home."):t("导入已完成。画布或对话在等待期间发生变化，已保留当前修改；可在工作流主页打开导入结果。","Import completed. The canvas or conversation changed while waiting, so current edits were preserved. Open the imported result from the workflow home."))
        return
      }
      // No local edits remain: adopt the Host response first. Calling open() for
      // this same identity then cancels stale navigation without flushing or
      // fetching the source definition again.
      store.update({workflow:saved,library,page:'canvas',configId:'',logs:false,annotationDraft:undefined,generateDraft:undefined,selected:[],scopePath:saved.editor?.scopePath??[],undo:[],redo:[],saveState:'saved',error:'',run:library.runs.find(item=>item.workflowId===saved.id),viewport:saved.editor?.viewport??{x:32,y:40,scale:1}})
      await store.open(saved.id);onClose()
    }catch(error){setError(error instanceof Error?error.message:String(error))}finally{setSaving(false)}
  }
  const thumbnail=localGraph??preview?.thumbnail
  return <>
    <div className="vdw-library-content" data-vdw-view="import" role="tabpanel" aria-label={t("导入工作流","Import workflow")}>
      <div className="vdw-import-settings"><Field label={t("目标工作区","Target workspace")}><Select label={t("JSON 导入目标工作区","Import target workspace")} value={workspace} disabled={blocked||working} options={state.library.workspaces.map(item=>({id:item.id,label:item.name}))} onChange={value=>{if(blocked||working)return;invalidate();setWorkspace(value);setOptions({});setPreview(undefined)}}/></Field><Field label={t("导入方式","Import destination")}><Select label={t("JSON 导入覆盖目标","Import destination")} value={options.overwrite?'current':'new'} disabled={blocked||working} options={[{id:'new',label:t("导入到新的画布","Import to a new canvas")},{id:'current',label:t("导入到当前画布","Import to the current canvas")}]} onChange={value=>void destination(value)}/></Field></div>
      <input ref={fileInput} className="vdw-import-file-input" type="file" disabled={blocked} aria-label={t("选择工作流 JSON 或 ZIP 文件","Choose workflow JSON or ZIP file")} accept="application/json,.json,application/zip,.zip" onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void readFile(file)}}/>
      <button type="button" className={`vdw-import-dropzone${dragging?' is-dragging':''}`} disabled={blocked} aria-label={t("拖入文件或点击导入","Drop a file here or click to import")} onClick={()=>fileInput.current?.click()} onDragEnter={event=>{event.preventDefault();if(!blocked)setDragging(true)}} onDragOver={event=>{event.preventDefault();event.dataTransfer.dropEffect=blocked?'none':'copy'}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDragging(false)}} onDrop={event=>{event.preventDefault();setDragging(false);const file=event.dataTransfer.files?.[0];if(file)void readFile(file)}}>{t("拖入文件或点击导入","Drop a file here or click to import")}</button>
      {filename&&<article className="vdw-import-selection" aria-label={t("待导入流程预览","Selected workflow preview")}><strong title={filename}>{preview?.title||filename}</strong><WorkflowThumbnail graph={thumbnail} emptyText={working?t("正在读取…","Loading\u2026"):archive?t("流程包预览","Workflow package preview"):t("无法读取缩略图","Preview unavailable")}/><button type="button" className="vdw-import-remove" aria-label={t("移除待导入流程","Remove selected workflow")} title={t("移除待导入流程","Remove selected workflow")} disabled={blocked} onClick={clearFile}><Glyph name="close" size={12}/></button></article>}
      {preparingDestination&&<p role="status" className="vdw-muted">{t("正在保存当前画布…","Saving the current canvas\u2026")}</p>}{working&&<p role="status" className="vdw-muted">{t("正在检查文件…","Checking file\u2026")}</p>}
      {preview&&<div className="vdw-import-details"><strong>{preview.title}</strong><p>{t('{nodes} 个节点 · {edges} 条连线 · {variables} 个环境变量','{nodes} nodes · {edges} edges · {variables} environment variables',{nodes:preview.nodeCount,edges:preview.edgeCount,variables:preview.environmentCount})}</p>{preview.dependencies.length>0&&<><strong>{t("依赖映射","Dependency mapping")}</strong>{preview.dependencies.map(dependency=>{
        const selected=options.mappings?.find(item=>item.kind===dependency.kind&&item.id===dependency.id)?.target
        return <Field key={`${dependency.kind}/${dependency.id}`} label={`${dependency.kind}：${dependency.label}`}><p role="status">{dependency.status==='ready'?t("已匹配","Matched"):dependency.status==='deferred'?t("运行时配置","Configure at runtime"):t("待配置","Needs configuration")} · {dependency.message}</p>{dependency.kind==='file'?dependency.status!=='deferred'&&<input disabled={blocked} aria-label={t('映射 {label}','Map {label}',{label:dependency.label})} placeholder={t("工作区相对路径，例如 docs/source.md","Workspace-relative path, e.g. docs/source.md")} value={typeof selected==='string'?selected:typeof dependency.target==='string'?dependency.target:''} onChange={event=>mapDependency(event.target.value?{kind:dependency.kind,id:dependency.id,target:event.target.value}:undefined,dependency.kind,dependency.id)}/>:<Select label={t('映射 {label}','Map {label}',{label:dependency.label})} disabled={blocked} value={selected===undefined?'':JSON.stringify(selected)} options={[{id:'',label:dependency.kind==='role'?t("使用随包角色（如有）","Use the packaged role, if any"):t("保留原依赖","Keep the original dependency")},...dependency.choices.map(choice=>({id:JSON.stringify(choice.target),label:choice.label}))]} onChange={value=>mapDependency(value?{kind:dependency.kind,id:dependency.id,target:JSON.parse(value)}:undefined,dependency.kind,dependency.id)}/>}</Field>
      })}</>}{preview.warnings.map((warning,index)=><p key={index}>{warning}</p>)}{preview.errors.map((message,index)=><p className="vdw-error" key={index}>{message}</p>)}<p className="vdw-muted">{t("缺少的资源可在导入后配置。Secret 仅保留定义，配置与授权不会随文件导入。","Missing resources can be configured after import. Only Secret definitions are retained; their values and permissions are not imported.")}</p>{preview.overwrite&&<label className="vdw-check-field"><input type="checkbox" disabled={blocked||working||!checked} checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>{t('确认用此文件替换当前画布“{title}”（版本 {revision}）；原运行快照保留。','Replace the current canvas “{title}” (revision {revision}) with this file. Existing run snapshots are retained.',{title:preview.overwrite.title,revision:preview.overwrite.expectedRevision})}</label>}</div>}
      {error&&<p className="vdw-error" role="alert">{error}</p>}{feedback&&<p role="status">{feedback}</p>}
    </div>
    <footer className="vdw-transfer-footer">{error&&filename&&<Button disabled={working||blocked} onClick={()=>void inspect()}>{t("重新检查","Check again")}</Button>}<Button variant="primary" disabled={working||blocked||!checked||!preview?.canImport||!!options.overwrite&&!confirmed} onClick={()=>void save()}>{saving?t("正在导入…","Importing\u2026"):options.overwrite?t("导入到当前画布","Import to the current canvas"):t("导入到新的画布","Import to a new canvas")}</Button></footer>
  </>
}

function WorkflowExportPanel({store,annotations,onClose,sourceWorkflow,presentation='canvas'}:ExportProps){
  const {t}=useLocale()
  const state=useWorkflowStore(store),flow=sourceWorkflow??state.workflow!,ref=useRef<HTMLElement>(null),[format,setFormat]=useState('json'),[includeValues,setIncludeValues]=useState(false),[working,setWorking]=useState(false),[error,setError]=useState(''),[feedback,setFeedback]=useState('')
  useWorkflowPanelDismiss(ref,onClose,working,presentation==='canvas')
  const exportSource=useMemo(()=>sourceWorkflow??({...flow,editor:{...flow.editor,viewport:state.viewport,scopePath:state.scopePath,...(annotations?{annotations:annotations.map(({id,number,nodeIds,text,position})=>({id,number,nodeIds,text,...(position?{position}:{})}))}:{})}}),[sourceWorkflow,flow,state.viewport,state.scopePath,annotations])
  const exportResult=useMemo(()=>{try{return {text:exportWorkflowJson(exportSource,{includeEnvironmentValues:includeValues,presets:state.library.presets,workflows:state.library.workflows}),error:''}}catch(error){return {text:'',error:error instanceof Error?error.message:String(error)}}},[exportSource,includeValues,state.library.presets,state.library.workflows])
  const svgResult=useMemo(()=>{if(format!=='svg')return {text:'',error:''};try{return {text:svgForWorkflow(exportSource),error:''}}catch(error){return {text:'',error:error instanceof Error?error.message:String(error)}}},[exportSource,format])
  const downloadArchive=async()=>{if(!store.api.exportArchive)return;setWorking(true);setError('');try{const base64=await store.api.exportArchive(exportSource,includeValues,state.sessionId),binary=atob(base64),bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));download(`${flow.title}.workflow.zip`,bytes,'application/zip')}catch(error){setError(error instanceof Error?error.message:String(error))}finally{setWorking(false)}}
  const content=<>
    <style>{workflowLibraryStyles}</style><div className="vdw-picker-heading vdw-export-heading"><strong>{sourceWorkflow?t('导出：{title}','Export: {title}',{title:flow.title}):t('导出工作流','Export workflow')}</strong><Button size="sm" className="vdw-icon-button" aria-label={t("关闭导出工作流","Close workflow export")} disabled={working} onClick={onClose}><Glyph name="close"/></Button></div>
    <div className="vdw-library-content" data-vdw-view={`export-${format}`}><Field label={t("导出格式","Export format")}><Select label={t("工作流导出格式","Workflow export format")} value={format} options={[{id:'json',label:'JSON'},{id:'svg',label:'SVG'}]} disabled={working} onChange={setFormat}/></Field><div className="vdw-export-thumbnail" aria-label={format==='json'?t("JSON 流程缩略图","JSON workflow preview"):t("SVG 预览","SVG preview")}>{format==='json'?<WorkflowThumbnail graph={flow}/>:svgResult.text?<img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgResult.text)}`} alt={t('{title} SVG 缩略图','{title} SVG preview',{title:flow.title})}/>:<p className="vdw-error">{svgResult.error||t("无法生成 SVG 预览","SVG preview unavailable")}</p>}</div>
      {format==='json'&&<><div className="vdw-export-code"><CodeEditor label={t("工作流 JSON 导出预览","Workflow JSON export preview")} value={exportResult.text} language="json" rows={8} readOnly/></div>{!exportResult.text&&<p className="vdw-error">{exportResult.error||t("当前定义无法导出，请先解决流程校验问题。","This definition cannot be exported. Resolve workflow validation errors first.")}</p>}<label className="vdw-check-field"><input type="checkbox" disabled={working} checked={includeValues} onChange={event=>setIncludeValues(event.target.checked)}/>{t("包含普通环境变量的值","Include regular environment variable values")}</label><p className="vdw-muted">{t("Secret 值与本机授权不会导出。","Secret values and local permissions are not exported.")}</p><details className="vdw-export-extra"><summary>{t("更多导出选项","More export options")}</summary><div className="vdw-actions"><Button disabled={working||!exportResult.text} onClick={()=>void navigator.clipboard.writeText(exportResult.text).then(()=>setFeedback(t("已复制 JSON","JSON copied"))).catch(()=>setFeedback(t("复制失败，请使用下载 JSON","Copy failed. Download the JSON instead.")))}>{t("复制 JSON","Copy JSON")}</Button><Button disabled={working||!store.api.exportArchive} onClick={()=>void downloadArchive()}>{t("下载完整流程包（含资料）","Download complete package with files")}</Button><Button disabled={working} onClick={()=>download(`${flow.title}.md`,exportWorkflowMarkdown(flow),'text/markdown')}>{t("导出 Markdown 说明","Export Markdown documentation")}</Button></div><p className="vdw-muted">{t("完整流程包会附带工作区内可读取的固定资料文件。","Complete packages include readable fixed files from the workspace.")}</p></details></>}
      {error&&<p className="vdw-error" role="alert">{error}</p>}{feedback&&<p role="status">{feedback}</p>}
    </div><footer className="vdw-transfer-footer"><Button variant="primary" disabled={working||!(format==='json'?exportResult.text:svgResult.text)} onClick={()=>format==='json'?download(`${flow.title}.workflow.json`,exportResult.text,'application/json'):download(`${flow.title}.svg`,svgResult.text,'image/svg+xml')}>{format==='json'?t("下载 JSON","Download JSON"):t("下载 SVG","Download SVG")}</Button></footer>
  </>
  return presentation==='home'?<Modal open headless title={t('导出工作流','Export workflow')} className="vdw-modal vdw-workflow-library vdw-home-workflow-modal vdw-home-export-modal" onClose={()=>{if(!working)onClose()}}>{content}</Modal>:<section ref={ref} className="vdw-node-picker vdw-workflow-library vdw-workflow-export" aria-label={t('导出工作流','Export workflow')} onPointerDown={event=>event.stopPropagation()}>{content}</section>
}
