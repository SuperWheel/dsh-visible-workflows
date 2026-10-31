import type { PlanningCanvasContext, PlanningPublicationUpdates, PlanningProgressUpdate } from '../shared/planning-ui.ts'
import { workflowVisibleInWorkspace } from '../shared/workflow-scope.ts'
import type { WorkflowStore } from './store.ts'

export interface PlanningUiCursor { cursor:number;epoch?:string;progress?:PlanningProgressUpdate[];progressScope?:string }
/** Visible tab bodies own leases; the resident conversation binder owns the
 * single Host context. Hiding one of several bodies must not hide the others. */
export class PlanningCanvasVisibility {
  private bodies=new Set<symbol>()
  private listeners=new Set<()=>void>()
  getSnapshot=()=>this.bodies.size>0
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
  mount():()=>void {
    const token=Symbol();this.bodies.add(token);this.listeners.forEach(listener=>listener())
    return()=>{if(this.bodies.delete(token))this.listeners.forEach(listener=>listener())}
  }
}
export interface PlanningUiApi {
  /** Server waits for journal events. Legacy adapters retain the 3-second schedule. */
  eventDrivenUpdates?:boolean
  setPlanningContext(sessionId:string,context:PlanningCanvasContext):Promise<void>
  planningUpdates(sessionId:string,afterSequence:number,epoch:string):Promise<PlanningPublicationUpdates>
}
export interface PlanningUiBinding {
  sessionId:string
  store:Pick<WorkflowStore,'getSnapshot'|'subscribe'|'hasUnsavedChanges'|'refreshProposals'>
  api:PlanningUiApi
  cursor:PlanningUiCursor
  workspaceId:()=>string|undefined
  canvasVisibility?:Pick<PlanningCanvasVisibility,'getSnapshot'|'subscribe'>
  onCreated:(workflowId:string,sessionId:string)=>Promise<void>|void
  onError?:(message:string)=>void
  /** The connection works again: withdraw the message last passed to onError. */
  onRecover?:(message:string)=>void
  onProgress?:(updates:PlanningProgressUpdate[])=>void
  clientId?:string
}

/** A mounted canvas supplies an untrusted selection hint. Only Host receipts
 * announce a result; this bridge never starts planning or writes a workflow. */
