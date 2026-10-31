import { t, useLocale } from './i18n.ts'
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { Glyph } from './icons.tsx'
import { formatJsonCode, indentCode, tokenizeCode, type CodeLanguage } from './code-tokens.ts'
import { ExpandedEditorShell } from './expanded-editor.tsx'
export { tokenizeCode, type CodeLanguage } from './code-tokens.ts'

export function HighlightedCode({ value, language }: { value: string; language: CodeLanguage }) {
  const tokens = useMemo(() => tokenizeCode(value, language), [value, language])
  return <>{tokens.map((token, index) => token.kind === 'plain' ? token.text : <span key={index} className={`vdw-syntax-${token.kind}`}>{token.text}</span>)}</>
}

export function CollapseEditorIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 9h6V3M21 9h-6V3M3 15h6v6M21 15h-6v6"/></svg> }

const LANGUAGES: Record<CodeLanguage, string> = { json: 'JSON', javascript: 'JavaScript', python: 'Python', template: '模板', text: '纯文本' }

interface CodeEditorProps {
  label: string; value: string; language: CodeLanguage; onChange?: (value: string) => void; disabled?: boolean; readOnly?: boolean; rows?: number; error?: string; help?: string
}

/** Compact and expanded views share the same controlled value, validation and actions. */
export function CodeEditor({ label, value, language, onChange, disabled = false, readOnly = false, rows = 8, error, help }: CodeEditorProps) {
  useLocale()
  const [expanded, setExpanded] = useState(false), [status, setStatus] = useState(''), [formatError, setFormatError] = useState('')
  const expandButton = useRef<HTMLButtonElement>(null), formattedChange = useRef(false)
  const locked = readOnly || !onChange
  useEffect(() => { if (formattedChange.current) formattedChange.current = false; else setStatus(''); setFormatError('') }, [value])
  const change = (next: string) => { if (!disabled && !locked) { setFormatError(''); onChange?.(next) } }
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setStatus('已复制') }
    catch { setStatus('复制失败，请选择文字后复制。') }
  }
  const format = () => {
    if (disabled || locked) return
    const result = formatJsonCode(value)
    if (result.error) { setFormatError(result.error); setStatus(''); return }
    formattedChange.current = result.value !== value
    change(result.value); setStatus('已格式化')
  }
  const close = () => { setExpanded(false); queueMicrotask(() => expandButton.current?.focus()) }
  const shared = { label, value, language, disabled, readOnly: locked, rows, help, error: error || formatError, onChange: change, onCopy: () => void copy(), onFormat: format, status }
  return <>
    <EditorSurface {...shared} onExpand={() => setExpanded(true)} expandButton={expandButton}/>
    {expanded && <ExpandedEditorShell label={`${label} · ${t(LANGUAGES[language])}`} onClose={close}>
      <EditorSurface {...shared} expanded onCloseExpanded={close}/>
    </ExpandedEditorShell>}
  </>
}

