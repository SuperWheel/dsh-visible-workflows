import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tools,attest } from './fixtures/t18-tools.ts'
import { templateContext, filling } from './fixtures/planning-compiler/template.ts'
import { EXACT_TARGET_EXISTS_CODE,builtinToolOperation,operationDigest,registeredToolOperation,validateToolOperation,unknownToolOperation } from '../src/shared/tool-operation-contract.ts'
import { BUILTIN_TOOLS } from '../src/shared/builtin-tools.ts'
import { createTemplateBinding,validateTemplateBinding } from '../src/shared/planning-node-templates.ts'
import { planningCandidateIssues } from '../src/shared/planning-projection.ts'
import { planningToolPreconditionIssues } from '../src/shared/planning-tool-preconditions.ts'
import type { WorkflowNode } from '../src/shared/types.ts'
import { ToolCatalog } from '../src/host/tool-catalog.ts'
import { WorkflowPlanningService, type PlanningCaller } from '../src/host/planning/service.ts'
import { ModelAdmission } from '../src/host/run-usage.ts'
import type { PlanningReceipt } from '../src/host/planning/receipt.ts'

function fixture(){
  const c=templateContext();c.tools=tools()
  const n=(id:string,kind:WorkflowNode['kind'],config:WorkflowNode['config']):WorkflowNode=>({id,kind,title:id,number:id,x:0,y:0,fixed:false,config})
  c.workflow.nodes=[n('start','input',{fields:[]}),n('glob','tool',{toolId:'native:glob',inputs:{pattern:'out.json'}}),
    n('exists','code',{language:'javascript',code:EXACT_TARGET_EXISTS_CODE,inputs:{listing:'{{glob.value}}',target:'out.json'},outputSchema:[{name:'exists',type:'boolean',required:true}]}),
    n('branch','if',{variable:'exists.exists',operator:'equals',value:'true'}),n('read','tool',{toolId:'native:read',inputs:{file_path:'out.json'}}),
    n('write','tool',{toolId:'native:write',inputs:{file_path:'out.json',content:'Hello'}}),n('end','output',{text:'done',outputName:'result'})]
  c.workflow.edges=[['start','glob'],['glob','exists'],['exists','branch'],['branch','read','true'],['branch','write','false'],['read','write'],['write','end']].map(([source,target,port],i)=>({id:'e'+i,source,target,...(port?{port}:{})}))
  return c
}
const issues=(c:ReturnType<typeof fixture>)=>planningToolPreconditionIssues(c.workflow,c)
const node=(c:ReturnType<typeof fixture>,id:string)=>c.workflow.nodes.find(n=>n.id===id)!

