import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowStore } from '../src/client/store.ts'
import { setSavePreferences, getSavePreferences } from '../src/client/save-preferences.ts'
import { makeWorkflow, type Workflow, type WorkflowAPI } from '../src/shared/types.ts'
import { WorkflowReadinessNotice } from '../src/client/workflow-readiness.tsx'
import { EditorHeading } from '../src/client/editor-heading.tsx'
vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:({icon,children,...p}:any)=><button {...p}>{icon}{children}</button>,Tooltip:({children}:any)=><>{children}</>}))
const stores:WorkflowStore[]=[]
function fixture(){
  const flow={...makeWorkflow('workspace','保存测试',true),revision:1}
  const api={get:vi.fn(async()=>flow),save:vi.fn(async(raw:string,revision:number)=>({...JSON.parse(raw),revision:revision+1})),inspectReadiness:vi.fn(async(w:Workflow)=>({workflowId:w.id,revision:w.revision,canRun:true,issues:[]})),start:vi.fn(async()=>({id:'run',workflowId:flow.id,status:'success',executions:[]})),importPackage:vi.fn(async()=>({...flow,id:'copy',revision:1}))} as unknown as WorkflowAPI
  const store=new WorkflowStore(api);stores.push(store);store.update({workflow:flow,page:'canvas',loading:false,library:{workflows:[flow],presets:[],workspaces:[],runs:[]}})
  return {store,api,flow}
}
afterEach(()=>{stores.splice(0).forEach(store=>store.dispose());setSavePreferences({mode:'auto',intervalMinutes:5});vi.useRealTimers()})
describe('explicit and timed canvas saving',()=>{
  it('uses five minutes by default and manual edits do not save or repeatedly inspect',async()=>{
    expect(getSavePreferences()).toEqual({mode:'auto',intervalMinutes:5});vi.useFakeTimers();setSavePreferences({mode:'manual',intervalMinutes:5})
    const {store,api,flow}=fixture();await vi.advanceTimersByTimeAsync(1);vi.mocked(api.inspectReadiness!).mockClear()
    store.edit({...flow,title:'未保存修改'});await vi.advanceTimersByTimeAsync(600_000)
    expect(api.save).not.toHaveBeenCalled();expect(api.inspectReadiness).not.toHaveBeenCalled();expect(store.getSnapshot().saveState).toBe('dirty')
    await store.save();expect(api.save).toHaveBeenCalledOnce();expect(api.inspectReadiness).toHaveBeenCalledOnce();expect(store.getSnapshot().saveState).toBe('saved')
  })
  it('automatically saves on interval and takes later edits without restarting the deadline',async()=>{
    vi.useFakeTimers();const {store,api,flow}=fixture();await vi.advanceTimersByTimeAsync(1)
    store.edit({...flow,title:'第一次'});await vi.advanceTimersByTimeAsync(240_000);store.edit({...store.getSnapshot().workflow!,title:'第二次'})
    expect(api.save).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(60_000)
    expect(api.save).toHaveBeenCalledOnce();expect(JSON.parse(vi.mocked(api.save).mock.calls[0]![0]).title).toBe('第二次')
    await vi.advanceTimersByTimeAsync(300_000);expect(api.save).toHaveBeenCalledOnce()
  })
  it('keeps spinner through inspection, saves invalid configuration and only then shows issues',async()=>{
    const {store,api,flow}=fixture();let release!:(x:any)=>void
    api.inspectReadiness=vi.fn(w=>new Promise(resolve=>{release=issues=>resolve({workflowId:w.id,revision:w.revision,canRun:!issues.length,issues})}))
    let ui!:ReturnType<typeof create>;act(()=>{ui=create(<WorkflowReadinessNotice store={store} onLocate={()=>{}}/>);store.edit({...flow,title:'保存缺失配置'})})
    let saving!:Promise<unknown>;await act(async()=>{saving=store.save();await Promise.resolve()})
    expect(store.getSnapshot().saveState).toBe('saving');expect(ui.toJSON()).toBeNull()
    await act(async()=>{release([{id:'missing',kind:'model',action:'node',message:'请配置模型'}]);await saving})
    expect(store.getSnapshot().saveState).toBe('saved');expect(JSON.stringify(ui.toJSON())).toContain('请配置模型');act(()=>ui.unmount())
  })
  it('forces the latest definition and viewport to persist before starting a run',async()=>{
    setSavePreferences({mode:'manual',intervalMinutes:5});const {store,api,flow}=fixture()
    store.edit({...flow,title:'运行前保存'});store.update({viewport:{x:99,y:42,scale:.8}});await store.execute()
    const saved=JSON.parse(vi.mocked(api.save).mock.calls[0]![0]);expect(saved.editor.viewport).toEqual({x:99,y:42,scale:.8})
    expect(vi.mocked(api.save).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.start).mock.invocationCallOrder[0]!)
  })
  it('save as preserves the unsaved source while creating a separate canvas',async()=>{
    const {store,api,flow}=fixture();store.edit({...flow,title:'副本内容'});await store.saveAs('{}')
    expect(api.save).not.toHaveBeenCalled();expect(api.importPackage).toHaveBeenCalledWith('{}','workspace',{},undefined)
    expect(store.getSnapshot().workflow?.id).toBe('copy');expect(store.getSnapshot().library.workflows.find(w=>w.id===flow.id)?.title).toBe('保存测试')
  })
  it('puts save and save-as buttons after the title and animates the actual save operation',()=>{
    let ui!:ReturnType<typeof create>;act(()=>{ui=create(<EditorHeading title="流程" revision={1} saveState="saving" onBack={()=>{}} onSave={()=>{}} onSaveAs={()=>{}}/>)})
    const button=ui.root.findByProps({'aria-label':'保存工作流'});expect(button.props['aria-busy']).toBe(true);expect(ui.root.findAllByProps({className:'vdw-save-spinner'})).toHaveLength(2);expect(ui.root.findByProps({className:'vdw-save-feedback'}).children.at(-1)).toBe('正在保存')
    expect(ui.root.findAllByType('button').filter(button=>button.props['aria-label']==='工作流另存为')).toHaveLength(1);act(()=>ui.unmount())
  })
})
