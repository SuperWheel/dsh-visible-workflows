import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindPlanningUi, PlanningCanvasVisibility, type PlanningUiApi, type PlanningUiCursor } from '../src/client/planning-ui.ts'
import type { PlanningPublicationUpdates } from '../src/shared/planning-ui.ts'
import { makeWorkflow } from '../src/shared/types.ts'
import type { EditorState } from '../src/client/store.ts'

const bindings:Array<()=>void>=[]
beforeEach(()=>vi.useFakeTimers())
afterEach(()=>{bindings.splice(0).forEach(dispose=>dispose());vi.useRealTimers()})
function fixture(){
  const flow={...makeWorkflow('workspace','当前画布'),revision:3}
  let state={workflow:flow,sessionId:'session',page:'canvas'} as EditorState,dirty=false,workspace='workspace'
  const listeners=new Set<()=>void>(),notify=()=>listeners.forEach(fn=>fn())
  const store={getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn)}},hasUnsavedChanges:()=>dirty,refreshProposals:vi.fn(async()=>{})}
  const api:PlanningUiApi={setPlanningContext:vi.fn(async()=>{}),planningUpdates:vi.fn(async()=>({epoch:'host-a',cursor:0,items:[]}))}
  const cursor:PlanningUiCursor={cursor:0},onCreated=vi.fn(async()=>{}),onError=vi.fn(),onProgress=vi.fn()
  const bind=(clientId='client',canvasVisibility?:PlanningCanvasVisibility)=>{const dispose=bindPlanningUi({sessionId:'session',store,api,cursor,workspaceId:()=>workspace,canvasVisibility,onCreated,onError,onProgress,clientId});bindings.push(dispose);return dispose}
  return {flow,store,api,cursor,onCreated,onError,onProgress,bind,notify,setWorkspace:(value:string)=>{workspace=value;notify()},setDirty:(value:boolean)=>{dirty=value;notify()},update:(patch:Partial<EditorState>)=>{state={...state,...patch};notify()}}
}
describe('current canvas hint and authoritative publication bridge',()=>{
  it('keeps publication notifications active without a sidebar, and clears the canvas hint immediately on hide',async()=>{
    const f=fixture(),visibility=new PlanningCanvasVisibility()
    vi.mocked(f.api.planningUpdates).mockResolvedValue({epoch:'host-a',cursor:1,items:[{sequence:1,taskId:'command',kind:'created',workflowId:'created',revision:1}]})
    f.bind('resident-dock',visibility);await vi.advanceTimersByTimeAsync(0)
    expect(f.api.setPlanningContext).toHaveBeenLastCalledWith('session',{clientId:'resident-dock',sequence:1,dirty:false})
    expect(f.onCreated).toHaveBeenCalledExactlyOnceWith('created','session')
    const hide=visibility.mount();await vi.advanceTimersByTimeAsync(0)
    expect(f.api.setPlanningContext).toHaveBeenLastCalledWith('session',expect.objectContaining({workflowId:f.flow.id,sequence:2}))
    hide();await vi.advanceTimersByTimeAsync(0)
    expect(f.api.setPlanningContext).toHaveBeenLastCalledWith('session',{clientId:'resident-dock',sequence:3,dirty:false})
    await vi.advanceTimersByTimeAsync(3_000)
    expect(f.api.planningUpdates).toHaveBeenLastCalledWith('session',1,'host-a')
  })
  it('keeps another visible tab body active when one copy unmounts',()=>{
    const visibility=new PlanningCanvasVisibility(),one=visibility.mount(),two=visibility.mount()
    expect(visibility.getSnapshot()).toBe(true);one();one()
    expect(visibility.getSnapshot()).toBe(true);two();expect(visibility.getSnapshot()).toBe(false)
  })
  it('synchronizes the exact session, stable workflow revision and unsaved status; library clears its hint',async()=>{
    const f=fixture();f.bind();await vi.advanceTimersByTimeAsync(0)
    expect(f.api.setPlanningContext).toHaveBeenLastCalledWith('session',{clientId:'client',sequence:1,workflowId:f.flow.id,revision:3,dirty:false})
    f.setDirty(true);await vi.advanceTimersByTimeAsync(0)
    expect(f.api.setPlanningContext).toHaveBeenLastCalledWith('session',expect.objectContaining({sequence:2,workflowId:f.flow.id,dirty:true}))
    f.update({page:'library'});await vi.advanceTimersByTimeAsync(0)
    expect(f.api.setPlanningContext).toHaveBeenLastCalledWith('session',{clientId:'client',sequence:3,dirty:false})
    expect(f.onCreated).not.toHaveBeenCalled()
  })
  it('does not borrow another session or a workflow outside its current workspace',async()=>{
    const f=fixture();f.update({sessionId:'another'});f.bind();await vi.advanceTimersByTimeAsync(0)
    expect(f.api.setPlanningContext).toHaveBeenLastCalledWith('session',expect.not.objectContaining({workflowId:f.flow.id}))
    f.update({sessionId:'session'});f.setWorkspace('other');await vi.advanceTimersByTimeAsync(0)
    expect(f.api.setPlanningContext).toHaveBeenLastCalledWith('session',expect.not.objectContaining({workflowId:f.flow.id}))
    f.update({workflow:{...f.flow,scope:'global'}});await vi.advanceTimersByTimeAsync(0)
    expect(f.api.setPlanningContext).toHaveBeenLastCalledWith('session',expect.objectContaining({workflowId:f.flow.id,dirty:false}))
  })
  it('serializes asynchronous context updates, coalesces superseded values and clears only its client',async()=>{
    const f=fixture();let release!:()=>void
    vi.mocked(f.api.setPlanningContext).mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve}))
    const dispose=f.bind();f.setDirty(true);f.update({page:'library'})
    expect(f.api.setPlanningContext).toHaveBeenCalledTimes(1)
    release();await vi.advanceTimersByTimeAsync(0)
    expect(f.api.setPlanningContext).toHaveBeenCalledTimes(2)
    expect(f.api.setPlanningContext).toHaveBeenLastCalledWith('session',{clientId:'client',sequence:3,dirty:false})
    dispose();await vi.advanceTimersByTimeAsync(0)
    expect(f.api.setPlanningContext).toHaveBeenLastCalledWith('session',{clientId:'client',sequence:4,dirty:false})
  })
  it('refreshes its context lease within 30 seconds and stops intervals on unmount',async()=>{
    const f=fixture(),dispose=f.bind();await vi.advanceTimersByTimeAsync(25_000)
    expect(f.api.setPlanningContext).toHaveBeenCalledTimes(2)
    expect(f.api.setPlanningContext).toHaveBeenLastCalledWith('session',expect.objectContaining({sequence:2,workflowId:f.flow.id}))
    dispose();await vi.advanceTimersByTimeAsync(0)
    const count=vi.mocked(f.api.planningUpdates).mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.api.planningUpdates).toHaveBeenCalledTimes(count)
    expect(f.api.setPlanningContext).toHaveBeenCalledTimes(3)
  })
  it('uses Host created receipts for exact-session notifications and only refreshes matching proposals',async()=>{
    const f=fixture();f.setDirty(true)
    const result:PlanningPublicationUpdates={epoch:'host-a',cursor:3,items:[
      {sequence:1,taskId:'one',kind:'created',workflowId:'new-workflow',revision:1},
      {sequence:2,taskId:'two',kind:'proposed',workflowId:f.flow.id,revision:3,proposalId:'proposal'},
      {sequence:3,taskId:'three',kind:'proposed',workflowId:'another-workflow',revision:2,proposalId:'another-proposal'},
    ]}
    vi.mocked(f.api.planningUpdates).mockResolvedValue(result);f.bind();await vi.advanceTimersByTimeAsync(0)
    expect(f.onCreated).toHaveBeenCalledExactlyOnceWith('new-workflow','session')
    expect(f.store.refreshProposals).toHaveBeenCalledTimes(1)
    expect(f.store.getSnapshot().workflow).toEqual(f.flow);expect(f.store.hasUnsavedChanges()).toBe(true)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(f.api.planningUpdates).toHaveBeenLastCalledWith('session',3,'host-a')
    expect(f.onCreated).toHaveBeenCalledTimes(1);expect(f.store.refreshProposals).toHaveBeenCalledTimes(1)
  })
  it('shares a session cursor across remounts without replaying old publications',async()=>{
    const f=fixture();vi.mocked(f.api.planningUpdates).mockResolvedValue({epoch:'host-a',cursor:1,items:[{sequence:1,taskId:'one',kind:'created',workflowId:'new',revision:1}]})
    const dispose=f.bind('old-client');await vi.advanceTimersByTimeAsync(0);dispose()
    f.bind('new-client');await vi.advanceTimersByTimeAsync(0)
    expect(f.onCreated).toHaveBeenCalledTimes(1)
    expect(f.api.planningUpdates).toHaveBeenLastCalledWith('session',1,'host-a')
    expect(f.api.setPlanningContext).toHaveBeenLastCalledWith('session',expect.objectContaining({clientId:'new-client',sequence:1,workflowId:f.flow.id}))
  })
  it('ignores a publication response arriving after its exact session binding unmounted',async()=>{
    const f=fixture();let release!:(value:PlanningPublicationUpdates)=>void
    vi.mocked(f.api.planningUpdates).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
    const dispose=f.bind();dispose();release({epoch:'host-a',cursor:1,items:[{sequence:1,taskId:'one',kind:'created',workflowId:'new',revision:1}]})
    await vi.advanceTimersByTimeAsync(0)
    expect(f.onCreated).not.toHaveBeenCalled();expect(f.cursor.cursor).toBe(0)
  })
  it('resets a retained cursor when the Host publication journal restarts',async()=>{
    const f=fixture();f.cursor.cursor=20;f.cursor.epoch='previous-host'
    vi.mocked(f.api.planningUpdates).mockResolvedValue({epoch:'host-a',cursor:1,items:[{sequence:1,taskId:'after-restart',kind:'created',workflowId:'new',revision:1}]})
    f.bind();await vi.advanceTimersByTimeAsync(0)
    expect(f.onCreated).toHaveBeenCalledExactlyOnceWith('new','session');expect(f.cursor.cursor).toBe(1)
  })
  it('does not rewind or replay receipts when a same-epoch sibling response arrives out of order',async()=>{
    const f=fixture();f.cursor.epoch='host-a'
    let first!:(value:PlanningPublicationUpdates)=>void,second!:(value:PlanningPublicationUpdates)=>void
    vi.mocked(f.api.planningUpdates)
      .mockImplementationOnce(()=>new Promise(resolve=>{first=resolve}))
      .mockImplementationOnce(()=>new Promise(resolve=>{second=resolve}))
    f.bind('window-a');f.bind('window-b')
    expect(f.api.planningUpdates).toHaveBeenNthCalledWith(1,'session',0,'host-a')
    expect(f.api.planningUpdates).toHaveBeenNthCalledWith(2,'session',0,'host-a')
    const one={sequence:1,taskId:'one',kind:'created' as const,workflowId:'first',revision:1}
    const two={sequence:2,taskId:'two',kind:'created' as const,workflowId:'second',revision:1}
    second({epoch:'host-a',cursor:2,items:[one,two]});await vi.advanceTimersByTimeAsync(0)
    first({epoch:'host-a',cursor:1,items:[one]});await vi.advanceTimersByTimeAsync(0)
    expect(f.onCreated.mock.calls).toEqual([['first','session'],['second','session']])
    expect(f.cursor).toEqual({cursor:2,epoch:'host-a'})
  })
  it.each([false,true])('stops an old epoch during notification await without advancing the new cursor (more items: %s)',async(moreItems)=>{
    const f=fixture();f.cursor.epoch='old-host'
    let releaseNotice!:()=>void,releaseNew!:(value:PlanningPublicationUpdates)=>void
    f.onCreated.mockImplementationOnce(()=>new Promise<void>(resolve=>{releaseNotice=resolve}))
    vi.mocked(f.api.planningUpdates)
      .mockResolvedValueOnce({epoch:'old-host',cursor:50,items:[
        {sequence:1,taskId:'old-one',kind:'created',workflowId:'old-first',revision:1},
        ...(moreItems?[{sequence:2,taskId:'old-two',kind:'created' as const,workflowId:'old-second',revision:1}]:[]),
      ]})
      .mockImplementationOnce(()=>new Promise(resolve=>{releaseNew=resolve}))
    f.bind('window-a');await vi.advanceTimersByTimeAsync(0)
    expect(f.onCreated).toHaveBeenCalledExactlyOnceWith('old-first','session')
    f.bind('window-b')
    releaseNew({epoch:'new-host',cursor:1,items:[{sequence:1,taskId:'new-one',kind:'created',workflowId:'new-first',revision:1}]})
    await vi.advanceTimersByTimeAsync(0)
    releaseNotice();await vi.advanceTimersByTimeAsync(0)
    expect(f.onCreated.mock.calls).toEqual([['old-first','session'],['new-first','session']])
    expect(f.cursor).toEqual({cursor:1,epoch:'new-host'})
  })
  it('uses a changed epoch even when the new Host cursor has overtaken the old cursor',async()=>{
    const f=fixture();f.cursor.cursor=2;f.cursor.epoch='previous-host'
    vi.mocked(f.api.planningUpdates).mockResolvedValue({epoch:'new-host',cursor:8,items:[{sequence:1,taskId:'after-restart',kind:'created',workflowId:'new',revision:1}]})
    f.bind();await vi.advanceTimersByTimeAsync(0)
    expect(f.api.planningUpdates).toHaveBeenCalledWith('session',2,'previous-host')
    expect(f.onCreated).toHaveBeenCalledExactlyOnceWith('new','session');expect(f.cursor).toEqual({cursor:8,epoch:'new-host'})
  })
  it('ignores an old Host response after a sibling binding advances the shared epoch',async()=>{
    const f=fixture();f.cursor.cursor=2;f.cursor.epoch='previous-host'
    let release!:(value:PlanningPublicationUpdates)=>void
    vi.mocked(f.api.planningUpdates).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
    f.bind();f.cursor.cursor=3;f.cursor.epoch='new-host'
    release({epoch:'previous-host',cursor:9,items:[{sequence:8,taskId:'stale',kind:'created',workflowId:'stale-workflow',revision:1}]})
    await vi.advanceTimersByTimeAsync(0)
    expect(f.onCreated).not.toHaveBeenCalled();expect(f.cursor).toEqual({cursor:3,epoch:'new-host'})
  })
  it('also ignores stale first responses when no epoch was known at request time',async()=>{
    const f=fixture();let release!:(value:PlanningPublicationUpdates)=>void
    vi.mocked(f.api.planningUpdates).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
    f.bind();f.cursor.cursor=3;f.cursor.epoch='new-host'
    release({epoch:'old-host',cursor:9,items:[{sequence:8,taskId:'stale',kind:'created',workflowId:'stale-workflow',revision:1}]})
    await vi.advanceTimersByTimeAsync(0)
    expect(f.onCreated).not.toHaveBeenCalled();expect(f.cursor).toEqual({cursor:3,epoch:'new-host'})
  })
  it('reports connection failure once without recursively publishing errors as context changes',async()=>{
    const f=fixture();vi.mocked(f.api.setPlanningContext).mockRejectedValue(new Error('连接中断'))
    f.onError.mockImplementation(()=>f.notify());f.bind();await vi.advanceTimersByTimeAsync(25_000)
    expect(f.onError).toHaveBeenCalledExactlyOnceWith('工作流规划连接暂不可用：连接中断')
    expect(f.api.setPlanningContext).toHaveBeenCalledTimes(2)
  })
})

