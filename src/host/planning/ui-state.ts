import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { PlanningCanvasContext, PlanningPublicationUpdates, PlanningPublicationUpdate, PlanningProgressUpdate, PlanningProgressState } from '../../shared/planning-ui.ts'
import { PLANNING_PROGRESS_STATES } from '../../shared/planning-ui.ts'
import type { PlanningTask } from './service.ts'
import type { PlanningTrial } from './trial-service.ts'
import { planningReceiptSchema } from './receipt.ts'

const identity=z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const contextSchema=z.object({clientId:identity,sequence:z.number().int().nonnegative().safe(),workflowId:identity.optional(),revision:z.number().int().nonnegative().safe().optional(),dirty:z.boolean()}).strict().superRefine((v,c)=>{
  if((v.workflowId===undefined)!==(v.revision===undefined)||!v.workflowId&&v.dirty)c.addIssue({code:'custom',message:'画布上下文身份、版本或未保存状态无效'})
})
/** Hints cannot grant permission. Consumers must recheck the actual live root and stored workflow. */
export class PlanningUIState {
  private contexts=new Map<string,{value:PlanningCanvasContext;updatedAt:number}>()
  private publications=new Map<string,{workspaceId:string;sessionId:string;update:PlanningPublicationUpdate}>()
  private progress=new Map<string,{workspaceId:string;sessionId:string;update:PlanningProgressUpdate}>()
  private waiters=new Map<string,Set<{finish:()=>void;close:()=>void}>>()
  private waiterCount=0
  private disposed=false
  private sequence=0
  private readonly epoch=randomUUID()
  constructor(private now=Date.now){}
  set(sessionId:string,value:unknown):void{
    identity.parse(sessionId)
    const context=contextSchema.parse(value),key=JSON.stringify([sessionId,context.clientId])
    this.prune()
    const previous=this.contexts.get(key)
    if(previous&&context.sequence<=previous.value.sequence)return
    if(!previous&&this.contexts.size>=500)throw new Error('画布上下文数量达到上限，请关闭不使用的窗口后重试')
    this.contexts.set(key,{value:context,updatedAt:this.now()})
  }
  current(sessionId:string):PlanningCanvasContext|undefined{
    const contexts=this.forSession(sessionId)
    if(!contexts.length)return undefined
    if(new Set(contexts.map(value=>value.workflowId)).size>1)throw new Error('当前对话在多个窗口打开了不同工作流，请用 @ 明确选择要优化的流程')
    return this.aggregate(contexts)
  }
  /** An explicit target is not made ambiguous by a different canvas in another window. */
  forWorkflow(sessionId:string,workflowId:string):PlanningCanvasContext|undefined{
    return this.aggregate(this.forSession(sessionId).filter(context=>context.workflowId===workflowId))
  }
  private forSession(sessionId:string):PlanningCanvasContext[]{
    this.prune()
    return [...this.contexts].filter(([key])=>JSON.parse(key)[0]===sessionId).map(([,entry])=>entry.value).filter(value=>value.workflowId)
  }
  private aggregate(contexts:PlanningCanvasContext[]):PlanningCanvasContext|undefined{
    if(!contexts.length)return undefined
    // Any stale window must remain visible to Host revision checks rather than being masked by a newer window.
    const oldest=contexts.reduce((a,b)=>a.revision!<b.revision!?a:b)
    return {...oldest,dirty:contexts.some(value=>value.dirty)}
  }
  private prune(){const before=this.now()-120_000;for(const[key,entry]of this.contexts)if(entry.updatedAt<before)this.contexts.delete(key)}
  private recordProgress(task:{id:string;sessionId:string;workspaceId:string;revision:number;state:PlanningProgressState;updatedAt:string;events?:{state:PlanningProgressState;at:string;message:string}[];request:{targetWorkflowId?:string};context?:{workflow:{id:string}}},cancellable?:boolean):void{
    if(!identity.safeParse(task.id).success||!identity.safeParse(task.sessionId).success||!task.workspaceId||!Number.isSafeInteger(task.revision)||task.revision<1||!(PLANNING_PROGRESS_STATES as readonly string[]).includes(task.state))return
    const key=JSON.stringify([task.workspaceId,task.sessionId,task.id]),previous=this.progress.get(key)
    if(previous&&task.revision<=previous.update.taskRevision)return
    const event=task.events?.at(-1),at=event?.at??task.updatedAt
    if(!at||!Number.isFinite(Date.parse(at)))return
    const message=(event?.state===task.state?event.message:'')?.slice(0,1200)??''
    const workflowId=task.request.targetWorkflowId??task.context?.workflow.id
    const update:PlanningProgressUpdate={sequence:++this.sequence,taskId:task.id,taskRevision:task.revision,state:task.state,at,message,
      ...(workflowId?{workflowId}:{}),cancellable:cancellable??!['returned','handed_off','published','failed','cancelled','interrupted','conflict','blocked','cancelling'].includes(task.state)}
    this.progress.delete(key);this.progress.set(key,{workspaceId:task.workspaceId,sessionId:task.sessionId,update})
    while(this.progress.size>500)this.progress.delete(this.progress.keys().next().value!)
  }
  record(task:PlanningTask):void{
    if(this.disposed)return
    const before=this.sequence
    try{
      this.recordProgress(task)
      if(task.state!=='published'||!task.receipt)return
      const checked=planningReceiptSchema.safeParse(task.receipt)
      if(!checked.success||task.context?.workflow.id!==checked.data.workflowId)return
      const key=JSON.stringify([task.workspaceId,task.sessionId,task.receipt.key])
      if(this.publications.has(key))return
      const receipt=task.receipt,update:PlanningPublicationUpdate={sequence:++this.sequence,taskId:task.id,kind:receipt.kind,workflowId:receipt.workflowId,revision:receipt.revision,...(receipt.proposalId?{proposalId:receipt.proposalId}:{})}
      this.publications.set(key,{workspaceId:task.workspaceId,sessionId:task.sessionId,update})
      while(this.publications.size>500)this.publications.delete(this.publications.keys().next().value!)
    }finally{if(this.sequence>before)this.wake(task.workspaceId,task.sessionId)}
  }
  recordTrial(trial:PlanningTrial):void{
    if(this.disposed)return
    const before=this.sequence
    const states:Record<PlanningTrial['state'],PlanningProgressState>={preparing:'trial_preparing',executing:'trial_executing',verifying:'trial_verifying',needs_input:'awaiting_input',needs_review:'interrupted',verified:'trial_verifying',planning:'distilling',ready:'trial_ready',failed:'failed',cancelled:'cancelled',interrupted:'interrupted'}
    const messages:Record<PlanningTrial['state'],string>={preparing:'试做已受理，尚未完成业务',executing:'正在执行冻结范围内的本次任务',verifying:'核验实际文件与执行前冻结的条件',needs_input:'试做已停止，需要补充信息；不会自动重做',needs_review:'旧版复核已结束，保留记录且不自动重放',verified:'试做记录已保存，检查缺口保留',planning:'试做完成，正在提炼工作流',ready:'试做结果已保留；生成图状态请查看规划任务',failed:'试做或后续规划失败，请查看具体诊断',cancelled:'试做已取消，已发生动作的回执保留',interrupted:'试做已中断，不会自动重做'}
    const state=states[trial.state]
    this.recordProgress({id:trial.id,sessionId:trial.rootSessionId,workspaceId:trial.workspaceId,revision:trial.revision,state,updatedAt:trial.updatedAt,request:trial.request,events:[{state,at:trial.updatedAt,message:messages[trial.state]}]},!['needs_input','ready','failed','cancelled','interrupted'].includes(trial.state))
    if(this.sequence>before)this.wake(trial.workspaceId,trial.rootSessionId)
  }
  private wake(workspaceId:string,sessionId:string):void{
    for(const waiter of [...(this.waiters.get(JSON.stringify([workspaceId,sessionId]))??[])])waiter.finish()
  }
  /** Host event wakeup over the same scoped journal; transport remains bounded long polling. */
  waitUpdates(workspaceId:string,sessionId:string,after:number,afterEpoch?:string,waitMs=0,signal?:AbortSignal):Promise<PlanningPublicationUpdates>{
    if(signal?.aborted)return Promise.reject(signal.reason??new Error('规划等待已取消'))
    if(this.disposed)return Promise.reject(new Error('规划通知已关闭'))
    if(!Number.isSafeInteger(waitMs)||waitMs<0||waitMs>20_000)return Promise.reject(new Error('规划通知等待时间须为0至20000毫秒'))
    const current=this.updates(workspaceId,sessionId,after,afterEpoch)
    // Epoch handshakes and existing owned events never wait. Invisible events alone do not wake an owner.
    if(!waitMs||afterEpoch!==current.epoch||after>current.cursor||current.items.length||current.progress?.length)return Promise.resolve(current)
    const key=JSON.stringify([workspaceId,sessionId]),listeners=this.waiters.get(key)??new Set<{finish:()=>void;close:()=>void}>()
    if(this.waiterCount>=128||listeners.size>=4)return Promise.reject(new Error('规划通知等待数量达到上限'))
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{
        clearTimeout(timer)
        signal?.removeEventListener('abort',abort)
        if(listeners.delete(waiter))this.waiterCount--
        if(!listeners.size)this.waiters.delete(key)
      }
      const waiter={finish:()=>{cleanup();resolve(this.updates(workspaceId,sessionId,after,afterEpoch))},close:()=>{cleanup();reject(new Error('规划通知已关闭'))}}
      const abort=()=>{cleanup();reject(signal?.reason??new Error('规划等待已取消'))}
      const timer=setTimeout(waiter.finish,waitMs)
      listeners.add(waiter);this.waiters.set(key,listeners);this.waiterCount++
      signal?.addEventListener('abort',abort,{once:true})
      if(signal?.aborted)abort()
    })
  }
  dispose():void{
    if(this.disposed)return
    this.disposed=true
    for(const listeners of [...this.waiters.values()])for(const waiter of [...listeners])waiter.close()
    this.contexts.clear();this.publications.clear();this.progress.clear()
  }
  updates(workspaceId:string,sessionId:string,after:number,afterEpoch?:string):PlanningPublicationUpdates{
    if(!Number.isSafeInteger(after)||after<0)throw new Error('规划通知游标无效')
    // Epoch detects a restart even when its fresh sequence has already overtaken the old cursor.
    const cursor=afterEpoch!==this.epoch||after>this.sequence?0:after
    const progress=[...this.progress.values()].filter(value=>value.workspaceId===workspaceId&&value.sessionId===sessionId&&value.update.sequence>cursor).map(value=>({...value.update}))
    return {epoch:this.epoch,cursor:this.sequence,...(progress.length?{progress}:{}),items:[...this.publications.values()].filter(value=>value.workspaceId===workspaceId&&value.sessionId===sessionId&&value.update.sequence>cursor).map(value=>({...value.update}))}
  }
}
