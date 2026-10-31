import { z } from 'zod'
import type { PlannerOutput, PlanningRequest } from './planning-types.ts'
import { conversationSourceSchema } from './retrospective.ts'
import { optimizationTargetSchema } from './planning-optimization.ts'
import { planningHandoffSchema } from './planning-handoff-contract.ts'

const identity = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
// Optional on stored/internal requests; completeness is enforced only at the main-agent entry.
export const planningModuleCheckSchema=z.object({checked:z.array(z.string().min(1).max(260)).max(100),notApplicable:z.string().trim().min(1).max(400)}).strict()

const requestSchema = z.object({
  requestId: identity,
  operation: z.enum(['create', 'revise']),
  instruction: z.string().trim().min(1).max(100_000),
  title: z.string().trim().min(1).max(160).optional(),
  targetWorkflowId: identity.optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  targetNodeIds: z.array(identity).max(500).optional(),
  preview: z.boolean().optional(),
  source: z.union([conversationSourceSchema,z.object({kind:z.literal('verified-trial'),trialId:identity}).strict()]).optional(),
  optimizationTarget: optimizationTargetSchema.optional(),
  handoff: planningHandoffSchema.optional(),
  moduleCheck: planningModuleCheckSchema.optional(),
  runAfterSave: z.literal(true).optional(),
}).strict().superRefine((value, ctx) => {
  if(value.runAfterSave&&(value.operation!=='create'||value.handoff?.mode!=='module'||value.source||value.preview))
    ctx.addIssue({code:'custom',message:'保存后运行一次只用于新建入口直接实例化的模块'})
  if(value.handoff&&(value.source||value.optimizationTarget||value.handoff.mode!=='module'&&value.operation!=='revise'))
    ctx.addIssue({code:'custom',message:'字段交接仅支持 revise；历史提炼使用原证据入口'})
  if (value.optimizationTarget && !value.source)
    ctx.addIssue({ code: 'custom', message: 'v0.0.2 的优化目标仅用于证据驱动任务提炼预览，不授权执行' })
  if (value.source && (value.operation !== 'create' || value.source.kind==='current-conversation'&&value.preview !== true))
    ctx.addIssue({ code: 'custom', message: '从当前任务提炼只支持创建预览，必须指定 create 和 preview:true' })
  if (value.operation === 'revise' && (!value.targetWorkflowId || value.expectedRevision === undefined || value.expectedRevision < 1))
    ctx.addIssue({ code: 'custom', message: '修改工作流必须提供目标身份与大于零的期望版本' })
  if (value.operation === 'create' && (value.expectedRevision !== undefined && value.expectedRevision !== 0 || value.targetNodeIds?.length))
    ctx.addIssue({ code: 'custom', message: '创建工作流的期望版本只能省略或为零，不能携带既有节点范围' })
  if (new Set(value.targetNodeIds ?? []).size !== (value.targetNodeIds?.length ?? 0))
    ctx.addIssue({ code: 'custom', message: '目标节点身份不能重复' })
})

const outputSchema = z.object({
  outcome: z.enum(['candidate', 'needs-input']),
  graphJson: z.string().max(2_000_000),
  summary: z.string().max(10_000),
  assumptions: z.array(z.string().max(4000)).max(50),
  questions: z.array(z.object({ id: identity, question: z.string().min(1).max(4000), options: z.array(z.string().min(1).max(1000)).max(8) }).strict()).max(3),
  requirementCoverage: z.array(z.object({ requirementId: identity, nodeIds: z.array(identity).max(500), note: z.string().max(4000) }).strict()).max(100),
}).strict().superRefine((value, ctx) => {
  if (value.outcome === 'candidate' && (!value.graphJson.trim() || value.questions.length))
    ctx.addIssue({ code: 'custom', message: '候选结果必须包含图，且不能同时等待澄清问题' })
  if (value.outcome === 'needs-input' && (!value.questions.length || value.graphJson.trim()))
    ctx.addIssue({ code: 'custom', message: '等待输入必须提供问题，不能同时提交图' })
  if (new Set(value.questions.map(question => question.id)).size !== value.questions.length)
    ctx.addIssue({ code: 'custom', message: '澄清问题身份不能重复' })
  if (new Set(value.requirementCoverage.map(item => item.requirementId)).size !== value.requirementCoverage.length)
    ctx.addIssue({ code: 'custom', message: '需求覆盖身份不能重复' })
})

export const parsePlanningRequest = (value: unknown): PlanningRequest => requestSchema.parse(value)
export const parsePlannerOutput = (value: unknown): PlannerOutput => outputSchema.parse(value)

/** Deliberately uses the DSH structured-output subset; detailed limits are Host-side. */
export const plannerOutputSchema = {
  type: 'object' as const,
  properties: {
    outcome: { type: 'string' as const, enum: ['candidate', 'needs-input'] },
    graphJson: { type: 'string' as const },
    summary: { type: 'string' as const },
    assumptions: { type: 'array' as const, items: { type: 'string' as const } },
    questions: { type: 'array' as const, items: { type: 'object' as const, properties: {
      id: { type: 'string' as const }, question: { type: 'string' as const }, options: { type: 'array' as const, items: { type: 'string' as const } },
    }, required: ['id', 'question', 'options'], additionalProperties: false } },
    requirementCoverage: { type: 'array' as const, items: { type: 'object' as const, properties: {
      requirementId: { type: 'string' as const }, nodeIds: { type: 'array' as const, items: { type: 'string' as const } }, note: { type: 'string' as const },
    }, required: ['requirementId', 'nodeIds', 'note'], additionalProperties: false } },
  },
  required: ['outcome', 'graphJson', 'summary', 'assumptions', 'questions', 'requirementCoverage'],
  additionalProperties: false,
}
