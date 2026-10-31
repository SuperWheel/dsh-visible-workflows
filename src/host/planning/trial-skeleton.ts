import { isDeepStrictEqual } from 'node:util'
import { templateIdForTool } from '../../shared/planning-node-templates.ts'
import { verifiedModuleInstances } from '../../shared/planning-module-fragments.ts'
import type { PlanningContext } from '../../shared/planning-types.ts'
import type { TaskProcedure } from '../../shared/retrospective.ts'
import type { JsonValue, Workflow } from '../../shared/types.ts'
import { allNodes } from '../../shared/workflow-validation.ts'
import { renderDataTemplate } from '../template.ts'
import { isLocalTextDocument } from '../document-files.ts'
import { EXCERPT_MARK } from './conversation-evidence.ts'

type SkeletonForm={key:string;template:string;title:string;values:Record<string,unknown>}
type SkeletonModule={key:string;module:string;parameters:{target:string;content:string}}
type SkeletonRole={key:string;name:string;prompt:string}
type Draft={mode:'create';title:string;forms:SkeletonForm[];modules:SkeletonModule[];roles?:SkeletonRole[];chains:{key:string;container?:string;nodes:string[]}[];coverage:Record<string,string[]>;assumptions:string[]}
export interface TrialSkeleton {
  instruction:string
  /** Trial calls as nodes with the values the trial actually used; the adjustment report compares against these. */
  forms:SkeletonForm[]; modules:SkeletonModule[]; order:string[]; open:string[]
  /** The sub-agent the skeleton's Agent nodes bind to. */
  roles?:SkeletonRole[]
  /** Evidence record of the trial call each key came from. */
  sources:Record<string,string>
  /** Doc 26 §7: a complete CREATE submission the Host compiled first. */
  draft?:Draft
  /** What that compile rejected; only these parts are the author's to change. */
  draftIssues?:{code:string;message:string;path?:string}[]
}
export interface TrialSkeletonReport { used:string[]; adjusted:{key:string;reason:string}[] }

const WRITE_MODULE='verified-file-write@1.1.0'
const SKELETON_INSTRUCTION='trialSkeleton 由 Host 按试做跑通的调用直接换成节点：forms/modules/roles 可原样放进 CREATE 提交，order 是建议顺序，配置是试做实际用过的值。以它为起点，只补 open 列出的部分；改动或删除骨架节点及其网址、选择器、字段、读写路径时，在 assumptions 写一条「骨架调整：<key>：理由」。把网址或路径改为 {{input.字段}} 参数不算调整。'
const DRAFT_HEAD='trialSkeleton.draft 是 Host 按试做跑通的路径生成、已通过同一编译检查的完整 CREATE 提交：'
const DRAFT_ISSUES_HEAD='trialSkeleton.draft 是 Host 按试做跑通的路径生成的完整 CREATE 提交，draftIssues 列出它没通过同一编译或覆盖检查的几处：只改这几处涉及的节点、链或覆盖，其余节点原样保留，不要因此重写整张图。'
const DRAFT_INSTRUCTION=DRAFT_HEAD+'节点配置是试做实际用过的值，render 模板（verified=true 时）已用试做写出的文件逐条核对。以它为起点：对照需求与 procedure 核对，没问题就原样提交；只改需要改的部分，open 列出 Host 无法确定的地方。改动或删除 fetch/select/extract/read/save 等试做节点及其网址、选择器、字段、读写路径时，在 assumptions 写一条「骨架调整：<key>：理由」；把值改为 {{input.字段}} 参数不算调整。提交时保持草稿的结构：模块留在 modules、节点留在 forms，不添加草稿里没有的属性。'
// Desktop r45: the root chat's brief named native:write/read + code, the author
// split the module apart, and its own check misread CRLF files.
const MODULE_INSTRUCTION='写入模块 verified-file-write 就是写文件节点：已含写前探测、写入、写后回读和核对（按行比较，CRLF 行尾已处理）。需求或生成说明点名用写文件工具、回读工具或代码核对，不是拆掉模块的理由；只有需求要模块做不到的事（如局部修改、一次写多个文件）才换成工具节点，并在 assumptions 写明。'
// Plain file tools touch a path; they are not parsers.
const FILE_TOOLS=new Set(['read','write','edit','glob','grep','ls','bash'])
const LOOKING_TOOLS=new Set(['read','glob','grep','ls'])
const STAT_TEMPLATE=templateIdForTool('builtin:file.stat'),GLOB_TEMPLATE=templateIdForTool('native:glob')
const DOCUMENT_AGENT_PROMPT='按原文顺序提取文档全部文字，保留段落结构，不要总结或改写。'
const RUNNER:SkeletonRole={key:'runner',name:'试做步骤执行器',prompt:'只按节点任务调用给定工具完成这一步，把工具输出原样作为最终回复，不加解释、代码块或前后缀；不做任务之外的操作。'}
// The trial reads a workspace file as a stand-in when the run will take an upload.
const UPLOAD=/上传|附件|attachment|upload/i
const inputRef=(value:unknown)=>typeof value==='string'&&/^\{\{\s*input\.[A-Za-z_][\w-]*\s*\}\}$/.test(value)
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const args=(text:string):Record<string,unknown>|undefined=>{try{const value=JSON.parse(text);return record(value)?value:undefined}catch{return undefined}}
// A long write keeps content first, so its path may survive only as a prefix match.
const stringField=(text:string,name:string,parsed?:Record<string,unknown>)=>{
  if(typeof parsed?.[name]==='string')return parsed[name] as string
  const match=new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text)
  try{return match?JSON.parse(`"${match[1]}"`) as string:undefined}catch{return undefined}
}
/** Full text of a complete `read` result ("N: line" rows ending in the end-of-file note); undefined when partial. */
function readResultText(text:string):string|undefined{
  const body=/<content>\n([\s\S]*)\n\n\(End of file - total (\d+) lines\)\n<\/content>$/.exec(text.trim())
  if(!body)return undefined
  const rows=body[1]!.split('\n'),lines:string[]=[]
  for(const [index,row] of rows.entries()){const match=/^(\d+): ?(.*)$/.exec(row);if(!match||Number(match[1])!==index+1)return undefined;lines.push(match[2]!)}
  return lines.length===Number(body[2])?lines.join('\n'):undefined
}
/** The decodable start of a string field whose call text was cut off. */
const stringPrefix=(text:string,name:string)=>{
  const start=new RegExp(`"${name}"\\s*:\\s*"`).exec(text)
  if(!start)return undefined
  let raw=text.slice(start.index+start[0].length)
  if(raw.endsWith(EXCERPT_MARK))raw=raw.slice(0,-EXCERPT_MARK.length)
  const close=/(?:^|[^\\])(?:\\\\)*"/.exec(raw)
  if(close)return undefined
  raw=raw.replace(/\\(u[0-9a-fA-F]{0,3})?$/,'')
  try{return JSON.parse(`"${raw}"`) as string}catch{return undefined}
}

