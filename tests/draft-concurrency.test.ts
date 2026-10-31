import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowEditorState } from '../src/host/editor-state-store.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowStore } from '../src/client/store.ts'
import { makeWorkflow, type WorkflowAPI, type WorkflowDraft } from '../src/shared/types.ts'

const paths:string[]=[],stores:WorkflowStore[]=[]
afterEach(async()=>{for(const store of stores.splice(0))store.dispose();await tick();for(const path of paths.splice(0))rmSync(path,{recursive:true,force:true});vi.useRealTimers()})
async function tick(){for(let i=0;i<12;i++)await Promise.resolve()}
function setup(){
  const path=mkdtempSync(join(tmpdir(),'workflow-draft-cas-'));paths.push(path)
  const storage=new WorkflowStorage(path),flow=storage.save(makeWorkflow('workspace','Preserved workflow',true),0),editor=new WorkflowEditorState(storage)
  const base:WorkflowDraft={id:'draft',workflowId:flow.id,workspaceId:flow.workspaceId,sessionId:'session',kind:'editor',payload:{generateDraft:'original'},revision:0,updatedAt:'legacy-date'}
  return{path,storage,flow,editor,base,file:join(path,'editor-state.json')}
}
function client(f:ReturnType<typeof setup>){
  const api={drafts:vi.fn(async(id,session)=>f.editor.drafts(id,session)),saveDraft:vi.fn(async(json,revision)=>f.editor.saveDraft(JSON.parse(json),revision)),removeDraft:vi.fn(async(id,revision)=>f.editor.removeDraft(id,revision))} as unknown as WorkflowAPI
  const store=new WorkflowStore(api);stores.push(store);store.update({workflow:f.flow,sessionId:'session',loading:false})
  return{store,api}
}

