import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowApp, type WorkflowNavigation } from '../src/client/app.tsx'
import { WorkflowHomeCard } from '../src/client/workflow-home-card.tsx'
import { WorkflowLibraryPanel } from '../src/client/workflow-library-panel.tsx'
import { HighlightedCode } from '../src/client/code-editor.tsx'
import { Select } from '../src/client/controls.tsx'
import { WorkflowStore } from '../src/client/store.ts'
import { setLocale } from '../src/client/i18n.ts'
import { makeWorkflow, type WorkflowAPI } from '../src/shared/types.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:({icon,children,...props}:any)=><button {...props}>{icon}{children}</button>,Input:'input',Tooltip:({children,...props}:any)=><tooltip-mock {...props}>{children}</tooltip-mock>,Menu:({anchor,...props}:any)=><menu-mock {...props}>{anchor}</menu-mock>,Modal:({children,footer,...props}:any)=><modal-mock {...props}>{children}{footer}</modal-mock>}))
vi.mock('../src/client/canvas.tsx',()=>({Canvas:(props:any)=><canvas-mock {...props}/>,svgForWorkflow:vi.fn((flow:any)=>`<svg><title>${flow.title}</title></svg>`)}))
vi.mock('../src/client/editor-heading.tsx',()=>({EditorHeading:(props:any)=><heading-mock {...props}/>}))
const uis:ReactTestRenderer[]=[],stores:WorkflowStore[]=[]
afterEach(()=>{for(const ui of uis.splice(0))act(()=>ui.unmount());for(const store of stores.splice(0))store.dispose();setLocale('zh-CN');vi.unstubAllGlobals()})
function render(element:React.ReactElement){let ui!:ReactTestRenderer;act(()=>{ui=create(element)});uis.push(ui);return ui}
function fixture(){
  const editing={...makeWorkflow('workspace','当前未保存流程',true),id:'editing',revision:3},target={...makeWorkflow('workspace','指定卡片流程',true),id:'target-card',revision:7}
  editing.editor={viewport:{x:11,y:22,scale:.8},scopePath:[]};target.editor={viewport:{x:700,y:800,scale:.4},scopePath:[],annotations:[{id:'card-note',number:1,nodeIds:[target.nodes[0]!.id],text:'Card annotation only'}]}
  const api={get:vi.fn(async()=>target),save:vi.fn(),models:vi.fn(async()=>[]),templates:vi.fn(async()=>[]),presets:vi.fn(async()=>[]),list:vi.fn(),start:vi.fn(),exportArchive:vi.fn(async()=>btoa('PK'))} as unknown as WorkflowAPI
  const store=new WorkflowStore(api);stores.push(store);store.update({workflow:editing,page:'library',sessionId:'session',loading:false,library:{workflows:[editing,target],workspaces:[{id:'workspace',name:'工作区'}],presets:[],runs:[]}});store.edit({...editing,title:'当前未保存流程-新编辑'});const flush=vi.spyOn(store,'flush')
  const navigation:WorkflowNavigation={getSessionId:()=> 'session',openChat:()=>{},openSettings:()=>{},toFull:()=>{},toSide:()=>{}}
  const ui=render(<WorkflowApp store={store} mode="side" navigation={navigation}/>),card=()=>ui.root.findByProps({'data-workflow-id':target.id}),menu=()=>card().findByType('menu-mock' as never)
  return {api,store,editing,target,ui,card,menu,flush}
}

