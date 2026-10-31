import type { RolePreset, Workflow } from './types.ts'
import { allNodes } from './workflow-validation.ts'

/** Missing scope is the existing global library format. */
export const rolePresetAvailable=(preset:RolePreset,workflowId?:string):boolean=>preset.scope!=='workflow'||!!workflowId&&preset.workflowId===workflowId
export const rolePresetsForWorkflow=(presets:readonly RolePreset[],workflowId?:string):RolePreset[]=>presets.filter(preset=>rolePresetAvailable(preset,workflowId))
/** An absent role remains an editable pending reference; a known foreign role cannot be consumed. */
export function assertRolePresetScope(flow:Workflow,presets:readonly RolePreset[]):void {
  for(const node of allNodes(flow))if(node.config.rolePresetId){const preset=presets.find(preset=>preset.id===node.config.rolePresetId);if(preset&&!rolePresetAvailable(preset,flow.id))throw new Error(`节点 ${node.number} 的智能体预设属于其他工作流，请重新选择`)}
}
