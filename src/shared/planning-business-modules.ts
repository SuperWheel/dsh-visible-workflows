import { z } from 'zod'
import { businessModuleRequestSchema,businessModuleParametersSchema as parametersSchema,reviewedFileWriteParametersSchema } from './planning-business-module-contract.ts'
export { businessModuleRequestSchema,type BusinessModuleRequest } from './planning-business-module-contract.ts'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { PlanningContext } from './planning-types.ts'
import { AuthoringCore, type AuthoringOptions } from './planning-authoring-core.ts'
import { compilerJson, CompilerError, jsonDigest } from './planning-repair.ts'
import { compileHandoffChanges } from './planning-handoff.ts'
import type { Workflow } from './types.ts'
import { allNodes } from './workflow-validation.ts'
import { reviewedFileAuthoring, reviewedFileGraph, reviewedFileImplementationDigest, reviewedFileParameterChanges, reviewedFileStoredParameters } from './planning-reviewed-file-module.ts'

// This exact implementation is copied into every v1 instance. Parameters are
// data in inputs; they never alter code, output contracts, or graph structure.
import { renderCode, inputContract, outputContract, fixedInput, fixedCode } from './planning-table-recipe.ts'
import { tableFragmentCatalogEntry } from './planning-module-fragment-contract.ts'
const fixedOutput={outputName:'result'}
const implementationDigest=jsonDigest({fixedInput,fixedCode,fixedOutput,inputContract,outputContract,parameters:z.toJSONSchema(parametersSchema,{io:'input'}),topology:['input','code','output'],runtimeContract:'javascript-main-json-v1'})
// A v1 implementation/contract change requires a deliberate new version and
// independent verification, rather than silently changing existing instances.
const pinnedDigest='97ab7ab7732fc5cc1f22bce41bcce0b280401042345e18106513385bb9a53419'
if(implementationDigest!==pinnedDigest)throw new CompilerError('MODULE_CONTRACT_DRIFT','结构化结果模块的固定实现或参数合同已变化；需新版本及独立验证 '+implementationDigest,undefined,true)

/** 从固定配方投影，保留角色引用；占位目标只是目录文案，不参与实现摘要。 */
function reviewedFileFixedFacts(){
  const graph=reviewedFileGraph({target:'<parameters.target>',producer:{text:''},maxIterations:3})
  const config=(role:string)=>allNodes(graph).find(node=>node.id===role)!.config
  const gate=config('reviewGate')
  return {
    notation:'<parameters.target> 替换为目标路径；引用使用固定配方角色名。',
    reviewPromptPattern:gate.prompt,fields:gate.fields,actions:gate.actions,
    draftPathPattern:config('draftWrite').inputs!.file_path,
    draftContent:config('draftWrite').inputs!.content,
    writeContent:config('commit').inputs!.content,
  }
}

