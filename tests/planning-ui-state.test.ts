import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlanningUIState } from '../src/host/planning/ui-state.ts'
import type { PlanningTask } from '../src/host/planning/service.ts'
import { makeWorkflow } from '../src/shared/types.ts'

const context=(clientId='window-a',sequence=1,workflowId='daily',revision=3,dirty=false)=>({clientId,sequence,workflowId,revision,dirty})
function published(index=1,sessionId='main',workspaceId='workspace',kind:'created'|'proposed'='created'):PlanningTask {
  const key=index.toString(16).padStart(64,'0'),digest='b'.repeat(64),workflow=makeWorkflow(workspaceId,'日报');workflow.id=`flow-${index}`
  return {id:`task-${index}`,request:{requestId:`request-${index}`,operation:kind==='created'?'create':'revise',instruction:'日报'},state:'published',sessionId,workspaceId,
    context:{workflow},candidate:workflow,candidateDigest:digest,commit:{key,digest},receipt:{key,digest,kind,workflowId:workflow.id,revision:kind==='created'?1:3,...(kind==='proposed'?{proposalId:`proposal-${index}`}:{})}} as PlanningTask
}

describe('planning canvas context',()=>{
  it('accepts only strictly increasing sequences for the same session and client',()=>{
    const state=new PlanningUIState()
    state.set('main',context('window-a',3,'daily',4))
    state.set('main',context('window-a',2,'other',8,true))
    state.set('main',context('window-a',3,'other',8,true))
    expect(state.current('main')).toEqual(context('window-a',3,'daily',4))
    state.set('main',context('window-a',4,'daily',5,true))
    expect(state.current('main')).toEqual(context('window-a',4,'daily',5,true))
  })

  it('expires stale hints without letting out-of-order updates extend their TTL',()=>{
    let now=0;const state=new PlanningUIState(()=>now)
    state.set('main',context('window-a',3))
    now=100_000;state.set('main',context('window-a',2))
    now=120_001;expect(state.current('main')).toBeUndefined()
  })

  it('refreshes TTL on a newer heartbeat and detaches the input and output objects',()=>{
    let now=0;const state=new PlanningUIState(()=>now),value=context()
    state.set('main',value);value.dirty=true
    expect(state.current('main')?.dirty).toBe(false)
    now=100_000;state.set('main',context('window-a',2))
    now=150_000;expect(state.current('main')?.workflowId).toBe('daily')
    state.current('main')!.dirty=true;expect(state.current('main')?.dirty).toBe(false)
  })

  it('reports different workflow windows as ambiguous but resolves an explicit target independently',()=>{
    const state=new PlanningUIState()
    state.set('main',context('window-a',1,'daily',3))
    state.set('main',context('window-b',1,'weekly',6,true))
    expect(()=>state.current('main')).toThrow(/多个窗口/)
    expect(state.forWorkflow('main','daily')).toEqual(context('window-a',1,'daily',3))
    expect(state.forWorkflow('main','weekly')).toEqual(context('window-b',1,'weekly',6,true))
    expect(state.forWorkflow('main','missing')).toBeUndefined()
  })

  it('aggregates dirty across windows and retains the oldest revision for stale-baseline rejection',()=>{
    const state=new PlanningUIState()
    state.set('main',context('window-a',2,'daily',3,false))
    state.set('main',context('window-b',4,'daily',7,true))
    expect(state.current('main')).toMatchObject({workflowId:'daily',revision:3,dirty:true})
    expect(state.forWorkflow('main','daily')).toMatchObject({workflowId:'daily',revision:3,dirty:true})
  })

  it('clears only its own window with a monotonic tombstone',()=>{
    const state=new PlanningUIState()
    state.set('main',context('window-a',1,'daily',3,true))
    state.set('main',context('window-b',1,'daily',3,false))
    state.set('main',{clientId:'window-a',sequence:2,dirty:false})
    expect(state.current('main')).toEqual(context('window-b',1,'daily',3,false))
    state.set('main',context('window-a',1,'other',5,true))
    expect(state.current('main')?.workflowId).toBe('daily')
    state.set('main',{clientId:'window-b',sequence:2,dirty:false})
    expect(state.current('main')).toBeUndefined()
  })

  it('isolates identical client IDs in different sessions',()=>{
    const state=new PlanningUIState()
    state.set('main',context('window-a',99,'daily',3))
    state.set('other',context('window-a',1,'private',8,true))
    expect(state.current('main')?.workflowId).toBe('daily')
    expect(state.current('other')?.workflowId).toBe('private')
    state.set('main',{clientId:'window-a',sequence:100,dirty:false})
    expect(state.current('other')?.workflowId).toBe('private')
  })

  it.each([
    {...context(),unknown:true}, {...context(),sequence:-1}, {...context(),sequence:1.5}, {...context(),sequence:Number.MAX_SAFE_INTEGER+1},
    {...context(),clientId:'unsafe/id'}, {...context(),revision:-1}, {clientId:'window-a',sequence:1,workflowId:'daily',dirty:false},
    {clientId:'window-a',sequence:1,revision:1,dirty:false}, {clientId:'window-a',sequence:1,dirty:true},
  ])('rejects malformed or partial context %#',value=>{
    const state=new PlanningUIState();expect(()=>state.set('main',value)).toThrow();expect(state.current('main')).toBeUndefined()
  })

  it('bounds active contexts and recovers capacity after TTL',()=>{
    let now=0;const state=new PlanningUIState(()=>now)
    for(let i=0;i<500;i++)state.set('main',context(`window-${i}`))
    expect(()=>state.set('main',context('overflow'))).toThrow(/数量达到上限/)
    state.set('main',context('window-0',2))
    now=120_001;state.set('main',context('after-expiry'))
    expect(state.current('main')?.clientId).toBe('after-expiry')
  })
})

