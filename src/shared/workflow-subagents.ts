import { newId, type RolePreset, type Workflow, type WorkflowNode, type WorkflowSubagent } from './types.ts'
import { rolePresetAvailable } from './role-presets.ts'

const nodesOf=(flow:Pick<Workflow,'nodes'>):WorkflowNode[]=>flow.nodes.flatMap(node=>[node,...(node.config.body?nodesOf(node.config.body):[])])
export const subagentForNode=(flow:Workflow,node:WorkflowNode)=>node.kind==='agent'?(flow.subAgents??[]).find(agent=>agent.id===node.config.subagentId):undefined
export const subagentInSession=(agent:WorkflowSubagent,sessionId?:string)=>!agent.sessionId||agent.sessionId===sessionId
export function createWorkflowSubagent(flow:Workflow,name:string,sessionId?:string,preset?:RolePreset):WorkflowSubagent {
  if(preset&&!rolePresetAvailable(preset,flow.id))throw new Error('智能体预设不属于当前工作流')
  const trimmed=name.trim()
  if(!trimmed||trimmed.length>100)throw new Error('子 Agent 名称须为 1 至 100 个字符')
  if((flow.subAgents??[]).some(agent=>agent.name===trimmed))throw new Error('此工作流已有同名子 Agent，请从列表选择或使用新名称')
  const number=Math.max(0,...(flow.subAgents??[]).map(agent=>Number(agent.number.slice(6))||0))+1
  return {id:newId(),number:`agent-${number}`,name:trimmed,prompt:preset?.prompt??'',...(sessionId?{sessionId}:{}),...(preset?{rolePresetId:preset.id,rolePresetRevision:preset.revision}:{})}
}
/** Mutates an editable graph atomically so all nodes sharing an identity see its saved role. */
export function bindNodeSubagent(flow:Workflow,nodeId:string,definition:WorkflowSubagent,sessionId?:string):void {
  if(!subagentInSession(definition,sessionId))throw new Error('子 Agent 属于其他主对话，请为当前对话创建新身份')
  const node=nodesOf(flow).find(candidate=>candidate.id===nodeId)
  if(node?.kind!=='agent')throw new Error('请选择 Agent 节点')
  const next={...definition,...(sessionId?{sessionId}:{})},index=(flow.subAgents??[]).findIndex(agent=>agent.id===definition.id)
  if(index<0)(flow.subAgents??=[]).push(next);else flow.subAgents![index]=next
  node.config.subagentId=definition.id
}
/** Freeze on a detached run graph. Never rebind a definition from another conversation. */
export function bindWorkflowSubagentsForRun(flow:Workflow,sessionId?:string):void {
  for(const node of nodesOf(flow))if(node.kind==='agent'&&node.config.subagentId){
    const definition=subagentForNode(flow,node)
    if(!definition)throw new Error(`节点 ${node.number} 的子 Agent 定义缺失`)
    if(!subagentInSession(definition,sessionId))throw new Error(`子 Agent「${definition.name}」属于其他主对话，请在当前对话重新选择或创建`)
    if(sessionId)definition.sessionId=sessionId
  }
}
export function workflowSubagentScopeIssues(flow:Workflow,sessionId?:string):{nodeId:string;message:string}[] {
  return nodesOf(flow).flatMap(node=>{
    const definition=subagentForNode(flow,node)
    return definition&&!subagentInSession(definition,sessionId)?[{nodeId:node.id,message:`子 Agent「${definition.name}」属于其他主对话，请为当前对话创建新身份`}]:[]
  })
}
