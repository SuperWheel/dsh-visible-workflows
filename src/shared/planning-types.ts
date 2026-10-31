import type { ModelRef, NodeKind, ToolChoice, Workflow } from './types.ts'
import type { ConversationEvidence, ConversationSource } from './retrospective.ts'
import type { OptimizationTarget } from './planning-optimization.ts'
import type { PlanningTrialSpec, TrialVerificationReport } from './planning-trial.ts'
import type { PlanningToolOutputSnapshot } from './planning-tool-outputs.ts'
import type { PlanningHandoff } from './planning-handoff-contract.ts'
import type { PlanningContextSelection } from './planning-context-slice.ts'

export interface PlanningRequest {
  requestId: string
  operation: 'create' | 'revise'
  instruction: string
  /** Workflow name; module content parameters keep their own meaning. */
  title?: string
  targetWorkflowId?: string
  expectedRevision?: number
  targetNodeIds?: string[]
  preview?: boolean
  source?: ConversationSource | { kind: 'verified-trial'; trialId: string }
  /** Advisory design target; never an execution limit or authorization. */
  optimizationTarget?: OptimizationTarget
  /** Main-agent route audit only; never included in the design prompt. */
  moduleCheck?: { checked: string[]; notApplicable: string }
  handoff?: PlanningHandoff
  /** Set by the create entry when it instantiates a module: the Host runs the saved graph once, as after a trial. */
  runAfterSave?: true
}

export interface PlannerOutput {
  outcome: 'candidate' | 'needs-input'
  graphJson: string
  summary: string
  assumptions: string[]
  questions: { id: string; question: string; options: string[] }[]
  requirementCoverage: { requirementId: string; nodeIds: string[]; note: string }[]
}

/** Every identity pool and baseline comes from the Host, never from model output. */
export interface PlanningContext {
  workflow: Workflow
  operation: 'create' | 'revise'
  targetNodeIds: string[]
  nodeIds: string[]
  subagentIds: string[]
  environmentIds: string[]
  tools: ToolChoice[]
  /** Host-only output guarantees and call-scoped observations; never model-supplied. */
  toolOutputs?:PlanningToolOutputSnapshot
  contextSelection?:PlanningContextSelection
  model: ModelRef
  effort?: string
  conversation?: ConversationEvidence
  /** Host-resolved trial receipt; never supplied as model evidence. */
  trial?: { trialId: string; rootSessionId: string; childSessionId: string; workspaceId: string; specDigest: string; verificationDigest: string; evidenceDigest: string; receiptDigest: string }
  /** Trial submission, accepted only after deterministic procedure compilation. */
  trialProcedure?:unknown
  trialTask?: Pick<PlanningTrialSpec,'task'|'inputs'|'artifacts'|'reviewItems'>
  trialReport?:{verification:TrialVerificationReport;summary:string;summarySource:'agent-claim'}
}

export interface PlanningIssue { code: string; message: string; nodeId?: string; path?: string }
export interface PlanningNodeProjection {
  note?: string | null
  id: string
  kind: NodeKind
  title: string
  config: Record<string, unknown> & { body?: PlanningGraphProjection }
}
export interface PlanningGraphProjection {
  nodes: PlanningNodeProjection[]
  edges: { source: string; target: string; port?: string }[]
}
export interface PlanningProjection extends PlanningGraphProjection {
  moduleInstances?: import('./types.ts').WorkflowModuleInstance[]
  title: string
  description: string
  subAgents?: { id: string; name: string; prompt: string }[]
  environmentVariables?: ({ id: string; name: string; description?: string; required?: boolean } & (
    { type: 'string'; value?: string } | { type: 'number'; value?: number } | { type: 'secret'; value?: never }
  ))[]
}
