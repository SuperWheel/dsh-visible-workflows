/** Session-local UI hints and authoritative publication receipts, never an execution format. */
export interface PlanningCanvasContext {
  clientId:string
  sequence:number
  workflowId?:string
  revision?:number
  dirty:boolean
}
export interface PlanningPublicationUpdate {
  sequence:number
  taskId:string
  kind:'created'|'proposed'
  workflowId:string
  revision:number
  proposalId?:string
}
export interface PlanningPublicationUpdates {epoch:string;cursor:number;items:PlanningPublicationUpdate[];progress?:PlanningProgressUpdate[]}

export const PLANNING_PROGRESS_STATES=['returned','handed_off','collecting','queued','distilling','authoring','validating','repairing','optimizing','regressing','awaiting_input','ready','publishing','published','conflict','blocked','cancelling','cancelled','interrupted','failed','trial_preparing','trial_executing','trial_verifying','trial_review','trial_ready'] as const
export type PlanningProgressState=typeof PLANNING_PROGRESS_STATES[number]
/** Host task state only; completion never substitutes for a publication receipt. */
export interface PlanningProgressUpdate {
  sequence:number
  taskId:string
  taskRevision:number
  state:PlanningProgressState
  at:string
  message:string
  workflowId?:string
  cancellable:boolean
}
