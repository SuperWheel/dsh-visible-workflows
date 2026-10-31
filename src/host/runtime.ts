import { isHtmlTool } from './html-tools.ts'
import { CachedBodyError, HTTP_CACHE_THRESHOLD, isCachedBody, mapCachedBodies, type CachedBody } from '../shared/http-cache.ts'
import { RunRequestStore, runRequestDigest, validRequestId } from './run-request-store.ts'
import { executionPolicyWarnings } from '../shared/workflow-validation.ts'
import { activeExecutionPolicy } from '../shared/execution-policy.ts'
import { bindWorkflowSubagentsForRun, subagentForNode } from '../shared/workflow-subagents.ts'
import { workflowForExecution } from './workflow-scope.ts'
import { rolePresetAvailable } from '../shared/role-presets.ts'
import { evaluateLogicGate } from '../shared/logic-gates.ts'
import { randomUUID } from 'node:crypto'
import type {
  AgentTaskEvent, AgentSupplementMessage, Condition, InputField, JsonValue, ModelRef, NodeExecution, NodeGraph, ParameterField,
  VariableAssignment, Workflow, WorkflowModelDefaults, WorkflowNode, WorkflowRun, WorkflowRunRevisionPlan,
} from '../shared/types.ts'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { NativeRepairExhaustedError, nativeOutputSchema } from './native-agent.ts'
import { buildRecoveryPlan, workflowSemanticDigest } from './recovery-plan.ts'
import { reviewedRecovery } from './recovery-review.ts'
import { WorkflowStorage } from './storage.ts'
import { renderDataTemplate } from './template.ts'
import { allNodes, assertGraph, inputsSchema, topologicalNodes, parseWorkflow, protectFixedNodes } from './validation.ts'
import { applyModelDefaults } from './model-defaults.ts'
import { GraphonBridge, graphonRuntimeDirectory } from './graphon.ts'
import { assertNoSystemOverrides, createSystemVariables, environmentSnapshot } from '../shared/workflow-variables.ts'
import { observeAgentUsage, initializeUsage, ModelAdmission, recordUsageCall, settleUsage, settleUsageGroup } from './run-usage.ts'
import { assertReferenceAllowed, createReferenceScopePlan, visibleReferenceVariables, withReferenceVariables, type ReferenceScope, type ReferenceScopePlan } from '../shared/reference-scope.ts'
import type { FileEvidenceState, NativeFileReadReceipt } from '../shared/file-evidence.ts'
import { FileEvidenceError } from './file-evidence-error.ts'
import { dataSources, sampleValue } from './revise-locate.ts'

export interface TokenUsage { totalTokens: number; inputTokens?: number; outputTokens?: number }
export type AgentStepAdmission = (usage:TokenUsage|undefined,completedCalls:number)=>void
export interface ModelRequest { model: ModelRef; effort?: string; prompt: string; system: string; signal: AbortSignal; onUsage?: (usage: TokenUsage | undefined) => void }
export interface ModelBackend { generate(request: ModelRequest): Promise<string> }
export type AdapterNodeKind = 'agent' | 'knowledge' | 'code' | 'document' | 'http' | 'tool'
export interface AdapterRequest {
  readCachedBody?:(ref:CachedBody)=>Buffer; cacheHttpBody?:(bytes:Uint8Array,contentType:string)=>JsonValue
  node: WorkflowNode; inputs: Record<string,JsonValue>; workspaceId: string; runId: string; signal: AbortSignal; backend: ModelBackend
  rolePrompt?: string; executionId?: string; onUsage?: (usage: TokenUsage | undefined) => void; onTask?: (taskId: string) => void; onTaskEvent?: (event:AgentTaskEvent)=>void
  sessionId?:string; toolConstraints?:Record<string,string>; childRunId?:string; onChild?:(id:string)=>void; beforeModelStep?:AgentStepAdmission
  repairLimit?: number; repairMode?:'confirm'|'auto'; outputRepair?:{candidate:JsonValue;error:string;attempt:number}
  fileEvidence?:FileEvidenceState;fileEvidenceRoot?:string;onFileReadEvidence?:(receipts:NativeFileReadReceipt[])=>void
  withRepairUsage?: <T>(invoke:(onUsage:(usage:TokenUsage|undefined)=>void,outputLimit?:number,beforeModelStep?:AgentStepAdmission)=>Promise<T>)=>Promise<T>
}
export interface ExecutionAdapters {
  secretPreflight?(flow:Workflow,signal:AbortSignal):Promise<void>
  execute(kind: AdapterNodeKind, request: AdapterRequest): Promise<Record<string,JsonValue>>
  verify?(node:WorkflowNode,workspaceId:string,signal:AbortSignal):Promise<void>
  captureEvidence?(node:WorkflowNode,workspaceId:string,record:NodeExecution,signal:AbortSignal):Promise<void>
  verifyEvidence?(node:WorkflowNode,workspaceId:string,record:NodeExecution,signal:AbortSignal):Promise<void>
}
type Data = Record<string,JsonValue>
type Values = Map<string, Data>
interface Scope {
  guardCachedText?:(value:JsonValue)=>void; readCachedBody?:(ref:CachedBody)=>string
  values: Values; variables: Data; input: Data; environment?: Data; system?: Data; item?: JsonValue; index?: number
  path: string; parentNodeId?: string; inLoop?: boolean; references?: ReferenceScope; referencePlan?: ReferenceScopePlan
  outputClaims?: Map<string,{nodeId:string;settled:Promise<void>}>
}
/** T37: one node of a candidate graph rerun on a finished run's recorded outputs. */
export interface WorkflowReplayStep {nodeId:string;title:string;kind:string;status:'success'|'failed'|'not-replayed';output?:unknown;error?:string;reason?:string}
/** Pure computation only: nothing here reads or writes files, calls tools or models. */
const REPLAY_KINDS=new Set(['code','template','list','aggregator','output'])
export interface RunStartOptions {
  requestId?:string
  /** Host supplies external request parameters, excluding resolved defaults and current definitions. */
  requestParameters?:unknown
  repairAuthorization?:WorkflowRun['repairAuthorization']; toolConstraints?:Record<string,string>;freezeTools?:(flows:Workflow[])=>Record<string,string>
  sessionId?:string; sourceGraph?:Workflow; sourceRunId?:string; rolePrompts?:Record<string,string>
  dependencySnapshots?:Record<string,Workflow>; dependencyRolePrompts?:Record<string,Record<string,string>>; rootRunId?:string
}
const now = () => new Date().toISOString()
const own = (value: object,key:string) => Object.prototype.hasOwnProperty.call(value,key)
const forbidden = new Set(['__proto__','prototype','constructor'])
const stringify = (value: JsonValue): string => typeof value === 'string' ? value : JSON.stringify(value)
class MissingValue extends Error {}
export class HumanPause extends Error {}
class ExitLoop extends Error {}