const progress=(sequence:number,taskRevision=sequence,state:'queued'|'authoring'|'repairing'|'published'='queued')=>({sequence,taskId:'task',taskRevision,state,at:'2026-10-19T10:00:00Z',message:state,cancellable:state!=='published'})
describe('planning progress bridge',()=>{
  it('merges progress and publication sequence without losing either channel',async()=>{
    const f=fixture();vi.mocked(f.api.planningUpdates).mockResolvedValue({epoch:'host-a',cursor:3,items:[{sequence:3,taskId:'task',kind:'created',workflowId:'new',revision:1}],progress:[progress(1),progress(2,2,'authoring')]})
    f.bind();await vi.advanceTimersByTimeAsync(0)
    expect(f.onCreated).toHaveBeenCalledExactlyOnceWith('new','session');expect(f.cursor.cursor).toBe(3)
    expect(f.onProgress).toHaveBeenLastCalledWith([expect.objectContaining({state:'authoring',taskRevision:2})])
    expect(f.store.getSnapshot().workflow).toEqual(f.flow)
  })
  it('retains task progress across remounts and rejects older task revisions',async()=>{
    const f=fixture();vi.mocked(f.api.planningUpdates).mockResolvedValueOnce({epoch:'host-a',cursor:1,items:[],progress:[progress(1,3,'repairing')]}).mockResolvedValue({epoch:'host-a',cursor:2,items:[],progress:[progress(2,2,'queued')]})
    const dispose=f.bind();await vi.advanceTimersByTimeAsync(0);dispose();f.bind('remount');await vi.advanceTimersByTimeAsync(0)
    expect(f.cursor.progress).toEqual([expect.objectContaining({taskRevision:3,state:'repairing'})]);expect(f.onProgress).toHaveBeenLastCalledWith([expect.objectContaining({taskRevision:3,state:'repairing'})])
    expect(f.onCreated).not.toHaveBeenCalled()
  })
  it('clears old task revisions on epoch restart and does not replay late progress',async()=>{
    const f=fixture();f.cursor.epoch='old';f.cursor.cursor=20;f.cursor.progress=[progress(20,9,'repairing')]
    vi.mocked(f.api.planningUpdates).mockResolvedValue({epoch:'host-a',cursor:1,items:[],progress:[progress(1,1,'queued')]})
    const dispose=f.bind();await vi.advanceTimersByTimeAsync(0)
    expect(f.cursor.progress).toEqual([expect.objectContaining({taskRevision:1,state:'queued'})]);dispose()
    const calls=f.onProgress.mock.calls.length;await vi.advanceTimersByTimeAsync(10_000);expect(f.onProgress).toHaveBeenCalledTimes(calls)
  })
})

