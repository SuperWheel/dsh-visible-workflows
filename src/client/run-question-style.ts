/** Run input and human-input dialogs share the node menu's density, within native Modal bounds. */
export const runQuestionStyles=`
.vdw-modal.vdw-run-question { display:flex; flex-direction:column; width:min(560px,100%); min-height:0; max-height:100%; gap:var(--vdw-space-field,16px); padding:var(--vdw-space-field,16px); overflow:hidden; border:1px solid var(--vdw-border); border-radius:16px; background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base)); }
.vdw-run-question-heading { display:flex; flex:none; align-items:center; justify-content:space-between; gap:var(--vdw-space-inner,8px); min-width:0; }
.vdw-run-question-heading h2 { min-width:0; margin:0; font-size:16px; line-height:24px; font-weight:600; overflow-wrap:anywhere; }
.vdw-run-question .vdw-run-question-close { display:grid; place-items:center; flex:none; width:var(--vdw-control-height,32px); min-width:var(--vdw-control-height,32px); height:var(--vdw-control-height,32px); min-height:var(--vdw-control-height,32px); padding:8px; border:0; border-radius:var(--vdw-radius-control,8px); background:transparent; color:var(--vdw-secondary); }
.vdw-run-question .vdw-run-question-close:hover { background:var(--vdw-input-hover); }
.vdw-run-question-body { display:flex; flex-direction:column; gap:var(--vdw-space-field,16px); min-width:0; min-height:0; overflow:auto; overscroll-behavior:contain; font-size:13px; line-height:22px; }
.vdw-run-question-body > * { flex:none; min-width:0; }
.vdw-run-question .vdw-muted { margin:0; font-size:12px; line-height:18px; overflow-wrap:anywhere; }
.vdw-run-question .vdw-human-prompt { margin:0; padding:var(--vdw-space-card,12px); border:1px solid var(--vdw-border); border-radius:var(--vdw-radius-control,8px); background:var(--vdw-input-bg); font-size:13px; line-height:22px; }
.vdw-run-question-fields { display:flex; flex-direction:column; gap:var(--vdw-space-field,16px); padding:var(--vdw-space-card,12px); border:1px solid var(--vdw-border); border-radius:var(--vdw-radius-control,8px); background:var(--dsw-alias-bg-base); box-shadow:0 1px 2px rgb(0 0 0 / .04),0 3px 8px rgb(0 0 0 / .03); }
.vdw-run-question-fields > .vdw-field { flex:none; margin:0; gap:var(--vdw-space-inner,8px); }
.vdw-run-question-fields .vdw-field-label { font-size:13px; line-height:20px; font-weight:500; }
.vdw-run-question-fields .vdw-field > span:has(> input),.vdw-run-question-fields .vdw-select-trigger { flex:none; height:var(--vdw-control-height,32px); min-height:var(--vdw-control-height,32px); border-radius:var(--vdw-radius-control,8px); }
.vdw-run-question-fields .vdw-field > textarea { margin:0; padding:var(--vdw-space-card,12px); border-radius:var(--vdw-radius-control,8px); font-size:13px; line-height:22px; resize:none; }
.vdw-run-question .vdw-file-input { display:flex; flex-direction:column; gap:var(--vdw-space-inner,8px); min-width:0; }
.vdw-run-question .vdw-file-input > input { width:100%; min-width:0; min-height:var(--vdw-control-height,32px); color:var(--vdw-secondary); font-size:13px; line-height:20px; }
.vdw-run-question .vdw-file-input > input::file-selector-button { height:var(--vdw-control-height,32px); margin-right:8px; padding:0 12px; border:1px solid var(--vdw-border); border-radius:var(--vdw-radius-control,8px); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; cursor:pointer; }
.vdw-run-question .vdw-file-input > input::file-selector-button:hover { background:var(--vdw-input-hover); }
.vdw-run-question .vdw-file-input > input:disabled::file-selector-button { cursor:not-allowed; }
.vdw-run-question .vdw-file-input > small { margin:0; overflow-wrap:anywhere; }
.vdw-run-question-footer { display:flex; flex:none; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:var(--vdw-space-inner,8px); }
.vdw-run-question-footer > button { flex:none; min-height:var(--vdw-control-height,32px); height:var(--vdw-control-height,32px); max-width:100%; padding:0 12px; border-radius:var(--vdw-radius-control,8px); font-size:13px; line-height:20px; }
`
