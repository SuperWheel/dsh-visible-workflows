import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RolePresetsPanel } from '../src/client/role-presets-panel.tsx'
import { ExecutionPolicyPanel } from '../src/client/execution-policy.tsx'
import { AdvancedSettingsPanel } from '../src/client/advanced-settings.tsx'
import { setLocale } from '../src/client/i18n.ts'
import { WorkflowStore } from '../src/client/store.ts'
import { makeWorkflow, type RolePreset, type WorkflowAPI } from '../src/shared/types.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Input:'input',Tooltip:({children}:any)=><>{children}</>,Modal:({children,footer}:any)=><div>{children}{footer}</div>}))
vi.mock('../src/client/controls.tsx',()=>({Field:({label,children,help}:any)=><label>{label}{children}{help&&<small>{help}</small>}</label>,Select:({label,value,onChange,options}:any)=><select aria-label={label} value={value} onChange={(event:any)=>onChange(event.target.value)}>{options.map((option:any)=><option key={option.id} value={option.id}>{option.label}</option>)}</select>}))
const cleanups:(()=>void)[]=[]
afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();setLocale('zh-CN');vi.restoreAllMocks()})
async function mount(component:(store:WorkflowStore)=>React.ReactElement,overrides:Partial<WorkflowAPI>={}){
  const flow=makeWorkflow('workspace','当前流程',true),presets:RolePreset[]=[{id:'global',name:'全局研究员',summary:'全局分析',prompt:'GLOBAL PROMPT',revision:2},{id:'local',name:'本地审稿人',summary:'核对逻辑',prompt:'LOCAL PROMPT',scope:'workflow',workflowId:flow.id,revision:3},{id:'foreign',name:'不应展示的角色',summary:'机密概述',prompt:'FOREIGN PROMPT',scope:'workflow',workflowId:'another-flow',revision:1}]
  const api={presets:vi.fn(async()=>presets),savePreset:vi.fn(async(json:string)=>[...presets.filter(item=>item.id!==JSON.parse(json).id),{...JSON.parse(json),revision:JSON.parse(json).revision+1}]),deletePreset:vi.fn(async(id:string)=>presets.filter(item=>item.id!==id)),...overrides} as unknown as WorkflowAPI
  const store=new WorkflowStore(api);store.update({workflow:flow,library:{workflows:[flow],presets,runs:[],workspaces:[]}});const flush=vi.spyOn(store,'flush').mockResolvedValue(undefined)
  vi.spyOn(store,'refreshSecretBoundary').mockResolvedValue(undefined)
  let renderer!:ReactTestRenderer;await act(async()=>{renderer=create(component(store))});cleanups.push(()=>{act(()=>renderer.unmount());store.dispose()});return {renderer,store,api,flow,flush}
}
const button=(renderer:ReactTestRenderer,label:string)=>renderer.root.findAllByType('button').find(item=>item.children.includes(label))!
const change=(renderer:ReactTestRenderer,label:string,value:string)=>act(()=>renderer.root.findByProps({'aria-label':label}).props.onChange({target:{value}}))

