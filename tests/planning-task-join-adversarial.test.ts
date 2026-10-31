import {afterEach,describe,expect,it,vi} from 'vitest'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {PlanningTurnJoin,planningJoinDisposition,planningJoinSummary,type PlanningJoinView} from '../src/host/planning/task-join.ts'
import {PlanningUIState} from '../src/host/planning/ui-state.ts'

const root=(id='root')=>({id,inbox:{nextStep:[] as {id:string}[]},steer:vi.fn()}) as unknown as Agent
const task=(state='authoring',revision=1,other:Partial<PlanningJoinView>={}):PlanningJoinView=>({taskId:'exact-task',state,revision,preview:true,...other})
const deferred=<T>()=>Promise.withResolvers<T>()
afterEach(()=>vi.useRealTimers())

describe('adversarial planning turn join boundaries',()=>{
  it('joins an early command only in the turn that consumes its Host followup',async()=>{
    const join=new PlanningTurnJoin(),agent=root(),signal=new AbortController().signal
    join.trackCommand(agent,'workspace',task('queued'))
    const read=vi.fn(()=>task('published',4,{receipt:{kind:'created'}})),wait=vi.fn()
    join.begin(agent,1,[{source:{kind:'user'},content:'previous turn'}])
    await join.stopping(agent,1,signal,{read,wait})
    expect(read).not.toHaveBeenCalled()
    join.begin(agent,2,[{source:{kind:'visible-workflow-command'},content:{taskId:'exact-task'}}])
    await join.stopping(agent,2,signal,{read,wait})
    expect(read).toHaveBeenCalledOnce();expect(agent.steer).toHaveBeenCalledOnce()
    join.begin(agent,3,[{source:{kind:'user'},content:'another turn'}])
    await join.stopping(agent,3,signal,{read,wait})
    expect(read).toHaveBeenCalledOnce()
  })
  it('waits through bounded timeout responses and the nonpreview ready→publish race',async()=>{
    const join=new PlanningTurnJoin(),agent=root(),controller=new AbortController()
    join.begin(agent,1);join.observe(agent,'owned-workspace',task('queued',1,{preview:false}))
    let current=task('ready',2,{preview:false,joinActive:true}),calls=0
    const wait=vi.fn(async(id,workspace)=>{
      expect(id).toBe('exact-task');expect(workspace).toBe('owned-workspace')
      expect(agent.steer).not.toHaveBeenCalled()
      if(++calls===2)current=task('published',3,{preview:false,receipt:{kind:'proposed',proposalId:'actual-proposal'}})
      return current
    })
    await join.stopping(agent,1,controller.signal,{read:()=>current,wait})
    expect(wait).toHaveBeenCalledTimes(2);expect(agent.steer).toHaveBeenCalledOnce()
    expect(JSON.stringify(vi.mocked(agent.steer).mock.calls[0])).toContain('actual-proposal')
    await join.stopping(agent,1,controller.signal,{read:()=>current,wait})
    expect(agent.steer).toHaveBeenCalledOnce()
  })

  it('retains pending bookkeeping if steering fails and retries only the same final notice',async()=>{
    const join=new PlanningTurnJoin(),agent=root(),signal=new AbortController().signal
    join.begin(agent,1);join.observe(agent,'workspace',task())
    vi.mocked(agent.steer).mockImplementationOnce(()=>{throw new Error('inbox write failed')})
    const read=()=>task('ready',2),wait=vi.fn()
    await expect(join.stopping(agent,1,signal,{read,wait})).rejects.toThrow('inbox write failed')
    await join.stopping(agent,1,signal,{read,wait})
    await join.stopping(agent,1,signal,{read,wait})
    expect(agent.steer).toHaveBeenCalledTimes(2);expect(wait).not.toHaveBeenCalled()
  })

  it('does not join another Agent object sharing the same textual root ID or an old turn',async()=>{
    const join=new PlanningTurnJoin(),agent=root(),impostor=root(),signal=new AbortController().signal
    join.begin(agent,3);join.observe(agent,'workspace',task())
    const read=vi.fn(()=>task('ready',2)),wait=vi.fn()
    await join.stopping(impostor,3,signal,{read,wait})
    await join.stopping(agent,2,signal,{read,wait})
    join.begin(agent,4)
    await join.stopping(agent,4,signal,{read,wait})
    expect(read).not.toHaveBeenCalled();expect(wait).not.toHaveBeenCalled();expect(agent.steer).not.toHaveBeenCalled()
  })

  it('treats a new next-step input already pending at hook entry as work for the native loop',async()=>{
    const join=new PlanningTurnJoin(),agent=root(),signal=new AbortController().signal
    join.begin(agent,1);join.observe(agent,'workspace',task())
    ;(agent.inbox.nextStep as {id:string}[]).push({id:'human-stop'})
    const read=vi.fn(()=>task('ready',2)),wait=vi.fn()
    await join.stopping(agent,1,signal,{read,wait})
    expect(read).not.toHaveBeenCalled();expect(agent.steer).not.toHaveBeenCalled()
    ;(agent.inbox.nextStep as {id:string}[]).splice(0)
    await join.stopping(agent,1,signal,{read,wait})
    expect(agent.steer).toHaveBeenCalledOnce()
  })

  it('interrupts a blocked join for fresh human steering and keeps all undelivered task notices',async()=>{
    const join=new PlanningTurnJoin(),agent=root(),controller=new AbortController(),entered=deferred<void>()
    join.begin(agent,1);join.observe(agent,'workspace',task('queued'))
    join.observe(agent,'workspace',task('queued',1,{taskId:'second-task'}))
    const read=(id:string)=>id==='exact-task'?task('ready',2):task('authoring',2,{taskId:id})
    const wait=vi.fn((_id,_workspace,signal:AbortSignal)=>new Promise<PlanningJoinView>((_resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});entered.resolve()
    }))
    const stopping=join.stopping(agent,1,controller.signal,{read,wait})
    await entered.promise
    join.interrupt(agent)
    await stopping
    expect(controller.signal.aborted).toBe(false);expect(agent.steer).not.toHaveBeenCalled()
    await join.stopping(agent,1,controller.signal,{read:id=>task('ready',3,{taskId:id}),wait})
    const notice=JSON.stringify(vi.mocked(agent.steer).mock.calls[0])
    expect(notice).toContain('exact-task');expect(notice).toContain('second-task')
    expect(agent.steer).toHaveBeenCalledOnce()
  })

  it('propagates external cancellation instead of swallowing it as fresh input',async()=>{
    const join=new PlanningTurnJoin(),agent=root(),controller=new AbortController(),entered=deferred<void>()
    join.begin(agent,1);join.observe(agent,'workspace',task())
    const error=new Error('external user cancel')
    const wait=vi.fn((_id,_workspace,signal:AbortSignal)=>new Promise<PlanningJoinView>((_resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});entered.resolve()
    }))
    const promise=join.stopping(agent,1,controller.signal,{read:()=>task(),wait})
    const rejection=expect(promise).rejects.toBe(error)
    await entered.promise;controller.abort(error);join.interrupt(agent)
    await rejection
    expect(agent.steer).not.toHaveBeenCalled()
  })

  it('rechecks live authority after an event wakes the waiter and emits no unauthorized notice',async()=>{
    const join=new PlanningTurnJoin(),agent=root(),signal=new AbortController().signal
    join.begin(agent,1);join.observe(agent,'original-workspace',task())
    let permitted=true
    const read=vi.fn((_id,workspace)=>{expect(workspace).toBe('original-workspace');if(!permitted)throw new Error('owner or workspace revoked');return task()})
    const wait=vi.fn(async()=>{permitted=false;return task('published',5)})
    await expect(join.stopping(agent,1,signal,{read,wait})).rejects.toThrow('owner or workspace revoked')
    expect(read).toHaveBeenCalledTimes(2);expect(agent.steer).not.toHaveBeenCalled()
  })

  it.each(['awaiting_input','needs_input'])('hands %s to the human without waiting for an answer or taking an action',async state=>{
    const join=new PlanningTurnJoin(),agent=root(),signal=new AbortController().signal
    join.begin(agent,1);join.observe(agent,'workspace',task('queued'))
    const wait=vi.fn(),read=()=>task(state,2,{questions:[{id:'human-choice',question:'Actual pending question'}]})
    await join.stopping(agent,1,signal,{read,wait})
    expect(wait).not.toHaveBeenCalled();expect(agent.steer).toHaveBeenCalledOnce()
    expect(JSON.stringify(vi.mocked(agent.steer).mock.calls[0])).toContain('needs-input')
  })

  it('does not steer an already observed preview ready state or treat active nonpreview ready as final',async()=>{
    expect(planningJoinDisposition(task('ready',2,{preview:false,joinActive:true}))).toBeUndefined()
    expect(planningJoinDisposition(task('ready',2,{preview:false,joinActive:false}))).toBe('ready')
    const join=new PlanningTurnJoin(),agent=root(),signal=new AbortController().signal,view=task('ready',2)
    join.begin(agent,1);join.observe(agent,'workspace',view)
    await join.stopping(agent,1,signal,{read:()=>view,wait:vi.fn()})
    expect(agent.steer).not.toHaveBeenCalled()
  })
})

