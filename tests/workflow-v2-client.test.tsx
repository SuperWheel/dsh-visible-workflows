import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasTopActions } from '../src/client/canvas-top-actions.tsx'
import { VariablePanel } from '../src/client/variable-panels.tsx'
import { VariableBrowser } from '../src/client/variable-browser.tsx'
import { environmentDraft, environmentFromDraft, environmentReferences, systemVariableValue } from '../src/client/workflow-variables.ts'
import { serializeEditorDraft, restoreEditorDraft } from '../src/client/editor-drafts.ts'
import { WorkflowStore } from '../src/client/store.ts'
import { makeWorkflow, type WorkflowAPI, type WorkflowDraft } from '../src/shared/types.ts'
import { WorkflowTransfer } from '../src/client/workflow-transfer.tsx'
import { exportWorkflowJson } from '../src/shared/workflow-format.ts'
import { LogicGateEditor } from '../src/client/logic-gate-editor.tsx'
import { Select } from '../src/client/controls.tsx'
import { workflowChangeSummary } from '../src/client/proposal-review.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Input:'input',Tooltip:({children,label}:any)=><tooltip-mock label={label}>{children}</tooltip-mock>,Menu:({anchor,...props}:any)=><menu-mock {...props}>{anchor}</menu-mock>,Modal:({children,footer,...props}:any)=><modal-mock {...props}>{children}{footer}</modal-mock>}))
const renderers:ReactTestRenderer[]=[],stores:WorkflowStore[]=[]
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount());for(const store of stores.splice(0))store.dispose();vi.unstubAllGlobals();vi.useRealTimers()})
function render(element:React.ReactElement){let renderer!:ReactTestRenderer;act(()=>{renderer=create(element)});renderers.push(renderer);return renderer}
function fixture(){
  const flow=makeWorkflow('workspace','v2 测试',true);flow.revision=1
  const library={workflows:[flow],workspaces:[{id:'workspace',name:'测试工作区'}],presets:[],runs:[]}
  const api={save:vi.fn(async(json:string,revision:number)=>({...JSON.parse(json),revision:revision+1})),list:vi.fn(async()=>library),get:vi.fn(async()=>flow),models:vi.fn(async()=>[]),start:vi.fn(),presets:vi.fn(async()=>[])} as unknown as WorkflowAPI
  const store=new WorkflowStore(api);stores.push(store);store.update({workflow:flow,library,loading:false,page:'canvas'})
  return{flow,store,api}
}
describe('v2 workflow editing contracts',()=>{
  it.each([{collapsed:false,iconOnly:false},{collapsed:false,iconOnly:true},{collapsed:true,iconOnly:false}])('keeps variable and budget entry points out of the top actions in toolbar mode %j',mode=>{
    const environment=vi.fn(),system=vi.fn(),renderer=render(<CanvasTopActions {...mode} selectedCount={0} disabled placingAnnotation={false} onToggleAnnotation={()=>{}} onDuplicate={()=>{}} onDelete={()=>{}} onEnvironment={environment} onSystem={system} executionActions={<button>执行</button>}/> )
    expect(renderer.root.findAllByProps({'aria-label':'工作流变量'})).toHaveLength(0)
    for(const label of ['环境变量','系统变量','执行策略与预算'])expect(renderer.root.findAllByProps({'aria-label':label})).toHaveLength(0)
    expect(renderer.root.findAllByType('button').filter(button=>button.children.includes('执行'))).toHaveLength(1)
  })
  it('uses typed number values, keeps missing distinct from empty, and validates duplicates',()=>{
    const string=environmentDraft({id:'variable-id',name:'NAME',type:'string'})
    expect(environmentFromDraft(string,[])).not.toHaveProperty('value')
    expect(environmentFromDraft({...string,configured:true},[])).toMatchObject({type:'string',value:''})
    expect(environmentFromDraft({...string,type:'number',value:'25.5',configured:true},[])).toMatchObject({type:'number',value:25.5})
    expect(()=>environmentFromDraft({...string,type:'number',value:'Infinity',configured:true},[])).toThrow('有限数值')
    expect(()=>environmentFromDraft({...string,name:'1wrong'},[])).toThrow('名称须')
    expect(()=>environmentFromDraft(string,[{id:'other',name:'NAME',type:'string'}])).toThrow('同名')
  })
  it('does not make Secret value controls or references available to generic nodes',()=>{
    const {flow,store}=fixture();flow.environmentVariables=[{id:'public-id',name:'PUBLIC',type:'string',value:'hello'},{id:'secret-id',name:'TOKEN',type:'secret'}]
    store.update({environmentDraft:{id:'secret-id',name:'TOKEN',type:'secret',value:'must-never-appear',description:'token',required:false,configured:true}})
    const panel=render(<VariablePanel store={store} kind="environment" onClose={()=>{}} onLocate={()=>{}}/>)
    expect(panel.root.findAllByProps({'aria-label':'环境变量值'})).toHaveLength(0)
    expect(panel.root.findAllByType('input').map(input=>input.props.value)).not.toContain('must-never-appear')
    expect(panel.root.findByProps({role:'note'}).children.join('')).toContain('不能录入真实密钥')
    const browser=render(<VariableBrowser inputs={[]} nodes={[]} parents={[]} executions={[]} environmentVariables={flow.environmentVariables} includeSystem/>)
    const tree=JSON.stringify(browser.toJSON());expect(tree).toContain('{{env.public-id}}');expect(tree).not.toContain('secret-id');expect(tree).toContain('{{sys.workflow_run_id}}');expect(tree).not.toContain('{{sys.user_id}}')
  })
  it('keeps stable environment references valid across renaming and finds nested usages',()=>{
    const {flow}=fixture();flow.environmentVariables=[{id:'stable',name:'BEFORE',type:'string',value:'x'}]
    flow.nodes[1]!.config.text='{{env.stable}}'
    expect(environmentReferences(flow,'stable').map(node=>node.id)).toEqual([flow.nodes[1]!.id])
    flow.environmentVariables[0]!.name='AFTER';expect(environmentReferences(flow,'stable')).toHaveLength(1)
    expect(environmentReferences(flow,'stabl')).toHaveLength(0)
  })
  it('renders unstarted system fields as generated later and does not invent user or app IDs',()=>{
    const {flow,store}=fixture(),panel=render(<VariablePanel store={store} kind="system" onClose={()=>{}} onLocate={()=>{}}/>)
    expect(systemVariableValue('workflow_run_id',flow)).toBe('运行时生成')
    expect(systemVariableValue('timestamp',flow)).toBe('运行时生成')
    expect(panel.root.findAllByProps({'aria-label':'复制系统变量 user_id'})).toHaveLength(0)
    expect(panel.root.findAllByProps({'aria-label':'复制系统变量 app_id'})).toHaveLength(0)
    expect(panel.root.findAllByType('input')).toHaveLength(1)
  })
  it('serializes only draft fields and removes even a stale Secret value before persistence',()=>{
    const {store}=fixture();store.update({environmentDraft:{id:'secret',name:'TOKEN',type:'secret',value:'do-not-store',description:'safe description',required:false,configured:true},generateDraft:'draft',generateTargetId:'target'})
    const value=serializeEditorDraft(store.getSnapshot(),'draft-id')!
    expect(JSON.stringify(value)).not.toContain('do-not-store');expect(value.payload).not.toHaveProperty('environmentDraft.value')
    expect(restoreEditorDraft(value).environmentDraft).toMatchObject({value:'',configured:false})
    expect(value.payload).not.toHaveProperty('workflow')
  })
  it('saves drafts by flow and session and restores them after creating a new editor',async()=>{
    const {store,api,flow}=fixture();let saved:WorkflowDraft[]=[]
    api.saveDraft=vi.fn(async(json,revision)=>{const draft={...JSON.parse(json),revision:revision+1} as WorkflowDraft;saved=saved.filter(item=>item.id!==draft.id);saved.push(draft);return draft});api.removeDraft=vi.fn(async id=>{saved=saved.filter(item=>item.id!==id)});api.drafts=vi.fn(async(id,sessionId)=>saved.filter(item=>item.workflowId===id&&item.sessionId===sessionId))
    store.update({sessionId:'session-a'});store.update({generateDraft:'keep me',generateTargetId:flow.id});await store.flushDraft()
    expect(saved).toHaveLength(1);expect(saved[0]!.id).toMatch(/^[a-f0-9-]{36}$/)
    const restored=new WorkflowStore(api);stores.push(restored);restored.update({sessionId:'session-a'});await restored.load();await restored.open(flow.id);await Promise.resolve();await Promise.resolve()
    expect(restored.getSnapshot().generateDraft).toBe('keep me')
    restored.update({sessionId:'session-b'});await Promise.resolve();await Promise.resolve();expect(restored.getSnapshot().generateDraft).toBeUndefined()
  })
  it('validates JSON and previews dependencies before creating a separate flow without executing it',async()=>{
    const {flow,store,api}=fixture();api.importPackage=vi.fn(async(json,workspaceId)=>({...flow,id:'imported-flow',workspaceId}));vi.mocked(api.get).mockResolvedValue({...flow,id:'imported-flow'})
    const close=vi.fn(),dialog=render(<WorkflowTransfer store={store} initialMode="import" onClose={close}/> )
    const button=(text:string)=>dialog.root.findAllByType('button').find(item=>item.children.includes(text))!
    expect(button('导入到新的画布').props.disabled).toBe(true)
    const json=exportWorkflowJson(flow)
    await act(async()=>dialog.root.findByProps({'aria-label':'选择工作流 JSON 或 ZIP 文件'}).props.onChange({target:{files:[{name:'flow.json',size:json.length,type:'application/json',text:async()=>json}]}}))
    expect(button('导入到新的画布').props.disabled).toBe(false)
    await act(async()=>button('导入到新的画布').props.onClick());expect(api.importPackage).toHaveBeenCalledOnce();expect(api.start).not.toHaveBeenCalled();expect(close).toHaveBeenCalledOnce()
  })
  it('enforces logic gate arity in the editor while preserving explicit Boolean input values',()=>{
    const change=vi.fn(),renderer=render(<LogicGateEditor value={{operator:'AND',inputs:[{value:true},{value:false}]}} onChange={change}/> )
    const select=renderer.root.findAllByType(Select).find(item=>item.props.label==='逻辑门类型')!
    act(()=>select.props.onChange('NOT'));expect(change).toHaveBeenLastCalledWith({operator:'NOT',inputs:[{value:true}]})
    const source=renderer.root.findAllByType(Select).find(item=>item.props.label==='逻辑输入 1 来源')!;act(()=>source.props.onChange('false'));expect(change.mock.calls.at(-1)?.[0].inputs[0].value).toBe(false)
  })
  it('includes nested node changes and variable or policy changes in proposal impact',()=>{
    const {flow}=fixture(),after=structuredClone(flow);after.nodes[1]!.config.text='updated';after.environmentVariables=[{id:'env',name:'VALUE',type:'number',value:1}];after.executionPolicy={tokenBudget:500}
    const changes=workflowChangeSummary(flow,after);expect(changes.changed.map(change=>change.after.id)).toEqual([flow.nodes[1]!.id]);expect(changes.variablesChanged).toBe(true);expect(changes.policyChanged).toBe(true);expect(changes.edgesChanged).toBe(false)
  })
})
