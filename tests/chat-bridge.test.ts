import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { Context } from '@deepseek-ai/cordis'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ReferenceInsert, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { acceptedAnnotationTokens, createChatBridge, type ChatBridge } from '../src/client/chat-bridge.tsx'
import { makeWorkflow } from '../src/shared/types.ts'

// These tests exercise our native-SDK contract, without loading the Desktop UI or any model.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: 'button', Modal: () => null }))

const PREFIX = 'visible-workflow-annotation-admission:'
const renderers: ReactTestRenderer[] = []
const bridges: ChatBridge[] = []
function observable<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return { getSnapshot: () => value, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next: T) { value = next; for (const listener of [...listeners]) listener() } }
}
const userMessage = (text: string, rpcId = 'accepted-rpc') => ({
  role: 'user', source: { kind: 'user', rpcId }, content: [{ type: 'text', text }],
})
const tokenIn = (text: string) => text.split('\n').find(line => line.startsWith(PREFIX))!.slice(PREFIX.length)

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) } })
})
afterEach(() => {
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount())
  for (const bridge of bridges.splice(0)) bridge.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function setup() {
  const flow = makeWorkflow('workspace-a', '稳定引用样例', true)
  flow.revision = 3
  const other = makeWorkflow('workspace-b', '其他工作区样例')
  let input = { draft: '保留我已有的文字 ', draftRev: 1, phase: 'plain', occurrences: [], attachmentIds: [], queue: [] } as unknown as InputState
  const inputState = observable(input)
  const setInput = (next: InputState) => { input = next; inputState.set(next) }
  const events = observable({ entries: [] as unknown[] })
  const inbox = observable<unknown>({ 'next-turn': [], 'next-step': [] })
  const actions = {
    captureInsertion: () => ({ start: input.draft.length - input.occurrences.reduce((n, item) => n + item.length - 1, 0),
      end: input.draft.length - input.occurrences.reduce((n, item) => n + item.length - 1, 0), draftRev: input.draftRev }),
    insertText: vi.fn((text: string, span: { start: number; end: number; draftRev: number }) => {
      if (span.draftRev !== input.draftRev || input.phase !== 'plain' || text !== '' || span.end !== span.start + 1) return false
      let delta = 0
      const target = input.occurrences.find(item => {
        const matches = item.offset - delta === span.start
        delta += item.length - 1
        return matches
      })
      if (!target) return false
      setInput({ ...input, draft: input.draft.slice(0, target.offset) + input.draft.slice(target.offset + target.length),
        draftRev: input.draftRev + 1,
        occurrences: input.occurrences.filter(item => item.occurrenceId !== target.occurrenceId).map(item =>
          item.offset > target.offset ? { ...item, offset: item.offset - target.length } : item) })
      return true
    }),
  }
  let source!: InputTriggerSource
  let Control!: React.ComponentType<any>
  const disposeSource = vi.fn(), disposeSlot = vi.fn(), release = vi.fn()
  const scope = {
    bail: vi.fn((_subject, event: string, request: { reference?: ReferenceInsert; text?: string; span: { draftRev: number } }) => {
      if (request.span.draftRev !== input.draftRev || input.phase !== 'plain') return false
      if (event === 'slash/input-insert-reference' && request.reference) {
        const reference = request.reference
        setInput({ ...input, draft: input.draft + reference.clipboardText + ' ', draftRev: input.draftRev + 1,
          occurrences: [...input.occurrences, { ...reference, occurrenceId: input.occurrences.length + 1,
            offset: input.draft.length, length: reference.clipboardText.length }] })
        return true
      }
      if (event === 'slash/input-insert-text' && request.text) {
        setInput({ ...input, draft: input.draft + request.text, draftRev: input.draftRev + 1 }); return true
      }
      return false
    }),
  }
  const facade = { state: inputState, focus: vi.fn() }
  const binding = { ctx: scope, eventSource: events, session: { projections: { faceOf: () => inbox } } }
  const context = {
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'workspace-a', sessionIds: ['session-a'] }] }) } },
    sessions: { scope: (id: string) => id === 'session-a' ? scope : undefined,
      retain: () => ({ binding, ready: Promise.resolve(binding), release }), binding: () => binding },
    conversation: { input: { for: () => facade } },
    inputTriggers: { registerSource: (value: InputTriggerSource) => { source = value; return disposeSource } },
    slots: { inject: (_name: string, install: () => () => void) => install(),
      register: (_entry: unknown, component: React.ComponentType<any>) => { Control = component; return disposeSlot } },
  }
  const getWorkflow = vi.fn(async (id: string) => {
    if (id !== flow.id) throw new Error('工作流不存在')
    return structuredClone(flow)
  })
  const openWorkflow = vi.fn()
  const bridge = createChatBridge(context as unknown as Context, {
    listWorkflows: async () => [flow, other], getWorkflow, openWorkflow,
  })
  bridges.push(bridge)
  let renderer!: ReactTestRenderer
  act(() => { renderer = create(React.createElement(Control, { sessionId: 'session-a',
    useInput: (select: (state: InputState) => unknown) => select(React.useSyncExternalStore(inputState.subscribe, inputState.getSnapshot)), inputActions: actions })); renderers.push(renderer) })
  return { flow, other, bridge, source, events, inbox, getWorkflow, openWorkflow, release, renderer, actions,
    input: () => input,
    optimisticClear() { act(() => setInput({ ...input, draft: '', occurrences: [], draftRev: input.draftRev + 1 })) },
    restoreDraft(previous: InputState) { act(() => setInput(previous)) },
    changeInput(patch: Partial<InputState>) { act(() => setInput({ ...input, ...patch, draftRev: input.draftRev + 1 })) },
  }
}

