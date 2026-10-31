import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {assembleContextFor,type Agent} from '@deepseek-ai/dsh-agent'
import SystemPrompt,{renderPrompt} from '@deepseek-ai/dsh-system-prompt'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import { createWorkflowPlanningCommand, registerWorkflowPlanningCommand, type WorkflowPlanningCommandOptions } from '../src/host/planning/command.ts'

function setup() {
  const ctx=new Context()
  const followup = vi.fn(), agent = { id: 'main', followup,ctx } as unknown as Agent, controller = new AbortController()
  const options: WorkflowPlanningCommandOptions = { authorize: vi.fn() }
  const invocation = { agent, signal: controller.signal, rawInput: '  按原文生成：\n第一步 A\n第二步 B  ', commandId: 'native:command-1', attachments: [] }
  return { ctx,agent, controller, followup, options, invocation, command: () => createWorkflowPlanningCommand(options) }
}

describe('native workflow planning command', () => {
  it('T23.20：空闲 Agent 的首步先组装简报，再受理消息', async () => {
    const f=setup(),prompt=f.ctx.plugin(SystemPrompt,{includeHarnessIdentity:false});await prompt
    Object.assign(f.agent,{status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{id:'main'}})
    f.options.brief=()=>'{"routeRule":"首步必须可见"}'
    const signal=new AbortController().signal
    try{
      await f.command().handler(f.invocation)
      Object.assign(f.agent,{status:'running'})
      f.ctx.emit('session/event',f.agent.session,{type:'turn/start',data:{turn:1}} as any)
      const message=f.followup.mock.calls[0]![0]
      // SDK 0.2.1-rc.1 dsh-plan-mode/lib/index.js:17–20：先 assembly，
      // 后 agent/pre-step；同一步请求重试复用 assembly。真实 SystemPrompt 服务，
      // Agent 驱动替身使用 dsh-agent assembleContextFor 的 agent/scope/signal 形状。
      const first=renderPrompt(await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent,signal}))
      await f.ctx.waterfall('agent/pre-step',{agent:f.agent,messages:[message],turn:1,step:1,signal},async()=>({kind:'enter' as const,messages:[message]}))
      expect(first).toBe('{"routeRule":"首步必须可见"}')
    }finally{await prompt.dispose()}
  })
  it('hands off through the installed official registry with paired command events and truthful user messages', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', new URL('./fixtures/planning-command-fixture.ts', import.meta.url).pathname], { timeout: 20_000 })
    expect(JSON.parse(stdout.trim())).toEqual({ ok: true, nativeRegistry: true, exactInput: true, exactOwner: true, bareHandoff: true, followups: 2, commandOnlyEvents: true, unregister: true })
  })

  it('registers the optional native command and disposes it with the plugin scope', async () => {
    const ctx = new Context(), fixture = setup(), unregister = vi.fn(), register = vi.fn(() => unregister)
    const dispose = ctx.provide('commands', { register })
    const fiber = ctx.plugin((scope: Context) => registerWorkflowPlanningCommand(scope, fixture.options))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: 'dsh-visible-workflows', input: expect.objectContaining({ hint: expect.any(String) }), handler: expect.any(Function) }))
    await fiber.dispose(); dispose()
    expect(unregister).toHaveBeenCalledTimes(1)
  })

  it('preserves the actual slash input and uses the official immutable user-message helper once', async () => {
    const f = setup(), result = await f.command().handler(f.invocation)
    expect(f.options.authorize).toHaveBeenCalledWith(f.agent, f.controller.signal)
    expect(f.followup).toHaveBeenCalledTimes(1)
    const message = f.followup.mock.calls[0]![0]
    expect(message).toMatchObject({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `/dsh-visible-workflows${f.invocation.rawInput}` }] })
    expect(typeof message.id).toBe('string'); expect(Object.isFrozen(message)).toBe(true)
    expect(result).toEqual({ kind: 'success' })
  })

  it('hands a bare command to the normal conversation instead of asking or planning inside the command', async () => {
    const f = setup(); f.invocation.rawInput = ''
    expect(await f.command().handler(f.invocation)).toEqual({ kind: 'success' })
    expect(f.followup.mock.calls[0]![0].content).toEqual([{ type: 'text', text: '/dsh-visible-workflows' }])
  })

  it.each(['优化这个 workflow，先演示新建一个版本',' 优化这个 workflow，先演示新建一个版本','\n优化这个 workflow，先演示新建一个版本'])('preserves separator behaviour for rawInput %j', async rawInput => {
    const f = setup(); f.invocation.rawInput = rawInput
    await f.command().handler(f.invocation)
    const message=f.followup.mock.calls[0]![0]
    expect(message.content).toEqual([{type:'text',text:`/dsh-visible-workflows${/^\s/.test(rawInput)?'':' '}${rawInput}`}])
    expect(message.source).toEqual({kind:'user'})
  })

  it('keeps Host data out of user content and byte-stable across all steps of the admitted turn only',async()=>{
    const f=setup();f.options.brief=vi.fn(()=>'{"source":"Host 简报"}')
    const prompt=f.ctx.plugin(SystemPrompt,{includeHarnessIdentity:false});await prompt
    const signal=new AbortController().signal
    const assemble=async(control=signal)=>renderPrompt(await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent,signal:control}))
    const step=async(messages:any[],owner=f.agent,turn=1,step=1)=>f.ctx.waterfall('agent/pre-step',{agent:owner,messages,turn,step,signal},async()=>({kind:'enter' as const,messages}))
    try{
    await f.command().handler(f.invocation)
    const message=f.followup.mock.calls[0]![0]
    expect(message).toMatchObject({source:{kind:'user'},content:[{type:'text',text:'/dsh-visible-workflows'+f.invocation.rawInput}]})
    expect(message.content).toHaveLength(1)
    expect(await assemble()).toBe('')
    await step([createUserMessage({source:{kind:'user'},content:[{type:'text',text:'other turn'}]})])
    expect(await assemble()).toBe('')
    await step([message],{id:'foreign'} as Agent)
    expect(await assemble()).toBe('')
    f.controller.abort(new Error('command RPC ended'))
    expect((await step([message])).messages).toEqual([message])
    const firstPrompt=await assemble()
    expect(firstPrompt).toBe('{"source":"Host 简报"}')
    expect(await assemble(new AbortController().signal)).toBe('')
    await step([],f.agent,1,2)
    expect(await assemble()).toBe(firstPrompt)
    await step([message],f.agent,2)
    expect(await assemble()).toBe('')
    expect(f.options.brief).toHaveBeenCalledExactlyOnceWith(f.invocation)
    f.invocation.rawInput='  '
    await f.command().handler({...f.invocation,signal:new AbortController().signal})
    expect(f.followup.mock.calls[1]![0].content).toEqual([{type:'text',text:'/dsh-visible-workflows  '}])
    expect(f.options.brief).toHaveBeenCalledTimes(1)
    }finally{await prompt.dispose()}
  })

  it.each(['discard','reject','abort','stop','end','dispose','other-signal','throw'] as const)('cleans command context on %s without leaking to a later turn',async action=>{
    const f=setup(),prompt=f.ctx.plugin(SystemPrompt,{includeHarnessIdentity:false});await prompt
    f.options.brief=()=>'{"source":"Host 简报"}'
    const controller=new AbortController(),signal=controller.signal
    try{
      await f.command().handler(f.invocation)
      const message=f.followup.mock.calls[0]![0],payload={agent:f.agent,messages:[message],turn:1,step:1,signal}
      if(action==='discard')f.ctx.emit('agent/inbox/discarded',{agent:f.agent,message})
      if(action==='throw')await expect(f.ctx.waterfall('agent/pre-step',payload,async()=>{throw Error('admission failed')})).rejects.toThrow('admission failed')
      else await f.ctx.waterfall('agent/pre-step',payload,async()=>action==='reject'?{kind:'reject' as const}:{kind:'enter' as const,messages:[message]})
      if(action==='abort')controller.abort()
      if(action==='stop')await f.ctx.serial('agent/turn-stopping',{agent:f.agent,turn:1,signal})
      if(action==='end'){
        const session={} as Agent['session'];Object.assign(f.agent,{session})
        f.ctx.emit('session/event',session,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}} as any)
      }
      if(action==='dispose')f.ctx.emit('agent/disposed',{agent:f.agent})
      if(action==='other-signal')await f.ctx.waterfall('agent/pre-step',{...payload,messages:[],step:2,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages:[]}))
      expect(renderPrompt(await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent,signal}))).toBe('')
    }finally{await prompt.dispose()}
  })

  it('isolates queued commands and clears pending context when the owning plugin unloads',async()=>{
    const f=setup(),prompt=f.ctx.plugin(SystemPrompt,{includeHarnessIdentity:false});await prompt
    let command:ReturnType<typeof createWorkflowPlanningCommand>
    const fiber=f.ctx.plugin((scope:Context)=>{command=createWorkflowPlanningCommand({...f.options,brief:invocation=>'Host '+invocation.commandId},scope)});await fiber
    const signal=new AbortController().signal
    const step=async(message:any,turn:number)=>f.ctx.waterfall('agent/pre-step',{agent:f.agent,messages:[message],turn,step:1,signal},async()=>({kind:'enter' as const,messages:[message]}))
    const assemble=async()=>renderPrompt(await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent,signal}))
    try{
      await command!.handler({...f.invocation,commandId:'one'})
      await command!.handler({...f.invocation,commandId:'two'})
      await step(f.followup.mock.calls[0]![0],1)
      expect(await assemble()).toBe('Host one')
      await step(f.followup.mock.calls[1]![0],2)
      expect(await assemble()).toBe('Host two')
      await command!.handler({...f.invocation,commandId:'three'})
      await fiber.dispose()
      expect(await assemble()).toBe('')
      await step(f.followup.mock.calls[2]![0],3)
      expect(await assemble()).toBe('')
    }finally{await fiber.dispose();await prompt.dispose()}
  })

  it('uses followup for a busy Agent and returns without waiting for model work', async () => {
    const f = setup(), wait = vi.fn(() => new Promise(() => {}))
    Object.assign(f.agent, { status: 'running', whenIdle: wait })
    expect(await f.command().handler(f.invocation)).toEqual({ kind: 'success' })
    expect(f.followup).toHaveBeenCalledTimes(1); expect(wait).not.toHaveBeenCalled()
  })

  it('does not tie the admitted followup to the completed command signal', async () => {
    const f = setup()
    await f.command().handler(f.invocation)
    f.controller.abort(new Error('command RPC closed'))
    expect(f.followup.mock.calls[0]).toHaveLength(1)
    expect(f.followup.mock.calls[0]![0]).not.toHaveProperty('signal')
  })

  it('rejects a child, stale root or invalid workspace before enqueuing a turn', async () => {
    const f = setup(); f.options.authorize = () => { throw new Error('工作流规划须从当前主对话发起') }
    await expect(f.command().handler(f.invocation)).rejects.toThrow(/主对话/)
    expect(f.followup).not.toHaveBeenCalled()
  })

  it('refuses unhandled attachments instead of silently dropping them', async () => {
    const f = setup()
    await expect(f.command().handler({ ...f.invocation, attachments: [{}] })).rejects.toThrow(/暂只接收文字/)
    expect(f.followup).not.toHaveBeenCalled()
  })

  it('rejects invalid or oversized text before waking the Agent', async () => {
    const f = setup()
    await expect(f.command().handler({ ...f.invocation, rawInput: 'x'.repeat(100_001) })).rejects.toThrow(/过长/)
    await expect(f.command().handler({ ...f.invocation, rawInput: undefined as unknown as string })).rejects.toThrow(/无效/)
    expect(f.followup).not.toHaveBeenCalled()
  })

  it('honors cancellation both before authorization and immediately before handoff', async () => {
    const f = setup(); f.controller.abort(new Error('cancelled'))
    await expect(f.command().handler(f.invocation)).rejects.toThrow('cancelled')
    expect(f.options.authorize).not.toHaveBeenCalled(); expect(f.followup).not.toHaveBeenCalled()
    const g = setup(); g.options.authorize = () => g.controller.abort(new Error('cancelled during authorization'))
    await expect(g.command().handler(g.invocation)).rejects.toThrow('cancelled during authorization')
    expect(g.followup).not.toHaveBeenCalled()
  })
})


