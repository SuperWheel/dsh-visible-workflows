import { createHash } from 'node:crypto'
import { z } from 'zod'
import { continuationDigest, hostRepairCheckpointSchema, sealRepairCheckpoint, type HostRepairCheckpoint, type LoadedPlanningContracts, type PlanningContinuation, type PlanningReservations } from './planning-continuation.ts'
import { assertSupportedJsonSchema, type JsonSchemaNode, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { planningOneOf, submissionSchemaIssues } from './planning-submission-schema.ts'

export const jsonDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const unsafe = new Set(['__proto__', 'prototype', 'constructor'])
export class CompilerError extends Error {
  constructor(readonly code: string, message: string, readonly path?: string, readonly fatal = false) { super(message) }
}

/** Reject exotic values before cloning, traversing, assigning or persisting. */
export function compilerJson(value: unknown, maximum = 1_000_000): any {
  let entries = 0
  const visit = (item: unknown, depth: number): void => {
    if (++entries > 100_000 || depth > 32) throw new CompilerError('COMPILER_DEPTH_LIMIT', '编译输入过深或过大', undefined, true)
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object' || !(Array.isArray(item)?Object.getPrototypeOf(item)===Array.prototype:[Object.prototype,null].includes(Object.getPrototypeOf(item))))
      throw new CompilerError('COMPILER_INVALID_JSON', '只接受普通 JSON', undefined, true)
    for (const key of Object.keys(item)) {
      if (unsafe.has(key)) throw new CompilerError('COMPILER_UNSAFE_KEY', '禁止危险键', undefined, true)
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!
      if (!('value' in descriptor)) throw new CompilerError('COMPILER_INVALID_JSON', '禁止访问器', undefined, true)
      visit(descriptor.value, depth + 1)
    }
  }
  visit(value, 0)
  if (Buffer.byteLength(JSON.stringify(value)) > maximum) throw new CompilerError('COMPILER_SIZE_LIMIT', '编译输入超过大小限制', undefined, true)
  return structuredClone(value)
}
export const pointer = (parts: readonly (string | number)[]): string => parts.length ? '/' + parts.map(String).map(s => s.replaceAll('~', '~0').replaceAll('/', '~1')).join('/') : ''
export function pointerParts(path: string): string[] {
  if (!path.startsWith('/') || /~(?![01])/u.test(path)) throw new CompilerError('PATCH_PATH', '需要合法的非根 JSON Pointer', path)
  const parts = path.slice(1).split('/').map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'))
  if (parts.some(part => unsafe.has(part))) throw new CompilerError('COMPILER_UNSAFE_KEY', '补丁包含危险键', path, true)
  return parts
}
export function withinPath(path: string, root: string): boolean {
  const p = pointerParts(path), r = pointerParts(root)
  return p.length >= r.length && r.every((part, i) => p[i] === part)
}
const patchSchema = z.discriminatedUnion('op', [
  z.object({op:z.literal('add'),path:z.string().min(1).max(2000),value:z.unknown()}).strict(),
  z.object({op:z.literal('replace'),path:z.string().min(1).max(2000),value:z.unknown()}).strict(),
  z.object({op:z.literal('remove'),path:z.string().min(1).max(2000)}).strict(),
  z.object({op:z.literal('replace-text'),path:z.string().min(1).max(2000),find:z.string().min(1).max(100_000),replace:z.string().max(100_000)}).strict(),
])
export const repairValueSchema = z.object({mode:z.literal('repair'),draftRevision:z.number().int().positive(),patches:z.array(patchSchema).min(1).max(64),summary:z.string().max(10000).optional()}).strict()
export type RepairPatch = z.infer<typeof patchSchema>
export interface CompilerIssue {
  code:string; message:string; path?:string; nodeId?:string; allowedPaths:string[]
  /** Exact local contract, never an assertion that a schema error proves business intent. */
  expected?:JsonSchemaNode; actualType?:string; candidates?:unknown[]
  contracts?:Record<string,JsonSchemaNode>
}
export interface RepairFeedback {
  status:'repairable'; draftRevision:number; issues:CompilerIssue[]
  fragments:Record<string,unknown>; allowedPaths:string[]; remainingSubmissions:number
}
export type SubmissionResult<T> = {ok:true;value:T;repairedWire?:unknown} | {ok:false;feedback:RepairFeedback}
export interface UniqueRepair { patches:RepairPatch[]; reason:string }
export interface SubmissionCompiler<T = unknown> {
  readonly schema:ObjectJsonSchema
  /** Model-facing schema may narrow after a failure; the native terminal schema stays fixed. */
  readonly nextSchema?:ObjectJsonSchema
  readonly instructions:string
  submit(input:unknown):SubmissionResult<T>
  /** Charge a pre-compile wire rejection to the same submission budget without changing the draft. */
  rejectWire(input:unknown,issues:CompilerIssue[]):SubmissionResult<T>
  repairUnique?(schemas?:readonly ObjectJsonSchema[]):SubmissionResult<T>|undefined
  /** Fill values the Host already fixed (the requested CREATE title) when the submission omits them. */
  fillKnown?(input:unknown):unknown
  checkpoint?():HostRepairCheckpoint|undefined
  continuation?():PlanningContinuation|undefined
}
const string:JsonSchemaNode={type:'string'}
export const repairWireSchema:JsonSchemaNode={type:'object',properties:{
  mode:{type:'string',const:'repair'},draftRevision:{type:'integer'},summary:string,patches:{type:'array',items:{oneOf:[
    {type:'object',properties:{op:{type:'string',const:'add'},path:string,value:{}},required:['op','path','value'],additionalProperties:false},
    {type:'object',properties:{op:{type:'string',const:'replace'},path:string,value:{}},required:['op','path','value'],additionalProperties:false},
    {type:'object',properties:{op:{type:'string',const:'remove'},path:string},required:['op','path'],additionalProperties:false},
    {type:'object',properties:{op:{type:'string',const:'replace-text'},path:string,find:string,replace:string},required:['op','path','find','replace'],additionalProperties:false},
  ]}},
},required:['mode','draftRevision','patches'],additionalProperties:false}
export const submissionSchema = (...initial:JsonSchemaNode[]):ObjectJsonSchema => ({
  type:'object',properties:{submission:planningOneOf([...initial,repairWireSchema])},required:['submission'],additionalProperties:false,
})
export const questionWireSchema:JsonSchemaNode={type:'object',properties:{
  id:string,question:string,options:{type:'array',items:string},
},required:['id','question'],additionalProperties:false}
export const needsInputWireSchema:JsonSchemaNode={type:'object',properties:{
  mode:{type:'string',const:'needs-input'},questions:{type:'array',items:questionWireSchema},summary:string,
},required:['mode','questions'],additionalProperties:false}
export const needsInputSchema=z.object({mode:z.literal('needs-input'),questions:z.array(z.object({
  id:z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/),question:z.string().min(1).max(4000),options:z.array(z.string().min(1).max(1000)).max(8).default([]),
}).strict()).min(1).max(3),summary:z.string().max(10000).default('需要补充信息')}).strict()

