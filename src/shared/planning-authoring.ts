import type { PlanningContext } from './planning-types.ts'
import { AuthoringCore, type AuthoringOptions, type CompiledAuthoring } from './planning-authoring-core.ts'
import { authoringContinuationContract, type HostRepairCheckpoint } from './planning-continuation.ts'
import { RepairSession, type CompilerIssue } from './planning-repair.ts'
export { normalizeAuthoring, type AuthoringOptions, type CompiledAuthoring } from './planning-authoring-core.ts'

export type AuthoringResumeOptions=AuthoringOptions&{resume?:HostRepairCheckpoint;resumeScope?:string}

/** Compact authoring remains a compatible frontend to the shared materializer. */
export class WorkflowAuthoringCompiler {
  private readonly core:AuthoringCore
  readonly session:RepairSession<CompiledAuthoring>
  constructor(context:PlanningContext,options:AuthoringResumeOptions={}){
    this.core=new AuthoringCore(context,options)
    this.session=new RepairSession(this.core.schema,{
      maxSubmissions:options.maxSubmissions??3,
      ...(options.resumeScope?{resumeScope:options.resumeScope,contractDigest:authoringContinuationContract(context,{frontend:'compact-v1',requiredCoverageIds:options.requiredCoverageIds,completionDigest:options.completion?.digest})}:{}),
      ...(options.resume?{resume:options.resume}:{}),
      reservations:()=>this.core.exportReservations(),restoreReservations:value=>this.core.importReservations(value),
      normalize:input=>this.core.normalize(input),
      roots:doc=>this.core.repairRoots(doc),
      compile:doc=>this.core.compile(doc),
      diagnose:(error,doc)=>this.core.diagnose(error,doc),
      uniqueRepair:(doc,issues)=>this.core.uniqueRepair(doc,issues),
      onSubmission:options.onSubmission,
    })
  }
  get schema(){return this.core.schema}
  get instructions(){return this.core.instructions}
  get nextSchema(){return this.session.snapshot().revision?this.session.nextSchema:this.core.initialSchema()}
  submit(value:unknown){return this.session.submit(value)}
  rejectWire(value:unknown,issues:CompilerIssue[]){return this.session.rejectWire(value,issues)}
  snapshot(){return this.session.snapshot()}
  checkpoint(){return this.session.checkpoint()}
  continuation(){return this.session.continuation()}
  repairUnique(schemas?:readonly import('@deepseek-ai/dsh-tools').ObjectJsonSchema[]){return this.session.repairUnique(schemas)}
  fillKnown(input:unknown){return this.core.withRequestedTitle(input)}
}
