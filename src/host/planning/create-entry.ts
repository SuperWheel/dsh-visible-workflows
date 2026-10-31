import { z } from 'zod'
import { planningTrialCheckSchema, type PlanningTrialCheck } from '../../shared/planning-trial.ts'
import { businessModuleCatalog } from '../../shared/planning-business-modules.ts'
import { WORKFLOW_SESSION_TOOL_NAMES } from '../../shared/workflow-session-tools.ts'

/** T31 (Desktop r52: 252 s from request to admission): the main chat names the workflow and
 * relays the request; the Host fills what the main chat used to decide. */
export const createEntryInputSchema=z.object({
  title:z.string().trim().min(1).max(160),
  request:z.string().trim().min(1).max(12_000),
  checks:z.array(z.object({path:z.string().min(1).max(1000).optional()}).passthrough()).max(30).optional(),
  attempt:z.number().int().min(1).max(100).optional(),
}).strict()
export type CreateEntryInput=z.infer<typeof createEntryInputSchema>
export interface CreateEntryFacts {
  workspaceId:string; sessionId:string
  /** Session tools a trial may use, in catalog order. */
  offeredTools:readonly string[]
  /** What a workspace-relative path names right now. */
  fileKind:(path:string)=>'file'|'directory'|'missing'
  digest:(value:unknown)=>string
}

export const CREATE_TOOL_DESCRIPTION='新建工作流的默认入口。title：用户给了名称就照抄，没给就按需求起一个简短名称；request：用户需求原文，原样转达（路径、命令、格式要求都保留），不要改写，也不要替规划设计步骤；checks：只有用户原话写了验收条件（如「结果必须包含 X」「总数应为 N」）才照抄，每项 {kind:text-includes,value:文字} 或 {kind:json-equals|json-type|json-length,pointer:/字段,value}，有多个产物时加 path；表格列名、格式、保存路径、「写入后回读核对」是需求本身，不是验收条件，不要据此编 checks。不传 checks 时 Host 只要求产物存在，内容由生成图里的核对节点检查。Host 自动生成请求 ID、从需求认出输入和产物路径、选试做工具、做模块检查，然后先试做、再生成保存、自动运行一次。需求没写结果保存到哪个文件时先问用户。受理后用 visible_workflow_plan_wait 等待。同一需求重复调用返回原任务；用户明确要求重做时 attempt 加 1。明确只设计不执行、需要自己指定试做工具或检查、修改已有工作流时用 visible_workflow_plan。'
export class CreateEntryError extends Error {
  constructor(readonly code:string,message:string){super(`${code}：${message}`)}
}

