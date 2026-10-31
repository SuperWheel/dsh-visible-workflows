import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowViews, workflowEntrySession } from '../src/client/navigation.ts'
import { makeWorkflow, type WorkflowAPI } from '../src/shared/types.ts'

const active:WorkflowViews[]=[]
afterEach(()=>{for(const views of active.splice(0))views.dispose()})
function setup(){
  const flow={...makeWorkflow('w','A',true),id:'a',revision:1}
  const api={list:async()=>({workflows:[flow],presets:[],runs:[],workspaces:[]}),models:async()=>[],get:async()=>flow,save:async(raw:string)=>({...JSON.parse(raw),revision:2})} as unknown as WorkflowAPI
  const views=new WorkflowViews(api);active.push(views);return{views,flow,api}
}
describe('工作流统一使用宿主原生侧栏',()=>{
  it('左侧主页沿用准确的当前对话，不启动新会话或选择最近聊天',async()=>{
    const startSession=vi.fn(),host={selectedSession:()=> 'exact-current',isBlankSession:()=>false,startSession}
    expect(await workflowEntrySession(host)).toBe('exact-current')
    expect(startSession).not.toHaveBeenCalled()
  })
  it('没有当前会话时仅等待宿主自己的空白会话，不借已有聊天',async()=>{
    let selected:string|undefined
    const startSession=vi.fn(),host={selectedSession:()=>selected,isBlankSession:(id:string)=>id==='native-blank',startSession}
    expect(await workflowEntrySession(host,()=>true,async()=>{selected='native-blank'})).toBe('native-blank')
    expect(startSession).toHaveBeenCalledOnce()
    selected=undefined
    expect(await workflowEntrySession(host,()=>true,async()=>{selected='unrelated-existing'})).toBeUndefined()
  })
  it('新会话等待期间的后续导航获胜，不把页面拉回工作流',async()=>{
    let current=true
    const host={selectedSession:()=>undefined,isBlankSession:()=>true,startSession:vi.fn()}
    expect(await workflowEntrySession(host,()=>current,async()=>{current=false})).toBeUndefined()
  })
  it('主页与原生放大不重建编辑器，画布、选中、草稿、撤销及其他会话保持独立',async()=>{
    const{views,flow}=setup(),editor=views.session('current'),other=views.session('other')
    await editor.open(flow.id)
    editor.edit({...flow,title:'edited'})
    editor.update({annotationDraft:{text:'unsent',nodeIds:[flow.nodes[1]!.id]},generateDraft:'draft',selected:[flow.nodes[1]!.id],configId:flow.nodes[1]!.id,viewport:{x:100,y:200,scale:.5}})
    const state=editor.getSnapshot(),{readiness,readinessState,readinessError,...editingState}=state
    expect(views.management('current')).toBe(editor)
    expect(editor.getSnapshot()).toMatchObject({...editingState,page:'library'})
    await editor.open(flow.id)
    expect(editor.getSnapshot()).toMatchObject({...editingState,page:'canvas'})
    // Reopening may recheck external dependencies; it must retain the exact
    // editing objects, not merely recreate an equivalent empty editor.
    for(const key of ['workflow','annotationDraft','selected','undo','redo','viewport'] as const)expect(editor.getSnapshot()[key]).toBe(state[key])
    expect(views.session('current')).toBe(editor)
    expect(other.getSnapshot().workflow).toBeUndefined()
    expect(other.getSnapshot().annotationDraft).toBeUndefined()
  })
  it('显式关联到另一会话时同一个store不会同时污染两个会话',async()=>{
    const{views,flow}=setup(),editor=views.session('source')
    await editor.open(flow.id);editor.update({annotationDraft:{text:'keep',nodeIds:[flow.nodes[1]!.id]}})
    await views.attach(editor,'target')
    expect(views.session('target')).toBe(editor)
    expect(editor.getSnapshot().annotationDraft?.text).toBe('keep')
    expect(views.session('source')).not.toBe(editor)
    expect(views.session('source').getSnapshot().annotationDraft).toBeUndefined()
  })
  it.each(['annotation','generation'] as const)('目标会话存在%s编辑框时拒绝覆盖，包括空白需求',async kind=>{
    const{views,flow,api}=setup(),source=views.session('source'),destination=views.session('destination')
    await source.open(flow.id);await destination.open(flow.id)
    source.update({annotationDraft:{text:'source unsent',nodeIds:[flow.nodes[0]!.id]}})
    destination.update(kind==='annotation'?{annotationDraft:{text:'',nodeIds:[flow.nodes[1]!.id]}}:{generateDraft:''})
    const beforeSource=source.getSnapshot(),beforeDestination=destination.getSnapshot()
    api.save=vi.fn(api.save)
    await expect(views.attach(source,'destination')).rejects.toThrow('目标对话存在未提交的工作流需求')
    expect(views.session('source')).toBe(source);expect(views.session('destination')).toBe(destination)
    expect(source.getSnapshot()).toBe(beforeSource);expect(destination.getSnapshot()).toBe(beforeDestination)
    expect(api.save).not.toHaveBeenCalled()
  })
  it('保存等待期间目标新打开需求编辑框，也不得替换其store或草稿',async()=>{
    const{views,flow,api}=setup(),source=views.session('source'),destination=views.session('destination')
    await source.open(flow.id);await destination.open(flow.id)
    source.edit({...flow,title:'source pending save'})
    let complete!:(saved:typeof flow)=>void
    api.save=vi.fn(()=>new Promise(resolve=>{complete=resolve})) as WorkflowAPI['save']
    const attaching=views.attach(source,'destination')
    destination.update({generateDraft:'new requirement while saving'})
    complete({...flow,title:'source pending save',revision:2})
    await expect(attaching).rejects.toThrow('目标对话存在未提交的工作流需求')
    expect(views.session('source')).toBe(source);expect(views.session('destination')).toBe(destination)
    expect(destination.getSnapshot().generateDraft).toBe('new requirement while saving')
  })
  it('已提交或关闭编辑框后允许显式关联，同一个store继续编辑不受保护条件阻止',async()=>{
    const{views,flow}=setup(),source=views.session('source'),destination=views.session('destination')
    await source.open(flow.id)
    source.update({generateDraft:'own draft'})
    await views.attach(source,'source')
    expect(views.session('source')).toBe(source)
    destination.update({generateDraft:''});destination.update({generateDraft:undefined})
    await views.attach(source,'destination')
    expect(views.session('destination')).toBe(source)
    expect(source.getSnapshot().generateDraft).toBe('own draft')
  })
})