/** The catalog's evidence applies to the pinned implementation, not future business inputs. */
export function businessModuleCatalog(){return structuredClone([{
  id:'structured-result-table',version:'1.0.0',title:'结构化结果表格渲染',operations:['create','revise-parameters'],
  fragment:tableFragmentCatalogEntry(),
  implementationDigest,parameters:z.toJSONSchema(parametersSchema,{io:'input'}),
  parameterExample:{title:'成绩表',columns:[{key:'name',label:'姓名'},{key:'score',label:'成绩'}],emptyText:'暂无数据'},
  inputs:inputContract,outputs:outputContract,
  applicability:'输入为至多 500 行 JSON 对象；仅渲染明确列出的标量字段，不写文件、不调用模型或工具。新建或通过 Host 已发布来源映射修改现有实例参数。',
  limitations:['更新须匹配已发布任务中的实例来源、固定实现与连接；不猜测手写代码是否等价','不生成或猜测缺失业务值；缺列及嵌套单元格在运行时明确失败','模块元数据记录为规划任务来源；不作为 Workflow 的授权或运行成功证据'],
  diagnosticCoverage:[] as {code:string;nodeKind:'tool';toolIds:string[]}[],
  toolContracts:[],runtimeContract:'javascript-main-json-v1',humanReview:'每个候选仍须通过正常提案查看和接受；模块无外部副作用，无额外运行人审节点。',
  fixedBehaviours:'输入 rows → 固定 JavaScript 转义并渲染指定列 → 输出 text/count；不写文件、不调用模型。',
  verification:{status:'runtime-fixture-verified',fixture:'tests/planning-business-modules.test.ts',runtime:'production WorkflowRuntime + Graphon 0.7.0 + QuickJS',scope:'独立临时存储中的确定性本地执行；不证明 Desktop 已安装或任意业务输入已通过'},
},{
  id:'reviewed-file-write',version:'1.0.0',title:'审核后写入文件（有限退回修改）',operations:['create','revise-parameters'],
  implementationDigest:reviewedFileImplementationDigest,parameters:z.toJSONSchema(reviewedFileWriteParametersSchema,{io:'input'}),
  parameterExample:{target:'report.txt',producer:{text:'{% if reviewBase or reviewNote %}{{reviewBase}}\n修改意见：{{reviewNote}}{% else %}这是固定初稿。{% endif %}'},maxIterations:3},
  inputs:{},outputs:{result:{type:'string',enum:['approved','not-approved']}},
  applicability:'目标为字面量工作区根相对文件路径；固定正文模板可使用 reviewBase 和 reviewNote。先精确探测／读取目标，每轮写隔离草稿并询问真人；通过后只提交表单正文，最多 1–100 轮（默认 3）。参数齐全时 Host 实例化，新增规划模型调用为 0。',
  limitations:['只复用 reviewedFileWriteGraph，不生成正文业务逻辑；额外业务节点仍由 Agent 局部设计','工具固定为 native:glob/native:read/native:write，须由当前工具目录及存储合同校验，不允许任意工具覆盖','离线校验与配方运行夹具不代表 T20 Desktop 验收完成'],
  diagnosticCoverage:[{code:'REVIEW_BEFORE_EFFECT',nodeKind:'tool' as const,toolIds:['native:write']}],
  toolContracts:['native:glob 精确路径探测','native:read 当前 owner 读取已有目标','native:write 当前 owner 版本／不存在时首建'],
  runtimeContract:'reviewed-file-write-v1',humanReview:'每轮 human 暂停；content 为可修改的段落表单，默认生成正文；拒绝保留正文及意见，通过只写 reviewGate.content；达到上限输出 not-approved。',
  fixedBehaviours:'精确探测／读取目标 → 生成隔离草稿 → 真人审核并可退回修改 → 通过后写表单正文；未通过不写目标。',
  fixedFacts:reviewedFileFixedFacts(),
  verification:{status:'offline-recipe-verified',fixture:'tests/planning-reviewed-file-module.test.ts + tests/planning-review.test.ts',runtime:'production WorkflowRuntime + Graphon + SDK observation-policy fixture',scope:'配方等价性、完整候选与存储合同校验、拒绝／批准／有限轮数的隔离运行；Desktop 留待 T22.4'},
}])}

export function expandBusinessModule(input:unknown){
  const request=businessModuleRequestSchema.parse(compilerJson(input)),key=request.instanceKey+'Render'
  if(request.moduleId==='reviewed-file-write')return {
    ...reviewedFileAuthoring(request.parameters),
    provenance:{moduleId:request.moduleId,version:request.version,instanceKey:request.instanceKey,implementationDigest:reviewedFileImplementationDigest,parametersDigest:jsonDigest(request.parameters)},
  }
  return {
    nodesByKey:{
      start:{kind:'input',title:'数据输入',config:structuredClone(fixedInput)},
      [key]:{kind:'code',title:'结构化结果渲染',config:{...structuredClone(fixedCode),inputs:{rows:'{{input.rows}}',specification:request.parameters}}},
      result:{kind:'output',title:'渲染结果',config:{text:`{{${key}.text}}`,...fixedOutput}},
    },
    chainsByKey:{[request.instanceKey+'Chain']:{nodes:['start',key,'result']}},
    linksByKey:{},
    coverageKeys:[key,'result'],
    provenance:{moduleId:request.moduleId,version:request.version,instanceKey:request.instanceKey,implementationDigest,parametersDigest:jsonDigest(request.parameters)},
  }
}

/** Same materializer, authority checks, validation and Host identity allocation as authored plans. */
export function compileBusinessModule(input:unknown,context:PlanningContext,options:AuthoringOptions={},title?:string){
  if(context.operation!=='create')throw new CompilerError('MODULE_OPERATION_UNSUPPORTED','该版本模块仅支持在未发布基线上创建；既有实例更新需要可信来源映射',undefined,true)
  const request=businessModuleRequestSchema.parse(input),expanded=expandBusinessModule(request),core=new AuthoringCore(context,options)
  const result=core.compile({mode:'create',title:title??(request.moduleId==='structured-result-table'?request.parameters.title:'审核后写入 '+request.parameters.target),nodesByKey:expanded.nodesByKey,chainsByKey:expanded.chainsByKey,linksByKey:expanded.linksByKey,coverage:Object.fromEntries((options.requiredCoverageIds??['R1']).map(id=>[id,expanded.coverageKeys])),summary:request.moduleId==='structured-result-table'?'使用已固定版本的结构化结果渲染模块':'使用已固定版本的审核写入模块'})
  return {...result,provenance:{...expanded.provenance,nodeIds:result.candidate?allNodes(result.candidate).map(node=>node.id):[]}}
}

