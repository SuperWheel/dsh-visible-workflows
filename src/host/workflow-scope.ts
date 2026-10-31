import type { Workflow } from '../shared/types.ts'
import { workflowScope, workflowVisibleInWorkspace } from '../shared/workflow-scope.ts'
import { stripLocalFileBindings } from '../shared/workflow-format.ts'

/** A shared definition executes in the caller's project. Never persist this
 * projection, or carry an owner's attachment or conversation authorization. */
export function workflowForExecution(value:Workflow,workspaceId:string):Workflow {
  if(!workflowVisibleInWorkspace(value,workspaceId))throw new Error('只能调用当前工作区或全局范围的工作流')
  const flow=structuredClone(value)
  if(flow.workspaceId!==workspaceId){
    flow.workspaceId=workspaceId
    stripLocalFileBindings(flow)
  }
  if(workflowScope(flow)==='global')for(const definition of flow.subAgents??[])delete definition.sessionId
  return flow
}
