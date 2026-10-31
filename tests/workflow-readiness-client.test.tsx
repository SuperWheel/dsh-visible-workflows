import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowStore } from '../src/client/store.ts'
import { NodeReadinessWarning, WorkflowReadinessNotice, issuesForNode, nodeScopePath } from '../src/client/workflow-readiness.tsx'
import { RunToolbar } from '../src/client/run-governance.tsx'
import { newNode } from '../src/client/nodes.ts'
import { makeWorkflow, type Workflow, type WorkflowAPI } from '../src/shared/types.ts'
import type { WorkflowReadiness, WorkflowReadinessIssue } from '../src/shared/workflow-import.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:({icon,children,...props}:any)=><button {...props}>{icon}{children}</button>,Input:'input',Tooltip:({children}:any)=><>{children}</>,Menu:()=>null,Modal:({children,footer,...props}:any)=><modal-mock {...props}>{children}{footer}</modal-mock>}))
const stores:WorkflowStore[]=[],renderers:ReactTestRenderer[]=[]
afterEach(()=>{for(const ui of renderers.splice(0))act(()=>ui.unmount());for(const store of stores.splice(0))store.dispose();vi.useRealTimers()})
const ready=(workflow:Workflow,issues:WorkflowReadinessIssue[]=[]):WorkflowReadiness=>({workflowId:workflow.id,revision:workflow.revision,canRun:!issues.length,issues})
const missing=(nodeId:string):WorkflowReadinessIssue=>({id:'missing-tool',nodeId,kind:'tool',action:'node',message:'搜索工具未连接，请选择可用工具'})
function fixture(){
  const flow={...makeWorkflow('workspace','待配置流程',true),revision:1}
  const api={inspectReadiness:vi.fn(async(workflow:Workflow)=>ready(workflow)),save:vi.fn(async(raw:string,revision:number)=>({...JSON.parse(raw),revision:revision+1})),get:vi.fn(async()=>flow),start:vi.fn(async()=>({id:'run',workflowId:flow.id,status:'success',executions:[]}))} as unknown as WorkflowAPI
  const store=new WorkflowStore(api);stores.push(store);store.update({workflow:flow,page:'canvas',loading:false,sessionId:'session',library:{workflows:[flow],presets:[],runs:[],workspaces:[]}})
  return {flow,api,store}
}
function render(element:React.ReactElement){let ui!:ReactTestRenderer;act(()=>{ui=create(element)});renderers.push(ui);return ui}

describe('incomplete workflows stay on the canvas and cannot execute',()=>{
  it('saves incomplete definitions and rejects execution before creating a run',async()=>{
    const {store,flow,api}=fixture(),issue=missing(flow.nodes[1]!.id)
    vi.mocked(api.inspectReadiness!).mockImplementation(async workflow=>ready(workflow,[issue]))
    store.edit({...flow,title:'仍可保存的待配置流程'});await store.flush()
    expect(store.getSnapshot().saveState).toBe('saved');expect(api.save).toHaveBeenCalledOnce()
    await expect(store.execute()).rejects.toThrow('1 项待处理配置')
    expect(api.start).not.toHaveBeenCalled();expect(store.getSnapshot().page).toBe('canvas');expect(store.getSnapshot().readiness?.issues).toEqual([issue])
  })
  it('does not let an older successful inspection admit a newly edited workflow',async()=>{
    const {store,flow,api}=fixture();let release!:(value:WorkflowReadiness)=>void
    vi.mocked(api.inspectReadiness!).mockImplementationOnce(()=>new Promise(resolve=>release=resolve))
    const old=store.refreshReadiness();store.edit({...flow,title:'新的配置'})
    release(ready(flow));await expect(old).rejects.toThrow('已变化')
    expect(store.getSnapshot().readinessState).toBeUndefined();expect(store.getSnapshot().readiness?.canRun).not.toBe(true)
    vi.mocked(api.inspectReadiness!).mockImplementation(async workflow=>ready(workflow,[missing(flow.nodes[1]!.id)]))
    await store.refreshReadiness();expect(store.getSnapshot().readiness?.canRun).toBe(false)
  })
  it('rechecks dependencies on every execute even after a green report',async()=>{
    const {store,flow,api}=fixture();await store.refreshReadiness();expect(store.getSnapshot().readiness?.canRun).toBe(true)
    vi.mocked(api.inspectReadiness!).mockImplementation(async workflow=>ready(workflow,[missing(flow.nodes[1]!.id)]))
    await expect(store.execute()).rejects.toThrow('待处理配置');expect(api.start).not.toHaveBeenCalled()
  })
  it('fails closed when the current host cannot check or returns another revision',async()=>{
    const {store,api}=fixture();delete api.inspectReadiness
    await expect(store.execute()).rejects.toThrow('当前宿主尚不支持配置检查');expect(api.start).not.toHaveBeenCalled()
    api.inspectReadiness=vi.fn(async workflow=>({...ready(workflow),revision:workflow.revision+1}))
    await expect(store.execute()).rejects.toThrow('版本不一致');expect(api.start).not.toHaveBeenCalled()
  })
  it('rejects session changes that occur during the launch check',async()=>{
    const {store,flow,api}=fixture();let release!:(report:WorkflowReadiness)=>void,entered!:()=>void
    const checking=new Promise<void>(resolve=>entered=resolve)
    api.inspectReadiness=vi.fn(()=>{entered();return new Promise(resolve=>release=resolve)})
    const start=store.execute();await checking;store.update({sessionId:'other-session'});release(ready(flow))
    await expect(start).rejects.toThrow('已变化');expect(api.start).not.toHaveBeenCalled()
  })
  it('reloads an overwrite of the currently open workflow rather than retaining its old canvas',async()=>{
    const {store,flow,api}=fixture(),replacement={...flow,title:'导入替换后的流程',revision:2}
    vi.mocked(api.get).mockResolvedValue(replacement);await store.open(flow.id,true)
    expect(api.get).toHaveBeenCalledWith(flow.id);expect(store.getSnapshot().workflow).toEqual(replacement)
  })
})

