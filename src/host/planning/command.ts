import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const WORKFLOW_PLANNING_COMMAND = 'dsh-visible-workflows'

/** The optional native command service contract in DSH 0.2.1. */
export interface CommandInvocation { commandId: string; agent: Agent; rawInput: string; attachments: readonly unknown[]; signal: AbortSignal }
interface CommandResult { kind: 'success' | 'error'; text?: string }
interface CommandDefinition {
  name: string; description: string; input: { hint: string }
  handler(invocation: CommandInvocation): Promise<CommandResult>
}
interface CommandRegistry { register(definition: CommandDefinition): () => void }

export interface CurrentPlanningTarget { workflowId: string; title: string; revision: number; dirty: boolean }
export interface WorkflowPlanningCommandOptions {
  /** Validate the live main conversation and workspace, without selecting a model or starting work. */
  authorize(agent: Agent, signal: AbortSignal): void
  /** Host catalog data, bound to every step of the admitted command turn. */
  brief?(invocation:CommandInvocation):string
  /** Omitted when rollback is enabled. Acceptance must not await model work. */
  intake?(invocation:CommandInvocation):Promise<{taskId:string}>
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'visible-workflow-command':{kind:'visible-workflow-command';form:'notice';summary:string}
  }
}

/**
 * SDK 0.2.1-rc.1：plan-mode/lib/index.js:17-20 明确先组装后 pre-step；
 * agent/lib/index.js assembleContextFor 同时传 agent/scope/回合 signal。
 * 组装无 messages，不能仅凭 scope 将排队命令预挂到忙碌回合。
 * 仅在 followup 前空闲且 inbox 为空时预挂下一 turn/start；其他情况仍在
 * 精确消息获准后激活。runtime-types.d.ts:293-310 定义受理消息和回合 signal。
 * 简报是冻结的 system section，不使用短命 command RPC signal。
 */
function bindCommandBrief(agent:Agent,message:UserMessage,brief:string,onDispose:()=>void):()=>void {
  const disposers:(()=>void)[]=[]
  const previewEligible=agent.status==='idle'&&agent.inbox.nextTurn.length===0&&agent.inbox.nextStep.length===0
  let proposedTurn:number|undefined
  let preview:{turn:number;signal:AbortSignal}|undefined,active:typeof preview,closed=false
  let removeSection=()=>{}
  const dispose=(force=false)=>{
    if(!closed){closed=true;removeSection();onDispose()}
    // 已组装的文本不可撤回。discard/插件卸载若夹在组装和受理之间，保留
    // 一次受理守卫以拒绝该快照；到受理、abort 或回合边界即释放监听。
    if(!force&&preview&&!active&&!preview.signal.aborted)return
    for(const undo of disposers.splice(0).reverse())undo()
  }
  const watchAbort=(signal:AbortSignal)=>{
    const abort=()=>dispose(true)
    signal.addEventListener('abort',abort,{once:true})
    disposers.push(()=>signal.removeEventListener('abort',abort))
  }
  removeSection=agent.ctx.systemPrompt.section({name:'visible-workflows:command-brief:'+message.id,order:86,interpolate:false,
    text:context=>{
      if(closed||context.agent!==agent||context.scope!==agent||!context.signal||context.signal.aborted)return ''
      if(active)return context.signal===active.signal?brief:''
      if(!previewEligible||proposedTurn===undefined)return ''
      if(!preview){preview={turn:proposedTurn,signal:context.signal};watchAbort(context.signal)}
      return context.signal===preview.signal?brief:''
    }})
  disposers.push(agent.ctx.on('agent/pre-step',async(payload,next)=>{
    if(payload.agent!==agent)return next()
    if(closed){dispose(true);return preview?.signal===payload.signal?{kind:'reject'}:next()}
    // Keep the same section and frozen text across all steps of this turn.
    // A different turn or signal must never inherit the command context.
    if(active){
      if(payload.turn!==active.turn||payload.signal!==active.signal||payload.signal.aborted){dispose(true);return next()}
      try{
        const decision=await next()
        if(decision.kind==='reject')dispose(true)
        return decision
      }catch(error){dispose(true);throw error}
    }
    const owns=payload.messages.some(row=>row.id===message.id)
    try{
      const decision=await next()
      const previewed=preview?.signal===payload.signal
      if(decision.kind==='reject'||payload.signal.aborted){if(owns||previewed)dispose(true);return decision}
      if(closed||!owns||!decision.messages.some(row=>row.id===message.id)){
        if(owns||previewed)dispose(true)
        // 消息在组装后被替换/丢弃，不能让含旧简报的快照进入模型请求。
        return previewed?{kind:'reject'}:decision
      }
      if(preview&&(preview.turn!==payload.turn||preview.signal!==payload.signal)){dispose(true);return decision}
      active={turn:payload.turn,signal:payload.signal}
      if(!preview)watchAbort(payload.signal)
      return decision
    }catch(error){if(owns||preview?.signal===payload.signal)dispose(true);throw error}
  }))
  disposers.push(agent.ctx.on('agent/inbox/discarded',payload=>{if(payload.agent===agent&&payload.message.id===message.id)dispose()}))
  disposers.push(agent.ctx.on('agent/turn-stopping',payload=>{if(payload.agent===agent&&(payload.turn===active?.turn||payload.turn===proposedTurn))dispose(true)}))
  disposers.push(agent.ctx.on('session/event',(session,event)=>{
    if(session!==agent.session)return
    if(event.type==='turn/start'){
      if(active||proposedTurn!==undefined)dispose(true)
      else if(previewEligible)proposedTurn=event.data.turn
    }
    if(event.type==='turn/end'&&(event.data.turn===active?.turn||event.data.turn===proposedTurn))dispose(true)
  }))
  disposers.push(agent.ctx.on('agent/disposed',payload=>{if(payload.agent===agent)dispose(true)}))
  return ()=>dispose()
}

