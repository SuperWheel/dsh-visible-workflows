import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Input, Menu, Tooltip, useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import { Glyph } from './icons.tsx'
import { annotationPlacement, visibleAnnotationTargets } from './annotation-placement.ts'
import { measureAnnotationCompose } from './annotation-compose.ts'
import { useLocale } from './i18n.ts'

export interface AnnotationEditorNode { id: string; number: string; title: string; ancestorIds?: readonly string[] }
export interface AnnotationEditorItem {
  id: string
  number?: number
  text: string
  nodes?: readonly AnnotationEditorNode[]
  /** Kept for older callers while node IDs are supplied separately through nodes. */
  nodeLabels?: readonly string[]
  workflowTitle?: string
}
export interface AnnotationEditorProps {
  open: boolean
  annotations: readonly AnnotationEditorItem[]
  initialId?: string
  title?: string
  saveLabel?: string
  disabled?: boolean
  availableNodes?: readonly AnnotationEditorNode[] | ((annotation: AnnotationEditorItem) => readonly AnnotationEditorNode[])
  anchorRect?: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>
  onSave(id: string, text: string, nodeIds: string[]): void | Promise<void>
  onDelete?(id: string): void | Promise<void>
  /** Explicit removal of a new unsaved annotation. */
  onDiscard?(): void | Promise<void>
  onClose(): void
  onLocate?(id: string): void
  onSelectedChange?(id: string): void
  onDraftChange?(id:string,text:string,nodeIds:string[]):void
}
interface AnnotationDraft { text: string; nodeIds: string[] }
const nodeIdsFor = (item: AnnotationEditorItem) => [...new Set(item.nodes?.map(node => node.id) || [])]
const changedTargets = (first: readonly string[], second: readonly string[]) => first.length !== second.length || first.some((id, index) => id !== second[index])

