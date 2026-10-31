import {describe,it,expect} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {assertObjectJsonSchema,validateJsonSchemaValue} from '@deepseek-ai/dsh-tools'
import {WorkflowAuthoringCompiler} from '../src/shared/planning-authoring.ts'
import {TemplateFillingCompiler} from '../src/shared/planning-template-compiler.ts'
import {fragmentModules,fragmentContract,fragmentCatalog} from '../src/shared/planning-module-fragment-contract.ts'
import {verifiedModuleInstances} from '../src/shared/planning-module-fragments.ts'
import {planningEditView} from '../src/shared/planning-edits.ts'
import {allNodes} from '../src/shared/workflow-validation.ts'
import {exportWorkflowJson,importWorkflowJson} from '../src/shared/workflow-format.ts'
import {WorkflowStorage} from '../src/host/storage.ts'
import {WorkflowRuntime} from '../src/host/runtime.ts'
import {createExecutionAdapters,httpRequest} from '../src/host/execution-adapters.ts'
import {ToolCatalog} from '../src/host/tool-catalog.ts'
import {buildPlanningCommandBrief,planningFragmentBriefLines} from '../src/host/planning/command-brief.ts'
import {templateContext} from './fixtures/planning-compiler/template.ts'
import type {Workflow} from '../src/shared/types.ts'

const moduleId='list-map-template@1.0.0'
const parameters=(items='{{prepare.text}}',template='{{index}}: {{item.name}}')=>({items,template})
function create():any{return {mode:'create',title:'列表模板片段',nodes:[
  {key:'start',kind:'input',config:{fields:[{name:'items',label:'数组',type:'json',required:true}]}},
  {key:'prepare',kind:'template',config:{text:'{{input.items}}'}},
  {key:'result',kind:'output',config:{text:'{{mapped.texts}} ({{mapped.count}})',outputName:'result'}},
],modules:[{key:'mapped',module:moduleId,parameters:parameters()}],chains:[{key:'main',nodes:['start','prepare','mapped','result']}],coverage:{R1:['mapped','result']}}}
function filling(doc:any){const d=structuredClone(doc);d.forms=d.nodes.map(({kind,config,...n}:any)=>({...n,template:kind,values:config}));delete d.nodes;return d}
const accepted=(r:ReturnType<WorkflowAuthoringCompiler['submit']>)=>{if(!r.ok)throw Error(JSON.stringify(r.feedback));return r.value.candidate!}
const compile=(doc=create())=>accepted(new WorkflowAuthoringCompiler(templateContext()).submit({submission:doc}))
const revision=(flow:Workflow)=>({...templateContext(),operation:'revise' as const,workflow:{...structuredClone(flow),revision:1},targetNodeIds:allNodes(flow).map(n=>n.id)})
const refs=(flow:Workflow)=>new Map(allNodes(flow).map((n,i)=>[n.id,'n'+(i+1)]))
function nested(kind:'iteration'|'loop'){
  const doc=create();doc.nodes.splice(1,1,{key:'outer',kind,config:kind==='iteration'?{iterator:'input.items',outputVariable:'mapped.texts'}:{maxIterations:1,outputVariable:'mapped.texts'}})
  doc.modules[0].parameters=parameters(kind==='iteration'?'{{item}}':'{{input.items}}')
  doc.nodes[2].config.text='{{outer.text}}';doc.chains=[{key:'main',nodes:['start','outer','result']},{key:'body',container:'outer',nodes:['mapped']}];doc.coverage={R1:['outer','mapped','result']}
  return doc
}

