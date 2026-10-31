import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TemplateDialog } from '../src/client/workflow-templates.tsx'
import { WorkflowLibraryPanel } from '../src/client/workflow-library-panel.tsx'
import { makeWorkflow, type WorkflowTemplate } from '../src/shared/types.ts'
import { WorkflowStore } from '../src/client/store.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Input:'input',Tooltip:({children}:any)=><>{children}</>,Menu:({anchor}:any)=><>{anchor}</>,Modal:({children,footer}:any)=><div>{children}{footer}</div>}))
vi.mock('../src/client/controls.tsx',()=>({Field:({children}:any)=><div>{children}</div>,Select:({label,value,options,onChange,disabled}:any)=><select aria-label={label} value={value} disabled={disabled} onChange={event=>onChange(event.target.value)}>{options.map((item:any)=><option key={item.id} value={item.id}>{item.label}</option>)}</select>}))
const renderers:ReactTestRenderer[]=[]
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount())})
async function setup(shell=false){
  const flow=makeWorkflow('workspace','Current',true),created={...makeWorkflow('workspace','Created'),revision:1},base={description:'Template description',revision:1,createdAt:'2026-10-16T00:00:00.000Z',updatedAt:'2026-10-16T00:00:00.000Z'},templates:WorkflowTemplate[]=[{...base,id:'builtin',scope:'builtin',title:'Builtin'},{...base,id:'personal',scope:'personal',title:'Personal',thumbnail:{nodes:flow.nodes,edges:flow.edges}}]
  const state={workflow:flow,library:{workspaces:[{id:'workspace',name:'Workspace'}],workflows:[flow],runs:[],presets:[]}}
  const api={templates:vi.fn(async()=>[...templates]),archivedTemplates:vi.fn(),saveTemplate:vi.fn(),renameTemplate:vi.fn(async(id,title)=>{templates[1]!.title=title;return templates[1]!}),removeTemplate:vi.fn(async(id:string,revision:number)=>{const index=templates.findIndex(template=>template.id===id&&template.revision===revision);templates.splice(index,1)}),useTemplate:vi.fn(async()=>created),start:vi.fn()}
  const store={api,getSnapshot:()=>state,subscribe:()=>()=>{},refreshImportedAssets:vi.fn(async()=>{}),flush:vi.fn(async()=>{}),open:vi.fn(async()=>{}),update:vi.fn((patch:any)=>Object.assign(state,patch))} as unknown as WorkflowStore
  const onClose=vi.fn();let renderer!:ReactTestRenderer
  await act(async()=>{renderer=create(shell?<WorkflowLibraryPanel store={store} onClose={onClose}/>:<TemplateDialog store={store} onClose={onClose}/>)})
  renderers.push(renderer);return {renderer,store,api,flow,created,onClose}
}
describe('personal template directory',()=>{
  it('shows personal visual cards without builtins, archived modules or a save-current-flow form',async()=>{
    const {renderer,api}=await setup()
    expect(renderer.root.findAllByProps({'aria-label':'内置模板'})).toHaveLength(0);expect(renderer.root.findAllByProps({'aria-label':'个人模板'})).toHaveLength(1)
    expect(renderer.root.findAllByProps({'aria-label':'使用模板：Personal'})).toHaveLength(1);expect(renderer.root.findAllByProps({'aria-label':'使用模板：Builtin'})).toHaveLength(0)
    expect(renderer.root.findAllByProps({'aria-label':'Personal缩略图'})).toHaveLength(1)
    expect(renderer.root.findAllByProps({'aria-label':'已归档模板'})).toHaveLength(0);expect(api.archivedTemplates).not.toHaveBeenCalled();expect(api.saveTemplate).not.toHaveBeenCalled()
  })
  it('creates and opens a separate workspace copy without executing it',async()=>{
    const {renderer,api,store,created,onClose}=await setup()
    await act(async()=>renderer.root.findByProps({'aria-label':'使用模板：Personal'}).props.onClick())
    expect(api.useTemplate).toHaveBeenCalledWith('personal','workspace');expect(store.flush).toHaveBeenCalled();expect(store.refreshImportedAssets).toHaveBeenCalled();expect(store.open).toHaveBeenCalledWith(created.id);expect(api.start).not.toHaveBeenCalled();expect(onClose).toHaveBeenCalledOnce()
  })
  it('keeps rename revision checks and reports host failures',async()=>{
    const {renderer,api}=await setup();api.renameTemplate.mockRejectedValueOnce(new Error('模板版本冲突'))
    act(()=>renderer.root.findAllByType('button').find(button=>button.children.includes('重命名'))!.props.onClick())
    act(()=>renderer.root.findByProps({'aria-label':'新模板名称'}).props.onChange({target:{value:'Renamed'}}))
    await act(async()=>renderer.root.findAllByType('button').find(button=>button.children.includes('保存名称'))!.props.onClick())
    expect(api.renameTemplate).toHaveBeenCalledWith('personal','Renamed',1);expect(renderer.root.findByProps({role:'alert'}).children.join('')).toContain('模板版本冲突')
  })
  it('archives only the selected personal template and leaves an actionable empty state',async()=>{
    const {renderer,api}=await setup()
    await act(async()=>renderer.root.findAllByType('button').find(button=>button.children.includes('归档'))!.props.onClick())
    expect(api.removeTemplate).toHaveBeenCalledWith('personal',1);expect(api.start).not.toHaveBeenCalled();expect(renderer.root.findAllByType('p').some(item=>item.children.join('').includes('右键创建模板'))).toBe(true)
  })
  it('refreshes the template copy local role IDs before opening it and treats catalog failure as a saved-state notice',async()=>{
    const original=makeWorkflow('workspace','Original',true),created={...makeWorkflow('workspace','Template copy',true),revision:1},role={id:'copied-local-role',name:'Template local',prompt:'Prompt',scope:'workflow' as const,workflowId:created.id,revision:1}
    created.nodes[1]!.kind='llm';created.nodes[1]!.config={prompt:'Task',rolePresetId:role.id}
    const metadata={id:'personal',scope:'personal' as const,title:'Template',description:'',revision:1,createdAt:original.createdAt,updatedAt:original.updatedAt},api={templates:vi.fn(async()=>[metadata]),useTemplate:vi.fn(async()=>created),presets:vi.fn(async()=>[role]),list:vi.fn(async()=>({workflows:[original,created],presets:[role],workspaces:[],runs:[]})),models:vi.fn(async()=>[])} as any
    const store=new WorkflowStore(api);store.update({workflow:original,page:'canvas',loading:false,library:{workflows:[original],presets:[],workspaces:[{id:'workspace',name:'Workspace'}],runs:[]}})
    const onClose=vi.fn();let renderer!:ReactTestRenderer;await act(async()=>{renderer=create(<TemplateDialog store={store} onClose={onClose}/>)});renderers.push(renderer)
    await act(async()=>renderer.root.findByProps({'aria-label':'使用模板：Template'}).props.onClick())
    expect(onClose).toHaveBeenCalledOnce();expect(store.getSnapshot().workflow?.id).toBe(created.id)
    expect(store.getSnapshot().library.presets.find(item=>item.id===created.nodes[1]!.config.rolePresetId)).toEqual(role)
    store.dispose()
  })
  it('shares one floating surface with keyboard-addressable template and import tabs',async()=>{
    const {renderer}=await setup(true)
    expect(renderer.root.findByProps({'aria-label':'工作流模板与导入'}).props.className).toContain('vdw-node-picker')
    const tabs=renderer.root.findAllByProps({role:'tab'});expect(tabs.map(tab=>tab.children.join(''))).toEqual(['工作流模板','导入'])
    act(()=>tabs[1]!.props.onClick());expect(renderer.root.findByProps({'aria-label':'导入工作流'})).toBeDefined()
    expect(renderer.root.findAllByProps({'aria-label':'工作流模板'})).toHaveLength(0)
  })
})