/** A small, anchored draft editor shared by composer annotations and canvas markers. */
export function AnnotationEditor(props: AnnotationEditorProps) {
  // Mount the focus layer only while visible; the host restores the invoking control on unmount.
  return props.open && props.annotations.length ? <AnnotationPopover {...props}/> : null
}
function AnnotationTargetChip({node,disabled,onRemove}:{node:AnnotationEditorNode;disabled:boolean;onRemove:()=>void}) {
  const chip=useRef<HTMLSpanElement>(null),label=useRef<HTMLSpanElement>(null),remove=useRef<HTMLButtonElement>(null)
  const measureMask=()=>{
    const text=label.current?.getBoundingClientRect(),glyph=remove.current?.querySelector('svg')?.getBoundingClientRect()
    if(!text?.width||!glyph?.width||!chip.current)return
    chip.current.style.setProperty('--vdw-chip-covered',`${Math.max(0,text.right-glyph.left)}px`)
  }
  useLayoutEffect(measureMask,[node.number])
  return <span ref={chip} className="vdw-annotation-target" title={`${node.number} · ${node.title}`} onPointerEnter={measureMask} onFocusCapture={measureMask}><span ref={label}>{node.number||'—'}</span><button ref={remove} type="button" className="vdw-annotation-chip-remove" aria-label={`移除引用 ${node.number} · ${node.title}`} disabled={disabled} onClick={onRemove}><Glyph name="close" size={12}/></button></span>
}
function AnnotationPopover({ annotations, initialId, title = '编辑注释', saveLabel = '保存', disabled = false, availableNodes, anchorRect,
  onSave, onDelete, onDiscard, onClose, onLocate, onSelectedChange, onDraftChange }: AnnotationEditorProps) {
  const {t}=useLocale(),actionLabel=saveLabel==='保存'?t('保存','Save'):saveLabel
  const [selectedId, setSelectedId] = useState(initialId), [drafts, setDrafts] = useState<Record<string, AnnotationDraft>>({})
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [menu, setMenu] = useState<'more' | 'add' | 'annotations'>(), [search, setSearch] = useState(''), [visibleCount, setVisibleCount] = useState(Number.POSITIVE_INFINITY)
  const panel = useRef<HTMLElement>(null), targets = useRef<HTMLDivElement>(null), measurement = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null), composing = useRef(false),compose=useRef<HTMLDivElement>(null),textMeasurement=useRef<HTMLTextAreaElement>(null)
  const [multiline,setMultiline]=useState(false)
  const selectionCallback = useRef(onSelectedChange); selectionCallback.current = onSelectedChange
  const hintId = useId()
  const [placement, setPlacement] = useState<{ left: number; top: number; width: number }>()
  const selected = annotations.find(item => item.id === selectedId) ?? annotations[0]!
  const getDraft = (item: AnnotationEditorItem): AnnotationDraft => drafts[item.id] ?? { text: item.text, nodeIds: nodeIdsFor(item) }
  const draft = getDraft(selected), text = draft.text, locked = disabled || busy,hasRemoval=!!(onDelete||onDiscard)
  const available = typeof availableNodes === 'function' ? availableNodes(selected) : availableNodes ?? selected.nodes ?? []
  const choices = [...new Map(available.map(node => [node.id, node])).values()]
  const lookup = new Map([...(selected.nodes ?? []), ...choices].map(node => [node.id, node]))
  const selectedNodes = draft.nodeIds.map(id => lookup.get(id) ?? { id, number: '', title: '节点暂不可用' })
  const measurementKey = selectedNodes.map(node => `${node.id}:${node.number}`).join('\n')
  const visible = selectedNodes.slice(0, visibleCount), remaining = selectedNodes.slice(visibleCount)
  const selectedNodeIds = new Set(draft.nodeIds)
  const coveredBySelectedContainer = (node: AnnotationEditorNode) => node.ancestorIds?.some(id => selectedNodeIds.has(id)) ?? false
  const addable = choices.filter(node => !selectedNodeIds.has(node.id) && !coveredBySelectedContainer(node))
  const matches = (node: AnnotationEditorNode) => `${node.number} ${node.title}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  const menuNodes = (menu === 'more' ? remaining : addable).filter(matches)
  const close = () => { if (!busy) { setDrafts({}); setError(''); onClose() } }
  useModalLayer(panel, true, close)
  useEffect(() => { setSelectedId(initialId); setDrafts({}); setError(''); setMenu(undefined) }, [initialId])
  useEffect(() => { selectionCallback.current?.(selected.id) }, [selected.id])
  useEffect(() => { setSearch('') }, [menu, selected.id])
  useEffect(() => { if (locked) setMenu(undefined) }, [locked])
  useLayoutEffect(() => {
    const field = input.current
    if (!field) return
    const measure=()=>{
      const next=measureAnnotationCompose(field,textMeasurement.current,compose.current,hasRemoval)
      const height=`${next.height}px`
      if(field.style.height!==height)field.style.height=height
      if(field.style.overflowY!==next.overflowY)field.style.overflowY=next.overflowY
      setMultiline(previous=>previous===next.multiline?previous:next.multiline)
    }
    measure()
    let width=compose.current?.getBoundingClientRect().width??0
    const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(()=>{
      const next=compose.current?.getBoundingClientRect().width??0
      // Textarea height, padding and panel animations cannot retrigger measuring.
      if(Math.abs(next-width)<.5)return;width=next;measure()
    })
    if(compose.current)observer?.observe(compose.current)
    return()=>observer?.disconnect()
  }, [text, selected.id, placement?.width,hasRemoval])
  useLayoutEffect(() => {
    if (!panel.current || typeof window === 'undefined') return
    const place = () => {
      const width = Math.min(400, Math.max(0, window.innerWidth - 32)), height = panel.current?.getBoundingClientRect().height || 120
      const fallback = { left: window.innerWidth - width - 34, right: window.innerWidth - width - 34, top: window.innerHeight - height / 2 - 80, bottom: window.innerHeight - height / 2 - 80 }
      const {left,top}=annotationPlacement(anchorRect ?? fallback,{width,height},{width:window.innerWidth,height:window.innerHeight})
      setPlacement(previous => previous?.left === left && previous.top === top && previous.width === width ? previous : { left, top, width })
    }
    place()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place)
    observer?.observe(panel.current)
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { observer?.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [anchorRect])
  useLayoutEffect(() => {
    if (!targets.current || !measurement.current) return
    const measure = () => {
      const available = targets.current?.getBoundingClientRect().width ?? 0
      const widths = Array.from(measurement.current?.children ?? []).map(element => element.getBoundingClientRect().width)
      // Unlaid-out/renderer-mocked elements have no real dimensions; preserve all targets until measured.
      if (!available || widths.some(width => !width)) return
      setVisibleCount(visibleAnnotationTargets(widths, available))
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(targets.current); observer?.observe(measurement.current)
    return () => observer?.disconnect()
  }, [measurementKey, annotations.length, placement?.width])
  const patch = (change: Partial<AnnotationDraft>) => {
    if (locked) return
    const next={...getDraft(selected),...change}
    setDrafts(previous => ({ ...previous, [selected.id]: next })); setError('');onDraftChange?.(selected.id,next.text,[...next.nodeIds])
  }
  const removeTarget = (id: string) => {
    if (locked) return
    const nodeIds = draft.nodeIds.filter(candidate => candidate !== id)
    patch({ nodeIds })
    if (menu === 'more' && nodeIds.length <= visibleCount) setMenu(undefined)
  }
  const toggleMenu = (next: 'more' | 'add') => { if (!locked) { setSearch(''); setMenu(menu === next ? undefined : next) } }
  const addTarget = (node: AnnotationEditorNode) => {
    if (locked || selectedNodeIds.has(node.id) || coveredBySelectedContainer(node)) return
    patch({ nodeIds: [...draft.nodeIds, node.id] }); setMenu(undefined)
  }
  const invalid = !text.trim() || !draft.nodeIds.length || annotations.some(item => drafts[item.id] && (!drafts[item.id]!.text.trim() || !drafts[item.id]!.nodeIds.length))
  const apply = async (operation: 'save' | 'delete') => {
    if (locked || operation === 'save' && invalid) return
    setBusy(true); setError(''); setMenu(undefined)
    try {
      if (operation === 'save') {
        // Save every locally edited annotation; switching ordinals must never drop an earlier draft.
        for (const item of annotations) {
          const edited = drafts[item.id]
          if (item.id !== selected.id && edited && (edited.text !== item.text || changedTargets(edited.nodeIds, nodeIdsFor(item)))) await onSave(item.id, edited.text.trim(), [...edited.nodeIds])
        }
        await onSave(selected.id, text.trim(), [...draft.nodeIds]); setDrafts({}); onClose()
      } else if (onDelete || onDiscard) {
        if(onDelete)await onDelete(selected.id)
        else await onDiscard!()
        setDrafts(previous => { const next = { ...previous }; delete next[selected.id]; return next })
        const rest = annotations.filter(item => item.id !== selected.id)
        if (!rest.length) onClose()
        else setSelectedId(rest[0]!.id)
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const targetMenu = (kind: 'more' | 'add', anchor: React.ReactNode) => <Menu open={menu === kind && !locked} onClose={() => setMenu(undefined)} anchor={anchor} portal align={kind === 'add' ? 'end' : 'start'} className="vdw-annotation-menu-anchor" listClassName="vdw-menu vdw-annotation-node-menu">
    <div className="vdw-annotation-menu-search"><Input autoFocus icon={<Glyph name="search" size={14}/>} aria-label={kind === 'more' ? '搜索已引用节点' : '搜索可添加节点'} placeholder="搜索节点" value={search} onChange={event => setSearch(event.target.value)}/></div>
    <div className="vdw-annotation-node-options">{menuNodes.map(node => <div className="vdw-annotation-node-row" key={node.id}>
      {kind === 'add' ? <button type="button" role="menuitem" title={`${node.number} · ${node.title}`} aria-label={`添加引用 ${node.number} · ${node.title}`} onClick={() => addTarget(node)}><span className="vdw-annotation-node-number">{node.number}</span><span>{node.title}</span></button> : <div className="vdw-annotation-node-label" title={`${node.number} · ${node.title}`}><span className="vdw-annotation-node-number">{node.number}</span><span>{node.title}</span></div>}
      {kind === 'more' && <button type="button" role="menuitem" className="vdw-annotation-remove-node" aria-label={`移除引用 ${node.number} · ${node.title}`} onClick={() => removeTarget(node.id)}><Glyph name="close" size={14}/></button>}
    </div>)}{!menuNodes.length && <p className="vdw-annotation-menu-empty">{search ? '没有匹配的节点' : kind === 'add' ? '所有可用节点均已引用' : '没有其他引用节点'}</p>}</div>
  </Menu>
  return createPortal(<div className="vdw-annotation-layer" role="presentation">
    <div className="vdw-annotation-dismiss" aria-hidden="true" onPointerDown={close}/>
    <section ref={panel} className="vdw-modal vdw-annotation-popover" role="dialog" aria-modal="true" aria-label={title} style={placement ?? { right: 24, bottom: 80 }}>
      <div className="vdw-annotation-reference-row">
        {annotations.length>1&&<nav className="vdw-annotation-list" aria-label="注释列表"><Menu open={menu==='annotations'&&!busy} onClose={()=>setMenu(undefined)} portal listClassName="vdw-menu vdw-annotation-switch-menu" selection="fill" selectedId={selected.id} items={annotations.map(item=>({id:item.id,label:`注释 ${item.number??'·'} · ${getDraft(item).text}`}))} onSelect={id=>{if(busy)return;setSelectedId(id);setError('');setMenu(undefined)}} anchor={<Button size="sm" className="vdw-annotation-switch" aria-label="切换注释" title={`注释 ${selected.number??'·'}`} aria-haspopup="menu" aria-expanded={menu==='annotations'} disabled={busy} onClick={()=>setMenu(menu==='annotations'?undefined:'annotations')}>注释 {selected.number??'·'}<Glyph name="chevron-down" size={12}/></Button>}/></nav>}
      <div ref={targets} className="vdw-annotation-targets" role="group" aria-label="引用节点" aria-describedby={!draft.nodeIds.length ? `${hintId}-targets` : undefined}>
        {visible.map(node => <AnnotationTargetChip key={node.id} node={node} disabled={locked} onRemove={()=>removeTarget(node.id)}/>)}
        {!selectedNodes.length && !!selected.nodeLabels?.length && <span className="vdw-annotation-legacy-label" title={selected.nodeLabels.join('、')}>引用暂不可用</span>}
        {!!remaining.length && targetMenu('more', <Button size="sm" className="vdw-annotation-target-more" aria-label={`查看其余 ${remaining.length} 个引用节点`} aria-haspopup="menu" aria-expanded={menu === 'more'} disabled={locked} onClick={() => toggleMenu('more')}><Glyph name="more" size={16}/></Button>)}
        {targetMenu('add', <Button size="sm" className="vdw-annotation-target-add" aria-label="添加引用节点" aria-haspopup="menu" aria-expanded={menu === 'add'} disabled={locked} onClick={() => toggleMenu('add')}><Glyph name="plus" size={16}/></Button>)}
      </div>
      </div>
        <div ref={compose} className={`vdw-annotation-compose${hasRemoval?' has-removal':''}${multiline?' is-multiline':''}`}>
          <textarea ref={input} data-modal-autofocus aria-label="修改要求" aria-describedby={`${hintId}-draft`} className="vdw-annotation-input" rows={1} value={text} disabled={locked} placeholder="添加注释…" onChange={event => patch({ text: event.target.value })} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return
            if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.keyCode === 229) return
            event.preventDefault(); event.stopPropagation()
            if (!event.repeat) void apply('save')
          }}/>
          <div className="vdw-annotation-inline-actions" aria-hidden={multiline||undefined}>
            {hasRemoval&&<Tooltip label={t('删除注释','Delete annotation')} disabled={multiline} portal side="top" maxWidth={300}><button type="button" className="vdw-annotation-delete" aria-label={multiline?undefined:t('删除注释','Delete annotation')} aria-hidden={multiline||undefined} tabIndex={multiline?-1:undefined} disabled={multiline||locked} onClick={()=>void apply('delete')}><Glyph name="trash" size={16}/></button></Tooltip>}
            <Tooltip label={t('{action}，仅保存到聊天草稿','{action}. Saves to the chat draft only.',{action:actionLabel})} disabled={multiline} portal side="top"><button type="button" className="vdw-annotation-submit" aria-label={multiline?undefined:actionLabel} aria-hidden={multiline||undefined} tabIndex={multiline?-1:undefined} disabled={multiline||locked||invalid} onClick={() => void apply('save')}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor"/></svg></button></Tooltip>
          </div>
          <div className="vdw-annotation-card-actions" aria-hidden={!multiline||undefined}>{multiline&&<>{(onDelete||onDiscard)&&<Tooltip label={t('删除注释','Delete annotation')} portal side="top" maxWidth={300}><Button size="sm" className="vdw-annotation-card-delete" aria-label={t('删除注释','Delete annotation')} disabled={locked} onClick={()=>void apply('delete')}><Glyph name="trash" size={16}/></Button></Tooltip>}<span/><Button size="sm" className="vdw-annotation-cancel" disabled={busy} onClick={close}>{t('取消','Cancel')}</Button><Tooltip label={t('{action}，仅保存到聊天草稿','{action}. Saves to the chat draft only.',{action:actionLabel})} portal side="top" maxWidth={300}><Button size="sm" className="vdw-annotation-save" aria-label={actionLabel} disabled={locked||invalid} onClick={()=>void apply('save')}>{t('保存','Save')}</Button></Tooltip></>}</div>
        </div>
      {!multiline&&onLocate&&<div className="vdw-annotation-secondary"><Tooltip label="查看工作流" portal side="top"><Button size="sm" className="vdw-annotation-locate" aria-label="查看工作流" disabled={busy} onClick={() => onLocate(selected.id)}><Glyph name="fit" size={14}/></Button></Tooltip></div>}
      <div ref={measurement} className="vdw-annotation-target-measure" aria-hidden="true">{selectedNodes.map(node=><span className="vdw-annotation-target" key={node.id}><span>{node.number||'—'}</span></span>)}</div>
      <textarea ref={textMeasurement} className="vdw-annotation-input-measure" aria-hidden="true" tabIndex={-1} readOnly value={text} rows={1}/>
      <span id={`${hintId}-draft`} className="vdw-annotation-a11y">提交后仅保存到聊天草稿；发送聊天消息后 Agent 才会处理。</span>
      {!draft.nodeIds.length && <small className="vdw-annotation-target-hint" id={`${hintId}-targets`}>请至少引用一个节点。</small>}
      {error && <p className="vdw-annotation-error" role="alert">{error}</p>}
    </section>
  </div>, document.body)
}

/** Scoped portal styles; appended by the existing client registration. */
export const annotationEditorStyles = `
.vdw-annotation-layer { position:fixed; inset:0; z-index:1000; pointer-events:auto; }
.vdw-annotation-dismiss { position:absolute; inset:0; background:transparent; }
.vdw-modal.vdw-annotation-popover { --vdw-comment-radius:24px; position:fixed; display:flex; flex-direction:column; gap:8px; width:min(400px,calc(100vw - 32px)); max-height:calc(100dvh - 32px); margin:0; padding:0; overflow:visible; border:0; border-radius:0; background:transparent; box-shadow:none; color:var(--dsw-alias-label-primary); font-family:var(--dsw-font-family); font-size:13px; line-height:20px; }
.vdw-annotation-popover > :not(.vdw-annotation-a11y) { flex-shrink:0; }
.vdw-annotation-reference-row { display:flex; align-items:center; gap:8px; min-width:0; }
.vdw-annotation-targets { display:flex; flex:1; align-items:center; gap:6px; min-width:0; margin:0; padding:0; border:0; border-radius:0; background:transparent; box-shadow:none; }
.vdw-annotation-target { position:relative; display:inline-flex; align-items:center; flex:0 0 auto; width:fit-content; min-width:0; height:28px; padding:4px 10px; overflow:hidden; border:1px solid var(--dsw-alias-border-l3); border-radius:var(--vdw-comment-radius); corner-shape:round; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-base); box-shadow:0 1px 3px rgb(0 0 0 / .04); font-size:12px; line-height:18px; }
.vdw-annotation-target { --vdw-chip-covered:calc(12px + 3px + (20px - 12px) / 2 - 10px); --vdw-chip-fade:2px; }
.vdw-annotation-target > span { display:block; min-width:0; overflow:hidden; white-space:nowrap; }
.vdw-annotation-chip-remove { position:absolute; display:grid; place-items:center; right:3px; top:3px; width:20px; height:20px; padding:3px; border:0; border-radius:50%; background:transparent; color:var(--dsw-alias-label-secondary); opacity:0; pointer-events:none; }
.vdw-annotation-target:hover .vdw-annotation-chip-remove,.vdw-annotation-target:focus-within .vdw-annotation-chip-remove { opacity:1; pointer-events:auto; }
.vdw-annotation-chip-remove:hover:not(:disabled) { background:transparent; color:var(--dsw-alias-label-primary); }
.vdw-annotation-target:hover > span,.vdw-annotation-target:focus-within > span { -webkit-mask-image:linear-gradient(to right,#000 max(0px,calc(100% - var(--vdw-chip-covered) - var(--vdw-chip-fade))),transparent max(0px,calc(100% - var(--vdw-chip-covered)))); mask-image:linear-gradient(to right,#000 max(0px,calc(100% - var(--vdw-chip-covered) - var(--vdw-chip-fade))),transparent max(0px,calc(100% - var(--vdw-chip-covered)))); }
.vdw-annotation-menu-anchor { display:inline-flex; flex:none; }
.vdw-annotation-targets .vdw-annotation-target-more,.vdw-annotation-targets .vdw-annotation-target-add { flex:none; width:28px; height:28px; padding:6px; border:1px solid var(--dsw-alias-border-l3); border-radius:var(--vdw-comment-radius); corner-shape:round; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-base); box-shadow:0 1px 3px rgb(0 0 0 / .04); }
/* Keep reference controls opaque; interaction is expressed by a deeper fill. */
.vdw-annotation-popover .vdw-annotation-targets :is(.vdw-annotation-target-more,.vdw-annotation-target-add):not(:disabled),.vdw-annotation-popover .vdw-annotation-switch:not(:disabled) { opacity:1; transition:background-color 120ms,border-color 120ms; }
.vdw-annotation-target:hover,.vdw-annotation-target:focus-within,.vdw-annotation-popover .vdw-annotation-targets :is(.vdw-annotation-target-more,.vdw-annotation-target-add):is(:hover,:focus-visible,[aria-expanded=true]):not(:disabled),.vdw-annotation-popover .vdw-annotation-switch:is(:hover,:focus-visible,[aria-expanded=true]):not(:disabled) { opacity:1; background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,var(--dsw-alias-bg-base)); border-color:var(--dsw-alias-border-l1); }
.vdw-annotation-legacy-label { min-width:0; flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; color:var(--dsw-alias-label-secondary); font-size:12px; }
.vdw-annotation-list { display:flex; flex:none; min-width:0; }
.vdw-annotation-list .vdw-annotation-switch { display:flex; align-items:center; gap:4px; height:28px; padding:4px 8px; border:1px solid var(--dsw-alias-border-l3); border-radius:var(--vdw-comment-radius); corner-shape:round; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-base); font-size:12px; line-height:18px; }
.vdw-menu.vdw-annotation-switch-menu { width:min(260px,calc(100vw - 32px)); min-width:0; max-height:min(280px,calc(100dvh - 32px)); overflow:auto; }
.vdw-annotation-target-measure { position:fixed; left:-100000px; top:0; display:flex; width:max-content; height:0; overflow:hidden; visibility:hidden; pointer-events:none; }
.vdw-annotation-popover .vdw-annotation-compose { --vdw-annotation-inline-width:34px; display:grid; grid-template-columns:minmax(0,1fr) var(--vdw-annotation-inline-width); grid-template-rows:auto auto; align-items:center; column-gap:8px; row-gap:0; min-width:0; min-height:50px; padding:7px 7px 7px 16px; overflow:hidden; border:1px solid var(--dsw-alias-border-l3); border-radius:var(--vdw-comment-radius); corner-shape:round; background:var(--dsw-alias-bg-base); box-shadow:0 2px 6px rgb(0 0 0 / .05),0 6px 20px rgb(0 0 0 / .04); transition:grid-template-columns 160ms ease-out,column-gap 160ms ease-out,row-gap 160ms ease-out,padding 160ms ease-out,border-radius 160ms ease-out; }
.vdw-annotation-popover .vdw-annotation-compose.has-removal { --vdw-annotation-inline-width:74px; }
.vdw-annotation-popover .vdw-annotation-compose.is-multiline { grid-template-columns:minmax(0,1fr) 0px; column-gap:0; row-gap:12px; padding:12px; border-radius:var(--vdw-comment-radius); }
.vdw-annotation-compose:focus-within { border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 50%,var(--dsw-alias-border-l3)); }
.vdw-modal.vdw-annotation-popover .vdw-annotation-input { display:block; grid-column:1; grid-row:1; width:100%; min-width:0; height:22px; min-height:22px; max-height:110px; margin:0; padding:0; border:0; border-radius:0; outline:none; resize:none; overflow-x:hidden; overflow-y:hidden; white-space:pre-wrap; overflow-wrap:break-word; background:transparent; color:var(--dsw-alias-label-primary); font:400 13px/22px var(--dsw-font-family); transition:height 160ms ease-out; }
.vdw-modal.vdw-annotation-popover .vdw-annotation-input-measure { position:fixed; left:-100000px; top:0; display:block; width:1px; min-width:0; height:0; min-height:0; max-height:none; margin:0; padding:0; border:0; border-radius:0; overflow:hidden; visibility:hidden; pointer-events:none; resize:none; white-space:pre-wrap; overflow-wrap:break-word; font:400 13px/22px var(--dsw-font-family); transition:none; animation:none; }
.vdw-modal.vdw-annotation-popover .vdw-annotation-input:focus-visible { outline:none; }
.vdw-annotation-input::placeholder { color:var(--dsw-alias-label-tertiary); }
.vdw-annotation-popover .vdw-annotation-inline-actions { display:flex; grid-column:2; grid-row:1; align-items:center; align-self:end; gap:8px; width:var(--vdw-annotation-inline-width); opacity:1; visibility:visible; transition:opacity 160ms ease-out,visibility 0s; }
.vdw-annotation-popover .is-multiline .vdw-annotation-inline-actions { visibility:hidden; opacity:0; pointer-events:none; transition:opacity 160ms ease-out,visibility 0s 160ms; }
.vdw-annotation-popover .vdw-annotation-delete { display:grid; place-items:center; flex:none; width:32px; height:32px; margin:0; padding:8px; border:0; border-radius:50%; background:transparent; color:var(--dsw-alias-label-secondary); }
.vdw-annotation-popover .vdw-annotation-delete:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-state-error-primary); }
.vdw-annotation-popover .vdw-annotation-delete:disabled { opacity:.4; }
.vdw-annotation-popover .vdw-annotation-submit { display:grid; flex:none; place-items:center; width:34px; height:34px; margin:0; padding:0; border:0; border-radius:999px; corner-shape:round; background:var(--dsw-alias-button-info-fill); color:#fff; cursor:pointer; transition:background 120ms; }
.vdw-annotation-popover .vdw-annotation-submit:hover:not(:disabled) { background:var(--dsw-alias-button-info-hover); }
.vdw-annotation-popover .vdw-annotation-submit:disabled { background:var(--dsw-alias-button-info-fill); color:#fff; opacity:.4; cursor:default; }
.vdw-annotation-popover .vdw-annotation-card-actions { display:flex; grid-column:1 / -1; grid-row:2; align-items:center; gap:8px; min-width:0; height:32px; max-height:0; overflow:hidden; visibility:hidden; opacity:0; pointer-events:none; transition:max-height 160ms ease-out,opacity 160ms ease-out,visibility 0s 160ms; }
.vdw-annotation-popover .is-multiline .vdw-annotation-card-actions { max-height:32px; visibility:visible; opacity:1; pointer-events:auto; transition:max-height 160ms ease-out,opacity 160ms ease-out,visibility 0s; }
.vdw-annotation-card-actions > span { flex:1; }
.vdw-annotation-popover .vdw-annotation-card-actions button { flex:none; height:32px; padding:6px 12px; border:0; border-radius:16px; background:transparent; color:var(--dsw-alias-label-secondary); font-size:13px; line-height:20px; }
.vdw-annotation-popover .vdw-annotation-card-actions .vdw-annotation-cancel { border:1px solid var(--dsw-alias-border-l3); background:var(--dsw-alias-bg-base); }
.vdw-annotation-popover .vdw-annotation-card-actions button:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }
.vdw-annotation-popover .vdw-annotation-card-actions .vdw-annotation-card-delete { width:32px; padding:8px; }
.vdw-annotation-popover .vdw-annotation-card-actions .vdw-annotation-card-delete:hover:not(:disabled) { color:var(--dsw-alias-state-error-primary); }
.vdw-annotation-popover .vdw-annotation-card-actions .vdw-annotation-save { background:var(--dsw-alias-button-info-fill); color:#fff; }
.vdw-annotation-popover .vdw-annotation-card-actions .vdw-annotation-save:hover:not(:disabled) { background:var(--dsw-alias-button-info-hover); color:#fff; }
.vdw-annotation-popover .vdw-annotation-card-actions .vdw-annotation-save:disabled { opacity:.4; cursor:default; }
.vdw-annotation-popover .vdw-annotation-secondary { display:flex; flex-wrap:nowrap; align-items:center; justify-content:flex-end; gap:4px; margin:-4px 0 0; padding:0; min-height:24px; opacity:.7; }
.vdw-annotation-popover:hover .vdw-annotation-secondary,.vdw-annotation-popover:focus-within .vdw-annotation-secondary { opacity:1; }
.vdw-annotation-secondary button { flex:none; width:24px; height:24px; padding:5px; border-radius:50%; color:var(--dsw-alias-label-secondary); }
.vdw-annotation-a11y { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
.vdw-annotation-popover .vdw-annotation-target-hint { margin-left:0; color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; }
.vdw-annotation-error { margin:0; color:var(--dsw-alias-state-error-primary); font-size:12px; line-height:18px; overflow-wrap:anywhere; }
.vdw-menu.vdw-annotation-node-menu { display:flex; flex-direction:column; width:min(280px,calc(100vw - 32px)); min-width:0; max-height:min(320px,calc(100dvh - 32px)); padding:4px; overflow:hidden; }
.vdw-annotation-menu-search { flex:none; padding:4px 4px 8px; border-bottom:1px solid var(--dsw-alias-border-l2); }
.vdw-annotation-menu-search > span { width:100%; min-width:0; height:32px; padding-inline:8px; border-radius:7px; background:var(--vdw-input-bg); }
.vdw-annotation-menu-search input { min-width:0; font-size:13px; line-height:20px; }
.vdw-annotation-node-options { flex:1; min-height:0; max-height:236px; overflow:auto; padding-top:4px; }
.vdw-annotation-node-row { display:flex; align-items:center; gap:4px; border-radius:7px; }
.vdw-menu.vdw-annotation-node-menu .vdw-annotation-node-row > button,.vdw-annotation-node-row > .vdw-annotation-node-label { display:flex; align-items:center; flex:1; min-width:0; min-height:32px; padding:6px 8px; border:0; border-radius:6px; background:transparent; color:var(--dsw-alias-label-primary); text-align:left; font:400 13px/20px var(--dsw-font-family); }
.vdw-annotation-node-row > :is(button,.vdw-annotation-node-label) > span:last-child { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.vdw-annotation-node-number { flex:none; color:var(--dsw-alias-label-tertiary); font-size:12px; }
.vdw-menu.vdw-annotation-node-menu .vdw-annotation-node-row > .vdw-annotation-remove-node { flex:none; width:28px; height:28px; min-height:28px; padding:7px; color:var(--dsw-alias-label-secondary); }
.vdw-annotation-node-row:hover { background:var(--dsw-alias-interactive-bg-hover); }
.vdw-menu.vdw-annotation-node-menu .vdw-annotation-node-row > button:hover { background:var(--dsw-alias-interactive-bg-hover); }
.vdw-annotation-menu-empty { margin:0; padding:12px 8px; color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; }
@media(hover:none) { .vdw-annotation-chip-remove { opacity:1; pointer-events:auto; } .vdw-annotation-target > span { -webkit-mask-image:linear-gradient(to right,#000 max(0px,calc(100% - var(--vdw-chip-covered) - var(--vdw-chip-fade))),transparent max(0px,calc(100% - var(--vdw-chip-covered)))); mask-image:linear-gradient(to right,#000 max(0px,calc(100% - var(--vdw-chip-covered) - var(--vdw-chip-fade))),transparent max(0px,calc(100% - var(--vdw-chip-covered)))); } }
@media(prefers-reduced-motion:reduce) { .vdw-annotation-popover .vdw-annotation-compose,.vdw-modal.vdw-annotation-popover .vdw-annotation-input,.vdw-annotation-popover .vdw-annotation-inline-actions,.vdw-annotation-popover .vdw-annotation-submit,.vdw-annotation-popover .vdw-annotation-card-actions { transition:none; } }
`
