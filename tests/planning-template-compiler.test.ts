import { describe,it,expect } from 'vitest'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertObjectJsonSchema,validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { createTemplateBinding,templateIdForTool,validateTemplateBinding } from '../src/shared/planning-node-templates.ts'
import { exportWorkflowPackage,parseWorkflowPackage } from '../src/shared/workflow-format.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { templateContext,filling } from './fixtures/planning-compiler/template.ts'
import { r28Filling,r28Repair,r28Corrected } from './fixtures/planning-compiler/r28.ts'
import { submissionSchemaIssues } from '../src/shared/planning-submission-schema.ts'
import { templateAuthoringContext,templateGraphContext } from '../src/host/planning/template-catalog.ts'

const accepted=(result:ReturnType<TemplateFillingCompiler['submit']>)=>{if(!result.ok)throw Error(JSON.stringify(result.feedback));return result.value.candidate!}
describe('template filling authoring',()=>{
  it('projects every node template to the supported native SDK schema subset',()=>{
    const binding=createTemplateBinding([]),compiler=new TemplateFillingCompiler(templateContext(),{binding})
    compiler.queryTemplates(binding.templates.map(t=>t.id))
    expect(()=>assertObjectJsonSchema(compiler.nextSchema)).not.toThrow()
  })
  it('uses SDK-compatible typed forms and produces the same canonical graph as compact declarations',()=>{
    const context=templateContext(),wire=filling(),compiler=new TemplateFillingCompiler(context)
    assertObjectJsonSchema(compiler.schema);assertObjectJsonSchema(compiler.nextSchema)
    expect(validateJsonSchemaValue(compiler.nextSchema,wire)).toEqual([])
    const {forms,...rest}=wire.submission
    const compact={submission:{...rest,nodes:forms.map(({template,values,...form}:any)=>({...form,kind:template,config:values}))}}
    const baseline=new WorkflowAuthoringCompiler(context).submit(compact)
    expect(accepted(compiler.submit(wire))).toEqual(accepted(baseline))
    expect(context.workflow.nodes).toHaveLength(2)
  })
  it('collects field errors at filling paths and repairs once without a second submission counter',()=>{
    const observations:any[]=[],compiler=new TemplateFillingCompiler(templateContext(),{onSubmission:s=>observations.push(s)}),wire=filling()
    wire.submission.forms[0].values.fields[0].required='yes';wire.submission.forms[1].values.text=42
    const first=compiler.submit(wire);if(first.ok)throw Error('expected invalid fields')
    expect(first.feedback.issues.map(i=>i.path)).toEqual(['/formsByKey/start/values/fields/0/required','/formsByKey/greet/values/text'])
    const result=compiler.submit({submission:{mode:'repair',draftRevision:1,patches:[
      {op:'replace',path:'/formsByKey/start/values/fields/0/required',value:true},
      {op:'replace',path:'/formsByKey/greet/values/text',value:'你好 {{input.name}}'},
    ]}})
    expect(accepted(result).nodes).toHaveLength(3)
    expect(observations.map(o=>o.attempt)).toEqual([1,2]);expect(compiler.snapshot().submissions).toBe(2)
    expect(()=>compiler.submit(wire)).toThrow('已经接受')
  })
  it('maps graph reference errors back to forms and preserves other fields during repair',()=>{
    const compiler=new TemplateFillingCompiler(templateContext()),wire=filling();wire.submission.forms[1].values.text='{{missing.text}}'
    const first=compiler.submit(wire);if(first.ok)throw Error('expected reference error')
    expect(first.feedback.allowedPaths).toContain('/formsByKey/greet/values')
    const before=compiler.snapshot().document as any
    const graph=accepted(compiler.submit({submission:{mode:'repair',draftRevision:1,patches:[{op:'replace',path:'/formsByKey/greet/values/text',value:'hello'}]}}))
    expect((compiler.snapshot().document as any).formsByKey.start).toEqual(before.formsByKey.start)
    expect(graph.nodes.some(n=>n.id==='allocated-0')).toBe(true)
  })
  it('keeps an invalid patch atomic and rejects stale revisions',()=>{
    const compiler=new TemplateFillingCompiler(templateContext(),{maxSubmissions:5}),wire=filling();wire.submission.forms[1].values.text=42
    compiler.submit(wire);const before=(compiler.snapshot().document as any).formsByKey
    const bad=compiler.submit({submission:{mode:'repair',draftRevision:1,patches:[{op:'replace',path:'/formsByKey/greet/values/text',value:'hello'},{op:'replace',path:'/title',value:'escape'}]}})
    expect(bad.ok).toBe(false);expect((compiler.snapshot().document as any).formsByKey).toEqual(before)
    const stale=compiler.submit({submission:{mode:'repair',draftRevision:999,patches:[{op:'replace',path:'/formsByKey/greet/values/text',value:'hello'}]}})
    expect(stale.ok).toBe(false)
  })
  it('recovers missing forms and duplicated keys without accepting raw config input',()=>{
    const wire=filling(),compiler=new TemplateFillingCompiler(templateContext());wire.submission.forms[1].key='start'
    const result=compiler.submit(wire);expect(result.ok).toBe(false)
    if(result.ok)throw Error('expected duplicate')
    expect(result.feedback.allowedPaths).toContain('/forms')
    const repaired=compiler.submit({submission:{mode:'repair',draftRevision:1,patches:[{op:'replace',path:'/forms/1/key',value:'greet'}]}})
    expect(accepted(repaired).nodes).toHaveLength(3)
    const missing=new TemplateFillingCompiler(templateContext());const bad=filling();delete bad.submission.forms
    const feedback=missing.submit(bad);if(feedback.ok)throw Error('expected missing forms')
    expect(feedback.feedback.allowedPaths).toContain('/formsByKey')
  })
  it('points bare file-write templates at the verified write module (Desktop r34 FILE_WRITE_NEEDS_READ repair)',()=>{
    const tool=(id:string)=>({id,name:id,description:id,providerId:'p',providerName:'p',category:'plugin' as const,available:true,inputSchema:{type:'object' as const,properties:{file_path:{type:'string' as const}},required:['file_path']}})
    const binding=createTemplateBinding([tool('native:write'),tool('native:edit'),tool('native:read')])
    const rules=(id:string)=>binding.templates.find(t=>t.id===templateIdForTool(id))!.rules.join('\n')
    expect(rules('native:write')).toContain('verified-file-write');expect(rules('native:edit')).toContain('FILE_WRITE_NEEDS_READ');expect(rules('native:read')).not.toContain('verified-file-write')
    // Desktop r45: a hand-written read-back check missed the stripped CR of a CRLF file.
    expect(rules('native:read')).toContain('CRLF 文件的 \\r 也已去掉')
    // T18: official tools without known rules go into an Agent node; hand-checked file tools do not.
    const official=createTemplateBinding([tool('native:bash'),tool('native:read')]).templates
    expect(official.find(t=>t.id===templateIdForTool('native:bash'))!.rules.join()).toContain('优先用 Agent 节点')
    expect(official.find(t=>t.id===templateIdForTool('native:read'))!.rules.join()).not.toContain('优先用 Agent 节点')
  })
  it('queries a frozen tool template and fixes its tool ID without accepting override',()=>{
    const context=templateContext();context.tools=[{id:'native:read',name:'读取',description:'读取内容',providerId:'p',providerName:'p',category:'plugin',available:true,inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}]
    const binding=createTemplateBinding(context.tools),id=templateIdForTool('native:read'),compiler=new TemplateFillingCompiler(context,{binding})
    const tool=compiler.queryTemplates([id]).entries[0]!
    expect(tool.fixed).toEqual({toolId:'native:read'});expect(tool.outputs.fields).toHaveProperty('value');expect(tool.outputs.fields).not.toHaveProperty('result')
    tool.fixed.toolId='evil';expect(compiler.queryTemplates([id]).entries[0]!.fixed.toolId).toBe('native:read')
    const wire=filling();wire.submission.forms[1]={key:'greet',template:id,values:{inputs:{path:'{{input.name}}'}}}
    assertObjectJsonSchema(compiler.nextSchema);expect(validateJsonSchemaValue(compiler.nextSchema,wire)).toEqual([])
    const graph=accepted(compiler.submit(wire));expect(graph.nodes.find(n=>n.kind==='tool')!.config.toolId).toBe('native:read')
    const duplicate=filling();duplicate.submission.forms[1]={key:'greet',template:id,values:{toolId:'evil',inputs:{path:'x'}}}
    expect(new TemplateFillingCompiler(context).submit(duplicate).ok).toBe(false)
    expect(()=>compiler.queryTemplates(['missing'])).toThrow('冻结目录')
  })
  it('enforces real tool argument types while allowing compatible dynamic inputs',()=>{
    const context=templateContext();context.tools=[{id:'native:count',name:'计数',description:'计数',providerId:'p',providerName:'p',category:'plugin',available:true,inputSchema:{type:'object',properties:{count:{type:'integer'}},required:['count'],additionalProperties:false}}]
    const wire=filling();wire.submission.forms[1]={key:'greet',template:templateIdForTool('native:count'),values:{inputs:{count:'wrong'}}}
    expect(new TemplateFillingCompiler(context).submit(wire).ok).toBe(false)
    wire.submission.forms[0].values.fields[0].type='number';wire.submission.forms[1].values.inputs.count='{{input.name}}'
    expect(accepted(new TemplateFillingCompiler(context).submit(wire)).nodes).toHaveLength(3)
  })
  it('preserves baseline fields for an edit and rejects fixed or non-target node mutations',()=>{
    const context=templateContext();context.workflow=accepted(new TemplateFillingCompiler(context).submit(filling()));context.workflow.revision=1;context.operation='revise'
    const target=context.workflow.nodes.find(n=>n.kind==='template')!;target.config.cache='never';context.targetNodeIds=[target.id]
    const baseline=structuredClone(context.workflow),compiler=new TemplateFillingCompiler(context)
    const graph=accepted(compiler.submit({submission:{mode:'edit',updates:{n3:{values:{text:'changed'}}},coverage:{R1:['n3']}}}))
    expect(graph.nodes.find(n=>n.id===target.id)!.config.cache).toBe('never')
    expect(graph.nodes.filter(n=>n.id!==target.id)).toEqual(baseline.nodes.filter(n=>n.id!==target.id))
    expect(()=>new TemplateFillingCompiler(context).submit({submission:{mode:'edit',updates:{n1:{values:{fields:[]}}},coverage:{R1:['n1']}}})).toThrow()
  })
  it('keeps scoped loops, roles and Secret declarations in the existing graph contract',()=>{
    const wire=filling();wire.submission.forms[1]={key:'greet',template:'loop',values:{maxIterations:1,initialVariables:{},outputVariable:'inside.text'}}
    wire.submission.forms.push({key:'innerStart',template:'input',scope:['greet'],values:{fields:[]}},{key:'inside',template:'template',scope:['greet'],values:{text:'inside'}},{key:'innerEnd',template:'output',scope:['greet'],values:{text:'{{inside.text}}',outputName:'result'}})
    wire.submission.chains.push({key:'nested',nodes:['innerStart','inside','innerEnd']});wire.submission.environment=[{key:'apiKey',name:'KEY',type:'secret'}]
    const compiler=new TemplateFillingCompiler(templateContext());compiler.queryTemplates(['loop']);assertObjectJsonSchema(compiler.nextSchema)
    const graph=accepted(compiler.submit(wire));expect(graph.nodes.find(n=>n.kind==='loop')!.config.body?.nodes).toHaveLength(3)
    expect(graph.environmentVariables?.[0]?.type).toBe('secret')
  })
  it('rejects a changed or forged template binding and excludes unavailable tools',()=>{
    const context=templateContext(),binding=createTemplateBinding(context.tools);binding.templates[0]!.fixed={toolId:'evil'}
    expect(()=>validateTemplateBinding(binding)).toThrow('摘要')
    const mutated=createTemplateBinding(context.tools);mutated.protocolVersion=2 as any;expect(()=>validateTemplateBinding(mutated)).toThrow()
    const hidden={id:'native:hidden',name:'hidden',description:'Unavailable',providerId:'p',providerName:'p',category:'plugin' as const,available:false,inputSchema:{type:'object'}}
    expect(createTemplateBinding([hidden]).templates.some(t=>t.fixed.toolId===hidden.id)).toBe(false)
  })
  it('permits explicit type replacement and removing obsolete fields via one patch',()=>{
    const context=templateContext();context.workflow=accepted(new TemplateFillingCompiler(context).submit(filling()));context.workflow.revision=1;context.operation='revise'
    const compiler=new TemplateFillingCompiler(context);compiler.queryTemplates(['llm'])
    const wire={submission:{mode:'edit',updates:{n3:{template:'llm',values:{prompt:'Hello'}}},coverage:{R1:['n3']}}}
    assertObjectJsonSchema(compiler.nextSchema);expect(validateJsonSchemaValue(compiler.nextSchema,wire)).toEqual([])
    const first=compiler.submit(wire);if(first.ok)throw Error('old text must be removed explicitly')
    const next=compiler.submit({submission:{mode:'repair',draftRevision:1,patches:[{op:'add',path:'/updates/n3/unset',value:['text']}]}})
    expect(accepted(next).nodes.find(n=>n.id==='allocated-0')!.kind).toBe('llm')
  })
  it('enforces branch ports and preserves explicit true/false routes',()=>{
    const wire=filling();wire.submission.forms[1]={key:'greet',template:'if',values:{variable:'input.name',operator:'contains',value:'yes'}}
    expect(new TemplateFillingCompiler(templateContext()).submit(wire).ok).toBe(false)
    wire.submission.forms[2].values.text='yes';wire.submission.forms.push({key:'otherwise',template:'output',values:{text:'no',outputName:'no'}})
    wire.submission.chains=[{key:'entry',nodes:['start','greet']}]
    wire.submission.links=[{key:'yes',source:'greet',target:'result',port:'true'},{key:'no',source:'greet',target:'otherwise',port:'false'}]
    const graph=accepted(new TemplateFillingCompiler(templateContext()).submit(wire))
    expect(graph.edges.map(e=>e.port).filter(Boolean)).toEqual(['true','false'])
  })
  it('executes a newly composed graph on Graphon with two unseen inputs and no model calls',async()=>{
    const graph=accepted(new TemplateFillingCompiler(templateContext()).submit(filling())),directory=mkdtempSync(join(tmpdir(),'template-fill-graphon-'))
    const storage=new WorkflowStorage(directory),runtime=new WorkflowRuntime(storage,{generate:async()=>{throw Error('No model permitted')}})
    try{
      const saved=storage.save(graph,0)
      for(const name of ['小明','独立样本']){
        const result=await runtime.settle(runtime.start(saved.id,{name}).id)
        expect(result.status).toBe('success');expect(result.outputs).toEqual({result:'你好 '+name})
      }
      expect(()=>parseWorkflowPackage(JSON.stringify(exportWorkflowPackage(graph)))).not.toThrow()
    }finally{await runtime.close();storage.close();rmSync(directory,{recursive:true,force:true})}
  })
  it('uses the same filling names in focused graph views and on-demand graph metadata',()=>{
    const context=templateContext();context.workflow=accepted(new TemplateFillingCompiler(context).submit(filling()));context.operation='revise'
    context.targetNodeIds=[context.workflow.nodes.find(n=>n.kind==='template')!.id]
    const focused=templateAuthoringContext(context,'改写问候').graph!,full=templateGraphContext(context)
    expect(focused.nodes.filter(n=>n.values)).toHaveLength(1)
    expect(full.every(n=>n.template&&n.values&&!Object.hasOwn(n,'config')&&!Object.hasOwn(n,'kind'))).toBe(true)
    for(const node of focused.nodes.filter(n=>n.values))expect(full.find(n=>n.key===node.key)?.values).toEqual(node.values)
  })
  it('supports template queries and accepted graphs over the standalone NDJSON interface',()=>{
    const input=[{context:templateContext(),compilerMode:'template-fill'},{query:{ids:['code']}},filling()].map(value=>JSON.stringify(value)).join('\n')+'\n'
    const child=spawnSync(process.execPath,['--import','tsx','scripts/workflow-compile.ts'],{input,encoding:'utf8',timeout:15000,maxBuffer:2_000_000})
    expect(child.status,child.stderr).toBe(0)
    const rows=child.stdout.trim().split('\n').map(line=>JSON.parse(line))
    expect(rows.map(r=>r.status)).toEqual(['bound','templates','accepted'])
    expect(rows[1].entries[0].id).toBe('code');expect(rows[2].candidate.nodes).toHaveLength(3)
  })
  it('documents if operators as condition values and rejects the r28 extra gte property',()=>{
    const compiler=new TemplateFillingCompiler(templateContext()),entry=compiler.queryTemplates(['if']).entries[0]!
    expect(entry.descriptions.cases).toContain('operator:"gte",value:"1"')
    expect(entry.descriptions.cases).toContain('不能另写 gte:true')
    const condition=(entry.fields as any).properties.cases.items.properties.conditions.items
    expect(Object.keys(condition.properties)).toEqual(['variable','operator','value'])
    expect(condition.properties.operator.enum).toContain('gte');expect(condition.additionalProperties).toBe(false)
    expect(submissionSchemaIssues(compiler.nextSchema,r28Filling())[0]!.message).toContain('conditions[1].gte')
    expect(validateJsonSchemaValue(compiler.nextSchema,r28Corrected())).toEqual([])
    expect(compiler.instructions).toContain('尚无草稿')
  })
  it('returns normal correction diagnostics for r28 schema-invalid create then repair over compiler-cli',()=>{
    const input=[{context:templateContext(),compilerMode:'template-fill'},{query:{ids:['if']}},r28Filling(),r28Repair(),r28Corrected()].map(value=>JSON.stringify(value)).join('\n')+'\n'
    const child=spawnSync(process.execPath,['--import','tsx','scripts/workflow-compile.ts'],{input,encoding:'utf8',timeout:15000,maxBuffer:2_000_000})
    expect(child.status,child.stderr).toBe(0)
    const rows=child.stdout.trim().split('\n').map(line=>JSON.parse(line))
    expect(rows.map(r=>r.status)).toEqual(['bound','templates','repairable','repairable','accepted'])
    expect(rows[2]).toMatchObject({draftRevision:0,remainingSubmissions:2,issues:[{code:'COMPILER_TOOL_SCHEMA_INVALID'}]})
    expect(rows[3]).toMatchObject({draftRevision:0,remainingSubmissions:1,allowedPaths:[],issues:[{code:'PATCH_NO_DRAFT'}]})
    expect(rows[4].candidate.nodes).toHaveLength(3)
  })
  it('keeps compiler-cli at three total submissions after a schema rejection and two draftless repairs',()=>{
    const input=[{context:templateContext(),compilerMode:'template-fill'},{query:{ids:['if']}},r28Filling(),r28Repair(),r28Repair(1),r28Corrected()].map(value=>JSON.stringify(value)).join('\n')+'\n'
    const child=spawnSync(process.execPath,['--import','tsx','scripts/workflow-compile.ts'],{input,encoding:'utf8',timeout:15000,maxBuffer:2_000_000})
    expect(child.status,child.stderr).toBe(1)
    const rows=child.stdout.trim().split('\n').map(line=>JSON.parse(line))
    expect(rows.map(r=>r.status)).toEqual(['bound','templates','repairable','repairable','failed'])
    expect(rows.at(-1).code).toBe('PLANNING_REPAIR_STALLED')
  })
})