describe('production scoped UI journal wait cleanup',()=>{
  it('releases aborted waiter slots and rejects the original cancellation reason',async()=>{
    const ui=new PlanningUIState(),journal=ui.updates('workspace','root',0)
    try{
      for(let i=0;i<6;i++){
        const controller=new AbortController(),reason=new Error('cancel waiting '+i)
        const promise=ui.waitUpdates('workspace','root',journal.cursor,journal.epoch,20_000,controller.signal)
        const rejection=expect(promise).rejects.toBe(reason)
        controller.abort(reason);await rejection
      }
      const controller=new AbortController(),last=ui.waitUpdates('workspace','root',journal.cursor,journal.epoch,20_000,controller.signal)
      const rejection=expect(last).rejects.toThrow('last cancel')
      controller.abort(new Error('last cancel'));await rejection
    }finally{ui.dispose()}
  })

  it('leaves other roots asleep on targeted abort and closes outstanding waits on dispose',async()=>{
    const ui=new PlanningUIState(),first=ui.updates('workspace','a',0),second=ui.updates('workspace','b',0),controller=new AbortController()
    const a=ui.waitUpdates('workspace','a',first.cursor,first.epoch,20_000,controller.signal)
    const b=ui.waitUpdates('workspace','b',second.cursor,second.epoch,20_000)
    let bSettled=false;void b.then(()=>{bSettled=true},()=>{bSettled=true})
    const aRejected=expect(a).rejects.toThrow('only a');controller.abort(new Error('only a'));await aRejected
    expect(bSettled).toBe(false)
    const bRejected=expect(b).rejects.toThrow('规划通知已关闭');ui.dispose();await bRejected
  })

  it('returns after a bounded timeout without inventing a progress or publication event',async()=>{
    vi.useFakeTimers()
    const ui=new PlanningUIState(),journal=ui.updates('workspace','root',0)
    try{
      const promise=ui.waitUpdates('workspace','root',journal.cursor,journal.epoch,12_000,new AbortController().signal)
      await vi.advanceTimersByTimeAsync(12_000)
      expect(await promise).toEqual(journal)
    }finally{ui.dispose()}
  })
})

it('reports ended legacy review states and carries rehearsal/run facts in the final join notice',()=>{
  for(const state of ['needs_review','trial_review'])expect(planningJoinDisposition(task(state))).toBe('stopped')
  const firstRun={runId:'run-once',run:{status:'waiting',waiting:{prompt:'请确认'}}},trialReport={summary:'网页提取未跑通',summarySource:'agent-claim'}
  const summary=planningJoinSummary(task('published',3,{planning:task('published',3,{firstRun,trialReport})}))
  expect(summary.firstRun).toEqual(firstRun);expect(summary.trialReport).toEqual(trialReport)
})
