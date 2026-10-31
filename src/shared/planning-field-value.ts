import type { JsonSchemaNode, ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { PlanningCompletionPlan } from './planning-completion.ts'
import type { PlanningHandoff } from './planning-handoff-contract.ts'
import { CompilerError, compilerJson, needsInputWireSchema } from './planning-repair.ts'

/** Wire adaptation only. This never generates business values or grants authority. */
export function singleFieldValueEligible(handoff: PlanningHandoff | undefined, requiredCoverageIds: readonly string[]): boolean {
  return handoff?.version === 2 && handoff.mode === 'partial' && handoff.unresolved.length === 1 && handoff.unresolved[0]!.fields.length === 1 && handoff.completion.length === 1
    && handoff.completion[0]!.nodeId === handoff.unresolved[0]!.nodeId && handoff.completion[0]!.field === handoff.unresolved[0]!.fields[0]
    && requiredCoverageIds.length === 1 && requiredCoverageIds[0] === 'R1'
}
export class PlanningFieldValueAdapter {
  readonly entry: PlanningCompletionPlan['entries'][number]
  readonly initialSchema: ObjectJsonSchema
  readonly instructions = '本任务的节点、字段、edit 包壳与 R1 覆盖映射已由 Host 确定。首次只提交 {submission:{mode:"complete-field",value:该字段的完整新值}}，不得再提交节点、字段、coverage、updates 或完整图。值必须满足原字段类型及业务需求，Host 不生成或补猜业务值。缺关键信息仍用 mode=needs-input 和 questions。若返回失败草稿，之后仅使用原 mode=repair、draftRevision 与 allowedPaths 内 patches，不再次提交 complete-field。成功即结束。'
  constructor(plan: PlanningCompletionPlan, focused: Map<string, readonly string[]>, requiredCoverageIds: readonly string[]) {
    if (plan.entries.length !== 1 || requiredCoverageIds.length !== 1 || requiredCoverageIds[0] !== 'R1') throw new CompilerError('FIELD_VALUE_SCOPE', '字段值协议仅支持一个明确完成义务和 R1 覆盖', undefined, true)
    this.entry = structuredClone(plan.entries[0]!)
    const fields = focused.get(this.entry.key)
    if (focused.size !== 1 || fields?.length !== 1 || fields[0] !== this.entry.field) throw new CompilerError('FIELD_VALUE_SCOPE', '字段值协议不能扩大已授权的聚焦字段', undefined, true)
    const value: JsonSchemaNode = { type: 'object', properties: { mode: { type: 'string', const: 'complete-field' }, value: this.entry.wire }, required: ['mode', 'value'], additionalProperties: false }
    this.initialSchema = { type: 'object', properties: { submission: { oneOf: [value, needsInputWireSchema] } }, required: ['submission'], additionalProperties: false }
  }
  expand(input: unknown, hasDraft: boolean): unknown {
    const envelope = compilerJson(input), submission = envelope?.submission
    if (submission?.mode !== 'complete-field') {
      if (!hasDraft && submission?.mode !== 'needs-input') throw new CompilerError('FIELD_VALUE_PROTOCOL', '初次提交只接受字段值或必要澄清', undefined, true)
      return envelope
    }
    if (hasDraft) throw new CompilerError('PATCH_REQUIRED', '已有失败草稿，只允许原局部修复或必要澄清', undefined, true)
    if (!envelope || Array.isArray(envelope) || Object.keys(envelope).length !== 1 || !submission || Array.isArray(submission) || Object.keys(submission).some(key => !['mode', 'value'].includes(key)) || !Object.hasOwn(submission, 'value'))
      throw new CompilerError('FIELD_VALUE_PROTOCOL', '字段值提交不能包含其他字段，且必须提供 value', undefined, true)
    return { submission: { mode: 'edit', updates: { [this.entry.key]: { values: { [this.entry.field]: submission.value } } }, coverage: { R1: [this.entry.key] } } }
  }
}
