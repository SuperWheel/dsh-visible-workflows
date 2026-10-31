import {describe,expect,it} from 'vitest'
import {TemplateFillingCompiler} from '../src/shared/planning-template-compiler.ts'
import {templateIdForTool} from '../src/shared/planning-node-templates.ts'
import {artifactProbeRefs,buildTrialSkeleton,trialSkeletonPrompt,trialSkeletonReport,type TrialSkeleton} from '../src/host/planning/trial-skeleton.ts'
import {BUILTIN_TOOLS} from '../src/host/tool-catalog.ts'
import {authorPrompt} from '../src/host/planning/service-prompts.ts'
import {templateContext} from './fixtures/planning-compiler/template.ts'
import {tools} from './fixtures/t18-tools.ts'
import type {ConversationEvidence} from '../src/shared/retrospective.ts'
import type {Workflow} from '../src/shared/types.ts'

// Tool-call excerpts copied from the Desktop r34 trial records (write bodies shortened).
type Call=[seq:number,tool:string,args:unknown,status?:'reported-success'|'failed'|'unknown',truncated?:boolean,result?:string]
const evidence=(calls:Call[]):ConversationEvidence=>({version:1,sessionId:'child',fromSeq:1,throughSeq:99,digest:'0'.repeat(64),warnings:[],
  records:calls.flatMap(([seq,tool,args,status='unknown',truncated=false,result='…'])=>[
    {id:`e${seq}`,seq,kind:'tool-call' as const,text:typeof args==='string'?args:JSON.stringify(args),status:truncated?'unknown' as const:status,toolName:tool,callId:'c'+seq,truncated},
    {id:`e${seq+1}`,seq:seq+1,kind:'tool-result' as const,text:result,status,toolName:tool,callId:'c'+seq,truncated:false},
  ])})
const artifact=(path:string)=>({path,format:'text' as const,checks:[{kind:'text-includes' as const,value:'#'}],requireChanged:true})
const toolset=()=>[...tools(),...BUILTIN_TOOLS]
const trending=()=>({...templateContext(),tools:toolset(),operation:'create' as const,
  trialTask:{task:'抓取 GitHub Trending 前 10 个仓库写入 Markdown',inputs:[],artifacts:[artifact('reports/t24-r34-trending.md')],reviewItems:[]},
  conversation:evidence([
    [16,'workflow_http_request',{headers:{Accept:'text/html'},method:'GET',timeoutMs:30000,url:'https://github.com/trending'}],
    [21,'workflow_html_select',{baseUrl:'https://github.com/trending',fields:{link:{attr:'href',selector:'h2 a'},name:{selector:'h2 a',text:true},description:{selector:'p',text:true}},html:'{"$cachedBody": {"id": "74d3"}}',items:'article.Box-row',limit:10}],
    [26,'read',{file_path:'reports/t24-r34-trending.md'},'failed'],
    [31,'write',{content:'# GitHub Trending\n\n- [a](https://github.com/a)',file_path:'reports/t24-r34-trending.md'},'reported-success'],
    [36,'read',{file_path:'reports/t24-r34-trending.md'}],
  ])})
const wiki=()=>({...trending(),
  trialTask:{task:'抓取 United States 维基页面正文写入 Markdown',inputs:[],artifacts:[artifact('reports/t24-r34-wiki.md')],reviewItems:[]},
  conversation:evidence([
    [16,'workflow_http_request',{headers:{'User-Agent':'DSH-rehearsal/1.0'},method:'GET',timeoutMs:60000,url:'https://en.wikipedia.org/wiki/United_States'}],
    [21,'workflow_html_extract_text',{contentType:'text/html; charset=UTF-8',html:'{"$cachedBody": {"id": "0d47"}}',statusCode:200,url:'https://en.wikipedia.org/wiki/United_States'}],
    [26,'write','{"content":"# United States\\n\\nThe United States of America',undefined,true],
    [31,'read',{file_path:'reports/t24-r34-wiki.md'}],
  ])})

/** The fewest additions the skeleton's open list asks for. */
function completed(skeleton:TrialSkeleton,from:string){
  const order=[...skeleton.order];order.splice(order.indexOf('save'),0,'render')
  return {submission:{mode:'create',title:'照试做',forms:[
    {key:'start',template:'input',values:{fields:[{name:'note',label:'备注',type:'text',required:false}]}},
    ...structuredClone(skeleton.forms),
    {key:'render',template:'template',values:{text:`{{${from}}}`}},
    {key:'result',template:'output',values:{text:'{{save.path}} {{save.check}}',outputName:'result'}},
  ],modules:structuredClone(skeleton.modules),chains:[{key:'main',nodes:['start',...order,'result']}],coverage:{R1:[...skeleton.order,'render','result']}}}
}
const accepted=(context:ReturnType<typeof trending>,doc:unknown,requiredCoverageIds?:string[]):Workflow=>{
  const result=new TemplateFillingCompiler(context,requiredCoverageIds?{requiredCoverageIds}:{}).submit(doc)
  if(!result.ok)throw Error(JSON.stringify(result.feedback))
  return result.value.candidate!
}

describe('looks at an artifact before it is written (Desktop r52)',()=>{
  const trialTask={task:'另存',inputs:[],artifacts:[artifact('t05/out/saved.csv')],reviewItems:[]}
  it('counts reads, globs and stats of the target before the first write, never a read-back',()=>{
    const conversation=evidence([[10,'read',{file_path:'t05/out/saved.csv'},'failed'],[12,'glob',{pattern:'t05/out/saved.csv'}],[14,'workflow_file_stat',{path:'t05/out/saved.csv'}],
      [16,'read',{file_path:'t05/sellers.csv'}],[20,'write',{file_path:'t05/out/saved.csv',content:'x'}],[22,'read',{file_path:'t05/out/saved.csv'}]])
    expect(artifactProbeRefs({conversation,trialTask})).toEqual(['e10','e11','e12','e13','e14','e15'])
  })
  it('stops at a shell command naming the target or a write whose target is unreadable',()=>{
    const shell=evidence([[10,'read',{file_path:'t05/out/saved.csv'}],[12,'bash',{command:'cp t05/sellers.csv t05/out/saved.csv'}],[14,'read',{file_path:'t05/out/saved.csv'}]])
    expect(artifactProbeRefs({conversation:shell,trialTask})).toEqual(['e10','e11'])
    const unrelated=evidence([[10,'bash',{command:'shasum -a 256 t05/*.csv'}],[12,'read',{file_path:'t05/out/saved.csv'}]])
    expect(artifactProbeRefs({conversation:unrelated,trialTask})).toEqual(['e12','e13'])
    const unknown=evidence([[10,'write','{"content":"cut off'],[12,'read',{file_path:'t05/out/saved.csv'}]])
    expect(artifactProbeRefs({conversation:unknown,trialTask})).toEqual([])
  })
})

