import { z } from 'zod'
import type { NodeGraph, Workflow } from './types.ts'
import { allNodes, parseWorkflow } from './workflow-validation.ts'

const identifier=z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const selectionSchema=z.object({
  nodeIds:z.array(identifier).min(1,'请先选择节点').max(500).refine(ids=>new Set(ids).size===ids.length,'选区不能包含重复节点'),
  scopePath:z.array(identifier).max(5),
  expectedRevision:z.number().int().nonnegative(),
}).strict()
export type WorkflowTemplateSelection=z.infer<typeof selectionSchema>
export function parseWorkflowTemplateSelection(value:unknown):WorkflowTemplateSelection{return selectionSchema.parse(value)}

/** Promote only one verified canvas selection, retaining complete selected container bodies. */
export function selectWorkflowTemplateNodes(source:Workflow,value:unknown):Workflow {
  const selection=parseWorkflowTemplateSelection(value),flow=parseWorkflow(source)
  if(flow.revision!==selection.expectedRevision)throw new Error('工作流已被修改，请刷新后重新选择节点创建模板')
  let graph:NodeGraph=flow
  for(const id of selection.scopePath){const container=graph.nodes.find(node=>node.id===id);if(!container?.config.body)throw new Error('选区所属画布不存在，请重新选择节点');graph=container.config.body}
  const selected=new Set(selection.nodeIds)
  if(selection.nodeIds.some(id=>!graph.nodes.some(node=>node.id===id)))throw new Error('选区包含不存在或不属于当前画布的节点，请重新选择')
  const nodes=graph.nodes.filter(node=>selected.has(node.id)),edges=graph.edges.filter(edge=>selected.has(edge.source)&&selected.has(edge.target))
  const keptIds=new Set(allNodes({nodes,edges}).map(node=>node.id)),agentIds=new Set(allNodes({nodes,edges}).map(node=>node.config.subagentId).filter(Boolean))
  const fragment:Workflow={...flow,nodes,edges,notes:selection.scopePath.length?[]:flow.notes.filter(note=>!!note.anchorNodeId&&selected.has(note.anchorNodeId)),subAgents:flow.subAgents?.filter(agent=>agentIds.has(agent.id))}
  delete fragment.editor
  const annotations=(flow.editor?.annotations??[]).flatMap(annotation=>{
    const nodeIds=annotation.nodeIds.filter(id=>keptIds.has(id)),path=annotation.position?.scopePath
    const inside=!!path&&selection.scopePath.every((id,index)=>path[index]===id)&&path.length>=selection.scopePath.length
    const relativePath=inside?path!.slice(selection.scopePath.length):undefined
    let target:NodeGraph|undefined={nodes,edges}
    for(const id of relativePath??[]){target=target?.nodes.find(node=>node.id===id)?.config.body;if(!target)break}
    const position=annotation.position&&relativePath&&target?{...annotation.position,scopePath:relativePath}:undefined
    if(!nodeIds.length&&!(position&&relativePath!.length))return []
    return [{id:annotation.id,number:annotation.number,text:annotation.text,nodeIds,...(position?{position}:{})}]
  })
  if(annotations.length)fragment.editor={annotations}
  return fragment
}
