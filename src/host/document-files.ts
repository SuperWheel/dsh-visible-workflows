import { open, realpath, stat } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { isAbsolute, relative, resolve, extname, sep } from 'node:path'
import type { JsonValue } from '../shared/types.ts'
type Data = Record<string,JsonValue>
const MAX = 2_000_000
const MAX_LOCAL = 10_000_000

export interface DocumentSource { value: JsonValue; name: string; bytes?: Buffer; identity?: { dev: number; ino: number; size: number } }
const LOCAL_TEXT_SUFFIXES=new Set(['.txt','.md','.markdown','.csv','.tsv','.json','.yaml','.yml','.xml','.html','.htm','.log'])
/** Formats the document node's local mode reads as UTF-8 text. */
export const isLocalTextDocument=(name:string)=>LOCAL_TEXT_SUFFIXES.has(extname(name).toLowerCase())
export async function prepareDocumentSources(workspaceRoot:string,source:JsonValue,signal:AbortSignal):Promise<DocumentSource[]> {
  const values=Array.isArray(source)?source:[source]
  if(!values.length||values.length>20)throw new Error('一次请选择 1 至 20 个文档')
  const prepared:DocumentSource[]=[];let uploadBytes=0
  for(const value of values){
    signal.throwIfAborted()
    const file=value&&typeof value==='object'&&!Array.isArray(value)?value:undefined
    if(file&&typeof file.base64==='string'){
      const raw=file.base64.replace(/^data:[^,]*;base64,/, '')
      if(!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)||raw.length>2_800_000)throw new Error('附件不是有效 base64 或超过 2 MB')
      const bytes=Buffer.from(raw,'base64');uploadBytes+=bytes.length
      if(bytes.toString('base64').replace(/=+$/,'')!==raw.replace(/=+$/,''))throw new Error('附件不是有效 base64')
      if(uploadBytes>MAX)throw new Error('上传附件总计最多 2 MB')
      const name=typeof file.name==='string'?file.name:'document.txt'
      if(!name||name.length>500||name.includes('\0'))throw new Error('附件名称无效')
      prepared.push({name,bytes,value:{name,mimeType:typeof file.mimeType==='string'?file.mimeType:'application/octet-stream',base64:bytes.toString('base64')}})
    }else{
      const path=typeof value==='string'?value:file&&typeof file.path==='string'?file.path:''
      if(!path||path.includes('\0'))throw new Error('文档来源必须为工作区文件路径或上传附件')
      const root=await realpath(workspaceRoot),target=await realpath(resolve(root,path)),rel=relative(root,target)
      if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error('只能读取当前工作区内文档，不允许符号链接越界')
      const info=await stat(target);if(!info.isFile()||info.size>MAX_LOCAL)throw new Error('需要不超过 10 MB 的本地文件')
      prepared.push({name:rel,value:target,identity:{dev:info.dev,ino:info.ino,size:info.size}})
    }
  }
  signal.throwIfAborted();return prepared
}
export function documentResult(output:string,sources:DocumentSource[]):Data {
  if(Buffer.byteLength(output)>MAX)throw new Error('提取文本超过 2 MB')
  return {text:output,source:sources.length===1?sources[0]!.name:sources.map(s=>s.name),characters:output.length}
}
async function readLocalDocument(workspaceRoot:string,item:DocumentSource,signal:AbortSignal):Promise<Buffer> {
  const root=await realpath(workspaceRoot),target=String(item.value)
  signal.throwIfAborted()
  const file=await open(target,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW??0))
  try{
    const info=await file.stat(),identity=item.identity
    if(!info.isFile()||info.size>MAX_LOCAL)throw new Error('需要不超过 10 MB 的本地文件')
    if(!identity||info.dev!==identity.dev||info.ino!==identity.ino||info.size!==identity.size)throw new Error('文档文件身份已变化，请重新选择文件')
    const rel=relative(root,await realpath(target))
    if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error('只能读取当前工作区内文档，不允许符号链接越界')
    // A file can grow after fstat. Read only through this validated handle and
    // cap all reads together at the limit plus one byte to detect that case.
    const bytes=Buffer.alloc(MAX_LOCAL+1);let length=0
    while(length<bytes.length){
      signal.throwIfAborted()
      const result=await file.read(bytes,length,Math.min(64*1024,bytes.length-length),length)
      if(!result.bytesRead)break
      length+=result.bytesRead
    }
    signal.throwIfAborted()
    if(length>MAX_LOCAL)throw new Error('需要不超过 10 MB 的本地文件')
    return bytes.subarray(0,length)
  }finally{await file.close()}
}
/** Lightweight extraction only: complex formats are routed explicitly to a selected DSH tool/Agent. */
export async function extractDocument(workspaceRoot:string,source:JsonValue,signal:AbortSignal):Promise<Data> {
  const sources=await prepareDocumentSources(workspaceRoot,source,signal),documents:Data[]=[]
  for(const item of sources){
    signal.throwIfAborted();const suffix=extname(item.name).toLowerCase()
    if(!LOCAL_TEXT_SUFFIXES.has(suffix))throw new Error(`轻量本地解析不支持 ${suffix||'无扩展名'}；PDF、DOCX、图片等请改选「指定工具」或「Agent」解析`)
    const bytes=item.bytes??await readLocalDocument(workspaceRoot,item,signal)
    let output:string
    try{output=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw new Error('文件不是有效 UTF-8 文本，请改选指定工具或 Agent 解析')}
    if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(output))throw new Error('文件包含二进制内容，不能按纯文本解析；请选择指定工具或 Agent')
    if(['.html','.htm'].includes(suffix))output=output.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    documents.push(documentResult(output,[item]))
  }
  signal.throwIfAborted()
  return Array.isArray(source)?{...documentResult(documents.map(d=>String(d.text)).join('\n\n'),sources),documents}:documents[0]!
}
/** Verify actual readable artifacts; declarative output claims never count as a successful file check. */
export async function verifyRequiredFiles(workspaceRoot:string,paths:readonly string[],signal:AbortSignal):Promise<void> {
  if(paths.length>50)throw new Error('产物验证一次最多检查 50 个文件')
  const root=await realpath(workspaceRoot)
  for(const path of paths){
    signal.throwIfAborted()
    if(!path||path.includes('\0')||isAbsolute(path))throw new Error('产物验证只接受当前工作区内的相对文件路径')
    const requested=resolve(root,path),requestedRelative=relative(root,requested)
    if(requestedRelative==='..'||requestedRelative.startsWith(`..${sep}`)||isAbsolute(requestedRelative))throw new Error('产物验证路径不能越出当前工作区')
    let target:string
    try{target=await realpath(requested)}catch{throw new Error(`产物验证失败：文件不存在或不可访问（${path}）`)}
    const rel=relative(root,target)
    if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error(`产物验证失败：符号链接越出当前工作区（${path}）`)
    // Resolve the approved target, then refuse a last-component link substituted before open.
    let file:Awaited<ReturnType<typeof open>>|undefined
    try{
      file=await open(target,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW??0))
      const info=await file.stat()
      if(!info.isFile())throw new Error('不是普通文件')
      await file.read(Buffer.alloc(1),0,1,0)
      signal.throwIfAborted()
    }catch(error){if(signal.aborted)signal.throwIfAborted();throw new Error(`产物验证失败：无法读取文件（${path}）：${error instanceof Error?error.message:'读取失败'}`)}
    finally{await file?.close()}
  }
}
