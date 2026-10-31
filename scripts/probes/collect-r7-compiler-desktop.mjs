// Read only the explicitly authorized R7 root and its newly created planning children.
// Persist public calls, receipts and timings; never persist reasoning or request bodies.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
const root=path.resolve(import.meta.dirname,'../..')
const out=path.join(root,'docs/evidence/r7-compiler-desktop-20261019')
const state=path.join(os.homedir(),'.dsh/visible-dynamic-workflows')
const sessionDirectory=path.join(os.homedir(),'.dsh/sessions/--private-tmp-dsh-workflow-r7-acceptance-20261018--')
const rootId='session-ebfe6768-ad6a-438f-864e-f3ecf6f8c1a8'
const workspaceId='3e8e6188-0e29-48d6-83d0-17daaca8dc9e'
const trialId='trial-71128754-f3a1-483e-b5e2-a8eb3dd3ddf9'
const requestPrefix='r7-compiler-resume-20261019-'
const baseline=JSON.parse(fs.readFileSync(path.join(out,'root-session-baseline.json'),'utf8'))
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'))
const sha=b=>crypto.createHash('sha256').update(b).digest('hex')
const save=(name,value)=>fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2)+'\n')
function rowsFor(id){
  assert.match(id,/^[A-Za-z0-9_-]+$/)
  const file=path.join(sessionDirectory,id,'session.v4.jsonl.zstd')
  if(!fs.existsSync(file))return undefined
  const bytes=fs.readFileSync(file),chunks=[];let offset=0
  while(offset<bytes.length){const item=zlib.zstdDecompressSync(bytes.subarray(offset),{info:true});assert(item.engine.bytesWritten>0);offset+=item.engine.bytesWritten;chunks.push(item.buffer)}
  const rows=Buffer.concat(chunks).toString().trim().split('\n').filter(Boolean).map(s=>JSON.parse(s))
  assert.equal(rows[0].id,id)
  return {file,sha256:sha(bytes),header:rows[0],rows:rows.slice(1)}
}
const rootSession=rowsFor(rootId)
assert(rootSession)
const newRootRows=rootSession.rows.filter(r=>r.seq>baseline.lastSeq)
const startedAt=newRootRows.find(r=>r.type==='user/message')?.time
const tasks=read(path.join(state,'planning/tasks.json')).tasks.filter(t=>t.sessionId===rootId&&t.workspaceId===workspaceId&&t.request.requestId.startsWith(requestPrefix))
const trials=read(path.join(state,'trials/planning/tasks.json')).tasks
const source=trials.find(t=>t.id===trialId);assert(source)
const taskFields=['id','request','requestDigest','state','preview','revision','createdAt','updatedAt','compilerMode','compilerMetrics','diagnostics','steps','childAttempts','childId','distillationAttempts','candidateAttempts','questionRounds','answers','events','spentTokens','unknownUsageCalls','pendingUsageCalls','observedInputBytes','procedure','sourceMap','provenanceDigest','candidate','candidateDigest','optimization','optimizationDigest','readiness','receipt','compilerDraft']
const taskViews=tasks.map(t=>({...Object.fromEntries(taskFields.filter(k=>t[k]!==undefined).map(k=>[k,t[k]])),model:t.context?.model,effort:t.context?.effort,sourceBinding:t.context?.trial,sourceEvidenceDigest:t.context?.conversation?.digest,sourceEvidenceCount:t.context?.conversation?.records.length}))
save('planning-tasks.json',taskViews)
// A run snapshot is runtime evidence, not permission to replay the original trial.
const workflowIds=new Set(tasks.map(t=>t.candidate?.id).filter(Boolean))
const runFields=['id','engine','workflowId','workspaceId','workflowTitle','sourceRevision','activeRevision','status','inputs','outputs','startedAt','endedAt','error','budget','executions','graph','snapshotDigest','repairAuthorization']
const runViews=[]
for(const item of fs.readdirSync(path.join(state,'runs'))){
  if(!item.endsWith('.json'))continue
  const file=path.join(state,'runs',item),run=read(file)
  if(!workflowIds.has(run.workflowId))continue
  assert.equal(run.workspaceId,workspaceId)
  const eventsFile=path.join(state,'runs',run.id+'.events.jsonl')
  const events=fs.existsSync(eventsFile)?fs.readFileSync(eventsFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[]
  runViews.push({...Object.fromEntries(runFields.filter(k=>run[k]!==undefined).map(k=>[k,run[k]])),events})
}
runViews.sort((a,b)=>a.startedAt.localeCompare(b.startedAt))
save('graphon-runs.json',runViews)
const callsAllowed=name=>name==='structured_output'||name.startsWith('planner_')||name.startsWith('visible_workflow_')||['read','write','ask_user_question'].includes(name)
function publicRows(session,after=-1){
  const rows=session.rows.filter(r=>r.seq>after), calls=new Map(rows.filter(r=>r.type==='tool/call'&&callsAllowed(r.data.name)).map(r=>[r.data.callId,r.data.name]))
  return rows.flatMap(r=>{
    const d=r.data??{},meta={seq:r.seq,time:r.time,type:r.type}
    if(r.type==='tool/call'&&calls.has(d.callId))return [{...meta,...d}]
    if(r.type==='tool/result'&&calls.has(d.message?.toolCallId))return [{...meta,turn:d.turn,step:d.step,name:calls.get(d.message.toolCallId),message:d.message,error:d.error}]
    if(['turn/start','turn/end','model/selection','subagent/descriptor'].includes(r.type))return [{...meta,data:d}]
    if(r.type==='user/message'&&session.header.id===rootId)return [{...meta,text:(d.content??d.message?.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n')}]
    if(r.type==='request/header')return [{...meta,turn:d.turn,step:d.step,provider:d.header?.config?.provider??d.header?.provider,model:d.header?.config?.model??d.header?.model}]
    if(['assistant/message','assistant/attempt'].includes(r.type)){
      const chunks=d.stream??[]
      const usage=d.usage??chunks.filter(x=>x.type==='chunk'&&x.chunk?.type==='usage').at(-1)?.chunk?.usage
      return [{...meta,turn:d.turn,step:d.step,usage:usage??null}]
    }
    return []
  })
}
const sessions=[{id:rootId,role:'root',file:rootSession.file,sha256:rootSession.sha256,events:publicRows(rootSession,baseline.lastSeq)}]
if(startedAt)for(const item of fs.readdirSync(sessionDirectory,{withFileTypes:true})){
  if(!item.isDirectory()||item.name===rootId)continue
  const current=rowsFor(item.name)
  if(!current||current.header.parentSession!==rootId||current.header.createdAt<startedAt)continue
  const descriptor=current.rows.find(r=>r.type==='subagent/descriptor')?.data
  assert(descriptor?.label?.startsWith('Workflow '),'Unexpected child requires explicit inspection')
  sessions.push({id:item.name,role:'planner',file:current.file,sha256:current.sha256,createdAt:current.header.createdAt,parentSession:current.header.parentSession,label:descriptor.label,events:publicRows(current)})
}
save('native-public-events.json',{capturedAt:new Date().toISOString(),rootSessionId:rootId,baselineSeq:baseline.lastSeq,startedAt,sessions})
const summary={capturedAt:new Date().toISOString(),startedAt:startedAt?new Date(startedAt).toISOString():null,trialCount:trials.length,sourceTrialId:source.id,sourceTrialUpdatedAt:source.updatedAt,sourceTrialSteps:source.steps,sourceReceiptDigest:source.receiptDigest,tasks:taskViews.map(t=>({id:t.id,state:t.state,revision:t.revision,createdAt:t.createdAt,updatedAt:t.updatedAt,compilerMode:t.compilerMode,steps:t.steps,childAttempts:t.childAttempts,candidateAttempts:t.candidateAttempts,distillationAttempts:t.distillationAttempts,model:t.model,effort:t.effort,candidate:!!t.candidate,diagnostics:t.diagnostics,events:t.events?.slice(-3),metricsCount:t.compilerMetrics?.length})),nativeChildCount:sessions.length-1}
save('live-status.json',summary)
console.log(JSON.stringify(summary,null,2))
