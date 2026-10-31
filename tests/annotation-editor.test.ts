import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnnotationEditor, type AnnotationEditorItem, type AnnotationEditorProps, type AnnotationEditorNode } from '../src/client/annotation-editor.tsx'
import { setLocale } from '../src/client/i18n.ts'

vi.mock('react-dom',()=>({createPortal:(children:React.ReactNode)=>children}))

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: 'button',
  Input: 'input',
  Tooltip:({children}:{children:React.ReactNode})=>children,
  Menu:({anchor,children,open,items=[],...props}:any)=>React.createElement('menu-mock',props,anchor,open?items.map((item:any)=>React.createElement('button',{key:item.id,role:'menuitem','data-menu-id':item.id,'aria-pressed':props.selectedId===item.id,onClick:()=>props.onSelect?.(item.id)},item.label)):null,open?children:null),
  useModalLayer:vi.fn(),
}))

const renderers: ReactTestRenderer[] = []
afterEach(() => { for (const renderer of renderers.splice(0)) act(() => renderer.unmount());setLocale('zh-CN');vi.unstubAllGlobals() })
const nodes:AnnotationEditorNode[]=[{id:'stable-template',number:'a-2',title:'模板转换'},{id:'stable-model',number:'a1-1',title:'大语言模型'},{id:'stable-output',number:'a-4',title:'输出'},{id:'stable-branch',number:'b-1',title:'条件分支'},{id:'stable-list',number:'b-2',title:'列表操作'}]
const notes: AnnotationEditorItem[] = [
  { id: 'note-one', number: 1, text: '精简内容', nodes:[nodes[0]!], nodeLabels: ['a-2 · 模板转换'], workflowTitle: '工作流示例' },
  { id: 'note-two', number: 3, text: '统一术语', nodes:[nodes[1]!,nodes[2]!], nodeLabels: ['a1-1 · 大语言模型', 'a-4 · 输出'], workflowTitle: '工作流示例' },
]

function mount(overrides: Partial<AnnotationEditorProps> = {},inputNode?:{scrollHeight:number;style:{height:string;overflowY:string}},layout?:{available:number;widths:number[]},composeLayout?:{width:number;compactHeight:number;expandedHeight:number;contentWidth?:number}) {
  vi.stubGlobal('document',{body:{}})
  const onSave = vi.fn(), onDelete = vi.fn(), onClose = vi.fn(), onLocate = vi.fn()
  let props: AnnotationEditorProps = { open: true, annotations: notes, initialId: notes[0]!.id, availableNodes:nodes, onSave, onDelete, onClose, onLocate, ...overrides }
  let renderer!: ReactTestRenderer
  const mirror={style:{width:''},get scrollHeight(){const width=Number.parseFloat(this.style.width);return composeLayout!.contentWidth!==undefined?(width<composeLayout!.contentWidth?44:22):width<=composeLayout!.width-67?composeLayout!.compactHeight:composeLayout!.expandedHeight}}
  act(() => { renderer = create(React.createElement(AnnotationEditor, props),{createNodeMock:node=>node.props.className==='vdw-annotation-input-measure'&&composeLayout?mirror:node.type==='textarea'?inputNode??null:composeLayout&&String(node.props.className).startsWith('vdw-annotation-compose')?{getBoundingClientRect:()=>({width:composeLayout.width})}:layout&&node.props.className==='vdw-annotation-targets'?{getBoundingClientRect:()=>({width:layout.available})}:layout&&node.props.className==='vdw-annotation-target-measure'?{children:layout.widths.map(width=>({getBoundingClientRect:()=>({width})}))}:null}); renderers.push(renderer) })
  return { renderer, onSave, onDelete, onClose, onLocate,
    update(patch: Partial<AnnotationEditorProps>) { props = { ...props, ...patch }; act(() => renderer.update(React.createElement(AnnotationEditor, props))) },
    button(label: string) { return renderer.root.findAllByType('button').find(button => button.children.includes(label)||button.props['aria-label']===label)! },
    textarea() { return renderer.root.findByProps({ 'aria-label': '修改要求' }) },
    selectAnnotation(index:number){act(()=>this.button('切换注释').props.onClick());act(()=>renderer.root.findByProps({'data-menu-id':props.annotations[index]!.id}).props.onClick())},
  }
}

