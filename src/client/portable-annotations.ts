import type { Workflow, WorkflowEditorState } from '../shared/types.ts'
import { allNodes } from '../shared/workflow-validation.ts'
import { legacyAnnotationPosition } from './annotation-fallback.ts'

type Annotation=NonNullable<WorkflowEditorState['annotations']>[number]
/** Imported annotations remain canvas data until a human explicitly stages one in chat. */
export function canvasAnnotations(flow:Workflow,sessionNotes:readonly Annotation[]):Annotation[]{
  const portable=flow.editor?.annotations??[],seen=new Set(portable.map(item=>item.id))
  return [...portable,...sessionNotes.filter(note=>!seen.has(note.id))].map((note,index)=>({...note,number:index+1,position:note.position??legacyAnnotationPosition(flow,note.nodeIds)}))
}
export function withoutPortableAnnotation(flow:Workflow,id:string):Workflow {
  return {...flow,editor:{...flow.editor,annotations:flow.editor?.annotations?.filter(note=>note.id!==id)??[]}}
}
export function copiedEditor(source:Workflow,target:Workflow):WorkflowEditorState|undefined {
  if(!source.editor)return undefined
  const targets=allNodes(target),ids=new Map(allNodes(source).map((node,index)=>[node.id,targets[index]!.id])),map=(values:string[])=>values.map(id=>ids.get(id)??id)
  return {...structuredClone(source.editor),scopePath:source.editor.scopePath&&map(source.editor.scopePath),annotations:source.editor.annotations?.map(note=>({...note,id:crypto.randomUUID(),nodeIds:map(note.nodeIds),position:note.position&&{...note.position,scopePath:map(note.position.scopePath)}}))}
}
/** Node deletion keeps imported text; references to removed nodes and containers are detached. */
export function reconcileEditorReferences(flow:Workflow):Workflow{
  if(!flow.editor)return flow
  const ids=new Set(allNodes(flow).map(node=>node.id))
  const scope=(path:readonly string[])=>{let graph=flow as Pick<Workflow,'nodes'|'edges'>;const result:string[]=[];for(const id of path){const node=graph.nodes.find(n=>n.id===id);if(!node?.config.body)break;result.push(id);graph=node.config.body}return result}
  return {...flow,editor:{...flow.editor,scopePath:scope(flow.editor.scopePath??[]),annotations:flow.editor.annotations?.map(note=>({...note,nodeIds:note.nodeIds.filter(id=>ids.has(id)),...(note.position?{position:{...note.position,scopePath:scope(note.position.scopePath)}}:{})}))}}
}
