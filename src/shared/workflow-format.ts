import { jsonDigest } from './json-digest.ts'
import { z } from 'zod'
import { newId, type JsonValue, type RolePreset, type Workflow } from './types.ts'
import { allNodes, assertGraph, parseWorkflow, presetSchema } from './workflow-validation.ts'
import { assertRolePresetScope, rolePresetAvailable } from './role-presets.ts'
import { workflowVisibleInWorkspace } from './workflow-scope.ts'

export interface WorkflowDependency { kind:'model'|'tool'|'workflow'|'file'|'role'; id:string; label:string }
export interface WorkflowPackage { format:'dsh-visible-workflow'; formatVersion:2; runtime:{engine:'graphon';protocol:1}; workflow:Workflow; workflows:Workflow[]; presets:RolePreset[]; dependencies:WorkflowDependency[] }
export interface ImportedWorkflow { workflow:Workflow; workflows:Workflow[]; presets:RolePreset[]; dependencies:WorkflowDependency[]; warnings:string[] }
export interface WorkflowExportOptions {includeEnvironmentValues?:boolean;presets?:RolePreset[];workflows?:Workflow[]}
const envelope=z.object({format:z.literal('dsh-visible-workflow'),formatVersion:z.literal(2),runtime:z.object({engine:z.literal('graphon'),protocol:z.literal(1)}).strict(),workflow:z.unknown(),workflows:z.array(z.unknown()).max(50).default([]),presets:z.array(presetSchema).max(200),dependencies:z.array(z.object({kind:z.enum(['model','tool','workflow','file','role']),id:z.string().max(512),label:z.string().max(1000)}).strict()).max(2000)}).strict()
const absolutePath=(value:string)=>/^(?:\/(?!\/)|[A-Za-z]:[\\/]|file:\/\/|~\/)/.test(value.trim())
export const FILE_VERIFICATION_FIELDS=['requiredFiles','requiredReadFiles','requiredChangedFiles'] as const
export const WORKFLOW_PACKAGE_MAX_BYTES=8_000_000
export const WORKFLOW_PACKAGE_MAX_DEPTH=32
type ReferenceIds={nodes:ReadonlyMap<string,string>;environment:ReadonlyMap<string,string>}
const reservedRoots=new Set(['input','env','sys','item','index','vars','loop','true','True','false','False','null','none','None','and','or','not','in','is','defined'])
/** Match a reference root and its first property as one token. A property which
 * happens to have a node ID must never be treated as a second reference root. */
