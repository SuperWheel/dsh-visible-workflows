import { layoutPlanningCandidate } from './planning-layout.ts'
import { z } from 'zod'
import { assertObjectJsonSchema, validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { NODE_LABELS, type EnvironmentVariable, type InputField, type NodeConfig, type NodeGraph, type Workflow, type WorkflowNode } from './types.ts'
import { ATTACHMENT_READ_RULE, ATTACHMENT_SHAPE, NODE_SEMANTICS } from './workflow-semantics.ts'
import { allNodes, workflowModuleInstanceSchema, environmentVariableSchema, graphIssues, parseWorkflow, protectFixedNodes } from './workflow-validation.ts'
import { dataInterpolationReferences, referenceScopeIssues, referencesEnvironmentVariable } from './reference-scope.ts'
import { normalizePlanningWorkflowNumbers } from './numbering.ts'
import type { PlanningContext, PlanningGraphProjection, PlanningIssue, PlanningProjection } from './planning-types.ts'
import { planningToolPreconditionIssues, planningNativeFileWriteIssues } from './planning-tool-preconditions.ts'
import { planningReviewIssues } from './planning-review.ts'
import { planningTemplateSyntaxIssues } from './planning-template-syntax.ts'

const identity = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const projectedNode = z.object({ id: identity, kind: z.enum(Object.keys(NODE_LABELS) as [WorkflowNode['kind'], ...WorkflowNode['kind'][]]), title: z.string().min(1).max(200), note: z.string().max(2000).nullable().optional(), config: z.record(z.string(), z.unknown()) }).strict()
const projectedGraph = z.object({ nodes: z.array(projectedNode).min(1).max(200), edges: z.array(z.object({ source: identity, target: identity, port: identity.optional() }).strict()).max(1000) }).strict()
const projectionSchema = projectedGraph.extend({
  moduleInstances:z.array(workflowModuleInstanceSchema).max(200).optional(),
  title: z.string().min(1).max(200), description: z.string().max(10_000),
  subAgents: z.array(z.object({ id: identity, name: z.string().trim().min(1).max(100), prompt: z.string().max(100_000) }).strict()).max(500).optional(),
  environmentVariables: z.array(z.unknown()).max(200).optional(),
}).strict()

const clone = <T>(value: T): T => structuredClone(value)
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => equal(item, b[index]))
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && equal(left[key], right[key]))
}
const graphProjection = (graph: NodeGraph): PlanningGraphProjection => ({
  nodes: graph.nodes.map(node => {
    const { body, ...config } = clone(node.config)
    return { id: node.id, kind: node.kind, title: node.title, ...(node.note === undefined ? {} : { note: node.note }), config: { ...config, ...(body ? { body: graphProjection(body) } : {}) } }
  }),
  edges: graph.edges.map(({ source, target, port }) => ({ source, target, ...(port === undefined ? {} : { port }) })),
})

/** The editable projection has no authority, layout, execution budget or local bindings. */
export function projectWorkflow(flow: Workflow): PlanningProjection {
  return {
    title: flow.title, description: flow.description, ...graphProjection(flow),
    ...(flow.moduleInstances===undefined?{}:{moduleInstances:clone(flow.moduleInstances)}),
    ...(flow.subAgents === undefined ? {} : { subAgents: flow.subAgents.map(({ id, name, prompt }) => ({ id, name, prompt })) }),
    ...(flow.environmentVariables === undefined ? {} : { environmentVariables: flow.environmentVariables.map(({ revision: _, ...variable }) => clone(variable)) }),
  }
}

function inspectJson(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error('规划图 JSON 嵌套超过 32 层')
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('规划图包含不安全字段')
    inspectJson(child, depth + 1)
  }
}
const edgeKey = (edge: { source: string; target: string; port?: string }): string => JSON.stringify([edge.source, edge.target, edge.port ?? 'default'])

