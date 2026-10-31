import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Canvas } from '../src/client/canvas.tsx'
import { StickyNote } from '../src/client/sticky-note.tsx'
import { useFrameState } from '../src/client/use-frame-state.ts'
import { newNode } from '../src/client/nodes.ts'
import { MiniMap } from '../src/client/mini-map.tsx'
import { centerViewport, worldViewport } from '../src/client/viewport.ts'
import { makeWorkflow, type CanvasNote, type WorkflowAPI, type WorkflowNode } from '../src/shared/types.ts'

// Keep React and the actual Canvas handlers. Only replace native SDK surfaces and
// the separately tested bitmap minimap; no browser, model, or Host is involved.
vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({
  Button:'button', Input:'input', Menu:()=>null, Modal:()=>null,
  Tooltip:({children}:{children:React.ReactNode})=>children,
}))
vi.mock('../src/client/mini-map.tsx',()=>({MiniMap:()=>null}))

const renderers:ReactTestRenderer[]=[]
let frameId=0,frames:Map<number,FrameRequestCallback>
beforeEach(()=>{
  vi.useFakeTimers()
  frameId=0;frames=new Map()
  vi.stubGlobal('requestAnimationFrame',vi.fn((callback:FrameRequestCallback)=>{const id=++frameId;frames.set(id,callback);return id}))
  vi.stubGlobal('cancelAnimationFrame',vi.fn((id:number)=>frames.delete(id)))
  // React test renderer supplies geometry doubles, not the browser CSSOM.
  vi.stubGlobal('getComputedStyle',()=>({getPropertyValue:(name:string)=>name==='--vdw-control-height'?'32px':''}))
  vi.stubGlobal('ResizeObserver',class {
    constructor(private readonly callback:()=>void){}
    observe(){this.callback()}
    disconnect(){}
  })
})
afterEach(()=>{
  for(const renderer of renderers.splice(0))act(()=>renderer.unmount())
  vi.useRealTimers();vi.unstubAllGlobals()
})
function nextFrame(){
  const callbacks=[...frames.values()];frames.clear()
  act(()=>{for(const callback of callbacks)callback(16)})
}
function pointer(x:number,y:number){return{
  button:0,clientX:x,clientY:y,pointerId:1,shiftKey:false,
  target:{closest:()=>null},stopPropagation:vi.fn(),preventDefault:vi.fn(),
}}
function mountCanvas(nodes:WorkflowNode[],notes:CanvasNote[]=[],overrides:Partial<React.ComponentProps<typeof Canvas>>={},geometry={width:600,height:500,inspectorWidth:0}){
  const workflow={...makeWorkflow('workspace','交互验收'),nodes,edges:[],notes}
  const capture=new Set<number>()
  const inspector={getBoundingClientRect:()=>({width:geometry.inspectorWidth})}
  const editorBody={clientWidth:geometry.width,style:{setProperty:vi.fn()},querySelector:(selector:string)=>geometry.inspectorWidth&&selector.includes('.vdw-editor-dock')?inspector:null}
  const element={
    clientWidth:geometry.width,clientHeight:geometry.height,
    getBoundingClientRect:()=>({left:0,top:0,width:geometry.width,height:geometry.height,right:geometry.width,bottom:geometry.height}),
    closest:()=>geometry.inspectorWidth?editorBody:null,
    setPointerCapture:(id:number)=>capture.add(id),hasPointerCapture:(id:number)=>capture.has(id),releasePointerCapture:(id:number)=>capture.delete(id),
    addEventListener:vi.fn(),removeEventListener:vi.fn(),
    focus:vi.fn(),
  }
  const onEdit=vi.fn(),onSelect=vi.fn(),onConfigure=vi.fn(),onViewport=vi.fn()
  let props:React.ComponentProps<typeof Canvas>={
    workflow,api:{} as WorkflowAPI,selected:[],disabled:false,canUndo:false,canRedo:false,
    annotations:[],viewport:{x:0,y:0,scale:1},onEdit,onSelect,onConfigure,onViewport,
    onEnter:vi.fn(),onAnnotate:vi.fn(),onEditAnnotation:vi.fn(),onUndo:vi.fn(),onRedo:vi.fn(),onNote:vi.fn(),onRunDetails:vi.fn(),...overrides,
  }
  let renderer!:ReactTestRenderer
  act(()=>{
    renderer=create(React.createElement(Canvas,props),{createNodeMock:node=>node.props['aria-label']==='工作流画布'?element:null})
  })
  renderers.push(renderer)
  return{renderer,onEdit,onSelect,onConfigure,onViewport,capture,focus:element.focus,
    surface:()=>renderer.root.findByProps({'aria-label':'工作流画布'}),
    node:(node:WorkflowNode)=>renderer.root.findByProps({'aria-label':`${node.number} ${node.title}`}),
    setSelected:(selected:string[])=>{props={...props,selected};act(()=>renderer.update(React.createElement(Canvas,props)))},
    update:(patch:Partial<React.ComponentProps<typeof Canvas>>)=>{props={...props,...patch};act(()=>renderer.update(React.createElement(Canvas,props)))},
    onAnnotate:props.onAnnotate as ReturnType<typeof vi.fn>,
    onEditAnnotation:props.onEditAnnotation as ReturnType<typeof vi.fn>,
    renderedCount:()=>renderer.root.findByProps({'data-total-nodes':nodes.length}).props['data-rendered-nodes'],
  }
}

