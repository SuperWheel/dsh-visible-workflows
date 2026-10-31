/** Keep both toolbar widths measurable without hiding primary execution or wrapping controls. */
export const canvasTopActionsStyles = `
.vdw-canvas-top-actions .vdw-selection-actions { flex:none; width:max-content; max-width:none; white-space:nowrap; }
.vdw-canvas-top-actions .vdw-execution-actions { position:relative; flex:none; flex-wrap:nowrap; width:max-content; padding-inline:4px; }
.vdw-canvas-top-actions .vdw-agent-action { flex:none; width:max-content; }
.vdw-canvas-top-actions .vdw-variable-actions { position:relative; flex:none; flex-wrap:nowrap; width:max-content; }
.vdw-canvas-top-actions .vdw-variable-actions .vdw-icon-button,.vdw-canvas-top-actions .vdw-policy-action { width:var(--vdw-control-height); min-width:var(--vdw-control-height); height:var(--vdw-control-height); min-height:var(--vdw-control-height); padding:8px!important; }
.vdw-canvas-top-actions .vdw-variable-actions [aria-pressed=true] { color:var(--vdw-accent); background:color-mix(in srgb,var(--vdw-accent) 10%,transparent); }
.vdw-canvas-top-actions .vdw-canvas-overflow { display:inline-flex; flex:none; width:var(--vdw-control-height); min-width:var(--vdw-control-height); height:var(--vdw-control-height); }
.vdw-canvas-top-actions .vdw-canvas-overflow-trigger { width:var(--vdw-control-height); min-width:var(--vdw-control-height); height:var(--vdw-control-height); min-height:var(--vdw-control-height); padding:8px!important; }
.vdw-canvas-top-actions .vdw-primary-execution { display:inline-flex; align-items:center; flex:none; gap:2px; min-width:0; color:inherit; text-align:initial; }
.vdw-canvas-top-actions .vdw-primary-execution > button { flex:none; min-height:28px; height:28px; padding:0 8px; border-radius:8px; font-size:12px; line-height:18px; gap:4px; }
.vdw-canvas-top-actions .vdw-primary-execution > button svg { flex:none; width:16px; height:16px; }
.vdw-canvas-top-actions :is(.vdw-annotation-action,.vdw-agent-action,.vdw-primary-execution > button) { min-width:0; overflow:hidden; }
.vdw-canvas-top-actions :is(.vdw-control-label,.vdw-selection-count) { flex:none; width:max-content; white-space:nowrap; opacity:1; }
.vdw-canvas-top-actions.is-icon-only :is(.vdw-control-label,.vdw-selection-count) { position:absolute; opacity:0; width:max-content; white-space:nowrap; pointer-events:none; }
.vdw-canvas-top-actions.is-icon-only :is(.vdw-annotation-action,.vdw-agent-action,.vdw-primary-execution > button) { position:relative; width:var(--vdw-control-height); min-width:var(--vdw-control-height); height:var(--vdw-control-height); min-height:var(--vdw-control-height); padding:8px!important; gap:0; }
.vdw-canvas-top-actions.is-icon-only .vdw-primary-execution > button { width:28px; min-width:28px; height:28px; min-height:28px; padding:6px!important; }
.vdw-canvas-top-actions :is(.vdw-selection-actions,.vdw-agent-action,.vdw-policy-action,.vdw-canvas-overflow).is-concealed { position:absolute; visibility:hidden; pointer-events:none; }
`
