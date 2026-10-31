import type { EnvironmentVariable, JsonValue, NodeGraph, ValidationIssue, Workflow, WorkflowNode } from './types.ts'
import { SECRET_UNAVAILABLE_REASON, SYSTEM_VARIABLES } from './workflow-variables.ts'

export interface ReferenceScope {
  readonly nodeId:string
  readonly nodeIds:ReadonlySet<string>
  readonly knownNodeIds:ReadonlySet<string>
  readonly knownVariables:ReadonlySet<string>
  readonly variables:ReadonlySet<string>
  /** Static guarantees; nodeIds/variables remain the runtime's may-access scope. */
  readonly mustNodeIds?:ReadonlySet<string>
  readonly mustVariables?:ReadonlySet<string>
  /** Completed bodies only: guarantees of a pass that ended without Exit Loop. */
  readonly passMustNodeIds?:ReadonlySet<string>
  readonly passMustVariables?:ReadonlySet<string>
  readonly hasItem:boolean
  readonly hasIndex:boolean
  readonly environmentVariables?:ReadonlyMap<string,EnvironmentVariable>
}
export interface ReferenceScopePlan {
  nodes:Map<string,ReferenceScope>
  completedBodies:Map<string,ReferenceScope>
}
export class ReferenceScopeError extends Error {}
export class InvalidReferenceError extends ReferenceScopeError {}
const unsafe=new Set(['__proto__','prototype','constructor'])
const fieldNames=(node:WorkflowNode)=>node.kind==='assigner'?(node.config.assignments??[]).map(item=>item.name):[]

/** Reduced multi-way decision diagrams retain correlations between routes without
 * enumerating every combination of branches. Ordinary forks activate every edge;
 * a join waits for all edges to settle, then runs if any was taken (Graphon).
 * Thus a producer is guaranteed exactly when consumer => producer is a tautology. */
export function executionConditions(graph:NodeGraph) {
  const byId=new Map(graph.nodes.map(node=>[node.id,node])),incoming=new Map(graph.nodes.map(node=>[node.id,[] as NodeGraph['edges']]))
  for(const edge of graph.edges)if(byId.has(edge.source)&&byId.has(edge.target))incoming.get(edge.target)!.push(edge)
  const decisions=new Map<string,{rank:number;ports:string[]}>()
  for(const node of graph.nodes){
    const c=node.config
    const ports=node.kind==='if'?(c.cases?.length&&!c.logicGate?[...c.cases.map(branch=>branch.id),'false']:['true','false'])
      :node.kind==='classifier'?(c.classes??[]).map(category=>category.id)
      :node.kind==='human'?[...(c.actions??[{id:'continue'}]).map(action=>action.id),...(graph.edges.some(edge=>edge.source===node.id&&edge.port==='timeout')?['timeout']:[])]:undefined
    if(ports?.length)decisions.set(node.id,{rank:decisions.size,ports:[...new Set(ports)]})
  }
  const domains=[...decisions.values()].map(decision=>decision.ports.length)
  // IDs 0/1 are false/true. All other IDs are canonical ordered decisions.
  const diagrams:{rank:number;children:number[]}[]=[{rank:Infinity,children:[]},{rank:Infinity,children:[]}],unique=new Map<string,number>(),memo=new Map<string,number>()
  const decision=(rank:number,children:number[]):number=>{
    if(children.every(child=>child===children[0]))return children[0]!
    const key=`${rank}:${children.join(',')}`,known=unique.get(key)
    if(known!==undefined)return known
    const id=diagrams.length;diagrams.push({rank,children});unique.set(key,id);return id
  }
  const combine=(op:'and'|'or',a:number,b:number):number=>{
    if(a===b)return a
    if(op==='and'){if(!a||!b)return 0;if(a===1)return b;if(b===1)return a}
    else {if(a===1||b===1)return 1;if(!a)return b;if(!b)return a}
    const key=`${op}:${Math.min(a,b)}:${Math.max(a,b)}`,known=memo.get(key)
    if(known!==undefined)return known
    const left=diagrams[a]!,right=diagrams[b]!,rank=Math.min(left.rank,right.rank)
    const result=decision(rank,Array.from({length:domains[rank]!},(_,i)=>combine(op,left.rank===rank?left.children[i]!:a,right.rank===rank?right.children[i]!:b)))
    memo.set(key,result);return result
  }
  const conditions=new Map<string,number>()
  const active=(id:string):number=>{
    const known=conditions.get(id);if(known!==undefined)return known
    // Invalid cyclic drafts are diagnosed by graph validation; keep this pass finite.
    conditions.set(id,0)
    const node=byId.get(id)!
    let result=node.kind==='input'?1:0
    for(const edge of incoming.get(id)??[]){
      const route=decisions.get(edge.source),port=edge.port??'default'
      const selected=route?decision(route.rank,route.ports.map(choice=>Number(choice===port||(byId.get(edge.source)!.kind==='human'&&port==='default'&&choice!=='timeout')))):1
      result=combine('or',result,combine('and',active(edge.source),selected))
    }
    conditions.set(id,result);return result
  }
  for(const node of graph.nodes)active(node.id)
  const route=(id:string,port:string)=>{
    const item=decisions.get(id)
    return item?combine('and',active(id),decision(item.rank,item.ports.map(choice=>Number(choice===port)))):0
  }
  return {active,route,union:(a:number,b:number)=>combine('or',a,b),implies:(consumer:number,producer:number)=>combine('and',consumer,producer)===consumer}
}

