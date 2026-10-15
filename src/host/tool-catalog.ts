import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JsonValue, ToolChoice, Workflow } from '../shared/types.ts'
import { allNodes } from './validation.ts'
import type { AdapterRequest } from './runtime.ts'

type Data = Record<string, JsonValue>
const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {}
const objectSchema = (properties: Data, required: string[] = []): Data => ({type:'object',properties,required})
const str = (description: string): Data => ({type:'string',description})
const builtin = (id:string,name:string,provider:string,description:string,inputSchema:Data):ToolChoice => ({id:`builtin:${id}`,name,description,providerId:`builtin:${provider}`,providerName:provider==='time'?'时间':'JSON 处理',category:'plugin',author:'工作流内置',available:true,inputSchema})
const tz = { timezone: str('IANA 时区，例如 Asia/Shanghai；默认 UTC') }
export const BUILTIN_TOOLS: ToolChoice[] = [
  builtin('time.now','当前时间','time','获取当前时间，可指定 IANA 时区。',objectSchema(tz)),
  builtin('time.timestamp','当前时间戳','time','返回 Unix 秒和毫秒时间戳。',objectSchema({})),
  builtin('time.from_timestamp','时间戳转换','time','将 Unix 时间戳转为日期时间。',objectSchema({timestamp:{type:'number'},unit:{type:'string',enum:['seconds','milliseconds']},...tz},['timestamp'])),
  builtin('time.convert_timezone','时区转换','time','将带时区的 ISO 日期时间转换到指定时区。',objectSchema({datetime:str('含 Z 或 UTC 偏移的 ISO 日期时间'),...tz},['datetime','timezone'])),
  builtin('time.weekday','星期几','time','返回日期所在星期；日期默认当前时刻。',objectSchema({datetime:str('含时区的 ISO 日期时间；不填为现在'),...tz})),
  builtin('json.parse','解析 JSON','json','将 JSON 文本解析为结构化值。',objectSchema({text:str('JSON 文本')},['text'])),
  builtin('json.stringify','生成 JSON 文本','json','将 JSON 值序列化为文本。',objectSchema({value:{},pretty:{type:'boolean'}},['value'])),
  builtin('json.select','读取 JSON 路径','json','通过点分隔键或数组下标读取 JSON 字段。',objectSchema({value:{},path:str('例如 items.0.title')},['value','path'])),
  builtin('json.merge','合并 JSON 对象','json','浅合并对象；右侧同名字段覆盖左侧。',objectSchema({left:{type:'object'},right:{type:'object'}},['left','right'])),
]
export function validateArguments(schema: Data, input: JsonValue, at='参数'):void {
  if(schema.type==='object') {
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error(`${at} 必须为对象`)
    for(const k of Array.isArray(schema.required)?schema.required:[])if(typeof k==='string'&&!Object.hasOwn(input,k))throw new Error(`${at}.${k} 为必填项`)
    for(const [k,v]of Object.entries(input)) {const sub=obj(schema.properties)[k];if(sub)validateArguments(sub,v,`${at}.${k}`)}
  } else if(schema.type==='array') {if(!Array.isArray(input))throw new Error(`${at} 必须为数组`);if(schema.items)for(const v of input)validateArguments(obj(schema.items),v,at)}
  else if(schema.type==='integer'){if(typeof input!=='number'||!Number.isSafeInteger(input))throw new Error(`${at} 必须为整数`)}
  else if(['string','number','boolean'].includes(String(schema.type))&&typeof input!==schema.type)throw new Error(`${at} 类型不符`)
  if(Array.isArray(schema.enum)&&!schema.enum.some(v=>JSON.stringify(v)===JSON.stringify(input)))throw new Error(`${at} 不在可选值中`)
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
interface CatalogOptions {
  directory:string
  workflows(workspaceId:string):Workflow[]
  nativeTools(workspaceId:string,sessionId?:string):ToolChoice[]
  executeNative(id:string,args:Data,request:AdapterRequest):Promise<Data>
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
    for(const value of [...(obj(pathValue).parameters??[]),...(op.parameters??[])]) {const p=obj(deref(value,root));if(!p.name||!['path','query','header','body'].includes(p.in))continue;const name=String(p.name);if(['__proto__','prototype','constructor'].includes(name))throw new Error('API 参数名称无效');properties[name]=deref(p.schema??{type:p.type??'string',description:p.description},root);params.push({name,location:p.in});if(p.required||p.in==='path')required.push(name)}
    const request=obj(deref(op.requestBody??{},root)),content=obj(request.content),contentType=Object.hasOwn(content,'application/json')?'application/json':Object.keys(content)[0]
    if(contentType){if(!['application/json','text/plain','application/x-www-form-urlencoded'].includes(contentType))throw new Error(`暂不支持请求体 ${contentType}，请使用 HTTP 节点配置`);properties.body=deref(obj(content[contentType]).schema??{},root);params.push({name:'body',location:'body'});if(request.required)required.push('body')}
    const id=`swagger:${pid}:${method}:${encodeURIComponent(path)}`
    out.push({workspaceId,url:base.replace(/\/$/,'')+'/'+path.replace(/^\//,''),method:method.toUpperCase(),parameters:params,contentType,choice:{id,name:String(op.summary??op.operationId??`${method.toUpperCase()} ${path}`),description:String(op.description??`${method.toUpperCase()} ${path}`),providerId:`swagger:${pid}`,providerName:title,category:'swagger',available:true,inputSchema:objectSchema(properties,required)}})
  }
  if(!out.length)throw new Error('文档没有可调用的 HTTP operation');if(out.length>300)throw new Error('一个 API 最多导入 300 个 operation');return out
}
export class ToolCatalog {
  private operations:SwaggerOperation[]=[]
  private file:string
  constructor(private options:CatalogOptions) {this.file=join(options.directory,'tool-catalog.json');if(existsSync(this.file)){if(lstatSync(this.file).isSymbolicLink())throw new Error('工具目录存储不能是符号链接');const saved=JSON.parse(readFileSync(this.file,'utf8'));if(!Array.isArray(saved))throw new Error('工具目录格式错误');this.operations=saved}}
  list(workspaceId:string,sessionId?:string):ToolChoice[] {
    const flows=this.options.workflows(workspaceId).filter(w=>w.workspaceId===workspaceId&&!w.archived).map(w=>({id:`workflow:${w.id}`,name:w.title,description:w.description||'执行此工作区已保存的工作流。',providerId:'workflows',providerName:'工作流',category:'workflow' as const,available:!allNodes(w).some(n=>n.kind==='human'),...(allNodes(w).some(n=>n.kind==='human')?{unavailableReason:'包含人工介入，请从画布独立运行'}:{}),inputSchema:objectSchema(Object.fromEntries((w.nodes.find(n=>n.kind==='input')?.config.fields??[]).map(f=>[f.name,{type:f.type==='number'?'number':f.type==='boolean'?'boolean':'string',description:f.label}])),(w.nodes.find(n=>n.kind==='input')?.config.fields??[]).filter(f=>f.required&&f.defaultValue===undefined).map(f=>f.name))}))
    return structuredClone([...BUILTIN_TOOLS,...this.operations.filter(o=>o.workspaceId===workspaceId).map(o=>o.choice),...flows,...this.options.nativeTools(workspaceId,sessionId)])
  }
  importSwagger(workspaceId:string,json:string):ToolChoice[]{const operations=parseSwagger(workspaceId,json),ids=new Set(operations.map(o=>o.choice.providerId));const next=[...this.operations.filter(o=>!ids.has(o.choice.providerId)),...operations],temp=`${this.file}.${randomUUID()}.tmp`;writeFileSync(temp,JSON.stringify(next),{flag:'wx',mode:0o600});renameSync(temp,this.file);this.operations=next;return operations.map(o=>structuredClone(o.choice))}
  async execute(id:string,args:Data,request:AdapterRequest):Promise<Data> {
    request.signal.throwIfAborted()
    if(id.startsWith('builtin:'))return executeBuiltin(id,args)
    if(id.startsWith('native:'))return this.options.executeNative(id.slice(7),args,request)
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