describe('原生消息准入识别', () => {
  const expected = new Set(['receipt-a'])
  const text = `${PREFIX}receipt-a\n用户修改要求`
  it('普通接收和排队接收都确认成功，不依赖 Agent 或工具', () => {
    expect(acceptedAnnotationTokens({ type: 'user/message', data: userMessage(text) }, expected)).toEqual(['receipt-a'])
    expect(acceptedAnnotationTokens({ 'next-turn': [userMessage(text)], 'next-step': [] }, expected)).toEqual(['receipt-a'])
    expect(acceptedAnnotationTokens({ 'next-turn': [], 'next-step': [userMessage(text)] }, expected)).toEqual(['receipt-a'])
  })
  it.each([
    ['本地 echo', { pendingSubmissions: [userMessage(text)] }],
    ['工具结果', { type: 'tool/result', data: userMessage(text) }],
    ['Agent 回答', { type: 'assistant/message', data: userMessage(text) }],
    ['消息提交事件', { type: 'messageSubmitted', data: userMessage(text) }],
    ['无 RPC 身份', { type: 'user/message', data: { ...userMessage(text), source: { kind: 'user' } } }],
    ['工具注入用户上下文', { type: 'user/message', data: { ...userMessage(text), source: { kind: 'tool', rpcId: 'abc' } } }],
    ['拼接在用户文字中的 token', { type: 'user/message', data: userMessage(`无边界${text}`) }],
    ['未知旧 token', { type: 'user/message', data: userMessage(`${PREFIX}old-receipt`) }],
  ])('%s 不能作为发送成功回执', (_name, value) => expect(acceptedAnnotationTokens(value, expected)).toEqual([]))
})

