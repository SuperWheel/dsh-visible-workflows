import { isCachedBody } from '../shared/http-cache.ts'
import { t, useLocale } from './i18n.ts'
import { useEffect, useMemo, useState } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { ExpandedEditorShell } from './expanded-editor.tsx'
import { Glyph } from './icons.tsx'
import { CollapseEditorIcon, HighlightedCode } from './code-editor.tsx'

const PAGE = 40
export function dataType(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
}
export function inspectData(value: unknown) {
  if (value === undefined) return { raw: '', value, structured: false, fieldsSafe: true }
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (typeof value === 'string' && value.trim()) {
    try { let unsafe = false; const parsed: unknown = JSON.parse(value, (_key, item) => { if (typeof item === 'number' && (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))) unsafe = true; return item }); if (parsed !== null && typeof parsed === 'object') return { raw, value: parsed, structured: true, fieldsSafe: !unsafe } } catch { /* Ordinary text is displayed verbatim. */ }
  }
  return { raw, value, structured: value !== null && typeof value === 'object', fieldsSafe: true }
}
function Value({value, depth = 0}: {value: unknown; depth?: number}) {useLocale();
  const [expanded, setExpanded] = useState(false), [count, setCount] = useState(PAGE)
  if(isCachedBody(value)){const ref=value.$cachedBody;return <div className="vdw-data-text"><p className="vdw-muted">{ref.evicted?t('响应正文已清理','Response body cleared'):t('响应正文已缓存','Response body cached')}（{ref.evicted?t('原大小 ','Original size '):''}{ref.bytes.toLocaleString()} bytes，sha256: {ref.sha256}）</p><span className="vdw-data-value vdw-data-string">{ref.preview}</span></div>}
  if (value !== null && typeof value === 'object') {
    const size = Array.isArray(value) ? value.length : Object.keys(value).length
    if (!size) return <code className="vdw-data-primitive">{Array.isArray(value) ? '[]' : '{}'}</code>
    return <div className="vdw-data-nested"><button type="button" className="vdw-data-fold" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><Glyph name={expanded ? 'chevron-down' : 'chevron-right'} size={12}/><span>{size} {Array.isArray(value) ? t("项") : t("个字段")}</span></button>{expanded && (depth < 12 ? <Entries value={value} depth={depth + 1}/> : <p className="vdw-data-limit">{t("层级较深，请切换 JSON 查看。")}</p>)}</div>
  }
  const rendered = value === '' ? '""' : value === undefined ? t('未提供') : String(value)
  const visible = rendered.slice(0, count * 100)
  return <span className={`vdw-data-value vdw-data-${dataType(value)}`}>{visible}{visible.length < rendered.length && <button type="button" className="vdw-data-more" onClick={() => setCount(count + PAGE)}>{t('展开剩余 {count} 字符','Show remaining {count} characters',{count:rendered.length-visible.length})}</button>}</span>
}
function Entries({value, depth = 0}: {value: object; depth?: number}) {useLocale();
  const [count, setCount] = useState(PAGE)
  const keys = useMemo(() => Array.isArray(value) ? undefined : Object.keys(value), [value]), total = Array.isArray(value) ? value.length : keys!.length
  const rows = keys ? keys.slice(0, count) : Array.from({length: Math.min(total, count)}, (_, index) => String(index))
  return <div className="vdw-data-entries">{rows.map(name => {
    const entry = (value as Record<string, unknown>)[name]
    return <div className="vdw-data-row" key={name}><div className="vdw-data-key"><code>{name}</code><span className="vdw-data-type">{dataType(entry)}</span></div><Value value={entry} depth={depth}/></div>
  })}{total > count && <button type="button" className="vdw-data-more" onClick={() => setCount(count + PAGE)}>{t('再显示 {count} 项 · 共 {total} 项','Show {count} more · {total} total',{count:Math.min(PAGE,total-count),total})}</button>}{!total && <code className="vdw-data-primitive">{Array.isArray(value) ? '[]' : '{}'}</code>}</div>
}
function DataBody({value, raw, structured, fieldsSafe, mode, expanded}: ReturnType<typeof inspectData> & {mode: string; expanded?: boolean}) {useLocale();
  const [limit, setLimit] = useState(20_000)
  if(isCachedBody(value)&&mode==='fields')return <Value value={value}/>
  if (structured && fieldsSafe && mode === 'fields') return <Entries value={value as object}/>
  if (value === undefined) return <p className="vdw-data-empty">{t("未提供")}</p>
  if (!structured) return <div className="vdw-data-text"><Value value={value}/></div>
  const code = raw, visible = code.slice(0, expanded ? Math.max(limit, 50_000) : limit)
  return <div className="vdw-data-code">{!fieldsSafe && <p className="vdw-data-precision-note">{t("数值超过安全精度，保留原始 JSON 查看。")}</p>}<div className="vdw-data-source"><div className="vdw-data-line-numbers" aria-hidden="true">{visible.split('\n').map((_, index) => <span key={index}>{index + 1}</span>)}</div><pre><code><HighlightedCode value={visible} language="json"/></code></pre></div>{visible.length < code.length && <button type="button" className="vdw-data-more" onClick={() => setLimit(Math.max(limit, expanded ? 50_000 : 20_000) + 50_000)}>{t('继续显示 · 共 {count} 字符','Show more · {count} characters total',{count:code.length.toLocaleString()})}</button>}</div>
}
/** Displays real run values; copy always uses the original, complete payload. */
export function DataViewer({title, value}: {title: string; value: unknown}) {useLocale();
  const data = useMemo(() => inspectData(value), [value]), [mode, setMode] = useState('fields'), [expanded, setExpanded] = useState(false), [feedback, setFeedback] = useState('')
  useEffect(() => { setFeedback('') }, [value])
  const copy = async () => { try { if (!navigator.clipboard?.writeText) throw new Error(); await navigator.clipboard.writeText(data.raw); setFeedback('已复制') } catch { setFeedback('复制失败，请选择内容复制。') } }
  const body = (large = false) => <DataBody key={`${mode}:${large}`} {...data} mode={mode} expanded={large}/>
  const toolbar = (large = false) => <header className="vdw-data-toolbar"><h4>{title}</h4><span className="vdw-data-type">{data.structured ? 'JSON' : dataType(value) === 'string' ? t("文本") : dataType(value) === 'undefined' ? t("空") : dataType(value)}</span><div className="vdw-data-actions">{data.structured && data.fieldsSafe && <div className="vdw-data-modes" aria-label={t('{title}显示方式','Display mode for {title}',{title})}><button type="button" aria-pressed={mode === 'fields'} onClick={() => setMode('fields')}>{t("字段")}</button><button type="button" aria-pressed={mode === 'json'} onClick={() => setMode('json')}>JSON</button></div>}<Tooltip label={t('复制{title}','Copy {title}',{title})} portal><Button size="sm" className="vdw-icon-button" aria-label={t('复制{title}{suffix}','Copy {title}{suffix}',{title,suffix:large?t('（展开）',' (expanded)'):''})} disabled={value === undefined} onClick={() => void copy()}><Glyph name="copy" size={14}/></Button></Tooltip><Tooltip label={large ? t('收起{title}','Collapse {title}',{title}) : t('展开{title}','Expand {title}',{title})} portal><Button size="sm" className="vdw-icon-button" aria-label={large ? t('关闭展开{title}','Close expanded {title}',{title}) : t('展开{title}','Expand {title}',{title})} onClick={() => setExpanded(!large)}>{large ? <CollapseEditorIcon/> : <Glyph name="expand" size={14}/>}</Button></Tooltip></div></header>
  return <section className="vdw-data-viewer" aria-label={title}>
    {toolbar()}<div className="vdw-data-content">{body()}</div>{!expanded && feedback && <small className="vdw-data-feedback" role="status">{t(feedback)}</small>}
    {expanded && <ExpandedEditorShell label={title} onClose={() => setExpanded(false)}><section className="vdw-data-viewer vdw-data-expanded" aria-label={t('{title}（展开）','{title} (expanded)',{title})}>{toolbar(true)}<div className="vdw-data-content">{body(true)}</div>{feedback && <small className="vdw-data-feedback" role="status">{t(feedback)}</small>}</section></ExpandedEditorShell>}
  </section>
}
