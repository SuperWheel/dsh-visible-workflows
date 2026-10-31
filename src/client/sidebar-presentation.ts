/** The native sidebar owns fullscreen, tab placement and split geometry. The
 * workflow asks for a mode only after an explicit action on its current tab. */
interface Target { sessionId:string; tabId?:string; host:string }
interface Tab { id:string; kind:string }
export interface WorkflowSidebarHost<T extends Target> {
  mounted:{getSnapshot():string|undefined}
  active():Tab|undefined
  commandTarget():T|undefined
  isTargetCurrent(target:T):boolean
  toggleFullscreen(target:T):void
}
export function setWorkflowSidebarFullscreen<T extends Target>(host:WorkflowSidebarHost<T>,sessionId:string,fullscreen:boolean,requested:boolean):boolean {
  if(fullscreen===requested||host.mounted.getSnapshot()!==sessionId)return false
  const active=host.active(),target=host.commandTarget()
  if(!active||active.kind!=='visible-workflows'||!target||target.sessionId!==sessionId||target.tabId!==active.id||target.host!=='dock'||!host.isTargetCurrent(target))return false
  host.toggleFullscreen(target)
  return true
}

/** This SDK exposes only a panel-row icon slot. Capture activation on this
 * contribution's own row so its hard-coded central-panel click never runs.
 * Native buttons produce the same click for pointer, Enter and Space. */
export function bindWorkflowSidebarEntry(icon:Element,activate:()=>void):()=>void {
  const button=icon.closest('button')
  if(!button)return()=>{}
  const click=(event:Event)=>{event.preventDefault();event.stopPropagation();activate()}
  button.addEventListener('click',click,true)
  return()=>button.removeEventListener('click',click,true)
}
