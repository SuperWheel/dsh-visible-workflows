import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Canvas } from '../src/client/canvas.tsx'
import { StickyNote } from '../src/client/sticky-note.tsx'
import { useFrameState } from '../src/client/use-frame-state.ts'
import { newNode } from '../src/client/nodes.ts'
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
function mountCanvas(nodes:WorkflowNode[],notes:CanvasNote[]=[]){
  const workflow={...makeWorkflow('workspace','交互验收'),nodes,edges:[],notes}
  const capture=new Set<number>()
  const element={
    clientWidth:600,clientHeight:500,
    getBoundingClientRect:()=>({left:0,top:0,width:600,height:500,right:600,bottom:500}),
    setPointerCapture:(id:number)=>capture.add(id),hasPointerCapture:(id:number)=>capture.has(id),releasePointerCapture:(id:number)=>capture.delete(id),
    addEventListener:vi.fn(),removeEventListener:vi.fn(),
  }
  const onEdit=vi.fn(),onSelect=vi.fn(),onConfigure=vi.fn(),onViewport=vi.fn()
  const props:React.ComponentProps<typeof Canvas>={
    workflow,api:{} as WorkflowAPI,selected:[],disabled:false,canUndo:false,canRedo:false,
    annotations:[],viewport:{x:0,y:0,scale:1},onEdit,onSelect,onConfigure,onViewport,
    onEnter:vi.fn(),onAnnotate:vi.fn(),onEditAnnotation:vi.fn(),onUndo:vi.fn(),onRedo:vi.fn(),onNote:vi.fn(),onRunDetails:vi.fn(),
  }
  let renderer!:ReactTestRenderer
  act(()=>{
    renderer=create(React.createElement(Canvas,props),{createNodeMock:node=>node.props['aria-label']==='工作流画布'?element:null})
  })
  renderers.push(renderer)
  return{renderer,onEdit,onSelect,onConfigure,onViewport,capture,
    surface:()=>renderer.root.findByProps({'aria-label':'工作流画布'}),
    node:(node:WorkflowNode)=>renderer.root.findByProps({'aria-label':`${node.number} ${node.title}`}),
    setSelected:(selected:string[])=>act(()=>renderer.update(React.createElement(Canvas,{...props,selected}))),
    renderedCount:()=>renderer.root.findByProps({'data-total-nodes':nodes.length}).props['data-rendered-nodes'],
  }
}

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