describe('trial skeleton (doc 26)',()=>{
  it('maps the r34 A path to fetch → select → verified write; probe and read-back stay with the module',()=>{
    const skeleton=buildTrialSkeleton(trending())!
    expect(skeleton.order).toEqual(['fetch','select','save'])
    expect(skeleton.forms).toEqual([
      {key:'fetch',template:'http',title:'HTTP 请求',values:{url:'https://github.com/trending',method:'GET',headers:{Accept:'text/html'},timeoutMs:30000}},
      {key:'select',template:templateIdForTool('builtin:html.select'),title:'提取网页列表',values:{inputs:{baseUrl:'https://github.com/trending',fields:{link:{attr:'href',selector:'h2 a'},name:{selector:'h2 a',text:true},description:{selector:'p',text:true}},items:'article.Box-row',limit:10,html:'{{fetch.text}}'}}},
    ])
    expect(skeleton.modules).toEqual([{key:'save',module:'verified-file-write@1.1.0',parameters:{target:'reports/t24-r34-trending.md',content:'{{render.text}}'}}])
    expect(skeleton.sources).toEqual({fetch:'e16',select:'e21',save:'e31'})
    expect(skeleton.draft?.forms.map(form=>form.key)).toEqual(['start','fetch','fetchOk','select','render','check','result'])
    expect(skeleton.open.join()).toContain('verified=false')
  })
  it('maps the r34 large page to fetch → extract and recovers a cut-off write target from the single artifact',()=>{
    const skeleton=buildTrialSkeleton(wiki())!
    expect(skeleton.order).toEqual(['fetch','extract','save'])
    expect(skeleton.forms[1]!.values).toEqual({inputs:{statusCode:'{{fetch.status_code}}',url:'https://en.wikipedia.org/wiki/United_States',html:'{{fetch.text}}',headers:'{{fetch.headers}}'}})
    expect(skeleton.modules[0]!.parameters.target).toBe('reports/t24-r34-wiki.md')
  })
  it.each([[trending,'select.text'],[wiki,'extract.text']] as const)('compiles once the open items are filled (%#)',(make,from)=>{
    const context=make(),skeleton=buildTrialSkeleton(context)!,flow=accepted(context,completed(skeleton,from))
    expect(trialSkeletonReport(skeleton,flow,[])).toEqual({used:skeleton.order,adjusted:[]})
  })
  it('reports adjusted nodes with the stated reason, without blocking',()=>{
    const context=trending(),skeleton=buildTrialSkeleton(context)!,doc:any=completed(skeleton,'select.text')
    doc.submission.forms.find((form:any)=>form.key==='select').values.inputs.items='article'
    doc.submission.forms.find((form:any)=>form.key==='fetch').values.url='{{input.url}}'
    doc.submission.forms[0].values.fields.push({name:'url',label:'网址',type:'text',required:true,defaultValue:'https://github.com/trending'})
    const flow=accepted(context,doc)
    expect(trialSkeletonReport(skeleton,flow,['骨架调整：select：改用更宽的条目选择器'])).toEqual({used:['fetch','save'],adjusted:[{key:'select',reason:'改用更宽的条目选择器'}]})
    expect(trialSkeletonReport(skeleton,flow,[]).adjusted).toEqual([{key:'select',reason:'未说明理由'}])
  })
  it('counts a selector turned into a run parameter inside fields as kept, not adjusted (Desktop r40 B)',()=>{
    const context=trending(),skeleton=buildTrialSkeleton(context)!,doc:any=completed(skeleton,'select.text')
    doc.submission.forms.find((form:any)=>form.key==='select').values.inputs.fields.description.selector='{{input.descriptionSelector}}'
    doc.submission.forms[0].values.fields.push({name:'descriptionSelector',label:'描述选择器',type:'text',required:false,defaultValue:'p'})
    expect(trialSkeletonReport(skeleton,accepted(context,doc),[])).toEqual({used:skeleton.order,adjusted:[]})
  })
  it('keeps the later of two consecutive calls and skips calls with no node equivalent',()=>{
    const context=trending()
    context.conversation=evidence([
      [10,'web_fetch',{url:'https://github.com/trending'}],
      [16,'workflow_http_request',{url:'https://github.com/trending',headers:{Range:'bytes=0-10'}}],
      [21,'workflow_http_request',{url:'https://github.com/trending',timeoutMs:999_999}],
      [26,'bash',{command:'curl …'}],
      [31,'write',{file_path:'/private/tmp/ws/reports/t24-r34-trending.md',content:'x'}],
      [36,'write',{file_path:'/private/tmp/ws/scratch.txt',content:'x'}],
    ])
    const skeleton=buildTrialSkeleton(context)!
    expect(skeleton.forms).toEqual([{key:'fetch',template:'http',title:'HTTP 请求',values:{url:'https://github.com/trending',method:'GET',timeoutMs:120000}}])
    expect(skeleton.sources).toEqual({fetch:'e21',save:'e31'})
    expect(skeleton.modules.map(row=>row.parameters.target)).toEqual(['reports/t24-r34-trending.md'])
  })
  describe('complete draft (doc 26 §7)',()=>{
    const repos=[{name:'a / x',link:'https://github.com/a/x',description:'Alpha'},{name:'b / y',link:'https://github.com/b/y',description:'Beta'},{name:'c / z',link:'https://github.com/c/z',description:'Gamma'}]
    const line=(repo:typeof repos[number])=>`- [${repo.name}](${repo.link}) — ${repo.description}\n`
    const listing=(result:string,content:string,limit:number|undefined=3)=>({...trending(),
      procedure:{goal:'列表',parameters:[],rules:[],excluded:[],reviewItems:[],steps:[
        {id:'s1',title:'抓取',instruction:'抓取',dependsOn:[],evidenceRefs:['e16','e17'],requiresReview:false},
        {id:'s2',title:'提取',instruction:'提取',dependsOn:['s1'],evidenceRefs:['e21','e22'],requiresReview:false},
        {id:'s3',title:'写入核对',instruction:'写入并回读',dependsOn:['s2'],evidenceRefs:['e26','e31','e36'],requiresReview:false}]},
      conversation:evidence([
        [16,'workflow_http_request',{method:'GET',url:'https://github.com/trending'}],
        [21,'workflow_html_select',{baseUrl:'https://github.com/trending',fields:{name:{selector:'h2 a',text:true},link:{selector:'h2 a',attr:'href'},description:{selector:'p',text:true}},html:'{"$cachedBody":{"id":"x"}}',items:'article.Box-row',...(limit===undefined?{}:{limit})},'unknown',false,result],
        [26,'read',{file_path:'reports/t24-r34-trending.md'},'failed'],
        [31,'write',{content,file_path:'reports/t24-r34-trending.md'},'reported-success'],
        [36,'read',{file_path:'reports/t24-r34-trending.md'}],
      ])})
    const draftOf=(context:ReturnType<typeof listing>)=>buildTrialSkeleton(context,{procedure:context.procedure as any,title:'照试做'})
    const content='# GitHub Trending\n\n'+repos.map(line).join('')
    it('reverses the written list into a render template proved against the trial file, and the draft compiles as is',()=>{
      const context=listing(JSON.stringify({items:repos,count:3}),content),skeleton=draftOf(context)!
      expect(skeleton.draft!.forms.find(form=>form.key==='render')!.values.text).toBe('# GitHub Trending\n\n{% for item in select.items %}- [{{item.name | default("")}}]({{item.link | default("")}}) — {{item.description | default("")}}\n{% endfor %}')
      expect(skeleton.draft!.chains[0]!.nodes).toEqual(['start','fetch','fetchOk','select','render','save','check','result'])
      expect(skeleton.draft!.coverage).toMatchObject({s1:['fetch'],s2:['select'],s3:['save','check','render']})
      expect(skeleton.draft!.forms.find(form=>form.key==='fetch')!.values.url).toBe('{{input.url}}')
      expect(String(skeleton.draft!.forms.find(form=>form.key==='check')!.values.code)).toContain('!== 3')
      expect(skeleton.open.join()).toContain('verified=true')
      const prompt=trialSkeletonPrompt(skeleton)
      expect(prompt).not.toHaveProperty('forms');expect(prompt).toHaveProperty('draft')
      const flow=accepted(context,{submission:skeleton.draft},['R1','s1','s2','s3'])
      expect(trialSkeletonReport(skeleton,flow,[])).toEqual({used:['fetch','select','save'],adjusted:[]})
    })
    it('checks each record title and link the trial wrote and reports each node in the result (Desktop r57 C)',()=>{
      const context=listing(JSON.stringify({items:repos,count:3}),content),skeleton=draftOf(context)!,forms=skeleton.draft!.forms
      const check=forms.find(form=>form.key==='check')!.values as {inputs:Record<string,string>;code:string}
      expect(check.inputs.items).toBe('{{select.items}}')
      // The name and link are written verbatim for every record; the description too, but only one title field is checked.
      expect(check.code).toContain('var shown = ["name","link"], links = ["link"];')
      const main=new Function(check.code+'\nreturn main;')() as (inputs:Record<string,unknown>)=>{summary:string}
      const run=(items:unknown,text=content)=>main({content:text,writeCheck:'window-match',checkNote:'',count:3,items})
      expect(run(repos).summary).toContain('逐条核对 name、link')
      expect(run(JSON.stringify(repos)).summary).toContain('写入回读 window-match')
      expect(()=>run([{...repos[0],link:'/a/x'},repos[1],repos[2]])).toThrow('第 1 条的 link 不是完整网址：/a/x')
      expect(()=>run([repos[0],{...repos[1],name:' '},repos[2]])).toThrow('第 2 条的 name 为空')
      expect(()=>run(repos,content.replace('c / z','c-z'))).toThrow('正文缺少第 3 条的 name「c / z」')
      expect(forms.find(form=>form.key==='result')!.values.text).toMatch(/^抓取 fetch：HTTP \{\{fetch\.status_code\}\}，\{\{fetch\.bytes\}\} 字节\n提取 select：\{\{select\.count\}\} 条\n\{\{check\.summary\}\}/)
      expect(skeleton.open.join()).toContain('逐条核对 name、link（非空、链接为完整网址、正文含有）')
      accepted(context,{submission:skeleton.draft},['R1','s1','s2','s3'])
    })
    it('counts records past a cut-off result by their shape and fills a missing limit',()=>{
      const cut=JSON.stringify({items:repos,count:3}).slice(0,-60)
      const skeleton=draftOf(listing(cut,content,undefined))!
      expect(skeleton.open.join()).toContain('前 2 条记录逐字一致、共 3 条同格式')
      expect((skeleton.draft!.forms.find(form=>form.key==='select')!.values.inputs as any).limit).toBe(3)
    })
    it('numbers a numbered list with the loop index',()=>{
      const numbered='# GitHub Trending\n\n'+repos.map((repo,index)=>`${index+1}. [${repo.name}](${repo.link}) — ${repo.description}\n`).join('')
      const context=listing(JSON.stringify({items:repos,count:3}),numbered),skeleton=draftOf(context)!
      expect(skeleton.draft!.forms.find(form=>form.key==='render')!.values.text).toBe('# GitHub Trending\n\n{% for item in select.items %}{{loop.index}}. [{{item.name | default("")}}]({{item.link | default("")}}) — {{item.description | default("")}}\n{% endfor %}')
      expect(skeleton.open.join()).toContain('verified=true')
      accepted(context,{submission:skeleton.draft},['R1','s1','s2','s3'])
    })
    it('leaves the render open when the trial file does not follow one format',()=>{
      const skeleton=draftOf(listing(JSON.stringify({items:repos,count:3}),'# GitHub Trending\n\n'+line(repos[0]!)+`* ${repos[1]!.name} ${repos[1]!.link}\n`+line(repos[2]!)))!
      expect(skeleton.draft!.forms.find(form=>form.key==='render')!.values.text).toBe('{{select.text}}')
      expect(skeleton.open.join()).toContain('verified=false')
    })
    it('reverses a cut-off trial write with a repeated field, checking only the records it reached (Desktop r40)',()=>{
      const twice=(repo:typeof repos[number])=>`- ${repo.name} — [${repo.link}](${repo.link})：${repo.description}\n`
      const written='# GitHub Trending\n\n'+repos.map(twice).join('')
      const cut=JSON.stringify({file_path:'reports/t24-r34-trending.md',content:written}).slice(0,-45)+'\n[摘录：原记录未完整保留]'
      const context=listing(JSON.stringify({items:repos,count:3}),'unused')
      context.conversation.records=context.conversation.records.map(row=>row.toolName==='write'&&row.kind==='tool-call'?{...row,text:cut,truncated:true,status:'unknown' as const}:row)
      const skeleton=draftOf(context)!
      expect(skeleton.draft!.forms.find(form=>form.key==='render')!.values.text).toBe('# GitHub Trending\n\n{% for item in select.items %}- {{item.name | default("")}} — [{{item.link | default("")}}]({{item.link | default("")}})：{{item.description | default("")}}\n{% endfor %}')
      expect(skeleton.open.join()).toContain('前 2 条记录逐字一致、共 3 条同格式')
      expect(skeleton.open.join()).toContain('写入记录被截断')
      accepted(context,{submission:skeleton.draft},['R1','s1','s2','s3'])
    })
    it('gives a per-item template its own iteration when the task asks for one template per record (Desktop r40 B)',()=>{
      const numbered='# Trending Top 3\n\n'+repos.map((repo,index)=>`${index+1}. ${repo.name} — ${repo.description}（${repo.link}）\n`).join('')
      const context=listing(JSON.stringify({items:repos,count:3}),numbered)
      context.trialTask={...context.trialTask,task:'提取前 3 个仓库；逐条用同一模板生成一行，合并成 Markdown 写入文件'}
      const skeleton=draftOf(context)!,forms=skeleton.draft!.forms
      expect(forms.find(form=>form.key==='lines')!.values).toMatchObject({iterator:'select.items',outputVariable:'line.text'})
      expect(forms.find(form=>form.key==='line')!.values.text).toBe('{{item.name | default("")}} — {{item.description | default("")}}（{{item.link | default("")}}）')
      expect(forms.find(form=>form.key==='render')!.values.text).toBe('# Trending Top 3\n\n{% for row in lines.result %}{{loop.index}}. {{row}}\n{% endfor %}')
      expect(skeleton.draft!.chains).toEqual([{key:'main',nodes:['start','fetch','fetchOk','select','lines','render','save','check','result']},{key:'lineChain',container:'lines',nodes:['line']}])
      accepted(context,{submission:skeleton.draft},['R1','s1','s2','s3'])
      expect(draftOf(listing(JSON.stringify({items:repos,count:3}),numbered))!.draft!.forms.some(form=>form.key==='lines')).toBe(false)
    })
    it('reverses a field the trial tidied with a filter the template can express (Desktop r41 B)',()=>{
      // "a / x" is written as "a/x", which also appears inside the link.
      const tidy='# Trending Top 3\n\n'+repos.map((repo,index)=>`${index+1}. ${repo.name.split(' / ').join('/')} — ${repo.description.toLowerCase()}（${repo.link}）\n`).join('')
      const context=listing(JSON.stringify({items:repos,count:3}),tidy)
      context.trialTask={...context.trialTask,task:'提取前 3 个仓库，逐条套用同一模板生成一行，合并成 Markdown 写入文件'}
      const skeleton=draftOf(context)!
      expect(skeleton.draft!.forms.find(form=>form.key==='line')!.values.text).toBe('{{item.name | default("") | replace(" / ", "/")}} — {{item.description | default("") | lower}}（{{item.link | default("")}}）')
      expect(skeleton.open.join()).toContain('verified=true')
      // The name goes through replace, so only the link is checked against the text.
      expect(String(skeleton.draft!.forms.find(form=>form.key==='check')!.values.code)).toContain('var shown = ["link"], links = ["link"];')
      accepted(context,{submission:skeleton.draft},['R1','s1','s2','s3'])
    })
    it('offers no draft for review steps or several artifacts',()=>{
      const review=listing(JSON.stringify({items:repos}),content);(review.procedure.steps[2] as any).requiresReview=true
      expect(draftOf(review)!.draft).toBeUndefined()
      expect(buildTrialSkeleton(listing(JSON.stringify({items:repos}),content),{draft:false})!.draft).toBeUndefined()
    })
  })
  describe('input files (T05 附件另存为文件, Desktop r44)',()=>{
    const csv='"seller_id","seller_city"\n"3442f8","campinas"\nd1b65f,"mogi guacu"'
    const readResult=(text:string,path:string)=>`<path>/ws/${path}</path>\n<type>file</type>\n<content>\n${text.split('\n').map((line,index)=>`${index+1}: ${line}`).join('\n')}\n\n(End of file - total ${text.split('\n').length} lines)\n</content>`
    const copying=(task:string,written=csv+'\n',input='t05/sellers.csv')=>({...trending(),
      trialTask:{task,inputs:[input],artifacts:[artifact('t05/out/saved.csv')],reviewItems:[]},
      procedure:{goal:'另存',parameters:[],rules:[],excluded:[],reviewItems:[],steps:[
        {id:'s1',title:'读取',instruction:'读取输入',dependsOn:[],evidenceRefs:['e16','e17'],requiresReview:false},
        {id:'s2',title:'写入核对',instruction:'写入并回读',dependsOn:['s1'],evidenceRefs:['e21','e26'],requiresReview:false}]},
      conversation:evidence([
        [16,'read',{file_path:input},'reported-success',false,readResult(csv,input)],
        [21,'write',{content:written,file_path:'t05/out/saved.csv'},'reported-success'],
        [26,'read',{file_path:'t05/out/saved.csv'},'reported-success',false,readResult(csv,'t05/out/saved.csv')],
      ])})
    const draftOf=(context:ReturnType<typeof copying>)=>buildTrialSkeleton(context,{procedure:context.procedure as any,title:'另存'})!
    it('reads an upload with a document node and writes the read text as is when the trial copied it verbatim',()=>{
      const context=copying('用工作区文件 t05/sellers.csv 作为上传附件运行一次：读取附件文本 → 覆盖写入 t05/out/saved.csv'),skeleton=draftOf(context)
      expect(skeleton.forms).toEqual([{key:'read',template:'document',title:'读取输入文件',values:{source:'t05/sellers.csv',documentMode:'local'}}])
      const draft=skeleton.draft!
      expect(draft.chains[0]!.nodes).toEqual(['start','read','save','check','result'])
      expect(draft.forms.find(form=>form.key==='start')!.values.fields).toEqual([{name:'file',label:'附件',type:'file',required:true},{name:'outputPath',label:'输出文件路径',type:'text',required:false,defaultValue:'t05/out/saved.csv'}])
      expect(draft.forms.find(form=>form.key==='read')).toMatchObject({title:'读取上传附件',values:{source:'input.file',documentMode:'local'}})
      expect(draft.forms.some(form=>form.key==='render')).toBe(false)
      expect(draft.modules[0]!.parameters).toEqual({target:'{{input.outputPath}}',content:'{{read.text}}'})
      expect(draft.coverage).toMatchObject({s1:['read'],s2:['save','check']})
      expect(skeleton.open.join()).toContain('逐字一致（verified=true）')
      // Desktop r45: a brief naming write/read tools is no reason to split the module.
      expect(skeleton.instruction).toContain('不是拆掉模块的理由')
      const flow=accepted(context,{submission:draft},['R1','s1','s2'])
      expect(trialSkeletonReport(skeleton,flow,[])).toEqual({used:['read','save'],adjusted:[]})
    })
    it('does not pin text the trial input already held once that input is a parameter (Desktop r46)',()=>{
      const context=copying('用工作区文件 t05/sellers.csv 作为上传附件运行一次：读取附件文本 → 覆盖写入 t05/out/saved.csv')
      context.trialTask.artifacts=[{...artifact('t05/out/saved.csv'),checks:[{kind:'text-includes',value:'"seller_id","seller_city"'},{kind:'text-includes',value:'#'}]}]
      const skeleton=draftOf(context),code=String(skeleton.draft!.forms.find(form=>form.key==='check')!.values.code)
      expect(code).toContain('var includes = ["#"]')
      expect(code).not.toContain('seller_id')
      expect(skeleton.open.join()).toContain('check 不写死 「"seller_id","seller_city"」')
      accepted(context,{submission:skeleton.draft},['R1','s1','s2'])
    })
    it('keeps official tools the trial ran but no node maps out of fixed nodes and points to an Agent node (T18)',()=>{
      const context=copying('用工作区文件 t05/sellers.csv 作为上传附件运行一次：读取附件文本 → 覆盖写入 t05/out/saved.csv')
      context.tools=[...context.tools,{id:'native:bash',name:'bash',description:'shell',providerId:'p',providerName:'p',category:'plugin',available:true,inputSchema:{type:'object',properties:{command:{type:'string'}},required:['command']}}]
      context.conversation=evidence([[10,'glob',{pattern:'t05/*'}],[12,'bash',{command:'wc -l t05/sellers.csv'}],
        [16,'read',{file_path:'t05/sellers.csv'},'reported-success',false,readResult(csv,'t05/sellers.csv')],[21,'write',{content:csv+'\n',file_path:'t05/out/saved.csv'},'reported-success']])
      const skeleton=draftOf(context),note=skeleton.open.find(text=>text.startsWith('试做还用了'))
      expect(note).toContain('试做还用了 bash：');expect(note).toContain('tools 填 native:bash')
      expect(note).not.toContain('glob')
      expect(note).toContain('roles 声明子 Agent {key,name,prompt}、节点 values.subagentId 填这个 key')
      expect(JSON.stringify(skeleton.draft)).not.toContain('native:bash')
    })
    it('refuses an Agent node without a sub-agent in a trial-derived graph and accepts it once roles bind it (Desktop r51)',()=>{
      const context={...copying('用工作区文件 t05/sellers.csv 作为上传附件运行一次：读取附件文本 → 覆盖写入 t05/out/saved.csv'),
        trial:{trialId:'trial-1',rootSessionId:'root',childSessionId:'child',workspaceId:'ws',specDigest:'0'.repeat(64),verificationDigest:'0'.repeat(64),evidenceDigest:'0'.repeat(64),receiptDigest:'0'.repeat(64)}}
      context.tools=[...context.tools,{id:'native:bash',name:'bash',description:'shell',providerId:'p',providerName:'p',category:'plugin',available:true,inputSchema:{type:'object',properties:{command:{type:'string'}},required:['command']}}]
      const draft=structuredClone(draftOf(context).draft!) as any
      draft.forms.push({key:'hash',template:'agent',values:{prompt:'计算 {{read.text}} 的校验和',tools:['native:bash']}})
      draft.chains[0].nodes.splice(draft.chains[0].nodes.indexOf('result'),0,'hash')
      const refused=new TemplateFillingCompiler(context,{requiredCoverageIds:['R1','s1','s2']}).submit({submission:draft})
      expect(refused.ok).toBe(false)
      expect(JSON.stringify(refused)).toContain('Agent 节点必须绑定子 Agent')
      draft.roles=[{key:'hasher',name:'校验员',prompt:'用 bash 计算校验和'}];draft.forms.at(-1).values.subagentId='hasher'
      const flow=accepted(context,{submission:draft},['R1','s1','s2'])
      expect(flow.nodes.find(node=>node.kind==='agent')!.config.subagentId).toBe(flow.subAgents![0]!.id)
    })
    it('maps a trial file stat of an input to a file.stat node on the same path parameter, leaving the artifact to the module (Desktop r48)',()=>{
      const context=copying('统计 t05/sellers.csv 的字节数和行数，整理后写入 t05/out/saved.csv','# 卖家\n'+csv)
      context.conversation=evidence([[10,'workflow_file_stat',{path:'/ws/t05/sellers.csv'},'reported-success'],[12,'workflow_file_stat',{path:'t05/out/saved.csv'},'reported-success'],
        [16,'read',{file_path:'t05/sellers.csv'},'reported-success',false,readResult(csv,'t05/sellers.csv')],[21,'write',{content:'# 卖家\n'+csv,file_path:'t05/out/saved.csv'},'reported-success']])
      const skeleton=draftOf(context)
      expect(skeleton.forms).toContainEqual({key:'stat',template:templateIdForTool('builtin:file.stat'),title:'统计文件信息',values:{inputs:{path:'t05/sellers.csv'}}})
      expect(skeleton.forms.filter(form=>form.key.startsWith('stat'))).toHaveLength(1)
      const draft=skeleton.draft!
      expect(draft.forms.find(form=>form.key==='stat')!.values.inputs).toEqual({path:'{{input.inputPath}}'})
      expect(draft.forms.find(form=>form.key==='read')!.values.source).toBe('input.inputPath')
      expect(draft.forms.find(form=>form.key==='render')!.values.text).toBe('{{read.text}}')
      accepted(context,{submission:draft},['R1','s1','s2'])
      const upload=copying('用工作区文件 t05/sellers.csv 作为上传附件运行一次：统计字节数后写入 t05/out/saved.csv')
      upload.conversation=evidence([[10,'workflow_file_stat',{path:'t05/sellers.csv'},'reported-success'],[16,'read',{file_path:'t05/sellers.csv'},'reported-success',false,readResult(csv,'t05/sellers.csv')],[21,'write',{content:csv+'\n',file_path:'t05/out/saved.csv'},'reported-success']])
      expect(draftOf(upload).open.join()).toContain('stat 统计的是试做文件 t05/sellers.csv；运行时上传的附件不是工作区文件')
    })
    describe('each file in a directory (Desktop r49)',()=>{
      const stat=(path:string,bytes:number,lines:number)=>JSON.stringify({text:`${path}：${bytes} 字节，${lines} 行，行尾 lf`,path,name:path.split('/').pop(),bytes,lines,lineEnding:'lf',endsWithNewline:true,bom:false})
      const table='# CSV 统计\n\n| 文件名 | 行数 | 字节数 |\n| --- | ---: | ---: |\n| a.csv | 16 | 484 |\n| b.csv | 6 | 367 |\n'
      const listed=(globbed:string,written=table)=>{
        const context=copying('统计 t05 目录下每个 .csv 文件的行数和字节数，写成表格存到 t05/out/saved.csv',written)
        context.trialTask.inputs=[];context.procedure.steps[0]!.evidenceRefs=['e10','e12','e14']
        context.conversation=evidence([[10,'glob',{pattern:'t05/*.csv'},'reported-success',false,globbed],
          [12,'workflow_file_stat',{path:'t05/a.csv'},'reported-success',false,stat('t05/a.csv',484,16)],
          [14,'workflow_file_stat',{path:'t05/b.csv'},'reported-success',false,stat('t05/b.csv',367,6)],
          [21,'write',{content:written,file_path:'t05/out/saved.csv'},'reported-success']])
        return context
      }
      it('stats each file the glob lists in an iteration, sorted by path, with the table proved against the trial file',()=>{
        const context=listed('t05/b.csv\nt05/a.csv'),skeleton=draftOf(context),draft=skeleton.draft!
        expect(skeleton.order).toEqual(['files','sorted','each','save'])
        expect(skeleton.forms.find(form=>form.key==='stat')!.values.inputs).toEqual({path:'{{item}}'})
        expect(draft.chains).toEqual([{key:'main',nodes:['start','files','sorted','each','render','save','check','result']},{key:'eachChain',container:'each',nodes:['stat']}])
        expect(draft.forms.find(form=>form.key==='files')!.values.inputs).toEqual({pattern:'{{input.pattern}}'})
        expect(draft.forms.find(form=>form.key==='start')!.values.fields).toContainEqual({name:'pattern',label:'文件匹配模式',type:'text',required:false,defaultValue:'t05/*.csv'})
        expect(draft.forms.find(form=>form.key==='render')!.values.text).toBe('# CSV 统计\n\n| 文件名 | 行数 | 字节数 |\n| --- | ---: | ---: |\n{% for item in each.result %}| {{item.name | default("")}} | {{item.lines | default("")}} | {{item.bytes | default("")}} |\n{% endfor %}')
        expect(String(draft.forms.find(form=>form.key==='check')!.values.code)).toContain('没有匹配的文件')
        expect(draft.coverage).toMatchObject({s1:['files','each']})
        expect(skeleton.open.join()).toContain('verified=true')
        expect(skeleton.open.join()).toContain('试做先用 glob 列出 2 个文件，再逐个统计了全部')
        const flow=accepted(context,{submission:draft},['R1','s1','s2'])
        expect(trialSkeletonReport(skeleton,flow,[])).toEqual({used:['files','sorted','each','save'],adjusted:[]})
      })
      it('proves the table when the trial wrote the rows in listing order, not path order (Desktop r52 A)',()=>{
        const globOrder='# CSV 统计\n\n| 文件名 | 行数 | 字节数 |\n| --- | ---: | ---: |\n| b.csv | 6 | 367 |\n| a.csv | 16 | 484 |\n'
        const skeleton=draftOf(listed('t05/b.csv\nt05/a.csv',globOrder)),draft=skeleton.draft!
        expect(draft.forms.find(form=>form.key==='render')!.values.text).toBe('# CSV 统计\n\n| 文件名 | 行数 | 字节数 |\n| --- | ---: | ---: |\n{% for item in each.result %}| {{item.name | default("")}} | {{item.lines | default("")}} | {{item.bytes | default("")}} |\n{% endfor %}')
        expect(skeleton.open.join()).toContain('verified=true')
      })
      it('keeps fixed stat nodes when the trial statted only some of the listed files',()=>{
        const skeleton=draftOf(listed('t05/b.csv\nt05/a.csv\nt05/c.csv'))
        expect(skeleton.forms.map(form=>form.key)).toEqual(['stat','stat2'])
        expect(skeleton.open.join()).not.toContain('逐个统计 files')
      })
      it('flags fixed text around the table that names a trial file',()=>{
        const context=listed('t05/b.csv\nt05/a.csv'),noted=table+'\n说明：a.csv 含 BOM。\n'
        context.conversation.records=context.conversation.records.map(row=>row.toolName==='write'&&row.kind==='tool-call'?{...row,text:JSON.stringify({content:noted,file_path:'t05/out/saved.csv'})}:row)
        expect(draftOf(context).open.join()).toContain('render 表格前后的固定文字写到了试做的文件 a.csv')
        expect(draftOf(listed('t05/b.csv\nt05/a.csv')).open.join()).not.toContain('固定文字')
      })
    })
    it('turns a workspace input into a path parameter, keeps a render when the trial rewrote the text, and keeps two inputs apart',()=>{
      const changed=draftOf(copying('把 t05/sellers.csv 的内容整理后写入 t05/out/saved.csv','# 卖家\n'+csv))
      expect(changed.draft!.forms.find(form=>form.key==='start')!.values.fields).toContainEqual({name:'inputPath',label:'输入文件路径',type:'text',required:false,defaultValue:'t05/sellers.csv'})
      expect(changed.draft!.forms.find(form=>form.key==='read')).toMatchObject({title:'读取输入文件',values:{source:'input.inputPath'}})
      expect(changed.draft!.forms.find(form=>form.key==='render')!.values.text).toBe('{{read.text}}')
      expect(changed.draft!.modules[0]!.parameters.content).toBe('{{render.text}}')
      expect(changed.open.join()).toContain('verified=false')
      const two=copying('合并两个文件写入 t05/out/saved.csv')
      two.trialTask.inputs=['t05/a.csv','t05/b.csv']
      two.conversation=evidence([[10,'read',{file_path:'t05/a.csv'}],[12,'read',{file_path:'t05/b.csv'}],[14,'read',{file_path:'t05/a.csv'}],[21,'write',{content:'x',file_path:'t05/out/saved.csv'},'reported-success']])
      expect(buildTrialSkeleton(two)!.forms.map(form=>[form.key,form.values.source])).toEqual([['read','t05/a.csv'],['read2','t05/b.csv']])
    })
    const pdfTool={id:'native:pdf_to_text',name:'pdf_to_text',description:'PDF 转文字',providerId:'mcp-pdf',providerName:'PDF',category:'mcp' as const,available:true,
      inputSchema:{type:'object',properties:{path:{type:'string'},pages:{type:'string'}},required:['path'],additionalProperties:false}}
    const pdf=(calls:Call[],task='读取 t05/report.pdf 的文字写入 t05/out/saved.csv')=>{const context=copying(task,'x','t05/report.pdf');context.tools=[...context.tools,pdfTool];context.conversation=evidence([...calls,[40,'write',{content:'正文',file_path:'t05/out/saved.csv'},'reported-success']]);return context}
    const converted=JSON.stringify({pages:2,content:'第一页正文\n第二页正文',source:'t05/report.pdf'})
    it('reads another format with the document Agent when the trial read it directly, and says it calls a model',()=>{
      const context=pdf([[16,'read',{file_path:'t05/report.pdf'},'reported-success']]),skeleton=buildTrialSkeleton(context,{procedure:context.procedure as any,title:'另存'})!
      expect(skeleton.forms).toEqual([{key:'read',template:'document',title:'读取输入文件',values:{source:'t05/report.pdf',documentMode:'agent',tools:['native:read'],prompt:'按原文顺序提取文档全部文字，保留段落结构，不要总结或改写。'}}])
      expect(skeleton.open.join()).toContain('会调用模型')
      expect(skeleton.draft!.forms.find(form=>form.key==='read')!.values).toMatchObject({source:'input.inputPath',documentMode:'agent'})
      accepted(context,{submission:skeleton.draft},['R1','s1','s2'])
    })
    it('uses the parsing tool the trial ran, in place of an earlier direct read, with its other arguments and text field',()=>{
      const context=pdf([[16,'read',{file_path:'t05/report.pdf'},'reported-success'],[21,'pdf_to_text',{path:'/ws/t05/report.pdf',pages:'all'},'reported-success',false,converted],[30,'glob',{pattern:'t05/report.pdf'},'reported-success']],'把上传的 PDF 附件转成文字写入 t05/out/saved.csv')
      const skeleton=buildTrialSkeleton(context,{procedure:context.procedure as any,title:'另存'})!
      expect(skeleton.forms).toEqual([{key:'read',template:'document',title:'读取输入文件',values:{source:'t05/report.pdf',documentMode:'tool',toolId:'native:pdf_to_text',documentSourceKey:'path',documentTextPath:'content',inputs:{pages:'all'}}}])
      expect(skeleton.sources.read).toBe('e21')
      expect(skeleton.open.join()).not.toContain('会调用模型')
      expect(skeleton.draft!.forms.find(form=>form.key==='read')).toMatchObject({title:'读取上传附件',values:{source:'input.file',documentMode:'tool'}})
      const flow=accepted(context,{submission:skeleton.draft},['R1','s1','s2'])
      expect(trialSkeletonReport(skeleton,flow,[]).adjusted).toEqual([])
    })
  })
  it('is absent without a trial, for edits, or when nothing maps',()=>{
    expect(buildTrialSkeleton({...trending(),trialTask:undefined})).toBeUndefined()
    expect(buildTrialSkeleton({...trending(),operation:'revise'})).toBeUndefined()
    expect(buildTrialSkeleton({...trending(),conversation:evidence([[16,'web_fetch',{url:'https://github.com/trending'}]])})).toBeUndefined()
  })
})

