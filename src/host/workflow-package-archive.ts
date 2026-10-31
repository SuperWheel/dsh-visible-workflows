import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { z } from 'zod'
import { exportWorkflowPackage, isFileReference, parseWorkflowPackage } from '../shared/workflow-format.ts'
import { allNodes } from '../shared/workflow-validation.ts'
import type { RolePreset, Workflow } from '../shared/types.ts'

export const ARCHIVE_LIMITS = { archive:32_000_000, file:8_000_000, assets:16_000_000, entries:202, files:200 } as const
const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const utf8=new TextDecoder('utf-8',{fatal:true})
const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0})
const crc32=(bytes:Uint8Array)=>{let crc=0xffffffff;for(const b of bytes)crc=(crc>>>8)^crcTable[(crc^b)&255]!;return (crc^0xffffffff)>>>0}
const safeEntry=(name:string)=>name.length>0&&name.length<=512&&!name.includes('\\')&&!name.includes('\0')&&!name.startsWith('/')&&!name.split('/').some(p=>!p||p==='.'||p==='..')&&!/^[A-Za-z]:/.test(name)
function safeFilename(name:string):string {
  let result='',bytes=0
  for(const char of name.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_')){
    const size=Buffer.byteLength(char);if(bytes+size>180)break
    result+=char;bytes+=size
  }
  return result||'file'
}

/** Small, bounded ZIP writer. Stored entries avoid a second compression runtime in the plugin. */
export function writeWorkflowZip(entries:ReadonlyMap<string,Uint8Array>):Buffer {
  if(entries.size>ARCHIVE_LIMITS.entries)throw new Error('流程包文件数量超过限制')
  const local:Buffer[]=[],central:Buffer[]=[];let offset=0
  for(const [name,bytes]of entries){
    if(!safeEntry(name)||bytes.length>ARCHIVE_LIMITS.file)throw new Error('流程包文件名称或大小不符合限制')
    const path=Buffer.from(name),data=Buffer.from(bytes),crc=crc32(data),header=Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(path.length,26)
    const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800,8);record.writeUInt32LE(crc,16);record.writeUInt32LE(data.length,20);record.writeUInt32LE(data.length,24);record.writeUInt16LE(path.length,28);record.writeUInt32LE(offset,42)
    local.push(header,path,data);central.push(record,path);offset+=header.length+path.length+data.length
  }
  const index=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.size,8);end.writeUInt16LE(entries.size,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16)
  const zip=Buffer.concat([...local,index,end]);if(zip.length>ARCHIVE_LIMITS.archive)throw new Error('完整流程包不能超过 32 MB');return zip
}

/** Reads only bounded regular-file entries. It never extracts caller-controlled paths. */
export function readWorkflowZip(bytes:Uint8Array):Map<string,Buffer> {
  const zip=Buffer.from(bytes)
  if(zip.length>ARCHIVE_LIMITS.archive||zip.length<22)throw new Error('流程包大小无效（上限 32 MB）')
  let end=-1
  for(let i=zip.length-22;i>=Math.max(0,zip.length-65557);i--)if(zip.readUInt32LE(i)===0x06054b50&&i+22+zip.readUInt16LE(i+20)===zip.length){end=i;break}
  if(end<0)throw new Error('不是有效的 ZIP 流程包')
  const count=zip.readUInt16LE(end+10),indexSize=zip.readUInt32LE(end+12),indexOffset=zip.readUInt32LE(end+16)
  if(zip.readUInt16LE(end+4)||zip.readUInt16LE(end+6)||count!==zip.readUInt16LE(end+8)||count>ARCHIVE_LIMITS.entries||indexOffset+indexSize!==end)throw new Error('不支持分卷、ZIP64 或不完整的流程包')
  const result=new Map<string,Buffer>(),ranges:{start:number;end:number}[]=[];let cursor=indexOffset,total=0
  for(let i=0;i<count;i++){
    if(cursor+46>end||zip.readUInt32LE(cursor)!==0x02014b50)throw new Error('流程包目录损坏')
    const flags=zip.readUInt16LE(cursor+8),method=zip.readUInt16LE(cursor+10),crc=zip.readUInt32LE(cursor+16),packed=zip.readUInt32LE(cursor+20),size=zip.readUInt32LE(cursor+24),nameSize=zip.readUInt16LE(cursor+28),extra=zip.readUInt16LE(cursor+30),comment=zip.readUInt16LE(cursor+32),offset=zip.readUInt32LE(cursor+42)
    if(cursor+46+nameSize+extra+comment>end||flags&~0x808||![0,8].includes(method)||size>ARCHIVE_LIMITS.file||packed>ARCHIVE_LIMITS.archive||zip.readUInt16LE(cursor+34)||((zip.readUInt32LE(cursor+38)>>>16)&0xf000)===0xa000)throw new Error('流程包含不支持、加密、链接或过大的文件')
    const name=utf8.decode(zip.subarray(cursor+46,cursor+46+nameSize));cursor+=46+nameSize+extra+comment
    if(!safeEntry(name)||result.has(name)||offset+30>indexOffset||zip.readUInt32LE(offset)!==0x04034b50)throw new Error('流程包存在非法路径、重复文件或无效入口')
    const localNameSize=zip.readUInt16LE(offset+26),localExtra=zip.readUInt16LE(offset+28),start=offset+30+localNameSize+localExtra
    if(start+packed>indexOffset||zip.readUInt16LE(offset+6)!==flags||zip.readUInt16LE(offset+8)!==method||utf8.decode(zip.subarray(offset+30,offset+30+localNameSize))!==name)throw new Error('流程包文件与目录不一致')
    const payload=zip.subarray(start,start+packed)
    let content:Buffer
    try{content=method===0?Buffer.from(payload):inflateRawSync(payload,{maxOutputLength:Math.max(1,size)})}catch{throw new Error('流程包解压失败或超过声明大小')}
    if(content.length!==size||crc32(content)!==crc)throw new Error('流程包文件校验失败')
    total+=size;if(total>ARCHIVE_LIMITS.assets+ARCHIVE_LIMITS.file)throw new Error('流程包解压后的总大小超过限制')
    ranges.push({start:offset,end:start+packed});result.set(name,content)
  }
  ranges.sort((a,b)=>a.start-b.start)
  if(cursor!==end||ranges.some((range,i)=>i>0&&range.start<ranges[i-1]!.end))throw new Error('流程包目录或数据区域重叠')
  return result
}

