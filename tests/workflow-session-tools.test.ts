import {afterEach,expect,it,vi} from 'vitest'
import {existsSync,mkdtempSync,readdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import type {ToolRunContext} from '@deepseek-ai/dsh-tools'
import {WorkflowStorage} from '../src/host/storage.ts'
import {WorkflowSessionTools,SESSION_HTTP_CACHE_IDLE_MS,SESSION_HTTP_INLINE_LIMIT} from '../src/host/workflow-session-tools.ts'
import {createExecutionAdapters} from '../src/host/execution-adapters.ts'
import {ToolCatalog} from '../src/host/tool-catalog.ts'
import type {AdapterRequest} from '../src/host/runtime.ts'
import {makeWorkflow,type WorkflowRun} from '../src/shared/types.ts'
import {HTTP_CACHE_THRESHOLD,HTTP_DOWNLOAD_LIMIT,type CachedBody} from '../src/shared/http-cache.ts'

const cleanups:(()=>void)[]=[]
const forbidden=async()=>{throw Error('不允许模型或外部网络调用')}
function setup(){
  const directory=mkdtempSync(join(tmpdir(),'workflow-session-tools-')),storage=new WorkflowStorage(directory)
  let sessionId='session',workspaceId='workspace'
  const executor=new WorkflowSessionTools(storage,()=>({sessionId,workspaceId}))
  const context=(signal=new AbortController().signal)=>({signal} as ToolRunContext)
  const call=(name:Parameters<typeof executor.execute>[0],args:any,signal?:AbortSignal)=>executor.execute(name,args,context(signal))
  const catalog=new ToolCatalog({directory,workflows:()=>[],nativeTools:()=>[],executeNative:forbidden,runWorkflow:forbidden,http:forbidden})
  const adapters=createExecutionAdapters({catalog,workspaceRoot:()=>directory})
  const graph=makeWorkflow(workspaceId)
  const run:WorkflowRun={id:randomUUID(),workflowId:graph.id,workflowTitle:graph.title,sourceRevision:graph.revision,workspaceId,graph,status:'running',startedAt:new Date().toISOString(),inputs:{},outputs:{},executions:[]}
  storage.saveRun(run)
  const request=(kind:'http'|'tool',inputs:any,config:any={}):AdapterRequest=>({node:{id:'node',number:'a-2',kind,title:'测试',x:0,y:0,fixed:false,config},inputs,signal:new AbortController().signal,runId:run.id,workspaceId,backend:{generate:forbidden},cacheHttpBody:(bytes,type)=>storage.cacheHttpBody(run.id,'node',1,bytes,type),readCachedBody:ref=>storage.readCachedBody(run.id,ref)})
  const result={directory,storage,executor,call,adapters,request,run,switchSession:(id:string)=>{sessionId=id},switchWorkspace:(id:string)=>{workspaceId=id}}
  cleanups.push(()=>{executor.close();storage.close();rmSync(directory,{recursive:true,force:true})});return result
}
afterEach(()=>{try{for(const cleanup of cleanups.splice(0))cleanup()}finally{vi.useRealTimers();vi.unstubAllGlobals()}})
const selectArgs={items:'article',fields:{name:{selector:'a',text:true},link:{selector:'a',attr:'href'}},baseUrl:'https://page.test/trending'}
const html='<title>列表</title><body><main><article><a href="/repo">项目</a></article></main></body>'
function mockResponse(body:string){const fetch=vi.fn(async(_url:Parameters<typeof globalThis.fetch>[0],_options?:RequestInit)=>new Response(body,{status:200,headers:{'content-type':'text/html','set-cookie':'fixture-only','authorization':'fixture-only','proxy-authorization':'fixture-only'}}));vi.stubGlobal('fetch',fetch);return fetch}

it('matches HTTP and HTML node outputs on literal and cached paths, with raw bytes and redacted headers',async()=>{
  const f=setup()
  for(const body of [html,'<!--'+'n'.repeat(HTTP_CACHE_THRESHOLD)+'-->'+html]){
    mockResponse(body)
    const input={url:'https://page.test/trending',headers:{Accept:'text/html'}}
    const actual=await f.call('workflow_http_request',input),node=await f.adapters.execute('http',f.request('http',input))
    expect(actual.headers).toEqual({'content-type':'text/html'})
    if(typeof actual.text==='string')expect(actual).toEqual(node)
    else {
      const a=actual.text as CachedBody,b=node.text as CachedBody
      expect(a.$cachedBody.runId).not.toBe(f.run.id)
      expect({...a.$cachedBody,id:'id',runId:'run'}).toEqual({...b.$cachedBody,id:'id',runId:'run'})
      expect(actual.body).toEqual(actual.text)
      expect(f.storage.readCachedBody(a.$cachedBody.runId,a).toString()).toBe(body)
      expect(JSON.stringify(actual)).not.toContain(body)
    }
    for(const [name,toolId,args] of [
      ['workflow_html_extract_text','builtin:html.extract_text',{statusCode:200}],
      ['workflow_html_select','builtin:html.select',selectArgs],
    ] as const){
      expect(await f.call(name,{...args,html:actual.text})).toEqual(await f.adapters.execute('tool',f.request('tool',{...args,html:node.text},{toolId})))
    }
  }
})

it('resolves a stringified or trimmed cache reference this lease issued, by id only',async()=>{
  const f=setup(),body='<!--'+'n'.repeat(HTTP_CACHE_THRESHOLD)+'-->'+html;mockResponse(body)
  const ref=(await f.call('workflow_http_request',{url:'https://page.test/trending'})).body as CachedBody,{id,runId}=ref.$cachedBody
  const expected=await f.call('workflow_html_select',{...selectArgs,html:ref})
  expect(expected.count).toBe(1)
  for(const html of [JSON.stringify(ref),JSON.stringify({$cachedBody:{id,runId}}),{$cachedBody:{id}},JSON.stringify({id,runId})])
    expect(await f.call('workflow_html_select',{...selectArgs,html})).toEqual(expected)
  for(const html of [JSON.stringify({$cachedBody:{id:randomUUID(),runId}}),{$cachedBody:{id:'missing'}}])
    await expect(f.call('workflow_html_select',{...selectArgs,html})).rejects.toThrow('缓存引用无效或已过期')
  // Literal HTML and non-reference JSON text keep the node's literal-string path.
  expect((await f.call('workflow_html_select',{...selectArgs,html:'{"id":1}'})).count).toBe(0)
  expect((await f.call('workflow_html_select',{...selectArgs,html})).count).toBe(1)
})

it('returns a cache reference above the session inline limit while node output stays inline, with equal HTML results',async()=>{
  const f=setup(),body='<!--'+'n'.repeat(SESSION_HTTP_INLINE_LIMIT)+'-->'+html;mockResponse(body)
  expect(Buffer.byteLength(body)).toBeLessThan(HTTP_CACHE_THRESHOLD)
  const input={url:'https://page.test/trending'},actual=await f.call('workflow_http_request',input),node=await f.adapters.execute('http',f.request('http',input))
  expect(typeof node.text).toBe('string')
  const ref=actual.body as CachedBody
  expect(actual.text).toEqual(ref);expect(actual.json).toBeUndefined();expect(ref.$cachedBody.bytes).toBe(Buffer.byteLength(body))
  expect(JSON.stringify(actual)).not.toContain(body)
  expect(await f.call('workflow_html_select',{...selectArgs,html:ref})).toEqual(await f.adapters.execute('tool',f.request('tool',{...selectArgs,html:node.text},{toolId:'builtin:html.select'})))
  mockResponse(html);expect((await f.call('workflow_http_request',input)).text).toBe(html)
})

it('shares HTTP normalization, JSON decoding, redirect policy, schemes and download limit',async()=>{
  const f=setup(),fetch=mockResponse('{"ok":true}'),input={url:'https://page.test',method:'post',body:{a:1},headers:{'x-count':2},timeoutMs:1000}
  expect(await f.call('workflow_http_request',input)).toEqual(await f.adapters.execute('http',f.request('http',input,{method:'post',timeoutMs:1000})))
  expect(fetch.mock.calls[0]![1]).toMatchObject({method:'POST',body:'{"a":1}',headers:{'x-count':'2'},redirect:'manual'})
  for(const url of ['file:///tmp/page','ftp://page.test','https://fixture:fixture@page.test'])await expect(f.call('workflow_http_request',{url})).rejects.toThrow('无内嵌凭证')
  expect(fetch).toHaveBeenCalledTimes(2)
  mockResponse('x'.repeat(HTTP_DOWNLOAD_LIMIT+1))
  await expect(f.call('workflow_http_request',{url:'https://page.test'})).rejects.toThrow('10 MB')
})

it('rejects another session, workspace, or workflow owner even with an exact cache reference',async()=>{
  const f=setup();mockResponse(html+' '.repeat(HTTP_CACHE_THRESHOLD))
  const ref=(await f.call('workflow_http_request',{url:'https://page.test'})).text as CachedBody
  f.switchSession('other');await expect(f.call('workflow_html_select',{...selectArgs,html:ref})).rejects.toThrow('不属于本次运行')
  f.switchSession('session');f.switchWorkspace('other');await expect(f.call('workflow_html_select',{...selectArgs,html:ref})).rejects.toThrow('不属于本次运行')
  f.switchWorkspace('workspace');expect((await f.call('workflow_html_select',{...selectArgs,html:ref})).count).toBe(1)
  const foreign=f.storage.cacheHttpBody(f.run.id,'node',1,Buffer.from(html),'text/html')
  await expect(f.call('workflow_html_select',{...selectArgs,html:foreign})).rejects.toThrow('不属于本次运行')
})

it('leases immediate-cleanup bodies between calls, then expires without permanent active protection',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});const f=setup();f.storage.saveHttpCacheSettings({httpCacheImmediateCleanup:true});mockResponse(html+' '.repeat(HTTP_CACHE_THRESHOLD))
  const ref=(await f.call('workflow_http_request',{url:'https://page.test'})).text as CachedBody,folder=join(f.directory,'http-cache',ref.$cachedBody.runId)
  expect(existsSync(folder)).toBe(true)
  vi.advanceTimersByTime(SESSION_HTTP_CACHE_IDLE_MS-1)
  expect((await f.call('workflow_html_select',{...selectArgs,html:ref})).count).toBe(1)
  vi.advanceTimersByTime(1);expect(existsSync(folder)).toBe(true)
  vi.advanceTimersByTime(SESSION_HTTP_CACHE_IDLE_MS-1);expect(existsSync(folder)).toBe(false)
  await expect(f.call('workflow_html_select',{...selectArgs,html:ref})).rejects.toThrow('已清理')
  expect(f.storage.runs('workspace').map(r=>r.id)).toEqual([f.run.id])
})

