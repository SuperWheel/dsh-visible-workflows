import { describe, expect, it } from 'vitest'
import { orderedExecutions } from '../src/client/execution-order.ts'
import { makeWorkflow, type WorkflowRun } from '../src/shared/types.ts'

function run(): WorkflowRun {
  const graph = makeWorkflow('workspace', '顺序', true), [input, template, output] = graph.nodes
  // Stored node order differs from flow order, as in compiled human-review graphs.
  graph.nodes = [input!, output!, template!]
  const record = (executionId: string, title: string) => ({ nodeId: executionId.split(/[/[]/).at(-1)!, executionId, title, number: title, status: 'success' as const })
  return { id: 'run', workflowId: graph.id, workspaceId: graph.workspaceId, workflowTitle: graph.title, sourceRevision: 1, graph, status: 'cancelled', inputs: {}, outputs: {}, startedAt: '2026-10-26T00:00:00Z',
    executions: [record(input!.id, 'a-1'), record(output!.id, 'a-3'), record('orphan', 'other'), record(template!.id, 'a-2'), record(`${template!.id}[0]/inner`, 'a-2 item 1'), record(`${template!.id}[1]/inner`, 'a-2 item 2')] }
}

describe('run detail execution order', () => {
  it('lists records in flow order, keeps nested and repeated steps after their container, and leaves unknown records last', () => {
    expect(orderedExecutions(run()).map(record => record.number)).toEqual(['a-1', 'a-2', 'a-2 item 1', 'a-2 item 2', 'a-3', 'other'])
  })
  it('falls back to stored graph order when the graph cannot be sorted', () => {
    const value = run(), [input, output] = value.graph.nodes
    value.graph.edges.push({ id: 'back', source: output!.id, target: input!.id })
    expect(orderedExecutions(value).map(record => record.number)).toEqual(['a-1', 'a-3', 'a-2', 'a-2 item 1', 'a-2 item 2', 'other'])
  })
})
