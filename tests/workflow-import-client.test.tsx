import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowTransfer } from '../src/client/workflow-transfer.tsx'
import { WorkflowStore } from '../src/client/store.ts'
import { Select } from '../src/client/controls.tsx'
import { exportWorkflowJson } from '../src/shared/workflow-format.ts'
import type { WorkflowImportOptions, WorkflowImportPreview } from '../src/shared/workflow-import.ts'
import { makeWorkflow, type Workflow, type WorkflowAPI } from '../src/shared/types.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Input:'input',Tooltip:({children}:any)=><>{children}</>,Menu:({anchor,...props}:any)=><menu-mock {...props}>{anchor}</menu-mock>,Modal:({children,footer,...props}:any)=><modal-mock {...props}>{children}{footer}</modal-mock>}))
const renderers:ReactTestRenderer[]=[],stores:WorkflowStore[]=[]
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount());for(const store of stores.splice(0))store.dispose();vi.unstubAllGlobals()})
function fixture(mode:'import'|'export'='import'){
  const flow={...makeWorkflow('workspace','existing',true),revision:3},library={workflows:[flow],presets:[],runs:[],workspaces:[{id:'workspace',name:'工作区'}]}
  const preview:WorkflowImportPreview={title:'incoming',nodeCount:2,edgeCount:1,environmentCount:0,canImport:true,dependencies:[],warnings:[],errors:[]}
  const api={list:vi.fn(async()=>library),get:vi.fn(async()=>flow),models:vi.fn(async()=>[]),presets:vi.fn(async()=>[]),start:vi.fn(),previewImport:vi.fn(async()=>preview),importPackage:vi.fn()} as unknown as WorkflowAPI
  const store=new WorkflowStore(api);stores.push(store);store.update({workflow:flow,library,sessionId:'session',loading:false,page:'canvas'})
  const close=vi.fn();let ui!:ReactTestRenderer;act(()=>{ui=create(<WorkflowTransfer store={store} initialMode={mode} onClose={close}/>)});renderers.push(ui)
  const button=(label:string)=>ui.root.findAllByType('button').find(value=>value.children.includes(label))!
  const text=exportWorkflowJson(flow),input=()=>ui.root.findByProps({'aria-label':'选择工作流 JSON 或 ZIP 文件'})
  const choose=async(value=text,name='flow.json')=>{await act(async()=>input().props.onChange({target:{files:[{name,type:'application/json',size:value.length,text:async()=>value}]}}))}
  return {flow,api,store,ui,button,text,preview,close,input,choose}
}
describe('file import mapping and overwrite confirmation',()=>{
  it('uses a floating library with two destination modes and a clickable dropzone without a JSON editor',()=>{
    const {ui}=fixture()
    expect(ui.root.findAllByType('modal-mock')).toHaveLength(0)
    expect(ui.root.findByProps({'aria-label':'拖入文件或点击导入'}).children).toEqual(['拖入文件或点击导入'])
    expect(ui.root.findAllByType('textarea')).toHaveLength(0)
    expect(ui.root.findAllByType(Select).find(value=>value.props.label==='JSON 导入覆盖目标')!.props.options).toEqual([{id:'new',label:'导入到新的画布'},{id:'current',label:'导入到当前画布'}])
  })
  it('automatically checks ZIP files and atomically imports them without putting binary content in an editor',async()=>{
    const {api,ui,button,preview,flow,close,input}=fixture(),zip=new Uint8Array([80,75,3,4]),base64=btoa(String.fromCharCode(...zip)),incoming={...flow,id:'archive-incoming'}
    api.previewArchive=vi.fn(async()=>preview);api.importArchive=vi.fn(async()=>incoming);vi.mocked(api.get).mockResolvedValue(incoming)
    await act(async()=>input().props.onChange({target:{files:[{name:'flow.zip',type:'application/zip',size:zip.length,arrayBuffer:async()=>zip.buffer}]}}))
    expect(ui.root.findAllByType('textarea')).toHaveLength(0)
    expect(api.previewArchive).toHaveBeenCalledExactlyOnceWith(base64,'workspace',{mappings:[]},'session');expect(api.previewImport).not.toHaveBeenCalled()
    await act(async()=>button('导入到新的画布').props.onClick());expect(api.importArchive).toHaveBeenCalledExactlyOnceWith(base64,'workspace',{mappings:[]},'session');expect(api.importPackage).not.toHaveBeenCalled();expect(api.start).not.toHaveBeenCalled();expect(close).toHaveBeenCalledOnce()
  })
  it('rejects oversized JSON and ZIP before reading their content',async()=>{
    const {ui,input}=fixture(),text=vi.fn(),arrayBuffer=vi.fn()
    await act(async()=>input().props.onChange({target:{files:[{name:'big.json',type:'application/json',size:8_000_001,text}]}}));expect(text).not.toHaveBeenCalled();expect(JSON.stringify(ui.toJSON())).toContain('JSON 不能超过 8 MB')
    await act(async()=>input().props.onChange({target:{files:[{name:'big.zip',type:'application/zip',size:32_000_001,arrayBuffer}]}}));expect(arrayBuffer).not.toHaveBeenCalled();expect(JSON.stringify(ui.toJSON())).toContain('完整流程包不能超过 32 MB')
  })
  it('accepts dropped JSON, previews its actual layout and removes the selected file',async()=>{
    const {ui,api,button,text}=fixture(),preventDefault=vi.fn()
    await act(async()=>ui.root.findByProps({'aria-label':'拖入文件或点击导入'}).props.onDrop({preventDefault,dataTransfer:{files:[{name:'dropped.json',size:text.length,type:'application/json',text:async()=>text}]}}))
    expect(preventDefault).toHaveBeenCalledOnce();expect(api.previewImport).toHaveBeenCalledOnce()
    expect(ui.root.findByProps({'aria-label':'待导入流程预览'}).findAllByType('svg').length).toBeGreaterThan(0)
    act(()=>ui.root.findByProps({'aria-label':'移除待导入流程'}).props.onClick())
    expect(ui.root.findAllByProps({'aria-label':'待导入流程预览'})).toHaveLength(0);expect(button('导入到新的画布').props.disabled).toBe(true)
  })
  it('imports unresolved dependencies into the editable canvas without requiring mappings',async()=>{
    const {api,button,preview,close,choose}=fixture(),incoming={...makeWorkflow('workspace','缺少工具的导入流程',true),id:'incoming',revision:1}
    vi.mocked(api.previewImport!).mockResolvedValue({...preview,dependencies:[{kind:'tool',id:'builtin:missing',label:'需要连接的搜索工具',status:'missing',message:'导入后在节点中配置',choices:[]}]})
    vi.mocked(api.importPackage!).mockResolvedValue(incoming);vi.mocked(api.get).mockResolvedValue(incoming)
    await choose();expect(button('导入到新的画布').props.disabled).toBe(false)
    await act(async()=>button('导入到新的画布').props.onClick())
    expect(stores.at(-1)!.getSnapshot()).toMatchObject({page:'canvas',workflow:incoming});expect(api.start).not.toHaveBeenCalled();expect(close).toHaveBeenCalledOnce()
  })
  it('automatically rechecks a changed mapping and retains the file and mapping after a save conflict',async()=>{
    const {api,ui,button,text,preview,close,choose}=fixture()
    vi.mocked(api.previewImport!).mockResolvedValue({...preview,dependencies:[{kind:'tool',id:'builtin:old',label:'old',status:'missing',message:'待映射',choices:[{id:'builtin:new',label:'new',target:'builtin:new'}]}],canImport:false})
    await choose();expect(button('导入到新的画布').props.disabled).toBe(true)
    let resolveCheck!:(value:WorkflowImportPreview)=>void;vi.mocked(api.previewImport!).mockImplementationOnce(()=>new Promise(resolve=>{resolveCheck=resolve}))
    await act(async()=>ui.root.findAllByType(Select).find(value=>value.props.label==='映射 old')!.props.onChange(JSON.stringify('builtin:new')))
    expect(button('导入到新的画布').props.disabled).toBe(true)
    await act(async()=>resolveCheck({...preview,dependencies:[{kind:'tool',id:'builtin:old',label:'old',status:'ready',target:'builtin:new',message:'已匹配',choices:[{id:'builtin:new',label:'new',target:'builtin:new'}]}]}))
    expect(api.previewImport).toHaveBeenLastCalledWith(text,'workspace',{mappings:[{kind:'tool',id:'builtin:old',target:'builtin:new'}]},'session')
    vi.mocked(api.importPackage!).mockRejectedValue(new Error('目标已被修改'));await act(async()=>button('导入到新的画布').props.onClick())
    expect(ui.root.findAllByProps({'aria-label':'待导入流程预览'})).toHaveLength(1)
    expect(ui.root.findAllByType(Select).find(value=>value.props.label==='映射 old')!.props.value).toBe(JSON.stringify('builtin:new'))
    expect(close).not.toHaveBeenCalled();expect(api.start).not.toHaveBeenCalled()
  })
  it('requires explicit replacement confirmation and submits the checked revision',async()=>{
    const {flow,api,ui,button,text,preview,close,choose}=fixture()
    await act(async()=>ui.root.findAllByType(Select).find(value=>value.props.label==='JSON 导入覆盖目标')!.props.onChange('current'))
    vi.mocked(api.previewImport!).mockResolvedValue({...preview,overwrite:{workflowId:flow.id,title:flow.title,expectedRevision:3}});await choose()
    expect(button('导入到当前画布').props.disabled).toBe(true)
    act(()=>ui.root.findAllByType('input').find(value=>value.props.type==='checkbox')!.props.onChange({target:{checked:true}}));expect(button('导入到当前画布').props.disabled).toBe(false)
    vi.mocked(api.importPackage!).mockResolvedValue({...flow,revision:4});await act(async()=>button('导入到当前画布').props.onClick())
    expect(api.importPackage).toHaveBeenCalledExactlyOnceWith(text,'workspace',{mappings:[],overwrite:{workflowId:flow.id,expectedRevision:3}},'session');expect(api.start).not.toHaveBeenCalled();expect(close).toHaveBeenCalledOnce()
  })
  it('keeps a committed import successful and refreshes its local roles without replacing unrelated editor data',async()=>{
    const {api,store,choose,button,close,flow}=fixture(),incoming={...makeWorkflow('workspace','Imported local roles',true),id:'imported-role-flow',revision:1},local={id:'new-imported-role',name:'Local role',prompt:'Snapshot',scope:'workflow' as const,workflowId:'imported-role-flow',revision:1}
    incoming.nodes[1]!.kind='llm';incoming.nodes[1]!.config={prompt:'Task',rolePresetId:local.id}
    vi.mocked(api.importPackage!).mockResolvedValue(incoming);vi.mocked(api.presets).mockResolvedValue([local]);vi.mocked(api.list).mockResolvedValue({workflows:[flow,incoming],presets:[local],runs:[],workspaces:[]})
    await choose();await act(async()=>button('导入到新的画布').props.onClick())
    expect(close).toHaveBeenCalledOnce();expect(store.getSnapshot().workflow?.id).toBe(incoming.id)
    expect(store.getSnapshot().library.presets.find(role=>role.id===incoming.nodes[1]!.config.rolePresetId)).toEqual(local)
  })
  it('does not report a successful Host import as failed when its asset refresh is unavailable',async()=>{
    const {api,ui,store,choose,button,close}=fixture(),incoming={...makeWorkflow('workspace','Committed import',true),id:'committed-import',revision:1}
    vi.mocked(api.importPackage!).mockResolvedValue(incoming);vi.mocked(api.list).mockRejectedValue(new Error('Catalog offline'));vi.mocked(api.presets).mockRejectedValue(new Error('Roles offline'))
    await choose();await act(async()=>button('导入到新的画布').props.onClick())
    expect(api.importPackage).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();expect(store.getSnapshot().workflow?.id).toBe(incoming.id)
    expect(ui.root.findAllByProps({role:'alert'})).toHaveLength(0);expect(store.getSnapshot().libraryWarning).toContain('流程已保存')
  })
  it('ignores an earlier file read after a newer file has already been checked',async()=>{
    const {api,ui,input,choose,text}=fixture();let resolveRead!:(value:string)=>void
    await act(async()=>input().props.onChange({target:{files:[{name:'old.json',size:2,type:'application/json',text:()=>new Promise(resolve=>{resolveRead=resolve})}]}}))
    await choose(text,'new.json');await act(async()=>resolveRead('old stale content'))
    expect(api.previewImport).toHaveBeenCalledExactlyOnceWith(text,'workspace',{mappings:[]},'session')
    expect(ui.root.findByProps({'aria-label':'待导入流程预览'}).findByType('strong').props.title).toBe('new.json')
  })
  it('ignores a host check that finishes after its file has been removed',async()=>{
    const {api,ui,choose,preview,button}=fixture();let resolveCheck!:(value:WorkflowImportPreview)=>void
    vi.mocked(api.previewImport!).mockImplementationOnce(()=>new Promise(resolve=>{resolveCheck=resolve}));await choose()
    act(()=>ui.root.findByProps({'aria-label':'移除待导入流程'}).props.onClick());await act(async()=>resolveCheck(preview))
    expect(ui.root.findAllByProps({'aria-label':'待导入流程预览'})).toHaveLength(0);expect(button('导入到新的画布').props.disabled).toBe(true)
  })
})
describe('unified workflow export',()=>{
  it('shows an immutable highlighted JSON preview and switches to an actual SVG image',()=>{
    const {ui}=fixture('export')
    expect(ui.root.findAllByType('modal-mock')).toHaveLength(0)
    expect(ui.root.findByProps({'aria-label':'工作流 JSON 导出预览'}).props.readOnly).toBe(true)
    expect(ui.root.findAllByType('textarea')).toHaveLength(1)
    expect(ui.root.findByProps({className:'vdw-source-toolbar'})).toBeDefined()
    expect(ui.root.findByProps({className:'vdw-source-gutter'}).children).not.toHaveLength(0)
    act(()=>ui.root.findAllByType(Select).find(value=>value.props.label==='工作流导出格式')!.props.onChange('svg'))
    expect(ui.root.findAllByProps({'aria-label':'工作流 JSON 导出预览'})).toHaveLength(0)
    expect(decodeURIComponent(ui.root.findByType('img').props.src)).toContain('<svg')
    expect(ui.root.findAllByType('button').some(button=>button.children.includes('下载 SVG'))).toBe(true)
  })
  it('reuses the node code viewer copy and expansion controls while keeping both export views immutable',async()=>{
    const {ui,api,store}=fixture('export'),writeText=vi.fn(async()=>{}),source=store.getSnapshot().workflow,edit=vi.spyOn(store,'edit')
    vi.stubGlobal('navigator',{clipboard:{writeText}})
    const preview=()=>ui.root.findByProps({'aria-label':'工作流 JSON 导出预览'}),exported=preview().props.value
    expect(preview().props.readOnly).toBe(true)
    act(()=>preview().props.onChange({target:{value:'tampered JSON'}}))
    expect(preview().props.value).toBe(exported)
    await act(async()=>ui.root.findByProps({'aria-label':'复制工作流 JSON 导出预览'}).props.onClick())
    expect(writeText).toHaveBeenCalledExactlyOnceWith(exported)
    act(()=>ui.root.findByProps({'aria-label':'展开工作流 JSON 导出预览'}).props.onClick())
    const expanded=ui.root.findByProps({'aria-label':'工作流 JSON 导出预览（展开）'})
    expect(expanded.props.readOnly).toBe(true);expect(expanded.props.value).toBe(exported)
    act(()=>expanded.props.onChange({target:{value:'still cannot edit'}}))
    expect(expanded.props.value).toBe(exported);expect(preview().props.value).toBe(exported)
    expect(ui.root.findAllByProps({'aria-label':'格式化工作流 JSON 导出预览'})).toHaveLength(0)
    expect(store.getSnapshot().workflow).toBe(source);expect(edit).not.toHaveBeenCalled();expect(api.importPackage).not.toHaveBeenCalled()
  })
  it('reads fixed files only after an explicit complete-package download click',async()=>{
    const {api,button,flow}=fixture('export'),click=vi.fn(),createElement=vi.fn(()=>({href:'',download:'',click}))
    vi.stubGlobal('document',{createElement,addEventListener:vi.fn(),removeEventListener:vi.fn()});api.exportArchive=vi.fn(async()=>btoa('PK-test'))
    expect(api.exportArchive).not.toHaveBeenCalled();await act(async()=>button('下载完整流程包（含资料）').props.onClick())
    expect(api.exportArchive).toHaveBeenCalledOnce();expect(vi.mocked(api.exportArchive!).mock.calls[0]).toEqual([expect.objectContaining({id:flow.id,editor:expect.objectContaining({viewport:{x:32,y:40,scale:1},scopePath:[]})}),false,'session']);expect(click).toHaveBeenCalledOnce()
  })
})

