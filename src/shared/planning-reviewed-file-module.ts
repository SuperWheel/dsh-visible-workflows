import { z } from 'zod'
import { reviewedFileWriteParametersSchema } from './planning-business-module-contract.ts'
import { reviewedFileWriteGraph } from './planning-review-recipe.ts'
import { rewritePlanningConfig } from './planning-edits.ts'
import { CompilerError, jsonDigest } from './planning-repair.ts'
import { allNodes, parseWorkflow } from './workflow-validation.ts'
import type { NodeConfig, NodeGraph, Workflow, WorkflowNode } from './types.ts'

type Parameters=z.infer<typeof reviewedFileWriteParametersSchema>
export function reviewedFileStoredParameters(graph:Workflow,roles:Workflow=graph,nodeIds?:string[]):Parameters {
  const nodes=new Map(allNodes(graph).map(node=>[node.id,node]))
  const byRole=new Map(allNodes(roles).filter(node=>!nodeIds||nodeIds.includes(node.id)).map(node=>[node.title,nodes.get(node.id)]))
  return reviewedFileWriteParametersSchema.parse({
    target:byRole.get('targetProbe')?.config.inputs?.pattern,
    producer:{text:byRole.get('produce')?.config.text},maxIterations:byRole.get('reviewLoop')?.config.maxIterations,
  })
}
export const reviewedFileGraph=(parameters:Parameters)=>reviewedFileWriteGraph({
  target:parameters.target,maxIterations:parameters.maxIterations,
  producer:{kind:'template',config:{text:parameters.producer.text}},
})
// Digest the actual recipe, not a second handwritten implementation. Any
// recipe/parameter contract change must deliberately version this module.
export const reviewedFileImplementationDigest=jsonDigest({
  graph:reviewedFileGraph({target:'review-target.txt',producer:{text:'正文 {{reviewBase}} {{reviewNote}}'},maxIterations:3}),
  parameters:z.toJSONSchema(reviewedFileWriteParametersSchema,{io:'input'}),
  runtimeContract:'reviewed-file-write-v1',
})
if(reviewedFileImplementationDigest!=='e44821bd615c8343e0729cbde3540d63be5eef7ebf9d29123a2cd0b1fc747751')
  throw new CompilerError('MODULE_CONTRACT_DRIFT','审核写入模块固定配方或参数合同已变化；需新版本及独立验证 '+reviewedFileImplementationDigest,undefined,true)

/** Runtime recipe -> canonical CREATE declarations. Ordinary edges become
 * chains; only branch exits become links. No planner copies a runtime body. */
export function reviewedFileAuthoring(parameters:Parameters){
  const nodesByKey:Record<string,{kind:WorkflowNode['kind'];title:string;config:NodeConfig}>={}
  const chainsByKey:Record<string,{container?:string;nodes:string[]}>={}
  const linksByKey:Record<string,{source:string;target:string;port:string}>={}
  const visit=(graph:NodeGraph,container?:string)=>{
    for(const node of graph.nodes){
      const {body,...config}=structuredClone(node.config)
      nodesByKey[node.id]={kind:node.kind,title:node.title,config}
      if(container)chainsByKey['member'+node.id]={container,nodes:[node.id]}
      if(body)visit(body,node.id)
    }
    graph.edges.forEach((edge,index)=>{
      const key=(container??'root')+'Edge'+index
      if(edge.port)linksByKey[key]={source:edge.source,target:edge.target,port:edge.port}
      else chainsByKey[key]={...(container?{container}:{}),nodes:[edge.source,edge.target]}
    })
  }
  visit(reviewedFileGraph(parameters))
  return {nodesByKey,chainsByKey,linksByKey,coverageKeys:Object.keys(nodesByKey)}
}

/** Reconstruct only from a trusted published candidate. Its fixed titles
 * identify recipe roles; parameter updates retain IDs, titles and layout. */
export function reviewedFileParameterChanges(parameters:Parameters,source:Workflow,nodeIds:string[],parametersDigest:string){
  const original=allNodes(source).filter(node=>nodeIds.includes(node.id)),byRole=new Map(original.map(node=>[node.title,node]))
  const old=reviewedFileStoredParameters(source,source,nodeIds)
  if(jsonDigest(old)!==parametersDigest||new Set(nodeIds).size!==original.length||original.some(node=>!nodeIds.includes(node.id)))
    throw new CompilerError('MODULE_INSTANCE_CONFLICT','审核写入模块来源映射或参数摘要无效')
  const mapGraph=(graph:NodeGraph):NodeGraph=>({
    nodes:graph.nodes.map(node=>{
      const saved=byRole.get(node.id)
      if(!saved||saved.kind!==node.kind)throw new CompilerError('MODULE_INSTANCE_CONFLICT','审核写入模块固定节点不匹配')
      const {body,...config}=node.config
      const mapped=rewritePlanningConfig(config,{nodes:new Map([...byRole].map(([key,value])=>[key,value.id])),agents:new Map(),environment:new Map()},false,node.kind) as NodeConfig
      return {...saved,config:{...mapped,...(body?{body:mapGraph(body)}:{})}}
    }),
    edges:graph.edges.map(edge=>({...edge,source:byRole.get(edge.source)!.id,target:byRole.get(edge.target)!.id})),
  })
  const expected=parseWorkflow({...source,...mapGraph(reviewedFileGraph(old))})
  const definitions=(graph:NodeGraph):unknown=>({
    nodes:graph.nodes.map(node=>({id:node.id,kind:node.kind,config:{...node.config,body:node.config.body?definitions(node.config.body):undefined}})).sort((a,b)=>a.id.localeCompare(b.id)),
    edges:graph.edges.map(({source,target,port})=>({source,target,port})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
  })
  const moduleGraph={nodes:source.nodes.filter(node=>nodeIds.includes(node.id)),edges:source.edges.filter(edge=>nodeIds.includes(edge.source)||nodeIds.includes(edge.target))}
  if(jsonDigest(definitions(expected))!==jsonDigest(definitions(moduleGraph)))throw new CompilerError('MODULE_INSTANCE_CONFLICT','审核写入模块固定实现或连接已改变')
  const next=parseWorkflow({...source,...mapGraph(reviewedFileGraph(parameters))})
  const before=new Map(allNodes(expected).map(node=>[node.id,node]))
  return allNodes(next).flatMap(node=>Object.entries(node.config).filter(([field,value])=>field!=='body'&&jsonDigest(value)!==jsonDigest(before.get(node.id)!.config[field as keyof NodeConfig])).map(([field,value])=>({op:'set-config' as const,nodeId:node.id,field,value})))
}
