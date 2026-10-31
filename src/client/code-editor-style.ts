/** Appended after the general form styles. Every selector belongs to a workflow editor/viewer. */
export const codeEditorStyles = `
.vdw-source-editor { min-width:0; overflow:hidden; border:1px solid var(--vdw-border); border-radius:8px; background:var(--vdw-input-bg); }
.vdw-source-editor:has(.vdw-source-input:focus-visible) { border-color:var(--vdw-accent); outline:2px solid color-mix(in srgb,var(--vdw-accent) 16%,transparent); outline-offset:1px; }
.vdw-source-editor.has-error { border-color:var(--dsw-alias-state-error-primary,var(--vdw-border)); }
.vdw-source-toolbar { display:flex; align-items:center; justify-content:space-between; gap:8px; min-height:36px; padding:4px 8px 4px 12px; border-bottom:1px solid var(--dsw-alias-border-l2); }
.vdw-source-language,.vdw-source-actions { display:flex; align-items:center; gap:8px; min-width:0; }
.vdw-source-language { color:var(--vdw-secondary); font-size:12px; line-height:20px; }
.vdw-source-language strong { font-size:12px; font-weight:500; }
.vdw-source-language > span { color:var(--vdw-muted); font-size:12px; white-space:nowrap; }
.vdw-source-actions { flex:none; gap:4px; }
.vdw-source-actions .vdw-source-action { display:inline-flex; align-items:center; justify-content:center; min-width:28px; height:28px; padding:4px 6px; border:0; border-radius:6px; background:transparent; color:var(--vdw-secondary); font-size:12px; line-height:20px; }
.vdw-source-actions .vdw-source-action:hover:not(:disabled) { background:var(--vdw-input-hover); color:var(--dsw-alias-label-primary); }
.vdw-source-body { display:flex; position:relative; min-width:0; overflow:hidden; }
.vdw-source-gutter { flex:none; overflow:hidden; padding:12px 8px; border-right:1px solid var(--dsw-alias-border-l2); color:var(--vdw-muted); text-align:right; user-select:none; }
.vdw-source-gutter > div { white-space:pre; }
.vdw-source-content { position:relative; flex:1; min-width:0; overflow:hidden; }
.vdw-source-editor .vdw-source-highlight,:is(.vdw,.vdw-modal,.vdw-settings-section) .vdw-source-editor .vdw-source-input,.vdw-source-gutter { font:400 12px/20px var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace); tab-size:2; letter-spacing:normal; }
.vdw-source-editor .vdw-source-highlight { position:absolute; left:0; top:0; width:max-content; min-width:100%; max-width:none; max-height:none; overflow:visible; margin:0; padding:12px; border:0; border-radius:0; background:transparent; color:var(--dsw-alias-label-primary); white-space:pre; pointer-events:none; user-select:none; }
:is(.vdw,.vdw-modal,.vdw-settings-section) .vdw-source-editor .vdw-source-input { display:block; position:absolute; inset:0; width:100%; height:100%; min-height:0; margin:0; padding:12px; border:0; border-radius:0; outline:none; resize:none; overflow:auto; background:transparent; color:transparent; -webkit-text-fill-color:transparent; caret-color:var(--dsw-alias-label-primary); white-space:pre; }
:is(.vdw,.vdw-modal,.vdw-settings-section) .vdw-source-editor .vdw-source-input:focus-visible { outline:none; }
:is(.vdw,.vdw-modal,.vdw-settings-section) .vdw-source-editor .vdw-source-input::selection { background:color-mix(in srgb,var(--vdw-accent) 20%,transparent); }
.vdw-source-footer { display:flex; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; gap:4px 8px; padding:8px 12px; border-top:1px solid var(--dsw-alias-border-l2); }
.vdw-source-editor .vdw-source-footer small { color:var(--vdw-muted); font-size:12px; line-height:18px; }
.vdw-source-editor .vdw-source-footer small[role=status] { color:var(--vdw-secondary); }
.vdw-source-editor .vdw-source-error { display:block; margin:0; padding:8px 12px; color:var(--dsw-alias-state-error-primary,var(--vdw-secondary)); font-size:12px; line-height:18px; }
.vdw-source-a11y { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }
/* The transparent dismissal layer belongs only to this expanded editor. */
[role=presentation]:has(> .vdw-expanded-editor) { align-items:stretch; justify-content:flex-end; padding:max(16px,var(--dsh-frame-overlay-top,16px)) 16px 16px; }
[role=presentation]:has(> .vdw-expanded-editor) > [aria-hidden=true] { backdrop-filter:none; }
[role=presentation]:has(> .vdw-expanded-editor) > [aria-hidden=true]::after { background:transparent; animation:none; }
.vdw-modal.vdw-expanded-editor { display:flex; flex-direction:column; width:min(640px,100%); height:100%; max-height:100%; min-height:0; padding:16px; gap:0; border:1px solid var(--vdw-border); border-radius:16px; background:var(--dsw-alias-bg-base); }
.vdw-expanded-editor > :only-child { flex:1; min-height:0; min-width:0; max-height:none; }
.vdw-expanded-editor > .vdw-source-editor { display:flex; flex-direction:column; min-height:0; border:0; border-radius:8px; }
.vdw-expanded-editor .vdw-source-toolbar { flex:none; min-height:36px; }
.vdw-expanded-editor .vdw-source-body { flex:1; min-height:0; height:auto; }
.vdw-expanded-editor .vdw-source-footer,.vdw-expanded-editor .vdw-source-error { flex:none; }
.vdw-source-editor.is-disabled .vdw-source-body { opacity:.55; }
.vdw-source-editor.is-disabled .vdw-source-input { cursor:not-allowed; }
:is(.vdw-source-editor,.vdw-data-viewer) .vdw-syntax-property { color:color-mix(in srgb,var(--vdw-accent) 74%,var(--dsw-alias-label-primary)); }
:is(.vdw-source-editor,.vdw-data-viewer) .vdw-syntax-string { color:color-mix(in srgb,#16794a 72%,var(--dsw-alias-label-primary)); }
:is(.vdw-source-editor,.vdw-data-viewer) .vdw-syntax-number { color:color-mix(in srgb,#a45c22 78%,var(--dsw-alias-label-primary)); }
:is(.vdw-source-editor,.vdw-data-viewer) .vdw-syntax-keyword { color:color-mix(in srgb,#8a53b0 78%,var(--dsw-alias-label-primary)); font-weight:500; }
:is(.vdw-source-editor,.vdw-data-viewer) .vdw-syntax-comment { color:var(--vdw-muted); font-style:italic; }
:is(.vdw-source-editor,.vdw-data-viewer) .vdw-syntax-punctuation { color:var(--vdw-secondary); }
:is(.vdw-source-editor,.vdw-data-viewer) .vdw-syntax-variable { color:var(--vdw-accent); background:color-mix(in srgb,var(--vdw-accent) 8%,transparent); border-radius:3px; }
@media (forced-colors:active) { :is(.vdw,.vdw-modal,.vdw-settings-section) .vdw-source-editor .vdw-source-input { color:CanvasText; -webkit-text-fill-color:CanvasText; background:Canvas; } .vdw-source-editor .vdw-source-highlight { visibility:hidden; } }
`
