import { z } from 'zod'
import { CANVAS_NOTE_SIZE, type Workflow, type WorkflowNode, type ValidationIssue, type NodeGraph, type NodeKind, type JsonValue } from './types.ts'
import { referenceScopeIssues, referencesEnvironmentVariable } from './reference-scope.ts'
import { environmentVariableIssues } from './workflow-variables.ts'
import { validateLogicGate } from './logic-gates.ts'

const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/, '身份只能包含字母、数字、下划线或连字符')
const fieldName = z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).refine(v => !['constructor', 'prototype', '__proto__'].includes(v))
const json: z.ZodType<JsonValue> = z.lazy(() => z.union([z.string().max(400000), z.number().finite(), z.boolean(), z.null(), z.array(json).max(10000), z.record(z.string().max(1000).refine(v => !['constructor', 'prototype', '__proto__'].includes(v)), json)]))
const mapping = z.record(fieldName, json)
export const inputFieldSchema = z.object({ name: fieldName, label: z.string().max(200), required: z.boolean(), defaultValue: z.string().max(200000).optional(), type: z.enum(['text','paragraph','number','boolean','select','json','file','files']).optional(), options: z.array(z.string().max(1000)).max(100).optional(), hidden: z.boolean().optional() }).strict()
const model = z.object({ provider: z.string().min(1).max(256), model: z.string().min(1).max(256) }).strict()
const text = z.string().max(400000)
const evidencePaths=z.array(z.string().min(1).max(4000)).max(30).optional()
const executionFields = { verification:z.object({requiredFiles:evidencePaths,requiredReadFiles:evidencePaths,requiredChangedFiles:evidencePaths,minTextLength:z.number().int().min(1).max(400000).optional()}).strict().optional(),cache:z.enum(['never','reuse']).optional() }
const environmentBase={id:identifier,name:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(80).refine(v=>!['__proto__','prototype','constructor'].includes(v)),description:z.string().max(2000).optional(),required:z.boolean().optional(),revision:z.number().int().nonnegative().optional()}
export const environmentVariableSchema=z.discriminatedUnion('type',[
  z.object({...environmentBase,type:z.literal('string'),value:text.optional()}).strict(),
  z.object({...environmentBase,type:z.literal('number'),value:z.number().finite().optional()}).strict(),
  z.object({...environmentBase,type:z.literal('secret')}).strict(),
])
const generationFields = { prompt: text.default(''), model: model.optional(), effort: z.string().min(1).max(128).optional() }
const modelFields = { ...generationFields, rolePresetId: identifier.optional() }
const condition = z.object({ variable: z.string().max(400), operator: z.enum(['contains','not_contains','equals','not_equals','not_empty','empty','starts_with','ends_with','gt','gte','lt','lte']), value: text.optional() }).strict()
const parameter = z.object({ name: fieldName, type: z.enum(['string','number','boolean','object','array']), description: z.string().max(2000).optional(), required: z.boolean().optional() }).strict()
const nodeSchema = z.object({ id: identifier, number: z.string().max(100), kind: z.enum(['input','template','llm','if','output','agent','knowledge','classifier','human','iteration','loop','exit_loop','code','aggregator','document','assigner','extractor','http','list','tool']), title: z.string().min(1).max(200), note: z.string().max(2000).optional(), x: z.number().finite(), y: z.number().finite(), fixed: z.boolean(), config: z.record(z.string(), z.unknown()) }).strict()
const edgeSchema = z.object({ id: identifier, source: identifier, target: identifier, port: identifier.optional() }).strict()
const graphSchema = z.object({ nodes: z.array(nodeSchema).min(1).max(200), edges: z.array(edgeSchema).max(1000) }).strict()
const configs = {
  input: z.object({ fields: z.array(inputFieldSchema).max(40).default([]) }).strict(),
  template: z.object({ text: text.default(''), inputs: mapping.optional() }).strict(),
  llm: z.object({ ...modelFields, inputs: mapping.optional(), outputSchema: z.array(parameter).max(40).optional() }).strict(),
  if: z.object({ variable: z.string().max(400).default(''), operator: condition.shape.operator.default('not_empty'), value: text.optional(), cases: z.array(z.object({ id: identifier, logic: z.enum(['and','or']).optional(), conditions: z.array(condition).min(1).max(30) }).strict()).max(20).optional(),logicGate:z.object({operator:z.enum(['IF','AND','OR','NOT','NAND','NOR','XOR','XNOR']),inputs:z.array(z.object({value:json,predicate:z.enum(['boolean','truthy','falsy','nonEmpty']).optional()}).strict()).min(1).max(32)}).strict().optional() }).strict(),
  output: z.object({ text: text.default(''), outputName: fieldName.default('result'), inputs: mapping.optional() }).strict(),
  agent: z.object({ ...generationFields, subagentId:identifier.optional(), outputSchema: z.array(parameter).max(40).optional(), tools: z.array(z.string().max(256)).max(30).default([]), inputs: mapping.optional(), maxSteps: z.number().int().min(1).max(20).default(6), timeoutMs:z.number().int().min(100).max(3_600_000).optional() }).strict(),
  knowledge: z.object({ query: text.default(''), sources: z.array(text).max(20).default([]), topK: z.number().int().min(1).max(50).default(5), threshold: z.number().min(0).max(1).optional(), inputs: mapping.optional() }).strict(),
  classifier: z.object({ ...modelFields, classes: z.array(z.object({ id: identifier, label: z.string().min(1).max(200), description: text.optional() }).strict()).max(20).default([]), inputs: mapping.optional() }).strict(),
  human: z.object({ prompt: text.default(''), fields: z.array(inputFieldSchema).max(40).default([]), actions: z.array(z.object({ id: identifier, label: z.string().min(1).max(200) }).strict()).min(1).max(20).default([{id:'continue',label:'继续'}]), timeoutSeconds: z.number().int().min(1).max(2592000).optional() }).strict(),
  iteration: z.object({ iterator: z.string().max(400).default(''), body: graphSchema.optional(), outputVariable: z.string().max(400).default(''), errorMode: z.enum(['terminate','null','remove']).default('terminate'), parallel: z.boolean().default(false), concurrency: z.number().int().min(1).max(10).default(3) }).strict(),
  loop: z.object({ body: graphSchema.optional(), maxIterations: z.number().int().min(1).max(100).default(10), until: condition.optional(), initialVariables: mapping.default({}), outputVariable: z.string().max(400).optional() }).strict(),
  exit_loop: z.object({}).strict(),
  code: z.object({ language: z.enum(['javascript','python']).default('javascript'), code: text.default(''), inputs: mapping.default({}), outputSchema: z.array(parameter).max(40).optional(), timeoutMs: z.number().int().min(100).max(30000).default(5000) }).strict(),
  aggregator: z.object({ groups: z.array(z.object({ name: fieldName, variables: z.array(z.string().min(1).max(400)).min(1).max(40) }).strict()).max(40).default([]) }).strict(),
  document: z.object({ source: text.default(''), documentMode: z.enum(['local','tool','agent']).default('local'), documentSourceKey: fieldName.optional(), documentTextPath: z.string().min(1).max(400).refine(v=>v.split('.').every(k=>k.length>0&&!['__proto__','prototype','constructor'].includes(k)),'文本路径包含无效字段').optional(), toolId: z.string().max(256).optional(), inputs: mapping.optional(), ...modelFields, tools: z.array(z.string().min(1).max(256)).max(30).optional(), maxSteps: z.number().int().min(2).max(20).optional() }).strict(),
  assigner: z.object({ assignments: z.array(z.object({ name: fieldName, operation: z.enum(['set','clear','add','subtract','multiply','divide','append','extend','pop','shift']), value: json.optional() }).strict()).max(40).default([]) }).strict(),
  extractor: z.object({ ...modelFields, parameters: z.array(parameter).max(40).default([]), inputs: mapping.optional() }).strict(),
  http: z.object({ url: text.default(''), method: z.enum(['GET','HEAD','POST','PUT','PATCH','DELETE']).default('GET'), headers: z.record(z.string().max(200), z.string().max(10000)).default({}), bodyText: text.optional(), timeoutMs: z.number().int().min(100).max(120000).default(30000), inputs: mapping.optional() }).strict(),
  list: z.object({ listSource: z.string().max(400).default(''), filter: condition.optional(), sort: z.enum(['asc','desc']).optional(), limit: z.number().int().min(1).max(20).optional() }).strict(),
  tool: z.object({ toolId: z.string().max(256).default(''), inputs: mapping.default({}) }).strict(),
}
// Undefined clearing patches are allowed in the editor; any supplied direct-request
// value is rejected in protected mode. JSON never carries these clearing keys.
const protectedHttpConfig = z.object({
  credentialOperation:z.object({secretVariableId:identifier,operationId:z.literal('deepseek.account-status.v1')}).strict(),
  timeoutMs:z.never().optional(),
  url:z.never().optional(),method:z.never().optional(),headers:z.never().optional(),bodyText:z.never().optional(),inputs:z.never().optional(),
  ...executionFields,
}).strict()
const httpConfigSchema = z.union([configs.http.extend({credentialOperation:z.never().optional(),...executionFields}),protectedHttpConfig])
export function workflowNodeConfigSchema(kind:NodeKind):z.ZodType { return kind==='http'?httpConfigSchema:configs[kind].extend(executionFields) }
export function storedWorkflowNodeConfigSchema(kind:NodeKind):z.ZodType {return workflowNodeConfigSchema(kind)}
export const canvasNoteSchema = z.object({
  id: identifier, text: z.string().max(20000), x: z.number().finite(), y: z.number().finite(),
  width: z.number().finite().min(CANVAS_NOTE_SIZE.minWidth).max(CANVAS_NOTE_SIZE.maxWidth).optional(),
  height: z.number().finite().min(CANVAS_NOTE_SIZE.minHeight).max(CANVAS_NOTE_SIZE.maxHeight).optional(),
  color: z.enum(['yellow','blue','green','purple','neutral']).optional(), anchorNodeId: identifier.optional(),
}).strict()
const scopePathSchema=z.array(identifier).max(5)
export const workflowEditorSchema=z.object({
  viewport:z.object({x:z.number().finite(),y:z.number().finite(),scale:z.number().finite().min(.1).max(4)}).strict().optional(),
  scopePath:scopePathSchema.optional(),
  annotations:z.array(z.object({id:identifier,number:z.number().int().positive(),nodeIds:z.array(identifier).max(500),text:z.string().max(20000),position:z.object({x:z.number().finite(),y:z.number().finite(),scopePath:scopePathSchema}).strict().optional()}).strict()).max(200).optional(),
}).strict()
export const workflowModuleInstanceSchema=z.object({
  instanceKey:identifier,moduleId:identifier,version:z.string().min(1).max(80),implementationDigest:z.string().regex(/^[a-f0-9]{64}$/),parametersDigest:z.string().regex(/^[a-f0-9]{64}$/),
  parameters:z.record(z.string().refine(v=>!['constructor','prototype','__proto__'].includes(v)),json),roles:z.record(identifier,identifier),scope:z.array(identifier).max(5),
  edges:z.array(edgeSchema.omit({id:true})).max(1000),
}).strict()
export const workflowSchema = graphSchema.extend({
  id: identifier, workspaceId: z.string().min(1).max(160), title: z.string().min(1).max(200), description: z.string().max(10000), revision: z.number().int().nonnegative(),
  scope:z.enum(['workspace','global']).optional(),
  moduleInstances:z.array(workflowModuleInstanceSchema).max(200).optional(),
  notes: z.array(canvasNoteSchema).max(200),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), archived: z.boolean().optional(),
  environmentVariables:z.array(environmentVariableSchema).max(200).optional(),
  editor:workflowEditorSchema.optional(),
  budgetDecision:z.object({mode:z.enum(['limited','unlimited']),decidedAt:z.string().datetime()}).strict().optional().describe('Legacy metadata, preserved on old graphs; not execution control or permission.'),
  subAgents:z.array(z.object({id:identifier,number:z.string().regex(/^agent-[1-9][0-9]*$/).max(100),name:z.string().trim().min(1).max(100),prompt:z.string().max(100000),sessionId:identifier.optional(),rolePresetId:identifier.optional(),rolePresetRevision:z.number().int().nonnegative().optional()}).strict()).max(500).optional(),
  executionPolicy:z.object({httpCacheLimitMB:z.unknown().optional(),httpCacheImmediateCleanup:z.unknown().optional(),repairMode:z.enum(['confirm','auto']).optional(),maxConcurrentAgents:z.number().int().min(1).max(8).optional(),maxAgentTasks:z.number().int().min(1).max(1000).optional().describe('兼容旧图字段，已不生效：不再限制本次运行的任务数。'),tokenBudget:z.number().int().min(1).max(100_000_000).optional().describe('兼容旧图字段，已不生效：不再限制 Token 总用量。'),perTaskTokens:z.number().int().min(1).max(1_000_000).optional().describe('兼容旧图字段，已不生效：不再为单任务预留 Token。'),maxRepairAttempts:z.number().int().min(0).max(2).optional()}).strict().transform(({httpCacheLimitMB:_limit,httpCacheImmediateCleanup:_immediate,...policy})=>policy).optional(),
}).strict()
export const presetSchema = z.object({ id: identifier, name: z.string().trim().min(1).max(100), prompt: z.string().max(100000), revision: z.number().int().nonnegative(),summary:z.string().trim().max(240).optional(),scope:z.enum(['global','workflow']).optional(),workflowId:identifier.optional() }).strict().superRefine((preset,context)=>{if(preset.scope==='workflow'&&!preset.workflowId)context.addIssue({code:'custom',path:['workflowId'],message:'工作流预设须指定所属工作流'});if(preset.scope!=='workflow'&&preset.workflowId)context.addIssue({code:'custom',path:['workflowId'],message:'全局预设不能绑定工作流'})})
export const inputsSchema = z.record(z.string().regex(/^(?:[A-Za-z][A-Za-z0-9_]*|__action)$/), z.string().max(3_000_000)).refine(v => JSON.stringify(v).length <= 4_000_000, '一次输入最多 4 MB').refine(v => Object.keys(v).length <= 41, '最多 40 个输入')

