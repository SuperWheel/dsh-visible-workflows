import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowApp, type WorkflowNavigation } from '../src/client/app.tsx'
import { WorkflowStore } from '../src/client/store.ts'
import { makeWorkflow, type WorkflowAPI } from '../src/shared/types.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Input:'input',Tooltip:({children}:any)=>children,Menu:()=>null,Modal:({children,footer,...props}:any)=><modal-mock {...props}>{children}{footer}</modal-mock>}))
vi.mock('../src/client/canvas.tsx',()=>({Canvas:(props:any)=><canvas-mock {...props}/>,svgForWorkflow:()=>'<svg/>'}))
vi.mock('../src/client/editor-heading.tsx',()=>({EditorHeading:(props:any)=><heading-mock {...props}/>}))
vi.mock('../src/client/workflow-leave-dialog.tsx',()=>({WorkflowLeaveDialog:(props:any)=><leave-dialog-mock {...props}/>}))
const mounted:ReactTestRenderer[]=[],stores:WorkflowStore[]=[]
afterEach(()=>{for(const ui of mounted.splice(0))act(()=>ui.unmount());for(const store of stores.splice(0))store.dispose()})
function fixture(){
  let persisted={...makeWorkflow('workspace','原名称',true),description:'原简介',revision:4}
  const api={save:vi.fn(async(raw:string,revision:number)=>{persisted={...JSON.parse(raw),revision:revision+1};return structuredClone(persisted)}),get:vi.fn(async()=>structuredClone(persisted)),models:vi.fn(async()=>[]),presets:vi.fn(async()=>[])} as unknown as WorkflowAPI
  const store=new WorkflowStore(api);stores.push(store)
  store.update({workflow:structuredClone(persisted),page:'canvas',sessionId:'session',loading:false,library:{workflows:[structuredClone(persisted)],workspaces:[{id:'workspace',name:'我的工作区'}],presets:[],runs:[]}})
  const navigation:WorkflowNavigation={toFull:vi.fn(),toSide:vi.fn(),openChat:vi.fn(),openSettings:vi.fn(),getSessionId:()=> 'session'}
  let ui!:ReactTestRenderer;act(()=>{ui=create(<WorkflowApp store={store} mode="full" navigation={navigation}/>)})
  mounted.push(ui)
  return {ui,store,api,heading:()=>ui.root.findByType('heading-mock' as never),dialog:()=>ui.root.findByType('leave-dialog-mock' as never)}
}
describe('workflow management integration',()=>{
  it('exposes real workflow metadata without saving on menu discovery, and merges edits into the latest graph',async()=>{
    const f=fixture(),details=f.heading().props.management
    expect(details).toMatchObject({workflowId:f.store.getSnapshot().workflow!.id,title:'原名称',description:'原简介',workspaceName:'我的工作区',revision:4,nodeCount:3,edgeCount:2})
    expect(f.api.save).not.toHaveBeenCalled()
    const flow=f.store.getSnapshot().workflow!
    act(()=>f.store.edit({...flow,nodes:flow.nodes.map((node,index)=>index?node:{...node,title:'保留同时修改的节点'})}))
    await act(async()=>{await details.onSaveDetails('新的名称','新的简介')})
    expect(f.store.getSnapshot().workflow).toMatchObject({title:'新的名称',description:'新的简介',revision:5})
    expect(f.store.getSnapshot().workflow!.nodes).toHaveLength(3)
    expect(f.store.getSnapshot().workflow!.nodes[0]!.title).toBe('保留同时修改的节点')
    expect(f.store.hasUnsavedChanges()).toBe(false)
  })
  it('asks before leaving dirty definitions and cancellation retains the edit without any write',()=>{
    const f=fixture();act(()=>f.store.edit({...f.store.getSnapshot().workflow!,title:'未保存的名称'}))
    act(()=>f.heading().props.onBack())
    expect(f.dialog().props).toMatchObject({workflowTitle:'未保存的名称',working:false,error:''})
    expect(f.store.getSnapshot().page).toBe('canvas');expect(f.api.save).not.toHaveBeenCalled()
    act(()=>f.dialog().props.onCancel())
    expect(f.ui.root.findAllByType('leave-dialog-mock' as never)).toHaveLength(0)
    expect(f.store.getSnapshot().workflow!.title).toBe('未保存的名称')
    expect(f.store.hasUnsavedChanges()).toBe(true)
  })
  it('saves before leaving and keeps the dialog and draft if saving fails',async()=>{
    const f=fixture();act(()=>f.store.edit({...f.store.getSnapshot().workflow!,title:'待保存名称'}))
    vi.mocked(f.api.save).mockRejectedValueOnce(new Error('写入失败'))
    act(()=>f.heading().props.onBack())
    await act(async()=>{await f.dialog().props.onSave()})
    expect(f.store.getSnapshot().page).toBe('canvas');expect(f.dialog().props.error).toContain('写入失败')
    expect(f.store.getSnapshot().workflow!.title).toBe('待保存名称')
    await act(async()=>{await f.dialog().props.onSave()})
    expect(f.store.getSnapshot().page).toBe('library')
    expect(f.store.getSnapshot().workflow!.title).toBe('待保存名称')
  })
  it('discards the changed definition through the store without a save and reopens the persisted title',async()=>{
    const f=fixture(),original=f.store.getSnapshot().workflow!
    act(()=>f.store.edit({...original,title:'将被放弃'}));act(()=>f.heading().props.onBack())
    await act(async()=>{await f.dialog().props.onDiscard()})
    expect(f.api.save).not.toHaveBeenCalled();expect(f.api.get).toHaveBeenCalledWith(original.id)
    expect(f.store.getSnapshot()).toMatchObject({page:'library',workflow:{title:'原名称'},undo:[],redo:[]})
    expect(f.store.hasUnsavedChanges()).toBe(false)
    await act(async()=>{await f.store.open(original.id)})
    expect(f.store.getSnapshot().workflow!.title).toBe('原名称')
  })
})