export const ARTIFACT_PROBE_EXCLUSION='Host 归入排除：写入前查看目标文件，写入模块已含写前探测，不另建步骤。'
/** Looks at an artifact before the trial first wrote it, call and result (Desktop r52).
 * The write module's own probe does this work. After a write whose target is
 * unreadable, or a shell command naming an artifact, nothing more counts: a
 * read-back must never pass for a probe. */
export function artifactProbeRefs(context:Pick<PlanningContext,'conversation'|'trialTask'>):string[]{
  const {conversation,trialTask}=context
  if(!conversation||!trialTask)return []
  const artifacts=trialTask.artifacts.map(item=>item.path)
  const artifact=(file:string|undefined)=>file===undefined?undefined:artifacts.find(path=>file===path||file==='./'+path||file.endsWith('/'+path))
  const written=new Set<string>(),probes=new Set<string>()
  for(const row of conversation.records){
    if(row.kind!=='tool-call'||!row.toolName)continue
    const tool=row.toolName,parsed=row.truncated?undefined:args(row.text)
    const target=artifact(stringField(row.text,tool==='glob'?'pattern':tool==='workflow_file_stat'?'path':'file_path',parsed))
    // A shell command naming an artifact may have written it.
    if(tool==='bash'){if(artifacts.some(path=>row.text.includes(path)))break;continue}
    if(tool==='write'||tool==='edit'){if(!target)break;written.add(target);continue}
    if(target&&!written.has(target)&&(LOOKING_TOOLS.has(tool)||tool==='workflow_file_stat'))probes.add(row.callId??row.id)
  }
  return conversation.records.filter(row=>(row.kind==='tool-call'||row.kind==='tool-result')&&probes.has(row.callId??row.id)).map(row=>row.id)
}

/** Built from frozen trial evidence only: no execution, no file reads. Calls
 * that failed, were cut off, or have no workflow node equivalent stay with the
 * author model; the module's own probe and read-back replace trial reads. */
