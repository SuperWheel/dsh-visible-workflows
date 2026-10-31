import type { NodeGraph, WorkflowThumbnail } from './types.ts'

/** Geometry only: previews never expose node configuration, prompts or variable values. */
export function createWorkflowThumbnail(graph:NodeGraph):WorkflowThumbnail {
  return {nodes:graph.nodes.map(({id,kind,x,y})=>({id,kind,x,y})),edges:graph.edges.map(({source,target})=>({source,target}))}
}
