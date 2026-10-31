import { useSyncExternalStore } from 'react'
import type { LibrarySnapshot, ModelChoice, Workflow, WorkflowAPI, WorkflowRun, WorkflowProposal, WorkflowDraft, JsonValue } from '../shared/types.ts'
import { renumberWorkflow } from '../shared/numbering.ts'
import type { AnnotationPosition } from './annotation-position.ts'
import type { EnvironmentDraft } from './workflow-variables.ts'
import { editorDraftKey, hasEditorDraftPatch, restoreEditorDraft, serializeEditorDraft } from './editor-drafts.ts'
import type { WorkflowReadiness } from '../shared/workflow-import.ts'
import { reconcileEditorReferences } from './portable-annotations.ts'
import { t } from './i18n.ts'
import { getSavePreferences, subscribeSavePreferences } from './save-preferences.ts'
import { workflowDefinitionContent as definitionContent } from '../shared/workflow-content.ts'

export interface EditorState {
  readiness?: WorkflowReadiness
  readinessState?: 'checking'|'ready'|'error'
  readinessError?: string
  readinessFocus?: number
  secretBoundaryReport?: import('../shared/secret-boundary.ts').SecretBoundaryReport
  secretBoundaryState?: 'idle'|'loading'|'ready'|'error'
  library: LibrarySnapshot; models: ModelChoice[]; workflow?: Workflow; run?: WorkflowRun
  loading: boolean; error: string; saveState: 'saved'|'dirty'|'saving'|'error'; page: 'library'|'canvas'
  savedAt?: number
  selected: string[]; scopePath: string[]; undo: Workflow[]; redo: Workflow[]; sessionId?: string
  viewport: {x:number;y:number;scale:number}
  annotationDraft?: {id?:string;text:string;nodeIds:string[];position?:AnnotationPosition}
  generateDraft?: string
  generateTargetId?: string
  generateRequestId?: string
  configId?: string
  logs?: boolean
  search?: string
  workspaceFilter?: string
  statusFilter?: string
  pendingWorkflow?: {id:string;title:string}
  modelsError?: string
  libraryWarning?:string
  variablePanel?: 'environment'|'system'
  environmentDraft?: EnvironmentDraft
  proposals?: WorkflowProposal[]
  draftSaveState?: 'saved'|'saving'|'error'
  selectedRunId?: string
}
const copy = <T,>(value: T): T => structuredClone(value)
export const ACTIVE_RUN_STATUSES=['running','waiting','paused','pausing','budget_waiting']
/** One editing context; its full-width and sidebar presentations share this instance. */
export class WorkflowStore {
  private state: EditorState = {library:{workflows:[],presets:[],runs:[],workspaces:[]},models:[],loading:true,error:'',saveState:'saved',page:'library',selected:[],scopePath:[],undo:[],redo:[],viewport:{x:32,y:40,scale:1}}
  private listeners = new Set<()=>void>()
  private saveTimer?: ReturnType<typeof setTimeout>
  private pollTimer?: ReturnType<typeof setTimeout>
  private refreshTimer?: ReturnType<typeof setTimeout>
  private saving?: Promise<void>
  private saveOperation?: Promise<WorkflowReadiness|undefined>
  private savingAs?:Promise<void>
  private unsubscribePreferences:()=>void
  private editSerial = 0
  private persistedSerial = 0
  private libraryError = ''
  private persistedWorkflow?:Workflow
  private discarding?:Promise<void>
  private discardPhase?:'waiting'|'reading'
  private navigationRequest = 0
  private libraryRequest = 0
  private presetsRequest = 0
  private runRequest = 0
  /** Only an adopted successful reply finishes the intent; lost or stale replies retain it. */
  private runIntents=new Map<string,string>()
  private runIntent(key:string):string{const id=this.runIntents.get(key)??crypto.randomUUID();this.runIntents.set(key,id);return id}
  private proposalRequest = 0
  private disposed = false
  private readinessTimer?: ReturnType<typeof setTimeout>
  private readinessRequest=0
  private draftTimer?: ReturnType<typeof setTimeout>
  private draftSerial=0
  private draftSaving:Promise<void>=Promise.resolve()
  private draftVersions=new Map<string,string>()
  private draftIds=new Map<string,string>()
  private draftRevisions=new Map<string,number>()
  private unsavedDrafts=new Map<string,WorkflowDraft>()
  private draftErrors=new Map<string,string>()
  private draftLoading?:{key:string;serial:number}
  private viewportReader?: {read:()=>EditorState['viewport'];workflowId:string}
  registerViewport=(read:()=>EditorState['viewport'],workflowId:string)=>{
    const entry={read,workflowId};this.viewportReader=entry
    return()=>{if(this.viewportReader===entry){this.captureViewport();this.viewportReader=undefined}}
  }
  captureViewport(){const entry=this.viewportReader;if(entry&&this.state.workflow?.id===entry.workflowId)this.update({viewport:entry.read()})}
  constructor(readonly api: WorkflowAPI) {this.unsubscribePreferences=subscribeSavePreferences(()=>this.scheduleAutoSave());this.scheduleAutoSave()}
  private scheduleAutoSave(){
    clearTimeout(this.saveTimer)
    const preferences=getSavePreferences()
    if(this.disposed||preferences.mode!=='auto')return
    this.saveTimer=setTimeout(()=>{void (async()=>{try{if(this.editSerial>this.persistedSerial&&!this.savingAs&&!this.discardPhase)await this.save()}catch{/* Save errors remain visible; never discard edits. */}finally{this.scheduleAutoSave()}})()},preferences.intervalMinutes*60_000)
  }
  /** Editing invalidates admission without displaying a checking warning. */
  private scheduleReadiness(clear=false){
    clearTimeout(this.readinessTimer);this.readinessRequest++
    if(!this.state.workflow){this.publish({readiness:undefined,readinessState:undefined,readinessError:undefined});return}
    this.publish({readinessState:undefined,readinessError:undefined,...(clear?{readiness:undefined}:{})})
    // Opening/importing a persisted graph checks once. Ordinary canvas edits wait for save.
    if(clear&&this.api.inspectReadiness)this.readinessTimer=setTimeout(()=>{void this.refreshReadiness().catch(()=>{})},0)
  }
  async refreshReadiness():Promise<WorkflowReadiness>{
    clearTimeout(this.readinessTimer)
    const flow=this.state.workflow,sessionId=this.state.sessionId,request=++this.readinessRequest
    if(!flow)throw new Error('请先打开工作流')
    this.publish({readinessState:'checking',readinessError:undefined,saveState:'saving'})
    try{
      if(!this.api.inspectReadiness)throw new Error('当前宿主尚不支持配置检查，请更新插件后运行')
      const report=await this.api.inspectReadiness(copy(flow),sessionId)
      if(this.disposed||request!==this.readinessRequest||flow!==this.state.workflow||sessionId!==this.state.sessionId)throw new Error('流程配置已变化，请重新检查')
      if(report.workflowId!==flow.id||report.revision!==flow.revision)throw new Error('检查结果与当前流程版本不一致，请重新检查')
      this.publish({readiness:report,readinessState:'ready',readinessError:undefined})
      return report
    }catch(error){
      if(!this.disposed&&request===this.readinessRequest&&flow===this.state.workflow&&sessionId===this.state.sessionId)this.publish({readinessState:'error',readinessError:error instanceof Error?error.message:String(error)})
      throw error
    }finally{if(!this.disposed&&request===this.readinessRequest&&!this.saveOperation)this.publish({saveState:this.pendingSaveState()})}
  }
  async refreshSecretBoundary(){
    if(!this.api.secretBoundary){this.publish({secretBoundaryState:'error',secretBoundaryReport:undefined});return}
    this.publish({secretBoundaryState:'loading'})
    try{const report=await this.api.secretBoundary();this.publish({secretBoundaryReport:report,secretBoundaryState:'ready'})}
    catch{this.publish({secretBoundaryState:'error',secretBoundaryReport:undefined})}
  }
  /** Returns true for unsaved graph/configuration/content changes. Pan, zoom and
   * scope navigation alone keep their existing silent flush behavior. */
  hasUnsavedChanges():boolean{
    const flow=this.state.workflow
    if(!flow||this.editSerial===this.persistedSerial)return false
    return !this.persistedWorkflow||this.persistedWorkflow.id!==flow.id||definitionContent(flow)!==definitionContent(this.persistedWorkflow)
  }
  /** View state still flushes silently; only definition edits read as unsaved. */
  private pendingSaveState():'dirty'|'saved'{return this.hasUnsavedChanges()?'dirty':'saved'}
  /** Explicit user intent only: settle any existing save, reload the persisted
   * definition, then leave without allowing a later autosave/unmount to revive it. */
  async discardAndLeave():Promise<void>{
    if(this.discarding)return this.discarding
    const source=this.state.workflow,serial=this.editSerial,session=this.state.sessionId
    if(!source){this.viewportReader=undefined;this.update({page:'library'});return}
    const unchanged=()=>{
      if(this.disposed)throw new Error(t('工作流编辑器已关闭。','The workflow editor is closed.'))
      if(this.state.workflow?.id!==source.id||this.state.sessionId!==session||this.editSerial!==serial)throw new Error(t('画布在等待期间有新修改或已切换，请重新确认是否放弃。','The canvas changed while waiting. Confirm again before discarding changes.'))
    }
    ++this.navigationRequest
    this.discardPhase='waiting'
    this.discarding=(async()=>{
      // Existing save() may recursively flush edits that were already present.
      // Let that authorized operation settle before blocking all new flushes.
      while(this.savingAs||this.saveOperation||this.saving){
        await (this.savingAs??this.saveOperation??this.saving)
        unchanged()
      }
      unchanged();this.discardPhase='reading'
      const restored=await this.api.get(source.id)
      unchanged()
      if(restored.id!==source.id)throw new Error(t('读取到的工作流身份不一致，当前修改已保留。','The loaded workflow identity does not match. Current edits were preserved.'))
      ++this.libraryRequest
      // registerViewport cleanup captures the old canvas during unmount. Detach
      // it before publishing page=library so abandoned coordinates stay abandoned.
      this.viewportReader=undefined
      this.editSerial=0;this.persistedSerial=0
      const library={...this.state.library,workflows:[restored,...this.state.library.workflows.filter(flow=>flow.id!==restored.id)]}
      this.update({workflow:restored,library,page:'library',loading:false,selected:[],configId:'',logs:false,undo:[],redo:[],scopePath:restored.editor?.scopePath??[],viewport:restored.editor?.viewport??{x:32,y:40,scale:1},saveState:'saved',error:'',readiness:undefined,readinessState:undefined,readinessError:undefined})
    })()
    try{await this.discarding}finally{this.discarding=undefined;this.discardPhase=undefined}
  }
  getSnapshot = () => this.state
  subscribe = (fn:()=>void) => {this.listeners.add(fn);return()=>this.listeners.delete(fn)}
  private publish=(patch:Partial<EditorState>)=>{if(this.disposed)return;this.state={...this.state,...patch};this.listeners.forEach(fn=>fn())}
  update = (patch: Partial<EditorState>) => {
    if(this.disposed)return
    const previous=this.state,next={...previous,...patch},changed=editorDraftKey(previous)!==editorDraftKey(next)
    // A saved/edited role catalog invalidates all older role and list reads.
    if(patch.library&&patch.library.presets!==previous.library.presets)this.presetsRequest++
    if(!patch.workflow&&next.workflow&&(patch.viewport||patch.scopePath)&&JSON.stringify([previous.viewport,previous.scopePath])!==JSON.stringify([next.viewport,next.scopePath])){
      next.workflow={...next.workflow,editor:{...next.workflow.editor,viewport:copy(next.viewport),scopePath:[...next.scopePath]}}
      this.editSerial++;next.saveState=this.saving||this.saveOperation||this.savingAs?'saving':this.pendingSaveState()
    }
    if(changed){clearTimeout(this.draftTimer);this.queueDraft(this.snapshotDraft(previous));Object.assign(next,{annotationDraft:undefined,generateDraft:undefined,generateTargetId:undefined,generateRequestId:undefined,environmentDraft:undefined,variablePanel:undefined,proposals:undefined});this.draftSerial++}
    if(patch.workflow&&(previous.workflow?.id!==next.workflow?.id||this.editSerial===this.persistedSerial))this.persistedWorkflow=copy(patch.workflow)
    this.publish(next)
    if(previous.workflow!==next.workflow||previous.sessionId!==next.sessionId)this.scheduleReadiness(previous.workflow?.id!==next.workflow?.id)
    if(changed){void this.loadDraft();void this.refreshProposals()}
    else if(hasEditorDraftPatch(patch)){this.draftLoading=undefined;this.draftSerial++;clearTimeout(this.draftTimer);this.publish({draftSaveState:this.api.saveDraft?'saving':undefined});this.draftTimer=setTimeout(()=>this.queueDraft(this.snapshotDraft(this.state)),400)}
  }
  private snapshotDraft(state:EditorState){const key=editorDraftKey(state);if(!key)return;if(this.draftLoading?.key===key)return this.unsavedDrafts.get(key);const id=this.draftIds.get(key)??crypto.randomUUID();this.draftIds.set(key,id);return serializeEditorDraft(state,id,this.draftRevisions.get(id)??0)}
  private queueDraft(draft:WorkflowDraft|undefined){
    if(!draft||!this.api.saveDraft||!this.api.removeDraft)return
    const content=JSON.stringify(draft.payload),key=JSON.stringify([draft.workspaceId,draft.workflowId,draft.sessionId??''])
    this.unsavedDrafts.set(key,draft)
    this.draftSaving=this.draftSaving.catch(()=>{}).then(async()=>{
      // Read our latest acknowledged revision inside the queue. Two local edits
      // serialize; another editor's version is never silently adopted on conflict.
      const id=this.draftIds.get(key)??draft.id,revision=this.draftRevisions.get(id)??0
      try{
        if(this.draftVersions.get(id)!==content||this.draftErrors.has(key)){
          if(content==='{}'){
            if(revision>0)await this.api.removeDraft!(id,revision)
            this.draftRevisions.delete(id);this.draftVersions.delete(id)
            const nextId=crypto.randomUUID();this.draftIds.set(key,nextId);this.draftVersions.set(nextId,'{}')
          }else{
            const saved=await this.api.saveDraft!(JSON.stringify({...draft,id,revision}),revision)
            this.draftIds.set(key,saved.id);this.draftRevisions.set(saved.id,saved.revision);this.draftVersions.set(saved.id,content)
          }
        }
        this.draftErrors.delete(key)
        if(JSON.stringify(this.unsavedDrafts.get(key)?.payload)===content)this.unsavedDrafts.delete(key)
        if(editorDraftKey(this.state)===key&&!this.unsavedDrafts.has(key))this.publish({draftSaveState:'saved'})
      }
      catch(e){const error=`草稿保存失败：${String(e)}；本地编辑内容已保留`;this.draftErrors.set(key,error);if(editorDraftKey(this.state)===key)this.publish({draftSaveState:'error',error})}
    })
  }
  async flushDraft(){clearTimeout(this.draftTimer);const key=editorDraftKey(this.state);this.queueDraft(this.snapshotDraft(this.state));await this.draftSaving;const error=key&&this.draftErrors.get(key);if(error)throw new Error(error)}
  /** An explicit handoff transfers the same editor; ordinary session navigation remains isolated. */
  async associateSession(sessionId:string){
    if(this.state.sessionId===sessionId)return
    const flow=this.state.workflow
    if(flow&&this.api.drafts){const target=await this.api.drafts(flow.id,sessionId);if(target.some(draft=>draft.payload&&typeof draft.payload==='object'&&Object.keys(draft.payload).length))throw new Error('目标对话存在未提交的工作流需求，请先完成或关闭该需求，或者选择新对话。');const existing=target[0];if(existing){const key=JSON.stringify([flow.workspaceId,flow.id,sessionId]);this.draftIds.set(key,existing.id);this.draftRevisions.set(existing.id,existing.revision)}}
    await this.flushDraft()
    const previous=this.state,oldKey=editorDraftKey(previous),next={...previous,sessionId},draft=this.snapshotDraft(next)
    if(draft&&this.api.saveDraft&&JSON.stringify(draft.payload)!=='{}'){const saved=await this.api.saveDraft(JSON.stringify(draft),draft.revision);this.draftRevisions.set(saved.id,saved.revision);this.draftVersions.set(saved.id,JSON.stringify(saved.payload));const oldId=oldKey&&this.draftIds.get(oldKey);if(oldId&&oldId!==draft.id){await this.api.removeDraft?.(oldId,this.draftRevisions.get(oldId)??0);this.draftRevisions.delete(oldId);this.draftVersions.delete(oldId);this.draftIds.delete(oldKey!)}}
    clearTimeout(this.draftTimer);this.draftSerial++;this.publish({sessionId,draftSaveState:this.api.saveDraft?'saved':undefined})
  }
  private async loadDraft(){
    const flow=this.state.workflow,key=editorDraftKey(this.state),serial=this.draftSerial,sessionId=this.state.sessionId;if(!flow||!key||!this.api.drafts)return
    const loading={key,serial};this.draftLoading=loading
    try{await this.draftSaving;const local=this.unsavedDrafts.get(key);if(local){if(!this.disposed&&editorDraftKey(this.state)===key&&this.draftSerial===serial)this.publish({...restoreEditorDraft(local),draftSaveState:'error',error:this.draftErrors.get(key)??'本地草稿尚未保存'});return}const drafts=await this.api.drafts(flow.id,sessionId);if(this.disposed||editorDraftKey(this.state)!==key||this.draftSerial!==serial)return;const draft=drafts.find(item=>item.workspaceId===flow.workspaceId&&(item.sessionId??'')===(sessionId??''));if(draft){this.draftIds.set(key,draft.id);this.draftRevisions.set(draft.id,draft.revision);this.draftVersions.set(draft.id,JSON.stringify(draft.payload));this.publish({...restoreEditorDraft(draft),draftSaveState:'saved'})}}
    catch(e){if(editorDraftKey(this.state)===key&&this.draftSerial===serial)this.publish({error:`草稿读取失败：${String(e)}`})}
    finally{if(this.draftLoading===loading)this.draftLoading=undefined}
  }
  async refreshProposals(){const flow=this.state.workflow,request=++this.proposalRequest;if(!flow||!this.api.proposals)return;try{const proposals=await this.api.proposals(flow.id);if(request===this.proposalRequest&&this.state.workflow?.id===flow.id)this.publish({proposals})}catch(e){if(request===this.proposalRequest&&this.state.workflow?.id===flow.id)this.publish({error:`修改提案读取失败：${String(e)}`})}}
  async resolveProposal(id:string,action:'accept'|'reject'){
    if(!this.api.resolveProposal||!this.state.workflow)throw new Error('当前宿主不支持修改提案')
    const source=this.state.workflow,navigation=this.navigationRequest
    if(action==='accept'&&this.hasUnsavedChanges())throw new Error('画布有未保存的流程修改，请先保存并让 Agent 基于最新版本重新生成提案；本地修改和当前提案已保留。')
    // Rejecting never needs to save the canvas. A view-only save before accept
    // is safe because Host compares the frozen definition, not just its number.
    if(action==='accept')await this.flush()
    if(this.disposed||navigation!==this.navigationRequest||this.state.workflow?.id!==source.id)throw new Error('工作流已切换，请在原工作流中重新处理提案')
    const flow=this.state.workflow,resolved=await this.api.resolveProposal(id,action,flow.revision)
    if(resolved.id!==id||resolved.workflowId!==flow.id||resolved.status==='pending')throw new Error('提案处理结果不一致，请重新读取提案状态')
    // The mutation receipt is authoritative. Do not depend on a second get/list
    // request succeeding, or let an older pending read resurrect this notice.
    ++this.proposalRequest;++this.libraryRequest
    if(this.disposed||navigation!==this.navigationRequest||this.state.workflow?.id!==source.id)return
    this.publish({proposals:[...(this.state.proposals??[]).filter(item=>item.id!==id),resolved]})
    if(resolved.status==='accepted'&&!this.hasUnsavedChanges()){
      const saved=resolved.candidate,editor={...saved.editor,viewport:copy(this.state.viewport),scopePath:[...this.state.scopePath]},current={...saved,editor}
      const viewChanged=JSON.stringify(saved.editor)!==JSON.stringify(editor)
      this.editSerial=viewChanged?1:0;this.persistedSerial=0;this.persistedWorkflow=copy(saved)
      this.update({workflow:current,undo:[],redo:[],saveState:'saved',library:{...this.state.library,workflows:this.state.library.workflows.map(item=>item.id===saved.id?saved:item)}})
    }
    void this.refreshProposals()
  }
  async load() {
    const request=++this.libraryRequest,presetsRequest=++this.presetsRequest
    this.update({loading:true,error:''})
    try {
      const library=await this.api.list('')
      if(request!==this.libraryRequest||this.disposed)return
      this.update({library:{...library,presets:presetsRequest===this.presetsRequest?library.presets:this.state.library.presets},loading:false})
      this.loadModels()
      this.libraryError=''
      this.scheduleRefresh()
    } catch(e){
      if(request!==this.libraryRequest||this.disposed)return
      // The background refresh retries and withdraws this error once the catalog answers.
      this.libraryError=String(e);this.update({loading:false,error:this.libraryError});this.scheduleRefresh()
    }
  }
  async open(id:string,refresh=false) {
    if(this.discardPhase)throw new Error(t('正在放弃修改并返回主页，请稍后再切换工作流。','Discarding changes and returning home. Wait before switching workflows.'))
    const request=++this.navigationRequest
    if(this.state.workflow?.id===id&&!refresh){this.update({page:'canvas'});void this.refreshReadiness().catch(()=>{});return}
    await this.flushForNavigation()
    if(request!==this.navigationRequest||this.disposed)return
    const workflow=await this.api.get(id)
    if(request!==this.navigationRequest||this.disposed)return
    // The previous canvas remains usable while fetching. Preserve edits made
    // during that wait before committing this navigation.
    await this.flushForNavigation()
    if(request!==this.navigationRequest||this.disposed)return
    this.editSerial=0;this.persistedSerial=0
    this.update({workflow,page:'canvas',configId:'',logs:false,annotationDraft:undefined,generateDraft:undefined,selected:[],scopePath:workflow.editor?.scopePath??[],undo:[],redo:[],saveState:'saved',error:'',run:this.state.library.runs.find(r=>r.workflowId===id),viewport:workflow.editor?.viewport??{x:32,y:40,scale:1}})
    if(this.state.run&&ACTIVE_RUN_STATUSES.includes(this.state.run.status))this.poll(this.state.run.id)
  }
  async create(workflow:Workflow) {
    if(this.discardPhase)throw new Error(t('正在放弃修改并返回主页，请稍后再创建工作流。','Discarding changes and returning home. Wait before creating a workflow.'))
    const request=++this.navigationRequest
    await this.flushForNavigation()
    const saved=await this.api.save(JSON.stringify(renumberWorkflow(workflow)),0)
    ++this.libraryRequest
    if(request!==this.navigationRequest||this.disposed)return
    this.editSerial=0;this.persistedSerial=0
    this.update({workflow:saved,page:'canvas',configId:'',logs:false,annotationDraft:undefined,generateDraft:undefined,selected:[],scopePath:[],undo:[],redo:[],run:undefined,saveState:'saved',error:'',viewport:{x:32,y:40,scale:1},library:{...this.state.library,workflows:[saved,...this.state.library.workflows]}})
  }
  edit(next:Workflow,history=true) {
    next=reconcileEditorReferences(next)
    next=renumberWorkflow(next)
    const current=this.state.workflow
    if(!current||current.id!==next.id)return
    this.editSerial++
    this.update({workflow:next,saveState:this.saveOperation||this.saving||this.savingAs?'saving':'dirty',error:'',...(history?{undo:[...this.state.undo.slice(-59),copy(current)],redo:[]}:{} )})
  }
  undo() {
    const previous=this.state.undo.at(-1),current=this.state.workflow
    if(!previous||!current)return
    this.edit({...copy(previous),revision:current.revision},false)
    this.update({undo:this.state.undo.slice(0,-1),redo:[...this.state.redo,copy(current)]})
  }
  redo() {
    const next=this.state.redo.at(-1),current=this.state.workflow
    if(!next||!current)return
    this.edit({...copy(next),revision:current.revision},false)
    this.update({redo:this.state.redo.slice(0,-1),undo:[...this.state.undo,copy(current)]})
  }
  /** Leaving a canvas is never blocked by a failed save of view state alone
   * (pan, zoom, scope), e.g. after the workflow's workspace was removed from the
   * Host. Graph, configuration or content changes still block and stay dirty. */
  flushForNavigation():Promise<void>{
    const flushing=this.flush()
    // Nothing to write: keep flush()'s own timing for navigation ordering.
    if(!this.saving)return flushing
    return flushing.catch(error=>{
      if(this.hasUnsavedChanges()||this.saving||this.savingAs||this.discardPhase)throw error
      this.persistedSerial=this.editSerial
      this.publish({saveState:'saved',error:''})
    })
  }
  async flush():Promise<void> {
    if(this.discardPhase==='reading')throw new Error(t('正在放弃修改并返回主页，请稍后再保存。','Discarding changes and returning home. Wait before saving.'))
    if(this.savingAs)throw new Error('正在另存为，请完成后再保存或切换工作流')
    if(this.saving){await this.saving;if(this.editSerial>this.persistedSerial)return this.flush();return}
    if(!this.state.workflow||this.editSerial===this.persistedSerial)return
    const snapshot=copy(this.state.workflow),serial=this.editSerial
    this.publish({saveState:'saving'})
    this.saving=(async()=>{
      try {
        const saved=await this.api.save(JSON.stringify(snapshot),snapshot.revision)
        ++this.libraryRequest
        this.persistedSerial=serial
        if(this.state.workflow?.id===saved.id){
          this.persistedWorkflow=copy(saved)
          this.update({workflow:this.editSerial===serial?saved:{...this.state.workflow,revision:saved.revision},saveState:this.saveOperation||this.editSerial!==serial?'saving':'saved',library:{...this.state.library,workflows:this.state.library.workflows.map(w=>w.id===saved.id?saved:w)}})
        }
      }catch(e){this.update({saveState:'error',error:`保存失败：${String(e)}`});throw e}
    })()
    try{await this.saving}finally{this.saving=undefined}
    if(this.editSerial>this.persistedSerial)return this.flush()
  }
  /** Explicit/interval/pre-run save: persist first, then check. Missing resources never prevent saving. */
  async save():Promise<WorkflowReadiness|undefined>{
    if(this.discardPhase)throw new Error(t('正在放弃修改并返回主页，请稍后再保存。','Discarding changes and returning home. Wait before saving.'))
    if(this.savingAs)throw new Error('正在另存为，请完成后再保存或运行')
    if(this.saveOperation)return this.saveOperation
    this.captureViewport()
    const flow=this.state.workflow&&copy(this.state.workflow)
    if(!flow)return
    for(const agent of flow.subAgents??[])if(!agent.sessionId&&this.state.sessionId)agent.sessionId=this.state.sessionId
    const editor={...flow.editor,viewport:copy(this.state.viewport),scopePath:[...this.state.scopePath]}
    if(JSON.stringify({...flow,editor})!==JSON.stringify(this.state.workflow))this.edit({...flow,editor},false)
    const id=flow.id,session=this.state.sessionId
    this.publish({saveState:'saving',error:''})
    this.saveOperation=(async()=>{
      await this.flush()
      if(this.state.workflow?.id!==id||this.state.sessionId!==session)throw new Error('工作流或对话已变化，请在当前画布重新保存')
      this.publish({savedAt:Date.now()})
      // Legacy hosts can persist drafts; execution still requires inspectReadiness.
      const report=this.api.inspectReadiness?await this.refreshReadiness():undefined
      return report
    })()
    try{return await this.saveOperation}
    finally{this.saveOperation=undefined;if(this.state.saveState!=='error')this.publish({saveState:this.pendingSaveState()})}
  }
  /** Save As forks the current draft; it does not overwrite the source or copy local grants. */
  async saveAs(raw:string):Promise<void>{
    if(this.discardPhase)throw new Error(t('正在放弃修改并返回主页，请稍后再另存为。','Discarding changes and returning home. Wait before saving a copy.'))
    if(this.savingAs)throw new Error('正在另存为，请勿重复提交')
    if(!this.api.importPackage)throw new Error('当前宿主不支持另存为，请更新插件')
    const source=this.state.workflow,serial=this.editSerial,session=this.state.sessionId
    if(!source)throw new Error('请先打开工作流')
    const previousSaving=this.saveOperation??this.saving
    this.publish({saveState:'saving'})
    this.savingAs=(async()=>{
      if(previousSaving)await previousSaving
      if(this.state.workflow?.id!==source.id||this.editSerial!==serial||this.state.sessionId!==session)throw new Error('工作流或对话已变化，请重新另存为')
      const saved=await this.api.importPackage!(raw,source.workspaceId,{},session)
      await this.refreshImportedAssets()
      ++this.libraryRequest
      const library={...this.state.library,workflows:[saved,...this.state.library.workflows.filter(flow=>flow.id!==saved.id)]}
      if(this.state.workflow?.id!==source.id||this.editSerial!==serial||this.state.sessionId!==session){this.publish({library});throw new Error('副本已创建，原画布有更新，已保留当前修改；可在主页打开副本')}
      this.editSerial=0;this.persistedSerial=0
      this.update({workflow:saved,library,undo:[],redo:[],selected:[],configId:'',logs:false,run:undefined,scopePath:saved.editor?.scopePath??[],viewport:saved.editor?.viewport??this.state.viewport,saveState:'saving',savedAt:Date.now(),error:''})
      if(this.api.inspectReadiness)try{await this.refreshReadiness()}catch{this.publish({libraryWarning:t('副本已创建，配置检查暂不可用；请稍后重新检查。','The copy was created. Configuration checking is temporarily unavailable; check again later.')})}
    })()
    try{await this.savingAs}finally{this.savingAs=undefined;this.publish({saveState:this.pendingSaveState()})}
  }
  async execute(inputs:Record<string,string>={},intent?:{workflowId:string;sessionId?:string}) {
    const checkIntent=()=>{if(intent&&(this.state.workflow?.id!==intent.workflowId||this.state.sessionId!==intent.sessionId))throw new Error('流程或对话已变化，请重新运行')}
    checkIntent()
    const readiness=await this.save()
    checkIntent()
    if(!this.state.workflow)return
    checkIntent()
    if(!readiness)throw new Error('当前宿主尚不支持配置检查，请更新插件后运行')
    if(this.editSerial>this.persistedSerial)throw new Error('流程配置已变化，请重新运行')
    if(!readiness.canRun||readiness.issues.length)throw new Error(`请先处理画布中的 ${readiness.issues.length} 项待处理配置，再执行运行`)
    const request=++this.runRequest,startedWorkflow=this.state.workflow.id,startedSession=this.state.sessionId
    const intentKey=JSON.stringify(['start',startedWorkflow,startedSession,inputs]),requestId=this.runIntent(intentKey)
    const run=await this.api.start(startedWorkflow,JSON.stringify(inputs),startedSession,requestId)
    if(request!==this.runRequest||this.disposed)return
    if(this.state.workflow?.id!==startedWorkflow||this.state.sessionId!==startedSession){++this.libraryRequest;this.publish({library:{...this.state.library,runs:[run,...this.state.library.runs.filter(value=>value.id!==run.id)]}})}
    else {this.setRun(run);if(ACTIVE_RUN_STATUSES.includes(run.status))this.poll(run.id)}
    if(this.runIntents.get(intentKey)===requestId)this.runIntents.delete(intentKey)
  }
  async answer(inputs:Record<string,string>) {
    if(!this.state.run)return
    const request=++this.runRequest
    const run=await this.api.answer(this.state.run.id,JSON.stringify(inputs));if(request!==this.runRequest||this.disposed)return;this.setRun(run);this.poll(run.id)
  }
  async cancel(){const active=this.state.library.runs.find(r=>r.workflowId===this.state.workflow?.id&&ACTIVE_RUN_STATUSES.includes(r.status));if(active){const request=++this.runRequest;const run=await this.api.cancel(active.id);if(request===this.runRequest&&!this.disposed)this.setRun(run)}}
  async control(action:'pause'|'resume'|'recover'|'rerun',id:string,planDigest?:string,review?:import('../shared/recovery-review.ts').RecoveryReview) {
    if(action==='resume'&&this.state.library.runs.find(run=>run.id===id)?.executions.some(execution=>execution.repair?.waiting))throw new Error('存在待修正的 Agent 输出，请确认修正内容后继续')
    const request=++this.runRequest
    let run:WorkflowRun,identity:{key:string;requestId:string}|undefined
    if(action==='recover'||action==='rerun'){
      const method=this.api[action];if(!method)throw new Error('当前宿主不支持此运行操作')
      const intent=JSON.stringify([action,id,this.state.sessionId,planDigest,review]),requestId=this.runIntent(intent)
      run=action==='recover'?await this.api.recover!(id,this.state.sessionId,planDigest,review,requestId):await this.api.rerun!(id,this.state.sessionId,requestId)
      identity={key:intent,requestId}
    }else{
      const method=this.api[action];if(!method)throw new Error('当前宿主不支持此运行操作')
      run=await method.call(this.api,id)
    }
    if(request!==this.runRequest||this.disposed)return
    this.setRun(run);if(ACTIVE_RUN_STATUSES.includes(run.status))this.poll(run.id)
    if(identity&&this.runIntents.get(identity.key)===identity.requestId)this.runIntents.delete(identity.key)
  }
  async followupAgent(runId:string,executionId:string,prompt:string,messageId:string){
    if(!this.api.followupAgent)throw new Error('当前宿主不支持补充 Agent 指令')
    const request=++this.runRequest,run=await this.api.followupAgent(runId,executionId,prompt,messageId)
    if(request!==this.runRequest||this.disposed)return
    this.setRun(run);if(ACTIVE_RUN_STATUSES.includes(run.status))this.poll(run.id)
  }
  async confirmRepairOutput(runId:string,executionId:string,expectedAttempts:number){
    if(!this.api.confirmRepairOutput)throw new Error('当前宿主不支持确认模型修复')
    const request=++this.runRequest,run=await this.api.confirmRepairOutput(runId,executionId,expectedAttempts)
    if(request!==this.runRequest||this.disposed)return
    this.setRun(run);if(ACTIVE_RUN_STATUSES.includes(run.status))this.poll(run.id)
  }
  async acceptRepairOutput(runId:string,executionId:string,output:Record<string,JsonValue>){
    if(!this.api.acceptRepairOutput)throw new Error('当前宿主不支持人工修正输出')
    const request=++this.runRequest,run=await this.api.acceptRepairOutput(runId,executionId,output)
    if(request!==this.runRequest||this.disposed)return
    this.setRun(run);if(ACTIVE_RUN_STATUSES.includes(run.status))this.poll(run.id)
  }
  async previewRunRevision(runId:string,workflow:Workflow,sessionId?:string){
    if(!this.api.previewRunRevision)throw new Error('当前宿主不支持运行修订预览')
    const plan=await this.api.previewRunRevision(runId,workflow,sessionId)
    if(plan.sourceRunId!==runId)throw new Error('运行修订计划与来源运行不一致，请重新核验')
    return plan
  }
  async applyRunRevision(runId:string,workflow:Workflow,planDigest:string,sessionId?:string){
    if(!this.api.applyRunRevision)throw new Error('当前宿主不支持应用运行修订')
    const request=++this.runRequest,run=await this.api.applyRunRevision(runId,workflow,planDigest,sessionId)
    if(request!==this.runRequest||this.disposed)return
    this.setRun(run);if(ACTIVE_RUN_STATUSES.includes(run.status))this.poll(run.id)
  }
  async recoveryPlan(runId:string,review?:import('../shared/recovery-review.ts').RecoveryReview){
    if(!this.api.recoveryPlan)throw new Error('当前宿主不支持恢复预览')
    const plan=review?await this.api.recoveryPlan(runId,review):await this.api.recoveryPlan(runId)
    if(plan.sourceRunId!==runId)throw new Error('恢复计划与来源运行不一致，请重新核验')
    return plan
  }
  async stopExecution(runId:string,executionId:string){
    if(!this.api.stopNode)throw new Error('当前宿主不支持单独停止 Agent')
    const request=++this.runRequest,run=await this.api.stopNode(runId,executionId)
    if(request!==this.runRequest||this.disposed)return
    this.setRun(run);if(ACTIVE_RUN_STATUSES.includes(run.status))this.poll(run.id)
  }
  private setRun(run:WorkflowRun){
    ++this.libraryRequest
    this.update({run,selectedRunId:run.id,library:{...this.state.library,runs:[run,...this.state.library.runs.filter(r=>r.id!==run.id)]}})
  }
  selectRun(id:string){const run=this.state.library.runs.find(item=>item.id===id&&item.workflowId===this.state.workflow?.id);if(!run)return;this.update({run,selectedRunId:id});if(ACTIVE_RUN_STATUSES.includes(run.status))this.poll(id)}
  private poll(id:string){
    if(this.disposed)return
    clearTimeout(this.pollTimer)
    this.pollTimer=setTimeout(async()=>{
      const request=this.runRequest
      try{const run=await this.api.run(id);if(this.disposed||this.state.run?.id!==id||request!==this.runRequest)return;this.setRun(run);if(ACTIVE_RUN_STATUSES.includes(run.status))this.poll(id)}
      catch(e){this.update({error:`读取运行状态失败：${String(e)}`})}
    },700)
  }
  async refreshPresets(){
    const request=++this.presetsRequest,presets=await this.api.presets()
    if(!this.disposed&&request===this.presetsRequest)this.update({library:{...this.state.library,presets}})
  }
  /** Refresh assets created by an already committed import without replacing a
   * dirty editor or turning a successful Host write into an import failure. */
  async refreshImportedAssets():Promise<void>{
    const request=++this.libraryRequest,presetsRequest=++this.presetsRequest
    const [catalog,roles]=await Promise.allSettled([
      Promise.resolve().then(()=>this.api.list('')),
      Promise.resolve().then(()=>this.api.presets()),
    ])
    if(this.disposed)return
    const loaded=catalog.status==='fulfilled'&&catalog.value&&Array.isArray(catalog.value.workflows)&&Array.isArray(catalog.value.presets)?catalog.value:undefined
    const readRoles=roles.status==='fulfilled'&&Array.isArray(roles.value)?roles.value:undefined
    const library=loaded&&request===this.libraryRequest?loaded:this.state.library
    const presets=presetsRequest===this.presetsRequest?(readRoles??loaded?.presets??this.state.library.presets):this.state.library.presets
    const warning=!loaded||!readRoles?t('流程已保存，部分资源目录暂时无法刷新；请稍后刷新，无需重复创建或导入。','The workflow was saved. Some resource catalogs could not be refreshed; refresh later without creating or importing it again.'):undefined
    this.update({library:{...library,presets},...((request===this.libraryRequest||presetsRequest===this.presetsRequest)&&(warning||this.state.libraryWarning)?{libraryWarning:warning}:{})})
  }
  private loadModels(){void this.api.models().then(models=>this.update({models,modelsError:''})).catch(e=>this.update({modelsError:String(e)}))}
  private scheduleRefresh(){
    if(this.disposed)return
    clearTimeout(this.refreshTimer)
    this.refreshTimer=setTimeout(async()=>{
      const request=++this.libraryRequest,presetsRequest=++this.presetsRequest
      try{
        const rawLibrary=await this.api.list('')
        const library={...rawLibrary,presets:presetsRequest===this.presetsRequest?rawLibrary.presets:this.state.library.presets}
        if(request!==this.libraryRequest||this.disposed)return
        const current=this.state.workflow,remote=current&&library.workflows.find(w=>w.id===current.id)
        const latest=current&&library.runs.find(r=>r.workflowId===current.id)
        const patch:Partial<EditorState>={library}
        // The first load failed before reading models; recovering the catalog completes that initialization.
        if(this.libraryError){if(this.state.error===this.libraryError)patch.error='';this.libraryError='';this.loadModels()}
        if(remote&&remote.revision>current!.revision&&this.editSerial===this.persistedSerial&&!this.saving){patch.workflow=remote;patch.undo=[];patch.redo=[]}
        const selected=this.state.selectedRunId?library.runs.find(run=>run.id===this.state.selectedRunId&&run.workflowId===current?.id):undefined
        if(selected)patch.run=selected
        else if(latest&&(!this.state.run||latest.startedAt>this.state.run.startedAt||latest.id===this.state.run.id)){patch.run=latest}
        this.update(patch)
        void this.refreshProposals()
      }catch{/* Explicit refresh remains available; transient background errors do not erase local edits. */}
      finally{if(!this.disposed)this.scheduleRefresh()}
    },3000)
  }
  dispose(){clearTimeout(this.draftTimer);clearTimeout(this.readinessTimer);this.readinessRequest++;this.queueDraft(this.snapshotDraft(this.state));this.unsubscribePreferences();this.disposed=true;clearTimeout(this.saveTimer);clearTimeout(this.pollTimer);clearTimeout(this.refreshTimer);this.listeners.clear()}
}
export function useWorkflowStore(store:WorkflowStore){return useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot)}
