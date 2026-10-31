import { useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocale } from './i18n.ts'

/** Fit the remark into an unused area inside the details panel. */
export function WorkflowManagementHelp({text}:{text:string}){
  const {t}=useLocale(),id=useId(),anchor=useRef<HTMLButtonElement>(null),bubble=useRef<HTMLDivElement>(null)
  const [hover,setHover]=useState(false),[focused,setFocused]=useState(false),[position,setPosition]=useState<{left:number;top:number;width:number}>()
  const open=hover||focused
  useLayoutEffect(()=>{
    if(!open)return
    const button=anchor.current,tooltip=bubble.current,panel=button?.closest('.vdw-workflow-management')
    if(!button||!tooltip||!panel)return
    const place=()=>{
      const surface=panel.getBoundingClientRect(),target=button.getBoundingClientRect(),margin=12,gap=8
      const width=Math.min(240,surface.width-margin*2)
      tooltip.style.maxWidth=`${width}px`
      const size=tooltip.getBoundingClientRect()
      const minX=Math.max(margin,surface.left+margin),maxX=Math.min(window.innerWidth-margin,surface.right-margin)-size.width
      const minY=Math.max(margin,surface.top+margin),maxY=Math.min(window.innerHeight-margin,surface.bottom-margin)-size.height
      const occupied=[...panel.querySelectorAll('input,textarea,button,label,code,strong,dt,dd,.vdw-workflow-management-heading small')].map(element=>element.getBoundingClientRect()).filter(rect=>rect.width>0&&rect.height>0)
      const xs=[target.right+gap,target.left-size.width-gap,target.right-size.width,minX,maxX,...occupied.flatMap(rect=>[rect.right+gap,rect.left-size.width-gap])]
      const ys=[target.top+(target.height-size.height)/2,target.top-gap-size.height,target.bottom+gap,minY,maxY,...occupied.flatMap(rect=>[rect.bottom+gap,rect.top-size.height-gap])]
      const candidates=xs.flatMap(x=>ys.map(y=>({x:Math.max(minX,Math.min(x,maxX)),y:Math.max(minY,Math.min(y,maxY))})))
      const scored=candidates.map(candidate=>{
        const overlap=occupied.reduce((sum,rect)=>sum+Math.max(0,Math.min(candidate.x+size.width,rect.right)-Math.max(candidate.x,rect.left))*Math.max(0,Math.min(candidate.y+size.height,rect.bottom)-Math.max(candidate.y,rect.top)),0)
        const distance=Math.hypot(candidate.x+size.width/2-(target.left+target.width/2),candidate.y+size.height/2-(target.top+target.height/2))
        return {...candidate,score:overlap*10000+distance}
      }).sort((a,b)=>a.score-b.score)
      const {x,y}=scored[0]!
      setPosition(previous=>previous?.left===x&&previous.top===y&&previous.width===width?previous:{left:x,top:y,width})
    }
    place()
    const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(place)
    observer?.observe(panel);observer?.observe(tooltip)
    window.addEventListener('resize',place);window.addEventListener('scroll',place,true)
    return()=>{observer?.disconnect();window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true)}
  },[open,text])
  return <><button ref={anchor} type="button" className="vdw-help-button vdw-management-scope-help" aria-label={t('使用范围说明','About availability')} aria-describedby={open?id:undefined} onMouseEnter={()=>setHover(true)} onMouseLeave={()=>{setHover(false);if(!focused)setPosition(undefined)}} onFocus={()=>setFocused(true)} onBlur={()=>{setFocused(false);if(!hover)setPosition(undefined)}} onKeyDown={event=>{if(event.key==='Escape'){setHover(false);setFocused(false);setPosition(undefined)}}}><svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M8 7.5a2 2 0 114 0c0 1.4-2 1.5-2 3M10 13.3v.2" strokeLinecap="round"/></svg></button>{open&&typeof document!=='undefined'&&createPortal(<div ref={bubble} id={id} role="tooltip" className="vdw-management-help-bubble" style={{left:position?.left,top:position?.top,maxWidth:position?.width??240,visibility:position?'visible':'hidden'}}>{text}</div>,document.body)}</>
}
