import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StickyNote, type StickyNoteProps } from '../src/client/sticky-note.tsx'
import { newNode } from '../src/client/nodes.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({
  Button:({children,...props}:any)=>React.createElement('button',props,children),
  Menu:({anchor,...props}:any)=>React.createElement('menu-mock',props,anchor),
}))
let renderer:ReactTestRenderer|undefined
afterEach(()=>{if(renderer)act(()=>renderer!.unmount());renderer=undefined})
const key=(value:string,patch:Record<string,unknown>={})=>({key:value,shiftKey:false,metaKey:false,ctrlKey:false,nativeEvent:{isComposing:false},preventDefault:vi.fn(),stopPropagation:vi.fn(),...patch})
function setup(patch:Partial<StickyNoteProps>={}){
  const node=newNode('template'),onChange=vi.fn(),onDelete=vi.fn(),onEditingChange=vi.fn()
  const props:StickyNoteProps={note:{id:'note',text:'原说明',x:30,y:50},nodes:[node],selected:true,onSelect:vi.fn(),onChange,onDelete,onDragStart:vi.fn(),onResizeStart:vi.fn(),onEditingChange,...patch}
  const field={focus:vi.fn(),value:props.note.text,setSelectionRange:vi.fn()}
  act(()=>{renderer=create(React.createElement(StickyNote,props),{createNodeMock:element=>element.type==='textarea'?field:null})})
  const begin=()=>act(()=>renderer!.root.findByProps({className:'vdw-canvas-note-body '}).props.onDoubleClick({stopPropagation:vi.fn()}))
  const input=(text:string)=>act(()=>renderer!.root.findByType('textarea').props.onChange({target:{value:text}}))
  return {node,onChange,onDelete,onEditingChange,props,field,begin,input}
}
describe('persistent note editor behavior',()=>{
  it('formats headings, emphasis and lists without interpreting HTML or changing stored text',()=>{
    const text='# 使用说明\n\n**重要提示**：保留 `input_text`\n\n- 第一步\n- <img src=x onerror=alert(1)>\n\n1. 阅读\n2. 确认'
    const note=setup({note:{id:'note',text,x:30,y:50}})
    expect(renderer!.root.findByType('h3').children).toEqual(['使用说明'])
    expect(renderer!.root.findByType('strong').children).toEqual(['重要提示'])
    expect(renderer!.root.findByType('code').children).toEqual(['input_text'])
    expect(renderer!.root.findByType('ul').findAllByType('li')).toHaveLength(2)
    expect(renderer!.root.findByType('ol').findAllByType('li')).toHaveLength(2)
    expect(renderer!.root.findAllByType('img')).toHaveLength(0)
    expect(renderer!.root.findAllByType('li')[1]!.children).toEqual(['<img src=x onerror=alert(1)>'])
    note.begin();expect(renderer!.root.findByType('textarea').props.value).toBe(text)
    act(()=>renderer!.root.findByType('textarea').props.onBlur())
    expect(note.onChange).not.toHaveBeenCalled()
  })
  it('opens the same inline editor from the accessible floating toolbar',()=>{
    const note=setup()
    act(()=>renderer!.root.findByProps({'aria-label':'编辑便签'}).props.onClick())
    expect(renderer!.root.findByType('textarea').props.value).toBe('原说明')
    expect(note.onEditingChange).toHaveBeenCalledWith(true)
  })
  it('edits in place and commits one undoable change instead of saving each keystroke',()=>{
    const note=setup();note.begin();expect(note.field.focus).toHaveBeenCalled()
    note.input('新增');note.input('新增流程说明');expect(note.onChange).not.toHaveBeenCalled()
    act(()=>renderer!.root.findByType('textarea').props.onBlur())
    expect(note.onChange).toHaveBeenCalledTimes(1);expect(note.onChange.mock.calls[0]![0]).toMatchObject({id:'note',text:'新增流程说明'})
    expect(note.onEditingChange.mock.calls.map(call=>call[0])).toEqual([true,false])
  })
  it('cancels editing with Escape and ignores composing Ctrl+Enter',()=>{
    const note=setup();note.begin();note.input('还未提交')
    act(()=>renderer!.root.findByType('textarea').props.onKeyDown(key('Enter',{ctrlKey:true,nativeEvent:{isComposing:true}})))
    expect(note.onChange).not.toHaveBeenCalled();expect(renderer!.root.findAllByType('textarea')).toHaveLength(1)
    act(()=>renderer!.root.findByType('textarea').props.onKeyDown(key('Escape')))
    expect(note.onChange).not.toHaveBeenCalled();expect(renderer!.root.findAllByType('textarea')).toHaveLength(0)
  })
  it('commits Ctrl+Enter only once even if the same field then emits blur',()=>{
    const note=setup();note.begin();note.input('已完成说明')
    const field=renderer!.root.findByType('textarea').props
    act(()=>{field.onKeyDown(key('Enter',{ctrlKey:true}));field.onBlur()})
    expect(note.onChange).toHaveBeenCalledTimes(1)
  })
  it('saves the latest draft once when the parent closes a controlled editor without blur',()=>{
    const note=setup({editing:true});note.input('还在输入');note.input('切换便签前的最新说明')
    const moved={...note.props.note,x:450,y:650}
    act(()=>renderer!.update(React.createElement(StickyNote,{...note.props,note:moved,editing:false})))
    expect(note.onChange).toHaveBeenCalledTimes(1)
    expect(note.onChange.mock.calls[0]![0]).toEqual({...moved,text:'切换便签前的最新说明'})
    act(()=>renderer!.update(React.createElement(StickyNote,{...note.props,note:moved,editing:false})))
    expect(note.onChange).toHaveBeenCalledTimes(1)
  })
  it('does not save an Escape-cancelled draft when controlled editing then becomes false',()=>{
    const note=setup({editing:true});note.input('应该取消')
    act(()=>renderer!.root.findByType('textarea').props.onKeyDown(key('Escape')))
    act(()=>renderer!.update(React.createElement(StickyNote,{...note.props,editing:false})))
    expect(note.onChange).not.toHaveBeenCalled()
  })
  it('does not duplicate a blur save when the parent later closes the editor',()=>{
    const note=setup({editing:true});note.input('已失焦保存')
    act(()=>renderer!.root.findByType('textarea').props.onBlur())
    act(()=>renderer!.update(React.createElement(StickyNote,{...note.props,editing:false})))
    expect(note.onChange).toHaveBeenCalledTimes(1)
  })
  it('does not commit a draft when the parent disables and closes its editor',()=>{
    const note=setup({editing:true});note.input('不可再修改')
    act(()=>renderer!.update(React.createElement(StickyNote,{...note.props,disabled:true,editing:false})))
    act(()=>renderer!.update(React.createElement(StickyNote,{...note.props,disabled:false,editing:false})))
    expect(note.onChange).not.toHaveBeenCalled()
  })
  it('does not resurrect a deleted note by saving its draft during unmount',()=>{
    const note=setup({editing:true});note.input('即将删除')
    act(()=>renderer!.unmount());renderer=undefined
    expect(note.onChange).not.toHaveBeenCalled()
  })
  it('connects by stable node ID, changes the paper color and detaches without moving content',()=>{
    const note=setup()
    const menus=renderer!.root.findAllByType('menu-mock')
    act(()=>menus[0]!.props.onSelect('blue'))
    expect(note.onChange.mock.calls.at(-1)![0]).toMatchObject({color:'blue',x:30,y:50,text:'原说明'})
    act(()=>menus[1]!.props.onSelect(note.node.id))
    expect(note.onChange.mock.calls.at(-1)![0].anchorNodeId).toBe(note.node.id)
    act(()=>renderer!.update(React.createElement(StickyNote,{...note.props,note:{...note.props.note,anchorNodeId:note.node.id}})))
    act(()=>renderer!.root.findAllByType('menu-mock')[1]!.props.onSelect(':detach:'))
    expect(note.onChange.mock.calls.at(-1)![0]).toEqual(note.props.note)
  })
  it('batches repeated keyboard resizing into one change when the key is released',()=>{
    const note=setup(),handle=()=>renderer!.root.findByProps({className:'vdw-canvas-note-resize'})
    act(()=>{handle().props.onKeyDown(key('ArrowRight',{shiftKey:true}));handle().props.onKeyDown(key('ArrowRight',{shiftKey:true}));handle().props.onKeyDown(key('ArrowRight',{shiftKey:true}))})
    expect(note.onChange).not.toHaveBeenCalled();expect(renderer!.root.findByType('section').props.style.width).toBe(310)
    act(()=>handle().props.onKeyUp(key('ArrowRight')))
    expect(note.onChange).toHaveBeenCalledTimes(1);expect(note.onChange.mock.calls[0]![0]).toMatchObject({width:310,height:180})
  })
  it('blocks mutation and in-place editing while disabled',()=>{
    const note=setup({disabled:true});note.begin()
    expect(renderer!.root.findAllByType('textarea')).toHaveLength(0)
    act(()=>renderer!.root.findAllByType('menu-mock')[0]!.props.onSelect('purple'))
    act(()=>renderer!.root.findByProps({'aria-label':'删除便签'}).props.onClick())
    expect(note.onChange).not.toHaveBeenCalled();expect(note.onDelete).not.toHaveBeenCalled()
    expect(renderer!.root.findAllByProps({className:'vdw-canvas-note-resize'})).toHaveLength(0)
  })
})
