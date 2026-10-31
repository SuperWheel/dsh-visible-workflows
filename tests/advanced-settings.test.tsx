import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { AdvancedSettingsPanel, type AdvancedSettingsTab } from '../src/client/advanced-settings.tsx'
import { CanvasExportMenu } from '../src/client/canvas-top-actions.tsx'
import { ExecutionPolicyPanel } from '../src/client/execution-policy.tsx'
import { VariablePanel } from '../src/client/variable-panels.tsx'
import { WorkflowStore } from '../src/client/store.ts'
import { makeWorkflow, type WorkflowAPI } from '../src/shared/types.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Input:'input',Tooltip:({children,label}:any)=><tooltip-mock label={label}>{children}</tooltip-mock>,Menu:({anchor,items,open,...props}:any)=><menu-mock {...props} items={items} open={open}>{anchor}{open&&items.map((item:any)=><button key={item.id} role="menuitem" onClick={()=>props.onSelect(item.id)}>{item.label}</button>)}</menu-mock>,Modal:({children,footer}:any)=><div>{children}{footer}</div>}))
vi.mock('../src/client/controls.tsx',()=>({Field:({label,help,children}:any)=><label>{label}{help}{children}</label>,Select:({label,value,onChange,options}:any)=><select aria-label={label} value={value} onChange={(event:any)=>onChange(event.target.value)}>{options.map((option:any)=><option key={option.id} value={option.id}>{option.label}</option>)}</select>}))
const cleanups:(()=>void)[]=[]
afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();vi.restoreAllMocks()})
function render(element:React.ReactElement){let renderer!:ReactTestRenderer;act(()=>{renderer=create(element)});cleanups.push(()=>act(()=>renderer.unmount()));return renderer}
function fixture(){
  const flow=makeWorkflow('workspace','菜单测试',true),api={} as WorkflowAPI,store=new WorkflowStore(api)
  store.update({workflow:flow,library:{workflows:[flow],presets:[],runs:[],workspaces:[]}})
  vi.spyOn(store,'refreshSecretBoundary').mockResolvedValue(undefined);vi.spyOn(store,'flush').mockResolvedValue(undefined)
  cleanups.push(()=>store.dispose());return{flow,store}
}
const button=(renderer:ReactTestRenderer,label:string)=>renderer.root.findAllByType('button').find(item=>item.children.some(child=>typeof child==='string'&&child.trim()===label))!

it('saves public strings and numbers with their actual types even when Secret storage is unavailable',async()=>{
  const {store}=fixture(),panel=render(<VariablePanel store={store} kind="environment" embedded onClose={()=>{}} onLocate={()=>{}}/>)
  act(()=>button(panel,'添加环境变量').props.onClick())
  expect(panel.root.findAllByProps({role:'radio'}).map(item=>item.children.filter(child=>typeof child==='string').join('').trim())).toEqual(['字符型','数字型','密钥'])
  expect(panel.root.findByProps({'aria-label':'环境变量值'}).props.type).toBe('text')
  act(()=>panel.root.findByProps({'aria-label':'环境变量名称'}).props.onChange({target:{value:'PUBLIC_URL'}}))
  act(()=>panel.root.findByProps({'aria-label':'环境变量值'}).props.onChange({target:{value:'https://example.test'}}))
  await act(async()=>button(panel,'保存').props.onClick())
  act(()=>button(panel,'添加环境变量').props.onClick())
  act(()=>button(panel,'数字型').props.onClick())
  expect(panel.root.findByProps({'aria-label':'环境变量值'}).props.type).toBe('number')
  act(()=>panel.root.findByProps({'aria-label':'环境变量名称'}).props.onChange({target:{value:'TIMEOUT'}}))
  act(()=>panel.root.findByProps({'aria-label':'环境变量值'}).props.onChange({target:{value:'25.5'}}))
  await act(async()=>button(panel,'保存').props.onClick())
  expect(store.getSnapshot().workflow?.environmentVariables).toEqual([expect.objectContaining({name:'PUBLIC_URL',type:'string',value:'https://example.test'}),expect.objectContaining({name:'TIMEOUT',type:'number',value:25.5})])
})

it('clears the public value when changing to Secret and never renders a Secret value input',()=>{
  const {store}=fixture(),panel=render(<VariablePanel store={store} kind="environment" embedded onClose={()=>{}} onLocate={()=>{}}/>)
  act(()=>button(panel,'添加环境变量').props.onClick())
  act(()=>panel.root.findByProps({'aria-label':'环境变量值'}).props.onChange({target:{value:'public-before-secret'}}))
  act(()=>button(panel,'密钥').props.onClick())
  expect(panel.root.findAllByProps({'aria-label':'环境变量值'})).toHaveLength(0)
  expect(store.getSnapshot().environmentDraft).toMatchObject({type:'secret',value:'',configured:false})
  expect(panel.root.findByProps({className:'vdw-secret-status'}).props.open).toBeUndefined()
  act(()=>button(panel,'字符型').props.onClick())
  expect(panel.root.findByProps({'aria-label':'环境变量值'}).props.value).toBe('')
})