export function applyRepair(document: unknown, patches: RepairPatch[], allowedPaths: readonly string[]): unknown {
  const copy = compilerJson(document)
  for (const patch of patches) {
    if (!allowedPaths.some(root => withinPath(patch.path, root))) throw new CompilerError('PATCH_SCOPE', '补丁不在本轮错误及依赖修复范围', patch.path)
    const parts = pointerParts(patch.path), name = parts.pop()!
    let parent = copy
    for (const key of parts) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new CompilerError('PATCH_PATH', '补丁父路径不存在', patch.path)
      parent = parent[key]
    }
    if (!parent || typeof parent !== 'object') throw new CompilerError('PATCH_PATH', '补丁父路径不是对象', patch.path)
    const array = Array.isArray(parent)
    if (array && !/^(0|[1-9]\d*|-)$/.test(name)) throw new CompilerError('PATCH_PATH', '数组下标无效', patch.path)
    const index = name === '-' ? parent.length : Number(name)
    if (array && (name === '-' && patch.op !== 'add' || index > parent.length || index === parent.length && patch.op !== 'add'))
      throw new CompilerError('PATCH_PATH', '数组下标越界', patch.path)
    if (patch.op !== 'add' && !Object.hasOwn(parent,name)) throw new CompilerError('PATCH_PATH', '补丁目标不存在', patch.path)
    if (patch.op === 'replace-text') {
      const text = parent[name]
      if (typeof text !== 'string' || text.split(patch.find).length !== 2) throw new CompilerError('PATCH_TEXT_MATCH', 'find 必须恰好匹配一次', patch.path)
      parent[name] = text.replace(patch.find, () => patch.replace)
    } else if (patch.op === 'remove') {
      if (array) parent.splice(index,1); else delete parent[name]
    } else if (array && patch.op === 'add') parent.splice(index,0,compilerJson(patch.value))
    else parent[name]=compilerJson(patch.value)
  }
  return compilerJson(copy)
}
export function issueFromError(error:unknown, roots:readonly string[]):CompilerIssue[] {
  if (error instanceof CompilerError && error.fatal) throw error
  if (error instanceof z.ZodError) return error.issues.slice(0,40).map(issue=>{
    const path=pointer(issue.path.map(String))
    // Unknown keys need removal at the containing object; ordinary failures use exact leaves.
    const paths=issue.code==='unrecognized_keys'?(path?[path]:issue.keys.map(key=>pointer([key]))):path?[path]:[...roots]
    const expected=issue.code==='invalid_type'&&['string','number','boolean','integer','null'].includes(issue.expected)?{type:issue.expected} as JsonSchemaNode:
      issue.code==='invalid_value'?{enum:issue.values} as JsonSchemaNode:undefined
    return {code:'INVALID_FIELDS',message:issue.message,path,...(expected?{expected}:{}),allowedPaths:paths.filter(p=>p&&roots.some(r=>withinPath(p,r)))}
  })
  const path=error instanceof CompilerError?error.path:undefined
  return [{code:error instanceof CompilerError?error.code:'INVALID_CANDIDATE',message:error instanceof Error?error.message:String(error),...(path?{path}:{}),allowedPaths:path&&roots.some(r=>withinPath(path,r))?[path]:[...roots]}]
}

