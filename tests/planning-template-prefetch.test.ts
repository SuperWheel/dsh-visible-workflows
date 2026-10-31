import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { prefetchedTemplateIds, planningTemplateCatalog, templateAuthoringContext } from '../src/host/planning/template-catalog.ts'
import { templateIdForTool } from '../src/shared/planning-node-templates.ts'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import type { ToolChoice } from '../src/shared/types.ts'
import { templateContext, filling } from './fixtures/planning-compiler/template.ts'

const tool=(id:string,name=id):ToolChoice=>({id,name,description:'Offline test tool',providerId:'p',providerName:'p',category:'plugin',available:true,inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}})
function focusedCode(){
  const context=templateContext(),created=new TemplateFillingCompiler(context).submit(filling())
  if(!created.ok)throw Error('Fixture compilation failed')
  context.workflow=created.value.candidate!;context.workflow.revision=1;context.operation='revise'
  const target=context.workflow.nodes.find(node=>node.kind==='template')!
  target.kind='code';target.config={language:'javascript',code:'function main() { return { text: "Before" }; }',outputSchema:[{name:'text',type:'string',required:true}]}
  context.targetNodeIds=[target.id];context.contextSelection={targetNodeIds:[target.id],targetFields:{[target.id]:['code']}}
  return {context,target}
}
describe('bounded deterministic template prefetch',()=>{
  it.each(['模型选择仅为本次对话元信息','HTTP URL仅为验收元描述','人工确认与核对仅为验收元描述','明确无关工具 native:other 和保存结果仅为元描述'])(
    'does not expand known code fields from prose: %s',instruction=>{
      const {context}=focusedCode();context.tools=[tool('native:other','保存结果')]
      const binding=planningTemplateCatalog(context),base=prefetchedTemplateIds(binding,context,'只补已有字段'),ids=prefetchedTemplateIds(binding,context,instruction)
      expect(ids).toEqual(base);expect(ids).toContain('code')
      for(const id of ['llm','http','human',templateIdForTool('native:other')])expect(ids).not.toContain(id)
      const compiler=new TemplateFillingCompiler(context,{binding,prefetch:ids}),without=new TemplateFillingCompiler(context,{binding,prefetch:base})
      expect(compiler.nextSchema).toEqual(without.nextSchema)
      const wire={submission:{mode:'edit',updates:{n3:{values:{code:'function main() { return { text: "After" }; }'}}},coverage:{R1:['n3']}}}
      expect(validateJsonSchemaValue(compiler.nextSchema,wire)).toEqual([])
      expect(compiler.submit(wire).ok).toBe(true)
      expect(validateJsonSchemaValue(without.nextSchema,{submission:{...wire.submission,updates:{n3:{template:'llm',values:{prompt:'Unrequested'}}}}}).length).toBeGreaterThan(0)
    })

  it('retains the existing targeted tool while ignoring unrelated prose tools and kinds',()=>{
    const {context,target}=focusedCode();context.tools=[tool('native:used'),tool('native:other','保存结果')]
    target.kind='tool';target.config={toolId:'native:used',inputs:{text:'Before'}}
    context.contextSelection!.targetFields={[target.id]:['inputs']}
    const ids=prefetchedTemplateIds(planningTemplateCatalog(context),context,'模型选择、HTTP、人工确认、native:other 和保存结果都是元描述')
    expect(ids).toContain(templateIdForTool('native:used'));expect(ids).not.toContain(templateIdForTool('native:other'))
    for(const id of ['llm','http','human'])expect(ids).not.toContain(id)
  })

  it.each(['create','unfocused','incomplete','topology','type','kind','body'] as const)('keeps discovery fallback for %s tasks',reason=>{
    const {context,target}=focusedCode()
    if(reason==='create'){Object.assign(context,templateContext());delete context.contextSelection}
    context.tools=[tool('native:other')]
    if(reason==='unfocused')delete context.contextSelection
    if(reason==='incomplete')context.contextSelection!.targetNodeIds=[target.id,context.workflow.nodes[0]!.id]
    if(reason==='topology')context.contextSelection!.topologyChanged=true
    if(reason==='type')context.contextSelection!.templateIds=['llm']
    if(reason==='kind'||reason==='body')context.contextSelection!.targetFields={[target.id]:[reason]}
    const binding=planningTemplateCatalog(context),ids=prefetchedTemplateIds(binding,context,'模型与HTTP、人工确认，以及 native:other')
    expect(ids).toEqual(expect.arrayContaining(['llm','http','human',templateIdForTool('native:other')]))
    if(reason==='create'){
      const compiler=new TemplateFillingCompiler(context,{binding,prefetch:ids})
      expect(ids).toContain('template')
      expect(validateJsonSchemaValue(compiler.nextSchema,filling())).toEqual([])
      expect(compiler.submit(filling()).ok).toBe(true)
    }
  })

  it('includes an explicitly named exact tool ID in the first model schema',()=>{
    const context=templateContext();context.tools=[tool('native:write'),tool('native:write-extra')]
    const binding=planningTemplateCatalog(context),ids=prefetchedTemplateIds(binding,context,'用 native:write 保存库存结果')
    expect(ids).toContain(templateIdForTool('native:write'));expect(ids).not.toContain(templateIdForTool('native:write-extra'))
    const compiler=new TemplateFillingCompiler(context,{binding,prefetch:ids}),wire=filling()
    wire.submission.forms[1]={key:'greet',template:templateIdForTool('native:write'),values:{inputs:{text:'{{input.name}}'}}}
    expect(validateJsonSchemaValue(compiler.nextSchema,wire)).toEqual([])
  })
  it('uses only a unique available tool name and respects exact ID boundaries',()=>{
    const context=templateContext();context.tools=[tool('native:read','读取库存'),tool('native:a','保存结果'),tool('native:b','保存结果'),tool('native:write'),{...tool('native:hidden','隐藏工具'),available:false}]
    const binding=planningTemplateCatalog(context),ids=prefetchedTemplateIds(binding,context,'读取库存后保存结果；native:write-extra 和隐藏工具不在本次目录')
    expect(ids).toContain(templateIdForTool('native:read'))
    for(const id of ['native:a','native:b','native:write','native:hidden'])expect(ids).not.toContain(templateIdForTool(id))
    expect(prefetchedTemplateIds(binding,context,'工具 native:a')).toContain(templateIdForTool('native:a'))
  })
  it('prefetches tools already used by a revise graph without loading unrelated tools',()=>{
    const context=templateContext();context.operation='revise';context.workflow.revision=1
    context.tools=[tool('native:used'),tool('native:unused')]
    context.workflow.nodes.push({id:'used-node',kind:'tool',title:'Used',number:'3',x:100,y:0,fixed:false,config:{toolId:'native:used',inputs:{text:'x'}}})
    const ids=prefetchedTemplateIds(planningTemplateCatalog(context),context,'修改输出格式')
    expect(ids).toContain(templateIdForTool('native:used'));expect(ids).not.toContain(templateIdForTool('native:unused'))
  })
  it('caps automatic tool expansion by count and bytes while retaining base templates',()=>{
    const context=templateContext();context.tools=Array.from({length:12},(_,i)=>tool('native:tool-'+i))
    context.tools[0]!.description='x'.repeat(30_000)
    const binding=planningTemplateCatalog(context),instruction=context.tools.map(t=>t.id).join(' '),ids=prefetchedTemplateIds(binding,context,instruction)
    const expanded=binding.templates.filter(t=>ids.includes(t.id)&&t.kind==='tool')
    expect(expanded.length).toBeGreaterThan(0);expect(expanded.length).toBeLessThanOrEqual(4)
    expect(Buffer.byteLength(JSON.stringify(expanded))).toBeLessThanOrEqual(24*1024)
    expect(ids).not.toContain(templateIdForTool('native:tool-0'))
    expect(ids).toEqual(prefetchedTemplateIds(binding,context,instruction))
    expect(ids).toEqual(expect.arrayContaining(['input','output','template']))
    expect(prefetchedTemplateIds(binding,context,'输入文字并输出').some(id=>id.startsWith('tool-'))).toBe(false)
  })
  it('explains the acquired-template schema and expands it after a missing-template query',()=>{
    const context=templateContext();context.tools=[tool('native:optional')]
    const binding=planningTemplateCatalog(context),compiler=new TemplateFillingCompiler(context,{binding,prefetch:prefetchedTemplateIds(binding,context,'输入并输出')})
    const prompt=templateAuthoringContext(context,'输入并输出')
    expect(JSON.stringify(prompt)).toContain('当前提交 schema 仅列已获取模板')
    expect(JSON.stringify(prompt)).toContain('下一轮自动扩展')
    const id=templateIdForTool('native:optional'),wire=filling();wire.submission.forms[1]={key:'greet',template:id,values:{inputs:{text:'x'}}}
    expect(validateJsonSchemaValue(compiler.nextSchema,wire).length).toBeGreaterThan(0)
    compiler.queryTemplates([id]);expect(validateJsonSchemaValue(compiler.nextSchema,wire)).toEqual([])
  })
})
