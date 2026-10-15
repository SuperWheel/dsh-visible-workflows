import type { InputField, JsonValue, NodeExecution, WorkflowNode } from '../shared/types.ts'
import { outputFields } from './nodes.ts'

export interface VariableMetadata { name:string; reference:string; type:string; description:string }
type Metadata = Pick<VariableMetadata,'type'|'description'>
const meta=(type:string,description:string):Metadata=>({type,description})
const text=meta('string','节点输出的文本')

/** These are this plugin's runtime contracts, not the output schema of a Dify node. */
const contracts:Partial<Record<WorkflowNode['kind'],Record<string,Metadata>>>={
 input:{text:meta('string','输入字段的 JSON 文本')},
 template:{text:meta('string','模板转换后的文本')},
 output:{text:meta('string','最终输出文本')},
 llm:{text:meta('string','模型生成的内容'),json:meta('object','按输出字段解析后的结构化内容')},
 agent:{text:meta('string','Agent 返回的最终内容'),steps:meta('number','Agent 已执行的步数'),tool_results:meta('array','工具调用结果记录')},
 knowledge:{text:meta('string','检索结果的文本摘要'),results:meta('array','匹配的检索结果'),result:meta('array','匹配的检索结果'),method:meta('string','检索方法'),count:meta('number','匹配结果数量')},
 classifier:{text:meta('string','命中的分类名称'),class_id:meta('string','命中的分类 ID'),class_label:meta('string','命中的分类名称'),class_name:meta('string','命中分类的说明；未填写时使用名称')},
 if:{text:meta('string','命中的分支 ID'),result:meta('boolean','是否命中 true 分支'),branch:meta('string','命中的分支 ID')},
 human:{text:meta('string','用户提交内容的 JSON 文本'),__action_id:meta('string','用户选择的操作 ID'),__action_value:meta('string','用户选择的操作名称'),__rendered_content:meta('string','向用户展示的表单内容')},
 iteration:{text:meta('string','迭代结果的 JSON 文本'),result:meta('array','收集的各项迭代结果'),json:meta('array','收集的各项迭代结果'),errors:meta('array','迭代失败项及原因')},
 loop:{text,variables:meta('object','循环结束时的变量'),iterations:meta('number','实际执行的循环轮数')},
 aggregator:{text:meta('string','聚合结果的文本表示'),json:meta('object','按聚合组名称组织的结果')},
 assigner:{text:meta('string','本次赋值结果的 JSON 文本'),variables:meta('object','本次修改的变量'),json:meta('object','本次修改的变量')},
 extractor:{text:meta('string','模型返回的原始内容'),json:meta('object','成功提取的参数'),__is_success:meta('number','1 表示提取成功，0 表示失败'),__reason:meta('string','提取失败原因；成功时为空')},
 http:{text:meta('string','响应正文'),body:meta('string','响应正文'),status_code:meta('number','HTTP 响应状态码'),headers:meta('object','过滤敏感字段后的响应头')},
 list:{text:meta('string','处理结果的 JSON 文本'),result:meta('array','筛选、排序或截取后的列表'),json:meta('array','筛选、排序或截取后的列表'),first_record:meta('动态类型','列表第一项；空列表时为 null'),last_record:meta('动态类型','列表最后一项；空列表时为 null')},
 document:{text:meta('string','解析得到的文档文本'),characters:meta('number','提取文本的字符数')},
}
function valueType(value:JsonValue):string { return value===null?'null':Array.isArray(value)?'array':typeof value }
function valueAt(data:Record<string,JsonValue>|undefined,name:string):JsonValue|undefined {
 if(data&&Object.prototype.hasOwnProperty.call(data,name))return data[name]
 let value:JsonValue|undefined=data
 for(const part of name.split('.')){if(value===null||typeof value!=='object'||!Object.prototype.hasOwnProperty.call(value,part))return undefined;value=(value as Record<string,JsonValue>)[part]}
 return value
}
export function inputVariable(field:InputField,prefix='input'):VariableMetadata {
 const types:Record<NonNullable<InputField['type']>,string>={text:'string',paragraph:'string',select:'string',number:'number',boolean:'boolean',json:'JSON',file:'object',files:'array'}
 return {name:field.name,reference:`{{${prefix}.${field.name}}}`,type:types[field.type??'text'],description:field.label||'未设置字段说明'}
}
export function nodeOutputVariables(node:WorkflowNode,data?:Record<string,JsonValue>):VariableMetadata[] {
 const c=node.config
 return outputFields(node,data).map(name=>{
  const declared=(node.kind==='extractor'?c.parameters:c.outputSchema)?.find(field=>field.name===name)
  const input=['input','human'].includes(node.kind)?c.fields?.find(field=>field.name===name):undefined
  const known=contracts[node.kind]?.[name]
  const actual=valueAt(data,name)
  const inferred=actual===undefined?undefined:valueType(actual)
  const fallback=name==='text'?text:meta('动态类型','类型将在节点运行后确定')
  const definition=input?inputVariable(input,node.id):declared?meta(declared.type,declared.description||'未设置字段说明'):known??fallback
  return {name,reference:`{{${node.id}.${name}}}`,type:inferred??definition.type,description:definition.description==='类型将在节点运行后确定'&&inferred?'来自上次成功运行的输出':definition.description}
 })
}
export function scopeVariables(parents:WorkflowNode[],upstream:WorkflowNode[],executions:NodeExecution[]):VariableMetadata[] {
 const variables:VariableMetadata[]=[]
 if(parents.some(node=>node.kind==='iteration'))variables.push({name:'item',reference:'{{item}}',type:'动态类型',description:'当前迭代项'})
 if(parents.length)variables.push({name:'index',reference:'{{index}}',type:'number',description:'当前迭代或循环的索引，从 0 开始'})
 const names=[...new Set([...parents.flatMap(node=>Object.keys(node.config.initialVariables||{})),...upstream.filter(node=>node.kind==='assigner').flatMap(node=>node.config.assignments?.map(value=>value.name)||[])])]
 for(const name of names){
  const assignment=upstream.filter(node=>node.kind==='assigner'&&node.config.assignments?.some(value=>value.name===name)).at(-1)
  const actual=assignment?executions.filter(record=>record.nodeId===assignment.id&&record.status==='success').at(-1)?.data?.[name]:undefined
  variables.push({name:`vars.${name}`,reference:`{{vars.${name}}}`,type:actual===undefined?'动态类型':valueType(actual),description:'当前作用域中的可变值'})
 }
 return variables
}
