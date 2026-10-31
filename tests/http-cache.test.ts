import {afterEach,describe,expect,it} from 'vitest'
import {existsSync,lstatSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {WorkflowStorage} from '../src/host/storage.ts'
import {HttpBodyCache} from '../src/host/http-cache.ts'
import type {WorkflowRun} from '../src/shared/types.ts'
import {templateContext} from './fixtures/planning-compiler/template.ts'

const contexts:{directory:string;storage:WorkflowStorage}[]=[]
function setup(){const directory=mkdtempSync(join(tmpdir(),'http-cache-test-')),storage=new WorkflowStorage(directory);const ctx={directory,storage};contexts.push(ctx);return ctx}
function run(overrides:Partial<WorkflowRun>={}):WorkflowRun {return {id:randomUUID(),workflowId:'test',workspaceId:'workspace',graph:templateContext().workflow,status:'running',startedAt:'2026-10-24T00:00:00Z',inputs:{},outputs:{},executions:[],...overrides} as WorkflowRun}
afterEach(()=>{for(const ctx of contexts.splice(0)){ctx.storage.close();rmSync(ctx.directory,{recursive:true,force:true})}})

describe('HTTP response cache storage',()=>{
  it('writes original bytes and identity metadata privately; Host hook verifies every read',()=>{
    const {directory,storage}=setup(),r=run();storage.saveRun(r)
    const bytes=Buffer.from([0xff,0,0xe4,0xb8,0xad]),ref=storage.cacheHttpBody(r.id,'fetch',2,bytes,'text/plain'),base=join(directory,'http-cache',r.id),id=ref.$cachedBody.id
    expect(readFileSync(join(base,id+'.body'))).toEqual(bytes)
    expect(storage.readCachedBody(r.id,ref)).toEqual(bytes)
    expect(ref.$cachedBody.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(JSON.parse(readFileSync(join(base,id+'.json'),'utf8'))).toMatchObject({id,runId:r.id,nodeId:'fetch',attempt:2,bytes:5,sha256:ref.$cachedBody.sha256,contentType:'text/plain',createdAt:expect.any(String)})
    for(const path of [join(directory,'http-cache'),base])expect(lstatSync(path).mode&0o777).toBe(0o700)
    for(const ext of ['.body','.json'])expect(lstatSync(join(base,id+ext)).mode&0o777).toBe(0o600)
  })
  it('preserves a long content-type without imposing a hidden metadata limit',()=>{
    const {storage}=setup(),r=run();storage.saveRun(r)
    const contentType='text/plain; note='+ 'x'.repeat(20000),ref=storage.cacheHttpBody(r.id,'fetch',1,Buffer.from('body'),contentType)
    expect(ref.$cachedBody.contentType).toBe(contentType);expect(storage.readCachedBody(r.id,ref).toString()).toBe('body')
  })
  it('redacts literal replacement tokens without expanding them back into full bodies',()=>{
    const {storage}=setup(),r=run();storage.saveRun(r)
    const body="$&$`$'\""+'x'.repeat(300000),ref=storage.cacheHttpBody(r.id,'fetch',1,Buffer.from(body),'text/html')
    storage.readCachedBody(r.id,ref)
    const redacted=storage.redactCachedText(r.id,{input:body,encoded:JSON.stringify({html:body})})
    expect(redacted.input).toBe(JSON.stringify(ref));expect(JSON.parse(redacted.encoded).html).toBe(JSON.stringify(ref))
    expect(JSON.stringify(redacted)).not.toContain(body);expect(JSON.stringify(redacted).length).toBeLessThan(6000)
  })
  it.each(['body','bytes','metadata','symlink'])('rejects %s tampering on every read',kind=>{
    const {directory,storage}=setup(),r=run();storage.saveRun(r)
    const ref=storage.cacheHttpBody(r.id,'fetch',1,Buffer.from('original'),'text/plain'),base=join(directory,'http-cache',r.id),path=join(base,ref.$cachedBody.id+'.body')
    expect(storage.readCachedBody(r.id,ref).toString()).toBe('original')
    if(kind==='body')writeFileSync(path,'tampered')
    if(kind==='bytes')writeFileSync(path,'short')
    if(kind==='metadata')writeFileSync(join(base,ref.$cachedBody.id+'.json'),JSON.stringify({runId:randomUUID()}))
    if(kind==='symlink'){rmSync(path);symlinkSync(join(directory,'library.json'),path)}
    expect(()=>storage.readCachedBody(r.id,ref)).toThrow(/HTTP 缓存/)
  })
  it('rejects cross-run refs even when id, bytes and digest match, and rejects traversal',()=>{
    const {storage}=setup(),a=run(),b=run();storage.saveRun(a);storage.saveRun(b)
    const ref=storage.cacheHttpBody(a.id,'fetch',1,Buffer.from('abc'),'text/plain')
    expect(()=>storage.readCachedBody(b.id,ref)).toThrow('请重跑抓取节点')
    expect(()=>storage.readCachedBody(a.id,{$cachedBody:{...ref.$cachedBody,id:'../evil'}})).toThrow('请重跑抓取节点')
  })
  it.each(['http-cache','run-directory'])('rejects a symlink at %s',part=>{
    const {directory,storage}=setup(),r=run();storage.saveRun(r)
    const ref=storage.cacheHttpBody(r.id,'fetch',1,Buffer.from('abc'),'text/plain'),base=join(directory,'http-cache'),path=part==='http-cache'?base:join(base,r.id)
    rmSync(path,{recursive:true});symlinkSync(tmpdir(),path)
    expect(()=>storage.readCachedBody(r.id,ref)).toThrow('符号链接')
    expect(()=>storage.cacheHttpBody(r.id,'fetch',1,Buffer.from('abc'),'text/plain')).toThrow('符号链接')
  })
  it('evicts oldest finished runs until quota while protecting all active states',()=>{
    const {directory}=setup(),states=['running','waiting','pausing','paused','budget_waiting'] as const
    const old=run({status:'success',endedAt:'2026-10-24T01:00:00Z'}),newer=run({status:'failed',endedAt:'2026-10-24T02:00:00Z'}),active=states.map(status=>run({status}))
    const runs=[old,newer,...active];for(const r of runs)r.graph={...r.graph,executionPolicy:{httpCacheLimitMB:20}}
    // Start all runs active while writing, then let the cleanup observe terminal states.
    const cache=new HttpBodyCache(directory,()=>runs,()=>({httpCacheLimitMB:20,httpCacheImmediateCleanup:false})),prior=runs.map(r=>r.status);runs.forEach(r=>r.status='running')
    for(const r of runs)cache.write(r.id,'fetch',1,Buffer.alloc(3_000_000),'text/plain')
    runs.forEach((r,i)=>r.status=prior[i]!);cache.cleanup()
    expect(existsSync(join(directory,'http-cache',old.id))).toBe(false)
    for(const r of [newer,...active])expect(existsSync(join(directory,'http-cache',r.id))).toBe(true)
    cache.write(active[0]!.id,'again',2,Buffer.alloc(10_000_000),'text/plain')
    expect(existsSync(join(directory,'http-cache',newer.id))).toBe(false)
    for(const r of active)expect(existsSync(join(directory,'http-cache',r.id))).toBe(true)
  })
  it.each(['success','failed','cancelled','interrupted'] as const)('immediate cleanup at %s preserves preview and cleared display state',status=>{
    const {storage}=setup(),r=run();storage.saveRun(r);storage.saveHttpCacheSettings({httpCacheImmediateCleanup:true})
    const ref=storage.cacheHttpBody(r.id,'fetch',1,Buffer.from('preview'),'text/plain')
    r.executions=[{nodeId:'fetch',status:'success',data:{text:ref,body:ref},output:JSON.stringify(ref)} as any]
    storage.saveRun(r);expect((storage.run(r.id).executions[0]!.data!.text as any).$cachedBody.evicted).toBe(false)
    r.status=status;r.endedAt='2026-10-24T02:00:00Z';storage.saveRun(r)
    expect(()=>storage.readCachedBody(r.id,ref)).toThrow('已清理')
    expect((storage.run(r.id).executions[0]!.data!.text as any).$cachedBody).toMatchObject({evicted:true,preview:'preview',bytes:7,sha256:ref.$cachedBody.sha256})
  })
  it('keeps finished cache by default and cleans on Host startup using persisted policy',()=>{
    const ctx=setup(),r=run();ctx.storage.save(templateContext().workflow,0);ctx.storage.saveRun(r)
    const ref=ctx.storage.cacheHttpBody(r.id,'fetch',1,Buffer.from('retained'),'text/plain');r.status='success';r.endedAt='2026-10-24T02:00:00Z';ctx.storage.saveRun(r)
    expect(ctx.storage.readCachedBody(r.id,ref).toString()).toBe('retained');ctx.storage.close()
    const file=join(ctx.directory,'library.json'),saved=JSON.parse(readFileSync(file,'utf8'));saved.httpCacheSettings={httpCacheLimitMB:200,httpCacheImmediateCleanup:true};writeFileSync(file,JSON.stringify(saved))
    ctx.storage=new WorkflowStorage(ctx.directory)
    expect(()=>ctx.storage.readCachedBody(r.id,ref)).toThrow('已清理')
  })
  it('startup enforces the latest saved quota in finish order and preserves paused runs',()=>{
    const ctx=setup(),flow=ctx.storage.save({...templateContext().workflow,executionPolicy:{httpCacheLimitMB:20}},0)
    ctx.storage.saveHttpCacheSettings({httpCacheLimitMB:20})
    const runs=Array.from({length:4},()=>run({graph:flow})),refs=[]
    for(const r of runs){ctx.storage.saveRun(r);refs.push(ctx.storage.cacheHttpBody(r.id,'fetch',1,Buffer.alloc(8_000_000),'text/plain'))}
    ctx.storage.close()
    runs.forEach((r,index)=>{const file=join(ctx.directory,'runs',r.id+'.json'),saved=JSON.parse(readFileSync(file,'utf8'));saved.status=index===3?'paused':'success';saved.endedAt=`2026-10-24T0${index+1}:00:00Z`;writeFileSync(file,JSON.stringify(saved))})
    ctx.storage=new WorkflowStorage(ctx.directory)
    for(const index of [0,1])expect(()=>ctx.storage.readCachedBody(runs[index]!.id,refs[index]!)).toThrow('已清理')
    for(const index of [2,3])expect(ctx.storage.readCachedBody(runs[index]!.id,refs[index]!).length).toBe(8_000_000)
    expect(ctx.storage.run(runs[3]!.id).status).toBe('paused')
  })
  it('persists validated global settings and ignores legacy workflow values on load',()=>{
    const ctx=setup();expect(ctx.storage.httpCacheSettings()).toEqual({httpCacheLimitMB:200,httpCacheImmediateCleanup:false})
    for(const value of [19,5001,20.5,'20'])expect(()=>ctx.storage.saveHttpCacheSettings({httpCacheLimitMB:value})).toThrow()
    expect(()=>ctx.storage.saveHttpCacheSettings({httpCacheImmediateCleanup:'true'})).toThrow()
    expect(()=>ctx.storage.saveHttpCacheSettings({extra:1})).toThrow()
    ctx.storage.saveHttpCacheSettings({httpCacheLimitMB:5000});ctx.storage.saveHttpCacheSettings({httpCacheImmediateCleanup:true})
    const flow=ctx.storage.save({...templateContext().workflow,executionPolicy:{httpCacheLimitMB:20,httpCacheImmediateCleanup:true}},0)
    expect(flow.executionPolicy).toEqual({});ctx.storage.close()
    const file=join(ctx.directory,'library.json'),saved=JSON.parse(readFileSync(file,'utf8'))
    saved.workflows.find((item:any)=>item.id===flow.id).executionPolicy={httpCacheLimitMB:'legacy',httpCacheImmediateCleanup:{obsolete:true}}
    writeFileSync(file,JSON.stringify(saved));ctx.storage=new WorkflowStorage(ctx.directory)
    expect(ctx.storage.httpCacheSettings()).toEqual({httpCacheLimitMB:5000,httpCacheImmediateCleanup:true})
    expect(ctx.storage.get(flow.id).executionPolicy).toEqual({})
  })
  it('uses current settings on writes and terminal transitions, never run snapshots or workflow minimums',()=>{
    const {storage}=setup(),r=run();r.graph={...r.graph,executionPolicy:{httpCacheLimitMB:20,httpCacheImmediateCleanup:true}};storage.saveRun(r)
    const ref=storage.cacheHttpBody(r.id,'fetch',1,Buffer.from('retained'),'text/plain')
    r.status='success';storage.saveRun(r);expect(storage.readCachedBody(r.id,ref).toString()).toBe('retained')
    storage.saveHttpCacheSettings({httpCacheImmediateCleanup:true})
    const next=run();storage.saveRun(next);const current=storage.cacheHttpBody(next.id,'fetch',1,Buffer.from('current'),'text/plain')
    expect(()=>storage.readCachedBody(r.id,ref)).toThrow('已清理');expect(storage.readCachedBody(next.id,current).toString()).toBe('current')
    storage.saveHttpCacheSettings({httpCacheImmediateCleanup:false});next.status='success';storage.saveRun(next)
    expect(storage.readCachedBody(next.id,current).toString()).toBe('current')
    storage.saveHttpCacheSettings({httpCacheImmediateCleanup:true});next.status='failed';storage.saveRun(next)
    expect(()=>storage.readCachedBody(next.id,current)).toThrow('已清理')
  })
  it('removes cache with history retention, retaining all active runs',()=>{
    const {directory,storage}=setup(),old=run();storage.saveRun(old)
    const ref=storage.cacheHttpBody(old.id,'fetch',1,Buffer.from('old'),'text/plain');old.status='success';storage.saveRun(old)
    for(let i=0;i<200;i++)storage.saveRun(run({status:'success',startedAt:new Date(Date.UTC(2026,9,25,0,i)).toISOString()}))
    expect(storage.runs()).toHaveLength(200);expect(()=>storage.run(old.id)).toThrow('不存在');expect(existsSync(join(directory,'http-cache',old.id))).toBe(false)
    expect(()=>storage.readCachedBody(old.id,ref)).toThrow('重跑')
  })
})
