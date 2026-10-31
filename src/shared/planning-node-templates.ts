import { z } from 'zod'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { NODE_LABELS, type NodeKind, type ToolChoice } from './types.ts'
import { workflowNodeConfigSchema } from './workflow-validation.ts'
import { NODE_SEMANTICS } from './workflow-semantics.ts'
import { compilerJson, CompilerError, jsonDigest } from './planning-repair.ts'
import { planningOneOf } from './planning-submission-schema.ts'
import { planningAdapterOutputs, parsePlanningToolOutputSnapshot, planningToolOutputContractSchema, type PlanningToolOutputContract, type PlanningToolOutputSnapshot } from './planning-tool-outputs.ts'
import { EXACT_TARGET_EXISTS_CODE, toolOperationContractSchema, validateToolOperation, type ToolOperationContract } from './tool-operation-contract.ts'

export interface PlanningNodeTemplate {
  id:string; kind:NodeKind; title:string; purpose:string
  fixed:Record<string,unknown>; fields:Record<string,any>; descriptions:Record<string,string>
  outputs:{status:'known'|'partial'|'unknown'; source:'node-contract'|'adapter-contract'; fields:Record<string,string>;contract?:PlanningToolOutputContract}
  rules:string[]
  operations?:ToolOperationContract
}
export interface PlanningTemplateBinding {
  protocolVersion:1; catalogDigest:string; templates:PlanningNodeTemplate[]
}
export const templateIdForTool=(id:string)=>'tool-'+jsonDigest(id).slice(0,20)

/** SDK-facing projection only. The authoritative node and tool validators still run. */
export function templateFieldSchema(source:Record<string,any>):JsonSchemaNode {
  const visit=(value:any,seen=new Set<string>()):any=>{
    if(value===true)return {}
    if(value===false)return {}
    if(!value||typeof value!=='object')return {}
    if(value.$ref){
      const ref=String(value.$ref)
      if(!ref.startsWith('#/')||seen.has(ref))return {}
      const resolved=ref.slice(2).split('/').reduce((v:any,k:string)=>v?.[k.replaceAll('~1','/').replaceAll('~0','~')],source)
      return visit(resolved,new Set([...seen,ref]))
    }
    const out:any={}
    for(const k of ['type','const','enum','description'])if(value[k]!==undefined)out[k]=value[k]
    const union=value.oneOf??value.anyOf
    if(union){
      // SDK unions cannot carry validation siblings. Do not accidentally
      // overwrite either constraint when collapsing an unsupported composition.
      if(union.length===1&&['properties','required','additionalProperties','items','enum','const'].some(key=>value[key]!==undefined))throw new CompilerError('TEMPLATE_FIELD_SCHEMA','单分支联合不能与其他字段约束混用',undefined,true)
      delete out.type;Object.assign(out,planningOneOf(union.map((v:any)=>visit(v,seen))))
    }
    if(value.properties)out.properties=Object.fromEntries(Object.entries(value.properties).filter(([,v]:any)=>!v.not).map(([k,v])=>[k,visit(v,seen)]))
    if(value.required)out.required=value.required.filter((k:string)=>!out.properties||Object.hasOwn(out.properties,k))
    if(value.items)out.items=visit(value.items,seen)
    if(value.additionalProperties!==undefined)out.additionalProperties=typeof value.additionalProperties==='boolean'?value.additionalProperties:true
    return out
  }
  return visit(source)
}

const staticTemplates=new Map<NodeKind,PlanningNodeTemplate>()
function nodeTemplate(kind:NodeKind):PlanningNodeTemplate {
  const cached=staticTemplates.get(kind)
  if(cached)return structuredClone(cached)
  const fields=JSON.parse(JSON.stringify(z.toJSONSchema(workflowNodeConfigSchema(kind),{target:'draft-7',io:'input',unrepresentable:'any'})))
  if(fields.properties)delete fields.properties.body
  if(fields.required)fields.required=fields.required.filter((key:string)=>key!=='body')
  const semantic=NODE_SEMANTICS[kind]
  const template:PlanningNodeTemplate={id:kind,kind,title:NODE_LABELS[kind],purpose:semantic.purpose,fixed:{},fields,descriptions:Object.fromEntries(Object.entries(semantic.fields).filter(([key])=>key!=='body')),
    outputs:{status:['code','agent','llm','document'].includes(kind)?'partial':'known',source:'node-contract',fields:{...semantic.outputs}},rules:[...semantic.rules]}
  staticTemplates.set(kind,template)
  return structuredClone(template)
}