export const jsonValueType=(value:unknown):string=>value===null?'null':Array.isArray(value)?'array':typeof value
const valueAt=(document:any,path:string):unknown=>pointerParts(path).reduce((item:any,key)=>item&&typeof item==='object'&&Object.hasOwn(item,key)?item[key]:undefined,document)
/** Observed shape is guidance, never a type contract. It may be incomplete or
 * wrong (including array element types); only compiler diagnostics justify an
 * enforced value schema. Object hints stay open and have no required keys. */
function fragmentSchema(value:unknown,depth=0):JsonSchemaNode {
  if(depth>=8)return {}
  if(Array.isArray(value))return {type:'array'}
  if(value&&typeof value==='object')return {type:'object',properties:Object.fromEntries(Object.entries(value).map(([key,item])=>[key,fragmentSchema(item,depth+1)])),additionalProperties:true}
  const type=jsonValueType(value)
  return ['string','number','boolean','null'].includes(type)?{type} as JsonSchemaNode:{}
}
/** Convert diagnostic JSON Schema to the actual installed DSH tool subset. */
function supportedContract(input:any):JsonSchemaNode|undefined{
  if(!input||typeof input!=='object')return undefined
  // Preserve exact supported contracts. Conversion of unsupported unions can
  // introduce overlap into exact-oneOf; use a documented upper bound instead.
  try{assertSupportedJsonSchema(input);return structuredClone(input)}catch{/* Widen unsupported keywords below. */}
  const union=input.oneOf??input.anyOf
  if(Array.isArray(union)){
    const branches:JsonSchemaNode[]=union.map(supportedContract).filter((branch:JsonSchemaNode|undefined):branch is JsonSchemaNode=>!!branch)
    const types=branches.map(branch=>branch.type)
    const disjoint=branches.length===union.length&&branches.length>0&&types.every(Boolean)&&new Set(types).size===types.length&&!(types.includes('number')&&types.includes('integer'))
    return disjoint?planningOneOf(branches):{description:'编译器联合合同（工具子集无法无损表达，按编译器校验）：'+JSON.stringify(input)}
  }
  if(Array.isArray(input.enum)&&input.enum.length&&new Set(input.enum.map(jsonValueType)).size>1){
    const types=[...new Set<string>(input.enum.map(jsonValueType))]
    return planningOneOf(types.map(type=>({type,enum:input.enum.filter((value:unknown)=>jsonValueType(value)===type)} as JsonSchemaNode)))
  }
  const type=input.type??(input.enum?.length?jsonValueType(input.enum[0]):Object.hasOwn(input,'const')?jsonValueType(input.const):undefined)
  if(!['object','array','string','number','integer','boolean','null'].includes(type))return {}
  if(type==='object'){
    const properties=Object.fromEntries(Object.entries(input.properties??{}).flatMap(([key,value])=>{const schema=supportedContract(value);return schema?[[key,schema]]:[]}))
    return {type:'object',properties,required:(input.required??[]).filter((key:string)=>Object.hasOwn(properties,key)),additionalProperties:input.additionalProperties!==false}
  }
  if(type==='array'){
    const items=supportedContract(input.items)
    return {type:'array',...(items?{items}:{})}
  }
  return {type,...(Array.isArray(input.enum)&&input.enum.length?{enum:input.enum}:{}),...(Object.hasOwn(input,'const')?{const:input.const}:{})} as JsonSchemaNode
}
const exactPatch=(op:string,path:string,properties:Record<string,JsonSchemaNode>,required:string[]):JsonSchemaNode=>({type:'object',
  properties:{op:{type:'string',const:op},path:{type:'string',const:path},...properties},required:['op','path',...required],additionalProperties:false})