export function businessModuleParameterContract(moduleId:'structured-result-table'|'reviewed-file-write'='structured-result-table'):JsonSchemaNode{return z.toJSONSchema(moduleId==='structured-result-table'?parametersSchema:reviewedFileWriteParametersSchema,{io:'input'}) as JsonSchemaNode}

export type BusinessModuleProvenance=ReturnType<typeof compileBusinessModule>['provenance']
/** Resolve parameters using Host-published role identities, including nested nodes. */
export function businessModuleStoredParametersDigest(workflow:Workflow,provenance:{moduleId:string;nodeIds:string[]},source:Workflow=workflow):string {
  if(!['structured-result-table','reviewed-file-write'].includes(provenance.moduleId))throw new CompilerError('MODULE_INSTANCE_CONFLICT','未知模块来源')
  return jsonDigest(provenance.moduleId==='reviewed-file-write'?reviewedFileStoredParameters(workflow,source,provenance.nodeIds):allNodes(workflow).find(node=>node.kind==='code'&&provenance.nodeIds.includes(node.id))?.config.inputs?.specification)
}
/** Parameter updates require a Host-resolved published instance, never caller-supplied provenance. */
export function updateBusinessModule(input:unknown,context:PlanningContext,source:Workflow,provenance:BusinessModuleProvenance){
  const request=businessModuleRequestSchema.parse(input)
  const digest=request.moduleId==='structured-result-table'?implementationDigest:reviewedFileImplementationDigest
  if(context.operation!=='revise'||source.id!==context.workflow.id||request.moduleId!==provenance.moduleId||request.version!==provenance.version||request.instanceKey!==provenance.instanceKey||provenance.implementationDigest!==digest)
    throw new CompilerError('MODULE_INSTANCE_CONFLICT','模块版本、实现或实例来源不匹配')
  const ids=new Set(provenance.nodeIds),original=allNodes(source).filter(node=>ids.has(node.id)),current=allNodes(context.workflow).filter(node=>ids.has(node.id))
  const render=original.find(node=>node.kind==='code'&&node.config.code===renderCode)
  if(ids.size!==original.length||current.length!==original.length||(request.moduleId==='structured-result-table'&&(ids.size!==3||!render||jsonDigest(render.config.inputs?.specification)!==provenance.parametersDigest)))
    throw new CompilerError('MODULE_INSTANCE_CONFLICT','模块来源映射或参数摘要无效')
  const definitions=(nodes:typeof original)=>nodes.map(node=>({id:node.id,kind:node.kind,...(request.moduleId==='reviewed-file-write'?{title:node.title}:{}),config:{...node.config,body:undefined}})).sort((a,b)=>a.id.localeCompare(b.id))
  const edges=(workflow:Workflow)=>[workflow,...allNodes(workflow).flatMap(node=>node.config.body?[node.config.body]:[])].flatMap(graph=>graph.edges).filter(edge=>ids.has(edge.source)||ids.has(edge.target)).map(({source,target,port})=>({source,target,port})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
  if(jsonDigest(definitions(original))!==jsonDigest(definitions(current))||jsonDigest(edges(source))!==jsonDigest(edges(context.workflow)))
    throw new CompilerError('MODULE_INSTANCE_CONFLICT','模块实现、参数或连接已改变；先核对当前实例，不覆盖手工修改')
  const changes=request.moduleId==='structured-result-table'?[{op:'set-config' as const,nodeId:render!.id,field:'inputs',value:{...render!.config.inputs,specification:request.parameters}}]:reviewedFileParameterChanges(request.parameters,source,provenance.nodeIds,provenance.parametersDigest)
  // Preserve idempotent updates without inventing a graph edit or a new ID.
  if(!changes.length&&request.moduleId==='reviewed-file-write')changes.push({op:'set-config',nodeId:original.find(node=>node.kind==='loop')!.id,field:'maxIterations',value:request.parameters.maxIterations})
  const result=compileHandoffChanges({version:1,mode:'edit',constraints:[],evidenceRefs:[],changes},context)
  return {...result,provenance:{...provenance,parametersDigest:jsonDigest(request.parameters)}}
}