/** Inspect original strings so JSON escaping cannot hide a supported bracket
 * reference from edit guards. Containers include their descendants. */
export function referencesEnvironmentVariable(node:WorkflowNode,id:string):boolean {
  const visit=(value:unknown):boolean=>{
    if(typeof value==='string')return [...value.matchAll(/(?:^|[^A-Za-z0-9_-])env(?:\.([A-Za-z0-9_-]+)|\[['"]([A-Za-z0-9_-]+)['"]\])/g)].some(match=>(match[1]??match[2])===id)
    return !!value&&typeof value==='object'&&Object.values(value).some(visit)
  }
  return node.config.credentialOperation?.secretVariableId===id||visit(node.config)||!!node.config.body?.nodes.some(child=>referencesEnvironmentVariable(child,id))
}

/** Compile dependency access, never arrival order. A child inherits the context
 * before its container runs, not the container's future result or sibling data. */
export function createReferenceScopePlan(graph:NodeGraph):ReferenceScopePlan {
  const knownNodeIds=new Set<string>(),knownVariables=new Set<string>(),nodes=new Map<string,ReferenceScope>(),completedBodies=new Map<string,ReferenceScope>()
  const collect=(current:NodeGraph)=>{for(const node of current.nodes){knownNodeIds.add(node.id);for(const name of fieldNames(node))knownVariables.add(name);if(node.kind==='loop')for(const name of Object.keys(node.config.initialVariables??{}))knownVariables.add(name);if(node.config.body)collect(node.config.body)}}
  collect(graph)
  const visit=(current:NodeGraph,inherited:ReferenceScope):ReturnType<typeof executionConditions>=>{
    const byId=new Map(current.nodes.map(node=>[node.id,node])),parents=new Map(current.nodes.map(node=>[node.id,[] as string[]]))
    const conditions=executionConditions(current)
    for(const edge of current.edges)if(byId.has(edge.source)&&byId.has(edge.target))parents.get(edge.target)!.push(edge.source)
    const ancestors=(id:string)=>{
      const result=new Set<string>(),seen=new Set([id]),pending=[...(parents.get(id)??[])]
      for(let at=0;at<pending.length;at++){const candidate=pending[at]!;if(seen.has(candidate))continue;seen.add(candidate);result.add(candidate);pending.push(...(parents.get(candidate)??[]))}
      return result
    }
    for(const node of current.nodes){
      const upstream=ancestors(node.id),variables=new Set(inherited.variables),mustNodeIds=new Set(inherited.mustNodeIds),mustVariables=new Set(inherited.mustVariables),writers=new Map<string,number>()
      for(const id of upstream){
        if(conditions.implies(conditions.active(node.id),conditions.active(id)))mustNodeIds.add(id)
        for(const name of fieldNames(byId.get(id)!)){variables.add(name);writers.set(name,conditions.union(writers.get(name)??0,conditions.active(id)))}
      }
      for(const [name,available] of writers)if(conditions.implies(conditions.active(node.id),available))mustVariables.add(name)
      const scope:ReferenceScope={...inherited,nodeId:node.id,nodeIds:new Set([...inherited.nodeIds,...upstream]),variables,mustNodeIds,mustVariables}
      nodes.set(node.id,scope)
      if(node.config.body){
        const initial=node.kind==='loop'?Object.keys(node.config.initialVariables??{}):[]
        const bodyScope:ReferenceScope={...scope,nodeIds:new Set(scope.nodeIds),variables:new Set([...scope.variables,...initial]),mustVariables:new Set([...mustVariables,...initial]),hasItem:scope.hasItem||node.kind==='iteration',hasIndex:true}
        const bodyConditions=visit(node.config.body,bodyScope),bodyWriters=new Map<string,number>()
        for(const child of node.config.body.nodes)for(const name of fieldNames(child))bodyWriters.set(name,bodyConditions.union(bodyWriters.get(name)??0,bodyConditions.active(child.id)))
        // `until` is evaluated only after a pass without Exit Loop, and an
        // iteration rethrows Exit Loop instead of reading its output. A loop
        // breaks on Exit Loop and still reads outputVariable from that pass.
        const body=node.config.body,exited=body.nodes.filter(child=>child.kind==='exit_loop').reduce((all,child)=>bodyConditions.union(all,bodyConditions.active(child.id)),0)
        const guarantees=(excuse:number)=>{
          const guaranteed=(available:number)=>bodyConditions.union(available,excuse)===1
          return {nodeIds:new Set([...mustNodeIds,...body.nodes.filter(child=>guaranteed(bodyConditions.active(child.id))).map(child=>child.id)]),
            variables:new Set([...bodyScope.mustVariables!,...[...bodyWriters].filter(([,available])=>guaranteed(available)).map(([name])=>name)])}
        }
        const pass=guarantees(exited),output=node.kind==='loop'?guarantees(0):pass
        completedBodies.set(node.id,{...bodyScope,nodeIds:new Set([...bodyScope.nodeIds,...node.config.body.nodes.map(child=>child.id)]),variables:new Set([...bodyScope.variables,...node.config.body.nodes.flatMap(fieldNames)]),
          mustNodeIds:output.nodeIds,mustVariables:output.variables,passMustNodeIds:pass.nodeIds,passMustVariables:pass.variables})
      }
    }
    return conditions
  }
  visit(graph,{nodeId:'',nodeIds:new Set(),knownNodeIds,knownVariables,variables:new Set(),mustNodeIds:new Set(),mustVariables:new Set(),hasItem:false,hasIndex:false,environmentVariables:new Map(((graph as Partial<Workflow>).environmentVariables??[]).map(variable=>[variable.id,variable]))})
  return {nodes,completedBodies}
}

/** allowMissing only tolerates a name absent from the entire graph. A known
 * forbidden node is always rejected, including optional template/merge inputs. */
export function assertReferenceAllowed(name:string,scope:ReferenceScope,options:{allowMissing?:boolean}={}):void {
  const reference=name.trim().replace(/^\{\{\s*|\s*\}\}$/g,''),[root,...path]=reference.split('.')
  if(reference.startsWith('#')||reference.endsWith('#'))throw new InvalidReferenceError(`变量引用 ${reference} 使用了不支持的 # 包裹；请使用 {{节点ID.字段}} 或 {{input.字段}}`)
  if(!root||[root,...path].some(part=>unsafe.has(part)))throw new ReferenceScopeError(`${root==='sys'?'系统变量':root==='env'?'环境变量':'变量'}引用 ${reference} 无效`)
  if(root==='input')return
  if(root==='env'){
    const variable=path.length===1?scope.environmentVariables?.get(path[0]!):undefined
    if(!variable)throw new ReferenceScopeError(`环境变量引用 ${reference} 未声明；请使用稳定变量身份`)
    if(variable.type==='secret')throw new ReferenceScopeError(`Secret ${variable.name}：${SECRET_UNAVAILABLE_REASON}`)
    return
  }
  if(root==='sys'){
    const variable=path.length===1?SYSTEM_VARIABLES.find(item=>item.name===path[0]):undefined
    if(!variable?.supported)throw new ReferenceScopeError(`系统变量 ${reference} 不存在或暂不支持`)
    return
  }
  if(root==='item'){if(!scope.hasItem)throw new ReferenceScopeError('item 仅在迭代内部作用域可用');return}
  if(root==='index'){if(!scope.hasIndex)throw new ReferenceScopeError('index 仅在容器内部作用域可用');return}
  if(root==='vars'){
    if(path.length&&!options.allowMissing&&!scope.knownVariables.has(path[0]!)&&!scope.variables.has(path[0]!))throw new InvalidReferenceError(`变量引用 vars.${path[0]} 未声明`)
    if(path.length&&!scope.variables.has(path[0]!)&&!(options.allowMissing&&!scope.knownVariables.has(path[0]!)))throw new ReferenceScopeError(`变量 vars.${path[0]} 不在当前节点的依赖作用域内`)
    return
  }
  if(scope.nodeIds.has(root))return
  if(options.allowMissing&&!scope.knownNodeIds.has(root))return
  if(!scope.knownNodeIds.has(root))throw new InvalidReferenceError(`节点引用 ${reference} 不存在；请使用图中真实的稳定节点 ID`)
  throw new ReferenceScopeError(`节点引用 ${reference} 不在当前节点的上游依赖作用域内`)
}

/** Assignment statements may consume values written by an earlier statement in
 * this same node. Extending a context never mutates the shared compiled plan. */
export function withReferenceVariables(scope:ReferenceScope,names:Iterable<string>):ReferenceScope {
  const added=[...names]
  return {...scope,variables:new Set([...scope.variables,...added]),mustVariables:new Set([...(scope.mustVariables??scope.variables),...added])}
}
/** Bare {{vars}} must not expose variables written by an unrelated sibling that
 * happened to run earlier. Field references are checked by the guard above. */
export function visibleReferenceVariables<T>(values:Record<string,T>,scope:ReferenceScope):Record<string,T> {
  return Object.fromEntries(Object.entries(values).filter(([name])=>scope.variables.has(name)))
}

function splitOutside(source:string,separator:string):string[] {
  const result:string[]=[];let depth=0,quote='',start=0
  for(let i=0;i<source.length;i++){
    const char=source[i]!
    if(quote){if(char==='\\')i++;else if(char===quote)quote='';continue}
    if(char==='"'||char==="'"){quote=char;continue}
    if('([{'.includes(char))depth++
    if(')]}'.includes(char))depth--
    if(!depth&&source.slice(i,i+separator.length)===separator){result.push(source.slice(start,i).trim());start=i+separator.length;i+=separator.length-1}
  }
  result.push(source.slice(start).trim());return result
}
type Check=(name:string,scope:ReferenceScope,allowMissing?:boolean,syntaxError?:string)=>void
function expression(source:string,scope:ReferenceScope,locals:ReadonlySet<string>,check:Check,allowMissing=false):void {
  const text=source.trim()
  // Conditional operators bind outside a filtered operand, as in the runtime's
  // truth() parser: value|default("") == other.text must inspect both operands.
  for(const separator of [' or ',' and ',' == ',' != ',' >= ',' <= ',' > ',' < ',' in ']){
    const parts=splitOutside(text,separator)
    if(parts.length>1){for(const part of parts)expression(part,scope,locals,check,allowMissing);return}
  }
  if(text.startsWith('not ')){expression(text.slice(4),scope,locals,check,allowMissing);return}
  if(text.endsWith(' is defined')){expression(text.slice(0,-11),scope,locals,check,true);return}
  const filters=splitOutside(text,'|')
  if(filters.length>1){
    expression(filters[0]!,scope,locals,check,allowMissing||filters.slice(1).some(filter=>/^default(?:\s*\(|$)/.test(filter)))
    for(const filter of filters.slice(1)){
      const args=filter.match(/^[a-z_]+\((.*)\)$/)?.[1]
      if(args)for(const arg of splitOutside(args,','))expression(arg,scope,locals,check,allowMissing)
    }
    return
  }
  if(!text||/^(?:true|True|false|False|none|None|null|-?\d+(?:\.\d+)?)$/.test(text))return
  if((text.startsWith('"')&&text.endsWith('"'))||(text.startsWith("'")&&text.endsWith("'"))||text.startsWith('[')||text.startsWith('{'))return
  const path=text.replace(/\[['"]([A-Za-z0-9_-]+)['"]\]/g,'.$1').replace(/\[(\d+)\]/g,'.$1')
  if(!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(path)){
    if(text.startsWith('#')||text.endsWith('#'))check(text,scope,allowMissing)
    return // Other unsupported expressions fail in the template parser, never execute JS.
  }
  if(!locals.has(path.split('.')[0]!))check(path,scope,allowMissing)
}
function templateReferences(source:string,scope:ReferenceScope,names:Iterable<string>,check:Check):void {
  let locals=new Set(names)
  const stack:{kind:'for'|'if';locals:Set<string>;defined:string[];elseDefined:string[]}[]=[]
  const guards=(condition:string):{defined:string[];elseDefined:string[]}=>{
    const match=condition.trim().match(/^(not\s+)?([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s+is defined$/)
    return {defined:match&&!match[1]?[match[2]!]:[],elseDefined:match?.[1]?[match[2]!]:[]}
  }
  const guardedCheck:Check=(name,current,allowMissing=false)=>check(name,current,allowMissing||stack.some(frame=>frame.defined.some(guard=>name===guard||name.startsWith(`${guard}.`))))
  for(const match of source.matchAll(/\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}|\{#[\s\S]*?#\}/g)){
    if(match[1]!==undefined){expression(match[1],scope,locals,guardedCheck);continue}
    if(match[2]===undefined)continue
    const command=match[2].trim(),loop=command.match(/^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+)$/)
    if(loop){expression(loop[2]!,scope,locals,guardedCheck);stack.push({kind:'for',locals,defined:[],elseDefined:[]});locals=new Set([...locals,loop[1]!,'loop'])}
    else if(command.startsWith('if ')){expression(command.slice(3),scope,locals,guardedCheck,true);stack.push({kind:'if',locals,...guards(command.slice(3))})}
    else if(command==='else'||command.startsWith('elif ')){
      const frame=stack.at(-1)
      // An empty for renders its fallback with the enclosing locals. Neither
      // this loop's item nor its loop metadata exists in the fallback branch.
      if(frame?.kind==='for')locals=frame.locals
      if(frame?.kind==='if'){
        frame.defined=[]
        if(command.startsWith('elif ')){expression(command.slice(5),scope,locals,guardedCheck,true);Object.assign(frame,guards(command.slice(5)))}
        else frame.defined=frame.elseDefined
      }
    }
    else if(command==='endfor'||command==='endif'){const previous=stack.pop();if(previous)locals=previous.locals}
  }
}
/** Plain data interpolation grammar, matching runtime render/resolve. Rich
 * template expressions use templateReferences instead of this path scanner. */
export function dataInterpolationReferences(source:string):{references:string[];invalid:boolean}{
  const references:string[]=[];let invalid=false
  const literal=source.replace(/\{\{\s*([^{}]+?)\s*\}\}/g,(_match,name:string)=>{
    const reference=name.trim()
    if(reference)references.push(reference);else invalid=true
    return ''
  })
  return {references,invalid:invalid||/\{\{|\}\}/.test(literal)}
}
function interpolations(source:string|undefined,scope:ReferenceScope,check:Check):void {
  const parsed=dataInterpolationReferences(source??'')
  if(parsed.invalid)check('',scope,false,'模板变量引用为空或括号不完整')
  for(const name of parsed.references)check(name,scope)
}
function dataReferences(value:JsonValue|undefined,scope:ReferenceScope,check:Check):void {
  if(typeof value==='string')interpolations(value,scope,check)
  else if(Array.isArray(value))for(const item of value)dataReferences(item,scope,check)
  else if(value&&typeof value==='object')for(const item of Object.values(value))dataReferences(item,scope,check)
}

/** Validate only strings which the runtime actually resolves. Code, descriptions,
 * literal source paths and strings inside literal iterator arrays are not code. */
export function referenceScopeIssues(graph:NodeGraph,options:{strictMissing?:boolean}={}):(ValidationIssue&{code?:'INVALID_REFERENCE'})[] {
  const plan=createReferenceScopePlan(graph),issues:(ValidationIssue&{code?:'INVALID_REFERENCE'})[]=[]
  const inputFields=new Set((graph.nodes.find(node=>node.kind==='input')?.config.fields??[]).map(field=>field.name))
  let currentNode=''
  // Draft/runtime checks preserve optional merge and missing-value behavior.
  // Planning requires real producers for required reads before publication;
  // default/defined/conditional expressions still explicitly permit absence.
  const check:Check=(name,scope,allowMissing=false,syntaxError)=>{try{
    if(syntaxError)throw new InvalidReferenceError(syntaxError)
    assertReferenceAllowed(name,scope,{allowMissing:!options.strictMissing||allowMissing})
    const reference=name.trim().replace(/^\{\{\s*|\s*\}\}$/g,''),[root,field]=reference.split('.')
    const conditional=root==='vars'?!!field&&scope.variables.has(field)&&!scope.mustVariables?.has(field)
      :!['input','env','sys','item','index'].includes(root!)&&scope.nodeIds.has(root!)&&!scope.mustNodeIds?.has(root!)
    if(!allowMissing&&conditional)throw new ReferenceScopeError(`引用 ${reference} 在某些分支下不可用；请改用聚合节点/变量，或在两个分支上都产出所需值`)
  }catch(error){issues.push({nodeId:currentNode,message:toolNameHint(name,error instanceof Error?error.message:String(error)),...(error instanceof InvalidReferenceError?{code:'INVALID_REFERENCE' as const}:{})})}}
  // A reference rooted at a tool's name (glob.value.paths) means that tool's node; name it,
  // or the repair falls back to hard-coding the trial's values (Desktop r48).
  const toolNodes=new Map<string,string[]>(),index=(current:NodeGraph)=>{for(const node of current.nodes){const tool=node.kind==='tool'?node.config.toolId?.split(':')[1]:undefined;if(tool)toolNodes.set(tool,[...toolNodes.get(tool)??[],node.id]);if(node.config.body)index(node.config.body)}}
  index(graph)
  const toolNameHint=(name:string,message:string)=>{
    const reference=name.trim().replace(/^\{\{\s*|\s*\}\}$/g,''),[root,...rest]=reference.split('.'),ids=toolNodes.get(root!)
    if(!ids||!message.startsWith(`节点引用 ${reference} 不存在`))return message
    return `${message}。${root} 是工具名，不是节点；引用调用它的节点 ${ids.join('、')}，例如 ${[ids[0],...rest].join('.')}`
  }
  const condition=(value:{variable:string;value?:string}|undefined,scope:ReferenceScope)=>{if(value){check(value.variable,scope);interpolations(value.value,scope,check)}}
  const visit=(current:NodeGraph)=>{
    for(const node of current.nodes){
      currentNode=node.id
      const scope=plan.nodes.get(node.id)!,c=node.config
      dataReferences(c.inputs,scope,check)
      if(node.kind==='template')templateReferences(c.text??'',scope,Object.keys(c.inputs??{}),(name,current,allowMissing,syntaxError)=>{
        const root=name.split('.')[0]!
        // default/defined may intentionally tolerate an absent producer. They
        // cannot make a declared workflow input an implicit template alias;
        // actual config.inputs and for locals were resolved by templateReferences.
        const bareInput=options.strictMissing&&inputFields.has(root)&&!scope.knownNodeIds.has(root)&&!['input','vars','env','sys','item','index'].includes(root)
        check(name,current,allowMissing,syntaxError??(bareInput?`模板变量 ${root} 未映射；工作流输入请使用 input.${root}`:undefined))
      })
      if(node.kind==='output')interpolations(c.text,scope,check)
      if(['llm','agent','classifier','extractor'].includes(node.kind)||(node.kind==='document'&&c.documentMode==='agent'))interpolations(c.prompt,scope,check)
      if(node.kind==='knowledge')interpolations(c.query,scope,check)
      if(node.kind==='human'){
        interpolations(c.prompt,scope,check)
        for(const field of c.fields??[])interpolations(field.defaultValue,scope,check)
      }
      if(node.kind==='if'){
        if(c.logicGate)for(const input of c.logicGate.inputs)dataReferences(input.value,scope,check)
        else if(c.cases?.length)for(const branch of c.cases)for(const item of branch.conditions)condition(item,scope)
        else if(c.variable)condition({variable:c.variable,value:c.value},scope)
      }
      if(node.kind==='aggregator')for(const group of c.groups??[])for(const name of group.variables)check(name,scope,true)
      if(node.kind==='assigner'){
        let local=scope
        for(const item of c.assignments??[]){dataReferences(item.value,local,check);local=withReferenceVariables(local,[item.name])}
      }
      if(node.kind==='http'){
        interpolations(c.url,scope,check);interpolations(c.bodyText,scope,check)
        for(const header of Object.values(c.headers??{}))interpolations(header,scope,check)
      }
      if(node.kind==='document'){
        if(c.source?.includes('{{'))interpolations(c.source,scope,check)
        else if(c.source&&['input','item','index','vars','env','sys',...scope.knownNodeIds].includes(c.source.split('.')[0]!))check(c.source,scope)
      }
      if(node.kind==='iteration'||node.kind==='list'){
        const source=node.kind==='iteration'?c.iterator:c.listSource
        if(source&&!source.trim().startsWith('['))check(source,scope)
      }
      if(node.kind==='list'&&c.filter)condition(c.filter,{...scope,hasItem:true,hasIndex:true})
      if(node.kind==='loop')dataReferences(c.initialVariables,scope,check)
      if(c.body){
        const complete=plan.completedBodies.get(node.id)!
        if(c.outputVariable)check(c.outputVariable,complete)
        if(node.kind==='loop')condition(c.until,{...complete,mustNodeIds:complete.passMustNodeIds,mustVariables:complete.passMustVariables})
        visit(c.body)
      }
    }
  }
  visit(graph);return issues
}
