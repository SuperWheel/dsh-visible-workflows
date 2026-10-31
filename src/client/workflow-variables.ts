import type { EnvironmentVariable, Workflow, WorkflowRun } from '../shared/types.ts'
import { SYSTEM_VARIABLES } from '../shared/workflow-variables.ts'
import { allNodes } from './nodes.ts'
import type { VariableMetadata } from './variable-metadata.ts'

export interface EnvironmentDraft { id:string; name:string; type:EnvironmentVariable['type']; value:string; description:string; required:boolean; configured:boolean }
export function environmentDraft(variable:EnvironmentVariable):EnvironmentDraft {
  return {id:variable.id,name:variable.name,type:variable.type,value:variable.type==='secret'?'':String(variable.value??''),description:variable.description??'',required:variable.required??false,configured:variable.type!=='secret'&&variable.value!==undefined}
}
/** Secret has no value control and is never copied into an editable/persistent value. */
export function environmentFromDraft(draft:EnvironmentDraft, variables:EnvironmentVariable[]):EnvironmentVariable {
  const name=draft.name.trim()
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))throw new Error('名称须以字母或下划线开头，仅包含字母、数字和下划线。')
  if(variables.some(variable=>variable.id!==draft.id&&variable.name===name))throw new Error('已有同名环境变量，请使用其他名称。')
  const base={id:draft.id,name,description:draft.description.trim(),required:draft.required,revision:(variables.find(variable=>variable.id===draft.id)?.revision??0)+1}
  if(draft.type==='secret')return {...base,type:'secret'}
  if(!draft.configured)return {...base,type:draft.type}
  if(draft.type==='number'){
    if(!draft.value.trim()||!Number.isFinite(Number(draft.value)))throw new Error('请输入有限数值，不能使用空值、NaN 或 Infinity。')
    return {...base,type:'number',value:Number(draft.value)}
  }
  return {...base,type:'string',value:draft.value}
}
export function environmentReferences(workflow:Workflow,id:string) {
  const contains=(value:unknown):boolean=>typeof value==='string'?new RegExp(`\\{\\{\\s*env\\.${id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s*\\}\\}`).test(value)||value===`env.${id}`:Array.isArray(value)?value.some(contains):!!value&&typeof value==='object'?Object.values(value).some(contains):false
  return allNodes(workflow).filter(node=>{const {body,...config}=node.config;return config.credentialOperation?.secretVariableId===id||contains(config)})
}
export function environmentMetadata(variables:EnvironmentVariable[]):VariableMetadata[] {
  return variables.filter(variable=>variable.type!=='secret').map(variable=>({name:`env.${variable.name}`,reference:`{{env.${variable.id}}}`,type:variable.type,description:variable.description||'当前工作流的普通配置；可被 Agent 读取'}))
}
export function systemMetadata():VariableMetadata[] {
  return SYSTEM_VARIABLES.filter(variable=>variable.supported).map(variable=>({name:`sys.${variable.name}`,reference:`{{sys.${variable.name}}}`,type:`${variable.type}${variable.nullable?' | null':''}`,description:variable.description}))
}
export function systemVariableValue(name:string, workflow:Workflow, run?:WorkflowRun, sessionId?:string):string {
  if(run?.systemVariables&&Object.prototype.hasOwnProperty.call(run.systemVariables,name)){
    const value=run.systemVariables[name]
    return value===null?'空（独立运行）':String(value)
  }
  if(name==='workflow_id')return run?.workflowId??workflow.id
  if(name==='workspace_id')return run?.workspaceId??workflow.workspaceId
  if(name==='session_id')return run?'此历史运行未记录':sessionId??'空（独立运行）'
  return run?'此历史运行未记录':'运行时生成'
}
