/** Insets affect branch chrome only; ports retain their existing 32px pitch. */
export const nodeBranchesStyles = `
.vdw-node-branches { position:absolute; left:12px; right:12px; }
.vdw-node-branches > .vdw-node-branch-row { position:relative; display:flex; align-items:center; height:32px; min-width:0; padding:2px 0; border:0; }
.vdw-node-branches > .vdw-node-branch-row::after { content:''; position:absolute; right:-12px; top:50%; width:10px; border-top:1px solid var(--vdw-border); pointer-events:none; }
.vdw-node-branches .vdw-node-branch-content { display:flex; align-items:center; justify-content:flex-end; gap:8px; width:100%; height:28px; min-width:0; padding:0 8px; border-radius:6px; background:var(--vdw-input-bg); }
.vdw-node-branches .vdw-node-branch-label { flex:0 0 auto; min-width:0; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:right; color:var(--dsw-alias-label-primary); font-size:12px; line-height:18px; font-weight:600; }
.vdw-node-branches .has-summary > .vdw-node-branch-label { max-width:50%; }
.vdw-node-branches[data-kind=if] .vdw-node-branch-label { font-family:var(--dsw-font-family-mono,monospace); font-size:11px; }
.vdw-node-branches .vdw-node-branch-summary { flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:right; color:var(--vdw-secondary); font-size:11px; line-height:18px; }
`
