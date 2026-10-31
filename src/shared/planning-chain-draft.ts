import { CompilerError, compilerJson } from './planning-repair.ts'
import { chainSpliceSchema, type ChainForm, type ChainSplice } from './planning-chain-contract.ts'

/** values: fields an update op sets on an existing node, which keeps its ID. */
export interface ChainDraftEntry {alias:string; nodeId?:string; form?:ChainForm; values?:Record<string,unknown>}
export interface ChainDraft {
  version:1; chainKey:string; baseDigest:string; baseRevision:number; draftRevision:number
  active:ChainDraftEntry[]; retired:string[]; reservedKeys:string[]; aliasWrites:number
  /** An insert keeps its target under a new alias; the old alias still names that node. */
  moved:Record<string,string>
}
const fail=(code:string,message:string):never=>{throw new CompilerError(code,message,undefined,true)}
/** Numeric segments, including recursive # segments, are compared as integers. */
export function compareChainAliases(left:string,right:string):number {
  const parse=(value:string)=>{const match=/^([A-Za-z][A-Za-z0-9_-]*)-([1-9]\d*(?:#[1-9]\d*)*)$/.exec(value);if(!match)fail('CHAIN_ALIAS','临时编号语法无效：'+value);return {key:match![1]!,parts:match![2]!.split('#').map(BigInt)}}
  const a=parse(left),b=parse(right)
  if(a.key!==b.key)fail('CHAIN_ALIAS_SCOPE','不同链的临时编号不能比较顺序')
  for(let i=0;i<Math.min(a.parts.length,b.parts.length);i++)if(a.parts[i]!==b.parts[i])return a.parts[i]!<b.parts[i]!?-1:1
  return a.parts.length-b.parts.length
}
/** Host builds this once from stable IDs and explicit graph topology. No model IDs are allocated here. */
export function createChainDraft(binding:{chainKey:string;baseDigest:string;baseRevision:number;nodeIds:readonly string[]}):ChainDraft {
  if(!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(binding.chainKey)||!binding.nodeIds.length||new Set(binding.nodeIds).size!==binding.nodeIds.length)fail('CHAIN_BINDING','链前缀、初始身份序列无效')
  return {version:1,chainKey:binding.chainKey,baseDigest:binding.baseDigest,baseRevision:binding.baseRevision,draftRevision:0,active:binding.nodeIds.map((nodeId,index)=>({alias:`${binding.chainKey}-${index+1}`,nodeId})),retired:[],reservedKeys:[],aliasWrites:binding.nodeIds.length,moved:{}}
}
/** Desktop r60 E: after "insert before a-1" the main chat still wrote a-1 for the node it inserted before. */
export function resolveChainAlias(draft:ChainDraft,alias:string):string {
  let current=alias
  for(let depth=0;depth<24&&!draft.active.some(entry=>entry.alias===current)&&draft.moved[current];depth++)current=draft.moved[current]!
  return current
}
/** Immutable local splice. Retired parents and deleted aliases are never reused in this draft. */
export function applyChainSplice(draft:ChainDraft,raw:ChainSplice):ChainDraft {
  const operation=chainSpliceSchema.parse(compilerJson(raw))
  if(draft.version!==1||operation.draftRevision!==draft.draftRevision)fail('CHAIN_DRAFT_REVISION','操作属于旧草稿版本；请读取当前 draftRevision')
  const at=resolveChainAlias(draft,operation.target),index=draft.active.findIndex(entry=>entry.alias===at)
  if(index<0)fail('CHAIN_TARGET_INACTIVE','目标已删除、已展开或不属于当前草稿：'+operation.target+'；当前可用：'+draft.active.map(entry=>entry.alias+(entry.form?`（新增 ${entry.form.key}）`:'')).join('、'))
  const target=draft.active[index]!
  if(operation.op==='update'){
    const entry=target.form?{...target,form:{...target.form,values:compilerJson({...target.form.values,...operation.values})}}:{...target,values:compilerJson({...target.values,...operation.values})}
    return {...draft,draftRevision:draft.draftRevision+1,active:draft.active.map((item,i)=>i===index?entry:item)}
  }
  const forms=operation.op==='delete'?[]:operation.nodes
  if(target.alias.split('#').length>=24)fail('CHAIN_DEPTH_LIMIT','临时编号展开层次超过 24 层')
  const keys=forms.map(form=>form.key),reserved=new Set(draft.reservedKeys)
  if(new Set(keys).size!==keys.length||keys.some(key=>reserved.has(key)))fail('CHAIN_DUPLICATE_KEY','新增节点 key 已在本草稿使用；删除后也不能复用')
  const values:Omit<ChainDraftEntry,'alias'>[]=forms.map(form=>({form:structuredClone(form)}))
  const kept=operation.op==='insert'?(operation.position==='before'?values.length:0):-1
  if(operation.op==='insert')values.splice(kept,0,{...(target.nodeId?{nodeId:target.nodeId}:{}),...(target.form?{form:structuredClone(target.form)}:{}),...(target.values?{values:structuredClone(target.values)}:{})})
  const inserted=values.map((value,i)=>({...value,alias:`${target.alias}#${i+1}`}))
  return {...draft,draftRevision:draft.draftRevision+1,active:[...draft.active.slice(0,index),...inserted,...draft.active.slice(index+1)],retired:[...draft.retired,target.alias],reservedKeys:[...draft.reservedKeys,...keys],aliasWrites:draft.aliasWrites+inserted.length,
    moved:kept<0?draft.moved:{...draft.moved,[target.alias]:inserted[kept]!.alias}}
}
/** Standard aliases belong to the next alias version, not WorkflowNode.number. */
export function confirmChainDraft(draft:ChainDraft):{entries:(ChainDraftEntry&{standardAlias:string})[];mapping:Record<string,string>} {
  const aliases=new Set(draft.active.map(entry=>entry.alias)),retired=new Set(draft.retired)
  if(aliases.size!==draft.active.length||draft.active.some(entry=>retired.has(entry.alias)))fail('CHAIN_DRAFT_INVALID','有效编号不唯一或失效父仍在有效序列')
  for(let i=1;i<draft.active.length;i++)if(compareChainAliases(draft.active[i-1]!.alias,draft.active[i]!.alias)>=0)fail('CHAIN_DRAFT_ORDER','当前草稿的数字段顺序无效')
  const entries=draft.active.map((entry,index)=>({...structuredClone(entry),standardAlias:`${draft.chainKey}-${index+1}`}))
  return {entries,mapping:Object.fromEntries(entries.map(entry=>[entry.alias,entry.standardAlias]))}
}