export function buildTrialSkeleton(context:Pick<PlanningContext,'conversation'|'trialTask'|'tools'|'operation'>,options:{procedure?:TaskProcedure;title?:string;draft?:boolean}={}):TrialSkeleton|undefined{
  const {conversation,trialTask}=context
  if(context.operation!=='create'||!conversation||!trialTask)return undefined
  const available=(toolId:string)=>context.tools.some(tool=>tool.id===toolId&&tool.available)
  const artifacts=trialTask.artifacts.map(item=>item.path)
  const artifact=(file:string|undefined)=>file===undefined?(artifacts.length===1?artifacts[0]:undefined):artifacts.find(path=>file===path||file==='./'+path||file.endsWith('/'+path))
  const forms:SkeletonForm[]=[],modules:SkeletonModule[]=[],order:string[]=[],sources:Record<string,string>={},open:string[]=[],counts=new Map<string,number>()
  // Every trial call (probes and read-backs included) and the key that now does its work, for coverage.
  const inputFile=(file:string)=>trialTask.inputs.find(path=>file===path||file.endsWith('/'+path))
  const resultOf=(callId:string)=>conversation.records.find(item=>item.kind==='tool-result'&&item.callId===callId&&item.status!=='failed'&&!item.truncated)
  // Input file → the document node key that reads it.
  const readers=new Map<string,string>()
  const callKeys=new Map<string,string>(),artifactChecks=new Map<string,string>(),written=new Map<string,{text:string;cut:boolean}>(),selects=new Map<string,string>(),reads=new Map<string,string>()
  // Workspace-relative glob listings, and each stat result by path, for "every file in a directory".
  const globs:{callId:string;id:string;pattern:string;paths:string[]}[]=[],statResults=new Map<string,Record<string,unknown>>(),rows=new Map<string,Record<string,unknown>[]>()
  let http:string|undefined,last:{tool:string;key:string}|undefined
  const key=(base:string)=>{const n=(counts.get(base)??0)+1;counts.set(base,n);return n===1?base:base+n}
  const place=(tool:string,id:string,form?:SkeletonForm,module?:SkeletonModule)=>{
    // A repeated call right after the same tool corrects it: keep the later one.
    const index=form&&last?.tool===tool?forms.findIndex(row=>row.key===last!.key):-1
    if(form&&index>=0){forms[index]=form;sources[form.key]=id;return form.key}
    const name=(form??module)!.key
    if(form)forms.push(form);if(module)modules.push(module)
    order.push(name);sources[name]=id;last={tool,key:name}
    return name
  }
  for(const row of conversation.records){
    if(row.kind!=='tool-call'||!row.toolName)continue
    const tool=row.toolName,parsed=row.truncated?undefined:args(row.text),callId=row.callId??row.id
    if((tool==='read'||tool==='glob')&&artifact(stringField(row.text,tool==='read'?'file_path':'pattern',parsed)??''))artifactChecks.set(callId,artifact(stringField(row.text,tool==='read'?'file_path':'pattern',parsed)??'')!)
    if(row.status==='failed')continue
    if(tool==='workflow_http_request'&&parsed&&typeof parsed.url==='string'){
      const {url,method,headers,timeoutMs,body}=parsed,name=last?.tool===tool?last.key:key('fetch')
      const values:Record<string,unknown>={url,method:typeof method==='string'?method.toUpperCase():'GET',...(headers&&typeof headers==='object'?{headers}:{}),...(typeof timeoutMs==='number'?{timeoutMs:Math.min(120_000,Math.max(100,timeoutMs))}:{}),
        ...(body!==undefined&&body!==null?{bodyText:typeof body==='string'?body:JSON.stringify(body)}:{})}
      http=place(tool,row.id,{key:name,template:'http',title:'HTTP 请求',values});callKeys.set(callId,http)
    }else if((tool==='workflow_html_select'||tool==='workflow_html_extract_text')&&parsed&&http){
      const toolId=tool==='workflow_html_select'?'builtin:html.select':'builtin:html.extract_text'
      if(!available(toolId)){open.push(`试做用了 ${tool}，当前工具目录没有 ${toolId}，需另选节点。`);continue}
      const {html:_,contentType,...rest}=parsed,inputs:Record<string,unknown>={...rest,html:`{{${http}.text}}`}
      if(tool==='workflow_html_extract_text'){
        if(rest.statusCode!==undefined)inputs.statusCode=`{{${http}.status_code}}`
        if(rest.headers!==undefined||contentType!==undefined)inputs.headers=`{{${http}.headers}}`
      }
      const base=tool==='workflow_html_select'?'select':'extract',name=last?.tool===tool?last.key:key(base)
      callKeys.set(callId,place(tool,row.id,{key:name,template:templateIdForTool(toolId),title:tool==='workflow_html_select'?'提取网页列表':'提取网页正文',values:{inputs}}))
      if(base==='select')selects.set(name,callId)
    }else if(tool==='workflow_file_stat'&&parsed&&typeof parsed.path==='string'){
      // Sizes of an input file become a fixed node; an artifact's are the module's read-back business.
      const target=inputFile(parsed.path)??(!parsed.path.startsWith('/')&&!artifact(parsed.path)?parsed.path:undefined)
      if(!target)continue
      if(!available('builtin:file.stat')){open.push(`试做用了 workflow_file_stat，当前工具目录没有 builtin:file.stat，需另选节点。`);continue}
      callKeys.set(callId,place(`stat:${target}`,row.id,{key:key('stat'),template:STAT_TEMPLATE,title:'统计文件信息',values:{inputs:{path:target}}}))
      const result=resultOf(callId),value=result?args(result.text):undefined
      if(value)statResults.set(target,value)
    }else if(tool==='glob'&&parsed&&typeof parsed.pattern==='string'&&(parsed.path===undefined||parsed.path==='.')){
      // Without a search root the result lists workspace-relative paths, one per line.
      const result=resultOf(callId)
      if(result)globs.push({callId,id:row.id,pattern:parsed.pattern,paths:result.text.split('\n').map(line=>line.trim()).filter(Boolean)})
    }else if(tool==='write'){
      const target=artifact(stringField(row.text,'file_path',parsed))
      if(!target)continue
      const content=stringField(row.text,'content',parsed)
      if(content!==undefined&&!row.truncated)written.set(target,{text:content,cut:false})
      else{const prefix=row.truncated?stringPrefix(row.text,'content'):undefined;if(prefix!==undefined)written.set(target,{text:prefix,cut:true})}
      const existing=modules.find(item=>item.parameters.target===target)
      if(existing){sources[existing.key]=row.id;callKeys.set(callId,existing.key);continue}
      callKeys.set(callId,place(tool,row.id,undefined,{key:key('save'),module:WRITE_MODULE,parameters:{target,content:'{{render.text}}'}}))
    }else if(tool==='read'&&parsed&&typeof parsed.file_path==='string'){
      // An input file read before the write becomes a document node: it returns
      // the whole text (no line numbers) and takes a path or an upload alike.
      // Reads after the write are the module's read-back.
      const input=inputFile(parsed.file_path)
      if(!input||modules.length||readers.has(input))continue
      // Text formats are read locally; other formats need a model with a reading tool.
      const values=isLocalTextDocument(input)?{source:input,documentMode:'local'}:available('native:read')?{source:input,documentMode:'agent',tools:['native:read'],prompt:DOCUMENT_AGENT_PROMPT}:undefined
      if(!values)continue
      const form={key:key('read'),template:'document',title:'读取输入文件',values}
      readers.set(input,form.key);callKeys.set(callId,place(`read:${input}`,row.id,form))
      if(values.documentMode==='agent')open.push(`${form.key} 用 Agent 模式读 ${input}（会调用模型，工具为 native:read）：试做没有用解析工具读它；目录里有能读这种格式的解析工具时改用 tool 模式。`)
      const result=resultOf(callId)
      const text=result&&values.documentMode==='local'?readResultText(result.text):undefined
      if(text!==undefined)reads.set(form.key,text)
    }else if(parsed&&!modules.length&&!FILE_TOOLS.has(tool)&&available('native:'+tool)){
      // A parsing or conversion tool the trial ran on an input file becomes the
      // document node's tool mode; it replaces a model read of the same file.
      const [sourceKey,input]=Object.entries(parsed).flatMap(([name,value])=>{const file=typeof value==='string'?inputFile(value):undefined;return file?[[name,file] as const]:[]})[0]??[]
      const existing=input?forms.find(item=>item.key===readers.get(input)):undefined
      if(!input||!sourceKey||existing&&existing.values.documentMode!=='agent')continue
      const output=resultOf(callId),result=output?args(output.text):undefined
      // The text field: `text` when present, else the longest string field of the trial result that is not the file itself.
      const textPath=result&&typeof result.text!=='string'?Object.entries(result).filter((entry):entry is [string,string]=>typeof entry[1]==='string'&&!inputFile(entry[1])).sort((a,b)=>b[1].length-a[1].length)[0]?.[0]:undefined
      const {[sourceKey]:_,...rest}=parsed
      const values={source:input,documentMode:'tool',toolId:'native:'+tool,...(sourceKey!=='source'?{documentSourceKey:sourceKey}:{}),...(textPath?{documentTextPath:textPath}:{}),...(Object.keys(rest).length?{inputs:rest}:{})}
      if(existing){existing.values=values;sources[existing.key]=row.id;callKeys.set(callId,existing.key);const note=open.findIndex(text=>text.startsWith(`${existing.key} 用 Agent 模式`));if(note>=0)open.splice(note,1)}
      else{const form={key:key('read'),template:'document',title:'读取输入文件',values};readers.set(input,form.key);callKeys.set(callId,place(`parse:${input}`,row.id,form))}
      if(!result)open.push(`${readers.get(input)} 用 ${tool} 解析 ${input}：试做结果不是完整 JSON，确认 documentTextPath（结果里正文所在字段，默认 text）。`)
    }
  }
  // Desktop r49: a glob, then the same stat on exactly the files it listed, is
  // "each file in the directory": the run lists the files again and stats each one.
  const stats=forms.filter(row=>row.template===STAT_TEMPLATE),statPaths=stats.map(row=>String((row.values.inputs as Record<string,unknown>).path))
  const listing=stats.length>=2&&new Set(statPaths).size===stats.length&&available('native:glob')?globs.find(row=>row.paths.length===stats.length&&row.paths.every(path=>statPaths.includes(path))):undefined
  if(listing){
    const at=forms.indexOf(stats[0]!),step=order.indexOf(stats[0]!.key),source=sources[stats[0]!.key]!
    for(const form of stats){forms.splice(forms.indexOf(form),1);order.splice(order.indexOf(form.key),1);delete sources[form.key]}
    forms.splice(at,0,
      {key:'files',template:GLOB_TEMPLATE,title:'列出匹配文件',values:{inputs:{pattern:listing.pattern}}},
      {key:'sorted',template:'list',title:'按路径排序',values:{listSource:'files.value.paths',sort:'asc'}},
      {key:'each',template:'iteration',title:'逐个统计文件',values:{iterator:'sorted.result',outputVariable:'stat',parallel:false,errorMode:'terminate'}},
      {key:'stat',template:STAT_TEMPLATE,title:'统计文件信息',values:{inputs:{path:'{{item}}'}}})
    order.splice(step,0,'files','sorted','each');sources.files=listing.id;sources.each=source
    for(const [callId,name] of callKeys)if(stats.some(form=>form.key===name))callKeys.set(callId,'each')
    callKeys.set(listing.callId,'files')
    // The render is proved against the trial results in the order the run will see them.
    const sorted=[...listing.paths].sort().map(path=>statResults.get(path))
    if(sorted.every(record))rows.set('each',sorted)
    open.push(`each 逐个统计 files 列出的文件：试做先用 glob 列出 ${listing.paths.length} 个文件，再逐个统计了全部，运行时按 files 的 pattern 重新列出并按路径排序。stat 在 each 的子链里（chains 加 {key:'eachChain',container:'each',nodes:['stat']}）。需求点名具体文件时可改回固定路径节点，在 assumptions 写骨架调整。`)
  }
  // T28.3 (Desktop r52 B): a step the trial did with an official tool no node maps runs in an
  // Agent node bound to a sub-agent, its task the trial's own call. Only a call before the write
  // whose output reached the written file is a step; calls naming the artifact probe or re-check it.
  const firstWrite=conversation.records.findIndex(row=>row.kind==='tool-call'&&row.toolName==='write'&&artifact(stringField(row.text,'file_path',args(row.text)))!==undefined)
  const writtenText=[...written.values()].map(item=>item.text).join('\n'),excluded=new Set(options.procedure?.excluded.flatMap(item=>item.evidenceRefs)??[])
  const roles:SkeletonRole[]=[],outputs=new Map<string,string>()
  for(const [index,row] of conversation.records.entries()){
    const tool=row.toolName,callId=row.callId??row.id
    if(row.kind!=='tool-call'||!tool||row.status==='failed'||callKeys.has(callId)||LOOKING_TOOLS.has(tool)||tool==='write'||tool.startsWith('workflow_')||!available('native:'+tool)||firstWrite<0)continue
    const named=artifacts.find(path=>row.text.includes(path))
    if(named){artifactChecks.set(callId,named);continue}
    const parsed=row.truncated?undefined:args(row.text),result=resultOf(callId)
    if(!parsed||!result||index>firstWrite||excluded.has(row.id)||!result.text.split(/[\s|]+/).some(token=>token.length>=8&&writtenText.includes(token)))continue
    const command=tool==='bash'&&typeof parsed.command==='string'?parsed.command:undefined,name=key('run')
    const prompt=command!==undefined?`用 native:bash 在工作区根目录执行下面这条命令，把标准输出原样作为最终回复；只执行这一条命令，失败时只回复一行 ERROR: <错误原文>。\n${command}`:`用 native:${tool} 按下面的参数调用一次，把结果原样作为最终回复。\n${JSON.stringify(parsed)}`
    const form={key:name,template:'agent',title:command!==undefined?'执行命令':`调用 ${tool}`,values:{subagentId:RUNNER.key,prompt,tools:['native:'+tool]}}
    // In trial order: before the first node that came from a later call.
    const at=order.findIndex(other=>conversation.records.findIndex(item=>item.id===sources[other])>index)
    if(at<0)order.push(name);else order.splice(at,0,name)
    const slot=at<0?-1:forms.findIndex(item=>item.key===order[at+1])
    if(slot<0)forms.push(form);else forms.splice(slot,0,form)
    sources[name]=row.id;callKeys.set(callId,name);outputs.set(name,result.text)
    if(!roles.length)roles.push({...RUNNER})
    // The listing the command repeats belongs to this step.
    for(const listed of globs)if(command?.includes(listed.pattern)&&!callKeys.has(listed.callId))callKeys.set(listed.callId,name)
    const shown=command===undefined?'完成了这一步':`执行 ${command.length>120?command.slice(0,120)+'…':command}`
    open.push(`${name} 是 Agent 节点（子 Agent ${RUNNER.key}，工具 native:${tool}）：试做用 ${tool} ${shown}，输出写进了产物；官方工具的前置条件和能否重复执行未知，Host 不把它做成固定节点。prompt 里的路径或模式是试做的值，运行时需要可改时换成 {{input.字段}}。`)
  }
  // T18: official tools the trial ran that map to no node stay out of fixed nodes; their
  // preconditions and rerun safety are unknown. Looking around (read/glob/grep/ls) is not a step.
  const mapped=new Set([...callKeys.keys(),...artifactChecks.keys()]),unmapped=[...new Set(conversation.records.filter(row=>row.kind==='tool-call'&&row.toolName&&row.status!=='failed'&&!mapped.has(row.callId??row.id)
    &&!LOOKING_TOOLS.has(row.toolName)&&row.toolName!=='write'&&!row.toolName.startsWith('workflow_')&&available('native:'+row.toolName)).map(row=>row.toolName!))]
  if(unmapped.length)open.push(`试做还用了 ${unmapped.join('、')}：这些官方工具的前置条件和能否重复执行未知，Host 不把它们做成固定节点。工作流需要这一步时用 Agent 节点，tools 填 ${unmapped.map(tool=>'native:'+tool).join('、')}，prompt 写清这一步要做什么，并在 roles 声明子 Agent {key,name,prompt}、节点 values.subagentId 填这个 key（保存后立即首跑，未绑定子 Agent 的节点不能运行）；只是试做中的查看或探索、或对上一步结果的重复核对就不用加。`)
  if(!forms.length&&!modules.length)return undefined
  const skeletonOpen=['开头 input（key=start）和结尾 output（key=result）：按 procedure.parameters 声明运行参数。']
  if(modules.length){
    const feeder=[...forms].reverse().find(row=>row.template!=='http'&&!(listing&&row.key==='stat'))?.key??http
    skeletonOpen.push(`${modules.map(row=>row.key).join('、')}.parameters.content 须是整理节点的完整输出引用：在写入前加 template 或 code 节点（key=render）把${feeder?` ${feeder} 的输出`:'上游数据'}整理成最终正文；骨架暂填 {{render.text}}。`)
    skeletonOpen.push('写入模块已含写前探测和回读窗口核对（输出 check/checkNote），试做中的探测和回读不必另建节点；trialTask.artifacts 的 checks 等机械检查用 code/if 节点接在模块之后。')
  }
  const moduleNote=modules.length?MODULE_INSTRUCTION:''
  const skeleton:TrialSkeleton={instruction:SKELETON_INSTRUCTION+moduleNote,forms,modules,order,open:[...skeletonOpen,...open],sources,...(roles.length?{roles}:{})}
  const draft=options.draft===false?undefined:draftFromSkeleton(skeleton,{conversation,trialTask,procedure:options.procedure,title:options.title,callKeys,artifactChecks,written,selects,reads,rows,outputs,patterns:globs.map(row=>row.pattern)})
  return draft?{...skeleton,instruction:DRAFT_INSTRUCTION+moduleNote,open:[...draft.open,...open],draft:draft.document}:skeleton
}

