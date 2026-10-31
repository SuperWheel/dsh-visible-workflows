import { fragmentContract, fragmentModules, MODULE_FRAGMENT_GUIDANCE } from './planning-module-fragment-contract.ts'
import { expandModuleFragments, bindFragmentKeys, FragmentIssues, normalizeModuleDeclarations, verifiedModuleInstances, moduleInstanceRefs, instanceEdges,
  rewriteFragmentParameters, authoredChainPath } from './planning-module-fragments.ts'
import { nodeDescription, nodeDescriptionWire, updateDescriptionWire } from './planning-node-note.ts'
import { completionNextSchema, completionRepairIssue, type PlanningCompletionPlan } from './planning-completion.ts'
import { z } from 'zod'
import type { JsonSchemaNode, ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { NODE_LABELS, type Workflow } from './types.ts'
import type { PlanningContext, PlanningIssue, PlannerOutput } from './planning-types.ts'
import { allNodes, workflowNodeConfigSchema } from './workflow-validation.ts'
import { codeInputReads } from './planning-code-inputs.ts'
import { CANONICAL_INPUT_GUIDANCE, CANONICAL_TEMPLATE_GUIDANCE, CANONICAL_EXIT_GUIDANCE, NODE_SEMANTICS } from './workflow-semantics.ts'
import { compilePlanningEdits, planningEditDigest, planningEditView, planningNodeRefs, planningUpdateLocals, rewritePlanningConfig,
  type PlanningAliases } from './planning-edits.ts'
import type { PlanningReservations } from './planning-continuation.ts'
import { compilerJson, CompilerError, jsonDigest, issueFromError, needsInputSchema, needsInputWireSchema, pointer, pointerParts, RepairSession, submissionSchema,
  type CompilerIssue, type UniqueRepair } from './planning-repair.ts'
import { submissionSchemaIssues } from './planning-submission-schema.ts'

const reservedKeys=['input','env','sys','loop','__proto__','constructor','prototype']
const keyGuidance='key 为1–40个字符，以英文字母开头，其余仅字母、数字、下划线或连字符；不能使用保留词 '+reservedKeys.join('/')+'。'
export const AUTHORING_NODE_KEY_GUIDANCE=keyGuidance+CANONICAL_EXIT_GUIDANCE+'input 只能作为输入引用命名空间，不能作为节点 key。'
export const AUTHORING_TITLE_GUIDANCE='CREATE 工作流级 title 必填；请求给出名称时必须同名，节点级 title 可选。'
const key=z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/,{error:keyGuidance}).refine(s=>!reservedKeys.includes(s),{error:issue=>'key '+JSON.stringify(issue.input)+' 是保留词。'+AUTHORING_NODE_KEY_GUIDANCE})
const keyWire:JsonSchemaNode={type:'string',description:keyGuidance}
export const authoringNodeKeyWire:JsonSchemaNode={type:'string',description:AUTHORING_NODE_KEY_GUIDANCE}
export const AUTHORING_TOPOLOGY_GUIDANCE='CREATE：顺序决定连线，Host 接线。每层用 chains 描述顺序，普通顺序、并行分叉和汇合用多条 chains；外层 chain 至少2个节点。'+
  '容器内部用 {key:"<内部链key>",container:"<容器节点key>",nodes:["<内部节点key>"]}，可只有1个节点，嵌套容器也用各自的 container chain。'+
  '节点 scope 由 chain 归属和 links 端点推导，不必填写；容器内缺 input 时 Host 自动补空入口并连接所有无上游节点，不要手写入口。'+
  'links 仅用于 if/classifier/human 的分支出口，必须填写合法字符串 port（如 "true"/"false"），不是布尔值；if/classifier 不能在 chain 中后接节点。'+
  '显式节点 scope 仅兼容旧协议，必须等于推导值；link.scope 已弃用，省略即可。EDIT 保持显式 scope 和 addLinks/removeLinks 协议。'
export const authoringScopeWire:JsonSchemaNode={type:'array',items:authoringNodeKeyWire,
  description:'从外到内的祖先 loop/iteration 容器节点 key；chain key 不是容器 scope。CREATE 无需填写，由 chains/container 和 links 端点推导；兼容值必须与推导一致，link.scope 已弃用。EDIT 保持原义。'}
const kind=z.enum(Object.keys(NODE_LABELS) as [keyof typeof NODE_LABELS,...(keyof typeof NODE_LABELS)[]])
const config=z.record(z.string(),z.unknown()).refine(value=>!Object.hasOwn(value,'body'),'config.body 由 Host 根据 scope 组装')
const node=z.object({description:nodeDescription.optional(),kind,title:z.string().trim().min(1).max(200).optional(),config,scope:z.array(key).max(5).optional()}).strict()
const link=z.object({source:key,target:key,port:z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/).optional(),scope:z.array(key).max(5).optional()}).strict()
const role=z.object({name:z.string().min(1).max(100),prompt:z.string().max(100_000)}).strict()
const environment=z.object({type:z.enum(['string','number','secret']),name:z.string().max(80).regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine(s=>!['constructor','prototype','__proto__'].includes(s)),
  description:z.string().max(2000).optional(),required:z.boolean().optional(),value:z.union([z.string().max(100000),z.number().finite()]).optional()}).strict()
const coverage=z.record(z.string(),z.array(key).min(1).max(500))
const common={summary:z.string().max(10000).optional(),assumptions:z.array(z.string().max(4000)).max(50).optional(),coverage}
const byKey=<T extends z.ZodType>(value:T)=>z.record(key,value,{error:issue=>issue.code==='invalid_key'?issue.issues.map(item=>item.message).join('；'):undefined})
const chainSchema=z.object({container:key.optional(),nodes:z.array(key).min(1).max(500)}).strict()
  .refine(chain=>chain.container!==undefined||chain.nodes.length>=2,{path:['nodes'],message:'没有 container 的 chain 至少需要2个节点；容器内部用 {container, nodes:[...]}，可只有1个节点。'})
const createSchema=z.object({mode:z.literal('create'),title:z.string().min(1).max(200).refine(value=>!!value.trim(),'工作流标题不能为空白'),description:z.string().max(10000).optional(),
  nodesByKey:byKey(node),chainsByKey:byKey(chainSchema).optional(),linksByKey:byKey(link).optional(),
  rolesByKey:byKey(role).optional(),environmentByKey:byKey(environment).optional(),...common,
}).strict()
const update=z.object({description:nodeDescription.nullable().optional(),set:config.optional(),
  unset:z.array(z.string().min(1).max(100).refine(s=>!['body','constructor','prototype','__proto__'].includes(s))).max(100).optional(),
  kind:kind.optional(),title:z.string().min(1).max(200).optional()}).strict()
const editSchema=z.object({mode:z.literal('edit'),updates:byKey(update).optional(),addNodesByKey:byKey(node).optional(),removeNodes:z.array(key).max(500).optional(),
  addLinksByKey:byKey(link).optional(),removeLinks:z.array(link).max(1000).optional(),title:z.string().min(1).max(200).optional(),description:z.string().max(10000).optional(),
  addRolesByKey:byKey(role).optional(),updateRoles:byKey(role.partial()).optional(),removeRoles:z.array(key).optional(),
  addEnvironmentByKey:byKey(environment).optional(),updateEnvironment:byKey(environment.omit({type:true}).partial()).optional(),removeEnvironment:z.array(key).optional(),...common,
}).strict()
// Required planner fields come from the compiler contract. Only mode is
// inferred from the Host-bound operation; list/map names are wire aliases.
const wireRequired=(shape:Record<string,z.ZodType>,aliases:Record<string,string>={})=>Object.entries(shape).filter(([name,field])=>name!=='mode'&&!field.isOptional()).map(([name])=>aliases[name]??name)
const listFields=['nodes','chains','links','roles','environment','addNodes','addLinks','addRoles','addEnvironment'] as const
/** Normalization preserves unknown fields. Duplicate/missing keys stay in list form for repair. */
export function normalizeAuthoring(input:unknown):any{
  const result=compilerJson(input)
  if(!result||typeof result!=='object'||Array.isArray(result))return result
  for(const field of listFields){
    const rows=result[field]
    if(!Array.isArray(rows)||Object.hasOwn(result,field+'ByKey'))continue
    const keys=rows.map(row=>row?.key)
    if(keys.some(k=>typeof k!=='string'||!key.safeParse(k).success)||new Set(keys).size!==keys.length)continue
    result[field+'ByKey']=Object.fromEntries(rows.map(({key,...rest})=>[key,rest]))
    delete result[field]
  }
  return normalizeModuleDeclarations(result)
}
const str:JsonSchemaNode={type:'string'},record:JsonSchemaNode={type:'object'}
const array=(items:JsonSchemaNode):JsonSchemaNode=>({type:'array',items})
const object=(properties:Record<string,JsonSchemaNode>,required=Object.keys(properties)):JsonSchemaNode=>({type:'object',properties,required,additionalProperties:false})
const portWire:JsonSchemaNode={type:'string',description:'出口 ID 字符串，例如 "true"/"false"、case ID 或 human action ID；不能填布尔值。'}
const nodeWire=object({description:nodeDescriptionWire,key:authoringNodeKeyWire,kind:{type:'string',enum:Object.keys(NODE_LABELS)},title:str,config:record,scope:authoringScopeWire},['key','kind','config'])
const linkWire=object({key:keyWire,source:authoringNodeKeyWire,target:authoringNodeKeyWire,port:portWire,scope:authoringScopeWire},['key','source','target'])
const createLinkWire={...linkWire,required:['key','source','target','port'],description:'CREATE 仅声明分支出口；必须有合法字符串 port。普通顺序、并行分叉和汇合用 chains；scope 已弃用。'}
const chainWire=(names:JsonSchemaNode=authoringNodeKeyWire)=>object({
  container:{...authoringNodeKeyWire,description:'内部链所属 loop/iteration 节点 key；省略表示外层或兼容旧显式 scope。Host 推导嵌套 scope 并生成空 input 入口。'},
  nodes:{...array(names),description:'同层顺序节点；有 container 时至少1项，否则至少2项。if/classifier 只能作末节点；相邻节点生成 default 连线，普通分叉和汇合用多条 chains。'}},['nodes'])
