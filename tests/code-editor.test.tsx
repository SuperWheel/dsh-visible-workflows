import React, { useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeEditor } from '../src/client/code-editor.tsx'
import { JsonEditor } from '../src/client/controls.tsx'
import { formatJsonCode, indentCode, tokenizeCode } from '../src/client/code-tokens.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: 'button', Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>, Menu: () => null, Modal: ({children,title,className,headless,onClose}:any) => <section role="dialog" aria-label={title} data-modal-class={className} data-headless={headless} onClose={onClose}>{children}</section> }))
const renderers: ReactTestRenderer[] = []
afterEach(() => { for (const renderer of renderers.splice(0)) act(() => renderer.unmount()); vi.unstubAllGlobals() })

function jsonFixture() {
  const changes = vi.fn(), selection = vi.fn(), focus = vi.fn()
  let renderer!: ReactTestRenderer, replace!: (value: unknown) => void
  function Fixture() {
    const [value, setValue] = useState<unknown>({ count: 1 }); replace = setValue
    return <JsonEditor label="参数" value={value} onChange={next => { changes(next); setValue(next) }}/>
  }
  act(() => { renderer = create(<Fixture/>, { createNodeMock: element => element.type === 'textarea' ? { setSelectionRange: selection } : element.type==='button'?{focus}:null }); renderers.push(renderer) })
  return { renderer, changes, selection, focus, input: () => renderer.root.findByProps({'aria-label':'参数'}), edit(value: string) { act(() => this.input().props.onChange({ target: { value } })) }, replace(value: unknown) { act(() => replace(value)) } }
}