describe('统一注释编辑器', () => {
  it('单行删除位于输入胶囊内蓝色箭头前，不再提供独立关闭按钮，点击外部仍收起',()=>{
    const fixture=mount({onLocate:undefined})
    const actions=fixture.renderer.root.findByProps({className:'vdw-annotation-inline-actions'})
    expect(actions.findAllByType('button').map(button=>button.props.className)).toEqual(['vdw-annotation-delete','vdw-annotation-submit'])
    expect(fixture.button('关闭注释')).toBeUndefined()
    expect(fixture.renderer.root.findAllByProps({className:'vdw-annotation-secondary'})).toHaveLength(0)
    act(()=>fixture.textarea().props.onChange({target:{value:'尚未提交的单行修改'}}))
    act(()=>fixture.renderer.root.findByProps({className:'vdw-annotation-dismiss'}).props.onPointerDown())
    expect(fixture.onClose).toHaveBeenCalledOnce()
    expect(fixture.onSave).not.toHaveBeenCalled()
    expect(fixture.onDelete).not.toHaveBeenCalled()
  })
  it('仅首次打开与切换选中注释时通知调用方更新marker锚点',()=>{
    const first=vi.fn(),next=vi.fn(),fixture=mount({onSelectedChange:first})
    expect(first).toHaveBeenCalledExactlyOnceWith('note-one')
    fixture.update({onSelectedChange:next})
    act(()=>fixture.textarea().props.onChange({target:{value:'只改文本'}}))
    expect(next).not.toHaveBeenCalled()
    fixture.selectAnnotation(1)
    expect(next).toHaveBeenCalledExactlyOnceWith('note-two')
    expect(fixture.renderer.root.findAllByProps({className:'vdw-annotation-ordinal'})).toHaveLength(0)
  })
  it('悬停遮罩只按内部叉图标与文字的真实交叠像素计算，不以20px点击区遮字或修改chip宽度',()=>{
    vi.stubGlobal('document',{body:{}})
    const setProperty=vi.fn(),textRect={width:30,right:110},glyphRect={width:12,left:102},buttonRect=vi.fn(()=>({width:20,left:98}))
    let renderer!:ReactTestRenderer
    act(()=>{renderer=create(React.createElement(AnnotationEditor,{open:true,annotations:[notes[0]!],onSave:vi.fn(),onClose:vi.fn()}),{createNodeMock:node=>node.props.className==='vdw-annotation-target'?{style:{setProperty}}:node.type==='span'&&node.props.children==='a-2'?{getBoundingClientRect:()=>textRect}:node.props['aria-label']==='移除引用 a-2 · 模板转换'?{getBoundingClientRect:buttonRect,querySelector:()=>({getBoundingClientRect:()=>glyphRect})}:null});renderers.push(renderer)})
    expect(setProperty).toHaveBeenLastCalledWith('--vdw-chip-covered','8px')
    textRect.right=122
    act(()=>renderer.root.findByProps({title:'a-2 · 模板转换'}).props.onPointerEnter())
    expect(setProperty).toHaveBeenLastCalledWith('--vdw-chip-covered','20px')
    expect(buttonRect).not.toHaveBeenCalled()
    expect(setProperty.mock.calls.every(([name])=>name==='--vdw-chip-covered')).toBe(true)
  })
  it('编号chip只显示结构编号，单行起步并随内容增高到五行后内部滚动',()=>{
    const input={scrollHeight:22,style:{height:'',overflowY:''}},fixture=mount({},input)
    expect(fixture.textarea().props.rows).toBe(1)
    expect(input.style).toEqual({height:'22px',overflowY:'hidden'})
    const chip=fixture.renderer.root.findByProps({title:'a-2 · 模板转换'})
    expect(chip.findAllByType('span').filter(span=>span.children.every(child=>typeof child==='string')).map(span=>span.children.join(''))).toEqual(['a-2'])
    input.scrollHeight=176
    act(()=>fixture.textarea().props.onChange({target:{value:'第一行\n第二行\n第三行\n第四行\n第五行\n第六行'}}))
    expect(input.style).toEqual({height:'110px',overflowY:'auto'})
    input.scrollHeight=22
    act(()=>fixture.textarea().props.onChange({target:{value:'回到一行'}}))
    expect(input.style).toEqual({height:'22px',overflowY:'hidden'})
    expect(fixture.renderer.root.findAllByType('header')).toHaveLength(0)
    expect(fixture.renderer.root.findAllByType('footer')).toHaveLength(0)
  })
  it('按真实紧凑宽度折行切换白底卡片，卡片宽度足以容纳一行时也不会反复切换',()=>{
    const input={scrollHeight:22,style:{height:'',overflowY:''}},layout={width:400,compactHeight:22,expandedHeight:22},fixture=mount({},input,undefined,layout)
    const compose=()=>fixture.renderer.root.findAllByType('div').find(node=>String(node.props.className).startsWith('vdw-annotation-compose'))!
    expect(compose().props.className).not.toContain('is-multiline')
    layout.compactHeight=44
    act(()=>fixture.textarea().props.onChange({target:{value:'实际折行的长文本，不含换行符'}}))
    expect(compose().props.className).toContain('is-multiline')
    expect(input.style.height).toBe('44px')
    expect(fixture.renderer.root.findAllByProps({className:'vdw-annotation-secondary'})).toHaveLength(0)
    const arrow=fixture.renderer.root.findByProps({className:'vdw-annotation-submit'})
    expect(arrow.props['aria-hidden']).toBe(true)
    expect(arrow.props.disabled).toBe(true)
    expect(fixture.renderer.root.findAllByProps({'aria-label':'删除注释'})).toHaveLength(1)
    expect(fixture.button('取消')).toBeDefined()
    expect(fixture.button('保存').props.className).toBe('vdw-annotation-save')
    expect(fixture.button('移除引用 a-2 · 模板转换')).toBeDefined()
    layout.compactHeight=22
    act(()=>fixture.textarea().props.onChange({target:{value:'回到一行'}}))
    expect(compose().props.className).not.toContain('is-multiline')
    expect(fixture.button('取消')).toBeUndefined()
    expect(fixture.button('保存').props.className).toBe('vdw-annotation-submit')
    expect(fixture.renderer.root.findAllByProps({className:'vdw-annotation-secondary'})).toHaveLength(1)
    expect(input.style.height).toBe('22px')
  })
  it('多行可见保存保留传入的提交语义，取消沿用关闭且不保存草稿',async()=>{
    const input={scrollHeight:44,style:{height:'',overflowY:''}},fixture=mount({saveLabel:'更新到聊天草稿'},input)
    const save=fixture.renderer.root.findByProps({className:'vdw-annotation-save'})
    expect(save.children).toEqual(['保存'])
    expect(save.props['aria-label']).toBe('更新到聊天草稿')
    act(()=>fixture.textarea().props.onChange({target:{value:'第一行\n第二行'}}))
    act(()=>fixture.button('取消').props.onClick())
    expect(fixture.onClose).toHaveBeenCalledOnce()
    expect(fixture.onSave).not.toHaveBeenCalled()
    fixture.update({open:false});fixture.update({open:true})
    expect(fixture.textarea().props.value).toBe('精简内容')
    await act(async()=>fixture.renderer.root.findByProps({className:'vdw-annotation-save'}).props.onClick())
    expect(fixture.onSave).toHaveBeenCalledExactlyOnceWith('note-one','精简内容',['stable-template'])
  })
  it('多行卡片没有删除回调时不显示删除入口，英文新按钮不翻译用户内容',()=>{
    setLocale('en')
    const fixture=mount({onDelete:undefined}, {scrollHeight:44,style:{height:'',overflowY:''}})
    expect(fixture.button('Cancel')).toBeDefined()
    expect(fixture.button('Save').props.className).toBe('vdw-annotation-save')
    expect(fixture.renderer.root.findAllByProps({className:'vdw-annotation-card-delete'})).toHaveLength(0)
    expect(fixture.textarea().props.value).toBe('精简内容')
    fixture.update({onDelete:vi.fn()})
    expect(fixture.button('Delete annotation').props.className).toBe('vdw-annotation-card-delete')
  })
  it('新注释单行通过删除按钮丢弃草稿，清理回调不触发保存',async()=>{
    const onDiscard=vi.fn(),fixture=mount({annotations:[notes[0]!],onDelete:undefined,onDiscard})
    expect(fixture.button('删除注释').props.className).toBe('vdw-annotation-delete')
    await act(async()=>fixture.button('删除注释').props.onClick())
    expect(onDiscard).toHaveBeenCalledOnce()
    expect(fixture.onSave).not.toHaveBeenCalled()
    expect(fixture.onClose).toHaveBeenCalledOnce()
  })
  it('新注释从单行切换多行时删除入口移至卡片左下方，复用同一丢弃回调',async()=>{
    const input={scrollHeight:22,style:{height:'',overflowY:''}},onDiscard=vi.fn(),fixture=mount({annotations:[notes[0]!],onDelete:undefined,onDiscard},input)
    expect(fixture.button('删除注释').props.className).toBe('vdw-annotation-delete')
    input.scrollHeight=44
    act(()=>fixture.textarea().props.onChange({target:{value:'未保存的新注释\n第二行'}}))
    expect(fixture.button('删除注释').props.className).toBe('vdw-annotation-card-delete')
    await act(async()=>fixture.button('删除注释').props.onClick())
    expect(onDiscard).toHaveBeenCalledOnce()
    expect(fixture.onSave).not.toHaveBeenCalled()
    expect(fixture.onClose).toHaveBeenCalledOnce()
  })
  it('删除按钮占用的真实宽度改变折行阈值，回调变化时重新测量并能恢复单行',()=>{
    const input={scrollHeight:22,style:{height:'',overflowY:''}},layout={width:400,compactHeight:22,expandedHeight:22,contentWidth:320},fixture=mount({onDelete:undefined},input,undefined,layout)
    expect(fixture.renderer.root.findByProps({className:'vdw-annotation-inline-actions'}).findAllByType('button')).toHaveLength(1)
    expect(fixture.button('取消')).toBeUndefined()
    fixture.update({onDiscard:vi.fn()})
    expect(fixture.button('取消')).toBeDefined()
    expect(fixture.button('删除注释').props.className).toBe('vdw-annotation-card-delete')
    expect(input.style.height).toBe('44px')
    fixture.update({onDiscard:undefined})
    expect(fixture.button('取消')).toBeUndefined()
    expect(input.style.height).toBe('22px')
    expect(fixture.textarea().props.value).toBe('精简内容')
  })
  it('进入多行卡片不替换输入，中文选字和Shift+Enter继续受保护，Enter保存原节点引用',async()=>{
    const input={scrollHeight:22,style:{height:'',overflowY:''}},fixture=mount({},input),field=fixture.textarea()
    act(()=>field.props.onCompositionStart())
    input.scrollHeight=44
    act(()=>field.props.onChange({target:{value:'第一行\n输入法候选'}}))
    expect(fixture.textarea()).toBe(field)
    const key=(shiftKey=false)=>({key:'Enter',shiftKey,nativeEvent:{},preventDefault:vi.fn(),stopPropagation:vi.fn()})
    const composing=key()
    act(()=>field.props.onKeyDown(composing))
    expect(composing.preventDefault).not.toHaveBeenCalled()
    act(()=>field.props.onCompositionEnd())
    const newline=key(true)
    act(()=>field.props.onKeyDown(newline))
    expect(newline.preventDefault).not.toHaveBeenCalled()
    expect(fixture.onSave).not.toHaveBeenCalled()
    await act(async()=>field.props.onKeyDown(key()))
    expect(fixture.onSave).toHaveBeenCalledExactlyOnceWith('note-one','第一行\n输入法候选',['stable-template'])
  })
  it('尺寸观察只响应宽度变化，文本增高通知不重复测量且卸载释放观察器',()=>{
    const observers:Array<{callback:()=>void;disconnect:ReturnType<typeof vi.fn>}>=[]
    vi.stubGlobal('ResizeObserver',class{disconnect=vi.fn();constructor(public callback:()=>void){observers.push(this)}observe=vi.fn()})
    const input={scrollHeight:22,style:{height:'',overflowY:''}},layout={width:400,compactHeight:22,expandedHeight:22},fixture=mount({},input,undefined,layout)
    const observer=observers[0]!
    layout.compactHeight=44
    act(()=>observer.callback())
    expect(input.style.height).toBe('22px')
    layout.width=300
    act(()=>observer.callback())
    expect(input.style.height).toBe('44px')
    act(()=>observer.callback())
    expect(input.style.height).toBe('44px')
    fixture.update({open:false})
    expect(observer.disconnect).toHaveBeenCalledOnce()
  })
  it('Enter只提交草稿，Shift+Enter保留换行行为',async()=>{
    const fixture=mount(),key=(shiftKey=false)=>({key:'Enter',shiftKey,nativeEvent:{},preventDefault:vi.fn(),stopPropagation:vi.fn()})
    const newline=key(true)
    act(()=>fixture.textarea().props.onKeyDown(newline))
    expect(newline.preventDefault).not.toHaveBeenCalled()
    expect(fixture.onSave).not.toHaveBeenCalled()
    const enter=key()
    await act(async()=>fixture.textarea().props.onKeyDown(enter))
    expect(enter.preventDefault).toHaveBeenCalledOnce()
    expect(enter.stopPropagation).toHaveBeenCalledOnce()
    expect(fixture.onSave).toHaveBeenCalledExactlyOnceWith('note-one','精简内容',['stable-template'])
  })
  it('中文选字的Enter不会误提交，兼容composition状态、isComposing及229键码',async()=>{
    const fixture=mount(),key=(nativeEvent:Record<string,unknown>={},keyCode?:number)=>({key:'Enter',nativeEvent,keyCode,preventDefault:vi.fn(),stopPropagation:vi.fn()})
    act(()=>fixture.textarea().props.onCompositionStart())
    const composing=key()
    act(()=>fixture.textarea().props.onKeyDown(composing))
    act(()=>fixture.textarea().props.onCompositionEnd())
    for(const event of [key({isComposing:true}),key({keyCode:229}),key({},229)])act(()=>fixture.textarea().props.onKeyDown(event))
    expect(composing.preventDefault).not.toHaveBeenCalled()
    expect(fixture.onSave).not.toHaveBeenCalled()
    await act(async()=>fixture.textarea().props.onKeyDown(key()))
    expect(fixture.onSave).toHaveBeenCalledOnce()
  })
  it('空目标与重复Enter不会触发草稿提交',async()=>{
    const fixture=mount()
    const repeated={key:'Enter',repeat:true,nativeEvent:{},preventDefault:vi.fn(),stopPropagation:vi.fn()}
    await act(async()=>fixture.textarea().props.onKeyDown(repeated))
    expect(fixture.onSave).not.toHaveBeenCalled()
    act(()=>fixture.button('移除引用 a-2 · 模板转换').props.onClick())
    await act(async()=>fixture.textarea().props.onKeyDown({...repeated,repeat:false}))
    expect(fixture.onSave).not.toHaveBeenCalled()
  })
  it('使用轻量浮层，添加菜单支持搜索；增添引用只更新本地草稿，保存才提交稳定节点 ID',async()=>{
    const fixture=mount()
    expect(fixture.renderer.root.findByProps({role:'dialog'}).props.className).toContain('vdw-annotation-popover')
    act(()=>fixture.button('添加引用节点').props.onClick())
    const search=fixture.renderer.root.findByProps({'aria-label':'搜索可添加节点'})
    act(()=>search.props.onChange({target:{value:'输出'}}))
    expect(fixture.renderer.root.findAllByProps({role:'menuitem'})).toHaveLength(1)
    act(()=>fixture.button('添加引用 a-4 · 输出').props.onClick())
    expect(fixture.renderer.root.findByProps({title:'a-4 · 输出'})).toBeTruthy()
    expect(fixture.onSave).not.toHaveBeenCalled()
    await act(async()=>fixture.button('保存').props.onClick())
    expect(fixture.onSave).toHaveBeenCalledExactlyOnceWith('note-one','精简内容',['stable-template','stable-output'])
  })
  it('可添加列表按稳定ID去重并排除已选项，编号和名称相同的不同节点仍可分别添加',async()=>{
    const first={id:'unique-first',number:'b-1',title:'同名节点'},second={...first,id:'unique-second'}
    const fixture=mount({annotations:[notes[0]!],availableNodes:[nodes[0]!,{...nodes[0]!},first,{...first},second]})
    act(()=>fixture.button('添加引用节点').props.onClick())
    expect(fixture.button('添加引用 a-2 · 模板转换')).toBeUndefined()
    const matches=fixture.renderer.root.findAllByProps({'aria-label':'添加引用 b-1 · 同名节点'})
    expect(matches).toHaveLength(2)
    act(()=>matches[0]!.props.onClick())
    act(()=>fixture.button('添加引用节点').props.onClick())
    expect(fixture.renderer.root.findAllByProps({'aria-label':'添加引用 b-1 · 同名节点'})).toHaveLength(1)
    act(()=>fixture.button('添加引用 b-1 · 同名节点').props.onClick())
    await act(async()=>fixture.button('保存').props.onClick())
    expect(fixture.onSave).toHaveBeenCalledExactlyOnceWith('note-one','精简内容',['stable-template','unique-first','unique-second'])
  })
  it('已选容器覆盖全部后代的可添加入口，删除容器后后代立即重新出现并可单独引用',async()=>{
    const parent:AnnotationEditorNode={id:'container',number:'a-4',title:'迭代',ancestorIds:[]}
    const child:AnnotationEditorNode={id:'child',number:'a-4:a-1',title:'模板转换',ancestorIds:[parent.id]}
    const deep:AnnotationEditorNode={id:'deep-child',number:'a-4:a-2:a-1',title:'大语言模型',ancestorIds:[parent.id,'inner-container']}
    const fixture=mount({annotations:[{...notes[0]!,nodes:[parent]}],availableNodes:[parent,child,deep,nodes[4]!]})
    act(()=>fixture.button('添加引用节点').props.onClick())
    expect(fixture.renderer.root.findAllByProps({role:'menuitem'})).toHaveLength(1)
    expect(fixture.button('添加引用 a-4:a-1 · 模板转换')).toBeUndefined()
    expect(fixture.button('添加引用 a-4:a-2:a-1 · 大语言模型')).toBeUndefined()
    act(()=>fixture.button('移除引用 a-4 · 迭代').props.onClick())
    expect(fixture.button('添加引用 a-4:a-1 · 模板转换')).toBeDefined()
    expect(fixture.button('添加引用 a-4:a-2:a-1 · 大语言模型')).toBeDefined()
    act(()=>fixture.renderer.root.findByProps({'aria-label':'搜索可添加节点'}).props.onChange({target:{value:'大语言'}}))
    expect(fixture.renderer.root.findAllByProps({role:'menuitem'})).toHaveLength(1)
    act(()=>fixture.button('添加引用 a-4:a-2:a-1 · 大语言模型').props.onClick())
    await act(async()=>fixture.button('保存').props.onClick())
    expect(fixture.onSave).toHaveBeenCalledExactlyOnceWith('note-one','精简内容',['deep-child'])
  })
  it('保留既有显式父子引用，只隐藏未添加的后代；祖先未选时允许直接添加子节点',async()=>{
    const parent:AnnotationEditorNode={id:'container',number:'a-4',title:'迭代'}
    const child:AnnotationEditorNode={id:'child',number:'a-4:a-1',title:'模板转换',ancestorIds:[parent.id]}
    const sibling:AnnotationEditorNode={id:'sibling',number:'a-4:a-2',title:'大语言模型',ancestorIds:[parent.id]}
    const fixture=mount({annotations:[{...notes[0]!,nodes:[parent,child]}],availableNodes:[parent,child,sibling]})
    expect(fixture.button('移除引用 a-4:a-1 · 模板转换')).toBeDefined()
    act(()=>fixture.button('添加引用节点').props.onClick())
    expect(fixture.button('添加引用 a-4:a-2 · 大语言模型')).toBeUndefined()
    act(()=>fixture.button('移除引用 a-4 · 迭代').props.onClick())
    expect(fixture.button('移除引用 a-4:a-1 · 模板转换')).toBeDefined()
    expect(fixture.button('添加引用 a-4:a-2 · 大语言模型')).toBeDefined()
    act(()=>fixture.button('添加引用 a-4:a-2 · 大语言模型').props.onClick())
    await act(async()=>fixture.button('保存').props.onClick())
    expect(fixture.onSave).toHaveBeenCalledExactlyOnceWith('note-one','精简内容',['child','sibling'])
  })
  it('删除全部引用会禁用保存，重新添加后提交真实新目标而非显示编号',async()=>{
    const fixture=mount()
    act(()=>fixture.button('移除引用 a-2 · 模板转换').props.onClick())
    expect(fixture.button('保存').props.disabled).toBe(true)
    await act(async()=>fixture.button('保存').props.onClick())
    expect(fixture.onSave).not.toHaveBeenCalled()
    act(()=>fixture.button('添加引用节点').props.onClick())
    act(()=>fixture.button('添加引用 a1-1 · 大语言模型').props.onClick())
    expect(fixture.button('保存').props.disabled).toBe(false)
    await act(async()=>fixture.button('保存').props.onClick())
    expect(fixture.onSave).toHaveBeenCalledExactlyOnceWith('note-one','精简内容',['stable-model'])
  })
  it('更多菜单中的溢出引用可搜索并默认提供删除入口',async()=>{
    const fixture=mount({annotations:[{...notes[0]!,nodes}]},undefined,{available:200,widths:[40,40,40,40,40]})
    expect(fixture.renderer.root.findByProps({'aria-label':'引用节点'}).findAllByProps({className:'vdw-annotation-target'})).toHaveLength(3)
    act(()=>fixture.button('查看其余 2 个引用节点').props.onClick())
    expect(fixture.button('移除引用 b-2 · 列表操作')).toBeDefined()
    expect(fixture.renderer.root.findAllByProps({className:'vdw-annotation-node-label'})).toHaveLength(2)
    expect(fixture.renderer.root.findAllByProps({role:'menuitem'})).toHaveLength(2)
    act(()=>fixture.renderer.root.findByProps({'aria-label':'搜索已引用节点'}).props.onChange({target:{value:'列表操作'}}))
    expect(fixture.renderer.root.findAllByProps({className:'vdw-annotation-node-row'})).toHaveLength(1)
    act(()=>fixture.button('移除引用 b-2 · 列表操作').props.onClick())
    await act(async()=>fixture.button('保存').props.onClick())
    expect(fixture.onSave).toHaveBeenCalledExactlyOnceWith('note-one','精简内容',['stable-template','stable-model','stable-output','stable-branch'])
  })
  it('切换批注保留只修改引用目标的草稿，统一保存所有被编辑条目',async()=>{
    const fixture=mount({initialId:'note-two'})
    act(()=>fixture.button('移除引用 a-4 · 输出').props.onClick())
    fixture.selectAnnotation(0)
    await act(async()=>fixture.button('保存').props.onClick())
    expect(fixture.onSave.mock.calls).toEqual([['note-two','统一术语',['stable-model']],['note-one','精简内容',['stable-template']]])
  })
  it('节点结构编号变化后引用仍使用同一稳定 ID',async()=>{
    const fixture=mount()
    const renamed={...nodes[0]!,number:'c-9'}
    fixture.update({annotations:[{...notes[0]!,nodes:[renamed]}],availableNodes:[renamed,...nodes.slice(1)]})
    expect(fixture.renderer.root.findByProps({title:'c-9 · 模板转换'})).toBeTruthy()
    await act(async()=>fixture.button('保存').props.onClick())
    expect(fixture.onSave).toHaveBeenCalledExactlyOnceWith('note-one','精简内容',['stable-template'])
  })
  it('节点标签和原始序号可见，切换条目保留输入，保存一次提交全部已编辑条目', async () => {
    const fixture = mount()
    expect(fixture.renderer.root.findByProps({title:'a-2 · 模板转换'})).toBeTruthy()
    act(() => fixture.textarea().props.onChange({ target: { value: '内容修改' } }))
    fixture.selectAnnotation(1)
    expect(fixture.button('切换注释').props.title).toBe('注释 3')
    expect(fixture.renderer.root.findAllByProps({className:'vdw-annotation-ordinal'})).toHaveLength(0)
    expect(fixture.textarea().props.value).toBe('统一术语')
    act(() => fixture.textarea().props.onChange({ target: { value: '术语修改' } }))
    fixture.selectAnnotation(0)
    expect(fixture.textarea().props.value).toBe('内容修改')
    await act(async () => fixture.button('保存').props.onClick())
    expect(fixture.onSave.mock.calls).toEqual([['note-two', '术语修改',['stable-model','stable-output']], ['note-one', '内容修改',['stable-template']]])
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
    fixture.selectAnnotation(1)
    expect(fixture.button('保存').props.disabled).toBe(true)
    act(() => fixture.renderer.root.findByProps({className:'vdw-annotation-dismiss'}).props.onPointerDown())
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
    act(() => fixture.button('查看工作流').props.onClick())
    expect(fixture.onLocate).toHaveBeenCalledExactlyOnceWith('note-one')
    fixture.update({ onDelete: undefined, disabled: false, saveLabel: '提交到草稿' })
    expect(fixture.button('删除注释')).toBeUndefined()
    expect(fixture.button('提交到草稿')).toBeDefined()
  })
})
