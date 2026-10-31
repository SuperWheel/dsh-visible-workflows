/** Proposal review uses the same spacing and card contract as the node menus. */
export const proposalReviewStyles = `
.vdw-modal.vdw-proposal-review { display:flex; flex-direction:column; width:min(560px,calc(100vw - 32px)); min-height:0; max-height:100%; gap:var(--vdw-space-field); padding:var(--vdw-space-field); overflow:hidden; border:1px solid var(--vdw-border); border-radius:16px; background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base)); }
.vdw-proposal-review-heading { display:flex; flex:none; align-items:center; justify-content:space-between; gap:var(--vdw-space-inner); min-width:0; }
.vdw-proposal-review-heading h2 { min-width:0; margin:0; font-size:16px; line-height:24px; font-weight:600; overflow-wrap:anywhere; }
.vdw-proposal-review .vdw-proposal-review-close { display:grid; place-items:center; flex:none; width:var(--vdw-control-height); min-width:var(--vdw-control-height); height:var(--vdw-control-height); min-height:var(--vdw-control-height); padding:8px; border:0; border-radius:var(--vdw-radius-control); background:transparent; color:var(--vdw-secondary); }
.vdw-proposal-review .vdw-proposal-review-close:hover:not(:disabled) { background:var(--vdw-input-hover); }
.vdw-proposal-review-body { display:flex; flex-direction:column; gap:var(--vdw-space-field); min-width:0; min-height:0; overflow:auto; overscroll-behavior:contain; font-size:13px; line-height:22px; }
.vdw-proposal-review-body > * { flex:none; min-width:0; }
.vdw-proposal-review .vdw-proposal-review-intro { display:flex; flex-direction:column; gap:var(--vdw-space-inner); overflow-wrap:anywhere; }
.vdw-proposal-review .vdw-muted { margin:0; font-size:12px; line-height:18px; }
.vdw-proposal-review .vdw-json-summary { gap:var(--vdw-space-inner); padding:var(--vdw-space-card); border-radius:var(--vdw-radius-control); background:var(--dsw-alias-bg-base); box-shadow:0 1px 2px rgb(0 0 0 / .04),0 3px 8px rgb(0 0 0 / .03); font-size:13px; line-height:20px; }
.vdw-proposal-review .vdw-json-summary > strong,.vdw-proposal-review .vdw-proposal-change > h3 { margin:0; font-size:13px; line-height:20px; font-weight:500; }
.vdw-proposal-review .vdw-proposal-change { display:flex; flex-direction:column; gap:var(--vdw-space-inner); min-width:0; margin:0; }
.vdw-proposal-review-stack { display:flex; flex-direction:column; gap:var(--vdw-space-card); min-width:0; }
.vdw-proposal-review-stack > * { flex:none; min-width:0; margin:0; }
.vdw-proposal-review .vdw-data-viewer { box-shadow:0 1px 2px rgb(0 0 0 / .04),0 3px 8px rgb(0 0 0 / .03); }
.vdw-proposal-review-definitions > summary { width:fit-content; min-height:var(--vdw-control-height); padding:4px 8px; border-radius:var(--vdw-radius-control); color:var(--vdw-secondary); font-size:13px; line-height:24px; cursor:pointer; }
.vdw-proposal-review-definitions > summary:hover { background:var(--vdw-input-hover); }
.vdw-proposal-review-definitions > .vdw-proposal-review-stack { margin-top:var(--vdw-space-card); }
.vdw-proposal-review-footer { display:flex; flex:none; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:var(--vdw-space-inner); }
.vdw-proposal-review-footer > button,.vdw-proposal-review-tabs > button { flex:none; height:var(--vdw-control-height); min-height:var(--vdw-control-height); padding:0 12px; border-radius:var(--vdw-radius-control); font-size:13px; line-height:20px; }
.vdw-proposal-review-tabs { display:flex; flex-wrap:wrap; gap:var(--vdw-space-inner); }
.vdw-proposal-review-tabs > button[aria-pressed=true] { background:var(--vdw-input-bg); color:var(--dsw-alias-label-primary); }
`