/** Frozen metadata only; never queries or executes a business tool. */
const HAND_CHECKED_NATIVE=new Set(['native:read','native:write','native:edit','native:glob'])
export function createTemplateBinding(tools:readonly ToolChoice[],toolOutputs?:PlanningToolOutputSnapshot):PlanningTemplateBinding {
  const outputs=new Map(toolOutputs?parsePlanningToolOutputSnapshot(toolOutputs).contracts.map(contract=>[contract.toolId,contract]):[])
  const templates=(Object.keys(NODE_LABELS) as NodeKind[]).filter(kind=>kind!=='tool').map(nodeTemplate)
  for(const tool of tools.filter(tool=>tool.available)){
    const template=nodeTemplate('tool');template.id=templateIdForTool(tool.id);template.title=tool.name;template.purpose=tool.description
    template.fixed={toolId:tool.id};delete template.fields.properties.toolId;delete template.descriptions.toolId
    if(template.fields.required)template.fields.required=template.fields.required.filter((key:string)=>key!=='toolId')
    template.fields.properties.inputs=structuredClone(tool.inputSchema)
    const {adapterVersion:_,...adapter}=planningAdapterOutputs(tool),contract=outputs.get(tool.id)
    template.outputs={...adapter,...(contract?{contract}:{})}
    // Absent metadata preserves historical binding bytes; new Host registries
    // explicitly attach unknown. Never upgrade a historical task in place.
    if(tool.operationContract){
      template.operations=validateToolOperation(tool.operationContract,tool.id)
      template.rules.push('operations 独立描述动作前置条件、owner／路径范围、状态影响及复用限制；不等于 outputs 合同、执行许可或历史成功证明。unknown 不得按工具同名猜测。')
      if(template.operations.status==='known'&&template.operations.declaration.action.kind==='file-write')template.rules.push('覆盖前须在当前 owner 显式 read 精确目标；首次不存在须走首建分支。不得暗中预读、用 glob 替代 read 或绕过 SDK。列表合同须声明 coverage={kind:exact-path,pathInput:探测参数名,root:.}，本次该参数须为与目标相同的无通配符静态路径；普通列表或过滤结果不能证明不存在。文件动作须使用显式工具节点，文档工具模式不兼容。root=. 的相对 POSIX 路径可用此固定 JavaScript 代码节点，inputs={listing:上游 glob.value,target:写入路径}，按 exists===true 分支读取、false 分支直接写入，随后合流一次 write：'+EXACT_TARGET_EXISTS_CODE)
    }
    if(contract)template.rules.push('输出 contract.guarantee 是结构保证；schema.valuePath=value 表示原生 canonical 值位于 value。observations 仅为指定调用的公开渲染结果，不能据其 shape 推断 value 字段、其他输入或通用结构。没有可信 schema 的内部字段仍为未知。')
    template.rules.push('固定 toolId 由 Host 填入，values 中不得覆盖。inputs 必须满足当前工具参数定义；动态值沿用 {{key.field}} 引用语法。')
    // Desktop r31/r32/r34 each spent a repair on a bare write node.
    // Desktop r45: a hand-written check compared read lines with CRLF text.
    if(tool.id==='native:read')template.rules.push('value.lines[].text 是去掉行尾换行的单行文本：CRLF 文件的 \\r 也已去掉，超长行会被截断并带「... (line truncated to N chars)」，limit/offset 之外的行不返回。拿回读和原文比较时，先把原文按 \\n 分行、去掉每行末尾的 \\r。要文件字节数或行数用 builtin:file.stat，不要从读到的文本推算。')
    // T18 (2026-10-27): official tools without a known contract go into an Agent node,
    // which decides at run time; read/write/edit/glob have hand-checked graph rules.
    if(tool.id.startsWith('native:')&&!HAND_CHECKED_NATIVE.has(tool.id)&&template.operations?.status!=='known')template.rules.push('官方工具，前置条件和能否重复执行未知：试做跑通一次，不能证明换输入或再次运行仍然成立。工作流需要它完成一步时，优先用 Agent 节点（tools 加上本工具，prompt 写清这一步），不做成固定工具节点；文档提取器用 tool 模式读取输入文件不受此限。')
    if(['native:write','native:edit'].includes(tool.id))template.rules.push('写工作区文件优先用 verified-file-write 模块（自带写前探测与回读核对）；直接用本工具时，每条到达路径上都须先有同一路径表达式的 native:read，否则 FILE_WRITE_NEEDS_READ。')
    templates.push(template)
  }
  if(new Set(templates.map(t=>t.id)).size!==templates.length)throw new CompilerError('TEMPLATE_ID_CONFLICT','模板身份重复',undefined,true)
  const snapshot=compilerJson(templates,8_000_000)
  return {protocolVersion:1,catalogDigest:jsonDigest(snapshot),templates:snapshot}
}

const templateSchema=z.object({id:z.string().min(1).max(160),kind:z.enum(Object.keys(NODE_LABELS) as [NodeKind,...NodeKind[]]),title:z.string(),purpose:z.string(),fixed:z.record(z.string(),z.unknown()),fields:z.record(z.string(),z.unknown()),descriptions:z.record(z.string(),z.string()),outputs:z.object({status:z.enum(['known','partial','unknown']),source:z.enum(['node-contract','adapter-contract']),fields:z.record(z.string(),z.string()),contract:planningToolOutputContractSchema.optional()}).strict(),rules:z.array(z.string()),operations:toolOperationContractSchema.optional()}).strict()
export const templateBindingSchema=z.object({protocolVersion:z.literal(1),catalogDigest:z.string().regex(/^[a-f0-9]{64}$/),templates:z.array(templateSchema).max(5020)}).strict()
export function validateTemplateBinding(raw:unknown):PlanningTemplateBinding {
  const binding=templateBindingSchema.parse(compilerJson(raw,8_000_000)) as PlanningTemplateBinding
  for(const template of binding.templates)if(template.operations)validateToolOperation(template.operations,typeof template.fixed.toolId==='string'?template.fixed.toolId:undefined)
  if(jsonDigest(binding.templates)!==binding.catalogDigest||new Set(binding.templates.map(t=>t.id)).size!==binding.templates.length)
    throw new CompilerError('TEMPLATE_CONTRACT_CONFLICT','模板快照摘要或身份无效',undefined,true)
  return binding
}
