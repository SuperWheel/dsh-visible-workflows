import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest'
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {WorkflowAuthoringCompiler} from '../src/shared/planning-authoring.ts'
import {TemplateFillingCompiler} from '../src/shared/planning-template-compiler.ts'
import {planningEditView} from '../src/shared/planning-edits.ts'
import {verifiedModuleInstances} from '../src/shared/planning-module-fragments.ts'
import {allNodes,parseWorkflow} from '../src/shared/workflow-validation.ts'
import {planningToolPreconditionIssues} from '../src/shared/planning-tool-preconditions.ts'
import {submissionSchemaIssues} from '../src/shared/planning-submission-schema.ts'
import {templateIdForTool} from '../src/shared/planning-node-templates.ts'
import {compileBusinessModule} from '../src/shared/planning-business-modules.ts'
import {WorkflowRuntime,type ModelRequest} from '../src/host/runtime.ts'
import {WorkflowStorage} from '../src/host/storage.ts'
import {createExecutionAdapters,httpRequest} from '../src/host/execution-adapters.ts'
import {BUILTIN_TOOLS,ToolCatalog} from '../src/host/tool-catalog.ts'
import {cases,oracle,structuredPromptPrefix,webFixtures} from '../scripts/benchmarks/workflow-compiler.ts'
import {templateContext} from './fixtures/planning-compiler/template.ts'
import {tools} from './fixtures/t18-tools.ts'
import type {NodeGraph,Workflow} from '../src/shared/types.ts'

// New, portable reference copy. Old evidence, pinned request bytes and the
// reviewer export stay read-only. Trending's surviving description is NOT
// presented as a verbatim user message. See requests.*.kind in this file.
const references=JSON.parse(readFileSync(new URL('./t24-fragment-replay.references.json',import.meta.url),'utf8'))
const library=references.workflows as Workflow[]
const benchmark=(id:string)=>cases.find(c=>c.id===id)!
const readJson=(path:string)=>JSON.parse(readFileSync(new URL('../'+path,import.meta.url),'utf8'))
const copy=<T>(v:T):T=>structuredClone(v)
type Document={mode:string;title:string;nodes:any[];modules:any[];chains:any[];coverage:Record<string,string[]>;links?:any[]}
type Arm='compact-repair'|'template-fill'
const arms:Arm[]=['compact-repair','template-fill']
const node=(key:string,kind:string,config:any)=>({key,kind,config})
const output=(text:string)=>node('result','output',{text,outputName:'result'})
const input=(name:string,type='text')=>node('start','input',{fields:[{name,label:name,type,required:true}]})
const fragment=(key:string,id:string,parameters:any)=>({key,module:id+(['web-extract','verified-file-write'].includes(id)?'@1.1.0':'@1.0.0'),parameters})
const document=(title:string,nodes:any[],modules:any[],order:string[]):Document=>({mode:'create',title,nodes,modules,chains:[{key:'main',nodes:order}],coverage:{R1:order}})
const field=(name:string,type:string)=>({name,type,required:true,description:name})
const context=()=>({...templateContext(),tools:[...tools(),...BUILTIN_TOOLS,{id:'native:web_fetch',name:'web_fetch',description:'离线网页替身',providerId:'native:harness',providerName:'offline',category:'plugin' as const,available:true,inputSchema:{type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}}]})
function wire(doc:Document,arm:Arm):any {
  const d:any=copy(doc)
  if(arm==='template-fill'){
    d.forms=d.nodes.map(({kind,config,...n}:any)=>{
      if(kind==='tool'){const {toolId,...values}=config;return {...n,template:templateIdForTool(toolId),values}}
      return {...n,template:kind,values:config}
    });delete d.nodes
  }
  return {submission:d}
}
function compile(doc:Document,arm:Arm='compact-repair') {
  const c=arm==='compact-repair'?new WorkflowAuthoringCompiler(context()):new TemplateFillingCompiler(context())
  const value=wire(doc,arm)
  if(c instanceof TemplateFillingCompiler)c.queryTemplates([...new Set(value.submission.forms.map((f:any)=>f.template))] as string[])
  expect(submissionSchemaIssues(c.nextSchema,value)).toEqual([])
  const r=c.submit(value)
  if(!r.ok)throw Error(JSON.stringify(r.feedback))
  expect(c.snapshot().submissions).toBe(1)
  expect(r.value.issues).toEqual([])
  const flow=r.value.candidate!
  expect(verifiedModuleInstances(flow)).toHaveLength(doc.modules.length)
  expect(planningToolPreconditionIssues(flow,context())).toEqual([])
  return flow
}