/** Real WorkflowStore persistence: stale revisions throw just as the Host does. */
function persistentFixture(){
  const result=fixture(),remote=new Map<string,Workflow>([[result.flow.id,structuredClone(result.flow)]])
  const {api,store,flow,ui}=result
  api.save=vi.fn(async(raw:string,revision:number)=>{
    const incoming=JSON.parse(raw) as Workflow,existing=remote.get(incoming.id)
    if(existing?.revision!==revision)throw new Error('目标已被修改')
    const saved={...incoming,revision:revision+1};remote.set(saved.id,structuredClone(saved));return structuredClone(saved)
  })
  api.get=vi.fn(async(id:string)=>structuredClone(remote.get(id)!))
  api.list=vi.fn(async()=>({...store.getSnapshot().library,workflows:[...remote.values()].map(value=>structuredClone(value))}))
  api.previewImport=vi.fn(async(_text:string,_workspace:string,options:WorkflowImportOptions={})=>({title:'Imported',nodeCount:2,edgeCount:1,environmentCount:0,canImport:true,dependencies:[],warnings:[],errors:[],...(options.overwrite?{overwrite:{...options.overwrite,title:remote.get(options.overwrite.workflowId)!.title}}:{})}))
  api.importPackage=vi.fn(async(_text:string,workspace:string,options:WorkflowImportOptions={})=>{
    const target=options.overwrite&&remote.get(options.overwrite.workflowId)
    if(options.overwrite&&target?.revision!==options.overwrite.expectedRevision)throw new Error('导入目标版本冲突')
    const saved={...makeWorkflow(workspace,'Imported',true),id:target?.id??'new-imported',revision:(target?.revision??0)+1}
    remote.set(saved.id,structuredClone(saved));return structuredClone(saved)
  })
  const selectCurrent=async()=>{await act(async()=>ui.root.findAllByType(Select).find(value=>value.props.label==='JSON 导入覆盖目标')!.props.onChange('current'))}
  const confirm=()=>act(()=>ui.root.findAllByType('input').find(value=>value.props.type==='checkbox')!.props.onChange({target:{checked:true}}))
  const edit=(title:string)=>act(()=>store.edit({...store.getSnapshot().workflow!,title}))
  return {...result,remote,selectCurrent,confirm,edit,flow}
}

