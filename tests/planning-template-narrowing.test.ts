import { describe,expect,it } from 'vitest'
import { readFileSync } from 'node:fs'
import { assertObjectJsonSchema,validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { planningTemplateCatalog,prefetchedTemplateIds,queryPlanningTemplates,templateAuthoringContext } from '../src/host/planning/template-catalog.ts'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { freezePair,runPairArm,type PairConfig } from '../scripts/benchmarks/template-fill-paired.ts'
import { greetingSubmission } from '../scripts/benchmarks/template-fill-paired-self-test.ts'
import { oracle } from '../scripts/benchmarks/workflow-compiler.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'

const config=JSON.parse(readFileSync(new URL('../scripts/benchmarks/t09-config.json',import.meta.url),'utf8')) as PairConfig
const selected:Record<string,string[]>={
  greeting:['input','output','template'],
  'web-process':['input','output','template','http','code'],
  'tool-wrapper':['input','output','template','tool-28b72b479a020132d84e'],
  'structured-llm':['input','output','template','llm'],
  branch:['input','output','template','if'],container:['input','output','template','iteration'],
  'local-edit':['input','output','template'],'large-edit':['input','output','template'],
}
const strip=(value:any):any=>Array.isArray(value)?value.map(strip):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='description').map(([key,value])=>[key,strip(value)])):value
const descriptions=(value:any):string[]=>!value||typeof value!=='object'?[]:Object.entries(value).flatMap(([key,value])=>key==='description'&&typeof value==='string'?[value]:descriptions(value))
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value))
describe('positive template requirements',()=>{
  it.each([
    ['让大模型概括意见','llm'],['添加语言模型节点','llm'],['调用模型检查拼写','llm'],['An LLM might help with the response','llm'],['Use a language model for tone','llm'],
    ['以 Python 脚本转换日期','code'],['JavaScript 节点做字符替换','code'],['添加代码节点','code'],['A script may be appropriate','code'],
    ['POST 到接口收集状态','http'],['请求 URL 后提取响应头','http'],['GET the endpoint','http'],
    ['按条件判断是否备货','if'],['Choose a branch, otherwise emit a fallback','if'],['分数大于等于60输出合格否则不合格','if'],
    ['按类别分类消息','classifier'],['Add a classifier for incoming tickets','classifier'],
    ['逐项处理 items','iteration'],['逐个处理联系人','iteration'],['对每个订单生成记录','iteration'],['循环处理列表中的记录','iteration'],['Iterate over the orders','iteration'],['For each invoice emit a row','iteration'],
    ['循环直到状态变为就绪','loop'],['Repeat the check until ready','loop'],
    ['发送前人工审核','human'],['付款前人工确认','human'],['Require manual approval','human'],
    ['用模板拼接日期和标题','template'],['Consider a template for the label','template'],
  ])('includes a positive or ambiguous signal: %s',(instruction,kind)=>{
    const context=templateContext(),ids=prefetchedTemplateIds(planningTemplateCatalog(context),context,instruction)
    expect(ids).toContain(kind)
    expect(templateAuthoringContext(context,instruction).runtimeSemantics!.nodes.some(node=>node.kind===kind)).toBe(true)
  })
  it.each([
    '不使用模型、代码或工具','不要调用模型和脚本','禁止代码及模型调用','不得使用语言模型节点或 Python','不调用模型；无需代码节点','不能使用 LLM 和 JavaScript',
    'No LLM or code nodes','Without a language model or script','Do not use an LLM or Python','Never use code or LLM nodes','No LLM, code or scripts','不使用模型，代码或工具',
    '输出 JSON','Return a JSON object in plain text',
  ])('rejects negated requirements and format-only mentions: %s',instruction=>{
    const context=templateContext(),ids=prefetchedTemplateIds(planningTemplateCatalog(context),context,instruction)
    expect(ids).toEqual(['input','template','output'])
  })
  it.each(['把姓名和问候语拼成一句话输出','Greet the user by name'])(
    'includes the formatting template when a plain request does not name it: %s',instruction=>{
      const context=templateContext(),ids=prefetchedTemplateIds(planningTemplateCatalog(context),context,instruction)
      expect(ids).toEqual(['input','template','output'])
      expect(templateAuthoringContext(context,instruction).runtimeSemantics!.nodes.find(node=>node.kind==='template')!.syntax).toBeDefined()
    })
  it.each(['不要使用模板节点','Do not use a template node','Without a template'])(
    'excludes the default formatting template when explicitly negated: %s',instruction=>{
      const context=templateContext();expect(prefetchedTemplateIds(planningTemplateCatalog(context),context,instruction)).toEqual(['input','output'])
    })
  it.each([
    ['不要人工确认','human'],['无需 HTTP 接口','http'],['No conditional branch','if'],['Without iteration','iteration'],['Do not use a loop','loop'],['不要分类节点','classifier'],['不使用模板','template'],
  ])('negates every vocabulary kind: %s',(instruction,kind)=>{
    const context=templateContext();expect(prefetchedTemplateIds(planningTemplateCatalog(context),context,instruction)).not.toContain(kind)
  })
  it.each(['不要模型，但需要代码节点','Without an LLM; use Python','No LLM. Use Python.','Without an LLM, use Python','不使用模型，添加代码节点','Do not use code, but add an LLM','禁止代码；调用模型'])('retains a separate positive requirement: %s',instruction=>{
    const context=templateContext(),ids=prefetchedTemplateIds(planningTemplateCatalog(context),context,instruction)
    expect(ids).toContain(/Python|[需添]要?加?代码/.test(instruction)?'code':'llm')
    expect(ids).not.toContain(/Python|[需添]要?加?代码/.test(instruction)?'llm':'code')
  })
  it('retains explicit selections and targeted kinds even when prose negates them',()=>{
    const context=templateContext();context.contextSelection={templateIds:['code','llm','template']}
    expect(prefetchedTemplateIds(planningTemplateCatalog(context),context,'禁止代码与模型，不使用模板')).toEqual(expect.arrayContaining(['code','llm','template','input','output']))
    context.operation='revise';context.workflow.nodes[1]!.kind='template';context.targetNodeIds=[context.workflow.nodes[1]!.id];delete context.contextSelection
    expect(prefetchedTemplateIds(planningTemplateCatalog(context),context,'不使用模板')).toContain('template')
  })
})
describe('template-only narrowing and recovery',()=>{
  it.each(config.cases)('captures the first-request selected set and preserves all schema constraints: $id',async item=>{
    const frozen=freezePair({...config,repeats:1,cases:[item]}),slot=frozen.schedule.find(slot=>slot.arm==='template-fill')!
    let captured:any
    const result=await runPairArm(frozen,slot,{async request(body){captured=structuredClone(body);return {error:'OFFLINE_CAPTURE_STOP'}}},async()=>{throw Error('Capture must not run the oracle')})
    expect(result.requests).toBe(1)
    const prompt=JSON.parse(captured.messages[1].content),ids=prompt.templateCatalog.prefetched.entries.map((entry:any)=>entry.id)
    expect(ids.sort()).toEqual([...selected[item.id]!].sort())
    const binding=planningTemplateCatalog(item.context),compiler=new TemplateFillingCompiler(item.context,{binding,prefetch:prefetchedTemplateIds(binding,item.context,item.instruction)})
    const original=compiler['wire'](true),saved=structuredClone(original),after=compiler.nextSchema
    expect(strip(after)).toEqual(strip(original));expect(original).toEqual(saved)
    expect(after).toEqual(captured.tools[0].function.parameters);expect(compiler.nextSchema).toEqual(after)
    expect(new Set(descriptions(after))).toEqual(new Set(descriptions(original)))
    const long=descriptions(after).filter(text=>Buffer.byteLength(text)>=24)
    expect(long).toHaveLength(new Set(long).size)
    assertObjectJsonSchema(after)
    expect(prompt.templateCatalog.templates).toHaveLength(binding.templates.length)
  })
  it('preserves the frozen focused schema constraints while updating canonical teaching (T21.1)',()=>{
    const manifest=JSON.parse(readFileSync(new URL('../docs/evidence/planning-speed-20261019/s10-frozen-v3-20261019/manifest.json',import.meta.url),'utf8'))
    const item=manifest.cases.find((item:any)=>item.id==='unresolved-combined-31'),compiler=new TemplateFillingCompiler(item.context,{prefetch:['input','output','template'],maxSubmissions:3})
    expect(strip(compiler.nextSchema)).toEqual(strip(item.arms.B.schema))
    expect(JSON.stringify(compiler.nextSchema)).toContain('多个分支输出节点各取不同 key')
    expect(JSON.stringify(compiler.nextSchema)).not.toContain('默认出口用 result')
    expect(compiler.nextSchema).toEqual(compiler['wire'](true))
  })
  it('deduplicates repair schemas after filtering without mutating the repair session',()=>{
    const compiler=new TemplateFillingCompiler(templateContext()),wire=greetingSubmission('template-fill')
    wire.submission.title=42;expect(compiler.submit(wire).ok).toBe(false)
    const original=structuredClone(compiler.session.nextSchema),after=compiler.nextSchema
    expect(strip(after)).toEqual(strip(original));expect(compiler.session.nextSchema).toEqual(original)
    expect(new Set(descriptions(after))).toEqual(new Set(descriptions(original)))
  })
  it('recovers omitted fields and runtime syntax through the real T query endpoint, then passes the shared oracle',async()=>{
    const item={...config.cases.find(item=>item.id==='branch')!,instruction:'输入 score，达到六十分输出合格，低于六十分输出不合格'},frozen=freezePair({...config,repeats:1,cases:[item]})
    const wire={submission:{mode:'create',title:'分数结果',forms:[
      {key:'start',template:'input',values:{fields:[{name:'score',label:'分数',type:'number',required:true}]}},
      {key:'check',template:'if',values:{variable:'input.score',operator:'gte',value:'60'}},
      {key:'pass',template:'output',values:{text:'合格',outputName:'result'}},
      {key:'fail',template:'output',values:{text:'不合格',outputName:'result'}},
    ],chains:[{key:'main',nodes:['start','check']}],links:[
      {key:'yes',source:'check',target:'pass',port:'true'},{key:'no',source:'check',target:'fail',port:'false'},
    ],coverage:{R1:['check','pass','fail']}}}
    let calls=0,initial:any
    const answer=(name:string,args:unknown)=>({message:{role:'assistant',tool_calls:[{id:'offline-'+calls,function:{name,arguments:JSON.stringify(args)}}]}})
    const result=await runPairArm(frozen,frozen.schedule.find(slot=>slot.arm==='template-fill')!,{async request(body){
      calls++;const schema=(body.tools as any[])[0].function.parameters
      if(calls===1){
        initial=structuredClone(schema)
        expect(JSON.parse((body.messages as any[])[1].content).templateCatalog.prefetched.entries.map((entry:any)=>entry.id)).toEqual(['input','template','output'])
        expect(validateJsonSchemaValue(schema,wire).length).toBeGreaterThan(0)
        return answer('planner_node_templates',{ids:['unknown-template']})
      }
      const response=JSON.parse((body.messages as any[]).at(-1).content)
      if(calls===2){expect(response).toEqual({error:'Catalog query rejected'});expect(schema).toEqual(initial);return answer('planner_node_templates',{ids:['if']})}
      expect(response.entries[0].fields.properties.operator.enum).toContain('gte')
      const node=response.runtimeSemantics.nodes[0]
      expect(node.kind).toBe('if');expect(node.example).toEqual({variable:'input.score',operator:'gte',value:'60'});expect(node.fields.value).toContain('右值文本');expect(node.rules.join(' ')).toContain('port 必须 true/false');expect(node).not.toHaveProperty('schema')
      expect(bytes(response)).toBeGreaterThan(bytes(response.entries));expect(bytes(schema)).toBeGreaterThan(bytes(initial))
      expect(validateJsonSchemaValue(schema,wire)).toEqual([])
      return answer('structured_output',wire)
    }},(flow,item)=>oracle(flow,item))
    expect(result.status).toBe('success');expect(result.catalogCalls).toBe(2);expect(result.requests).toBe(3);expect(result.submissions).toBe(1);expect(result.oracle!.passed).toBe(true)
  },30000)
  it('batches query semantics for every acquired kind and keeps focused edit permissions',()=>{
    const context=templateContext(),compiler=new TemplateFillingCompiler(context,{prefetch:['input','output']})
    const result=queryPlanningTemplates(compiler,['template','if','iteration','code','http','llm','loop','human'])
    expect(result.runtimeSemantics!.nodes.map(node=>node.kind)).toEqual(result.entries.map(entry=>entry.kind))
    expect(result.runtimeSemantics!.nodes.every(node=>!Object.hasOwn(node,'schema'))).toBe(true)
    const before=compiler.nextSchema
    expect(()=>queryPlanningTemplates(compiler,['template','unknown'])).toThrow('冻结目录');expect(compiler.nextSchema).toEqual(before)
    expect(()=>queryPlanningTemplates(compiler,Array(13).fill('template'))).toThrow()
  })
})
