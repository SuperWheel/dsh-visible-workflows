import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { submissionSchemaIssues } from '../src/shared/planning-submission-schema.ts'
import { planningEditsSchema } from '../src/shared/planning-edits.ts'
import { allNodes, parseWorkflow, protectFixedNodes } from '../src/shared/workflow-validation.ts'
import { exportWorkflowPackage, parseWorkflowPackage, importWorkflowJson } from '../src/shared/workflow-format.ts'
import { authoringContext, authoringGraphContext } from '../src/shared/planning-authoring-context.ts'
import { templateAuthoringContext } from '../src/host/planning/template-catalog.ts'
import { templateContext, filling } from './fixtures/planning-compiler/template.ts'
import { WorkflowTemplateLibrary } from '../src/host/template-library.ts'
import type { Workflow } from '../src/shared/types.ts'

const fixtureRoot=new URL('./fixtures/t26/',import.meta.url)
const sources=JSON.parse(readFileSync(new URL('sources.json',fixtureRoot),'utf8')) as any[]
const load=(row:any,kind:string)=>JSON.parse(readFileSync(new URL(row.files[kind].file,fixtureRoot),'utf8'))
const accepted=(result:any):Workflow=>{expect(result,JSON.stringify(result?.feedback)).toMatchObject({ok:true});return result.value.candidate}
function semantic(flow:Workflow){
  const names=new Map(allNodes(flow).map((n,i)=>[n.id,'node-'+i]))
  const rewrite=(value:any):any=>typeof value==='string'?[...names].sort((a,b)=>b[0].length-a[0].length).reduce((s,[id,name])=>s.replaceAll(id,name),value):Array.isArray(value)?value.map(rewrite):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rewrite(v)])):value
  const graph=(g:any):any=>({nodes:g.nodes.map((n:any)=>({kind:n.kind,config:{...rewrite(n.config),...(n.config.body?{body:graph(n.config.body)}:{})}})),edges:g.edges.map(({source,target,port}:any)=>[names.get(source),names.get(target),port??'default']).sort()})
  return graph(flow)
}
function online(c:TemplateFillingCompiler,wire:any){
  const schemas=[c.nextSchema,c.schema];schemas.forEach(s=>assertObjectJsonSchema(s))
  const issues=submissionSchemaIssues(schemas[0]!,wire)
  expect(issues.length).toBeGreaterThan(0)
  expect(c.rejectWire(wire,issues).ok).toBe(false)
  const result=c.repairUnique(schemas)
  if(result?.ok)for(const s of schemas)expect(validateJsonSchemaValue(s,result.repairedWire)).toEqual([])
  return result
}