describe('editor draft optimistic concurrency',()=>{
  it('round trips the native requirement identity through the real Host draft validator',async()=>{
    const f=setup(),{store}=client(f)
    await tick()
    store.update({generateDraft:'持久保留的需求',generateTargetId:f.flow.id,generateRequestId:'stable-request-id'})
    await store.flushDraft()
    const saved=new WorkflowEditorState(f.storage).drafts(f.flow.id,'session')[0]!
    expect(saved.payload).toMatchObject({generateDraft:'持久保留的需求',generateRequestId:'stable-request-id',generateTargetId:f.flow.id})
    expect(()=>f.editor.saveDraft({...saved,payload:{generateRequestId:{not:'an identity'}}},saved.revision)).toThrow('需求草稿身份无效')
    expect(store.getSnapshot().draftSaveState).toBe('saved')
  })
  it('upgrades old on-disk drafts in memory and preserves workflow, timestamp and file bytes on read',()=>{
    const f=setup(),{revision:_,...legacy}=f.base,bytes=JSON.stringify({proposals:[],drafts:[legacy]})
    writeFileSync(f.file,bytes)
    const restored=new WorkflowEditorState(f.storage).drafts(f.flow.id,'session')[0]!
    expect(restored).toEqual({...legacy,revision:1});expect(readFileSync(f.file,'utf8')).toBe(bytes)
    expect(f.storage.get(f.flow.id)).toEqual(f.flow)
  })
  it('advances accepted writes, rejects stale edits/deletes and never rewrites unchanged content',()=>{
    const f=setup(),first=f.editor.saveDraft(f.base,0)
    expect(first.revision).toBe(1)
    const bytes=readFileSync(f.file,'utf8'),mtime=statSync(f.file).mtimeMs
    expect(f.editor.saveDraft({...first,updatedAt:'different'},1)).toEqual(first)
    expect(readFileSync(f.file,'utf8')).toBe(bytes);expect(statSync(f.file).mtimeMs).toBe(mtime)
    const second=f.editor.saveDraft({...first,payload:{generateDraft:'newer'}},1),accepted=readFileSync(f.file,'utf8')
    expect(second.revision).toBe(2)
    expect(()=>f.editor.saveDraft({...first,payload:{generateDraft:'stale'}},1)).toThrow('其他窗口')
    expect(()=>f.editor.removeDraft(first.id,1)).toThrow('不能清除')
    expect(readFileSync(f.file,'utf8')).toBe(accepted)
    f.editor.removeDraft(second.id,2);expect(f.editor.drafts(f.flow.id,'session')).toEqual([])
    expect(()=>f.editor.saveDraft({...second,payload:{generateDraft:'stale resurrection'}},2)).toThrow('其他窗口')
    expect(f.storage.get(f.flow.id)).toEqual(f.flow)
  })
  it('cannot bypass the scope revision by creating another draft ID or omitting expectedRevision',()=>{
    const f=setup();f.editor.saveDraft(f.base,0)
    expect(()=>f.editor.saveDraft({...f.base,id:'other'},0)).toThrow('其他窗口')
    for(const revision of [undefined,NaN,-1,0.5])expect(()=>f.editor.saveDraft(f.base,revision as number)).toThrow('其他窗口')
    expect(f.editor.drafts(f.flow.id,'session')).toHaveLength(1)
    const restarted=new WorkflowEditorState(f.storage)
    expect(restarted.saveDraft({...f.base,payload:{generateDraft:'after restart'}},1).revision).toBe(2)
  })
  it('retains the losing client text on a stale write and fast navigation without replacing the winner',async()=>{
    const f=setup();f.editor.saveDraft(f.base,0)
    const a=client(f),b=client(f);await tick()
    a.store.update({generateDraft:'winner'});await a.store.flushDraft()
    b.store.update({generateDraft:'local unsaved'});await expect(b.store.flushDraft()).rejects.toThrow('其他窗口')
    expect(b.store.getSnapshot()).toMatchObject({generateDraft:'local unsaved',draftSaveState:'error'})
    b.store.update({sessionId:'away'});b.store.update({sessionId:'session'});b.store.update({sessionId:'away'});await tick()
    b.store.update({sessionId:'session'});await tick()
    expect(b.store.getSnapshot()).toMatchObject({generateDraft:'local unsaved',draftSaveState:'error'})
    expect(f.editor.drafts(f.flow.id,'session')[0]).toMatchObject({revision:2,payload:{generateDraft:'winner'}})
    expect(f.storage.get(f.flow.id)).toEqual(f.flow)
  })
  it('does not allow stale clearing or reverting to the old baseline to conceal a conflict',async()=>{
    const f=setup();f.editor.saveDraft(f.base,0)
    const a=client(f),b=client(f);await tick()
    a.store.update({generateDraft:'winner'});await a.store.flushDraft()
    b.store.update({generateDraft:undefined});await expect(b.store.flushDraft()).rejects.toThrow('不能清除')
    b.store.update({generateDraft:'original'});await expect(b.store.flushDraft()).rejects.toThrow('其他窗口')
    expect(b.store.getSnapshot().draftSaveState).toBe('error')
    expect(f.editor.drafts(f.flow.id,'session')[0]!.payload).toEqual({generateDraft:'winner'})
  })
  it('serializes fast edits with the latest acknowledged revision including a return to the old text',async()=>{
    const f=setup();f.editor.saveDraft(f.base,0)
    const {store,api}=client(f);await tick()
    store.update({generateDraft:'intermediate'});const first=store.flushDraft()
    store.update({generateDraft:'original'});const second=store.flushDraft()
    await Promise.all([first,second])
    expect(vi.mocked(api.saveDraft!).mock.calls.map(call=>call[1])).toEqual([1,2])
    expect(f.editor.drafts(f.flow.id,'session')[0]).toMatchObject({revision:3,payload:{generateDraft:'original'}})
    expect(store.getSnapshot().draftSaveState).toBe('saved')
  })
  it('uses a fresh identity after clearing and can save again without resurrecting the deleted revision',async()=>{
    const f=setup();f.editor.saveDraft(f.base,0)
    const {store}=client(f);await tick()
    store.update({generateDraft:undefined});await store.flushDraft()
    store.update({generateDraft:'new draft'});await store.flushDraft()
    const saved=f.editor.drafts(f.flow.id,'session')[0]!
    expect(saved.id).not.toBe(f.base.id);expect(saved.revision).toBe(1);expect(saved.payload).toEqual({generateDraft:'new draft'})
  })
})
