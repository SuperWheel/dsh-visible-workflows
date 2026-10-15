import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodePicker, ToolsPicker, type ToolEntry } from '../src/client/node-picker.tsx'
import type { WorkflowAPI } from '../src/shared/types.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({
  Button:'button',Input:'input',Modal:()=>null,
  Tooltip:({children}:{children:React.ReactNode})=><>{children}</>,
  Menu:({anchor}:{anchor:React.ReactNode})=><>{anchor}</>,
}))
const renderers:ReactTestRenderer[]=[]
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount());vi.unstubAllGlobals()})
const available:ToolEntry={id:'format',name:'格式化',description:'按指定格式整理文本。',providerId:'text',providerName:'文本工具',category:'plugin',available:true,inputSchema:{type:'object',properties:{text:{type:'string',description:'需要整理的原文。'}},required:['text']}}
const unavailable:ToolEntry={...available,id:'missing',name:'未连接的工具',available:false,unavailableReason:'请先连接此工具。',inputSchema:{type:'object',properties:{}}}
async function mountTools(){
  const onSelect=vi.fn(),api={tools:vi.fn(async()=>[available,unavailable])}
  let renderer!:ReactTestRenderer
  await act(async()=>{renderer=create(<ToolsPicker api={api} workspaceId="workspace" sessionId="session" search="" onSelect={onSelect}/>);renderers.push(renderer)})
  act(()=>renderer.root.findByProps({className:'vdw-picker-row vdw-provider-row'}).props.onClick())
  return {renderer,onSelect,api}
}
describe('node and tool catalogue actions',()=>{
  it('opens the Agent strategy and adds its actual node only after the add action',()=>{
    vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()})
    const onAdd=vi.fn();let renderer!:ReactTestRenderer
    act(()=>{renderer=create(<NodePicker api={{} as WorkflowAPI} workspaceId="workspace" hasInput inLoop={false} onClose={vi.fn()} onAdd={onAdd}/>);renderers.push(renderer)})
    const agent=renderer.root.findAllByType('button').find(button=>button.props['aria-expanded']===false)!
    act(()=>agent.props.onClick())
    expect(onAdd).not.toHaveBeenCalled()
    act(()=>renderer.root.findByProps({'aria-label':'添加工具调用 Agent'}).props.onClick())
    expect(onAdd).toHaveBeenCalledExactlyOnceWith('agent')
  })
  it('keeps each tool action and its parameter description together and passes the original tool to selection',async()=>{
    const {renderer,onSelect,api}=await mountTools()
    expect(api.tools).toHaveBeenCalledWith('workspace','session')
    const item=renderer.root.findByProps({'aria-label':'格式化'})
    expect(item.type).toBe('article')
    const schema=item.findByProps({className:'vdw-tool-schema'})
    expect(schema.findByType('code').children).toEqual(['text'])
    expect(schema.findByType('p').children).toEqual(['需要整理的原文。'])
    act(()=>item.findByProps({'aria-label':'添加工具：格式化'}).props.onClick())
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(available)
  })
  it('keeps unavailable tools inspectable while blocking their action and displaying the concrete reason',async()=>{
    const {renderer,onSelect}=await mountTools()
    const item=renderer.root.findByProps({'aria-label':'未连接的工具'})
    const button=item.findByProps({'aria-label':'添加工具：未连接的工具'})
    expect(button.props.disabled).toBe(true)
    act(()=>button.props.onClick())
    expect(onSelect).not.toHaveBeenCalled()
    expect(item.findByProps({className:'vdw-error'}).children).toEqual(['请先连接此工具。'])
    expect(item.findByProps({className:'vdw-tool-schema'}).findByType('small').children).toEqual(['无需参数'])
  })
})
