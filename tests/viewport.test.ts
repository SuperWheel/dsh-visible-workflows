import { describe, expect, it } from 'vitest'
import type { WorkflowEdge } from '../src/shared/types.ts'
import { newNode, nodeSize, portY } from '../src/client/nodes.ts'
import { centerViewport, createViewportIndex, cubicBezierBounds, cullViewport, intersectsRect, miniMapToWorld, miniMapTransform, unionRects, worldToMiniMap, worldViewport } from '../src/client/viewport.ts'

describe('viewport geometry and graph culling',()=>{
  it('converts a constant screen buffer through the current pan and zoom',()=>{
    expect(worldViewport({x:-400,y:100,scale:2},800,600,200)).toEqual({x:100,y:-150,width:600,height:500})
    expect(worldViewport({x:-400,y:100,scale:.5},800,600,200)).toEqual({x:400,y:-600,width:2400,height:2000})
    const near=newNode('template',650,20),far=newNode('template',750,20),index=createViewportIndex([near,far],[])
    expect(cullViewport(index,{x:0,y:0,scale:1},500,300).nodes.map(n=>n.id)).toEqual([near.id])
  })
  it('keeps partially visible large nodes and pinned drag targets without rendering all offscreen nodes',()=>{
    const container=newNode('iteration',-470,30),offscreen=newNode('template',1600,200),pinned=newNode('template',-2000,-2000)
    const index=createViewportIndex([container,offscreen,pinned],[])
    expect(cullViewport(index,{x:0,y:0,scale:1},500,300,0,new Set([pinned.id])).nodes).toEqual([container,pinned])
    expect(index.bounds).toEqual({x:-2000,y:-2000,width:3856,height:2280})
    expect(index.nodeById.get(container.id)).toBe(container)
  })
  it('retains a crossing edge even when both endpoint nodes are offscreen',()=>{
    const left=newNode('template',-600,20),right=newNode('template',1000,20),edge={id:'crossing',source:left.id,target:right.id}
    const index=createViewportIndex([left,right],[edge,{id:'missing',source:left.id,target:'deleted'}])
    const visible=cullViewport(index,{x:0,y:0,scale:1},500,300,0)
    expect(visible.nodes).toHaveLength(0)
    expect(visible.edges.map(e=>e.edge.id)).toEqual(['crossing'])
    expect(index.edges).toHaveLength(1)
  })
  it('includes actual cubic extrema rather than only endpoints',()=>{
    const points=[{x:0,y:0},{x:100,y:100},{x:-100,y:100},{x:0,y:0}] as const
    const bounds=cubicBezierBounds(...points)
    expect(bounds.x).toBeLessThan(-28);expect(bounds.x+bounds.width).toBeGreaterThan(28)
    expect(bounds.y).toBe(0);expect(bounds.height).toBeCloseTo(75)
    // The curve turns into this area although both endpoints are at the origin.
    expect(intersectsRect(bounds,{x:20,y:20,width:10,height:60})).toBe(true)
    for(let i=0;i<=100;i++){
      const t=i/100,u=1-t,x=u**3*points[0].x+3*u*u*t*points[1].x+3*u*t*t*points[2].x+t**3*points[3].x,y=u**3*points[0].y+3*u*u*t*points[1].y+3*u*t*t*points[2].y+t**3*points[3].y
      expect(x).toBeGreaterThanOrEqual(bounds.x-1e-9);expect(x).toBeLessThanOrEqual(bounds.x+bounds.width+1e-9)
      expect(y).toBeGreaterThanOrEqual(bounds.y-1e-9);expect(y).toBeLessThanOrEqual(bounds.y+bounds.height+1e-9)
    }
  })
  it('uses actual branch port heights and model-node dimensions for cached edges',()=>{
    const branch=newNode('classifier',-100,80,{classes:Array.from({length:30},(_,i)=>({id:`class-${i}`,label:`Class ${i}`}))}),target=newNode('llm',550,400)
    const edges:WorkflowEdge[]=Array.from({length:30},(_,i)=>({id:`edge-${i}`,source:branch.id,target:target.id,port:`class-${i}`}))
    const index=createViewportIndex([branch,target],edges)
    for(const curve of index.edges){
      expect(curve.start).toEqual({x:branch.x+nodeSize(branch).width,y:branch.y+portY(branch,curve.edge.port!)})
      expect(curve.end).toEqual({x:target.x,y:target.y+nodeSize(target).height/2})
    }
  })
  it('does not mount a whole graph before the surface is measured and handles empty graphs',()=>{
    const node=newNode('template'),index=createViewportIndex([node],[])
    expect(cullViewport(index,{x:0,y:0,scale:1},0,0).nodes).toEqual([])
    expect(cullViewport(index,{x:0,y:0,scale:1},0,0,200,new Set([node.id])).nodes).toEqual([node])
    expect(createViewportIndex([],[]).bounds).toEqual({x:0,y:0,width:0,height:0})
    expect(cullViewport(createViewportIndex([],[]),{x:0,y:0,scale:1},500,300).edges).toEqual([])
  })
  it('reduces a large graph to its visible subset and keeps identity lookups intact',()=>{
    const nodes=Array.from({length:1000},(_,i)=>({...newNode(i>2&&i%4===0?'iteration':i>2&&i%4===1?'classifier':'template',i*600,0),id:`n-${i}`})),edges:WorkflowEdge[]=nodes.slice(1).map((node,i)=>({id:`e-${i}`,source:nodes[i]!.id,target:node.id}))
    const index=createViewportIndex(nodes,edges),visible=cullViewport(index,{x:0,y:0,scale:1},1400,300,0)
    expect(index.nodeById.size).toBe(1000);expect(index.edges).toHaveLength(999)
    expect(index.nodeById.get('n-999')).toBe(nodes[999])
    expect(visible.nodes.map(n=>n.id)).toEqual(['n-0','n-1','n-2'])
    expect(visible.edges.map(e=>e.edge.id)).toEqual(['e-0','e-1'])
  })
  it('keeps strokes on the shared viewport boundary visible',()=>{
    expect(intersectsRect({x:-100,y:0,width:100,height:50},{x:0,y:0,width:100,height:50})).toBe(true)
    expect(intersectsRect({x:-101,y:0,width:100,height:50},{x:0,y:0,width:100,height:50})).toBe(false)
  })
})