it('removes empty variable lists from the form flow and preserves the editor while filtering',()=>{
  const {flow,store}=fixture();store.update({workflow:{...flow,environmentVariables:[{id:'public-url',name:'PUBLIC_URL',type:'string',value:'https://example.test',description:'服务地址'}]}})
  const panel=render(<VariablePanel store={store} kind="environment" embedded onClose={()=>{}} onLocate={()=>{}}/>)
  expect(panel.root.findAllByProps({className:'vdw-variable-panel-list'})).toHaveLength(1)
  act(()=>button(panel,'添加环境变量').props.onClick())
  act(()=>panel.root.findByProps({'aria-label':'环境变量名称'}).props.onChange({target:{value:'UNSAVED_NAME'}}))
  act(()=>panel.root.findByProps({'aria-label':'搜索环境变量'}).props.onChange({target:{value:'missing'}}))
  expect(panel.root.findAllByProps({className:'vdw-variable-panel-list'})).toHaveLength(0)
  expect(panel.root.findByProps({'aria-label':'环境变量名称'}).props.value).toBe('UNSAVED_NAME')
  act(()=>panel.root.findByProps({'aria-label':'搜索环境变量'}).props.onChange({target:{value:'服务'}}))
  expect(panel.root.findAllByProps({className:'vdw-variable-panel-list'})).toHaveLength(1)
  expect(panel.root.findByProps({'aria-label':'环境变量名称'}).props.value).toBe('UNSAVED_NAME')
})

it('switches all four advanced tabs without discarding pending concurrency settings',()=>{
  const {store}=fixture(),close=vi.fn(),locate=vi.fn()
  function Harness(){const [tab,setTab]=React.useState<AdvancedSettingsTab>('environment');return <AdvancedSettingsPanel store={store} tab={tab} onTabChange={setTab} onClose={close} onLocate={locate}/>}
  const panel=render(<Harness/>),tabs=panel.root.findAllByProps({role:'tab'})
  expect(tabs.map(item=>item.children.join(''))).toEqual(['环境变量','全局变量','执行策略','智能体预设'])
  act(()=>tabs[2]!.props.onClick())
  act(()=>panel.root.findByProps({'aria-label':'Agent 并发上限'}).props.onChange({target:{value:'4'}}))
  act(()=>tabs[1]!.props.onClick())
  expect(panel.root.findAllByProps({role:'tabpanel'}).map(item=>item.props.hidden)).toEqual([true,false,true,true])
  act(()=>tabs[2]!.props.onClick())
  expect(panel.root.findByProps({'aria-label':'Agent 并发上限'}).props.value).toBe('4')
  act(()=>panel.root.findByProps({'aria-label':'关闭高级设置'}).props.onClick());expect(close).toHaveBeenCalledOnce()
})

it('opens one native export menu to the right and dispatches the selected format once',()=>{
  const json=vi.fn(),svg=vi.fn(),open=vi.fn(),panel=render(<CanvasExportMenu onJson={json} onSvg={svg} onOpen={open}/>)
  const trigger=()=>panel.root.findByProps({'aria-label':'导出'}),menu=panel.root.findByType('menu-mock' as never)
  expect(menu.props.side).toBe('right');expect(menu.props.portal).toBe(true);expect(menu.props.autoFocus).toBe(true)
  act(()=>trigger().props.onClick());expect(open).toHaveBeenCalledOnce()
  expect(panel.root.findAllByProps({role:'menuitem'}).map(item=>item.children.join(''))).toEqual(['流程 JSON','画布 SVG'])
  act(()=>button(panel,'流程 JSON').props.onClick());expect(json).toHaveBeenCalledOnce();expect(svg).not.toHaveBeenCalled();expect(trigger().props['aria-expanded']).toBe(false)
  act(()=>trigger().props.onClick());act(()=>button(panel,'画布 SVG').props.onClick());expect(svg).toHaveBeenCalledOnce();expect(panel.root.findAllByProps({role:'menuitem'})).toHaveLength(0)
})

it('edits only effective safety controls and preserves legacy policy fields without rendering dead settings',async()=>{
  const {flow,store}=fixture();store.update({workflow:{...flow,executionPolicy:{tokenBudget:1000,perTaskTokens:100,maxConcurrentAgents:2,maxAgentTasks:12,maxRepairAttempts:1},budgetDecision:{mode:'limited',decidedAt:'2026-10-17T08:00:00.000Z'}}})
  const panel=render(<ExecutionPolicyPanel store={store}/>),text=JSON.stringify(panel.toJSON())
  for(const removed of ['预算','预留','额度','Agent 任务总数'])expect(text).not.toContain(removed)
  expect(panel.root.findAllByType('input').map(input=>input.props['aria-label'])).toEqual(['Agent 并发上限','最大修复轮次'])
  expect(panel.root.findByProps({'aria-label':'Agent 并发上限'}).props.value).toBe('2')
  act(()=>panel.root.findByProps({'aria-label':'Agent 并发上限'}).props.onChange({target:{value:'4'}}))
  await act(async()=>button(panel,'保存').props.onClick())
  expect(store.getSnapshot().workflow?.executionPolicy).toEqual({tokenBudget:1000,perTaskTokens:100,maxConcurrentAgents:4,maxAgentTasks:12,maxRepairAttempts:1,repairMode:'confirm'})
})