describe('planning progress ownership changes',()=>{
  it('clears retained progress immediately when the session workspace changes and rereads the scoped journal',async()=>{
    const f=fixture();vi.mocked(f.api.planningUpdates).mockResolvedValueOnce({epoch:'host-a',cursor:4,items:[],progress:[progress(4,4,'repairing')]}).mockResolvedValue({epoch:'host-a',cursor:4,items:[]})
    f.bind();await vi.advanceTimersByTimeAsync(0);expect(f.cursor.progress).toHaveLength(1)
    f.setWorkspace('other');await vi.advanceTimersByTimeAsync(0)
    expect(f.onProgress).toHaveBeenLastCalledWith([]);expect(f.cursor.cursor).toBe(0)
    await vi.advanceTimersByTimeAsync(3_000);expect(f.api.planningUpdates).toHaveBeenLastCalledWith('session',0,'host-a')
  })
})


describe('event-driven planning long polling bridge',()=>{
  it('keeps one in-flight request and reconnects shortly after a response',async()=>{
    const f=fixture();f.api.eventDrivenUpdates=true
    let release!:(value:PlanningPublicationUpdates)=>void
    vi.mocked(f.api.planningUpdates).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve})).mockImplementation(()=>new Promise(()=>{}))
    const dispose=f.bind();await vi.advanceTimersByTimeAsync(19_000)
    expect(f.api.planningUpdates).toHaveBeenCalledTimes(1)
    release({epoch:'host-a',cursor:1,items:[],progress:[progress(1)]});await vi.advanceTimersByTimeAsync(0)
    expect(f.onProgress).toHaveBeenLastCalledWith([expect.objectContaining({state:'queued'})])
    await vi.advanceTimersByTimeAsync(49);expect(f.api.planningUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1);expect(f.api.planningUpdates).toHaveBeenCalledTimes(2)
    expect(f.api.planningUpdates).toHaveBeenLastCalledWith('session',1,'host-a')
    dispose();await vi.advanceTimersByTimeAsync(60_000);expect(f.api.planningUpdates).toHaveBeenCalledTimes(2)
  })
  it('backs off failures and resets the backoff after a successful event response',async()=>{
    const f=fixture();f.api.eventDrivenUpdates=true
    vi.mocked(f.api.planningUpdates).mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({epoch:'host-a',cursor:0,items:[]}).mockImplementation(()=>new Promise(()=>{}))
    f.bind();await vi.advanceTimersByTimeAsync(999);expect(f.api.planningUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1);expect(f.api.planningUpdates).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_999);expect(f.api.planningUpdates).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1);expect(f.api.planningUpdates).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(50);expect(f.api.planningUpdates).toHaveBeenCalledTimes(4)
    expect(f.onError).toHaveBeenCalledTimes(1)
  })
  it('does not reconnect or deliver late data after disposal during a Host wait',async()=>{
    const f=fixture();f.api.eventDrivenUpdates=true
    let release!:(value:PlanningPublicationUpdates)=>void
    vi.mocked(f.api.planningUpdates).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
    const dispose=f.bind();dispose()
    const calls=f.onProgress.mock.calls.length
    release({epoch:'host-a',cursor:1,items:[],progress:[progress(1)]})
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.api.planningUpdates).toHaveBeenCalledTimes(1);expect(f.onProgress).toHaveBeenCalledTimes(calls);expect(f.cursor.cursor).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('clears a pending reconnect timer on dispose',async()=>{
    const f=fixture();f.api.eventDrivenUpdates=true
    const dispose=f.bind();await vi.advanceTimersByTimeAsync(0);expect(f.api.planningUpdates).toHaveBeenCalledTimes(1)
    dispose();await vi.advanceTimersByTimeAsync(5_000)
    expect(f.api.planningUpdates).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0)
  })
})


