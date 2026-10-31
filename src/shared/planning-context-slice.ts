import { z } from 'zod'
import type { PlanningContext } from './planning-types.ts'
import { allNodes } from './workflow-validation.ts'
import type { NodeGraph } from './types.ts'
import { createReferenceScopePlan, dataInterpolationReferences, withReferenceVariables, type ReferenceScope } from './reference-scope.ts'

/** Host-derived input selection. Read dependencies never enlarge edit permissions. */
export const planningContextSelectionSchema=z.object({
  targetNodeIds:z.array(z.string().min(1).max(160)).max(200).optional(),
  targetFields:z.record(z.string().min(1).max(160),z.array(z.string().min(1).max(160)).max(100)).optional(),
  topologyChanged:z.boolean().optional(),outputChanged:z.boolean().optional(),
  templateIds:z.array(z.string().min(1).max(160)).max(12).optional(),
}).strict()
export type PlanningContextSelection=z.infer<typeof planningContextSelectionSchema>
export function contextSelection(context:PlanningContext):PlanningContextSelection|undefined {
  return (context as PlanningContext&{contextSelection?:PlanningContextSelection}).contextSelection
}
const displayFields=new Set(['title','note','description','number','x','y'])
// These fields can change output names/types, loop state or legal control ports.
const exposedFields=new Set(['outputSchema','fields','kind','body','outputVariable','assignments','initialVariables','cases','classes','actions','logicGate','toolId'])
export function selectedConfigFields(fields:readonly string[]|undefined):string[]|undefined {
  return fields?.filter(f=>!displayFields.has(f)).map(f=>f.replace(/^(?:config|values)\./,'').split('.')[0]!)
}
/** A known same-type field task. This selects contracts, never grants edit rights. */
export function focusedPlanningFields(context:PlanningContext):Map<string,readonly string[]>|undefined {
  const selection=contextSelection(context)
  if(context.operation!=='revise'||!selection?.targetFields||selection.topologyChanged||selection.templateIds?.length)return
  const targets=selection.targetNodeIds?.length?selection.targetNodeIds:context.targetNodeIds
  if(!targets.length||targets.some(id=>!selection.targetFields![id]?.length))return
  const nodes=new Set(allNodes(context.workflow).map(node=>node.id)),result=new Map<string,readonly string[]>()
  for(const id of targets){
    const fields=selection.targetFields[id]!
    if(!nodes.has(id)||selectedConfigFields(fields)?.some(field=>['kind','template','body'].includes(field)))return
    result.set(id,fields)
  }
  return result
}
// Split only outside quoted literals and static brackets. Unsupported syntax
// stays unknown rather than extracting a plausible node root from arbitrary text.
function splitExpression(source:string,separator:string):string[]|undefined {
  const parts:string[]=[],stack:string[]=[];let quote='',start=0
  for(let i=0;i<source.length;i++){
    const char=source[i]!
    if(quote){if(char==='\\')i++;else if(char===quote)quote='';continue}
    if(char==='"'||char==="'"){quote=char;continue}
    if('([{'.includes(char))stack.push(char)
    else if(')]}'.includes(char)&&stack.pop()!=='([{'.charAt(')]}'.indexOf(char)))return
    if(!stack.length&&source.startsWith(separator,i)){parts.push(source.slice(start,i).trim());i+=separator.length-1;start=i+1}
  }
  if(quote||stack.length)return
  parts.push(source.slice(start).trim());return parts
}
function dependencyPath(source:string):string[]|undefined {
  const normalized=source.trim().replace(/\[(['"])([A-Za-z0-9_-]+)\1\]/g,'.$2').replace(/\[(\d+)\]/g,'.$1')
  if(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(normalized))return normalized.split('.')
}
/** The shared parser owns interpolation boundaries and the compiled scope owns
 * vars/item/index visibility. Template-only locals never mask config.inputs. */
function nodeDependencies(config:Record<string,unknown>,kind:string,scope:ReferenceScope,link:(id:string)=>void):boolean {
  let unknown=false
  const reference=(source:string,locals:ReadonlySet<string>)=>{
    const path=dependencyPath(source),root=path?.[0]
    if(!root){unknown=true;return}
    if(locals.has(root)||['input','inputs','env','sys'].includes(root))return
    if(root==='vars'){if(path.length===1||scope.variables.has(path[1]!))return}
    else if(root==='item'){if(scope.hasItem)return}
    else if(root==='index'){if(scope.hasIndex)return}
    else if(scope.knownNodeIds.has(root)){link(root);return}
    unknown=true
  }
  const expression=(source:string,locals:ReadonlySet<string>)=>{
    const text=source.trim()
    for(const separator of [' or ',' and ',' == ',' != ',' >= ',' <= ',' > ',' < ',' in ']){
      const parts=splitExpression(text,separator)
      if(!parts){unknown=true;return}
      if(parts.length>1){parts.forEach(part=>expression(part,locals));return}
    }
    if(text.startsWith('not ')){expression(text.slice(4),locals);return}
    if(text.endsWith(' is defined')){expression(text.slice(0,-11),locals);return}
    const filters=splitExpression(text,'|')!
    if(filters.length>1){
      expression(filters[0]!,locals)
      for(const filter of filters.slice(1)){
        const match=filter.match(/^[a-z_]+(?:\((.*)\))?$/)
        if(!match){unknown=true;continue}
        if(match[1]?.trim())for(const arg of splitExpression(match[1],',')??[])expression(arg,locals)
      }
      return
    }
    if(/^(?:true|True|false|False|none|None|null|-?\d+(?:\.\d+)?)$/.test(text))return
    if(/^'(?:[^'\\]|\\.)*'$/.test(text))return
    try{JSON.parse(text);return}catch{/* A non-literal must be a static reference. */}
    reference(text,locals)
  }
  const template=(source:string)=>{
    let locals=new Set(Object.keys((config.inputs??{}) as object))
    const stack:{kind:'for'|'if';locals:Set<string>}[]=[]
    const remainder=source.replace(/\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}|\{#[\s\S]*?#\}/g,(token,output:string|undefined,statement:string|undefined)=>{
      if(output!==undefined){
        const parsed=dataInterpolationReferences(token)
        if(parsed.invalid)unknown=true
        parsed.references.forEach(name=>expression(name,locals));return ''
      }
      if(statement===undefined)return ''
      const command=statement.trim(),loop=command.match(/^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+)$/)
      if(loop){expression(loop[2]!,locals);stack.push({kind:'for',locals});locals=new Set([...locals,loop[1]!,'loop'])}
      else if(command.startsWith('if ')){expression(command.slice(3),locals);stack.push({kind:'if',locals})}
      else if(command==='else'||command.startsWith('elif ')){
        const frame=stack.at(-1)
        if(!frame||command.startsWith('elif ')&&frame.kind!=='if')unknown=true
        if(frame?.kind==='for')locals=frame.locals
        if(command.startsWith('elif '))expression(command.slice(5),locals)
      }else if(command==='endfor'||command==='endif'){
        const frame=stack.pop()
        if(!frame||command!==`end${frame.kind}`)unknown=true
        if(frame)locals=frame.locals
      }else unknown=true
      return ''
    })
    if(stack.length||/\{\{|\}\}|\{%|%\}|\{#|#\}/.test(remainder))unknown=true
  }
  const strings=(value:unknown):void=>{
    if(typeof value==='string'){
      const parsed=dataInterpolationReferences(value)
      if(parsed.invalid||/\{%|%\}/.test(value))unknown=true
      parsed.references.forEach(name=>reference(name,new Set()))
      // Retain bare reference fields such as iterator/outputVariable/condition.
      const direct=dependencyPath(value)
      if(direct&&direct.length>1&&scope.knownNodeIds.has(direct[0]!))link(direct[0]!)
    }else if(value&&typeof value==='object')Object.values(value).forEach(strings)
  }
  for(const [key,value] of Object.entries(config)){
    if(kind==='template'&&key==='text'&&typeof value==='string')template(value)
    else if(kind==='assigner'&&key==='assignments'&&Array.isArray(value)){
      for(const assignment of value){strings(assignment.value);scope=withReferenceVariables(scope,[assignment.name])}
    }else strings(value)
  }
  return unknown
}
/** One dependency traversal used by initial projection and exact batch retrieval. */
export function planningContextSlice(context:PlanningContext,selection:PlanningContextSelection|undefined=contextSelection(context)) {
  const nodes=allNodes(context.workflow),byId=new Map(nodes.map(n=>[n.id,n]))
  const upstream=new Map<string,Set<string>>(),downstream=new Map<string,Set<string>>(),parents=new Map<string,string[]>(),reasons=new Map<string,Set<string>>()
  const unknown=new Set<string>()
  const link=(source:string,target:string)=>{
    if(!byId.has(source)||!byId.has(target))return
    if(!upstream.has(target))upstream.set(target,new Set())
    if(!downstream.has(source))downstream.set(source,new Set())
    upstream.get(target)!.add(source);downstream.get(source)!.add(target)
  }
  const visit=(graph:NodeGraph,scope:string[])=>{
    for(const n of graph.nodes){parents.set(n.id,scope);if(n.config.body)visit(n.config.body,[...scope,n.id])}
    for(const e of graph.edges)link(e.source,e.target)
  }
  visit(context.workflow,[])
  const referencePlan=createReferenceScopePlan(context.workflow)
  for(const node of nodes){
    const {body:_,...config}=node.config
    if(nodeDependencies(config,node.kind,referencePlan.nodes.get(node.id)!,id=>link(id,node.id)))unknown.add(node.id)
  }
  const requested=selection?.targetNodeIds?.length?selection.targetNodeIds:context.targetNodeIds
  for(const id of requested)if(!byId.has(id))throw new Error('规划目标节点不存在或已删除: '+id)
  const permitted=new Set(context.targetNodeIds.length?context.targetNodeIds:nodes.map(n=>n.id))
  const targetNodeIds=requested.length?[...new Set(requested)]:nodes.map(n=>n.id)
  const editableNodeIds=targetNodeIds.filter(id=>permitted.has(id)&&!byId.get(id)!.fixed&&!(parents.get(id)??[]).some(parent=>byId.get(parent)?.fixed))
  const read=new Set<string>()
  const add=(id:string,reason:string)=>{read.add(id);if(!reasons.has(id))reasons.set(id,new Set());reasons.get(id)!.add(reason)}
  const walk=(seeds:readonly string[],edges:Map<string,Set<string>>,reason:string)=>{
    const seen=new Set(seeds),queue=[...seeds]
    for(let i=0;i<queue.length;i++)for(const id of edges.get(queue[i]!)??[])if(!seen.has(id)){seen.add(id);queue.push(id);add(id,reason)}
  }
  for(const id of targetNodeIds)add(id,'target')
  const executionTargets=targetNodeIds.filter(id=>{
    const fields=selection?.targetFields?.[id]
    return selection?.topologyChanged||selection?.outputChanged||!fields?.length||fields.some(f=>!displayFields.has(f))
  })
  walk(executionTargets,upstream,'upstream-contract')
  const outputTargets=executionTargets.filter(id=>selection?.topologyChanged||selection?.outputChanged||!selection?.targetFields?.[id]?.length||selectedConfigFields(selection.targetFields[id])!.some(field=>exposedFields.has(field)))
  // A nested mutation may alter the exported state of every enclosing loop,
  // including its default variables result with no outputVariable reference.
  const exposedContainers=[...new Set(outputTargets.flatMap(id=>parents.get(id)??[]))]
  for(const id of exposedContainers){
    add(id,'container-output-contract')
    for(const child of nodes)if(parents.get(child.id)?.includes(id))add(child.id,'container-output-contract')
  }
  walk([...outputTargets,...exposedContainers],downstream,'affected-downstream')
  // A changed container owns its descendants, including loop carried state.
  for(const id of executionTargets)if(byId.get(id)?.config.body)for(const node of nodes)if(parents.get(node.id)?.includes(id))add(node.id,'container-body')
  let previous=-1
  while(previous!==read.size){
    previous=read.size
    for(const id of [...read])for(const parent of parents.get(id)??[])add(parent,'container-contract')
    if(executionTargets.length)walk([...read],upstream,'upstream-contract')
    if(executionTargets.length&&([...read].some(id=>unknown.has(id))||outputTargets.length&&unknown.size))for(const node of nodes)add(node.id,'dynamic-dependency')
  }
  return {targetNodeIds,readNodeIds:nodes.filter(n=>read.has(n.id)).map(n=>n.id),editableNodeIds,
    reasons:Object.fromEntries([...reasons].map(([id,why])=>[id,[...why]])),
    conservative:[...read].some(id=>unknown.has(id)),
  }
}