function repairSchemaFor(document:unknown,issues:CompilerIssue[],allowed:readonly string[],revision:number):JsonSchemaNode {
  const alternatives:JsonSchemaNode[]=[]
  const paths=[...new Set([...allowed,...issues.flatMap(issue=>issue.path&&allowed.some(root=>withinPath(issue.path!,root))?[issue.path]:[])])]
  for(const path of paths){
    const current=valueAt(document,path),issue=issues.find(issue=>issue.path===path)
    const contract=issue?.candidates?.length?{enum:issue.candidates}:issue?.expected??issues.map(issue=>issue.contracts?.[path]).find(Boolean)
    const expected=supportedContract(contract)??{description:'当前草稿形状（仅作提示，不限制修复值）：'+JSON.stringify(fragmentSchema(current))}
    alternatives.push(exactPatch('add',path,{value:expected},['value']))
    alternatives.push(exactPatch('replace',path,{value:expected},['value']))
    alternatives.push(exactPatch('remove',path,{},[]))
    alternatives.push(exactPatch('replace-text',path,{find:{type:'string'},replace:{type:'string'}},['find','replace']))
  }
  if(paths.length){
    // The SDK subset has no prefix/pattern paths. XOR excludes the exact paths
    // above from the generic branch, so valid descendants (including new keys)
    // reach applyRepair's authoritative pointer/scope checks without overlapping
    // exact-oneOf matches. This is deliberately a superset, never a new grant.
    const otherPath:JsonSchemaNode={oneOf:[{type:'string'},{type:'string',enum:paths}],description:'仅允许反馈 allowedPaths 及其子路径：'+JSON.stringify(allowed)}
    const generic=structuredClone(repairWireSchema).properties!.patches!.items!.oneOf!
    for(const branch of generic){branch.properties!.path=otherPath;alternatives.push(branch)}
  }
  const items=alternatives.length?planningOneOf(alternatives):undefined
  // No allowed repair slot: retain an uninhabited patch item contract.
  return {type:'object',
    properties:{mode:{type:'string',const:'repair'},draftRevision:{type:'integer',const:revision},summary:{type:'string'},patches:{type:'array',items:items??{type:'null'}}},
    required:['mode','draftRevision','patches'],additionalProperties:false}
}
const allowedRepairPaths=(issues:readonly CompilerIssue[],roots:readonly string[]):string[]=>
  [...new Set(issues.flatMap(issue=>issue.allowedPaths).filter(path=>path&&roots.some(root=>withinPath(path,root))))]
const withActualTypes=(document:unknown,issues:CompilerIssue[]):CompilerIssue[]=>
  issues.map(issue=>({...issue,...(issue.path?{actualType:jsonValueType(valueAt(document,issue.path))}:{})}))

