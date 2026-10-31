import type { Workflow, WorkflowEdge, NodeGraph, WorkflowNode } from './types.ts'

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
    const id = queue.shift()!
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


const numberedNodes=(graph:NodeGraph):WorkflowNode[]=>graph.nodes.flatMap(node=>[node,...(node.config.body?numberedNodes(node.config.body):[])])
/** Host-owned numbering for a planning/proposal candidate. Keep saved IDs' numbers;
 * deterministically allocate only genuinely new nodes, with each final container prefix.
 * This is deliberately separate from ordinary user/agent save renumbering.
 */
export function normalizePlanningWorkflowNumbers(flow:Workflow,baseline:Workflow):Workflow {
  const baselineNodes=new Map(numberedNodes(baseline).map(node=>[node.id,node]))
  const materialized = renumberWorkflow(flow)
  // Existing presentation numbers are not model edits. In particular, a fixed
  // container's whole saved body must not change merely through projection.
  for (const node of numberedNodes(materialized)) { const previous = baselineNodes.get(node.id); if (previous) node.number = previous.number }
  // Restoring saved numbers can occupy a newly inserted node's generated number
  // (input a-1 -> new a-2 -> saved output a-2). Reserve every surviving saved
  // number first, then allocate only new nodes. Keep generated branch labels and
  // use the final container number as the prefix for new descendants.
  const usedNumbers = new Set(numberedNodes(materialized).filter(node => baselineNodes.has(node.id)).map(node => node.number))
  const numberNewNodes = (graph: NodeGraph, prefix = ''): void => {
    const added = graph.nodes.filter(node => !baselineNodes.has(node.id)).map(node => ({ node, local: node.number.slice(node.number.lastIndexOf(':') + 1) }))
      .sort((left, right) => left.local.localeCompare(right.local) || left.node.id.localeCompare(right.node.id))
    const collisions: typeof added = []
    for (const item of added) {
      const preferred = `${prefix}${item.local}`
      if (usedNumbers.has(preferred)) collisions.push(item)
      else { item.node.number = preferred; usedNumbers.add(preferred) }
    }
    for (const { node, local } of collisions) {
      const match = local.match(/^(.*-)(\d+)$/)!
      let ordinal = Number(match[2]), number: string
      do { number = `${prefix}${match[1]}${++ordinal}` } while (usedNumbers.has(number))
      node.number = number; usedNumbers.add(number)
    }
    for (const node of graph.nodes) if (node.config.body) numberNewNodes(node.config.body, `${node.number}:`)
  }
  numberNewNodes(materialized)
  return materialized
}
/** Display metadata is not authority supplied by an agent or an old proposal.
 * Compare against the current saved graph too: definition digests ignore numbers.
 */
export function assertExistingWorkflowNumbers(flow:Workflow,baseline:Workflow):void {
  const previous=new Map(numberedNodes(baseline).map(node=>[node.id,node.number]))
  for(const node of numberedNodes(flow))if(previous.has(node.id)&&node.number!==previous.get(node.id))throw new Error('WORKFLOW_NUMBER_CONFLICT: 已有节点编号已变化，请重新生成或核对提案：'+node.id)
  const agents=new Map((baseline.subAgents??[]).map(agent=>[agent.id,agent.number]))
  for(const agent of flow.subAgents??[])if(agents.has(agent.id)&&agent.number!==agents.get(agent.id))throw new Error('WORKFLOW_NUMBER_CONFLICT: 已有子 Agent 编号不能由提案改写：'+agent.id)
}
/** Acceptance must persist the very numbering already reviewed, never reassign it. */
export function assertReviewedWorkflowNumbers(flow:Workflow,baseline:Workflow):void {
  assertExistingWorkflowNumbers(flow,baseline)
  const nodes=numberedNodes(flow),numbers=new Set<string>()
  for(const node of nodes){if(!node.number.trim()||numbers.has(node.number))throw new Error('WORKFLOW_NUMBER_CONFLICT: 候选节点编号必须非空且唯一');numbers.add(node.number)}
  const expected=new Map(numberedNodes(normalizePlanningWorkflowNumbers(flow,baseline)).map(node=>[node.id,node.number]))
  for(const node of nodes)if(node.number!==expected.get(node.id))throw new Error('WORKFLOW_NUMBER_CONFLICT: 候选新节点编号与 Host 规范器不一致，请重新生成提案：'+node.id)
}
