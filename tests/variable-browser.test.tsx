import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VariableBrowser } from '../src/client/variable-browser.tsx'
import { nodeOutputVariables, scopeVariables } from '../src/client/variable-metadata.ts'
import { newNode } from '../src/client/nodes.ts'
import type { NodeExecution } from '../src/shared/types.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Tooltip:({children}:{children:React.ReactNode})=><>{children}</>}))
const renderers:ReactTestRenderer[]=[]
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount());vi.unstubAllGlobals()})
describe('readable variable references',()=>{
 it('offers an Agent declared field immediately from the unsaved graph without inventing tool results',async()=>{
  const copy=vi.fn(async()=>{});vi.stubGlobal('navigator',{clipboard:{writeText:copy}})
  const node=newNode('agent');node.id='agent-unsaved';node.config.outputSchema=[{name:'score',type:'number',description:'分析分数',required:true}]
  expect(nodeOutputVariables(node).map(field=>[field.name,field.type])).toEqual([['text','string'],['json','object'],['steps','number'],['score','number']])
  let renderer!:ReactTestRenderer
  act(()=>{renderer=create(<VariableBrowser inputs={[]} nodes={[node]} parents={[]} executions={[]}/>);renderers.push(renderer)})
  expect(renderer.root.findByProps({title:'{{agent-unsaved.score}}'}).children).toEqual(['score'])
  await act(async()=>renderer.root.findByProps({'aria-label':'复制引用 {{agent-unsaved.score}}'}).props.onClick());expect(copy).toHaveBeenCalledWith('{{agent-unsaved.score}}')
  expect(JSON.stringify(renderer.toJSON())).not.toContain('tool_results')
 })
 it('keeps runtime-owned Agent output types and applies declared schemas only to supported node kinds',()=>{
  const agent=newNode('agent');agent.config.outputSchema=[{name:'text',type:'number'},{name:'json',type:'array'},{name:'steps',type:'boolean'},{name:'extra',type:'boolean'}]
  expect(nodeOutputVariables(agent).map(field=>[field.name,field.type])).toEqual([['text','string'],['json','object'],['steps','number'],['extra','boolean']])
  const template=newNode('template');template.config.outputSchema=[{name:'text',type:'number'}];expect(nodeOutputVariables(template).find(field=>field.name==='text')?.type).toBe('string')
  const llm=newNode('llm');llm.config.outputSchema=[{name:'text',type:'number'}];expect(nodeOutputVariables(llm).find(field=>field.name==='text')?.type).toBe('string')
  const code=newNode('code');code.config.outputSchema=[{name:'text',type:'number'}];expect(nodeOutputVariables(code).find(field=>field.name==='text')?.type).toBe('number')
  expect(nodeOutputVariables(agent,{tool_results:[{receipt:'legacy'}]}).find(field=>field.name==='tool_results')?.type).toBe('array')
 })
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
 it('organizes each source into a labeled header and structured field content with name, type and description',()=>{
  const node=newNode('code');node.id='nested-stable-id';node.number='a-4:a-2';node.title='生成数据';node.config.outputSchema=[{name:'numbers',type:'array',description:'待排序的数值'},{name:'count',type:'number',description:'数值数量'}]
  let renderer!:ReactTestRenderer
  act(()=>{renderer=create(<VariableBrowser inputs={[]} nodes={[node]} parents={[]} executions={[]}/>);renderers.push(renderer)})
  const card=renderer.root.findByProps({className:'vdw-variable-card'}),header=card.findByType('header'),title=header.findByType('h4')
  expect(title.children.join('')).toBe('a-2 · 生成数据')
  expect(card.props['aria-labelledby']).toBe(title.props.id)
  expect(header.findByProps({className:'vdw-variable-count'}).children.join('')).toBe('2 个字段')
  const content=card.findByProps({className:'vdw-variable-content'}),rows=content.findAllByType('li')
  expect(content.findByType('ul').props['aria-label']).toBe('a-2 · 生成数据的可引用字段')
  expect(rows).toHaveLength(2)
  const [nameId,typeId]=rows[0]!.props['aria-labelledby'].split(' ')
  expect(rows[0]!.findByProps({id:nameId}).children).toEqual(['numbers'])
  expect(rows[0]!.findByProps({id:typeId}).children).toEqual(['array'])
  expect(rows[0]!.findByProps({id:rows[0]!.props['aria-describedby']}).children).toEqual(['待排序的数值'])
  expect(renderer.root.findAllByType('button').some(button=>button.children.includes('JSON'))).toBe(false)
 })
 it('uses actual successful output metadata without rendering values or adopting later failed output fields',()=>{
  const node=newNode('tool');node.id='stable-tool';node.number='a-2';node.title='查询工具'
  const record=(status:NodeExecution['status'],data:NodeExecution['data']):NodeExecution=>({nodeId:node.id,number:node.number,title:node.title,status,data})
  let renderer!:ReactTestRenderer
  act(()=>{renderer=create(<VariableBrowser inputs={[]} nodes={[node]} parents={[]} executions={[record('success',{answer:'真实值仅留在运行详情',ok:false}),record('failed',{should_not_exist:123})]}/>);renderers.push(renderer)})
  expect(renderer.root.findAllByProps({className:'vdw-variable-type'}).map(type=>type.children.join(''))).toEqual(['string','boolean'])
  expect(renderer.root.findByProps({title:'{{stable-tool.ok}}'}).children).toEqual(['ok'])
  const tree=JSON.stringify(renderer.toJSON())
  expect(tree).not.toContain('真实值仅留在运行详情')
  expect(tree).not.toContain('should_not_exist')
  expect(tree).toContain('来自上次成功运行的输出')
 })
 it('keeps undeclared tools and a completely empty browser explicit without inventing output fields',()=>{
  const tool=newNode('tool');tool.title='尚未运行的工具';tool.number='a-2'
  let renderer!:ReactTestRenderer
  act(()=>{renderer=create(<VariableBrowser inputs={[]} nodes={[tool]} parents={[]} executions={[]}/>);renderers.push(renderer)})
  expect(renderer.root.findByProps({className:'vdw-variable-count'}).children.join('')).toBe('0 个字段')
  expect(renderer.root.findAllByType('li')).toHaveLength(0)
  expect(renderer.root.findByProps({className:'vdw-variable-empty'}).children.join('')).toContain('尚无已声明或已运行的输出字段')
  act(()=>renderer.update(<VariableBrowser inputs={[]} nodes={[]} parents={[]} executions={[]}/>))
  expect(renderer.root.findByProps({className:'vdw-variable-empty'}).children.join('')).toContain('当前没有可引用的变量')
 })
 it('preserves scoped references and exposes the full fallback when the clipboard API is unavailable',async()=>{
  vi.stubGlobal('navigator',{})
  const parent=newNode('iteration')
  let renderer!:ReactTestRenderer
  act(()=>{renderer=create(<VariableBrowser inputs={[]} nodes={[]} parents={[parent]} executions={[]}/>);renderers.push(renderer)})
  expect(renderer.root.findByType('h4').children).toEqual(['当前循环作用域'])
  await act(async()=>renderer.root.findByProps({'aria-label':'复制引用 {{item}}'}).props.onClick())
  expect(renderer.root.findByProps({className:'vdw-variable-reference'}).children).toEqual(['{{item}}'])
  expect(renderer.root.findByProps({role:'status'}).children.join('')).toContain('复制失败')
 })
})
