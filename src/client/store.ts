import { useSyncExternalStore } from 'react'
import type { LibrarySnapshot, ModelChoice, Workflow, WorkflowAPI, WorkflowRun } from '../shared/types.ts'
import { renumberWorkflow } from '../shared/numbering.ts'

export interface EditorState {
  library: LibrarySnapshot; models: ModelChoice[]; workflow?: Workflow; run?: WorkflowRun
  loading: boolean; error: string; saveState: 'saved'|'saving'|'error'; page: 'library'|'canvas'
  selected: string[]; scopePath: string[]; undo: Workflow[]; redo: Workflow[]; sessionId?: string
  viewport: {x:number;y:number;scale:number}
  annotationDraft?: {id?:string;text:string;nodeIds:string[]}
  generateDraft?: string
  generateTargetId?: string
  configId?: string
  logs?: boolean
  search?: string
  workspaceFilter?: string
  statusFilter?: string
  pendingWorkflow?: {id:string;title:string}
  modelsError?: string
}
const copy = <T,>(value: T): T => structuredClone(value)
/** One editing context; its full-width and sidebar presentations share this instance. */
export class WorkflowStore {
  private state: EditorState = {library:{workflows:[],presets:[],runs:[],workspaces:[]},models:[],loading:true,error:'',saveState:'saved',page:'library',selected:[],scopePath:[],undo:[],redo:[],viewport:{x:32,y:40,scale:1}}
  private listeners = new Set<()=>void>()
  private saveTimer?: ReturnType<typeof setTimeout>
  private pollTimer?: ReturnType<typeof setTimeout>
  private refreshTimer?: ReturnType<typeof setTimeout>
  private saving?: Promise<void>
  private editSerial = 0
  private persistedSerial = 0
  private navigationRequest = 0
  private libraryRequest = 0
  private runRequest = 0
  private disposed = false
  private viewportReader?: {read:()=>EditorState['viewport'];workflowId:string}
  registerViewport=(read:()=>EditorState['viewport'],workflowId:string)=>{
    const entry={read,workflowId};this.viewportReader=entry
    return()=>{if(this.viewportReader===entry){this.captureViewport();this.viewportReader=undefined}}
  }
  captureViewport(){const entry=this.viewportReader;if(entry&&this.state.workflow?.id===entry.workflowId)this.update({viewport:entry.read()})}
  constructor(readonly api: WorkflowAPI) {}
  getSnapshot = () => this.state
  subscribe = (fn:()=>void) => {this.listeners.add(fn);return()=>this.listeners.delete(fn)}
  update = (patch: Partial<EditorState>) => {if(this.disposed)return;this.state={...this.state,...patch};this.listeners.forEach(fn=>fn())}
  async load() {
    const request=++this.libraryRequest
    this.update({loading:true,error:''})
    try {
      const library=await this.api.list('')
      if(request!==this.libraryRequest||this.disposed)return
      this.update({library,loading:false})
      void this.api.models().then(models=>this.update({models,modelsError:''})).catch(e=>this.update({modelsError:String(e)}))
      this.scheduleRefresh()
    } catch(e){this.update({loading:false,error:String(e)})}
  }
  async open(id:string) {
    const request=++this.navigationRequest
    if(this.state.workflow?.id===id){this.update({page:'canvas'});return}
    await this.flush()
    if(request!==this.navigationRequest||this.disposed)return
    const workflow=await this.api.get(id)
    if(request!==this.navigationRequest||this.disposed)return
    // The previous canvas remains usable while fetching. Preserve edits made
    // during that wait before committing this navigation.
    await this.flush()
    if(request!==this.navigationRequest||this.disposed)return
    this.editSerial=0;this.persistedSerial=0
    this.update({workflow,page:'canvas',configId:'',logs:false,annotationDraft:undefined,generateDraft:undefined,selected:[],scopePath:[],undo:[],redo:[],saveState:'saved',error:'',run:this.state.library.runs.find(r=>r.workflowId===id),viewport:{x:32,y:40,scale:1}})
    if(this.state.run?.status==='running'||this.state.run?.status==='waiting')this.poll(this.state.run.id)
  }
  async create(workflow:Workflow) {
    const request=++this.navigationRequest
    await this.flush()
    const saved=await this.api.save(JSON.stringify(renumberWorkflow(workflow)),0)
    ++this.libraryRequest
    if(request!==this.navigationRequest||this.disposed)return
    this.editSerial=0;this.persistedSerial=0
    this.update({workflow:saved,page:'canvas',configId:'',logs:false,annotationDraft:undefined,generateDraft:undefined,selected:[],scopePath:[],undo:[],redo:[],run:undefined,saveState:'saved',error:'',viewport:{x:32,y:40,scale:1},library:{...this.state.library,workflows:[saved,...this.state.library.workflows]}})
  }
  edit(next:Workflow,history=true) {
    next=renumberWorkflow(next)
    const current=this.state.workflow
    if(!current||current.id!==next.id)return
    if(this.state.library.runs.some(r=>r.workflowId===current.id&&['running','waiting'].includes(r.status)))throw new Error('请先停止当前运行，再编辑原流程。')
    this.editSerial++
    this.update({workflow:next,saveState:'saving',error:'',...(history?{undo:[...this.state.undo.slice(-59),copy(current)],redo:[]}:{} )})
    clearTimeout(this.saveTimer)
    this.saveTimer=setTimeout(()=>void this.flush().catch(()=>{}),500)
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
  async flush():Promise<void> {
    clearTimeout(this.saveTimer)
    if(this.saving){await this.saving;if(this.editSerial>this.persistedSerial)return this.flush();return}
    if(!this.state.workflow||this.editSerial===this.persistedSerial)return
    const snapshot=copy(this.state.workflow),serial=this.editSerial
    this.saving=(async()=>{
      try {
        const saved=await this.api.save(JSON.stringify(snapshot),snapshot.revision)
        ++this.libraryRequest
        this.persistedSerial=serial
        if(this.state.workflow?.id===saved.id){
          this.update({workflow:this.editSerial===serial?saved:{...this.state.workflow,revision:saved.revision},saveState:this.editSerial===serial?'saved':'saving',library:{...this.state.library,workflows:this.state.library.workflows.map(w=>w.id===saved.id?saved:w)}})
        }
      }catch(e){this.update({saveState:'error',error:`保存失败：${String(e)}`});throw e}
    })()
    try{await this.saving}finally{this.saving=undefined}
    if(this.editSerial>this.persistedSerial)return this.flush()
  }
  async execute(inputs:Record<string,string>={}) {
    await this.flush()
    if(!this.state.workflow)return
    const request=++this.runRequest
    const run=await this.api.start(this.state.workflow.id,JSON.stringify(inputs),this.state.sessionId)
    if(request!==this.runRequest||this.disposed)return
    this.setRun(run);if(run.status==='running'||run.status==='waiting')this.poll(run.id)
  }
  async answer(inputs:Record<string,string>) {
    if(!this.state.run)return
    const request=++this.runRequest
    const run=await this.api.answer(this.state.run.id,JSON.stringify(inputs));if(request!==this.runRequest||this.disposed)return;this.setRun(run);this.poll(run.id)
  }
  async cancel(){const active=this.state.library.runs.find(r=>r.workflowId===this.state.workflow?.id&&['running','waiting'].includes(r.status));if(active){const request=++this.runRequest;const run=await this.api.cancel(active.id);if(request===this.runRequest&&!this.disposed)this.setRun(run)}}
  private setRun(run:WorkflowRun){
    ++this.libraryRequest
    this.update({run,library:{...this.state.library,runs:[run,...this.state.library.runs.filter(r=>r.id!==run.id)]}})
  }
  private poll(id:string){
    if(this.disposed)return
    clearTimeout(this.pollTimer)
    this.pollTimer=setTimeout(async()=>{
      const request=this.runRequest
      try{const run=await this.api.run(id);if(this.disposed||this.state.run?.id!==id||request!==this.runRequest)return;this.setRun(run);if(['running','waiting'].includes(run.status))this.poll(id)}
      catch(e){this.update({error:`读取运行状态失败：${String(e)}`})}
    },700)
  }
  async refreshPresets(){const presets=await this.api.presets();this.update({library:{...this.state.library,presets}})}
  private scheduleRefresh(){
    if(this.disposed)return
    clearTimeout(this.refreshTimer)
    this.refreshTimer=setTimeout(async()=>{
      const request=++this.libraryRequest
      try{
        const library=await this.api.list('')
        if(request!==this.libraryRequest||this.disposed)return
        const current=this.state.workflow,remote=current&&library.workflows.find(w=>w.id===current.id)
        const latest=current&&library.runs.find(r=>r.workflowId===current.id)
        const patch:Partial<EditorState>={library}
        if(remote&&remote.revision>current!.revision&&this.editSerial===this.persistedSerial&&!this.saving){patch.workflow=remote;patch.undo=[];patch.redo=[]}
        if(latest&&(!this.state.run||latest.startedAt>this.state.run.startedAt||latest.id===this.state.run.id)){patch.run=latest}
        this.update(patch)
      }catch{/* Explicit refresh remains available; transient background errors do not erase local edits. */}
      finally{if(!this.disposed)this.scheduleRefresh()}
    },3000)
  }
  dispose(){this.disposed=true;clearTimeout(this.saveTimer);clearTimeout(this.pollTimer);clearTimeout(this.refreshTimer);this.listeners.clear()}
}
export function useWorkflowStore(store:WorkflowStore){return useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot)}
