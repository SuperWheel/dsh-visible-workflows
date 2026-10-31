// Read-only S10 incremental evidence. No dispatch, UI, network or profile writes.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {SCOPE,S10_CASES,STATE,REPO,readBytes,noSymlinks,publicSafe,ownedSessionIds,selectedRecords,fields,ownRows,sha} from './collect-planning-speed-desktop.mjs'
import {publicEvents} from './collect-backend-batch2-desktop.mjs'

export const ALLOWED_FLOWS=new Set(Object.values(S10_CASES).map(row=>row.workflowId))
export const OUTPUT=path.join(REPO,'docs/evidence/planning-speed-20261019/desktop-incremental-20261020')
const SESSIONS=path.join(os.homedir(),'.dsh/sessions/--private-tmp-dsh-planning-speed-acceptance-20261019--')
const identity=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(v)
const object=v=>v&&typeof v==='object'&&!Array.isArray(v)
const decode=v=>{try{return typeof v==='string'?JSON.parse(v):v}catch{return undefined}}
const ordered=v=>Array.isArray(v)?v.map(ordered):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v
const digest=v=>sha(JSON.stringify(ordered(v)))
const safe=value=>{
  const visit=v=>typeof v==='string'?v.replace(/<(?:think|thinking|reasoning|analysis)>[\s\S]*?<\/(?:think|thinking|reasoning|analysis)>/gi,'[private-model-text-excluded]'):Array.isArray(v)?v.map(visit):object(v)?Object.fromEntries(Object.entries(v).map(([k,item])=>[k,visit(item)])):v
  return visit(publicSafe(value))
}
export function parseArgs(args){
  const result={rootId:undefined,requestIds:[],workflowIds:[],before:undefined}
  for(let i=0;i<args.length;i+=2){const key=args[i],value=args[i+1];assert(typeof value==='string'&&!value.startsWith('--'),'Every flag needs a value')
    if(key==='--root-session-id'){assert(!result.rootId,'Duplicate root');result.rootId=value}
    else if(key==='--request-id')result.requestIds.push(value)
    else if(key==='--workflow-id')result.workflowIds.push(value)
    else if(key==='--before'){assert(!result.before,'Duplicate before');result.before=value}
    else assert.fail('Unsupported flag')
  }
  assert(identity(result.rootId),'Explicit valid root required')
  assert(result.requestIds.length>0&&result.requestIds.length<=20&&result.requestIds.every(identity)&&new Set(result.requestIds).size===result.requestIds.length,'Explicit distinct request IDs required, maximum 20')
  assert(result.workflowIds.length>0&&result.workflowIds.length<=5&&result.workflowIds.every(id=>ALLOWED_FLOWS.has(id))&&new Set(result.workflowIds).size===result.workflowIds.length,'Explicit workflow IDs must belong to the five S10 cases')
  if(result.before){const file=path.resolve(result.before);assert(file.startsWith(OUTPUT+path.sep)&&path.basename(file)==='summary.json','Before must be an incremental summary in the fixed evidence directory');noSymlinks(file);result.before=file}
  return result
}
const publicTaskFields=['taskId','requestId','workflowId','state','revision','preview','candidateDigest','summary','assumptions','questions','diagnostics','readiness','receipt','usage','events','delivery','handoff','compilerMetrics','chain','candidate','moduleProvenance','engineVersion']
export function projectPublicTask(value,workflowId){
  if(!object(value)||!identity(value.taskId)||!identity(value.requestId)||!ALLOWED_FLOWS.has(workflowId))return undefined
  if(value.workflowId!==undefined&&value.workflowId!==workflowId)return undefined
  if(value.candidate&&(value.candidate.id!==workflowId||value.candidate.workspaceId!==SCOPE.workspaceId))return undefined
  if(value.receipt?.workflowId!==undefined&&value.receipt.workflowId!==workflowId)return undefined
  return safe(Object.fromEntries(publicTaskFields.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]])))
}
const initiators=new Set(['visible_workflow_plan','visible_workflow_edit','visible_workflow_splice'])
function requestFrom(event){
  const args=decode(event.arguments);if(!object(args))return undefined
  if(event.name==='visible_workflow_plan'){const request=decode(args.request_json);return object(request)?{args,requestId:request.requestId,workflowId:request.targetWorkflowId,workspaceId:request.workspaceId,operation:request.operation}:undefined}
  if(event.name==='visible_workflow_edit'||event.name==='visible_workflow_splice')return {args,requestId:args.request_id,workflowId:args.workflow_id,workspaceId:args.workspace_id,operation:'revise'}
}
/** Only paired, real, successful root tool records bind request -> task -> flow. */
export function bindRequests(rootEvents,rootId,requestIds,workflowIds){
  assert(identity(rootId));const requests=new Set(requestIds),flows=new Set(workflowIds),calls=new Map(),bindings=Object.create(null),errors=[]
  for(const event of rootEvents){
    if(event.type==='tool/call'&&initiators.has(event.name)){
      const request=requestFrom(event);if(!requests.has(request?.requestId))continue
      if(!identity(event.callId)||!flows.has(request.workflowId)||request.operation!=='revise'||request.workspaceId!==undefined&&request.workspaceId!==SCOPE.workspaceId){errors.push({code:'EXPLICIT_REQUEST_SCOPE_MISMATCH',requestId:request.requestId,callId:event.callId});continue}
      if(calls.has(event.callId)){errors.push({code:'DUPLICATE_CALL_ID',requestId:request.requestId,callId:event.callId});continue}
      calls.set(event.callId,{requestId:request.requestId,workflowId:request.workflowId,callId:event.callId,toolName:event.name,eventSeq:event.seq,observedAt:event.time,arguments:safe(request.args),argumentSha256:digest(request.args)})
    }else if(event.type==='tool/result'&&calls.has(event.message?.toolCallId)){
      const call=calls.get(event.message.toolCallId)
      if(event.message.isError){errors.push({code:'INITIATING_TOOL_ERROR',requestId:call.requestId,callId:call.callId});continue}
      const values=(event.message.content??[]).filter(b=>b.type==='text').map(b=>projectPublicTask(decode(b.text),call.workflowId)).filter(Boolean)
      if(values.length!==1||values[0].requestId!==call.requestId){errors.push({code:'UNBOUND_RECEIPT',requestId:call.requestId,callId:call.callId});continue}
      const value=values[0],prior=bindings[call.requestId]
      if(prior&&(prior.taskId!==value.taskId||prior.workflowId!==call.workflowId)){errors.push({code:'REQUEST_IDENTITY_CONFLICT',requestId:call.requestId,callId:call.callId});continue}
      const row={...call,resultSeq:event.seq,resultObservedAt:event.time,task:value}
      if(prior)prior.receipts.push(row);else bindings[call.requestId]={requestId:call.requestId,taskId:value.taskId,workflowId:call.workflowId,receipts:[row]}
    }
  }
  return {rootId,bindings,calls:[...calls.values()],errors}
}
const controls={visible_workflow_plan_get:['task_id','include_candidates','include_metrics'],visible_workflow_plan_answer:['task_id','revision','answers_json'],visible_workflow_plan_cancel:['task_id'],visible_workflow_plan_publish:['task_id','revision','candidate_digest']}
const meta=e=>({seq:e.seq,time:e.time,type:e.type,...(e.callId?{callId:e.callId}:{}),...(e.name?{name:e.name}:{})})
export function projectRootEvents(events,bound){
  const byTask=new Map(Object.values(bound.bindings).map(b=>[b.taskId,b])),calls=new Map(bound.calls.map(c=>[c.callId,c])),seenCalls=new Set(),snapshots=[],controlCalls=[]
  for(const event of events)if(event.type==='tool/call'&&controls[event.name]){
    const args=decode(event.arguments),binding=byTask.get(args?.task_id)
    if(binding&&object(args)&&Object.keys(args).every(k=>controls[event.name].includes(k))){const call={...binding,callId:event.callId,toolName:event.name,arguments:safe(args)};calls.set(event.callId,call);controlCalls.push({sessionId:bound.rootId,...meta(event),arguments:safe(args)})}
  }
  const projected=events.map(event=>{
    if(event.type==='tool/call'){const call=calls.get(event.callId);if(call)seenCalls.add(event.callId);return call?{...meta(event),arguments:call.arguments}:{...meta(event),contentExcluded:'not-an-explicit-bound-call'}}
    if(event.type==='tool/result'){
      const call=seenCalls.has(event.message?.toolCallId)?calls.get(event.message.toolCallId):undefined,content=[]
      if(call)for(const block of event.message.content??[]){const value=projectPublicTask(decode(block.text),call.workflowId),binding=value&&bound.bindings[value.requestId];if(binding&&binding.requestId===call.requestId&&binding.taskId===value.taskId){snapshots.push({sessionId:bound.rootId,callId:event.message.toolCallId,toolName:call.toolName,eventSeq:event.seq,observedAt:event.time,task:value});content.push({type:'text',text:JSON.stringify(value)})}}
      return {...meta(event),message:{toolCallId:event.message?.toolCallId,isError:event.message?.isError,content},...(call&&event.message?.isError?{publicErrorText:safe((event.message.content??[]).filter(b=>b.type==='text').map(b=>b.text.slice(0,16000)))}:{}),...(content.length?{}:{contentExcluded:'not-a-valid-bound-task-snapshot'})}
    }
    return safe(event)
  })
  return {events:projected,taskSnapshots:snapshots,controlCalls}
}
function entries(directory,max=2000){noSymlinks(directory);if(!fs.existsSync(directory))return [];const result=fs.readdirSync(directory,{withFileTypes:true});assert(result.length<=max,'Inventory exceeds collection bound');assert(result.every(e=>!e.isSymbolicLink()),'Symbolic links forbidden');return result}
function sessionFile(directory,id){assert(identity(id));return path.join(directory,id,'session.v4.jsonl.zstd')}
function header(directory,id){const first=zlib.zstdDecompressSync(readBytes(sessionFile(directory,id),65536,true),{maxOutputLength:65536}).toString('utf8').split('\n',1)[0],h=JSON.parse(first);assert(h.type==='session'&&h.version===4&&h.id===id);return h}
function readSession(directory,id,h){
  const bytes=readBytes(sessionFile(directory,id)),chunks=[];let offset=0,total=0
  while(offset<bytes.length){const part=zlib.zstdDecompressSync(bytes.subarray(offset),{info:true,maxOutputLength:128*1024*1024});assert(part.engine.bytesWritten>0);offset+=part.engine.bytesWritten;total+=part.buffer.length;assert(total<=128*1024*1024,'Session exceeds decompression bound');chunks.push(part.buffer)}
  const lines=Buffer.concat(chunks).toString('utf8').trim().split('\n'),actual=JSON.parse(lines.shift());assert.equal(actual.id,h.id);assert.equal(actual.cwd,SCOPE.workspaceRoot);assert.equal(actual.parentSession,h.parentSession)
  return {id,parentSession:h.parentSession,sha256:sha(bytes),events:publicEvents(ownRows(actual,lines.filter(Boolean).map(l=>JSON.parse(l))))}
}
const durableFields=['id','workspaceId','sessionId','requestDigest','state','revision','createdAt','updatedAt','compilerMode','compilerSelection','compilerMetrics','diagnostics','steps','childAttempts','childId','candidateAttempts','questionRounds','answers','events','spentTokens','usageAccountingVersion','observedInputBytes','unknownUsageCalls','pendingUsageCalls','candidate','candidateDigest','readiness','receipt','handoffState','chainState','delivery']
export function projectDurableTask(task,binding,rootId){
  assert(task.id===binding.taskId&&task.sessionId===rootId&&task.workspaceId===SCOPE.workspaceId&&task.request?.requestId===binding.requestId&&task.request?.targetWorkflowId===binding.workflowId,'Durable task identity mismatch')
  if(task.candidate)assert(task.candidate.id===binding.workflowId&&task.candidate.workspaceId===SCOPE.workspaceId,'Durable candidate scope mismatch')
  return safe({...Object.fromEntries(durableFields.filter(k=>Object.hasOwn(task,k)).map(k=>[k,task[k]])),requestId:binding.requestId,workflowId:binding.workflowId})
}
export function childIdsFor(taskRows,snapshots){
  const ids=new Set();for(const row of [...taskRows,...snapshots.map(s=>s.task)]){if(identity(row.childId))ids.add(row.childId);for(const metric of row.compilerMetrics??[])if(identity(metric.childId))ids.add(metric.childId)}return ids
}
export function compareConservation(before,after){
  if(!before)return {workflows:null,proposals:null,budgets:null,runs:null,allUnchanged:null}
  const result=Object.fromEntries(['workflows','proposals','budgets','runs'].map(k=>[k,digest(before[k])===digest(after[k])]))
  return {...result,allUnchanged:Object.values(result).every(Boolean)}
}
function conservation(stateDirectory,flowIds){
  const flows=selectedRecords(noSymlinks(path.join(stateDirectory,'library.json')),'workflows',s=>flowIds.has(s('id'))&&s('workspaceId')===SCOPE.workspaceId)
  assert(flows.length===flowIds.size,'Every explicit S10 workflow must exist in the exact workspace')
  const proposals=selectedRecords(noSymlinks(path.join(stateDirectory,'editor-state.json')),'proposals',s=>flowIds.has(s('workflowId')))
  for(const p of proposals)assert(p.candidate?.workspaceId===SCOPE.workspaceId&&p.candidate?.id===p.workflowId,'Proposal scope mismatch')
  const runs=[];for(const file of entries(path.join(stateDirectory,'runs'))){if(!file.isFile()||!file.name.match(/^[A-Za-z0-9_-]+\.json$/))continue
    const full=path.join(stateDirectory,'runs',file.name),route=fields(readBytes(full,16384,true).toString('utf8'))
    if(decode(route.get('workspaceId'))!==SCOPE.workspaceId||!flowIds.has(decode(route.get('workflowId'))))continue
    const bytes=readBytes(full),run=JSON.parse(bytes);assert(run.workspaceId===SCOPE.workspaceId&&flowIds.has(run.workflowId)&&identity(run.id),'Run scope mismatch')
    const eventFile=path.join(stateDirectory,'runs',run.id+'.events.jsonl');runs.push({id:run.id,workflowId:run.workflowId,status:run.status,sha256:sha(bytes),eventsSha256:fs.existsSync(eventFile)?sha(readBytes(eventFile)):null})
  }
  const sorted=rows=>rows.sort((a,b)=>a.id.localeCompare(b.id))
  return {workflows:sorted(flows.map(f=>({id:f.id,revision:f.revision,sha256:digest(f)}))),proposals:sorted(proposals.map(p=>({id:p.id,workflowId:p.workflowId,status:p.status,sha256:digest(p)}))),budgets:sorted(flows.map(f=>({id:f.id,sha256:digest({budgetDecision:f.budgetDecision??null,executionPolicy:f.executionPolicy??null})}))),runs:sorted(runs)}
}
/** IO overrides are solely for isolated fixture tests; the CLI exposes no scope/profile overrides. */
export function collect(options,fixtureIO={}){
  const {rootId,requestIds,workflowIds,before}=options
  assert(identity(rootId)&&requestIds.length&&requestIds.length<=20&&requestIds.every(identity)&&new Set(requestIds).size===requestIds.length,'Invalid explicit request scope')
  assert(workflowIds.length&&workflowIds.every(id=>ALLOWED_FLOWS.has(id))&&new Set(workflowIds).size===workflowIds.length,'Invalid workflow scope')
  const stateDirectory=fixtureIO.stateDirectory??STATE,sessionsDirectory=fixtureIO.sessionsDirectory??SESSIONS,outputRoot=fixtureIO.outputRoot??OUTPUT,pending=[]
  for(const input of [stateDirectory,sessionsDirectory])assert(path.resolve(outputRoot)!==path.resolve(input)&&!path.resolve(outputRoot).startsWith(path.resolve(input)+path.sep),'Evidence output must be outside profile/session directories')
  const headers=new Map();for(const entry of entries(sessionsDirectory))if(entry.isDirectory()&&identity(entry.name)){try{headers.set(entry.name,header(sessionsDirectory,entry.name))}catch{pending.push({kind:'session-header',id:entry.name,reason:'unready-or-invalid'})}}
  const owned=ownedSessionIds(headers,rootId),root=readSession(sessionsDirectory,rootId,headers.get(rootId)),bound=bindRequests(root.events,rootId,requestIds,workflowIds),projection=projectRootEvents(root.events,bound)
  const byId=new Map(Object.values(bound.bindings).map(b=>[b.taskId,b])),taskReadStartedAt=new Date().toISOString()
  const rawTasks=selectedRecords(noSymlinks(path.join(stateDirectory,'planning/tasks.json')),'tasks',s=>s('workspaceId')===SCOPE.workspaceId&&s('sessionId')===rootId&&byId.has(s('id')))
  const taskRows=rawTasks.map(t=>projectDurableTask(t,byId.get(t.id),rootId)),taskReadCompletedAt=new Date().toISOString()
  const backgroundReadStartedAt=new Date().toISOString(),background=selectedRecords(noSymlinks(path.join(stateDirectory,'planning/background.json')),'tasks',s=>s('workspaceId')===SCOPE.workspaceId&&s('sessionId')===rootId&&byId.has(s('taskId')??s('id'))).map(row=>{
    const binding=byId.get(row.taskId??row.id);assert(row.requestId===binding.requestId&&row.taskId===binding.taskId,'Background identity mismatch')
    return safe(Object.fromEntries(['id','taskId','requestId','requestDigest','sessionId','workspaceId','acceptedAt','state','interruptedAt','protocolVersion'].filter(k=>Object.hasOwn(row,k)).map(k=>[k,row[k]])))
  })
  const backgroundReadCompletedAt=new Date().toISOString(),children=[],childIds=childIdsFor(taskRows,projection.taskSnapshots)
  for(const id of childIds){if(!owned.has(id)||id===rootId){pending.push({kind:'bound-child',id,reason:'not-an-exact-cwd-owned-descendant'});continue}
    try{const session=readSession(sessionsDirectory,id,headers.get(id));session.events=session.events.map(e=>e.type==='tool/call'||e.type==='tool/result'?{...meta(e),contentExcluded:'child-tool-body-excluded; public-lifecycle-and-usage-only'}:safe(e));children.push(session)}catch{pending.push({kind:'bound-child',id,reason:'unready-or-invalid'})}
  }
  const conservationState=conservation(stateDirectory,new Set(workflowIds)),capturedAt=new Date().toISOString(),taskStatus=requestIds.map(requestId=>{
    const binding=bound.bindings[requestId],current=binding&&taskRows.find(t=>t.id===binding.taskId),envelope=binding&&background.find(t=>t.taskId===binding.taskId),snapshots=projection.taskSnapshots.filter(s=>s.task.requestId===requestId),last=snapshots.at(-1)
    const metricsSnapshot=snapshots.findLast(s=>Object.hasOwn(s.task,'compilerMetrics'))
    return {requestId,taskId:binding?.taskId??null,workflowId:binding?.workflowId??null,currentTaskState:current?.state??null,currentTaskStateSource:current?'planning/tasks.json':'unknown; preview may be memory-only',backgroundState:envelope?.state??null,lastPublicSnapshot:last?{state:last.task.state,eventSeq:last.eventSeq,observedAt:last.observedAt,toolName:last.toolName}:null,compilerMetrics:current?.compilerMetrics??metricsSnapshot?.task.compilerMetrics??null,compilerMetricsSource:current?.compilerMetrics?'planning/tasks.json':metricsSnapshot?'actual-public-tool-snapshot':'unknown; not exposed or not observed',childIds:[...childIdsFor(current?[current]:[],snapshots)],usage:current?Object.fromEntries(['steps','childAttempts','spentTokens','observedInputBytes','unknownUsageCalls','pendingUsageCalls'].map(k=>[k,current[k]??null])):last?.task.usage??null}
  })
  let prior
  if(before){const file=path.resolve(before);assert(file.startsWith(path.resolve(outputRoot)+path.sep)&&path.basename(file)==='summary.json','Before outside incremental evidence directory');prior=JSON.parse(readBytes(file,8*1024*1024));assert(prior.stage==='incremental-read-only-snapshot'&&prior.rootSessionId===rootId&&digest(prior.requestIds)===digest(requestIds)&&digest(prior.workflowIds)===digest(workflowIds),'Before evidence scope mismatch')}
  noSymlinks(outputRoot);fs.mkdirSync(outputRoot,{recursive:true});const out=path.join(outputRoot,new Date().toISOString().replace(/[-:.]/g,'')+'-'+crypto.randomBytes(3).toString('hex'));fs.mkdirSync(out,{mode:0o700})
  const save=(name,value)=>fs.writeFileSync(path.join(out,name),JSON.stringify(safe(value),null,2)+'\n',{flag:'wx',mode:0o600})
  save('public-events.json',{capturedAt,...SCOPE,rootSessionId:rootId,root:{...root,events:projection.events},children})
  save('bindings.json',bound);save('tool-task-snapshots.json',projection.taskSnapshots);save('control-calls.json',projection.controlCalls)
  save('planning-current.json',{readStartedAt:taskReadStartedAt,readCompletedAt:taskReadCompletedAt,tasks:taskRows})
  save('background-current.json',{readStartedAt:backgroundReadStartedAt,readCompletedAt:backgroundReadCompletedAt,rows:background})
  save('conservation.json',conservationState)
  const summary={stage:'incremental-read-only-snapshot',capturedAt,...SCOPE,rootSessionId:rootId,requestIds,workflowIds,outputDirectory:path.relative(REPO,out),tasks:taskStatus,bindingErrors:bound.errors,unboundRequestIds:requestIds.filter(id=>!bound.bindings[id]),children:children.map(s=>({id:s.id,parentSession:s.parentSession,sha256:s.sha256,events:s.events.length})),unboundDescendantIds:[...owned].filter(id=>id!==rootId&&!childIds.has(id)),pending,conservation:conservationState,comparison:compareConservation(prior?.conservation,conservationState),limits:['Only explicit root tool call/result pairs bind requests; prose, orphan results and descendants cannot bind tasks.','Exactly the selected existing S10 workflows are hashed. Foreign session bodies, unbound child bodies, unrelated tool bodies, assistant prose, private reasoning and attachments are excluded.','Preview absence from tasks.json means current task state unknown. Background acceptance is not current activity; timestamped public get/answer snapshots are historical observations.','Compiler metrics and child IDs are retained only from actual durable task or public API payload. Missing metrics, child linkage and usage stay unknown, never invented zero.','Only bound, metadata-owned children supply public lifecycle/usage; child tool bodies are excluded. Unbound descendant metadata does not prove task ownership.','Hashes compare observed selected entities; snapshots are not transactional and no action, performance improvement or activity-at-Quit is inferred. Automatic secret filtering is not a general secrecy proof.']}
  save('summary.json',summary);return summary
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{const summary=collect(parseArgs(process.argv.slice(2)));console.log(JSON.stringify({outputDirectory:summary.outputDirectory,tasks:summary.tasks,bindingErrors:summary.bindingErrors,pending:summary.pending,comparison:summary.comparison},null,2))}catch(error){console.error(JSON.stringify({status:'failed',reason:'SCOPED_INCREMENTAL_READ_ONLY_COLLECTION_FAILED',errorType:error?.name??'Error'}));process.exitCode=1}}