describe('T18 versioned operation contracts and static prerequisites',()=>{
  it('freezes independent operation and output contracts without changing workflow config',()=>{
    const c=fixture(),binding=createTemplateBinding(c.tools)
    expect(validateTemplateBinding(binding)).toEqual(binding)
    const write=binding.templates.find(t=>t.fixed.toolId==='native:write')!
    expect(write.operations).toEqual(c.tools[1]!.operationContract)
    expect(write.outputs).not.toHaveProperty('operations')
    expect(write.rules.join(' ')).toContain(EXACT_TARGET_EXISTS_CODE)
    expect(node(c,'write').config).toEqual({toolId:'native:write',inputs:{file_path:'out.json',content:'Hello'}})
  })
  it('keeps missing source, same-name tools, unavailable provenance and stale schema attestations unknown',()=>{
    const def={name:'write',description:'Create or fully replace',parameters:{type:'object'},output:{schema:{type:'object'}}}
    expect(registeredToolOperation('native:write',def).status).toBe('unknown')
    const declared=attest('write',def).operationContract!
    if(declared.status!=='known')throw Error('fixture')
    expect(registeredToolOperation('native:write',{...def,operationContract:{...declared.declaration,sourceId:'native-tool:other'}}).status).toBe('unknown')
    expect(registeredToolOperation('native:write',{...def,parameters:{type:'string'},operationContract:declared.declaration}).status).toBe('unknown')
    expect(registeredToolOperation('swagger:write',{...def,operationContract:declared.declaration}).status).toBe('unknown')
    expect(registeredToolOperation('native:write',{...def,operationContract:{...declared.declaration,version:''}}).status).toBe('unknown')
    const c=fixture();c.tools.forEach(t=>t.operationContract=unknownToolOperation())
    expect(createTemplateBinding(c.tools).templates.filter(t=>t.kind==='tool').every(t=>t.operations?.status==='unknown')).toBe(true)
  })
  it('rejects operation digest tampering independently of outputs',()=>{
    const c=fixture(),op=structuredClone(c.tools[1]!.operationContract!)
    if(op.status!=='known')throw Error('fixture')
    op.declaration.version='tampered'
    expect(()=>validateToolOperation(op)).toThrow('摘要')
    const before=createTemplateBinding(c.tools).catalogDigest
    op.digest=operationDigest(op.declaration);c.tools[1]!.operationContract=op
    expect(createTemplateBinding(c.tools).catalogDigest).not.toBe(before)
  })
  it('rejects a correctly hashed contract copied from another tool identity',()=>{
    const c=fixture();c.tools[0]!.operationContract=c.tools[1]!.operationContract
    expect(()=>createTemplateBinding(c.tools)).toThrow('来源不属于')
    expect(()=>issues(c)).toThrow('来源不属于')
  })
  it.each(['builtin:json.parse','swagger:fixture:get:%2Fwrite','workflow:write','mcp:write','unregistered:write','native:'])('rejects a native contract copied to unregistered identity %s in all consumers',id=>{
    const c=fixture(),copied={...c.tools[1]!,id},dir=mkdtempSync(join(tmpdir(),'t18-ownership-'))
    try{
      c.tools=[copied]
      expect(()=>validateToolOperation(copied.operationContract,id)).toThrow('来源不属于')
      expect(()=>createTemplateBinding(c.tools)).toThrow('来源不属于')
      expect(()=>issues(c)).toThrow('来源不属于')
      const catalog=new ToolCatalog({directory:dir,workflows:()=>[],nativeTools:()=>c.tools,executeNative:async()=>({}),runWorkflow:async()=>({}),http:async()=>({})})
      expect(()=>catalog.list('workspace','session')).toThrow('来源不属于')
    }finally{rmSync(dir,{recursive:true,force:true})}
  })
  it('rejects known contracts without a tool identity and forged non-native source mappings',()=>{
    const op=structuredClone(tools()[1]!.operationContract!)
    expect(()=>validateToolOperation(op)).toThrow('来源不属于')
    if(op.status!=='known')throw Error('fixture')
    op.declaration.sourceId='builtin-tool:json.parse';op.digest=operationDigest(op.declaration)
    expect(()=>validateToolOperation(op,'builtin:json.parse')).toThrow('来源不属于')
    expect(validateToolOperation(unknownToolOperation(),'builtin:json.parse').status).toBe('unknown')
  })
  it('knows builtin contracts from the plugin itself and keeps them on their own tool (T18 2026-10-27)',()=>{
    const parse=BUILTIN_TOOLS.find(tool=>tool.id==='builtin:json.parse')!,now=BUILTIN_TOOLS.find(tool=>tool.id==='builtin:time.now')!
    const contract=builtinToolOperation(parse)
    expect(validateToolOperation(contract,'builtin:json.parse')).toEqual(contract)
    expect(contract.status==='known'&&contract.declaration.reuseLimits).toEqual(['相同输入得到相同输出，可重复执行'])
    const clock=builtinToolOperation(now);expect(clock.status==='known'&&clock.declaration.reuseLimits[0]).toContain('取决于调用时刻')
    for(const id of ['builtin:json.stringify','native:json.parse','swagger:json.parse'])expect(()=>validateToolOperation(contract,id)).toThrow('来源不属于')
    const forged=structuredClone(contract);if(forged.status!=='known')throw Error('fixture')
    forged.declaration.sourceId='native-tool:json.parse';forged.digest=operationDigest(forged.declaration)
    expect(()=>validateToolOperation(forged,'native:json.parse')).toThrow('来源不属于')
  })
  it('reports unsupported write owner scope instead of treating it as a safe action',()=>{
    const c=fixture(),op=c.tools[1]!.operationContract!
    if(op.status==='known'){op.declaration.scope.owner='call';op.digest=operationDigest(op.declaration)}
    expect(issues(c)).toContainEqual(expect.objectContaining({code:'TOOL_PRECONDITION_UNSUPPORTED_SCOPE',nodeId:'write',path:'config.toolId'}))
  })
  it('accepts precise presence/read and absence/create paths joining once',()=>{
    const c=fixture();expect(issues(c)).toEqual([])
    expect(planningCandidateIssues(c.workflow,c)).toEqual([])
  })
  it('accepts overwrite-only graphs with a dominating exact-target read',()=>{
    const c=fixture();c.workflow.nodes=c.workflow.nodes.filter(n=>['start','read','write','end'].includes(n.id));c.workflow.edges=[['start','read'],['read','write'],['write','end']].map(([source,target],i)=>({id:'e'+i,source,target}))
    expect(issues(c)).toEqual([])
  })
  it.each(['never','reuse'] as const)('rejects document write tools with missing prerequisites and cache=%s',cache=>{
    const c=fixture(),write=node(c,'write');write.kind='document';write.config={...write.config,documentMode:'tool',source:'source.txt',cache}
    c.workflow.nodes=c.workflow.nodes.filter(n=>['start','write','end'].includes(n.id));c.workflow.edges=[{id:'a',source:'start',target:'write'},{id:'b',source:'write',target:'end'}]
    expect(issues(c)).toContainEqual(expect.objectContaining({code:'TOOL_DOCUMENT_OPERATION_UNSUPPORTED',nodeId:'write',path:'config.toolId'}))
    expect(planningCandidateIssues(c.workflow,c).map(i=>i.code)).toContain('TOOL_DOCUMENT_OPERATION_UNSUPPORTED')
    if(cache==='reuse')expect(issues(c)).toContainEqual(expect.objectContaining({code:'TOOL_OBSERVATION_REUSE_UNSAFE',nodeId:'write',path:'config.cache'}))
  })
  it('does not accept document attachment conversion as an exact read observation',()=>{
    const c=fixture(),read=node(c,'read');read.kind='document';read.config={...read.config,documentMode:'tool',documentSourceKey:'file_path',source:'sub/out.json'}
    expect(issues(c)).toContainEqual(expect.objectContaining({code:'TOOL_DOCUMENT_OPERATION_UNSUPPORTED',nodeId:'read'}))
    expect(issues(c)).toContainEqual(expect.objectContaining({code:'TOOL_PRECONDITION_UNPROVEN',nodeId:'write'}))
  })
  it.each([['{{input.path}}',true],['{{path}}',false],['{{vars.path}}',false]])('only stable dynamic path %s can establish a match', (path,accepted)=>{
    const c=fixture();node(c,'exists').config.inputs!.target=path;node(c,'read').config.inputs!.file_path=path;node(c,'write').config.inputs!.file_path=path
    c.workflow.nodes=c.workflow.nodes.filter(n=>['start','read','write','end'].includes(n.id));c.workflow.edges=[['start','read'],['read','write'],['write','end']].map(([source,target],i)=>({id:'e'+i,source,target}))
    expect(issues(c).length===0).toBe(accepted)
  })
  it.each(['missing-read','wrong-target','post-write-read','parallel-read','wrong-source','other-owner'])("rejects %s with a precise write path",kind=>{
    const c=fixture()
    if(kind==='missing-read')c.workflow.edges=c.workflow.edges.filter(e=>e.source!=='read'&&e.target!=='read').concat({id:'bypass',source:'branch',target:'write',port:'true'})
    if(kind==='wrong-target')node(c,'read').config.inputs!.file_path='sub/out.json'
    if(kind==='post-write-read')c.workflow.edges=c.workflow.edges.filter(e=>e.source!=='read'&&e.target!=='read').concat({id:'bypass',source:'branch',target:'write',port:'true'},{id:'late',source:'write',target:'read'})
    if(kind==='parallel-read')c.workflow.edges=c.workflow.edges.filter(e=>e.source!=='read').concat({id:'bypass',source:'branch',target:'write',port:'true'})
    if(kind==='wrong-source')c.tools[0]!.operationContract=unknownToolOperation()
    if(kind==='other-owner'){const op=c.tools[0]!.operationContract!;if(op.status==='known'){op.declaration.scope.owner='call';op.digest=operationDigest(op.declaration)}}
    expect(issues(c)).toContainEqual(expect.objectContaining({code:'TOOL_PRECONDITION_UNPROVEN',nodeId:'write',path:'config.inputs.file_path',message:expect.stringContaining('out.json')}))
  })
  it('does not turn a glob or successful creation sample into read proof',()=>{
    const c=fixture();node(c,'read').config.toolId='native:glob'
    expect(issues(c).map(i=>i.code)).toContain('TOOL_PRECONDITION_UNPROVEN')
  })
  it('reports argument fields and action prerequisites as separate diagnostics',()=>{
    const c=fixture();node(c,'write').config.inputs!.content=42;node(c,'read').config.inputs!.file_path='other.json'
    const diagnostics=planningCandidateIssues(c.workflow,c)
    expect(diagnostics).toContainEqual(expect.objectContaining({code:'INVALID_TOOL_ARGUMENTS',nodeId:'write',path:'config.inputs'}))
    expect(diagnostics).toContainEqual(expect.objectContaining({code:'TOOL_PRECONDITION_UNPROVEN',nodeId:'write',path:'config.inputs.file_path'}))
  })
  it('refuses historical cached reads as current-owner observation proof',()=>{
    const c=fixture();node(c,'read').config.cache='reuse'
    expect(issues(c)).toContainEqual(expect.objectContaining({code:'TOOL_OBSERVATION_REUSE_UNSAFE',nodeId:'read',path:'config.cache'}))
    expect(issues(c).map(i=>i.code)).toContain('TOOL_PRECONDITION_UNPROVEN')
  })
  it('does not mistake unrelated array length code for a target existence test',()=>{
    const c=fixture();node(c,'start').config.fields=[{name:'paths',label:'paths',type:'json',required:true}]
    const unused={...node(c,'exists'),id:'check',config:{language:'javascript' as const,code:'function main(inputs) { return {nonempty:inputs.paths.length > 0}; }',inputs:{paths:'{{input.paths}}'}}}
    c.workflow.nodes.push(unused);c.workflow.edges.push({id:'extra-a',source:'start',target:'check'},{id:'extra-b',source:'check',target:'write'})
    expect(issues(c).some(i=>i.code==='IMPRECISE_TARGET_EXISTENCE')).toBe(false)
  })
  it.each(['direct','code'])('diagnoses imprecise %s existence checks at the offending field',kind=>{
    const c=fixture()
    if(kind==='direct')node(c,'branch').config={variable:'glob.value.paths',operator:'not_empty'}
    else node(c,'exists').config.code='function main(inputs) { return {exists: inputs.listing.paths.length > 0}; }'
    expect(issues(c)).toContainEqual(expect.objectContaining({code:'IMPRECISE_TARGET_EXISTENCE',nodeId:kind==='direct'?'branch':'exists',path:kind==='direct'?'config.variable':'config.code'}))
    expect(issues(c).map(i=>i.code)).toContain('TOOL_PRECONDITION_UNPROVEN')
  })
  it.each(['direct','code'])('accepts an imprecise %s filter when an exact read covers every write route',kind=>{
    const c=fixture()
    if(kind==='direct')node(c,'branch').config={variable:'glob.value.paths',operator:'not_empty'}
    else node(c,'exists').config.code='function main(inputs) { return {exists: inputs.listing.paths.length > 0}; }'
    c.workflow.edges=c.workflow.edges.filter(e=>!(e.source==='branch'&&e.target==='write'))
    // glob -> if(paths not_empty) -> exact read -> write; the false route stops.
    expect(issues(c)).toEqual([])
    expect(planningCandidateIssues(c.workflow,c)).toEqual([])
  })
  it.each(['*.txt','*.json','sub/out.json','{{input.path}}','out[0].json','../out.json','/out.json'])('rejects a listing query %s that does not prove exact coverage of out.json',pattern=>{
    const c=fixture();node(c,'glob').config.inputs!.pattern=pattern
    expect(issues(c)).toContainEqual(expect.objectContaining({code:'TOOL_PRECONDITION_UNPROVEN',nodeId:'write'}))
  })
  it.each(['@(out.json)','+(out.json)','out[0].json','{{input.path}}'])('rejects non-literal probe %s even when it equals the target text',path=>{
    const c=fixture();node(c,'glob').config.inputs!.pattern=path;node(c,'exists').config.inputs!.target=path;node(c,'read').config.inputs!.file_path=path;node(c,'write').config.inputs!.file_path=path
    expect(issues(c)).toContainEqual(expect.objectContaining({code:'TOOL_PRECONDITION_UNPROVEN',nodeId:'write'}))
  })
  it('accepts a registered exact probe of the target with root-relative normalization',()=>{
    const c=fixture();node(c,'glob').config.inputs!.pattern='./out.json'
    expect(issues(c)).toEqual([])
  })
  it('does not infer exhaustive probe coverage from matching canonical output field names',()=>{
    const c=fixture(),op=c.tools[2]!.operationContract!
    if(op.status!=='known'||op.declaration.action.kind!=='file-list')throw Error('fixture')
    delete op.declaration.action.coverage;op.digest=operationDigest(op.declaration)
    expect(issues(c)).toContainEqual(expect.objectContaining({code:'TOOL_PRECONDITION_UNPROVEN',nodeId:'write'}))
  })
  it('does not use a cached exact probe to prove current absence',()=>{
    const c=fixture();node(c,'glob').config.cache='reuse'
    expect(issues(c).map(i=>i.code)).toEqual(expect.arrayContaining(['TOOL_OBSERVATION_REUSE_UNSAFE','TOOL_PRECONDITION_UNPROVEN']))
  })
  it.each(['different-target','untrusted-selector','wrong-root-contract','selector-not-upstream','listing-not-upstream'])('refuses absence proof with %s',kind=>{
    const c=fixture()
    if(kind==='different-target')node(c,'exists').config.inputs!.target='sub/out.json'
    if(kind==='untrusted-selector')node(c,'exists').config.code=EXACT_TARGET_EXISTS_CODE+'\n// modified'
    if(kind==='wrong-root-contract'){const op=c.tools[2]!.operationContract!;if(op.status==='known'&&op.declaration.action.kind==='file-list'){op.declaration.action.rootField='value.directory';op.digest=operationDigest(op.declaration)}}
    if(kind==='selector-not-upstream')c.workflow.edges=c.workflow.edges.filter(e=>e.target!=='branch').concat({id:'shortcut',source:'start',target:'branch'})
    if(kind==='listing-not-upstream')c.workflow.edges=c.workflow.edges.filter(e=>e.target!=='exists').concat({id:'shortcut',source:'start',target:'exists'})
    expect(issues(c).map(i=>i.code)).toContain('TOOL_PRECONDITION_UNPROVEN')
  })
  it('freezes registry operation versions into runtime constraints without touching Swagger conversion',()=>{
    const c=fixture(),dir=mkdtempSync(join(tmpdir(),'t18-catalog-'))
    try{
      const catalog=new ToolCatalog({directory:dir,workflows:()=>[],nativeTools:()=>c.tools,executeNative:async()=>({}),runWorkflow:async()=>({}),http:async()=>({})})
      expect(catalog.list('workspace','session').every(tool=>tool.operationContract?.status)).toBe(true)
      const before=catalog.constraints('workspace',['native:write'],'session')['native:write']
      const op=c.tools[1]!.operationContract!;if(op.status==='known'){op.declaration.version='new-version';op.digest=operationDigest(op.declaration)}
      expect(catalog.constraints('workspace',['native:write'],'session')['native:write']).not.toBe(before)
    }finally{rmSync(dir,{recursive:true,force:true})}
  })
  it('persists operation contracts in the planning task and reads identical versions after restart',async()=>{
    const c=templateContext();c.tools=tools();const dir=mkdtempSync(join(tmpdir(),'t18-task-'))
    const caller={parent:{id:'session'},sessionId:'session',workspaceId:'workspace',signal:new AbortController().signal} as PlanningCaller
    const receipts=new Map<string,PlanningReceipt>()
    const options:ConstructorParameters<typeof WorkflowPlanningService>[0]={directory:dir,compilerMode:'template-fill',admission:new ModelAdmission(1,1),context:async()=>c,authorize:()=>{},driver:{generate:async input=>{const value=input.compiler!.submit(filling());if(!value.ok)throw Error(JSON.stringify(value.feedback));return {output:value.value,steps:0}}},readiness:async flow=>({workflowId:flow.id,revision:0,canRun:true,issues:[]}),publish:async(flow,_task,_caller,commit)=>{receipts.set(commit.key,{...commit,workflowId:flow.id,revision:1,kind:'created'})},receipt:key=>receipts.get(key)}
    let service=new WorkflowPlanningService(options)
    try{
      const ready=await service.start({requestId:'t18-freeze',operation:'create',instruction:'问候'},caller)
      expect(ready.state,JSON.stringify(ready.diagnostics)).toBe('published')
      expect(ready.context!.tools.map(t=>t.operationContract)).toEqual(c.tools.map(t=>t.operationContract))
      await service.close();service=new WorkflowPlanningService(options)
      expect(service.get(ready.id,caller).context!.tools).toEqual(ready.context!.tools)
    }finally{await service.close();rmSync(dir,{recursive:true,force:true})}
  })
})
