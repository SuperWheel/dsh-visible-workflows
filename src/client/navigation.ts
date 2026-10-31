import type { WorkflowAPI } from '../shared/types.ts'
import { WorkflowStore } from './store.ts'

export interface WorkflowEntryHost {
  selectedSession():string|undefined
  isBlankSession(id:string):boolean
  startSession():void
}
/** A left entry keeps the exact current conversation. With no selection only
 * the Host's new-session flow may supply a surface; never choose recent chats. */
export async function workflowEntrySession(host:WorkflowEntryHost,isCurrent:()=>boolean=()=>true,wait:()=>Promise<void>=()=>new Promise(resolve=>setTimeout(resolve,30))):Promise<string|undefined>{
  const selected=host.selectedSession()
  if(selected)return selected
  host.startSession()
  const started=Date.now()
  while(isCurrent()&&Date.now()-started<4000){
    await wait()
    if(!isCurrent())return undefined
    const current=host.selectedSession()
    if(current){
      if(host.isBlankSession(current))return current
      // An unrelated manual navigation won while the blank session was opening.
      return undefined
    }
  }
  if(!isCurrent())return undefined
  throw new Error('请先在 DeepSeekHarness 添加工作区或打开对话，再打开工作流。')
}

export interface WorkflowView { store:WorkflowStore; originSessionId?:string }
/** Session-scoped editors survive native sidebar resize, fullscreen and tab switches. */
export class WorkflowViews {
  private manager:WorkflowStore
  private sessions=new Map<string,WorkflowStore>()
  private stores=new Set<WorkflowStore>()
  private listeners=new Set<()=>void>()
  private main:WorkflowView
  private request=0
  private associations=new Map<string,string>()
  constructor(private api:WorkflowAPI){this.manager=this.make();this.main={store:this.manager}}
  private make(){const store=new WorkflowStore(this.api);this.stores.add(store);void store.load();return store}
  getSnapshot=()=>this.main
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn)}}
  private publish(view:WorkflowView){this.main=view;this.listeners.forEach(fn=>fn())}
  session(id:string){let store=this.sessions.get(id);if(!store){store=this.make();store.update({sessionId:id});this.sessions.set(id,store)}return store}
  management(sessionId?:string){
    ++this.request
    if(sessionId){
      const store=this.session(sessionId)
      store.captureViewport();store.update({page:'library'});this.publish({store})
      return store
    }
    // A manager canvas handed to a conversation now belongs to that conversation.
    if(this.manager.getSnapshot().sessionId)this.manager=this.make()
    this.manager.update({page:'library'})
    this.publish({store:this.manager})
    return this.manager
  }
  expand(sessionId:string){++this.request;const store=this.session(sessionId);store.captureViewport();this.publish({store,originSessionId:sessionId})}
  associatedSession(store:WorkflowStore){const state=store.getSnapshot();if(state.sessionId&&state.workflow)this.associations.set(state.workflow.id,state.sessionId);return state.sessionId||(state.workflow&&this.associations.get(state.workflow.id))}
  async attach(store:WorkflowStore,sessionId:string){
    const request=++this.request,previous=this.sessions.get(sessionId)
    const protectTargetDraft=()=>{
      const state=previous?.getSnapshot()
      if(previous&&previous!==store&&(state?.annotationDraft!==undefined||state?.generateDraft!==undefined))throw new Error('目标对话存在未提交的工作流需求，请先完成或关闭该需求，或者选择新对话。')
    }
    protectTargetDraft()
    store.captureViewport();await store.flush();if(previous&&previous!==store)await previous.flush()
    if(request!==this.request)throw new Error('页面已切换，请重新提交。')
    // The target may have opened an editor while either workflow was saving.
    protectTargetDraft()
    // Keep the very same editor instance, including drafts, history and viewport.
    const sourceSession=store.getSnapshot().sessionId
    await store.associateSession(sessionId)
    if(sourceSession&&sourceSession!==sessionId&&this.sessions.get(sourceSession)===store)this.sessions.delete(sourceSession)
    this.sessions.set(sessionId,store);if(store.getSnapshot().workflow)this.associations.set(store.getSnapshot().workflow!.id,sessionId)
    if(previous&&previous!==store&&previous!==this.manager&&previous!==this.main.store){previous.dispose();this.stores.delete(previous)}
    this.publish({...this.main})
  }
  async generated(workflowId:string,sessionId:string){
    const flow=await this.api.get(workflowId)
    const store=this.session(sessionId)
    // A completed background request is a notification, not a navigation command.
    store.update({pendingWorkflow:{id:flow.id,title:flow.title}})
  }
  dispose(){for(const store of this.stores)store.dispose();this.stores.clear();this.listeners.clear()}
}
