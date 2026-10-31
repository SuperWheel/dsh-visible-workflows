import { t, useLocale } from './i18n.ts'
import { useState, useEffect, useRef, useCallback, useId, type ReactNode } from 'react'
import { Button, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { Glyph } from './icons.tsx'
import { CodeEditor } from './code-editor.tsx'
/** Keep the portal inside the same 12px viewport margin used by the native Menu. */
export function selectMenuWidth(anchorWidth:number,viewportWidth:number){return Math.min(Math.max(0,anchorWidth),Math.max(0,viewportWidth-24))}
export function Select({label,value,options,onChange,disabled=false}:{label:string;value:string;options:{id:string;label:string}[];onChange:(value:string)=>void;disabled?:boolean}){
  const [open,setOpen]=useState(false)
  const trigger=useRef<HTMLButtonElement>(null),instanceClass=`vdw-select-instance-${useId().replace(/[^a-zA-Z0-9_-]/g,'')}`
  // This SDK has no matchAnchorWidth prop. Its native placement hook already tracks
  // scroll, resize and every animation frame; size only this owned portal before placement.
  const getAnchorRect=useCallback(()=>{
    const rect=trigger.current?.getBoundingClientRect()??null
    if(!rect)return null
    const list=document.querySelector<HTMLElement>(`.${instanceClass}`)
    if(list){const width=`${selectMenuWidth(rect.width,window.innerWidth)}px`;if(list.style.getPropertyValue('--vdw-select-trigger-width')!==width)list.style.setProperty('--vdw-select-trigger-width',width)}
    return rect
  },[instanceClass])
  const selected=options.find(o=>o.id===value)?.label||t('请选择')
  return <Menu open={open&&!disabled} onClose={()=>setOpen(false)} portal getAnchorRect={getAnchorRect} className="vdw-select" listClassName={`vdw-menu vdw-select-list ${instanceClass}`} selection="fill" selectedId={value} items={options} onSelect={id=>{if(disabled)return;setOpen(false);onChange(id)}} anchor={<Button ref={trigger} variant="outline" size="md" className="vdw-select-trigger" aria-label={label} aria-haspopup="menu" aria-expanded={open&&!disabled} title={selected} disabled={disabled} onClick={()=>setOpen(!open)}><span>{selected}</span><Glyph name="chevron-down"/></Button>}/>
}
/** Reuse the host's pinned, keyboard-accessible help bubble, including its portal positioning. */
export function HelpButton({label,text,children}:{label:string;text:string;children?:ReactNode}){
 useLocale();return <Tooltip label={text} portal side="bottom" maxWidth={300} openOnClick><button type="button" className="vdw-help-button" aria-label={t('{label}说明','About {label}',{label})}>{children||<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M8 7.5a2 2 0 114 0c0 1.4-2 1.5-2 3M10 13.3v.2" strokeLinecap="round"/></svg>}</button></Tooltip>
}
export function Field({label,help,helpVisible=false,children}:{label:string;help?:string;helpVisible?:boolean;children:ReactNode}){return <div className="vdw-field"><div className="vdw-field-label"><label>{label}</label>{help&&!helpVisible&&<HelpButton label={label} text={help}/>}</div>{children}{help&&helpVisible&&<small className="vdw-field-help">{help}</small>}</div>}

export function JsonEditor({label,value,onChange,disabled=false,help}:{label:string;value:unknown;onChange:(value:any)=>void;disabled?:boolean;help?:string}){
 const rendered=JSON.stringify(value??{},null,2),[draft,setDraft]=useState(rendered),[error,setError]=useState('')
 const committed=useRef(rendered)
 useEffect(()=>{if(committed.current===rendered)return;committed.current=rendered;setDraft(rendered);setError('')},[rendered])
 const edit=(next:string)=>{if(disabled)return;setDraft(next);let parsed:unknown;try{parsed=JSON.parse(next)}catch{setError('JSON 格式不完整，暂未保存。请检查引号、逗号和括号。');return}if(parsed===null||typeof parsed!=='object'){setError('请输入 JSON 对象或数组，暂未保存。');return}committed.current=JSON.stringify(parsed,null,2);setError('');onChange(parsed)}
 return <Field label={label} help={help}><CodeEditor label={label} language="json" value={draft} rows={6} disabled={disabled} onChange={edit} error={error}/></Field>
}
