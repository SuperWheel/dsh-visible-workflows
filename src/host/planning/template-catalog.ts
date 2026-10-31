import { z } from 'zod'
import type { NodeKind } from '../../shared/types.ts'
import type { PlanningContext } from '../../shared/planning-types.ts'
import { createTemplateBinding, type PlanningTemplateBinding } from '../../shared/planning-node-templates.ts'
import { authoringContext, authoringGraphContext } from '../../shared/planning-authoring-context.ts'
import { planningEditView } from '../../shared/planning-edits.ts'
import { templateIdForTool } from '../../shared/planning-node-templates.ts'
import { contextSelection, focusedPlanningFields, planningContextSlice, selectedConfigFields } from '../../shared/planning-context-slice.ts'
import { allNodes } from '../../shared/workflow-validation.ts'
import { queryWorkflowSemantics } from '../../shared/workflow-semantics.ts'
import type { TemplateFillingCompiler } from '../../shared/planning-template-compiler.ts'

export const templateQuerySchema=z.object({ids:z.array(z.string().min(1).max(160)).min(1).max(12)}).strict()
export const TEMPLATE_QUERY_GUIDANCE='当前提交 schema 仅列已获取模板。完整目录中的其他模板需要先用 planner_node_templates 查询；查询成功后下一轮自动扩展可用模板的提交 schema，再按返回字段填写；明确字段任务不会因查询放开换型或其他字段。查询同时返回填写合同与各类型的 runtimeSemantics.nodes；template 正文直接引用上游路径，不用 inputs 重命名；inputs 无需填写。完整语法、过滤器与例子见同类型节点的 syntax，条件与容器规则见对应节点；缺少模板或运行语法时用 planner_node_templates 按 ids 查询，不要猜测。'
// Reusable requirement vocabulary; format names (JSON, text, etc.) are not code signals.
const TEMPLATE_REQUIREMENT_VOCABULARY:Partial<Record<NodeKind,RegExp>>={
  template:/\btemplate\b|模板|文本拼接|字符串拼接|插值/gi,
  llm:/\bLLMs?\b|\blanguage\s+models?\b|大模型|语言模型(?:节点)?|模型/gi,
  code:/\b(?:code|JavaScript|Python|scripts?)\b|代码(?:节点)?|脚本/gi,
  http:/\b(?:HTTP|GET|POST|URL|API)\b|请求\s*(?:URL|网址)|接口|网页|网址|抓取/gi,
  if:/\bif\b|\b(?:condition(?:al)?|branch|otherwise|else)\b|条件|判断|分支|否则/gi,
  classifier:/\bclassif(?:ier|ication|y)\b|分类/gi,
  iteration:/\biteration\b|\b(?:iterate|for\s+each)\b|遍历|逐项|逐个|对每[个项]|循环处理列表/gi,
  loop:/\bloop\b|\brepeat\b[\s\S]*?\buntil\b|循环(?:直到|直至)|重复[\s\S]*?(?:直到|直至)/gi,
  human:/\bhuman\b|\breview\b|\bapproval\b|\bmanual\s+(?:review|approval|confirmation)\b|人工(?:审核|确认|审批|复核)?|人审|审核/gi,
}
function positiveTemplateRequirement(instruction:string,signal:RegExp):boolean{
  // A negation scopes over coordinated nouns, including “模型、代码或工具”.
  // A new clause/contrast restores positive intent; uncertain mentions stay included.
  const negation=/不(?:使用|调用|采用|需要|允许|要|得|能|用)|禁止|无需|无须|避免|\b(?:no|without|never|cannot)\b|\b(?:do|must)\s+not\b|\b(?:don't|can't)\b/gi
  const clauses=instruction.split(/[。；;!?！？\n]|\.(?=\s|$)|\bbut\b|\binstead\b|但是|而是|不过|但/gi)
  for(const clause of clauses){
    let negativeList=false
    for(const segment of clause.split(/[，,]/)){
      const nouns=Object.values(TEMPLATE_REQUIREMENT_VOCABULARY).reduce((text,term)=>text.replace(term,''),segment)
      const listOnly=!nouns.replace(/\b(?:and|or|a|an|the|any|nodes?|tools?)\b|以及|或者|和|或|与|及|节点|工具|[\s、/()（）]/gi,'')
      for(const match of segment.matchAll(signal)){
        const prefix=segment.slice(0,match.index),last=[...prefix.matchAll(negation)].at(-1)
        if(!last&&!(negativeList&&listOnly))return true
        if(last&&/改用|转用/.test(prefix.slice(last.index+last[0].length)))return true
      }
      negativeList=[...segment.matchAll(negation)].length>0||(negativeList&&listOnly)
    }
  }
  return false
}
export function templateGraphContext(context:PlanningContext){
  return authoringGraphContext(context).map(({kind,config,...node})=>{
    const values=config as Record<string,unknown>
    return {...node,template:kind==='tool'?templateIdForTool(String(values.toolId)):kind,
      values:Object.fromEntries(Object.entries(values).filter(([key])=>kind!=='tool'||key!=='toolId'))}
  })
}
export function planningTemplateCatalog(context:PlanningContext):PlanningTemplateBinding { return createTemplateBinding(context.tools,context.toolOutputs) }
/** A rehearsal procedure turns mechanical checks into check nodes, so a trial-backed
 * author nearly always needs if/code; Desktop r28 spent a whole turn querying `if`. */