/** Pure transactional repair state. No model, IO, publishing or workflow execution. */
export class RepairSession<T> implements SubmissionCompiler<T> {
  private uniqueRepairSummary?:string
  private wireRejected?:unknown
  private document:unknown
  private revision=0
  private allowed:string[]=[]
  private priorFailure=''
  private attempts=0
  private accepted=false
  private lastIssues:CompilerIssue[]=[]
  private pausedDraft?:{document:unknown;revision:number;issues:CompilerIssue[];allowed:string[];priorFailure:string}
  private resumedClarification=false
  readonly instructions='通过 structured_output 的 submission 提交。可修复错误会返回 draftRevision、具体路径和片段；'+
    '已有草稿时只提交 mode=repair 与 patches，draftRevision=0 表示尚无草稿，须更正后重新提交初始参数（新建图用 create，修改图用 edit）。'+
    '一次修完本批错误，保留无关字段。成功即终止，不再确认。'
  constructor(readonly schema:ObjectJsonSchema,private readonly options:{
    maxSubmissions:number
    /** Host storage only; never exposed in a model-facing submission schema. */
    resume?:HostRepairCheckpoint
    resumeScope?:string
    contractDigest?:string
    loadedContracts?():LoadedPlanningContracts
    /** Host identity reservations held by the compiler; restored before recompiling a draft. */
    reservations?():PlanningReservations
    restoreReservations?(value:PlanningReservations|undefined):void
    wire?(document:any):unknown
    normalize?(input:any):unknown
    compile(document:any):T
    roots(document:any):string[]
    diagnose?(error:unknown,document:any):CompilerIssue[]
    /** Trusted Host rules only. A unique type-compatible value alone is insufficient. */
    uniqueRepair?(document:any,issues:CompilerIssue[]):UniqueRepair|undefined
    onSubmission?(snapshot:{attempt:number;revision:number;document:unknown;issues:CompilerIssue[];patch:boolean;elapsedMs:number;repairSummary?:string;checkpoint?:HostRepairCheckpoint}):void
  }){
    if(options.resume){
      if(!options.resumeScope||!options.contractDigest)throw new CompilerError('COMPILER_RESUME_BINDING','恢复需要当前任务范围与合同摘要',undefined,true)
      this.restore(options.resume)
    }
  }
  get nextSchema():ObjectJsonSchema{
    if(this.document===undefined||this.accepted)return this.schema
    const branches=(this.schema.properties?.submission as any)?.oneOf??[]
    const clarification=branches.filter((branch:any)=>branch.properties?.mode?.const==='needs-input')
    return {type:'object',properties:{submission:planningOneOf([...clarification,repairSchemaFor(this.document,this.lastIssues,this.allowed,this.revision)])},required:['submission'],additionalProperties:false}
  }
  /** Uses exactly the normal repair transaction, including scope, revision and submission limits. */
  repairUnique(schemas?:readonly ObjectJsonSchema[]):SubmissionResult<T>|undefined{
    if(this.accepted)return undefined
    const rejected=this.wireRejected
    this.wireRejected=undefined
    const draft=rejected===undefined?{document:this.document,issues:this.lastIssues,allowed:this.allowed}:this.rejectedDraft(rejected,schemas)
    if(!draft)return
    const {document,issues,allowed}=draft
    if(document===undefined||!issues.length)return
    const repair=this.options.uniqueRepair?.(structuredClone(document),structuredClone(issues))
    if(!repair?.patches.length)return
    let repairedWire:unknown
    if(rejected!==undefined){
      const preflight=this.preflightRejected(document,repair,allowed,schemas!)
      if(!preflight)return
      repairedWire=preflight.repairedWire
      this.document=document;this.revision++;this.lastIssues=issues;this.allowed=allowed
    }
    this.uniqueRepairSummary=repair.reason
    try{
      const result=this.submit({submission:{mode:'repair',draftRevision:this.revision,patches:repair.patches,summary:repair.reason}})
      return result.ok&&repairedWire!==undefined?{...result,repairedWire}:result
    }finally{this.uniqueRepairSummary=undefined}
  }
  /** Diagnoses a wire-rejected first submission as a draft; undefined means no Host repair applies. */
  private rejectedDraft(rejected:unknown,schemas?:readonly ObjectJsonSchema[]):{document:unknown;issues:CompilerIssue[];allowed:string[]}|undefined{
    // 线上拒绝只暂存原始值；无已存在草稿时，才尝试同一 Host 判定。
    if(this.document!==undefined||!schemas?.length||!this.options.wire||this.attempts>=this.options.maxSubmissions)return
    const outer=compilerJson(rejected)
    if(!outer||Object.keys(outer).length!==1||!outer.submission||outer.submission.mode!==undefined&&!['create','edit'].includes(outer.submission.mode))return
    const reservations=this.options.reservations?.()
    try{
      const document=this.options.normalize?this.options.normalize(outer.submission):outer.submission
      let issues:CompilerIssue[]
      try{this.options.compile(document);return}catch(error){
        if(error instanceof CompilerError&&error.fatal)return
        issues=this.options.diagnose?.(error,document)??issueFromError(error,this.options.roots(document))
      }
      const roots=this.options.roots(document)
      return {document,issues,allowed:allowedRepairPaths(issues,roots)}
    }finally{this.options.restoreReservations?.(reservations)}
  }
  /** Proves a wire-rejected repair compiles before it opens a transaction; undefined means abandon it. */
  private preflightRejected(document:unknown,repair:UniqueRepair,allowed:readonly string[],schemas:readonly ObjectJsonSchema[]):{repairedWire:unknown}|undefined{
    const reservations=this.options.reservations?.()
    try{
      const patched=applyRepair(document,repair.patches,allowed)
      const repairedWire=this.options.wire!(patched)
      if(schemas.some(schema=>submissionSchemaIssues(schema,repairedWire).length))return
      // 线上拒绝先证明全部编译检查通过；失败不改草稿、不增加 Host 修复次数。
      this.options.compile(patched)
      return {repairedWire}
    }catch(error){if(error instanceof CompilerError&&error.fatal)throw error;return}
    finally{this.options.restoreReservations?.(reservations)}
  }

