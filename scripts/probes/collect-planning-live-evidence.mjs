// Read-only, explicit-identity acceptance evidence. Never enumerates session directories.
// Usage: node scripts/probes/collect-planning-live-evidence.mjs /absolute/manifest.json
// Manifest: {stateDirectory,workspaceId,workflowIds:[id],sessions:[{id,file,role:'root'|'planner',parentId?}]}
// Aggregate plugin files must be parsed, but only allowlisted identities are retained or printed.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'

const identity = /^[A-Za-z0-9_-]{1,160}$/
const fail = message => { throw new Error(message) }
const sha = value => crypto.createHash('sha256').update(value).digest('hex')
function readFile(file, maximum = 64_000_000) {
  if (!path.isAbsolute(file)) fail('Every manifest path must be absolute')
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) fail('Invalid or oversized evidence file')
  return fs.readFileSync(file)
}
function readJson(file, optional = false) {
  if (optional && !fs.existsSync(file)) return undefined
  return JSON.parse(readFile(file).toString('utf8'))
}
function readSession(spec) {
  const bytes = readFile(spec.file)
  let text
  if (spec.file.endsWith('.zstd')) {
    let offset = 0; const frames = []
    while (offset < bytes.length) {
      const frame = zlib.zstdDecompressSync(bytes.subarray(offset), { info: true })
      if (!frame.engine.bytesWritten) fail('Invalid session compression frame')
      offset += frame.engine.bytesWritten; frames.push(frame.buffer)
    }
    text = Buffer.concat(frames).toString('utf8')
  } else text = bytes.toString('utf8')
  const rows = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const header = rows[0]
  if (header?.id !== spec.id) fail('Manifest session identity does not match file header')
  if (spec.role === 'planner' && (header.origin !== 'subagent' || header.parentSession !== spec.parentId)) fail('Planner parent/origin does not match manifest')
  return { rows: rows.slice(1), hash: sha(bytes), header }
}
const manifestPath = process.argv[2]
if (!manifestPath) fail('Pass the absolute path to an explicit test-identity manifest')
const manifest = readJson(manifestPath)
if (!path.isAbsolute(manifest.stateDirectory) || typeof manifest.workspaceId !== 'string' || !manifest.workspaceId || !Array.isArray(manifest.workflowIds) || !manifest.workflowIds.length || manifest.workflowIds.some(id => !identity.test(id)) || !Array.isArray(manifest.sessions) || !manifest.sessions.length) fail('Invalid evidence manifest')
if (manifest.sessions.some(s => !identity.test(s.id) || !['root','planner'].includes(s.role) || typeof s.file !== 'string' || s.role === 'planner' && !identity.test(s.parentId))) fail('Invalid session allowlist')
const roots = new Set(manifest.sessions.filter(s => s.role === 'root').map(s => s.id))
const flows = new Set(manifest.workflowIds)
if (manifest.sessions.some(s => s.role === 'planner' && !roots.has(s.parentId))) fail('Every planner must belong to an allowlisted root')
if (new Set(manifest.sessions.map(s => s.id)).size !== manifest.sessions.length) fail('Duplicate session identity')
const stateFile = name => path.join(manifest.stateDirectory, name)
const taskState = readJson(stateFile('planning/tasks.json'), true)
const tasks = (taskState?.tasks ?? []).filter(t => roots.has(t.sessionId) && t.workspaceId === manifest.workspaceId && flows.has(t.context?.workflow.id ?? t.request?.targetWorkflowId))
const library = readJson(stateFile('library.json'))
const editor = readJson(stateFile('editor-state.json'), true)
const proposals = (editor?.proposals ?? []).filter(p => flows.has(p.workflowId))
const taskIds = new Set(tasks.map(t => t.id)), childIds = new Set(tasks.map(t => t.childId).filter(Boolean))
// A persisted task retains its latest child. Explicit manifest children can also
// be earlier attempts; their native parent and descriptor must match below.
const sessions = manifest.sessions.map(spec => {
  const { rows, hash, header } = readSession(spec)
  const descriptor = rows.find(r => r.type === 'subagent/descriptor')?.data
  if (spec.role === 'planner' && !childIds.has(spec.id) && !descriptor?.label?.startsWith('Workflow planning ')) fail('Child is not a known planning attempt')
  const calls = rows.filter(r => r.type === 'tool/call').map(r => {
    let args; try { args = JSON.parse(r.data.arguments) } catch { args = undefined }
    let request; try { request = typeof args?.request_json === 'string' ? JSON.parse(args.request_json) : undefined } catch { request = undefined }
    return { seq:r.seq,turn:r.data.turn,name:r.data.name,callId:r.data.callId,
      ...(r.data.name === 'visible_workflow_plan' && request ? {request:{requestId:request.requestId,operation:request.operation,targetWorkflowId:request.targetWorkflowId,expectedRevision:request.expectedRevision}}:{}),
      ...(r.data.name === 'visible_workflow_budget' && flows.has(args?.workflow_id) ? {budgetChange:{workflowId:args.workflow_id,requestId:args.request_id}}:{}),
      ...(r.data.name === 'ask_user_question' ? {questionIds:Array.isArray(args?.questions)?args.questions.map(q=>q.id):[],hasBudgetMode:JSON.stringify(args??{}).includes('budget-mode')}:{}),
    }
  })
  const commands = rows.filter(r => ['command/run','command/done'].includes(r.type)).map(r => {
    const marker = typeof r.data.text === 'string' && r.data.text.match(/visible-workflow-planning-result:(\{[^\n]+\})/)
    let result; try { result = marker ? JSON.parse(marker[1]) : undefined } catch { result = undefined }
    return {seq:r.seq,type:r.type,commandId:r.data.commandId,name:r.data.name,kind:r.data.kind,
      ...(r.data.kind==='error'&&typeof r.data.text==='string'?{errorSummary:r.data.text.split('visible-workflow-planning-result:')[0].trim().slice(0,2000)}:{}),
      ...(result && taskIds.has(result.taskId)?{result}:{})}
  })
  const attempts = rows.filter(r => ['assistant/message','assistant/attempt'].includes(r.type)).map(r => {
    const usage=r.data.usage ?? r.data.stream?.filter(s=>s.type==='chunk'&&s.chunk?.type==='usage').at(-1)?.chunk?.usage
    return {seq:r.seq,type:r.type,turn:r.data.turn,step:r.data.step,usage:usage??null}
  })
  return {id:spec.id,role:spec.role,file:spec.file,sha256:hash,origin:header.origin,parentSession:header.parentSession,
    descriptor:descriptor?{provider:descriptor.provider,label:descriptor.label}:undefined,
    modelSelections:rows.filter(r=>r.type==='model/selection').map(r=>({seq:r.seq,...r.data})),
    requestHeaders:rows.filter(r=>r.type==='request/header').map(r=>({seq:r.seq,provider:r.data.header.config?.provider??r.data.header.provider,model:r.data.header.config?.model??r.data.header.model,tools:r.data.header.tools?.map(t=>t.name)})),
    calls,commands,attempts,
    turnEnds:rows.filter(r=>r.type==='turn/end').map(r=>({seq:r.seq,turn:r.data.turn,reason:r.data.reason})),
    results:rows.filter(r=>r.type==='tool/result').map(r=>({seq:r.seq,callId:r.data.message.toolCallId,isError:r.data.message.isError??false,errorCode:r.data.error?.code})),
  }
})
const budgetChoices = [...roots].flatMap(sessionId => [...flows].map(workflowId => {
  const scope = {workspaceId:manifest.workspaceId,sessionId,workflowId}
  const file = stateFile(`creation-budgets/${sha(JSON.stringify([scope.workspaceId,scope.sessionId,scope.workflowId]))}.json`)
  const value = readJson(file,true)
  if (value && JSON.stringify(value.scope)!==JSON.stringify(scope)) fail('Budget scope mismatch')
  return {scope,exists:!!value,...(value?{mode:value.mode,decidedAt:value.decidedAt,policy:value.policy,completedChangeRequestIds:value.completedChangeRequestIds??[],pendingChange:!!value.pendingChange,sha256:sha(readFile(file))}:{})}
}))
const receipts = [...(library.planningReceipts??[]),...(editor?.planningReceipts??[])].filter(r=>flows.has(r.workflowId))
console.log(JSON.stringify({checkedAt:new Date().toISOString(),manifestSha256:sha(readFile(manifestPath)),
  sessions,budgetChoices,
  tasks:tasks.map(t=>({id:t.id,sessionId:t.sessionId,workspaceId:t.workspaceId,state:t.state,revision:t.revision,createdAt:t.createdAt,updatedAt:t.updatedAt,requestId:t.request.requestId,operation:t.request.operation,workflowId:t.context?.workflow.id,childId:t.childId,childAttempts:t.childAttempts,steps:t.steps,spentTokens:t.spentTokens,unknownTokens:t.unknownTokens,reservedTokens:t.reservedTokens,events:t.events,diagnostics:t.diagnostics,receipt:t.receipt})),
  workflows:library.workflows.filter(f=>flows.has(f.id)).map(f=>({id:f.id,title:f.title,revision:f.revision,workspaceId:f.workspaceId,budgetDecision:f.budgetDecision,executionPolicy:f.executionPolicy,nodeKinds:f.nodes.map(n=>n.kind),edgeCount:f.edges.length})),
  proposals:proposals.map(p=>({id:p.id,workflowId:p.workflowId,baseRevision:p.baseRevision,status:p.status,createdAt:p.createdAt,candidateBudget:p.candidate?.budgetDecision,candidatePolicy:p.candidate?.executionPolicy})),receipts,
  limits:['Native userQuestions.ask UI waterfall calls are not guaranteed to be session tool/call events. UI question counts need separate observations.','This collector does not prove UI navigation or rendering; compare screenshots and visible proposal state.','Only allowlisted synthetic session and workflow identities are emitted. No model calls or host mutations are performed.'],
},null,2))
