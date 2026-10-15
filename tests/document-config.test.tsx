import React, { useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentConfig } from '../src/client/node-config.tsx'
import { WorkflowStore } from '../src/client/store.ts'
import { makeWorkflow, type NodeConfig, type WorkflowAPI, type WorkflowNode } from '../src/shared/types.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Input:'input',Switch:'input',Tooltip:({children}:{children:React.ReactNode})=><>{children}</>,Modal:()=>null,Menu:({anchor,open,items,onSelect}:{anchor:React.ReactNode;open:boolean;items:{id:string;label:string}[];onSelect(id:string):void})=><>{anchor}{open&&<div role="menu">{items.map(item=><button key={item.id} data-choice={item.id} onClick={()=>onSelect(item.id)}>{item.label}</button>)}</div>}</>}))
const renderers:ReactTestRenderer[]=[]
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount())})
async function fixture(initial:NodeConfig){
 const tools=vi.fn(async()=>[]),store=new WorkflowStore({tools} as unknown as WorkflowAPI),flow=makeWorkflow('w');store.update({sessionId:'session'})
 let value!:NodeConfig,renderer!:ReactTestRenderer
 function Fixture(){const [config,setConfig]=useState(initial);value=config;const node:WorkflowNode={...flow.nodes[1]!,kind:'document',config};return <DocumentConfig flow={flow} node={node} store={store} disabled={false} config={patch=>setConfig(previous=>({...previous,...patch}))}/>}
 await act(async()=>{renderer=create(<Fixture/>);renderers.push(renderer)})
 return {renderer,tools,value:()=>value,select(id:string){act(()=>renderer.root.findByProps({'aria-label':'文档解析来源'}).props.onClick());act(()=>renderer.root.findByProps({'data-choice':id}).props.onClick())}}
}
describe('document parser configuration',()=>{
 it('keeps explicit model/tool choices when switching parsing sources and exposes the appropriate controls',async()=>{
  const initial:NodeConfig={documentMode:'local',source:'{{input.file}}',model:{provider:'p',model:'chosen'},effort:'low',tools:['native:reader'],toolId:'native:reader'}
  const f=await fixture(initial);expect(JSON.stringify(f.renderer.toJSON())).toContain('PDF、DOCX、图片')
  f.select('agent');expect(f.renderer.root.findByProps({'aria-label':'文档解析要求'})).toBeTruthy();expect(f.value()).toMatchObject({...initial,documentMode:'agent'})
  f.select('tool');expect(f.renderer.root.findByProps({'aria-label':'文档文件参数名'})).toBeTruthy();expect(f.value().model).toEqual(initial.model);expect(f.value().tools).toEqual(initial.tools)
  expect(f.tools).toHaveBeenCalledWith('w','session')
 })
 it('keeps a missing selected parser visible and does not replace it with another tool',async()=>{
  const f=await fixture({documentMode:'tool',source:'file.pdf',toolId:'native:missing'})
  expect(JSON.stringify(f.renderer.toJSON())).toContain('暂不可用');expect(f.value().toolId).toBe('native:missing')
 })
})
