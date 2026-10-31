import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
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
import { workflowVisibleInWorkspace } from '../shared/workflow-scope.ts'
import { AnnotationEditor } from './annotation-editor.tsx'
import { enumerateAnnotationNodes, resolveAnnotationNodes } from './annotation-nodes.ts'
import { legacyAnnotationPosition } from './annotation-fallback.ts'
import { cloneAnnotationPosition, isAnnotationPosition, type AnnotationPosition } from './annotation-position.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { visibleWorkflows: unknown }
}

const SOURCE = 'visible-workflows'
const DRAFT_KEY = 'dsh.visibleWorkflows.annotationDrafts.v1'
/** Keep ordinary annotation drafts across host restarts. Legacy tab storage is read for migration. */
function annotationStorage():Storage {try{if(globalThis.localStorage)return globalThis.localStorage}catch{}return sessionStorage}
const RECEIPT_PREFIX = 'visible-workflow-annotation-admission:'
const GENERATION_RECEIPT_PREFIX = 'visible-workflow-generation-admission:'
const PLANNING_RESULT_GUIDE = '工具受理即返回 taskId、状态和版本；queued/authoring/validating/repairing 只表示受理或处理中，不能声称候选已生成或发布成功。后台事件与通知会更新结果；本回合必须用 visible_workflow_plan_wait 对同一 taskId 事件等待并核验，再正常总结，不能在子任务未结束时提前 final。waiting 须继续同任务等待，不能当作成功；核对完整候选才用 visible_workflow_plan_get。不要高频查询或换 requestId 重提。返回 awaiting_input 时优先沿用 Host 已显示的原生问题，不重复询问；未显示时用原生问答完整转达当前 questions，等待真人回答后调用 visible_workflow_plan_answer，以同一 taskId 和当前 revision 续接，不能代答或另建任务。只有 receipt.kind=created 才能说新工作流已保存，receipt.kind=proposed 表示修改提案待用户在画布确认；ready 或 preview 只是预览，用户明确要求保存后才调用 visible_workflow_plan_publish。不要自动接受提案或执行业务工作流。'
const PLANNING_READ_GUIDE = '修改已有工作流时，已知稳定目标节点 ID 和当前图 revision 的局部修改先用 visible_workflow_nodes 精确定位或批量读取：workflow_id 使用原工作流，expected_revision 使用当前 revision，node_id/node_ids 保持原目标；已知字段用 fields 只取必要字段及依赖。仅全图问题、目标无法确定或缺少／过期版本时才用 visible_workflow_get 读同一目标的整图。版本过期后重新读取同一目标身份并核对原要求，不自动换目标、扩大范围或新建 requestId；不能跳过 Host stale 校验。'
const PLANNING_ROUTE_GUIDE = '按已有决定选择入口：修改已有工作流且已有明确字段新值时用 visible_workflow_edit，changes 只写已按用户要求确定的字段操作，不重新交给子 Agent 设计；request_id 使用原规划 requestId，workflow_id 使用原目标 workflowId（规划请求中为 targetWorkflowId），expected_revision 使用刚读取的最新 revision，instruction 完整保留原始要求，target_node_ids 保留原明确 targetNodeIds。已验证模块且参数齐全时用 visible_workflow_plan 的 handoff.version=1、handoff.mode=module，保留固定模块身份、版本、参数与来源。只有未决业务推理才用 visible_workflow_plan 的 handoff.mode=partial，同时交 changes 中已确定的决定、unresolved 的节点／字段／问题及必要约束；开放任务才用 visible_workflow_plan 的完整规划路径。调用 plan 时保留原 requestId、operation、targetWorkflowId、最新 expectedRevision 和完整 instruction，request 传完整规划请求对象。画布引用或标记只用于定位，不能作为独立授权；明确指定节点时保留 targetNodeIds，不扩大修改范围，不改未要求的节点和连接。全部路径仍由 Host 校验版本、权限、固定节点和完整图；修改通过正常待接受提案确认。不自行设计完整 JSON 或调用保存工具，不自动接受提案或执行流程。'

