import type { WorkflowNode } from '../shared/types.ts'
import { nodeSize } from './nodes.ts'
import type { Viewport } from './viewport.ts'

/** Return a new view only when the inspector (or canvas edge) hides the node. */
export function revealNode(node:WorkflowNode,view:Viewport,width:number,height:number,inspectorWidth:number,top:number):Viewport|undefined {
  const available=Math.max(0,width-inspectorWidth),left=Math.min(60,available*.15),right=Math.max(left,available-12),bottom=Math.max(top+24,height-64)
  const size=nodeSize(node),x=node.x*view.scale+view.x,y=node.y*view.scale+view.y,w=size.width*view.scale,h=size.height*view.scale
  if(x>=left&&x+w<=right&&y>=top&&y+h<=bottom)return
  return {...view,x:(left+right)/2-(node.x+size.width/2)*view.scale,y:(top+bottom)/2-(node.y+size.height/2)*view.scale}
}
