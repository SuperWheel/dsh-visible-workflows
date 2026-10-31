import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { Glyph } from './icons.tsx'
import { useLocale } from './i18n.ts'

/** A pending request stays in the inspector dock until the user chooses to review it. */
export function ProposalNotice({count,onReview}:{count:number;onReview:()=>void}) {
  const {t}=useLocale()
  if(count<=0)return null
  return <section className="vdw-proposal-notice-card" role="status" aria-live="polite" aria-atomic="true" aria-label={t('待确认的工作流修改','Workflow changes awaiting review')}>
    <header className="vdw-proposal-notice-heading"><span className="vdw-proposal-notice-badge"><Glyph name="note" size={14}/>{t('修改请求','Change request')}</span><span className="vdw-proposal-notice-count">{t('{count} 项待确认','{count} pending',{count})}</span></header>
    <div className="vdw-proposal-notice-content"><p>{t('Agent 提交了修改，等待你确认。','The Agent submitted changes for your review.')}</p><Button type="button" variant="primary" size="sm" onClick={onReview}>{t('查看修改','Review changes')}</Button></div>
  </section>
}

export const proposalNoticeStyles=`
.vdw-proposal-notice-card { display:flex; flex:0 0 auto; flex-direction:column; gap:var(--vdw-space-inner,8px); width:100%; min-width:0; padding:var(--vdw-space-card,12px); border:1px solid color-mix(in srgb,var(--vdw-accent) 32%,var(--vdw-border)); border-radius:12px; background:color-mix(in srgb,var(--vdw-accent) 4%,var(--dsw-alias-bg-base)); box-shadow:var(--vdw-floating-shadow,var(--dsw-elevation-soft)); pointer-events:auto; animation:vdw-proposal-notice-appear 160ms ease-out; }
.vdw-proposal-notice-heading { display:flex; align-items:center; justify-content:space-between; gap:var(--vdw-space-inner,8px); min-width:0; }
.vdw-proposal-notice-badge { display:inline-flex; flex:none; align-items:center; gap:4px; min-height:24px; padding:2px 8px; border-radius:6px; background:color-mix(in srgb,var(--vdw-accent) 10%,var(--dsw-alias-bg-base)); color:var(--vdw-accent); font-size:12px; line-height:20px; font-weight:500; }
.vdw-proposal-notice-badge > svg { flex:none; }
.vdw-proposal-notice-count { min-width:0; color:var(--vdw-secondary); font-size:12px; line-height:18px; text-align:right; overflow-wrap:anywhere; font-variant-numeric:tabular-nums; }
.vdw-proposal-notice-content { display:flex; align-items:center; gap:var(--vdw-space-card,12px); min-width:0; }
.vdw-proposal-notice-content > p { flex:1; min-width:0; margin:0; color:var(--dsw-alias-label-primary); font-size:13px; line-height:20px; overflow-wrap:anywhere; }
.vdw-proposal-notice-content > button { flex:none; height:var(--vdw-control-height,32px); min-height:var(--vdw-control-height,32px); padding:0 12px; border-radius:var(--vdw-radius-control,8px); font-size:13px; line-height:20px; box-shadow:none; }
@keyframes vdw-proposal-notice-appear { from { opacity:0; } to { opacity:1; } }
@media (prefers-reduced-motion:reduce) { .vdw-proposal-notice-card { animation:none; } }
`
