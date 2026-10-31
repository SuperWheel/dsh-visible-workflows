import { createHash } from 'node:crypto'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  conversationSourceSchema, parseConversationEvidence, type ConversationEvidence, type ConversationEvidenceRecord, type ConversationSource,
} from '../../shared/retrospective.ts'

/** Structural view of the official SessionObservation; no corpus search or deprecated snapshots. */
export interface ConversationQuery {
  observeSession(id: SessionId, options: { projectionMode: 'none'; signal?: AbortSignal }): Promise<Disposable & {
    readonly header: SessionHeader; readonly inheritedEventCount: number; readonly cursor: number; readonly events: readonly SessionEvent[]
  }>
}
export const CONVERSATION_EVIDENCE_LIMITS = { sessionEvents: 10_000, records: 100, bytes: 24_000, recordChars: 1800 } as const

/** Fixed field order is independent of caller object insertion order. */
export function conversationEvidenceDigest(value: Omit<ConversationEvidence, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify({
    version: value.version, sessionId: value.sessionId, fromSeq: value.fromSeq, throughSeq: value.throughSeq,
    records: value.records.map(record => ({
      id: record.id, seq: record.seq, kind: record.kind, text: record.text, status: record.status,
      ...(record.toolName !== undefined ? { toolName: record.toolName } : {}), ...(record.callId !== undefined ? { callId: record.callId } : {}), truncated: record.truncated,
    })), warnings: value.warnings,
  })).digest('hex')
}

export function validateConversationEvidence(value: unknown): ConversationEvidence {
  const evidence = parseConversationEvidence(value)
  if (conversationEvidenceDigest(evidence) !== evidence.digest) throw new Error('当前对话证据摘要不匹配')
  if (Buffer.byteLength(JSON.stringify(evidence), 'utf8') > CONVERSATION_EVIDENCE_LIMITS.bytes) throw new Error('当前对话证据超过 24 KB，请缩小任务范围')
  return evidence
}

const secretKey = /(?:password|passwd|authorization|credential|client.?secret|api.?key|access.?token|refresh.?token|private.?key|secret|^token$|^bearer$)/i
const privateKey = /^(?:thinking|reasoning|analysis|system|developer|meta|replayState)$/i
const childTool = /subagent|spawn_agent|delegate|cliworker/i
const unknownOutcome = /TOOL_(?:NOT_STARTED|OUTCOME_UNKNOWN)|(?:"|\b)(?:outcome|status)(?:"|\b)\s*[:=]\s*"?(?:unknown|interrupted|not.started)/i

/** Defense in depth for common credentials, not a guarantee of automatic secret detection. */
function redactText(value: string): string {
  return value
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/g, '[REDACTED TOKEN]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|authorization|secret|token)["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;\n}]+)/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&#\s]*/gi, '$1[REDACTED]')
}

function publicJson(value: unknown, state: { omitted: boolean }, depth = 0): unknown {
  if (depth > 8) { state.omitted = true; return '[OMITTED DEPTH]' }
  if (typeof value === 'string') {
    const visible = redactText(value.slice(0, 12_000))
    if (visible !== value) state.omitted = true
    return visible
  }
  if (Array.isArray(value)) {
    if (value.length > 100) state.omitted = true
    return value.slice(0, 100).map(item => publicJson(item, state, depth + 1))
  }
  if (value && typeof value === 'object') {
    if (Object.keys(value).length > 100) state.omitted = true
    return Object.fromEntries(Object.entries(value).slice(0, 100).flatMap(([key, item]) => {
      if (privateKey.test(key)) { state.omitted = true; return [] }
      if (secretKey.test(key)) { state.omitted = true; return [[key, '[REDACTED]']] }
      return [[key, publicJson(item, state, depth + 1)]]
    }))
  }
  return value
}

