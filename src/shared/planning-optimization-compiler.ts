import type { PlanningContext,PlanningIssue } from './planning-types.ts'
import type { Workflow } from './types.ts'
import { compileOptimizationEdits, optimizationEditsSchema } from './planning-edits.ts'
import { CompilerError, RepairSession, submissionSchema } from './planning-repair.ts'

/** Keeps the existing optimizer contract and authority checks; adds transactional local repair. */
export function createOptimizationCompiler(context:PlanningContext,base:Workflow,options:{maxSubmissions:number;onSubmission?:ConstructorParameters<typeof RepairSession>[1]['onSubmission'];validate?(result:ReturnType<typeof compileOptimizationEdits>):PlanningIssue[]}){
  return new RepairSession(submissionSchema(optimizationEditsSchema),{
    ...options,roots:()=>['/replacements','/summary'],
    compile:document=>{
      const result=compileOptimizationEdits(document,context,base)
      const issues=[...result.issues,...(options.validate?.(result)??[])]
      if(issues.length){
        const fatal=issues.some(i=>/FIXED|SCOPE|FORBIDDEN|HOST_FIELD/.test(i.code))
        throw new CompilerError(fatal?'FORBIDDEN':'INVALID_REPLACEMENT',issues.map(i=>i.message).join('; '),'/replacements',fatal)
      }
      return result
    },
  })
}
