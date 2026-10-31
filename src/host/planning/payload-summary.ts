import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { NODE_LABELS, type NodeKind } from '../../shared/types.ts'

const count = z.number().int().nonnegative().safe()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const planningMetadataToolNames = ['planner_graph_context', 'planner_node_catalog', 'planner_node_templates', 'planner_tool_catalog', 'structured_output'] as const
const toolName = z.enum(planningMetadataToolNames)
const nodeKind = z.enum(Object.keys(NODE_LABELS) as [NodeKind, ...NodeKind[]])
export const planningPayloadSummarySchema = z.object({
  version: z.literal(1), boundary: z.literal('sdk-generate-options'),
  messageCount: count, messageBytes: count, systemTextBytes: count,
  toolOrder: z.array(toolName).max(5), unexpectedToolCount: count, schemaBytes: count, schemaDigest: digest,
  outputSchemaDigest: digest.optional(), schemaRefCount: count,
  toolHistoryDeclarationCount: count, toolHistoryUpdateCount: count,
  exactTaskPromptCopies: count,
  compilerRulesCopies: count, templateAccessCopies: count,
  prompt: z.object({
    kind: z.enum(['initial', 'initial-clarification', 'draft-repair', 'unrecognized']),
    sharedContractDigest: digest.optional(), sharedContractBytes: count,
    sharedPrefixBytes: count, sharedPrefixDigest: digest.optional(),
    runtimeKinds: z.array(nodeKind).max(20), runtimeSchemaCount: count,
    runtimeSemanticsDigest: digest.optional(), templateSyntaxDigest: digest.optional(),
    prefetchedTemplateCount: count, prefetchedTemplateIdsDigest: digest.optional(),
  }).strict(),
}).strict()
export type PlanningPayloadSummary = z.infer<typeof planningPayloadSummarySchema>
export const planningCatalogQuerySummarySchema = z.object({
  requestedCount: count, requestedIdsDigest: digest, knownBeforeCount: count,
  returnedCount: count, returnedIdsDigest: digest, resultBytes: count,
}).strict()
/** IDs are hashed in order; neither arbitrary arguments nor metadata bodies
 * enter the metric journal. Call only after a successful authorized query. */
