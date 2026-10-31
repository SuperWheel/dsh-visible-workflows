import { fragmentModules, fragmentKey, type FragmentModule, type FragmentRecipe } from './planning-module-fragment-contract.ts'
import { compilerJson, jsonDigest, pointer, pointerParts, type CompilerIssue } from './planning-repair.ts'
import { rewritePlanningConfig, type PlanningAliases } from './planning-edits.ts'
import { allNodes, storedWorkflowNodeConfigSchema } from './workflow-validation.ts'
import type { Workflow, WorkflowModuleInstance, NodeGraph, JsonValue } from './types.ts'

export class FragmentIssues extends Error {constructor(readonly issues:CompilerIssue[]){super(issues.map(i=>i.message).join('；'))}}
const maps=(nodes:Map<string,string>):PlanningAliases=>({nodes,agents:new Map(),environment:new Map()})
export const rewriteFragmentParameters=(p:Record<string,unknown>,ids:Map<string,string>)=>{
  const result=(rewritePlanningConfig({inputs:p},maps(ids),false,'code') as any).inputs as Record<string,JsonValue>
  // A fragment template is a template.text field, including if/for expressions
  // and lexical locals, rather than an ordinary input-mapping interpolation.
  if(typeof p.template==='string')result.template=rewritePlanningConfig(p.template,maps(ids),false,'template','text') as string
  return result
}
export function normalizeModuleDeclarations(doc:any){
  for(const root of ['modules','addModules'])if(Array.isArray(doc?.[root])){
    const keys=doc[root].map((row:any)=>row?.key)
    if(keys.some((key:any)=>!fragmentKey.safeParse(key).success)||new Set(keys).size!==keys.length)continue
    doc[root]=Object.fromEntries(doc[root].map(({key,...rest}:any)=>[key,rest]))
  }
  return doc
}
const edgeDefinitions=(edges:{source:string;target:string;port?:string}[])=>edges.map(e=>({source:e.source,target:e.target,port:e.port??'default'})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
export function instanceEdges(workflow:NodeGraph,ids:Set<string>){
  return [workflow,...allNodes(workflow).flatMap(n=>n.config.body?[n.config.body]:[])].flatMap(g=>g.edges).filter(e=>ids.has(e.source)||ids.has(e.target)).map(({source,target,port})=>({source,target,...(port===undefined?{}:{port})}))
}
// Normalize the frozen recipe itself, including container-owned chains. This
// operates only on Host recipe data, never on model-authored body objects.
function normalizedRecipe(module:FragmentModule,parameters:Record<string,unknown>):FragmentRecipe{
  const recipe=structuredClone(module.recipe(parameters)),assigned=new Map<string,string[]>(),chains=Object.values(recipe.chains),done=new Set<object>()
  const assign=(name:string,scope:string[])=>{
    if(!recipe.nodes[name])throw Error('片段配方引用不存在的角色 '+name)
    const previous=assigned.get(name)
    if(previous&&JSON.stringify(previous)!==JSON.stringify(scope))throw Error('片段角色跨越作用域')
    assigned.set(name,scope)
  }
  for(const chain of chains)if(!chain.container){for(const name of chain.nodes)assign(name,[]);done.add(chain)}
  for(const[name,node]of Object.entries(recipe.nodes))if(node.scope)assign(name,node.scope)
  for(;;){
    let changed=false
    for(const chain of chains)if(chain.container&&!done.has(chain)&&assigned.has(chain.container)){
      if(!['iteration','loop'].includes(recipe.nodes[chain.container]?.kind??''))throw Error('片段配方 container 必须为容器')
      for(const name of chain.nodes)assign(name,[...assigned.get(chain.container)!,chain.container]);done.add(chain);changed=true
    }
    for(const edge of Object.values(recipe.links)){
      if(assigned.has(edge.source)&&!assigned.has(edge.target)){assign(edge.target,assigned.get(edge.source)!);changed=true}
      if(assigned.has(edge.target)&&!assigned.has(edge.source)){assign(edge.source,assigned.get(edge.target)!);changed=true}
    }
    if(changed)continue
    const name=Object.keys(recipe.nodes).find(n=>!assigned.has(n))
    if(name){assign(name,[]);continue}break
  }
  if(done.size!==chains.length)throw Error('片段容器归属形成循环')
  for(const[name,scope]of assigned)if(scope.length)recipe.nodes[name]!.scope=scope
  // Explicit Host recipe entries keep the roles map complete and verifiable.
  for(const[name,node]of Object.entries(recipe.nodes))if(['loop','iteration'].includes(node.kind)){
    const scope=[...assigned.get(name)??[],name],children=Object.entries(recipe.nodes).filter(([,n])=>JSON.stringify(n.scope??[])===JSON.stringify(scope))
    if(!children.length)throw Error('片段容器必须有内部节点')
    if(!children.some(([,n])=>n.kind==='input')){
      let role=name+'Entry',index=0;while(recipe.nodes[role])role=name+'Entry'+(++index)
      recipe.nodes[role]={kind:'input',config:{fields:[]},scope}
      const incoming=new Set([...Object.values(recipe.links).map(e=>e.target),...chains.flatMap(c=>c.nodes.slice(1))])
      for(const[child]of children)if(!incoming.has(child))recipe.chains[role+'To'+child]={container:name,nodes:[role,child]}
    }
  }
  // Recipe default edges follow the same canonical chains contract as authored nodes.
  for(const[key,edge]of Object.entries(recipe.links))if(!edge.port||edge.port==='default'){
    recipe.chains['link'+key]={nodes:[edge.source,edge.target],...(recipe.nodes[edge.source]?.scope?.at(-1)?{container:recipe.nodes[edge.source]!.scope!.at(-1)}:{})};delete recipe.links[key]
  }
  return recipe
}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical((value as Record<string,unknown>)[k])])):value
const sameDefinition=(a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b))
function semanticConfig(config:import('./types.ts').NodeConfig):unknown{
  const {body,...own}=config
  return {...own,...(body?{body:{nodes:body.nodes.map(n=>({id:n.id,kind:n.kind,config:semanticConfig(n.config)})).sort((a,b)=>a.id.localeCompare(b.id)),edges:edgeDefinitions(body.edges)}}:{})}
}
function recipeTopology(recipe:FragmentRecipe){
  const edges=Object.values(recipe.links).map(e=>({...e}))
  for(const chain of Object.values(recipe.chains))for(let i=1;i<chain.nodes.length;i++)edges.push({source:chain.nodes[i-1]!,target:chain.nodes[i]!})
  const names=Object.keys(recipe.nodes),root=names.filter(n=>!recipe.nodes[n]!.scope?.length)
  const incoming=new Set(edges.map(e=>e.target)),outgoing=new Set(edges.map(e=>e.source))
  if(!names.includes(recipe.entry)||!names.includes(recipe.exit)||recipe.nodes[recipe.exit]?.kind==='output'||root.filter(n=>!incoming.has(n)).join()!==recipe.entry||root.filter(n=>!outgoing.has(n)).join()!==recipe.exit)throw Error('片段配方必须一入一出，出口不能为 output')
  return edges
}
/** Records are hints: independently re-expand and compare on EVERY use. */
export function verifiedModuleInstances(workflow:Workflow,catalog:readonly FragmentModule[]=fragmentModules):WorkflowModuleInstance[]{
  const nodes=new Map(allNodes(workflow).map(n=>[n.id,n])),locations=new Map<string,string[]>()
  const visit=(g:NodeGraph,path:string[])=>{for(const n of g.nodes){locations.set(n.id,path);if(n.config.body)visit(n.config.body,[...path,n.id])}};visit(workflow,[])
  const verified:WorkflowModuleInstance[]=[]
  for(const record of workflow.moduleInstances??[])try{
    const module=catalog.find(m=>m.id===record.moduleId&&m.version===record.version&&m.implementationDigest===record.implementationDigest)
    if(!module||module.scopes==='root'&&record.scope.length>0||jsonDigest(record.parameters)!==record.parametersDigest)continue
    const parameters=module.parameters.parse(record.parameters),recipe=normalizedRecipe(module,parameters),edges=recipeTopology(recipe)
    const roleNames=Object.keys(recipe.nodes),ids=new Set(Object.values(record.roles))
    if(jsonDigest(Object.keys(record.roles).sort())!==jsonDigest(roleNames.sort())||ids.size!==roleNames.length)continue
    const roleMap=new Map(Object.entries(record.roles))
    const expectedConfig=(role:string):import('./types.ts').NodeConfig=>{
      const node=recipe.nodes[role]!,config=storedWorkflowNodeConfigSchema(node.kind).parse(rewritePlanningConfig(node.config,maps(roleMap),false,node.kind)) as import('./types.ts').NodeConfig
      if(['loop','iteration'].includes(node.kind)){
        const scope=[...node.scope??[],role],children=roleNames.filter(r=>sameDefinition(recipe.nodes[r]!.scope??[],scope)),childIds=new Set(children.map(r=>record.roles[r]!))
        config.body={nodes:children.map(r=>({id:record.roles[r]!,kind:recipe.nodes[r]!.kind,config:expectedConfig(r),number:'',x:0,y:0,title:'recipe',fixed:false})),edges:edges.filter(e=>childIds.has(record.roles[e.source]!)&&childIds.has(record.roles[e.target]!)).map((e,i)=>({id:'recipe'+i,...e,source:record.roles[e.source]!,target:record.roles[e.target]!}))}
      }
      return config
    }
    if(roleNames.some(role=>{
      const actual=nodes.get(record.roles[role]!),expected=recipe.nodes[role]!
      return !actual||actual.kind!==expected.kind||!sameDefinition(semanticConfig(actual.config),semanticConfig(expectedConfig(role)))||jsonDigest(locations.get(actual.id))!==jsonDigest([...record.scope,...(expected.scope??[]).map(r=>record.roles[r])])
    }))continue
    const actualEdges=instanceEdges(workflow,ids),entry=record.roles[recipe.entry]!,exit=record.roles[recipe.exit]!
    const expectedInternal=edges.map(e=>({...e,source:record.roles[e.source]!,target:record.roles[e.target]!}))
    // Outside wiring may change freely (new consumers, rerouted inputs); it may
    // only attach at the entry or leave from the exit. record.edges is a creation-time hint.
    const boundary=actualEdges.every(e=>ids.has(e.source)&&ids.has(e.target)||!ids.has(e.source)&&e.target===entry||!ids.has(e.target)&&e.source===exit)
    if(jsonDigest(edgeDefinitions(actualEdges.filter(e=>ids.has(e.source)&&ids.has(e.target))))!==jsonDigest(edgeDefinitions(expectedInternal))||!boundary)continue
    verified.push(record)
  }catch{/* Untrusted/stale records detach silently, never rewrite the graph. */}
  // Overlapping records and duplicate keys are ambiguous: neither is trusted.
  return verified.filter(r=>verified.every(other=>other===r||other.instanceKey!==r.instanceKey&&!Object.values(other.roles).some(id=>Object.values(r.roles).includes(id))))
}
/** Instance refs share the current edit namespace. Keep the recorded key stable;
 * choose a public alias only when a fresh nN node ref would collide with it. */
