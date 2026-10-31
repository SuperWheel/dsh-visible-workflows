/** The readiness list scrolls above the overview instead of covering its controls. */
export const canvasOverviewStyles=`
.vdw-editor-body { --vdw-overview-clearance:198px; }
.vdw-editor-body:has(> .vdw-canvas-wrap .vdw-minimap-shell.is-collapsed) { --vdw-overview-clearance:110px; }
.vdw-editor-body:has(> .vdw-canvas-wrap.is-overview-tiny) { --vdw-overview-clearance:242px; }
.vdw-editor-body:has(> .vdw-canvas-wrap.is-overview-tiny .vdw-minimap-shell.is-collapsed) { --vdw-overview-clearance:154px; }
.vdw-editor-body > .vdw-editor-dock:not(.has-details),
.vdw-editor-body:has(> .vdw-canvas-wrap.is-inspector-compact) > .vdw-editor-dock { bottom:min(var(--vdw-overview-clearance),max(60px,calc(100% - var(--vdw-inspector-top,60px) - 46px))); }
.vdw-editor-body:has(> .vdw-canvas-wrap.is-inspector-compact) > .vdw-editor-dock.has-details { overflow:auto; overscroll-behavior:contain; pointer-events:auto; }
.vdw-editor-body.is-inspector-compact .vdw-minimap-shell,
.vdw-canvas-wrap.is-inspector-compact .vdw-minimap-shell { display:block; right:12px; }
`