describe('advanced preset management and execution policy controls',()=>{
  it('filters presets by scope and summary and never renders a foreign workflow role',async()=>{
    const {renderer}=await mount(store=><RolePresetsPanel store={store}/>)
    expect(renderer.root.findAllByProps({className:'vdw-role-preset-card'})).toHaveLength(2)
    expect(renderer.root.findAll(node=>node.children.some(child=>typeof child==='string'&&(child.includes('FOREIGN PROMPT')||child.includes('不应展示的角色'))))).toHaveLength(0)
    change(renderer,'筛选预设作用域','workflow');expect(renderer.root.findAllByProps({className:'vdw-role-preset-card'})).toHaveLength(1)
    change(renderer,'搜索智能体预设','逻辑');expect(renderer.root.findByProps({'aria-label':'编辑预设 本地审稿人'})).toBeDefined()
    change(renderer,'搜索智能体预设','没有');expect(renderer.root.findAllByProps({className:'vdw-role-preset-card'})).toHaveLength(0)
  })

  it('creates workflow-owned presets after flushing and edits them without changing the user prompt',async()=>{
    const {renderer,api,flow,flush}=await mount(store=><RolePresetsPanel store={store}/>)
    act(()=>button(renderer,'新增预设').props.onClick());change(renderer,'智能体名称','新角色');change(renderer,'智能体概述','简要介绍');change(renderer,'角色提示词','  保留原始角色文本\n')
    await act(async()=>renderer.root.findByType('form').props.onSubmit({preventDefault(){}}))
    expect(flush).toHaveBeenCalledOnce()
    const request=JSON.parse(vi.mocked(api.savePreset).mock.calls[0]![0]);expect(request).toMatchObject({name:'新角色',summary:'简要介绍',prompt:'  保留原始角色文本\n',scope:'workflow',workflowId:flow.id,revision:0})
    act(()=>renderer.root.findByProps({'aria-label':'编辑预设 新角色'}).props.onClick());change(renderer,'预设作用域','global')
    await act(async()=>renderer.root.findByType('form').props.onSubmit({preventDefault(){}}))
    const update=JSON.parse(vi.mocked(api.savePreset).mock.calls[1]![0]);expect(update).toMatchObject({scope:'global',revision:1});expect(update).not.toHaveProperty('workflowId')
  })

  it('keeps HTTP cache controls out of per-workflow execution policy',async()=>{
    const {renderer}=await mount(store=><ExecutionPolicyPanel store={store}/>)
    expect(JSON.stringify(renderer.toJSON())).not.toContain('HTTP')
  })

  it('resets execution policy drafts locally and persists only on Save while preserving legacy metadata',async()=>{
    const {renderer,store,flow}=await mount(store=><ExecutionPolicyPanel store={store}/>),save=vi.spyOn(store,'save').mockResolvedValue(undefined),edit=vi.spyOn(store,'edit')
    const legacy={mode:'limited' as const,decidedAt:'2026-10-17T08:00:00.000Z'},legacyPolicy={tokenBudget:7,maxAgentTasks:1}
    act(()=>store.update({workflow:{...flow,budgetDecision:legacy,executionPolicy:legacyPolicy}}))
    change(renderer,'Agent 并发上限','4');change(renderer,'最大修复轮次','1');change(renderer,'输出修复策略','auto')
    expect(edit).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();expect(store.getSnapshot().workflow?.executionPolicy).toEqual(legacyPolicy)
    act(()=>button(renderer,'重置').props.onClick())
    expect(renderer.root.findByProps({'aria-label':'Agent 并发上限'}).props.value).toBe('');expect(renderer.root.findByProps({'aria-label':'最大修复轮次'}).props.value).toBe('');expect(renderer.root.findByProps({'aria-label':'输出修复策略'}).props.value).toBe('confirm')
    expect(edit).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();expect(store.getSnapshot().workflow?.executionPolicy).toEqual(legacyPolicy)
    await act(async()=>button(renderer,'保存').props.onClick())
    expect(save).toHaveBeenCalledOnce();expect(store.getSnapshot().workflow?.executionPolicy).toEqual({...legacyPolicy,repairMode:'confirm'})
    expect(store.getSnapshot().workflow?.budgetDecision).toEqual(legacy)
  })

  it('reacts to English mode for tabs, preset editors and effective safety fields while preserving custom names',async()=>{
    const {renderer}=await mount(store=><AdvancedSettingsPanel store={store} tab="presets" onTabChange={()=>{}} onClose={()=>{}} onLocate={()=>{}}/>)
    act(()=>setLocale('en'))
    expect(renderer.root.findAllByProps({role:'tab'}).map(tab=>tab.children.join(''))).toEqual(['Environment','Global variables','Execution policy','Agent presets'])
    expect(renderer.root.findByProps({'aria-label':'Concurrent agents'})).toBeDefined();expect(renderer.root.findByProps({'aria-label':'Maximum repair attempts'})).toBeDefined()
    expect(renderer.root.findAllByProps({'aria-label':'Total token budget'})).toHaveLength(0)
    expect(renderer.root.findByProps({'aria-label':'Edit preset 本地审稿人'})).toBeDefined()
    act(()=>button(renderer,'New preset').props.onClick())
    expect(renderer.root.findByProps({'aria-label':'Agent name'})).toBeDefined();expect(renderer.root.findByProps({'aria-label':'Preset scope'})).toBeDefined();expect(renderer.root.findByProps({'aria-label':'Role prompt'})).toBeDefined()
  })

  it('does not let a stale initial preset read hide a later successful save',async()=>{
    let resolve!:(presets:RolePreset[])=>void;const initial=new Promise<RolePreset[]>(done=>{resolve=done})
    const {renderer,store}=await mount(store=><RolePresetsPanel store={store}/>,{presets:()=>initial})
    act(()=>button(renderer,'新增预设').props.onClick());change(renderer,'智能体名称','并发新角色');change(renderer,'角色提示词','保持角色')
    await act(async()=>renderer.root.findByType('form').props.onSubmit({preventDefault(){}}))
    expect(store.getSnapshot().library.presets.some(role=>role.name==='并发新角色')).toBe(true)
    await act(async()=>resolve([]))
    expect(store.getSnapshot().library.presets.some(role=>role.name==='并发新角色')).toBe(true)
    expect(renderer.root.findByProps({'aria-label':'编辑预设 并发新角色'})).toBeDefined()
  })

  it('abandons a pending preset submission if the workflow changes before the prerequisite flush finishes',async()=>{
    const {renderer,store,api,flush}=await mount(store=><RolePresetsPanel store={store}/>),next=makeWorkflow('workspace','新的流程',true)
    let resolve!:()=>void;flush.mockImplementationOnce(()=>new Promise<void>(done=>{resolve=done}))
    act(()=>button(renderer,'新增预设').props.onClick());change(renderer,'智能体名称','旧流程角色');change(renderer,'角色提示词','仅旧流程')
    act(()=>renderer.root.findByType('form').props.onSubmit({preventDefault(){}}))
    act(()=>store.update({workflow:next}))
    await act(async()=>resolve())
    expect(api.savePreset).not.toHaveBeenCalled();expect(store.getSnapshot().workflow?.id).toBe(next.id)
    expect(renderer.root.findAllByType('form')).toHaveLength(0)
  })

  it('reinitializes safety drafts for a different workflow without applying previous canvas values',async()=>{
    const {renderer,store,flow}=await mount(store=><ExecutionPolicyPanel store={store}/>),next={...makeWorkflow('workspace','下一流程',true),executionPolicy:{tokenBudget:2048,maxConcurrentAgents:2,maxRepairAttempts:1}},save=vi.spyOn(store,'save').mockResolvedValue(undefined)
    change(renderer,'Agent 并发上限','4');change(renderer,'最大修复轮次','2')
    act(()=>store.update({workflow:next}))
    expect(renderer.root.findByProps({'aria-label':'Agent 并发上限'}).props.value).toBe('2');expect(renderer.root.findByProps({'aria-label':'最大修复轮次'}).props.value).toBe('1')
    act(()=>button(renderer,'重置').props.onClick())
    expect(store.getSnapshot().workflow?.executionPolicy).toEqual({tokenBudget:2048,maxConcurrentAgents:2,maxRepairAttempts:1});expect(save).not.toHaveBeenCalled()
    change(renderer,'Agent 并发上限','3')
    await act(async()=>button(renderer,'保存').props.onClick())
    expect(store.getSnapshot().workflow?.id).toBe(next.id);expect(store.getSnapshot().workflow?.executionPolicy).toEqual({tokenBudget:2048,maxConcurrentAgents:3,repairMode:'confirm'})
    expect(store.getSnapshot().library.workflows.find(item=>item.id===flow.id)?.executionPolicy).toBeUndefined()
  })
})
