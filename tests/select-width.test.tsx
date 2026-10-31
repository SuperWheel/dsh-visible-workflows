import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Select, selectMenuWidth } from '../src/client/controls.tsx'
import { selectStyles } from '../src/client/select-style.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Tooltip:({children}:{children:React.ReactNode})=><>{children}</>,Menu:({anchor,items,open,...props}:any)=><menu-mock {...props}>{anchor}{open&&items.map((item:any)=><button key={item.id} role="menuitem" onClick={()=>props.onSelect(item.id)}>{item.label}</button>)}</menu-mock>}))
const renderers:ReactTestRenderer[]=[]
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount());vi.unstubAllGlobals()})
function fixture(width:number,viewport=1041){
 const values=new Map<string,string>(),setProperty=vi.fn((key:string,value:string)=>values.set(key,value)),list={style:{getPropertyValue:(key:string)=>values.get(key)||'',setProperty}}
 const querySelector=vi.fn(()=>list);vi.stubGlobal('document',{querySelector});vi.stubGlobal('window',{innerWidth:viewport})
 const rect={width,left:100,right:100+width,top:100,bottom:132,height:32},trigger={getBoundingClientRect:()=>rect},change=vi.fn()
 let renderer!:ReactTestRenderer
 const long='自定义模型提供方 / 一个很长的模型名称（保留完整选项说明）'
 act(()=>{renderer=create(<Select label="模型" value="follow" options={[{id:'follow',label:'跟随 DSH'},{id:'custom',label:long}]} onChange={change}/>,{createNodeMock:element=>element.type==='button'?trigger:null});renderers.push(renderer)})
 return {renderer,rect,list,values,querySelector,setProperty,change,long,measure:()=>renderer.root.findByType('menu-mock').props.getAnchorRect()}
}
describe('Select portal sizing',()=>{
 it('matches the input-width trigger and remeasures when the sidebar changes',()=>{
  const f=fixture(322)
  expect(f.measure()).toBe(f.rect)
  expect(f.values.get('--vdw-select-trigger-width')).toBe('322px')
  f.rect.width=296;f.measure()
  expect(f.values.get('--vdw-select-trigger-width')).toBe('296px')
  expect(f.querySelector.mock.calls[0]![0]).toMatch(/^\.vdw-select-instance-/)
  f.measure();expect(f.setProperty).toHaveBeenCalledTimes(2)
 })
 it('fits narrow viewports and keeps complete option labels and selection behavior',()=>{
  const f=fixture(322,250);f.measure()
  expect(f.values.get('--vdw-select-trigger-width')).toBe('226px')
  act(()=>f.renderer.root.findByProps({'aria-label':'模型'}).props.onClick())
  const options=f.renderer.root.findAllByProps({role:'menuitem'})
  expect(options[1]!.children).toEqual([f.long])
  act(()=>options[1]!.props.onClick())
  expect(f.change).toHaveBeenCalledWith('custom')
  expect(f.renderer.root.findAllByProps({role:'menuitem'})).toHaveLength(0)
  expect(selectStyles).toContain('overflow-wrap:anywhere')
  expect(selectStyles).toContain('max-width:calc(100vw - 24px)')
 })
 it('never imposes a minimum wider than the trigger or available viewport',()=>{
  expect(selectMenuWidth(132,320)).toBe(132)
  expect(selectMenuWidth(322,160)).toBe(136)
  expect(selectMenuWidth(322,20)).toBe(0)
 })
})
