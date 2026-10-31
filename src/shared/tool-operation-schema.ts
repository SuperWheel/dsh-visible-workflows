import { z } from 'zod'

const label=z.string().min(1).max(2000), digest=z.string().regex(/^[a-f0-9]{64}$/)
const action=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('other')}).strict(),
  z.object({kind:z.literal('file-read'),pathInput:label,missing:z.literal('error')}).strict(),
  z.object({kind:z.literal('file-list'),readsContent:z.literal(false),rootField:label,pathsField:label,
    // Optional registration guarantee: a literal path query is exhaustive for
    // that target under root=.; field names alone establish no coverage.
    coverage:z.object({kind:z.literal('exact-path'),pathInput:label,root:z.literal('.')}).strict().optional()}).strict(),
  z.object({kind:z.literal('file-write'),pathInput:label,readToolIds:z.array(label).min(1),listToolIds:z.array(label),
    existing:z.literal('current-owner-version'),absent:z.literal('create-if-absent')}).strict(),
])
/** A declaration is supplied by a registered implementation, never by a planner or a call sample. */
export const toolOperationDeclarationSchema=z.object({
  sourceId:label,version:label,registrationDigest:digest,
  implementationSources:z.array(z.object({id:label,version:label,digest}).strict()).min(1).max(20),
  preconditions:z.array(label).min(1).max(40),scope:z.object({owner:z.enum(['agent-session','call','none']),target:z.enum(['canonical-filesystem-path','none'])}).strict(),stateEffects:z.array(label).min(1).max(40),reuseLimits:z.array(label).min(1).max(40),action,
}).strict()
export type ToolOperationDeclaration=z.infer<typeof toolOperationDeclarationSchema>
export const toolOperationContractSchema=z.discriminatedUnion('status',[
  z.object({status:z.literal('unknown'),reason:label}).strict(),
  z.object({status:z.literal('known'),source:z.enum(['host-tool-registration','plugin-builtin']),declaration:toolOperationDeclarationSchema,digest}).strict(),
])
export type ToolOperationContract=z.infer<typeof toolOperationContractSchema>
