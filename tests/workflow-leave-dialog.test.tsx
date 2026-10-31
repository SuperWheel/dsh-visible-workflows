import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowLeaveDialog } from '../src/client/workflow-leave-dialog.tsx'
import { setLocale } from '../src/client/i18n.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Modal:({children,footer,...props}:any)=><modal-mock {...props}>{children}{footer}</modal-mock>}))
const renderers:ReactTestRenderer[]=[]
afterEach(()=>{renderers.splice(0).forEach(renderer=>act(()=>renderer.unmount()));setLocale('zh-CN')})
function fixture(working=false){const onCancel=vi.fn(),onDiscard=vi.fn(),onSave=vi.fn();let renderer!:ReactTestRenderer;act(()=>{renderer=create(<WorkflowLeaveDialog workflowTitle="用户原有名称" working={working} error="" onCancel={onCancel} onDiscard={onDiscard} onSave={onSave}/>)});renderers.push(renderer);return {renderer,onCancel,onDiscard,onSave}}
describe('workflow unsaved-return confirmation',()=>{
  it('offers explicit cancel, discard and save actions in a native modal',()=>{
    const f=fixture(),buttons=f.renderer.root.findAllByType('button')
    expect(f.renderer.root.findByType('modal-mock' as never).props.className).toContain('vdw-leave-dialog')
    expect(buttons.map(button=>button.children.join(''))).toEqual(['取消','不保存并返回','保存并返回'])
    act(()=>buttons[0]!.props.onClick());act(()=>buttons[1]!.props.onClick());act(()=>buttons[2]!.props.onClick())
    expect(f.onCancel).toHaveBeenCalledOnce();expect(f.onDiscard).toHaveBeenCalledOnce();expect(f.onSave).toHaveBeenCalledOnce()
  })
  it('treats native dismissal as cancel and keeps the dialog open while an action is pending',()=>{
    const f=fixture(true);expect(f.renderer.root.findAllByType('button').every(button=>button.props.disabled)).toBe(true)
    act(()=>f.renderer.root.findByType('modal-mock' as never).props.onClose());expect(f.onCancel).not.toHaveBeenCalled()
  })
  it('shows a save failure in the same dialog and allows a later cancel',()=>{
    const f=fixture();act(()=>f.renderer.update(<WorkflowLeaveDialog workflowTitle="用户原有名称" error="保存失败，修改已保留" onCancel={f.onCancel} onDiscard={f.onDiscard} onSave={f.onSave}/>))
    expect(f.renderer.root.findByProps({role:'alert'}).children).toEqual(['保存失败，修改已保留'])
    act(()=>f.renderer.root.findByType('modal-mock' as never).props.onClose());expect(f.onCancel).toHaveBeenCalledOnce();expect(f.onDiscard).not.toHaveBeenCalled()
  })
  it('translates UI labels without changing the user workflow title',()=>{
    const f=fixture();act(()=>setLocale('en'))
    expect(f.renderer.root.findByType('modal-mock' as never).props.title).toBe('Save workflow changes?')
    expect(f.renderer.root.findByType('strong').children).toEqual(['用户原有名称'])
    expect(f.renderer.root.findAllByType('button').map(button=>button.children.join(''))).toEqual(['Cancel','Discard and return','Save and return'])
  })
})
