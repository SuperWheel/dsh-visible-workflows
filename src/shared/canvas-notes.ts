import { CANVAS_NOTE_SIZE, type CanvasNote, type WorkflowNode } from './types.ts'
import { nodeSize } from './canvas-layout.ts'

const bounded=(value:number|undefined,fallback:number,min:number,max:number)=>Math.max(min,Math.min(max,typeof value==='number'&&Number.isFinite(value)?value:fallback))
export function noteSize(note:Pick<CanvasNote,'width'|'height'>):{width:number;height:number}{
  return {width:bounded(note.width,CANVAS_NOTE_SIZE.width,CANVAS_NOTE_SIZE.minWidth,CANVAS_NOTE_SIZE.maxWidth),height:bounded(note.height,CANVAS_NOTE_SIZE.height,CANVAS_NOTE_SIZE.minHeight,CANVAS_NOTE_SIZE.maxHeight)}
}
const detach=(note:CanvasNote):CanvasNote=>{const {anchorNodeId:_,...rest}=note;return rest}
/** Moves from the latest absolute note position, so dragging a note establishes a new offset. */
export function moveAttachedNotes(notes:readonly CanvasNote[],beforeNodes:readonly WorkflowNode[],afterNodes:readonly WorkflowNode[]):CanvasNote[]{
  const before=new Map(beforeNodes.map(n=>[n.id,n])),after=new Map(afterNodes.map(n=>[n.id,n]))
  return notes.map(note=>{
    if(!note.anchorNodeId)return note
    const next=after.get(note.anchorNodeId),previous=before.get(note.anchorNodeId)
    if(!next)return detach(note)
    if(!previous)return note
    const dx=next.x-previous.x,dy=next.y-previous.y
    return dx||dy?{...note,x:note.x+dx,y:note.y+dy}:note
  })
}
type Rect={x:number;y:number;width:number;height:number}
const overlaps=(a:Rect,b:Rect,gap=16)=>a.x<b.x+b.width+gap&&a.x+a.width+gap>b.x&&a.y<b.y+b.height+gap&&a.y+a.height+gap>b.y
/** Attached notes start below their anchor and avoid nodes, free notes, and previously placed notes. */
export function arrangeAttachedNotes(notes:readonly CanvasNote[],nodes:readonly WorkflowNode[]):CanvasNote[]{
  const byId=new Map(nodes.map(n=>[n.id,n])),occupied:Rect[]=nodes.map(node=>({x:node.x,y:node.y,...nodeSize(node)}))
  const normalized=notes.map(note=>note.anchorNodeId&&!byId.has(note.anchorNodeId)?detach(note):note)
  for(const note of normalized)if(!note.anchorNodeId)occupied.push({x:note.x,y:note.y,...noteSize(note)})
  return normalized.map(note=>{
    if(!note.anchorNodeId)return note
    const node=byId.get(note.anchorNodeId)!,position={x:node.x,y:node.y+nodeSize(node).height+24,...noteSize(note)}
    for(let tries=0;tries<=occupied.length;tries++){
      const collisions=occupied.filter(rect=>overlaps(position,rect))
      if(!collisions.length)break
      position.y=Math.max(...collisions.map(rect=>rect.y+rect.height))+16
    }
    occupied.push(position)
    return position.x===note.x&&position.y===note.y?note:{...note,x:position.x,y:position.y}
  })
}
