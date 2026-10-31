import {describe,expect,it} from 'vitest'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {cases,contextFor,oracle} from '../scripts/benchmarks/workflow-compiler.ts'
import {freezePair,runPairArm,runPaired,type PairConfig} from '../scripts/benchmarks/template-fill-paired.ts'
import {greetingSubmission} from '../scripts/benchmarks/template-fill-paired-self-test.ts'
import {TemplateFillingCompiler} from '../src/shared/planning-template-compiler.ts'
import {completeToolArgumentJson,parseToolArguments} from '../src/shared/planning-tool-arguments.ts'
import {assertObjectJsonSchema,validateJsonSchemaValue} from '@deepseek-ai/dsh-tools'

// Only verbatim submissions/argument strings; provenance is a journal path + line.
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/t10-authoring/replicate-r5-feedback.json',import.meta.url),'utf8')) as any[]
const fixture=(caseId:string)=>fixtures.find(f=>f.caseId===caseId&&f.submission)!
const compilerFor=(caseId:string)=>{
  const compiler=new TemplateFillingCompiler(contextFor(cases.find(c=>c.id===caseId)!))
  compiler.queryTemplates(compiler.catalog().templates.map(t=>t.id));return compiler
}
const accepted=(result:ReturnType<TemplateFillingCompiler['submit']>)=>{if(!result.ok)throw Error(JSON.stringify(result.feedback));return result.value.candidate!}
const singleIssue=(result:ReturnType<TemplateFillingCompiler['submit']>)=>{if(result.ok)throw Error('Expected ambiguity');expect(result.feedback.issues).toHaveLength(1);return result.feedback}
const config=JSON.parse(readFileSync(new URL('../scripts/benchmarks/t09-config.json',import.meta.url),'utf8')) as PairConfig

