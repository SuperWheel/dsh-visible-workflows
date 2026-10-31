import { z } from 'zod'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolChoice } from './types.ts'
import { NODE_SEMANTICS } from './workflow-semantics.ts'
import { parseConversationEvidence, type ConversationEvidence } from './retrospective.ts'
import { compilerJson, CompilerError, jsonDigest } from './planning-repair.ts'

const digestSchema=z.string().regex(/^[a-f0-9]{64}$/),label=z.string().min(1).max(512)
/** Host-owned declarations from the same scoped SDK registry used by executeNative. */
export interface TrustedToolOutputSchema {toolId:string;sourceId:string;version:string;valuePath:'value';schema:Record<string,unknown>}
const declarationSchema=z.object({toolId:label,sourceId:label,version:z.string().min(1).max(160),valuePath:z.literal('value'),schema:z.record(z.string(),z.unknown())}).strict()
const guaranteeSchema=z.object({
  adapterVersion:z.enum(['native-output-v1','workflow-output-v1','builtin-output-v1','unknown-output-v1']),fields:z.record(z.string(),z.string()),
  schema:declarationSchema.extend({source:z.literal('host-tool-definition'),digest:digestSchema}).strict().optional(),digest:digestSchema,
}).strict()
const observationSchema=z.object({
  source:z.literal('conversation-evidence'),representation:z.literal('rendered-tool-result'),scope:z.literal('this-call-only'),
  sessionId:label,conversationDigest:digestSchema,callId:label,callEvidenceId:z.string().regex(/^e\d+$/),resultEvidenceId:z.string().regex(/^e\d+$/),
  inputDigest:digestSchema,resultDigest:digestSchema,shape:z.record(z.string(),z.unknown()),
}).strict()
export const planningToolOutputContractSchema=z.object({toolId:label,guarantee:guaranteeSchema,observations:z.array(observationSchema).max(2),digest:digestSchema}).strict()
export const planningToolOutputSnapshotSchema=z.object({protocolVersion:z.literal(1),contracts:z.array(planningToolOutputContractSchema).max(5000),digest:digestSchema}).strict()
export type PlanningToolOutputContract=z.infer<typeof planningToolOutputContractSchema>
export type PlanningToolOutputSnapshot=z.infer<typeof planningToolOutputSnapshotSchema>

/** Key order does not change a contract. Values and schema array order do. */
function digest(value:unknown):string {
  const canonical=(item:any):any=>Array.isArray(item)?item.map(canonical):item&&typeof item==='object'?Object.fromEntries(Object.keys(item).sort().map(key=>[key,canonical(item[key])])):item
  return jsonDigest(canonical(value))
}
const conflict=(message:string):never=>{throw new CompilerError('TOOL_OUTPUT_CONTRACT_CONFLICT',message,undefined,true)}
/** Output fields a builtin tool declared before; a task frozen then still loads and
 * reports the change only when it is published (Desktop r50: adding file.stat `name`
 * failed the r49 task, and with it the whole planning store). Add the old fields here
 * before changing a builtin's outputs. */
export const PREVIOUS_BUILTIN_OUTPUTS:Readonly<Record<string,readonly Readonly<Record<string,string>>[]>>={
  'builtin:file.stat':[{text:'string：一句话摘要。',path:'string：工作区相对路径。',bytes:'number：文件真实字节数，含 BOM 和行尾。',lines:'number：行数；末尾换行不多算一行。',lineEnding:'string：lf/crlf/cr/mixed/none。',endsWithNewline:'boolean：是否以换行结尾。',bom:'boolean：是否有 UTF-8 BOM。'}],
}

export function planningAdapterOutputs(tool:ToolChoice):{status:'known'|'partial'|'unknown';source:'adapter-contract';adapterVersion:PlanningToolOutputContract['guarantee']['adapterVersion'];fields:Record<string,string>}{
  const builtin=NODE_SEMANTICS.tool.builtinTools?.find(item=>item.toolId===tool.id)
  if(tool.id.startsWith('native:'))return {status:'partial' as const,source:'adapter-contract' as const,adapterVersion:'native-output-v1',fields:{text:'原始 value 的字符串或 JSON 文本。',value:'原始返回值。内部字段未知；仅凭本包装不能推断 value.text 或 value.result。'}}
  if(tool.id.startsWith('workflow:'))return {status:'partial' as const,source:'adapter-contract' as const,adapterVersion:'workflow-output-v1',fields:{outputs:'子工作流的命名输出，内部键以对应工作流合同为准。',run_id:'子运行 ID。',text:'outputs 的 JSON 文本。'}}
  return {status:builtin?'known' as const:'unknown' as const,source:'adapter-contract' as const,adapterVersion:builtin?'builtin-output-v1':'unknown-output-v1',fields:builtin?{...builtin.outputs}:{}}
}

