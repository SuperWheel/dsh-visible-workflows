import { describe,expect,it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { templateAuthoringContext,planningTemplateCatalog,prefetchedTemplateIds,REHEARSAL_TEMPLATE_KINDS } from '../src/host/planning/template-catalog.ts'
import { queryWorkflowSemantics } from '../src/shared/workflow-semantics.ts'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { renderDataTemplate } from '../src/host/template.ts'
import type { JsonValue } from '../src/shared/types.ts'
import { templateContext,filling } from './fixtures/planning-compiler/template.ts'
function focused(kind:'template'|'code'='template',fields=['text']){
  const context=templateContext(),created=new TemplateFillingCompiler(context).submit(filling())
  if(!created.ok)throw Error('Fixture compilation failed')
  context.workflow=created.value.candidate!;context.workflow.revision=1;context.operation='revise'
  const target=context.workflow.nodes.find(node=>node.kind==='template')!
  if(kind==='code'){
    target.kind='code';target.config={language:'javascript',code:'function main() { return {normalized:"PENDING"}; }',inputs:{name:'{{input.name}}'},outputSchema:[{name:'normalized',type:'string',required:true}],timeoutMs:5000}
    context.workflow.nodes.find(node=>node.kind==='output')!.config.text=`{{${target.id}.normalized}}`
  }
  context.targetNodeIds=[target.id];context.contextSelection={targetNodeIds:[target.id],targetFields:{[target.id]:fields}}
  return {context,target}
}
describe('operation-scoped template runtime semantics',()=>{
  it('supplies the exact same-source template grammar including default rules and all rendering examples',()=>{
    const {context}=focused(),prompt=templateAuthoringContext(context,'仅补text')
    const source=queryWorkflowSemantics({kinds:['template'],includeSchema:false})
    expect(prompt.runtimeSemantics).toEqual(source)
    const node=prompt.runtimeSemantics!.nodes[0]!
    expect(node).not.toHaveProperty('schema');expect(Object.keys(node.syntax!.filters)).toHaveLength(11)
    expect(node.syntax!.filters.default).toContain('第二参数 true');expect(node.syntax!.examples).toHaveLength(4)
    for(const example of node.syntax!.examples){
      const result=renderDataTemplate(example.config.text,name=>{
        const parts=name.split('.');let value:unknown={input:example.input}
        for(const part of parts)value=value&&typeof value==='object'?(value as Record<string,unknown>)[part]:undefined
        return value as JsonValue
      })
      expect(result).toBe(example.expected)
    }
    expect(prompt.templateAccess).toContain('runtimeSemantics.nodes');expect(prompt.templateAccess).toContain('planner_node_templates');expect(prompt.templateAccess).not.toContain('planner_node_catalog')
  })
  it('does not reintroduce unrelated large-graph configs or runtime kinds into a field task',()=>{
    const {context}=focused()
    for(let i=0;i<28;i++)context.workflow.nodes.push({id:`unrelated-${i}`,number:String(i+4),kind:'llm',title:`Unrelated ${i}`,x:0,y:0,fixed:false,config:{prompt:`NEVER_RETURN_UNRELATED_${i}`}})
    const prompt=templateAuthoringContext(context,'仅补text'),serialized=JSON.stringify(prompt)
    expect(context.workflow.nodes).toHaveLength(31)
    expect(prompt.runtimeSemantics!.nodes.map(node=>node.kind)).toEqual(['template'])
    expect(prompt.runtimeSemantics).not.toHaveProperty('nodeIndex');expect(prompt.graph!.nodes.length).toBeLessThan(4)
    expect(serialized).not.toContain('NEVER_RETURN_UNRELATED');expect(serialized).not.toContain('Unrelated 27')
  })
  it('restores necessary code input/return/runtime limits without importing template syntax',()=>{
    const {context}=focused('code',['code']),prompt=templateAuthoringContext(context,'仅补code')
    expect(prompt.runtimeSemantics).toEqual(queryWorkflowSemantics({kinds:['code'],includeSchema:false}))
    const code=prompt.runtimeSemantics!.nodes[0]!
    expect(code.purpose).toContain('同步 main(inputs)');expect(code.fields.code).toContain('不展开 {{变量}}')
    expect(code.outputs['<main 返回对象的键>']).toContain('不会自动添加 result 或 text')
    expect(code.rules.join(' ')).toContain('异步 Promise');expect(code).not.toHaveProperty('syntax');expect(code).not.toHaveProperty('schema')
  })
  it('keeps title-only tasks free of runtime grammar and preserves focused field permissions after metadata queries',()=>{
    expect(templateAuthoringContext(focused('template',['title']).context,'只改名').runtimeSemantics).toBeUndefined()
    const {context}=focused(),compiler=new TemplateFillingCompiler(context),before=structuredClone(compiler.nextSchema)
    templateAuthoringContext(context,'仅补text');compiler.queryTemplates(['code'])
    expect(compiler.nextSchema).toEqual(before)
    for(const change of [{title:'escape'},{template:'code',values:{code:'escape'}},{values:{inputs:{name:'escape'}}}])
      expect(validateJsonSchemaValue(compiler.nextSchema,{submission:{mode:'edit',updates:{n3:change},coverage:{R1:['n3']}}}).length).toBeGreaterThan(0)
    expect(validateJsonSchemaValue(compiler.nextSchema,{submission:{mode:'edit',updates:{n3:{values:{text:'Hello {{input.name}}'}}},coverage:{R1:['n3']}}})).toEqual([])
  })
  it('retains necessary create semantics and schema-valid existing forms',()=>{
    const context=templateContext(),prompt=templateAuthoringContext(context,'使用代码计算，再用模板输出')
    expect(prompt.graph).toBeUndefined()
    expect(prompt.runtimeSemantics!.nodes.map(node=>node.kind)).toEqual(expect.arrayContaining(['input','output','template','code']))
    expect(prompt.runtimeSemantics!.nodes.find(node=>node.kind==='template')!.syntax).toEqual(queryWorkflowSemantics({kinds:['template']}).nodes![0]!.syntax)
    expect(prompt.runtimeSemantics!.nodes.every(node=>!Object.hasOwn(node,'schema'))).toBe(true)
    expect(validateJsonSchemaValue(new TemplateFillingCompiler(context).nextSchema,filling())).toEqual([])
  })
  it('prefetches rehearsal check kinds with their runtime semantics for trial-backed authoring (Desktop r28)',()=>{
    const context=templateContext(),instruction='抓取网页，提取列表后写入文件并回读'
    const kinds=(ids:string[])=>new Set(planningTemplateCatalog(context).templates.filter(template=>ids.includes(template.id)).map(template=>template.kind))
    expect(kinds(prefetchedTemplateIds(planningTemplateCatalog(context),context,instruction)).has('if')).toBe(false)
    const ids=prefetchedTemplateIds(planningTemplateCatalog(context),context,instruction,REHEARSAL_TEMPLATE_KINDS)
    for(const kind of REHEARSAL_TEMPLATE_KINDS)expect(kinds(ids).has(kind)).toBe(true)
    expect(templateAuthoringContext(context,instruction,REHEARSAL_TEMPLATE_KINDS).runtimeSemantics!.nodes.map(node=>node.kind)).toEqual(expect.arrayContaining([...REHEARSAL_TEMPLATE_KINDS]))
  })
  it('locally batches more than five explicitly acquired create kinds without truncation or duplicate schemas',()=>{
    const context=templateContext();context.contextSelection={templateIds:['code','http','llm','if','iteration','loop']}
    const binding=planningTemplateCatalog(context),ids=prefetchedTemplateIds(binding,context,'按明确类型创建'),prompt=templateAuthoringContext(context,'按明确类型创建')
    const expected=[...new Set(binding.templates.filter(template=>ids.includes(template.id)||context.contextSelection!.templateIds!.includes(template.id)).map(template=>template.kind))]
    expect(prompt.runtimeSemantics!.nodes.map(node=>node.kind)).toEqual(expected)
    expect(expected.length).toBeGreaterThan(5);expect(prompt.runtimeSemantics!.nodes.every(node=>!Object.hasOwn(node,'schema'))).toBe(true)
  })
})