function pathValue(value: JsonValue, path: string[], read?:(ref:CachedBody)=>string): JsonValue {
  for(const part of path) {
    if(isCachedBody(value)&&read)value=read(value)
    if(forbidden.has(part)||value===null||typeof value!=='object'||!own(value,part)) throw new MissingValue(`变量字段 ${path.join('.')} 不存在`)
    value=(value as Record<string,JsonValue>)[part]!
  }
  return isCachedBody(value)&&read?read(value):value
}
function reference(name:string,scope:Scope):JsonValue {
  const value=referenceRaw(name,scope);scope.guardCachedText?.(value);return value
}
function referenceRaw(name:string,scope:Scope):JsonValue {
  const key=name.trim().replace(/^\{\{\s*|\s*\}\}$/g,''), [head,...rest]=key.split('.')
  if(scope.references)assertReferenceAllowed(key,scope.references,{allowMissing:true})
  if(head==='item') {if(scope.item===undefined)throw new MissingValue('item 仅在迭代子流程可用');return pathValue(scope.item,rest,scope.readCachedBody)}
  if(head==='index') {if(scope.index===undefined)throw new MissingValue('index 仅在容器子流程可用');return pathValue(scope.index,rest)}
  if(head==='input') return pathValue(scope.input,rest,scope.readCachedBody)
  if(head==='env') return pathValue(scope.environment??{},rest)
  if(head==='sys') return pathValue(scope.system??{},rest)
  if(head==='vars') return pathValue(scope.references?visibleReferenceVariables(scope.variables,scope.references):scope.variables,rest,scope.readCachedBody)
  const data=scope.values.get(head!)
  if(!data) throw new MissingValue(`节点变量 ${key} 不存在或尚未产生结果（可能被条件跳过），请使用稳定节点 ID`)
  if(!rest.length)return scope.readCachedBody?mapCachedBodies(data,ref=>scope.readCachedBody!(ref)):data
  if(rest[0]==='json'&&!own(data,'json')&&isCachedBody(data.text)){
    if(!scope.readCachedBody)throw new CachedBodyError('HTTP 缓存正文读取不可用，请重跑抓取节点')
    const text=scope.readCachedBody(data.text)
    let json:JsonValue;try{json=JSON.parse(text) as JsonValue}catch{throw new MissingValue('HTTP 响应不是有效 JSON')}
    return pathValue(json,rest.slice(1))
  }
  if(rest[0]==='json'&&!own(data,'json'))return pathValue(data,rest.slice(1))
  return pathValue(data,rest,scope.readCachedBody)
}
function render(source:string,scope:Scope):string {
  const result=source.replace(/\{\{\s*([^{}]+?)\s*\}\}/g,(_m,key:string)=>stringify(reference(key,scope)))
  const literal=source.replace(/\{\{\s*[^{}]+?\s*\}\}/g,'')
  if(/\{\{|\}\}/.test(literal))throw new Error('模板变量括号不完整')
  if(result.length>1_000_000)throw new Error('节点文本超过 1 MB 限制')
  return result
}
function resolve(value:JsonValue,scope:Scope):JsonValue {
  if(typeof value==='string') {const exact=value.match(/^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/);return exact?structuredClone(reference(exact[1]!,scope)):render(value,scope)}
  if(Array.isArray(value))return value.map(v=>resolve(v,scope))
  if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolve(v,scope)]))
  return value
}
function mapping(input:Data|undefined,scope:Scope):Data {return Object.fromEntries(Object.entries(input??{}).map(([k,v])=>[k,resolve(v,scope)]))}
function listReference(source:string,scope:Scope):JsonValue[] {
  let value:JsonValue
  try {value=reference(source,scope)}catch(e){if(!source.trim().startsWith('['))throw e;value=JSON.parse(source) as JsonValue}
  if(typeof value==='string') {try{value=JSON.parse(value) as JsonValue}catch{throw new Error('列表来源不是 JSON 数组')}}
  if(!Array.isArray(value))throw new Error('列表来源必须为数组')
  if(value.length>1000)throw new Error('一次列表或迭代最多 1000 项')
  return value
}
function matches(condition:Condition,scope:Scope):boolean {
  const left=reference(condition.variable,scope)
  let right:JsonValue=resolve(condition.value??'',scope)
  if(typeof left==='number'&&typeof right==='string'&&right.trim()!=='')right=Number(right)
  if(typeof left==='boolean'&&typeof right==='string'&&['true','false'].includes(right))right=right==='true'
  const empty=left===null||left===''||(Array.isArray(left)&&left.length===0)
  switch(condition.operator) {
    case 'empty':return empty
    case 'not_empty':return !empty
    case 'equals':return JSON.stringify(left)===JSON.stringify(right)
    case 'not_equals':return JSON.stringify(left)!==JSON.stringify(right)
    case 'contains':return Array.isArray(left)?left.some(x=>JSON.stringify(x)===JSON.stringify(right)):typeof left==='string'&&left.includes(stringify(right))
    case 'not_contains':return !matches({...condition,operator:'contains'},scope)
    case 'starts_with':return typeof left==='string'&&left.startsWith(stringify(right))
    case 'ends_with':return typeof left==='string'&&left.endsWith(stringify(right))
    default:
      if(typeof left!=='number'||typeof right!=='number'||!Number.isFinite(right))throw new Error('数值比较要求左右两侧都是数字')
      return condition.operator==='gt'?left>right:condition.operator==='gte'?left>=right:condition.operator==='lt'?left<right:left<=right
  }
}
function typedInputs(fields:InputField[],raw:Record<string,string>):Data {
  const data:Data={}
  for(const f of fields) {
    const value=raw[f.name]??f.defaultValue??''
    if(!['file','files'].includes(f.type??'text')&&value.length>200000)throw new Error(`字段 ${f.label||f.name} 超过 200000 字符`)
    if(value===''){data[f.name]='';continue}
    switch(f.type??'text') {
      case 'number': {const n=Number(value);if(!Number.isFinite(n))throw new Error(`字段 ${f.label||f.name} 必须是数字`);data[f.name]=n;break}
      case 'boolean':if(value!=='true'&&value!=='false')throw new Error(`字段 ${f.label||f.name} 必须是 true 或 false`);data[f.name]=value==='true';break
      case 'json':case 'file':case 'files': {
        let parsed:JsonValue;try{parsed=JSON.parse(value) as JsonValue}catch{throw new Error(`字段 ${f.label||f.name} 不是有效 JSON`)}
        if(f.type==='files'&&!Array.isArray(parsed))throw new Error(`字段 ${f.label||f.name} 必须是文件数组`)
        if(f.type==='file'&&(parsed===null||Array.isArray(parsed)||typeof parsed!=='object'))throw new Error(`字段 ${f.label||f.name} 必须是文件对象`)
        data[f.name]=parsed;break
      }
      case 'select':if(!f.options?.includes(value))throw new Error(`字段 ${f.label||f.name} 的选项无效`);data[f.name]=value;break
      default:data[f.name]=value
    }
  }
  return data
}
function validateObject(value:unknown,fields:ParameterField[]):Data {
  if(value===null||typeof value!=='object'||Array.isArray(value))throw new Error('模型或代码输出必须为 JSON 对象')
  const data=value as Data
  for(const f of fields) {
    if(!own(data,f.name)){if(f.required!==false)throw new Error(`输出缺少必填参数 ${f.name}`);continue}
    const v=data[f.name],type=Array.isArray(v)?'array':v===null?'null':typeof v
    if(type!==f.type)throw new Error(`参数 ${f.name} 应为 ${f.type}，实际为 ${type}`)
  }
  return data
}
function parseJson(text:string):unknown {return JSON.parse(text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''))}
function classifiedCategory(text:string,classes:{id:string;label:string;description?:string}[]|undefined) {
  let parsed:unknown;try{parsed=parseJson(text)}catch{throw new Error('分类模型未返回有效 JSON')}
  const id=(parsed as {class_id?:unknown})?.class_id,category=classes?.find(x=>x.id===id)
  if(!category)throw new Error('分类模型未返回已定义的类别 ID')
  return category
}
function aggregateGroups(groups:{name:string;variables:string[]}[],scope:Scope):Data {
  const result:Data={}
  for(const group of groups){
    const found:JsonValue[]=[]
    for(const ref of group.variables){try{found.push(reference(ref,scope))}catch(e){if(!(e instanceof MissingValue))throw e}}
    if(found.length!==1)throw new Error(`聚合组 ${group.name} 需要一个有效互斥分支，实际为 ${found.length}`)
    result[group.name]=found[0]!
  }
  return result
}
function assignedValue(operation:VariableAssignment['operation'],old:JsonValue|undefined,value:JsonValue):JsonValue {
  let next:JsonValue
  switch(operation){
    case 'set':next=value;break
    case 'clear':next=Array.isArray(old)?[]:typeof old==='string'?'':typeof old==='number'?0:typeof old==='boolean'?false:old&&typeof old==='object'?{}:null;break
    case 'append':if(!Array.isArray(old))throw new Error('append 目标必须是数组');next=[...old,value];break
    case 'extend':if(!Array.isArray(old)||!Array.isArray(value))throw new Error('extend 要求数组');next=[...old,...value];break
    case 'pop':case 'shift':if(!Array.isArray(old))throw new Error('移除首尾目标必须是数组');next=operation==='pop'?old.slice(0,-1):old.slice(1);break
    default:
      if(typeof old!=='number'||typeof value!=='number')throw new Error('算术赋值要求数值')
      next=operation==='add'?old+value:operation==='subtract'?old-value:operation==='multiply'?old*value:old/value
      if(!Number.isFinite(next))throw new Error('算术赋值产生无效数值')
  }
  return next
}
function sortedList(result:JsonValue[],order:'asc'|'desc'):JsonValue[] {
  const type=typeof result[0]
  if(result.some(v=>typeof v!==type)||!['string','number','boolean','undefined'].includes(type))throw new Error('排序要求同类型字符串、数字或布尔数组')
  return [...result].sort((a,b)=>{const cmp=a===b?0:a!<b!?-1:1;return order==='desc'?-cmp:cmp})
}
const UNFINISHED_RUN_STATUSES=['running','waiting','paused','pausing','budget_waiting']
const sessionIdOf=(run:WorkflowRun)=>typeof run.systemVariables?.session_id==='string'?run.systemVariables.session_id:undefined

/** Backward-compatible plain interpolation; runtime uses typed values internally. */
export function renderTemplate(template:string,run:WorkflowRun,values:Map<string,string>):string {
  return render(template,{values:new Map([...values].map(([id,text])=>[id,{text}])),variables:{},input:run.inputs,environment:run.environment,system:run.systemVariables,path:''})
}

/** One executor serves UI buttons and Agent tools; successful steps are never replayed when Human Input resumes. */
export class WorkflowRuntime {
  private running=new Map<string,{controller:AbortController;done:Promise<void>}>()
  private timers=new Map<string,ReturnType<typeof setTimeout>>()
  private liveRuns=new Map<string,WorkflowRun>()
  private pauseRequested=new Set<string>()
  private repairRoots=new Set<string>()
  private superseded=new WeakSet<WorkflowRun>()
  /** Replay copies of a run; never saved. */
  private detached=new WeakSet<WorkflowRun>()
  private activeMetering=new Map<string,{owner:WorkflowRun;record:NodeExecution;ids:string[];signal:AbortSignal;settled:boolean}>()
  private readonly admission:ModelAdmission
  private closed=false
  private readonly requests:RunRequestStore
  private readonly graphon: GraphonBridge
  constructor(
    readonly storage:WorkflowStorage,private backend:ModelBackend,private adapters?:ExecutionAdapters,
    private readinessPreflight?:(run:WorkflowRun,signal:AbortSignal)=>Promise<void>,
    engineOptions?:{verifyRuntimeContents?:boolean;admission?:ModelAdmission;runtimeDirectory?:string},
  ) {
    this.requests=new RunRequestStore(storage.directory)
    this.admission=engineOptions?.admission??new ModelAdmission(8)
    this.graphon = new GraphonBridge(engineOptions?.runtimeDirectory??graphonRuntimeDirectory(storage.directory),engineOptions)
    for(const run of storage.runs())if(run.status==='waiting'&&run.waitingNodeId)this.armTimeout(run)
  }
  private prepareSnapshot(value:Workflow,modelDefaults:WorkflowModelDefaults|undefined,options:RunStartOptions={}){
    const graph=structuredClone(value);bindWorkflowSubagentsForRun(graph,options.sessionId);applyModelDefaults(graph,modelDefaults);assertGraph(graph,true,!!this.adapters?.secretPreflight)
    const presets=this.storage.presets(),rolePrompts:Record<string,string>=structuredClone(options.rolePrompts??{})
    const freezeRoles=(flow:Workflow)=>Object.fromEntries(allNodes(flow).filter(n=>subagentForNode(flow,n)||n.config.rolePresetId).map(n=>{
      const agent=subagentForNode(flow,n);if(agent)return [n.id,agent.prompt]
      const p=presets.find(p=>p.id===n.config.rolePresetId&&rolePresetAvailable(p,flow.id))
      if(!p)throw new Error(`节点 ${n.number} 的角色预设不存在或不属于当前工作流`)
      return [n.id,p.prompt]
    }))
    if(!options.rolePrompts)Object.assign(rolePrompts,freezeRoles(graph))
    const dependencySnapshots:Record<string,Workflow>=structuredClone(options.dependencySnapshots??{}),dependencyRolePrompts=structuredClone(options.dependencyRolePrompts??{})
    const visit=(flow:Workflow,ancestors:string[])=>{
      for(const node of allNodes(flow))for(const tool of [node.config.toolId,...(node.config.tools??[])].filter((v):v is string=>!!v&&v.startsWith('workflow:'))){
        const childId=tool.slice(9);if(ancestors.includes(childId)||ancestors.length>=8)throw new Error('工作流递归调用或超过 8 层限制')
        if(dependencySnapshots[childId])continue
        if(options.dependencySnapshots)throw new Error(`历史快照缺少子工作流 ${childId}，不能读取最新定义替代`)
        const child=workflowForExecution(this.storage.get(childId),graph.workspaceId)
        bindWorkflowSubagentsForRun(child,options.sessionId);applyModelDefaults(child,modelDefaults);assertGraph(child,true,!!this.adapters?.secretPreflight)
        dependencySnapshots[childId]=child;dependencyRolePrompts[childId]=freezeRoles(child);visit(child,[...ancestors,childId])
      }
    };visit(graph,[graph.id])
    const toolConstraints=options.toolConstraints??options.freezeTools?.([graph,...Object.values(dependencySnapshots)])
    return {graph,rolePrompts,dependencySnapshots,dependencyRolePrompts,toolConstraints,environment:environmentSnapshot(graph,!!this.adapters?.secretPreflight)}
  }
  /** Lookup happens before capacity/preflight checks so a lost reply can always be read again. */
  requestRun(requestId:string|undefined,workspaceId:string,sessionId:string|undefined,parameters:unknown):WorkflowRun|undefined{
    if(requestId===undefined)return undefined
    if(!validRequestId(requestId))throw new Error('请求身份 requestId 无效')
    const digest=runRequestDigest(parameters)
    const prior=this.requests.get(workspaceId,sessionId,requestId)??this.storage.runs().find(run=>run.workspaceId===workspaceId&&run.requestReceipt?.sessionId===sessionId&&run.requestReceipt?.requestId===requestId)
    if(!prior)return undefined
    if(prior.requestReceipt!.parametersDigest!==digest)throw new Error('REQUEST_ID_CONFLICT：同一运行请求身份的参数已改变')
    const live=this.storage.runs().find(run=>run.id===prior.id)
    if(live)return live
    // Admission may have committed just before a run-store failure/crash. Never
    // dispatch it again; materialize an interrupted record for explicit recovery.
    if(UNFINISHED_RUN_STATUSES.includes(prior.status)){
      prior.status='interrupted';prior.endedAt=now();prior.error='请求已受理，运行记录未完整提交；未自动重放，请核查后显式恢复'
      this.requests.save(prior);this.storage.saveRun(prior)
    }
    return prior
  }

