import { closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const SNAPSHOT_LIMIT=32_000_000,ROW_LIMIT=32_000_000,JOURNAL_LIMIT=128_000_000
const COMPACT_BYTES=8_000_000,COMPACT_ROWS=512,MAX_ROWS=100
export interface PlanningStoreLimits {snapshotBytes?:number;maxRows?:number}
export interface PlanningRetention<T> extends PlanningStoreLimits {
  canEvict(row:T,retained:readonly T[]):boolean
  createdAt(row:T):string
  beforeEvict?(ids:readonly string[]):void
  onEvict(ids:readonly string[]):void
}
const generationPattern=/^[a-f0-9-]{36}$/

/**
 * Ordinary previews are ephemeral. Verified execution receipts may opt into recovery persistence.
 *
 * `<name>.json` is a compacted snapshot. `append` journals only the changed row
 * to `<name>.journal` (synchronous write+fsync), so one event no longer
 * serializes every task. The journal header names a snapshot generation; a
 * journal is replayed only for the snapshot that declared it, so a crash during
 * compaction never lets older rows overwrite a newer snapshot.
 */
export class PlanningStore<T extends {id:string;preview:boolean}> {
  private readonly directory:string
  private readonly file:string
  private readonly journal:string
  /** Generation this process last compacted; appends require a known generation. */
  private generation?:string
  private journalBytes=0
  private journalRows=0
  /** Serialized bytes of each row in the merged view, so an append can be capacity-checked without serializing every task. */
  private rowBytes=new Map<string,number>()
  private snapshotBytes=0
  constructor(directory:string,private readonly persist:(task:T)=>boolean=task=>!task.preview,filename:'tasks.json'|'background.json'='tasks.json',private readonly retention?:PlanningRetention<T>){
    this.directory=join(directory,'planning');this.file=join(this.directory,filename);this.journal=join(this.directory,filename.replace(/\.json$/,'.journal'))
  }
  get maxRows():number{return this.retention?.maxRows??MAX_ROWS}
  private get limit():number{return this.retention?.snapshotBytes??SNAPSHOT_LIMIT}
  private assertPaths():void{
    if(lstatSync(this.directory).isSymbolicLink())throw new Error('规划目录不能是符号链接')
    for(const path of [this.file,this.journal])if(existsSync(path)){const meta=lstatSync(path);if(meta.isSymbolicLink()||!meta.isFile())throw new Error('规划记录路径无效')}
  }
  /** Merged raw rows (snapshot, then its own journal); last journaled row per id wins. */
  readRaw():{version:1;tasks:unknown[]}{
    if(!existsSync(this.directory))return {version:1,tasks:[]}
    this.assertPaths()
    if(!existsSync(this.file))return {version:1,tasks:[]}
    if(lstatSync(this.file).size>this.limit)throw new Error('规划记录文件无效或超过容量')
    const raw=JSON.parse(readFileSync(this.file,'utf8'))
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!['version','tasks','journal'].includes(key))||raw.version!==1||!Array.isArray(raw.tasks)||raw.tasks.length>this.maxRows||(raw.journal!==undefined&&(typeof raw.journal!=='string'||!generationPattern.test(raw.journal))))throw new Error('规划记录格式无效')
    const rows=new Map<string,unknown>(),order:string[]=[]
    const put=(row:unknown)=>{
      const id=row&&typeof row==='object'&&'id'in row&&typeof row.id==='string'?row.id:undefined
      if(id===undefined)throw new Error('规划记录格式无效')
      if(!rows.has(id))order.push(id)
      rows.set(id,row)
    }
    const snapshotIds=raw.tasks.map((row:{id?:unknown})=>row?.id)
    if(new Set(snapshotIds).size!==snapshotIds.length)throw new Error('规划任务身份重复')
    for(const row of raw.tasks)put(row)
    if(raw.journal&&existsSync(this.journal)){
      if(lstatSync(this.journal).size>JOURNAL_LIMIT)throw new Error('规划日志超过容量')
      const lines=readFileSync(this.journal,'utf8').split('\n')
      const torn=lines.at(-1)!==''
      let header:unknown
      try{header=JSON.parse(lines[0]??'')}catch{header=undefined}
      // A header from another generation predates the snapshot: it is subsumed.
      if(header&&typeof header==='object'&&'generation'in header&&header.generation===raw.journal){
        for(const [index,line] of lines.slice(1).entries()){
          if(!line)continue
          let row:unknown
          try{row=JSON.parse(line)}catch(error){
            // Only an unterminated final line can be a torn append; never skip committed rows.
            if(torn&&index===lines.length-2)break
            throw error
          }
          put(row)
        }
      }
    }
    if(order.length>this.maxRows)throw new Error('规划记录格式无效')
    return {version:1,tasks:order.map(id=>rows.get(id))}
  }
  read(validate:(value:unknown)=>T):T[]{
    const tasks=this.readRaw().tasks.map(validate)
    if(new Set(tasks.map(task=>task.id)).size!==tasks.length)throw new Error('规划任务身份重复')
    return tasks
  }
  /** Full compaction: atomically replace the snapshot and start a fresh journal generation. */
  write(tasks:readonly T[],currentId?:string):void{
    const generation=randomUUID(),serialized=new Map(tasks.filter(this.persist).map(row=>[row.id,JSON.stringify(row)]))
    let retained=[...tasks]
    const overhead=Buffer.byteLength(`{"version":1,"tasks":[],"journal":${JSON.stringify(generation)}}`)
    let bytes=overhead+[...serialized.values()].reduce((sum,row)=>sum+Buffer.byteLength(row),0)+Math.max(0,serialized.size-1)
    const evicted:string[]=[]
    if(bytes>this.limit||retained.length>this.maxRows){
      // Stable sort preserves insertion order for equal creation timestamps.
      const candidates=this.retention?[...tasks].sort((a,b)=>this.retention!.createdAt(a).localeCompare(this.retention!.createdAt(b))):[]
      while(bytes>Math.floor(this.limit*.75)||retained.length>Math.floor(this.maxRows*.75)){
        const row=candidates.find(row=>row.id!==currentId&&!evicted.includes(row.id)&&this.retention!.canEvict(row,retained))
        if(!row)break
        retained=retained.filter(item=>item.id!==row.id);evicted.push(row.id)
        const text=serialized.get(row.id)
        if(text!==undefined){bytes-=Buffer.byteLength(text)+(serialized.size>1?1:0);serialized.delete(row.id)}
      }
      // The low-water mark is a target; protected rows may require more space.
      if(bytes>this.limit||retained.length>this.maxRows)throw new Error('规划记录超过容量')
    }
    const saved=retained.filter(this.persist),rows=saved.map(row=>serialized.get(row.id)!),content=`{"version":1,"tasks":[${rows.join(',')}],"journal":${JSON.stringify(generation)}}`
    // Foreground previews have no detail file to commit or recreate.
    if(evicted.length&&!saved.length&&!existsSync(this.file)){
      this.retention!.beforeEvict?.(evicted);this.retention!.onEvict(evicted);return
    }
    mkdirSync(this.directory,{recursive:true,mode:0o700})
    this.assertPaths()
    if(evicted.length)this.retention!.beforeEvict?.(evicted)
    // Invalidate appends first: until the new journal exists no row may target a stale generation.
    this.generation=undefined
    this.atomic(this.file,content)
    // The snapshot is authoritative even if old-journal removal fails.
    if(evicted.length)this.retention!.onEvict(evicted)
    // The old journal names an older generation, so it is already ignored; the
    // next append starts this generation's journal lazily.
    if(existsSync(this.journal))rmSync(this.journal)
    this.generation=generation;this.journalBytes=0;this.journalRows=0
    this.rowBytes=new Map(saved.map((row,index)=>[row.id,Buffer.byteLength(rows[index]!)]));this.snapshotBytes=Buffer.byteLength(content)
  }
  /**
   * Durably journal one changed row. The first append of a process, or a large
   * journal, compacts all rows via `all`; compaction failure after a durable
   * append is non-fatal because the journal remains authoritative.
   */
  append(task:T,all:()=>readonly T[]):void{
    if(!this.persist(task))return
    if(this.generation===undefined){this.write(all(),task.id);return}
    const line=JSON.stringify(task)+'\n',bytes=Buffer.byteLength(line)
    if(bytes>ROW_LIMIT)throw new Error('规划记录超过容量')
    // Never journal a row the merged view could not compact into a snapshot.
    const prior=this.rowBytes.get(task.id),projected=this.snapshotBytes-(prior??-1)+bytes-1
    if(projected>this.limit||(prior===undefined&&this.rowBytes.size>=this.maxRows)){this.write(all(),task.id);return}
    if(this.journalBytes+bytes>JOURNAL_LIMIT){this.write(all(),task.id);return}
    this.assertPaths()
    if(!this.journalBytes){
      const header=JSON.stringify({generation:this.generation})+'\n'
      this.atomic(this.journal,header+line);this.journalBytes=Buffer.byteLength(header)
    }else this.appendLine(line)
    this.journalBytes+=bytes;this.journalRows++
    this.rowBytes.set(task.id,bytes-1);this.snapshotBytes=projected
    if(this.journalBytes>COMPACT_BYTES||this.journalRows>COMPACT_ROWS){try{this.write(all(),task.id)}catch{/* Retried at the next threshold. */}}
  }
  /** Report success only after the whole line is written and synced; otherwise restore the last complete row. */
  private appendLine(line:string):void{
    const buffer=Buffer.from(line)
    let fd:number|undefined,start:number|undefined
    try{
      fd=openSync(this.journal,fsConstants.O_WRONLY|fsConstants.O_APPEND|(fsConstants.O_NOFOLLOW??0))
      start=fstatSync(fd).size
      for(let offset=0;offset<buffer.length;){
        const written=writeSync(fd,buffer,offset,buffer.length-offset)
        if(written<=0)throw new Error('规划日志写入未完成')
        offset+=written
      }
      fsyncSync(fd)
    }catch(error){
      // A torn row must stay the final line or vanish: truncate it, and force
      // the next persist to compact so nothing is ever appended after it.
      this.generation=undefined
      if(fd!==undefined&&start!==undefined)try{ftruncateSync(fd,start);fsyncSync(fd)}catch{/* Ignored as a torn final line on read. */}
      throw error
    }finally{if(fd!==undefined)closeSync(fd)}
  }
  private atomic(path:string,content:string):void{
    const temp=join(this.directory,`write-${randomUUID()}.tmp`)
    let fd:number|undefined
    try{fd=openSync(temp,'wx',0o600);writeFileSync(fd,content);fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temp,path)}
    finally{if(fd!==undefined)closeSync(fd);if(existsSync(temp))rmSync(temp)}
  }
}
