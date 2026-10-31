import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeWorkflow, type NodeConfig, type Workflow, type WorkflowNode } from '../src/shared/types.ts'
import { assertGraph, parseWorkflow, protectFixedNodes } from '../src/shared/workflow-validation.ts'
import { exportWorkflowJson, importWorkflowJson } from '../src/shared/workflow-format.ts'
import { environmentReferences } from '../src/client/workflow-variables.ts'
import { nodeSummary, outputFields } from '../src/client/nodes.ts'
import { nodeOutputVariables } from '../src/client/variable-metadata.ts'
import { HttpConfig } from '../src/client/node-config.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Input:'input',Switch:'input'}))
vi.mock('../src/client/controls.tsx',()=>({
 Field:({label,children}:any)=>React.createElement('section',{'aria-label':label},children),
 Select:({label,value,options,onChange,disabled}:any)=>React.createElement('select',{'aria-label':label,value,disabled,onChange:(event:any)=>onChange(event.target.value)},options.map((option:any)=>React.createElement('option',{key:option.id,value:option.id},option.label))),
 JsonEditor:({label}:any)=>React.createElement('textarea',{'aria-label':label}),
}))
vi.mock('../src/client/code-editor.tsx',()=>({CodeEditor:({label}:any)=>React.createElement('textarea',{'aria-label':label})}))
const operation={secretVariableId:'secret-id',operationId:'deepseek.account-status.v1' as const}
function fixture():Workflow{
 const flow=makeWorkflow('workspace','protected HTTP',true)
 flow.environmentVariables=[{id:'secret-id',name:'DEEPSEEK_TOKEN',type:'secret'}]
 flow.nodes[1]={...flow.nodes[1]!,kind:'http',config:{credentialOperation:{...operation}}}
 flow.nodes[2]!.config.text=`{{${flow.nodes[1]!.id}.ok}}`
 return flow
}
function http(flow:Workflow):WorkflowNode{return flow.nodes[1]!}
const renderers:ReactTestRenderer[]=[]
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount())})

 describe('protected HTTP schema and reference boundaries',()=>{
 it('accepts a public operation declaration while retaining the original direct HTTP contract',()=>{
  const flow=parseWorkflow(fixture())
  expect(http(flow).config).toEqual({credentialOperation:operation})
  expect(()=>assertGraph(flow,true)).not.toThrow()
  http(flow).config={url:'https://example.invalid/',method:'GET',headers:{Accept:'application/json'},inputs:{query:'public'}}
  expect(http(parseWorkflow(flow)).config).toMatchObject({url:'https://example.invalid/',method:'GET',headers:{Accept:'application/json'},inputs:{query:'public'}})
 })
 it.each<[string,unknown]>([['timeoutMs',10000],['url',''],['method','GET'],['headers',{}],['bodyText',''],['inputs',{}],['secretRef','opaque'],['approved',true],['actor','user']])('rejects protected mode combined with %s', (key,value)=>{
  const flow=fixture();(http(flow).config as Record<string,unknown>)[key]=value
  expect(()=>parseWorkflow(flow)).toThrow()
 })
 it.each(['value','binding','grant','authorization','secretRef'])('rejects %s inside the public operation selector',key=>{
  const flow=fixture();(http(flow).config.credentialOperation as unknown as Record<string,unknown>)[key]='not-authority'
  expect(()=>parseWorkflow(flow)).toThrow()
 })
 it('rejects an arbitrary operation, non-HTTP use and missing or ordinary environment references',()=>{
  const flow=fixture();http(flow).config.credentialOperation!.operationId='arbitrary.execute' as never
  expect(()=>parseWorkflow(flow)).toThrow()
  const other=fixture();http(other).kind='tool';expect(()=>parseWorkflow(other)).toThrow()
  for(const type of [undefined,'string'] as const){const next=fixture();next.environmentVariables=type?[{id:'secret-id',name:'PUBLIC',type,value:'ordinary'}]:[];expect(()=>assertGraph(parseWorkflow(next))).toThrow('Secret 环境变量')}
 })
 it('continues rejecting all ordinary interpolation of a Secret including protected request fields',()=>{
  const flow=fixture();http(flow).config={url:'https://example.invalid/',headers:{Authorization:'Bearer {{env.secret-id}}'}}
  expect(()=>assertGraph(parseWorkflow(flow))).toThrow('Secret')
  const protectedFlow=fixture();protectedFlow.nodes[2]!.config.text='{{env.secret-id}}'
  expect(()=>assertGraph(parseWorkflow(protectedFlow))).toThrow('Secret')
 })
 it('counts structured Secret references and protects them behind fixed nodes',()=>{
  const flow=fixture();http(flow).fixed=true
  expect(environmentReferences(flow,'secret-id').map(node=>node.id)).toEqual([http(flow).id])
  for(const change of ['rename','delete','retype'] as const){const next=structuredClone(flow);if(change==='delete')next.environmentVariables=[];else if(change==='rename')next.environmentVariables![0]!.name='RENAMED';else next.environmentVariables=[{id:'secret-id',name:'DEEPSEEK_TOKEN',type:'string'}];expect(()=>protectFixedNodes(flow,next)).toThrow('环境变量')}
 })
 it('protects a structured Secret reference inside a fixed container child',()=>{
  const flow=fixture(),child=http(flow);child.fixed=true
  flow.nodes[1]={...child,id:'container',kind:'loop',fixed:false,config:{body:{nodes:[child],edges:[]}}}
  const next=structuredClone(flow);next.environmentVariables=[]
  expect(()=>protectFixedNodes(flow,next)).toThrow('环境变量')
 })
 it('exports only declarations and remaps the Secret identity on import without inheriting authorization',()=>{
  const source=fixture(),json=exportWorkflowJson(source,{includeEnvironmentValues:true}),envelope=JSON.parse(json)
  expect(envelope.workflow.environmentVariables).toEqual(source.environmentVariables)
  expect(envelope.workflow.nodes[1].config.credentialOperation).toEqual(operation)
  const imported=importWorkflowJson(json,'other-workspace')
  expect(imported.workflow.id).not.toBe(source.id)
  expect(imported.workflow.environmentVariables![0]!.id).not.toBe(operation.secretVariableId)
  expect(http(imported.workflow).config.credentialOperation).toEqual({...operation,secretVariableId:imported.workflow.environmentVariables![0]!.id})
  expect(imported.warnings.join(' ')).toContain('不继承原流程授权')
  expect(()=>assertGraph(imported.workflow)).not.toThrow()
 })
 it('offers only fixed safe outputs, including when historical data contains extra fields',()=>{
  const node=http(fixture()),poisoned={ok:true,status_code:200,text:'unexpected',body:'unexpected',headers:{authorization:'unexpected'}}
  expect(outputFields(node,poisoned)).toEqual(['ok','status_code'])
  expect(nodeOutputVariables(node,poisoned).map(item=>[item.name,item.type])).toEqual([['ok','boolean'],['status_code','number']])
  expect(nodeSummary(node)).toContain('受控凭据')
 })
})

