import { DEFAULT_HTTP_CACHE_SETTINGS, type HttpCacheSettings } from '../shared/http-cache-settings.ts'
import {chmodSync,closeSync,constants,fstatSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs'
import {createHash,randomUUID} from 'node:crypto'
import {join} from 'node:path'
import type {WorkflowRun} from '../shared/types.ts'
import {CachedBodyError,HTTP_DOWNLOAD_LIMIT,isCachedBody,type CachedBody} from '../shared/http-cache.ts'

const active=new Set(['running','waiting','pausing','paused','budget_waiting'])
const identity=(id:string)=>/^[a-f0-9-]{36}$/.test(id)
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const missing='HTTP 响应正文已清理或不属于本次运行，请重跑抓取节点'
export type HttpCacheOwner = Pick<WorkflowRun,'id'|'status'|'startedAt'|'endedAt'>
function stat(path:string){try{return lstatSync(path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error}}
/** Private Host storage. Never expose read() through Remote or tool catalogs. */
export class HttpBodyCache {
  constructor(private directory:string,private runs:()=>HttpCacheOwner[],private settings:()=>HttpCacheSettings=()=>DEFAULT_HTTP_CACHE_SETTINGS){}
  private folder(runId?:string,create=false):string {
    if(runId!==undefined&&!identity(runId))throw new CachedBodyError('HTTP 缓存运行身份无效，请重跑抓取节点')
    let path=this.directory
    for(const part of ['http-cache',...(runId?[runId]:[])]){
      path=join(path,part);let info=stat(path)
      if(!info&&create){mkdirSync(path,{mode:0o700});info=stat(path)}
      if(info&&(info.isSymbolicLink()||!info.isDirectory()))throw new CachedBodyError('HTTP 缓存目录不能是符号链接或普通文件')
      if(info)chmodSync(path,0o700)
      else if(!create)throw new CachedBodyError(missing)
    }
    return path
  }
  write(runId:string,nodeId:string,attempt:number,bytes:Uint8Array,contentType:string):CachedBody {
    if(!this.runs().some(run=>run.id===runId))throw new CachedBodyError(missing)
    if(bytes.length>HTTP_DOWNLOAD_LIMIT)throw new CachedBodyError('响应超过 10 MB 上限')
    const directory=this.folder(runId,true),id=randomUUID(),sha256=digest(bytes)
    const metadata={id,runId,nodeId,attempt,bytes:bytes.length,sha256,contentType,createdAt:new Date().toISOString()}
    writeFileSync(join(directory,`${id}.body`),bytes,{flag:'wx',mode:0o600})
    try{writeFileSync(join(directory,`${id}.json`),JSON.stringify(metadata),{flag:'wx',mode:0o600})}catch(error){rmSync(join(directory,`${id}.body`));throw error}
    this.cleanup()
    return {$cachedBody:{id,runId,bytes:bytes.length,sha256,contentType,preview:Buffer.from(bytes).toString('utf8').slice(0,2000)}}
  }
  private file(path:string,limit:number):Buffer {
    const info=stat(path)
    if(!info)throw new CachedBodyError(missing)
    if(!info.isFile()||info.isSymbolicLink()||info.size>limit)throw new CachedBodyError('HTTP 缓存文件无效或超限')
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW)
    try{const current=fstatSync(fd);if(current.dev!==info.dev||current.ino!==info.ino||current.size>limit)throw new CachedBodyError('HTTP 缓存文件身份已变化');return readFileSync(fd)}finally{closeSync(fd)}
  }
  read(runId:string,ref:CachedBody):Buffer {
    if(!isCachedBody(ref)||!identity(ref.$cachedBody.id)||ref.$cachedBody.runId!==runId||!this.runs().some(run=>run.id===runId))throw new CachedBodyError(missing)
    const r=ref.$cachedBody,directory=this.folder(runId);let meta
    try{meta=JSON.parse(this.file(join(directory,`${r.id}.json`),HTTP_DOWNLOAD_LIMIT).toString('utf8'))}catch(error){if(error instanceof CachedBodyError)throw error;throw new CachedBodyError('HTTP 缓存元数据无效，请重跑抓取节点')}
    if(!meta||typeof meta!=='object')throw new CachedBodyError('HTTP 缓存元数据无效，请重跑抓取节点')
    if(meta.runId!==runId||meta.id!==r.id||meta.bytes!==r.bytes||meta.sha256!==r.sha256||meta.contentType!==r.contentType||typeof meta.nodeId!=='string'||!Number.isSafeInteger(meta.attempt)||typeof meta.createdAt!=='string')throw new CachedBodyError('HTTP 缓存身份校验失败，请重跑抓取节点')
    const bytes=this.file(join(directory,`${r.id}.body`),HTTP_DOWNLOAD_LIMIT)
    if(bytes.length!==r.bytes||digest(bytes)!==r.sha256)throw new CachedBodyError('HTTP 缓存字节数或 sha256 校验失败，请重跑抓取节点')
    return bytes
  }
  available(runId:string,ref:CachedBody):boolean {
    try{if(!identity(ref.$cachedBody.id)||ref.$cachedBody.runId!==runId)return false;const info=stat(join(this.folder(runId),`${ref.$cachedBody.id}.body`));return !!info?.isFile()&&!info.isSymbolicLink()}catch{return false}
  }
  remove(runId:string):void {
    if(!identity(runId))return
    const base=join(this.directory,'http-cache');if(!stat(base))return
    this.folder();const path=join(base,runId),info=stat(path)
    if(!info)return
    this.folder(runId);rmSync(path,{recursive:true})
  }
  cleanup():void {
    if(!stat(join(this.directory,'http-cache')))return
    const directory=this.folder(),runs=this.runs(),byId=new Map(runs.map(run=>[run.id,run]))
    const settings=this.settings(),quota=settings.httpCacheLimitMB*1_000_000
    const entries=readdirSync(directory).map(id=>{
      const path=this.folder(id),run=byId.get(id)
      const bytes=readdirSync(path).reduce((sum,name)=>{const info=stat(join(path,name));if(info?.isSymbolicLink()||!info?.isFile())throw new CachedBodyError('HTTP 缓存文件无效');return sum+info.size},0)
      return {id,run,bytes}
    })
    let total=entries.reduce((sum,item)=>sum+item.bytes,0)
    const finished=entries.filter(item=>!item.run||!active.has(item.run.status)).sort((a,b)=>(a.run?.endedAt??a.run?.startedAt??'').localeCompare(b.run?.endedAt??b.run?.startedAt??'')||a.id.localeCompare(b.id))
    for(const item of finished)if(!item.run||settings.httpCacheImmediateCleanup||total>quota){this.remove(item.id);total-=item.bytes}
  }
}
