import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { Context } from '@deepseek-ai/cordis'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ReferenceInsert, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { acceptedAnnotationTokens, createChatBridge, type ChatBridge } from '../src/client/chat-bridge.tsx'
import { makeWorkflow } from '../src/shared/types.ts'
import type { AnnotationPosition } from '../src/client/annotation-position.ts'

// These tests exercise our native-SDK contract, without loading the Desktop UI or any model.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: 'button', Modal: () => null }))
vi.mock('../src/client/annotation-editor.tsx',()=>({AnnotationEditor:(props:Record<string,unknown>)=>React.createElement('annotation-editor-mock',props)}))

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

function setup(options:{flow?:ReturnType<typeof makeWorkflow>;input?:InputState;controlRect?:{left:number;right:number;top:number;bottom:number}}={}) {
  const flow = options.flow??makeWorkflow('workspace-a', '稳定引用样例', true)
  flow.revision = 3
  const other = makeWorkflow('workspace-b', '其他工作区样例')
  let input = options.input??{ draft: '保留我已有的文字 ', draftRev: 1, phase: 'plain', occurrences: [], attachmentIds: [], queue: [] } as unknown as InputState
  const inputState = observable(input)
  const setInput = (next: InputState) => { input = next; inputState.set(next) }
  const events = observable({ entries: [] as unknown[] })
  const inbox = observable<unknown>({ 'next-turn': [], 'next-step': [] })
  const workspaces=observable({items:[{workspaceId:'workspace-a',sessionIds:['session-a']}]})
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
    bail: vi.fn((_subject, event: string, request: { reference?: ReferenceInsert; text?: string; span: { start:number;end:number;draftRev: number } }) => {
      if (request.span.draftRev !== input.draftRev || input.phase !== 'plain') return false
      if (event === 'slash/input-insert-reference' && request.reference) {
        const reference = request.reference
        const expand=(position:number)=>{let delta=0;for(const item of input.occurrences){if(item.offset-delta>=position)break;delta+=item.length-1}return position+delta}
        const start=expand(request.span.start),end=expand(request.span.end),text=reference.clipboardText+' '
        const occurrences=input.occurrences.filter(item=>item.offset<start||item.offset>=end).map(item=>item.offset>=end?{...item,offset:item.offset+text.length-(end-start)}:item)
        const occurrenceId=Math.max(0,...input.occurrences.map(item=>item.occurrenceId))+1
        setInput({ ...input,draft:input.draft.slice(0,start)+text+input.draft.slice(end),draftRev:input.draftRev+1,
          occurrences:[...occurrences,{...reference,occurrenceId,offset:start,length:reference.clipboardText.length}].sort((a,b)=>a.offset-b.offset) })
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
    workspaces: { list: workspaces },
    sessions: { scope: (id: string) => id === 'session-a' ? scope : undefined,
      retain: () => ({ binding, ready: Promise.resolve(binding), release }), binding: () => binding },
    conversation: { input: { for: () => facade } },
    inputTriggers: { registerSource: (value: InputTriggerSource) => { source = value; return disposeSource } },
    slots: { inject: (_name: string, install: () => () => void) => install(),
      register: (_entry: unknown, component: React.ComponentType<any>) => { Control = component; return disposeSlot } },
  }
  const getWorkflow = vi.fn(async (id: string) => {
    if(id===flow.id)return structuredClone(flow)
    if(id===other.id)return structuredClone(other)
    throw new Error('工作流不存在')
  })
  const openWorkflow = vi.fn()
  const bridge = createChatBridge(context as unknown as Context, {
    listWorkflows: async () => [flow, other], getWorkflow, openWorkflow,
  })
  bridges.push(bridge)
  let renderer!: ReactTestRenderer
  act(() => { renderer = create(React.createElement(Control, { sessionId: 'session-a',
    useInput: (select: (state: InputState) => unknown) => select(React.useSyncExternalStore(inputState.subscribe, inputState.getSnapshot)), inputActions: actions }),{createNodeMock:node=>node.type==='button'?{getBoundingClientRect:()=>options.controlRect??{left:10,right:110,top:600,bottom:628}}:null}); renderers.push(renderer) })
  return { flow, other, bridge, source, events, inbox, workspaces, getWorkflow, openWorkflow, release, renderer, actions,
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
  it('需求更新替换同一原生引用，保留邻接正文和其他引用，不往编辑框加入协议 JSON',async()=>{
    const f=setup()
    await f.bridge.insertWorkflow('session-a',f.flow)
    await f.bridge.insertGenerateRequest('session-a','原需求',f.flow)
    const previous=f.bridge.getGenerateRequest('session-a',f.flow.id)!,other=f.input().occurrences[0]!
    await f.bridge.insertGenerateRequest('session-a','更新后的\n完整需求',f.flow)
    expect(f.input().occurrences).toHaveLength(2)
    expect(f.input().occurrences[0]).toEqual(other)
    expect(f.input().draft).toContain('保留我已有的文字')
    expect(f.input().draft).not.toContain('原需求')
    expect(f.input().draft).not.toContain('visible_workflow_plan')
    expect(f.input().draft).not.toContain(f.flow.id)
    expect(f.bridge.getGenerateRequest('session-a',f.flow.id)).toMatchObject({id:previous.id,text:'更新后的\n完整需求',revision:2,status:'draft'})
    const payload=await f.source.codec!.serialize(f.input().occurrences[1]!.ref,new AbortController().signal)
    expect(payload).toContain(JSON.stringify('更新后的\n完整需求'))
    expect(payload).toContain(f.flow.id)
  })
  it('需求只有匹配版本的真人准入才消费，序列化、乐观清空和旧回执都保留当前草稿',async()=>{
    const f=setup()
    await f.bridge.insertGenerateRequest('session-a','第一次需求',f.flow)
    const old=await f.source.codec!.serialize(f.input().occurrences[0]!.ref,new AbortController().signal)
    await f.bridge.insertGenerateRequest('session-a','第二次需求',f.flow)
    act(()=>f.events.set({entries:[{type:'event',event:{type:'user/message',data:userMessage(old)}}]}))
    expect(f.bridge.getGenerateRequest('session-a',f.flow.id)?.text).toBe('第二次需求')
    const current=await f.source.codec!.serialize(f.input().occurrences[0]!.ref,new AbortController().signal)
    f.optimisticClear()
    expect(f.bridge.getGenerateRequest('session-a',f.flow.id)?.status).toBe('sending')
    expect(await f.bridge.insertGenerateRequest('session-a','发送中禁止改写',f.flow)).toBe(false)
    const request=JSON.parse(current.split('\n').find(line=>line.startsWith('规划请求：'))!.slice('规划请求：'.length))
    // A typed-edit result does not acknowledge the composer's human message.
    act(()=>f.events.set({entries:[{type:'event',event:{type:'tool/result',data:{name:'visible_workflow_edit',requestId:request.requestId,receipt:{kind:'proposed'},message:userMessage(current)}}}]}))
    expect(request).toMatchObject({operation:'revise',targetWorkflowId:f.flow.id,instruction:'第二次需求'})
    expect(current.indexOf('visible_workflow_edit')).toBeLessThan(current.indexOf('visible_workflow_plan'))
    expect(f.bridge.getGenerateRequest('session-a',f.flow.id)).toBeDefined()
    act(()=>f.inbox.set({'next-turn':[userMessage(current)],'next-step':[]}))
    expect(f.bridge.getGenerateRequest('session-a',f.flow.id)).toBeUndefined()
    await f.bridge.insertGenerateRequest('session-a','新一轮需求',f.flow)
    expect(f.bridge.getGenerateRequest('session-a',f.flow.id)).toMatchObject({text:'新一轮需求',revision:1})
  })
  it('需求插入CAS失败时不丢失原草稿，取消发送后可继续编辑',async()=>{
    const f=setup()
    await f.bridge.insertGenerateRequest('session-a','保留需求',f.flow)
    const before=f.input(),original=f.bridge.getGenerateRequest('session-a',f.flow.id)
    const capture=f.actions.captureInsertion
    f.actions.captureInsertion=()=>({...capture(),draftRev:-1})
    // New target insertion uses a captured revision, never a whole-composer setDraft.
    expect(await f.bridge.insertGenerateRequest('session-a','无法插入的新建需求')).toBe(false)
    expect(f.input()).toEqual(before)
    expect(f.bridge.getGenerateRequest('session-a',f.flow.id)).toEqual(original)
    const controller=new AbortController()
    await f.source.codec!.serialize(f.input().occurrences[0]!.ref,controller.signal)
    f.optimisticClear();controller.abort();f.restoreDraft(before)
    f.actions.captureInsertion=capture
    expect(await f.bridge.insertGenerateRequest('session-a','取消后继续改',f.flow)).toBe(true)
    expect(f.input().occurrences).toHaveLength(1)
  })
  it('全局流程可精确引用，本项目之外的私有流程与伪造范围不可引用',async()=>{
    const f=setup(),request={query:'',position:'inline' as const,drilled:false,signal:new AbortController().signal}
    f.other.scope='global';f.other.title=f.flow.title
    const candidates=await f.source.candidates({sessionId:'session-a' as never},request)
    expect(candidates.map(item=>item.name)).toEqual([f.flow.id,f.other.id])
    const candidate=candidates.find(item=>item.name===f.other.id)!
    const picked=f.source.onPick({session:{sessionId:'session-a'},candidate,action:'insert'} as never) as {insert:ReferenceInsert}
    expect(JSON.parse(picked.insert.ref)).toMatchObject({workflowId:f.other.id,workspaceId:f.other.workspaceId,sessionId:'session-a'})
    await f.bridge.insertWorkflow('session-a',f.other)
    f.other.scope='workspace'
    await expect(f.source.codec!.serialize(f.input().occurrences[0]!.ref,new AbortController().signal)).rejects.toThrow('当前工作区或全局范围')
    await expect(f.bridge.insertGenerateRequest('session-a','不能伪造全局',{...f.other,scope:'global'})).rejects.toThrow('复制到当前对话所属工作区')
  })
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
    expect(text).toContain('visible_workflow_get'); expect(text).toContain('visible_workflow_plan')
    expect(text.indexOf('visible_workflow_edit')).toBeLessThan(text.indexOf('visible_workflow_plan'))
    expect(text).toContain('handoff.mode=partial');expect(text).toContain('handoff.mode=module')
    // Routing changes cannot turn a tool proposal receipt into native message admission.
    act(()=>fixture.events.set({entries:[{type:'event',event:{type:'tool/result',data:{name:'visible_workflow_edit',requestId:json.requestId,receipt:{kind:'proposed'}}}}]}))
    expect(bridge.getAnnotations(flow.id)).toHaveLength(2)
    expect(text).not.toContain('visible_workflow_save')
    expect(json.requestId).toBe(tokenIn(text))
    expect(json.targetNodeIds).toEqual([flow.nodes[1]!.id, flow.nodes[2]!.id])
    expect(text.indexOf('visible_workflow_nodes')).toBeLessThan(text.indexOf('visible_workflow_get'))
    expect(text).toContain('当前读取版本使用 currentRevision')
    expect(text).toContain('不自动换目标、扩大范围或新建 requestId')
    expect(text).toContain('expectedRevision 使用刚读取的最新 revision')
    expect(text).toContain('完整保留 annotations 的每项 nodeIds 和 requirement')
    expect(bridge.getAnnotations(flow.id)).toHaveLength(2)
    act(() => fixture.inbox.set({ 'next-turn': [userMessage(text)], 'next-step': [] }))
    expect(bridge.getAnnotations(flow.id)).toEqual([])
  })
  it('修改引用节点仍保持注释身份和编号，发送载荷使用更新后的稳定 ID', async () => {
    const fixture = setup(), { flow, bridge, source } = fixture
    await act(async () => bridge.stageAnnotation('session-a', flow, [flow.nodes[1]!.id], '原始要求'))
    const original = bridge.getAnnotations(flow.id)[0]!
    await act(async () => bridge.stageAnnotation('session-a', flow, [flow.nodes[0]!.id, flow.nodes[2]!.id, flow.nodes[2]!.id], '改用这两个节点', original.id))
    const edited = bridge.getAnnotations(flow.id)[0]!
    expect(edited).toMatchObject({id:original.id,number:original.number,nodeIds:[flow.nodes[0]!.id,flow.nodes[2]!.id],text:'改用这两个节点'})
    const serialized = await source.codec!.serialize(fixture.input().occurrences[0]!.ref, new AbortController().signal)
    const payload = JSON.parse(serialized.split('\n').find(line => line.startsWith('{'))!)
    expect(payload.annotations[0]).toEqual({nodeIds:edited.nodeIds,requirement:edited.text})
    expect(fixture.input().draft).toContain('保留我已有的文字')
  })
  it('拒绝清空或引用无效节点，原注释和正文保持不变', async () => {
    const fixture=setup(), {flow,bridge}=fixture
    await act(async()=>bridge.stageAnnotation('session-a',flow,[flow.nodes[1]!.id],'保留原要求'))
    const original=bridge.getAnnotations(flow.id)[0]!,before=fixture.input().draft
    expect(()=>bridge.editAnnotation('session-a',original.id,'无效要求',[])).toThrow('至少一个有效节点')
    expect(()=>bridge.editAnnotation('session-a',original.id,'无效要求',['unknown-node'])).toThrow('至少一个有效节点')
    expect(bridge.getAnnotations(flow.id)[0]).toEqual(original)
    expect(fixture.input().draft).toBe(before)
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
    expect(fixture.input().draft).not.toContain('visible_workflow_plan')
    const createDraft=await fixture.source.codec!.serialize(fixture.input().occurrences[0]!.ref,new AbortController().signal)
    expect(createDraft).toContain('等待真人回答后');expect(createDraft).not.toContain('预算')
    const identity = JSON.parse(createDraft.split('\n').find(line => line.startsWith('新工作流身份：'))!.slice('新工作流身份：'.length))
    expect(identity).toMatchObject({ workspaceId: fixture.flow.workspaceId })
    expect(identity.workflowId).not.toBe(fixture.flow.id)
    const createRequest = JSON.parse(createDraft.split('\n').find(line => line.startsWith('规划请求：'))!.slice('规划请求：'.length))
    expect(createRequest).toMatchObject({ operation: 'create', instruction: '整理会议纪要', targetWorkflowId: identity.workflowId, expectedRevision: 0 })
    expect(createRequest.requestId).toBe(createDraft.split('\n').find(line => line.startsWith('visible-workflow-generation-admission:'))!.slice('visible-workflow-generation-admission:'.length))
    expect(createDraft).not.toContain('visible_workflow_save')
    expect(createDraft).toContain('visible_workflow_plan_answer')
    fixture.optimisticClear()
    expect(await fixture.bridge.insertGenerateRequest('session-a', '增加检查步骤', fixture.flow)).toBe(true)
    const editDraft = await fixture.source.codec!.serialize(fixture.input().occurrences[0]!.ref,new AbortController().signal)
    expect(fixture.input().draft).toContain(`@${fixture.flow.title}`)
    expect(fixture.input().draft).not.toContain(fixture.flow.id)
    expect(editDraft).toContain('请修改已有工作流')
    expect(editDraft).toContain(`"workflowId":"${fixture.flow.id}"`)
    expect(editDraft).toContain('visible_workflow_get')
    const editRequest = JSON.parse(editDraft.split('\n').find(line => line.startsWith('规划请求：'))!.slice('规划请求：'.length))
    expect(editRequest).toMatchObject({ operation: 'revise', instruction: '增加检查步骤', targetWorkflowId: fixture.flow.id })
    expect(editRequest.requestId).toBeTruthy()
    expect(editRequest).not.toHaveProperty('expectedRevision')
    expect(editDraft).toContain('此需求草稿没有当前 revision 时，可先用 visible_workflow_get')
    expect(editDraft).toContain('最新 revision 填入规划请求的 expectedRevision')
    expect(editDraft).toContain('visible_workflow_plan')
    expect(editDraft.indexOf('visible_workflow_edit')).toBeLessThan(editDraft.indexOf('visible_workflow_plan'))
    expect(editDraft).toContain('request_id 使用原规划 requestId')
    expect(editDraft).toContain('target_node_ids 保留原明确 targetNodeIds')
    expect(editDraft).not.toContain('visible_workflow_save')
    expect(editDraft).not.toContain('请生成一个工作流')
    expect(editDraft).toContain('generation-admission:')
    await expect(fixture.bridge.insertGenerateRequest('session-a', '修改其他流程', fixture.other)).rejects.toThrow('复制到当前对话所属工作区')
  })
  it('规划请求完整保留多行、引号及长需求，不让主对话再生成图 JSON', async () => {
    const fixture = setup(), requirement = `第一步：读取提供的资料\n第二步：保留字段 "金额" 与 "期间"\n${'不得省略这个检查要求。'.repeat(300)}\n最后输出 JSON 和摘要`
    expect(await fixture.bridge.insertGenerateRequest('session-a', requirement)).toBe(true)
    const serialized=await fixture.source.codec!.serialize(fixture.input().occurrences[0]!.ref,new AbortController().signal)
    const request = JSON.parse(serialized.split('\n').find(line => line.startsWith('规划请求：'))!.slice('规划请求：'.length))
    expect(request.instruction).toBe(requirement)
    expect(serialized).toContain('不自行设计完整 JSON 或调用保存工具')
    expect(fixture.openWorkflow).not.toHaveBeenCalled()
  })
  it('交给 Agent 的优化请求保留问题和待接受提案闭环且不发起预算选择',async()=>{
    const f=setup();await f.bridge.insertGenerateRequest('session-a','帮我优化这个 workflow',f.flow)
    const text=await f.source.codec!.serialize(f.input().occurrences[0]!.ref,new AbortController().signal)
    const request=JSON.parse(text.split('\n').find(line=>line.startsWith('规划请求：'))!.slice('规划请求：'.length))
    expect(request).toMatchObject({operation:'revise',targetWorkflowId:f.flow.id,instruction:'帮我优化这个 workflow'})
    expect(request).not.toHaveProperty('targetNodeIds')
    expect(text).toContain('visible_workflow_plan_answer');expect(text).toContain('visible_workflow_plan_get')
    expect(text).toContain('receipt.kind=proposed');expect(text).toContain('不自动接受提案或执行流程')
    expect(text).not.toContain('预算');expect(text).not.toContain('额度')
    expect(text).not.toContain('预算选择持久绑定此工作流')
  })
  it('等待目标读取时工作区变化，不把旧需求写进新工作区的草稿',async()=>{
    const f=setup();let release!:(value:typeof f.flow)=>void
    f.getWorkflow.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
    const pending=f.bridge.insertGenerateRequest('session-a','优化原工作区流程',f.flow)
    await Promise.resolve()
    f.workspaces.set({items:[{workspaceId:'workspace-b',sessionIds:['session-a']}]})
    release(structuredClone(f.flow))
    await expect(pending).rejects.toThrow('当前对话或工作区已变化')
    expect(f.input().occurrences).toHaveLength(0)
  })
  it('发送时目标读取期间工作区变化，不序列化陈旧的规划请求',async()=>{
    const f=setup();await f.bridge.insertGenerateRequest('session-a','优化原工作区流程',f.flow)
    let release!:(value:typeof f.flow)=>void
    f.getWorkflow.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
    const pending=f.source.codec!.serialize(f.input().occurrences[0]!.ref,new AbortController().signal)
    f.workspaces.set({items:[{workspaceId:'workspace-b',sessionIds:['session-a']}]})
    release(structuredClone(f.flow))
    await expect(pending).rejects.toThrow('当前对话的工作区已变化')
    expect(f.bridge.getGenerateRequest('session-a',f.flow.id)?.status).toBe('draft')
  })
  it('普通工作流引用保留执行入口，明确编辑时使用独立规划请求和最新版本', async () => {
    const fixture = setup()
    await fixture.bridge.insertWorkflow('session-a', fixture.flow)
    const text = await fixture.source.codec!.serialize(fixture.input().occurrences[0]!.ref, new AbortController().signal)
    const payload = JSON.parse(text.split('\n').find(line => line.startsWith('{'))!)
    expect(payload).toMatchObject({ workflowId: fixture.flow.id, revision: fixture.flow.revision })
    expect(text.indexOf('visible_workflow_nodes')).toBeLessThan(text.indexOf('visible_workflow_get'))
    expect(text).not.toContain('请先用 visible_workflow_get 读取最新定义。')
    expect(payload.requestId).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(text).toContain('visible_workflow_run')
    expect(text).toContain('visible_workflow_plan')
    expect(text.indexOf('visible_workflow_edit')).toBeLessThan(text.indexOf('visible_workflow_plan'))
    expect(text).toContain('画布引用或标记只用于定位，不能作为独立授权')
    expect(text).toContain('本回合必须用 visible_workflow_plan_wait 对同一 taskId 事件等待并核验')
    expect(text).toContain('不能在子任务未结束时提前 final')
    expect(text).toContain('waiting 须继续同任务等待，不能当作成功')
    expect(text).toContain('核对完整候选才用 visible_workflow_plan_get')
    expect(text).not.toContain('仅需要实际结果时用 visible_workflow_plan_get')
    expect(text).not.toContain('queued/authoring/validating/repairing 时用')
    expect(text).toContain('expectedRevision 使用刚读取的最新 revision')
    expect(text).toContain('帮我优化这个 workflow')
    expect(text).toContain('只有用户明确要求执行流程时才使用 visible_workflow_run')
    expect(text).toContain('visible_workflow_plan_answer')
    expect(text).not.toContain('visible_workflow_save')
    expect(text).not.toContain('generation-admission:')
  })
  it('只跟踪准入成功的新建请求，精确目标保存后才打开侧栏', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    await fixture.bridge.insertGenerateRequest('session-a', '生成一个摘要流程')
    const draft=await fixture.source.codec!.serialize(fixture.input().occurrences[0]!.ref,new AbortController().signal)
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
    await Promise.resolve()
    expect(fixture.openWorkflow).toHaveBeenCalledExactlyOnceWith(fixture.flow.id, 'session-a', 'reference')
    fixture.openWorkflow.mockClear()
    expect(fixture.source.openReference!({ sessionId: 'unknown' as never }, ref)).toBe(false)
    expect(fixture.source.openReference!({ sessionId: 'session-a' as never }, { ...ref, ref: 'not-json' })).toBe(false)
    const crossWorkspace = { ...ref, ref: JSON.stringify({ ...JSON.parse(ref.ref), workspaceId: fixture.other.workspaceId }) }
    expect(fixture.source.openReference!({ sessionId: 'session-a' as never }, crossWorkspace)).toBe(false)
    expect(fixture.openWorkflow).not.toHaveBeenCalled()
  })
  it('每条注释按自己的画布层级提供候选，旧版无坐标注释按首个引用定位，编号仅显示本层',async()=>{
    const flow=makeWorkflow('workspace-a','多层流程',true),container=flow.nodes[1]!
    const inner={...structuredClone(container),id:'scope-inner',number:'a-2:a-1',title:'当前元素'}
    const deep={...structuredClone(container),id:'scope-deep',number:'a-2:a-2:a-1',title:'深层元素'}
    const nested={...structuredClone(container),id:'scope-nested',number:'a-2:a-2',title:'内层循环',config:{body:{nodes:[deep],edges:[]}}}
    container.kind='iteration';container.config={body:{nodes:[inner,nested],edges:[]}}
    const fixture=setup({flow})
    await act(async()=>{
      await fixture.bridge.stageAnnotation('session-a',flow,[container.id],'父层',undefined,{x:1,y:2,scopePath:[]})
      await fixture.bridge.stageAnnotation('session-a',flow,[inner.id],'子层',undefined,{x:3,y:4,scopePath:[container.id]})
      await fixture.bridge.stageAnnotation('session-a',flow,[deep.id],'旧版深层')
    })
    const props=fixture.renderer.root.findByType('annotation-editor-mock' as never).props,items=props.annotations
    expect(props.availableNodes(items[0]).map((item:{id:string})=>item.id)).toEqual(flow.nodes.map(node=>node.id))
    expect(props.availableNodes(items[1]).map((item:{id:string})=>item.id)).toEqual([inner.id,nested.id])
    expect(props.availableNodes(items[2]).map((item:{id:string})=>item.id)).toEqual([deep.id])
    expect(items[1].nodes[0]).toMatchObject({id:inner.id,number:'a-1',ancestorIds:[container.id]})
    expect(items[2].nodes[0]).toMatchObject({id:deep.id,number:'a-1',ancestorIds:[container.id,nested.id]})
    expect(fixture.bridge.getAnnotations(flow.id)[2]!.position).toBeUndefined()
  })
  it('已失效的注释层级不回退到父流程候选，历史稳定引用仍保留',async()=>{
    const fixture=setup()
    await act(async()=>fixture.bridge.stageAnnotation('session-a',fixture.flow,[fixture.flow.nodes[1]!.id],'保留历史引用',undefined,{x:1,y:2,scopePath:['removed-container']}))
    const props=fixture.renderer.root.findByType('annotation-editor-mock' as never).props,item=props.annotations[0]
    expect(props.availableNodes(item)).toEqual([])
    expect(item.nodes[0]).toMatchObject({id:fixture.flow.nodes[1]!.id,number:fixture.flow.nodes[1]!.number})
    expect(fixture.bridge.getAnnotations(fixture.flow.id)[0]!.nodeIds).toEqual([fixture.flow.nodes[1]!.id])
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

describe('注释世界坐标与聊天编辑锚点',()=>{
  const marker:AnnotationPosition={x:-137.5,y:248.25,scopePath:['iteration','loop']}
  const draftKey='dsh.visibleWorkflows.annotationDrafts.v1'
  const countButton=(fixture:ReturnType<typeof setup>)=>fixture.renderer.root.findAllByType('button').find(button=>button.props.title==='查看和修改节点注释')!
  const editor=(fixture:ReturnType<typeof setup>)=>fixture.renderer.root.findByType('annotation-editor-mock' as never)
  it('一条注释只有一个点，stage与get均深拷贝，编辑文字或节点不丢位置且不发给Agent',async()=>{
    const fixture=setup(),position=structuredClone(marker)
    await act(async()=>fixture.bridge.stageAnnotation('session-a',fixture.flow,fixture.flow.nodes.map(node=>node.id),'多节点共享一点',undefined,position))
    position.x=999;position.scopePath.push('external-change')
    const staged=fixture.bridge.getAnnotations(fixture.flow.id)[0]!
    expect(staged.position).toEqual(marker)
    staged.position!.y=999;staged.position!.scopePath.push('read-change')
    expect(fixture.bridge.getAnnotations(fixture.flow.id)[0]!.position).toEqual(marker)
    act(()=>fixture.bridge.editAnnotation('session-a',staged.id,'修改正文'))
    await act(async()=>fixture.bridge.stageAnnotation('session-a',fixture.flow,[fixture.flow.nodes[2]!.id],'修改引用',staged.id))
    expect(fixture.bridge.getAnnotations(fixture.flow.id)[0]!.position).toEqual(marker)
    const text=await fixture.source.codec!.serialize(fixture.input().occurrences[0]!.ref,new AbortController().signal)
    const payload=JSON.parse(text.split('\n').find(line=>line.startsWith('{'))!)
    expect(payload.annotations[0]).toEqual({nodeIds:[fixture.flow.nodes[2]!.id],requirement:'修改引用'})
    expect(text).not.toContain('scopePath');expect(text).not.toContain('"position"')
  })
  it('显式保存新点位会更新同一注释，重载恢复相同world坐标与scopePath',async()=>{
    const first=setup()
    await act(async()=>first.bridge.stageAnnotation('session-a',first.flow,[first.flow.nodes[1]!.id],'先放置',undefined,marker))
    const note=first.bridge.getAnnotations(first.flow.id)[0]!,next={x:401,y:-99,scopePath:[]}
    await act(async()=>first.bridge.stageAnnotation('session-a',first.flow,note.nodeIds,'同一条移动后',note.id,next))
    const saved=first.bridge.getAnnotations(first.flow.id)[0]!
    expect(saved.id).toBe(note.id);expect(saved.position).toEqual(next)
    first.bridge.dispose()
    const restored=setup({flow:first.flow,input:first.input()})
    expect(restored.bridge.getAnnotations(first.flow.id)[0]).toEqual(saved)
    const copy=restored.bridge.getAnnotations(first.flow.id)[0]!
    copy.position!.scopePath.push('mutated-after-reload')
    expect(restored.bridge.getAnnotations(first.flow.id)[0]!.position).toEqual(next)
  })
  it.each([{x:Infinity,y:0,scopePath:[]},{x:0,y:NaN,scopePath:[]},{x:0,y:0,scopePath:[1]},{x:0,y:0,scopePath:new Array(1)},{x:'0',y:0,scopePath:[]},null])('拒绝stage坏坐标，不生成引用或破坏既有草稿 %s',async position=>{
    const fixture=setup(),before=fixture.input()
    await expect(fixture.bridge.stageAnnotation('session-a',fixture.flow,[fixture.flow.nodes[1]!.id],'无效位置',undefined,position as unknown as AnnotationPosition)).rejects.toThrow('注释位置无效')
    expect(fixture.input()).toBe(before);expect(fixture.bridge.getAnnotations(fixture.flow.id)).toEqual([])
  })
  it('恢复旧版无位置草稿和坏位置时保留注释，只丢弃损坏的可选位置',async()=>{
    const first=setup()
    await act(async()=>{
      await first.bridge.stageAnnotation('session-a',first.flow,[first.flow.nodes[1]!.id],'旧版没有位置')
      await first.bridge.stageAnnotation('session-a',first.flow,[first.flow.nodes[2]!.id],'坏位置仍保留正文',undefined,marker)
    })
    const saved=JSON.parse(sessionStorage.getItem(draftKey)!)
    saved.batches[0].annotations[1].position={x:0,y:null,scopePath:['loop']}
    sessionStorage.setItem(draftKey,JSON.stringify(saved));first.bridge.dispose()
    const restored=setup({flow:first.flow,input:first.input()}),notes=restored.bridge.getAnnotations(first.flow.id)
    expect(notes.map(note=>note.text)).toEqual(['旧版没有位置','坏位置仍保留正文'])
    expect(notes.every(note=>note.position===undefined)).toBe(true)
  })
  it('聊天入口优先当前workflow对应可见pin，切换注释重找锚点且不自动导航；没有pin回退聊天按钮',async()=>{
    const fallback={left:10,right:110,top:600,bottom:628},fixture=setup({controlRect:fallback})
    await act(async()=>{
      await fixture.bridge.stageAnnotation('session-a',fixture.flow,[fixture.flow.nodes[1]!.id],'第一条',undefined,marker)
      await fixture.bridge.stageAnnotation('session-a',fixture.flow,[fixture.flow.nodes[2]!.id],'第二条',undefined,{...marker,x:300})
    })
    const notes=fixture.bridge.getAnnotations(fixture.flow.id),firstRect={left:320,right:344,top:220,bottom:244},secondRect={left:480,right:504,top:330,bottom:354}
    const pin=(annotationId:string,workflowId:string,rect:typeof firstRect)=>({getAttribute:(key:string)=>key==='data-annotation-id'?annotationId:workflowId,getBoundingClientRect:()=>rect})
    let pins=[pin(notes[0]!.id,'other-workflow',secondRect),pin(notes[0]!.id,fixture.flow.id,firstRect),pin(notes[1]!.id,fixture.flow.id,secondRect)]
    vi.stubGlobal('document',{querySelectorAll:()=>pins})
    await act(async()=>countButton(fixture).props.onClick())
    expect(editor(fixture).props.anchorRect).toEqual(firstRect)
    act(()=>editor(fixture).props.onSelectedChange(notes[1]!.id))
    expect(editor(fixture).props.anchorRect).toEqual(secondRect)
    pins=[]
    act(()=>editor(fixture).props.onSelectedChange(notes[0]!.id))
    expect(editor(fixture).props.anchorRect).toEqual(fallback)
    expect(fixture.openWorkflow).not.toHaveBeenCalled()
  })
})