/** A draft that failed the Host compile stays the starting point; the author repairs only what it reported (doc 26 §7). */
export function withDraftIssues(skeleton:TrialSkeleton,issues:NonNullable<TrialSkeleton['draftIssues']>):TrialSkeleton{
  return {...skeleton,instruction:DRAFT_ISSUES_HEAD+skeleton.instruction.slice(DRAFT_HEAD.length),draftIssues:issues}
}

/** What the model receives: the draft replaces the bare node lists it already contains. */
export function trialSkeletonPrompt(skeleton:TrialSkeleton){
  const {forms,modules,order,roles,...rest}=skeleton
  return skeleton.draft?rest:{...rest,forms,modules,order,...(roles?{roles}:{})}
}

/** Recover complete records from a cut-off html.select result excerpt. */
function completeItems(text:string):Record<string,unknown>[]{
  const whole=args(text)
  if(whole&&Array.isArray(whole.items))return whole.items.filter(record)
  const start=text.indexOf('"items":[')
  if(start<0)return []
  const items:Record<string,unknown>[]=[]
  for(let i=start+9;i<text.length;){
    while(text[i]===','||text[i]===' '||text[i]==='\n')i++
    if(text[i]!=='{')break
    let depth=0,quote=false,end=-1
    for(let j=i;j<text.length;j++){
      const c=text[j]
      if(quote){if(c==='\\')j++;else if(c==='"')quote=false;continue}
      if(c==='"')quote=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){end=j;break}
    }
    if(end<0)break
    const item=args(text.slice(i,end+1))
    if(!item)break
    items.push(item);i=end+1
  }
  return items
}

