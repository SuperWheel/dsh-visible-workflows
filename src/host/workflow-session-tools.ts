import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterPropertySpec, type ParameterSchemaSpec, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BUILTIN_TOOLS } from '../shared/builtin-tools.ts'
import { WORKFLOW_SESSION_TOOL_NODES, WORKFLOW_SESSION_TOOL_PLAN_GUIDANCE, type WorkflowSessionToolName } from '../shared/workflow-session-tools.ts'
import type { JsonValue } from '../shared/types.ts'
import { isCachedBody, mapCachedBodies, type CachedBody } from '../shared/http-cache.ts'
import { executeHttpRequest } from './execution-adapters.ts'
import { executeHtml } from './html-tools.ts'
import { statWorkspaceFile } from './file-stat.ts'
import type { WorkflowStorage } from './storage.ts'

type Data=Record<string,JsonValue>
export const SESSION_HTTP_CACHE_IDLE_MS=300_000
/** Larger inline bodies are spilled to files by the session and then misused as HTML. */
export const SESSION_HTTP_INLINE_LIMIT=32_768
interface Lease {runId:string;pending:number;refs:Map<string,CachedBody>;timer?:ReturnType<typeof setTimeout>}

/** A finite idle lease bridges HTTP and HTML calls, including immediate cleanup mode. */
export class WorkflowSessionTools {
  private readonly leases=new Map<string,Lease>()
  private closed=false
  private readonly controller=new AbortController()
  private cleanupError:unknown
  constructor(private storage:WorkflowStorage,private authorize:(exec:ToolRunContext)=>{sessionId:string;workspaceId:string}){}
  async execute(name:WorkflowSessionToolName,args:Data,exec:ToolRunContext):Promise<Data> {
    const signal=AbortSignal.any([exec.signal,this.controller.signal])
    signal.throwIfAborted()
    if(this.closed)throw new Error('工作流会话工具已关闭')
    if(this.cleanupError)throw this.cleanupError
    const scope=this.authorize(exec),key=JSON.stringify([scope.sessionId,scope.workspaceId])
    let lease=this.leases.get(key)
    if(!lease){lease={runId:this.storage.beginSessionHttpCacheOwner(),pending:0,refs:new Map()};this.leases.set(key,lease)}
    else this.storage.beginSessionHttpCacheOwner(lease.runId)
    clearTimeout(lease.timer);lease.pending++
    const {runId}=lease
    try {
      const node=WORKFLOW_SESSION_TOOL_NODES[name]
      const result=node.kind==='http'
        ?await executeHttpRequest(args,{method:args.method as string|undefined,timeoutMs:args.timeoutMs as number|undefined},signal,(bytes,type)=>this.storage.cacheHttpBody(runId,name,1,bytes,type))
        :await executeHtml(node.toolId,{...args,html:sessionHtml(args.html,lease.refs)},signal,ref=>this.storage.readCachedBody(runId,ref))
      if(node.kind==='http'&&typeof result.text==='string'&&Buffer.byteLength(result.text)>SESSION_HTTP_INLINE_LIMIT){
        // Same post-processing as the runtime applies to HTTP nodes, at the session's lower inline limit.
        const ref=this.storage.cacheHttpBody(runId,name,1,Buffer.from(result.text),String((result.headers as Data|undefined)?.['content-type']??''))
        result.text=ref;result.body=ref;delete result.json
      }
      if(node.kind==='http')mapCachedBodies(result,ref=>{lease.refs.set(ref.$cachedBody.id,ref);return ref})
      signal.throwIfAborted()
      const current=this.authorize(exec)
      if(current.sessionId!==scope.sessionId||current.workspaceId!==scope.workspaceId)throw new Error('对话工作区已变化，请重新执行网页步骤')
      return this.storage.redactCachedText(runId,this.storage.compactCachedData(runId,result,name,1)) as Data
    } catch(error) {
      if(signal.aborted)signal.throwIfAborted()
      throw new Error(this.storage.redactCachedText(runId,error instanceof Error?error.message:String(error)))
    } finally {
      if(--lease.pending===0){
        this.storage.releaseCachedReads(runId)
        if(this.closed||signal.aborted)this.storage.finishSessionHttpCacheOwner(runId)
        else {
          lease.timer=setTimeout(()=>{try{this.storage.finishSessionHttpCacheOwner(runId)}catch(error){this.cleanupError=error}},SESSION_HTTP_CACHE_IDLE_MS)
          lease.timer.unref?.()
        }
      }
    }
  }
  close():void {
    if(this.closed)return
    this.closed=true;this.controller.abort(new Error('工作流会话工具已关闭'))
    for(const lease of this.leases.values()){clearTimeout(lease.timer);if(!lease.pending)this.storage.finishSessionHttpCacheOwner(lease.runId)}
  }
}

/** Models often send the reference as a JSON string or drop its preview; resolve
 * only references this lease issued, by id, back to the exact cached body. */