export const REHEARSAL_TEMPLATE_KINDS:readonly NodeKind[]=['if','code']
export function prefetchedTemplateIds(binding:PlanningTemplateBinding,context:PlanningContext,instruction:string,extraKinds:readonly NodeKind[]=[]):string[]{
  const kinds=new Set<NodeKind>(['input','output',...extraKinds])
  const selection=contextSelection(context),slice=planningContextSlice(context,selection),targets=new Set(slice.targetNodeIds)
  const relevant=allNodes(context.workflow).filter(node=>targets.has(node.id))
  for(const node of relevant)kinds.add(node.kind)
  // Known field slots already determine the needed types. Prose may describe
  // model selection, HTTP or human review without requesting those node kinds.
  const focused=!!focusedPlanningFields(context)
  if(!focused){
    for(const [kind,signal] of Object.entries(TEMPLATE_REQUIREMENT_VOCABULARY))if(positiveTemplateRequirement(instruction,signal))kinds.add(kind as NodeKind)
    // Users rarely name the text-formatting node, and a missed template costs a
    // whole query turn while its bytes barely move latency; keep it unless negated.
    if(!new RegExp(TEMPLATE_REQUIREMENT_VOCABULARY.template!.source,'i').test(instruction))kinds.add('template')
  }
  const explicit=(selection?.templateIds??[]).filter(id=>binding.templates.some(t=>t.id===id))
  const base=[...new Set([...explicit.filter(id=>binding.templates.find(t=>t.id===id)?.kind!=='tool'),...binding.templates.filter(t=>kinds.has(t.kind)&&t.kind!=='tool').map(t=>t.id)])].slice(0,8)
  const templates=new Map(binding.templates.filter(t=>t.kind==='tool').map(t=>[String(t.fixed.toolId),t]))
  const tools=context.tools.filter(tool=>tool.available&&templates.has(tool.id)),names=new Map<string,number>()
  for(const tool of tools)names.set(tool.name,(names.get(tool.name)??0)+1)
  const mentioned=(text:string)=>{
    if(!text.trim())return false
    // ASCII IDs/names require token boundaries: native:write-extra is not native:write.
    if(/[^\x00-\x7F]/.test(text))return instruction.includes(text)
    return new RegExp('(?:^|[^A-Za-z0-9_.:/-])'+text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=$|[^A-Za-z0-9_.:/-])').test(instruction)
  }
  const candidates=[...explicit.map(id=>String(binding.templates.find(t=>t.id===id)?.fixed.toolId??'')),...(!focused?tools.filter(tool=>mentioned(tool.id)).map(tool=>tool.id):[]),...(!focused?tools.filter(tool=>names.get(tool.name)===1&&mentioned(tool.name)).map(tool=>tool.id):[]),
    ...(context.operation==='revise'?relevant.filter(node=>node.kind==='tool').map(node=>String(node.config.toolId)):[])]
  const selected:string[]=[];let bytes=2
  // Bound automatic expansion. The full frozen directory remains queryable.
  for(const id of new Set(candidates)){
    const template=templates.get(id)
    if(!template||selected.length>=4)continue
    const size=Buffer.byteLength(JSON.stringify(template))+1
    if(bytes+size>24*1024)continue
    bytes+=size;selected.push(template.id)
  }
  return [...base,...selected]
}