// Reuse business code verbatim from the reference; only rename graph references.
// This helper never expands a fragment or calls its recipe to create an oracle.
function referenceNode(index:number,id:string,key:string,names:Record<string,string>) {
  const original=library[index]!.nodes.find(n=>n.id===id)!
  let config=JSON.stringify(original.config)
  for(const [from,to]of Object.entries(names))config=config.replaceAll(from+'.',to+'.')
  return node(key,original.kind,JSON.parse(config))
}
const joinCode='function main(inputs){return {text:JSON.parse(inputs.texts).join("")};}'
const joinNode=(key:string,source:string)=>node(key,'code',{language:'javascript',code:joinCode,inputs:{texts:'{{'+source+'.texts}}'},outputSchema:[field('text','string')]})
const time=node('clock','tool',{toolId:'builtin:time.now',inputs:{timezone:'Asia/Shanghai'}})
const ids={
  first:{clock:'e8971703-1a40-4154-a07f-d1da0a348eed',fetch:'8faa23a6-eec6-44ba-a614-4514ecba0777',extract:'e660685d-090e-4c9b-b756-2c333a62ab95',render:'66a417a1-d539-4f4c-9959-2fc0d3786397'},
  second:{clock:'6f2b738c-eae8-412b-9838-04f0482a6054',fetch:'f7ba2693-8c77-4770-987e-39d64381abba',parse:'1cfaedaa-44cc-4416-848f-515c9738fc59',render:'2addc2cc-b712-4079-bf99-387e1aba3f87'},
  r7:{start:'9f442803-6de5-4653-8ac5-4035c13467f6',read:'c00ed870-68b2-43cd-ab43-5ef7bab9a7da',parse:'0f519845-f2ec-44b2-bdb7-3a01443321bc',sum:'b344704f-3974-44c0-95b3-eda07a7e79c6',report:'5fb5a110-16b6-4df6-b421-82311340a721',summaryRead:'85b4ec7f-4d70-442e-a301-86b94b11e28a',reportRead:'33309387-4c6e-475e-a28e-fe0308ce2d6a',human:'e43ba72e-9fdb-4233-bad7-eb8c14fcc9d8'},
  stock:{start:'b24457c5-bb19-4522-99ed-d247aeb6f980',sum:'b80e9c8a-2c9e-422d-b24f-93b124ab8864',render:'568f6f74-455b-4551-bdb6-2ea110fb27b6'},
}

function trendingLlm(date='2026-10-24') {
  const original=library[0]!.nodes.find(n=>n.kind==='llm')!
  const instruction=String(original.config.prompt).split('\n\n网页文本：')[0]!+'\n把上述 projects 数组放在 payload.projects 中，顶层只返回 payload 对象。'
  const render=referenceNode(0,ids.first.render,'render',{[ids.first.clock]:'clock',[ids.first.extract]:'checked.data.payload'})
  return document(library[0]!.title,[node('start','input',copy(library[0]!.nodes[0]!.config)),
    copy(time),node('fetch','tool',{toolId:'native:web_fetch',inputs:{url:'https://github.com/trending'}}),render,
    output('{{render.report}}\n\n---\n文件已保存：{{render.filePath}}'),
  ],[
    fragment('checked','extract-validate',{source:'{{fetch.text}}',fields:[field('payload','object')],instruction}),
    fragment('save','verified-file-write',{target:'github-top10-'+date+'.md',content:'{{render.report}}'}),
  ],['start','clock','fetch','checked','render','save','result'])
}

const trendingRow='| {{item.rank}} | {{item.repo}} | {{item.language}} | {{item.starsText}} | {{item.url}} |\n'
const trendingDetails='## {{item.rank}}. {{item.repo}}\n\n- 简介：{{item.description}}\n- 语言：{{item.language}}\n- Star：{{item.starsText}}（今日新增 +{{item.todayStarsText}}）\n- Fork：{{item.forksText}}\n- 链接：{{item.url}}\n\n'
function trendingHttp(date='2026-10-24') {
  const select=node('select','tool',{toolId:'builtin:html.select',inputs:{html:'{{fetch.text}}',items:'article.Box-row',baseUrl:'https://github.com/trending',limit:500,fields:{
    link:{selector:'h2 a',attr:'href'},description:{selector:'p',text:true},language:{selector:'[itemprop="programmingLanguage"]',text:true},stars:{selector:'a[href$="/stargazers"]',text:true},forks:{selector:'a[href$="/forks"]',text:true},body:{text:true},
  }}})
  const parse=node('parse','code',{language:'javascript',inputs:{rows:'{{select.items}}',datetime:'{{clock.datetime}}'},code:`function main(inputs){
    const date=inputs.datetime.slice(0,10),items=[];
    const num=t=>{const m=String(t).match(/[\\d.,]+/);return m?m[0].replace(/,/g,''):'0'};
    for(const row of inputs.rows){const repo=row.link.replace(/^https:\\/\\/github\\.com\\//,'');if(!repo.includes('/'))continue;
      const starsText=num(row.stars),forksText=num(row.forks),m=row.body.match(/([\\d.,]+)\\s+stars?\\s+today/i),todayStarsText=m?num(m[1]):'0';
      items.push({rank:items.length+1,repo,url:row.link,description:row.description||'暂无简介',language:row.language||'未知',starsText,stars:parseFloat(starsText)||0,todayStarsText,todayStars:parseFloat(todayStarsText)||0,forksText,forks:parseFloat(forksText)||0});if(items.length===10)break;
    }return {date,count:items.length,items};
  }`,outputSchema:[field('date','string'),field('count','number'),field('items','array')]})
  const text='# GitHub Trending Top10\n\n抓取日期：{{parse.date}}\n\n| 排名 | 项目 | 语言 | Star | 链接 |\n| --- | --- | --- | --- | --- |\n{% if parse.count %}{{rowsText.text}}{% else %}| - | 未解析到项目 | - | - | - |\n{% endif %}\n{% if parse.count %}{{detailsText.text}}{% else %}本次运行未解析到项目数据，请检查 GitHub Trending 页面结构。\n{% endif %}---\n\n数据来源：[GitHub Trending](https://github.com/trending)，抓取日期：{{parse.date}}\n'
  return document(library[1]!.title,[node('start','input',{fields:[]}),copy(time),referenceNode(1,ids.second.fetch,'fetch',{}),select,parse,
    joinNode('rowsText','rows'),joinNode('detailsText','details'),node('render','template',{text}),
    output('GitHub Trending Top10 日报已生成并写入工作区：github-trending-top10-{{parse.date}}.md（解析到 {{parse.count}} 个项目）'),
  ],[
    fragment('rows','list-map-template',{items:'{{parse.items}}',template:trendingRow}),
    fragment('details','list-map-template',{items:'{{parse.items}}',template:trendingDetails}),
    fragment('save','verified-file-write',{target:'github-trending-top10-'+date+'.md',content:'{{render.text}}'}),
  ],['start','clock','fetch','select','parse','rows','rowsText','details','detailsText','render','save','result'])
}

