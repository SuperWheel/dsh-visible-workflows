import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasTopActions, type CanvasTopActionsProps } from '../src/client/canvas-top-actions.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: 'button', Tooltip: ({children, label, side}: {children: React.ReactNode; label: string; side?: string}) => <tooltip-mock label={label} side={side}>{children}</tooltip-mock>,
  Menu: ({anchor, items, open, ...props}: any) => <menu-mock {...props} open={open} items={items}>{anchor}{open && items.map((item: any) => <button key={item.id} role="menuitem" disabled={item.disabled} onClick={() => props.onSelect(item.id)}>{item.label}</button>)}</menu-mock>,
}))

const renderers: ReactTestRenderer[] = []
afterEach(() => { for (const renderer of renderers.splice(0)) act(() => renderer.unmount()) })
function fixture(overrides: Partial<CanvasTopActionsProps> = {}) {
  const callbacks = {onToggleAnnotation: vi.fn(), onDuplicate: vi.fn(), onDelete: vi.fn(), onAgent: vi.fn()}
  let props: CanvasTopActionsProps = {selectedCount: 2, disabled: false, placingAnnotation: false, collapsed: true, ...callbacks, executionActions: <button aria-label="执行">执行</button>, ...overrides}
  let renderer!: ReactTestRenderer
  act(() => { renderer = create(<CanvasTopActions {...props}/>) })
  renderers.push(renderer)
  return {renderer, ...callbacks,
    trigger: () => renderer.root.findByProps({'aria-label': '展开画布操作'}),
    menu: () => renderer.root.findByType('menu-mock' as never),
    items: () => renderer.root.findAllByProps({role: 'menuitem'}),
    update: (patch: Partial<CanvasTopActionsProps>) => { props = {...props, ...patch}; act(() => renderer.update(<CanvasTopActions {...props}/>)) },
  }
}

