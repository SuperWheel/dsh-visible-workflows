import { describe,expect,it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { RunObservationScopes,UNRECORDED_OBSERVATION,type ObservationContext } from '../src/host/run-observation-scope.ts'
import { FsError,observationPolicyPlugin } from './fixtures/t18-tools.ts'

// The decorated Host entry runs in tsx; each case mounts a fresh Host, real
// Cordis events, the real dsh-tools registry and the pinned T18 SDK sources.
const host=async(name:string)=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/run-observation-host-fixture.ts',import.meta.url).pathname,name],{timeout:60_000})
  return JSON.parse(stdout.trim().split('\n').at(-1)!)
}

describe('workflow runs own their filesystem observations (T05.7.5)',()=>{
  it.each([
    ['cross-run-create','run A reads and writes, external delete, run B creates the root target'],
    ['same-run-stale','an external change between a read and a write in one run is still rejected'],
    ['same-run-unread','an unread existing target stays protected inside a run'],
    ['conversation-to-run','conversation observations neither authorize nor stale a run'],
    ['run-to-conversation','run observations neither authorize nor stale the conversation, which keeps its own'],
    ['child-run','a child workflow run owns its observations, separate from its parent'],
    ['foreign-decider','a non-policy decider in the slot keeps its stricter semantics'],
    ['nested-before-observation','a wrapper nested dispatch belongs to the run before the wrapper emits anything'],
    ['pre-install-conversation','conversation history predating installation is unknown and needs a re-read'],
    ['release-after-answer','a run completed after an answer releases its ledger without a Remote poll'],
    ['release-after-agent-cancel','cancelling a waiting run through the Agent tool releases its ledger'],
    ['answer-before-drain','answering before the first executor drained keeps the live conversation binding'],
  ])('%s: %s',async name=>{
    expect(await host(name)).toEqual({ok:true,case:name})
  },60_000)
})

