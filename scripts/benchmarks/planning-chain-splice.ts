/** Synthetic local CPU/representation comparison. Never calls a model or changes a user workflow. */
import { performance } from 'node:perf_hooks'
import { mkdirSync,writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyChainSplice,confirmChainDraft,createChainDraft,compilePlanningChain,planningChainView } from '../../src/shared/planning-chain.ts'
import { chainSpliceSchema,planningChainRequestSchema,type ChainSplice } from '../../src/shared/planning-chain-contract.ts'
import type { PlanningContext } from '../../src/shared/planning-types.ts'
import type { NodeGraph,WorkflowNode } from '../../src/shared/types.ts'
import { allNodes } from '../../src/shared/workflow-validation.ts'
const form=(key:string)=>({key,template:'template',values:{text:key}})
const values=(entries:{nodeId?:string;form?:{key:string}}[])=>entries.map(entry=>entry.nodeId??entry.form!.key)
function exercise(size:number,splices:number) {
  let draft=createChainDraft({chainKey:'a',baseDigest:'a'.repeat(64),baseRevision:1,nodeIds:Array.from({length:size},(_,i)=>'old-'+i)})
  const eager=values(draft.active).map((value,i)=>({value,alias:'a-'+(i+1)})),operations:ChainSplice[]=[],positions:number[]=[]
  let eagerWrites=size
  for(let step=0;step<splices;step++){
    const index=(Math.floor(size/3)+step*7)%draft.active.length,target=draft.active[index]!.alias
    const operation:ChainSplice=step%4===0?{op:'delete',draftRevision:step,target}:step%3===0?{op:'replace',draftRevision:step,target,nodes:[form('new'+step+'a'),form('new'+step+'b')]}:{op:'insert',draftRevision:step,target,position:step%2?'before':'after',nodes:[form('new'+step)]}
    const added=operation.op==='delete'?[]:operation.nodes.map(node=>({value:node.key,alias:''}))
    if(operation.op==='insert')added.splice(operation.position==='before'?added.length:0,0,{...eager[index]!})
    eager.splice(index,1,...added)
    for(let i=0;i<eager.length;i++)eager[i]!.alias='a-'+(i+1)
    eagerWrites+=eager.length;draft=applyChainSplice(draft,operation);operations.push(operation);positions.push(index)
    if(JSON.stringify(values(draft.active))!==JSON.stringify(eager.map(entry=>entry.value)))throw Error('Splice sequence diverged at '+step)
  }
  const confirmed=confirmChainDraft(draft)
  if(JSON.stringify(confirmed.entries.map(entry=>entry.standardAlias))!==JSON.stringify(eager.map(entry=>entry.alias)))throw Error('Renumber mapping differs')
  return {draft,eagerWrites,operations,positions}
}
const sample=(run:()=>unknown,repeats:number)=>{
  run();const times:number[]=[]
  for(let i=0;i<repeats;i++){const start=performance.now();run();times.push(performance.now()-start)}
  times.sort((a,b)=>a-b);return {repeats,medianMs:times[Math.floor(times.length/2)]!,minMs:times[0]!,maxMs:times.at(-1)!}
}
export function createChainBenchmarkContext(total:number):PlanningContext {
  if(![31,150,500].includes(total))throw Error('Legal graph fixtures are 31, 150 and 500 only')
  const graph=(count:number,prefix:string):NodeGraph=>{
    const nodes:WorkflowNode[]=Array.from({length:count},(_,i)=>({id:prefix+'node-'+i,kind:i===0?'input':i===count-1?'output':'template',number:prefix+'a-'+(i+1),title:'Node '+i,x:i*10,y:0,fixed:false,config:i===0?{fields:[]}:i===count-1?{text:'Constant',outputName:'result'}:{text:'Constant '+i}}))
    return {nodes,edges:nodes.slice(1).map((node,i)=>({id:prefix+'edge-'+i,source:nodes[i]!.id,target:node.id}))}
  }
  const root=total===500?graph(5,'root-'):graph(total,'root-')
  if(total===500)for(let i=1;i<=3;i++){root.nodes[i]!.kind='loop';root.nodes[i]!.config={maxIterations:1,initialVariables:{},body:graph(165,'body'+i+'-')}}
  const anchor=total===500?'body2-node-80':'root-node-'+Math.floor(total/2)
  return {operation:'revise',workflow:{id:'benchmark-flow',workspaceId:'benchmark-workspace',title:'Synthetic chain benchmark',description:'',revision:1,createdAt:'2026-10-20T00:00:00.000Z',updatedAt:'2026-10-20T00:00:00.000Z',...root,notes:[]},targetNodeIds:[anchor],nodeIds:Array.from({length:10},(_,i)=>'allocated-'+i),subagentIds:[],environmentIds:[],model:{provider:'offline',model:'no-model-called'},tools:[]}
}
export function runChainSpliceBenchmark(options:{splices?:number;repeats?:number}={}) {
  const splices=options.splices??20,repeats=options.repeats??30
  const algorithmCases=[31,150,500,1000].map(size=>{
    const checked=exercise(size,splices),initial=Array.from({length:size},(_,i)=>'old-'+i)
    const hierarchy=()=>{let draft=createChainDraft({chainKey:'a',baseDigest:'a'.repeat(64),baseRevision:1,nodeIds:initial});for(const operation of checked.operations)draft=applyChainSplice(draft,operation);confirmChainDraft(draft)}
    // This is a freshly implemented eager comparator, not a reconstructed installed/legacy baseline.
    const eager=()=>{const active=initial.map((value,i)=>({value,alias:'a-'+(i+1)}));for(const [step,raw]of checked.operations.entries()){const operation=chainSpliceSchema.parse(raw),index=checked.positions[step]!;if(operation.op==='update')continue;const added=operation.op==='delete'?[]:operation.nodes.map(node=>({value:node.key,alias:''}));if(operation.op==='insert')added.splice(operation.position==='before'?added.length:0,0,{...active[index]!});active.splice(index,1,...added);for(let i=0;i<active.length;i++)active[i]!.alias='a-'+(i+1)}}
    return {initialNodes:size,splices,finalNodes:checked.draft.active.length,orderAndFinalMappingEqual:true,aliasAssignments:{hierarchicalDuringEdits:checked.draft.aliasWrites,hierarchicalOneConfirmation:checked.draft.active.length,eagerEverySplice:checked.eagerWrites},cpu:{hierarchical:sample(hierarchy,repeats),syntheticEager:sample(eager,repeats)},candidateLegality:size===1000?'algorithm-only; exceeds current 500 total node limit':'algorithm-only; candidate legality measured separately'}
  })
  const candidateCases=[31,150,500].map(total=>{
    const context=createChainBenchmarkContext(total),anchorNodeId=context.targetNodeIds[0]!,view=planningChainView(context,{anchorNodeId}),target=view.nodes.find(node=>node.nodeId===anchorNodeId)!.alias
    const request=planningChainRequestSchema.parse({version:1,baseDigest:view.baseDigest,baseRevision:view.baseRevision,anchorNodeId,chainKey:view.chainKey,operations:[{op:'replace',draftRevision:0,target,nodes:[form('discard'),form('intermediate')]},{op:'delete',draftRevision:1,target:target+'#1'},{op:'replace',draftRevision:2,target:target+'#2',nodes:[form('final')]}]})
    const result=compilePlanningChain(request,context)
    if(result.issues.length||!result.candidate)throw Error(JSON.stringify(result.issues))
    if(allNodes(result.candidate).length!==total)throw Error('Wrong materialized node count')
    return {totalNodes:total,editedScopeNodes:view.nodes.length,splices:3,finalTotalNodes:allNodes(result.candidate).length,issues:result.issues,cpu:sample(()=>compilePlanningChain(request,context),Math.min(repeats,10)),retainedOldIds:allNodes(result.candidate).filter(node=>allNodes(context.workflow).some(old=>old.id===node.id)).length}
  })
  return {protocolVersion:1,scope:'synthetic-local-chain-splice-and-canonical-candidate-only',modelCalls:0,splices,repeats,algorithmCases,candidateCases,limits:['CPU times compare local implementations only; no model/pipeline/SDK timing or 20% speed gate is established.','The eager comparator is synthetic, not an installed historical baseline.','1000 nodes tests only the isolated alias algorithm; a legal Workflow remains at most 200 per scope and 500 total.','Existing WorkflowNode.number values remain unchanged; standardAlias is a version-bound sequential draft alias.']}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const report=runChainSpliceBenchmark(),directory=resolve(process.argv[2]??'docs/evidence/planning-chain-20261020')
  mkdirSync(directory,{recursive:true});writeFileSync(resolve(directory,'chain-splice-local.json'),JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({directory,...report},null,2))
}