describe('草稿、引用与准入闭环（SDK 边界模拟）', () => {
  it('两条注释共用一个原生引用，修改使用稳定 ID，最终历史不携带注释序号', async () => {
    const fixture = setup(), { flow, bridge, source } = fixture
    await act(async () => {
      await bridge.stageAnnotation('session-a', flow, [flow.nodes[1]!.id], '先精简内容')
      await bridge.stageAnnotation('session-a', flow, [flow.nodes[1]!.id, flow.nodes[2]!.id], '保持两处术语一致')
    })
    expect(fixture.input().draft).toContain('保留我已有的文字')
    expect(fixture.input().occurrences).toHaveLength(1)
    expect(bridge.getAnnotations(flow.id).map(note => note.number)).toEqual([1, 2])
    act(() => bridge.editAnnotation('session-a', bridge.getAnnotations(flow.id)[0]!.id, '改为三段'))
    flow.nodes[1]!.number = 'b-99'; flow.revision++
    const text = await source.codec!.serialize(fixture.input().occurrences[0]!.ref, new AbortController().signal)
    const json = JSON.parse(text.split('\n').find(line => line.startsWith('{'))!)
    expect(json).toMatchObject({ workflowId: flow.id, referencedRevision: 3, currentRevision: 4,
      annotations: [{ nodeIds: [flow.nodes[1]!.id], requirement: '改为三段' },
        { nodeIds: [flow.nodes[1]!.id, flow.nodes[2]!.id], requirement: '保持两处术语一致' }] })
    expect(json.annotations.every((note: object) => !('number' in note))).toBe(true)
    expect(text).toContain('visible_workflow_get'); expect(text).toContain('visible_workflow_save')
    expect(bridge.getAnnotations(flow.id)).toHaveLength(2)
    act(() => fixture.inbox.set({ 'next-turn': [userMessage(text)], 'next-step': [] }))
    expect(bridge.getAnnotations(flow.id)).toEqual([])
  })
  it('原生草稿清空和序列化不代表接收，失败恢复后可重试', async () => {
    const fixture = setup(), { flow, bridge, source } = fixture
    await act(async () => bridge.stageAnnotation('session-a', flow, [flow.nodes[1]!.id], '修改摘要'))
    const previous = fixture.input()
    const text = await source.codec!.serialize(previous.occurrences[0]!.ref, new AbortController().signal)
    fixture.optimisticClear()
    expect(bridge.getAnnotations(flow.id)).toHaveLength(1)
    act(() => fixture.events.set({ entries: [{ type: 'event', event: { type: 'tool/result', data: userMessage(text) } }] }))
    expect(bridge.getAnnotations(flow.id)).toHaveLength(1)
    fixture.restoreDraft(previous)
    act(() => bridge.editAnnotation('session-a', bridge.getAnnotations(flow.id)[0]!.id, '修改后的草稿'))
    const retry = await source.codec!.serialize(previous.occurrences[0]!.ref, new AbortController().signal)
    expect(tokenIn(retry)).not.toBe(tokenIn(text))
    act(() => fixture.events.set({ entries: [{ type: 'event', event: { type: 'user/message', data: userMessage(retry) } }] }))
    expect(bridge.getAnnotations(flow.id)).toEqual([])
  })
  it('旧批次迟到回执只清旧批，不清用户刚添加的新草稿', async () => {
    const fixture = setup(), { flow, bridge, source } = fixture
    await act(async () => bridge.stageAnnotation('session-a', flow, [flow.nodes[1]!.id], '旧批次'))
    const oldText = await source.codec!.serialize(fixture.input().occurrences[0]!.ref, new AbortController().signal)
    fixture.optimisticClear()
    await act(async () => bridge.stageAnnotation('session-a', flow, [flow.nodes[2]!.id], '新批次'))
    const newText = await source.codec!.serialize(fixture.input().occurrences[0]!.ref, new AbortController().signal)
    act(() => fixture.inbox.set({ 'next-turn': [userMessage(oldText)], 'next-step': [] }))
    expect(bridge.getAnnotations(flow.id).map(note => [note.number, note.text])).toEqual([[1, '新批次']])
    act(() => fixture.inbox.set({ 'next-turn': [userMessage(newText)], 'next-step': [] }))
    expect(bridge.getAnnotations(flow.id)).toEqual([])
  })
  it('同一批次提交后的新修订不被旧修订回执清除', async () => {
    const fixture = setup(), { flow, bridge, source } = fixture
    await act(async () => bridge.stageAnnotation('session-a', flow, [flow.nodes[1]!.id], '提交快照'))
    const oldText = await source.codec!.serialize(fixture.input().occurrences[0]!.ref, new AbortController().signal)
    act(() => bridge.editAnnotation('session-a', bridge.getAnnotations(flow.id)[0]!.id, '发送失败后继续修改'))
    act(() => fixture.inbox.set({ 'next-turn': [userMessage(oldText)], 'next-step': [] }))
    expect(bridge.getAnnotations(flow.id)[0]!.text).toBe('发送失败后继续修改')
  })
  it('删除节点导致引用失效时阻止发送，保留原草稿', async () => {
    const fixture = setup(), { flow, bridge, source } = fixture
    await act(async () => bridge.stageAnnotation('session-a', flow, [flow.nodes[1]!.id], '引用该节点'))
    flow.nodes.splice(1, 1)
    await expect(source.codec!.serialize(fixture.input().occurrences[0]!.ref, new AbortController().signal)).rejects.toThrow('已被删除')
    expect(bridge.getAnnotations(flow.id)).toHaveLength(1)
  })
  it('@候选和原生插入隔离工作区，无法识别工作区时不泄漏候选', async () => {
    const fixture = setup()
    const request = { query: '', position: 'inline' as const, drilled: false, signal: new AbortController().signal }
    const candidates = await fixture.source.candidates({ sessionId: 'session-a' as never }, request)
    expect(candidates.map(candidate => candidate.label)).toEqual([fixture.flow.title])
    expect(await fixture.source.candidates({ sessionId: 'unknown' as never }, request)).toEqual([])
    await expect(fixture.bridge.insertWorkflow('session-a', fixture.other)).rejects.toThrow('复制到当前对话所属工作区')
  })
  it('新建请求包含专属新 ID，已有流程请求只修改原 ID，不混入新建指令', async () => {
    const fixture = setup()
    expect(await fixture.bridge.insertGenerateRequest('session-a', '整理会议纪要')).toBe(true)
    const createDraft = fixture.input().draft
    const identity = JSON.parse(createDraft.split('\n').find(line => line.startsWith('新工作流身份：'))!.slice('新工作流身份：'.length))
    expect(identity).toMatchObject({ workspaceId: fixture.flow.workspaceId })
    expect(identity.workflowId).not.toBe(fixture.flow.id)
    expect(createDraft).toContain('expected_revision=0')
    fixture.optimisticClear()
    expect(await fixture.bridge.insertGenerateRequest('session-a', '增加检查步骤', fixture.flow)).toBe(true)
    const editDraft = fixture.input().draft
    expect(editDraft).toContain('请修改已有工作流')
    expect(editDraft).toContain(`"workflowId":"${fixture.flow.id}"`)
    expect(editDraft).toContain('visible_workflow_get')
    expect(editDraft).toContain('同一 ID 和最新 expected_revision')
    expect(editDraft).not.toContain('请生成一个工作流')
    expect(editDraft).not.toContain('generation-admission:')
    await expect(fixture.bridge.insertGenerateRequest('session-a', '修改其他流程', fixture.other)).rejects.toThrow('复制到当前对话所属工作区')
  })
  it('只跟踪准入成功的新建请求，精确目标保存后才打开侧栏', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    await fixture.bridge.insertGenerateRequest('session-a', '生成一个摘要流程')
    const draft = fixture.input().draft
    const identity = JSON.parse(draft.split('\n').find(line => line.startsWith('新工作流身份：'))!.slice('新工作流身份：'.length))
    const generated = { ...structuredClone(fixture.flow), id: identity.workflowId, title: '新摘要流程' }
    fixture.getWorkflow.mockImplementation(async id => {
      if (id !== generated.id) throw new Error('没有此流程')
      return generated
    })
    await vi.advanceTimersByTimeAsync(3000)
    expect(fixture.getWorkflow).not.toHaveBeenCalled()
    act(() => fixture.events.set({ entries: [{ type: 'event', event: { type: 'tool/result', data: userMessage(draft) } }] }))
    await vi.advanceTimersByTimeAsync(3000)
    expect(fixture.openWorkflow).not.toHaveBeenCalled()
    act(() => fixture.events.set({ entries: [{ type: 'event', event: { type: 'user/message', data: userMessage(draft) } }] }))
    await vi.advanceTimersByTimeAsync(1500)
    expect(fixture.getWorkflow).toHaveBeenCalledWith(generated.id)
    expect(fixture.openWorkflow).toHaveBeenCalledExactlyOnceWith(generated.id, 'session-a', 'generated')
    await vi.advanceTimersByTimeAsync(3000)
    expect(fixture.openWorkflow).toHaveBeenCalledTimes(1)
  })
  it('引用按钮只打开同工作区画布，失效或跨工作区引用不触发导航', async () => {
    const fixture = setup()
    await fixture.bridge.insertWorkflow('session-a', fixture.flow)
    const ref = fixture.input().occurrences[0]!
    expect(fixture.openWorkflow).not.toHaveBeenCalled()
    fixture.openWorkflow.mockClear()
    expect(fixture.source.openReference!({ sessionId: 'session-a' as never }, ref)).toBe(true)
    expect(fixture.openWorkflow).toHaveBeenCalledExactlyOnceWith(fixture.flow.id, 'session-a', 'reference')
    fixture.openWorkflow.mockClear()
    expect(fixture.source.openReference!({ sessionId: 'unknown' as never }, ref)).toBe(false)
    expect(fixture.source.openReference!({ sessionId: 'session-a' as never }, { ...ref, ref: 'not-json' })).toBe(false)
    const crossWorkspace = { ...ref, ref: JSON.stringify({ ...JSON.parse(ref.ref), workspaceId: fixture.other.workspaceId }) }
    expect(fixture.source.openReference!({ sessionId: 'session-a' as never }, crossWorkspace)).toBe(false)
    expect(fixture.openWorkflow).not.toHaveBeenCalled()
  })
})