/** Accept textual requirements early when enabled; otherwise preserve user text and supply scoped Host context. */
export function createWorkflowPlanningCommand(options: WorkflowPlanningCommandOptions,scope?:Context): CommandDefinition {
  const contexts=new Set<()=>void>()
  scope?.effect(()=>()=>{for(const dispose of contexts)dispose()})
  return {
    name: WORKFLOW_PLANNING_COMMAND,
    description: '在当前对话中协作新建或优化工作流',
    input: { hint: '描述需求，或直接发送后与 Agent 沟通' },
    async handler(invocation) {
      const {agent,signal,rawInput,attachments}=invocation
      signal.throwIfAborted()
      options.authorize(agent, signal)
      // The native registry rejects attachments too; alternate adapters must not silently discard them.
      if (attachments.length) throw new Error('此工作流命令暂只接收文字需求，请在普通对话中说明附件内容后规划。')
      if (typeof rawInput !== 'string' || rawInput.length > 100_000) throw new Error('工作流需求无效或过长，请控制在 100000 字以内。')
      if(rawInput.trim()&&options.intake){
        signal.throwIfAborted()
        const {taskId}=await options.intake(invocation)
        // Intake owns a managed background lifetime. Closing the command RPC
        // after acceptance must not cancel it or discard the waiting notice.
        agent.followup(createUserMessage({source:{kind:'visible-workflow-command',form:'notice',summary:'Host 已受理工作流命令'},content:[
          {type:'text',text:JSON.stringify({source:'用户原始需求',requirement:rawInput})},
          {type:'text',text:'Host 生成的受理通知（不是用户原话或新增授权）：'+JSON.stringify({taskId})+'。立即调用 visible_workflow_plan_wait；后续传回 event_cursor，只等待、按 input 渠道转达真人问题并凭真实回执汇报。不重查目录、不重新路由或提交需求。returned 时读取 Host 简报并沿用现行路径。'},
        ]}))
        return {kind:'success'}
      }
      const brief=rawInput.trim()?options.brief?.(invocation):undefined
      const separator = rawInput && !/^\s/.test(rawInput) ? ' ' : ''
      const message = createUserMessage({ content: [{ type: 'text', text: `/${WORKFLOW_PLANNING_COMMAND}${separator}${rawInput}` }], source: { kind: 'user' } })
      signal.throwIfAborted()
      // followup wakes an idle Agent or queues one complete next turn. Do not
      // await that turn or attach its lifetime to this short-lived command RPC.
      let dispose:(()=>void)|undefined
      if(brief){dispose=bindCommandBrief(agent,message,brief,()=>contexts.delete(dispose!));contexts.add(dispose)}
      try{agent.followup(message)}catch(error){dispose?.();throw error}
      return { kind: 'success' }
    },
  }
}

/** Match the official plan-mode integration: activate only when the optional native registry exists. */
export function registerWorkflowPlanningCommand(ctx: Context, options: WorkflowPlanningCommandOptions): void {
  ctx.inject(['commands'], commandCtx => {
    const registry = (commandCtx as unknown as { get(name: string): unknown }).get('commands') as CommandRegistry
    commandCtx.effect(() => registry.register(createWorkflowPlanningCommand(options,commandCtx)))
  })
}
