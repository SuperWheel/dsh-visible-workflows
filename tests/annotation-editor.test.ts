import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnnotationEditor, type AnnotationEditorItem, type AnnotationEditorProps } from '../src/client/annotation-editor.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: 'button',
  Modal: ({ open, children, footer }: { open: boolean; children: React.ReactNode; footer: React.ReactNode }) =>
    open ? React.createElement('section', { role: 'dialog' }, children, footer) : null,
}))

const renderers: ReactTestRenderer[] = []
afterEach(() => { for (const renderer of renderers.splice(0)) act(() => renderer.unmount()) })
const notes: AnnotationEditorItem[] = [
  { id: 'note-one', number: 1, text: '精简内容', nodeLabels: ['a-2 · 模板转换'], workflowTitle: '工作流示例' },
  { id: 'note-two', number: 3, text: '统一术语', nodeLabels: ['a1-1 · 大语言模型', 'a-4 · 输出'], workflowTitle: '工作流示例' },
]

function mount(overrides: Partial<AnnotationEditorProps> = {}) {
  const onSave = vi.fn(), onDelete = vi.fn(), onClose = vi.fn(), onLocate = vi.fn()
  let props: AnnotationEditorProps = { open: true, annotations: notes, initialId: notes[0]!.id, onSave, onDelete, onClose, onLocate, ...overrides }
  let renderer!: ReactTestRenderer
  act(() => { renderer = create(React.createElement(AnnotationEditor, props)); renderers.push(renderer) })
  return { renderer, onSave, onDelete, onClose, onLocate,
    update(patch: Partial<AnnotationEditorProps>) { props = { ...props, ...patch }; act(() => renderer.update(React.createElement(AnnotationEditor, props))) },
    button(label: string) { return renderer.root.findAllByType('button').find(button => button.children.includes(label))! },
    textarea() { return renderer.root.findByProps({ 'aria-label': '修改要求' }) },
    row(index: number) { return renderer.root.findByProps({ 'aria-label': '注释列表' }).findAllByType('button')[index]! },
  }
}

describe('统一注释编辑器', () => {
  it('节点标签和原始序号可见，切换条目保留输入，保存一次提交全部已编辑条目', async () => {
    const fixture = mount()
    expect(fixture.renderer.root.findByProps({ 'aria-label': '引用节点' }).findAllByType('span')[0]!.children).toContain('a-2 · 模板转换')
    act(() => fixture.textarea().props.onChange({ target: { value: '内容修改' } }))
    act(() => fixture.row(1).props.onClick())
    expect(fixture.row(1).props['aria-pressed']).toBe(true)
    expect(fixture.row(1).findByProps({ className: 'vdw-annotation-ordinal' }).children).toEqual(['3'])
    expect(fixture.textarea().props.value).toBe('统一术语')
    act(() => fixture.textarea().props.onChange({ target: { value: '术语修改' } }))
    act(() => fixture.row(0).props.onClick())
    expect(fixture.textarea().props.value).toBe('内容修改')
    await act(async () => fixture.button('保存').props.onClick())
    expect(fixture.onSave.mock.calls).toEqual([['note-two', '术语修改'], ['note-one', '内容修改']])
    expect(fixture.onClose).toHaveBeenCalledOnce()
  })
  it('删除当前条目后转到剩余条目；删除最后条目关闭编辑器', async () => {
    const fixture = mount({ initialId: notes[1]!.id })
    await act(async () => fixture.button('删除注释').props.onClick())
    expect(fixture.onDelete).toHaveBeenCalledExactlyOnceWith('note-two')
    expect(fixture.onClose).not.toHaveBeenCalled()
    fixture.update({ annotations: [notes[0]!] })
    expect(fixture.textarea().props.value).toBe('精简内容')
    await act(async () => fixture.button('删除注释').props.onClick())
    expect(fixture.onDelete).toHaveBeenLastCalledWith('note-one')
    expect(fixture.onClose).toHaveBeenCalledOnce()
  })
  it('保存或删除失败时保留草稿和编辑器并显示可操作错误', async () => {
    const fixture = mount({ onSave: vi.fn().mockRejectedValue(new Error('草稿正在提交')), onDelete: vi.fn().mockRejectedValue(new Error('引用尚未移除')) })
    act(() => fixture.textarea().props.onChange({ target: { value: '保留用户输入' } }))
    await act(async () => fixture.button('保存').props.onClick())
    expect(fixture.renderer.root.findByProps({ role: 'alert' }).children).toEqual(['草稿正在提交'])
    expect(fixture.textarea().props.value).toBe('保留用户输入')
    await act(async () => fixture.button('删除注释').props.onClick())
    expect(fixture.renderer.root.findByProps({ role: 'alert' }).children).toEqual(['引用尚未移除'])
    expect(fixture.onClose).not.toHaveBeenCalled()
  })
  it('取消不提交修改，再次打开使用原值；任一已编辑条目空白时禁用保存', () => {
    const fixture = mount()
    act(() => fixture.textarea().props.onChange({ target: { value: '  ' } }))
    act(() => fixture.row(1).props.onClick())
    expect(fixture.button('保存').props.disabled).toBe(true)
    act(() => fixture.button('取消').props.onClick())
    expect(fixture.onSave).not.toHaveBeenCalled()
    expect(fixture.onClose).toHaveBeenCalledOnce()
    fixture.update({ open: false }); fixture.update({ open: true })
    expect(fixture.textarea().props.value).toBe('精简内容')
  })
  it('提交中不可修改或删除，新增模式不提供删除入口，定位使用稳定注释 ID', () => {
    const fixture = mount({ disabled: true })
    expect(fixture.textarea().props.disabled).toBe(true)
    expect(fixture.button('保存').props.disabled).toBe(true)
    expect(fixture.button('删除注释').props.disabled).toBe(true)
    act(() => fixture.button('定位节点').props.onClick())
    expect(fixture.onLocate).toHaveBeenCalledExactlyOnceWith('note-one')
    fixture.update({ onDelete: undefined, disabled: false, saveLabel: '提交到草稿' })
    expect(fixture.button('删除注释')).toBeUndefined()
    expect(fixture.button('提交到草稿')).toBeDefined()
  })
})