const FILE_TOOLS=['read','write','edit','glob','grep','ls','workflow_file_stat']
const WEB_TOOLS=WORKFLOW_SESSION_TOOL_NAMES.filter(name=>name==='workflow_http_request'||name.startsWith('workflow_html_'))
const WEB=/https?:\/\/|网页|网站|抓取|爬取/i
// Named commands or the words for them; a plain file task has no use for a shell (T18: bash steps become Agent nodes).
const SHELL=/\b(?:bash|shell|zsh|shasum|sha\d+sum|md5sum|git|npm|pnpm|yarn|npx|python3?|node|curl|wget|awk|sed|jq|ffmpeg|make|tar|unzip)\b|命令行|终端|脚本|执行命令/i
const REVIEW=/(?:人工|真人|人)?审核(?:通过)?(?:后|以后|之后)(?:再)?(?:写|保存|落盘|提交)|review(?:ed)? before (?:writ|sav)/i
// The fixed draft a review module prefills, quoted after a content word.
const FIXED_TEXT=/(?:内容|正文|初稿|写上)(?:为|是)?[：:]?\s*[「“"]([^」”"]{1,4000})[」”"]/
const WRITE_VERB=/(?:保存|存|写|输出|另存|导出|生成|落盘)(?:到|为|至|入|进|成)|覆盖写入|覆盖|save (?:to|as)|write (?:to|into)|output to/gi
// Workspace-relative file paths: ASCII path characters with an extension or a directory part.
const PATH=/(?<![A-Za-z0-9_./*?\[\]-])((?:[A-Za-z0-9_.*?\[\]-]+\/)*[A-Za-z0-9_*?\[\]-][A-Za-z0-9_.*?\[\]-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?![A-Za-z0-9_/-])/g

/** Paths the request names, split into existing inputs and the files it asks to write. */
export function requestPaths(request:string,fileKind:CreateEntryFacts['fileKind']):{inputs:string[];artifacts:string[]}{
  const text=request.replace(/https?:\/\/\S+/gi,match=>' '.repeat(match.length)),inputs:string[]=[],artifacts:string[]=[]
  const verbs=[...text.matchAll(WRITE_VERB)].map(match=>match.index!+match[0].length)
  for(const match of text.matchAll(PATH)){
    const path=match[1]!.replace(/^\.\//,'')
    // A pattern stays in the task; the trial lists it (TRIAL_INPUT_PATTERN).
    if(/[*?[\]]/.test(path)||path.split('/').some(part=>part==='..'||part==='.'))continue
    const start=match.index!,verb=verbs.filter(end=>end<=start).at(-1)
    // A write verb earlier in the same clause, a few words away, makes it the file to write.
    const written=verb!==undefined&&start-verb<=20&&!/[，。；;,\n]/.test(text.slice(verb,start))
    if(written){if(!artifacts.includes(path))artifacts.push(path)}
    else if(fileKind(path)==='file'&&!inputs.includes(path))inputs.push(path)
  }
  return {inputs:inputs.filter(path=>!artifacts.includes(path)),artifacts}
}

/** The tools a trial gets: file tools always, web and shell tools when the request calls for them, other tools it names. */
export function requestTools(request:string,offered:readonly string[]):string[]{
  const named=(name:string)=>new RegExp(`(?<![A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![A-Za-z0-9_])`,'i').test(request)
  return offered.filter(name=>FILE_TOOLS.includes(name)||WEB_TOOLS.includes(name as never)&&WEB.test(request)||name==='bash'&&SHELL.test(request)||named(name))
}

/** The plan request the ordinary entry gate admits; nothing here bypasses it. */
export function buildCreateEntry(raw:unknown,facts:CreateEntryFacts):Record<string,unknown>{
  const input=createEntryInputSchema.parse(raw),{title,request}=input
  const requestId='create-'+facts.digest([facts.workspaceId,facts.sessionId,title,request,input.checks??[],input.attempt??1]).slice(0,32)
  const named=requestPaths(request,facts.fileKind),artifacts=named.artifacts
  const checks=new Map<string,PlanningTrialCheck[]>()
  // Desktop r53 B: the main chat copied the artifact shape {path,requireChanged,checks:[…]} from visible_workflow_plan.
  // Each inner check counts; requireChanged and format stay the Host's call.
  const rows=(input.checks??[]).flatMap((row,index)=>{
    const {checks:inner,requireChanged:_changed,format:_format,...rest}=row
    if(inner===undefined)return [{at:`checks[${index}]`,row:rest}]
    if(!Array.isArray(inner)||Object.keys(rest).some(key=>key!=='path'))return [{at:`checks[${index}]`,row}]
    return inner.map((check,position)=>({at:`checks[${index}].checks[${position}]`,row:{...(rest.path===undefined?{}:{path:rest.path}),...(check&&typeof check==='object'?check:{check})}}))
  })
  for(const {at,row} of rows){
    const {path,...check}=row as {path?:string},parsed=planningTrialCheckSchema.safeParse(check)
    if(!parsed.success)throw new CreateEntryError('CREATE_CHECK_INVALID',`${at} 须是 {kind:text-includes,value:文字} 或 {kind:json-equals|json-type|json-length,pointer:/字段,value}，可加 path 指明是哪个产物。`)
    const target=path?.replace(/^\.\//,'')??(artifacts.length===1?artifacts[0]:undefined)
    if(!target)throw new CreateEntryError('CREATE_CHECK_PATH_REQUIRED',artifacts.length?`需求里有多个产物（${artifacts.join('、')}），${at} 须写 path。`:`需求里没认出产物文件，${at} 须写 path。`)
    if(!artifacts.includes(target))artifacts.push(target)
    checks.set(target,[...checks.get(target)??[],parsed.data])
  }
  if(!artifacts.length)throw new CreateEntryError('CREATE_ARTIFACT_UNKNOWN','需求里没写明结果保存到哪个文件（工作区相对路径，如 out/report.md）。先问用户保存位置，把路径加进 request 后重新调用；或改用 visible_workflow_plan 自己声明 execution.artifacts。')
  const modules=businessModuleCatalog(),ids=modules.map(module=>`${module.id}@${module.version}`)
  const review=REVIEW.test(request),fixed=FIXED_TEXT.exec(request)?.[1]
  // Desktop r57 D: the main chat restated the fixed draft as a text check; such a check adds nothing the draft does not hold.
  const restated=[...checks.values()].flat().every(check=>check.kind==='text-includes'&&!!fixed&&fixed.includes(check.value.trim()))
  // The review module needs a literal target and a fixed draft; then the Host instantiates it with no planning call.
  if(review&&fixed&&!/\{[{%]/.test(fixed)&&artifacts.length===1&&restated&&ids.includes('reviewed-file-write@1.0.0'))
    // No trial to run first; the Host still runs the saved module once, as the main chat is told (Desktop r59 D).
    return {requestId,operation:'create',instruction:request,title,execution:{mode:'design-only'},runAfterSave:true,
      handoff:{version:1,mode:'module',module:{moduleId:'reviewed-file-write',version:'1.0.0',instanceKey:'review',
        parameters:{target:artifacts[0],producer:{text:`{% if reviewBase or reviewNote %}{{reviewBase}}{% else %}${fixed}{% endif %}`},maxIterations:3}}}}
  const reason=review?'需求要求审核后再写，但没给出固定正文，交给生成阶段（审核仍须在写入之前）':'需求里没有「每轮审核后再写」等模块信号，模块是否适用交给生成阶段判断'
  return {requestId,operation:'create',instruction:request,title,moduleCheck:{checked:ids,notApplicable:`Host 按需求关键词预判：${reason}。`},
    execution:{mode:'execute-first',task:request,tools:requestTools(request,facts.offeredTools),inputs:named.inputs.filter(path=>!artifacts.includes(path)),
      // No stated check: the file only has to exist afterwards; the generated graph checks the content.
      artifacts:artifacts.map(path=>({path,format:/\.json$/i.test(path)?'json':'text',checks:checks.get(path)??[],requireChanged:false}))}}
}
