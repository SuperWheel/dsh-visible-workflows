import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'

export interface PlanningBackgroundOwner {
  readonly parent: Agent
  readonly sessionId: string
  readonly workspaceId: string
}

/** Attribution and exact live identity only. The service still authorizes every operation. */
export interface PlanningBackgroundRuntime {
  isLive(parent: Agent): boolean
  withInitiator<T>(parent: Agent, operation: () => Promise<T>): Promise<T>
  onDisposed(listener: (parent: Agent) => void): () => void
}

/** Pass the plugin's Host context, rather than a returning tool's scoped context. */
export function planningBackgroundRuntime(ctx: Pick<Context, 'on'>, agents: Pick<AgentRegistry, 'get' | 'withInitiator'>): PlanningBackgroundRuntime {
  return {
    isLive: parent => agents.get(parent.id) === parent,
    withInitiator: (parent, operation) => agents.withInitiator(parent, operation),
    onDisposed: listener => ctx.on('agent/disposed', ({ agent }) => listener(agent)),
  }
}

/** Compatible with the service's existing foreground active entries. No second task map. */
export interface PlanningActiveOperation<T> {
  readonly controller: AbortController
  readonly done: Promise<T>
  readonly background?: true
  readonly owner?: PlanningBackgroundOwner
}
export interface PlanningBackgroundOperation<T> extends PlanningActiveOperation<T> {
  readonly background: true
  readonly owner: PlanningBackgroundOwner
}

export class PlanningBackgroundError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'PlanningBackgroundError' }
}
const parentDisposed = () => new PlanningBackgroundError('PLANNING_PARENT_DISPOSED', '主对话 Agent 已关闭，后台规划已停止')
const invalidOwner = () => new PlanningBackgroundError('PLANNING_BACKGROUND_OWNER', '后台规划的工作区或主对话归属不匹配')
const sameOwner = (a: PlanningBackgroundOwner, b: PlanningBackgroundOwner) => a.parent === b.parent && a.sessionId === b.sessionId && a.workspaceId === b.workspaceId
function assertOwner(owner: PlanningBackgroundOwner) {
  if (!owner.sessionId || !owner.workspaceId || owner.parent.id !== owner.sessionId || owner.parent.session.id !== owner.sessionId) throw invalidOwner()
}

export interface RegisterPlanningBackground<T> {
  /** The one active Map already owned by WorkflowPlanningService. */
  active: Map<string, PlanningActiveOperation<T>>
  taskId: string
  owner: PlanningBackgroundOwner
  /** Checked during acceptance only; never included in the detached lifetime. */
  callSignal: AbortSignal
  hostSignal: AbortSignal
  runtime: PlanningBackgroundRuntime
  deadlineMs: number
  /** Must settle only after owned child disposal and durable final-state accounting. */
  run(signal: AbortSignal, externalSignal: AbortSignal): Promise<T>
  /** Persist a terminal task if admission races cancellation or SDK setup fails before run. */
  onFailure?(error: unknown, signal: AbortSignal, externalSignal: AbortSignal): T | Promise<T>
}

/**
 * The service persists its acceptance receipt BEFORE calling this function and
 * returns that receipt without awaiting done. This registers synchronously in
 * its existing active Map and defers generation into a tracked SDK initiator
 * boundary. It does not publish, replay requests, copy history or grant authority.
 *
 * Cancellation is cooperative: done/close never claim cleanup until run settles.
 * externalSignal omits the internal deadline for the existing retained-candidate
 * path, while retaining user cancellation, parent disposal and Host shutdown.
 */