  start(id:string,rawInputs:unknown,modelDefaults?:WorkflowModelDefaults,options:RunStartOptions={}):WorkflowRun {
    return this.startPrepared(id,rawInputs,modelDefaults,options)
  }
  private startPrepared(id:string,rawInputs:unknown,modelDefaults:WorkflowModelDefaults|undefined,options:RunStartOptions,prepare?:(run:WorkflowRun)=>void):WorkflowRun {
    const {requestId,requestParameters,freezeTools,...parameters}=options
    const identity=requestParameters??{operation:'start',id,inputs:rawInputs,modelDefaults,options:parameters}
    // Legacy callers preserve the existing admission behavior.
    const workspaceId=options.sourceGraph?.workspaceId??(requestId===undefined?'':this.requests.find(requestId,options.sessionId,run=>run.workflowId===id)?.workspaceId??this.storage.get(id).workspaceId)
    const prior=this.requestRun(requestId,workspaceId,options.sessionId,identity)
    if(prior)return prior
    this.assertCanStart(id)
    if(rawInputs&&typeof rawInputs==='object'&&!Array.isArray(rawInputs))assertNoSystemOverrides(rawInputs as Record<string,unknown>)
    const {graph,rolePrompts,dependencySnapshots,dependencyRolePrompts,toolConstraints}=this.prepareSnapshot(options.sourceGraph??this.storage.get(id),modelDefaults,options)
    const runId=randomUUID(),inputs=this.prepareInputs(graph.nodes.find(n=>n.kind==='input')?.config.fields??[],rawInputs,runId)
    const startedAt=now(),environment=environmentSnapshot(graph,!!this.adapters?.secretPreflight),systemVariables=createSystemVariables({workflowId:graph.id,runId,workspaceId:graph.workspaceId,startedAt,sessionId:options.sessionId})
    const repairAuthorization=options.rootRunId?this.liveRuns.get(options.rootRunId)?.repairAuthorization:options.repairAuthorization
    const run:WorkflowRun={
      ...(repairAuthorization?{repairAuthorization:structuredClone(repairAuthorization)}:{}),
      engine:this.graphon.engine,id:runId,workflowId:graph.id,workspaceId:graph.workspaceId,workflowTitle:graph.title,sourceRevision:graph.revision,graph,activeRevision:1,status:'waiting',
      inputs,outputs:{},startedAt,rolePrompts,environment,systemVariables,toolConstraints,dependencySnapshots,dependencyRolePrompts,
      ...(options.sourceRunId?{sourceRunId:options.sourceRunId}:{}),
      ...(options.rootRunId?{rootRunId:options.rootRunId}:{}),
      ...(modelDefaults?{modelDefaults:structuredClone(modelDefaults)}:{}),
      executions:graph.nodes.map(n=>this.record(n,n.id,rolePrompts)),
    }
    run.snapshotDigest=workflowSemanticDigest(graph,{dependencySnapshots,rolePrompts,dependencyRolePrompts,environment,toolConstraints,modelDefaults:run.modelDefaults,inputs,systemVariables,engine:run.engine})
    if(requestId!==undefined)run.requestReceipt={requestId,sessionId:options.sessionId,parametersDigest:runRequestDigest(identity),runId}
    run.compatibilityWarnings=executionPolicyWarnings(graph)
    initializeUsage(run)
    prepare?.(run)
    this.checkInputs(run);this.saveRun(run)
    if(!run.missingFields?.length)this.launch(run)
    return structuredClone(run)
  }
  private assertCanStart(id:string):void {
    if(this.closed)throw new Error('运行器已关闭')
    if(this.running.size>=4)throw new Error('最多同时运行 4 个工作流，请等待当前任务结束')
    if(this.storage.runs().some(r=>r.workflowId===id&&UNFINISHED_RUN_STATUSES.includes(r.status)))throw new Error('此工作流已有未结束的运行，请查看或取消后再启动')
  }
  private record(node:WorkflowNode,id:string,prompts:Record<string,string>,scope?:Scope):NodeExecution {
    return {
      runRevision:1,nodeId:node.id,executionId:id,...(node.config.subagentId?{subagentDefinitionId:node.config.subagentId}:{}),
      number:node.number,title:node.title,status:'pending',model:node.config.model,effort:node.config.effort,rolePrompt:prompts[node.id]??'',
      ...(scope?.parentNodeId?{parentNodeId:scope.parentNodeId,iteration:scope.index}:{}),
    }
  }
  private prepareInputs(fields:InputField[],value:unknown,runId?:string):Record<string,string> {
    const parsed=inputsSchema.parse(value)
    if(Object.keys(parsed).some(name=>!fields.some(f=>f.name===name)))throw new Error('输入包含工作流未声明的字段')
    const result:Record<string,string>={}
    for(const field of fields)result[field.name]=own(parsed,field.name)?parsed[field.name]!:field.defaultValue??''
    const typed=typedInputs(fields,result);let uploaded=0
    if(runId)for(const field of fields)if(['file','files'].includes(field.type??'')&&result[field.name]){
      const files=field.type==='files'?typed[field.name] as JsonValue[]:[typed[field.name]!]
      if(files.length>10)throw new Error('一次文件列表最多 10 个文件')
      for(const file of files)if(file&&typeof file==='object'&&!Array.isArray(file)&&typeof file.base64==='string')uploaded+=Buffer.byteLength(file.base64,'base64')
      if(uploaded>2*1024*1024)throw new Error('一次上传文件合计不能超过 2 MB')
      const refs=files.map(file=>this.storage.stageAttachment(runId,file));result[field.name]=JSON.stringify(field.type==='files'?refs:refs[0])
    }
    return result
  }
  private checkInputs(run:WorkflowRun):void {
    const fields=run.graph.nodes.find(n=>n.kind==='input')?.config.fields??[]
    run.missingFields=fields.filter(f=>f.required&&!run.inputs[f.name]?.trim())
    run.status=run.missingFields.length?'waiting':'running';if(!run.missingFields.length)delete run.missingFields
  }
  answer(id:string,rawInputs:unknown):WorkflowRun {
    if(this.closed)throw new Error('运行器已关闭')
    // While the paused executor still drains, answer on its live object so its
    // late checkpoints (parallel siblings, usage) and this answer share one state.
    const run=this.liveRuns.get(id)??this.storage.run(id)
    if(run.status!=='waiting')throw new Error('本次运行已不再等待输入，请刷新运行状态')
    if(this.running.size>=4)throw new Error('最多同时运行 4 个工作流')
    const answer=inputsSchema.parse(rawInputs)
    if(run.waitingNodeId) {
      const node=allNodes(run.graph).find(n=>n.id===run.waitingNodeId)!,fields=run.missingFields??node.config.fields??[]
      const action=answer.__action??(node.config.actions?.length===1?node.config.actions[0]!.id:undefined)
      if(!action||!node.config.actions?.some(a=>a.id===action))throw new Error('请选择有效的人工操作')
      const input={...answer};delete input.__action
      const prepared=this.prepareInputs(fields,input,run.id),missing=fields.filter(f=>f.required&&!prepared[f.name]?.trim())
      if(missing.length)throw new Error(`请填写：${missing.map(f=>f.label||f.name).join('、')}`)
      const rec=run.executions.find(e=>(e.executionId??e.nodeId)===run.waitingExecutionId)!
      rec.data={...typedInputs(fields,prepared),__action_id:action,__action_value:node.config.actions!.find(a=>a.id===action)!.label,__rendered_content:run.humanPrompt??''}
      rec.data.text=JSON.stringify(rec.data);rec.output=stringify(rec.data.text);rec.selectedPort=action;rec.status='success';rec.endedAt=now()
      this.clearWaiting(run);run.status='running';this.saveRun(run);this.launch(run)
    } else {
      run.inputs=this.prepareInputs(run.graph.nodes.find(n=>n.kind==='input')?.config.fields??[],{...run.inputs,...answer},run.id)
      this.checkInputs(run);this.saveRun(run);if(!run.missingFields?.length)this.launch(run)
    }
    return structuredClone(run)
  }
  private clearWaiting(run:WorkflowRun):void {
    const timer=this.timers.get(run.id);if(timer)clearTimeout(timer);this.timers.delete(run.id)
    delete run.waitingNodeId;delete run.waitingExecutionId;delete run.humanActions;delete run.humanPrompt;delete run.missingFields;delete run.waitingSince
  }
  private armTimeout(run:WorkflowRun):void {
    if(!run.waitingNodeId||!run.waitingSince)return
    const node=allNodes(run.graph).find(n=>n.id===run.waitingNodeId);if(!node)return
    const wait=Math.max(0,new Date(run.waitingSince).getTime()+(node.config.timeoutSeconds??259200)*1000-Date.now())
    const timer=setTimeout(()=>{
      if(this.closed)return
      const latest=this.liveRuns.get(run.id)??this.storage.run(run.id);if(latest.status!=='waiting'||latest.waitingExecutionId!==run.waitingExecutionId)return
      if(wait>2147483647){this.armTimeout(latest);return}
      const rec=latest.executions.find(e=>(e.executionId??e.nodeId)===latest.waitingExecutionId)!
      const containing=(graph:NodeGraph):NodeGraph|undefined=>graph.nodes.some(n=>n.id===latest.waitingNodeId)?graph:graph.nodes.map(n=>n.config.body?containing(n.config.body):undefined).find(Boolean)
      const graph=containing(latest.graph),hasTimeout=graph?.edges.some(e=>e.source===latest.waitingNodeId&&e.port==='timeout')
      rec.endedAt=now()
      if(hasTimeout)this.continueAfterTimeout(latest,rec)
      else this.failAfterTimeout(latest,rec)
    },Math.min(wait,2147483647));timer.unref?.();this.timers.set(run.id,timer)
  }
  private continueAfterTimeout(latest:WorkflowRun,rec:NodeExecution):void {
    rec.status='success';rec.selectedPort='timeout'
    rec.data={text:'人工介入等待超时',__action_id:'timeout',__action_value:'超时',__rendered_content:latest.humanPrompt??''};rec.output='人工介入等待超时'
    this.clearWaiting(latest);latest.status='running';this.saveRun(latest);this.launch(latest)
  }
  private failAfterTimeout(latest:WorkflowRun,rec:NodeExecution):void {
    rec.status='failed';rec.error='人工介入等待超时';latest.status='failed';latest.error=rec.error;latest.endedAt=now();this.clearWaiting(latest)
    for(const pending of latest.executions)if(pending.status==='pending')pending.status='skipped'
    this.saveRun(latest)
  }
  /** Every launch is a generation. A superseded executor may still be draining
   * the engine, but it can no longer persist its snapshot or evict the successor. */
  private saveRun(run:WorkflowRun):void {
    if(this.superseded.has(run)||this.detached.has(run))return
    for(const record of run.executions){for(const key of ['input','output','error'] as const)if(record[key]!==undefined)record[key]=this.storage.redactCachedText(run.id,record[key])}
    if(run.error)run.error=this.storage.redactCachedText(run.id,run.error)
    this.requests.save(this.storage.redactCachedText(run.id,run))
    this.storage.saveRun(run)
  }
  private launch(run:WorkflowRun):void {
    const controller=new AbortController(),prior=this.running.get(run.id),previous=this.liveRuns.get(run.id)
    if(previous&&previous!==run)this.superseded.add(previous)
    this.liveRuns.set(run.id,run)
    // Serialize per run: an answer or timeout that arrives before the paused
    // engine request drains waits for it instead of executing concurrently.
    const entry={controller,done:Promise.resolve()}
    entry.done=(prior?prior.done.catch(()=>{}):Promise.resolve()).then(()=>{
      if(prior&&previous===run){
        // The drained predecessor wrote its final checkpoints into this object.
        // A container that observed the earlier pause may have marked it paused;
        // a real pause request or repair wait keeps it, a terminal end is final.
        if(run.status==='paused'&&!this.pauseRequested.has(run.id)&&!run.executions.some(record=>record.repair?.waiting)){run.status='running';this.saveRun(run)}
        if(run.status!=='running')return
      }
      return this.execute(run,controller.signal)
    }).finally(()=>{
      if(this.running.get(run.id)===entry)this.running.delete(run.id)
      if(this.liveRuns.get(run.id)===run){this.liveRuns.delete(run.id);this.storage.releaseCachedReads(run.id)}
    })
    this.running.set(run.id,entry);void entry.done.catch(()=>{})
  }
  private async execute(run:WorkflowRun,signal:AbortSignal):Promise<void> {
    const fields=run.graph.nodes.find(n=>n.kind==='input')?.config.fields??[]
    try {
      // Every launch path (start, resume, answer, timeout, recovery and nested
      // execution) rechecks Host resources before any node or model action.
      await this.readinessPreflight?.(run,signal);signal.throwIfAborted()
      for(const flow of [run.graph,...Object.values(run.dependencySnapshots??{})]){
        const needs=flow.environmentVariables?.some(v=>v.type==='secret'&&v.required)||allNodes(flow).some(n=>n.config.credentialOperation)
        if(needs){if(!this.adapters?.secretPreflight)throw new Error('受保护凭据代理尚未接入');await this.adapters.secretPreflight(flow,signal);signal.throwIfAborted()}
      }
      const scope:Scope={
        readCachedBody:ref=>this.storage.readCachedBody(run.id,ref).toString('utf8'),values:new Map(),variables:{},input:typedInputs(fields,run.inputs),
        environment:run.environment,system:run.systemVariables,path:'',referencePlan:createReferenceScopePlan(run.graph),outputClaims:new Map(),
      }
      run.outputs={};await this.executeGraph(run.graph,run,scope,signal)
      run.status='success';run.endedAt=now();this.saveRun(run)
    }catch(error){
      if(error instanceof HumanPause){if(this.superseded.has(run))return;this.saveRun(run);this.armTimeout(run);return}
      this.endFailedRun(run,signal,error)
    }
  }
  private endFailedRun(run:WorkflowRun,signal:AbortSignal,error:unknown):void {
    run.status=signal.aborted?'cancelled':'failed';run.error=signal.aborted?'用户已取消运行':error instanceof Error?error.message:String(error);run.endedAt=now()
    for(const rec of run.executions){
      if(rec.status==='running'){rec.status=signal.aborted?'cancelled':'failed';rec.error??=run.error;rec.endedAt=run.endedAt}
      else if(rec.status==='pending')rec.status=signal.aborted?'cancelled':'skipped'
    }
    if(!run.rootRunId)for(const [id,allocation] of Object.entries(initializeUsage(run).allocations))if(allocation.status==='reserved')settleUsage(run,id,undefined)
    this.saveRun(run)
  }
  private async executeGraph(graph:NodeGraph,run:WorkflowRun,scope:Scope,signal:AbortSignal):Promise<void> {
    const nodes=new Map(graph.nodes.map(node=>[node.id,node]))
    const incomingVariables=structuredClone(scope.variables),assignments=topologicalNodes(graph).filter(node=>node.kind==='assigner')
    const recordFor=(node:WorkflowNode)=>{
      const executionId=scope.path?`${scope.path}/${node.id}`:node.id
      let record=run.executions.find(e=>(e.executionId??e.nodeId)===executionId)
      if(!record){if(run.executions.length>=5000)throw new Error('本次运行超过 5000 个节点步骤');record=this.record(node,executionId,run.rolePrompts??{},scope);record.runRevision=run.activeRevision??1;run.executions.push(record)}
      return record
    }
    const result=await this.graphon.execute(graph,signal,async(nodeId,nodeSignal)=>{
      nodeSignal.throwIfAborted()
      const node=nodes.get(nodeId);if(!node)throw new Error('引擎请求的节点不属于当前流程')
      const record=recordFor(node),container=node.kind==='iteration'||node.kind==='loop'
      const references=scope.referencePlan?.nodes.get(node.id)
      const variables=references?visibleReferenceVariables(incomingVariables,references):structuredClone(incomingVariables)
      // Arrival order cannot make a sibling's assignment visible. Reconstruct
      // each node's state only from its declared dependency path and this
      // graph's incoming checkpoint (including the previous loop round).
      for(const upstream of assignments)if(references?.nodeIds.has(upstream.id)){
        const changed=scope.values.get(upstream.id)?.variables
        if(changed&&typeof changed==='object'&&!Array.isArray(changed))Object.assign(variables,structuredClone(changed))
      }
      const nodeScope:Scope={...scope,variables,references}
      let data:Data,releaseOutput:(()=>void)|undefined
      try { try {
        if((this.pauseRequested.has(run.id)||!!run.rootRunId&&this.pauseRequested.has(run.rootRunId))&&record.status!=='success'){run.status='paused';record.status='pending';throw new HumanPause()}
        if(node.kind==='output'&&!scope.parentNodeId){
          // Parallel outputs may both start before either writes run.outputs.
          // Claim the name synchronously; a duplicate waits for the claimant to
          // settle so exactly one output completes whatever the arrival order.
          const name=node.config.outputName??'result',claims=scope.outputClaims??new Map(),claim=claims.get(name)
          if(claim&&claim.nodeId!==node.id||!claim&&own(run.outputs,name)){await claim?.settled;throw new Error(`输出名称「${name}」重复：多个已激活的输出不能覆盖同一结果，请使用不同名称或先汇总`)}
          if(!claim)claims.set(name,{nodeId:node.id,settled:new Promise<void>(resolve=>releaseOutput=resolve)})
        }
        if(node.kind==='exit_loop'&&record.status==='success')throw new ExitLoop()
        if(record.status==='success'&&record.data&&!container){await this.verifyRepairEvidence(node,run,record,nodeSignal);data=record.data}
        else {
          if(record.repair?.waiting){run.status='paused';throw new HumanPause()}
          if(record.status==='failed')throw new Error(record.error??'之前的节点执行失败')
          record.status='running';record.startedAt??=now();record.error=undefined
          this.saveRun(run)
          record.attempt=(record.attempt??0)+1
          data=await this.executeNode(node,record,run,nodeScope,nodeSignal)
          nodeSignal.throwIfAborted()
          if(node.kind==='http'&&typeof data.text==='string'&&Buffer.byteLength(data.text)>HTTP_CACHE_THRESHOLD){
            const ref=this.storage.cacheHttpBody(run.id,node.id,record.attempt!,Buffer.from(data.text),String((data.headers as Data|undefined)?.['content-type']??''))
            data={...data,text:ref,body:ref};delete data.json
          }
          await this.verifyRepairEvidence(node,run,record,nodeSignal)
          if(JSON.stringify(data).length>1_000_000)throw new Error('节点输出超过 1 MB 限制')
          this.assertMinTextLength(node,run,record,data)
          record.verification??={status:node.config.outputSchema?.length||node.config.verification?'passed':'unverified',reasons:[]}
          data=this.storage.compactCachedData(run.id,data,node.id,record.attempt??1) as Data
          record.data=data;record.output=stringify(data.text??data);record.status='success';record.endedAt=now()
        }
      }catch(error){
        // Engine failure invalidates in-flight callbacks without changing the
        // user's signal. The outer run owns the final status and persisted state;
        // late provider results must not overwrite it or write after close.
        if(nodeSignal.aborted)throw nodeSignal.reason??error
        if(record.fileEvidence&&!record.fileEvidence.after){try{await this.adapters?.verifyEvidence?.(node,run.workspaceId,record,nodeSignal)}catch{/* Preserve the original action error and the evidence outcome on the record. */}}
        if(error instanceof NativeRepairExhaustedError){this.pauseForRepair(run,record,error);return {data:{},control:'pause'}}
        if(error instanceof HumanPause){
          if(run.status==='running'||run.status==='pausing')run.status='paused'
          if(container||run.status==='paused')record.status='pending'
          this.saveRun(run);return {data:{},control:'pause'}
        }
        if(error instanceof ExitLoop){record.status='success';record.data={text:'退出循环'};record.output='退出循环';record.endedAt=now();this.saveRun(run);return {data:record.data,control:'exit_loop'}}
        this.failNodeRecord(node,run,record,signal,error);throw error
      }
      scope.values.set(node.id,data)
      // Restore deterministic local assignments from the durable checkpoint; completed external calls are not replayed.
      if(node.kind==='assigner'&&data.variables&&typeof data.variables==='object'&&!Array.isArray(data.variables))Object.assign(scope.variables,structuredClone(data.variables))
      if(node.kind==='output'&&!scope.parentNodeId)run.outputs[node.config.outputName??'result']=stringify(data.text??data)
      this.saveRun(run)
      const activePorts=record.selectedPort?[record.selectedPort,...(node.kind==='human'&&record.selectedPort!=='timeout'?['default']:[])]:undefined
      return {data,...(activePorts?{activePorts,selectedPort:record.selectedPort}:{})}
      } finally { releaseOutput?.() }
    },nodeId=>{
      const node=nodes.get(nodeId);if(!node)throw new Error('引擎跳过的节点不属于当前流程')
      const record=recordFor(node);if(record.status!=='success')record.status='skipped';this.saveRun(run)
    },{maxWorkers:graph.nodes.some(node=>node.kind==='human'||node.kind==='assigner')?1:run.graph.executionPolicy?.maxConcurrentAgents??3})
    signal.throwIfAborted()
    if(result.status==='paused')throw new HumanPause()
    if(result.status==='exit_loop')throw new ExitLoop()
    if(result.status!=='success')throw new Error(result.error??'工作流引擎执行失败')
  }
  private assertMinTextLength(node:WorkflowNode,run:WorkflowRun,record:NodeExecution,data:Data):void {
    if(node.config.verification?.minTextLength===undefined)return
    const text=isCachedBody(data.text)?this.storage.readCachedBody(run.id,data.text).toString('utf8'):stringify(data.text??data)
    if(text.trim().length<node.config.verification.minTextLength){record.verification={status:'failed',reasons:['输出长度未达到验证要求']};throw new Error('节点结果验证失败：输出长度不足')}
  }
  private pauseForRepair(run:WorkflowRun,record:NodeExecution,error:NativeRepairExhaustedError):void {
    record.status='waiting';record.error=error.message
    record.repair={mode:this.repairMode(run),usedAttempts:record.repairAttemptsUsed??error.attempts.length,waiting:true,candidate:error.candidate,limit:error.limit,attempts:error.attempts,reason:error.reason}
    record.verification={status:'failed',reasons:[error.message,...(record.verification?.reasons??[])]}
    run.status='paused';run.error=error.message;this.pauseRequested.add(run.id);if(run.rootRunId)this.pauseRequested.add(run.rootRunId)
    this.saveRun(run)
  }
  private failNodeRecord(node:WorkflowNode,run:WorkflowRun,record:NodeExecution,signal:AbortSignal,error:unknown):void {
    record.status=signal.aborted?'cancelled':'failed';record.error=error instanceof Error?error.message:String(error)
    if(!(error instanceof FileEvidenceError)&&(node.config.verification||node.config.outputSchema?.length))record.verification={status:'failed',reasons:[record.error,...(record.verification?.reasons??[])]}
    record.endedAt=now();this.saveRun(run)
  }
  private async metered<T>(
    run:WorkflowRun,record:NodeExecution,signal:AbortSignal,agent:boolean,
    invoke:(onUsage:(usage:TokenUsage|undefined)=>void,outputLimit?:number,beforeModelStep?:AgentStepAdmission)=>Promise<T>,reuseSlot=false,
  ):Promise<T>{
    const owner=run.rootRunId?this.liveRuns.get(run.rootRunId):run
    if(!owner)throw new Error('父运行上下文已结束，不能启动子调用')
    const release=reuseSlot?()=>{}:await this.admission.acquire(owner.id,owner.graph.executionPolicy?.maxConcurrentAgents??3,signal,owner.workspaceId)
    let reservation:{id:string;tokens:number}|undefined
    const key=`${run.id}/${record.executionId??record.nodeId}`,group={owner,record,ids:[] as string[],signal,settled:false}
    const settle=(usage:TokenUsage|undefined)=>{
      if(!reservation)return
      if(group.settled){this.settleLateUsage(owner.id,run.id,record.executionId??record.nodeId,group.ids,usage);return}
      group.settled=true;if(this.activeMetering.get(key)===group)this.activeMetering.delete(key)
      if(this.liveRuns.get(owner.id)!==owner||['failed','cancelled','success','interrupted'].includes(owner.status)){this.settleLateUsage(owner.id,run.id,record.executionId??record.nodeId,group.ids,usage);return}
      settleUsageGroup(owner,group.ids,usage)
      const reported=initializeUsage(owner).allocations[reservation.id]?.usage;if(reported!==undefined)record.tokenUsage=(record.tokenUsage??0)+reported
      this.saveRun(owner)
    }
    try{
      signal.throwIfAborted()
      if(this.pauseRequested.has(owner.id)){run.status='paused';throw new HumanPause()}
      reservation=recordUsageCall(owner,agent);group.ids.push(reservation.id);if(agent)this.activeMetering.set(key,group);this.saveRun(owner)
      const beforeModelStep:AgentStepAdmission=(usage,completedCalls)=>{
        signal.throwIfAborted()
        if(group.settled||this.liveRuns.get(owner.id)!==owner)throw new Error('运行用量上下文已结束')
        try{observeAgentUsage(owner,group.ids,usage,completedCalls)}finally{this.saveRun(owner)}
      }
      // Usage observation does not impose an execution Token or output quota.
      return await invoke(settle,undefined,beforeModelStep)
    }finally{
      settle(undefined)
      release()
    }
  }
  /** A provider receipt can arrive after the engine exited or the run ended.
   * Record only trusted reported use, idempotently per allocation, on the
   * current owner state; node and run status are never changed here. */
  private settleLateUsage(ownerId:string,runId:string,executionId:string,ids:string[],usage:TokenUsage|undefined):void{
    if(!usage||!Number.isSafeInteger(usage.totalTokens)||usage.totalTokens<0||!ids.length)return
    try{
      const owner=this.liveRuns.get(ownerId)??this.storage.run(ownerId)
      const allocation=initializeUsage(owner).allocations[ids[0]!]
      if(!allocation||allocation.status==='settled')return
      settleUsageGroup(owner,ids,usage)
      const reported=initializeUsage(owner).allocations[ids[0]!]
      if(reported?.status!=='settled')return
      const target=runId===ownerId?owner:this.liveRuns.get(runId)??this.storage.run(runId)
      const record=target.executions.find(item=>(item.executionId??item.nodeId)===executionId)
      if(record&&reported.usage!==undefined)record.tokenUsage=(record.tokenUsage??0)+reported.usage
      this.saveRun(owner);if(target!==owner)this.saveRun(target)
    }catch{/* Closed storage or a pruned run cannot accept a late receipt. */}
  }
  async supplementAgent(runId:string,executionId:string,taskId:string,text:string,messageId:string,deliver:(authorization:{allocationId:string})=>{nativeMessageId?:string}):Promise<WorkflowRun>{
    if(!/^[A-Za-z0-9_-]{1,160}$/.test(messageId)||!text.trim()||text.length>20_000)throw new Error('补充指令身份无效或内容超过 20000 字符')
    const run=this.liveRuns.get(runId),record=run?.executions.find(item=>(item.executionId??item.nodeId)===executionId)
    if(!run||!record||record.status!=='running')throw new Error('任务已结束，不能向旧任务补充指令')
    if(record.subagentId!==taskId&&!record.repairTaskIds?.includes(taskId))throw new Error('补充指令的任务身份不属于当前节点')
    const prior=record.agentMessages?.find(item=>item.id===messageId)
    if(prior){if(prior.text!==text||prior.taskId!==taskId)throw new Error('消息身份已用于其他补充指令');if(prior.status==='rejected')throw new Error(prior.error??'这条指令未投递');return structuredClone(run)}
    if((record.agentMessages?.length??0)>=20)throw new Error('每个节点最多接收 20 条补充指令')
    const key=`${runId}/${executionId}`,group=this.activeMetering.get(key)
    if(!group||group.settled||this.pauseRequested.has(group.owner.id))throw new Error('当前任务无法接收新的补充指令')
    group.signal.throwIfAborted()
    const deliveryId=randomUUID()
    const message:AgentSupplementMessage={id:messageId,taskId,text,createdAt:now(),status:'accepted',allocationId:deliveryId}
    try{const receipt=deliver({allocationId:deliveryId});message.nativeMessageId=receipt.nativeMessageId}
    catch(error){message.status='rejected';message.error=error instanceof Error?error.message:String(error);(record.agentMessages??=[]).push(message);this.saveRun(group.owner);if(run!==group.owner)this.saveRun(run);throw error}
    ;(record.agentMessages??=[]).push(message);this.saveRun(group.owner);if(run!==group.owner)this.saveRun(run);return structuredClone(run)
  }
  private async verifyRepairEvidence(node:WorkflowNode,run:WorkflowRun,record:NodeExecution,signal:AbortSignal):Promise<void>{
    const requirement=node.config.verification
    if(requirement?.requiredFiles?.length||requirement?.requiredReadFiles?.length||requirement?.requiredChangedFiles?.length){
      if(!this.adapters?.verifyEvidence)throw new Error('当前环境无法验证文件证据')
      await this.adapters.verifyEvidence(node,run.workspaceId,record,signal)
    }else await this.adapters?.verify?.(node,run.workspaceId,signal)
  }
  private repairMode(run:WorkflowRun):'confirm'|'auto'{
    const root=run.rootRunId?this.liveRuns.get(run.rootRunId)??this.storage.run(run.rootRunId):run
    const authorized=root.repairAuthorization?.source==='agent-tool'||root.repairAuthorization?.source==='user-diagnostics'
    return authorized&&root.graph.executionPolicy?.repairMode!=='confirm'&&(run.graph.executionPolicy?.repairMode??'auto')==='auto'?'auto':'confirm'
  }
  private repairLimit(run:WorkflowRun):number{
    const root=run.rootRunId?this.liveRuns.get(run.rootRunId)??this.storage.run(run.rootRunId):run
    return Math.min(2,run.graph.executionPolicy?.maxRepairAttempts??2,root.graph.executionPolicy?.maxRepairAttempts??2)
  }
  private consumeRepairAttempt(run:WorkflowRun,record:NodeExecution):void{
    const used=record.repairAttemptsUsed??record.repair?.usedAttempts??record.repair?.attempts.length??0
    if(used>=this.repairLimit(run))throw new Error('输出修复已达到本次节点的总轮次上限')
    record.repairAttemptsUsed=used+1
    if(record.repair)record.repair.usedAttempts=used+1
    // Persist before dispatch: failure, cancellation or another confirmation cannot reset this ledger.
    this.saveRun(run)
  }
  async confirmRepairOutput(runId:string,executionId:string,expectedAttempts:number):Promise<WorkflowRun>{
    if(this.closed)throw new Error('运行器已关闭')
    const run=this.storage.run(runId),root=run.rootRunId?this.storage.run(run.rootRunId):run
    const record=run.executions.find(item=>(item.executionId??item.nodeId)===executionId),repair=record?.repair
    if(run.status!=='paused'||root.status!=='paused'||this.running.has(run.id)||this.running.has(root.id)||!record||!repair?.waiting)throw new Error('请等待根运行与当前节点暂停完成，再确认输出修复')
    const used=record.repairAttemptsUsed??repair.usedAttempts??repair.attempts.length
    if(!Number.isSafeInteger(expectedAttempts)||expectedAttempts!==used)throw new Error('修复记录已变化，请刷新后重试')
    if(used>=Math.min(repair.limit,this.repairLimit(run)))throw new Error('输出修复已达到本次节点的总轮次上限；请人工修正输出')
    if(!this.adapters)throw new Error('当前宿主没有 Agent 输出修复适配器')
    const node=allNodes(run.graph).find(item=>item.id===record.nodeId)
    if(!node||node.kind!=='agent')throw new Error('当前节点不是可修复的 Agent 输出')
    const related=this.storage.runs().filter(item=>item.id===root.id||item.rootRunId===root.id)
    if(related.some(item=>this.running.has(item.id)))throw new Error('根运行仍有未暂停的任务')
    if(this.running.size+(run===root?1:2)>4)throw new Error('最多同时运行 4 个工作流')
    const controller=new AbortController(),signal=controller.signal,locked=run===root?[run]:[root,run]
    this.repairRoots.add(root.id)
    for(const item of locked){this.pauseRequested.delete(item.id);item.status='running';this.liveRuns.set(item.id,item);this.saveRun(item)}
    record.status='running';this.saveRun(run)
    const done=Promise.resolve().then(async()=>{
      try{
        await this.readinessPreflight?.(run,signal);signal.throwIfAborted()
        const original=record.input?JSON.parse(record.input) as Data:{}
        const data=await this.metered(run,record,signal,true,async(onUsage,_outputLimit,beforeModelStep)=>{
          this.consumeRepairAttempt(run,record)
          return this.adapters!.execute('agent',{
            node,inputs:original,workspaceId:run.workspaceId,runId:run.id,executionId,signal,backend:this.backend,toolConstraints:run.toolConstraints,sessionId:sessionIdOf(run),
            onUsage,beforeModelStep,repairMode:'confirm',repairLimit:this.repairLimit(run),
            outputRepair:{candidate:repair.candidate,error:record.error??'输出未通过验证',attempt:record.repairAttemptsUsed!},
            onTask:id=>{(record.repairTaskIds??=[]).push(id);this.saveRun(run)},
          })
        })
        signal.throwIfAborted()
        const raw=data.json??Object.fromEntries(Object.entries(data).filter(([key])=>!['steps','repair_attempts'].includes(key)))
        const violations=validateJsonSchemaValue(nativeOutputSchema(node.config.outputSchema),raw)
        if(violations.length)throw new Error(`修复输出不符合结构：${violations.join('；')}`)
        if(JSON.stringify(data).length>1_000_000)throw new Error('节点输出超过 1 MB 限制')
        if(node.config.verification?.minTextLength!==undefined&&stringify(data.text??raw).trim().length<node.config.verification.minTextLength)throw new Error('修复输出未达到最小文本长度')
        await this.verifyRepairEvidence(node,run,record,signal)
        signal.throwIfAborted()
        record.data=data;record.output=stringify(data.text??raw);record.status='success';record.endedAt=now();delete record.error
        repair.waiting=false;repair.resolvedAt=now()
        record.verification={status:'passed',reasons:[...(record.verification?.status==='passed'?record.verification.reasons:[]),'用户确认的一次空工具输出修复已通过验证；原 Agent 动作未重放']}
        repair.attempts.push({attempt:record.repairAttemptsUsed,error:'输出修复通过验证'})
        delete run.error
      }catch(error){
        record.status=signal.aborted?'cancelled':'waiting';record.error=error instanceof Error?error.message:String(error)
        if(error instanceof NativeRepairExhaustedError){repair.candidate=error.candidate;repair.attempts.push(...error.attempts);repair.reason=error.reason}
        else {if(error instanceof HumanPause)repair.reason='unavailable';if((record.repairAttemptsUsed??0)>used)repair.attempts.push({attempt:record.repairAttemptsUsed,error:record.error})}
        run.error=record.error
      }finally{
        for(const item of locked)this.releaseRepairLock(item,signal.aborted)
        // The one-shot confirmation does not authorize any successor actions. Root resume is explicit.
        if(signal.aborted)for(const child of related)if(!locked.some(item=>item.id===child.id)&&['paused','waiting','budget_waiting'].includes(child.status))await this.cancel(child.id)
      }
    }).finally(()=>{this.repairRoots.delete(root.id);for(const item of locked){this.running.delete(item.id);this.liveRuns.delete(item.id)}})
    for(const item of locked)this.running.set(item.id,{controller,done})
    void done.catch(()=>{})
    return structuredClone(run)
  }
  private releaseRepairLock(item:WorkflowRun,aborted:boolean):void {
    item.status=aborted?'cancelled':'paused'
    if(aborted){item.error='用户已取消运行';item.endedAt=now();for(const step of item.executions)if(['pending','running','waiting'].includes(step.status))step.status='cancelled'}
    else this.pauseRequested.add(item.id)
    this.saveRun(item)
  }
  async acceptRepairOutput(runId:string,executionId:string,value:unknown):Promise<WorkflowRun>{
    const run=this.storage.run(runId),record=run.executions.find(item=>(item.executionId??item.nodeId)===executionId)
    const root=run.rootRunId?this.storage.run(run.rootRunId):run
    if(run.status!=='paused'||root.status!=='paused'||this.running.has(runId)||this.running.has(root.id)||!record?.repair?.waiting)throw new Error('请等待根运行与验证暂停完成，再修正此节点输出')
    const node=allNodes(run.graph).find(item=>item.id===record.nodeId);if(!node)throw new Error('执行节点不存在')
    const violations=validateJsonSchemaValue(nativeOutputSchema(node.config.outputSchema),value);if(violations.length)throw new Error(`修正输出不符合结构：${violations.join('；')}`)
    const raw=validateObject(value,node.config.outputSchema?.length?node.config.outputSchema:[{name:'text',type:'string',required:true}])
    if(JSON.stringify(raw).length>1_000_000)throw new Error('节点输出超过 1 MB 限制')
    const text=typeof raw.text==='string'?raw.text:JSON.stringify(raw)
    if(node.config.verification?.minTextLength!==undefined&&text.trim().length<node.config.verification.minTextLength)throw new Error('修正输出未达到最小文本长度')
    const expectedState=JSON.stringify(run)
    try{await this.verifyRepairEvidence(node,run,record,new AbortController().signal)}catch(error){
      const current=this.storage.run(runId),currentRoot=run.rootRunId?this.storage.run(run.rootRunId):current
      if(current.status==='paused'&&currentRoot.status==='paused'&&!this.running.has(runId)&&!this.running.has(root.id)&&JSON.stringify(current)===expectedState)this.saveRun(run)
      throw error
    }
    const latest=this.storage.run(runId)
    const latestRoot=run.rootRunId?this.storage.run(run.rootRunId):latest
    if(latest.status!=='paused'||latestRoot.status!=='paused'||this.running.has(runId)||this.running.has(root.id)||JSON.stringify(latest)!==expectedState)throw new Error('暂停记录已变化，请刷新后重试')
    record.data={...structuredClone(raw),text,json:structuredClone(raw)};record.output=text;record.status='success';record.endedAt=now();delete record.error
    record.repair.waiting=false;record.repair.resolvedAt=now()
    record.verification={status:'passed',reasons:[...(record.verification?.status==='passed'?record.verification.reasons:[]),'用户修正输出已通过结构与已配置验证；原 Agent 动作未重放']}
    delete run.error;this.saveRun(run)
    // A child shares its root's live execution context. Keep the corrected child
    // paused until the root resumes and re-enters the existing child invocation.
    return run.rootRunId||run.executions.some(item=>item.repair?.waiting)?structuredClone(run):this.resume(runId)
  }
  private guardHumanCachedText(scope:Scope,run:WorkflowRun,remote:boolean):Scope {
    const read=scope.readCachedBody
    return {
      ...scope,
      guardCachedText:value=>{
        if(remote&&JSON.stringify(this.storage.redactCachedText(run.id,value))!==JSON.stringify(value))throw new CachedBodyError('HTTP 缓存全文不能直接显示在人工节点界面，请先用 HTML 处理节点提取需要的内容')
      },
      readCachedBody:ref=>{if(remote)throw new CachedBodyError('HTTP 缓存全文不能直接显示在人工节点界面，请先用 HTML 处理节点提取需要的内容');return read!(ref)},
    }
  }
  private evaluateBranch(node:WorkflowNode,record:NodeExecution,scope:Scope):Data {
    const c=node.config
    if(c.logicGate){
      const gate=evaluateLogicGate(c.logicGate,value=>resolve(value,scope));const port=gate.result?'true':'false'
      record.input=JSON.stringify({operator:c.logicGate.operator,inputs:gate.inputs,operands:gate.operands});record.selectedPort=port
      return {text:port,result:gate.result,branch:port,inputs:gate.inputs,operands:gate.operands}
    }
    let port='false'
    if(c.cases?.length){for(const branch of c.cases)if(branch.logic==='or'?branch.conditions.some(v=>matches(v,scope)):branch.conditions.every(v=>matches(v,scope))){port=branch.id;break}}
    else port=matches({variable:c.variable!,operator:c.operator??'not_empty',value:c.value},scope)?'true':'false'
    record.input=JSON.stringify(c.cases??{variable:c.variable,operator:c.operator,value:c.value});record.selectedPort=port;return {text:port,result:port==='true',branch:port}
  }
  private enterHumanWait(node:WorkflowNode,record:NodeExecution,run:WorkflowRun,scope:Scope):never {
    const c=node.config
    record.status='waiting';run.status='waiting';run.waitingNodeId=node.id;run.waitingExecutionId=record.executionId??record.nodeId
    run.humanPrompt=render(c.prompt??'',scope);run.humanActions=c.actions??[{id:'continue',label:'继续'}]
    run.missingFields=(c.fields??[]).map(field=>({...field,...(field.defaultValue!==undefined?{defaultValue:render(field.defaultValue,scope)}:{})}))
    run.waitingSince=now();record.input=run.humanPrompt;throw new HumanPause()
  }
  private async executeNode(node:WorkflowNode,record:NodeExecution,run:WorkflowRun,scope:Scope,signal:AbortSignal):Promise<Data> {
    const c=node.config
    // Downstream nodes receive the full cached body (records are redacted on save); only the
    // human form would render it, and that UI can show the preview only, so it must fail clearly.
    scope=this.guardHumanCachedText(scope,run,node.kind==='human')
    if(c.verification?.requiredFiles?.length||c.verification?.requiredReadFiles?.length||c.verification?.requiredChangedFiles?.length){
      if(!this.adapters?.captureEvidence)throw new Error('当前执行环境没有执行前文件证据采集器')
      await this.adapters.captureEvidence(node,run.workspaceId,record,signal)
      this.saveRun(run)
    }
    if(node.kind==='input')return {text:JSON.stringify(scope.input),...scope.input}
    if(node.kind==='if')return this.evaluateBranch(node,record,scope)
    if(node.kind==='human')this.enterHumanWait(node,record,run,scope)
    if(node.kind==='exit_loop'){if(!scope.inLoop)throw new Error('退出循环只能在循环内执行');throw new ExitLoop()}
    if(node.kind==='iteration') {
      const items=listReference(c.iterator!,scope),results:JsonValue[]=new Array(items.length), errors:Data[]=[]
      const iterationController=new AbortController(),iterationSignal=AbortSignal.any([signal,iterationController.signal])
      if(c.parallel&&allNodes(c.body!).some(n=>n.kind==='human'))throw new Error('含人工介入的迭代请使用顺序模式，以保证表单逐项恢复')
      const work=async(index:number)=>{
        const child:Scope={...scope,values:new Map(scope.values),variables:structuredClone(scope.variables),item:items[index]!,index,path:`${record.executionId}[${index}]`,parentNodeId:node.id}
        try {await this.executeGraph(c.body!,run,child,iterationSignal);results[index]=structuredClone(reference(c.outputVariable!,{...child,references:scope.referencePlan?.completedBodies.get(node.id)}))}
        catch(e){if(e instanceof HumanPause||e instanceof ExitLoop||iterationSignal.aborted||c.errorMode==='terminate'||!c.errorMode)throw e;errors.push({index,error:e instanceof Error?e.message:String(e)});results[index]=null}
      }
      try {
        if(c.parallel){
          let next=0,firstError:unknown,exitControl:ExitLoop|undefined,stopped=false
          const workers=Array.from({length:Math.min(c.concurrency??3,items.length)},async()=>{
            while(!stopped&&next<items.length){
              signal.throwIfAborted()
              try{await work(next++)}catch(error){
                stopped=true
                if(error instanceof HumanPause){firstError??=error}else{if(!firstError||firstError instanceof HumanPause)firstError=error;if(error instanceof ExitLoop)exitControl=error;iterationController.abort(error)}
                throw error
              }
            }
          })
          await Promise.allSettled(workers)
          signal.throwIfAborted()
          if(exitControl)throw exitControl
          if(firstError)throw firstError
        } else for(let i=0;i<items.length;i++)await work(i)
      }catch(error){
        if(error instanceof ExitLoop){
          // A deliberate loop exit may abort other item graphs. Their callbacks
          // are settled above; keep completed effects, close unfinished states.
          const prefix=`${record.executionId??node.id}[`
          for(const step of run.executions)if((step.executionId??step.nodeId).startsWith(prefix)&&['running','pending'].includes(step.status)){
            step.status=step.status==='running'?'cancelled':'skipped';step.error=undefined;step.endedAt=now()
          }
        }
        throw error
      }
      const failedIndices=new Set(errors.map(e=>e.index)),result=c.errorMode==='remove'?results.filter((_r,i)=>!failedIndices.has(i)):results
      return {text:JSON.stringify(result),result,json:result,errors}
    }
    if(node.kind==='loop') {
      const vars={...scope.variables,...mapping(c.initialVariables,scope)};let last:Scope|undefined,count=0
      for(let i=0;i<(c.maxIterations??10);i++){
        signal.throwIfAborted()
        const child:Scope={...scope,values:new Map(scope.values),variables:vars,index:i,path:`${record.executionId}[${i}]`,parentNodeId:node.id,inLoop:true}
        last={...child,references:scope.referencePlan?.completedBodies.get(node.id)};count=i+1
        try{await this.executeGraph(c.body!,run,child,signal)}catch(e){if(e instanceof ExitLoop)break;throw e}
        if(c.until&&matches(c.until,last))break
      }
      const result=c.outputVariable&&last?reference(c.outputVariable,last):vars
      return {text:stringify(result),result,variables:vars,iterations:count,json:result}
    }
    if(node.kind==='aggregator') {
      const result=aggregateGroups(c.groups??[],scope)
      return {...result,text:typeof Object.values(result)[0]==='string'?Object.values(result)[0]!:JSON.stringify(result),json:result}
    }
    if(node.kind==='assigner') {
      const changed:Data={}
      for(const assignment of c.assignments??[]){
        const old=scope.variables[assignment.name],value=assignment.value===undefined?null:resolve(assignment.value,scope)
        const next=assignedValue(assignment.operation,old,value)
        scope.variables[assignment.name]=structuredClone(next);changed[assignment.name]=next
        if(scope.references)scope.references=withReferenceVariables(scope.references,[assignment.name])
      }
      return {...changed,variables:changed,text:JSON.stringify(changed),json:changed}
    }
    if(node.kind==='list') {
      let result=listReference(c.listSource!,scope)
      if(c.filter)result=result.filter((item,index)=>matches(c.filter!,{...scope,item,index,references:scope.references?{...scope.references,hasItem:true,hasIndex:true}:undefined}))
      if(c.sort)result=sortedList(result,c.sort)
      if(c.limit!==undefined)result=result.slice(0,c.limit)
      return {text:JSON.stringify(result),result,first_record:result[0]??null,last_record:result.at(-1)??null,json:result}
    }
    const htmlHandle=node.kind==='tool'&&isHtmlTool(c.toolId??'')&&typeof c.inputs?.html==='string'&&/^\{\{\s*[^{}]+?\s*\}\}$/.test(c.inputs.html)
      ?referenceRaw(c.inputs.html,{...scope,readCachedBody:undefined}):undefined
    const inputs:Data=isCachedBody(htmlHandle)
      ?{...mapping(Object.fromEntries(Object.entries(c.inputs??{}).filter(([key])=>key!=='html')),scope),html:htmlHandle}
      :mapping(c.inputs,scope)
    if(node.kind==='template'||node.kind==='output') {
      const local={...scope,input:{...scope.input,...inputs}}
      const text=node.kind==='template'
        ?renderDataTemplate(c.text??'',name=>{const [key,...path]=name.split('.');return own(inputs,key!)?pathValue(inputs[key!]!,path):reference(name,local)})
        :render(c.text??'',local)
      record.input=text;return {text}
    }
    if(['llm','classifier','extractor'].includes(node.kind)) {
      const prompt=render(c.prompt??'',{...scope,input:{...scope.input,...inputs}})
      let system=record.rolePrompt??''
      if(node.kind==='classifier')system+=`\nClassify the input into exactly one category. Return only JSON {"class_id":"ID"}. Categories: ${JSON.stringify(c.classes)}`
      if(node.kind==='extractor')system+=`\nExtract these parameters, return only a JSON object. Never invent missing values. Parameters: ${JSON.stringify(c.parameters)}`
      if(node.kind==='llm'&&c.outputSchema?.length)system+=`\nReturn only a JSON object matching fields: ${JSON.stringify(c.outputSchema)}`
      record.input=prompt;record.tokenEstimate=await this.graphon.countTokens(system+'\n'+prompt,signal);signal.throwIfAborted();this.saveRun(run)
      const text=await this.metered(run,record,signal,false,onUsage=>this.backend.generate({model:c.model!,effort:c.effort,prompt,system,signal,onUsage}))
      signal.throwIfAborted()
      if(node.kind==='classifier'){
        const category=classifiedCategory(text,c.classes);record.selectedPort=category.id
        return {text:category.label,class_id:category.id,class_label:category.label,class_name:category.description??category.label}
      }
      if(node.kind==='extractor'){
        try{const data=validateObject(parseJson(text),c.parameters??[]);return {...data,text,json:data,__is_success:1,__reason:''}}
        catch(e){return {text,__is_success:0,__reason:e instanceof Error?e.message:String(e)}}
      }
      if(c.outputSchema?.length){const data=validateObject(parseJson(text),c.outputSchema);return {...data,text,json:data}}
      return {text}
    }
    if(!this.adapters)throw new Error(`节点 ${node.title} 的执行适配器尚未配置`)
    this.renderAdapterInputs(node,inputs,scope)
    record.input=JSON.stringify(node.kind==='http'?(c.credentialOperation?{credentialOperation:c.credentialOperation}:{url:inputs.url,method:c.method}):inputs);this.saveRun(run)
    const request=this.adapterRequest(node,record,run,inputs,signal)
    const data=node.kind==='agent'
      ?await this.metered(run,record,signal,true,(onUsage,_outputLimit,beforeModelStep)=>this.adapters!.execute('agent',{...request,onUsage,beforeModelStep}))
      :await this.adapters.execute(node.kind as AdapterNodeKind,request)
    if(c.outputSchema?.length)validateObject(data,c.outputSchema)
    return data
  }
  private renderAdapterInputs(node:WorkflowNode,inputs:Data,scope:Scope):void {
    const c=node.config
    if(node.kind==='agent'||(node.kind==='document'&&c.documentMode==='agent'))inputs.prompt=render(c.prompt??'',scope)
    if(node.kind==='knowledge')inputs.query=render(c.query??'',scope)
    if(node.kind==='document'){try{inputs.source=reference(c.source??'',scope)}catch(e){if(c.source?.includes('{{'))inputs.source=resolve(c.source,scope);else inputs.source=c.source??''}}
    if(node.kind==='http'&&!c.credentialOperation){
      inputs.url=render(c.url??'',scope);inputs.body=render(c.bodyText??'',scope)
      inputs.headers=Object.fromEntries(Object.entries(c.headers??{}).map(([k,v])=>[k,render(v,scope)]))
    }
  }
  private adapterRequest(node:WorkflowNode,record:NodeExecution,run:WorkflowRun,inputs:Data,signal:AbortSignal):AdapterRequest {
    const request:AdapterRequest={
      readCachedBody:ref=>this.storage.readCachedBody(run.id,ref),
      cacheHttpBody:(bytes,type)=>this.storage.cacheHttpBody(run.id,node.id,record.attempt??1,bytes,type),
      node,inputs,workspaceId:run.workspaceId,runId:run.id,executionId:record.executionId??node.id,signal,
      backend:{generate:async request=>{
        record.tokenEstimate=await this.graphon.countTokens(request.system+"\n"+request.prompt,request.signal);request.signal.throwIfAborted();this.saveRun(run)
        return this.metered(run,record,request.signal,false,(onUsage)=>this.backend.generate({...request,onUsage:value=>{onUsage(value);request.onUsage?.(value)}}))
      }},
      rolePrompt:record.rolePrompt,sessionId:sessionIdOf(run),toolConstraints:run.toolConstraints,childRunId:record.childRunId,
      onChild:id=>{record.childRunId=id;this.saveRun(run)},
      onTaskEvent:event=>{
        if(this.liveRuns.get(run.id)!==run||['failed','cancelled','success','interrupted'].includes(run.status))return
        const events=record.agentEvents??=[];if(events.some(item=>item.id===event.id))return
        events.push({...event,summary:event.summary.slice(0,2000)});if(events.length>120)events.splice(0,events.length-120)
        this.saveRun(run)
      },
      onTask:taskId=>{if(!record.subagentId)record.subagentId=taskId;else (record.repairTaskIds??=[]).push(taskId);this.saveRun(run)},
      repairMode:this.repairMode(run),repairLimit:this.repairLimit(run),
      withRepairUsage:invoke=>this.metered(run,record,signal,true,(onUsage,tokens,beforeModelStep)=>{this.consumeRepairAttempt(run,record);return invoke(onUsage,tokens,beforeModelStep)},true),
    }
    if(record.fileEvidence){
      request.fileEvidence=record.fileEvidence
      request.onFileReadEvidence=receipts=>{
        if(this.liveRuns.get(run.id)!==run||!record.fileEvidence)return
        record.fileEvidence.reads=structuredClone(receipts.filter(receipt=>receipt.taskId===record.subagentId).slice(0,90))
        this.saveRun(run)
      }
    }
    return request
  }
  async cancel(id:string):Promise<WorkflowRun> {
    const run=this.storage.run(id),task=this.running.get(id)
    if(!task){
      const children=this.storage.runs().filter(child=>child.rootRunId===id&&UNFINISHED_RUN_STATUSES.includes(child.status))
      await Promise.all(children.map(child=>this.cancel(child.id)))
    }
    if(task){task.controller.abort(new Error('用户取消'));await task.done;this.pauseRequested.delete(id);return this.storage.run(id)}
    if(['waiting','paused','pausing','budget_waiting'].includes(run.status))this.cancelIdleRun(run)
    this.pauseRequested.delete(id)
    return this.storage.run(id)
  }
  private cancelIdleRun(run:WorkflowRun):void {
    run.status='cancelled';run.error='用户已取消运行';run.endedAt=now();this.clearWaiting(run)
    for(const rec of run.executions)if(['pending','waiting','running'].includes(rec.status))rec.status='cancelled'
    this.saveRun(run)
  }
  async pause(id:string):Promise<WorkflowRun>{
    const run=this.liveRuns.get(id)??this.storage.run(id)
    if(!['running','pausing'].includes(run.status))throw new Error('只有执行中的运行可以暂停')
    this.pauseRequested.add(id);run.status='pausing';this.saveRun(run)
    return structuredClone(run)
  }
  resume(id:string):WorkflowRun{
    const run=this.storage.run(id)
    if(this.repairRoots.has(run.rootRunId??id))throw new Error('根运行正在执行已确认的输出修复，请等待修复完成')
    if(!['paused','budget_waiting'].includes(run.status)||this.running.has(id))throw new Error('运行尚未暂停完成或不能继续')
    if(this.closed)throw new Error('运行器已关闭')
    // A child continues only when its live parent re-enters the same invocation;
    // a direct resume would bypass root coordination and pause/repair state.
    if(run.rootRunId&&!this.childInvocationLive(id))throw new Error('子工作流须由所属根运行继续，不能单独恢复')
    // An execution still marked running was interrupted mid-action; continuing
    // would replay it. Recovery review decides whether that action is redone.
    if(run.executions.some(record=>record.status==='running'))throw new Error('运行含有中断时仍在执行的节点，不能直接继续；请通过恢复计划核对后再重做')
    if(run.executions.some(record=>record.repair?.waiting)||this.storage.runs().some(child=>child.rootRunId===id&&child.executions.some(record=>record.repair?.waiting))){
      throw new Error('请先处理验证暂停的输出；继续不会重新执行原 Agent 动作')
    }
    if(this.running.size>=4)throw new Error('最多同时运行 4 个工作流')
    this.pauseRequested.delete(id);run.status='running';delete run.error;delete run.endedAt
    for(const rec of run.executions)if(rec.status==='pending')delete rec.error
    this.saveRun(run);this.launch(run);return structuredClone(run)
  }
  private childInvocationLive(id:string):boolean {
    return [...this.liveRuns.values()].some(parent=>parent.status==='running'&&this.running.has(parent.id)&&parent.executions.some(record=>record.childRunId===id&&record.status==='running'))
  }
  private prepareRunRevision(id:string,value:unknown,freezeTools?:RunStartOptions['freezeTools']){
    const source=this.storage.run(id)
    this.assertRevisable(id,source)
    const candidate=parseWorkflow(value)
    if(candidate.id!==source.workflowId||candidate.workspaceId!==source.workspaceId)throw new Error('运行修订不能改变流程和工作区身份')
    protectFixedNodes(source.graph,candidate)
    const snapshot=this.prepareSnapshot(candidate,source.modelDefaults,{freezeTools,sessionId:sessionIdOf(source)})
    const inputs=this.prepareInputs(snapshot.graph.nodes.find(node=>node.kind==='input')?.config.fields??[],source.inputs)
    if(JSON.stringify(inputs)!==JSON.stringify(source.inputs))throw new Error('本次运行修订须保留已有输入；更改输入请创建新运行')
    if(snapshot.graph.nodes.find(node=>node.kind==='input')?.config.fields?.some(field=>field.required&&!inputs[field.name]?.trim()))throw new Error('修订后的必填输入未配置，请创建新运行')
    const context={
      rolePrompts:snapshot.rolePrompts,dependencySnapshots:snapshot.dependencySnapshots,dependencyRolePrompts:snapshot.dependencyRolePrompts,environment:snapshot.environment,
      toolConstraints:snapshot.toolConstraints,modelDefaults:source.modelDefaults,inputs:source.inputs,systemVariables:source.systemVariables,
    }
    const plan=buildRecoveryPlan(source,'resume',snapshot.graph,context)
    const changes=this.revisionChanges(source,snapshot)
    const oldContext={
      rolePrompts:source.rolePrompts??{},dependencySnapshots:source.dependencySnapshots??{},dependencyRolePrompts:source.dependencyRolePrompts??{},
      environment:source.environment??environmentSnapshot(source.graph,!!this.adapters?.secretPreflight),
      toolConstraints:source.toolConstraints,modelDefaults:source.modelDefaults,inputs:source.inputs,systemVariables:source.systemVariables,
    }
    if(workflowSemanticDigest(source.graph,oldContext)===workflowSemanticDigest(snapshot.graph,context)){plan.allowed=false;plan.blockedReasons.push('执行语义未变化；名称、布局或便签修改无需建立运行修订')}
    const preview:WorkflowRunRevisionPlan={...plan,baseRevision:source.activeRevision??1,targetRevision:(source.activeRevision??1)+1,changes}
    return {source,snapshot,preview}
  }
  private assertRevisable(id:string,source:WorkflowRun):void {
    if(source.status!=='paused'||this.running.has(id)||source.rootRunId)throw new Error('仅已排空在途任务的根运行可以建立修订')
    if(source.executions.some(record=>record.repair?.waiting)||this.storage.runs().some(child=>child.rootRunId===id&&UNFINISHED_RUN_STATUSES.includes(child.status))){
      throw new Error('请先处理待验证输出或子工作流，再修改本次运行')
    }
    if((source.revisionHistory?.length??0)>=20)throw new Error('本次运行已达到 20 次修订上限')
  }
  private revisionChanges(source:WorkflowRun,snapshot:ReturnType<WorkflowRuntime['prepareSnapshot']>):WorkflowRunRevisionPlan['changes'] {
    const oldNodes=new Map(allNodes(source.graph).map(node=>[node.id,node])),newNodes=new Map(allNodes(snapshot.graph).map(node=>[node.id,node]))
    const changes:WorkflowRunRevisionPlan['changes']=[]
    for(const nodeId of new Set([...oldNodes.keys(),...newNodes.keys()])){
      const old=oldNodes.get(nodeId),next=newNodes.get(nodeId)
      const before=old?JSON.parse(JSON.stringify({kind:old.kind,config:old.config})):null,after=next?JSON.parse(JSON.stringify({kind:next.kind,config:next.config})):null
      if(JSON.stringify(before)!==JSON.stringify(after))changes.push({nodeId,title:next?.title??old?.title??nodeId,before,after})
    }
    const beforeContext={
      edges:source.graph.edges,environment:source.environment??{},rolePrompts:source.rolePrompts??{},toolConstraints:source.toolConstraints??{},
      policy:activeExecutionPolicy(source.graph.executionPolicy),
    }
    const afterContext={
      edges:snapshot.graph.edges,environment:snapshot.environment,rolePrompts:snapshot.rolePrompts,toolConstraints:snapshot.toolConstraints??{},
      policy:activeExecutionPolicy(snapshot.graph.executionPolicy),
    }
    if(JSON.stringify(beforeContext)!==JSON.stringify(afterContext)){
      changes.push({nodeId:'$context',title:'连线、变量、角色与执行策略',before:JSON.parse(JSON.stringify(beforeContext)),after:JSON.parse(JSON.stringify(afterContext))})
    }
    return changes
  }
  previewRunRevision(id:string,value:unknown,freezeTools?:RunStartOptions['freezeTools']):WorkflowRunRevisionPlan{return this.prepareRunRevision(id,value,freezeTools).preview}
  applyRunRevision(id:string,value:unknown,planDigest:string,freezeTools?:RunStartOptions['freezeTools']):WorkflowRun{
    const {source,snapshot,preview}=this.prepareRunRevision(id,value,freezeTools)
    if(!planDigest||preview.planDigest!==planDigest)throw new Error('运行修订预览已变化，请重新确认差异与失效范围')
    if(!preview.allowed)throw new Error(preview.blockedReasons.join('；'))
    const archived={
      revision:source.activeRevision??1,capturedAt:now(),sourceRevision:source.sourceRevision,graph:structuredClone(source.graph),executions:structuredClone(source.executions),
      environment:source.environment,rolePrompts:source.rolePrompts,toolConstraints:source.toolConstraints,dependencySnapshots:source.dependencySnapshots,
      dependencyRolePrompts:source.dependencyRolePrompts,snapshotDigest:source.snapshotDigest,
    }
    const reusable=new Set(preview.items.filter(item=>item.action==='reuse').map(item=>item.executionId))
    const cached=source.executions.filter(record=>reusable.has(record.executionId??record.nodeId)&&record.status==='success'&&record.data).map(record=>({...structuredClone(record),reusedAtRevision:preview.targetRevision}))
    const keys=new Set(cached.map(record=>record.executionId??record.nodeId))
    const pending=snapshot.graph.nodes.filter(node=>!keys.has(node.id)).map(node=>({...this.record(node,node.id,snapshot.rolePrompts),runRevision:preview.targetRevision}))
    source.revisionHistory=[...(source.revisionHistory??[]),archived];source.activeRevision=preview.targetRevision;Object.assign(source,snapshot)
    source.sourceRevision=snapshot.graph.revision;source.executions=[...pending,...cached];source.outputs={};delete source.error
    source.snapshotDigest=workflowSemanticDigest(source.graph,{
      rolePrompts:source.rolePrompts,dependencySnapshots:source.dependencySnapshots,dependencyRolePrompts:source.dependencyRolePrompts,environment:source.environment,
      toolConstraints:source.toolConstraints,modelDefaults:source.modelDefaults,inputs:source.inputs,systemVariables:source.systemVariables,engine:source.engine,
    })
    this.saveRun(source);return structuredClone(source)
  }
  /**
   * T37: rerun the changed pure nodes of a candidate graph, and the pure nodes that read them, on one finished
   * run's recorded outputs. Nothing is saved. A node with effects or model calls is not run; its readers stop there.
   */
  async replay(source:WorkflowRun,graph:Workflow,changed:ReadonlySet<string>,signal:AbortSignal):Promise<WorkflowReplayStep[]>{
    const run:WorkflowRun={...structuredClone(source),graph,executions:[]};this.detached.add(run)
    const values:Values=new Map(source.executions.flatMap(record=>(record.executionId??record.nodeId)===record.nodeId&&record.status==='success'&&record.data?[[record.nodeId,structuredClone(record.data)] as const]:[]))
    const scope:Scope={readCachedBody:ref=>this.storage.readCachedBody(source.id,ref).toString('utf8'),values,variables:{},
      input:typedInputs(graph.nodes.find(node=>node.kind==='input')?.config.fields??[],source.inputs),environment:source.environment,system:source.systemVariables,path:''}
    const top=new Set(graph.nodes.map(node=>node.id)),steps:WorkflowReplayStep[]=[],affected=new Set<string>(),stopped=new Set<string>()
    for(const node of allNodes(graph))if(changed.has(node.id)&&!top.has(node.id))steps.push({nodeId:node.id,title:node.title,kind:node.kind,status:'not-replayed',reason:'容器内节点按项执行，接受后运行时验证'})
    for(const node of topologicalNodes(graph)){
      const sources=dataSources(graph,node).filter(id=>top.has(id))
      if(!changed.has(node.id)&&!sources.some(id=>affected.has(id)))continue
      affected.add(node.id);values.delete(node.id)
      const step={nodeId:node.id,title:node.title,kind:node.kind}
      // A reader of a node that did not run cannot run either; only the change itself is listed.
      if(!changed.has(node.id)&&sources.some(id=>stopped.has(id))){stopped.add(node.id);continue}
      if(!REPLAY_KINDS.has(node.kind)){stopped.add(node.id);steps.push({...step,status:'not-replayed',reason:'有副作用或需要模型，回放到此为止，接受后运行时执行'});continue}
      const missing=sources.filter(id=>!values.has(id))
      if(missing.length){stopped.add(node.id);steps.push({...step,status:'not-replayed',reason:'上游没有可用结果：'+missing.map(id=>graph.nodes.find(item=>item.id===id)?.title??id).join('、')});continue}
      try{
        const data=await this.executeNode(node,this.record(node,node.id,{},scope),run,scope,signal)
        values.set(node.id,data);steps.push({...step,status:'success',output:sampleValue(data)})
      }catch(error){signal.throwIfAborted();stopped.add(node.id);steps.push({...step,status:'failed',error:error instanceof Error?error.message:String(error)})}
    }
    return steps
  }
  recoveryPlan(id:string,review?:unknown){return reviewedRecovery(this.storage.run(id),review).plan}
  /** Retained confirmation receipts remain readable even after their source history expires. */
  recoveryReceipt(id:string,mode:'resume'|'rerun',sessionId?:string,planDigest?:string,review?:unknown,requestId?:string):WorkflowRun|undefined{
    const prior=requestId===undefined?undefined:this.requests.find(requestId,sessionId,run=>run.sourceRunId===id)
    return prior?this.requestRun(requestId,prior.workspaceId,sessionId,{operation:'recover',id,mode,planDigest,review}):undefined
  }
  recover(id:string,mode:'resume'|'rerun',sessionId?:string,planDigest?:string,review?:unknown,requestId?:string):WorkflowRun{
    const retained=this.recoveryReceipt(id,mode,sessionId,planDigest,review,requestId)
    if(retained)return retained
    const original=this.storage.run(id),requestParameters={operation:'recover',id,mode,planDigest,review}
    const prior=this.requestRun(requestId,original.workspaceId,sessionId,requestParameters)
    if(prior)return prior
    const reviewed=mode==='resume'?reviewedRecovery(original,review):undefined,source=reviewed?.source??original
    if(UNFINISHED_RUN_STATUSES.includes(source.status))throw new Error('请先结束当前运行，暂停的运行请使用继续')
    if(mode==='rerun'&&review!==undefined)throw new Error('外部动作核验仅用于恢复计划')
    const plan=reviewed?.plan??buildRecoveryPlan(source,mode)
    if(planDigest&&planDigest!==plan.planDigest)throw new Error('恢复预览已过期，请重新查看复用与重做原因')
    if(!plan.allowed)throw new Error(plan.blockedReasons.join('；'))
    const raw=this.rematerializeAttachments(source)
    if(source.rootRunId)throw new Error('子工作流必须从所属根运行恢复，避免重放外部动作')
    return this.startPrepared(source.workflowId,raw,source.modelDefaults,{
      requestId,requestParameters,sourceGraph:source.graph,sourceRunId:source.id,sessionId,toolConstraints:source.toolConstraints,rolePrompts:source.rolePrompts,
      dependencySnapshots:source.dependencySnapshots??{},dependencyRolePrompts:source.dependencyRolePrompts??{},
    },run=>{
      if(reviewed?.review)run.recoveryReview={...structuredClone(reviewed.review),confirmedAt:now(),sourceRunId:original.id}
      if(mode==='resume'){
        const reusable=new Set(plan.items.filter(item=>item.action==='reuse').map(item=>item.executionId))
        const cached=source.executions.filter(record=>reusable.has(record.executionId??record.nodeId)&&record.status==='success'&&record.data).map(record=>({...structuredClone(record),reusedFromRunId:source.id}))
        const keys=new Set(cached.map(record=>record.executionId??record.nodeId))
        run.executions=[...run.executions.filter(record=>!keys.has(record.executionId??record.nodeId)),...cached]
      }
    })
  }
  /** Attachments remain owned by the source run; rematerialize validated bytes into the new run. */
  private rematerializeAttachments(source:WorkflowRun):Record<string,string> {
    const raw={...source.inputs}
    for(const field of source.graph.nodes.find(n=>n.kind==='input')?.config.fields??[])if(['file','files'].includes(field.type??'')&&raw[field.name]){
      const value=JSON.parse(raw[field.name]!),files=field.type==='files'?value:[value]
      raw[field.name]=JSON.stringify((field.type==='files'
        ?files.map((f:any)=>f.workflowFileId?this.storage.readAttachment(source.id,f.workflowFileId):f)
        :files[0]?.workflowFileId?this.storage.readAttachment(source.id,files[0].workflowFileId):files[0]))
    }
    return raw
  }
  async settle(id:string):Promise<WorkflowRun>{await this.running.get(id)?.done;return this.storage.run(id)}
  async close():Promise<void>{
    this.closed=true;for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear()
    const tasks=[...this.running.values()];for(const t of tasks)t.controller.abort(new Error('插件正在卸载'))
    await Promise.allSettled(tasks.map(t=>t.done));await this.graphon.close();this.storage.close()
  }
}
