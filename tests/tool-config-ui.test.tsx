import React from 'react'
import {act,create,type ReactTestRenderer} from 'react-test-renderer'
import {afterEach,expect,it,vi} from 'vitest'
import {SpecificConfig} from '../src/client/node-config.tsx'
import {WorkflowStore} from '../src/client/store.ts'
import {BUILTIN_TOOLS} from '../src/shared/builtin-tools.ts'
import {makeWorkflow,type ToolChoice,type WorkflowAPI,type WorkflowNode} from '../src/shared/types.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Input:'input',Button:'button',Switch:'input',Modal:()=>null,Tooltip:({children}:any)=><>{children}</>,Menu:({anchor}:any)=><>{anchor}</>}))
vi.mock('../src/client/controls.tsx',()=>({Field:({label,help,children}:any)=><label>{label}{children}<small>{help}</small></label>,JsonEditor:({label,value}:any)=><textarea aria-label={label} value={JSON.stringify(value)} readOnly/>,Select:({label,value,options,onChange,disabled}:any)=><select aria-label={label} value={value} disabled={disabled} onChange={(e:any)=>onChange(e.target.value)}>{options.map((o:any)=><option key={o.id} value={o.id}>{o.label}</option>)}</select>}))

const cleanup:(()=>void)[]=[]
afterEach(()=>cleanup.splice(0).forEach(f=>f()))
function deferred(){let resolve!:(tools:ToolChoice[])=>void,reject!:(error:Error)=>void;const promise=new Promise<ToolChoice[]>((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
function mount(toolId:string,tools?:WorkflowAPI['tools']){
 const flow=makeWorkflow('w','test',true),node:WorkflowNode={...flow.nodes[1]!,kind:'tool',config:{toolId,inputs:{}}},store=new WorkflowStore({tools} as unknown as WorkflowAPI),changed=vi.fn()
 store.update({workflow:flow});let view!:ReactTestRenderer
 act(()=>{view=create(<SpecificConfig node={node} flow={flow} store={store} disabled={false} config={changed} onEnter={()=>{}}/>)})
 cleanup.push(()=>{act(()=>view.unmount());store.dispose()})
 return{view,store,changed,text:()=>JSON.stringify(view.toJSON())}
}
const remote:ToolChoice={id:'plugin:example.read',providerId:'example',providerName:'示例工具',name:'读取内容',description:'读取示例内容。',category:'plugin',available:true,inputSchema:{type:'object',properties:{source:{type:'string'}}}}
const unavailable='原工具操作不可用，请连接该工具或重新选择。'

it.each(BUILTIN_TOOLS)('$id resolves its label, description and fields before the catalog responds',async tool=>{
 const request=deferred(),tools=vi.fn(()=>request.promise),{view,text,changed}=mount(tool.id,tools)
 const assertResolved=()=>{
  expect(view.root.findByProps({'aria-label':'选择工具操作'}).findAllByType('option').filter(option=>option.props.value===tool.id).map(option=>option.children.join(''))).toEqual([`${tool.providerName} / ${tool.name}`])
  expect(view.root.findAll(field=>(field.type==='input'||field.type==='select')&&field.props['aria-label']?.startsWith('工具参数 ')).map(field=>field.props['aria-label'])).toEqual(Object.keys(tool.inputSchema.properties as object).map(key=>'工具参数 '+key))
  expect(text()).toContain(tool.description);expect(text()).not.toContain(unavailable);expect(text()).not.toContain('缺少工具')
  expect(view.root.findAllByProps({role:'status'})).toHaveLength(0)
 }
 expect(tools).toHaveBeenCalledWith('w','');assertResolved()
 await act(async()=>request.resolve([]));assertResolved()
 expect(changed).not.toHaveBeenCalled()
})

it('shows a neutral pending state until a remote tool resolves',async()=>{
 const request=deferred(),{view,text,changed}=mount(remote.id,()=>request.promise)
 expect(view.root.findByProps({role:'status'}).props.className).toBe('vdw-muted')
 expect(text()).toContain('正在读取工具…');expect(text()).not.toContain(unavailable);expect(text()).not.toContain('缺少工具')
 await act(async()=>request.resolve([remote]))
 expect(view.root.findAllByProps({role:'status'})).toHaveLength(0)
 expect(text()).toContain(`${remote.providerName} / ${remote.name}`);expect(text()).not.toContain(unavailable)
 expect(view.root.findByProps({'aria-label':'工具参数 source'})).toBeDefined();expect(changed).not.toHaveBeenCalled()
})

it.each([remote.id,'builtin:html.unknown'])('marks %s missing only after a successful catalog response',async id=>{
 const request=deferred(),{text}=mount(id,()=>request.promise)
 expect(text()).not.toContain(unavailable);expect(text()).not.toContain('缺少工具')
 await act(async()=>request.resolve([]))
 expect(text()).toContain(unavailable);expect(text()).toContain(`${id}（缺少工具）`);expect(text()).not.toContain('正在读取工具…')
})

it('reports a catalog failure without declaring a remote tool missing',async()=>{
 const request=deferred(),{text}=mount(remote.id,()=>request.promise)
 await act(async()=>request.reject(new Error('目录读取失败')))
 expect(text()).toContain('目录读取失败');expect(text()).not.toContain(unavailable);expect(text()).not.toContain('缺少工具');expect(text()).not.toContain('正在读取工具…')
})

it('keeps builtin fields available when the catalog fails or reports stale builtin metadata',async()=>{
 const tool=BUILTIN_TOOLS.find(tool=>tool.id==='builtin:html.select')!,request=deferred(),first=mount(tool.id,()=>request.promise)
 await act(async()=>request.reject(new Error('目录读取失败')))
 expect(first.view.root.findByProps({'aria-label':'工具参数 html'})).toBeDefined();expect(first.text()).not.toContain(unavailable)
 const second=mount(tool.id,async()=>[{...tool,name:'旧名称',available:false,unavailableReason:'旧状态'}])
 await act(async()=>{})
 expect(second.text()).toContain(`${tool.providerName} / ${tool.name}`);expect(second.text()).not.toContain('旧名称');expect(second.text()).not.toContain('旧状态')
})

it('distinguishes an unavailable remote tool from a missing operation',async()=>{
 const {text}=mount(remote.id,async()=>[{...remote,available:false,unavailableReason:'请连接示例工具'}])
 await act(async()=>{})
 expect(text()).toContain('请连接示例工具');expect(text()).toContain('（不可用）');expect(text()).not.toContain(unavailable)
})

it('reports a disconnected catalog without declaring the selected operation missing',()=>{
 const {text}=mount(remote.id)
 expect(text()).toContain('工具目录尚未连接');expect(text()).not.toContain(unavailable);expect(text()).not.toContain('缺少工具')
})

it('loads the new session catalog without retaining the previous missing state or accepting late results',async()=>{
 const first=deferred(),second=deferred(),third=deferred(),tools=vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise),{view,store,text}=mount(remote.id,tools)
 await act(async()=>first.resolve([]));expect(text()).toContain(unavailable)
 act(()=>store.update({sessionId:'session-2'}))
 expect(text()).toContain('正在读取工具…');expect(text()).not.toContain(unavailable)
 act(()=>store.update({sessionId:'session-3'}))
 await act(async()=>second.resolve([remote]))
 expect(text()).toContain('正在读取工具…');expect(view.root.findAllByProps({'aria-label':'工具参数 source'})).toHaveLength(0)
 await act(async()=>third.resolve([remote]))
 expect(text()).toContain(`${remote.providerName} / ${remote.name}`);expect(text()).not.toContain(unavailable)
 expect(tools.mock.calls).toEqual([['w',''],['w','session-2'],['w','session-3']])
})