function expressionRefs(text:string,ids:ReferenceIds,locals:ReadonlySet<string>=new Set()):string {
  return text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?<![A-Za-z0-9_.-])([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_-]+)|\[(["'])([A-Za-z0-9_-]+)\3\])?/g,(whole,root:string|undefined,property:string|undefined,quote:string|undefined,bracketProperty:string|undefined)=>{
    if(!root||locals.has(root)||(!property&&!bracketProperty&&/^-?\d+$/.test(root)))return whole
    if(root==='env'){
      const original=property??bracketProperty,replacement=original&&ids.environment.get(original)
      return replacement?property?`env.${replacement}`:`env[${quote}${replacement}${quote}]`:whole
    }
    if(reservedRoots.has(root))return whole
    const replacement=ids.nodes.get(root)
    return replacement?replacement+whole.slice(root.length):whole
  })
}
const interpolationRefs=(text:string,ids:ReferenceIds)=>text.replace(/\{\{([\s\S]*?)\}\}/g,(_,value:string)=>`{{${expressionRefs(value,ids)}}}`)
function templateRefs(text:string,ids:ReferenceIds,names:Iterable<string>=[]):string {
  let locals=new Set(names)
  const stack:{kind:'for'|'if';locals:Set<string>}[]=[]
  return text.replace(/\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}|\{#[\s\S]*?#\}/g,(whole,expression:string|undefined,statement:string|undefined)=>{
    if(expression!==undefined)return `{{${expressionRefs(expression,ids,locals)}}}`
    if(statement===undefined)return whole
    const command=statement.trim(),loop=command.match(/^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+)$/)
    if(loop){const rewritten=statement.replace(/^(\s*for\s+[A-Za-z_][A-Za-z0-9_]*\s+in\s+)([\s\S]*)$/,(_,prefix:string,value:string)=>prefix+expressionRefs(value,ids,locals));stack.push({kind:'for',locals});locals=new Set([...locals,loop[1]!,'loop']);return `{%${rewritten}%}`}
    if(command.startsWith('if ')){const rewritten=statement.replace(/^(\s*if\s+)([\s\S]*)$/,(_,prefix:string,value:string)=>prefix+expressionRefs(value,ids,locals));stack.push({kind:'if',locals});return `{%${rewritten}%}`}
    if(command==='else'||command.startsWith('elif ')){const frame=stack.at(-1);if(frame?.kind==='for')locals=frame.locals;return `{%${statement.replace(/^(\s*elif\s+)([\s\S]*)$/,(_,prefix:string,value:string)=>prefix+expressionRefs(value,ids,locals))}%}`}
    if(command==='endfor'||command==='endif'){const frame=stack.pop();if(frame)locals=frame.locals}
    return whole
  })
}
function assertPackageSize(input:string):void {
  if(new TextEncoder().encode(input).byteLength>WORKFLOW_PACKAGE_MAX_BYTES)throw new Error('工作流文件不能超过 8 MB；请减少长文本或拆分工作流后重试')
}
function inspectPackage(value:unknown,depth=0):void {
  if(depth>WORKFLOW_PACKAGE_MAX_DEPTH)throw new Error('工作流 JSON 嵌套超过 32 层')
  if(value&&typeof value==='object')for(const [key,item]of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(key))throw new Error('工作流 JSON 含不安全字段');inspectPackage(item,depth+1)}
}
function mapStrings<T>(value:T,transform:(value:string)=>string):T {
  if(typeof value==='string')return transform(value) as T
  if(Array.isArray(value))return value.map(item=>mapStrings(item,transform)) as T
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,mapStrings(item,transform)])) as T
  return value
}
export function workflowDependencies(flow:Workflow):WorkflowDependency[] {
  const found=new Map<string,WorkflowDependency>()
  const add=(kind:WorkflowDependency['kind'],id:string,label=id)=>found.set(`${kind}:${id}`,{kind,id,label})
  for(const node of allNodes(flow)){
    if(node.config.model)add('model',`${node.config.model.provider}/${node.config.model.model}`)
    if(node.config.rolePresetId)add('role',node.config.rolePresetId)
    for(const tool of [node.config.toolId,...(node.config.tools??[])].filter((item):item is string=>!!item))add(tool.startsWith('workflow:')?'workflow':'tool',tool)
    if(node.kind==='document'&&(!node.config.source||!isFileReference(node.config.source,flow)))add('file',`file-${node.id}-source`,`${node.title}：文档来源`)
    for(const [index,source] of (node.config.sources??[]).entries())if(!isFileReference(source,flow))add('file',`file-${node.id}-sources-${index}`,`${node.title}：资料文件 ${index+1}`)
    for(const field of FILE_VERIFICATION_FIELDS)for(const [index] of (node.config.verification?.[field]??[]).entries())add('file',`file-${node.id}-${field}-${index}`,`${node.title}：${field==='requiredReadFiles'?'阅读资料':field==='requiredChangedFiles'?'改动产物':'验收文件'} ${index+1}`)
    for(const field of node.config.fields??[])if(['file','files'].includes(field.type??''))add('file',`file-${node.id}-input-${field.name}`,`${node.title}：${field.label}（运行时上传）`)
  }
  return [...found.values()]
}
// `item` is the current element inside an iteration body; a bare `item` names it whole (Desktop r48).
export const isFileReference=(source:string,flow:Workflow)=>source.includes('{{')||/^item(?:\.[A-Za-z0-9_-]+)*$/.test(source)||/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(source)&&new Set(['input','env','sys',...allNodes(flow).map(node=>node.id)]).has(source.split('.')[0]!)
function portableWorkflow(source:Workflow,options:WorkflowExportOptions):Workflow {
  const flow=structuredClone(source)
  flow.workspaceId='import-required';flow.scope='workspace';flow.revision=0;delete flow.archived
  // Definitions travel with the graph; conversation and local preset links do not.
  for(const agent of flow.subAgents??[]){delete agent.sessionId;delete agent.rolePresetId;delete agent.rolePresetRevision}
  flow.environmentVariables=flow.environmentVariables?.map(variable=>{
    const {value:_value,...definition}=variable
    return options.includeEnvironmentValues&&variable.type!=='secret'?{...definition,value:variable.value}:definition
  }) as Workflow['environmentVariables']
  stripLocalFileBindings(flow)
  return flow
}
/** An unresolved external target is a declaration, while a cycle among included
 * definitions cannot execute and must be rejected before any import is written. */
