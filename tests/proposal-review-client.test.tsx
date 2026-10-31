import React, { useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowEditorState } from '../src/host/editor-state-store.ts'
import { WorkflowStore, useWorkflowStore } from '../src/client/store.ts'
import { ProposalReview } from '../src/client/proposal-review.tsx'
import { ProposalNotice } from '../src/client/proposal-notice.tsx'
import { makeWorkflow, type Workflow, type WorkflowAPI, type WorkflowProposal } from '../src/shared/types.ts'
import { getSavePreferences, setSavePreferences } from '../src/client/save-preferences.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Modal:({children,...props}:any)=><modal-mock {...props}>{children}</modal-mock>}))
vi.mock('../src/client/data-viewer.tsx',()=>({DataViewer:({title}:any)=><data-viewer title={title}/>}))
const resources:{storage:WorkflowStorage;store:WorkflowStore;path:string}[]=[],renderers:ReactTestRenderer[]=[]
const originalPreferences={...getSavePreferences()}
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount());for(const {storage,store,path} of resources.splice(0)){store.dispose();storage.close();rmSync(path,{recursive:true,force:true})}setSavePreferences(originalPreferences);vi.useRealTimers()})
async function fixture(){
  const path=mkdtempSync(join(tmpdir(),'workflow-proposal-client-')),storage=new WorkflowStorage(path),editor=new WorkflowEditorState(storage)
  const flow=storage.save({...makeWorkflow('workspace','Original',true),editor:{viewport:{x:32,y:40,scale:1},scopePath:[]}},0)
  const proposal=editor.propose({...structuredClone(flow),title:'Accepted title'},flow.revision)
  const api={get:vi.fn(async(id:string)=>storage.get(id)),save:vi.fn(async(raw:string,revision:number)=>storage.save(JSON.parse(raw),revision)),proposals:vi.fn(async(id:string)=>editor.proposals(id)),resolveProposal:vi.fn(async(id:string,action:'accept'|'reject',revision:number)=>editor.resolve(id,action,revision))} as unknown as WorkflowAPI
  const store=new WorkflowStore(api);resources.push({storage,store,path})
  store.update({workflow:flow,loading:false,page:'canvas',library:{workflows:[flow],presets:[],workspaces:[],runs:[]}})
  await store.refreshProposals()
  return {storage,editor,store,flow,proposal,api}
}
async function render(store:WorkflowStore){
  const close=vi.fn()
  function Review(){const state=useWorkflowStore(store),[open,setOpen]=useState(true);return <><ProposalNotice count={state.proposals?.filter(p=>p.status==='pending').length??0} onReview={()=>setOpen(true)}/>{open&&<ProposalReview store={store} onClose={()=>{close();setOpen(false)}}/>}</>}
  let renderer!:ReactTestRenderer;await act(async()=>{renderer=create(<Review/>)});renderers.push(renderer)
  return {renderer,close}
}
function button(renderer:ReactTestRenderer,label:string){return renderer.root.findAllByType('button').find(b=>b.children.includes(label))!}
async function click(renderer:ReactTestRenderer,label:string){await act(async()=>{button(renderer,label).props.onClick()})}
const notices=(renderer:ReactTestRenderer)=>renderer.root.findAllByProps({className:'vdw-proposal-notice-card'})

