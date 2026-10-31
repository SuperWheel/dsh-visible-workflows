import React from 'react'
import {act,create,type ReactTestRenderer} from 'react-test-renderer'
import {afterEach,describe,it,expect,vi} from 'vitest'
import {WorkflowApp,type AnnotationBridge,type WorkflowNavigation} from '../src/client/app.tsx'
import {WorkflowStore} from '../src/client/store.ts'
import {makeWorkflow,type WorkflowAPI} from '../src/shared/types.ts'
import type {WorkflowRequestSnapshot} from '../src/client/chat-bridge.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Input:'input',Tooltip:({children}:any)=>children,Menu:()=>null,Modal:()=>null}))
vi.mock('../src/client/canvas.tsx',()=>({Canvas:(props:any)=><canvas-mock {...props}/>}))
vi.mock('../src/client/workflow-request-dialog.tsx',()=>({WorkflowRequestDialog:(props:any)=><request-mock {...props}/>}))
vi.mock('../src/client/home-workflow-management-dialog.tsx',()=>({HomeWorkflowManagementDialog:(props:any)=><management-mock {...props}/>}))
vi.mock('../src/client/workflow-home-card.tsx',()=>({WorkflowHomeCard:(props:any)=><card-mock {...props}/>}))
const stores:WorkflowStore[]=[],uis:ReactTestRenderer[]=[]
afterEach(()=>{for(const ui of uis.splice(0))act(()=>ui.unmount());for(const store of stores.splice(0))store.dispose()})
function fixture(){
  let persisted={...makeWorkflow('workspace','保留用户名称',true),revision:2}
  const api={save:vi.fn(async(raw:string)=>{persisted={...JSON.parse(raw),revision:persisted.revision+1};return structuredClone(persisted)}),get:vi.fn(async()=>structuredClone(persisted))} as unknown as WorkflowAPI
  const store=new WorkflowStore(api);stores.push(store)
  store.update({workflow:structuredClone(persisted),page:'canvas',sessionId:'session',loading:false,library:{workflows:[structuredClone(persisted)],workspaces:[{id:'workspace',name:'本项目'}],runs:[],presets:[]}})
  let staged:WorkflowRequestSnapshot|undefined
  const listeners=new Set<()=>void>(),notify=()=>listeners.forEach(fn=>fn())
  const chat:AnnotationBridge={getAnnotations:()=>[],subscribe:fn=>{listeners.add(fn);return()=>{listeners.delete(fn)}},stageAnnotation:vi.fn(async()=>{}),deleteAnnotation:vi.fn(async()=>{}),insertWorkflow:vi.fn(async()=>{}),getGenerateRequest:()=>staged,insertGenerateRequest:vi.fn(async(_id,text)=>{staged={id:'request',text,revision:(staged?.revision??0)+1,status:'draft'};notify();return true})}
  const navigation:WorkflowNavigation={getSessionId:()=> 'session',sessions:()=>[{id:'session',title:'当前会话'}],toFull:()=>{},toSide:()=>{},openSettings:()=>{},openChat:vi.fn(async()=>{})}
  let ui!:ReactTestRenderer;act(()=>{ui=create(<WorkflowApp store={store} mode="side" navigation={navigation} chat={chat}/>)});uis.push(ui)
  const open=()=>act(()=>ui.root.findByType('canvas-mock' as never).props.onAgent()),dialog=()=>ui.root.findByType('request-mock' as never)
  return {ui,store,chat,api,navigation,open,dialog,admit:()=>act(()=>{staged=undefined;notify()}),sending:()=>act(()=>{staged={...staged!,status:'sending'};notify()})}
}
describe('workflow request lifecycle in the existing app',()=>{
  it('restoring a local requirements draft does not automatically open its dialog',()=>{
    const f=fixture();act(()=>f.store.update({generateDraft:'之前保存的本地输入',generateTargetId:f.store.getSnapshot().workflow!.id}))
    expect(f.ui.root.findAllByType('request-mock' as never)).toHaveLength(0)
    f.open();expect(f.dialog().props.value).toBe('之前保存的本地输入')
  })
  it('reopens and updates the same submitted draft, resetting only after Host admission',async()=>{
    const f=fixture();f.open()
    expect(f.dialog().props.value).toBe('');expect(f.dialog().props.target.title).toBe('保留用户名称')
    act(()=>f.dialog().props.onChange('第一次完整需求'))
    await act(async()=>f.dialog().props.onSubmit())
    expect(f.ui.root.findAllByType('request-mock' as never)).toHaveLength(0)
    f.open();expect(f.dialog().props.value).toBe('第一次完整需求');expect(f.dialog().props.submitted).toBe(true)
    act(()=>f.dialog().props.onChange('第二次修改需求'))
    await act(async()=>f.dialog().props.onSubmit())
    f.open();expect(f.dialog().props.value).toBe('第二次修改需求')
    expect(f.store.getSnapshot().generateRequestId).toBe('request')
    f.sending();expect(f.dialog().props.working).toBe(true)
    f.admit();expect(f.store.getSnapshot().generateDraft).toBeUndefined()
    f.open();expect(f.dialog().props.value).toBe('');expect(f.dialog().props.submitted).toBe(false)
    expect(f.chat.insertGenerateRequest).toHaveBeenCalledTimes(2)
  })
  it('cancel and unavailable composer retain the local requirements',async()=>{
    const f=fixture();f.open();act(()=>f.dialog().props.onChange('不要丢失本地输入'))
    act(()=>f.dialog().props.onClose());f.open();expect(f.dialog().props.value).toBe('不要丢失本地输入')
    vi.mocked(f.chat.insertGenerateRequest).mockResolvedValueOnce(false)
    await act(async()=>f.dialog().props.onSubmit())
    expect(f.dialog().props.value).toBe('不要丢失本地输入');expect(f.dialog().props.error).toContain('聊天草稿暂时无法接收')
  })
  it('persists unsaved canvas content before handing its latest revision to Agent',async()=>{
    const f=fixture();f.open();act(()=>{f.dialog().props.onChange('帮我优化这个 workflow');f.store.edit({...f.store.getSnapshot().workflow!,description:'尚未保存的处理要求'})})
    await act(async()=>f.dialog().props.onSubmit())
    expect(f.api.save).toHaveBeenCalledOnce()
    expect(JSON.parse(vi.mocked(f.api.save).mock.calls[0]![0]).description).toBe('尚未保存的处理要求')
    expect(f.chat.insertGenerateRequest).toHaveBeenCalledExactlyOnceWith('session','帮我优化这个 workflow',expect.objectContaining({id:f.store.getSnapshot().workflow!.id,revision:3,description:'尚未保存的处理要求'}))
  })
  it('does not hand off requirements when saving the current canvas fails',async()=>{
    const f=fixture();f.open();act(()=>{f.dialog().props.onChange('优化流程');f.store.edit({...f.store.getSnapshot().workflow!,description:'待保存'})})
    vi.mocked(f.api.save).mockRejectedValueOnce(new Error('当前版本冲突'))
    await act(async()=>f.dialog().props.onSubmit())
    expect(f.chat.insertGenerateRequest).not.toHaveBeenCalled()
    expect(f.dialog().props.value).toBe('优化流程');expect(f.dialog().props.error).toContain('当前版本冲突')
  })
  it('rejects a changed target while the native conversation is mounting',async()=>{
    const f=fixture();f.open();act(()=>f.dialog().props.onChange('仅优化原流程'))
    let release!:()=>void,submission!:Promise<void>
    vi.mocked(f.navigation.openChat).mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve}))
    await act(async()=>{submission=f.dialog().props.onSubmit();await Promise.resolve()})
    expect(release).toBeTypeOf('function')
    const other={...makeWorkflow('workspace','新的画布'),revision:1}
    act(()=>f.store.update({workflow:other,library:{...f.store.getSnapshot().library,workflows:[other]},generateDraft:'新画布需求',generateTargetId:other.id}))
    await act(async()=>{release();await submission})
    expect(f.chat.insertGenerateRequest).not.toHaveBeenCalled()
    expect(f.store.getSnapshot().workflow?.id).toBe(other.id)
  })
  it('includes canvas edits made while the conversation was mounting',async()=>{
    const f=fixture();f.open();act(()=>f.dialog().props.onChange('继续优化流程'))
    let release!:()=>void,submission!:Promise<void>
    vi.mocked(f.navigation.openChat).mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve}))
    await act(async()=>{submission=f.dialog().props.onSubmit();await Promise.resolve()})
    act(()=>f.store.edit({...f.store.getSnapshot().workflow!,description:'挂载期间的新修改'}))
    await act(async()=>{release();await submission})
    expect(f.chat.insertGenerateRequest).toHaveBeenCalledExactlyOnceWith('session','继续优化流程',expect.objectContaining({revision:3,description:'挂载期间的新修改'}))
  })
  it('home management saves scope for the selected card without opening its canvas',async()=>{
    const f=fixture();act(()=>f.store.update({page:'library'}))
    act(()=>f.ui.root.findByType('card-mock' as never).props.onManage())
    const details=f.ui.root.findByType('management-mock' as never).props.details
    await act(async()=>details.onSaveDetails('新名称','新说明','global'))
    expect(f.store.getSnapshot().page).toBe('library')
    expect(f.store.getSnapshot().library.workflows[0]).toMatchObject({title:'新名称',description:'新说明',scope:'global',workspaceId:'workspace'})
    expect(f.store.getSnapshot().workflow?.scope).toBe('global')
  })
})
