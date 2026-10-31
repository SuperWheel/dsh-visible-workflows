import type { JsonValue } from './types.ts'
export interface RecoveryDecision {
  executionId:string
  action:'completed'|'redo'|'abandon'
  /** Optional operator note kept with the recovery record. */
  evidence?:string
  output?:Record<string,JsonValue>
}
export interface RecoveryReview { baseDigest:string; decisions:RecoveryDecision[] }
