import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentExecutionActions, AgentProcessPanel } from '../src/client/agent-execution-actions.tsx'
import type { AgentNativeTaskView, AgentProcessView, NodeExecution } from '../src/shared/types.ts'
import type { WorkflowStore } from '../src/client/store.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Input:'input'}))
vi.mock('../src/client/data-viewer.tsx',()=>({DataViewer:()=>null}))
const renderers:ReactTestRenderer[]=[]
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount())})
const task=(values:Partial<AgentNativeTaskView>={}):AgentNativeTaskView=>({taskId:'action-child',executionId:'agent',status:'completed',startedAt:'2026-10-19T10:00:00Z',endedAt:'2026-10-19T10:00:01Z',steps:1,usage:{totalTokens:17},
  lifecycle:{cleanup:'completed',activationDisposed:true,childRegisteredAfterCleanup:false,ownedParentDisposed:true,ownedParentRegisteredAfterCleanup:false,errors:[],activation:{runId:'sdk-epoch',provider:'spawn',local:true,startedAt:'2026-10-19T10:00:00Z',endedAt:'2026-10-19T10:00:01Z',stopReason:'completed'}},...values})
async function panel(nativeTasks?:AgentNativeTaskView[]){
  const view:AgentProcessView={taskId:'action-child',status:'success',canSteer:false,events:[],messages:[],...(nativeTasks?{nativeTasks}:{})}
  const store={api:{agentProcess:vi.fn(async()=>view)}} as unknown as WorkflowStore
  let renderer!:ReactTestRenderer
  await act(async()=>{renderer=create(<AgentProcessPanel store={store} runId="run" executionId="agent"/>)})
  renderers.push(renderer);return renderer
}
const text=(renderer:ReactTestRenderer)=>JSON.stringify(renderer.toJSON())