// 真实 SystemPrompt + assembleContextFor，驱动只替代未安装的 agent-loop。
// SDK 0.2.1-rc.1：dsh-session/lib/types/types.d.ts:257–280（先 turn/start），
// dsh-agent/lib/types/runtime-types.d.ts:293–310（messages/turn/signal），
// dsh-plan-mode/lib/index.js:17–20（先 assembly 再 pre-step；重试复用快照）。
async function briefDriver(){
  const f=setup(),prompt=f.ctx.plugin(SystemPrompt,{includeHarnessIdentity:false});await prompt
  const inbox={nextTurn:[] as any[],nextStep:[] as any[]}
  Object.assign(f.agent,{status:'idle',inbox,session:{id:'main'}})
  f.followup.mockImplementation(message=>{inbox.nextTurn.push(message);Object.assign(f.agent,{status:'running'})})
  const brief='{"routeRule":"冻结简报 {{literal}}"}'
  f.options.brief=vi.fn(()=>brief)
  const command=createWorkflowPlanningCommand(f.options)
  const start=(turn:number)=>{
    const controller=new AbortController()
    f.ctx.emit('session/event',f.agent.session,{type:'turn/start',data:{turn}} as any)
    const messages=inbox.nextTurn.splice(0,1)
    return {controller,payload:{agent:f.agent,turn,step:1,signal:controller.signal,messages}}
  }
  const assemble=(signal:AbortSignal)=>f.ctx.systemPrompt.assemble(assembleContextFor(f.agent,signal)).then(renderPrompt)
  const admit=(payload:ReturnType<typeof start>['payload'],next=async()=>({kind:'enter' as const,messages:payload.messages}))=>f.ctx.waterfall('agent/pre-step',payload,next)
  const end=(turn:number)=>f.ctx.emit('session/event',f.agent.session,{type:'turn/end',data:{turn,reason:{kind:'completed'}}} as any)
  return {...f,prompt,inbox,brief,command,start,assemble,admit,end}
}

