/** Plugin-owned surfaces only, including native portals carrying .vdw-menu/.vdw-modal. */
export const workflowMotionStyles=`
:is(.vdw,.vdw-menu,.vdw-modal) { --vdw-motion-duration:160ms; --vdw-motion-ease:cubic-bezier(.2,.7,.2,1); }
:is(.vdw-node-picker,.vdw-config,.vdw-run-panel,.vdw-variable-panel,.vdw-readiness-panel,.vdw-subagent-options,.vdw-workflow-management,.vdw-modal,.vdw-menu) {
  animation:vdw-surface-enter var(--vdw-motion-duration,160ms) var(--vdw-motion-ease,ease-out) both;
}
/* An embedded variable pane is content of the entering picker, not another floating surface. */
.vdw-variable-panel.is-embedded { animation:none; }
@keyframes vdw-surface-enter { from { opacity:0; translate:0 4px; } to { opacity:1; translate:0 0; } }
.vdw .vdw-home-action-label,.vdw .vdw-canvas-top-actions :is(.vdw-control-label,.vdw-selection-count) { transition:opacity var(--vdw-motion-duration,160ms) var(--vdw-motion-ease,ease-out); }
.vdw .vdw-library-divider::after { transition:opacity var(--vdw-motion-duration,160ms) var(--vdw-motion-ease,ease-out); }
@media (prefers-reduced-motion:reduce) {
  :is(.vdw,.vdw-menu,.vdw-modal),:is(.vdw,.vdw-menu,.vdw-modal) * { animation:none!important; transition:none!important; }
}
`
