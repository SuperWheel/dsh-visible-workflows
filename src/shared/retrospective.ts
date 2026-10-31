import { z } from 'zod'

const identity = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const seq = z.number().int().nonnegative().safe()
const ref = z.string().regex(/^e\d+$/)
const question = z.object({ id: identity, question: z.string().min(1).max(4000), options: z.array(z.string().min(1).max(1000)).max(8) }).strict()

/** Host selects the current root session; callers can only narrow its event range. */
export const conversationSourceSchema = z.object({
  kind: z.literal('current-conversation'), fromSeq: seq.optional(), throughSeq: seq.optional(),
}).strict().refine(value => value.fromSeq === undefined || value.throughSeq === undefined || value.fromSeq <= value.throughSeq, '证据起点不得晚于终点')
export type ConversationSource = z.infer<typeof conversationSourceSchema>

export const conversationEvidenceRecordSchema = z.object({
  id: ref, seq, kind: z.enum(['user', 'assistant', 'tool-call', 'tool-result']),
  text: z.string().max(4000), status: z.enum(['statement', 'reported-success', 'failed', 'unknown']),
  toolName: z.string().min(1).max(400).optional(), callId: z.string().min(1).max(400).optional(), truncated: z.boolean(),
}).strict()
export type ConversationEvidenceRecord = z.infer<typeof conversationEvidenceRecordSchema>
export const conversationEvidenceSchema = z.object({
  version: z.literal(1), sessionId: z.string().min(1).max(400), fromSeq: seq, throughSeq: seq,
  digest: z.string().regex(/^[a-f0-9]{64}$/), records: z.array(conversationEvidenceRecordSchema).min(1).max(100),
  warnings: z.array(z.string().max(1000)).max(100),
}).strict().superRefine((value, ctx) => {
  if (value.fromSeq > value.throughSeq) ctx.addIssue({ code: 'custom', message: '证据范围无效' })
  let previous = -1
  for (const record of value.records) {
    if (record.id !== `e${record.seq}` || record.seq < value.fromSeq || record.seq > value.throughSeq || record.seq <= previous)
      ctx.addIssue({ code: 'custom', message: '证据身份、顺序或范围无效' })
    if (record.truncated && record.status !== 'unknown') ctx.addIssue({ code: 'custom', message: '摘录证据必须保留未知状态' })
    previous = record.seq
  }
})
export type ConversationEvidence = z.infer<typeof conversationEvidenceSchema>
/** Structure only. Host additionally verifies the SHA-256 digest before use. */
export const parseConversationEvidence = (value: unknown): ConversationEvidence => conversationEvidenceSchema.parse(value)

export const PROCEDURE_STEP_EVIDENCE_GUIDANCE='每个已观察业务步骤的 evidenceRefs 至少1条冻结事件 ID；specRefs 是任务规范，不能替代已执行证据。'
export const TRIAL_REVIEW_GUIDANCE='试做reviewItems和未知证据是最终报告备注，不要求运行时人工节点。可机械检查的数量、格式、回读相等、标题和链接须生成code/if自动检查，失败时给明确错误；定性问题留给最终审阅。requiresReview=true仅用于用户原始需求明确要求未来每次运行时人工审核的步骤，此时仍必须映射human并遵守REVIEW_BEFORE_EFFECT；不得从reviewItems推断该授权。'
export const PROCEDURE_REVIEW_GUIDANCE='未来每次人工复核是业务约束：将对应 specRefs 和 requiresReview=true 附在有真实产物事件的已观察业务步骤上，并在 reviewItems 原样保留复核要求，供后续生成真实 human 节点。不要单独杜撰没有事件的已执行复核步骤，也不要将助手自报或 structured_output 回执当成人工已复核的证明。'

export const taskProcedureSchema = z.object({
  goal: z.string().min(1).max(4000),
  parameters: z.array(z.object({ name: identity, description: z.string().min(1).max(2000) }).strict()).max(40),
  rules: z.array(z.string().min(1).max(2000)).max(50),
  steps: z.array(z.object({
    id: identity.refine(value => value !== 'R1', 'R1 为整体需求保留身份'), title: z.string().min(1).max(400), instruction: z.string().min(1).max(4000),
    dependsOn: z.array(identity).max(60), evidenceRefs: z.array(ref).min(1,{error:PROCEDURE_STEP_EVIDENCE_GUIDANCE+'人工审核义务须附在已有事件依据的业务步骤上；试做缺口属于最终报告。'+'修复仅可修改反馈 allowedPaths 列出的字段；缺少依据时可用 needs-input，不编造事件。'}).max(100), requiresReview: z.boolean(),
    /** Frozen task specifications are context, never proof of execution. */
    specRefs: z.array(z.string().min(1).max(200)).max(100).optional(),
  }).strict()).min(1).max(60),
  excluded: z.array(z.object({ evidenceRefs: z.array(ref).min(1).max(100), reason: z.string().min(1).max(2000) }).strict()).max(100),
  reviewItems: z.array(z.string().min(1).max(2000)).max(100),
}).strict()
export type TaskProcedure = z.infer<typeof taskProcedureSchema>

/** Semantic validation keeps Error compatibility and a path relative to the procedure. */
export class TaskProcedureValidationError extends Error {
  constructor(readonly code: string, message: string, readonly path: readonly (string | number)[]) { super(message) }
}