export function moduleInstanceRefs(workflow:Workflow,instances=verifiedModuleInstances(workflow)):Map<string,string>{
  const nodes=new Set(allNodes(workflow).map((_n,i)=>'n'+(i+1))),used=new Set([...nodes,...instances.map(r=>r.instanceKey)]),refs=new Map<string,string>();let index=0
  for(const record of instances){let ref=record.instanceKey;if(nodes.has(ref)){do{ref='module'+(++index)}while(used.has(ref));used.add(ref)}refs.set(record.instanceKey,ref)}
  return refs
}
export interface FragmentExpansion {document:any;instances:{key:string;module:FragmentModule;parameters:Record<string,unknown>;roles:Record<string,string>}[];removed:Set<string>;owners:Map<string,string>
  /** Chains split at module boundaries: expanded key → authored key and the authored index of each node. */
  chains:Map<string,{chain:string;origin:number[]}>}
/** Pure normalize → expand pass. No IDs, storage, repair sessions, or execution. */
export function expandModuleFragments(input:unknown,catalog:readonly FragmentModule[]=fragmentModules,workflow?:Workflow):FragmentExpansion{
  const document=normalizeModuleDeclarations(compilerJson(input)),instances:FragmentExpansion['instances']=[],removed=new Set<string>(),owners=new Map<string,string>(),chains:FragmentExpansion['chains']=new Map()
  if(!document||typeof document!=='object'||document.mode==='needs-input')return {document,instances,removed,owners,chains}
  const create=document.mode==='create',root=create?'modules':'addModules',nodesRoot=create?'nodesByKey':'addNodesByKey'
  const active=workflow?verifiedModuleInstances(workflow,catalog):[],oldNodes=workflow?allNodes(workflow):[],oldRefs=new Map(oldNodes.map((n,i)=>[n.id,'n'+(i+1)]))
  const instanceRefs=workflow?moduleInstanceRefs(workflow,active):new Map<string,string>()
  const activeNodes=new Set(active.flatMap(r=>Object.values(r.roles))),fail=(code:string,message:string,path:string):never=>{throw new FragmentIssues([{code,message,path,allowedPaths:[path]}])}
  for(const name of Object.keys(document.updates??{}))if(activeNodes.has(oldNodes[Number(name.slice(1))-1]?.id??''))throw new FragmentIssues([{code:'MODULE_INTERNAL_EDIT',message:'有效模块实例只能用 updateModules 修改参数；从 updates 删除内部节点修改。',path:'/updates',allowedPaths:['/updates','/updateModules']}])
  for(const name of document.removeNodes??[])if(activeNodes.has(oldNodes[Number(name.slice(1))-1]?.id??''))fail('MODULE_INTERNAL_EDIT','有效模块实例只能用 removeModules 整体删除','/removeNodes')
  if(!active.length&&!['modules','addModules','updateModules','removeModules'].some(k=>Object.hasOwn(document,k)))return {document,instances,removed,owners,chains}
  for(const field of create?['addModules','updateModules','removeModules']:['modules'])if(Object.hasOwn(document,field))fail('MODULE_DECLARATION','当前模式不接受 '+field,'/'+field)
  const updates=document.updateModules??{},removals=document.removeModules??[]
  if(!Array.isArray(removals)||!updates||typeof updates!=='object'||Array.isArray(updates))fail('MODULE_PARAMETERS','模块修改格式无效','/updateModules')
  const declarations=document[root]??{}
  if(!declarations||typeof declarations!=='object'||Array.isArray(declarations))fail('MODULE_DECLARATION','modules 必须为带唯一 key 的声明列表','/'+root)
  document[nodesRoot]??={}
  const placementScopes=new Map<string,string[]>(),outerNodes={...document.nodesByKey,...declarations},pending=Object.values(document.chainsByKey??{}) as any[]
  for(const chain of pending)if(!chain.container&&Array.isArray(chain.nodes)){
    const explicit=chain.nodes.map((n:string)=>outerNodes[n]?.scope),legacy=explicit[0]&&explicit.every((s:any)=>sameDefinition(s,explicit[0]))?explicit[0]:[]
    for(const name of chain.nodes)placementScopes.set(name,legacy)
  }
  for(let round=0;round<=5;round++){
    for(const chain of pending)if(chain.container&&placementScopes.has(chain.container))for(const name of chain.nodes??[])if(!placementScopes.has(name))placementScopes.set(name,[...placementScopes.get(chain.container)!,chain.container])
    for(const edge of Object.values(document.linksByKey??{}) as any[]){if(placementScopes.has(edge.source)&&!placementScopes.has(edge.target))placementScopes.set(edge.target,placementScopes.get(edge.source)!);if(placementScopes.has(edge.target)&&!placementScopes.has(edge.source))placementScopes.set(edge.source,placementScopes.get(edge.target)!)}
  }
  const bindings=new Map<string,{entry:string;exit:string;module:FragmentModule;path:string}>()
  for(const record of active){
    const m=catalog.find(m=>m.id===record.moduleId&&m.version===record.version)!,recipe=normalizedRecipe(m,record.parameters)
    bindings.set(instanceRefs.get(record.instanceKey)!,{entry:oldRefs.get(record.roles[recipe.entry]!)!,exit:oldRefs.get(record.roles[recipe.exit]!)!,module:m,path:'/updateModules/'+instanceRefs.get(record.instanceKey)!+'/parameters'})
  }
  for(const key of new Set([...Object.keys(updates),...removals])){
    const record=active.find(r=>instanceRefs.get(r.instanceKey)===key),path=pointer([removals.includes(key)?'removeModules':'updateModules',key])
    if(!record)fail('MODULE_DETACHED','实例不存在或已脱离；请按普通节点编辑',path)
    if(removals.includes(key)&&Object.hasOwn(updates,key))fail('MODULE_CONFLICT','同一实例不能同时更新和删除',path)
    const ids=Object.values(record!.roles),m=catalog.find(m=>m.id===record!.moduleId&&m.version===record!.version)!
    if(ids.some(id=>oldNodes.find(n=>n.id===id)?.fixed))fail('FIXED_NODE','固定节点不允许通过模块整体修改',path)
    if(removals.includes(key)){
      document.removeNodes=[...document.removeNodes??[],...ids.map(id=>oldRefs.get(id)!)];removed.add(record!.instanceKey);continue
    }
    const change=updates[key]
    if(!change||Object.keys(change).some(k=>k!=='parameters')||!Object.hasOwn(change,'parameters'))fail('MODULE_PARAMETERS','updateModules 只接受完整 parameters',path)
    const parsed=m.parameters.safeParse(change.parameters)
    if(!parsed.success)throw new FragmentIssues(parsed.error.issues.map(i=>({code:'MODULE_PARAMETERS',message:i.message,path:path+'/parameters'+pointer(i.path.map(String)),allowedPaths:[path+'/parameters'+pointer(i.path.map(String))]})))
    const roleMap=Object.fromEntries(Object.entries(record!.roles).map(([role,id])=>[role,oldRefs.get(id)!])),recipe=normalizedRecipe(m,parsed.data)
    for(const [role,definition]of Object.entries(recipe.nodes)){
      const ref=roleMap[role]!,config=rewritePlanningConfig(definition.config,maps(new Map(Object.entries(roleMap))),false,definition.kind)
      document.updates??={};document.updates[ref]={set:config,...(oldNodes.find(n=>n.id===record!.roles[role])?.note===undefined?{description:definition.description??'模块片段：'+m.title+' · '+record!.instanceKey}:{})};owners.set(ref,path+'/parameters')
    }
    instances.push({key:record!.instanceKey,module:m,parameters:parsed.data,roles:roleMap})
  }
  for(const [key,raw]of Object.entries(declarations) as [string,any][]){
    const path=pointer([root,key,'parameters']),m=catalog.find(m=>raw?.module===m.id+'@'+m.version)
    if(!fragmentKey.safeParse(key).success)fail('MODULE_KEY','片段 key 必须为1–40字符的合法节点 key',pointer([root,key]))
    if(!m)fail('MODULE_UNKNOWN','请选择目录中的片段模块',pointer([root,key,'module']))
    if(Object.hasOwn(document[nodesRoot],key)||oldRefsHas(key)||bindings.has(key))fail('DUPLICATE_KEY','片段 key 与节点或实例重名',pointer([root,key]))
    if(Object.keys(raw).some(k=>!['module','parameters','scope'].includes(k)))fail('MODULE_DECLARATION','片段只允许 module/parameters/scope',pointer([root,key]))
    const parsed=m!.parameters.safeParse(raw.parameters)
    if(!parsed.success)throw new FragmentIssues(parsed.error.issues.map(i=>({code:'MODULE_PARAMETERS',message:i.message,path:path+pointer(i.path.map(String)),allowedPaths:[path+pointer(i.path.map(String))]})))
    let recipe:FragmentRecipe
    try{recipe=normalizedRecipe(m!,parsed.data)}catch(e){fail('MODULE_RECIPE',(e as Error).message,path)}
    try{recipeTopology(recipe!)}catch(e){fail('MODULE_RECIPE',(e as Error).message,path)}
    const roleMap=Object.fromEntries(Object.keys(recipe!.nodes).map(role=>[role,key+'__'+role]))
    for(const name of Object.values(roleMap))if(Object.hasOwn(document[nodesRoot],name)||oldRefsHas(name))fail('DUPLICATE_KEY','片段内部 key 冲突：'+name,path)
    const idMap=new Map(Object.entries(roleMap))
    const baseScope=Array.isArray(raw.scope)?raw.scope:placementScopes.get(key)??[]
    const placement=baseScope.at(-1)
    if(m!.scopes==='root'&&baseScope.length)fail('MODULE_SCOPE','该片段只允许根作用域',path)
    for(const[role,definition]of Object.entries(recipe!.nodes)){
      const scope=[...baseScope,...definition.scope?.map(r=>roleMap[r]??r)??[]]
      document[nodesRoot][roleMap[role]!]={...definition,config:rewritePlanningConfig(definition.config,maps(idMap),false,definition.kind),...(scope?{scope}:{}),description:definition.description??'模块片段：'+m!.title+' · '+key}
      owners.set(roleMap[role]!,path)
    }
    for(const[name,chain]of Object.entries(recipe!.chains)){
      if(create){document.chainsByKey??={};const ck=key+'__'+name;if(Object.hasOwn(document.chainsByKey,ck))fail('DUPLICATE_KEY','片段链 key 冲突',path);document.chainsByKey[ck]={...chain,nodes:chain.nodes.map(n=>roleMap[n]),...(chain.container?{container:roleMap[chain.container]}:placement?{container:placement}:{})}}
      else for(let i=1;i<chain.nodes.length;i++){document.addLinksByKey??={};document.addLinksByKey[key+'__'+name+i]={source:roleMap[chain.nodes[i-1]!],target:roleMap[chain.nodes[i]!]}}
    }
    for(const[name,edge]of Object.entries(recipe!.links)){const lr=create?'linksByKey':'addLinksByKey';document[lr]??={};if(Object.hasOwn(document[lr],key+'__'+name))fail('DUPLICATE_KEY','片段连线 key 冲突',path);document[lr][key+'__'+name]={...edge,source:roleMap[edge.source],target:roleMap[edge.target]}}
    bindings.set(key,{entry:roleMap[recipe!.entry]!,exit:roleMap[recipe!.exit]!,module:m!,path})
    instances.push({key,module:m!,parameters:parsed.data,roles:roleMap})
  }
  function oldRefsHas(name:string){return create?['start','result'].includes(name):[...oldRefs.values()].includes(name)}
  // Split outer chains at entry/exit. Never invent an entry→exit shortcut
  // across an internal branch or loop; recipe chains supply those connections.
  for(const [name,chain]of Object.entries(document.chainsByKey??{}) as [string,any][]){
    const segments:{nodes:string[];origin:number[]}[]=[],min=chain.container?1:2;let segment:{nodes:string[];origin:number[]}={nodes:[],origin:[]}
    chain.nodes.forEach((node:string,index:number)=>{
      const binding=bindings.get(node)
      segment.nodes.push(binding?.entry??node);segment.origin.push(index)
      if(binding&&binding.entry!==binding.exit){if(segment.nodes.length>=min)segments.push(segment);segment={nodes:[binding.exit],origin:[index]}}
    })
    if(segment.nodes.length>=min)segments.push(segment)
    if(!segments.length)delete document.chainsByKey[name]
    else for(let index=0;index<segments.length;index++){
      let key=name;if(index)for(key=name+'Part'+index;Object.hasOwn(document.chainsByKey,key);)key+='x'
      document.chainsByKey[key]={...chain,nodes:segments[index]!.nodes}
      // Diagnostics name the expanded position; the author can only patch the declared one.
      if(key!==name||segments[index]!.origin.some((at,position)=>at!==position))chains.set(key,{chain:name,origin:segments[index]!.origin})
    }
  }
  for(const lr of ['linksByKey','addLinksByKey','removeLinks'])for(const [name,edge]of Object.entries(document[lr]??{}) as [string,any][]){
    const source=bindings.get(edge.source),target=bindings.get(edge.target)
    if(source){if(edge.port&&edge.port!=='default')fail('MODULE_BRANCH_SOURCE','片段不能作为分支源',pointer([lr,name]));edge.source=source.exit}
    if(target)edge.target=target.entry
  }
  for(const refs of Object.values(document.coverage??{}) as any[])if(Array.isArray(refs))for(let i=0;i<refs.length;i++)refs[i]=bindings.get(refs[i])?.exit??refs[i]
  let location:string|undefined
  const protectedRefs=new Map<string,string>()
  for(const r of active)for(const id of Object.values(r.roles))protectedRefs.set(oldRefs.get(id)!,'/updateModules/'+instanceRefs.get(r.instanceKey)!+'/parameters')
  for(const[key,path]of owners)protectedRefs.set(key,path)
  // Generated configs may reference sibling Host roles. User parameters never
  // gain that privilege merely because they are copied into a recipe config.
  for(const instance of instances){
    const rejectPrivate=(reference:string)=>{
      if(protectedRefs.has(reference.split('.')[0]!))fail('MODULE_INTERNAL_REFERENCE','模块内部引用不可见；请使用实例声明的输出端口',owners.get(Object.values(instance.roles)[0]!)!)
      return reference
    }
    const {template,...rest}=instance.parameters
    rewritePlanningConfig({inputs:rest},maps(new Map()),false,'code','',undefined,rejectPrivate)
    if(typeof template==='string')rewritePlanningConfig(template,maps(new Map()),false,'template','text',undefined,rejectPrivate)
  }
  const rewrite=(reference:string)=>{
    const [root,port]=reference.split('.'),binding=bindings.get(root!),owner=protectedRefs.get(root!)
    if(owner&&owner!==location)fail('MODULE_INTERNAL_REFERENCE','模块内部引用不可见；请使用实例声明的输出端口',location??owner)
    if(!binding)return reference
    if(!port||!Object.hasOwn(binding.module.outputs,port)){
      const allowedPaths=[binding.path,...(location&&!location.includes('__')?[location]:[])]
      throw new FragmentIssues([{code:'MODULE_OUTPUT_PORT',message:'未声明输出端口 '+reference+'；可选端口：'+Object.keys(binding.module.outputs).join(', '),path:binding.path,allowedPaths,candidates:Object.keys(binding.module.outputs)}])
    }
    return binding.exit+reference.slice(root!.length)
  }
  for(const root of ['nodesByKey','addNodesByKey'])for(const [key,definition]of Object.entries(document[root]??{}) as [string,any][]){
    for(const field of Object.keys(definition.config??{})){location=owners.get(key)??pointer([root,key,'config',field]);definition.config[field]=rewritePlanningConfig(definition.config[field],maps(new Map()),false,definition.kind,field,new Set(Object.keys(definition.config.inputs??{})),rewrite)}
  }
  for(const [name,change]of Object.entries(document.updates??{}) as [string,any][]){const kind=change.kind??oldNodes[Number(name.slice(1))-1]?.kind;location=owners.get(name)??pointer(['updates',name,'set']);if(change.set&&kind)change.set=rewritePlanningConfig(change.set,maps(new Map()),false,kind,'',undefined,rewrite)}
  for(const instance of instances)instance.parameters=rewriteFragmentParameters(instance.parameters,new Map([...bindings].map(([key,b])=>[key,b.exit])))
  delete document.modules;delete document.addModules;delete document.updateModules;delete document.removeModules
  return {document,instances,removed,owners,chains}
}

