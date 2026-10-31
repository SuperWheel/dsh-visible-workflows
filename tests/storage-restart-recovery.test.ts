import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowStorage } from '../src/host/storage.ts'
import { makeWorkflow, type WorkflowRun } from '../src/shared/types.ts'

const directories:string[]=[],stores:WorkflowStorage[]=[]
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true})})
const open=(directory:string)=>{const store=new WorkflowStorage(directory);stores.push(store);return store}
function fixture(status:WorkflowRun['status']='paused'){
  const directory=mkdtempSync(join(tmpdir(),'storage-restart-recovery-'));directories.push(directory)
  const store=open(directory),graph=store.save(makeWorkflow('workspace','恢复记录',true),0)
  const run:WorkflowRun={id:randomUUID(),workflowId:graph.id,workspaceId:graph.workspaceId,workflowTitle:graph.title,sourceRevision:graph.revision,graph,status,inputs:{text:'保留输入'},outputs:{receipt:'external-action-receipt'},executions:[],startedAt:'2026-10-19T00:00:00.000Z'}
  const events=join(directory,'runs',`${run.id}.events.jsonl`),quarantine=join(directory,'runs',`${run.id}.events.quarantine.jsonl`)
  return {directory,store,run,events,quarantine}
}
const rows=(file:string)=>readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line))

describe('restart recovery with unfinished executions',()=>{
  it.each(['paused','budget_waiting','waiting','success','failed','cancelled','interrupted'] as const)('interrupts a %s run containing a running execution exactly once',status=>{
    const f=fixture(status)
    f.run.executions=[
      {nodeId:f.run.graph.nodes[0]!.id,number:'1',title:'Complete',status:'success',tokenUsage:17},
      {nodeId:f.run.graph.nodes[1]!.id,number:'2',title:'External action',status:'running'},
    ]
    f.run.usage={spentTokens:17,reservedTokens:300,unknownTokens:23,unknownCalls:2,agentTasks:1,calls:4,limit:1,allocations:{pending:{tokens:200,status:'reserved'},settled:{tokens:9,status:'settled',usage:17}}}
    f.store.saveRun(f.run)
    const history=readFileSync(f.events),library=readFileSync(join(f.directory,'library.json'))
    f.store.close()
    const reopened=open(f.directory),recovered=reopened.run(f.run.id)
    expect(recovered).toEqual({...f.run,status:'interrupted',error:'Host 已重新启动；未自动重放可能有外部副作用的节点',endedAt:expect.any(String),executions:[f.run.executions[0],{...f.run.executions[1],status:'failed',error:'执行被中断',endedAt:recovered.endedAt}]})
    expect(recovered.endedAt).toBeDefined()
    expect(readFileSync(f.events).subarray(0,history.length)).toEqual(history)
    expect(rows(f.events).at(-1)).toMatchObject({seq:2,status:'interrupted',usage:f.run.usage})
    expect(readFileSync(join(f.directory,'library.json'))).toEqual(library)
    const snapshot=readFileSync(join(f.directory,'runs',`${f.run.id}.json`)),events=readFileSync(f.events)
    reopened.close()
    expect(open(f.directory).run(f.run.id)).toEqual(recovered)
    expect(readFileSync(join(f.directory,'runs',`${f.run.id}.json`))).toEqual(snapshot)
    expect(readFileSync(f.events)).toEqual(events)
  })

  it.each(['paused','budget_waiting'] as const)('preserves a clean %s run and its event bytes',status=>{
    const f=fixture(status)
    f.run.executions=[{nodeId:f.run.graph.nodes[0]!.id,number:'1',title:'Complete',status:'success'}]
    f.store.saveRun(f.run);const events=readFileSync(f.events);f.store.close()
    expect(open(f.directory).run(f.run.id)).toEqual(f.run)
    expect(readFileSync(f.events)).toEqual(events)
    expect(existsSync(f.quarantine)).toBe(false)
  })
})

