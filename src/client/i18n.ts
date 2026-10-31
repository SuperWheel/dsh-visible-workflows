import { useSyncExternalStore } from 'react'
import { englishMessages } from './i18n-messages.ts'

export type WorkflowLocale='zh-CN'|'en'
export const LOCALE_STORAGE_KEY='visible-workflows.locale.v1'
const listeners=new Set<()=>void>()
function readLocale():WorkflowLocale{try{return globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY)==='en'?'en':'zh-CN'}catch{return 'zh-CN'}}
let locale:WorkflowLocale=readLocale()
export const getLocale=()=>locale
export function subscribeLocale(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener)}}
export function setLocale(value:WorkflowLocale){
 if(value!=='zh-CN'&&value!=='en')throw new Error('Unsupported workflow language')
 try{globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY,value)}catch{/* An unavailable browser store must not prevent switching the current view. */}
 if(locale===value)return
 locale=value;listeners.forEach(listener=>listener())
}
/** Call only for interface copy. User titles, prompts, input values and tool names stay untouched. */
export function t(chinese:string,english?:string,values?:Record<string,string|number>):string{
 const message=locale==='en'?(english??englishMessages[chinese]??chinese):chinese
 return values?message.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g,(match,key)=>Object.hasOwn(values,key)?String(values[key]):match):message
}
export function useLocale(){const value=useSyncExternalStore(subscribeLocale,getLocale,getLocale);return {locale:value,setLocale,t}}
if(typeof window!=='undefined')window.addEventListener('storage',event=>{if(event.key===LOCALE_STORAGE_KEY||event.key===null){const next=readLocale();if(next!==locale){locale=next;listeners.forEach(listener=>listener())}}})