describe('minimap navigation',()=>{
  it('fits true negative-coordinate bounds with padding and roundtrips pointer coordinates',()=>{
    const bounds={x:-1600,y:-350,width:2400,height:700},map=miniMapTransform(bounds)
    const a=worldToMiniMap(bounds,map),b=worldToMiniMap({x:bounds.x+bounds.width,y:bounds.y+bounds.height},map)
    expect(a.x).toBeCloseTo(8);expect(b.x).toBeCloseTo(172);expect(a.y).toBeGreaterThanOrEqual(8);expect(b.y).toBeLessThanOrEqual(104)
    const world={x:-432.5,y:76.25},result=miniMapToWorld(worldToMiniMap(world,map),map)
    expect(result.x).toBeCloseTo(world.x);expect(result.y).toBeCloseTo(world.y)
  })
  it('keeps a viewport outside the graph on the minimap and centers clicks without changing zoom',()=>{
    const view={x:6000,y:-900,scale:1.5},visible=worldViewport(view,900,600),graph={x:0,y:0,width:1000,height:400},map=miniMapTransform(unionRects(graph,visible))
    const a=worldToMiniMap(visible,map),b=worldToMiniMap({x:visible.x+visible.width,y:visible.y+visible.height},map)
    expect(a.x).toBeGreaterThanOrEqual(7.999);expect(a.y).toBeGreaterThanOrEqual(7.999);expect(b.x).toBeLessThanOrEqual(172.001);expect(b.y).toBeLessThanOrEqual(104.001)
    const center={x:-150,y:240},next=centerViewport(center,view,900,600),nextWorld=worldViewport(next,900,600)
    expect(next.scale).toBe(1.5);expect(nextWorld.x+nextWorld.width/2).toBeCloseTo(center.x);expect(nextWorld.y+nextWorld.height/2).toBeCloseTo(center.y)
  })
  it('produces finite mappings for empty graphs and unmeasured viewports',()=>{
    const map=miniMapTransform({x:0,y:0,width:0,height:0},0,0)
    expect(Number.isFinite(map.scale)).toBe(true);expect(map.scale).toBeGreaterThan(0)
    const emptyView=worldViewport({x:NaN,y:Infinity,scale:0},0,0)
    for(const value of Object.values(emptyView))expect(value).toBeCloseTo(0)
    expect(centerViewport({x:0,y:0},{x:0,y:0,scale:0},0,0)).toEqual({x:0,y:0,scale:1})
  })
})
