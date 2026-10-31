import { describe, expect, it } from 'vitest'
import { arrangeNodes, nodeSize, overlaps } from '../src/shared/canvas-layout.ts'
import { arrangeNodes as clientArrange } from '../src/client/layout.ts'
import { nodeSize as clientSize } from '../src/client/nodes.ts'
import { noteSize } from '../src/shared/canvas-notes.ts'
import { materializePlanningCandidate, planningCandidateIssues, projectWorkflow } from '../src/shared/planning-projection.ts'
import { layoutPlanningCandidate } from '../src/shared/planning-layout.ts'
import { allNodes, parseWorkflow } from '../src/shared/workflow-validation.ts'
import type { NodeGraph, Workflow, WorkflowNode } from '../src/shared/types.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'

const node = (id: string, kind: WorkflowNode['kind'] = 'template', config: WorkflowNode['config'] = {}): WorkflowNode => ({ id, kind, config, title: id, number: id, x: 0, y: 0, fixed: false })
const chain = (...nodes: WorkflowNode[]): NodeGraph => ({ nodes, edges: nodes.slice(1).map((n, i) => ({ id: `edge-${n.id}`, source: nodes[i]!.id, target: n.id })) })
const coordinates = (nodes: WorkflowNode[]) => nodes.map(({ id, x, y }) => ({ id, x, y }))
function separated(graph: NodeGraph): void {
  for (const [i, a] of graph.nodes.entries()) for (const b of graph.nodes.slice(i + 1)) expect(overlaps({ ...a, ...nodeSize(a) }, { ...b, ...nodeSize(b) }, 32)).toBe(false)
  for (const n of graph.nodes) if (n.config.body) separated(n.config.body)
}
function create(graph: NodeGraph) {
  const context = templateContext()
  context.nodeIds.push(...allNodes(graph).map(n => n.id))
  const projection = projectWorkflow(parseWorkflow({ ...context.workflow, ...graph }))
  return { context, projection, result: materializePlanningCandidate(JSON.stringify(projection), context) }
}