const roleWire=object({key:keyWire,name:str,prompt:str})
const envWire=object({key:keyWire,type:{type:'string',enum:['string','number','secret']},name:str,description:str,required:{type:'boolean'},value:{oneOf:[str,{type:'number'}]}},['key','type','name'])
/** Schema navigation is descriptive; the full Zod/runtime validator remains authoritative. */
const configWires=new Map<string,any>()
function configContract(kind:keyof typeof NODE_LABELS,path:PropertyKey[]):JsonSchemaNode|undefined{
  try{
    if(!configWires.has(kind))configWires.set(kind,z.toJSONSchema(workflowNodeConfigSchema(kind),{unrepresentable:'any'}))
    let schema=configWires.get(kind)
    for(const part of path)schema=schema?.type==='array'?schema.items:schema?.properties?.[String(part)]??(typeof schema?.additionalProperties==='object'?schema.additionalProperties:undefined)
    if(!schema||!Object.keys(schema).length||JSON.stringify(schema).includes('"$ref"'))return undefined
    return schema
  }catch{return undefined}
}
const legalPorts=(definition:any):string[]=>definition?.kind==='if'?definition.config?.logicGate?['true','false']:definition.config?.cases?.length?[...definition.config.cases.map((row:any)=>row.id),'false']:['true','false']:
  definition?.kind==='classifier'?definition.config?.classes?.map((row:any)=>row.id)??[]:definition?.kind==='human'?['default','timeout',...(definition.config?.actions?.map((row:any)=>row.id)??['continue'])]:['default']

type CreateDraft=z.infer<typeof createSchema>
type EditDraft=z.infer<typeof editSchema>
type AuthoringDraft=CreateDraft|EditDraft
type DraftNode=z.infer<typeof node>
type DraftRole=z.infer<typeof role>
type DraftEnvironment=z.infer<typeof environment>
type HostEdge={source:string,target:string}
interface TopologyFrame {
  value:AuthoringDraft; nodes:Record<string,DraftNode>; issues:CompilerIssue[]
  view:ReturnType<typeof planningEditView>; existing:Map<string,ReturnType<typeof planningEditView>['nodes'][number]>
  knownNames:string[]; containers:string[]; scopeContract:JsonSchemaNode; chainContract:JsonSchemaNode; typedLink:JsonSchemaNode; linksContract:JsonSchemaNode
  definitionFor(name:string):any; branchSource(name:string):boolean; endpointScope(name:string):string
}
/** Known map keys plus eight fresh repair slots. */
const repairSlots=(keys:readonly string[],prefix:string)=>[...new Set([...keys,...Array.from({length:8},(_,index)=>prefix+(index+1))])]
/** Typed guidance for listed keys; the map stays open because the native SDK has only boolean additionalProperties. */
const openMap=(keys:readonly string[],contract:JsonSchemaNode):JsonSchemaNode=>({...object(Object.fromEntries(keys.map(key=>[key,contract])),[]),additionalProperties:true})
const updatedConfig=(config:Record<string,unknown>,change:{set?:Record<string,unknown>;unset?:string[]})=>{
  const merged={...config,...change.set};for(const field of change.unset??[])delete merged[field]
  return merged
}
/** Output field names an upstream declaration offers as code input candidates. */
const outputFieldNames=(node:any):unknown[]=>[
  ...Object.keys(NODE_SEMANTICS[node.kind as keyof typeof NODE_LABELS]?.outputs??{})
    .filter(field=>node.kind!=='http'||!['json',...(node.config?.credentialOperation?['text','body','bytes','status_code','headers']:['ok'])].includes(field)),
  ...(Array.isArray(node.config?.outputSchema)?node.config.outputSchema:[]).map((field:any)=>field?.name),
  ...(node.kind==='input'&&Array.isArray(node.config?.fields)?node.config.fields:[]).map((field:any)=>field?.name),
]
const edgeScopeMessage=(path:string,source:string,sourceScope:string,target:string,targetScope:string)=>
  `${path} 的连线 ${source}(scope=${sourceScope}) → ${target}(scope=${targetScope}) 跨越了 scope；连线两端必须在同一层。`+
  `外层节点不能直接连入容器内部节点：外层只连接容器本身，容器内部由同 scope 的 input 节点作为入口连接内部节点。请删除或改写 ${path}。`
const scopeMismatchMessage=(path:string,explicit:string,source:string,target:string,sourceScope:string)=>
  `${path} 的 scope=${explicit} 与端点 ${source}、${target} 的 scope=${sourceScope} 不一致；改为 ${sourceScope} 或省略 scope。`
const createContainerMessage=(name:string,scope:string[])=>
  `容器 ${name} 的内部没有节点；添加 {container:${JSON.stringify(name)},nodes:[内部节点key]} chain（至少1项）。`+
  `内部节点与容器同列声明，无需 scope；Host 自动推导 scope=${JSON.stringify(scope)}，并在缺 input 时生成 config:{fields:[]} 入口和到所有无上游节点的连线；不要手写 repairNode 入口。`+
  '不要填写 config.body；将 body 中业务节点改为独立声明并通过 container chain 排序，outputVariable 和 coverage 引用业务节点 key，Host 入口不需要 coverage。'+
  '使用反馈的独立节点与 chain 路径；add /nodesByKey 或 /chainsByKey 会替换整张映射。'
const editContainerMessage=(name:string,scope:string[])=>
  `容器 ${name} 的内部节点必须与容器同列声明，scope=${JSON.stringify(scope)}；不要填写 config.body。`+
  '每层运行图必须有且只有一个 input（可用 config:{fields:[]}），并用 chain/links 连接到内部 template；只有 template 的子图不能运行。'+
  '内部节点用其声明 key 寻址，outputVariable 和 coverage 均可引用。将 body.nodes 的 id 改为声明 key，body.edges 改为 chains/links，删除 body 时同时保留这些声明。'+
  '修复使用 nodesByKey 下反馈给出的独立节点路径；add /nodesByKey 或 /chainsByKey 会替换整张映射，不能用它追加单项。'
const aliasRef=(maps:PlanningAliases,name:string,kind:keyof PlanningAliases='nodes')=>{
  const ref=maps[kind].get(name)
  if(!ref)throw new CompilerError('UNKNOWN_REFERENCE','不存在的创作引用 '+name)
  return ref
}
const aliasScope=(maps:PlanningAliases,path:string[]|undefined)=>(path??[]).map(name=>aliasRef(maps,name))
const hostConfig=(maps:PlanningAliases,config:Record<string,unknown>,kind:any,locals?:ReadonlySet<string>)=>rewritePlanningConfig(config,maps,false,kind,'',locals)

/** Remove only a redundant implicit branch edge whose explicit route already states intent. */
export function uniqueExplicitBranchRepairs(document:any,issues:CompilerIssue[]):UniqueRepair|undefined{
  if(document?.mode!=='create'||!issues.length||issues.some(issue=>issue.code!=='BRANCH_PORT'))return undefined
  const nodes=document.nodesByKey??document.formsByKey,links=Object.values(document.linksByKey??{}) as any[]
  if(!nodes)return undefined
  const keys=[...new Set(issues.map(issue=>issue.path&&pointerParts(issue.path)[1]).filter((key):key is string=>!!key))]
  const patches:UniqueRepair['patches']=[]
  for(const key of keys){
    const chain=document.chainsByKey?.[key],segments:string[][]=[]
    if(!chain?.nodes)return undefined
    let segment=[chain.nodes[0]]
    for(let index=1;index<chain.nodes.length;index++){
      const source=chain.nodes[index-1],target=chain.nodes[index],raw=nodes[source],definition=raw&&{kind:raw.kind??raw.template,config:raw.config??raw.values}
      if(['if','classifier'].includes(definition?.kind)){
        const explicit=links.filter(edge=>edge.source===source&&edge.target===target&&JSON.stringify(edge.scope??[])===JSON.stringify(raw.scope??[]))
        if(!explicit.length||explicit.some(edge=>typeof edge.port!=='string'||!legalPorts(definition).includes(edge.port)))return undefined
        if(segment.length>=(chain.container?1:2))segments.push(segment)
        segment=[target]
      }else segment.push(target)
    }
    if(segment.length>=(chain.container?1:2))segments.push(segment)
    // Replacing the existing chain is always in its authorized repair region.
    // Further segments need new keys outside that region, so refuse that case.
    if(segments.length>1)return undefined
    patches.push(segments.length?{op:'replace',path:pointer(['chainsByKey',key]),value:{...chain,nodes:segments[0]}}:{op:'remove',path:pointer(['chainsByKey',key])})
  }
  return patches.length?{patches,reason:'仅移除已由相同端点、合法显式出口声明的冗余隐式分支边；其余顺序边保持不变。'}:undefined
}
export interface AuthoringOptions {
  /** Explicit request.title, never inferred from the scaffold or requirement text. CREATE only. */
  requestedTitle?:string
  /** Host-derived explicit v2 obligations; never supplied by model output or contextSelection. */
  completion?:PlanningCompletionPlan
  requiredCoverageIds?:readonly string[]
  validate?(candidate:Workflow,output:PlannerOutput):PlanningIssue[]
  onSubmission?:ConstructorParameters<typeof RepairSession>[1]['onSubmission']
  maxSubmissions?:number
}
export type CompiledAuthoring=ReturnType<typeof compilePlanningEdits>
type FragmentExpansion=ReturnType<typeof expandModuleFragments>