function assertWorkflowBundle(workflows:Workflow[],validateGraph=true):void {
  const byId=new Map(workflows.map(flow=>[flow.id,flow])),active=new Set<string>(),done=new Set<string>()
  if(byId.size!==workflows.length)throw new Error('工作流包中存在重复的工作流身份')
  const visit=(flow:Workflow)=>{
    if(active.has(flow.id))throw new Error('随包子工作流存在循环调用，请移除循环后重试')
    if(done.has(flow.id))return
    active.add(flow.id)
    for(const dependency of workflowDependencies(flow))if(dependency.kind==='workflow'){const target=byId.get(dependency.id.slice('workflow:'.length));if(target)visit(target)}
    active.delete(flow.id);done.add(flow.id)
  }
  for(const flow of workflows){if(validateGraph)assertGraph(flow);visit(flow)}
}
export function exportWorkflowPackage(value:Workflow,options:WorkflowExportOptions={}):WorkflowPackage {
  const source=parseWorkflow(value),available=new Map((options.workflows??[]).filter(flow=>workflowVisibleInWorkspace(flow,source.workspaceId)).map(flow=>[flow.id,flow])),selected=new Map<string,Workflow>([[source.id,source]])
  const collect=(flow:Workflow)=>{for(const dependency of workflowDependencies(flow))if(dependency.kind==='workflow'){
    const id=dependency.id.slice('workflow:'.length),candidate=available.get(id)
    if(candidate&&!selected.has(id)){if(selected.size>=51)throw new Error('工作流包最多附带 50 个子工作流');const parsed=parseWorkflow(candidate);selected.set(id,parsed);collect(parsed)}
  }}
  collect(source)
  const sources=[...selected.values()]
  assertWorkflowBundle(sources)
  const dependencies=[...new Map(sources.flatMap(workflowDependencies).map(dependency=>[`${dependency.kind}:${dependency.id}`,dependency])).values()]
  const neededRoles=new Set(sources.flatMap(allNodes).map(node=>node.config.rolePresetId).filter(Boolean))
  for(const flow of sources)assertRolePresetScope(flow,options.presets??[])
  const presets=(options.presets??[]).filter(preset=>preset.scope==='workflow'?sources.some(flow=>flow.id===preset.workflowId):neededRoles.has(preset.id)).map(preset=>presetSchema.parse(preset))
  if(new Set(presets.map(preset=>preset.id)).size!==presets.length)throw new Error('角色预设身份重复')
  const [workflow,...workflows]=sources.map(flow=>portableWorkflow(flow,options))
  const result:WorkflowPackage={format:'dsh-visible-workflow',formatVersion:2,runtime:{engine:'graphon',protocol:1},workflow:workflow!,workflows,presets,dependencies}
  // Export must satisfy the same envelope limits as import (including the role
  // and dependency collection limits), rather than create an unreadable file.
  envelope.parse(result)
  inspectPackage(result)
  assertPackageSize(JSON.stringify(result,null,2))
  return result
}
export function stripLocalFileBindings(flow:Workflow):void {
  for(const node of allNodes(flow)){
    if(node.config.source&&absolutePath(node.config.source))node.config.source=''
    if(node.config.sources)node.config.sources=node.config.sources.map(value=>absolutePath(value)?'':value)
    for(const field of FILE_VERIFICATION_FIELDS)if(node.config.verification?.[field])node.config.verification[field]=node.config.verification[field]!.map((value,index)=>absolutePath(value)?`__WORKFLOW_FILE_REBIND_REQUIRED__/${node.id}/${field}/${index}`:value)
    // Upload metadata and local file paths must not become portable authorization.
    if(node.config.inputs)node.config.inputs=scrubFileReferences(node.config.inputs) as Record<string,JsonValue>
    if(node.config.initialVariables)node.config.initialVariables=scrubFileReferences(node.config.initialVariables) as Record<string,JsonValue>
    for(const assignment of node.config.assignments??[])if(assignment.value!==undefined)assignment.value=scrubFileReferences(assignment.value)
    for(const field of node.config.fields??[])if(['file','files'].includes(field.type??''))delete field.defaultValue
  }
}
function scrubFileReferences(value:JsonValue):JsonValue {
  if(Array.isArray(value))return value.map(scrubFileReferences)
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['workflowFileId','base64'].includes(key)).map(([key,item])=>[key,key==='path'&&typeof item==='string'&&absolutePath(item)?'':scrubFileReferences(item)]))
  return value
}
export function exportWorkflowJson(flow:Workflow,options:WorkflowExportOptions={}):string { return JSON.stringify(exportWorkflowPackage(flow,options),null,2) }
/** Stored template evidence skips current graph contracts; import remains strict. */
export function parseWorkflowPackage(input:string,options:{historical?:boolean}={}):WorkflowPackage {
  assertPackageSize(input)
  let raw:unknown
  try{raw=JSON.parse(input)}catch{throw new Error('工作流文件不是有效 JSON')}
  inspectPackage(raw)
  if((raw as {formatVersion?:number}|null)?.formatVersion!==2)throw new Error('不支持此工作流格式版本；仅支持当前 formatVersion: 2，不提供旧版迁移')
  const parsed=envelope.parse(raw),workflow=parseWorkflow(parsed.workflow),workflows=parsed.workflows.map(parseWorkflow)
  if(new Set(parsed.presets.map(preset=>preset.id)).size!==parsed.presets.length)throw new Error('角色预设身份重复')
  if(parsed.presets.some(preset=>preset.scope==='workflow'&&![workflow,...workflows].some(flow=>flow.id===preset.workflowId)))throw new Error('角色预设不属于随包工作流')
  for(const flow of [workflow,...workflows])assertRolePresetScope(flow,parsed.presets)
  assertWorkflowBundle([workflow,...workflows],!options.historical)
  return {...parsed,formatVersion:2,workflow,workflows}
}
export function importWorkflowJson(input:string,workspaceId:string,options:{externalPresets?:RolePreset[]}={}):ImportedWorkflow {
  if(!workspaceId)throw new Error('请选择目标工作区')
  const parsed=parseWorkflowPackage(input),warnings:string[]=[],sources=[parsed.workflow,...parsed.workflows],workflowIds=new Map(sources.map(flow=>[flow.id,newId()])),roleIds=new Map(parsed.presets.map(preset=>[preset.id,newId()]))
  const presets=parsed.presets.map(preset=>({...preset,id:roleIds.get(preset.id)!,revision:0,...(preset.scope==='workflow'?{workflowId:workflowIds.get(preset.workflowId!)!}:{})})),presentRoles=[...presets,...(options.externalPresets??[])]
  const importOne=(source:Workflow):Workflow=>{
  const nodeIds=new Map(allNodes(source).map(node=>[node.id,newId()])),environmentIds=new Map((source.environmentVariables??[]).map(variable=>[variable.id,newId()]))
  const subagentIds=new Map((source.subAgents??[]).map(agent=>[agent.id,newId()]))
  const ids:ReferenceIds={nodes:nodeIds,environment:environmentIds}
  const localFiles=workflowDependencies(source).filter(dependency=>dependency.kind==='file')
  if(localFiles.length)warnings.push('文件依赖须在目标工作区核对；运行附件须重新上传')
  const workflow=structuredClone(source)
  // A hand-written package can hide an upload handle in ordinary tool inputs,
  // assignments or loop state without declaring any file dependency. Imported
  // metadata never grants access to another run's attachments, regardless of
  // which node kinds happen to be present in the graph.
  stripLocalFileBindings(workflow)
  workflow.id=workflowIds.get(source.id)!;workflow.workspaceId=workspaceId;workflow.scope='workspace';workflow.revision=0;workflow.createdAt=new Date().toISOString();workflow.updatedAt=workflow.createdAt;delete workflow.archived
  for(const agent of workflow.subAgents??[]){agent.id=subagentIds.get(agent.id)!;delete agent.sessionId;delete agent.rolePresetId;delete agent.rolePresetRevision}
  for(const node of allNodes(workflow)){
    node.id=nodeIds.get(node.id)??node.id
    const c=node.config
    if(c.subagentId)c.subagentId=subagentIds.get(c.subagentId)??c.subagentId
    if(c.credentialOperation)c.credentialOperation={...c.credentialOperation,secretVariableId:environmentIds.get(c.credentialOperation.secretVariableId)??c.credentialOperation.secretVariableId}
    // Only rewrite syntax the runtime resolves. Code, literal input data and
    // explanatory prose must keep their meaning even if they resemble an ID.
    if(c.inputs)c.inputs=mapStrings(c.inputs,value=>interpolationRefs(value,ids))
    for(const key of ['text','prompt','query','url','bodyText'] as const)if(c[key]!==undefined)c[key]=key==='text'&&node.kind==='template'?templateRefs(c[key]!,ids,Object.keys(c.inputs??{})):interpolationRefs(c[key]!,ids)
    if(c.headers)c.headers=mapStrings(c.headers,value=>interpolationRefs(value,ids))
    for(const key of ['variable','iterator','outputVariable','listSource'] as const)if(c[key]!==undefined)c[key]=expressionRefs(c[key]!,ids)
    if(c.source)c.source=c.source.includes('{{')?interpolationRefs(c.source,ids):/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(c.source)?expressionRefs(c.source,ids):c.source
    const condition=(value:{variable:string;value?:string}|undefined)=>{if(value){value.variable=expressionRefs(value.variable,ids);if(value.value)value.value=interpolationRefs(value.value,ids)}}
    for(const branch of c.cases??[])for(const value of branch.conditions)condition(value)
    for(const input of c.logicGate?.inputs??[])input.value=mapStrings(input.value,value=>interpolationRefs(value,ids))
    condition(c.until);condition(c.filter)
    if(c.value)c.value=interpolationRefs(c.value,ids)
    for(const group of c.groups??[])group.variables=group.variables.map(value=>expressionRefs(value,ids))
    for(const assignment of c.assignments??[])if(assignment.value!==undefined)assignment.value=mapStrings(assignment.value,value=>interpolationRefs(value,ids))
    if(c.initialVariables)c.initialVariables=mapStrings(c.initialVariables,value=>interpolationRefs(value,ids))
    if(node.kind==='human')for(const field of c.fields??[])if(field.defaultValue)field.defaultValue=interpolationRefs(field.defaultValue,ids)
    if(node.config.rolePresetId)node.config.rolePresetId=roleIds.get(node.config.rolePresetId)??node.config.rolePresetId
    const workflowTool=(id:string)=>id.startsWith('workflow:')&&workflowIds.has(id.slice(9))?`workflow:${workflowIds.get(id.slice(9))}`:id
    if(c.toolId)c.toolId=workflowTool(c.toolId)
    if(c.tools)c.tools=c.tools.map(workflowTool)
    if(node.config.body)for(const edge of node.config.body.edges){edge.id=newId();edge.source=nodeIds.get(edge.source)??edge.source;edge.target=nodeIds.get(edge.target)??edge.target}
  }
  for(const edge of workflow.edges){edge.id=newId();edge.source=nodeIds.get(edge.source)??edge.source;edge.target=nodeIds.get(edge.target)??edge.target}
  for(const record of workflow.moduleInstances??[]){
    record.roles=Object.fromEntries(Object.entries(record.roles).map(([role,id])=>[role,nodeIds.get(id)??id]))
    record.scope=record.scope.map(id=>nodeIds.get(id)??id)
    record.edges=record.edges.map(edge=>({...edge,source:nodeIds.get(edge.source)??edge.source,target:nodeIds.get(edge.target)??edge.target}))
    // Preserve detached parameter digests as detached; never certify stale records during import.
    const matched=jsonDigest(record.parameters)===record.parametersDigest
    record.parameters=Object.fromEntries(Object.entries(record.parameters).map(([key,value])=>[key,
      key==='template'&&typeof value==='string'?templateRefs(value,ids):mapStrings(value,text=>interpolationRefs(text,ids)),
    ])) as Record<string,JsonValue>
    if(matched)record.parametersDigest=jsonDigest(record.parameters)
  }
  for(const note of workflow.notes){note.id=newId();if(note.anchorNodeId)note.anchorNodeId=nodeIds.get(note.anchorNodeId)??note.anchorNodeId}
  if(workflow.editor){
    const scope=(path:string[])=>path.map(id=>nodeIds.get(id)??id)
    if(workflow.editor.scopePath)workflow.editor.scopePath=scope(workflow.editor.scopePath)
    for(const annotation of workflow.editor.annotations??[]){annotation.id=newId();annotation.nodeIds=scope(annotation.nodeIds);if(annotation.position)annotation.position.scopePath=scope(annotation.position.scopePath)}
  }
  for(const variable of workflow.environmentVariables??[]){variable.id=environmentIds.get(variable.id)??variable.id;variable.revision=0;if(variable.type==='secret')warnings.push(`Secret ${variable.name} 仅导入声明；须在当前设备的受保护凭据管理窗口重新配置和批准，不继承原流程授权`)}
  for(const node of allNodes(workflow))if(node.config.rolePresetId&&!presentRoles.some(role=>role.id===node.config.rolePresetId&&rolePresetAvailable(role,workflow.id)))warnings.push(`${node.title}：缺少角色预设 ${node.config.rolePresetId}，已保留声明；请在画布中重新配置后运行`)
  assertGraph(workflow)
  return workflow
  }
  const [workflow,...workflows]=sources.map(importOne)
  if(parsed.dependencies.length)warnings.push('导入不会执行；请核对模型、工具、子流程和文件依赖')
  return {workflow:workflow!,workflows,presets,dependencies:parsed.dependencies,warnings}
}
export function exportWorkflowMarkdown(flow:Workflow):string {
  const code=(text:string)=>text.replace(/`/g,'\\`')
  return [`# ${flow.title}`,flow.description,'> 本文件仅为说明。执行以 workflow.json 为准。',...allNodes(flow).flatMap(node=>[`## ${node.number} ${node.title}`,`类型：${node.kind}；身份：\`${code(node.id)}\``,node.config.prompt??node.config.text??''])].join('\n\n')+'\n'
}