describe('a step done with an official tool no node maps (Desktop r52 B)',()=>{
  const bash={id:'native:bash',name:'bash',description:'shell',providerId:'p',providerName:'p',category:'plugin' as const,available:true,inputSchema:{type:'object',properties:{command:{type:'string'}},required:['command']}}
  const [x,y]=['a'.repeat(64),'b'.repeat(64)]
  const table=`| 文件名 | SHA-256 |\n| --- | --- |\n| x.csv | ${x} |\n| y.csv | ${y} |\n`
  const hashing=(excluded:string[]=[])=>({...trending(),tools:[...toolset(),bash],
    trial:{trialId:'trial-1',rootSessionId:'root',childSessionId:'child',workspaceId:'ws',specDigest:'0'.repeat(64),verificationDigest:'0'.repeat(64),evidenceDigest:'0'.repeat(64),receiptDigest:'0'.repeat(64)},
    trialTask:{task:'用 shasum -a 256 计算 t05 下每个 csv 的 SHA-256，写成表格存到 t05/out/sums.md',inputs:[],reviewItems:[],
      artifacts:[{path:'t05/out/sums.md',format:'text' as const,requireChanged:false,checks:[{kind:'text-includes' as const,value:'文件名'},{kind:'text-includes' as const,value:'x.csv'},{kind:'text-includes' as const,value:x}]}]},
    procedure:{goal:'校验和',parameters:[],rules:[],reviewItems:[],excluded:excluded.length?[{evidenceRefs:excluded,reason:'查看'}]:[],steps:[
      {id:'s1',title:'计算',instruction:'shasum',dependsOn:[],evidenceRefs:['e10','e11',...['e12','e13'].filter(ref=>!excluded.includes(ref))],requiresReview:false},
      {id:'s2',title:'写入核对',instruction:'写入并核对',dependsOn:['s1'],evidenceRefs:['e16','e17','e21','e22','e26','e27','e30','e31'],requiresReview:false}]},
    conversation:evidence([
      [10,'glob',{pattern:'t05/*.csv'},'reported-success',false,'t05/y.csv\nt05/x.csv'],
      [12,'bash',{command:'shasum -a 256 t05/*.csv',description:'hash'},'reported-success',false,`${x}  t05/x.csv\n${y}  t05/y.csv`],
      [16,'read',{file_path:'t05/out/sums.md'},'reported-success',false,'old'],
      [21,'write',{content:table,file_path:'t05/out/sums.md'},'reported-success'],
      [26,'read',{file_path:'t05/out/sums.md'},'reported-success'],
      [30,'bash',{command:'diff <(shasum -a 256 t05/*.csv) t05/out/sums.md'},'reported-success',false,'IDENTICAL'],
    ])})
  const skeletonOf=(context:ReturnType<typeof hashing>,draft?:false)=>buildTrialSkeleton(context,{procedure:context.procedure as any,title:'校验和',...(draft===false?{draft}:{})})!
  it('drafts an Agent node bound to a sub-agent with the trial command as its task, and leaves the parse to the author',()=>{
    const context=hashing(),skeleton=skeletonOf(context),draft=skeleton.draft!
    expect(skeleton.forms).toEqual([{key:'run',template:'agent',title:'执行命令',values:{subagentId:'runner',tools:['native:bash'],prompt:expect.stringContaining('\nshasum -a 256 t05/*.csv')}}])
    expect(draft.roles).toEqual([expect.objectContaining({key:'runner',name:'试做步骤执行器'})])
    expect(draft.chains).toEqual([{key:'main',nodes:['start','run','render','save','check','result']}])
    expect(draft.forms.find(form=>form.key==='run')!.values.prompt).toContain('\nshasum -a 256 {{input.pattern}}')
    expect(draft.forms.find(form=>form.key==='start')!.values.fields).toContainEqual({name:'pattern',label:'文件匹配模式',type:'text',required:false,defaultValue:'t05/*.csv'})
    expect(String(draft.forms.find(form=>form.key==='check')!.values.code)).toContain('var includes = ["文件名"]')
    const open=skeleton.open.join()
    expect(open).toContain(`check 不写死 「x.csv」、「${x}」：这些文字是试做时命令的输出`)
    expect(open).toContain('render.values.text 是占位（verified=false）：run.text 是命令的原样输出')
    expect(open).not.toContain('试做还用了')
    expect(draft.coverage).toMatchObject({s1:['run']})
    const flow=accepted(context,{submission:draft},['R1','s1','s2'])
    expect(flow.nodes.find(node=>node.kind==='agent')!.config.subagentId).toBe(flow.subAgents![0]!.id)
    expect(trialSkeletonReport(skeleton,flow,[])).toEqual({used:['run','save'],adjusted:[]})
  })
  it('has the author review the draft and fill its placeholder with the trial record in view (T29)',()=>{
    const context=hashing(),skeleton=skeletonOf(context)
    const compiler=new TemplateFillingCompiler(context,{prefetch:[...new Set(skeleton.draft!.forms.map(form=>form.template))]})
    const task={request:{instruction:'算校验和'},context,procedure:context.procedure,answers:[]} as any
    const prompt=JSON.parse(authorPrompt(task,{handoff:undefined,authorContext:context,authorCompiler:compiler,authorKinds:[],skeleton,continuation:undefined}))
    expect(prompt.instruction).toContain('verified=false 的节点是占位')
    expect(prompt.trialEvidence).toEqual(context.conversation)
    expect(prompt.runtimeSemantics.nodes.map((node:any)=>node.kind)).toEqual(['template','code'])
    expect(prompt.trialSkeleton.draft.roles).toEqual([expect.objectContaining({key:'runner'})])
  })
  it('offers the role with the bare node lists when there is no draft',()=>{
    expect(trialSkeletonPrompt(skeletonOf(hashing(),false))).toMatchObject({roles:[{key:'runner'}],forms:[{key:'run'}]})
    expect(trialSkeletonPrompt(skeletonOf(hashing()))).not.toHaveProperty('roles')
  })
  it('leaves a call the method excluded to the open note',()=>{
    const skeleton=skeletonOf(hashing(['e12','e13']))
    expect(skeleton.forms).toEqual([])
    expect(skeleton.open.join()).toContain('试做还用了 bash：')
  })
})
