import { z } from 'zod'
import { compilerJson } from './planning-repair.ts'

const key=z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/).refine(value=>!['input','env','sys','loop','__proto__','constructor','prototype'].includes(value))
const identity=z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const alias=z.string().min(3).max(1000).regex(/^[A-Za-z][A-Za-z0-9_-]*-[1-9]\d*(?:#[1-9]\d*)*$/)
/** True for a draft alias such as a-1 or a-1#2; anything else in a target is a Host key (n9) or a node ID. */
export const isChainAlias=(value:string)=>alias.safeParse(value).success
export const chainFormSchema=z.object({key,template:z.string().min(1).max(160),values:z.record(z.string(),z.unknown()).transform(value=>compilerJson(value)),title:z.string().trim().min(1).max(200).optional()}).strict()
export const chainSpliceSchema=z.discriminatedUnion('op',[
  z.object({op:z.literal('insert'),draftRevision:z.number().int().nonnegative(),target:alias,position:z.enum(['before','after']),nodes:z.array(chainFormSchema).min(1).max(200)}).strict(),
  z.object({op:z.literal('replace'),draftRevision:z.number().int().nonnegative(),target:alias,nodes:z.array(chainFormSchema).max(200)}).strict(),
  z.object({op:z.literal('delete'),draftRevision:z.number().int().nonnegative(),target:alias}).strict(),
  // Desktop r60 E: change fields of a node in place, keeping its ID, so a consumer can point at a node added in the same splice.
  // Desktop r65 E: a node outside the chain (past a branch) is named by its Host key or ID, so one splice still makes one proposal.
  z.object({op:z.literal('update'),draftRevision:z.number().int().nonnegative(),target:z.union([alias,identity]),values:z.record(z.string(),z.unknown()).refine(value=>Object.keys(value).length>0,'values 至少改一个字段').transform(value=>compilerJson(value))}).strict(),
])
export const chainBoundarySchema=z.object({entryEdgeId:identity.optional(),exitEdgeId:identity.optional()}).strict()
export const planningChainLocatorSchema=z.object({chainKey:key.default('a'),anchorNodeId:identity,scope:z.array(identity).max(5).optional(),nodeIds:z.array(identity).min(1).max(500).optional(),boundary:chainBoundarySchema.optional()}).strict()
/** Version 1 is a draft-alias protocol, never a Workflow numbering or identity schema. */
export const planningChainRequestSchema=planningChainLocatorSchema.extend({version:z.literal(1),baseDigest:z.string().regex(/^[a-f0-9]{64}$/),baseRevision:z.number().int().nonnegative(),operations:z.array(chainSpliceSchema).min(1).max(200),exports:z.array(z.object({from:z.object({nodeId:identity,field:identity}).strict(),to:z.object({key,field:identity}).strict()}).strict()).max(200).default([])}).strict()
export type ChainForm=z.infer<typeof chainFormSchema>
export type ChainSplice=z.infer<typeof chainSpliceSchema>
export type PlanningChainLocator=z.input<typeof planningChainLocatorSchema>
export type PlanningChainRequest=z.infer<typeof planningChainRequestSchema>
export const planningChainStateSchema=z.object({version:z.literal(1),baseDigest:z.string().regex(/^[a-f0-9]{64}$/),baseRevision:z.number().int().nonnegative(),draftRevision:z.number().int().nonnegative(),mapping:z.array(z.object({temporaryAlias:alias,standardAlias:alias,nodeId:identity,actualNumber:z.string().min(1).max(200)}).strict()).max(500),retiredAliases:z.array(alias).max(200),aliasWrites:z.number().int().nonnegative()}).strict()
export type PlanningChainState=z.infer<typeof planningChainStateSchema>
