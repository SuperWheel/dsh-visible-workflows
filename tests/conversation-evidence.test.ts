import { describe, expect, it, vi } from 'vitest'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { collectConversationEvidence, conversationEvidenceDigest, validateConversationEvidence, type ConversationQuery } from '../src/host/planning/conversation-evidence.ts'
import { parseTaskProcedure } from '../src/shared/retrospective.ts'

type Row = { type: string; data: any }
const start = (turn: number): Row => ({ type: 'turn/start', data: { turn } })
const end = (turn: number): Row => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
const user = (text: string, kind = 'user'): Row => ({ type: 'user/message', data: createUserMessage({ source: { kind } as any, content: [{ type: 'text', text }] }) })
const assistant = (text: string, turn = 0): Row => ({ type: 'assistant/message', data: { turn, step: 0, stream: [], message: createAssistantMessage({ source: { kind: 'model', provider: 'fixture', model: 'offline' }, content: [{ type: 'text', text }] }) } })
const call = (name = 'calculate', args = '{"month":"September"}', id = 'c1'): Row => ({ type: 'tool/call', data: { turn: 0, step: 0, name, arguments: args, callId: ToolCallId(id) } })
const result = (text = 'total=100', isError = false, id = 'c1'): Row => ({ type: 'tool/result', data: { turn: 0, step: 0, message: createToolResultMessage({ callId: ToolCallId(id), content: [{ type: 'text', text }], isError }), meta: { privateNote: 'private-meta-never-forward' } } })
const normal = () => [start(0), user('汇总本月报销'), call(), result(), assistant('报告已生成'), end(0), start(1), user('将刚才的任务生成工作流')]
function fixture(rows = normal(), options: { inherited?: number; sessionId?: string; subagent?: boolean; cursor?: number } = {}) {
  const events = rows.map((row, seq) => ({ ...row, seq, time: seq, ...(['user/message', 'assistant/message', 'tool/result'].includes(row.type) ? { surfaceOp: 'append' } : {}) })) as SessionEvent[]
  const dispose = vi.fn(), getter = vi.fn(() => events)
  const observation = {
    header: { id: SessionId(options.sessionId ?? 'root'), version: 4, createdAt: 0, isSeeded: !!options.inherited, ...(options.subagent ? { origin: 'subagent', delegationDepth: 1 } : {}) } as SessionHeader,
    inheritedEventCount: options.inherited ?? 0, cursor: options.cursor ?? events.length - 1, get events() { return getter() }, [Symbol.dispose]: dispose,
  }
  const query: ConversationQuery = { observeSession: vi.fn(async () => observation) }
  const collect = (source = { kind: 'current-conversation' as const }) => collectConversationEvidence(query, { sessionId: 'root', source })
  return { query, events, observation, collect, dispose, getter }
}

