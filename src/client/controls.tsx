import { useState, useEffect, type ReactNode } from 'react'
import { Button, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { Glyph } from './icons.tsx'
export function Select({label,value,options,onChange,disabled=false}:{label:string;value:string;options:{id:string;label:string}[];onChange:(value:string)=>void;disabled?:boolean}){
  const [open,setOpen]=useState(false)
  const selected=options.find(o=>o.id===value)?.label||'请选择'
  return <Menu open={open&&!disabled} onClose={()=>setOpen(false)} portal className="vdw-select" listClassName="vdw-menu vdw-select-list" selection="fill" selectedId={value} items={options} onSelect={id=>{setOpen(false);onChange(id)}} anchor={<Button variant="outline" size="md" className="vdw-select-trigger" aria-label={label} aria-haspopup="menu" aria-expanded={open&&!disabled} title={selected} disabled={disabled} onClick={()=>setOpen(!open)}><span>{selected}</span><Glyph name="chevron-down"/></Button>}/>
}
/** Reuse the host's pinned, keyboard-accessible help bubble, including its portal positioning. */
export function HelpButton({label,text,children}:{label:string;text:string;children?:ReactNode}){
 return <Tooltip label={text} portal side="bottom" maxWidth={300} openOnClick><button type="button" className="vdw-help-button" aria-label={`${label}说明`}>{children||<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M8 7.5a2 2 0 114 0c0 1.4-2 1.5-2 3M10 13.3v.2" strokeLinecap="round"/></svg>}</button></Tooltip>
}
export function Field({label,help,helpVisible=false,children}:{label:string;help?:string;helpVisible?:boolean;children:ReactNode}){return <div className="vdw-field"><div className="vdw-field-label"><label>{label}</label>{help&&!helpVisible&&<HelpButton label={label} text={help}/>}</div>{children}{help&&helpVisible&&<small className="vdw-field-help">{help}</small>}</div>}

export function JsonEditor({label,value,onChange,disabled=false,help}:{label:string;value:unknown;onChange:(value:any)=>void;disabled?:boolean;help?:string}){
 const rendered=JSON.stringify(value??{},null,2),[draft,setDraft]=useState(rendered),[error,setError]=useState('')
 useEffect(()=>{setDraft(rendered);setError('')},[rendered])
 return <Field label={label} help={help}><textarea className="vdw-code-editor" aria-label={label} rows={5} value={draft} disabled={disabled} onChange={e=>{setDraft(e.target.value);try{const parsed=JSON.parse(e.target.value);if(parsed===null||typeof parsed!=='object')throw new Error('请输入 JSON 对象或数组');setError('');onChange(parsed)}catch(err){setError(String(err))}}}/>{error&&<small className="vdw-error">JSON 格式不完整，暂未保存：{error}</small>}</Field>
}