describe('Canvas minimap navigates the strip exposed below a compact inspector',()=>{
  it.each([360,320])('keeps a navigated world point visible in a %dpx canvas at non-unit zoom',async width=>{
    const height=700,initial={x:40,y:30,scale:.5},fixture=mountCanvas([],[],{inspectorOpen:true,viewport:initial},{width,height,inspectorWidth:width-24})
    expect(fixture.renderer.root.findByProps({'data-total-nodes':0}).props.className).toContain('is-inspector-compact')
    act(()=>fixture.renderer.root.findByProps({'aria-label':'展开缩略图'}).props.onClick())
    const overview=()=>fixture.renderer.root.findByType(MiniMap).props
    const exposedTop=height-(width<360?242:198)+12,projection=worldViewport(overview().viewport,overview().width,overview().height)
    // Projection describes the unoccluded bottom strip, including the current pan and zoom.
    expect(projection.y*initial.scale+initial.y).toBe(exposedTop)
    expect(projection.width*initial.scale).toBeLessThanOrEqual(width-186)
    const target={x:900,y:1200}
    const centered=centerViewport(target,overview().viewport,overview().width,overview().height)
    act(()=>overview().onViewport(centered));nextFrame()
    await act(async()=>{await vi.advanceTimersByTimeAsync(100)})
    const saved=fixture.onViewport.mock.calls.at(-1)![0]
    const screen={x:target.x*saved.scale+saved.x,y:target.y*saved.scale+saved.y}
    expect(saved.scale).toBe(initial.scale)
    expect(screen.x).toBeGreaterThan(12)
    expect(screen.x).toBeLessThan(width-174) // The minimap starts at this right-hand boundary.
    expect(screen.y).toBeGreaterThan(exposedTop)
    expect(screen.y).toBeLessThan(height-(width<360?104:60))
    // Feeding the updated Canvas view back into MiniMap must retain the same world center.
    const projected=worldViewport(overview().viewport,overview().width,overview().height)
    expect(projected.x+projected.width/2).toBeCloseTo(target.x)
    expect(projected.y+projected.height/2).toBeCloseTo(target.y)
    expect(fixture.onEdit).not.toHaveBeenCalled()
  })
})

