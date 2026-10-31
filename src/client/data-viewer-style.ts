export const dataViewerStyles = `
.vdw-result-details { display:flex; flex-direction:column; gap:12px; min-width:0; }
.vdw-result-summary { margin-bottom:12px; border:1px solid var(--vdw-border); border-radius:8px; background:var(--vdw-input-bg); overflow:hidden; }
.vdw-result-details > .vdw-result-summary { margin-bottom:0; }
.vdw-result-summary-top { display:flex; align-items:center; gap:10px; height:calc(var(--vdw-control-height,32px) - 2px); min-width:0; padding:0 10px; }
.vdw-result-summary-top > small { margin-left:auto; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.vdw-run-overview { display:flex; flex-direction:column; gap:12px; margin-bottom:12px; }
.vdw-run-overview > .vdw-result-summary { margin-bottom:0; }
.vdw-result-status { display:inline-flex; align-items:center; gap:6px; font-size:13px; line-height:20px; font-weight:500; }
.vdw-result-status[data-status=success] { color:var(--dsw-alias-state-success-primary); }
.vdw-result-status[data-status=failed] { color:var(--dsw-alias-state-error-primary); }
.vdw-result-status[data-status=running] { color:var(--vdw-accent); }
.vdw-result-duration { color:var(--vdw-secondary); font-size:12px; line-height:18px; font-variant-numeric:tabular-nums; }
.vdw-result-metadata { display:grid; grid-template-columns:auto minmax(0,1fr); gap:6px 12px; margin:0; padding:10px; border-top:1px solid var(--vdw-border); font-size:12px; line-height:18px; }
.vdw-result-metadata dt { color:var(--vdw-muted); }
.vdw-result-metadata dd { margin:0; overflow-wrap:anywhere; }
.vdw-result-metadata dd small { display:block; }
.vdw-result-error { padding:12px; border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 25%,transparent); border-radius:8px; background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 5%,var(--dsw-alias-bg-base)); color:var(--dsw-alias-state-error-primary); font-size:12px; line-height:20px; overflow-wrap:anywhere; }
.vdw-result-error strong { font-weight:500; }
.vdw-result-error p { margin-top:4px; white-space:pre-wrap; }
.vdw-data-viewer { min-width:0; overflow:hidden; border:1px solid var(--vdw-border); border-radius:8px; background:var(--vdw-input-bg); }
.vdw-data-toolbar { display:flex; align-items:center; gap:6px; min-height:34px; padding:3px 8px 3px 12px; border-bottom:1px solid var(--vdw-border); background:var(--dsw-alias-bg-base); }
.vdw-data-toolbar h4 { margin:0; min-width:0; overflow-wrap:anywhere; font-size:12px; line-height:18px; font-weight:600; }
.vdw-data-type { flex:none; color:var(--vdw-muted); font-family:var(--dsw-font-family-mono,monospace); font-size:12px; line-height:18px; }
.vdw-data-actions { display:flex; flex:none; align-items:center; gap:2px; margin-left:auto; }
.vdw-data-actions > button { width:28px; height:28px; padding:7px; color:var(--vdw-secondary); }
.vdw-data-modes { display:flex; padding:2px; border-radius:5px; background:var(--vdw-input-bg); }
.vdw-data-modes button { height:22px; padding:1px 6px; border:0; border-radius:4px; background:transparent; color:var(--vdw-muted); font-size:12px; line-height:18px; }
.vdw-data-modes button[aria-pressed=true] { background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); box-shadow:0 1px 2px rgb(0 0 0 / .06); }
.vdw-data-content { max-height:320px; overflow:auto; overscroll-behavior:auto; }
.vdw-data-text,.vdw-data-empty { padding:12px; font-size:13px; line-height:22px; white-space:pre-wrap; overflow-wrap:anywhere; }
.vdw-data-empty { color:var(--vdw-muted); }
.vdw-data-entries { min-width:0; padding:0 12px; }
.vdw-data-row { padding:8px 0; min-width:0; border-bottom:1px solid color-mix(in srgb,var(--vdw-border) 70%,transparent); }
.vdw-data-row:last-child { border-bottom:0; }
.vdw-data-key { display:flex; align-items:baseline; gap:8px; min-width:0; margin-bottom:3px; }
.vdw-data-key code { min-width:0; overflow-wrap:anywhere; font-family:var(--dsw-font-family-mono,monospace); font-size:12px; line-height:20px; font-weight:600; }
.vdw-data-value,.vdw-data-primitive { font-size:12px; line-height:20px; white-space:pre-wrap; overflow-wrap:anywhere; user-select:text; }
.vdw-data-string { font-family:var(--dsw-font-family); }
.vdw-data-number,.vdw-data-boolean { color:var(--vdw-accent); font-family:var(--dsw-font-family-mono,monospace); }
.vdw-data-null,.vdw-data-undefined { color:var(--vdw-muted); font-family:var(--dsw-font-family-mono,monospace); }
.vdw-data-fold { display:inline-flex; align-items:center; gap:4px; max-width:100%; padding:0 3px 0 0; border:0; background:transparent; color:var(--vdw-secondary); font-size:12px; line-height:20px; }
.vdw-data-nested > .vdw-data-entries { margin:4px 0; padding:0 0 0 12px; border-left:1px solid var(--vdw-border); }
.vdw-data-more { display:block; padding:4px 0; border:0; background:transparent; color:var(--vdw-accent); font-size:12px; line-height:20px; text-align:left; }
.vdw-data-precision-note { padding:8px 12px; font-size:12px; line-height:18px; color:var(--vdw-secondary); }
.vdw-data-limit { font-size:12px; color:var(--vdw-muted); }
.vdw-data-code { min-width:0; }
.vdw-data-source { display:flex; min-width:0; align-items:stretch; font-family:var(--dsw-font-family-mono,monospace); font-size:12px; line-height:20px; }
.vdw-data-line-numbers { display:flex; flex:none; flex-direction:column; position:sticky; left:0; min-width:34px; padding:10px 8px; border-right:1px solid var(--vdw-border); background:var(--vdw-input-bg); color:var(--vdw-muted); text-align:right; user-select:none; font-variant-numeric:tabular-nums; }
:is(.vdw,.vdw-modal) .vdw-data-source pre { flex:1; min-width:max-content; max-width:none; max-height:none; margin:0; padding:10px 12px; border:0; border-radius:0; background:transparent; overflow:visible; font-family:inherit; font-size:12px; line-height:20px; white-space:pre; }
.vdw-data-source code { font:inherit; }
.vdw-data-code > .vdw-data-more { padding:4px 12px; }
.vdw-data-feedback { display:block; padding:4px 12px; border-top:1px solid var(--vdw-border); }
.vdw-modal.vdw-data-modal { width:min(760px,calc(100vw - 32px)); }
.vdw-data-expanded { display:flex; flex-direction:column; height:100%; min-height:0; }
.vdw-data-expanded > .vdw-data-toolbar { flex:none; }
.vdw-data-expanded > .vdw-data-content { flex:1; max-height:none; min-height:0; }
.vdw-execution-details .vdw-result-details { padding:0 0 4px; }
.vdw-execution > button { gap:6px; padding:12px 0; }
.vdw-execution > button > .vdw-result-status { font-size:12px; line-height:18px; flex:none; }
.vdw-run-output { display:flex; flex-direction:column; gap:12px; }
.vdw-run-output > h3 { margin:16px 0 0; }
`