function r7(directory='reports') {
  const p=ids.r7,names={[p.start]:'input',[p.read]:'read',[p.parse]:'parse',[p.sum]:'sum',[p.summaryRead]:'summaryRead',[p.reportRead]:'reportRead'}
  const human=referenceNode(2,p.human,'review',names)
  const d=document(library[2]!.title,[referenceNode(2,p.start,'start',{}),referenceNode(2,p.read,'read',names),referenceNode(2,p.parse,'parse',names),referenceNode(2,p.sum,'sum',names),
    joinNode('categoryText','lines'),node('report','template',{text:'# 已支付订单汇总\n\n笔数：{{sum.paidCount}}\n总额（分）：{{sum.totalCents}}\n{{categoryText.text}}'}),
    node('summaryRead','tool',{toolId:'native:read',inputs:{file_path:directory+'/summary.json'}}),
    node('reportRead','tool',{toolId:'native:read',inputs:{file_path:directory+'/report.md'}}),human,
    referenceNode(2,library[2]!.nodes.find(n=>n.kind==='output')!.id,'result',names),
  ],[
    fragment('lines','list-map-template',{items:'{{sum.categories}}',template:'{{item.name}}：{{item.cents}}\n'}),
    fragment('summary','verified-file-write',{target:directory+'/summary.json',content:'{{sum.summaryJson}}'}),
    fragment('reportFile','verified-file-write',{target:directory+'/report.md',content:'{{report.text}}'}),
  ],['start','read','parse','sum','lines','categoryText','summary','report','reportFile','summaryRead','reportRead','review'])
  d.links=[{key:'confirmed',source:'review',target:'result',port:'approve'}]
  return d
}

function inventory() {
  const p=ids.stock,names={[p.start]:'input',[p.sum]:'sum',[p.render]:'render'}
  return document(library[3]!.title,[referenceNode(3,p.start,'start',{}),referenceNode(3,p.sum,'sum',names),joinNode('lineText','lines'),
    node('render','template',{text:'# 库存补货清单（验收修订）\n品类：{{sum.count}}\n补货总数：{{sum.total}}\n{% if sum.count %}{{lineText.text}}{% else %}无需补货\n{% endif %}'}),
    // Dynamic exact input paths can retain an ordinary read-before-overwrite.
    // Absence / first-create and arbitrary computed paths remain a gap.
    node('prior','tool',{toolId:'native:read',inputs:{file_path:'{{input.outputPath}}'},cache:'never'}),
    node('write','tool',{toolId:'native:write',inputs:{file_path:'{{input.outputPath}}',content:'{{render.text}}'},cache:'never'}),
    referenceNode(3,library[3]!.nodes.find(n=>n.kind==='output')!.id,'result',names),
  ],[fragment('lines','list-map-template',{items:'{{sum.lines}}',template:'{{item.sku}}：{{item.restock}}\n'})],['start','sum','lines','lineText','render','prior','write','result'])
}
function container() {return document('container',[input('items','json'),output('{{mapped.texts}}')],[fragment('mapped','list-map-template',{items:'{{input.items}}',template:'项：{{item}}'})],['start','mapped','result'])}
function web() {return document('web-process',[input('page'),node('normalize','code',{language:'javascript',code:'function main(inputs){return {text:inputs.title+"|"+(inputs.text||"空")};}',inputs:{title:'{{page.title}}',text:'{{page.text}}'},outputSchema:[field('text','string')]}),output('{{normalize.text}}')],[fragment('page','web-extract',{url:'https://fixture.invalid/pages/{{input.page}}'})],['start','page','normalize','result'])}
function structured() {return document('structured-llm (result-only variant)',[input('record','json'),node('source','template',{text:'{{input.record}}'}),node('render','template',{text:'{{checked.data.name}}|{{checked.data.total}}|{{checked.data.taxable}}'}),output('{{render.text}}')],[fragment('checked','extract-validate',{source:'{{source.text}}',fields:[field('name','string'),field('total','number'),field('taxable','boolean')],instruction:structuredPromptPrefix})],['start','source','checked','render','result'])}
const tableParameters={rows:'{{input.rows}}',title:'核对结果',columns:[{key:'name',label:'项目'},{key:'amount',label:'金额'}],emptyText:'无记录'}
function table() {return document('structured-result-table',[input('rows','json'),output('{{table.text}}')],[fragment('table','structured-result-table',tableParameters)],['start','table','result'])}
function verified() {return document('verified-file-write',[input('text','paragraph'),node('render','template',{text:'{{input.text}}'}),output('{{save.path}}/{{save.operation}}/{{save.check}}')],[fragment('save','verified-file-write',{target:'result.txt',content:'{{render.text}}'})],['start','render','save','result'])}

