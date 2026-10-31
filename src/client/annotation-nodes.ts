import type { NodeGraph, WorkflowNode } from '../shared/types.ts'

/** A UI-only number. Persisted structural numbers and stable node IDs are unchanged. */
export function displayNodeNumber(rawNumber: string): string {
  return rawNumber.slice(rawNumber.lastIndexOf(':') + 1)
}

export interface AnnotationNodeMetadata {
  id: string
  number: string
  title: string
  ancestorIds: string[]
}

const metadata = (node: WorkflowNode, ancestorIds: readonly string[]): AnnotationNodeMetadata => ({
  id: node.id, number: displayNodeNumber(node.number), title: node.title, ancestorIds: [...ancestorIds],
})

/** Candidates belong only to the requested canvas scope, never its descendants. */
export function enumerateAnnotationNodes(graph: NodeGraph, scopePath: readonly string[] = []): AnnotationNodeMetadata[] {
  for (const id of scopePath) {
    const body = graph.nodes.find(node => node.id === id)?.config.body
    if (!body) return []
    graph = body
  }
  const seen = new Set<string>()
  const nodes: AnnotationNodeMetadata[] = []
  for (const node of graph.nodes) {
    if (seen.has(node.id)) continue
    seen.add(node.id)
    nodes.push(metadata(node, scopePath))
  }
  return nodes
}

/** Resolve existing references across scopes without offering those scopes as candidates. */
export function resolveAnnotationNodes(graph: NodeGraph, nodeIds: readonly string[]): AnnotationNodeMetadata[] {
  const wanted = new Set(nodeIds), found = new Map<string, AnnotationNodeMetadata>(), seen = new Set<string>()
  const visit = (scope: NodeGraph, ancestors: readonly string[]) => {
    for (const node of scope.nodes) {
      if (seen.has(node.id)) continue
      seen.add(node.id)
      if (wanted.has(node.id)) found.set(node.id, metadata(node, ancestors))
      if (node.config.body) visit(node.config.body, [...ancestors, node.id])
    }
  }
  visit(graph, [])
  return nodeIds.map(id => found.get(id) ?? { id, number: '', title: '节点暂不可用', ancestorIds: [] })
}
