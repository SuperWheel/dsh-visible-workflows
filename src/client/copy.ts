import { newId, type JsonValue, type NodeConfig, type NodeGraph } from '../shared/types.ts'
/** Rewrite references, never field names, configuration keys or ordinary prose. */
export function remapNodeConfig(config:NodeConfig,ids:ReadonlyMap<string,string>):NodeConfig {
 const next=structuredClone(config)
 const key=(value:string)=>{if(/^(input|vars|item|index)(\.|$)/.test(value))return value;for(const [id,mapped] of ids)if(value.startsWith(`${id}.`))return mapped+value.slice(id.length);return value}
 const template=(value:string)=>value.replace(/\{\{(\s*)([^{}]+?)(\s*)\}\}/g,(match,leading:string,ref:string,trailing:string)=>{const mapped=key(ref);return mapped===ref?match:`{{${leading}${mapped}${trailing}}}`})
 const ref=(value:string)=>value.trim().startsWith('{{')?template(value):key(value.trim())
 const values=(value:JsonValue):JsonValue=>typeof value==='string'?template(value):Array.isArray(value)?value.map(values):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,values(v)])):value
 for(const name of ['text','prompt','query','url','bodyText'] as const)if(next[name]!==undefined)next[name]=template(next[name]!)
 for(const name of ['variable','iterator','outputVariable','listSource','source'] as const)if(next[name]!==undefined)next[name]=ref(next[name]!)
 if(next.fields)next.fields=next.fields.map(f=>({...f,...(f.defaultValue!==undefined?{defaultValue:template(f.defaultValue)}:{})}))
 if(next.inputs)next.inputs=values(next.inputs) as Record<string,JsonValue>
 if(next.initialVariables)next.initialVariables=values(next.initialVariables) as Record<string,JsonValue>
 if(next.headers)next.headers=Object.fromEntries(Object.entries(next.headers).map(([k,v])=>[k,template(v)]))
 if(next.groups)next.groups=next.groups.map(g=>({...g,variables:g.variables.map(ref)}))
 if(next.assignments)next.assignments=next.assignments.map(a=>({...a,...(a.value!==undefined?{value:values(a.value)}:{})}))
 if(next.cases)next.cases=next.cases.map(c=>({...c,conditions:c.conditions.map(c=>({...c,variable:ref(c.variable),...(c.value!==undefined?{value:template(c.value)}:{})}))}))
 for(const name of ['until','filter'] as const)if(next[name])next[name]={...next[name]!,variable:ref(next[name]!.variable),...(next[name]!.value!==undefined?{value:template(next[name]!.value!)}:{})}
 if(next.body)next.body=remapGraph(next.body,ids)
 return next
}
function remapGraph(graph:NodeGraph,ids:ReadonlyMap<string,string>):NodeGraph{return{nodes:graph.nodes.map(n=>({...structuredClone(n),id:ids.get(n.id)||n.id,config:remapNodeConfig(n.config,ids)})),edges:graph.edges.map(e=>({...e,id:newId(),source:ids.get(e.source)||e.source,target:ids.get(e.target)||e.target}))}}
export function copyNodes(graph:NodeGraph):NodeGraph{const ids=new Map<string,string>();const visit=(g:NodeGraph)=>{for(const n of g.nodes){ids.set(n.id,newId());if(n.config.body)visit(n.config.body)}};visit(graph);return remapGraph(graph,ids)}
