import type { WorkflowExecutionPolicy } from './types.ts'

/** Effective runtime safeguards only. Deprecated token/task quotas remain
 * readable in historical graphs but have no execution or recovery semantics. */
export function activeExecutionPolicy(policy:WorkflowExecutionPolicy|undefined) {
  return {
    maxConcurrentAgents:policy?.maxConcurrentAgents??3,
    repairMode:policy?.repairMode??'auto',
    maxRepairAttempts:policy?.maxRepairAttempts??2,
  }
}
