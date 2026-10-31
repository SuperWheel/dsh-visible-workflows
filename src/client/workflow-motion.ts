export const WORKFLOW_MOTION_DURATION=160
const easing='cubic-bezier(.2,.7,.2,1)'
type Size={width:number;height:number}
const sizeOf=(element:HTMLElement):Size=>{const {width,height}=element.getBoundingClientRect();return {width,height}}
const sameSize=(a:Size,b:Size)=>Math.abs(a.width-b.width)<.75&&Math.abs(a.height-b.height)<.75
const visible=(size:Size)=>size.width>0&&size.height>0

/** Animate the box, never scale its text. Only forced content/viewport changes
 * retarget a running animation; its own RO notifications must be ignored. */
export function createWorkflowSizeMotion(element:HTMLElement,options:{now?:()=>number;enabled?:()=>boolean}={}) {
  const now=options.now??(()=>performance.now()),enabled=options.enabled??(()=>true)
  let previous=sizeOf(element),animation:Animation|undefined,deadline=0,disposed=false
  const cancel=()=>{const current=animation;animation=undefined;current?.cancel()}
  const resize=(force=false)=>{
    if(disposed)return
    if(!enabled()||typeof element.animate!=='function'){cancel();previous=sizeOf(element);return}
    if(animation&&!force)return
    const current=animation?sizeOf(element):previous,oldTarget=previous,oldDeadline=deadline
    cancel()
    const target=sizeOf(element);previous=target
    if(!visible(current)||!visible(target)||sameSize(current,target))return
    const duration=force&&sameSize(target,oldTarget)&&oldDeadline?Math.max(1,oldDeadline-now()):WORKFLOW_MOTION_DURATION
    deadline=now()+duration
    const next=element.animate([{width:`${current.width}px`,height:`${current.height}px`},{width:`${target.width}px`,height:`${target.height}px`}],{duration,easing,fill:'both'})
    animation=next
    void next.finished.then(()=>{if(disposed||animation!==next)return;animation=undefined;next.cancel();resize()}).catch(()=>{/* Cancelled/removed surfaces have no delayed work. */})
  }
  return {resize,dispose:()=>{disposed=true;cancel()}}
}

// Fill-height inspectors enter with CSS but do not auto-size from their contents.
// Animating their flex height would fight the adjacent readiness surface.
const surfaces='.vdw-node-picker,.vdw-readiness-panel,.vdw-subagent-options,.vdw-workflow-management,.vdw-modal,.vdw-menu'
const buttons='.vdw .vdw-home-actions button:has(.vdw-home-action-label),.vdw .vdw-canvas-top-actions button:has(.vdw-control-label)'
export const WORKFLOW_MOTION_TARGETS=`${surfaces},${buttons}`
const owned=(element:Element)=>element.matches('.vdw-modal,.vdw-menu')||!!element.closest('.vdw')

/** One controller per plugin lifetime; removed portals and all pending frames
 * are released on close, reduced-motion changes and plugin cleanup. */
export function installWorkflowMotion(document:Document=globalThis.document):()=>void {
  const view=document.defaultView
  if(!view||typeof view.ResizeObserver!=='function'||typeof view.MutationObserver!=='function')return()=>{}
  const reduced=view.matchMedia?.('(prefers-reduced-motion: reduce)')
  let release:(()=>void)|undefined,disposed=false
  const start=()=>{
    if(disposed||reduced?.matches||release)return
    const tracked=new Map<HTMLElement,ReturnType<typeof createWorkflowSizeMotion>>(),pending=new Set<HTMLElement>(),roots=new Set<Element>()
    let frame=0,stopped=false
    const collect=(root:Element)=>{const values:HTMLElement[]=[];if(root.matches(WORKFLOW_MOTION_TARGETS))values.push(root as HTMLElement);values.push(...root.querySelectorAll<HTMLElement>(WORKFLOW_MOTION_TARGETS));return values.filter(owned)}
    const flush=()=>{frame=0;if(stopped)return;for(const element of pending){tracked.get(element)?.resize(true)}pending.clear()}
    const schedule=(element:HTMLElement)=>{pending.add(element);if(!frame)frame=view.requestAnimationFrame(flush)}
    const sizes=new view.ResizeObserver(entries=>{for(const entry of entries)tracked.get(entry.target as HTMLElement)?.resize()})
    const viewport=new view.ResizeObserver(()=>{for(const element of tracked.keys())schedule(element)})
    viewport.observe(document.documentElement)
    const register=(element:HTMLElement)=>{if(tracked.has(element)||typeof element.animate!=='function')return;tracked.set(element,createWorkflowSizeMotion(element));sizes.observe(element)}
    const scan=()=>{
      for(const [element,motion] of tracked)if(!element.isConnected||!element.matches(WORKFLOW_MOTION_TARGETS)||!owned(element)){motion.dispose();sizes.unobserve(element);tracked.delete(element);pending.delete(element)}
      for(const element of collect(document.documentElement))register(element)
      for(const root of roots)if(!root.isConnected){viewport.unobserve(root);roots.delete(root)}
      for(const root of document.querySelectorAll('.vdw'))if(!roots.has(root)){roots.add(root);viewport.observe(root)}
    }
    scan()
    const mutations=new view.MutationObserver(records=>{
      // Discovery establishes a baseline, so newly mounted controls/cards never
      // animate from an unrelated page's geometry.
      if(records.some(record=>record.type==='childList'||record.type==='attributes'&&record.attributeName==='class'))scan()
      for(const record of records){
        const target=record.target.nodeType===1?record.target as Element:record.target.parentElement
        if(!target)continue
        if(record.type==='attributes'&&record.attributeName==='style'&&target.matches('.vdw-canvas-wrap,.vdw-editor-body,.vdw-canvas,.vdw-world'))continue
        for(const [element] of tracked){
          // Native portal placement updates its own inline style every frame.
          // That is positioning, not a new natural box size.
          if(record.type==='attributes'&&record.attributeName==='style'&&target===element)continue
          if(element.contains(target)||target.contains(element))schedule(element)
        }
      }
    })
    mutations.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','hidden','open','aria-selected','aria-expanded','style']})
    const resized=()=>{for(const element of tracked.keys())schedule(element)}
    const loaded=(event:Event)=>{const target=event.target;if(target instanceof view.Element)for(const element of tracked.keys())if(element.contains(target))schedule(element)}
    view.addEventListener('resize',resized);document.addEventListener('load',loaded,true)
    release=()=>{stopped=true;mutations.disconnect();sizes.disconnect();viewport.disconnect();if(frame)view.cancelAnimationFrame(frame);pending.clear();roots.clear();for(const motion of tracked.values())motion.dispose();tracked.clear();view.removeEventListener('resize',resized);document.removeEventListener('load',loaded,true)}
  }
  const changed=()=>{release?.();release=undefined;start()}
  reduced?.addEventListener('change',changed);start()
  return()=>{disposed=true;reduced?.removeEventListener('change',changed);release?.();release=undefined}
}
