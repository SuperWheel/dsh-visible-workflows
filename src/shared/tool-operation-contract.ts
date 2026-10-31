import { compilerJson, CompilerError, jsonDigest } from './planning-repair.ts'
import { toolOperationContractSchema,toolOperationDeclarationSchema,type ToolOperationContract,type ToolOperationDeclaration } from './tool-operation-schema.ts'
export { toolOperationContractSchema,toolOperationDeclarationSchema,type ToolOperationContract,type ToolOperationDeclaration } from './tool-operation-schema.ts'

export const unknownToolOperation=():ToolOperationContract=>({status:'unknown',reason:'当前工具注册未提供可验证且有版本的操作合同；不能从工具同名、输出字段或一次成功样本推断前置条件和重复执行能力。'})

/** Stable across object-key ordering, including SDK schemas. */
export function operationDigest(value:unknown):string {
  const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>[k,canonical(v[k])])):v
  return jsonDigest(canonical(value))
}
export function validateToolOperation(raw:unknown,toolId?:string):ToolOperationContract {
  const contract=toolOperationContractSchema.parse(compilerJson(raw,128000))
  if(contract.status==='known'&&operationDigest(contract.declaration)!==contract.digest)
    throw new CompilerError('TOOL_OPERATION_CONTRACT_CONFLICT','工具操作合同摘要无效',undefined,true)
  // Native registrations and this plugin's own builtin tools have a verifiable ownership
  // mapping. A valid digest never authorizes copying a declaration into another namespace.
  const [prefix,sourcePrefix]=contract.status==='known'&&contract.source==='plugin-builtin'?['builtin:','builtin-tool:']:['native:','native-tool:']
  if(contract.status==='known'&&(!toolId?.startsWith(prefix)||!toolId.slice(prefix.length)||contract.declaration.sourceId!==sourcePrefix+toolId.slice(prefix.length)))
    throw new CompilerError('TOOL_OPERATION_CONTRACT_CONFLICT','工具操作合同来源不属于当前工具',undefined,true)
  return contract
}
/** Optional SDK extension. Missing/stale provenance stays unknown even for a tool named write. */
export function registeredToolOperation(toolId:string,definition?:{name:string;description:string;parameters:unknown;output?:{schema:unknown};operationContract?:unknown}):ToolOperationContract {
  if(!definition||!toolId.startsWith('native:')||definition.name!==toolId.slice(7)||!definition.operationContract)return unknownToolOperation()
  const result=toolOperationDeclarationSchema.safeParse(definition.operationContract)
  if(!result.success)return unknownToolOperation()
  const declaration=result.data
  if(declaration.sourceId!==`native-tool:${definition.name}`||declaration.registrationDigest!==operationDigest({name:definition.name,description:definition.description,parameters:definition.parameters,outputSchema:definition.output?.schema}))return unknownToolOperation()
  return {status:'known',source:'host-tool-registration',declaration,digest:operationDigest(declaration)}
}

// Builtins whose result depends on the moment of the call (time.weekday only without datetime).
const CLOCK_TOOLS=new Set(['builtin:time.now','builtin:time.timestamp','builtin:time.weekday'])
/** This plugin implements its builtin tools, so it is their registration source: they
 * compute from their arguments alone, touch no files or network, and are safe to rerun. */
export function builtinToolOperation(tool:{id:string;name:string;description:string;inputSchema:unknown}):ToolOperationContract {
  const name=tool.id.slice('builtin:'.length),registrationDigest=operationDigest({name:tool.name,description:tool.description,parameters:tool.inputSchema})
  const declaration:ToolOperationDeclaration={sourceId:`builtin-tool:${name}`,version:'1',registrationDigest,
    implementationSources:[{id:'dsh-visible-dynamic-workflows:builtin-tools',version:'1',digest:registrationDigest}],
    ...(tool.id==='builtin:file.stat'
      ?{preconditions:['path 指向当前工作区内已存在的普通文件；不存在、是目录或经符号链接越出工作区时报错'],scope:{owner:'none',target:'canonical-filesystem-path'},stateEffects:['无：只读取文件字节做统计，不修改文件，也不返回内容'],
        reuseLimits:['结果反映调用时刻的文件；文件改动后重新调用才会更新，可重复执行']}
      :{preconditions:['无：只按输入参数计算，不读写文件、不访问网络'],scope:{owner:'none',target:'none'},stateEffects:['无'],
        reuseLimits:[CLOCK_TOOLS.has(tool.id)?'结果取决于调用时刻（time.weekday 仅在不填 datetime 时），每次运行重新计算':'相同输入得到相同输出，可重复执行']}),
    action:{kind:'other'}}
  return {status:'known',source:'plugin-builtin',declaration,digest:operationDigest(declaration)}
}

/** Pure, deliberately narrow exact-path selector. This code is a versioned planning
 * recipe, not an implicit read/probe. It consumes the canonical listing explicitly
 * supplied by a graph node. Unsupported roots/paths fail instead of guessing. */
export const EXACT_TARGET_EXISTS_CODE=String.raw`function main(inputs) {
  const listing = inputs.listing;
  const normalize = path => {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.includes(':') || path.includes('\0')) throw new Error('Expected a root-relative POSIX file path');
    const parts = path.split('/').filter(part => part && part !== '.');
    if (!parts.length || parts.includes('..')) throw new Error('Path traversal is unsupported');
    return parts.join('/');
  };
  if (!listing || typeof listing !== 'object' || listing.root !== '.' || !Array.isArray(listing.paths)) throw new Error('Expected canonical glob value with root=. and paths');
  const target = normalize(inputs.target);
  const paths = listing.paths.map(normalize);
  return {exists:paths.includes(target)};
}`
