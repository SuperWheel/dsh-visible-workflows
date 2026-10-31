import { BUILTIN_TOOLS } from '../shared/builtin-tools.ts'
export { BUILTIN_TOOLS } from '../shared/builtin-tools.ts'
import { executeHtml, isHtmlTool } from './html-tools.ts'
import { statWorkspaceFile } from './file-stat.ts'
import { isCachedBody } from '../shared/http-cache.ts'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolChoice, Workflow } from '../shared/types.ts'
import { workflowVisibleInWorkspace } from '../shared/workflow-scope.ts'
import { builtinToolOperation, unknownToolOperation, validateToolOperation } from '../shared/tool-operation-contract.ts'
import { allNodes } from './validation.ts'
import type { AdapterRequest } from './runtime.ts'

type Data = Record<string, JsonValue>
const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {}
const objectSchema=(properties:Data,required:string[]=[]):Data=>({type:'object',properties,required})
export function validateArguments(schema: Data, input: JsonValue, at='参数'):void {
  // Call only after runtime references / attachment aliases have been resolved.
  // Assert the contract too: unsupported keywords must never become silent no-ops.
  assertSupportedJsonSchema(schema)
  const violations=validateJsonSchemaValue(schema,input,at)
  if(violations.length)throw new Error(`工具参数无效：${violations.join('；')}`)
}
/** Agents choose their arguments at execution time; omitted inputs are unknown. */
export function builtinReadsCurrentTime(id:string,inputs?:Data):boolean {
  return id==='builtin:time.now'||id==='builtin:time.timestamp'||id==='builtin:time.weekday'&&inputs?.datetime===undefined
}
function date(value:JsonValue|undefined):Date {const d=value===undefined?new Date():new Date(String(value));if(!Number.isFinite(d.getTime()))throw new Error('无效日期时间');if(typeof value==='string'&&!/(Z|[+-]\d\d:\d\d)$/.test(value))throw new Error('日期时间必须包含 Z 或 UTC 偏移');return d}
function formatDate(d:Date,zone:JsonValue|undefined):Data {const timezone=String(zone||'UTC');const local=new Intl.DateTimeFormat('sv-SE',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(d);return {text:local,datetime:local,iso:d.toISOString(),timezone,timestamp:Math.floor(d.getTime()/1000)}}
export function executeBuiltin(id:string,args:Data):Data {
  const choice=BUILTIN_TOOLS.find(t=>t.id===id);if(!choice)throw new Error('内置工具不存在');validateArguments(choice.inputSchema,args)
  switch(id) {
    case 'builtin:time.now':return formatDate(new Date(),args.timezone)
    case 'builtin:time.timestamp':{const ms=Date.now();return {text:String(Math.floor(ms/1000)),seconds:Math.floor(ms/1000),milliseconds:ms}}
    case 'builtin:time.from_timestamp':{const d=new Date(Number(args.timestamp)*(args.unit==='milliseconds'?1:1000));if(!Number.isFinite(d.getTime()))throw new Error('时间戳超出范围');return formatDate(d,args.timezone)}
    case 'builtin:time.convert_timezone':return formatDate(date(args.datetime),args.timezone)
    case 'builtin:time.weekday':{const d=date(args.datetime),timezone=String(args.timezone||'UTC'),weekday=new Intl.DateTimeFormat('zh-CN',{timeZone:timezone,weekday:'long'}).format(d);return {text:weekday,weekday,timezone}}
    case 'builtin:json.parse':{const value=JSON.parse(String(args.text)) as JsonValue;return {text:JSON.stringify(value),value,json:value}}
    case 'builtin:json.stringify':return {text:JSON.stringify(args.value,null,args.pretty?2:undefined)}
    case 'builtin:json.select':{let value=args.value;for(const key of String(args.path).split('.').filter(Boolean)){if(['__proto__','constructor','prototype'].includes(key)||value===null||typeof value!=='object'||!Object.hasOwn(value,key))throw new Error(`JSON 路径 ${args.path} 不存在`);value=(value as Data)[key]}return {text:typeof value==='string'?value:JSON.stringify(value),value}}
    case 'builtin:json.merge':{const value={...obj(args.left),...obj(args.right)};return {text:JSON.stringify(value),value}}
    default:throw new Error('工具不存在')
  }
}

interface SwaggerOperation { choice:ToolChoice; url:string; method:string; parameters:{name:string;location:string}[]; contentType?:string; workspaceId:string }
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`
  if(value&&typeof value==='object')return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,v])=>`${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}
interface CatalogOptions {
  directory:string
  workflows(workspaceId:string):Workflow[]
  nativeTools(workspaceId:string,sessionId?:string):ToolChoice[]
  sessionForRun?(runId:string):string|undefined
  executeNative(id:string,args:Data,request:AdapterRequest):Promise<Data>
  /** Needed by builtin:file.stat only. */
  workspaceRoot?(workspaceId:string):string
  runWorkflow(id:string,args:Data,request:AdapterRequest):Promise<Data>
  http(url:string,method:string,headers:Record<string,string>,body:string|undefined,signal:AbortSignal,timeoutMs?:number):Promise<Data>
}
function deref(value:unknown,root:Record<string,any>,depth=0):any {
  if(depth>16)throw new Error('OpenAPI schema 引用过深或存在循环')
  if(Array.isArray(value))return value.map(v=>deref(v,root,depth+1))
  if(!value||typeof value!=='object')return value
  const raw=obj(value)
  if(raw.$ref){if(typeof raw.$ref!=='string'||!raw.$ref.startsWith('#/'))throw new Error('仅支持 OpenAPI 文档内的 $ref 引用');let target:any=root;for(const part of raw.$ref.slice(2).split('/'))target=target?.[part.replace(/~1/g,'/').replace(/~0/g,'~')];if(!target)throw new Error('OpenAPI 引用不存在');return deref(target,root,depth+1)}
  return Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,deref(v,root,depth+1)]))
}
export function parseSwagger(workspaceId:string,json:string):SwaggerOperation[] {
  if(Buffer.byteLength(json)>2_000_000)throw new Error('OpenAPI 文档超过 2 MB')
  const root=obj(JSON.parse(json));if(!root.openapi&&!root.swagger)throw new Error('需要 OpenAPI 3 或 Swagger 2 JSON 文档')
  const base=String(root.servers?.[0]?.url??(root.host?`${root.schemes?.[0]??'https'}://${root.host}${root.basePath??''}`:''));const u=new URL(base)
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('API server 必须为无内嵌凭证的 HTTP(S) 地址')
  const title=String(root.info?.title??u.hostname),pid=createHash('sha256').update(`${workspaceId}:${title}:${base}`).digest('hex').slice(0,16),out:SwaggerOperation[]=[]
  for(const [path,pathValue]of Object.entries(obj(root.paths))) for(const [method,raw]of Object.entries(obj(pathValue))) {
    if(!['get','post','put','patch','delete','head','options'].includes(method))continue
    const op=obj(raw),properties:Data={},required:string[]=[],params:{name:string;location:string}[]=[]
    for(const value of [...(obj(pathValue).parameters??[]),...(op.parameters??[])]) {
      const p=obj(deref(value,root));if(!p.name||!['path','query','header','body'].includes(p.in))throw new Error(`OpenAPI ${method.toUpperCase()} ${path} 参数合同包含无效或不支持的参数位置`)
      const name=String(p.name);if(['__proto__','prototype','constructor'].includes(name))throw new Error('API 参数名称无效')
      // Swagger 2 puts schema constraints directly on non-body parameters.
      // Strip only transport metadata; every remaining keyword reaches the
      // supported-schema checker, which rejects unsupported contracts explicitly.
      const {name:_name,in:_in,required:_required,collectionFormat,...schema}=p
      if(root.swagger&&p.in!=='body'&&collectionFormat!==undefined&&!(p.in==='query'&&p.type==='array'&&collectionFormat==='multi'))throw new Error(`OpenAPI ${method.toUpperCase()} ${path} 参数合同不支持 collectionFormat ${collectionFormat}`)
      properties[name]=deref(root.swagger&&p.in!=='body'?{...schema,type:p.type??'string'}:p.schema??{type:p.type??'string',...(p.description!==undefined?{description:p.description}:{})},root);params.push({name,location:p.in});if(p.required||p.in==='path')required.push(name)}
    const request=obj(deref(op.requestBody??{},root)),content=obj(request.content),contentType=Object.hasOwn(content,'application/json')?'application/json':Object.keys(content)[0]
    if(contentType){if(!['application/json','text/plain','application/x-www-form-urlencoded'].includes(contentType))throw new Error(`暂不支持请求体 ${contentType}，请使用 HTTP 节点配置`);properties.body=deref(obj(content[contentType]).schema??{},root);params.push({name:'body',location:'body'});if(request.required)required.push('body')}
    const id=`swagger:${pid}:${method}:${encodeURIComponent(path)}`
    const inputSchema=objectSchema(properties,required)
    try{assertSupportedJsonSchema(inputSchema)}catch(error){throw new Error(`OpenAPI ${method.toUpperCase()} ${path} 参数合同超出支持范围：${error instanceof Error?error.message:String(error)}`)}
    out.push({workspaceId,url:base.replace(/\/$/,'')+'/'+path.replace(/^\//,''),method:method.toUpperCase(),parameters:params,contentType,choice:{id,name:String(op.summary??op.operationId??`${method.toUpperCase()} ${path}`),description:String(op.description??`${method.toUpperCase()} ${path}`),providerId:`swagger:${pid}`,providerName:title,category:'swagger',available:true,inputSchema}})
  }
  if(!out.length)throw new Error('文档没有可调用的 HTTP operation');if(out.length>300)throw new Error('一个 API 最多导入 300 个 operation');return out
}
/** visible_workflow_tools: a compact index by default, full schemas and contracts only for the ids asked for.
 * The whole catalog was too large to read inline, and the agent grepped a spilled file (Desktop r49). */
export function toolCatalogView(tools:readonly ToolChoice[],ids?:readonly string[],includeWorkflows=false):JsonValue {
  if(ids?.length){const wanted=new Set(ids);return {tools:tools.filter(tool=>wanted.has(tool.id)) as unknown as JsonValue,missing:ids.filter(id=>!tools.some(tool=>tool.id===id))}}
  // T31.6 (Desktop r52: 66 of 117 entries were saved test workflows): saved workflows only on request.
  const flows=tools.filter(tool=>tool.id.startsWith('workflow:')).length
  if(!includeWorkflows)tools=tools.filter(tool=>!tool.id.startsWith('workflow:'))
  const brief=(text:string)=>{const first=/^[\s\S]*?[。.!?！？](?=\s|$)/.exec(text.trim())?.[0]??text.trim();return first.length>120?first.slice(0,119)+'…':first}
  return {tools:tools.map(tool=>({id:tool.id,name:tool.name,description:brief(tool.description),...(tool.available?{}:{available:false,...(tool.unavailableReason?{unavailableReason:tool.unavailableReason}:{})})})),
    detail:'这是紧凑目录；需要参数 schema 或操作合同时用 ids 查询，例如 {"ids":["native:glob"]}。'+(!includeWorkflows&&flows?`另有 ${flows} 个已保存工作流可作为工具调用，未列出；需要时传 include_workflows:true。`:'')}
}
export class ToolCatalog {
  private operations:SwaggerOperation[]=[]
  private file:string
  constructor(private options:CatalogOptions) {this.file=join(options.directory,'tool-catalog.json');if(existsSync(this.file)){if(lstatSync(this.file).isSymbolicLink())throw new Error('工具目录存储不能是符号链接');const saved=JSON.parse(readFileSync(this.file,'utf8'));if(!Array.isArray(saved))throw new Error('工具目录格式错误');this.operations=saved}}
  list(workspaceId:string,sessionId?:string):ToolChoice[] {
    const flows=this.options.workflows(workspaceId).filter(w=>workflowVisibleInWorkspace(w,workspaceId)).map(w=>({id:`workflow:${w.id}`,name:w.title,description:w.description||'在当前工作区执行此流程定义。',providerId:'workflows',providerName:'工作流',category:'workflow' as const,available:!allNodes(w).some(n=>n.kind==='human'),...(allNodes(w).some(n=>n.kind==='human')?{unavailableReason:'包含人工介入，请从画布独立运行'}:{}),inputSchema:objectSchema(Object.fromEntries((w.nodes.find(n=>n.kind==='input')?.config.fields??[]).map(f=>[f.name,{type:f.type==='number'?'number':f.type==='boolean'?'boolean':'string',description:f.label}])),(w.nodes.find(n=>n.kind==='input')?.config.fields??[]).filter(f=>f.required&&f.defaultValue===undefined).map(f=>f.name))}))
    return structuredClone([...BUILTIN_TOOLS.map(tool=>({...tool,operationContract:builtinToolOperation(tool)})),...this.operations.filter(o=>o.workspaceId===workspaceId).map(o=>o.choice),...flows,...this.options.nativeTools(workspaceId,sessionId)].map((tool:ToolChoice)=>({...tool,operationContract:tool.operationContract?validateToolOperation(tool.operationContract,tool.id):unknownToolOperation()})))
  }
  importSwagger(workspaceId:string,json:string):ToolChoice[]{const operations=parseSwagger(workspaceId,json),ids=new Set(operations.map(o=>o.choice.providerId));const next=[...this.operations.filter(o=>!ids.has(o.choice.providerId)),...operations],temp=`${this.file}.${randomUUID()}.tmp`;writeFileSync(temp,JSON.stringify(next),{flag:'wx',mode:0o600});renameSync(temp,this.file);this.operations=next;return operations.map(o=>structuredClone(o.choice))}
  /** Freeze execution-relevant contracts. Nested workflow definitions have their own recursive snapshot. */
  constraints(workspaceId:string,toolIds:readonly string[],sessionId?:string):Record<string,string>{
    const choices=this.list(workspaceId,sessionId),result:Record<string,string>={}
    for(const id of new Set(toolIds)){
      if(id.startsWith('workflow:'))continue
      const choice=choices.find(tool=>tool.id===id&&tool.available)
      if(!choice){if(id.startsWith('native:')&&!sessionId)continue;throw new Error(`无法冻结不可用工具：${id}`)}
      const op=this.operations.find(item=>item.workspaceId===workspaceId&&item.choice.id===id)
      const operation=choice.operationContract&&validateToolOperation(choice.operationContract,choice.id)
      // A builtin's contract follows the plugin's own code, which this digest does not track
      // either; leaving it out keeps runs saved before it existed resumable.
      const contract={id,name:choice.name,description:choice.description,inputSchema:choice.inputSchema,...(operation?.status==='known'&&operation.source==='host-tool-registration'?{operationContract:operation}:{}),...(op?{url:op.url,method:op.method,parameters:op.parameters,contentType:op.contentType}:{}),...(id.startsWith('builtin:')?{implementation:'visible-workflow-builtins-v1'}:{})}
      result[id]=createHash('sha256').update(canonical(contract)).digest('hex')
    }
    return result
  }
  assertConstraints(request:AdapterRequest,toolIds:readonly string[],sessionId?:string):void{
    if(!request.toolConstraints)return
    const tracked=toolIds.filter(id=>!id.startsWith('workflow:')&&(!id.startsWith('native:')||request.toolConstraints?.[id]!==undefined))
    if(!tracked.length)return
    const current=this.constraints(request.workspaceId,tracked,sessionId)
    for(const id of tracked)if(!request.toolConstraints[id]||request.toolConstraints[id]!==current[id])throw new Error(`工具定义已变化，不能继续旧运行：${id}。请核对配置后重新启动。`)
  }
  async execute(id:string,args:Data,request:AdapterRequest):Promise<Data> {
    request.signal.throwIfAborted()
    this.assertConstraints(request,[id],this.options.sessionForRun?.(request.runId))
    if(isHtmlTool(id)){
      const choice=BUILTIN_TOOLS.find(tool=>tool.id===id)!
      // Validate all other arguments with the unchanged SDK limit. HTML alone
      // is checked by the Host tool (10 MB), including verified cache handles.
      if(typeof args.html!=='string'&&!isCachedBody(args.html))throw Error('html 必须为 HTML 字符串')
      validateArguments(choice.inputSchema,{...args,html:''})
      return executeHtml(id,args,request.signal,request.readCachedBody)
    }
    if(id==='builtin:file.stat'){
      validateArguments(BUILTIN_TOOLS.find(tool=>tool.id===id)!.inputSchema,args)
      if(!this.options.workspaceRoot)throw new Error('文件信息工具需要工作区')
      return statWorkspaceFile(this.options.workspaceRoot(request.workspaceId),String(args.path),request.signal)
    }
    if(id.startsWith('builtin:'))return executeBuiltin(id,args)
    if(id.startsWith('native:'))return this.options.executeNative(id.slice(7),args,request)
    // Never validate a frozen child against today's catalog schema; runWorkflow/prepareInputs own that snapshot.
    if(id.startsWith('workflow:'))return this.options.runWorkflow(id.slice(9),args,request)
    const op=this.operations.find(o=>o.workspaceId===request.workspaceId&&o.choice.id===id);if(!op)throw new Error('工具不存在、已删除或不属于当前工作区')
    validateArguments(op.choice.inputSchema,args)
    let url=op.url,body:string|undefined;const headers:Record<string,string>={}
    for(const p of op.parameters){const value=args[p.name];if(value===undefined)continue;if(p.location==='path')url=url.replaceAll(`{${p.name}}`,encodeURIComponent(String(value)))}
    const parsed=new URL(url)
    for(const p of op.parameters){const value=args[p.name];if(value===undefined)continue;if(p.location==='query'){for(const v of Array.isArray(value)?value:[value])parsed.searchParams.append(p.name,String(v))}else if(p.location==='header')headers[p.name]=String(value);else if(p.location==='body'){body=op.contentType==='application/x-www-form-urlencoded'?new URLSearchParams(Object.entries(obj(value)).map(([k,v])=>[k,String(v)])).toString():typeof value==='string'&&op.contentType==='text/plain'?value:JSON.stringify(value);headers['Content-Type']=op.contentType??'application/json'}}
    return this.options.http(parsed.toString(),op.method,headers,body,request.signal,request.node.config.timeoutMs)
  }
}