describe('注释与真实草稿引用联动', () => {
  const countButton = (fixture: ReturnType<typeof setup>) => fixture.renderer.root.findAllByType('button')
    .find(button => button.children.join('') === '1 条注释')
  it('手动删除引用同时隐藏按钮和画布注释，原生 Undo 恢复同一批次并可继续编辑', async () => {
    const fixture = setup(), { bridge, flow } = fixture
    await act(async () => bridge.stageAnnotation('session-a', flow, [flow.nodes[1]!.id], '保留修改意见'))
    const draft = fixture.input(), note = bridge.getAnnotations(flow.id)[0]!, observer = vi.fn()
    const off = bridge.subscribe(observer)
    expect(countButton(fixture)).toBeDefined()
    fixture.changeInput({ draft: '', occurrences: [] })
    expect(observer).toHaveBeenCalled()
    expect(bridge.getAnnotations(flow.id)).toEqual([])
    expect(countButton(fixture)).toBeUndefined()
    expect(JSON.parse(sessionStorage.getItem('dsh.visibleWorkflows.annotationDrafts.v1')!).batches).toHaveLength(1)
    fixture.changeInput({ draft: draft.draft, occurrences: draft.occurrences })
    expect(countButton(fixture)).toBeDefined()
    expect(bridge.getAnnotations(flow.id)[0]).toEqual(note)
    act(() => bridge.editAnnotation('session-a', note.id, 'Undo 后继续修改'))
    expect(bridge.getAnnotations(flow.id)[0]!.text).toBe('Undo 后继续修改')
    off()
  })
  it('提交中保留按钮和标注，失败恢复后再手动删引用不残留旧发送状态', async () => {
    const fixture = setup(), { bridge, flow, source } = fixture
    await act(async () => bridge.stageAnnotation('session-a', flow, [flow.nodes[1]!.id], '发送中的意见'))
    const draft = fixture.input()
    await act(async () => { await source.codec!.serialize(draft.occurrences[0]!.ref, new AbortController().signal) })
    fixture.changeInput({ draft: '', occurrences: [], phase: 'submitting' })
    expect(bridge.getAnnotations(flow.id)).toHaveLength(1)
    expect(countButton(fixture)).toBeDefined()
    fixture.changeInput({ draft: draft.draft, occurrences: draft.occurrences, phase: 'plain' })
    fixture.changeInput({ draft: '', occurrences: [] })
    expect(bridge.getAnnotations(flow.id)).toEqual([])
    expect(countButton(fixture)).toBeUndefined()
    // Data is retained for native Undo; only Host admission may permanently retire it.
    expect(JSON.parse(sessionStorage.getItem('dsh.visibleWorkflows.annotationDrafts.v1')!).batches).toHaveLength(1)
  })
  it('取消发送隐藏已移出输入框的临时标注，准入后 Undo 旧引用也不复活历史序号', async () => {
    const fixture = setup(), { bridge, flow, source } = fixture
    await act(async () => bridge.stageAnnotation('session-a', flow, [flow.nodes[1]!.id], '本次注释'))
    const draft = fixture.input(), controller = new AbortController()
    await act(async () => { await source.codec!.serialize(draft.occurrences[0]!.ref, controller.signal) })
    fixture.optimisticClear()
    expect(bridge.getAnnotations(flow.id)).toHaveLength(1)
    act(() => controller.abort())
    expect(bridge.getAnnotations(flow.id)).toEqual([])
    fixture.changeInput({ draft: draft.draft, occurrences: draft.occurrences })
    let text = ''
    await act(async () => { text = await source.codec!.serialize(draft.occurrences[0]!.ref, new AbortController().signal) })
    fixture.optimisticClear()
    act(() => fixture.inbox.set({ 'next-turn': [userMessage(text)], 'next-step': [] }))
    fixture.changeInput({ draft: draft.draft, occurrences: draft.occurrences })
    expect(bridge.getAnnotations(flow.id)).toEqual([])
    expect(countButton(fixture)).toBeUndefined()
    expect(JSON.parse(sessionStorage.getItem('dsh.visibleWorkflows.annotationDrafts.v1')!).batches).toEqual([])
  })
  it('可同时注释主图和多层容器节点，序列化仍以稳定 ID 校验已删除子节点', async () => {
    const fixture = setup(), { bridge, flow, source } = fixture
    const { newNode } = await import('../src/client/nodes.ts')
    const iteration = newNode('iteration'), loop = newNode('loop')
    iteration.config.body!.nodes.push(loop); flow.nodes.push(iteration)
    const child = loop.config.body!.nodes[1]!, ids = [flow.nodes[1]!.id, child.id]
    await act(async () => bridge.stageAnnotation('session-a', flow, ids, '一起修正术语'))
    let text = ''
    await act(async () => { text = await source.codec!.serialize(fixture.input().occurrences[0]!.ref, new AbortController().signal) })
    const payload = JSON.parse(text.split('\n').find(line => line.startsWith('{'))!)
    expect(payload.annotations[0].nodeIds).toEqual(ids)
    loop.config.body!.nodes = loop.config.body!.nodes.filter(n => n.id !== child.id)
    await expect(source.codec!.serialize(fixture.input().occurrences[0]!.ref, new AbortController().signal)).rejects.toThrow('已被删除')
    expect(bridge.getAnnotations(flow.id)).toHaveLength(1)
  })
})

