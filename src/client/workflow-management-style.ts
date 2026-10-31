/** Absolute details and feedback do not affect the measured canvas navigation. */
export const workflowManagementStyles=`
.vdw .vdw-editor-heading.vdw-editor-heading-floating[data-management-open=true] { z-index:10; }
.vdw-editor-title-card[data-management=true] { padding:0; overflow:hidden; }
.vdw-editor-title-card .vdw-editor-title-trigger { display:flex; align-items:center; gap:6px; width:100%; min-width:0; height:100%; min-height:0; padding:4px 12px; border:0; border-radius:inherit; color:inherit; background:transparent; text-align:left; }
.vdw-editor-title-card .vdw-editor-title-trigger:hover:not(:disabled),.vdw-editor-title-card .vdw-editor-title-trigger[aria-expanded=true] { background:var(--vdw-input-hover); }
.vdw-workflow-management-stack { position:absolute; left:0; top:calc(100% + 8px); display:flex; flex-direction:column; gap:8px; width:min(360px,calc(100cqw - 24px)); max-height:min(640px,calc(100dvh - 128px)); min-height:0; pointer-events:auto; }
.vdw-workflow-management { flex:1 1 auto; min-height:0; padding:12px; overflow:auto; overscroll-behavior:contain; border:1px solid var(--vdw-border); border-radius:12px; background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#fff)); color:var(--dsw-alias-label-primary); box-shadow:var(--dsw-elevation-prominent); font-size:13px; line-height:20px; }
.vdw-workflow-management-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; margin-bottom:var(--vdw-space-field,16px); }
.vdw-workflow-management-heading>div { display:flex; flex-direction:column; gap:8px; min-width:0; }
.vdw-workflow-management-heading strong { font-size:14px; line-height:22px; font-weight:600; overflow-wrap:anywhere; white-space:normal; }
.vdw-workflow-management .vdw-management-icon { display:grid; place-items:center; flex:none; width:32px; min-width:32px; height:32px; min-height:32px; padding:8px; border:0; border-radius:8px; background:transparent; color:inherit; }
.vdw-workflow-management .vdw-management-icon:hover:not(:disabled) { background:var(--vdw-input-hover); }
.vdw-workflow-management-form { display:flex; flex-direction:column; gap:var(--vdw-space-field,16px); min-width:0; }
.vdw-management-primary-fields { display:grid; grid-template-columns:minmax(0,1fr); gap:var(--vdw-space-field,16px); min-width:0; }
.vdw-management-field { display:flex; flex-direction:column; gap:var(--vdw-space-inner,8px); min-width:0; }
.vdw-management-field>label,.vdw-management-field-label>label { font-weight:500; }
.vdw-management-field-label { display:flex; align-items:center; gap:8px; min-height:20px; }
.vdw-workflow-management .vdw-management-scope-help,.vdw-workflow-management .vdw-management-scope-help:is(:hover,:active,:focus) { animation:none; transition:none; transform:none; translate:none; box-shadow:none; background:transparent; }
.vdw-management-help-bubble { box-sizing:border-box; position:fixed; z-index:1100; width:max-content; padding:3px 7px; border-radius:var(--dsw-radius-sm,8px); background:var(--dsw-alias-tooltip-bg); color:var(--dsw-static-neutral-bluish-00); font-family:var(--dsw-font-family); font-size:13px; line-height:20px; white-space:pre-line; overflow-wrap:break-word; pointer-events:none; animation:vdw-management-help-in 150ms var(--ds-ease-in-out,ease-in-out); }
@keyframes vdw-management-help-in { from { opacity:0; } }
@media (prefers-reduced-motion:reduce) { .vdw-management-help-bubble { animation:none; } }
.vdw-management-identity { display:flex; align-items:center; gap:8px; min-width:0; min-height:32px; }
.vdw-management-identity>code { flex:1; min-width:0; user-select:text; overflow-wrap:anywhere; font-size:12px; line-height:20px; }
.vdw-workflow-management .vdw-management-field>span:has(>input) { display:flex; align-items:center; width:100%; min-width:0; height:32px; min-height:32px; padding:0 10px; border:1px solid transparent; border-radius:8px; background:var(--vdw-input-bg); }
.vdw-workflow-management .vdw-management-field input { min-width:0; width:100%; height:100%; font-size:13px; line-height:20px; }
.vdw-workflow-management .vdw-management-field>textarea { display:block; width:100%; min-height:80px; padding:8px 10px; border:1px solid transparent; border-radius:8px; resize:none; color:inherit; background:var(--vdw-input-bg); font-size:13px; line-height:22px; }
.vdw-workflow-management .vdw-management-field>.vdw-select,.vdw-workflow-management .vdw-management-field .vdw-select-trigger { width:100%; min-width:0; }
.vdw-workflow-management .vdw-management-field .vdw-select-trigger { height:32px; min-height:32px; }
.vdw-workflow-management .vdw-management-field>small { font-size:12px; line-height:20px; color:var(--vdw-secondary); }
/* One bounded label/value card keeps each fact attached to its value. */
.vdw-workflow-management-facts { display:flex; flex-direction:column; gap:0; margin:0; border:1px solid var(--vdw-border); border-radius:8px; overflow:hidden; background:var(--dsw-alias-bg-base); box-shadow:0 1px 2px rgb(0 0 0 / .04),0 3px 8px rgb(0 0 0 / .03); }
.vdw-workflow-management-facts>div { display:grid; grid-template-columns:88px minmax(0,1fr); align-items:start; gap:12px; min-width:0; padding:8px 12px; }
.vdw-workflow-management-facts>div+div { border-top:1px solid var(--vdw-border); }
.vdw-workflow-management-facts dt { color:var(--vdw-secondary); font-size:12px; line-height:20px; }
.vdw-workflow-management-facts dd { min-width:0; margin:0; text-align:right; overflow-wrap:anywhere; font-variant-numeric:tabular-nums; }
.vdw-management-save-actions,.vdw-workflow-management-actions { display:flex; align-items:center; gap:8px; }
.vdw-management-save-actions { justify-content:flex-end; }
.vdw-workflow-management-actions { margin-top:16px; padding-top:12px; border-top:1px solid var(--vdw-border); }
.vdw-workflow-management :is(.vdw-management-save-actions,.vdw-workflow-management-actions)>button { display:flex; align-items:center; justify-content:center; gap:8px; min-width:0; height:32px; min-height:32px; padding:0 12px; border-radius:8px; font-size:13px; line-height:20px; }
.vdw-workflow-management-actions>button { flex:1; box-shadow:0 1px 2px rgb(0 0 0 / .04),0 3px 8px rgb(0 0 0 / .03); }
.vdw-workflow-management .vdw-management-error { margin:0; color:var(--dsw-alias-state-error-primary); font-size:12px; line-height:20px; overflow-wrap:anywhere; }
.vdw-workflow-management-stack>.vdw-save-feedback { position:static; align-self:flex-start; flex:none; }
.vdw-modal.vdw-workflow-management.vdw-home-workflow-management { display:block; flex:0 1 auto; width:min(600px,calc(100vw - 32px)); max-height:calc(100dvh - 32px); min-height:0; padding:16px; overflow:auto; border-radius:16px; }
.vdw-home-workflow-management .vdw-management-primary-fields { grid-template-columns:minmax(0,3fr) minmax(0,2fr); }
@media (max-width:480px) { .vdw-home-workflow-management .vdw-management-primary-fields { grid-template-columns:minmax(0,1fr); } }
.vdw-workflow-management .vdw-management-saved { color:var(--vdw-secondary); font-size:12px; line-height:20px; }
@container workflow (max-width:360px) { .vdw-editor-title-card .vdw-editor-title-trigger { padding-inline:10px; } }
`
