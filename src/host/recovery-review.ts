import { createHash } from 'node:crypto'
import { z } from 'zod'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { WorkflowRun } from '../shared/types.ts'
import type { RecoveryReview } from '../shared/recovery-review.ts'
import { allNodes } from '../shared/workflow-validation.ts'
import { buildRecoveryPlan, type RecoveryPlan } from './recovery-plan.ts'
import { nativeOutputSchema } from './native-agent.ts'

const reviewSchema=z.object({baseDigest:z.string().regex(/^[a-f0-9]{64}$/),decisions:z.array(z.object({executionId:z.string().min(1).max(1000),action:z.enum(['completed','redo','abandon']),evidence:z.string().trim().max(4000).optional(),output:z.record(z.string(),z.unknown()).optional()}).strict()).max(1000)}).strict()
const external=new Set(['agent','tool','http','document'])
function plainOutput(value:unknown):asserts value is Record<string,import('../shared/types.ts').JsonValue>{
  const visit=(item:unknown,depth=0):void=>{if(depth>24)throw new Error('核验输出嵌套过深');if(item===null||typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return;if(Array.isArray(item)){item.forEach(value=>visit(value,depth+1));return}if(item&&typeof item==='object'&&Object.getPrototypeOf(item)===Object.prototype){for(const [key,value]of Object.entries(item)){if(['__proto__','prototype','constructor'].includes(key))throw new Error('核验输出包含不安全字段');visit(value,depth+1)}return}throw new Error('核验输出必须为 JSON 数据')}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('请提供已核实的 JSON 对象输出')
  visit(value);if(JSON.stringify(value).length>1_000_000)throw new Error('核验输出超过 1 MB')
}
/** A review is an explicit one-time recovery decision; source history is never rewritten. */
export function reviewedRecovery(source:WorkflowRun,raw?:unknown):{plan:RecoveryPlan;source:WorkflowRun;review?:RecoveryReview}{
  const base=buildRecoveryPlan(source,'resume'),plan=structuredClone(base),copy=structuredClone(source)
  const nodes=allNodes(source.graph)
  for(const item of plan.items){const record=source.executions.find(record=>(record.executionId??record.nodeId)===item.executionId),node=nodes.find(node=>node.id===item.nodeId)
    item.reviewable=!!record&&!!node&&external.has(node.kind)&&item.action==='blocked'&&(item.reason.startsWith('外部操作已启动但结果未确认')||item.reason.startsWith('已完成的外部操作不能自动重放'))
  }
  if(raw===undefined)return {plan,source:copy}
  const parsed=reviewSchema.parse(raw)
  if(parsed.baseDigest!==base.planDigest)throw new Error('核验依据已变化，请重新查看恢复计划')
  const seen=new Set<string>()
  for(const decision of parsed.decisions){
    if(seen.has(decision.executionId))throw new Error('同一执行实例不能重复核验');seen.add(decision.executionId)
    const item=plan.items.find(item=>item.executionId===decision.executionId)
    if(!item?.reviewable)throw new Error('该执行实例不允许通过外部动作核验解除阻断')
    const record=copy.executions.find(record=>(record.executionId??record.nodeId)===item.executionId)!,node=nodes.find(node=>node.id===item.nodeId)!
    if(decision.action==='abandon'){item.reason='用户放弃此动作；本次恢复不会执行';continue}
    if(decision.action==='completed'){
      if(record.status==='success'||item.reviewCanComplete===false)throw new Error('已成功但失效的旧结果不能用“已完成”绕过失效规则；请核验并选择重做')
      if(Object.values(node.config.verification??{}).some(value=>Array.isArray(value)&&value.length))throw new Error('此节点配置了资料或文件证据验证，不能通过手工结果跳过；请先核验这些证据')
      plainOutput(decision.output)
      if(node.kind==='agent'||node.config.outputSchema?.length){const errors=validateJsonSchemaValue(nativeOutputSchema(node.config.outputSchema),decision.output);if(errors.length)throw new Error(`核验输出不符合结构：${errors.join('；')}`)}
      const text=typeof decision.output.text==='string'?decision.output.text:JSON.stringify(decision.output)
      if(text.trim().length<(node.config.verification?.minTextLength??0))throw new Error('核验输出未达到最小文本长度')
      record.status='success';record.data=structuredClone(decision.output);record.output=text;delete record.error
      record.verification={status:'unverified',reasons:['用户根据外部回执确认完成并提供输出；插件未独立验证外部业务结果']}
      item.action='reuse';item.reason='采用用户核验提供的结果，不重新发送原动作；外部业务结果未由插件独立验证'
    }else {if(decision.output!==undefined)throw new Error('允许重做不能同时提交完成输出');item.action='rerun';item.reason='用户已核验并明确允许此实例重做；外部动作可能再次发生'}
    plan.blockedReasons=plan.blockedReasons.filter(reason=>!reason.startsWith(`${item.executionId}：`))
  }
  plan.allowed=plan.blockedReasons.length===0&&!plan.items.some(item=>item.action==='blocked')
  plan.invalidNodeIds=[...new Set(plan.items.filter(item=>item.action!=='reuse').map(item=>item.nodeId))].sort()
  const review=parsed as RecoveryReview
  plan.planDigest=createHash('sha256').update(JSON.stringify({base:base.planDigest,review})).digest('hex')
  return {plan,source:copy,review}
}
