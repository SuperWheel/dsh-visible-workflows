import {describe,it,expect} from 'vitest'
import {readFileSync,mkdtempSync,rmSync,writeFileSync,existsSync,statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import {defineTool,assertObjectJsonSchema,validateJsonSchemaValue} from '@deepseek-ai/dsh-tools'
import {WorkflowAuthoringCompiler} from '../src/shared/planning-authoring.ts'
import {TemplateFillingCompiler} from '../src/shared/planning-template-compiler.ts'
import {fragmentModules,fragmentContract,fragmentCatalog} from '../src/shared/planning-module-fragment-contract.ts'
import {verifiedModuleInstances} from '../src/shared/planning-module-fragments.ts'
import {READ_WINDOW_CODE,VERIFIED_COMPARE_CODE,VERIFIED_READ_WINDOW,VERIFIED_TARGET_CODE} from '../src/shared/planning-verified-file-recipe.ts'
import {planningNativeFileWriteIssues,planningToolPreconditionIssues} from '../src/shared/planning-tool-preconditions.ts'
import {isReviewedFileWriteTarget} from '../src/shared/planning-review-recipe.ts'
import {planningReviewIssues} from '../src/shared/planning-review.ts'
import {planningEditView} from '../src/shared/planning-edits.ts'
import {allNodes,parseWorkflow} from '../src/shared/workflow-validation.ts'
import {planningDigest} from '../src/host/planning/service.ts'
import {exportWorkflowJson,importWorkflowJson} from '../src/shared/workflow-format.ts'
import {inspectWorkflowReadiness} from '../src/host/workflow-readiness.ts'
import {WorkflowStorage} from '../src/host/storage.ts'
import {WorkflowRuntime} from '../src/host/runtime.ts'
import {createExecutionAdapters} from '../src/host/execution-adapters.ts'
import {ToolCatalog} from '../src/host/tool-catalog.ts'
import {buildPlanningCommandBrief,planningFragmentBriefLines} from '../src/host/planning/command-brief.ts'
import {templateContext} from './fixtures/planning-compiler/template.ts'
import {tools,sdk,FsError,attest} from './fixtures/t18-tools.ts'
import type {Workflow} from '../src/shared/types.ts'

const moduleId='verified-file-write@1.1.0',ports=['path','operation','check','checkNote']
const parameters=(content='{{prepare.text}}',target='out.txt')=>({target,content})
const context=()=>({...templateContext(),tools:tools()})
function create():any{return {mode:'create',title:'窗口核对写入',nodes:[
  {key:'start',kind:'input',config:{fields:[{name:'text',label:'正文',type:'paragraph',required:false}]}},
  {key:'prepare',kind:'template',config:{text:'{{input.text}}'}},
  {key:'result',kind:'output',config:{text:ports.map(p=>'{{save.'+p+'}}').join('/'),outputName:'result'}},
],modules:[{key:'save',module:moduleId,parameters:parameters()}],chains:[{key:'main',nodes:['start','prepare','save','result']}],coverage:{R1:['save','result']}}}
function filling(doc:any){const d=structuredClone(doc);if(d.nodes){d.forms=d.nodes.map(({kind,config,...n}:any)=>({...n,template:kind,values:config}));delete d.nodes}return d}
const accepted=(r:ReturnType<WorkflowAuthoringCompiler['submit']>)=>{if(!r.ok)throw Error(JSON.stringify(r.feedback));return r.value.candidate!}
const compile=(d=create())=>accepted(new WorkflowAuthoringCompiler(context()).submit({submission:d}))
const revision=(flow:Workflow)=>({...context(),operation:'revise' as const,workflow:{...structuredClone(flow),revision:1},targetNodeIds:allNodes(flow).map(n=>n.id)})
const refs=(flow:Workflow)=>new Map(allNodes(flow).map((n,i)=>[n.id,'n'+(i+1)]))
const source=readFileSync(new URL('./fixtures/t18-sdk/dsh-tool-fs.js.txt',import.meta.url),'utf8')
// Execute the frozen original verbatim, without imports/platform registration.
const frozenWindow=new Function('Buffer','FsError',source.slice(source.indexOf('function newAccumulator()'),source.indexOf('/**\n* Format a read outcome'))+'\nreturn buildWindow;')(Buffer,FsError)
const portedWindow=new Function(READ_WINDOW_CODE+'\nreturn expectedReadWindow;')()
const compare=new Function(VERIFIED_COMPARE_CODE+'\nreturn main;')()

describe('T24.2 verified-file-write fragment',()=>{
  it.each([WorkflowAuthoringCompiler,TemplateFillingCompiler])('creates root graphs with one entry/exit and resolves all public ports through $name',C=>{
    const d=create(),flow=accepted(new C(context()).submit({submission:C===TemplateFillingCompiler?filling(d):d}))
    expect(flow).toEqual(compile(d));expect(verifiedModuleInstances(flow)).toHaveLength(1)
    const r=flow.moduleInstances![0]!,ids=new Set(Object.values(r.roles))
    expect(flow.nodes.find(n=>n.id===r.roles.compare)!.kind).toBe('code')
    expect(flow.edges.filter(e=>ids.has(e.target)&&!ids.has(e.source)).map(e=>e.target)).toEqual([r.roles.validate])
    expect(flow.edges.filter(e=>ids.has(e.source)&&!ids.has(e.target)).map(e=>e.source)).toEqual([r.roles.compare])
    expect(flow.nodes.find(n=>n.kind==='output')!.config.text).toBe(ports.map(p=>'{{'+r.roles.compare+'.'+p+'}}').join('/'))
    expect(verifiedModuleInstances(importWorkflowJson(exportWorkflowJson(flow),'workspace').workflow)).toHaveLength(1)
    expect(planningToolPreconditionIssues(flow,context())).toEqual([])
    expect(planningReviewIssues(flow,context())).toEqual([])
  })
  it.each([WorkflowAuthoringCompiler,TemplateFillingCompiler])('rejects container placement with a clear root-only diagnostic through $name',C=>{
    for(const kind of ['iteration','loop']){
      const d=create();d.nodes.splice(1,0,{key:'outer',kind,config:kind==='iteration'?{iterator:'input.text',outputVariable:'save.check'}:{maxIterations:1,outputVariable:'save.check'}})
      d.chains=[{key:'main',nodes:['start','prepare','outer','result']},{key:'body',container:'outer',nodes:['save']}];d.nodes.at(-1).config.text='{{outer.text}}'
      const r=new C(context()).submit({submission:C===TemplateFillingCompiler?filling(d):d});expect(r.ok).toBe(false)
      if(!r.ok)expect(r.feedback.issues[0]).toMatchObject({code:'MODULE_SCOPE',message:expect.stringContaining('只允许根作用域')})
    }
  })
  it.each([WorkflowAuthoringCompiler,TemplateFillingCompiler])('rejects undeclared ports with candidates and private role references through $name',C=>{
    for(const [text,code]of [['{{save.verified}}','MODULE_OUTPUT_PORT'],['{{save__write.value}}','MODULE_INTERNAL_REFERENCE'],['{{save__compare.check}}','MODULE_INTERNAL_REFERENCE']]){
      const d=create();d.nodes[2].config.text=text
      const r=new C(context()).submit({submission:C===TemplateFillingCompiler?filling(d):d});expect(r.ok).toBe(false)
      if(!r.ok){expect(r.feedback.issues[0]!.code).toBe(code);if(code==='MODULE_OUTPUT_PORT')expect(r.feedback.issues[0]!.candidates).toEqual(ports)}
    }
    const d=create();d.modules[0].parameters.content='{{save__readback.value}}'
    const r=new C(context()).submit({submission:C===TemplateFillingCompiler?filling(d):d});expect(r.ok).toBe(false)
    if(!r.ok)expect(r.feedback.issues[0]!.code).toBe('MODULE_INTERNAL_REFERENCE')
  })
  it.each([WorkflowAuthoringCompiler,TemplateFillingCompiler])('reports a bad chain step after the module at the declared chain position through $name (Desktop r55 C)',C=>{
    const d=create();d.chains[0].nodes.splice(3,0,'stat');d.coverage.R1.push('stat')
    const compiler=new C(context()),r=compiler.submit({submission:C===TemplateFillingCompiler?filling(d):d});expect(r.ok).toBe(false);if(r.ok)return
    const issue=r.feedback.issues.find(i=>i.code==='UNKNOWN_REFERENCE'&&i.path?.startsWith('/chainsByKey'))!
    expect(issue).toMatchObject({path:'/chainsByKey/main/nodes/3',allowedPaths:['/chainsByKey/main/nodes/3']})
    expect(issue.candidates).toContain('save');expect(JSON.stringify(issue)).not.toMatch(/save__|mainPart/)
    const flow=accepted(compiler.submit({submission:{mode:'repair',draftRevision:r.feedback.draftRevision,patches:[{op:'remove',path:'/chainsByKey/main/nodes/3'},{op:'remove',path:'/coverage/R1/2'}]}}))
    expect(flow).toEqual(compile())
  })
  it.each([WorkflowAuthoringCompiler,TemplateFillingCompiler])('enforces exact literal targets, upstream content and no override slots through $name',C=>{
    for(const target of ['/tmp/out','../out','a/../out','a/./out','a//out','C:\\out','out\\file','out\0file','{{prepare.text}}','{{input.path.deep}}','{{ input.path }}','{{input.path | trim}}','prefix{{input.path}}','{{input.path}}{{input.other}}','{{env.path}}','{{item.path}}','*.txt','a?.txt','[ab].txt','a(b).txt','!out','.dsh-drafts/out','']){
      const d=create();d.modules[0].parameters.target=target
      expect(new C(context()).submit({submission:C===TemplateFillingCompiler?filling(d):d}).ok,target).toBe(false)
    }
    for(const content of ['literal','prefix {{prepare.text}}','{{prepare.text | trim}}','{{item}}','{{index}}','{{result.text}}','{{missing.text}}']){
      const d=create();d.modules[0].parameters.content=content
      expect(new C(context()).submit({submission:C===TemplateFillingCompiler?filling(d):d}).ok,content).toBe(false)
    }
    for(const name of ['readback','readToolId','toolId','code','implementation','maxBytes']){
      const d=create();d.modules[0].parameters[name]=false
      expect(new C(context()).submit({submission:C===TemplateFillingCompiler?filling(d):d}).ok,name).toBe(false)
    }
    const unrelated=create();unrelated.nodes.push({key:'other',kind:'template',config:{text:'x'}});unrelated.modules[0].parameters.content='{{other.text}}'
    expect(new C(context()).submit({submission:C===TemplateFillingCompiler?filling(unrelated):unrelated}).ok).toBe(false)
    for(const target of ['reports/daily.md','报告/结果.txt']){const d=create();d.modules[0].parameters.target=target;expect(verifiedModuleInstances(compile(d))).toHaveLength(1)}
  })
  it.each([WorkflowAuthoringCompiler,TemplateFillingCompiler])('edits add/update/remove with stable identities through $name',C=>{
    const flow=compile(),names=refs(flow),prepare=names.get(flow.nodes.find(n=>n.kind==='template')!.id)!,output=names.get(flow.nodes.find(n=>n.kind==='output')!.id)!
    const set=(text:string)=>C===TemplateFillingCompiler?{values:{text}}:{set:{text}}
    const changed=accepted(new C(revision(flow)).submit({submission:{mode:'edit',updateModules:{save:{parameters:parameters('{{'+prepare+'.text}}','reports/new.txt')}},coverage:{R1:['save']}}}))
    expect(verifiedModuleInstances(changed)).toHaveLength(1);expect(changed.moduleInstances![0]!.roles).toEqual(flow.moduleInstances![0]!.roles)
    expect(planningEditView(revision(changed)).modules![0]!.parameters.target).toBe('reports/new.txt')
    expect(planningEditView(revision(changed)).nodes.some(n=>n.kind==='tool'||n.kind==='code')).toBe(false)
    const removed=accepted(new C(revision(changed)).submit({submission:{mode:'edit',removeModules:['save'],removeLinks:[{source:prepare,target:'save'},{source:'save',target:output}],addLinks:[{key:'bridge',source:prepare,target:output}],updates:{[output]:set('{{'+prepare+'.text}}')},coverage:{R1:[prepare,output]}}}))
    expect(removed.moduleInstances).toEqual([]);expect(allNodes(removed).some(n=>n.kind==='tool'||n.kind==='code')).toBe(false)
    const next=refs(removed),p=next.get(flow.nodes.find(n=>n.kind==='template')!.id)!,o=next.get(flow.nodes.find(n=>n.kind==='output')!.id)!
    const added=accepted(new C(revision(removed)).submit({submission:{mode:'edit',addModules:[{key:'again',module:moduleId,parameters:parameters('{{'+p+'.text}}')}],removeLinks:[{source:p,target:o}],addLinks:[{key:'in',source:p,target:'again'},{key:'out',source:'again',target:o}],updates:{[o]:set('{{again.check}}')},coverage:{R1:['again',o]}}}))
    expect(verifiedModuleInstances(added)).toHaveLength(1)
  })
  it('detaches altered probe/read/write/compare configs and preserves new downstream consumers',()=>{
    const flow=compile(),record=flow.moduleInstances![0]!
    for(const [role,field,value]of [['probe','inputs',{pattern:'*.txt'}],['exists','code','function main(){return {exists:false}}'],['prior','cache','reuse'],['readback','inputs',{file_path:'out.txt',offset:2,limit:1}],['write','inputs',{file_path:'other.txt',content:'changed'}],['compare','code',VERIFIED_COMPARE_CODE+'\n// changed'],['compare','inputs',{}]]){
      const copy=structuredClone(flow),node=allNodes(copy).find(n=>n.id===record.roles[role as string])!;(node.config as any)[field as string]=value
      const before=structuredClone(copy);expect(verifiedModuleInstances(copy)).toEqual([]);expect(copy).toEqual(before)
    }
    const after=accepted(new WorkflowAuthoringCompiler(revision(flow)).submit({submission:{mode:'edit',addNodes:[{key:'consumer',kind:'template',config:{text:'{{save.check}}'}}],addLinks:[{key:'feed',source:'save',target:'consumer'}],coverage:{R1:['consumer']}}}))
    expect(verifiedModuleInstances(after)).toHaveLength(1)
  })
  it('module candidates digest identically once in the stored key order (r29 optimization mismatch)',()=>{
    const raw=compile(),stored=parseWorkflow(structuredClone(raw))
    // The compiler appends moduleInstances last; the planning store and optimization report re-parse it after revision.
    expect(Object.keys(raw).at(-1)).toBe('moduleInstances');expect(planningDigest(raw)).not.toBe(planningDigest(stored))
    expect(planningDigest(parseWorkflow(structuredClone(stored)))).toBe(planningDigest(stored))
  })
  it('keeps T18 proofs, registered tool validation, availability and T20 human-gate policy unchanged',()=>{
    const flow=compile(),r=flow.moduleInstances![0]!
    for(const role of ['probe','exists','prior']){
      const copy=structuredClone(flow),node=copy.nodes.find(n=>n.id===r.roles[role])!;node.config.inputs={file_path:'other.txt',pattern:'*.txt'}
      expect(planningToolPreconditionIssues(copy,context()).map(i=>i.code)).toContain('TOOL_PRECONDITION_UNPROVEN')
    }
    expect(new WorkflowAuthoringCompiler({...context(),tools:[]}).submit({submission:create()}).ok).toBe(false)
    // A stale/forged registered contract remains rejected by the existing binding.
    const forged=context();(forged.tools[1]!.operationContract as any).digest='0'.repeat(64)
    expect(()=>planningToolPreconditionIssues(flow,forged)).toThrow('摘要')
    expect(()=>new WorkflowAuthoringCompiler(forged).submit({submission:create()})).toThrow('摘要')
    const d=create();d.nodes.splice(2,0,{key:'gate',kind:'human',config:{prompt:'确认',actions:[{id:'approve',label:'通过'},{id:'reject',label:'退回'}]}})
    d.chains=[{key:'main',nodes:['start','prepare','save','gate']}];d.links=[{key:'approved',source:'gate',target:'result',port:'approve'},{key:'rejected',source:'gate',target:'result',port:'reject'}]
    for(const C of [WorkflowAuthoringCompiler,TemplateFillingCompiler]){
      const result=new C(context()).submit({submission:C===TemplateFillingCompiler?filling(d):d});expect(result.ok).toBe(false)
      if(!result.ok)expect(result.feedback.issues.map(i=>i.code)).toContain('REVIEW_BEFORE_EFFECT')
    }
    // Even placing this gate-free fragment after approval does not replace the
    // required T20 loop/form/retained-observation commit recipe.
    const gated=structuredClone(flow),gate={...flow.nodes[0]!,id:'gate',kind:'human' as const,config:{actions:[{id:'approve',label:'通过'},{id:'reject',label:'退回'}]}}
    gated.nodes.push(gate);const edge=gated.edges.find(e=>e.target===r.roles.validate)!;const prior=edge.source;edge.source='gate';edge.port='approve';gated.edges.push({id:'to-gate',source:prior,target:'gate'})
    expect(planningReviewIssues(gated,context()).map(i=>i.code)).toContain('REVIEW_BEFORE_EFFECT')
  })
  it('retains the production readiness block for unavailable or unauthorized tools',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'verified-readiness-'))
    try{
      const report=await inspectWorkflowReadiness(compile(),{workspaceRoot:directory,catalog:{models:[],tools:context().tools.map(t=>({...t,available:false})),presets:[],workflows:[]}})
      expect(report.canRun).toBe(false)
      expect(new Set(report.issues.filter(i=>i.kind==='tool').map(i=>i.dependencyId))).toEqual(new Set(['native:glob','native:read','native:write']))
    }finally{rmSync(directory,{recursive:true,force:true})}
  })
  it('shares byte-identical SDK-valid contracts, catalog/template query, digest and brief budget',()=>{
    expect((fragmentContract().items as any).oneOf).toHaveLength(5)
    for(const c of [context(),revision(compile())]){
      const a=new WorkflowAuthoringCompiler(c),b=new TemplateFillingCompiler(c)
      for(const schema of [a.schema,a.nextSchema,b.schema,b.nextSchema])assertObjectJsonSchema(schema)
      const props=(s:any)=>s.properties.submission.oneOf[0].properties
      for(const name of c.operation==='create'?['modules']:['addModules','updateModules','removeModules'])for(const schema of [a.nextSchema,b.schema,b.nextSchema])expect(JSON.stringify(props(schema)[name])).toBe(JSON.stringify(props(a.schema)[name]))
    }
    const c=new TemplateFillingCompiler(context());expect(validateJsonSchemaValue(c.nextSchema,{submission:filling(create())})).toEqual([])
    expect(c.queryTemplates(['template']).modules).toEqual(fragmentCatalog())
    const row=fragmentModules.find(m=>m.id==='verified-file-write')!;expect(row.scopes).toBe('root');expect(Object.keys(row.outputs)).toEqual(ports)
    expect(row.implementationDigest).toBe('71f31824dd59d14c1392c1f7e69a3ff5dc92af54b0f01a63279e7af7083434ef')
    const brief=buildPlanningCommandBrief('workspace',Array.from({length:8},(_,i)=>({...templateContext().workflow,id:'flow-'+i,title:'流程 '+i})))
    expect(Buffer.byteLength(brief)).toBeLessThan(8000)
    expect(JSON.parse(brief).fragmentModules).toEqual(planningFragmentBriefLines());expect(brief).toContain(moduleId)
  })
  it.each([WorkflowAuthoringCompiler,TemplateFillingCompiler])('accepts one input target reference and revalidates its guard through $name',C=>{
    const d=create();d.nodes[0].config.fields.push({name:'outputPath',label:'输出路径',type:'text',required:true});d.modules[0].parameters.target='{{input.outputPath}}'
    const flow=accepted(new C(context()).submit({submission:C===TemplateFillingCompiler?filling(d):d})),record=flow.moduleInstances![0]!
    expect(verifiedModuleInstances(flow)).toHaveLength(1);expect(planningToolPreconditionIssues(flow,context())).toEqual([])
    expect(planningNativeFileWriteIssues(flow,context())).toEqual([])
    const unknown={...context(),tools:context().tools.map(({operationContract,...tool})=>tool)}
    expect(new C(unknown).submit({submission:C===TemplateFillingCompiler?filling(d):d}).ok).toBe(true)
    const changed=accepted(new C(revision(flow)).submit({submission:{mode:'edit',updateModules:{save:{parameters:parameters('{{'+refs(flow).get(flow.nodes.find(n=>n.kind==='template')!.id)+'.text}}','{{input.outputPath}}')}},coverage:{R1:['save']}}}))
    expect(verifiedModuleInstances(changed)).toHaveLength(1)
    for(const mutation of ['code','bypass']){
      const bad=structuredClone(flow),guard=bad.nodes.find(n=>n.id===record.roles.validate)!
      if(mutation==='code')guard.config.code+='\n// changed'
      else bad.edges=bad.edges.filter(e=>e.target!==record.roles.probe).concat({id:'bypass',source:bad.nodes.find(n=>n.kind==='input')!.id,target:record.roles.probe!})
      expect(verifiedModuleInstances(bad)).toHaveLength(0);expect(planningNativeFileWriteIssues(bad,context()).map(i=>i.code)).toContain('FILE_WRITE_NEEDS_READ')
    }
    const old=structuredClone(flow);old.moduleInstances![0]!.version='1.0.0';expect(verifiedModuleInstances(old)).toHaveLength(0)
    d.modules[0].module='verified-file-write@1.0.0';const rejected=new C(context()).submit({submission:C===TemplateFillingCompiler?filling(d):d})
    expect(rejected.ok).toBe(false);if(!rejected.ok)expect(rejected.feedback.issues[0]!.code).toBe('MODULE_UNKNOWN')
  })
  it('uses the same literal and resolved path predicate',()=>{
    const validate=new Function(VERIFIED_TARGET_CODE+';return main;')()
    const paths=['out.txt','报告/结果.md','a/b','.dsh-drafts','/out','../out','a/./out','a//b','a/','a\\b','C:out','a\0b','{a}','*.txt','a?.txt','[a]','(a)','!a','.dsh-drafts/a','']
    for(const path of paths){if(isReviewedFileWriteTarget(path))expect(validate({target:path})).toEqual({target:path});else expect(()=>validate({target:path})).toThrow('写入目标无效')}
    for(const target of [null,1,{},[],false])expect(()=>validate({target})).toThrow('写入目标无效')
  })
  it('fails invalid resolved targets before glob/read/write in WorkflowRuntime',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'verified-invalid-target-')),storage=new WorkflowStorage(directory),calls:string[]=[]
    const forbidden=async()=>{throw Error('No model/network calls')}
    const catalog=new ToolCatalog({directory,workflows:id=>storage.workflows(id),nativeTools:()=>context().tools,executeNative:async name=>{calls.push(name);throw Error('Unexpected file action')},runWorkflow:forbidden,http:forbidden})
    const runtime=new WorkflowRuntime(storage,{generate:forbidden},createExecutionAdapters({catalog,workspaceRoot:()=>directory}),undefined,{runtimeDirectory:join(directory,'runtime')})
    try{
      const d=create();d.nodes[0].config.fields.push({name:'outputPath',label:'输出路径',type:'text',required:false});d.modules[0].parameters.target='{{input.outputPath}}'
      const flow=storage.save(compile(d),0)
      for(const outputPath of ['/out','a//b','a/./b','../out','a\\b','C:out','a\0b','{a}','*','?','[a]','(a)','!a','.dsh-drafts/a','']){
        const run=await runtime.settle(runtime.start(flow.id,{text:'body',outputPath}).id)
        expect(run.status).toBe('failed');expect(run.error).toContain('写入目标无效');expect(calls).toEqual([])
      }
    }finally{await runtime.close();storage.close();rmSync(directory,{recursive:true,force:true})}
  },60_000)
  it('ports frozen SDK buildWindow exactly across chunks, CRLF, EOF, Unicode, caps and offsets',async()=>{
    const texts=['','\n','\n\n','abc','abc\n','abc\r\n','a\rb\r','\r','\r\n','中文🙂\ud800\udc00\ud800\udc00\udfff','x'.repeat(2000),'x'.repeat(2000)+'\r\n','x'.repeat(2000)+'\rZ\n','x'.repeat(9000),Array(2002).fill('line').join('\n'),Array(40).fill('中'.repeat(600)).join('\n')]
    let state=24
    for(let n=0;n<80;n++){let s='';for(let i=0;i<n*7;i++){state=(Math.imul(state,1664525)+1013904223)>>>0;s+=['x','\r','\n','中','🙂','\ud800','\udfff'][state%7]}texts.push(s)}
    const requests=[VERIFIED_READ_WINDOW,{offset:1,limit:3,maxLineLength:4,maxBytes:15},{offset:2,limit:5,maxLineLength:1,maxBytes:4},{offset:1,limit:1,maxLineLength:2000,maxBytes:1},{offset:1,limit:3000,maxLineLength:2000,maxBytes:51200}]
    for(const text of texts)for(const request of requests)for(const size of [1,17,text.length||1]){
      const chunks=Array.from({length:Math.ceil(text.length/size)},(_,i)=>text.slice(i*size,(i+1)*size))
      let expected:any;try{expected=await frozenWindow(chunks,request,'out.txt')}catch(error){expect(()=>portedWindow(chunks,request,'out.txt')).toThrow((error as Error).message);continue}
      expect(portedWindow(chunks,request,'out.txt')).toEqual(expected)
    }
  })
  it('uses a closed check enum, labels invisible CR/LF differences and never matches partial content',async()=>{
    const run=async(content:string,actual=content,write:any={})=>compare({content,target:'out.txt',window:VERIFIED_READ_WINDOW,existed:true,write,readback:{offset:1,...await frozenWindow([actual],VERIFIED_READ_WINDOW,'out.txt')}})
    expect(await run('abc\r\n','abc\n')).toMatchObject({operation:'updated',check:'window-match',checkNote:expect.stringContaining('不证明精确相等')})
    expect(await run('abc','abc\n')).toMatchObject({check:'window-match'})
    expect(await run('abc','tampered')).toMatchObject({check:'mismatch'})
    for(const text of ['x'.repeat(2001),Array(2001).fill('a').join('\n'),Array(100).fill('x'.repeat(520)).join('\n')])expect(await run(text)).toMatchObject({check:'unchecked'})
    expect(await run('abc','abc',{operation:'create',path:'/isolated/out.txt'})).toMatchObject({path:'/isolated/out.txt',operation:'created'})
    expect(await run('x'.repeat(1999))).toMatchObject({check:'window-match'})
    expect(await run('x'.repeat(2000))).toMatchObject({check:'unchecked'})
    expect(await run('x'.repeat(2000),'x'.repeat(2000)+'\rhidden')).toMatchObject({check:'unchecked'})
    expect(await run(Array(2000).fill('a').join('\n'))).toMatchObject({check:'window-match'})
    expect(await run(Array(100).fill('x'.repeat(511)).join('\n')+'\n')).toMatchObject({check:'window-match'})
    expect(await run(Array(100).fill('x'.repeat(511)).join('\n')+'\r\n')).toMatchObject({check:'unchecked'})
  })
  it('runs production WorkflowRuntime using frozen SDK tools and observation policy in an isolated workspace',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'verified-file-runtime-')),storage=new WorkflowStorage(directory),definitions=new Map<string,any>(),events=new Map<string,Function[]>(),calls:string[]=[]
    const hash=(path:string)=>existsSync(path)?createHash('sha256').update(readFileSync(path)).digest('hex'):undefined
    let tamper=false,denied=false,externalCalls=0,writes=0
    const forbidden=async()=>{externalCalls++;throw Error('No model/network calls')}
    const provider={resolve:async(path:string)=>{expect(path).toBe('out.txt');return {targetKey:resolve(directory,path),displayPath:resolve(directory,path)}},processPath:(target:any)=>target.displayPath,
      stat:async(target:any)=>{if(denied)throw new FsError('fixture denied','FS_PERMISSION_DENIED');const path=target.displayPath;return existsSync(path)?{type:statSync(path).isFile()?'file':'directory',size:statSync(path).size,version:hash(path)}:undefined},
      readText:async(target:any)=>tamper&&calls.at(-2)==='write'?'tampered':readFileSync(target.displayPath,'utf8'),
      writeText:async(target:any,content:string,intent:any)=>{const path=target.displayPath,before=existsSync(path)?readFileSync(path,'utf8'):null;if(intent?.kind==='createIfAbsent'&&before!==null)throw new FsError('not observed','FS_NOT_OBSERVED');if(intent?.kind==='replaceIfVersion'&&hash(path)!==intent.version)throw new FsError('external change','FS_STALE_VERSION');writeFileSync(path,content,{flag:intent?.kind==='createIfAbsent'?'wx':'w'});writes++;return {operation:before===null?'create':'update',before,after:content,version:hash(path)}},
    }
    const ctx={fs:provider,workingDirectory:{ensure:async()=>directory},tools:{register:(t:any)=>definitions.set(t.name,t),get:(name:string)=>definitions.get(name)},systemPrompt:{section:()=>{},getSectionOrder:()=>0},effect:()=>{},on:(name:string,f:Function)=>events.set(name,[...(events.get(name)??[]),f]),emit:(name:string,...args:any[])=>{for(const f of events.get(name)??[])f(...args)},waterfall:async(name:string,...args:any[])=>events.get(name)?.[0]?.(...args)}
    sdk(ctx)
    // Re-register read with the frozen Config's own resolved defaults. The
    // shared T18 helper deliberately uses a different byte cap; leave it intact.
    const frozenRead=new Function('z','defineTool','FsError','langFromPath',source.replace(/^import .*;\n/gm,'').replace(/^export .*;$/gm,'')+'\nreturn {apply,Config};')(z,defineTool,FsError,()=>undefined)
    const resolved=frozenRead.Config({read:true,readImage:false,write:false,edit:false})
    expect({offset:1,limit:resolved.readLimit,maxLineLength:resolved.readMaxLineLength,maxBytes:resolved.readMaxBytes}).toEqual(VERIFIED_READ_WINDOW)
    frozenRead.apply(ctx,resolved)
    const owner={session:{}},native=[attest('read',definitions.get('read')),attest('write',definitions.get('write')),tools()[2]!]
    const catalog=new ToolCatalog({directory,workflows:id=>storage.workflows(id),nativeTools:()=>native,executeNative:async(name,args,request)=>{
      calls.push(name)
      if(name==='glob'){expect(args).toEqual({pattern:'out.txt'});return {value:{root:'.',paths:existsSync(join(directory,'out.txt'))?['./out.txt']:['sub/out.txt']}}}
      if(name==='read')expect(args).toEqual({file_path:'out.txt',offset:1,limit:2000})
      const value=await definitions.get(name).execute(args,{agent:owner,signal:request.signal});return {value}
    },runWorkflow:forbidden,http:forbidden})
    const runtime=new WorkflowRuntime(storage,{generate:forbidden},createExecutionAdapters({catalog,workspaceRoot:()=>directory}),undefined,{runtimeDirectory:join(directory,'private-runtime')})
    try{
      const cases:[string,string,string][]=[['hello','created','window-match'],['new content','updated','window-match'],['x'.repeat(2000),'updated','unchecked'],['x'.repeat(2001),'updated','unchecked'],[Array(2001).fill('a').join('\n'),'updated','unchecked'],[Array(100).fill('中'.repeat(180)).join('\n'),'updated','unchecked'],['a\r\nb\r\n','updated','window-match'],['','updated','window-match'],['abc','updated','mismatch']]
      for(const [text,operation,check]of cases){
        calls.length=0;tamper=check==='mismatch'
        const d=create();d.nodes[0].config.fields.push({name:'outputPath',label:'输出路径',type:'text',required:true});d.modules[0].parameters.target='{{input.outputPath}}'
        const candidate=accepted(new WorkflowAuthoringCompiler({...context(),tools:native}).submit({submission:d}));candidate.id='fixture-'+storage.workflows().length
        const flow=storage.save(candidate,0),run=await runtime.settle(runtime.start(flow.id,{text,outputPath:'out.txt'}).id)
        expect(run.status,run.error).toBe('success')
        expect(calls).toEqual(operation==='created'?['glob','write','read']:['glob','read','write','read'])
        const data=run.executions.find(e=>e.nodeId===flow.moduleInstances![0]!.roles.compare)!.data
        expect(data).toMatchObject({path:join(directory,'out.txt'),operation,check,checkNote:expect.any(String)})
        expect(readFileSync(join(directory,'out.txt'),'utf8')).toBe(text)
        expect(verifiedModuleInstances(storage.get(flow.id))).toHaveLength(1)
      }
      denied=true;calls.length=0;const candidate=compile();candidate.id='denied';const flow=storage.save(candidate,0),run=await runtime.settle(runtime.start(flow.id,{text:'must not write'}).id)
      expect(run.status).toBe('failed');expect(run.error).toContain('fixture denied');expect(calls).toEqual(['glob','read']);expect(writes).toBe(cases.length);expect(externalCalls).toBe(0)
    }finally{await runtime.close();storage.close();rmSync(directory,{recursive:true,force:true})}
  },60_000)
})