/** Appended to every cut-off record; readers of the excerpt strip it before decoding. */
export const EXCERPT_MARK = '\n[摘录：原记录未完整保留]'
function excerpt(raw: string, structured = false): { text: string; truncated: boolean } {
  const rawTruncated = raw.length > 12_000
  const state = { omitted: rawTruncated }
  let clean: string
  try { clean = JSON.stringify(publicJson(JSON.parse(raw.slice(0, 12_000)), state)) } catch {
    if (structured || /^[\s]*[\[{]/.test(raw)) { clean = '[结构化材料无法完整解析，未保留原始内容]'; state.omitted = true }
    else { clean = redactText(raw.slice(0, 12_000)); if (clean !== raw) state.omitted = true }
  }
  // Every omission (including nested JSON limits) makes the source incomplete.
  const truncated = state.omitted || clean.length > CONVERSATION_EVIDENCE_LIMITS.recordChars
  return { text: clean.slice(0, CONVERSATION_EVIDENCE_LIMITS.recordChars) + (truncated ? EXCERPT_MARK : ''), truncated }
}

function publicText(message: { content: readonly unknown[] }): { text: string; omitted: boolean } {
  const texts: string[] = []
  let omitted = false, remaining = 12_001
  for (const block of message.content) {
    if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string') {
      if (remaining > 0) {
        const text = (texts.length ? '\n' : '') + block.text.slice(0, remaining)
        texts.push(text.slice(0, remaining)); remaining -= Math.min(text.length, remaining)
      }
    }
    else if (!(block && typeof block === 'object' && 'type' in block && ['thinking', 'reasoning'].includes(String(block.type)))) omitted = true
  }
  return { text: texts.join(''), omitted }
}

// Trial children reuse exactly the same public-content filtering and limits.
export { excerpt as publicEvidenceExcerpt, publicText as publicEvidenceText }

/** One immutable, bounded observation of the trusted caller's current root conversation. */
export async function collectConversationEvidence(query: ConversationQuery, options: {
  sessionId: string; source: ConversationSource; signal?: AbortSignal
}): Promise<ConversationEvidence> {
  const source = conversationSourceSchema.parse(options.source)
  options.signal?.throwIfAborted()
  const observation = await query.observeSession(SessionId(options.sessionId), { projectionMode: 'none', ...(options.signal ? { signal: options.signal } : {}) })
  try {
    options.signal?.throwIfAborted()
    if (observation.header.id !== options.sessionId || observation.header.origin === 'subagent' || (observation.header.delegationDepth ?? 0) > 0)
      throw new Error('仅允许读取当前根对话自己的任务记录')
    if (!Number.isSafeInteger(observation.cursor) || observation.cursor < 0 || observation.cursor >= CONVERSATION_EVIDENCE_LIMITS.sessionEvents)
      throw new Error('当前会话日志为空或超过 10000 个事件；首版不自动截断超大日志')
    const inherited = observation.inheritedEventCount
    if (!Number.isSafeInteger(inherited) || inherited < 0 || inherited > observation.cursor + 1 || (inherited > 0 && !observation.header.isSeeded)) throw new Error('会话继承边界不可验证')
    // cursor is checked before this lazy getter can materialize the full log.
    const events = observation.events
    if (events.length !== observation.cursor + 1 || events.some((event, index) => event.seq !== index)) throw new Error('会话事件序号不连续，无法固定证据范围')
    const starts = new Map<number, number>()
    const endings = new Map<number, { seq: number; completed: boolean }>()
    for (let index = inherited; index < events.length; index++) {
      const event = events[index]!
      if (event.type === 'turn/start') {
        if (starts.has(event.data.turn)) throw new Error('会话轮次边界重复')
        starts.set(event.data.turn, event.seq)
      } else if (event.type === 'turn/end' && starts.has(event.data.turn)) endings.set(event.data.turn, { seq: event.seq, completed: event.data.reason.kind === 'completed' })
    }
    const active = [...starts].filter(([turn]) => !endings.has(turn))
    if (active.length !== 1) throw new Error('无法确定当前转换请求所在的活动轮次')
    const activeStart = active[0]![1]
    if (!events.slice(activeStart).some(event => event.type === 'user/message' && event.data.source.kind === 'user'))
      throw new Error('当前转换轮次缺少真人用户消息，注入内容不能发起任务提炼')
    const completedEnds = [...endings.values()].filter(end => end.seq < activeStart)
    if (!completedEnds.length) throw new Error('当前对话尚无已闭合的任务历史可提炼')
    const lastClosed = Math.max(...completedEnds.map(end => end.seq))
    const ownStart = Math.min(...starts.values())
    const fromSeq = source.fromSeq ?? ownStart
    const throughSeq = source.throughSeq ?? lastClosed
    if (fromSeq < ownStart || throughSeq > lastClosed || fromSeq > throughSeq || throughSeq >= activeStart) throw new Error('选择范围必须位于当前对话自有且已闭合的历史内')
    const selected = events.slice(fromSeq, throughSeq + 1)
    const warnings = new Set<string>(['工具成功仅代表调用报告成功；公开助手陈述不等于业务验收。', '仅采集根对话公开文字，不读取附件正文、文件内容或子会话；自动脱敏不能保证识别所有敏感信息。'])
    if (inherited) warnings.add('已排除从其他会话继承的事件前缀。')
    const calls = new Map<string, Extract<SessionEvent, { type: 'tool/call' }>>()
    const results = new Map<string, Extract<SessionEvent, { type: 'tool/result' }>>()
    for (const event of selected) {
      if (event.type === 'tool/call') { if (calls.has(event.data.callId)) throw new Error('工具调用身份重复'); calls.set(event.data.callId, event) }
      if (event.type === 'tool/result') { if (results.has(event.data.message.toolCallId)) throw new Error('工具结果身份重复'); results.set(event.data.message.toolCallId, event) }
    }
    const records: ConversationEvidenceRecord[] = []
    for (const event of selected) {
      options.signal?.throwIfAborted()
      let kind: ConversationEvidenceRecord['kind'], raw: string, status: ConversationEvidenceRecord['status'] = 'statement'
      let toolName: string | undefined, callId: string | undefined, omitted = false
      if (event.type === 'user/message') {
        if (event.data.source.kind !== 'user') continue
        kind = 'user'; const visible = publicText(event.data); raw = visible.text; omitted = visible.omitted
      } else if (event.type === 'assistant/message') {
        kind = 'assistant'; const visible = publicText(event.data.message); raw = visible.text; omitted = visible.omitted
        if (event.data.interrupted || !endings.get(event.data.turn)?.completed) status = 'unknown'
      } else if (event.type === 'tool/call') {
        kind = 'tool-call'; callId = event.data.callId; toolName = event.data.name; raw = event.data.arguments
        const result = results.get(callId)
        status = !result || unknownOutcome.test(publicText(result.data.message).text + (result?.data.error?.code ?? '')) ? 'unknown' : result.data.message.isError ? 'failed' : 'reported-success'
      } else if (event.type === 'tool/result') {
        kind = 'tool-result'; callId = event.data.message.toolCallId; toolName = calls.get(callId)?.data.name
        const visible = publicText(event.data.message); raw = visible.text; omitted = visible.omitted
        status = !calls.has(callId) || unknownOutcome.test(raw + (event.data.error?.code ?? '')) ? 'unknown' : event.data.message.isError ? 'failed' : 'reported-success'
      } else continue
      if (!raw.trim() && !omitted && raw.length <= 12_000) continue
      const value = excerpt(raw || '[非文本材料未展开]', kind === 'tool-call')
      if (omitted) { value.truncated = true; warnings.add('部分记录含非文本材料，未读取其正文，相关步骤需复核。') }
      if (toolName && childTool.test(toolName)) { status = 'unknown'; warnings.add('子 Agent 或外部执行器仅保留根对话中的调用与结果摘要，内部步骤未展开。') }
      if (value.truncated) { status = 'unknown'; warnings.add('部分记录只保留摘录；不得把摘录当作完整成功证据。') }
      if (status === 'unknown' || status === 'failed') warnings.add('记录包含失败、未完成或未知结果，提炼时须说明排除理由或保留复核项。')
      records.push({ id: `e${event.seq}`, seq: event.seq, kind, text: value.text, status, ...(toolName ? { toolName } : {}), ...(callId ? { callId } : {}), truncated: value.truncated })
      if (records.length > CONVERSATION_EVIDENCE_LIMITS.records) throw new Error('所选任务超过 100 条公开记录，请缩小任务范围，禁止静默丢弃步骤')
    }
    // A call cannot be used as a "success" shortcut around an incomplete result.
    // The inverse is intentionally asymmetric: complete result text remains a
    // reported result even when its arguments were too long to retain.
    const visibleResults = new Map(records.filter(record => record.kind === 'tool-result').map(record => [record.callId!, record]))
    for (const record of records) {
      if (record.kind !== 'tool-call') continue
      const result = visibleResults.get(record.callId!)
      if (!result || result.status === 'unknown') record.status = 'unknown'
      else if (result.status === 'failed' && record.status !== 'unknown') record.status = 'failed'
    }
    if (!records.length || !records.some(record => record.kind === 'user')) throw new Error('所选范围没有真人用户任务要求，请扩展到相应用户消息')
    const value = { version: 1 as const, sessionId: options.sessionId, fromSeq, throughSeq, records, warnings: [...warnings] }
    return validateConversationEvidence({ ...value, digest: conversationEvidenceDigest(value) })
  } finally { observation[Symbol.dispose]() }
}
