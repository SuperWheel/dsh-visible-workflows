import { describe, expect, it } from 'vitest'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { planningContextSlice } from '../src/shared/planning-context-slice.ts'
import { planningTemplateCatalog, prefetchedTemplateIds } from '../src/host/planning/template-catalog.ts'
import { filling, templateContext } from './fixtures/planning-compiler/template.ts'

function focused(fields=['text']) {
  const context=templateContext(),created=new TemplateFillingCompiler(context).submit(filling())
  if(!created.ok)throw Error('Fixture compilation failed')
  context.workflow=created.value.candidate!;context.workflow.revision=1;context.operation='revise'
  const target=context.workflow.nodes.find(node=>node.kind==='template')!
  context.targetNodeIds=[target.id]
  context.contextSelection={targetNodeIds:[target.id],targetFields:{[target.id]:fields}}
  return {context,target}
}
const edit=(change:unknown)=>({submission:{mode:'edit',updates:{n3:change},coverage:{R1:['n3']}}})
const initial=(compiler:TemplateFillingCompiler)=>(compiler.nextSchema.properties!.submission as any).oneOf[0]

describe('operation-specific template field schema',()=>{
  it('exposes only the explicit field slot and keeps the fixed native upper bound',()=>{
    const {context,target}=focused(),compiler=new TemplateFillingCompiler(context)
    assertObjectJsonSchema(compiler.schema);assertObjectJsonSchema(compiler.nextSchema)
    expect(Object.keys(initial(compiler).properties).sort()).toEqual(['assumptions','coverage','mode','summary','updates'])
    expect(Object.keys(initial(compiler).properties.updates.properties)).toEqual(['n3'])
    expect(initial(compiler).properties.updates.properties.n3.properties.values.properties).toEqual({text:expect.any(Object)})
    expect((compiler.schema.properties!.submission as any).oneOf[0].properties).toHaveProperty('addForms')
    const wire=edit({values:{text:'Focused replacement'}})
    expect(validateJsonSchemaValue(compiler.nextSchema,wire)).toEqual([])
    const result=compiler.submit(wire);if(!result.ok)throw Error(JSON.stringify(result.feedback))
    expect(result.value.candidate!.nodes.find(node=>node.id===target.id)!.config.text).toBe('Focused replacement')
  })

  it('does not acquire type, topology or other-field slots from read-only template queries',()=>{
    const {context}=focused(),compiler=new TemplateFillingCompiler(context),before=structuredClone(compiler.nextSchema)
    compiler.queryTemplates(['llm','code','if','loop'])
    expect(compiler.nextSchema).toEqual(before);assertObjectJsonSchema(compiler.nextSchema)
    for(const change of [{title:'Unrequested'},{template:'llm',values:{prompt:'Escape'}},{values:{cache:'always'}},{unset:['cache']}])
      expect(validateJsonSchemaValue(compiler.nextSchema,edit(change)).length).toBeGreaterThan(0)
    for(const extra of [{addForms:[]},{addLinks:[]},{removeNodes:[]},{addRoles:[]},{addEnvironment:[]},{title:'Workflow title'}])
      expect(validateJsonSchemaValue(compiler.nextSchema,{submission:{...edit({values:{text:'ok'}}).submission,...extra}}).length).toBeGreaterThan(0)
  })

  it('keeps explicit output dependency reads without widening known field or prefetch slots',()=>{
    const {context}=focused(),before=new TemplateFillingCompiler(context).nextSchema
    context.contextSelection!.outputChanged=true
    const output=context.workflow.nodes.find(node=>node.kind==='output')!
    expect(planningContextSlice(context).readNodeIds).toContain(output.id)
    const binding=planningTemplateCatalog(context),ids=prefetchedTemplateIds(binding,context,'模型选择、HTTP和人工确认都是元描述')
    for(const id of ['llm','http','human'])expect(ids).not.toContain(id)
    expect(new TemplateFillingCompiler(context,{binding,prefetch:ids}).nextSchema).toEqual(before)
  })

  it('permits title only when explicitly selected, including a title-only task',()=>{
    const {context}=focused(['title']),compiler=new TemplateFillingCompiler(context)
    expect(Object.keys(initial(compiler).properties.updates.properties.n3.properties)).toEqual(['title'])
    expect(validateJsonSchemaValue(compiler.nextSchema,edit({title:'Approved label'}))).toEqual([])
    expect(validateJsonSchemaValue(compiler.nextSchema,edit({values:{text:'No'}})).length).toBeGreaterThan(0)
    expect(compiler.submit(edit({title:'Approved label'})).ok).toBe(true)
    const mixed=new TemplateFillingCompiler(focused(['title','config.text']).context)
    expect(validateJsonSchemaValue(mixed.nextSchema,edit({title:'New label',values:{text:'New text'}}))).toEqual([])
    assertObjectJsonSchema(mixed.nextSchema)
  })

  it('fills an authorized field absent from the current node while preserving its other configuration',()=>{
    const {context,target}=focused();delete target.config.text;target.config.cache='never'
    const compiler=new TemplateFillingCompiler(context),wire=edit({values:{text:'New required field'}})
    expect(validateJsonSchemaValue(compiler.nextSchema,wire)).toEqual([])
    const result=compiler.submit(wire);if(!result.ok)throw Error(JSON.stringify(result.feedback))
    expect(result.value.candidate!.nodes.find(node=>node.id===target.id)!.config).toEqual({text:'New required field',cache:'never'})
  })

  it('retains create, unfocused revise, incomplete target selections and explicit type/topology editing',()=>{
    const create=new TemplateFillingCompiler(templateContext())
    expect(initial(create).properties).toHaveProperty('forms');expect(initial(create).properties).toHaveProperty('chains')
    expect(validateJsonSchemaValue(create.nextSchema,filling())).toEqual([])
    const {context}=focused();delete context.contextSelection
    expect(initial(new TemplateFillingCompiler(context)).properties).toHaveProperty('addForms')
    const incomplete=focused();incomplete.context.targetNodeIds=incomplete.context.workflow.nodes.map(node=>node.id)
    incomplete.context.contextSelection!.targetNodeIds=incomplete.context.targetNodeIds
    expect(initial(new TemplateFillingCompiler(incomplete.context)).properties).toHaveProperty('addForms')
    for(const selection of [{templateIds:['llm']},{topologyChanged:true},{targetFields:{[focused().target.id]:['kind']}}]){
      const item=focused();item.context.contextSelection={...item.context.contextSelection!,...selection}
      const compiler=new TemplateFillingCompiler(item.context);compiler.queryTemplates(['llm'])
      assertObjectJsonSchema(compiler.nextSchema);expect(initial(compiler).properties).toHaveProperty('addForms')
    }
    const typed=focused();typed.context.contextSelection!.templateIds=['llm']
    const compiler=new TemplateFillingCompiler(typed.context)
    expect(validateJsonSchemaValue(compiler.nextSchema,edit({template:'llm',values:{prompt:'Hello'},unset:['text']}))).toEqual([])
  })

  it('keeps repair paths and full graph checks after a focused field failure',()=>{
    const {context,target}=focused(),compiler=new TemplateFillingCompiler(context)
    const invalid=compiler.submit(edit({values:{text:42}}));if(invalid.ok)throw Error('Expected typed field error')
    assertObjectJsonSchema(compiler.nextSchema)
    expect(invalid.feedback.issues.some(issue=>issue.path==='/updates/n3/values/text')).toBe(true)
    const escape=compiler.submit({submission:{mode:'repair',draftRevision:1,patches:[{op:'replace',path:'/addForms/new/values/text',value:'escape'}]}})
    expect(escape.ok).toBe(false)
    const repaired=compiler.submit({submission:{mode:'repair',draftRevision:1,patches:[{op:'replace',path:'/updates/n3/values/text',value:'Repaired'}]}})
    expect(repaired.ok).toBe(true)
    if(repaired.ok)expect(repaired.value.candidate!.nodes.find(node=>node.id===target.id)!.config.text).toBe('Repaired')
    const reference=new TemplateFillingCompiler(context).submit(edit({values:{text:'{{missing.text}}'}}))
    expect(reference.ok).toBe(false)
  })

  it('keeps real multi-field type replacement compatible after field focus is explicitly disabled',()=>{
    for(const reason of ['template','topology','kind','incomplete'] as const){
      const {context,target}=focused(['prompt']);target.kind='llm';target.config={prompt:'Before',model:{provider:'offline',model:'fixed'}}
      const selection=context.contextSelection!
      if(reason==='template')selection.templateIds=['template']
      if(reason==='topology')selection.topologyChanged=true
      if(reason==='kind')selection.targetFields![target.id]=['kind']
      if(reason==='incomplete')selection.targetNodeIds=[target.id,context.workflow.nodes[0]!.id]
      const compiler=new TemplateFillingCompiler(context);compiler.queryTemplates(['template'])
      const wire=edit({template:'template',values:{text:'After'},unset:['prompt','model']})
      assertObjectJsonSchema(compiler.nextSchema)
      expect(validateJsonSchemaValue(compiler.nextSchema,wire)).toEqual([])
      const result=compiler.submit(wire);if(!result.ok)throw Error(JSON.stringify(result.feedback))
      const changed=result.value.candidate!.nodes.find(node=>node.id===target.id)!
      expect(changed.kind).toBe('template');expect(changed.config).toEqual({text:'After'})
    }
  })
})
