import { t, useLocale } from './i18n.ts'
import { useEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import type { WorkflowNode } from '../shared/types.ts'
import { nodeSize } from './nodes.ts'
import { centerViewport, createViewportIndex, miniMapToWorld, miniMapTransform, unionRects, worldToMiniMap, worldViewport, type MiniMapTransform, type Point, type Viewport } from './viewport.ts'

export interface MiniMapProps {
  nodes:WorkflowNode[]
  viewport:Viewport
  width:number
  height:number
  onViewport:(view:Viewport)=>void
}
const WIDTH=160,HEIGHT=100
interface Drag { pointerId:number; map:MiniMapTransform; offset:Point; viewport:Viewport; width:number; height:number }
/** One bitmap for the entire graph; no React subtree is created for individual nodes. */
export function MiniMap(props:MiniMapProps){useLocale();
  const canvas=useRef<HTMLCanvasElement>(null),drag=useRef<Drag>(),frame=useRef<number>(),pending=useRef<Viewport>(),latest=useRef(props),requestRedraw=useRef<()=>void>(()=>{})
  latest.current=props
  const index=useMemo(()=>createViewportIndex(props.nodes,[]),[props.nodes])
  const visible=worldViewport(props.viewport,props.width,props.height)
  // Include the current view, including empty space outside the graph, so its frame stays reachable.
  const map=miniMapTransform(index.nodes.length?unionRects(index.bounds,visible):visible,WIDTH,HEIGHT,8),currentMap=useRef(map)
  currentMap.current=map
  const commit=()=>{frame.current=undefined;const view=pending.current;pending.current=undefined;if(view)latest.current.onViewport(view)}
  const schedule=(view:Viewport)=>{pending.current=view;if(frame.current===undefined)frame.current=requestAnimationFrame(commit)}
  const flush=()=>{if(frame.current!==undefined){cancelAnimationFrame(frame.current);frame.current=undefined}commit()}
  useEffect(()=>()=>{if(frame.current!==undefined)cancelAnimationFrame(frame.current)},[])
  useEffect(()=>{
    const element=canvas.current;if(!element)return
    let drawFrame:number|undefined
    const draw=()=>{
      drawFrame=undefined
      const ctx=element.getContext('2d');if(!ctx)return
      const dpr=Math.max(1,Math.min(window.devicePixelRatio||1,3))
      if(element.width!==Math.round(WIDTH*dpr)||element.height!==Math.round(HEIGHT*dpr)){element.width=Math.round(WIDTH*dpr);element.height=Math.round(HEIGHT*dpr)}
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,WIDTH,HEIGHT)
      const computed=getComputedStyle(element),color=(name:string,fallback:string)=>computed.getPropertyValue(name).trim()||fallback
      ctx.fillStyle=color('--dsw-alias-bg-layer-1',computed.backgroundColor);ctx.fillRect(0,0,WIDTH,HEIGHT)
      ctx.fillStyle=color('--dsw-alias-label-tertiary',computed.color)
      // Keep the projection fixed during dragging, matching the pointer-to-world mapping.
      const transform=drag.current?.map??currentMap.current
      ctx.globalAlpha=.5
      for(const node of latest.current.nodes){const point=worldToMiniMap(node,transform),size=nodeSize(node);ctx.fillRect(point.x,point.y,Math.max(1,size.width*transform.scale),Math.max(1,size.height*transform.scale))}
      ctx.globalAlpha=1
      const view=worldViewport(latest.current.viewport,latest.current.width,latest.current.height),point=worldToMiniMap(view,transform)
      ctx.fillStyle=color('--dsw-alias-state-business-primary',computed.color);ctx.globalAlpha=.1;ctx.fillRect(point.x,point.y,view.width*transform.scale,view.height*transform.scale);ctx.globalAlpha=1
      ctx.strokeStyle=color('--dsw-alias-state-business-primary',computed.color);ctx.lineWidth=1.5;ctx.strokeRect(point.x,point.y,view.width*transform.scale,view.height*transform.scale)
    }
    const redraw=()=>{if(drawFrame===undefined)drawFrame=requestAnimationFrame(draw)}
    requestRedraw.current=redraw
    redraw()
    // The map has a fixed CSS size; resize refreshes the backing bitmap when monitor DPR changes.
    window.addEventListener('resize',redraw)
    const observer=new MutationObserver(redraw)
    observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','data-ds-dark-theme','class','style']})
    observer.observe(document.body,{attributes:true,attributeFilter:['data-theme','data-ds-dark-theme','class','style']})
    return()=>{requestRedraw.current=()=>{};if(drawFrame!==undefined)cancelAnimationFrame(drawFrame);window.removeEventListener('resize',redraw);observer.disconnect()}
  },[])
  useEffect(()=>{requestRedraw.current()},[props.nodes,props.viewport.x,props.viewport.y,props.viewport.scale,props.width,props.height])
  const localPoint=(event:PointerEvent<HTMLCanvasElement>):Point=>{const rect=event.currentTarget.getBoundingClientRect();return{x:(event.clientX-rect.left)*WIDTH/Math.max(1,rect.width),y:(event.clientY-rect.top)*HEIGHT/Math.max(1,rect.height)}}
  const move=(event:PointerEvent<HTMLCanvasElement>)=>{const active=drag.current;if(!active||event.pointerId!==active.pointerId)return;event.stopPropagation();const point=miniMapToWorld(localPoint(event),active.map);schedule(centerViewport({x:point.x-active.offset.x,y:point.y-active.offset.y},active.viewport,active.width,active.height))}
  const down=(event:PointerEvent<HTMLCanvasElement>)=>{
    if(event.button!==0)return;event.preventDefault();event.stopPropagation();event.currentTarget.focus()
    const current=latest.current,map=currentMap.current,point=miniMapToWorld(localPoint(event),map),view=worldViewport(current.viewport,current.width,current.height)
    const inside=point.x>=view.x&&point.x<=view.x+view.width&&point.y>=view.y&&point.y<=view.y+view.height
    drag.current={pointerId:event.pointerId,map,viewport:current.viewport,width:current.width,height:current.height,offset:inside?{x:point.x-(view.x+view.width/2),y:point.y-(view.y+view.height/2)}:{x:0,y:0}}
    event.currentTarget.setPointerCapture(event.pointerId);move(event)
  }
  const end=(event:PointerEvent<HTMLCanvasElement>)=>{
    if(event.pointerId!==drag.current?.pointerId)return
    event.stopPropagation();drag.current=undefined;flush()
    // Reproject after releasing the frozen drag map even if pointer-up did not change the viewport.
    requestRedraw.current()
  }
  const up=(event:PointerEvent<HTMLCanvasElement>)=>{if(event.pointerId!==drag.current?.pointerId)return;move(event);end(event);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId)}
  const key=(event:KeyboardEvent<HTMLCanvasElement>)=>{
    const current=latest.current,view=pending.current??current.viewport,amount=event.shiftKey ? .5 : .1
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){
      event.preventDefault();event.stopPropagation();schedule({...view,x:view.x+(event.key==='ArrowLeft'?1:event.key==='ArrowRight'?-1:0)*current.width*amount,y:view.y+(event.key==='ArrowUp'?1:event.key==='ArrowDown'?-1:0)*current.height*amount})
    } else if(['Home','Enter',' '].includes(event.key)){
      event.preventDefault();event.stopPropagation();const bounds=index.bounds;schedule(centerViewport({x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2},view,current.width,current.height))
    }
  }
  return <canvas ref={canvas} className="vdw-minimap" style={{width:WIDTH,height:HEIGHT,touchAction:'none',display:'block'}} tabIndex={0} role="button" aria-roledescription={t("交互式缩略图")} aria-label={t("工作流缩略图，点击或拖动定位；方向键移动视野，Home 或回车回到流程中心")} title={t("点击或拖动定位；方向键移动视野")} onKeyDown={key} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={end} onLostPointerCapture={end} onWheel={event=>event.stopPropagation()}/>
}