describe('删除聊天注释', () => {
  it('删除中间条保持其余稳定 ID 和序号，迟到发送回执不清除新版本', async () => {
    const fixture = setup(), { bridge, flow, source } = fixture
    await act(async () => {
      for (const text of ['第一条', '中间条', '最后条']) await bridge.stageAnnotation('session-a', flow, [flow.nodes[1]!.id], text)
    })
    const before = bridge.getAnnotations(flow.id), reference = fixture.input().occurrences[0]!
    let old = ''
    await act(async () => { old = await source.codec!.serialize(reference.ref, new AbortController().signal) })
    await act(async () => bridge.deleteAnnotation('session-a', before[1]!.id))
    expect(bridge.getAnnotations(flow.id)).toEqual([before[0], before[2]])
    expect(fixture.input().occurrences).toEqual([reference])
    expect(fixture.actions.insertText).not.toHaveBeenCalled()
    act(() => fixture.inbox.set({ 'next-turn': [userMessage(old)], 'next-step': [] }))
    expect(bridge.getAnnotations(flow.id)).toEqual([before[0], before[2]])
    let serialized = ''
    await act(async () => { serialized = await source.codec!.serialize(reference.ref, new AbortController().signal) })
    const payload = JSON.parse(serialized.split('\n').find(line => line.startsWith('{'))!)
    expect(payload.annotations.map((item: { requirement: string }) => item.requirement)).toEqual(['第一条', '最后条'])
  })
  it('删除最后条只移除其引用，保留前后正文、其他原生引用和附件，Undo 可恢复', async () => {
    const fixture = setup(), { bridge, flow } = fixture
    await act(async () => {
      await bridge.insertWorkflow('session-a', flow)
      await bridge.stageAnnotation('session-a', flow, [flow.nodes[1]!.id], '可删除的修改')
      await bridge.insertWorkflow('session-a', flow)
    })
    fixture.changeInput({ draft: fixture.input().draft + '后面的补充文字 [工作流注释]', attachmentIds: ['existing-file' as never] })
    const before = fixture.input(), note = bridge.getAnnotations(flow.id)[0]!, target = before.occurrences[1]!
    const observer = vi.fn(), off = bridge.subscribe(observer)
    await act(async () => bridge.deleteAnnotation('session-a', note.id))
    expect(fixture.input().draft).toBe(before.draft.slice(0, target.offset) + before.draft.slice(target.offset + target.length))
    expect(fixture.input().attachmentIds).toEqual(before.attachmentIds)
    expect(fixture.input().occurrences).toEqual([
      before.occurrences[0], { ...before.occurrences[2], offset: before.occurrences[2]!.offset - target.length },
    ])
    expect(fixture.actions.insertText).toHaveBeenCalledExactlyOnceWith('', {
      start: target.offset - (before.occurrences[0]!.length - 1),
      end: target.offset - (before.occurrences[0]!.length - 1) + 1, draftRev: before.draftRev,
    })
    expect(bridge.getAnnotations(flow.id)).toEqual([])
    expect(fixture.renderer.root.findAllByType('button')).toHaveLength(0)
    expect(observer).toHaveBeenCalled()
    fixture.restoreDraft(before)
    expect(bridge.getAnnotations(flow.id)).toEqual([note])
    off()
  })
  it('同一注释批次引用被复制后，删除最后条移除全部同批引用并保留夹在中间的正文', async () => {
    const fixture = setup(), { bridge, flow } = fixture
    await act(async () => bridge.stageAnnotation('session-a', flow, [flow.nodes[1]!.id], '重复引用'))
    const before = fixture.input(), target = before.occurrences[0]!, between = '中间正文 '
    fixture.changeInput({ draft: before.draft + between + target.clipboardText + ' 结束',
      occurrences: [...before.occurrences, { ...target, occurrenceId: 90, offset: before.draft.length + between.length }] })
    await act(async () => bridge.deleteAnnotation('session-a', bridge.getAnnotations(flow.id)[0]!.id))
    expect(fixture.input().occurrences).toEqual([])
    expect(fixture.input().draft).toBe(before.draft.slice(0, target.offset) + before.draft.slice(target.offset + target.length) + between + ' 结束')
    expect(fixture.actions.insertText).toHaveBeenCalledTimes(2)
  })
  it('原生输入拒绝过期位置时不删数据、不覆盖草稿，用户可重试', async () => {
    const fixture = setup(), { bridge, flow } = fixture
    await act(async () => bridge.stageAnnotation('session-a', flow, [flow.nodes[1]!.id], '先保留'))
    const before = fixture.input(), notes = bridge.getAnnotations(flow.id)
    fixture.actions.insertText.mockReturnValueOnce(false)
    await expect(bridge.deleteAnnotation('session-a', notes[0]!.id)).rejects.toThrow('草稿已变化')
    expect(fixture.input()).toEqual(before)
    expect(bridge.getAnnotations(flow.id)).toEqual(notes)
    await act(async () => bridge.deleteAnnotation('session-a', notes[0]!.id))
    expect(bridge.getAnnotations(flow.id)).toEqual([])
  })
  it('正在提交时拒绝删除，保留发送中的注释直到原生准入回执', async () => {
    const fixture = setup(), { bridge, flow, source } = fixture
    await act(async () => bridge.stageAnnotation('session-a', flow, [flow.nodes[1]!.id], '发送快照'))
    const note = bridge.getAnnotations(flow.id)[0]!
    let text = ''
    await act(async () => { text = await source.codec!.serialize(fixture.input().occurrences[0]!.ref, new AbortController().signal) })
    fixture.changeInput({ phase: 'submitting' })
    await expect(bridge.deleteAnnotation('session-a', note.id)).rejects.toThrow('正在提交')
    expect(bridge.getAnnotations(flow.id)).toEqual([note])
    expect(fixture.actions.insertText).not.toHaveBeenCalled()
    fixture.optimisticClear()
    act(() => fixture.events.set({ entries: [{ type: 'event', event: { type: 'user/message', data: userMessage(text) } }] }))
    expect(bridge.getAnnotations(flow.id)).toEqual([])
  })
  it('删除等待原生编辑器时新增的注释不会连同整个引用一起丢失', async () => {
    const fixture = setup(), { bridge, flow } = fixture
    await act(async () => bridge.stageAnnotation('session-a', flow, [flow.nodes[1]!.id], '待删除'))
    const id = bridge.getAnnotations(flow.id)[0]!.id
    await act(async () => {
      const deleting = bridge.deleteAnnotation('session-a', id)
      await bridge.stageAnnotation('session-a', flow, [flow.nodes[2]!.id], '刚添加的内容')
      await deleting
    })
    expect(bridge.getAnnotations(flow.id).map(note => note.text)).toEqual(['刚添加的内容'])
    expect(fixture.input().occurrences).toHaveLength(1)
    expect(fixture.actions.insertText).not.toHaveBeenCalled()
  })
})