describe('R5 authoring feedback, real submissions without a model',()=>{
  for(const caseId of ['container','large-edit','web-process','branch'])it(`accepts ${caseId} after any required title repair and passes its oracle`,async()=>{
    const wire=fixture(caseId).submission,before=structuredClone(wire),compiler=compilerFor(caseId)
    const first=compiler.submit(wire)
    const unique=!first.ok?compiler.repairUnique():undefined
    if(!first.ok&&!unique)expect(first.feedback.issues).toEqual([expect.objectContaining({path:'/title'})])
    const flow=accepted(first.ok?first:unique??compiler.submit({submission:{mode:'repair',draftRevision:first.feedback.draftRevision,patches:[{op:'add',path:'/title',value:caseId}]}}))
    expect(wire).toEqual(before);expect(compiler.snapshot().submissions).toBe(first.ok?1:2)
    expect((await oracle(flow,cases.find(c=>c.id===caseId)!)).passed).toBe(true)
  })
  it.each(['container','scope'])('drops redundant form %s, including nested ancestry',field=>{
    const wire=structuredClone(fixture('container').submission),compiler=compilerFor('container')
    for(const form of wire.submission.forms)if(form.container){delete form.container;form[field]=field==='container'?'iterate':['iterate']}
    const initial=compiler.submit(wire);accepted(initial.ok?initial:compiler.repairUnique()!)
    expect((compiler.snapshot().document as any).formsByKey.inner_gen).not.toHaveProperty(field)
    const nested=structuredClone(wire)
    nested.submission.forms.push({key:'nested',template:'iteration',values:{iterator:'input.items',outputVariable:'inner_gen.text'},scope:['iterate']})
    nested.submission.chains[1].nodes=['nested']
    nested.submission.forms.find((f:any)=>f.key==='iterate').values.outputVariable='nested.text'
    nested.submission.chains.push({key:'nested_body',container:'nested',nodes:['inner_gen','inner_out']})
    for(const form of nested.submission.forms)if(['inner_gen','inner_out'].includes(form.key))form[field]=field==='container'?'nested':['iterate','nested']
    const second=compilerFor('container'),result=second.submit(nested);accepted(result.ok?result:second.repairUnique()!)
  })
  it.each(['container','scope'])('reports exactly one chain-only ambiguity for conflicting %s and accepts its advertised deletion',field=>{
    const wire=structuredClone(fixture('container').submission),compiler=compilerFor('container')
    for(const form of wire.submission.forms)delete form.container
    wire.submission.forms.find((f:any)=>f.key==='inner_gen')[field]=field==='container'?'other':['other']
    const feedback=singleIssue(compiler.submit(wire)),path='/formsByKey/inner_gen/'+field
    expect(feedback.issues[0]!.message).toContain('chains[].container')
    expect(feedback.allowedPaths).toEqual([path,'/chainsByKey/inner_body'])
    expect(feedback.issues[0]!.message).not.toContain('values/container')
    const repair={submission:{mode:'repair',draftRevision:feedback.draftRevision,patches:[{op:'remove',path}]}}
    assertObjectJsonSchema(compiler.nextSchema);expect(validateJsonSchemaValue(compiler.nextSchema,repair)).toEqual([])
    accepted(compiler.submit(repair))
  })
  it('rejects form container on a root node with one actionable issue',()=>{
    const wire=structuredClone(fixture('container').submission),compiler=compilerFor('container')
    for(const form of wire.submission.forms)delete form.container
    wire.submission.forms.find((f:any)=>f.key==='start').container='iterate'
    const feedback=singleIssue(compiler.submit(wire))
    expect(feedback.allowedPaths).toContain('/formsByKey/start/container')
    expect(feedback.allowedPaths).toContain('/chainsByKey/main')
    accepted(compiler.submit({submission:{mode:'repair',draftRevision:1,patches:[{op:'remove',path:'/formsByKey/start/container'}]}}))
  })
  it.each(['forms','formsByKey','addForms'])('lifts actual config fields in %s, including identical duplicates',root=>{
    const wire=greetingSubmission('template-fill'),greet=wire.submission.forms[1]
    greet.text=greet.values.text
    if(root==='formsByKey'){wire.submission.formsByKey=Object.fromEntries(wire.submission.forms.map(({key,...rest}:any)=>[key,rest]));delete wire.submission.forms}
    else if(root==='addForms'){
      const context=contextFor(cases.find(c=>c.id==='local-edit')!),edit={submission:{mode:'edit',addForms:[{key:'extra',template:'template',text:'extra'}],addLinks:[{key:'extra_in',source:'n1',target:'extra'},{key:'extra_out',source:'extra',target:'n3'}],coverage:{R1:['extra']}}}
      const c=new TemplateFillingCompiler(context);expect(c.submit(edit).ok).toBe(false);accepted(c.repairUnique()!);return
    }else delete greet.values
    const c=compilerFor('greeting');expect(c.submit(wire).ok).toBe(false);accepted(c.repairUnique()!)
  })
  it.each(['create','edit'])('reports one conflicting config field in %s, and one deletion fixes it',mode=>{
    const wire=mode==='create'?greetingSubmission('template-fill'):structuredClone(fixture('large-edit').submission)
    const raw=mode==='create'?wire.submission.forms[1]:wire.submission.updates.n30
    raw.text='different';raw.values={text:mode==='create'?'你好，{{input.name}}！':'结果：{{input.text}}'}
    const compiler=compilerFor(mode==='create'?'greeting':'large-edit'),feedback=singleIssue(compiler.submit(wire))
    const path=mode==='create'?'/formsByKey/greet':'/updates/n30'
    expect(feedback.allowedPaths).toEqual([path+'/text',path+'/values/text'])
    expect(feedback.issues[0]!.message).toContain('值不同')
    accepted(compiler.submit({submission:{mode:'repair',draftRevision:1,patches:[{op:'remove',path:path+'/text'}]}}))
  })
  it.each(['create','edit'])('unknown %s fields advise deletion, never values/<typo>',mode=>{
    const wire=mode==='create'?greetingSubmission('template-fill'):structuredClone(fixture('large-edit').submission)
    const raw=mode==='create'?wire.submission.forms[1]:wire.submission.updates.n30
    // 单独验证未知字段；T26 的真实 text 归位另有计数与范围测试。
    if(mode==='edit'){raw.values={text:raw.text};delete raw.text}
    raw.typo='unknown'
    const compiler=compilerFor(mode==='create'?'greeting':'large-edit'),feedback=singleIssue(compiler.submit(wire))
    expect(feedback.issues[0]!.message).toContain('删除不支持的字段')
    expect(feedback.issues[0]!.message).not.toContain('values/typo')
    accepted(compiler.submit({submission:{mode:'repair',draftRevision:1,patches:[{op:'remove',path:(mode==='create'?'/formsByKey/greet':'/updates/n30')+'/typo'}]}}))
  })
  it.each([undefined,'','  '])('requires explicit repair of missing/empty create title %s without changing the schema',title=>{
    const wire=greetingSubmission('template-fill');if(title===undefined)delete wire.submission.title;else wire.submission.title=title
    wire.submission.description='  '+('说明'.repeat(120))+'  '
    const compiler=compilerFor('greeting'),before=JSON.stringify(compiler.schema)
    const first=compiler.submit(wire);if(first.ok)throw Error('Expected explicit title repair')
    const feedback=first.feedback
    expect(feedback.issues.every(issue=>issue.path==='/title')).toBe(true)
    expect(feedback.allowedPaths).toContain('/title')
    expect(accepted(compiler.submit({submission:{mode:'repair',draftRevision:feedback.draftRevision,patches:[{op:'add',path:'/title',value:'用户指定标题'}]}})).title).toBe('用户指定标题')
    expect(JSON.stringify(compiler.schema)).toBe(before)
    const initial=(compiler.schema.properties!.submission as any).oneOf[0]
    expect(initial.required).toContain('title')
  })
  it('does not infer a create title from summary; keeps omitted edit title and rejects invalid title types',()=>{
    for(const summary of ['  摘要  ','  ']){
      const wire=greetingSubmission('template-fill');delete wire.submission.title;wire.submission.summary=summary
      expect(singleIssue(compilerFor('greeting').submit(wire)).issues[0]!.path).toBe('/title')
    }
    const edit=compilerFor('large-edit');expect(edit.submit(fixture('large-edit').submission).ok).toBe(false)
    expect(accepted(edit.repairUnique()!).title).toBe(contextFor(cases.find(c=>c.id==='large-edit')!).workflow.title)
    const wire=greetingSubmission('template-fill');wire.submission.title=null
    expect(singleIssue(compilerFor('greeting').submit(wire)).issues[0]!.path).toBe('/title')
  })
})

