import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { cases, contextFor, oracle, structuredPromptPrefix, type Case } from '../scripts/benchmarks/workflow-compiler.ts'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { authoringGraphContext } from '../src/shared/planning-authoring-context.ts'
import { templateIdForTool } from '../src/shared/planning-node-templates.ts'
import { allNodes } from '../src/shared/workflow-validation.ts'
import { freezePair, pairedSchedule, type Arm, type PairConfig } from '../scripts/benchmarks/template-fill-paired.ts'
import type { WorkflowNode } from '../src/shared/types.ts'

// Only scripted declarations. The real compilers materialize every reference
// graph; the shared oracle then executes it through the actual local Graphon.
function reference(item:Case,arm:Arm,alternative=false){
  const context=contextFor(item)
  const compiler=arm==='template-fill'?new TemplateFillingCompiler(context):new WorkflowAuthoringCompiler(context)
  if(item.edit){
    const key=authoringGraphContext(context).find(n=>n.kind==='template'&&n.key===`n${context.workflow.nodes.findIndex(n=>n.id==='target')+1}`)!.key
    const text=(item.large?'结果：':'完成：')+(alternative?'{{ content }}':'{{input.text}}')
    const values={text,...(alternative?{inputs:{content:'{{base-0.text}}'}}:{})}
    const compiled=compiler.submit({submission:{mode:'edit',updates:{[key]:{[arm==='template-fill'?'values':'set']:values}},coverage:{R1:[key]}}})
    if(!compiled.ok)throw Error(JSON.stringify(compiled.feedback))
    return compiled.value.candidate!
  }
  const n=(key:string,kind:WorkflowNode['kind'],config:WorkflowNode['config'],scope?:string[])=>({key,kind,config,...(scope?{scope}:{})})
  const input=(name:string,type:'text'|'number'|'json'='text')=>n('start','input',{fields:[{name,label:name,type,required:true}]})
  const output=(text:string)=>n('result','output',{text,outputName:'result'})
  let rows:ReturnType<typeof n>[],chains:{key:string;nodes:string[]}[]=[],links:unknown[]=[]
  switch(item.id){
    case 'greeting': rows=[input('name'),n('format','template',{text:'你好，{{input.name}}！'}),output('{{format.text}}')];break
    case 'sum': rows=[input('values','json'),n('sum','code',{language:'javascript',inputs:{values:'{{input.values}}'},code:'function main(inputs){return {total:String(inputs.values.reduce((a,b)=>a+b,0))}}',outputSchema:[{name:'total',type:'string',required:true}]}),output('{{sum.total}}')];break
    case 'report': rows=[input('rows','json'),n('report','code',{language:'javascript',inputs:{rows:'{{input.rows}}'},code:'function main(inputs){const totals={}; for(const row of inputs.rows)totals[row.category]=(totals[row.category]??0)+row.amount;return {text:inputs.rows.length?Object.keys(totals).sort().map(k=>k+"="+totals[k]).join("\\n"):"空"}}',outputSchema:[{name:'text',type:'string',required:true}]}),output('{{report.text}}')];break
    case 'branch':
      rows=[input('score','number'),n('check','if',{variable:'input.score',operator:'gte',value:'60'}),n('pass','output',{text:'合格',outputName:'result'}),n('fail','output',{text:'不合格',outputName:'result'})]
      chains=[{key:'main',nodes:['start','check']}]
      links=[{key:'passLink',source:'check',target:'pass',port:'true'},{key:'failLink',source:'check',target:'fail',port:'false'}];break
    case 'web-process':
      rows=[input('page'),n('fetch','http',{url:'https://fixture.invalid/pages/{{input.page}}',method:'GET',headers:{}}),n('parse','code',{language:'javascript',inputs:{html:'{{fetch.body}}'},code:'function main(inputs){const clean=s=>s.replace(/<[^>]*>/g, "").replace(/\\s+/g," ").trim();const title=clean(inputs.html.match(/<title>([\\s\\S]*?)<\\/title>/i)[1]);const main=clean(inputs.html.match(/<main>([\\s\\S]*?)<\\/main>/i)[1]);return {text:title+"|"+(main||"空")}}',outputSchema:[{name:'text',type:'string',required:true}]}),output('{{parse.text}}')];break
    case 'tool-wrapper': rows=[input('sku'),n('lookup','tool',{toolId:'native:benchmark_lookup',inputs:{sku:'{{input.sku}}'}}),n('format','template',{text:'{{lookup.value.label}}：{{lookup.value.stock}}'}),output('{{format.text}}')];break
    case 'structured-llm': rows=[input('record','json'),n('model','llm',{model:context.model,effort:context.effort,prompt:structuredPromptPrefix+'\n{{input.record}}',outputSchema:[{name:'name',type:'string',required:true},{name:'total',type:'number',required:true},{name:'taxable',type:'boolean',required:true}]}),n('format','template',{text:'{{model.name}}|{{model.total}}|{{model.taxable}}'}),output('{{format.text}}')];break
    case 'container':
      rows=[input('items','json'),n('iterate','iteration',{iterator:'input.items',outputVariable:'inside.text',errorMode:'terminate',parallel:false}),n('format','template',{text:'{{iterate.result}}'}),output('{{format.text}}'),n('innerStart','input',{fields:[]},['iterate']),n('inside','template',{text:'项：{{item}}'},['iterate']),n('innerEnd','output',{text:'{{inside.text}}',outputName:'item'},['iterate'])]
      chains=[{key:'main',nodes:['start','iterate','format','result']},{key:'body',nodes:['innerStart','inside','innerEnd']}];break
    default: throw Error('Missing reference '+item.id)
  }
  if(alternative)switch(item.id){
    case 'greeting':rows.find(n=>n.key==='format')!.config={text:'你好，{{ guest }}！',inputs:{guest:'{{start.name}}'}};break
    case 'web-process':rows.find(n=>n.key==='parse')!.config.inputs={html:'{{fetch.text}}'};break
    case 'tool-wrapper':
      rows.find(n=>n.key==='lookup')!.config.inputs={sku:'{{start.sku}}'}
      rows.find(n=>n.key==='format')!.config={text:'{{label}}：{{stock}}',inputs:{label:'{{lookup.value.label}}',stock:'{{lookup.value.stock}}'}};break
    case 'structured-llm':
      rows.find(n=>n.key==='model')!.config.outputSchema!.reverse()
      rows.find(n=>n.key==='model')!.config.outputSchema!.push({name:'note',type:'string',required:false})
      rows.find(n=>n.key==='model')!.config.inputs={record:'{{start.record}}'}
      rows.find(n=>n.key==='format')!.config={text:"{{ fields['name'] }}|{{ fields.total }}|{{ fields.taxable }}",inputs:{fields:'{{model.json}}'}};break
    case 'branch':
      rows.find(n=>n.key==='check')!.config={cases:[{id:'qualified',conditions:[{variable:'start.score',operator:'gte',value:'60'}]}]}
      links=[{key:'passLink',source:'check',target:'pass',port:'qualified'},{key:'failLink',source:'check',target:'fail',port:'false'}];break
    case 'container':
      rows.find(n=>n.key==='iterate')!.config.iterator='start.items'
      rows.find(n=>n.key==='iterate')!.config.parallel=true
      rows.find(n=>n.key==='inside')!.config={text:'{% if entry is defined %}项：{{entry}}{% endif %}',inputs:{entry:'{{item}}'}}
      // A helper template is valid: one template execution per item was too strict.
      rows.push(n('helper','template',{text:'{{item}}'},['iterate']))
      chains.find(c=>c.key==='body')!.nodes.splice(1,0,'helper');break
  }
  if(!chains.length)chains=[{key:'main',nodes:rows.map(n=>n.key)}]
  if(compiler instanceof TemplateFillingCompiler)compiler.queryTemplates(rows.map(n=>n.kind==='tool'?templateIdForTool(n.config.toolId!):n.kind))
  const wire=arm==='template-fill'?{forms:rows.map(({kind,config,...rest})=>({...rest,template:kind==='tool'?templateIdForTool(config.toolId!):kind,values:kind==='tool'?{inputs:config.inputs}:config}))}:{nodes:rows}
  const compiled=compiler.submit({submission:{mode:'create',title:'确定性参考 '+item.id,...wire,chains,links,coverage:{R1:rows.map(n=>n.key)}}})
  if(!compiled.ok)throw Error(JSON.stringify(compiled.feedback))
  return compiled.value.candidate!
}

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()})
describe('deterministic benchmark category references',()=>{
  for(const item of cases)it(`${item.id}: both frontends compile; shared oracle accepts reference and rejects wrong output`,async()=>{
    // Any accidental networking is a test failure; local Graphon subprocesses
    // remain real. No provider transport is constructed by these tests.
    const noNetwork=()=>{throw Error('Offline benchmark attempted network access')}
    vi.stubGlobal('fetch',vi.fn(noNetwork))
    const guards=[vi.spyOn(http,'request').mockImplementation(noNetwork),vi.spyOn(http,'get').mockImplementation(noNetwork),vi.spyOn(https,'request').mockImplementation(noNetwork),vi.spyOn(https,'get').mockImplementation(noNetwork)]
    expect(contextFor(item)).toEqual(contextFor(item))
    const compact=reference(item,'compact-repair'),template=reference(item,'template-fill')
    expect(template).toEqual(compact)
    for(const flow of [compact,template]){
      const result=await oracle(flow,{...item,context:contextFor(item)})
      expect(result.passed,JSON.stringify(result)).toBe(true)
      expect(result.results).toHaveLength(item.samples.length)
    }
    const wrong=structuredClone(compact)
    if(item.edit){
      wrong.nodes.find(n=>n.id==='target')!.config.text='错误'
    }else{
      wrong.nodes.filter(n=>n.kind==='output').forEach(n=>{n.config.text='错误'})
    }
    expect((await oracle(wrong,item)).passed).toBe(false)
    expect(fetch).not.toHaveBeenCalled();guards.forEach(guard=>expect(guard).not.toHaveBeenCalled())
  },60_000)

  const t09Ids=['greeting','web-process','tool-wrapper','structured-llm','branch','container','local-edit','large-edit']
  for(const id of t09Ids)it(`${id}: accepts a runtime-supported alternative through both frontends`,async()=>{
    const item=cases.find(c=>c.id===id)!
    for(const arm of ['compact-repair','template-fill'] as const){
      const result=await oracle(reference(item,arm,true),item)
      expect(result.passed,JSON.stringify(result)).toBe(true)
      expect(result.probeResults.length).toBeGreaterThan(0)
    }
  },60_000)

  it('structured-llm: a model node without config.model falls back to the Desktop harness default, like the runtime does',async()=>{
    const item=cases.find(c=>c.id==='structured-llm')!
    for(const arm of ['compact-repair','template-fill'] as const){
      const flow=reference(item,arm),model=flow.nodes.find(n=>n.kind==='llm')!
      delete model.config.model;delete model.config.effort
      const result=await oracle(flow,item)
      expect(result.passed,JSON.stringify(result)).toBe(true)
      expect(result.results.every(r=>r.standInCalls===1)).toBe(true)
    }
  },60_000)

  it('accepts the exact aborted tool/input mapping with corrected format and executes ambiguous text as a business failure',async()=>{
    const item=cases.find(c=>c.id==='tool-wrapper')!
    for(const arm of ['compact-repair','template-fill'] as const){
      const flow=reference(item,arm,true),tool=flow.nodes.find(n=>n.kind==='tool')!,template=flow.nodes.find(n=>n.kind==='template')!
      expect(tool.config).toEqual({toolId:'native:benchmark_lookup',inputs:{sku:'{{base-0.sku}}'}})
      expect(template.config).toEqual({text:'{{label}}：{{stock}}',inputs:{label:'{{allocated-0.value.label}}',stock:'{{allocated-0.value.stock}}'}})
      expect((await oracle(flow,item)).passed).toBe(true)
      template.config.text='名称：{{label}}，库存：{{stock}}'
      const wrong=await oracle(flow,item)
      expect(wrong.results).toHaveLength(3)
      expect(wrong.results.every(r=>r.status==='success'&&r.toolCalls===1&&!r.passed)).toBe(true)
      expect(wrong.results[0]!.actual).toBe('名称：铅笔，库存：3')
    }
  },60_000)

  for(const id of t09Ids)it(`${id}: rejects sample lookup cheating even when all public samples pass`,async()=>{
    const item=cases.find(c=>c.id===id)!,flow=reference(item,'compact-repair')
    const template=flow.nodes.find(n=>n.kind==='template')
    switch(id){
      case 'greeting':template!.config.text='{% if input.name == "小明" %}你好，小明！{% else %}你好，Ada！{% endif %}';break
      case 'web-process':{
        const code=flow.nodes.find(n=>n.kind==='code')!
        code.config.inputs={...code.config.inputs,page:'{{input.page}}'}
        code.config.code='function main(inputs){return {text:({news:"公告|欢迎 Ada 阅读",notice:"更新|版本 2 已发布",empty:"空白|空"})[inputs.page]}}';break
      }
      case 'tool-wrapper':template!.config.text='{% if input.sku == "A" %}铅笔：3{% elif input.sku == "B" %}笔记本：0{% else %}橡皮：12{% endif %}';break
      case 'structured-llm':template!.config.text='{% if input.record.name == "Ada" %}Ada|6|true{% elif input.record.name == "林" %}林|0|false{% else %}负数|-5|false{% endif %}';break
      case 'branch':flow.nodes.find(n=>n.kind==='if')!.config.operator='equals';break
      case 'container':flow.nodes.find(n=>n.kind==='iteration')!.config.body!.nodes.find(n=>n.kind==='template')!.config.text='项：{% if item == "乙" %}乙{% elif item == "甲" %}甲{% else %}Ada{% endif %}';break
      case 'local-edit':template!.config.text='完成：{% if input.text == "样本" %}样本{% else %}另一个{% endif %}';break
      case 'large-edit':flow.nodes.find(n=>n.id==='target')!.config.text='结果：{% if input.text == "甲" %}甲{% else %}乙{% endif %}';break
    }
    const result=await oracle(flow,item)
    expect(result.results.every(r=>r.passed),JSON.stringify(result)).toBe(true)
    expect(result.probeResults.some(r=>!r.passed),JSON.stringify(result)).toBe(true)
    expect(result.passed).toBe(false)
  },60_000)

  it('rejects native text parsing even when it reproduces every public sample',async()=>{
    const item=cases.find(c=>c.id==='tool-wrapper')!,flow=reference(item,'compact-repair'),tool=flow.nodes.find(n=>n.kind==='tool')!
    flow.nodes.find(n=>n.kind==='template')!.config.text=`{{ ${tool.id}.text | replace('{"sku":"A","label":"','') | replace('{"sku":"B","label":"','') | replace('{"sku":"C","label":"','') | replace('","stock":','：') | replace('}','') }}`
    const result=await oracle(flow,item)
    expect(result.results.every(r=>r.passed),JSON.stringify(result)).toBe(true)
    expect(result.probeResults.every(r=>!r.passed)).toBe(true)
    expect(result.passed).toBe(false)
  })

  it.each(['label','stock'])('rejects hardcoded native %s even with unused valid typed mappings',async field=>{
    const item=cases.find(c=>c.id==='tool-wrapper')!,flow=reference(item,'compact-repair',true),template=flow.nodes.find(n=>n.kind==='template')!
    template.config.text=field==='label'?'{% if input.sku == "A" %}铅笔{% elif input.sku == "B" %}笔记本{% else %}橡皮{% endif %}：{{stock}}':'{{label}}：{% if input.sku == "A" %}3{% elif input.sku == "B" %}0{% else %}12{% endif %}'
    const result=await oracle(flow,item)
    expect(result.results.every(r=>r.passed)).toBe(true)
    expect(result.passed).toBe(false)
  })

  it.each(['greeting','tool-wrapper','structured-llm','container'])('%s rejects an executed but bypassed required template',async id=>{
    const item=cases.find(c=>c.id===id)!,flow=reference(item,'compact-repair')
    const output=flow.nodes.find(n=>n.kind==='output')!
    if(id==='container'){
      // The real iteration still runs, but its child text is discarded.
      flow.nodes.find(n=>n.kind==='template')!.config.text='[{% for entry in input.items %}"项：{{entry}}"{% if not loop.last %},{% endif %}{% endfor %}]'
    }else{
      output.config.text=id==='greeting'?'你好，{{input.name}}！':id==='tool-wrapper'?'{{allocated-0.value.label}}：{{allocated-0.value.stock}}':'{{allocated-0.name}}|{{allocated-0.total}}|{{allocated-0.taxable}}'
    }
    const result=await oracle(flow,item)
    expect([...result.results,...result.probeResults].every(r=>r.passed),JSON.stringify(result)).toBe(true)
    expect(result.templateDependency?.passed).toBe(false)
    expect(result.passed).toBe(false)
  })

  it.each(['tool-wrapper','structured-llm'])('%s rejects two executed required actions',async id=>{
    const item=cases.find(c=>c.id===id)!,flow=reference(item,'compact-repair')
    const action=flow.nodes.find(n=>n.kind===(id==='tool-wrapper'?'tool':'llm'))!
    flow.nodes.push({...structuredClone(action),id:'duplicate-action'})
    flow.edges.find(e=>e.target===action.id)!.target='duplicate-action'
    flow.edges.push({id:'duplicate-action-edge',source:'duplicate-action',target:action.id})
    const result=await oracle(flow,item)
    expect(result.results.every(r=>r.actual===r.expected&&(id==='tool-wrapper'?r.toolCalls:r.standInCalls)===2&&!r.exercised)).toBe(true)
    expect(result.passed).toBe(false)
  })

  it('rejects a constant conditional whose output template independently computes the score result',async()=>{
    const item=cases.find(c=>c.id==='branch')!,flow=reference(item,'compact-repair'),check=flow.nodes.find(n=>n.kind==='if')!
    check.config={logicGate:{operator:'IF',inputs:[{value:true,predicate:'boolean'}]}}
    const pass=flow.nodes.find(n=>n.kind==='output'&&n.config.text==='合格')!
    flow.nodes.push({...structuredClone(pass),id:'bypass',kind:'template',config:{text:'{% if input.score >= 60 %}合格{% else %}不合格{% endif %}'}})
    flow.edges.find(e=>e.target===pass.id)!.target='bypass'
    flow.edges.push({id:'bypass-edge',source:'bypass',target:pass.id});pass.config.text='{{bypass.text}}'
    const result=await oracle(flow,item)
    expect([...result.results,...result.probeResults].every(r=>r.passed)).toBe(true)
    expect(result.branchSemantics).toBe(false)
    expect(result.passed).toBe(false)
  })

  it('rejects two executed HTTP calls while preserving correct page output',async()=>{
    const item=cases.find(c=>c.id==='web-process')!,flow=reference(item,'compact-repair'),fetch=flow.nodes.find(n=>n.kind==='http')!
    const edge=flow.edges.find(e=>e.target===fetch.id)!
    flow.nodes.push({...structuredClone(fetch),id:'extra-fetch'})
    flow.edges.push({id:'extra-fetch-edge',source:'extra-fetch',target:fetch.id});edge.target='extra-fetch'
    const result=await oracle(flow,item)
    expect(result.results.every(r=>r.actual===r.expected&&r.httpCalls===2&&!r.exercised)).toBe(true)
    expect(result.passed).toBe(false)
  })

  it('rejects a dummy JavaScript node bypassed by HTML processing in a template',async()=>{
    const item=cases.find(c=>c.id==='web-process')!,flow=reference(item,'compact-repair'),fetch=flow.nodes.find(n=>n.kind==='http')!,code=flow.nodes.find(n=>n.kind==='code')!,output=flow.nodes.find(n=>n.kind==='output')!
    code.config.code='function main(){return {text:"unused"}}'
    const replacements=[['<!doctype html>',''],['<html><head><title>',''],['</title></head><body>','|'],['<nav>忽略导航</nav>',''],['<main>',''],['</main>',''],['</body></html>',''],['<footer>忽略页脚</footer>',''],['<b>',''],['</b>',''],['<em>',''],['</em>',''],['\n',' '],['   ',' '],['|  ','|空'],['| ','|']]
    const text='{{ '+['html',...replacements.map(([from,to])=>`replace(${JSON.stringify(from)},${JSON.stringify(to)})`),'trim'].join(' | ')+' }}'
    flow.nodes.push({...structuredClone(output),id:'bypass',kind:'template',config:{text,inputs:{html:`{{${fetch.id}.body}}`}}})
    flow.edges.find(e=>e.target===output.id)!.target='bypass'
    flow.edges.push({id:'bypass-edge',source:'bypass',target:output.id});output.config.text='{{bypass.text}}'
    const result=await oracle(flow,item)
    expect([...result.results,...result.probeResults].every(r=>r.passed),JSON.stringify(result)).toBe(true)
    expect(result.codeDependency?.passed).toBe(false)
    expect(result.passed).toBe(false)
  })

  it('accepts typed tool values routed through a deterministic assigner helper',async()=>{
    const item=cases.find(c=>c.id==='tool-wrapper')!,flow=reference(item,'compact-repair',true),tool=flow.nodes.find(n=>n.kind==='tool')!,template=flow.nodes.find(n=>n.kind==='template')!
    flow.nodes.push({...structuredClone(tool),id:'alias',kind:'assigner',config:{assignments:[{name:'product',operation:'set',value:`{{${tool.id}.value}}`}]}})
    flow.edges.find(e=>e.source===tool.id)!.target='alias'
    flow.edges.push({id:'alias-edge',source:'alias',target:template.id})
    template.config.inputs={label:'{{vars.product.label}}',stock:'{{vars.product.stock}}'}
    const result=await oracle(flow,item)
    expect(result.passed,JSON.stringify(result)).toBe(true)
  })

  it.each(['tool-wrapper','structured-llm','container'])('%s accepts mutually exclusive action nodes with one execution per sample',async id=>{
    const item=cases.find(c=>c.id===id)!,flow=reference(item,'compact-repair'),input=flow.nodes.find(n=>n.kind==='input')!
    const renamed=new Map(allNodes(flow).filter(n=>n.id!==input.id).map(n=>[n.id,'alternate-'+n.id]))
    const duplicate=<T,>(value:T):T=>JSON.parse(JSON.stringify(value,(_key,value:unknown)=>typeof value==='string'?renamed.get(value)??[...renamed].reduce((text,[from,to])=>text.replaceAll(from+'.',to+'.'),value):value))
    const alternateNodes=duplicate(flow.nodes.filter(n=>n.id!==input.id)),alternateEdges=duplicate(flow.edges.filter(e=>e.source!==input.id)).map(e=>({...e,id:'alternate-'+e.id}))
    const first=flow.edges.find(e=>e.source===input.id)!,target=first.target
    const variable=id==='tool-wrapper'?'input.sku':id==='structured-llm'?'input.record.name':'input.items'
    const value=id==='tool-wrapper'?'A':id==='structured-llm'?'Ada':'[]'
    flow.nodes.push({...structuredClone(input),id:'route',kind:'if',config:{variable,operator:id==='container'?'empty':'equals',value}},...alternateNodes)
    first.source='route';first.port='true'
    flow.edges.push({id:'route-entry',source:input.id,target:'route'},{id:'route-alternate',source:'route',target:renamed.get(target)!,port:'false'},...alternateEdges)
    const result=await oracle(flow,item)
    expect(result.passed,JSON.stringify(result)).toBe(true)
  },60_000)

  it.each(['tool-wrapper','structured-llm','container','branch'])('%s rejects forbidden code even if disconnected',async id=>{
    const item=cases.find(c=>c.id===id)!,flow=reference(item,'compact-repair')
    flow.nodes.push({...flow.nodes[0]!,id:'forbidden',kind:'code',config:{language:'javascript',code:'function main(){return {}}'}})
    await expect(oracle(flow,item)).rejects.toThrow('prohibited code')
  })
  it.each(['greeting','web-process','tool-wrapper','branch','container'])('%s rejects forbidden models even if disconnected',async id=>{
    const item=cases.find(c=>c.id===id)!,flow=reference(item,'compact-repair')
    flow.nodes.push({...flow.nodes[0]!,id:'forbidden',kind:'llm',config:{}})
    await expect(oracle(flow,item)).rejects.toThrow('prohibited model')
  })

  it.each(['local-edit','large-edit'])('%s rejects unrelated changes even when business output is correct',async id=>{
    const item=cases.find(c=>c.id===id)!,flow=reference(item,'compact-repair')
    flow.nodes[0]!.title='silent unrelated mutation'
    // Deliberately omit legacy edit flags, as the CLI config does.
    await expect(oracle(flow,{id,instruction:item.instruction,samples:item.samples})).rejects.toThrow('unrelated nodes')
    const reordered=reference(item,'compact-repair');reordered.edges.reverse()
    await expect(oracle(reordered,item)).rejects.toThrow('all edges')
    const nodeOrder=reference(item,'compact-repair');nodeOrder.nodes.reverse()
    await expect(oracle(nodeOrder,item)).rejects.toThrow('identities and order')
    const target=reference(item,'compact-repair');target.nodes.find(n=>n.id==='target')!.title='changed target metadata'
    await expect(oracle(target,item)).rejects.toThrow('Only target template text/inputs')
  })
  it('rejects a structured LLM graph with a wrong field type before execution',async()=>{
    const item=cases.find(c=>c.id==='structured-llm')!,flow=reference(item,'compact-repair')
    flow.nodes.find(n=>n.kind==='llm')!.config.outputSchema![1]!.type='string'
    await expect(oracle(flow,item)).rejects.toThrow('schema differs')
  })
  it('rejects a tool graph using a guessed top-level business field',async()=>{
    const item=cases.find(c=>c.id==='tool-wrapper')!,flow=reference(item,'compact-repair')
    flow.nodes.find(n=>n.kind==='template')!.config.text='{{lookup.label}}'
    expect((await oracle(flow,item)).passed).toBe(false)
  })
  it('rejects an HTTP graph pointing outside the frozen fixture routes without sending a request',async()=>{
    const item=cases.find(c=>c.id==='web-process')!,flow=reference(item,'compact-repair')
    flow.nodes.find(n=>n.kind==='http')!.config.url='https://example.com/'
    const result=await oracle(flow,item)
    expect(result.passed).toBe(false)
    expect(result.results.every(r=>r.httpCalls===0&&r.status==='failed')).toBe(true)
  })
  it('rejects a container replaced by a template even if an output is hardcoded',async()=>{
    const item=cases.find(c=>c.id==='container')!,flow=reference(item,'compact-repair'),container=flow.nodes.find(n=>n.kind==='iteration')!
    container.kind='template';container.config={text:item.samples[0]!.expected}
    await expect(oracle(flow,item)).rejects.toThrow('iteration container')
  })
  it('freezes exactly eight direct categories and a balanced, adjacent 48-slot AB/BA schedule',()=>{
    const config:PairConfig=JSON.parse(readFileSync('scripts/benchmarks/t09-config.json','utf8'))
    const ids=['greeting','web-process','tool-wrapper','structured-llm','branch','container','local-edit','large-edit']
    expect(config.cases.map(c=>c.id)).toEqual(ids)
    for(const item of config.cases){
      const source=cases.find(c=>c.id===item.id)!
      expect(item).toEqual({id:source.id,sourceLayer:'direct',instruction:source.instruction,context:{...contextFor(source),effort:config.model.reasoningEffort},samples:source.samples})
    }
    const frozen=freezePair(config),schedule=pairedSchedule(frozen)
    expect(config.repeats).toBe(3);expect(schedule).toHaveLength(48)
    expect(schedule.filter(s=>s.arm==='compact-repair')).toHaveLength(24)
    expect(schedule.filter(s=>s.arm==='template-fill')).toHaveLength(24)
    for(let i=0;i<48;i+=2){
      const first=schedule[i]!,second=schedule[i+1]!
      expect(second).toMatchObject({sourceLayer:'direct',caseId:first.caseId,repeat:first.repeat,position:1})
      expect(second.arm).not.toBe(first.arm)
      expect(first.arm).toBe((ids.indexOf(first.caseId)+first.repeat)%2?'template-fill':'compact-repair')
    }
    expect(allNodes(config.cases.at(-1)!.context.workflow)).toHaveLength(31)
  })
})
