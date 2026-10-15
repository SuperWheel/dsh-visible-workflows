import { randomUUID } from 'node:crypto'
import type { Condition, InputField, JsonValue, ModelRef, NodeExecution, NodeGraph, ParameterField, Workflow, WorkflowModelDefaults, WorkflowNode, WorkflowRun } from '../shared/types.ts'
import { WorkflowStorage } from './storage.ts'
import { renderDataTemplate } from './template.ts'
import { allNodes, assertGraph, inputsSchema } from './validation.ts'
import { applyModelDefaults } from './model-defaults.ts'
import { GraphonBridge, graphonRuntimeDirectory } from './graphon.ts'

export interface ModelRequest { model: ModelRef; effort?: string; prompt: string; system: string; signal: AbortSignal }
export interface ModelBackend { generate(request: ModelRequest): Promise<string> }
export type AdapterNodeKind = 'agent' | 'knowledge' | 'code' | 'document' | 'http' | 'tool'
export interface AdapterRequest { node: WorkflowNode; inputs: Record<string,JsonValue>; workspaceId: string; runId: string; signal: AbortSignal; backend: ModelBackend; rolePrompt?: string }
export interface ExecutionAdapters { execute(kind: AdapterNodeKind, request: AdapterRequest): Promise<Record<string,JsonValue>> }
type Data = Record<string,JsonValue>
type Values = Map<string, Data>
interface Scope { values: Values; variables: Data; input: Data; item?: JsonValue; index?: number; path: string; parentNodeId?: string; inLoop?: boolean }
const now = () => new Date().toISOString()
const own = (value: object,key:string) => Object.prototype.hasOwnProperty.call(value,key)
const forbidden = new Set(['__proto__','prototype','constructor'])
const stringify = (value: JsonValue): string => typeof value === 'string' ? value : JSON.stringify(value)
class MissingValue extends Error {}
class HumanPause extends Error {}
class ExitLoop extends Error {}

