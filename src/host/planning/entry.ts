import { z } from 'zod'
import { parsePlanningRequest, planningModuleCheckSchema } from '../../shared/planning-schema.ts'
import { optimizationTargetSchema } from '../../shared/planning-optimization.ts'
import { parsePlanningTrialSpec } from '../../shared/planning-trial.ts'
import { planningCreateRequestSkeletons } from './command-brief.ts'
import { businessModuleCatalog } from '../../shared/planning-business-modules.ts'
import { BUSINESS_MODULE_INSTANCE_KEY_RULE } from '../../shared/planning-business-module-contract.ts'

// Local formatting only: do not change global Zod configuration or admission rules.
function entryIssueSentences(issue:z.core.$ZodIssue,prefix:PropertyKey[]=[]):string[] {
  const fullPath=[...prefix,...issue.path],path=fullPath.map(String).join('.')||'request'
  if(issue.code==='invalid_union'){
    if(!issue.errors.length)return [`${path}：${'options' in issue&&issue.options?`必须是 ${issue.options.map(String).join(' 或 ')}`:'必须符合声明的联合结构'}。`]
    // Zod union branches carry relative paths. Select only an unambiguous
    // discriminator match for display; the original schema already rejected it.
    const matching=issue.errors.filter(branch=>!branch.some(item=>item.code==='invalid_value'&&item.path.length===1&&['version','mode','op','kind'].includes(String(item.path[0]))))
    if(matching.length===1)return matching[0]!.flatMap(item=>entryIssueSentences(item,fullPath))
    return [`${path}：须符合以下任一结构：${issue.errors.map(branch=>`（${branch.flatMap(item=>entryIssueSentences(item,fullPath)).join(' ')}）`).join('或')}。`]
  }
  const rule=issue.code==='custom'?issue.message:
    issue.code==='invalid_format'&&path==='handoff.module.instanceKey'?BUSINESS_MODULE_INSTANCE_KEY_RULE:
    issue.code==='invalid_type'?`必须是 ${issue.expected} 类型`:
    z.locales.zhCN().localeError!({...issue,input:undefined})
  return [`${path}：${rule}。`]
}

/** The command intake and ordinary plan tool share exactly the same entry gate. */
export function parsePlanningEntry(value:unknown,readOnly:boolean) {
  try{return parseEntry(value,readOnly)}catch(error){
    if(error instanceof z.ZodError)throw new Error(error.issues.flatMap(issue=>entryIssueSentences(issue)).join('\n'))
    throw error
  }
}

function parseEntry(value:unknown,readOnly:boolean) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('规划请求必须是JSON对象')
  const {execution,...rest}=value as Record<string,unknown>
  const catalog=businessModuleCatalog()
  const needsModuleCheck=rest.operation==='create'&&rest.handoff===undefined&&rest.source===undefined&&catalog.length>0
  const checked=planningModuleCheckSchema.safeParse(rest.moduleCheck)
  const ids=catalog.map(module=>`${module.id}@${module.version}`)
  const invalidModuleCheck=needsModuleCheck&&(!checked.success||checked.data.checked.length!==ids.length||new Set(checked.data.checked).size!==ids.length||ids.some(id=>!checked.data.checked.includes(id)))
  const missingExecution=execution===undefined&&rest.operation==='create'&&rest.source===undefined&&!readOnly
  if(invalidModuleCheck||missingExecution){
    const skeletons=planningCreateRequestSkeletons(),messages=[]
    if(missingExecution)messages.push('EXECUTION_SPEC_REQUIRED：保留原请求，仅补execution。Host不推断模式；仅用户明确“只设计/不要执行/先不要执行”时选designOnly，否则按executeFirst骨架填写真实任务、工具和产物验收；必要信息缺失时原生询问。试做失败不得自动切换design-only。')
    if(invalidModuleCheck)messages.push('MODULE_CHECK_REQUIRED：设计新建前请逐个对照下列模块适用条件，适用则改用模块骨架，否则补齐 moduleCheck（checked 须包含全部 id@version，不多、不少、不重复；notApplicable 为 1–400 字符的简短理由）。')
    throw new Error(messages.join('')+JSON.stringify({
      ...(invalidModuleCheck?{modules:catalog.map(module=>({module:`${module.id}@${module.version}`,applicability:module.applicability})),module:skeletons.module,moduleInstanceKeyRule:skeletons.moduleInstanceKeyRule,moduleCheck:skeletons.designOnly.moduleCheck}:{}),
      requestId:rest.requestId,operation:rest.operation,title:rest.title,
      ...(missingExecution?{executionOptions:{designOnly:{execution:skeletons.designOnly.execution},executeFirst:{execution:skeletons.executeFirst.execution}}}:{}),
    }))
  }
  if(execution!==undefined){
    if(!execution||typeof execution!=='object'||Array.isArray(execution))throw new Error('execution必须是JSON对象')
    const {mode,...spec}=execution as Record<string,unknown>
    if(mode==='execute-first'){
      // Final-report notes belong to the trial spec; Desktop r34 resubmitted twice to move them.
      if(rest.reviewItems!==undefined&&spec.reviewItems===undefined){spec.reviewItems=rest.reviewItems;delete rest.reviewItems}
      const request=z.object({requestId:z.string(),operation:z.literal('create'),instruction:z.string(),title:z.string().trim().min(1).max(160).optional(),targetWorkflowId:z.string().optional(),expectedRevision:z.literal(0).optional(),preview:z.literal(true).optional(),optimizationTarget:optimizationTargetSchema.optional(),moduleCheck:planningModuleCheckSchema.optional()}).strict().parse(rest)
      // Also enforce the ordinary identity/instruction limits before admitting a trial.
      parsePlanningRequest({...request,optimizationTarget:undefined})
      return {request,execution:{mode:'execute-first' as const,...parsePlanningTrialSpec(spec)}}
    }
    if(mode!=='design-only'||Object.keys(spec).length)throw new Error('execution.mode只支持execute-first或显式design-only')
    if(rest.operation!=='create'||rest.source!==undefined)throw new Error('design-only只用于无来源的新建设计')
  }
  return {request:parsePlanningRequest(rest),execution:execution?{mode:'design-only' as const}:undefined}
}
