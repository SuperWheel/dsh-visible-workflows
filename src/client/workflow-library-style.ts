import { useEffect, useRef, type RefObject } from 'react'

/** The same outside-click and Escape dismissal used by the node directory. */
export function useWorkflowPanelDismiss(ref:RefObject<HTMLElement>,onClose:()=>void,busy=false,active=true){
  const returnTrigger=useRef<HTMLElement|null>(null)
  useEffect(()=>{
    if(!active||typeof document==='undefined')return
    if(!returnTrigger.current&&typeof HTMLElement!=='undefined'&&document.activeElement instanceof HTMLElement&&document.activeElement.matches('[data-workflow-library-trigger]'))returnTrigger.current=document.activeElement
    const outside=(event:Event)=>{const target=event.target as Element;if(!busy&&ref.current&&!ref.current.contains(target)&&!target.closest('[role=dialog],[role=menu],[role=listbox],[data-workflow-library-trigger]'))onClose()}
    const key=(event:KeyboardEvent)=>{if(busy||event.key!=='Escape'||event.defaultPrevented||(event.target as Element).closest('[role=dialog],[role=menu],[role=listbox]'))return;event.preventDefault();event.stopPropagation();const trigger=returnTrigger.current?.isConnected?returnTrigger.current:ref.current?.closest('.vdw')?.querySelector<HTMLButtonElement>('[data-workflow-library-trigger]');onClose();trigger?.focus()}
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',key)
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',key)}
  },[ref,onClose,busy,active])
}