function pathValue(value: JsonValue, path: string[]): JsonValue {
  for(const part of path) {
    if(forbidden.has(part)||value===null||typeof value!=='object'||!own(value,part)) throw new MissingValue(`变量字段 ${path.join('.')} 不存在`)
    value=(value as Record<string,JsonValue>)[part]!
  }
  return value
}
function reference(name:string,scope:Scope):JsonValue {
  const key=name.trim().replace(/^\{\{\s*|\s*\}\}$/g,''), [head,...rest]=key.split('.')
  if(head==='item') {if(scope.item===undefined)throw new MissingValue('item 仅在迭代子流程可用');return pathValue(scope.item,rest)}
  if(head==='index') {if(scope.index===undefined)throw new MissingValue('index 仅在容器子流程可用');return pathValue(scope.index,rest)}
  if(head==='input') return pathValue(scope.input,rest)
  if(head==='vars') return pathValue(scope.variables,rest)
  const data=scope.values.get(head!)
  if(!data) throw new MissingValue(`节点变量 ${key} 不存在或尚未产生结果（可能被条件跳过），请使用稳定节点 ID`)
  if(!rest.length)return data
  if(rest[0]==='json'&&!own(data,'json'))return pathValue(data,rest.slice(1))
  return pathValue(data,rest)
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

/** Backward-compatible plain interpolation; runtime uses typed values internally. */
export function renderTemplate(template:string,run:WorkflowRun,values:Map<string,string>):string {
  return render(template,{values:new Map([...values].map(([id,text])=>[id,{text}])),variables:{},input:run.inputs,path:''})
}

/** One executor serves UI buttons and Agent tools; successful steps are never replayed when Human Input resumes. */
export class WorkflowRuntime {
  private running=new Map<string,{controller:AbortController;done:Promise<void>}>()
  private timers=new Map<string,ReturnType<typeof setTimeout>>()
  private closed=false
  private readonly graphon: GraphonBridge
  constructor(readonly storage:WorkflowStorage,private backend:ModelBackend,private adapters?:ExecutionAdapters) {
    this.graphon = new GraphonBridge(graphonRuntimeDirectory(storage.directory))
    for(const run of storage.runs())if(run.status==='waiting'&&run.waitingNodeId)this.armTimeout(run)
  }
  start(id:string,rawInputs:unknown,modelDefaults?:WorkflowModelDefaults):WorkflowRun {
    if(this.closed)throw new Error('运行器已关闭')
    if(this.running.size>=4)throw new Error('最多同时运行 4 个工作流，请等待当前任务结束')
    if(this.storage.runs().some(r=>r.workflowId===id&&['running','waiting'].includes(r.status)))throw new Error('此工作流已有未结束的运行，请查看或取消后再启动')
    const graph=this.storage.get(id);applyModelDefaults(graph,modelDefaults);assertGraph(graph,true)
    const runId=randomUUID(),inputs=this.prepareInputs(graph.nodes.find(n=>n.kind==='input')?.config.fields??[],rawInputs,runId)
    const presets=this.storage.presets(),rolePrompts:Record<string,string>={}
    for(const n of allNodes(graph))if(n.config.rolePresetId){const p=presets.find(p=>p.id===n.config.rolePresetId);if(!p)throw new Error(`节点 ${n.number} 的角色预设不存在`);rolePrompts[n.id]=p.prompt}
    const run:WorkflowRun={engine:this.graphon.engine,id:runId,workflowId:graph.id,workspaceId:graph.workspaceId,workflowTitle:graph.title,sourceRevision:graph.revision,graph,status:'waiting',inputs,outputs:{},startedAt:now(),rolePrompts,...(modelDefaults?{modelDefaults:structuredClone(modelDefaults)}:{}),executions:graph.nodes.map(n=>this.record(n,n.id,rolePrompts))}
    this.checkInputs(run);this.storage.saveRun(run)
    if(!run.missingFields?.length)this.launch(run)
    return structuredClone(run)
  }
  private record(node:WorkflowNode,id:string,prompts:Record<string,string>,scope?:Scope):NodeExecution {
    return {nodeId:node.id,executionId:id,number:node.number,title:node.title,status:'pending',model:node.config.model,effort:node.config.effort,rolePrompt:prompts[node.id]??'',...(scope?.parentNodeId?{parentNodeId:scope.parentNodeId,iteration:scope.index}:{})}
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
    const run=this.storage.run(id)
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
      this.clearWaiting(run);run.status='running';this.storage.saveRun(run);this.launch(run)
    } else {
      run.inputs=this.prepareInputs(run.graph.nodes.find(n=>n.kind==='input')?.config.fields??[],{...run.inputs,...answer},run.id)
      this.checkInputs(run);this.storage.saveRun(run);if(!run.missingFields?.length)this.launch(run)
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
      const latest=this.storage.run(run.id);if(latest.status!=='waiting'||latest.waitingExecutionId!==run.waitingExecutionId)return
      if(wait>2147483647){this.armTimeout(latest);return}
      const rec=latest.executions.find(e=>(e.executionId??e.nodeId)===latest.waitingExecutionId)!
      const containing=(graph:NodeGraph):NodeGraph|undefined=>graph.nodes.some(n=>n.id===latest.waitingNodeId)?graph:graph.nodes.map(n=>n.config.body?containing(n.config.body):undefined).find(Boolean)
      const graph=containing(latest.graph),hasTimeout=graph?.edges.some(e=>e.source===latest.waitingNodeId&&e.port==='timeout')
      rec.endedAt=now()
      if(hasTimeout){rec.status='success';rec.selectedPort='timeout';rec.data={text:'人工介入等待超时',__action_id:'timeout',__action_value:'超时',__rendered_content:latest.humanPrompt??''};rec.output='人工介入等待超时';this.clearWaiting(latest);latest.status='running';this.storage.saveRun(latest);this.launch(latest)}
      else {rec.status='failed';rec.error='人工介入等待超时';latest.status='failed';latest.error=rec.error;latest.endedAt=now();this.clearWaiting(latest);for(const pending of latest.executions)if(pending.status==='pending')pending.status='skipped';this.storage.saveRun(latest)}
    },Math.min(wait,2147483647));timer.unref?.();this.timers.set(run.id,timer)
  }
  private launch(run:WorkflowRun):void {
    const controller=new AbortController()
    const done=Promise.resolve().then(()=>this.execute(run,controller.signal)).finally(()=>this.running.delete(run.id))
    this.running.set(run.id,{controller,done});void done.catch(()=>{})
  }
  private async execute(run:WorkflowRun,signal:AbortSignal):Promise<void> {
    const fields=run.graph.nodes.find(n=>n.kind==='input')?.config.fields??[]
    try {
      const scope:Scope={values:new Map(),variables:{},input:typedInputs(fields,run.inputs),path:''}
      run.outputs={};await this.executeGraph(run.graph,run,scope,signal)
      run.status='success';run.endedAt=now();this.storage.saveRun(run)
    }catch(error){
      if(error instanceof HumanPause){this.storage.saveRun(run);this.armTimeout(run);return}
      run.status=signal.aborted?'cancelled':'failed';run.error=signal.aborted?'用户已取消运行':error instanceof Error?error.message:String(error);run.endedAt=now()
      for(const rec of run.executions){if(rec.status==='running'){rec.status=signal.aborted?'cancelled':'failed';rec.error??=run.error;rec.endedAt=run.endedAt}else if(rec.status==='pending')rec.status=signal.aborted?'cancelled':'skipped'}
      this.storage.saveRun(run)
    }
  }
  private async executeGraph(graph:NodeGraph,run:WorkflowRun,scope:Scope,signal:AbortSignal):Promise<void> {
    const nodes=new Map(graph.nodes.map(node=>[node.id,node]))
    const recordFor=(node:WorkflowNode)=>{
      const executionId=scope.path?`${scope.path}/${node.id}`:node.id
      let record=run.executions.find(e=>(e.executionId??e.nodeId)===executionId)
      if(!record){if(run.executions.length>=5000)throw new Error('本次运行超过 5000 个节点步骤');record=this.record(node,executionId,run.rolePrompts??{},scope);run.executions.push(record)}
      return record
    }
    const result=await this.graphon.execute(graph,signal,async(nodeId,nodeSignal)=>{
      nodeSignal.throwIfAborted()
      const node=nodes.get(nodeId);if(!node)throw new Error('引擎请求的节点不属于当前流程')
      const record=recordFor(node),container=node.kind==='iteration'||node.kind==='loop'
      let data:Data
      try {
        if(node.kind==='exit_loop'&&record.status==='success')throw new ExitLoop()
        if(record.status==='success'&&record.data&&!container)data=record.data
        else {
          if(record.status==='failed')throw new Error(record.error??'之前的节点执行失败')
          record.status='running';record.startedAt??=now();record.error=undefined
          this.storage.saveRun(run)
          data=await this.executeNode(node,record,run,scope,nodeSignal)
          nodeSignal.throwIfAborted()
          if(JSON.stringify(data).length>1_000_000)throw new Error('节点输出超过 1 MB 限制')
          record.data=data;record.output=stringify(data.text??data);record.status='success';record.endedAt=now()
        }
      }catch(error){
        // Engine failure invalidates in-flight callbacks without changing the
        // user's signal. The outer run owns the final status and persisted state;
        // late provider results must not overwrite it or write after close.
        if(nodeSignal.aborted)throw nodeSignal.reason??error
        if(error instanceof HumanPause){if(container)record.status='pending';this.storage.saveRun(run);return {data:{},control:'pause'}}
        if(error instanceof ExitLoop){record.status='success';record.data={text:'退出循环'};record.output='退出循环';record.endedAt=now();this.storage.saveRun(run);return {data:record.data,control:'exit_loop'}}
        record.status=signal.aborted?'cancelled':'failed';record.error=error instanceof Error?error.message:String(error);record.endedAt=now();this.storage.saveRun(run);throw error
      }
      scope.values.set(node.id,data)
      // Restore deterministic local assignments from the durable checkpoint; completed external calls are not replayed.
      if(node.kind==='assigner'&&data.variables&&typeof data.variables==='object'&&!Array.isArray(data.variables))Object.assign(scope.variables,structuredClone(data.variables))
      if(node.kind==='output'&&!scope.parentNodeId)run.outputs[node.config.outputName??'result']=stringify(data.text??data)
      this.storage.saveRun(run)
      const activePorts=record.selectedPort?[record.selectedPort,...(node.kind==='human'&&record.selectedPort!=='timeout'?['default']:[])]:undefined
      return {data,...(activePorts?{activePorts,selectedPort:record.selectedPort}:{})}
    },nodeId=>{
      const node=nodes.get(nodeId);if(!node)throw new Error('引擎跳过的节点不属于当前流程')
      const record=recordFor(node);if(record.status!=='success')record.status='skipped';this.storage.saveRun(run)
    })
    signal.throwIfAborted()
    if(result.status==='paused')throw new HumanPause()
    if(result.status==='exit_loop')throw new ExitLoop()
    if(result.status!=='success')throw new Error(result.error??'工作流引擎执行失败')
  }
  private async executeNode(node:WorkflowNode,record:NodeExecution,run:WorkflowRun,scope:Scope,signal:AbortSignal):Promise<Data> {
    const c=node.config
    if(node.kind==='input')return {text:JSON.stringify(scope.input),...scope.input}
    if(node.kind==='if') {
      let port='false'
      if(c.cases?.length){for(const branch of c.cases)if(branch.logic==='or'?branch.conditions.some(v=>matches(v,scope)):branch.conditions.every(v=>matches(v,scope))){port=branch.id;break}}
      else port=matches({variable:c.variable!,operator:c.operator??'not_empty',value:c.value},scope)?'true':'false'
      record.input=JSON.stringify(c.cases??{variable:c.variable,operator:c.operator,value:c.value});record.selectedPort=port;return {text:port,result:port==='true',branch:port}
    }
    if(node.kind==='human') {
      record.status='waiting';run.status='waiting';run.waitingNodeId=node.id;run.waitingExecutionId=record.executionId??record.nodeId;run.humanPrompt=render(c.prompt??'',scope);run.humanActions=c.actions??[{id:'continue',label:'继续'}];run.missingFields=(c.fields??[]).map(field=>({...field,...(field.defaultValue!==undefined?{defaultValue:render(field.defaultValue,scope)}:{})}));run.waitingSince=now();record.input=run.humanPrompt;throw new HumanPause()
    }
    if(node.kind==='exit_loop'){if(!scope.inLoop)throw new Error('退出循环只能在循环内执行');throw new ExitLoop()}
    if(node.kind==='iteration') {
      const items=listReference(c.iterator!,scope),results:JsonValue[]=new Array(items.length), errors:Data[]=[],iterationController=new AbortController(),iterationSignal=AbortSignal.any([signal,iterationController.signal])
      if(c.parallel&&allNodes(c.body!).some(n=>n.kind==='human'))throw new Error('含人工介入的迭代请使用顺序模式，以保证表单逐项恢复')
      const work=async(index:number)=>{
        const child:Scope={...scope,values:new Map(scope.values),variables:structuredClone(scope.variables),item:items[index]!,index,path:`${record.executionId}[${index}]`,parentNodeId:node.id}
        try {await this.executeGraph(c.body!,run,child,iterationSignal);results[index]=structuredClone(reference(c.outputVariable!,child))}
        catch(e){if(e instanceof HumanPause||signal.aborted||c.errorMode==='terminate'||!c.errorMode)throw e;errors.push({index,error:e instanceof Error?e.message:String(e)});results[index]=null}
      }
      if(c.parallel){let next=0,firstError:unknown;let stopped=false;const workers=Array.from({length:Math.min(c.concurrency??3,items.length)},async()=>{while(!stopped&&next<items.length){signal.throwIfAborted();try{await work(next++)}catch(error){stopped=true;firstError??=error;iterationController.abort(error);throw error}}});await Promise.allSettled(workers);if(firstError)throw firstError}
      else for(let i=0;i<items.length;i++)await work(i)
      const failedIndices=new Set(errors.map(e=>e.index)),result=c.errorMode==='remove'?results.filter((_r,i)=>!failedIndices.has(i)):results
      return {text:JSON.stringify(result),result,json:result,errors}
    }
    if(node.kind==='loop') {
      const vars={...scope.variables,...mapping(c.initialVariables,scope)};let last:Scope|undefined,count=0
      for(let i=0;i<(c.maxIterations??10);i++){
        signal.throwIfAborted();const child:Scope={...scope,values:new Map(scope.values),variables:vars,index:i,path:`${record.executionId}[${i}]`,parentNodeId:node.id,inLoop:true};last=child;count=i+1
        try{await this.executeGraph(c.body!,run,child,signal)}catch(e){if(e instanceof ExitLoop)break;throw e}
        if(c.until&&matches(c.until,child))break
      }
      const result=c.outputVariable&&last?reference(c.outputVariable,last):vars
      return {text:stringify(result),result,variables:vars,iterations:count,json:result}
    }
    if(node.kind==='aggregator') {
      const result:Data={}
      for(const group of c.groups??[]){const found:JsonValue[]=[];for(const ref of group.variables){try{found.push(reference(ref,scope))}catch(e){if(!(e instanceof MissingValue))throw e}}if(found.length!==1)throw new Error(`聚合组 ${group.name} 需要一个有效互斥分支，实际为 ${found.length}`);result[group.name]=found[0]!}
      return {...result,text:typeof Object.values(result)[0]==='string'?Object.values(result)[0]!:JSON.stringify(result),json:result}
    }
    if(node.kind==='assigner') {
      const changed:Data={}
      for(const assignment of c.assignments??[]){const old=scope.variables[assignment.name],value=assignment.value===undefined?null:resolve(assignment.value,scope);let next:JsonValue
        switch(assignment.operation){
          case 'set':next=value;break
          case 'clear':next=Array.isArray(old)?[]:typeof old==='string'?'':typeof old==='number'?0:typeof old==='boolean'?false:old&&typeof old==='object'?{}:null;break
          case 'append':if(!Array.isArray(old))throw new Error('append 目标必须是数组');next=[...old,value];break
          case 'extend':if(!Array.isArray(old)||!Array.isArray(value))throw new Error('extend 要求数组');next=[...old,...value];break
          case 'pop':case 'shift':if(!Array.isArray(old))throw new Error('移除首尾目标必须是数组');next=assignment.operation==='pop'?old.slice(0,-1):old.slice(1);break
          default:if(typeof old!=='number'||typeof value!=='number')throw new Error('算术赋值要求数值');next=assignment.operation==='add'?old+value:assignment.operation==='subtract'?old-value:assignment.operation==='multiply'?old*value:old/value;if(!Number.isFinite(next))throw new Error('算术赋值产生无效数值')
        }
        scope.variables[assignment.name]=structuredClone(next);changed[assignment.name]=next
      }
      return {...changed,variables:changed,text:JSON.stringify(changed),json:changed}
    }
    if(node.kind==='list') {
      let result=listReference(c.listSource!,scope)
      if(c.filter)result=result.filter((item,index)=>matches(c.filter!,{...scope,item,index}))
      if(c.sort){const type=typeof result[0];if(result.some(v=>typeof v!==type)||!['string','number','boolean','undefined'].includes(type))throw new Error('排序要求同类型字符串、数字或布尔数组');result=[...result].sort((a,b)=>{const cmp=a===b?0:a!<b!?-1:1;return c.sort==='desc'?-cmp:cmp})}
      if(c.limit!==undefined)result=result.slice(0,c.limit)
      return {text:JSON.stringify(result),result,first_record:result[0]??null,last_record:result.at(-1)??null,json:result}
    }
    const inputs=mapping(c.inputs,scope)
    if(node.kind==='template'||node.kind==='output') {
      const local={...scope,input:{...scope.input,...inputs}}
      const text=node.kind==='template'?renderDataTemplate(c.text??'',name=>{const [key,...path]=name.split('.');return own(inputs,key!)?pathValue(inputs[key!]!,path):reference(name,local)}):render(c.text??'',local);record.input=text;return {text}
    }
    if(['llm','classifier','extractor'].includes(node.kind)) {
      const prompt=render(c.prompt??'',{...scope,input:{...scope.input,...inputs}})
      let system=record.rolePrompt??''
      if(node.kind==='classifier')system+=`\nClassify the input into exactly one category. Return only JSON {"class_id":"ID"}. Categories: ${JSON.stringify(c.classes)}`
      if(node.kind==='extractor')system+=`\nExtract these parameters, return only a JSON object. Never invent missing values. Parameters: ${JSON.stringify(c.parameters)}`
      if(node.kind==='llm'&&c.outputSchema?.length)system+=`\nReturn only a JSON object matching fields: ${JSON.stringify(c.outputSchema)}`
      record.input=prompt;record.tokenEstimate=await this.graphon.countTokens(system+'\n'+prompt,signal);signal.throwIfAborted();this.storage.saveRun(run)
      const text=await this.backend.generate({model:c.model!,effort:c.effort,prompt,system,signal})
      signal.throwIfAborted()
      if(node.kind==='classifier'){let parsed:unknown;try{parsed=parseJson(text)}catch{throw new Error('分类模型未返回有效 JSON')};const id=(parsed as {class_id?:unknown})?.class_id,category=c.classes?.find(x=>x.id===id);if(!category)throw new Error('分类模型未返回已定义的类别 ID');record.selectedPort=category.id;return {text:category.label,class_id:category.id,class_label:category.label,class_name:category.description??category.label}}
      if(node.kind==='extractor'){try{const data=validateObject(parseJson(text),c.parameters??[]);return {...data,text,json:data,__is_success:1,__reason:''}}catch(e){return {text,__is_success:0,__reason:e instanceof Error?e.message:String(e)}}}
      if(c.outputSchema?.length){const data=validateObject(parseJson(text),c.outputSchema);return {...data,text,json:data}}
      return {text}
    }
    if(!this.adapters)throw new Error(`节点 ${node.title} 的执行适配器尚未配置`)
    if(node.kind==='agent'||(node.kind==='document'&&c.documentMode==='agent'))inputs.prompt=render(c.prompt??'',scope)
    if(node.kind==='knowledge')inputs.query=render(c.query??'',scope)
    if(node.kind==='document'){try{inputs.source=reference(c.source??'',scope)}catch(e){if(c.source?.includes('{{'))inputs.source=resolve(c.source,scope);else inputs.source=c.source??''}}
    if(node.kind==='http'){inputs.url=render(c.url??'',scope);inputs.body=render(c.bodyText??'',scope);inputs.headers=Object.fromEntries(Object.entries(c.headers??{}).map(([k,v])=>[k,render(v,scope)]))}
    record.input=JSON.stringify(node.kind==='http'?{url:inputs.url,method:c.method}:inputs);this.storage.saveRun(run)
    const data=await this.adapters.execute(node.kind as AdapterNodeKind,{node,inputs,workspaceId:run.workspaceId,runId:run.id,signal,backend:{generate:async request=>{record.tokenEstimate=await this.graphon.countTokens(request.system+"\n"+request.prompt,request.signal);request.signal.throwIfAborted();this.storage.saveRun(run);return this.backend.generate(request)}},rolePrompt:record.rolePrompt})
    if(c.outputSchema?.length)validateObject(data,c.outputSchema)
    return data
  }
  async cancel(id:string):Promise<WorkflowRun> {
    const run=this.storage.run(id),task=this.running.get(id)
    if(task){task.controller.abort(new Error('用户取消'));await task.done;return this.storage.run(id)}
    if(run.status==='waiting'){run.status='cancelled';run.error='用户已取消运行';run.endedAt=now();this.clearWaiting(run);for(const rec of run.executions)if(['pending','waiting','running'].includes(rec.status))rec.status='cancelled';this.storage.saveRun(run)}
    return this.storage.run(id)
  }
  async settle(id:string):Promise<WorkflowRun>{await this.running.get(id)?.done;return this.storage.run(id)}
  async close():Promise<void>{this.closed=true;for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();const tasks=[...this.running.values()];for(const t of tasks)t.controller.abort(new Error('插件正在卸载'));await Promise.allSettled(tasks.map(t=>t.done));await this.graphon.close();this.storage.close()}
}
