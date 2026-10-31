import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowStore } from '../src/client/store.ts'
import { setSavePreferences } from '../src/client/save-preferences.ts'
import { makeWorkflow, type Workflow, type WorkflowAPI } from '../src/shared/types.ts'
const stores:WorkflowStore[]=[]
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
const microtasks=async()=>{for(let index=0;index<12;index++)await Promise.resolve()}
function fixture(){
  let persisted:Workflow={...makeWorkflow('workspace','Persisted workflow',true),revision:1,editor:{viewport:{x:20,y:30,scale:.8},scopePath:[]}}
  const api={get:vi.fn(async()=>structuredClone(persisted)),save:vi.fn(async(raw:string,revision:number)=>{if(revision!==persisted.revision)throw new Error('Version conflict');persisted={...JSON.parse(raw),revision:revision+1};return structuredClone(persisted)}),inspectReadiness:vi.fn(async(flow:Workflow)=>({workflowId:flow.id,revision:flow.revision,canRun:true,issues:[]})),models:vi.fn(async()=>[])} as unknown as WorkflowAPI
  const store=new WorkflowStore(api);stores.push(store);store.update({workflow:structuredClone(persisted),page:'canvas',sessionId:'session',loading:false,viewport:persisted.editor!.viewport!,scopePath:[],library:{workflows:[structuredClone(persisted)],presets:[],workspaces:[],runs:[]}})
  const edit=(title:string)=>store.edit({...store.getSnapshot().workflow!,title})
  return {api,store,edit,get persisted(){return persisted},set persisted(value:Workflow){persisted=value}}
}
afterEach(()=>{stores.splice(0).forEach(store=>store.dispose());setSavePreferences({mode:'auto',intervalMinutes:5});vi.useRealTimers()})

