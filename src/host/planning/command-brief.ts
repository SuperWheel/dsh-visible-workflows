import { fragmentCatalog } from '../../shared/planning-module-fragment-contract.ts'
import { businessModuleCatalog } from '../../shared/planning-business-modules.ts'
import { BUSINESS_MODULE_INSTANCE_KEY_RULE } from '../../shared/planning-business-module-contract.ts'
import type { Workflow } from '../../shared/types.ts'
import { allNodes } from '../../shared/workflow-validation.ts'
import { buildTrialSkeleton, trialSkeletonReport } from './trial-skeleton.ts'
import type { PlanningTask } from './service.ts'

export const PLANNING_ROUTE_GUIDANCE='新建默认用 visible_workflow_create，模块检查由 Host 做。用 visible_workflow_plan 新建时：create 逐个检查 modules[].applicability；适用用模块骨架（Host 实例化，0 次规划调用），全部不适用才设计。设计须填 moduleCheck:{checked:[全部 id@version],notApplicable:不适用理由}（1–400字符）；Host 仅核对集合和存在性。'
export const PLANNING_MODULE_HINT_GUIDANCE='设计失败且带 moduleHint 时，若请求符合该模块的 applicability，则改用模块路线，不重试设计；Host 不自动切换路线。'

export const PLANNING_WORKFLOW_INDEX_GUIDANCE='简报只给已保存工作流数量（workflowCount），不逐个列出（T31.6）；要找某个工作流或请用户选择时用 visible_workflow_list，范围是当前 workspace+global，排除归档/其他私有图。按名称/ID查找；新建不覆盖同名图，无需list核重名；完整图按需查询。'
export const PLANNING_RECEIPT_GUIDANCE='execute-first：reviewItems留最终审阅；Host保存后跑一次。按receipt.workflowId/revision、verification.graph、checksPassed、workspaceChanges汇报，无需重读。用户需节点细节才用 visible_workflow_nodes；完整图用 plan_get include_candidates=true。固定行为/文案以 fixedBehaviours/fixedFacts 为准，勿重读节点或检索安装目录/源码核验。created已保存，proposed待接受；回执不证明业务/Desktop通过。'
export const PLANNING_PROPOSAL_GUIDANCE='待接受提案：告诉用户在画布「查看修改」中接受或拒绝，然后结束本回合；不要用提问卡询问是否已接受，也不要等待接受；用户接受后另行要求运行时再运行。'

/** Fill the data slots; executable examples are regression-tested against the entry gate. */
export function planningCreateRequestSkeletons() {
  const moduleCheck={checked:businessModuleCatalog().map(module=>`${module.id}@${module.version}`),notApplicable:'逐个说明不适用理由'}
  const common={requestId:'stable_request_id',operation:'create' as const,instruction:'完整需求'}
  return {
    designOnly:{...common,moduleCheck,execution:{mode:'design-only'}},
    executeFirst:{...common,moduleCheck,execution:{mode:'execute-first',task:'本次真实任务',tools:['read','write'],artifacts:[{path:'result.txt',format:'text',checks:[{kind:'text-includes',value:'必要文本'}]}]}},
    module:{...common,execution:{mode:'design-only'},handoff:{version:1,mode:'module',module:{moduleId:'module_id',version:'1.0.0',instanceKey:'instance_key',parameters:{}}}},
    moduleInstanceKeyRule:BUSINESS_MODULE_INSTANCE_KEY_RULE,
  }
}

/** Compact catalog lines retain every fragment's purpose and ports.
 * The full structured catalog remains available through template queries. */
export function planningFragmentBriefLines(){return fragmentCatalog().map(m=>m.module+' '+m.purpose+' ['+m.ports.inputs.join(',')+'→'+m.ports.outputs.join(',')+']')}

/** Metadata only. This shared projection never serializes workflow nodes/config. */
export function buildPlanningCommandBrief(workspaceId:string,workflows:readonly Workflow[]):string {
  return JSON.stringify({routeRule:PLANNING_ROUTE_GUIDANCE,source:'Host 目录简报；非用户原话或授权',workspaceId,
    fragmentModules:planningFragmentBriefLines(),http:'原样响应；>256KB由Host缓存，下游引用取全文；下载限10MB。',htmlTools:['builtin:html.extract_text HTML→标题/正文；不执行脚本/联网。','builtin:html.select CSS→记录文本/属性，补全链接；不联网。'],
    modules:businessModuleCatalog().map(module=>({module:`${module.id}@${module.version}`,title:module.title,
      applicability:module.applicability,parameters:module.parameters,parameterExample:module.parameterExample,fixedBehaviours:module.fixedBehaviours,
      ...(module.fixedFacts?{fixedFacts:module.fixedFacts}:{}),
      humanReview:module.humanReview,limitations:module.limitations})),
    workflowCount:workflows.length,
    workflowIndex:PLANNING_WORKFLOW_INDEX_GUIDANCE,verificationReceipt:PLANNING_RECEIPT_GUIDANCE,
    routes:'路由与执行模式规则见 visible-workflows:guide。',
    createRequestSkeletons:planningCreateRequestSkeletons(),optionalCreateFields:{title:'用户给出的工作流名：已命名必传 request.title；未命名才省略'},
    fullCatalogs:'完整目录按需查询。'})
}

