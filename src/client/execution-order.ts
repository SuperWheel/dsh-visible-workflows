import type { NodeExecution, WorkflowRun } from '../shared/types.ts'
import { topologicalNodes } from '../shared/workflow-validation.ts'

/** Records are stored in creation order; list them in flow order. Nested steps
 * follow their top-level container, and repeated steps keep their run order. */
export function orderedExecutions(run: WorkflowRun): NodeExecution[] {
  let nodes = run.graph.nodes
  try { nodes = topologicalNodes(run.graph) } catch { /* Keep the stored graph order. */ }
  const rank = new Map(nodes.map((node, index) => [node.id, index]))
  const position = (record: NodeExecution) => rank.get((record.executionId ?? record.nodeId).split(/[/[]/)[0]!) ?? nodes.length
  return run.executions.map((record, index) => ({record, index})).sort((a, b) => position(a.record) - position(b.record) || a.index - b.index).map(item => item.record)
}