describe('Canvas pointer handlers commit the final release position',()=>{
  it.each(['pending','painted'] as const)('uses pointerup after a %s intermediate frame and saves exactly once',phase=>{
    const node=newNode('template',100,100),fixture=mountCanvas([node])
    act(()=>fixture.node(node).props.onPointerDown(pointer(110,110)))
    act(()=>fixture.surface().props.onPointerMove(pointer(130,130)))
    expect(fixture.onEdit).not.toHaveBeenCalled()
    if(phase==='painted')nextFrame()
    act(()=>fixture.surface().props.onPointerUp(pointer(190,170)))
    expect(fixture.onEdit).toHaveBeenCalledTimes(1)
    expect(fixture.onEdit.mock.calls[0]![0].nodes[0]).toMatchObject({id:node.id,x:180,y:160})
    expect(node).toMatchObject({x:100,y:100})
    expect(fixture.onConfigure).not.toHaveBeenCalled()
    expect(fixture.capture.size).toBe(0)
    nextFrame()
    expect(fixture.onEdit).toHaveBeenCalledTimes(1)
  })
  it('commits a release even when no pointermove was delivered',()=>{
    const node=newNode('template',100,100),fixture=mountCanvas([node])
    act(()=>fixture.node(node).props.onPointerDown(pointer(110,110)))
    act(()=>fixture.surface().props.onPointerUp(pointer(190,170)))
    expect(fixture.onEdit).toHaveBeenCalledTimes(1)
    expect(fixture.onEdit.mock.calls[0]![0].nodes[0]).toMatchObject({x:180,y:160})
  })
  it('uses the final release rectangle for box selection before its scheduled frame',()=>{
    const selected=newNode('template',100,100),outside=newNode('template',400,350),fixture=mountCanvas([selected,outside])
    act(()=>fixture.surface().props.onPointerDown(pointer(0,0)))
    act(()=>fixture.surface().props.onPointerMove(pointer(30,30)))
    act(()=>fixture.surface().props.onPointerUp(pointer(180,170)))
    expect(fixture.onSelect.mock.calls.at(-1)?.[0]).toEqual([selected.id])
    expect(fixture.onEdit).not.toHaveBeenCalled()
    nextFrame()
    expect(fixture.onSelect.mock.calls.at(-1)?.[0]).toEqual([selected.id])
  })
  it('keeps a true click as configuration rather than a saved move',()=>{
    const node=newNode('template',100,100),fixture=mountCanvas([node])
    act(()=>fixture.node(node).props.onPointerDown(pointer(110,110)))
    act(()=>fixture.surface().props.onPointerUp(pointer(110,110)))
    expect(fixture.onEdit).not.toHaveBeenCalled()
    expect(fixture.onConfigure).toHaveBeenCalledExactlyOnceWith(node.id)
  })
})

describe('Canvas keeps keyboard focus without defeating viewport culling',()=>{
  it('retains the focused offscreen node and releases it on blur',()=>{
    const focused={...newNode('template',100,100),title:'聚焦节点'},distant={...newNode('template',2100,100),title:'远处节点'},fixture=mountCanvas([focused,distant])
    expect(fixture.renderedCount()).toBe(1)
    act(()=>fixture.node(focused).props.onFocus())
    act(()=>fixture.surface().props.onWheel({deltaX:2000,deltaY:0,ctrlKey:false,metaKey:false}))
    nextFrame()
    expect(fixture.renderedCount()).toBe(2)
    expect(fixture.node(focused)).toBeDefined()
    expect(fixture.node(distant)).toBeDefined()
    act(()=>fixture.node(focused).props.onBlur())
    expect(fixture.renderedCount()).toBe(1)
    expect(fixture.renderer.root.findAllByProps({'aria-label':`${focused.number} ${focused.title}`})).toHaveLength(0)
    expect(fixture.node(distant)).toBeDefined()
  })
  it('selects the entire graph through the keyboard while mounting only visible nodes',()=>{
    const nodes=Array.from({length:10},(_,i)=>({...newNode('template',100+i*1200,100),title:`节点 ${i+1}`})),fixture=mountCanvas(nodes)
    const event={key:'a',metaKey:true,ctrlKey:false,preventDefault:vi.fn(),target:{closest:()=>null}}
    act(()=>fixture.surface().props.onKeyDown(event))
    const selected=fixture.onSelect.mock.calls.at(-1)![0] as string[]
    expect(selected).toEqual(nodes.map(node=>node.id))
    expect(event.preventDefault).toHaveBeenCalledOnce()
    fixture.setSelected(selected)
    expect(fixture.renderedCount()).toBe(1)
    expect(fixture.node(nodes[0]!).props['aria-pressed']).toBe(true)
    act(()=>fixture.surface().props.onWheel({deltaX:1200,deltaY:0,ctrlKey:false,metaKey:false}))
    nextFrame()
    expect(fixture.renderedCount()).toBe(1)
    expect(fixture.node(nodes[1]!).props['aria-pressed']).toBe(true)
    expect(fixture.renderer.root.findAllByProps({'aria-label':`${nodes[0]!.number} ${nodes[0]!.title}`})).toHaveLength(0)
  })
})