describe('planning journal unavailable owner',()=>{
  it('backs off an unavailable session quietly rather than reconnecting every short success interval',async()=>{
    const f=fixture();f.api.eventDrivenUpdates=true
    vi.mocked(f.api.planningUpdates).mockResolvedValue({epoch:'unavailable',cursor:0,items:[]})
    const dispose=f.bind();await vi.advanceTimersByTimeAsync(999);expect(f.api.planningUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1);expect(f.api.planningUpdates).toHaveBeenCalledTimes(2)
    // Growing backoff: the next attempt waits 2 s.
    await vi.advanceTimersByTimeAsync(1_999);expect(f.api.planningUpdates).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1);expect(f.api.planningUpdates).toHaveBeenCalledTimes(3)
    // A conversation not yet bound to a workspace is not a connection error.
    expect(f.onError).not.toHaveBeenCalled()
    expect(f.cursor).toEqual({cursor:0})
    dispose()
  })
  it('withdraws its own connection error once the journal answers again',async()=>{
    const f=fixture(),onRecover=vi.fn();f.api.eventDrivenUpdates=true
    vi.mocked(f.api.planningUpdates).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({epoch:'unavailable',cursor:0,items:[]}).mockImplementation(()=>new Promise(()=>{}))
    const dispose=bindPlanningUi({sessionId:'session',store:f.store,api:f.api,cursor:f.cursor,workspaceId:()=>'workspace',onCreated:f.onCreated,onError:f.onError,onRecover,clientId:'client'})
    await vi.advanceTimersByTimeAsync(0);expect(f.onError).toHaveBeenCalledExactlyOnceWith('工作流规划连接暂不可用：network')
    await vi.advanceTimersByTimeAsync(1_000);expect(onRecover).toHaveBeenCalledExactlyOnceWith('工作流规划连接暂不可用：network')
    dispose()
  })
  it('never withdraws a context-write failure that repeats the poll error text',async()=>{
    const f=fixture(),onRecover=vi.fn();f.api.eventDrivenUpdates=true
    let failContext!:(error:Error)=>void
    vi.mocked(f.api.setPlanningContext).mockImplementationOnce(()=>new Promise((_resolve,reject)=>{failContext=reject}))
    vi.mocked(f.api.planningUpdates).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({epoch:'unavailable',cursor:0,items:[]}).mockImplementation(()=>new Promise(()=>{}))
    const dispose=bindPlanningUi({sessionId:'session',store:f.store,api:f.api,cursor:f.cursor,workspaceId:()=>'workspace',onCreated:f.onCreated,onError:f.onError,onRecover,clientId:'client'})
    await vi.advanceTimersByTimeAsync(0);expect(f.onError).toHaveBeenCalledExactlyOnceWith('工作流规划连接暂不可用：network')
    expect(f.api.setPlanningContext).toHaveBeenCalled();failContext(new Error('network'));await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000);expect(f.api.planningUpdates).toHaveBeenCalledTimes(2);expect(onRecover).not.toHaveBeenCalled()
    dispose()
  })
  it('keeps an unresolved context-write failure visible when a different poll error recovers',async()=>{
    const f=fixture(),onRecover=vi.fn();f.api.eventDrivenUpdates=true
    let failContext!:(error:Error)=>void,failPoll!:(error:Error)=>void
    vi.mocked(f.api.setPlanningContext).mockImplementationOnce(()=>new Promise((_resolve,reject)=>{failContext=reject}))
    vi.mocked(f.api.planningUpdates).mockImplementationOnce(()=>new Promise((_resolve,reject)=>{failPoll=reject})).mockResolvedValueOnce({epoch:'unavailable',cursor:0,items:[]}).mockImplementation(()=>new Promise(()=>{}))
    const dispose=bindPlanningUi({sessionId:'session',store:f.store,api:f.api,cursor:f.cursor,workspaceId:()=>'workspace',onCreated:f.onCreated,onError:f.onError,onRecover,clientId:'client'})
    await vi.advanceTimersByTimeAsync(0);failContext(new Error('context down'));await vi.advanceTimersByTimeAsync(0)
    failPoll(new Error('network'));await vi.advanceTimersByTimeAsync(0)
    expect(f.onError).toHaveBeenLastCalledWith('工作流规划连接暂不可用：network')
    await vi.advanceTimersByTimeAsync(1_000);expect(f.api.planningUpdates).toHaveBeenCalledTimes(2)
    expect(onRecover).toHaveBeenCalledExactlyOnceWith('工作流规划连接暂不可用：network')
    expect(f.onError).toHaveBeenLastCalledWith('工作流规划连接暂不可用：context down')
    dispose()
  })
  it('withdraws a restored context-write failure once the next context write succeeds',async()=>{
    const f=fixture(),onRecover=vi.fn();f.api.eventDrivenUpdates=true
    let failContext!:(error:Error)=>void,failPoll!:(error:Error)=>void
    vi.mocked(f.api.setPlanningContext).mockImplementationOnce(()=>new Promise((_resolve,reject)=>{failContext=reject}))
    vi.mocked(f.api.planningUpdates).mockImplementationOnce(()=>new Promise((_resolve,reject)=>{failPoll=reject})).mockResolvedValueOnce({epoch:'unavailable',cursor:0,items:[]}).mockImplementation(()=>new Promise(()=>{}))
    const dispose=bindPlanningUi({sessionId:'session',store:f.store,api:f.api,cursor:f.cursor,workspaceId:()=>'workspace',onCreated:f.onCreated,onError:f.onError,onRecover,clientId:'client'})
    await vi.advanceTimersByTimeAsync(0);failContext(new Error('context down'));await vi.advanceTimersByTimeAsync(0)
    failPoll(new Error('network'));await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000);expect(f.onError).toHaveBeenLastCalledWith('工作流规划连接暂不可用：context down')
    // The 25s heartbeat rewrites the context; its success must withdraw the restored banner.
    const errors=vi.mocked(f.onError).mock.calls.length
    await vi.advanceTimersByTimeAsync(25_000)
    expect(onRecover).toHaveBeenLastCalledWith('工作流规划连接暂不可用：context down')
    expect(f.onError).toHaveBeenCalledTimes(errors)
    dispose()
  })
  it('stops processing a scoped response when workspace changes while a notification is pending',async()=>{
    const f=fixture();f.api.eventDrivenUpdates=true
    let release!:()=>void
    f.onCreated.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve}))
    vi.mocked(f.api.planningUpdates).mockResolvedValueOnce({epoch:'host-a',cursor:2,items:[{sequence:1,taskId:'created',kind:'created',workflowId:'new',revision:1}],progress:[progress(2)]}).mockImplementation(()=>new Promise(()=>{}))
    const dispose=f.bind();await vi.advanceTimersByTimeAsync(0);f.setWorkspace('other');release();await vi.advanceTimersByTimeAsync(0)
    expect(f.cursor.cursor).toBe(0);expect(f.cursor.progress??[]).toEqual([])
    expect(f.onProgress).not.toHaveBeenCalledWith([expect.objectContaining({taskId:'task'})]);dispose()
  })
})