describe('workflow home entry points',()=>{
  it('keeps all three responsive header actions accessible and groups the two filters into an equal-column row',()=>{
    const {ui}=fixture()
    const actions=ui.root.findByProps({className:'vdw-actions vdw-home-actions'}).findAllByType('button')
    expect(actions.map(button=>button.props['aria-label'])).toEqual(['从模板创建','导入工作流','新建工作流'])
    expect(actions.every(button=>button.findAllByProps({className:'vdw-home-action-label'}).length===1)).toBe(true)
    expect(ui.root.findByProps({className:'vdw-actions vdw-home-actions'}).findAllByType('tooltip-mock' as never)).toHaveLength(3)
    expect(ui.root.findByProps({className:'vdw-library-filters'}).findAllByType(Select).map(select=>select.props.label)).toEqual(['筛选工作流','工作区筛选'])
  })
  it('opens the archive from the status selector without changing filters or mutating the current editor',async()=>{
    const {ui,store,api,flush}=fixture(),archived=vi.fn(async()=>[]),restore=vi.fn()
    Object.assign(api,{archived,restore})
    act(()=>store.update({search:'指定',workspaceFilter:'workspace',statusFilter:'failed'}))
    const before=store.getSnapshot(),selector=ui.root.findByProps({className:'vdw-library-filters'}).findAllByType(Select).find(select=>select.props.label==='筛选工作流')!
    expect(selector.props.options.map((option:any)=>option.id)).toEqual(['all','success','failed','running','archived'])
    expect(ui.root.findAllByProps({className:'vdw-library-meta'})).toHaveLength(0)
    expect(ui.root.findAllByType('button').filter(button=>button.children.includes('刷新')||button.children.includes('已归档'))).toHaveLength(0)
    await act(async()=>selector.props.onChange('archived'))
    expect(ui.root.findByType('modal-mock' as never).props.title).toBe('已归档工作流')
    expect(archived).toHaveBeenCalledExactlyOnceWith('');expect(restore).not.toHaveBeenCalled();expect(flush).not.toHaveBeenCalled();expect(api.start).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toMatchObject({search:'指定',workspaceFilter:'workspace',statusFilter:'failed',saveState:'dirty'})
    expect(store.getSnapshot().workflow).toBe(before.workflow)
  })
  it('shows the header divider shadow only while the card list is scrolled and resets it when returning home',()=>{
    const {ui,store}=fixture(),body=()=>ui.root.findByProps({className:'vdw-library-body'}),divider=()=>ui.root.findAllByType('div').find(node=>String(node.props.className).startsWith('vdw-library-divider'))!
    expect(divider().props.className).toBe('vdw-library-divider')
    act(()=>body().props.onScroll({currentTarget:{scrollTop:48}}));expect(divider().props.className).toBe('vdw-library-divider is-scrolled')
    act(()=>body().props.onScroll({currentTarget:{scrollTop:0}}));expect(divider().props.className).toBe('vdw-library-divider')
    act(()=>body().props.onScroll({currentTarget:{scrollTop:48}}));act(()=>store.update({page:'canvas'}));act(()=>store.update({page:'library'}))
    expect(divider().props.className).toBe('vdw-library-divider')
  })
  it('keeps loading accessible without a visible count row and translates the archive filter action',()=>{
    const {ui,store,api}=fixture();Object.assign(api,{archived:vi.fn(async()=>[])})
    act(()=>store.update({loading:true}));expect(ui.root.findByProps({className:'vdw-library-loading'}).children).toEqual(['正在加载工作流…'])
    expect(ui.root.findByProps({className:'vdw-library-body'}).props['aria-busy']).toBe(true)
    act(()=>setLocale('en'))
    const selector=ui.root.findByProps({className:'vdw-library-filters'}).findAllByType(Select).find(select=>select.props.label==='Filter workflows')!
    expect(selector.props.options.find((option:any)=>option.id==='archived').label).toBe('Archived workflows')
    expect(ui.root.findByProps({className:'vdw-library-loading'}).children).toEqual(['Loading workflows…'])
  })
  it.each(['从模板创建','导入工作流'])('opens %s as a centered native Modal from home, while canvas still uses a floating directory',async(label)=>{
    const {ui,store}=fixture()
    await act(async()=>ui.root.findByProps({'aria-label':label}).props.onClick())
    expect(ui.root.findByType('modal-mock' as never).props.className).toContain('vdw-home-workflow-modal')
    expect(ui.root.findAllByProps({className:'vdw-node-picker vdw-workflow-library'})).toHaveLength(0)
    const canvas=render(<WorkflowLibraryPanel store={store} onClose={()=>{}}/>);await act(async()=>{})
    expect(canvas.root.findByProps({className:'vdw-node-picker vdw-workflow-library'})).toBeDefined()
    expect(canvas.root.findAllByType('modal-mock' as never)).toHaveLength(0)
  })
  it('does not reserve inspector width when only the readiness notice is visible',()=>{
    const {ui,store}=fixture(),flow=store.getSnapshot().workflow!
    act(()=>store.update({page:'canvas',readiness:{workflowId:flow.id,revision:flow.revision,canRun:false,issues:[{id:'missing',kind:'model',action:'node',message:'请配置模型'}]}}))
    expect(ui.root.findByType('canvas-mock' as never).props.inspectorOpen).toBe(false)
  })
  it('uses the same export/copy/archive menu and handlers for ellipsis and right-click',()=>{
    const flow=makeWorkflow('workspace','卡片',true),copy=vi.fn(),exportFlow=vi.fn(),archive=vi.fn(),open=vi.fn(),ui=render(<WorkflowHomeCard workflow={flow} workspaceName="Workspace" status="尚未运行" onOpen={open} onCopy={copy} onExport={exportFlow} onArchive={archive}/>),menu=()=>ui.root.findByType('menu-mock' as never)
    expect(menu().props.items.map((item:any)=>item.id)).toEqual(['copy','export','delete'])
    act(()=>ui.root.findByProps({'aria-label':'工作流更多操作'}).props.onClick());expect(menu().props.open).toBe(true);expect(menu().props.getAnchorRect).toBeUndefined()
    act(()=>menu().props.onSelect('copy'));expect(copy).toHaveBeenCalledOnce()
    const preventDefault=vi.fn(),stopPropagation=vi.fn();act(()=>ui.root.findByType('article').props.onContextMenu({clientX:120,clientY:240,preventDefault,stopPropagation}))
    expect(preventDefault).toHaveBeenCalledOnce();expect(stopPropagation).toHaveBeenCalledOnce();expect(menu().props.open).toBe(true);expect(menu().props.getAnchorRect).toBeTypeOf('function')
    act(()=>menu().props.onSelect('export'));expect(exportFlow).toHaveBeenCalledOnce();expect(open).not.toHaveBeenCalled()
    act(()=>menu().props.onSelect('delete'));expect(archive).toHaveBeenCalledOnce()
  })
  it('places management first and uses the same action for ellipsis and right-click without opening the canvas',()=>{
    const flow=makeWorkflow('owner-workspace','卡片',true),manage=vi.fn(),open=vi.fn(),ui=render(<WorkflowHomeCard workflow={flow} workspaceName="Owner" status="尚未运行" onManage={manage} onOpen={open} onCopy={vi.fn()} onExport={vi.fn()} onArchive={vi.fn()}/>),menu=()=>ui.root.findByType('menu-mock' as never)
    expect(menu().props.items.map((item:any)=>item.id)).toEqual(['manage','copy','export','delete'])
    act(()=>ui.root.findByProps({'aria-label':'工作流更多操作'}).props.onClick());act(()=>menu().props.onSelect('manage'))
    expect(manage).toHaveBeenCalledOnce();expect(menu().props.open).toBe(false)
    act(()=>ui.root.findByType('article').props.onContextMenu({clientX:120,clientY:240,preventDefault:vi.fn(),stopPropagation:vi.fn()}));act(()=>menu().props.onSelect('manage'))
    expect(manage).toHaveBeenCalledTimes(2);expect(open).not.toHaveBeenCalled()
    act(()=>setLocale('en'));expect(menu().props.items[0].label).toBe('Manage workflow')
  })
  it('exports the specified card in an independent modal without opening, saving or changing the dirty current editor',()=>{
    const {ui,store,target,menu,flush,api}=fixture(),before=store.getSnapshot(),open=vi.spyOn(store,'open')
    act(()=>menu().props.onSelect('export'))
    expect(ui.root.findByType('modal-mock' as never).props.className).toContain('vdw-home-export-modal')
    const exported=JSON.parse(ui.root.findByType(HighlightedCode).props.value)
    expect(exported.workflow).toMatchObject({id:target.id,title:target.title,editor:{viewport:target.editor!.viewport,annotations:[{text:'Card annotation only'}]}})
    expect(store.getSnapshot().workflow).toBe(before.workflow);expect(store.getSnapshot().viewport).toEqual(before.viewport);expect(store.getSnapshot().page).toBe('library');expect(store.getSnapshot().saveState).toBe('dirty')
    expect(flush).not.toHaveBeenCalled();expect(open).not.toHaveBeenCalled();expect(api.save).not.toHaveBeenCalled();expect(api.get).not.toHaveBeenCalled()
    act(()=>ui.root.findByProps({'aria-label':'关闭导出工作流'}).props.onClick());expect(store.getSnapshot().workflow).toBe(before.workflow)
  })
  it('also exports a card when no canvas is currently open',()=>{
    const {ui,store,target,menu}=fixture();act(()=>store.update({workflow:undefined}))
    act(()=>menu().props.onSelect('export'))
    expect(ui.root.findByType('modal-mock' as never).props.title).toBe('导出工作流')
    expect(JSON.parse(ui.root.findByType(HighlightedCode).props.value).workflow.id).toBe(target.id)
    expect(store.getSnapshot().workflow).toBeUndefined()
  })
  it('keeps source isolation for a selected card complete-package download',async()=>{
    const {ui,store,target,menu,api,flush}=fixture(),click=vi.fn(),before=store.getSnapshot().workflow
    act(()=>menu().props.onSelect('export'))
    vi.stubGlobal('document',{createElement:()=>({click,href:'',download:''})})
    await act(async()=>ui.root.findAllByType('button').find(button=>button.children.includes('下载完整流程包（含资料）'))!.props.onClick())
    expect(api.exportArchive).toHaveBeenCalledExactlyOnceWith(target,false,'session');expect(click).toHaveBeenCalledOnce();expect(flush).not.toHaveBeenCalled();expect(store.getSnapshot().workflow).toBe(before)
  })
  it('updates entry labels and card menus in English without translating user-authored names',()=>{
    const {ui,menu,target}=fixture();act(()=>setLocale('en'))
    expect(ui.root.findAllByType('button').filter(button=>button.props['aria-label']==='Import workflow')).toHaveLength(1)
    expect(menu().props.items.map((item:any)=>item.label)).toEqual(['Manage workflow','Duplicate workflow','Export workflow','Archive workflow'])
    act(()=>menu().props.onSelect('export'))
    expect(ui.root.findByType('modal-mock' as never).props.title).toBe('Export workflow')
    expect(JSON.parse(ui.root.findByType(HighlightedCode).props.value).workflow.title).toBe(target.title)
  })
})
