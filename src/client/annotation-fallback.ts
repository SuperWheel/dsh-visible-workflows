import type { NodeGraph } from '../shared/types.ts'
import type { AnnotationPosition } from './annotation-position.ts'
import { nodeSize } from './nodes.ts'

/** Resolve one display-only point for an older annotation, in reference order
 * across the entire workflow. The local canvas must not choose a new point. */
export function legacyAnnotationPosition(workflow:NodeGraph,nodeIds:readonly string[]):AnnotationPosition|undefined {
  const wanted=new Set(nodeIds),positions=new Map<string,AnnotationPosition>()
  const visit=(graph:NodeGraph,scopePath:string[])=>{
    for(const node of graph.nodes){
      if(wanted.has(node.id))positions.set(node.id,{x:node.x+nodeSize(node).width,y:node.y,scopePath:[...scopePath]})
      if(node.config.body)visit(node.config.body,[...scopePath,node.id])
    }
  }
  visit(workflow,[])
  for(const id of nodeIds){const position=positions.get(id);if(position)return position}
  return undefined
}
