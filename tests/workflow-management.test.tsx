import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorHeading } from '../src/client/editor-heading.tsx'
import { type WorkflowManagementDetails } from '../src/client/workflow-management.tsx'
import { setLocale } from '../src/client/i18n.ts'
import { Select } from '../src/client/controls.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({
  Button:React.forwardRef<HTMLButtonElement,any>(({children,icon,...props},ref)=><button ref={ref} {...props}>{icon}{children}</button>),
  Input:React.forwardRef<HTMLInputElement,any>((props,ref)=><span><input ref={ref} {...props}/></span>),
  Tooltip:({children}:{children:React.ReactNode})=>children,
  Menu:({anchor,...props}:any)=><menu-mock {...props}>{anchor}</menu-mock>,
}))

const renderers:ReactTestRenderer[]=[]
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount());vi.unstubAllGlobals();setLocale('zh-CN')})
function fixture(overrides:Partial<WorkflowManagementDetails>={}){
  const details:WorkflowManagementDetails={workflowId:'2fb464c1-2237-4df8-9404-8014c61eac29',title:'完整工作流标题',description:'原始说明',workspaceName:'本地工作区',workspaceId:'owner-workspace',nodeCount:3,edgeCount:2,updatedAt:'2026-10-18T01:00:00Z',onSaveDetails:vi.fn(async()=>{}),onExport:vi.fn(),...overrides}
  const onSave=vi.fn(),onSaveAs=vi.fn(),onBack=vi.fn(),props={title:details.title,revision:7,saveState:'saved' as const,onBack,onSave,onSaveAs,management:details}
  const listeners=new Map<string,Set<(event:any)=>void>>()
  const focus=vi.fn(),inputFocus=vi.fn(),outside={},inside={}
  const panel={contains:(target:unknown)=>target===inside,querySelector:()=>({focus:inputFocus})}
  const body={getBoundingClientRect:()=>({bottom:400})},heading={}
  const stack={contains:(target:unknown)=>target===inside,closest:(selector:string)=>selector==='.vdw-editor-body'?body:heading,getBoundingClientRect:()=>({top:80})}
  const trigger={contains:()=>false,focus}
  vi.stubGlobal('document',{addEventListener:(type:string,listener:(event:any)=>void)=>{if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type)!.add(listener)},removeEventListener:(type:string,listener:(event:any)=>void)=>listeners.get(type)?.delete(listener)})
  vi.stubGlobal('window',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
  let renderer!:ReactTestRenderer
  act(()=>{renderer=create(<EditorHeading {...props}/>,{createNodeMock:element=>element.props.className==='vdw-editor-title-trigger'?trigger:element.props.className==='vdw-workflow-management-stack'?stack:element.props.className==='vdw-workflow-management'?panel:null})})
  renderers.push(renderer)
  const button=(label:string)=>renderer.root.findAllByType('button').find(button=>button.props['aria-label']===label)!
  const click=(label:string)=>act(()=>button(label).props.onClick())
  const open=()=>click('工作流信息：完整工作流标题')
  const input=()=>renderer.root.findByType('input'),form=()=>renderer.root.findByType('form')
  const event=(type:string,data:any)=>act(()=>{for(const listener of listeners.get(type)??[])listener(data)})
  return{details,props,renderer,button,click,open,input,form,event,focus,inputFocus,outside,inside,onSave,onSaveAs,onBack,listeners}
}

