import { displayNodeNumber } from './annotation-nodes.ts'
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasNote, WorkflowNode } from '../shared/types.ts'
import { Glyph } from './icons.tsx'
import { NOTE_COLORS, noteColor, noteSize, noteTone } from './notes.ts'
import { parseNoteContent, type NoteInline } from './note-content.ts'

// ':' is excluded by node-ID validation, so the detach action cannot collide with a real node.
const DETACH_ID=':detach:'

/** A small, safe note formatter. Stored text is unchanged and HTML is always escaped by React. */
function noteInline(parts:readonly NoteInline[]):ReactNode[]{
  return parts.map((part,index)=>part.kind==='strong'?<strong key={index}>{part.text}</strong>:part.kind==='code'?<code key={index}>{part.text}</code>:part.text)
}
function NoteContent({text}:{text:string}){
  return <>{parseNoteContent(text).map((block,index)=>block.kind==='heading'?<h3 key={index}>{noteInline(block.content)}</h3>:block.kind==='paragraph'?<p key={index}>{noteInline(block.content)}</p>:block.ordered?<ol key={index} start={block.start}>{block.items.map((item,itemIndex)=><li key={itemIndex}>{noteInline(item)}</li>)}</ol>:<ul key={index}>{block.items.map((item,itemIndex)=><li key={itemIndex}>{noteInline(item)}</li>)}</ul>)}</>
}

