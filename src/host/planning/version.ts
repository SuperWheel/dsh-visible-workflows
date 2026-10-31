/** Engine releases are independent of Workflow formatVersion and Graphon protocol. */
export const PLANNING_ENGINE_VERSION = '0.0.2' as const
export type PlanningEngineVersion = '0.0.1' | typeof PLANNING_ENGINE_VERSION
