import { z } from 'zod'
import { compilerJson } from './planning-repair.ts'
import { planningChainRequestSchema } from './planning-chain-contract.ts'
import { businessModuleRequestSchema } from './planning-business-module-contract.ts'

const identity=z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const field=z.string().min(1).max(100).regex(/^[A-Za-z][A-Za-z0-9_]*$/).refine(value=>!['body','constructor','prototype','__proto__'].includes(value),'不能通过字段更新重建容器或修改宿主元数据')
const change=z.discriminatedUnion('op',[
  z.object({op:z.literal('set-title'),nodeId:identity,value:z.string().trim().min(1).max(200)}).strict(),
  z.object({op:z.literal('set-config'),nodeId:identity,field,value:z.unknown().transform(value=>compilerJson(value))}).strict(),
  z.object({op:z.literal('unset-config'),nodeId:identity,field}).strict(),
])
const common={constraints:z.array(z.string().min(1).max(2000)).max(50).default([]),evidenceRefs:z.array(identity).max(100).default([])}
const unresolved=z.array(z.object({nodeId:identity,fields:z.array(field).min(1).max(30),question:z.string().min(1).max(4000)}).strict()).min(1).max(50)
/** Parent decisions are data, never authority. A field value replaces that entire field. */
export const planningHandoffSchema=z.union([
  z.object({version:z.literal(3),...common,mode:z.literal('chain'),chain:planningChainRequestSchema}).strict(),
  z.object({version:z.literal(1),...common,mode:z.literal('edit'),changes:z.array(change).min(1).max(200)}).strict(),
  z.object({version:z.literal(1),...common,mode:z.literal('module'),module:businessModuleRequestSchema}).strict(),
  z.object({version:z.literal(1),...common,mode:z.literal('partial'),changes:z.array(change).max(200),unresolved}).strict(),
  z.object({version:z.literal(2),...common,mode:z.literal('partial'),changes:z.array(change).max(200),unresolved,completion:z.array(z.object({nodeId:identity,field,require:z.enum(['changed','present'])}).strict()).min(1).max(200)}).strict(),
]).superRefine((value,ctx)=>{
  if(value.mode==='module'||value.mode==='chain')return
  const fields=new Set<string>()
  for(const item of value.changes){const key=JSON.stringify([item.nodeId,item.op==='set-title'?'title':'config.'+item.field]);if(fields.has(key))ctx.addIssue({code:'custom',message:'同一节点字段不能重复或冲突提交'});fields.add(key)}
  if(value.mode==='partial')for(const item of value.unresolved)for(const name of item.fields){const key=JSON.stringify([item.nodeId,'config.'+name]);if(fields.has(key))ctx.addIssue({code:'custom',message:'已确定字段与未决字段不能重叠'});fields.add(key)}
  if(value.version===2){
    const allowed=new Set(value.unresolved.flatMap(row=>row.fields.map(name=>JSON.stringify([row.nodeId,name])))),seen=new Set<string>()
    for(const item of value.completion){const key=JSON.stringify([item.nodeId,item.field]);if(!allowed.has(key)||seen.has(key))ctx.addIssue({code:'custom',message:'完成义务必须唯一且属于同一未决节点字段'});seen.add(key)}
  }
})
export type PlanningHandoff=z.infer<typeof planningHandoffSchema>