describe('T26 原始提交离线回放',()=>{
  it('固定全部来源字节及 SHA-256',()=>{
    expect(createHash('sha256').update(readFileSync(new URL('sources.json',fixtureRoot))).digest('hex')).toBe('d1552ea14aceb7d8eedc48f6e50171a161f7fa3a72d68565f7640aa929a853e1')
    for(const row of sources)for(const file of Object.values(row.files) as any[]){
      const bytes=readFileSync(new URL(file.file,fixtureRoot))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256)
    }
  })
  for(const row of sources)it(row.name,()=>{
    const context=load(row,'context'),wire=load(row,'submission'),observations:any[]=[]
    const c=row.arm==='compact-repair'?new WorkflowAuthoringCompiler(context,{onSubmission:s=>observations.push(s)}):new TemplateFillingCompiler(context,{onSubmission:s=>observations.push(s)})
    // 预取完整冻结目录，仅为离线重建当时可用合同；不调用模型或工具。
    if(c instanceof TemplateFillingCompiler)c.queryTemplates(c.catalog().templates.map(t=>t.id))
    let candidate:Workflow
    if(row.arm==='compact-repair'){
      expect(validateJsonSchemaValue(c.nextSchema,wire)).toEqual([])
      candidate=accepted(c.submit(wire))
      for(const node of wire.submission.nodes.filter((n:any)=>n.description!==undefined))expect(allNodes(candidate).some(n=>n.note===node.description)).toBe(true)
      expect(c.snapshot().submissions).toBe(1)
    }else{
      candidate=accepted(online(c as TemplateFillingCompiler,wire))
      expect(c.snapshot().submissions).toBe(2)
      expect(observations.at(-1)).toMatchObject({patch:true,repairSummary:expect.stringContaining('Host 唯一修复')})
      const offline=new TemplateFillingCompiler(context);expect(offline.submit(wire).ok).toBe(false)
      expect(semantic(accepted(offline.repairUnique()))).toEqual(semantic(candidate))
    }
    if(row.files.candidate)expect(semantic(candidate)).toEqual(semantic(load(row,'candidate')))
    else {
      // 这两次历史模型修复失败，没有“模型修好”的版本。用明确需求构造独立期望。
      const expected=structuredClone(context.workflow),key=Object.keys(wire.submission.updates)[0]!,index=Number(key.slice(1))-1
      allNodes(expected)[index]!.config.text=wire.submission.updates[key].text
      expect(semantic(candidate)).toEqual(semantic(expected))
    }
  })
  it('replicate-r5 container 提示只指向 chains，不建议 values/container',()=>{
    const row=sources.find(r=>r.name==='replicate-container'),c=new TemplateFillingCompiler(load(row,'context'))
    const result=c.submit(load(row,'submission'));expect(result.ok).toBe(false)
    if(result.ok)return
    const text=result.feedback.issues.map(i=>i.message).join('\n')
    expect(text).toContain('chains[].container');expect(text).toContain('不能写入 values')
    expect(text).not.toMatch(/移到[^。]*values\/container/)
    // 还回放历史第二交，把 container 错写入 values 的版本。
    const wire=load(row,'submission')
    for(const form of wire.submission.forms)if(form.container){form.values.container=form.container;delete form.container}
    const second=new TemplateFillingCompiler(load(row,'context'));second.queryTemplates(second.catalog().templates.map(t=>t.id))
    expect(accepted(online(second,wire))).toBeDefined()
  })
})

