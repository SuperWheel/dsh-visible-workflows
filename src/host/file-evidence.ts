import { createHash } from 'node:crypto'
import { constants, realpathSync, type Stats } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { FileEvidenceRequirements,FileFingerprint,FileEvidenceSnapshot,NativeFileReadContract,NativeFileReadReceipt,FileEvidenceVerification } from '../shared/file-evidence.ts'
export type { FileEvidenceRequirements,FileFingerprint,FileEvidenceSnapshot,NativeFileReadContract,NativeFileReadReceipt,FileEvidenceState,FileEvidenceVerification } from '../shared/file-evidence.ts'
export interface NativeReadExecution {
  name:string;arguments:unknown;token:symbol;parent?:symbol
  agent?:{id:string;session?:{header?:{cwd?:string}}}
}
export interface NativeReadResult { isError?:boolean;value?:unknown }

const MAX_FILE_BYTES=4*1024*1024,MAX_TOTAL_BYTES=16*1024*1024,MAX_FILES=90,MAX_LINES=50_000,MAX_TOOL_RESULTS=1000
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const paths=(requirements:FileEvidenceRequirements)=>[...new Set([...(requirements.requiredFiles??[]),...(requirements.requiredReadFiles??[]),...(requirements.requiredChangedFiles??[])])].sort()
const safeRelative=(path:string)=>typeof path==='string'&&path.length>0&&path.length<=4000&&!isAbsolute(path)&&!/^\w:/.test(path)&&!path.includes('\\')&&!/[\x00-\x1f]/.test(path)&&!path.split('/').some(part=>part===''||part==='.'||part==='..')&&!path.includes('{{')&&!path.startsWith('__WORKFLOW_FILE_REBIND_REQUIRED__/')
const inside=(root:string,target:string)=>{const rel=relative(root,target);return rel!==''&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`)}
const sameFile=(a:{dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number},b:typeof a)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs
function textFingerprint(bytes:Uint8Array):FileFingerprint['text'] {
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{return}
  if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))return
  // Matches dsh-tool-fs buildWindow: a final newline does not add an empty line,
  // CRLF loses only the CR, and an empty file has zero lines.
  const lines=text===''?[]:text.split('\n');if(text.endsWith('\n'))lines.pop()
  if(lines.length>MAX_LINES)return
  return {lineCount:lines.length,digest:hash(JSON.stringify(lines.map(line=>hash(line.endsWith('\r')?line.slice(0,-1):line))))}
}
async function noLinks(root:string,path:string):Promise<Stats|undefined>{
  let target=root
  const parts=path.split('/')
  for(let i=0;i<parts.length;i++){
    target=resolve(target,parts[i]!)
    let info:Stats
    try{info=await lstat(target)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
    if(info.isSymbolicLink())throw new Error('文件路径含符号链接，无法认证工作区文件证据')
    if(i<parts.length-1&&!info.isDirectory())throw new Error('文件路径的父级不是目录')
    if(i===parts.length-1)return info
  }
}

/** Read-only bounded evidence. Rejects symlinks (including in-workspace links),
 * non-regular files, changing reads and unsafe paths. Hashes are evidence of
 * contents at capture, not a sandbox or proof of which process wrote them. */
export async function captureFileEvidence(workspaceRoot:string,requirements:FileEvidenceRequirements,signal:AbortSignal):Promise<FileEvidenceSnapshot>{
  signal.throwIfAborted()
  const requested=paths(requirements)
  if(requested.length>MAX_FILES)throw new Error(`一次文件验收最多 ${MAX_FILES} 个文件`)
  const root=await realpath(workspaceRoot),files:Record<string,FileFingerprint>=Object.create(null);let consumed=0
  for(const path of requested){
    signal.throwIfAborted();let handle:FileHandle|undefined
    try{
      if(!safeRelative(path))throw new Error('文件证据只接受当前工作区内无跳转的相对路径')
      const before=await noLinks(root,path)
      if(!before){files[path]={path,status:'missing',reason:'文件不存在'};continue}
      if(!before.isFile())throw new Error('验收目标不是普通文件')
      if(before.size>MAX_FILE_BYTES||consumed+before.size>MAX_TOTAL_BYTES)throw new Error('文件证据超过读取上限（单文件 4 MiB，总计 16 MiB）')
      const target=resolve(root,path),actual=await realpath(target)
      if(!inside(root,actual)||actual!==target)throw new Error('文件路径不在已确认的工作区内')
      handle=await open(target,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0))
      const opened=await handle.stat(),checked=await noLinks(root,path)
      if(!opened.isFile()||!checked||!sameFile(before,opened)||!sameFile(opened,checked))throw new Error('文件在校验和读取之间发生变化')
      const bytes=Buffer.alloc(opened.size);let offset=0
      while(offset<bytes.length){signal.throwIfAborted();const {bytesRead}=await handle.read(bytes,offset,Math.min(64*1024,bytes.length-offset),offset);if(!bytesRead)throw new Error('文件在读取时长度变化');offset+=bytesRead}
      consumed+=offset
      const final=await handle.stat(),latest=await noLinks(root,path)
      if(!latest||!sameFile(opened,final)||!sameFile(final,latest))throw new Error('文件在读取过程中发生变化')
      signal.throwIfAborted()
      const text=textFingerprint(bytes)
      files[path]={path,status:'present',sha256:hash(bytes),size:bytes.length,...(text?{text}:{})}
    }catch(error){signal.throwIfAborted();files[path]={path,status:'unverified',reason:error instanceof Error?error.message:'文件证据无法验证'}}
    finally{await handle?.close()}
  }
  return {version:1,workspaceRootDigest:hash(root),files}
}

interface ReadWindow {path:string;tool:string;lineCount:number;lines:Map<number,string>;reason?:string}
function relativeToolPath(root:string,value:unknown):string|undefined {
  if(typeof value!=='string'||value.includes('\0'))return
  let target:string;try{target=realpathSync(resolve(root,value))}catch{return}if(!inside(root,target))return
  const path=relative(root,target).split(sep).join('/');return safeRelative(path)?path:undefined
}
function readWindow(root:string,name:string,args:unknown,value:unknown,contract:NativeFileReadContract,snapshot:FileEvidenceSnapshot):ReadWindow|undefined {
  if(!record(args))return
  if(contract==='dsh-tool-fs/read@0.2.0-rc.2'){
    const path=relativeToolPath(root,args.file_path)
    if(!path||!record(value)||relativeToolPath(root,value.path)!==path||!Number.isSafeInteger(value.offset)||Number(value.offset)<1||!Number.isSafeInteger(value.totalLines)||Number(value.totalLines)<0||Number(value.totalLines)>MAX_LINES||!Array.isArray(value.lines)||value.lines.length>MAX_LINES)return
    if(value.offset!==(args.offset??1))return
    if(args.limit!==undefined&&(!Number.isSafeInteger(args.limit)||Number(args.limit)<1||value.lines.length>Number(args.limit)))return
    const lines=new Map<number,string>();let number=Number(value.offset),bytes=0
    for(const item of value.lines){
      if(!record(item)||item.number!==number||typeof item.text!=='string'||number>Number(value.totalLines))return
      bytes+=Buffer.byteLength(item.text);if(bytes>MAX_FILE_BYTES)return
      if(/\.\.\. \(line truncated to \d+ chars\)$/.test(item.text))return {path,tool:name,lineCount:Number(value.totalLines),lines:new Map(),reason:'读取回执包含被截断的行，不能认证完整资料'}
      lines.set(number++,hash(item.text))
    }
    return {path,tool:name,lineCount:Number(value.totalLines),lines}
  }
  if(contract==='dsh-tool-str-replace-editor/view@0.2.0-rc.2'){
    const path=relativeToolPath(root,args.path)
    if(args.command!=='view'||!path||typeof value!=='string'||Buffer.byteLength(value)>MAX_FILE_BYTES)return
    if(value.includes('<response clipped>'))return {path,tool:name,lineCount:0,lines:new Map(),reason:'查看结果被截断，不能认证完整资料'}
    // This contract intentionally accepts only complete views. A partial view
    // cannot stand in for required reading even if the tool returned success.
    if(args.view_range!==undefined&&args.view_range!==null)return {path,tool:name,lineCount:0,lines:new Map(),reason:'局部查看不能认证完整资料；请使用完整 view 或分页 read'}
    const match=/^Here's the content of (.+) with line numbers \(which has a total of (\d+) lines\):\n([\s\S]*)\n$/.exec(value)
    if(!match||relativeToolPath(root,match[1])!==path)return
    const count=Number(match[2]),lines=new Map<number,string>(),body=match[3]!.split('\n')
    if(!Number.isSafeInteger(count)||count<1||count>MAX_LINES+1||body.length!==count)return
    for(let index=0;index<body.length;index++){const line=/^\s*(\d+)  ([\s\S]*)$/.exec(body[index]!);if(!line||Number(line[1])!==index+1)return;const content=line[2]!;lines.set(index+1,hash(content.endsWith('\r')?content.slice(0,-1):content))}
    // str_replace_editor splits trailing newlines (and an empty file) into an
    // extra empty line; normalize to the read contract used by snapshots.
    if(count===(snapshot.files[path]?.text?.lineCount??-2)+1&&lines.get(count)===hash(''))lines.delete(count)
    return {path,tool:name,lineCount:lines.size,lines}
  }
}

/** Observe only final SDK tools/result callbacks from a pinned child task.
 * trustedTools must be supplied by the host after checking the installed tool
 * contract; names such as read_file or model-supplied receipts are never trusted.
 * Nested/PTC reads count only after every enclosing tool token also succeeds. */
export function createNativeFileReadCollector(options:{workspaceRoot:string;taskId:string;snapshot:FileEvidenceSnapshot;trustedTools?:Readonly<Record<string,NativeFileReadContract>>}){
  const root=realpathSync(options.workspaceRoot),observed=new Map<symbol,{parent?:symbol;ok:boolean;window?:ReadWindow}>();let overflow=false
  return {
    record(exec:NativeReadExecution,result:NativeReadResult):void{
      if(!exec.agent||exec.agent.id!==options.taskId||typeof exec.token!=='symbol'||(exec.parent!==undefined&&typeof exec.parent!=='symbol')||!exec.agent.session?.header?.cwd)return
      try{if(realpathSync(exec.agent.session.header.cwd)!==root)return}catch{return}
      if(observed.has(exec.token))return
      if(observed.size>=MAX_TOOL_RESULTS){overflow=true;return}
      const contract=options.trustedTools?.[exec.name],ok=result.isError!==true
      observed.set(exec.token,{parent:exec.parent,ok,...(ok&&contract?{window:readWindow(root,exec.name,exec.arguments,result.value,contract,options.snapshot)}:{})})
    },
    receipts():NativeFileReadReceipt[]{
      const accepted=(token:symbol,visited=new Set<symbol>()):boolean=>{if(visited.has(token))return false;visited.add(token);const event=observed.get(token);return !!event?.ok&&(event.parent===undefined||accepted(event.parent,visited))}
      const windows=[...observed].filter(([token])=>accepted(token)).map(([,event])=>event.window).filter((window):window is ReadWindow=>!!window)
      return Object.entries(options.snapshot.files).filter(([,file])=>file.text).map(([path,file])=>{
        const matches=windows.filter(window=>window.path===path),lines=new Map<number,string>(),tools=[...new Set(matches.map(window=>window.tool))].sort();let reason=overflow?'原生工具回执超过证据容量，不能认证完整读取':''
        if(hash(root)!==options.snapshot.workspaceRootDigest)reason='读取任务的工作区与文件快照不一致'
        for(const window of matches){if(window.reason)reason=window.reason;if(window.lineCount!==file.text!.lineCount)reason='读取回执的文件行数与启动快照不一致';for(const [number,digest] of window.lines){if(lines.has(number)&&lines.get(number)!==digest)reason='多次读取的同一行内容不一致';lines.set(number,digest)}}
        if(!matches.length)reason='未取得受信任原生文件工具的成功读取回执'
        const complete=lines.size===file.text!.lineCount&&hash(JSON.stringify([...lines].sort(([a],[b])=>a-b).map(([,digest])=>digest)))===file.text!.digest
        if(!complete&&!reason)reason='读取回执未完整覆盖启动快照的全部内容（可能仅局部读取或文件已改变）'
        return {path,sha256:file.sha256,taskId:options.taskId,tools,calls:matches.length,status:reason?'unverified':'passed',reason:reason||'已取得完整、成功且内容匹配的原生工具读取回执；不证明模型理解了内容'}
      })
    },
  }
}

export function evaluateFileEvidence(requirements:FileEvidenceRequirements,before:FileEvidenceSnapshot,after:FileEvidenceSnapshot,reads:NativeFileReadReceipt[]=[]):FileEvidenceVerification{
  const failures:string[]=[],unknown:string[]=[]
  if(before.workspaceRootDigest!==after.workspaceRootDigest)unknown.push('文件验收前后的工作区不一致')
  const present=(path:string,phase:'before'|'after')=>{const file=(phase==='before'?before:after).files[path];if(!file||file.status==='unverified'){unknown.push(`${path}：${file?.reason??'缺少文件指纹'}`);return false}if(file.status==='missing'){failures.push(`${path}：${phase==='before'?'执行前':'执行后'}文件不存在`);return false}return true}
  for(const path of requirements.requiredFiles??[])present(path,'after')
  for(const path of requirements.requiredChangedFiles??[]){
    if(!present(path,'after'))continue
    const initial=before.files[path],final=after.files[path]!
    if(!initial||initial.status==='unverified')unknown.push(`${path}：缺少可信执行前指纹，无法证明必要变更`)
    else if(initial.status==='present'&&initial.sha256===final.sha256)failures.push(`${path}：内容未发生必要变更（仅时间戳或重写相同内容不算变更）`)
  }
  for(const path of requirements.requiredReadFiles??[]){
    if(!present(path,'before'))continue
    const receipt=reads.find(read=>read.path===path&&read.status==='passed'&&read.sha256===before.files[path]!.sha256)
    if(!receipt)unknown.push(`${path}：${reads.find(read=>read.path===path)?.reason??'缺少可信原生读取回执；文件存在或模型自述不能证明已读'}`)
  }
  return {status:failures.length?'failed':unknown.length?'unverified':'passed',reasons:[...new Set([...failures,...unknown])],files:{before,after,reads}}
}

/** Compare completed-run fingerprints to a fresh capture before reuse. Unknown,
 * missing, newly created, deleted or changed files all invalidate dependent
 * cached results; callers propagate invalidation through the graph. */
export function compareFileEvidence(previous:FileEvidenceSnapshot|undefined,current:FileEvidenceSnapshot):{valid:boolean;changedPaths:string[];reasons:string[]}{
  const keys=[...new Set([...Object.keys(previous?.files??{}),...Object.keys(current.files)])].sort(),changedPaths:string[]=[],reasons:string[]=[]
  if(!previous||previous.workspaceRootDigest!==current.workspaceRootDigest)reasons.push('缺少原文件证据或工作区身份已变化')
  for(const path of keys){const before=previous?.files[path],after=current.files[path];if(!before||!after||before.status!=='present'||after.status!=='present'||before.sha256!==after.sha256){changedPaths.push(path);reasons.push(`${path}：${!before?'缺少来源指纹':!after?'缺少当前指纹':after.status==='missing'?'文件已缺失':before.status==='missing'?'文件从缺失变为存在':before.status==='unverified'||after.status==='unverified'?'文件内容无法验证':'文件内容已变化'}`)}}
  return {valid:reasons.length===0,changedPaths,reasons}
}
