import type { Workflow } from './types.ts'

export const workflowScope=(flow:Pick<Workflow,'scope'>):'workspace'|'global'=>flow.scope??'workspace'
/** Visibility does not authorize another project's files, credentials or tools. */
export function workflowVisibleInWorkspace(flow:Pick<Workflow,'scope'|'workspaceId'|'archived'>,workspaceId:string):boolean {
  return !!workspaceId&&!flow.archived&&(flow.workspaceId===workspaceId||workflowScope(flow)==='global')
}