describe('torn run event tail recovery',()=>{
  it('quarantines exact tail bytes and byte offsets before continuing sequence numbers across restarts',()=>{
    const f=fixture('running');f.store.saveRun(f.run);f.store.close()
    const valid=Buffer.from(JSON.stringify({runId:f.run.id,seq:40,note:'中文完整事件'})+'\n')
    // A crash can also split a UTF-8 character, so a decoded string is insufficient.
    const tail=Buffer.concat([Buffer.from('{"runId":"部分'),Buffer.from([0xe6,0x96])])
    writeFileSync(f.events,Buffer.concat([valid,tail]))
    const reopened=open(f.directory)
    expect(reopened.run(f.run.id).status).toBe('interrupted')
    expect(readFileSync(f.events).subarray(0,valid.length)).toEqual(valid)
    expect(rows(f.events).map(row=>row.seq)).toEqual([40,41])
    let quarantined=rows(f.quarantine)
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]).toMatchObject({runId:f.run.id,byteOffset:valid.length,detectedAt:expect.any(String)})
    expect(Number.isNaN(Date.parse(quarantined[0].detectedAt))).toBe(false)
    expect(Buffer.from(quarantined[0].bytesBase64,'base64')).toEqual(tail)
    expect(statSync(f.quarantine).mode&0o777).toBe(0o600)
    const next=reopened.run(f.run.id);next.error='Reviewed';reopened.saveRun(next);reopened.close()
    // A later torn append must append to the same quarantine without overwriting it.
    const before=readFileSync(f.events),secondTail=Buffer.from('{"second":')
    appendFileSync(f.events,secondTail)
    const again=open(f.directory),latest=again.run(f.run.id);latest.error='Reviewed again';again.saveRun(latest)
    expect(again.runs()).toHaveLength(1)
    expect(rows(f.events).map(row=>row.seq)).toEqual([40,41,42,43])
    quarantined=rows(f.quarantine)
    expect(quarantined).toHaveLength(2)
    expect(Buffer.from(quarantined[0].bytesBase64,'base64')).toEqual(tail)
    expect(quarantined[1].byteOffset).toBe(before.length)
    expect(Buffer.from(quarantined[1].bytesBase64,'base64')).toEqual(secondTail)
  })

  it('starts at sequence one when the only event is an incomplete tail',()=>{
    const f=fixture('running');f.store.saveRun(f.run);f.store.close()
    writeFileSync(f.events,'{"runId":')
    expect(open(f.directory).run(f.run.id).status).toBe('interrupted')
    expect(rows(f.events).map(row=>row.seq)).toEqual([1])
    expect(rows(f.quarantine)[0].byteOffset).toBe(0)
  })

  it.each(['middle','terminated last','middle before unterminated whitespace'] as const)('rejects %s corruption without truncating or quarantining',position=>{
    const f=fixture('running');f.store.saveRun(f.run);f.store.close()
    const valid=readFileSync(f.events,'utf8'),bad='{"runId":\n'
    const content=valid+bad+(position==='middle'?valid:position==='middle before unterminated whitespace'?'  ':'')
    writeFileSync(f.events,content)
    expect(()=>new WorkflowStorage(f.directory)).toThrow('运行事件日志格式无效')
    expect(readFileSync(f.events,'utf8')).toBe(content)
    expect(existsSync(f.quarantine)).toBe(false)
    expect(existsSync(join(f.directory,'host.lock'))).toBe(false)
  })

  it('does not quarantine a complete JSON tail with an invalid run identity',()=>{
    const f=fixture('running');f.store.saveRun(f.run);f.store.close()
    const content=JSON.stringify({runId:'other-run',seq:1});writeFileSync(f.events,content)
    expect(()=>new WorkflowStorage(f.directory)).toThrow('运行事件日志身份无效')
    expect(readFileSync(f.events,'utf8')).toBe(content)
    expect(existsSync(f.quarantine)).toBe(false)
  })

  it('removes the quarantine alongside a finished run when retention evicts it',()=>{
    const f=fixture('running');f.store.saveRun(f.run);f.store.close();appendFileSync(f.events,'{"torn":')
    const reopened=open(f.directory)
    expect(existsSync(f.quarantine)).toBe(true)
    for(let index=1;index<=200;index++)reopened.saveRun({...f.run,id:randomUUID(),status:'success',startedAt:new Date(Date.parse(f.run.startedAt)+index*1000).toISOString()})
    for(const file of [f.events,f.quarantine,join(f.directory,'runs',`${f.run.id}.json`)])expect(existsSync(file)).toBe(false)
  })
})
