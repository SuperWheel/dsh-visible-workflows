import { describe, expect, it, vi } from 'vitest'
import { bindWorkflowSidebarEntry, setWorkflowSidebarFullscreen } from '../src/client/sidebar-presentation.ts'

function setup(){
  const target={sessionId:'s',tabId:'workflow',host:'dock'},tab={id:'workflow',kind:'visible-workflows'}
  const tabs=[tab,{id:'worker',kind:'cliworker'}]
  const host={mounted:{getSnapshot:()=> 's'},active:()=>tab,commandTarget:()=>target,isTargetCurrent:()=>true,toggleFullscreen:vi.fn()}
  return{host,target,tabs}
}
describe('原生侧栏全屏与其他插件隔离',()=>{
  it('只有明确的当前工作流按钮动作才调用宿主原生全屏；不替换其他tab或布局',()=>{
    const s=setup(),before=structuredClone(s.tabs)
    expect(setWorkflowSidebarFullscreen(s.host,'s',false,true)).toBe(true)
    expect(s.host.toggleFullscreen).toHaveBeenCalledExactlyOnceWith(s.target)
    expect(s.tabs).toEqual(before)
    expect(setWorkflowSidebarFullscreen(s.host,'s',true,true)).toBe(false)
    expect(s.host.toggleFullscreen).toHaveBeenCalledTimes(1)
  })
  it('收回全屏仍用同一宿主命令，不切换主区域或关闭tab',()=>{
    const s=setup()
    expect(setWorkflowSidebarFullscreen(s.host,'s',true,false)).toBe(true)
    expect(s.host.toggleFullscreen).toHaveBeenCalledExactlyOnceWith(s.target)
  })
  it.each(['background session','floating pane','stale target','foreign target','foreign active tab'])('不操作%s',scenario=>{
    const s=setup()
    if(scenario==='background session')s.host.mounted.getSnapshot=()=> 'other'
    if(scenario==='floating pane')s.target.host='float'
    if(scenario==='stale target')s.host.isTargetCurrent=()=>false
    if(scenario==='foreign target')s.target.tabId='worker'
    if(scenario==='foreign active tab')s.host.active=()=>({id:'worker',kind:'cliworker'})
    expect(setWorkflowSidebarFullscreen(s.host,'s',false,true)).toBe(false)
    expect(s.host.toggleFullscreen).not.toHaveBeenCalled()
  })
  it('入口只拦自己的原生行click，覆盖鼠标和键盘激活，卸载后完整解除',()=>{
    const activate=vi.fn(),addEventListener=vi.fn(),removeEventListener=vi.fn(),button={addEventListener,removeEventListener}
    const dispose=bindWorkflowSidebarEntry({closest:()=>button} as unknown as Element,activate)
    const handler=addEventListener.mock.calls[0]![1] as (event:Event)=>void
    expect(addEventListener.mock.calls[0]![0]).toBe('click')
    expect(addEventListener.mock.calls[0]![2]).toBe(true)
    for(const detail of [1,0]){
      const event={detail,preventDefault:vi.fn(),stopPropagation:vi.fn()} as unknown as Event
      handler(event)
      expect(event.preventDefault).toHaveBeenCalledOnce();expect(event.stopPropagation).toHaveBeenCalledOnce()
    }
    expect(activate).toHaveBeenCalledTimes(2)
    dispose();expect(removeEventListener).toHaveBeenCalledWith('click',handler,true)
  })
  it('没有自己宿主行时不添加全局或外部监听',()=>{
    const activate=vi.fn()
    expect(()=>bindWorkflowSidebarEntry({closest:()=>null} as unknown as Element,activate)()).not.toThrow()
    expect(activate).not.toHaveBeenCalled()
  })
})
