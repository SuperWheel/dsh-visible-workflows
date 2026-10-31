import { describe, expect, it, vi } from 'vitest'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createNativeAgentExecutor, NativeRepairExhaustedError, nativeOutputSchema, type NativeSubagentRun, type NativeSubagentService } from '../src/host/native-agent.ts'
import { reportedTokenUsage, sessionTokenUsage } from '../src/host/token-usage.ts'
import type { AdapterRequest } from '../src/host/runtime.ts'
import type { ToolCatalog } from '../src/host/tool-catalog.ts'
import { renderToolsSdk, type ToolDefinition, type ToolExecution, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'

const request = (overrides: Partial<AdapterRequest> = {}): AdapterRequest => ({
  node: { id: 'node', number: 'a-2', title: '分析', kind: 'agent', x: 0, y: 0, fixed: false, config: { model: { provider: 'test', model: 'fake' }, tools: ['native:read_file'], maxSteps: 2 } },
  repairMode:'auto',inputs: { prompt: '完成指定分析' }, workspaceId: 'w', runId: 'run', executionId: 'loop/2/node', signal: new AbortController().signal,
  backend: { generate: vi.fn(async () => { throw new Error('must not use a model loop') }) }, ...overrides,
})
type StartRequest = Parameters<NativeSubagentService['start']>[1]
function fixture(options: { noParent?: boolean; consumeSteering?: boolean; presentation?: 'native'|'ptc'; ownPresentation?: 'native'|'ptc'; catalog?: ToolCatalog; run?: (start: StartRequest, child: Agent, emit: (type: string, data: unknown) => void, step: () => Promise<boolean>) => Promise<Awaited<NativeSubagentRun['result']>> } = {}) {
  const listeners = new Map<string, Set<(...args: any[]) => any>>()
  const ctx = { on(name: string, fn: (...args: any[]) => any, options?:{prepend?:boolean}) { const previous = listeners.get(name) ?? new Set(); const group = options?.prepend ? new Set([fn, ...previous]) : previous; group.add(fn); listeners.set(name, group); return () => group.delete(fn) } } as unknown as Pick<Context, 'on'>
  const parent = { id: 'parent', session: { header: { delegationDepth: 0 } } } as unknown as Agent
  const disposeParent = vi.fn(async () => {}), disposeChild = vi.fn(async () => {})
  const createParent = vi.fn(async () => ({ agent: parent, dispose: disposeParent }) as AgentHandle)
  const starts: StartRequest[] = []
  const children=new Map<string,Agent>(), bridgeTools=new Map<string,ToolDefinition[]>(),roleSections:unknown[]=[], steered:unknown[]=[]
  const headers=new Map<string,PromptAssembly[]>(),guards=new Map<string,((exec:ToolExecution)=>string|undefined)[]>()
  const service: NativeSubagentService = {
    getProvider: () => ({ inheritsParentContext: false, capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true } }),
    async start(_, start) {
      starts.push(start)
      const childId=`child-${starts.length}`, scopedTools:ToolDefinition[]=[]
      let presentation=options.presentation??'native'
      const childGuards:((exec:ToolExecution)=>string|undefined)[]=[], definitions=new Map<string,ToolDefinition>()
      // Real SDK filters inherited tools, then its agent/created hook adds an
      // own-scope subagent tool. That tool survives restrict({allow:[]}).
      for(const name of [...start.toolFilter.allow,'structured_output','subagent'])definitions.set(name,{name,description:name,parameters:name==='structured_output'?start.outputSchema:{type:'object'},output:{schema:{type:'object'},render:()=>[]},execute:async()=>({})})
      const child = { id: childId, session: { id: childId, header: { parentSession: parent.id } }, cancel: vi.fn(),ctx:{
        get:(name:string)=>name==='ptcRuntime'?{language:'typescript'}:undefined,
        tools:{register:(tool:ToolDefinition)=>{scopedTools.push(tool);definitions.set(tool.name,tool);return ()=>{}},guard:(fn:(exec:ToolExecution)=>string|undefined)=>{childGuards.push(fn);return()=>{}},get:(name:string)=>definitions.get(name),presentAs:(mode:typeof presentation)=>{if(options.ownPresentation)throw new Error('tools.presentAs conflicts with an existing own-scope mode');presentation=mode;return()=>{}}},
        systemPrompt:{section:(section:unknown)=>{roleSections.push(section);return ()=>{}}}
      } } as unknown as Agent
      children.set(childId,child);bridgeTools.set(childId,scopedTools);guards.set(childId,childGuards);headers.set(childId,[])
      for(const listener of listeners.get('agent/created')??[])await listener({agent:child,source:'startup'})
      let seq = 0
      const emit = (type: string, data: unknown) => { for (const fn of listeners.get('session/event') ?? []) fn(child.session, { type, data, seq: seq++ }) }
      Object.assign(child,{steer:(message:unknown)=>{steered.push(message);if(options.consumeSteering!==false)emit('user/message',message)}})
      let descriptor=false
      const step = async () => {
        const all=[...definitions.values()],assembly:PromptAssembly={sections:[{name:'tool:subagent',text:'Start independent subagent delegations together.'},...(presentation==='ptc'?[{name:'tools:sdk',text:renderToolsSdk(all.map(d=>({...d,output:d.output.schema})))}]:[])],contexts:[],variables:{},tools:presentation==='ptc'?[{name:'run_code',description:'PTC transport',parameters:{type:'object'}}]:all}
        const assemblyListeners=[...listeners.get('system-prompt/assemble')??[]]
        const assemble=(i:number):Promise<PromptAssembly>=>i<assemblyListeners.length?assemblyListeners[i]!(assembly,{agent:child,scope:child},()=>assemble(i+1)):Promise.resolve(assembly)
        headers.get(childId)!.push(await assemble(0))
        // Installed loop assembles BEFORE pre-step's descriptor append.
        if(!descriptor){descriptor=true;emit('subagent/descriptor',{label:start.label})}

        for (const fn of listeners.get('agent/pre-step') ?? []) { const result = await fn({ agent: child, signal: start.signal }, async () => ({ kind: 'enter', messages: [] })); if (result.kind === 'reject') return false }
        emit('step/start', {})
        return true
      }
      // First step starts before start() returns, matching the in-process provider.
      const result = (async () => {
        if (options.run) return options.run(start, child, emit, step)
        await step()
        emit('assistant/message', { usage: { inputTokens: 12, outputTokens: 8, cacheReadTokens: 10, totalTokens: 30 } })
        return { stopReason: 'completed', structured: { text: 'result' }, output: [] }
      })()
      return { id: child.id, localAgent: child, result, dispose: async () => { await result; await disposeChild() } }
    },
  }
  const executor = createNativeAgentExecutor({ ctx, subagents: () => service, parentForRun: () => options.noParent ? undefined : parent, createParent, nativeTools: () => ['read_file', 'write_file', 'subagent', 'cliworker_run'],catalog:options.catalog,childForId:id=>children.get(id) })
  const dispatchTool = async (exec: ToolExecution, result: ToolExecutionResult) => {
    const denial=(guards.get(exec.agent?.id??'')??[]).map(guard=>guard(exec)).find(reason=>reason!==undefined)
    if(denial)return {isError:true,value:{error:denial},content:[{type:'text',text:denial}]} as ToolExecutionResult
    const middleware = [...listeners.get('tools/execute') ?? []]
    const invoke = (i: number): Promise<ToolExecutionResult> => i < middleware.length ? middleware[i]!(exec, () => invoke(i + 1)) : Promise.resolve(result)
    return invoke(0)
  }
  const finishTool = (exec: ToolExecution, result: ToolExecutionResult) => { for (const listener of listeners.get('tools/result') ?? []) listener(exec, result) }
  const toolExecution = (id: string, name: string, parent?: ToolExecution['token']) => ({ agent: children.get(id), name, token: Symbol(name), parent, arguments: {}, callId: 'call', rootCallId: 'call', signal: new AbortController().signal }) as ToolExecution
  return { executor, service, starts, createParent, disposeChild, disposeParent, listeners,bridgeTools,roleSections,steered,headers,dispatchTool,finishTool,toolExecution }
}