describe('T26 备注合同与数据保留',()=>{
  for(const mode of ['compact','template'])it(mode+' 设置、保留、清除、超长和固定节点',()=>{
    const context=templateContext(),wire=filling()
    for(const form of wire.submission.forms)form.description='节点说明'
    const create=mode==='compact'?new WorkflowAuthoringCompiler(context):new TemplateFillingCompiler(context)
    if(mode==='compact'){wire.submission.nodes=wire.submission.forms.map(({template,values,...n}:any)=>({...n,kind:template,config:values}));delete wire.submission.forms}
    const workflow=accepted(create.submit(wire));expect(allNodes(workflow).every(n=>n.note==='节点说明')).toBe(true)
    context.workflow=workflow;context.operation='revise';context.workflow.revision=1
    const target=workflow.nodes.find(n=>n.kind==='template')!;target.fixed=true;context.targetNodeIds=[target.id]
    const key='n'+(allNodes(workflow).indexOf(target)+1)
    for(const description of ['新备注',null,undefined]){
      const c=mode==='compact'?new WorkflowAuthoringCompiler(context):new TemplateFillingCompiler(context)
      const edit={submission:{mode:'edit',updates:{[key]:description===undefined?{}:{description}},coverage:{R1:[key]}}}
      assertObjectJsonSchema(c.nextSchema);expect(validateJsonSchemaValue(c.nextSchema,edit)).toEqual([])
      const result=accepted(c.submit(edit));expect(result.nodes.find(n=>n.id===target.id)?.note).toBe(description===null?undefined:description??'节点说明')
      expect(()=>protectFixedNodes(workflow,result)).not.toThrow()
    }
    const long=mode==='compact'?new WorkflowAuthoringCompiler(context):new TemplateFillingCompiler(context)
    expect(long.submit({submission:{mode:'edit',updates:{[key]:{description:'字'.repeat(2001)}},coverage:{R1:[key]}}}).ok).toBe(false)
  })
  it('两种 EDIT 新增节点保留 description；内部 add-node 合同拒绝 null',()=>{
    for(const mode of ['compact','template']){
      const context=templateContext();context.operation='revise'
      const c=mode==='compact'?new WorkflowAuthoringCompiler(context):new TemplateFillingCompiler(context)
      const wire={submission:{mode:'edit',[mode==='compact'?'addNodes':'addForms']:[{key:'extra',description:'新增备注',...(mode==='compact'?{kind:'template',config:{text:'说明'}}:{template:'template',values:{text:'说明'}})}],removeLinks:[{source:'n1',target:'n2'}],addLinks:[{key:'a',source:'n1',target:'extra'},{key:'b',source:'extra',target:'n2'}],coverage:{R1:['extra']}}}
      expect(submissionSchemaIssues(c.nextSchema,wire)).toEqual([])
      expect(allNodes(accepted(c.submit(wire))).find(n=>n.kind==='template')?.note).toBe('新增备注')
    }
    const wire={baseDigest:'test',outcome:'candidate',edits:[{op:'add-node',key:'extra',kind:'template',title:'说明',config:{text:'说明'},note:null}]}
    expect(validateJsonSchemaValue(planningEditsSchema,wire).length).toBeGreaterThan(0)
    wire.edits[0]!.note='备注' as any
    expect(validateJsonSchemaValue(planningEditsSchema,wire)).toEqual([])
  })
  it('导入导出、复制与容器内备注保留；固定容器内只改备注可通过',()=>{
    const row=sources.find(r=>r.name==='compact-container'),flow=accepted(new WorkflowAuthoringCompiler(load(row,'context')).submit(load(row,'submission')))
    allNodes(flow).forEach(n=>{n.note='备注 '+n.title})
    expect(allNodes(parseWorkflow(flow)).map(n=>n.note)).toEqual(allNodes(flow).map(n=>n.note))
    const imported=parseWorkflowPackage(JSON.stringify(exportWorkflowPackage(flow)))
    expect(allNodes(imported.workflow).map(n=>n.note)).toEqual(allNodes(flow).map(n=>n.note))
    expect(allNodes(importWorkflowJson(JSON.stringify(exportWorkflowPackage(flow)),'copy').workflow).map(n=>n.note)).toEqual(allNodes(flow).map(n=>n.note))
    const parent=flow.nodes.find(n=>n.config.body)!;parent.fixed=true
    const after=structuredClone(flow);allNodes(after).forEach(n=>n.note='更新')
    expect(()=>protectFixedNodes(flow,after)).not.toThrow()
    after.nodes.find(n=>n.id===parent.id)!.config.body!.nodes[0]!.config.cache='reuse'
    expect(()=>protectFixedNodes(flow,after)).toThrow('固定')
  })
  it('保存模板与重新实例化保留容器内外备注',()=>{
    const root=mkdtempSync(join(tmpdir(),'t26-template-'))
    try{
      const row=sources.find(r=>r.name==='compact-container'),flow=accepted(new WorkflowAuthoringCompiler(load(row,'context')).submit(load(row,'submission')))
      allNodes(flow).forEach(n=>n.note='备注 '+n.title)
      const library=new WorkflowTemplateLibrary(root),saved=library.save(flow,{title:'备注模板',selection:{nodeIds:flow.nodes.map(n=>n.id),scopePath:[],expectedRevision:flow.revision}})
      const restored=new WorkflowTemplateLibrary(root).instantiate(saved.id,'new-workspace').workflow
      expect(allNodes(restored).map(n=>n.note)).toEqual(allNodes(flow).map(n=>n.note))
    }finally{rmSync(root,{recursive:true,force:true})}
  })
  it('只给编辑目标节点最多300字只读备注',()=>{
    const context=templateContext();context.operation='revise';context.targetNodeIds=[context.workflow.nodes[0]!.id]
    context.workflow.nodes.forEach(n=>n.note='注'.repeat(1000))
    for(const view of [authoringGraphContext(context),authoringContext(context,'修改目标').graph!.nodes]){
      expect(view[0]!.note).toHaveLength(300);expect(view[1]!.note).toBeUndefined()
    }
    expect(JSON.stringify(templateAuthoringContext(context,'修改目标'))).not.toContain('注'.repeat(301))
  })
})

