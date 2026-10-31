import {afterEach,describe,expect,it,vi} from 'vitest'
import {mkdtempSync,readFileSync,readdirSync,rmSync,existsSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {gzipSync} from 'node:zlib'
import {WorkflowStorage} from '../src/host/storage.ts'
import {WorkflowRuntime} from '../src/host/runtime.ts'
import {createExecutionAdapters,httpRequest} from '../src/host/execution-adapters.ts'
import {extractStaticHtml} from '../src/host/static-html-text.ts'
import {ToolCatalog} from '../src/host/tool-catalog.ts'
import {WorkflowAuthoringCompiler} from '../src/shared/planning-authoring.ts'
import {TemplateFillingCompiler} from '../src/shared/planning-template-compiler.ts'
import {storedWorkflowNodeConfigSchema,workflowNodeConfigSchema,parseWorkflow} from '../src/shared/workflow-validation.ts'
import {fragmentCatalog,fragmentContract} from '../src/shared/planning-module-fragment-contract.ts'
import {buildPlanningCommandBrief} from '../src/host/planning/command-brief.ts'
import {templateContext} from './fixtures/planning-compiler/template.ts'
import type {CachedBody} from '../src/shared/http-cache.ts'

const url='https://example.invalid/page',forbidden=async()=>{throw Error('No network/model/tool call allowed')}
function compile(next:any={kind:'code',config:{language:'javascript',code:'function main(inputs){return {text:String(inputs.html.length)}}',inputs:{html:'{{web.text}}'}}},pause=false){
  const result=new WorkflowAuthoringCompiler(templateContext()).submit({submission:{mode:'create',title:'raw HTTP',nodes:[
    {key:'start',kind:'input',config:{fields:[]}},
    {key:'web',kind:'http',config:{url,method:'GET'}},
    ...(pause?[{key:'review',kind:'human',config:{prompt:'继续',actions:[{id:'continue',label:'继续'}],fields:[]}}]:[]),
    {key:'consume',...next},
    {key:'result',kind:'output',config:{text:'{{consume.text}}',outputName:'result'}},
  ],chains:[{key:'main',nodes:['start','web',...(pause?['review']:[]),'consume','result']}],coverage:{R1:['web','consume','result']}}})
  if(!result.ok)throw Error(JSON.stringify(result.feedback));return result.value.candidate!
}
function dense(bytes:number){const prefix='<title>Dense &amp; title</title><body><main>',suffix='</main></body>',unit='<b>x</b>',n=bytes-prefix.length-suffix.length;return prefix+unit.repeat(Math.floor(n/unit.length))+'x'.repeat(n%unit.length)+suffix}
function responseStream(bytes:Uint8Array,status=200,headers:Record<string,string>={'content-type':'text/html'}){
  let sent=0,cancelled=false
  const stream=new ReadableStream<Uint8Array>({pull(controller){if(sent===bytes.length){controller.close();return}const end=Math.min(sent+65536,bytes.length);controller.enqueue(bytes.subarray(sent,end));sent=end},cancel(){cancelled=true}},{highWaterMark:0})
  return {response:new Response(stream,{status,headers}),sent:()=>sent,cancelled:()=>cancelled}
}
const contexts:{runtime:WorkflowRuntime;storage:WorkflowStorage;directory:string}[]=[]
function setup(){
  const directory=mkdtempSync(join(tmpdir(),'raw-http-')),storage=new WorkflowStorage(directory)
  const catalog=new ToolCatalog({directory,workflows:id=>storage.workflows(id),nativeTools:()=>[],executeNative:forbidden,runWorkflow:forbidden,http:forbidden as typeof httpRequest})
  const runtime=new WorkflowRuntime(storage,{generate:forbidden},createExecutionAdapters({catalog,workspaceRoot:()=>directory}),undefined,{runtimeDirectory:process.env.DSH_WORKFLOW_RUNTIME_DIRECTORY})
  const ctx={directory,storage,runtime};contexts.push(ctx);return ctx
}
async function run(candidate=compile()) {const ctx=setup(),flow=ctx.storage.save(candidate,0),result=await ctx.runtime.settle(ctx.runtime.start(flow.id,{}).id);return {...ctx,flow,run:result}}
afterEach(async()=>{vi.unstubAllGlobals();for(const ctx of contexts.splice(0)){await ctx.runtime.close();ctx.storage.close();rmSync(ctx.directory,{recursive:true,force:true})}})

describe('T24.4a raw HTTP and response cache',()=>{
  it.each(['plain','json','boundary','unicode'])('preserves <=256 KB %s response fields byte-for-byte',async kind=>{
    const body=kind==='json'?'{ "a": [1,true], "z": "中文" }':kind==='boundary'?'x'.repeat(262144):kind==='unicode'?'中'.repeat(87381):'<body>raw &amp; text</body>'
    const headers={'content-type':'text/html','set-cookie':'hidden','authorization':'hidden','proxy-authorization':'hidden','x-test':'kept'}
    vi.stubGlobal('fetch',async()=>responseStream(Buffer.from(body),200,headers).response)
    const expected={text:body,body,bytes:Buffer.byteLength(body),status_code:200,headers:{'content-type':'text/html','x-test':'kept'},...(kind==='json'?{json:JSON.parse(body)}:{})}
    expect(await httpRequest(url,'GET',{},undefined,new AbortController().signal)).toEqual(expected)
    const result=await run(),data=result.run.executions.find(e=>e.kind==='http'||e.nodeId===result.flow.nodes.find(n=>n.kind==='http')!.id)!.data
    expect(data).toEqual(expected);expect(result.run.status,result.run.error).toBe('success');expect(existsSync(join(result.directory,'http-cache'))).toBe(false)
  },30_000)
  it.each([262145,535_000,2_900_000,10_000_000])('stores %i bytes as one shared ref, reads fully and enforces code limits',async bytes=>{
    const body=dense(bytes);vi.stubGlobal('fetch',async()=>responseStream(Buffer.from(body)).response)
    const result=await run(),record=result.run.executions.find(e=>e.nodeId===result.flow.nodes.find(n=>n.kind==='http')!.id)!,data=record.data!,ref=data.text as CachedBody
    expect(record.status).toBe('success');expect(data.body).toEqual(ref);expect(data.json).toBeUndefined();expect(ref.$cachedBody.bytes).toBe(bytes);expect(data.bytes).toBe(bytes);expect(ref.$cachedBody.preview).toBe(body.slice(0,2000))
    expect(result.storage.readCachedBody(result.run.id,ref).toString()).toBe(body)
    expect(JSON.stringify(data).length).toBeLessThan(6000)
    expect(readdirSync(join(result.directory,'http-cache',result.run.id))).toHaveLength(2)
    expect(result.run.status,result.run.error).toBe(bytes>2_000_000?'failed':'success')
    if(bytes>2_000_000)expect(result.run.error).toContain('HTML 处理');else expect(result.run.outputs.result).toBe(String(bytes))
    expect(JSON.stringify(result.run)).not.toContain(body)
    for(const name of readdirSync(join(result.directory,'runs')))expect(readFileSync(join(result.directory,'runs',name),'utf8')).not.toContain(body)
  },30_000)
  it('validates minimum text length against the full HTTP response',async()=>{
    const body=JSON.stringify({text:'x'.repeat(300000)});vi.stubGlobal('fetch',async()=>responseStream(Buffer.from(body)).response)
    const flow=compile(),http=flow.nodes.find(node=>node.kind==='http')!
    http.config.verification={minTextLength:300000}
    const result=await run(flow);expect(result.run.status,result.run.error).toBe('success');expect(result.run.executions.find(e=>e.nodeId===http.id)!.data!.json).toBeUndefined()
  },30_000)
  it('keeps original non-UTF8 bytes in cache before decoding',async()=>{
    const body=Buffer.alloc(300000,0xff);vi.stubGlobal('fetch',async()=>responseStream(body).response)
    const result=await run(),ref=result.run.executions.find(e=>e.nodeId===result.flow.nodes.find(n=>n.kind==='http')!.id)!.data!.body as CachedBody
    expect(result.storage.readCachedBody(result.run.id,ref)).toEqual(body)
  },30_000)
  it.each(['text','body','json.payload'])('lazily resolves %s through template input without persisting full content',async path=>{
    const payload='q'.repeat(535000),body=JSON.stringify({payload});vi.stubGlobal('fetch',async()=>responseStream(Buffer.from(body)).response)
    const result=await run(compile({kind:'template',config:{inputs:{page:'{{web.'+path+'}}'},text:'{{page | length}}'}}))
    expect(result.run.status,result.run.error).toBe('success');expect(result.run.outputs.result).toBe(String(path==='json.payload'?payload.length:body.length));expect(JSON.stringify(result.run)).not.toContain(payload)
  },30_000)
  it.each([false,true])('resolves 2.9 MB across Host restart, with tamper=%s',async tamper=>{
    const body=dense(2_900_000),fetch=vi.fn(async()=>responseStream(Buffer.from(body)).response);vi.stubGlobal('fetch',fetch)
    const ctx=setup(),flow=ctx.storage.save(compile({kind:'template',config:{text:'{{web.body | length}}'}},true),0)
    const waiting=await ctx.runtime.settle(ctx.runtime.start(flow.id,{}).id);expect(waiting.status).toBe('waiting')
    const ref=waiting.executions.find(e=>e.nodeId===flow.nodes.find(n=>n.kind==='http')!.id)!.data!.text as CachedBody
    await ctx.runtime.close()
    if(tamper)writeFileSync(join(ctx.directory,'http-cache',waiting.id,ref.$cachedBody.id+'.body'),'tampered')
    ctx.storage=new WorkflowStorage(ctx.directory);ctx.runtime=new WorkflowRuntime(ctx.storage,{generate:forbidden},undefined,undefined,{runtimeDirectory:process.env.DSH_WORKFLOW_RUNTIME_DIRECTORY})
    expect(ctx.storage.run(waiting.id).status).toBe('waiting')
    ctx.runtime.answer(waiting.id,{__action:'continue'});const result=await ctx.runtime.settle(waiting.id)
    expect(fetch).toHaveBeenCalledTimes(1)
    if(tamper){expect(result.status).toBe('failed');expect(result.error).toContain('sha256 校验失败');expect(result.error).toContain('重跑抓取节点')}
    else{expect(result.status,result.error).toBe('success');expect(result.outputs.result).toBe('2900000')}
  },30_000)
  it('keeps the 1 MB node output cap before compacting a downstream echoed body',async()=>{
    vi.stubGlobal('fetch',async()=>responseStream(Buffer.from(dense(535000))).response)
    const result=await run(compile({kind:'code',config:{language:'javascript',code:'function main(inputs){return {text:inputs.html,body:inputs.html}}',inputs:{html:'{{web.text}}'}}}))
    expect(result.run.status).toBe('failed');expect(result.run.error).toContain('节点输出超过 1 MB 限制')
  },30_000)
  it('keeps full-body echoes in cache after downstream output checks',async()=>{
    const body=dense(535000);vi.stubGlobal('fetch',async()=>responseStream(Buffer.from(body)).response)
    const result=await run(compile({kind:'code',config:{language:'javascript',code:'function main(inputs){return {text:"prefix:"+inputs.html}}',inputs:{html:'{{web.text}}'}}}))
    expect(result.run.status,result.run.error).toBe('success');expect(JSON.stringify(result.run)).not.toContain(body)
    const ref=JSON.parse(result.run.outputs.result!) as CachedBody;expect(result.storage.readCachedBody(result.run.id,ref).toString()).toBe('prefix:'+body)
  },30_000)
  it('resolves cached JSON for existing Host-only builtin tools',async()=>{
    vi.stubGlobal('fetch',async()=>responseStream(Buffer.from(JSON.stringify({padding:'x'.repeat(300000),result:'selected'}))).response)
    const flow=compile(),consumer=flow.nodes.find(node=>node.kind==='code')!
    consumer.kind='tool';consumer.config={toolId:'builtin:json.select',inputs:{value:'{{'+flow.nodes.find(node=>node.kind==='http')!.id+'.json}}',path:'result'}}
    const result=await run(flow);expect(result.run.status,result.run.error).toBe('success');expect(result.run.outputs.result).toBe('selected')
  },30_000)
  it('passes the full cached body to downstream remote nodes while records keep only the reference',async()=>{
    const body=dense(535000),sent:string[]=[]
    vi.stubGlobal('fetch',async(_url:unknown,init?:RequestInit)=>{if(typeof init?.body==='string')sent.push(init.body);return responseStream(Buffer.from(body)).response})
    const result=await run(compile({kind:'http',config:{method:'POST',url:'https://example.com/echo',headers:{},bodyText:'{{web.text}}',timeoutMs:30000}}))
    expect(result.run.status,result.run.error).toBe('success');expect(sent).toEqual([body]);expect(JSON.stringify(result.run)).not.toContain(body)
  },30_000)
  it('rejects rendering cached full text in the human form',async()=>{
    vi.stubGlobal('fetch',async()=>responseStream(Buffer.from(dense(535000))).response)
    const result=await run(compile({kind:'human',config:{prompt:'{{web.text}}',actions:[{id:'continue',label:'继续'}],fields:[]}}))
    expect(result.run.status).toBe('failed');expect(result.run.error).toContain('缓存全文不能直接显示在人工节点界面');expect(result.run.humanPrompt).toBeUndefined()
  },30_000)
  it('does not raise template output limit for cached bodies',async()=>{
    vi.stubGlobal('fetch',async()=>responseStream(Buffer.from(dense(2_900_000))).response)
    const result=await run(compile({kind:'template',config:{text:'{{web.body}}'}}));expect(result.run.status).toBe('failed');expect(result.run.error).toMatch(/400000 字符/)
  },30_000)
  it.each([10_000_001,10_500_000])('fails >10 MB (%i decompressed bytes), cancels stream and exposes no partial body',async bytes=>{
    const compressed=gzipSync(dense(bytes));vi.stubGlobal('fetch',async()=>new Response(responseStream(compressed).response.body!.pipeThrough(new DecompressionStream('gzip')),{headers:{'content-length':String(compressed.length)}}))
    const result=await run();expect(result.run.status).toBe('failed');expect(result.run.error).toContain('响应超过 10 MB 上限');expect(result.run.executions.find(e=>e.nodeId===result.flow.nodes.find(n=>n.kind==='http')!.id)!.data).toBeUndefined()
    const stream=responseStream(Buffer.alloc(bytes));vi.stubGlobal('fetch',async()=>stream.response)
    await expect(httpRequest(url,'GET',{},undefined,new AbortController().signal)).rejects.toThrow('响应超过 10 MB 上限');expect(stream.cancelled()).toBe(true)
  },30_000)
  it.each([302,404,500])('returns status %i and original body instead of extracting or skipping',async status=>{
    const body='<html><title>raw</title><body>full</body></html>',fetch=vi.fn(async(_url:URL,init:RequestInit)=>{expect(init.redirect).toBe('manual');return responseStream(Buffer.from(body),status).response});vi.stubGlobal('fetch',fetch)
    expect(await httpRequest(url,'GET',{},undefined,new AbortController().signal)).toEqual({text:body,body,bytes:Buffer.byteLength(body),status_code:status,headers:{'content-type':'text/html'}});expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('preserves URL, cancellation, method, transport and timeout safeguards',async()=>{
    const call=(signal=new AbortController().signal,method='GET',address=url)=>httpRequest(address,method,{},undefined,signal,100)
    const fetch=vi.fn(async()=>{throw Error('fixture transport error')});vi.stubGlobal('fetch',fetch)
    for(const address of ['file:///page','https://user:pass@example.invalid'])await expect(call(undefined,'GET',address)).rejects.toThrow('无内嵌凭证')
    await expect(call(undefined,'INVALID')).rejects.toThrow('方法');expect(fetch).not.toHaveBeenCalled();await expect(call()).rejects.toThrow('fixture transport error')
    const controller=new AbortController();controller.abort(new Error('fixture cancellation'));await expect(call(controller.signal)).rejects.toThrow('fixture cancellation')
    vi.stubGlobal('fetch',async(_url:URL,init:RequestInit)=>new Promise((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(init.signal!.reason),{once:true})))
    await expect(call()).rejects.toThrow(/timeout/i)
  })
  it('rejects leftover hidden mode and removes 1.0.0 from both contracts/catalog/brief',()=>{
    const config={url,method:'GET',responseMode:'static-html-text'},flow=compile();Object.assign(flow.nodes.find(n=>n.kind==='http')!.config,config)
    expect(()=>parseWorkflow(flow)).toThrow('已移除的未知字段 responseMode')
    expect(storedWorkflowNodeConfigSchema('http').safeParse(config).success).toBe(false);expect(workflowNodeConfigSchema('http').safeParse(config).success).toBe(false)
    expect(JSON.stringify(fragmentCatalog())).not.toContain('web-extract@1.0.0');expect((fragmentContract().items as any).oneOf).toHaveLength(5)
    for(const C of [WorkflowAuthoringCompiler,TemplateFillingCompiler]){const compiler=new C(templateContext());expect(JSON.stringify(compiler.schema)).not.toContain('web-extract@1.0.0');expect(JSON.stringify(compiler.nextSchema)).not.toContain('responseMode')}
    const brief=buildPlanningCommandBrief('workspace',[]);expect(brief).not.toContain('web-extract@1.0.0');expect(brief).toContain('下游引用取全文');expect(Buffer.byteLength(brief)).toBeLessThan(8000)
  })
  it('yields to cancellation during dense Host extraction',async()=>{
    const controller=new AbortController(),pending=extractStaticHtml(dense(10_000_000),controller.signal)
    controller.abort(new Error('cancel during extraction'))
    await expect(pending).rejects.toThrow('cancel during extraction')
  })
  it('handles long whitespace, quoted/malformed tags, boundaries, entities and empty preferred main in linear scan',async()=>{
    expect(await extractStaticHtml('<body>'+ ' '.repeat(1_000_000)+'<p>A&amp;<b>B</b></p><div title="a>b">&#x1f600; &#0; &unknown;</div></body>')).toEqual({title:'',text:'A&B 😀 � &unknown;',truncated:false})
    expect(await extractStaticHtml('<body>body<article>article</article><main> <!-- hidden --><script>bad</script></main></body>')).toEqual({title:'',text:'',truncated:false})
    expect(await extractStaticHtml('<body>valid<bad title="'+'x'.repeat(1_000_000))).toEqual({title:'',text:'valid',truncated:false})
  })
})
