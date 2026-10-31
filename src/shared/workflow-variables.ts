import type { EnvironmentVariable, Workflow, WorkflowSystemVariables, ValidationIssue } from './types.ts'

export interface SystemVariableDefinition { name: string; type: 'string' | 'number'; nullable: boolean; supported: boolean; label: string; description: string }
export const SYSTEM_VARIABLES: readonly SystemVariableDefinition[] = [
  { name:'workflow_id', type:'string', nullable:false, supported:true, label:'工作流 ID', description:'当前工作流的稳定身份' },
  { name:'workflow_run_id', type:'string', nullable:false, supported:true, label:'运行 ID', description:'运行启动时生成；暂停继续保持不变' },
  { name:'workspace_id', type:'string', nullable:false, supported:true, label:'工作区 ID', description:'当前可信执行工作区' },
  { name:'session_id', type:'string', nullable:true, supported:true, label:'会话 ID', description:'发起运行的宿主会话；独立运行时为空' },
  { name:'timestamp', type:'number', nullable:false, supported:true, label:'开始时间', description:'运行开始时的 Unix 秒数（UTC）' },
  { name:'user_id', type:'string', nullable:true, supported:false, label:'用户 ID', description:'当前宿主尚未提供可信映射，暂不可引用' },
  { name:'app_id', type:'string', nullable:true, supported:false, label:'应用 ID', description:'当前宿主没有对应应用实体，暂不可引用' },
]
export const SECRET_UNAVAILABLE_REASON = 'Secret 由系统凭据库管理；当前存储或受控消费尚未就绪，不能将原值加入普通变量'
export function environmentVariableStatus(variable: EnvironmentVariable): 'configured' | 'missing' | 'unavailable' {
  return variable.type === 'secret' ? 'unavailable' : variable.value === undefined ? 'missing' : 'configured'
}
export function environmentVariableIssues(flow: Pick<Workflow,'environmentVariables'>, executable = false, deferSecretCheck = false): ValidationIssue[] {
  const issues:ValidationIssue[] = [], ids = new Set<string>(), names = new Set<string>()
  for (const variable of flow.environmentVariables ?? []) {
    if(ids.has(variable.id)) issues.push({message:`环境变量身份重复：${variable.id}`})
    if(names.has(variable.name)) issues.push({message:`环境变量名称重复：${variable.name}`})
    ids.add(variable.id); names.add(variable.name)
    if(executable && variable.required && !(deferSecretCheck&&variable.type==='secret') && environmentVariableStatus(variable) !== 'configured') issues.push({message:variable.type === 'secret' ? `${variable.name}：${SECRET_UNAVAILABLE_REASON}` : `必需环境变量 ${variable.name} 尚未配置`})
  }
  return issues
}
/** Take once at start. Never contains Secret data or references exchangeable for it. */
export function environmentSnapshot(flow: Pick<Workflow,'environmentVariables'>, deferSecretCheck = false): Record<string,string|number> {
  const issues=environmentVariableIssues(flow,true,deferSecretCheck)
  if(issues.length) throw new Error(issues.map(issue=>issue.message).join('\n'))
  return Object.fromEntries((flow.environmentVariables??[]).flatMap(variable=>variable.type!=='secret'&&variable.value!==undefined?[[variable.id,variable.value]]:[]))
}
export function createSystemVariables(context:{workflowId:string;runId:string;workspaceId:string;startedAt:string;sessionId?:string|null}): WorkflowSystemVariables {
  const timestamp=Date.parse(context.startedAt)/1000
  if(!context.workflowId||!context.runId||!context.workspaceId||!Number.isFinite(timestamp)) throw new Error('系统变量缺少可信运行上下文')
  return {workflow_id:context.workflowId,workflow_run_id:context.runId,workspace_id:context.workspaceId,session_id:context.sessionId??null,timestamp:Math.floor(timestamp)}
}
export function assertNoSystemOverrides(inputs:Record<string,unknown>):void {
  if(Object.keys(inputs).some(name=>/^(?:sys|env)(?:\.|$)/.test(name))) throw new Error('输入不得覆盖环境变量或系统变量命名空间')
}
