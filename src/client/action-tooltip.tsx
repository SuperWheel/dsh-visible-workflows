import { cloneElement, useLayoutEffect, useRef, useState, type ComponentProps } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { tooltipSide } from './tooltip-placement.ts'

/** Keep the native tooltip's focus, dismissal and viewport fitting behavior. */
export function ActionTooltip({children,side='bottom',maxWidth=300,...props}:ComponentProps<typeof Tooltip>){
  const anchor=useRef<HTMLElement|null>(null),[placement,setPlacement]=useState<'top'|'bottom'>(side==='top'?'top':'bottom')
  useLayoutEffect(()=>{
    const element=anchor.current;if(!element||typeof window==='undefined')return
    const measure=()=>{
      const label=typeof props.label==='function'?props.label():props.label,rect=element.getBoundingClientRect(),canvas=document.createElement('canvas'),context=canvas.getContext('2d')
      if(context)context.font=`13px ${getComputedStyle(element).fontFamily}`
      const lines=label.split('\n'),lineWidths=lines.map(line=>context?.measureText(line).width??Array.from(line).length*13),width=Math.min(maxWidth,Math.max(40,...lineWidths)+14),height=6+20*lineWidths.reduce((sum,line)=>sum+Math.max(1,Math.ceil(line/Math.max(1,width-14))),0)
      const obstacles=Array.from(document.querySelectorAll<HTMLElement>('button,[role=button],[role=tab],input,[role=combobox]')).filter(item=>item!==element&&!element.contains(item)&&!item.contains(element)&&!item.closest('.vdw-world')&&getComputedStyle(item).visibility!=='hidden'&&item.getClientRects().length).map(item=>item.getBoundingClientRect())
      setPlacement(tooltipSide(rect,{width,height},{width:window.innerWidth,height:window.innerHeight},obstacles,side==='top'?'top':'bottom'))
    }
    measure();const observer=new ResizeObserver(measure);observer.observe(element);if(element.parentElement)observer.observe(element.parentElement)
    window.addEventListener('resize',measure);window.addEventListener('scroll',measure,true)
    return()=>{observer.disconnect();window.removeEventListener('resize',measure);window.removeEventListener('scroll',measure,true)}
  },[props.label,maxWidth,side])
  const original=(children as typeof children&{ref?:((element:HTMLElement|null)=>void)|{current:HTMLElement|null}}).ref
  return <Tooltip {...props} side={placement} maxWidth={maxWidth}>{cloneElement(children,{ref:(element:HTMLElement|null)=>{anchor.current=element;if(typeof original==='function')original(element);else if(original)original.current=element}})}</Tooltip>
}
