import {afterEach,describe,expect,it} from 'vitest'
import {existsSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {WorkflowStorage} from '../src/host/storage.ts'
import {makeWorkflow,type WorkflowRun} from '../src/shared/types.ts'
const directories:string[]=[],stores:WorkflowStorage[]=[]
const temporary=()=>{const directory=mkdtempSync(join(tmpdir(),'storage-lifecycle-'));directories.push(directory);return directory}
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true})})
const graph=makeWorkflow('test')
const run=(index:number,status:WorkflowRun['status']='success'):WorkflowRun=>({id:randomUUID(),workflowId:graph.id,workspaceId:graph.workspaceId,workflowTitle:graph.title,sourceRevision:graph.revision,graph,status,inputs:{},outputs:{},executions:[],startedAt:new Date(Date.UTC(2026,0,1)+index*1000).toISOString()})
const open=()=>{const store=new WorkflowStorage(temporary());stores.push(store);return store}
const upload=(store:WorkflowStorage,id:string)=>store.stageAttachment(id,{name:'file.txt',base64:Buffer.from('retained content').toString('base64')}) as {workflowFileId:string}
describe('storage ownership and retained attachment lifecycle',()=>{
  it('serializes two real stale-lock recovery processes and preserves the live winner',async()=>{
    const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/storage-lock-recovery.mjs',import.meta.url).pathname],{timeout:15000})
    expect(JSON.parse(stdout)).toMatchObject({singleOwner:true,liveOwnerPreserved:true})
  },20000)
  it('fails closed for a leftover recovery gate and does not remove it',()=>{
    const directory=temporary(),gate=join(directory,'host.lock.recovery');writeFileSync(gate,'interrupted recovery')
    expect(()=>new WorkflowStorage(directory)).toThrow('确认无 Host 正在恢复');expect(readFileSync(gate,'utf8')).toBe('interrupted recovery')
  })
  it('evicts only finished runs and their files, keeping active/recent attachments and external symlink targets',()=>{
    const store=open(),old=run(0),active=run(-1,'running'),recent=run(1)
    for(const value of [old,active,recent])store.saveRun(value)
    const oldFile=upload(store,old.id),activeFile=upload(store,active.id),recentFile=upload(store,recent.id)
    const external=temporary(),sentinel=join(external,'sentinel.txt');writeFileSync(sentinel,'keep')
    symlinkSync(external,join(store.directory,'attachments',old.id,'external-directory'))
    symlinkSync(sentinel,join(store.directory,'attachments',old.id,'external-file'))
    for(let i=2;i<=200;i++)store.saveRun(run(i))
    expect(store.runs()).toHaveLength(201)
    for(const suffix of ['.json','.events.jsonl'])expect(existsSync(join(store.directory,'runs',old.id+suffix))).toBe(false)
    expect(existsSync(join(store.directory,'attachments',old.id))).toBe(false)
    expect(readFileSync(sentinel,'utf8')).toBe('keep')
    expect(store.readAttachment(active.id,activeFile.workflowFileId).name).toBe('file.txt')
    expect(store.readAttachment(recent.id,recentFile.workflowFileId).name).toBe('file.txt')
    expect(()=>store.readAttachment(old.id,oldFile.workflowFileId)).toThrow('运行记录不存在')
    const historical=run(-2);store.saveRun(historical)
    expect(existsSync(join(store.directory,'runs',historical.id+'.json'))).toBe(false)
    expect(existsSync(join(store.directory,'runs',historical.id+'.events.jsonl'))).toBe(false)
  })
  it('does not follow an attachment parent symlink during eviction',()=>{
    const store=open(),old=run(0);store.saveRun(old)
    const external=temporary(),sentinel=join(external,old.id);writeFileSync(sentinel,'keep')
    symlinkSync(external,join(store.directory,'attachments'))
    for(let i=1;i<=200;i++)store.saveRun(run(i))
    expect(readFileSync(sentinel,'utf8')).toBe('keep')
  })
})
