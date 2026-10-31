import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { PlanningContext } from './planning-types.ts'
import type { CompilerIssue,RepairFeedback } from './planning-repair.ts'

const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
/** Content identity, not authorization. Only Host-owned storage may supply checkpoints. */
export const continuationDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const digest=z.string().regex(/^[a-f0-9]{64}$/),path=z.string().min(1).max(2000)
export const loadedPlanningContractsSchema=z.object({catalogDigest:digest,templateIds:z.array(z.string().min(1).max(160)).max(64),changeTemplateIds:z.array(z.string().min(1).max(160)).max(64)}).strict().superRefine((value,ctx)=>{
  if(new Set(value.templateIds).size!==value.templateIds.length||new Set(value.changeTemplateIds).size!==value.changeTemplateIds.length||value.changeTemplateIds.some(id=>!value.templateIds.includes(id)))ctx.addIssue({code:'custom',message:'已加载模板身份无效'})
})
export type LoadedPlanningContracts=z.infer<typeof loadedPlanningContractsSchema>
const reservationMap=z.record(z.string().min(1).max(200),z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)).refine(value=>Object.keys(value).length<=1000&&new Set(Object.values(value)).size===Object.keys(value).length,'预留身份重复')
/** Host-allocated identities for draft keys; they must survive a resume. */
export const planningReservationsSchema=z.object({nodes:reservationMap,agents:reservationMap,environment:reservationMap}).strict()
export type PlanningReservations=z.infer<typeof planningReservationsSchema>
export interface HostRepairCheckpoint {
  protocolVersion:1
  scope:string
  schemaDigest:string
  contractDigest:string
  state:'empty'|'draft'|'clarification'|'accepted'
  revision:number
  submissions:number
  maxSubmissions:number
  document?:unknown
  issues:CompilerIssue[]
  priorFailure:string
  loadedContracts?:LoadedPlanningContracts
  reservations?:PlanningReservations
  digest:string
}
const issueSchema=z.object({code:z.string().min(1).max(160),message:z.string().max(16000),path:z.string().max(2000).optional(),nodeId:z.string().max(160).optional(),allowedPaths:z.array(path).max(1000),
  expected:z.record(z.string(),z.unknown()).optional(),actualType:z.string().max(32).optional(),candidates:z.array(z.unknown()).max(1000).optional(),contracts:z.record(z.string(),z.record(z.string(),z.unknown())).optional(),
}).strict()
export const hostRepairCheckpointSchema=z.object({protocolVersion:z.literal(1),scope:z.string().min(1).max(16000),schemaDigest:digest,contractDigest:digest,state:z.enum(['empty','draft','clarification','accepted']),revision:z.number().int().nonnegative().safe(),submissions:z.number().int().nonnegative().safe(),maxSubmissions:z.number().int().min(1).max(100),document:z.unknown().optional(),issues:z.array(issueSchema).max(1000),priorFailure:z.union([z.literal(''),digest]),loadedContracts:loadedPlanningContractsSchema.optional(),reservations:planningReservationsSchema.optional(),digest,
}).strict().superRefine((value,ctx)=>{
  const hasDraft=Object.hasOwn(value,'document'),hasIssues=value.issues.length>0
  if(value.submissions>value.maxSubmissions||value.revision>value.submissions||hasDraft!==(value.revision>0))ctx.addIssue({code:'custom',message:'恢复检查点的草稿版本或累计提交数无效'})
  if(value.state==='empty'&&(hasDraft||value.submissions||hasIssues)||value.state==='draft'&&(!hasDraft||!hasIssues)||value.state==='clarification'&&(!value.submissions||hasDraft!==hasIssues)||value.state==='accepted'&&(!hasDraft||hasIssues))ctx.addIssue({code:'custom',message:'恢复检查点的状态与草稿不匹配'})
  const {digest:actual,...body}=value
  if(continuationDigest(body)!==actual)ctx.addIssue({code:'custom',message:'恢复检查点内容摘要不匹配'})
}) as unknown as z.ZodType<HostRepairCheckpoint>
export function sealRepairCheckpoint(body:Omit<HostRepairCheckpoint,'digest'>):HostRepairCheckpoint {
  return hostRepairCheckpointSchema.parse({...structuredClone(body),digest:continuationDigest(body)})
}
/** Callback implementations/permissions are rechecked locally; they are not serialized. */
export function authoringContinuationContract(context:PlanningContext,options:{frontend:'compact-v1'|'template-fill-v1';requiredCoverageIds?:readonly string[];catalogDigest?:string;completionDigest?:string}):string {
  return continuationDigest({protocolVersion:1,frontend:options.frontend,context,requiredCoverageIds:options.requiredCoverageIds??['R1'],...(options.catalogDigest?{catalogDigest:options.catalogDigest}:{}),...(options.completionDigest?{completionDigest:options.completionDigest}:{})})
}
export interface PlanningContinuation {
  protocolVersion:1
  kind:'initial-clarification'|'draft-repair'
  hasDraft:boolean
  scope:string
  draftRevision:number
  submissions:number
  remainingSubmissions:number
  contracts:{schemaDigest:string;contractDigest:string;loaded?:LoadedPlanningContracts}
  /** Existing draft is Host-owned; only these current local slots need a response. */
  unresolved:string[]
  feedback?:RepairFeedback
}
