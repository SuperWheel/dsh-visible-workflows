import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKFLOW_SESSION_TOOL_NAMES } from '../src/shared/workflow-session-tools.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { createTrialAgent, normalizeTrialEntryTools, trialAgentOutputSchema, validateTrialEntryTools, type TrialAgentInput } from '../src/host/planning/trial-agent.ts'
import type { PlanningSubagentService } from '../src/host/planning/agent.ts'

type Spec = Parameters<PlanningSubagentService['startActivation']>[0]
type Result = Awaited<Awaited<ReturnType<PlanningSubagentService['startActivation']>>['result']>
type Driver = { child: Agent; spec: Spec; step(): Promise<boolean>; emit(type: string, data: unknown, seq?: number): void }
const completed = { outcome: 'completed', summary: '产物已写出，等待 Host 核验', questions: [] }
const definition = (name: string): ToolDefinition => ({ name, description: name, parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, execute: async () => ({}) })

function fixture(config: { run?: (driver: Driver) => Promise<Result>; cleanupError?: boolean; wrongChild?: boolean; wrongReceipt?: boolean; missingStructured?: boolean; removeSettledChild?: boolean; setupPrefix?: number; isSeeded?: boolean; inheritedEventCount?: number; firstLiveSeq?: number; firstLifecycleSeq?: number } = {}) {
  const listeners = new Map<string, Set<(...args: any[]) => any>>(), known = new Set(['child']), starts: Spec[] = []
  const ctx = { on(name: string, fn: (...args: any[]) => any, option?: { prepend?: boolean }) { const existing = listeners.get(name) ?? new Set(); const group = option?.prepend ? new Set([fn, ...existing]) : existing; group.add(fn); listeners.set(name, group); return () => group.delete(fn) } } as unknown as Pick<Context, 'on'>
  const children = new Map<string, Agent>(), guards = new Map<string, ((exec: ToolExecution) => string | undefined)[]>(), childDefinitions = new Map<string, Map<string, ToolDefinition>>()
  const parentDefinitions = new Map(['read_file', 'write_file', 'run_code', 'subagent', 'ask_user_question'].map(name => [name, definition(name)]))
  const schemas = (definitions: Map<string, ToolDefinition>) => [...definitions.values()].map(({ name, description, parameters }) => ({ name, description, parameters }))
  const parent = { id: 'root', session: { header: { delegationDepth: 0 } }, ctx: { tools: { schemas: () => schemas(parentDefinitions), get: (name: string) => parentDefinitions.get(name) } } } as unknown as Agent
  const disposal = vi.fn(), assemblies: PromptAssembly[] = [], authorize = vi.fn(), onPrepared = vi.fn(), onCreated = vi.fn(), onStep = vi.fn(), onEvent = vi.fn()
  function makeChild(id: string, parentId = 'root') {
    const definitions = new Map(parentDefinitions), childGuards: ((exec: ToolExecution) => string | undefined)[] = []
    if (!config.missingStructured) definitions.set('structured_output', definition('structured_output'))
    const child = { id, session: { id, seq: config.setupPrefix ?? 0, inheritedEventCount: config.inheritedEventCount ?? 0, firstLiveSeq: config.firstLiveSeq ?? 0, firstLifecycleSeq: config.firstLifecycleSeq ?? 0, header: { parentSession: parentId, isSeeded: config.isSeeded ?? false } }, cancel: vi.fn(), ctx: {
      tools: { schemas: () => schemas(definitions), get: (name: string) => definitions.get(name), guard: (guard: (exec: ToolExecution) => string | undefined) => { childGuards.push(guard); return () => {} }, presentAs: vi.fn() },
      systemPrompt: { section: vi.fn() },
    } } as unknown as Agent
    children.set(id, child); guards.set(id, childGuards); childDefinitions.set(id, definitions)
    return child
  }
  async function created(child: Agent, source = 'startup') { for (const listener of listeners.get('agent/created') ?? []) await listener({ agent: child, source }) }
  const service: PlanningSubagentService = {
    getProvider: () => ({ inheritsParentContext: false, capabilities: { agentOptions: true, outputSchema: true, depthLimit: true } }),
    async startActivation(spec) {
      starts.push(spec)
      const child = makeChild(config.wrongChild ? 'unexpected' : spec.childId)
      await created(child)
      let seq = config.setupPrefix ?? 0, stepNo = 0
      const emit = (type: string, data: unknown, explicitSeq?: number) => {
        const eventSeq = explicitSeq ?? seq++
        Object.assign(child.session, { seq: eventSeq + 1 })
        for (const listener of listeners.get('session/event') ?? []) listener(child.session, { type, data: { turn: 1, step: stepNo, ...(data as any) }, seq: eventSeq })
      }
      const step = async () => {
        const assembly = { tools: schemas(childDefinitions.get(child.id)!), sections: [{ name: 'tools:ptc-only', text: 'run code' }, { name: 'visible-workflows:guide', text: 'plan workflows' }, { name: 'tool:subagent', text: 'spawn child' }, { name: 'host:policy', text: 'Host policy' }], contexts: [], variables: {} } as PromptAssembly
        const middleware = [...listeners.get('system-prompt/assemble') ?? []]
        const assemble = (index: number): Promise<PromptAssembly> => index === middleware.length ? Promise.resolve(assembly) : middleware[index]!(assembly, { agent: child }, () => assemble(index + 1))
        assemblies.push(await assemble(0))
        const callbacks = [...listeners.get('agent/pre-step') ?? []]
        const preStep = (index: number): Promise<any> => index === callbacks.length ? Promise.resolve({ kind: 'enter', messages: [] }) : callbacks[index]!({ agent: child, turn: 1, step: ++stepNo }, () => preStep(index + 1))
        return (await preStep(0)).kind === 'enter'
      }
      let cancel!: (value: Result) => void
      const cancelled = new Promise<Result>(resolve => { cancel = resolve })
      const run = (async () => {
        if (config.run) return config.run({ child, spec, step, emit })
        emit('turn/start', { turn: 1 }); await step()
        emit('assistant/message', { turn: 1, usage: { totalTokens: 12 }, message: { content: [{ type: 'thinking', text: 'private-thought' }, { type: 'text', text: '完成任务' }] } })
        emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
        return { stopReason: 'completed', structured: completed, output: [] }
      })()
      const result = Promise.race([run, cancelled]); void result.catch(() => {})
      if (config.removeSettledChild) { await result; children.delete(child.id) }
      return { childId: config.wrongReceipt ? 'wrong' : child.id, result, dispose: async () => { disposal(child.id); if (config.cleanupError) throw new Error('cleanup failed'); cancel({ stopReason: 'aborted', output: [] }); await result.catch(() => {}) } }
    },
  }
  const driver = createTrialAgent({ ctx, subagents: () => service, childForId: id => children.get(id), isKnownChild: id => known.has(id) })
  const input = (changes: Partial<TrialAgentInput> = {}): TrialAgentInput => ({ trialId: 'trial', childId: 'child', parent, model: { provider: 'test', model: 'test' }, prompt: '读取 input.json 并写出 result.json', signal: new AbortController().signal, tools: ['read_file', 'write_file'], maxSteps: 3, authorize, onPrepared, onCreated, onStep, onEvent, ...changes })
  const denied = (id: string, name: string, actor = children.get(id)) => (guards.get(id) ?? []).map(guard => guard({ name, agent: actor } as ToolExecution)).find(Boolean)
  return { driver, input, service, starts, children, parent, parentDefinitions, childDefinitions, makeChild, created, denied, assemblies, disposal, authorize, onPrepared, onCreated, onStep, onEvent, listeners, known }
}

