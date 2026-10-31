import { subagentForNode, workflowSubagentScopeIssues } from '../shared/workflow-subagents.ts'
import { rolePresetAvailable } from '../shared/role-presets.ts'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Workflow, WorkflowModelDefaults, WorkflowNode } from '../shared/types.ts'
import type { WorkflowImportCatalog, WorkflowReadiness, WorkflowReadinessIssue } from '../shared/workflow-import.ts'
import { allNodes, graphIssues, parseWorkflow } from '../shared/workflow-validation.ts'
import { FILE_VERIFICATION_FIELDS, isFileReference } from '../shared/workflow-format.ts'
import { createReferenceScopePlan, referenceScopeIssues } from '../shared/reference-scope.ts'
import { isModelNode } from './model-defaults.ts'
import { verifyWorkflowFile } from './workflow-import.ts'
import { workflowVisibleInWorkspace } from '../shared/workflow-scope.ts'
import { workflowForExecution } from './workflow-scope.ts'
import { FILE_READ_CAPABILITY_UNAVAILABLE } from './file-evidence-error.ts'

export interface WorkflowReadinessContext {
  sessionId?:string
  catalog:WorkflowImportCatalog
  workspaceRoot:string
  modelDefaults?:WorkflowModelDefaults
  /** Host-attested evidence capability for this node, not a name/schema heuristic. */
  canVerifyFileReads?:(node:WorkflowNode)=>boolean
  /** Passive metadata only. Must never prompt for or return a credential. */
  secretStatus?:(flow:Workflow,variableId:string)=>Promise<'configured'|'missing'|'unavailable'|'authorization_required'>
  /** Historical runs validate their frozen dependencies/roles, not newer edits. */
  dependencySnapshots?:Record<string,Workflow>
  rolePrompts?:Record<string,string>
  dependencyRolePrompts?:Record<string,Record<string,string>>
}

/** Missing child declarations are reported by readiness, not thrown while
 * deciding whether a cold session's model selection needs to be inspected. */
export function needsReadinessModelDefaults(root:Workflow,workflows:readonly Workflow[],snapshots?:Record<string,Workflow>):boolean {
  const seen=new Set<string>(),available=new Map(workflows.filter(flow=>workflowVisibleInWorkspace(flow,root.workspaceId)).map(flow=>[flow.id,workflowForExecution(flow,root.workspaceId)]))
  const visit=(flow:Workflow):boolean=>{
    if(seen.has(flow.id))return false;seen.add(flow.id)
    for(const node of allNodes(flow)){
      if(isModelNode(node)&&(!node.config.model||node.config.effort===undefined))return true
      for(const id of [node.config.toolId,...(node.config.tools??[])])if(id?.startsWith('workflow:')){const child=snapshots?snapshots[id.slice(9)]:available.get(id.slice(9));if(child&&child.workspaceId===root.workspaceId&&visit(child))return true}
    }
    return false
  }
  return visit(root)
}

