import type { Workflow, WorkflowEdge } from './types.ts'

/**
 * Deterministic display numbering for DAGs and nested containers. Node/edge identities are never rewritten.
 * The current schema has no saved main-path/port-order metadata, so the declared
 * true branch wins, then stable target identity. Pixel positions and array order
 * never decide the path. `u` is reserved for disconnected/invalid draft nodes.
 * Container numbers prefix their local path; UUID-based references never change.
 */
export function renumberWorkflow(flow: Workflow): Workflow {
  const nodes = new Map(flow.nodes.map(n => [n.id, n]))
  const edges = flow.edges.filter(e => nodes.has(e.source) && nodes.has(e.target))
  const incoming = new Map<string, WorkflowEdge[]>(), outgoing = new Map<string, WorkflowEdge[]>()
  for (const node of flow.nodes) { incoming.set(node.id, []); outgoing.set(node.id, []) }
  for (const edge of edges) { incoming.get(edge.target)!.push(edge); outgoing.get(edge.source)!.push(edge) }
  const edgeCompare = (a: WorkflowEdge, b: WorkflowEdge) => ((a.port === 'false' ? 1 : 0) - (b.port === 'false' ? 1 : 0)) || a.target.localeCompare(b.target) || a.id.localeCompare(b.id)
  for (const list of outgoing.values()) list.sort(edgeCompare)
  const roots = flow.nodes.filter(n => n.kind === 'input' && !incoming.get(n.id)!.length).sort((a,b) => a.id.localeCompare(b.id))
  const rootIds = new Set(roots.map(n => n.id)), reached = new Set(rootIds)
  const traversal = [...rootIds]
  for (let i = 0; i < traversal.length; i++) for (const edge of outgoing.get(traversal[i]!) ?? []) if (!reached.has(edge.target)) { reached.add(edge.target); traversal.push(edge.target) }

  const rootPrefix = (index: number): string => {
    let text = '', value = index + 1
    while (value > 0) { value--; text = String.fromCharCode(97 + value % 26) + text; value = Math.floor(value / 26) }
    return text
  }
  let rootIndex = 0
  const parents = new Map<string, string | undefined>(), rootPaths = new Map<string, string>()
  const newRoot = () => {
    let path: string
    do { path = rootPrefix(rootIndex++) } while (path === 'u')
    parents.set(path, path === 'a' ? undefined : 'a'); return path
  }
  for (const root of roots) rootPaths.set(root.id, newRoot())
  const branchCounts = new Map<string, number>(), pathCounts = new Map<string, number>()
  const edgePaths = new Map<string, string>(), assigned = new Map<string, string>()
  const childPath = (parent: string): string => {
    const count = (branchCounts.get(parent) ?? 0) + 1; branchCounts.set(parent, count)
    const path = /^[a-z]+$/.test(parent) ? `${parent}${count}` : `${parent}.${count}`
    parents.set(path, parent); return path
  }
  const ancestry = (path: string): string[] => { const list = [path]; let p = parents.get(path); while (p) { list.push(p); p = parents.get(p) } return list }
  const commonPath = (paths: string[]): string => {
    if (!paths.length) return 'u'
    const other = paths.slice(1).map(path => new Set(ancestry(path)))
    return ancestry(paths[0]!).find(path => other.every(set => set.has(path))) ?? 'a'
  }
  const pending = new Map(flow.nodes.map(n => [n.id, incoming.get(n.id)!.length]))
  const queue = flow.nodes.filter(n => pending.get(n.id) === 0).map(n => n.id).sort()
  while (queue.length) {
    const id = queue.shift()!, node = nodes.get(id)!
    const path = rootPaths.get(id) ?? (reached.has(id) ? commonPath(incoming.get(id)!.map(e => edgePaths.get(e.id)).filter((v): v is string => !!v)) : 'u')
    const index = (pathCounts.get(path) ?? 0) + 1; pathCounts.set(path, index); assigned.set(id, `${path}-${index}`)
    const outputs = outgoing.get(id)!
    // Parallel arcs to the same target are one logical destination for display numbering.
    const destinations = [...new Set(outputs.map(e => e.target))]
    const destinationPaths = new Map<string, string>()
    for (const [i, target] of destinations.entries()) destinationPaths.set(target, i === 0 || path === 'u' ? path : rootIds.has(id) ? newRoot() : childPath(path))
    for (const edge of outputs) {
      edgePaths.set(edge.id, destinationPaths.get(edge.target)!)
      const count = pending.get(edge.target)! - 1; pending.set(edge.target, count)
      if (count === 0) { queue.push(edge.target); queue.sort() }
    }
  }
  // Cycles remain invalid at Host validation; editor previews still get unique temporary labels.
  for (const id of [...nodes.keys()].filter(id => !assigned.has(id)).sort()) { const index = (pathCounts.get('u') ?? 0) + 1; pathCounts.set('u', index); assigned.set(id, `u-${index}`) }
  return { ...flow, nodes: flow.nodes.map(node => {
    const number = assigned.get(node.id)!
    if (!node.config.body) return { ...node, number }
    const inner = renumberWorkflow({ ...flow, ...node.config.body, notes: [] })
    const prefix = (nodes: typeof flow.nodes): typeof flow.nodes => nodes.map(child => ({ ...child, number: `${number}:${child.number}`, config: child.config.body ? { ...child.config, body: { ...child.config.body, nodes: prefix(child.config.body.nodes) } } : child.config }))
    return { ...node, number, config: { ...node.config, body: { nodes: prefix(inner.nodes), edges: inner.edges } } }
  }) }
}
