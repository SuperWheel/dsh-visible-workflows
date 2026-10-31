import { verifiedModuleInstances, moduleInstanceRefs, rewriteFragmentParameters } from './planning-module-fragments.ts'
import { fragmentModules } from './planning-module-fragment-contract.ts'
import { nodeDescriptionWire, updateDescriptionWire } from './planning-node-note.ts'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { NODE_LABELS, type NodeKind, type Workflow } from './types.ts'
import { allNodes } from './workflow-validation.ts'
import type { PlannerOutput, PlanningContext, PlanningGraphProjection, PlanningIssue, PlanningProjection } from './planning-types.ts'
import { materializePlanningCandidate, planningCandidateIssues, projectWorkflow } from './planning-projection.ts'
import { parsePlannerOutput } from './planning-schema.ts'
import { optimizationEvidenceRefSchema, parseOptimizationOutput, type OptimizationOutput } from './planning-optimization.ts'
import { workflowDefinitionContent } from './workflow-content.ts'

/** Internal transport only. The persisted Workflow and PlannerOutput contracts are unchanged. */
export const PLANNING_EDIT_PROTOCOL_VERSION = 1 as const
const MAX_BYTES = 1_000_000, MAX_OPERATIONS = 200
const unsafe = new Set(['__proto__', 'constructor', 'prototype'])
const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/).refine(value => !unsafe.has(value))
const nodeRef = z.string().regex(/^(?:@[1-9]\d*|\+[A-Za-z][A-Za-z0-9_-]{0,39})$/)
const agentRef = z.string().regex(/^(?:@a[1-9]\d*|\+a:[A-Za-z][A-Za-z0-9_-]{0,39})$/)
const envRef = z.string().regex(/^(?:@e[1-9]\d*|\+e:[A-Za-z][A-Za-z0-9_-]{0,39})$/)
const identity = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const kind = z.enum(Object.keys(NODE_LABELS) as [keyof typeof NODE_LABELS, ...(keyof typeof NODE_LABELS)[]])
const title = z.string().trim().min(1).max(200)
const config = z.record(z.string(), z.unknown()).refine(value => !Object.hasOwn(value, 'body'), 'body 只能通过 scope 中的节点操作编辑')
const scope = z.array(nodeRef).max(5).optional()
const environmentFields = { name: z.string().min(1).max(80).regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine(value => !unsafe.has(value)), description: z.string().max(2000).optional(), required: z.boolean().optional() }
const edits = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add-node'), key, scope, kind, title, note: z.string().max(2000).optional(), config }).strict(),
  z.object({ op: z.literal('update-node'), node: nodeRef, scope, kind: kind.optional(), title: title.optional(), note: z.string().max(2000).nullable().optional(), configSet: config.optional(), configUnset: z.array(z.string().min(1).max(100).refine(value => !unsafe.has(value) && value !== 'body')).max(100).optional() }).strict(),
  z.object({ op: z.literal('remove-node'), node: nodeRef, scope }).strict(),
  z.object({ op: z.literal('connect'), source: nodeRef, target: nodeRef, port: identity.optional(), scope }).strict(),
  z.object({ op: z.literal('disconnect'), source: nodeRef, target: nodeRef, port: identity.optional(), scope }).strict(),
  z.object({ op: z.literal('set-workflow'), title: title.optional(), description: z.string().max(10_000).optional() }).strict(),
  z.object({ op: z.literal('add-subagent'), key, name: z.string().trim().min(1).max(100), prompt: z.string().max(100_000) }).strict(),
  z.object({ op: z.literal('update-subagent'), agent: agentRef, name: z.string().trim().min(1).max(100).optional(), prompt: z.string().max(100_000).optional() }).strict(),
  z.object({ op: z.literal('remove-subagent'), agent: agentRef }).strict(),
  z.object({ op: z.literal('add-environment'), key, type: z.enum(['string', 'number', 'secret']), ...environmentFields, value: z.union([z.string().max(100_000), z.number().finite()]).optional() }).strict(),
  z.object({ op: z.literal('update-environment'), variable: envRef, ...environmentFields, name: environmentFields.name.optional(), value: z.union([z.string().max(100_000), z.number().finite()]).optional() }).strict(),
  z.object({ op: z.literal('remove-environment'), variable: envRef }).strict(),
])
const question = z.object({ id: identity, question: z.string().trim().min(1).max(4000), options: z.array(z.string().min(1).max(1000)).max(8).default([]) }).strict()
const coverage = z.object({ requirementId: identity, nodeIds: z.array(nodeRef).max(500), note: z.string().max(4000).default('') }).strict()
// This entry point has one internal wire contract. Omission means that contract;
// an explicit incompatible version must never be silently migrated or coerced.
const envelope = { protocolVersion: z.literal(1).default(1), baseDigest: z.string().regex(/^[a-f0-9]{64}$/), summary: z.string().trim().max(10_000).optional() }
const authorSchema = z.object({
  ...envelope, outcome: z.enum(['candidate', 'needs-input']), edits: z.array(edits).max(MAX_OPERATIONS).default([]),
  assumptions: z.array(z.string().max(4000)).max(50).default([]), questions: z.array(question).max(3).default([]), requirementCoverage: z.array(coverage).max(100).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.outcome === 'needs-input' && (!value.questions.length || value.edits.length || value.requirementCoverage.length)) ctx.addIssue({ code: 'custom', message: 'needs-input 必须有真实问题，不能携带修改或覆盖结论' })
  if (value.outcome === 'candidate' && value.questions.length) ctx.addIssue({ code: 'custom', message: 'candidate 不能携带阻塞问题' })
})
// Trusted compact declarations may expand to many small operations; the legacy model wire stays at 200.
const expandedAuthorSchema=authorSchema.safeExtend({edits:z.array(edits).max(2000).default([])})
const evidenceCase = z.object({
  id: identity, workflowInputs: optimizationEvidenceRefSchema.optional(),
  upstreamOutputs: z.record(nodeRef, optimizationEvidenceRefSchema).refine(value => Object.keys(value).length <= 20).optional(), expected: optimizationEvidenceRefSchema,
}).strict()
const optimizerSchema = z.object({
  ...envelope, outcome: z.enum(['candidate', 'unchanged']), replacements: z.array(z.object({
    node: nodeRef, kind, config, reason: z.string().trim().min(1).max(4000), evidenceCases: z.array(evidenceCase).max(20).default([]),
  }).strict()).max(20).default([]),
}).strict().superRefine((value, ctx) => {
  if ((value.outcome === 'candidate') !== (value.replacements.length > 0)) ctx.addIssue({ code: 'custom', message: '优化 candidate 必须声明替换，unchanged 不能携带替换' })
  if (value.replacements.reduce((total, replacement) => total + replacement.evidenceCases.length, 0) > 20) ctx.addIssue({ code: 'custom', message: '最多 20 条回归证据' })
})
export type PlanningEdits = z.infer<typeof authorSchema>
export type OptimizationEdits = z.infer<typeof optimizerSchema>