describe('planning publication journal',()=>{
  it('records only a committed published receipt, never summaries, previews, or candidate claims',()=>{
    const state=new PlanningUIState()
    for(const status of ['ready','publishing','awaiting_input','failed','blocked','cancelled'] as const)state.record({...published(),state:status})
    state.record({...published(),receipt:undefined})
    state.record({...published(),receipt:{...published().receipt!,workflowId:'wrong'}})
    state.record({...published(),receipt:{...published().receipt!,key:'bad-key'}})
    expect(state.updates('workspace','main',0)).toEqual({epoch:expect.any(String),cursor:0,items:[]})
    state.record(published())
    expect(state.updates('workspace','main',0)).toEqual({epoch:expect.any(String),cursor:1,items:[{sequence:1,taskId:'task-1',kind:'created',workflowId:'flow-1',revision:1}]})
  })

  it('preserves proposed receipt identity without claiming that the original graph changed',()=>{
    const state=new PlanningUIState();state.record(published(1,'main','workspace','proposed'))
    expect(state.updates('workspace','main',0).items).toEqual([{sequence:1,taskId:'task-1',kind:'proposed',workflowId:'flow-1',revision:3,proposalId:'proposal-1'}])
  })

  it('deduplicates a receipt across repeated status reads and returns detached updates',()=>{
    const state=new PlanningUIState(),task=published()
    state.record(task);state.record(structuredClone(task));state.record({...task,id:'another-task'})
    const result=state.updates('workspace','main',0)
    expect(result.cursor).toBe(1);expect(result.items).toHaveLength(1)
    result.items[0]!.workflowId='changed'
    expect(state.updates('workspace','main',0).items[0]!.workflowId).toBe('flow-1')
  })

  it('filters workspace and session while advancing the shared cursor across invisible receipts',()=>{
    const state=new PlanningUIState()
    state.record(published(1,'main'));state.record(published(2,'other'));state.record(published(3,'main','other-workspace'))
    expect(state.updates('workspace','main',0)).toMatchObject({cursor:3,items:[{taskId:'task-1'}]})
    expect(state.updates('workspace','other',0).items.map(item=>item.taskId)).toEqual(['task-2'])
    expect(state.updates('other-workspace','main',0).items.map(item=>item.taskId)).toEqual(['task-3'])
    expect(state.updates('workspace','main',1,state.updates('workspace','main',0).epoch)).toEqual({epoch:expect.any(String),cursor:3,items:[]})
  })

  it('resets an obsolete cursor after Host restart and returns only the requesting session receipts',()=>{
    const state=new PlanningUIState()
    expect(state.updates('workspace','main',92)).toEqual({epoch:expect.any(String),cursor:0,items:[]})
    state.record(published(1));state.record(published(2,'other'))
    expect(state.updates('workspace','main',92)).toEqual({epoch:expect.any(String),cursor:2,items:[{sequence:1,taskId:'task-1',kind:'created',workflowId:'flow-1',revision:1}]})
  })

  it('replays after an epoch change even when fresh publications have overtaken the old cursor',()=>{
    const before=new PlanningUIState();before.record(published(1))
    const old=before.updates('workspace','main',0)
    const after=new PlanningUIState();after.record(published(2));after.record(published(3));after.record(published(4))
    const result=after.updates('workspace','main',old.cursor,old.epoch)
    expect(result.epoch).not.toBe(old.epoch);expect(result.cursor).toBe(3)
    expect(result.items.map(item=>item.taskId)).toEqual(['task-2','task-3','task-4'])
    expect(after.updates('workspace','main',result.cursor,result.epoch).items).toEqual([])
  })

  it.each([-1,1.5,Number.MAX_SAFE_INTEGER+1,NaN,Infinity])('rejects invalid publication cursor %s',cursor=>{
    const state=new PlanningUIState();expect(()=>state.updates('workspace','main',cursor)).toThrow(/游标无效/)
  })

  it('bounds publication history and keeps the cursor monotonic after eviction',()=>{
    const state=new PlanningUIState()
    for(let i=1;i<=501;i++)state.record(published(i))
    const result=state.updates('workspace','main',0)
    expect(result.cursor).toBe(501);expect(result.items).toHaveLength(500);expect(result.items[0]!.sequence).toBe(2)
  })
})

