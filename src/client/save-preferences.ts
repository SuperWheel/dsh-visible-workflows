import { useSyncExternalStore } from 'react'

export interface SavePreferences { mode:'manual'|'auto'; intervalMinutes:number }
const KEY='visible-workflows.save-preferences.v1'
const defaults:SavePreferences={mode:'auto',intervalMinutes:5}
const listeners=new Set<()=>void>()
function read():SavePreferences {
  try { const value=JSON.parse(globalThis.localStorage?.getItem(KEY)??'null');return value&&['manual','auto'].includes(value.mode)&&Number.isInteger(value.intervalMinutes)&&value.intervalMinutes>=1&&value.intervalMinutes<=1440?value:{...defaults} } catch { return {...defaults} }
}
let current=read()
export const getSavePreferences=()=>current
export function subscribeSavePreferences(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener)}}
export function setSavePreferences(value:SavePreferences){
  if(!['manual','auto'].includes(value.mode)||!Number.isInteger(value.intervalMinutes)||value.intervalMinutes<1||value.intervalMinutes>1440)throw new Error('自动保存间隔请输入 1–1440 分钟的整数')
  globalThis.localStorage?.setItem(KEY,JSON.stringify(value))
  current={...value};listeners.forEach(listener=>listener())
}
if(typeof window!=='undefined')window.addEventListener('storage',event=>{if(event.key===KEY){current=read();listeners.forEach(listener=>listener())}})
export function useSavePreferences(){return useSyncExternalStore(subscribeSavePreferences,getSavePreferences,getSavePreferences)}
