import { z } from 'zod'
import { lastAssistantStreamChunk, type AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { planningCatalogQuerySummarySchema, planningPayloadSummarySchema } from './payload-summary.ts'

export const PLANNING_METRIC_LIMIT = 4096
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const tokenFields = ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'] as const
export const planningMetricSchema = z.object({
  phase: z.string().max(80), at: count,
  durationMs: z.number().finite().nonnegative().optional(), bytes: count.optional(),
  turn: count.optional(), step: count.optional(), requestIndex: count.optional(), sequence: count.optional(), toolIndex: count.optional(),
  childId: z.string().max(160).optional(), callId: z.string().max(256).optional(),
  count: count.optional(), ratio: z.number().finite().min(0).max(1).optional(),
  status: z.enum(['observed', 'unknown', 'success', 'failed', 'cancelled', 'timeout']).optional(),
  usage: z.object({ inputTokens: count.nullable(), outputTokens: count.nullable(), reasoningTokens: count.nullable(), cacheReadTokens: count.nullable(), cacheWriteTokens: count.nullable(), totalTokens: count.nullable() }).strict().optional(),
  payload: planningPayloadSummarySchema.optional(),
  catalogQuery: planningCatalogQuerySummarySchema.optional(),
}).strict()
export type PlanningMetric = z.infer<typeof planningMetricSchema>
type Extra = Omit<PlanningMetric, 'phase' | 'at'>
type Identity = { turn: number; step: number; requestIndex: number }
type Request = Identity & { started: number; closed: boolean; observed: boolean; text: boolean; arguments: boolean }
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')

/** Preserve missing and invalid provider counters as unknown; never derive tokens from bytes. */
export function planningUsageReceipt(data: unknown): NonNullable<PlanningMetric['usage']> {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {}
  let streamed: unknown
  if (Array.isArray(record.stream)) {
    try { streamed = lastAssistantStreamChunk(record.stream as AssistantStreamRecord[], 'usage')?.usage } catch { /* Malformed/unavailable stream cannot supply usage. */ }
  }
  const raw = record.usage ?? streamed
  const usage = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return Object.fromEntries(tokenFields.map(key => [key, Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0 ? usage[key] : null])) as NonNullable<PlanningMetric['usage']>
}

/** Exact duplicate serialized units within this request; not semantic redundancy or a cache-hit rate. */
export function repeatedPayloadRatio(messages: readonly unknown[], tools: readonly unknown[]): number {
  const seen = new Set<string>()
  let total = 0, repeated = 0
  for (const unit of [...messages, ...tools]) {
    const serialized = JSON.stringify(unit) ?? '', size = Buffer.byteLength(serialized, 'utf8')
    total += size
    if (seen.has(serialized)) repeated += size
    seen.add(serialized)
  }
  return total ? repeated / total : 0
}

/** Only timings/counters and bounded public contract summaries. No stream text,
 * reasoning, business values or raw tool arguments are retained. */
export class PlanningMetricRecorder {
  private requestIndex = 0
  private current?: Request
  private readonly seenReceipts = new Set<number>()
  constructor(private readonly emit?: (metric: PlanningMetric) => void, private readonly clock = { wall: () => Date.now(), monotonic: () => performance.now() }) {}
  metric(phase: string, extra: Extra = {}) { this.emit?.({ phase, at: this.clock.wall(), ...extra }) }
  private identity(): Partial<Identity> {
    const current = this.current
    return current ? { turn: current.turn, step: current.step, requestIndex: current.requestIndex } : {}
  }
  private elapsed() { return this.current ? Math.max(0, this.clock.monotonic() - this.current.started) : 0 }
  request(messages: readonly unknown[], tools: readonly unknown[], identity: { turn: number; step: number }, totalBytes: number) {
    // A prior admitted call without a terminal journal event must remain visible.
    this.closePending('unknown')
    this.current = { ...identity, requestIndex: ++this.requestIndex, started: this.clock.monotonic(), closed: false, observed: false, text: false, arguments: false }
    const id = this.identity()
    this.metric('model-request', { ...id, bytes: totalBytes, count: 1 })
    this.metric('model-message-bytes', { ...id, bytes: bytes(messages) })
    this.metric('model-schema-bytes', { ...id, bytes: bytes(tools) })
    this.metric('model-repeated-content', { ...id, ratio: repeatedPayloadRatio(messages, tools) })
    this.metric('provider-queue', { ...id, status: 'unknown' })
    this.metric('provider-prefill', { ...id, status: 'unknown' })
  }
  stream(frame: unknown) {
    const request = this.current
    if (!request || request.closed || !frame || typeof frame !== 'object') return
    const value = frame as { type?: unknown; chunk?: { type?: unknown; text?: unknown; argumentsDelta?: unknown } }
    const id = this.identity(), durationMs = this.elapsed()
    if (!request.observed) { request.observed = true; this.metric('first-observed-delta', { ...id, durationMs, status: 'observed' }) }
    if (value.type !== 'chunk' || !value.chunk) return
    const chunk = value.chunk
    if (!request.text && chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.trim()) {
      request.text = true; this.metric('first-valid-text', { ...id, durationMs, status: 'observed' })
    }
    if (!request.arguments && chunk.type === 'tool-call-delta' && typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta.trim()) {
      request.arguments = true; this.metric('first-valid-tool-arguments', { ...id, durationMs, status: 'observed' })
    }
  }
  response(data: { turn: number; step: number; [key: string]: unknown }, sequence: number, failed: boolean) {
    if (this.seenReceipts.has(sequence)) return
    this.seenReceipts.add(sequence)
    const current = this.current
    const id = current && current.turn === data.turn && current.step === data.step ? this.identity() : { turn: data.turn, step: data.step }
    this.metric('model-usage', { ...id, sequence, usage: planningUsageReceipt(data) })
    if (current && current.turn === data.turn && current.step === data.step && !current.closed) {
      this.metric('model-response', { ...id, sequence, durationMs: this.elapsed(), status: failed ? 'failed' : 'success' })
      this.missingContent(); current.closed = true
    }
  }
  private missingContent() {
    if (!this.current?.text) this.metric('first-valid-text', { ...this.identity(), status: 'unknown' })
    if (!this.current?.arguments) this.metric('first-valid-tool-arguments', { ...this.identity(), status: 'unknown' })
  }
  closePending(status: NonNullable<PlanningMetric['status']>) {
    if (!this.current || this.current.closed) return
    this.metric('model-response', { ...this.identity(), durationMs: this.elapsed(), status })
    this.metric('model-usage', { ...this.identity(), usage: planningUsageReceipt(undefined), status: 'unknown' })
    this.missingContent(); this.current.closed = true
  }
  tool(phase: string, extra: Extra = {}) { this.metric(phase, { ...this.identity(), ...extra }) }
}