describe('explicit unsaved return confirmation state',()=>{
  it('distinguishes graph/content edits from pan, zoom and scope navigation',()=>{
    const f=fixture();expect(f.store.hasUnsavedChanges()).toBe(false)
    f.store.update({viewport:{x:700,y:800,scale:.4},scopePath:['current-scope']})
    expect(f.store.getSnapshot().saveState).toBe('saved');expect(f.store.hasUnsavedChanges()).toBe(false)
    f.edit('Unsaved title');expect(f.store.hasUnsavedChanges()).toBe(true);expect(f.store.getSnapshot().saveState).toBe('dirty')
    f.store.undo();expect(f.store.hasUnsavedChanges()).toBe(false)
    f.store.edit({...f.store.getSnapshot().workflow!,nodes:f.store.getSnapshot().workflow!.nodes.map((node,index)=>index?node:{...node,x:node.x+100})});expect(f.store.hasUnsavedChanges()).toBe(true)
  })
  it('counts ordinary settings and portable annotations as definition content',()=>{
    const f=fixture(),original=f.store.getSnapshot().workflow!
    f.store.edit({...original,environmentVariables:[{id:'value',name:'NAME',type:'string',value:'Unsaved'}]});expect(f.store.hasUnsavedChanges()).toBe(true)
    f.store.undo();expect(f.store.hasUnsavedChanges()).toBe(false)
    f.store.edit({...f.store.getSnapshot().workflow!,editor:{...original.editor,annotations:[{id:'annotation',number:1,nodeIds:[original.nodes[0]!.id],text:'Unsaved annotation'}]}});expect(f.store.hasUnsavedChanges()).toBe(true)
  })
  it('drops unsaved content, clears undo history and remains clean after unmount and future autosave deadlines',async()=>{
    vi.useFakeTimers();setSavePreferences({mode:'auto',intervalMinutes:1});const f=fixture();await vi.advanceTimersByTimeAsync(0)
    const unmount=f.store.registerViewport(()=>({x:999,y:888,scale:.2}),f.persisted.id)
    f.edit('Do not persist');f.store.update({viewport:{x:999,y:888,scale:.2}})
    await f.store.discardAndLeave();unmount()
    expect(f.api.save).not.toHaveBeenCalled();expect(f.store.getSnapshot()).toMatchObject({page:'library',workflow:f.persisted,viewport:f.persisted.editor!.viewport,saveState:'saved',undo:[],redo:[]})
    expect(f.store.hasUnsavedChanges()).toBe(false)
    await vi.advanceTimersByTimeAsync(180_000);expect(f.api.save).not.toHaveBeenCalled()
    await f.store.open(f.persisted.id);expect(f.store.getSnapshot().workflow).toEqual(f.persisted);expect(f.store.hasUnsavedChanges()).toBe(false)
  })
  it('waits for the existing save and restores its acknowledged revision without issuing a new write',async()=>{
    const f=fixture(),write=deferred<Workflow>();f.edit('Save already in progress')
    vi.mocked(f.api.save).mockReturnValueOnce(write.promise)
    const saving=f.store.flush(),leaving=f.store.discardAndLeave();await microtasks()
    expect(f.api.get).not.toHaveBeenCalled();expect(f.store.getSnapshot().page).toBe('canvas')
    f.persisted={...JSON.parse(vi.mocked(f.api.save).mock.calls[0]![0]),revision:2};write.resolve(structuredClone(f.persisted))
    await Promise.all([saving,leaving])
    expect(f.api.save).toHaveBeenCalledOnce();expect(f.store.getSnapshot()).toMatchObject({page:'library',workflow:{title:'Save already in progress',revision:2},saveState:'saved'})
    expect(f.store.hasUnsavedChanges()).toBe(false)
  })
  it('drains recursive saves that were already authorized before reading the persisted definition',async()=>{
    const f=fixture(),first=deferred<Workflow>(),second=deferred<Workflow>();f.edit('First submitted edit')
    vi.mocked(f.api.save).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const saving=f.store.flush();f.edit('Later edit already queued by save');const leaving=f.store.discardAndLeave()
    f.persisted={...JSON.parse(vi.mocked(f.api.save).mock.calls[0]![0]),revision:2};first.resolve(structuredClone(f.persisted));await microtasks()
    expect(f.api.save).toHaveBeenCalledTimes(2);expect(f.api.get).not.toHaveBeenCalled()
    f.persisted={...JSON.parse(vi.mocked(f.api.save).mock.calls[1]![0]),revision:3};second.resolve(structuredClone(f.persisted));await Promise.all([saving,leaving])
    expect(f.store.getSnapshot()).toMatchObject({page:'library',workflow:{title:'Later edit already queued by save',revision:3},saveState:'saved'})
  })
  it('retains the current canvas when an existing save fails and never starts a discard read',async()=>{
    const f=fixture(),write=deferred<Workflow>();f.edit('Keep after write failure');vi.mocked(f.api.save).mockReturnValueOnce(write.promise)
    const saving=f.store.flush(),leaving=f.store.discardAndLeave(),savedError=expect(saving).rejects.toThrow('Write failed'),leaveError=expect(leaving).rejects.toThrow('Write failed')
    write.reject(new Error('Write failed'));await Promise.all([savedError,leaveError])
    expect(f.api.get).not.toHaveBeenCalled();expect(f.store.getSnapshot()).toMatchObject({page:'canvas',workflow:{title:'Keep after write failure'},saveState:'error'})
    expect(f.store.hasUnsavedChanges()).toBe(true)
  })
  it('keeps unsaved content after a failed persisted-definition read',async()=>{
    const f=fixture();f.edit('Keep after read failure');vi.mocked(f.api.get).mockRejectedValueOnce(new Error('Read unavailable'))
    await expect(f.store.discardAndLeave()).rejects.toThrow('Read unavailable')
    expect(f.store.getSnapshot()).toMatchObject({page:'canvas',workflow:{title:'Keep after read failure'},saveState:'dirty'});expect(f.api.save).not.toHaveBeenCalled();expect(f.store.hasUnsavedChanges()).toBe(true)
  })
  it('preserves edits made after discard was clicked and rejects stale discard intent',async()=>{
    const f=fixture(),read=deferred<Workflow>();f.edit('Initial unsaved edit');vi.mocked(f.api.get).mockReturnValueOnce(read.promise)
    const leaving=f.store.discardAndLeave(),rejected=expect(leaving).rejects.toThrow('新修改');await microtasks();f.edit('New edit made while reading')
    read.resolve(structuredClone(f.persisted));await rejected
    expect(f.store.getSnapshot()).toMatchObject({page:'canvas',workflow:{title:'New edit made while reading'},saveState:'dirty'});expect(f.store.hasUnsavedChanges()).toBe(true);expect(f.api.save).not.toHaveBeenCalled()
  })
  it('blocks new saves/navigation and skips autosave while discard is reading, then leaves without reviving the abandoned graph',async()=>{
    vi.useFakeTimers();setSavePreferences({mode:'auto',intervalMinutes:1});const f=fixture(),read=deferred<Workflow>();await vi.advanceTimersByTimeAsync(0)
    f.edit('Abandoned graph');vi.mocked(f.api.get).mockReturnValueOnce(read.promise)
    const leaving=f.store.discardAndLeave();await microtasks()
    await expect(f.store.flush()).rejects.toThrow('正在放弃');await expect(f.store.save()).rejects.toThrow('正在放弃');await expect(f.store.saveAs('{}')).rejects.toThrow('正在放弃');await expect(f.store.open('another')).rejects.toThrow('正在放弃')
    await vi.advanceTimersByTimeAsync(60_000);expect(f.api.save).not.toHaveBeenCalled()
    read.resolve(structuredClone(f.persisted));await leaving;await vi.advanceTimersByTimeAsync(60_000)
    expect(f.api.save).not.toHaveBeenCalled();expect(f.store.getSnapshot()).toMatchObject({page:'library',workflow:{title:'Persisted workflow'},saveState:'saved'})
  })
  it('does not discard or leave a different workflow created by an already pending Save As',async()=>{
    const f=fixture(),imported=deferred<Workflow>(),copy={...structuredClone(f.persisted),id:'created-copy',title:'Created copy',revision:1}
    f.edit('Source copy content');f.api.importPackage=vi.fn(()=>imported.promise)
    const copying=f.store.saveAs('{}'),leaving=f.store.discardAndLeave(),rejected=expect(leaving).rejects.toThrow('已切换')
    imported.resolve(copy);await copying;await rejected
    expect(f.store.getSnapshot()).toMatchObject({page:'canvas',workflow:{id:copy.id,title:copy.title},saveState:'saved'})
    expect(f.api.get).not.toHaveBeenCalled();expect(f.api.save).not.toHaveBeenCalled()
  })
  it('reloads the actual latest persisted revision and rejects a mismatched identity without losing edits',async()=>{
    const f=fixture();f.edit('Abandon local version')
    f.persisted={...f.persisted,title:'Newer persisted version',revision:4};await f.store.discardAndLeave()
    expect(f.store.getSnapshot().workflow).toMatchObject({title:'Newer persisted version',revision:4});expect(f.store.hasUnsavedChanges()).toBe(false)
    await f.store.open(f.persisted.id);f.edit('Must keep on wrong response')
    vi.mocked(f.api.get).mockResolvedValueOnce({...f.persisted,id:'wrong-workflow'})
    await expect(f.store.discardAndLeave()).rejects.toThrow('身份不一致')
    expect(f.store.getSnapshot()).toMatchObject({page:'canvas',workflow:{id:f.persisted.id,title:'Must keep on wrong response'},saveState:'dirty'})
  })
  it('saves the newest graph normally and leaves no definition warning after a successful save',async()=>{
    const f=fixture();f.edit('Save and return content');await f.store.save()
    expect(f.persisted.title).toBe('Save and return content');expect(f.store.hasUnsavedChanges()).toBe(false)
    expect(f.store.getSnapshot().saveState).toBe('saved')
  })
  it('keeps the original automatic flush protection when switching to another workflow normally',async()=>{
    const f=fixture(),other={...makeWorkflow('workspace','Other',true),revision:1};f.edit('Preserve ordinary navigation')
    vi.mocked(f.api.get).mockResolvedValueOnce(other);await f.store.open(other.id)
    expect(f.api.save).toHaveBeenCalledOnce();expect(f.persisted.title).toBe('Preserve ordinary navigation');expect(f.store.getSnapshot().workflow?.id).toBe(other.id)
  })
})