describe('native Harness Agent adapter (SDK-shaped fake host, no model calls)', () => {
  it('checks cumulative reported usage before each new step without injecting a default output cap',async()=>{
    const beforeModelStep=vi.fn(),onUsage=vi.fn()
    const f=fixture({run:async(start,_child,emit,step)=>{
      expect(start.agentOptions).not.toHaveProperty('maxTokens')
      expect(await step()).toBe(true);emit('assistant/message',{usage:{totalTokens:30}})
      expect(await step()).toBe(true);emit('assistant/message',{usage:{totalTokens:40}})
      return {stopReason:'completed',structured:{text:'done'},output:[]}
    }})
    await f.executor(request({beforeModelStep,onUsage}))
    expect(beforeModelStep.mock.calls).toEqual([[undefined,0],[{totalTokens:30},1]])
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({totalTokens:70})
  })
  it.each([0,1])('ignores an obsolete native tokenLimit=%s without injecting SDK output quotas',async tokenLimit=>{
    const f=fixture(),onUsage=vi.fn()
    await f.executor(request({onUsage,...{tokenLimit}} as any))
    expect(f.starts).toHaveLength(1);expect(f.starts[0]!.agentOptions).not.toHaveProperty('maxTokens')
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({inputTokens:12,outputTokens:8,totalTokens:30})
  })
  it('honors revoked Host authority before a second model step and retains reported usage',async()=>{
    let secondStarted=false
    const onUsage=vi.fn(),stop=new Error('Host permission revoked; actions must not replay')
    const f=fixture({run:async(_start,_child,emit,step)=>{
      await step();emit('assistant/message',{usage:{totalTokens:100}})
      await step();secondStarted=true
      return {stopReason:'completed',structured:{text:'must not complete'},output:[]}
    }})
    await expect(f.executor(request({onUsage,beforeModelStep:(_usage,completed)=>{if(completed)throw stop}}))).rejects.toBe(stop)
    expect(secondStarted).toBe(false);expect(f.starts).toHaveLength(1)
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({totalTokens:100})
    expect([...f.listeners.values()].every(group=>group.size===0)).toBe(true)
  })
  it('checks a durable failed attempt before a same-step SDK retry while preserving the host decision',async()=>{
    const beforeModelStep=vi.fn(),onUsage=vi.fn(),retry=vi.fn(async()=>({kind:'retry' as const}))
    const f=fixture({run:async(_start,child,emit,step)=>{
      await step()
      // Actual installed loop commits assistant/attempt before request-error;
      // retry is a continue within that request loop, with no second pre-step.
      emit('assistant/attempt',{stream:[{type:'chunk',chunk:{type:'usage',usage:{totalTokens:30}}}]})
      const listener=[...f.listeners.get('agent/request-error')!][0]!
      expect(await listener({agent:child},retry)).toEqual({kind:'retry'})
      emit('assistant/message',{usage:{totalTokens:40}})
      return {stopReason:'completed',structured:{text:'done'},output:[]}
    }})
    await f.executor(request({beforeModelStep,onUsage}))
    expect(retry).toHaveBeenCalledOnce()
    expect(beforeModelStep.mock.calls).toEqual([[undefined,0],[{totalTokens:30},1]])
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({totalTokens:70})
    expect(f.executor.inspect('child-1')?.steps).toBe(1)
    expect([...f.listeners.values()].every(group=>group.size===0)).toBe(true)
  })
  it.each([true,false])('honors a revoked same-step retry authority for known or unknown usage (known=%s)',async known=>{
    const stop=new Error('Host revoked retry authority'),onUsage=vi.fn()
    let retryStarted=false
    const f=fixture({run:async(_start,child,emit,step)=>{
      await step();emit('assistant/attempt',known?{usage:{totalTokens:100}}:{})
      const listener=[...f.listeners.get('agent/request-error')!][0]!
      await listener({agent:child},async()=>({kind:'retry'}));retryStarted=true
      return {stopReason:'completed',structured:{text:'must not complete'},output:[]}
    }})
    await expect(f.executor(request({onUsage,beforeModelStep:(usage,completed)=>{if(completed){expect(usage).toEqual(known?{totalTokens:100}:undefined);throw stop}}}))).rejects.toBe(stop)
    expect(retryStarted).toBe(false);expect(f.starts).toHaveLength(1)
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(known?{totalTokens:100}:undefined)
    expect([...f.listeners.values()].every(group=>group.size===0)).toBe(true)
  })
  it('keeps terminal provider errors and unrelated Agent retry policies outside the retry admission gate',async()=>{
    const beforeModelStep=vi.fn(),terminal=vi.fn(async()=>undefined),unrelatedRetry=vi.fn(async()=>({kind:'retry' as const}))
    const f=fixture({run:async(_start,child,emit,step)=>{
      await step();emit('assistant/attempt',{})
      const listener=[...f.listeners.get('agent/request-error')!][0]!
      expect(await listener({agent:child},terminal)).toBeUndefined()
      expect(await listener({agent:{id:'unrelated'}},unrelatedRetry)).toEqual({kind:'retry'})
      return {stopReason:'failed',diagnostic:'original provider failure',output:[]}
    }})
    await expect(f.executor(request({beforeModelStep}))).rejects.toThrow('original provider failure')
    expect(beforeModelStep.mock.calls).toEqual([[undefined,0]])
    expect(terminal).toHaveBeenCalledOnce();expect(unrelatedRetry).toHaveBeenCalledOnce()
  })
  it('cancels a published 0.2.1 activation through exact disposal even when its admission signal no longer controls execution',async()=>{
    const f=fixture(),legacyStart=f.service.start.bind(f.service),controller=new AbortController()
    let started!:()=>void,finish!:(value:Awaited<NativeSubagentRun['result']>)=>void
    const announced=new Promise<void>(resolve=>{started=resolve}),pending=new Promise<Awaited<NativeSubagentRun['result']>>(resolve=>{finish=resolve}),disposed=vi.fn()
    f.service.startActivation=async spec=>{
      const run=await legacyStart(spec.provider,{...spec.request,label:spec.label,signal:spec.signal,toolFilter:{allow:['read_file']},persona:''})
      return {childId:run.id,result:pending,dispose:async()=>{disposed();finish({stopReason:'cancelled',output:[]});await run.dispose()}}
    }
    f.service.getProvider=()=>({inheritsParentContext:false,capabilities:{agentOptions:true,outputSchema:true,depthLimit:true}})
    const execution=f.executor(request({signal:controller.signal,onTask:()=>started()}))
    const rejected=expect(execution).rejects.toThrow('用户取消')
    await announced;controller.abort(new Error('用户取消'));await rejected
    expect(disposed).toHaveBeenCalledOnce();expect(f.executor.inspect('child-1')?.status).toBe('cancelled')
    expect([...f.listeners.values()].every(group=>group.size===0)).toBe(true)
  })
  it('uses the 0.2.1 managed activation API without obsolete persona/toolFilter request capabilities', async () => {
    const f=fixture(),legacyStart=f.service.start.bind(f.service),activation=vi.fn(async(spec:Parameters<NonNullable<NativeSubagentService['startActivation']>>[0])=>{
      // The SDK owns creation and the activation result; our early listener owns
      // exact-child dispatch guards and filters every assembled tool request.
      expect(spec.delivery).toBe('caller');expect(spec.request).not.toHaveProperty('toolFilter');expect(spec.request).not.toHaveProperty('persona')
      const run=await legacyStart(spec.provider,{...spec.request,label:spec.label,signal:spec.signal,toolFilter:{allow:['read_file']},persona:''})
      return {childId:run.id,result:run.result,dispose:()=>run.dispose()}
    })
    f.service.startActivation=activation
    f.service.getProvider=()=>({inheritsParentContext:false,capabilities:{agentOptions:true,outputSchema:true,depthLimit:true}})
    f.service.start=vi.fn(async()=>{throw new Error('legacy API must not be called')})
    const req=request();req.node.config.subagentId='definition-1'
    const tasks:string[]=[]
    await f.executor({...req,onTask:id=>tasks.push(id)});await f.executor({...req,onTask:id=>tasks.push(id)})
    expect(activation).toHaveBeenCalledTimes(2);expect(tasks).toEqual(['child-1','child-2'])
    expect(JSON.parse((f.starts[0]!.prompt[0] as {text:string}).text).workflow.subagentDefinitionId).toBe('definition-1')
    expect(f.headers.get('child-1')![0]!.tools.map(tool=>tool.name)).toEqual(['read_file','structured_output'])
    expect(f.disposeChild).toHaveBeenCalledTimes(2)
  })
  it('creates one native task, scopes selected tools, preserves instance identity and settles measured usage', async () => {
    const f = fixture(), onTask = vi.fn(), onUsage = vi.fn(), req = request({ onTask, onUsage, rolePrompt: '原样保留 {{example}}' })
    expect(await f.executor(req)).toEqual({ text: 'result', json: { text: 'result' }, steps: 1 })
    expect(f.starts[0]).toMatchObject({ parent: { id: 'parent' }, maxDepth: 1, toolFilter: { allow: ['read_file'] }, agentOptions: { provider: 'test', model: 'fake' }, outputSchema: { required: ['text'] } })
    expect(JSON.parse((f.starts[0]!.prompt[0] as { text: string }).text)).toMatchObject({ role: '原样保留 {{example}}', workflow: { runId: 'run', nodeId: 'node', executionId: 'loop/2/node' } })
    expect(onTask).toHaveBeenCalledWith('child-1')
    expect(f.roleSections).toContainEqual({name:'visible-workflows:node-role',order:90,interpolate:false,text:'原样保留 {{example}}'})
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 12, outputTokens: 8, totalTokens: 30 })
    expect(req.backend.generate).not.toHaveBeenCalled()
    expect(f.disposeChild).toHaveBeenCalledOnce()
    expect(f.createParent).not.toHaveBeenCalled()
    expect([...f.listeners.values()].every(group => group.size === 0)).toBe(true)
  })
  it('owns a silent standalone parent and disposes it without requiring an existing chat', async () => {
    const f = fixture({ noParent: true })
    await f.executor(request())
    expect(f.createParent).toHaveBeenCalledOnce()
    expect(f.disposeParent).toHaveBeenCalledOnce()
  })
  it('fails loud when native spawn capability is unavailable, without local-model fallback', async () => {
    const f = fixture(); f.service.getProvider = () => undefined
    const req = request()
    await expect(f.executor(req)).rejects.toThrow('spawn 服务不可用')
    expect(f.starts).toHaveLength(0)
    expect(req.backend.generate).not.toHaveBeenCalled()
  })
  it('rejects providers that inherit chat content or cannot enforce a tool allowlist', async () => {
    const f = fixture()
    f.service.getProvider = () => ({ inheritsParentContext: true, capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: false, persona: true } })
    await expect(f.executor(request())).rejects.toThrow('不能保证独立上下文')
    expect(f.starts).toHaveLength(0)
  })
  it('refuses missing permissions and untracked delegation tools before calling the provider', async () => {
    const f = fixture()
    for (const tool of ['native:not_authorized', 'native:subagent', 'native:cliworker_run', 'workflow:nested', 'builtin:json.parse']) {
      const req = request(); req.node.config.tools = [tool]
      await expect(f.executor(req)).rejects.toThrow()
    }
    expect(f.starts).toHaveLength(0)
  })
  it('rejects the generic PTC executor before calling spawn instead of putting it in the SDK allowlist',async()=>{
    const f=fixture(),req=request();req.node.config.tools=['native:run_code']
    await expect(f.executor(req)).rejects.toThrow('可直接运行代码')
    expect(f.starts).toHaveLength(0)
  })
  it('enforces the step cap even when the child begins before start returns', async () => {
    const f = fixture({ run: async (_start, _child, emit, step) => {
      expect(await step()).toBe(true)
      emit('assistant/message', { usage: { totalTokens: 7 } })
      expect(await step()).toBe(true)
      emit('assistant/message', { usage: { totalTokens: 8 } })
      expect(await step()).toBe(false)
      return { stopReason: 'aborted', output: [] }
    } })
    const onUsage = vi.fn()
    await expect(f.executor(request({ onUsage }))).rejects.toThrow('达到 2 步上限')
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ totalTokens: 15 })
    expect(f.disposeChild).toHaveBeenCalledOnce()
  })
  it('reports missing usage as unknown and rejects partial/unvalidated output', async () => {
    const f = fixture({ run: async (_start, _child, emit, step) => { await step(); emit('assistant/message', {}); return { stopReason: 'completed', output: [{ type: 'text', text: 'not schema checked' }] } } })
    const onUsage = vi.fn()
    await expect(f.executor(request({ onUsage }))).rejects.toThrow('输出未满足')
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(f.disposeChild).toHaveBeenCalledOnce()
  })
  it('cancel propagates through native signal and still drains/disposes owned resources', async () => {
    const f = fixture({ noParent: true, run: async (start, _child, _emit, step) => {
      await step()
      await new Promise<void>(resolve => { start.signal.addEventListener('abort', () => resolve(), { once: true }); if (start.signal.aborted) resolve() })
      return { stopReason: 'aborted', output: [] }
    } })
    const controller = new AbortController(), onTask = vi.fn(() => controller.abort(new Error('cancel test'))), onUsage = vi.fn()
    await expect(f.executor(request({ signal: controller.signal, onTask, onUsage }))).rejects.toThrow('cancel test')
    expect(f.starts[0]!.signal.aborted).toBe(true)
    expect(f.disposeChild).toHaveBeenCalledOnce(); expect(f.disposeParent).toHaveBeenCalledOnce()
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(undefined)
  })
  it('honors the configured timeout, stops the native task and preserves already reported usage without retry',async()=>{
    const f=fixture({run:async(start,_child,emit,step)=>{
      await step();emit('assistant/message',{usage:{totalTokens:7}})
      await new Promise<void>(resolve=>{start.signal.addEventListener('abort',()=>resolve(),{once:true});if(start.signal.aborted)resolve()})
      return {stopReason:'aborted',output:[]}
    }}),onUsage=vi.fn(),repair=vi.fn(),req=request({onUsage,withRepairUsage:repair})
    req.node.config.timeoutMs=100
    await expect(f.executor(req)).rejects.toThrow('执行超时')
    expect(f.starts).toHaveLength(1);expect(f.starts[0]!.signal.aborted).toBe(true)
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({totalTokens:7});expect(repair).not.toHaveBeenCalled()
    expect(f.disposeChild).toHaveBeenCalledOnce();expect([...f.listeners.values()].every(group=>group.size===0)).toBe(true)
  })
  it('stops an exact live task by id, without retrying it or stopping an unrelated task',async()=>{
    const f=fixture({run:async(start,_child,_emit,step)=>{
      await step()
      await new Promise<void>(resolve=>{start.signal.addEventListener('abort',()=>resolve(),{once:true});if(start.signal.aborted)resolve()})
      return {stopReason:'aborted',output:[]}
    }})
    const repair=vi.fn(),onTask=(id:string)=>{expect(f.executor.stop('not-this-task')).toBe(false);expect(f.executor.stop(id)).toBe(true)}
    await expect(f.executor(request({onTask,withRepairUsage:repair}))).rejects.toThrow('子 Agent 已停止')
    expect(repair).not.toHaveBeenCalled();expect(f.executor.stop('child-1')).toBe(false)
  })
  it('cleans up the standalone parent and leaves unknown accounting if native startup rejects',async()=>{
    const f=fixture({noParent:true}),onUsage=vi.fn()
    f.service.start=async()=>{throw new Error('provider start failed')}
    await expect(f.executor(request({onUsage}))).rejects.toThrow('provider start failed')
    expect(f.disposeParent).toHaveBeenCalledOnce();expect(onUsage).toHaveBeenCalledExactlyOnceWith(undefined)
    expect([...f.listeners.values()].every(group=>group.size===0)).toBe(true)
  })
  it('validates custom structured output and rejects invalid/duplicate schema names', async () => {
    const f = fixture({ run: async (_start, _child, emit, step) => { await step(); emit('assistant/message', { usage: { totalTokens: 5 } }); return { stopReason: 'completed', structured: { score: 4 }, output: [] } } })
    const req = request(); req.node.config.outputSchema = [{ name: 'score', type: 'number', required: true }]
    expect(await f.executor(req)).toMatchObject({ score: 4, json: { score: 4 } })
    expect(() => nativeOutputSchema([{ name: '__proto__', type: 'string' }])).toThrow('字段名')
    expect(() => nativeOutputSchema([{ name: 'score', type: 'number' }, { name: 'score', type: 'string' }])).toThrow('重复')
    expect(nativeOutputSchema([{name:'score',type:'number'},{name:'optional',type:'string',required:false}]).required).toEqual(['score'])
  })
  it('does not mix concurrent execution identities or usage on the same parent', async () => {
    const f = fixture(), first = vi.fn(), second = vi.fn()
    const values = await Promise.all([f.executor(request({ executionId: 'first', onUsage: first })), f.executor(request({ executionId: 'second', onUsage: second }))])
    expect(values.map(value => value.steps)).toEqual([1, 1])
    expect(f.starts[0]!.label).not.toBe(f.starts[1]!.label)
    expect(first).toHaveBeenCalledExactlyOnceWith({ inputTokens: 12, outputTokens: 8, totalTokens: 30 })
    expect(second).toHaveBeenCalledExactlyOnceWith({ inputTokens: 12, outputTokens: 8, totalTokens: 30 })
  })
  it('bridges selected builtin/API tools only in the exact child scope, with original schema and cancellation',async()=>{
    const calls:unknown[]=[]
    const catalog={assertConstraints:()=>{},list:()=>[{id:'builtin:json.parse',name:'JSON',description:'Parse',available:true,inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}],execute:async(id:string,args:unknown,req:AdapterRequest)=>{calls.push({id,args,runId:req.runId,signal:req.signal});return {value:{ok:true}}}} as unknown as ToolCatalog
    const f=fixture({catalog,run:async(start,child,emit,step)=>{
      await step()
      const [tool]=f.bridgeTools.get(child.id)!
      expect(tool?.parameters).toMatchObject({required:['text']})
      await expect(tool!.execute({text:'{}'},{agent:{id:'other'},signal:start.signal} as any)).rejects.toThrow('不属于')
      await expect(tool!.execute({text:4},{agent:child,signal:start.signal} as any)).rejects.toThrow('参数无效')
      expect(await tool!.execute({text:'{}'},{agent:child,signal:start.signal} as any)).toEqual({value:{ok:true}})
      emit('assistant/message',{usage:{totalTokens:8}})
      return {stopReason:'completed',structured:{text:'bridged'},output:[]}
    }})
    const req=request();req.node.config.tools=['builtin:json.parse']
    expect(await f.executor(req)).toMatchObject({text:'bridged'})
    expect(f.starts[0]?.toolFilter.allow).toEqual([])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({id:'builtin:json.parse',args:{text:'{}'},runId:'run'})
  })
  it('binds bridges before the first assembly and isolates concurrent children despite own-scope delegation registration',async()=>{
    const catalog={assertConstraints:()=>{},list:()=>[{id:'builtin:time.now',name:'Time',description:'Current time',available:true,inputSchema:{type:'object'}}],execute:async()=>({iso:'2026-10-17T00:00:00.000Z'})} as unknown as ToolCatalog
    const f=fixture({catalog}),a=request({executionId:'A'}),b=request({executionId:'B'})
    a.node.config.tools=['builtin:time.now'];b.node.config.tools=[]
    await Promise.all([f.executor(a),f.executor(b)])
    const first=f.headers.get('child-1')![0]!,second=f.headers.get('child-2')![0]!
    expect(first.tools.map(tool=>tool.name)).toEqual(['structured_output','workflow_bound_tool_1'])
    expect(first.tools.find(tool=>tool.name==='workflow_bound_tool_1')?.description).toContain('builtin:time.now')
    expect(second.tools.map(tool=>tool.name)).toEqual(['structured_output'])
    expect([...first.sections,...second.sections].some(section=>section.name==='tool:subagent')).toBe(false)
    expect(f.bridgeTools.get('child-1')).toHaveLength(1);expect(f.bridgeTools.get('child-2')).toHaveLength(0)
  })
  it('overrides only a child of a PTC parent to native tools and blocks generic execution plus unselected tools',async()=>{
    const f=fixture({presentation:'ptc',run:async(_start,child,emit,step)=>{
      await step()
      const header=f.headers.get(child.id)![0]!
      expect(header.tools.map(tool=>tool.name)).toEqual(['read_file','structured_output'])
      expect(header.sections.some(section=>['tools:sdk','tools:ptc-only','tool:subagent'].includes(section.name))).toBe(false)
      const result={isError:false,value:{ok:true},content:[]} as ToolExecutionResult
      expect((await f.dispatchTool(f.toolExecution(child.id,'subagent'),result)).isError).toBe(true)
      expect((await f.dispatchTool(f.toolExecution(child.id,'subagent',Symbol('ptc')),result)).isError).toBe(true)
      expect((await f.dispatchTool(f.toolExecution(child.id,'write_file',Symbol('ptc')),result)).isError).toBe(true)
      expect((await f.dispatchTool(f.toolExecution(child.id,'run_code'),result)).isError).toBe(true)
      expect(await f.dispatchTool(f.toolExecution(child.id,'read_file',Symbol('ptc')),result)).toBe(result)
      emit('assistant/message',{usage:{totalTokens:5}})
      return {stopReason:'completed',structured:{text:'PTC guarded'},output:[]}
    }})
    await expect(f.executor(request())).resolves.toMatchObject({text:'PTC guarded'})
  })
  it('keeps empty-tool output repair native and rejects run_code even when its parent uses PTC',async()=>{
    let count=0
    const f=fixture({presentation:'ptc',run:async(_start,child,emit,step)=>{
      await step();const call=++count,header=f.headers.get(child.id)![0]!
      expect(header.tools.map(tool=>tool.name)).toEqual(call===1?['read_file','structured_output']:['structured_output'])
      expect(header.sections.some(section=>section.name==='tools:sdk'||section.name==='tools:ptc-only')).toBe(false)
      const result={isError:false,value:{},content:[]} as ToolExecutionResult
      expect((await f.dispatchTool(f.toolExecution(child.id,'run_code'),result)).isError).toBe(true)
      if(call===2)expect((await f.dispatchTool(f.toolExecution(child.id,'read_file'),result)).isError).toBe(true)
      emit('assistant/message',{usage:{totalTokens:5}})
      return {stopReason:'completed',structured:{text:call===1?'x':'repaired output'},output:[]}
    }})
    const req=request({withRepairUsage:invoke=>invoke(()=>{},100),repairLimit:1});req.node.config.verification={minTextLength:5}
    expect(await f.executor(req)).toMatchObject({text:'repaired output',repair_attempts:1})
    expect(f.starts).toHaveLength(2);expect(f.starts[1]!.toolFilter.allow).toEqual([])
  })
  it('fails before any request if a child already declares a conflicting own-scope presentation',async()=>{
    const f=fixture({presentation:'ptc',ownPresentation:'ptc'})
    await expect(f.executor(request())).rejects.toThrow('presentAs conflicts')
    expect(f.headers.get('child-1')).toEqual([]);expect(f.starts).toHaveLength(1)
  })
  it('repairs only completed invalid output with a fresh empty-tool task and separately admitted usage',async()=>{
    let calls=0
    const f=fixture({run:async(_start,_child,emit,step)=>{await step();emit('assistant/message',{usage:{totalTokens:++calls===1?10:6}});return {stopReason:'completed',structured:{text:calls===1?'x':'correct result'},output:[]}}})
    const originalUsage=vi.fn(),repairUsage=vi.fn(),onTask=vi.fn(),originalAdmission=vi.fn(),repairAdmission=vi.fn()
    const withRepairUsage:NonNullable<AdapterRequest['withRepairUsage']>=async invoke=>{
      expect(f.disposeChild).toHaveBeenCalledTimes(1)
      expect(originalUsage).toHaveBeenCalledExactlyOnceWith({totalTokens:10})
      return invoke(repairUsage,500,repairAdmission)
    }
    const req=request({onUsage:originalUsage,onTask,withRepairUsage,repairLimit:2,beforeModelStep:originalAdmission});req.node.config.verification={minTextLength:5,requiredFiles:['already-created.md']}
    expect(await f.executor(req)).toMatchObject({text:'correct result',repair_attempts:1,steps:2})
    expect(f.starts[1]).toMatchObject({toolFilter:{allow:[]}})
    expect(f.starts[1]!.agentOptions).not.toHaveProperty('maxTokens')
    expect(f.starts[1]!.label).toContain('/repair/1')
    expect(onTask.mock.calls.map(args=>args[0])).toEqual(['child-1','child-2'])
    expect(originalUsage).toHaveBeenCalledOnce()
    expect(repairUsage).toHaveBeenCalledExactlyOnceWith({totalTokens:6})
    expect(originalAdmission).toHaveBeenCalledExactlyOnceWith(undefined,0)
    expect(repairAdmission).toHaveBeenCalledExactlyOnceWith(undefined,0)
  })
  it('limits output repair attempts and never retries a failed or incomplete action task',async()=>{
    const f=fixture({run:async(_start,_child,emit,step)=>{await step();emit('assistant/message',{usage:{totalTokens:3}});return {stopReason:'completed',structured:{text:'x'},output:[]}}})
    const usage=vi.fn(async(invoke:any)=>invoke(vi.fn(),200))
    const req=request({withRepairUsage:usage,repairLimit:20});req.node.config.verification={minTextLength:5}
    await expect(f.executor(req)).rejects.toThrow('修复达到 2 次上限')
    expect(usage).toHaveBeenCalledTimes(2);expect(f.starts).toHaveLength(3)
    const failed=fixture({run:async()=>({stopReason:'error',output:[]})})
    const noRepair=vi.fn()
    await expect(failed.executor(request({withRepairUsage:noRepair}))).rejects.toThrow('未完成')
    expect(noRepair).not.toHaveBeenCalled()
  })
  it('inspects only owned tasks, delivers admitted steering to the same task and audits consumption without duplicate usage',async()=>{
    let finish!:()=>void
    const gate=new Promise<void>(resolve=>{finish=resolve}),usage=vi.fn(),events=vi.fn()
    const f=fixture({run:async(_start,_child,emit,step)=>{await step();await gate;emit('assistant/message',{usage:{totalTokens:19}});return {stopReason:'completed',structured:{text:'done'},output:[]}}})
    const task=vi.fn((id:string)=>{
      expect(f.executor.inspect('foreign')).toBeUndefined()
      expect(f.executor.inspect(id)).toMatchObject({taskId:id,runId:'run',executionId:'loop/2/node',status:'running',canSteer:true})
      expect(()=>f.executor.steer(id,{id:'message_1',text:'补充限定'},undefined as any)).toThrow('投递身份')
      expect(()=>f.executor.steer('foreign',{id:'message_1',text:'补充限定'},{allocationId:'a1'})).toThrow('不属于')
      const receipt=f.executor.steer(id,{id:'message_1',text:'补充限定'},{allocationId:'a1'})
      expect(receipt).toMatchObject({taskId:id,messageId:'message_1',allocationId:'a1',status:'consumed'})
      expect(typeof receipt.nativeMessageId).toBe('string')
      expect(f.executor.steer(id,{id:'message_1',text:'补充限定'},{allocationId:'a1'})).toEqual(receipt)
      expect(()=>f.executor.steer(id,{id:'message_1',text:'changed'},{allocationId:'a1'})).toThrow('不同内容')
      expect(()=>f.executor.steer(id,{id:'message_2',text:'another'},{allocationId:'a1'})).toThrow('另一条')
      expect(f.steered).toHaveLength(1)
      expect(f.steered[0]).toMatchObject({role:'user',source:{kind:'user'},content:[{type:'text',text:'补充限定'}]})
      const copy=f.executor.inspect(id)!;copy.events.length=0;expect(f.executor.inspect(id)!.events.length).toBeGreaterThan(0)
      finish()
    })
    await f.executor(request({onTask:task,onUsage:usage,onTaskEvent:events}))
    expect(usage).toHaveBeenCalledExactlyOnceWith({totalTokens:19})
    expect(f.starts).toHaveLength(1)
    expect(events).toHaveBeenCalled()
    expect(f.executor.inspect('child-1')).toMatchObject({status:'completed',canSteer:false,usage:{totalTokens:19}})
    expect(()=>f.executor.steer('child-1',{id:'message_2',text:'too late'},{allocationId:'a2'})).toThrow('已结束')
  })
  it('bounds and redacts process projections without mistaking a requested tool call for committed capture',async()=>{
    let release!:()=>void,emitLater!:(type:string,data:unknown)=>void
    const gate=new Promise<void>(resolve=>{release=resolve})
    const f=fixture({run:async(_start,_child,emit,step)=>{emitLater=emit;await step();await gate;return {stopReason:'completed',structured:{text:'done'},output:[]}}})
    await f.executor(request({onTask:id=>{
      for(let i=0;i<120;i++)emitLater('tool/call',{name:'read_file',arguments:'secret raw args'})
      emitLater('assistant/message',{message:{content:[{type:'reasoning',text:'hidden internal reasoning'},{type:'text',text:'API_KEY=super-secret-value Bearer abcd1234 public result'}]},usage:{totalTokens:1}})
      emitLater('tool/result',{message:{content:[{type:'text',text:'secret raw tool output'}]}})
      emitLater('tool/call',{name:'structured_output',arguments:'secret structured args'})
      const snapshot=f.executor.inspect(id)!,serialized=JSON.stringify(snapshot)
      expect(snapshot.events.length).toBe(100);expect(snapshot.droppedEvents).toBeGreaterThan(0)
      for(const event of snapshot.events)expect(event.summary.length).toBeLessThanOrEqual(2000)
      expect(serialized).toContain('public result');expect(serialized).toContain('已隐藏')
      for(const hidden of ['super-secret-value','abcd1234','hidden internal reasoning','secret raw args','secret raw tool output','secret structured args'])expect(serialized).not.toContain(hidden)
      expect(snapshot.canSteer).toBe(true)
      release()
    }}))
  })
  it('holds steering only during structured dispatch and permanently closes it after a successful authoritative result',async()=>{
    let release!:()=>void,started!:(id:string)=>void
    const gate=new Promise<void>(resolve=>{release=resolve}),ready=new Promise<string>(resolve=>{started=resolve})
    const f=fixture({run:async(_start,_child,_emit,step)=>{await step();await gate;return {stopReason:'completed',structured:{text:'done'},output:[]}}})
    const running=f.executor(request({onTask:started})),id=await ready
    const success={isError:false,value:{recorded:true},content:[]} as ToolExecutionResult
    const failure={isError:true,content:[{type:'text',text:'schema rejected'}]} as ToolExecutionResult
    try{
      const rejected=f.toolExecution(id,'structured_output')
      await f.dispatchTool(rejected,failure)
      expect(f.executor.inspect(id)?.canSteer).toBe(false)
      expect(()=>f.executor.steer(id,{id:'pending',text:'wait'},{allocationId:'p'})).toThrow('结构化结果')
      f.finishTool(rejected,failure)
      expect(f.executor.inspect(id)?.canSteer).toBe(true)
      expect(f.executor.steer(id,{id:'after_failure',text:'补充限定'},{allocationId:'a'}).status).toBe('consumed')
      const accepted=f.toolExecution(id,'structured_output')
      await f.dispatchTool(accepted,success)
      // A post-execution projection may change the value. The SDK commits the
      // staged body result if the final outcome succeeds, not its rendered value.
      f.finishTool(accepted,{isError:false,value:{redacted:true},content:[]} as ToolExecutionResult)
      expect(f.executor.inspect(id)?.canSteer).toBe(false)
      expect(()=>f.executor.steer(id,{id:'late',text:'no'},{allocationId:'b'})).toThrow('结构化结果')
    }finally{release();await running}
    expect([...f.listeners.values()].every(group=>group.size===0)).toBe(true)
  })
  it('waits for the matching PTC outer result, reopens after outer failure, and ignores unrelated task results',async()=>{
    let release!:()=>void,started!:(id:string)=>void
    const gate=new Promise<void>(resolve=>{release=resolve}),ready=new Promise<string>(resolve=>{started=resolve})
    const f=fixture({run:async(_start,_child,_emit,step)=>{await step();await gate;return {stopReason:'completed',structured:{text:'done'},output:[]}}})
    const running=f.executor(request({onTask:started})),id=await ready
    const success={isError:false,value:{recorded:true},content:[]} as ToolExecutionResult
    const failure={isError:true,content:[{type:'text',text:'outer denied'}]} as ToolExecutionResult
    try{
      const firstOuter=f.toolExecution(id,'run_code'),inner=f.toolExecution(id,'structured_output',firstOuter.token)
      await f.dispatchTool(inner,success);f.finishTool(inner,success)
      expect(f.executor.inspect(id)?.canSteer).toBe(false)
      f.finishTool(f.toolExecution(id,'run_code'),success)
      f.finishTool({...firstOuter,agent:{id:'unowned'} as Agent},success)
      expect(f.executor.inspect(id)?.canSteer).toBe(false)
      f.finishTool(firstOuter,failure)
      expect(f.executor.inspect(id)?.canSteer).toBe(true)
      const secondOuter=f.toolExecution(id,'run_code'),secondInner=f.toolExecution(id,'structured_output',secondOuter.token)
      await f.dispatchTool(secondInner,success);f.finishTool(secondInner,success)
      f.finishTool(secondOuter,success)
      expect(f.executor.inspect(id)?.canSteer).toBe(false)
    }finally{release();await running}
  })
  it('marks undelivered steering after cancellation and never reopens a stopped task',async()=>{
    const f=fixture({consumeSteering:false,run:async(start,_child,_emit,step)=>{await step();await new Promise<void>(resolve=>{start.signal.addEventListener('abort',()=>resolve(),{once:true});if(start.signal.aborted)resolve()});return {stopReason:'aborted',output:[]}}})
    await expect(f.executor(request({onTask:id=>{expect(f.executor.steer(id,{id:'queued',text:'未消费'},{allocationId:'q'})).toMatchObject({status:'queued'});expect(f.executor.stop(id)).toBe(true);expect(f.executor.inspect(id)?.canSteer).toBe(false);expect(()=>f.executor.steer(id,{id:'message',text:'no'},{allocationId:'a'})).toThrow('停止')}}))).rejects.toThrow('子 Agent 已停止')
    expect(f.executor.inspect('child-1')).toMatchObject({status:'cancelled',canSteer:false,messages:[{messageId:'queued',status:'not_consumed'}]})
  })
  it('exposes typed verification pauses for disabled repair, exhausted attempts and usage holds',async()=>{
    const invalid=()=>fixture({run:async(_start,_child,emit,step)=>{await step();emit('assistant/message',{usage:{totalTokens:3}});return {stopReason:'completed',structured:{text:'x'},output:[]}}})
    const req=request({repairLimit:0});req.node.config.verification={minTextLength:5}
    await expect(invalid().executor(req)).rejects.toMatchObject({name:'NativeRepairExhaustedError',reason:'disabled',attempts:[],candidate:{text:'x'},limit:0})
    const exhausted=invalid(),usage=vi.fn(async(invoke:any)=>invoke(vi.fn(),200))
    try {await exhausted.executor({...req,repairLimit:2,withRepairUsage:usage});expect.unreachable()}catch(error){
      expect(error).toBeInstanceOf(NativeRepairExhaustedError)
      expect(error).toMatchObject({reason:'limit',limit:2,candidate:{text:'x'},attempts:[{attempt:1,taskId:'child-2',candidate:{text:'x'}},{attempt:2,taskId:'child-3',candidate:{text:'x'}}]})
    }
    const blocked=invalid()
    await expect(blocked.executor({...req,repairLimit:2,withRepairUsage:async()=>{throw new Error('Host repair authority revoked')}})).rejects.toMatchObject({name:'NativeRepairExhaustedError',reason:'unavailable',attempts:[{attempt:1,error:'Host repair authority revoked',candidate:{text:'x'}}],candidate:{text:'x'},limit:2})
    expect(blocked.starts).toHaveLength(1)
  })
})

describe('provider usage accounting', () => {
  it('does not invent totals from incomplete or inconsistent token fields', () => {
    expect(reportedTokenUsage({ inputTokens: 2, outputTokens: 3 })).toBeUndefined()
    expect(reportedTokenUsage({ totalTokens: 5, inputTokens: 4, outputTokens: 4 })).toBeUndefined()
    expect(reportedTokenUsage({ totalTokens: -1 })).toBeUndefined()
    expect(reportedTokenUsage({ totalTokens: 10, inputTokens: 2, outputTokens: 3, cacheWriteTokens: 5 })).toEqual({ totalTokens: 10, inputTokens: 2, outputTokens: 3 })
  })
  it('includes failed retry attempts and never replaces partially unknown usage with zero', () => {
    const failed = { type: 'assistant/attempt', data: { stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { totalTokens: 6 } } }] } }
    expect(sessionTokenUsage([failed, { type: 'assistant/message', data: { usage: { totalTokens: 8 } } }])).toEqual({ totalTokens: 14 })
    expect(sessionTokenUsage([failed, { type: 'assistant/message', data: {} }])).toBeUndefined()
  })
})