it('protects in-flight calls and cleans their cache lease after cancellation',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']})
  const f=setup();f.storage.saveHttpCacheSettings({httpCacheImmediateCleanup:true});mockResponse(html+' '.repeat(HTTP_CACHE_THRESHOLD))
  const ref=(await f.call('workflow_http_request',{url:'https://page.test'})).text as CachedBody,folder=join(f.directory,'http-cache',ref.$cachedBody.runId)
  const abort=new AbortController()
  vi.stubGlobal('fetch',vi.fn((_url:unknown,options:RequestInit)=>new Promise<Response>((_resolve,reject)=>options.signal!.addEventListener('abort',()=>reject(options.signal!.reason),{once:true}))))
  const pending=f.call('workflow_http_request',{url:'https://page.test'},abort.signal),rejected=expect(pending).rejects.toThrow('取消租约')
  vi.advanceTimersByTime(SESSION_HTTP_CACHE_IDLE_MS*2);expect(existsSync(folder)).toBe(true)
  abort.abort(new Error('取消租约'));await rejected
  expect(existsSync(folder)).toBe(false)
})

it('retains idle bodies under the default policy, shares quota with runs, and removes session orphans at startup',async()=>{
  vi.useFakeTimers();const f=setup();f.storage.saveHttpCacheSettings({httpCacheLimitMB:20});mockResponse('x'.repeat(8_000_000))
  const ref=(await f.call('workflow_http_request',{url:'https://page.test'})).text as CachedBody,folder=join(f.directory,'http-cache',ref.$cachedBody.runId)
  vi.advanceTimersByTime(SESSION_HTTP_CACHE_IDLE_MS);expect(existsSync(folder)).toBe(true)
  f.storage.cacheHttpBody(f.run.id,'node',1,Buffer.alloc(8_000_000),'text/html')
  f.storage.cacheHttpBody(f.run.id,'node',2,Buffer.alloc(8_000_000),'text/html')
  expect(existsSync(folder)).toBe(false)
  expect(readdirSync(join(f.directory,'http-cache',f.run.id)).length).toBe(4)
  // Simulate a lost process: no session owner metadata survives in library.json.
  const crash=setup();mockResponse(html+' '.repeat(HTTP_CACHE_THRESHOLD))
  const orphan=(await crash.call('workflow_http_request',{url:'https://page.test'})).text as CachedBody
  crash.executor.close()
  ;(crash.storage as any).sessionHttpOwners.clear()
  crash.storage.close()
  const restored=new WorkflowStorage(crash.directory)
  try{expect(existsSync(join(crash.directory,'http-cache',orphan.$cachedBody.runId))).toBe(false)}finally{restored.close()}
})