export function bindPlanningUi({sessionId,store,api,cursor,workspaceId,canvasVisibility,onCreated,onError,onRecover,onProgress,clientId=crypto.randomUUID()}:PlanningUiBinding):()=>void {
  let disposed=false,sequence=0,signature='',contextBusy=false,pollBusy=false
  let pending:PlanningCanvasContext|undefined
  let lastError='',pollError='',contextError='',progressSignature='',pollFailures=0,unavailableRounds=0
  let nextPoll:ReturnType<typeof setTimeout>|undefined,lastScope:string|undefined
  const notifyProgress=()=>{
    if(disposed||!onProgress)return
    const updates=cursor.progress??[],signature=JSON.stringify(updates)
    if(signature===progressSignature)return
    progressSignature=signature;onProgress(structuredClone(updates))
  }
  // A poll success withdraws only the poll's own failure. An unresolved context
  // write failure is tracked separately and stays (or becomes) the visible error.
  const recover=()=>{
    const message=pollError;pollError=''
    if(disposed||!message||lastError!==message||contextError===message)return
    lastError='';onRecover?.(message)
    if(contextError){lastError=contextError;onError?.(contextError)}
  }
  // A context write success withdraws only the context failure; an unresolved
  // poll failure stays (or becomes) the visible error.
  const resolveContext=()=>{
    const message=contextError;contextError=''
    if(disposed||!message||lastError!==message||pollError===message)return
    lastError='';onRecover?.(message)
    if(pollError){lastError=pollError;onError?.(pollError)}
  }
  const fail=(error:unknown,fromPoll=false)=>{
    if(disposed)return
    const message=`工作流规划连接暂不可用：${error instanceof Error?error.message:String(error)}`
    if(fromPoll)pollError=message;else contextError=message
    // Writing a visible store error causes a subscription notification too.
    if(message!==lastError){lastError=message;onError?.(message)}
  }
  const currentScope=()=>JSON.stringify([sessionId,workspaceId()??''])
  const syncProgressScope=()=>{
    const scope=currentScope()
    if(cursor.progressScope&&cursor.progressScope!==scope||lastScope!==undefined&&lastScope!==scope){cursor.progress=[];cursor.progressScope=scope;cursor.cursor=0;notifyProgress()}
    lastScope=scope
    return scope
  }
  const drain=async()=>{
    if(contextBusy)return
    contextBusy=true
    try{
      while(pending){const value=pending;pending=undefined;try{await api.setPlanningContext(sessionId,value);resolveContext()}catch(error){fail(error)}}
    }finally{contextBusy=false}
  }
  const sync=(force=false)=>{
    syncProgressScope()
    const state=store.getSnapshot(),workspace=workspaceId()
    const flow=!disposed&&(canvasVisibility?.getSnapshot()??true)&&state.sessionId===sessionId&&state.page==='canvas'&&state.workflow&&workspace&&workflowVisibleInWorkspace(state.workflow,workspace)?state.workflow:undefined
    const selection={...(flow?{workflowId:flow.id,revision:flow.revision}:{}),dirty:!!flow&&store.hasUnsavedChanges()}
    const next=JSON.stringify(selection)
    if(!force&&next===signature)return
    signature=next;pending={clientId,sequence:++sequence,...selection};void drain()
  }
  const poll=async()=>{
    if(disposed||pollBusy)return
    pollBusy=true
    try{
      const requestedScope=syncProgressScope(),requestedEpoch=cursor.epoch
      const result=await api.planningUpdates(sessionId,cursor.cursor,requestedEpoch??'')
      pollFailures=0;recover()
      // No live root Agent or workspace yet is a normal state of a resident dock:
      // stay quiet, keep the cursor, and back off instead of reporting an error.
      if(result.epoch==='unavailable'){unavailableRounds++;return}
      unavailableRounds=0
      if(disposed||currentScope()!==requestedScope)return
      // A sibling binding can have observed the restarted Host while this older request was in flight.
      if(cursor.epoch!==requestedEpoch&&result.epoch!==cursor.epoch)return
      // Only an epoch change signals a restart. A smaller cursor in the same epoch is an older sibling response.
      if(result.epoch!==cursor.epoch){cursor.cursor=0;if(cursor.progress)cursor.progress=[]}
      cursor.epoch=result.epoch
      const updates=[...result.items.map(item=>({type:'publication' as const,item})),...(result.progress??[]).map(item=>({type:'progress' as const,item}))].sort((a,b)=>a.item.sequence-b.item.sequence)
      for(const update of updates){
        const item=update.item
        if(disposed||currentScope()!==requestedScope||cursor.epoch!==result.epoch)return
        if(item.sequence<=cursor.cursor)continue
        // Claim before awaiting a notification so a remount cannot replay it.
        cursor.cursor=item.sequence
        if(update.type==='progress'){
          cursor.progressScope=requestedScope
          const item=update.item,previous=cursor.progress?.find(entry=>entry.taskId===item.taskId)
          if(!previous||item.taskRevision>previous.taskRevision)cursor.progress=[...(cursor.progress??[]).filter(entry=>entry.taskId!==item.taskId),structuredClone(item)].sort((a,b)=>a.sequence-b.sequence).slice(-20)
          notifyProgress()
        }else{
          const item=update.item
          if(item.kind==='created')await onCreated(item.workflowId,sessionId)
          else if(store.getSnapshot().sessionId===sessionId&&store.getSnapshot().workflow?.id===item.workflowId)await store.refreshProposals()
        }
      }
      if(!disposed&&currentScope()===requestedScope&&cursor.epoch===result.epoch){cursor.cursor=Math.max(cursor.cursor,result.cursor);notifyProgress()}
    }catch(error){pollFailures++;fail(error,true)}finally{
      pollBusy=false
      const backoff=pollFailures||unavailableRounds
      if(api.eventDrivenUpdates&&!disposed)nextPoll=setTimeout(()=>{void poll()},backoff?Math.min(30_000,1000*2**Math.min(backoff-1,5)):50)
    }
  }
  const unsubscribe=store.subscribe(()=>sync())
  const unsubscribeVisibility=canvasVisibility?.subscribe(()=>sync())
  syncProgressScope();notifyProgress();sync();void poll()
  const heartbeat=setInterval(()=>sync(true),25_000)
  const publicationPoll=api.eventDrivenUpdates?undefined:setInterval(()=>{void poll()},3_000)
  return()=>{
    if(disposed)return
    disposed=true;unsubscribe();unsubscribeVisibility?.();clearInterval(heartbeat);clearInterval(publicationPoll);clearTimeout(nextPoll)
    // A final higher sequence only clears this mounted client's own hint.
    sync(true)
  }
}
