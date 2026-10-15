import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ModelSelection, ModelSelectionProjectionState } from '@deepseek-ai/dsh-api-session-controller'
import { foldRequestHeader, SessionId, SessionLogOffset, type EpochHeader } from '@deepseek-ai/dsh-session'
import type { NodeGraph, WorkflowModelDefaults, WorkflowNode } from '../shared/types.ts'
import { allNodes } from './validation.ts'

export const MODEL_NODE_KINDS = new Set(['llm', 'agent', 'classifier', 'extractor'])
export const isModelNode = (node: WorkflowNode): boolean => MODEL_NODE_KINDS.has(node.kind) || (node.kind === 'document' && node.config.documentMode === 'agent')

// This optional SDK service is supplied by the Host, not imported or mounted by
// this plugin. Its public currentSelection() only reads configured references.
type ModelContext = Context & { agentDefaultModel: { currentSelection(): ModelSelection } }

function snapshot(selection: ModelSelection | undefined, source: WorkflowModelDefaults['source']): WorkflowModelDefaults | undefined {
  if (!selection?.provider?.trim() || !selection.model?.trim()) return undefined
  return { model: { provider: selection.provider, model: selection.model }, ...(selection.reasoningEffort ? { effort: selection.reasoningEffort } : {}), source }
}

/** Match the SDK's selectionFor.current: pending wins; adapter defaults are not explicit effort. */
export function sessionModelDefaults(pending: ModelSelection | null | undefined, header: EpochHeader | undefined): WorkflowModelDefaults | undefined {
  if (pending) return snapshot(pending, 'session')
  if (!header) return undefined
  return snapshot({ provider: header.config.provider, model: header.config.model, ...(header.config.reasoningEffort && !header.adapterDefaults?.reasoningEffort ? { reasoningEffort: header.config.reasoningEffort } : {}) }, 'session')
}

/** Cold-safe, read-only resolution. Never creates an Agent or chooses a catalog entry. */
export async function resolveHarnessModelDefaults(ctx: Context, workspaceId: string, sessionId?: string, agent?: Agent, currentRequest = false): Promise<WorkflowModelDefaults | undefined> {
  const workspace = ctx.workspaceRegistry.list().find(w => w.id === workspaceId)
  const scoped = !!sessionId && !!workspace?.sessionIds.includes(SessionId(sessionId))
  if (scoped && workspace) {
    const projections = ctx.get('sessionProjections')
    if (agent && agent.id === sessionId && agent.session.header.cwd === workspace.path) {
      // A running Agent tool belongs to its current request, even when the user
      // has already picked a different model for a later conversation turn.
      const pending = currentRequest ? undefined : projections?.stateOf(agent.session, 'modelSelection')?.pending
      const header = agent.session.requestHeader()
      const selected = currentRequest && header ? snapshot(header.config, 'session') : sessionModelDefaults(pending, header)
      if (selected) return selected
    } else {
      const controller = ctx.get('sessionController')
      if (controller && projections) {
        const inspected = await controller.inspect(SessionId(sessionId!))
        if (inspected.meta.cwd === workspace.path) {
          // Use the registered SDK fold over one exact observation, not a second
          // read that could race a model change or a custom copy of its reducer.
          const restored = projections.restore({}, inspected.events, SessionLogOffset(0), inspected.meta, inspected.inheritedEventCount)
          const state = restored.checkpoint.modelSelection?.val as ModelSelectionProjectionState | undefined
          const selected = sessionModelDefaults(state?.pending, foldRequestHeader(inspected.events))
          if (selected) return selected
        }
      }
    }
  }
  return snapshot((ctx as ModelContext).get('agentDefaultModel')?.currentSelection(), 'harness')
}

/** Mutate only the detached execution graph. Nested body nodes receive the same frozen defaults. */
export function applyModelDefaults(graph: NodeGraph, defaults?: WorkflowModelDefaults): void {
  for (const node of allNodes(graph)) {
    if (!isModelNode(node)) continue
    if (!node.config.model) {
      if (!defaults) throw new Error(`节点 ${node.number || node.title} 未指定模型，DSH 也未配置默认模型；请在 DSH 选择模型或为此节点指定模型`)
      node.config.model = { ...defaults.model }
    }
    if (node.config.effort === undefined && defaults && node.config.model.provider === defaults.model.provider && node.config.model.model === defaults.model.model && defaults.effort !== undefined) node.config.effort = defaults.effort
  }
}
