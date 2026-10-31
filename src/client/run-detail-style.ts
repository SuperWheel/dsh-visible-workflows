/** DESIGN.md §§13, 22: readable run cards, 32px controls and shared surface tokens. */
export const runDetailStyles = `
.vdw-file-evidence { display:flex; flex-direction:column; gap:var(--vdw-space-card,12px); min-width:0; max-width:100%; font-size:13px; line-height:20px; }
.vdw-file-evidence > strong { font-size:13px; line-height:20px; font-weight:500; }
.vdw-file-evidence > .vdw-file-evidence-card { margin:0; gap:var(--vdw-space-inner,8px); }
.vdw-file-evidence-card > div { display:grid; gap:4px; min-width:0; }
.vdw-file-evidence :is(p,small,code),.vdw-result-details > .vdw-muted { min-width:0; overflow-wrap:anywhere; }
.vdw-file-evidence-path { font-family:var(--dsw-font-family-mono,monospace); font-size:12px; line-height:20px; white-space:pre-wrap; }

.vdw-agent-actions,.vdw-agent-actions > .vdw-config-group,.vdw-agent-events,.vdw-agent-event { min-width:0; max-width:100%; }
.vdw-agent-actions { font-size:13px; line-height:20px; }
.vdw-agent-actions > .vdw-config-group,.vdw-agent-actions .vdw-field { margin:0; }
.vdw-agent-actions :is(p,small,strong,code,summary) { overflow-wrap:anywhere; }
.vdw-agent-actions code { font-size:12px; line-height:20px; }
.vdw-agent-actions > .vdw-actions,.vdw-agent-actions > .vdw-config-group > .vdw-actions { gap:var(--vdw-space-inner,8px); min-width:0; }
.vdw-agent-actions > .vdw-actions > button,
.vdw-agent-actions > .vdw-config-group > .vdw-actions > button,
.vdw-agent-actions > .vdw-config-group > button {
  flex:none; align-self:flex-start; min-width:0; max-width:100%; min-height:var(--vdw-control-height,32px); height:auto;
  padding:5px 12px; border:1px solid var(--vdw-border); border-radius:var(--vdw-radius-control,8px);
  box-shadow:var(--vdw-floating-shadow); font-size:13px; line-height:20px; white-space:normal; overflow-wrap:anywhere;
}
/* The repair editor's final direct action is its native primary confirmation.
   Restore SDK theme tokens after the generic config-group button surface. */
.vdw-config-body .vdw-agent-actions > .vdw-config-group[aria-label="Agent 输出修正"] > button:last-of-type {
  background:var(--dsw-alias-button-primary-fill); color:var(--dsw-alias-label-primary-foreground);
}
.vdw-config-body .vdw-agent-actions > .vdw-config-group[aria-label="Agent 输出修正"] > button:last-of-type:hover:not(:disabled) {
  background:var(--dsw-alias-button-primary-hover);
}
`
