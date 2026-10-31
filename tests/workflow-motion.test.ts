import { describe, expect, it, vi } from 'vitest'
import { createWorkflowSizeMotion, installWorkflowMotion, WORKFLOW_MOTION_DURATION } from '../src/client/workflow-motion.ts'

type Size={width:number;height:number}
function elementFixture(name='vdw-menu') {
  let natural:Size={width:200,height:100},painted:Size|undefined,current:any
  const animations:any[]=[]
  const element={
    isConnected:true,nodeType:1,parentElement:null,
    matches:(selector:string)=>selector.split(',').some(part=>part.trim()===`.${name}`),
    closest:()=>name==='foreign-menu'?null:element,
    contains:(target:unknown)=>target===element,
    querySelectorAll:()=>[],
    getBoundingClientRect:()=>({...painted??natural,x:0,y:0,top:0,left:0,right:0,bottom:0,toJSON(){}}),
    animate:vi.fn((frames:Keyframe[],timing:KeyframeAnimationOptions)=>{
      let resolve!:()=>void,reject!:(error:Error)=>void
      const finished=new Promise<void>((done,fail)=>{resolve=done;reject=fail})
      const animation={frames,timing,finished,resolve,cancel:vi.fn(()=>{if(current===animation){current=undefined;painted=undefined}reject(new Error('cancelled'))})}
      current=animation;painted={width:parseFloat(String(frames[0]!.width)),height:parseFloat(String(frames[0]!.height))};animations.push(animation);return animation as unknown as Animation
    }),
  }
  return {element:element as unknown as HTMLElement,animations,setNatural:(size:Size)=>{natural=size},paint:(size:Size)=>{painted=size}}
}

describe('workflow box motion',()=>{
  it('establishes a quiet initial baseline and animates genuine natural width and height changes without scaling',async()=>{
    const f=elementFixture(),motion=createWorkflowSizeMotion(f.element)
    motion.resize();expect(f.element.animate).not.toHaveBeenCalled()
    f.setNatural({width:300,height:180});motion.resize()
    expect(f.animations[0].frames).toEqual([{width:'200px',height:'100px'},{width:'300px',height:'180px'}])
    expect(f.animations[0].timing).toMatchObject({duration:WORKFLOW_MOTION_DURATION,fill:'both'})
    f.paint({width:240,height:130});for(let index=0;index<20;index++)motion.resize()
    expect(f.element.animate).toHaveBeenCalledOnce()
    f.animations[0].resolve();await Promise.resolve()
    expect(f.animations[0].cancel).toHaveBeenCalledOnce();expect(f.element.animate).toHaveBeenCalledOnce()
    motion.dispose()
  })

  it('retargets from the currently painted size on rapid reverse changes and ignores stale completion callbacks',async()=>{
    const f=elementFixture();let now=0;const motion=createWorkflowSizeMotion(f.element,{now:()=>now})
    f.setNatural({width:300,height:180});motion.resize();f.paint({width:260,height:140});now=60
    f.animations[0].resolve()
    f.setNatural({width:100,height:80});motion.resize(true)
    expect(f.animations[1].frames).toEqual([{width:'260px',height:'140px'},{width:'100px',height:'80px'}])
    await Promise.resolve();expect(f.animations[1].cancel).not.toHaveBeenCalled()
    f.animations[1].resolve();await Promise.resolve();expect(f.element.animate).toHaveBeenCalledTimes(2)
    motion.dispose()
  })

  it('does not extend an animation deadline for placement/content notifications with the same target',()=>{
    const f=elementFixture();let now=0;const motion=createWorkflowSizeMotion(f.element,{now:()=>now})
    f.setNatural({width:300,height:180});motion.resize();f.paint({width:240,height:120});now=60;motion.resize(true)
    expect(f.animations[1].timing.duration).toBe(100)
    f.paint({width:298,height:178});now=170;motion.resize(true)
    expect(f.animations[2].timing.duration).toBe(1)
    motion.dispose()
  })

  it('cancels hidden/removed surfaces and turns reduced-motion changes into immediate natural layout',async()=>{
    const f=elementFixture();let enabled=true;const motion=createWorkflowSizeMotion(f.element,{enabled:()=>enabled})
    f.setNatural({width:300,height:180});motion.resize();enabled=false;motion.resize()
    expect(f.animations[0].cancel).toHaveBeenCalledOnce()
    f.setNatural({width:400,height:200});motion.resize();expect(f.element.animate).toHaveBeenCalledOnce()
    enabled=true;f.setNatural({width:0,height:0});motion.resize();f.setNatural({width:200,height:100});motion.resize()
    expect(f.element.animate).toHaveBeenCalledOnce()
    f.setNatural({width:320,height:180});motion.resize();motion.dispose();f.animations[1].resolve();await Promise.resolve();motion.resize(true)
    expect(f.animations[1].cancel).toHaveBeenCalledOnce();expect(f.element.animate).toHaveBeenCalledTimes(2)
  })
})

