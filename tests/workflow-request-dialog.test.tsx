import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowRequestDialog, type WorkflowRequestDialogProps } from '../src/client/workflow-request-dialog.tsx'
import { setLocale } from '../src/client/i18n.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({
  Button:'button',
  Tooltip:({children,label}:any)=><tooltip-mock label={label}>{children}</tooltip-mock>,
  Modal:({children,...props}:any)=><modal-mock {...props}>{children}</modal-mock>,
}))
const renderers:ReactTestRenderer[]=[]
afterEach(()=>{renderers.splice(0).forEach(renderer=>act(()=>renderer.unmount()));setLocale('zh-CN')})
function fixture(overrides:Partial<WorkflowRequestDialogProps>={}){
  const props:WorkflowRequestDialogProps={open:true,target:{title:'用户自己的流程名称',id:'d4887f0e-cbf1-41af-bf78-a1d5597eb19a',workspaceId:'workspace'},value:'保留 {{input.text}}\n原始需求🙂',onChange:vi.fn(),onClose:vi.fn(),onSubmit:vi.fn(),...overrides}
  let renderer!:ReactTestRenderer;act(()=>{renderer=create(<WorkflowRequestDialog {...props}/>)});renderers.push(renderer)
  const update=(next:Partial<WorkflowRequestDialogProps>)=>{Object.assign(props,next);act(()=>renderer.update(<WorkflowRequestDialog {...props}/>))}
  const field=()=>renderer.root.findByType('textarea')
  const submit=()=>act(()=>renderer.root.findByType('form').props.onSubmit({preventDefault:vi.fn()}))
  return {renderer,props,update,field,submit}
}

describe('Agent 需求草稿对话框',()=>{
  it('显示 @目标标签，编号只在可访问说明与提示中，正文不预填或修改用户值',()=>{
    const f=fixture(),target=f.renderer.root.findByProps({className:'vdw-workflow-request-target'})
    expect(target.children.map(child=>typeof child==='string'?child:child.children.join('')).join('')).toBe(`@${f.props.target!.title}`)
    expect(target.props['aria-label']).toContain(f.props.target!.id)
    expect(f.renderer.root.findAllByType('tooltip-mock' as never).some(item=>item.props.label.includes(f.props.target!.id))).toBe(true)
    expect(f.field().props.value).toBe(f.props.value);expect(f.field().props.value).not.toContain(f.props.target!.id)
    expect(f.field().props['data-modal-autofocus']).toBe(true)
    expect(f.props.onChange).not.toHaveBeenCalled();expect(f.props.onSubmit).not.toHaveBeenCalled()
  })

  it('需求保持受控且保留空行和变量引用，只有显式提交才通知调用者',()=>{
    const f=fixture(),value='  用户原文\n\n{{input.text}} 🙂  '
    act(()=>f.field().props.onChange({target:{value}}));expect(f.props.onChange).toHaveBeenCalledExactlyOnceWith(value)
    expect(f.props.onSubmit).not.toHaveBeenCalled();expect(f.field().props.value).toBe(f.props.value)
    f.update({value});f.submit();expect(f.props.onSubmit).toHaveBeenCalledOnce();expect(f.props.onClose).not.toHaveBeenCalled()
    expect(f.field().props.value).toBe(value)
  })

  it.each(['',' \n\t '])('空白需求不会提交：%j',value=>{
    const f=fixture({value});expect(f.renderer.root.findAllByType('button').find(button=>button.props.type==='submit')!.props.disabled).toBe(true)
    f.submit();expect(f.props.onSubmit).not.toHaveBeenCalled()
  })

  it('工作中锁定编辑、关闭与提交，忽略重复事件且保留错误原文',()=>{
    const f=fixture({working:true,error:'原生聊天暂时不可用'})
    expect(f.field().props.disabled).toBe(true);expect(f.field().props['aria-invalid']).toBe(true)
    expect(f.renderer.root.findByProps({role:'alert'}).children).toEqual(['原生聊天暂时不可用'])
    expect(f.renderer.root.findAllByType('button').every(button=>button.props.disabled)).toBe(true)
    act(()=>{f.field().props.onChange({target:{value:'不得覆盖'}});f.renderer.root.findByType('modal-mock' as never).props.onClose();f.renderer.root.findByProps({'aria-label':'关闭需求输入'}).props.onClick()});f.submit()
    expect(f.props.onChange).not.toHaveBeenCalled();expect(f.props.onClose).not.toHaveBeenCalled();expect(f.props.onSubmit).not.toHaveBeenCalled()
    f.update({working:false});act(()=>f.renderer.root.findByType('modal-mock' as never).props.onClose());expect(f.props.onClose).toHaveBeenCalledOnce()
    expect(f.field().props.value).toBe(f.props.value)
  })

  it('关闭和重新打开保留父层草稿，更新草稿使用明确文案',()=>{
    const f=fixture();f.update({open:false});expect(f.renderer.toJSON()).toBeNull()
    expect(f.props.onChange).not.toHaveBeenCalled();f.update({open:true,submitted:true})
    expect(f.field().props.value).toBe(f.props.value)
    expect(f.renderer.root.findAllByType('button').find(button=>button.props.type==='submit')!.children).toEqual(['更新聊天草稿'])
    const cancel=f.renderer.root.findAllByType('button').find(button=>button.children.includes('取消'))!;act(()=>cancel.props.onClick())
    expect(f.props.onClose).toHaveBeenCalledOnce();expect(f.props.onSubmit).not.toHaveBeenCalled()
  })

  it('首页需求使用新工作流目标，语言切换只改变界面不改变用户文本',()=>{
    const f=fixture({target:undefined,value:'中英混合 user request 🙂'})
    expect(f.renderer.root.findByProps({className:'vdw-workflow-request-target'}).children).toEqual(['新建工作流'])
    act(()=>setLocale('en'))
    expect(f.renderer.root.findByType('modal-mock' as never).props.title).toBe('Ask Agent')
    expect(f.renderer.root.findByProps({className:'vdw-workflow-request-target'}).children).toEqual(['New workflow'])
    expect(f.field().props.value).toBe('中英混合 user request 🙂')
    expect(f.renderer.root.findAllByType('button').find(button=>button.props.type==='submit')!.children).toEqual(['Add to chat draft'])
    expect(f.props.onChange).not.toHaveBeenCalled()
  })
})
