import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HomeWorkflowManagementDialog, type HomeWorkflowManagementDialogProps } from '../src/client/home-workflow-management-dialog.tsx'
import { type WorkflowManagementDetails } from '../src/client/workflow-management.tsx'
import { Select } from '../src/client/controls.tsx'
import { setLocale } from '../src/client/i18n.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({
  Button:React.forwardRef<HTMLButtonElement,any>(({children,icon,...props},ref)=><button ref={ref} {...props}>{icon}{children}</button>),
  Input:({children,...props}:any)=><span><input {...props}/>{children}</span>,
  Tooltip:({children}:any)=>children,
  Menu:({anchor,...props}:any)=><menu-mock {...props}>{anchor}</menu-mock>,
  Modal:({children,...props}:any)=><modal-mock {...props}>{children}</modal-mock>,
}))
const renderers:ReactTestRenderer[]=[]
afterEach(()=>{renderers.splice(0).forEach(renderer=>act(()=>renderer.unmount()));setLocale('zh-CN')})
function fixture(overrides:Partial<WorkflowManagementDetails>={}){
  const details:WorkflowManagementDetails={workflowId:'target-card-id',title:'独立卡片流程',description:'保留说明',workspaceId:'owner-workspace',workspaceName:'真实所属工作区',revision:8,nodeCount:4,edgeCount:3,updatedAt:'2026-10-18T00:00:00Z',onSaveDetails:vi.fn(async()=>{}),onExport:vi.fn(),...overrides}
  const props:HomeWorkflowManagementDialogProps={open:true,details,onClose:vi.fn(),onSaveAs:vi.fn()}
  let renderer!:ReactTestRenderer;act(()=>{renderer=create(<HomeWorkflowManagementDialog {...props}/>)});renderers.push(renderer)
  const select=()=>renderer.root.findByType(Select),form=()=>renderer.root.findByType('form'),modal=()=>renderer.root.findByType('modal-mock' as never)
  const submit=async()=>{await act(async()=>{form().props.onSubmit({preventDefault:vi.fn()});await Promise.resolve()})}
  const update=(next:Partial<HomeWorkflowManagementDialogProps>)=>{Object.assign(props,next);act(()=>renderer.update(<HomeWorkflowManagementDialog {...props}/>))}
  return {details,props,renderer,select,form,modal,submit,update}
}

describe('首页独立工作流管理弹窗',()=>{
  it('采用独立居中Modal及同一元信息表单，打开不调用任何保存或导出操作',()=>{
    const f=fixture()
    expect(f.modal().props.title).toBe('管理工作流');expect(f.modal().props.className).toContain('vdw-home-workflow-management')
    expect(f.renderer.root.findAllByProps({className:'vdw-workflow-management-stack'})).toHaveLength(0)
    expect(f.renderer.root.findByType('code').children).toEqual([f.details.workflowId])
    expect(f.renderer.root.findByType('input').props['data-modal-autofocus']).toBe(true)
    expect(f.select().props.value).toBe('workspace');expect(f.details.onSaveDetails).not.toHaveBeenCalled();expect(f.details.onExport).not.toHaveBeenCalled()
  })

  it('scope切换仅改变草稿，保存时提交第三参且不改变所属工作区，成功后保持弹窗打开',async()=>{
    const f=fixture();act(()=>f.select().props.onChange('global'))
    expect(f.details.onSaveDetails).not.toHaveBeenCalled();expect(f.details.scope).toBeUndefined()
    await f.submit()
    expect(f.details.onSaveDetails).toHaveBeenCalledExactlyOnceWith(f.details.title,f.details.description,'global')
    expect(f.details.workspaceId).toBe('owner-workspace');expect(f.select().props.value).toBe('global')
    expect(f.renderer.root.findAllByType('dd').some(node=>node.children.includes('真实所属工作区'))).toBe(true)
    expect(f.renderer.root.findByProps({role:'status'}).children).toEqual(['已保存'])
    expect(f.props.onClose).not.toHaveBeenCalled()
    expect(f.renderer.root.findAllByType('button').find(button=>button.props.type==='submit')!.props.disabled).toBe(true)
  })

  it('保存失败保留scope与名称草稿，重试仍提交所选范围',async()=>{
    const f=fixture();vi.mocked(f.details.onSaveDetails).mockRejectedValueOnce(new Error('写入版本冲突'))
    act(()=>{f.select().props.onChange('global');f.renderer.root.findByType('input').props.onChange({target:{value:' 名称草稿 '}})})
    await f.submit()
    expect(f.renderer.root.findByProps({role:'alert'}).children).toEqual(['写入版本冲突'])
    expect(f.select().props.value).toBe('global');expect(f.renderer.root.findByType('input').props.value).toBe(' 名称草稿 ')
    expect(f.props.onClose).not.toHaveBeenCalled();await f.submit()
    expect(f.details.onSaveDetails).toHaveBeenLastCalledWith('名称草稿',f.details.description,'global')
    expect(f.renderer.root.findByType('input').props.value).toBe('名称草稿')
  })

  it('保存中锁定Modal关闭与下拉，外部重绘不覆盖未应用值',async()=>{
    const f=fixture();let finish!:()=>void
    vi.mocked(f.details.onSaveDetails).mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve}))
    act(()=>f.select().props.onChange('global'));f.update({details:{...f.details,scope:'workspace',title:'外部标题'}})
    expect(f.select().props.value).toBe('global');expect(f.renderer.root.findByType('input').props.value).toBe('独立卡片流程')
    act(()=>f.form().props.onSubmit({preventDefault:vi.fn()}));expect(f.select().props.disabled).toBe(true)
    act(()=>f.modal().props.onClose());expect(f.props.onClose).not.toHaveBeenCalled()
    await act(async()=>{finish();await Promise.resolve()})
    act(()=>f.modal().props.onClose());expect(f.props.onClose).toHaveBeenCalledOnce()
  })

  it.each(['导出','另存为'])('%s先关闭首页管理，再调用所选卡片入口',(label)=>{
    const f=fixture(),button=f.renderer.root.findAllByType('button').find(button=>button.children.includes(label))!
    act(()=>button.props.onClick())
    const action=label==='导出'?f.details.onExport:f.props.onSaveAs!
    expect(f.props.onClose).toHaveBeenCalledOnce();expect(action).toHaveBeenCalledOnce()
    expect(vi.mocked(f.props.onClose).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(action).mock.invocationCallOrder[0]!)
    expect(f.details.onSaveDetails).not.toHaveBeenCalled()
  })

  it('英文范围标签保持双语，关闭再打开重置未保存的scope而不改源数据',()=>{
    const f=fixture({scope:'global'});act(()=>{setLocale('en');f.select().props.onChange('workspace')})
    expect(f.select().props.options.map((option:any)=>option.label)).toEqual(['Current workspace','Global'])
    expect(f.renderer.root.findByType('input').props.value).toBe(f.details.title)
    f.update({open:false});expect(f.renderer.toJSON()).toBeNull();f.update({open:true})
    expect(f.select().props.value).toBe('global');expect(f.details.scope).toBe('global')
    expect(f.details.onSaveDetails).not.toHaveBeenCalled()
  })
})
