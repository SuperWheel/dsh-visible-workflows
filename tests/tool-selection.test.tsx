import React, { useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolSelectionCard } from '../src/client/tool-selection.tsx'
import type { ToolEntry } from '../src/client/node-picker.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({
 Button:'button',Input:({icon,...props}:any)=><input {...props}/>,Switch:'switch-mock',Tooltip:({children}:any)=><>{children}</>,
 Menu:({anchor,open,items,onSelect}:any)=><>{anchor}{open&&<div role="menu">{items.map((item:any)=><button key={item.id} data-filter={item.id} onClick={()=>onSelect(item.id)}>{item.label}</button>)}</div>}</>,
}))
const renderers:ReactTestRenderer[]=[]
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount())})
const tools:ToolEntry[]=[
 {id:'mcp:reader',name:'读取文档',providerId:'docs',providerName:'文档服务',description:'全文读取',category:'mcp',available:true,inputSchema:{}},
 {id:'plugin:clock',name:'当前时间',providerId:'time',providerName:'时间工具',description:'查询时间',category:'plugin',available:true,inputSchema:{}},
 {id:'workflow:offline',name:'离线工作流',providerId:'workflow',providerName:'工作流',description:'已停止连接',category:'workflow',available:false,inputSchema:{}},
]
function mount({selected=['mcp:reader','workflow:offline','missing'],disabled=false,loading=false}:{selected?:string[];disabled?:boolean;loading?:boolean}={}){
 let current!:string[],renderer!:ReactTestRenderer
 const change=vi.fn()
 function Fixture(){const [value,setValue]=useState(selected);current=value;return <ToolSelectionCard tools={tools} selected={value} disabled={disabled} loading={loading} onChange={ids=>{change(ids);setValue(ids)}}/>}
 act(()=>{renderer=create(<Fixture/>);renderers.push(renderer)})
 return {renderer,change,selected:()=>current,search(value:string){act(()=>renderer.root.findByProps({'aria-label':'搜索可调用工具'}).props.onChange({target:{value}}))},filter(value:string){act(()=>renderer.root.findByProps({'aria-label':'筛选可调用工具'}).props.onClick());act(()=>renderer.root.findByProps({'data-filter':value}).props.onClick())}}
}
describe('可调用工具选择器',()=>{
 it('keeps the allowed-tools title and its help inside the searchable card',()=>{
  const f=mount(),card=f.renderer.root.findByProps({'aria-label':'可调用工具选择器'}),heading=card.findByProps({className:'vdw-tool-selection-heading'})
  expect(heading.findByType('strong').children).toEqual(['可调用工具'])
  expect(heading.findByProps({'aria-label':'可调用工具说明'})).toBeDefined()
  expect(card.findByProps({'aria-label':'搜索可调用工具'})).toBeDefined()
 })
 it('combines search and category filtering without changing tool authorization',()=>{
  const f=mount();f.filter('mcp');f.search('文档服务')
  expect(f.renderer.root.findAllByType('switch-mock')).toHaveLength(1)
  expect(f.renderer.root.findByProps({label:'授权 读取文档'}).props.checked).toBe(true)
  f.search('不存在');expect(JSON.stringify(f.renderer.toJSON())).toContain('没有符合条件的工具')
  expect(f.change).not.toHaveBeenCalled();expect(f.selected()).toEqual(['mcp:reader','workflow:offline','missing'])
  f.search('');f.filter('all');expect(f.renderer.root.findAllByType('switch-mock')).toHaveLength(3)
 })
 it('keeps missing tools removable and selected unavailable tools reversible',()=>{
  const f=mount();f.filter('selected')
  expect(f.renderer.root.findAllByType('switch-mock')).toHaveLength(2)
  act(()=>f.renderer.root.findByProps({'aria-label':'移除缺失工具 missing'}).props.onClick())
  expect(f.selected()).toEqual(['mcp:reader','workflow:offline'])
  const unavailable=f.renderer.root.findByProps({label:'授权 离线工作流'});expect(unavailable.props.disabled).toBe(false)
  act(()=>unavailable.props.onChange(false));expect(f.selected()).toEqual(['mcp:reader'])
  f.filter('all');expect(f.renderer.root.findByProps({label:'授权 离线工作流'}).props.disabled).toBe(true)
 })
 it('allows inspecting protected configuration while blocking authorization changes',()=>{
  const f=mount({disabled:true});f.filter('available');f.search('时间')
  const choice=f.renderer.root.findByProps({label:'授权 当前时间'});expect(choice.props.disabled).toBe(true)
  act(()=>choice.props.onChange(true));expect(f.change).not.toHaveBeenCalled()
 })
 it('does not label selected tools missing while their directory is loading',()=>{
  const f=mount({loading:true});expect(f.renderer.root.findAllByProps({'aria-label':'移除缺失工具 missing'})).toHaveLength(0)
  expect(f.renderer.root.findByProps({'aria-label':'可调用工具选择器'}).props['aria-busy']).toBe(true)
 })
})
