import { z } from 'zod'

export const planningCommitSchema = z.object({key:z.string().regex(/^[a-f0-9]{64}$/),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
export type PlanningCommit = z.infer<typeof planningCommitSchema>
export const planningReceiptSchema = planningCommitSchema.extend({kind:z.enum(['created','proposed']),workflowId:z.string().min(1).max(160),revision:z.number().int().nonnegative(),proposalId:z.string().min(1).max(160).optional()}).strict().superRefine((value,ctx)=>{
  if((value.kind==='proposed')!==(value.proposalId!==undefined))ctx.addIssue({code:'custom',message:'提案回执必须且仅能携带 proposalId'})
})
export type PlanningReceipt = z.infer<typeof planningReceiptSchema>
export function appendPlanningReceipt(previous:PlanningReceipt[]|undefined,receipt:PlanningReceipt):PlanningReceipt[]{
  const records=previous??[],parsed=planningReceiptSchema.parse(receipt)
  if(records.some(record=>record.key===parsed.key))throw new Error('规划提交身份已存在')
  if(records.length>=2000)throw new Error('规划提交回执已达容量限制，请先归档规划记录')
  return [...records,parsed]
}