const templateSyntax=/\{\{|\{%|\{#|%\}|#\}|\u0000/
// Normalisations a template filter can express, applied in this order. The
// trial often tidies a field before writing it ("owner / repo" → "owner/repo").
const NORMALISE:[string,(text:string)=>string][]=[
  ['trim',text=>text.trim()],
  ['replace(" / ", "/")',text=>text.split(' / ').join('/')],
  ['lower',text=>text.toLowerCase()],
]
/** The value as written, plainest form first: [filters, text]. */
function variants(value:string):[string,string][]{
  const out:[string,string][]=[]
  for(let mask=0;mask<1<<NORMALISE.length;mask++){
    const steps=NORMALISE.filter((_,index)=>mask&1<<index)
    const text=steps.reduce((text,[,apply])=>apply(text),value)
    if(text&&!out.some(([,seen])=>seen===text))out.push([steps.map(([filter])=>` | ${filter}`).join(''),text])
  }
  return out
}
/** Reverse the trial's written list (the array at `source`) into a template body and prove it: the
 * known records must render to the trial file byte for byte, and every other
 * block in the file must have the same shape. Anything less stays open. */
function listTemplate(content:string,records:Record<string,unknown>[],source:string,limit:unknown,cut=false,anyOrder=false):{text:string;header:string;body:string;footer:string;count:number;checked:number;cut:boolean}|undefined{
  const fields=(item:Record<string,unknown>)=>Object.entries(item).filter(([name,value])=>/^[A-Za-z][A-Za-z0-9_]*$/.test(name)&&(typeof value==='string'||typeof value==='number')&&String(value).length>0) as [string,string|number][]
  if(records.length<2||records.some(item=>!fields(item).length))return undefined
  // Desktop r52: stats of listed files carry no order of their own; the trial
  // may have written them in listing order. Prove the body in the file's order.
  let all=records
  if(anyOrder){
    const at=(item:Record<string,unknown>)=>{for(const value of fields(item).map(([,value])=>String(value)).sort((a,b)=>b.length-a.length)){const index=content.indexOf(value);if(index>=0)return index}return -1}
    const positions=records.map(at)
    if(positions.every(index=>index>=0)&&new Set(positions).size===positions.length)all=records.map((item,index)=>({item,index:positions[index]!})).sort((a,b)=>a.index-b.index).map(row=>row.item)
  }
  // A cut-off write keeps only the records it reached; its last line may be partial.
  const lines=content.split('\n'),starts:number[]=[]
  for(const item of all){
    const values=fields(item).flatMap(([,value])=>variants(String(value)).map(([,text])=>text)),from=starts.length?starts.at(-1)!+1:0
    const at=lines.findIndex((line,index)=>index>=from&&(!cut||index<lines.length-1)&&values.some(value=>line.includes(value)))
    if(at<0){if(cut)break;return undefined}
    starts.push(at)
  }
  const items=all.slice(0,starts.length)
  if(items.length<2)return undefined
  const size=starts[1]!-starts[0]!
  if(size<1||starts.some((start,index)=>start!==starts[0]!+index*size))return undefined
  const offset=lines.slice(0,starts[0]).reduce((sum,line)=>sum+line.length+1,0)
  let block=lines.slice(starts[0],starts[0]!+size).map(line=>line+'\n').join('')
  const marks:string[]=[]
  // A numbered list ("1. ", "1) ", "1、") numbers each record with the loop index.
  const numbered=block.match(/^(\s*)1(?=[.)、]\s?)/)
  if(numbered){block=`${numbered[1]}\u00000\u0000`+block.slice(numbered[0].length);marks.push('')}
  // Each field as written (plainest normalisation found), longest first so a
  // name inside a link is not marked before the link. Every occurrence counts:
  // a line may repeat a field, e.g. a link as both text and target.
  const written=fields(items[0]!).flatMap(([name,value])=>{
    const found=variants(String(value)).find(([,text])=>block.includes(text))
    return found?[{expression:`item.${name} | default("")${found[0]}`,text:found[1]}]:[]
  }).sort((a,b)=>b.text.length-a.text.length)
  for(const {expression,text} of written){
    const mark=`\u0000${marks.length}\u0000`
    const parts=block.split(/(\u0000\d+\u0000)/).map(part=>part.startsWith('\u0000')?part:part.split(text).join(mark))
    if(parts.join('')===block)continue
    block=parts.join('');marks.push(expression)
  }
  const literals=block.split(/\u0000\d+\u0000/)
  if(!marks.some(Boolean)||literals.some(part=>templateSyntax.test(part)))return undefined
  const body=block.replace(/\u0000(\d+)\u0000/g,(_,index:string)=>marks[Number(index)]?`{{${marks[Number(index)]}}}`:'{{loop.index}}')
  const loop=`{% for item in ${source} %}${body}{% endfor %}`
  let rendered:string
  try{rendered=renderDataTemplate(loop,name=>{if(name===source)return items as JsonValue;throw new Error(name)})}catch{return undefined}
  if(content.slice(offset,offset+rendered.length)!==rendered)return undefined
  // Records beyond the excerpt: count consecutive blocks with the same literal shape.
  const shape=new RegExp(literals.map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[^\\n]*?'),'y')
  let count=0,at=offset
  for(;;){shape.lastIndex=at;const match=shape.exec(content);if(!match||!match[0].length)break;count++;at+=match[0].length}
  // A cut-off file ends inside the list: its tail is unknown, the count comes from the limit.
  const header=content.slice(0,offset),footer=cut?'':content.slice(at)
  if(cut&&(typeof limit!=='number'||count>limit))return undefined
  if(count<items.length||templateSyntax.test(header)||templateSyntax.test(footer)||(!cut&&typeof limit==='number'&&limit!==count))return undefined
  return {text:header+loop+footer,header,body,footer,count:cut?limit as number:count,checked:items.length,cut}
}

const js=(value:unknown)=>JSON.stringify(value)
const PER_ITEM=/逐(?:个|条|项)[^，。；\n]{0,8}(?:模板|生成|套用)|(?:用|套)同一个?模板/
/** One-line record body → numbering prefix kept in the merge, record line for the per-item template. */
function splitLine(body:string):{prefix:string;line:string}|undefined{
  const at=body.indexOf('{{item.')
  if(at<0||!body.endsWith('\n')||body.slice(0,-1).includes('\n')||body.slice(0,at).includes('{{item'))return undefined
  return {prefix:body.slice(0,at),line:body.slice(at,-1)}
}
function draftFromSkeleton(skeleton:TrialSkeleton,facts:{conversation:NonNullable<PlanningContext['conversation']>;trialTask:NonNullable<PlanningContext['trialTask']>;procedure?:TaskProcedure;title?:string;callKeys:Map<string,string>;artifactChecks:Map<string,string>;written:Map<string,{text:string;cut:boolean}>;selects:Map<string,string>;reads:Map<string,string>;rows:Map<string,Record<string,unknown>[]>;outputs:Map<string,string>;patterns:string[]}):{document:Draft;open:string[]}|undefined{
  const {forms,modules,order}=skeleton,module=modules[0]
  // One artifact, written once; review steps need human nodes the Host does not invent.
  if(modules.length!==1||!module||facts.procedure?.steps.some(step=>step.requiresReview))return undefined
  const draft=structuredClone(forms),open:string[]=[],fields:{name:string;label:string;type:'text'|'number'|'file';required:boolean;defaultValue?:string}[]=[]
  const nodes:string[]=['start'],checks:string[]=[]
  const upload=UPLOAD.test([facts.trialTask.task,...(facts.procedure?.parameters.map(item=>item.name+item.description)??[])].join('\n'))
  let urls=0,files=0
  const pathFields=new Map<string,string>()
  for(const name of order){
    const form=draft.find(row=>row.key===name)
    if(!form){if(name===module.key)nodes.push('render',name,'check');continue}
    if(form.template==='http'){
      const field=++urls===1?'url':`url${urls}`,url=String(form.values.url)
      fields.push({name:field,label:urls===1?'网页地址':`网页地址 ${urls}`,type:'text',required:false,defaultValue:url})
      form.values.url=`{{input.${field}}}`
      for(const other of draft)if(record(other.values.inputs)&&other.values.inputs.baseUrl===url)other.values.inputs.baseUrl=`{{input.${field}}}`
      const ok=`${name}Ok`
      draft.splice(draft.indexOf(form)+1,0,{key:ok,template:'code',title:'确认抓取成功',values:{language:'javascript',inputs:{status:`{{${name}.status_code}}`},timeoutMs:3000,
        outputSchema:[{name:'status',type:'number',required:true,description:'HTTP 状态码'}],
        code:`function main(inputs) {\n  var status = Number(inputs.status);\n  if (!(status >= 200 && status < 300)) throw new Error('抓取失败：HTTP 状态 ' + inputs.status + '，已停止后续步骤');\n  return { status: status };\n}`}})
      nodes.push(name,ok)
    }else if(form.template==='document'){
      // The trial file stands in for the run's input: an upload, or a path parameter defaulting to it.
      const n=++files,path=String(form.values.source),field=upload?(n===1?'file':`file${n}`):(n===1?'inputPath':`inputPath${n}`)
      fields.push(upload?{name:field,label:n===1?'附件':`附件 ${n}`,type:'file',required:true}:{name:field,label:n===1?'输入文件路径':`输入文件路径 ${n}`,type:'text',required:false,defaultValue:path})
      form.values.source=`input.${field}`;if(upload)form.title='读取上传附件';else pathFields.set(path,field)
      open.push(upload?`${name} 读取运行时上传的附件 input.${field}（试做用工作区文件 ${path} 代替上传）。`:`${name} 读取路径参数 input.${field}，默认值是试做读取的 ${path}。`)
      nodes.push(name)
    }else if(form.template===GLOB_TEMPLATE){
      const inputs=form.values.inputs as Record<string,unknown>,pattern=String(inputs.pattern)
      fields.push({name:'pattern',label:'文件匹配模式',type:'text',required:false,defaultValue:pattern})
      inputs.pattern='{{input.pattern}}'
      open.push(`${name} 按参数 input.pattern 列出文件，默认值是试做用的 ${pattern}。`)
      nodes.push(name)
    }else if(form.template==='agent'){
      // The pattern the trial ran the command on becomes the same run parameter a listing gets.
      const prompt=String(form.values.prompt),pattern=facts.patterns.find(item=>prompt.includes(item)),field=fields.find(item=>item.name==='pattern')
      if(pattern&&(!field||field.defaultValue===pattern)){
        if(!field)fields.push({name:'pattern',label:'文件匹配模式',type:'text',required:false,defaultValue:pattern})
        form.values.prompt=prompt.split(pattern).join('{{input.pattern}}')
        open.push(`${name} 的命令按参数 input.pattern 匹配文件，默认值是试做用的 ${pattern}。`)
      }
      nodes.push(name)
    }else nodes.push(name)
  }
  // file.stat follows the run input of the document node that reads the same file.
  for(const form of draft.filter(row=>row.template===STAT_TEMPLATE)){
    const inputs=form.values.inputs as Record<string,unknown>,path=String(inputs.path)
    if(path.includes('{{'))continue
    if(upload&&!pathFields.has(path)){open.push(`${form.key} 统计的是试做文件 ${path}；运行时上传的附件不是工作区文件，file.stat 统计不了它。`);continue}
    if(!pathFields.has(path)){const n=++files,field=n===1?'inputPath':`inputPath${n}`;fields.push({name:field,label:n===1?'输入文件路径':`输入文件路径 ${n}`,type:'text',required:false,defaultValue:path});pathFields.set(path,field)}
    inputs.path=`{{input.${pathFields.get(path)}}}`
  }
  fields.push({name:'outputPath',label:'输出文件路径',type:'text',required:false,defaultValue:module.parameters.target})
    // The data the render reads: the last extraction before the write.
  const feeder=[...draft].reverse().find(row=>row.template!=='http'&&row.template!=='code'&&row.template!==STAT_TEMPLATE)
  if(!feeder)return undefined
  const content=facts.written.get(module.parameters.target),selectCall=facts.selects.get(feeder.key)
  // The trial wrote exactly what it read: the write takes the read text, with no render node.
  const read=facts.reads.get(feeder.key),copy=feeder.template==='document'&&read!==undefined&&content!==undefined&&!content.cut&&content.text.replace(/\n$/,'')===read
  if(copy){
    const index=nodes.indexOf('render');nodes.splice(index,1)
    open.push(`save 直接写入 ${feeder.key}.text：试做写出的内容与读到的正文逐字一致（verified=true），不设整理节点；需求要求改写内容时再在 save 前加 template。`)
  }
  const body=copy?`{{${feeder.key}.text}}`:'{{render.text}}'
  const resultRow=selectCall?facts.conversation.records.find(row=>row.kind==='tool-result'&&row.callId===selectCall):undefined
  const limit=record(feeder.values.inputs)?feeder.values.inputs.limit:undefined
  const save={...module,parameters:{target:'{{input.outputPath}}',content:body}}
  // Records the trial's write listed: the selection result, or the stats an iteration collected.
  const iterated=feeder.template==='iteration'?facts.rows.get(feeder.key):undefined
  // An iteration over listed files: every listed file gets a row, and the listing is not empty.
  const listed=feeder.template==='iteration'?String(feeder.values.iterator).replace(/\.result$/,'.text'):undefined
  if(listed)checks.push('var rows = JSON.parse(String(inputs.rows)), files = JSON.parse(String(inputs.files));',"if (!files.length) failures.push('没有匹配的文件');","if (rows.length !== files.length) failures.push('统计了 ' + rows.length + ' 个文件，匹配到 ' + files.length + ' 个');")
  const records=resultRow?{items:completeItems(resultRow.text),source:`${feeder.key}.items`}:iterated?{items:iterated,source:`${feeder.key}.result`}:undefined
  const list=!copy&&content!==undefined&&records?listTemplate(content.text,records.items,records.source,limit,content.cut,!!iterated):undefined
  let renderText=''
  // "Each record through the same template" gets that node: an iteration over the
  // records with a one-line template inside; the merge keeps the numbering.
  const perItem=list&&PER_ITEM.test([facts.trialTask.task,...(facts.procedure?.steps.map(step=>step.title+step.instruction)??[])].join('\n'))?splitLine(list.body):undefined
  if(list&&perItem){
    renderText=`${list.header}{% for row in lines.result %}${perItem.prefix}{{row}}\n{% endfor %}${list.footer}`
    draft.push({key:'lines',template:'iteration',title:'逐条生成条目行',values:{iterator:`${feeder.key}.items`,outputVariable:'line.text',parallel:false,errorMode:'terminate'}})
    draft.push({key:'line',template:'template',title:'条目行模板',values:{text:perItem.line}})
    nodes.splice(nodes.indexOf('render'),0,'lines')
  }
  if(list){
    if(!perItem)renderText=list.text
    if(record(feeder.values.inputs)&&limit===undefined)feeder.values.inputs.limit=list.count
    if(!listed)checks.push(`if (Number(inputs.count) !== ${list.count}) failures.push('提取条数为 ' + inputs.count + '，应为 ${list.count}');`)
    open.push(`render 模板由试做写出的文件反推，前 ${list.checked} 条记录逐字一致、共 ${list.count} 条同格式（verified=true）；需求要求不同格式时再改。`)
    if(list.cut)open.push('试做的写入记录被截断：模板只核对到截断处，列表之后若有结尾段需按需求补上。')
    // Fixed text around the rows that names a trial file no longer holds once the listing changes (Desktop r49 footer).
    const named=[...new Set((iterated??[]).flatMap(row=>[row.name,row.path]).filter((value):value is string=>typeof value==='string'&&(list.header+list.footer).includes(value)))]
    if(named.length)open.push(`render 表格前后的固定文字写到了试做的文件 ${named.join('、')}：运行时文件由 files 列出，换目录后这些文字不成立，按需求删去或改成从 each.result 生成。`)
  }else if(!copy){
    renderText=`{{${feeder.key}.text}}`
    open.push(feeder.template==='agent'?`render.values.text 是占位（verified=false）：${feeder.key}.text 是命令的原样输出。按试做写出的文件格式，在 render 前加 code 节点（key=parse）把它解析成记录，render 再用 {% for %} 整理；正文只引用上游输出。`:`render.values.text 是占位（verified=false）：按需求和试做写出的文件格式改写，正文只引用上游 ${feeder.key} 的输出。`)
  }
  // Titles and links the trial wrote verbatim for every record: the run checks each is
  // non-empty, a link is a full address, and the written text holds it. Without this the
  // author wrote that check itself (Desktop r57 C: about 6 of 7.6 minutes).
  const sample=list&&records&&!iterated&&content?records.items.slice(0,list.checked):[]
  // Only fields the template prints as they are: a replace or lower filter changes what the text holds.
  const plain=(field:string)=>{const uses=(list?.text??'').split('{{item.'+field).slice(1).map(rest=>rest.slice(0,rest.indexOf('}}')));return uses.length>0&&uses.every(use=>/^\s*(?:\|\s*(?:default\([^)]*\)|trim)\s*)*$/.test(use))}
  const verbatim=Object.keys(sample[0]??{}).filter(field=>plain(field)&&sample.every(item=>typeof item[field]==='string'&&!!(item[field] as string).trim()&&content!.text.includes((item[field] as string).trim())))
  const links=verbatim.filter(field=>sample.every(item=>/^https?:\/\//.test((item[field] as string).trim())))
  const titles=verbatim.filter(field=>!links.includes(field)).slice(0,1),shown=[...titles,...links]
  if(shown.length)checks.push(
    "var items = typeof inputs.items === 'string' ? JSON.parse(inputs.items) : (inputs.items || []);",
    `var shown = ${js(shown)}, links = ${js(links)};`,
    'for (var r = 0; r < items.length; r++) for (var f = 0; f < shown.length; f++) {',
    "  var value = String(items[r] == null || items[r][shown[f]] == null ? '' : items[r][shown[f]]).trim(), at = '第 ' + (r + 1) + ' 条的 ' + shown[f];",
    "  if (!value) failures.push(at + ' 为空');",
    "  else if (links.indexOf(shown[f]) >= 0 && !/^https?:\\/\\//.test(value)) failures.push(at + ' 不是完整网址：' + value);",
    "  else if (content.indexOf(value) < 0) failures.push('正文缺少' + at + '「' + value + '」');",
    '}')
  const required=facts.trialTask.artifacts.find(item=>item.path===module.parameters.target)?.checks.flatMap(check=>check.kind==='text-includes'?[check.value]:[])??[]
  // Text the trial input file already held follows the run's input once that file is a
  // parameter (Desktop r46: a categories upload failed the sellers header check).
  const inputTexts=files?[...facts.reads.values()]:[]
  const fromInput=required.filter(value=>inputTexts.some(text=>text.includes(value)))
  // Likewise text an Agent node's command printed in the trial (Desktop r52 B: file names and hashes).
  const fromRun=required.filter(value=>!fromInput.includes(value)&&[...facts.outputs.values()].some(text=>text.includes(value)))
  const includes=required.filter(value=>!fromInput.includes(value)&&!fromRun.includes(value))
  if(fromInput.length)open.push(`check 不写死 ${fromInput.map(value=>`「${value}」`).join('、')}：这些文字来自试做的输入文件，换一个输入就不成立；内容是否原样写入由写入回读核对保证。`)
  if(fromRun.length)open.push(`check 不写死 ${fromRun.map(value=>`「${value}」`).join('、')}：这些文字是试做时命令的输出，文件变了就不成立；内容是否原样写入由写入回读核对保证。`)
  if(facts.trialTask.artifacts.some(item=>item.checks.some(check=>check.kind!=='text-includes')))open.push('trialTask.artifacts 里有非文本包含的检查，需补进 check。')
  const checkInputs:Record<string,string>={content:body,writeCheck:`{{${module.key}.check}}`,checkNote:`{{${module.key}.checkNote}}`,...(list&&!listed?{count:`{{${feeder.key}.count}}`}:{}),...(shown.length?{items:`{{${records!.source}}}`}:{}),...(listed?{rows:`{{${feeder.key}.text}}`,files:`{{${listed}}}`}:{})}
  if(!copy)draft.push({key:'render',template:'template',title:'整理报告正文',values:{text:renderText}})
  draft.push({key:'check',template:'code',title:'核对产物',values:{language:'javascript',inputs:checkInputs,timeoutMs:3000,
    outputSchema:[{name:'summary',type:'string',required:true,description:'核对结论'}],
    code:`function main(inputs) {\n  var content = String(inputs.content == null ? '' : inputs.content);\n  var failures = [];\n  var includes = ${js(includes)};\n  for (var i = 0; i < includes.length; i++) if (content.indexOf(includes[i]) < 0) failures.push('正文缺少「' + includes[i] + '」');\n  if (inputs.writeCheck !== 'window-match') failures.push('写入回读核对为 ' + inputs.writeCheck + '：' + inputs.checkNote);\n  ${checks.join('\n  ')}\n  if (failures.length) throw new Error('产物核对未通过：' + failures.join('；'));\n  return { summary: '产物核对通过：' + ${js(includes.length?`包含 ${includes.join('、')}；`:'')} + '写入回读 ' + inputs.writeCheck${list&&!listed?` + '；条数 ' + inputs.count`:''}${shown.length?` + '；逐条核对 ${shown.join('、')}'`:''}${listed?` + '；文件数 ' + files.length`:''} };\n}`}})
  draft.unshift({key:'start',template:'input',title:'运行参数',values:{fields}})
  // Each node's result, not only the check (Desktop r57 C: the author rewrote result for 「告诉我每个节点的结果」).
  const fetched=draft.filter(row=>row.template==='http').map(row=>`抓取 ${row.key}：HTTP {{${row.key}.status_code}}，{{${row.key}.bytes}} 字节\n`).join('')
  const extracted=list&&records&&!iterated&&!copy?`提取 ${feeder.key}：{{${feeder.key}.count}} 条\n`:''
  draft.push({key:'result',template:'output',title:'结果',values:{outputName:'result',text:`${fetched}${extracted}{{check.summary}}\n输出文件：{{${module.key}.path}}（{{${module.key}.operation}}）\n写入核对：{{${module.key}.check}}（{{${module.key}.checkNote}}）`}})
  nodes.push('result')
  if(facts.title===undefined)open.push('title 按需求命名。')
  open.push(`check 已含 trialTask.artifacts 的文本检查、写入回读核对${list&&!listed?'、条数':''}${shown.length?`，并逐条核对 ${shown.join('、')}（非空${links.length?'、链接为完整网址':''}、正文含有）`:''}；回读相等由写入模块保证。需求另有这些之外的可机械检查条件时才补进 check。`)
  // Procedure steps cite trial calls; each maps to the node that now does that call's work.
  const recordKeys=new Map<string,string[]>()
  for(const row of facts.conversation.records){
    const callId=row.callId??row.id,key=facts.callKeys.get(callId)
    const keys=key===module.key?[...(copy?[]:['render']),...(nodes.includes('lines')?['lines']:[]),module.key]:key?[key]:facts.artifactChecks.has(callId)?[module.key,'check']:[]
    if(keys.length)recordKeys.set(row.id,keys)
  }
  const all=nodes.filter(name=>name!=='start')
  const coverage:Record<string,string[]>={R1:all}
  for(const step of facts.procedure?.steps??[]){
    const keys=[...new Set(step.evidenceRefs.flatMap(ref=>recordKeys.get(ref)??[]))]
    coverage[step.id]=keys.length?keys:all
  }
  return {open,document:{mode:'create',title:facts.title??'试做工作流',forms:draft,modules:[save],...(skeleton.roles?{roles:structuredClone(skeleton.roles)}:{}),chains:[{key:'main',nodes},...(nodes.includes('lines')?[{key:'lineChain',container:'lines',nodes:['line']}]:[]),...(nodes.includes('each')?[{key:'eachChain',container:'each',nodes:['stat']}]:[])],coverage,assumptions:['草稿由 Host 按试做跑通路径生成。']}}
}

/** Not a gate: records which skeleton nodes the candidate kept and why others changed. */
export function trialSkeletonReport(skeleton:TrialSkeleton,candidate:Workflow,assumptions:readonly string[]):TrialSkeletonReport{
  const nodes=allNodes(candidate),taken=new Set<string>(),used:string[]=[],adjusted:TrialSkeletonReport['adjusted']=[]
  // A value turned into a run parameter at any depth (e.g. one field selector) is not a change.
  const same=(actual:unknown,expected:unknown):boolean=>inputRef(actual)||isDeepStrictEqual(actual,expected)||
    (Array.isArray(actual)&&Array.isArray(expected)?actual.length===expected.length&&actual.every((value,index)=>same(value,expected[index])):
      record(actual)&&record(expected)&&isDeepStrictEqual(Object.keys(actual).sort(),Object.keys(expected).sort())&&Object.keys(expected).every(name=>same(actual[name],expected[name])))
  const instances=verifiedModuleInstances(candidate).filter(row=>`${row.moduleId}@${row.version}`===WRITE_MODULE)
  for(const name of skeleton.order){
    const form=skeleton.forms.find(row=>row.key===name),module=skeleton.modules.find(row=>row.key===name)
    let match:string|undefined
    if(form?.template==='http')match=nodes.find(node=>!taken.has(node.id)&&node.kind==='http'&&same(node.config.url,form.values.url))?.id
    // The same file, or a run input (an upload or a path parameter) in its place.
    else if(form?.template==='document')match=nodes.find(node=>!taken.has(node.id)&&node.kind==='document'&&(node.config.source===form.values.source||/^\s*(?:\{\{\s*)?input\.[A-Za-z_][\w-]*(?:\s*\}\})?\s*$/.test(String(node.config.source??''))))?.id
    else if(form?.template==='list'||form?.template==='iteration')match=nodes.find(node=>!taken.has(node.id)&&node.kind===form.template)?.id
    else if(form?.template==='agent')match=nodes.find(node=>!taken.has(node.id)&&node.kind==='agent'&&isDeepStrictEqual(node.config.tools,form.values.tools))?.id
    else if(form){
      const expected=form.values.inputs as Record<string,unknown>
      match=nodes.find(node=>{
        if(taken.has(node.id)||node.kind!=='tool'||templateIdForTool(String(node.config.toolId))!==form.template)return false
        const inputs=(node.config.inputs??{}) as Record<string,unknown>
        return ['items','fields','file_path'].every(field=>expected[field]===undefined||same(inputs[field],expected[field]))
      })?.id
    }else if(module)match=instances.find(row=>!taken.has(row.instanceKey)&&same(row.parameters.target,module.parameters.target))?.instanceKey
    if(match){taken.add(match);used.push(name);continue}
    // The note may sit inside a longer assumption (Desktop r36 A).
    const pattern=new RegExp(`骨架调整[：:]\\s*${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s*[：:]\\s*([^；;\\n]+)`)
    const reason=assumptions.map(text=>pattern.exec(text)?.[1]?.trim()).find(Boolean)
    adjusted.push({key:name,reason:reason??'未说明理由'})
  }
  return {used,adjusted}
}