describe('resident planning event consumer without an input-area status renderer',()=>{
  it('consumes ready and terminal progress while retaining publication notifications and proposal refresh',async()=>{
    const f=fixture();f.api.eventDrivenUpdates=true
    vi.mocked(f.api.planningUpdates)
      .mockResolvedValueOnce({epoch:'host-a',cursor:1,items:[],progress:[{...progress(1),state:'ready',cancellable:true}]})
      .mockResolvedValueOnce({epoch:'host-a',cursor:4,items:[
        {sequence:2,taskId:'task',kind:'proposed',workflowId:f.flow.id,revision:f.flow.revision,proposalId:'proposal'},
        {sequence:3,taskId:'created',kind:'created',workflowId:'new-workflow',revision:1},
      ],progress:[progress(4,2,'published')]})
      .mockImplementation(()=>new Promise(()=>{}))
    // The mounted dock provides no progress callback or visible status controls.
    const dispose=bindPlanningUi({sessionId:'session',store:f.store,api:f.api,cursor:f.cursor,workspaceId:()=>'workspace',onCreated:f.onCreated,onError:f.onError,clientId:'resident'})
    bindings.push(dispose)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.cursor.progress?.[0]?.state).toBe('ready')
    expect(f.store.refreshProposals).not.toHaveBeenCalled();expect(f.onCreated).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(50)
    expect(f.store.refreshProposals).toHaveBeenCalledTimes(1)
    expect(f.onCreated).toHaveBeenCalledExactlyOnceWith('new-workflow','session')
    expect(f.cursor).toMatchObject({cursor:4,epoch:'host-a',progress:[expect.objectContaining({state:'published',taskRevision:2})]})
    expect(f.store.getSnapshot().workflow).toEqual(f.flow);expect(f.onProgress).not.toHaveBeenCalled()
    dispose();await vi.advanceTimersByTimeAsync(5_000)
    expect(f.api.planningUpdates).toHaveBeenCalledTimes(2)
  })
})