const attachmentSchema=z.object({workflowId:z.string().min(1).max(160),nodeId:z.string().min(1).max(160),field:z.enum(['source','sources','requiredReadFiles']),index:z.number().int().nonnegative().max(1000).optional(),name:z.string().min(1).max(255),path:z.string().min(1).max(512),size:z.number().int().nonnegative().max(ARCHIVE_LIMITS.file),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
const manifestSchema=z.object({format:z.literal('dsh-workflow-attachments'),version:z.literal(1),files:z.array(attachmentSchema).max(ARCHIVE_LIMITS.files)}).strict()
export type WorkflowAttachment=z.infer<typeof attachmentSchema>
type Package=ReturnType<typeof parseWorkflowPackage>
const packageFlows=(pkg:Package)=>[pkg.workflow,...((pkg as Package&{workflows?:Workflow[]}).workflows??[])]
function slot(flow:Workflow,item:WorkflowAttachment){
  const node=allNodes(flow).find(n=>n.id===item.nodeId)
  if(!node)throw new Error('附件引用的节点不存在')
  if(item.field==='source'){if(node.kind!=='document'||item.index!==undefined)throw new Error('附件来源字段不匹配');return {set:(path:string)=>{node.config.source=path}}}
  const values=item.field==='sources'?node.kind==='knowledge'?node.config.sources:undefined:node.config.verification?.requiredReadFiles
  if(item.index===undefined||!values||item.index>=values.length)throw new Error('附件列表字段不匹配')
  return {set:(path:string)=>{values[item.index!]=path}}
}
function sourceSlots(flow:Workflow){
  return allNodes(flow).flatMap(node=>[
    ...(node.kind==='document'&&node.config.source&&!isFileReference(node.config.source,flow)?[{nodeId:node.id,field:'source' as const,source:node.config.source}]:[]),
    ...(node.kind==='knowledge'?(node.config.sources??[]).flatMap((source,index)=>source&&!isFileReference(source,flow)?[{nodeId:node.id,field:'sources' as const,index,source}]:[]):[]),
    ...(node.config.verification?.requiredReadFiles??[]).map((source,index)=>({nodeId:node.id,field:'requiredReadFiles' as const,index,source})),
  ])
}
async function readSource(root:string,path:string):Promise<Buffer>{
  const base=await realpath(root),resolved=await realpath(isAbsolute(path)?path:resolve(base,path)),rel=relative(base,resolved)
  if(!rel||rel==='..'||rel.startsWith(`..${process.platform==='win32'?'\\':'/'}`)||isAbsolute(rel))throw new Error('只能附带当前工作区内的资料文件')
  const expected=await stat(resolved,{bigint:true})
  const regular=(meta:BigIntStats)=>{
    if(!meta.isFile()||meta.size>BigInt(ARCHIVE_LIMITS.file))throw new Error('资料必须为普通文件，单个文件不能超过 8 MB')
    if(meta.nlink!==1n)throw new Error('资料文件存在硬链接或已移除；请先复制为工作区内的独立文件')
  }
  const unchanged=(meta:BigIntStats)=>{
    regular(meta)
    if((['dev','ino','size','mtimeNs','ctimeNs','mode'] as const).some(key=>meta[key]!==expected[key]))throw new Error('资料文件在读取期间发生变化，请重试')
  }
  regular(expected)
  // Non-blocking open also avoids hanging if a concurrent writer swaps in a FIFO.
  const handle=await open(resolved,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  let buffer:Buffer|undefined
  try{
    // Defense in depth for a direct Host read: reject observed swaps and discard
    // bytes unless both the descriptor and its path still match. These metadata
    // checks do not replace an OS-confined reader for hostile mutable parents.
    const stable=async()=>{
      unchanged(await handle.stat({bigint:true}))
      if(await realpath(root)!==base||await realpath(resolved)!==resolved)throw new Error('资料路径在读取期间发生变化，请重试')
      unchanged(await stat(resolved,{bigint:true}))
    }
    await stable()
    buffer=Buffer.alloc(ARCHIVE_LIMITS.file+1);let length=0
    while(length<buffer.length){const {bytesRead}=await handle.read(buffer,length,buffer.length-length,null);if(!bytesRead)break;length+=bytesRead}
    if(length>ARCHIVE_LIMITS.file)throw new Error('资料文件超过 8 MB')
    await stable()
    if(BigInt(length)!==expected.size)throw new Error('资料文件在读取期间发生变化，请重试')
    return Buffer.from(buffer.subarray(0,length))
  }finally{buffer?.fill(0);await handle.close()}
}

export async function createWorkflowArchive(flow:Workflow,root:string,options:{includeEnvironmentValues?:boolean;presets?:RolePreset[];workflows?:Workflow[]}={}):Promise<Buffer>{
  const pkg=exportWorkflowPackage(flow,options),files:WorkflowAttachment[]=[],entries=new Map<string,Uint8Array>(),sources=new Map([...(options.workflows??[]),flow].map(value=>[value.id,value]));let total=0
  for(const definition of packageFlows(pkg)){
    const original=sources.get(definition.id);if(!original)throw new Error('找不到随包子流程的原始定义')
    for(const value of sourceSlots(original)){
      if(files.length>=ARCHIVE_LIMITS.files)throw new Error('完整流程包最多附带 200 个资料文件')
      let bytes:Buffer
      try{bytes=await readSource(root,value.source)}catch(error){throw new Error(`${original.title} / ${allNodes(original).find(n=>n.id===value.nodeId)?.title??value.nodeId}：${error instanceof Error?error.message:'资料无法读取'}；可改用 JSON 导出并稍后选择文件`)}
      total+=bytes.length;if(total>ARCHIVE_LIMITS.assets)throw new Error('附带资料总大小不能超过 16 MB')
      const name=safeFilename(basename(value.source)),path=`files/${files.length+1}/${name}`
      files.push({workflowId:original.id,nodeId:value.nodeId,field:value.field,...('index'in value?{index:value.index}:{}),name,path,size:bytes.length,sha256:sha256(bytes)});entries.set(path,bytes)
      // A portable archive never asks the destination to read the source machine's path.
      slot(definition,files.at(-1)!).set(value.field==='requiredReadFiles'?`__WORKFLOW_FILE_REBIND_REQUIRED__/${value.nodeId}/requiredReadFiles/${value.index}`:'')
    }
  }
  const text=JSON.stringify(pkg,null,2);parseWorkflowPackage(text)
  entries.set('workflow.json',Buffer.from(text));entries.set('attachments.json',Buffer.from(JSON.stringify({format:'dsh-workflow-attachments',version:1,files},null,2)))
  return writeWorkflowZip(entries)
}

export function parseWorkflowArchive(encoded:string):{pkg:Package;files:WorkflowAttachment[];entries:Map<string,Buffer>}{
  if(encoded.length>Math.ceil(ARCHIVE_LIMITS.archive/3)*4||encoded.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new Error('流程包编码或大小无效')
  const decoded=Buffer.from(encoded,'base64');if(decoded.toString('base64')!==encoded)throw new Error('流程包编码无效')
  const entries=readWorkflowZip(decoded),definition=entries.get('workflow.json'),manifest=entries.get('attachments.json')
  if(!definition||!manifest)throw new Error('流程包缺少 workflow.json 或 attachments.json')
  const pkg=parseWorkflowPackage(utf8.decode(definition)),{files}=manifestSchema.parse(JSON.parse(utf8.decode(manifest))),flows=new Map(packageFlows(pkg).map(flow=>[flow.id,flow])),used=new Set<string>(),slots=new Set<string>();let total=0
  for(const file of files){
    const bytes=entries.get(file.path),flow=flows.get(file.workflowId),id=JSON.stringify([file.workflowId,file.nodeId,file.field,file.index])
    if(!file.path.startsWith('files/')||!bytes||!flow||used.has(file.path)||slots.has(id)||file.size!==bytes.length||file.sha256!==sha256(bytes))throw new Error('附件缺失、重复或内容摘要不一致')
    slot(flow,file);used.add(file.path);slots.add(id);total+=bytes.length
  }
  if(total>ARCHIVE_LIMITS.assets||entries.size!==files.length+2)throw new Error('流程包含未声明附件或资料过大')
  return {pkg,files,entries}
}

/** Host-private rollback ownership. Never part of the portable JSON schema. */
export const archiveReceiptSchema=z.object({directoryName:z.string().regex(/^workflow-assets-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),owner:z.string().uuid()}).strict()
export type WorkflowArchiveReceipt=z.infer<typeof archiveReceiptSchema>
const OWNER_FILE='.workflow-import-owner'
export const createWorkflowArchiveReceipt=():WorkflowArchiveReceipt=>({directoryName:`workflow-assets-${randomUUID()}`,owner:randomUUID()})

/** Must run in the same OS-confined archive worker as materialization. The
 * receipt identifies one fresh directory; it never authorizes an arbitrary path.
 * Ownership checks are defense in depth, not a substitute for OS confinement. */
export async function cleanupWorkflowArchiveMaterialization(root:string,input:WorkflowArchiveReceipt):Promise<void>{
  const receipt=archiveReceiptSchema.parse(input),base=await realpath(root),directory=join(base,receipt.directoryName)
  let before
  try{before=await lstat(directory,{bigint:true})}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
  if(!before.isDirectory()||before.isSymbolicLink())throw new Error('流程包清理目录不匹配')
  const handle=await open(join(directory,OWNER_FILE),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  try{
    const marker=await handle.stat({bigint:true})
    if(!marker.isFile()||marker.nlink!==1n||marker.size!==BigInt(Buffer.byteLength(receipt.owner)))throw new Error('流程包清理凭据不匹配')
    const bytes=Buffer.alloc(64);const {bytesRead}=await handle.read(bytes,0,bytes.length,0)
    if(bytes.subarray(0,bytesRead).toString('utf8')!==receipt.owner)throw new Error('流程包清理凭据不匹配')
    const after=await lstat(directory,{bigint:true})
    if(!after.isDirectory()||after.dev!==before.dev||after.ino!==before.ino)throw new Error('流程包清理目录已变化')
  }finally{await handle.close()}
  await rm(directory,{recursive:true,force:true})
}

/** A dedicated fresh directory provides rollback. Production read/write/removal
 * must run in the OS-confined archive worker against hostile mutable parents.
 * internal.receipt is generated only by trusted Host composition, never UI JSON. */
export async function materializeWorkflowArchive(encoded:string,root:string,internal:{receipt?:WorkflowArchiveReceipt}={}):Promise<{text:string;receipt:WorkflowArchiveReceipt|null;cleanup:()=>Promise<void>}>{
  const {pkg,files,entries}=parseWorkflowArchive(encoded),base=await realpath(root),receipt=archiveReceiptSchema.parse(internal.receipt??createWorkflowArchiveReceipt()),name=receipt.directoryName,directory=join(base,name),flows=new Map(packageFlows(pkg).map(flow=>[flow.id,flow]))
  let created=false
  const cleanup=async()=>{if(created)await cleanupWorkflowArchiveMaterialization(base,receipt)}
  try{
    if(files.length){await mkdir(directory,{mode:0o700});created=true;await writeFile(join(directory,OWNER_FILE),receipt.owner,{flag:'wx',mode:0o600})}
    for(const [index,file]of files.entries()){
      const filename=`${index+1}-${safeFilename(file.name)}`
      await writeFile(join(directory,filename),entries.get(file.path)!,{flag:'wx',mode:0o600})
      slot(flows.get(file.workflowId)!,file).set(`${name}/${filename}`)
    }
    return {text:JSON.stringify(pkg),receipt:created?receipt:null,cleanup}
  }catch(error){if(created)await rm(directory,{recursive:true,force:true});throw error}
}
