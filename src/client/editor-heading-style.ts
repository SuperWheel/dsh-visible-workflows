import { workflowManagementStyles } from './workflow-management-style.ts'
/** Only the workflow canvas floating heading uses these layout overrides. */
export const editorHeadingStyles = `
.vdw .vdw-editor-heading.vdw-editor-heading-floating { position:absolute; inset:12px auto auto 12px; display:flex; flex-direction:column; align-items:stretch; gap:6px; width:max-content; min-width:0; max-width:min(var(--vdw-heading-max-width,348px),calc(100% - 24px)); min-height:0; margin:0; padding:0; border:0; background:transparent; z-index:6; pointer-events:none; }
.vdw-editor-heading-floating .vdw-editor-heading-row { display:flex; align-items:center; gap:8px; min-width:0; }
.vdw-editor-heading-floating :is(.vdw-editor-back,.vdw-editor-conversation) { display:grid; place-items:center; flex:none; width:var(--vdw-floating-height); min-width:var(--vdw-floating-height); height:var(--vdw-floating-height); min-height:var(--vdw-floating-height); margin:0; padding:10px; border:1px solid var(--vdw-border); border-radius:var(--vdw-floating-radius); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); box-shadow:var(--vdw-floating-shadow); pointer-events:auto; }
.vdw-editor-heading-floating :is(.vdw-editor-back,.vdw-editor-conversation):hover:not(:disabled) { background:var(--vdw-input-hover); }
.vdw-editor-heading-floating .vdw-editor-title-card { display:flex; flex:1 1 auto; flex-direction:row; align-items:center; gap:6px; min-width:0; max-width:300px; height:var(--vdw-floating-height); min-height:var(--vdw-floating-height); padding:4px 12px; border:1px solid var(--vdw-border); border-radius:var(--vdw-floating-radius); background:var(--dsw-alias-bg-base); box-shadow:var(--vdw-floating-shadow); pointer-events:auto; }
.vdw-editor-heading-floating .vdw-editor-name { display:block; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-primary); font-size:13px; line-height:20px; font-weight:600; }
.vdw-editor-heading-floating .vdw-editor-status-indicator { display:grid; place-items:center; flex:none; width:16px; height:20px; border-radius:4px; }
.vdw-editor-heading-floating .vdw-editor-status-indicator:focus-visible { outline:2px solid var(--vdw-accent); outline-offset:2px; }
.vdw-editor-heading-floating .vdw-editor-status-dot { display:block; width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-success-primary); }
.vdw-editor-heading-floating .vdw-editor-status-dot[data-state=saving] { background:var(--dsw-alias-button-info-fill); }
.vdw-editor-heading-floating .vdw-editor-status-dot[data-state=error] { background:var(--dsw-alias-state-error-primary); }
.vdw-editor-heading-floating .vdw-editor-status-dot[data-state=dirty] { background:var(--dsw-alias-label-tertiary); }
.vdw-editor-heading-floating .vdw-editor-save-actions { display:flex; align-items:center; flex:none; gap:2px; height:var(--vdw-floating-height); min-height:var(--vdw-floating-height); padding:var(--vdw-floating-padding); border:1px solid var(--vdw-border); border-radius:var(--vdw-floating-radius); background:var(--dsw-alias-bg-base); box-shadow:var(--vdw-floating-shadow); pointer-events:auto; }
.vdw-editor-heading-floating .vdw-editor-save { display:grid; place-items:center; flex:none; width:var(--vdw-control-height); min-width:var(--vdw-control-height); height:var(--vdw-control-height); min-height:var(--vdw-control-height); padding:8px; background:transparent; border:0; border-radius:var(--vdw-radius-control); box-shadow:none; }
.vdw-editor-heading-floating .vdw-editor-save:hover:not(:disabled) { background:var(--vdw-input-hover); }
.vdw-save-spinner { display:flex; animation:vdw-save-spin .85s linear infinite; }
.vdw-save-feedback { position:absolute; left:0; top:calc(100% + 8px); display:flex; align-items:center; gap:4px; min-height:28px; padding:4px 8px; white-space:nowrap; font-size:12px; line-height:20px; color:var(--dsw-alias-label-secondary); border:1px solid var(--vdw-border); border-radius:var(--vdw-floating-radius); background:var(--dsw-alias-bg-base); box-shadow:var(--vdw-floating-shadow); }
.vdw-save-feedback[data-state=saved] { animation:vdw-saved-fade 3s forwards; }
@keyframes vdw-save-spin { to { transform:rotate(360deg); } }
@keyframes vdw-saved-fade { 0%,75% { opacity:1; } 100% { opacity:0; visibility:hidden; } }
@media (prefers-reduced-motion:reduce) { .vdw-save-spinner { animation:none; } }
.vdw .vdw-editor-heading-floating .vdw-editor-save-state { position:absolute; display:block; width:1px; height:1px; min-width:0; min-height:0; margin:-1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; pointer-events:none; }
.vdw-editor-heading-floating .vdw-editor-heading-path { display:flex; min-width:0; max-width:100%; pointer-events:auto; }
.vdw-editor-heading-floating .vdw-scope-breadcrumb { flex:1; min-width:0; max-width:100%; min-height:28px; padding:2px 6px; gap:2px; border:1px solid var(--vdw-border); border-radius:var(--vdw-floating-radius); background:var(--dsw-alias-bg-base); box-shadow:var(--vdw-floating-shadow); font-size:11px; line-height:18px; }
.vdw-editor-heading-floating .vdw-scope-breadcrumb button { flex:none; max-width:148px; height:24px; min-height:24px; padding:2px 5px; font-size:11px; line-height:18px; }
.vdw-editor-heading-floating .vdw-scope-breadcrumb > small { font-size:10px; line-height:16px; padding-left:6px; }
@container workflow (max-width:360px) { .vdw .vdw-editor-heading.vdw-editor-heading-floating { inset-inline-start:8px; max-width:min(var(--vdw-heading-max-width,348px),calc(100% - 16px)); } .vdw-editor-heading-floating .vdw-editor-heading-row { gap:6px; } .vdw-editor-heading-floating .vdw-editor-title-card { padding-inline:10px; } }
${workflowManagementStyles}
`