/** Compare frozen endpoints only; unrelated edits are observations, not task effects. */
export function workspaceChangeVerification(task:PlanningTask) {
  const snapshot=task.workspaceSnapshot,receipt=task.receipt
  if(task.request.operation!=='create'||task.state!=='published'||!receipt||!snapshot?.published)return undefined
  const otherWorkflows=[...new Set([...Object.keys(snapshot.accepted),...Object.keys(snapshot.published)])]
    .filter(id=>id!==receipt.workflowId).sort().map(id=>{
      const acceptedRevision=Object.hasOwn(snapshot.accepted,id)?snapshot.accepted[id]!:null,publishedRevision=Object.hasOwn(snapshot.published!,id)?snapshot.published![id]!:null
      return {workflowId:id,acceptedRevision,publishedRevision,unchanged:acceptedRevision===publishedRevision}
    })
  return {source:'Host 受理与发布时当前工作区及 global（含归档）的版本比较；其他工作流的变化不归因于本任务，不证明业务已执行',
    taskWorkflow:{workflowId:receipt.workflowId,action:receipt.kind==='created'?'created':'proposed',revision:receipt.revision},
    otherWorkflows,changedWorkflowIds:otherWorkflows.filter(row=>!row.unchanged).map(row=>row.workflowId),
    existingWorkflowsUnchanged:otherWorkflows.every(row=>row.unchanged)}
}

/** Frozen publication facts: no storage reread, configs, or new persisted evidence. */
function publicationFacts(task:PlanningTask) {
  const {receipt,candidate,candidateDigest}=task
  if(task.state!=='published'||!receipt||!candidate||!candidateDigest||receipt.digest!==candidateDigest||receipt.workflowId!==candidate.id)return undefined
  const nodes=allNodes(candidate)
  return {graph:{workflowId:receipt.workflowId,revision:receipt.revision,status:receipt.kind==='created'?'saved':'proposal-pending',
    candidateDigest,nodeCount:nodes.length,nodeSummary:nodes.map(({title,kind})=>({title,kind}))},
    reporting:PLANNING_RECEIPT_GUIDANCE,
    revisionMeaning:receipt.kind==='created'?'本次保存版本；不表示之后的实时状态':'提案基线版本；节点摘要为待接受候选，不表示修改已保存',
    ...(receipt.kind==='proposed'?{nextStep:PLANNING_PROPOSAL_GUIDANCE}:{})}
}

/** View-only projection of checks recorded for this exact authored candidate. */
export function designVerificationReceipt(task:PlanningTask) {
  const checks=task.designChecks,output=task.output,facts=publicationFacts(task)
  if(!facts||!checks?.candidateDigest||checks.candidateDigest!==task.candidateDigest||!output||output.outcome!=='candidate'||task.diagnostics.length||task.request.handoff&&task.request.handoff.mode!=='partial')return undefined
  return {...facts,source:'Host 结构检查回执；需求覆盖来自创作计划的声明，不是业务行为证明，也不代表业务已执行或 Desktop 验收',
    requirementCoverage:output.requirementCoverage,checksPassed:checks.checksPassed,assumptions:output.assumptions,
    ...trialSkeletonFacts(task,output.assumptions),
    unresolvedItems:[...output.questions.map(question=>question.question),...(task.procedure?.reviewItems??[]),...(task.readiness?.issues.map(issue=>issue.message)??[])]}
}

/** Doc 26: the skeleton is a starting point, not a gate; report what changed and the stated reasons. */
function trialSkeletonFacts(task:PlanningTask,assumptions:readonly string[]){
  const skeleton=task.compilerMode==='template-fill'&&!task.request.handoff&&task.request.source?.kind==='verified-trial'&&task.context?buildTrialSkeleton(task.context):undefined
  if(!skeleton||!task.candidate)return {}
  return {trialSkeleton:{...trialSkeletonReport(skeleton,task.candidate,assumptions),meaning:'试做骨架节点的沿用与调整；调整不阻断发布，汇报时如实转述调整及理由（含未说明理由）。'}}
}

/** Generated only for a verified module candidate; never claims a business run. */
export function moduleVerificationReceipt(task:PlanningTask) {
  const provenance=task.moduleProvenance,facts=publicationFacts(task)
  if(!facts||!provenance||task.diagnostics.length||task.request.handoff?.mode!=='module')return undefined
  const module=businessModuleCatalog().find(row=>row.id===provenance.moduleId&&row.version===provenance.version)
  if(!module||module.implementationDigest!==provenance.implementationDigest)return undefined
  return {...facts,source:'Host 验证回执；不代表业务已执行或 Desktop 验收',module:`${module.id}@${module.version}`,
    parameters:(task.request.handoff.module as {parameters:unknown}).parameters,implementationDigest:module.implementationDigest,
    checksPassed:['candidate-schema','references-and-scope','authority','module-provenance-and-fixed-implementation','tool-preconditions','REVIEW_BEFORE_EFFECT'],
    fixedBehaviours:module.fixedBehaviours,...(module.fixedFacts?{fixedFacts:module.fixedFacts}:{}),humanReview:module.humanReview}
}