describe('responsive canvas actions', () => {
  it('places toolbar explanations below their anchors so sibling buttons remain uncovered', () => {
    const f=fixture({collapsed:false})
    const tips=f.renderer.root.findAllByType('tooltip-mock' as never)
    expect(tips.length).toBeGreaterThan(0)
    expect(tips.every(tip=>tip.props.side==='bottom')).toBe(true)
  })

  it('keeps secondary controls mounted for measurement while only rendering primary execution once', () => {
    const mounted = vi.fn()
    function Primary() { React.useEffect(() => { mounted() }, []); return <button aria-label="执行">执行</button> }
    const f = fixture({collapsed: false, executionActions: <Primary/>})
    const selection = f.renderer.root.findByProps({'aria-label': '所选节点操作'}), agent = f.renderer.root.findByProps({'aria-label': '交给 Agent'})
    expect(selection.props['aria-hidden']).toBeUndefined()
    expect(f.trigger().props['aria-hidden']).toBe(true)
    f.update({collapsed: true})
    expect(f.renderer.root.findByProps({'aria-label': '所选节点操作'})).toBe(selection)
    expect(f.renderer.root.findByProps({'aria-label': '交给 Agent'})).toBe(agent)
    expect(selection.props['aria-hidden']).toBe(true)
    expect(agent.props['aria-hidden']).toBe(true)
    expect(f.renderer.root.findAllByProps({'aria-label': '执行'})).toHaveLength(1)
    expect(mounted).toHaveBeenCalledOnce()
  })

  it('runs the chosen native menu command and closes the menu after each choice', () => {
    const f = fixture()
    const cases = [['交给 Agent', f.onAgent], ['添加注释', f.onToggleAnnotation], ['复制节点', f.onDuplicate], ['删除节点', f.onDelete]] as const
    for (const [label, callback] of cases) {
      act(() => f.trigger().props.onClick())
      expect(f.items().map(item => item.children.join(''))).toEqual(cases.map(([text]) => text))
      act(() => f.items().find(item => item.children.join('') === label)!.props.onClick())
      expect(callback).toHaveBeenCalledOnce()
      expect(f.items()).toHaveLength(0)
      expect(f.trigger().props['aria-expanded']).toBe(false)
    }
    expect(f.menu().props.listClassName).toBe('vdw-menu')
  })

  it('blocks mutation commands while running, while annotation placement remains cancellable', () => {
    const f = fixture({disabled: true, placingAnnotation: true})
    act(() => f.trigger().props.onClick())
    expect(f.items().find(item => item.children.includes('复制节点'))!.props.disabled).toBe(true)
    expect(f.items().find(item => item.children.includes('删除节点'))!.props.disabled).toBe(true)
    act(() => f.menu().props.onSelect('duplicate'))
    act(() => f.menu().props.onSelect('delete'))
    expect(f.onDuplicate).not.toHaveBeenCalled()
    expect(f.onDelete).not.toHaveBeenCalled()
    act(() => f.trigger().props.onClick())
    act(() => f.items().find(item => item.children.includes('取消添加注释'))!.props.onClick())
    expect(f.onToggleAnnotation).toHaveBeenCalledOnce()
    expect(f.renderer.root.findByProps({'aria-label': '添加注释'}).props['aria-pressed']).toBe(true)
  })

  it('omits selected-node commands without selection and never invokes stale mutation requests', () => {
    const f = fixture({selectedCount: 0})
    expect(f.renderer.root.findAllByProps({'aria-label': '所选节点操作'})).toHaveLength(0)
    act(() => f.trigger().props.onClick())
    expect(f.items().map(item => item.children.join(''))).toEqual(['交给 Agent'])
    act(() => f.menu().props.onSelect('annotation'))
    act(() => f.menu().props.onSelect('duplicate'))
    act(() => f.menu().props.onSelect('delete'))
    expect(f.onToggleAnnotation).not.toHaveBeenCalled()
    expect(f.onDuplicate).not.toHaveBeenCalled()
    expect(f.onDelete).not.toHaveBeenCalled()
    f.update({onAgent: undefined})
    expect(f.trigger().props.disabled).toBe(true)
  })

  it('dismisses without invoking any command and does not reopen when moving back to compact mode', () => {
    const f = fixture()
    act(() => f.trigger().props.onClick())
    act(() => f.menu().props.onClose())
    expect(f.items()).toHaveLength(0)
    act(() => f.trigger().props.onClick())
    f.update({collapsed: false})
    expect(f.items()).toHaveLength(0)
    f.update({collapsed: true})
    expect(f.items()).toHaveLength(0)
    for (const callback of [f.onAgent, f.onToggleAnnotation, f.onDuplicate, f.onDelete]) expect(callback).not.toHaveBeenCalled()
  })

  it('keeps full-width direct controls connected to the same actions', () => {
    const f = fixture({collapsed: false})
    act(() => f.renderer.root.findByProps({'aria-label': '添加注释'}).props.onClick())
    act(() => f.renderer.root.findByProps({'aria-label': '复制节点'}).props.onClick())
    act(() => f.renderer.root.findByProps({'aria-label': '删除节点'}).props.onClick())
    act(() => f.renderer.root.findByProps({'aria-label': '交给 Agent'}).props.onClick())
    for (const callback of [f.onAgent, f.onToggleAnnotation, f.onDuplicate, f.onDelete]) expect(callback).toHaveBeenCalledOnce()
  })

  it('keeps accessible icon actions and measurable labels through the intermediate icon-only mode', () => {
    const f = fixture({collapsed: false, iconOnly: false})
    const count = f.renderer.root.findByProps({className: 'vdw-selection-count'})
    const annotation = f.renderer.root.findByProps({'aria-label': '添加注释'}), agent = f.renderer.root.findByProps({'aria-label': '交给 Agent'})
    const annotationLabel = annotation.findByProps({className: 'vdw-control-label'}), agentLabel = agent.findByProps({className: 'vdw-control-label'})
    f.update({iconOnly: true})
    expect(f.renderer.root.findByProps({className: 'vdw-selection-count'})).toBe(count)
    expect(count.props['aria-hidden']).toBe(true)
    expect(annotation.findByProps({className: 'vdw-control-label'})).toBe(annotationLabel)
    expect(agent.findByProps({className: 'vdw-control-label'})).toBe(agentLabel)
    expect(annotationLabel.props['aria-hidden']).toBe(true)
    expect(agentLabel.props['aria-hidden']).toBe(true)
    expect(agent.props['aria-hidden']).toBeUndefined()
    expect(f.renderer.root.findAllByType('tooltip-mock' as never).map(tip => tip.props.label)).toContain('添加注释')
    expect(f.renderer.root.findAllByType('tooltip-mock' as never).map(tip => tip.props.label)).toContain('交给 Agent')
    act(() => annotation.props.onClick())
    act(() => agent.props.onClick())
    expect(f.onToggleAnnotation).toHaveBeenCalledOnce()
    expect(f.onAgent).toHaveBeenCalledOnce()
    expect(f.renderer.root.findAllByProps({'aria-label': '执行'})).toHaveLength(1)
    expect(f.items()).toHaveLength(0)
    f.update({iconOnly: false})
    expect(count.props['aria-hidden']).toBeUndefined()
    expect(annotationLabel.props['aria-hidden']).toBeUndefined()
  })
})
