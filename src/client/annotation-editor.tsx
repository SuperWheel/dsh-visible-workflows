import { useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { Glyph } from './icons.tsx'

export interface AnnotationEditorItem {
  id: string
  number?: number
  text: string
  nodeLabels: readonly string[]
  workflowTitle?: string
}

export interface AnnotationEditorProps {
  open: boolean
  annotations: readonly AnnotationEditorItem[]
  initialId?: string
  title?: string
  saveLabel?: string
  disabled?: boolean
  onSave(id: string, text: string): void | Promise<void>
  onDelete?(id: string): void | Promise<void>
  onClose(): void
  onLocate?(id: string): void
}

/** One editor for the native composer chip and canvas annotation markers. */
export function AnnotationEditor({ open, annotations, initialId, title = '编辑注释', saveLabel = '保存', disabled = false,
  onSave, onDelete, onClose, onLocate }: AnnotationEditorProps) {
  const [selectedId, setSelectedId] = useState(initialId)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setSelectedId(initialId); setDrafts({}); setError('')
  }, [open, initialId])
  const selected = annotations.find(item => item.id === selectedId) ?? annotations[0]
  const text = selected ? drafts[selected.id] ?? selected.text : ''
  const locked = disabled || busy
  const close = () => { if (!busy) { setDrafts({}); setError(''); onClose() } }
  const apply = async (operation: 'save' | 'delete') => {
    if (!selected || locked) return
    setBusy(true); setError('')
    try {
      if (operation === 'save') {
        // Switching list rows keeps local edits. Save those edits together so
        // closing the editor cannot silently discard a previously edited row.
        for (const item of annotations) {
          if (item.id !== selected.id && drafts[item.id] !== undefined && drafts[item.id] !== item.text) {
            await onSave(item.id, drafts[item.id]!.trim())
          }
        }
        await onSave(selected.id, text.trim())
        setDrafts({}); onClose()
      } else if (onDelete) {
        await onDelete(selected.id)
        setDrafts(previous => { const next = { ...previous }; delete next[selected.id]; return next })
        const remaining = annotations.filter(item => item.id !== selected.id)
        if (!remaining.length) onClose()
        else setSelectedId(remaining[0]!.id)
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const hasEmptyDraft = annotations.some(item => drafts[item.id] !== undefined && !drafts[item.id]!.trim())
  return <Modal open={open && !!selected} onClose={close} title={title} closeLabel="关闭注释"
    className={`vdw-modal vdw-annotation-modal${annotations.length > 1 ? ' vdw-annotation-modal-multiple' : ''}`}
    description="修改保存在聊天草稿中，发送后 Agent 才会处理。"
    footer={<div className="vdw-annotation-footer">
      <div>{onDelete && <Button variant="ghost" className="vdw-annotation-delete" icon={<Glyph name="trash"/>} disabled={locked} onClick={() => void apply('delete')}>删除注释</Button>}</div>
      <div><Button disabled={busy} onClick={close}>取消</Button><Button variant="primary" disabled={locked || !text.trim() || hasEmptyDraft} onClick={() => void apply('save')}>{saveLabel}</Button></div>
    </div>}>
    <div className="vdw-annotation-layout">
      {annotations.length > 1 && <nav className="vdw-annotation-list" aria-label="注释列表">
        {annotations.map(item => <button key={item.id} type="button" aria-pressed={selected?.id === item.id}
          disabled={busy} onClick={() => { setSelectedId(item.id); setError('') }}>
          <span className="vdw-annotation-ordinal">{item.number ?? '·'}</span>
          <span><strong>注释 {item.number ?? ''}</strong><span>{drafts[item.id] ?? item.text}</span></span>
        </button>)}
      </nav>}
      <div className="vdw-annotation-content">
        {selected?.workflowTitle && <p className="vdw-annotation-workflow">{selected.workflowTitle}</p>}
        <div className="vdw-annotation-targets" aria-label="引用节点">
          {selected?.nodeLabels.map((label, index) => <span className="vdw-annotation-target" key={`${index}-${label}`}><Glyph name="link"/>{label}</span>)}
          {selected && onLocate && <Button size="sm" variant="ghost" onClick={() => onLocate(selected.id)}>定位节点</Button>}
        </div>
        <label className="vdw-annotation-input-label">修改要求
          <textarea data-modal-autofocus aria-label="修改要求" rows={6} value={text} disabled={locked}
            placeholder="描述你希望如何调整这些节点" onChange={event => {
              if (selected) setDrafts(previous => ({ ...previous, [selected.id]: event.target.value }))
            }}/>
        </label>
        {error && <p className="vdw-annotation-error" role="alert">{error}</p>}
      </div>
    </div>
  </Modal>
}

/** Append to the root plugin stylesheet so portaled native modals share these rules. */
export const annotationEditorStyles = `
.vdw-annotation-modal { width:min(560px,100%); font-size:14px; line-height:22px; }
.vdw-annotation-modal-multiple { width:min(740px,100%); }
.vdw-annotation-layout { display:flex; gap:20px; min-width:0; margin-top:4px; }
.vdw-annotation-list { flex:0 0 176px; display:flex; flex-direction:column; gap:4px; padding-right:12px; border-right:1px solid var(--dsw-alias-border-l3); max-height:320px; overflow:auto; }
.vdw-annotation-list > button { display:flex; align-items:flex-start; gap:8px; width:100%; padding:10px; border:0; border-radius:12px; text-align:left; font:inherit; color:var(--dsw-alias-label-secondary); background:transparent; }
.vdw-annotation-list > button:hover { background:var(--dsw-alias-interactive-bg-hover); }
.vdw-annotation-list > button[aria-pressed=true] { color:var(--dsw-alias-state-business-primary); background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,transparent); }
.vdw-annotation-ordinal { display:grid; place-items:center; flex:0 0 22px; height:22px; border-radius:6px; font-size:12px; background:color-mix(in srgb,currentColor 8%,transparent); }
.vdw-annotation-list > button > span:last-child { min-width:0; display:flex; flex-direction:column; gap:2px; }
.vdw-annotation-list strong { font-size:14px; font-weight:500; line-height:22px; }
.vdw-annotation-list > button > span:last-child > span { color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; }
.vdw-annotation-content { flex:1; min-width:0; display:flex; flex-direction:column; gap:12px; }
.vdw-annotation-workflow { color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; overflow-wrap:anywhere; }
.vdw-annotation-targets { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
.vdw-annotation-target { display:inline-flex; align-items:center; gap:6px; max-width:100%; padding:4px 8px; border:1px solid var(--dsw-alias-border-l3); border-radius:8px; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:18px; overflow-wrap:anywhere; }
.vdw-annotation-target > svg { width:14px; height:14px; flex:none; }
.vdw-annotation-targets > button { height:28px; font-size:12px; line-height:18px; }
.vdw-annotation-input-label { display:flex; flex-direction:column; gap:8px; font-size:14px; line-height:22px; font-weight:500; }
.vdw-annotation-modal .vdw-annotation-input-label > textarea { min-height:128px; max-height:360px; width:100%; padding:12px; border:1px solid var(--dsw-alias-border-l3); border-radius:12px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font:inherit; font-weight:400; line-height:22px; resize:vertical; }
.vdw-annotation-error { color:var(--dsw-alias-state-error-primary); font-size:12px; line-height:18px; overflow-wrap:anywhere; }
.vdw-annotation-footer { display:flex; align-items:center; justify-content:space-between; flex:1; width:100%; gap:12px; }
.vdw-annotation-footer > div { display:flex; gap:8px; align-items:center; }
.vdw-annotation-footer button { height:36px; font-size:14px; line-height:22px; border-radius:12px; }
.vdw-annotation-footer .vdw-annotation-delete { color:var(--dsw-alias-state-error-primary); }
@media(max-width:600px) {
  .vdw-annotation-layout { flex-direction:column; gap:12px; }
  .vdw-annotation-list { flex:0 0 auto; max-height:112px; border-right:0; border-bottom:1px solid var(--dsw-alias-border-l3); padding:0 0 8px; }
  .vdw-annotation-list > button { padding:8px; }
  .vdw-annotation-list > button > span:last-child > span { -webkit-line-clamp:1; }
  .vdw-annotation-footer { gap:8px; }
  .vdw-annotation-footer > div { gap:4px; }
  .vdw-annotation-footer button { padding-inline:8px; }
}
`
