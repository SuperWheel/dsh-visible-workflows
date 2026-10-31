import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { WorkflowPlanningService, type PlanningCaller, type PlanningTask } from '../src/host/planning/service.ts'
import type { PlanningAgentInput } from '../src/host/planning/agent.ts'
import type { PlanningReceipt } from '../src/host/planning/receipt.ts'
import { ModelAdmission } from '../src/host/run-usage.ts'
import { assertWorkflowReady, inspectWorkflowReadiness } from '../src/host/workflow-readiness.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'
import { createTemplateBinding } from '../src/shared/planning-node-templates.ts'
import { planningCompilerSelectionSchema, selectPlanningCompiler } from '../src/host/planning/compiler-selection.ts'

const directories:string[]=[],services:WorkflowPlanningService[]=[]
afterEach(async()=>{await Promise.all(services.splice(0).map(service=>service.close()));for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true})})
function reviseContext(){
  const context=templateContext();context.operation='revise';context.workflow.revision=1
  context.workflow.nodes.splice(1,0,{id:'retired',kind:'tool',title:'旧工具',number:'3',x:100,y:0,fixed:false,config:{toolId:'native:retired',inputs:{path:'kept'},cache:'never'}})
  context.workflow.edges=[{id:'a',source:'host-start',target:'retired'},{id:'b',source:'retired',target:'host-end'}]
  context.workflow.nodes[2]!.config.text='保留结果';context.targetNodeIds=['retired']
  return context
}
const titleEdit={submission:{mode:'edit',updates:{n2:{title:'仅修改标题'}},coverage:{R1:['n2']}}}
const question={submission:{mode:'needs-input',questions:[{id:'format',question:'请选择标题',options:[]}],summary:'需澄清'}}
const unavailableTool={id:'native:retired',name:'旧工具',description:'离线目录',providerId:'p',providerName:'p',category:'plugin' as const,available:false,inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}
function submit(input:PlanningAgentInput,wire:unknown){
  input.beforeStep?.(100,undefined);input.beforeSubmission?.()
  const result=input.compiler!.submit(wire);if(!result.ok)throw Error(JSON.stringify(result.feedback))
  return {output:result.value,steps:1,usage:{totalTokens:7}}
}
function fixture(context=reviseContext()){
  const directory=mkdtempSync(join(tmpdir(),'planning-selection-'));directories.push(directory)
  const caller={parent:{id:'session'},sessionId:'session',workspaceId:'workspace',signal:new AbortController().signal} as PlanningCaller
  const receipts=new Map<string,PlanningReceipt>()
  const generate=vi.fn(async(input:PlanningAgentInput)=>submit(input,titleEdit))
  const options:ConstructorParameters<typeof WorkflowPlanningService>[0]={directory,compilerMode:'template-fill',admission:new ModelAdmission(1,1),driver:{generate},context:vi.fn(async()=>context),authorize:vi.fn(()=>{}),
    readiness:vi.fn(flow=>inspectWorkflowReadiness(flow,{catalog:{models:[],tools:context.tools,workflows:[],presets:[]},workspaceRoot:directory})),
    publish:vi.fn(async(flow,task,_caller,commit)=>{receipts.set(commit.key,{...commit,workflowId:flow.id,revision:flow.revision,kind:'proposed',proposalId:'proposal'})}),receipt:key=>receipts.get(key)}
  const open=()=>{const service=new WorkflowPlanningService(options);services.push(service);return service}
  const request={requestId:'mode-choice',operation:'revise',instruction:'仅修改旧工具节点的标题',targetWorkflowId:context.workflow.id,expectedRevision:1,targetNodeIds:context.targetNodeIds}
  const file=join(directory,'planning','tasks.json')
  const stored=()=>JSON.parse(readFileSync(file,'utf8')) as {tasks:PlanningTask[]}
  const replace=(change:(task:any)=>void)=>{const raw=stored();change(raw.tasks[0]!);writeFileSync(file,JSON.stringify(raw))}
  return {context,caller,options,generate,open,request,stored,replace}
}

