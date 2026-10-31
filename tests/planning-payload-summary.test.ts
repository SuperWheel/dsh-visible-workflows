import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { planningCatalogQuerySummary, planningCatalogQuerySummarySchema, planningPayloadSummary, planningPayloadSummarySchema, planningPrefetchedTemplateIds } from '../src/host/planning/payload-summary.ts'
import { planningPromptJson } from '../src/host/planning/prompt-layout.ts'
import { planningMetricSchema } from '../src/host/planning/metrics.ts'

describe('SDK planning payload summaries', () => {
  const tools = [
    { name: 'planner_node_catalog', description: 'Public catalog', parameters: { type: 'object' } },
    { name: 'structured_output', description: 'Submit', parameters: { type: 'object', properties: { submission: { $ref: '#/$defs/form' } }, $defs: { form: { type: 'object' } } } },
  ]
  const input = (prompt: string): GenerateOptions => ({ provider: 'fixture', model: 'no-model', tools, messages: [
    { role: 'system', content: [{ type: 'text', text: 'Host public policy' }] },
    { role: 'user', content: [{ type: 'text', text: prompt }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'text', text: 'GENERATED_SOURCE' }], source: { replayState: { credential: 'PRIVATE_REPLAY' } } } as any,
  ] })
  it('observes runtime meaning, schema refs and actual public prefix without exporting raw content', () => {
    const payload = { rules: 'PUBLIC_COMPILER_RULES', templateAccess: 'PUBLIC_ACCESS_RULES', runtimeSemantics: { nodes: [{ kind: 'template', syntax: { version: 'fixture-v1', examples: ['PUBLIC_SYNTAX'] } }] }, templateCatalog: { prefetched: { entries: [{ id: 'template' }] } }, requirement: 'PRIVATE_BUSINESS_VALUE' }
    const prompt = planningPromptJson(payload), options = input(prompt)
    const summary = planningPayloadSummary(options, prompt)
    expect(planningPayloadSummarySchema.parse(summary)).toEqual(summary)
    expect(summary).toMatchObject({ boundary: 'sdk-generate-options', toolOrder: ['planner_node_catalog', 'structured_output'], schemaRefCount: 1, exactTaskPromptCopies: 1, compilerRulesCopies: 1, templateAccessCopies: 1, prompt: { kind: 'initial', runtimeKinds: ['template'], runtimeSchemaCount: 0, prefetchedTemplateCount: 1, templateSyntaxDigest: expect.any(String), sharedPrefixBytes: expect.any(Number) } })
    expect(summary.prompt.sharedPrefixBytes).toBeGreaterThan(0)
    expect(summary.messageBytes).toBe(Buffer.byteLength(JSON.stringify(options.messages)))
    expect(summary.schemaBytes).toBe(Buffer.byteLength(JSON.stringify(tools)))
    const serialized = JSON.stringify(summary)
    for (const marker of ['PRIVATE_', 'GENERATED_SOURCE', 'PUBLIC_COMPILER_RULES', 'PUBLIC_ACCESS_RULES', 'PUBLIC_SYNTAX']) expect(serialized).not.toContain(marker)
    expect(planningMetricSchema.parse({ phase: 'sdk-payload', at: 1, payload: summary })).toBeDefined()
    expect(planningMetricSchema.safeParse({ phase: 'sdk-payload', at: 1, payload: { ...summary, raw: prompt } }).success).toBe(false)
  })
  it('keeps matching prefixes stable across task deltas and detects schema/order/contract changes', () => {
    const a = planningPromptJson({ rules: 'rules', runtimeSemantics: { nodes: [{ kind: 'code' }] }, requirement: 'first' })
    const b = planningPromptJson({ rules: 'rules', runtimeSemantics: { nodes: [{ kind: 'code' }] }, requirement: 'second' })
    const left = planningPayloadSummary(input(a), a), right = planningPayloadSummary(input(b), b)
    expect(right.prompt.sharedPrefixDigest).toBe(left.prompt.sharedPrefixDigest)
    expect(right.schemaDigest).toBe(left.schemaDigest)
    const reordered = planningPayloadSummary({ ...input(b), tools: tools.toReversed() }, b)
    expect(reordered.schemaDigest).not.toBe(left.schemaDigest)
    expect(reordered.toolOrder).toEqual(['structured_output', 'planner_node_catalog'])
    const changed = planningPayloadSummary({ ...input(b), tools: [{ ...tools[1]!, parameters: { type: 'object' } }] }, b)
    expect(changed.outputSchemaDigest).not.toBe(left.outputSchemaDigest)
  })
  it('counts duplicate instructions, keeps delta without invented runtime contracts, and requires an actual matching message', () => {
    const prompt = planningPromptJson({ rules: 'exact compiler instructions', templateAccess: 'exact access', requirement: 'task' })
    const options = input(prompt); options.messages[0] = { role: 'system', content: [{ type: 'text', text: 'exact compiler instructions exact access' }] }
    expect(planningPayloadSummary(options, prompt)).toMatchObject({ compilerRulesCopies: 2, templateAccessCopies: 2 })
    const delta = JSON.stringify({ continuation: { kind: 'draft-repair' }, answers: ['PRIVATE_ANSWER'] })
    expect(planningPayloadSummary(input(delta), delta)).toMatchObject({ compilerRulesCopies: 0, prompt: { kind: 'draft-repair', runtimeKinds: [], sharedContractBytes: 0, sharedPrefixBytes: 0 } })
    const missing = planningPayloadSummary({ ...input(prompt), messages: [] }, prompt)
    expect(missing.exactTaskPromptCopies).toBe(0); expect(missing.prompt.sharedPrefixBytes).toBe(0); expect(missing.prompt.sharedPrefixDigest).toBeUndefined()
  })
  it('summarizes successful metadata-query overlap without recording arguments or returned content', () => {
    const prompt = JSON.stringify({ templateCatalog: { prefetched: { entries: [{ id: 'template' }] } } })
    const known = new Set(planningPrefetchedTemplateIds(prompt))
    const summary = planningCatalogQuerySummary(['template','code'], known, { entries: [{ id: 'template', description: 'PRIVATE_CONTENT' }, { id: 'code', fields: { code: 'PRIVATE_SOURCE' } }] })
    expect(planningCatalogQuerySummarySchema.parse(summary)).toMatchObject({ requestedCount: 2, knownBeforeCount: 1, returnedCount: 2 })
    expect(JSON.stringify(summary)).not.toContain('PRIVATE')
    expect(summary.requestedIdsDigest).toBe(summary.returnedIdsDigest)
    expect(planningPrefetchedTemplateIds('legacy prose')).toEqual([])
  })
})