describe('import preserves real pending canvas edits',()=>{
  it('saves an initially dirty canvas before checking replacement and adopts the imported response without resaving the old definition',async()=>{
    const {api,store,flow,remote,edit,selectCurrent,choose,confirm,button,close}=persistentFixture()
    edit('Unsaved source');expect(store.getSnapshot().saveState).toBe('dirty')
    await selectCurrent()
    expect(api.save).toHaveBeenCalledOnce();expect(store.getSnapshot().workflow?.revision).toBe(4)
    await choose();expect(api.previewImport).toHaveBeenLastCalledWith(expect.any(String),'workspace',expect.objectContaining({overwrite:{workflowId:flow.id,expectedRevision:4}}),'session')
    confirm();await act(async()=>button('导入到当前画布').props.onClick())
    expect(api.importPackage).toHaveBeenCalledWith(expect.any(String),'workspace',expect.objectContaining({overwrite:{workflowId:flow.id,expectedRevision:4}}),'session')
    expect(api.save).toHaveBeenCalledOnce();expect(api.get).not.toHaveBeenCalled()
    expect(store.getSnapshot().workflow).toMatchObject({id:flow.id,title:'Imported',revision:5});expect(store.getSnapshot().saveState).toBe('saved')
    expect(remote.get(flow.id)).toMatchObject({title:'Imported',revision:5});expect(close).toHaveBeenCalledOnce()
    // The adopted workflow also remains normally editable after the import.
    edit('Edited imported flow');await act(async()=>store.flush());expect(remote.get(flow.id)).toMatchObject({title:'Edited imported flow',revision:6})
  })
  it('rechecks the new revision and clears replacement confirmation when the canvas is edited after checking',async()=>{
    const {api,ui,store,edit,selectCurrent,choose,confirm,button,flow}=persistentFixture()
    await selectCurrent();await choose();confirm();edit('Edited after check')
    await act(async()=>button('导入到当前画布').props.onClick())
    expect(api.importPackage).not.toHaveBeenCalled();expect(api.save).toHaveBeenCalledOnce()
    expect(api.previewImport).toHaveBeenLastCalledWith(expect.any(String),'workspace',expect.objectContaining({overwrite:{workflowId:flow.id,expectedRevision:4}}),'session')
    expect(ui.root.findAllByType('input').find(value=>value.props.type==='checkbox')!.props.checked).toBe(false)
    expect(button('导入到当前画布').props.disabled).toBe(true)
    expect(store.getSnapshot().workflow).toMatchObject({title:'Edited after check',revision:4})
    confirm();await act(async()=>button('导入到当前画布').props.onClick())
    expect(api.importPackage).toHaveBeenCalledOnce();expect(store.getSnapshot().workflow).toMatchObject({title:'Imported',revision:5})
  })
  it('does not create a new workflow when the source cannot be saved first',async()=>{
    const {api,ui,store,edit,choose,button,remote,close}=persistentFixture()
    edit('Keep these local edits');await choose();vi.mocked(api.save).mockRejectedValueOnce(new Error('保存版本冲突'))
    await act(async()=>button('导入到新的画布').props.onClick())
    expect(api.importPackage).not.toHaveBeenCalled();expect(remote.size).toBe(1);expect(close).not.toHaveBeenCalled()
    expect(store.getSnapshot().workflow?.title).toBe('Keep these local edits');expect(store.getSnapshot().saveState).toBe('error')
    expect(ui.root.findByProps({role:'alert'}).children.join('')).toContain('保存版本冲突')
  })
  it('saves a dirty source before creating and opening a new imported canvas',async()=>{
    const {api,store,flow,edit,choose,button,remote}=persistentFixture()
    edit('Saved source before import');await choose();await act(async()=>button('导入到新的画布').props.onClick())
    expect(remote.get(flow.id)).toMatchObject({title:'Saved source before import',revision:4})
    expect(store.getSnapshot().workflow).toMatchObject({id:'new-imported',title:'Imported',revision:1})
    expect(api.save).toHaveBeenCalledOnce();expect(vi.mocked(api.save).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.importPackage!).mock.invocationCallOrder[0]!)
  })
  it.each(['new','current'] as const)('keeps edits made while a %s import is pending and reports the successful import without flushing those edits over it',async(mode)=>{
    const {api,ui,store,flow,remote,choose,selectCurrent,confirm,edit,button,close}=persistentFixture()
    if(mode==='current')await selectCurrent()
    await choose();if(mode==='current')confirm()
    let resolveImport!:(value:Workflow)=>void;vi.mocked(api.importPackage!).mockImplementationOnce(()=>new Promise(resolve=>{resolveImport=resolve}))
    const label=mode==='current'?'导入到当前画布':'导入到新的画布'
    await act(async()=>button(label).props.onClick());edit('New edits while waiting')
    const imported={...makeWorkflow('workspace','Imported',true),id:mode==='current'?flow.id:'new-imported',revision:mode==='current'?4:1}
    remote.set(imported.id,structuredClone(imported));await act(async()=>resolveImport(imported))
    expect(api.save).not.toHaveBeenCalled();expect(api.get).not.toHaveBeenCalled()
    expect(store.getSnapshot().workflow).toMatchObject({id:flow.id,title:'New edits while waiting'});expect(store.getSnapshot().saveState).toBe('dirty')
    expect(store.getSnapshot().library.workflows.some(item=>item.id===imported.id&&item.title==='Imported')).toBe(true)
    expect(ui.root.findAllByProps({role:'alert'})).toHaveLength(0)
    expect(ui.root.findAllByProps({role:'status'}).some(item=>item.children.join('').includes('导入已完成'))).toBe(true)
    expect(button(label).props.disabled).toBe(true);expect(close).not.toHaveBeenCalled()
  })
})
