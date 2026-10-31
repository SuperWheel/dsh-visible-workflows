import { lstat, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { FILE_VERIFICATION_FIELDS, importWorkflowJson, parseWorkflowPackage, workflowDependencies } from '../shared/workflow-format.ts'
import type { ImportedWorkflow } from '../shared/workflow-format.ts'
import { parseWorkflowImportOptions, type WorkflowImportCatalog, type WorkflowImportDependency, type WorkflowImportPreview } from '../shared/workflow-import.ts'
import { newId, type ModelRef, type RolePreset, type WorkflowNode } from '../shared/types.ts'
import { allNodes } from '../shared/workflow-validation.ts'
import { createWorkflowThumbnail } from '../shared/workflow-thumbnail.ts'
import { rolePresetAvailable } from '../shared/role-presets.ts'

const key=(kind:string,id:string)=>`${kind}:${id}`
const modelKey=(value:ModelRef)=>`${value.provider}/${value.model}`
const missingPath=(value:string)=>!value||value.startsWith('__WORKFLOW_FILE_REBIND_REQUIRED__/')||isAbsolute(value)||/^(?:[A-Za-z]:[\\/]|file:\/\/|~\/)/.test(value)

/** Check existing sources and future output paths without reading their contents. */
export async function verifyWorkflowFile(root:string,path:string,output:boolean):Promise<void>{
  if(missingPath(path)||path.includes('\0')||path.split(/[\\/]/).includes('..'))throw new Error('请填写目标工作区内的相对文件路径，不接受绝对路径或上级目录')
  const base=await realpath(root),requested=resolve(base,path),inside=(target:string)=>{const rel=relative(base,target);return rel!==''&&!isAbsolute(rel)&&rel.split(/[\\/]/)[0]!=='..'}
  if(!inside(requested))throw new Error('文件必须位于目标工作区内')
  let probe=requested
  while(true){
    let meta
    try{
      meta=await lstat(probe)
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error
      if(!output)throw new Error('来源文件不存在，请在目标工作区重新选择')
      const parent=dirname(probe);if(parent===probe)throw new Error('文件父目录不可用');probe=parent;continue
    }
    const actual=await realpath(probe)
    if(actual!==base&&!inside(actual))throw new Error('文件符号链接指向目标工作区之外')
    if(probe===requested){if(!(await stat(probe)).isFile())throw new Error('目标路径不是普通文件')}
    else if(!meta.isDirectory()&&!meta.isSymbolicLink())throw new Error('目标路径的父级不是目录')
    return
  }
}

export async function prepareWorkflowImport(text:string,workspaceId:string,rawOptions:unknown,catalog:WorkflowImportCatalog,workspaceRoot:string):Promise<{preview:WorkflowImportPreview;workflow?:ImportedWorkflow['workflow'];workflows?:ImportedWorkflow['workflows'];presets?:RolePreset[]}> {
  if(!workspaceId)throw new Error('请选择目标工作区')
  const options=parseWorkflowImportOptions(rawOptions),pkg=parseWorkflowPackage(text),flow=pkg.workflow,flows=[flow,...pkg.workflows],nodes=flows.flatMap(allNodes),originalNodes=structuredClone(nodes)
  const dependencies=[...new Map(flows.flatMap(candidate=>workflowDependencies(candidate).map(item=>candidate.id!==flow.id&&item.kind==='file'?{...item,id:`workflow-${candidate.id}:${item.id}`,label:`${candidate.title}：${item.label}`}:item)).map(item=>[key(item.kind,item.id),item])).values()],known=new Set(dependencies.map(item=>key(item.kind,item.id))),mappings=new Map<string,string|ModelRef>()
  for(const mapping of options.mappings??[]){const id=key(mapping.kind,mapping.id);if(!known.has(id))throw new Error('映射引用了文件中不存在的依赖');if(mappings.has(id))throw new Error('同一依赖不能重复映射');mappings.set(id,mapping.target)}
  const preview:WorkflowImportPreview={title:flow.title,thumbnail:createWorkflowThumbnail(flow),nodeCount:nodes.length,edgeCount:flows.reduce((total,flow)=>total+allNodes(flow).reduce((count,node)=>count+(node.config.body?.edges.length??0),flow.edges.length),0),environmentCount:flows.reduce((total,flow)=>total+(flow.environmentVariables?.length??0),0),canImport:false,dependencies:[],warnings:[],errors:[]}
  const externalPresets:RolePreset[]=[],externalRoleIds=new Map<string,string>(),externalWorkflowIds=new Map<string,string>(),retainedEmbedded=new Set<string>(),localWorkflows=catalog.workflows.filter(value=>value.workspaceId===workspaceId&&!value.archived)
  const eachOriginal=(predicate:(node:WorkflowNode)=>boolean,update:(node:WorkflowNode)=>void)=>{for(const [index,node] of originalNodes.entries())if(predicate(node))update(nodes[index]!)}
  if(options.overwrite){
    const target=localWorkflows.find(value=>value.id===options.overwrite!.workflowId)
    if(!target)preview.errors.push('覆盖目标不存在、已归档或不属于目标工作区')
    else if(target.revision!==options.overwrite.expectedRevision)preview.errors.push('覆盖目标已被修改，请刷新版本并重新检查；导入内容已保留')
    else preview.overwrite={workflowId:target.id,title:target.title,expectedRevision:target.revision}
  }
  for(const dependency of dependencies){
    const chosen=mappings.get(key(dependency.kind,dependency.id))
    const item:WorkflowImportDependency={...dependency,status:'missing',message:'待映射',choices:[]}
    preview.dependencies.push(item)
    const fail=(message:string)=>{item.message=message;if(chosen!==undefined)preview.errors.push(`${dependency.label}：${message}`)}
    if(dependency.kind==='model'){
      item.choices=catalog.models.map(model=>({id:JSON.stringify({provider:model.provider,model:model.model}),label:model.label,target:{provider:model.provider,model:model.model}}))
      const original=originalNodes.find(node=>node.config.model&&modelKey(node.config.model)===dependency.id)!.config.model!
      const target=chosen??original
      if(typeof target==='string'){fail('模型映射必须包含提供方和模型身份');continue}
      const available=catalog.models.find(model=>model.provider===target.provider&&model.model===target.model)
      if(!available){fail('当前宿主没有此模型，请选择可用模型');continue}
      eachOriginal(node=>!!node.config.model&&modelKey(node.config.model)===dependency.id,node=>{node.config.model={...target};if(node.config.effort&&!available.efforts.some(effort=>effort.id===node.config.effort)){preview.warnings.push(`${node.title}：已保留原思考强度，请在画布选择当前模型支持的值后运行`)}})
      item.target=target;item.status='ready';item.message='模型已匹配';continue
    }
    if(dependency.kind==='tool'||dependency.kind==='workflow'){
      item.choices=dependency.kind==='workflow'?localWorkflows.filter(value=>value.id!==options.overwrite?.workflowId).map(value=>({id:`workflow:${value.id}`,label:value.title,target:`workflow:${value.id}`})):catalog.tools.filter(tool=>tool.available&&!tool.id.startsWith('workflow:')&&tool.id!=='native:run_code').map(tool=>({id:tool.id,label:tool.name,target:tool.id}))
      if(dependency.kind==='workflow'&&chosen===undefined&&pkg.workflows.some(child=>`workflow:${child.id}`===dependency.id)){item.status='ready';item.message='使用随包子工作流，创建新身份';continue}
      const target=chosen??dependency.id
      if(typeof target!=='string'||!item.choices.some(choice=>choice.id===target)){fail('依赖在目标工作区不可用，请选择可用目标');continue}
      const mapped=dependency.kind==='workflow'&&chosen!==undefined?`workflow:${newId()}`:target
      if(mapped!==target)externalWorkflowIds.set(mapped,target)
      for(const [index,node] of nodes.entries()){const original=originalNodes[index]!;if(original.config.toolId===dependency.id)node.config.toolId=mapped;if(node.config.tools)node.config.tools=node.config.tools.map((id,at)=>original.config.tools?.[at]===dependency.id?mapped:id)}
      item.target=target;item.status='ready';item.message='依赖已匹配';continue
    }
    if(dependency.kind==='role'){
      const consumers=flows.filter(candidate=>allNodes(candidate).some(node=>node.config.rolePresetId===dependency.id)),availableRoles=catalog.presets.filter(preset=>consumers.every(candidate=>rolePresetAvailable(preset,candidate.id===flow.id?options.overwrite?.workflowId:undefined)))
      item.choices=availableRoles.map(preset=>({id:preset.id,label:preset.name,target:preset.id}))
      const bundled=pkg.presets.find(preset=>preset.id===dependency.id)
      if(chosen===undefined&&bundled){retainedEmbedded.add(bundled.id);item.status='ready';item.message='使用随包角色，创建新身份';continue}
      const selected=typeof (chosen??dependency.id)==='string'?availableRoles.find(preset=>preset.id===(chosen??dependency.id)):undefined
      if(!selected){fail('角色未附带，请映射到现有角色');continue}
      const alias=newId();externalRoleIds.set(alias,selected.id)
      eachOriginal(node=>node.config.rolePresetId===dependency.id,node=>{node.config.rolePresetId=alias})
      externalPresets.push({id:alias,name:selected.name,prompt:selected.prompt,revision:selected.revision});item.target=selected.id;item.status='ready';item.message='使用目标环境已有角色';continue
    }
    let slot:{node:WorkflowNode;field:'source'|'sources'|typeof FILE_VERIFICATION_FIELDS[number];index?:number}|undefined
    for(const candidate of flows)for(const node of allNodes(candidate)){
      const dependencyId=candidate.id===flow.id?dependency.id:dependency.id.startsWith(`workflow-${candidate.id}:`)?dependency.id.slice(`workflow-${candidate.id}:`.length):''
      if(dependencyId===`file-${node.id}-source`)slot={node,field:'source'}
      for(const [index] of (node.config.sources??[]).entries())if(dependencyId===`file-${node.id}-sources-${index}`)slot={node,field:'sources',index}
      for(const field of FILE_VERIFICATION_FIELDS)for(const [index] of (node.config.verification?.[field]??[]).entries())if(dependencyId===`file-${node.id}-${field}-${index}`)slot={node,field,index}
    }
    if(!slot){if(chosen!==undefined){fail('运行附件须通过运行时上传入口提供，不能导入文件授权');continue}item.status='deferred';item.message='运行时由用户重新上传，不携带原附件或授权';continue}
    const {node,field,index}=slot,original=field==='source'?node.config.source??'':field==='sources'?node.config.sources![index!]!:node.config.verification![field]![index!]!
    const target=chosen??original
    if(typeof target!=='string'){fail('文件映射必须是工作区相对路径');continue}
    item.target=missingPath(target)?'':target
    const output=field==='requiredFiles'||field==='requiredChangedFiles'
    try{await verifyWorkflowFile(workspaceRoot,target,output)}catch(error){fail(error instanceof Error?error.message:String(error));continue}
    if(field==='source')node.config.source=target
    else if(field==='sources')node.config.sources![index!]=target
    else node.config.verification![field]![index!]=target
    item.status='ready';item.message=output?'验收目标已限定在工作区，执行时重新检查文件与边界':'来源文件已在目标工作区核验，执行时重新检查'
  }
  // Missing resources are editable canvas state, not malformed packages. Preserve
  // every unresolved reference so a later Host readiness check can rediscover it.
  preview.canImport=preview.errors.length===0
  if(!preview.canImport)return {preview}
  if(preview.dependencies.some(item=>item.status==='missing'))preview.warnings.push('已保留待配置依赖；可在画布保存，全部处理完成前不能运行')
  pkg.presets=pkg.presets.filter(preset=>retainedEmbedded.has(preset.id)||preset.scope==='workflow')
  const imported=importWorkflowJson(JSON.stringify(pkg),workspaceId,{externalPresets})
  for(const node of [imported.workflow,...imported.workflows].flatMap(allNodes)){
    if(node.config.rolePresetId&&externalRoleIds.has(node.config.rolePresetId))node.config.rolePresetId=externalRoleIds.get(node.config.rolePresetId)!
    if(node.config.toolId&&externalWorkflowIds.has(node.config.toolId))node.config.toolId=externalWorkflowIds.get(node.config.toolId)!
    if(node.config.tools)node.config.tools=node.config.tools.map(id=>externalWorkflowIds.get(id)??id)
  }
  preview.warnings.push(...imported.warnings)
  return {preview,workflow:imported.workflow,workflows:imported.workflows,presets:imported.presets}
}