describe('RunObservationScopes over the pinned SDK policy and real Cordis events',()=>{
  const target={targetKey:'/w/t05-greeting.json',displayPath:'/w/t05-greeting.json'}
  async function events(options:{policy?:'before'|'after'|'none';foreign?:boolean;wrapper?:'before-host'|'after-host';gate?:()=>Promise<void>}={}){
    const ctx=new Context() as any,policy=options.policy??'before'
    // Shape of the SDK workspace-changes recorder: prepended, awaits the decision, then captures.
    const wrapped:unknown[]=[]
    const wrapper=()=>ctx.plugin({name:'workspace-changes',apply:(plugin:any)=>{for(const name of ['fs/write-intent','fs/edit-intent'])plugin.on(name,async(_target:unknown,_actor:unknown,next:()=>Promise<unknown>)=>{await options.gate?.();const intent=await next();wrapped.push(intent);return intent},{prepend:true})}})
    const foreign=options.foreign?ctx.plugin({name:'create-only-decider',apply:(plugin:any)=>{plugin.on('fs/write-intent',async()=>({kind:'createIfAbsent'}))}}):undefined
    if(foreign)await foreign
    if(policy==='before')await ctx.plugin(observationPolicyPlugin())
    if(options.wrapper==='before-host')await wrapper()
    let scopes!:RunObservationScopes
    const host=ctx.plugin({name:'visible-workflows-probe',apply:(plugin:any)=>{scopes=new RunObservationScopes(plugin as ObservationContext);plugin.effect(()=>{const disposers=scopes.listeners();return ()=>{for(const dispose of disposers)dispose()}})}})
    await host
    if(options.wrapper==='after-host')await wrapper()
    let policyFiber=policy==='after'?ctx.plugin(observationPolicyPlugin()):undefined
    if(policyFiber)await policyFiber
    const agent={session:{}},exec=(callId:string,extra:Record<string,unknown>={})=>({callId,token:Symbol(callId),agent,signal:new AbortController().signal,...extra})
    return {ctx,scopes,exec,agent,wrapped,removeForeign:async()=>{await foreign?.dispose()},
      reloadPolicy:async()=>{await policyFiber?.dispose();policyFiber=ctx.plugin(observationPolicyPlugin());await policyFiber},
      write:(actor:unknown)=>ctx.waterfall('fs/write-intent',target,actor,()=>undefined),
      edit:(actor:unknown)=>ctx.waterfall('fs/edit-intent',target,actor,()=>undefined),
      execute:(actor:unknown,body:()=>Promise<unknown>)=>ctx.waterfall('tools/execute',actor,body),
      observe:(observation:unknown,actor:unknown)=>ctx.emit('fs/observed',target,observation,actor)}
  }
  it('edits in a run follow the SDK gate over the run ledger, with the SDK error class',async()=>{
    const e=await events()
    await e.scopes.dispatch('run-1','c1',async()=>{
      const unseen=await e.edit(e.exec('c1')).catch((error:unknown)=>error)
      expect(unseen).toBeInstanceOf(FsError);expect(unseen).toMatchObject({code:'FS_NOT_OBSERVED',message:`edit requires reading "${target.displayPath}" first`})
      e.observe({kind:'absent'},e.exec('c1'))
      const absent=await e.edit(e.exec('c1')).catch((error:unknown)=>error)
      expect(absent).toBeInstanceOf(FsError);expect(absent).toMatchObject({code:'FS_NOT_FOUND'})
      e.observe({kind:'present',version:'v1'},e.exec('c1'))
      await expect(e.edit(e.exec('c1'))).resolves.toEqual({version:'v1'})
    })
    // The SDK gate also stored v1 under the session of a conversation opened before
    // installation: unknown history, so its guarded mutations demand a re-read.
    await expect(e.write(e.exec('conversation'))).resolves.toEqual({kind:'replaceIfVersion',version:UNRECORDED_OBSERVATION})
    await expect(e.edit(e.exec('conversation'))).resolves.toEqual({version:UNRECORDED_OBSERVATION})
  })
  it('a conversation announced after installation is unseen, not unknown, for run-touched targets',async()=>{
    const e=await events()
    e.ctx.emit('session/created',e.agent.session)
    await e.scopes.dispatch('run-1','c1',async()=>e.observe({kind:'present',version:'v1'},e.exec('c1')))
    await expect(e.edit(e.exec('conversation'))).rejects.toMatchObject({code:'FS_NOT_OBSERVED'})
    await expect(e.write(e.exec('conversation'))).resolves.toEqual({kind:'createIfAbsent'})
  })
  it('registers ancestry at the execution boundary, live only while the call is',async()=>{
    const e=await events()
    let parent:symbol|undefined
    await e.scopes.dispatch('run-1','c1',async()=>{
      e.observe({kind:'present',version:'v1'},e.exec('c1'))
      const outer=e.exec('c1');parent=outer.token as symbol
      // The wrapper dispatches before emitting any fs event of its own.
      await e.execute(outer,async()=>{
        const nested=e.exec('nested',{parent})
        await e.execute(nested,async()=>e.observe({kind:'present',version:'v2'},nested))
        await expect(e.write(e.exec('deeper',{parent:nested.token}))).resolves.toEqual({kind:'replaceIfVersion',version:'v2'})
      })
    })
    await expect(e.write(e.exec('late',{parent}))).resolves.toEqual({kind:'replaceIfVersion',version:UNRECORDED_OBSERVATION})
  })
  it('a resumed run keeps its ledger in process; release and other runs start unseen',async()=>{
    const e=await events()
    await e.scopes.dispatch('run-1','c1',async()=>e.observe({kind:'present',version:'v1'},e.exec('c1')))
    await e.scopes.dispatch('run-1','c2',async()=>expect(await e.write(e.exec('c2'))).toEqual({kind:'replaceIfVersion',version:'v1'}))
    await e.scopes.dispatch('run-2','c3',async()=>expect(await e.write(e.exec('c3'))).toEqual({kind:'createIfAbsent'}))
    e.scopes.release('run-1')
    expect(e.scopes.holds('run-1')).toBe(false)
    await e.scopes.dispatch('run-1','c4',async()=>expect(await e.write(e.exec('c4'))).toEqual({kind:'createIfAbsent'}))
  })
  it('a call outliving its run release cannot resurrect the ledger',async()=>{
    const e=await events()
    let resume!:()=>void
    const running=e.scopes.dispatch('run-1','c1',()=>new Promise<void>(done=>{resume=done}))
    e.scopes.release('run-1')
    e.observe({kind:'present',version:'v1'},e.exec('c1'))
    resume();await running
    expect(e.scopes.holds('run-1')).toBe(false)
  })
  it('the conversation keeps its own observation across a run and hands back to the SDK on re-read',async()=>{
    const e=await events()
    e.ctx.emit('session/created',e.agent.session)
    e.observe({kind:'present',version:'v0'},e.exec('conversation'))
    await e.scopes.dispatch('run-1','c1',async()=>e.observe({kind:'present',version:'v1'},e.exec('c1')))
    await expect(e.write(e.exec('conversation'))).resolves.toEqual({kind:'replaceIfVersion',version:'v0'})
    e.observe({kind:'present',version:'v2'},e.exec('conversation'))
    await expect(e.write(e.exec('conversation'))).resolves.toEqual({kind:'replaceIfVersion',version:'v2'})
  })
  it.each(['before-host','after-host'] as const)('decides behind a pass-through wrapper loaded %s, which still wraps the decision',async wrapper=>{
    const e=await events({wrapper})
    e.ctx.emit('session/created',e.agent.session)
    // Desktop order: the conversation wrote the target, then a run finds it gone and creates it.
    e.observe({kind:'present',version:'v1'},e.exec('conversation'))
    await e.scopes.dispatch('run-1','c1',async()=>{
      await expect(e.execute(e.exec('c1'),()=>e.write(e.exec('c1')))).resolves.toEqual({kind:'createIfAbsent'})
      e.observe({kind:'present',version:'v2'},e.exec('c1'))
      await expect(e.edit(e.exec('c1'))).resolves.toEqual({version:'v2'})
    })
    expect(e.wrapped).toEqual([{kind:'createIfAbsent'},{version:'v2'}])
    await expect(e.write(e.exec('conversation'))).resolves.toEqual({kind:'replaceIfVersion',version:'v1'})
  })
  it('a dispatch under way keeps the successor it snapshotted when another call reseats',async()=>{
    let release!:()=>void
    const gate=new Promise<void>(done=>{release=done})
    // [wrapper, Host, foreign, policy]: the foreign decider is behind Host for this dispatch.
    const e=await events({foreign:true,policy:'after',wrapper:'after-host',gate:()=>gate})
    await e.scopes.dispatch('run-1','c1',async()=>{
      e.observe({kind:'present',version:'v1'},e.exec('c1'))
      const actor=e.exec('c1'),pending=[e.write(actor)]
      await e.execute(e.exec('c2'),async()=>undefined)
      // Overlapping dispatches by the same actor on the same target, snapshotted after the reseat;
      // the foreign decider answers writes only, so the edit is Host's.
      pending.push(e.write(actor),e.edit(actor))
      release()
      await expect(Promise.all(pending)).resolves.toEqual([{kind:'createIfAbsent'},{kind:'createIfAbsent'},{version:'v1'}])
    })
  })
  it('never rewrites a decision of a foreign decider holding the slot',async()=>{
    const e=await events({foreign:true})
    await e.scopes.dispatch('run-1','c1',async()=>{
      e.observe({kind:'present',version:'v1'},e.exec('c1'))
      await expect(e.write(e.exec('c1'))).resolves.toEqual({kind:'createIfAbsent'})
    })
  })
  it('a policy loaded after installation starts empty, so every conversation history is known',async()=>{
    const e=await events({policy:'after'})
    await e.scopes.dispatch('run-1','c1',async()=>e.observe({kind:'present',version:'v1'},e.exec('c1')))
    await expect(e.write(e.exec('conversation'))).resolves.toEqual({kind:'createIfAbsent'})
  })
  it('a reloaded policy cleared its state; the ledgers restart with it',async()=>{
    const e=await events({policy:'after'})
    await e.scopes.dispatch('run-1','c1',async()=>e.observe({kind:'present',version:'v1'},e.exec('c1')))
    await e.reloadPolicy()
    await e.scopes.dispatch('run-1','c2',async()=>expect(await e.write(e.exec('c2'))).toEqual({kind:'createIfAbsent'}))
  })
  it('a policy first seen behind a foreign decider was collecting all along; its removal resets nothing',async()=>{
    const e=await events({foreign:true})
    // Installed after this conversation started: its own read is recorded by both.
    e.observe({kind:'present',version:'v0'},e.exec('conversation'))
    await e.removeForeign()
    await e.scopes.dispatch('run-1','c1',async()=>e.observe({kind:'present',version:'v1'},e.exec('c1')))
    // A later external delete must still fail the conversation's stale v0, never create.
    await expect(e.write(e.exec('conversation'))).resolves.toEqual({kind:'replaceIfVersion',version:'v0'})
  })
  it('a policy replaced between run calls keeps the run ledger registered for the next call',async()=>{
    const e=await events({policy:'after'})
    await e.scopes.dispatch('run-1','c1',async()=>e.observe({kind:'present',version:'v1'},e.exec('c1')))
    await e.reloadPolicy()
    // This call took the run's ledger before its first event noticed the new policy.
    await e.scopes.dispatch('run-1','c2',async()=>e.observe({kind:'present',version:'v2'},e.exec('c2')))
    await e.scopes.dispatch('run-1','c3',async()=>expect(await e.write(e.exec('c3'))).toEqual({kind:'replaceIfVersion',version:'v2'}))
  })
  it('without the policy plugin, run calls keep the bare provider behavior',async()=>{
    const e=await events({policy:'none'})
    await e.scopes.dispatch('run-1','c1',async()=>{
      e.observe({kind:'present',version:'v1'},e.exec('c1'))
      await expect(e.write(e.exec('c1'))).resolves.toBeUndefined()
      await expect(e.edit(e.exec('c1'))).resolves.toBeUndefined()
    })
  })
})