describe('review completion follows the Host mutation receipt',()=>{
  it.each(['accept','reject'] as const)('closes review and removes the sole notice after %s',async action=>{
    const f=await fixture(),{renderer,close}=await render(f.store)
    await click(renderer,action==='accept'?'接受并应用':'拒绝修改')
    expect(close).toHaveBeenCalledOnce();expect(renderer.root.findAllByType('modal-mock')).toHaveLength(0);expect(notices(renderer)).toHaveLength(0)
    expect(f.editor.proposals(f.flow.id)[0]?.status).toBe(action==='accept'?'accepted':'rejected')
    expect(f.store.getSnapshot().workflow?.title).toBe(action==='accept'?'Accepted title':'Original')
  })

  it('preserves pan/zoom while accepting instead of making its own version conflict',async()=>{
    const f=await fixture(),{renderer,close}=await render(f.store),viewport={x:600,y:-300,scale:.5}
    act(()=>f.store.update({viewport}))
    await click(renderer,'接受并应用')
    expect(close).toHaveBeenCalledOnce();expect(notices(renderer)).toHaveLength(0)
    expect(f.store.getSnapshot().workflow).toMatchObject({title:'Accepted title',revision:2,editor:{viewport}})
    expect(f.storage.get(f.flow.id).editor?.viewport).toEqual(viewport)
  })

  it('keeps the dialog and request when the actual definition changed',async()=>{
    const f=await fixture(),{renderer,close}=await render(f.store)
    f.storage.save({...f.flow,description:'Concurrent edit'},f.flow.revision)
    await click(renderer,'接受并应用')
    expect(close).not.toHaveBeenCalled();expect(notices(renderer)).toHaveLength(1)
    expect(JSON.stringify(renderer.toJSON())).toContain('过期')
    expect(f.editor.proposals(f.flow.id)[0]?.status).toBe('pending')
  })

  it('does not save local definition edits as a side effect of accepting or rejecting',async()=>{
    const f=await fixture(),{renderer,close}=await render(f.store)
    act(()=>f.store.edit({...f.store.getSnapshot().workflow!,description:'Unsaved edit'}))
    await click(renderer,'接受并应用')
    expect(close).not.toHaveBeenCalled();expect(f.api.resolveProposal).not.toHaveBeenCalled();expect(f.api.save).not.toHaveBeenCalled()
    expect(JSON.stringify(renderer.toJSON())).toContain('未保存的流程修改')
    await click(renderer,'拒绝修改')
    expect(close).toHaveBeenCalledOnce();expect(f.api.save).not.toHaveBeenCalled();expect(f.store.getSnapshot().workflow?.description).toBe('Unsaved edit')
  })

  it('uses the accepted candidate without a second get and closes even if refreshing the list fails',async()=>{
    const f=await fixture(),{renderer,close}=await render(f.store)
    vi.mocked(f.api.get).mockRejectedValue(new Error('get unavailable'))
    vi.mocked(f.api.proposals!).mockRejectedValueOnce(new Error('list unavailable'))
    await click(renderer,'接受并应用')
    expect(close).toHaveBeenCalledOnce();expect(f.api.get).not.toHaveBeenCalled();expect(notices(renderer)).toHaveLength(0)
    expect(f.store.getSnapshot().workflow?.title).toBe('Accepted title')
    expect(f.store.getSnapshot().proposals?.[0]?.status).toBe('accepted')
  })

  it('cannot resurrect a pending card from a response started before acceptance',async()=>{
    const f=await fixture(),{renderer}=await render(f.store)
    let release!:(proposals:WorkflowProposal[])=>void
    vi.mocked(f.api.proposals!).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
    const old=f.store.refreshProposals()
    await click(renderer,'接受并应用')
    await act(async()=>{release([f.proposal]);await old})
    expect(notices(renderer)).toHaveLength(0);expect(f.store.getSnapshot().proposals?.[0]?.status).toBe('accepted')
  })

  it('closes immediately after the commit even while the following list read is stalled',async()=>{
    const f=await fixture(),{renderer,close}=await render(f.store)
    vi.mocked(f.api.proposals!).mockImplementationOnce(()=>new Promise(()=>{}))
    await click(renderer,'接受并应用')
    expect(close).toHaveBeenCalledOnce();expect(notices(renderer)).toHaveLength(0)
    expect(f.store.getSnapshot().workflow?.title).toBe('Accepted title')
  })

  it('closes this review while retaining the notice for a different pending proposal',async()=>{
    const f=await fixture(),other=f.editor.propose({...f.flow,description:'Another request'},f.flow.revision)
    await f.store.refreshProposals();const {renderer,close}=await render(f.store)
    await click(renderer,'拒绝修改')
    expect(close).toHaveBeenCalledOnce();expect(notices(renderer)).toHaveLength(1)
    expect(f.store.getSnapshot().proposals?.filter(p=>p.status==='pending').map(p=>p.id)).toEqual([other.id])
  })

  it('enables a request only at the exact view-only revision verified by Host',async()=>{
    const f=await fixture(),current=f.storage.save({...f.flow,editor:{viewport:{x:4,y:5,scale:.8}}},f.flow.revision)
    f.store.update({workflow:current,viewport:current.editor!.viewport!});await f.store.refreshProposals()
    const {renderer,close}=await render(f.store)
    expect(button(renderer,'接受并应用').props.disabled).toBeFalsy()
    await click(renderer,'接受并应用');expect(close).toHaveBeenCalledOnce()
  })

  it('keeps the Agent baseline through repeated timed autosaves and advances it only for real edits',async()=>{
    vi.useFakeTimers();setSavePreferences({mode:'auto',intervalMinutes:1})
    const f=await fixture()
    for(const x of [100,200]){
      f.store.update({viewport:{x,y:40,scale:.8}})
      await vi.advanceTimersByTimeAsync(60_000)
      expect(f.store.getSnapshot().workflow?.revision).toBe(f.flow.revision)
      expect(f.storage.get(f.flow.id).revision).toBe(f.flow.revision)
    }
    expect(f.api.save).toHaveBeenCalledTimes(2)
    const changed=structuredClone(f.store.getSnapshot().workflow!);changed.nodes[1]!.config.text='Actual change'
    f.store.edit(changed);await vi.advanceTimersByTimeAsync(60_000)
    expect(f.storage.get(f.flow.id).revision).toBe(f.flow.revision+1)
    await expect(f.store.resolveProposal(f.proposal.id,'accept')).rejects.toThrow('过期')
    expect(f.editor.proposals(f.flow.id)[0]?.status).toBe('pending')
  })
})