/** The native textarea owns input methods, selection and ordinary text undo. */
function EditorSurface({ label, value, language, onChange, disabled = false, readOnly = false, rows = 8, error, help, status, onCopy, onFormat, onExpand, expandButton, expanded = false, onCloseExpanded }: CodeEditorProps & {
  status: string; onCopy: () => void; onFormat: () => void; onExpand?: () => void; expandButton?: RefObject<HTMLButtonElement>; expanded?: boolean; onCloseExpanded?: () => void
}) {
  const field = useRef<HTMLTextAreaElement>(null), highlight = useRef<HTMLPreElement>(null), gutter = useRef<HTMLDivElement>(null)
  const escapeTab = useRef(false), composing = useRef(false), pendingSelection = useRef<{ start: number; end: number }>()
  const id = useId(), locked = readOnly || !onChange, lineCount = value.split('\n').length
  useEffect(() => {
    const selection = pendingSelection.current
    if (selection && field.current) { field.current.setSelectionRange(selection.start, selection.end); pendingSelection.current = undefined }
  }, [value])
  const description = disabled ? '当前不可编辑。' : locked ? '只读内容。' : `Tab 缩进，Shift+Tab 取消缩进。${expanded ? 'Esc 关闭展开编辑器。' : '按 Esc 后再按 Tab 可离开编辑器。'}`
  const notice = value.length > 60_000 ? '内容较长，已暂停语法高亮。' : ''
  return <section className={`vdw-source-editor${expanded ? ' is-expanded' : ''}${disabled ? ' is-disabled' : ''}${error ? ' has-error' : ''}`} aria-label={`${label}编辑器${expanded ? '（展开）' : ''}`}>
    <header className="vdw-source-toolbar"><div className="vdw-source-language"><Glyph name="code" size={14}/><strong>{t(LANGUAGES[language])}</strong><span>{t('{count} 行','{count} lines',{count:lineCount})}</span></div><div className="vdw-source-actions">
      {language === 'json' && !locked && <Tooltip label={t("格式化 JSON","Format JSON")} portal side="bottom"><Button size="sm" className="vdw-source-action" disabled={disabled} aria-label={`格式化${label}${expanded ? '（展开）' : ''}`} onClick={onFormat}>{t("格式化","Format")}</Button></Tooltip>}
      <Tooltip label={t('复制{label}','Copy {label}',{label})} portal side="bottom"><Button size="sm" className="vdw-source-action" disabled={disabled || !value} aria-label={t('复制{label}{suffix}','Copy {label}{suffix}',{label,suffix:expanded?t('（展开）',' (expanded)'):''})} onClick={onCopy}><Glyph name="copy" size={14}/></Button></Tooltip>
      {onExpand && <Tooltip label={locked ? t('展开查看{label}','Expand {label}',{label}) : t('展开编辑{label}','Expand {label}',{label})} portal side="bottom"><Button ref={expandButton} size="sm" className="vdw-source-action" aria-label={t('展开{label}','Expand {label}',{label})} aria-haspopup="dialog" onClick={onExpand}><Glyph name="expand" size={14}/></Button></Tooltip>}
      {onCloseExpanded && <Tooltip label={t('收起{label}','Collapse {label}',{label})} portal side="bottom"><Button size="sm" className="vdw-source-action" aria-label={t('收起{label}','Collapse {label}',{label})} data-modal-autofocus={disabled || undefined} onClick={onCloseExpanded}><CollapseEditorIcon/></Button></Tooltip>}
    </div></header>
    <span className="vdw-source-a11y" id={`${id}-help`}>{description}</span>
    <div className="vdw-source-body" style={expanded ? undefined : { height: Math.max(4, Math.min(20, rows)) * 20 + 24 }}>
      <div className="vdw-source-gutter" aria-hidden="true" style={{ minWidth: `${Math.max(2, String(lineCount).length) + 2}ch` }}><div ref={gutter}>{Array.from({ length: Math.min(lineCount, 5_000) }, (_, index) => index + 1).join('\n')}</div></div>
      <div className="vdw-source-content"><pre ref={highlight} className="vdw-source-highlight" aria-hidden="true"><HighlightedCode value={value + '\n'} language={language}/></pre><textarea ref={field} className="vdw-source-input" aria-label={`${label}${expanded ? '（展开）' : ''}`} aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`} aria-invalid={!!error} data-modal-autofocus={expanded && !disabled || undefined} value={value} disabled={disabled} readOnly={locked} wrap="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onChange={event => { if (!disabled && !locked) onChange?.(event.target.value) }} onBlur={() => { escapeTab.current = false }} onScroll={event => {
        const { scrollTop, scrollLeft } = event.currentTarget
        if (highlight.current) highlight.current.style.transform = `translate(${-scrollLeft}px,${-scrollTop}px)`
        if (gutter.current) gutter.current.style.transform = `translateY(${-scrollTop}px)`
      }} onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing) return
        if (event.key === 'Escape' && onCloseExpanded) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) onCloseExpanded(); return }
        if (disabled || locked) return
        if (event.key === 'Escape') { escapeTab.current = true; event.preventDefault(); event.stopPropagation(); return }
        if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
        if (escapeTab.current) { escapeTab.current = false; return }
        event.preventDefault(); event.stopPropagation()
        const next = indentCode(value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd, event.shiftKey)
        if (next.value === value) return
        pendingSelection.current = { start: next.start, end: next.end }
        onChange?.(next.value)
      }}/></div>
    </div>
    {(help || notice || status) && <footer className="vdw-source-footer">{(help || notice) && <small>{[help, notice].filter(Boolean).join(' ')}</small>}{status && <small role="status">{t(status)}</small>}</footer>}
    {error && <small className="vdw-source-error" id={`${id}-error`} role="alert">{error}</small>}
  </section>
}
