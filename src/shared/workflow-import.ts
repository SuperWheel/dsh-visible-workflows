import type { ModelChoice, ModelRef, RolePreset, ToolChoice, Workflow, WorkflowThumbnail } from './types.ts'
import type { WorkflowDependency } from './workflow-format.ts'
import { z } from 'zod'

export interface WorkflowImportMapping { kind:WorkflowDependency['kind']; id:string; target:string|ModelRef }
export interface WorkflowImportOptions {
  mappings?:WorkflowImportMapping[]
  overwrite?:{workflowId:string;expectedRevision:number}
}
const optionSchema=z.object({
  mappings:z.array(z.object({kind:z.enum(['model','tool','workflow','file','role']),id:z.string().min(1).max(512),target:z.union([z.string().min(1).max(4000),z.object({provider:z.string().min(1).max(256),model:z.string().min(1).max(256)}).strict()])}).strict()).max(2000).optional(),
  overwrite:z.object({workflowId:z.string().min(1).max(160),expectedRevision:z.number().int().nonnegative()}).strict().optional(),
}).strict()
export function parseWorkflowImportOptions(value:unknown):WorkflowImportOptions{return optionSchema.parse(value??{})}
/** Host-provided current catalogs; client-supplied catalogs never authorize an import. */
export interface WorkflowImportCatalog { models:ModelChoice[]; tools:ToolChoice[]; workflows:Workflow[]; presets:RolePreset[] }
export interface WorkflowImportDependency extends WorkflowDependency {
  status:'ready'|'missing'|'deferred'
  target?:string|ModelRef
  message:string
  choices:{id:string;label:string;target:string|ModelRef}[]
}
export interface WorkflowImportPreview {
  title:string; nodeCount:number; edgeCount:number; environmentCount:number
  thumbnail?:WorkflowThumbnail
  canImport:boolean; dependencies:WorkflowImportDependency[]; warnings:string[]; errors:string[]
  overwrite?:{workflowId:string;title:string;expectedRevision:number}
}

/** Recomputed by the current Host; never persisted or trusted from an import. */
export interface WorkflowReadinessIssue {
  id:string
  nodeId?:string
  workflowId?:string
  field?:string
  kind:'configuration'|'model'|'tool'|'workflow'|'file'|'role'|'environment'|'secret'
  message:string
  action:'node'|'environment'|'dependency'
  dependencyId?:string
}
export interface WorkflowReadiness {
  workflowId:string
  revision:number
  canRun:boolean
  issues:WorkflowReadinessIssue[]
}
