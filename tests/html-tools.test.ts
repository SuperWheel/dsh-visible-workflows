import {afterEach,describe,expect,it,vi} from 'vitest'
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {executeHtml} from '../src/host/html-tools.ts'
import {extractStaticHtml} from '../src/host/static-html-text.ts'
import {ToolCatalog,BUILTIN_TOOLS} from '../src/host/tool-catalog.ts'
import {WorkflowStorage} from '../src/host/storage.ts'
import {WorkflowRuntime,type AdapterRequest} from '../src/host/runtime.ts'
import {createExecutionAdapters} from '../src/host/execution-adapters.ts'
import {WorkflowAuthoringCompiler} from '../src/shared/planning-authoring.ts'
import {templateContext} from './fixtures/planning-compiler/template.ts'
import {isCachedBody} from '../src/shared/http-cache.ts'
const extract=(args:any,signal?:AbortSignal)=>executeHtml('builtin:html.extract_text',args,signal)
const select=(args:any,signal?:AbortSignal)=>executeHtml('builtin:html.select',args,signal)
const forbidden=async()=>{throw Error('No model/network/native calls')}
afterEach(()=>vi.unstubAllGlobals())
describe('Host HTML tools',()=>{
  it.each([
    ['<head><title>A &amp; B</title></head><body>nav<main>Hello <b>world</b><script>hide</script></main></body>','A & B','Hello world'],
    ['<body>nav<article>A&#x4e2d;</article><article>B&nbsp; C</article></body>','','A中 B C'],
    ['<body>fallback<main><style>hide</style></main></body>','',''],
    ['<title>T</title>no body','T',''],
    ['<body><p>Hi</p><!-- hide --><div title="a>b">next &unknown;</div></body>','','Hi next &unknown;'],
  ])('preserves prior extractor rules on %s',async(html,title,text)=>{
    expect(await extractStaticHtml(html)).toEqual({title,text,truncated:false})
    expect(await extract({html})).toEqual({status:text?'ok':'empty',title,text,truncated:false})
  })
  it('reports status precedence, optional HTTP metadata and exact truncation boundaries',async()=>{
    const html='<title>T</title><body>12345</body>'
    expect(await extract({html,statusCode:404,contentType:'application/json'})).toEqual({status:'http_error',title:'',text:'',truncated:false,httpStatus:404})
    expect(await extract({html,statusCode:200,headers:{'Content-Type':'text/plain'},url:'https://x.test'})).toMatchObject({status:'not_html',url:'https://x.test',httpStatus:200})
    expect(await extract({html,contentType:'TEXT/HTML; charset=utf-8',maxChars:5})).toMatchObject({text:'12345',truncated:false})
    expect(await extract({html,maxChars:4})).toMatchObject({text:'1234',truncated:true})
    expect(await extract({html:'<body>'+ 'a'.repeat(200001)+'</body>',maxChars:200000})).toMatchObject({text:'a'.repeat(200000),truncated:true})
    for(const maxChars of [0,200001,1.5,'20'])await expect(extract({html,maxChars})).rejects.toThrow('maxChars')
  })
  it('selects nested CSS, malformed HTML, attributes, text and absolute or unresolved links',async()=>{
    const result=await select({html:'<article><h2><a href="/a?x=1&amp;y=2"> A <b>B</b></a></h2><img src="//img.test/a"><p>open<article><h2>Other</h2><a href="http://[">bad',items:'article',baseUrl:'https://example.test/page',fields:{name:{selector:'h2',text:true},link:{selector:'h2 > a',attr:'href'},src:{selector:'img',attr:'src'},missing:{selector:'.absent',text:true}},limit:1})
    expect(result).toEqual({count:1,items:[{name:'A B',link:'https://example.test/a?x=1&y=2',src:'https://img.test/a',missing:''}],text:JSON.stringify([{name:'A B',link:'https://example.test/a?x=1&y=2',src:'https://img.test/a',missing:''}])})
    const unresolved=await select({html:'<a href="http://[">x</a><a href="relative">y</a>',items:'a',fields:{link:{attr:'href'}}})
    expect(unresolved.items).toEqual([{link:'http://[',_unresolvedLinks:['link']},{link:'relative',_unresolvedLinks:['link']}])
  })
  it('enforces field shapes, selectors and limits without silent output truncation',async()=>{
    const base={html:'<b>x</b>'.repeat(501),items:'b',fields:{text:{text:true}}}
    expect((await select(base)).count).toBe(100);expect((await select({...base,limit:500})).count).toBe(500)
    for(const limit of [0,501,1.1,'5'])await expect(select({...base,limit})).rejects.toThrow('limit')
    for(const fields of [{},Object.fromEntries(Array.from({length:21},(_,i)=>['f'+i,{text:true}])),{a:{text:false}},{a:{attr:'href',text:true}},{a:{selector:4,text:true}},{_unresolvedLinks:{text:true}}])await expect(select({...base,fields})).rejects.toThrow('fields')
    await expect(select({...base,items:'['})).rejects.toThrow()
    await expect(select({...base,html:'',fields:{a:{selector:'[',text:true}}})).rejects.toThrow()
    await expect(select({...base,html:'<b>'+ 'x'.repeat(510000)+'</b>'})).rejects.toThrow('节点输出超过 1 MB')
  })
  it('yields on 10 MB pages and cancels parsing and selection cooperatively',async()=>{
    const prefix='<body><a href="/last">tail</a>',suffix='</body>',padding=10_000_000-prefix.length-suffix.length,html=prefix+'<i>x</i>'.repeat(Math.floor(padding/8))+' '.repeat(padding%8)+suffix,start=performance.now();let ticks=0
    const timer=setInterval(()=>ticks++,1)
    try{const result=await select({html,items:'a',baseUrl:'https://example.test',fields:{link:{attr:'href'}}});expect(result.items).toEqual([{link:'https://example.test/last'}]);expect(ticks).toBeGreaterThan(0);console.log('html.select bytes/ms/timerTicks',Buffer.byteLength(html),performance.now()-start,ticks)}finally{clearInterval(timer)}
    for(const invoke of [select,extract]){const controller=new AbortController(),pending=invoke({html,items:'i',fields:{text:{text:true}}},controller.signal);setTimeout(()=>controller.abort(Error('fixture cancel')),1);await expect(pending).rejects.toThrow('fixture cancel')}
    const selection=new AbortController(),check=selection.signal.throwIfAborted.bind(selection.signal);let checks=0
    vi.spyOn(selection.signal,'throwIfAborted').mockImplementation(()=>{if(++checks>1+Math.ceil(html.length/16384)*2)selection.abort(Error('cancel during selection'));check()})
    await expect(select({html,items:'.missing',fields:{text:{text:true}}},selection.signal)).rejects.toThrow('cancel during selection')
    const controller=new AbortController();controller.abort(Error('already cancelled'));await expect(select({html:'',items:'a',fields:{text:{text:true}}},controller.signal)).rejects.toThrow('already cancelled')
  },30000)
  it('only HTML catalog tools accept full cache handles; other builtin argument validation is unchanged',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'html-catalog-'))
    try{
      const catalog=new ToolCatalog({directory,workflows:()=>[],nativeTools:()=>[],executeNative:forbidden,runWorkflow:forbidden,http:forbidden}),read=vi.fn(()=>Buffer.from('<body>full</body>'))
      const request={signal:new AbortController().signal,readCachedBody:read,workspaceId:'w',runId:'r'} as unknown as AdapterRequest
      const ref={$cachedBody:{id:'id',runId:'r',bytes:17,sha256:'digest',contentType:'text/html',preview:'preview'}}
      expect(await catalog.execute('builtin:html.extract_text',{html:ref},request)).toMatchObject({text:'full'});expect(read).toHaveBeenCalledWith(ref)
      await expect(catalog.execute('builtin:json.parse',{text:ref},request)).rejects.toThrow();expect(read).toHaveBeenCalledTimes(1)
      await expect(catalog.execute('builtin:html.select',{html:'x',items:4,fields:{a:{text:true}}},request)).rejects.toThrow('工具参数无效')
    }finally{rmSync(directory,{recursive:true,force:true})}
  })
  it('runs 535 KB cached HTTP → html.select → template, retains handles in records and fails oversized output',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'html-e2e-')),storage=new WorkflowStorage(directory),catalog=new ToolCatalog({directory,workflows:()=>[],nativeTools:()=>[],executeNative:forbidden,runWorkflow:forbidden,http:forbidden}),spy=vi.spyOn(catalog,'execute')
    const runtime=new WorkflowRuntime(storage,{generate:forbidden},createExecutionAdapters({catalog,workspaceRoot:()=>directory}))
    let html='<body><a href="/owner/repo">Repo</a>'+' '.repeat(535000-41)+'</body>'
    vi.stubGlobal('fetch',async()=>new Response(html,{headers:{'content-type':'text/html'}}))
    try{
      const doc={mode:'create',title:'HTML',nodes:[{key:'start',kind:'input',config:{fields:[]}},{key:'http',kind:'http',config:{url:'https://example.test'}},{key:'select',kind:'tool',config:{toolId:'builtin:html.select',inputs:{html:'{{http.text}}',items:'a',baseUrl:'https://example.test',fields:{link:{attr:'href'},name:{text:true}}}}},{key:'render',kind:'template',config:{text:'{% for row in select.items %}{{row.name}}: {{row.link}}{% endfor %}'}},{key:'result',kind:'output',config:{text:'{{render.text}}',outputName:'result'}}],chains:[{key:'main',nodes:['start','http','select','render','result']}],coverage:{R1:['http','select','render','result']}}
      const result=new WorkflowAuthoringCompiler({...templateContext(),tools:BUILTIN_TOOLS}).submit({submission:doc});if(!result.ok)throw Error(JSON.stringify(result.feedback))
      const flow=storage.save(result.value.candidate!,0),run=await runtime.settle(runtime.start(flow.id,{}).id)
      expect(run.status,run.error).toBe('success');expect(run.outputs.result).toBe('Repo: https://example.test/owner/repo');expect(isCachedBody(spy.mock.calls[0]![1].html)).toBe(true)
      expect(JSON.stringify(run)).not.toContain(html);for(const file of readdirSync(join(directory,'runs')))expect(readFileSync(join(directory,'runs',file),'utf8')).not.toContain(html)
      html='<a>'+'x'.repeat(510000)+'</a>';const failed=await runtime.settle(runtime.start(flow.id,{}).id);expect(failed.status).toBe('failed');expect(failed.error).toContain('节点输出超过 1 MB')
    }finally{await runtime.close();storage.close();rmSync(directory,{recursive:true,force:true})}
  },30000)
})