/** Structural provenance checks; these do not prove that the model understood the task. */
export function taskSpecificationRefs(task?:{inputs:readonly unknown[];artifacts:readonly unknown[];reviewItems:readonly unknown[]}):string[]{
  return task?['trialTask.task',...task.inputs.map((_,i)=>`trialTask.inputs[${i}]`),...task.artifacts.map((_,i)=>`trialTask.artifacts[${i}]`),...task.reviewItems.map((_,i)=>`trialTask.reviewItems[${i}]`)]:[]
}
/** rehearsal: trial reviewItems are optional final-report notes (user decision 2026-10-26), so failed,
 * unknown or cut trial evidence never requires one; the evidence keeps its status and the Host
 * verification report travels with the task. Conversation sources still mark such steps for review. */
export function parseTaskProcedure(value: unknown, evidence: ConversationEvidence, specificationRefs:readonly string[]=[],rehearsal=false): TaskProcedure {
  const procedure = taskProcedureSchema.parse(value)
  if (new TextEncoder().encode(JSON.stringify(procedure)).length > 64_000) throw new Error('任务方法说明超过 64 KB，请缩小任务范围')
  const ids = new Set(procedure.steps.map(step => step.id))
  if (ids.size !== procedure.steps.length) throw new Error('方法步骤身份重复')
  if (new Set(procedure.parameters.map(parameter => parameter.name)).size !== procedure.parameters.length) throw new Error('方法参数身份重复')
  const records = new Map(evidence.records.map(record => [record.id, record]))
  const covered = new Set<string>()
  for (const [collection, items] of [['steps', procedure.steps], ['excluded', procedure.excluded]] as const) {
    for (const [i, item] of items.entries()) {
      if (new Set(item.evidenceRefs).size !== item.evidenceRefs.length)
        throw new TaskProcedureValidationError('DUPLICATE_EVIDENCE_REFS', '步骤或排除项的证据引用重复', [collection, i, 'evidenceRefs'])
      for (const id of item.evidenceRefs) {
        if (!records.has(id)) throw new Error(`方法引用了不存在的证据 ${id}`)
        covered.add(id)
      }
    }
  }
  for (const step of procedure.steps) {
    if(step.specRefs&&(new Set(step.specRefs).size!==step.specRefs.length||step.specRefs.some(ref=>!specificationRefs.includes(ref))))throw new Error('步骤引用了不存在或重复的任务规范；规范不属于执行事件')
    if (new Set(step.dependsOn).size !== step.dependsOn.length || step.dependsOn.some(id => !ids.has(id) || id === step.id)) throw new Error('步骤依赖缺失、重复或指向自身')
    const uncertain = !rehearsal && step.evidenceRefs.some(id => { const record = records.get(id)!; return record.status === 'failed' || record.truncated || record.status === 'unknown' })
    if (uncertain && !step.requiresReview) throw new Error(`步骤 ${step.id} 引用了失败或未知证据，必须标记复核`)
  }
  if (procedure.steps.some(step => step.requiresReview) && !procedure.reviewItems.length) throw new Error('待复核步骤必须提供具体复核项')
  if (covered.size !== records.size) {
    // Name each record so a repair touches only these (Desktop r52).
    const missing = [...records.values()].filter(record => !covered.has(record.id)).map(record => `${record.id}（${record.kind}${record.toolName ? ' ' + record.toolName : ''}：${record.text.slice(0, 80)}）`)
    throw new TaskProcedureValidationError('UNCOVERED_EVIDENCE', `证据 ${missing.join('；')} 未归入步骤或排除理由，不得静默遗漏过程。属于业务步骤的放进对应步骤的 evidenceRefs，只是查看或探索的在 excluded 补一项写明理由。`, ['excluded'])
  }
  const pending = new Map(procedure.steps.map(step => [step.id, new Set(step.dependsOn)]))
  while (pending.size) {
    const ready = [...pending].filter(([, dependencies]) => !dependencies.size).map(([id]) => id)
    if (!ready.length) throw new Error('方法步骤依赖存在循环')
    for (const id of ready) { pending.delete(id); for (const dependencies of pending.values()) dependencies.delete(id) }
  }
  return procedure
}

export const retrospectiveOutputValueSchema = z.object({
  outcome: z.enum(['procedure', 'needs-input']), procedureJson: z.string().max(64_000), summary: z.string().max(10_000), questions: z.array(question).max(3).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.outcome === 'procedure' && (!value.procedureJson.trim() || value.questions.length)) ctx.addIssue({ code: 'custom', message: '方法结果必须包含 JSON 且不能同时等待澄清' })
  if (value.outcome === 'needs-input' && (value.procedureJson.trim() || !value.questions.length)) ctx.addIssue({ code: 'custom', message: '等待澄清必须包含问题且不能同时提交方法' })
  if (new Set(value.questions.map(item => item.id)).size !== value.questions.length) ctx.addIssue({ code: 'custom', message: '澄清身份重复' })
})
export type RetrospectiveOutput = z.infer<typeof retrospectiveOutputValueSchema>
export const parseRetrospectiveOutput = (value: unknown): RetrospectiveOutput => retrospectiveOutputValueSchema.parse(value)

/** DSH structured-output subset; detailed validation remains on the Host. */
export const retrospectiveOutputSchema = {
  type: 'object' as const,
  properties: {
    outcome: { type: 'string' as const, enum: ['procedure', 'needs-input'] }, procedureJson: { type: 'string' as const }, summary: { type: 'string' as const },
    questions: { type: 'array' as const, items: { type: 'object' as const, properties: {
      id: { type: 'string' as const }, question: { type: 'string' as const }, options: { type: 'array' as const, items: { type: 'string' as const } },
    }, required: ['id', 'question', 'options'], additionalProperties: false } },
  }, required: ['outcome', 'procedureJson', 'summary'], additionalProperties: false,
}