export interface StickyNoteProps {
  note:CanvasNote
  nodes:WorkflowNode[]
  disabled?:boolean
  selected:boolean
  editing?:boolean
  onSelect:()=>void
  onChange:(next:CanvasNote)=>void
  onDelete:()=>void
  onDragStart:(event:PointerEvent<HTMLElement>)=>void
  onResizeStart:(event:PointerEvent<HTMLElement>)=>void
  onEditingChange?:(editing:boolean)=>void
}
/** Persistent canvas explanation; it is separate from temporary Agent chat annotations. */
export function StickyNote(p:StickyNoteProps){
  const [localEditing,setLocalEditing]=useState(false),[draft,setDraft]=useState(p.note.text),[menu,setMenu]=useState<'color'|'anchor'>(),textarea=useRef<HTMLTextAreaElement>(null),finishing=useRef(false)
  const [resizePreview,setResizePreview]=useState<{width:number;height:number}>(),pendingResize=useRef<{width:number;height:number}>()
  const editing=p.editing??localEditing,size=noteSize(resizePreview??p.note),color=noteColor(p.note),anchor=p.nodes.find(node=>node.id===p.note.anchorNodeId)
  const previousEditing=useRef(editing)
  const setEditing=(value:boolean)=>{setLocalEditing(value);p.onEditingChange?.(value)}
  useEffect(()=>{
    const wasEditing=previousEditing.current;previousEditing.current=editing
    // A parent can switch editors without a DOM blur (e.g. start dragging another note).
    // Finalize only this mounted note, never in cleanup where deletion must stay deleted.
    if(wasEditing&&!editing&&!finishing.current){
      finishing.current=true
      if(!p.disabled&&draft!==p.note.text)p.onChange({...p.note,text:draft})
    }
  },[editing])
  useEffect(()=>{
    if(!editing)return
    finishing.current=false;setDraft(p.note.text)
    const field=textarea.current;field?.focus();if(field)field.setSelectionRange(field.value.length,field.value.length)
  },[editing,p.note.id])
  useEffect(()=>{if(!editing)setDraft(p.note.text)},[p.note.text,editing])
  useEffect(()=>{if(p.disabled){setLocalEditing(false);if(editing)p.onEditingChange?.(false);setMenu(undefined);pendingResize.current=undefined;setResizePreview(undefined)}},[p.disabled])
  const beginEdit=()=>{if(p.disabled)return;p.onSelect();setDraft(p.note.text);finishing.current=false;setEditing(true)}
  const finish=(save:boolean)=>{
    if(!editing||finishing.current)return
    finishing.current=true
    if(save&&!p.disabled&&draft!==p.note.text)p.onChange({...p.note,text:draft})
    setEditing(false)
  }
  const finishResize=()=>{const pending=pendingResize.current;if(!pending)return;pendingResize.current=undefined;setResizePreview(undefined);const original=noteSize(p.note);if(!p.disabled&&(pending.width!==original.width||pending.height!==original.height))p.onChange({...p.note,...pending})}
  const toolbar=<div className="vdw-canvas-note-tools" role="toolbar" aria-label="便签操作" onPointerDown={event=>event.stopPropagation()}>
    {anchor&&<span className="vdw-note-anchor-label" title={`已连接 ${displayNodeNumber(anchor.number)} ${anchor.title}`}>{displayNodeNumber(anchor.number)}</span>}
    <Button size="sm" variant="ghost" className="vdw-note-tool" aria-label="编辑便签" title="编辑便签 · 双击正文也可编辑" disabled={p.disabled||editing} onClick={beginEdit}><Glyph name="note"/></Button>
    <Menu open={menu==='color'&&!p.disabled} portal onClose={()=>setMenu(undefined)} listClassName="vdw-menu vdw-note-menu" selectedId={color} selection="fill"
      items={NOTE_COLORS.map(item=>({id:item.id,label:item.label,icon:<span className="vdw-note-swatch" style={{background:noteTone({color:item.id})}}/>}))}
      onSelect={id=>{setMenu(undefined);if(!p.disabled&&id!==color)p.onChange({...p.note,color:id as CanvasNote['color']})}}
      anchor={<Button size="sm" variant="ghost" className="vdw-note-tool" aria-label={`便签颜色：${NOTE_COLORS.find(item=>item.id===color)!.label}`} title="便签颜色" aria-haspopup="menu" aria-expanded={menu==='color'} disabled={p.disabled} onClick={()=>setMenu(menu==='color'?undefined:'color')}><span className="vdw-note-swatch" style={{background:noteTone(p.note)}}/></Button>}/>
    <Menu open={menu==='anchor'&&!p.disabled} portal onClose={()=>setMenu(undefined)} listClassName="vdw-menu vdw-note-menu vdw-note-anchor-menu" selectedId={p.note.anchorNodeId||DETACH_ID} selection="fill"
      items={[{id:DETACH_ID,label:'不连接节点',icon:<Glyph name="close"/>},...p.nodes.map(node=>({id:node.id,label:`${displayNodeNumber(node.number)} · ${node.title}`,icon:<Glyph name="link"/>}))]}
      onSelect={id=>{setMenu(undefined);if(p.disabled||id===(p.note.anchorNodeId||DETACH_ID))return;const {anchorNodeId:_,...note}=p.note;p.onChange(id===DETACH_ID?note:{...note,anchorNodeId:id})}}
      anchor={<Button size="sm" variant="ghost" className={`vdw-note-tool ${anchor?'is-linked':''}`} aria-label={anchor?`便签已连接 ${displayNodeNumber(anchor.number)} ${anchor.title}`:'连接便签到节点'} title={anchor?`已连接 ${displayNodeNumber(anchor.number)} ${anchor.title}`:'连接节点'} aria-haspopup="menu" aria-expanded={menu==='anchor'} disabled={p.disabled} onClick={()=>setMenu(menu==='anchor'?undefined:'anchor')}><Glyph name="link"/></Button>}/>
    <Button size="sm" variant="ghost" className="vdw-note-tool" aria-label="删除便签" title="删除便签" disabled={p.disabled} onClick={()=>{if(!p.disabled)p.onDelete()}}><Glyph name="trash"/></Button>
  </div>
  return <section className={`vdw-canvas-note ${p.selected?'is-selected':''} ${editing?'is-editing':''}`} data-color={color} data-note-id={p.note.id} data-disabled={p.disabled||undefined}
    style={{left:p.note.x,top:p.note.y,width:size.width,height:size.height,'--vdw-note-tone':noteTone(p.note)} as CSSProperties}
    role="group" aria-label={anchor?`画布便签，连接 ${displayNodeNumber(anchor.number)} ${anchor.title}`:'画布便签'} tabIndex={0}
    onPointerDown={event=>{event.stopPropagation();p.onSelect()}} onFocus={p.onSelect}
    onKeyDown={event=>{if(event.target===event.currentTarget&&(event.key==='Enter'||event.key==='F2')){event.preventDefault();event.stopPropagation();beginEdit()}}}>
    <div className="vdw-canvas-note-header" title="拖动便签" aria-hidden="true" onPointerDown={event=>{if(event.button!==0||p.disabled||editing)return;event.preventDefault();p.onSelect();p.onDragStart(event)}}/>
    {toolbar}
    {editing&&!p.disabled?<textarea ref={textarea} className="vdw-canvas-note-editor" aria-label="便签内容" value={draft} maxLength={20000} placeholder="写下流程说明…" aria-description="支持 # 标题、**重点**、列表和行内代码。按 Escape 取消，Command 或 Control 加 Enter 保存。"
      onChange={event=>setDraft(event.target.value)} onBlur={()=>finish(true)} onPointerDown={event=>event.stopPropagation()}
      onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();finish(false)}else if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)&&!event.nativeEvent.isComposing){event.preventDefault();finish(true)}}}/>
      :<div className={`vdw-canvas-note-body ${p.note.text?'':'is-empty'}`} title="双击编辑说明，支持标题、粗体和列表" onDoubleClick={event=>{event.stopPropagation();beginEdit()}}>{p.note.text?<NoteContent text={p.note.text}/>:<p>双击添加说明</p>}</div>}
    {p.selected&&!p.disabled&&!editing&&<button type="button" className="vdw-canvas-note-resize" aria-label="调整便签大小，方向键可微调" title="拖动调整便签大小" onPointerDown={event=>{event.preventDefault();event.stopPropagation();p.onSelect();p.onResizeStart(event)}}
      onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();event.stopPropagation();const step=event.shiftKey?10:1,base=pendingResize.current??size,next=noteSize({width:base.width+(event.key==='ArrowRight'?step:event.key==='ArrowLeft'?-step:0),height:base.height+(event.key==='ArrowDown'?step:event.key==='ArrowUp'?-step:0)});pendingResize.current=next;setResizePreview(next)}}
      onKeyUp={event=>{if(event.key.startsWith('Arrow')){event.stopPropagation();finishResize()}}} onBlur={finishResize}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 10l6-6M8 10l2-2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></button>}
  </section>
}

