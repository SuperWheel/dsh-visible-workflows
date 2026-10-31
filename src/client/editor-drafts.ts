import type { JsonValue, WorkflowDraft } from '../shared/types.ts'
import type { EditorState } from './store.ts'
import type { EnvironmentDraft } from './workflow-variables.ts'

export type EditorDraftFields=Pick<EditorState,'annotationDraft'|'generateDraft'|'generateTargetId'|'generateRequestId'|'environmentDraft'>
const draftKeys=['annotationDraft','generateDraft','generateTargetId','generateRequestId','environmentDraft'] as const
export function editorDraftKey(state:Pick<EditorState,'workflow'|'sessionId'>):string|undefined {
  return state.workflow?JSON.stringify([state.workflow.workspaceId,state.workflow.id,state.sessionId??'']):undefined
}
export function hasEditorDraftPatch(patch:Partial<EditorState>):boolean { return draftKeys.some(key=>Object.prototype.hasOwnProperty.call(patch,key)) }
export function serializeEditorDraft(state:EditorState,id:string,revision=0):WorkflowDraft|undefined {
  const flow=state.workflow;if(!flow)return
  const fields:EditorDraftFields={annotationDraft:state.annotationDraft,generateDraft:state.generateDraft,generateTargetId:state.generateTargetId,generateRequestId:state.generateRequestId,environmentDraft:state.environmentDraft}
  const payload=JSON.parse(JSON.stringify(fields)) as Record<string,JsonValue>
  if(fields.environmentDraft?.type==='secret'){const variable=payload.environmentDraft as Record<string,JsonValue>;delete variable.value;variable.configured=false}
  return {id,workflowId:flow.id,workspaceId:flow.workspaceId,sessionId:state.sessionId,kind:'editor',payload,revision,updatedAt:new Date().toISOString()}
}
export function restoreEditorDraft(value:WorkflowDraft):EditorDraftFields {
  const payload=value.payload;if(!payload||Array.isArray(payload)||typeof payload!=='object')return {}
  const fields:EditorDraftFields={}
  if(typeof payload.generateDraft==='string')fields.generateDraft=payload.generateDraft
  if(typeof payload.generateTargetId==='string')fields.generateTargetId=payload.generateTargetId
  if(typeof payload.generateRequestId==='string')fields.generateRequestId=payload.generateRequestId
  const environment=payload.environmentDraft as unknown as EnvironmentDraft|undefined
  if(environment&&typeof environment.id==='string'&&typeof environment.name==='string'&&['string','number','secret'].includes(environment.type))fields.environmentDraft={id:environment.id,name:environment.name,type:environment.type,description:typeof environment.description==='string'?environment.description:'',required:environment.required===true,configured:environment.type!=='secret'&&environment.configured===true,value:environment.type==='secret'?'':typeof environment.value==='string'?environment.value:''}
  const annotation=payload.annotationDraft as unknown as EditorState['annotationDraft']
  if(annotation&&typeof annotation.text==='string'&&Array.isArray(annotation.nodeIds)&&annotation.nodeIds.every(id=>typeof id==='string'))fields.annotationDraft={...annotation,nodeIds:[...annotation.nodeIds]}
  return fields
}
