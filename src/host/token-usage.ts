import type { TokenUsage } from './runtime.ts'

/** Only the provider's exact full-call total settles a reservation; missing usage is not zero. */
export function reportedTokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const usage = value as Record<string, unknown>
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  if (!count(usage.totalTokens)) return undefined
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    if (usage[key] !== undefined && !count(usage[key])) return undefined
  }
  const measured = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].reduce((sum, key) => sum + (count(usage[key]) ? usage[key] : 0), 0)
  if (measured > usage.totalTokens) return undefined
  return { totalTokens: usage.totalTokens, ...(count(usage.inputTokens) ? { inputTokens: usage.inputTokens } : {}), ...(count(usage.outputTokens) ? { outputTokens: usage.outputTokens } : {}) }
}

/** Includes failed/retried model attempts, not just successful assistant messages. */
export function sessionTokenUsage(events: readonly { type: string; data: unknown }[]): TokenUsage | undefined {
  const calls = events.filter(event => event.type === 'assistant/message' || event.type === 'assistant/attempt')
  if (!calls.length) return undefined
  let totalTokens = 0, inputTokens = 0, outputTokens = 0, completeInput = true, completeOutput = true
  for (const event of calls) {
    const data = event.data as { usage?: unknown; stream?: { type?: string; chunk?: { type?: string; usage?: unknown } }[] }
    const latest = data.stream?.filter(record => record.type === 'chunk' && record.chunk?.type === 'usage').at(-1)?.chunk?.usage
    const usage = reportedTokenUsage(data.usage ?? latest)
    if (!usage) return undefined
    totalTokens += usage.totalTokens
    if (!Number.isSafeInteger(totalTokens)) return undefined
    if (usage.inputTokens === undefined) completeInput = false
    else inputTokens += usage.inputTokens
    if (usage.outputTokens === undefined) completeOutput = false
    else outputTokens += usage.outputTokens
  }
  return { totalTokens, ...(completeInput ? { inputTokens } : {}), ...(completeOutput ? { outputTokens } : {}) }
}