function referencesEnvironment(node:WorkflowNode,id:string):boolean {
  const config=node.config,escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
  const pattern=new RegExp(`(?:^|[^A-Za-z0-9_.-])env(?:\\.${escaped}(?![A-Za-z0-9_-])|\\[['"]${escaped}['"]\\])`)
  const strings=(value:unknown):string[]=>typeof value==='string'?[value]:Array.isArray(value)?value.flatMap(strings):value&&typeof value==='object'?Object.values(value).flatMap(strings):[]
  const fields=['inputs','text','prompt','query','url','bodyText','headers','source','logicGate','value','assignments','initialVariables'] as const
  if(node.kind==='template'){
    // Reuse the existing static template parser's declaration diagnostics. This
    // probe supplies no environment declarations and inert local input values,
    // so only actual reads are reported; it neither renders nor runs a template.
    // Comments, quoted literals, filters and loop-local scope follow the exact
    // same grammar used by graph validation instead of a second regex parser.
    const probe={nodes:[{...node,config:{text:config.text,inputs:Object.fromEntries(Object.keys(config.inputs??{}).map(key=>[key,null]))}}],edges:[]}
    if(referenceScopeIssues(probe).some(issue=>issue.message===`环境变量引用 env.${id} 未声明；请使用稳定变量身份`))return true
  }
  const templates=fields.filter(field=>!(node.kind==='template'&&field==='text')).flatMap(field=>strings(config[field])).concat(node.kind==='human'?(config.fields??[]).flatMap(field=>strings(field.defaultValue)):[])
  for(const text of templates)for(const match of text.matchAll(/\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}/g))if(pattern.test(match[1]??match[2]??''))return true
  const conditions=[...(config.cases??[]).flatMap(branch=>branch.conditions),config.until,config.filter].filter(condition=>!!condition)
  const expressions=[config.variable,config.iterator,config.outputVariable,config.listSource,config.source,...(config.groups??[]).flatMap(group=>group.variables),...conditions.map(condition=>condition.variable)]
  if(expressions.some(expression=>!!expression&&pattern.test(expression)))return true
  return conditions.some(condition=>strings(condition.value).some(text=>[...text.matchAll(/\{\{([\s\S]*?)\}\}/g)].some(match=>pattern.test(match[1]!))))
}

/** Document parsing injects the selected file into its declared source key. */
function providesToolArgument(node:WorkflowNode,key:string):boolean {
  return Object.hasOwn(node.config.inputs??{},key)||(node.kind==='document'&&node.config.documentMode==='tool'&&key===(node.config.documentSourceKey??'source'))
}

