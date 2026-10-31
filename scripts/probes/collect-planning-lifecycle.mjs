// Read-only S10 lifecycle evidence. Never dispatches tools/models or changes Host state.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {SCOPE,STATE,REPO,readBytes,noSymlinks,publicSafe,scopedPublicEvents,ownedSessionIds,selectedRecords,fields,ownRows,sha} from './collect-planning-speed-desktop.mjs'
export const FLOW='cf6080af-968c-4c86-8f53-b44c50db8849'
export const REQUEST_IDS=['s10-life-active-v2-20261019','s10-life-queued-v2-20261019','s10-life-restart-v2-20261019']
const OUTPUT=path.join(REPO,'docs/evidence/planning-speed-20261019/desktop-lifecycle-live')
const PREPARE=path.join(REPO,'docs/evidence/planning-speed-20261019/desktop-lifecycle-prepare')
const SESSIONS=path.join(os.homedir(),'.dsh/sessions/--private-tmp-dsh-planning-speed-acceptance-20261019--')
const safeId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(v)
const ordered=v=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v
const equal=(a,b)=>JSON.stringify(ordered(a))===JSON.stringify(ordered(b))
const object=v=>v&&typeof v==='object'&&!Array.isArray(v)
const decode=v=>{try{return typeof v==='string'?JSON.parse(v):v}catch{return undefined}}
const normalizedRequest=value=>object(value)&&object(value.handoff)?{...value,handoff:{...value.handoff,evidenceRefs:value.handoff.evidenceRefs??[]}}:value
const safePublic=value=>{const visit=v=>typeof v==='string'?v.replace(/<(?:think|thinking|reasoning|analysis)>[\s\S]*?<\/(?:think|thinking|reasoning|analysis)>/gi,'[private-model-text-excluded]'):Array.isArray(v)?v.map(visit):object(v)?Object.fromEntries(Object.entries(v).map(([k,item])=>[k,visit(item)])):v;return visit(publicSafe(value))}
export function expectedRequests(){const manifest=JSON.parse(readBytes(path.join(PREPARE,'manifest.prepare.json'),128_000));assert(manifest.requestFormat==='compact-v2-before-first-live-dispatch','Wrong preregistration version');return Object.fromEntries(['active','queued','restart'].map(name=>{const bytes=readBytes(path.join(PREPARE,name+'.request.json'),64_000),value=JSON.parse(bytes);assert(REQUEST_IDS.includes(value.requestId)&&manifest.plannedRequests[name].requestId===value.requestId&&manifest.plannedRequests[name].requestFileSha256===sha(bytes),'Preregistered compact request digest mismatch');return [value.requestId,value]}))}
const taskFields=['taskId','requestId','workflowId','state','revision','preview','candidateDigest','summary','diagnostics','readiness','receipt','usage','events','delivery','handoff','compilerMetrics','candidate','moduleProvenance']
export function projectPublicTask(value){
  if(!object(value)||!safeId(value.taskId)||!REQUEST_IDS.includes(value.requestId))return undefined
  if(value.workflowId!==undefined&&value.workflowId!==FLOW)return undefined
  if(value.candidate&&(value.candidate.id!==FLOW||value.candidate.workspaceId!==SCOPE.workspaceId))return undefined
  return safePublic(Object.fromEntries(taskFields.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]])))
}
/** Only real paired root call/result records bind identity. Model prose and descendants cannot bind. */
export function bindRequests(sessions,rootId,expected=expectedRequests()){
  const root=sessions.find(s=>s.id===rootId);assert(root,'Explicit root public projection missing')
  const calls=new Map(),bindings={},errors=[]
  for(const event of root.events){
    if(event.type==='tool/call'&&event.name==='visible_workflow_plan'){
      const args=decode(event.arguments),request=decode(args?.request_json)
      if(!REQUEST_IDS.includes(request?.requestId))continue
      if(!object(args)||Object.keys(args).length!==1||!equal(normalizedRequest(request),normalizedRequest(expected[request.requestId]))){errors.push({code:'REQUEST_CONTRACT_MISMATCH',callId:event.callId,requestId:request.requestId});continue}
      assert(safeId(event.callId),'Invalid public call ID');calls.set(event.callId,{requestId:request.requestId,callId:event.callId,seq:event.seq,time:event.time,turn:event.turn,step:event.step,canonicalRequestSha256:sha(JSON.stringify(ordered(normalizedRequest(request)))),arguments:{request_json:JSON.stringify(request)}})
    }else if(event.type==='tool/result'&&calls.has(event.message?.toolCallId)){
      const call=calls.get(event.message.toolCallId)
      if(event.message?.isError){errors.push({code:'PLAN_TOOL_ERROR',callId:call.callId,requestId:call.requestId});continue}
      const values=(event.message?.content??[]).filter(b=>b.type==='text').map(b=>projectPublicTask(decode(b.text))).filter(Boolean)
      if(values.length!==1||values[0].requestId!==call.requestId){errors.push({code:'UNBOUND_OR_INVALID_PLAN_RECEIPT',callId:call.callId,requestId:call.requestId});continue}
      const value=values[0],prior=bindings[call.requestId]
      if(prior&&prior.taskId!==value.taskId){errors.push({code:'DUPLICATE_REQUEST_CHANGED_TASK_ID',requestId:call.requestId,taskIds:[prior.taskId,value.taskId]});continue}
      const row={...call,resultSeq:event.seq,resultTime:event.time,task:value}
      if(prior)prior.receipts.push(row);else bindings[call.requestId]={requestId:call.requestId,taskId:value.taskId,receipts:[row]}
    }
  }
  return {bindings,errors,calls:[...calls.values()]}
}
/** Whitelist task fields and exact bound task IDs; unrelated planning bodies stay excluded. */
export function projectLifecycleSessions(sessions,rootId,bound){
  const ids=new Set(Object.values(bound.bindings).map(b=>b.taskId)),allowedPlan=new Set(bound.calls.map(c=>c.callId)),snapshots=[],controls=[]
  const projected=sessions.map(session=>{
    const allowed=new Map()
    for(const event of session.events)if(event.type==='tool/call'){
      const args=decode(event.arguments)
      if(session.id===rootId&&allowedPlan.has(event.callId))allowed.set(event.callId,{name:event.name,args})
      else if(session.id===rootId&&['visible_workflow_plan_get','visible_workflow_plan_cancel'].includes(event.name)&&object(args)&&ids.has(args.task_id)&&Object.keys(args).every(k=>['task_id','include_candidates'].includes(k)))allowed.set(event.callId,{name:event.name,args})
    }
    const events=session.events.flatMap(event=>{
      if(event.type==='tool/call'){
        const call=allowed.get(event.callId)
        if(!call)return [{seq:event.seq,time:event.time,type:event.type,callId:event.callId,name:event.name,contentExcluded:'not-a-bound-lifecycle-call'}]
        if(call.name!=='visible_workflow_plan')controls.push({sessionId:session.id,seq:event.seq,time:event.time,callId:event.callId,name:call.name,arguments:publicSafe(call.args)})
        return [{...event,arguments:publicSafe(call.args)}]
      }
      if(event.type==='tool/result'){
        const call=allowed.get(event.message?.toolCallId)
        if(!call)return [{seq:event.seq,time:event.time,type:event.type,name:event.name,message:{toolCallId:event.message?.toolCallId,isError:event.message?.isError},contentExcluded:'not-a-bound-lifecycle-result'}]
        const content=[]
        for(const block of event.message?.content??[]){const task=projectPublicTask(decode(block.text));if(task&&ids.has(task.taskId)&&bound.bindings[task.requestId]?.taskId===task.taskId){snapshots.push({sessionId:session.id,eventSeq:event.seq,observedAt:event.time,toolName:call.name,callId:event.message.toolCallId,task});content.push({type:'text',text:JSON.stringify(task)})}}
        return [{seq:event.seq,time:event.time,type:event.type,name:call.name,message:{toolCallId:event.message?.toolCallId,isError:event.message?.isError,content},...(event.message?.isError?{publicErrorText:safePublic((event.message.content??[]).filter(b=>b.type==='text'&&typeof b.text==='string').map(b=>b.text.slice(0,16000)))}:{}),...(content.length?{}:{contentExcluded:'no-valid-bound-task-payload'})}]
      }
      return [publicSafe(event)]
    })
    return {...session,events}
  })
  return {sessions:projected,taskSnapshots:snapshots,controls}
}
const time=v=>typeof v==='number'?v:typeof v==='string'?Date.parse(v):NaN
const observation=(covered,reason,evidence={})=>({covered,reason,...evidence})
/** A preview admission envelope is not a live task-state feed. Old public receipts never decide current activity. */
export function assessBeforeActivity(before,requestId){
  const binding=before?.bindings?.[requestId],durable=before?.durableState
  const recent=before?.taskSnapshots?.filter(s=>s.task.requestId===requestId&&s.toolName==='visible_workflow_plan_get').at(-1)
  const details={recentPublicGet:recent?{state:recent.task.state,observedAt:recent.observedAt,eventSeq:recent.eventSeq,ageAtCaptureMs:Number.isFinite(time(before?.capturedAt))?time(before.capturedAt)-recent.observedAt:null}:null,durableReadWindow:durable?{tasks:durable.tasks?.readCompletedAt??null,background:durable.background?.readCompletedAt??null}:null}
  if(!binding||!durable)return observation(null,'no-current-durable-task-state; stale plan/get cannot establish snapshot activity',details)
  const rows=durable.tasks?.rows??[],envelopes=durable.background?.rows??[]
  const tasks=rows.filter(t=>t.id===binding.taskId),background=envelopes.filter(t=>(t.taskId??t.id)===binding.taskId)
  if(tasks.length>1||background.length>1||tasks.some(t=>t.requestId!==requestId)||background.some(t=>t.requestId!==requestId||t.sessionId!==before.rootSessionId||t.workspaceId!==SCOPE.workspaceId))return observation(null,'durable-identity-conflict',details)
  const current=tasks[0],envelope=background[0]
  if(envelope?.state==='interrupted')return observation(false,'durable-envelope-already-interrupted',details)
  if(!current)return observation(null,envelope?.state==='accepted'?'admission-envelope-only; require separately timestamped native get/Host/UI activity and Quit timeline':'current-durable-task-missing',details)
  const active=['collecting','queued','distilling','authoring','repairing','optimizing','validating','publishing']
  if(!active.includes(current.state))return observation(false,'current-durable-task-is-not-active',{...details,durableState:current.state})
  // A later ready/cancelled receipt or bound child terminal contradicts an older active journal.
  const afterJournal=before.taskSnapshots?.filter(s=>s.task.taskId===binding.taskId&&Number.isFinite(time(current.updatedAt))&&s.observedAt>=time(current.updatedAt)&&!active.includes(s.task.state))??[]
  const childIds=new Set((current.compilerMetrics??[]).map(m=>m.childId).filter(safeId))
  const terminal=(before.childTerminalEvidence??[]).filter(e=>childIds.has(e.sessionId)||childIds.has(e.childId))
  if(afterJournal.length||terminal.length)return observation(null,'durable/public-or-child-terminal-inconsistency; activity is not established',{...details,durableState:current.state,terminalEvidence:terminal,conflictingPublicStates:afterJournal.map(s=>({state:s.task.state,observedAt:s.observedAt}))})
  if(!Number.isFinite(time(durable.tasks?.readCompletedAt)))return observation(null,'current-durable-read-time-missing',details)
  return observation(true,'current-bound-durable-task-state; normal Quit timing still needs operator evidence',{...details,durableState:current.state})
}
export function assessLifecycle(bound,projection,before=null,identity=null,pendingCount=0){
  const result={}
  for(const requestId of REQUEST_IDS){
    const binding=bound.bindings[requestId],snaps=projection.taskSnapshots.filter(s=>s.task.requestId===requestId).sort((a,b)=>a.observedAt-b.observedAt),last=snaps.at(-1),cancel=projection.controls.find(c=>c.name==='visible_workflow_plan_cancel'&&c.arguments.task_id===binding?.taskId)
    const counters=snaps.map(s=>s.task.usage?.childAttempts).filter(v=>Number.isInteger(v)&&v>=0)
    const events=snaps.flatMap(s=>(s.task.events??[]).map(e=>({...e,at:time(e.at)}))).filter(e=>Number.isFinite(e.at))
    const prior=cancel?events.filter(e=>e.at<cancel.time).sort((a,b)=>a.at-b.at).at(-1):undefined
    const cancelResult=cancel?snaps.find(s=>s.callId===cancel.callId&&s.toolName==='visible_workflow_plan_cancel'):undefined
    const hadChild=cancel?events.some(e=>e.at<cancel.time&&/规划子任务已启动|模型步骤已开始/.test(e.message??'')):false
    const conflict=bound.errors.some(e=>e.requestId===requestId),finalChild=last?.task.usage?.childAttempts,cancelChild=cancelResult?.task.usage?.childAttempts
    const finalChildKnown=Number.isInteger(finalChild)&&finalChild>=0,cancelChildKnown=Number.isInteger(cancelChild)&&cancelChild>=0
    result[requestId]={taskId:binding?.taskId??null,lastState:last?.task.state??null,usage:last&&Object.hasOwn(last.task,'usage')?last.task.usage:null,
      duplicateSameTaskId:observation(conflict?false:binding?.receipts.length>=2?true:null,conflict?'binding-error':binding?.receipts.length>=2?'paired-public-receipts':'not-observed'),
      duplicateNoExtraChild:observation(!conflict&&binding?.receipts.length>=2&&finalChildKnown?finalChild<=1:null,'only-known-task-child-counter-evidence; no counter is unknown'),
      queuedCancelledBeforeChild:observation(cancelResult?cancelResult.task.state==='cancelled'&&prior&&cancelChildKnown?prior.state==='queued'&&cancelChild===0&&!hadChild:null:null,cancelResult?'actual-before-cancel-events-and-known-child-count':'cancel-receipt-not-observed',{stateBeforeCancel:prior?.state??null}),
      activeCancelledDuringGeneration:observation(cancelResult&&prior?cancelResult.task.state==='cancelled'&&hadChild&&['authoring','repairing','distilling','optimizing'].includes(prior.state):null,cancelResult?'actual-before-cancel-events; early-ready-is-not-covered':'cancel-receipt-not-observed',{stateBeforeCancel:prior?.state??null}),
      acceptanceTimes:binding?.receipts.map(r=>r.task.delivery?.acceptedAt??null)??[],cancelResult:cancelResult?.task.state??null}
  }
  const first=bound.calls.find(c=>c.requestId===REQUEST_IDS[0]),second=bound.calls.find(c=>c.requestId===REQUEST_IDS[1])
  const hasResponseIdentity=first&&second&&Number.isInteger(first.turn)&&Number.isInteger(first.step)&&Number.isInteger(second.turn)&&Number.isInteger(second.step)
  const queuedCancel=projection.controls.find(c=>c.name==='visible_workflow_plan_cancel'&&c.arguments.task_id===bound.bindings[REQUEST_IDS[1]]?.taskId)
  const firstEvents=projection.taskSnapshots.filter(s=>s.task.requestId===REQUEST_IDS[0]).flatMap(s=>(s.task.events??[]).map(e=>({...e,at:time(e.at)})))
  const firstBeforeQueuedCancel=queuedCancel?firstEvents.filter(e=>Number.isFinite(e.at)&&e.at<queuedCancel.time).sort((a,b)=>a.at-b.at).at(-1):undefined
  result.sequence={twoPlansInSameAssistantResponse:observation(hasResponseIdentity?first.turn===second.turn&&first.step===second.step:null,'only actual root turn/step identities count'),activeStateWhenQueuedCancelled:firstBeforeQueuedCancel?.state??null,activeChildObservedBeforeQueuedCancelled:queuedCancel?firstEvents.some(e=>e.at<queuedCancel.time&&/规划子任务已启动|模型步骤已开始/.test(e.message??'')):null}
  const id=REQUEST_IDS[2],current=result[id],oldBinding=before?.bindings?.[id],currentBinding=bound.bindings[id],task=projection.taskSnapshots.filter(s=>s.task.requestId===id&&s.task.delivery?.recovered===true).at(-1)?.task
  const priorTask=before?.taskSnapshots?.filter(s=>s.task.requestId===id).at(-1)?.task
  const same=before&&oldBinding&&currentBinding&&task?oldBinding.taskId===currentBinding.taskId&&task.state==='interrupted'&&task.delivery?.acceptedAt===priorTask?.delivery?.acceptedAt:null
  const activityBefore=assessBeforeActivity(before,id),activeBefore=activityBefore.covered
  const keys=['steps','childAttempts','spentTokens','observedInputBytes','unknownUsageCalls','pendingUsageCalls','legacyEstimates']
  const unknown=task?task.usage?.recoveredWithoutUsage===true&&keys.every(k=>Object.hasOwn(task.usage??{},k)&&task.usage[k]===null):null
  const beforeIds=new Set(before?.sessions?.map(s=>s.id)??[]),newChildren=identity?.sessions?.filter(s=>s.id!==identity.rootSessionId&&!beforeIds.has(s.id)).map(s=>s.id)??[]
  const oldSeq=new Map(before?.sessions?.map(s=>[s.id,s.maxPublicSeq??-1])??[])
  const childActivity=before?projection.sessions.filter(s=>s.id!==identity?.rootSessionId).flatMap(s=>s.events.filter(e=>e.seq>(oldSeq.get(s.id)??-1)&&['step/start','assistant/message','assistant/attempt'].includes(e.type)).map(e=>({sessionId:s.id,seq:e.seq,type:e.type,time:e.time}))):[]
  current.restart={sameIdentityInterrupted:observation(same,'requires-explicit-before-and-after-manifests'),activeInBeforeSnapshot:activityBefore,recoveredUsageNull:observation(unknown,'unknown-recovered-usage-must-not-be-zero'),noNewChildSinceBeforeSnapshot:observation(before&&identity&&!pendingCount?newChildren.length===0:null,'explicit-before/after lineage comparison only; does not prove interrupted active work',{newChildren}),noObservedChildModelActivitySinceBeforeSnapshot:observation(before&&identity&&!pendingCount?childActivity.length===0:null,'observed descendant step/usage delta only; does not prove interrupted active work',{childActivity}),noObservedChildReplay:observation(before&&same&&activeBefore&&identity&&!pendingCount?newChildren.length===0&&childActivity.length===0:null,'observable-lineage-and-child-step/usage-comparison; not an internal provider dispatch proof',{newChildren,childActivity}),normalQuitRestartAction:null}
  return result
}
function boundedEntries(dir,max){noSymlinks(dir);if(!fs.existsSync(dir))return [];const entries=fs.readdirSync(dir,{withFileTypes:true});assert(entries.every(e=>!e.isSymbolicLink()),'Symbolic links forbidden');assert(entries.length<=max,'Evidence directory exceeds bounded inventory');return entries}
function header(id){const file=path.join(SESSIONS,id,'session.v4.jsonl.zstd'),first=zlib.zstdDecompressSync(readBytes(file,65536,true),{maxOutputLength:65536}).toString('utf8').split('\n',1)[0],h=JSON.parse(first);assert(h.type==='session'&&h.version===4&&h.id===id);return h}
function readOwned(id,h,rootId){const file=path.join(SESSIONS,id,'session.v4.jsonl.zstd'),bytes=readBytes(file),chunks=[];let offset=0,total=0
  while(offset<bytes.length){const part=zlib.zstdDecompressSync(bytes.subarray(offset),{info:true,maxOutputLength:128*1024*1024});assert(part.engine.bytesWritten>0);offset+=part.engine.bytesWritten;total+=part.buffer.length;assert(total<=128*1024*1024,'Owned session exceeds decompression bound');chunks.push(part.buffer)}
  const lines=Buffer.concat(chunks).toString('utf8').trim().split('\n'),actual=JSON.parse(lines.shift());assert.equal(actual.id,h.id);assert.equal(actual.cwd,SCOPE.workspaceRoot);assert.equal(actual.parentSession,h.parentSession)
  return {id,role:id===rootId?'root':'descendant',parentSession:h.parentSession,createdAt:h.createdAt,sha256:sha(bytes),events:scopedPublicEvents(ownRows(actual,lines.filter(Boolean).map(l=>JSON.parse(l))),new Set([FLOW]))}}
