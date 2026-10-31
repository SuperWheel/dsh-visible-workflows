import { z } from 'zod'
import { conversationEvidenceSchema } from './retrospective.ts'

export const TRIAL_LIMITS = { files: 30, fileBytes: 4 * 1024 * 1024, totalBytes: 16 * 1024 * 1024, checks: 30, events: 200, specBytes: 64_000 } as const
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const identity = z.string().min(1).max(400)
const unsafeKey = /^(?:__proto__|prototype|constructor)$/
const sensitivePart = /^(?:\.env(?:\..*)?|\.(?:ssh|git|dsh|codex|aws|azure|config|gnupg|kube|npmrc|netrc|pypirc)|credentials?(?:\..*)?|(?:api[-_]?keys?|access[-_]?tokens?|refresh[-_]?tokens?|secrets?)(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/i

/** Paths are data, never shell expressions; sensitive locations are not auto-read. */
export function isSafeTrialPath(path: string): boolean {
  return path.length > 0 && path.length <= 1000 && !path.startsWith('/') && !/^\w:/.test(path) && !/[\\\x00-\x1f]/.test(path)
    && !path.includes('{{') && path.split('/').every(part => !!part && part !== '.' && part !== '..' && !sensitivePart.test(part) && !unsafeKey.test(part))
}
const path = z.string().refine(isSafeTrialPath, '试做文件必须是工作区内普通相对路径，不允许跳转、敏感目录或凭据文件')
const pointer = z.string().max(1000).refine(value => value === '' || (value.startsWith('/') && value.split('/').length <= 17 && !/~(?:[^01]|$)/.test(value)
  && value.slice(1).split('/').every(part => !unsafeKey.test(part.replace(/~1/g, '/').replace(/~0/g, '~')))), 'JSON Pointer 无效或超出范围')
function boundedJson(value: unknown, depth = 0, state = { count: 0 }): boolean {
  if (++state.count > 1000 || depth > 12) return false
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return typeof value !== 'string' || value.length <= 16_000
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(item => boundedJson(item, depth + 1, state))
  return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Object.entries(value).every(([key, item]) => !unsafeKey.test(key) && boundedJson(item, depth + 1, state))
}
const jsonValue = z.unknown().refine(value => boundedJson(value), '比较值必须是有界 JSON 数据')
export const planningTrialCheckSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('json-equals'), pointer, value: jsonValue }).strict(),
  z.object({ kind: z.literal('text-includes'), value: z.string().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal('json-type'), pointer, value: z.enum(['null', 'boolean', 'number', 'string', 'array', 'object']) }).strict(),
  z.object({ kind: z.literal('json-length'), pointer, value: z.number().int().nonnegative().max(TRIAL_LIMITS.fileBytes) }).strict(),
])
export type PlanningTrialCheck = z.infer<typeof planningTrialCheckSchema>
export const planningTrialSpecSchema = z.object({
  task: z.string().min(1).max(12_000), tools: z.array(z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/)).min(1).max(30),
  inputs: z.array(path).max(TRIAL_LIMITS.files).default([]),
  artifacts: z.array(z.object({ path, format: z.enum(['json', 'text']), checks: z.array(planningTrialCheckSchema).max(TRIAL_LIMITS.checks), requireChanged: z.boolean().default(false) }).strict()).min(1).max(TRIAL_LIMITS.files),
  /** Compatibility field: notes for final review, never runtime human gates. */
  reviewItems: z.array(z.string().min(1).max(2000)).max(30).default([]),
}).strict().superRefine((value, ctx) => {
  const paths = [...value.inputs, ...value.artifacts.map(item => item.path)]
  if (new Set(paths).size !== paths.length) ctx.addIssue({ code: 'custom', message: '输入与产物路径必须互不重复；试做输入只读' })
  if (paths.length > TRIAL_LIMITS.files) ctx.addIssue({ code: 'custom', message: '试做输入与产物合计最多 30 个文件' })
  if (new Set(value.tools).size !== value.tools.length) ctx.addIssue({ code: 'custom', message: '工具名称不得重复' })
  for (const item of value.artifacts) if (item.checks.some(check => (check.kind === 'text-includes') !== (item.format === 'text')))
    ctx.addIssue({ code: 'custom', message: '产物格式与检查类型不一致' })
  if (new TextEncoder().encode(JSON.stringify(value)).length > TRIAL_LIMITS.specBytes) ctx.addIssue({ code: 'custom', message: '试做规范超过 64 KB' })
})
export type PlanningTrialSpec = z.infer<typeof planningTrialSpecSchema>
export const parsePlanningTrialSpec = (value: unknown): PlanningTrialSpec => planningTrialSpecSchema.parse(value)

