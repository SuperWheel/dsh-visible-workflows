import { z } from 'zod'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { PlanningContext } from '../../shared/planning-types.ts'
import { WorkflowAuthoringCompiler } from '../../shared/planning-authoring.ts'

export const planningCompilerModeSchema=z.enum(['legacy','compact-repair','template-fill'])
export type PlanningCompilerMode=z.infer<typeof planningCompilerModeSchema>
const pending=z.object({protocolVersion:z.literal(1),state:z.literal('pending'),requestedMode:planningCompilerModeSchema}).strict()
const frozen=z.object({
  protocolVersion:z.literal(1),state:z.literal('frozen'),requestedMode:planningCompilerModeSchema,effectiveMode:planningCompilerModeSchema,
  reason:z.enum(['configured','baseline-tool-template-unavailable','typed-partial-handoff','legacy-retired']),nodeIds:z.array(z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)).max(500),
}).strict().superRefine((value,ctx)=>{
  if(new Set(value.nodeIds).size!==value.nodeIds.length)ctx.addIssue({code:'custom',message:'模式选择包含重复节点'})
  if(value.reason==='configured'?(value.effectiveMode!==value.requestedMode||value.nodeIds.length!==0):['typed-partial-handoff','legacy-retired'].includes(value.reason)?(value.requestedMode!=='legacy'||value.effectiveMode!=='compact-repair'||value.nodeIds.length!==0):(value.requestedMode!=='template-fill'||value.effectiveMode!=='compact-repair'||!value.nodeIds.length))
    ctx.addIssue({code:'custom',message:'模式选择与回退原因不匹配'})
})
export const planningCompilerSelectionSchema=z.discriminatedUnion('state',[pending,frozen])
export type PlanningCompilerSelection=z.infer<typeof planningCompilerSelectionSchema>
export type FrozenCompilerSelection=Extract<PlanningCompilerSelection,{state:'frozen'}>

/** Metadata-only choice for a new task. No exception is interpreted as permission to downgrade. */
export function selectPlanningCompiler(requestedMode:PlanningCompilerMode,context:PlanningContext):FrozenCompilerSelection {
  const selection:FrozenCompilerSelection={protocolVersion:1,state:'frozen',requestedMode,effectiveMode:requestedMode,reason:'configured',nodeIds:[]}
  if(requestedMode==='legacy')return {...selection,effectiveMode:'compact-repair',reason:'legacy-retired'}
  if(requestedMode!=='template-fill'||context.operation!=='revise')return selection
  const available=new Set(context.tools.filter(tool=>tool.available).map(tool=>tool.id)),targets=new Set(context.targetNodeIds),missingTools=new Set<string>()
  const visit=(nodes:PlanningContext['workflow']['nodes'],fixedAncestor=false):void=>{
    for(const node of nodes){
      const fixed=fixedAncestor||node.fixed
      // All current non-tool kinds have templates. An unavailable baseline tool
      // can still be retained by compact edits; it cannot be introduced anew.
      if(!fixed&&(!targets.size||targets.has(node.id))&&node.kind==='tool'&&node.config.toolId&&!available.has(node.config.toolId)){
        selection.nodeIds.push(node.id);missingTools.add(node.config.toolId)
      }
      if(node.config.body)visit(node.config.body.nodes,fixed)
    }
  }
  visit(context.workflow.nodes)
  if(!selection.nodeIds.length)return selection
  // Do not select a frontend that cannot itself represent the shared contract.
  // Unsupported tool schemas must fail, even when that tool is unavailable.
  assertObjectJsonSchema(new WorkflowAuthoringCompiler(context).schema)
  for(const id of missingTools){
    const tool=context.tools.find(tool=>tool.id===id)
    if(tool)assertObjectJsonSchema(tool.inputSchema)
  }
  return {...selection,effectiveMode:'compact-repair',reason:'baseline-tool-template-unavailable'}
}