describe('frozen current-root conversation evidence', () => {
  it('uses a single immutable SDK-shaped observation and excludes its active conversion turn', async () => {
    const f = fixture(), value = await f.collect()
    expect(f.query.observeSession).toHaveBeenCalledExactlyOnceWith('root', { projectionMode: 'none' })
    expect(f.dispose).toHaveBeenCalledOnce()
    expect(value.records.map(record => record.id)).toEqual(['e1', 'e2', 'e3', 'e4'])
    expect(value.fromSeq).toBe(0); expect(value.throughSeq).toBe(5)
    expect(value.records.filter(record => record.kind.startsWith('tool')).map(record => record.status)).toEqual(['reported-success', 'reported-success'])
    expect(JSON.stringify(value)).not.toContain('将刚才')
    expect(validateConversationEvidence(value)).toEqual(value)
  })
  it('rejects foreign-session and child-session reads while releasing the observation', async () => {
    for (const options of [{ sessionId: 'other' }, { subagent: true }]) {
      const f = fixture(normal(), options)
      await expect(f.collect()).rejects.toThrow('当前根对话')
      expect(f.dispose).toHaveBeenCalledOnce()
      expect(f.getter).not.toHaveBeenCalled()
    }
  })
  it('checks the cursor before materializing an oversized history', async () => {
    const f = fixture(normal(), { cursor: 10_000 })
    await expect(f.collect()).rejects.toThrow('10000')
    expect(f.getter).not.toHaveBeenCalled(); expect(f.dispose).toHaveBeenCalledOnce()
  })
  it('excludes fork-inherited prefixes and synthetic closers before the first owned turn', async () => {
    const inherited = [start(8), user('祖先任务'), end(8)]
    const f = fixture([...inherited, { type: 'session/restored', data: { inherited: true } }, ...normal()], { inherited: 3 })
    const value = await f.collect()
    expect(value.fromSeq).toBe(4)
    expect(JSON.stringify(value)).not.toContain('祖先任务')
    expect(value.warnings.join('')).toContain('继承')
    await expect(collectConversationEvidence(f.query, { sessionId: 'root', source: { kind: 'current-conversation', fromSeq: 1 } })).rejects.toThrow('自有')
  })
  it('requires a genuine user source in the active request and in the selected task', async () => {
    const injected = normal(); injected[7] = user('自动任务上下文', 'plugin-notice')
    await expect(fixture(injected).collect()).rejects.toThrow('注入内容')
    const priorInjected = normal(); priorInjected[1] = user('伪装的历史要求', 'plugin-notice')
    await expect(fixture(priorInjected).collect()).rejects.toThrow('真人用户任务要求')
  })
  it('does not accept future events, the current turn, or incomplete prior-turn boundaries', async () => {
    const f = fixture()
    for (const throughSeq of [6, 7, 100]) await expect(collectConversationEvidence(f.query, { sessionId: 'root', source: { kind: 'current-conversation', throughSeq } })).rejects.toThrow('已闭合')
    const unclosed = normal().filter(row => row.type !== 'turn/end')
    await expect(fixture(unclosed).collect()).rejects.toThrow('活动轮次')
  })
  it('admits an explicit earlier task range without mixing later corrections', async () => {
    const rows = [start(0), user('任务一'), assistant('交付一'), end(0), start(1), user('任务二'), assistant('交付二', 1), end(1), start(2), user('整理任务一')]
    const f = fixture(rows)
    const value = await collectConversationEvidence(f.query, { sessionId: 'root', source: { kind: 'current-conversation', fromSeq: 0, throughSeq: 3 } })
    expect(value.records.map(record => record.text)).toEqual(['任务一', '交付一'])
  })
  it('excludes thinking, raw streams, system prompts, injected context and tool private metadata', async () => {
    const rows = normal()
    rows.splice(2, 0, { type: 'system/message', data: { message: { content: [{ type: 'text', text: 'private-system' }] } } }, user('private-injection', 'plugin-notice'))
    const a = rows.find(row => row.type === 'assistant/message')!
    a.data.message = { ...a.data.message, content: [{ type: 'thinking', thinking: 'private-thinking' }, { type: 'text', text: '公开答案' }], source: { ...a.data.message.source, replayState: 'private-replay' } }
    a.data.stream = [{ type: 'thinking', text: 'private-stream' }]
    const value = await fixture(rows).collect()
    expect(JSON.stringify(value)).not.toContain('private-')
    expect(value.records.some(record => record.text === '公开答案')).toBe(true)
  })
  it('redacts structured credential fields and common token strings without leaking private nested keys', async () => {
    const rows = normal(); rows[2] = call('api', JSON.stringify({ api_key: 'api-secret-value', nested: { password: 'password-value', analysis: 'private-analysis', instruction: 'keep' }, url: 'https://example.test?token=token-value' }))
    rows[3] = result('Authorization: Bearer abcDEFGH123456 api_key="quoted-secret" sk-123456789abcdef')
    const value = await fixture(rows).collect(), text = JSON.stringify(value)
    for (const secret of ['api-secret-value', 'password-value', 'private-analysis', 'token-value', 'abcDEFGH123456', 'quoted-secret', 'sk-123456789abcdef']) expect(text).not.toContain(secret)
    expect(text).toContain('keep'); expect(text).toContain('REDACTED')
  })
  it('withholds malformed or oversized structured arguments instead of falling back to raw secret content', async () => {
    for (const args of ['{"api_key":"leak-never","thinking":"private-never"', '{"data":"' + 'x'.repeat(13_000) + '","token":"leak-never"}']) {
      const rows = normal(); rows[2] = call('api', args)
      const value = await fixture(rows).collect(), record = value.records.find(item => item.kind === 'tool-call')!
      expect(record.truncated).toBe(true); expect(record.status).toBe('unknown')
      expect(JSON.stringify(value)).not.toContain('leak-never'); expect(JSON.stringify(value)).not.toContain('private-never')
    }
  })
  it.each(['meta', 'analysis', 'reasoning', 'thinking', 'system', 'developer', 'replayState', 'api_key'])('marks omitted %s fields incomplete instead of treating the remaining object as a full output', async key => {
    const rows = normal(); rows[3] = result(JSON.stringify({ text: 'hello', [key]: { value: 'private-value-never-forward' } }))
    const value = await fixture(rows).collect(), records = value.records.filter(record => record.kind.startsWith('tool'))
    expect(records.every(record => record.status === 'unknown')).toBe(true)
    expect(records.find(record => record.kind === 'tool-result')!.truncated).toBe(true)
    expect(JSON.stringify(value)).not.toContain('private-value-never-forward')
  })
  it('marks textual credential redaction incomplete for both JSON strings and plain tool text', async () => {
    for (const text of ['Bearer abcDEFGH123456', JSON.stringify({ text: 'Bearer abcDEFGH123456' })]) {
      const rows = normal(); rows[3] = result(text)
      const record = (await fixture(rows).collect()).records.find(item => item.kind === 'tool-result')!
      expect(record.truncated).toBe(true); expect(record.status).toBe('unknown')
      expect(record.text).not.toContain('abcDEFGH123456')
    }
  })
  it.each([JSON.stringify(Array.from({ length: 101 }, () => 1)), JSON.stringify(Object.fromEntries(Array.from({ length: 101 }, (_, n) => [`k${n}`, 1])))])('marks nested material limits explicitly even for short serialized content', async args => {
    const rows = normal(); rows[2] = call('calculate', args)
    const value = await fixture(rows).collect(), record = value.records.find(item => item.kind === 'tool-call')!
    expect(record.truncated).toBe(true); expect(record.status).toBe('unknown')
  })
  it.each(['TOOL_OUTCOME_UNKNOWN', 'TOOL_NOT_STARTED'])('keeps restored %s tool outcomes unknown', async code => {
    const rows = normal(); rows[3] = result(code, true)
    const value = await fixture(rows).collect()
    expect(value.records.filter(record => record.kind.startsWith('tool')).every(record => record.status === 'unknown')).toBe(true)
  })
  it('keeps failures and unmatched calls distinct from reported success', async () => {
    const failed = normal(); failed[3] = result('calculation failed', true)
    expect((await fixture(failed).collect()).records.filter(record => record.kind.startsWith('tool')).every(record => record.status === 'failed')).toBe(true)
    const missing = normal().filter(row => row.type !== 'tool/result')
    expect((await fixture(missing).collect()).records.find(record => record.kind === 'tool-call')!.status).toBe('unknown')
  })
  it('never expands child sessions and makes the missing internal process explicit', async () => {
    const rows = normal(); rows[2] = call('subagent', '{"prompt":"完成计算"}'); rows[3] = result('child reported complete')
    const f = fixture(rows), value = await f.collect()
    expect(f.query.observeSession).toHaveBeenCalledOnce()
    expect(value.warnings.join('')).toContain('内部步骤未展开')
    expect(value.records.filter(record => record.kind.startsWith('tool')).every(record => record.status === 'unknown')).toBe(true)
  })
  it('marks non-text attachments and shortened visible text as incomplete without reading files', async () => {
    const rows = normal(); rows[1] = user('输入附件'); rows[1]!.data = { ...rows[1]!.data, content: [{ type: 'text', text: '输入附件' }, { type: 'file', path: '/never-read/private.txt' }] }
    rows[3] = result('x'.repeat(3000))
    const value = await fixture(rows).collect()
    expect(value.records.find(record => record.kind === 'user')!.truncated).toBe(true)
    expect(value.records.find(record => record.kind === 'tool-result')!.status).toBe('unknown')
    expect(value.records.find(record => record.kind === 'tool-call')!.status).toBe('unknown')
    expect(JSON.stringify(value)).not.toContain('/never-read')
  })
  it('cannot bypass result uncertainty by citing only its call and excluding the excerpted result', async () => {
    for (const nonText of [false, true]) {
      const rows = normal(); rows[3] = result(nonText ? '附件已生成' : 'x'.repeat(3000))
      if (nonText) rows[3]!.data.message = { ...rows[3]!.data.message, content: [{ type: 'text', text: '附件已生成' }, { type: 'file', path: '/not-read/output.pdf' }] }
      const value = await fixture(rows).collect()
      const candidate = { goal: '汇总', parameters: [], rules: [], steps: [{ id: 'S1', title: '计算', instruction: '使用计算工具', dependsOn: [], evidenceRefs: ['e1', 'e2'], requiresReview: false }], excluded: [{ evidenceRefs: ['e3', 'e4'], reason: '省略结果和重复总结' }], reviewItems: [] }
      expect(() => parseTaskProcedure(candidate, value)).toThrow('必须标记复核')
      candidate.steps[0]!.requiresReview = true; candidate.reviewItems.push('重新确认未完整保留的工具结果')
      expect(parseTaskProcedure(candidate, value).steps[0]!.requiresReview).toBe(true)
    }
  })
  it('never requires a review note for unknown, cut-off or failed trial evidence; conversation evidence still does (Desktop r40, r43-2 A)', async () => {
    const rows = normal(); rows[3] = result('x'.repeat(3000))
    const value = await fixture(rows).collect()
    const candidate = { goal: '汇总', parameters: [], rules: [], steps: [{ id: 'S1', title: '计算', instruction: '使用计算工具', dependsOn: [], evidenceRefs: ['e1', 'e2', 'e3', 'e4'], requiresReview: false }], excluded: [], reviewItems: [] as string[] }
    expect(() => parseTaskProcedure(candidate, value)).toThrow('必须标记复核')
    expect(parseTaskProcedure(candidate, value, [], true).steps[0]!.requiresReview).toBe(false)
    // An expected-failure write-before probe cited by a step, with no notes at all.
    const failed = { ...value, records: value.records.map(record => record.kind === 'tool-result' ? { ...record, status: 'failed' as const } : record) }
    expect(() => parseTaskProcedure(candidate, failed)).toThrow('必须标记复核')
    expect(parseTaskProcedure(candidate, failed, [], true).reviewItems).toEqual([])
  })
  it('retains complete reported results while explicitly marking incomplete arguments', async () => {
    const rows = normal(); rows[2] = call('calculate', JSON.stringify({ content: 'x'.repeat(3000) }))
    const value = await fixture(rows).collect()
    expect(value.records.find(record => record.kind === 'tool-call')!.status).toBe('unknown')
    expect(value.records.find(record => record.kind === 'tool-result')!.status).toBe('reported-success')
  })
  it('bounds joined public text across huge blocks and does not silently discard a whitespace prefix', async () => {
    const rows = normal(); rows[3] = result()
    rows[3]!.data.message = { ...rows[3]!.data.message, content: [{ type: 'text', text: ' '.repeat(100_000) }, { type: 'text', text: 'result-after-prefix' }] }
    const value = await fixture(rows).collect(), toolResult = value.records.find(record => record.kind === 'tool-result')!
    expect(toolResult.text.length).toBeLessThan(1900)
    expect(toolResult.truncated).toBe(true); expect(toolResult.status).toBe('unknown')
    expect(value.records.find(record => record.kind === 'tool-call')!.status).toBe('unknown')
  })
  it('rejects too many records or bytes rather than silently discarding them', async () => {
    const many = [start(0), user('生成'), ...Array.from({ length: 100 }, () => assistant('a')), end(0), start(1), user('转换')]
    await expect(fixture(many).collect()).rejects.toThrow('100 条')
    const large = [start(0), user('生成'), ...Array.from({ length: 30 }, () => assistant('x'.repeat(1600))), end(0), start(1), user('转换')]
    await expect(fixture(large).collect()).rejects.toThrow('24 KB')
  })
  it('fails on noncontiguous logs and releases a cancelled observation', async () => {
    const f = fixture(); (f.events[2] as any).seq = 20
    await expect(f.collect()).rejects.toThrow('不连续'); expect(f.dispose).toHaveBeenCalledOnce()
    const cancelled = fixture(), controller = new AbortController()
    cancelled.query.observeSession = vi.fn(async () => { controller.abort(); return cancelled.observation })
    await expect(collectConversationEvidence(cancelled.query, { sessionId: 'root', source: { kind: 'current-conversation' }, signal: controller.signal })).rejects.toThrow()
    expect(cancelled.dispose).toHaveBeenCalledOnce()
  })
  it('binds the digest to exact material, range and identity, independent of object key order', async () => {
    const value = await fixture().collect()
    expect(conversationEvidenceDigest({ warnings: value.warnings, records: value.records, throughSeq: value.throughSeq, fromSeq: value.fromSeq, sessionId: value.sessionId, version: 1 })).toBe(value.digest)
    for (const change of [
      (item: typeof value) => { item.records[0]!.text = '篡改要求' },
      (item: typeof value) => { item.sessionId = 'other' },
      (item: typeof value) => { item.throughSeq = 6 },
    ]) { const modified = structuredClone(value); change(modified); expect(() => validateConversationEvidence(modified)).toThrow('摘要不匹配') }
  })
})
