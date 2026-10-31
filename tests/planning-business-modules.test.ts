import { describe,it,expect } from 'vitest'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { businessModuleCatalog,businessModuleRequestSchema,compileBusinessModule,expandBusinessModule,updateBusinessModule } from '../src/shared/planning-business-modules.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { createExecutionAdapters,httpRequest } from '../src/host/execution-adapters.ts'
import { ToolCatalog } from '../src/host/tool-catalog.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'
import { arrangeNodes } from '../src/shared/canvas-layout.ts'

const request=()=>({moduleId:'structured-result-table' as const,version:'1.0.0' as const,instanceKey:'report',parameters:{title:'核对结果',columns:[{key:'name',label:'项目'},{key:'amount',label:'金额'}],emptyText:'无记录'}})
describe('pinned deterministic business module',()=>{
  it('expands fixed implementation and topology; parameters affect data only',()=>{
    const first=expandBusinessModule(request()),input=request();input.parameters.title='第二份结果'
    const second=expandBusinessModule(input)
    expect(second.nodesByKey.reportRender.config.code).toBe(first.nodesByKey.reportRender.config.code)
    expect(second.chainsByKey).toEqual(first.chainsByKey)
    expect(second.provenance.implementationDigest).toBe(first.provenance.implementationDigest)
    expect(second.provenance.parametersDigest).not.toBe(first.provenance.parametersDigest)
    const modified=businessModuleCatalog();modified[0]!.version='tampered'
    modified[0]!.inputs.rows.type='tampered'
    expect(businessModuleCatalog()[0]!.version).toBe('1.0.0')
    expect(businessModuleCatalog()[0]!.inputs.rows.type).toBe('array')
    expect(first.provenance.implementationDigest).toBe('97ab7ab7732fc5cc1f22bce41bcce0b280401042345e18106513385bb9a53419')
  })
  it('compiles through shared validation, allocates isolated Host IDs, rejects version/contract drift',()=>{
    const context=templateContext(),before=structuredClone(context)
    const first=compileBusinessModule(request(),context)
    const other=templateContext();other.nodeIds=other.nodeIds.map(id=>'second-'+id)
    const second=compileBusinessModule({...request(),instanceKey:'other'},other)
    expect(first.candidate!.nodes).toHaveLength(3)
    expect(first.candidate!.nodes).toEqual(arrangeNodes(first.candidate!))
    expect(first.candidate!.nodes.find(node=>node.kind==='code')!.id).not.toBe(second.candidate!.nodes.find(node=>node.kind==='code')!.id)
    expect(first.candidate!.nodes.find(node=>node.kind==='code')!.config.code).toBe(second.candidate!.nodes.find(node=>node.kind==='code')!.config.code)
    expect(first.issues).toEqual([]);expect(context).toEqual(before)
    expect(()=>compileBusinessModule({...request(),version:'2.0.0'},context)).toThrow()
    expect(()=>compileBusinessModule({...request(),code:'arbitrary'},context)).toThrow()
    expect(()=>compileBusinessModule(request(),{...context,operation:'revise'})).toThrow('仅支持')
    expect(()=>compileBusinessModule(request(),{...context,workflow:{...context.workflow,nodes:context.workflow.nodes.map(node=>({...node,fixed:true}))}})).toThrow()
    expect(businessModuleRequestSchema.safeParse({...request(),parameters:{...request().parameters,title:'{{input.command}}'}}).success).toBe(false)
    expect(businessModuleRequestSchema.safeParse({...request(),parameters:{...request().parameters,columns:[{key:'name',label:'甲'},{key:'name',label:'乙'}]}}).success).toBe(false)
  })
  it('executes copied graph in production Graphon and QuickJS in independent temporary storage',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'planning-module-runtime-'))
    const storage=new WorkflowStorage(directory)
    let modelCalls=0
    const catalog=new ToolCatalog({directory,workflows:id=>storage.workflows(id),nativeTools:()=>[],executeNative:async()=>{throw Error('No tools allowed')},runWorkflow:async()=>{throw Error('No nested workflow allowed')},http:httpRequest})
    const runtime=new WorkflowRuntime(storage,{generate:async()=>{modelCalls++;throw Error('No model allowed')}},createExecutionAdapters({catalog,workspaceRoot:()=>directory}),undefined,{runtimeDirectory:join(directory,'private-graphon-runtime')})
    try{
      const compiled=compileBusinessModule(request(),templateContext()),flow=storage.save(compiled.candidate!,0)
      expect(flow.nodes.map(({id,x,y})=>({id,x,y}))).toEqual(compiled.candidate!.nodes.map(({id,x,y})=>({id,x,y})))
      expect(flow.nodes).toEqual(arrangeNodes(flow))
      const rows=[{name:'A|B\n<C>',amount:0},{name:'False',amount:false},{name:'Null',amount:null}]
      const first=await runtime.settle(runtime.start(flow.id,{rows:JSON.stringify(rows)}).id)
      expect(first.status).toBe('success')
      expect(first.outputs.result).toBe('# 核对结果\n\n| 项目 | 金额 |\n| --- | --- |\n| A&#124;B &lt;C&gt; | 0 |\n| False | false |\n| Null |  |')
      expect(first.executions.find(row=>row.nodeId===flow.nodes.find(node=>node.kind==='code')!.id)!.data).toMatchObject({count:3})
      const repeated=await runtime.settle(runtime.start(flow.id,{rows:JSON.stringify(rows)}).id)
      expect(repeated.outputs).toEqual(first.outputs)
      const empty=await runtime.settle(runtime.start(flow.id,{rows:'[]'}).id)
      expect(empty.outputs.result).toBe('# 核对结果\n\n无记录')
      const invalid=await runtime.settle(runtime.start(flow.id,{rows:'[{"name":"missing amount"}]'}).id)
      expect(invalid.status).toBe('failed');expect(invalid.error).toContain('missing column amount')
      const nested=await runtime.settle(runtime.start(flow.id,{rows:'[{"name":"nested","amount":{}}]'}).id)
      expect(nested.status).toBe('failed');expect(nested.error).toContain('scalar')
      expect(modelCalls).toBe(0)
    }finally{await runtime.close();storage.close();rmSync(directory,{recursive:true,force:true})}
  },60_000)
  it('updates only a published-instance parameter slot and rejects altered implementation, ports and provenance',()=>{
    const context=templateContext(),first=compileBusinessModule(request(),context),source=first.candidate!
    const revision={...context,operation:'revise' as const,workflow:{...structuredClone(source),revision:1}},input=request();input.parameters.title='新标题'
    const result=updateBusinessModule(input,revision,source,first.provenance)
    expect(result.issues).toEqual([])
    expect(result.candidate!.nodes.map(({id,x,y})=>({id,x,y}))).toEqual(source.nodes.map(({id,x,y})=>({id,x,y})))
    const codeBefore=source.nodes.find(node=>node.kind==='code')!,codeAfter=result.candidate!.nodes.find(node=>node.id===codeBefore.id)!
    expect(codeAfter.config.code).toBe(codeBefore.config.code)
    expect(codeAfter.config.inputs!.specification).toEqual(input.parameters)
    expect(result.candidate!.edges).toEqual(source.edges)
    expect(result.candidate!.nodes.filter(node=>node.id!==codeBefore.id)).toEqual(source.nodes.filter(node=>node.id!==codeBefore.id))
    const changed=structuredClone(revision);changed.workflow.nodes.find(node=>node.id===codeBefore.id)!.config.code+='\n// user changed'
    expect(()=>updateBusinessModule(input,changed,source,first.provenance)).toThrow('已改变')
    const port=structuredClone(revision);port.workflow.edges[0]!.port='invented'
    expect(()=>updateBusinessModule(input,port,source,first.provenance)).toThrow('已改变')
    expect(()=>updateBusinessModule(input,revision,source,{...first.provenance,implementationDigest:'0'.repeat(64)})).toThrow('不匹配')
  })
  it('continues to validate and revise the pre-T22 v1 provenance byte-for-byte',()=>{
    // Published v1 shape and digests before a second module was registered.
    const legacy={moduleId:'structured-result-table',version:'1.0.0',instanceKey:'report',implementationDigest:'97ab7ab7732fc5cc1f22bce41bcce0b280401042345e18106513385bb9a53419',parametersDigest:'cf78b529c84f8104c8f881d82d484ea568649a9a7557155838b55e3dff4bf78a',nodeIds:['host-start','host-end','allocated-0']}
    const c=templateContext(),first=compileBusinessModule(request(),c)
    expect(JSON.stringify(first.provenance)).toBe(JSON.stringify(legacy))
    const input=request();input.parameters.emptyText='新空结果'
    const updated=updateBusinessModule(input,{...c,operation:'revise',workflow:{...first.candidate!,revision:1}},first.candidate!,legacy)
    expect(updated.issues).toEqual([])
    expect(updated.provenance).toEqual({...legacy,parametersDigest:expandBusinessModule(input).provenance.parametersDigest})
  })
})
