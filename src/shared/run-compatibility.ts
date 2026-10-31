import type { RunUsage, WorkflowRun } from './types.ts'

/** Disk aliases only. Application code uses WorkflowRun's current names. */
interface LegacyRunFields { budget?: RunUsage; budgetRootRunId?: string }

/** Normalize in memory, never write during a read. Explicit current fields win. */
export function normalizeRun(value: WorkflowRun & LegacyRunFields): WorkflowRun {
  const { budget, budgetRootRunId, ...run } = value
  if (run.usage === undefined && budget !== undefined) run.usage = budget
  if (run.rootRunId === undefined && budgetRootRunId !== undefined) run.rootRunId = budgetRootRunId
  return run
}

export function runStorageAliases(run: WorkflowRun): LegacyRunFields {
  // Transition period only: an older build reads these names for usage and
  // child cancellation/pause/concurrency/recovery. Keep aliases on save so a
  // rollback can read the run; never use them as application state or limits.
  return {
    ...(run.usage !== undefined ? { budget: run.usage } : {}),
    ...(run.rootRunId !== undefined ? { budgetRootRunId: run.rootRunId } : {}),
  }
}