describe('navigation with a workspace removed from the Host',()=>{
  const missing=()=>new Error('工作区不存在，请在宿主中选择有效工作区')
  it('a failed save of pan, zoom or scope alone never blocks leaving or opening another workflow',async()=>{
    const f=fixture(),other={...makeWorkflow('workspace','Other workflow',true),revision:1}
    f.store.update({viewport:{x:700,y:800,scale:.4},scopePath:['scope']});vi.mocked(f.api.save).mockRejectedValue(missing())
    await f.store.flushForNavigation()
    expect(f.store.getSnapshot()).toMatchObject({saveState:'saved',error:''});expect(f.store.hasUnsavedChanges()).toBe(false)
    // Later navigation no longer retries the abandoned view state.
    vi.mocked(f.api.get).mockResolvedValueOnce(structuredClone(other))
    await f.store.open(other.id);expect(f.store.getSnapshot().workflow?.id).toBe(other.id);expect(f.api.save).toHaveBeenCalledOnce()
  })
  it('definition changes stay dirty and still block navigation when the save fails',async()=>{
    const f=fixture();f.edit('Unsaved title');vi.mocked(f.api.save).mockRejectedValue(missing())
    await expect(f.store.flushForNavigation()).rejects.toThrow('工作区不存在')
    expect(f.store.hasUnsavedChanges()).toBe(true);expect(f.store.getSnapshot()).toMatchObject({saveState:'error',workflow:{title:'Unsaved title'}})
    await expect(f.store.open('another')).rejects.toThrow('工作区不存在');expect(f.store.getSnapshot().workflow?.title).toBe('Unsaved title')
  })
  it('a failed first library load retries in the background and withdraws its own error',async()=>{
    vi.useFakeTimers();const f=fixture()
    const library={workflows:[],presets:[],workspaces:[],runs:[]}
    ;(f.api as any).list=vi.fn().mockRejectedValueOnce(new Error('宿主暂不可用')).mockResolvedValue(library)
    await f.store.load();expect(f.store.getSnapshot().error).toContain('宿主暂不可用')
    await vi.advanceTimersByTimeAsync(3000)
    expect((f.api as any).list).toHaveBeenCalledTimes(2);expect(f.store.getSnapshot().error).toBe('')
    // Recovery completes the first load, including the model catalog.
    expect(f.api.models).toHaveBeenCalledOnce()
  })
})