/** Materialization is deterministic and never runs node code or reads the clock. */
export function materializePlanningCandidate(graphJson: string, context: PlanningContext): Workflow {
  if (new TextEncoder().encode(graphJson).byteLength > 2_000_000) throw new Error('规划图最多 2 MB')
  const raw: unknown = JSON.parse(graphJson)
  inspectJson(raw)
  const projected = projectionSchema.parse(raw)
  const baseline = context.workflow
  const baselineNodes = new Map(allNodes(baseline).map(node => [node.id, node]))
  const allowedNodeIds = new Set([...baselineNodes.keys(), ...context.nodeIds])
  const existingEdgeIds = new Set<string>()
  const collectEdges = (graph: NodeGraph): void => { for (const edge of graph.edges) existingEdgeIds.add(edge.id); for (const node of graph.nodes) if (node.config.body) collectEdges(node.config.body) }
  collectEdges(baseline)
  let edgeNumber = 0, nodeCount = 0
  const nextEdge = (): string => { let id: string; do { id = `planning-edge-${++edgeNumber}` } while (existingEdgeIds.has(id)); existingEdgeIds.add(id); return id }
  const materializeGraph = (value: unknown, oldGraph?: NodeGraph, depth = 0): NodeGraph => {
    if (depth > 5) throw new Error('子流程嵌套不能超过 5 层')
    const graph = projectedGraph.parse(value)
    return {
      nodes: graph.nodes.map((node, index): WorkflowNode => {
        if (++nodeCount > 500) throw new Error('一个工作流最多 500 个节点（含子流程）')
        if (!allowedNodeIds.has(node.id)) throw new Error(`UNALLOCATED_NODE_ID: ${node.id}`)
        const previous = baselineNodes.get(node.id)
        const { body, ...config } = node.config
        return {
          id: node.id, kind: node.kind, title: node.title,
          ...((node.note === undefined ? previous?.note : node.note) == null ? {} : { note: (node.note === undefined ? previous?.note : node.note)! }),
          x: previous?.x ?? 0, y: previous?.y ?? 0,
          fixed: previous?.fixed ?? false, number: previous?.number ?? `u-${index + 1}`,
          config: { ...config, ...(body === undefined ? {} : { body: materializeGraph(body, previous?.config.body, depth + 1) }) } as NodeConfig,
        }
      }),
      edges: graph.edges.map(edge => ({ ...edge, id: oldGraph?.edges.find(old => edgeKey(old) === edgeKey(edge))?.id ?? nextEdge() })),
    }
  }
  const subAgents = projected.subAgents?.map((definition, index) => {
    const previous = baseline.subAgents?.find(item => item.id === definition.id)
    if (!previous && !context.subagentIds.includes(definition.id)) throw new Error(`UNALLOCATED_SUBAGENT_ID: ${definition.id}`)
    const maxNumber = Math.max(0, ...(baseline.subAgents ?? []).map(item => Number(item.number.slice(6))))
    return { ...previous, ...definition, number: previous?.number ?? `agent-${maxNumber + index + 1}` }
  })
  const environmentVariables = projected.environmentVariables?.map(value => {
    if (value && typeof value === 'object' && Object.hasOwn(value, 'revision')) throw new Error('模型不能设置环境变量 revision')
    const variable = environmentVariableSchema.parse(value)
    const previous = baseline.environmentVariables?.find(item => item.id === variable.id)
    if (!previous && !context.environmentIds.includes(variable.id)) throw new Error(`UNALLOCATED_ENVIRONMENT_ID: ${variable.id}`)
    return { ...variable, ...(previous?.revision === undefined ? {} : { revision: previous.revision }) } as EnvironmentVariable
  })
  const graph = materializeGraph({ nodes: projected.nodes, edges: projected.edges }, baseline)
  const candidate: Workflow = { ...clone(baseline), ...graph, title: projected.title, description: projected.description }
  if(projected.moduleInstances!==undefined)candidate.moduleInstances=projected.moduleInstances
  if (subAgents !== undefined) candidate.subAgents = subAgents
  if (environmentVariables !== undefined) candidate.environmentVariables = environmentVariables
  // Editing annotations are Host-owned. Remove only references whose authorized deletion
  // will be checked below; preserve their prose and every still-valid attachment.
  const ids = new Set(allNodes(candidate).map(node => node.id))
  const validPath = (path: string[]): boolean => { let current: NodeGraph = candidate; for (const id of path) { const node = current.nodes.find(item => item.id === id); if (!node?.config.body) return false; current = node.config.body } return true }
  if (candidate.editor) {
    if (candidate.editor.scopePath && !validPath(candidate.editor.scopePath)) delete candidate.editor.scopePath
    for (const annotation of candidate.editor.annotations ?? []) {
      annotation.nodeIds = annotation.nodeIds.filter(id => ids.has(id))
      if (annotation.position && !validPath(annotation.position.scopePath)) delete annotation.position
    }
  }
  return normalizePlanningWorkflowNumbers(layoutPlanningCandidate(parseWorkflow(candidate), baseline, context.operation), baseline)
}