describe('T26 B1/B2 唯一修复边界',()=>{
  const misplaced=()=>{const wire=filling();wire.submission.forms[1].text=wire.submission.forms[1].values.text;delete wire.submission.forms[1].values.text;return wire}
  it.each([false,true])('B1 缺少 values 或同值重复：%s',duplicate=>{
    const wire=misplaced();if(duplicate)wire.submission.forms[1].values.text=wire.submission.forms[1].text;else delete wire.submission.forms[1].values
    expect(accepted(online(new TemplateFillingCompiler(templateContext()),wire))).toBeDefined()
  })
  it('冲突保留草稿且不消耗 Host 修复额度',()=>{
    const wire=misplaced();wire.submission.forms[1].values.text='不同'
    const c=new TemplateFillingCompiler(templateContext());expect(c.submit(wire).ok).toBe(false)
    const before=c.snapshot();expect(c.repairUnique()).toBeUndefined();expect(c.snapshot()).toEqual(before)
  })
  it('外部字段未知或修好后仍不满足合同不能接受',()=>{
    for(const mutate of [(w:any)=>w.submission.forms[1].typo=1,(w:any)=>delete w.submission.title,(w:any)=>w.submission.forms[1].text=42]){
      const wire=misplaced();mutate(wire);const c=new TemplateFillingCompiler(templateContext())
      expect(online(c,wire)).toBeUndefined();expect(c.snapshot().submissions).toBe(1);expect(c.snapshot().document).toBeUndefined()
    }
  })
  const container=()=>{
    const row=sources.find(r=>r.name==='replicate-container');return {row,wire:load(row,'submission'),context:load(row,'context')}
  }
  it.each([false,true])('B2 新建 chain 或追加现有 chain：%s',keep=>{
    const context=templateContext(),wire={submission:{mode:'create',title:'容器',forms:[
      {key:'start',template:'input',values:{fields:[]}},
      {key:'each',template:'iteration',values:{iterator:'input.items',outputVariable:'itemText.text'}},
      {key:'itemText',template:'template',values:{text:'项：{{item}}'},container:'each'},
      {key:'result',template:'output',values:{text:'{{each.text}}',outputName:'result'}},
      ...(keep?[{key:'before',template:'template',values:{text:'前置'}}]:[]),
    ],chains:[{key:'main',nodes:['start','each','result']},...(keep?[{key:'body',container:'each',nodes:['before']}]:[])],coverage:{R1:['itemText']}}}
    wire.submission.forms[0]!.values={fields:[{name:'items',label:'条目',required:true,type:'json'}]} as any
    const c=new TemplateFillingCompiler(context);c.queryTemplates(['iteration'])
    const candidate=accepted(online(c,wire)),body=allNodes(candidate).find(n=>n.kind==='iteration')!.config.body!
    expect(body.nodes.some(n=>n.config.text==='项：{{item}}')).toBe(true)
    if(keep){const before=body.nodes.find(n=>n.config.text==='前置')!,item=body.nodes.find(n=>n.config.text==='项：{{item}}')!;expect(body.edges.some(e=>e.source===before.id&&e.target===item.id)).toBe(true)}
  })
  it.each(['non-container','multiple-chains','other-chain','two-positions'])('B2 不猜测：%s',kind=>{
    const {wire,context}=container(),form=wire.submission.forms.find((f:any)=>f.container),chain=wire.submission.chains.find((c:any)=>c.container)
    if(kind==='non-container')form.container='start'
    if(kind==='multiple-chains')wire.submission.chains.push({...chain,key:'second'})
    if(kind==='other-chain')wire.submission.chains[0].nodes.push(form.key)
    if(kind==='two-positions')form.values.container=form.container
    const c=new TemplateFillingCompiler(context);expect(c.submit(wire).ok).toBe(false);expect(c.repairUnique()).toBeUndefined();expect(c.snapshot().submissions).toBe(1)
  })
  it('B2 多个尚未排序的内部节点不能用表单顺序猜 chain',()=>{
    const {wire,context}=container();wire.submission.chains=wire.submission.chains.filter((c:any)=>!c.container)
    const c=new TemplateFillingCompiler(context);expect(c.submit(wire).ok).toBe(false);expect(c.repairUnique()).toBeUndefined()
  })
  it('固定节点的执行字段和非目标备注仍受保护',()=>{
    const context=templateContext();context.operation='revise';context.workflow.nodes[0]!.fixed=true;context.targetNodeIds=[context.workflow.nodes[0]!.id]
    for(const C of [WorkflowAuthoringCompiler,TemplateFillingCompiler]){
      const c=new C(context),wire={submission:{mode:'edit',updates:{n1:{title:'偷偷改名'}},coverage:{R1:['n1']}}}
      expect(submissionSchemaIssues(c.nextSchema,wire).length).toBeGreaterThan(0)
      expect(()=>c.submit(wire)).toThrow()
      expect(()=>new C(context).submit({submission:{mode:'edit',updates:{n2:{description:'越界'}},coverage:{R1:['n2']}}})).toThrow()
    }
  })
  it('已有草稿时的线上拒绝不能顺带修复旧草稿',()=>{
    const c=new TemplateFillingCompiler(templateContext());expect(c.submit(misplaced()).ok).toBe(false)
    const before=c.snapshot(),bad={submission:{mode:'repair',draftRevision:1,patches:[],extra:'拒绝'}}
    c.rejectWire(bad,submissionSchemaIssues(c.nextSchema,bad))
    expect(c.repairUnique([c.nextSchema,c.schema])).toBeUndefined()
    expect(c.snapshot()).toMatchObject({document:before.document,revision:before.revision,submissions:2})
  })
  it('修复仍占同一提交额度',()=>{
    const c=new TemplateFillingCompiler(templateContext(),{maxSubmissions:1});expect(c.submit(misplaced()).ok).toBe(false)
    expect(()=>c.repairUnique()).toThrow('上限');expect(c.snapshot().submissions).toBe(1)
  })
})