describe('native lifecycle receipts in the existing Agent process panel',()=>{
  it('keeps one process panel beside the repair editor across repeated parent run refreshes without conflicting keys',async()=>{
    const errors=vi.spyOn(console,'error').mockImplementation(()=>{})
    try{
      const view:AgentProcessView={taskId:'action-child',status:'waiting',canSteer:false,events:[],messages:[],nativeTasks:[task()]}
      const query=vi.fn(async()=>view),store={api:{agentProcess:query}} as unknown as WorkflowStore
      const execution:NodeExecution={nodeId:'agent',executionId:'agent',number:'1',title:'Agent',status:'waiting',subagentId:'action-child',repair:{waiting:true,candidate:{text:'done'},limit:1,attempts:[]}}
      let renderer!:ReactTestRenderer
      await act(async()=>{renderer=create(<AgentExecutionActions store={store} runId="run" execution={execution}/>)})
      renderers.push(renderer)
      const toggle=()=>renderer.root.findAllByType('button').find(button=>button.children.includes('查看 Agent 过程')||button.children.includes('收起 Agent 过程'))!
      await act(async()=>toggle().props.onClick())
      for(let index=0;index<20;index++){
        await act(async()=>renderer.update(<AgentExecutionActions store={store} runId="run" execution={structuredClone(execution)}/>))
        expect(renderer.root.findAllByProps({'aria-label':'Agent 过程'})).toHaveLength(1)
        expect(renderer.root.findAllByProps({'aria-label':'原生任务生命周期'})).toHaveLength(1)
        expect(renderer.root.findAllByProps({'aria-label':'Agent 输出修正'})).toHaveLength(1)
      }
      expect(query).toHaveBeenCalledOnce()
      await act(async()=>toggle().props.onClick())
      expect(renderer.root.findAllByProps({'aria-label':'Agent 过程'})).toHaveLength(0)
      expect(renderer.root.findAllByProps({'aria-label':'Agent 输出修正'})).toHaveLength(1)
      expect(errors.mock.calls.filter(args=>args.some(value=>typeof value==='string'&&value.includes('same key')))).toEqual([])
    }finally{errors.mockRestore()}
  })
  it('preserves manual output across equal-candidate polls, submits it, and synchronizes genuinely new candidates and execution identities',async()=>{
    const accept=vi.fn(async()=>{}),store={api:{acceptRepairOutput:async()=>{}},acceptRepairOutput:accept} as unknown as WorkflowStore
    const execution:NodeExecution={nodeId:'agent',executionId:'agent',number:'1',title:'Agent',status:'waiting',subagentId:'action-child',repair:{waiting:true,candidate:{text:'done'},limit:1,attempts:[]}}
    let renderer!:ReactTestRenderer
    await act(async()=>{renderer=create(<AgentExecutionActions store={store} runId="run" execution={execution}/>)})
    renderers.push(renderer)
    const input=()=>renderer.root.findByProps({'aria-label':'修正后的输出 JSON'})
    const manual=JSON.stringify({text:'已验证原任务完成；本次仅人工补充既有输出说明，没有调用行动工具，也没有重新写入文件。'.repeat(2)})
    act(()=>input().props.onChange({target:{value:manual}}))
    for(let index=0;index<20;index++){
      await act(async()=>renderer.update(<AgentExecutionActions store={store} runId="run" execution={structuredClone(execution)}/>))
      expect(input().props.value).toBe(manual)
    }
    const confirm=renderer.root.findAllByType('button').find(button=>button.children.includes('确认修正输出并继续'))!
    await act(async()=>confirm.props.onClick())
    expect(accept).toHaveBeenCalledExactlyOnceWith('run','agent',JSON.parse(manual))
    const updated=structuredClone(execution);updated.repair!.candidate={text:'实际新候选'}
    await act(async()=>renderer.update(<AgentExecutionActions store={store} runId="run" execution={updated}/>))
    expect(input().props.value).toBe(JSON.stringify(updated.repair!.candidate,null,2))
    act(()=>input().props.onChange({target:{value:manual}}))
    await act(async()=>renderer.update(<AgentExecutionActions store={store} runId="another-run" execution={{...updated,executionId:'another-agent'}}/>))
    expect(input().props.value).toBe(JSON.stringify(updated.repair!.candidate,null,2))
  })
  it('shows confirmed release only from explicit host receipts and distinguishes action from output repair',async()=>{
    const renderer=await panel([task(),task({taskId:'repair-child',executionId:'agent/repair/1',usage:undefined})])
    expect(renderer.root.findAllByProps({'aria-label':'原任务'})).toHaveLength(1)
    expect(renderer.root.findAllByProps({'aria-label':'输出修复任务'})).toHaveLength(1)
    const rendered=text(renderer)
    expect(rendered).toContain('已确认（子任务）');expect(rendered).toContain('无残留');expect(rendered).toContain('已对齐');expect(rendered).toContain('sdk-epoch');expect(rendered).toContain('未知')
  })
  it('keeps cleanup unknown for an older host and for completed tasks without registry evidence',async()=>{
    const older=await panel()
    expect(text(older)).toContain('宿主未提供生命周期记录');expect(text(older)).not.toContain('已确认（子任务）')
    const missing=task();delete missing.lifecycle!.childRegisteredAfterCleanup;delete missing.lifecycle!.ownedParentDisposed;delete missing.lifecycle!.ownedParentRegisteredAfterCleanup;delete missing.lifecycle!.activation
    const renderer=await panel([missing])
    expect(text(renderer)).toContain('未确认');expect(text(renderer)).toContain('未知');expect(text(renderer)).not.toContain('已确认（子任务）');expect(text(renderer)).not.toContain('已对齐')
  })
  it('shows failed or unverified cleanup despite completed status and bounds the displayed tasks',async()=>{
    const failed=task({lifecycle:{cleanup:'failed',activationDisposed:false,childRegisteredAfterCleanup:true,errors:['activation teardown failed']}})
    const unverified=task({taskId:'unverified-child',executionId:'agent/repair/1',lifecycle:{cleanup:'unverified',activationDisposed:true,childRegisteredAfterCleanup:true,errors:[]}})
    const third=task({taskId:'unknown-child',executionId:'agent/repair/2',lifecycle:undefined})
    const renderer=await panel([failed,unverified,third,task({taskId:'must-not-display'})]),rendered=text(renderer)
    expect(rendered).toContain('失败');expect(rendered).toContain('activation teardown failed');expect(rendered).toContain('仍有残留');expect(rendered).toContain('未确认')
    expect(rendered).not.toContain('已确认（子任务）');expect(rendered).not.toContain('must-not-display')
  })
})
