/** Schema cards share the run viewer's hierarchy, without suggesting actual run values. */
export const variableBrowserStyles = `
.vdw-variables { min-width:0; padding-top:16px; border-top:.5px solid var(--dsw-alias-border-l2); font-size:12px; line-height:18px; }
.vdw-variables > summary { margin-bottom:12px; padding:4px 0; cursor:pointer; font-size:13px; line-height:20px; font-weight:500; }
.vdw-variables .vdw-variable-intro { margin:0 0 12px!important; color:var(--vdw-muted); font-size:12px; line-height:18px; overflow-wrap:anywhere; }
.vdw-variables .vdw-variable-cards { display:flex; flex-direction:column; gap:12px; min-width:0; }
.vdw-variables .vdw-variable-card { min-width:0; overflow:hidden; border:1px solid var(--vdw-border); border-radius:8px; background:var(--vdw-input-bg); }
.vdw-variables .vdw-variable-toolbar { display:flex; align-items:center; gap:8px; min-height:34px; padding:7px 12px; border-bottom:1px solid var(--vdw-border); background:var(--dsw-alias-bg-base); }
.vdw-variables .vdw-variable-toolbar h4 { flex:1; min-width:0; margin:0; color:var(--dsw-alias-label-primary); overflow-wrap:anywhere; font-size:12px; line-height:18px; font-weight:600; }
.vdw-variables .vdw-variable-count { flex:none; color:var(--vdw-muted); font-size:12px; line-height:18px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.vdw-variables .vdw-variable-content { min-width:0; background:var(--vdw-input-bg); }
.vdw-variables .vdw-variable-list { display:flex; flex-direction:column; gap:0; list-style:none; padding:0 12px; margin:0; }
.vdw-variables .vdw-variable-row { position:relative; min-width:0; padding:8px 0; border-bottom:1px solid color-mix(in srgb,var(--vdw-border) 70%,transparent); }
.vdw-variables .vdw-variable-row:last-child { border-bottom:0; }
.vdw-variables .vdw-variable-heading { display:flex; align-items:baseline; gap:8px; min-width:0; }
.vdw-variables .vdw-variable-heading code { min-width:0; margin:0; padding:0; border:0; background:transparent; color:var(--dsw-alias-label-primary); overflow-wrap:anywhere; font-family:var(--dsw-font-family-mono,monospace); font-size:12px; line-height:20px; font-weight:600; }
.vdw-variables .vdw-variable-type { flex:none; color:var(--vdw-muted); font-family:var(--dsw-font-family-mono,monospace); font-size:12px; line-height:18px; }
.vdw-variables .vdw-variable-copy { display:inline-flex; align-items:center; justify-content:center; align-self:center; flex:none; width:24px; min-width:24px; height:24px; padding:5px!important; margin-left:auto; border:0; border-radius:5px; background:transparent; color:var(--vdw-secondary); }
.vdw-variables .vdw-variable-copy:hover { background:var(--vdw-input-hover); color:var(--vdw-accent); }
.vdw-variables .vdw-variable-description { margin:0!important; color:var(--vdw-secondary); font-size:12px; line-height:20px; overflow-wrap:anywhere; }
.vdw-variables .vdw-variable-empty { margin:0; padding:12px; color:var(--vdw-muted); font-size:12px; line-height:20px; overflow-wrap:anywhere; }
.vdw-variables .vdw-variable-reference { display:block; margin-top:4px; padding:4px 6px; border:1px solid var(--vdw-border); border-radius:4px; background:var(--dsw-alias-bg-base); color:var(--vdw-secondary); overflow-wrap:anywhere; font-family:var(--dsw-font-family-mono,monospace); font-size:12px; line-height:18px; user-select:all; }
.vdw-variables .vdw-variable-status { display:block; margin-top:4px; color:var(--vdw-secondary); font-size:12px; line-height:18px; }
`