describe('T27 shared and Host canvas layout', () => {
  it('matches the pre-T27 client coordinates for mixed dimensions and keeps the same client exports', () => {
    const input = node('input', 'input'), loop = node('loop', 'loop'), branch = node('branch', 'if', { cases: Array.from({ length: 15 }, (_, i) => ({ id: `case${i}`, logic: 'and', conditions: [] })) }), output = node('output', 'output')
    const graph = { nodes: [input, loop, branch, output], edges: [{ id: 'a', source: input.id, target: loop.id }, { id: 'b', source: input.id, target: branch.id }, { id: 'c', source: loop.id, target: output.id }, { id: 'd', source: branch.id, target: output.id }] }
    // Golden coordinates from the original client algorithm at 745ddad.
    expect(coordinates(arrangeNodes(graph))).toEqual([{ id: 'input', x: 64, y: 80 }, { id: 'loop', x: 400, y: 80 }, { id: 'branch', x: 400, y: 364 }, { id: 'output', x: 960, y: 80 }])
    expect(clientArrange).toBe(arrangeNodes)
    expect(clientSize).toBe(nodeSize)
    separated({ ...graph, nodes: arrangeNodes(graph) })
    expect(nodeSize({ ...branch, note: '长备注'.repeat(600) })).toEqual(nodeSize(branch))
  })

  it('retains legacy human/classifier branch sizing including reserved and duplicate action IDs', () => {
    expect(nodeSize(node('human', 'human'))).toEqual({ width: 256, height: 184 })
    expect(nodeSize(node('human', 'human', { actions: [] })).height).toBe(152)
    expect(nodeSize(node('human', 'human', { actions: [{ id: 'default', label: 'a' }, { id: 'default', label: 'b' }, { id: 'timeout', label: 'c' }] })).height).toBe(184)
    expect(nodeSize(node('class', 'classifier', { classes: [{ id: 'one', label: '1' }, { id: 'two', label: '2' }] })).height).toBe(180)
  })

  it('lays out every create scope, including nested iteration and loop bodies, without changing semantics', () => {
    const graph = chain(node('start', 'input'), node('loop', 'loop', { maxIterations: 2, body: chain(node('inner', 'input'), node('each', 'iteration', { iterator: 'input.items', body: chain(node('deep', 'input'), node('deep-end', 'output', { text: 'done' })) }), node('inner-end', 'output', { text: 'done' })) }), node('end', 'output', { text: 'done' }))
    const { context, projection, result } = create(graph), before = structuredClone(context)
    const check = (g: NodeGraph): void => { expect(g.nodes).toEqual(arrangeNodes(g)); for (const n of g.nodes) if (n.config.body) check(n.config.body) }
    check(result); separated(result)
    expect(projectWorkflow(result)).toEqual(projection)
    expect(materializePlanningCandidate(JSON.stringify(projection), context)).toEqual(result)
    expect(context).toEqual(before)
  })

  it('lays out reused create entry IDs while preserving fixed nodes and their complete bodies', () => {
    const context = templateContext()
    const result = materializePlanningCandidate(JSON.stringify(projectWorkflow(context.workflow)), context)
    expect(result.nodes.map(n => [n.x, n.y])).toEqual([[64, 80], [400, 80]])
    expect(planningCandidateIssues(result, context)).toEqual([])
    const fixed = { ...node('fixed', 'loop', { body: chain(node('child'), node('child2')) }), fixed: true, x: 64, y: 80 }
    const flow: Workflow = { ...context.workflow, ...chain(node('first'), fixed, node('last')) }
    const laid = layoutPlanningCandidate(flow, flow, 'create')
    expect(laid.nodes[1]).toEqual(fixed)
    expect(laid.nodes[0]!.y).toBeGreaterThan(fixed.y + nodeSize(fixed).height)
    for (const n of [laid.nodes[0]!, laid.nodes[2]!]) expect(overlaps({ ...n, ...nodeSize(n) }, { ...fixed, ...nodeSize(fixed) }, 32)).toBe(false)
  })

  it('places new nodes in dependency order to the right, avoiding existing cards and free/anchored notes', () => {
    const context = templateContext(); context.operation = 'revise'
    context.workflow.nodes[0] = { ...context.workflow.nodes[0]!, x: 100, y: 100, fixed: true }
    context.workflow.nodes[1] = { ...context.workflow.nodes[1]!, x: 436, y: 100 }
    context.workflow.notes = [{ id: 'free', text: 'free', x: 436, y: 244 }, { id: 'attached', text: 'attached', x: 436, y: 600, anchorNodeId: 'host-end' }]
    const before = structuredClone(context.workflow), projection = projectWorkflow(before)
    projection.nodes.push({ id: 'allocated-1', kind: 'template', title: 'second', config: {} }, { id: 'allocated-0', kind: 'template', title: 'first', config: {} })
    projection.edges = [{ source: 'host-start', target: 'allocated-0' }, { source: 'allocated-0', target: 'allocated-1' }, { source: 'allocated-1', target: 'host-end' }]
    const result = materializePlanningCandidate(JSON.stringify(projection), context)
    expect(result.nodes.slice(0, 2)).toEqual(before.nodes)
    expect(result.notes).toEqual(before.notes)
    const a = result.nodes.find(n => n.id === 'allocated-0')!, b = result.nodes.find(n => n.id === 'allocated-1')!
    expect(a.x).toBe(436); expect(b.x).toBe(a.x + nodeSize(a).width + 80)
    separated(result)
    for (const added of [a, b]) for (const note of before.notes) expect(overlaps({ ...added, ...nodeSize(added) }, { ...note, ...noteSize(note) }, 32)).toBe(false)
    expect(materializePlanningCandidate(JSON.stringify(projection), context)).toEqual(result)
    expect(context.workflow).toEqual(before)
  })

  it('uses a downstream node on the left when there is no upstream and arranges a new container body', () => {
    const context = templateContext(); context.operation = 'revise'; context.workflow.nodes[0]!.x = 1000
    const projection = projectWorkflow(context.workflow)
    projection.nodes.push({ id: 'allocated-0', kind: 'loop', title: 'new', config: { body: { nodes: [{ id: 'allocated-1', kind: 'input', title: 'entry', config: {} }, { id: 'allocated-2', kind: 'output', title: 'exit', config: { text: 'done' } }], edges: [{ source: 'allocated-1', target: 'allocated-2' }] } } })
    projection.edges.push({ source: 'allocated-0', target: 'host-start' })
    const result = materializePlanningCandidate(JSON.stringify(projection), context), added = result.nodes.at(-1)!
    expect(added.x).toBe(1000 - 480 - 80)
    expect(added.config.body!.nodes.map(n => [n.x, n.y])).toEqual([[64, 80], [400, 80]])
    expect(result.nodes.slice(0, 2)).toEqual(context.workflow.nodes)
  })

  it('moves attached notes by the anchor delta and preserves free notes on create', () => {
    const context = templateContext(), flow = context.workflow
    flow.notes = [{ id: 'attached', text: 'memo', x: 0, y: 100, anchorNodeId: 'host-start' }, { id: 'free', text: 'free', x: 400, y: 80 }]
    const result = layoutPlanningCandidate(flow, flow, 'create')
    expect(result.notes[0]!.x - flow.notes[0]!.x).toBe(result.nodes[0]!.x - flow.nodes[0]!.x)
    expect(result.notes[0]!.y - flow.notes[0]!.y).toBe(result.nodes[0]!.y - flow.nodes[0]!.y)
    expect(result.notes[1]).toEqual(flow.notes[1])
    for (const n of result.nodes) for (const note of result.notes) expect(overlaps({ ...n, ...nodeSize(n) }, { ...note, ...noteSize(note) })).toBe(false)
  })

  it('terminates deterministically on cycles and disconnected additions', () => {
    const context = templateContext(), flow = { ...context.workflow, ...chain(node('a'), node('b'), node('c')) }
    flow.edges.push({ id: 'back', source: 'c', target: 'a' }); flow.nodes.push(node('isolated'))
    const result = layoutPlanningCandidate(flow, flow, 'create')
    expect(result.nodes).toEqual(arrangeNodes(flow)); separated(result)
    expect(layoutPlanningCandidate(flow, flow, 'create')).toEqual(result)
  })
})
