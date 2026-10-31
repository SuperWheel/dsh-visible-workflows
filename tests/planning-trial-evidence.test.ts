import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { parsePlanningTrialSpec, type TrialPublicEvent, type TrialVerificationReport } from '../src/shared/planning-trial.ts'
import { captureTrialFiles, planningTrialSpecDigest, verifyTrialArtifacts } from '../src/host/planning/trial-verification.ts'
import { buildTrialEvidence, compactTrialEvidence, projectTrialEvent, validateVerifiedTrialEvidence } from '../src/host/planning/trial-evidence.ts'

let root: string, report: TrialVerificationReport, reviewReport: TrialVerificationReport, failedReport: TrialVerificationReport
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'trial-evidence-'))
  for (const reviewItems of [[], ['用户确认报告语气']]) {
    const spec = parsePlanningTrialSpec({ task: 'Make a greeting', tools: ['write'], artifacts: [{ path: 'out.json', format: 'json', checks: [{ kind: 'json-equals', pointer: '/text', value: '你好，Ada！' }] }], reviewItems })
    const before = await captureTrialFiles({ workspaceRoot: root, spec, authorize() {} })
    if (!reviewItems.length) failedReport = verifyTrialArtifacts({ spec, before, after: before })
    await writeFile(join(root, 'out.json'), '{"text":"你好，Ada！"}')
    const verified = verifyTrialArtifacts({ spec, before, after: await captureTrialFiles({ workspaceRoot: root, spec, authorize() {} }) })
    if (reviewItems.length) reviewReport = verified; else report = verified
    expect(verified.specDigest).toBe(planningTrialSpecDigest(spec))
  }
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })
const events = (): TrialPublicEvent[] => [
  { seq: 0, type: 'turn/start', turn: 0 },
  { seq: 1, type: 'user/message', source: 'host', text: 'Host-owned task request, not a human quote', truncated: false },
  { seq: 2, type: 'tool/call', turn: 0, callId: 'write1', toolName: 'write', text: '{"file_path":"out.json","content":"你好，Ada！"}', truncated: false },
  { seq: 3, type: 'tool/result', turn: 0, callId: 'write1', text: '{"text":"你好，Ada！"}', truncated: false, isError: false },
  { seq: 4, type: 'assistant/message', turn: 0, text: 'Done', truncated: false, interrupted: false },
  { seq: 5, type: 'turn/end', turn: 0, completed: true },
]
function build(overrides: Partial<Parameters<typeof buildTrialEvidence>[0]> = {}) {
  return buildTrialEvidence({ trialId: 'trial-1', workspaceId: 'workspace-1', rootSessionId: 'root-1', childSessionId: 'child-1', specDigest: report.specDigest, verification: report, events: events(), evidenceIncomplete: false, ...overrides })
}
describe('owned trial public evidence', () => {
  it('binds the real child identity and preserves exact complete results without inventing a wrapper', () => {
    const bundle = build()
    expect(bundle.evidence.sessionId).toBe('child-1'); expect(bundle.binding.rootSessionId).toBe('root-1')
    expect(bundle.evidence.records.map(record => record.id)).toEqual(['e2', 'e3', 'e4'])
    expect(bundle.evidence.records[1]?.text).toBe('{"text":"你好，Ada！"}')
    expect(bundle.evidence.records.slice(0, 2).map(record => record.status)).toEqual(['reported-success', 'reported-success'])
    expect(validateVerifiedTrialEvidence(JSON.parse(JSON.stringify(bundle)))).toEqual(bundle)
    expect(JSON.stringify(bundle)).not.toContain('Host-owned task request')
  })
  it('rejects false root identity and digest tampering on restore', () => {
    expect(() => build({ childSessionId: 'root-1' })).toThrow('冒充')
    const bundle = build(); bundle.evidence.records[0]!.text = 'tampered'
    expect(() => validateVerifiedTrialEvidence(bundle)).toThrow('摘要')
    const other = build(); other.binding.childSessionId = 'other-child'
    expect(() => validateVerifiedTrialEvidence(other)).toThrow('身份')
  })
  it('ignores a long Host-owned execution prompt without making task results incomplete', () => {
    const rows = events(); (rows[1] as Extract<TrialPublicEvent, { type: 'user/message' }>).truncated = true
    const bundle = build({ events: rows })
    expect(bundle.evidence.records.map(record => record.id)).toEqual(['e2', 'e3', 'e4'])
    expect(bundle.evidence.records[1]?.status).toBe('reported-success')
  })
  it('retains failed checks as warnings, but rejects mismatched frozen specifications',()=>{
    const bundle=build({verification:failedReport})
    expect(bundle.evidence.warnings.join(' ')).toContain('未通过')
    expect(bundle.binding.verificationDigest).toBe(failedReport.digest)
    expect(()=>build({specDigest:'f'.repeat(64)})).toThrow('摘要不匹配')
  })
  it('accepts final review notes without human confirmation and still reads legacy human receipts',()=>{
    const bundle=build({verification:reviewReport,specDigest:reviewReport.specDigest})
    expect(bundle.binding.humanReview).toBeUndefined()
    const humanReview={accepted:true as const,questionId:'q-review',answeredAt:new Date(0).toISOString()}
    expect(build({verification:reviewReport,specDigest:reviewReport.specDigest,humanReview}).binding.humanReview).toEqual(humanReview)
  })
  it('does not accept assistant claims, structured_output, delegated summaries or failed tools as execution', () => {
    expect(() => build({ events: events().filter(event => !event.type.startsWith('tool/')) })).toThrow('业务工具')
    for (const toolName of ['structured_output', 'native:structured_output', 'spawn_agent']) {
      const rows = events(); (rows[2] as Extract<TrialPublicEvent, { type: 'tool/call' }>).toolName = toolName
      expect(() => build({ events: rows })).toThrow('业务工具')
    }
    const failed = events(); (failed[3] as Extract<TrialPublicEvent, { type: 'tool/result' }>).isError = true
    expect(() => build({ events: failed })).toThrow('业务工具')
  })
  it('rejects incomplete, unfinished and unmatched execution evidence', () => {
    expect(() => build({ evidenceIncomplete: true })).toThrow('不完整')
    expect(() => build({ events: events().slice(0, -1) })).toThrow('尚未完整结束')
    expect(() => build({ events: events().filter(event => event.type !== 'tool/result') })).toThrow('业务工具')
    const duplicates = events(); duplicates[3]!.seq = 2
    expect(() => build({ events: duplicates })).toThrow('身份重复')
  })
  it('rejects a missing tool result even when another business call succeeded',()=>{
    const rows=events(),end=rows.pop()!
    rows.push({seq:5,type:'tool/call',turn:0,callId:'missing-result',toolName:'read',text:'{}',truncated:false},{...end,seq:6})
    expect(()=>build({events:rows})).toThrow('未完整配对')
  })
  it('counts a truncated but reported-successful call for the gate while keeping its records unknown', () => {
    const rows = events(); (rows[2] as Extract<TrialPublicEvent, { type: 'tool/call' }>).truncated = true; (rows[3] as Extract<TrialPublicEvent, { type: 'tool/result' }>).truncated = true
    const bundle = build({ events: rows })
    expect(bundle.evidence.records.slice(0, 2).map(record => record.status)).toEqual(['unknown', 'unknown'])
    expect(bundle.evidence.warnings.join(' ')).toContain('摘录已截断')
    expect(build().evidence.warnings.join(' ')).not.toContain('摘录已截断')
    const unknown = events(); Object.assign(unknown[3]!, { truncated: true, text: '{"status":"interrupted"' })
    expect(() => build({ events: unknown })).toThrow('业务工具')
    const failed = events(); Object.assign(failed[3]!, { truncated: true, isError: true })
    expect(() => build({ events: failed })).toThrow('业务工具')
  })
  it('marks additional incomplete evidence unknown without contaminating a complete result contract', () => {
    const rows = events(); rows.splice(4, 0,
      { seq: 4, type: 'tool/call', turn: 0, callId: 'extra', toolName: 'read', text: '{}', truncated: false },
      { seq: 5, type: 'tool/result', turn: 0, callId: 'extra', text: '[摘录]', truncated: true, isError: false })
    rows[6]!.seq = 6; rows[7]!.seq = 7
    const bundle = build({ events: rows })
    expect(bundle.evidence.records.filter(record => record.callId === 'extra').map(record => record.status)).toEqual(['unknown', 'unknown'])
    expect(bundle.evidence.records[1]?.status).toBe('reported-success')
  })
  it('bounds record count by folding the oldest attempts and naming every folded record', () => {
    const rows: TrialPublicEvent[] = [{ seq: 0, type: 'turn/start', turn: 0 }]
    for (let i = 0; i < 51; i++) rows.push(
      { seq: i * 2 + 1, type: 'tool/call', turn: 0, callId: `c${i}`, toolName: 'read', text: '{}', truncated: false },
      { seq: i * 2 + 2, type: 'tool/result', turn: 0, callId: `c${i}`, text: '{}', truncated: false, isError: false })
    rows.push({ seq: 103, type: 'turn/end', turn: 0, completed: true })
    const { evidence } = build({ events: rows })
    expect(evidence.records).toHaveLength(100)
    expect(evidence.records.map(record => record.id).slice(0, 2)).toEqual(['e3', 'e4'])
    expect(evidence.records.at(-1)).toMatchObject({ id: 'e102', callId: 'c50', status: 'reported-success', truncated: false })
    expect(evidence.warnings).toContain('为放入上限折叠了 2 条较早记录（e1–e2；工具调用 read×1），这些步骤已执行但不再逐条提供。')
    expect(evidence.warnings.some(item => item.startsWith('试做记录原有 102 条'))).toBe(true)
  })
  it('keeps evidence within the limits byte-for-byte unchanged', () => {
    const before = build({ events: events() }).evidence
    expect(before.warnings.some(item => item.startsWith('试做记录原有'))).toBe(false)
    const { digest, ...body } = before
    expect(compactTrialEvidence(body)).toEqual(before); expect(digest).toBe(before.digest)
  })
})

