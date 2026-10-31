import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeBranches } from '../src/client/node-branches.tsx'
import { branchTop, newNode, nodePorts } from '../src/client/nodes.ts'

const renderers: ReactTestRenderer[] = []
function render(node: React.ComponentProps<typeof NodeBranches>['node']) {
  let renderer!: ReactTestRenderer
  act(() => { renderer = create(<NodeBranches node={node}/>) })
  renderers.push(renderer)
  return renderer
}
afterEach(() => { for (const renderer of renderers.splice(0)) act(() => renderer.unmount()) })

describe('compact branching node content', () => {
  it.each(['if', 'classifier', 'human'] as const)('preserves every %s output identity and its source order without adding controls', kind => {
    const node = newNode(kind), before = structuredClone(node), renderer = render(node)
    const rows = renderer.root.findAllByProps({className: 'vdw-node-branch-row'})
    expect(rows.map(row => row.props['data-port-id'])).toEqual(nodePorts(node).map(port => port.id))
    expect(renderer.root.findByProps({role: 'list'}).props.style.top).toBe(branchTop(node))
    expect(renderer.root.findAllByType('button')).toHaveLength(0)
    expect(node).toEqual(before)
  })

  it('shows condition labels, operators and real comparison values with complete hover descriptions', () => {
    const node = newNode('if', 0, 0, {cases: [
      {id: 'eligibility', logic: 'and', conditions: [{variable: 'input.score', operator: 'gte', value: '0'}, {variable: 'input.name', operator: 'not_empty'}]},
      {id: 'alternative', logic: 'or', conditions: [{variable: 'input.region', operator: 'equals', value: ''}, {variable: 'input.region', operator: 'contains', value: '北京'}]},
    ]})
    const rows = render(node).root.findAllByProps({className: 'vdw-node-branch-row'})
    expect(rows.map(row => row.findByProps({className: 'vdw-node-branch-label'}).children.join(''))).toEqual(['IF', 'ELIF', 'ELSE'])
    expect(rows.map(row => row.props.title)).toEqual([
      'IF · input.score ≥ 0 且 input.name 不为空',
      'ELIF · input.region = "" 或 input.region 包含 北京',
      'ELSE · 其他情况',
    ])
    expect(rows[1]!.findByProps({className: 'vdw-node-branch-summary'}).children.join('')).toContain('input.region')
  })

  it('supports legacy single conditions and makes incomplete conditions explicit', () => {
    const legacy = render(newNode('if', 0, 0, {variable: 'input.status', operator: 'equals', value: 'ready'}))
    expect(legacy.root.findByProps({'data-port-id': 'true'}).props.title).toBe('IF · input.status = ready')
    const empty = render(newNode('if', 0, 0, {cases: [{id: 'draft', conditions: []}]}))
    expect(empty.root.findByProps({'data-port-id': 'draft'}).props.title).toBe('IF · 未设置条件')
  })

  it('shows category descriptions without inventing text for categories that have none', () => {
    const node = newNode('classifier', 0, 0, {classes: [{id: 'business', label: '企业业务', description: '对公开户、贷款与账户问题'}, {id: 'personal', label: '个人业务'}, {id: 'draft', label: ''}]})
    const rows = render(node).root.findAllByProps({className: 'vdw-node-branch-row'})
    expect(rows[0]!.props.title).toBe('企业业务 · 对公开户、贷款与账户问题')
    expect(rows[1]!.findAllByProps({className: 'vdw-node-branch-summary'})).toHaveLength(0)
    expect(rows[2]!.props.title).toBe('未命名分类')
    expect(rows.map(row => row.props['data-port-id'])).toEqual(['business', 'personal', 'draft'])
  })

  it('distinguishes user actions from the real timeout branch and updates when its configuration changes', () => {
    const node = newNode('human', 0, 0, {actions: [{id: 'approve-stable', label: '确认继续'}, {id: 'reject-stable', label: '退回'}], timeoutSeconds: 90}), renderer = render(node)
    expect(renderer.root.findByProps({'data-port-id': 'approve-stable'}).props.title).toBe('确认继续 · 用户选择')
    expect(renderer.root.findByProps({'data-port-id': 'default'}).props.title).toBe('常规继续 · 任一常规行动后')
    expect(renderer.root.findByProps({'data-port-id': 'timeout'}).props.title).toBe('超时 · 90 秒未响应')
    act(() => renderer.update(<NodeBranches node={{...node, config: {...node.config, timeoutSeconds: 86400}}}/>))
    expect(renderer.root.findByProps({'data-port-id': 'timeout'}).props.title).toBe('超时 · 1 天未响应')
    expect(node.config.timeoutSeconds).toBe(90)
  })

  it('renders nothing for ordinary nodes and an unconfigured classifier has no fake ports', () => {
    expect(render(newNode('template')).toJSON()).toBeNull()
    expect(render(newNode('classifier', 0, 0, {classes: []})).root.findAllByProps({role: 'listitem'})).toHaveLength(0)
  })
})
