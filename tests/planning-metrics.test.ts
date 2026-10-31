import { describe, expect, it } from 'vitest'
import { PlanningMetricRecorder, planningMetricSchema, planningUsageReceipt, repeatedPayloadRatio, type PlanningMetric } from '../src/host/planning/metrics.ts'

function fixture() {
  let wall = 10_000, mono = 100
  const records: PlanningMetric[] = []
  const metrics = new PlanningMetricRecorder(record => { planningMetricSchema.parse(record); records.push(record) }, { wall: () => wall, monotonic: () => mono })
  const advance = (ms: number) => { mono += ms; wall -= ms } // Wall-clock correction cannot corrupt intervals.
  return { records, metrics, advance }
}

describe('planning observable metrics', () => {
  it('separates stream activity from first meaningful text and tool arguments without recording reasoning', () => {
    const { records, metrics, advance } = fixture()
    metrics.request([], [], { turn: 2, step: 3 }, 10)
    metrics.stream({ type: 'start' })
    advance(10)
    metrics.stream({ type: 'chunk', chunk: { type: 'reasoning-delta', text: 'private reasoning must never be stored' } })
    metrics.stream({ type: 'chunk', chunk: { type: 'usage', usage: { totalTokens: 8 } } })
    metrics.stream({ type: 'chunk', chunk: { type: 'text-delta', text: ' \n' } })
    metrics.stream({ type: 'chunk', chunk: { type: 'tool-call-delta', name: 'structured_output', argumentsDelta: '' } })
    expect(records.filter(record => record.phase.startsWith('first-valid'))).toHaveLength(0)
    advance(20)
    metrics.stream({ type: 'chunk', chunk: { type: 'tool-call-delta', argumentsDelta: '{' } })
    advance(30)
    metrics.stream({ type: 'chunk', chunk: { type: 'text-delta', text: 'public text' } })
    metrics.stream({ type: 'chunk', chunk: { type: 'text-delta', text: 'more text' } })
    expect(records.find(record => record.phase === 'first-observed-delta')).toMatchObject({ durationMs: 0 })
    expect(records.filter(record => record.phase === 'first-valid-tool-arguments')).toEqual([expect.objectContaining({ requestIndex: 1, turn: 2, step: 3, durationMs: 30 })])
    expect(records.filter(record => record.phase === 'first-valid-text')).toEqual([expect.objectContaining({ durationMs: 60 })])
    expect(JSON.stringify(records)).not.toContain('private reasoning')
    expect(JSON.stringify(records)).not.toContain('public text')
  })

  it('counts UTF-8 messages and schemas separately and defines exact duplicate units', () => {
    const { records, metrics } = fixture()
    const message = { role: 'user', content: [{ type: 'text', text: '你好' }] }
    const messages = [message, message], tools = [{ name: 'submit', parameters: { type: 'object' } }]
    const totalBytes = Buffer.byteLength(JSON.stringify({ messages, tools }))
    metrics.request(messages, tools, { turn: 1, step: 1 }, totalBytes)
    expect(records.find(record => record.phase === 'model-message-bytes')?.bytes).toBe(Buffer.byteLength(JSON.stringify(messages)))
    expect(records.find(record => record.phase === 'model-schema-bytes')?.bytes).toBe(Buffer.byteLength(JSON.stringify(tools)))
    expect(records.find(record => record.phase === 'model-request')).toMatchObject({ count: 1, bytes: totalBytes })
    const m = Buffer.byteLength(JSON.stringify(message)), t = Buffer.byteLength(JSON.stringify(tools[0]))
    expect(repeatedPayloadRatio(messages, tools)).toBe(m / (2 * m + t))
    expect(repeatedPayloadRatio([], [])).toBe(0)
    expect(records.filter(record => record.phase.startsWith('provider-')).every(record => record.status === 'unknown' && record.durationMs === undefined)).toBe(true)
  })

  it('deduplicates journal receipts and preserves partial usage without inventing totals or cache values', () => {
    const { records, metrics, advance } = fixture()
    metrics.request([], [], { turn: 1, step: 1 }, 10)
    advance(50)
    const response = { turn: 1, step: 1, usage: { inputTokens: 30, outputTokens: 10, reasoningTokens: 6, cacheReadTokens: 0 } }
    metrics.response(response, 12, true)
    metrics.response(response, 12, true)
    metrics.closePending('failed')
    expect(records.filter(record => record.phase === 'model-response')).toEqual([expect.objectContaining({ durationMs: 50, status: 'failed', sequence: 12 })])
    expect(records.filter(record => record.phase === 'model-usage')).toEqual([expect.objectContaining({ usage: { inputTokens: 30, outputTokens: 10, reasoningTokens: 6, cacheReadTokens: 0, cacheWriteTokens: null, totalTokens: null } })])
  })

  it('uses the latest final stream usage snapshot once; missing and malformed counters remain unknown', () => {
    expect(planningUsageReceipt({ stream: [
      { type: 'chunk', time: 1, chunk: { type: 'usage', usage: { totalTokens: 5 } } },
      { type: 'chunk', time: 2, chunk: { type: 'usage', usage: { inputTokens: 4, outputTokens: 8, totalTokens: 12, reasoningTokens: 6 } } },
    ] })).toEqual({ inputTokens: 4, outputTokens: 8, totalTokens: 12, reasoningTokens: 6, cacheReadTokens: null, cacheWriteTokens: null })
    expect(planningUsageReceipt({ usage: { inputTokens: -1, outputTokens: '3', totalTokens: Infinity, reasoningTokens: NaN, cacheReadTokens: 0, cacheWriteTokens: 0.2 } })).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, reasoningTokens: null, cacheReadTokens: 0, cacheWriteTokens: null })
    expect(planningUsageReceipt({ usage: { totalTokens: 0 } }).totalTokens).toBe(0)
  })

  it.each(['cancelled', 'timeout', 'failed'] as const)('retains elapsed time and explicit unknown usage for %s without a settlement receipt', status => {
    const { records, metrics, advance } = fixture()
    metrics.request([], [], { turn: 1, step: 1 }, 10)
    advance(120)
    metrics.closePending(status)
    metrics.closePending(status)
    expect(records.filter(record => record.phase === 'model-response')).toEqual([expect.objectContaining({ durationMs: 120, status })])
    expect(records.filter(record => record.phase === 'model-usage')).toHaveLength(1)
    expect(records.find(record => record.phase === 'model-usage')?.usage?.totalTokens).toBeNull()
    expect(records.find(record => record.phase === 'first-valid-text')?.status).toBe('unknown')
  })

  it('assigns distinct call identities across steps and keeps an unobserved previous settlement visible', () => {
    const { records, metrics, advance } = fixture()
    metrics.request([], [], { turn: 1, step: 1 }, 10)
    advance(10)
    metrics.request([], [], { turn: 1, step: 2 }, 10)
    metrics.response({ turn: 1, step: 2, usage: { totalTokens: 9 } }, 4, false)
    expect(records.filter(record => record.phase === 'model-request').map(record => record.requestIndex)).toEqual([1, 2])
    expect(records.filter(record => record.phase === 'model-response')).toEqual([
      expect.objectContaining({ requestIndex: 1, status: 'unknown', durationMs: 10 }),
      expect.objectContaining({ requestIndex: 2, status: 'success', sequence: 4 }),
    ])
  })

  it('rejects raw content and invalid counter data at the persistence contract', () => {
    expect(planningMetricSchema.safeParse({ phase: 'stream', at: 1, text: 'private' }).success).toBe(false)
    expect(planningMetricSchema.safeParse({ phase: 'usage', at: 1, count: -1 }).success).toBe(false)
    expect(planningMetricSchema.safeParse({ phase: 'ratio', at: 1, ratio: 1.1 }).success).toBe(false)
  })
})