const semantic = (node: WorkflowNode): unknown => { const { body, ...config } = node.config; return { kind: node.kind, title: node.title, note: node.note, fixed: node.fixed, config, hasBody: !!body } }
function scopedIssues(candidate: Workflow, context: PlanningContext): PlanningIssue[] {
  if (context.operation !== 'revise') return []
  const issues: PlanningIssue[] = [], before = parseWorkflow(context.workflow), oldNodes = allNodes(before), nextNodes = allNodes(candidate)
  const next = new Map(nextNodes.map(node => [node.id, node])), allowed = new Set(context.targetNodeIds)
  const report = (message: string, nodeId?: string): void => { issues.push({ code: 'TARGET_SCOPE_VIOLATION', message, ...(nodeId ? { nodeId } : {}) }) }
  for (const id of context.targetNodeIds) {
    const node = oldNodes.find(item => item.id === id)
    if (!node) report(`指定节点 ${id} 不在可信基线中`, id)
    if (node?.config.body) for (const child of allNodes(node.config.body)) allowed.add(child.id)
  }
  for (const old of oldNodes) {
    const changed = next.get(old.id)
    if (!changed && !allowed.has(old.id)) report('删除节点须在请求中明确指定目标范围', old.id)
    else if (changed && context.targetNodeIds.length && !allowed.has(old.id) && !equal(semantic(old), semantic(changed))) report('不能修改目标范围外节点', old.id)
  }
  if (!context.targetNodeIds.length) return issues
  const locations = (graph: NodeGraph, path = '', map = new Map<string, string>()): Map<string, string> => {
    for (const node of graph.nodes) { map.set(node.id, path); if (node.config.body) locations(node.config.body, `${path}/${node.id}`, map) } return map
  }
  const oldLocations = locations(before), nextLocations = locations(candidate)
  for (const old of oldNodes) if (next.has(old.id) && !allowed.has(old.id) && oldLocations.get(old.id) !== nextLocations.get(old.id)) report('不能移动目标范围外节点到其他容器', old.id)
  if (candidate.title !== before.title || candidate.description !== before.description) report('节点范围修改不能同时改写工作流名称或说明')
  const outside = oldNodes.filter(node => !allowed.has(node.id))
  for (const definition of before.subAgents ?? []) if (!equal(definition, candidate.subAgents?.find(item => item.id === definition.id)) && outside.some(node => node.config.subagentId === definition.id)) report('共享角色仍被目标范围外节点引用，不能修改或删除')
  for (const variable of before.environmentVariables ?? []) if (!equal(variable, candidate.environmentVariables?.find(item => item.id === variable.id)) && outside.some(node => referencesEnvironmentVariable(node, variable.id))) report('环境变量仍被目标范围外节点引用，不能修改或删除')
  const oldIds = new Set(oldNodes.map(node => node.id)), editable = (id: string): boolean => allowed.has(id) || !oldIds.has(id)
  const visit = (graph: NodeGraph, path = ''): string[] => [...graph.edges.filter(edge => !editable(edge.source) && !editable(edge.target)).map(edge => `${path}:${edgeKey(edge)}`), ...graph.nodes.flatMap(node => node.config.body ? visit(node.config.body, `${path}/${node.id}`) : [])]
  if (!equal(visit(before).sort(), visit(candidate).sort())) report('不能修改目标范围外节点之间的连线')
  return issues
}