/** A shape of rendered public content, never a schema of the canonical value. */
function observedShape(value:any,depth=0):Record<string,unknown>{
  if(value===null)return {type:'null'}
  if(Array.isArray(value))return {type:'array',...(depth<4?{observedItems:[...new Map(value.slice(0,8).map(item=>{const shape=observedShape(item,depth+1);return [digest(shape),shape]})).values()]}:{})}
  if(typeof value==='object')return {type:'object',...(depth<4?{observedProperties:Object.fromEntries(Object.entries(value).slice(0,40).map(([key,item])=>[key,observedShape(item,depth+1)]))}:{})}
  return {type:typeof value}
}
function observations(tools:readonly ToolChoice[],raw?:ConversationEvidence):Map<string,PlanningToolOutputContract['observations']>{
  const result=new Map<string,PlanningToolOutputContract['observations']>()
  if(!raw)return result
  const evidence=parseConversationEvidence(raw)
  // This is the frozen conversation-evidence v1 field order, not a new digest protocol.
  const expected=jsonDigest({version:evidence.version,sessionId:evidence.sessionId,fromSeq:evidence.fromSeq,throughSeq:evidence.throughSeq,records:evidence.records.map(record=>({id:record.id,seq:record.seq,kind:record.kind,text:record.text,status:record.status,...(record.toolName!==undefined?{toolName:record.toolName}:{}),...(record.callId!==undefined?{callId:record.callId}:{}),truncated:record.truncated})),warnings:evidence.warnings})
  if(expected!==evidence.digest)conflict('输出样本的冻结对话摘要不匹配')
  const calls=evidence.records.filter(record=>record.kind==='tool-call'&&record.status==='reported-success'&&!record.truncated&&record.callId&&record.toolName)
  for(const record of evidence.records){
    if(record.kind!=='tool-result'||record.status!=='reported-success'||record.truncated||!record.callId||!record.toolName)continue
    if(evidence.records.filter(item=>item.kind==='tool-result'&&item.callId===record.callId).length!==1)continue
    const matching=calls.filter(call=>call.callId===record.callId&&call.toolName===record.toolName&&call.seq<record.seq)
    if(matching.length!==1)continue
    const exact=tools.filter(tool=>tool.id===`native:${record.toolName}`),candidates=exact.length?exact:tools.filter(tool=>tool.name===record.toolName)
    if(candidates.length!==1)continue
    const tool=candidates[0]!,entries=result.get(tool.id)??[]
    if(entries.length>=2)continue
    let value:unknown=record.text
    try{value=JSON.parse(record.text)}catch{/* Plain rendered text remains a text observation. */}
    let shape:Record<string,unknown>
    try{shape=compilerJson(observedShape(value),16000)}catch{continue}
    entries.push({source:'conversation-evidence',representation:'rendered-tool-result',scope:'this-call-only',sessionId:evidence.sessionId,conversationDigest:evidence.digest,callId:record.callId,callEvidenceId:matching[0]!.id,resultEvidenceId:record.id,inputDigest:digest(matching[0]!.text),resultDigest:digest(record.text),shape})
    result.set(tool.id,entries)
  }
  return result
}