describe('T26 回退维护脚本',()=>{
  it('要求显式路径；dry-run 不写；apply 先保留字节级备份并递归删除',()=>{
    const root=mkdtempSync(join(tmpdir(),'t26-strip-'))
    try{
      const flow=templateContext().workflow;flow.nodes[0]!.note='外层';flow.nodes[0]!.config.body={nodes:[{...flow.nodes[1]!,note:'内层'}],edges:[]}
      const bytes=JSON.stringify({schema:2,workflows:[flow],presets:[]}),file=join(root,'library.json');writeFileSync(file,bytes)
      const run=(args:string[])=>spawnSync(process.execPath,['scripts/strip-node-notes.mjs',...args],{encoding:'utf8'})
      expect(run([]).status).toBe(1)
      const dry=run([root]);expect(dry.status,dry.stderr).toBe(0);expect(JSON.parse(dry.stdout).nodes).toHaveLength(2);expect(readFileSync(file,'utf8')).toBe(bytes);expect(readdirSync(root)).toEqual(['library.json'])
      const applied=run([root,'--apply']);expect(applied.status,applied.stderr).toBe(0)
      const report=JSON.parse(applied.stdout);expect(readFileSync(report.backup,'utf8')).toBe(bytes)
      expect(allNodes(JSON.parse(readFileSync(file,'utf8')).workflows[0]).every(n=>!Object.hasOwn(n,'note'))).toBe(true)
      expect(JSON.parse(run([root,'--apply']).stdout).backup).toBeUndefined()
    }finally{rmSync(root,{recursive:true,force:true})}
  })
})
