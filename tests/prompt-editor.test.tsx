import React, { useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PromptEditor } from '../src/client/prompt-editor.tsx'
import { Field } from '../src/client/controls.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({
 Button:'button',
 Tooltip:({children,label,openOnClick}:{children:React.ReactNode;label:string;openOnClick:boolean})=><div data-help={label} data-open-on-click={openOnClick}>{children}</div>,
 Modal:({children,footer,onClose,closeLabel,headless}:{children:React.ReactNode;footer:React.ReactNode;onClose:()=>void;closeLabel:string;headless?:boolean})=><div role="dialog">{children}{footer}{!headless&&<button aria-label={closeLabel} onClick={onClose}/>}</div>,
}))
const renderers:ReactTestRenderer[]=[]
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount());vi.unstubAllGlobals()})
function mount({readOnly=false,disabled=false}:{readOnly?:boolean;disabled?:boolean}={}){
 let current='',renderer!:ReactTestRenderer
 const changes=vi.fn()
 function Fixture(){const [value,setValue]=useState('请归纳 {{input.text}}。');current=value;return <PromptEditor label="任务提示词" role="USER" value={value} readOnly={readOnly} disabled={disabled} onChange={v=>{changes(v);setValue(v)}}/>}
 act(()=>{renderer=create(<Fixture/>);renderers.push(renderer)})
 return {renderer,changes,value:()=>current,open(){act(()=>renderer.root.findByProps({'aria-label':'展开任务提示词'}).props.onClick())}}
}
describe('prompt cards',()=>{
 it('expanded edits preserve variable syntax and immediately synchronize with the compact field',()=>{
  const f=mount();f.open()
  act(()=>f.renderer.root.findByProps({'aria-label':'任务提示词（展开）'}).props.onChange({target:{value:'保留 {{input.text}}\n🙂'}}))
  expect(f.value()).toBe('保留 {{input.text}}\n🙂')
  expect(f.renderer.root.findByProps({'aria-label':'任务提示词'}).props.value).toBe(f.value())
  act(()=>f.renderer.root.findByProps({'aria-label':'关闭展开任务提示词'}).props.onClick())
  expect(f.renderer.root.findAllByProps({role:'dialog'})).toHaveLength(0)
  expect(f.changes).toHaveBeenCalledOnce()
 })
 it.each([{readOnly:true},{disabled:true}])('protects readonly/running prompts while preserving copy and expanded viewing: %j',async(options)=>{
  const copy=vi.fn(async()=>{});vi.stubGlobal('navigator',{clipboard:{writeText:copy}})
  const f=mount(options);f.open()
  const expanded=f.renderer.root.findByProps({'aria-label':'任务提示词（展开）'})
  expect(expanded.props[options.readOnly?'readOnly':'disabled']).toBe(true)
  act(()=>expanded.props.onChange({target:{value:'must not change'}}))
  expect(f.changes).not.toHaveBeenCalled()
  await act(async()=>{f.renderer.root.findByProps({'aria-label':'复制任务提示词'}).props.onClick()})
  expect(copy).toHaveBeenCalledWith(f.value())
  expect(f.renderer.root.findByProps({role:'status'}).children).toEqual(['已复制'])
 })
 it('reports clipboard failure and counts Unicode characters without calling them tokens',async()=>{
  vi.stubGlobal('navigator',{clipboard:{writeText:vi.fn(async()=>{throw new Error('denied')})}})
  const f=mount()
  act(()=>f.renderer.root.findByProps({'aria-label':'任务提示词'}).props.onChange({target:{value:'🙂中'}}))
  expect(f.renderer.root.findByProps({'aria-label':'2 个字符'})).toBeTruthy()
  await act(async()=>{f.renderer.root.findByProps({'aria-label':'复制任务提示词'}).props.onClick()})
  expect(f.renderer.root.findByProps({role:'status'}).children).toEqual(['复制失败，请选择文字后复制。'])
 })
 it('uses pinnable host help and retains important visible field errors',()=>{
  let renderer!:ReactTestRenderer
  act(()=>{renderer=create(<><Field label="模型" help="继承 DSH"><input/></Field><Field label="思考强度" help="当前模型不支持" helpVisible><input/></Field></>);renderers.push(renderer)})
  expect(renderer.root.findByProps({'aria-label':'模型说明'}).type).toBe('button')
  expect(renderer.root.findByProps({'data-help':'继承 DSH'}).props['data-open-on-click']).toBe(true)
  expect(renderer.root.findByProps({className:'vdw-field-help'}).children).toEqual(['当前模型不支持'])
  expect(renderer.root.findAllByProps({'aria-label':'思考强度说明'})).toHaveLength(0)
 })
})

describe('节点备注复用长文本编辑器',()=>{
 it('不显示提示词角色，展开同步、可清空，紧凑与展开均限制2000字',()=>{
  let renderer!:ReactTestRenderer,current='原备注'
  function Note(){const [value,setValue]=useState(current);current=value;return <PromptEditor label="备注" help="仅作说明" placeholder="添加节点备注（可选）" rows={3} maxLength={2000} value={value} onChange={setValue}/>}
  act(()=>{renderer=create(<Note/>);renderers.push(renderer)})
  expect(renderer.root.findByType('strong').children).toEqual(['备注'])
  const compact=()=>renderer.root.findAllByType('textarea')[0]!
  expect(compact().props).toMatchObject({className:'vdw-prompt-body',maxLength:2000,rows:3,placeholder:'添加节点备注（可选）',style:{resize:'none'}})
  act(()=>renderer.root.findByProps({'aria-label':'展开备注'}).props.onClick())
  const expanded=renderer.root.findAllByType('textarea').find(node=>node.props['aria-label']==='备注（展开）')!
  expect(expanded.props.maxLength).toBe(2000)
  act(()=>expanded.props.onChange({target:{value:'改后备注\n第二行'}}))
  expect(compact().props.value).toBe('改后备注\n第二行')
  act(()=>expanded.props.onChange({target:{value:'字'.repeat(2001)}}))
  expect(current).toBe('改后备注\n第二行')
  act(()=>expanded.props.onChange({target:{value:''}}));expect(current).toBe('')
 })
})
