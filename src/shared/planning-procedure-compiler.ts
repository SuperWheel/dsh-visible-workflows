import { z } from 'zod'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { parseTaskProcedure, TaskProcedureValidationError, taskSpecificationRefs, PROCEDURE_STEP_EVIDENCE_GUIDANCE, PROCEDURE_REVIEW_GUIDANCE, TRIAL_REVIEW_GUIDANCE, type ConversationEvidence, type RetrospectiveOutput } from './retrospective.ts'
import { compilerJson, CompilerError, issueFromError, needsInputSchema, needsInputWireSchema, pointer, RepairSession, submissionSchema, type CompilerIssue } from './planning-repair.ts'
import type { PlanningContext } from './planning-types.ts'
const str:JsonSchemaNode={type:'string'},strings:JsonSchemaNode={type:'array',items:str}
const object=(properties:Record<string,JsonSchemaNode>,required=Object.keys(properties)):JsonSchemaNode=>({type:'object',properties,required,additionalProperties:false})
/** Shared native wire shape; Host validators enforce all size and provenance limits. */
export function procedureWireSchema(eventIds?:readonly string[],trialTask?:PlanningContext['trialTask'],rehearsal=!!trialTask):JsonSchemaNode{
  const specRefs=taskSpecificationRefs(trialTask)
  // The native SDK subset cannot express minItems; parseTaskProcedure enforces it.
  const eventRefs:JsonSchemaNode={type:'array',items:{type:'string',...(eventIds?{enum:[...eventIds]}:{})},description:eventIds?'至少1条冻结事件 ID，不能空数组；任务规范只能放 specRefs，不是执行事件。':'至少1条路径调用编号（c加编号，如 c3），Host 映射到该调用及其结果；规范放 specRefs。'}
  return object({
    goal:str,parameters:{type:'array',items:object({name:str,description:str})},rules:strings,
    steps:{type:'array',description:PROCEDURE_STEP_EVIDENCE_GUIDANCE+(rehearsal?TRIAL_REVIEW_GUIDANCE:PROCEDURE_REVIEW_GUIDANCE),items:object({id:str,title:str,instruction:str,dependsOn:strings,evidenceRefs:{...eventRefs,description:PROCEDURE_STEP_EVIDENCE_GUIDANCE},requiresReview:{type:'boolean',description:rehearsal?'仅用户明确要求未来每次运行时人工审核才为true，试做缺口或reviewItems不构成该要求。':'未来每次复核或未确认事项的业务约束；附在有事件依据的步骤，不表示人工复核已经发生。'},...(specRefs.length||!eventIds?{specRefs:{type:'array',items:{type:'string',...(specRefs.length?{enum:specRefs}:{})},description:(specRefs.length?'':'只能用 trialTask.task、trialTask.inputs[i]、trialTask.artifacts[i]、trialTask.reviewItems[i]（i 从 0 起）；')+'冻结任务规范引用；用于约束有事件依据的业务步骤，不能替代 evidenceRefs。'} as JsonSchemaNode}:{})},['id','title','instruction','dependsOn','evidenceRefs','requiresReview'])},
    excluded:{type:'array',items:object({evidenceRefs:eventRefs,reason:str})},reviewItems:{...strings,description:rehearsal?'可选：最终报告备注（如未跑通缺口）；不代表运行时人工节点或已复核。':'原样保留未来每次必须执行的人工复核要求；不能声称该复核已执行。'},
  })
}