export function planningCatalogQuerySummary(ids: readonly string[], known: ReadonlySet<string>, result: unknown): z.infer<typeof planningCatalogQuerySummarySchema> {
  const entries = record(result)?.entries
  const returnedIds = Array.isArray(entries) ? entries.flatMap(entry => typeof record(entry)?.id === 'string' ? [record(entry)!.id] : []) : []
  return { requestedCount: ids.length, requestedIdsDigest: hash(ids), knownBeforeCount: ids.filter(id => known.has(id)).length, returnedCount: returnedIds.length, returnedIdsDigest: hash(returnedIds), resultBytes: bytes(result) }
}
/** Returned IDs are metadata identity only, kept in memory for overlap counts. */
export function planningPrefetchedTemplateIds(prompt: string): string[] {
  try {
    const entries = record(record(record(JSON.parse(prompt))?.templateCatalog)?.prefetched)?.entries
    return Array.isArray(entries) ? entries.flatMap(entry => typeof record(entry)?.id === 'string' ? [record(entry)!.id as string] : []) : []
  } catch { return [] }
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex')
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Public contract hashes/counters only. Never retain prompt text, business
 * values, assistant blocks, replay state, arguments, provider config or headers.
 * This observes SDK input, before any adapter-specific HTTP projection. */
export function planningPayloadSummary(options: GenerateOptions, taskPrompt: string, contracts?: { rules?: string; templateAccess?: string }): PlanningPayloadSummary {
  let payload: Record<string, unknown> | undefined
  try { payload = record(JSON.parse(taskPrompt)) } catch { /* Legacy prose has no structured public contract. */ }
  const continuation = record(payload?.continuation)
  const kind = continuation?.kind === 'draft-repair' || continuation?.kind === 'initial-clarification' ? continuation.kind : payload && ('rules' in payload || 'templateCatalog' in payload || 'runtimeSemantics' in payload) ? 'initial' : 'unrecognized'
  const shared = payload ? Object.fromEntries(['rules', 'templateAccess', 'runtimeSemantics', 'semantics', 'templateCatalog'].filter(key => Object.hasOwn(payload!, key)).map(key => [key, payload![key]])) : {}
  const semantics = record(payload?.runtimeSemantics)
  const nodes = Array.isArray(semantics?.nodes) ? semantics.nodes.map(record).filter((node): node is Record<string, unknown> => !!node) : []
  const runtimeKinds = [...new Set(nodes.flatMap(node => typeof node.kind === 'string' && Object.hasOwn(NODE_LABELS, node.kind) ? [node.kind as NodeKind] : []))]
  const templateSyntax = nodes.find(node => node.kind === 'template')?.syntax
  const entries = record(record(payload?.templateCatalog)?.prefetched)?.entries
  const prefetchedIds = Array.isArray(entries) ? entries.flatMap(entry => typeof record(entry)?.id === 'string' ? [record(entry)!.id] : []) : []
  // ToolDefinition callbacks/output renderers are not part of the SDK tool
  // declaration. Summarize the final GenerateOptions declarations as received.
  const tools = options.tools ?? []
  let schemaRefCount = 0
  const refs = (value: unknown): void => { if (Array.isArray(value)) value.forEach(refs); else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { if (key === '$ref') schemaRefCount++; refs(child) } }
  tools.forEach(tool => refs(tool.parameters))
  const outputSchema = tools.find(tool => tool.name === 'structured_output')?.parameters
  const texts = options.messages.flatMap(message => message.role === 'user' || message.role === 'system' ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
  const exactTaskPromptCopies = texts.filter(text => text === taskPrompt).length
  const contractCopies = (value: unknown, field: 'rules' | 'templateAccess') => typeof value !== 'string' || !value ? 0 : (payload?.[field] === value ? exactTaskPromptCopies : 0) + texts.filter(text => text !== taskPrompt).reduce((total, text) => total + text.split(value).length - 1, 0)
  // Only report an actual leading byte sequence when it occurs unchanged in
  // the admitted task message. A digest alone is never a provider-cache hit.
  const prefix = Object.keys(shared).length ? JSON.stringify(shared).slice(0, -1) + ',' : ''
  const sharedPrefix = exactTaskPromptCopies && prefix && taskPrompt.startsWith(prefix) ? prefix : ''
  return {
    version: 1, boundary: 'sdk-generate-options', messageCount: options.messages.length, messageBytes: bytes(options.messages),
    systemTextBytes: Buffer.byteLength((options.system ?? '') + options.messages.filter(message => message.role === 'system').flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join(''), 'utf8'),
    toolOrder: tools.flatMap(tool => toolName.safeParse(tool.name).success ? [tool.name as typeof planningMetadataToolNames[number]] : []),
    unexpectedToolCount: tools.filter(tool => !toolName.safeParse(tool.name).success).length,
    schemaBytes: bytes(tools), schemaDigest: hash(tools), ...(outputSchema ? { outputSchemaDigest: hash(outputSchema) } : {}), schemaRefCount,
    toolHistoryDeclarationCount: options.toolHistory?.tools.length ?? 0, toolHistoryUpdateCount: options.toolHistory?.updates.length ?? 0,
    exactTaskPromptCopies, compilerRulesCopies: contractCopies(contracts?.rules ?? payload?.rules, 'rules'), templateAccessCopies: contractCopies(contracts?.templateAccess ?? payload?.templateAccess, 'templateAccess'),
    prompt: { kind, sharedContractBytes: Object.keys(shared).length ? bytes(shared) : 0, ...(Object.keys(shared).length ? { sharedContractDigest: hash(shared) } : {}),
      sharedPrefixBytes: Buffer.byteLength(sharedPrefix, 'utf8'), ...(sharedPrefix ? { sharedPrefixDigest: hash(sharedPrefix) } : {}),
      runtimeKinds, runtimeSchemaCount: nodes.filter(node => Object.hasOwn(node, 'schema')).length,
      ...(semantics ? { runtimeSemanticsDigest: hash(semantics) } : {}), ...(templateSyntax ? { templateSyntaxDigest: hash(templateSyntax) } : {}),
      prefetchedTemplateCount: prefetchedIds.length, ...(prefetchedIds.length ? { prefetchedTemplateIdsDigest: hash(prefetchedIds) } : {}),
    },
  }
}