export interface WorkflowAnnotation {
  id: string
  number: number
  sessionId: string
  workflowId: string
  nodeIds: string[]
  text: string
  position?: AnnotationPosition
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

export type WorkflowEditTarget = Pick<Workflow, 'id' | 'workspaceId' | 'title' | 'scope'>
export interface WorkflowRequestSnapshot {id:string;text:string;revision:number;status:'draft'|'sending'}
interface RequestDraft {id:string;sessionId:string;workspaceId:string;workflowId:string;title:string;operation:'create'|'revise';text:string;revision:number}
interface RequestReceipt {id:string;revision:number}

interface ReferenceValue {
  version: 1
  kind: 'workflow' | 'annotations' | 'request'
  workflowId: string
  workspaceId: string
  sessionId: string
  title: string
  batchId?: string
  requestId?: string
}

export interface ChatBridgeOptions {
  listWorkflows(): Promise<Workflow[]>
  getWorkflow(id: string): Promise<Workflow>
  openWorkflow(id: string, sessionId: string, reason: 'reference'|'generated'): void
}

export interface ChatBridge {
  stageAnnotation(sessionId: string, workflow: Workflow, nodeIds: string[], text: string, annotationId?: string, position?: AnnotationPosition): Promise<void>
  editAnnotation(sessionId: string, annotationId: string, text: string, nodeIds?: readonly string[]): void
  deleteAnnotation(sessionId: string, annotationId: string): Promise<void>
  insertWorkflow(sessionId: string, workflow: Workflow): Promise<void>
  insertGenerateRequest(sessionId: string, text: string, workflow?: WorkflowEditTarget): Promise<boolean>
  getGenerateRequest(sessionId:string,targetWorkflowId?:string):WorkflowRequestSnapshot|undefined
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
  if (!parsed || parsed.version !== 1 || !['workflow', 'annotations', 'request'].includes(String(parsed.kind)) ||
    !['workflowId', 'workspaceId', 'sessionId', 'title'].every(key => typeof parsed[key] === 'string') ||
    (parsed.kind === 'annotations' && typeof parsed.batchId !== 'string') || (parsed.kind === 'request' && typeof parsed.requestId !== 'string')) throw new Error('工作流引用已失效，请重新添加。')
  return parsed as unknown as ReferenceValue
}

function serializeRequest(item:RequestDraft,token:string):string{
  const planningRequest={requestId:token,operation:item.operation,targetWorkflowId:item.workflowId,instruction:item.text.trim(),...(item.operation==='create'?{expectedRevision:0}:{})}
  const identity=JSON.stringify({workflowId:item.workflowId,workspaceId:item.workspaceId,title:item.title})
  return `\n${GENERATION_RECEIPT_PREFIX}${token}\n${item.operation==='revise'?'请修改已有工作流：':'请生成一个工作流：\n新工作流身份：'}${item.operation==='revise'?'\n':''}${identity}\n规划请求：${JSON.stringify(planningRequest)}\n${item.operation==='revise'?'此需求草稿没有当前 revision 时，可先用 visible_workflow_get 读取此 ID 的最新定义，将最新 revision 填入规划请求的 expectedRevision；保持同一 targetWorkflowId，不另建副本。':'请先用 visible_workflow_list 核对当前工作区；expectedRevision=0。'}完整保留 instruction 和同一 requestId。${PLANNING_READ_GUIDE}${PLANNING_ROUTE_GUIDE}${PLANNING_RESULT_GUIDE}\n`
}

function reference(value: ReferenceValue): ReferenceInsert {
  return {
    source: SOURCE, ref: encodeReference(value),
    label: value.kind === 'annotations' ? '工作流注释' : `@${value.title}`,
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
  const requests=new Map<string,RequestDraft>(),requestReceipts=new Map<string,RequestReceipt>()
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
    const saved: unknown = JSON.parse(annotationStorage().getItem(DRAFT_KEY) ?? sessionStorage.getItem(DRAFT_KEY) ?? '[]')
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
    }).map(batch=>({...batch,annotations:batch.annotations.map(note=>{
      // A corrupt optional location must not discard an otherwise valid draft.
      const {position,...content}=note
      return {...content,...(isAnnotationPosition(position)?{position:cloneAnnotationPosition(position)}:{})}
    })}))
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
    if(Array.isArray(stored?.requests))for(const entry of stored.requests){
      if(!Array.isArray(entry)||typeof entry[0]!=='string')continue
      const item=record(entry[1])
      if(item&&['id','sessionId','workspaceId','workflowId','title','text'].every(key=>typeof item[key]==='string')&&['create','revise'].includes(String(item.operation))&&Number.isSafeInteger(item.revision)&&Number(item.revision)>0)requests.set(entry[0],item as unknown as RequestDraft)
    }
    if(Array.isArray(stored?.requestReceipts))for(const entry of stored.requestReceipts){
      if(!Array.isArray(entry)||typeof entry[0]!=='string')continue
      const item=record(entry[1]);if(item&&typeof item.id==='string'&&Number.isSafeInteger(item.revision)&&requests.has(item.id))requestReceipts.set(entry[0],item as unknown as RequestReceipt)
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
    try { annotationStorage().setItem(DRAFT_KEY, JSON.stringify({ batches, receipts: [...receipts], generations: [...generations], flights: [...annotationFlights], requests:[...requests], requestReceipts:[...requestReceipts] })) } catch { /* Runtime drafts remain usable. */ }
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

  const requestReference=(value:ReferenceValue):ReferenceInsert=>{
    const item=value.requestId?requests.get(value.requestId):undefined
    if(!item)return reference(value)
    const target=item.operation==='create'?'新工作流':`@${item.title}`
    return {...reference(value),label:`${target} · ${item.text.replace(/\s+/g,' ').slice(0,100)}`,clipboardText:`${target}\n${item.text}`}
  }
  const requestOccurrence=(item:RequestDraft)=>{
    try{return inputFor(item.sessionId).state.getSnapshot().occurrences.find(occurrence=>{
      if(occurrence.source!==SOURCE)return false
      try{const value=decodeReference(occurrence.ref);return value.kind==='request'&&value.requestId===item.id&&value.sessionId===item.sessionId}catch{return false}
    })}catch{return undefined}
  }
  const requestInFlight=(item:RequestDraft)=>[...requestReceipts.values()].some(receipt=>receipt.id===item.id&&receipt.revision===item.revision)
  const activeRequest=(sessionId:string,targetWorkflowId?:string)=>[...requests.values()].reverse().find(item=>item.sessionId===sessionId&&(targetWorkflowId?item.operation==='revise'&&item.workflowId===targetWorkflowId:item.operation==='create')&&(requestOccurrence(item)||requestInFlight(item)))
  const requestSnapshot=(item:RequestDraft):WorkflowRequestSnapshot=>({id:item.id,text:item.text,revision:item.revision,status:inputFor(item.sessionId).state.getSnapshot().phase!=='plain'||(!requestOccurrence(item)&&requestInFlight(item))?'sending':'draft'})

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
      for(const token of acceptedMessageTokens(value,new Set(requestReceipts.keys()),GENERATION_RECEIPT_PREFIX)){
        const receipt=requestReceipts.get(token),item=receipt&&requests.get(receipt.id)
        if(!receipt||!item||item.sessionId!==sessionId)continue
        if(item.revision===receipt.revision){requests.delete(item.id);for(const [key,other]of requestReceipts)if(other.id===item.id)requestReceipts.delete(key);changed=true}
        else requestReceipts.delete(token)
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
      const signature = JSON.stringify([state.phase, [...visibleIds].sort(),state.occurrences.filter(item=>item.source===SOURCE).map(item=>item.ref)])
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

  const editAnnotation = (sessionId: string, id: string, text: string, nodeIds?: readonly string[], position?: AnnotationPosition) => {
    const batch = batches.find(item => item.sessionId === sessionId && item.annotations.some(note => note.id === id))
    if (!batch || !hasBatchReference(batch)) throw new Error('这条注释已经提交或移出草稿，请重新添加。')
    if (!text.trim()) throw new Error('请填写修改要求。')
    if (inputFor(sessionId).state.getSnapshot().phase !== 'plain') throw new Error('聊天草稿正在提交，请稍后再修改注释。')
    const ids = nodeIds ? [...new Set(nodeIds)] : undefined
    if (ids) {
      const workflow = workflowCache.get(batch.workflowId)
      if (!ids.length || workflow && ids.some(target => !nodeIdsIn(workflow).has(target))) throw new Error('请选择至少一个有效节点。')
      if (!workflow) throw new Error('节点列表尚未加载，请重新打开工作流后修改引用。')
    }
    batch.annotations = batch.annotations.map(note => note.id === id ? { ...note, text: text.trim(), ...(ids ? { nodeIds: ids } : {}), ...(position ? {position:cloneAnnotationPosition(position)} : {}) } : note)
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
      for(const flow of workflows)workflowCache.set(flow.id,flow)
      return workflows.filter(flow => workflowVisibleInWorkspace(flow,workspaceId) &&
        (!query || `${flow.title} ${flow.description} ${flow.id}`.toLocaleLowerCase().includes(query)))
        .map(flow => ({ name: flow.id, label: flow.title, description: `${flow.scope==='global'?'全局':'当前工作区'}${flow.description?` · ${flow.description}`:''}`,
          section: '工作流', icon: 'file' as const,
          value: encodeReference({ version: 1, kind: 'workflow', workflowId: flow.id, workspaceId:flow.workspaceId,
            sessionId: session.sessionId, title: flow.title }) }))
    },
    onPick(pick) {
      if (!pick.candidate.value) return
      const value = decodeReference(pick.candidate.value)
      const actual=workspaceFor(pick.session.sessionId),flow=workflowCache.get(value.workflowId)
      if(value.kind!=='workflow'||!actual||!flow||!workflowVisibleInWorkspace(flow,actual)||flow.workspaceId!==value.workspaceId)throw new Error('工作流不属于当前工作区或全局范围。')
      return { insert: reference({...value,sessionId:pick.session.sessionId,title:flow.title}) }
    },
    openReference(session, ref) {
      try {
        const value = decodeReference(ref.ref)
        const actual=workspaceFor(session.sessionId)
        if(!actual)return false
        const cached=workflowCache.get(value.workflowId)
        if(cached&&(cached.workspaceId!==value.workspaceId||!workflowVisibleInWorkspace(cached,actual)))return false
        if(value.kind==='request'&&requests.get(value.requestId??'')?.operation==='create')return true
        void options.getWorkflow(value.workflowId).then(flow=>{
          if(disposed||flow.id!==value.workflowId||flow.workspaceId!==value.workspaceId||!workflowVisibleInWorkspace(flow,actual))return
          workflowCache.set(flow.id,flow);options.openWorkflow(flow.id,session.sessionId,'reference')
          if(value.kind==='annotations')showEditor(session.sessionId,value.batchId)
        }).catch(()=>{})
        return true
      } catch { return false }
    },
    codec: {
      clipboardText(ref) { const value=decodeReference(ref);return (value.kind==='request'?requestReference(value):reference(value)).clipboardText },
      async serialize(ref, signal) {
        const value = decodeReference(ref)
        const caller=workspaceFor(value.sessionId)
        if(!caller)throw new Error('当前对话的工作区还未加载，请稍后重试。')
        const assertCaller=()=>{if(disposed)throw new Error('工作流插件已关闭。');if(workspaceFor(value.sessionId)!==caller)throw new Error('当前对话的工作区已变化，请重新添加工作流需求。')}
        if(value.kind==='request'){
          const item=requests.get(value.requestId??'')
          if(!item||item.sessionId!==value.sessionId||item.workflowId!==value.workflowId||item.workspaceId!==value.workspaceId)throw new Error('工作流需求草稿已失效，请重新添加。')
          if(item.operation==='revise'){
            const flow=await options.getWorkflow(item.workflowId)
            assertCaller()
            if(flow.id!==item.workflowId||flow.workspaceId!==item.workspaceId||!workflowVisibleInWorkspace(flow,caller))throw new Error('工作流不属于当前工作区或全局范围。')
          }else if(item.workspaceId!==caller)throw new Error('新工作流必须属于当前工作区。')
          if(signal.aborted)throw new Error('发送已取消。')
          if(requests.get(item.id)!==item)throw new Error('工作流需求在发送期间已变化，请重新发送当前草稿。')
          const token=crypto.randomUUID(),revision=item.revision
          requestReceipts.set(token,{id:item.id,revision})
          if(item.operation==='create')generations.set(token,{sessionId:item.sessionId,workspaceId:item.workspaceId,workflowId:item.workflowId})
          const abort=()=>{requestReceipts.delete(token);if(generations.get(token)?.acceptedAt===undefined)generations.delete(token);notify()}
          signal.addEventListener('abort',abort,{once:true});disposers.push(()=>signal.removeEventListener('abort',abort));ensureSubscription(item.sessionId);notify()
          return serializeRequest(item,token)
        }
        const workflow = await options.getWorkflow(value.workflowId)
        assertCaller()
        if (signal.aborted) throw new Error('发送已取消。')
        if (workflow.id!==value.workflowId||workflow.workspaceId !== value.workspaceId||!workflowVisibleInWorkspace(workflow,caller)) throw new Error('工作流不属于当前工作区或全局范围，请重新引用。')
        if (value.kind === 'workflow') return `\n工作流引用（稳定标识）：\n${JSON.stringify({ workflowId: workflow.id,
          workspaceId: workflow.workspaceId, title: workflow.title, revision: workflow.revision, requestId: crypto.randomUUID() })}\n${PLANNING_READ_GUIDE}用户明确要求修改、优化、改进或重新规划（包括“帮我优化这个 workflow”）时，保持 operation="revise"、targetWorkflowId=上述 workflowId、上述规划 requestId，expectedRevision 使用刚读取的最新 revision；instruction 完整转达本条消息的修改要求。${PLANNING_ROUTE_GUIDE}只要求查看或解释时只读；只有用户明确要求执行流程时才使用 visible_workflow_run。${PLANNING_RESULT_GUIDE}\n`
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
          requestId: token, targetNodeIds: [...new Set(batch.annotations.flatMap(note => note.nodeIds))],
          annotations: batch.annotations.map(note => ({ nodeIds: note.nodeIds, requirement: note.text })) }
        // Annotation ordinals are intentionally absent from sent history.
        return `\n${RECEIPT_PREFIX}${token}\n工作流节点修改要求：\n${JSON.stringify(payload)}\n当前读取版本使用 currentRevision；referencedRevision 仅为注释原依据，二者不同时先核对同一稳定目标与原要求。${PLANNING_READ_GUIDE}保持 operation="revise"、上述规划 requestId、targetWorkflowId=workflowId、上述 targetNodeIds，expectedRevision 使用刚读取的最新 revision。instruction 必须完整保留 annotations 的每项 nodeIds 和 requirement，以及本条消息补充的全部修改要求，不删减或自行重写需求。${PLANNING_ROUTE_GUIDE}${PLANNING_RESULT_GUIDE}\n`
      },
    },
  }

