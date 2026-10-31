import { describe, it, expect } from 'vitest'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { graphIssues, parseWorkflow, protectFixedNodes } from '../src/shared/workflow-validation.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'
import type { Workflow, WorkflowNode } from '../src/shared/types.ts'

// Regression tests for the 2026-10-20 shared planning audit (graph validation).
const node = (id: string, kind: WorkflowNode['kind'], config: Record<string, unknown>, fixed = false): WorkflowNode => ({ id, kind, config, title: id, number: id, x: 0, y: 0, fixed } as WorkflowNode)
const reviewed = (): Workflow => {
  const flow = templateContext().workflow
  flow.nodes = [node('start', 'input', { fields: [] }), node('prep', 'template', { text: 'x' }), node('review', 'human', { prompt: 'approve', fields: [], actions: [{ id: 'approve', label: 'Approve' }] }, true), node('out', 'output', { text: 'ok' })]
  flow.edges = [{ id: 'a', source: 'start', target: 'prep' }, { id: 'b', source: 'prep', target: 'review' }, { id: 'c', source: 'review', target: 'out', port: 'approve' }]
  return parseWorkflow(flow)
}
const withNode = (flow: Workflow, added: WorkflowNode, edges: Workflow['edges']): Workflow => ({ ...flow, nodes: [...flow.nodes, added], edges: [...flow.edges, ...edges] })

describe('new action nodes cannot bypass a fixed node (FIXED_BYPASS)', () => {
  it('rejects the audited input → native:write branch through the authoring compiler', () => {
    const base = templateContext(); base.operation = 'revise'; base.workflow.revision = 1
    base.workflow.nodes.splice(1, 0, { ...node('review', 'human', { prompt: 'approve', fields: [], actions: [{ id: 'approve', label: 'Approve' }] }), fixed: true })
    base.workflow.edges = [{ id: 'e1', source: 'host-start', target: 'review' }, { id: 'e2', source: 'review', target: 'host-end' }]; base.workflow.nodes[2]!.config.text = 'ok'
    base.tools = [{ id: 'native:write', name: 'write', description: '', available: true, providerId: 'p', providerName: 'P', category: 'native', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] as never
    const submit = () => new WorkflowAuthoringCompiler(base).submit({ submission: { mode: 'edit', addNodes: [{ key: 'write', kind: 'tool', config: { toolId: 'native:write', inputs: { text: 'write before review' } } }], addLinks: [{ key: 'bypass', source: 'n1', target: 'write' }], coverage: { R1: ['write'] } } })
    expect(submit).toThrow('绕过固定节点')
  })
  it.each([
    ['tool', node('w', 'tool', { toolId: 'native:write', inputs: {} })],
    ['http', node('w', 'http', { url: 'https://example.test', method: 'POST', headers: {}, timeoutMs: 1000 })],
    ['agent', node('w', 'agent', { prompt: 'x', tools: [], maxSteps: 2 })],
    ['document agent', node('w', 'document', { source: 'x', documentMode: 'agent' })],
    ['container with an action', node('w', 'loop', { maxIterations: 1, initialVariables: {}, body: { nodes: [node('w-in', 'input', { fields: [] }), node('w-tool', 'tool', { toolId: 'native:write', inputs: {} })], edges: [{ id: 'w-e', source: 'w-in', target: 'w-tool' }] } })],
  ])('rejects a new %s node reachable around the fixed node', (_, added) => {
    const before = reviewed()
    expect(() => protectFixedNodes(before, withNode(before, added, [{ id: 'x', source: 'prep', target: 'w' }]))).toThrow('绕过固定节点')
  })
  it('rejects a new action inside an existing container, or an existing node turned into an action', () => {
    const before = withNode(reviewed(), node('each', 'iteration', { iterator: '[1]', outputVariable: 'pure.text', errorMode: 'terminate', parallel: false, concurrency: 1,
      body: { nodes: [node('each-in', 'input', { fields: [] }), node('pure', 'template', { text: 'x' })], edges: [{ id: 'p', source: 'each-in', target: 'pure' }] } }), [{ id: 'x', source: 'start', target: 'each' }])
    const container = structuredClone(before), each = container.nodes.find(n => n.id === 'each')!
    each.config.body!.nodes.push(node('write', 'tool', { toolId: 'native:write', inputs: {} })); each.config.body!.edges.push({ id: 'q', source: 'pure', target: 'write' })
    expect(() => protectFixedNodes(before, container)).toThrow('绕过固定节点')
    const pureBranch = withNode(before, node('side', 'template', { text: 'x' }), [{ id: 's', source: 'start', target: 'side' }])
    const changed = structuredClone(pureBranch); Object.assign(changed.nodes.find(n => n.id === 'side')!, { kind: 'tool', config: { toolId: 'native:write', inputs: {} } })
    expect(() => protectFixedNodes(pureBranch, changed)).toThrow('绕过固定节点')
    const unchanged = structuredClone(before); unchanged.nodes.find(n => n.id === 'each')!.config.body!.nodes[1]!.config.text = 'edited'
    expect(() => protectFixedNodes(before, unchanged)).not.toThrow()
  })
  it('allows action nodes dominated by, or feeding into, the fixed node, and pure nodes elsewhere', () => {
    const before = reviewed()
    const tool = node('w', 'tool', { toolId: 'native:write', inputs: {} })
    expect(() => protectFixedNodes(before, withNode(before, tool, [{ id: 'x', source: 'out', target: 'w' }]))).not.toThrow()
    expect(() => protectFixedNodes(before, withNode(before, tool, [{ id: 'x', source: 'start', target: 'w' }, { id: 'y', source: 'w', target: 'prep' }]))).not.toThrow()
    expect(() => protectFixedNodes(before, withNode(before, node('w', 'template', { text: 'pure' }), [{ id: 'x', source: 'prep', target: 'w' }]))).not.toThrow()
  })
})

describe('if case ids cannot alias reserved ports (CASE_COLLISION)', () => {
  const flow = (cases: { id: string }[]) => {
    const value = templateContext().workflow
    value.nodes = [node('start', 'input', { fields: [{ name: 'flag', label: 'flag', required: true }] }), node('cond', 'if', { cases: cases.map(c => ({ ...c, conditions: [{ variable: 'input.flag', operator: 'equals', value: 'yes' }] })) }), node('matched', 'output', { text: 'M', outputName: 'match' }), node('fallback', 'output', { text: 'F', outputName: 'fallback' })]
    value.edges = [{ id: 's', source: 'start', target: 'cond' }, { id: 'm', source: 'cond', target: 'matched', port: cases[0]!.id }, { id: 'f', source: 'cond', target: 'fallback', port: 'false' }]
    return parseWorkflow(value)
  }
  it('rejects case id false, which aliases the fallback exit', () => {
    expect(graphIssues(flow([{ id: 'false' }]), false).map(i => i.message).join()).toContain('保留出口名：false')
  })
  it('accepts case id true, which is not a port in cases mode', () => {
    expect(graphIssues(flow([{ id: 'true' }]), true)).toEqual([])
  })
  it('rejects duplicate case ids', () => {
    expect(graphIssues(flow([{ id: 'yes' }, { id: 'yes' }]), false).map(i => i.message)).toContain('条件分支身份重复')
  })
  it('accepts unique ordinary case ids', () => {
    expect(graphIssues(flow([{ id: 'yes' }, { id: 'maybe' }]), true)).toEqual([])
  })
})
