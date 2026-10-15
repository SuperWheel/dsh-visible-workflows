import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MiniMap, type MiniMapProps } from '../src/client/mini-map.tsx'
import { newNode, nodeSize } from '../src/client/nodes.ts'
import { miniMapTransform, unionRects, worldToMiniMap, worldViewport } from '../src/client/viewport.ts'

let renderer:ReactTestRenderer|undefined
let frames:Map<number,FrameRequestCallback>
beforeEach(()=>{
  frames=new Map();let nextFrame=0
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{const id=++nextFrame;frames.set(id,callback);return id})
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id))
  vi.stubGlobal('window',{devicePixelRatio:2,addEventListener:vi.fn(),removeEventListener:vi.fn()})
  vi.stubGlobal('document',{documentElement:{},body:{}})
  vi.stubGlobal('MutationObserver',class {observe(){}disconnect(){}})
  vi.stubGlobal('getComputedStyle',()=>({getPropertyValue:()=>'',backgroundColor:'#fff',color:'#555'}))
})
afterEach(()=>{if(renderer)act(()=>renderer!.unmount());renderer=undefined;vi.unstubAllGlobals()})
function drawFrames(){
  let count=0
  while(frames.size){
    if(++count>20)throw new Error('Unbounded animation loop')
    const callbacks=[...frames.values()];frames.clear()
    act(()=>{for(const callback of callbacks)callback(0)})
  }
}
function setup(){
  const context={setTransform:vi.fn(),clearRect:vi.fn(),fillRect:vi.fn(),strokeRect:vi.fn(),fillStyle:'',strokeStyle:'',globalAlpha:1,lineWidth:1}
  const captures=new Set<number>(),canvas={width:0,height:0,getContext:()=>context,focus:vi.fn(),getBoundingClientRect:()=>({left:0,top:0,width:160,height:100}),setPointerCapture:(id:number)=>captures.add(id),hasPointerCapture:(id:number)=>captures.has(id),releasePointerCapture:(id:number)=>captures.delete(id)}
  // Keep this projection fixture at 1000×500 regardless of card density.
  const last=newNode('template',744,0);last.y=500-nodeSize(last).height
  const nodes=[newNode('template',0,0),last]
  let props:MiniMapProps={nodes,viewport:{x:0,y:0,scale:1},width:500,height:300,onViewport:()=>{}}
  const onViewport=vi.fn((view:MiniMapProps['viewport'])=>{
    // The parent may ignore an identical final pointer-up value; the minimap must still redraw.
    if(view.x===props.viewport.x&&view.y===props.viewport.y&&view.scale===props.viewport.scale)return
    props={...props,viewport:view};renderer!.update(React.createElement(MiniMap,props))
  })
  props={...props,onViewport}
  act(()=>{renderer=create(React.createElement(MiniMap,props),{createNodeMock:element=>element.type==='canvas'?canvas:null})})
  drawFrames()
  const event=(x:number,y:number,pointerId=1)=>({currentTarget:canvas,clientX:x,clientY:y,pointerId,button:0,preventDefault:vi.fn(),stopPropagation:vi.fn()})
  const invoke=(handler:string,x:number,y:number,pointerId=1)=>act(()=>renderer!.root.findByType('canvas').props[handler](event(x,y,pointerId)))
  const drawnCenter=()=>{const [x,y,width,height]=context.strokeRect.mock.calls.at(-1)! as unknown as number[];return{x:x!+width!/2,y:y!+height!/2}}
  return {context,canvas,invoke,drawnCenter,onViewport,props:()=>props}
}

describe('minimap drag projection',()=>{
  it('keeps the drawn viewport under the pointer while graph-plus-viewport bounds expand',()=>{
    const map=setup()
    expect(map.drawnCenter().x).toBeCloseTo(44)
    map.invoke('onPointerDown',44,35.6);drawFrames()
    map.invoke('onPointerMove',149,35.6);drawFrames()
    expect(map.drawnCenter().x).toBeCloseTo(149)
    expect(map.drawnCenter().y).toBeCloseTo(35.6)
    expect(map.props().viewport.x).toBeCloseTo(-729.1666666666667)
    expect(map.canvas.width).toBe(320);expect(map.canvas.height).toBe(200)

    const currentView=worldViewport(map.props().viewport,500,300)
    const unlocked=miniMapTransform(unionRects({x:0,y:0,width:1000,height:500},currentView),160,100,8)
    const unlockedCenter=worldToMiniMap({x:currentView.x+250,y:currentView.y+150},unlocked)
    // Recomputing bounds mid-drag would put the visible center ~30px behind the pointer.
    expect(unlockedCenter.x).toBeCloseTo(122.71186440677965,2)
    expect(map.drawnCenter().x-unlockedCenter.x).toBeGreaterThan(25)
  })
  it('redraws the unlocked projection on pointer-up even with an unchanged viewport',()=>{
    const map=setup()
    map.invoke('onPointerDown',44,35.6);drawFrames()
    map.invoke('onPointerMove',149,35.6);drawFrames()
    const viewport=map.props().viewport,drawCount=map.context.strokeRect.mock.calls.length
    map.invoke('onPointerUp',149,35.6);drawFrames()
    expect(map.props().viewport).toBe(viewport)
    expect(map.context.strokeRect.mock.calls.length).toBeGreaterThan(drawCount)
    expect(map.drawnCenter().x).toBeCloseTo(122.71186440677965,2)
    expect(map.canvas.hasPointerCapture(1)).toBe(false)
  })
  it('flushes the final drag position and redraws after pointer cancellation',()=>{
    const map=setup()
    map.invoke('onPointerDown',44,35.6);drawFrames()
    map.invoke('onPointerMove',149,35.6)
    // Cancel before the scheduled movement frame: no last position or redraw may be dropped.
    map.invoke('onPointerCancel',149,35.6);drawFrames()
    expect(map.props().viewport.x).toBeCloseTo(-729.1666666666667)
    expect(map.drawnCenter().x).toBeCloseTo(122.71186440677965,2)
  })
})
