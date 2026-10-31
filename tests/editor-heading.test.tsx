import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorHeading } from '../src/client/editor-heading.tsx'
import { WorkflowApp, type WorkflowNavigation } from '../src/client/app.tsx'
import { WorkflowStore } from '../src/client/store.ts'
import { newNode } from '../src/client/nodes.ts'
import { makeWorkflow, type WorkflowAPI } from '../src/shared/types.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({
  Button:'button',Input:'input',Menu:()=>null,Modal:()=>null,
  Tooltip:({children}:{children:React.ReactNode})=>children,
}))
vi.mock('../src/client/canvas.tsx',()=>({Canvas:'canvas-mock'}))
vi.mock('../src/client/forms.tsx',()=>({Field:'field-mock',NodePanel:'node-panel-mock',Select:'select-mock'}))
vi.mock('../src/client/annotation-editor.tsx',()=>({AnnotationEditor:()=>null}))

const renderers:ReactTestRenderer[]=[],stores:WorkflowStore[]=[]
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount());for(const store of stores.splice(0))store.dispose()})
function render(element:React.ReactElement){let renderer!:ReactTestRenderer;act(()=>{renderer=create(element)});renderers.push(renderer);return renderer}
function app(){
  const container=newNode('iteration',100,100),flow={...makeWorkflow('workspace','一个很长的工作流名称，需要保留完整标题供悬停查看'),revision:7,nodes:[container],edges:[]}
  const store=new WorkflowStore({} as WorkflowAPI);stores.push(store)
  store.update({workflow:flow,page:'canvas',loading:false,library:{workflows:[flow],runs:[],presets:[],workspaces:[]}})
  const navigation:WorkflowNavigation={toFull:vi.fn(),toSide:vi.fn(),openChat:vi.fn(),openSettings:vi.fn(),getSessionId:()=> 'current-session'}
  const renderer=render(<WorkflowApp store={store} mode="side" navigation={navigation}/>)
  return{renderer,store,navigation,container,flow}
}

