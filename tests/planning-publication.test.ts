import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowEditorState } from '../src/host/editor-state-store.ts'
import { makeWorkflow } from '../src/shared/types.ts'
import type { PlanningCommit } from '../src/host/planning/receipt.ts'

const directories:string[]=[],stores:WorkflowStorage[]=[]
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const commit=(value:unknown,key='task-1'):PlanningCommit=>({key:digest(key),digest:digest(value)})
function directory(){const path=mkdtempSync(join(tmpdir(),'workflow-planning-publication-'));directories.push(path);return path}
function storage(path=directory()){const store=new WorkflowStorage(path);stores.push(store);return store}
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true})})

describe('atomic planning publication receipts',()=>{
  it('persists a new graph and its exact candidate digest together and recovers both after reopening',()=>{
    const store=storage(),candidate=makeWorkflow('workspace','Generated workflow'),receipt=commit(candidate)
    const saved=store.save(candidate,0,'agent',receipt),expected={...receipt,kind:'created',workflowId:saved.id,revision:saved.revision}
    const disk=JSON.parse(readFileSync(join(store.directory,'library.json'),'utf8'))
    expect(disk.schema).toBe(2);expect(disk.workflows).toEqual([saved]);expect(disk.planningReceipts).toEqual([expected])
    expect(saved).not.toHaveProperty('planningReceipts');expect(store.planningReceipt(receipt.key)).toEqual(expected)
    store.planningReceipt(receipt.key)!.digest='0'.repeat(64)
    expect(store.planningReceipt(receipt.key)?.digest).toBe(receipt.digest)
    store.close();const reopened=storage(store.directory)
    expect(reopened.get(saved.id)).toEqual(saved);expect(reopened.planningReceipt(receipt.key)).toEqual(expected)
  })

  it('rejects repeated keys, including changed digests, without creating another graph or changing persisted data',()=>{
    const store=storage(),candidate=makeWorkflow('workspace'),receipt=commit(candidate)
    store.save(candidate,0,'agent',receipt)
    const before=readFileSync(join(store.directory,'library.json'),'utf8')
    for(const repeated of [receipt,{...receipt,digest:digest('different candidate')}])expect(()=>store.save(makeWorkflow('workspace'),0,'agent',repeated)).toThrow('提交已完成')
    expect(store.workflows()).toHaveLength(1);expect(store.planningReceipt(receipt.key)?.digest).toBe(receipt.digest)
    expect(readFileSync(join(store.directory,'library.json'),'utf8')).toBe(before)
    store.close();const reopened=storage(store.directory)
    expect(()=>reopened.save(makeWorkflow('workspace'),0,'agent',receipt)).toThrow('提交已完成');expect(reopened.workflows()).toHaveLength(1)
  })

  it('rejects malformed commits and noncreation revisions before mutating the library',()=>{
    const store=storage(),saved=store.save(makeWorkflow('workspace'),0),before=readFileSync(join(store.directory,'library.json'),'utf8')
    for(const invalid of [{key:'short',digest:digest('candidate')},{key:digest('key'),digest:'invalid'},{...commit('candidate'),extra:true}])expect(()=>store.save(makeWorkflow('workspace'),0,'agent',invalid)).toThrow()
    expect(()=>store.save({...saved,title:'edit'},saved.revision,'agent',commit(saved))).toThrow('版本无效')
    expect(readFileSync(join(store.directory,'library.json'),'utf8')).toBe(before);expect(store.planningReceipt(digest('task-1'))).toBeUndefined()
  })

  it('opens existing schema 2 without receipts and adds a receipt without changing existing workflows',()=>{
    const path=directory(),prior={...makeWorkflow('workspace','Existing'),revision:1}
    writeFileSync(join(path,'library.json'),JSON.stringify({schema:2,workflows:[prior],presets:[]}))
    writeFileSync(join(path,'editor-state.json'),JSON.stringify({proposals:[],drafts:[]}))
    const store=storage(path),editor=new WorkflowEditorState(store)
    expect(store.planningReceipt(digest('absent'))).toBeUndefined();expect(editor.planningReceipt(digest('absent'))).toBeUndefined()
    const candidate=makeWorkflow('workspace','New'),receipt=commit(candidate);store.save(candidate,0,'agent',receipt)
    expect(store.get(prior.id)).toEqual(prior);expect(store.workflows()).toHaveLength(2)
    expect(JSON.parse(readFileSync(join(path,'library.json'),'utf8')).schema).toBe(2)
  })

  it('does not treat an existing revision-zero identity as a fresh planning creation',()=>{
    const path=directory(),existing=makeWorkflow('workspace','Existing zero revision'),original=JSON.stringify({schema:2,workflows:[existing],presets:[]})
    writeFileSync(join(path,'library.json'),original)
    const store=storage(path),receipt=commit(existing)
    for(const candidate of [existing,{...existing,title:'Overwrite'}])expect(()=>store.save(candidate,0,'agent',receipt)).toThrow('全新的工作流身份')
    expect(store.get(existing.id)).toEqual(existing);expect(store.planningReceipt(receipt.key)).toBeUndefined()
    expect(readFileSync(join(path,'library.json'),'utf8')).toBe(original)
  })

  it('persists a pending proposal and receipt together while leaving the saved workflow unchanged',()=>{
    const store=storage(),saved=store.save(makeWorkflow('workspace','Original'),0),editor=new WorkflowEditorState(store)
    const candidate={...saved,title:'Proposed'},receipt=commit(candidate),proposal=editor.propose(candidate,saved.revision,receipt)
    const expected={...receipt,kind:'proposed',workflowId:saved.id,revision:saved.revision,proposalId:proposal.id}
    const disk=JSON.parse(readFileSync(join(store.directory,'editor-state.json'),'utf8'))
    expect(disk.proposals).toEqual([proposal]);expect(disk.planningReceipts).toEqual([expected]);expect(store.get(saved.id)).toEqual(saved)
    store.close();const reopened=storage(store.directory),reopenedEditor=new WorkflowEditorState(reopened)
    expect(reopenedEditor.proposals(saved.id)).toEqual([proposal]);expect(reopenedEditor.planningReceipt(receipt.key)).toEqual(expected)
    expect(reopened.planningReceipt(receipt.key)).toBeUndefined()
  })

  it('rejects repeated proposal keys and keeps the original proposal and digest after restart',()=>{
    const store=storage(),saved=store.save(makeWorkflow('workspace'),0),editor=new WorkflowEditorState(store),candidate={...saved,title:'Proposal'},receipt=commit(candidate)
    const proposal=editor.propose(candidate,saved.revision,receipt),before=readFileSync(join(store.directory,'editor-state.json'),'utf8')
    for(const repeated of [receipt,{...receipt,digest:digest('changed')}])expect(()=>editor.propose({...candidate,title:'Another'},saved.revision,repeated)).toThrow('提交已完成')
    expect(editor.proposals(saved.id)).toEqual([proposal]);expect(readFileSync(join(store.directory,'editor-state.json'),'utf8')).toBe(before)
    const reopened=new WorkflowEditorState(store)
    expect(()=>reopened.propose(candidate,saved.revision,receipt)).toThrow('提交已完成');expect(reopened.planningReceipt(receipt.key)?.digest).toBe(receipt.digest)
  })

  it.each(['accept','reject'] as const)('preserves the publication receipt when a proposal is %sed',decision=>{
    const store=storage(),saved=store.save(makeWorkflow('workspace','Original'),0),editor=new WorkflowEditorState(store),candidate={...saved,title:'Proposed'},receipt=commit(candidate)
    const proposal=editor.propose(candidate,saved.revision,receipt),originalReceipt=editor.planningReceipt(receipt.key)
    editor.resolve(proposal.id,decision,saved.revision)
    expect(editor.planningReceipt(receipt.key)).toEqual(originalReceipt)
    store.close();const reopened=storage(store.directory),reopenedEditor=new WorkflowEditorState(reopened)
    expect(reopenedEditor.planningReceipt(receipt.key)).toEqual(originalReceipt)
    expect(reopenedEditor.proposals(saved.id)[0]!.status).toBe(decision==='accept'?'accepted':'rejected')
    expect(reopened.get(saved.id).title).toBe(decision==='accept'?'Proposed':'Original')
    expect(()=>reopenedEditor.propose(reopened.get(saved.id),reopened.get(saved.id).revision,receipt)).toThrow('提交已完成')
  })
})
