import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react'

/** Accumulate high-frequency input immediately, but commit React work once per frame. */
export function useFrameState<T>(initial:T) {
  const [value,commit]=useState(initial),latest=useRef(value),frame=useRef<number>()
  const set=useCallback((next:SetStateAction<T>)=>{
    latest.current=typeof next==='function'?(next as (previous:T)=>T)(latest.current):next
    if(frame.current!==undefined)return
    frame.current=requestAnimationFrame(()=>{frame.current=undefined;commit(latest.current)})
  },[])
  useEffect(()=>()=>{if(frame.current!==undefined)cancelAnimationFrame(frame.current)},[])
  return [value,set,latest] as const
}
