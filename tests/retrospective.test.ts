import { describe, expect, it } from 'vitest'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import {
  conversationSourceSchema, parseConversationEvidence, parseRetrospectiveOutput, parseTaskProcedure, retrospectiveOutputSchema,
  type ConversationEvidence, type TaskProcedure,
} from '../src/shared/retrospective.ts'

const evidence = (): ConversationEvidence => ({
  version: 1, sessionId: 'root', fromSeq: 0, throughSeq: 8, digest: 'a'.repeat(64), warnings: [],
  records: [
    { id: 'e1', seq: 1, kind: 'user', text: '按支付日期汇总', status: 'statement', truncated: false },
    { id: 'e3', seq: 3, kind: 'tool-result', text: 'done', status: 'reported-success', truncated: false },
    { id: 'e5', seq: 5, kind: 'assistant', text: '完成', status: 'statement', truncated: false },
  ],
})
const procedure = (): TaskProcedure => ({
  goal: '汇总每月报销', parameters: [{ name: 'month', description: '统计月份' }], rules: ['按支付日期统计'],
  steps: [
    { id: 'S1', title: '汇总', instruction: '读取材料并按月份汇总', dependsOn: [], evidenceRefs: ['e1', 'e3'], requiresReview: false },
    { id: 'S2', title: '说明', instruction: '输出本次统计口径', dependsOn: ['S1'], evidenceRefs: ['e5'], requiresReview: false },
  ], excluded: [], reviewItems: [],
})

describe('retrospective analysis contract (not an execution format)', () => {
  it('admits a parameterized procedure whose evidence is fully accounted for', () => {
    expect(parseTaskProcedure(procedure(), evidence())).toEqual(procedure())
    expect(conversationSourceSchema.parse({ kind: 'current-conversation', fromSeq: 0, throughSeq: 8 })).toEqual({ kind: 'current-conversation', fromSeq: 0, throughSeq: 8 })
  })
  it('forbids caller-selected session identity and reversed source ranges', () => {
    expect(() => conversationSourceSchema.parse({ kind: 'current-conversation', sessionId: 'other' })).toThrow()
    expect(() => conversationSourceSchema.parse({ kind: 'current-conversation', fromSeq: 5, throughSeq: 3 })).toThrow()
  })
  it('requires every material to have a kept step or a concrete exclusion reason', () => {
    const value = procedure(); value.steps.pop()
    expect(() => parseTaskProcedure(value, evidence())).toThrow('静默遗漏')
    value.excluded.push({ evidenceRefs: ['e5'], reason: '收尾复述已被输出步骤覆盖' })
    expect(parseTaskProcedure(value, evidence()).excluded).toHaveLength(1)
  })
  it('rejects fabricated evidence refs and duplicate refs in one explanation', () => {
    const value = procedure(); value.steps[0]!.evidenceRefs.push('e999')
    expect(() => parseTaskProcedure(value, evidence())).toThrow('不存在')
    value.steps[0]!.evidenceRefs = ['e1', 'e1', 'e3']
    expect(() => parseTaskProcedure(value, evidence())).toThrow('引用重复')
  })
  it.each(['failed', 'unknown'] as const)('does not turn %s tools into an observed successful method', status => {
    const source = evidence(); source.records[1]!.status = status
    const value = procedure()
    expect(() => parseTaskProcedure(value, source)).toThrow('必须标记复核')
    value.steps[0]!.requiresReview = true
    expect(() => parseTaskProcedure(value, source)).toThrow('具体复核项')
    value.reviewItems.push('确认工具失败后的最终有效计算方法')
    expect(parseTaskProcedure(value, source).steps[0]!.requiresReview).toBe(true)
  })
  it('requires review for excerpted material even if a caller incorrectly says success', () => {
    const source = evidence(); source.records[1]!.truncated = true
    expect(() => parseConversationEvidence(source)).toThrow('未知状态')
    expect(() => parseTaskProcedure(procedure(), source)).toThrow('必须标记复核')
  })
  it('allows failed attempts to be excluded with reasons without inventing a successful step', () => {
    const source = evidence(); source.records[1]!.status = 'failed'
    const value = procedure(); value.steps[0]!.evidenceRefs = ['e1']; value.excluded.push({ evidenceRefs: ['e3'], reason: '尝试失败，不固化为已验证方法' })
    expect(parseTaskProcedure(value, source).excluded).toHaveLength(1)
  })
  it('rejects cycles, missing dependencies, repeated identities and reserved R1', () => {
    const cycle = procedure(); cycle.steps[0]!.dependsOn = ['S2']
    expect(() => parseTaskProcedure(cycle, evidence())).toThrow('循环')
    const missing = procedure(); missing.steps[1]!.dependsOn = ['missing']
    expect(() => parseTaskProcedure(missing, evidence())).toThrow('依赖缺失')
    const duplicate = procedure(); duplicate.steps[1]!.id = 'S1'
    expect(() => parseTaskProcedure(duplicate, evidence())).toThrow('身份重复')
    const reserved = procedure(); reserved.steps[0]!.id = 'R1'
    expect(() => parseTaskProcedure(reserved, evidence())).toThrow('保留')
  })
  it('keeps event refs ordered, unique, correctly identified and inside the frozen range', () => {
    for (const change of [
      (value: ConversationEvidence) => { value.records[0]!.id = 'e2' },
      (value: ConversationEvidence) => { value.records.reverse() },
      (value: ConversationEvidence) => { value.throughSeq = 2 },
      (value: ConversationEvidence) => { value.records.push(value.records[2]!) },
    ]) { const value = evidence(); change(value); expect(() => parseConversationEvidence(value)).toThrow() }
  })
  it('supports clarification with at most three questions and forbids mixing it with a procedure', () => {
    const value = { outcome: 'needs-input', procedureJson: '', summary: '范围不明确', questions: [{ id: 'scope', question: '整理哪次报销任务？', options: [] }] }
    expect(parseRetrospectiveOutput(value).outcome).toBe('needs-input')
    expect(() => parseRetrospectiveOutput({ ...value, procedureJson: '{}' })).toThrow()
    expect(() => parseRetrospectiveOutput({ ...value, questions: [value.questions[0], value.questions[0]] })).toThrow('重复')
    expect(() => parseRetrospectiveOutput({ ...value, questions: Array.from({ length: 4 }, (_, n) => ({ ...value.questions[0], id: `q${n}` })) })).toThrow()
  })
  it('keeps structured output in the simple provider-compatible subset', () => {
    expect(retrospectiveOutputSchema.required).toEqual(['outcome', 'procedureJson', 'summary'])
    expect(JSON.stringify(retrospectiveOutputSchema)).not.toMatch(/oneOf|anyOf|\$ref/)
  })
  it('defaults omitted nonblocking questions without inventing a clarification or changing procedure evidence',()=>{
    const value={outcome:'procedure',procedureJson:JSON.stringify(procedure()),summary:'已提炼'}
    expect(()=>assertObjectJsonSchema(retrospectiveOutputSchema)).not.toThrow()
    expect(validateJsonSchemaValue(retrospectiveOutputSchema,value)).toEqual([])
    const parsed=parseRetrospectiveOutput(value)
    expect(parsed.questions).toEqual([])
    expect(parseTaskProcedure(JSON.parse(parsed.procedureJson),evidence())).toEqual(procedure())
    expect(()=>parseRetrospectiveOutput({outcome:'needs-input',procedureJson:'',summary:'需要确认'})).toThrow('必须包含问题')
  })
})