/** Shared materializer. Owns stable Host bindings, never submission state, IO or execution. */
export class AuthoringCore {
  private readonly context:PlanningContext
  private readonly refs=new Map<string,string>()
  private readonly scopes=new Map<string,string[]>()
  private readonly reservations:PlanningAliases={nodes:new Map(),agents:new Map(),environment:new Map()}
  private readonly required:readonly string[]
  readonly schema:ObjectJsonSchema
  readonly instructions:string
  private readonly titleContract:JsonSchemaNode
  /** A CREATE title is fixed by the request; an omitted one is filled, never replaced. */
  withRequestedTitle(input:unknown):unknown{
    const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
    const title=this.options.requestedTitle
    if(this.context.operation!=='create'||title===undefined||!record(input))return input
    const inner=record(input.submission)?input.submission:input
    if(inner.mode!=='create'||Object.hasOwn(inner,'title'))return input
    return inner===input?{...input,title}:{...input,submission:{...inner,title}}
  }
  constructor(context:PlanningContext,private readonly options:AuthoringOptions={}){
    this.context=structuredClone(context);this.required=[...(options.requiredCoverageIds??['R1'])]
    this.titleContract=context.operation==='create'&&options.requestedTitle!==undefined?{type:'string',const:options.requestedTitle}:str
    const view=planningEditView(this.context,this.context.workflow,false)
    this.bindBase(context,view)
    const cov=object(Object.fromEntries(this.required.map(id=>[id,array(authoringNodeKeyWire)])))
    const shared={coverage:cov,summary:str,assumptions:array(str)}
    const create=this.createWire(shared),edit=this.editWire(context,view,shared)
    this.schema=submissionSchema(context.operation==='create'?create:edit,needsInputWireSchema)
    this.instructions=(context.operation==='create'?AUTHORING_TITLE_GUIDANCE:'')+
      '提交精简创作声明，Host 编译为当前 Workflow。create 使用 nodes 列表与 chains/links；edit 只提交变化，例如 updates:{n2:{set:{text:"新文本"}}}，删除字段用 unset。'+
      'config 使用当前词典字段，引用 {{format.text}} 或 {{n2.text}}，不加 + 或 @。'+
      '不填写 UUID/baseDigest/body。coverage 必须逐项映射真实节点。'+
      '已有草稿时需要修复只提交 {submission:{mode:"repair",draftRevision:反馈版本,patches:[...]}}；draftRevision=0 表示尚无草稿，须更正后重新提交 create/edit，不能 repair。'+
      '一次修完反馈中的全部错误，不再重交声明。nodesByKey 是 Host 修复视图，不是首次提交字段。'+
      '缺关键信息用 mode=needs-input。'+CANONICAL_INPUT_GUIDANCE+CANONICAL_TEMPLATE_GUIDANCE+AUTHORING_NODE_KEY_GUIDANCE+AUTHORING_TOPOLOGY_GUIDANCE+MODULE_FRAGMENT_GUIDANCE
  }
  /** Binds stable Host refs: CREATE exposes only the scaffold ends, EDIT every existing node. */
  private bindBase(context:PlanningContext,view:ReturnType<typeof planningEditView>):void{
    if(context.operation==='create'){
      if(context.workflow.revision!==0)throw new CompilerError('COMPILER_CREATE_BASE','create 只能绑定未发布基线',undefined,true)
      // The scaffold is addressable only as start/result, so n1/n2 stay free for new business nodes.
      const start=view.nodes.find(n=>n.kind==='input'&&!n.scope.length),end=view.nodes.find(n=>n.kind==='output'&&!n.scope.length)
      if(start){this.refs.set('start',start.ref);this.scopes.set('start',[])}
      if(end){this.refs.set('result',end.ref);this.scopes.set('result',[])}
    }else for(const n of view.nodes){const name='n'+n.ref.slice(1);this.refs.set(name,n.ref);this.scopes.set(name,n.scope.map(ref=>'n'+ref.slice(1)))}
  }
  private createWire(shared:Record<string,JsonSchemaNode>):JsonSchemaNode{
    const chainKey={...keyWire,description:'顺序连线段的标签；chain key 不创建节点或容器 scope。'}
    const chains=array({...chainWire(),properties:{key:chainKey,...(chainWire() as any).properties},required:['key','nodes']})
    return object({mode:{type:'string',const:'create'},title:this.titleContract,description:str,nodes:array(nodeWire),modules:fragmentContract(),
      chains,links:array(createLinkWire),roles:array(roleWire),environment:array(envWire),...shared},wireRequired(createSchema.shape,{nodesByKey:'nodes'}))
  }
  /** Exposes only editable target nodes and verified module instances; fixed nodes keep only their description slot. */
  private editWire(context:PlanningContext,view:ReturnType<typeof planningEditView>,shared:Record<string,JsonSchemaNode>):JsonSchemaNode{
    const internal=new Set(verifiedModuleInstances(context.workflow).flatMap(r=>Object.values(r.roles)))
    const nodeIds=allNodes(context.workflow).map(n=>n.id)
    const editable=view.nodes.filter(n=>!internal.has(nodeIds[Number(n.ref.slice(1))-1]!)&&(!view.targetNodeRefs.length||view.targetNodeRefs.includes(n.ref)))
    const moduleRefs=moduleInstanceRefs(context.workflow)
    const moduleWire=(r:ReturnType<typeof verifiedModuleInstances>[number])=>object({parameters:fragmentModules.find(m=>m.id===r.moduleId&&m.version===r.version)!.parameterWire})
    const moduleUpdates=object(Object.fromEntries(verifiedModuleInstances(context.workflow).map(r=>[moduleRefs.get(r.instanceKey)!,moduleWire(r)])),[])
    const updateWire=object({description:updateDescriptionWire,set:record,unset:array(str),kind:{type:'string',enum:Object.keys(NODE_LABELS)},title:str},[])
    const updates=object(Object.fromEntries(editable.map(n=>['n'+n.ref.slice(1),view.fixedNodeRefs.includes(n.ref)?object({description:updateDescriptionWire},[]):updateWire])),[])
    const removeModules=array(verifiedModuleInstances(context.workflow).length?{type:'string',enum:[...moduleRefs.values()]}:str)
    const removeLink=object({source:authoringNodeKeyWire,target:authoringNodeKeyWire,port:portWire,scope:authoringScopeWire},['source','target'])
    return object({mode:{type:'string',const:'edit'},updates,
      addModules:fragmentContract(),updateModules:moduleUpdates,removeModules,addNodes:array(nodeWire),removeNodes:array(authoringNodeKeyWire),addLinks:array(linkWire),removeLinks:array(removeLink),
      title:str,description:str,addRoles:array(roleWire),updateRoles:record,removeRoles:array(keyWire),addEnvironment:array(envWire),updateEnvironment:record,removeEnvironment:array(keyWire),...shared},
      wireRequired(editSchema.shape))
  }
  initialSchema(){return completionNextSchema(this.schema,this.options.completion,'set')}
  normalize(input:unknown):any {
    const document=normalizeAuthoring(input)
    if(document&&typeof document==='object'&&!Array.isArray(document)&&!Object.hasOwn(document,'mode'))document.mode=this.context.operation==='create'?'create':'edit'
    if(this.options.completion&&document?.mode==='edit'&&!Object.hasOwn(document,'updates'))document.updates={}
    return document
  }
  /** Serializable copy of the draft-key → Host ID reservations. */
  exportReservations():PlanningReservations{
    return {nodes:Object.fromEntries(this.reservations.nodes),agents:Object.fromEntries(this.reservations.agents),environment:Object.fromEntries(this.reservations.environment)}
  }
  /** Restores checkpointed reservations, accepting only unused IDs from the current Host pools. */
  importReservations(value:PlanningReservations|undefined):void{
    const pools={
      nodes:[this.context.nodeIds,allNodes(this.context.workflow).map(n=>n.id),/^\+[A-Za-z][A-Za-z0-9_-]{0,39}$/],
      agents:[this.context.subagentIds,(this.context.workflow.subAgents??[]).map(x=>x.id),/^\+a:[A-Za-z][A-Za-z0-9_-]{0,39}$/],
      environment:[this.context.environmentIds,(this.context.workflow.environmentVariables??[]).map(x=>x.id),/^\+e:[A-Za-z][A-Za-z0-9_-]{0,39}$/],
    } as const
    for(const kind of ['nodes','agents','environment'] as const){
      const [pool,used,ref]=pools[kind],entries=Object.entries(value?.[kind]??{})
      if(entries.some(([name,id])=>!ref.test(name)||!pool.includes(id)||used.includes(id)))throw new CompilerError('COMPILER_RESUME_CONFLICT','恢复检查点的身份预留不属于当前 Host 身份池',undefined,true)
      this.reservations[kind].clear();for(const[name,id]of entries)this.reservations[kind].set(name,id)
    }
  }
  private reserve(reservations:PlanningAliases,kind:keyof PlanningAliases,ref:string,pool:string[],used:readonly string[]):void{
    if(reservations[kind].has(ref))return
    const taken=new Set([...used,...reservations[kind].values()]),id=pool.find(id=>!taken.has(id))
    if(!id)throw new CompilerError('COMPILER_ID_POOL','Host 身份池已耗尽',undefined,true)
    reservations[kind].set(ref,id)
  }
  private maps(nodes:Record<string,unknown>,roles:Record<string,unknown>,env:Record<string,unknown>):PlanningAliases{
    const maps:PlanningAliases={nodes:new Map(this.refs),agents:new Map(),environment:new Map()}
    // Bind only identities still declared by this draft. Removed failed keys
    // release their slots, while surviving keys retain their original Host IDs.
    // Allocate all pools on copies so exhaustion cannot partially commit bindings.
    const active={nodes:new Set(Object.keys(nodes).map(name=>'+'+name)),agents:new Set(Object.keys(roles).map(name=>'+a:'+name)),environment:new Set(Object.keys(env).map(name=>'+e:'+name))}
    const retained=(kind:keyof PlanningAliases)=>new Map([...this.reservations[kind]].filter(([ref])=>active[kind].has(ref)))
    const reservations:PlanningAliases={nodes:retained('nodes'),agents:retained('agents'),environment:retained('environment')}
    const view=planningEditView(this.context,this.context.workflow,false)
    for(const row of view.subAgents)maps.agents.set('r'+row.ref.slice(2),row.ref)
    for(const row of view.environmentVariables)maps.environment.set('e'+row.ref.slice(2),row.ref)
    const nodeIds=allNodes(this.context.workflow).map(n=>n.id)
    for(const name of Object.keys(nodes))if(!this.refs.has(name)){
      maps.nodes.set(name,'+'+name);this.reserve(reservations,'nodes','+'+name,this.context.nodeIds,nodeIds)
    }
    for(const name of Object.keys(roles)){
      if(maps.agents.has(name))throw new CompilerError('DUPLICATE_KEY','角色 key 已存在')
      maps.agents.set(name,'+a:'+name);this.reserve(reservations,'agents','+a:'+name,this.context.subagentIds,(this.context.workflow.subAgents??[]).map(x=>x.id))
    }
    for(const name of Object.keys(env)){
      if(maps.environment.has(name))throw new CompilerError('DUPLICATE_KEY','环境 key 已存在')
      maps.environment.set(name,'+e:'+name);this.reserve(reservations,'environment','+e:'+name,this.context.environmentIds,(this.context.workflow.environmentVariables??[]).map(x=>x.id))
    }
    for(const kind of ['nodes','agents','environment'] as const){this.reservations[kind].clear();for(const[ref,id]of reservations[kind])this.reservations[kind].set(ref,id)}
    return maps
  }
  compile(document:any):CompiledAuthoring{
    const expansion=expandModuleFragments(document,fragmentModules,this.context.workflow)
    bindFragmentKeys(expansion)
    let result:CompiledAuthoring
    try { result=this.compileExpanded(expansion.document,new Set(expansion.owners.keys())) }
    catch(error){
      if(!expansion.owners.size)throw error
      throw new FragmentIssues(this.fragmentIssues(error,expansion))
    }
    if(result.candidate)this.attachModuleInstances(result,result.candidate,expansion)
    return result
  }
  /** Fragment-internal diagnostics are reported at the owning module declaration. */
  private fragmentIssues(error:unknown,expansion:FragmentExpansion):CompilerIssue[]{
    return this.diagnose(error,expansion.document).map(issue=>{
      const paths=[issue.path,...issue.allowedPaths].filter((p):p is string=>!!p)
      const owner=paths.map(p=>expansion.owners.get(pointerParts(p)[1]??'')).find(Boolean)
      if(owner){
        const message='模块参数或接入不合法：'+issue.message.replaceAll(/\b[A-Za-z][A-Za-z0-9_-]*__[A-Za-z][A-Za-z0-9_-]*\b/g,'片段内部节点')
        return {...issue,path:owner,allowedPaths:[owner],contracts:undefined,expected:undefined,message}
      }
      // Report the author's chain position and module key, not the expansion's (Desktop r55 C).
      const at=(p:string)=>authoredChainPath(expansion.chains,p),declared=<T,>(name:T):T=>{const owner=typeof name==='string'?expansion.owners.get(name):undefined;return owner?pointerParts(owner)[1] as T:name}
      const names=<T,>(list:T[])=>[...new Set(list.map(declared))]
      const expected=Array.isArray(issue.expected?.enum)?{...issue.expected,enum:names(issue.expected.enum)}:issue.expected
      return {...issue,...(issue.path?{path:at(issue.path)}:{}),...(expected?{expected}:{}),...(issue.candidates?{candidates:names(issue.candidates)}:{}),
        ...(issue.contracts?{contracts:Object.fromEntries(Object.entries(issue.contracts).map(([p,c])=>[at(p),c]))}:{}),
        allowedPaths:[...new Set(issue.allowedPaths.filter(p=>![...expansion.owners.keys()].some(k=>p.includes('/'+k))).map(at))]}
    })
  }
  /** Records expanded module instances against the compiled candidate and its persisted graph. */
  private attachModuleInstances(result:CompiledAuthoring,candidate:NonNullable<CompiledAuthoring['candidate']>,expansion:FragmentExpansion):void{
    const ids=new Map<string,string>(),refs=planningNodeRefs(this.context.workflow)
    for(const[id,ref]of refs)ids.set('n'+ref.slice(1),id)
    if(this.context.operation==='create')for(const[key,ref]of this.refs){const id=[...refs].find(([,r])=>r===ref)?.[0];if(id)ids.set(key,id)}
    for(const[ref,id]of this.reservations.nodes)ids.set(ref.slice(1),id)
    const records=(this.context.workflow.moduleInstances??[]).filter(r=>!expansion.removed.has(r.instanceKey)&&!expansion.instances.some(i=>i.key===r.instanceKey))
    const locations=new Map<string,string[]>()
    const visit=(g:import('./types.ts').NodeGraph,scope:string[])=>{for(const n of g.nodes){locations.set(n.id,scope);if(n.config.body)visit(n.config.body,[...scope,n.id])}};visit(candidate,[])
    for(const instance of expansion.instances){
      const roles=Object.fromEntries(Object.entries(instance.roles).map(([r,key])=>[r,ids.get(key)!])),parameters=rewriteFragmentParameters(instance.parameters,ids)
      records.push({instanceKey:instance.key,moduleId:instance.module.id,version:instance.module.version,implementationDigest:instance.module.implementationDigest,
        parameters,parametersDigest:jsonDigest(parameters),roles,scope:locations.get(roles[instance.module.recipe(instance.parameters).entry]!)??[],
        edges:instanceEdges(candidate,new Set(Object.values(roles)))})
    }
    if(records.length||this.context.workflow.moduleInstances!==undefined)candidate.moduleInstances=records
    // The persisted output is consumed by the ordinary Host materializer too.
    const graph=JSON.parse(result.output.graphJson)
    if(candidate.moduleInstances!==undefined)graph.moduleInstances=candidate.moduleInstances
    result.output.graphJson=JSON.stringify(graph)
  }
  private compileExpanded(document:any,internalKeys:Set<string>):CompiledAuthoring{
    if(document?.mode==='needs-input'){
      const input=needsInputSchema.parse(document)
      return compilePlanningEdits({baseDigest:planningEditDigest(this.context.workflow),outcome:'needs-input',summary:input.summary,questions:input.questions},this.context)
    }
    if(document?.mode!==this.context.operation.replace('revise','edit'))throw new CompilerError('COMPILER_MODE','提交模式与绑定任务不符',undefined,true)
    const value=this.parseDraft(document)
    if(value.mode==='edit'&&this.options.completion?.entries.some(entry=>value.updates?.[entry.key]?.unset?.includes(entry.field)))
      throw new CompilerError('COMPLETION_REPAIR_UNAVAILABLE','该草稿显式删除了必须提供的字段；不能扩大局部修复范围',undefined,true)
    const create=value.mode==='create'
    const nodes=create?value.nodesByKey:(value.addNodesByKey??{}),roles=create?(value.rolesByKey??{}):(value.addRolesByKey??{}),env=create?(value.environmentByKey??{}):(value.addEnvironmentByKey??{})
    this.checkDeclarations(nodes,env,create)
    this.checkNodeConfigs(value,nodes)
    const generated=this.checkTopology(document,value,nodes)
    const maps=this.maps(nodes,roles,env),edits=this.draftEdits(value,nodes,roles,env,maps,generated)
    const coverageKeys=Object.keys(value.coverage)
    if(coverageKeys.length!==this.required.length||this.required.some(id=>!coverageKeys.includes(id)))
      throw new CompilerError('REQUIREMENT_COVERAGE','coverage 必须包含 '+this.required.join(', '),'/coverage')
    const result=compilePlanningEdits({baseDigest:planningEditDigest(this.context.workflow),outcome:'candidate',edits:[...edits.filter(e=>e.op==='disconnect'),...edits.filter(e=>e.op!=='disconnect')],
      ...(value.summary!==undefined?{summary:value.summary}:{}),...(value.assumptions!==undefined?{assumptions:value.assumptions}:{}),
      requirementCoverage:Object.entries(value.coverage).map(([requirementId,keys])=>({requirementId,nodeIds:keys.map(name=>aliasRef(maps,name))}))},
    this.context,this.context.workflow,this.reservations,'host-compiled')
    const issues=[...result.issues,...(result.candidate?this.options.validate?.(result.candidate,result.output)??[]:[])]
    if(issues.length)throw new AuthoringIssues(issues)
    return result
  }
  /** Shape validation. A CREATE title error never hides other field diagnostics of the same round. */
  private parseDraft(document:any):AuthoringDraft{
    let titleIssues:CompilerIssue[]=[]
    if(this.context.operation==='create'){
      // Use the advertised field contract even for direct compiler/repair calls.
      const title=Object.hasOwn(document,'title')?{title:document.title}:{}
      const issues=submissionSchemaIssues(object({title:this.titleContract}),title)
      const requested=Object.hasOwn(this.titleContract,'const')?'，必须等于请求名称 '+JSON.stringify(this.titleContract.const):''
      titleIssues=issues.map(issue=>({...issue,path:'/title',allowedPaths:['/title'],expected:this.titleContract,
        message:'CREATE 工作流级 title 必须是字符串且不可省略'+requested+'；按字段合同修复 /title。'}))
    }
    const parsed=this.context.operation==='create'?createSchema.safeParse(document):editSchema.safeParse(document)
    if(!parsed.success){
      if(!titleIssues.length)throw parsed.error
      // Preserve all other shape/key diagnostics and their repair paths. A title
      // error must not hide fields that need fixing in the same bounded round.
      const others=parsed.error.issues.filter(issue=>issue.path[0]!=='title')
      throw new AuthoringFields([...titleIssues,...(others.length?this.diagnose(new z.ZodError(others),document):[])])
    }
    if(titleIssues.length)throw new AuthoringFields(titleIssues)
    return parsed.data
  }
  /** Declaration limits and identity collisions; each is a single blocking error. */
  private checkDeclarations(nodes:Record<string,DraftNode>,env:Record<string,DraftEnvironment>,create:boolean):void{
    if(Object.keys(nodes).length>500)throw new CompilerError('COMPILER_NODE_LIMIT','最多 500 个节点',undefined,true)
    if(!create&&Object.keys(nodes).some(name=>this.refs.has(name)))throw new CompilerError('DUPLICATE_KEY','新增节点 key 与已有节点重名')
    for(const definition of Object.values(env))if(definition.type==='secret'&&Object.hasOwn(definition,'value'))throw new CompilerError('COMPILER_FORBIDDEN','Secret 声明不得包含值',undefined,true)
    const bound=Object.keys(nodes).filter(name=>this.refs.has(name))
    const collisions=bound.filter((name,index)=>bound.some((other,j)=>j!==index&&this.refs.get(other)===this.refs.get(name)))
    if(collisions.length)throw new CompilerError('DUPLICATE_KEY','多个 key 绑定了同一个已有节点：'+collisions.join('、')+
      '。edit 不能用已有节点的 n1/n2 声明新节点；请给新节点换 key，并同步 chains/links、配置引用和 coverage。')
  }
  /** Every declared or updated config against its node kind's field contract, collected in one round. */
  private checkNodeConfigs(value:AuthoringDraft,nodes:Record<string,DraftNode>):void{
    const create=value.mode==='create',fieldIssues:CompilerIssue[]=[]
    const validateConfig=(definition:any,path:string)=>{
      const checked=workflowNodeConfigSchema(definition.kind).safeParse(definition.config)
      if(!checked.success)for(const issue of checked.error.issues){
        const local=path+pointer(issue.path.map(String)),expected=configContract(definition.kind,issue.path)
        const allowedPaths=issue.code==='unrecognized_keys'?issue.keys.map(key=>local+pointer([key])):[local]
        fieldIssues.push({code:'INVALID_NODE_CONFIG',message:issue.message,path:local,...(expected?{expected}:{}),...(issue.code==='invalid_value'?{candidates:issue.values}:{}),allowedPaths})
      }
    }
    for(const[name,definition]of Object.entries(nodes))validateConfig(definition,pointer([create?'nodesByKey':'addNodesByKey',name,'config']))
    if(!create)for(const[name,change]of Object.entries(value.updates??{})){
      const old=planningEditView(this.context,this.context.workflow,false).nodes.find(n=>n.ref===this.refs.get(name))
      if(old)validateConfig({kind:change.kind??old.kind,config:updatedConfig(old.config,change)},pointer(['updates',name,'set']))
    }
    if(fieldIssues.length)throw new AuthoringFields(fieldIssues)
  }
  /** Topology checks independent of materialization; may add Host container entries to nodes. */
  private checkTopology(document:any,value:AuthoringDraft,nodes:Record<string,DraftNode>):HostEdge[]{
    // These checks are independent of materialization. Collect both scope and
    // implicit branch-edge errors before resolve() can hide the latter behind
    // the first unknown scope. Final graph/authority validation remains below.
    const frame=this.topologyFrame(value,nodes)
    this.checkLinkReferences(frame)
    this.checkScopes(frame)
    const generated=this.addContainerEntries(document,frame)
    this.checkEdgeScopes(frame)
    this.checkCodeInputs(frame)
    if(frame.issues.length)throw new AuthoringFields(frame.issues)
    return generated
  }
  private topologyFrame(value:AuthoringDraft,nodes:Record<string,DraftNode>):TopologyFrame{
    const create=value.mode==='create'
    const view=planningEditView(this.context,this.context.workflow,false),existing=new Map(view.nodes.map(n=>[n.ref,n]))
    const knownNames=[...new Set([...Object.keys(nodes),...this.refs.keys()])]
    const definitionFor=(name:string)=>{
      const definition=nodes[name]??existing.get(this.refs.get(name)??'')
      return !create&&value.updates?.[name]?{...definition,kind:value.updates[name].kind??definition?.kind,config:{...definition?.config,...value.updates[name].set}}:definition
    }
    const containers=knownNames.filter(name=>['loop','iteration'].includes(definitionFor(name)?.kind??''))
    const scopeContract:JsonSchemaNode={type:'array',...(containers.length?{items:{type:'string',enum:containers},maxItems:5}:{maxItems:0})}
    const chainContract=chainWire({type:'string',enum:knownNames})
    // The installed native SDK supports only boolean additionalProperties.
    // Known map entries provide typed guidance; fresh keys must remain open.
    // The compiler validates every entry, including keys not in this draft.
    const branchSource=(name:string)=>['if','classifier','human'].includes(definitionFor(name)?.kind??'')
    const linkRequired=create?['source','target','port']:['source','target']
    const repairLink=object({source:{type:'string',enum:knownNames},target:{type:'string',enum:knownNames},port:{type:'string'},scope:scopeContract},linkRequired)
    const linkChoice=(name:string)=>
      object({source:{type:'string',const:name},target:{type:'string',enum:knownNames},port:{type:'string',enum:legalPorts(definitionFor(name))},scope:scopeContract},linkRequired)
    const linkChoices=knownNames.filter(name=>!create||branchSource(name)).map(name=>linkChoice(name))
    const typedLink=linkChoices.length>1?{oneOf:linkChoices}:linkChoices[0]??repairLink
    const linksContract=openMap(repairSlots(Object.keys((create?value.linksByKey:value.addLinksByKey)??{}),'repair'),typedLink)
    const endpointScope=(name:string)=>JSON.stringify(nodes[name]?.scope??this.scopes.get(name)??[])
    return {value,nodes,issues:[],view,existing,knownNames,containers,scopeContract,chainContract,typedLink,linksContract,definitionFor,branchSource,endpointScope}
  }
  /** Declared references, CREATE branch-only links and legal ports. */
  private checkLinkReferences(t:TopologyFrame):void{
    const {value,knownNames,issues}=t,create=value.mode==='create'
    const checkReference=(name:string,path:string)=>{
      if(!knownNames.includes(name))issues.push({code:'UNKNOWN_REFERENCE',message:'不存在的创作引用 '+name,path,expected:{type:'string',enum:knownNames},candidates:knownNames,allowedPaths:[path]})
    }
    for(const[name,edge]of Object.entries(create?value.linksByKey??{}:value.addLinksByKey??{})){
      const root=create?'linksByKey':'addLinksByKey',linkPath=pointer([root,name])
      checkReference(edge.source,pointer([root,name,'source']));checkReference(edge.target,pointer([root,name,'target']))
      const source=t.definitionFor(edge.source),ports=legalPorts(source)
      if(create&&edge.port===undefined){
        const chains=openMap(repairSlots(Object.keys(value.chainsByKey??{}),'repair'),t.chainContract)
        issues.push({code:'LINK_PORT_REQUIRED',message:'CREATE links 必须填写分支出口 port；普通顺序、并行分叉和汇合请改用 chain 表达顺序。',path:linkPath,
          contracts:{[linkPath]:t.typedLink,'/chainsByKey':chains},allowedPaths:[linkPath,'/chainsByKey']})
      }else if(create&&source&&!t.branchSource(edge.source)){
        const chains=openMap(repairSlots(Object.keys(value.chainsByKey??{}),'repair'),t.chainContract)
        issues.push({code:'LINK_SOURCE_PORT',message:'CREATE links 仅用于 if/classifier/human 的分支出口；此源节点没有分支出口，请改用 chain 表达顺序。',path:linkPath,
          allowedPaths:[linkPath,'/chainsByKey'],contracts:{'/chainsByKey':chains}})
      }
      if(source&&edge.port!==undefined&&!ports.includes(edge.port))issues.push({code:'INVALID_PORT',message:'显式连线出口无效；需要按业务意图选择合法出口',path:pointer([root,name,'port']),
        expected:{type:'string',enum:ports},candidates:ports,allowedPaths:[pointer([root,name,'port'])]})
    }
    if(create)for(const[name,chain]of Object.entries(value.chainsByKey??{}))for(const[index,reference]of chain.nodes.entries())checkReference(reference,pointer(['chainsByKey',name,'nodes',index]))
    for(const[id,references]of Object.entries(value.coverage))for(const[index,reference]of references.entries())checkReference(reference,pointer(['coverage',id,index]))
  }
  /** Explicit node/link scopes must list actual ancestor containers; CREATE scopes are inferred first. */
  private checkScopes(t:TopologyFrame):void{
    const {value,nodes,existing,containers,scopeContract,issues}=t,create=value.mode==='create'
    const checkScope=(path:string[]|undefined,location:string)=>{
      for(const [index,name]of (path??[]).entries()){
        const definition=nodes[name]??existing.get(this.refs.get(name)??''),effectiveKind=!create?value.updates?.[name]?.kind??definition?.kind:definition?.kind,issuePath=location+'/'+index
        let message:string|undefined,code='INVALID_SCOPE'
        if(!definition){
          code='UNKNOWN_REFERENCE'
          message=Object.hasOwn(create?value.chainsByKey??{}:{},name)?`scope 中 ${name} 是 chain key，不是容器节点；根层省略 scope 或用 []。`:
            `scope 中不存在容器节点 ${name}；请使用祖先 loop/iteration 节点 key，根层省略或用 []。`
        }
        else if(!['loop','iteration'].includes(effectiveKind!))message=`scope 中 ${name} 不是 loop/iteration 容器节点；chain key 也不能作为 scope。`
        else if(JSON.stringify(nodes[name]?.scope??this.scopes.get(name)??[])!==JSON.stringify(path!.slice(0,index)))message=`scope 中容器 ${name} 的祖先路径不匹配；按从外到内填写实际容器节点。`
        if(message)issues.push({code,message,path:issuePath,...(containers.length?{expected:{type:'string',enum:containers} as JsonSchemaNode,candidates:containers}:{}),
          contracts:{[location]:scopeContract},allowedPaths:[location]})
      }
    }
    if(create)this.inferScopes(value,issues,t.chainContract)
    for(const[name,definition]of Object.entries(nodes))checkScope(definition.scope,pointer([create?'nodesByKey':'addNodesByKey',name,'scope']))
    for(const[name,edge]of Object.entries(create?value.linksByKey??{}:value.addLinksByKey??{}))checkScope(edge.scope,pointer([create?'linksByKey':'addLinksByKey',name,'scope']))
  }
  /** CREATE gives each container without an input a Host entry wired to its unlinked nodes; otherwise reports the container. */
  private addContainerEntries(document:any,t:TopologyFrame):HostEdge[]{
    const {value,nodes,issues}=t,create=value.mode==='create',generated:HostEdge[]=[]
    for(const[name,definition]of Object.entries(nodes))if(['iteration','loop'].includes(definition.kind)){
      const childScope=[...(definition.scope??[]),name],children=Object.entries(nodes).filter(([,child])=>JSON.stringify(child.scope??[])===JSON.stringify(childScope))
      if(create){
        if(!children.length)issues.push(this.containerRepair(document,name,'CONTAINER_ENTRY',childScope))
        else if(!children.some(([,child])=>child.kind==='input')){
          let index=1;while(Object.hasOwn(nodes,'hostEntry'+index)||this.refs.has('hostEntry'+index))index++
          const entry='hostEntry'+index
          nodes[entry]={kind:'input',config:{fields:[]},scope:childScope}
          const incoming=new Set(Object.values(value.linksByKey??{}).map(edge=>edge.target))
          for(const chain of Object.values(value.chainsByKey??{}))for(const target of chain.nodes.slice(1))incoming.add(target)
          for(const[target]of children)if(!incoming.has(target))generated.push({source:entry,target})
        }
      }else if(!children.some(([,child])=>child.kind==='input'))issues.push(this.containerRepair(document,name,'CONTAINER_ENTRY'))
    }
    return generated
  }
  /** Cross-scope edges and implicit branch edges, unless an invalid scope entry is already the root cause. */
  private checkEdgeScopes(t:TopologyFrame):void{
    const {value,nodes,knownNames,endpointScope,issues}=t,create=value.mode==='create'
    // Report cross-scope edges in the same round as container issues; otherwise
    // the edge stays outside the repair region until materialization rejects it.
    const crossScope=(source:string,target:string,explicit:string[]|undefined,path:string)=>{
      if(!knownNames.includes(source)||!knownNames.includes(target))return
      const sourceScope=endpointScope(source),targetScope=endpointScope(target)
      if(sourceScope!==targetScope)issues.push({code:'EDGE_SCOPE',message:edgeScopeMessage(path,source,sourceScope,target,targetScope),path,allowedPaths:[path]})
      else if(explicit&&JSON.stringify(explicit)!==sourceScope)
        issues.push({code:'EDGE_SCOPE',message:scopeMismatchMessage(path,JSON.stringify(explicit),source,target,sourceScope),path,allowedPaths:[path]})
    }
    // An invalid scope entry is the root cause; edges derived from it would only repeat it.
    const scopeFault=issues.some(issue=>/\/scope\/\d+$/.test(issue.path??''))
    if(!scopeFault)for(const[name,edge]of Object.entries(create?value.linksByKey??{}:value.addLinksByKey??{}))crossScope(edge.source,edge.target,edge.scope,pointer([create?'linksByKey':'addLinksByKey',name]))
    if(create&&!scopeFault)for(const[name,chain]of Object.entries(value.chainsByKey??{}))for(let i=1;i<chain.nodes.length;i++)crossScope(chain.nodes[i-1]!,chain.nodes[i]!,undefined,pointer(['chainsByKey',name]))
    if(create)for(const[name,chain]of Object.entries(value.chainsByKey??{}))for(let i=1;i<chain.nodes.length;i++){
      const source=chain.nodes[i-1]!,target=chain.nodes[i]!
      if(!['if','classifier'].includes(nodes[source]?.kind??''))continue
      const chainPath=pointer(['chainsByKey',name]),hasExplicit=Object.values(value.linksByKey??{}).some(edge=>edge.source===source&&edge.target===target&&edge.port!==undefined)
      const message=`chain ${name} 的 ${source} → ${target} 生成了分支节点的隐式 default 边；请从该 chain 移除或拆开此顺序段，改用 links 显式连线。`+
        'port 必须是字符串（如 "true"/"false"），不能改成布尔值。'+(hasExplicit?'此端点已有带字符串 port 的 links；该错误来自 chain，不要把 port 改成布尔值。':'')
      issues.push({code:'BRANCH_PORT',message,path:pointer(['chainsByKey',name,'nodes',String(i-1)]),expected:{type:'string',enum:knownNames},candidates:knownNames,
        contracts:{[chainPath]:t.chainContract,...(!hasExplicit?{'/linksByKey':t.linksContract}:{})},allowedPaths:[chainPath,...(hasExplicit?[]:['/linksByKey'])]})
    }
  }
  /** Code nodes must map every input they read; candidates come from same-scope upstream outputs. */
  private checkCodeInputs(t:TopologyFrame):void{
    const {value,nodes,view,existing,endpointScope,issues}=t,create=value.mode==='create'
    const incoming=new Map<string,string[]>()
    const upstream=(source:string,target:string)=>{if(endpointScope(source)===endpointScope(target))incoming.set(target,[...(incoming.get(target)??[]),source])}
    if(create)for(const chain of Object.values(value.chainsByKey??{}))for(let i=1;i<chain.nodes.length;i++)upstream(chain.nodes[i-1]!,chain.nodes[i]!)
    else{
      const names=new Map([...this.refs].map(([name,ref])=>[ref,name]))
      for(const edge of view.edges){
        const source=names.get(edge.source),target=names.get(edge.target)
        if(source&&target&&!value.removeNodes?.includes(source)&&!value.removeNodes?.includes(target)&&!value.removeLinks?.some(link=>link.source===source&&link.target===target&&(link.port??'default')===(edge.port??'default')))upstream(source,target)
      }
    }
    for(const edge of Object.values(create?value.linksByKey??{}:value.addLinksByKey??{}))upstream(edge.source,edge.target)
    const checkNode=(name:string,definition:any,configPath:string,change?:z.infer<typeof update>)=>{
      if(definition.kind!=='code')return
      const reads=codeInputReads(definition.config.code,definition.config.language),mapping=definition.config.inputs??{}
      const missing=reads?.names.filter(key=>!Object.hasOwn(mapping,key))??[]
      if(!missing.length)return
      const path=configPath+'/inputs',candidates:string[]=[],seen=new Set([name]),queue=[...(incoming.get(name)??[])]
      for(let i=0;i<queue.length&&candidates.length<5;i++){
        const ancestor=queue[i]!;if(seen.has(ancestor))continue;seen.add(ancestor)
        const node:any=t.definitionFor(ancestor)
        if(node){
          for(const field of new Set(outputFieldNames(node)))if(typeof field==='string'&&/^[A-Za-z_][\w]*$/.test(field)&&candidates.length<5)candidates.push('{{'+ancestor+'.'+field+'}}')
        }
        queue.push(...incoming.get(ancestor)??[])
      }
      const contracts:Record<string,JsonSchemaNode>={[path]:{type:'object',additionalProperties:true}}
      if(change&&!change.set)contracts[configPath]={type:'object',additionalProperties:true}
      if(change?.unset?.includes('inputs'))contracts[pointer(['updates',name,'unset'])]=array(str)
      const message=`代码节点 ${name} 读取了 ${missing.map(key=>reads!.parameter+'.'+key).join('、')}，但 inputs 中没有映射 ${missing.join('、')}；`+
        `在 ${path} 添加 ${JSON.stringify(Object.fromEntries(missing.map(key=>[key,'{{上游节点key.字段}}'])))}。`+(candidates.length?'同 scope 上游候选：'+candidates.join('、')+'。':'')
      issues.push({code:'CODE_INPUT_UNMAPPED',path,message,allowedPaths:Object.keys(contracts),contracts})
    }
    for(const[name,definition]of Object.entries(nodes))checkNode(name,definition,pointer([create?'nodesByKey':'addNodesByKey',name,'config']))
    if(!create)for(const[name,change]of Object.entries(value.updates??{}))if(['code','inputs'].some(field=>Object.hasOwn(change.set??{},field)||change.unset?.includes(field))){
      const old=existing.get(this.refs.get(name)??'')
      // Preserve fatal authority diagnostics for fixed or unselected targets.
      if(old&&!view.fixedNodeRefs.includes(old.ref)&&(!view.targetNodeRefs.length||view.targetNodeRefs.includes(old.ref)))
        checkNode(name,{kind:change.kind??old.kind,config:updatedConfig(old.config,change)},pointer(['updates',name,'set']),change)
    }
  }
  /** Materializes the checked draft as Host edits, in declaration order. */
  private draftEdits(value:AuthoringDraft,nodes:Record<string,DraftNode>,roles:Record<string,DraftRole>,env:Record<string,DraftEnvironment>,maps:PlanningAliases,generated:HostEdge[]):any[]{
    const create=value.mode==='create',edits:any[]=[]
    if('title'in value||'description'in value)edits.push({op:'set-workflow',...('title'in value?{title:value.title}:{}),...('description'in value?{description:value.description}:{})})
    for(const [name,definition]of Object.entries(roles))edits.push({op:'add-subagent',key:name,...definition})
    for(const [name,definition]of Object.entries(env))edits.push({op:'add-environment',key:name,...definition})
    if(create){
      // Remove the scaffold topology; retain its bound identities, not its old bypass.
      for(const edge of planningEditView(this.context,this.context.workflow,false).edges)edits.push({op:'disconnect',...edge})
      const kept=new Set(Object.keys(nodes).filter(name=>this.refs.has(name)).map(name=>this.refs.get(name)))
      for(const old of planningEditView(this.context,this.context.workflow,false).nodes.filter(n=>!n.scope.length))if(!kept.has(old.ref))edits.push({op:'remove-node',node:old.ref})
    }else edits.push(...this.changeEdits(value,maps))
    edits.push(...this.nodeEdits(nodes,maps),...this.linkEdits(value,nodes,maps,generated))
    return edits
  }
  private changeEdits(value:EditDraft,maps:PlanningAliases):any[]{
    const edits:any[]=[],resolve=(name:string,kind:keyof PlanningAliases='nodes')=>aliasRef(maps,name,kind)
    for(const name of value.removeNodes??[])if(!(this.scopes.get(name)??[]).some(parent=>value.removeNodes?.includes(parent)))
      edits.push({op:'remove-node',node:resolve(name),scope:aliasScope(maps,this.scopes.get(name))})
    for(const [name,change]of Object.entries(value.updates??{})){
      const old=planningEditView(this.context,this.context.workflow,false).nodes.find(n=>n.ref===resolve(name))
      if(!old)throw new CompilerError('UNKNOWN_REFERENCE','修改节点不存在')
      edits.push({op:'update-node',node:resolve(name),scope:aliasScope(maps,this.scopes.get(name)),...(change.kind?{kind:change.kind}:{}),...(change.title?{title:change.title}:{}),
        ...(change.description!==undefined?{note:change.description}:{}),
        ...(change.set?{configSet:hostConfig(maps,change.set,change.kind??old.kind,planningUpdateLocals(old.config,change.set,change.unset))}:{}),
        ...(change.unset?{configUnset:change.unset}:{})})
    }
    for(const [name,change]of Object.entries(value.updateRoles??{}))edits.push({op:'update-subagent',agent:resolve(name,'agents'),...change})
    for(const name of value.removeRoles??[])edits.push({op:'remove-subagent',agent:resolve(name,'agents')})
    for(const [name,change]of Object.entries(value.updateEnvironment??{}))edits.push({op:'update-environment',variable:resolve(name,'environment'),...change})
    for(const name of value.removeEnvironment??[])edits.push({op:'remove-environment',variable:resolve(name,'environment')})
    return edits
  }
  /** Outer nodes first, so every container exists before its children. */
  private nodeEdits(nodes:Record<string,DraftNode>,maps:PlanningAliases):any[]{
    const edits:any[]=[]
    for(const [name,definition]of Object.entries(nodes).sort((a,b)=>(a[1].scope?.length??0)-(b[1].scope?.length??0))){
      const ref=aliasRef(maps,name)
      const fields={...(definition.description===undefined?{}:{note:definition.description}),kind:definition.kind,title:definition.title??NODE_LABELS[definition.kind],scope:aliasScope(maps,definition.scope)}
      const configured=hostConfig(maps,definition.config,definition.kind)
      if(this.refs.has(name)){
        const old=planningEditView(this.context,this.context.workflow,false).nodes.find(n=>n.ref===ref)!
        edits.push({op:'update-node',node:ref,...fields,configSet:configured,configUnset:Object.keys(old.config).filter(k=>!Object.hasOwn(definition.config,k))})
      }else edits.push({op:'add-node',key:name,...fields,config:configured})
    }
    return edits
  }
  /** Removed links, then declared links, chain edges and Host entry edges, each connected once. */
  private linkEdits(value:AuthoringDraft,nodes:Record<string,DraftNode>,maps:PlanningAliases,generated:HostEdge[]):any[]{
    const create=value.mode==='create',edits:any[]=[],resolve=(name:string)=>aliasRef(maps,name)
    // A cross-scope edge names its own link or chain so the repair can remove exactly that entry.
    const edgeScope=(source:string,target:string,explicit:string[]|undefined,path:string)=>{
      const sourceScope=nodes[source]?.scope??this.scopes.get(source)??[],targetScope=nodes[target]?.scope??this.scopes.get(target)??[],shown=(items:string[])=>JSON.stringify(items)
      if(JSON.stringify(sourceScope)!==JSON.stringify(targetScope))
        throw new CompilerError('EDGE_SCOPE',edgeScopeMessage(path,source,shown(sourceScope),target,shown(targetScope)),path)
      if(explicit&&JSON.stringify(explicit)!==JSON.stringify(sourceScope))
        throw new CompilerError('EDGE_SCOPE',scopeMismatchMessage(path,shown(explicit),source,target,shown(sourceScope)),path)
      return aliasScope(maps,sourceScope)
    }
    if(!create)for(const [index,edge] of (value.removeLinks??[]).entries())
      edits.push({op:'disconnect',source:resolve(edge.source),target:resolve(edge.target),...(edge.port?{port:edge.port}:{}),scope:edgeScope(edge.source,edge.target,edge.scope,pointer(['removeLinks',index]))})
    const linksRoot=create?'linksByKey':'addLinksByKey'
    const links:{edge:{source:string,target:string,port?:string,scope?:string[]},path:string}[]=Object.entries((create?value.linksByKey:value.addLinksByKey)??{}).map(([name,edge])=>({edge,path:pointer([linksRoot,name])}))
    if(create)for(const [name,chain] of Object.entries(value.chainsByKey??{}))for(let i=1;i<chain.nodes.length;i++){
      const source=chain.nodes[i-1]!,sourceKind=nodes[source]?.kind
      if(['if','classifier'].includes(sourceKind??''))throw new CompilerError('BRANCH_PORT','分支节点请使用 links 显式指定 port')
      links.push({edge:{source,target:chain.nodes[i]!},path:pointer(['chainsByKey',name])})
    }
    for(const edge of generated)links.push({edge,path:'/chainsByKey'})
    const seen=new Set<string>()
    for(const {edge,path} of links){
      const normalized={source:resolve(edge.source),target:resolve(edge.target),...(edge.port?{port:edge.port}:{}),scope:edgeScope(edge.source,edge.target,edge.scope,path)}
      const fingerprint=JSON.stringify(normalized)
      if(!seen.has(fingerprint)){edits.push({op:'connect',...normalized});seen.add(fingerprint)}
    }
    return edits
  }
  /** Reuse authoritative layered/legacy inference for redundant template metadata.
   * The projection is cloned by Zod; explicit scope mismatches do not hide the
   * derived value, while conflicting chains never authorize normalization. */
  createChainScopes(input:unknown):Map<string,string[]>|undefined{
    const parsed=createSchema.pick({nodesByKey:true,chainsByKey:true,linksByKey:true}).safeParse(input)
    if(!parsed.success)return
    const issues:CompilerIssue[]=[],scopes=this.inferScopes(parsed.data,issues,chainWire())
    return issues.some(issue=>issue.code!=='NODE_SCOPE_MISMATCH')?undefined:scopes
  }
  private inferScopes(value:Pick<z.infer<typeof createSchema>,'nodesByKey'|'chainsByKey'|'linksByKey'>,issues:CompilerIssue[],chainContract:JsonSchemaNode):Map<string,string[]>{
    const nodes=value.nodesByKey,chains=Object.entries(value.chainsByKey??{}),assigned=new Map<string,string[]>(),members=new Set(chains.flatMap(([,chain])=>chain.nodes)),done=new Set<string>()
    const same=(a:string[],b:string[])=>JSON.stringify(a)===JSON.stringify(b)
    const assign=(name:string,scope:string[],path?:string)=>{
      if(!nodes[name])return false
      const old=assigned.get(name)
      if(old){
        if(path&&!same(old,scope)){
          const message=`${path} 将节点 ${name} 放入 scope=${JSON.stringify(scope)}，但该节点已属于 scope=${JSON.stringify(old)}；同一节点不能属于两层。`
          issues.push({code:'CHAIN_SCOPE_CONFLICT',message,path,contracts:{[path]:chainContract},allowedPaths:[path]})
        }
        return false
      }
      assigned.set(name,scope);return true
    }
    for(const[name,chain]of chains)if(!chain.container){
      const scopes=chain.nodes.map(name=>nodes[name]?.scope),legacy=scopes[0]&&scopes.every(scope=>scope&&same(scope,scopes[0]!))?scopes[0]!:[]
      for(const node of chain.nodes)assign(node,legacy,pointer(['chainsByKey',name]))
      done.add(name)
    }
    for(const[name,chain]of chains)if(chain.container&&(!nodes[chain.container]||!['loop','iteration'].includes(nodes[chain.container]!.kind))){
      const path=pointer(['chainsByKey',name,'container'])
      issues.push({code:nodes[chain.container]?'INVALID_SCOPE':'UNKNOWN_REFERENCE',message:'container 必须引用 loop/iteration 容器节点 key。',path,allowedPaths:[path],expected:authoringNodeKeyWire});done.add(name)
    }
    for(;;){
      let changed=false
      for(const[name,chain]of chains)if(!done.has(name)&&assigned.has(chain.container!)){
        const scope=[...assigned.get(chain.container!)!,chain.container!],path=pointer(['chainsByKey',name])
        if(scope.length>5||scope.slice(0,-1).includes(chain.container!))issues.push({code:'INVALID_SCOPE',message:'container chain 不能形成自身包含或超过5层的嵌套。',path,allowedPaths:[path],contracts:{[path]:chainContract}})
        else for(const node of chain.nodes)assign(node,scope,path)
        done.add(name);changed=true
      }
      if(changed)continue
      for(const edge of Object.values(value.linksByKey??{})){
        if(assigned.has(edge.source)&&!members.has(edge.target))changed=assign(edge.target,assigned.get(edge.source)!)||changed
        if(assigned.has(edge.target)&&!members.has(edge.source))changed=assign(edge.source,assigned.get(edge.target)!)||changed
      }
      if(changed)continue
      const unbound=Object.keys(nodes).find(name=>!assigned.has(name)&&!members.has(name))
      if(unbound){assign(unbound,[]);continue}
      break
    }
    for(const[name]of chains)if(!done.has(name)){
      const path=pointer(['chainsByKey',name,'container'])
      issues.push({code:'INVALID_SCOPE',message:'容器归属形成循环；先在外层 chain 声明容器，再用 container chain 声明内部节点。',path,
        allowedPaths:[pointer(['chainsByKey',name])],contracts:{[pointer(['chainsByKey',name])]:chainContract}})
    }
    for(const[name,node]of Object.entries(nodes)){
      const scope=assigned.get(name)??[],explicit=node.scope,path=pointer(['nodesByKey',name,'scope'])
      // Invalid legacy references keep their original precise scope diagnostic.
      if(explicit?.some(parent=>!['loop','iteration'].includes(nodes[parent]?.kind??'')))continue
      if(explicit&&!same(explicit,scope)){
        const message=`${path} 的显式 scope=${JSON.stringify(explicit)} 与推导 scope=${JSON.stringify(scope)} 不一致；省略 scope 或改为推导值。`
        issues.push({code:'NODE_SCOPE_MISMATCH',message,path,expected:{type:'array',items:authoringNodeKeyWire},allowedPaths:[path]})
      }
      node.scope=scope
    }
    return assigned
  }
  repairRoots(document:any):string[]{
    const schema=this.context.operation==='create'?createSchema:editSchema
    return [...new Set([...Object.keys(schema.shape),...(this.context.operation==='create'?['modules']:['addModules','updateModules','removeModules']),...Object.keys(document??{})])].filter(k=>k!=='mode').map(k=>pointer([k]))
  }
  uniqueRepair(document:any,issues:CompilerIssue[]):UniqueRepair|undefined{return uniqueExplicitBranchRepairs(document,issues)}
  /** Explicit authoring slots, not a second draft or an automatic body conversion.
   * Preserve the existing map: JSON Patch add at the map itself replaces it. */
  private containerRepair(document:any,name:string,code:string,inferredScope?:string[]):CompilerIssue{
    const create=document.mode==='create',root=create?'nodesByKey':'addNodesByKey',nodes=document[root]??{},container=nodes[name]
    const scope=inferredScope??[...(Array.isArray(container?.scope)?container.scope:[]),name],configPath=pointer([root,name,'config'])
    const body=container?.config?.body
    const bodyKeys=(Array.isArray(body?.nodes)?body.nodes:[]).map((node:any)=>node?.id).filter((name:unknown)=>key.safeParse(name).success) as string[]
    const selected=String(container?.config?.outputVariable??'').split('.')[0]!
    const fresh=repairSlots([...bodyKeys,...(key.safeParse(selected).success?[selected]:[])],'repairNode').filter(key=>!Object.hasOwn(nodes,key)&&!this.refs.has(key)).slice(0,32)
    const names=[...new Set([...Object.keys(nodes),...this.refs.keys(),...fresh])]
    const nodeContract=object({description:nodeDescriptionWire,kind:{type:'string',enum:Object.keys(NODE_LABELS)},title:str,config:{type:'object',additionalProperties:true},
      scope:{type:'array',items:str}},create?['kind','config']:['kind','config','scope'])
    const contracts:Record<string,JsonSchemaNode>=create?{[configPath]:{type:'object',additionalProperties:true}}:{}
    for(const key of fresh)contracts[pointer([root,key])]=nodeContract
    const chainRoot=create?'chainsByKey':'addLinksByKey'
    const chainKeys=repairSlots(Object.keys(document[chainRoot]??{}),'repair')
    const reference:JsonSchemaNode={type:'string',enum:names}
    const connection=create?chainWire(reference):object({source:reference,target:reference,port:str,scope:{type:'array',items:str}},['source','target'])
    // Existing connection entries are individually patchable; absent maps must
    // first be added at their root, retaining any entries already in the draft.
    if(document[chainRoot])for(const key of chainKeys)contracts[pointer([chainRoot,key])]=connection
    else contracts['/'+chainRoot]=openMap(chainKeys,connection)
    for(const id of this.required)contracts[pointer(['coverage',id])]={type:'array',items:reference}
    return {code,path:configPath,message:create?createContainerMessage(name,scope):editContainerMessage(name,scope),
      allowedPaths:[...(body?[configPath]:[]),...Object.keys(contracts)],contracts}
  }
  diagnose(error:unknown,document:any):CompilerIssue[]{
    const roots=this.repairRoots(document)
    if(error instanceof FragmentIssues)return error.issues
    if(error instanceof AuthoringFields)return error.issues
    if(error instanceof AuthoringIssues)return error.issues.map(issue=>this.diagnoseIssue(issue,document,roots))
    if(error instanceof Error&&/FORBIDDEN|HOST_FIELD|SECRET_VALUE|HOST_METADATA|UNALLOCATED|FIXED_NODE|TARGET_SCOPE/.test(error.message))
      throw new CompilerError('COMPILER_FORBIDDEN',error.message,undefined,true)
    const diagnosed=issueFromError(error,roots)
    // Renaming an invalid record key needs remove+add at its parent; permitting
    // only the invalid child path would make an explicit correction impossible.
    if(error instanceof z.ZodError)return diagnosed.flatMap((issue,index)=>this.diagnoseShape(issue,error.issues[index]!,document))
    return diagnosed
  }
  /** Maps a graph issue back to the declaring key and its repair region; authority conflicts stay fatal. */
  private diagnoseIssue(issue:PlanningIssue,document:any,roots:string[]):CompilerIssue{
    const completion=completionRepairIssue(this.options.completion,issue,document)
    if(completion)return completion
    if(this.options.completion&&issue.code==='HANDOFF_DECISION_CONFLICT')throw new CompilerError(issue.code,issue.message,undefined,true)
    if(/FIXED|TARGET_SCOPE|FORBIDDEN|HOST_METADATA|SECRET|UNALLOCATED/.test(issue.code))
      throw new CompilerError(issue.code,issue.message,undefined,true)
    const name=issue.nodeId?this.declaredName(issue.nodeId):undefined
    const declared=!name?undefined:document.nodesByKey?.[name]?pointer(['nodesByKey',name,'config']):document.addNodesByKey?.[name]?pointer(['addNodesByKey',name,'config']):
      document.updates?.[name]?pointer(['updates',name,'set']):undefined
    let path=declared
    if(path&&issue.path?.startsWith('config.'))path+=pointer(issue.path.slice(7).split('.'))
    if(path&&issue.path?.startsWith('/config/'))path+=issue.path.slice(7)
    let message=issue.message
    if(issue.code==='TEMPLATE_SYNTAX_UNSUPPORTED'){
      for(const[key,id]of this.reservations.nodes)message=message.replaceAll('{{'+id+'.','{{'+key.slice(1)+'.')
      for(const[key,ref]of this.refs){const id=[...planningNodeRefs(this.context.workflow)].find(([,r])=>r===ref)?.[0];if(id)message=message.replaceAll('{{'+id+'.','{{'+key+'.')}
    }
    if(/COVERAGE/.test(issue.code)||issue.code==='REVIEW_REQUIRED')path='/coverage'
    // Review and explicit template insertion may require topology edits;
    // retain the exact field as well as the existing structural repair roots.
    const structuralRepair=['REVIEW_REQUIRED','REVIEW_BEFORE_EFFECT','TEMPLATE_SYNTAX_UNSUPPORTED','FILE_WRITE_NEEDS_READ'].includes(issue.code)
    return {code:issue.code,message,...(issue.code==='FILE_WRITE_NEEDS_READ'&&issue.nodeId?{nodeId:issue.nodeId}:{}),...(path?{path}:{}),
      allowedPaths:structuralRepair?[...new Set([...(path?[path]:[]),...roots])]:path?[path]:roots}
  }
  /** Draft key of a base or reserved Host node ID. */
  private declaredName(nodeId:string):string|undefined{
    const baseRef=planningNodeRefs(this.context.workflow).get(nodeId)
    let name=[...this.refs].find(([,ref])=>ref===baseRef)?.[0]
    if(this.context.operation==='create'){
      if(baseRef===this.refs.get('start'))name='start'
      if(baseRef===this.refs.get('result'))name='result'
    }
    name??=[...this.reservations.nodes].find(([,id])=>id===nodeId)?.[0].slice(1)
    return name
  }
  /** Shape issues whose repair needs a parent path or a container chain instead of the failing leaf. */
  private diagnoseShape(issue:CompilerIssue,raw:z.core.$ZodIssue,document:any):CompilerIssue[]{
    const parts=raw.path.map(String)
    if(raw.code==='invalid_key')return [{...issue,allowedPaths:[pointer(parts.slice(0,-1))]}]
    if(raw.code==='custom'&&raw.message==='config.body 由 Host 根据 scope 组装')return [this.containerRepair(document,parts[1]!,'CONTAINER_BODY_AUTHORING')]
    if(raw.code==='unrecognized_keys'&&parts[0]==='chainsByKey'&&parts.length===2){
      const chain=document.chainsByKey?.[parts[1]!],container=chain?.container??document.nodesByKey?.[chain?.nodes?.[0]]?.scope?.at(-1)
      if(container&&chain?.nodes?.length===1&&!chain.container)return [issue,this.containerRepair(document,container,'CONTAINER_ENTRY')]
    }
    if(parts[0]==='chainsByKey'&&parts[1]&&parts[2]==='nodes'&&parts.length===3&&['too_small','invalid_type','custom'].includes(raw.code)){
      const chainPath=pointer(parts.slice(0,2)),chain=document.chainsByKey?.[parts[1]],nodes=document.nodesByKey??{}
      const scope=nodes[chain?.nodes?.[0]]?.scope
      const container=chain?.container??scope?.at(-1)
      const guidance=container?this.containerRepair(document,container,'CONTAINER_ENTRY'):undefined
      const message='chain 只声明同层顺序；无 container 时 nodes 至少 2 项；容器内部用 {container, nodes:[...]} 可只有1项。删除整个 '+chainPath+
        '，不能仅删除必填的 nodes。容器入口由 Host 自动生成，不需手写 input。'
      return [{...issue,message,allowedPaths:[chainPath],contracts:{[chainPath]:chainWire()}},...(guidance?[guidance]:[])]
    }
    return [issue]
  }
}
class AuthoringIssues extends Error {constructor(readonly issues:PlanningIssue[]){super(issues.map(x=>x.message).join('；'))}}


class AuthoringFields extends Error {constructor(readonly issues:CompilerIssue[]){super(issues.map(x=>x.message).join("; "))}}