it('removes transient session bodies on orderly storage shutdown',async()=>{
  const f=setup();mockResponse(html+' '.repeat(HTTP_CACHE_THRESHOLD))
  const ref=(await f.call('workflow_http_request',{url:'https://page.test'})).text as CachedBody,folder=join(f.directory,'http-cache',ref.$cachedBody.runId)
  expect(existsSync(folder)).toBe(true)
  f.executor.close();f.storage.close();expect(existsSync(folder)).toBe(false)
})

it('honors pre-abort, download abort, HTML abort and plugin disposal without real network',async()=>{
  const f=setup(),controller=new AbortController();controller.abort(new Error('已取消'))
  const fetch=mockResponse(html)
  for(const name of ['workflow_http_request','workflow_html_extract_text','workflow_html_select'] as const)await expect(f.call(name,{url:'https://page.test',html,...selectArgs},controller.signal)).rejects.toThrow('已取消')
  expect(fetch).not.toHaveBeenCalled()
  for(const dispose of [false,true]){
    const current=dispose?setup():f,abort=new AbortController()
    let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve})
    vi.stubGlobal('fetch',vi.fn(async(_url:unknown,options:RequestInit)=>new Response(new ReadableStream({start(stream){stream.enqueue(new Uint8Array(20));options.signal!.addEventListener('abort',()=>stream.error(options.signal!.reason),{once:true});started()}}))))
    const pending=current.call('workflow_http_request',{url:'https://page.test'},abort.signal)
    const rejected=expect(pending).rejects.toThrow(dispose?'已关闭':'下载取消')
    await ready;if(dispose)current.executor.close();else abort.abort(new Error('下载取消'))
    await rejected
  }
  const abort=new AbortController(),pending=f.call('workflow_html_select',{...selectArgs,html:'<article>x</article>'.repeat(20000)},abort.signal)
  abort.abort(new Error('HTML 取消'));await expect(pending).rejects.toThrow('HTML 取消')
})

it('leaves probing to the trial: the main agent guidance names the tools without asking it to record selectors (Desktop r38)',async()=>{
  const {WORKFLOW_SESSION_TOOL_GUIDANCE,WORKFLOW_SESSION_TOOL_PLAN_GUIDANCE}=await import('../src/shared/workflow-session-tools.ts')
  expect(WORKFLOW_SESSION_TOOL_GUIDANCE).toContain('记录实际地址、选择器和字段')
  expect(WORKFLOW_SESSION_TOOL_PLAN_GUIDANCE).toContain('不必先自己试抓')
  expect(WORKFLOW_SESSION_TOOL_PLAN_GUIDANCE).toContain('声明了产物文件时再加 write，回读核对再加 read')
  expect(WORKFLOW_SESSION_TOOL_PLAN_GUIDANCE).toContain('不在 visible_workflow_tools 工具目录里')
  expect(WORKFLOW_SESSION_TOOL_PLAN_GUIDANCE).not.toContain('供生成工作流时照搭节点')
})