function selected(relative,key,accept){const file=path.join(STATE,relative);noSymlinks(file);return selectedRecords(file,key,accept)}
export function compareConservation(before,after){if(!before)return {flow:null,proposals:null,budgets:null,runs:null,allUnchanged:null};const parts=Object.fromEntries(['flow','proposals','budgets','runs'].map(k=>[k,equal(before[k],after[k])]));return {...parts,allUnchanged:Object.values(parts).every(Boolean)}}
function conservation(){const flows=selected('library.json','workflows',s=>s('id')===FLOW&&s('workspaceId')===SCOPE.workspaceId);assert(flows.length===1,'Exact S10 flow missing');const f=flows[0]
  const proposals=selected('editor-state.json','proposals',s=>s('workflowId')===FLOW).map(p=>({id:p.id,status:p.status,sha256:sha(JSON.stringify(p))})).sort((a,b)=>a.id.localeCompare(b.id))
  const budgets=[]
  for(const entry of boundedEntries(path.join(STATE,'creation-budgets'),4096)){if(!entry.isFile()||!/^\w+\.json$/.test(entry.name))continue;const file=path.join(STATE,'creation-budgets',entry.name),bytes=readBytes(file,131072),scope=fields(bytes.toString()).get('scope');if(!scope)continue;const route=fields(scope);if(decode(route.get('workflowId'))!==FLOW||decode(route.get('workspaceId'))!==SCOPE.workspaceId)continue;budgets.push({id:entry.name,sha256:sha(bytes)})}
  const runs=[]
  for(const entry of boundedEntries(path.join(STATE,'runs'),16384)){if(!entry.isFile()||!safeId(entry.name.slice(0,-5))||!entry.name.endsWith('.json'))continue;const file=path.join(STATE,'runs',entry.name),route=fields(readBytes(file,16384,true).toString());if(decode(route.get('workspaceId'))!==SCOPE.workspaceId||decode(route.get('workflowId'))!==FLOW)continue;const eventFile=file.slice(0,-5)+'.events.jsonl';runs.push({id:entry.name.slice(0,-5),sha256:sha(readBytes(file)),eventsSha256:fs.existsSync(eventFile)?sha(readBytes(eventFile)):null})}
  return {flow:{id:f.id,revision:f.revision,sha256:sha(JSON.stringify(f))},proposals:proposals.sort((a,b)=>a.id.localeCompare(b.id)),budgets:budgets.sort((a,b)=>a.id.localeCompare(b.id)),runs:runs.sort((a,b)=>a.id.localeCompare(b.id)),counts:{proposals:proposals.length,budgets:budgets.length,runs:runs.length}}
}
function beforeManifest(file,rootId){if(!file)return null;noSymlinks(file);const resolved=path.resolve(file);assert(path.dirname(path.dirname(resolved))===OUTPUT&&path.basename(resolved)==='manifest.json','Before manifest must be a prior lifecycle snapshot manifest');const before=JSON.parse(readBytes(resolved,8*1024*1024));assert(before.kind==='scoped-planning-lifecycle-snapshot'&&before.rootSessionId===rootId&&before.workspaceId===SCOPE.workspaceId&&before.workspaceRoot===SCOPE.workspaceRoot&&before.workflowId===FLOW,'Before manifest scope mismatch');assert(Number.isFinite(Date.parse(before.capturedAt))&&Date.parse(before.capturedAt)<=Date.now(),'Invalid before snapshot time');return before}
export function collectLifecycle(rootId,previousFile){assert(safeId(rootId),'Explicit --root-session-id required');const before=beforeManifest(previousFile,rootId),headers=new Map(),pending=[]
  for(const entry of boundedEntries(SESSIONS,256))if(entry.isDirectory()&&!entry.isSymbolicLink()&&safeId(entry.name)){try{headers.set(entry.name,header(entry.name))}catch{pending.push({kind:'header',reason:'not-ready-or-unsupported'})}}
  // All unselected histories stop at header metadata. Never parse their bodies.
  const owned=ownedSessionIds(headers,rootId),raw=[]
  for(const id of owned)try{raw.push(readOwned(id,headers.get(id),rootId))}catch{pending.push({kind:'owned-session',id,reason:'write-in-progress-or-invalid'})}
  const bound=bindRequests(raw,rootId),projection=projectLifecycleSessions(raw,rootId,bound),ids=new Set(Object.values(bound.bindings).map(b=>b.taskId)),bindings=Object.fromEntries(Object.entries(bound.bindings).map(([id,b])=>[id,{taskId:b.taskId,receipts:b.receipts.map(r=>({callId:r.callId,canonicalRequestSha256:r.canonicalRequestSha256,seq:r.seq,time:r.time,resultSeq:r.resultSeq,resultTime:r.resultTime,delivery:r.task.delivery??null}))}]))
  const tasksReadStartedAt=new Date().toISOString()
  const stored=selected('planning/tasks.json','tasks',s=>s('workspaceId')===SCOPE.workspaceId&&s('sessionId')===rootId&&ids.has(s('id'))).map(t=>publicSafe({id:t.id,requestId:t.request?.requestId,state:t.state,revision:t.revision,updatedAt:t.updatedAt??null,delivery:t.delivery??null,compilerMetrics:t.compilerMetrics??[],usage:{steps:t.steps??null,childAttempts:t.childAttempts??null,spentTokens:t.spentTokens??null,observedInputBytes:t.observedInputBytes??null,unknownUsageCalls:t.unknownUsageCalls??null,pendingUsageCalls:t.pendingUsageCalls??null},events:t.events??[]}))
  const tasksReadCompletedAt=new Date().toISOString(),backgroundReadStartedAt=new Date().toISOString()
  const background=selected('planning/background.json','tasks',s=>s('workspaceId')===SCOPE.workspaceId&&s('sessionId')===rootId&&ids.has(s('taskId')??s('id'))).map(t=>publicSafe(Object.fromEntries(['protocolVersion','id','taskId','requestId','requestDigest','sessionId','workspaceId','acceptedAt','state','interruptedAt'].filter(k=>Object.hasOwn(t,k)).map(k=>[k,t[k]]))))
  const backgroundReadCompletedAt=new Date().toISOString(),durableState={tasks:{readStartedAt:tasksReadStartedAt,readCompletedAt:tasksReadCompletedAt,rows:stored},background:{readStartedAt:backgroundReadStartedAt,readCompletedAt:backgroundReadCompletedAt,rows:background}}
  const childTerminalEvidence=projection.sessions.flatMap(s=>s.events.filter(e=>s.id!==rootId&&['turn/end','subagent/end'].includes(e.type)||e.type==='subagent/end').map(e=>({sessionId:s.id,childId:e.data?.childId??e.data?.id??null,seq:e.seq,time:e.time,type:e.type})))
  const capturedAt=new Date().toISOString(),sessions=projection.sessions.map(s=>({id:s.id,role:s.role,parentSession:s.parentSession??null,sha256:s.sha256,maxPublicSeq:s.events.reduce((n,e)=>Math.max(n,e.seq),-1)})),identity={rootSessionId:rootId,sessions},current=conservation(),lifecycle=assessLifecycle(bound,projection,before,identity,pending.length)
  const manifest={kind:'scoped-planning-lifecycle-snapshot',stage:'read-only-observation-not-automatic-acceptance',capturedAt,...SCOPE,workflowId:FLOW,rootSessionId:rootId,requestIds:REQUEST_IDS,collectorSourceSha256:sha(readBytes(fileURLToPath(import.meta.url))),preregistrationSha256:sha(readBytes(path.join(PREPARE,'manifest.prepare.json'))),beforeManifest:previousFile?path.relative(REPO,path.resolve(previousFile)):null,sessions,bindings,bindingErrors:bound.errors,taskSnapshots:projection.taskSnapshots,durableState,childTerminalEvidence,lifecycle,conservation:current,conservationComparison:compareConservation(before?.conservation,current),pending,limits:['No models/tools/UI dispatched and no Host/profile files written.','Only explicitly selected root lineage full histories read; all other histories stop at headers.','Task IDs come only from paired actual root plan call/results matching one exact preregistered request. Missing bindings/receipts/usage remain unknown.','Planning background envelope proves identity/state only. No replay conclusions require explicit before and after snapshots and observable child lineage; normal Quit action remains operator evidence.','Only exact target workflow and associated proposal/budget/run hashes/counts compared. Other batches are not treated as authorized changes.','No thinking/reasoning text, assistant prose, request headers or credentials exported; automatic text scrubbing is not a general secrecy proof.']}
  noSymlinks(OUTPUT);fs.mkdirSync(OUTPUT,{recursive:true});const out=path.join(OUTPUT,new Date().toISOString().replace(/[-:.]/g,'')+'-'+crypto.randomBytes(3).toString('hex'));fs.mkdirSync(out,{mode:0o700});const save=(name,value)=>fs.writeFileSync(path.join(out,name),JSON.stringify(safePublic(value),null,2)+'\n',{flag:'wx',mode:0o600})
  save('manifest.json',manifest);save('bindings.json',{bindings,bindingErrors:bound.errors});save('public-events.json',{...SCOPE,rootSessionId:rootId,sessions:projection.sessions});save('task-snapshots.json',{public:projection.taskSnapshots,stored,background});save('lifecycle.json',lifecycle);save('conservation.json',{current,comparison:manifest.conservationComparison});return {outputDirectory:path.relative(REPO,out),rootSessionId:rootId,boundRequests:bindings,bindingErrors:bound.errors,conservation:manifest.conservationComparison,pending}
}
export function parseArgs(args){assert(args.length===2||args.length===4,'Usage: --root-session-id SESSION_ID [--before-manifest PRIOR_MANIFEST]');assert(args[0]==='--root-session-id'&&safeId(args[1]),'Explicit root required');if(args.length===4)assert(args[2]==='--before-manifest'&&args[3],'Invalid before manifest argument');return {rootId:args[1],before:args[3]}}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{const args=parseArgs(process.argv.slice(2));console.log(JSON.stringify(collectLifecycle(args.rootId,args.before),null,2))}catch(error){console.error(JSON.stringify({status:'failed',reason:'SCOPED_LIFECYCLE_COLLECTION_FAILED',errorType:error?.name??'Error'}));process.exitCode=1}
