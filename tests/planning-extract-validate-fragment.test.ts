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
import {templateContext} from './fixtures/planning-compiler/template.ts'
import type {Workflow} from '../src/shared/types.ts'

const moduleId='extract-validate@1.0.0'
const field=(name:string,type='string',required=true)=>({name,type,required,description:name})
const parameters=(source='{{prepare.text}}')=>({source,fields:[field('name'),field('age','number',false)]})
function create():any{return {mode:'create',title:'结构化抽取校验',nodes:[
  {key:'start',kind:'input',config:{fields:[{name:'text',label:'原文',type:'paragraph',required:true}]}},
  {key:'prepare',kind:'template',config:{text:'{{input.text}}'}},
  {key:'result',kind:'output',config:{text:'{{checked.ok}}/{{checked.data.name}}/{{checked.errors}}/{{checked.source}}',outputName:'result'}},
],modules:[{key:'checked',module:moduleId,parameters:parameters()}],chains:[{key:'main',nodes:['start','prepare','checked','result']}],coverage:{R1:['checked','result']}}}
function filling(doc:any){const d=structuredClone(doc);if(d.nodes){d.forms=d.nodes.map(({kind,config,...n}:any)=>({...n,template:kind,values:config}));delete d.nodes}return d}
const accepted=(r:ReturnType<WorkflowAuthoringCompiler['submit']>)=>{if(!r.ok)throw Error(JSON.stringify(r.feedback));return r.value.candidate!}
const compile=(doc=create())=>accepted(new WorkflowAuthoringCompiler(templateContext()).submit({submission:doc}))
const revision=(flow:Workflow)=>({...templateContext(),operation:'revise' as const,workflow:{...structuredClone(flow),revision:1},targetNodeIds:allNodes(flow).map(n=>n.id)})
const refs=(flow:Workflow)=>new Map(allNodes(flow).map((n,i)=>[n.id,'n'+(i+1)]))
function nested(kind:'iteration'|'loop'){
  const d=create();d.nodes.splice(1,1,{key:'outer',kind,config:kind==='iteration'?{iterator:'input.text',outputVariable:'checked.ok'}:{maxIterations:1,outputVariable:'checked.ok'}})
  // Runtime array inputs are supplied by the fixture; CREATE only needs scope validity.
  if(kind==='iteration')d.nodes[0].config.fields[0].type='json'
  d.modules[0].parameters=parameters(kind==='iteration'?'{{item}}':'{{input.text}}')
  d.nodes[2].config.text='{{outer.text}}';d.chains=[{key:'main',nodes:['start','outer','result']},{key:'body',container:'outer',nodes:['checked']}];d.coverage={R1:['outer','checked','result']};return d
}
function routed(){
  const d=create();d.nodes[2].config.text='accepted';d.nodes.push({key:'gate',kind:'if',config:{variable:'{{checked.ok}}',operator:'equals',value:'true'}},{key:'failed',kind:'output',config:{text:'{{checked.errors}}',outputName:'failure'}})
  d.chains=[{key:'main',nodes:['start','prepare','checked','gate']}];d.links=[{key:'yes',source:'gate',target:'result',port:'true'},{key:'no',source:'gate',target:'failed',port:'false'}];return d
}

