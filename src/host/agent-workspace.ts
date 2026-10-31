import { realpathSync } from 'node:fs'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'

interface RegisteredWorkspace {
  readonly id: string
  readonly path: string
  readonly sessionIds: readonly string[]
}

/** Path identity as the SDK workspace registry judges membership: canonical
 * (realpath) equality, so /tmp vs /private/tmp, symlinks or a trailing slash do
 * not detach a registered conversation. An unresolvable path never matches. */
export function sameWorkspacePath(left: string, right: string): boolean {
  if (left === right) return true
  try { return realpathSync.native(left) === realpathSync.native(right) } catch { return false }
}

/** Resolve only live SDK identities. Durable parentSession and cwd are data,
 * not authority: each inherited hop also needs the registry's exact runtime
 * owner. No session registration is added, and no historical Agent is resumed. */
export function resolveAgentWorkspace(
  agent: Agent,
  workspaces: readonly RegisteredWorkspace[],
  agents: Pick<AgentRegistry, 'get' | 'isOwnedBy'>,
  samePath: (left: string, right: string) => boolean = sameWorkspacePath,
): string | undefined {
  const cwd = agent.session.header.cwd
  if (!cwd) return undefined
  const visited = new Set<string>()
  let current = agent
  while (!visited.has(current.id)) {
    visited.add(current.id)
    if (agents.get(current.id) !== current || current.session.id !== current.id || !samePath(current.session.header.cwd ?? '', cwd)) return undefined
    const matches = workspaces.filter(workspace => workspace.sessionIds.includes(current.id) && samePath(workspace.path, cwd))
    if (matches.length) return matches.length === 1 ? matches[0]!.id : undefined
    const header = current.session.header
    if (header.origin !== 'subagent' || !header.parentSession || typeof agents.isOwnedBy !== 'function') return undefined
    const parent = agents.get(header.parentSession)
    if (!parent || !agents.isOwnedBy(current.id, parent)) return undefined
    current = parent
  }
  return undefined
}
