import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionInput, ReferenceInsert, InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { NodeGraph, Workflow } from '../shared/types.ts'
import { AnnotationEditor } from './annotation-editor.tsx'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { visibleWorkflows: unknown }
}

const SOURCE = 'visible-workflows'
const DRAFT_KEY = 'dsh.visibleWorkflows.annotationDrafts.v1'
const RECEIPT_PREFIX = 'visible-workflow-annotation-admission:'
const GENERATION_RECEIPT_PREFIX = 'visible-workflow-generation-admission:'

export interface WorkflowAnnotation {
  id: string
  number: number
  sessionId: string
  workflowId: string
  nodeIds: string[]
  text: string
}

interface AnnotationBatch {
  id: string
  sessionId: string
  workflowId: string
  workspaceId: string
  workflowTitle: string
  graphRevision: number
  revision: number
  annotations: WorkflowAnnotation[]
}

interface AnnotationFlight { revision: number; token: string; removedFromInput: boolean }

function nodeIdsIn(graph: NodeGraph): Set<string> {
  return new Set(graph.nodes.flatMap(node => [node.id, ...(node.config.body ? nodeIdsIn(node.config.body) : [])]))
}

interface GenerationRequest {
  sessionId: string
  workspaceId: string
  workflowId: string
  acceptedAt?: number
}

export type WorkflowEditTarget = Pick<Workflow, 'id' | 'workspaceId' | 'title'>

interface ReferenceValue {
  version: 1
  kind: 'workflow' | 'annotations'
  workflowId: string
  workspaceId: string
  sessionId: string
  title: string
  batchId?: string
}

export interface ChatBridgeOptions {
  listWorkflows(): Promise<Workflow[]>
  getWorkflow(id: string): Promise<Workflow>
  openWorkflow(id: string, sessionId: string, reason: 'reference'|'generated'): void
}