function installerFixture(reduce=false,surfaceName='vdw-menu') {
  const surface=elementFixture(surfaceName),foreign=elementFixture('foreign-menu'),observers:{kind:string;callback:Function;observe:ReturnType<typeof vi.fn>;unobserve:ReturnType<typeof vi.fn>;disconnect:ReturnType<typeof vi.fn>}[]=[],frames=new Map<number,FrameRequestCallback>(),events=new Map<string,Function>()
  let frameId=0
  class Resize {kind='resize';observe=vi.fn();unobserve=vi.fn();disconnect=vi.fn();constructor(readonly callback:Function){observers.push(this)}}
  class Mutation {kind='mutation';observe=vi.fn();unobserve=vi.fn();disconnect=vi.fn();constructor(readonly callback:Function){observers.push(this)}}
  const query={matches:reduce,addEventListener:vi.fn((name:string,callback:Function)=>events.set(`media-${name}`,callback)),removeEventListener:vi.fn((name:string)=>events.delete(`media-${name}`))}
  const root={matches:()=>false,querySelectorAll:()=>[surface.element,foreign.element]}
  const view={ResizeObserver:Resize,MutationObserver:Mutation,matchMedia:()=>query,requestAnimationFrame:(callback:FrameRequestCallback)=>{frames.set(++frameId,callback);return frameId},cancelAnimationFrame:vi.fn((id:number)=>frames.delete(id)),addEventListener:vi.fn((name:string,callback:Function)=>events.set(name,callback)),removeEventListener:vi.fn((name:string)=>events.delete(name))}
  const document={defaultView:view,documentElement:root,querySelectorAll:()=>[],addEventListener:vi.fn(),removeEventListener:vi.fn()}
  return {surface,foreign,observers,frames,events,query,view,document:document as unknown as Document}
}

describe('plugin motion lifetime',()=>{
  it('retargets the workflow details panel when its canvas-height stack constraint changes',()=>{
    const f=installerFixture(false,'vdw-workflow-management'),stop=installWorkflowMotion(f.document)
    expect(f.observers[0]!.observe).toHaveBeenCalledWith(f.surface.element)
    const stack={nodeType:1,matches:()=>false,contains:(element:unknown)=>element===f.surface.element}
    const mutate=()=>f.observers.find(observer=>observer.kind==='mutation')!.callback([{type:'attributes',attributeName:'style',target:stack}])
    const flush=()=>{const scheduled=Array.from(f.frames.values());f.frames.clear();scheduled.forEach(callback=>callback(0))}
    f.surface.setNatural({width:320,height:308});mutate();flush()
    expect(f.surface.animations[0].frames.at(-1)).toEqual({width:'320px',height:'308px'})
    f.surface.paint({width:290,height:220});f.surface.setNatural({width:320,height:180});mutate();flush()
    expect(f.surface.animations[1].frames).toEqual([{width:'290px',height:'220px'},{width:'320px',height:'180px'}])
    expect(f.surface.animations[0].cancel).toHaveBeenCalledOnce();stop()
  })

  it('leaves other-plugin surfaces untouched and disconnects observers, frames and in-flight animations',()=>{
    const f=installerFixture(),stop=installWorkflowMotion(f.document)
    expect(f.observers[0]!.observe).toHaveBeenCalledExactlyOnceWith(f.surface.element)
    expect(f.foreign.element.animate).not.toHaveBeenCalled();expect(f.surface.element.animate).not.toHaveBeenCalled()
    f.surface.setNatural({width:350,height:190});f.observers[0]!.callback([{target:f.surface.element}])
    expect(f.surface.element.animate).toHaveBeenCalledOnce()
    f.events.get('resize')!();expect(f.frames.size).toBe(1)
    stop();expect(f.frames.size).toBe(0);expect(f.surface.animations[0].cancel).toHaveBeenCalledOnce()
    expect(f.observers.every(observer=>observer.disconnect.mock.calls.length===1)).toBe(true)
    expect(f.events.size).toBe(0);expect(f.view.cancelAnimationFrame).toHaveBeenCalledOnce()
  })

  it('does not observe or animate at reduced-motion startup and safely rebaselines when the preference changes',()=>{
    const f=installerFixture(true),stop=installWorkflowMotion(f.document)
    expect(f.observers).toHaveLength(0)
    f.query.matches=false;f.events.get('media-change')!();expect(f.observers).toHaveLength(3)
    f.surface.setNatural({width:300,height:180});f.observers[0]!.callback([{target:f.surface.element}])
    f.query.matches=true;f.events.get('media-change')!();expect(f.surface.animations[0].cancel).toHaveBeenCalledOnce()
    f.query.matches=false;f.events.get('media-change')!();expect(f.observers).toHaveLength(6);expect(f.surface.element.animate).toHaveBeenCalledOnce()
    stop();expect(f.events.size).toBe(0)
  })
})
