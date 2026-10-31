import { businessModuleCatalog } from '../../shared/planning-business-modules.ts'
import { templateIdForTool } from '../../shared/planning-node-templates.ts'
import { materializePlanningCandidate } from '../../shared/planning-projection.ts'
import { allNodes } from '../../shared/workflow-validation.ts'
import { planningCreateRequestSkeletons } from './command-brief.ts'
import type { PlanningTask } from './service.ts'

const record=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined

/** View-only advice. Match the last authoring diagnostics to exact node/tool
 * identities, never prose, earlier repair rounds, or a guessed business intent. */
export function planningModuleHint(task:PlanningTask) {
  if(task.state!=='failed'||task.request.handoff&&task.request.handoff.mode!=='partial')return undefined
  if(task.compilerDraft&&task.compilerDraft.purpose!=='author')return undefined
  const draft=task.compilerDraft?.purpose==='author'?task.compilerDraft:undefined
  const issues=draft?draft.issues:task.diagnostics,document=record(draft?.document)
  let candidate=task.candidate
  if(!draft&&task.output?.outcome==='candidate'&&task.context){
    try{candidate=materializePlanningCandidate(task.output.graphJson,task.context)}catch{return undefined}
  }
  const module=businessModuleCatalog().find(module=>module.diagnosticCoverage.some(rule=>issues.some(issue=>{
    if(issue.code!==rule.code)return false
    if(draft){
      // Compiler diagnostics use JSON pointers into the normalized draft. A
      // stale candidate or UUID mentioned in a message is not node evidence.
      const parts=issue.path?.split('/').slice(1).map(part=>part.replace(/~1/g,'/').replace(/~0/g,'~'))
      if(!parts||parts.length<2||!['nodesByKey','formsByKey'].includes(parts[0]!))return false
      const node=record(record(document?.[parts[0]!])?.[parts[1]!])
      if(parts[0]==='nodesByKey')return node?.kind===rule.nodeKind&&rule.toolIds.includes(String(record(node.config)?.toolId))
      return rule.nodeKind==='tool'&&rule.toolIds.some(id=>node?.template===templateIdForTool(id))
    }
    const node=candidate&&allNodes(candidate).find(node=>node.id===issue.nodeId)
    return node?.kind===rule.nodeKind&&rule.toolIds.includes(node.config.toolId??'')
  })))
  if(!module)return undefined
  const skeleton=planningCreateRequestSkeletons().module
  return {module:`${module.id}@${module.version}`,reason:'这些诊断对应模块已固化的结构',applicability:module.applicability,
    parameterExample:module.parameterExample,skeleton:{...skeleton,handoff:{...skeleton.handoff,module:{moduleId:module.id,version:module.version,instanceKey:'review',parameters:module.parameterExample}}}}
}