export const stickyNoteStyles=String.raw`
.vdw-canvas-note{--vdw-note-paper:#ffe975;position:absolute;box-sizing:border-box;display:flex;flex-direction:column;border:1px solid color-mix(in srgb,var(--vdw-note-paper) 24%,var(--dsw-alias-border-l3));border-radius:8px;background:color-mix(in srgb,var(--vdw-note-paper) 14%,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font:14px/23px var(--dsw-font-family);box-shadow:0 1px 3px color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);outline:none;overflow:visible;transition:border-color 120ms,box-shadow 120ms}
.vdw-canvas-note[data-color=blue]{--vdw-note-paper:#8fd0ff}.vdw-canvas-note[data-color=purple]{--vdw-note-paper:#b9a0ff}.vdw-canvas-note[data-color=green]{--vdw-note-paper:#a3d9b0}.vdw-canvas-note[data-color=neutral]{--vdw-note-paper:#b6bbc7}
.vdw-canvas-note::before{content:"";position:absolute;inset:0 0 auto;height:6px;border-radius:7px 7px 0 0;background:color-mix(in srgb,var(--vdw-note-paper) 23%,var(--dsw-alias-bg-base));pointer-events:none}
.vdw-canvas-note:hover{border-color:color-mix(in srgb,var(--vdw-note-tone) 45%,var(--dsw-alias-border-l3))}
.vdw-canvas-note.is-selected{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}
.vdw-canvas-note:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.vdw-canvas-note-header{position:absolute;inset:0 0 auto;height:18px;z-index:1;cursor:grab;user-select:none}
.vdw-canvas-note-header:active{cursor:grabbing}.vdw-canvas-note.is-editing .vdw-canvas-note-header,.vdw-canvas-note[data-disabled=true] .vdw-canvas-note-header{cursor:default;pointer-events:none}
.vdw-canvas-note-tools{position:absolute;right:0;bottom:calc(100% + 6px);display:flex;align-items:center;gap:2px;padding:3px;border:1px solid var(--dsw-alias-border-l3);border-radius:9px;background:var(--dsw-alias-bg-base);box-shadow:0 3px 10px color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);opacity:0;pointer-events:none;transition:opacity 120ms;z-index:3}
.vdw-canvas-note-tools::after{content:"";position:absolute;left:0;right:0;top:100%;height:7px}
.vdw-canvas-note:hover .vdw-canvas-note-tools,.vdw-canvas-note.is-selected .vdw-canvas-note-tools,.vdw-canvas-note:focus-within .vdw-canvas-note-tools{opacity:1;pointer-events:auto}
.vdw-note-anchor-label{max-width:72px;padding:0 5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.vdw-canvas-note .vdw-note-tool{width:28px;min-width:28px;height:28px;min-height:28px;padding:0;border-radius:6px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary));display:inline-flex;align-items:center;justify-content:center}
.vdw-canvas-note .vdw-note-tool:hover{background:var(--dsw-alias-bg-secondary,color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent))}.vdw-canvas-note .vdw-note-tool.is-linked{color:var(--dsw-alias-state-business-primary)}
.vdw-note-swatch{display:inline-block;width:12px;height:12px;border-radius:50%;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);box-sizing:border-box;flex-shrink:0}
.vdw-note-menu{font-family:var(--dsw-font-family);font-size:13px;line-height:20px;min-width:160px}.vdw-note-anchor-menu{min-width:240px;max-width:320px;max-height:320px;overflow:auto}
.vdw-canvas-note-body,.vdw-canvas-note-editor{flex:1;min-height:0;box-sizing:border-box;margin:0;padding:22px 16px 16px;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;font:14px/23px var(--dsw-font-family);color:inherit;user-select:text;border-radius:inherit}
.vdw-canvas-note-body>:first-child{margin-top:0}.vdw-canvas-note-body>:last-child{margin-bottom:0}.vdw-canvas-note-body p{margin:0 0 14px}.vdw-canvas-note-body h3{margin:16px 0 12px;font:600 15px/23px var(--dsw-font-family);color:inherit}.vdw-canvas-note-body strong{font-weight:600}.vdw-canvas-note-body ul,.vdw-canvas-note-body ol{margin:0 0 14px;padding-left:20px;white-space:normal}.vdw-canvas-note-body li{margin:2px 0}.vdw-canvas-note-body code{padding:1px 4px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);font-size:12px;line-height:20px}
.vdw-canvas-note-body.is-empty{color:var(--dsw-alias-label-tertiary)}
.vdw-canvas-note textarea.vdw-canvas-note-editor{width:100%;min-height:0;resize:none;border:0!important;border-radius:inherit;background:transparent!important;outline:none!important;box-shadow:none!important;padding:22px 16px 16px}
.vdw-canvas-note.is-editing{box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent)}
.vdw-canvas-note-resize{position:absolute;right:0;bottom:0;display:flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:nwse-resize;border-radius:6px}
.vdw-canvas-note-resize:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}.vdw-canvas-note-resize:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
@media(prefers-reduced-motion:reduce){.vdw-canvas-note,.vdw-canvas-note-tools{transition:none}}
`