describe('useFrameState batches real React commits',()=>{
  it('accumulates high-frequency functional updates and paints only their final value',()=>{
    let state!:ReturnType<typeof useFrameState<number>>,renders=0
    function Probe(){renders++;state=useFrameState(0);return React.createElement('output',null,state[0])}
    let renderer!:ReactTestRenderer
    act(()=>{renderer=create(React.createElement(Probe))});renderers.push(renderer)
    act(()=>{for(let i=0;i<100;i++)state[1](previous=>previous+1)})
    expect(state[2].current).toBe(100)
    expect(state[0]).toBe(0)
    expect(frames.size).toBe(1)
    expect(renders).toBe(1)
    nextFrame()
    expect(renderer.root.findByType('output').children).toEqual(['100'])
    expect(state[0]).toBe(100)
    expect(renders).toBe(2)
    act(()=>{state[1](200);state[1](previous=>previous+1);state[1](250)})
    expect(state[2].current).toBe(250)
    expect(frames.size).toBe(1)
    nextFrame()
    expect(renderer.root.findByType('output').children).toEqual(['250'])
    expect(renders).toBe(3)
  })
  it('cancels pending React work on unmount',()=>{
    let state!:ReturnType<typeof useFrameState<number>>
    function Probe(){state=useFrameState(0);return null}
    let renderer!:ReactTestRenderer
    act(()=>{renderer=create(React.createElement(Probe))})
    act(()=>state[1](42))
    expect(frames.size).toBe(1)
    act(()=>renderer.unmount())
    expect(frames.size).toBe(0)
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1)
  })
})


describe('Canvas note and keyboard transactions',()=>{
  it('moves an attached note with its node in one edit',()=>{
    const node=newNode('template',100,100),note={id:'note',text:'说明',x:80,y:300,anchorNodeId:node.id},fixture=mountCanvas([node],[note])
    act(()=>fixture.node(node).props.onPointerDown(pointer(110,110)))
    act(()=>fixture.surface().props.onPointerUp(pointer(190,170)))
    expect(fixture.onEdit).toHaveBeenCalledOnce()
    expect(fixture.onEdit.mock.calls[0]![0].notes[0]).toMatchObject({x:160,y:360,anchorNodeId:node.id})
  })
  it('clears the note target when a node is right-clicked, so Delete removes the node',()=>{
    const node=newNode('template',100,100),note={id:'note',text:'说明',x:80,y:300},fixture=mountCanvas([node],[note])
    act(()=>fixture.renderer.root.findByType(StickyNote).props.onSelect())
    act(()=>fixture.node(node).props.onContextMenu({clientX:100,clientY:100,preventDefault:vi.fn()}))
    fixture.setSelected([node.id])
    act(()=>fixture.surface().props.onKeyDown({key:'Delete',target:{closest:()=>null},preventDefault:vi.fn()}))
    expect(fixture.onEdit.mock.calls.at(-1)![0].nodes).toHaveLength(0)
    expect(fixture.onEdit.mock.calls.at(-1)![0].notes).toEqual([note])
  })
  it('coalesces repeated arrow-key movement into one undoable save',()=>{
    const node=newNode('template',100,100),fixture=mountCanvas([node]);fixture.setSelected([node.id])
    const event={key:'ArrowRight',shiftKey:true,preventDefault:vi.fn(),target:{closest:()=>null}}
    act(()=>{for(let i=0;i<6;i++)fixture.surface().props.onKeyDown(event)})
    expect(fixture.onEdit).not.toHaveBeenCalled()
    act(()=>fixture.surface().props.onKeyUp({key:'ArrowRight'}))
    expect(fixture.onEdit).toHaveBeenCalledOnce()
    expect(fixture.onEdit.mock.calls[0]![0].nodes[0]).toMatchObject({x:160,y:100})
  })
  it('switches hand and pointer modes through H/V without changing text fields',()=>{
    const fixture=mountCanvas([]),event=(key:string,input=false)=>({key,target:{closest:()=>input?{}:null}})
    act(()=>fixture.surface().props.onKeyDown(event('h')))
    expect(fixture.surface().props.className).toContain('is-hand')
    act(()=>fixture.surface().props.onKeyDown(event('v',true)))
    expect(fixture.surface().props.className).toContain('is-hand')
    act(()=>fixture.surface().props.onKeyDown(event('v')))
    expect(fixture.surface().props.className).not.toContain('is-hand')
  })
})