/** Inspect before schema parsing or object assignment; objects from tools are not trusted JSON. */
function checkedJson(value: unknown): unknown {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > MAX_BYTES) throw new Error('EDIT_SIZE_LIMIT: 编辑意图最多 1 MB')
    value = JSON.parse(value)
  }
  let entries = 0
  const visit = (item: unknown, depth: number): void => {
    if (++entries > 100_000 || depth > 32) throw new Error('EDIT_DEPTH_LIMIT: 编辑意图过深或过大')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object') throw new Error('EDIT_INVALID_JSON: 编辑意图必须为 JSON')
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null && !Array.isArray(item)) throw new Error('EDIT_INVALID_JSON: 只接受普通 JSON 对象')
    for (const name of Object.keys(item)) {
      if (unsafe.has(name)) throw new Error('EDIT_UNSAFE_KEY: 编辑意图包含不安全字段')
      const descriptor = Object.getOwnPropertyDescriptor(item, name)!
      if (!('value' in descriptor)) throw new Error('EDIT_INVALID_JSON: 不接受访问器')
      visit(descriptor.value, depth + 1)
    }
  }
  visit(value, 0)
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw new Error('EDIT_SIZE_LIMIT: 编辑意图最多 1 MB')
  return value
}
export const parsePlanningEdits = (value: unknown): PlanningEdits => authorSchema.parse(checkedJson(value))
export const parseOptimizationEdits = (value: unknown): OptimizationEdits => optimizerSchema.parse(checkedJson(value))

/** Canonical content includes Host identity, layout and protected fields, but excludes view navigation. */
export const planningEditDigest = (base: Workflow): string => createHash('sha256').update(workflowDefinitionContent(base)).digest('hex')
export interface PlanningAliases { nodes: Map<string, string>; agents: Map<string, string>; environment: Map<string, string> }
type Aliases = PlanningAliases
function aliases(base: Workflow): Aliases {
  const result: Aliases = { nodes: new Map(), agents: new Map(), environment: new Map() }
  const visit = (graph: PlanningGraphProjection): void => { for (const node of graph.nodes) { result.nodes.set(`@${result.nodes.size + 1}`, node.id); if (node.config.body) visit(node.config.body) } }
  visit(projectWorkflow(base))
  for (const agent of base.subAgents ?? []) result.agents.set(`@a${result.agents.size + 1}`, agent.id)
  for (const variable of base.environmentVariables ?? []) result.environment.set(`@e${result.environment.size + 1}`, variable.id)
  return result
}
function resolve(map: Map<string, string>, ref: string): string {
  const id = map.get(ref)
  if (id === undefined) throw new Error(`EDIT_UNKNOWN_REFERENCE: ${ref}`)
  return id
}
const reverse = (map: Map<string, string>): Map<string, string> => new Map([...map].map(([ref, id]) => [id, ref]))
/** Host-only mapping for diagnostics and evidence links; do not send the ID pool to a model. */
export const planningNodeRefs = (base: Workflow): ReadonlyMap<string, string> => reverse(aliases(base).nodes)
function selectorPath(kind: NodeKind, path: string): boolean {
  if (kind === 'if') return path === 'variable' || /^cases\.\d+\.conditions\.\d+\.variable$/.test(path)
  if (kind === 'aggregator') return /^groups\.\d+\.variables\.\d+$/.test(path)
  if (kind === 'document') return path === 'source'
  if (kind === 'iteration') return path === 'iterator' || path === 'outputVariable'
  if (kind === 'list') return path === 'listSource' || path === 'filter.variable'
  if (kind === 'loop') return path === 'outputVariable' || path === 'until.variable'
  return false
}
function interpolationPath(kind: NodeKind, path: string): boolean {
  if (path.startsWith('inputs.')) return true
  if (['template', 'output'].includes(kind) && path === 'text') return true
  if (['llm', 'agent', 'classifier', 'extractor', 'document', 'human'].includes(kind) && path === 'prompt') return true
  if (kind === 'knowledge' && path === 'query') return true
  if (kind === 'human' && /^fields\.\d+\.defaultValue$/.test(path)) return true
  if (kind === 'if' && (path === 'value' || /^cases\.\d+\.conditions\.\d+\.value$/.test(path) || /^logicGate\.inputs\.\d+\.value(?:\.|$)/.test(path))) return true
  if (kind === 'assigner' && /^assignments\.\d+\.value(?:\.|$)/.test(path)) return true
  if (kind === 'http' && (['url', 'bodyText'].includes(path) || path.startsWith('headers.'))) return true
  if (kind === 'list' && path === 'filter.value') return true
  if (kind === 'loop' && (path === 'until.value' || path.startsWith('initialVariables.'))) return true
  return selectorPath(kind, path)
}
/** The small template grammar mirrors reference-scope.ts: quoted literals and
 * brackets are opaque when splitting conditions, filters and filter arguments. */