describe('T24.2 extract-validate fragment',()=>{
  it.each([WorkflowAuthoringCompiler,TemplateFillingCompiler])('creates at root, iteration and loop and resolves all ports through $name',C=>{
    for(const d of [create(),nested('iteration'),nested('loop'),routed()]){
      const flow=accepted(new C(templateContext()).submit({submission:C===TemplateFillingCompiler?filling(d):d}))
      expect(flow).toEqual(compile(d));expect(verifiedModuleInstances(flow)).toHaveLength(1)
      const r=flow.moduleInstances![0]!,nodes=allNodes(flow)
      expect(Object.keys(r.roles).sort()).toEqual(['extract','validate'])
      expect(nodes.find(n=>n.id===r.roles.extract)!.kind).toBe('extractor')
      expect(nodes.find(n=>n.id===r.roles.validate)!.kind).toBe('code')
      expect(verifiedModuleInstances(importWorkflowJson(exportWorkflowJson(flow),'workspace').workflow)).toHaveLength(1)
    }
  })
  it.each([WorkflowAuthoringCompiler,TemplateFillingCompiler])('rejects undeclared ports, private roles and fragment branch sources through $name',C=>{
    for(const [text,code]of [['{{checked.unknown}}','MODULE_OUTPUT_PORT'],['{{checked__extract.text}}','MODULE_INTERNAL_REFERENCE'],['{{checked__validate.ok}}','MODULE_INTERNAL_REFERENCE']]){
      const d=create();d.nodes[2].config.text=text
      const r=new C(templateContext()).submit({submission:C===TemplateFillingCompiler?filling(d):d});expect(r.ok).toBe(false)
      if(!r.ok){expect(r.feedback.issues[0]!.code).toBe(code);if(code==='MODULE_OUTPUT_PORT')expect(r.feedback.issues[0]!.candidates).toEqual(['ok','data','errors','source'])}
    }
    const d=routed();d.links[0].source='checked'
    const r=new C(templateContext()).submit({submission:C===TemplateFillingCompiler?filling(d):d});expect(r.ok).toBe(false)
    if(!r.ok)expect(r.feedback.issues.some(i=>i.code==='MODULE_BRANCH_SOURCE')).toBe(true)
    const privateInput=create();privateInput.modules[0].parameters.source='{{checked__extract.text}}'
    const bad=new C(templateContext()).submit({submission:C===TemplateFillingCompiler?filling(privateInput):privateInput});expect(bad.ok).toBe(false)
    if(!bad.ok)expect(bad.feedback.issues[0]!.code).toBe('MODULE_INTERNAL_REFERENCE')
  })
  it('enforces explicit field, literal, reference and upstream limits',()=>{
    for(const mutate of [
      (p:any)=>{p.source='literal'},(p:any)=>{p.source='{{prepare.text | trim}}'},(p:any)=>{p.source='x'.repeat(401)},
      (p:any)=>{p.fields=[]},(p:any)=>{p.fields=Array.from({length:41},(_,i)=>field('a'+i))},
      (p:any)=>{p.fields=[field('name'),field('name')]},(p:any)=>{p.fields[0].name='constructor'},(p:any)=>{p.fields[0].name='bad-name'},(p:any)=>{p.fields[0].name='a'.repeat(81)},
      (p:any)=>{delete p.fields[0].required},(p:any)=>{delete p.fields[0].description},(p:any)=>{p.fields[0].type='integer'},
      (p:any)=>{p.fields[0].description='x'.repeat(2001)},(p:any)=>{p.instruction='x'.repeat(4001)},(p:any)=>{p.instruction='{{result.text}}'},
      (p:any)=>{p.fields[0].description='{% if x %}'},(p:any)=>{p.model={provider:'x',model:'y'}},(p:any)=>{p.code='return 1'},(p:any)=>{p.toolId='native:read'},
      (p:any)=>{p.source='{{result.text}}'},(p:any)=>{p.source='{{item}}'},
    ]){const d=create();mutate(d.modules[0].parameters);expect(new WorkflowAuthoringCompiler(templateContext()).submit({submission:d}).ok).toBe(false)}
    const d=create();d.modules[0].parameters.instruction='只提取明确出现的值。';expect(verifiedModuleInstances(compile(d))).toHaveLength(1)
  })
  it.each([WorkflowAuthoringCompiler,TemplateFillingCompiler])('edits add/update/remove without exposing internals through $name',C=>{
    const flow=compile(),names=refs(flow),prepare=names.get(flow.nodes.find(n=>n.kind==='template')!.id)!,output=names.get(flow.nodes.find(n=>n.kind==='output')!.id)!
    const set=(text:string)=>C===TemplateFillingCompiler?{values:{text}}:{set:{text}}
    const changed=accepted(new C(revision(flow)).submit({submission:{mode:'edit',updateModules:{checked:{parameters:{...parameters('{{'+prepare+'.text}}'),instruction:'不要猜测。'}}},coverage:{R1:['checked']}}}))
    expect(verifiedModuleInstances(changed)).toHaveLength(1);expect(changed.moduleInstances![0]!.roles).toEqual(flow.moduleInstances![0]!.roles)
    expect(planningEditView(revision(changed)).modules![0]!.parameters.instruction).toBe('不要猜测。')
    const removed=accepted(new C(revision(changed)).submit({submission:{mode:'edit',removeModules:['checked'],removeLinks:[{source:prepare,target:'checked'},{source:'checked',target:output}],addLinks:[{key:'bridge',source:prepare,target:output}],updates:{[output]:set('{{'+prepare+'.text}}')},coverage:{R1:[prepare,output]}}}))
    expect(removed.moduleInstances).toEqual([]);expect(allNodes(removed).some(n=>n.kind==='extractor'||n.kind==='code')).toBe(false)
    const next=refs(removed),p=next.get(flow.nodes.find(n=>n.kind==='template')!.id)!,o=next.get(flow.nodes.find(n=>n.kind==='output')!.id)!
    const added=accepted(new C(revision(removed)).submit({submission:{mode:'edit',addModules:[{key:'again',module:moduleId,parameters:parameters('{{'+p+'.text}}')}],removeLinks:[{source:p,target:o}],addLinks:[{key:'in',source:p,target:'again'},{key:'out',source:'again',target:o}],updates:{[o]:set('{{again.ok}}/{{again.data.name}}/{{again.errors}}/{{again.source}}')},coverage:{R1:['again',o]}}}))
    expect(verifiedModuleInstances(added)).toHaveLength(1)
  })
  it('detaches altered extractor and code configs but keeps new downstream consumers valid',()=>{
    const flow=compile(),r=flow.moduleInstances![0]!
    for(const role of ['extract','validate']){
      const copy=structuredClone(flow),node=allNodes(copy).find(n=>n.id===r.roles[role])!
      if(role==='extract')node.config.prompt+=' changed';else node.config.code+='\n// changed'
      const before=structuredClone(copy);expect(verifiedModuleInstances(copy)).toEqual([]);expect(copy).toEqual(before)
      expect(planningEditView(revision(copy)).nodes.some(n=>n.kind==='extractor')).toBe(true)
    }
    const after=accepted(new WorkflowAuthoringCompiler(revision(flow)).submit({submission:{mode:'edit',addNodes:[{key:'consumer',kind:'template',config:{text:'{{checked.ok}}/{{checked.data.name}}/{{checked.errors}}/{{checked.source}}'}}],addLinks:[{key:'feed',source:'checked',target:'consumer'}],coverage:{R1:['consumer']}}}))
    expect(verifiedModuleInstances(after)).toHaveLength(1)
  })
  it('shares SDK-valid byte-identical compiler contracts, catalog and the new digest pin',()=>{
    expect((fragmentContract().items as any).oneOf).toHaveLength(5)
    for(const context of [templateContext(),revision(compile())]){
      const a=new WorkflowAuthoringCompiler(context),b=new TemplateFillingCompiler(context)
      for(const schema of [a.schema,a.nextSchema,b.schema,b.nextSchema])assertObjectJsonSchema(schema)
      const props=(s:any)=>s.properties.submission.oneOf[0].properties
      for(const name of context.operation==='create'?['modules']:['addModules','updateModules','removeModules'])for(const schema of [a.nextSchema,b.schema,b.nextSchema])expect(JSON.stringify(props(schema)[name])).toBe(JSON.stringify(props(a.schema)[name]))
    }
    const c=new TemplateFillingCompiler(templateContext());expect(validateJsonSchemaValue(c.nextSchema,{submission:filling(create())})).toEqual([])
    const catalog=fragmentCatalog(),row=catalog.find(m=>m.module===moduleId)!
    expect(row.ports).toEqual({inputs:['source'],outputs:['ok','data','errors','source']});expect(c.queryTemplates(['extractor']).modules).toEqual(catalog)
    expect(fragmentModules.find(m=>m.id==='extract-validate')!.implementationDigest).toBe('aa867bc3a36898088201fc767b2043295d7540e9930190a83100cce357eab6e3')
  })
  it('runs production runtime with stub extraction, normalized data, all validation failures, source and real if routing',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'extract-validate-runtime-')),storage=new WorkflowStorage(directory)
    let response='',modelCalls=0,externalCalls=0
    const forbidden=async()=>{externalCalls++;throw Error('No external calls')}
    const catalog=new ToolCatalog({directory,workflows:id=>storage.workflows(id),nativeTools:()=>[],executeNative:forbidden,runWorkflow:forbidden,http:forbidden as typeof httpRequest})
    const runtime=new WorkflowRuntime(storage,{generate:async request=>{modelCalls++;expect(request.model).toEqual(templateContext().model);expect(request.prompt).toContain('原文');return response}},createExecutionAdapters({catalog,workspaceRoot:()=>directory}),undefined,{runtimeDirectory:join(directory,'private-runtime')})
    const source=' 原文\n张三 20岁\n{{literal.text}} '
    try{
      const cases:[string,boolean,Record<string,unknown>,{field:string;reason:string}[]][]=[
        ['{"name":" 张三 ","age":20,"active":false,"tags":["x",1,true],"meta":{"x":1},"extra":"drop"}',true,{name:' 张三 ',age:20,active:false,tags:['x',1,true],meta:{x:1}},[]],
        ['{}',false,{},[{field:'name',reason:'required'}]],
        ['{"name":5,"age":"20"}',false,{},[{field:'name',reason:'expected_string'},{field:'age',reason:'expected_number'}]],
        ['```json\n{"name":"张三"}\n```',true,{name:'张三'},[]],
        ['{"name":"张三","tags":[{}]}',false,{name:'张三'},[{field:'tags',reason:'expected_scalar_array'}]],
        ['{"name":null,"meta":[]}',false,{},[{field:'name',reason:'expected_string'},{field:'meta',reason:'expected_object'}]],
        ['not JSON',false,{},[{field:'',reason:'invalid_object_json'}]],
        ['[]',false,{},[{field:'',reason:'invalid_object_json'}]],
      ]
      for(const [text,ok,data,errors]of cases){
        response=text;const d=routed();d.modules[0].parameters.fields.push(field('active','boolean',false),field('tags','array',false),field('meta','object',false))
        const candidate=compile(d);candidate.id='fixture-'+storage.workflows().length
        const flow=storage.save(candidate,0),run=await runtime.settle(runtime.start(flow.id,{text:source},{model:templateContext().model!,source:'session'}).id)
        expect(run.status,run.error).toBe('success')
        const result=JSON.parse(run.executions.find(e=>e.nodeId===flow.moduleInstances![0]!.roles.validate)!.output!)
        expect(result).toEqual({ok,data,errors,source});expect(run.outputs).toEqual(ok?{result:'accepted'}:{failure:JSON.stringify(errors)})
        expect(verifiedModuleInstances(storage.get(flow.id))).toHaveLength(1)
      }
      for(const kind of ['iteration','loop']as const){
        response='{"name":"张三"}';const candidate=compile(nested(kind));candidate.id='nested-'+kind;const flow=storage.save(candidate,0)
        const run=await runtime.settle(runtime.start(flow.id,{text:kind==='iteration'?JSON.stringify([source,source]):source},{model:templateContext().model!,source:'session'}).id)
        expect(run.status,run.error).toBe('success');expect(run.outputs.result).toBe(kind==='iteration'?'[true,true]':'true')
      }
      expect(modelCalls).toBe(cases.length+3);expect(externalCalls).toBe(0)
    }finally{await runtime.close();storage.close();rmSync(directory,{recursive:true,force:true})}
  },60_000)
})
