/** DESIGN.md sections 10–11: 32px controls, 13/20 text, 12px cards and 8/16px form spacing. */
export const runRecoveryStyles = `
.vdw-run-governance { display:flex; flex-direction:column; gap:12px; margin-bottom:12px; min-width:0; }
.vdw-run-provenance,.vdw-run-revision-actions { display:grid; gap:8px; min-width:0; }
.vdw-run-provenance p,.vdw-run-ledger .vdw-run-ledger-note { margin:0; }
.vdw-run-provenance code { font-size:inherit; overflow-wrap:anywhere; }
.vdw-run-governance .vdw-run-ledger { margin:0; padding:12px; gap:12px; }
.vdw-run-ledger-title { font-size:13px; line-height:20px; font-weight:500; }
.vdw-usage-ledger { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,auto); gap:8px 12px; margin:0; font-size:12px; line-height:18px; }
.vdw-usage-ledger dt { color:var(--vdw-secondary); }
.vdw-usage-ledger dd { margin:0; text-align:right; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
.vdw-run-revision-actions > button { justify-self:start; }
.vdw-run-actions { gap:8px; margin:0; }
:is(.vdw-run-actions,.vdw-run-revision-actions) button { min-height:32px; font-size:13px; line-height:20px; }

.vdw-recovery-content { display:flex; flex-direction:column; gap:16px; font-size:13px; line-height:20px; }
.vdw-recovery-content .vdw-muted,.vdw-recovery-content .vdw-config-group { margin:0; }
.vdw-recovery-content strong { font-size:13px; line-height:20px; font-weight:500; }
.vdw-recovery-source { display:grid; gap:4px; }
.vdw-recovery-source code,.vdw-recovery-items small { overflow-wrap:anywhere; }
.vdw-recovery-source code { font-size:inherit; }
.vdw-recovery-description { font-size:12px; line-height:18px; color:var(--vdw-secondary); }
.vdw-recovery-plan { display:flex; flex-direction:column; gap:12px; min-width:0; padding:12px; border:1px solid var(--vdw-border); border-radius:var(--vdw-radius-control); background:var(--vdw-input-bg); }
.vdw-recovery-items { display:flex; flex-direction:column; gap:12px; max-height:min(30vh,280px); overflow:auto; overscroll-behavior:contain; }
.vdw-recovery-items > .vdw-config-group { flex:none; box-shadow:none; }
.vdw-recovery-items p { font-size:12px; line-height:18px; color:var(--vdw-secondary); overflow-wrap:anywhere; }
.vdw-recovery-action { flex:none; padding:0 8px; border:1px solid var(--vdw-border); border-radius:4px; background:var(--vdw-input-bg); font-size:12px; line-height:20px; white-space:nowrap; }
.vdw-recovery-action[data-recovery-action=reuse] { color:var(--dsw-alias-state-success-primary); }
.vdw-recovery-review { display:flex; flex-direction:column; gap:12px; }
.vdw-recovery-section-heading { display:grid; gap:8px; }
.vdw-recovery-review-card { gap:16px; }
.vdw-recovery-select { position:relative; min-width:0; }
.vdw-recovery-select select { appearance:none; width:100%; min-width:0; height:32px; padding:0 32px 0 12px; border:1px solid transparent; border-radius:var(--vdw-radius-control); background:var(--vdw-input-bg); color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; line-height:20px; cursor:pointer; }
.vdw-recovery-select select:hover:not(:disabled) { background:var(--vdw-input-hover); }
.vdw-recovery-select select:focus-visible { outline:2px solid var(--vdw-accent); outline-offset:2px; }
.vdw-recovery-select select:disabled { opacity:.5; cursor:not-allowed; }
.vdw-recovery-select select:has(option[value=""]:checked) { color:var(--vdw-muted); }
.vdw-recovery-select option { background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); }
.vdw-recovery-select > svg { position:absolute; right:10px; top:8px; width:16px; height:16px; color:var(--vdw-secondary); pointer-events:none; }
.vdw-recovery-checks { display:grid; gap:12px; }
.vdw-recovery-actions { flex-wrap:nowrap; gap:8px; }
.vdw-recovery-actions > button { flex:none; height:32px; padding-inline:12px; font-size:13px; line-height:20px; }
.vdw-run-actions button,.vdw-recovery-actions > button,.vdw-recovery-modal > div:last-child:not(:first-child) > button { box-shadow:var(--vdw-floating-shadow); }
.vdw-recovery-feedback,.vdw-recovery-blocked { display:grid; gap:4px; padding:12px; border:1px solid var(--vdw-border); border-radius:var(--vdw-radius-control); background:var(--vdw-input-bg); }
.vdw-recovery-feedback p { font-size:12px; line-height:18px; color:var(--vdw-secondary); }
.vdw-recovery-feedback[data-review-status=passed] { border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,var(--vdw-border)); }
.vdw-recovery-feedback[data-review-status=passed] strong { color:var(--dsw-alias-state-success-primary); }
.vdw-recovery-feedback:is([data-review-status=blocked],[data-review-status=error]) strong,.vdw-recovery-blocked strong { color:var(--dsw-alias-state-error-primary); }
.vdw-recovery-blocked ul { margin:4px 0 0; padding-left:20px; font-size:12px; line-height:18px; overflow-wrap:anywhere; }
`