/** Read-only completeness check against actual resources in the target Host. */
export async function inspectWorkflowReadiness(value:unknown,context:WorkflowReadinessContext):Promise<WorkflowReadiness> {
  const root=parseWorkflow(value),issues:WorkflowReadinessIssue[]=[],seen=new Set<string>()
  const add=(flow:Workflow,nodeId:string|undefined,kind:WorkflowReadinessIssue['kind'],message:string,extra:Partial<WorkflowReadinessIssue>={},callerId?:string)=>{
    const target=callerId??nodeId,id=JSON.stringify([flow.id,target,kind,extra.dependencyId??extra.field??'',message])
    if(seen.has(id))return;seen.add(id)
    issues.push({id,...(target?{nodeId:target}:{}),workflowId:flow.id,kind,message:callerId?`子工作流「${flow.title}」：${message}`:message,action:kind==='environment'||kind==='secret'?'environment':kind==='configuration'?'node':'dependency',...extra})
  }
  const visit=async(flow:Workflow,ancestors:string[],callerId?:string):Promise<void>=>{
    const nodes=allNodes(flow),effective=structuredClone(flow),referencePlan=createReferenceScopePlan(flow)
    const artifactPath=(path:string):string|undefined=>{
      if(!path||path.startsWith('__WORKFLOW_FILE_REBIND_REQUIRED__/')||path.includes('{{')||path.includes('\0')||path.split(/[\\/]/).includes('..'))return undefined
      const normalized=relative(resolve(context.workspaceRoot),resolve(context.workspaceRoot,path))
      return normalized&&!isAbsolute(normalized)&&normalized.split(/[\\/]/)[0]!=='..'?normalized:undefined
    }
    const producedUpstream=(node:WorkflowNode,path:string):boolean=>{
      const target=artifactPath(path),upstream=referencePlan.nodes.get(node.id)?.nodeIds
      return !!target&&!!upstream&&nodes.some(producer=>upstream.has(producer.id)&&[...(producer.config.verification?.requiredFiles??[]),...(producer.config.verification?.requiredChangedFiles??[])].some(path=>artifactPath(path)===target))
    }
    for(const node of allNodes(effective))if(isModelNode(node)&&!node.config.model&&context.modelDefaults)node.config.model={...context.modelDefaults.model}
    // Ordinary missing environment values are emitted below with node locations.
    for(const issue of graphIssues(effective,true,true).filter(issue=>!issue.message.startsWith('必需环境变量 ')&&!['请选择此节点的模型','请配置 DSH 默认模型或选择文档解析模型'].includes(issue.message)))add(flow,issue.nodeId,'configuration',issue.message,{},callerId)
    for(const variable of flow.environmentVariables??[]){
      const consumers=nodes.filter(node=>referencesEnvironment(node,variable.id)||node.config.credentialOperation?.secretVariableId===variable.id)
      if(!variable.required&&!consumers.length)continue
      if(variable.type==='secret'){
        let status:'configured'|'missing'|'unavailable'|'authorization_required'='unavailable'
        try{status=await context.secretStatus?.(flow,variable.id)??'unavailable'}catch{status='unavailable'}
        if(status!=='configured')for(const node of consumers.length?consumers:[undefined])add(flow,node?.id,'secret',status==='authorization_required'?`Secret「${variable.name}」尚未授权自动使用，请在系统凭据窗口核对当前工作流和请求目标后授权`:status==='missing'?`Secret「${variable.name}」尚未配置，请打开受保护凭据管理窗口`:`Secret「${variable.name}」的受保护配置状态暂不可核验，请检查当前宿主凭据代理`,{dependencyId:variable.id,field:'environmentVariables'},callerId)
      }else if(variable.value===undefined)for(const node of consumers.length?consumers:[undefined])add(flow,node?.id,'environment',`环境变量「${variable.name}」缺少值，请填写`,{dependencyId:variable.id,field:'environmentVariables'},callerId)
    }
    for(const issue of workflowSubagentScopeIssues(flow,context.sessionId))add(flow,issue.nodeId,'role',issue.message,{field:'subagentId'},callerId)
    for(const node of nodes){
      if(isModelNode(node)){
        const model=node.config.model??context.modelDefaults?.model
        if(model){const choice=context.catalog.models.find(item=>item.provider===model.provider&&item.model===model.model)
          const inheritedEffort=model.provider===context.modelDefaults?.model.provider&&model.model===context.modelDefaults.model.model?context.modelDefaults.effort:undefined,effort=node.config.effort??inheritedEffort
          if(!choice)add(flow,node.id,'model',`模型 ${model.provider}/${model.model} 在当前宿主不可用，请重新选择或配置`,{dependencyId:`${model.provider}/${model.model}`,field:'model'},callerId)
          else if(effort&&!choice.efforts.some(item=>item.id===effort))add(flow,node.id,'model',node.config.effort?'原思考强度在当前模型不可用，请重新选择':'DSH 默认思考强度在当前模型不可用，请在 DSH 或此节点重新选择',{field:'effort'},callerId)
        }else add(flow,node.id,'model','未指定模型，DSH 也未配置默认模型；请在 DSH 选择模型或为此节点指定模型',{field:'model'},callerId)
      }
      if(node.config.rolePresetId&&!subagentForNode(flow,node)){const frozen=flow.id===root.id?context.rolePrompts:context.dependencyRolePrompts?.[flow.id]
        if(!(frozen&&Object.hasOwn(frozen,node.id))&&!context.catalog.presets.some(role=>role.id===node.config.rolePresetId&&rolePresetAvailable(role,flow.id)))add(flow,node.id,'role',`角色预设 ${node.config.rolePresetId} 不存在或不属于当前工作流，请选择角色或取消此引用`,{dependencyId:node.config.rolePresetId,field:'rolePresetId'},callerId)
      }
      for(const id of new Set([node.config.toolId,...(node.config.tools??[])].filter((id):id is string=>!!id))){
        if(id.startsWith('workflow:')){
          const childId=id.slice(9),stored=context.dependencySnapshots?context.dependencySnapshots[childId]:context.catalog.workflows.find(child=>child.id===childId&&workflowVisibleInWorkspace(child,flow.workspaceId)),child=stored?workflowForExecution(stored,flow.workspaceId):undefined
          if(!child||child.workspaceId!==flow.workspaceId){add(flow,node.id,'workflow',`子工作流 ${childId} 不存在或不属于当前工作区，请重新选择`,{dependencyId:id,field:node.config.toolId===id?'toolId':'tools'},callerId);continue}
          if(ancestors.includes(childId)||ancestors.length>=8){add(flow,node.id,'workflow','子工作流递归调用或超过 8 层限制',{dependencyId:id},callerId);continue}
          if(allNodes(child).some(node=>node.kind==='human'))add(flow,node.id,'workflow','包含人工介入的子工作流须独立运行，请选择其他流程',{dependencyId:id},callerId)
          if(node.config.toolId===id)for(const field of child.nodes.find(node=>node.kind==='input')?.config.fields??[])if(field.required&&field.defaultValue===undefined&&!providesToolArgument(node,field.name))add(flow,node.id,'configuration',`子工作流参数「${field.label||field.name}」为必填项`,{dependencyId:id,field:`inputs.${field.name}`},callerId)
          await visit(child,[...ancestors,childId],callerId??node.id)
        }else{
          const tool=context.catalog.tools.find(tool=>tool.id===id&&tool.available&&tool.id!=='native:run_code')
          if(!tool)add(flow,node.id,'tool',`工具 ${id} 在当前工作区不可用${id.startsWith('native:')?'或缺少对话权限':''}，请连接、授权或重新选择`,{dependencyId:id,field:node.config.toolId===id?'toolId':'tools'},callerId)
          else if(node.config.toolId===id)for(const field of Array.isArray(tool.inputSchema.required)?tool.inputSchema.required:[])if(typeof field==='string'&&!providesToolArgument(node,field))add(flow,node.id,'configuration',`工具参数「${field}」为必填项`,{dependencyId:id,field:`inputs.${field}`},callerId)
        }
      }
      const files:{path:string;field:string;output:boolean}[]=[]
      if(node.config.verification?.requiredReadFiles?.length){
        let available=false
        try{available=context.canVerifyFileReads?.(node)===true}catch{/* An unavailable attestation cannot authorize execution. */}
        if(!available)add(flow,node.id,'configuration',FILE_READ_CAPABILITY_UNAVAILABLE,{field:'verification.requiredReadFiles'},callerId)
      }
      if(node.kind==='knowledge'&&!node.config.sources?.length)add(flow,node.id,'file','请选择知识来源文件',{field:'sources'},callerId)
      if(node.kind==='document'&&node.config.source&&!isFileReference(node.config.source,flow))files.push({path:node.config.source,field:'source',output:false})
      for(const [index,path] of (node.config.sources??[]).entries()){
        if(node.kind==='knowledge'&&isFileReference(path,flow))add(flow,node.id,'file','知识来源须选择工作区文件路径，当前检索器不支持动态变量来源',{field:`sources.${index}`},callerId)
        else files.push({path,field:`sources.${index}`,output:false})
      }
      for(const field of FILE_VERIFICATION_FIELDS)for(const [index,path] of (node.config.verification?.[field]??[]).entries())files.push({path,field:`verification.${field}.${index}`,output:field!=='requiredReadFiles'})
      // A matching verified upstream output is supplied during execution. Its
      // destination is still checked now; unrelated or downstream declarations
      // never authorize a missing external source. Execution rechecks the bytes.
      for(const file of files)try{await verifyWorkflowFile(context.workspaceRoot,isAbsolute(file.path)?relative(context.workspaceRoot,file.path):file.path,file.output||producedUpstream(node,file.path))}catch(error){add(flow,node.id,'file',`${file.field}：${error instanceof Error?error.message:'文件不可用'}`,{field:file.field,dependencyId:file.path},callerId)}
    }
  }
  await visit(root,[root.id])
  return {workflowId:root.id,revision:root.revision,canRun:issues.length===0,issues}
}

export function assertWorkflowReady(readiness:WorkflowReadiness):void {
  if(!readiness.canRun)throw new Error(`工作流还有 ${readiness.issues.length} 项待处理配置，不能运行：\n${readiness.issues.map(issue=>`${issue.nodeId?`${issue.nodeId}：`:''}${issue.message}`).join('\n')}`)
}
