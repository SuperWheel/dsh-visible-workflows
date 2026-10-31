import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import {spawnSync} from 'node:child_process'
import {parseArgs,bindRequests,projectRootEvents,projectPublicTask,projectDurableTask,childIdsFor,compareConservation,collect,ALLOWED_FLOWS} from '../../scripts/probes/collect-planning-incremental.mjs'
import {SCOPE,sha} from '../../scripts/probes/collect-planning-speed-desktop.mjs'
const root='incremental-root',child='incremental-child',requestId='s11-explicit-request',flow=[...ALLOWED_FLOWS][0],taskId='incremental-task'
const scope={rootId:root,requestIds:[requestId],workflowIds:[flow]}
const task=(overrides={})=>({taskId,requestId,workflowId:flow,state:'queued',revision:2,preview:true,delivery:{mode:'background',protocolVersion:1,acceptedAt:'2026-10-20T00:00:00.000Z'},usage:{childAttempts:0,spentTokens:null},...overrides})
function call(name='visible_workflow_plan',callId='call-plan',overrides={}){
  const args=name==='visible_workflow_plan'?{request_json:JSON.stringify({requestId,operation:'revise',targetWorkflowId:flow,expectedRevision:1,instruction:'Explicit input'})}:{request_id:requestId,workflow_id:flow,expected_revision:1,instruction:'Explicit input',...(name==='visible_workflow_splice'?{chain_json:'{}'}:{changes:[]})}
  return {type:'tool/call',seq:1,time:10,name,callId,arguments:JSON.stringify(args),...overrides}
}
const receipt=(value=task(),callId='call-plan',name='visible_workflow_plan',seq=2)=>({type:'tool/result',seq,time:seq*10,name,message:{toolCallId:callId,isError:false,content:[{type:'text',text:JSON.stringify(value)}]}})
const binding=events=>bindRequests(events,root,[requestId],[flow])
test('CLI fails before profile reads without explicit root/request/allowlisted workflow and rejects profile overrides',()=>{
  const good=['--root-session-id',root,'--request-id',requestId,'--workflow-id',flow]
  assert.deepEqual(parseArgs(good),{...scope,before:undefined})
  for(const args of [[],good.slice(0,4),good.slice(2),[...good,'--state','/secret'],[...good,'--request-id',requestId],[...good,'--workflow-id','foreign'],[...good,'--before','/private/tmp/summary.json'],['--root-session-id','../bad',...good.slice(2)]])assert.throws(()=>parseArgs(args))
  const p=spawnSync(process.execPath,['scripts/probes/collect-planning-incremental.mjs'],{encoding:'utf8'});assert.equal(p.status,1);assert.equal(JSON.parse(p.stderr).reason,'SCOPED_INCREMENTAL_READ_ONLY_COLLECTION_FAILED')
})
test('all three real root initiation tools bind only paired receipt identities',()=>{
  for(const name of ['visible_workflow_plan','visible_workflow_edit','visible_workflow_splice']){const b=binding([call(name),receipt(task(),'call-plan',name)]);assert.equal(b.bindings[requestId].taskId,taskId);assert.equal(b.bindings[requestId].workflowId,flow);assert.equal(b.errors.length,0)}
  for(const events of [[receipt()],[{type:'assistant/message',text:JSON.stringify(task())}],[]])assert.equal(Object.keys(binding(events).bindings).length,0)
})
test('explicit request ID never permits foreign flow, workspace, create operation or mismatched receipt',()=>{
  for(const patch of [{targetWorkflowId:'foreign'},{workspaceId:'foreign'},{operation:'create'}]){
    const c=call(),args=JSON.parse(c.arguments);args.request_json=JSON.stringify({...JSON.parse(args.request_json),...patch});c.arguments=JSON.stringify(args)
    const b=binding([c,receipt()]);assert.equal(Object.keys(b.bindings).length,0);assert.equal(b.errors[0].code,'EXPLICIT_REQUEST_SCOPE_MISMATCH')
  }
  for(const value of [task({requestId:'unselected'}),task({taskId:'../bad'}),task({workflowId:'foreign'}),task({candidate:{id:flow,workspaceId:'foreign'}})])assert.equal(Object.keys(binding([call(),receipt(value)]).bindings).length,0)
  const error=receipt();error.message.isError=true;assert.equal(binding([call(),error]).errors[0].code,'INITIATING_TOOL_ERROR')
})
test('duplicate request preserves exact task identity while changed identities are errors',()=>{
  const b=binding([call(),receipt(),call('visible_workflow_edit','repeat'),receipt(task(),'repeat','visible_workflow_edit',4),call('visible_workflow_splice','conflict'),receipt(task({taskId:'other-task'}),'conflict','visible_workflow_splice',6)])
  assert.equal(b.bindings[requestId].receipts.length,2);assert.equal(b.bindings[requestId].taskId,taskId);assert.equal(b.errors.at(-1).code,'REQUEST_IDENTITY_CONFLICT')
})
test('bound root controls retain include_metrics and exact snapshots, chain mapping, questions and null usage',()=>{
  const controls=['get','answer','cancel','publish'].flatMap((suffix,i)=>{
    const args={task_id:taskId,...(suffix==='get'?{include_metrics:true,include_candidates:true}:suffix==='answer'?{revision:2,answers_json:'[{"questionId":"q","answer":"human answer"}]'}:suffix==='publish'?{revision:3,candidate_digest:'a'.repeat(64)}:{})}
    return [{type:'tool/call',seq:3+i*2,time:30+i,name:'visible_workflow_plan_'+suffix,callId:suffix,arguments:JSON.stringify(args)},receipt(task({state:suffix==='get'?'awaiting_input':'ready',questions:[{id:'q'}],chain:{mapping:[{nodeId:'stable',temporaryAlias:'a-1#1'}]},compilerMetrics:[{childId:child,inputBytes:123}]}),suffix,'visible_workflow_plan_'+suffix,4+i*2)]
  })
  const events=[call(),receipt(),...controls],p=projectRootEvents(events,binding(events))
  assert.equal(p.controlCalls.length,4);assert.equal(p.controlCalls[0].arguments.include_metrics,true);assert.equal(p.taskSnapshots.length,5)
  assert.equal(p.taskSnapshots.at(-1).task.chain.mapping[0].nodeId,'stable');assert.equal(p.taskSnapshots.at(-1).task.usage.spentTokens,null)
  assert.deepEqual([...childIdsFor([],p.taskSnapshots)],[child])
})
test('unbound tool bodies, task-swapped controls and private material are not exported',()=>{
  const events=[call(),receipt(),{type:'tool/call',callId:'foreign',name:'visible_workflow_plan_get',arguments:JSON.stringify({task_id:'foreign'})},receipt(task({taskId:'foreign',summary:'NEVER-FOREIGN'}),'foreign','visible_workflow_plan_get'),{type:'tool/call',callId:'bad-control',name:'visible_workflow_plan_get',arguments:JSON.stringify({task_id:taskId,rawRequest:'NEVER-RAW'})},receipt(task({summary:'NEVER-RAW'}),'bad-control','visible_workflow_plan_get')]
  const p=projectRootEvents(events,binding(events));assert(!JSON.stringify(p).includes('NEVER'))
  const projected=projectPublicTask(task({thinking:'NEVER',source:'NEVER',history:'NEVER',requestHeader:'NEVER',summary:'safe <analysis>NEVER</analysis>',usage:{spentTokens:null,token:'NEVER'},candidate:{id:flow,workspaceId:SCOPE.workspaceId,environmentVariables:[{type:'secret',value:'NEVER'}]}}),flow)
  assert(!JSON.stringify(projected).includes('NEVER'));assert.equal(projected.usage.spentTokens,null);assert(!Object.hasOwn(projected,'compilerMetrics'))
})
test('a paired control for task A cannot export another selected task B payload',()=>{
  const secondId='second-request',secondTask='second-task',secondCall=call('visible_workflow_edit','second-call')
  secondCall.arguments=JSON.stringify({...JSON.parse(secondCall.arguments),request_id:secondId})
  const events=[call(),receipt(),secondCall,receipt(task({taskId:secondTask,requestId:secondId}),'second-call','visible_workflow_edit',4),{type:'tool/call',seq:5,time:50,callId:'get-a',name:'visible_workflow_plan_get',arguments:JSON.stringify({task_id:taskId,include_metrics:true})},receipt(task({taskId:secondTask,requestId:secondId,summary:'NEVER_TASK_SWAPPED'}),'get-a','visible_workflow_plan_get',6)]
  const bound=bindRequests(events,root,[requestId,secondId],[flow]),p=projectRootEvents(events,bound)
  assert.equal(p.taskSnapshots.length,2);assert(!JSON.stringify(p).includes('NEVER_TASK_SWAPPED'))
})
test('an orphan control result cannot borrow a later call identity',()=>{
  const events=[call(),receipt(),receipt(task({summary:'NEVER_ORPHAN'}),'future-get','visible_workflow_plan_get',3),{type:'tool/call',seq:4,time:40,name:'visible_workflow_plan_get',callId:'future-get',arguments:JSON.stringify({task_id:taskId})}]
  const p=projectRootEvents(events,binding(events));assert.equal(p.taskSnapshots.length,1);assert(!JSON.stringify(p).includes('NEVER_ORPHAN'))
})
test('durable task projection requires exact root/request/task/flow and never imports private context',()=>{
  const b={taskId,requestId,workflowId:flow},raw={id:taskId,sessionId:root,workspaceId:SCOPE.workspaceId,request:{requestId,targetWorkflowId:flow},state:'ready',compilerMetrics:[],chainState:{mapping:[]},context:{messages:'NEVER'},source:'NEVER'}
  const p=projectDurableTask(raw,b,root);assert.deepEqual(p.compilerMetrics,[]);assert(!JSON.stringify(p).includes('NEVER'))
  for(const patch of [{id:'other'},{sessionId:'other'},{workspaceId:'other'},{request:{requestId:'other',targetWorkflowId:flow}}])assert.throws(()=>projectDurableTask({...raw,...patch},b,root))
})
function fixture(){
  const directory=fs.mkdtempSync('/private/tmp/planning-incremental-test-'),stateDirectory=path.join(directory,'profile'),sessionsDirectory=path.join(directory,'sessions'),outputRoot=path.join(directory,'evidence')
  fs.mkdirSync(path.join(stateDirectory,'planning'),{recursive:true});fs.mkdirSync(path.join(stateDirectory,'runs'));fs.mkdirSync(sessionsDirectory)
  const write=(relative,value)=>fs.writeFileSync(path.join(stateDirectory,relative),JSON.stringify(value))
  const header=(id,parentSession,cwd=SCOPE.workspaceRoot)=>({type:'session',version:4,id,cwd,...(parentSession?{parentSession}:{})})
  function session(id,h,events,invalidBody=false){const dir=path.join(sessionsDirectory,id);fs.mkdirSync(dir);const rows=events.map(e=>{const {type,seq,time,...data}=e;return {type,seq,time,data}});fs.writeFileSync(path.join(dir,'session.v4.jsonl.zstd'),Buffer.concat([zlib.zstdCompressSync(Buffer.from(JSON.stringify(h)+'\n')),zlib.zstdCompressSync(Buffer.from(invalidBody?'NEVER_PARSE_UNBOUND_SESSION\n':rows.map(r=>JSON.stringify(r)).join('\n')+'\n'))]))}
  const get={type:'tool/call',seq:3,time:30,callId:'metrics',name:'visible_workflow_plan_get',arguments:JSON.stringify({task_id:taskId,include_metrics:true})}
  session(root,header(root),[call(),receipt(),get,receipt(task({state:'awaiting_input',compilerMetrics:[{childId:child,event:'request-summary',inputBytes:123,requestSummary:{toolNames:['planner_submit'],reasoning:'NEVER'}}],questions:[{id:'choice',text:'Human decision'}]}),'metrics','visible_workflow_plan_get',4),{type:'tool/call',seq:5,time:50,callId:'other',name:'visible_workflow_plan',arguments:JSON.stringify({request_json:JSON.stringify({requestId:'unselected',operation:'revise',targetWorkflowId:flow,instruction:'NEVER_UNSELECTED'})})},{type:'assistant/message',seq:6,time:60,content:[{type:'text',text:'NEVER_PROSE'}],usage:{totalTokens:11}}])
  session(child,header(child,root),[{type:'step/start',seq:1,time:20},{type:'assistant/message',seq:2,time:25,content:[{type:'thinking',text:'NEVER_THINK'}],usage:{totalTokens:7}},{type:'tool/call',seq:3,time:26,callId:'query',name:'planner_query',arguments:{secret:'NEVER_CHILD_BODY'}},{type:'tool/result',seq:4,time:27,message:{toolCallId:'query',content:[{type:'text',text:'NEVER_CHILD_BODY'}]}}])
  session('unbound-child',header('unbound-child',root),[],true);session('foreign-root',header('foreign-root',undefined,'/foreign'),[],true);session('foreign-child',header('foreign-child',root,'/foreign'),[],true)
  const flowRow={id:flow,workspaceId:SCOPE.workspaceId,revision:1,nodes:[],edges:[],budgetDecision:{mode:'unlimited'},executionPolicy:{}}
  write('library.json',{workflows:[{id:'foreign',workspaceId:'foreign',private:'NEVER_PARSE_FOREIGN_RECORD'},flowRow]})
  write('planning/tasks.json',{tasks:[{id:'unselected-task',workspaceId:SCOPE.workspaceId,sessionId:root,private:'NEVER_PARSE_FOREIGN_RECORD'}]})
  write('planning/background.json',{tasks:[{id:taskId,taskId,requestId,workspaceId:SCOPE.workspaceId,sessionId:root,state:'accepted',acceptedAt:'2026-10-20T00:00:00Z',history:'NEVER_BACKGROUND_HISTORY'}]})
  write('editor-state.json',{proposals:[{id:'p',workflowId:flow,status:'pending',candidate:flowRow},{id:'foreign',workflowId:'foreign',private:'NEVER_PARSE_FOREIGN_RECORD'}]})
  write('runs/run-selected.json',{id:'run-selected',workflowId:flow,workspaceId:SCOPE.workspaceId,status:'success'});write('runs/run-foreign.json',{id:'run-foreign',workflowId:'foreign',workspaceId:'foreign',private:'NEVER_PARSE_FOREIGN_RECORD'})
  fs.writeFileSync(path.join(stateDirectory,'runs/run-selected.events.jsonl'),'{}\n')
  return {directory,stateDirectory,sessionsDirectory,outputRoot,flowRow,write,io:{stateDirectory,sessionsDirectory,outputRoot},cleanup:()=>fs.rmSync(directory,{recursive:true,force:true})}
}
const profileHashes=directory=>Object.fromEntries(fs.readdirSync(directory,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{const file=path.join(e.parentPath,e.name);return [file,sha(fs.readFileSync(file))]}))
test('end-to-end fixture collection is read-only and keeps preview state unknown while actual metrics bind only owned child',()=>{
  const f=fixture(),parse=JSON.parse,before=profileHashes(f.stateDirectory),sessionsBefore=profileHashes(f.sessionsDirectory)
  try{
    JSON.parse=value=>{assert(!value.includes('NEVER_PARSE_FOREIGN_RECORD'));assert(!value.includes('NEVER_PARSE_UNBOUND_SESSION'));return parse(value)}
    const result=collect(scope,f.io);JSON.parse=parse
    assert.equal(result.tasks[0].currentTaskState,null);assert.equal(result.tasks[0].backgroundState,'accepted');assert.equal(result.tasks[0].lastPublicSnapshot.state,'awaiting_input')
    assert.equal(result.tasks[0].compilerMetricsSource,'actual-public-tool-snapshot');assert.equal(result.tasks[0].compilerMetrics[0].inputBytes,123)
    assert.deepEqual(result.children.map(c=>c.id),[child]);assert(result.unboundDescendantIds.includes('unbound-child'));assert(!result.children.some(c=>c.id==='foreign-child'))
    assert.equal(result.comparison.allUnchanged,null);assert.deepEqual(profileHashes(f.stateDirectory),before);assert.deepEqual(profileHashes(f.sessionsDirectory),sessionsBefore)
    const output=path.join(f.outputRoot,fs.readdirSync(f.outputRoot)[0]),text=fs.readdirSync(output).map(name=>fs.readFileSync(path.join(output,name),'utf8')).join('\n')
    assert(!text.includes('NEVER'));assert(text.includes('"totalTokens": 7'));assert(text.includes('"totalTokens": 11'));assert.equal(fs.statSync(path.join(output,'summary.json')).mode&0o777,0o600)
    const second=collect({...scope,before:path.join(output,'summary.json')},f.io);assert.equal(second.comparison.allUnchanged,true)
    f.write('library.json',{workflows:[{...f.flowRow,revision:2}]});const third=collect({...scope,before:path.join(output,'summary.json')},f.io);assert.equal(third.comparison.workflows,false);assert.equal(third.comparison.budgets,true)
    assert.throws(()=>collect({...scope,rootId:'foreign-root'},f.io),/scope mismatch|header mismatch|Explicit root|Root/)
  }finally{JSON.parse=parse;f.cleanup()}
})
test('missing metrics and usage remain null; no descendant is guessed by proximity or label',()=>{
  const f=fixture()
  try{
    const file=path.join(f.sessionsDirectory,root,'session.v4.jsonl.zstd'),h={type:'session',version:4,id:root,cwd:SCOPE.workspaceRoot},rows=[call(),receipt(task({usage:null}))].map(e=>{const {type,seq,time,...data}=e;return {type,seq,time,data}})
    fs.writeFileSync(file,zlib.zstdCompressSync(Buffer.from([JSON.stringify(h),...rows.map(r=>JSON.stringify(r))].join('\n')+'\n')))
    const result=collect(scope,f.io);assert.equal(result.tasks[0].compilerMetrics,null);assert.equal(result.tasks[0].usage,null);assert.equal(result.children.length,0)
    assert(result.unboundDescendantIds.includes(child))
  }finally{f.cleanup()}
})
test('collection rejects symlinked profile ancestry and never creates evidence in the profile',()=>{
  const f=fixture()
  try{
    const linked=path.join(f.directory,'linked-profile');fs.symlinkSync(f.stateDirectory,linked)
    assert.throws(()=>collect(scope,{...f.io,stateDirectory:linked}),/Symbolic links/)
    assert.throws(()=>collect(scope,{...f.io,outputRoot:path.join(f.stateDirectory,'evidence')}),/outside profile/)
    assert(!fs.existsSync(path.join(f.stateDirectory,'summary.json')))
    assert.equal(fs.existsSync(f.outputRoot),false)
  }finally{f.cleanup()}
})
test('conservation compares every selected flow/proposal/budget/run hash and unknown before never passes',()=>{
  const before={workflows:[],proposals:[],budgets:[],runs:[]};assert.equal(compareConservation(null,before).allUnchanged,null);assert.equal(compareConservation(before,structuredClone(before)).allUnchanged,true)
  for(const key of Object.keys(before)){const after={...before,[key]:[{id:'changed',sha256:'different'}]};assert.equal(compareConservation(before,after)[key],false)}
})