export function parseWorkflow(value: unknown): Workflow {
  const rejectHidden=(value:unknown):void=>{if(!value||typeof value!=='object')return;if(Array.isArray(value)){value.forEach(rejectHidden);return}const row=value as Record<string,unknown>;if(row.kind==='http'&&row.config&&typeof row.config==='object'&&Object.hasOwn(row.config,'responseMode'))throw new Error('HTTP 节点含已移除的未知字段 responseMode，请删除该字段并使用普通 HTTP 请求');if(Array.isArray(row.nodes))row.nodes.forEach(rejectHidden);if(row.config&&typeof row.config==='object')rejectHidden((row.config as Record<string,unknown>).body)}
  rejectHidden(value)
  const raw = workflowSchema.parse(value)
  let count = 0
  function parseNodes(nodes: (typeof raw.nodes[number] | WorkflowNode)[], depth: number): WorkflowNode[] {
    if (depth > 5) throw new Error('子流程嵌套不能超过 5 层')
    return nodes.map(node => {
      if (++count > 500) throw new Error('一个工作流最多 500 个节点（含子流程）')
      if(node.kind==='agent'&&Object.hasOwn(node.config,'rolePresetId'))throw new Error('Agent 节点不再支持 rolePresetId；请使用 workflow.subAgents 与 config.subagentId')
      const config = storedWorkflowNodeConfigSchema(node.kind).parse(node.config) as WorkflowNode['config']
      if (config.body) config.body = { ...config.body, nodes: parseNodes(config.body.nodes, depth + 1) }
      return { ...node, config }
    })
  }
  const nodes=parseNodes(raw.nodes,0),canvasIds=new Set(nodes.map(node=>node.id))
  // Removing an anchor (including an Agent patch) must not remove its persistent explanation.
  const notes=raw.notes.map(note=>{if(!note.anchorNodeId||canvasIds.has(note.anchorNodeId))return note;const {anchorNodeId:_,...detached}=note;return detached})
  const result={ ...raw, nodes, notes }
  if(result.editor){
    const nodeIds=new Set(allNodes(result).map(node=>node.id)),annotationIds=new Set<string>()
    const validateScope=(path:string[])=>{let graph:NodeGraph=result;for(const id of path){const node=graph.nodes.find(item=>item.id===id);if(!node?.config.body)throw new Error('编辑视图引用了不存在的容器');graph=node.config.body}return graph}
    if(result.editor.scopePath)validateScope(result.editor.scopePath)
    for(const annotation of result.editor.annotations??[]){
      if(annotationIds.has(annotation.id))throw new Error('批注身份重复');annotationIds.add(annotation.id)
      if(new Set(annotation.nodeIds).size!==annotation.nodeIds.length||annotation.nodeIds.some(id=>!nodeIds.has(id)))throw new Error('批注引用了不存在或重复的节点')
      if(annotation.position)validateScope(annotation.position.scopePath)
    }
  }
  return result
}
/** Non-blocking notices: historical quotas stay parseable but never govern execution. */
export function executionPolicyWarnings(flow:Workflow):ValidationIssue[]{
  const fields=(['maxAgentTasks','tokenBudget','perTaskTokens'] as const).filter(key=>flow.executionPolicy?.[key]!==undefined)
  return fields.length?[{message:`兼容提示：旧执行策略 ${fields.join('、')} 已不生效，不再限制任务数或 Token 用量；实际用量记录和独立安全限制仍保留。`}]:[]
}
export function allNodes(graph: NodeGraph): WorkflowNode[] { return graph.nodes.flatMap(node => [node, ...(node.config.body ? allNodes(node.config.body) : [])]) }