describe('T24.2 list-map-template fragment',()=>{
  it.each([WorkflowAuthoringCompiler,TemplateFillingCompiler])('creates at root and nested in iteration/loop through $name',C=>{
    for(const doc of [create(),nested('iteration'),nested('loop')]){
      const c=new C(templateContext()),flow=accepted(c.submit({submission:C===TemplateFillingCompiler?filling(doc):doc}))
      expect(flow).toEqual(compile(doc));expect(verifiedModuleInstances(flow)).toHaveLength(1)
      const record=flow.moduleInstances![0]!,nodes=allNodes(flow),container=nodes.find(n=>n.id===record.roles.iterate)!
      expect(Object.keys(record.roles).sort()).toEqual(['iterate','iterateEntry','project','render'])
      expect(container.config.body!.nodes.map(n=>n.kind).sort()).toEqual(['input','template'])
      expect(nodes.find(n=>n.id===record.roles.project)!.kind).toBe('code')
      expect(nodes.filter(n=>n.kind==='output')).toHaveLength(1)
      expect(JSON.stringify(flow.nodes)).not.toContain('mapped.texts')
    }
  })
  it('rejects unknown ports with candidates and all private role references',()=>{
    const doc=create();doc.nodes[2].config.text='{{mapped.missing}}'
    const r=new WorkflowAuthoringCompiler(templateContext()).submit({submission:doc});expect(r.ok).toBe(false)
    if(!r.ok){expect(r.feedback.issues[0]).toMatchObject({code:'MODULE_OUTPUT_PORT',candidates:['texts','count']});expect(r.feedback.allowedPaths).toContain('/nodesByKey/result/config/text')}
    for(const role of ['iterate','render','project','iterateEntry']){
      const d=create();d.nodes[2].config.text='{{mapped__'+role+'.text}}'
      const bad=new WorkflowAuthoringCompiler(templateContext()).submit({submission:d});expect(bad.ok).toBe(false)
      if(!bad.ok)expect(bad.feedback.issues.some(i=>i.code==='MODULE_INTERNAL_REFERENCE')).toBe(true)
    }
    for(const template of ['{{mapped__iterateEntry.text}}','{% if mapped__iterateEntry.text %}x{% endif %}']){
      const d=create();d.modules[0].parameters.template=template
      const bad=new WorkflowAuthoringCompiler(templateContext()).submit({submission:d});expect(bad.ok).toBe(false)
      if(!bad.ok)expect(bad.feedback.issues[0]!.code).toBe('MODULE_INTERNAL_REFERENCE')
    }
  })
  it('keeps normal upstream, scope, template and parameter validation',()=>{
    for(const mutate of [
      (d:any)=>{d.modules[0].parameters.items='[]'},
      (d:any)=>{d.modules[0].parameters.items='{{prepare.text | tojson}}'},
      (d:any)=>{d.modules[0].parameters.items='x'.repeat(401)},
      (d:any)=>{d.modules[0].parameters.template='x'.repeat(100001)},
      (d:any)=>{d.modules[0].parameters.toolId='native:read'},
      (d:any)=>{d.modules[0].parameters.template='{{result.text}}'},
      (d:any)=>{d.modules[0].parameters.items='{{item}}'},
      (d:any)=>{d.nodes.push({key:'unrelated',kind:'template',config:{text:'x'}});d.modules[0].parameters.template='{{unrelated.text}}'},
    ]){const d=create();mutate(d);const r=new WorkflowAuthoringCompiler(templateContext()).submit({submission:d});expect(r.ok).toBe(false)}
    // Real external upstream references work in interpolations AND control expressions.
    const d=create();d.modules[0].parameters.template='{% if prepare.text %}{{item}}{% endif %}'
    const flow=compile(d);expect(verifiedModuleInstances(flow)).toHaveLength(1)
    expect(verifiedModuleInstances(importWorkflowJson(exportWorkflowJson(flow),'workspace').workflow)).toHaveLength(1)
    d.modules[0].parameters.template='';expect(verifiedModuleInstances(compile(d))).toHaveLength(1)
  })
  it.each([WorkflowAuthoringCompiler,TemplateFillingCompiler])('updates, removes and adds whole instances through $name',C=>{
    const flow=compile(),names=refs(flow),prepare=names.get(flow.nodes.find(n=>n.kind==='template')!.id)!,output=names.get(flow.nodes.find(n=>n.kind==='output')!.id)!
    const set=(text:string)=>C===TemplateFillingCompiler?{values:{text}}:{set:{text}}
    const changed=accepted(new C(revision(flow)).submit({submission:{mode:'edit',updateModules:{mapped:{parameters:parameters('{{'+prepare+'.text}}','{% if '+prepare+'.text %}{{item.name}}{% endif %}')}},coverage:{R1:['mapped']}}}))
    expect(verifiedModuleInstances(changed)).toHaveLength(1)
    expect(changed.moduleInstances![0]!.roles).toEqual(flow.moduleInstances![0]!.roles)
    expect(planningEditView(revision(changed)).modules![0]!.parameters.template).toBe('{% if '+prepare+'.text %}{{item.name}}{% endif %}')
    const removed=accepted(new C(revision(changed)).submit({submission:{mode:'edit',removeModules:['mapped'],removeLinks:[{source:prepare,target:'mapped'},{source:'mapped',target:output}],addLinks:[{key:'bridge',source:prepare,target:output}],updates:{[output]:set('{{'+prepare+'.text}}')},coverage:{R1:[prepare,output]}}}))
    expect(removed.moduleInstances).toEqual([]);expect(allNodes(removed).some(n=>n.kind==='iteration')).toBe(false)
    const nextRefs=refs(removed),p=nextRefs.get(flow.nodes.find(n=>n.kind==='template')!.id)!,o=nextRefs.get(flow.nodes.find(n=>n.kind==='output')!.id)!
    const added=accepted(new C(revision(removed)).submit({submission:{mode:'edit',addModules:[{key:'again',module:moduleId,parameters:parameters('{{'+p+'.text}}')}],removeLinks:[{source:p,target:o}],addLinks:[{key:'in',source:p,target:'again'},{key:'out',source:'again',target:o}],updates:{[o]:set('{{again.texts}} ({{again.count}})')},coverage:{R1:['again',o]}}}))
    expect(verifiedModuleInstances(added)).toHaveLength(1)
  })
  it('detaches changed template/container configuration but accepts a new downstream consumer',()=>{
    const flow=compile(),record=flow.moduleInstances![0]!
    for(const change of [(w:Workflow)=>{allNodes(w).find(n=>n.id===record.roles.render)!.config.text+=' changed'},(w:Workflow)=>{allNodes(w).find(n=>n.id===record.roles.iterate)!.config.parallel=true}]){
      const copy=structuredClone(flow);change(copy);const before=structuredClone(copy)
      expect(verifiedModuleInstances(copy)).toEqual([]);expect(copy).toEqual(before)
      expect(planningEditView(revision(copy)).nodes.some(n=>n.kind==='iteration')).toBe(true)
    }
    const after=accepted(new WorkflowAuthoringCompiler(revision(flow)).submit({submission:{mode:'edit',addNodes:[{key:'consumer',kind:'template',config:{text:'{{mapped.texts}}/{{mapped.count}}'}}],addLinks:[{key:'feed',source:'mapped',target:'consumer'}],coverage:{R1:['consumer']}}}))
    expect(verifiedModuleInstances(after)).toHaveLength(1)
  })
  it('advertises per-module oneOf with identical compiler bytes and valid SDK structure',()=>{
    expect((fragmentContract().items as any).oneOf).toHaveLength(5)
    for(const context of [templateContext(),revision(compile())]){
      const a=new WorkflowAuthoringCompiler(context),b=new TemplateFillingCompiler(context)
      for(const schema of [a.schema,a.nextSchema,b.schema,b.nextSchema])assertObjectJsonSchema(schema)
      const props=(s:any)=>s.properties.submission.oneOf[0].properties
      for(const field of context.operation==='create'?['modules']:['addModules','updateModules','removeModules'])for(const schema of [a.nextSchema,b.schema,b.nextSchema])expect(JSON.stringify(props(schema)[field])).toBe(JSON.stringify(props(a.schema)[field]))
    }
    const c=new TemplateFillingCompiler(templateContext());expect(validateJsonSchemaValue(c.nextSchema,{submission:filling(create())})).toEqual([])
    const catalog=fragmentCatalog(),row=catalog.find(m=>m.module===moduleId)!
    expect(row.ports).toEqual({inputs:['items'],outputs:['texts','count']});expect(row.parameterExample).toEqual(parameters('{{fetch.items}}'))
    expect(c.queryTemplates(['iteration']).modules).toEqual(catalog)
    const brief=buildPlanningCommandBrief('workspace',Array.from({length:8},(_,i)=>({...templateContext().workflow,id:'flow-'+i,title:'流程 '+i})))
    expect(JSON.parse(brief).fragmentModules).toEqual(planningFragmentBriefLines());expect(Buffer.byteLength(brief)).toBeLessThan(8000)
    expect(fragmentModules.find(m=>m.id==='list-map-template')!.implementationDigest).toBe('5d64dc4771d905129a4f76393497b085f256834c6305ecdd45fef3ec239a9a45')
  })
  it('runs production iteration with ordered JSON strings, empty input and nested scopes without model/tools/network',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'list-map-runtime-')),storage=new WorkflowStorage(directory)
    let externalCalls=0
    const forbidden=async()=>{externalCalls++;throw Error('No external calls')}
    const catalog=new ToolCatalog({directory,workflows:id=>storage.workflows(id),nativeTools:()=>[],executeNative:forbidden,runWorkflow:forbidden,http:forbidden as typeof httpRequest})
    const runtime=new WorkflowRuntime(storage,{generate:forbidden},createExecutionAdapters({catalog,workspaceRoot:()=>directory}),undefined,{runtimeDirectory:join(directory,'private-runtime')})
    try{
      const chained=create();chained.modules.push({key:'second',module:moduleId,parameters:parameters('{{mapped.texts}}','{{index}}={{item}}')})
      chained.chains[0].nodes.splice(3,0,'second');chained.nodes[2].config.text='{{second.texts}} ({{second.count}})';chained.coverage.R1.push('second')
      const upstream=create();upstream.modules[0].parameters.template='{% if prepare.text %}{{index}}: {{item.name}}{% endif %}'
      for(const [doc,items,expected]of [
        [create(),[{name:'B"\n'},{name:'A'},{name:'中'}],'["0: B\\\"\\n","1: A","2: 中"] (3)'],
        [create(),[],'[] (0)'],
        [chained,[{name:'B'},{name:'A'}],'["0=0: B","1=1: A"] (2)'],
        [upstream,[{name:'A'}],'["0: A"] (1)'],
        [nested('iteration'),[[{name:'B'},{name:'A'}],[],[{name:'C'}]],JSON.stringify(['["0: B","1: A"]','[]','["0: C"]'])],
        [nested('loop'),[{name:'A'}],'["0: A"]'],
      ]as const){
        const candidate=compile(doc);candidate.id='fixture-'+storage.workflows().length
        const flow=storage.save(candidate,0),run=await runtime.settle(runtime.start(flow.id,{items:JSON.stringify(items)}).id)
        expect(run.status,run.error).toBe('success');expect(run.outputs.result).toBe(expected)
        expect(verifiedModuleInstances(storage.get(flow.id))).toHaveLength(doc.modules.length)
        if(items.length===0)expect(run.executions.some(e=>e.nodeId===flow.moduleInstances![0]!.roles.render)).toBe(false)
      }
      const candidate=compile();candidate.id='fixture-limit'
      const tooMany=storage.save(candidate,0),run=await runtime.settle(runtime.start(tooMany.id,{items:JSON.stringify(Array.from({length:1001},()=>({name:'x'})))}).id)
      expect(run.status).toBe('failed');expect(run.error).toContain('1000');expect(externalCalls).toBe(0)
    }finally{await runtime.close();storage.close();rmSync(directory,{recursive:true,force:true})}
  },60_000)
})