describe('structured code editing', () => {
  it('keeps keyboard help accessible without showing a permanent footer',()=>{
    const f=jsonFixture()
    expect(f.renderer.root.findAllByType('footer')).toHaveLength(0)
    const help=f.renderer.root.findByProps({className:'vdw-source-a11y'})
    expect(help.children.join('')).toContain('Tab 缩进')
    expect(f.input().props['aria-describedby']).toContain(help.props.id)
    const actions=f.renderer.root.findByProps({className:'vdw-source-actions'}).findAllByType('button')
    expect(actions.map(button=>button.props['aria-label'])).toEqual(['格式化参数','复制参数','展开参数'])
  })
  it('edits in a large workspace, keeps incomplete JSON across closing, and restores the expand trigger focus',async()=>{
    const f=jsonFixture()
    act(()=>f.renderer.root.findByProps({'aria-label':'展开参数'}).props.onClick())
    const dialog=f.renderer.root.findByProps({role:'dialog'})
    expect(dialog.props['data-headless']).toBe(true)
    expect(dialog.props['data-modal-class']).toContain('vdw-expanded-editor')
    const expanded=()=>f.renderer.root.findByProps({'aria-label':'参数（展开）'})
    act(()=>expanded().props.onChange({target:{value:'{ "count": 7 }'}}))
    expect(f.changes).toHaveBeenLastCalledWith({count:7})
    expect(f.input().props.value).toBe('{ "count": 7 }')
    act(()=>expanded().props.onChange({target:{value:'{ "count":'}}))
    act(()=>f.renderer.root.findByProps({'aria-label':'格式化参数（展开）'}).props.onClick())
    expect(expanded().props.value).toBe('{ "count":')
    const escape={key:'Escape',nativeEvent:{},preventDefault:vi.fn(),stopPropagation:vi.fn()}
    await act(async()=>expanded().props.onKeyDown(escape))
    expect(f.renderer.root.findAllByProps({role:'dialog'})).toHaveLength(0)
    expect(f.input().props.value).toBe('{ "count":')
    expect(f.input().props['aria-invalid']).toBe(true)
    expect(f.focus).toHaveBeenCalledOnce()
    expect(escape.preventDefault).toHaveBeenCalledOnce()
  })
  it.each([{disabled:true},{readOnly:true}])('keeps expanded editors protected while retaining close/view access: %j',async(options)=>{
    const changes=vi.fn();let renderer!:ReactTestRenderer
    act(()=>{renderer=create(<CodeEditor label="代码" language="python" value="return x" onChange={changes} {...options}/>);renderers.push(renderer)})
    act(()=>renderer.root.findByProps({'aria-label':'展开代码'}).props.onClick())
    const expanded=renderer.root.findByProps({'aria-label':'代码（展开）'})
    expect(expanded.props[options.disabled?'disabled':'readOnly']).toBe(true)
    act(()=>expanded.props.onChange({target:{value:'changed'}}))
    expect(changes).not.toHaveBeenCalled()
    await act(async()=>renderer.root.findByProps({'aria-label':'收起代码'}).props.onClick())
    expect(renderer.root.findAllByProps({role:'dialog'})).toHaveLength(0)
  })
  it('saves parsed JSON without rewriting user whitespace and keeps incomplete drafts', () => {
    const f = jsonFixture(), source = '{ "count" : 2,  "label": "中文 🙂" }'
    f.edit(source)
    expect(f.input().props.value).toBe(source)
    expect(f.changes).toHaveBeenLastCalledWith({ count: 2, label: '中文 🙂' })
    f.edit('{ "count":')
    expect(f.input().props.value).toBe('{ "count":')
    expect(f.changes).toHaveBeenCalledOnce()
    expect(f.input().props['aria-invalid']).toBe(true)
    expect(f.renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('暂未保存')
    f.replace({ count: 1 })
    expect(f.input().props.value).toBe('{\n  "count": 1\n}')
    expect(f.input().props['aria-invalid']).toBe(false)
  })
  it('formats only when requested and leaves invalid JSON untouched', () => {
    const f = jsonFixture()
    f.edit('{"count":2}')
    act(() => f.renderer.root.findByProps({ 'aria-label': '格式化参数' }).props.onClick())
    expect(f.input().props.value).toBe('{\n  "count": 2\n}')
    f.edit('{"count":')
    const count = f.changes.mock.calls.length
    act(() => f.renderer.root.findByProps({ 'aria-label': '格式化参数' }).props.onClick())
    expect(f.input().props.value).toBe('{"count":')
    expect(f.changes).toHaveBeenCalledTimes(count)
    expect(formatJsonCode('{ broken')).toMatchObject({ value: '{ broken', error: expect.any(String) })
  })
  it('inserts indentation with a stable selection and provides a keyboard exit', () => {
    const changes = vi.fn(), setSelectionRange = vi.fn()
    let renderer!: ReactTestRenderer
    function Fixture() { const [value, setValue] = useState('return x'); return <CodeEditor label="代码" language="javascript" value={value} onChange={next => { changes(next); setValue(next) }}/> }
    act(() => { renderer = create(<Fixture/>, { createNodeMock: element => element.type === 'textarea' ? { setSelectionRange } : null }); renderers.push(renderer) })
    const key = (key: string) => ({ key, nativeEvent: {}, currentTarget: { selectionStart: 0, selectionEnd: 0 }, preventDefault: vi.fn(), stopPropagation: vi.fn() })
    const tab = key('Tab')
    act(() => renderer.root.findByType('textarea').props.onKeyDown(tab))
    expect(changes).toHaveBeenLastCalledWith('  return x')
    expect(setSelectionRange).toHaveBeenLastCalledWith(2, 2)
    expect(tab.preventDefault).toHaveBeenCalledOnce()
    const escape = key('Escape')
    act(() => renderer.root.findByType('textarea').props.onKeyDown(escape))
    const leave = key('Tab')
    act(() => renderer.root.findByType('textarea').props.onKeyDown(leave))
    expect(leave.preventDefault).not.toHaveBeenCalled()
    expect(changes).toHaveBeenCalledOnce()
  })
  it.each([{ disabled: true }, { readOnly: true }])('prevents updates and indentation while locked: %j', options => {
    const changes = vi.fn(); let renderer!: ReactTestRenderer
    act(() => { renderer = create(<CodeEditor label="代码" language="python" value="return x" onChange={changes} {...options}/>); renderers.push(renderer) })
    const input = renderer.root.findByType('textarea')
    act(() => input.props.onChange({ target: { value: 'changed' } }))
    const preventDefault = vi.fn()
    act(() => input.props.onKeyDown({ key: 'Tab', nativeEvent: {}, preventDefault }))
    expect(changes).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })
  it('copies the original code including whitespace', async () => {
    const copy = vi.fn(async () => {}); vi.stubGlobal('navigator', { clipboard: { writeText: copy } })
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<CodeEditor label="代码" language="javascript" value={'\treturn "🙂"\n'}/>); renderers.push(renderer) })
    await act(async () => { renderer.root.findByProps({ 'aria-label': '复制代码' }).props.onClick() })
    expect(copy).toHaveBeenCalledWith('\treturn "🙂"\n')
    expect(renderer.root.findByProps({ role: 'status' }).children).toEqual(['已复制'])
  })
})

describe('code text helpers', () => {
  it('indents a selection without affecting the following unselected line', () => {
    expect(indentCode('a\nb\nc', 0, 4)).toEqual({ value: '  a\n  b\nc', start: 2, end: 8 })
    expect(indentCode('  a\n b\nc', 0, 7, true)).toEqual({ value: 'a\nb\nc', start: 0, end: 4 })
    expect(indentCode('\nx', 0, 1)).toEqual({ value: '  \nx', start: 2, end: 3 })
  })
  it('preserves all source text, distinguishes JSON keys and bounds large-document highlighting', () => {
    const source = '{"html":"<script>alert(1)</script>","count":0,"ok":false,"ref":"{{input.text}}"}'
    const tokens = tokenizeCode(source, 'json')
    expect(tokens.map(token => token.text).join('')).toBe(source)
    expect(tokens).toContainEqual({ text: '"html"', kind: 'property' })
    expect(tokens).toContainEqual({ text: 'false', kind: 'keyword' })
    const long = '"'.repeat(60_001)
    expect(tokenizeCode(long, 'json')).toEqual([{ text: long, kind: 'plain' }])
  })
})
