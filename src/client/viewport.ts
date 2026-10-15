import type { WorkflowEdge, WorkflowNode } from '../shared/types.ts'
import { branchTop, nodePorts, nodeSize, portY } from './nodes.ts'

export interface Viewport { x:number; y:number; scale:number }
export interface Point { x:number; y:number }
export interface ViewportRect { x:number; y:number; width:number; height:number }
export interface EdgeCurve {
  edge:WorkflowEdge
  start:Point; control1:Point; control2:Point; end:Point
  path:string; bounds:ViewportRect
}
export interface GraphViewportIndex {
  nodes:readonly WorkflowNode[]
  nodeById:ReadonlyMap<string,WorkflowNode>
  nodeBounds:ReadonlyMap<string,ViewportRect>
  edges:readonly EdgeCurve[]
  bounds:ViewportRect
}
const finite=(value:number,fallback=0)=>Number.isFinite(value)?value:fallback
const positiveScale=(scale:number)=>Number.isFinite(scale)&&scale>0?scale:1
/** Includes a shared boundary, so strokes on the screen edge do not blink. */
export function intersectsRect(a:ViewportRect,b:ViewportRect):boolean {
  return a.x<=b.x+b.width&&a.x+a.width>=b.x&&a.y<=b.y+b.height&&a.y+a.height>=b.y
}
export function unionRects(a:ViewportRect,b:ViewportRect):ViewportRect {
  const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y)
  return {x,y,width:Math.max(a.x+a.width,b.x+b.width)-x,height:Math.max(a.y+a.height,b.y+b.height)-y}
}
/** Screen buffer stays visually constant while zooming; the world margin is buffer/scale. */
export function worldViewport(viewport:Viewport,width:number,height:number,buffer=0):ViewportRect {
  const scale=positiveScale(viewport.scale),margin=Math.max(0,finite(buffer))
  return {x:(-finite(viewport.x)-margin)/scale,y:(-finite(viewport.y)-margin)/scale,width:(Math.max(0,finite(width))+margin*2)/scale,height:(Math.max(0,finite(height))+margin*2)/scale}
}
const cubic=(p0:number,p1:number,p2:number,p3:number,t:number)=>{const u=1-t;return u*u*u*p0+3*u*u*t*p1+3*u*t*t*p2+t*t*t*p3}
function extrema(p0:number,p1:number,p2:number,p3:number):number[] {
  const a=-p0+3*p1-3*p2+p3,b=2*(p0-2*p1+p2),c=p1-p0,roots:number[]=[]
  if(Math.abs(a)<1e-12){if(Math.abs(b)>1e-12)roots.push(-c/b)}
  else {const d=b*b-4*a*c;if(d>=0){const sqrt=Math.sqrt(d);roots.push((-b+sqrt)/(2*a),(-b-sqrt)/(2*a))}}
  return [p0,p3,...roots.filter(t=>t>0&&t<1).map(t=>cubic(p0,p1,p2,p3,t))]
}
/** Tight AABB includes internal curve extrema, not only endpoint or node boxes. */
export function cubicBezierBounds(start:Point,control1:Point,control2:Point,end:Point):ViewportRect {
  const xs=extrema(start.x,control1.x,control2.x,end.x),ys=extrema(start.y,control1.y,control2.y,end.y),x=Math.min(...xs),y=Math.min(...ys)
  return {x,y,width:Math.max(...xs)-x,height:Math.max(...ys)-y}
}
function curveBetween(edge:WorkflowEdge,start:Point,end:Point):EdgeCurve {
  const control1={x:start.x+65,y:start.y},control2={x:end.x-65,y:end.y}
  return {edge,start,control1,control2,end,bounds:cubicBezierBounds(start,control1,control2,end),path:`M${start.x},${start.y} C${control1.x},${control1.y} ${control2.x},${control2.y} ${end.x},${end.y}`}
}
export function edgeCurve(edge:WorkflowEdge,source:WorkflowNode,target:WorkflowNode):EdgeCurve {
  return curveBetween(edge,{x:source.x+nodeSize(source).width,y:source.y+portY(source,edge.port||'default')},{x:target.x,y:target.y+nodeSize(target).height/2})
}
/** Build once per graph change: each node/edge is visited once; no per-edge array.find. */
export function createViewportIndex(nodes:readonly WorkflowNode[],edges:readonly WorkflowEdge[]):GraphViewportIndex {
  const nodeById=new Map<string,WorkflowNode>(),nodeBounds=new Map<string,ViewportRect>(),curves:EdgeCurve[]=[]
  const portOffsets=new Map<string,{fallback:number;byPort:Map<string,number>}>()
  let bounds:ViewportRect|undefined
  for(const node of nodes){
    const rect={x:node.x,y:node.y,...nodeSize(node)}
    nodeById.set(node.id,node);nodeBounds.set(node.id,rect);bounds=bounds?unionRects(bounds,rect):rect
    const branch=['if','classifier','human'].includes(node.kind),fallback=branch?branchTop(node)+16:rect.height/2
    // Cache branch offsets once as well: a many-branch node must not rescan all its ports per edge.
    portOffsets.set(node.id,{fallback,byPort:branch?new Map(nodePorts(node).map((port,index)=>[port.id,fallback+index*32])):new Map()})
  }
  for(const edge of edges){
    const source=nodeBounds.get(edge.source),target=nodeBounds.get(edge.target),ports=portOffsets.get(edge.source)
    if(source&&target&&ports)curves.push(curveBetween(edge,{x:source.x+source.width,y:source.y+(ports.byPort.get(edge.port||'default')??ports.fallback)},{x:target.x,y:target.y+target.height/2}))
  }
  return {nodes,nodeById,nodeBounds,edges:curves,bounds:bounds??{x:0,y:0,width:0,height:0}}
}
export function cullViewport(index:GraphViewportIndex,viewport:Viewport,width:number,height:number,buffer=200,keepNodeIds?:ReadonlySet<string>):{nodes:WorkflowNode[];edges:EdgeCurve[];world:ViewportRect} {
  const world=worldViewport(viewport,width,height,buffer),measured=width>0&&height>0
  const nodes=index.nodes.filter(n=>keepNodeIds?.has(n.id)||(measured&&intersectsRect(index.nodeBounds.get(n.id)!,world)))
  // A curve may cross the screen even when both of its nodes are outside it.
  const edges=measured?index.edges.filter(e=>intersectsRect(e.bounds,world)):[]
  return {nodes,edges,world}
}
export interface MiniMapTransform {
  scale:number; offsetX:number; offsetY:number; width:number; height:number; bounds:ViewportRect
}
export function miniMapTransform(bounds:ViewportRect,width=180,height=112,padding=8):MiniMapTransform {
  width=Math.max(1,finite(width,180));height=Math.max(1,finite(height,112));padding=Math.max(0,Math.min(finite(padding,8),(Math.min(width,height)-1)/2))
  const worldWidth=Math.max(1,finite(bounds.width,1)),worldHeight=Math.max(1,finite(bounds.height,1))
  const scale=Math.min((width-padding*2)/worldWidth,(height-padding*2)/worldHeight)
  return {scale,offsetX:(width-worldWidth*scale)/2-finite(bounds.x)*scale,offsetY:(height-worldHeight*scale)/2-finite(bounds.y)*scale,width,height,bounds}
}
export const worldToMiniMap=(point:Point,map:MiniMapTransform):Point=>({x:point.x*map.scale+map.offsetX,y:point.y*map.scale+map.offsetY})
export const miniMapToWorld=(point:Point,map:MiniMapTransform):Point=>({x:(point.x-map.offsetX)/map.scale,y:(point.y-map.offsetY)/map.scale})
export function centerViewport(center:Point,viewport:Viewport,width:number,height:number):Viewport {
  const scale=positiveScale(viewport.scale)
  return {x:Math.max(0,finite(width))/2-center.x*scale,y:Math.max(0,finite(height))/2-center.y*scale,scale}
}
