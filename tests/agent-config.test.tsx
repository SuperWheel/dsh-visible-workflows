import React, { useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ParameterEditor, SpecificConfig } from '../src/client/node-config.tsx'
import { Select } from '../src/client/controls.tsx'
import { NodePanel } from '../src/client/forms.tsx'
import { WorkflowStore } from '../src/client/store.ts'
import { makeWorkflow, type NodeConfig, type WorkflowAPI, type WorkflowNode, type ToolChoice } from '../src/shared/types.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Input:({icon,...props}:any)=><input {...props}/>,Switch:'switch-mock',Tooltip:({children}:any)=><>{children}</>,Menu:({anchor}:any)=><>{anchor}</>,Modal:()=>null}))
vi.mock('../src/client/prompt-editor.tsx',()=>({PromptEditor:()=>null}))
vi.mock('../src/client/variable-browser.tsx',()=>({VariableBrowser:()=>null}))
vi.mock('../src/client/code-editor.tsx',()=>({CodeEditor:()=>null}))
const renderers:ReactTestRenderer[]=[],stores:WorkflowStore[]=[]
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount());for(const store of stores.splice(0))store.dispose()})
async function fixture(initial:NodeConfig,disabled=false,tools:ToolChoice[]=[],kind:WorkflowNode['kind']='agent'){
  const flow=makeWorkflow('workspace'),store=new WorkflowStore({tools:vi.fn(async()=>tools)} as unknown as WorkflowAPI);stores.push(store)
  let value!:NodeConfig,renderer!:ReactTestRenderer
  function Fixture(){const[config,setConfig]=useState(initial);value=config;const node:WorkflowNode={...flow.nodes[1]!,kind,config};return <SpecificConfig node={node} flow={flow} store={store} disabled={disabled} config={patch=>setConfig(previous=>({...previous,...patch}))} onEnter={()=>{}}/>}
  await act(async()=>{renderer=create(<Fixture/>)});renderers.push(renderer)
  return{renderer,value:()=>value}
}
describe('Agent structured output configuration',()=>{
  it('shows missing selected tools and lets a user explicitly remove them without erasing other settings',async()=>{
    const f=await fixture({prompt:'keep',tools:['native:missing','workflow:missing-child'],maxSteps:3})
    expect(JSON.stringify(f.renderer.toJSON())).toContain('工具未连接或子工作流不存在')
    act(()=>f.renderer.root.findByProps({'aria-label':'移除缺失工具 native:missing'}).props.onClick())
    expect(f.value()).toEqual({prompt:'keep',tools:['workflow:missing-child'],maxSteps:3})
  })
  it('allows deselecting an unavailable selected tool while preventing new unavailable selections',async()=>{
    const tools=[{id:'native:offline',providerName:'本地',name:'离线操作',available:false},{id:'native:unselected',providerName:'本地',name:'未授权操作',available:false}] as ToolChoice[]
    const f=await fixture({tools:['native:offline']},false,tools),selected=f.renderer.root.findByProps({label:'授权 离线操作'}),unselected=f.renderer.root.findByProps({label:'授权 未授权操作'})
    expect(selected.props.disabled).toBe(false);expect(unselected.props.disabled).toBe(true)
    act(()=>selected.props.onChange(false));expect(f.value().tools).toEqual([])
  })
  it('keeps a missing tool operation visible and permits explicit replacement',async()=>{
    const tools=[{id:'native:available',providerName:'本地',name:'可用操作',available:true,inputSchema:{}}] as ToolChoice[],f=await fixture({toolId:'native:missing',inputs:{query:'original'}},false,tools,'tool')
    const select=f.renderer.root.findAllByType(Select).find(item=>item.props.label==='选择工具操作')!
    expect(select.props.options).toContainEqual({id:'native:missing',label:'native:missing（缺少工具）'});expect(f.value().toolId).toBe('native:missing')
    act(()=>select.props.onChange('native:available'));expect(f.value().toolId).toBe('native:available')
  })
  it('preserves a current subagent role snapshot when its local preset is unavailable',async()=>{
    const flow=makeWorkflow('workspace'),node={...flow.nodes[1]!,kind:'agent' as const,config:{subagentId:'worker'}},store=new WorkflowStore({tools:async()=>[]} as unknown as WorkflowAPI),edit=vi.fn();stores.push(store)
    flow.subAgents=[{id:'worker',number:'agent-1',name:'研究员',prompt:'保留角色内容',rolePresetId:'missing-role',rolePresetRevision:3}]
    flow.nodes[1]=node;store.update({workflow:flow,loading:false})
    let renderer!:ReactTestRenderer;await act(async()=>{renderer=create(<NodePanel node={node} flow={flow} store={store} onClose={()=>{}} disabled={false} onSettings={()=>{}} onEdit={edit} onEnter={()=>{}}/>)});renderers.push(renderer)
    const select=renderer.root.findAllByType(Select).find(item=>item.props.label==='选择子 Agent 角色预设')!
    expect(select.props.options).toContainEqual({id:'missing-role',label:'原预设不可用（保留角色提示词）'})
    expect(store.getSnapshot().workflow!.subAgents![0]!.prompt).toBe('保留角色内容')
    act(()=>select.props.onChange(''))
    const updated=store.getSnapshot().workflow!,agent=updated.subAgents![0]!
    expect(updated.nodes[1]!.config.rolePresetId).toBeUndefined();expect(updated.nodes[1]!.config.subagentId).toBe(agent.id);expect(agent.prompt).toBe('')
  })
  it('keeps the optional Agent timeout unset and supports opt-in configuration without touching task settings',async()=>{
    const initial:NodeConfig={prompt:'分析输入',tools:['native:read_file'],maxSteps:3},f=await fixture(initial)
    const toggle=()=>f.renderer.root.findByProps({label:'启用 Agent 超时'})
    expect(toggle().props.checked).toBe(false);expect(f.value()).not.toHaveProperty('timeoutMs')
    act(()=>toggle().props.onChange(true));expect(f.value()).toEqual({...initial,timeoutMs:300000})
    const input=f.renderer.root.findByProps({'aria-label':'Agent 超时（毫秒）'})
    expect(input.props.min).toBe(100);expect(input.props.max).toBe(3600000)
    act(()=>input.props.onChange({target:{value:'15000'}}));expect(f.value()).toEqual({...initial,timeoutMs:15000})
    act(()=>toggle().props.onChange(false));expect(JSON.parse(JSON.stringify(f.value()))).toEqual(initial)
  })
  it('shows an existing timeout as read-only for protected configuration',async()=>{
    const f=await fixture({timeoutMs:5000},true)
    expect(f.renderer.root.findByProps({label:'启用 Agent 超时'}).props.disabled).toBe(true)
    const input=f.renderer.root.findByProps({'aria-label':'Agent 超时（毫秒）'})
    expect(input.props.value).toBe('5000');expect(input.props.disabled).toBe(true)
  })
  it('keeps the text default and edits typed output fields without changing the task or tools',async()=>{
    const initial:NodeConfig={prompt:'分析输入',tools:['native:read_file'],maxSteps:3},f=await fixture(initial)
    expect(f.value().outputSchema).toBeUndefined();expect(f.renderer.root.findByType(ParameterEditor).props.items).toEqual([])
    const add=f.renderer.root.findAllByType('button').find(item=>item.children.includes('添加参数'))!
    act(()=>add.props.onClick());act(()=>f.renderer.root.findByProps({'aria-label':'参数 1 名称'}).props.onChange({target:{value:'score'}}))
    act(()=>f.renderer.root.findAllByType(Select).find(item=>item.props.label==='参数 1 类型')!.props.onChange('number'))
    act(()=>f.renderer.root.findByProps({label:'参数 1 必填'}).props.onChange(false))
    expect(f.value()).toEqual({...initial,outputSchema:[{name:'score',type:'number',required:false}]})
    act(()=>f.renderer.root.findByProps({'aria-label':'删除参数 1'}).props.onClick());expect(f.value()).toEqual({...initial,outputSchema:[]})
  })
  it('renders a saved schema and respects the existing read-only state',async()=>{
    const f=await fixture({outputSchema:[{name:'approved',type:'boolean',required:true,description:'审批结果'}]},true)
    expect(f.renderer.root.findByProps({'aria-label':'参数 1 名称'}).props.value).toBe('approved');expect(f.renderer.root.findByProps({'aria-label':'参数 1 名称'}).props.disabled).toBe(true)
    expect(f.renderer.root.findAllByType(Select).find(item=>item.props.label==='参数 1 类型')!.props.value).toBe('boolean');expect(f.renderer.root.findByProps({'aria-label':'删除参数 1'}).props.disabled).toBe(true)
  })
})
