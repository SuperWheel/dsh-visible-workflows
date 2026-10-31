import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowSettingsSection, NodePanel } from '../src/client/forms.tsx'
import { SubagentCard } from '../src/client/subagent-card.tsx'
import { WorkflowStore } from '../src/client/store.ts'
import { getLocale, LOCALE_STORAGE_KEY, setLocale, t } from '../src/client/i18n.ts'
import { nodeSummary, definition } from '../src/client/nodes.ts'
import { makeWorkflow, type RolePreset, type WorkflowAPI } from '../src/shared/types.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Input:({icon,...props}:any)=><input {...props}/>,Switch:'switch-mock',Tooltip:({children}:any)=><>{children}</>,Menu:({anchor}:any)=><>{anchor}</>,Modal:()=>null}))
vi.mock('../src/client/controls.tsx',()=>({Field:({label,children}:any)=><section><strong>{label}</strong>{children}</section>,HelpButton:()=>null,Select:({label,value,options,onChange,disabled}:any)=><select aria-label={label} value={value} disabled={disabled} onChange={event=>onChange(event.target.value)}>{options.map((option:any)=><option key={option.id} value={option.id}>{option.label}</option>)}</select>}))
vi.mock('../src/client/variable-browser.tsx',()=>({VariableBrowser:()=>null}))
const renderers:ReactTestRenderer[]=[],stores:WorkflowStore[]=[]
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount());for(const store of stores.splice(0))store.dispose();setLocale('zh-CN');vi.unstubAllGlobals()})
function storeWithPresets(presets:RolePreset[]=[]){const flow=makeWorkflow('workspace','保存',true),store=new WorkflowStore({httpCacheSettings:async()=>({httpCacheLimitMB:200,httpCacheImmediateCleanup:false})} as WorkflowAPI);stores.push(store);store.update({workflow:flow,loading:false,library:{workflows:[flow],presets,workspaces:[],runs:[]}});return {flow,store}}
describe('workflow language preferences',()=>{
 it('switches native settings rows immediately and persists the chosen language',async()=>{
  const storage={setItem:vi.fn()};vi.stubGlobal('localStorage',storage)
  const {store}=storeWithPresets();let ui!:ReactTestRenderer;await act(async()=>{ui=create(<WorkflowSettingsSection store={store}/>);renderers.push(ui)})
  act(()=>ui.root.findByProps({'aria-label':'界面语言'}).props.onChange({target:{value:'en'}}))
  expect(getLocale()).toBe('en');expect(storage.setItem).toHaveBeenCalledWith(LOCALE_STORAGE_KEY,'en')
  expect(ui.root.findByProps({'aria-label':'Interface language'}).props.value).toBe('en')
  expect(ui.root.findByProps({'aria-label':'Workflow save mode'}).findAllByType('option').map(option=>option.children.join(''))).toEqual(['Manual save','Autosave'])
  expect(ui.root.findAllByType('button').some(button=>button.children.includes('管理角色预设'))).toBe(false)
 })
 it('keeps user names and prompts unchanged while translating node labels and summaries',()=>{
  const global:RolePreset={id:'global',name:'保存',prompt:'工作流',revision:1},foreign:RolePreset={id:'foreign',name:'别的工作流',prompt:'不可泄漏角色',revision:1,scope:'workflow',workflowId:'other'}
  const {flow,store}=storeWithPresets([global,foreign]),node={...flow.nodes[1]!,kind:'llm' as const,title:'已保存',config:{prompt:'正在保存',rolePresetId:'global'}}
  let ui!:ReactTestRenderer;act(()=>{ui=create(<NodePanel node={node} flow={flow} store={store} disabled={false} onClose={()=>{}} onEnter={()=>{}} onSettings={()=>{}}/>);renderers.push(ui);setLocale('en')})
  expect(ui.root.findByProps({'aria-label':'Node name'}).props.value).toBe('已保存')
  expect(ui.root.findByProps({'aria-label':'Task prompt'}).props.value).toBe('正在保存')
  expect(ui.root.findByProps({'aria-label':'Role prompt'}).props.value).toBe('工作流')
  expect(ui.root.findByProps({'aria-label':'Select role preset'}).findAllByType('option').map(option=>option.children.join(''))).toEqual(['No role preset','保存'])
  expect(nodeSummary(node)).toBe('正在保存');expect(definition('llm').description).toMatch(/^Generate content/)
  expect(t('任意用户内容')).toBe('任意用户内容')
 })
 it('does not read or apply a preset scoped to another workflow',()=>{
  const foreign:RolePreset={id:'foreign',name:'外国预设',prompt:'不可泄漏角色',revision:1,scope:'workflow',workflowId:'other'}, {flow}=storeWithPresets([foreign])
  const node={...flow.nodes[1]!,kind:'agent' as const,config:{subagentId:'identity'}};flow.nodes[1]=node;flow.subAgents=[{id:'identity',number:'agent-1',name:'本地身份',prompt:'保留的角色快照',rolePresetId:'foreign'}]
  const edit=vi.fn();let ui!:ReactTestRenderer;act(()=>{ui=create(<SubagentCard flow={flow} node={node} presets={[foreign]} onChange={edit} onSettings={()=>{}}/>);renderers.push(ui)})
  const select=ui.root.findByProps({'aria-label':'选择子 Agent 角色预设'});expect(select.findAllByType('option').some(option=>option.children.includes('外国预设'))).toBe(false)
  expect(ui.root.findByProps({'aria-label':'子 Agent 角色提示词'}).props.value).toBe('保留的角色快照')
  act(()=>select.props.onChange({target:{value:'foreign'}}));expect(edit).not.toHaveBeenCalled()
 })
 it('uses explicit interpolation without interpreting user variable expressions',()=>{
  setLocale('en');expect(t('已选 {count} 个','{count} selected',{count:3})).toBe('3 selected')
  expect(t('任务：{prompt}','Task: {prompt}',{prompt:'{{input.text}} 中文'})).toBe('Task: {{input.text}} 中文')
 })
})
