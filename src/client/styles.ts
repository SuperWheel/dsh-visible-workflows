import { subagentCardStyles } from './subagent-card-style.ts'
import { workflowReadinessStyles } from './workflow-readiness.tsx'
import { proposalNoticeStyles } from './proposal-notice.tsx'
import { selectStyles } from './select-style.ts'
import { dataViewerStyles } from './data-viewer-style.ts'
import { variableBrowserStyles } from './variable-browser-style.ts'
import { editorHeadingStyles } from './editor-heading-style.ts'
import { nodeBranchesStyles } from './node-branches-style.ts'
import { canvasTopActionsStyles } from './canvas-top-actions-style.ts'
import { codeEditorStyles } from './code-editor-style.ts'
import { advancedSettingsStyles } from './advanced-settings-style.ts'
import { toolSelectionStyles } from './tool-selection-style.ts'
import { workflowMotionStyles } from './workflow-motion-style.ts'
import { runRecoveryStyles } from './run-recovery-style.ts'
import { runDetailStyles } from './run-detail-style.ts'
/** Shared visual contract for the workflow UI. See DESIGN.md before changing it. */
export const styles = subagentCardStyles + workflowReadinessStyles + proposalNoticeStyles + `

/* Scope tokens to the plugin, including portaled menus and dialogs. */
:is(.vdw,.vdw-modal,.vdw-settings-section,.vdw-menu) {
  --vdw-accent:var(--dsw-alias-state-business-primary);
  --vdw-border:var(--dsw-alias-border-l3);
  --vdw-muted:var(--dsw-alias-label-tertiary);
  --vdw-secondary:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary));
  --vdw-radius-control:8px;
  --vdw-control-height:32px;
  --vdw-space-field:16px;
  --vdw-space-card:12px;
  --vdw-space-inner:8px;
  --vdw-floating-height:38px;
  --vdw-floating-padding:2px;
  --vdw-floating-radius:10px;
  --vdw-floating-shadow:0 1px 2px rgb(0 0 0 / .04),0 3px 8px rgb(0 0 0 / .03);
  --vdw-input-bg:color-mix(in srgb,var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-1)) 75%,var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1)));
  --vdw-input-hover:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,var(--dsw-alias-bg-base));
  --vdw-node-border:color-mix(in srgb,var(--dsw-alias-label-primary) 22%,var(--dsw-alias-bg-base));
  --vdw-node-border-hover:color-mix(in srgb,var(--dsw-alias-label-primary) 32%,var(--dsw-alias-bg-base));
  --vdw-edge-color:color-mix(in srgb,var(--dsw-alias-label-primary) 28%,var(--dsw-alias-bg-base));
  --vdw-radius-small:var(--dsw-radius-sm,8px);
  font-family:var(--dsw-font-family);
  font-size:14px;
  line-height:22px;
  color:var(--dsw-alias-label-primary);
}
:is(.vdw,.vdw-modal,.vdw-settings-section,.vdw-menu),
:is(.vdw,.vdw-modal,.vdw-settings-section,.vdw-menu) * { box-sizing:border-box; }
:is(.vdw,.vdw-modal,.vdw-settings-section) :is(h1,h2,h3,p) { margin:0; }
:is(.vdw,.vdw-modal,.vdw-settings-section,.vdw-menu) :is(button,input,textarea) { font-family:inherit; }
:is(.vdw,.vdw-modal,.vdw-settings-section) input::placeholder { color:var(--vdw-muted); opacity:1; }
:is(.vdw,.vdw-modal,.vdw-settings-section,.vdw-menu) button { cursor:pointer; transition:background-color 120ms,border-color 120ms,color 120ms; }
:is(.vdw,.vdw-modal,.vdw-settings-section,.vdw-menu) button:disabled { cursor:not-allowed; }
:is(.vdw,.vdw-modal,.vdw-settings-section,.vdw-menu) :is(button,textarea,summary):focus-visible {
  outline:2px solid var(--vdw-accent); outline-offset:2px;
}
:is(.vdw,.vdw-modal,.vdw-settings-section) small,
:is(.vdw,.vdw-modal,.vdw-settings-section) .vdw-muted {
  color:var(--vdw-muted); font-size:12px; line-height:18px;
}
.vdw { height:100%; min-width:0; min-height:0; display:flex; flex-direction:column; overflow:hidden; position:relative; background:var(--dsw-alias-bg-base); container:workflow / inline-size; }
.vdw-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.vdw-between { display:flex; align-items:center; justify-content:space-between; gap:12px; min-width:0; }
.vdw-between > :first-child { min-width:0; overflow-wrap:anywhere; }
.vdw-between > :last-child { flex-shrink:0; }

/* Library: a clear heading, one filter strip, then equal-height cards. */
.vdw-library-heading { display:flex; align-items:center; justify-content:space-between; gap:24px; padding:calc(var(--dsh-frame-top-clearance,0px) + 24px) 32px 24px; flex:none; }
.vdw-library-heading > div:first-child { min-width:0; flex:1; }
.vdw-library-heading h1 { font-size:24px; line-height:32px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vdw-library-heading p { margin-top:8px; color:var(--vdw-muted); }
.vdw-library-controls { display:flex; gap:12px; align-items:center; padding:0 32px; flex:none; }
.vdw-library-controls > span:first-child { flex:1; min-width:160px; height:36px; padding-inline:12px; }
.vdw-library-filters { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; flex:0 1 440px; min-width:0; }
.vdw-library-controls .vdw-library-filters .vdw-select { width:100%; min-width:0; max-width:none; }
.vdw-library-heading > .vdw-home-actions { flex:none; flex-wrap:nowrap; }
.vdw-home-actions button { position:relative; min-width:0; height:32px; min-height:32px; overflow:hidden; }
.vdw-home-action-label { flex:none; width:max-content; white-space:nowrap; opacity:1; }
.vdw-library-loading { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }
.vdw-library-divider { position:relative; z-index:1; flex:none; width:100%; height:1px; margin-top:16px; background:var(--vdw-border); }
.vdw-library-divider::after { content:''; position:absolute; inset:1px 0 auto; height:12px; pointer-events:none; background:linear-gradient(to bottom,rgb(0 0 0 / .10),transparent); opacity:0; }
.vdw-library-divider.is-scrolled::after { opacity:1; }
.vdw-library-body { flex:1; min-height:0; overflow:auto; padding:20px 32px 32px; overscroll-behavior:contain; }
.vdw-flow-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(260px,100%),1fr)); gap:16px; }
.vdw-flow-card { position:relative; min-width:0; border:1px solid var(--vdw-border); border-radius:var(--dsw-radius-xl,16px); background:var(--dsw-alias-bg-base); overflow:hidden; transition:background-color 120ms,border-color 120ms; }
.vdw-flow-card:hover { background:var(--dsw-alias-interactive-bg-hover); border-color:var(--dsw-alias-border-l1); }
.vdw-card-open { width:100%; min-height:208px; display:flex; flex-direction:column; align-items:flex-start; gap:12px; padding:20px; border:0; background:transparent; color:inherit; text-align:left; font:inherit; }
.vdw-card-icon { width:36px; height:36px; display:grid; place-items:center; border-radius:var(--vdw-radius-control); color:var(--vdw-accent); background:color-mix(in srgb,var(--vdw-accent) 8%,transparent); }
.vdw-card-open > strong { max-width:100%; font-size:16px; line-height:24px; font-weight:500; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.vdw-card-open > p { color:var(--vdw-secondary); font-size:14px; line-height:20px; min-height:40px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; }
.vdw-card-open > div { width:100%; display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:auto; font-size:12px; line-height:18px; color:var(--vdw-muted); }
.vdw-card-open > div > span:first-child { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vdw-card-open > div > span:last-child { flex:none; }
.vdw-card-open > small { font-size:12px; }
.vdw-card-menu { position:absolute; top:12px; right:12px; }
.vdw-card-menu button { width:32px; height:32px; padding:8px; }
.vdw-empty { min-height:220px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; padding:32px 20px; color:var(--vdw-muted); text-align:center; }
.vdw-empty h2 { color:var(--dsw-alias-label-primary); font-size:18px; line-height:26px; font-weight:600; }
.vdw-empty .vdw-actions { margin-top:8px; justify-content:center; }

/* The editor heading floats above the canvas; see editorHeadingStyles. */
.vdw-editor-body { position:relative; flex:1; min-width:0; min-height:0; display:flex; overflow:hidden; }
.vdw-scope-breadcrumb { display:flex; align-items:center; gap:4px; flex:none; min-width:0; overflow-x:auto; padding:8px 16px; border-bottom:.5px solid var(--vdw-border); font-size:12px; line-height:18px; white-space:nowrap; }
.vdw-scope-breadcrumb > span { display:flex; align-items:center; flex:none; }
.vdw-scope-breadcrumb button { max-width:180px; height:32px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
.vdw-scope-breadcrumb > small { margin-left:auto; padding-left:12px; flex:none; }

/* Canvas geometry is owned by nodeSize/layout; these rules never scale UI chrome. */
.vdw-canvas-wrap { position:relative; flex:1; min-width:0; min-height:0; overflow:clip; background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-1)); container:canvas / inline-size; }
.vdw-canvas { position:absolute; inset:0; overflow:clip; touch-action:none; user-select:none; background-image:radial-gradient(circle,var(--dsw-alias-border-l2) 1px,transparent 1px); outline:none; }
.vdw-canvas.is-hand { cursor:grab; }
.vdw-canvas.is-hand:active { cursor:grabbing; }
.vdw-world { position:absolute; left:0; top:0; width:0; height:0; transform-origin:0 0; }
.vdw-edges { position:absolute; left:0; top:0; width:1px; height:1px; overflow:visible; }
.vdw-edge { fill:none; stroke:var(--vdw-edge-color); stroke-width:2; pointer-events:none; }
.vdw-edge-hit { fill:none; stroke:transparent; stroke-width:16; pointer-events:stroke; cursor:pointer; }
.vdw-edges .is-selected .vdw-edge { stroke:var(--vdw-accent); }
.vdw-edges text { fill:var(--vdw-muted); font-size:12px; pointer-events:none; }
.vdw-node { position:absolute; width:256px; min-height:80px; padding:12px 14px; border:1px solid var(--vdw-node-border); border-radius:12px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); box-shadow:0 2px 5px rgb(0 0 0 / .04),0 0 1px rgb(0 0 0 / .08); cursor:default; touch-action:none; }
.vdw-node:hover { border-color:var(--vdw-node-border-hover); }
.vdw-node.is-selected { border-color:var(--vdw-accent); box-shadow:0 0 0 1px var(--vdw-accent),0 2px 5px rgb(0 0 0 / .04); }
.vdw-node:focus-visible { outline:2px solid var(--vdw-accent); outline-offset:2px; }
.vdw-node-title { display:flex; align-items:center; gap:8px; min-width:0; height:24px; }
.vdw-node-title > strong { flex:1; min-width:0; font-size:14px; line-height:22px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.vdw-node-number { color:var(--vdw-accent); font-size:12px; font-weight:500; font-variant-numeric:tabular-nums; }
.vdw-node-title > svg { flex:none; color:var(--vdw-muted); }
.vdw-node-preview { margin-top:8px; color:var(--vdw-muted); font-size:12px; line-height:18px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.vdw-node-badge { display:inline-flex; align-items:center; justify-content:center; flex:none; width:24px; height:24px; border-radius:7px; color:#fff; background:var(--tone); box-shadow:0 1px 3px color-mix(in srgb,var(--tone) 18%,transparent); }
.tone-blue { --tone:var(--dsw-alias-state-business-primary); }
.tone-violet { --tone:color-mix(in srgb,var(--dsw-alias-state-business-primary) 70%,var(--dsw-alias-state-error-primary)); }
.tone-green { --tone:var(--dsw-alias-state-success-primary); }
.tone-cyan { --tone:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,var(--dsw-alias-state-success-primary)); }
.tone-orange { --tone:var(--dsw-alias-state-warn-primary); }
.vdw-model-strip { display:flex; align-items:center; gap:6px; min-width:0; height:24px; margin-top:8px; padding:2px 8px; border-radius:6px; background:var(--vdw-input-bg); color:var(--vdw-secondary); font-size:12px; line-height:20px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.vdw-model-strip > svg { flex:none; }
.vdw-model-strip > span { min-width:0; overflow:hidden; text-overflow:ellipsis; }
.vdw-model-strip + .vdw-node-preview { margin-top:4px; }
.vdw-port { position:absolute; width:10px; height:10px; min-height:0; padding:0; border:2px solid var(--vdw-edge-color); border-radius:50%; background:var(--dsw-alias-bg-base); z-index:2; }
.vdw-port::after { content:''; position:absolute; inset:-7px; }
.vdw-port-in { left:-6px; }
.vdw-port-out { right:-6px; }
.vdw-node.is-selected .vdw-port { border-color:var(--vdw-accent); background:var(--vdw-accent); }
.vdw-port:hover,.vdw-port:focus-visible,.vdw-port.is-target { border-color:var(--vdw-accent); background:var(--vdw-accent); box-shadow:0 0 0 4px color-mix(in srgb,var(--vdw-accent) 10%,transparent); }
.vdw-selection-box { position:absolute; border:1px solid var(--vdw-accent); background:color-mix(in srgb,var(--vdw-accent) 8%,transparent); pointer-events:none; }
.vdw-container-node { border-style:dashed; background:var(--dsw-alias-bg-base); }
.vdw-container-inner { height:132px; margin-top:12px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; padding:12px 0; border-top:1px dashed var(--vdw-border); background-image:radial-gradient(circle,var(--dsw-alias-border-l2) 1px,transparent 1px); background-size:16px 16px; }
.vdw-container-mini { display:flex; align-items:center; gap:8px; max-width:100%; overflow:hidden; }
.vdw-container-mini > span { min-width:0; display:flex; align-items:center; gap:4px; padding:8px; border:.5px solid var(--vdw-border); border-radius:var(--vdw-radius-small); background:var(--dsw-alias-bg-base); font-size:12px; line-height:18px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.vdw-container-mini .vdw-node-badge { width:20px; height:20px; }
.vdw-container-mini .vdw-node-badge > svg { width:14px; height:14px; }
.vdw-container-inner > button { height:32px; font-size:13px; line-height:20px; }
.vdw-sticky { position:absolute; width:280px; min-height:96px; padding:16px; border:.5px solid var(--vdw-border); border-radius:var(--vdw-radius-control); background:color-mix(in srgb,var(--vdw-accent) 5%,var(--dsw-alias-bg-base)); white-space:pre-wrap; overflow-wrap:anywhere; }
.vdw-sticky > span { font-size:12px; line-height:18px; color:var(--vdw-muted); }
.vdw-sticky > p { margin-top:8px; }
.vdw-sticky > button { position:absolute; top:8px; right:8px; opacity:0; width:32px; height:32px; padding:8px; }
.vdw-sticky:hover > button,.vdw-sticky:focus-within > button { opacity:1; }
.vdw-annotation-pin { position:absolute; display:grid; place-items:center; width:28px; height:28px; padding:0; transform:translate(-50%,-50%); border:2px solid var(--dsw-alias-bg-base); border-radius:14px 14px 14px 3px; corner-shape:round; background:var(--dsw-alias-button-info-fill); color:#fff; font-size:12px; line-height:20px; font-weight:500; z-index:4; box-shadow:0 1px 4px rgb(0 0 0 / .12); cursor:pointer; }
.vdw-canvas.is-placing-annotation,.vdw-canvas.is-placing-annotation * { cursor:crosshair!important; }

/* Screen-space tool groups. Execution stays complete when selection wraps. */
.vdw-canvas-top-actions { position:absolute; top:var(--vdw-actions-top,12px); left:12px; right:12px; display:flex; align-items:flex-start; justify-content:flex-end; flex-wrap:nowrap; gap:8px; z-index:8; pointer-events:none; }
.vdw-floating,.vdw-selection-actions,.vdw-canvas-tools { display:flex; align-items:center; gap:4px; padding:var(--vdw-floating-padding); border:1px solid var(--vdw-border); border-radius:var(--vdw-floating-radius); background:var(--dsw-alias-bg-base); box-shadow:var(--vdw-floating-shadow); pointer-events:auto; }
.vdw-floating,.vdw-selection-actions { min-height:var(--vdw-floating-height); height:var(--vdw-floating-height); gap:2px; }
.vdw :is(.vdw-floating,.vdw-selection-actions,.vdw-canvas-tools,.vdw-editor-save-actions,.vdw-editor-title-card,.vdw-minimap-shell) button { box-shadow:none; }
.vdw-selection-actions { position:static; flex:0 0 auto; max-width:100%; }
.vdw-selection-actions > span { padding:0 4px; font-size:12px; line-height:18px; color:var(--vdw-muted); white-space:nowrap; }
.vdw-execution-actions { flex:0 0 auto; flex-wrap:nowrap; white-space:nowrap; }
.vdw-floating > button,.vdw-selection-actions > button { min-height:var(--vdw-control-height); height:var(--vdw-control-height); padding:0 8px; font-size:12px; line-height:18px; border-radius:var(--vdw-radius-small); gap:4px; flex:none; }
.vdw-floating > span { min-width:36px; color:var(--vdw-muted); font-size:12px; line-height:18px; text-align:center; }
.vdw-floating > button svg,.vdw-selection-actions > button svg { width:16px; height:16px; flex:none; }
.vdw-icon-button { width:32px; min-width:32px; height:32px; padding:8px!important; flex:none; justify-content:center; border-radius:var(--vdw-radius-small); }
.vdw-floating .vdw-icon-button,.vdw-selection-actions .vdw-icon-button { width:var(--vdw-control-height); min-width:var(--vdw-control-height); height:var(--vdw-control-height); min-height:var(--vdw-control-height); padding:8px!important; }
.vdw-icon-button[aria-pressed=true] { color:var(--vdw-accent); background:color-mix(in srgb,var(--vdw-accent) 10%,transparent); }
.vdw-canvas-tools { position:absolute; top:50%; left:12px; transform:translateY(-50%); flex-direction:column; max-height:calc(100% - 128px); overflow-y:auto; z-index:3; }
.vdw-canvas-tools > i { align-self:stretch; height:.5px; min-height:.5px; margin:4px; background:var(--dsw-alias-border-l2); }
.vdw-canvas-bottom { position:absolute; bottom:12px; left:12px; right:12px; display:flex; align-items:flex-end; justify-content:space-between; flex-wrap:wrap; gap:8px; pointer-events:none; z-index:3; }
.vdw-canvas-wrap.is-inspecting .vdw-canvas-bottom { right:calc(var(--vdw-inspector-width,360px) + 12px); }
.vdw-canvas-bottom > .vdw-floating:last-child { margin-left:auto; }
.vdw-canvas-hint { position:absolute; bottom:60px; left:50%; transform:translateX(-50%); max-width:calc(100% - 32px); padding:8px 12px; border:1px solid var(--vdw-border); border-radius:var(--vdw-radius-control); background:var(--dsw-alias-bg-base); color:var(--vdw-secondary); box-shadow:var(--dsw-elevation-soft); font-size:12px; line-height:18px; z-index:3; }
.vdw-minimap-shell { position:absolute; bottom:60px; right:12px; width:162px; max-width:calc(100% - 24px); overflow:hidden; border:1px solid var(--vdw-border); border-radius:var(--vdw-floating-radius); background:var(--dsw-alias-bg-base); box-shadow:var(--vdw-floating-shadow); z-index:3; }
.vdw-canvas-wrap.is-inspecting .vdw-minimap-shell { right:calc(var(--vdw-inspector-width,360px) + 12px); }
.vdw-minimap-header { display:flex; align-items:center; justify-content:space-between; gap:4px; height:24px; padding:0 2px 0 8px; border-bottom:.5px solid var(--vdw-border); color:var(--vdw-muted); font-size:12px; line-height:18px; }
.vdw-minimap-shell canvas { display:block; width:160px!important; max-width:100%; height:100px!important; outline-offset:-2px; }
.vdw-minimap:focus-visible { outline:2px solid var(--vdw-accent); outline-offset:-2px; }
.vdw-minimap-toggle { display:inline-flex; align-items:center; justify-content:center; width:28px; min-width:28px; height:28px; padding:6px; border:0; border-radius:var(--vdw-radius-small); background:transparent; color:var(--vdw-secondary); }
.vdw-minimap-shell > .vdw-icon-button { width:var(--vdw-control-height); min-width:var(--vdw-control-height); height:var(--vdw-control-height); min-height:var(--vdw-control-height); padding:8px!important; }
.vdw-minimap-shell button svg { width:16px; height:16px; }
.vdw-minimap-header :is(.vdw-minimap-toggle,.vdw-icon-button) { width:24px; min-width:24px; height:24px; padding:4px!important; }
.vdw-minimap-toggle:hover { background:var(--dsw-alias-interactive-bg-hover); }
.vdw-minimap-shell:is(.is-collapsed,[data-collapsed=true]) { width:var(--vdw-floating-height); height:var(--vdw-floating-height); padding:var(--vdw-floating-padding); border-radius:var(--vdw-floating-radius); }
.vdw-minimap-shell:is(.is-collapsed,[data-collapsed=true]) > .vdw-minimap-toggle { width:var(--vdw-control-height); min-width:var(--vdw-control-height); height:var(--vdw-control-height); padding:8px; }

/* Node / tool picker: fixed header + independent scroll area + fixed footer. */
.vdw-node-picker { position:absolute; top:50%; left:64px; transform:translateY(-50%); width:min(384px,calc(100% - 76px)); max-height:min(560px,calc(100% - 24px)); min-height:0; display:flex; flex-direction:column; background:var(--dsw-alias-bg-base); border:1px solid var(--vdw-border); border-radius:14px; box-shadow:var(--dsw-elevation-prominent); overflow:hidden; user-select:none; z-index:9; }
.vdw-picker-heading { display:flex; align-items:center; gap:4px; padding:4px 8px 0; background:var(--vdw-input-bg); flex:none; min-width:0; }
.vdw-picker-tabs { display:flex; flex:1; min-width:0; overflow-x:auto; align-items:center; }
.vdw-picker-tabs > button { position:relative; height:36px; border-radius:8px 8px 0 0; flex:0 0 auto; padding:0 12px; border:0; background:transparent; color:var(--vdw-muted); font-size:14px; line-height:20px; font-weight:500; white-space:nowrap; }
.vdw-picker-tabs > button:hover { background:var(--dsw-alias-interactive-bg-hover); }
.vdw-picker-tabs > button[aria-selected=true] { color:var(--vdw-accent); background:var(--dsw-alias-bg-base); }

.vdw-picker-heading > button { flex:none; }
.vdw-picker-search { padding:12px; flex:none; }
.vdw-picker-search > span { width:100%; height:32px; padding:0 10px; border:1px solid transparent; border-radius:8px; background:var(--vdw-input-bg); }
.vdw-picker-search input { font-size:13px; }
.vdw-picker-scroll { flex:1; min-height:0; overflow-y:auto; overflow-x:hidden; padding:0 8px 8px; overscroll-behavior:contain; }
.vdw-picker-group + .vdw-picker-group { margin-top:8px; }
.vdw-picker-group > h3 { padding:8px 10px 4px; color:var(--vdw-muted); font-size:12px; line-height:18px; font-weight:500; }
.vdw-picker-row { width:100%; display:flex; align-items:center; gap:10px; padding:8px 10px; border:0; border-radius:var(--vdw-radius-small); background:transparent; color:inherit; font:inherit; text-align:left; }
.vdw-picker-row:hover:not(:disabled),.vdw-picker-row:focus-visible:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }
.vdw-picker-row:active:not(:disabled) { background:var(--dsw-alias-interactive-bg-active); }
.vdw-picker-row:focus-visible { outline-offset:-2px; }
.vdw-picker-row:disabled { opacity:.45; }
.vdw-picker-row > svg { color:var(--vdw-muted); flex:none; }
.vdw-picker-label { flex:1; min-width:0; }
.vdw-picker-label strong { display:block; font-size:14px; line-height:20px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vdw-picker-label small { display:block; margin-top:2px; font-size:12px; line-height:18px; color:var(--vdw-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vdw-node-option { min-height:36px; padding-block:6px; }
.vdw-node-option > em { padding:0 4px; border-radius:4px; background:var(--dsw-alias-bg-layer-1); color:var(--vdw-muted); font-style:normal; font-size:12px; line-height:18px; }
.vdw-agent-submenu { margin:4px 8px 8px 32px; }
.vdw-agent-option { min-height:40px; border:1px solid var(--vdw-border); background:var(--vdw-input-bg); }
.vdw-picker-add-action { display:inline-flex; align-items:center; gap:3px; flex:none; color:var(--vdw-secondary); font-size:12px; line-height:18px; }
.vdw-picker-add-action svg { width:14px; height:14px; }
.vdw-picker-row:hover:not(:disabled) .vdw-picker-add-action { color:var(--vdw-accent); }
.vdw-picker-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; padding:24px 16px; color:var(--vdw-muted); text-align:center; font-size:13px; line-height:20px; }
.vdw-picker-empty strong { font-size:14px; line-height:22px; font-weight:500; }
.vdw-picker-empty button { height:32px; font-size:13px; }
.vdw-picker-explainer { padding:8px 12px; color:var(--vdw-muted); font-size:12px; line-height:18px; }
.vdw-picker-unavailable { display:flex; flex-direction:column; gap:8px; margin:8px; padding:16px; border-radius:var(--vdw-radius-control); background:var(--dsw-alias-bg-layer-1); }
.vdw-picker-unavailable strong { font-size:14px; line-height:22px; font-weight:500; }
.vdw-tool-filters { padding:0 12px 8px; flex:none; min-width:0; }
.vdw-tool-category { display:flex; gap:4px; min-width:0; overflow-x:auto; padding:2px; scrollbar-width:thin; }
.vdw-tool-category > button { flex:none; min-height:28px; padding:4px 10px; border:0; border-radius:var(--vdw-radius-small); background:transparent; color:var(--vdw-muted); font-size:13px; line-height:20px; white-space:nowrap; }
.vdw-tool-category > button:hover { background:var(--dsw-alias-interactive-bg-hover); }
.vdw-tool-category > button[aria-selected=true] { color:var(--dsw-alias-label-primary); background:var(--vdw-input-bg); font-weight:500; }
.vdw-tool-category > button:focus-visible { outline-offset:-2px; }
.vdw-tool-list-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:0 12px 4px; flex:none; }
.vdw-tool-list-heading > span { font-size:12px; line-height:18px; color:var(--vdw-muted); }
.vdw-tool-provider + .vdw-tool-provider { margin-top:4px; }
.vdw-provider-row { min-height:52px; }
.vdw-tool-operations { margin:0 4px 12px 28px; }
.vdw-tool-operation { margin-top:8px; border:1px solid var(--vdw-border); border-radius:8px; background:var(--dsw-alias-bg-base); overflow:hidden; box-shadow:0 1px 2px rgb(0 0 0 / .03); }
.vdw-tool-operation:first-child { margin-top:4px; }
.vdw-operation-row { min-height:48px; padding:10px 12px; border-radius:0; background:var(--vdw-input-bg); }
.vdw-operation-row .vdw-picker-label small { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; white-space:normal; overflow-wrap:anywhere; }
.vdw-tool-operation > .vdw-error { display:block; padding:4px 12px; }
.vdw-tool-operation > details { padding:4px 12px; border-top:1px solid var(--vdw-border); color:var(--vdw-muted); font-size:12px; line-height:18px; }
.vdw-tool-operation summary { display:list-item; cursor:pointer; width:fit-content; padding:4px 0; }
.vdw-tool-schema > div { padding:8px 0; }
.vdw-tool-schema > div + div { border-top:.5px solid var(--vdw-border); }
.vdw-tool-schema-heading { display:flex; align-items:baseline; flex-wrap:wrap; gap:8px; }
.vdw-tool-schema-heading code { min-width:0; overflow-wrap:anywhere; color:var(--vdw-secondary); font-family:var(--dsw-font-family-mono,monospace); font-size:12px; line-height:20px; }
.vdw-tool-schema-heading strong { font-size:12px; font-weight:500; }
.vdw-tool-schema p { margin-top:4px; overflow-wrap:anywhere; }
.vdw-picker-footer { flex:none; display:flex; align-items:center; flex-wrap:wrap; gap:4px; padding:8px 12px; border-top:.5px solid var(--vdw-border); }
.vdw-picker-footer > small { flex:1; min-width:0; font-size:12px; line-height:18px; }
.vdw-picker-footer > button { height:32px; padding-inline:8px; font-size:13px; white-space:nowrap; }

/* Native primitives, with scoped form sizing and scoped portal menu rows. */
.vdw-select { display:inline-flex; width:100%; min-width:0; flex:none; }
.vdw-select > .vdw-select-trigger { width:100%; height:var(--vdw-control-height); min-height:var(--vdw-control-height); max-height:var(--vdw-control-height); flex:none; min-width:0; justify-content:space-between; gap:8px; padding:0 10px; border:1px solid transparent; border-radius:var(--vdw-radius-control); background:var(--vdw-input-bg); font-size:13px; line-height:20px; font-weight:400; }
.vdw-select-trigger > span:first-child { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.vdw-select-trigger > svg { flex:none; color:var(--vdw-muted); }
.vdw-menu { --dsw-menu-surface-fill:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#fff)); --dsw-menu-backdrop-filter:none; background:var(--dsw-menu-surface-fill); min-width:180px; max-width:min(380px,calc(100vw - 24px)); padding:4px; border-radius:var(--vdw-radius-control); }
.vdw-menu button { min-height:36px; padding:8px 10px; gap:8px; font-size:13px; line-height:20px; border-radius:var(--vdw-radius-small); }
.vdw-menu button svg { width:16px; height:16px; }
.vdw-select-list { max-height:min(360px,calc(100vh - 48px)); overflow-y:auto; }
.vdw-field { display:flex; flex-direction:column; min-width:0; gap:8px; margin:0 0 16px; }
.vdw-field > label { font-size:13px; line-height:20px; font-weight:500; }
.vdw-field > small { margin-top:-2px; overflow-wrap:anywhere; }
.vdw-field > span:has(> input),.vdw-config-group > span:has(> input) { height:32px; min-height:32px; padding-inline:10px; border:1px solid transparent; border-radius:var(--vdw-radius-control); background:var(--vdw-input-bg); }
.vdw-field > span > input,.vdw-config-group > span > input { font-size:13px; line-height:20px; background:transparent; }
.vdw-field > button:not([role=switch]),.vdw-config-group button:not([role=switch]),.vdw-condition-row > button:not([role=switch]) { height:32px; font-size:13px; line-height:20px; }
:is(.vdw,.vdw-modal,.vdw-settings-section) textarea { width:100%; min-width:0; min-height:88px; padding:10px 12px; border:1px solid transparent; border-radius:var(--vdw-radius-control); background:var(--vdw-input-bg); color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; line-height:22px; resize:none; }
:is(.vdw,.vdw-modal,.vdw-settings-section) textarea::placeholder { color:var(--vdw-muted); opacity:1; }
:is(.vdw,.vdw-modal,.vdw-settings-section) textarea:disabled { opacity:.5; cursor:not-allowed; }
:is(.vdw,.vdw-modal,.vdw-settings-section) .vdw-code-editor { font-family:var(--dsw-font-family-mono,monospace); font-size:12px; line-height:20px; white-space:pre; overflow:auto; tab-size:2; }
.vdw-setting-row { display:flex; align-items:center; justify-content:space-between; gap:20px; min-width:0; padding:12px 0; margin:0 0 16px; border-bottom:.5px solid var(--dsw-alias-border-l2); }
.vdw-setting-row > div { display:flex; flex-direction:column; min-width:0; gap:4px; }
.vdw-setting-row > div > span,.vdw-setting-row > span { font-size:13px; line-height:20px; font-weight:500; }
.vdw-setting-row > :last-child { flex-shrink:0; }
.vdw-config-group { display:flex; flex-direction:column; min-width:0; gap:8px; padding:12px; margin:0 0 12px; border:1px solid var(--vdw-border); border-radius:var(--vdw-radius-control); background:var(--dsw-alias-bg-base); box-shadow:0 1px 2px rgb(0 0 0 / .04),0 3px 8px rgb(0 0 0 / .03); }
.vdw-config-group strong { font-size:13px; line-height:20px; font-weight:500; }
.vdw-config-group .vdw-between > span { font-size:13px; line-height:20px; }
.vdw-condition { display:flex; flex:1; flex-direction:column; gap:8px; min-width:0; }
.vdw-condition > span:has(> input) { height:32px; padding-inline:10px; border:1px solid transparent; border-radius:8px; background:var(--vdw-input-bg); }
.vdw-condition-row { display:flex; align-items:flex-start; gap:8px; padding:8px 0; border-top:.5px solid var(--vdw-border); }
.vdw-condition-row > button { flex:none; width:32px; padding:8px; }
.vdw-inline-inputs { display:flex; align-items:center; flex-wrap:wrap; gap:8px; min-width:0; }
.vdw-inline-inputs > span { flex:1; min-width:120px; height:32px; min-height:32px; padding-inline:10px; }
.vdw-inline-inputs > small { max-width:100%; overflow-wrap:anywhere; font-family:var(--dsw-font-family-mono,monospace); font-size:12px; line-height:20px; }
.vdw-inline-inputs > button { height:32px; width:32px; padding:8px; }
.vdw-role-preview { max-height:160px; overflow:auto; padding:12px; border:.5px solid var(--dsw-alias-border-l2); border-radius:var(--vdw-radius-control); white-space:pre-wrap; overflow-wrap:anywhere; color:var(--vdw-secondary); font-size:12px; line-height:20px; }

/* Inset editing cards: all actions remain native Harness controls. */
.vdw-field-label { display:flex; align-items:center; gap:4px; min-height:20px; font-size:13px; line-height:20px; font-weight:500; }
.vdw-help-button { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; min-height:20px; padding:3px; border:0; border-radius:4px; background:transparent; color:var(--vdw-muted); }
.vdw-help-button:hover { color:var(--vdw-secondary); background:var(--vdw-input-hover); }
.vdw-help-button svg { width:14px; height:14px; }
.vdw-config-actions { display:flex; align-items:center; flex:none; gap:4px; }
.vdw-config-actions :is(.vdw-icon-button,.vdw-help-button),.vdw-prompt-actions .vdw-icon-button { width:28px; min-width:28px; height:28px; padding:6px!important; border-radius:6px; color:var(--vdw-secondary); background:transparent; }
.vdw-config-actions .vdw-icon-button:hover,.vdw-prompt-actions .vdw-icon-button:hover { background:var(--vdw-input-hover); }
.vdw-config-actions > :last-child { margin-left:4px; }
.vdw-config-actions .vdw-icon-button[aria-pressed=true] { color:var(--vdw-accent); background:color-mix(in srgb,var(--vdw-accent) 10%,transparent); }
.vdw-node-name { display:block; width:100%; min-width:0; height:26px; padding:0; border:1px solid transparent; border-radius:4px; outline:none; background:transparent; color:inherit; font:600 16px/24px var(--dsw-font-family); text-overflow:ellipsis; }
.vdw-node-name:hover:not(:disabled) { background:var(--vdw-input-bg); }
.vdw-node-name:focus { background:var(--vdw-input-bg); border-color:var(--vdw-accent); }
.vdw-node-name:disabled { opacity:.65; }
.vdw-prompt-editor { min-width:0; margin-bottom:16px; overflow:hidden; border:1px solid transparent; border-radius:8px; background:var(--vdw-input-bg); }
.vdw-prompt-editor:focus-within { border-color:color-mix(in srgb,var(--vdw-accent) 60%,transparent); }
.vdw-prompt-header { display:flex; align-items:center; justify-content:space-between; gap:4px; min-height:40px; padding:6px 8px 2px 12px; }
.vdw-prompt-heading { display:flex; align-items:center; min-width:0; gap:4px; font-size:12px; line-height:18px; font-weight:600; color:var(--vdw-secondary); }
.vdw-prompt-heading > strong { font-size:12px; font-weight:600; }
.vdw-prompt-heading > span { display:none; }
.vdw-prompt-actions { display:flex; flex:none; align-items:center; gap:2px; }
.vdw-prompt-count { margin-right:4px; color:var(--vdw-muted); font-size:12px; line-height:18px; font-variant-numeric:tabular-nums; white-space:nowrap; }
:is(.vdw,.vdw-modal) .vdw-prompt-body { display:block; min-height:120px; margin:0; padding:4px 12px 12px; border:0; border-radius:0; outline:none; background:transparent; font-family:var(--dsw-font-family); font-size:13px; line-height:22px; }
:is(.vdw,.vdw-modal) .vdw-prompt-body:focus-visible { outline:none; }
.vdw-prompt-readonly .vdw-prompt-body { color:var(--vdw-secondary); }
.vdw-prompt-status { display:block; padding:0 12px 8px; color:var(--vdw-muted); font-size:12px; line-height:18px; }
.vdw-modal.vdw-prompt-modal { width:min(720px,calc(100vw - 32px)); }
.vdw-prompt-modal .vdw-prompt-body { min-height:260px; max-height:65vh; border-radius:8px; background:var(--vdw-input-bg); }
.vdw-modal.vdw-prompt-modal .vdw-prompt-body:focus-visible { outline:2px solid var(--vdw-accent); outline-offset:2px; }
.vdw-field > .vdw-preset-manage { align-self:flex-end; height:28px; padding:0 4px; font-size:12px; color:var(--vdw-secondary); }
.vdw-select-trigger:hover:not(:disabled) { background:var(--vdw-input-hover); }
:is(.vdw-field,.vdw-condition,.vdw-config-group) > span:has(> input):focus-within { border-color:var(--vdw-accent); }

/* Both inspectors float below the measured action row, without shrinking the canvas. */
.vdw-config,.vdw-run-panel,.vdw-variable-panel { position:absolute; right:12px; top:var(--vdw-inspector-top,60px); bottom:12px; width:min(360px,calc(100% - 24px)); height:auto; min-width:0; min-height:0; display:flex; flex-direction:column; overflow:hidden; background:var(--dsw-alias-bg-base); border:.5px solid var(--dsw-alias-border-l2); border-radius:16px; box-shadow:var(--dsw-elevation-soft); z-index:6; }
.vdw-config > header,.vdw-run-panel > header,.vdw-variable-panel > header { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:64px; flex:none; padding:12px 16px; }
.vdw-config > header > .vdw-config-title { display:flex; flex:1; flex-direction:column; min-width:0; gap:2px; }
.vdw-config > header strong,.vdw-run-panel > header strong,.vdw-variable-panel > header strong { display:block; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:16px; line-height:24px; font-weight:600; }
.vdw-config > header > button,.vdw-run-panel > header > button,.vdw-variable-panel > header > button { flex:none; width:28px; height:28px; padding:6px; }
.vdw-config > header > .vdw-node-badge { width:28px; height:28px; border-radius:8px; }
.vdw-node-description { flex:none; padding:0 16px 12px; color:var(--vdw-secondary); font-size:12px; line-height:18px; overflow-wrap:anywhere; }
.vdw-config-tabs { display:flex; gap:20px; flex:none; padding:0 16px; border-bottom:.5px solid var(--vdw-border); }
.vdw-config-tabs > button { position:relative; height:40px; padding:0; border:0; background:transparent; color:var(--vdw-muted); font-size:13px; line-height:20px; font-weight:500; }
.vdw-config-tabs > button:hover { background:var(--dsw-alias-interactive-bg-hover); }
.vdw-config-tabs > button[aria-selected=true] { color:var(--vdw-accent); }
.vdw-config-tabs > button[aria-selected=true]::after { content:''; position:absolute; bottom:0; left:0; right:0; height:2px; background:var(--vdw-accent); border-radius:2px; }
.vdw-config-body { flex:1; min-width:0; min-height:0; overflow:auto; padding:16px; overscroll-behavior:contain; }
.vdw-config > .vdw-config-body { display:flex; flex-direction:column; gap:var(--vdw-space-field); }
.vdw-config > .vdw-config-body > * { flex-shrink:0; }
.vdw-config > .vdw-config-body > :is(.vdw-field,.vdw-config-group,.vdw-prompt-editor,.vdw-setting-row,.vdw-subagent-card),.vdw-config-group > .vdw-field,.vdw-field > .vdw-config-group { margin:0; }
.vdw-config-body :is(.vdw-field,.vdw-config-group) > span:has(> input) { flex-shrink:0; height:var(--vdw-control-height); min-height:var(--vdw-control-height); }
.vdw-config-body :is(.vdw-field,.vdw-config-group) > button:not([role=switch]):not(.vdw-icon-button) { flex:none; min-height:var(--vdw-control-height); height:var(--vdw-control-height); background:var(--dsw-alias-bg-base); border:1px solid var(--vdw-border); border-radius:var(--vdw-radius-control); box-shadow:0 1px 2px rgb(0 0 0 / .04),0 3px 8px rgb(0 0 0 / .03); }
.vdw-config-body :is(.vdw-field,.vdw-config-group) > button:not([role=switch]):not(.vdw-icon-button):hover:not(:disabled) { background:var(--vdw-input-hover); }
.vdw-config-body details.vdw-config-group { display:block; padding:0; }
.vdw-config-body details.vdw-config-group > summary { height:var(--vdw-control-height); min-height:var(--vdw-control-height); padding:6px 12px; font-size:13px; line-height:20px; cursor:pointer; }
.vdw-config-body details.vdw-config-group > :not(summary) { margin:12px; }

.vdw-run-status { display:flex; align-items:center; gap:8px; padding:16px 0; font-size:14px; }
.vdw-run-status > small { margin-left:auto; }
.vdw-status-dot { display:inline-block; flex:none; width:8px; height:8px; border-radius:50%; background:var(--dsw-alias-label-tertiary); }
.vdw-status-dot[data-status=success],.vdw-run-status[data-status=success] > .vdw-status-dot { background:var(--dsw-alias-state-success-primary); }
.vdw-status-dot[data-status=failed],.vdw-run-status[data-status=failed] > .vdw-status-dot { background:var(--dsw-alias-state-error-primary); }
.vdw-status-dot[data-status=running],.vdw-run-status[data-status=running] > .vdw-status-dot { background:var(--vdw-accent); }
.vdw-execution { border-bottom:.5px solid var(--dsw-alias-border-l2); }
.vdw-execution > button { display:flex; align-items:center; gap:8px; width:100%; padding:16px 0; border:0; background:transparent; color:inherit; font:inherit; text-align:left; }
.vdw-execution > button > span:nth-child(2) { min-width:0; flex:1; overflow-wrap:anywhere; }
.vdw-execution > button > small { flex:none; white-space:nowrap; font-size:12px; line-height:18px; }
.vdw-execution-details { padding-bottom:16px; }
.vdw pre { max-width:100%; max-height:320px; overflow:auto; padding:12px; margin:8px 0 16px; border-radius:var(--vdw-radius-control); background:var(--dsw-alias-bg-layer-1); font-family:var(--dsw-font-family-mono,monospace); font-size:12px; line-height:20px; white-space:pre; user-select:text; }
.vdw-run-output h3 { margin:20px 0 12px; font-size:14px; line-height:22px; font-weight:500; }

/* Native settings content: no second navigation or modal shell. */
.vdw-settings-section { width:100%; min-width:0; max-width:960px; container:workflow-settings / inline-size; }
.vdw-settings-heading { margin-bottom:24px; }
.vdw-settings-heading h2 { font-size:18px; line-height:26px; font-weight:600; }
.vdw-settings-heading p { margin-top:8px; max-width:64ch; }
.vdw-settings-toolbar { display:flex; align-items:center; gap:12px; margin-bottom:24px; }
.vdw-settings-toolbar > span { flex:1; min-width:0; height:36px; padding:0 12px; border-radius:var(--vdw-radius-control); }
.vdw-settings-toolbar > button { flex:none; height:36px; font-size:14px; line-height:22px; white-space:nowrap; }
.vdw-role-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(240px,100%),1fr)); gap:16px; }
.vdw-role-card { display:block; min-width:0; width:100%; padding:20px; border:1px solid var(--vdw-border); border-radius:var(--dsw-radius-xl,16px); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); text-align:left; font:inherit; }
.vdw-role-card:hover { background:var(--dsw-alias-interactive-bg-hover); }
.vdw-role-card > strong { display:block; font-size:14px; line-height:22px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vdw-role-card > p { display:-webkit-box; margin-top:8px; color:var(--vdw-secondary); font-size:12px; line-height:20px; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; }
.vdw-settings-error { display:flex; align-items:center; gap:12px; margin-bottom:16px; }

/* Dialogs and annotations use the same form vocabulary in either entry point. */
.vdw-modal { width:min(560px,100%); max-height:100%; }
.vdw-modal > div:first-child { min-height:0; overflow:auto; overscroll-behavior:contain; }
.vdw-modal > div:last-child:not(:first-child) { flex:none; flex-wrap:wrap; gap:8px; }
.vdw-modal .vdw-muted { margin:8px 0 16px; }
.vdw-modal .vdw-field:last-child { margin-bottom:0; }
.vdw-modal > div:last-child:not(:first-child) > button { height:36px; font-size:14px; line-height:22px; }
.vdw-human-prompt { max-height:260px; overflow:auto; padding:12px; margin-bottom:20px; border:.5px solid var(--vdw-border); border-radius:var(--vdw-radius-control); background:var(--dsw-alias-bg-layer-1); white-space:pre-wrap; overflow-wrap:anywhere; font-size:14px; line-height:22px; }
.vdw-file-input { display:flex; flex-direction:column; gap:8px; min-width:0; }
.vdw-file-input > input { max-width:100%; min-width:0; font:inherit; font-size:13px; }
.vdw-file-input small { overflow-wrap:anywhere; }
:is(.vdw,.vdw-modal,.vdw-settings-section) .vdw-error { color:var(--dsw-alias-state-error-primary); font-size:12px; line-height:20px; overflow-wrap:anywhere; }
.vdw-error-banner { position:absolute; bottom:16px; left:16px; right:16px; display:flex; align-items:center; gap:8px; padding:12px 16px; border:1px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-lg,12px); background:var(--dsw-alias-bg-base); box-shadow:var(--dsw-elevation-prominent); color:var(--dsw-alias-state-error-primary); font-size:12px; line-height:20px; z-index:10; }
.vdw-error-banner > span { flex:1; min-width:0; overflow-wrap:anywhere; }
.vdw-error-banner > button { flex:none; height:32px; font-size:13px; }

/* Responsive overrides live here only; the same floating bounds apply in either entry. */
.vdw-editor-body.is-inspector-compact > :is(.vdw-config,.vdw-run-panel,.vdw-variable-panel),
.vdw-editor-body:has(> .vdw-canvas-wrap.is-inspector-compact) > :is(.vdw-config,.vdw-run-panel,.vdw-variable-panel) { bottom:56px; }
.vdw-editor-body.is-inspector-compact .vdw-canvas-bottom,
.vdw-canvas-wrap.is-inspector-compact .vdw-canvas-bottom { right:12px; }
.vdw-editor-body.is-inspector-compact .vdw-minimap-shell,
.vdw-canvas-wrap.is-inspector-compact .vdw-minimap-shell { display:none; }
.vdw-editor-body.is-inspector-compact .vdw-canvas-bottom .vdw-control-label,
.vdw-canvas-wrap.is-inspector-compact .vdw-canvas-bottom .vdw-control-label { display:none; }
.vdw-editor-body.is-inspector-compact .vdw-canvas-bottom button:has(.vdw-control-label),
.vdw-canvas-wrap.is-inspector-compact .vdw-canvas-bottom button:has(.vdw-control-label) { width:var(--vdw-control-height); min-width:var(--vdw-control-height); padding:8px; gap:0; }
@container workflow (max-width:800px) {
  .vdw-library-heading { padding-left:20px; padding-right:20px; }
  .vdw-library-controls { padding-inline:20px; flex-wrap:wrap; }
  .vdw-library-controls > span:first-child { flex-basis:100%; }
  .vdw-library-filters { flex:1 0 100%; width:100%; }
  .vdw-library-heading { gap:12px; }
  .vdw-library-heading > .vdw-home-actions { width:auto; }
  .vdw-home-action-label { position:absolute; opacity:0; pointer-events:none; }
  .vdw-home-actions button { width:32px; min-width:32px; padding:0; gap:0; }
  .vdw-library-body { padding:20px; }
}
@container workflow (max-width:480px) {
  .vdw-library-heading { align-items:center; gap:12px; flex-wrap:nowrap; padding-top:20px; }
  .vdw-library-heading > .vdw-home-actions { width:auto; }
  .vdw-scope-breadcrumb > small { display:none; }
}
@container canvas (max-width:460px) {
  .vdw-node-picker { left:12px; width:calc(100% - 24px); }
  .vdw-canvas-bottom .vdw-control-label { display:none; }
  .vdw-canvas-bottom button:has(.vdw-control-label) { width:var(--vdw-control-height); min-width:var(--vdw-control-height); padding:8px; gap:0; }
}
@container canvas (max-width:359px) {
  .vdw-canvas-bottom { justify-content:flex-start; }
  .vdw-canvas-hint { bottom:104px; }
  .vdw-picker-tabs > button { padding-inline:10px; }
  .vdw-minimap-shell { bottom:104px; }
}
@container workflow-settings (max-width:480px) {
  .vdw-settings-toolbar { flex-wrap:wrap; }
  .vdw-settings-toolbar > span { flex-basis:100%; }
  .vdw-settings-toolbar > button { margin-left:auto; }
}
@media(prefers-reduced-motion:reduce) {
  :is(.vdw,.vdw-modal,.vdw-settings-section,.vdw-menu) * { transition:none!important; animation:none!important; }
}

.vdw-navigation-notice{position:absolute;bottom:64px;left:50%;transform:translateX(-50%);z-index:30;display:flex;align-items:center;gap:8px;max-width:90%;padding:8px 12px;border:1px solid var(--vdw-border);border-radius:10px;background:var(--dsw-alias-bg-base);box-shadow:0 4px 18px #0000000d;font-size:12px;white-space:nowrap}
.vdw-navigation-notice>span{overflow:hidden;text-overflow:ellipsis}
.vdw-ready-dot{width:6px;height:6px;border-radius:50%;background:#3975ff}
.vdw-prompt-expanded { display:flex; flex-direction:column; height:100%; min-height:0; }
.vdw-prompt-expanded .vdw-prompt-header { flex:none; }
:is(.vdw-modal,.vdw) .vdw-prompt-expanded .vdw-prompt-body { flex:1; height:100%; min-height:0; resize:none; font-size:14px; line-height:24px; }
${codeEditorStyles}
${dataViewerStyles}
${variableBrowserStyles}
${editorHeadingStyles}
${nodeBranchesStyles}

.vdw-variable-panel .vdw-config-body { display:flex; flex-direction:column; gap:16px; }
.vdw-variable-panel-intro { color:var(--vdw-secondary); font-size:13px; line-height:21px; }
.vdw-variable-panel-list { display:flex; flex-direction:column; gap:12px; }
.vdw-variable-panel-list .vdw-variable-card { min-width:0; overflow:hidden; border:1px solid var(--vdw-border); border-radius:8px; }
.vdw-variable-panel-list .vdw-variable-toolbar { display:flex; align-items:center; min-height:36px; padding:8px 12px; gap:8px; border-bottom:1px solid var(--vdw-border); background:var(--vdw-input-bg); }
.vdw-variable-panel-list .vdw-variable-type { flex:none; font-size:12px; color:var(--vdw-muted); }
.vdw-variable-panel-list .vdw-variable-toolbar > :first-child { flex:1; min-width:0; overflow-wrap:anywhere; }
.vdw-variable-panel-list .vdw-variable-toolbar strong { overflow:hidden; text-overflow:ellipsis; font-size:13px; }
.vdw-variable-panel-content { display:flex; flex-direction:column; gap:8px; padding:12px; font-size:13px; }
.vdw-variable-current-value { display:block; padding:8px; border-radius:6px; background:var(--vdw-input-bg); overflow-wrap:anywhere; white-space:pre-wrap; font-size:12px; }
.vdw-variable-references { display:flex; flex-direction:column; align-items:flex-start; gap:4px; }
.vdw-check-field { display:flex; align-items:center; gap:8px; font-size:13px; line-height:20px; }
.vdw-secret-unavailable { display:flex; align-items:flex-start; gap:8px; padding:12px; border:1px solid var(--vdw-border); border-radius:8px; font-size:13px; line-height:21px; color:var(--vdw-secondary); }
.vdw-secret-unavailable svg { flex:none; margin-top:3px; }
.vdw-json-preview { width:100%; min-height:200px; font-family:monospace!important; font-size:12px; line-height:20px; resize:none; }
.vdw-json-summary { display:flex; flex-direction:column; gap:8px; padding:12px; border:1px solid var(--vdw-border); border-radius:8px; }
.vdw-policy-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
@container workflow (max-width:420px) { .vdw-policy-fields { grid-template-columns:1fr; } }
.vdw-result-agent { display:flex; flex-direction:column; gap:4px; padding:12px; border-radius:8px; background:var(--vdw-input-bg); font-size:12px; }
.vdw-result-agent code { overflow-wrap:anywhere; }
.vdw-proposal-change { display:flex; flex-direction:column; gap:8px; margin-top:16px; }
${canvasTopActionsStyles}
[data-recovery-action=blocked] { color:var(--dsw-alias-state-error-primary); }
.vdw-agent-actions { display:grid; gap:12px; margin-top:12px; }
.vdw-agent-events { max-height:320px; overflow:auto; }
.vdw-agent-event { padding:8px 0; border-bottom:1px solid var(--vdw-border); }
.vdw-agent-event p { margin:4px 0; white-space:pre-wrap; overflow-wrap:anywhere; }
${selectStyles}
${advancedSettingsStyles}
${workflowMotionStyles}
${toolSelectionStyles}
${runRecoveryStyles}
${runDetailStyles}
.vdw-library-entry > .vdw-workflow-library { top:80px; left:32px; transform:none; width:min(420px,calc(100% - 64px)); max-height:calc(100% - 96px); }
`