function splitExpression(source: string, separator: string): string[] {
  const parts: string[] = []; let start = 0, depth = 0, quote = '', escaped = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    if (quote) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if ('([{'.includes(char)) depth++
    if (')]}'.includes(char)) depth--
    if (!depth && source.slice(index, index + separator.length) === separator) { parts.push(source.slice(start, index)); start = index + separator.length; index += separator.length - 1 }
  }
  parts.push(source.slice(start)); return parts
}
export type PlanningReferenceRewriter = (reference: string) => string
/** Conservative syntax proof used only by the local-reference scan copy. */
function reliableTemplateExpression(source: string): boolean {
  const text = source.trim(), stack: string[] = []
  let quote = '', escaped = false
  if (!text) return false
  for (const char of text) {
    if (quote) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if ('([{'.includes(char)) stack.push(char)
    else if (')]}'.includes(char) && stack.pop() !== ({ ')': '(', ']': '[', '}': '{' } as Record<string,string>)[char]) return false
  }
  if (quote || escaped || stack.length) return false
  for (const separator of [' or ', ' and ', ' == ', ' != ', ' >= ', ' <= ', ' > ', ' < ', ' in ']) {
    const parts = splitExpression(text, separator)
    if (parts.length > 1) return parts.every(reliableTemplateExpression)
  }
  if (text.startsWith('not ')) return reliableTemplateExpression(text.slice(4))
  if (text.endsWith(' is defined')) return reliableTemplateExpression(text.slice(0, -11))
  const filters = splitExpression(text, '|')
  if (filters.length > 1) return reliableTemplateExpression(filters[0]!) && filters.slice(1).every(filter => {
    const match = filter.trim().match(/^([a-z_]+)(?:\(([\s\S]*)\))?$/)
    return !!match && (match[2] === undefined || splitExpression(match[2], ',').every(reliableTemplateExpression))
  })
  if (/^(?:true|True|false|False|none|None|null|-?\d+(?:\.\d+)?)$/.test(text)) return true
  if (/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/.test(text)) return true
  if (/^[\[{]/.test(text)) { try { JSON.parse(text); return true } catch { return false } }
  return /^(@[1-9]\d*|\+[A-Za-z][A-Za-z0-9_-]{0,39}|[A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+|\[["'][A-Za-z0-9_-]+["']\]|\[\d+\])*$/.test(text)
}
function translateExpression(source: string, maps: Aliases, toHost: boolean, locals: ReadonlySet<string>, rewriteReference?: PlanningReferenceRewriter, maskLocals = false): string {
  if (maskLocals && !reliableTemplateExpression(source)) return source
  const padding = source.match(/^(\s*)([\s\S]*?)(\s*)$/)!, text = padding[2]!
  const translate = (value: string) => translateExpression(value, maps, toHost, locals, rewriteReference, maskLocals)
  let result = text
  const transform = (): string => {
    for (const separator of [' or ', ' and ', ' == ', ' != ', ' >= ', ' <= ', ' > ', ' < ', ' in ']) {
      const parts = splitExpression(text, separator)
      if (parts.length > 1) return parts.map(translate).join(separator)
    }
    if (text.startsWith('not ')) return `not ${translate(text.slice(4))}`
    if (text.endsWith(' is defined')) return `${translate(text.slice(0, -11))} is defined`
    const filters = splitExpression(text, '|')
    if (filters.length > 1) return [translate(filters[0]!), ...filters.slice(1).map(filter => {
      const parsed = filter.match(/^(\s*[a-z_]+\()([\s\S]*)(\)\s*)$/)
      return parsed ? `${parsed[1]}${splitExpression(parsed[2]!, ',').map(translate).join(',')}${parsed[3]}` : filter
    })].join('|')
    if (!text || /^(?:true|True|false|False|none|None|null|-?\d+(?:\.\d+)?)$/.test(text) || /^["'\[{]/.test(text)) return text
    const environment = text.match(/^env(?:\.([^.[\]]+)|\[(["'])([^"']+)\2\])$/)
    if (environment && !locals.has('env')) {
      const ref = environment[1] ?? environment[3]!
      if (toHost && /^[@+]/.test(ref)) { envRef.parse(ref); return `env.${resolve(maps.environment, ref)}` }
      if (!toHost && maps.environment.has(ref)) return `env.${maps.environment.get(ref)}`
      return text
    }
    const node = text.match(/^(@[1-9]\d*|\+[A-Za-z][A-Za-z0-9_-]{0,39}|[A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_-]+|\[["'][A-Za-z0-9_-]+["']\]|\[\d+\])*)$/)
    if (node && locals.has(node[1]!) && maskLocals) return '__known_template_local__'
    if (node && !locals.has(node[1]!)) {
      if (rewriteReference) {
        const normalized = (node[1]! + node[2]!).replace(/\[["']([A-Za-z0-9_-]+)["']\]/g, '.$1').replace(/\[(\d+)\]/g, '.$1')
        const rewritten = rewriteReference(normalized)
        if (rewritten !== normalized) return translateExpression(rewritten, maps, toHost, locals)
      }
      if (toHost && /^[@+]/.test(node[1]!)) return `${resolve(maps.nodes, node[1]!)}${node[2]}`
      if (!toHost && maps.nodes.has(node[1]!)) return `${maps.nodes.get(node[1]!)}${node[2]}`
    }
    if (toHost && /^(?:[@+]|env(?:\.|\[["'])[@+])/.test(text)) throw new Error(`EDIT_INVALID_REFERENCE: ${text.slice(0, 100)}`)
    return text
  }
  result = transform()
  return `${padding[1]}${result}${padding[3]}`
}
function translateTemplate(source: string, maps: Aliases, toHost: boolean, initialLocals: ReadonlySet<string>, rewriteReference?: PlanningReferenceRewriter, maskLocals = false): string {
  let locals = new Set(initialLocals)
  let reliable = true
  const stack: { kind: 'for' | 'if'; locals: Set<string>; elseSeen: boolean }[] = []
  const result = source.replace(/\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}|\{#[\s\S]*?#\}/g, (whole, interpolation: string | undefined, command: string | undefined) => {
    if (interpolation !== undefined) {
      if (maskLocals && !reliableTemplateExpression(interpolation)) reliable = false
      return `{{${translateExpression(interpolation, maps, toHost, locals, rewriteReference, maskLocals)}}}`
    }
    if (command === undefined) return whole
    const loop = command.match(/^(\s*for\s+)([A-Za-z_][A-Za-z0-9_]*)(\s+in\s+)([\s\S]*?)(\s*)$/)
    if (loop) {
      if (maskLocals && !reliableTemplateExpression(loop[4]!)) reliable = false
      const expression = translateExpression(loop[4]!, maps, toHost, locals, rewriteReference, maskLocals)
      stack.push({ kind: 'for', locals, elseSeen: false }); locals = new Set([...locals, loop[2]!, 'loop'])
      return `{%${loop[1]}${maskLocals ? '__known_template_local__' : loop[2]}${loop[3]}${expression}${loop[5]}%}`
    }
    const condition = command.match(/^(\s*(?:if|elif)\s+)([\s\S]*?)(\s*)$/)
    if (condition) {
      if (maskLocals && !reliableTemplateExpression(condition[2]!)) reliable = false
      const expression = translateExpression(condition[2]!, maps, toHost, locals, rewriteReference, maskLocals)
      if (command.trim().startsWith('elif ') && (stack.at(-1)?.kind !== 'if' || stack.at(-1)?.elseSeen)) reliable = false
      if (command.trim().startsWith('if ')) stack.push({ kind: 'if', locals, elseSeen: false })
      return `{%${condition[1]}${expression}${condition[3]}%}`
    }
    if (command.trim() === 'else') { const frame=stack.at(-1); if (!frame || frame.elseSeen) reliable = false; if(frame)frame.elseSeen=true; if (frame?.kind === 'for') locals = frame.locals }
    else if (command.trim() === 'endfor' || command.trim() === 'endif') { if (stack.at(-1)?.kind !== (command.trim() === 'endfor' ? 'for' : 'if')) reliable = false; locals = stack.pop()?.locals ?? locals }
    else reliable = false
    return whole
  })
  const residue=source.replace(/\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}|\{#[\s\S]*?#\}/g,'')
  return maskLocals && (!reliable || stack.length || /\{\{|\}\}|\{%|%\}|\{#|#\}/.test(residue)) ? source : result
}
/** A scan-only copy: erase only lexically proven local references, never data,
 * quoted literals, dynamic expressions or unknown/unbalanced template syntax. */
export function maskPlanningTemplateLocals(source: string, names: Iterable<string>): string {
  return translateTemplate(source, { nodes: new Map(), agents: new Map(), environment: new Map() }, false, new Set(names), undefined, true)
}
/** Only runtime reference fields are translated. Literal business payload keys
 * named variable/subagentId/code have no structural identity authority. */
export function rewritePlanningConfig(value: unknown, maps: Aliases, toHost: boolean, kind: NodeKind, path = '', locals: ReadonlySet<string> = new Set(Object.keys((value as { inputs?: object } | null)?.inputs ?? {})), rewriteReference?: PlanningReferenceRewriter): unknown {
  // Only template.text renders config.inputs keys as bare locals; every other
  // field (prompts, input mappings, selectors) resolves them as node references.
  const translate = (expression: string) => translateExpression(expression, maps, toHost, new Set(), rewriteReference)
  if (typeof value === 'string') {
    if (kind === 'agent' && path === 'subagentId') return toHost ? resolve(maps.agents, value) : maps.agents.get(value) ?? value
    if (kind === 'http' && path === 'credentialOperation.secretVariableId') return toHost ? resolve(maps.environment, value) : maps.environment.get(value) ?? value
    if (selectorPath(kind, path) && !value.includes('{{')) return translate(value)
    if (!interpolationPath(kind, path)) return value
    if (kind === 'template' && path === 'text') return translateTemplate(value, maps, toHost, locals, rewriteReference)
    return value.replace(/\{\{([^{}]+)\}\}/g, (_whole, expression: string) => `{{${translate(expression)}}}`)
  }
  if (Array.isArray(value)) return value.map((item, index) => rewritePlanningConfig(item, maps, toHost, kind, `${path}.${index}`, locals, rewriteReference))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, rewritePlanningConfig(item, maps, toHost, kind, path ? `${path}.${name}` : name, locals, rewriteReference)]))
  return value
}
const rewriteConfig = rewritePlanningConfig
/** Template locals visible after a field update: the old config merged with
 * set and unset. A patch that only edits text still sees existing inputs. */
export function planningUpdateLocals(config: Record<string, unknown>, set: Record<string, unknown> = {}, unset: readonly string[] = []): Set<string> {
  const merged: Record<string, unknown> = { ...config, ...set }
  for (const name of unset) delete merged[name]
  const inputs = merged.inputs
  return new Set(inputs && typeof inputs === 'object' && !Array.isArray(inputs) ? Object.keys(inputs) : [])
}

/** Derived from the same strict parser, so model hints cannot drift from allowed operation fields. */
export const planningEditOperations = edits.options.map(option => ({
  op: option.shape.op.value,
  required: Object.entries(option.shape).filter(([name, schema]) => name !== 'op' && !schema.isOptional()).map(([name]) => name),
  optional: Object.entries(option.shape).filter(([name, schema]) => name !== 'op' && schema.isOptional()).map(([name]) => name),
}))
const operationGuide = planningEditOperations.map(item => `${item.op}: ${item.required.join(',') || '(none)'}${item.optional.length ? ` [${item.optional.join(',')}]` : ''}`).join('; ')

/** Read-only aliases are rebuilt for each digest. New +keys never survive into another turn. */
export function planningEditView(context: PlanningContext, base: Workflow = context.workflow, collapseModules=true) {
  const map = aliases(base), inverted: Aliases = { nodes: reverse(map.nodes), agents: reverse(map.agents), environment: reverse(map.environment) }
  const projection = projectWorkflow(base)
  const nodes: { ref: string; scope: string[]; kind: keyof typeof NODE_LABELS; title: string; note?: string; config: Record<string, unknown>; hasBody: boolean }[] = []
  const edges: { scope: string[]; source: string; target: string; port?: string }[] = []
  const visit = (graph: PlanningGraphProjection, path: string[]): void => {
    for (const node of graph.nodes) {
      const ref = resolve(inverted.nodes, node.id), { body, ...config } = node.config
      nodes.push({ ref, scope: path, kind: node.kind, title: node.title, ...(context.operation !== "create" && context.targetNodeIds.includes(node.id) && node.note != null ? { note: node.note.slice(0,300) } : {}), config: rewriteConfig(config, inverted, false, node.kind) as Record<string, unknown>, hasBody: !!body })
      if (body) visit(body, [...path, ref])
    }
    for (const edge of graph.edges) edges.push({ scope: path, source: resolve(inverted.nodes, edge.source), target: resolve(inverted.nodes, edge.target), ...(edge.port === undefined ? {} : { port: edge.port }) })
  }
  visit(projection, [])
  const instances=collapseModules?verifiedModuleInstances(base):[],internals=new Set(instances.flatMap(r=>Object.values(r.roles))),hidden=new Set([...internals].map(id=>inverted.nodes.get(id)!))
  const moduleRefs=moduleInstanceRefs(base,instances)
  const modules=instances.map(r=>({ref:moduleRefs.get(r.instanceKey)!,module:r.moduleId+'@'+r.version,parameters:rewriteFragmentParameters(r.parameters,new Map([...inverted.nodes].map(([id,ref])=>[id,'n'+ref.slice(1)]))),ports:fragmentModules.find(m=>m.id===r.moduleId&&m.version===r.version)!.outputs}))
  const endpoint=new Map(instances.flatMap(r=>Object.values(r.roles).map(id=>[inverted.nodes.get(id)!,moduleRefs.get(r.instanceKey)!] as const)))
  // Config references use the public output ports; internal definitions stay Host-side.
  const publicMap:PlanningAliases={nodes:new Map(endpoint),agents:new Map(),environment:new Map()}
  return {
    ...(modules.length?{modules}:{}),
    protocolVersion: PLANNING_EDIT_PROTOCOL_VERSION, baseDigest: planningEditDigest(base), title: base.title, description: base.description, nodes:nodes.filter(n=>!hidden.has(n.ref)).map(n=>({...n,config:rewriteConfig(n.config,publicMap,false,n.kind) as Record<string,unknown>})), edges:edges.filter(e=>!hidden.has(e.source)||!hidden.has(e.target)).map(e=>({...e,source:endpoint.get(e.source)??e.source,target:endpoint.get(e.target)??e.target})),
    targetScope: context.targetNodeIds.length ? 'selected-nodes' as const : 'workflow' as const,
    targetNodeRefs: context.targetNodeIds.filter(id => inverted.nodes.has(id)).map(id => resolve(inverted.nodes, id)), fixedNodeRefs: allNodes(base).filter(node => node.fixed).map(node => resolve(inverted.nodes, node.id)),
    subAgents: (projection.subAgents ?? []).map(({ id, ...definition }) => ({ ref: resolve(inverted.agents, id), ...definition })),
    environmentVariables: (projection.environmentVariables ?? []).map(({ id, ...definition }) => ({ ref: resolve(inverted.environment, id), ...definition })),
    available: { nodes: context.nodeIds.filter(id => !inverted.nodes.has(id)).length, subAgents: context.subagentIds.filter(id => !inverted.agents.has(id)).length, environmentVariables: context.environmentIds.filter(id => !inverted.environment.has(id)).length },
  }
}

function assertDigest(digest: string, base: Workflow): void {
  if (digest !== planningEditDigest(base)) throw new Error('EDIT_BASE_CONFLICT: 编辑意图不属于当前草稿，请读取新的 baseDigest 和只读引用')
}
function allocate(map: Map<string, string>, ref: string, pool: string[], reserved?: ReadonlyMap<string,string>): void {
  if (map.has(ref)) throw new Error(`EDIT_DUPLICATE_KEY: ${ref}`)
  const used = new Set(map.values()), id = reserved?.get(ref) ?? pool.find(candidate => !used.has(candidate))
  if (!id) throw new Error('EDIT_ID_POOL_EXHAUSTED: Host 预分配身份不足')
  if (!pool.includes(id) || used.has(id)) throw new Error('EDIT_INVALID_ID_POOL: Host 预留身份无效或已使用')
  if (!/^[A-Za-z0-9_-]+$/.test(id) || unsafe.has(id)) throw new Error('EDIT_INVALID_ID_POOL: Host 身份池无效')
  map.set(ref, id)
}
function graphAt(projection: PlanningProjection, path: string[] | undefined, map: Aliases): PlanningGraphProjection {
  let graph: PlanningGraphProjection = projection
  for (const ref of path ?? []) {
    const node = graph.nodes.find(item => item.id === resolve(map.nodes, ref))
    if (!node?.config.body) throw new Error(`EDIT_INVALID_SCOPE: ${ref}`)
    graph = node.config.body
  }
  return graph
}
function canonicalResult(projection: PlanningProjection, context: PlanningContext, base: Workflow) {
  const graphJson = JSON.stringify(projection)
  const candidate = materializePlanningCandidate(graphJson, { ...context, workflow: base })
  return { candidate, issues: planningCandidateIssues(candidate, context), graphJson }
}
export function compilePlanningEdits(value: unknown, context: PlanningContext, base: Workflow = context.workflow, reservations?: Partial<Record<keyof PlanningAliases,ReadonlyMap<string,string>>>, expansion?:'host-compiled'): { output: PlannerOutput; candidate?: Workflow; issues: PlanningIssue[] } {
  const wire = expansion==='host-compiled'?expandedAuthorSchema.parse(checkedJson(value)):parsePlanningEdits(value)
  assertDigest(wire.baseDigest, base)
  if (wire.outcome === 'needs-input') return { output: parsePlannerOutput({ outcome: wire.outcome, graphJson: '', summary: wire.summary || '需要补充信息', assumptions: wire.assumptions, questions: wire.questions, requirementCoverage: [] }), issues: [] }
  const projection = projectWorkflow(base), map = aliases(base), touched = new Set<string>()
  // Forward references are legal in templates and coverage, but graph operations remain sequential.
  for (const edit of wire.edits) {
    if (edit.op === 'add-node') allocate(map.nodes, `+${edit.key}`, context.nodeIds, reservations?.nodes)
    if (edit.op === 'add-subagent') allocate(map.agents, `+a:${edit.key}`, context.subagentIds, reservations?.agents)
    if (edit.op === 'add-environment') allocate(map.environment, `+e:${edit.key}`, context.environmentIds, reservations?.environment)
  }
  const touch = (path: string): void => { if (touched.has(path)) throw new Error(`EDIT_CONFLICTING_OPERATIONS: ${path}`); touched.add(path) }
  for (const edit of wire.edits) {
    if (edit.op === 'set-workflow') {
      if (edit.title !== undefined) { touch('title'); projection.title = edit.title }
      if (edit.description !== undefined) { touch('description'); projection.description = edit.description }
    } else if (edit.op === 'add-subagent') {
      (projection.subAgents ??= []).push({ id: resolve(map.agents, `+a:${edit.key}`), name: edit.name, prompt: edit.prompt })
    } else if (edit.op === 'update-subagent' || edit.op === 'remove-subagent') {
      const id = resolve(map.agents, edit.agent), definition = projection.subAgents?.find(item => item.id === id)
      if (!definition) throw new Error('EDIT_MISSING_SUBAGENT')
      touch(`agent:${id}`)
      if (edit.op === 'remove-subagent') projection.subAgents = projection.subAgents!.filter(item => item.id !== id)
      else { if (edit.name !== undefined) definition.name = edit.name; if (edit.prompt !== undefined) definition.prompt = edit.prompt }
    } else if (edit.op === 'add-environment') {
      const { op: _op, key: name, ...definition } = edit
      if (definition.type === 'secret' && definition.value !== undefined) throw new Error('EDIT_SECRET_VALUE_FORBIDDEN')
      ;(projection.environmentVariables ??= []).push({ id: resolve(map.environment, `+e:${name}`), ...definition } as NonNullable<PlanningProjection['environmentVariables']>[number])
    } else if (edit.op === 'update-environment' || edit.op === 'remove-environment') {
      const id = resolve(map.environment, edit.variable), variable = projection.environmentVariables?.find(item => item.id === id)
      if (!variable) throw new Error('EDIT_MISSING_ENVIRONMENT')
      touch(`env:${id}`)
      if (edit.op === 'remove-environment') projection.environmentVariables = projection.environmentVariables!.filter(item => item.id !== id)
      else {
        if (variable.type === 'secret' && edit.value !== undefined) throw new Error('EDIT_SECRET_VALUE_FORBIDDEN')
        const { op: _op, variable: _variable, ...changes } = edit
        Object.assign(variable, changes)
      }
    } else {
      const graph = graphAt(projection, edit.scope, map)
      if (edit.op === 'add-node') {
        graph.nodes.push({ id: resolve(map.nodes, `+${edit.key}`), kind: edit.kind, title: edit.title, ...(edit.note === undefined ? {} : { note: edit.note }), config: { ...rewriteConfig(edit.config, map, true, edit.kind) as Record<string, unknown>, ...(['loop', 'iteration'].includes(edit.kind) ? { body: { nodes: [], edges: [] } } : {}) } })
      } else if (edit.op === 'update-node' || edit.op === 'remove-node') {
        const id = resolve(map.nodes, edit.node), node = graph.nodes.find(item => item.id === id)
        if (!node) throw new Error(`EDIT_NODE_SCOPE_MISMATCH: ${edit.node}`)
        touch(`node:${id}`)
        if (edit.op === 'remove-node') { graph.nodes = graph.nodes.filter(item => item.id !== id); graph.edges = graph.edges.filter(edge => edge.source !== id && edge.target !== id) }
        else {
          if (edit.kind !== undefined) node.kind = edit.kind
          if (edit.title !== undefined) node.title = edit.title
          if (edit.note !== undefined) node.note = edit.note
          const set = edit.configSet ?? {}, unset = edit.configUnset ?? []
          if (new Set(unset).size !== unset.length || unset.some(name => Object.hasOwn(set, name))) throw new Error('EDIT_CONFLICTING_CONFIG: 同一字段不能同时设置和删除')
          const locals = planningUpdateLocals(node.config, set, unset)
          for (const name of unset) delete node.config[name]
          Object.assign(node.config, rewriteConfig(set, map, true, node.kind, '', locals))
          if (['loop', 'iteration'].includes(node.kind) && !node.config.body) node.config.body = { nodes: [], edges: [] }
        }
      } else {
        const edge = { source: resolve(map.nodes, edit.source), target: resolve(map.nodes, edit.target), ...(edit.port === undefined ? {} : { port: edit.port }) }
        if (![edge.source, edge.target].every(id => graph.nodes.some(node => node.id === id))) throw new Error('EDIT_EDGE_SCOPE_MISMATCH: 连线端点必须在同一 scope 中')
        const same = (item: typeof edge): boolean => item.source === edge.source && item.target === edge.target && (item.port ?? 'default') === (edge.port ?? 'default')
        const exists = graph.edges.some(same)
        if (edit.op === 'connect') { if (exists) throw new Error('EDIT_DUPLICATE_EDGE'); graph.edges.push(edge) }
        else { if (!exists) throw new Error('EDIT_MISSING_EDGE'); graph.edges = graph.edges.filter(item => !same(item)) }
      }
    }
  }
  const result = canonicalResult(projection, context, base)
  const output = parsePlannerOutput({ outcome: wire.outcome, graphJson: result.graphJson, summary: wire.summary || '已组装工作流候选', assumptions: wire.assumptions, questions: [], requirementCoverage: wire.requirementCoverage.map(item => ({ ...item, nodeIds: item.nodeIds.map(ref => resolve(map.nodes, ref)) })) })
  return { output, candidate: result.candidate, issues: result.issues }
}

export function compileOptimizationEdits(value: unknown, context: PlanningContext, base: Workflow = context.workflow): { output: OptimizationOutput; candidate?: Workflow; issues: PlanningIssue[] } {
  const wire = parseOptimizationEdits(value)
  assertDigest(wire.baseDigest, base)
  if (wire.outcome === 'unchanged') return { output: parseOptimizationOutput({ outcome: 'unchanged', graphJson: '', summary: wire.summary || '保留当前候选', replacements: [], regressionCases: [] }), issues: [] }
  const projection = projectWorkflow(base), map = aliases(base), seen = new Set<string>()
  const replacements: OptimizationOutput['replacements'] = [], regressionCases: OptimizationOutput['regressionCases'] = []
  for (const replacement of wire.replacements) {
    const id = resolve(map.nodes, replacement.node), node = projection.nodes.find(item => item.id === id)
    if (!node || seen.has(id)) throw new Error('EDIT_OPTIMIZATION_SCOPE: 只能替换不重复的现有顶层节点')
    if (node.config.body) throw new Error('EDIT_OPTIMIZATION_SCOPE: 优化器不能改变容器结构')
    seen.add(id)
    node.kind = replacement.kind
    node.config = rewriteConfig(replacement.config, map, true, node.kind) as typeof node.config
    replacements.push({ nodeId: id, reason: replacement.reason })
    for (const item of replacement.evidenceCases) regressionCases.push({ ...item, nodeId: id, ...(item.upstreamOutputs ? { upstreamOutputs: Object.fromEntries(Object.entries(item.upstreamOutputs).map(([ref, evidence]) => [resolve(map.nodes, ref), evidence])) } : {}) })
  }
  const result = canonicalResult(projection, context, base)
  return { output: parseOptimizationOutput({ outcome: 'candidate', graphJson: result.graphJson, summary: wire.summary || '已组装局部优化候选', replacements, regressionCases }), candidate: result.candidate, issues: result.issues }
}

// DSH accepts a small JSON-schema subset. Per-op allowed keys and all limits are
// enforced by the strict parser above, even when providers ignore wire hints.
const string = { type: 'string' as const }, boolean = { type: 'boolean' as const }, record = { type: 'object' as const, additionalProperties: true }
const strings = { type: 'array' as const, items: string }
const evidenceSchema = { type: 'object' as const, properties: { evidenceId: string, pointer: string }, required: ['evidenceId', 'pointer'], additionalProperties: false }
const commonProperties = { protocolVersion: { type: 'number' as const, enum: [1] }, baseDigest: string, summary: string }
const editFieldSchemas: Record<string, JsonSchemaNode> = {
  key: string, scope: strings, node: string, source: string, target: string, port: string,
  kind: { type: 'string', enum: Object.keys(NODE_LABELS) }, title: string, note: updateDescriptionWire, config: record, configSet: record, configUnset: strings,
  description: string, agent: string, name: string, prompt: string, variable: string,
  type: { type: 'string', enum: ['string', 'number', 'secret'] }, required: boolean, value: { oneOf: [string, { type: 'number' }] },
}
// Keep provider constraints as strict as the Host parser: a flat object with
// all operation fields optional falsely advertises cross-operation keys.
const editOperationSchemas: JsonSchemaNode[] = planningEditOperations.map(operation => ({
  type: 'object',
  properties: {
    op: { type: 'string', const: operation.op },
    ...Object.fromEntries([...operation.required, ...operation.optional].map(field => {
      const schema = editFieldSchemas[field]
      if (!schema) throw new Error(`Missing edit field schema: ${field}`)
      return [field, field==='note'&&operation.op==='add-node'?nodeDescriptionWire:schema]
    })),
  },
  required: ['op', ...operation.required], additionalProperties: false,
}))
export const planningEditsSchema = {
  type: 'object' as const, properties: {
    ...commonProperties, outcome: { type: 'string' as const, enum: ['candidate', 'needs-input'] }, assumptions: strings,
    questions: { type: 'array' as const, items: { type: 'object' as const, properties: { id: string, question: string, options: strings }, required: ['id', 'question'], additionalProperties: false } },
    requirementCoverage: { type: 'array' as const, items: { type: 'object' as const, properties: { requirementId: string, nodeIds: strings, note: string }, required: ['requirementId', 'nodeIds'], additionalProperties: false } },
    edits: { type: 'array' as const, description: `${operationGuide}. Brackets mean optional fields. update-node uses configSet/configUnset, never config. Example: {"op":"update-node","node":"@2","configSet":{"text":"Hello {{input.name}}"}}. Omitted scope means root; config.body is forbidden.`, items: { oneOf: editOperationSchemas } },
  }, required: ['baseDigest', 'outcome'], additionalProperties: false,
}
export const optimizationEditsSchema = {
  type: 'object' as const, properties: {
    ...commonProperties, outcome: { type: 'string' as const, enum: ['candidate', 'unchanged'] },
    replacements: { type: 'array' as const, items: { type: 'object' as const, properties: {
      node: string, kind: { type: 'string' as const, enum: Object.keys(NODE_LABELS) }, config: record, reason: string,
      evidenceCases: { type: 'array' as const, items: { type: 'object' as const, properties: { id: string, workflowInputs: evidenceSchema, upstreamOutputs: record, expected: evidenceSchema }, required: ['id', 'expected'], additionalProperties: false } },
    }, required: ['node', 'kind', 'config', 'reason'], additionalProperties: false } },
  }, required: ['baseDigest', 'outcome'], additionalProperties: false,
}