describe('compiler applicability before task freeze (offline)',()=>{
  it.each([undefined,'legacy'] as const)('runs new requests configured as %s through compact repair and records why',async mode=>{
    const f=fixture();f.options.compilerMode=mode
    const service=f.open(),task=await service.start(f.request,f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('published');expect(task.compilerMode).toBe('compact-repair')
    expect(task.compilerSelection).toEqual({protocolVersion:1,state:'frozen',requestedMode:'legacy',effectiveMode:'compact-repair',reason:'legacy-retired',nodeIds:[]})
    expect(f.generate.mock.calls[0]![0].compiler).toBeInstanceOf(WorkflowAuthoringCompiler)
    f.options.compilerMode='template-fill'
    const restored=f.open().get(task.id,f.caller)
    expect(restored.compilerSelection).toEqual(task.compilerSelection);expect(restored.receipt).toEqual(task.receipt);expect(f.generate).toHaveBeenCalledOnce()
  })
  it.each(['authoring','awaiting_input','ready'] as const)('fails a frozen legacy %s task during restore without generation or publication',async state=>{
    const f=fixture(),service=f.open();f.generate.mockImplementationOnce(async input=>submit(input,state==='ready'?titleEdit:question))
    const task=await service.start(f.request,f.caller);vi.mocked(f.options.publish).mockClear()
    f.replace(row=>{delete row.compilerMode;delete row.compilerSelection;delete row.compilerDraft;delete row.compilerMetrics;row.state=state;delete row.commit;delete row.receipt;row.spentTokens=37;row.unknownTokens=1000;row.reservedTokens=500})
    const restored=f.open().get(task.id,f.caller)
    expect(restored.state).toBe('failed');expect(restored.diagnostics.at(-1)).toEqual({code:'PLANNING_LEGACY_RETIRED',message:'旧生成协议已退役，请重新发起该请求'})
    expect(restored).toMatchObject({spentTokens:37,unknownTokens:1000,reservedTokens:500,childAttempts:1,steps:1})
    expect(restored.context).toEqual(task.context);expect(restored.requestDigest).toBe(task.requestDigest)
    expect(f.generate).toHaveBeenCalledOnce();expect(f.options.publish).not.toHaveBeenCalled()
    expect(f.open().get(task.id,f.caller)).toEqual(restored)
  })
  it('fails a live legacy question on answer before accepting answers or calling a child',async()=>{
    const f=fixture(),service=f.open();f.generate.mockImplementationOnce(async input=>submit(input,question))
    const waiting=await service.start(f.request,f.caller),task=(service as any).tasks.get(waiting.id)
    delete task.compilerMode;delete task.compilerSelection;delete task.compilerDraft;delete task.compilerMetrics
    const failed=await service.answer(waiting.id,waiting.revision,[{questionId:'format',answer:'标题'}],f.caller)
    expect(failed.state).toBe('failed');expect(failed.diagnostics.at(-1)!.code).toBe('PLANNING_LEGACY_RETIRED');expect(failed.answers).toEqual([])
    expect(failed.spentTokens).toBe(waiting.spentTokens);expect(failed.steps).toBe(waiting.steps);expect(f.generate).toHaveBeenCalledOnce();expect(f.options.publish).not.toHaveBeenCalled()
  })
  it('keeps published legacy history readable and verifies its original receipt and usage without rewriting it',async()=>{
    const f=fixture(),service=f.open(),task=await service.start(f.request,f.caller)
    f.replace(row=>{delete row.compilerMode;delete row.compilerSelection;delete row.compilerDraft;delete row.compilerMetrics;row.spentTokens=37;row.unknownTokens=1000;row.reservedTokens=500})
    const file=join(f.options.directory,'planning','tasks.json'),before=readFileSync(file,'utf8'),restored=f.open().get(task.id,f.caller)
    expect(restored.state).toBe('published');expect(restored.receipt).toEqual(task.receipt);expect(restored.compilerMode).toBeUndefined()
    expect(restored).toMatchObject({spentTokens:37,unknownTokens:1000,reservedTokens:500});expect(readFileSync(file,'utf8')).toBe(before)
    expect(f.generate).toHaveBeenCalledOnce();expect(f.options.publish).toHaveBeenCalledOnce()
    expect(planningCompilerSelectionSchema.parse({protocolVersion:1,state:'frozen',requestedMode:'legacy',effectiveMode:'legacy',reason:'configured',nodeIds:[]})).toMatchObject({effectiveMode:'legacy'})
    expect(planningCompilerSelectionSchema.parse({protocolVersion:1,state:'frozen',requestedMode:'legacy',effectiveMode:'compact-repair',reason:'typed-partial-handoff',nodeIds:[]})).toMatchObject({reason:'typed-partial-handoff'})
  })
  it('demonstrates the unavailable baseline tool gap without losing its config or clearing readiness',async()=>{
    const context=reviseContext(),template=new TemplateFillingCompiler(context).submit(titleEdit)
    expect(template.ok).toBe(false)
    if(template.ok)throw Error('Expected unavailable template')
    expect(template.feedback.issues[0]!.code).toBe('UNKNOWN_TEMPLATE')
    const compact=new WorkflowAuthoringCompiler(context).submit(titleEdit)
    if(!compact.ok)throw Error(JSON.stringify(compact.feedback))
    const node=compact.value.candidate!.nodes.find(node=>node.id==='retired')!
    expect(node).toEqual({...context.workflow.nodes[1],title:'仅修改标题'})
    const readiness=await inspectWorkflowReadiness(compact.value.candidate,{catalog:{models:[],tools:[],workflows:[],presets:[]},workspaceRoot:tmpdir()})
    expect(readiness.canRun).toBe(false);expect(readiness.issues).toContainEqual(expect.objectContaining({kind:'tool',dependencyId:'native:retired'}))
    expect(()=>assertWorkflowReady(readiness)).toThrow('不能运行')
  })
  it('selects compact only before a new task freeze and preserves unavailable-tool readiness through publication',async()=>{
    const f=fixture(),service=f.open(),task=await service.start(f.request,f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('published')
    expect(task.compilerMode).toBe('compact-repair')
    expect(task).toHaveProperty('compilerSelection',{protocolVersion:1,state:'frozen',requestedMode:'template-fill',effectiveMode:'compact-repair',reason:'baseline-tool-template-unavailable',nodeIds:['retired']})
    expect(task.templateBinding).toBeUndefined();expect(task.compilerDraft?.format).toBe('compact-v1')
    expect(task.candidate!.nodes.find(node=>node.id==='retired')!.config).toEqual(f.context.workflow.nodes[1]!.config)
    expect(task.readiness?.canRun).toBe(false);expect(task.readiness?.issues.some(issue=>issue.dependencyId==='native:retired')).toBe(true)
    expect(f.options.publish).toHaveBeenCalledOnce();expect(f.generate).toHaveBeenCalledOnce()
    expect(task.childAttempts).toBe(1);expect(task.candidateAttempts).toBe(1);expect(task.steps).toBe(1);expect(task.spentTokens).toBe(7)
    f.options.compilerMode='legacy'
    const reopened=f.open().get(task.id,f.caller)
    expect((reopened as any).compilerSelection).toEqual((task as any).compilerSelection)
    expect((await service.start(f.request,f.caller)).id).toBe(task.id);expect(f.generate).toHaveBeenCalledOnce()
  })
  it('retains template mode when a real tool template is available',async()=>{
    const f=fixture();f.context.tools=[{...unavailableTool,available:true}]
    const task=await f.open().start(f.request,f.caller)
    expect(task.state,JSON.stringify(task.diagnostics)).toBe('published')
    expect(task.compilerMode).toBe('template-fill');expect(task.templateBinding).toBeDefined()
    expect(task).toHaveProperty('compilerSelection',expect.objectContaining({requestedMode:'template-fill',effectiveMode:'template-fill',reason:'configured',nodeIds:[]}))
    expect(task.readiness?.canRun).toBe(true)
  })
  it('preserves fixed and out-of-target missing templates without downgrading unrelated edits',async()=>{
    for(const fixed of [false,true]){
      const f=fixture();f.context.workflow.nodes[1]!.fixed=fixed;f.context.targetNodeIds=['host-end'];f.request.targetNodeIds=['host-end']
      f.generate.mockImplementation(async input=>submit(input,{submission:{mode:'edit',updates:{n3:{title:'更新输出标题'}},coverage:{R1:['n3']}}}))
      const task=await f.open().start(f.request,f.caller)
      expect(task.state,JSON.stringify(task.diagnostics)).toBe('published');expect(task.compilerMode).toBe('template-fill')
      expect(task.candidate!.nodes[1]).toEqual(f.context.workflow.nodes[1]);expect(task.readiness?.canRun).toBe(false)
    }
    const fixed=reviseContext();fixed.workflow.nodes[1]!.fixed=true
    expect(selectPlanningCompiler('template-fill',fixed).effectiveMode).toBe('template-fill')
  })
  it('does not downgrade create, a blank tool selection, or an explicitly selected compact mode',()=>{
    const context=reviseContext();context.operation='create';context.workflow.revision=0
    expect(selectPlanningCompiler('template-fill',context).effectiveMode).toBe('template-fill')
    context.operation='revise';context.workflow.nodes[1]!.config.toolId=''
    expect(selectPlanningCompiler('template-fill',context).effectiveMode).toBe('template-fill')
    expect(selectPlanningCompiler('compact-repair',reviseContext())).toMatchObject({effectiveMode:'compact-repair',reason:'configured',nodeIds:[]})
    expect(selectPlanningCompiler('legacy',reviseContext())).toMatchObject({requestedMode:'legacy',effectiveMode:'compact-repair',reason:'legacy-retired',nodeIds:[]})
  })
  it('fails before a child when compact cannot validate the unavailable tool schema',async()=>{
    const f=fixture();f.context.tools=[{...unavailableTool,inputSchema:{type:'object',properties:{path:{type:'string',pattern:'^kept$'}}}}]
    const task=await f.open().start(f.request,f.caller)
    expect(task.state).toBe('failed');expect(f.generate).not.toHaveBeenCalled()
    expect(task.context).toBeUndefined();expect(task.compilerMode).toBeUndefined();expect(task.templateBinding).toBeUndefined()
    expect(task).toHaveProperty('compilerSelection',{protocolVersion:1,state:'pending',requestedMode:'template-fill'})
    expect(f.open().get(task.id,f.caller).state).toBe('failed')
  })
  it('does not translate permission or template snapshot failures into a fallback',async()=>{
    const denied=fixture();let calls=0
    denied.options.authorize=()=>{if(++calls>1)throw Error('FORBIDDEN permission revoked')}
    const blocked=await denied.open().start(denied.request,denied.caller)
    expect(blocked.state).toBe('blocked');expect(denied.generate).not.toHaveBeenCalled();expect(blocked.context).toBeUndefined()
    const invalid=fixture();invalid.context.tools=[{...unavailableTool,id:'native:bad-schema',available:true,inputSchema:JSON.parse('{"type":"object","properties":{"constructor":{"type":"string"}}}')}]
    const failed=await invalid.open().start(invalid.request,invalid.caller)
    expect(failed.state).toBe('failed');expect(invalid.generate).not.toHaveBeenCalled();expect(failed.context).toBeUndefined()
    expect(failed).toHaveProperty('compilerSelection',expect.objectContaining({state:'pending'}))
  })
  it('never reselects a historical task on clarification after the default changes',async()=>{
    const f=fixture(),service=f.open();f.generate.mockImplementationOnce(async input=>submit(input,question))
    const waiting=await service.start(f.request,f.caller)
    expect(waiting.state).toBe('awaiting_input')
    await service.close()
    // Historical template5 tasks froze template-fill even for missing templates,
    // and predate the Host-only continuation checkpoint contract.
    f.replace(task=>{delete task.compilerSelection;delete task.compilerDraft.checkpoint;task.compilerMode='template-fill';task.templateBinding=createTemplateBinding(f.context.tools);task.compilerDraft.format='template-fill-v1'})
    f.options.compilerMode='compact-repair'
    const resumed=await f.open().answer(waiting.id,waiting.revision,[{questionId:'format',answer:'仅修改标题'}],f.caller)
    expect(resumed.state).toBe('failed');expect(resumed.compilerMode).toBe('template-fill');expect(resumed).not.toHaveProperty('compilerSelection')
    expect(resumed.childAttempts).toBe(2);expect(resumed.candidateAttempts).toBe(1);expect(f.options.context).toHaveBeenCalledOnce()
  })
  it('keeps the frozen fallback and counters through clarification without rereading the baseline',async()=>{
    const f=fixture(),service=f.open();f.generate.mockImplementationOnce(async input=>submit(input,question))
    const waiting=await service.start(f.request,f.caller);expect(waiting.state).toBe('awaiting_input')
    f.options.compilerMode='legacy';f.context.tools=[{...unavailableTool,available:true}]
    const result=await service.answer(waiting.id,waiting.revision,[{questionId:'format',answer:'仅修改标题'}],f.caller)
    expect(result.state).toBe('published');expect(result.compilerMode).toBe('compact-repair')
    expect((result as any).compilerSelection).toEqual((waiting as any).compilerSelection)
    expect(result.childAttempts).toBe(2);expect(result.steps).toBe(2);expect(result.spentTokens).toBe(14);expect(result.candidateAttempts).toBe(1)
    expect(f.options.context).toHaveBeenCalledOnce()
  })
  it('blocks an uncertain publication and contract rejection without protocol retry',async()=>{
    for(const error of ['write uncertain','TEMPLATE_CONTRACT_CONFLICT: contract changed']){
      const f=fixture();f.options.publish=vi.fn(async()=>{throw Error(error)})
      const service=f.open(),task=await service.start(f.request,f.caller)
      expect(task.state).toBe(error==='write uncertain'?'blocked':'conflict');expect(task.compilerMode).toBe('compact-repair')
      expect(task.candidateAttempts).toBe(1);expect(f.generate).toHaveBeenCalledOnce()
      expect((await service.start(f.request,f.caller)).id).toBe(task.id);expect(f.generate).toHaveBeenCalledOnce()
    }
  })
  it('rejects unknown or inconsistent selection protocols',()=>{
    for(const raw of [
      {protocolVersion:2,state:'pending',requestedMode:'template-fill'},
      {protocolVersion:1,state:'pending',requestedMode:'future'},
      {protocolVersion:1,state:'frozen',requestedMode:'template-fill',effectiveMode:'legacy',reason:'baseline-tool-template-unavailable',nodeIds:['retired']},
      {protocolVersion:1,state:'frozen',requestedMode:'template-fill',effectiveMode:'compact-repair',reason:'configured',nodeIds:[]},
    ])expect(()=>planningCompilerSelectionSchema.parse(raw)).toThrow()
  })
  it('rejects pending records with context, drafts, children or accounting and never resumes them',async()=>{
    const f=fixture();f.options.context=vi.fn(async()=>{throw Error('context unavailable')})
    const task=await f.open().start(f.request,f.caller),base=f.stored()
    expect(task).toHaveProperty('compilerSelection',expect.objectContaining({state:'pending'}))
    for(const fields of [
      {context:f.context},{childAttempts:1},{compilerMode:'compact-repair'},{spentTokens:1},
      {compilerDraft:{format:'compact-v1',purpose:'author',baseDigest:'0'.repeat(64),revision:1,document:{},issues:[]}},
    ]){
      f.replace(record=>Object.assign(record,fields));expect(()=>f.open()).toThrow('待选择模式')
      writeFileSync(join(f.options.directory,'planning','tasks.json'),JSON.stringify(base))
    }
    f.replace(record=>record.compilerSelection.protocolVersion=2);expect(()=>f.open()).toThrow()
    expect(f.generate).not.toHaveBeenCalled()
  })
  it('records the requested mode while context is pending and freezes against that request rather than later defaults',async()=>{
    const f=fixture();let resolveContext!:(context:ReturnType<typeof reviseContext>)=>void
    f.options.context=vi.fn(()=>new Promise(resolve=>{resolveContext=resolve}))
    const service=f.open(),running=service.start(f.request,f.caller)
    await vi.waitFor(()=>expect(f.options.context).toHaveBeenCalledOnce())
    const pending=service.findRequest(f.request.requestId,f.caller)!
    expect(pending.compilerMode).toBeUndefined();expect(pending.context).toBeUndefined()
    expect(pending).toHaveProperty('compilerSelection',{protocolVersion:1,state:'pending',requestedMode:'template-fill'})
    f.options.compilerMode='legacy';resolveContext(f.context)
    const task=await running
    expect(task.state).toBe('published');expect(task.compilerMode).toBe('compact-repair')
    expect(task).toHaveProperty('compilerSelection',expect.objectContaining({requestedMode:'template-fill',effectiveMode:'compact-repair'}))
  })
  it('marks a valid persisted pending task interrupted without selecting or calling a child after restart',async()=>{
    const f=fixture();f.options.context=vi.fn(async()=>{throw Error('context unavailable')})
    const service=f.open(),task=await service.start(f.request,f.caller);await service.close()
    f.replace(record=>record.state='collecting');f.options.compilerMode='compact-repair'
    const reopened=f.open(),restored=reopened.get(task.id,f.caller)
    expect(restored.state).toBe('interrupted');expect(restored.compilerMode).toBeUndefined()
    expect(restored).toHaveProperty('compilerSelection',{protocolVersion:1,state:'pending',requestedMode:'template-fill'})
    expect((await reopened.start(f.request,f.caller)).state).toBe('interrupted')
    expect(f.generate).not.toHaveBeenCalled();expect(f.options.context).toHaveBeenCalledOnce()
  })
})
