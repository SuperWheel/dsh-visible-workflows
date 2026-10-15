import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VariableBrowser } from '../src/client/variable-browser.tsx'
import { nodeOutputVariables, scopeVariables } from '../src/client/variable-metadata.ts'
import { newNode } from '../src/client/nodes.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Tooltip:({children}:{children:React.ReactNode})=><>{children}</>}))
const renderers:ReactTestRenderer[]=[]
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount());vi.unstubAllGlobals()})
describe('readable variable references',()=>{
 it('uses declared code output schemas and actual tool outputs without inventing generic fields',()=>{
  const code=newNode('code');code.id='stable_code';code.config.outputSchema=[{name:'numbers',type:'array',description:'待排序的数值'}]
  expect(nodeOutputVariables(code)).toEqual([{name:'numbers',reference:'{{stable_code.numbers}}',type:'array',description:'待排序的数值'}])
  const tool=newNode('tool');tool.id='stable_tool';expect(nodeOutputVariables(tool)).toEqual([])
  const output=nodeOutputVariables(tool,{answer:0,ok:false,items:[],missing:null})
  expect(output.map(field=>[field.name,field.type])).toEqual([['answer','number'],['ok','boolean'],['items','array'],['missing','null']])
  expect(output.every(field=>field.description==='来自上次成功运行的输出')).toBe(true)
  expect(nodeOutputVariables(newNode('llm')).map(field=>field.name)).toEqual(['text'])
 })
 it('shows list records as dynamic until execution and does not mistake the extractor success flag for a boolean',()=>{
  const list=newNode('list')
  expect(nodeOutputVariables(list).find(field=>field.name==='first_record')?.type).toBe('动态类型')
  expect(nodeOutputVariables(list,{first_record:{title:'x'},last_record:null}).find(field=>field.name==='first_record')?.type).toBe('object')
  expect(nodeOutputVariables(newNode('extractor')).find(field=>field.name==='__is_success')?.type).toBe('number')
  const loop=newNode('loop');loop.config.initialVariables={count:'{{input.count}}'}
  expect(scopeVariables([loop],[],[]).find(field=>field.name==='vars.count')?.type).toBe('动态类型')
 })
 it('copies complete stable references while showing compact field names grouped by node',async()=>{
  const copy=vi.fn(async()=>{});vi.stubGlobal('navigator',{clipboard:{writeText:copy}})
  const node=newNode('code');node.id='verify_code';node.number='a-2';node.title='生成数据';node.config.outputSchema=[{name:'numbers',type:'array',description:'待排序的数值'}]
  let renderer!:ReactTestRenderer
  act(()=>{renderer=create(<VariableBrowser inputs={[{name:'text',label:'原始资料',required:true}]} nodes={[node]} parents={[]} executions={[]}/>);renderers.push(renderer)})
  expect(renderer.root.findAllByType('h4').map(title=>title.children.join(''))).toEqual(['工作流输入','a-2 · 生成数据'])
  expect(renderer.root.findByProps({title:'{{verify_code.numbers}}'}).children).toEqual(['numbers'])
  await act(async()=>{renderer.root.findByProps({'aria-label':'复制引用 {{verify_code.numbers}}'}).props.onClick()})
  expect(copy).toHaveBeenCalledWith('{{verify_code.numbers}}')
  expect(renderer.root.findByProps({role:'status'}).children).toEqual(['已复制'])
 })
 it('exposes the full selectable reference if clipboard permission fails',async()=>{
  vi.stubGlobal('navigator',{clipboard:{writeText:vi.fn(async()=>{throw new Error('denied')})}})
  let renderer!:ReactTestRenderer
  act(()=>{renderer=create(<VariableBrowser inputs={[{name:'text',label:'原始资料',required:true}]} nodes={[]} parents={[]} executions={[]}/>);renderers.push(renderer)})
  await act(async()=>{renderer.root.findByProps({'aria-label':'复制引用 {{input.text}}'}).props.onClick()})
  expect(renderer.root.findByProps({className:'vdw-variable-reference'}).children).toEqual(['{{input.text}}'])
  expect(renderer.root.findByProps({role:'status'}).children.join('')).toContain('复制失败')
 })
})