describe('protected HTTP editor',()=>{
 async function editor(flow:Workflow){
  const node=http(flow),patch=vi.fn((next:Partial<NodeConfig>)=>{node.config={...node.config,...next}})
  let renderer!:ReactTestRenderer
  await act(async()=>{renderer=create(React.createElement(HttpConfig,{node,flow,disabled:false,config:patch}))})
  renderers.push(renderer)
  const refresh=()=>act(()=>renderer.update(React.createElement(HttpConfig,{node,flow,disabled:false,config:patch})))
  return {node,patch,renderer,refresh}
 }
 it('switches existing direct nodes by clearing all direct-request fields and exposes no value or URL controls',async()=>{
  const flow=fixture();http(flow).config={url:'https://example.invalid/',method:'POST',headers:{Accept:'application/json'},bodyText:'public',inputs:{value:'public'}}
  const {node,renderer,refresh}=await editor(flow)
  await act(async()=>renderer.root.findByProps({'aria-label':'HTTP 请求模式'}).props.onChange({target:{value:'protected'}}));refresh()
  expect(()=>parseWorkflow(flow)).not.toThrow()
  for(const key of ['url','method','headers','bodyText','inputs','timeoutMs'])expect((node.config as Record<string,unknown>)[key]).toBeUndefined()
  for(const label of ['请求地址','请求方法','请求头 Headers','请求正文 Body','环境变量值','请求超时（毫秒）'])expect(renderer.root.findAllByProps({'aria-label':label})).toHaveLength(0)
  expect(renderer.root.findByProps({'aria-label':'受控操作 Secret'}).props.value).toBe('secret-id')
  expect(JSON.stringify(renderer.toJSON())).toContain('选择声明不代表授权')
  expect(JSON.stringify(renderer.toJSON())).toContain('认证与操作最长3分钟；网络请求最长25秒')
  await act(async()=>renderer.root.findByProps({'aria-label':'HTTP 请求模式'}).props.onChange({target:{value:'direct'}}));refresh()
  expect(node.config.credentialOperation).toBeUndefined()
  expect(()=>parseWorkflow(flow)).not.toThrow()
  expect(renderer.root.findAllByProps({'aria-label':'请求地址'})).toHaveLength(2)
 })
 it('does not create an invalid reference when no Secret is declared',async()=>{
  const flow=fixture();flow.environmentVariables=[];http(flow).config={url:'https://example.invalid/'}
  const {patch,renderer}=await editor(flow)
  await act(async()=>renderer.root.findByProps({'aria-label':'HTTP 请求模式'}).props.onChange({target:{value:'protected'}}))
  expect(patch).not.toHaveBeenCalled()
  expect(JSON.stringify(renderer.toJSON())).toContain('先在高级设置的环境变量中添加密钥声明')
 })
})
