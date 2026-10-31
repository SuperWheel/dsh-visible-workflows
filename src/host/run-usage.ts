import { randomUUID } from 'node:crypto'
import type { WorkflowRun } from '../shared/types.ts'
import type { TokenUsage } from './runtime.ts'

/** Usage receipts are a ledger only. No field
 * here authorizes work or caps tokens; old limit/estimate values are inert. */
export function initializeUsage(run: WorkflowRun): NonNullable<WorkflowRun['usage']> {
  return run.usage ??= { spentTokens:0, reservedTokens:0, unknownTokens:0, unknownCalls:0, agentTasks:0, calls:0, allocations:{} }
}

/** A pending receipt identity, with zero token reservation. */
export function recordUsageCall(run:WorkflowRun,agent:boolean):{id:string;tokens:number}{
  const state=initializeUsage(run),id=randomUUID()
  state.calls++;if(agent)state.agentTasks++
  state.allocations[id]={tokens:0,status:'reserved'}
  return {id,tokens:0}
}

/** Keep liveness/accounting validation without a known/unknown usage gate. */
export function observeAgentUsage(run:WorkflowRun,ids:string[],usage:TokenUsage|undefined,completedCalls:number):void{
  if(!Number.isSafeInteger(completedCalls)||completedCalls<0)throw new Error('Agent 调用回执数量无效')
  const state=initializeUsage(run)
  const pending=ids.map(id=>state.allocations[id]).find(item=>item?.status==='reserved')
  if(!pending)throw new Error('Agent 用量记录已结束，不能启动下一步骤')
  if(usage&&Number.isSafeInteger(usage.totalTokens)&&usage.totalTokens>=0)pending.usage=Math.max(pending.usage??0,usage.totalTokens)
}

/** Only provider-reported use is added. Missing use is a call count, not zero
 * consumption and not an estimated token charge. Old reserved amounts remain
 * readable, but are released without carrying them into new unknown estimates.
 * Settlement is idempotent per allocation: a trusted receipt may later replace
 * an "unknown" settlement once (for example after the engine exited), but a
 * settled allocation never changes and missing use never erases known use. */
export function settleUsage(run:WorkflowRun,id:string,usage:TokenUsage|undefined):void{
  const state=initializeUsage(run),allocation=state.allocations[id]
  const known=!!usage&&Number.isSafeInteger(usage.totalTokens)&&usage.totalTokens>=0
  if(allocation?.status==='unknown'&&known){
    const prior=allocation.usage??0,reported=Math.max(prior,usage!.totalTokens)
    if(!Number.isSafeInteger(state.spentTokens+reported-prior))throw new Error('实际Token用量超出可安全累计范围')
    state.spentTokens+=reported-prior;allocation.usage=reported;allocation.status='settled';state.unknownCalls=Math.max(0,state.unknownCalls-1)
    return
  }
  if(!allocation||allocation.status!=='reserved')return
  state.reservedTokens=Math.max(0,state.reservedTokens-allocation.tokens)
  const reported=known?Math.max(allocation.usage??0,usage!.totalTokens):allocation.usage
  if(reported!==undefined){
    if(!Number.isSafeInteger(state.spentTokens+reported))throw new Error('实际Token用量超出可安全累计范围')
    allocation.usage=reported;state.spentTokens+=reported
  }
  if(known)allocation.status='settled'
  else{allocation.status='unknown';state.unknownCalls++}
}

/** One cumulative native-task receipt is never split into invented per-message
 * usage. Supplemental instructions have their own delivery IDs, no model calls.
 * Once no allocation is open, only the group's leading allocation can still
 * take a late trusted receipt, replacing its "unknown" settlement once. */
export function settleUsageGroup(run:WorkflowRun,ids:string[],usage:TokenUsage|undefined):void{
  const allocations=initializeUsage(run).allocations
  const pending=ids.filter(id=>allocations[id]?.status==='reserved')
  if(!pending.length){if(ids[0]!==undefined&&allocations[ids[0]]?.status==='unknown')settleUsage(run,ids[0],usage);return}
  settleUsage(run,pending[0]!,usage)
  for(const id of pending.slice(1))settleUsage(run,id,undefined)
}

interface Waiter {key:string;workspace?:string;limit:number;signal:AbortSignal;resolve:(release:()=>void)=>void;reject:(error:unknown)=>void;abort:()=>void}
/** Process-wide capacity plus per-root-run capacity. Cancellation removes queued calls. */
export class ModelAdmission {
  private count=0
  private active=new Map<string,number>()
  private workspaces=new Map<string,number>()
  private waiting:Waiter[]=[]
  constructor(private readonly maximum=8,private readonly workspaceMaximum=4){}
  acquire(key:string,limit:number,signal:AbortSignal,workspace?:string):Promise<()=>void>{
    signal.throwIfAborted()
    return new Promise((resolve,reject)=>{
      const entry:Waiter={key,workspace,limit:Math.max(1,Math.min(8,limit)),signal,resolve,reject,abort:()=>{this.waiting=this.waiting.filter(item=>item!==entry);reject(signal.reason??new Error('已取消排队'))}}
      this.waiting.push(entry);signal.addEventListener('abort',entry.abort,{once:true});this.drain()
    })
  }
  private drain():void{
    for(const entry of [...this.waiting]){
      if(this.count>=this.maximum)return
      if((this.active.get(entry.key)??0)>=entry.limit)continue
      if(entry.workspace&&(this.workspaces.get(entry.workspace)??0)>=this.workspaceMaximum)continue
      this.waiting.splice(this.waiting.indexOf(entry),1);entry.signal.removeEventListener('abort',entry.abort)
      if(entry.signal.aborted){entry.reject(entry.signal.reason);continue}
      this.count++;this.active.set(entry.key,(this.active.get(entry.key)??0)+1)
      if(entry.workspace)this.workspaces.set(entry.workspace,(this.workspaces.get(entry.workspace)??0)+1)
      let released=false
      entry.resolve(()=>{if(released)return;released=true;this.count--;const n=(this.active.get(entry.key)??1)-1;if(n)this.active.set(entry.key,n);else this.active.delete(entry.key);if(entry.workspace){const remaining=(this.workspaces.get(entry.workspace)??1)-1;if(remaining)this.workspaces.set(entry.workspace,remaining);else this.workspaces.delete(entry.workspace)}this.drain()})
    }
  }
}