describe('T23.20 SDK 顺序简报隔离',()=>{
  it('首步/后续步文本冻结，RPC 结束不取消；回合结束后新 signal 不继承',async()=>{
    const d=await briefDriver()
    try{
      await d.command.handler(d.invocation)
      d.controller.abort()
      const {payload}=d.start(1)
      expect(renderPrompt(await d.ctx.systemPrompt.assemble({signal:payload.signal}))).toBe('')
      expect(renderPrompt(await d.ctx.systemPrompt.assemble({agent:d.agent,scope:{},signal:payload.signal}))).toBe('')
      expect(await d.assemble(payload.signal)).toBe(d.brief)
      await d.admit(payload)
      // 重试使用已组装快照，不再 pre-step；下个新步骤才重新组装。
      d.options.brief=()=>'{"routeRule":"已改变目录"}'
      expect(await d.assemble(payload.signal)).toBe(d.brief)
      await d.admit({...payload,step:2,messages:[]})
      expect(await d.assemble(new AbortController().signal)).toBe('')
      d.end(1)
      expect(await d.assemble(payload.signal)).toBe('')
      const next=d.start(2)
      expect(await d.assemble(next.payload.signal)).toBe('')
    }finally{await d.prompt.dispose()}
  })

  it('忙碌回合后续步无排队简报；排队命令获准后才激活，另一排队命令不继承',async()=>{
    const d=await briefDriver()
    try{
      d.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'旧需求'}]}))
      const old=d.start(1)
      expect(await d.assemble(old.payload.signal)).toBe('')
      await d.admit(old.payload)
      await d.command.handler(d.invocation)
      expect(await d.assemble(old.payload.signal)).toBe('')
      await d.admit({...old.payload,step:2,messages:[]})
      d.end(1)
      const queued=d.start(2)
      expect(await d.assemble(queued.payload.signal)).toBe('') // 明确保留的保守限制
      await d.admit(queued.payload)
      expect(await d.assemble(queued.payload.signal)).toBe(d.brief)
      await d.admit({...queued.payload,step:2,messages:[]})
      d.end(2)
      expect(await d.assemble(d.start(3).payload.signal)).toBe('')
    }finally{await d.prompt.dispose()}
  })

  it('连续两个命令使用独立 signal，第二条不会预挂到第一条',async()=>{
    const d=await briefDriver()
    try{
      d.options.brief=invocation=>'Host '+invocation.commandId
      await d.command.handler({...d.invocation,commandId:'one'})
      await d.command.handler({...d.invocation,commandId:'two'})
      const one=d.start(1)
      expect(await d.assemble(one.payload.signal)).toBe('Host one')
      await d.admit(one.payload)
      expect(await d.assemble(one.payload.signal)).toBe('Host one')
      d.end(1)
      const two=d.start(2)
      expect(await d.assemble(two.payload.signal)).toBe('')
      await d.admit(two.payload)
      expect(await d.assemble(two.payload.signal)).toBe('Host two')
      expect(await d.assemble(one.payload.signal)).toBe('')
    }finally{await d.prompt.dispose()}
  })

  it.each(['reject','discard','replace','abort','stop','end','dispose','throw'] as const)('首次组装后 %s 清除简报，已丢弃/替换的快照不得受理',async action=>{
    const d=await briefDriver()
    try{
      await d.command.handler(d.invocation)
      const {payload,controller}=d.start(1)
      expect(await d.assemble(payload.signal)).toBe(d.brief)
      if(action==='discard'){
        d.ctx.emit('agent/inbox/discarded',{agent:d.agent,message:payload.messages[0]})
        expect((await d.admit({...payload,messages:[]})).kind).toBe('reject')
      }else if(action==='replace'){
        expect((await d.admit(payload,async()=>({kind:'enter',messages:[]}))).kind).toBe('reject')
      }else if(action==='reject'){
        const decision=await d.ctx.waterfall('agent/pre-step',payload,async()=>({kind:'reject' as const}))
        expect(decision.kind).toBe('reject')
      }else if(action==='abort')controller.abort()
      else if(action==='throw')await expect(d.admit(payload,async()=>{throw Error('拒绝受理')})).rejects.toThrow('拒绝受理')
      else if(action==='stop')await d.ctx.serial('agent/turn-stopping',{agent:d.agent,turn:1,signal:payload.signal})
      else if(action==='end')d.end(1)
      else d.ctx.emit('agent/disposed',{agent:d.agent})
      expect(await d.assemble(payload.signal)).toBe('')
      expect(await d.assemble(d.start(2).payload.signal)).toBe('')
    }finally{await d.prompt.dispose()}
  })

  it.each(['discard','abort'] as const)('首次组装之前 %s 不产生简报',async action=>{
    const d=await briefDriver()
    try{
      await d.command.handler(d.invocation)
      const {payload,controller}=d.start(1)
      if(action==='discard')d.ctx.emit('agent/inbox/discarded',{agent:d.agent,message:payload.messages[0]})
      else controller.abort()
      expect(await d.assemble(payload.signal)).toBe('')
      await d.admit(payload)
      d.end(1)
      expect(await d.assemble(d.start(2).payload.signal)).toBe('')
    }finally{await d.prompt.dispose()}
  })

  it('公开状态 idle 但已有 parked inbox 时不预挂',async()=>{
    const d=await briefDriver()
    try{
      d.inbox.nextTurn.push(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'parked'}]}))
      await d.command.handler(d.invocation)
      const old=d.start(1)
      expect(await d.assemble(old.payload.signal)).toBe('')
      await d.admit(old.payload)
      d.end(1)
      const own=d.start(2)
      expect(await d.assemble(own.payload.signal)).toBe('')
      await d.admit(own.payload)
      expect(await d.assemble(own.payload.signal)).toBe(d.brief)
    }finally{await d.prompt.dispose()}
  })
  it('组装后插件卸载清除 section，并拒绝尚未受理的旧快照',async()=>{
    const d=await briefDriver()
    let command:ReturnType<typeof createWorkflowPlanningCommand>
    const fiber=d.ctx.plugin((scope:Context)=>{command=createWorkflowPlanningCommand(d.options,scope)});await fiber
    try{
      await command!.handler(d.invocation)
      const {payload}=d.start(1)
      expect(await d.assemble(payload.signal)).toBe(d.brief)
      await fiber.dispose()
      expect(await d.assemble(payload.signal)).toBe('')
      expect((await d.admit(payload)).kind).toBe('reject')
      expect(await d.assemble(d.start(2).payload.signal)).toBe('')
    }finally{await fiber.dispose();await d.prompt.dispose()}
  })
})

describe('T23 early command handoff',()=>{
  it('accepts before waking the main agent and preserves the raw requirement as data',async()=>{
    const f=setup(),intake=vi.fn(async()=>({taskId:'task-23'}))
    f.options.intake=intake
    expect(await f.command().handler(f.invocation)).toEqual({kind:'success'})
    expect(intake).toHaveBeenCalledExactlyOnceWith(f.invocation)
    const message=f.followup.mock.calls[0]![0]
    expect(message.source.kind).toBe('visible-workflow-command')
    expect(JSON.parse(message.content[0].text).requirement).toBe(f.invocation.rawInput)
    expect(message.content[1].text).toContain('task-23')
    expect(message.content[1].text).toContain('visible_workflow_plan_wait')
    f.controller.abort()
    expect(f.followup).toHaveBeenCalledTimes(1)
  })
  it('does not start intake for a bare command',async()=>{
    const f=setup();f.invocation.rawInput='  ';f.options.intake=vi.fn()
    await f.command().handler(f.invocation)
    expect(f.options.intake).not.toHaveBeenCalled()
    expect(f.followup.mock.calls[0]![0].source).toEqual({kind:'user'})
  })
})
