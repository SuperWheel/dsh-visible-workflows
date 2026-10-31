import type { NodeGraph, NodeKind, WorkflowNode } from './types.ts'

export const isModelNode=(kind:NodeKind)=>['llm','agent','classifier','extractor'].includes(kind)
export const isContainer=(kind:NodeKind)=>kind==='iteration'||kind==='loop'
export function nodePorts(node:WorkflowNode):{id:string;label:string}[]{
 if(node.kind==='output'||node.kind==='exit_loop')return []
 if(node.kind==='classifier')return(node.config.classes||[]).map(c=>({id:c.id,label:c.label}))
 if(node.kind==='human'){
  const ports=(node.config.actions??[{id:'continue',label:'继续'}]).map(a=>({id:a.id,label:a.label}))
  // Normal human actions activate default as well as their named port; timeout
  // is independent. Keep action positions stable and do not duplicate legacy IDs.
  for(const port of [{id:'default',label:'常规继续'},{id:'timeout',label:'超时'}])if(!ports.some(existing=>existing.id===port.id))ports.push(port)
  return ports
 }
 if(node.kind==='if'&&node.config.logicGate)return[{id:'true',label:'IF'},{id:'false',label:'ELSE'}]
 if(node.kind==='if')return[...(node.config.cases?.length?node.config.cases.map((c,i)=>({id:c.id,label:i?'ELIF':'IF'})):[{id:'true',label:'IF'}]),{id:'false',label:'ELSE'}]
 return[{id:'default',label:''}]
}
export const branchTop=(node:WorkflowNode)=>isModelNode(node.kind)?108:80
export function nodeSize(node:WorkflowNode){const branches=['if','classifier','human'].includes(node.kind)?nodePorts(node).length:0;return{width:isContainer(node.kind)?480:256,height:isContainer(node.kind)?220:branches?branchTop(node)+branches*32+8:isModelNode(node.kind)?108:80}}


export interface Rect { x:number; y:number; width:number; height:number }
export function boundsOf(nodes:WorkflowNode[]):Rect {
  if(!nodes.length)return {x:0,y:0,width:0,height:0}
  const x=Math.min(...nodes.map(n=>n.x)),y=Math.min(...nodes.map(n=>n.y))
  return {x,y,width:Math.max(...nodes.map(n=>n.x+nodeSize(n).width))-x,height:Math.max(...nodes.map(n=>n.y+nodeSize(n).height))-y}
}
export function overlaps(a:Rect,b:Rect,gap=0):boolean {
  return a.x<b.x+b.width+gap&&a.x+a.width+gap>b.x&&a.y<b.y+b.height+gap&&a.y+a.height+gap>b.y
}
/** Keep copied groups intact; look for a nearby free slot, then fall back below the graph. */
export function placeWithoutOverlap(nodes:WorkflowNode[],existing:WorkflowNode[],origin:{x:number;y:number}):WorkflowNode[] {
  if(!nodes.length)return []
  const box=boundsOf(nodes),obstacles=existing.map(n=>({...n,...nodeSize(n)}))
  const x=Math.max(24,origin.x),y=Math.max(24,origin.y)
  let target={x,y}
  const free=(point:{x:number;y:number})=>!obstacles.some(rect=>overlaps({...box,...point},rect,32))
  if(!free(target)) {
    let found=false
    for(let ring=1;ring<=12&&!found;ring++) {
      // Down/right placement keeps additions close to the current view and away from toolbars.
      for(let step=0;step<=ring;step++) {
        const candidate={x:x+step*48,y:y+(ring-step)*48}
        if(free(candidate)){target=candidate;found=true;break}
      }
    }
    if(!found)target={x,y:Math.max(y,...obstacles.map(rect=>rect.y+rect.height+64))}
  }
  return nodes.map(n=>({...n,x:target.x+n.x-box.x,y:target.y+n.y-box.y}))
}
/** Deterministic DAG columns use real card dimensions, including long branch lists. */
export function arrangeNodes(graph:NodeGraph):WorkflowNode[] {
  const ids=new Set(graph.nodes.map(n=>n.id)),edges=graph.edges.filter(e=>ids.has(e.source)&&ids.has(e.target))
  const incoming=new Map(graph.nodes.map(n=>[n.id,edges.filter(e=>e.target===n.id).length]))
  const rank=new Map<string,number>(),queue=graph.nodes.filter(n=>!incoming.get(n.id)).map(n=>n.id),visited=new Set<string>()
  while(queue.length) {
    const id=queue.shift()!;if(visited.has(id))continue;visited.add(id)
    for(const edge of edges.filter(e=>e.source===id)) {
      rank.set(edge.target,Math.max(rank.get(edge.target)||0,(rank.get(id)||0)+1))
      incoming.set(edge.target,(incoming.get(edge.target)||0)-1)
      if(!incoming.get(edge.target))queue.push(edge.target)
    }
  }
  // Invalid cycles remain visible for correction rather than causing a layout loop.
  let fallback=Math.max(0,...rank.values())+1
  for(const node of graph.nodes)if(!visited.has(node.id))rank.set(node.id,fallback++)
  const columns=new Map<number,WorkflowNode[]>()
  for(const node of graph.nodes){const col=rank.get(node.id)||0;columns.set(col,[...(columns.get(col)||[]),node])}
  const positioned=new Map<string,{x:number;y:number}>();let x=64
  for(const [,column] of [...columns].sort((a,b)=>a[0]-b[0])) {
    let y=80
    for(const node of column){positioned.set(node.id,{x,y});y+=nodeSize(node).height+64}
    x+=Math.max(...column.map(n=>nodeSize(n).width))+80
  }
  return graph.nodes.map(n=>({...n,...positioned.get(n.id)!}))
}

export function fitView(nodes:WorkflowNode[],width:number,height:number,extra:Rect[]=[]) {
  if(!nodes.length&&!extra.length)return {x:48,y:80,scale:1}
  const all=[...nodes.map(n=>({...n,...nodeSize(n)})),...extra],x=Math.min(...all.map(r=>r.x)),y=Math.min(...all.map(r=>r.y)),bounds={x,y,width:Math.max(...all.map(r=>r.x+r.width))-x,height:Math.max(...all.map(r=>r.y+r.height))-y},scale=Math.max(.2,Math.min(1,(width-96)/Math.max(bounds.width,1),(height-176)/Math.max(bounds.height,1)))
  return {x:(width-bounds.width*scale)/2-bounds.x*scale,y:80+(Math.max(0,height-160)-bounds.height*scale)/2-bounds.y*scale,scale}
}
