import type { PlanningAgentInput } from '../../src/host/planning/agent.ts'
import { makeWorkflow, type Workflow } from '../../src/shared/types.ts'
import { allNodes } from '../../src/shared/workflow-validation.ts'
import { CompilerError } from '../../src/shared/planning-repair.ts'

const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
function rewrite(value:any,refs:Map<string,string>):any{
  if(typeof value==='string')return value.replace(/\{\{(#?)([^.{}\s]+)(?=[.}])/g,(match,hash,id)=>`{{${hash}${refs.get(id)??id}`)
  if(Array.isArray(value))return value.map(item=>rewrite(item,refs))
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,rewrite(item,refs)]))
  return value
}
export function fixturePlanningPrompt(input:PlanningAgentInput,stable?:Workflow):any{
  const view=JSON.parse(input.prompt)
  if(input.purpose==='distill')return {...view,answers:view.answers??[]}
  if(input.purpose==='optimize')return {...view,graph:fixtureOptimizationGraph(view,stable),answers:view.answers??[]}
  const seed=stable??makeWorkflow('workspace')
  const rows=input.graphContext??allNodes(seed).map((node,index)=>({...node,key:'n'+(index+1),scope:[]}))
  const stableNodes=stable?allNodes(stable):[],ids=new Map<string,string>(rows.map((node:any,index:number)=>[node.key,stableNodes[index]?.id??node.key]))
  const graphAt=(scope:string[]):any=>({nodes:rows.filter((node:any)=>equal(node.scope,scope)).map((node:any)=>({id:ids.get(node.key),kind:node.kind,title:node.title,config:{...rewrite(node.config,ids),...(node.config.body?{body:graphAt([...scope,node.key])}:{})}})),edges:(view.graph?.edges??seed.edges.map(edge=>({...edge,source:'n'+(allNodes(seed).findIndex(node=>node.id===edge.source)+1),target:'n'+(allNodes(seed).findIndex(node=>node.id===edge.target)+1),scope:[]}))).filter((edge:any)=>equal(edge.scope??[],scope)).map((edge:any)=>({source:ids.get(edge.source),target:ids.get(edge.target),...(edge.port?{port:edge.port}:{})}))})
  return {...view,fixedNodeRefs:(view.graph?.nodes??[]).filter((node:any)=>node.fixed).map((node:any)=>ids.get(node.key)),answers:view.answers??[],graph:{title:view.graph?.title??seed.title,description:view.graph?.description??seed.description,...graphAt([])},nodeIds:['fixture-added-node']}
}
export function fixtureSubmit(input:PlanningAgentInput,wire:unknown):unknown{
  input.beforeSubmission?.()
  const result=input.compiler.submit(wire)
  if(!result.ok)throw new CompilerError(result.feedback.remainingSubmissions?'FIXTURE_REPAIR_REQUIRED':'PLANNING_REPAIR_LIMIT',JSON.stringify(result.feedback),undefined,!result.feedback.remainingSubmissions)
  return result.value
}
// Projection fixtures describe business changes; every mock submits the current compiler wire.
export function fixturePlanningEdits(input:PlanningAgentInput,output:any,stable?:Workflow):any{
  if(output?.output&&output?.candidate!==undefined)return output
  if(input.compiler.snapshot().document&&output?.output)return output
  if(input.purpose==='distill'){
    if(output?.outcome==='needs-input')return fixtureSubmit(input,{submission:{mode:'needs-input',questions:output.questions,summary:output.summary}})
    let procedure;try{procedure=JSON.parse(output.procedureJson)}catch{return fixtureSubmit(input,{submission:{mode:'distill',procedure:{}}})}
    return fixtureSubmit(input,{submission:{mode:'distill',procedure,summary:output.summary}})
  }
  if(input.purpose==='optimize'){
    if(!Object.hasOwn(output,'graphJson'))return fixtureSubmit(input,{submission:output})
    const view=JSON.parse(input.prompt),base=fixtureOptimizationGraph(view,stable),refs=new Map<string,string>(view.nodes.map((node:any,index:number)=>[allNodes(base).find(item=>item.title===node.title)!.id,node.ref]))
    const common={protocolVersion:1,baseDigest:view.baseDigest,outcome:output.outcome,summary:output.summary}
    if(output.outcome==='unchanged')return fixtureSubmit(input,{submission:common})
    const next=JSON.parse(output.graphJson),replacements=(output.replacements??[]).map((item:any)=>{const node=allNodes(next).find(node=>node.id===item.nodeId);return {node:refs.get(item.nodeId)??item.nodeId,kind:node?.kind,config:rewrite(node?.config,refs),reason:item.reason,evidenceCases:(output.regressionCases??[]).filter((sample:any)=>sample.nodeId===item.nodeId).map(({nodeId:_nodeId,upstreamOutputs,...sample}:any)=>({...sample,...(upstreamOutputs?{upstreamOutputs:Object.fromEntries(Object.entries(upstreamOutputs).map(([id,value])=>[refs.get(id)??id,value]))}:{})}))}})
    const allowed=new Set((output.replacements??[]).map((item:any)=>item.nodeId)),invalid=Object.keys(next).some(key=>key!=='nodes'&&!equal(next[key],(base as any)[key]))||allNodes(base).some(node=>!allowed.has(node.id)&&!equal(node,allNodes(next).find(item=>item.id===node.id)))||allNodes(base).length!==allNodes(next).length
    return fixtureSubmit(input,{submission:{...common,replacements,...(invalid?{forbiddenFixtureMutation:true}:{})}})
  }
  if(output?.submission)return fixtureSubmit(input,output)
  if(output?.outcome==='needs-input')return fixtureSubmit(input,{submission:{mode:'needs-input',questions:output.questions,summary:output.summary}})
  if(!Object.hasOwn(output??{},'graphJson'))return fixtureSubmit(input,{submission:output})
  const prompt=fixturePlanningPrompt(input,stable),base=prompt.graph
  let next:any;try{next=JSON.parse(output.graphJson)}catch{return fixtureSubmit(input,{submission:{mode:JSON.parse(input.prompt).operation,nodes:'invalid fixture JSON'}})}
  const refs=new Map<string,string>(),before=new Map<string,any>(),after=new Map<string,any>()
  const collect=(graph:any,scope:string[],target:Map<string,any>)=>{for(const node of graph.nodes??[]){target.set(node.id,{node,scope});if(node.config.body)collect(node.config.body,[...scope,node.id],target)}}
  collect(base,[],before);collect(next,[],after)
  const rows=input.graphContext??[...before.keys()].map((id,index)=>({key:'n'+(index+1)}));[...before.keys()].forEach((id,index)=>refs.set(id,rows[index]?.key??'n'+(index+1)))
  let added=0;for(const id of after.keys())if(!refs.has(id))refs.set(id,`new${++added}`)
  if(JSON.parse(input.prompt).operation==='create'){
    const first=[...after].find(([,entry])=>entry.node.kind==='input'&&!entry.scope.length),last=[...after].find(([,entry])=>entry.node.kind==='output'&&!entry.scope.length)
    if(first)refs.set(first[0],'start');if(last)refs.set(last[0],'result')
  }
  const ref=(id:string)=>refs.get(id)??id
  const nodes=[...after].map(([id,{node,scope}])=>{const {body,...config}=node.config;return {key:ref(id),kind:node.kind,title:node.title,config:rewrite(config,refs),...(scope.length?{scope:scope.map(ref)}:{})}})
  const edges=(graph:any):any[]=>[...(graph.edges??[]),...(graph.nodes??[]).flatMap((node:any)=>node.config.body?edges(node.config.body):[])]
  const links=edges(next).filter((edge:any)=>edge.port&&edge.port!=='default').map((edge:any,index:number)=>({key:'branch'+index,source:ref(edge.source),target:ref(edge.target),port:edge.port}))
  const chains=edges(next).filter((edge:any)=>!edge.port||edge.port==='default').map((edge:any,index:number)=>({key:'chain'+index,nodes:[ref(edge.source),ref(edge.target)]}))
  const common={summary:output.summary,...(output.assumptions?.length?{assumptions:output.assumptions}:{}),coverage:Object.fromEntries((output.requirementCoverage??[]).map((item:any)=>[item.requirementId,item.nodeIds.map(ref)]))}
  const unsupported=Object.keys(next).some(key=>!['nodes','edges','title','description'].includes(key)&&!equal(next[key],base[key]))
  let submission:any
  if(JSON.parse(input.prompt).operation==='create')submission={mode:'create',title:next.title,description:next.description,nodes,chains,links,...common}
  else{
    const updates=Object.fromEntries([...after].filter(([id])=>before.has(id)).map(([id,{node}])=>{
      const old=before.get(id).node,{body,...config}=node.config,set=Object.fromEntries(Object.entries(config).filter(([key,value])=>!equal(value,old.config[key]))),unset=Object.keys(old.config).filter(key=>key!=='body'&&!Object.hasOwn(config,key))
      return [ref(id),{...(node.kind!==old.kind?{kind:node.kind}:{}),...(node.title!==old.title?{title:node.title}:{}),...(Object.keys(set).length?{set:rewrite(set,refs)}:{}),...(unset.length?{unset}:{})}]
    }).filter(([,change])=>Object.keys(change).length))
    const oldEdges=edges(base),newEdges=edges(next),link=(edge:any)=>({source:ref(edge.source),target:ref(edge.target),...(edge.port?{port:edge.port}:{})})
    submission={mode:'edit',updates,addNodes:nodes.filter(node=>![...before.keys()].some(id=>ref(id)===node.key)),removeNodes:[...before.keys()].filter(id=>!after.has(id)).map(ref),removeLinks:oldEdges.filter(edge=>!newEdges.some(item=>equal(item,edge))).map(link),addLinks:newEdges.filter(edge=>!oldEdges.some(item=>equal(item,edge))).map((edge,index)=>({key:'link'+index,...link(edge)})),...(next.title!==base.title?{title:next.title}:{}),...(next.description!==base.description?{description:next.description}:{}),...common}
  }
  return fixtureSubmit(input,{submission:{...submission,...(unsupported?{forbiddenFixtureMutation:true}:{})}})
}
function fixtureOptimizationGraph(view:any,stable?:Workflow):any{
  const ids=new Map<string,string>(view.nodes.map((node:any,index:number)=>[node.ref,stable?(allNodes(stable).find(item=>item.title===node.title)?.id??allNodes(stable)[index]?.id):node.ref]))
  return {title:view.title,description:view.description,nodes:view.nodes.map((node:any)=>({id:ids.get(node.ref),kind:node.kind,title:node.title,config:rewrite(node.config,ids)})),edges:view.edges.map((edge:any)=>({source:ids.get(edge.source),target:ids.get(edge.target),...(edge.port?{port:edge.port}:{})}))}
}
