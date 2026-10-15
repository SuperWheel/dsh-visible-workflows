import { describe, expect, it } from 'vitest'
import { renumberWorkflow } from '../src/shared/numbering.ts'
import { makeWorkflow, type WorkflowNode, type Workflow } from '../src/shared/types.ts'

const node = (id: string, kind: WorkflowNode['kind'] = 'template'): WorkflowNode => ({ id, kind, number: 'old', title: id, x: 0, y: 0, fixed: false, config: {} })
const edge = (source: string, target: string, port?: 'true' | 'false') => ({ id: `${source}-${target}`, source, target, port })
const numbers = (flow: Workflow) => Object.fromEntries(flow.nodes.map(n => [n.id, n.number]))
function graph(nodes: WorkflowNode[], edges: Workflow['edges']): Workflow { return { ...makeWorkflow('workspace-test'), nodes, edges } }

describe('结构编号与稳定身份', () => {
  it('插入、删除中间节点连续重编号，身份和模板引用完全不改写', () => {
    const original = graph([node('input', 'input'), node('end', 'output')], [edge('input', 'end')])
    original.nodes[1]!.config.text = '{{input.text}}'
    const before = renumberWorkflow(original)
    expect(numbers(before)).toEqual({ input: 'a-1', end: 'a-2' })
    const inserted = renumberWorkflow({ ...before, nodes: [...before.nodes, node('inserted')], edges: [edge('input', 'inserted'), edge('inserted', 'end')] })
    expect(numbers(inserted)).toEqual({ input: 'a-1', end: 'a-3', inserted: 'a-2' })
    expect(inserted.nodes[1]!.id).toBe('end'); expect(inserted.nodes[1]!.config).toEqual(before.nodes[1]!.config)
    expect(numbers(renumberWorkflow(original))).toEqual(numbers(before))
  })
  it('入口并行 a/b、内部替代 a1 和不等长汇合回主路径', () => {
    const flow = graph([node('00-input', 'input'), node('10-main'), node('20-parallel'), node('30-condition', 'if'), node('40-direct'), node('50-alt'), node('60-join', 'output')], [edge('00-input', '10-main'), edge('00-input', '20-parallel'), edge('10-main', '30-condition'), edge('30-condition', '40-direct', 'true'), edge('30-condition', '50-alt', 'false'), edge('40-direct', '60-join'), edge('50-alt', '60-join'), edge('20-parallel', '60-join')])
    expect(numbers(renumberWorkflow(flow))).toEqual({ '00-input': 'a-1', '10-main': 'a-2', '20-parallel': 'b-1', '30-condition': 'a-3', '40-direct': 'a-4', '50-alt': 'a1-1', '60-join': 'a-5' })
  })
  it('子分支嵌套得到 a1.1，内部汇合回 a1，外层汇合回 a', () => {
    const flow = graph([node('input', 'input'), node('outer', 'if'), node('direct'), node('inner', 'if'), node('short'), node('deep'), node('inner-join'), node('outer-join', 'output')], [edge('input', 'outer'), edge('outer', 'direct', 'true'), edge('outer', 'inner', 'false'), edge('inner', 'short', 'true'), edge('inner', 'deep', 'false'), edge('short', 'inner-join'), edge('deep', 'inner-join'), edge('inner-join', 'outer-join'), edge('direct', 'outer-join')])
    const result = numbers(renumberWorkflow(flow))
    expect(result.inner).toBe('a1-1'); expect(result.deep).toBe('a1.1-1'); expect(result['inner-join']).toBe('a1-3'); expect(result['outer-join']).toBe('a-4')
  })
  it('移动坐标、重排 API 数组、重复计算均不改变结构编号', () => {
    const flow = graph([node('input', 'input'), node('alpha'), node('beta'), node('join', 'output')], [edge('input', 'alpha'), edge('input', 'beta'), edge('alpha', 'join'), edge('beta', 'join')])
    const before = renumberWorkflow(flow)
    const moved = { ...before, nodes: before.nodes.map(n => ({ ...n, x: -n.x + 901, y: 412 })).reverse(), edges: [...before.edges].reverse() }
    expect(numbers(renumberWorkflow(moved))).toEqual(numbers(before))
    expect(numbers(renumberWorkflow(before))).toEqual(numbers(before))
    expect(flow.nodes.every(n => n.number === 'old')).toBe(true)
  })
  it('孤立节点用 u，重新连接后进入结构编号，30条并行与跨边仍唯一', () => {
    const leaves = Array.from({ length: 30 }, (_, i) => node(`branch-${i.toString().padStart(2, '0')}`))
    const flow = graph([node('input', 'input'), ...leaves, node('isolated')], leaves.map(n => edge('input', n.id)))
    const initial = renumberWorkflow(flow)
    expect(numbers(initial).isolated).toBe('u-1')
    expect(new Set(initial.nodes.map(n => n.number)).size).toBe(initial.nodes.length)
    const connected = renumberWorkflow({ ...initial, edges: [...initial.edges, edge(leaves[29]!.id, 'isolated'), edge(leaves[0]!.id, 'isolated')] })
    expect(numbers(connected).isolated).toMatch(/^a-/)
    expect(new Set(connected.nodes.map(n => n.number)).size).toBe(connected.nodes.length)
  })
})
