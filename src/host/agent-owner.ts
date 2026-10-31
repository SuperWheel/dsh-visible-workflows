import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'

/** Resolve the exact live runtime root, never durable parent metadata alone. */
export function workflowAgentOwner(agent: Agent, registry: Pick<AgentRegistry,'get'|'list'|'roots'|'isOwnedBy'>): Agent {
  const roots = registry.roots(), live = registry.list(), visited = new Set<string>()
  let current = agent
  while (!visited.has(current.id)) {
    visited.add(current.id)
    if (registry.get(current.id) !== current || current.session.id !== current.id) break
    if (roots.includes(current)) return current
    const owners = live.filter(candidate => registry.isOwnedBy(current.id, candidate))
    if (owners.length !== 1) break
    current = owners[0]!
  }
  throw new Error('无法确认当前主对话，请回到主对话创建工作流。')
}