const referenceContainer=readJson('tests/fixtures/t26/compact-container-candidate.json') as Workflow
const referenceWeb=readJson('tests/fixtures/t26/compact-web-process-candidate.json') as Workflow
function referenceStructured() {
  const d=document('structured-llm reference',[input('record','json'),node('extract','llm',{prompt:structuredPromptPrefix+'\n{{input.record}}',outputSchema:[field('name','string'),field('total','number'),field('taxable','boolean')]}),node('render','template',{text:'{{extract.name}}|{{extract.total}}|{{extract.taxable}}'}),output('{{render.text}}')],[],['start','extract','render','result'])
  return compile(d)
}
const replayCases=[
  {id:'trending-llm',make:trendingLlm,reference:()=>library[0]!,gap:'动态日期目标需字面参数重编译；payload.object 只校验顶层，不验证项目数组语义；原始用户请求未留存。'},
  {id:'trending-http',make:trendingHttp,reference:()=>library[1]!,gap:'普通 HTTP→html.select 保留链接；实体解码不宣称全域等价；动态日期目标需字面参数重编译；原始用户请求未留存。'},
  {id:'r7',make:r7,reference:()=>library[2]!,gap:'outputDir 字面专化；保留普通确定性汇总与单按钮人工核对。'},
  {id:'inventory',make:inventory,reference:()=>library[3]!,gap:'动态 input.outputPath 普通 read/write 仅覆盖已有目标；新增 iteration 不符合原请求五类节点单链限制。'},
  {id:'container',make:container,reference:()=>referenceContainer,gap:'输出与 iteration 子图等价；固定 code 投影被原 oracle 的全面禁 code 条款拒绝。'},
  {id:'web-process',make:web,reference:()=>referenceWeb,gap:'固定样本等价；通用 HTML 实体解码/容器回退并非原正则算法的全域等价。'},
  {id:'structured-llm',make:structured,reference:referenceStructured,gap:'结果等价变体；extractor+code 与原要求 llm/固定首行/禁 code 不符，不算原 oracle 通过。'},
  {id:'table',make:table,reference:()=>compileBusinessModule({moduleId:'structured-result-table',version:'1.0.0',instanceKey:'tableReference',parameters:{title:tableParameters.title,columns:tableParameters.columns,emptyText:tableParameters.emptyText}},templateContext()).candidate!,gap:'补充渲染 oracle；不替代既有业务报告格式。'},
  {id:'verified-file-write',make:verified,reference:()=>undefined,gap:'补充文件内容/调用顺序 oracle；window-match 不证明字节相等。'},
]

