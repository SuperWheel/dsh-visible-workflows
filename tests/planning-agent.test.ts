import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { renderPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { createPlanningAgent, PlanningAgentCleanupError, type PlanningAgentInput, type PlanningSubagentService } from '../src/host/planning/agent.ts'
import { RepairSession, CompilerError, submissionSchema } from '../src/shared/planning-repair.ts'
import { planningEditsSchema, optimizationEditsSchema } from '../src/shared/planning-edits.ts'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { PlanningContextReader } from '../src/shared/planning-context-reader.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'
import { planningMetricSchema, type PlanningMetric } from '../src/host/planning/metrics.ts'
import { planningPromptJson } from '../src/host/planning/prompt-layout.ts'
import { TEMPLATE_QUERY_GUIDANCE } from '../src/host/planning/template-catalog.ts'
import { parseToolArguments } from '../src/shared/planning-tool-arguments.ts'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { createProcedureCompiler } from '../src/shared/planning-procedure-compiler.ts'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { greetingSubmission } from '../scripts/benchmarks/template-fill-paired-self-test.ts'
import { cases,contextFor } from '../scripts/benchmarks/workflow-compiler.ts'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'

const output = { submission: { baseDigest: 'a'.repeat(64), outcome: 'needs-input', summary: '需要输入', questions: [{ id: 'q1', question: '输出格式？', options: ['文本', 'JSON'] }] } }
type Spec = Parameters<PlanningSubagentService['startActivation']>[0]
type Result = Awaited<Awaited<ReturnType<PlanningSubagentService['startActivation']>>['result']>
type Driver = { child: Agent; spec: Spec; step(messages?: any[]): Promise<boolean>; emit(type: string, data: unknown, seq?: number): void; tools: Map<string, ToolDefinition>; submit(value:unknown,deny?:boolean|'schema'):Promise<any> }

function fixture(config: { run?: (driver: Driver) => Promise<Result>; beforeReceipt?: () => Promise<void>; removeSettledChild?: boolean; missingStructured?: boolean; noCreated?: boolean; wrongReceipt?: boolean; cleanupError?: boolean } = {}) {
  const defaultCompilers=new WeakSet<PlanningAgentInput['compiler']>()
  const listeners = new Map<string, Set<(...args: any[]) => any>>()
  const ctx = { on(name: string, fn: (...args: any[]) => any, options?:{prepend?:boolean}) { const existing = listeners.get(name) ?? new Set(); const group=options?.prepend?new Set([fn,...existing]):existing; group.add(fn); listeners.set(name, group); return () => group.delete(fn) } } as unknown as Pick<Context, 'on'>
  const parent = { id: 'parent', session: { header: { delegationDepth: 2 } } } as unknown as Agent
  const children = new Map<string, Agent>(), guards = new Map<string, ((exec: ToolExecution) => string | undefined)[]>(), definitions = new Map<string, Map<string, ToolDefinition>>()
  const starts: Spec[] = [], assemblies: PromptAssembly[] = [], sections: any[] = [], presentations: string[] = []
  const disposal = vi.fn()
  const service: PlanningSubagentService = {
    getProvider: () => ({ inheritsParentContext: false, capabilities: { agentOptions: true, outputSchema: true, depthLimit: true } }),
    async startActivation(spec) {
      starts.push(spec)
      let seq = 0, stepNumber = 0
      const history:any[]=[]
      const tools = new Map<string, ToolDefinition>(), childGuards: ((exec: ToolExecution) => string | undefined)[] = []
      for (const name of ['write_file', 'run_code', ...(config.missingStructured ? [] : ['structured_output'])]) tools.set(name, { name, description: name, parameters: { type: 'object' }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
      const child = { id: spec.childId, session: { id: spec.childId, header: { parentSession: parent.id }, deriveMessages:()=>structuredClone(history) }, cancel: vi.fn(), ctx: {
        tools: {
          register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) },
          get: (name: string) => tools.get(name),
          guard: (guard: (exec: ToolExecution) => string | undefined) => { childGuards.push(guard); return () => {} },
          presentAs: (mode: string) => { presentations.push(mode); return () => {} },
        },
        systemPrompt: { section: (section: unknown) => { sections.push(section); return () => {} } },
      } } as unknown as Agent
      children.set(child.id, child); guards.set(child.id, childGuards); definitions.set(child.id, tools)
      try{if (!config.noCreated) for (const listener of listeners.get('agent/created') ?? []) await listener({ agent: child, source: 'startup' })}catch(error){disposal(child.id);throw error}
      // A preset can add own-scope tools after our creation hook. Assembly and dispatch must both exclude it.
      tools.set('subagent', { name: 'subagent', description: 'delegate', parameters: { type: 'object' }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
      const emit = (type: string, value: unknown, explicitSeq?: number) => {
        const data={turn:1,step:stepNumber,...value as any}
        if(data.message&&['assistant/message','tool/result'].includes(type))history.push(data.message)
        for (const listener of listeners.get('session/event') ?? []) listener(child.session, { type, data, seq: explicitSeq ?? seq++ })
      }
      const step = async (messages?:any[]) => {
        stepNumber++
        const claimed=messages??(stepNumber===1?[{role:'user',content:spec.request.prompt,source:{kind:'user'}}]:[])
        const assembly: PromptAssembly = { tools: [...tools.values()], sections: [{ name: 'tools:sdk', text: 'run_code instructions' }, { name: 'tools:ptc-only', text: 'PTC' }, { name: 'tool:subagent', text: 'delegate' }, { name: 'cliworker:delegation',text:'unavailable delegation guide'}, {name:'visible-workflows:guide',text:'unavailable parent workflow tools'}, {name:'plan:policy',text:'Host policy'}, { name: 'tool:structured_output', text: 'return' }], contexts: [], variables: {} }
        const middleware = [...listeners.get('system-prompt/assemble') ?? []]
        const assemble = (index: number): Promise<PromptAssembly> => index === middleware.length ? Promise.resolve(assembly) : middleware[index]!(assembly, { agent: child, scope: child }, () => assemble(index + 1))
        assemblies.push(await assemble(0))
        const preSteps = [...listeners.get('agent/pre-step') ?? []]
        const preStep = (index: number): Promise<any> => index === preSteps.length ? Promise.resolve({ kind: 'enter', messages:claimed }) : preSteps[index]!({ agent: child, messages:claimed, turn:1,step:stepNumber,signal: spec.signal }, () => preStep(index + 1))
        const decision=await preStep(0)
        if(decision.kind==='enter'){
          const text=renderPrompt(assemblies.at(-1)!)
          if(!history.some(message=>message.role==='system'))history.push({role:'system',content:[{type:'text',text}]})
          history.push(...decision.messages)
        }
        return decision.kind === 'enter'
      }
      const submit=async(value:unknown,deny:boolean|'schema'=false)=>{
        const exec={agent:child,name:'structured_output',callId:'fixture-call-'+(++seq),arguments:value,token:{},signal:spec.signal}
        const wrappers=[...listeners.get('tools/execute')??[]]
        const dispatch=(i:number):Promise<any>=>i===wrappers.length?Promise.resolve({isError:false,value,content:[],concludesTurn:true}):wrappers[i]!(exec,()=>dispatch(i+1))
        const result=await dispatch(0)
        const final=deny?{isError:true,error:{message:'policy denied',...(deny==='schema'?{info:{name:'ToolArgsError',code:'INVALID_ARGS'}}:{})},content:[]}:result
        for(const listener of listeners.get('tools/result')??[])await listener(Object.freeze(exec),Object.freeze(final))
        return final
      }
      let cancel!: (value: Result) => void
      const cancelled = new Promise<Result>(resolve => { cancel = resolve })
      const activeCompiler=currentCompiler
      const driver = (async () => {
        const result=config.run?await config.run({ child, spec, step, emit, tools, submit }):await (async()=>{await step();emit('assistant/message',{usage:{totalTokens:12}});return {stopReason:'completed',structured:output,output:[]}})()
        if(defaultCompilers.has(activeCompiler)&&result.structured!==undefined&&!validateJsonSchemaValue(spec.request.outputSchema,result.structured).length)await submit(result.structured)
        return result
      })()
      const result = Promise.race([driver, cancelled])
      void result.catch(() => {})
      if (config.removeSettledChild) { await result; children.delete(child.id) }
      await config.beforeReceipt?.()
      return { childId: config.wrongReceipt ? 'wrong-child' : child.id, result, dispose: async () => {
        disposal(child.id)
        if (config.cleanupError) throw new Error('teardown failed')
        cancel({ stopReason: 'cancelled', output: [] })
        await result.catch(() => {})
      } }
    },
  }
  const agent = createPlanningAgent({ ctx, subagents: () => service, childForId: id => children.get(id) })
  let currentCompiler:PlanningAgentInput['compiler']
  const input = (changes: Partial<PlanningAgentInput> = {}): PlanningAgentInput => ({ parent, model: { provider: 'test', model: 'fake' }, prompt: '设计工作流', signal: new AbortController().signal, nodeCatalog: [{ kind: 'input', description: '输入' }], tools: [{ id: 'native:write_file', name: 'write_file', description: '写文件', providerId: 'native', providerName: 'native', category: 'plugin', inputSchema: { type: 'object' }, available: true }], maxSteps: 3, compiler:currentCompiler=changes.compiler??(()=>{const compiler=new RepairSession(submissionSchema({type:'object'}),{maxSubmissions:3,roots:()=>['/questions'],compile:document=>({submission:document})});defaultCompilers.add(compiler);return compiler})(), ...changes })
  const denied = (id: string, name: string, actor = children.get(id)) => (guards.get(id) ?? []).map(guard => guard({ agent: actor, name } as ToolExecution)).find(Boolean)
  return { agent, service, input, starts, assemblies, sections, presentations, children, definitions, denied, disposal, listeners }
}

afterEach(()=>vi.useRealTimers())

describe('planning managed activation adapter (offline SDK fixture)', () => {
  it('keeps allowed tool wire order and policy text stable when registry insertion order changes', async () => {
    const f = fixture({ run: async ({ child, step, tools }) => {
      await step()
      const entries = [...tools.entries()].reverse()
      tools.clear()
      for (const [name, tool] of entries) tools.set(name, tool)
      await step([{ role: 'user', content: [{ type: 'text', text: 'only this delta changes' }], source: { kind: 'user' } }])
      expect(f.denied(child.id, 'write_file')).toContain('未授权')
      expect(f.denied(child.id, 'subagent')).toContain('未授权')
      return { stopReason: 'completed', structured: output, output: [] }
    } })
    await f.agent.generate(f.input())
    expect(f.assemblies.map(assembly => assembly.tools.map(tool => tool.name))).toEqual([
      ['planner_node_catalog', 'planner_tool_catalog', 'structured_output'],
      ['planner_node_catalog', 'planner_tool_catalog', 'structured_output'],
    ])
    expect(JSON.stringify(f.assemblies[1]!.tools)).toBe(JSON.stringify(f.assemblies[0]!.tools))
    expect(renderPrompt(f.assemblies[1]!)).toBe(renderPrompt(f.assemblies[0]!))
    expect(f.assemblies[0]!.sections).toContainEqual({ name: 'plan:policy', text: 'Host policy' })
  })

  it('records request identities, split payload bytes, effective stream content and unique usage receipts', async () => {
    const records: PlanningMetric[] = []
    const f = fixture({ run: async ({ child, step, emit }) => {
      await step()
      const stream = (chunk: unknown) => {
        for (const listener of f.listeners.get('agent/assistant-stream') ?? []) listener({ agent: child, frame: { type: 'chunk', chunk } })
      }
      stream({ type: 'reasoning-delta', text: 'PRIVATE-REASONING-SENTINEL' })
      stream({ type: 'tool-call-delta', name: 'structured_output', argumentsDelta: '{' })
      stream({ type: 'text-delta', text: 'ok' })
      const usage = { inputTokens: 8, outputTokens: 4, totalTokens: 12, reasoningTokens: 2 }
      emit('assistant/message', { usage }, 20)
      emit('assistant/message', { usage }, 20)
      return { stopReason: 'completed', structured: output, output: [] }
    } })
    await f.agent.generate(f.input({ onMetric: record => { planningMetricSchema.parse(record); records.push(record) } }))
    for (const phase of ['model-request', 'model-message-bytes', 'model-schema-bytes', 'first-valid-text', 'first-valid-tool-arguments', 'model-usage']) {
      expect(records.filter(record => record.phase === phase)).toEqual([expect.objectContaining({ requestIndex: 1, turn: 1, step: 1 })])
    }
    expect(records.find(record => record.phase === 'model-usage')).toMatchObject({ sequence: 20, usage: { reasoningTokens: 2, cacheReadTokens: null } })
    expect(records.every(record => record.childId === f.starts[0]!.childId)).toBe(true)
    expect(records.at(-1)).toMatchObject({ phase: 'subagent-end', status: 'success' })
    expect(JSON.stringify(records)).not.toContain('PRIVATE-REASONING-SENTINEL')
  })

  it('retains cancelled open-request timing with unknown usage and removes listeners even if terminal metric persistence fails', async () => {
    const records: PlanningMetric[] = [], controller = new AbortController()
    const f = fixture({ run: async ({ step }) => {
      await step(); controller.abort(new Error('user cancel'))
      return { stopReason: 'cancelled', output: [] }
    } })
    await expect(f.agent.generate(f.input({ signal: controller.signal, onMetric: record => {
      records.push(record)
      if (record.phase === 'subagent-end') throw new Error('metric journal unavailable')
    } }))).rejects.toThrow('metric journal unavailable')
    expect(records.find(record => record.phase === 'model-response')).toMatchObject({ status: 'cancelled', requestIndex: 1, durationMs: expect.any(Number) })
    expect(records.find(record => record.phase === 'model-usage')?.usage?.totalTokens).toBeNull()
    expect([...f.listeners.values()].every(group => group.size === 0)).toBe(true)
    expect(f.disposal).toHaveBeenCalledOnce()
  })

  it('records failed cleanup as failure even after the structured result succeeded', async () => {
    const records: PlanningMetric[] = [], f = fixture({ cleanupError: true })
    await expect(f.agent.generate(f.input({ onMetric: record => records.push(record) }))).rejects.toMatchObject({ code: 'PLANNER_CLEANUP_FAILED' })
    expect(records.at(-1)).toMatchObject({ phase: 'subagent-end', status: 'failed' })
  })
  it('uses SDK-compatible edit schemas and rejects legacy graph outputs and optimizer metadata',()=>{
    for(const schema of [planningEditsSchema,optimizationEditsSchema])expect(()=>assertObjectJsonSchema(schema)).not.toThrow()
    const candidate={protocolVersion:1,baseDigest:'a'.repeat(64),outcome:'candidate',edits:[{op:'update-node',node:'@2',configSet:{text:'你好 {{input.name}}'}}],requirementCoverage:[{requirementId:'R1',nodeIds:['@2'],note:'文本输出'}]}
    expect(validateJsonSchemaValue(planningEditsSchema,candidate)).toEqual([])
    expect(validateJsonSchemaValue(planningEditsSchema,{...candidate,requirementCoverage:[{nodeIds:['@2']}]})).not.toEqual([])
    const replacement={protocolVersion:1,baseDigest:'a'.repeat(64),outcome:'candidate',replacements:[{node:'@2',kind:'template',config:{text:'你好 {{input.name}}'},reason:'固定格式',evidenceCases:[{id:'sample',expected:{evidenceId:'e1',pointer:''}}]}]}
    expect(validateJsonSchemaValue(optimizationEditsSchema,replacement)).toEqual([])
    for(const[schema,value]of [[planningEditsSchema,candidate],[optimizationEditsSchema,replacement]]as const){
      const{protocolVersion:_version,...withoutVersion}=value
      expect(validateJsonSchemaValue(schema,withoutVersion)).toEqual([])
      for(const protocolVersion of [0,2,'1',null])expect(validateJsonSchemaValue(schema,{...value,protocolVersion})).not.toEqual([])
      const{baseDigest:_digest,...withoutDigest}=withoutVersion
      expect(validateJsonSchemaValue(schema,withoutDigest)).not.toEqual([])
    }
    for(const schema of [planningEditsSchema,optimizationEditsSchema])expect(validateJsonSchemaValue(schema,{outcome:'candidate',graphJson:'{}',summary:'旧输出',questions:[],assumptions:[],requirementCoverage:[]})).not.toEqual([])
    expect(validateJsonSchemaValue(optimizationEditsSchema,{...replacement,description:'不能借优化改元数据'})).not.toEqual([])
  })
  it('ignores obsolete caller Token caps and uses the host model output default',async()=>{
    const f=fixture()
    await f.agent.generate(f.input({maxTokens:1} as Partial<PlanningAgentInput>))
    expect(f.starts[0]!.request.agentOptions).not.toHaveProperty('maxTokens')
  })

  it('keeps a slowly progressing model alive beyond 180 seconds and clears its inactivity timer',async()=>{
    vi.useFakeTimers()
    const f=fixture({run:async({child,step})=>{
      await step()
      for(let i=0;i<4;i++){
        await vi.advanceTimersByTimeAsync(120_000)
        for(const listener of f.listeners.get('agent/assistant-stream')??[])listener({agent:child,frame:{type:'chunk'}})
      }
      return {stopReason:'completed',structured:output,output:[]}
    }})
    expect((await f.agent.generate(f.input())).output).toEqual(output)
    expect(vi.getTimerCount()).toBe(0);expect(f.disposal).toHaveBeenCalledOnce()
  })

  it('times out a model with no progress, ignores sibling activity and still disposes the child',async()=>{
    vi.useFakeTimers()
    let started!:()=>void
    const ready=new Promise<void>(resolve=>{started=resolve})
    const f=fixture({run:async({spec,step})=>{
      await step();started()
      await new Promise<void>(resolve=>spec.signal.addEventListener('abort',()=>resolve(),{once:true}))
      return {stopReason:'cancelled',output:[]}
    }})
    const pending=f.agent.generate(f.input())
    const rejected=expect(pending).rejects.toMatchObject({code:'PLANNING_IDLE_TIMEOUT'})
    await ready;await vi.advanceTimersByTimeAsync(240_000)
    for(const listener of f.listeners.get('agent/assistant-stream')??[])listener({agent:f.input().parent,frame:{type:'chunk'}})
    await vi.advanceTimersByTimeAsync(60_000);await rejected
    expect(f.disposal).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0)
  })

  it('stops if a contained durable-usage observer cannot record the receipt safely',async()=>{
    const f=fixture()
    await expect(f.agent.generate(f.input({onUsage:()=>{throw new Error('usage journal unavailable')}}))).rejects.toThrow('usage journal unavailable')
    expect(f.disposal).toHaveBeenCalledOnce()
  })

  it('reports provider quota only when the actual request-error hook identifies it',async()=>{
    const f=fixture({run:async({child,step})=>{
      await step()
      for(const listener of f.listeners.get('agent/request-error')??[])await listener({agent:child,failure:{code:'INSUFFICIENT_QUOTA',status:429,message:'Account quota exceeded'}},async()=>undefined)
      return {stopReason:'error',output:[]}
    }})
    await expect(f.agent.generate(f.input())).rejects.toMatchObject({code:'PLANNING_PROVIDER_QUOTA'})
    expect(f.disposal).toHaveBeenCalledOnce()
  })

  it('protects against oversized serialized context with a byte-specific error before a model call',async()=>{
    const beforeStep=vi.fn(),f=fixture()
    await expect(f.agent.generate(f.input({prompt:'大'.repeat(700_000),beforeStep}))).rejects.toMatchObject({code:'PLANNING_CONTEXT_TOO_LARGE'})
    expect(beforeStep).not.toHaveBeenCalled();expect(f.disposal).toHaveBeenCalledOnce()
  })

  it('estimates the admitted model history once, excludes raw journal data and skill catalogs, and preserves policy context',async()=>{
    const beforeStep=vi.fn(),onUsage=vi.fn(),prompt='规划要求'.repeat(600)
    const f=fixture({run:async({child,step,emit})=>{
      const user={role:'user',content:[{type:'text',text:prompt}],source:{kind:'user'}}
      const policy={role:'user',content:[{type:'text',text:'sandbox/approval/delegation policy'}],source:{kind:'runtime-context'}}
      const skills={role:'user',content:[{type:'text',text:'unavailable skills'.repeat(2000)}],source:{kind:'skill-catalog',entries:Array(200).fill('private metadata')}}
      emit('agent/descriptor',{journal:'not model history'.repeat(5000)})
      await step([user,skills,policy])
      expect(child.session.deriveMessages()).toEqual(expect.arrayContaining([user,policy]))
      expect(child.session.deriveMessages().some(message=>String(message.source?.kind)==='skill-catalog')).toBe(false)
      const size=()=>Buffer.byteLength(JSON.stringify({messages:child.session.deriveMessages().map(message=>({role:message.role,content:message.content,...('toolCallId'in message?{toolCallId:message.toolCallId}:{}),...('isError'in message?{isError:message.isError}:{})})),tools:f.assemblies.at(-1)!.tools}))
      expect(beforeStep.mock.calls[0]![0]).toBe(size())
      emit('assistant/message',{usage:{totalTokens:10_849},message:{role:'assistant',content:[{type:'text',text:'catalog request'}]}},15)
      emit('assistant/message',{usage:{totalTokens:10_849}},15)
      emit('tool/result',{message:{role:'tool',content:[{type:'text',text:'node catalog metadata'}],toolCallId:'call-1'}})
      emit('request/header',{notModelInput:'large repeated metadata'.repeat(5000)})
      await step()
      expect(beforeStep.mock.calls[1]![0]).toBe(size())
      expect(child.session.deriveMessages().filter(message=>message.role==='system')).toHaveLength(1)
      return {stopReason:'completed',structured:output,output:[]}
    }})
    await f.agent.generate(f.input({prompt,beforeStep,onUsage}))
    expect(beforeStep).toHaveBeenCalledTimes(2)
    expect(onUsage).toHaveBeenCalledOnce();expect(onUsage).toHaveBeenCalledWith({sequence:15,turn:1,step:1,usage:{totalTokens:10_849}})
    expect(f.assemblies.every(assembly=>assembly.sections.some(section=>section.name==='plan:policy'))).toBe(true)
  })
  it('filters catalog messages appended by an earlier outer plugin and does not bill source metadata twice',async()=>{
    const beforeStep=vi.fn(),skills={role:'user',content:[{type:'text',text:'unavailable skills'.repeat(800)}],source:{kind:'skill-catalog',entries:Array(500).fill({description:'large catalog metadata'})}}
    const policy={id:'policy',role:'user',content:[{type:'text',text:'sandbox and approval policy'}],source:{kind:'runtime-context',sections:Array(500).fill({text:'duplicate non-wire provenance'})}}
    const f=fixture({run:async({child,step,emit})=>{
      await step()
      const first=child.session.deriveMessages()
      expect(first.some(message=>String(message.source?.kind)==='skill-catalog')).toBe(false)
      expect(first).toContainEqual(policy)
      expect(beforeStep.mock.calls[0]![0]).toBeLessThan(5000)
      emit('assistant/message',{usage:{totalTokens:9575}})
      await step()
      expect(child.session.deriveMessages().some(message=>String(message.source?.kind)==='skill-catalog')).toBe(false)
      expect(beforeStep.mock.calls[1]![0]).toBeLessThan(5500)
      return {stopReason:'completed',structured:output,output:[]}
    }})
    // The real skills plugin is registered before this planner and appends its
    // catalog AFTER awaiting next(). Planner must prepend to see the final batch.
    f.listeners.set('agent/pre-step',new Set([async(_payload:any,next:()=>Promise<any>)=>{
      const decision=await next()
      return decision.kind==='enter'?{...decision,messages:[...decision.messages,skills,policy]}:decision
    }]))
    await f.agent.generate(f.input({beforeStep}))
    expect(beforeStep).toHaveBeenCalledTimes(2)
  })
  it('blocks retry policies only for the planning child so calls cannot bypass step and usage observation',async()=>{
    const next=vi.fn(async()=>({kind:'retry' as const}))
    const f=fixture({run:async({child,step})=>{
      await step()
      const handler=[...f.listeners.get('agent/request-error')!][0]!
      expect(await handler({agent:child},next)).toBeUndefined();expect(next).not.toHaveBeenCalled()
      expect(await handler({agent:f.input().parent},next)).toEqual({kind:'retry'});expect(next).toHaveBeenCalledOnce()
      return {stopReason:'completed',structured:output,output:[]}
    }})
    await f.agent.generate(f.input())
  })
  it('re-requests one malformed response per step through the same step, budget and request observation',async()=>{
    const beforeStep=vi.fn(),onMetric=vi.fn(),downstream=vi.fn(async()=>undefined)
    const failure={code:'MALFORMED_RESPONSE',message:'DeepSeek Messages stream: tool input is invalid JSON'}
    const f=fixture({run:async({child,step})=>{
      await step()
      const handler=[...f.listeners.get('agent/request-error')!][0]!
      expect(await handler({agent:child,turn:1,step:1,failure},downstream)).toEqual({kind:'retry'})
      expect(await handler({agent:child,turn:1,step:1,failure},downstream)).toBeUndefined()
      return {stopReason:'error',output:[]}
    }})
    await expect(f.agent.generate(f.input({beforeStep,onMetric}))).rejects.toMatchObject({code:'PLANNING_PROVIDER_ERROR'})
    expect(beforeStep).toHaveBeenCalledTimes(2);expect(beforeStep.mock.calls[1]).toEqual([beforeStep.mock.calls[0]![0],undefined,{turn:1,step:1}])
    expect(downstream).toHaveBeenCalledOnce()
    expect(onMetric.mock.calls.filter(([metric])=>metric.phase==='model-request')).toHaveLength(2)
    expect(onMetric.mock.calls.filter(([metric])=>metric.phase==='model-request-retry')).toHaveLength(1)
  })
  it('does not grant a model re-request past the planning step limit',async()=>{
    const beforeStep=vi.fn()
    const f=fixture({run:async({child,step})=>{
      await step()
      const handler=[...f.listeners.get('agent/request-error')!][0]!
      expect(await handler({agent:child,turn:1,step:1,failure:{code:'EMPTY_RESPONSE',message:'empty'}},async()=>undefined)).toBeUndefined()
      return {stopReason:'error',output:[]}
    }})
    await expect(f.agent.generate(f.input({beforeStep,maxSteps:1}))).rejects.toMatchObject({code:'PLANNING_STEP_LIMIT'});expect(beforeStep).toHaveBeenCalledOnce()
  })
  it('rejects an empty admitted batch after skill-only filtering without an unreserved request',async()=>{
    const beforeStep=vi.fn()
    const f=fixture({run:async({step})=>{
      expect(await step([{role:'user',content:[{type:'text',text:'skills'}],source:{kind:'skill-catalog'}}])).toBe(false)
      return {stopReason:'completed',structured:output,output:[]}
    }})
    await f.agent.generate(f.input({beforeStep}));expect(beforeStep).not.toHaveBeenCalled()
  })
  it('reports durable usage arriving during cancellation cleanup before removing listeners',async()=>{
    const controller=new AbortController(),onUsage=vi.fn()
    let started!:()=>void
    const ready=new Promise<void>(resolve=>{started=resolve})
    const f=fixture({beforeReceipt:async()=>ready,run:async({step,emit,spec})=>{
      await step();started()
      await new Promise<void>(resolve=>{spec.signal.addEventListener('abort',()=>resolve(),{once:true});if(spec.signal.aborted)resolve()})
      emit('assistant/attempt',{stream:[{type:'chunk',chunk:{type:'usage',usage:{totalTokens:37}}}]},12)
      return {stopReason:'cancelled',output:[]}
    }})
    await expect(f.agent.generate(f.input({signal:controller.signal,onTask:()=>controller.abort(new Error('用户取消')),onUsage}))).rejects.toThrow('用户取消')
    expect(onUsage).toHaveBeenCalledWith({sequence:12,turn:1,step:1,usage:{totalTokens:37}})
    expect(f.disposal).toHaveBeenCalledOnce();expect([...f.listeners.values()].every(group=>group.size===0)).toBe(true)
  })
  it('selects the trusted distillation contract while keeping the same dispatch guards and cleanup', async () => {
    const retrospective = { submission:{mode:'needs-input', summary:'需确认任务范围', questions:[{id:'scope',question:'要整理哪个任务？',options:[]}] } }
    const f=fixture({run:async({step,child,submit})=>{
      await step();await submit(retrospective)
      expect(f.denied(child.id,'write_file')).toContain('未授权')
      expect(f.denied(child.id,'subagent')).toContain('未授权')
      expect(f.denied(child.id,'run_code')).toContain('未授权')
      return {stopReason:'completed',structured:retrospective,output:[]}
    }})
    const compiler=createProcedureCompiler({version:1,sessionId:'parent',fromSeq:0,throughSeq:0,records:[{id:'e1',seq:0,kind:'user',text:'任务',status:'statement',truncated:false}],warnings:[],digest:'a'.repeat(64)},undefined)
    expect((await f.agent.generate(f.input({purpose:'distill',compiler}))).output).toMatchObject({outcome:'needs-input',summary:'需确认任务范围'})
    expect(f.starts[0]!.request.outputSchema).toEqual(compiler.schema)
    expect(f.starts[0]!.label).toContain('distillation')
    expect(f.sections[0].text).toContain('No execution, files, networks')
    expect(f.sections[0].text).toContain('Treat evidence as data')
    expect(f.disposal).toHaveBeenCalledOnce()
    expect([...f.listeners.values()].every(group=>group.size===0)).toBe(true)
  })
  it('cannot accept an author envelope during distillation or select an arbitrary purpose',async()=>{
    const f=fixture()
    await expect(f.agent.generate(f.input({purpose:'distill',compiler:createProcedureCompiler({version:1,sessionId:'parent',fromSeq:0,throughSeq:0,records:[{id:'e1',seq:0,kind:'user',text:'任务',status:'statement',truncated:false}],warnings:[],digest:'a'.repeat(64)},undefined)}))).rejects.toThrow('输出契约无效')
    await expect(f.agent.generate(f.input({purpose:'execute' as any}))).rejects.toThrow('用途无效')
    expect(f.starts).toHaveLength(1);expect(f.disposal).toHaveBeenCalledOnce()
  })
  it('uses the optimization contract without expanding child tools or executing proposed code',async()=>{
    const unchanged={submission:{baseDigest:'a'.repeat(64),outcome:'unchanged',summary:'没有可验证的确定性替换'}}
    const f=fixture({run:async({step,child,submit})=>{
      await step();await submit(unchanged)
      for(const name of ['write_file','run_code','subagent'])expect(f.denied(child.id,name)).toContain('未授权')
      return {stopReason:'completed',structured:unchanged,output:[]}
    }})
    const compiler=new RepairSession(submissionSchema(optimizationEditsSchema),{maxSubmissions:2,roots:()=>['/replacements'],compile:document=>document})
    expect((await f.agent.generate(f.input({purpose:'optimize',compiler}))).output).toEqual(unchanged.submission)
    expect(f.starts[0]!.request.outputSchema).toEqual(compiler.schema)
    expect(f.starts[0]!.label).toContain('optimization')
    expect(f.sections[0].text).toContain('No execution, files, networks')
    expect(f.disposal).toHaveBeenCalledOnce()
  })
  it('exposes bounded semantic fields, outputs, examples and optional current schemas instead of opaque configuration JSON', async () => {
    const f=fixture({run:async({child,tools})=>{
      const tool=tools.get('planner_node_catalog')!,exec={agent:child} as any
      const index=await tool.execute({},exec) as any
      expect(index.nodeIndex.length).toBeGreaterThan(10);expect(index).not.toHaveProperty('nodes')
      const selected=await tool.execute({kinds:['input','template'],topics:['references']},exec) as any
      expect(selected.nodes).toHaveLength(2);expect(selected.nodes[0].fields.fields).toContain('name')
      expect(selected.nodes[1].outputs.text).toContain('字符串');expect(selected.nodes[1].example.text).toContain('{{input.name}}')
      expect(selected.nodes[0]).not.toHaveProperty('schema');expect(selected.topics.references).toBeDefined()
      expect((await tool.execute({kinds:['input'],includeSchema:true},exec) as any).nodes[0].schema).toHaveProperty('properties')
      expect((await tool.execute({query:'input'},exec) as any).nodes[0].kind).toBe('input')
      expect((await tool.execute({query:'',limit:2},exec) as any).nodeIndex).toHaveLength(2)
      selected.nodes[0].fields.fields='corrupted'
      expect((await tool.execute({kinds:['input']},exec) as any).nodes[0].fields.fields).not.toBe('corrupted')
      await expect(tool.execute({kinds:['not-a-kind']},exec)).rejects.toThrow()
      await expect(tool.execute({}, {agent:f.input().parent} as any)).rejects.toThrow('不属于')
      return {stopReason:'completed',structured:output,output:[]}
    }})
    await f.agent.generate(f.input())
  })

  it('filters the first request and guards own-scope tools while using only the current API', async () => {
    const f = fixture(), beforeStep = vi.fn(), onStep = vi.fn()
    const result = await f.agent.generate(f.input({ beforeStep, onStep, effort: 'high' }))
    expect(result).toEqual({ output, steps: 1, usage: { totalTokens: 12 } })
    expect(f.starts[0]).toMatchObject({ provider: 'spawn', delivery: 'caller', request: { maxDepth: 3, agentOptions: { reasoningEffort: 'high' } } })
    expect(f.starts[0]!.request).not.toHaveProperty('toolFilter'); expect(f.starts[0]!.request).not.toHaveProperty('persona')
    expect(f.assemblies[0]!.tools.map(tool => tool.name).sort()).toEqual(['planner_node_catalog', 'planner_tool_catalog', 'structured_output'])
    expect(f.assemblies[0]!.sections.map(section => section.name)).toEqual(['plan:policy','tool:structured_output'])
    expect(f.presentations).toEqual(['native']); expect(f.sections[0].interpolate).toBe(false)
    expect(beforeStep).toHaveBeenCalledOnce(); expect(beforeStep.mock.calls[0]![0]).toBeGreaterThan(Buffer.byteLength('设计工作流')); expect(beforeStep.mock.calls[0]![1]).toBeUndefined()
    expect(onStep).toHaveBeenCalledOnce(); expect(f.disposal).toHaveBeenCalledOnce()
    expect([...f.listeners.values()].every(group => group.size === 0)).toBe(true)
  })

  it('exposes only detached frozen metadata and blocks business execution, siblings and delegation', async () => {
    let release!: () => void, started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const f = fixture({ run: async ({ child, tools, step }) => {
      await gate; await step()
      const tool = tools.get('planner_tool_catalog')!, exec = { agent: child } as any
      const first = await tool.execute({}, exec) as any
      expect(first.entries[0].description).toBe('写文件')
      first.entries[0].description = 'corrupted'
      expect((await tool.execute({}, exec) as any).entries[0].description).toBe('写文件')
      await expect(tool.execute({}, { agent: f.input().parent } as any)).rejects.toThrow('不属于')
      await expect(tool.execute({ limit: 1000 }, exec)).rejects.toThrow('参数无效')
      expect(f.denied(child.id, 'write_file')).toContain('未授权')
      expect(f.denied(child.id, 'subagent')).toContain('未授权')
      expect(f.denied(child.id, 'run_code')).toContain('未授权')
      expect(f.denied(child.id, 'structured_output')).toBeUndefined()
      return { stopReason: 'completed', structured: output, output: [] }
    } })
    const input = f.input({ onTask: started }), promise = f.agent.generate(input)
    await ready; input.tools[0]!.description = 'modified after admission'; release(); await promise
  })

  it.each([
    { stopReason: 'completed', output: [] },
    { stopReason: 'error', structured: output, output: [] },
    { stopReason: 'completed', structured: { graphJson: '{}' }, output: [] },
  ])('rejects missing, partial or unvalidated structured results: $stopReason', async result => {
    const f = fixture({ run: async ({ step }) => { await step(); return result as Result } })
    await expect(f.agent.generate(f.input())).rejects.toThrow(/完整结构化结果|输出契约无效/)
    expect(f.disposal).toHaveBeenCalledOnce()
  })

  it('fails before the first model step when required structured tooling is absent', async () => {
    const f = fixture({ missingStructured: true }), beforeStep = vi.fn()
    await expect(f.agent.generate(f.input({ beforeStep }))).rejects.toThrow('缺少原生结构化工具')
    expect(beforeStep).not.toHaveBeenCalled(); expect(f.disposal).toHaveBeenCalledOnce()
  })

  it('rejects unguarded creation and mismatched returned identities', async () => {
    for (const config of [{ noCreated: true }, { wrongReceipt: true }]) {
      const f = fixture(config)
      await expect(f.agent.generate(f.input())).rejects.toThrow(/身份不匹配|受控创建/)
      expect(f.disposal).toHaveBeenCalledOnce()
    }
  })

  it('disposes a published activation when admission signal cancellation alone does not stop it', async () => {
    const controller = new AbortController()
    const f = fixture({ run: async ({ step }) => { await step(); return new Promise<Result>(() => {}) } })
    await expect(f.agent.generate(f.input({ signal: controller.signal, onTask: () => controller.abort(new Error('用户取消')) }))).rejects.toThrow('用户取消')
    expect(f.disposal).toHaveBeenCalledOnce(); expect([...f.listeners.values()].every(group => group.size === 0)).toBe(true)
  })

  it('reports failed teardown explicitly instead of reporting a successful cancellation', async () => {
    const controller = new AbortController(), f = fixture({ cleanupError: true })
    await expect(f.agent.generate(f.input({ signal: controller.signal, onTask: () => controller.abort(new Error('用户取消')) }))).rejects.toBeInstanceOf(PlanningAgentCleanupError)
    expect(f.disposal).toHaveBeenCalledOnce(); expect([...f.listeners.values()].every(group => group.size === 0)).toBe(true)
  })

  it('cleans a late publication after cancellation during startup', async () => {
    let release!: () => void, admitted!: () => void
    const ready = new Promise<void>(resolve => { admitted = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const controller = new AbortController(), f = fixture({ beforeReceipt: async () => { admitted(); await gate } })
    const promise = f.agent.generate(f.input({ signal: controller.signal }))
    const rejected = expect(promise).rejects.toThrow('启动中取消')
    await ready; controller.abort(new Error('启动中取消')); release(); await rejected
    expect(f.disposal).toHaveBeenCalledOnce()
  })

  it('accepts a controlled child that naturally settled before the receipt and rejects successful output when disposal fails', async () => {
    const settled = fixture({ removeSettledChild: true })
    expect((await settled.agent.generate(settled.input())).output).toEqual(output)
    const failing = fixture({ cleanupError: true })
    await expect(failing.agent.generate(failing.input())).rejects.toMatchObject({ code: 'PLANNER_CLEANUP_FAILED' })
  })

  it('enforces step protection and live authorization before another request', async () => {
    const f = fixture({ run: async ({ step }) => {
      expect(await step()).toBe(true); expect(await step()).toBe(false)
      return { stopReason: 'completed', structured: output, output: [] }
    } })
    await expect(f.agent.generate(f.input({ maxSteps: 1 }))).rejects.toMatchObject({code:'PLANNING_STEP_LIMIT'})
    const denied = fixture()
    await expect(denied.agent.generate(denied.input({ beforeStep: () => { throw new Error('permission revoked') } }))).rejects.toThrow('permission revoked')
    expect(denied.disposal).toHaveBeenCalledOnce()
  })

  it('deduplicates durable usage and leaves incomplete accounting unknown', async () => {
    const counted = fixture({ run: async ({ step, emit }) => { await step(); emit('assistant/attempt', { usage: { totalTokens: 3 } }, 1); emit('assistant/attempt', { usage: { totalTokens: 3 } }, 1); emit('assistant/message', { usage: { totalTokens: 9 } }, 2); return { stopReason: 'completed', structured: output, output: [] } } })
    expect((await counted.agent.generate(counted.input())).usage).toEqual({ totalTokens: 12 })
    const missing = fixture({ run: async ({ step, emit }) => { await step(); emit('assistant/attempt', {}); emit('assistant/message', { usage: { totalTokens: 9 } }); return { stopReason: 'completed', structured: output, output: [] } } })
    expect((await missing.agent.generate(missing.input())).usage).toBeUndefined()
  })

  it('isolates simultaneous child scopes under the same parent', async () => {
    const f = fixture()
    const values = await Promise.all([f.agent.generate(f.input()), f.agent.generate(f.input())])
    expect(values).toHaveLength(2); expect(f.starts[0]!.childId).not.toBe(f.starts[1]!.childId)
    expect(f.disposal).toHaveBeenCalledTimes(2)
    expect(values.map(value => value.usage?.totalTokens)).toEqual([12, 12])
  })

  it('rejects unsupported providers and never starts a fallback', async () => {
    const f = fixture()
    f.service.getProvider = () => ({ inheritsParentContext: true, capabilities: { agentOptions: true, outputSchema: true, depthLimit: true } })
    await expect(f.agent.generate(f.input())).rejects.toThrow('不支持当前受控规划')
    expect(f.starts).toHaveLength(0)
  })
})


describe('compiler before native structured-output termination',()=>{
  const compiler=()=>new RepairSession(submissionSchema({type:'object',properties:{x:{type:'number'}},required:['x'],additionalProperties:false}),{
    maxSubmissions:3,roots:()=>['/x'],diagnose:()=>[{code:'VALUE',message:'x must equal 7',path:'/x',expected:{type:'number'},allowedPaths:['/x']}],compile:(v:any)=>{if(v.x!==7)throw new CompilerError('VALUE','x must equal 7','/x');return {canonical:7}},
  })
  it('narrows the next model tool schema to repairs while retaining the native terminal contract',async()=>{
    const c=compiler()
    const f=fixture({run:async d=>{
      await d.step();await d.submit({submission:{x:0}})
      await d.step()
      const wire={submission:{mode:'repair',draftRevision:1,patches:[{op:'replace',path:'/x',value:7}]}}
      await d.submit(wire)
      return{stopReason:'completed',structured:wire,output:[]}
    }})
    await f.agent.generate(f.input({compiler:c}))
    const schema=f.assemblies[1]!.tools.find(t=>t.name==='structured_output')!.parameters
    expect(validateJsonSchemaValue(schema,{submission:{x:7}})).not.toEqual([])
    expect(validateJsonSchemaValue(f.starts[0]!.request.outputSchema!,{submission:{x:7}})).toEqual([])
  })
  it('repairs in one activation and only the accepted native result terminates',async()=>{
    const c=compiler(),calls:any[]=[],metrics:PlanningMetric[]=[]
    const f=fixture({run:async({step,submit})=>{
      await step();const initial={submission:{x:8}};const failed=await submit(initial);calls.push(failed)
      expect(failed.isError).toBe(true);expect(failed.concludesTurn).toBeUndefined()
      const feedback=JSON.parse(failed.error.message)
      await step();const repair={submission:{mode:'repair',draftRevision:feedback.draftRevision,patches:[{op:'replace',path:'/x',value:7}]}}
      calls.push(await submit(repair));return {stopReason:'completed',structured:repair,output:[]}
    }})
    expect((await f.agent.generate(f.input({compiler:c,onMetric:record=>metrics.push(record)}))).output).toEqual({canonical:7})
    expect(f.starts).toHaveLength(1);expect(f.disposal).toHaveBeenCalledOnce();expect(calls).toHaveLength(2)
    expect(metrics.filter(record=>record.phase==='submission')).toHaveLength(2)
    expect(metrics.filter(record=>record.phase==='repair')).toEqual([expect.objectContaining({toolIndex:2,count:1,requestIndex:2})])
    expect(metrics.filter(record=>record.phase==='tool-start').map(record=>record.callId)).toEqual(metrics.filter(record=>record.phase==='tool-end').map(record=>record.callId))
    expect(metrics.filter(record=>record.phase==='tool-end').map(record=>record.status)).toEqual(['failed','success'])
  })
  it('does not add a model confirmation step after first success',async()=>{
    let steps=0
    const f=fixture({run:async({step,submit})=>{await step();steps++;const wire={submission:{x:7}};await submit(wire);return {stopReason:'completed',structured:wire,output:[]}}})
    expect((await f.agent.generate(f.input({compiler:compiler()}))).output).toEqual({canonical:7})
    expect(steps).toBe(1)
  })
  it('does not accept a compiled candidate when the final tool policy rejects it',async()=>{
    const f=fixture({run:async({step,submit})=>{await step();const wire={submission:{x:7}};await submit(wire,true);return {stopReason:'completed',structured:wire,output:[]}}})
    await expect(f.agent.generate(f.input({compiler:compiler()}))).rejects.toMatchObject({code:'COMPILER_COMMIT_REJECTED'})
    expect(f.disposal).toHaveBeenCalledOnce()
  })
  it('reports a late SDK INVALID_ARGS rejection as a tool Schema failure with no accepted result',async()=>{
    const f=fixture({run:async({step,submit})=>{await step();const wire={submission:{x:7}};await submit(wire,'schema');return {stopReason:'completed',structured:wire,output:[]}}})
    await expect(f.agent.generate(f.input({compiler:compiler()}))).rejects.toMatchObject({code:'COMPILER_COMMIT_REJECTED',message:expect.stringContaining('工具参数未通过 SDK 工具 Schema 校验')})
    expect(f.disposal).toHaveBeenCalledOnce()
  })
  it.each([
    {label:'narrower model declaration',field:{type:'number',const:7},invalid:8},
    {label:'broader model declaration, fixed SDK terminal still rejects',field:{oneOf:[{type:'number'},{type:'string'}]},invalid:'7'},
  ])('checks both actual declarations before compilation: $label',async({field,invalid})=>{
    const c=compiler()
    const f=fixture({run:async({child,step,submit})=>{
      await step()
      const schema=structuredClone(c.schema) as any
      schema.properties.submission.oneOf[0].properties.x=field
      const request=markAgentLoopRequest({provider:'fixture',model:'no-model',sessionId:child.id,messages:[],tools:[{name:'structured_output',description:'final declaration',parameters:schema}]})
      for(const listener of f.listeners.get('llm/stream')??[])listener(request,()=>({async *[Symbol.asyncIterator](){}}))
      const rejected=await submit({submission:{x:invalid}})
      const feedback=JSON.parse(rejected.error.message)
      expect(feedback.remainingSubmissions).toBe(2)
      expect(feedback.issues[0]).toMatchObject({code:'COMPILER_TOOL_SCHEMA_INVALID'})
      expect(c.snapshot().document).toBeUndefined()
      const wire={submission:{x:7}};await submit(wire)
      return {stopReason:'completed',structured:wire,output:[]}
    }})
    expect((await f.agent.generate(f.input({compiler:c}))).output).toEqual({canonical:7})
    expect(c.snapshot().submissions).toBe(2)
  })
  it('keeps an existing draft unchanged when a repair violates the advertised next schema',async()=>{
    const c=compiler()
    const f=fixture({run:async({step,submit})=>{
      await step();await submit({submission:{x:0}});await step()
      const before=c.snapshot()
      const rejected=await submit({submission:{mode:'repair',draftRevision:1,patches:[{op:'replace',path:'/x',value:'7'}]}})
      expect(JSON.parse(rejected.error.message)).toMatchObject({draftRevision:1,remainingSubmissions:1})
      expect(c.snapshot().document).toEqual(before.document);expect(c.snapshot().revision).toBe(before.revision)
      const wire={submission:{mode:'repair',draftRevision:1,patches:[{op:'replace',path:'/x',value:7}]}}
      await submit(wire);return {stopReason:'completed',structured:wire,output:[]}
    }})
    expect((await f.agent.generate(f.input({compiler:c}))).output).toEqual({canonical:7})
    expect(c.snapshot().submissions).toBe(3)
  })
  it('requires a native successful receipt and preserves cleanup failure precedence',async()=>{
    const f=fixture({run:async({step})=>{await step();return {stopReason:'completed',structured:{submission:{x:7}},output:[]}}})
    await expect(f.agent.generate(f.input({compiler:compiler()}))).rejects.toMatchObject({code:'COMPILER_MISSING_COMMIT'})
    const dirty=fixture({cleanupError:true,run:async({step,submit})=>{await step();const wire={submission:{x:7}};await submit(wire);return {stopReason:'completed',structured:wire,output:[]}}})
    await expect(dirty.agent.generate(dirty.input({compiler:compiler()}))).rejects.toMatchObject({code:'PLANNER_CLEANUP_FAILED'})
  })
})

describe('compiler graph context stays scoped and read-only',()=>{
  it.each([
    {label:'first initial',answers:[]},
    {label:'no-draft initial clarification',answers:[{questionId:'choice',answer:'Human selected greeting'}]},
  ])('observes final SDK declarations and deduplicates only the Host $label contract',async({answers})=>{
    const records:PlanningMetric[]=[]
    const c=new RepairSession(submissionSchema({type:'object'}),{maxSubmissions:1,roots:()=>[],compile:()=>({canonical:true})})
    const prompt=planningPromptJson({rules:c.instructions,templateAccess:TEMPLATE_QUERY_GUIDANCE,templateCatalog:{prefetched:{entries:[{id:'template'}]}},runtimeSemantics:{nodes:[{kind:'template',syntax:{kept:true}}]},requirement:{text:'BUSINESS_PRIVATE'},answers})
    const f=fixture({run:async({child,spec,step,submit})=>{
      await step()
      const admitted=(spec.request.prompt[0] as {type:'text';text:string}).text
      expect(admitted).not.toBe(prompt)
      expect(JSON.parse(admitted).runtimeSemantics).toEqual(JSON.parse(prompt).runtimeSemantics)
      expect(JSON.parse(admitted).answers).toEqual(answers)
      const boundary=f.sections.find(section=>section.name==='visible-workflows:planning-boundary')!.text
      expect(boundary).toContain(c.instructions);expect(boundary).toContain(TEMPLATE_QUERY_GUIDANCE)
      const sdk={provider:'fixture',model:'no-model',sessionId:child.id,messages:[{role:'system',content:[{type:'text',text:boundary}]},{role:'user',content:[{type:'text',text:admitted}]},{role:'assistant',content:[{type:'reasoning',text:'REASONING_PRIVATE'}],source:{replayState:{secret:'REPLAY_PRIVATE'}}}],tools:f.assemblies[0]!.tools.map(({name,description,parameters})=>({name,description,parameters}))}
      const frozen=JSON.stringify(sdk)
      const next=vi.fn(()=>({async *[Symbol.asyncIterator](){}}))
      for(const listener of f.listeners.get('llm/stream')??[]){
        listener(markAgentLoopRequest({...sdk,sessionId:'sibling'}),next)
        listener(markAgentLoopRequest({...sdk,purpose:'compaction'}),next)
        listener(sdk,next) // A direct auxiliary request may copy sessionId; it is not the planning loop.
        const stream=listener(markAgentLoopRequest(sdk),next);for await(const _ of stream){}
      }
      expect(JSON.stringify(sdk)).toBe(frozen)
      expect(next).toHaveBeenCalledTimes(4)
      const wire={submission:{}};await submit(wire);return{stopReason:'completed',structured:wire,output:[]}
    }})
    await f.agent.generate(f.input({prompt,promptContractSource:'host-template-initial-v1',compiler:c,templateQuery:()=>({entries:[]}),onMetric:metric=>{planningMetricSchema.parse(metric);records.push(metric)}}))
    const observed=records.filter(metric=>metric.phase==='sdk-payload')
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({requestIndex:1,payload:{compilerRulesCopies:1,templateAccessCopies:1,exactTaskPromptCopies:1,toolOrder:['planner_node_catalog','planner_node_templates','planner_tool_catalog','structured_output'],prompt:{runtimeKinds:['template'],runtimeSchemaCount:0,templateSyntaxDigest:expect.any(String)}}})
    expect(JSON.stringify(observed)).not.toContain('PRIVATE')
    expect([...f.listeners.values()].every(group=>group.size===0)).toBe(true)
  })
  it('explains acquired-template schemas in the planning boundary and template query tool',async()=>{
    const c=new RepairSession(submissionSchema({type:'object'}),{maxSubmissions:1,roots:()=>[],compile:()=>({canonical:true})})
    const templateQuery=vi.fn(ids=>({entries:ids.map((id:string)=>({id}))}))
    const f=fixture({run:async({child,step,tools,submit})=>{
      await step()
      const query=tools.get('planner_node_templates')!
      expect(query.description).toContain('当前提交 schema 仅列已获取模板')
      expect(query.description).toContain('下一轮自动扩展')
      expect(await query.execute({ids:['tool-example']},{agent:child} as any)).toEqual({entries:[{id:'tool-example'}]})
      const wire={submission:{}};await submit(wire);return {stopReason:'completed',structured:wire,output:[]}
    }})
    await f.agent.generate(f.input({compiler:c,templateQuery}))
    expect(templateQuery).toHaveBeenCalledWith(['tool-example'])
    expect(f.sections.find(section=>section.name==='visible-workflows:planning-boundary')?.text).toContain('当前提交 schema 仅列已获取模板')
  })
  it('batch-reads frozen omitted configs and advertises repairable terminal-tool semantics',async()=>{
    const graphContext=[{key:'n1',kind:'template',config:{text:'original'}}]
    const c=new RepairSession(submissionSchema({type:'object'}),{maxSubmissions:1,roots:()=>[],compile:()=>({canonical:true})})
    const f=fixture({run:async({child,step,tools,submit})=>{
      await step();graphContext[0]!.config.text='external mutation'
      const query=tools.get('planner_graph_context')!
      const first=await query.execute({keys:['n1']},{agent:child} as any) as any
      expect(first.nodes[0].config.text).toBe('original');first.nodes[0].config.text='caller mutation'
      expect(await query.execute({keys:['n1']},{agent:child} as any)).toMatchObject({nodes:[{config:{text:'original'}}]})
      await expect(query.execute({keys:['missing']},{agent:child} as any)).rejects.toThrow('不存在')
      await expect(query.execute({keys:['n1']},{agent:f.input().parent} as any)).rejects.toThrow('不属于')
      const wire={submission:{}};await submit(wire);return{stopReason:'completed',structured:wire,output:[]}
    }})
    await f.agent.generate(f.input({compiler:c,graphContext}))
    expect(f.assemblies[0]!.tools.find(t=>t.name==='structured_output')!.description).toContain('repairable')
    expect(f.assemblies[0]!.tools.some(t=>t.name==='planner_graph_context')).toBe(true)
  })
})

describe('Host authorization at metadata-read dispatch',()=>{
  it.each(['planner_node_catalog','planner_tool_catalog','planner_node_templates','planner_graph_context'])('rechecks current authority for %s without spending compiler submissions',async(name)=>{
    let allowed=true
    const authorize=vi.fn(()=>{if(!allowed)throw new Error('current owner/revision revoked')})
    const compiler=new RepairSession(submissionSchema({type:'object',properties:{text:{type:'string'}}}),{maxSubmissions:3,roots:()=>['/text'],compile:value=>({text:value.text})}),read=vi.fn(()=>({nodes:[{key:'n1'}]})),query=vi.fn(()=>({entries:[]}))
    const f=fixture({run:async({child,step,tools,submit})=>{
      await step();allowed=false
      const args=name==='planner_node_catalog'?{kinds:['template']}:name==='planner_tool_catalog'?{query:'write_file'}:name==='planner_node_templates'?{ids:['template']}:{keys:['n1']}
      await expect(tools.get(name)!.execute(args,{agent:child} as any)).rejects.toThrow('current owner/revision revoked')
      expect(compiler.snapshot().submissions).toBe(0);expect(read).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled()
      allowed=true;await submit({submission:{text:'valid'}})
      return {stopReason:'completed',structured:{submission:{text:'valid'}},output:[]}
    }})
    expect((await f.agent.generate(f.input({compiler,beforeSubmission:authorize,templateQuery:query,graphContextRead:read}))).output).toEqual({text:'valid'})
    expect(compiler.snapshot().submissions).toBe(1)
  })
  it('uses the shared batch reader and returns detached dependency rows',async()=>{
    const context=templateContext();context.operation='revise';context.workflow.revision=1
    const reader=new PlanningContextReader(context,{scopeIdentity:'workspace:parent:task'})
    const compiler=new RepairSession(submissionSchema({type:'object',properties:{text:{type:'string'}}}),{maxSubmissions:3,roots:()=>['/text'],compile:value=>value}),read=vi.fn((keys:readonly string[])=>reader.read({keys,expectedRevision:1})),authorize=vi.fn()
    const f=fixture({run:async({child,step,tools,submit})=>{
      await step();const tool=tools.get('planner_graph_context')!,exec={agent:child} as any
      const first=await tool.execute({keys:['n2']},exec) as any
      expect(first.readNodeIds).toEqual(['host-start','host-end']);expect(first.nodes.map((node:any)=>node.key)).toEqual(['n1','n2'])
      first.nodes[0].title='tampered'
      const next=await tool.execute({keys:['n2']},exec) as any
      expect(next.nodes[0].title).toBe('输入');expect(compiler.snapshot().submissions).toBe(0);expect(reader.stats().hits).toBe(1)
      await submit({submission:{text:'valid'}});return {stopReason:'completed',structured:{submission:{text:'valid'}},output:[]}
    }})
    await f.agent.generate(f.input({compiler,beforeSubmission:authorize,graphContextRead:read}))
    expect(read).toHaveBeenCalledTimes(2);expect(compiler.snapshot().submissions).toBe(1)
  })
})


describe('native planning tool-argument completion before SDK parsing',()=>{
  it.each(['compact-repair','template-fill'] as const)('%s completes only the terminal raw JSON suffix before native validation',async arm=>{
    const context=contextFor(cases.find(c=>c.id==='greeting')!),compiler=arm==='template-fill'?new TemplateFillingCompiler(context):new WorkflowAuthoringCompiler(context)
    const f=fixture({run:async({child,step,submit})=>{
      await step()
      const raw=JSON.stringify(greetingSubmission(arm)).slice(0,-1),block={type:'tool-call',id:'native-call',name:'structured_output',arguments:raw}
      const chunks:any[]=[{type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:raw},{type:'block-end',index:0,block},{type:'finish',reason:'tool-calls'}]
      const stream=async function*(items:any[]){yield* items}
      const listeners=[...f.listeners.get('llm/stream')??[]]
      const dispatch=(request:any,index=0):AsyncIterable<any>=>index===listeners.length?stream(chunks):listeners[index]!(request,()=>dispatch(request,index+1))
      const request={provider:'fixture',model:'no-model',sessionId:child.id,messages:[],tools:[]}
      for(const scoped of [request,markAgentLoopRequest({...request,sessionId:'sibling'}),markAgentLoopRequest({...request,purpose:'compaction'})]){
        const result=[];for await(const chunk of dispatch(scoped))result.push(chunk)
        expect(result).toEqual(chunks)
      }
      const result=[];for await(const chunk of dispatch(markAgentLoopRequest(request)))result.push(chunk)
      expect(result[1]).toMatchObject({type:'tool-call-delta',argumentsDelta:'}'})
      const completed=result.find(chunk=>chunk.type==='block-end')!.block.arguments
      expect(completed).toBe(raw+'}');expect(chunks[1].block.arguments).toBe(raw)
      const args=JSON.parse(completed)
      expect(parseToolArguments(raw)).toEqual(args)
      // Production compiler still runs inside the native tools/execute wrapper.
      expect((await submit(args)).isError).toBe(false)
      return {stopReason:'completed',structured:args,output:[]}
    }})
    const result=await f.agent.generate(f.input({compiler}))
    expect((result.output as any).candidate).toBeDefined();expect(compiler.snapshot().submissions).toBe(1)
  })
})
