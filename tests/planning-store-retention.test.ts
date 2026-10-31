import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PlanningStore, type PlanningStoreLimits } from '../src/host/planning/store.ts'

type Row={id:string;preview:boolean;createdAt:string;ended:boolean;value:string}
const directories:string[]=[]
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true})})
const row=(id:number,ended=true):Row=>({id:`r${id}`,preview:false,createdAt:new Date(id*1000).toISOString(),ended,value:'中文'.repeat(45)})
function fixture(limits:PlanningStoreLimits={}){
  const directory=mkdtempSync(join(tmpdir(),'planning-retention-'));directories.push(directory)
  const rows=new Map<string,Row>(),evicted=vi.fn((ids:readonly string[])=>{for(const id of ids)rows.delete(id)})
  const store=new PlanningStore<Row>(directory,task=>!task.preview,'tasks.json',{...limits,createdAt:task=>task.createdAt,canEvict:task=>task.ended,onEvict:evicted})
  const put=(task:Row)=>{rows.set(task.id,task);store.append(task,()=>[...rows.values()])}
  const read=()=>new PlanningStore<Row>(directory).read(value=>value as Row)
  return {directory,rows,store,put,read,evicted}
}
describe('planning retention compaction',()=>{
  it('evicts by creation time rather than insertion order at the row limit and leaves low-water headroom',()=>{
    const f=fixture({maxRows:4})
    for(const id of [3,1,4,2])f.put(row(id))
    expect(f.evicted).not.toHaveBeenCalled()
    f.put(row(5))
    expect(f.evicted).toHaveBeenCalledWith(['r1','r2'])
    expect([...f.rows.keys()]).toEqual(['r3','r4','r5'])
    f.put(row(6));expect(f.evicted).toHaveBeenCalledTimes(1)
    expect(f.read().map(row=>row.id)).toEqual([...f.rows.keys()])
  })
  it('compacts UTF-8 bytes below both low-water marks and never replays the old journal',()=>{
    const f=fixture({snapshotBytes:1800,maxRows:10})
    for(let id=1;id<=4;id++)f.put(row(id))
    const journal=join(f.directory,'planning/tasks.journal'),oldJournal=readFileSync(journal,'utf8')
    f.put(row(5))
    const snapshot=readFileSync(join(f.directory,'planning/tasks.json'))
    expect(snapshot.byteLength).toBeLessThanOrEqual(1350)
    expect(f.evicted).toHaveBeenCalledWith(['r1','r2'])
    writeFileSync(journal,oldJournal)
    expect(f.read().map(row=>row.id)).toEqual(['r3','r4','r5'])
    f.store.write([...f.rows.values()]);expect(f.read().map(row=>row.id)).toEqual(['r3','r4','r5'])
  })
  it('protects the current ended row, active rows and stable timestamp ties',()=>{
    const f=fixture({maxRows:4}),current=row(0)
    for(const task of [current,row(1,false),row(2),{...row(3),createdAt:row(2).createdAt}])f.put(task)
    f.rows.set('r4',row(4,false));f.store.write([...f.rows.values()],current.id)
    expect(f.evicted).toHaveBeenCalledWith(['r2','r3'])
    expect([...f.rows.keys()]).toEqual(['r0','r1','r4'])
  })
  it('does not delete any rows or call eviction hooks when even all eligible rows cannot make room',()=>{
    const f=fixture({maxRows:2,snapshotBytes:1600})
    f.put(row(1));f.put(row(2,false))
    const before=readFileSync(join(f.directory,'planning/tasks.json'),'utf8'),large={...row(3),value:'x'.repeat(1700)}
    expect(()=>f.put(large)).toThrow('规划记录超过容量')
    expect(f.evicted).not.toHaveBeenCalled()
    expect(readFileSync(join(f.directory,'planning/tasks.json'),'utf8')).toBe(before)
    expect(f.read().map(row=>row.id)).toEqual(['r1','r2'])
  })
  it('clears ended foreground previews without creating a detail file',()=>{
    const f=fixture({maxRows:2})
    for(const id of [1,2,3])f.rows.set(`r${id}`,{...row(id),preview:true})
    f.store.write([...f.rows.values()],'r3')
    expect([...f.rows.keys()]).toEqual(['r3'])
    expect(existsSync(join(f.directory,'planning/tasks.json'))).toBe(false)
  })
  it('accepts a protected working set above low water if it still fits the hard limits',()=>{
    const f=fixture({maxRows:4})
    for(const id of [1,2,3])f.put(row(id,false))
    f.put(row(4));f.put(row(5,false))
    expect(f.evicted).toHaveBeenCalledWith(['r4']);expect(f.read()).toHaveLength(4)
  })
})
