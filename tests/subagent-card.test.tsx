import React,{useState} from 'react'
import {act,create,type ReactTestRenderer} from 'react-test-renderer'
import {afterEach,describe,expect,it,vi} from 'vitest'
import {SubagentCard} from '../src/client/subagent-card.tsx'
import {makeWorkflow,type Workflow,type WorkflowNode} from '../src/shared/types.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Input:'input',Tooltip:({children}:{children:React.ReactNode})=><>{children}</>}))
vi.mock('../src/client/controls.tsx',()=>({Field:({children}:{children:React.ReactNode})=><>{children}</>,Select:({label,value,options,onChange,disabled}:any)=><select aria-label={label} value={value} disabled={disabled} onChange={event=>onChange(event.target.value)}>{options.map((option:any)=><option key={option.id} value={option.id}>{option.label}</option>)}</select>}))
vi.mock('../src/client/prompt-editor.tsx',()=>({PromptEditor:({label,value,onChange,disabled}:any)=><textarea aria-label={label} value={value} disabled={disabled} onChange={event=>onChange(event.target.value)}/>}))
const renderers:ReactTestRenderer[]=[]
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount())})
function mount(){
  const initial=makeWorkflow('w'),node:WorkflowNode={id:'n',number:'u-1',title:'Agent',kind:'agent',x:0,y:0,fixed:false,config:{prompt:'任务'}};initial.nodes.push(node)
  let flow!:Workflow,renderer!:ReactTestRenderer
  function Fixture(){const [value,setValue]=useState(initial);flow=value;return <SubagentCard flow={value} node={value.nodes.find(node=>node.id==='n')!} sessionId="main" presets={[{id:'role',name:'研究员',prompt:'认真研究',revision:3}]} onSettings={()=>{}} onChange={update=>setValue(current=>{const next=structuredClone(current);update(next);return next})}/>}
  act(()=>{renderer=create(<Fixture/>);renderers.push(renderer)})
  return {renderer,flow:()=>flow,input:(name:string)=>act(()=>renderer.root.findByProps({'aria-label':'子 Agent 名称'}).props.onChange({target:{value:name}})),click:(label:string)=>act(()=>renderer.root.findAllByProps({'aria-label':label}).find(node=>node.type==='button')!.props.onClick())}
}
describe('子 Agent 卡片',()=>{
  it('switches arrow to create plus for a new name, then stores unique identity and bound role in the workflow',()=>{
    const f=mount();expect(f.renderer.root.findAllByProps({'aria-label':'展开子 Agent 列表'}).length).toBeGreaterThan(0)
    f.input('分析员');f.click('创建子 Agent')
    expect(f.flow().subAgents).toHaveLength(1);expect(f.flow().subAgents![0]).toMatchObject({name:'分析员',number:'agent-1',sessionId:'main'})
    act(()=>f.renderer.root.findByType('select').props.onChange({target:{value:'role'}}))
    expect(f.flow().subAgents![0]).toMatchObject({prompt:'认真研究',rolePresetId:'role',rolePresetRevision:3})
    expect(f.flow().nodes.find(node=>node.id==='n')!.config.rolePresetId).toBeUndefined()
    expect(f.flow().nodes.find(node=>node.id==='n')!.config.prompt).toBe('任务')
  })
  it('offers all existing identities with the arrow and selects without making duplicates',()=>{
    const f=mount();f.input('A');f.click('创建子 Agent');const a=f.flow().subAgents![0]!.id
    f.input('B');f.click('创建子 Agent');f.click('展开子 Agent 列表')
    const options=f.renderer.root.findAllByProps({role:'option'});expect(options).toHaveLength(2)
    act(()=>options[0]!.props.onClick());expect(f.flow().subAgents).toHaveLength(2);expect(f.flow().nodes.find(node=>node.id==='n')!.config.subagentId).toBe(a)
    f.input('A');expect(f.renderer.root.findAllByProps({'aria-label':'创建子 Agent'})).toHaveLength(0)
  })
})