/** Runtime meaning complements filling contracts; never include validator Schema
 * or pull unrelated dependency/whole-graph kinds into a focused field task. */
export function runtimeSemanticsForKinds(kinds:NodeKind[]){
  if(!kinds.length)return undefined
  // Discovery has a five-kind query bound; merge without repeating metadata.
  const batches=Array.from({length:Math.ceil(kinds.length/5)},(_,index)=>queryWorkflowSemantics({kinds:kinds.slice(index*5,index*5+5),includeSchema:false}))
  return {...batches[0]!,nodes:batches.flatMap(batch=>batch.nodes??[])}
}
/** Shared by the Host, compiler CLI and offline driver; queries recover syntax as well as fields. */
export function queryPlanningTemplates(compiler:TemplateFillingCompiler,ids:readonly string[]){
  const result=compiler.queryTemplates(templateQuerySchema.parse({ids}).ids)
  return {...result,runtimeSemantics:runtimeSemanticsForKinds([...new Set(result.entries.map(entry=>entry.kind))])}
}
function templateRuntimeSemantics(context:PlanningContext,instruction:string,extraKinds:readonly NodeKind[]){
  const selection=contextSelection(context),needed=new Set<NodeKind>()
  if(context.operation==='create'||selection?.topologyChanged){
    const binding=planningTemplateCatalog(context),prefetched=new Set(prefetchedTemplateIds(binding,context,instruction,extraKinds))
    for(const template of binding.templates)if(prefetched.has(template.id))needed.add(template.kind)
  }
  if(context.operation==='revise'){
    const targets=new Set(selection?.targetNodeIds?.length?selection.targetNodeIds:context.targetNodeIds)
    for(const node of allNodes(context.workflow))if(!targets.size||targets.has(node.id)){
      const fields=selection?.targetFields?.[node.id]
      if(!fields?.length||selectedConfigFields(fields)!.length)needed.add(node.kind)
    }
  }
  if(selection?.templateIds?.length){
    const ids=new Set(selection.templateIds)
    for(const template of planningTemplateCatalog(context).templates)if(ids.has(template.id))needed.add(template.kind)
  }
  return runtimeSemanticsForKinds([...needed])
}

export function templateAuthoringContext(context:PlanningContext,instruction:string,extraKinds:readonly NodeKind[]=[]){
  const {semantics:_,prefetchedKinds:__,tools:___,...view}=authoringContext(context,instruction)
  const original=new Map(planningEditView(context).nodes.map(n=>['n'+n.ref.slice(1),n]))
  return {...view,runtimeSemantics:templateRuntimeSemantics(context,instruction,extraKinds),templateAccess:TEMPLATE_QUERY_GUIDANCE,...(view.graph?{graph:{...view.graph,nodes:view.graph.nodes.map(({kind,config,...node})=>({
    ...node,template:kind==='tool'?templateIdForTool(String(original.get(node.key)?.config.toolId)):kind,
    ...(config?{values:Object.fromEntries(Object.entries(config).filter(([key])=>kind!=='tool'||key!=='toolId'))}:{}),
  }))}}:{})}
}
