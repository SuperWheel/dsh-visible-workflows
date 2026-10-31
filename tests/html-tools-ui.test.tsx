import React from 'react'
import {act,create,type ReactTestRenderer} from 'react-test-renderer'
import {afterEach,expect,it,vi} from 'vitest'
import {BUILTIN_TOOLS} from '../src/host/tool-catalog.ts'
import {ToolsPicker} from '../src/client/node-picker.tsx'
import {SpecificConfig} from '../src/client/node-config.tsx'
import {nodeSummary,nodeSize} from '../src/client/nodes.ts'
import {WorkflowStore} from '../src/client/store.ts'
import {makeWorkflow,type WorkflowAPI,type WorkflowNode} from '../src/shared/types.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Input:'input',Button:'button',Switch:'input',Modal:()=>null,Tooltip:({children}:any)=><>{children}</>,Menu:({anchor}:any)=><>{anchor}</>}))
vi.mock('../src/client/controls.tsx',()=>({Field:({label,help,children}:any)=><label data-field={label}>{label}{children}<small>{help}</small></label>,JsonEditor:({label,value}:any)=><textarea aria-label={label} value={JSON.stringify(value)} readOnly/>,Select:({label,value,options,onChange}:any)=><select aria-label={label} value={value} onChange={(e:any)=>onChange(e.target.value)}>{options.map((o:any)=><option key={o.id} value={o.id}>{o.label}</option>)}</select>}))
const cleanup:(()=>void)[]=[]
afterEach(()=>cleanup.splice(0).forEach(f=>f()))
it('renders HTML alongside time/JSON with the same provider, operation and SchemaDescription rows',async()=>{
  const selected=vi.fn();let view!:ReactTestRenderer
  await act(async()=>{view=create(<ToolsPicker api={{tools:async()=>BUILTIN_TOOLS}} workspaceId="w" search="" onSelect={selected}/>)});cleanup.push(()=>act(()=>view.unmount()))
  const providers=view.root.findAllByProps({className:'vdw-picker-row vdw-provider-row'})
  expect(providers.map(p=>p.findByType('strong').children.join('')).sort()).toEqual(['HTML 处理','JSON 处理','文件','时间'].sort())
  for(const provider of providers)act(()=>provider.props.onClick())
  for(const tool of BUILTIN_TOOLS){const row=view.root.findByProps({'aria-label':tool.name});expect(row.type).toBe('article');expect(row.props.className).toBe('vdw-tool-operation');expect(row.findByType('summary').children).toEqual(['参数说明']);const schema=row.findByProps({className:'vdw-tool-schema'});expect(schema.findAllByType('code').map(c=>c.children.join(''))).toEqual(Object.keys(tool.inputSchema.properties as object))}
  const html=BUILTIN_TOOLS.filter(t=>t.providerId==='builtin:html');expect(html).toHaveLength(2)
  for(const tool of html){expect(tool).toMatchObject({providerName:'HTML 处理',category:'plugin',author:'工作流内置'});expect(tool.inputSchema.required).toContain('html');expect(Object.keys(tool.inputSchema.properties as object)[0]).toBe('html');act(()=>view.root.findByProps({'aria-label':'添加工具：'+tool.name}).props.onClick());expect(selected).toHaveBeenLastCalledWith(tool)}
  expect(html.map(t=>t.description)).toEqual(['从 HTML 中提取页面标题和可读正文，不执行脚本，不访问网络。','按 CSS 选择器从 HTML 中提取多条记录的文本或属性；链接按页面地址补成绝对地址，不访问网络。'])
  expect(JSON.stringify(html[1]!.inputSchema)).toContain('h2 a')
})
it.each(['builtin:time.now','builtin:json.parse','builtin:html.extract_text','builtin:html.select'])('%s uses the generic ToolConfig fields and canvas summary',async id=>{
  const tool=BUILTIN_TOOLS.find(t=>t.id===id)!,flow=makeWorkflow('w','test',true),node:WorkflowNode={...flow.nodes[1]!,kind:'tool',config:{toolId:id,inputs:{}}},store=new WorkflowStore({tools:async()=>BUILTIN_TOOLS} as unknown as WorkflowAPI),changed=vi.fn()
  store.update({workflow:flow});let view!:ReactTestRenderer
  await act(async()=>{view=create(<SpecificConfig node={node} flow={flow} store={store} disabled={false} config={changed} onEnter={()=>{}}/>)});cleanup.push(()=>{act(()=>view.unmount());store.dispose()})
  expect(view.root.findAllByType('input').map(i=>i.props['aria-label'])).toEqual(Object.keys(tool.inputSchema.properties as object).map(k=>'工具参数 '+k))
  expect(view.root.findByProps({'aria-label':'完整参数 JSON'})).toBeDefined();expect(JSON.stringify(view.toJSON())).toContain(tool.description)
  expect(nodeSummary(node)).toBe(tool.providerName+' / '+tool.name);expect(nodeSize(node).width).toBe(256)
  if(id==='builtin:html.select'){const sample='{"name":{"selector":"h2 a","text":true},"link":{"selector":"h2 a","attr":"href"}}';expect((tool.inputSchema.properties as any).fields.description).toContain(sample);act(()=>view.root.findByProps({'aria-label':'工具参数 fields'}).props.onChange({target:{value:sample}}));expect(changed).toHaveBeenCalledWith({inputs:{fields:JSON.parse(sample)}})}
})
