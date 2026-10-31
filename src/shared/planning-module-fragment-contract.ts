import { webExtractRecipe } from './planning-web-extract-recipe.ts'
import { z } from 'zod'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { businessModuleParametersSchema, reviewedFileWriteParametersSchema } from './planning-business-module-contract.ts'
import { planningOneOf } from './planning-submission-schema.ts'
import { fixedCode } from './planning-table-recipe.ts'
import { listMapRecipe } from './planning-list-map-recipe.ts'
import { extractValidateRecipe } from './planning-extract-validate-recipe.ts'
import { verifiedFileWriteRecipe } from './planning-verified-file-recipe.ts'
import { jsonDigest, CompilerError } from './planning-repair.ts'
import type { NodeKind } from './types.ts'

export const fragmentKey=z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/).refine(s=>!['input','env','sys','loop','__proto__','constructor','prototype'].includes(s))
// Port parameters are references, never literals, filters, or executable expressions.
export const fragmentReference=z.string().regex(/^\{\{\s*(?:[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+|item(?:\.[A-Za-z0-9_-]+)*|index)\s*\}\}$/,'输入端口只接受上游字段或容器 item/index 的完整引用')
export const tableFragmentParameters=businessModuleParametersSchema.extend({rows:fragmentReference})
export interface FragmentRecipe {
  entry:string; exit:string
  nodes:Record<string,{kind:NodeKind;config:Record<string,unknown>;title?:string;description?:string;scope?:string[]}>
  chains:Record<string,{container?:string;nodes:string[]}>
  links:Record<string,{source:string;target:string;port?:string}>
}
export interface FragmentModule {
  id:string;version:string;title:string;purpose:string;implementationDigest:string
  inputs:Record<string,{type:string;description:string}>;outputs:Record<string,{type:string;description:string}>;scopes:'any'|'root'
  parameters:z.ZodType<Record<string,unknown>>; parameterExample:Record<string,unknown>
  parameterWire:JsonSchemaNode
  recipe(parameters:Record<string,unknown>):FragmentRecipe
}
const parameterWire:JsonSchemaNode={type:'object',properties:{
  title:{type:'string',description:'字面标题，1–160 字符，不含引用。'},
  columns:{type:'array',items:{type:'object',properties:{key:{type:'string',description:'唯一字段名，英文字母开头，仅字母数字下划线，最多40字符。'},label:{type:'string',description:'字面列名，1–100字符。'}},required:['key','label'],additionalProperties:false},description:'1–10列；key不得重复。'},
  emptyText:{type:'string',description:'字面空表文案，最多1000字符；默认暂无数据。'},
  rows:{type:'string',description:'输入端口：仅完整上游字段引用 {{upstream.rows}}，或容器 {{item}} / {{item.rows}} / {{index}}；运行时最多500行标量对象。'},
},required:['title','columns','rows'],additionalProperties:false}
const inputs={rows:{type:'array',description:'上游 JSON 对象数组，最多500行。'}}
const outputs={text:{type:'string',description:'转义后的 Markdown 表格。'},count:{type:'number',description:'输入行数。'}}
const recipe=(parameters:Record<string,unknown>):FragmentRecipe=>{
  const {rows,...specification}=parameters
  return {entry:'render',exit:'render',nodes:{render:{kind:'code',title:'结构化结果渲染',config:{...structuredClone(fixedCode),inputs:{rows,specification}}}},chains:{},links:{}}
}
const digest=jsonDigest({recipe:recipe({rows:'{{upstream.rows}}',title:'<title>',columns:[],emptyText:'<emptyText>'}),parameters:z.toJSONSchema(tableFragmentParameters,{io:'input'}),inputs,outputs,scopes:'any',runtimeContract:'javascript-main-json-v1'})
const pinned='21e6a7e3cdc84ce2f5092987ec7167949f928e9b1b626f1b9106845b56d56b7e'
if(pinned!==digest)throw new CompilerError('MODULE_CONTRACT_DRIFT','表格片段固定实现变化；需新版本及独立验证 '+digest,undefined,true)
export const listMapFragmentParameters=z.object({items:fragmentReference.max(400),template:z.string().max(100000)}).strict()
const listInputs={items:{type:'array',description:'上游数组或其 JSON 文本；运行时最多1000项。'}}
const listOutputs={texts:{type:'string',description:'按输入顺序收集的字符串数组的紧凑 JSON 文本；空数组为 []。'},count:{type:'number',description:'收集的字符串数。'}}
const listParameterWire:JsonSchemaNode={type:'object',properties:{
  items:{type:'string',description:'最多400字符；仅完整上游字段引用 {{upstream.items}} 或容器 {{item}} / {{item.items}} / {{index}}；运行时数组最多1000项。'},
  template:{type:'string',description:'逐项 template 正文，0–100000字符；支持 item、item.字段、index 及合法外部上游引用；沿用正常模板语法、作用域和上游检查。'},
},required:['items','template'],additionalProperties:false}
const listDigest=jsonDigest({recipe:listMapRecipe({items:'{{upstream.items}}',template:'<template>'}),parameters:z.toJSONSchema(listMapFragmentParameters,{io:'input'}),inputs:listInputs,outputs:listOutputs,scopes:'any',runtimeContract:'iteration-template-json-v1'})
const listPinned='5d64dc4771d905129a4f76393497b085f256834c6305ecdd45fef3ec239a9a45'
if(listPinned!==listDigest)throw new CompilerError('MODULE_CONTRACT_DRIFT','列表模板片段固定实现变化；需新版本及独立验证 '+listDigest,undefined,true)
const literal=(max:number)=>z.string().max(max).refine(s=>!s.includes('{{')&&!s.includes('{%'),'只接受字面文本，不含模板引用或语句')
export const extractValidateFragmentParameters=z.object({
  source:fragmentReference.max(400),
  fields:z.array(z.object({
    name:z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).refine(s=>!['constructor','prototype','__proto__'].includes(s)),
    type:z.enum(['string','number','boolean','array','object']),required:z.boolean(),description:literal(2000),
  }).strict()).min(1).max(40).refine(fields=>new Set(fields.map(f=>f.name)).size===fields.length,'字段名不得重复'),
  instruction:literal(4000).optional(),
}).strict()
const extractInputs={source:{type:'string',description:'待抽取的原始文本；仅完整上游或容器 item/index 引用。'}}
const extractOutputs={ok:{type:'boolean',description:'仅类型和必填校验通过；下游 if 用 {{key.ok}} 分流，不保证语义正确。'},data:{type:'object',description:'仅含已声明且类型合法的字段；不做类型强转，缺失可选字段省略。'},errors:{type:'array',description:'{field,reason} 数组；空 field 表示整体 JSON 非对象或解析失败。'},source:{type:'string',description:'原始输入文本，原样保留。'}}
const extractParameterWire:JsonSchemaNode={type:'object',properties:{
  source:{type:'string',description:'最多400字符；仅完整上游字段引用或容器 item/index 引用；运行时须为字符串。'},
  fields:{type:'array',description:'1–40个唯一字段；全部四项必填。仅类型/必填检查；array只允许string/finite number/boolean元素，object仅检查顶层类型，无嵌套schema。',items:{type:'object',properties:{
    name:{type:'string',description:'1–80字符，英文字母开头，仅字母数字下划线；禁constructor/prototype/__proto__。'},
    type:{type:'string',enum:['string','number','boolean','array','object']},required:{type:'boolean'},description:{type:'string',description:'0–2000字符字面字段说明，不含 {{ 或 {% 。'},
  },required:['name','type','required','description'],additionalProperties:false}},
  instruction:{type:'string',description:'可选，0–4000字符字面补充抽取指令，不含 {{ 或 {% ；不覆盖实现/模型。'},
},required:['source','fields'],additionalProperties:false}
const extractDigest=jsonDigest({recipe:extractValidateRecipe({source:'{{upstream.text}}',fields:[{name:'value',type:'string',required:true,description:'<description>'}],instruction:'<instruction>'}),parameters:z.toJSONSchema(extractValidateFragmentParameters,{io:'input'}),inputs:extractInputs,outputs:extractOutputs,scopes:'any',runtimeContract:'extractor-text-javascript-main-json-v1'})
const extractPinned='aa867bc3a36898088201fc767b2043295d7540e9930190a83100cce357eab6e3'
if(extractPinned!==extractDigest)throw new CompilerError('MODULE_CONTRACT_DRIFT','抽取校验片段固定实现变化；需新版本及独立验证 '+extractDigest,undefined,true)
export const webExtractFragmentParameters=z.object({url:z.string().min(1).max(2048).refine(value=>{
  if(fragmentReference.safeParse(value).success)return true
  // Only ordinary interpolation; the compiler still validates every reference
  // and scope. The HTTP adapter validates the final resolved URL at runtime.
  const literal=value.replace(/\{\{[^{}]*\}\}/g,ref=>fragmentReference.safeParse(ref).success?'reference':ref)
  if(/[{}\s]/.test(literal))return false
  try{const url=new URL(literal);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password}catch{return false}
},'仅无内嵌凭证的 HTTP(S) URL 或普通上游/item/index 插值；最终地址仍由 HTTP 执行器校验')}).strict()
const webInputs={url:{type:'string',description:'请求 URL：无内嵌凭证的 HTTP(S) 字面量或普通上游/item/index 插值，最多2048字符。'}}
const webOutputs={status:{type:'string',description:'ok/http_error/empty/not_html；非2xx优先http_error；解压后超过10MB时HTTP节点失败；传输/超时仍失败。'},httpStatus:{type:'number',description:'真实 HTTP 状态码。'},title:{type:'string',description:'title纯文本，实体解码并合并空白；最多500个UTF-16码元。'},text:{type:'string',description:'静态HTML正文；优先main，其次article，否则body；去脚本等内容、解码常见实体、合并空白，最多20000个UTF-16码元；无容器或空正文为empty。'},url:{type:'string',description:'请求的URL，不跟随重定向。'}}
const webParameterWire:JsonSchemaNode={type:'object',properties:{url:{type:'string',description:'1–2048字符；无内嵌凭证的http(s)字面URL，或普通完整/嵌入上游字段、item/index引用；不含过滤器/语句。最终地址由原HTTP执行器检查；固定GET，无请求头/请求体/实现覆盖。静态HTML，输出status/httpStatus/title/text/url；status为ok/http_error/empty/not_html；普通HTTP原样返回，超过256KB缓存；随后可见HTML工具提取，超过10MB时HTTP节点失败。超时/传输仍在HTTP节点失败，不跟随重定向。'}},required:['url'],additionalProperties:false}
const webDigest=jsonDigest({recipe:webExtractRecipe({url:'https://example.com/{{upstream.path}}'}),parameters:z.toJSONSchema(webExtractFragmentParameters,{io:'input'}),inputs:webInputs,outputs:webOutputs,scopes:'any',runtimeContract:'http-raw-cache-html-extract-text-v1.1'})
const webPinned='5f8002af6ebe28c1656ee0ef9b3167320bbcffc21b95c1874d6c3b90257b2928'
if(webPinned!==webDigest)throw new CompilerError('MODULE_CONTRACT_DRIFT','网页提取片段固定实现变化；需新版本及独立验证 '+webDigest,undefined,true)
const verifiedTargetReference=z.string().regex(/^\{\{input\.[A-Za-z_][A-Za-z0-9_-]*\}\}$/).refine(value=>!['__proto__','constructor','prototype'].includes(value.slice(8,-2)))
export const verifiedFileFragmentParameters=z.object({target:z.union([reviewedFileWriteParametersSchema.shape.target,verifiedTargetReference]),content:fragmentReference.max(400).refine(value=>!/^\{\{\s*(?:item(?:\.|\s*\}\})|index\s*\}\})/.test(value),'正文仅接受完整上游字段引用')}).strict()
const verifiedInputs={target:{type:'string',description:'字面路径或单个 {{input.outputPath}}；运行前执行同一安全路径校验。'},content:{type:'string',description:'完整上游字段引用；写入完整正文。'}}
const verifiedOutputs={path:{type:'string',description:'写入工具返回的路径，缺失时使用 target。'},operation:{type:'string',description:'created/updated，优先采用写入结果；缺失时按精确探测分支。'},check:{type:'string',description:'闭集 window-match/mismatch/unchecked；触及行长或超过单窗上限为unchecked。window-match仅表示窗口一致，不证明精确相等。'},checkNote:{type:'string',description:'简短核对说明；窗口不能区分CR/换行格式及末尾换行。'}}
const verifiedParameterWire:JsonSchemaNode={type:'object',properties:{
  target:{type:'string',description:'字面量工作区根相对文件路径或单个完整 {{input.outputPath}} 引用（仅 input 单字段，无空格/拼接/过滤器）；运行时先校验再探测，沿用 reviewed-file-write：禁绝对路径、空段、.、..、反斜杠、冒号、NUL、花括号、通配符和 .dsh-drafts/。仅根作用域，防止迭代覆盖同一目标。'},
  content:{type:'string',description:'最多400字符；仅完整上游字段引用 {{producer.text}}，运行时须为完整字符串。固定精确探测→存在时read→write→read回读→窗口核对；不能关闭回读，无人审/工具/代码覆盖槽。固定首窗 offset=1、limit=2000；冻结SDK默认每行2000码元、50KiB。check=window-match/mismatch/unchecked，触及行长或超任一上限为unchecked；窗口一致不证明精确相等，CR及末尾换行差异不可见。'},
},required:['target','content'],additionalProperties:false}
const verifiedDigest=jsonDigest({recipe:verifiedFileWriteRecipe({target:'reports/result.txt',content:'{{upstream.text}}'}),parameters:z.toJSONSchema(verifiedFileFragmentParameters,{io:'input'}),inputs:verifiedInputs,outputs:verifiedOutputs,scopes:'root',runtimeContract:'native-fs-frozen-default-window-check-input-target-v2'})
const verifiedPinned='71f31824dd59d14c1392c1f7e69a3ff5dc92af54b0f01a63279e7af7083434ef'
if(verifiedPinned!==verifiedDigest)throw new CompilerError('MODULE_CONTRACT_DRIFT','窗口核对写入片段固定实现变化；需独立验证 '+verifiedDigest,undefined,true)
export const fragmentModules:readonly FragmentModule[]=[{
  id:'structured-result-table',version:'1.0.0',title:'结构化结果表格渲染',purpose:'rows → Markdown 表格。',implementationDigest:digest,
  inputs,outputs,scopes:'any',parameters:tableFragmentParameters,parameterWire,
  parameterExample:{title:'成绩表',columns:[{key:'name',label:'姓名'}],emptyText:'暂无数据',rows:'{{fetch.rows}}'},recipe,
},{
  id:'list-map-template',version:'1.0.0',title:'列表逐项模板',purpose:'逐项 template → 有序字符串 JSON 数组及数量。',implementationDigest:listDigest,
  inputs:listInputs,outputs:listOutputs,scopes:'any',parameters:listMapFragmentParameters,parameterWire:listParameterWire,
  parameterExample:{items:'{{fetch.items}}',template:'{{index}}: {{item.name}}'},recipe:listMapRecipe,
},{
  id:'extract-validate',version:'1.0.0',title:'结构化抽取校验',purpose:'文本→字段类型/必填校验；下游 if 用 {{key.ok}} 分流，不保证语义正确。',implementationDigest:extractDigest,
  inputs:extractInputs,outputs:extractOutputs,scopes:'any',parameters:extractValidateFragmentParameters,parameterWire:extractParameterWire,
  parameterExample:{source:'{{fetch.text}}',fields:[{name:'name',type:'string',required:true,description:'姓名'}]},recipe:extractValidateRecipe,
},{
  id:'web-extract',version:'1.1.0',title:'静态网页正文',purpose:'GET原样响应→HTML正文；超过10MB失败，不执行脚本。',implementationDigest:webDigest,
  inputs:webInputs,outputs:webOutputs,scopes:'any',parameters:webExtractFragmentParameters,parameterWire:webParameterWire,
  parameterExample:{url:'https://example.com/page'},recipe:webExtractRecipe,
},{
  id:'verified-file-write',version:'1.1.0',title:'写入并核对窗口',purpose:'根层写入并回读核对窗口；超限unchecked，窗口一致不证明精确相等。',implementationDigest:verifiedDigest,
  inputs:verifiedInputs,outputs:verifiedOutputs,scopes:'root',parameters:verifiedFileFragmentParameters,parameterWire:verifiedParameterWire,
  parameterExample:{target:'{{input.outputPath}}',content:'{{render.text}}'},recipe:verifiedFileWriteRecipe,
}]
export function tableFragmentCatalogEntry(){const m=fragmentModules[0]!;return structuredClone({inputs:m.inputs,outputs:m.outputs,scopes:m.scopes,implementationDigest:m.implementationDigest,parameters:z.toJSONSchema(m.parameters,{io:'input'}),parameterExample:m.parameterExample,purpose:m.purpose})}
export function fragmentCatalog(){return fragmentModules.map(m=>{const {emptyText:_,...example}=m.parameterExample;return {module:m.id+'@'+m.version,purpose:m.purpose,ports:{inputs:Object.keys(m.inputs),outputs:Object.keys(m.outputs)},parameterExample:example}})}
export const MODULE_FRAGMENT_GUIDANCE='可组合片段与节点 key 共用命名空间；CREATE modules:[{key,module,parameters}] 可放进 chains 或作 links 目标，不能作分支源。输出仅用声明的 {{key.port}}；容器内也可使用。EDIT 用 addModules / updateModules:{实例key:{parameters}} / removeModules:[实例key]，不能直接改有效实例内部节点；脱离后按普通节点编辑。'
export function fragmentContract(){
  const declaration:JsonSchemaNode=planningOneOf(fragmentModules.map(m=>({type:'object',properties:{key:{type:'string',description:m.title+'的 key；与节点共用命名空间；1–40字符，以英文字母开头，仅字母数字下划线连字符。'},module:{type:'string',const:m.id+'@'+m.version},parameters:m.parameterWire,scope:{type:'array',items:{type:'string'},description:m.title+'的容器归属；兼容显式 scope；CREATE 通常省略并由 chain 推导。'}},required:['key','module','parameters'],additionalProperties:false})))
  return {type:'array',items:declaration} as JsonSchemaNode
}
