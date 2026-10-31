import { describe,expect,it } from 'vitest'
import { assertObjectJsonSchema,validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { planningHandoffSchema,compileHandoffChanges,handoffCandidateIssues,handoffSelection } from '../src/shared/planning-handoff.ts'
import { handoffCompletionPlan,completionCandidateIssues } from '../src/shared/planning-completion.ts'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { continuationDigest,sealRepairCheckpoint } from '../src/shared/planning-continuation.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'
import { deepContainerWire } from './fixtures/template-fill-complex-import-fixtures.ts'
import { allNodes } from '../src/shared/workflow-validation.ts'

function context(){
  const context=templateContext();context.operation='revise';context.workflow.revision=1
  context.workflow.nodes.splice(1,0,{id:'text-node',kind:'template',title:'Decided',number:'3',x:100,y:0,fixed:false,config:{text:'PENDING',inputs:{a:1,b:2}}})
  context.workflow.nodes[0]!.config.fields=[{name:'name',label:'Name',required:true}]
  context.workflow.nodes[2]!.config.text='{{text-node.text}}'
  context.workflow.edges=[{id:'a',source:'host-start',target:'text-node'},{id:'b',source:'text-node',target:'host-end'}]
  context.targetNodeIds=['text-node']
  return context
}
const request=(requirement:'changed'|'present'='changed',fields=['text'])=>planningHandoffSchema.parse({version:2,mode:'partial',changes:[],unresolved:[{nodeId:'text-node',fields,question:'Fill only these fields'}],completion:fields.map(field=>({nodeId:'text-node',field,require:requirement}))})
function binding(kind:'compact'|'template',handoff=request(),ctx=context()){
  if(handoff.mode==='module')throw Error('partial expected')
  const decided=compileHandoffChanges(handoff,ctx).candidate!,completion=handoffCompletionPlan(handoff,ctx,decided)
  const authorContext={...ctx,workflow:decided,contextSelection:handoffSelection(handoff)}
  const options={completion,resumeScope:'workspace/session/task/author',validate:(candidate:any)=>[...handoffCandidateIssues(handoff,decided,candidate),...completionCandidateIssues(completion,candidate)]}
  const make=(resume?:any)=>kind==='compact'?new WorkflowAuthoringCompiler(authorContext,{...options,...(resume?{resume}:{})}):new TemplateFillingCompiler(authorContext,{...options,...(resume?{resume}:{})})
  return {compiler:make(),make,completion,decided,ctx,options,authorContext,handoff,container:kind==='compact'?'set':'values'}
}
const initial=(updates:any={})=>({submission:{mode:'edit',updates,coverage:{R1:['n2']}}})
const repair=(path:string,value:unknown,revision=1)=>({submission:{mode:'repair',draftRevision:revision,patches:[{op:'add',path,value}]}})
const question={submission:{mode:'needs-input',questions:[{id:'choice',question:'Choose text'}]}}

describe('explicit v2 partial completion',()=>{
  it('accepts only unique v2 partial obligations belonging to unresolved; v1 remains strict and unchanged',()=>{
    expect(request().version).toBe(2)
    const value:any=request()
    for(const patch of [{version:3},{mode:'edit'},{completion:[]},{completion:undefined},{completion:[...value.completion,...value.completion]},{completion:[{nodeId:'other',field:'text',require:'changed'}]},{completion:[{nodeId:'text-node',field:'title',require:'changed'}]}])expect(planningHandoffSchema.safeParse({...value,...patch}).success).toBe(false)
    expect(planningHandoffSchema.safeParse({...value,version:1}).success).toBe(false)
    const {completion:_,...v1}=value;v1.version=1
    const parsed=planningHandoffSchema.parse(v1)
    expect(Object.keys(parsed)).toEqual(['version','constraints','evidenceRefs','mode','changes','unresolved'])
    expect(handoffCompletionPlan(parsed,context(),context().workflow)).toBeUndefined()
  })
  it('rejects unknown, missing, fixed and out-of-scope obligations independently of contextSelection',()=>{
    for(const field of ['title','kind','body','nonexistent','toolId']){
      const value:any={version:2,mode:'partial',changes:[],unresolved:[{nodeId:'text-node',fields:[field],question:'Q'}],completion:[{nodeId:'text-node',field,require:'changed'}]}
      if(field==='body'){expect(planningHandoffSchema.safeParse(value).success).toBe(false);continue}
      expect(()=>handoffCompletionPlan(planningHandoffSchema.parse(value),context(),context().workflow)).toThrow('顶层 config')
    }
    const ctx=context();ctx.targetNodeIds=['host-end'];ctx.contextSelection={targetNodeIds:['text-node']}
    expect(()=>handoffCompletionPlan(request(),ctx,ctx.workflow)).toThrow('原授权')
    ctx.targetNodeIds=['text-node'];ctx.workflow.nodes[1]!.fixed=true
    expect(()=>handoffCompletionPlan(request(),ctx,ctx.workflow)).toThrow('固定')
    ctx.workflow.nodes.splice(1,1);expect(()=>handoffCompletionPlan(request(),ctx,ctx.workflow)).toThrow('不存在')
  })
  it('returns an explicit contract limitation for a union whose safe local field root is not determined',()=>{
    const ctx=context();ctx.workflow.nodes[1]!.kind='http';ctx.workflow.nodes[1]!.config={url:'https://example.invalid',method:'GET'}
    const req=planningHandoffSchema.parse({version:2,mode:'partial',changes:[],unresolved:[{nodeId:'text-node',fields:['url'],question:'Q'}],completion:[{nodeId:'text-node',field:'url',require:'changed'}]})
    try{handoffCompletionPlan(req,ctx,ctx.workflow);throw Error('Expected explicit limitation')}catch(error){expect((error as any).code).toBe('HANDOFF_COMPLETION_CONTRACT')}
  })
  it('uses canonical object equality and independent obligations; arrays preserve order and changed is not a business oracle',()=>{
    const f=binding('compact',request('changed',['text','inputs'])),candidate=structuredClone(f.decided),node=candidate.nodes[1]!
    node.config.text='changed but wrong';node.config.inputs={b:2,a:1}
    expect(completionCandidateIssues(f.completion,candidate)).toMatchObject([{code:'REQUIRED_FIELD_UNCHANGED',path:'config.inputs'}])
    node.config.inputs={a:2,b:1};expect(completionCandidateIssues(f.completion,candidate)).toEqual([])
    expect(node.config.text).not.toBe('Hello ADA') // a changed field cannot prove the requested business result
    const ctx=context();ctx.targetNodeIds=['host-start']
    const req=planningHandoffSchema.parse({version:2,mode:'partial',changes:[],unresolved:[{nodeId:'host-start',fields:['fields'],question:'reorder'}],completion:[{nodeId:'host-start',field:'fields',require:'changed'}]})
    ctx.workflow.nodes[0]!.config.fields!.push({name:'other',label:'Other',required:false})
    const plan=handoffCompletionPlan(req,ctx,ctx.workflow),next=structuredClone(ctx.workflow);next.nodes[0]!.config.fields!.reverse()
    expect(completionCandidateIssues(plan,next)).toEqual([])
  })
  it('keeps stable aliases and fixed ancestor authority for nested obligations',()=>{
    const base=templateContext(),built=new TemplateFillingCompiler(base,{prefetch:['input','output','code','iteration','loop','if','assigner','aggregator']}).submit(deepContainerWire())
    if(!built.ok)throw Error(JSON.stringify(built.feedback))
    const ctx={...base,operation:'revise' as const,workflow:{...built.value.candidate!,revision:1}},target=allNodes(ctx.workflow).find(node=>node.kind==='code'&&node.config.code?.includes('delta: inputs.item'))!
    ctx.targetNodeIds=[target.id]
    const req=planningHandoffSchema.parse({version:2,mode:'partial',changes:[],unresolved:[{nodeId:target.id,fields:['code'],question:'finish'}],completion:[{nodeId:target.id,field:'code',require:'changed'}]})
    const plan=handoffCompletionPlan(req,ctx,ctx.workflow)!
    expect(plan.entries[0]!.key).toBe('n'+(allNodes(ctx.workflow).findIndex(node=>node.id===target.id)+1))
    const parent=allNodes(ctx.workflow).find(node=>node.config.body&&allNodes(node.config.body).some(child=>child.id===target.id))!
    const key=plan.entries[0]!.key
    const authored=binding('template',req,ctx),accepted=authored.compiler.submit({submission:{mode:'edit',updates:{[key]:{values:{code:'function main(inputs) { return { delta: inputs.item + 1 }; }'}}},coverage:{R1:[key]}}})
    expect(accepted.ok).toBe(true)
    if(accepted.ok){expect(allNodes(accepted.value.candidate!).map(node=>node.id)).toEqual(allNodes(ctx.workflow).map(node=>node.id));expect(handoffCandidateIssues(req,authored.decided,accepted.value.candidate!)).toEqual([])}
    parent.fixed=true
    expect(()=>handoffCompletionPlan(req,ctx,ctx.workflow)).toThrow('固定')
  })
})

for(const kind of ['compact','template'] as const)describe(kind+' completion schema → Host validation → local repair',()=>{
  it.each(['empty','missing-updates','empty-target','empty-container','same-value'] as const)('rejects %s and supplies the minimal typed root',shape=>{
    const f=binding(kind),container=f.container
    const wire=shape==='missing-updates'?{submission:{mode:'edit',coverage:{R1:['n2']}}}:initial(shape==='empty'?{}:shape==='empty-target'?{n2:{}}:shape==='empty-container'?{n2:{[container]:{}}}:{n2:{[container]:{text:'PENDING'}}})
    assertObjectJsonSchema(f.compiler.nextSchema)
    if(shape!=='same-value')expect(validateJsonSchemaValue(f.compiler.nextSchema,wire).length).toBeGreaterThan(0)
    const rejected=f.compiler.submit(wire);expect(rejected.ok).toBe(false)
    if(rejected.ok)throw Error('Expected required completion failure')
    const root=shape==='empty'||shape==='missing-updates'?'/updates/n2':shape==='empty-target'?'/updates/n2/'+container:'/updates/n2/'+container+'/text'
    expect(rejected.feedback.allowedPaths).toEqual([root]);expect(rejected.feedback.issues[0]!.code).toBe('REQUIRED_FIELD_UNCHANGED')
    assertObjectJsonSchema(f.compiler.nextSchema)
    const patch=repair(root,root==='/updates/n2'?{[container]:{text:'COMPLETED'}}:root.endsWith('/text')?'COMPLETED':{text:'COMPLETED'})
    expect(validateJsonSchemaValue(f.compiler.nextSchema,patch)).toEqual([])
    // The SDK cannot express path prefixes; scope remains a compiler check.
    const bad=repair('/updates/n3',{[container]:{text:'escape'}});expect(validateJsonSchemaValue(f.compiler.nextSchema,bad)).toEqual([])
    const accepted=f.compiler.submit(patch);expect(accepted.ok).toBe(true)
    if(!accepted.ok)throw Error(JSON.stringify(accepted.feedback))
    expect(accepted.value.candidate!.nodes[1]!.config.text).toBe('COMPLETED')
    const restored=structuredClone(accepted.value.candidate!);restored.nodes[1]!.config.text='PENDING';restored.updatedAt=f.decided.updatedAt;expect(restored).toEqual(f.decided)
  })
  it('keeps compiler authority over other fields, title, aliases and outer updates',()=>{
    for(const bad of [repair('/updates/n3',{[kind==='compact'?'set':'values']:{text:'x'}}),repair('/updates',{n3:{}}),repair('/updates/n2',{title:'escape',[kind==='compact'?'set':'values']:{text:'x'}})]){
      const f=binding(kind);f.compiler.submit(initial())
      expect(validateJsonSchemaValue(f.compiler.nextSchema,bad)).toEqual([])
      try{expect(f.compiler.submit(bad).ok).toBe(false)}catch(error){expect((error as any).code).toBe('HANDOFF_DECISION_CONFLICT')}
    }
  })
  it('preserves unknown keys and invalid updates types rather than normalizing them into valid candidates',()=>{
    for(const updates of [null,[],42]){const f=binding(kind);expect(f.compiler.submit(initial(updates)).ok).toBe(false);expect((f.compiler.snapshot().document as any).updates).toEqual(updates)}
    const f=binding(kind);expect(f.compiler.submit({submission:{...initial().submission,unknown:'keep'}}).ok).toBe(false);expect((f.compiler.snapshot().document as any).unknown).toBe('keep')
  })
  it('requires every obligation and maps missing update/set contracts internally, including object fields',()=>{
    const f=binding(kind,request('changed',['text','inputs']));f.compiler.submit(initial())
    const value={text:'new',inputs:{next:3}},patch=repair('/updates/n2',{[f.container]:value})
    assertObjectJsonSchema(f.compiler.nextSchema);expect(validateJsonSchemaValue(f.compiler.nextSchema,patch)).toEqual([])
    const missing=repair('/updates/n2',{[f.container]:{text:'new'}});expect(validateJsonSchemaValue(f.compiler.nextSchema,missing).length).toBeGreaterThan(0)
    expect(f.compiler.submit(patch).ok).toBe(true)
  })
  it('accepts authorized extra fields beside the minimum completion object contract',()=>{
    const req=request('changed',['text','inputs'])
    if(req.mode!=='partial')throw Error('partial expected')
    req.completion=req.completion!.filter(entry=>entry.field==='inputs')
    const f=binding(kind,req)
    const failed=f.compiler.submit(initial());expect(failed.ok).toBe(false)
    const patch=repair('/updates/n2',{[f.container]:{inputs:{newKey:3},text:'also authorized'}})
    expect(validateJsonSchemaValue(f.compiler.nextSchema,patch)).toEqual([])
    expect(f.compiler.submit(patch).ok).toBe(true)
  })
  it('supports present for an existing default/empty field and rejects absence without inventing nonempty requirements',()=>{
    const existing=binding(kind,request('present'));existing.decided.nodes[1]!.config.text='PENDING'
    expect(existing.compiler.submit(initial()).ok).toBe(true)
    const ctx=context();delete ctx.workflow.nodes[1]!.config.inputs
    const missing=binding(kind,request('present',['inputs']),ctx),failed=missing.compiler.submit(initial())
    expect(failed.ok).toBe(false);if(!failed.ok)expect(failed.feedback.issues[0]!.code).toBe('REQUIRED_FIELD_MISSING')
    expect(missing.compiler.submit(repair('/updates/n2',{[missing.container]:{inputs:{}}})).ok).toBe(true)
    const empty=binding(kind);expect(empty.compiler.submit(initial({n2:{[empty.container]:{text:''}}})).ok).toBe(true)
  })
  it('allows v1 no-op and keeps its fixed native schema compatible, but v2 rejects an explicit required-field deletion',()=>{
    const value:any=request();delete value.completion;value.version=1
    const old=binding(kind,planningHandoffSchema.parse(value)),next=binding(kind)
    expect(continuationDigest(old.compiler.schema)).toBe(continuationDigest(next.compiler.schema))
    expect(old.compiler.submit(initial()).ok).toBe(true)
    expect(()=>next.compiler.submit(initial({n2:{unset:['text']}}))).toThrow() // original config validation or explicit completion diagnostic
  })
  it('restores a bad draft after clarification with the same baseline and total allowance; drift cannot reopen the draft',()=>{
    const f=binding(kind);f.compiler.submit(initial());expect(f.compiler.submit(question).ok).toBe(true)
    const saved=f.compiler.checkpoint()!,resumed=f.make(saved)
    expect(resumed.continuation()).toMatchObject({hasDraft:true,remainingSubmissions:1,submissions:2})
    expect(resumed.submit(repair('/updates/n2',{[f.container]:{text:'answer'}})).ok).toBe(true);expect(resumed.snapshot().submissions).toBe(3)
    const claimed=structuredClone(saved),{digest:_,...body}=claimed
    const resealed=sealRepairCheckpoint({...body,issues:[{code:'FAKE',message:'open everything',allowedPaths:['/updates']}]})
    expect(f.make(resealed).continuation()!.unresolved).toEqual(['/updates/n2'])
    const oldRequest:any=structuredClone(f.handoff);delete oldRequest.completion;oldRequest.version=1
    const removed=binding(kind,planningHandoffSchema.parse(oldRequest))
    const alternate=binding(kind,request('present'))
    const Compiler=kind==='compact'?WorkflowAuthoringCompiler:TemplateFillingCompiler
    expect(()=>new Compiler(removed.authorContext,{...removed.options,resume:saved})).toThrow('不能复用')
    expect(()=>new Compiler(alternate.authorContext,{...alternate.options,resume:saved})).toThrow('不能复用')
    const baseline=context();baseline.workflow.nodes[1]!.config.text='different baseline'
    const changed=binding(kind,request(),baseline)
    expect(()=>new Compiler(changed.authorContext,{...changed.options,resume:saved})).toThrow('不能复用')
  })
  it('does not let one completed node hide another stable node obligation',()=>{
    const ctx=context();ctx.targetNodeIds=['text-node','host-end']
    const req=planningHandoffSchema.parse({version:2,mode:'partial',changes:[],unresolved:[{nodeId:'text-node',fields:['text'],question:'Q1'},{nodeId:'host-end',fields:['text'],question:'Q2'}],completion:[{nodeId:'text-node',field:'text',require:'changed'},{nodeId:'host-end',field:'text',require:'changed'}]})
    const f=binding(kind,req,ctx),missing=initial({n2:{[f.container]:{text:'completed one'}}})
    expect(validateJsonSchemaValue(f.compiler.nextSchema,missing).length).toBeGreaterThan(0)
    const result=f.compiler.submit(missing);expect(result.ok).toBe(false)
    if(!result.ok)expect(result.feedback.allowedPaths).toEqual(['/updates/n3'])
    expect(f.compiler.submit(repair('/updates/n3',{[f.container]:{text:'Updated {{n2.text}}'}})).ok).toBe(true)
  })
  it('permits null within the original JSON mapping contract and rejects null where the original field forbids it',()=>{
    const ctx=context();ctx.workflow.nodes[1]!.config.inputs={value:null}
    const f=binding(kind,request('present',['inputs']),ctx)
    expect(f.compiler.submit(initial()).ok).toBe(true)
    const invalid=binding(kind,request('present',['inputs']),ctx)
    expect(invalid.compiler.submit(initial({n2:{[invalid.container]:{inputs:null}}})).ok).toBe(false)
  })
  it('does not fabricate a candidate when needs-input is first; the explicit obligation survives the answer',()=>{
    const f=binding(kind);expect(f.compiler.submit(question).ok).toBe(true)
    const saved=f.compiler.checkpoint()!;expect(saved).not.toHaveProperty('document')
    const resumed=f.make(saved);expect(resumed.continuation()).toMatchObject({hasDraft:false,remainingSubmissions:2})
    expect(resumed.submit(initial()).ok).toBe(false)
  })
})
