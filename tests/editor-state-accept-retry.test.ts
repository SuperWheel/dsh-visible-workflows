import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowEditorState } from '../src/host/editor-state-store.ts'
import { makeWorkflow } from '../src/shared/types.ts'

const directories:string[]=[],stores:WorkflowStorage[]=[]
afterEach(()=>{vi.restoreAllMocks();for(const store of stores.splice(0))store.close();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true})})
const open=(directory:string)=>{const storage=new WorkflowStorage(directory);stores.push(storage);return storage}
function failedAcceptance(){
  const directory=mkdtempSync(join(tmpdir(),'editor-accept-retry-'));directories.push(directory)
  const storage=open(directory),flow=storage.save(makeWorkflow('workspace','Original title',true),0),editor=new WorkflowEditorState(storage)
  const proposal=editor.propose({...structuredClone(flow),title:'Accepted title'},flow.revision)
  const save=vi.spyOn(storage,'saveReviewedCandidate')
  const persist=vi.spyOn(editor as unknown as {persist:(next:unknown)=>void},'persist').mockImplementationOnce(()=>{throw new Error('injected editor persistence failure')})
  expect(()=>editor.resolve(proposal.id,'accept',flow.revision)).toThrow('injected editor persistence failure')
  persist.mockRestore()
  expect(save).toHaveBeenCalledTimes(1)
  expect(storage.get(flow.id)).toMatchObject({title:'Accepted title',revision:flow.revision+1})
  expect(editor.proposals(flow.id)[0]?.status).toBe('pending')
  expect(JSON.parse(readFileSync(join(directory,'editor-state.json'),'utf8')).proposals[0].status).toBe('pending')
  return {directory,storage,flow,editor,proposal,save}
}

describe('retrying acceptance after editor-state persistence failure',()=>{
  it.each(['latest','base'] as const)('finishes acceptance using the %s revision without saving the definition again',revisionSource=>{
    const f=failedAcceptance(),prior=f.storage.get(f.flow.id),library=readFileSync(join(f.directory,'library.json'))
    const revision=revisionSource==='latest'?prior.revision:f.proposal.baseRevision
    const result=f.editor.resolve(f.proposal.id,'accept',revision)
    expect(result).toMatchObject({status:'accepted',candidate:prior})
    expect(f.save).toHaveBeenCalledTimes(1)
    expect(f.storage.get(f.flow.id).revision).toBe(f.flow.revision+1)
    expect(readFileSync(join(f.directory,'library.json'))).toEqual(library)
    expect(new WorkflowEditorState(f.storage).proposals(f.flow.id)[0]).toEqual(result)
    expect(f.editor.resolve(f.proposal.id,'accept',revision)).toEqual(result)
  })

  it('recovers after a storage restart and retains the latest saved viewport',()=>{
    const f=failedAcceptance(),prior=f.storage.get(f.flow.id)
    const viewed=f.storage.save({...prior,editor:{...prior.editor,viewport:{x:500,y:600,scale:.5},scopePath:[]}},prior.revision)
    f.storage.close()
    const storage=open(f.directory),editor=new WorkflowEditorState(storage),save=vi.spyOn(storage,'saveReviewedCandidate')
    const result=editor.resolve(f.proposal.id,'accept',viewed.revision)
    expect(result).toMatchObject({status:'accepted',candidate:viewed})
    expect(storage.get(f.flow.id)).toEqual(viewed)
    expect(storage.get(f.flow.id).revision).toBe(f.flow.revision+1)
    expect(save).not.toHaveBeenCalled()
  })

  it('still rejects an unrelated caller revision even when the candidate is already saved',()=>{
    const f=failedAcceptance(),prior=f.storage.get(f.flow.id)
    expect(()=>f.editor.resolve(f.proposal.id,'accept',prior.revision+1)).toThrow('提案基础版本已过期')
    expect(f.editor.proposals(f.flow.id)[0]?.status).toBe('pending')
    expect(f.storage.get(f.flow.id)).toEqual(prior)
    expect(f.save).toHaveBeenCalledTimes(1)
  })

  it.each(['latest','base'] as const)('still rejects the %s revision after a real concurrent definition edit',revisionSource=>{
    const f=failedAcceptance(),prior=f.storage.get(f.flow.id),current=f.storage.save({...prior,title:'Concurrent edit'},prior.revision)
    expect(()=>f.editor.resolve(f.proposal.id,'accept',revisionSource==='latest'?current.revision:f.proposal.baseRevision)).toThrow('提案基础版本已过期')
    expect(f.editor.proposals(f.flow.id)[0]?.status).toBe('pending')
    expect(f.storage.get(f.flow.id)).toEqual(current)
    expect(f.save).toHaveBeenCalledTimes(1)
  })
})