describe('missing value prompts',()=>{
  it('places a red-triangle control after node titles and includes nested missing nodes',()=>{
    const container=newNode('iteration'),child=container.config.body!.nodes[1]!,issue=missing(child.id),configure=vi.fn()
    const ui=render(<NodeReadinessWarning node={container} issues={[issue]} onConfigure={configure}/>),button=ui.root.findByType('button')
    expect(button.props['aria-label']).toContain('1 项待处理配置');expect(ui.root.findByProps({className:'vdw-missing-triangle'}).props.viewBox).toBe('0 0 16 16')
    act(()=>button.props.onClick({stopPropagation:()=>{}}));expect(configure).toHaveBeenCalledOnce()
    expect(issuesForNode(container,[issue])).toEqual([issue]);expect(nodeScopePath({...makeWorkflow('workspace'),nodes:[container]},child.id)).toEqual([container.id])
  })
  it('locates individual missing values and disappears only after a fresh successful check',async()=>{
    const {store,flow,api}=fixture(),issue=missing(flow.nodes[1]!.id),locate=vi.fn()
    api.inspectReadiness=vi.fn(async workflow=>ready(workflow,[issue]));await store.refreshReadiness()
    const ui=render(<WorkflowReadinessNotice store={store} onLocate={locate}/>)
    expect(JSON.stringify(ui.toJSON())).not.toContain('可以继续编辑和保存');expect(JSON.stringify(ui.toJSON())).toContain(issue.message)
    act(()=>ui.root.findAllByType('button').find(button=>button.findAllByType('small').length)!.props.onClick());expect(locate).toHaveBeenCalledWith(issue)
    act(()=>store.edit({...flow,title:'已填写新工具'}));expect(JSON.stringify(ui.toJSON())).toContain(issue.message)
    api.inspectReadiness=vi.fn(async workflow=>ready(workflow));await act(async()=>{await store.refreshReadiness()})
    expect(ui.toJSON()).toBeNull()
  })
  it('keeps the execute button clickable with missing values and explains the blocked run in a modal',async()=>{
    const {store,flow,api}=fixture(),execute=vi.fn()
    api.inspectReadiness=vi.fn(async workflow=>ready(workflow,[missing(flow.nodes[1]!.id)]));await store.refreshReadiness()
    const ui=render(<><RunToolbar store={store} working={false} onExecute={execute} onAction={()=>{}}/><WorkflowReadinessNotice store={store} onLocate={()=>{}}/></>),button=()=>ui.root.findByProps({'aria-label':'执行'})
    expect(button().props.disabled).toBe(false)
    await act(async()=>button().props.onClick())
    expect(execute).not.toHaveBeenCalled();expect(api.start).not.toHaveBeenCalled();expect(ui.root.findByType('modal-mock' as never).props.title).toBe('请先处理缺失配置')
    expect(JSON.stringify(ui.toJSON())).toContain('请先按照画布右侧待处理清单的指示补齐缺失值')
    act(()=>ui.root.findAllByType('button').find(item=>item.children.includes('去处理'))!.props.onClick())
    expect(ui.root.findAllByType('modal-mock' as never)).toHaveLength(0);expect(store.getSnapshot().readinessFocus).toBe(1);expect(button().props.disabled).toBe(false)
  })
  it('checks again when clicked during a pending background check and ignores the older successful response',async()=>{
    const {store,flow,api}=fixture(),execute=vi.fn();let oldRelease!:(report:WorkflowReadiness)=>void,newRelease!:(report:WorkflowReadiness)=>void
    api.inspectReadiness=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>oldRelease=resolve)).mockImplementationOnce(()=>new Promise(resolve=>newRelease=resolve))
    const background=store.refreshReadiness().catch(()=>{}),ui=render(<RunToolbar store={store} working={false} onExecute={execute} onAction={()=>{}}/>),button=()=>ui.root.findByProps({'aria-label':'执行'})
    expect(button().props.disabled).toBe(false)
    await act(async()=>{button().props.onClick();button().props.onClick();await Promise.resolve()})
    expect(api.inspectReadiness).toHaveBeenCalledTimes(2);expect(button().props.disabled).toBe(true)
    await act(async()=>{newRelease(ready(flow,[missing(flow.nodes[1]!.id)]));await Promise.resolve()})
    await act(async()=>{oldRelease(ready(flow));await background})
    expect(execute).not.toHaveBeenCalled();expect(ui.root.findAllByType('modal-mock' as never)).toHaveLength(1);expect(button().props.disabled).toBe(false)
  })
  it('shows inspection failures in the modal and allows another click after configuration succeeds',async()=>{
    const {store,api}=fixture();await store.refreshReadiness();vi.mocked(api.inspectReadiness!).mockClear();const execute=vi.fn(),ui=render(<RunToolbar store={store} working={false} onExecute={execute} onAction={()=>{}}/>),button=()=>ui.root.findByProps({'aria-label':'执行'})
    api.inspectReadiness=vi.fn(async()=>{throw new Error('配置服务不可用')})
    await act(async()=>button().props.onClick())
    expect(button().props.disabled).toBe(false);expect(JSON.stringify(ui.toJSON())).toContain('配置服务不可用');expect(execute).not.toHaveBeenCalled()
    act(()=>ui.root.findAllByType('button').find(item=>item.children.includes('关闭'))!.props.onClick())
    api.inspectReadiness=vi.fn(async workflow=>ready(workflow))
    await act(async()=>button().props.onClick())
    expect(execute).toHaveBeenCalledOnce();expect(ui.root.findAllByType('modal-mock' as never)).toHaveLength(0)
  })
  it('does not start a different workflow when the canvas changes during a click check',async()=>{
    const {store,flow,api}=fixture(),execute=vi.fn();let release!:(report:WorkflowReadiness)=>void
    api.inspectReadiness=vi.fn(()=>new Promise(resolve=>release=resolve))
    const ui=render(<RunToolbar store={store} working={false} onExecute={execute} onAction={()=>{}}/>)
    await act(async()=>{ui.root.findByProps({'aria-label':'执行'}).props.onClick();await Promise.resolve()})
    act(()=>store.update({workflow:{...flow,id:'other-flow'}}));await act(async()=>{release(ready(flow));await Promise.resolve()})
    expect(execute).not.toHaveBeenCalled();expect(JSON.stringify(ui.toJSON())).toContain('已变化');expect(ui.root.findAllByType('modal-mock' as never)).toHaveLength(1)
  })
  it('retains busy guards but lets a failed save be retried by clicking execute',async()=>{
    const {store,api}=fixture();await store.refreshReadiness();vi.mocked(api.inspectReadiness!).mockClear();const execute=vi.fn(),ui=render(<RunToolbar store={store} working onExecute={execute} onAction={()=>{}}/>),button=()=>ui.root.findByProps({'aria-label':'执行'})
    expect(button().props.disabled).toBe(true);await act(async()=>button().props.onClick());expect(api.inspectReadiness).not.toHaveBeenCalled()
    act(()=>{store.update({saveState:'error'});ui.update(<RunToolbar store={store} working={false} onExecute={execute} onAction={()=>{}}/>)})
    expect(button().props.disabled).toBe(false);await act(async()=>button().props.onClick());expect(execute).toHaveBeenCalledOnce()
  })
})
