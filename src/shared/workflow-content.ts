import { renumberWorkflow } from './numbering.ts'
import type { Workflow } from './types.ts'

/** View navigation is persisted, but does not change the definition under review. */
export function workflowDefinitionContent(flow:Workflow):string {
  const {revision:_,createdAt:__,updatedAt:___,editor,...definition}=renumberWorkflow(flow)
  const editorContent=Object.fromEntries(Object.entries(editor??{}).filter(([key,value])=>key!=='viewport'&&key!=='scopePath'&&value!==undefined&&!(key==='annotations'&&Array.isArray(value)&&!value.length)))
  const content={...definition,...(Object.keys(editorContent).length?{editor:editorContent}:{})}
  return JSON.stringify(content,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value)
}