describe('浮动画布标题组件',()=>{
  it('将保存和另存为保留在同一操作组，并在保存中一起锁定',()=>{
    const onSave=vi.fn(),onSaveAs=vi.fn(),onBack=vi.fn(),renderer=render(<EditorHeading title="示例" revision={1} saveState="dirty" onBack={onBack} onSave={onSave} onSaveAs={onSaveAs}/>)
    const group=()=>renderer.root.findByProps({'aria-label':'保存操作'})
    expect(group().props.role).toBe('group');expect(group().findAllByType('button')).toHaveLength(2)
    expect(group().findAllByProps({name:'save-as'})).toHaveLength(1);expect(group().findAllByProps({name:'copy'})).toHaveLength(0)
    act(()=>group().findByProps({'aria-label':'保存工作流'}).props.onClick())
    act(()=>group().findByProps({'aria-label':'工作流另存为'}).props.onClick())
    expect(onSave).toHaveBeenCalledOnce();expect(onSaveAs).toHaveBeenCalledOnce();expect(onBack).not.toHaveBeenCalled()
    act(()=>renderer.update(<EditorHeading title="示例" revision={1} saveState="saving" onBack={onBack} onSave={onSave} onSaveAs={onSaveAs}/>))
    expect(group().findAllByType('button').every(button=>button.props.disabled)).toBe(true)
    expect(group().findByProps({'aria-label':'保存工作流'}).props['aria-busy']).toBe(true)
  })
  it('只在详情打开时为底部控件预留右侧空间，待处理清单不占整列',()=>{
    const {renderer,store,flow}=app()
    act(()=>store.update({readiness:{workflowId:flow.id,revision:flow.revision,canRun:false,issues:[{id:'unconnected',nodeId:flow.nodes[0]!.id,kind:'configuration',message:'节点未连接到用户输入入口',action:'node'}]},configId:''}))
    expect(renderer.root.findByType('canvas-mock' as never).props.inspectorOpen).toBe(false)
    act(()=>store.update({configId:flow.nodes[0]!.id}))
    expect(renderer.root.findByType('canvas-mock' as never).props.inspectorOpen).toBe(true)
    act(()=>store.update({configId:''}))
    expect(renderer.root.findByType('canvas-mock' as never).props.inspectorOpen).toBe(false)
    expect(store.getSnapshot().readiness?.issues).toHaveLength(1)
  })

  it.each([['saved','已保存'],['saving','正在保存'],['error','保存失败']] as const)('准确显示%s保存状态、版本和可访问完整标题', (saveState,label)=>{
    const title='包含很长说明且不应丢失的工作流名称',renderer=render(<EditorHeading title={title} revision={12} saveState={saveState} onBack={vi.fn()}/>)
    expect(renderer.root.findByType('header').props.className).toContain('vdw-editor-heading-floating')
    expect(renderer.root.findByProps({className:'vdw-editor-name'}).props.title).toBe(title)
    expect(renderer.root.findByProps({role:'status'}).children.join('')).toBe(`${label} · v12`)
    expect(renderer.root.findByProps({role:'status'}).props['data-state']).toBe(saveState)
    const indicator=renderer.root.findByProps({className:'vdw-editor-status-indicator'})
    expect(indicator.props['aria-label']).toBe(`${label} · v12`)
    expect(indicator.props.tabIndex).toBe(0)
    expect(indicator.findByProps({className:'vdw-editor-status-dot'}).props['data-state']).toBe(saveState)
    expect(renderer.root.findByProps({className:'vdw-editor-title-card'}).findAllByType('strong')).toHaveLength(1)
    expect(renderer.root.findAllByProps({'aria-label':'工作流路径'})).toHaveLength(0)
  })
  it('返回与标题各自独立，保留可选返回对话入口及面包屑回调',()=>{
    const onBack=vi.fn(),onReturnToChat=vi.fn(),onScope=vi.fn(),renderer=render(<EditorHeading title="示例" revision={1} saveState="saved" onBack={onBack} onReturnToChat={onReturnToChat} breadcrumb={<button onClick={onScope}>父流程</button>}/>)
    const row=renderer.root.findByProps({className:'vdw-editor-heading-row'})
    expect(row.findAllByType('button')).toHaveLength(2)
    expect(renderer.root.findByProps({className:'vdw-editor-title-card'}).findAllByType('button')).toHaveLength(0)
    act(()=>renderer.root.findByProps({'aria-label':'返回工作流主页'}).props.onClick())
    act(()=>renderer.root.findByProps({'aria-label':'返回对话'}).props.onClick())
    act(()=>renderer.root.findByProps({'aria-label':'工作流路径'}).findByType('button').props.onClick())
    expect(onBack).toHaveBeenCalledOnce();expect(onReturnToChat).toHaveBeenCalledOnce();expect(onScope).toHaveBeenCalledOnce()
  })
  it('放在画布定位容器中，子流程导航随标题浮动且返回父层仍清空选中',()=>{
    const{renderer,store,container}=app()
    expect(renderer.root.findByProps({className:'vdw-editor-body'}).findByType(EditorHeading)).toBeTruthy()
    act(()=>store.update({scopePath:[container.id],selected:[container.config.body!.nodes[0]!.id]}))
    const breadcrumb=renderer.root.findByProps({className:'vdw-scope-breadcrumb'})
    expect(breadcrumb.parent?.props['aria-label']).toBe('工作流路径')
    act(()=>breadcrumb.findAllByType('button').find(button=>button.children.includes('工作流'))!.props.onClick())
    expect(store.getSnapshot().scopePath).toEqual([])
    expect(store.getSnapshot().selected).toEqual([])
  })
  it('返回主页等待保存完成，期间保留当前画布及会话',async()=>{
    const{renderer,store,navigation}=app();let finish!:()=>void
    const saving=new Promise<void>(resolve=>{finish=resolve}),flush=vi.spyOn(store,'flush').mockReturnValue(saving)
    act(()=>renderer.root.findByProps({'aria-label':'返回工作流主页'}).props.onClick())
    expect(flush).toHaveBeenCalledOnce();expect(store.getSnapshot().page).toBe('canvas')
    await act(async()=>{finish();await saving})
    expect(store.getSnapshot().page).toBe('library')
    expect(navigation.openChat).not.toHaveBeenCalled()
  })
  it('所属工作区已移除时，仅视图状态保存失败仍能返回主页',async()=>{
    const{renderer,store}=app();(store.api as any).save=vi.fn(async()=>{throw new Error('工作区不存在，请在宿主中选择有效工作区')})
    store.update({viewport:{x:400,y:300,scale:.5}});expect(store.getSnapshot().saveState).toBe('saved')
    await act(async()=>{renderer.root.findByProps({'aria-label':'返回工作流主页'}).props.onClick();for(let index=0;index<12;index++)await Promise.resolve()})
    expect((store.api as any).save).toHaveBeenCalledOnce()
    expect(store.getSnapshot()).toMatchObject({page:'library',saveState:'saved',error:''})
  })
  it('保存失败不离开画布且保留错误提示',async()=>{
    const{renderer,store}=app();vi.spyOn(store,'flush').mockRejectedValue(new Error('保存暂时失败'))
    await act(async()=>{renderer.root.findByProps({'aria-label':'返回工作流主页'}).props.onClick();await Promise.resolve()})
    expect(store.getSnapshot().page).toBe('canvas')
    expect(renderer.root.findByProps({role:'alert'}).children[0]!.props.children).toContain('保存暂时失败')
    expect(renderer.root.findByType(EditorHeading)).toBeTruthy()
  })
})
