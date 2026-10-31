import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { templateIdForTool } from '../src/shared/planning-node-templates.ts'
import { planningCandidateIssues } from '../src/shared/planning-projection.ts'
import { WorkflowPlanningService, type PlanningCaller, type PlanningTask } from '../src/host/planning/service.ts'
import { ModelAdmission } from '../src/host/run-usage.ts'
import { templateContext, filling } from './fixtures/planning-compiler/template.ts'

const directories:string[]=[]
afterEach(()=>{for(const dir of directories.splice(0))rmSync(dir,{recursive:true,force:true})})
const caller={parent:{id:'session'},sessionId:'session',workspaceId:'workspace',signal:new AbortController().signal} as PlanningCaller
function serviceFixture(){
  const directory=mkdtempSync(join(tmpdir(),'planning-freeze-regression-'));directories.push(directory)
  const context=templateContext()
  context.tools=[{id:'audit:constructor',name:'audit',description:'offline',providerId:'audit',providerName:'audit',category:'swagger',available:true,inputSchema:{type:'object',properties:{body:{type:'object',properties:{constructor:{type:'string'}}}}}}]
  const generate=vi.fn(async()=>{throw Error('Unexpected model call')})
  const options:ConstructorParameters<typeof WorkflowPlanningService>[0]={directory,compilerMode:'template-fill',admission:new ModelAdmission(1,1),driver:{generate},context:async()=>context,authorize:()=>{},readiness:async flow=>({workflowId:flow.id,revision:flow.revision,canRun:true,issues:[]}),publish:async()=>{throw Error('Unexpected publish')},receipt:()=>undefined}
  const file=join(directory,'planning','tasks.json')
  return {options,generate,file,context}
}
describe('planning backend audit regressions',()=>{
  it('explains reserved input keys consistently and permits an explicit rename repair',()=>{
    const wire=filling();wire.submission.forms[0].key='input';wire.submission.chains[0].nodes[0]='input';wire.submission.coverage.R1.unshift('input')
    const compiler=new TemplateFillingCompiler(templateContext()),schema:any=compiler.nextSchema
    const create=schema.properties.submission.oneOf[0],form=create.properties.forms.items.oneOf[0]
    const descriptions=[form.properties.key.description,create.properties.chains.items.properties.nodes.items.description,create.properties.coverage.properties.R1.items.description].filter((text):text is string=>typeof text==='string')
    expect(descriptions).toHaveLength(1) // S4 keeps the first shared key description; validation and repair are unchanged.
    for(const description of descriptions){expect(description).toContain('start');expect(description).toContain('result');expect(description).toContain('input');expect(description).toContain('40')}
    // Desktop planner tool/result seq 24 then 30: first repair corrected shape,
    // leaving reserved input at forms/chains/coverage with one submission left.
    const malformed=structuredClone(wire);delete malformed.submission.title;malformed.submission.forms.push('links');malformed.submission.source='input';malformed.submission.target='greet'
    const shape=compiler.submit(malformed);if(shape.ok)throw Error('Malformed declaration accepted')
    // Title is explicitly repaired along with shape; the Host never invents it.
    const failed=compiler.submit({submission:{mode:'repair',draftRevision:shape.feedback.draftRevision,patches:[{op:'replace',path:'/forms',value:wire.submission.forms},{op:'remove',path:'/source'},{op:'remove',path:'/target'},{op:'add',path:'/title',value:wire.submission.title}]}})
    if(failed.ok)throw Error('Reserved input key accepted')
    expect(failed.feedback.draftRevision).toBe(2);expect(failed.feedback.remainingSubmissions).toBe(1)
    for(const path of ['/formsByKey/input','/chainsByKey/main/nodes/0','/coverage/R1/0']){
      const issue=failed.feedback.issues.find(issue=>issue.path===path)
      expect(issue?.message).toContain('input');expect(issue?.message).toContain('保留词')
    }
    expect((compiler.snapshot().document as any).formsByKey.input).toBeDefined()
    const input=(compiler.snapshot().document as any).formsByKey.input
    expect(compiler.submit({submission:{mode:'repair',draftRevision:failed.feedback.draftRevision,patches:[{op:'remove',path:'/formsByKey/input'},{op:'add',path:'/formsByKey/start',value:input},{op:'replace',path:'/chainsByKey/main/nodes/0',value:'start'},{op:'replace',path:'/coverage/R1/0',value:'start'}]}}).ok).toBe(true)
  })
  it('freezes context and template binding atomically and can reopen a freeze failure',async()=>{
    const f=serviceFixture(),service=new WorkflowPlanningService(f.options)
    const failed=await service.start({requestId:'atomic-freeze',operation:'create',instruction:'输入文字并输出'},caller)
    await service.close()
    expect(failed.state).toBe('failed');expect(f.generate).not.toHaveBeenCalled()
    expect(failed.context).toBeUndefined();expect(failed.templateBinding).toBeUndefined()
    const reopened=new WorkflowPlanningService(f.options)
    try{expect(reopened.get(failed.id,caller).state).toBe('failed')}finally{await reopened.close()}
  })
  it('recovers only historical pre-child freeze failures, retaining strict candidate records',async()=>{
    const f=serviceFixture(),service=new WorkflowPlanningService(f.options)
    const failed=await service.start({requestId:'historical-freeze',operation:'create',instruction:'输入文字并输出'},caller)
    await service.close()
    const raw=JSON.parse(readFileSync(f.file,'utf8')) as {tasks:PlanningTask[]}
    // The historical Host had no entry-selection metadata and froze this mode
    // before assigning the incomplete context.
    delete raw.tasks[0]!.compilerSelection;raw.tasks[0]!.compilerMode='template-fill'
    raw.tasks[0]!.context=f.context
    writeFileSync(f.file,JSON.stringify(raw))
    const reopened=new WorkflowPlanningService(f.options)
    try{const recovered=reopened.get(failed.id,caller);expect(recovered.state).toBe('failed');expect(recovered.context).toBeUndefined();expect(JSON.parse(readFileSync(f.file,'utf8')).tasks[0].context).toBeUndefined()}finally{await reopened.close()}
    // The exception cannot be used to load a task that already reached a child/candidate phase.
    for(const field of ['childAttempts','candidateAttempts'] as const){
      raw.tasks[0]![field]=1;writeFileSync(f.file,JSON.stringify(raw))
      expect(()=>new WorkflowPlanningService(f.options)).toThrow('冻结快照')
      raw.tasks[0]![field]=0
    }
    raw.tasks[0]!.state='ready';writeFileSync(f.file,JSON.stringify(raw))
    expect(()=>new WorkflowPlanningService(f.options)).toThrow('冻结快照')
  })
  it('discards a legacy incomplete context before semantic validation only for an empty failed freeze',async()=>{
    const f=serviceFixture(),service=new WorkflowPlanningService(f.options)
    const failed=await service.start({requestId:'historical-invalid-context',operation:'create',instruction:'输入文字并输出'},caller)
    await service.close()
    const raw=JSON.parse(readFileSync(f.file,'utf8')) as {tasks:PlanningTask[]}
    delete raw.tasks[0]!.compilerSelection;raw.tasks[0]!.compilerMode='template-fill'
    // The old assignment preceded validateContext too, so even a duplicate pool
    // could be saved on a failed task with no template binding or child activity.
    raw.tasks[0]!.context={...f.context,nodeIds:['duplicate','duplicate']}
    writeFileSync(f.file,JSON.stringify(raw))
    const reopened=new WorkflowPlanningService(f.options)
    try{expect(reopened.get(failed.id,caller).context).toBeUndefined()}finally{await reopened.close()}
    expect(JSON.parse(readFileSync(f.file,'utf8')).tasks[0].context).toBeUndefined()
    raw.tasks[0]!.childAttempts=1;writeFileSync(f.file,JSON.stringify(raw))
    expect(()=>new WorkflowPlanningService(f.options)).toThrow('冻结快照')
  })
  for(const count of [1,60])for(const mode of ['template-fill','compact-repair'] as const){
    it(`reclaims removed draft keys while preserving remaining IDs (${mode}, ${count})`,()=>{
      const context=templateContext();context.nodeIds=[...context.workflow.nodes.map(n=>n.id),...Array.from({length:count},(_,i)=>'new-'+i)]
      const wire=filling(),nodes=Array.from({length:count},(_,i)=>({key:'step'+i,template:'template',values:{text:'step '+i}}))
      wire.submission.forms=[wire.submission.forms[0],...nodes,wire.submission.forms[2]]
      wire.submission.forms.at(-1).values.text='{{step'+(count-1)+'.text}}'
      wire.submission.chains=[{key:'main',nodes:['start',...nodes.map(n=>n.key),'result']}]
      // A whole-graph cycle is diagnosed after identity allocation and permits
      // rewriting these draft roots. A precise branch preflight error does
      // neither, so it cannot exercise full-pool reclamation through repair.
      wire.submission.chains.push({key:'cycle',nodes:['result','step0']})
      wire.submission.coverage={R1:[nodes.at(-1)!.key,'result']}
      wire.submission.roles=[{key:'obsoleteRole',name:'Role',prompt:'Offline'}]
      wire.submission.environment=[{key:'obsoleteEnv',name:'TOKEN',type:'secret'}]
      const compact=(value:any)=>{const {forms,...rest}=value.submission;return {submission:{...rest,nodes:forms.map(({template,values,...row}:any)=>({...row,kind:template,config:values}))}}}
      const make=()=>mode==='template-fill'?new TemplateFillingCompiler(context):new WorkflowAuthoringCompiler(context)
      const compiler=make(),failed=compiler.submit(mode==='template-fill'?wire:compact(wire))
      if(failed.ok)throw Error('Expected graph-cycle failure')
      expect(failed.feedback.issues.some(i=>i.code==='INVALID_GRAPH'&&i.message.includes('循环'))).toBe(true)
      const root=mode==='template-fill'?'formsByKey':'nodesByKey'
      for(const path of ['/'+root,'/chainsByKey','/linksByKey','/coverage','/rolesByKey','/environmentByKey'])expect(failed.feedback.allowedPaths).toContain(path)
      const restoredDraft=make(),restoredFailure=restoredDraft.submit({submission:JSON.parse(JSON.stringify(compiler.snapshot().document))})
      expect(restoredFailure.ok).toBe(false)
      const final=structuredClone(wire)
      final.submission.forms[1]={key:'replacement',template:'template',values:{text:'hello'}}
      final.submission.roles[0].key='replacementRole';final.submission.environment[0].key='replacementEnv'
      if(count>1)final.submission.forms=[final.submission.forms[0],final.submission.forms[1],...final.submission.forms.slice(2,-1).reverse(),final.submission.forms.at(-1)]
      final.submission.chains[0].nodes[1]='replacement'
      if(count===1){final.submission.forms.at(-1).values.text='{{replacement.text}}';final.submission.coverage.R1[0]='replacement'}
      const normalized=Object.fromEntries((mode==='template-fill'?final.submission.forms:compact(final).submission.nodes).map(({key,...rest}:any)=>[key,rest]))
      const repair={submission:{mode:'repair',draftRevision:failed.feedback.draftRevision,patches:[{op:'replace',path:'/'+root,value:normalized},{op:'replace',path:'/chainsByKey/main/nodes',value:final.submission.chains[0].nodes},{op:'remove',path:'/chainsByKey/cycle'},{op:'replace',path:'/coverage/R1',value:final.submission.coverage.R1},{op:'replace',path:'/rolesByKey',value:{replacementRole:{name:'Role',prompt:'Offline'}}},{op:'replace',path:'/environmentByKey',value:{replacementEnv:{name:'TOKEN',type:'secret'}}}]}}
      const repaired=compiler.submit(repair)
      expect(restoredDraft.submit(repair).ok).toBe(true)
      expect(repaired.ok).toBe(true)
      if(!repaired.ok)throw Error(JSON.stringify(repaired.feedback))
      expect(repaired.value.candidate!.nodes.find(n=>n.config.text==='hello')!.id).toBe('new-0')
      expect(repaired.value.candidate!.subAgents![0]!.id).toBe('role-1');expect(repaired.value.candidate!.environmentVariables![0]!.id).toBe('env-1')
      for(let i=1;i<count;i++)expect(repaired.value.candidate!.nodes.find(n=>n.config.text==='step '+i)!.id).toBe('new-'+i)
      // Stored documents carry declarations, not committed IDs. Rebinding the saved final draft is valid.
      const saved=JSON.parse(JSON.stringify(compiler.snapshot().document)),restored=make()
      const rows=saved[root];delete saved[root]
      saved[mode==='template-fill'?'forms':'nodes']=Object.entries(rows).map(([key,value]:[string,any])=>({key,...value}))
      expect(restored.submit({submission:saved}).ok).toBe(true)
    })
  }
  for(const field of [{type:'string',enum:['safe']},{type:'string',const:'safe'},{oneOf:[{type:'integer'},{type:'boolean'}]},{oneOf:[{type:'string',const:'safe'},{type:'string',const:'other'}]},{oneOf:[{oneOf:[{type:'integer',const:1},{type:'boolean'}]},{type:'number',const:2.5}]}]){
    it(`offers references without weakening literals for ${JSON.stringify(field)}`,()=>{
      const context=templateContext();context.tools=[{id:'native:audit',name:'audit',description:'Offline',providerId:'p',providerName:'p',category:'plugin',available:true,inputSchema:{type:'object',properties:{value:field},required:['value'],additionalProperties:false}}] as any
      const compiler=new TemplateFillingCompiler(context),wire=filling(),id=templateIdForTool('native:audit');compiler.queryTemplates([id])
      if('oneOf' in field)wire.submission.forms[0].values.fields[0].type='number'
      if(field.oneOf?.[0]?.type==='string')wire.submission.forms[0].values.fields[0].type='text'
      wire.submission.forms[1]={key:'greet',template:id,values:{inputs:{value:'{{input.name}}'}}}
      assertObjectJsonSchema(compiler.nextSchema)
      expect(validateJsonSchemaValue(compiler.nextSchema,wire)).toEqual([])
      expect(compiler.submit(wire).ok).toBe(true)
      const invalid=new TemplateFillingCompiler(context);invalid.queryTemplates([id])
      wire.submission.forms[1].values.inputs.value='wrong'
      expect(invalid.submit(wire).ok).toBe(false)
      const literal=new TemplateFillingCompiler(context);literal.queryTemplates([id])
      wire.submission.forms[1].values.inputs.value=field.oneOf&&field.oneOf[0]?.type!=='string'?true:'safe'
      expect(validateJsonSchemaValue(literal.nextSchema,wire)).toEqual([])
      expect(literal.submit(wire).ok).toBe(true)
    })
  }
  for(const mode of ['template-fill','compact-repair'] as const)for(const field of [{type:'string',const:'safe'},{type:'string',enum:['safe']}]){
    it(`rejects malformed dynamic arguments across compiler and final validation (${mode}, ${JSON.stringify(field)})`,()=>{
      const context=templateContext();context.tools=[{id:'native:syntax',name:'syntax',description:'Offline',providerId:'p',providerName:'p',category:'plugin',available:true,inputSchema:{type:'object',properties:{value:field},required:['value'],additionalProperties:true}}] as any
      const wire=filling();wire.submission.forms[1]={key:'greet',template:templateIdForTool('native:syntax'),values:{inputs:{value:'safe'}}}
      const compact=(value:any)=>{const {forms,...rest}=value.submission;return {submission:{...rest,nodes:forms.map(({template,values,...row}:any)=>({...row,kind:template.startsWith('tool-')?'tool':template,config:template.startsWith('tool-')?{...values,toolId:'native:syntax'}:values}))}}}
      const make=()=>mode==='template-fill'?new TemplateFillingCompiler(context):new WorkflowAuthoringCompiler(context)
      const valid=make().submit(mode==='template-fill'?wire:compact(wire));if(!valid.ok)throw Error(JSON.stringify(valid.feedback))
      for(const value of ['wrong{{','wrong{{}}','{{ }}','{{input.name','input.name}}','{{input.name}} trailing{{']){
        const bad=structuredClone(wire);bad.submission.forms[1].values.inputs.value=value
        const compiler=make(),failed=compiler.submit(mode==='template-fill'?bad:compact(bad))
        expect(failed.ok,value).toBe(false)
        if(failed.ok)throw Error('Malformed interpolation accepted')
        const root=mode==='template-fill'?'formsByKey/greet/values':'nodesByKey/greet/config'
        expect(compiler.submit({submission:{mode:'repair',draftRevision:failed.feedback.draftRevision,patches:[{op:'replace',path:'/'+root+'/inputs/value',value:'safe'}]}}).ok).toBe(true)
        const graph=structuredClone(valid.value.candidate!);graph.nodes.find(n=>n.kind==='tool')!.config.inputs!.value=value
        expect(planningCandidateIssues(graph,context).some(issue=>issue.code==='INVALID_TOOL_ARGUMENTS'||issue.code==='INVALID_REFERENCE'),value).toBe(true)
      }
      // A valid token must not hide a malformed sibling in an open/nested argument.
      const nested=structuredClone(wire);nested.submission.forms[1].values.inputs={value:'{{input.name}}',extra:{rows:['wrong{{']}}
      expect(make().submit(mode==='template-fill'?nested:compact(nested)).ok).toBe(false)
      const dynamic=structuredClone(wire);dynamic.submission.forms[1].values.inputs.value='prefix {{input.name}} suffix'
      expect(make().submit(mode==='template-fill'?dynamic:compact(dynamic)).ok).toBe(true)
    })
  }
})
