// Read-only collection for one explicitly authorized synthetic workspace/root.
// Only routing headers/prefixes are inspected before ownership is established;
// unrelated full session histories and run records are never parsed.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

export const scope={workspaceId:'b1cafa50-75a7-4960-a949-18df8b1954d8',rootSessionId:'session-e0a9d38e-85a3-46cb-a446-19e55d465a3d',workspaceRoot:'/private/tmp/dsh-backend-batch2-acceptance-20261019'}
const repo=path.resolve(import.meta.dirname,'../..'),state=path.join(os.homedir(),'.dsh/visible-dynamic-workflows')
const sessionsDirectory=path.join(os.homedir(),'.dsh/sessions/--private-tmp-dsh-backend-batch2-acceptance-20261019--')
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value)
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
export function scrub(value){
  if(typeof value==='string'){
    try {const parsed=JSON.parse(value);if(parsed&&typeof parsed==='object')return JSON.stringify(scrub(parsed))}catch{}
    return value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,'Bearer [redacted]').replace(/([?&](?:token|api_key|access_token)=)[^\s&#]+/gi,'$1[redacted]')
  }
  if(Array.isArray(value))return value.map(scrub)
  if(!value||typeof value!=='object')return value
  return Object.fromEntries(Object.entries(value).flatMap(([key,item])=>{
    if(/^(?:thinking|reasoning|analysis|replayState|requestDump|rawRequest|requestHeader|systemPrompt)$/i.test(key))return []
    return [[key,/^(?:authorization|password|passwd|token|bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|cookie|secret|credentials?)$/i.test(key)?'[redacted]':scrub(item)]]
  }))
}
function readBytes(file,maximum=64*1024*1024,prefix=false){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)
  try{const stat=fs.fstatSync(fd);assert(stat.isFile()&&(!stat.size||stat.size<=maximum||prefix),'Invalid bounded evidence file');const bytes=Buffer.alloc(Math.min(stat.size,maximum));let offset=0;while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)break;offset+=n}return bytes.subarray(0,offset)}finally{fs.closeSync(fd)}
}
function sessionFile(id){assert(safeId(id));const dir=path.join(sessionsDirectory,id);assert(!fs.lstatSync(dir).isSymbolicLink());return path.join(dir,'session.v4.jsonl.zstd')}
function sessionHeader(id){
  const first=zlib.zstdDecompressSync(readBytes(sessionFile(id),65536,true),{maxOutputLength:65536}).toString('utf8').split('\n',1)[0]
  const header=JSON.parse(first);assert(header.type==='session'&&header.version===4&&header.id===id);return header
}
export function ownRows(header,rows){
  if(!header.isSeeded)return rows
  const end=rows.findLastIndex(row=>row.type==='session/end-seed'&&row.data?.inherited===true)
  assert(end>=0,'Seed boundary missing; do not mix inherited histories');return rows.slice(end+1)
}
export function publicEvents(rows){
  const calls=new Map(rows.filter(row=>row.type==='tool/call').map(row=>[row.data?.callId,row.data?.name]))
  return rows.flatMap(row=>{
    const data=row.data??{},meta={seq:row.seq,time:row.time,type:row.type}
    if(row.type==='tool/call')return [{...meta,turn:data.turn,step:data.step,callId:data.callId,name:data.name,arguments:scrub(data.arguments)}]
    if(row.type==='tool/result'&&calls.has(data.message?.toolCallId))return [{...meta,turn:data.turn,step:data.step,name:calls.get(data.message.toolCallId),message:{id:data.message.id,toolCallId:data.message.toolCallId,isError:data.message.isError,content:scrub((data.message.content??[]).filter(block=>block.type==='text').map(block=>({type:'text',text:block.text})))},...(data.error?{error:scrub(data.error)}:{})}]
    if(['assistant/message','assistant/attempt'].includes(row.type)){
      const usage=data.usage??(data.stream??[]).filter(item=>item.type==='chunk'&&item.chunk?.type==='usage').at(-1)?.chunk?.usage
      return [{...meta,turn:data.turn,step:data.step,usage:usage??null}]
    }
    if(['subagent/start','subagent/end','subagent/descriptor','subagent/catalog'].includes(row.type))return [{...meta,data:scrub(Object.fromEntries(['id','childId','runId','parentSession','provider','local','label','stopReason'].filter(key=>data[key]!==undefined).map(key=>[key,data[key]])))}]
    if(['turn/start','turn/end','step/start','step/end','model/selection'].includes(row.type))return [{...meta,turn:data.turn,step:data.step,reason:data.reason?{kind:data.reason.kind,code:data.reason.code}:undefined,model:row.type==='model/selection'?scrub(data):undefined}]
    return []
  })
}
function readSession(id,header){
  const bytes=readBytes(sessionFile(id)),chunks=[];let offset=0
  while(offset<bytes.length){const part=zlib.zstdDecompressSync(bytes.subarray(offset),{info:true,maxOutputLength:128*1024*1024});assert(part.engine.bytesWritten>0);offset+=part.engine.bytesWritten;chunks.push(part.buffer)}
  const lines=Buffer.concat(chunks).toString('utf8').trim().split('\n').filter(Boolean),actual=JSON.parse(lines.shift());assert.equal(actual.id,header.id)
  // Parse only selected histories. Projection discards all assistant text,
  // request dumps, system/developer messages and non-text tool attachments.
  const rows=ownRows(actual,lines.map(line=>JSON.parse(line)))
  return {id,role:id===scope.rootSessionId?'root':'descendant',parentSession:header.parentSession,createdAt:header.createdAt,sha256:hash(bytes),events:publicEvents(rows)}
}

