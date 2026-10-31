import { open, realpath } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { JsonValue } from '../shared/types.ts'
type Data = Record<string,JsonValue>
const MAX = 200_000_000

/** builtin:file.stat — exact byte size and line breaks of one workspace file.
 * Read and document nodes hand back decoded text (BOM and CR may be gone), so
 * counts derived from that text are not the file's (Desktop r48). */
export async function statWorkspaceFile(workspaceRoot:string,path:string,signal:AbortSignal):Promise<Data> {
  if(!path||path.includes('\0'))throw new Error('path 必须是当前工作区内的文件路径')
  const root=await realpath(workspaceRoot),requested=resolve(root,path),within=(base:string,target:string)=>{const rel=relative(base,target);return rel!==''&&rel!=='..'&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel)},inside=(target:string)=>within(root,target)
  // An absolute path may spell the workspace as configured, before its own links resolve.
  if(!inside(requested)&&!(isAbsolute(path)&&within(resolve(workspaceRoot),path)))throw new Error('只能统计当前工作区内的文件')
  let target:string
  try{target=await realpath(requested)}catch{throw new Error(`文件不存在或不可访问：${path}`)}
  if(!inside(target))throw new Error('只能统计当前工作区内的文件，不允许符号链接越界')
  signal.throwIfAborted()
  const file=await open(target,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW??0))
  try{
    const info=await file.stat()
    if(!info.isFile())throw new Error(`不是普通文件：${path}`)
    if(info.size>MAX)throw new Error('文件超过 200 MB，不统计')
    const chunk=Buffer.alloc(64*1024),head:number[]=[]
    let bytes=0,breaks=0,lf=0,crlf=0,cr=0,pendingCr=false,last=-1
    while(true){
      signal.throwIfAborted()
      const {bytesRead}=await file.read(chunk,0,chunk.length,bytes)
      if(!bytesRead)break
      for(let index=0;index<bytesRead;index++){
        const byte=chunk[index]!
        if(head.length<3)head.push(byte)
        if(byte===0x0a){if(pendingCr){crlf++;cr--}else{lf++;breaks++}pendingCr=false}
        else{pendingCr=byte===0x0d;if(pendingCr){cr++;breaks++}}
        last=byte
      }
      bytes+=bytesRead
      if(bytes>MAX)throw new Error('文件超过 200 MB，不统计')
    }
    const endsWithNewline=last===0x0a||last===0x0d,lines=breaks+(bytes&&!endsWithNewline?1:0)
    const kinds=[lf&&'lf',crlf&&'crlf',cr&&'cr'].filter((kind):kind is string=>!!kind),lineEnding=kinds.length>1?'mixed':kinds[0]??'none'
    const bom=head[0]===0xef&&head[1]===0xbb&&head[2]===0xbf,shown=relative(root,target).split(sep).join('/')
    return {text:`${shown}：${bytes} 字节，${lines} 行，行尾 ${lineEnding}${bom?'，有 UTF-8 BOM':''}`,path:shown,name:basename(target),bytes,lines,lineEnding,endsWithNewline,bom}
  }finally{await file.close()}
}