describe('trial SessionEvent public projection', () => {
  const row = (type: string, data: unknown) => ({ seq: 4, time: 0, type, data }) as SessionEvent
  it('omits system and reasoning while retaining ordinary public assistant text', () => {
    expect(projectTrialEvent(row('session/update', { thinking: 'private' }))).toBeUndefined()
    const message = createAssistantMessage({ source: { kind: 'model', provider: 'test', model: 'offline' }, content: [{ type: 'thinking', text: 'private-analysis' } as never, { type: 'text', text: 'Public answer' }] })
    const projected = projectTrialEvent(row('assistant/message', { turn: 0, message, meta: { secret: 'private-meta' } }))
    expect(projected).toMatchObject({ text: 'Public answer', truncated: false })
    expect(JSON.stringify(projected)).not.toContain('private')
  })
  it('redacts credentials and marks the result incomplete instead of claiming exact evidence', () => {
    const message = createToolResultMessage({ callId: ToolCallId('c1'), content: [{ type: 'text', text: '{"text":"ok","api_key":"supersecret-value"}' }] })
    const projected = projectTrialEvent(row('tool/result', { turn: 0, message }))
    expect(projected).toMatchObject({ truncated: true })
    expect(JSON.stringify(projected)).not.toContain('supersecret-value')
    const long = createToolResultMessage({ callId: ToolCallId('c1'), content: [{ type: 'text', text: 'a'.repeat(5000) }] })
    expect(projectTrialEvent(row('tool/result', { turn: 0, message: long }))).toMatchObject({ truncated: true })
  })
  it('preserves plain text as plain text, without making a synthetic LLM output object', () => {
    const message = createToolResultMessage({ callId: ToolCallId('c1'), content: [{ type: 'text', text: 'hello' }] })
    expect(projectTrialEvent(row('tool/result', { turn: 0, message }))).toMatchObject({ text: 'hello', truncated: false })
  })
})