afterEach(() => vi.useRealTimers())

describe('trial entry session tool catalog', () => {
  it('requires exactly one schema and a resolvable tool, excluding forbidden tools from bounded sorted feedback', () => {
    const names = ['write', 'read', 'duplicate', 'duplicate', 'missing', 'run_code', 'ask_user_question', 'structured_output', 'subagent', 'send_message', 'set_sandbox', ...Array.from({ length: 45 }, (_, i) => 'tool_'+String(i).padStart(2, '0'))]
    const parent = { ctx: { tools: { schemas: () => names.map(name => ({ name })), get: (name: string) => name === 'missing' ? undefined : {} } } } as unknown as Agent
    const tools = ['native:web_fetch', 'builtin:html.select', 'unknown', 'duplicate', 'missing', 'run_code', 'subagent'], before = [...tools]
    let error: any
    try { validateTrialEntryTools(parent, tools) } catch (caught) { error = caught }
    expect(error.code).toBe('TRIAL_TOOLS_INVALID')
    const detail = JSON.parse(error.message.slice(error.message.indexOf('{')))
    expect(detail.invalidTools).toEqual(tools)
    expect(detail.allowedSessionTools).toEqual(['read', ...names.filter(name => name.startsWith('tool_')).sort().slice(0, 39)])
    expect(detail.allowedSessionTools).toHaveLength(40); expect(detail.allowedSessionToolsTruncated).toBe(true)
    expect(tools).toEqual(before)
    expect(() => validateTrialEntryTools(parent, ['write', 'read'])).not.toThrow()
    expect(detail.useInstead).toBeUndefined()
  })

  it('requires a file-writing tool when artifacts are declared (Desktop r31)', () => {
    const names = ['write', 'read', 'workflow_http_request', 'workflow_html_select']
    const parent = { ctx: { tools: { schemas: () => names.map(name => ({ name })), get: () => ({}) } } } as unknown as Agent
    const fetchOnly = ['workflow_http_request', 'workflow_html_select']
    let error: any
    try { validateTrialEntryTools(parent, fetchOnly, true) } catch (caught) { error = caught }
    expect(error.code).toBe('TRIAL_TOOLS_INVALID')
    expect(JSON.parse(error.message.slice(error.message.indexOf('{')))).toEqual({ missingFileWriteTool: true, addOneOf: ['write'] })
    expect(() => validateTrialEntryTools(parent, fetchOnly)).not.toThrow()
    expect(() => validateTrialEntryTools(parent, [...fetchOnly, 'write', 'read'], true)).not.toThrow()
  })
  it('asks for the node-equivalent fetch tool instead of web_fetch when it is offered (Desktop r32 large page)', () => {
    const names = ['write', 'read', 'web_fetch', 'bash', 'workflow_http_request', 'workflow_html_select', 'workflow_html_extract_text']
    const parent = { ctx: { tools: { schemas: () => names.map(name => ({ name })), get: () => ({}) } } } as unknown as Agent
    let error: any
    try { validateTrialEntryTools(parent, ['web_fetch', 'read', 'write', 'bash'], true) } catch (caught) { error = caught }
    expect(error.code).toBe('TRIAL_TOOLS_INVALID')
    expect(JSON.parse(error.message.slice(error.message.indexOf('{')))).toEqual({ useInstead: { web_fetch: 'workflow_http_request' }, addOneOf: ['workflow_html_extract_text', 'workflow_html_select'] })
    expect(() => validateTrialEntryTools(parent, ['workflow_http_request', 'workflow_html_extract_text', 'read', 'write'], true)).not.toThrow()
    const plain = { ctx: { tools: { schemas: () => ['web_fetch', 'write'].map(name => ({ name })), get: () => ({}) } } } as unknown as Agent
    expect(() => validateTrialEntryTools(plain, ['web_fetch', 'write'], true)).not.toThrow()
  })
  it('asks for the node-equivalent fetch tool when a web task selects no fetch tool (Desktop r33 large page)', () => {
    const names = ['write', 'read', 'web_fetch', 'workflow_http_request', 'workflow_html_select', 'workflow_html_extract_text']
    const parent = { ctx: { tools: { schemas: () => names.map(name => ({ name })), get: () => ({}) } } } as unknown as Agent
    let error: any
    try { validateTrialEntryTools(parent, ['write', 'read'], true, true) } catch (caught) { error = caught }
    expect(error.code).toBe('TRIAL_TOOLS_INVALID')
    expect(JSON.parse(error.message.slice(error.message.indexOf('{')))).toEqual({ add: ['workflow_http_request'], addOneOf: ['workflow_html_extract_text', 'workflow_html_select'] })
    expect(() => validateTrialEntryTools(parent, ['write', 'read'], true, false)).not.toThrow()
    expect(() => validateTrialEntryTools(parent, ['workflow_http_request', 'write', 'read'], true, true)).not.toThrow()
  })
  it('rewrites unambiguous tool aliases to offered session tools before validation (Desktop r34 resubmission)', () => {
    const names = ['write', 'read', 'workflow_http_request', 'workflow_html_select']
    const parent = { ctx: { tools: { schemas: () => names.map(name => ({ name })), get: () => ({}) } } } as unknown as Agent
    expect(normalizeTrialEntryTools(parent, ['native:read', 'builtin:html.select', 'workflow_http_request', 'native:write', 'read'])).toEqual(['read', 'workflow_html_select', 'workflow_http_request', 'write'])
    expect(normalizeTrialEntryTools(parent, ['native:edit', 'builtin:html.extract_text'])).toEqual(['native:edit', 'builtin:html.extract_text'])
    // Desktop r49 declared the builtin ID without its prefix.
    const stats = { ctx: { tools: { schemas: () => [...names, 'workflow_file_stat'].map(name => ({ name })), get: () => ({}) } } } as unknown as Agent
    expect(normalizeTrialEntryTools(stats, ['read', 'file.stat', 'builtin:file.stat', 'write'])).toEqual(['read', 'workflow_file_stat', 'write'])
  })
  it('names the matching session tool for node tool IDs (Desktop r28 first attempt)', () => {
    const names = ['write', 'read', 'workflow_http_request', 'workflow_html_select']
    const parent = { ctx: { tools: { schemas: () => names.map(name => ({ name })), get: () => ({}) } } } as unknown as Agent
    let error: any
    try { validateTrialEntryTools(parent, ['builtin:html.select', 'native:write', 'native:read', 'builtin:html.extract_text', 'native:edit']) } catch (caught) { error = caught }
    const detail = JSON.parse(error.message.slice(error.message.indexOf('{')))
    expect(detail.useInstead).toEqual({ 'builtin:html.select': 'workflow_html_select', 'native:write': 'write', 'native:read': 'read' })
  })
})

