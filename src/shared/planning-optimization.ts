import { z } from 'zod'
import { parseWorkflow } from './workflow-validation.ts'

const identity = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const count = z.number().int().nonnegative().safe()
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])
const pointer = z.string().max(2000).refine(value => {
  if (value === '') return true
  if (!value.startsWith('/')) return false
  const parts = value.slice(1).split('/')
  return parts.length <= 32 && parts.every(part => !/~(?:[^01]|$)/.test(part) && !unsafeKeys.has(part.replace(/~1/g, '/').replace(/~0/g, '~')))
}, '证据路径必须是安全的 RFC 6901 JSON pointer')

/** Design targets, not runtime authorization, provider money or Token allowances. */
export const optimizationTargetSchema = z.object({
  maxModelCalls: count.max(10_000).optional(), maxAgentCalls: count.max(10_000).optional(),
}).strict().refine(value => value.maxModelCalls !== undefined || value.maxAgentCalls !== undefined, '至少指定一个图级计划调用目标')
export type OptimizationTarget = z.infer<typeof optimizationTargetSchema>
export const parseOptimizationTarget = (value: unknown): OptimizationTarget => optimizationTargetSchema.parse(value)

export const optimizationEvidenceRefSchema = z.object({ evidenceId: z.string().regex(/^e\d+$/), pointer }).strict()
export type OptimizationEvidenceRef = z.infer<typeof optimizationEvidenceRefSchema>
export const optimizationRegressionCaseSchema = z.object({
  id: identity, nodeId: identity,
  workflowInputs: optimizationEvidenceRefSchema.optional(),
  upstreamOutputs: z.record(identity, optimizationEvidenceRefSchema).refine(value => Object.keys(value).length <= 20 && Object.keys(value).every(key => !unsafeKeys.has(key)), '上游证据身份无效').optional(),
  expected: optimizationEvidenceRefSchema,
}).strict()
export type OptimizationRegressionCase = z.infer<typeof optimizationRegressionCaseSchema>
export const optimizationReplacementSchema = z.object({ nodeId: identity, reason: z.string().trim().min(1).max(4000) }).strict()
export type OptimizationReplacement = z.infer<typeof optimizationReplacementSchema>

export const optimizationOutputValueSchema = z.object({
  outcome: z.enum(['candidate', 'unchanged']), graphJson: z.string().max(2_000_000), summary: z.string().min(1).max(10_000),
  replacements: z.array(optimizationReplacementSchema).max(20), regressionCases: z.array(optimizationRegressionCaseSchema).max(20),
}).strict().superRefine((value, ctx) => {
  if (value.outcome === 'candidate' && (!value.graphJson.trim() || !value.replacements.length))
    ctx.addIssue({ code: 'custom', message: '优化候选必须包含当前图投影和替换说明' })
  if (value.outcome === 'unchanged' && (value.graphJson.trim() || value.replacements.length || value.regressionCases.length))
    ctx.addIssue({ code: 'custom', message: '无替换时不得携带图、替换条目或回归案例' })
  const nodeIds = new Set(value.replacements.map(item => item.nodeId))
  if (nodeIds.size !== value.replacements.length) ctx.addIssue({ code: 'custom', message: '替换节点身份重复' })
  if (new Set(value.regressionCases.map(item => item.id)).size !== value.regressionCases.length) ctx.addIssue({ code: 'custom', message: '回归案例身份重复' })
  if (value.regressionCases.some(item => !nodeIds.has(item.nodeId))) ctx.addIssue({ code: 'custom', message: '回归案例必须对应已声明的替换节点' })
})
export type OptimizationOutput = z.infer<typeof optimizationOutputValueSchema>
export const parseOptimizationOutput = (value: unknown): OptimizationOutput => optimizationOutputValueSchema.parse(value)

