import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { templateContext } from './fixtures/planning-compiler/template.ts'
import { tools } from './fixtures/t18-tools.ts'
import { operationDigest } from '../src/shared/tool-operation-contract.ts'
import { planningReviewIssues, REVIEW_DRAFT_PREFIX, reviewDraftPath } from '../src/shared/planning-review.ts'
import { reviewedFileWriteGraph } from '../src/shared/planning-review-recipe.ts'
import { planningCandidateIssues } from '../src/shared/planning-projection.ts'
import { planningToolPreconditionIssues } from '../src/shared/planning-tool-preconditions.ts'
import { queryWorkflowSemantics } from '../src/shared/workflow-semantics.ts'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { templateIdForTool } from '../src/shared/planning-node-templates.ts'
import { parseWorkflow } from '../src/shared/workflow-validation.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { createExecutionAdapters } from '../src/host/execution-adapters.ts'
import { ToolCatalog } from '../src/host/tool-catalog.ts'
import type { NodeGraph, WorkflowNode } from '../src/shared/types.ts'

const n=(id:string,kind:WorkflowNode['kind'],config:WorkflowNode['config']={}):WorkflowNode=>({id,kind,config,title:id,number:id,x:0,y:0,fixed:false})
const edges=(rows:string[][])=>rows.map(([source,target,port],i)=>({id:'e'+i,source:source!,target:target!,...(port?{port}:{})}))
const flat=(g:NodeGraph):WorkflowNode[]=>g.nodes.flatMap(n=>[n,...(n.config.body?flat(n.config.body):[])])
function fixture(){
  const c=templateContext(),graph=reviewedFileWriteGraph({target:'t05-greeting.json',producer:{kind:'template',config:{text:'Hello Ada{{reviewBase}}{{reviewNote}}'}}})
  c.tools=tools()
  const f={...c.workflow,...graph};c.nodeIds=flat(f).map(n=>n.id);return {c,f}
}
const body=(f:ReturnType<typeof fixture>['f'])=>f.nodes.find(n=>n.kind==='loop')!.config.body!
function oldGreeting(){
  const {c,f}=fixture()
  f.nodes=[n('start','input',{fields:[]}),n('write','tool',{toolId:'native:write',inputs:{file_path:'t05-greeting.json',content:'Hello Ada'}}),n('human','human',{fields:[{name:'note',label:'意见',required:false}],actions:[{id:'approve',label:'核对通过'},{id:'reject',label:'核对不通过'}]}),n('ok','output',{text:'ok'}),n('no','output',{text:'review_rejected'})]
  f.edges=edges([['start','write'],['write','human'],['human','ok','approve'],['human','no','reject']]);c.nodeIds=flat(f).map(n=>n.id)
  return {c,f}
}
const review=(v:ReturnType<typeof fixture>)=>planningReviewIssues(v.f,v.c)
describe('T20 planning review before effects',()=>{
  it('rejects the new T05 write-before-human shape at the exact target argument',()=>{
    const v=oldGreeting(),before=structuredClone(v.f),issues=review(v)
    expect(issues).toEqual([expect.objectContaining({code:'REVIEW_BEFORE_EFFECT',nodeId:'write',path:'config.inputs.file_path',message:expect.stringContaining('t05-greeting.json')})])
    expect(issues[0]!.message).toContain(REVIEW_DRAFT_PREFIX);expect(v.f).toEqual(before)
  })
  it('accepts the draft-review-commit recipe through all shared planning checks and T18',()=>{
    const {c,f}=fixture();expect(planningCandidateIssues(f,c)).toEqual([]);expect(planningToolPreconditionIssues(f,c)).toEqual([])
    expect(body(f).nodes.find(n=>n.id==='reviewGate')!.config.actions).toHaveLength(2)
    expect(f.nodes.find(n=>n.kind==='loop')!.config.maxIterations).toBe(3)
  })
  it('checks native review structure without inventing a T18 registration contract',()=>{
    const v=fixture();v.c.tools=v.c.tools.map(t=>({...t,operationContract:undefined}))
    expect(review(v)).toEqual([]);expect(v.c.tools.every(t=>t.operationContract===undefined)).toBe(true)
    body(v.f).nodes.find(n=>n.id==='commit')!.config.inputs!.content='{{produce.text}}'
    expect(review(v)).toContainEqual(expect.objectContaining({path:'config.inputs.content'}))
  })
  it('leaves an unchanged legacy graph and unrelated scoped edits alone',()=>{
    const v=oldGreeting();v.c.operation='revise';v.c.workflow=structuredClone(v.f)
    expect(review(v)).toEqual([])
    v.f.nodes.find(n=>n.id==='no')!.config.text='clarified rejection';v.c.targetNodeIds=['no']
    expect(review(v)).toEqual([])
    v.f.nodes.find(n=>n.id==='write')!.config.inputs!.content='new';v.c.targetNodeIds=['write']
    expect(review(v).map(i=>i.code)).toContain('REVIEW_BEFORE_EFFECT')
  })
  it('rechecks existing effects if a gate or approval topology is added or changed',()=>{
    const v=oldGreeting();v.c.operation='revise';v.c.workflow=structuredClone(v.f);v.c.workflow.nodes=v.c.workflow.nodes.filter(n=>n.id!=='human')
    expect(review(v).map(i=>i.nodeId)).toContain('write')
    const correct=fixture();correct.c.operation='revise';correct.c.workflow=structuredClone(correct.f)
    body(correct.f).edges.push({id:'bypass',source:'roundStart',target:'commit'})
    expect(review(correct)).toContainEqual(expect.objectContaining({nodeId:'commit',path:'config.inputs.file_path'}))
  })
  it.each(['default','reject','timeout'])('refuses %s as an approval path',port=>{
    const v=fixture();body(v.f).edges.find(e=>e.source==='reviewGate'&&e.target==='commit')!.port=port
    expect(review(v)).toContainEqual(expect.objectContaining({code:'REVIEW_BEFORE_EFFECT',nodeId:'commit',path:'config.inputs.file_path'}))
  })
  it.each(['native:edit','native:bash','swagger:p:post:%2Fsend','swagger:p:delete:%2Fsend'])('presumes %s is an effect even without an operation contract',id=>{
    const v=oldGreeting();v.f.nodes.find(n=>n.id==='write')!.config.toolId=id;v.c.tools=[]
    expect(review(v)).toContainEqual(expect.objectContaining({nodeId:'write',code:'REVIEW_BEFORE_EFFECT'}))
  })
  it.each(['POST','PUT','PATCH','DELETE'])('presumes HTTP %s is irreversible',method=>{
    const v=oldGreeting();Object.assign(v.f.nodes.find(n=>n.id==='write')!,{kind:'http',config:{url:'https://example.invalid',method}})
    expect(review(v)).toContainEqual(expect.objectContaining({nodeId:'write',path:'config.method'}))
  })
  it.each(['GET','HEAD'])('does not presume HTTP/Swagger %s writes',method=>{
    const v=oldGreeting();Object.assign(v.f.nodes.find(n=>n.id==='write')!,{kind:'http',config:{url:'https://example.invalid',method}});expect(review(v)).toEqual([])
    Object.assign(v.f.nodes.find(n=>n.id==='write')!,{kind:'tool',config:{toolId:`swagger:p:${method.toLowerCase()}:%2Fdata`}});expect(review(v)).toEqual([])
  })
  it('tightens known file-write contracts under a different native ID, never unknown names',()=>{
    const v=oldGreeting(),tool=structuredClone(v.c.tools[1]!);tool.id='native:save';tool.name='save'
    if(tool.operationContract?.status!=='known')throw Error('fixture')
    tool.operationContract.declaration.sourceId='native-tool:save';tool.operationContract.digest=operationDigest(tool.operationContract.declaration);v.c.tools.push(tool)
    v.f.nodes.find(n=>n.id==='write')!.config.toolId=tool.id;expect(review(v)).not.toEqual([])
    const bash=structuredClone(tool);bash.id='native:bash'
    if(bash.operationContract?.status!=='known')throw Error('fixture')
    bash.operationContract.declaration.sourceId='native-tool:bash';bash.operationContract.digest=operationDigest(bash.operationContract.declaration);v.c.tools.push(bash)
    v.f.nodes.find(n=>n.id==='write')!.config={toolId:bash.id,inputs:{file_path:REVIEW_DRAFT_PREFIX+'bash.txt'}}
    expect(review(v).map(i=>i.nodeId)).toContain('write')
    v.f.nodes.find(n=>n.id==='write')!.config.toolId='unknown:write';expect(review(v)).toEqual([])
  })
  it('does not let document source conversion hide the real write path for unknown native contracts',()=>{
    const v=oldGreeting(),write=v.f.nodes.find(n=>n.id==='write')!;v.c.tools=[]
    write.kind='document';write.config={toolId:'native:write',documentMode:'tool',source:'target.txt',documentSourceKey:'file_path',inputs:{file_path:REVIEW_DRAFT_PREFIX+'fake.txt'}}
    expect(review(v)).toContainEqual(expect.objectContaining({nodeId:'write',path:'config.documentMode'}))
  })
  it.each(['.dsh-drafts/other/out.json','.dsh-drafts/{{sys.workflow_run_id}}/../out.json','.dsh-drafts/{{sys.workflow_run_id}}/{{input.path}}','.dsh-drafts/{{sys.workflow_run_id}}/x/../../out.json','{{input.draft}}'])('does not accept unproved draft prefix %s',path=>{
    expect(reviewDraftPath(path)).toBe(false)
    const v=fixture();body(v.f).nodes.find(n=>n.id==='draftWrite')!.config.inputs!.file_path=path
    expect(review(v)).toContainEqual(expect.objectContaining({nodeId:'draftWrite',path:'config.inputs.file_path'}))
  })
  it.each(['old-content','missing-observation','late-read','cached-read','no-revise-note','no-revise-base','no-form-default','wrong-form-type','no-file-warning','repeated-commit','no-limit-output','different-draft'])('rejects %s with a concrete fix',change=>{
    const v=fixture(),g=body(v.f),find=(id:string)=>g.nodes.find(n=>n.id===id)!
    if(change==='old-content')find('commit').config.inputs!.content='{{produce.text}}'
    if(change==='missing-observation')v.f.nodes.find(n=>n.id==='targetBefore')!.config.inputs!.file_path='other.txt'
    if(change==='late-read'){g.nodes.push(n('lateRead','tool',{toolId:'native:read',inputs:{file_path:'t05-greeting.json'},cache:'never'}));g.edges.find(e=>e.source==='reviewGate'&&e.port==='approve')!.target='lateRead';g.edges.push({id:'late',source:'lateRead',target:'commit'})}
    if(change==='cached-read')v.f.nodes.find(n=>n.id==='targetBefore')!.config.cache='reuse'
    if(change==='no-revise-note')find('revise').config.assignments!.shift()
    if(change==='no-revise-base')find('revise').config.assignments!.pop()
    if(change==='no-form-default')find('reviewGate').config.fields![0]!.defaultValue='old'
    if(change==='wrong-form-type')find('reviewGate').config.fields![0]!.type='text'
    if(change==='no-file-warning')find('reviewGate').config.prompt='Review'
    if(change==='repeated-commit')v.f.nodes.find(n=>n.kind==='loop')!.config.until=undefined
    if(change==='no-limit-output')v.f.nodes.find(n=>n.id==='notApproved')!.config.text='success'
    if(change==='different-draft')find('draftWrite').config.inputs!.file_path=REVIEW_DRAFT_PREFIX+'other.txt'
    const issues=review(v);expect(issues.length).toBeGreaterThan(0);expect(issues.every(i=>i.message.includes('：'))).toBe(true)
  })
  it('rejects a branch that only shares an independent approval condition, including nested effects',()=>{
    const v=oldGreeting();v.f.nodes.find(n=>n.id==='write')!.kind='loop';v.f.nodes.find(n=>n.id==='write')!.config={maxIterations:1,body:{nodes:[n('innerStart','input',{fields:[]}),n('bash','tool',{toolId:'native:bash'})],edges:edges([['innerStart','bash']])}}
    expect(review(v)).toContainEqual(expect.objectContaining({nodeId:'bash'}))
    v.f.edges=edges([['start','human'],['human','write','approve'],['human','no','reject'],['write','ok']]);expect(review(v)).toEqual([])
  })
  it('leaves no-gate graphs unchanged and reports all pre-review writes in one round',()=>{
    const plain=fixture();Object.assign(body(plain.f).nodes.find(n=>n.id==='reviewGate')!,{kind:'template',config:{text:''}})
    expect(review(plain)).toEqual([])
    const v=oldGreeting();v.f.nodes.find(n=>n.id==='human')!.config.actions=[{id:'approve',label:'继续'}];expect(review(v)).toEqual([])
    v.f.nodes.find(n=>n.id==='human')!.config.actions!.push({id:'reject',label:'拒绝'})
    v.f.nodes.push(n('another','tool',{toolId:'native:write',inputs:{file_path:'another.json',content:'x'}}));v.f.edges.push({id:'another-edge',source:'start',target:'another'})
    expect(review(v).map(i=>i.nodeId)).toEqual(['write','another'])
  })
  it.each(['compact-repair','template-fill'])('reports actionable feedback through the %s authoring frontend',mode=>{
    const {c}=oldGreeting();c.nodeIds=Array.from({length:150},(_,i)=>'allocated-'+i);c.tools=c.tools.map(t=>({...t,operationContract:undefined}))
    const defs={start:{kind:'input',config:{fields:[]}},write:{kind:'tool',config:{toolId:'native:write',inputs:{file_path:'t05-greeting.json',content:'Hello Ada'}}},review:{kind:'human',config:{fields:[],actions:[{id:'approve',label:'通过'},{id:'reject',label:'拒绝'}]}},result:{kind:'output',config:{text:'done'}}}
    const chains={main:{nodes:['start','write','review']}},links={yes:{source:'review',target:'result',port:'approve'},no:{source:'review',target:'result',port:'reject'}}
    const compiler=mode==='compact-repair'?new WorkflowAuthoringCompiler(c):new TemplateFillingCompiler(c)
    if(compiler instanceof TemplateFillingCompiler)compiler.queryTemplates(compiler.catalog().templates.map(t=>t.id))
    const submission=mode==='compact-repair'?{mode:'create',title:'T05',nodesByKey:defs,chainsByKey:chains,linksByKey:links,coverage:{R1:['write','review']}}:{mode:'create',title:'T05',formsByKey:Object.fromEntries(Object.entries(defs).map(([key,n])=>[key,{template:n.kind==='tool'?templateIdForTool('native:write'):n.kind,values:n.kind==='tool'?{inputs:n.config.inputs}:n.config}])),chainsByKey:chains,linksByKey:links,coverage:{R1:['write','review']}}
    const result=compiler.submit({submission});expect(result.ok).toBe(false)
    if(!result.ok){expect(result.feedback.issues).toContainEqual(expect.objectContaining({code:'REVIEW_BEFORE_EFFECT',path:mode==='compact-repair'?'/nodesByKey/write/config/inputs/file_path':'/formsByKey/write/values/inputs/file_path'}))}
  })
  it('serves review guidance only with human semantics, without mutating frozen descriptions',()=>{
    expect(queryWorkflowSemantics({kinds:['human']}).nodes![0]).toHaveProperty('reviewBeforeEffect')
    expect(queryWorkflowSemantics({kinds:['template']}).nodes![0]).not.toHaveProperty('reviewBeforeEffect')
  })
})