export interface ChatBridge {
  stageAnnotation(sessionId: string, workflow: Workflow, nodeIds: string[], text: string, annotationId?: string): Promise<void>
  editAnnotation(sessionId: string, annotationId: string, text: string): void
  deleteAnnotation(sessionId: string, annotationId: string): Promise<void>
  insertWorkflow(sessionId: string, workflow: Workflow): Promise<void>
  insertGenerateRequest(sessionId: string, text: string, workflow?: WorkflowEditTarget): Promise<boolean>
  getAnnotations(workflowId: string, sessionId?: string): readonly WorkflowAnnotation[]
  subscribe(listener: () => void): () => void
  dispose(): void
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** Only Host-accepted human messages count, never tool results or local echoes. */
export function acceptedAnnotationTokens(value: unknown, expectedTokens: ReadonlySet<string>): string[] {
  return acceptedMessageTokens(value, expectedTokens, RECEIPT_PREFIX)
}

function acceptedMessageTokens(value: unknown, expectedTokens: ReadonlySet<string>, prefix: string): string[] {
  const result = new Set<string>()
  const acceptMessage = (raw: unknown) => {
    const message = record(raw), source = record(message?.source)
    if (message?.role !== 'user' || source?.kind !== 'user' || typeof source.rpcId !== 'string') return
    if (!Array.isArray(message.content)) return
    for (const block of message.content) {
      const item = record(block)
      if (item?.type !== 'text' || typeof item.text !== 'string') continue
      // Receipts are opaque random IDs, surrounded by a unique line delimiter.
      for (const token of expectedTokens) {
        if (item.text.split('\n').includes(`${prefix}${token}`)) result.add(token)
      }
    }
  }
  const input = record(value)
  if (input?.type === 'user/message') acceptMessage(input.data)
  else if (input && (Array.isArray(input['next-turn']) || Array.isArray(input['next-step']))) {
    for (const key of ['next-turn', 'next-step']) {
      if (Array.isArray(input[key])) for (const item of input[key]) acceptMessage(item)
    }
  }
  return [...result]
}

function encodeReference(value: ReferenceValue): string { return JSON.stringify(value) }

function decodeReference(value: string): ReferenceValue {
  const parsed = record(JSON.parse(value))
  if (!parsed || parsed.version !== 1 || !['workflow', 'annotations'].includes(String(parsed.kind)) ||
    !['workflowId', 'workspaceId', 'sessionId', 'title'].every(key => typeof parsed[key] === 'string') ||
    (parsed.kind === 'annotations' && typeof parsed.batchId !== 'string')) throw new Error('工作流引用已失效，请重新添加。')
  return parsed as unknown as ReferenceValue
}

function reference(value: ReferenceValue): ReferenceInsert {
  return {
    source: SOURCE, ref: encodeReference(value),
    label: value.kind === 'annotations' ? '工作流注释' : value.title,
    appearance: 'file',
    clipboardText: value.kind === 'annotations' ? `[工作流注释：${value.title}]` : `@${value.title}`,
  }
}

/** Native composer extension; it never dispatches an Agent until the user presses Send. */
export function createChatBridge(ctx: Context, options: ChatBridgeOptions): ChatBridge {
  let batches: AnnotationBatch[] = []
  let version = 0
  let disposed = false
  const listeners = new Set<() => void>()
  const subscriptions = new Map<string, { reference: SessionReference; dispose: () => void }>()
  const receipts = new Map<string, { batchId: string; revision: number }>()
  const generations = new Map<string, GenerationRequest>()
  // Visibility during a detached native submission is distinct from retiring a batch.
  const annotationFlights = new Map<string, AnnotationFlight>()
  const inputSignatures = new Map<string, string>()
  const generationTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const inputActions = new Map<string, InputActions>()
  const workflowCache = new Map<string, Workflow>()
  const inputWaiters = new Map<string, Set<(actions: InputActions) => void>>()
  const disposers: (() => void)[] = []
  let showEditor: (sessionId: string, batchId?: string) => void = () => {}

  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? '[]')
    const stored = record(saved)
    const savedBatches = Array.isArray(saved) ? saved : stored?.batches
    if (Array.isArray(savedBatches)) batches = savedBatches.filter((value): value is AnnotationBatch => {
      const item = record(value)
      return !!item && typeof item.id === 'string' && typeof item.sessionId === 'string' &&
        typeof item.workflowId === 'string' && typeof item.workspaceId === 'string' &&
        typeof item.revision === 'number' && Array.isArray(item.annotations) &&
        item.annotations.every(a => {
          const note = record(a)
          return !!note && typeof note.id === 'string' && typeof note.text === 'string' &&
            typeof note.number === 'number' && Array.isArray(note.nodeIds) &&
            note.nodeIds.every(id => typeof id === 'string')
        })
    })
    if (Array.isArray(stored?.receipts)) for (const entry of stored.receipts) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
      const receipt = record(entry[1])
      if (receipt && typeof receipt.batchId === 'string' && typeof receipt.revision === 'number' &&
        batches.some(batch => batch.id === receipt.batchId)) {
        receipts.set(entry[0], { batchId: receipt.batchId, revision: receipt.revision })
      }
    }
    if (Array.isArray(stored?.flights)) for (const entry of stored.flights) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
      const flight = record(entry[1])
      if (flight && typeof flight.token === 'string' && typeof flight.revision === 'number' && typeof flight.removedFromInput === 'boolean' &&
        receipts.get(flight.token)?.batchId === entry[0]) annotationFlights.set(entry[0], flight as unknown as AnnotationFlight)
    }
    if (Array.isArray(stored?.generations)) for (const entry of stored.generations) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
      const request = record(entry[1])
      if (request && ['sessionId', 'workspaceId', 'workflowId'].every(key => typeof request[key] === 'string') &&
        (request.acceptedAt === undefined || typeof request.acceptedAt === 'number')) {
        generations.set(entry[0], request as unknown as GenerationRequest)
      }
    }
  } catch { /* An unavailable browser draft store does not mutate the user's composer. */ }

  const notify = () => {
    version++
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ batches, receipts: [...receipts], generations: [...generations], flights: [...annotationFlights] })) } catch { /* Runtime drafts remain usable. */ }
    for (const listener of listeners) listener()
  }
  const workspaceFor = (sessionId: string): string | undefined =>
    ctx.workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(sessionId as SessionId))?.workspaceId

  const inputFor = (sessionId: string): SessionInput => {
    const scope = ctx.sessions.scope(sessionId as SessionId)
    if (!scope) throw new Error('请先打开一个对话，再添加工作流引用。')
    return ctx.conversation.input.for(scope)
  }

  const actionsFor = async (sessionId: string): Promise<InputActions> => {
    const current = inputActions.get(sessionId)
    if (current) return current
    return new Promise((resolve, reject) => {
      const waiters = inputWaiters.get(sessionId) ?? new Set<(actions: InputActions) => void>()
      inputWaiters.set(sessionId, waiters)
      const finish = (actions: InputActions) => { clearTimeout(timeout); waiters.delete(finish); resolve(actions) }
      const timeout = setTimeout(() => { waiters.delete(finish); reject(new Error('请打开当前对话的输入框，再提交注释。')) }, 1500)
      waiters.add(finish)
    })
  }

  const assertWorkspace = (sessionId: string, workspaceId: string) => {
    const actual = workspaceFor(sessionId)
    if (!actual) throw new Error('当前对话的工作区还未加载，请稍后重试。')
    if (actual !== workspaceId) throw new Error('请先将工作流复制到当前对话所属工作区。')
  }

  // The generated ID belongs to this exact accepted request. Watching arbitrary
  // newly-created workflows would open unrelated work from another conversation.
  const watchGeneration = (token: string) => {
    const request = generations.get(token)
    if (disposed || request?.acceptedAt === undefined || generationTimers.has(token)) return
    if (Date.now() - request.acceptedAt > 10 * 60_000) {
      generations.delete(token); notify(); return
    }
    generationTimers.set(token, setTimeout(async () => {
      generationTimers.delete(token)
      if (disposed || !generations.has(token)) return
      try {
        const flow = await options.getWorkflow(request.workflowId)
        if (disposed || !generations.has(token)) return
        if (flow.id !== request.workflowId || flow.workspaceId !== request.workspaceId) {
          generations.delete(token); notify(); return
        }
        // Never steal a different conversation's canvas while the Agent finishes.
        if (workspaceFor(request.sessionId) === request.workspaceId) {
          generations.delete(token); notify(); options.openWorkflow(flow.id, request.sessionId, 'generated'); return
        }
      } catch { /* A draft does not exist until the Agent saves it. */ }
      watchGeneration(token)
    }, 1500))
  }

  const ensureSubscription = (sessionId: string) => {
    if (subscriptions.has(sessionId)) return
    const retained = ctx.sessions.retain(sessionId as SessionId, { source: 'visibleWorkflows' })
    const binding = retained.binding
    const inbox = binding.session.projections.faceOf('inbox')
    const observe = (value: unknown) => {
      if (disposed) return
      const tokens = acceptedAnnotationTokens(value, new Set(receipts.keys()))
      let changed = false
      for (const token of tokens) {
        const receipt = receipts.get(token)
        if (!receipt) continue
        if (!batches.some(batch => batch.id === receipt.batchId && batch.sessionId === sessionId)) continue
        // A late receipt may only retire the exact serialized revision and session.
        const index = batches.findIndex(batch => batch.id === receipt.batchId &&
          batch.sessionId === sessionId && batch.revision === receipt.revision)
        if (index >= 0) {
          batches.splice(index, 1); annotationFlights.delete(receipt.batchId); changed = true
          for (const [otherToken, otherReceipt] of receipts) if (otherReceipt.batchId === receipt.batchId) receipts.delete(otherToken)
        }
        receipts.delete(token)
      }
      for (const token of acceptedMessageTokens(value, new Set(generations.keys()), GENERATION_RECEIPT_PREFIX)) {
        const request = generations.get(token)
        if (!request || request.sessionId !== sessionId) continue
        if (request.acceptedAt === undefined) { request.acceptedAt = Date.now(); changed = true }
        watchGeneration(token)
      }
      if (changed) notify()
    }
    const observeEvents = () => {
      for (const entry of binding.eventSource.getSnapshot().entries) {
        if (entry.type === 'event') observe(entry.event)
      }
    }
    const offEvents = binding.eventSource.subscribe(observeEvents)
    const offInbox = inbox.subscribe(() => observe(inbox.getSnapshot()))
    const input = inputFor(sessionId)
    const observeInput = () => {
      if (disposed) return
      const state = input.state.getSnapshot()
      const visibleIds = new Set<string>()
      for (const occurrence of state.occurrences) {
        if (occurrence.source !== SOURCE) continue
        try { const value = decodeReference(occurrence.ref); if (value.kind === 'annotations' && value.sessionId === sessionId && value.batchId) visibleIds.add(value.batchId) } catch {}
      }
      let changed = false
      for (const batch of batches.filter(item => item.sessionId === sessionId)) {
        const flight = annotationFlights.get(batch.id)
        if (!flight) continue
        if (flight.revision !== batch.revision || (visibleIds.has(batch.id) && flight.removedFromInput)) {
          annotationFlights.delete(batch.id); changed = true
        } else if (!visibleIds.has(batch.id) && !flight.removedFromInput) {
          flight.removedFromInput = true; changed = true
        }
      }
      const signature = JSON.stringify([state.phase, [...visibleIds].sort()])
      if (inputSignatures.get(sessionId) !== signature) { inputSignatures.set(sessionId, signature); changed = true }
      if (changed) notify()
    }
    const offInput = input.state.subscribe(observeInput)
    subscriptions.set(sessionId, { reference: retained, dispose: () => { offEvents(); offInbox(); offInput(); inputSignatures.delete(sessionId); retained.release() } })
    observeInput()
    // Attach before readiness, so acceptance cannot race opening the history window.
    void retained.ready.then(() => { observeEvents(); observe(inbox.getSnapshot()) }).catch(() => {})
  }

  const insert = async (sessionId: string, value: ReferenceValue): Promise<boolean> => {
    const actions = await actionsFor(sessionId)
    if (disposed) throw new Error('工作流插件已关闭。')
    const input = inputFor(sessionId), state = input.state.getSnapshot()
    if (state.phase !== 'plain') return false
    // Use the editor's public detect-coordinate snapshot, not clipboard-text length.
    const captured = actions.captureInsertion()
    const scope = ctx.sessions.scope(sessionId as SessionId)!
    const result = scope.bail(scope, 'slash/input-insert-reference', {
      reference: reference(value), span: { ...captured, start: captured.end },
    })
    if (result) input.focus()
    return result === true
  }

  const hasBatchReference = (batch: AnnotationBatch): boolean => {
    try {
      return inputFor(batch.sessionId).state.getSnapshot().occurrences.some(occurrence => {
        if (occurrence.source !== SOURCE) return false
        try { const value = decodeReference(occurrence.ref); return value.kind === 'annotations' && value.batchId === batch.id && value.sessionId === batch.sessionId && value.workflowId === batch.workflowId } catch { return false }
      })
    } catch { return false }
  }

  const isVisible = (batch: AnnotationBatch): boolean => hasBatchReference(batch) || annotationFlights.get(batch.id)?.revision === batch.revision

  const editAnnotation = (sessionId: string, id: string, text: string) => {
    const batch = batches.find(item => item.sessionId === sessionId && item.annotations.some(note => note.id === id))
    if (!batch || !hasBatchReference(batch)) throw new Error('这条注释已经提交或移出草稿，请重新添加。')
    if (!text.trim()) throw new Error('请填写修改要求。')
    batch.annotations = batch.annotations.map(note => note.id === id ? { ...note, text: text.trim() } : note)
    batch.revision++
    annotationFlights.delete(batch.id)
    notify()
  }

  const deleteAnnotation = async (sessionId: string, id: string) => {
    const batch = batches.find(item => item.sessionId === sessionId && item.annotations.some(note => note.id === id))
    if (!batch || !hasBatchReference(batch)) throw new Error('这条注释已经提交或移出草稿，请重新添加。')
    if (inputFor(sessionId).state.getSnapshot().phase !== 'plain') throw new Error('聊天草稿正在提交，请稍后再删除注释。')
    if (batch.annotations.length > 1) {
      batch.annotations = batch.annotations.filter(note => note.id !== id)
      batch.revision++; annotationFlights.delete(batch.id); notify(); return
    }
    const actions = await actionsFor(sessionId)
    if (disposed) throw new Error('工作流插件已关闭。')
    if (!batches.includes(batch) || !batch.annotations.some(note => note.id === id) || !hasBatchReference(batch)) {
      throw new Error('这条注释已经提交或移出草稿，请重新添加。')
    }
    if (inputFor(sessionId).state.getSnapshot().phase !== 'plain') throw new Error('聊天草稿正在提交，请稍后再删除注释。')
    if (batch.annotations.length > 1) {
      batch.annotations = batch.annotations.filter(note => note.id !== id)
      batch.revision++; annotationFlights.delete(batch.id); notify(); return
    }
    // A chip occupies one detect character, while the public draft expands it
    // into clipboard text. Remove precisely that character, with revision CAS.
    // Never setDraft: doing so would flatten unrelated native references.
    const input = inputFor(sessionId)
    for (;;) {
      const state = input.state.getSnapshot()
      if (state.phase !== 'plain') throw new Error('聊天草稿正在提交，请稍后再删除注释。')
      let delta = 0
      let target: { start: number; occurrenceId: number } | undefined
      for (const occurrence of state.occurrences) {
        if (occurrence.source === SOURCE) {
          try {
            const value = decodeReference(occurrence.ref)
            if (value.kind === 'annotations' && value.batchId === batch.id && value.sessionId === sessionId && value.workflowId === batch.workflowId) {
              target = { start: occurrence.offset - delta, occurrenceId: occurrence.occurrenceId }; break
            }
          } catch { /* A malformed reference belongs to its own editor validation. */ }
        }
        delta += occurrence.length - 1
      }
      if (!target) break
      if (!actions.insertText('', { start: target.start, end: target.start + 1, draftRev: state.draftRev })) {
        throw new Error('聊天草稿已变化，未删除注释，请重试。')
      }
      if (input.state.getSnapshot().occurrences.some(item => item.occurrenceId === target.occurrenceId)) {
        throw new Error('注释引用尚未移除，请稍后重试。')
      }
    }
    // Retain hidden data for the native editor's Undo. Retire neither an older
    // in-flight revision nor another batch; Host admission still owns retirement.
    batch.revision++; annotationFlights.delete(batch.id); notify()
  }

  const source: InputTriggerSource = {
    trigger: '@', name: SOURCE, order: 15,
    async candidates(session, request) {
      const workspaceId = workspaceFor(session.sessionId)
      if (!workspaceId) return []
      const workflows = await options.listWorkflows()
      if (request.signal.aborted) return []
      const query = request.query.trim().toLocaleLowerCase()
      return workflows.filter(flow => !flow.archived && flow.workspaceId === workspaceId &&
        (!query || `${flow.title} ${flow.description}`.toLocaleLowerCase().includes(query)))
        .map(flow => ({ name: flow.title, label: flow.title, description: flow.description || '在当前工作区调用或修改',
          section: '工作流', icon: 'file' as const,
          value: encodeReference({ version: 1, kind: 'workflow', workflowId: flow.id, workspaceId,
            sessionId: session.sessionId, title: flow.title }) }))
    },
    onPick(pick) {
      if (!pick.candidate.value) return
      const value = decodeReference(pick.candidate.value)
      assertWorkspace(pick.session.sessionId, value.workspaceId)
      return { insert: reference(value) }
    },
    openReference(session, ref) {
      try {
        const value = decodeReference(ref.ref)
        assertWorkspace(session.sessionId, value.workspaceId)
        options.openWorkflow(value.workflowId, session.sessionId, 'reference')
        if (value.kind === 'annotations') showEditor(session.sessionId, value.batchId)
        return true
      } catch { return false }
    },
    codec: {
      clipboardText(ref) { return reference(decodeReference(ref)).clipboardText },
      async serialize(ref, signal) {
        const value = decodeReference(ref)
        assertWorkspace(value.sessionId, value.workspaceId)
        const workflow = await options.getWorkflow(value.workflowId)
        if (signal.aborted) throw new Error('发送已取消。')
        if (workflow.workspaceId !== value.workspaceId) throw new Error('工作流所属工作区已变化，请重新引用。')
        if (value.kind === 'workflow') return `\n工作流引用（稳定标识）：\n${JSON.stringify({ workflowId: workflow.id,
          workspaceId: workflow.workspaceId, title: workflow.title, revision: workflow.revision })}\n默认按此工作流执行；如果本条消息明确要求修改，则只按用户的修改要求编辑。请先用 visible_workflow_get 读取最新定义，用 visible_workflow_run 执行或用 visible_workflow_save 保存修改。\n`
        const batch = batches.find(item => item.id === value.batchId && item.sessionId === value.sessionId)
        if (!batch || batch.annotations.length === 0) throw new Error('注释草稿已失效，请重新添加。')
        const validNodeIds = nodeIdsIn(workflow)
        for (const note of batch.annotations) {
          if (note.nodeIds.some(id => !validNodeIds.has(id))) {
            throw new Error('注释引用的节点已被删除，请重新选择节点。')
          }
        }
        ensureSubscription(batch.sessionId)
        const token = crypto.randomUUID()
        receipts.set(token, { batchId: batch.id, revision: batch.revision })
        annotationFlights.set(batch.id, { revision: batch.revision, token, removedFromInput: !hasBatchReference(batch) })
        const abort = () => {
          if (disposed || annotationFlights.get(batch.id)?.token !== token) return
          annotationFlights.delete(batch.id); notify()
        }
        signal.addEventListener('abort', abort, { once: true })
        disposers.push(() => signal.removeEventListener('abort', abort))
        // Preserve receipt correlation across a renderer reload during Host admission.
        notify()
        const payload = { workflowId: workflow.id, workspaceId: workflow.workspaceId,
          referencedRevision: batch.graphRevision, currentRevision: workflow.revision,
          annotations: batch.annotations.map(note => ({ nodeIds: note.nodeIds, requirement: note.text })) }
        // Annotation ordinals are intentionally absent from sent history.
        return `\n${RECEIPT_PREFIX}${token}\n工作流节点修改要求：\n${JSON.stringify(payload)}\n请先用 visible_workflow_get 读取最新流程，仅修改用户明确要求的范围，保留其他节点和连接，再用 visible_workflow_save 保存。\n`
      },
    },
  }

  const bridge: ChatBridge = {
    async stageAnnotation(sessionId, workflow, nodeIds, text, annotationId) {
      assertWorkspace(sessionId, workflow.workspaceId)
      workflowCache.set(workflow.id, workflow)
      if (annotationId) { editAnnotation(sessionId, annotationId, text); return }
      if (!text.trim()) throw new Error('请填写修改要求。')
      const ids = [...new Set(nodeIds)]
      if (!ids.length || ids.some(id => !nodeIdsIn(workflow).has(id))) throw new Error('请先选择有效节点。')
      let batch = batches.find(item => item.sessionId === sessionId && item.workflowId === workflow.id && hasBatchReference(item))
      if (!batch) {
        batch = { id: crypto.randomUUID(), sessionId, workflowId: workflow.id, workspaceId: workflow.workspaceId,
          workflowTitle: workflow.title, graphRevision: workflow.revision, revision: 0, annotations: [] }
        const inserted = await insert(sessionId, { version: 1, kind: 'annotations', workflowId: workflow.id,
          workspaceId: workflow.workspaceId, sessionId, title: workflow.title, batchId: batch.id })
        if (!inserted) throw new Error('聊天草稿正在提交，请稍后再添加注释。')
        batches.push(batch)
      }
      const nextNumber = Math.max(0, ...batch.annotations.map(note => note.number)) + 1
      batch.annotations.push({ id: crypto.randomUUID(), number: nextNumber, sessionId, workflowId: workflow.id,
        nodeIds: ids, text: text.trim() })
      batch.revision++
      ensureSubscription(sessionId)
      notify()
    },
    editAnnotation,
    deleteAnnotation,
    async insertWorkflow(sessionId, workflow) {
      assertWorkspace(sessionId, workflow.workspaceId)
      if (!await insert(sessionId, { version: 1, kind: 'workflow', workflowId: workflow.id,
        workspaceId: workflow.workspaceId, sessionId, title: workflow.title })) throw new Error('聊天草稿正在提交，请稍后重试。')
    },
    async insertGenerateRequest(sessionId, text, workflow) {
      const actions = await actionsFor(sessionId)
      if (disposed) return false
      const scope = ctx.sessions.scope(sessionId as SessionId)
      if (!scope) return false
      const input = inputFor(sessionId), state = input.state.getSnapshot()
      if (state.phase !== 'plain') return false
      if (!text.trim()) throw new Error('请填写工作流需求。')
      const workspaceId = workspaceFor(sessionId)
      if (!workspaceId) throw new Error('当前对话的工作区还未加载，请稍后重试。')
      if (workflow) assertWorkspace(sessionId, workflow.workspaceId)
      const target = workflow ?? { id: crypto.randomUUID(), workspaceId }
      const token = workflow ? undefined : crypto.randomUUID()
      const requestText = workflow
        ? `请修改已有工作流：\n${JSON.stringify({ workflowId: target.id, workspaceId: target.workspaceId, title: workflow.title })}\n修改要求：\n${text.trim()}\n请先用 visible_workflow_get 读取此 ID 的最新定义，再以同一 ID 和最新 expected_revision 调用 visible_workflow_save；保留未要求修改的节点和连接，不另建副本。只保存修改草稿，等待我决定是否执行。`
        : `${GENERATION_RECEIPT_PREFIX}${token}\n请生成一个工作流：\n${text.trim()}\n新工作流身份：${JSON.stringify({ workflowId: target.id, workspaceId })}\n请先用 visible_workflow_list 核对当前工作区，再用 visible_workflow_save 创建可编辑工作流；新流程必须使用上面提供的 workflowId 作为 id，expected_revision=0。生成后先保存草稿，等待我决定是否执行。`
      const captured = actions.captureInsertion()
      if (token) {
        generations.set(token, { sessionId, workspaceId, workflowId: target.id })
        ensureSubscription(sessionId)
      }
      const result = scope.bail(scope, 'slash/input-insert-text', {
        text: `${state.draft ? '\n' : ''}${requestText}`,
        span: { ...captured, start: captured.end },
      })
      if (token) {
        if (result !== true) generations.delete(token)
        notify()
      }
      if (result) input.focus()
      return result === true
    },
    getAnnotations(workflowId, sessionId) {
      return batches.filter(batch => batch.workflowId === workflowId && (!sessionId || batch.sessionId === sessionId) && isVisible(batch))
        .flatMap(batch => batch.annotations.map(note => ({ ...note, nodeIds: [...note.nodeIds] })))
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    dispose() {
      if (disposed) return
      disposed = true
      for (const dispose of disposers.reverse()) dispose()
      for (const item of subscriptions.values()) item.dispose()
      subscriptions.clear(); receipts.clear(); annotationFlights.clear(); inputSignatures.clear(); listeners.clear(); inputActions.clear(); inputWaiters.clear(); workflowCache.clear()
      for (const timer of generationTimers.values()) clearTimeout(timer)
      generationTimers.clear(); generations.clear()
    },
  }

  function AnnotationControl({ sessionId, useInput, inputActions: actions }: PropsRuntime<'conversation.input.left'>) {
    useSyncExternalStore(bridge.subscribe, () => version, () => version)
    const input = useInput(state => state)
    const [editing, setEditing] = useState<string | null>(null)
    const [, refreshLabels] = useState(0)
    const notes = batches.filter(batch => batch.sessionId === sessionId && isVisible(batch)).flatMap(batch => batch.annotations)
    useEffect(() => {
      inputActions.set(sessionId, actions)
      for (const finish of inputWaiters.get(sessionId) ?? []) finish(actions)
      return () => { if (inputActions.get(sessionId) === actions) inputActions.delete(sessionId) }
    }, [sessionId, actions])
    useEffect(() => {
      const open = (targetSession: string, batchId?: string) => {
        if (targetSession !== sessionId) return
        const note = batches.find(batch => batch.sessionId === sessionId && (!batchId || batch.id === batchId) && isVisible(batch))?.annotations[0]
        if (note) setEditing(note.id)
      }
      showEditor = open
      return () => { if (showEditor === open) showEditor = () => {} }
    }, [sessionId])
    const visibleWorkflowIds = [...new Set(notes.map(note => note.workflowId))].join('\n')
    useEffect(() => {
      if (editing === null) return
      let active = true
      void Promise.all(visibleWorkflowIds.split('\n').filter(Boolean).map(async id => {
        try { const flow = await options.getWorkflow(id); if (active) { workflowCache.set(id, flow); refreshLabels(value => value + 1) } } catch { /* Stored stable IDs remain visible when a workflow cannot be read. */ }
      }))
      return () => { active = false }
    }, [editing !== null, visibleWorkflowIds])
    const labelsFor = (note: WorkflowAnnotation) => {
      const workflow = workflowCache.get(note.workflowId)
      const nodes = new Map<string, string>()
      const visit = (graph: NodeGraph) => { for (const node of graph.nodes) { nodes.set(node.id, `${node.number} · ${node.title}`); if (node.config.body) visit(node.config.body) } }
      if (workflow) visit(workflow)
      return { ...note, nodeLabels: note.nodeIds.map(id => nodes.get(id) ?? id), workflowTitle: workflow?.title ?? batches.find(batch => batch.workflowId === note.workflowId)?.workflowTitle }
    }
    if (!notes.length) return null
    return <>
      <Button variant="outline" size="sm" title="查看和修改节点注释" onClick={() => setEditing(notes[0]!.id)}>{notes.length} 条注释</Button>
      <AnnotationEditor open={editing !== null} annotations={notes.map(labelsFor)} initialId={editing ?? undefined}
        disabled={input.phase !== 'plain'} onClose={() => setEditing(null)}
        onSave={(id, text) => editAnnotation(sessionId, id, text)} onDelete={id => deleteAnnotation(sessionId, id)}
        onLocate={id => { const note = notes.find(item => item.id === id); if (note) options.openWorkflow(note.workflowId, note.sessionId, 'reference') }}/>
    </>
  }

  disposers.push(ctx.inputTriggers.registerSource(source))
  disposers.push(ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register({ name: 'conversation.input.left', id: `${SOURCE}.annotations`, order: 15 }, AnnotationControl)))
  for (const sessionId of new Set([...batches.map(batch => batch.sessionId), ...[...generations.values()].map(request => request.sessionId)])) {
    try { ensureSubscription(sessionId) } catch { /* A removed session remains a recoverable local draft. */ }
  }
  for (const [token, request] of generations) if (request.acceptedAt !== undefined) watchGeneration(token)
  return bridge
}