// Structural JSON slicing: only scalar routing fields are parsed before a
// workspace/session ownership match. Other records are not JSON.parse'd.
const ws=(text,i)=>{while(/\s/.test(text[i]??'')&&i<text.length)i++;return i}
function endValue(text,start){
  let i=ws(text,start),quoted=false,escape=false,depth=0
  if(!['{','[','"'].includes(text[i])){while(i<text.length&&!/[\s,}\]]/.test(text[i]))i++;return i}
  for(;i<text.length;i++){const c=text[i];if(quoted){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"'){quoted=false;if(!depth)return i+1}}else if(c==='"')quoted=true;else if(c==='{'||c==='[')depth++;else if(c==='}'||c===']'){if(--depth===0)return i+1}}
  throw Error('Incomplete JSON value')
}
export function fields(text){
  const result=new Map();let i=ws(text,0);if(text[i++]!=='{')return result
  while(i<text.length){i=ws(text,i);if(text[i]==='}')break;let end
    try{end=endValue(text,i);const key=JSON.parse(text.slice(i,end));i=ws(text,end);assert.equal(text[i++],':');const start=ws(text,i);end=endValue(text,start);result.set(key,text.slice(start,end));i=ws(text,end);if(text[i++]!==',')break}catch{break}
  }return result
}
export function selectedRecords(file,key,accept){
  if(!fs.existsSync(file))return []
  const text=readBytes(file).toString('utf8'),array=fields(text).get(key);if(!array)return []
  const values=[];let i=ws(array,1)
  while(i<array.length&&array[i]!==']'){const end=endValue(array,i),raw=array.slice(i,end),routing=fields(raw),scalar=name=>{const value=routing.get(name);return value&&/^(?:"|null|true|false|-?\d)/.test(value)?JSON.parse(value):undefined}
    if(accept(scalar))values.push(JSON.parse(raw));i=ws(array,end);if(array[i]===',')i=ws(array,i+1);else break
  }return values
}
export function collect(){
  const capturedAt=new Date().toISOString(),label=capturedAt.replace(/[-:.]/g,'')+'-'+crypto.randomBytes(3).toString('hex'),out=path.join(repo,'docs/evidence/backend-batch2-20261019/live',label)
  fs.mkdirSync(path.dirname(out),{recursive:true});fs.mkdirSync(out,{mode:0o700})
  const save=(name,value)=>fs.writeFileSync(path.join(out,name),JSON.stringify(scrub(value),null,2)+'\n',{flag:'wx',mode:0o600})
  const headers=new Map(),pending=[]
  for(const entry of fs.readdirSync(sessionsDirectory,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink()&&safeId(entry.name)){
    try{headers.set(entry.name,sessionHeader(entry.name))}catch{pending.push({kind:'header',id:entry.name,reason:'header-not-ready-or-unsupported'})}
  }
  const root=headers.get(scope.rootSessionId);assert(root,'Authorized root is not readable');assert.equal(path.resolve(root.cwd),scope.workspaceRoot)
  const owned=new Set([scope.rootSessionId]);let changed=true
  while(changed){changed=false;for(const[id,header]of headers)if(!owned.has(id)&&owned.has(header.parentSession)&&(!header.cwd||path.resolve(header.cwd)===scope.workspaceRoot)){owned.add(id);changed=true}}
  const sessions=[]
  for(const id of owned)try{sessions.push(readSession(id,headers.get(id)))}catch{pending.push({kind:'session',id,reason:'snapshot-write-in-progress-or-invalid'})}
  const inWorkspace=scalar=>scalar('workspaceId')===scope.workspaceId
  const tasks=selectedRecords(path.join(state,'planning/tasks.json'),'tasks',scalar=>inWorkspace(scalar)&&owned.has(scalar('sessionId')))
  const trials=selectedRecords(path.join(state,'trials/planning/tasks.json'),'tasks',scalar=>inWorkspace(scalar)&&owned.has(scalar('rootSessionId')??scalar('sessionId')))
  const workflows=selectedRecords(path.join(state,'library.json'),'workflows',inWorkspace),runs=[]
  const runDirectory=path.join(state,'runs')
  for(const file of fs.readdirSync(runDirectory)){if(!/^[A-Za-z0-9_-]+\.json$/.test(file))continue
    const filename=path.join(runDirectory,file),prefix=readBytes(filename,16384,true).toString('utf8'),routing=fields(prefix),workspace=routing.get('workspaceId')
    if(!workspace||JSON.parse(workspace)!==scope.workspaceId)continue
    try{const bytes=readBytes(filename),run=JSON.parse(bytes);assert.equal(run.workspaceId,scope.workspaceId);assert(safeId(run.id));const eventFile=path.join(runDirectory,run.id+'.events.jsonl')
      const events=fs.existsSync(eventFile)?readBytes(eventFile).toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)):[]
      runs.push({...run,evidence:{snapshotSha256:hash(bytes)},events})
    }catch{pending.push({kind:'run',id:file.slice(0,-5),reason:'snapshot-write-in-progress-or-invalid'})}
  }
  const taskFields=['id','workspaceId','sessionId','rootSessionId','childSessionId','request','spec','state','revision','createdAt','updatedAt','compilerMode','compilerSelection','compilerMetrics','diagnostics','steps','childAttempts','candidateAttempts','questionRounds','answers','events','spentTokens','unknownUsageCalls','pendingUsageCalls','candidate','candidateDigest','readiness','receipt','compilerDraft','verification','acceptance','planningTaskId']
  const projectTask=task=>({...Object.fromEntries(taskFields.filter(key=>task[key]!==undefined).map(key=>[key,task[key]])),...(task.context?{contextProjection:{model:task.context.model,effort:task.context.effort,baseline:{id:task.context.workflow?.id,revision:task.context.workflow?.revision},toolOutputs:task.context.toolOutputs,trial:task.context.trial}}:{})})
  save('public-events.json',{capturedAt,...scope,sessions});save('planning.json',tasks.map(projectTask));save('trials.json',trials.map(projectTask));save('workflows.json',workflows);save('runs.json',runs)
  const summary={capturedAt,...scope,outputDirectory:path.relative(repo,out),sessions:sessions.map(session=>({id:session.id,parentSession:session.parentSession,events:session.events.length})),planning:tasks.map(task=>({id:task.id,state:task.state})),trials:trials.map(task=>({id:task.id,state:task.state})),workflows:workflows.map(flow=>({id:flow.id,revision:flow.revision})),runs:runs.map(run=>({id:run.id,workflowId:run.workflowId,status:run.status,executionIds:run.executions?.map(item=>item.executionId??item.nodeId)})),pending,limits:['Only this workspace and root lineage session bodies are read. Other session headers and run routing prefixes are metadata only.','Assistant text/reasoning, request dumps and non-text attachments excluded. Secret-shaped keys and bearer/query credentials are redacted; automatic redaction is not a general secrecy proof.','SDK start/end captured only if persisted in these selected session logs; absent live-only events remain unobserved.','Snapshots taken while Desktop writes may be pending; no result is inferred from an unfinished snapshot.']}
  save('summary.json',summary);return summary
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const summary=collect();console.log(JSON.stringify({capturedAt:summary.capturedAt,outputDirectory:summary.outputDirectory,sessions:summary.sessions.length,planning:summary.planning,trials:summary.trials,workflows:summary.workflows.length,runs:summary.runs.map(({id,status})=>({id,status})),pending:summary.pending},null,2))}catch(error){console.error(JSON.stringify({status:'failed',reason:'READ_ONLY_COLLECTION_FAILED',errorType:error?.name??'Error'}));process.exitCode=1}
}