/** Ports owned by the condition node itself; a case id must not alias them. */
const RESERVED_IF_PORTS=['false']
/** Nodes whose own execution has external effects or yields a workflow result. */
function ownEffect(node: WorkflowNode): boolean {
  return ['output','tool','http','agent'].includes(node.kind) || node.kind === 'document' && (node.config.documentMode === 'tool' || node.config.documentMode === 'agent')
}
/** A root node that newly brings an effect into the graph: a new effectful node,
 * an existing node turned effectful, or a container gaining such a descendant. */
function introducesEffect(node: WorkflowNode, before: ReadonlyMap<string, WorkflowNode>): boolean {
  return [node, ...(node.config.body ? allNodes(node.config.body) : [])].some(item => { const old = before.get(item.id); return ownEffect(item) && !(old && ownEffect(old)) })
}
/** Structural validation also runs on save; incomplete node fields remain editable drafts. */
export function graphIssues(flow: Workflow, executable = false, deferSecretCheck = false): ValidationIssue[] {
  const issues: ValidationIssue[] = environmentVariableIssues(flow,executable,deferSecretCheck), ids = allNodes(flow).map(n => n.id)
  if(ids.some(id=>id==='env'||id==='sys'))issues.push({message:'节点身份不能占用 env/sys 保留命名空间'})
  if (new Set(ids).size !== ids.length) issues.push({message:'节点身份重复（包括子流程）'})
  if (new Set(flow.notes.map(n => n.id)).size !== flow.notes.length) issues.push({message:'便签身份重复'})
  const subAgents=flow.subAgents??[]
  if(new Set(subAgents.map(agent=>agent.id)).size!==subAgents.length)issues.push({message:'子 Agent 身份重复'})
  if(new Set(subAgents.map(agent=>agent.number)).size!==subAgents.length)issues.push({message:'子 Agent 编号重复'})
  if(new Set(subAgents.map(agent=>agent.name)).size!==subAgents.length)issues.push({message:'同一工作流中的子 Agent 名称重复'})
  const canvasNodeIds = new Set(flow.nodes.map(n=>n.id))
  for(const note of flow.notes) if(note.anchorNodeId&&!canvasNodeIds.has(note.anchorNodeId)) issues.push({message:`便签 ${note.id} 连接了当前画布不存在的节点`})
  function inspect(graph: NodeGraph, inLoop = false): void {
    const nodes = new Map(graph.nodes.map(n => [n.id,n])), inputs = graph.nodes.filter(n => n.kind === 'input')
    if (executable && inputs.length !== 1) issues.push({message:'运行时每层图必须有且只有一个用户输入节点'})
    if (new Set(graph.edges.map(e => e.id)).size !== graph.edges.length) issues.push({message:'连线身份重复'})
    const pairs = new Set<string>()
    for (const edge of graph.edges) {
      const source = nodes.get(edge.source), target = nodes.get(edge.target)
      if (!source || !target) { issues.push({message:'连线引用了不存在的节点（跨容器请使用输出变量）'}); continue }
      const pair = JSON.stringify([edge.source,edge.target,edge.port ?? 'default'])
      if (pairs.has(pair)) issues.push({message:'存在重复连线'}); pairs.add(pair)
      if (target.kind === 'input') issues.push({nodeId:target.id,message:'用户输入节点不能有上游连线'})
      const ports = source.kind === 'if' ? source.config.logicGate ? ['true','false'] : source.config.cases?.length ? [...source.config.cases.map(c => c.id),'false'] : ['true','false'] : source.kind === 'classifier' ? source.config.classes?.map(c=>c.id) ?? [] : source.kind === 'human' ? ['default','timeout',...(source.config.actions?.map(a=>a.id) ?? ['continue'])] : ['default']
      if (!ports.includes(edge.port ?? 'default')) issues.push({nodeId:source.id,message:source.kind==='if'&&!source.config.cases?.length?'条件节点的连线须选择 true 或 false 出口':`连线出口无效，可选：${ports.join('、')}`})
    }
    try { topologicalNodes(graph) } catch { issues.push({message:'图存在循环连线，请使用循环节点容器'}) }
    const reachable = new Set(inputs.map(n=>n.id)); let changed=true
    while(changed) {changed=false; for(const edge of graph.edges) if(reachable.has(edge.source)&&!reachable.has(edge.target)){reachable.add(edge.target);changed=true}}
    for(const node of graph.nodes) {
      const c=node.config, issue=(message:string)=>issues.push({nodeId:node.id,message})
      if(node.kind==='agent'&&Object.hasOwn(c,'rolePresetId'))issue('Agent 节点不再支持 rolePresetId；请使用 workflow.subAgents 与 config.subagentId')
      if(executable&&node.kind==='agent'&&!c.subagentId)issue('请选择或创建此节点的子 Agent')
      if(node.kind==='agent'&&c.subagentId){
        const definition=subAgents.find(agent=>agent.id===c.subagentId)
        if(executable&&!definition)issue('子 Agent 定义缺失，请在子 Agent 卡片选择或创建')
        // Role text is literal, not a variable template. Reject apparent Secret
        // interpolation explicitly so a user cannot mistake it for raw access.
        for(const match of (definition?.prompt??'').matchAll(/\{\{\s*env(?:\.([A-Za-z0-9_-]+)|\[['"]([A-Za-z0-9_-]+)['"]\])\s*\}\}/g)){
          const variable=flow.environmentVariables?.find(value=>value.id===(match[1]??match[2]))
          if(variable?.type==='secret')issue(`子 Agent 角色提示词不能读取 Secret「${variable.name}」；请通过受控操作引用`)
        }
      }
      if(executable&&[...(c.verification?.requiredFiles??[]),...(c.verification?.requiredReadFiles??[]),...(c.verification?.requiredChangedFiles??[])].some(path=>path.startsWith('__WORKFLOW_FILE_REBIND_REQUIRED__/')))issue('文件验收依赖尚未映射到当前工作区，请重新选择必需文件')
      if(node.kind==='template'&&(Object.keys(c.inputs??{}).some(name=>name==='sys'||name==='env')||/\{%\s*for\s+(?:sys|env)\s+in\s/.test(c.text??'')))issue('模板局部变量不能覆盖环境变量或系统变量命名空间')
      if(['iteration','list'].includes(node.kind)){
        const source=(node.kind==='iteration'?c.iterator:c.listSource)?.replace(/^\{\{\s*|\s*\}\}$/g,'').trim()
        if(source?.startsWith('env.')||source?.startsWith('sys.'))issue('环境变量和系统变量均为标量，不能作为数组迭代来源')
      }
      if(node.kind==='assigner'&&c.assignments?.some(a=>a.name==='sys'||a.name==='env'))issue('环境变量和系统变量只读，不能通过赋值节点覆盖')
      if(node.kind==='loop'&&Object.keys(c.initialVariables??{}).some(name=>name==='sys'||name==='env'))issue('容器局部变量不能覆盖 env/sys 保留命名空间')
      if(executable&&!reachable.has(node.id)) issue('节点未连接到用户输入入口')
      if(['input','human'].includes(node.kind)) {
        if(new Set(c.fields?.map(f=>f.name)).size!==(c.fields?.length??0)) issue('输入字段名称重复')
        if(c.fields?.some(f=>f.hidden&&f.required)) issue('隐藏字段不能同时必填')
      }
      if(executable&&['llm','agent','classifier','extractor'].includes(node.kind)&&!c.model) issue('请选择此节点的模型')
      if(node.kind==='if'&&c.logicGate){try{validateLogicGate(c.logicGate)}catch(error){issue(error instanceof Error?error.message:String(error))}if(c.cases?.length)issue('逻辑门与多条件分支不能同时配置')}
      if(executable&&node.kind==='if'&&!c.logicGate&&!c.cases?.length&&!c.variable?.trim()) issue('条件节点尚未选择变量')
      if(executable&&node.kind==='classifier'&&!c.classes?.length) issue('请至少配置一个类别')
      if(node.kind==='if'&&c.cases?.length){
        // Cases share one port namespace with the fallback exit.
        if(new Set(c.cases.map(x=>x.id)).size!==c.cases.length) issue('条件分支身份重复')
        const reserved=c.cases.filter(x=>RESERVED_IF_PORTS.includes(x.id)).map(x=>x.id)
        if(reserved.length) issue(`条件分支身份不能使用保留出口名：${[...new Set(reserved)].join('、')}`)
      }
      if(node.kind==='classifier'&&new Set(c.classes?.map(x=>x.id)).size!==c.classes?.length) issue('分类出口身份重复')
      if(node.kind==='human'&&new Set(c.actions?.map(x=>x.id)).size!==c.actions?.length) issue('人工操作身份重复')
      if(node.kind==='exit_loop'&&!inLoop) issue('退出循环只能放在循环内部')
      if(executable&&['iteration','loop'].includes(node.kind)&&!c.body) issue('请配置可执行子流程')
      if(executable&&node.kind==='iteration'&&(!c.iterator||!c.outputVariable)) issue('请选择迭代数组和输出变量')
      if(executable&&node.kind==='list'&&!c.listSource) issue('请选择列表变量')
      if(node.kind==='http'&&c.credentialOperation){
        const variable=flow.environmentVariables?.find(item=>item.id===c.credentialOperation!.secretVariableId)
        if(variable?.type!=='secret')issue('受控凭据操作须选择当前工作流已声明的 Secret 环境变量')
      }
      if(executable&&node.kind==='http'&&!c.credentialOperation&&!c.url) issue('请填写请求 URL')
      if(executable&&node.kind==='tool'&&!c.toolId) issue('请选择具体工具')
      if(executable&&node.kind==='code'&&!c.code?.trim()) issue('请填写代码')
      if(executable&&node.kind==='aggregator'&&!c.groups?.length) issue('请配置聚合组')
      if(executable&&node.kind==='document'&&!c.source) issue('请选择文件来源')
      if(executable&&node.kind==='document'&&c.documentMode==='tool'&&!c.toolId) issue('请选择文档解析工具')
      if(executable&&node.kind==='document'&&c.documentMode==='agent') {
        if(!c.model) issue('请配置 DSH 默认模型或选择文档解析模型')
        if(!c.tools?.length) issue('请为文档 Agent 选择至少一个能读取文件的工具')
      }
      if(c.body) inspect(c.body,inLoop||node.kind==='loop')
    }
  }
  inspect(flow)
  const references=referenceScopeIssues(flow)
  issues.push(...(executable?references:references.filter(issue=>issue.message.includes('环境变量')||issue.message.includes('系统变量')||issue.message.includes('Secret'))))
  return issues
}
export function assertGraph(flow: Workflow, executable = false, deferSecretCheck = false): void {
  const issues=graphIssues(flow,executable,deferSecretCheck)
  if(issues.length) throw new Error(issues.map(i=>`${i.nodeId?`${i.nodeId}: `:''}${i.message}`).join('\n'))
}
export function topologicalNodes(flow: NodeGraph): WorkflowNode[] {
  const pending=new Map(flow.nodes.map(n=>[n.id,0]))
  for(const edge of flow.edges) if(pending.has(edge.target)&&pending.has(edge.source)) pending.set(edge.target,pending.get(edge.target)!+1)
  const queue=flow.nodes.filter(n=>pending.get(n.id)===0),result:WorkflowNode[]=[]
  for(let i=0;i<queue.length;i++) {const node=queue[i]!;result.push(node);for(const edge of flow.edges.filter(e=>e.source===node.id)){if(!pending.has(edge.target))continue;const count=pending.get(edge.target)!-1;pending.set(edge.target,count);if(count===0)queue.push(flow.nodes.find(n=>n.id===edge.target)!)}}
  if(result.length!==flow.nodes.length)throw new Error('图存在循环')
  return result
}

/** Agent cannot edit fixed node semantics, remove it, reroute its incident edges or introduce a new bypass. */
export function protectFixedNodes(before: Workflow, after: Workflow): void {
  const hasFixed = (n: WorkflowNode): boolean => n.fixed || !!n.config.body && allNodes(n.config.body).some(child => child.fixed)
  const executionConfig = (config: WorkflowNode["config"]): unknown => ({ ...config, ...(config.body ? { body: { ...config.body, nodes: config.body.nodes.map(({ note: _note, ...node }) => ({ ...node, config: executionConfig(node.config) })) } } : {}) })
  const semantics = (n: WorkflowNode, whole: boolean) => { const { body, ...outer } = n.config; return JSON.stringify({ kind: n.kind, title: n.title, fixed: n.fixed, config: whole ? executionConfig(n.config) : outer }) }
  for (const node of before.nodes.filter(hasFixed)) {
    const next = after.nodes.find(n => n.id === node.id)
    if (!next || semantics(node, node.fixed) !== semantics(next, node.fixed)) throw new Error(`节点 ${node.number} 已固定，请由用户在画布中修改或解除固定`)
    for(const protectedNode of allNodes({nodes:[node],edges:[]}))if(protectedNode.config.subagentId){
      const id=protectedNode.config.subagentId
      if(JSON.stringify(before.subAgents?.find(agent=>agent.id===id))!==JSON.stringify(after.subAgents?.find(agent=>agent.id===id)))throw new Error(`固定节点 ${node.number} 引用的子 Agent 定义不能由 Agent 修改`)
    }
    for(const variable of before.environmentVariables??[])if(referencesEnvironmentVariable(node,variable.id)&&JSON.stringify(variable)!==JSON.stringify(after.environmentVariables?.find(item=>item.id===variable.id)))throw new Error(`固定节点 ${node.number} 引用的环境变量不能由 Agent 修改`)
    const incident = (flow: Workflow) => flow.edges.filter(e => e.source === node.id || e.target === node.id).map(e => JSON.stringify([e.source, e.target, e.port ?? 'default'])).sort()
    if (JSON.stringify(incident(before)) !== JSON.stringify(incident(after))) throw new Error(`不能改变固定节点 ${node.number} 的连接关系`)
    const bypass = (flow: Workflow): Set<string> => {
      const reached = new Set(flow.nodes.filter(n => n.kind === 'input' && n.id !== node.id).map(n => n.id))
      let changed = true
      while (changed) { changed = false; for (const e of flow.edges) if (e.target !== node.id && reached.has(e.source) && !reached.has(e.target)) { reached.add(e.target); changed = true } }
      return reached
    }
    const oldBypass = bypass(before), newBypass = bypass(after)
    if (before.nodes.some(n => n.kind !== 'input' && n.id !== node.id && !oldBypass.has(n.id) && newBypass.has(n.id))) throw new Error(`不能新增绕过固定节点 ${node.number} 的路径`)
    // A new effectful node must be dominated by the fixed node, unless it runs
    // ahead of it on a path that still leads into the fixed node.
    const feedsFixed = new Set([node.id]); let grown = true
    while (grown) { grown = false; for (const e of after.edges) if (feedsFixed.has(e.target) && !feedsFixed.has(e.source)) { feedsFixed.add(e.source); grown = true } }
    const previous = new Map(allNodes(before).map(n => [n.id, n]))
    for (const n of after.nodes) if (newBypass.has(n.id) && introducesEffect(n, previous) && (n.kind === 'output' || !feedsFixed.has(n.id)))
      throw new Error(n.kind === 'output' ? `不能新增绕过固定节点 ${node.number} 的输出` : `不能新增绕过固定节点 ${node.number} 的动作节点 ${n.number}`)
  }
  for (const node of before.nodes) if (node.config.body && allNodes(node.config.body).some(n => n.fixed)) {
    const next = after.nodes.find(n => n.id === node.id)
    if (!next?.config.body) throw new Error(`不能删除包含固定节点的容器 ${node.number}`)
    protectFixedNodes({ ...before, ...node.config.body, notes: [] }, { ...after, ...next.config.body, notes: [] })
  }

}
