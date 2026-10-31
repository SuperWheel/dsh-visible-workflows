import { arrangeNodes, nodeSize, overlaps, type Rect } from './canvas-layout.ts'
import { moveAttachedNotes, noteSize } from './canvas-notes.ts'
import type { CanvasNote, NodeGraph, Workflow, WorkflowNode } from './types.ts'
import { allNodes } from './workflow-validation.ts'

/** Layout only the materialized copy, never declarations or module recipes. */
export function layoutPlanningCandidate(candidate: Workflow, baseline: Workflow, operation: 'create' | 'revise'): Workflow {
  const existing = new Set(allNodes(baseline).map(node => node.id))
  const visit = (graph: NodeGraph, notes: CanvasNote[] = [], frozen = false): NodeGraph => {
    const nodes = graph.nodes.map(node => node.config.body
      ? { ...node, config: { ...node.config, body: visit(node.config.body, [], frozen || node.fixed) } }
      : node)
    const keep = (node: WorkflowNode): boolean => frozen || node.fixed || operation === 'revise' && existing.has(node.id)
    const placed = new Map(nodes.filter(keep).map(node => [node.id, node]))
    const occupied: Rect[] = [...placed.values()].map(node => ({ ...node, ...nodeSize(node) }))
    const moving = new Set(nodes.filter(node => !keep(node)).map(node => node.id))
    for (const note of notes) if (!note.anchorNodeId || !moving.has(note.anchorNodeId)) occupied.push({ ...note, ...noteSize(note) })
    const desired = arrangeNodes({ ...graph, nodes })
    // Topological columns place new predecessors first even when declarations are reversed.
    for (const node of [...desired].sort((a, b) => a.x - b.x || a.y - b.y)) {
      if (placed.has(node.id)) continue
      let x = node.x, y = node.y
      if (operation === 'revise' && nodes.some(item => existing.has(item.id))) {
        const upstream = graph.edges.filter(edge => edge.target === node.id).map(edge => placed.get(edge.source)).find(Boolean)
        const downstream = graph.edges.filter(edge => edge.source === node.id).map(edge => placed.get(edge.target)).find(Boolean)
        if (upstream) { x = upstream.x + nodeSize(upstream).width + 80; y = upstream.y }
        else if (downstream) { x = downstream.x - nodeSize(node).width - 80; y = downstream.y }
      }
      const original = nodes.find(item => item.id === node.id)!
      const attached = notes.filter(note => note.anchorNodeId === node.id)
      const rectangles = (): Rect[] => [
        { x, y, ...nodeSize(node) },
        ...attached.map(note => ({ x: x + note.x - original.x, y: y + note.y - original.y, ...noteSize(note) })),
      ]
      // Only move the addition down. Every collision crosses an obstacle's lower
      // boundary, so this terminates without moving existing nodes or annotations.
      while (true) {
        let shift = 0
        for (const rect of rectangles()) for (const obstacle of occupied) {
          if (overlaps(rect, obstacle, 32)) shift = Math.max(shift, obstacle.y + obstacle.height + 64 - rect.y)
        }
        if (!shift) break
        y += shift
      }
      placed.set(node.id, { ...node, x, y })
      occupied.push(...rectangles())
    }
    return { ...graph, nodes: nodes.map(node => placed.get(node.id)!) }
  }
  const graph = visit(candidate, candidate.notes)
  return { ...candidate, ...graph, notes: moveAttachedNotes(candidate.notes, candidate.nodes, graph.nodes) }
}