function inputFieldType(field: InputField): string | undefined {
  // Empty optional inputs remain '', including number/boolean/file fields.
  const type = field.type ?? 'text'
  if (['text', 'paragraph', 'select'].includes(type)) return 'string'
  if (!field.required) return undefined
  return type === 'number' || type === 'boolean' ? type : type === 'file' ? 'object' : type === 'files' ? 'array' : undefined
}

/** Runtime output types, shared by reference validation and chain exports.
 * A name alone never grants a type; wrapper precedence follows runtime.ts and
 * execution-adapters.ts/native-agent.ts. Unknown/dynamic values stay unknown.
 */
export function planningNodeOutputType(node: Pick<WorkflowNode, 'kind' | 'config'>, field: string, toolOutputs?: PlanningContext['toolOutputs']): string | undefined {
  const { kind, config } = node
  const declared = (fields: NodeConfig['outputSchema']): string | undefined => {
    const item = fields?.find(item => item.name === field)
    return item && item.required !== false ? item.type : undefined
  }
  switch (kind) {
    case 'input': {
      // Unlike LLM wrappers, scope.input is spread AFTER the default text.
      const item = config.fields?.find(item => item.name === field)
      return item ? inputFieldType(item) : field === 'text' ? 'string' : undefined
    }
    case 'human': {
      if (['text', '__action_id', '__action_value', '__rendered_content'].includes(field)) return 'string'
      const item = config.fields?.find(item => item.name === field)
      return item ? inputFieldType(item) : undefined
    }
    case 'llm':
      if (field === 'text') return 'string'
      if (field === 'json') return config.outputSchema?.length ? 'object' : undefined
      return declared(config.outputSchema)
    case 'agent':
      if (field === 'text') return 'string'
      if (field === 'json') return 'object'
      if (field === 'steps') return 'number'
      if (field === 'repair_attempts') return undefined // Only present after repair.
      return declared(config.outputSchema)
    case 'extractor':
      if (field === 'text' || field === '__reason') return 'string'
      if (field === '__is_success') return 'number'
      if (field === 'json') return 'object' // Present on successful extraction.
      return declared(config.parameters)
    case 'code':
      // main() returns its object unchanged; text/json/steps are ordinary keys.
      return declared(config.outputSchema)
    case 'tool': {
      const toolId = config.toolId ?? ''
      if (toolId.startsWith('native:')) {
        if (field === 'text') return 'string'
        const schema = toolOutputs?.contracts.find(item => item.toolId === toolId)?.guarantee.schema
        return field === 'value' && schema && typeof schema.schema.type === 'string' ? schema.schema.type : undefined
      }
      if (toolId.startsWith('workflow:')) return field === 'text' || field === 'run_id' ? 'string' : field === 'outputs' ? 'object' : undefined
      const builtin = NODE_SEMANTICS.tool.builtinTools?.find(tool => tool.toolId === toolId)
      return builtin ? /^(string|number|boolean|object|array)[:：]/.exec(builtin.outputs[field] ?? '')?.[1] : undefined
    }
    case 'template': case 'output':
      return field === 'text' ? 'string' : undefined
    case 'document':
      return field === 'text' ? 'string' : field === 'characters' ? 'number' : undefined
    case 'http':
      return config.credentialOperation ? field === 'ok' ? 'boolean' : undefined : ['text', 'body'].includes(field) ? 'string' : ['status_code', 'bytes'].includes(field) ? 'number' : field === 'headers' ? 'object' : undefined
    case 'classifier':
      return ['text', 'class_id', 'class_label', 'class_name'].includes(field) ? 'string' : undefined
    case 'knowledge':
      return field === 'text' || field === 'method' ? 'string' : field === 'count' ? 'number' : field === 'results' || field === 'result' ? 'array' : undefined
    case 'iteration':
      return field === 'text' ? 'string' : ['result', 'json', 'errors'].includes(field) ? 'array' : undefined
    case 'loop':
      return field === 'text' ? 'string' : field === 'iterations' ? 'number' : field === 'variables' ? 'object' : ['result', 'json'].includes(field) && !config.outputVariable ? 'object' : undefined
    case 'list':
      return field === 'text' ? 'string' : field === 'result' || field === 'json' ? 'array' : undefined
    case 'assigner':
      return field === 'text' ? 'string' : field === 'variables' || field === 'json' ? 'object' : undefined
    case 'aggregator':
      return field === 'text' ? 'string' : field === 'json' ? 'object' : undefined
    case 'if':
      return field === 'text' || field === 'branch' ? 'string' : field === 'result' ? 'boolean' : undefined
    default:
      return undefined
  }
}