describe('trial managed native execution driver', () => {
  it('passes path and procedure through without rewriting the system prompt between steps', async () => {
    const path=[{call:1,tool:'read_file',label:'读取输入',status:'success'}]
    const f=fixture({run:async({step,emit})=>{
      emit('turn/start',{turn:1});await step()
      emit('tool/call',{callId:'provider-opaque',name:'read_file',arguments:'{}'})
      emit('tool/result',{message:{toolCallId:'provider-opaque',isError:false,content:[{type:'text',text:'original result'}]}})
      await step();emit('turn/end',{turn:1,reason:{kind:'completed'}})
      return {stopReason:'completed',structured:{...completed,path,procedure:{invalid:'fall back deterministically'}},output:[]}
    }})
    const result=await f.driver.run(f.input())
    // A per-step system section would defeat prompt prefix caching on every trial step.
    expect(f.assemblies.length).toBeGreaterThan(1)
    expect(new Set(f.assemblies.map(assembly=>JSON.stringify(assembly.sections))).size).toBe(1)
    expect(result.path).toEqual(path);expect(result.procedure).toEqual({invalid:'fall back deterministically'})
    expect(result.events.find(event=>event.type==='tool/result')).toMatchObject({text:'original result',callId:'provider-opaque'})
    await f.driver.close()
  })

  it('admits only the three workflow session tools and preserves live guards and frozen schemas', async () => {
    const f = fixture({ run: async ({ child, step }) => {
      await step()
      for (const name of WORKFLOW_SESSION_TOOL_NAMES) expect(f.denied(child.id, name)).toBeUndefined()
      expect(f.denied(child.id, 'visible_workflow_run')).toMatch(/未授权工具/)
      f.parentDefinitions.delete('workflow_http_request')
      expect(f.denied(child.id, 'workflow_http_request')).toMatch(/权限或工具定义已变化/)
      return { stopReason: 'completed', structured: completed, output: [] }
    } })
    try {
      for (const name of WORKFLOW_SESSION_TOOL_NAMES) f.parentDefinitions.set(name, definition(name))
      validateTrialEntryTools(f.parent, WORKFLOW_SESSION_TOOL_NAMES)
      await expect(f.driver.run(f.input({ tools: [...WORKFLOW_SESSION_TOOL_NAMES] }))).rejects.toMatchObject({ code: 'TRIAL_TOOL_UNAVAILABLE' })
      expect(f.assemblies[0]!.tools.map(tool => tool.name)).toEqual([...WORKFLOW_SESSION_TOOL_NAMES, 'structured_output'])
      expect(f.onPrepared).toHaveBeenCalledWith({ toolDigest: expect.stringMatching(/^[a-f0-9]{64}$/), tools: [...WORKFLOW_SESSION_TOOL_NAMES] })
    } finally { await f.driver.close() }
  })
  it('says when a child stopped without a structured result, so the service may carry it on (T30.1)', async () => {
    const f = fixture({ run: async ({ step }) => { await step(); return { stopReason: 'max_turns', output: [] } } })
    try { expect(await f.driver.run(f.input())).toMatchObject({ outcome: 'failed', stopReason: 'max_turns', submitted: false }) } finally { await f.driver.close() }
  })
  it('uses the actual SDK schema subset and requires real needs-input questions', async () => {
    expect(() => assertObjectJsonSchema(trialAgentOutputSchema)).not.toThrow()
    expect(validateJsonSchemaValue(trialAgentOutputSchema, completed)).toEqual([])
    const f = fixture({ run: async ({ step }) => { await step(); return { stopReason: 'completed', structured: { outcome: 'needs-input', summary: '需要输出格式', questions: [] }, output: [] } } })
    await expect(f.driver.run(f.input())).rejects.toMatchObject({ code: 'TRIAL_OUTPUT_INVALID' }); await f.driver.close()
  })
  it('accepts a completed result that leaves out questions instead of re-requesting it (Desktop r57 C)', async () => {
    const bare = { outcome: 'completed', summary: '产物已写出，等待 Host 核验' }
    expect(validateJsonSchemaValue(trialAgentOutputSchema, bare)).toEqual([])
    const f = fixture({ run: async ({ step }) => { await step(); return { stopReason: 'completed', structured: bare, output: [] } } })
    try { expect(await f.driver.run(f.input())).toMatchObject({ outcome: 'completed', questions: [] }) } finally { await f.driver.close() }
  })
  it('freezes tools before startup, uses native presentation, retains policy and emits only public records', async () => {
    const f = fixture(); const result = await f.driver.run(f.input())
    expect(f.onPrepared).toHaveBeenCalledWith({ toolDigest: expect.stringMatching(/^[a-f0-9]{64}$/), tools: ['read_file', 'write_file'] })
    expect(f.onPrepared.mock.invocationCallOrder[0]).toBeLessThan(f.onCreated.mock.invocationCallOrder[0]!)
    expect(f.starts[0]).toMatchObject({ provider: 'spawn', childId: 'child', delivery: 'caller', request: { parent: f.parent, maxDepth: 1 } })
    expect(f.starts[0]!.request.agentOptions).not.toHaveProperty('maxTokens')
    expect(f.children.get('child')!.ctx.tools.presentAs).toHaveBeenCalledWith('native')
    expect(f.assemblies[0]!.tools.map(tool => tool.name)).toEqual(['read_file', 'write_file', 'structured_output'])
    expect(f.assemblies[0]!.sections.map(section => section.name)).toContain('host:policy')
    expect(f.assemblies[0]!.sections.map(section => section.name)).not.toContain('visible-workflows:guide')
    expect(result).toMatchObject({ outcome: 'completed', steps: 1, usage: { totalTokens: 12 }, evidenceIncomplete: false, submitted: true })
    expect(JSON.stringify(result)).not.toContain('private-thought'); expect(JSON.stringify(f.onEvent.mock.calls)).not.toContain('thinking')
    expect(f.disposal).toHaveBeenCalledOnce(); await f.driver.close()
  })
  it('captures complete public tool-result root text without claiming business verification', async () => {
    const f = fixture({ run: async ({ emit, step }) => {
      emit('turn/start', { turn: 1 }); await step()
      emit('tool/call', { callId: 'call-1', name: 'write_file', arguments: '{"path":"result.json"}' })
      emit('tool/result', { message: { toolCallId: 'call-1', content: [{ type: 'text', text: '{"saved":true,"count":3}' }], isError: false }, meta: { private: 'not public' } })
      emit('turn/end', { reason: { kind: 'completed' } })
      return { stopReason: 'completed', structured: completed, output: [] }
    } })
    const result = await f.driver.run(f.input()), receipt = result.events.find(event => event.type === 'tool/result')
    expect(receipt).toMatchObject({ type: 'tool/result', callId: 'call-1', text: '{"saved":true,"count":3}', isError: false, truncated: false })
    expect(result.usage).toBeUndefined(); expect(result).not.toHaveProperty('verified'); expect(JSON.stringify(result)).not.toContain('not public'); await f.driver.close()
  })
  it('accepts the trusted unpublished SDK setup prefix without requiring public events from zero', async () => {
    const f = fixture({ setupPrefix: 5 })
    const result = await f.driver.run(f.input())
    expect(result.events.map(event => event.seq)).toEqual([5, 6, 7])
    expect(result.evidenceIncomplete).toBe(false)
    await f.driver.close()
  })
  it.each(['first', 'later'])('does not accept a %s public event gap after a trusted setup prefix', async gap => {
    const f = fixture({ setupPrefix: 5, run: async ({ emit, step }) => {
      emit('turn/start', {}, gap === 'first' ? 6 : 5); await step()
      emit('turn/end', { reason: { kind: 'completed' } }, 7)
      return { stopReason: 'completed', structured: completed, output: [] }
    } })
    expect((await f.driver.run(f.input())).evidenceIncomplete).toBe(true)
    await f.driver.close()
  })
  it.each([
    { isSeeded: true }, { inheritedEventCount: 1 }, { firstLiveSeq: 2 }, { firstLifecycleSeq: 2 },
    { setupPrefix: -1 }, { setupPrefix: Number.NaN },
  ])('rejects seeded, restored or invalid child offsets before any business execution: %j', async config => {
    const run = vi.fn<NonNullable<Parameters<typeof fixture>[0]>['run']>()
    const f = fixture({ ...config, run })
    await expect(f.driver.run(f.input())).rejects.toMatchObject({ code: 'TRIAL_IDENTITY_INVALID' })
    expect(run).not.toHaveBeenCalled(); expect(f.onCreated).not.toHaveBeenCalled()
    expect(f.denied('child', 'write_file')).toBeTruthy(); expect(f.children.get('child')!.cancel).toHaveBeenCalled()
    await f.driver.close()
  })
  it.each(['run_code', 'ask_user_question', 'subagent', 'visible_workflow_run', 'send_message', 'set_sandbox'])('rejects prohibited tool %s before child creation', async tool => {
    const f = fixture(); await expect(f.driver.run(f.input({ tools: [tool] }))).rejects.toMatchObject({ code: 'TRIAL_TOOL_FORBIDDEN' })
    expect(f.starts).toHaveLength(0); await f.driver.close()
  })
  it('rejects unregistered child identities and a failed admission journal before any execution', async () => {
    const f = fixture(); await expect(f.driver.run(f.input({ childId: 'not-durable' }))).rejects.toMatchObject({ code: 'TRIAL_IDENTITY_INVALID' })
    await expect(f.driver.run(f.input({ onPrepared: () => { throw new Error('disk unavailable') } }))).rejects.toThrow('disk unavailable')
    expect(f.starts).toHaveLength(0); await f.driver.close()
  })
  it('rejects an unexpected child inside the creation scope before its first step', async () => {
    const f = fixture({ wrongChild: true }); await expect(f.driver.run(f.input())).rejects.toMatchObject({ code: 'TRIAL_RESUME_BLOCKED' })
    expect(f.denied('unexpected', 'write_file')).toBeTruthy(); expect(f.assemblies).toHaveLength(0); await f.driver.close()
  })
  it('detects changed parent and child definitions at authoritative tool dispatch', async () => {
    const f = fixture({ run: async ({ step }) => {
      await step(); expect(f.denied('child', 'write_file')).toBeUndefined()
      f.parentDefinitions.set('write_file', { ...definition('write_file'), description: 'changed tool' })
      expect(f.denied('child', 'write_file')).toMatch(/定义已变化/)
      return { stopReason: 'completed', structured: completed, output: [] }
    } })
    await expect(f.driver.run(f.input())).rejects.toMatchObject({ code: 'TRIAL_TOOL_CHANGED' }); expect(f.disposal).toHaveBeenCalledOnce(); await f.driver.close()
    const g = fixture({ run: async ({ step }) => {
      await step(); g.childDefinitions.get('child')!.set('write_file', { ...definition('write_file'), parameters: { type: 'object' } })
      expect(g.denied('child', 'write_file')).toBeTruthy(); return { stopReason: 'completed', structured: completed, output: [] }
    } })
    await expect(g.driver.run(g.input())).rejects.toMatchObject({ code: 'TRIAL_TOOL_CHANGED' }); await g.driver.close()
  })
  it('revalidates root authorization before each tool and denies unselected own-scope tools', async () => {
    const f = fixture({ run: async ({ step }) => {
      await step(); expect(f.denied('child', 'subagent')).toBeTruthy(); expect(f.denied('child', 'write_file', f.parent)).toBeTruthy()
      f.authorize.mockImplementation(() => { throw new Error('root became read-only') })
      expect(f.denied('child', 'write_file')).toBeTruthy(); return { stopReason: 'completed', structured: completed, output: [] }
    } })
    await expect(f.driver.run(f.input())).rejects.toThrow('root became read-only'); await f.driver.close()
  })
  it('blocks cold resume and a new startup of a settled known child but leaves unrelated children alone', async () => {
    const f = fixture(); await f.driver.run(f.input())
    const resumed = f.makeChild('child')
    await expect(f.created(resumed, 'resume')).rejects.toMatchObject({ code: 'TRIAL_RESUME_BLOCKED' })
    expect(f.denied('child', 'write_file')).toBeTruthy(); expect(resumed.cancel).toHaveBeenCalled()
    await expect(f.created(f.makeChild('child'), 'startup')).rejects.toMatchObject({ code: 'TRIAL_RESUME_BLOCKED' })
    await expect(f.created(f.makeChild('unrelated'), 'startup')).resolves.toBeUndefined()
    expect(f.denied('unrelated', 'write_file')).toBeUndefined(); await f.driver.close()
  })
  it('blocks known children recovered from a prior process without running any trial first', async () => {
    const f = fixture(); await expect(f.created(f.makeChild('child'), 'resume')).rejects.toMatchObject({ code: 'TRIAL_RESUME_BLOCKED' })
    expect(f.starts).toHaveLength(0); await f.driver.close()
  })
  it('does not replay actions to repair missing structured output', async () => {
    const f = fixture({ run: async ({ step }) => { await step(); return { stopReason: 'error', output: [{ type: 'text', text: 'done' }] } } })
    expect(await f.driver.run(f.input())).toMatchObject({ outcome: 'failed', stopReason: 'error' })
    expect(f.starts).toHaveLength(1); await f.driver.close()
  })
  it('marks truncated or sequence-gap evidence incomplete', async () => {
    const f = fixture({ run: async ({ emit, step }) => { await step(); emit('turn/start', {}, 1); emit('tool/result', { message: { toolCallId: 'call', content: [{ type: 'text', text: 'x'.repeat(7000) }], isError: false } }, 2); return { stopReason: 'completed', structured: completed, output: [] } } })
    const result = await f.driver.run(f.input()); expect(result.evidenceIncomplete).toBe(true); expect(result.events.some(event => 'truncated' in event && event.truncated)).toBe(true); await f.driver.close()
  })
  it('labels only the exact initial Host prompt as host and does not treat its excerpt as a missing execution trace', async () => {
    const prompt = '完整任务说明'.repeat(800)
    const f = fixture({ run: async ({ emit, step, spec }) => {
      emit('turn/start', {})
      emit('user/message', { source: { kind: 'user' }, content: spec.request.prompt })
      await step()
      emit('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '真人后续消息' }] })
      emit('turn/end', { reason: { kind: 'completed' } })
      return { stopReason: 'completed', structured: completed, output: [] }
    } })
    const result = await f.driver.run(f.input({ prompt })), messages = result.events.filter(event => event.type === 'user/message')
    expect(messages[0]).toMatchObject({ source: 'host', truncated: true })
    expect(messages[1]).toMatchObject({ source: 'user', text: '真人后续消息', truncated: false })
    expect(result.evidenceIncomplete).toBe(false); await f.driver.close()
  })
  it('keeps a truncated tool receipt explicitly incomplete locally without hiding other complete receipts', async () => {
    const f = fixture({ run: async ({ emit, step }) => {
      emit('turn/start', {}); await step()
      emit('tool/call', { callId: 'call', name: 'read_file', arguments: '{"path":"input.json"}' })
      emit('tool/result', { message: { toolCallId: 'call', content: [{ type: 'text', text: 'x'.repeat(7000) }], isError: false } })
      emit('turn/end', { reason: { kind: 'completed' } })
      return { stopReason: 'completed', structured: completed, output: [] }
    } })
    const result = await f.driver.run(f.input())
    expect(result.evidenceIncomplete).toBe(false)
    expect(result.events.find(event => event.type === 'tool/result')).toMatchObject({ truncated: true })
    await f.driver.close()
  })
  it('redacts credential-like text from model-authored public summaries and questions', async () => {
    const f = fixture({ run: async ({ step }) => { await step(); return { stopReason: 'completed', structured: { outcome: 'needs-input', summary: 'api_key=sk-privateabcdefghijk', questions: ['password=do-not-retain'] }, output: [] } } })
    const result = await f.driver.run(f.input())
    expect(JSON.stringify(result)).not.toContain('privateabcdefghijk'); expect(JSON.stringify(result)).not.toContain('do-not-retain')
    expect(result.summary).toContain('REDACTED'); await f.driver.close()
  })
  it('stops after the public event cap and retains only bounded receipts', async () => {
    const f = fixture({ run: async ({ emit, step }) => {
      await step()
      for (let n = 0; n < 220; n++) emit('assistant/message', { message: { content: [{ type: 'text', text: `公开输出 ${n}` }] } })
      return { stopReason: 'completed', structured: completed, output: [] }
    } })
    await expect(f.driver.run(f.input())).rejects.toMatchObject({ code: 'TRIAL_EVIDENCE_LIMIT' })
    expect(f.onEvent).toHaveBeenCalledTimes(200); expect(f.disposal).toHaveBeenCalledOnce(); await f.driver.close()
  })
  it('keeps provider quota failures distinct from local execution guards', async () => {
    const f = fixture({ run: async ({ child, step }) => {
      await step()
      for (const callback of f.listeners.get('agent/request-error') ?? []) await callback({ agent: child, failure: { code: 'INSUFFICIENT_QUOTA', status: 429, message: 'secret provider body' } }, async () => ({ kind: 'retry' }))
      return { stopReason: 'error', output: [] }
    } })
    await expect(f.driver.run(f.input())).rejects.toMatchObject({ code: 'TRIAL_PROVIDER_QUOTA' }); expect(f.starts).toHaveLength(1); await f.driver.close()
  })
  // Desktop 2026-10-26: deepseek-flash cut the final structured_output JSON short after every business call succeeded.
  const requestError = async (f: ReturnType<typeof fixture>, child: Agent, code: string, step: number, next = vi.fn(async () => undefined)) => {
    let action: unknown
    for (const callback of f.listeners.get('agent/request-error') ?? []) action = await callback({ agent: child, turn: 1, step, failure: { code, message: 'DeepSeek Messages stream: tool input is invalid JSON' } }, next)
    return action
  }
  it('re-requests a malformed or transient model response once per step and counts it as a step', async () => {
    const downstream = vi.fn(async () => undefined)
    const f = fixture({ run: async ({ child, step }) => {
      await step()
      expect(await requestError(f, child, 'MALFORMED_RESPONSE', 1, downstream)).toEqual({ kind: 'retry' })
      expect(await requestError(f, child, 'TIMEOUT', 2, downstream)).toEqual({ kind: 'retry' })
      return { stopReason: 'completed', structured: completed, output: [] }
    } })
    expect(await f.driver.run(f.input())).toMatchObject({ outcome: 'completed', steps: 3 })
    expect(f.onStep).toHaveBeenCalledTimes(3); expect(downstream).toHaveBeenCalledTimes(2); await f.driver.close()
  })
  it('keeps a second failure of the same step and non-transient failures terminal', async () => {
    for (const [codes, expected] of [[['MALFORMED_RESPONSE', 'MALFORMED_RESPONSE'], 'TRIAL_PROVIDER_ERROR'], [['CONTEXT_WINDOW_EXCEEDED'], 'TRIAL_PROVIDER_ERROR'], [['INSUFFICIENT_QUOTA'], 'TRIAL_PROVIDER_QUOTA']] as const) {
      const actions: unknown[] = []
      const f = fixture({ run: async ({ child, step }) => {
        await step()
        for (const code of codes) actions.push(await requestError(f, child, code, 1, vi.fn(async () => ({ kind: 'retry' as const }))))
        return { stopReason: 'error', output: [] }
      } })
      await expect(f.driver.run(f.input())).rejects.toMatchObject({ code: expected })
      expect(actions.at(-1)).toBeUndefined(); expect(f.starts).toHaveLength(1); await f.driver.close()
    }
  })
  it('does not grant a retry past the step limit', async () => {
    const f = fixture({ run: async ({ child, step }) => {
      await step()
      expect(await requestError(f, child, 'MALFORMED_RESPONSE', 1)).toBeUndefined()
      return { stopReason: 'error', output: [] }
    } })
    await expect(f.driver.run(f.input({ maxSteps: 1 }))).rejects.toMatchObject({ code: 'TRIAL_STEP_LIMIT' }); expect(f.onStep).toHaveBeenCalledOnce(); await f.driver.close()
  })
  it('stops on a durable event sink failure and still disposes the exact activation', async () => {
    const f = fixture(); await expect(f.driver.run(f.input({ onEvent: () => { throw new Error('receipt disk failed') } }))).rejects.toThrow('receipt disk failed')
    expect(f.disposal).toHaveBeenCalledOnce(); await f.driver.close()
  })
  it('honors cancellation even if the managed result itself does not observe the startup signal', async () => {
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve })
    const f = fixture({ run: async ({ step }) => { await step(); entered(); return new Promise<Result>(() => {}) } }), controller = new AbortController()
    const result = f.driver.run(f.input({ signal: controller.signal })), rejected = expect(result).rejects.toThrow('user stopped')
    await ready; controller.abort(new Error('user stopped')); await rejected
    expect(f.disposal).toHaveBeenCalledOnce(); await f.driver.close()
  })
  it('raises cleanup failure above a completed or cancelled outcome', async () => {
    const f = fixture({ cleanupError: true }); await expect(f.driver.run(f.input())).rejects.toMatchObject({ code: 'TRIAL_CLEANUP_FAILED' }); await f.driver.close()
  })
  it('retains the exact captured child when a very fast task leaves the registry before receipt', async () => {
    const f = fixture({ removeSettledChild: true }); expect(await f.driver.run(f.input())).toMatchObject({ outcome: 'completed' }); await f.driver.close()
  })
  it('uses an inactivity timeout rather than a token budget and closes running tasks on shutdown', async () => {
    vi.useFakeTimers(); let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve })
    const f = fixture({ run: async ({ step }) => { await step(); entered(); return new Promise<Result>(() => {}) } })
    const result = f.driver.run(f.input({ idleTimeoutMs: 1000 })), rejected = expect(result).rejects.toMatchObject({ code: 'TRIAL_IDLE_TIMEOUT' })
    await ready; await vi.advanceTimersByTimeAsync(1000); await rejected; expect(f.disposal).toHaveBeenCalledOnce(); await f.driver.close(); expect(vi.getTimerCount()).toBe(0)
    let started!: () => void; const running = new Promise<void>(resolve => { started = resolve })
    const g = fixture({ run: async ({ step }) => { await step(); started(); return new Promise<Result>(() => {}) } })
    const active = g.driver.run(g.input()), closed = expect(active).rejects.toMatchObject({ code: 'TRIAL_CLOSED' })
    await running; await g.driver.close(); await closed; expect(g.disposal).toHaveBeenCalledOnce()
  })
})