let scratch:string,serial=0
beforeAll(()=>{scratch=mkdtempSync(join(dirname(fileURLToPath(import.meta.url)),'t24-replay-run-'))})
afterAll(()=>{vi.unstubAllGlobals();if(scratch)rmSync(scratch,{recursive:true,force:true})})
type Sample={inputs:Record<string,string>;html?:string;page?:string;datetime?:string;files?:Record<string,string>;response?:string}
async function harness(sample:Sample,body:(h:{run:(flow:Workflow)=>Promise<any>;files:Map<string,string>;calls:string[];modelPrompts:string[]})=>Promise<void>) {
  const directory=join(scratch,'store-'+serial++);mkdirSync(directory)
  const storage=new WorkflowStorage(directory),files=new Map(Object.entries(sample.files??{})),calls:string[]=[],modelPrompts:string[]=[]
  const forbidden=async()=>{throw Error('T24 replay rejects external calls')}
  vi.stubGlobal('fetch',async(url:URL,init:RequestInit)=>{
    expect(String(url)).toMatch(/^https:\/\/(github\.com\/trending|fixture\.invalid\/pages\/)/)
    expect(init.method).toBe('GET');expect(init.redirect).toBe('manual')
    calls.push('GET '+url)
    const key=String(url).split('/').at(-1)!
    return new Response(sample.html??webFixtures[key]!,{headers:{'content-type':'text/html'}})
  })
  // File tools are in-memory test doubles, not claims about the SDK's version
  // policy. Static T18 validation is independently asserted on every candidate.
  const catalog=new ToolCatalog({directory,workflows:id=>storage.workflows(id),nativeTools:()=>context().tools,executeNative:async(name,args)=>{
    if(name==='web_fetch'){expect(args.url).toBe('https://github.com/trending');calls.push('web_fetch');return {text:sample.page!,value:{text:sample.page!}}}
    const path=String(args.file_path??args.pattern);expect(path).not.toContain('..');expect(path).not.toMatch(/^\//)
    calls.push(name+' '+path)
    if(name==='glob')return {value:{root:'.',paths:files.has(path)?['./'+path]:['sub/'+path]}}
    if(name==='write'){const existed=files.has(path);files.set(path,String(args.content));return {value:{path,operation:existed?'update':'create'},text:'written '+path}}
    if(name==='read'){
      if(!files.has(path))throw Error('fixture missing file '+path)
      const content=files.get(path)!,lines=content.split('\n');if(lines.at(-1)==='')lines.pop()
      const value={path,offset:1,lines:lines.map((text,i)=>({number:i+1,text})),totalLines:lines.length}
      return {value,text:JSON.stringify(value)}
    }
    return forbidden()
  },runWorkflow:forbidden,http:forbidden as typeof httpRequest})
  const adapters=createExecutionAdapters({catalog,workspaceRoot:()=>directory})
  const runtime=new WorkflowRuntime(storage,{generate:async(request:ModelRequest)=>{
    calls.push('model-stub');modelPrompts.push(request.prompt)
    if(sample.response!==undefined)return sample.response
    if(sample.page){
      expect(request.prompt).toContain(sample.page)
      const payload=JSON.parse(sample.page.slice(sample.page.indexOf('SOURCE_JSON:')+'SOURCE_JSON:'.length))
      return JSON.stringify(request.prompt.includes('payload.projects')?{payload}:payload)
    }
    const source=JSON.parse(sample.inputs.record!)
    expect(request.prompt).toContain(structuredPromptPrefix);expect(request.prompt).toContain(sample.inputs.record!)
    return JSON.stringify({name:source.name,total:source.amount*2,taxable:source.amount>0},null,2)
  }},{execute:async(kind,request)=>{
    if(kind==='tool'&&request.node.config.toolId==='builtin:time.now'){calls.push('time-stub');return {datetime:sample.datetime??'2026-10-24T09:30:00+08:00'}}
    return adapters.execute(kind,request)
  }},undefined,{runtimeDirectory:join(scratch,'engine')})
  try{
    await body({files,calls,modelPrompts,run:async(flow:Workflow)=>{
      const candidate=copy(flow);candidate.id='replay-'+serial++;candidate.revision=0;delete candidate.archived
      const saved=storage.save(candidate,0)
      const run=await runtime.settle(runtime.start(saved.id,sample.inputs,{model:templateContext().model!,source:'session'}).id)
      if(flow.moduleInstances?.length)expect(verifiedModuleInstances(storage.get(saved.id))).toHaveLength(flow.moduleInstances.length)
      return run
    }})
  }finally{vi.unstubAllGlobals();await runtime.close();storage.close()}
}

// Same source, different payloads, order and empty lists prevent sample constants
// from masquerading as equivalence. Model stubs test plumbing, not translation.
function githubHtml(count:number,owner='owner') {
  return '<html><title>Trending</title><body><main>'+Array.from({length:count},(_,i)=>`<article class="Box-row"><h2><a href="/${owner}/repo${i}">repo${i}</a></h2><p class="col-9">Description ${i}</p><span itemprop="programmingLanguage">TypeScript</span><a href="/${owner}/repo${i}/stargazers">1,234</a><a href="/${owner}/repo${i}/forks">56</a><span>7 stars today</span></article>`).join('')+'</main></body></html>'
}
function githubPage(count:number,owner='owner') {return 'GitHub Trending today\nSOURCE_JSON:'+JSON.stringify({projects:Array.from({length:count},(_,i)=>({rank:i+1,repo:owner+'/repo'+i,owner,url:'https://github.com/'+owner+'/repo'+i,description:'Description '+i,descriptionZh:'说明 '+i,language:'TypeScript',stars:'1,234',forks:'56',todayStars:'+7'}))})}
async function businessPair(index:number,doc:Document,sample:Sample) {
  let expectedFiles:Record<string,string>={}
  await harness(sample,async h=>{
    const ref=await h.run(library[index]!);expect(['success','waiting'],ref.error).toContain(ref.status)
    expectedFiles=Object.fromEntries(h.files)
    for(const arm of arms){
      h.files.clear();for(const [path,text]of Object.entries(sample.files??{}))h.files.set(path,text)
      h.calls.length=0
      const run=await h.run(compile(doc,arm));expect(run.status,run.error).toBe(ref.status)
      expect(Object.fromEntries(h.files)).toEqual(expectedFiles);expect(run.outputs).toEqual(ref.outputs);expect(run.humanPrompt).toBe(ref.humanPrompt)
      expect(h.calls.filter(c=>c==='model-stub')).toHaveLength(index===0?1:0)
      for(const e of run.executions.filter((e:any)=>e.data?.check))expect(e.data.check).toBe('window-match')
    }
  })
  return expectedFiles
}

describe('T24.3 offline fragment replays (production compilers + WorkflowRuntime)',()=>{
  it('preserves a portable reviewer reference and attributes surviving requests precisely',()=>{
    // The original export's byte hash is provenance, not a dependency on an
    // untracked .test-data file in future checkouts. Validate the copied graphs.
    expect(references.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(createHash('sha256').update(JSON.stringify(library)).digest('hex')).toBe(references.workflowsSha256)
    for(const flow of library)expect(()=>parseWorkflow(flow)).not.toThrow()
    for(const key of ['r7','inventory'])expect(references.requests[key].kind).toBe('verbatim-request')
    for(const key of ['trending-llm','trending-http'])expect(references.requests[key].kind).toContain('original user request not present')
    // Legacy saved graphs are business oracles, NOT current T18-compliant plans.
    for(const flow of library)expect(planningToolPreconditionIssues(flow,context()).some(i=>i.code==='TOOL_PRECONDITION_UNPROVEN')).toBe(true)
  })
  it.each(replayCases)('$id: both CREATE forms compile on first submission; measure actual wire bytes and expanded nodes',item=>{
    const d=item.make(),a=compile(d),b=compile(d,'template-fill');expect(b).toEqual(a)
    const ref=item.reference()
    process.stdout.write('T24_REPLAY '+JSON.stringify({id:item.id,compactBytes:Buffer.byteLength(JSON.stringify(wire(d,'compact-repair'))),templateBytes:Buffer.byteLength(JSON.stringify(wire(d,'template-fill'))),referenceGraphBytes:ref?Buffer.byteLength(JSON.stringify({nodes:ref.nodes,edges:ref.edges})):null,declaredNodes:d.nodes.length,declaredFragments:d.modules.length,expandedNodes:allNodes(a).length,referenceNodes:ref?allNodes(ref).length:null,firstSubmission:true})+'\n')
  })
  it('Trending extraction/translation plumbing preserves reports, top-10 cap, missing values, dates and file contents',async()=>{
    for(const [count,date]of [[2,'2026-10-24'],[0,'2026-10-24'],[12,'2026-10-25']]as const){
      const sample:Sample={inputs:{timezone:'Asia/Shanghai'},page:githubPage(count,'changed'),datetime:date+'T09:30:00+08:00'}
      const actual=await businessPair(0,trendingLlm(date),sample)
      expect(actual['github-top10-'+date+'.md']).toContain('# GitHub 每日热门项目 Top 10')
      if(count)expect(actual['github-top10-'+date+'.md']).toContain('[changed/repo0](https://github.com/changed/repo0)')
      if(count>10)expect(actual['github-top10-'+date+'.md']).not.toContain('changed/repo10')
    }
    const page=JSON.parse(githubPage(1).split('SOURCE_JSON:')[1]!);delete page.projects[0].language
    const actual=await businessPair(0,trendingLlm(),{inputs:{},page:'SOURCE_JSON:'+JSON.stringify(page)})
    expect(actual['github-top10-2026-10-24.md']).toContain('暂无')
  },60_000)
  it('Trending HTTP retains raw links/site parser; row/detail fragments preserve exact empty and populated reports',async()=>{
    for(const [count,date]of [[2,'2026-10-24'],[0,'2026-10-24'],[12,'2026-10-25']]as const){
      const actual=await businessPair(1,trendingHttp(date),{inputs:{},html:githubHtml(count,'changed'),datetime:date+'T10:00:00+08:00'})
      const text=actual['github-trending-top10-'+date+'.md']!
      expect(text).toContain(count?'https://github.com/changed/repo0':'未解析到项目')
      if(count>10)expect(text).not.toContain('changed/repo10')
    }
  },60_000)
  it('R7 preserves strict paid integer sums, category order, both files and the waiting human check',async()=>{
    const primary=readJson('docs/evidence/v002-execute-first-r7-20261018/orders.json')
    const holdout=readJson('docs/evidence/v002-execute-first-r7-20261018/orders-holdout.json')
    for(const [orders,directory]of [[primary,'reports'],[holdout,'alternate'],[[], 'empty'],[[{id:'x',status:'PAID',category:'ignored',amountCents:99},{id:'y',status:'paid',category:'new',amountCents:-2}], 'strict']]as const){
      const actual=await businessPair(2,r7(directory),{inputs:{orderFilePath:'orders.json',outputDir:directory},files:{'orders.json':JSON.stringify(orders)}})
      const summary=JSON.parse(actual[directory+'/summary.json']!)
      expect(Object.keys(summary)).toEqual(['paidCount','totalCents','byCategory'])
      if(directory==='reports')expect(summary).toEqual({paidCount:3,totalCents:4000,byCategory:{book:3700,food:300}})
      if(directory==='strict')expect(summary).toEqual({paidCount:1,totalCents:-2,byCategory:{new:-2}})
    }
  },60_000)
  it('inventory preserves ordered calculation, exact revised Markdown and dynamic existing targets; invalid input writes nothing',async()=>{
    const stock=readJson('docs/evidence/template-fill-desktop-20261019/cases.json')
    for(const c of stock.cases){
      const actual=await businessPair(3,inventory(),{inputs:{records:JSON.stringify(c.records),threshold:String(c.threshold),outputPath:c.outputPath},files:{[c.outputPath]:'old'}})
      expect(actual[c.outputPath]).toContain(c.expectedLines.slice(1).join('\n'))
    }
    for(const arm of arms)for(const bad of [{records:'[{"sku":"x","stock":-1}]',threshold:'4',outputPath:'invalid.md'},{records:'not JSON',threshold:'4',outputPath:'invalid.md'},{records:'[]',threshold:'-1',outputPath:'invalid.md'}])await harness({inputs:bad},async h=>{
      const run=await h.run(compile(inventory(),arm));expect(run.status).toBe('failed');expect(run.error).toContain('输入校验失败');expect(h.calls).toEqual([]);expect(h.files.size).toBe(0)
    })
    await harness({inputs:{records:'[]',threshold:'0',outputPath:'new.md'}},async h=>{
      const run=await h.run(compile(inventory()));expect(run.status).toBe('failed');expect(run.error).toContain('fixture missing file new.md');expect(h.calls).toEqual(['read new.md']);expect(h.files.size).toBe(0)
    })
  },60_000)
  it.each(['container','web-process','structured-llm'])('%s: runs original samples and counterfactuals against reference and fragment forms',async id=>{
    const item=replayCases.find(c=>c.id===id)!,original=benchmark(id)
    const probes=id==='container'?[{inputs:{items:'["新项","再一项"]'},expected:'["项：新项","项：再一项"]'}]:id==='web-process'?[
      {inputs:{page:'news'},html:webFixtures.news!.replace('公告','新标题'),expected:'新标题|欢迎 Ada 阅读'},
      {inputs:{page:'news'},html:webFixtures.news!.replace(' 欢迎 <b>Ada</b>   阅读 ',' 动态 <b>正文</b> '),expected:'公告|动态 正文'},
    ]:[{inputs:{record:'{"name":"探针","amount":7.25}'},expected:'探针|14.5|true'}]
    for(const sample of [...original.samples,...probes])await harness(sample,async h=>{
      for(const graph of [item.reference()!,...arms.map(arm=>compile(item.make(),arm))]){
        h.calls.length=0
        const run=await h.run(graph);expect(run.status,run.error).toBe('success');expect(run.outputs.result).toBe(sample.expected)
        if(id==='container'){
          const count=JSON.parse(sample.inputs.items!).length
          expect(run.executions.filter((e:any)=>e.status==='success'&&allNodes(graph).some(n=>n.id===e.nodeId&&n.kind==='template'))).toHaveLength(count)
        }
        if(id==='web-process')expect(h.calls).toEqual(['GET https://fixture.invalid/pages/'+sample.inputs.page])
        if(id==='structured-llm')expect(h.calls).toEqual(['model-stub'])
      }
    })
  },60_000)
  it('records strict original benchmark policy rejection instead of loosening its oracle',async()=>{
    // These fail BEFORE oracle creates storage/runtime. No .cache access.
    await expect(oracle(compile(container()),benchmark('container'))).rejects.toThrow('prohibited code')
    await expect(oracle(compile(structured()),benchmark('structured-llm'))).rejects.toThrow('prohibited model node')
    const ordinary=referenceStructured()
    expect(allNodes(ordinary).filter(n=>n.kind==='llm')).toHaveLength(1)
    expect(allNodes(ordinary).some(n=>n.kind==='code')).toBe(false)
    expect(allNodes(ordinary).find(n=>n.kind==='llm')!.config.prompt!.startsWith(structuredPromptPrefix+'\n')).toBe(true)
  })
  it('records entity/body fallback counterexamples while html.select recovers anchor targets',async()=>{
    const html='<html><title>A &amp; B</title><body><a href="/hidden/repository">label</a></body></html>'
    await harness({inputs:{page:'news'},html},async h=>{
      const original=await h.run(referenceWeb),candidate=compile(web()),changed=await h.run(candidate)
      expect(original.status,original.error).toBe('success');expect(changed.status,changed.error).toBe('success')
      expect(original.outputs.result).toBe('A &amp; B|空');expect(changed.outputs.result).toBe('A & B|label')
      const fetched=changed.executions.find((e:any)=>e.nodeId===candidate.moduleInstances![0]!.roles.extract)!.data
      expect(fetched.text).toBe('label');expect(JSON.stringify(fetched)).not.toContain('/hidden/repository')
      const d=document('links',[input('page'),node('fetch','http',{url:'https://fixture.invalid/pages/news'}),node('links','tool',{toolId:'builtin:html.select',inputs:{html:'{{fetch.text}}',items:'a',baseUrl:'https://fixture.invalid/pages/news',fields:{link:{attr:'href'}}}}),output('{{links.text}}')],[],['start','fetch','links','result'])
      const links=await h.run(compile(d));expect(links.status,links.error).toBe('success');expect(JSON.parse(links.outputs.result)).toEqual([{link:'https://fixture.invalid/hidden/repository'}])
    })
  },60_000)
  it('accepts input targets but rejects computed-path references and legacy bare writes',()=>{
    const d=verified();d.nodes[0].config.fields.push({name:'target',label:'路径',type:'text',required:true});d.modules[0].parameters.target='{{input.target}}'
    for(const arm of arms)expect(verifiedModuleInstances(compile(d,arm))).toHaveLength(1)
    d.modules[0].parameters.target='{{render.text}}'
    const r=new WorkflowAuthoringCompiler(context()).submit(wire(d,'compact-repair'))
    expect(r.ok).toBe(false);if(!r.ok)expect(r.feedback.issues[0]!.code).toBe('MODULE_PARAMETERS')
    const legacy=copy(library[2]!)
    expect(planningToolPreconditionIssues(legacy,context()).filter(i=>i.code==='TOOL_PRECONDITION_UNPROVEN')).toHaveLength(2)
  })
  it('table fragment matches the independently frozen whole-graph renderer on escaping, empty and changed rows',async()=>{
    const ref=replayCases.find(c=>c.id==='table')!.reference()!
    for(const rows of [[{name:'A|B\n<C>',amount:0},{name:'False',amount:false},{name:'Null',amount:null}],[],[{name:'changed',amount:-3}]]){
      let expected=''
      await harness({inputs:{rows:JSON.stringify(rows)}},async h=>{
        for(const [i,graph]of [ref,...arms.map(arm=>compile(table(),arm))].entries()){
          const run=await h.run(graph);expect(run.status,run.error).toBe('success')
          if(i===0)expected=run.outputs.result;else expect(run.outputs.result).toBe(expected)
          expect(h.calls).toEqual([])
        }
      })
      if(rows.length===3)expect(expected).toContain('A&#124;B &lt;C&gt;')
    }
  },60_000)
  it('verified write checks create/update call order and exact mock file contents, without treating window-match as exact proof',async()=>{
    for(const arm of arms)for(const prior of [undefined,'old'])await harness({inputs:{text:'new\n正文\n'},files:prior===undefined?{}:{'result.txt':prior}},async h=>{
      const run=await h.run(compile(verified(),arm));expect(run.status,run.error).toBe('success')
      expect(h.files.get('result.txt')).toBe('new\n正文\n')
      expect(h.calls).toEqual(prior===undefined?['glob result.txt','write result.txt','read result.txt']:['glob result.txt','read result.txt','write result.txt','read result.txt'])
      expect(run.outputs.result).toBe('result.txt/'+(prior===undefined?'created':'updated')+'/window-match')
    })
  },60_000)
})

// Flatten configs WITHOUT duplicating child configs through their parent's body.
// Topology and every non-config node attribute are compared separately.
function configs(flow:Workflow) {return Object.fromEntries(allNodes(flow).map(n=>{const {body,...config}=n.config;return [n.id,config]}))}
function topology(graph:NodeGraph):any {return {edges:graph.edges,nodes:graph.nodes.map(({config,...n})=>({...n,...(config.body?{body:topology(config.body)}:{})}))}}
function differences(a:any,b:any,path=''):string[] {
  if(JSON.stringify(a)===JSON.stringify(b))return []
  if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b))return [...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(key=>differences(a[key],b[key],path+'/'+key))
  return [path]
}
describe('T24.3 saved-instance EDIT replay',()=>{
  const edits=[
    {id:'list-map-template',make:container,key:'mapped',parameter:'template',value:'修订：{{item}}',role:'render',paths:['/text'],sample:{inputs:{items:'["乙","甲"]'}},expected:'["修订：乙","修订：甲"]'},
    {id:'extract-validate',make:structured,key:'checked',parameter:'instruction',value:structuredPromptPrefix+'\n只使用明确数值。',role:'extract',paths:['/prompt'],sample:{inputs:{record:'{"name":"edit","amount":2}'}},expected:'edit|4|true'},
    {id:'web-extract',make:web,key:'page',parameter:'url',value:'https://fixture.invalid/pages/notice',role:'fetch',paths:['/url'],sample:{inputs:{page:'news'}},expected:'更新|版本 2 已发布'},
    {id:'structured-result-table',make:table,key:'table',parameter:'title',value:'修订核对',role:'render',paths:['/inputs/specification/title'],sample:{inputs:{rows:'[]'}},expected:'# 修订核对\n\n无记录'},
    {id:'verified-file-write',make:verified,key:'save',parameter:'target',value:'edited.txt',role:'',paths:[],sample:{inputs:{text:'edit body'}},expected:'edited.txt/created/window-match'},
  ]
  for(const arm of arms)it.each(edits)(arm+' $id: changes only parameter-derived config on a saved verified instance',async edit=>{
    const directory=join(scratch,'edit-'+serial++);mkdirSync(directory);const storage=new WorkflowStorage(directory)
    try{
      const before=storage.save(compile(edit.make(),arm),0),ctx={...context(),operation:'revise' as const,workflow:before,targetNodeIds:allNodes(before).map(n=>n.id)},view=planningEditView(ctx)
      const module=view.modules!.find(m=>m.ref===edit.key)!,parameters={...copy(module.parameters),[edit.parameter]:edit.value}
      const c=arm==='compact-repair'?new WorkflowAuthoringCompiler(ctx):new TemplateFillingCompiler(ctx)
      const submission={submission:{mode:'edit',updateModules:{[module.ref]:{parameters}},coverage:{R1:[module.ref]}}}
      expect(submissionSchemaIssues(c.nextSchema,submission)).toEqual([])
      const result=c.submit(submission);if(!result.ok)throw Error(JSON.stringify(result.feedback))
      expect(c.snapshot().submissions).toBe(1)
      const after=storage.save(result.value.candidate!,before.revision)
      const record=before.moduleInstances![0]!,next=verifiedModuleInstances(after)[0]!
      expect(verifiedModuleInstances(after)).toHaveLength(1);expect(next.roles).toEqual(record.roles);expect(next.implementationDigest).toBe(record.implementationDigest);expect(next.parametersDigest).not.toBe(record.parametersDigest)
      expect(topology(after)).toEqual(topology(before))
      const delta=differences(configs(before),configs(after))
      const expected=edit.id==='verified-file-write'?[
        '/'+record.roles.validate+'/inputs/target','/'+record.roles.probe+'/inputs/pattern','/'+record.roles.exists+'/inputs/target',
        '/'+record.roles.prior+'/inputs/file_path','/'+record.roles.write+'/inputs/file_path',
        '/'+record.roles.readback+'/inputs/file_path','/'+record.roles.compare+'/inputs/target',
      ]:edit.id==='web-extract'?['/'+record.roles.fetch+'/url','/'+record.roles.extract+'/inputs/url']:edit.paths.map(path=>'/'+record.roles[edit.role]+path)
      expect(delta.sort()).toEqual(expected.sort())
      await harness(edit.sample,async h=>{const run=await h.run(after);expect(run.status,run.error).toBe('success');expect(run.outputs.result).toBe(edit.expected)})
    }finally{storage.close()}
  },60_000)
})
