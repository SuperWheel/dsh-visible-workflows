import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { RepairOutputEditor } from '../src/client/agent-execution-actions.tsx'
import { ExecutionPolicyDialog } from '../src/client/execution-policy.tsx'
import { WorkflowStore } from '../src/client/store.ts'
import { makeWorkflow, type NodeExecution, type WorkflowAPI, type WorkflowRun } from '../src/shared/types.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Input:'input',Modal:({children,footer}:any)=><div>{children}{footer}</div>}))
vi.mock('../src/client/controls.tsx',()=>({Field:({label,help,children}:any)=><label>{label}{help}{children}</label>,Select:({label,value,onChange,options}:any)=><select aria-label={label} value={value} onChange={(e:any)=>onChange(e.target.value)}>{options.map((option:any)=><option key={option.id} value={option.id}>{option.label}</option>)}</select>}))
vi.mock('../src/client/data-viewer.tsx',()=>({DataViewer:()=>null}))
const cleanups:(()=>void)[]=[]
afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup()})
function fixture(){
  const graph=makeWorkflow('workspace','repair',true),run:WorkflowRun={id:'run',workflowId:graph.id,workflowTitle:graph.title,workspaceId:graph.workspaceId,sourceRevision:1,graph,status:'paused',inputs:{},outputs:{},executions:[],startedAt:''}
  const api={confirmRepairOutput:vi.fn(async()=>run),acceptRepairOutput:vi.fn(),resume:vi.fn()} as unknown as WorkflowAPI
  const store=new WorkflowStore(api);store.update({workflow:graph,run,library:{workflows:[graph],presets:[],runs:[run],workspaces:[]}});cleanups.push(()=>store.dispose())
  return {store,api,run}
}
async function render(element:React.ReactElement){let renderer!:ReactTestRenderer;await act(async()=>{renderer=create(element)});cleanups.push(()=>act(()=>renderer.unmount()));return renderer}
const button=(renderer:ReactTestRenderer,label:string)=>renderer.root.findAllByType('button').find(item=>item.children.includes(label))!

it('requires a distinct model-repair confirmation bound to the current consumed count, without resuming',async()=>{
  const {store,api}=fixture(),execution:NodeExecution={nodeId:'agent',executionId:'agent',number:'a-2',title:'Agent',status:'waiting',repairAttemptsUsed:1,repair:{waiting:true,candidate:{text:2},usedAttempts:1,limit:2,attempts:[]}}
  const renderer=await render(<RepairOutputEditor store={store} runId="run" execution={execution}/>)
  expect(api.confirmRepairOutput).not.toHaveBeenCalled()
  await act(async()=>button(renderer,'允许一次模型修复').props.onClick())
  expect(api.confirmRepairOutput).toHaveBeenCalledWith('run','agent',1);expect(api.resume).not.toHaveBeenCalled();expect(api.acceptRepairOutput).not.toHaveBeenCalled()
  await act(async()=>renderer.update(<RepairOutputEditor store={store} runId="run" execution={{...execution,repairAttemptsUsed:2}}/>))
  expect(button(renderer,'允许一次模型修复').props.disabled).toBe(true)
})

it('saves the explicit A/B policy alongside numeric safety controls',async()=>{
  const {store}=fixture(),edited=vi.spyOn(store,'edit'),save=vi.spyOn(store,'save').mockResolvedValue(undefined)
  const renderer=await render(<ExecutionPolicyDialog store={store} onClose={()=>{}}/>),mode=renderer.root.findByProps({'aria-label':'输出修复策略'})
  expect(mode.props.value).toBe('confirm')
  await act(async()=>mode.props.onChange({target:{value:'auto'}}))
  await act(async()=>button(renderer,'保存').props.onClick())
  expect(edited).toHaveBeenLastCalledWith(expect.objectContaining({executionPolicy:{repairMode:'auto'}}));expect(save).toHaveBeenCalledOnce()
})