describe('Canvas annotations stay at one user-chosen world point',()=>{
  it('shows only the current scope local number while keeping its stable node identity',()=>{
    const node={...newNode('template',100,100),number:'a-4:a-1',title:'内部节点'},fixture=mountCanvas([node],[],{scopePath:['iteration']})
    const card=fixture.renderer.root.findByProps({'aria-label':'a-1 内部节点'})
    expect(card.props.title).toBeUndefined()
    expect(fixture.renderer.root.findByProps({className:'vdw-node-number'}).children.join('')).toBe('a-1 · ')
    act(()=>card.props.onKeyDown({key:'Enter',stopPropagation:vi.fn()}))
    expect(fixture.onConfigure).toHaveBeenCalledExactlyOnceWith(node.id)
    expect(node.number).toBe('a-4:a-1')
  })
  it('arms placement first and captures the clicked world point without moving or deselecting nodes',()=>{
    const node=newNode('template',100,100),fixture=mountCanvas([node],[],{viewport:{x:40,y:20,scale:.5},scopePath:['iteration']});fixture.setSelected([node.id])
    act(()=>fixture.renderer.root.findByProps({'aria-label':'添加注释'}).props.onClick())
    expect(fixture.onAnnotate).not.toHaveBeenCalled()
    expect(fixture.focus).toHaveBeenCalledWith({preventScroll:true})
    const event=pointer(240,180)
    act(()=>fixture.surface().props.onPointerDownCapture(event))
    expect(fixture.onAnnotate).toHaveBeenCalledExactlyOnceWith({position:{x:400,y:320,scopePath:['iteration']},anchorRect:{left:226,right:254,top:166,bottom:194}})
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(fixture.onEdit).not.toHaveBeenCalled()
    expect(fixture.onSelect).not.toHaveBeenCalled()
    expect(fixture.surface().props.className).not.toContain('is-placing-annotation')
  })
  it('Escape cancels placement without dropping node selection or creating a note',()=>{
    const node=newNode('template',100,100),fixture=mountCanvas([node]);fixture.setSelected([node.id])
    act(()=>fixture.renderer.root.findByProps({'aria-label':'添加注释'}).props.onClick())
    act(()=>fixture.surface().props.onKeyDown({key:'Escape',preventDefault:vi.fn(),target:{closest:()=>null}}))
    expect(fixture.surface().props.className).not.toContain('is-placing-annotation')
    expect(fixture.onSelect).not.toHaveBeenCalled();expect(fixture.onAnnotate).not.toHaveBeenCalled()
  })
  it('renders one marker for many references and follows the world point when panning',()=>{
    const a=newNode('template',100,100),b=newNode('template',400,100),fixture=mountCanvas([a,b])
    fixture.update({annotations:[{id:'note',number:1,nodeIds:[a.id,b.id],text:'调整',position:{x:240,y:220,scopePath:[]}}]})
    const pins=()=>fixture.renderer.root.findAllByProps({className:'vdw-annotation-pin '})
    expect(pins()).toHaveLength(1);expect(pins()[0]!.props.style).toEqual({left:240,top:220})
    act(()=>fixture.surface().props.onWheel({deltaX:60,deltaY:20,ctrlKey:false,metaKey:false}));nextFrame()
    expect(pins()[0]!.props.style).toEqual({left:180,top:200})
    const rect={left:166,right:194,top:186,bottom:214}
    act(()=>pins()[0]!.props.onClick({stopPropagation:vi.fn(),currentTarget:{getBoundingClientRect:()=>rect}}))
    expect(fixture.onEditAnnotation).toHaveBeenCalledExactlyOnceWith('note',rect)
    expect(fixture.onEdit).not.toHaveBeenCalled()
  })
  it('keeps points in their own nested scope and replaces an existing pin with its pending draft',()=>{
    const a=newNode('template',100,100),fixture=mountCanvas([a]),note={id:'note',number:1,nodeIds:[a.id],text:'调整',position:{x:240,y:220,scopePath:['iteration']}}
    fixture.update({annotations:[note]})
    expect(fixture.renderer.root.findAllByProps({'data-annotation-id':'note'})).toHaveLength(0)
    fixture.update({scopePath:['iteration'],pendingAnnotation:note})
    expect(fixture.renderer.root.findAllByProps({'data-annotation-id':'note'})).toHaveLength(1)
    expect(fixture.renderer.root.findByProps({'data-annotation-id':'note'}).props.className).toContain('is-pending')
  })
  it('supports older drafts with one fallback marker instead of repeating it per node',()=>{
    const a=newNode('template',100,100),b=newNode('template',400,100),fixture=mountCanvas([a,b])
    fixture.update({annotations:[{id:'legacy',number:2,nodeIds:[a.id,b.id],text:'旧草稿'}]})
    expect(fixture.renderer.root.findAllByProps({'data-annotation-id':'legacy'})).toHaveLength(1)
  })
})
