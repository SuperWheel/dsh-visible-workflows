import { describe, expect, it } from 'vitest'
import { displayNodeNumber, enumerateAnnotationNodes, resolveAnnotationNodes } from '../src/client/annotation-nodes.ts'
import type { NodeGraph, WorkflowNode } from '../src/shared/types.ts'

const node = (id: string, number: string, body?: NodeGraph): WorkflowNode => ({
  id, number, title: id, kind: body ? 'iteration' : 'template', x: 0, y: 0, fixed: false, config: body ? { body } : {},
})
const graph = (...nodes: WorkflowNode[]): NodeGraph => ({ nodes, edges: [] })
const sample = () => graph(node('container', 'a-4', graph(node('inner', 'a-4:a-1'), node('nested', 'a-4:a-2', graph(node('deep', 'a-4:a-2:a-1'))))), node('branch', 'a1-1'))

describe('scope-local display numbers', () => {
  it('uses only the last local number while preserving root and branch labels', () => {
    for (const number of ['a-1', 'a1-1', 'a1.2-3', 'aa-12', 'u-1', '', 'legacy']) expect(displayNodeNumber(number)).toBe(number)
    expect(displayNodeNumber('a-4:a-1')).toBe('a-1')
    expect(displayNodeNumber('a-4:a-2:a-1')).toBe('a-1')
    expect(displayNodeNumber('a-4:a1-2')).toBe('a1-2')
  })

  it('does not rewrite the stored structural number or stable ID', () => {
    const flow = sample(), before = structuredClone(flow)
    expect(enumerateAnnotationNodes(flow, ['container'])[0]).toMatchObject({ id: 'inner', number: 'a-1' })
    expect(flow).toEqual(before)
    expect(flow.nodes[0]!.config.body!.nodes[0]!.number).toBe('a-4:a-1')
  })
})

describe('scope-local annotation candidates', () => {
  it('lists only parent-layer nodes and never automatically exposes children', () => {
    expect(enumerateAnnotationNodes(sample())).toEqual([
      { id: 'container', number: 'a-4', title: 'container', ancestorIds: [] },
      { id: 'branch', number: 'a1-1', title: 'branch', ancestorIds: [] },
    ])
  })

  it('requires entering a child scope and lists only that level, including nested containers', () => {
    const flow = sample()
    expect(enumerateAnnotationNodes(flow, ['container'])).toEqual([
      { id: 'inner', number: 'a-1', title: 'inner', ancestorIds: ['container'] },
      { id: 'nested', number: 'a-2', title: 'nested', ancestorIds: ['container'] },
    ])
    expect(enumerateAnnotationNodes(flow, ['container', 'nested'])).toEqual([
      { id: 'deep', number: 'a-1', title: 'deep', ancestorIds: ['container', 'nested'] },
    ])
  })

  it('fails closed for removed or invalid scope paths instead of leaking parent candidates', () => {
    for (const path of [['removed'], ['container', 'removed'], ['branch']]) expect(enumerateAnnotationNodes(sample(), path)).toEqual([])
  })

  it('returns independent ancestor arrays and only one candidate per stable ID', () => {
    const flow = sample(), children = flow.nodes[0]!.config.body!
    children.nodes.push(children.nodes[0]!)
    const result = enumerateAnnotationNodes(flow, ['container'])
    expect(result.map(item => item.id)).toEqual(['inner', 'nested'])
    result[0]!.ancestorIds.push('metadata-only')
    expect(result[1]!.ancestorIds).toEqual(['container'])
  })
})

describe('legacy selected references', () => {
  it('resolves stable IDs across scopes without adding them to the available candidates', () => {
    const flow = sample()
    expect(resolveAnnotationNodes(flow, ['deep', 'branch', 'missing'])).toEqual([
      { id: 'deep', number: 'a-1', title: 'deep', ancestorIds: ['container', 'nested'] },
      { id: 'branch', number: 'a1-1', title: 'branch', ancestorIds: [] },
      { id: 'missing', number: '', title: '节点暂不可用', ancestorIds: [] },
    ])
    expect(enumerateAnnotationNodes(flow).map(item => item.id)).toEqual(['container', 'branch'])
  })
})
