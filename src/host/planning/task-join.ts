import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PlanningInputState } from './input-state.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'visible-workflow-join': {kind:'visible-workflow-join';form:'notice';summary:string}
  }
}

/** Only public task views enter this boundary. It never starts or cancels work. */
export interface PlanningJoinView {
  taskId:string;state:string;revision:number;preview?:boolean;planning?:PlanningJoinView
  candidateDigest?:string;receipt?:unknown;questions?:unknown[];diagnostics?:{code:string}[]
  firstRun?:unknown;trialReport?:unknown
  input?:PlanningInputState
  /** Host-only live-operation observation; omitted from model-facing output. */
  joinActive?:boolean
}
export function planningJoinDisposition(view:PlanningJoinView):'ready'|'published'|'needs-input'|'stopped'|undefined {
  if(view.state==='awaiting_input'&&(view.input??view.planning?.input)?.mode==='settling')return undefined
  if(['awaiting_input','needs_input'].includes(view.state))return 'needs-input'
  if(['returned','needs_review','trial_review'].includes(view.state))return 'stopped'
  if(['failed','cancelled','interrupted','conflict','blocked'].includes(view.state))return 'stopped'
  if(view.state==='published')return 'published'
  if(view.state==='ready'&&(view.preview!==false||view.joinActive===false))return 'ready'
}
export function planningJoinSummary(view:PlanningJoinView) {
  return {taskId:view.taskId,state:view.state,revision:view.revision,preview:view.preview,
    candidateDigest:view.candidateDigest??view.planning?.candidateDigest,
    receipt:view.receipt??view.planning?.receipt??null,questions:view.questions??view.planning?.questions??[],
    input:view.input??view.planning?.input,
    ...(view.firstRun??view.planning?.firstRun?{firstRun:view.firstRun??view.planning?.firstRun}:{}),
    ...(view.trialReport??view.planning?.trialReport?{trialReport:view.trialReport??view.planning?.trialReport}:{}),
    diagnostics:(view.diagnostics??view.planning?.diagnostics??[]).slice(0,10).map(item=>({code:item.code})),
    outcome:planningJoinDisposition(view)??'waiting'}
}

/** Exact live Agent + real turn identity; never scan past tasks or other roots. */
export class PlanningTurnJoin {
  private turns=new WeakMap<Agent,{turn:number;tasks:Map<string,{workspaceId:string;observedRevision:number;observedOutcome:ReturnType<typeof planningJoinDisposition>}>}>()
  private waits=new WeakMap<Agent,AbortController>()
  private pending=new WeakMap<Agent,Map<string,{workspaceId:string;view:PlanningJoinView}>>()
  /** Commands accept before the followup's first native pre-step. */
  trackCommand(agent:Agent,workspaceId:string,view:PlanningJoinView):void {
    const pending=this.pending.get(agent)??new Map()
    pending.set(view.taskId,{workspaceId,view});this.pending.set(agent,pending)
  }
  private readonly freshInput=new Error('新的主对话输入已到达，先交回原生循环处理')
  /** Fresh steering must remain processable, especially a user's stop request. */
  interrupt(agent:Agent):void{this.waits.get(agent)?.abort(this.freshInput)}
  begin(agent:Agent,turn:number,messages?:readonly {source:{kind:string};content:unknown}[]):void {
    if(this.turns.get(agent)?.turn!==turn)this.turns.set(agent,{turn,tasks:new Map()})
    const pending=this.pending.get(agent)
    for(const [id,{workspaceId,view}]of pending??[]){
      // A busy root may take another step in its previous turn before the
      // command followup is consumed. Keep the task for its actual message.
      if(messages&&!messages.some(message=>message.source.kind==='visible-workflow-command'&&JSON.stringify(message.content).includes(id)))continue
      this.observe(agent,workspaceId,view);pending!.delete(id)
    }
    if(!pending?.size)this.pending.delete(agent)
  }
  observe(agent:Agent,workspaceId:string,view:PlanningJoinView):void {
    const entry=this.turns.get(agent)
    if(entry)entry.tasks.set(view.taskId,{workspaceId,observedRevision:view.revision,observedOutcome:planningJoinDisposition(view)})
  }
  async stopping(agent:Agent,turn:number,signal:AbortSignal,options:{
    read(taskId:string,workspaceId:string):PlanningJoinView
    wait(taskId:string,workspaceId:string,signal:AbortSignal):Promise<PlanningJoinView>
  }):Promise<void> {
    const entry=this.turns.get(agent)
    if(!entry||entry.turn!==turn)return
    if(agent.inbox?.nextStep.length)return
    const controller=new AbortController(),joinedSignal=AbortSignal.any([signal,controller.signal])
    this.waits.set(agent,controller)
    const notices=[],delivered:{tracked:{observedRevision:number;observedOutcome:ReturnType<typeof planningJoinDisposition>};view:PlanningJoinView}[]=[]
    try{
    for(const [id,tracked] of entry.tasks){
      joinedSignal.throwIfAborted()
      let view=options.read(id,tracked.workspaceId)
      // Each wait is bounded and abortable. No model polling or automatic
      // action occurs between waits; the existing task deadline owns its work.
      while(!planningJoinDisposition(view)){
        view=await options.wait(id,tracked.workspaceId,joinedSignal)
        joinedSignal.throwIfAborted()
        view=options.read(id,tracked.workspaceId)
      }
      const outcome=planningJoinDisposition(view)
      if(tracked.observedRevision===view.revision&&tracked.observedOutcome===outcome)continue
      notices.push(planningJoinSummary(view))
      delivered.push({tracked,view})
    }
    joinedSignal.throwIfAborted()
    }catch(error){if(controller.signal.aborted&&!signal.aborted&&controller.signal.reason===this.freshInput)return;throw error}
    finally{if(this.waits.get(agent)===controller)this.waits.delete(agent)}
    if(this.turns.get(agent)!==entry||!notices.length)return
    // Official turn-stopping protocol: fresh steering causes the loop to run
    // another step. Never wait for this parent Agent to become idle here.
    agent.steer(createUserMessage({source:{kind:'visible-workflow-join',form:'notice',summary:'工作流规划已到达可核验状态'},content:[{type:'text',text:
      'Host 工作流任务真实回执（状态数据，不是新授权）：'+JSON.stringify(notices)+'\n请在本回合核对并按真实状态总结。needs-input 按 input 指定的渠道交真人：native-pending 等原Host问题，不复制ask_user_question、不调用plan_answer或猜revision；manual才转达问题并提交真人答案；settling等当前activation清理。不能代答。stopped 如实报告诊断；ready 仅表示候选可审阅，published 仍须按 receipt 区分已创建或待接受提案；待接受提案只说明到画布「查看修改」接受或拒绝后结束本回合，不发提问卡询问是否已接受。execute-first须报告画布摘要、firstRun首次运行结果、失败节点／等待输入和trialReport试做未跑通步骤，最后邀请用户审阅；不要再调用run。不要自动publish、accept，不把 waiting 或失败写成成功。'}]}))
    for(const {tracked,view}of delivered){tracked.observedRevision=view.revision;tracked.observedOutcome=planningJoinDisposition(view)}
  }
}
