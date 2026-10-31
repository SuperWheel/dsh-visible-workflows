import type { JsonValue, Workflow, WorkflowNode, WorkflowRun } from '../shared/types.ts'
import { allNodes } from '../shared/workflow-validation.ts'

/** T37 (Desktop r61 E): the main chat spent six minutes finding the workflow, the node and the fields a saved run already holds. */

/** Text the user quoted (「字节数」), without the workflow's own title. */
export function requestQuotes(request:string,title?:string):string[] {
  const quotes=[...request.matchAll(/[「『“"]([^「」『』“”"]{1,80})[」』”"]/g)].map(match=>match[1]!.trim())
  return [...new Set(quotes.filter(quote=>quote&&quote!==title?.trim()))]
}

/** Nodes whose title or config holds a quoted text, or whose title the request names; best match first. */
export function matchTargets(workflow:Workflow,request:string,quotes:readonly string[]):{node:WorkflowNode;matched:string[]}[] {
  return allNodes(workflow).flatMap(node=>{
    const config=JSON.stringify(node.config)
    const matched=[...quotes.filter(quote=>node.title.includes(quote)||config.includes(quote)),...(node.title.trim().length>=2&&request.includes(node.title.trim())?[node.title.trim()]:[])]
    return matched.length?[{node,matched:[...new Set(matched)]}]:[]
  }).sort((left,right)=>right.matched.length-left.matched.length).slice(0,5)
}

const topLevelResults=(run:WorkflowRun)=>run.executions.filter(record=>(record.executionId??record.nodeId)===record.nodeId&&record.status==='success'&&record.data)

/** The newest run of this workflow with recorded node results, preferring the current revision. */
export function latestRunFor(runs:readonly WorkflowRun[],workflow:Workflow):WorkflowRun|undefined {
  const current=(run:WorkflowRun)=>Number(run.sourceRevision===workflow.revision)
  return runs.filter(run=>run.workflowId===workflow.id&&!run.rootRunId&&topLevelResults(run).length)
    .sort((left,right)=>current(right)-current(left)||right.startedAt.localeCompare(left.startedAt))[0]
}

/** Recorded output of each top-level node in a run. */
export function runResults(run:WorkflowRun):Map<string,Record<string,JsonValue>> {
  return new Map(topLevelResults(run).map(record=>[record.nodeId,record.data!]))
}

/** Nodes another node reads from by stable ID in its config. */
export function dataSources(workflow:Workflow,node:WorkflowNode):string[] {
  const config=JSON.stringify(node.config)
  return allNodes(workflow).filter(item=>item.id!==node.id&&config.includes(item.id)).map(item=>item.id)
}

/** A short look at a recorded value: a few rows, cut long text, no JSON text copy beside the parsed value. */
export function sampleValue(value:unknown,depth=0):unknown {
  if(typeof value==='string')return value.length>1200?`${value.slice(0,1200)}…（共 ${value.length} 字）`:value
  if(value===null||typeof value!=='object')return value
  if(depth>=5)return '…'
  if(Array.isArray(value))return [...value.slice(0,3).map(item=>sampleValue(item,depth+1)),...(value.length>3?[`…共 ${value.length} 项`]:[])]
  const entries=Object.entries(value as Record<string,unknown>)
  const parsed=entries.some(([key])=>key==='result'||key==='json')
  const kept=entries.filter(([key,item])=>!(parsed&&key==='text'&&typeof item==='string'&&/^\s*[[{]/.test(item))&&!(key==='json'&&JSON.stringify(item)===JSON.stringify((value as Record<string,unknown>).result)))
  return Object.fromEntries(kept.slice(0,16).map(([key,item])=>[key,sampleValue(item,depth+1)]))
}

/** Nodes a candidate adds, or whose kind or config it changes. */
export function changedNodeIds(base:Workflow,candidate:Workflow):Set<string> {
  const before=new Map(allNodes(base).map(node=>[node.id,JSON.stringify({kind:node.kind,config:node.config})]))
  return new Set(allNodes(candidate).filter(node=>before.get(node.id)!==JSON.stringify({kind:node.kind,config:node.config})).map(node=>node.id))
}

const FORM_FIELDS=['key','template','values','title']
const isRecord=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
/**
 * Desktop r64 E: an insert or replace that writes one new node's key/template/values/title on the operation itself
 * instead of in nodes:[…]. Those fields belong to no operation, so they go into one node; an operation that also has
 * nodes, or lacks key or template, is left for the contract to reject.
 */
export function wrapFlatNodeForms(chain:unknown):unknown {
  if(!isRecord(chain)||!Array.isArray(chain.operations))return chain
  return {...chain,operations:chain.operations.map(operation=>{
    if(!isRecord(operation)||(operation.op!=='insert'&&operation.op!=='replace')||'nodes' in operation||typeof operation.key!=='string'||typeof operation.template!=='string')return operation
    const rest=Object.fromEntries(Object.entries(operation).filter(([field])=>!FORM_FIELDS.includes(field)))
    return {...rest,nodes:[Object.fromEntries(FORM_FIELDS.filter(field=>field in operation).map(field=>[field,operation[field]]))]}
  })}
}
/** Desktop r65 E: every operation left out draftRevision; they run in the order given, so number them 0, 1, 2…. A partly numbered list is left to the contract. */
export function numberDraftRevisions(chain:unknown):unknown {
  if(!isRecord(chain)||!Array.isArray(chain.operations)||!chain.operations.every(operation=>isRecord(operation)&&!('draftRevision' in operation)))return chain
  return {...chain,operations:chain.operations.map((operation,index)=>({...operation as Record<string,unknown>,draftRevision:index}))}
}