export function registerPlanningBackground<T>(options: RegisterPlanningBackground<T>): PlanningBackgroundOperation<T> {
  options.callSignal.throwIfAborted()
  options.hostSignal.throwIfAborted()
  assertOwner(options.owner)
  if (!options.taskId || !Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 2_147_483_647) throw new PlanningBackgroundError('PLANNING_BACKGROUND_ARGUMENT', '后台规划任务身份或时长保护无效')
  const existing = options.active.get(options.taskId)
  if (existing) {
    if (!existing.background || !existing.owner || !sameOwner(existing.owner, options.owner)) throw invalidOwner()
    return existing as PlanningBackgroundOperation<T>
  }
  if (!options.runtime.isLive(options.owner.parent)) throw parentDisposed()

  // Capture immutable identity: callers cannot reassign workspace/session after admission.
  const owner = Object.freeze({ ...options.owner })
  const controller = new AbortController(), parent = new AbortController(), deadline = new AbortController()
  const externalSignal = AbortSignal.any([controller.signal, parent.signal, options.hostSignal])
  const signal = AbortSignal.any([externalSignal, deadline.signal])
  const unlisten = options.runtime.onDisposed(agent => { if (agent === owner.parent) parent.abort(parentDisposed()) })
  let timer: ReturnType<typeof setTimeout> | undefined
  let operation: PlanningBackgroundOperation<T>
  try {
    // Subscription-before-recheck closes the disposal race at acceptance.
    if (!options.runtime.isLive(owner.parent)) parent.abort(parentDisposed())
    timer = setTimeout(() => deadline.abort(new PlanningBackgroundError('PLANNING_DEADLINE_EXCEEDED', '规划达到总时长保护，后台任务已停止')), options.deadlineMs)
    timer.unref?.()
    const done = Promise.resolve().then(() => {
      signal.throwIfAborted()
      if (!options.runtime.isLive(owner.parent)) { parent.abort(parentDisposed()); signal.throwIfAborted() }
      return options.runtime.withInitiator(owner.parent, () => options.run(signal, externalSignal))
    }).catch(error => {
      if (options.onFailure) return options.onFailure(error, signal, externalSignal)
      throw error
    }).finally(() => {
      if (timer) clearTimeout(timer)
      try { unlisten() }
      finally { if (options.active.get(options.taskId) === operation) options.active.delete(options.taskId) }
    })
    // The service owns done; a failing background task must not become an
    // unhandled rejection merely because its acceptance call already returned.
    void done.catch(() => {})
    operation = { controller, done, background: true, owner }
    options.active.set(options.taskId, operation)
    return operation
  } catch (error) {
    if (timer) clearTimeout(timer)
    unlisten()
    throw error
  }
}

/** The service must authorize the cancellation before calling this helper. */
export async function cancelPlanningBackground<T>(active: Map<string, PlanningActiveOperation<T>>, taskId: string, owner: PlanningBackgroundOwner, reason: unknown = new Error('用户取消规划')): Promise<T | undefined> {
  assertOwner(owner)
  const operation = active.get(taskId)
  if (!operation) return undefined
  if (!operation.background || !operation.owner || !sameOwner(operation.owner, owner)) throw invalidOwner()
  operation.controller.abort(reason)
  return operation.done
}

/** Reuses the service's active Map; drains foreground entries as well. */
export async function closePlanningBackground<T>(active: Map<string, PlanningActiveOperation<T>>, reason: unknown = new Error('Host 已关闭')): Promise<void> {
  const pending = [...active.values()]
  for (const operation of pending) operation.controller.abort(reason)
  await Promise.allSettled(pending.map(operation => operation.done))
}

const identity = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
/** Separate compact recovery receipts; never persist a preview's full request/source/context. */
export const planningBackgroundEnvelopeSchema = z.object({
  protocolVersion: z.literal(1), taskId: identity, requestId: identity,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/), sessionId: identity,
  workspaceId: z.string().min(1).max(4000), acceptedAt: z.string().datetime(),
  state: z.enum(['accepted', 'interrupted']), interruptedAt: z.string().datetime().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.state === 'interrupted') !== (value.interruptedAt !== undefined)) ctx.addIssue({ code: 'custom', message: '后台恢复回执的中断时间与状态不匹配' })
})
export type PlanningBackgroundEnvelope = z.infer<typeof planningBackgroundEnvelopeSchema>

/** On restart keep the same task/request identity; this function never schedules work. */
export function interruptPlanningBackgroundEnvelope(value: unknown, at = new Date().toISOString()): PlanningBackgroundEnvelope {
  const envelope = planningBackgroundEnvelopeSchema.parse(value)
  return envelope.state === 'interrupted' ? envelope : planningBackgroundEnvelopeSchema.parse({ ...envelope, state: 'interrupted', interruptedAt: at })
}