const referenceJsonSchema = { type: 'object' as const, properties: { evidenceId: { type: 'string' as const }, pointer: { type: 'string' as const } }, required: ['evidenceId', 'pointer'], additionalProperties: false }
/** The same small structured-output subset used by the author and distiller. */
export const optimizationOutputSchema = {
  type: 'object' as const,
  properties: {
    outcome: { type: 'string' as const, enum: ['candidate', 'unchanged'] }, graphJson: { type: 'string' as const }, summary: { type: 'string' as const },
    replacements: { type: 'array' as const, items: { type: 'object' as const, properties: { nodeId: { type: 'string' as const }, reason: { type: 'string' as const } }, required: ['nodeId', 'reason'], additionalProperties: false } },
    regressionCases: { type: 'array' as const, items: { type: 'object' as const, properties: {
      id: { type: 'string' as const }, nodeId: { type: 'string' as const }, workflowInputs: referenceJsonSchema,
      // DSH's structured-output subset accepts boolean additionalProperties only.
      // Host validation still requires every value to be an evidence reference.
      upstreamOutputs: { type: 'object' as const, additionalProperties: true }, expected: referenceJsonSchema,
    }, required: ['id', 'nodeId', 'expected'], additionalProperties: false } },
  }, required: ['outcome', 'graphJson', 'summary', 'replacements', 'regressionCases'], additionalProperties: false,
}

export const optimizationStatsSchema = z.object({
  totalNodes: count, modelNodes: count, agentNodes: count, deterministicNodes: count,
  plannedModelCalls: count.nullable(), plannedAgentCalls: count.nullable(), unknownReasons: z.array(z.string().max(2000)).max(500),
}).strict()
export type OptimizationStats = z.infer<typeof optimizationStatsSchema>
export const optimizationTargetEvaluationSchema = z.object({
  status: z.enum(['not_set', 'within_target', 'over_target', 'unknown']), reasons: z.array(z.string().max(2000)).max(500),
}).strict()
export type OptimizationTargetEvaluation = z.infer<typeof optimizationTargetEvaluationSchema>
const regressionStatus = z.enum(['passed', 'failed', 'skipped', 'cancelled', 'timeout'])
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const optimizationRegressionCaseResultSchema = z.object({
  id: identity, nodeId: identity, status: regressionStatus, reason: z.string().max(4000).optional(), expectedDigest: digest.optional(), actualDigest: digest.optional(),
}).strict()
export type OptimizationRegressionCaseResult = z.infer<typeof optimizationRegressionCaseResultSchema>
export const optimizationRegressionReportSchema = z.object({
  status: regressionStatus, cases: z.array(optimizationRegressionCaseResultSchema).max(20), passedRecorded: count.max(20), limitations: z.array(z.string().max(4000)).max(100),
  scope: z.literal('node-transform').optional(), evidenceSource: z.literal('recorded').optional(),
}).strict()
export type OptimizationRegressionReport = z.infer<typeof optimizationRegressionReportSchema>

const diagnosticSchema = z.object({ code: z.string().min(1).max(160), message: z.string().max(4000), nodeId: z.string().optional(), path: z.string().optional() }).strict()
export const optimizationAttemptSchema = z.object({
  round: count.min(1).max(2), candidate: z.unknown().transform(parseWorkflow).optional(), replacements: z.array(optimizationReplacementSchema).max(20),
  regressionCases: z.array(optimizationRegressionCaseSchema).max(20).optional(),
  summary: z.string().max(10_000), stats: optimizationStatsSchema.optional(), targetEvaluation: optimizationTargetEvaluationSchema.optional(),
  regression: optimizationRegressionReportSchema.optional(), accepted: z.boolean(), diagnostics: z.array(diagnosticSchema).max(1000),
}).strict()
export type OptimizationAttempt = z.infer<typeof optimizationAttemptSchema>
export const optimizationReportSchema = z.object({
  engineVersion: z.literal('0.0.2'),
  baseline: z.object({ candidate: z.unknown().transform(parseWorkflow), stats: optimizationStatsSchema, targetEvaluation: optimizationTargetEvaluationSchema }).strict(),
  selected: z.object({ stats: optimizationStatsSchema, targetEvaluation: optimizationTargetEvaluationSchema }).strict(),
  target: optimizationTargetSchema.optional(), selection: z.enum(['baseline', 'optimized']), attempts: z.array(optimizationAttemptSchema).max(2), stopReason: z.string().max(4000),
}).strict()
export type PlanningOptimizationReport = z.infer<typeof optimizationReportSchema>