export interface ProcedureCompilerOptions{
  maxSubmissions?:number
  onSubmission?:ConstructorParameters<typeof RepairSession>[1]['onSubmission']
  /** Host-owned checkpoint binding, identical to the authoring stage. */
  resume?:ConstructorParameters<typeof RepairSession>[1]['resume']
  resumeScope?:string
  contractDigest?:string
}
/** Typed distillation plus local repair, sharing the original provenance validator. */
export function createProcedureCompiler(evidence:ConversationEvidence,trialTask:PlanningContext['trialTask'],options:ProcedureCompilerOptions={}):RepairSession<RetrospectiveOutput>{
  const source=compilerJson(evidence),spec=trialTask?compilerJson(trialTask):undefined,specRefs=taskSpecificationRefs(spec)
  const procedureWire=procedureWireSchema(source.records.map((row:any)=>row.id),trialTask)
  const initial=object({mode:{type:'string',const:'distill'},procedure:procedureWire,summary:str},['mode','procedure'])
  const repairRoots=(document:any)=>[...new Set(['procedure','summary','questions',...Object.keys(document??{})])].filter(key=>key!=='mode').map(key=>pointer([key]))
  return new RepairSession(submissionSchema(initial,needsInputWireSchema),{maxSubmissions:options.maxSubmissions??2,onSubmission:options.onSubmission,resume:options.resume,resumeScope:options.resumeScope,contractDigest:options.contractDigest,roots:repairRoots,
    compile:document=>{
      if(document?.mode==='needs-input'){
        const value=needsInputSchema.parse(document)
        return {outcome:'needs-input',procedureJson:'',summary:value.summary,questions:value.questions}
      }
      const wire=z.object({mode:z.literal('distill'),procedure:z.unknown(),summary:z.string().max(10000).default('已提炼任务方法')}).strict().parse(document)
      let procedure:ReturnType<typeof parseTaskProcedure>
      try{procedure=parseTaskProcedure(wire.procedure,source,specRefs,!!trialTask)}catch(error){
        if(error instanceof z.ZodError)throw new z.ZodError(error.issues.map(issue=>({...issue,path:['procedure',...issue.path]})))
        if(error instanceof TaskProcedureValidationError)throw new CompilerError(error.code,error.message,pointer(['procedure',...error.path]))
        throw error
      }
      return {outcome:'procedure',procedureJson:JSON.stringify(procedure),summary:wire.summary,questions:[]}
    },
    diagnose:(error,document):CompilerIssue[]=>{
      const roots=repairRoots(document)
      // Return all offending fields at once, without silently deleting annotations.
      const issues:CompilerIssue[]=[],duplicates:CompilerIssue[]=[]
      const allowed=new Set(source.records.map((row:any)=>row.id)),procedure=document?.procedure
      for(const collection of ['steps','excluded']as const){
        if(!Array.isArray(procedure?.[collection]))continue
        for(const [i,item]of procedure[collection].entries()){
          if(!Array.isArray(item?.evidenceRefs))continue
          if(new Set(item.evidenceRefs).size!==item.evidenceRefs.length){
            const path=pointer(['procedure',collection,i,'evidenceRefs'])
            duplicates.push({code:'DUPLICATE_EVIDENCE_REFS',message:'步骤或排除项的证据引用重复',path,allowedPaths:[path]})
          }
          const bad=item.evidenceRefs.filter((ref:unknown)=>typeof ref!=='string'||!allowed.has(ref))
          if(bad.length){
            const path=pointer(['procedure',collection,i,'evidenceRefs'])
            issues.push({code:'INVALID_EVIDENCE_REFS',path,message:'evidenceRefs 只接收冻结执行事件 '+[...allowed].join(', ')+
              '。非法引用 '+JSON.stringify(bad)+'；任务规范可明确移至 specRefs（允许 '+specRefs.join(', ')+
              '）。requirement.R1 属于 Host 已绑定的设计控制，不是执行证据。只有规范且没有事件的业务步骤不能证明已执行。',
              allowedPaths:collection==='steps'?[path,pointer(['procedure','steps',i,'specRefs'])]:[pointer(['procedure','excluded',i])]})
          }
        }
      }
      // Duplicates are reported in the same evidence pass, every array at once.
      if(issues.length||error instanceof CompilerError&&error.code==='DUPLICATE_EVIDENCE_REFS'&&duplicates.length)return [...issues,...duplicates]
      // Uncovered evidence may join a step or the exclusions; nothing else needs to change.
      if(error instanceof CompilerError&&error.code==='UNCOVERED_EVIDENCE')
        return [{code:error.code,message:error.message,path:pointer(['procedure','excluded']),allowedPaths:[pointer(['procedure','excluded']),pointer(['procedure','steps'])]}]
      if(error instanceof z.ZodError){
        return error.issues.slice(0,40).map(issue=>{
          const path=pointer(issue.path.map(String))
          const paths=issue.code==='unrecognized_keys'?(path?[path]:issue.keys.map(key=>pointer([key]))):path?[path]:roots
          return {code:'INVALID_PROCEDURE_FIELDS',message:issue.message,path,allowedPaths:paths}
        })
      }
      return issueFromError(error,roots)
    },
  })
}

