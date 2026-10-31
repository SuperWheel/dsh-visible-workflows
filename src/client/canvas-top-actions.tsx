import { useEffect, useState, type ReactNode } from 'react'
import { Button, Menu, type MenuItem } from '@deepseek-ai/dsh-client-ui-primitives'
import { Glyph } from './icons.tsx'
import { ActionTooltip as Tooltip } from './action-tooltip.tsx'
import { useLocale } from './i18n.ts'

export interface CanvasTopActionsProps {
  selectedCount: number
  disabled: boolean
  placingAnnotation: boolean
  collapsed: boolean
  iconOnly?: boolean
  onToggleAnnotation: () => void
  onDuplicate: () => void
  onDelete: () => void
  onAgent?: () => void
  variablePanel?: 'environment' | 'system'
  onEnvironment?: () => void
  onSystem?: () => void
  onPolicy?: () => void
  executionActions?: ReactNode
}

function IconAction({label, icon, disabled, onClick}: {label: string; icon: string; disabled?: boolean; onClick: () => void}) {
  const {t}=useLocale()
  return <Tooltip label={t(label)} portal side="bottom"><Button type="button" size="sm" className="vdw-icon-button" aria-label={t(label)} disabled={disabled} onClick={onClick}><Glyph name={icon}/></Button></Tooltip>
}

/** Hidden secondary controls remain mounted and measurable; primary execution is never duplicated. */
export function CanvasTopActions({selectedCount, disabled, placingAnnotation, collapsed, iconOnly = false, onToggleAnnotation, onDuplicate, onDelete, onAgent, executionActions}: CanvasTopActionsProps) {
  const {t}=useLocale()
  const [open, setOpen] = useState(false)
  useEffect(() => { if (!collapsed) setOpen(false) }, [collapsed])
  const items: MenuItem[] = [
    ...(onAgent ? [{id: 'agent', label: t('交给 Agent', 'Send to Agent'), icon: <Glyph name="brain"/>}] : []),
    ...(selectedCount > 0 ? [
      {id: 'annotation', label: placingAnnotation ? t('取消添加注释','Cancel annotation') : t('添加注释','Add annotation'), icon: <Glyph name="comment"/>},
      {id: 'duplicate', label: t('复制节点', 'Duplicate nodes'), icon: <Glyph name="copy"/>, disabled},
      {id: 'delete', label: t('删除节点', 'Delete nodes'), icon: <Glyph name="trash"/>, disabled, danger: true},
    ] : []),
  ]
  const select = (id: string) => {
    setOpen(false)
    if (id === 'agent') { onAgent?.(); return }
    if (selectedCount <= 0) return
    if (id === 'annotation') onToggleAnnotation()
    if (disabled) return
    if (id === 'duplicate') onDuplicate()
    if (id === 'delete') onDelete()
  }
  return <>
    {selectedCount > 0 && <div className={`vdw-selection-actions${collapsed ? ' is-concealed' : ''}`} role="group" aria-label={t('所选节点操作', 'Selected node actions')} aria-hidden={collapsed || undefined}>
      <span className="vdw-selection-count" aria-hidden={iconOnly || undefined}>{t('已选 {count} 个','{count} selected',{count:selectedCount})}</span>
      <Tooltip label={placingAnnotation ? t('取消添加注释','Cancel annotation') : t('添加注释','Add annotation')} portal side="bottom"><Button type="button" size="sm" className="vdw-annotation-action" icon={<Glyph name="comment"/>} aria-label={t('添加注释', 'Add annotation')} aria-pressed={placingAnnotation} onClick={onToggleAnnotation}><span className="vdw-control-label" aria-hidden={iconOnly || undefined}>{t('添加注释', 'Add annotation')}</span></Button></Tooltip>
      <IconAction label={t('复制节点', 'Duplicate nodes')} icon="copy" disabled={disabled} onClick={onDuplicate}/>
      <IconAction label={t('删除节点', 'Delete nodes')} icon="trash" disabled={disabled} onClick={onDelete}/>
    </div>}
    <div className="vdw-execution-actions vdw-floating" role="group" aria-label={t('工作流执行', 'Workflow execution')}>
      {onAgent && <Tooltip label={t('交给 Agent', 'Send to Agent')} portal side="bottom"><Button type="button" size="sm" className={`vdw-agent-action${collapsed ? ' is-concealed' : ''}`} icon={<Glyph name="brain"/>} aria-label={t('交给 Agent', 'Send to Agent')} aria-hidden={collapsed || undefined} onClick={onAgent}><span className="vdw-control-label" aria-hidden={iconOnly || undefined}>{t('交给 Agent', 'Send to Agent')}</span></Button></Tooltip>}
      <Menu className={`vdw-canvas-overflow${collapsed ? '' : ' is-concealed'}`} open={open && collapsed} onClose={() => setOpen(false)} portal align="end" listClassName="vdw-menu" items={items} onSelect={select}
        anchor={<Button type="button" size="sm" className="vdw-canvas-overflow-trigger vdw-icon-button" aria-label={t('展开画布操作', 'More canvas actions')} aria-hidden={!collapsed || undefined} aria-haspopup="menu" aria-expanded={open && collapsed} disabled={!items.length} onClick={() => setOpen(value => !value)}><Glyph name="more"/></Button>}/>
      <span className="vdw-primary-execution">{executionActions}</span>
    </div>
  </>
}

/** One export entry; the native menu owns keyboard navigation and focus return. */
export function CanvasExportMenu({onJson,onSvg,onOpen}:{onJson?:()=>void;onSvg:()=>void;onOpen?:()=>void}) {
  const {t}=useLocale()
  const [open,setOpen]=useState(false)
  return <Menu className="vdw-canvas-export" listClassName="vdw-menu" open={open} onClose={()=>setOpen(false)} side="right" align="start" portal autoFocus
    items={[...(onJson?[{id:'json',label:'流程 JSON',icon:<Glyph name="code"/>}]:[]),{id:'svg',label:'画布 SVG',icon:<Glyph name="arrange"/>}]}
    onSelect={id=>{setOpen(false);if(id==='json')onJson?.();if(id==='svg')onSvg()}}
    anchor={<Tooltip label={t('导出', 'Export')} portal side="bottom"><Button type="button" size="sm" className="vdw-icon-button" aria-label={t('导出', 'Export')} aria-haspopup="menu" aria-expanded={open} onClick={()=>{if(!open)onOpen?.();setOpen(value=>!value)}}><Glyph name="download"/></Button></Tooltip>}/>
}
