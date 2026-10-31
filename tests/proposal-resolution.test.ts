import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowEditorState } from '../src/host/editor-state-store.ts'
import { makeWorkflow, type Workflow } from '../src/shared/types.ts'

const resources:{storage:WorkflowStorage;path:string}[]=[]
afterEach(()=>{for(const {storage,path} of resources.splice(0)){storage.close();rmSync(path,{recursive:true,force:true})}})
function fixture(){
  const path=mkdtempSync(join(tmpdir(),'workflow-proposal-')),storage=new WorkflowStorage(path)
  const resource={storage,path};resources.push(resource)
  const original=makeWorkflow('workspace','Original',true)
  original.editor={viewport:{x:32,y:40,scale:1},scopePath:[]}
  const flow=storage.save(original,0),editor=new WorkflowEditorState(storage),candidate={...structuredClone(flow),title:'Accepted title'},proposal=editor.propose(candidate,flow.revision)
  return {path,storage,flow,editor,candidate,proposal,resource}
}
// Reproduce a version written by the installed build before view-only saves
// stopped advancing revisions. Only this test's closed temporary store is edited.
function legacyViewSave(f:ReturnType<typeof fixture>,editor:Workflow['editor']){
  const file=join(f.path,'library.json'),library=JSON.parse(readFileSync(file,'utf8'))
  const current={...f.storage.get(f.flow.id),editor,revision:f.flow.revision+1}
  f.storage.close();library.workflows=[current];writeFileSync(file,JSON.stringify(library))
  f.storage=new WorkflowStorage(f.path);f.resource.storage=f.storage;f.editor=new WorkflowEditorState(f.storage)
  return current
}

describe('proposal resolution and view-only revisions',()=>{
  it('accepts across saved pan/zoom/scope changes and preserves the current view',()=>{
    const f=fixture(),view={viewport:{x:720,y:-100,scale:.5},scopePath:[]}
    const current=legacyViewSave(f,view)
    expect(f.editor.proposals(f.flow.id)[0]).toMatchObject({canAcceptAtRevision:current.revision,status:'pending'})
    const result=f.editor.resolve(f.proposal.id,'accept',current.revision)
    expect(result.status).toBe('accepted');expect(result.candidate.title).toBe('Accepted title')
    expect(result.candidate.editor).toEqual(view)
    expect(f.editor.proposals(f.flow.id).filter(p=>p.status==='pending')).toEqual([])
    const saved=f.storage.get(f.flow.id)
    expect(f.editor.resolve(f.proposal.id,'accept',saved.revision)).toEqual(result)
    expect(f.storage.get(f.flow.id)).toEqual(saved)
  })

  const edits:[string,(flow:Workflow)=>void][]=[
    ['node configuration',flow=>{flow.nodes[1]!.config.text='concurrent text'}],
    ['node positions',flow=>{flow.nodes[1]!.x+=40}],
    ['fixed nodes',flow=>{flow.nodes[1]!.fixed=true}],
    ['execution policy',flow=>{flow.executionPolicy={tokenBudget:10000}}],
    ['environment',flow=>{flow.environmentVariables=[{id:'region',name:'REGION',type:'string',value:'new'}]}],
    ['annotations',flow=>{flow.editor={...flow.editor,annotations:[{id:'note',number:1,text:'New review note',nodeIds:[]}]}}],
  ]
  it.each(edits)('keeps a pending proposal on a real %s conflict',(_name,edit)=>{
    const f=fixture(),changed=structuredClone(f.flow);edit(changed)
    const current=f.storage.save(changed,f.flow.revision)
    expect(f.editor.proposals(f.flow.id)[0]?.canAcceptAtRevision).toBeUndefined()
    expect(()=>f.editor.resolve(f.proposal.id,'accept',current.revision)).toThrow('过期')
    expect(f.storage.get(f.flow.id)).toEqual(current)
    expect(f.editor.proposals(f.flow.id)[0]?.status).toBe('pending')
  })

  it('does not accept an older viewed revision even when all intervening saves only moved the view',()=>{
    const f=fixture(),current=legacyViewSave(f,{viewport:{x:1,y:2,scale:.8}})
    expect(()=>f.editor.resolve(f.proposal.id,'accept',f.flow.revision)).toThrow('过期')
    expect(f.storage.get(f.flow.id)).toEqual(current)
  })

  it('recovers a prior request only from an exact Host planning baseline',()=>{
    const f=fixture(),file=join(f.path,'editor-state.json'),state=JSON.parse(readFileSync(file,'utf8'))
    expect(f.editor.needsPlanningBase(f.proposal.id)).toBe(false)
    delete state.proposals[0].baseDefinitionDigest
    writeFileSync(file,JSON.stringify(state))
    const current=legacyViewSave(f,{viewport:{x:100,y:200,scale:.5}})
    const unknown=new WorkflowEditorState(f.storage)
    expect(unknown.proposals(f.flow.id)[0]?.canAcceptAtRevision).toBeUndefined()
    expect(()=>unknown.resolve(f.proposal.id,'accept',current.revision)).toThrow('过期')
    const wrong=new WorkflowEditorState(f.storage,()=>({...f.flow,id:'unrelated'}))
    expect(wrong.proposals(f.flow.id)[0]?.canAcceptAtRevision).toBeUndefined()
    const recovered=new WorkflowEditorState(f.storage,proposal=>proposal.id===f.proposal.id?f.flow:undefined)
    expect(recovered.needsPlanningBase(f.proposal.id)).toBe(true)
    expect(recovered.proposals(f.flow.id)[0]?.canAcceptAtRevision).toBe(current.revision)
    expect(recovered.resolve(f.proposal.id,'accept',current.revision).status).toBe('accepted')
    expect(recovered.needsPlanningBase(f.proposal.id)).toBe(false)
  })

  it('keeps the baseline comparison after Host restart',()=>{
    const f=fixture(),current=legacyViewSave(f,{viewport:{x:3,y:4,scale:1.2}})
    const reopened=new WorkflowEditorState(f.storage)
    expect(reopened.proposals(f.flow.id)[0]?.canAcceptAtRevision).toBe(current.revision)
    expect(reopened.resolve(f.proposal.id,'accept',current.revision).candidate.editor).toEqual(current.editor)
  })

  it('persists view-only autosaves without advancing the definition revision or date',()=>{
    const f=fixture(),view={viewport:{x:500,y:600,scale:.4},scopePath:[]}
    const saved=f.storage.save({...f.flow,editor:view},f.flow.revision)
    expect(saved.revision).toBe(f.flow.revision);expect(saved.updatedAt).toBe(f.flow.updatedAt)
    expect(f.storage.get(f.flow.id).editor).toEqual(view)
    expect(f.storage.save(saved,saved.revision)).toEqual(saved)
    const edited=f.storage.save({...saved,description:'Real content edit'},saved.revision)
    expect(edited.revision).toBe(saved.revision+1)
  })
})
