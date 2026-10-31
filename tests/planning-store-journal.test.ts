import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Deterministic short writes / ENOSPC for the journal append path only.
const fault=vi.hoisted(()=>({mode:'none' as 'none'|'short-then-fail'}))
vi.mock('node:fs',async original=>{
  const actual=await original<typeof import('node:fs')>()
  return {...actual,writeSync:(fd:number,buffer:any,offset?:any,length?:any,...rest:any[])=>{
    if(fault.mode==='short-then-fail'&&Buffer.isBuffer(buffer)){
      fault.mode='none'
      const half=Math.max(1,Math.floor((length??buffer.length)/2))
      actual.writeSync(fd,buffer,offset??0,half)
      return half
    }
    if(fault.mode==='none'&&(globalThis as any).__failNextWrite){(globalThis as any).__failNextWrite=false;throw Object.assign(Error('ENOSPC: no space left on device'),{code:'ENOSPC'})}
    return (actual.writeSync as any)(fd,buffer,offset,length,...rest)
  }}
})
const { PlanningStore } = await import('../src/host/planning/store.ts')

type Row={id:string;preview:boolean;value:number|string}
const directories:string[]=[]
afterEach(()=>{fault.mode='none';(globalThis as any).__failNextWrite=false;for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true})})
const fresh=()=>{const directory=mkdtempSync(join(tmpdir(),'planning-store-journal-'));directories.push(directory);return directory}
const read=(directory:string)=>new PlanningStore<Row>(directory).read(value=>value as Row)

describe('planning journal durability',()=>{
  it('never reports a short write as durable and keeps the journal loadable',()=>{
    const directory=fresh(),journal=join(directory,'planning','tasks.journal')
    const store=new PlanningStore<Row>(directory),rows:Row[]=[{id:'a',preview:false,value:1}]
    store.append(rows[0]!,()=>rows)
    rows[0]!.value=2;store.append(rows[0]!,()=>rows)
    rows[0]!.value=3;store.append(rows[0]!,()=>rows)
    const before=readFileSync(journal,'utf8')
    // Short write followed by ENOSPC: the append must fail and leave no partial row.
    fault.mode='short-then-fail';(globalThis as any).__failNextWrite=true
    rows[0]!.value=4
    expect(()=>store.append(rows[0]!,()=>rows)).toThrow(/ENOSPC/)
    expect(readFileSync(journal,'utf8')).toBe(before)
    expect(read(directory).map(row=>row.value)).toEqual([3])
    // The next persist compacts instead of appending after a possibly torn row.
    rows[0]!.value=5;store.append(rows[0]!,()=>rows)
    expect(existsSync(journal)).toBe(false)
    expect(read(directory).map(row=>row.value)).toEqual([5])
    rows[0]!.value=6;store.append(rows[0]!,()=>rows)
    expect(read(directory).map(row=>row.value)).toEqual([6])
  })
  it('refuses to journal a row the merged view could not compact into a snapshot',()=>{
    const directory=fresh(),big='x'.repeat(17_000_000)
    const store=new PlanningStore<Row>(directory),rows:Row[]=[{id:'a',preview:false,value:big}]
    store.write(rows)
    const second:Row={id:'b',preview:false,value:big}
    expect(()=>store.append(second,()=>[...rows,second])).toThrow('规划记录超过容量')
    // Nothing was committed: restart and later compaction both still succeed.
    expect(read(directory).map(row=>row.id)).toEqual(['a'])
    rows[0]!.value='small';store.append(rows[0]!,()=>rows)
    expect(()=>store.write(rows)).not.toThrow()
    // Replacing an existing row is measured against its prior size, not added twice.
    const third:Row={id:'b',preview:false,value:big.slice(0,16_000_000)}
    store.append(third,()=>[...rows,third])
    expect(read(directory).map(row=>row.id)).toEqual(['a','b'])
  })
  it('refuses a 101st persisted row before writing it',()=>{
    const directory=fresh(),store=new PlanningStore<Row>(directory)
    const rows:Row[]=Array.from({length:100},(_,index)=>({id:`r${index}`,preview:false,value:index}))
    store.write(rows)
    const extra:Row={id:'extra',preview:false,value:0}
    expect(()=>store.append(extra,()=>[...rows,extra])).toThrow('规划记录超过容量')
    expect(read(directory)).toHaveLength(100)
  })
})