describe('shared conservative tool-argument completion, both arms',()=>{
  it('replays the real one-brace-short large-edit tool call in one submission',async()=>{
    const f=fixtures.find(f=>f.arguments&&f.caseId==='large-edit')!,args=parseToolArguments(f.arguments)
    expect(completeToolArgumentJson(f.arguments)).toBe(f.arguments+'}')
    expect((await oracle(accepted(compilerFor(f.caseId).submit(args)),cases.find(c=>c.id===f.caseId)!)).passed).toBe(true)
  })
  it('keeps the other real greeting failures rejected: trailing comma and wrong closing bracket',()=>{
    for(const f of fixtures.filter(f=>f.arguments&&f.caseId==='greeting'))expect(()=>parseToolArguments(f.arguments)).toThrow(SyntaxError)
  })
  it.each(['{"a":{"b":[1','{"text":"a\\\\\\\"}[]","x":[{}','['])('completes only missing closers: %s',raw=>{
    expect(()=>parseToolArguments(raw)).not.toThrow()
    expect(completeToolArgumentJson(raw).startsWith(raw)).toBe(true)
  })
  it.each(['{"a":"unterminated','{"a":"escaped\\','{"a":','{"a":1,','{"a" 1','{"a":[1}','{"a":tru','{"a":1e','{"a":1}junk','[[[[','{"a":1,}'])('rejects other corruption: %s',raw=>expect(()=>parseToolArguments(raw)).toThrow())
  it('preserves valid JSON bytes and leaves invalid values to normal schema validation',()=>{
    const raw=' { "text": "\\\\\\\"}[]" } \n'
    expect(completeToolArgumentJson(raw)).toBe(raw)
    const wire=greetingSubmission('template-fill',true),args=parseToolArguments(JSON.stringify(wire).slice(0,-1))
    expect(singleIssue(compilerFor('greeting').submit(args)).issues[0]!.path).toBe('/title')
  })
  it('the paired driver accepts a missing closing suffix on either arm without another request',async()=>{
    const item=config.cases.find(c=>c.id==='greeting')!,frozen=freezePair({...config,repeats:1,cases:[item]})
    const report=await runPaired(frozen,{async request(_body,slot){return {message:{role:'assistant',tool_calls:[{id:'truncated',function:{name:'structured_output',arguments:JSON.stringify(greetingSubmission(slot.arm)).slice(0,-1)}}]}}}},async()=>({passed:true}))
    expect(report.results.map(r=>[r.status,r.requests,r.submissions])).toEqual([['success',1,1],['success',1,1]])
  })
})

