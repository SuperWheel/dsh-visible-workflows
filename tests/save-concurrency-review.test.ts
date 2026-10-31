import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowStore } from '../src/client/store.ts'
import { setSavePreferences } from '../src/client/save-preferences.ts'
import { makeWorkflow, type Workflow, type WorkflowAPI, type WorkflowRun } from '../src/shared/types.ts'

const stores:WorkflowStore[]=[]
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
const flushMicrotasks=async()=>{for(let i=0;i<10;i++)await Promise.resolve()}
function fixture(){
  const flow={...makeWorkflow('workspace','原流程',true),revision:1},copy={...structuredClone(flow),id:'copied-flow',title:'副本'}
  const run:WorkflowRun={id:'source-run',workflowId:flow.id,workspaceId:flow.workspaceId,workflowTitle:flow.title,sourceRevision:1,graph:flow,status:'success',inputs:{},outputs:{},executions:[],startedAt:new Date().toISOString()}
  const api={save:vi.fn(async(raw:string,revision:number)=>({...JSON.parse(raw),revision:revision+1})),inspectReadiness:vi.fn(async(graph:Workflow)=>({workflowId:graph.id,revision:graph.revision,canRun:true,issues:[]})),importPackage:vi.fn(async()=>copy),start:vi.fn(async()=>run)} as unknown as WorkflowAPI
  const store=new WorkflowStore(api);stores.push(store)
  store.update({workflow:flow,sessionId:'main',page:'canvas',loading:false,library:{workflows:[flow],presets:[],runs:[],workspaces:[]}})
  return{flow,copy,run,api,store}
}
afterEach(()=>{for(const store of stores.splice(0))store.dispose();setSavePreferences({mode:'auto',intervalMinutes:5});vi.useRealTimers()})

