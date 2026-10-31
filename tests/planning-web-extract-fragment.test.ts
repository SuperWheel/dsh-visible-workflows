import {describe,it,expect,vi} from 'vitest'
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
import {ToolCatalog,BUILTIN_TOOLS} from '../src/host/tool-catalog.ts'
import {buildPlanningCommandBrief,planningFragmentBriefLines} from '../src/host/planning/command-brief.ts'
import {templateContext as baseContext} from './fixtures/planning-compiler/template.ts'
import type {Workflow} from '../src/shared/types.ts'

const templateContext=()=>({...baseContext(),tools:BUILTIN_TOOLS})
const moduleId='web-extract@1.1.0'
const parameters=(url='{{prepare.text}}')=>({url})
function create():any{return {mode:'create',title:'静态网页提取',nodes:[
  {key:'start',kind:'input',config:{fields:[{name:'text',label:'网址',type:'paragraph',required:true}]}},
  {key:'prepare',kind:'template',config:{text:'{{input.text}}'}},
  {key:'result',kind:'output',config:{text:'{{checked.status}}/{{checked.httpStatus}}/{{checked.title}}/{{checked.text}}/{{checked.url}}',outputName:'result'}},
],modules:[{key:'checked',module:moduleId,parameters:parameters()}],chains:[{key:'main',nodes:['start','prepare','checked','result']}],coverage:{R1:['checked','result']}}}
function filling(doc:any){const d=structuredClone(doc);if(d.nodes){d.forms=d.nodes.map(({kind,config,...n}:any)=>({...n,template:kind,values:config}));delete d.nodes}return d}
const accepted=(r:ReturnType<WorkflowAuthoringCompiler['submit']>)=>{if(!r.ok)throw Error(JSON.stringify(r.feedback));return r.value.candidate!}
const compile=(doc=create())=>accepted(new WorkflowAuthoringCompiler(templateContext()).submit({submission:doc}))
const revision=(flow:Workflow)=>({...templateContext(),operation:'revise' as const,workflow:{...structuredClone(flow),revision:1},targetNodeIds:allNodes(flow).map(n=>n.id)})
const refs=(flow:Workflow)=>new Map(allNodes(flow).map((n,i)=>[n.id,'n'+(i+1)]))
function nested(kind:'iteration'|'loop'){
  const d=create();d.nodes.splice(1,1,{key:'outer',kind,config:kind==='iteration'?{iterator:'input.text',outputVariable:'checked.status'}:{maxIterations:1,outputVariable:'checked.status'}})
  // Runtime array inputs are supplied by the fixture; CREATE only needs scope validity.
  if(kind==='iteration')d.nodes[0].config.fields[0].type='json'
  d.modules[0].parameters=parameters(kind==='iteration'?'{{item}}':'{{input.text}}')
  d.nodes[2].config.text='{{outer.text}}';d.chains=[{key:'main',nodes:['start','outer','result']},{key:'body',container:'outer',nodes:['checked']}];d.coverage={R1:['outer','checked','result']};return d
}
describe('T24.4b visible web-extract@1.1.0 fragment',()=>{
  it.each([WorkflowAuthoringCompiler,TemplateFillingCompiler])('creates at root, iteration and loop and resolves all ports through $name',C=>{
    for(const d of [create(),nested('iteration'),nested('loop')]){
      const flow=accepted(new C(templateContext()).submit({submission:C===TemplateFillingCompiler?filling(d):d}))
      expect(flow).toEqual(compile(d));expect(verifiedModuleInstances(flow)).toHaveLength(1)
      const r=flow.moduleInstances![0]!,nodes=allNodes(flow)
      expect(Object.keys(r.roles)).toEqual(['fetch','extract'])
      expect(nodes.find(n=>n.id===r.roles.fetch)!.kind).toBe('http')
      expect(nodes.find(n=>n.id===r.roles.fetch)!.config).not.toHaveProperty('responseMode');expect(nodes.find(n=>n.id===r.roles.extract)!.config.toolId).toBe('builtin:html.extract_text')
      expect(verifiedModuleInstances(importWorkflowJson(exportWorkflowJson(flow),'workspace').workflow)).toHaveLength(1)
    }
  })
  it.each([WorkflowAuthoringCompiler,TemplateFillingCompiler])('rejects undeclared ports and private roles through $name',C=>{
    for(const [text,code]of [['{{checked.unknown}}','MODULE_OUTPUT_PORT'],['{{checked__fetch.text}}','MODULE_INTERNAL_REFERENCE'],['{{checked__fetch.status}}','MODULE_INTERNAL_REFERENCE']]){
      const d=create();d.nodes[2].config.text=text
      const r=new C(templateContext()).submit({submission:C===TemplateFillingCompiler?filling(d):d});expect(r.ok).toBe(false)
      if(!r.ok){expect(r.feedback.issues[0]!.code).toBe(code);if(code==='MODULE_OUTPUT_PORT')expect(r.feedback.issues[0]!.candidates).toEqual(['status','httpStatus','title','text','url'])}
    }
    const privateInput=create();privateInput.modules[0].parameters.url='{{checked__fetch.text}}'
    const bad=new C(templateContext()).submit({submission:C===TemplateFillingCompiler?filling(privateInput):privateInput});expect(bad.ok).toBe(false)
    if(!bad.ok)expect(bad.feedback.issues[0]!.code).toBe('MODULE_INTERNAL_REFERENCE')
  })
  it.each([WorkflowAuthoringCompiler,TemplateFillingCompiler])('enforces URL schemes, interpolation, scope, upstream and no override slots through $name',C=>{
    for(const url of ['file:///tmp/page','javascript:alert(1)','data:text/html,x','ftp://example.com','https://user:pass@example.com','https://example.com/{{prepare.text | trim}}','{% if x %}https://example.com{% endif %}','x'.repeat(2049),'{{result.text}}','{{item}}','{{index}}','https://example.com/{{item.url}}','{{unknown.text}}']){
      const d=create();d.modules[0].parameters.url=url
      expect(new C(templateContext()).submit({submission:C===TemplateFillingCompiler?filling(d):d}).ok,url).toBe(false)
    }
    for(const name of ['method','headers','bodyText','code','toolId','implementation']){
      const d=create();d.modules[0].parameters[name]='override'
      expect(new C(templateContext()).submit({submission:C===TemplateFillingCompiler?filling(d):d}).ok).toBe(false)
    }
    for(const url of ['https://example.com/a','http://example.com','https://example.com/{{prepare.text}}']){const d=create();d.modules[0].parameters.url=url;expect(verifiedModuleInstances(compile(d))).toHaveLength(1)}
    const unrelated=create();unrelated.nodes.push({key:'other',kind:'template',config:{text:'x'}});unrelated.modules[0].parameters.url='{{other.text}}'
    expect(new C(templateContext()).submit({submission:C===TemplateFillingCompiler?filling(unrelated):unrelated}).ok).toBe(false)
  })
  it.each([WorkflowAuthoringCompiler,TemplateFillingCompiler])('edits add/update/remove without exposing internals through $name',C=>{
    const flow=compile(),names=refs(flow),prepare=names.get(flow.nodes.find(n=>n.kind==='template')!.id)!,output=names.get(flow.nodes.find(n=>n.kind==='output')!.id)!
    const set=(text:string)=>C===TemplateFillingCompiler?{values:{text}}:{set:{text}}
    const changed=accepted(new C(revision(flow)).submit({submission:{mode:'edit',updateModules:{checked:{parameters:parameters('https://example.com/{{'+prepare+'.text}}')}},coverage:{R1:['checked']}}}))
    expect(verifiedModuleInstances(changed)).toHaveLength(1);expect(changed.moduleInstances![0]!.roles).toEqual(flow.moduleInstances![0]!.roles)
    expect(planningEditView(revision(changed)).modules![0]!.parameters.url).toContain('https://example.com/{{')
    const removed=accepted(new C(revision(changed)).submit({submission:{mode:'edit',removeModules:['checked'],removeLinks:[{source:prepare,target:'checked'},{source:'checked',target:output}],addLinks:[{key:'bridge',source:prepare,target:output}],updates:{[output]:set('{{'+prepare+'.text}}')},coverage:{R1:[prepare,output]}}}))
    expect(removed.moduleInstances).toEqual([]);expect(allNodes(removed).some(n=>n.kind==='http'||n.kind==='code')).toBe(false)
    const next=refs(removed),p=next.get(flow.nodes.find(n=>n.kind==='template')!.id)!,o=next.get(flow.nodes.find(n=>n.kind==='output')!.id)!
    const added=accepted(new C(revision(removed)).submit({submission:{mode:'edit',addModules:[{key:'again',module:moduleId,parameters:parameters('{{'+p+'.text}}')}],removeLinks:[{source:p,target:o}],addLinks:[{key:'in',source:p,target:'again'},{key:'out',source:'again',target:o}],updates:{[o]:set('{{again.status}}/{{again.httpStatus}}/{{again.title}}/{{again.text}}/{{again.url}}')},coverage:{R1:['again',o]}}}))
    expect(verifiedModuleInstances(added)).toHaveLength(1)
  })
  it('detaches altered http configs but keeps new downstream consumers valid',()=>{
    const flow=compile(),r=flow.moduleInstances![0]!
    for(const config of [{timeoutMs:1000},{url:'https://example.com/changed'},{method:'POST'}]){
      const copy=structuredClone(flow),node=allNodes(copy).find(n=>n.id===r.roles.fetch)!
      Object.assign(node.config,config)
      const before=structuredClone(copy);expect(verifiedModuleInstances(copy)).toEqual([]);expect(copy).toEqual(before)
      expect(planningEditView(revision(copy)).nodes.some(n=>n.kind==='http')).toBe(true)
    }
    const after=accepted(new WorkflowAuthoringCompiler(revision(flow)).submit({submission:{mode:'edit',addNodes:[{key:'consumer',kind:'template',config:{text:'{{checked.status}}/{{checked.httpStatus}}/{{checked.title}}/{{checked.text}}/{{checked.url}}'}}],addLinks:[{key:'feed',source:'checked',target:'consumer'}],coverage:{R1:['consumer']}}}))
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
    expect(row.purpose).toContain('10MB');expect(row.purpose).toContain('失败');expect(row.ports).toEqual({inputs:['url'],outputs:['status','httpStatus','title','text','url']});expect(c.queryTemplates(['http']).modules).toEqual(catalog)
    const brief=buildPlanningCommandBrief('workspace',Array.from({length:8},(_,i)=>({...templateContext().workflow,id:'flow-'+i,title:'流程 '+i})))
    expect(Buffer.byteLength(brief)).toBeLessThan(8000)
    expect(JSON.parse(brief).fragmentModules).toEqual(planningFragmentBriefLines())
    expect(planningFragmentBriefLines().find(line=>line.startsWith(moduleId))).toBe(moduleId+' '+row.purpose+' [url→status,httpStatus,title,text,url]')
    expect(fragmentModules.find(m=>m.id==='web-extract')!.implementationDigest).toBe('5f8002af6ebe28c1656ee0ef9b3167320bbcffc21b95c1874d6c3b90257b2928')
  })
  it('runs production Runtime with stubbed HTTP, static extraction, explicit states and bounded outputs',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'web-extract-runtime-')),storage=new WorkflowStorage(directory)
    let html='',status=200,headers:Record<string,string>={},failure='',httpCalls=0,externalCalls=0
    const forbidden=async()=>{externalCalls++;throw Error('No model/tool/network calls')}
    const catalog=new ToolCatalog({directory,workflows:id=>storage.workflows(id),nativeTools:()=>[],executeNative:forbidden,runWorkflow:forbidden,http:forbidden as typeof httpRequest})
    vi.stubGlobal('fetch',async(requestUrl:URL,init:RequestInit)=>{
      httpCalls++;expect(String(requestUrl)).toMatch(/^https:\/\/example\.com\//);expect(init.method).toBe('GET');expect(init.headers).toEqual({});expect(init.body).toBeUndefined();expect(init.redirect).toBe('manual');expect(init.signal?.aborted).toBe(false)
      if(failure)throw Error(failure)
      return new Response(new TextEncoder().encode(html),{status,headers})
    })
    const runtime=new WorkflowRuntime(storage,{generate:forbidden},createExecutionAdapters({catalog,workspaceRoot:()=>directory}),undefined,{runtimeDirectory:join(directory,'private-runtime')})
    const url='https://example.com/page'
    try{
      const cases:[string,number,Record<string,string>,string,string,string][]=[
        ['<!doctype html><html><head>hidden<title> A &amp; B &#x4e2d; &#25991; </title><style>head-style</style></head><body>nav<article>other</article><main><h1>Hello&nbsp; world</h1><p>read <b>me</b> &lt;ok&gt; &quot;yes&quot; &#39;x&#39;</p><script>throw new Error("executed"); const x="<script><main>bad</main>";</script><style>bad-style</style><noscript>bad-noscript</noscript><template>bad-template<template>nested</template></template><svg><text>bad-svg</text></svg><!-- bad-comment --></main>footer</body></html>',200,{'content-type':'text/html; charset=utf-8'},'ok','A & B 中 文','Hello world read me <ok> "yes" \'x\''],
        ['<head><title>Body</title>hidden</head><body><p>Body <em>fallback</em></p><div>next &copy;</div></body>',200,{'Content-Type':'TEXT/HTML'},'ok','Body','Body fallback next ©'],
        ['<body>nav<article>Article text</article>footer</body>',200,{'content-type':'application/xhtml+xml'},'ok','','Article text'],
        ['<body>fallback<main><script>hidden</script> &nbsp; </main></body>',200,{'content-type':'text/html'},'empty','',''],
        ['<body><!-- empty --><style>x</style></body>',200,{},'empty','',''],
        ['<head><title>No body</title></head>',200,{},'empty','No body',''],
        ['<body>ignored</body>',200,{'content-type':'application/json'},'not_html','',''],
        ['<body>ignored</body>',200,{'content-type':'text/plain'},'not_html','',''],
        ['<body>ignored</body>',200,{'content-type':''},'not_html','',''],
        ['',200,{},'empty','',''],
        ['<body>missing</body>',404,{'content-type':'text/html'},'http_error','',''],
        ['<body>server error</body>',500,{'content-type':'text/html'},'http_error','',''],
        ['redirect',302,{'content-type':'text/plain'},'http_error','',''],
        ['<title>'+('t'.repeat(600))+'</title><body><main>'+('x'.repeat(100000))+'</main></body>',200,{'content-type':'text/html'},'ok','t'.repeat(500),'x'.repeat(20000)],
      ]
      for(const [body,code,responseHeaders,state,title,text]of cases){
        html=body;status=code;headers=responseHeaders
        const candidate=compile();candidate.id='fixture-'+storage.workflows().length
        const flow=storage.save(candidate,0),run=await runtime.settle(runtime.start(flow.id,{text:url}).id)
        expect(run.status,run.error).toBe('success')
        const result=run.executions.find(e=>e.nodeId===flow.moduleInstances![0]!.roles.extract)!.data
        expect(result).toEqual({status:state,httpStatus:code,title,text,url,truncated:body.includes("x".repeat(100000))});expect(verifiedModuleInstances(storage.get(flow.id))).toHaveLength(1)
      }
      // Genuine container runtime: item URL, embedded item path and index all
      // render through the HTTP config binding path.
      html='<body><main>Nested</main></body>';status=200;headers={}
      for(const parameter of ['{{item.url}}','https://example.com/{{item.path}}?i={{index}}']){
        const d=nested('iteration');d.modules[0].parameters.url=parameter
        const candidate=compile(d);candidate.id='nested-'+storage.workflows().length;const flow=storage.save(candidate,0)
        const run=await runtime.settle(runtime.start(flow.id,{text:JSON.stringify([{url,path:'one'},{url,path:'two'}])}).id)
        expect(run.status,run.error).toBe('success');expect(run.outputs.result).toBe('["ok","ok"]')
      }
      for(const message of ['fixture timeout','fixture transport error']){
        failure=message;const candidate=compile();candidate.id='failure-'+storage.workflows().length;const flow=storage.save(candidate,0)
        const run=await runtime.settle(runtime.start(flow.id,{text:url}).id)
        expect(run.status).toBe('failed');expect(run.error).toContain(message)
        expect(run.executions.find(e=>e.nodeId===flow.moduleInstances![0]!.roles.fetch)!.status).toBe('failed')
      }
      failure='';html='x'.repeat(10_000_001);status=200;headers={'content-type':'text/html'}
      const oversized=compile();oversized.id='oversized';const saved=storage.save(oversized,0),failed=await runtime.settle(runtime.start(saved.id,{text:url}).id)
      expect(failed.status).toBe('failed');expect(failed.error).toContain('响应超过 10 MB 上限');expect(failed.executions.find(e=>e.nodeId===saved.moduleInstances![0]!.roles.extract)!.status).not.toBe('success')
      expect(httpCalls).toBe(cases.length+4+3);expect(externalCalls).toBe(0)
    }finally{vi.unstubAllGlobals();await runtime.close();storage.close();rmSync(directory,{recursive:true,force:true})}
  },60_000)
})
