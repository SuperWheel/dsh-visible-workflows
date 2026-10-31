import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { cases, contextFor, oracle } from '../scripts/benchmarks/workflow-compiler.ts'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { codeInputReads } from '../src/shared/planning-code-inputs.ts'
import { planningNodeRefs } from '../src/shared/planning-edits.ts'

const fixture=JSON.parse(readFileSync(new URL('./fixtures/t10-authoring/narrow-code-inputs.json',import.meta.url),'utf8'))
const item=cases.find(c=>c.id==='web-process')!
const make=(template=false,context=contextFor(item))=>{
  const compiler=template?new TemplateFillingCompiler(context):new WorkflowAuthoringCompiler(context)
  if(compiler instanceof TemplateFillingCompiler)compiler.queryTemplates(['input','output','code','http'])
  return compiler
}
const failed=(result:ReturnType<WorkflowAuthoringCompiler['submit']>)=>{
  if(result.ok)throw Error('Expected rejected draft')
  return result.feedback
}
const repair=(compiler:ReturnType<typeof make>,patches:any[])=>{
  const submission={mode:'repair',draftRevision:compiler.snapshot().revision,patches}
  expect(()=>assertSupportedJsonSchema(compiler.nextSchema)).not.toThrow()
  expect(validateJsonSchemaValue(compiler.nextSchema,{submission})).toEqual([])
  return compiler.submit({submission})
}
const initial=(template:boolean)=>{
  const value=structuredClone(fixture.submissionsLog[0])
  if(!template){value.submission.nodes=value.submission.forms.map(({template:kind,values:config,...rest}:any)=>({...rest,kind,config}));delete value.submission.forms}
  return value
}
// The journal's source is truncated mid-regexp. Keep it verbatim in the fixture;
// this explicit source completion is needed to exercise the unchanged oracle.
const completeCode=String.raw`function main(inputs) {
  var html = String(inputs.html == null ? "" : inputs.html);
  function plain(s) { return String(s == null ? "" : s).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(); }
  var title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  var main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  return {title: plain(title ? title[1] : ""), main: plain(main ? main[1] : "") || "空"};
}`

