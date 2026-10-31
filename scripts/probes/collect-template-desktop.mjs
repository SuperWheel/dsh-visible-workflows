// Read-only evidence collection for the dedicated synthetic Desktop acceptance.
// Keep public tool calls/results and usage; never collect model reasoning or requests.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
const repo=path.resolve(import.meta.dirname,'../..')
const out=path.join(repo,'docs/evidence/template-fill-desktop-20261019')
const sessionDirectory=path.join(os.homedir(),'.dsh/sessions/--private-tmp-dsh-template-fill-acceptance-20261019--')
const rootId='session-3e0588a4-35a6-4069-82f7-c687eee51b1e'
const state=path.join(os.homedir(),'.dsh/visible-dynamic-workflows')
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'))
const save=(name,value)=>fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2)+'\n')
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
function readSession(id){
  const file=path.join(sessionDirectory,id,'session.v4.jsonl.zstd')
  if(!fs.existsSync(file))return
  const bytes=fs.readFileSync(file),chunks=[];let offset=0
  while(offset<bytes.length){const part=zlib.zstdDecompressSync(bytes.subarray(offset),{info:true});assert(part.engine.bytesWritten>0);offset+=part.engine.bytesWritten;chunks.push(part.buffer)}
  const [header,...rows]=Buffer.concat(chunks).toString().trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))
  assert.equal(header.id,id)
  return {header,rows,sha256:sha(bytes)}
}
const root=readSession(rootId);assert(root)
const allowed=name=>name==='structured_output'||name.startsWith('planner_')||name.startsWith('visible_workflow_')||['read','write','ask_user_question'].includes(name)
function publicEvents(session){
  const calls=new Map(session.rows.filter(r=>r.type==='tool/call'&&allowed(r.data.name)).map(r=>[r.data.callId,r.data.name]))
  return session.rows.flatMap(r=>{
    const d=r.data??{},meta={seq:r.seq,time:r.time,type:r.type}
    if(r.type==='tool/call'&&calls.has(d.callId))return [{...meta,...d}]
    if(r.type==='tool/result'&&calls.has(d.message?.toolCallId))return [{...meta,turn:d.turn,step:d.step,name:calls.get(d.message.toolCallId),message:d.message,error:d.error}]
    if(['turn/start','turn/end','model/selection','subagent/descriptor'].includes(r.type))return [{...meta,data:d}]
    if(r.type==='user/message'&&session.header.id===rootId)return [{...meta,text:(d.content??d.message?.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n')}]
    if(['assistant/message','assistant/attempt'].includes(r.type)){
      const usage=d.usage??(d.stream??[]).filter(x=>x.type==='chunk'&&x.chunk?.type==='usage').at(-1)?.chunk?.usage
      return [{...meta,turn:d.turn,step:d.step,usage:usage??null}]
    }
    return []
  })
}
const sessions=[{id:rootId,role:'root',createdAt:root.header.createdAt,sha256:root.sha256,events:publicEvents(root)}]
for(const entry of fs.readdirSync(sessionDirectory,{withFileTypes:true})){
  if(!entry.isDirectory()||entry.name===rootId)continue
  const session=readSession(entry.name)
  if(!session||session.header.parentSession!==rootId)continue
  const descriptor=session.rows.find(row=>row.type==='subagent/descriptor')?.data
  assert(descriptor?.label?.startsWith('Workflow '),'Unexpected child requires separate inspection')
  sessions.push({id:entry.name,role:'planner',label:descriptor.label,createdAt:session.header.createdAt,sha256:session.sha256,events:publicEvents(session)})
}
save('native-public-events.json',{capturedAt:new Date().toISOString(),rootSessionId:rootId,sessions})
const tasks=read(path.join(state,'planning/tasks.json')).tasks.filter(task=>task.sessionId===rootId)
const taskFields=['id','request','state','revision','createdAt','updatedAt','compilerMode','compilerMetrics','diagnostics','steps','childAttempts','candidateAttempts','questionRounds','answers','events','spentTokens','unknownUsageCalls','pendingUsageCalls','candidate','candidateDigest','readiness','receipt','compilerDraft']
save('planning-tasks.json',tasks.map(t=>({...Object.fromEntries(taskFields.filter(k=>t[k]!==undefined).map(k=>[k,t[k]])),model:t.context?.model,effort:t.context?.effort})))
const library=read(path.join(state,'library.json'))
const flows=library.workflows.filter(w=>w.title.startsWith('模板驱动验收·'))
save('workflows.json',flows)
const ids=new Set(flows.map(w=>w.id)),runs=[]
for(const file of fs.readdirSync(path.join(state,'runs'))){
  if(!file.endsWith('.json'))continue
  const run=read(path.join(state,'runs',file));if(!ids.has(run.workflowId))continue
  const eventFile=path.join(state,'runs',run.id+'.events.jsonl')
  runs.push({...run,events:fs.existsSync(eventFile)?fs.readFileSync(eventFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[]})
}
save('graphon-runs.json',runs)
console.log(JSON.stringify({capturedAt:new Date().toISOString(),sessions:sessions.map(s=>({id:s.id,label:s.label,events:s.events.length,last:s.events.slice(-2).map(e=>({type:e.type,name:e.name,time:e.time}))})),tasks:tasks.map(t=>({id:t.id,state:t.state,compilerMode:t.compilerMode})),workflows:flows.map(w=>({id:w.id,revision:w.revision,nodes:w.nodes.length})),runs:runs.map(r=>({id:r.id,status:r.status,error:r.error}))},null,2))