function progressTask(revision=1,state:PlanningTask['state']='queued',sessionId='main',workspaceId='workspace'):PlanningTask {
  const task=published(1,sessionId,workspaceId)
  return {...task,revision,state,receipt:undefined,updatedAt:'2026-10-19T10:00:00.000Z',events:[{sequence:revision,state,at:'2026-10-19T10:00:00.000Z',message:`progress-${revision}`}]} as PlanningTask
}
describe('planning progress journal',()=>{
  it('records actual task states once per revision without publishing candidate claims',()=>{
    const state=new PlanningUIState(),task=progressTask()
    state.record(task);state.record(structuredClone(task));state.record({...task,state:'published'})
    const first=state.updates('workspace','main',0)
    expect(first.cursor).toBe(1);expect(first.items).toEqual([])
    expect(first.progress).toEqual([{sequence:1,taskId:task.id,taskRevision:1,state:'queued',at:task.updatedAt,message:'progress-1',workflowId:task.context!.workflow.id,cancellable:true}])
    state.record(progressTask(2,'authoring'));state.record(progressTask(1,'failed'))
    const second=state.updates('workspace','main',first.cursor,first.epoch)
    expect(second.cursor).toBe(2);expect(second.progress).toEqual([expect.objectContaining({taskRevision:2,state:'authoring'})])
    expect(state.updates('workspace','main',second.cursor,second.epoch).progress).toBeUndefined()
  })
  it('isolates task ownership, workspace and session even when task IDs coincide',()=>{
    const state=new PlanningUIState()
    state.record(progressTask());state.record(progressTask(2,'repairing','other'));state.record(progressTask(3,'failed','main','private'))
    expect(state.updates('workspace','main',0).progress).toEqual([expect.objectContaining({taskRevision:1,state:'queued'})])
    expect(state.updates('workspace','other',0).progress).toEqual([expect.objectContaining({taskRevision:2,state:'repairing'})])
    expect(state.updates('private','main',0).progress).toEqual([expect.objectContaining({taskRevision:3,state:'failed',cancellable:false})])
  })
  it('keeps publication receipts separate and shares one ordered cursor',()=>{
    const state=new PlanningUIState(),task={...published(),revision:3,updatedAt:'2026-10-19T10:00:00.000Z',events:[]}
    state.record(task)
    const result=state.updates('workspace','main',0)
    expect(result.progress).toEqual([expect.objectContaining({sequence:1,state:'published',cancellable:false})])
    expect(result.items).toEqual([expect.objectContaining({sequence:2,kind:'created'})]);expect(result.cursor).toBe(2)
    result.progress![0]!.message='mutated';expect(state.updates('workspace','main',0).progress![0]!.message).toBe('')
  })
  it('replays current progress after epoch restart, bounds retained tasks and ignores malformed revisions',()=>{
    const state=new PlanningUIState(),previous=state.updates('workspace','main',0)
    for(let i=1;i<=501;i++)state.record({...progressTask(),id:`task-${i}`})
    state.record({...progressTask(),revision:0});state.record({...progressTask(),revision:NaN})
    const result=state.updates('workspace','main',1,previous.epoch+'old')
    expect(result.cursor).toBe(501);expect(result.progress).toHaveLength(500);expect(result.progress![0]!.taskId).toBe('task-2')
  })
})


