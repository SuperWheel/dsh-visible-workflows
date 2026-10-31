/** Keep scrolling separate from intrinsic form sizing, so opening a draft never compresses controls. */
export const advancedSettingsStyles = `
.vdw-advanced-settings { user-select:text; }
.vdw-advanced-settings .vdw-picker-tabs { min-width:0; overflow-x:auto; }
.vdw-advanced-settings .vdw-picker-tabs > button { flex:none; }
.vdw-advanced-content { display:block; flex:1; min-height:0; overflow:auto; padding:16px; overscroll-behavior:contain; scroll-padding-block:16px; }
.vdw-advanced-content[hidden] { display:none; }
.vdw-advanced-content .vdw-variable-panel.is-embedded { position:static; inset:auto; flex:none; width:100%; min-width:0; border:0; border-radius:0; box-shadow:none; overflow:visible; }
.vdw-advanced-content .vdw-variable-panel.is-embedded .vdw-config-body { flex:none; overflow:visible; padding:0; }

.vdw-variable-panel .vdw-config-body > * { flex-shrink:0; }
.vdw-variable-panel .vdw-variable-panel-search { display:flex; flex:none; width:100%; height:var(--vdw-control-height,32px); min-height:var(--vdw-control-height,32px); padding-inline:10px; border:1px solid transparent; border-radius:var(--vdw-radius-control,8px); background:var(--vdw-input-bg); }
.vdw-variable-panel .vdw-variable-panel-search:focus-within { border-color:var(--vdw-accent); }
.vdw-variable-panel-search > input { width:100%; min-width:0; height:100%; font-size:13px; line-height:20px; background:transparent; }
.vdw-variable-panel .vdw-variable-panel-add { flex:none; height:var(--vdw-control-height,32px); min-height:var(--vdw-control-height,32px); font-size:13px; line-height:20px; }
.vdw-variable-panel .vdw-environment-editor { gap:12px; margin:0; padding:12px; }
.vdw-environment-editor > .vdw-field { gap:8px; margin:0; }
.vdw-environment-editor > .vdw-check-field { min-height:20px; }
.vdw-variable-panel .vdw-environment-editor textarea { min-height:88px; resize:none; }
.vdw-environment-type-options { display:flex; gap:8px; }
.vdw-environment-type-options > button { flex:1; min-width:0; display:flex; align-items:center; justify-content:center; gap:4px; height:var(--vdw-control-height,32px); min-height:var(--vdw-control-height,32px); padding:0 8px; border:1px solid var(--vdw-border); border-radius:8px; background:var(--vdw-input-bg); color:var(--vdw-secondary); font:inherit; font-size:13px; line-height:20px; }
.vdw-environment-type-options > button:hover { background:var(--dsw-alias-interactive-bg-hover); }
.vdw-environment-type-options > button[aria-checked=true] { color:var(--vdw-accent); border-color:var(--vdw-accent); background:color-mix(in srgb,var(--vdw-accent) 8%,var(--dsw-alias-bg-base)); }
.vdw-environment-type-options > button:focus-visible { outline:2px solid var(--vdw-accent); outline-offset:2px; }

.vdw-variable-panel-list .vdw-variable-card { flex:none; background:var(--vdw-input-bg); }
.vdw-variable-panel-list .vdw-variable-toolbar { min-height:34px; padding:4px 12px; background:var(--dsw-alias-bg-base); }
.vdw-variable-panel-list .vdw-variable-toolbar > :first-child { font-size:12px; line-height:20px; font-weight:600; }
.vdw-variable-panel-list .vdw-variable-toolbar .vdw-icon-button { width:24px; min-width:24px; height:24px; padding:5px!important; border-radius:5px; }
.vdw-variable-panel .vdw-variable-panel-content { gap:8px; padding:8px 12px; font-size:12px; line-height:20px; }
.vdw-variable-panel .vdw-variable-current-value { padding:6px 8px; background:var(--dsw-alias-bg-base); font-size:12px; line-height:20px; }
.vdw-secret-status { flex:none; padding:12px; border:1px solid var(--vdw-border); border-radius:8px; }
.vdw-secret-status > summary { cursor:pointer; color:var(--vdw-secondary); font-size:13px; line-height:20px; }
.vdw-secret-status > .vdw-config-group { margin:12px 0 0; }

.vdw-execution-policy-panel { width:100%; display:flex; flex-direction:column; gap:16px; }
.vdw-execution-policy-panel > * { flex-shrink:0; }
.vdw-execution-policy-panel .vdw-policy-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px 12px; }
.vdw-execution-policy-panel .vdw-policy-actions > button { height:32px; min-height:32px; }
.vdw-execution-policy-panel .vdw-policy-fields > .vdw-field { gap:8px; margin:0; }
.vdw-execution-policy-panel .vdw-policy-actions > button { height:32px; min-height:32px; }
.vdw-execution-policy-panel .vdw-policy-fields > .vdw-field > :last-child { margin-top:auto; }
.vdw-execution-policy-panel .vdw-policy-actions { justify-content:space-between; }
.vdw-execution-policy-panel .vdw-policy-fields .vdw-field-label { align-items:flex-start; }
.vdw-execution-policy-panel .vdw-policy-fields .vdw-field-label > label { min-width:0; overflow-wrap:anywhere; }
.vdw-role-presets-panel,.vdw-role-preset-editor { display:flex; flex-direction:column; gap:12px; min-width:0; }
.vdw-role-presets-panel > * { flex-shrink:0; }
.vdw-role-presets-toolbar { display:grid; grid-template-columns:minmax(0,1fr) minmax(100px,120px); align-items:center; gap:8px; }
.vdw-role-presets-search { min-width:0; height:var(--vdw-control-height,32px); min-height:var(--vdw-control-height,32px); background:var(--vdw-input-bg); padding:0 10px; border:1px solid transparent; border-radius:8px; }
.vdw-role-presets-search > input { font-size:13px; line-height:20px; min-width:0; }
.vdw-role-presets-panel .vdw-role-presets-new { height:var(--vdw-control-height,32px); min-height:var(--vdw-control-height,32px); }
.vdw-role-presets-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
.vdw-role-preset-card { display:flex; flex-direction:column; gap:8px; min-width:0; padding:12px; text-align:left; border:1px solid var(--vdw-border); border-radius:8px; background:var(--dsw-alias-bg-base); color:inherit; box-shadow:0 1px 2px rgb(0 0 0 / .04),0 3px 8px rgb(0 0 0 / .03); }
.vdw-role-preset-card:hover { background:var(--vdw-input-hover); }
.vdw-role-preset-card > span { display:flex; align-items:center; flex-wrap:wrap; gap:4px 8px; width:100%; min-width:0; }
.vdw-role-preset-card strong { flex:1; min-width:0; font-size:13px; line-height:20px; font-weight:600; overflow-wrap:anywhere; }
.vdw-role-preset-card > span > svg { flex:none; width:14px; height:14px; color:var(--vdw-muted); }
.vdw-role-preset-card > p { display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; font-size:12px; line-height:20px; color:var(--vdw-secondary); }
.vdw-role-preset-editor > .vdw-field { margin:0; gap:8px; }
.vdw-role-preset-editor textarea { resize:none; min-height:176px; }
.vdw-role-preset-editor > .vdw-between { align-items:flex-start; flex-direction:column; gap:4px; }
.vdw-role-preset-editor .vdw-role-preset-back { align-self:flex-start; height:var(--vdw-control-height,32px); }
.vdw-role-preset-editor-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.vdw-role-preset-editor-actions > span { flex:1; }
`
