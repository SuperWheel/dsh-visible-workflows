import { createHash } from 'node:crypto'
import type { PlanningContext } from './planning-types.ts'
import { planningEditView } from './planning-edits.ts'
import { allNodes } from './workflow-validation.ts'
import { authoringGraphContext } from './planning-authoring-context.ts'
import { planningContextSlice, selectedConfigFields, type PlanningContextSelection } from './planning-context-slice.ts'
import { planningChainView, type PlanningChainLocator } from './planning-chain.ts'
import { createTemplateBinding } from './planning-node-templates.ts'
import { NODE_SEMANTICS, workflowTextFieldContract } from './workflow-semantics.ts'
import { planningAdapterOutputs } from './planning-tool-outputs.ts'
import { planningNodeOutputType } from './planning-projection.ts'

export interface PlanningReadIdentity {workflowId:string;revision:number;scopeIdentity:string;digest:string}
export interface PlanningReaderOptions {
  scopeIdentity:string
  cacheScope?:'task'|'session-workflow'
  contractVersion?:string
  maxEntries?:number
  maxBytes?:number
  /** Called on every read, including cache hits. Must throw if current access expired. */
  assertCurrent?:(identity:PlanningReadIdentity)=>void
}
export interface PlanningNodeQuery {nodeId?:string;query?:string;kind?:string;toolId?:string;field?:string;containerId?:string;limit?:number}
export interface PlanningReadRequest {nodeIds?:readonly string[];keys?:readonly string[];expectedRevision?:number;expectedIdentity?:PlanningReadIdentity;selection?:PlanningContextSelection}
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
/** Task-scoped frozen context cache. Never reuse across task/authorization scopes. */
export class PlanningContextReader {
  private context!:PlanningContext
  private options!:PlanningReaderOptions
  private rows!:ReturnType<typeof authoringGraphContext>
  private ids!:string[]
  private parents!:Map<string,string[]>
  private entries=new Map<string,{value:unknown;bytes:number}>()
  private bytes=0
  private hits=0
  private misses=0
  private boundIdentity!:PlanningReadIdentity
  get identity():PlanningReadIdentity{return {...this.boundIdentity}}
  constructor(context:PlanningContext,options:PlanningReaderOptions){this.rebind(context,options)}
  rebind(context:PlanningContext,options:PlanningReaderOptions=this.options){
    if(!options.scopeIdentity.trim())throw new Error('读取范围身份不能为空')
    const identity={workflowId:context.workflow.id,revision:context.workflow.revision,scopeIdentity:options.scopeIdentity,
      digest:hash({workflow:context.workflow,tools:context.tools,toolOutputs:context.toolOutputs,targets:context.targetNodeIds,selection:(context as any).contextSelection,contracts:options.contractVersion??''})}
    this.options=options
    if(this.boundIdentity&&hash(this.boundIdentity)===hash(identity))return
    const snapshot=structuredClone(context),rows=authoringGraphContext(snapshot),ids=allNodes(snapshot.workflow).map(n=>n.id)
    const view=planningEditView(snapshot),idByRef=new Map(view.nodes.map((n,i)=>[n.ref,ids[i]!]))
    const parents=new Map(view.nodes.map((n,i)=>[ids[i]!,n.scope.map(ref=>idByRef.get(ref)!)]))
    this.context=snapshot;this.boundIdentity=identity;this.rows=rows;this.ids=ids;this.parents=parents
    this.entries.clear();this.bytes=0
  }
  private check(request?:PlanningReadRequest){
    this.options.assertCurrent?.({...this.identity})
    if(request?.expectedRevision!==undefined&&request.expectedRevision!==this.identity.revision)throw new Error('图版本已变化，请重新定位节点')
    if(request?.expectedIdentity&&hash(request.expectedIdentity)!==hash(this.identity))throw new Error('图内容或读取范围已变化，请重新定位节点')
  }
  private cached<T>(key:string,build:()=>T):T {
    const old=this.entries.get(key)
    if(old){this.hits++;this.entries.delete(key);this.entries.set(key,old);return structuredClone(old.value) as T}
    this.misses++;const value=build(),bytes=Buffer.byteLength(JSON.stringify(value))
    const limit=Math.max(0,Math.min(this.options.maxEntries??16,64)),maxBytes=Math.max(0,Math.min(this.options.maxBytes??512*1024,2*1024*1024))
    if(limit&&bytes<=maxBytes){
      while(this.entries.size>=limit||this.bytes+bytes>maxBytes){const first=this.entries.keys().next().value!;this.bytes-=this.entries.get(first)!.bytes;this.entries.delete(first)}
      this.entries.set(key,{value:structuredClone(value),bytes});this.bytes+=bytes
    }
    return value
  }
  stats(){return {scope:this.options.cacheScope??'task',hits:this.hits,misses:this.misses,entries:this.entries.size,bytes:this.bytes}}
  /** T37: the bound context, for a Host-side compile of a decided change. */
  snapshot(expectedRevision:number):PlanningContext{this.check({expectedRevision});return structuredClone(this.context)}
  chain(locator:PlanningChainLocator,expectedRevision:number,templateIds:readonly string[]=[]){
    this.check({expectedRevision})
    if(templateIds.length>5||new Set(templateIds).size!==templateIds.length)throw new Error('一次读取最多 5 个不同模板')
    return this.cached('chain:'+hash({locator,templateIds}),()=>{
      const view=planningChainView(this.context,locator)
      if(!templateIds.length)return view
      const binding=createTemplateBinding(this.context.tools,this.context.toolOutputs)
      const templates=templateIds.map(id=>{
        const template=binding.templates.find(item=>item.id===id||item.fixed.toolId===id)
        if(!template)throw new Error('当前目录不存在模板：'+id)
        return template
      })
      return {...view,templateCatalog:{protocolVersion:binding.protocolVersion,digest:binding.catalogDigest,templates}}
    })
  }
  search(query:PlanningNodeQuery,expectedRevision?:number){
    this.check({expectedRevision})
    if(!query.nodeId&&!query.query?.trim()&&!query.kind&&!query.toolId&&!query.field&&!query.containerId)throw new Error('节点检索至少需要一个精确条件或关键词')
    const limit=Math.max(1,Math.min(query.limit??20,20))
    return this.cached('search:'+hash(query),()=>{
      const nodes=allNodes(this.context.workflow),text=query.query?.trim().toLocaleLowerCase(),tokens=text?.split(/\s+/)??[]
      const candidates=nodes.flatMap((node,index)=>{
        const reasons:string[]=[]
        if(query.nodeId){if(node.id!==query.nodeId)return [];reasons.push('exact-id')}
        if(query.kind){if(node.kind!==query.kind)return [];reasons.push('kind')}
        if(query.toolId){if(node.config.toolId!==query.toolId)return [];reasons.push('tool-id')}
        if(query.field){if(!Object.hasOwn(node.config,query.field))return [];reasons.push('field')}
        const scope=this.parents.get(node.id)??[]
        if(query.containerId){if(!scope.includes(query.containerId))return [];reasons.push('container')}
        if(text){
          const haystack=[node.id,node.title,node.kind,String(node.config.toolId??''),...Object.keys(node.config),...scope.map(id=>nodes.find(n=>n.id===id)?.title??id)].join(' ').toLocaleLowerCase()
          if(!tokens.every(token=>haystack.includes(token)))return []
          reasons.push(node.title.toLocaleLowerCase()===text?'exact-title':'keyword')
        }
        return [{nodeId:node.id,key:this.rows[index]!.key,title:node.title,kind:node.kind,scope,toolId:node.config.toolId,reasons}]
      })
      return {identity:{...this.identity},candidates:candidates.slice(0,limit),total:candidates.length,ambiguous:candidates.length>1}
    })
  }
  slice(selection?:PlanningContextSelection,expectedRevision?:number){
    this.check({expectedRevision})
    return this.cached('slice:'+hash(selection??null),()=>({identity:{...this.identity},...planningContextSlice(this.context,selection)}))
  }
  read(request:PlanningReadRequest){
    this.check(request)
    const ids=[...new Set([...(request.nodeIds??[]),...(request.keys??[]).map(key=>{
      const index=this.rows.findIndex(row=>row.key===key)
      if(index<0)throw new Error('图引用不存在或已变化: '+key)
      return this.ids[index]!
    })])]
    if(!ids.length||ids.length>20)throw new Error('一次批量读取需要 1 至 20 个节点')
    if(ids.some(id=>!this.ids.includes(id)))throw new Error('节点不存在或已删除')
    return this.cached('read:'+hash({ids,selection:request.selection}),()=>{
      const slice=planningContextSlice(this.context,{...request.selection,targetNodeIds:ids})
      const nodes=allNodes(this.context.workflow)
      const textTargets=this.rows.flatMap((row,index)=>{
        const id=this.ids[index]!
        if(!ids.includes(id)||!selectedConfigFields(request.selection?.targetFields?.[id])?.includes('text')||(row.kind!=='template'&&row.kind!=='output'))return []
        return [{nodeId:id,key:row.key,kind:row.kind,localInputKeys:Object.keys((row.config as {inputs?:Record<string,unknown>}).inputs??{})}]
      })
      return {identity:{...this.identity},...slice,...(textTargets.length?{
        semanticContracts:[...new Set(textTargets.map(target=>target.kind))].map(workflowTextFieldContract),
        textBindings:textTargets,
      }:{}),nodes:this.rows.flatMap((row,index)=>{
        const id=this.ids[index]!
        if(!slice.readNodeIds.includes(id))return []
        if(slice.conservative&&!ids.includes(id)){
          const node=nodes[index]!,config=node.config,tool=this.context.tools.find(tool=>tool.id===config.toolId)
          const definitions=node.kind==='tool'?(tool?planningAdapterOutputs(tool).fields:{}):NODE_SEMANTICS[node.kind].outputs
          // Unknown types remain explicit. Never infer a schema from observed
          // business values or copy prompts, defaults, descriptions or bodies.
          const outputs:Record<string,string>=Object.fromEntries(Object.entries(definitions).filter(([name])=>!name.startsWith('<')).map(([name,description])=>[name,/^(string|number|boolean|object|array)[:：]/.exec(description)?.[1]??(name==='text'?'string':'unknown')]))
          const declarations=node.kind==='input'||node.kind==='human'?config.fields:node.kind==='extractor'?config.parameters:['llm','agent','code'].includes(node.kind)?config.outputSchema:undefined
          const inputTypes:Record<string,string>={text:'string',paragraph:'string',select:'string',file:'object',files:'array',json:'unknown'}
          // Runtime wrapper fields win over same-named declarations (except input
          // fields, spread after text); then the shared per-kind inference decides.
          for(const field of declarations??[])if(node.kind==='input'||!Object.hasOwn(outputs,field.name))outputs[field.name]=inputTypes[field.type??'text']??field.type!
          for(const name of Object.keys(outputs)){const inferred=planningNodeOutputType(node,name,this.context.toolOutputs);if(inferred)outputs[name]=inferred}
          for(const field of node.kind==='assigner'?config.assignments??[]:node.kind==='aggregator'?config.groups??[]:[])outputs[field.name]='unknown'
          const ports=node.kind==='if'?config.logicGate?['true','false']:config.cases?.length?[...config.cases.map(branch=>branch.id),'false']:['true','false']:
            node.kind==='classifier'?(config.classes??[]).map(branch=>branch.id):node.kind==='human'?[...(config.actions??[]).map(action=>action.id),'default','timeout']:['default']
          return [{...row,nodeId:id,number:node.number,fixed:node.fixed,contractOnly:true,outputs,ports,config:{}}]
        }
        const fields=ids.includes(id)?selectedConfigFields(request.selection?.targetFields?.[id]):undefined
        return [{...structuredClone(row),...(fields?{config:Object.fromEntries(Object.entries(row.config as Record<string,unknown>).filter(([field])=>fields.includes(field)))}:{})}]
      })}
    })
  }
}