describe('save lifecycle concurrency and failures',()=>{
  it('does not autosave unsaved source edits while Save As is importing a copy',async()=>{
    vi.useFakeTimers();setSavePreferences({mode:'auto',intervalMinutes:1})
    const {flow,copy,api,store}=fixture();await vi.advanceTimersByTimeAsync(0)
    store.edit({...flow,title:'仅应存入副本的修改'})
    const imported=deferred<Workflow>();vi.mocked(api.importPackage!).mockReturnValueOnce(imported.promise)
    const copying=store.saveAs('{}');await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(60_000)
    const writes=vi.mocked(api.save).mock.calls.length
    imported.resolve(copy);await copying
    expect(writes).toBe(0);expect(api.save).not.toHaveBeenCalled()
    expect(store.getSnapshot().library.workflows.find(item=>item.id===flow.id)?.title).toBe('原流程')
  })
  it('blocks manual save and run while Save As is pending without writing or starting the source',async()=>{
    setSavePreferences({mode:'manual',intervalMinutes:5})
    const {flow,copy,api,store}=fixture();store.edit({...flow,title:'副本内容'})
    const imported=deferred<Workflow>();vi.mocked(api.importPackage!).mockReturnValueOnce(imported.promise)
    const copying=store.saveAs('{}');await flushMicrotasks()
    await expect(store.save()).rejects.toThrow('另存为')
    await expect(store.execute({}, {workflowId:flow.id,sessionId:'main'})).rejects.toThrow('另存为')
    expect(api.save).not.toHaveBeenCalled();expect(api.start).not.toHaveBeenCalled()
    imported.resolve(copy);await copying
  })
  it('retains edits made during import and reports the created copy instead of replacing the current canvas',async()=>{
    setSavePreferences({mode:'manual',intervalMinutes:5})
    const {flow,copy,api,store}=fixture();store.edit({...flow,title:'复制时内容'})
    const imported=deferred<Workflow>();vi.mocked(api.importPackage!).mockReturnValueOnce(imported.promise)
    const copying=store.saveAs('{}');const rejected=expect(copying).rejects.toThrow('副本已创建')
    store.edit({...store.getSnapshot().workflow!,title:'复制等待期间的新修改'})
    imported.resolve(copy);await rejected
    expect(store.getSnapshot().workflow?.id).toBe(flow.id)
    expect(store.getSnapshot().workflow?.title).toBe('复制等待期间的新修改')
    expect(store.getSnapshot().saveState).toBe('dirty')
    expect(store.getSnapshot().library.workflows.some(item=>item.id===copy.id)).toBe(true)
    expect(api.save).not.toHaveBeenCalled()
  })
  it('records successful persistence even when the following configuration check is unavailable',async()=>{
    setSavePreferences({mode:'manual',intervalMinutes:5})
    const {flow,api,store}=fixture();store.edit({...flow,title:'已落盘但检查失败'})
    vi.mocked(api.inspectReadiness!).mockRejectedValue(new Error('配置服务暂不可用'))
    await expect(store.save()).rejects.toThrow('配置服务暂不可用')
    expect(api.save).toHaveBeenCalledOnce();expect(store.getSnapshot().saveState).toBe('saved')
    expect(store.getSnapshot().workflow?.revision).toBe(2);expect(store.getSnapshot().savedAt).toBeGreaterThan(0)
    expect(store.getSnapshot().readinessState).toBe('error')
    expect(store.getSnapshot().readinessError).toBe('配置服务暂不可用')
    expect(api.start).not.toHaveBeenCalled()
  })
  it('serializes concurrent save requests and persists edits arriving during the first write before checking',async()=>{
    setSavePreferences({mode:'manual',intervalMinutes:5})
    const {flow,api,store}=fixture();store.edit({...flow,title:'第一版'})
    const saved=deferred<Workflow>();vi.mocked(api.save).mockReturnValueOnce(saved.promise)
    const first=store.save(),second=store.save();await flushMicrotasks()
    const snapshot=JSON.parse(vi.mocked(api.save).mock.calls[0]![0])
    store.edit({...store.getSnapshot().workflow!,title:'保存中继续修改'})
    saved.resolve({...snapshot,revision:2});await Promise.all([first,second])
    expect(vi.mocked(api.save).mock.calls.map(call=>call[1])).toEqual([1,2])
    expect(store.getSnapshot().workflow?.title).toBe('保存中继续修改');expect(store.getSnapshot().workflow?.revision).toBe(3)
    const checked=vi.mocked(api.inspectReadiness!).mock.calls.at(-1)![0]
    expect(checked.title).toBe('保存中继续修改');expect(checked.revision).toBe(3)
  })
  it('does not run if the conversation changes while the forced save is waiting',async()=>{
    setSavePreferences({mode:'manual',intervalMinutes:5})
    const {flow,api,store}=fixture();store.edit({...flow,title:'运行前修改'})
    const saved=deferred<Workflow>();vi.mocked(api.save).mockReturnValueOnce(saved.promise)
    const executing=store.execute({}, {workflowId:flow.id,sessionId:'main'}),rejected=expect(executing).rejects.toThrow('对话已变化')
    await flushMicrotasks();const snapshot=JSON.parse(vi.mocked(api.save).mock.calls[0]![0])
    store.update({sessionId:'different-conversation'});saved.resolve({...snapshot,revision:2});await rejected
    expect(api.start).not.toHaveBeenCalled();expect(store.getSnapshot().sessionId).toBe('different-conversation')
  })
  it('does not attach a late start response to another conversation or workflow',async()=>{
    setSavePreferences({mode:'manual',intervalMinutes:5})
    const {flow,run,api,store}=fixture(),started=deferred<WorkflowRun>()
    vi.mocked(api.start).mockReturnValueOnce(started.promise)
    const executing=store.execute({}, {workflowId:flow.id,sessionId:'main'});await flushMicrotasks()
    expect(api.start).toHaveBeenCalledOnce()
    const other={...makeWorkflow('workspace','另一流程'),revision:1}
    store.update({workflow:other,sessionId:'different-conversation',run:undefined})
    started.resolve(run);await executing
    expect(store.getSnapshot().workflow?.id).toBe(other.id)
    expect(store.getSnapshot().run?.id).not.toBe(run.id)
    expect(store.getSnapshot().library.runs.some(item=>item.id===run.id)).toBe(true)
  })
})
