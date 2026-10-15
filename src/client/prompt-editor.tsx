import { useEffect, useState } from 'react'
import { Button, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { HelpButton } from './controls.tsx'
import { Glyph } from './icons.tsx'

/** A view over the existing prompt value; expanded edits use the same controlled field. */
export function PromptEditor({label,role,value,onChange,readOnly=false,disabled=false,help,rows=6,placeholder}:{
 label:string;role:'SYSTEM'|'USER';value:string;onChange?:(value:string)=>void;readOnly?:boolean;disabled?:boolean;help?:string;rows?:number;placeholder?:string
}){
 const [expanded,setExpanded]=useState(false),[copyState,setCopyState]=useState<'idle'|'copied'|'error'>('idle')
 const locked=readOnly||!onChange
 useEffect(()=>{setCopyState('idle')},[value])
 const copy=async()=>{try{if(!navigator.clipboard?.writeText)throw new Error('clipboard unavailable');await navigator.clipboard.writeText(value);setCopyState('copied')}catch{setCopyState('error')}}
 const editor=(large=false)=><textarea className="vdw-prompt-body" aria-label={large?`${label}（展开）`:label} rows={large?18:rows} value={value} readOnly={locked} disabled={disabled} placeholder={placeholder} onChange={event=>{if(!locked&&!disabled)onChange?.(event.target.value)}} data-modal-autofocus={large||undefined}/>
 const status=copyState==='copied'?'已复制':copyState==='error'?'复制失败，请选择文字后复制。':''
 return <section className={`vdw-prompt-editor${locked?' vdw-prompt-readonly':''}`} aria-label={`${role} ${label}`}>
  <header className="vdw-prompt-header"><div className="vdw-prompt-heading"><strong>{role}</strong>{help&&<HelpButton label={label} text={help}/>}<span>{label}</span></div><div className="vdw-prompt-actions"><small className="vdw-prompt-count" aria-label={`${Array.from(value).length} 个字符`}>{Array.from(value).length} 字符</small><Tooltip label={`复制${label}`} portal side="bottom"><Button size="sm" className="vdw-icon-button" aria-label={`复制${label}`} onClick={()=>void copy()}><Glyph name="copy" size={14}/></Button></Tooltip><Tooltip label={locked?`展开查看${label}`:`展开编辑${label}`} portal side="bottom"><Button size="sm" className="vdw-icon-button" aria-label={`展开${label}`} onClick={()=>setExpanded(true)}><Glyph name="expand" size={14}/></Button></Tooltip></div></header>
  {editor()}
  {status&&<small className={`vdw-prompt-status${copyState==='error'?' vdw-error':''}`} role="status">{status}</small>}
  {expanded&&<Modal open title={`${role} · ${label}`} closeLabel={`关闭展开${label}`} className="vdw-modal vdw-prompt-modal" onClose={()=>setExpanded(false)} footer={<><small className="vdw-muted">{locked?'角色提示词仅在设置中修改。':disabled?'运行中暂不可修改。':'修改会同步保存到节点。'}</small><Button onClick={()=>setExpanded(false)}>完成</Button></>}>
   {editor(true)}
  </Modal>}
 </section>
}
