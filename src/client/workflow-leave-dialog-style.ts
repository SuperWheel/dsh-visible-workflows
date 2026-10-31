/** Short native confirmation, using the workflow form/control dimensions. */
export const workflowLeaveDialogStyles=`
.vdw-modal.vdw-leave-dialog { width:min(480px,100%); max-height:100%; }
.vdw-leave-dialog .vdw-leave-message { margin:0; color:var(--vdw-secondary); font-size:13px; line-height:22px; overflow-wrap:anywhere; }
.vdw-leave-dialog .vdw-leave-workflow-title { display:block; margin-bottom:8px; color:var(--dsw-alias-label-primary); font-weight:600; }
.vdw-leave-dialog .vdw-leave-error { margin-top:12px; }
.vdw-leave-dialog > div:last-child:not(:first-child) > button { height:32px; min-height:32px; padding-inline:12px; font-size:13px; line-height:20px; }
`