describe('event-woken planning journal waits',()=>{
  afterEach(()=>vi.useRealTimers())
  it('returns existing owned events and an epoch handshake without waiting',async()=>{
    vi.useFakeTimers()
    const state=new PlanningUIState(),initial=state.updates('workspace','main',0)
    expect(await state.waitUpdates('workspace','main',0,'old-host',20_000)).toEqual(initial)
    state.record(progressTask())
    expect((await state.waitUpdates('workspace','main',0,initial.epoch,20_000)).progress).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('wakes immediately for a matching owner event, with both receipt and progress in one journal response',async()=>{
    vi.useFakeTimers()
    const state=new PlanningUIState(),initial=state.updates('workspace','main',0)
    const waiting=state.waitUpdates('workspace','main',0,initial.epoch,20_000)
    const task=progressTask(1,'published');task.receipt=published().receipt
    state.record(task)
    expect(await waiting).toMatchObject({cursor:2,progress:[{state:'published'}],items:[{kind:'created'}]})
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not wake on another workspace or session and never returns their data at timeout',async()=>{
    vi.useFakeTimers()
    const state=new PlanningUIState(),initial=state.updates('workspace','main',0),resolved=vi.fn()
    const waiting=state.waitUpdates('workspace','main',0,initial.epoch,20_000).then(result=>{resolved(result);return result})
    state.record(progressTask(1,'queued','other'));state.record(progressTask(1,'queued','main','other-workspace'))
    await vi.advanceTimersByTimeAsync(19_999);expect(resolved).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await waiting).toEqual({epoch:initial.epoch,cursor:2,items:[]})
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds owner subscriptions and wait duration, then recovers capacity after timeout',async()=>{
    vi.useFakeTimers()
    const state=new PlanningUIState(),epoch=state.updates('workspace','main',0).epoch
    const waits=Array.from({length:4},()=>state.waitUpdates('workspace','main',0,epoch,20_000))
    await expect(state.waitUpdates('workspace','main',0,epoch,20_000)).rejects.toThrow(/数量达到上限/)
    await expect(state.waitUpdates('workspace','main',0,epoch,20_001)).rejects.toThrow(/等待时间/)
    await vi.advanceTimersByTimeAsync(20_000);await Promise.all(waits)
    const again=state.waitUpdates('workspace','main',0,epoch,1)
    await vi.advanceTimersByTimeAsync(1);expect((await again).items).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds total subscriptions independently of owner identity',async()=>{
    vi.useFakeTimers()
    const state=new PlanningUIState(),epoch=state.updates('workspace','main',0).epoch
    const waits=Array.from({length:128},(_,i)=>state.waitUpdates('workspace',`session-${i}`,0,epoch,20_000))
    await expect(state.waitUpdates('workspace','overflow',0,epoch,20_000)).rejects.toThrow(/数量达到上限/)
    const closed=Promise.allSettled(waits);state.dispose();expect((await closed).every(value=>value.status==='rejected')).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('closes pending waits and timers on dispose and refuses new subscriptions',async()=>{
    vi.useFakeTimers()
    const state=new PlanningUIState(),epoch=state.updates('workspace','main',0).epoch
    const waiting=state.waitUpdates('workspace','main',0,epoch,20_000)
    const closed=expect(waiting).rejects.toThrow(/已关闭/);state.dispose();state.dispose();await closed
    await expect(state.waitUpdates('workspace','main',0,epoch,20_000)).rejects.toThrow(/已关闭/)
    expect(vi.getTimerCount()).toBe(0)
  })
})