export function sessionHtml(html:JsonValue,refs:ReadonlyMap<string,CachedBody>):JsonValue {
  let value=html
  if(typeof value==='string'&&/^\s*\{/.test(value)&&/"(?:\$cachedBody|id)"/.test(value)){try{value=JSON.parse(value) as JsonValue}catch{return html}}
  if(!value||typeof value!=='object'||Array.isArray(value))return html
  if(isCachedBody(value))return value
  const inner=(value as Data).$cachedBody,bare=value as Data,id=inner&&typeof inner==='object'&&!Array.isArray(inner)?(inner as Data).id:typeof bare.runId==='string'?bare.id:undefined
  if(typeof id!=='string')return html
  const ref=refs.get(id)
  if(!ref)throw new Error('html 的缓存引用无效或已过期；请重新调用 workflow_http_request，并把返回的 body 对象原样传入')
  return ref
}

function htmlParameters(id:string):ParameterSchemaSpec {
  const schema=BUILTIN_TOOLS.find(tool=>tool.id===id)!.inputSchema
  const required=schema.required as string[]
  const parameters=Object.fromEntries(Object.entries(schema.properties as Data).map(([key,value])=>{
    const spec=value as Data
    return [key,{...spec,...(spec.type==='object'?{additionalProperties:true}:{}),...(required.includes(key)?{required:true}:{})} as ParameterPropertySpec]
  }))
  parameters.html={required:true,oneOf:[{type:'string'},{type:'object',additionalProperties:true}],description:'HTML 正文，或 workflow_http_request 返回的 body 缓存引用对象 {"$cachedBody":{"id":…}}（至少保留 id；无需转成字符串）。缓存失效须重新请求。'}
  return parameters
}

/** Session tools stay out of ordinary DSH conversations: they are registered only in the
 * scope of an agent doing workflow work (the planning command, any visible_workflow_* call,
 * a trial child), so the rest of DSH keeps its own tool choices. Returns that enabler. */
export function registerWorkflowSessionTools(ctx:Context,storage:WorkflowStorage,authorize:(exec:ToolRunContext)=>{sessionId:string;workspaceId:string},workspaceRoot:(workspaceId:string)=>string):(agent:Agent,options?:{guidance?:boolean})=>void {
  const executor=new WorkflowSessionTools(storage,authorize)
  ctx.effect(()=>()=>executor.close(),'visible-workflows:session-tools-lifetime')
  const output={schema:{type:'object' as const,additionalProperties:true as const},render:(_args:unknown,value:Data)=>[{type:'text' as const,text:JSON.stringify(value)}]}
  const definitions:ToolDefinition[]=[]
  definitions.push(defineTool({
    name:'workflow_http_request',timeoutMs:125_000,description:'发送 HTTP 请求并完整下载响应正文（最多 10 MB，超过则报错，不截断）；超过 32 KB 的正文完整存入缓存，对话里只返回开头预览和 body 缓存引用，把该 body 对象原样传给 HTML 处理工具即可读取全文。不转换网页，不自动跟随重定向。',
    parameters:{url:{type:'string',required:true,description:'无内嵌凭证的 HTTP(S) 地址。'},method:{type:'string',description:'HTTP 方法，默认 GET。'},headers:{type:'object',additionalProperties:true,description:'请求头对象。'},body:{type:'json',description:'请求正文；对象序列化为 JSON，GET/HEAD 忽略。'},timeoutMs:{type:'integer',description:'超时毫秒数，默认 30000，上限 120000。'}},
    output,execute:(args,exec)=>executor.execute('workflow_http_request',args as Data,exec),
  }))
  for(const name of ['workflow_html_extract_text','workflow_html_select'] as const){
    const id=WORKFLOW_SESSION_TOOL_NODES[name].toolId,choice=BUILTIN_TOOLS.find(tool=>tool.id===id)!
    definitions.push(defineTool({name,description:choice.description,parameters:htmlParameters(id),output,execute:(args,exec)=>executor.execute(name,args as Data,exec)}))
  }
  // No cache lease: the result is a few numbers, read straight from the file the node will read.
  const stat=BUILTIN_TOOLS.find(tool=>tool.id===WORKFLOW_SESSION_TOOL_NODES.workflow_file_stat.toolId)!
  definitions.push(defineTool({name:'workflow_file_stat',description:stat.description+'path 也可以是工作区内的绝对路径。',
    parameters:{path:{type:'string',required:true,description:'工作区相对路径，例如 data/a.csv。'}},
    output,execute:(args,exec)=>statWorkspaceFile(workspaceRoot(authorize(exec).workspaceId),String((args as Data).path),exec.signal)}))
  // Agent effects end with the agent; the plugin also withdraws them when it unloads.
  const enabled=new WeakMap<Agent,boolean>(),disposers=new Set<()=>unknown>()
  ctx.effect(()=>()=>{for(const dispose of disposers)try{void dispose()}catch{};disposers.clear()},'visible-workflows:session-tools-scopes')
  const scoped=(agent:Agent,effect:()=>()=>void,label:string)=>disposers.add(agent.ctx.effect(effect,label) as unknown as ()=>unknown)
  return (agent,options={})=>{
    const guidance=options.guidance!==false
    if(enabled.has(agent)&&(enabled.get(agent)||!guidance))return
    if(!enabled.has(agent))for(const definition of definitions)scoped(agent,()=>agent.ctx.tools.register(definition),`visible-workflows:session-${definition.name}`)
    // How to pick them when planning: only where they are offered, never in the global guide.
    if(guidance)scoped(agent,()=>agent.ctx.systemPrompt.section({name:'visible-workflows:session-tools',order:86,interpolate:false,text:WORKFLOW_SESSION_TOOL_PLAN_GUIDANCE}),'visible-workflows:session-tools-guide')
    enabled.set(agent,guidance)
  }
}