  snapshot(){return {revision:this.revision,document:structuredClone(this.document),issues:structuredClone(this.lastIssues),submissions:this.attempts}}
  checkpoint():HostRepairCheckpoint|undefined{
    if(!this.options.resumeScope||!this.options.contractDigest)return undefined
    const current=this.pausedDraft??{document:this.document,revision:this.revision,issues:this.lastIssues,allowed:this.allowed,priorFailure:this.priorFailure}
    const loaded=this.options.loadedContracts?.(),reservations=this.options.reservations?.()
    return sealRepairCheckpoint({protocolVersion:1,scope:this.options.resumeScope,schemaDigest:continuationDigest(this.schema),contractDigest:this.options.contractDigest,
      state:this.pausedDraft||this.resumedClarification?'clarification':this.accepted?'accepted':current.document===undefined?(this.attempts?'clarification':'empty'):'draft',
      // Draftless failures belong to submission feedback, not draft repair authority.
      revision:current.revision,submissions:this.attempts,maxSubmissions:this.options.maxSubmissions,
      ...(current.document===undefined?{}:{document:compilerJson(current.document)}),issues:current.document===undefined?[]:structuredClone(current.issues),
      priorFailure:current.priorFailure,...(loaded?{loadedContracts:loaded}:{}),...(reservations?{reservations}:{})})
  }
  private restore(raw:HostRepairCheckpoint):void{
    let checkpoint:HostRepairCheckpoint
    try{checkpoint=hostRepairCheckpointSchema.parse(compilerJson(raw))}catch(error){throw new CompilerError('COMPILER_RESUME_INVALID','Host 恢复检查点损坏或无效：'+(error instanceof Error?error.message:String(error)),undefined,true)}
    if(checkpoint.scope!==this.options.resumeScope||checkpoint.contractDigest!==this.options.contractDigest||checkpoint.schemaDigest!==continuationDigest(this.schema)||checkpoint.maxSubmissions!==this.options.maxSubmissions)
      throw new CompilerError('COMPILER_RESUME_CONFLICT','任务范围、Schema、合同或总提交次数上限已变化，不能复用草稿',undefined,true)
    const loaded=this.options.loadedContracts?.()
    if(continuationDigest(loaded??null)!==continuationDigest(checkpoint.loadedContracts??null))throw new CompilerError('COMPILER_RESUME_CONFLICT','已加载合同与检查点不一致',undefined,true)
    if(checkpoint.state==='accepted')throw new CompilerError('COMPILER_RESUME_ACCEPTED','已经接受的候选不能作为新的模型修复草稿导入',undefined,true)
    this.attempts=checkpoint.submissions;this.revision=checkpoint.revision;this.priorFailure=checkpoint.priorFailure;this.resumedClarification=checkpoint.state==='clarification'
    this.options.restoreReservations?.(checkpoint.reservations)
    if(checkpoint.document===undefined)return
    const document=this.options.normalize?this.options.normalize(compilerJson(checkpoint.document)):compilerJson(checkpoint.document)
    if(continuationDigest(document)!==continuationDigest(checkpoint.document))throw new CompilerError('COMPILER_RESUME_CONFLICT','草稿规范化合同已变化',undefined,true)
    // Saved issues are evidence, never permission. Re-run current Host compile
    // and authority checks, without a new submission, observer call or model.
    let failure:unknown
    try{this.options.compile(document)}catch(error){failure=error}
    if(failure===undefined)throw new CompilerError('COMPILER_RESUME_VALID_DRAFT','检查点声称失败的草稿当前已通过校验，禁止重新开放模型修改',undefined,true)
    if(failure instanceof CompilerError&&failure.fatal)throw failure
    const roots=this.options.roots(document),issues=this.options.diagnose?this.options.diagnose(failure,document):issueFromError(failure,roots)
    this.document=document
    this.lastIssues=withActualTypes(document,issues)
    this.allowed=allowedRepairPaths(issues,roots)
  }
  continuation():PlanningContinuation|undefined{
    const checkpoint=this.checkpoint()
    if(!checkpoint||checkpoint.state==='accepted'||checkpoint.state==='empty')return undefined
    const current=this.pausedDraft??{document:this.document,revision:this.revision,issues:this.lastIssues,allowed:this.allowed}
    return {protocolVersion:1,kind:current.document===undefined?'initial-clarification':'draft-repair',hasDraft:current.document!==undefined,scope:checkpoint.scope,
      draftRevision:checkpoint.revision,submissions:checkpoint.submissions,remainingSubmissions:checkpoint.maxSubmissions-checkpoint.submissions,
      contracts:{schemaDigest:checkpoint.schemaDigest,contractDigest:checkpoint.contractDigest,...(checkpoint.loadedContracts?{loaded:checkpoint.loadedContracts}:{})},unresolved:[...current.allowed],
      ...(current.document===undefined?{}:{feedback:this.feedback(current.document,current.revision,current.issues,current.allowed)})}
  }
  private feedback(document:unknown,revision:number,issues:CompilerIssue[],allowed:readonly string[]):RepairFeedback{
    const fragments:Record<string,unknown>={}
    for(const path of allowed.slice(0,30)){const item=valueAt(document,path);if(item!==undefined)fragments[path]=structuredClone(item)}
    let packet:RepairFeedback={status:'repairable',draftRevision:revision,issues:structuredClone(issues),fragments,allowedPaths:[...allowed],remainingSubmissions:this.options.maxSubmissions-this.attempts}
    if(Buffer.byteLength(JSON.stringify(packet))>64_000)packet={...packet,fragments:{},issues:issues.map(issue=>({...issue,message:issue.message.slice(0,600)}))}
    return packet
  }
  private report(snapshot:Parameters<NonNullable<ConstructorParameters<typeof RepairSession<T>>[1]['onSubmission']>>[0]):void{
    try{const checkpoint=this.checkpoint();this.options.onSubmission?.(structuredClone({...snapshot,...(checkpoint?{checkpoint}:{})}))}
    catch(error){throw new CompilerError('COMPILER_OBSERVER_FAILED',error instanceof Error?error.message:String(error),undefined,true)}
  }
  rejectWire(value:unknown,issues:CompilerIssue[]):SubmissionResult<T>{
    if(this.accepted)throw new CompilerError('COMPILER_ALREADY_ACCEPTED','编译器已经接受结果',undefined,true)
    if(this.attempts>=this.options.maxSubmissions)throw new CompilerError('PLANNING_REPAIR_LIMIT','达到本阶段提交与修复上限',undefined,true)
    const started=performance.now(),outer=compilerJson(value)
    this.attempts++
    // 拒绝本身不更改草稿；可选唯一修复预检成功后才开启原事务。
    this.wireRejected=outer
    this.report({attempt:this.attempts,revision:this.revision,document:this.document===undefined?outer?.submission??outer:this.document,issues,patch:outer?.submission?.mode==='repair',elapsedMs:performance.now()-started})
    return {ok:false,feedback:{status:'repairable',draftRevision:this.revision,issues:structuredClone(issues),fragments:{},allowedPaths:[],remainingSubmissions:this.options.maxSubmissions-this.attempts}}
  }
  submit(value:unknown):SubmissionResult<T>{
    if(this.accepted)throw new CompilerError('COMPILER_ALREADY_ACCEPTED','编译器已经接受结果',undefined,true)
    if(this.attempts>=this.options.maxSubmissions)throw new CompilerError('PLANNING_REPAIR_LIMIT','达到本阶段提交与修复上限',undefined,true)
    this.wireRejected=undefined
    const started=performance.now()
    this.attempts++
    const outer=compilerJson(value)
    if(!outer||typeof outer!=='object'||Array.isArray(outer)||Object.keys(outer).length!==1||!Object.hasOwn(outer,'submission'))
      throw new CompilerError('COMPILER_ENVELOPE','工具参数必须只有 submission',undefined,true)
    const input=outer.submission,isPatch=input?.mode==='repair'
    const previousAllowed=[...this.allowed],previousRevision=this.revision
    const previousDraft={document:structuredClone(this.document),revision:this.revision,issues:structuredClone(this.lastIssues),allowed:[...this.allowed],priorFailure:this.priorFailure}
    this.resumedClarification=false
    try{
      this.applyDraft(input,isPatch)
      this.revision++
      const output=this.options.compile(this.document)
      this.pausedDraft=input?.mode==='needs-input'?previousDraft:undefined
      this.accepted=true;this.lastIssues=[]
      const summary=this.uniqueRepairSummary?{repairSummary:this.uniqueRepairSummary}:{}
      this.report({attempt:this.attempts,revision:this.revision,document:this.document,issues:[],patch:isPatch,...summary,elapsedMs:performance.now()-started})
      return {ok:true,value:output}
    }catch(error){
      return this.rejectSubmission(error,input,isPatch,previousAllowed,previousRevision,started)
    }
  }
  /** Replaces the draft with a patched or initial document; throws before any change on an invalid transition. */
  private applyDraft(input:any,isPatch:boolean):void{
    if(isPatch){
      if(this.document===undefined)
        throw new CompilerError('PATCH_NO_DRAFT','尚无可修复草稿（draftRevision=0）；请按当前工具 Schema 更正并重新提交初始参数（新建图用 create，修改图用 edit），不要使用 repair')
      const repair=repairValueSchema.parse(input)
      if(repair.draftRevision!==this.revision)throw new CompilerError('PATCH_REVISION','草稿版本已变化，请使用最新反馈')
      const patched=applyRepair(this.document,repair.patches,this.allowed)
      if(jsonDigest(patched)===jsonDigest(this.document))throw new CompilerError('PATCH_NO_CHANGE','补丁没有修改任何内容')
      this.document=this.options.normalize?this.options.normalize(patched):patched
    }else{
      if(this.document!==undefined&&input?.mode!=='needs-input')throw new CompilerError('PATCH_REQUIRED','已有失败草稿，只允许提交局部修复或必要澄清')
      this.document=this.options.normalize?this.options.normalize(input):compilerJson(input)
    }
  }
  private rejectSubmission(error:unknown,input:any,isPatch:boolean,previousAllowed:string[],previousRevision:number,started:number):SubmissionResult<T>{
    if(error instanceof CompilerError && error.fatal)throw error
    const roots=this.document===undefined?[]:this.options.roots(this.document)
    let issues=this.document!==undefined&&this.options.diagnose?this.options.diagnose(error,this.document):issueFromError(error,roots)
    this.allowed=allowedRepairPaths(issues,roots)
    // A malformed patch leaves the previous document and its repair region available.
    const malformedPatch=isPatch&&(error instanceof z.ZodError&&this.revision===previousRevision||error instanceof CompilerError&&error.code.startsWith('PATCH_'))
    if(malformedPatch||error instanceof CompilerError&&error.code==='PATCH_REQUIRED')this.allowed=previousAllowed
    const failure=continuationDigest([this.document,issues.map(issue=>[issue.code,issue.path,issue.message])])
    if(failure===this.priorFailure)throw new CompilerError('PLANNING_REPAIR_STALLED','同一草稿和错误重复，停止重试',undefined,true)
    issues=withActualTypes(this.document,issues)
    this.priorFailure=failure;this.lastIssues=issues
    // Preserve rejected arguments as observer evidence; checkpoint owns draft presence.
    const document=this.document===undefined?input:this.document
    this.report({attempt:this.attempts,revision:this.revision,document,issues,patch:isPatch,elapsedMs:performance.now()-started})
    return {ok:false,feedback:this.feedback(this.document,this.revision,issues,this.allowed)}
  }
}


const wireLists=[['nodesByKey','nodes'],['formsByKey','forms'],['addNodesByKey','addNodes'],['addFormsByKey','addForms'],['chainsByKey','chains'],['linksByKey','links'],
  ['addLinksByKey','addLinks'],['rolesByKey','roles'],['addRolesByKey','addRoles'],['environmentByKey','environment'],['addEnvironmentByKey','addEnvironment']]
/** 将 Host 修复视图还原为对外声明；不添加缺失的必填字段。 */
export function authoringDocumentWire(document:unknown):unknown{
  const doc=compilerJson(document)
  for(const [from,to] of wireLists){
    if(Object.hasOwn(doc,from!)){doc[to!]=Object.entries(doc[from!]).map(([key,value])=>({key,...value as object}));delete doc[from!]}
  }
  for(const root of ['modules','addModules'])if(doc?.[root]&&!Array.isArray(doc[root]))doc[root]=Object.entries(doc[root]).map(([key,value])=>({key,...value as object}))
  return {submission:doc}
}