function referenceType(expression: string, flow: Workflow, toolOutputs?: PlanningContext['toolOutputs']): string | undefined {
  const value = expression.trim().replace(/^\{\{\s*|\s*\}\}$/g, '')
  const parts = value.match(/^([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_-]+)|\[['"]([^'"]+)['"]\])$/)
  if (!parts) return undefined
  const root = parts[1], field = parts[2] ?? parts[3]
  if (root === 'env') return flow.environmentVariables?.find(item => item.id === field)?.type
  if (root === 'sys') return field === 'timestamp' ? 'number' : field === 'session_id' ? undefined : 'string'
  const node = allNodes(flow).find(item => item.id === root)
  if (node) return planningNodeOutputType(node, field, toolOutputs)
  if (root === 'input') {
    const types = new Set(allNodes(flow).filter(item => item.kind === 'input').filter(item => item.config.fields?.some(input => input.name === field)).map(item => planningNodeOutputType(item, field, toolOutputs)))
    if (types.size !== 1) return undefined
    return [...types][0]
  }
  return undefined
}
const ATTACHMENT_KEYS = new Set(['name', 'mimeType', 'size'])
const attachmentFields = (flow: Workflow) => new Set(allNodes(flow).filter(node => node.kind === 'input').flatMap(node => (node.config.fields ?? []).filter(field => field.type === 'file' || field.type === 'files').map(field => field.name)))
/** An upload is an object without a path or its text; name the reading node instead of a type mismatch alone. */
function attachmentReferenceIssues(flow: Workflow): PlanningIssue[] {
  const files = attachmentFields(flow), issues: PlanningIssue[] = []
  if (!files.size) return issues
  for (const node of allNodes(flow)) {
    // Code source is not interpolated; nested bodies are visited as their own nodes.
    const { code: _code, body: _body, ...config } = node.config
    for (const [, field, key] of JSON.stringify(config).matchAll(/(?<![\w.-])input\.([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)/g))
      if (files.has(field!) && !ATTACHMENT_KEYS.has(key!)) issues.push({ code: 'INVALID_ATTACHMENT_REFERENCE', nodeId: node.id, message: `input.${field}.${key} 不存在：${ATTACHMENT_SHAPE}${ATTACHMENT_READ_RULE}` })
  }
  return issues
}
const hasDynamic = (value: unknown): boolean => {
  if(typeof value==='string'){
    const parsed=dataInterpolationReferences(value)
    if(parsed.invalid)throw new Error('模板变量引用为空或括号不完整')
    return parsed.references.length>0
  }
  // Inspect every nested value: a valid token must not hide malformed siblings.
  return !!value&&typeof value==='object'&&Object.values(value).map(hasDynamic).some(Boolean)
}
function argumentIssues(schema: JsonSchemaNode, value: unknown, flow: Workflow, path: string, toolOutputs?: PlanningContext['toolOutputs']): string[] {
  try{if (!hasDynamic(value)) return validateJsonSchemaValue(schema, value, path)}catch(error){return [`${path} ${error instanceof Error?error.message:String(error)}`]}
  if (schema.oneOf) {
    const branches = schema.oneOf.map(branch => argumentIssues(branch, value, flow, path, toolOutputs))
    return branches.some(branch => !branch.length) ? [] : [`${path} 不符合任何工具参数分支`]
  }
  if (typeof value === 'string') {
    const whole = /^\s*\{\{[^{}]+\}\}\s*$/.test(value), actual = whole ? referenceType(value, flow, toolOutputs) : 'string'
    if (actual && schema.type && actual !== schema.type && !(['number', 'integer'].includes(actual) && ['number', 'integer'].includes(schema.type))) {
      const field = /^\s*\{\{\s*input\.([A-Za-z_][\w-]*)\s*\}\}\s*$/.exec(value)?.[1]
      return [`${path} 引用类型 ${actual} 与工具要求 ${schema.type} 不符${field && attachmentFields(flow).has(field) ? `：input.${field} 是${ATTACHMENT_SHAPE}${ATTACHMENT_READ_RULE}` : ''}`]
    }
    // No value is invented for a runtime reference. Enum/const and unknown output
    // types remain the execution adapter's responsibility after interpolation.
    return []
  }
  if (Array.isArray(value)) return schema.type && schema.type !== 'array' ? [`${path} 必须为 ${schema.type}`] : schema.items ? value.flatMap((item, index) => argumentIssues(schema.items!, item, flow, `${path}[${index}]`, toolOutputs)) : []
  if (value && typeof value === 'object') {
    if (schema.type && schema.type !== 'object') return [`${path} 必须为 ${schema.type}`]
    const record = value as Record<string, unknown>, issues: string[] = []
    for (const required of schema.required ?? []) if (!Object.hasOwn(record, required)) issues.push(`${path}.${required} 为必填项`)
    for (const [key, item] of Object.entries(record)) {
      const child = schema.properties?.[key]
      if (child) issues.push(...argumentIssues(child, item, flow, `${path}.${key}`, toolOutputs))
      else if (schema.additionalProperties === false) issues.push(`${path}.${key} 不属于工具参数`)
    }
    return issues
  }
  return validateJsonSchemaValue(schema, value, path)
}

/** Structural diagnostics are distinct from readiness; known missing resources are not hallucinated IDs. */
export function planningCandidateIssues(candidate: Workflow, context: PlanningContext): PlanningIssue[] {
  const issues: PlanningIssue[] = []
  let parsed: Workflow
  try { parsed = parseWorkflow(candidate) } catch (error) { return [{ code: 'INVALID_WORKFLOW', message: error instanceof Error ? error.message : String(error) }] }
  if (['id', 'workspaceId', 'scope', 'revision', 'createdAt', 'updatedAt', 'executionPolicy', 'budgetDecision', 'archived'].some(key => !equal((parsed as unknown as Record<string, unknown>)[key], (context.workflow as unknown as Record<string, unknown>)[key]))) issues.push({ code: 'HOST_METADATA_CHANGED', message: '候选不能改写 Host 元数据、作用范围或执行策略与历史元数据' })
  const nodeIds = new Set([...allNodes(context.workflow).map(node => node.id), ...context.nodeIds])
  for (const node of allNodes(parsed)) {
    if (!nodeIds.has(node.id)) issues.push({ code: 'UNALLOCATED_NODE_ID', nodeId: node.id, message: '新增节点身份不在 Host 预分配池内' })
    const previous = allNodes(context.workflow).find(item => item.id === node.id)
    if (node.fixed !== (previous?.fixed ?? false) || previous && (node.number !== previous.number || (context.operation !== 'create' || previous.fixed) && (node.x !== previous.x || node.y !== previous.y))) issues.push({ code: 'HOST_METADATA_CHANGED', nodeId: node.id, message: '候选不能改写节点固定状态或已有布局编号' })
  }
  for (const definition of parsed.subAgents ?? []) {
    const previous = context.workflow.subAgents?.find(item => item.id === definition.id)
    if (!previous && !context.subagentIds.includes(definition.id)) issues.push({ code: 'UNALLOCATED_SUBAGENT_ID', message: '新增子 Agent 身份不在 Host 预分配池内' })
    const localKeys = ['sessionId', 'rolePresetId', 'rolePresetRevision'] as const
    if (localKeys.some(key => definition[key] !== previous?.[key]) || previous && previous.number !== definition.number) issues.push({ code: 'HOST_METADATA_CHANGED', message: '候选不能改写子 Agent 本地绑定、预设来源或已有编号' })
  }
  for (const variable of parsed.environmentVariables ?? []) {
    const previous = context.workflow.environmentVariables?.find(item => item.id === variable.id)
    if (!previous && !context.environmentIds.includes(variable.id)) issues.push({ code: 'UNALLOCATED_ENVIRONMENT_ID', message: '新增环境变量身份不在 Host 预分配池内' })
    if (variable.revision !== previous?.revision) issues.push({ code: 'HOST_METADATA_CHANGED', message: '候选不能改写环境变量版本' })
    if (previous?.type === 'secret' && variable.type !== 'secret') issues.push({ code: 'SECRET_DECLARATION_CHANGED', message: '规划不能把已有 Secret 变为普通变量' })
  }
  issues.push(...graphIssues(parsed, false).map(issue => ({ ...issue, code: 'INVALID_GRAPH' })), ...referenceScopeIssues(parsed, { strictMissing: true }).map(issue => ({ ...issue, code: issue.code ?? 'REFERENCE_OUT_OF_SCOPE' })), ...scopedIssues(parsed, context))
  // A trial-derived graph runs once right after saving; an unbound Agent node cannot.
  if (context.trial) for (const node of allNodes(parsed)) if (node.kind === 'agent' && !(parsed.subAgents ?? []).some(agent => agent.id === node.config.subagentId)) issues.push({ code: 'UNBOUND_AGENT', nodeId: node.id, message: '试做生成的工作流保存后立即首跑，Agent 节点必须绑定子 Agent：在 roles 声明 {key,name,prompt}，节点 subagentId 填这个 key' })
  try { protectFixedNodes(parseWorkflow(context.workflow), parsed) } catch (error) { issues.push({ code: 'FIXED_NODE_CHANGED', message: error instanceof Error ? error.message : String(error) }) }
  const structural = (graph: NodeGraph): void => {
    const inputs = graph.nodes.filter(node => node.kind === 'input')
    if (inputs.length !== 1) issues.push({ code: 'INVALID_ENTRY', message: '每层规划图必须有且只有一个用户输入节点' })
    const reachable = new Set(inputs.map(node => node.id)); let changed = true
    while (changed) { changed = false; for (const edge of graph.edges) if (reachable.has(edge.source) && !reachable.has(edge.target)) { reachable.add(edge.target); changed = true } }
    for (const node of graph.nodes) {
      if (!reachable.has(node.id)) issues.push({ code: 'UNREACHABLE_NODE', nodeId: node.id, message: '节点未连接到用户输入入口' })
      if (node.config.body) structural(node.config.body)
    }
  }
  structural(parsed)
  issues.push(...attachmentReferenceIssues(parsed),...planningNativeFileWriteIssues(parsed,context),...planningToolPreconditionIssues(parsed,context),...planningReviewIssues(parsed,context),...planningTemplateSyntaxIssues(parsed,context))
  const knownBaseline = new Set(allNodes(context.workflow).flatMap(node => [node.config.toolId, ...(node.config.tools ?? [])]).filter((id): id is string => !!id))
  const catalog = new Map(context.tools.map(tool => [tool.id, tool]))
  for (const node of allNodes(parsed)) {
    for (const id of new Set([node.config.toolId, ...(node.config.tools ?? [])].filter((id): id is string => !!id))) if (!catalog.has(id) && !knownBaseline.has(id)) issues.push({ code: 'UNKNOWN_TOOL_ID', nodeId: node.id, message: `工具 ${id} 不在真实目录或基线中`, path: 'config.toolId' })
    if ((node.kind !== 'tool' && !(node.kind === 'document' && node.config.documentMode === 'tool')) || !node.config.toolId) continue
    const tool = catalog.get(node.config.toolId)
    if (!tool) continue
    try {
      assertObjectJsonSchema(tool.inputSchema)
      const inputs: Record<string, unknown> = { ...(node.config.inputs ?? {}) }
      if (node.kind === 'document') inputs[node.config.documentSourceKey ?? 'source'] = '{{input.document_source}}'
      issues.push(...argumentIssues(tool.inputSchema, inputs, parsed, 'config.inputs', context.toolOutputs).map(message => ({ code: 'INVALID_TOOL_ARGUMENTS', nodeId: node.id, message, path: 'config.inputs' })))
    } catch (error) { issues.push({ code: 'TOOL_SCHEMA_UNSUPPORTED', nodeId: node.id, message: error instanceof Error ? error.message : String(error) }) }
  }
  const seen = new Set<string>()
  return issues.filter(issue => { const key = `${issue.code}:${issue.nodeId ?? ''}:${issue.message}`; if (seen.has(key)) return false; seen.add(key); return true })
}
