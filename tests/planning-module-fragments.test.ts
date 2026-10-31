import { describe,it,expect,vi } from 'vitest'
import { mkdtempSync,rmSync,readFileSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertObjectJsonSchema,validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { AuthoringCore } from '../src/shared/planning-authoring-core.ts'
import { expandModuleFragments,verifiedModuleInstances,instanceEdges,rewriteFragmentParameters } from '../src/shared/planning-module-fragments.ts'
import { fragmentModules,fragmentCatalog } from '../src/shared/planning-module-fragment-contract.ts'
import { businessModuleCatalog } from '../src/shared/planning-business-modules.ts'
import { authoringContext,authoringGraphContext } from '../src/shared/planning-authoring-context.ts'
import { planningEditView } from '../src/shared/planning-edits.ts'
import { compileHandoffChanges,planningHandoffSchema } from '../src/shared/planning-handoff.ts'
import { materializePlanningCandidate } from '../src/shared/planning-projection.ts'
import { allNodes,parseWorkflow } from '../src/shared/workflow-validation.ts'
import { exportWorkflowJson,importWorkflowJson } from '../src/shared/workflow-format.ts'
import { jsonDigest } from '../src/shared/planning-repair.ts'
import { jsonDigest as portableDigest } from '../src/shared/json-digest.ts'
import { arrangeNodes } from '../src/shared/canvas-layout.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { createExecutionAdapters,httpRequest } from '../src/host/execution-adapters.ts'
import { ToolCatalog } from '../src/host/tool-catalog.ts'
import { copyWorkflowCard } from '../src/client/workflow-home-copy.ts'
import { WorkflowStore } from '../src/client/store.ts'
import type { Workflow,WorkflowAPI } from '../src/shared/types.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'
// @ts-expect-error maintenance CLI intentionally stays plain ESM
import { stripNodeNotes } from '../scripts/strip-node-notes.mjs'

const parameters=(rows='{{prepare.text}}')=>({title:'核对结果',columns:[{key:'name',label:'姓名'}],emptyText:'无记录',rows})
const declaration=(key='table',rows='{{prepare.text}}')=>({key,module:'structured-result-table@1.0.0',parameters:parameters(rows)})
function create(){return {mode:'create',title:'组合片段',nodes:[
  {key:'start',kind:'input',config:{fields:[{name:'rows',label:'数据',required:true,type:'json'}]}},
  {key:'prepare',kind:'template',config:{text:'{{input.rows}}'}},
  {key:'result',kind:'output',config:{text:'{{table.text}} ({{table.count}})',outputName:'result'}},
],modules:[declaration()],chains:[{key:'main',nodes:['start','prepare','table','result']}],coverage:{R1:['table','result']}}}
function compile(input=create()){
  const c=new WorkflowAuthoringCompiler(templateContext()),r=c.submit({submission:input})
  if(!r.ok)throw Error(JSON.stringify(r.feedback));return r.value
}
function revision(flow:Workflow){return {...templateContext(),operation:'revise' as const,workflow:{...structuredClone(flow),revision:1}}}
function filling(input:any){const doc=structuredClone(input);doc.forms=doc.nodes.map(({kind,config,...n}:any)=>({...n,template:kind,values:config}));delete doc.nodes;return doc}
function expectFailure(input:any,code:string){const c=new WorkflowAuthoringCompiler(templateContext()),r=c.submit({submission:input});expect(r.ok).toBe(false);if(r.ok)throw Error('expected failure');expect(r.feedback.issues.some(i=>i.code===code)).toBe(true);expect(r.feedback.allowedPaths.every(p=>!p.includes('__render'))).toBe(true);return {c,...r}}

describe('T24.1 composable module fragments',()=>{
  it('pure expansion preserves input and splices ports into a normal chain',()=>{
    const core=new AuthoringCore(templateContext()),input=core.normalize(create()),before=structuredClone(input)
    const expanded=expandModuleFragments(input)
    expect(input).toEqual(before);expect(expanded.document.chainsByKey.main.nodes).toEqual(['start','prepare','table__render','result'])
    expect(expanded.document.nodesByKey.result.config.text).toBe('{{table__render.text}} ({{table__render.count}})')
    expect(expanded.document.nodesByKey.table__render.config.inputs.rows).toBe('{{prepare.text}}')
    const result=compile();expect(result.issues).toEqual([]);expect(verifiedModuleInstances(result.candidate!)).toHaveLength(1)
    expect(result.candidate!.nodes).toEqual(arrangeNodes(result.candidate!))
    expect(materializePlanningCandidate(result.output.graphJson,templateContext()).moduleInstances).toEqual(result.candidate!.moduleInstances)
    expect(allNodes(result.candidate!).find(n=>n.kind==='code')!.note).toBe('模块片段：结构化结果表格渲染 · table')
  })
  it.each(['literal','{{prepare}}','{{prepare.text | json}}'])('rejects non-reference rows %s',rows=>{const d=create();d.modules[0]!.parameters.rows=rows;const r=expectFailure(d,'MODULE_PARAMETERS');expect(r.feedback.allowedPaths).toEqual(['/modules/table/parameters/rows'])})
  it('rejects parameter errors, collisions, duplicate keys, unknown modules and branches',()=>{
    const d=create();d.modules[0]!.parameters.columns.push({key:'name',label:'duplicate'});expectFailure(d,'MODULE_PARAMETERS')
    const collision=create();collision.modules[0]!.key='prepare';expectFailure(collision,'DUPLICATE_KEY')
    const duplicate=create();duplicate.modules.push(declaration());expectFailure(duplicate,'MODULE_DECLARATION')
    const unknown=create();unknown.modules[0]!.module='reviewed-file-write@1.0.0';expectFailure(unknown,'MODULE_UNKNOWN')
    const branch:any=create();branch.links=[{key:'bad',source:'table',target:'result',port:'true'}];expectFailure(branch,'MODULE_BRANCH_SOURCE')
  })
  it('repairs undeclared output ports through the same draft and never exposes internal repair paths',()=>{
    const d=create();d.nodes[2]!.config.text='{{table.noSuchPort}}';const r=expectFailure(d,'MODULE_OUTPUT_PORT')
    expect(r.feedback.issues[0]!.message).toContain('text, count');expect(r.feedback.allowedPaths).toEqual(['/modules/table/parameters','/nodesByKey/result/config/text'])
    const repaired=r.c.submit({submission:{mode:'repair',draftRevision:r.feedback.draftRevision,patches:[{op:'replace',path:'/nodesByKey/result/config/text',value:'{{table.text}}'}]}});expect(repaired.ok).toBe(true)
    expect(r.feedback.remainingSubmissions).toBe(2)
    // A port error in downstream text must be repairable at the ORIGINAL user field as well.
  })
  it('rejects attempts to bypass public ports using internal role names',()=>{const d=create();d.nodes[2]!.config.text='{{table__render.text}}';expectFailure(d,'MODULE_INTERNAL_REFERENCE')})
  it('compiles two instances and resolves port references in expressions, selectors and parameters',()=>{
    const d=create();d.modules.push(declaration('second'));d.chains[0]!.nodes=['start','prepare','table','second','result'];d.nodes.splice(2,0,{key:'format',kind:'template',config:{text:'{% if table.count > 0 %}{{second.text}}{% endif %}'}});d.chains[0]!.nodes.splice(4,0,'format');d.nodes[3]!.config.text='{{format.text}}'
    const r=compile(d);expect(verifiedModuleInstances(r.candidate!)).toHaveLength(2)
    expect(r.candidate!.nodes.find(n=>n.kind==='output')!.config.text).not.toContain('table.')
    const missing=create();missing.nodes[2]!.config.text='{{table.missing}}';expectFailure(missing,'MODULE_OUTPUT_PORT')
  })
  it.each(['iteration','loop'])('supports fragments in %s with Host entry and layout',kind=>{
    const d:any=create();d.nodes.splice(1,1,{key:'container',kind,config:kind==='iteration'?{iterator:'input.rows',outputVariable:'table.text'}:{maxIterations:1,outputVariable:'table.text'}})
    d.modules[0].parameters.rows=kind==='iteration'?'{{item}}':'{{input.rows}}';d.nodes[2].config.text='{{container.output}}';d.chains=[{key:'outer',nodes:['start','container','result']},{key:'body',container:'container',nodes:['table']}];d.coverage={R1:['table','container','result']}
    const flow=compile(d).candidate!,container=flow.nodes.find(n=>n.kind===kind)!
    expect(container.config.body!.nodes.some(n=>n.kind==='input')).toBe(true);expect(container.config.body!.nodes).toEqual(arrangeNodes(container.config.body!))
    expect(verifiedModuleInstances(flow)).toHaveLength(1);expect(flow.moduleInstances![0]!.scope).toEqual([container.id])
    const rootOnly={...fragmentModules[0]!,scopes:'root' as const};expect(verifiedModuleInstances(flow,[rootOnly])).toEqual([]);expect(()=>expandModuleFragments(new AuthoringCore(templateContext()).normalize(d),[rootOnly])).toThrow('根作用域')
    const template=new TemplateFillingCompiler(templateContext(),{prefetch:['input','output',kind]}).submit({submission:filling(d)});if(!template.ok)throw Error(JSON.stringify(template.feedback));expect(template.value.candidate).toEqual(flow)
  })
  it('supports the full public 40-character fragment key without changing compiler caps',()=>{
    const d=create(),name='m'.repeat(40);d.modules[0]!.key=name;d.chains[0]!.nodes[2]=name;d.nodes[2]!.config.text='{{'+name+'.text}}';d.coverage.R1=[name,'result']
    expect(verifiedModuleInstances(compile(d).candidate!)[0]!.instanceKey).toBe(name)
  })
  it('keeps an instance key stable when the next edit assigns a colliding nN node ref',()=>{
    const d=create();d.modules[0]!.key='n1';d.chains[0]!.nodes[2]='n1';d.nodes[2]!.config.text='{{n1.text}}';d.coverage.R1=['n1','result']
    const flow=compile(d).candidate!,context=revision(flow),view=planningEditView(context),ref=view.modules![0]!.ref
    expect(ref).not.toBe('n1');expect(view.nodes.find(n=>n.ref==='@2')!.config.text).toBe('{{'+ref+'.text}}')
    const r=new WorkflowAuthoringCompiler(context).submit({submission:{mode:'edit',updateModules:{[ref]:{parameters:{...parameters('{{n3.text}}'),title:'再次修改'}}},coverage:{R1:[ref]}}})
    if(!r.ok)throw Error(JSON.stringify(r.feedback));expect(verifiedModuleInstances(r.value.candidate!)[0]!.instanceKey).toBe('n1')
  })
  it('rejects invalid multi-entry recipes instead of exposing recipe internals',()=>{
    const base=fragmentModules[0]!,fake={...base,recipe:(p:Record<string,unknown>)=>{const r=base.recipe(p);r.nodes.extra={kind:'template' as const,config:{text:'extra'}};return r}}
    const d=new AuthoringCore(templateContext()).normalize(create());expect(()=>expandModuleFragments(d,[fake])).toThrow('一入一出')
  })
  it.each(['branch','container'])('expands and verifies a Host recipe containing %s without shortcut edges',shape=>{
    const base=fragmentModules[0]!,fake={...base,recipe:(p:Record<string,unknown>)=>{
      const r=base.recipe(p)
      if(shape==='branch')return {...r,entry:'check',nodes:{...r.nodes,check:{kind:'if' as const,config:{logicGate:{operator:'IF',inputs:[{value:true}]}}},left:{kind:'template' as const,config:{text:'left'}},right:{kind:'template' as const,config:{text:'right'}}},chains:{left:{nodes:['left','render']},right:{nodes:['right','render']}},links:{yes:{source:'check',target:'left',port:'true'},no:{source:'check',target:'right',port:'false'}}}
      return {...r,entry:'repeat',exit:'render',nodes:{repeat:{kind:'loop' as const,config:{maxIterations:1,outputVariable:'inside.text'}},inside:{kind:'template' as const,config:{text:'body'}},...r.nodes},chains:{outer:{nodes:['repeat','render']},inner:{container:'repeat',nodes:['inside']}},links:{}}
    }}
    const core=new AuthoringCore(templateContext()),expanded=expandModuleFragments(core.normalize(create()),[fake]),result=core.compile(expanded.document),flow=result.candidate!
    const ids=new Map([['start','host-start'],['result','host-end'],...Object.entries(core.exportReservations().nodes).map(([key,id])=>[key.slice(1),id] as [string,string])]),roles=Object.fromEntries(Object.entries(expanded.instances[0]!.roles).map(([role,key])=>[role,ids.get(key)!])),p=rewriteFragmentParameters(expanded.instances[0]!.parameters,ids)
    flow.moduleInstances=[{instanceKey:'table',moduleId:fake.id,version:fake.version,implementationDigest:fake.implementationDigest,parameters:p,parametersDigest:jsonDigest(p),roles,scope:[],edges:instanceEdges(flow,new Set(Object.values(roles)))}]
    expect(verifiedModuleInstances(flow,[fake])).toHaveLength(1)
    const inner=shape==='branch'?roles.left!:roles.repeat!
    const consumer=structuredClone(flow);consumer.edges.push({id:'exit-consumer',source:roles.render!,target:'host-start'})
    expect(verifiedModuleInstances(consumer,[fake])).toHaveLength(1)
    const leak=structuredClone(flow);leak.edges.push({id:'inner-leak',source:inner,target:'host-start'})
    expect(verifiedModuleInstances(leak,[fake])).toEqual([])
    if(shape==='branch')expect(flow.edges.some(e=>e.source===roles.check&&e.target===roles.render)).toBe(false)
    else expect(allNodes(flow).find(n=>n.id===roles.repeat)!.config.body!.nodes.some(n=>n.kind==='input')).toBe(true)
  })
  it('independently verifies definitions and detaches altered config, roles, edges, version or digest',()=>{
    const flow=compile().candidate!
    for(const mutate of [
      (w:Workflow)=>{w.nodes.find(n=>n.kind==='code')!.config.code+='\n// manual'},
      (w:Workflow)=>{w.moduleInstances![0]!.roles.render='host-start'},
      (w:Workflow)=>{w.moduleInstances![0]!.version='9.0.0'},
      (w:Workflow)=>{w.moduleInstances![0]!.implementationDigest='0'.repeat(64)},
      (w:Workflow)=>{w.moduleInstances![0]!.parameters.title='forged';w.moduleInstances![0]!.parametersDigest=jsonDigest(w.moduleInstances![0]!.parameters)},
    ]){const changed=structuredClone(flow);mutate(changed);const before=structuredClone(changed);expect(verifiedModuleInstances(changed)).toEqual([]);expect(changed).toEqual(before);expect(planningEditView(revision(changed)).nodes.some(n=>n.kind==='code')).toBe(true)}
    const cosmetic=structuredClone(flow),render=cosmetic.nodes.find(n=>n.kind==='code')!;render.note='自己的备注';render.title='自己的标题';render.x+=100;render.y+=250
    expect(verifiedModuleInstances(cosmetic)).toHaveLength(1)
    // Rewiring outside the instance (dropped input, extra consumer) is ordinary editing, not detachment.
    const rewired=structuredClone(flow),renderId=rewired.moduleInstances![0]!.roles.render!
    rewired.edges=[...rewired.edges.filter(e=>e.target!==renderId),{id:'extra-consumer',source:renderId,target:'host-start'}]
    expect(verifiedModuleInstances(rewired)).toHaveLength(1)
  })
  it('keeps an existing instance valid when a later edit adds a consumer of its output port',()=>{
    const flow=compile().candidate!,context=revision(flow)
    const r=new WorkflowAuthoringCompiler(context).submit({submission:{mode:'edit',addNodes:[{key:'extra',kind:'template',config:{text:'副本：{{table.text}}'}}],addLinks:[{key:'feed',source:'table',target:'extra'}],coverage:{R1:['extra']}}})
    if(!r.ok)throw Error(JSON.stringify(r.feedback))
    const after=r.value.candidate!;expect(verifiedModuleInstances(after)).toHaveLength(1)
    const render=after.moduleInstances![0]!.roles.render!,extra=after.nodes.find(n=>n.config.text==='副本：{{'+render+'.text}}')
    expect(extra).toBeDefined();expect(after.edges.some(e=>e.source===render&&e.target===extra!.id)).toBe(true)
  })
  it('names the module route when a parent field edit targets an internal node instead of failing as invalid JSON (Desktop r32 C)',()=>{
    const flow=compile().candidate!,instance=flow.moduleInstances![0]!,internal=Object.values(instance.roles)[0]!
    const handoff=planningHandoffSchema.parse({version:1,mode:'edit',changes:[{op:'set-config',nodeId:internal,field:'inputs',value:{file_path:'reports/new.md'}}],constraints:[],evidenceRefs:[]})
    if(handoff.mode==='module')throw Error('Expected field handoff')
    const error=(()=>{try{compileHandoffChanges(handoff,revision(flow))}catch(caught){return caught as Error&{code?:string}}throw Error('expected rejection')})()
    expect(error.code).toBe('MODULE_INTERNAL_NODE');expect(error.message).toContain(`instanceKey:'${instance.instanceKey}'`);expect(error.message).toContain('当前参数：{')
  })
  it('collapses edit context and protects internal nodes, permits parameter updates preserving IDs/layout/notes',()=>{
    const flow=compile().candidate!,render=flow.nodes.find(n=>n.kind==='code')!;render.note='保留备注'
    const context=revision(flow),view=planningEditView(context),compiler=new WorkflowAuthoringCompiler(context)
    expect(view.nodes.some(n=>n.kind==='code')).toBe(false);expect(view.modules).toEqual([{ref:'table',module:'structured-result-table@1.0.0',parameters:expect.objectContaining({rows:'{{n3.text}}'}),ports:fragmentModules[0]!.outputs}])
    expect(authoringContext(context,'改表标题').graph!.modules).toEqual(view.modules);expect(authoringGraphContext(context).some(n=>n.kind==='code')).toBe(false)
    const initial=(compiler.schema.properties!.submission as any).oneOf[0];expect(initial.properties.updates.properties.n4).toBeUndefined()
    const result=compiler.submit({submission:{mode:'edit',updateModules:{table:{parameters:{...parameters('{{n3.text}}'),title:'新标题'}}},coverage:{R1:['table']}}})
    if(!result.ok)throw Error(JSON.stringify(result.feedback));const after=result.value.candidate!
    expect(verifiedModuleInstances(after)).toHaveLength(1);expect(after.nodes.map(({id,x,y})=>({id,x,y}))).toEqual(flow.nodes.map(({id,x,y})=>({id,x,y})));expect(after.nodes.find(n=>n.id===render.id)!.note).toBe('保留备注')
    expect(after.nodes.find(n=>n.id===render.id)!.config.inputs!.specification).toMatchObject({title:'新标题'})
    const bad=new WorkflowAuthoringCompiler(context).submit({submission:{mode:'edit',updates:{n4:{set:{code:'function main(){return {}}'}}},coverage:{R1:['n4']}}});expect(bad.ok).toBe(false);if(!bad.ok)expect(bad.feedback.allowedPaths).toEqual(['/updates','/updateModules'])
  })
  it.each([WorkflowAuthoringCompiler,TemplateFillingCompiler])('adds/removes entire instances with explicit caller-managed boundary links through $name',C=>{
    const submit=(c:InstanceType<typeof C>,doc:any)=>{if(C===TemplateFillingCompiler)for(const change of Object.values(doc.updates??{}) as any[]){if(change.set){change.values=change.set;delete change.set}}return c.submit({submission:doc})}
    const flow=compile().candidate!,context={...revision(flow),targetNodeIds:flow.nodes.map(n=>n.id)},compiler=new C(context)
    const removed=submit(compiler,{mode:'edit',removeModules:['table'],removeLinks:[{source:'n3',target:'table'},{source:'table',target:'n2'}],addLinks:[{key:'bridge',source:'n3',target:'n2'}],updates:{n2:{set:{text:'{{n3.text}}'}}},coverage:{R1:['n3','n2']}})
    if(!removed.ok)throw Error(JSON.stringify(removed.feedback));expect(removed.value.candidate!.moduleInstances).toEqual([]);expect(allNodes(removed.value.candidate!).some(n=>n.kind==='code')).toBe(false)
    const addContext=revision(removed.value.candidate!),add=submit(new C(addContext),{mode:'edit',addModules:[declaration('added','{{n3.text}}')],removeLinks:[{source:'n3',target:'n2'}],addLinks:[{key:'in',source:'n3',target:'added'},{key:'out',source:'added',target:'n2'}],updates:{n2:{set:{text:'{{added.text}}'}}},coverage:{R1:['added','n2']}})
    if(!add.ok)throw Error(JSON.stringify(add.feedback));expect(verifiedModuleInstances(add.value.candidate!)).toHaveLength(1)
  })
  it('shares exact module schema bytes in both compilers and uses normal schema and cap validation',()=>{
    for(const context of [templateContext(),revision(compile().candidate!)]){
      const compact=new WorkflowAuthoringCompiler(context),template=new TemplateFillingCompiler(context)
      for(const schema of [compact.schema,compact.nextSchema,template.schema,template.nextSchema])assertObjectJsonSchema(schema)
      const props=(schema:any)=>schema.properties.submission.oneOf[0].properties
      for(const field of context.operation==='create'?['modules']:['addModules','updateModules','removeModules']){
        expect(JSON.stringify(props(compact.schema)[field])).toBe(JSON.stringify(props(template.schema)[field]));expect(JSON.stringify(props(compact.schema)[field])).toBe(JSON.stringify(props(template.nextSchema)[field]))
      }
    }
    const template=new TemplateFillingCompiler(templateContext()),doc=filling(create());expect(validateJsonSchemaValue(template.nextSchema,{submission:doc})).toEqual([])
    const r=template.submit({submission:doc});if(!r.ok)throw Error(JSON.stringify(r.feedback));expect(r.value.candidate).toEqual(compile().candidate)
    const bad=create();bad.modules[0]!.parameters.rows='bad';const c=new WorkflowAuthoringCompiler(templateContext());const first=c.submit({submission:bad});if(first.ok)throw Error('expected failure')
    const repaired=c.submit({submission:{mode:'repair',draftRevision:first.feedback.draftRevision,patches:[{op:'replace',path:'/modules/table/parameters/rows',value:'{{prepare.text}}'}]}});expect(repaired.ok).toBe(true)
  })
  it.each([WorkflowAuthoringCompiler,TemplateFillingCompiler])('supports parameter edits through $name without exposing internal updates',C=>{
    const flow=compile().candidate!,c=new C(revision(flow)),doc={submission:{mode:'edit',updateModules:{table:{parameters:{...parameters('{{n3.text}}'),emptyText:'新的空表'}}},coverage:{R1:['table']}}}
    expect(validateJsonSchemaValue(c.nextSchema,doc)).toEqual([])
    const r=c.submit(doc);if(!r.ok)throw Error(JSON.stringify(r.feedback));expect(verifiedModuleInstances(r.value.candidate!)).toHaveLength(1)
  })
  it('keeps T26 unique repair in the same session for a form submission containing fragments',()=>{
    const c=new TemplateFillingCompiler(templateContext()),doc=filling(create()),form=doc.forms.find((f:any)=>f.key==='prepare')
    form.text=form.values.text;delete form.values.text
    expect(c.submit({submission:doc}).ok).toBe(false)
    const repaired=c.repairUnique([c.nextSchema,c.schema]);expect(repaired?.ok).toBe(true);expect(c.snapshot().submissions).toBe(2)
    if(repaired?.ok)expect(verifiedModuleInstances(repaired.value.candidate!)).toHaveLength(1)
  })
  it('splices a fragment used as a branch link target through both compilers',()=>{
    const doc:any=create();doc.nodes.splice(2,0,{key:'check',kind:'if',config:{logicGate:{operator:'IF',inputs:[{value:true}]}}},{key:'fallback',kind:'output',config:{text:'无数据',outputName:'empty'}})
    doc.chains=[{key:'head',nodes:['start','prepare','check']},{key:'tail',nodes:['table','result']}];doc.links=[{key:'yes',source:'check',target:'table',port:'true'},{key:'no',source:'check',target:'fallback',port:'false'}]
    const a=new WorkflowAuthoringCompiler(templateContext()).submit({submission:doc}),b=new TemplateFillingCompiler(templateContext(),{prefetch:['input','output','template','if']}).submit({submission:filling(doc)})
    for(const r of [a,b]){if(!r.ok)throw Error(JSON.stringify(r.feedback));expect(verifiedModuleInstances(r.value.candidate!)).toHaveLength(1)}
  })
  it('keeps frozen whole-graph digests and separately pins the fragment digest',()=>{
    expect(businessModuleCatalog().map(m=>m.implementationDigest)).toEqual(['97ab7ab7732fc5cc1f22bce41bcce0b280401042345e18106513385bb9a53419','e44821bd615c8343e0729cbde3540d63be5eef7ebf9d29123a2cd0b1fc747751'])
    expect(fragmentModules[0]!.implementationDigest).toBe('21e6a7e3cdc84ce2f5092987ec7167949f928e9b1b626f1b9106845b56d56b7e')
    expect(businessModuleCatalog()[0]!.fragment).toMatchObject({scopes:'any',outputs:fragmentModules[0]!.outputs})
    expect(new TemplateFillingCompiler(templateContext()).queryTemplates(['input']).modules).toEqual(fragmentCatalog())
  })
  it('preserves and remaps instances across strict parsing, export/import, storage and real card copy',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'fragment-copy-')),host=new WorkflowStorage(directory)
    let store:WorkflowStore|undefined
    try{
      const source=host.save(compile().candidate!,0);expect(parseWorkflow(source).moduleInstances).toEqual(source.moduleInstances)
      const raw=exportWorkflowJson(source),imported=importWorkflowJson(raw,'workspace').workflow
      expect(verifiedModuleInstances(imported)).toHaveLength(1);expect(imported.moduleInstances![0]!.parameters.rows).not.toBe(source.moduleInstances![0]!.parameters.rows)
      const library=()=>({workflows:host.workflows(),presets:[],runs:[],workspaces:[{id:'workspace',name:'workspace'}]})
      const api={get:vi.fn(async(id:string)=>host.get(id)),list:vi.fn(async()=>library()),models:vi.fn(async()=>[]),presets:vi.fn(async()=>[]),importPackage:vi.fn(async(raw:string,workspace:string)=>{const b=importWorkflowJson(raw,workspace);return host.importBundle(b.workflow,b.presets,undefined,b.workflows)})} as unknown as WorkflowAPI
      store=new WorkflowStore(api);store.update({workflow:source,page:'library',loading:false,library:library()})
      const copied=await copyWorkflowCard(store,source,'副本');expect(verifiedModuleInstances(copied)).toHaveLength(1);expect(copied.moduleInstances![0]!.roles).not.toEqual(source.moduleInstances![0]!.roles)
      const detached=structuredClone(source);detached.moduleInstances![0]!.parametersDigest='0'.repeat(64);expect(verifiedModuleInstances(importWorkflowJson(exportWorkflowJson(detached),'workspace').workflow)).toEqual([])
    }finally{store?.dispose();host.close();rmSync(directory,{recursive:true,force:true})}
  })
  it('matches portable SHA-256 to Host hashing for boundary lengths and Unicode metadata',()=>{
    for(const value of ['',null,{},parameters(),'中文🙂'.repeat(500),...Array.from({length:130},(_,n)=>'a'.repeat(n))])expect(portableDigest(value)).toBe(jsonDigest(value))
  })
  it('rolls back notes and moduleInstances with dry-run default and an exact-byte backup',()=>{
    const root=mkdtempSync(join(tmpdir(),'fragment-rollback-'))
    try{const flow=compile().candidate!,path=join(root,'library.json'),original=JSON.stringify({workflows:[flow]},null,2);writeFileSync(path,original)
      const dry=stripNodeNotes(root);expect(dry.mode).toBe('dry-run');expect(dry.moduleInstances).toHaveLength(1);expect(readFileSync(path,'utf8')).toBe(original)
      const applied=stripNodeNotes(root,true);expect(readFileSync(applied.backup,'utf8')).toBe(original);const after=JSON.parse(readFileSync(path,'utf8')).workflows[0];expect(after).not.toHaveProperty('moduleInstances');expect(after.nodes.every((n:any)=>!Object.hasOwn(n,'note'))).toBe(true);expect(stripNodeNotes(root,true)).not.toHaveProperty('backup')
    }finally{rmSync(root,{recursive:true,force:true})}
  })
  it('executes normal nodes plus table fragment through production runtime in isolated storage',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'fragment-runtime-')),storage=new WorkflowStorage(directory)
    const catalog=new ToolCatalog({directory,workflows:id=>storage.workflows(id),nativeTools:()=>[],executeNative:async()=>{throw Error('No tools')},runWorkflow:async()=>{throw Error('No nested workflows')},http:httpRequest})
    let modelCalls=0
    const runtime=new WorkflowRuntime(storage,{generate:async()=>{modelCalls++;throw Error('No model')}},createExecutionAdapters({catalog,workspaceRoot:()=>directory}),undefined,{runtimeDirectory:join(directory,'private-runtime')})
    try{const flow=storage.save(compile().candidate!,0),run=await runtime.settle(runtime.start(flow.id,{rows:'[{"name":"A|B"}]'}).id);expect(run.status).toBe('success');expect(run.outputs.result).toBe('# 核对结果\n\n| 姓名 |\n| --- |\n| A&#124;B | (1)');expect(modelCalls).toBe(0);expect(verifiedModuleInstances(storage.get(flow.id))).toHaveLength(1)
    }finally{await runtime.close();storage.close();rmSync(directory,{recursive:true,force:true})}
  },60_000)
})