describe('shared code input binding checks',()=>{
  for(const template of [false,true]){
    const root=template?'formsByKey':'nodesByKey',section=template?'values':'config',path=`/${root}/extract/${section}/inputs`
    it(`${root}: exact journal source is repairable; adding the map compiles`,async()=>{
      expect(fixture.line).toBe(85)
      expect(fixture.feedback).toEqual([])
      const compiler=make(template),first=failed(compiler.submit(initial(template)))
      const issue=first.issues.find(i=>i.code==='CODE_INPUT_UNMAPPED')!
      expect(issue.path).toBe(path)
      expect(issue.message).toContain(path)
      expect(issue.message).toContain('inputs.html')
      expect(issue.message).toContain('{{fetch.text}}')
      expect(first.allowedPaths).toEqual([path])
      const result=repair(compiler,[{op:'add',path,value:{html:'{{fetch.text}}'}}])
      if(!result.ok)throw Error(JSON.stringify(result.feedback))
      // Inputs alone cannot repair the independently truncated original code.
      expect((await oracle(result.value.candidate!,item)).passed).toBe(false)
    })
    it(`${root}: completed source plus the same one-round inputs repair passes unchanged oracle`,async()=>{
      const compiler=make(template),value=initial(template)
      const node=(template?value.submission.forms:value.submission.nodes).find((n:any)=>n.key==='extract')
      node[section].code=completeCode
      expect(failed(compiler.submit(value)).issues.map(i=>i.code)).toEqual(['CODE_INPUT_UNMAPPED'])
      const result=repair(compiler,[{op:'add',path,value:{html:'{{fetch.text}}'}}])
      if(!result.ok)throw Error(JSON.stringify(result.feedback))
      const checked=await oracle(result.value.candidate!,item)
      expect(checked.passed,JSON.stringify(checked)).toBe(true)
      expect(checked.results.every(r=>r.passed)).toBe(true)
      expect(checked.probeResults.every(r=>r.passed)).toBe(true)
    })
  }
  const submitCode=(code:string,inputs?:Record<string,unknown>,language='javascript')=>{
    const value=initial(false),node=value.submission.nodes.find((n:any)=>n.key==='extract')
    node.config={code,language,...(inputs?{inputs}:{})}
    return make().submit(value)
  }
  for(const [label,code,inputs,language]of [
    ['mapped','function main(inputs){ return {v: inputs.html} }',{html:'value'}],
    ['dynamic','function main(inputs){ return {v: inputs[key]} }'],
    ['whole object','function main(inputs){ return {v: JSON.stringify(inputs)} }'],
    ['keys','function main(inputs){ return {v: Object.keys(inputs)} }'],
    ['passing along','function main(inputs){ return other(inputs) }'],
    ['spread','function main(inputs){ return {...inputs} }'],
    ['renamed mapped','function main(data){ return {v: data.x} }',{x:'value'}],
    ['destructuring mapped','function main(inputs){ const {a, b: c} = inputs; return {a,c} }',{a:1,b:2}],
    ['comment and string','function main(inputs){ /* inputs.a */ const s="inputs.b"; // inputs.c\n return {s} }'],
    ['regex','function main(inputs){ return {v: /inputs.fake/.test("x")} }'],
    ['python mapped','def main(data):\n  return {"v": data.get("x", 0)}',{x:1},'python'],
    ['python comments','def main(inputs):\n  # inputs["a"]\n  return {"v": "inputs.get(\'b\')"}',undefined,'python'],
    ['reassigned','function main(inputs){ inputs = {x:1}; return {v:inputs.x} }'],
    ['shadowed block','function main(inputs){ {let inputs={x:1}; return {v:inputs.x}} }'],
    ['shadowed argument','function main(inputs){ function other(inputs){return inputs.x} return {v:1} }'],
    ['shadowed arrow','function main(inputs){ const f=(inputs)=>inputs.x; return {v:1} }'],
    ['write','function main(inputs){ inputs.x=1; return {v:inputs.x} }'],
    ['parenthesized write','function main(inputs){ (inputs.x)=1; return {v:inputs.x} }'],
    ['conditional write','function main(inputs){ inputs.x ??= 1; return {v:inputs.x} }'],
    ['destructuring target','function main(inputs){ ({a:inputs.x}={a:1}); return {v:inputs.x} }'],
    ['parenthesized delete','function main(inputs){ delete (inputs.x); return {v:inputs.x} }'],
    ['dynamic scope','function main(inputs){ with ({inputs:{x:1}}) {return {v:inputs.x}} }'],
    ['eval mutation','function main(inputs){ eval("inputs={x:1}"); return {v:inputs.x} }'],
    ['python reassigned','def main(inputs):\n  inputs = {"x": 1}\n  return {"v": inputs["x"]}',undefined,'python'],
    ['python shadowed','def main(inputs):\n  def other(inputs):\n    return inputs["x"]\n  return {}',undefined,'python'],
    ['python tuple target','def main(inputs):\n  inputs["x"], y = (1, 2)\n  return {"v": inputs["x"]}',undefined,'python'],
    ['template interpolation','function main(inputs){ return {v:`${inputs.x}`} }'],
    ['intrinsic','function main(inputs){ return {v:inputs.toString()} }'],
    ['unrelated function','function other(data){return data.x} function main(inputs){return {v:1}}'],
  ] as const)it(`does not flag ${label}`,()=>{
    const result=submitCode(code,inputs,language)
    expect(result.ok,result.ok?'':JSON.stringify(result.feedback)).toBe(true)
  })
  for(const [label,code,missing,language]of [
    ['destructuring','function main(inputs){ const {a, b: c} = inputs; return {a,c} }',['b']],
    ['destructuring without semicolon','function main(inputs){ const {a, b: c} = inputs\n return {a,c} }',['b']],
    ['python subscript','def main(data):\n  return {"v": data["x"]}',['x'],'python'],
    ['python get','def main(data):\n  return {"v": data.get("x", 0)}',['x'],'python'],
    ['renamed','function main(data){ return {v: data.x} }',['x']],
    ['arrow','const main=(data)=>{return {v:data.x}}',['x']],
    ['expression arrow','const main=(data)=>({v:data.x})',['x']],
    ['bare arrow','const main=data=>({v:data.x})',['x']],
    ['assigned function','main = function(data){return {v:data.x}}',['x']],
    ['bracket strings','function main(inputs){return {v:inputs["x"] + inputs[\'y\']}}',['x','y']],
  ] as const)it(`flags ${label}`,()=>{
    const result=submitCode(code,{a:1},language)
    const issue=failed(result).issues.find(i=>i.code==='CODE_INPUT_UNMAPPED')!
    expect(issue.path).toBe('/nodesByKey/extract/config/inputs')
    for(const name of missing)expect(issue.message).toContain(name)
  })
  it('replaces an existing mapping and preserves literal JSON values in the SDK repair contract',()=>{
    const compiler=make(),value=initial(false),node=value.submission.nodes.find((n:any)=>n.key==='extract')
    node.config={code:'function main(inputs){return {v:inputs.a + inputs.b}}',inputs:{a:2}}
    failed(compiler.submit(value))
    expect(repair(compiler,[{op:'replace',path:'/nodesByKey/extract/config/inputs',value:{a:2,b:3}}]).ok).toBe(true)
  })
  for(const template of [false,true])it(`edit ${template?'template':'compact'}: untouched legacy node is ignored, changed code/inputs and addNodes are checked`,()=>{
    const context=contextFor(cases.find(c=>c.id==='local-edit')!)
    const legacy=context.workflow.nodes.find(n=>n.id==='target')!
    legacy.kind='code';legacy.config={code:'function main(data){return {v:data.x}}'}
    const key='n'+planningNodeRefs(context.workflow).get('target')!.slice(1)
    const section=template?'values':'set',path=`/updates/${key}/${section}/inputs`
    for(const change of [{title:'改标题'},{[section]:{timeoutMs:2000}}]){
      const result=make(template,context).submit({submission:{mode:'edit',updates:{[key]:change},coverage:{R1:[key]}}})
      expect(result.ok,result.ok?'':JSON.stringify(result.feedback)).toBe(true)
    }
    for(const set of [{code:'function main(data){return {v:data.x}}'},{inputs:{}}]){
      const compiler=make(template,context)
      const issue=failed(compiler.submit({submission:{mode:'edit',updates:{[key]:{[section]:set}},coverage:{R1:[key]}}})).issues.find(i=>i.code==='CODE_INPUT_UNMAPPED')!
      expect(issue.path).toBe(path)
      expect(repair(compiler,[{op:'add',path,value:{x:1}}]).ok).toBe(true)
    }
    const unsetCompiler=make(template,context)
    failed(unsetCompiler.submit({submission:{mode:'edit',updates:{[key]:{unset:['inputs']}},coverage:{R1:[key]}}}))
    expect(repair(unsetCompiler,[{op:'remove',path:`/updates/${key}/unset`},{op:'add',path:`/updates/${key}/${section}`,value:{inputs:{x:1}}}]).ok).toBe(true)
    const compiler=make(template,context),add=template?'addForms':'addNodes',config=template?'values':'config'
    const result=compiler.submit({submission:{mode:'edit',[add]:[{key:'fresh',...(template?{template:'code'}:{kind:'code'}),[config]:{code:'function main(data){return {v:data.x}}'}}],coverage:{R1:[key]}}})
    expect(failed(result).issues.find(i=>i.code==='CODE_INPUT_UNMAPPED')!.path).toBe(`/${template?'addFormsByKey':'addNodesByKey'}/fresh/${config}/inputs`)
  })
  it('returns the actual parameter and unique literal names for journal auditing',()=>{
    expect(codeInputReads('function main(data){return {a:data.x,b:data["x"]}}')).toEqual({parameter:'data',names:['x']})
  })
})
