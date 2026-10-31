import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { deduplicatedPlanningPrompt, orderedPlanningTools, planningPromptJson } from '../src/host/planning/prompt-layout.ts'

describe('planning prompt wire layout', () => {
  it('produces an identical public contract prefix for distinct task deltas without losing values', () => {
    const rules = 'Read metadata only; retain human review.'
    const left = { graph: { nodes: [{ id: 'one', config: { z: 0, a: false } }] }, requirement: 'first task', rules, runtimeSemantics: { nodes: [{ kind: 'template' }] }, answers: [] }
    const right = { answers: ['reply'], rules, requirement: 'second task', runtimeSemantics: { nodes: [{ kind: 'template' }] }, graph: { nodes: [{ id: 'two' }] } }
    const a = planningPromptJson(left), b = planningPromptJson(right)
    const sharedPrefix = '{"rules":"Read metadata only; retain human review.","runtimeSemantics":{"nodes":[{"kind":"template"}]},'
    expect(a.startsWith(sharedPrefix)).toBe(true); expect(b.startsWith(sharedPrefix)).toBe(true)
    expect(JSON.parse(a)).toEqual(left); expect(JSON.parse(b)).toEqual(right)
    expect(planningPromptJson({ ...left, graph: { nodes: [{ config: { a: false, z: 0 }, id: 'one' }] } })).toBe(a)
    expect(left.graph.nodes[0]!.config).toEqual({ z: 0, a: false })
  })

  it('stabilizes tool and schema key order, preserves arrays, and leaves the input untouched', () => {
    const execute = () => 'same handler'
    const schema = { type: 'object', properties: { z: { type: 'string' }, a: { enum: ['second', 'first'] } }, required: ['z', 'a'], additionalProperties: false }
    const input = [
      { name: 'structured_output', parameters: schema, execute },
      { name: 'planner_tool_catalog', parameters: { type: 'object' }, execute },
      { name: 'planner_node_catalog', parameters: { type: 'object' }, execute },
    ]
    const before = JSON.stringify(input), ordered = orderedPlanningTools(input)
    expect(ordered.map(tool => tool.name)).toEqual(['planner_node_catalog', 'planner_tool_catalog', 'structured_output'])
    const alternate = input.toReversed().map(tool => tool.name === 'structured_output' ? { ...tool, parameters: { additionalProperties: false, required: ['z', 'a'], properties: { a: { enum: ['second', 'first'] }, z: { type: 'string' } }, type: 'object' } } : tool)
    expect(JSON.stringify(orderedPlanningTools(alternate))).toBe(JSON.stringify(ordered))
    expect(JSON.stringify(input)).toBe(before); expect(ordered.every(tool => tool.execute === execute)).toBe(true)
    const actual = ordered.at(-1)!.parameters
    expect(actual).toEqual(schema)
    expect(validateJsonSchemaValue(actual, { z: 'ok', a: 'first' })).toEqual([])
    expect(validateJsonSchemaValue(actual, { z: 'ok', a: 'first', unauthorized: true }).length).toBeGreaterThan(0)
  })

  it('does not add contracts to a continuation delta or normalize missing values into success', () => {
    const delta = { continuation: { draftRevision: 3, allowedPaths: ['/updates/n3/values/text'] }, answers: [], requirement: undefined }
    expect(JSON.parse(planningPromptJson(delta))).toEqual(JSON.parse(JSON.stringify(delta)))
    expect(planningPromptJson(delta)).not.toContain('runtimeSemantics')
  })

  it('deduplicates only an explicitly Host-owned matching initial contract and preserves task data', () => {
    const payload = { rules: 'authoritative contract '.repeat(20), templateAccess: 'access contract '.repeat(20), templateCatalog: { prefetched: { entries: [] } }, runtimeSemantics: { nodes: [{ kind: 'template', syntax: { preserved: true } }] }, requirement: { text: 'user requirement' }, answers: ['user answer'] }
    const prompt = planningPromptJson(payload), result = deduplicatedPlanningPrompt(prompt, 'host-template-initial-v1', payload.rules, payload.templateAccess)
    expect(Buffer.byteLength(result)).toBeLessThan(Buffer.byteLength(prompt))
    expect(JSON.parse(result)).toEqual({ ...payload, rules: expect.stringContaining('system planning boundary'), templateAccess: expect.stringContaining('system planning boundary') })
    expect(payload.rules).toBe('authoritative contract '.repeat(20))
    for (const other of [
      JSON.stringify({ ...payload, rules: payload.rules + '!' }),
      JSON.stringify({ ...payload, templateAccess: payload.templateAccess + '!' }),
      JSON.stringify({ ...payload, continuation: { kind: 'draft-repair', hasDraft: true } }),
      JSON.stringify({ ...payload, templateCatalog: undefined }),
      'user prose', JSON.stringify([payload]),
    ]) expect(deduplicatedPlanningPrompt(other, 'host-template-initial-v1', payload.rules, payload.templateAccess)).toBe(other)
    // User JSON with identical field names or copied values has no Host provenance.
    expect(deduplicatedPlanningPrompt(prompt, undefined, payload.rules, payload.templateAccess)).toBe(prompt)
  })
})