  const bridge: ChatBridge = {
    async stageAnnotation(sessionId, workflow, nodeIds, text, annotationId, position) {
      if(position!==undefined&&!isAnnotationPosition(position))throw new Error('注释位置无效，请重新选择画布位置。')
      const marker=position&&cloneAnnotationPosition(position)
      const actual=workspaceFor(sessionId)
      if(!actual)throw new Error('当前对话的工作区还未加载，请稍后重试。')
      if(actual!==workflow.workspaceId){const latest=await options.getWorkflow(workflow.id);if(latest.id!==workflow.id||latest.workspaceId!==workflow.workspaceId||!workflowVisibleInWorkspace(latest,actual))throw new Error('工作流不属于当前工作区或全局范围。')}
      workflowCache.set(workflow.id, workflow)
      if (annotationId) { const batch = batches.find(item => item.sessionId === sessionId && item.annotations.some(note => note.id === annotationId)); if (batch?.workflowId !== workflow.id) throw new Error('注释不属于当前工作流。'); editAnnotation(sessionId, annotationId, text, nodeIds, marker); return }
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
        nodeIds: ids, text: text.trim(), ...(marker?{position:marker}:{}) })
      batch.revision++
      ensureSubscription(sessionId)
      notify()
    },
    editAnnotation,
    deleteAnnotation,
    async insertWorkflow(sessionId, workflow) {
      const actual=workspaceFor(sessionId),latest=await options.getWorkflow(workflow.id)
      if(!actual||latest.id!==workflow.id||!workflowVisibleInWorkspace(latest,actual))throw new Error('请先将工作流复制到当前对话所属工作区，或将其设为全局。')
      workflow=latest;workflowCache.set(latest.id,latest)
      if (!await insert(sessionId, { version: 1, kind: 'workflow', workflowId: workflow.id,
        workspaceId: workflow.workspaceId, sessionId, title: workflow.title })) throw new Error('聊天草稿正在提交，请稍后重试。')
    },
    async insertGenerateRequest(sessionId,text,workflow){
      const actions=await actionsFor(sessionId)
      if(disposed)return false
      const scope=ctx.sessions.scope(sessionId as SessionId)
      if(!scope)return false
      const input=inputFor(sessionId),state=input.state.getSnapshot(),caller=workspaceFor(sessionId)
      if(state.phase!=='plain')return false
      if(!text.trim())throw new Error('请填写工作流需求。')
      if(!caller)throw new Error('当前对话的工作区还未加载，请稍后重试。')
      if(workflow){const latest=await options.getWorkflow(workflow.id);if(latest.id!==workflow.id||!workflowVisibleInWorkspace(latest,caller))throw new Error('请先将工作流复制到当前对话所属工作区，或将其设为全局。');workflow=latest;workflowCache.set(latest.id,latest)}
      if(disposed)return false
      if(workspaceFor(sessionId)!==caller||ctx.sessions.scope(sessionId as SessionId)!==scope)throw new Error('当前对话或工作区已变化，请重新提交工作流需求。')
      const previous=activeRequest(sessionId,workflow?.id)
      if(previous&&requestSnapshot(previous).status==='sending')return false
      const next:RequestDraft={id:previous?.id??crypto.randomUUID(),sessionId,workspaceId:workflow?.workspaceId??caller,workflowId:workflow?.id??previous?.workflowId??crypto.randomUUID(),title:workflow?.title??'新工作流',operation:workflow?'revise':'create',text,revision:(previous?.revision??0)+1}
      const occurrence=previous&&requestOccurrence(previous)
      // A native chip occupies one detect character. Replace only our own chip,
      // with revision CAS, preserving arbitrary neighboring text and references.
      const latest=input.state.getSnapshot()
      if(latest.phase!=='plain')return false
      let span=actions.captureInsertion()
      if(occurrence){let delta=0;for(const item of latest.occurrences){if(item.occurrenceId===occurrence.occurrenceId){span={start:item.offset-delta,end:item.offset-delta+1,draftRev:latest.draftRev};break}delta+=item.length-1}}
      else span={...span,start:span.end}
      requests.set(next.id,next);ensureSubscription(sessionId)
      const value:ReferenceValue={version:1,kind:'request',requestId:next.id,workflowId:next.workflowId,workspaceId:next.workspaceId,sessionId,title:next.title}
      const result=scope.bail(scope,'slash/input-insert-reference',{reference:requestReference(value),span})===true
      if(!result){if(previous)requests.set(previous.id,previous);else requests.delete(next.id)}
      notify();if(result)input.focus();return result
    },
    getGenerateRequest(sessionId,targetWorkflowId){const item=activeRequest(sessionId,targetWorkflowId);return item?requestSnapshot(item):undefined},
    getAnnotations(workflowId, sessionId) {
      return batches.filter(batch => batch.workflowId === workflowId && (!sessionId || batch.sessionId === sessionId) && isVisible(batch))
        .flatMap(batch => batch.annotations.map(note => ({ ...note, nodeIds: [...note.nodeIds], ...(note.position?{position:cloneAnnotationPosition(note.position)}:{}) })))
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    dispose() {
      if (disposed) return
      disposed = true
      for (const dispose of disposers.reverse()) dispose()
      for (const item of subscriptions.values()) item.dispose()
      subscriptions.clear(); receipts.clear(); annotationFlights.clear(); inputSignatures.clear(); listeners.clear(); inputActions.clear(); inputWaiters.clear(); workflowCache.clear()
      for (const timer of generationTimers.values()) clearTimeout(timer)
      generationTimers.clear(); generations.clear();requests.clear();requestReceipts.clear()
    },
  }

  function AnnotationControl({ sessionId, useInput, inputActions: actions }: PropsRuntime<'conversation.input.left'>) {
    useSyncExternalStore(bridge.subscribe, () => version, () => version)
    const input = useInput(state => state)
    const [editing, setEditing] = useState<string | null>(null)
    const control = useRef<HTMLButtonElement>(null)
    const [anchorRect, setAnchorRect] = useState<Pick<DOMRect, 'left'|'right'|'top'|'bottom'>>()
    const locateEditor = (id?:string) => {
      const note=batches.filter(batch=>batch.sessionId===sessionId&&isVisible(batch)).flatMap(batch=>batch.annotations).find(note=>note.id===id)
      const pin=note&&typeof document!=='undefined'?Array.from(document.querySelectorAll<HTMLElement>('[data-annotation-id][data-workflow-id]')).find(element=>{
        if(element.getAttribute('data-annotation-id')!==note.id||element.getAttribute('data-workflow-id')!==note.workflowId)return false
        const rect=element.getBoundingClientRect()
        return rect.right>rect.left&&rect.bottom>rect.top&&(typeof window==='undefined'||rect.right>0&&rect.bottom>0&&rect.left<window.innerWidth&&rect.top<window.innerHeight)
      }):undefined
      const rect=pin?.getBoundingClientRect()??control.current?.getBoundingClientRect()
      setAnchorRect(rect?{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom}:undefined)
    }
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
        if (note) { locateEditor(note.id); setEditing(note.id) }
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
    const nodesFor = (note: WorkflowAnnotation | undefined) => {
      if (!note) return []
      const workflow=workflowCache.get(note.workflowId)
      const scopePath=note.position?.scopePath ?? (workflow ? legacyAnnotationPosition(workflow,note.nodeIds)?.scopePath : undefined)
      return workflow ? enumerateAnnotationNodes(workflow,scopePath) : []
    }
    const labelsFor = (note: WorkflowAnnotation) => {
      const workflow=workflowCache.get(note.workflowId)
      return { ...note, nodes: workflow ? resolveAnnotationNodes(workflow,note.nodeIds) : note.nodeIds.map(id=>({id,number:'',title:'节点暂不可用',ancestorIds:[]})), workflowTitle: workflow?.title ?? batches.find(batch => batch.workflowId === note.workflowId)?.workflowTitle }
    }
    if (!notes.length) return null
    return <>
      <Button ref={control} variant="outline" size="sm" title="查看和修改节点注释" onClick={() => {locateEditor(notes[0]!.id);setEditing(notes[0]!.id)}}>{notes.length} 条注释</Button>
      <AnnotationEditor open={editing !== null} annotations={notes.map(labelsFor)} initialId={editing ?? undefined} anchorRect={anchorRect} availableNodes={item=>nodesFor(notes.find(note=>note.id===item.id))}
        disabled={input.phase !== 'plain'} onClose={() => setEditing(null)} onSelectedChange={locateEditor}
        onSave={(id, text, nodeIds) => editAnnotation(sessionId, id, text, nodeIds)} onDelete={id => deleteAnnotation(sessionId, id)}
        onLocate={id => { const note = notes.find(item => item.id === id); if (note) options.openWorkflow(note.workflowId, note.sessionId, 'reference') }}/>
    </>
  }

  disposers.push(ctx.inputTriggers.registerSource(source))
  disposers.push(ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register({ name: 'conversation.input.left', id: `${SOURCE}.annotations`, order: 15 }, AnnotationControl)))
  for (const sessionId of new Set([...batches.map(batch => batch.sessionId), ...[...generations.values()].map(request => request.sessionId),...[...requests.values()].map(request=>request.sessionId)])) {
    try { ensureSubscription(sessionId) } catch { /* A removed session remains a recoverable local draft. */ }
  }
  for (const [token, request] of generations) if (request.acceptedAt !== undefined) watchGeneration(token)
  return bridge
}