const checkResultSchema = z.object({ index: z.number().int().nonnegative().max(TRIAL_LIMITS.checks - 1), kind: z.enum(['json-equals', 'text-includes', 'json-type', 'json-length']), status: z.enum(['passed', 'failed', 'unverified']), reason: z.string().max(1000) }).strict()
export type TrialCheckResult = z.infer<typeof checkResultSchema>
export const trialFileFingerprintSchema = z.object({ path, status: z.enum(['present', 'missing', 'unverified']), sha256: digest.optional(), size: z.number().int().nonnegative().max(TRIAL_LIMITS.fileBytes).optional(), reason: z.string().max(1000).optional(), checks: z.array(checkResultSchema).max(TRIAL_LIMITS.checks).optional() }).strict().superRefine((value, ctx) => {
  if (value.status === 'present' && (value.sha256 === undefined || value.size === undefined)) ctx.addIssue({ code: 'custom', message: '已存在文件必须包含完整指纹' })
  if (value.status !== 'present' && (value.sha256 !== undefined || value.size !== undefined || value.checks !== undefined)) ctx.addIssue({ code: 'custom', message: '不可验证或缺失文件不能附带成功指纹或检查' })
})
export type TrialFileFingerprint = z.infer<typeof trialFileFingerprintSchema>
export const trialFileSnapshotSchema = z.object({ version: z.literal(1), specDigest: digest, workspaceRootDigest: digest, files: z.record(path, trialFileFingerprintSchema).refine(value => Object.keys(value).length <= TRIAL_LIMITS.files, '文件快照超过容量') }).strict()
export type TrialFileSnapshot = z.infer<typeof trialFileSnapshotSchema>
export const trialVerificationReportSchema = z.object({
  version: z.literal(1), specDigest: digest, verdict: z.enum(['passed', 'failed', 'needs-review']), digest,
  inputs: z.array(z.object({ path, status: z.enum(['passed', 'failed', 'unverified']), reason: z.string().max(1000) }).strict()).max(TRIAL_LIMITS.files),
  artifacts: z.array(z.object({ path, status: z.enum(['passed', 'failed', 'unverified']), changed: z.boolean().optional(), checks: z.array(checkResultSchema).max(TRIAL_LIMITS.checks), reason: z.string().max(1000) }).strict()).max(TRIAL_LIMITS.files),
  before: trialFileSnapshotSchema, after: trialFileSnapshotSchema, reviewItems: z.array(z.string().max(2000)).max(30), limitations: z.array(z.string().max(1000)).max(30),
}).strict()
export type TrialVerificationReport = z.infer<typeof trialVerificationReportSchema>

const seq = z.number().int().nonnegative().safe(), turn = seq, text = z.string().max(4000), truncated = z.boolean()
/** Driver emits only these public fields, never raw SessionEvent envelopes. */
export const trialPublicEventSchema = z.discriminatedUnion('type', [
  z.object({ seq, type: z.literal('turn/start'), turn }).strict(),
  z.object({ seq, type: z.literal('turn/end'), turn, completed: z.boolean() }).strict(),
  z.object({ seq, type: z.literal('user/message'), text, truncated, source: z.enum(['user', 'host']) }).strict(),
  z.object({ seq, type: z.literal('assistant/message'), turn, text, truncated, interrupted: z.boolean() }).strict(),
  z.object({ seq, type: z.literal('tool/call'), turn, callId: identity, toolName: identity, text, truncated }).strict(),
  z.object({ seq, type: z.literal('tool/result'), turn, callId: identity, text, truncated, isError: z.boolean(), errorCode: z.string().max(400).optional() }).strict(),
])
export type TrialPublicEvent = z.infer<typeof trialPublicEventSchema>
export const trialHumanReviewSchema = z.object({ accepted: z.literal(true), questionId: identity, answeredAt: z.iso.datetime() }).strict()
export type TrialHumanReview = z.infer<typeof trialHumanReviewSchema>
export const verifiedTrialEvidenceSchema = z.object({
  evidence: conversationEvidenceSchema,
  binding: z.object({ trialId: identity, workspaceId: identity, rootSessionId: identity, childSessionId: identity, specDigest: digest, verificationDigest: digest, evidenceDigest: digest, humanReview: trialHumanReviewSchema.optional(), receiptDigest: digest.optional() }).strict(),
}).strict()
export type VerifiedTrialEvidence = z.infer<typeof verifiedTrialEvidenceSchema>

/** Invalid optional submissions remain auditable and fall back without rerunning business calls. */
export const trialSubmissionSchema=z.unknown().refine(value=>value!==undefined&&new TextEncoder().encode(JSON.stringify(value)).length<=20_000,'试做路径或方法提交不得超过20 KB')
export const trialPathSchema=z.array(z.object({
  call:z.number().int().positive().max(TRIAL_LIMITS.events).describe('本次试做中第N次工具调用，从1起按发起顺序，不含structured_output'),
  tool:z.string().min(1).max(200).describe('该调用的工具名，Host据此核对编号'),
  label:z.string().min(1).max(200).describe('该调用完成的业务步骤'),
  status:z.enum(['success','expected-failure','failed']).describe('成功路径用success；检查性调用按预期返回错误（如写前读取确认文件不存在）且后续步骤依据它时用expected-failure；卡住步骤的最后失败调用用failed且只能放最后'),
  workaround:z.boolean().optional().describe('手工拼装或复制输入、旧产物替代等绕行必须标记true'),
  reason:z.string().min(1).max(600).optional().describe('绕行原因；绕行不代表步骤跑通'),
}).strict().refine(value=>!value.workaround||!!value.reason,'绕行必须说明原因')).min(1).max(60)
export type TrialPath=z.infer<typeof trialPathSchema>
