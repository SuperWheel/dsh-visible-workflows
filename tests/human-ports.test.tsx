import React, { useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodePanel } from '../src/client/forms.tsx'
import { NodeBranches } from '../src/client/node-branches.tsx'
import { branchTop, newNode, nodePorts, nodeSize, portY } from '../src/client/nodes.ts'
import { WorkflowStore } from '../src/client/store.ts'
import { createViewportIndex } from '../src/client/viewport.ts'
import { makeWorkflow, type Workflow, type WorkflowAPI } from '../src/shared/types.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: 'button', Input: 'input', Switch: 'input', Modal: () => null,
  Tooltip: ({children}: {children: React.ReactNode}) => children,
  Menu: ({anchor}: {anchor: React.ReactNode}) => anchor,
}))
const renderers: ReactTestRenderer[] = [], stores: WorkflowStore[] = []
afterEach(() => {
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount())
  for (const store of stores.splice(0)) store.dispose()
})

function sample(defaultPort: 'default' | null = 'default'): Workflow {
  const input = {...newNode('input'), id: 'start'}
  const human = {...newNode('human', 320, 100, {fields: [], prompt: '请确认', actions: [{id: 'approve', label: '确认继续'}, {id: 'revise', label: '返回修改'}], timeoutSeconds: 60}), id: 'human'}
  const targets = ['normal', 'approved', 'revised', 'timed-out'].map((id, index) => ({...newNode('template', 700, index * 120), id}))
  return {...makeWorkflow('workspace', '人工出口兼容'), nodes: [input, human, ...targets], edges: [
    {id: 'into-human', source: input.id, target: human.id},
    {id: 'default-edge', source: human.id, target: 'normal', ...(defaultPort ? {port: defaultPort} : {})},
    {id: 'approve-edge', source: human.id, target: 'approved', port: 'approve'},
    {id: 'revise-edge', source: human.id, target: 'revised', port: 'revise'},
    {id: 'timeout-edge', source: human.id, target: 'timed-out', port: 'timeout'},
  ], notes: []}
}

function mountPanel(initial: Workflow) {
  const store = new WorkflowStore({} as WorkflowAPI), edits = vi.fn()
  stores.push(store); store.update({workflow: initial, loading: false})
  let current = initial, renderer!: ReactTestRenderer
  function Fixture() {
    const [flow, setFlow] = useState(initial); current = flow
    return <NodePanel node={flow.nodes.find(node => node.id === 'human')!} flow={flow} store={store} disabled={false} onClose={() => {}} onSettings={() => {}} onEnter={() => {}}
      onEdit={next => { edits(next); store.update({workflow: next}); setFlow(next) }}/>
  }
  act(() => { renderer = create(<Fixture/>) }); renderers.push(renderer)
  return {renderer, edits, flow: () => current}
}

describe('human output ports agree with the host contract', () => {
  it('retains action order and adds a separate normal default continuation before timeout', () => {
    const human = sample().nodes.find(node => node.id === 'human')!
    expect(nodePorts(human)).toEqual([
      {id: 'approve', label: '确认继续'}, {id: 'revise', label: '返回修改'},
      {id: 'default', label: '常规继续'}, {id: 'timeout', label: '超时'},
    ])
  })

  it('matches the host fallback action when older configuration omits actions', () => {
    expect(nodePorts(newNode('human', 0, 0, {}))).toEqual([
      {id: 'continue', label: '继续'}, {id: 'default', label: '常规继续'}, {id: 'timeout', label: '超时'},
    ])
  })

  it('keeps older explicitly named default or timeout actions connectable without duplicate port IDs', () => {
    const node = newNode('human', 0, 0, {actions: [{id: 'default', label: '原继续'}, {id: 'timeout', label: '原超时'}, {id: 'approve', label: '确认'}]})
    expect(nodePorts(node)).toEqual([{id: 'default', label: '原继续'}, {id: 'timeout', label: '原超时'}, {id: 'approve', label: '确认'}])
  })

  it.each([{name: 'explicit default', port: 'default'}, {name: 'omitted port', port: null}] as const)('renaming the actual NodePanel preserves an existing $name continuation edge', ({port}) => {
    const flow = sample(port), before = structuredClone(flow), f = mountPanel(flow)
    act(() => f.renderer.root.findByProps({'aria-label': '节点名称'}).props.onChange({target: {value: '人工校验'}}))
    expect(f.edits).toHaveBeenCalledOnce()
    expect(f.flow().nodes.find(node => node.id === 'human')!.title).toBe('人工校验')
    expect(f.flow().edges).toEqual(before.edges)
    expect(flow).toEqual(before)
  })

  it('removing one action in the actual NodePanel removes only its edge and preserves default, timeout and other actions', () => {
    const f = mountPanel(sample())
    act(() => f.renderer.root.findByProps({'aria-label': '删除行动 2'}).props.onClick())
    expect(f.flow().nodes.find(node => node.id === 'human')!.config.actions?.map(action => action.id)).toEqual(['approve'])
    expect(f.flow().edges.map(edge => edge.id)).toEqual(['into-human', 'default-edge', 'approve-edge', 'timeout-edge'])
    expect(f.flow().edges.find(edge => edge.id === 'default-edge')!.port).toBe('default')
  })

  it('keeps rendered rows, source-port coordinates and viewport curves aligned for every human output', () => {
    const flow = sample(), human = flow.nodes.find(node => node.id === 'human')!
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<NodeBranches node={human}/>) }); renderers.push(renderer)
    const rows = renderer.root.findAllByProps({role: 'listitem'}), ports = nodePorts(human)
    expect(rows.map(row => row.props['data-port-id'])).toEqual(['approve', 'revise', 'default', 'timeout'])
    expect(renderer.root.findByProps({'data-port-id': 'default'}).props.title).toBe('常规继续 · 任一常规行动后')
    expect(renderer.root.findByProps({'data-port-id': 'timeout'}).props.title).toBe('超时 · 1 分钟未响应')
    expect(nodeSize(human).height).toBe(branchTop(human) + ports.length * 32 + 8)
    const index = createViewportIndex(flow.nodes, flow.edges)
    for (const [position, port] of ports.entries()) {
      expect(portY(human, port.id)).toBe(branchTop(human) + position * 32 + 16)
      const curve = index.edges.find(curve => curve.edge.source === human.id && (curve.edge.port ?? 'default') === port.id)!
      expect(curve.start).toEqual({x: human.x + nodeSize(human).width, y: human.y + portY(human, port.id)})
    }
  })
})
