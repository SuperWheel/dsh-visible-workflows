import React, { useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelSettings } from '../src/client/model-settings.tsx'
import type { ModelChoice, NodeConfig } from '../src/shared/types.ts'
import { newNode } from '../src/client/nodes.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: 'button',
  Tooltip: ({children}: {children:React.ReactNode}) => <>{children}</>,
  Menu: ({ anchor, open, items, onSelect }: { anchor: React.ReactNode; open: boolean; items: { id: string; label: string }[]; onSelect(id: string): void }) =>
    <>{anchor}{open && <div role="menu">{items.map(item => <button key={item.id} data-choice-label={item.label} onClick={() => onSelect(item.id)}>{item.label}</button>)}</div>}</>,
}))
const renderers: ReactTestRenderer[] = []
afterEach(() => { for (const renderer of renderers.splice(0)) act(() => renderer.unmount()) })
const models: ModelChoice[] = [
  { provider: 'configured', model: 'first-model', label: '目录首项', efforts: [{ id: 'low', label: '低' }] },
  { provider: 'configured', model: 'chosen-model', label: '用户指定模型', efforts: [{ id: 'low', label: '低' }, { id: 'high', label: '高' }] },
]
function mount(initial: NodeConfig, available: ModelChoice[] = models, modelsError?: string) {
  const changes = vi.fn()
  let config!: NodeConfig, renderer!: ReactTestRenderer
  function Fixture({ catalog, error }: { catalog: ModelChoice[]; error?: string }) {
    const [value, setValue] = useState(initial); config = value
    return <ModelSettings config={value} models={catalog} modelsError={error} onChange={patch => { changes(patch); setValue(previous => ({ ...previous, ...patch })) }}/>
  }
  act(() => { renderer = create(<Fixture catalog={available} error={modelsError}/>); renderers.push(renderer) })
  return {
    changes, renderer, config: () => config,
    select(label: string, option: string) {
      act(() => renderer.root.findByProps({ 'aria-label': label }).props.onClick())
      act(() => renderer.root.findByProps({ 'data-choice-label': option }).props.onClick())
    },
    refresh(catalog: ModelChoice[], error?: string) { act(() => renderer.update(<Fixture catalog={catalog} error={error}/>)) },
  }
}

describe('DSH 默认模型与节点覆盖', () => {
  it('新模型节点与目录加载均不填入首项；空目录时仍能保留跟随 DSH', () => {
    const node = newNode('llm'), fixture = mount(node.config, [])
    expect(fixture.config().model).toBeUndefined()
    expect(fixture.renderer.root.findByProps({ 'aria-label': '选择模型' }).props.disabled).toBe(false)
    fixture.refresh(models)
    expect(fixture.config().model).toBeUndefined()
    expect(fixture.config().effort).toBeUndefined()
    expect(fixture.changes).not.toHaveBeenCalled()
    fixture.select('选择模型', '跟随 DSH')
    expect(fixture.config().model).toBeUndefined()
    expect(fixture.config()).toMatchObject({ prompt: node.config.prompt })
  })
  it('切换模型保留显式思考强度，不支持时提示而不默默重置；用户可主动选择受支持强度', () => {
    const fixture = mount({ model: { provider: 'configured', model: 'chosen-model' }, effort: 'high' })
    fixture.select('选择模型', '目录首项')
    expect(fixture.config()).toEqual({ model: { provider: 'configured', model: 'first-model' }, effort: 'high' })
    expect(fixture.changes).toHaveBeenCalledExactlyOnceWith({ model: { provider: 'configured', model: 'first-model' } })
    expect(JSON.stringify(fixture.renderer.toJSON())).toContain('high（当前模型不支持）')
    fixture.select('选择思考强度', '低')
    expect(fixture.config().effort).toBe('low')
  })
  it('目录失败不会丢失已指定模型或强度，仍允许分别恢复模型和强度的默认继承', () => {
    const fixture = mount({ model: { provider: 'configured', model: 'chosen-model' }, effort: 'high' })
    fixture.refresh([], '目录暂不可用')
    expect(fixture.config()).toEqual({ model: { provider: 'configured', model: 'chosen-model' }, effort: 'high' })
    expect(fixture.changes).not.toHaveBeenCalled()
    expect(JSON.stringify(fixture.renderer.toJSON())).toContain('chosen-model · configured（暂不在目录）')
    fixture.select('选择模型', '跟随 DSH')
    expect(fixture.config().model).toBeUndefined()
    expect(fixture.config().effort).toBe('high')
    fixture.select('选择思考强度', '跟随 DSH')
    expect(fixture.config().effort).toBeUndefined()
  })
  it('模型恢复进入目录时只更新名称与能力显示，不改动已经保存的选择', () => {
    const fixture = mount({ model: { provider: 'configured', model: 'chosen-model' }, effort: 'low' }, [])
    fixture.refresh(models)
    expect(JSON.stringify(fixture.renderer.toJSON())).toContain('用户指定模型')
    expect(JSON.stringify(fixture.renderer.toJSON())).toContain('低')
    expect(fixture.changes).not.toHaveBeenCalled()
    expect(fixture.config()).toEqual({ model: { provider: 'configured', model: 'chosen-model' }, effort: 'low' })
  })
})