/** Preserve the public 40-character key contract and existing compiler limits.
 * Long generated key__role names get private short aliases at the core boundary;
 * persisted roles always contain the actual Host node identities. */
/** Maps a pointer into an expanded chain back to the chain and position the author declared. */
export function authoredChainPath(chains:FragmentExpansion['chains'],path:string):string{
  const parts=pointerParts(path),split=parts[0]==='chainsByKey'?chains.get(parts[1]!):undefined
  if(!split)return path
  const at=parts[2]==='nodes'&&parts[3]!==undefined?split.origin[Number(parts[3])]:undefined
  return pointer(['chainsByKey',split.chain,...(at===undefined?parts.slice(2):['nodes',String(at),...parts.slice(4)])])
}
export function bindFragmentKeys(expansion:FragmentExpansion):void {
  const doc=expansion.document,rename=new Map<string,string>(),used=new Set<string>([
    ...Object.keys(doc?.nodesByKey??{}),...Object.keys(doc?.addNodesByKey??{}),...expansion.instances.map(i=>i.key),
  ])
  let index=0
  for(const key of expansion.owners.keys())if(key.length>40){let alias:string;do{alias='hostFragment'+(++index)}while(used.has(alias));used.add(alias);rename.set(key,alias)}
  const shortConnections=()=>{
    for(const root of ['chainsByKey','linksByKey','addLinksByKey'])if(doc?.[root])doc[root]=Object.fromEntries(Object.entries(doc[root]).map(([key,value])=>{
      if(key.length<=40)return [key,value]
      const owner=expansion.instances.find(i=>key.startsWith(i.key+'__'))
      if(!owner)return [key,value]
      let alias:string;do{alias='hostFragmentLink'+(++index)}while(used.has(alias));used.add(alias);expansion.owners.set(alias,'/modules/'+owner.key+'/parameters');return [alias,value]
    }))
  }
  if(!rename.size){shortConnections();return}
  const ref=(key:string)=>rename.get(key)??key
  for(const root of ['nodesByKey','addNodesByKey'])if(doc[root])doc[root]=Object.fromEntries(Object.entries(doc[root]).map(([key,node]:[string,any])=>[ref(key),{...node,...(node.scope?{scope:node.scope.map(ref)}:{}),config:rewritePlanningConfig(node.config,maps(rename),false,node.kind)}]))
  for(const chain of Object.values(doc.chainsByKey??{}) as any[]){chain.nodes=chain.nodes.map(ref);if(chain.container)chain.container=ref(chain.container)}
  for(const root of ['linksByKey','addLinksByKey','removeLinks'])for(const edge of Object.values(doc[root]??{}) as any[]){edge.source=ref(edge.source);edge.target=ref(edge.target);if(edge.scope)edge.scope=edge.scope.map(ref)}
  for(const refs of Object.values(doc.coverage??{}) as string[][])for(let i=0;i<refs.length;i++)refs[i]=ref(refs[i]!)
  for(const instance of expansion.instances){instance.roles=Object.fromEntries(Object.entries(instance.roles).map(([role,key])=>[role,ref(key)]));instance.parameters=rewriteFragmentParameters(instance.parameters,rename)}
  for(const[key,path]of [...expansion.owners])if(rename.has(key)){expansion.owners.delete(key);expansion.owners.set(ref(key),path)}
  shortConnections()
}
