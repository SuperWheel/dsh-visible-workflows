import { describe,it,expect } from 'vitest'
import { businessModuleCatalog,businessModuleRequestSchema,compileBusinessModule,expandBusinessModule,updateBusinessModule } from '../src/shared/planning-business-modules.ts'
import { reviewedFileWriteGraph } from '../src/shared/planning-review-recipe.ts'
import { planningCandidateIssues } from '../src/shared/planning-projection.ts'
import { planningReviewIssues } from '../src/shared/planning-review.ts'
import { planningToolPreconditionIssues } from '../src/shared/planning-tool-preconditions.ts'
import { allNodes,parseWorkflow } from '../src/shared/workflow-validation.ts'
import { rewritePlanningConfig } from '../src/shared/planning-edits.ts'
import type { NodeGraph,WorkflowNode } from '../src/shared/types.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'
import { tools } from './fixtures/t18-tools.ts'
import { arrangeNodes } from '../src/shared/canvas-layout.ts'

const request=()=>({moduleId:'reviewed-file-write' as const,version:'1.0.0' as const,instanceKey:'review',parameters:{target:'reports/结果.txt',producer:{text:'正文 {{reviewBase}}\n修改意见：{{reviewNote}}'},maxIterations:3}})
const context=()=>({...templateContext(),tools:tools()})
// Normalize by recipe roles and accepted runtime defaults, not allocated IDs,
// node order, edge order or canvas layout. Reference translation is semantic.
function canonical(graph:NodeGraph){
  const nodes=new Map(allNodes(graph).map(node=>[node.id,node.title]))
  const visit=(g:NodeGraph):unknown=>({
    nodes:g.nodes.map(node=>{
      const {body,...config}=node.config
      return {role:node.title,kind:node.kind,config:rewritePlanningConfig(config,{nodes,agents:new Map(),environment:new Map()},false,node.kind),...(body?{body:visit(body)}:{})}
    }).sort((a,b)=>a.role.localeCompare(b.role)),
    edges:g.edges.map(({source,target,port})=>({source:nodes.get(source),target:nodes.get(target),port})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
  })
  return visit(graph)
}
describe('T22 reviewed-file-write module',()=>{
  it('discovers both versioned modules and defaults to three review rounds',()=>{
    expect(businessModuleCatalog().map(item=>item.id)).toEqual(['structured-result-table','reviewed-file-write'])
    const input=request(),{maxIterations,...parameters}=input.parameters
    expect(businessModuleRequestSchema.parse({...input,parameters}).parameters).toMatchObject({maxIterations:3})
    expect(businessModuleCatalog()[1]!.applicability).toContain('真人')
  })
  it.each(['','/absolute.txt','../escape.txt','a/../b','a//b','./a','a\\b','a\0b','C:a','.dsh-drafts/x','{{input.path}}','foo/{{input.name}}','a*','a?','a[0]','a!','a(b)'])('rejects nonliteral or unsafe target %j exactly as the recipe',target=>{
    const input=request();input.parameters.target=target
    expect(businessModuleRequestSchema.safeParse(input).success).toBe(false)
    expect(()=>reviewedFileWriteGraph({target,producer:{kind:'template',config:{text:''}}})).toThrow()
  })
  it.each([0,101,-1,1.5,'3',null])('rejects invalid maxIterations %j',maxIterations=>{
    expect(businessModuleRequestSchema.safeParse({...request(),parameters:{...request().parameters,maxIterations}}).success).toBe(false)
  })
  it('accepts limits and template references while rejecting literal injection, arbitrary producer and tool overrides',()=>{
    for(const maxIterations of [1,100])expect(businessModuleRequestSchema.safeParse({...request(),parameters:{...request().parameters,maxIterations}}).success).toBe(true)
    expect(businessModuleRequestSchema.safeParse(request()).success).toBe(true)
    for(const extra of [{writeToolId:'native:bash'},{readToolId:'{{input.tool}}'},{producer:{kind:'code',text:'unsafe'}}])
      expect(businessModuleRequestSchema.safeParse({...request(),parameters:{...request().parameters,...extra}}).success).toBe(false)
    expect(businessModuleRequestSchema.safeParse({...request(),instanceKey:'{{input.key}}'}).success).toBe(false)
  })
  it('uses canonical CREATE declarations and expands identically to the recipe through all current checks',()=>{
    const c=context(),input=request(),expanded=expandBusinessModule(input),compiled=compileBusinessModule(input,c),flow=compiled.candidate!
    for(const node of Object.values(expanded.nodesByKey)){expect(node).not.toHaveProperty('scope');expect(node.config).not.toHaveProperty('body')}
    expect(Object.values(expanded.chainsByKey).some(chain=>'container' in chain&&chain.container==='reviewLoop')).toBe(true)
    const recipe=reviewedFileWriteGraph({target:input.parameters.target,maxIterations:input.parameters.maxIterations,producer:{kind:'template',config:{text:input.parameters.producer.text}}})
    const laidOut=(graph:NodeGraph):void=>{expect(graph.nodes).toEqual(arrangeNodes(graph));for(const node of graph.nodes)if(node.config.body)laidOut(node.config.body)}
    laidOut(flow)
    expect(allNodes(recipe).every(node=>node.x===0&&node.y===0)).toBe(true)
    expect(compiled.provenance.implementationDigest).toBe('e44821bd615c8343e0729cbde3540d63be5eef7ebf9d29123a2cd0b1fc747751')
    expect(canonical(flow)).toEqual(canonical(parseWorkflow({...c.workflow,...recipe})))
    expect(compiled.issues).toEqual([])
    expect(planningCandidateIssues(flow,c)).toEqual([])
    expect(planningReviewIssues(flow,c)).toEqual([])
    expect(planningToolPreconditionIssues(flow,c)).toEqual([])
    expect(compiled.provenance.nodeIds).toHaveLength(22)
    expect(new Set(compiled.provenance.nodeIds)).toEqual(new Set(allNodes(flow).map(node=>node.id)))
    const other=context();other.nodeIds=other.nodeIds.map(id=>'other-'+id);other.workflow.nodes[0]!.id='other-start';other.workflow.edges[0]!.source='other-start'
    expect(compileBusinessModule(input,other).provenance.nodeIds.every(id=>!compiled.provenance.nodeIds.includes(id))).toBe(true)
  })
  it.each(['target','producer','maxIterations'] as const)('updates only the controlled %s difference, keeping IDs, layout, code, edges and implementation digest',parameter=>{
    const c=context(),input=request(),first=compileBusinessModule(input,c),source=first.candidate!,revision={...c,operation:'revise' as const,workflow:{...structuredClone(source),revision:1}}
    if(parameter==='target')input.parameters.target='reports/new.txt'
    if(parameter==='producer')input.parameters.producer.text='修订 {{reviewBase}}\n{{reviewNote}}'
    if(parameter==='maxIterations')input.parameters.maxIterations=5
    const updated=updateBusinessModule(input,revision,source,first.provenance)
    expect(updated.issues).toEqual([]);expect(updated.provenance.implementationDigest).toBe(first.provenance.implementationDigest)
    expect(updated.provenance.parametersDigest).not.toBe(first.provenance.parametersDigest)
    expect(updated.provenance.nodeIds).toEqual(first.provenance.nodeIds)
    const expected=compileBusinessModule(input,c).candidate!
    expect(canonical(updated.candidate!)).toEqual(canonical(expected))
    const changes=allNodes(updated.candidate!).flatMap((node,index)=>{
      const before=allNodes(source)[index]!,{body,...config}=node.config,{body:oldBody,...old}=before.config
      expect({...node,config:{}}).toEqual({...before,config:{}})
      return Object.keys(config).filter(key=>JSON.stringify(config[key as keyof typeof config])!==JSON.stringify(old[key as keyof typeof old])).map(field=>`${node.title}.${field}`)
    })
    expect(changes.sort()).toEqual((parameter==='producer'?['produce.text']:parameter==='maxIterations'?['reviewLoop.maxIterations']:['targetProbe.inputs','targetExists.inputs','targetBefore.inputs','draftProbe.inputs','draftExists.inputs','draftPrior.inputs','draftWrite.inputs','reviewGate.prompt','commit.inputs']).sort())
    const edgeSets=(graph:NodeGraph):unknown=>({edges:graph.edges,bodies:graph.nodes.flatMap(node=>node.config.body?[edgeSets(node.config.body)]:[])})
    expect(edgeSets(updated.candidate!)).toEqual(edgeSets(source))
  })
  it('preserves idempotency and refuses changed implementations, parameters, nested connections, provenance and fixed nodes',()=>{
    const c=context(),input=request(),first=compileBusinessModule(input,c),source=first.candidate!,revision={...c,operation:'revise' as const,workflow:structuredClone(source)}
    expect(canonical(updateBusinessModule(input,revision,source,first.provenance).candidate!)).toEqual(canonical(source))
    const changed=(edit:(nodes:WorkflowNode[],flow:typeof source)=>void)=>{const v=structuredClone(revision);edit(allNodes(v.workflow),v.workflow);return v}
    for(const v of [changed(nodes=>{nodes.find(n=>n.title==='produce')!.config.text='manual'}),changed(nodes=>{nodes.find(n=>n.title==='targetExists')!.config.code+='\n// changed'}),changed((_nodes,flow)=>{flow.nodes.find(n=>n.kind==='loop')!.config.body!.edges[0]!.port='bad'})])
      expect(()=>updateBusinessModule(input,v,source,first.provenance)).toThrow('已改变')
    expect(()=>updateBusinessModule(input,revision,source,{...first.provenance,parametersDigest:'0'.repeat(64)})).toThrow('摘要')
    expect(()=>updateBusinessModule(input,revision,source,{...first.provenance,implementationDigest:'0'.repeat(64)})).toThrow('不匹配')
    input.parameters.producer.text='new'
    expect(()=>updateBusinessModule(input,changed(nodes=>{nodes.find(n=>n.title==='produce')!.fixed=true}),source,first.provenance)).toThrow('固定')
  })
})
