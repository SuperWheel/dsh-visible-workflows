/** Uses the same opaque surface and prompt layers as the workflow inspector. */
export const workflowRequestDialogStyles=`
.vdw-modal.vdw-workflow-request-dialog { width:min(560px,calc(100vw - 32px)); max-height:calc(100dvh - 32px); min-height:0; padding:16px; overflow:auto; border:1px solid var(--vdw-border); border-radius:16px; background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#fff)); color:var(--dsw-alias-label-primary); }
.vdw-workflow-request-form { display:flex; flex-direction:column; gap:16px; min-width:0; min-height:0; }
.vdw-workflow-request-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; min-width:0; }
.vdw-workflow-request-heading h2 { margin:0; font-size:16px; line-height:24px; font-weight:600; }
.vdw-workflow-request-dialog .vdw-request-close { display:grid; place-items:center; flex:none; width:32px; min-width:32px; height:32px; min-height:32px; padding:8px; border:0; border-radius:8px; color:var(--vdw-secondary); background:transparent; }
.vdw-workflow-request-dialog .vdw-request-close:hover:not(:disabled) { background:var(--vdw-input-hover); }
.vdw-workflow-request-context { display:flex; align-items:center; gap:8px; min-width:0; font-size:13px; line-height:20px; }
.vdw-workflow-request-context>span:first-child:not(.vdw-workflow-request-target) { flex:none; color:var(--vdw-secondary); }
.vdw-workflow-request-target { display:inline-flex; align-items:center; gap:4px; max-width:100%; min-width:0; min-height:28px; padding:4px 8px; border:1px solid var(--vdw-border); border-radius:8px; background:var(--vdw-input-bg); color:var(--dsw-alias-label-primary); font-size:12px; line-height:18px; }
.vdw-workflow-request-target>span:last-child { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vdw-workflow-request-target:focus-visible { outline:2px solid var(--vdw-accent); outline-offset:2px; }
.vdw-workflow-request-dialog .vdw-workflow-request-editor { flex:none; margin:0; border:1px solid transparent; border-radius:8px; background:var(--vdw-input-bg); overflow:hidden; }
.vdw-workflow-request-dialog .vdw-workflow-request-editor:focus-within { border-color:color-mix(in srgb,var(--vdw-accent) 60%,transparent); }
.vdw-workflow-request-editor-heading { min-height:32px; padding:8px 12px 4px; gap:8px; }
.vdw-workflow-request-editor-heading>label { font-size:12px; line-height:20px; font-weight:500; color:var(--vdw-secondary); }
.vdw-workflow-request-editor-heading>small { flex:none; font-size:12px; line-height:20px; color:var(--vdw-muted); font-variant-numeric:tabular-nums; }
.vdw-workflow-request-dialog .vdw-workflow-request-editor .vdw-prompt-body { display:block; width:100%; min-height:176px; max-height:42dvh; margin:0; padding:4px 12px 12px; border:0; border-radius:0; resize:none; background:transparent; color:inherit; font-family:inherit; font-size:13px; line-height:22px; }
.vdw-workflow-request-dialog .vdw-workflow-request-editor .vdw-prompt-body:focus-visible { outline:none; }
.vdw-workflow-request-footer { display:flex; flex-direction:column; gap:8px; }
.vdw-workflow-request-footer>p { margin:0; color:var(--vdw-secondary); font-size:12px; line-height:20px; }
.vdw-workflow-request-footer>div { display:flex; align-items:center; justify-content:flex-end; gap:8px; }
.vdw-workflow-request-footer button { display:flex; align-items:center; justify-content:center; min-height:32px; height:32px; padding:0 12px; border-radius:8px; font-size:13px; line-height:20px; }
.vdw-workflow-request-dialog .vdw-workflow-request-error { margin:0; color:var(--dsw-alias-state-error-primary); font-size:12px; line-height:20px; overflow-wrap:anywhere; }
`
