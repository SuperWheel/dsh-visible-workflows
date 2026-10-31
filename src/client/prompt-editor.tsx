import { t, useLocale } from './i18n.ts'
import { useEffect, useState } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { CollapseEditorIcon } from './code-editor.tsx'
import { HelpButton } from './controls.tsx'
import { ExpandedEditorShell } from './expanded-editor.tsx'
import { Glyph } from './icons.tsx'

/** A view over the existing prompt value; expanded edits use the same controlled field. */
export function PromptEditor({label,role,value,onChange,readOnly=false,disabled=false,help,rows=6,placeholder,maxLength}:{
 label:string;role?:'SYSTEM'|'USER';value:string;onChange?:(value:string)=>void;readOnly?:boolean;disabled?:boolean;help?:string;rows?:number;placeholder?:string;maxLength?:number
}){useLocale();
 const [expanded,setExpanded]=useState(false),[copyState,setCopyState]=useState<'idle'|'copied'|'error'>('idle')
 const locked=readOnly||!onChange
 useEffect(()=>{setCopyState('idle')},[value])
 const copy=async()=>{try{if(!navigator.clipboard?.writeText)throw new Error('clipboard unavailable');await navigator.clipboard.writeText(value);setCopyState('copied')}catch{setCopyState('error')}}
 const editor=(large=false)=><textarea className="vdw-prompt-body" style={{resize:'none'}} aria-label={large?t('{label}（展开）','{label} (expanded)',{label}):label} rows={large?18:rows} maxLength={maxLength} value={value} readOnly={locked} disabled={disabled} placeholder={placeholder} onChange={event=>{if(!locked&&!disabled&&(maxLength===undefined||event.target.value.length<=maxLength))onChange?.(event.target.value)}} data-modal-autofocus={large||undefined}/>
 const status=copyState==='copied'?t('已复制'):copyState==='error'?t('复制失败，请选择文字后复制。'):''
 const toolbar=(large=false)=><header className="vdw-prompt-header"><div className="vdw-prompt-heading"><strong>{role??label}</strong>{help&&<HelpButton label={label} text={help}/>}{role&&<span>{label}</span>}</div><div className="vdw-prompt-actions"><small className="vdw-prompt-count" aria-label={t('{count} 个字符','{count} characters',{count:Array.from(value).length})}>{Array.from(value).length} {t("字符")}</small><Tooltip label={t('复制{label}','Copy {label}',{label})} portal side="bottom"><Button size="sm" className="vdw-icon-button" aria-label={t('复制{label}{suffix}','Copy {label}{suffix}',{label,suffix:large?t('（展开）',' (expanded)'):''})} onClick={()=>void copy()}><Glyph name="copy" size={14}/></Button></Tooltip><Tooltip label={large?t("收起编辑器"):locked?t('展开查看{label}','Expand {label}',{label}):t('展开编辑{label}','Expand {label}',{label})} portal side="bottom"><Button size="sm" className="vdw-icon-button" aria-label={large?t('关闭展开{label}','Close expanded {label}',{label}):t('展开{label}','Expand {label}',{label})} onClick={()=>setExpanded(!large)}>{large?<CollapseEditorIcon/>:<Glyph name="expand" size={14}/>}</Button></Tooltip></div></header>
 const feedback=()=>status&&<small className={`vdw-prompt-status${copyState==='error'?' vdw-error':''}`} role="status">{status}</small>
 return <section className={`vdw-prompt-editor${locked?' vdw-prompt-readonly':''}`} aria-label={role?`${role} ${label}`:label}>
  {toolbar()}{editor()}{!expanded&&feedback()}
  {expanded&&<ExpandedEditorShell label={role?`${role} · ${label}`:label} onClose={()=>setExpanded(false)}><section className={`vdw-prompt-editor vdw-prompt-expanded${locked?' vdw-prompt-readonly':''}`} aria-label={t('{label}（展开）','{label} (expanded)',{label:role?`${role} ${label}`:label})}>{toolbar(true)}{editor(true)}{feedback()}</section></ExpandedEditorShell>}
 </section>
}
