import { describe, expect, it, vi } from 'vitest'
import { adaptWorkflowFullscreen, type WorkflowSidebarPresentation } from '../src/client/sidebar-presentation.ts'

function setup() {
  const before:WorkflowSidebarPresentation={sessionId:'s',tabId:'workflow',visible:true,fullscreen:false,width:1280}
  const after={...before,fullscreen:true}
  const target={sessionId:'s',tabId:'workflow',host:'dock'}
  const tab={id:'workflow',kind:'visible-workflows'}
  const host={mounted:{getSnapshot:()=> 's'},active:()=>tab,tabsIn:()=>[tab],commandTarget:()=>target,
    isTargetCurrent:()=>true,toggleFullscreen:vi.fn()}
  const expand=vi.fn()
  return {before,after,host,target,expand}
}
describe('sidebars belonging to other plugins remain shell-owned',()=>{
  it('retains the workflow-only explicit expand interaction',()=>{
    const s=setup()
    expect(adaptWorkflowFullscreen(s.before,s.after,s.host,s.expand)).toBe(true)
    expect(s.host.toggleFullscreen).toHaveBeenCalledExactlyOnceWith(s.target)
    expect(s.expand).toHaveBeenCalledOnce()
  })
  it.each(['cliworker','terminal','browser','files','guide','visible-workflows'])('never takes over a shared layout containing %s',kind=>{
    const s=setup()
    s.host.tabsIn=()=>[{id:'workflow',kind:'visible-workflows'},{id:'other',kind}]
    // Workflow remains visible in the first pane while another owns fullscreen.
    s.host.active=()=>({id:'other',kind})
    s.host.commandTarget=()=>({...s.target,tabId:'other'})
    expect(adaptWorkflowFullscreen(s.before,s.after,s.host,s.expand)).toBe(false)
    expect(s.host.toggleFullscreen).not.toHaveBeenCalled();expect(s.expand).not.toHaveBeenCalled()
  })
  it('also protects a background foreign tab when workflow is selected',()=>{
    const s=setup();s.host.tabsIn=()=>[{id:'workflow',kind:'visible-workflows'},{id:'worker',kind:'cliworker'}]
    expect(adaptWorkflowFullscreen(s.before,s.after,s.host,s.expand)).toBe(false)
    expect(s.host.toggleFullscreen).not.toHaveBeenCalled();expect(s.expand).not.toHaveBeenCalled()
  })
  it.each(['initial mount','show hidden tab','switch session','switch tab','narrow viewport','leave narrow viewport','already fullscreen'])('does not interpret %s as a workflow expand command',scenario=>{
    const s=setup();let previous:WorkflowSidebarPresentation|undefined=s.before
    if(scenario==='initial mount')previous=undefined
    if(scenario==='show hidden tab')previous={...s.before,visible:false}
    if(scenario==='switch session')previous={...s.before,sessionId:'other'}
    if(scenario==='switch tab')previous={...s.before,tabId:'other'}
    if(scenario==='narrow viewport')s.after.width=600
    if(scenario==='leave narrow viewport')previous={...s.before,width:600}
    if(scenario==='already fullscreen')previous={...s.before,fullscreen:true}
    expect(adaptWorkflowFullscreen(previous,s.after,s.host,s.expand)).toBe(false)
    expect(s.host.toggleFullscreen).not.toHaveBeenCalled();expect(s.expand).not.toHaveBeenCalled()
  })
  it.each(['background session','hidden workflow','floating pane','stale target','foreign target','foreign active tab'])('leaves %s untouched',scenario=>{
    const s=setup()
    if(scenario==='background session')s.host.mounted.getSnapshot=()=> 'other'
    if(scenario==='hidden workflow')s.after.visible=false
    if(scenario==='floating pane')s.target.host='float'
    if(scenario==='stale target')s.host.isTargetCurrent=()=>false
    if(scenario==='foreign target')s.target.tabId='worker'
    if(scenario==='foreign active tab')s.host.active=()=>({id:'worker',kind:'cliworker'})
    expect(adaptWorkflowFullscreen(s.before,s.after,s.host,s.expand)).toBe(false)
    expect(s.host.toggleFullscreen).not.toHaveBeenCalled();expect(s.expand).not.toHaveBeenCalled()
  })
})