describe('工作流标题管理菜单',()=>{
  it('标题只打开信息菜单，保留真实编号、全部名称和同层面包屑',()=>{
    const f=fixture();expect(f.renderer.root.findAllByProps({role:'dialog'})).toHaveLength(0)
    act(()=>f.renderer.update(<EditorHeading {...f.props} breadcrumb={<button>主流程</button>}/>));f.open()
    expect(f.onSave).not.toHaveBeenCalled();expect(f.details.onSaveDetails).not.toHaveBeenCalled()
    const dialog=f.renderer.root.findByProps({role:'dialog'})
    expect(dialog.props['aria-modal']).toBe('false');expect(dialog.findByType('code').children).toEqual([f.details.workflowId])
    expect(dialog.findByType('strong').children).toEqual([f.details.title])
    expect(f.button('工作流信息：完整工作流标题').props['aria-expanded']).toBe(true)
    expect(f.renderer.root.findByProps({'aria-label':'工作流路径'}).parent?.type).toBe('header')
    expect(f.inputFocus).toHaveBeenCalledWith({preventScroll:true})
    expect(f.renderer.root.findByProps({className:'vdw-workflow-management-stack'}).props.style.maxHeight).toBe(308)
  })

  it('编辑中的名称和说明不随外部保存或语言重绘重置，保存后保持菜单打开',async()=>{
    const f=fixture();f.open()
    act(()=>{f.input().props.onChange({target:{value:'  用户输入的名称  '}});f.renderer.root.findByType('textarea').props.onChange({target:{value:'用户输入的说明'}})})
    act(()=>f.renderer.update(<EditorHeading {...f.props} title="外部更新" management={{...f.details,title:'外部更新',description:'外部说明'}}/>))
    expect(f.input().props.value).toBe('  用户输入的名称  ');expect(f.renderer.root.findByType('textarea').props.value).toBe('用户输入的说明')
    await act(async()=>{f.form().props.onSubmit({preventDefault:vi.fn()});await Promise.resolve()})
    expect(f.details.onSaveDetails).toHaveBeenCalledWith('用户输入的名称','用户输入的说明','workspace')
    expect(f.input().props.value).toBe('用户输入的名称')
    expect(f.renderer.root.findAllByProps({role:'dialog'})).toHaveLength(1)
    expect(f.form().props['aria-busy']).toBe(false)
    expect(f.renderer.root.findAllByType('button').find(button=>button.props.type==='submit')!.props.disabled).toBe(true)
  })

  it('保存期间锁定修改和关闭，失败时保留草稿并在菜单内显示错误',async()=>{
    const f=fixture();let reject!:(error:Error)=>void
    vi.mocked(f.details.onSaveDetails).mockImplementation(()=>new Promise<void>((_,fail)=>{reject=fail}))
    f.open();act(()=>f.input().props.onChange({target:{value:'保留此名称'}}))
    act(()=>{f.form().props.onSubmit({preventDefault:vi.fn()});f.form().props.onSubmit({preventDefault:vi.fn()})})
    expect(f.details.onSaveDetails).toHaveBeenCalledOnce();expect(f.input().props.disabled).toBe(true)
    expect(f.button('关闭工作流信息').props.disabled).toBe(true);expect(f.button('工作流信息：完整工作流标题').props.disabled).toBe(true)
    f.event('keydown',{key:'Escape',preventDefault:vi.fn(),stopPropagation:vi.fn()});f.event('pointerdown',{target:f.outside})
    expect(f.renderer.root.findAllByProps({role:'dialog'})).toHaveLength(1)
    await act(async()=>{reject(new Error('磁盘暂时不可写'));await Promise.resolve()})
    expect(f.renderer.root.findByProps({role:'alert'}).children).toEqual(['磁盘暂时不可写'])
    expect(f.input().props.value).toBe('保留此名称');expect(f.input().props.disabled).toBe(false)
    expect(f.renderer.root.findAllByType('button').find(button=>button.props.type==='submit')!.props.disabled).toBe(false)
  })

  it('复制真实 UUID，并在权限失败时提供可选择编号的反馈',async()=>{
    const f=fixture(),writeText=vi.fn(async()=>{});vi.stubGlobal('navigator',{clipboard:{writeText}});f.open()
    await act(async()=>{f.button('复制工作流编号').props.onClick();await Promise.resolve()})
    expect(writeText).toHaveBeenCalledWith(f.details.workflowId)
    expect(f.renderer.root.findAllByProps({role:'status'}).some(node=>node.children.join('')==='已复制工作流编号')).toBe(true)
    writeText.mockRejectedValueOnce(new Error('denied'))
    await act(async()=>{f.button('复制工作流编号').props.onClick();await Promise.resolve()})
    expect(f.renderer.root.findByType('code').children).toEqual([f.details.workflowId])
    expect(JSON.stringify(f.renderer.toJSON())).toContain('复制失败，请选择编号复制。')
  })

  it('旧流程默认当前工作区，范围只在保存时提交且下拉portal不会关掉画布菜单',async()=>{
    const f=fixture();f.open();const select=()=>f.renderer.root.findByType(Select)
    expect(select().props.value).toBe('workspace')
    expect(select().props.options.map((option:any)=>option.label)).toEqual(['当前工作区','全局'])
    act(()=>select().props.onChange('global'))
    expect(f.details.onSaveDetails).not.toHaveBeenCalled();expect(f.details.scope).toBeUndefined()
    f.event('pointerdown',{target:{closest:()=>({role:'menu'})}})
    expect(f.renderer.root.findAllByProps({role:'dialog'})).toHaveLength(1)
    expect(select().props.value).toBe('global')
    await act(async()=>{f.form().props.onSubmit({preventDefault:vi.fn()});await Promise.resolve()})
    expect(f.details.onSaveDetails).toHaveBeenCalledExactlyOnceWith(f.details.title,f.details.description,'global')
    expect(f.details.workspaceId).toBe('owner-workspace')
    expect(f.renderer.root.findAllByType('dd').some(node=>node.children.includes('本地工作区'))).toBe(true)
  })

  it('未应用的scope关闭后丢弃，全局流程仍保留真实所属工作区',()=>{
    const f=fixture({scope:'global',workspaceName:undefined});f.open()
    const select=()=>f.renderer.root.findByType(Select)
    expect(select().props.value).toBe('global')
    expect(f.renderer.root.findAllByType('dd').some(node=>node.children.includes('owner-workspace'))).toBe(true)
    act(()=>select().props.onChange('workspace'));f.click('关闭工作流信息');f.open()
    expect(select().props.value).toBe('global');expect(f.details.onSaveDetails).not.toHaveBeenCalled()
  })

  it('Escape 返回标题焦点，外部点击丢弃未应用草稿但不夺取焦点',()=>{
    const f=fixture();f.open();act(()=>f.input().props.onChange({target:{value:'未应用'}}))
    f.event('pointerdown',{target:f.inside});expect(f.renderer.root.findAllByProps({role:'dialog'})).toHaveLength(1)
    f.event('pointerdown',{target:f.outside});expect(f.renderer.root.findAllByProps({role:'dialog'})).toHaveLength(0);expect(f.focus).not.toHaveBeenCalled()
    f.open();expect(f.input().props.value).toBe(f.details.title)
    const preventDefault=vi.fn(),stopPropagation=vi.fn();f.event('keydown',{key:'Escape',preventDefault,stopPropagation})
    expect(f.renderer.root.findAllByProps({role:'dialog'})).toHaveLength(0);expect(f.focus).toHaveBeenCalledWith({preventScroll:true});expect(preventDefault).toHaveBeenCalledOnce()
    expect(f.details.onSaveDetails).not.toHaveBeenCalled()
  })

  it.each(['导出','另存为'])('%s 关闭菜单后打开已有功能入口',(label)=>{
    const f=fixture();f.open();const button=f.renderer.root.findAllByType('button').find(button=>button.children.includes(label))!
    act(()=>button.props.onClick())
    expect(f.renderer.root.findAllByProps({role:'dialog'})).toHaveLength(0)
    expect(label==='导出'?f.details.onExport:f.onSaveAs).toHaveBeenCalledOnce();expect(f.details.onSaveDetails).not.toHaveBeenCalled()
  })

  it('保存反馈放在菜单后方且英文界面保留用户名称与说明',()=>{
    const f=fixture();f.open();act(()=>f.renderer.update(<EditorHeading {...f.props} saveState="saving"/>))
    const stack=f.renderer.root.findByProps({className:'vdw-workflow-management-stack'}),feedback=f.renderer.root.findByProps({className:'vdw-save-feedback'})
    expect(feedback.parent).toBe(stack);expect(stack.children.at(-1)).toBe(feedback);expect(feedback.props['aria-hidden']).toBe('true')
    expect(f.renderer.root.findByProps({className:'vdw-editor-save-state'}).props.role).toBe('status')
    act(()=>{setLocale('en');f.renderer.update(<EditorHeading {...f.props} saveState="saved" savedAt={1}/>)})
    expect(f.renderer.root.findByProps({role:'dialog'}).findByType('strong').children).toEqual([f.details.title])
    expect(f.renderer.root.findByProps({'aria-label':'Workflow description'}).props.value).toBe(f.details.description)
    expect(JSON.stringify(f.renderer.toJSON())).toContain('Workflow ID')
  })
})
