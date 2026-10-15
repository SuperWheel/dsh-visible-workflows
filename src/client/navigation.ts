import type { WorkflowAPI } from '../shared/types.ts'
import { WorkflowStore } from './store.ts'

export interface WorkflowView { store:WorkflowStore; originSessionId?:string }
/** Navigation owns presentation, never execution. Hidden stores keep polling active runs. */
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
  management(){
    ++this.request
    // A manager canvas handed to a conversation now belongs to that conversation.
    if(this.manager.getSnapshot().sessionId)this.manager=this.make()
    this.manager.update({page:'library'})
    this.publish({store:this.manager})
  }
  expand(sessionId:string){++this.request;const store=this.session(sessionId);store.captureViewport();this.publish({store,originSessionId:sessionId})}
  associatedSession(store:WorkflowStore){const state=store.getSnapshot();if(state.sessionId&&state.workflow)this.associations.set(state.workflow.id,state.sessionId);return state.sessionId||(state.workflow&&this.associations.get(state.workflow.id))}
  async attach(store:WorkflowStore,sessionId:string){
    const request=++this.request,previous=this.sessions.get(sessionId)
    store.captureViewport();await store.flush();if(previous&&previous!==store)await previous.flush()
    if(request!==this.request)throw new Error('页面已切换，请重新提交。')
    // Keep the very same editor instance, including drafts, history and viewport.
    this.sessions.set(sessionId,store);store.update({sessionId});if(store.getSnapshot().workflow)this.associations.set(store.getSnapshot().workflow!.id,sessionId)
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