const contexts:{runtime:WorkflowRuntime;directory:string}[]=[]
afterEach(async()=>{for(const {runtime,directory} of contexts.splice(0)){await runtime.close();rmSync(directory,{recursive:true,force:true})}})
async function runtimeFixture(legacy=false,absent=false){
  const directory=mkdtempSync(join(tmpdir(),'t20-review-')),storage=new WorkflowStorage(directory),{f}=legacy?oldGreeting():fixture()
  const fs=new Map<string,{content:string;version:number}>(absent?[]:[['t05-greeting.json',{content:'original\r\n',version:1}]]),writes:string[]=[],calls:{id:string;path:string}[]=[]
  // Mirror the SDK gate: present -> replaceIfVersion, unseen/absent -> createIfAbsent.
  // The legacy fixture starts with a same-owner observation from an earlier call.
  const observed=new Map<string,number|undefined>(legacy?[['t05-greeting.json',1]]:[])
  const catalog=new ToolCatalog({directory,workflows:id=>storage.workflows(id),nativeTools:()=>[],executeNative:async(id,args)=>{
    id='native:'+id;const path=String(args.file_path??args.pattern);calls.push({id,path})
    if(id==='native:read'){const file=fs.get(path);if(!file){observed.set(path,undefined);throw Error('FS_NOT_FOUND '+path)}observed.set(path,file.version);return {value:{path,offset:1,lines:[{number:1,text:file.content.replace(/\r/g,'').slice(0,2000)}],totalLines:1}}}
    if(id==='native:glob')return {value:{root:'.',paths:fs.has(path)?[path]:[]}}
    if(id==='native:write'){
      const file=fs.get(path),prior=observed.get(path)
      if(prior!==undefined?file?.version!==prior:!!file)throw Error(prior!==undefined?'FS_STALE_VERSION: conflict; target changed, no overwrite':'FS_ALREADY_EXISTS: conflict; createIfAbsent refused')
      const version=(file?.version??0)+1;writes.push(path);fs.set(path,{content:String(args.content),version});observed.set(path,version);return {text:'written'}
    }
    throw Error('Unexpected tool '+id)
  },runWorkflow:async()=>{throw Error('No subworkflow')},http:async()=>{throw Error('No network')}})
  const runtime=new WorkflowRuntime(storage,{generate:async()=>{throw Error('No models')}},createExecutionAdapters({catalog,workspaceRoot:()=>directory}))
  contexts.push({runtime,directory});const flow=storage.save(parseWorkflow(f),0),run=await runtime.settle(runtime.start(flow.id,{}).id)
  const answer=async(action:string,note='',content?:string)=>runtime.settle(runtime.answer(run.id,{__action:action,note,...(content===undefined?{}:{content})}).id)
  return {runtime,storage,flow,run,answer,fs,writes,calls,observed,draft:REVIEW_DRAFT_PREFIX.replace('{{sys.workflow_run_id}}',run.id)+'t05-greeting.json'}
}
describe('T20 production runtime with SDK version guards and scripted form answers',()=>{
  it('reject leaves target bytes/version unchanged and keeps a draft',async()=>{
    const v=await runtimeFixture();expect(v.run.status).toBe('waiting');const before={...v.fs.get('t05-greeting.json')!}
    expect(v.run.missingFields?.find(f=>f.name==='content')?.defaultValue).toBe('Hello Ada')
    const next=await v.answer('reject',' revised','edited base');expect(next.status).toBe('waiting')
    expect(v.fs.get('t05-greeting.json')).toEqual(before);expect(v.fs.has(v.draft)).toBe(true);expect(v.writes.filter(p=>p==='t05-greeting.json')).toHaveLength(0)
    expect(next.missingFields?.find(f=>f.name==='content')?.defaultValue).toBe('Hello Adaedited base revised')
    expect(v.calls.filter(c=>c.path==='t05-greeting.json'&&c.id==='native:read')).toHaveLength(1)
  })
  it('commits edited form content exactly, including CRLF, trailing newline and a line longer than 2000 chars',async()=>{
    const v=await runtimeFixture();await v.answer('reject',' revised','base')
    v.fs.set(v.draft,{content:'file edit must not be committed',version:99})
    const content='表单正文\r\n'+ 'x'.repeat(5001)+'\r\nlast line\n'
    const done=await v.answer('approve','',content);expect(done.status).toBe('success');expect(done.outputs.result).toBe('approved')
    expect(v.fs.get('t05-greeting.json')!.content).toBe(content);expect(v.writes.filter(p=>p==='t05-greeting.json')).toHaveLength(1)
    expect(v.fs.get(v.draft)!.content).toBe('file edit must not be committed')
    expect(v.calls.filter(c=>c.path==='t05-greeting.json').map(c=>c.id)).toEqual(['native:glob','native:read','native:write'])
  })
  it('allows an explicitly approved empty form value without falling back to the draft',async()=>{
    const v=await runtimeFixture(),done=await v.answer('approve','','')
    expect(done.status).toBe('success');expect(v.fs.get('t05-greeting.json')!.content).toBe('')
  })
  it.each(['different-content','same-content-new-version','deleted'])('external change %s fails the commit without overwriting',async change=>{
    const v=await runtimeFixture(),content=change==='different-content'?'external':'original\r\n'
    if(change==='deleted')v.fs.delete('t05-greeting.json');else v.fs.set('t05-greeting.json',{content,version:22})
    const done=await v.answer('approve');expect(done.status).toBe('failed');expect(done.error).toContain('FS_STALE_VERSION')
    expect(v.fs.get('t05-greeting.json')).toEqual(change==='deleted'?undefined:{content,version:22});expect(v.writes.filter(p=>p==='t05-greeting.json')).toHaveLength(0)
    expect(done.executions.find(e=>e.nodeId==='commit')?.status).toBe('failed')
  })
  it('three rejections end at not-approved and keep target unchanged',async()=>{
    const v=await runtimeFixture(),before={...v.fs.get('t05-greeting.json')!};await v.answer('reject',' one');await v.answer('reject',' two');const done=await v.answer('reject',' three')
    expect(done.status).toBe('success');expect(done.outputs.result).toBe('not-approved');expect(v.fs.get('t05-greeting.json')).toEqual(before)
    expect(v.writes.filter(p=>p==='t05-greeting.json')).toHaveLength(0);expect(v.writes.filter(p=>p===v.draft)).toHaveLength(3)
  })
  it('creates an absent target only after approval without an unconditional read',async()=>{
    const v=await runtimeFixture(false,true);expect(v.run.status).toBe('waiting');expect(v.fs.has('t05-greeting.json')).toBe(false)
    const done=await v.answer('approve','','first\r\n');expect(done.status).toBe('success');expect(v.fs.get('t05-greeting.json')!.content).toBe('first\r\n')
    expect(v.calls.filter(c=>c.path==='t05-greeting.json').map(c=>c.id)).toEqual(['native:glob','native:write'])
  })
  it('refuses first create when someone creates the target during review',async()=>{
    const v=await runtimeFixture(false,true);v.fs.set('t05-greeting.json',{content:'external first create',version:1})
    const done=await v.answer('approve');expect(done.status).toBe('failed');expect(done.error).toContain('FS_ALREADY_EXISTS');expect(v.fs.get('t05-greeting.json')!.content).toBe('external first create')
  })
  it('lost in-memory observations refuse an existing target, but still allow an absent first create',async()=>{
    const v=await runtimeFixture();v.observed.clear();const done=await v.answer('approve');expect(done.status).toBe('failed');expect(done.error).toContain('FS_ALREADY_EXISTS');expect(v.fs.get('t05-greeting.json')!.content).toBe('original\r\n')
    const absent=await runtimeFixture(false,true);absent.observed.clear();expect((await absent.answer('approve')).status).toBe('success')
  })
  it('loads and executes the existing T05 shape without rewriting or applying planning rules',async()=>{
    const v=await runtimeFixture(true);expect(v.storage.get(v.flow.id).nodes).toEqual(v.flow.nodes)
    expect(v.run.status).toBe('waiting');expect(v.writes).toEqual(['t05-greeting.json'])
    const done=await v.answer('reject');expect(done.status).toBe('success');expect(v.writes).toEqual(['t05-greeting.json']);expect(v.storage.get(v.flow.id).nodes).toEqual(v.flow.nodes)
  })
})