export function buildPlanningToolOutputs(tools:readonly ToolChoice[],options:{schemas?:readonly TrustedToolOutputSchema[];conversation?:ConversationEvidence;builtinFields?:ReadonlyMap<string,Record<string,string>>}={}):PlanningToolOutputSnapshot {
  const schemas=new Map<string,NonNullable<PlanningToolOutputContract['guarantee']['schema']>>()
  for(const raw of options.schemas??[]){
    const declaration=declarationSchema.parse(compilerJson(raw,128000))
    if(!declaration.toolId.startsWith('native:')||declaration.sourceId!==`native-tool:${declaration.toolId.slice(7)}`||!tools.some(tool=>tool.id===declaration.toolId&&tool.available)||schemas.has(declaration.toolId))conflict('输出 schema 必须来自当前唯一可用的原生工具定义')
    assertSupportedJsonSchema(declaration.schema)
    schemas.set(declaration.toolId,{...declaration,source:'host-tool-definition',digest:digest(declaration)})
  }
  const samples=observations(tools,options.conversation),seen=new Set<string>()
  const contracts=tools.map(tool=>{
    if(seen.has(tool.id))conflict('工具输出合同身份重复');seen.add(tool.id)
    const adapter=planningAdapterOutputs(tool),schema=schemas.get(tool.id)
    const guaranteeBody={adapterVersion:adapter.adapterVersion,fields:options.builtinFields?.get(tool.id)??adapter.fields,...(schema?{schema}:{})}
    const guarantee={...guaranteeBody,digest:digest(guaranteeBody)}
    const body={toolId:tool.id,guarantee,observations:samples.get(tool.id)??[]}
    return {...body,digest:digest(body)}
  }).sort((a,b)=>a.toolId.localeCompare(b.toolId))
  const body={protocolVersion:1 as const,contracts}
  return compilerJson({...body,digest:digest(body)},8_000_000)
}

export function parsePlanningToolOutputSnapshot(raw:PlanningToolOutputSnapshot):PlanningToolOutputSnapshot {
  const snapshot=planningToolOutputSnapshotSchema.parse(compilerJson(raw,8_000_000))
  const seen=new Set<string>()
  for(const contract of snapshot.contracts){
    if(seen.has(contract.toolId))conflict('工具输出快照身份重复');seen.add(contract.toolId)
    const {digest:contractDigest,...body}=contract,{digest:guaranteeDigest,...guarantee}=contract.guarantee
    if(guarantee.schema){
      const {source:_,digest:schemaDigest,...declaration}=guarantee.schema
      if(declaration.toolId!==contract.toolId||!contract.toolId.startsWith('native:')||declaration.sourceId!==`native-tool:${contract.toolId.slice(7)}`||digest(declaration)!==schemaDigest)conflict('工具输出 schema 来源或摘要无效')
      assertSupportedJsonSchema(declaration.schema)
    }
    if(digest(guarantee)!==guaranteeDigest||digest(body)!==contractDigest)conflict('工具输出合同摘要无效')
  }
  if(digest({protocolVersion:snapshot.protocolVersion,contracts:snapshot.contracts})!==snapshot.digest)conflict('工具输出快照摘要无效')
  return snapshot
}
/** Check loaded metadata against its exact frozen tools and conversation, not newer history. */
export function validatePlanningToolOutputs(raw:PlanningToolOutputSnapshot,tools:readonly ToolChoice[],conversation?:ConversationEvidence):PlanningToolOutputSnapshot {
  const snapshot=parsePlanningToolOutputSnapshot(raw),schemas=snapshot.contracts.flatMap(contract=>{
    const schema=contract.guarantee.schema
    return schema?[{toolId:schema.toolId,sourceId:schema.sourceId,version:schema.version,valuePath:schema.valuePath,schema:schema.schema}]:[]
  })
  // Fields frozen under an earlier builtin version are that version's, not a forgery.
  const builtinFields=new Map(snapshot.contracts.flatMap(contract=>contract.guarantee.adapterVersion==='builtin-output-v1'&&PREVIOUS_BUILTIN_OUTPUTS[contract.toolId]?.some(old=>digest(old)===digest(contract.guarantee.fields))?[[contract.toolId,contract.guarantee.fields] as const]:[]))
  const expected=buildPlanningToolOutputs(tools,{schemas,conversation,builtinFields})
  if(expected.digest!==snapshot.digest)conflict('工具输出合同或样本不属于冻结上下文')
  return snapshot
}
/** Compare guarantees only. New history cannot overwrite or upgrade frozen observations. */
export function assertPlanningToolOutputsUnchanged(frozen:PlanningToolOutputSnapshot,tools:readonly ToolChoice[],usedIds:readonly string[],schemas:readonly TrustedToolOutputSchema[]=[]):void {
  const before=new Map(parsePlanningToolOutputSnapshot(frozen).contracts.map(contract=>[contract.toolId,contract.guarantee.digest]))
  const after=new Map(buildPlanningToolOutputs(tools,{schemas}).contracts.map(contract=>[contract.toolId,contract.guarantee.digest]))
  for(const id of new Set(usedIds))if(before.get(id)!==after.get(id))conflict(`使用的工具输出保证已变化：${id}；请重新规划`)
}
