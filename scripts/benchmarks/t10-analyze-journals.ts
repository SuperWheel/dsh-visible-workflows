/** Offline T10 accounting. Run against the pre-fix checkout to reconstruct exact
 * public requests; every body digest must match T09 before attributing bytes.
 * No PairJournal writer, provider transport or business execution is constructed.
 * Usage: node --import tsx scripts/benchmarks/t10-analyze-journals.ts JOURNAL_ROOT OUTPUT_JSON
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { runPairArm, slotKey, type FrozenPair, type PairResult } from './template-fill-paired.ts'
import { jsonDigest } from '../../src/shared/planning-repair.ts'

const root = process.argv[2], output = process.argv[3]
assert.ok(root && output, 'JOURNAL_ROOT and OUTPUT_JSON are required; no model calls are supported')
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)
const median = (values: number[]) => { const v = [...values].sort((a, b) => a - b); return v.length % 2 ? v[(v.length - 1) / 2]! : (v[v.length / 2 - 1]! + v[v.length / 2]!) / 2 }
const attempts: any[] = [], requests: any[] = [], sources: any[] = []
for (const shard of ['1', '2b', '3', '4']) {
  const directory = resolve(root, `shard-${shard}`)
  const frozen: FrozenPair = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))
  const raw = readFileSync(resolve(directory, 'events.jsonl'))
  sources.push({ shard, sha256: createHash('sha256').update(raw).digest('hex'), manifestDigest: frozen.digest })
  const events = raw.toString().trim().split('\n').map(line => JSON.parse(line).event)
  for (const { result: original } of events.filter(e => e.kind === 'result') as { result: PairResult }[]) {
    const slot = { sourceLayer: original.sourceLayer, caseId: original.caseId, repeat: original.repeat, arm: original.arm, position: original.position }
    const starts = events.filter(e => e.kind === 'call-start' && slotKey(e.slot) === slotKey(slot))
    const ends = events.filter(e => e.kind === 'call-end' && slotKey(e.slot) === slotKey(slot))
    let count = 0, digestError: unknown
    const replay = await runPairArm(frozen, slot, { request: async (body) => {
      const index = count++, start = starts[index], end = ends[index]
      try {
        assert.ok(start && end, 'Missing journal request')
        const publicBody = { ...body, messages: (body.messages as any[]).map(message => Object.fromEntries(Object.entries(message).filter(([key]) => !['reasoning_content', 'reasoning'].includes(key)))) }
        assert.equal(jsonDigest(publicBody), start.bodyDigest, `Request drift: ${shard}/${slotKey(slot)}/${index + 1}`)
        assert.ok(bytes(body) <= start.payload.inputBytes, 'Public replay cannot exceed recorded wire bytes')
        const privateContinuationBytes = start.payload.inputBytes - bytes(body)
        const messages = body.messages as any[], prompt = JSON.parse(messages[1].content)
        const catalogIds = new Set(messages.flatMap(m => (m.tool_calls ?? []).filter((c: any) => /^planner_.*(?:catalog|templates)$/.test(c.function.name)).map((c: any) => c.id)))
        const initialCatalogBytes = sum(['templateCatalog', 'semantics', 'runtimeSemantics'].filter(key => prompt[key] !== undefined).map(key => bytes(JSON.stringify(prompt[key])) - 2))
        const queryReplyBytes = sum(messages.filter(m => m.role === 'tool' && catalogIds.has(m.tool_call_id)).map(m => bytes(m.content)))
        const systemInstructionBytes = bytes(messages[0].content)
        const requirementBytes = bytes(JSON.stringify(prompt.requirement)) - 2
        requests.push({ shard, ...slot, request: index + 1, roundTripMs: end.wallMs, ...start.payload, reportedTokens: original.calls[index]!.reportedTokens, tokenUsage: original.calls[index]!.tokenUsage,
          // JSON-escaped UTF-8 values as embedded in the wire body. Disjoint
          // categories; residual includes keys, envelope, graph and other history.
          initialCatalogBytes, queryReplyBytes, systemInstructionBytes, requirementBytes, privateContinuationBytes,
          otherBytes: start.payload.inputBytes - start.payload.schemaBytes - initialCatalogBytes - queryReplyBytes - systemInstructionBytes - requirementBytes - privateContinuationBytes,
          templateCatalogBytes: prompt.templateCatalog === undefined ? 0 : bytes(JSON.stringify(prompt.templateCatalog)) - 2 })
      } catch (error) { digestError = error; throw error }
      return structuredClone(end.response)
    } }, async () => original.oracle!)
    if (digestError) throw digestError
    assert.equal(count, original.requests)
    assert.equal(replay.status, original.status)
    attempts.push({ shard, ...slot, status: original.status, requests: original.requests, catalogCalls: original.catalogCalls, submissions: original.submissions, timing: original.timing, usage: original.usage })
  }
}
assert.equal(attempts.length, 48, 'This accounting is restricted to the 48 valid T09 attempts')
assert.equal(requests.length, 90, 'This accounting is restricted to the 90 completed T09 requests')
for (const request of requests) for (const field of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens'])
  assert.equal(typeof request.tokenUsage[field], 'number', `Unknown ${field}; do not aggregate it as zero`)
for (const attempt of attempts) for (const field of ['designWallMs', 'modelRoundTripMs', 'compilerMs', 'assemblyMs', 'preparationMs', 'catalogMs', 'persistenceMs'])
  assert.equal(typeof attempt.timing[field], 'number', `Unknown ${field}; do not aggregate it as zero`)
const groups = ['compact-repair', 'template-fill'].map(arm => {
  const a = attempts.filter(a => a.arm === arm), r = requests.filter(r => r.arm === arm)
  const fields = ['designWallMs', 'modelRoundTripMs', 'compilerMs', 'assemblyMs', 'preparationMs', 'catalogMs', 'persistenceMs']
  const timing = Object.fromEntries(fields.map(field => [field, sum(a.map(a => a.timing[field]))]))
  const byteFields = ['inputBytes', 'messageBytes', 'schemaBytes', 'initialCatalogBytes', 'queryReplyBytes', 'systemInstructionBytes', 'requirementBytes', 'otherBytes', 'privateContinuationBytes', 'templateCatalogBytes']
  return { arm, attempts: a.length, successes: a.filter(a => a.status === 'success').length, requests: r.length,
    requestsPerAttempt: a.map(a => ({ caseId: a.caseId, repeat: a.repeat, requests: a.requests })),
    requestCountDistribution: Object.fromEntries([...new Set(a.map(a => a.requests))].sort().map(n => [n, a.filter(a => a.requests === n).length])),
    roundTripMs: { total: sum(r.map(r => r.roundTripMs)), median: median(r.map(r => r.roundTripMs)), mean: sum(r.map(r => r.roundTripMs)) / r.length, min: Math.min(...r.map(r => r.roundTripMs)), max: Math.max(...r.map(r => r.roundTripMs)) },
    timing, byteTotals: Object.fromEntries(byteFields.map(field => [field, sum(r.map(r => r[field]))])),
    reportedTokens: sum(r.map(r => r.reportedTokens)), tokenTotals: Object.fromEntries(['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens'].map(field => [field, sum(r.map(r => r.tokenUsage[field]))])),
    firstRequestMeanBytes: sum(r.filter(r => r.request === 1).map(r => r.inputBytes)) / a.length,
    successfulAttempts: { medianDesignMs: median(a.filter(a => a.status === 'success').map(a => a.timing.designWallMs)), modelMs: sum(a.filter(a => a.status === 'success').map(a => a.timing.modelRoundTripMs)), requests: sum(a.filter(a => a.status === 'success').map(a => a.requests)) },
  }
})
writeFileSync(output, JSON.stringify({ scope: 'Only 48 completed valid T09 attempts; void/aborted journals excluded. All 90 reconstructed public request digests verified. Wire byte counts come from journal receipts; private reasoning bodies were intentionally not journaled, and their extra wire bytes are reported separately. Tokens are provider reports, bytes are wire JSON UTF-8, never token estimates. assemblyMs already includes preparationMs; persistenceMs includes bookkeeping around oracle and is not a disjoint design span. Provider queue/prefill/generation are unknown.', sources, groups, attempts, requests }, null, 2) + '\n')
console.log(JSON.stringify({ verifiedRequests: requests.length, groups }, null, 2))
