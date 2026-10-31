import { z } from 'zod'
import { describe,it,expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { assertObjectJsonSchema,validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { authoringContext,authoringGraphContext } from '../src/shared/planning-authoring-context.ts'
import { applyRepair,compilerJson,RepairSession,submissionSchema,issueFromError } from '../src/shared/planning-repair.ts'
import { createProcedureCompiler } from '../src/shared/planning-procedure-compiler.ts'
import { parseTaskProcedure,taskSpecificationRefs } from '../src/shared/retrospective.ts'
import { exportWorkflowPackage,parseWorkflowPackage } from '../src/shared/workflow-format.ts'
import type { PlanningContext } from '../src/shared/planning-types.ts'

export function compilerContext():PlanningContext{
  return {workflow:{id:'flow',workspaceId:'workspace',title:'流程',description:'',revision:0,createdAt:'2026-10-18T00:00:00.000Z',updatedAt:'2026-10-18T00:00:00.000Z',nodes:[
    {id:'host-start',kind:'input',title:'输入',number:'1',x:0,y:0,fixed:false,config:{fields:[]}},
    {id:'host-end',kind:'output',title:'输出',number:'2',x:200,y:0,fixed:false,config:{text:'',outputName:'result'}},
  ],edges:[{id:'old-edge',source:'host-start',target:'host-end'}],notes:[]},operation:'create',targetNodeIds:[],nodeIds:Array.from({length:40},(_,i)=>'allocated-'+i),subagentIds:['role-1'],environmentIds:['env-1'],model:{provider:'test',model:'test'},tools:[]}
}
export function declaration(){return {submission:{mode:'create',title:'问候',nodes:[
  {key:'start',kind:'input',config:{fields:[{name:'name',label:'姓名',required:true}]}},
  {key:'greet',kind:'template',config:{text:'你好 {{input.name}}'}},
  {key:'result',kind:'output',config:{text:'{{greet.text}}',outputName:'result'}},
],chains:[{key:'main',nodes:['start','greet','result']}],coverage:{R1:['greet','result']}}}}
const r7=JSON.parse(readFileSync(new URL('./fixtures/planning-compiler/r7-distillation-failure.json',import.meta.url),'utf8'))

describe('dedicated workflow compiler',()=>{
  it('compiles a compact declaration into the existing JSON v2 contract with stable IDs and no bypass',()=>{
    const ctx=compilerContext(),compiler=new WorkflowAuthoringCompiler(ctx),wire=declaration()
    assertObjectJsonSchema(compiler.schema);expect(validateJsonSchemaValue(compiler.schema,wire)).toEqual([])
    const result=compiler.submit(wire);expect(result.ok,JSON.stringify(result)).toBe(true)
    if(!result.ok)throw Error(JSON.stringify(result.feedback))
    expect(result.value.issues).toEqual([])
    const flow=result.value.candidate!
    expect(flow.nodes.map(n=>n.id)).toEqual(['host-start','host-end','allocated-0'])
    expect(flow.edges.map(({source,target})=>[source,target])).toEqual([['host-start','allocated-0'],['allocated-0','host-end']])
    expect(flow.nodes[1]!.config.text).toBe('{{allocated-0.text}}')
    expect(ctx.workflow.nodes).toHaveLength(2)
    const pkg=exportWorkflowPackage(flow)
    expect(pkg).toMatchObject({formatVersion:2,runtime:{engine:'graphon',protocol:1}})
    expect(()=>parseWorkflowPackage(JSON.stringify(pkg))).not.toThrow()
    expect(()=>compiler.submit(wire)).toThrow('已经接受')
  })
  it('retains invalid code/config and repairs it without regenerating unrelated declarations',()=>{
    const compiler=new WorkflowAuthoringCompiler(compilerContext()),wire=declaration()
    wire.submission.nodes[1]!.config={text:'{{missing.text}}'} as any
    const first=compiler.submit(wire);expect(first.ok).toBe(false)
    if(first.ok)throw Error('expected feedback')
    expect(first.feedback.allowedPaths.some(p=>p.startsWith('/nodesByKey/greet/config')),JSON.stringify(first)).toBe(true)
    const before=compiler.snapshot().document as any
    const second=compiler.submit({submission:{mode:'repair',draftRevision:first.feedback.draftRevision,patches:[{op:'replace-text',path:'/nodesByKey/greet/config/text',find:'missing.text',replace:'input.name'}]}})
    expect(second.ok).toBe(true)
    const after=compiler.snapshot().document as any
    expect(after.nodesByKey.start).toEqual(before.nodesByKey.start)
    expect(after.nodesByKey.result).toEqual(before.nodesByKey.result)
    expect(second.ok&&second.value.candidate!.nodes.some(n=>n.id==='allocated-0')).toBe(true)
  })
  it('fills only an absent authoring mode from the immutable Host operation',()=>{
    const compiler=new WorkflowAuthoringCompiler(compilerContext()),wire:any=declaration()
    delete wire.submission.mode
    expect(validateJsonSchemaValue(compiler.schema,wire)).toEqual([])
    expect(compiler.submit(wire).ok).toBe(true)
    const conflicting:any=declaration();conflicting.submission.mode='edit'
    expect(()=>new WorkflowAuthoringCompiler(compilerContext()).submit(conflicting)).toThrow('模式与绑定任务不符')
  })
  it('reports all node-config type failures at editable draft paths',()=>{
    const c=new WorkflowAuthoringCompiler(compilerContext()),wire=declaration()
    ;(wire.submission.nodes[0]!.config.fields![0] as any).required='true'
    ;(wire.submission.nodes[1]!.config as any).text=7
    const result=c.submit(wire);expect(result.ok).toBe(false)
    if(result.ok)throw Error('expected failure')
    expect(result.feedback.issues).toHaveLength(2)
    expect(result.feedback.issues.map(i=>i.path)).toEqual(['/nodesByKey/start/config/fields/0/required','/nodesByKey/greet/config/text'])
    const repaired=c.submit({submission:{mode:'repair',draftRevision:1,patches:[{op:'replace',path:'/nodesByKey/start/config/fields/0/required',value:true},{op:'replace',path:'/nodesByKey/greet/config/text',value:'Hello {{input.name}}'}]}})
    expect(repaired.ok).toBe(true)
  })
  it('retains nested scopes, branch ports, roles and Secret declarations',()=>{
    const c=new WorkflowAuthoringCompiler(compilerContext())
    const result=c.submit({submission:{mode:'create',title:'容器',nodes:[
      {key:'start',kind:'input',config:{fields:[]}},
      {key:'repeat',kind:'loop',config:{maxIterations:1,initialVariables:{},outputVariable:'inside.text'}},
      {key:'innerStart',kind:'input',scope:['repeat'],config:{fields:[]}},
      {key:'inside',kind:'template',scope:['repeat'],config:{text:'hello'}},
      {key:'innerEnd',kind:'output',scope:['repeat'],config:{text:'{{inside.text}}',outputName:'result'}},
      {key:'result',kind:'output',config:{text:'{{repeat.text}}',outputName:'result'}},
    ],chains:[{key:'main',nodes:['start','repeat','result']},{key:'nested',nodes:['innerStart','inside','innerEnd']}],roles:[{key:'writer',name:'作者',prompt:'整理材料'}],environment:[{key:'apiKey',name:'KEY',type:'secret'}],coverage:{R1:['repeat','result']}}})
    expect(result.ok,JSON.stringify(result)).toBe(true)
    if(!result.ok)throw Error('failed')
    const flow=result.value.candidate!,loop=flow.nodes.find(n=>n.kind==='loop')!
    expect(loop.config.body?.nodes).toHaveLength(3)
    expect(loop.config.body?.edges).toHaveLength(2)
    expect(loop.config.outputVariable).toBe('allocated-2.text')
    expect(flow.environmentVariables?.[0]).toMatchObject({id:'env-1',name:'KEY',type:'secret'})
    expect(flow.subAgents?.[0]).toMatchObject({id:'role-1',name:'作者'})
  })
  it('compiles 120 nodes without imposing the legacy model edit-count limit on Host expansion',()=>{
    const ctx=compilerContext();ctx.nodeIds=Array.from({length:150},(_,i)=>'allocated-'+i)
    const wire=declaration(),extra=Array.from({length:117},(_,i)=>({key:'stage'+i,kind:'template',config:{text:'intermediate'}}))
    wire.submission.nodes.splice(2,0,...extra as any)
    wire.submission.chains[0]!.nodes=['start','greet',...extra.map(n=>n.key),'result']
    const result=new WorkflowAuthoringCompiler(ctx).submit(wire)
    expect(result.ok,JSON.stringify(result)).toBe(true)
    if(result.ok)expect(result.value.candidate!.nodes).toHaveLength(120)
  })
  it('permits correction of omitted required declaration fields without exposing Host fields',()=>{
    const c=new WorkflowAuthoringCompiler(compilerContext()),wire=declaration(),missing:any=structuredClone(wire)
    delete missing.submission.title
    const first=c.submit(missing);if(first.ok)throw Error('expected missing title')
    expect(first.feedback.allowedPaths).toContain('/title')
    expect(c.submit({submission:{mode:'repair',draftRevision:1,patches:[{op:'add',path:'/title',value:wire.submission.title}]}}).ok).toBe(true)
  })
  it('keeps selected edits and fixed-node authorization at the original validator',()=>{
    const ctx=compilerContext();ctx.operation='revise';ctx.workflow.revision=3;ctx.targetNodeIds=['host-end'];ctx.workflow.nodes[0]!.fixed=true
    const c=new WorkflowAuthoringCompiler(ctx)
    expect(()=>c.submit({submission:{mode:'edit',updates:{n1:{set:{fields:[]},title:'改动'}},coverage:{R1:['n2']}}})).toThrow()
    const good=new WorkflowAuthoringCompiler(ctx).submit({submission:{mode:'edit',updates:{n2:{set:{text:'完成'}}},coverage:{R1:['n2']}}})
    expect(good.ok).toBe(true)
    expect(good.ok&&good.value.candidate!.nodes[0]).toEqual(ctx.workflow.nodes[0])
  })
  it('does not silently accept duplicates, unknown fields or secret values',()=>{
    const duplicate=declaration();duplicate.submission.nodes.push(duplicate.submission.nodes[1]!)
    expect(new WorkflowAuthoringCompiler(compilerContext()).submit(duplicate).ok).toBe(false)
    const extra=declaration();(extra.submission as any).id='injected'
    expect(new WorkflowAuthoringCompiler(compilerContext()).submit(extra).ok).toBe(false)
    const secret=declaration();(secret.submission as any).environment=[{key:'credential',type:'secret',name:'KEY',value:'not-allowed'}]
    expect(()=>new WorkflowAuthoringCompiler(compilerContext()).submit(secret)).toThrow()
  })
  it('preloads selected semantics while retaining graph topology and omitting unrelated configs',()=>{
    const ctx=compilerContext();ctx.operation='revise';ctx.targetNodeIds=['host-end']
    const view=authoringContext(ctx,'更改输出')
    expect(view.graph?.nodes[0]).not.toHaveProperty('config')
    expect(view.graph?.nodes[1]).toHaveProperty('config')
    expect(view.graph?.edges).toHaveLength(1)
    expect(view.prefetchedKinds).toContain('output')
    expect(view.graph?.nodes[0]).toHaveProperty('outputs')
    expect(authoringGraphContext(ctx)[0]).toHaveProperty('config')
  })
})

describe('atomic bounded repair',()=>{
  it('rolls back the entire batch and respects RFC6901 path boundaries',()=>{
    const doc={a:{'b/c':1,text:'foo foo'},other:4}
    expect(()=>applyRepair(doc,[{op:'replace',path:'/a/b~1c',value:2},{op:'replace',path:'/other',value:5}],['/a'])).toThrow('范围')
    expect(doc.a['b/c']).toBe(1)
    expect(()=>applyRepair(doc,[{op:'replace-text',path:'/a/text',find:'foo',replace:'bar'}],['/a'])).toThrow('恰好')
    expect(()=>applyRepair(doc,[{op:'add',path:'/a/__proto__',value:{}}],['/a'])).toThrow('危险')
    expect(()=>compilerJson(JSON.parse('{"constructor":{}}'))).toThrow('危险')
  })
  it('rejects stale revisions and out-of-region patches without losing the original repair region',()=>{
    const c=new WorkflowAuthoringCompiler(compilerContext()),wire=declaration();wire.submission.nodes[1]!.config={text:'{{missing.text}}'} as any
    const first=c.submit(wire);if(first.ok)throw Error('expected invalid')
    const result=c.submit({submission:{mode:'repair',draftRevision:0,patches:[{op:'replace',path:'/title',value:'oops'}]}})
    expect(result.ok).toBe(false)
    if(result.ok)throw Error('expected invalid')
    expect(result.feedback.allowedPaths).toEqual(first.feedback.allowedPaths)
    expect(c.snapshot().revision).toBe(first.feedback.draftRevision)
  })
  it('allows renaming an invalid field within its affected object, without unlocking other objects',()=>{
    const schema=z.object({edits:z.array(z.object({configSet:z.record(z.string(),z.unknown()).optional()}).strict())})
    const c=new RepairSession(submissionSchema({type:'object'}),{maxSubmissions:2,roots:()=>['/edits'],compile:doc=>schema.parse(doc)})
    const first=c.submit({submission:{edits:[{config:{text:'preserve'}}]}});if(first.ok)throw Error('expected unknown field')
    expect(first.feedback.allowedPaths).toEqual(['/edits/0'])
    const repaired=c.submit({submission:{mode:'repair',draftRevision:1,patches:[{op:'add',path:'/edits/0/configSet',value:{text:'preserve'}},{op:'remove',path:'/edits/0/config'}]}})
    expect(repaired).toEqual({ok:true,value:{edits:[{configSet:{text:'preserve'}}]}})
  })
  it('fails closed when journaling fails and enforces bounded submissions',()=>{
    const c=new RepairSession(submissionSchema({type:'object'}),{maxSubmissions:1,roots:()=>['/x'],compile:()=>42,onSubmission:()=>{throw Error('disk unavailable')}})
    expect(()=>c.submit({submission:{x:1}})).toThrow('disk unavailable')
    expect(()=>c.submit({submission:{x:2}})).toThrow()
  })
  it('permits correcting root-level validation failures and narrows subsequent model tools to repair',()=>{
    const schema=z.object({items:z.array(z.string())}).superRefine((value,ctx)=>{if(new Set(value.items).size!==value.items.length)ctx.addIssue({code:'custom',message:'items must be unique'})})
    const c=new RepairSession(submissionSchema({type:'object',properties:{items:{type:'array',items:{type:'string'}}},required:['items']}),{maxSubmissions:2,roots:()=>['/items'],compile:doc=>schema.parse(doc)})
    const first=c.submit({submission:{items:['same','same']}});if(first.ok)throw Error('expected duplicate')
    expect(first.feedback.allowedPaths).toEqual(['/items'])
    expect(validateJsonSchemaValue(c.nextSchema,{submission:{items:['same']}})).not.toEqual([])
    const repair={submission:{mode:'repair',draftRevision:1,patches:[{op:'replace',path:'/items',value:['same']}],summary:'Remove duplicate only'}}
    expect(validateJsonSchemaValue(c.nextSchema,repair)).toEqual([])
    expect(c.submit(repair)).toEqual({ok:true,value:{items:['same']}})
  })
})

describe('R7 recorded distillation regression',()=>{
  function validProcedure(){
    const procedure=JSON.parse(r7.invalidOutput.procedureJson),events=new Set(r7.evidence.records.map((r:any)=>r.id)),specs=new Set(taskSpecificationRefs(r7.trialTask))
    for(const step of procedure.steps){step.specRefs=step.evidenceRefs.filter((id:string)=>specs.has(id));step.evidenceRefs=step.evidenceRefs.filter((id:string)=>events.has(id))}
    procedure.excluded=procedure.excluded.filter((item:any)=>item.evidenceRefs.every((id:string)=>events.has(id)))
    return procedure
  }
  it('accepts a trial procedure without copying the frozen review notes (notes are optional)',()=>{
    const evidence=structuredClone(r7.evidence)
    for(const record of evidence.records){record.status='success';record.truncated=false}
    const c=createProcedureCompiler(evidence,r7.trialTask),procedure=validProcedure()
    for(const step of procedure.steps)step.requiresReview=false
    procedure.reviewItems=[]
    const accepted=c.submit({submission:{mode:'distill',procedure}})
    expect(accepted.ok,JSON.stringify(accepted)).toBe(true)
    if(accepted.ok)expect(JSON.parse(accepted.value.procedureJson).reviewItems).toEqual([])
  })
  it('locates unknown procedure fields at the correct nested object',()=>{
    const c=createProcedureCompiler(r7.evidence,r7.trialTask),procedure=validProcedure()
    procedure.unrecognized='remove this annotation'
    const failed=c.submit({submission:{mode:'distill',procedure}});if(failed.ok)throw Error('expected field failure')
    expect(failed.feedback.allowedPaths).toContain('/procedure')
    expect(c.submit({submission:{mode:'repair',draftRevision:1,patches:[{op:'remove',path:'/procedure/unrecognized'}]}}).ok).toBe(true)
  })
  it('repairs all 11 invalid references in one batch while preserving the five business steps',()=>{
    const c=createProcedureCompiler(r7.evidence,r7.trialTask),procedure=JSON.parse(r7.invalidOutput.procedureJson)
    assertObjectJsonSchema(c.schema)
    expect(()=>parseTaskProcedure(procedure,r7.evidence)).toThrow()
    const first=c.submit({submission:{mode:'distill',procedure}});expect(first.ok).toBe(false)
    if(first.ok)throw Error('expected invalid')
    expect(first.feedback.issues).toHaveLength(6)
    const events=new Set(r7.evidence.records.map((r:any)=>r.id)),spec=new Set(taskSpecificationRefs(r7.trialTask)),patches:any[]=[]
    let invalid=0
    for(const [i,step]of procedure.steps.entries()){
      const annotations=step.evidenceRefs.filter((r:string)=>!events.has(r));invalid+=annotations.length
      patches.push({op:'replace',path:`/procedure/steps/${i}/evidenceRefs`,value:step.evidenceRefs.filter((r:string)=>events.has(r))})
      patches.push({op:'add',path:`/procedure/steps/${i}/specRefs`,value:annotations.filter((r:string)=>spec.has(r))})
    }
    for(let i=procedure.excluded.length-1;i>=0;i--)if(procedure.excluded[i].evidenceRefs.some((r:string)=>!events.has(r))){invalid++;patches.push({op:'remove',path:`/procedure/excluded/${i}`})}
    expect(invalid).toBe(11)
    const fixed=c.submit({submission:{mode:'repair',draftRevision:first.feedback.draftRevision,patches}})
    expect(fixed.ok).toBe(true)
    if(!fixed.ok)throw Error(JSON.stringify(fixed.feedback))
    const result=JSON.parse(fixed.value.procedureJson)
    expect(result.steps).toHaveLength(5)
    for(const[i,step]of result.steps.entries()){
      const{evidenceRefs:_,specRefs:__,...business}=step
      const{evidenceRefs:___,...original}=procedure.steps[i]
      expect(business).toEqual(original)
    }
    expect(result.reviewItems).toEqual(procedure.reviewItems)
    expect(()=>parseTaskProcedure(result,r7.evidence,taskSpecificationRefs(r7.trialTask))).not.toThrow()
    result.steps[0].evidenceRefs=[]
    expect(()=>parseTaskProcedure(result,r7.evidence,taskSpecificationRefs(r7.trialTask))).toThrow()
  })
})