export const workflowLibraryStyles=`
.vdw-home-workflow-modal.vdw-modal { display:flex; flex-direction:column; width:min(800px,calc(100vw - 48px)); height:min(800px,calc(100dvh - 48px)); max-height:100%; gap:0; padding:0; overflow:hidden; border-radius:20px; background:var(--dsw-alias-bg-base); }
.vdw-home-workflow-modal > .vdw-picker-heading { flex:none; min-height:48px; align-items:stretch; overflow:visible; padding:8px 16px 0; }
.vdw-home-workflow-modal > .vdw-picker-heading .vdw-picker-tabs { align-items:stretch; }
.vdw-home-workflow-modal > .vdw-picker-heading .vdw-picker-tabs > button { height:40px; }
.vdw-home-workflow-modal > .vdw-picker-heading .vdw-picker-tabs > button[aria-selected=true] { border-bottom:0; background:var(--dsw-alias-bg-base); }
.vdw-home-workflow-modal > .vdw-picker-heading > .vdw-icon-button { align-self:center; margin-bottom:8px; }
.vdw-home-workflow-modal.vdw-home-export-modal > .vdw-export-heading { min-height:44px; align-items:center; padding:8px 16px; }
.vdw-home-workflow-modal.vdw-home-export-modal > .vdw-export-heading > .vdw-icon-button { margin-bottom:0; }
.vdw-home-workflow-modal.vdw-home-export-modal > .vdw-library-content { padding-top:12px; }
.vdw-home-workflow-modal.vdw-modal > .vdw-library-content { flex:1; min-height:0; flex-wrap:nowrap; gap:16px; }
.vdw-home-workflow-modal.vdw-home-export-modal .vdw-export-thumbnail { min-height:180px; }
@media(max-width:480px) { .vdw-home-workflow-modal.vdw-modal { width:calc(100vw - 24px); height:calc(100dvh - 32px); max-height:100%; border-radius:16px; } }

.vdw-workflow-library.vdw-node-picker { width:min(480px,calc(100% - 76px)); max-height:min(640px,calc(100% - 24px)); }
.vdw-workflow-library .vdw-library-content { display:flex; flex-direction:column; gap:16px; min-height:0; overflow:auto; padding:16px; overscroll-behavior:contain; }
.vdw-workflow-library .vdw-library-content > *, .vdw-workflow-library .vdw-library-content .vdw-field { flex-shrink:0; }
.vdw-workflow-library .vdw-library-content .vdw-field { margin:0; gap:8px; }
.vdw-workflow-library .vdw-library-content > p { margin:0; }
.vdw-workflow-library .vdw-library-search { flex:none; display:flex; align-items:center; width:100%; height:32px; min-height:32px; }
.vdw-workflow-library .vdw-library-search > span { height:32px; min-height:32px; width:100%; background:var(--vdw-input-bg); border:1px solid transparent; border-radius:8px; padding:0 10px; }
.vdw-workflow-library .vdw-library-search input { height:100%; font-size:13px; }
.vdw-workflow-library .vdw-template-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
.vdw-workflow-library .vdw-template-tile { min-width:0; overflow:hidden; border:1px solid var(--vdw-border); border-radius:8px; background:var(--dsw-alias-bg-base); box-shadow:0 1px 2px #00000005,0 3px 8px #00000008; }
.vdw-workflow-library .vdw-template-use { display:flex; flex-direction:column; gap:12px; width:100%; aspect-ratio:1.12; padding:12px; border:0; color:inherit; background:transparent; text-align:left; }
.vdw-workflow-library .vdw-template-use:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }
.vdw-workflow-library .vdw-template-use > strong { width:100%; font-size:13px; line-height:20px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vdw-workflow-library .vdw-template-use > .vdw-workflow-thumbnail { flex:1; min-height:0; }
.vdw-workflow-thumbnail { display:grid; place-items:center; min-width:0; width:100%; min-height:88px; overflow:hidden; border-radius:6px; background:var(--vdw-input-bg); color:var(--vdw-muted); font-size:12px; }
.vdw-workflow-thumbnail > svg { display:block; width:100%; height:100%; max-height:240px; }
.vdw-workflow-thumbnail > span { padding:12px; text-align:center; }
.vdw-workflow-library .vdw-template-actions { display:flex; gap:4px; padding:0 8px 8px; }
.vdw-workflow-library .vdw-template-actions > button { height:28px; padding:0 8px; font-size:12px; }
.vdw-workflow-library .vdw-template-rename { display:flex; flex-direction:column; gap:8px; padding:12px; }
.vdw-workflow-library .vdw-template-rename > span { min-width:0; height:32px; }
.vdw-workflow-library .vdw-import-settings { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:12px; align-items:end; }
.vdw-workflow-library .vdw-select, .vdw-workflow-library .vdw-select-trigger { width:100%; min-width:0; }
.vdw-workflow-library .vdw-select-trigger { height:32px; min-height:32px; }
.vdw-workflow-library .vdw-import-dropzone { display:grid; place-items:center; width:100%; height:auto; min-height:0; aspect-ratio:4/3; padding:16px; border:1px dashed color-mix(in srgb,var(--vdw-accent) 30%,var(--vdw-border)); border-radius:12px; background:color-mix(in srgb,var(--vdw-accent) 3%,var(--dsw-alias-bg-base)); color:var(--vdw-secondary); font-size:13px; }
.vdw-workflow-library .vdw-import-dropzone:hover:not(:disabled),.vdw-workflow-library .vdw-import-dropzone.is-dragging { background:var(--vdw-input-bg); border-color:var(--vdw-accent); }
.vdw-workflow-library .vdw-import-file-input { display:none; }
.vdw-workflow-library .vdw-import-selection { position:relative; width:33.333%; min-width:112px; aspect-ratio:2/3; display:flex; flex-direction:column; gap:8px; padding:10px; border:1px solid var(--vdw-border); border-radius:8px; background:var(--dsw-alias-bg-base); box-shadow:0 1px 2px #00000005,0 3px 8px #00000008; }
.vdw-workflow-library .vdw-import-selection > strong { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; font-size:12px; line-height:18px; padding-right:8px; overflow-wrap:anywhere; }
.vdw-workflow-library .vdw-import-selection > .vdw-workflow-thumbnail { flex:1; min-height:0; }
.vdw-workflow-library .vdw-import-remove { position:absolute; top:6px; right:6px; display:grid; place-items:center; width:22px; height:22px; padding:0; border-radius:50%; border:1px solid var(--vdw-border); background:var(--dsw-alias-bg-base); color:var(--vdw-secondary); opacity:0; }
.vdw-workflow-library .vdw-import-selection:hover .vdw-import-remove,.vdw-workflow-library .vdw-import-selection:focus-within .vdw-import-remove { opacity:1; }
.vdw-workflow-library .vdw-import-details { display:flex; flex-direction:column; gap:12px; padding:12px; border:1px solid var(--vdw-border); border-radius:8px; font-size:12px; line-height:18px; }
.vdw-workflow-library .vdw-import-details .vdw-field { gap:8px; }
.vdw-workflow-library .vdw-import-details p { margin:0; }
.vdw-workflow-library .vdw-transfer-footer { display:flex; justify-content:flex-end; gap:8px; flex:none; border-top:1px solid var(--vdw-border); padding:12px 16px; }
.vdw-workflow-library .vdw-transfer-footer > button { height:32px; min-height:32px; }
.vdw-workflow-library .vdw-export-heading { padding:8px 12px; background:var(--dsw-alias-bg-base); }
.vdw-workflow-library .vdw-export-heading > strong { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; font-weight:600; }
.vdw-workflow-library .vdw-export-thumbnail { min-height:156px; display:grid; place-items:center; padding:12px; border:1px solid var(--vdw-border); border-radius:8px; background:var(--vdw-input-bg); }
.vdw-workflow-library .vdw-export-thumbnail img { display:block; width:100%; max-height:220px; object-fit:contain; }
.vdw-workflow-library .vdw-export-thumbnail .vdw-workflow-thumbnail { min-height:132px; }
.vdw-workflow-library .vdw-export-code { min-width:0; }
.vdw-workflow-library .vdw-export-code > .vdw-source-editor { width:100%; }
.vdw-workflow-library .vdw-export-extra { display:flex; flex-direction:column; gap:12px; font-size:12px; }
.vdw-workflow-library .vdw-export-extra > summary { cursor:pointer; }
.vdw-workflow-library .vdw-export-extra[open] > summary { margin-bottom:12px; }
.vdw-workflow-library .vdw-check-field { display:flex; align-items:flex-start; gap:8px; font-size:12px; line-height:18px; }
.vdw-workflow-library .vdw-check-field input { flex:none; margin:2px 0 0; }
@media (hover:none) { .vdw-workflow-library .vdw-import-remove { opacity:1; } }
@media (max-width:480px) { .vdw-workflow-library.vdw-node-picker { left:12px; width:calc(100% - 24px); } }
`