describe('T21 template-boundary compact request bytes',()=>{
  // Keep both historical T10 and T21.1 request fixtures immutable.
  const historical=JSON.parse(readFileSync(new URL('./fixtures/t10-authoring/compact-request-digests.json',import.meta.url),'utf8'))
  const canonical=JSON.parse(readFileSync(new URL('./fixtures/t21-canonical-request-digests.json',import.meta.url),'utf8'))
  // T24 r26 参数路径合同升级后重录；保留全部旧请求摘要。
  const r26=JSON.parse(readFileSync(new URL('./fixtures/t24/verified-file-write-1.1-request-digests.json',import.meta.url),'utf8'))
  // T24 r28 无草稿 repair 提示（PATCH_NO_DRAFT）及 if 条件示例更新后重录。
  const r28=JSON.parse(readFileSync(new URL('./fixtures/t24/patch-no-draft-request-digests.json',import.meta.url),'utf8'))
  // 2026-10-26 节点目录补上传附件结构与读取方式（设计 26 §6.1）后重录。
  const current=JSON.parse(readFileSync(new URL('./fixtures/t24/attachment-catalog-request-digests.json',import.meta.url),'utf8'))
  it.each(config.cases)('pins session-tool skeleton CREATE and EDIT request bytes: $id',async item=>{
    const frozen=freezePair({...config,repeats:1,cases:[item]}),slot=frozen.schedule.find(s=>s.arm==='compact-repair')!,bodies:string[]=[]
    await runPairArm(frozen,slot,{async request(body){
      bodies.push(JSON.stringify(body));if(bodies.length===3)return {error:'OFFLINE_CAPTURE_STOP'}
      return {message:{role:'assistant',tool_calls:[{id:'capture-'+bodies.length,function:bodies.length===1?{name:'planner_node_catalog',arguments:'{"kinds":["template"],"includeSchema":false}'}:{name:'structured_output',arguments:JSON.stringify(item.context.operation==='create'?{submission:{...greetingSubmission('compact-repair').submission,title:42}}:{submission:{mode:'edit',title:42,coverage:{R1:['n2']}}})}}]}}
    }},async()=>{throw Error('Capture cannot run oracle')})
    const digests=bodies.map(b=>createHash('sha256').update(b).digest('hex'))
    expect(digests).toEqual(current.find((row:any)=>row.caseId===item.id).digests)
    for(const [index,digest]of digests.entries())expect(digest).not.toBe(historical.find((row:any)=>row.caseId===item.id).digests[index])
    for(const [index,digest]of digests.entries())expect(digest).not.toBe(canonical.find((row:any)=>row.caseId===item.id).digests[index])
    for(const [index,digest]of digests.entries())expect(digest).not.toBe(r26.find((row:any)=>row.caseId===item.id).digests[index])
    for(const [index,digest]of digests.entries())expect(digest).not.toBe(r28.find((row:any)=>row.caseId===item.id).digests[index])
  })
})
