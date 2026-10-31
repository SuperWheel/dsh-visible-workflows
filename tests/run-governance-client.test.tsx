import React from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeWorkflow, type WorkflowAPI, type WorkflowRecoveryPlan, type WorkflowRun, type WorkflowRunRevisionPlan } from '../src/shared/types.ts'
import { WorkflowStore } from '../src/client/store.ts'
import { RunGovernance, RunToolbar } from '../src/client/run-governance.tsx'
import { RecoveryPreview } from '../src/client/recovery-preview.tsx'
import { AgentProcessPanel, RepairOutputEditor, parseRepairOutput } from '../src/client/agent-execution-actions.tsx'
import { RunRevisionPreview } from '../src/client/run-revision-preview.tsx'
import { normalizeRun } from '../src/shared/run-compatibility.ts'
import { setLocale } from '../src/client/i18n.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Input:'input',Menu:({anchor}:any)=><>{anchor}</>,Tooltip:({children}:any)=><>{children}</>,Modal:({children,footer,...props}:any)=><modal-mock {...props}>{children}{footer}</modal-mock>}))
vi.mock('../src/client/data-viewer.tsx',()=>({DataViewer:({title,value}:any)=><data-viewer title={title}>{JSON.stringify(value)}</data-viewer>}))
const renderers:ReactTestRenderer[]=[],stores:WorkflowStore[]=[]
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount());for(const store of stores.splice(0))store.dispose()})
function fixture(){
  const flow=makeWorkflow('workspace','恢复测试',true),run:WorkflowRun={id:'source',workflowId:flow.id,workspaceId:flow.workspaceId,workflowTitle:flow.title,sourceRevision:1,graph:flow,status:'failed',inputs:{text:'input'},outputs:{},executions:[],startedAt:'2026-10-16T10:00:00Z'}
  const plan:WorkflowRecoveryPlan={sourceRunId:run.id,planDigest:'digest-1',invalidNodeIds:[],allowed:true,blockedReasons:[],items:[{executionId:'first',nodeId:flow.nodes[0]!.id,title:'已完成节点',action:'reuse',reason:'结果完整且依赖未变'},{executionId:'second',nodeId:flow.nodes[1]!.id,title:'待执行节点',action:'rerun',reason:'此前未执行'}]}
  const api={recoveryPlan:vi.fn(async()=>plan),recover:vi.fn(async()=>({...run,id:'restored',status:'success'})),rerun:vi.fn(async()=>({...run,id:'rerun',status:'success'}))} as unknown as WorkflowAPI
  const store=new WorkflowStore(api);stores.push(store);store.update({workflow:flow,run,library:{workflows:[flow],presets:[],runs:[run],workspaces:[]}})
  return{store,api,run,plan}
}
async function render(element:React.ReactElement){let renderer!:ReactTestRenderer;await act(async()=>{renderer=create(element)});renderers.push(renderer);return renderer}
const button=(renderer:ReactTestRenderer,label:string)=>renderer.root.findAllByType('button').find(item=>item.children.includes(label))!
const reviewSelect=(renderer:ReactTestRenderer)=>renderer.root.findByProps({'aria-label':'核验决定 action'})
const decisionOptions=(renderer:ReactTestRenderer)=>reviewSelect(renderer).findAllByType('option')
const selectDecision=(renderer:ReactTestRenderer,value:string)=>reviewSelect(renderer).props.onChange({target:{value}})
const renderedText=(node:ReactTestInstance):string=>node.children.map(child=>typeof child==='string'?child:renderedText(child)).join('')
const reviewStatus=(renderer:ReactTestRenderer)=>renderer.root.findAllByProps({role:'status'}).map(renderedText).join(' ')

describe('recovery preflight',()=>{
  it('loads and shows each recovery action before creating a run only on confirmation',async()=>{
    const {store,api,run}=fixture(),renderer=await render(<RunGovernance store={store} run={run}/>)
    await act(async()=>button(renderer,'创建恢复运行').props.onClick())
    expect(api.recoveryPlan).toHaveBeenCalledWith('source');expect(api.recover).not.toHaveBeenCalled()
    const text=JSON.stringify(renderer.toJSON());expect(text).toContain('复用结果');expect(text).toContain('重新执行');expect(text).toContain('结果完整且依赖未变')
    await act(async()=>button(renderer,'确认创建恢复运行').props.onClick())
    expect(api.recover).toHaveBeenCalledWith('source',undefined,'digest-1',undefined,expect.any(String));expect(store.getSnapshot().run?.id).toBe('restored')
  })
  it('shows blocked reasons and refuses recovery even if a conflicting plan says allowed',async()=>{
    const {store,api,run,plan}=fixture();plan.items[0]!.action='blocked';plan.blockedReasons=['外部操作结果未确认']
    const renderer=await render(<RecoveryPreview store={store} run={run} mode="recover" onClose={()=>{}}/>)
    expect(JSON.stringify(renderer.toJSON())).toContain('外部操作结果未确认');expect(button(renderer,'确认创建恢复运行').props.disabled).toBe(true)
    await act(async()=>button(renderer,'确认创建恢复运行').props.onClick());expect(api.recover).not.toHaveBeenCalled()
  })
  it('keeps recovery disabled after a failed or mismatched lookup and permits rechecking',async()=>{
    const {store,api,run,plan}=fixture();vi.mocked(api.recoveryPlan!).mockResolvedValueOnce({...plan,sourceRunId:'other'})
    const renderer=await render(<RecoveryPreview store={store} run={run} mode="recover" onClose={()=>{}}/>)
    expect(JSON.stringify(renderer.toJSON())).toContain('恢复计划与来源运行不一致');expect(button(renderer,'确认创建恢复运行').props.disabled).toBe(true)
    await act(async()=>button(renderer,'重新核验').props.onClick());expect(button(renderer,'确认创建恢复运行').props.disabled).toBe(false)
  })
  it('does not run when cancelled or while another active run appears',async()=>{
    const {store,api,run}=fixture(),close=vi.fn(),renderer=await render(<RecoveryPreview store={store} run={run} mode="recover" onClose={close}/>)
    act(()=>store.update({library:{...store.getSnapshot().library,runs:[run,{...run,id:'other',status:'running'}]}}))
    expect(button(renderer,'确认创建恢复运行').props.disabled).toBe(true)
    act(()=>button(renderer,'取消').props.onClick());expect(close).toHaveBeenCalledOnce();expect(api.recover).not.toHaveBeenCalled()
  })
  it('locks review decisions while checking and cannot accept a previous run response',async()=>{
    const {store,api,run,plan}=fixture();plan.allowed=false;plan.items=[{...plan.items[0]!,executionId:'action',action:'blocked',reviewable:true,reviewCanComplete:false}]
    const renderer=await render(<RecoveryPreview store={store} run={run} mode="recover" onClose={()=>{}}/>)
    expect(decisionOptions(renderer).some(option=>option.props.value==='completed')).toBe(false)
    act(()=>selectDecision(renderer,'redo'))
    act(()=>renderer.root.findByProps({'aria-label':'核验说明 action'}).props.onChange({target:{value:'checked'}}))
    let finish!:(value:WorkflowRecoveryPlan)=>void
    vi.mocked(api.recoveryPlan!).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
    const inspect=button(renderer,'检查核验决定').props.onClick
    act(()=>{void inspect();void inspect()})
    expect(api.recoveryPlan).toHaveBeenCalledTimes(2)
    expect(reviewStatus(renderer)).toContain('核验中…')
    expect(button(renderer,'核验中…').props.disabled).toBe(true)
    expect(button(renderer,'确认创建恢复运行').props.disabled).toBe(true)
    expect(button(renderer,'正在创建…')).toBeUndefined()
    expect(reviewSelect(renderer).props.disabled).toBe(true)
    expect(renderer.root.findByProps({'aria-label':'核验说明 action'}).props.disabled).toBe(true)
    act(()=>selectDecision(renderer,'abandon'))
    expect(reviewSelect(renderer).props.value).toBe('redo')
    const nextRun={...run,id:'new-source'},nextPlan={...plan,sourceRunId:'new-source',planDigest:'new-digest'}
    vi.mocked(api.recoveryPlan!).mockResolvedValueOnce(nextPlan)
    await act(async()=>renderer.update(<RecoveryPreview store={store} run={nextRun} mode="recover" onClose={()=>{}}/>))
    await act(async()=>finish({...plan,allowed:true,blockedReasons:[],items:[{...plan.items[0]!,action:'rerun'}]}))
    expect(button(renderer,'确认创建恢复运行').props.disabled).toBe(true)
    expect(reviewSelect(renderer).props.value).toBe('')
    expect(reviewStatus(renderer)).toContain('待核验');expect(reviewStatus(renderer)).not.toContain('核验通过')
    expect(api.recover).not.toHaveBeenCalled()
  })
  it.each([true,false])('starts with no decision and respects reviewCanComplete=%s',async reviewCanComplete=>{
    const {store,api,run,plan}=fixture();plan.allowed=false;plan.items=[{...plan.items[0]!,executionId:'action',action:'blocked',reviewable:true,reviewCanComplete}]
    const renderer=await render(<RecoveryPreview store={store} run={run} mode="recover" onClose={()=>{}}/>),select=reviewSelect(renderer),options=decisionOptions(renderer)
    expect(select.type).toBe('select')
    expect(options.map(option=>option.props.value)).toEqual(reviewCanComplete?['','completed','redo','abandon']:['','redo','abandon'])
    expect(select.props.value).toBe('')
    expect(options.find(option=>option.props.value==='')!.props.disabled).toBe(true)
    expect(reviewStatus(renderer)).toContain('待核验')
    expect(button(renderer,'检查核验决定').props.disabled).toBe(true)
    expect(button(renderer,'确认创建恢复运行').props.disabled).toBe(true)
    expect(button(renderer,'检查核验决定').props.variant).toBe('outline')
    expect(button(renderer,'重新核验').props.variant).toBe('outline')
    expect(button(renderer,'检查核验决定').parent).toBe(button(renderer,'重新核验').parent)
    expect(api.recoveryPlan).toHaveBeenCalledTimes(1);expect(api.recover).not.toHaveBeenCalled()
  })
  it('does not choose abandon when evidence is entered first and requires an explicit decision before Host checking',async()=>{
    const {store,api,run,plan}=fixture();plan.allowed=false;plan.items=[{...plan.items[0]!,executionId:'action',action:'blocked',reviewable:true,reviewCanComplete:false}]
    const renderer=await render(<RecoveryPreview store={store} run={run} mode="recover" onClose={()=>{}}/>)
    act(()=>renderer.root.findByProps({'aria-label':'核验说明 action'}).props.onChange({target:{value:'先填写核验依据'}}))
    expect(reviewSelect(renderer).props.value).toBe('')
    expect(reviewStatus(renderer)).toContain('待核验')
    expect(button(renderer,'检查核验决定').props.disabled).toBe(false)
    await act(async()=>button(renderer,'检查核验决定').props.onClick())
    expect(JSON.stringify(renderer.toJSON())).toContain('请选择处理决定，再检查核验结果。')
    expect(reviewStatus(renderer)).toContain('核验未通过')
    expect(api.recoveryPlan).toHaveBeenCalledTimes(1);expect(api.recover).not.toHaveBeenCalled()
    expect(button(renderer,'确认创建恢复运行').props.disabled).toBe(true)
    act(()=>selectDecision(renderer,'redo'))
    expect(reviewStatus(renderer)).toContain('待核验')
    expect(JSON.stringify(renderer.toJSON())).not.toContain('请选择处理决定，再检查核验结果。')
  })
  it('checks an explicit redo and confirms only the latest Host plan and review',async()=>{
    const {store,api,run,plan}=fixture(),close=vi.fn();plan.allowed=false;plan.items=[{...plan.items[0]!,executionId:'action',action:'blocked',reviewable:true,reviewCanComplete:false}]
    const renderer=await render(<RecoveryPreview store={store} run={run} mode="recover" onClose={close}/>),evidence=()=>renderer.root.findByProps({'aria-label':'核验说明 action'})
    act(()=>selectDecision(renderer,'redo'))
    expect(reviewSelect(renderer).props.value).toBe('redo')
    expect(button(renderer,'确认创建恢复运行').props.disabled).toBe(true);expect(api.recover).not.toHaveBeenCalled()
    const accepted=(digest:string):WorkflowRecoveryPlan=>({...plan,planDigest:digest,allowed:true,blockedReasons:[],items:[{...plan.items[0]!,action:'rerun'}]})
    act(()=>evidence().props.onChange({target:{value:'已核对目标，允许重做'}}))
    vi.mocked(api.recoveryPlan!).mockResolvedValueOnce(accepted('reviewed-2'))
    await act(async()=>button(renderer,'检查核验决定').props.onClick())
    expect(button(renderer,'确认创建恢复运行').props.disabled).toBe(false)
    expect(reviewStatus(renderer)).toContain('核验通过')
    act(()=>selectDecision(renderer,'abandon'))
    expect(reviewStatus(renderer)).toContain('待核验')
    expect(button(renderer,'确认创建恢复运行').props.disabled).toBe(true)
    act(()=>selectDecision(renderer,'redo'))
    act(()=>evidence().props.onChange({target:{value:'再次核对，采用最新说明'}}))
    expect(reviewStatus(renderer)).toContain('待核验')
    expect(button(renderer,'确认创建恢复运行').props.disabled).toBe(true)
    await act(async()=>button(renderer,'确认创建恢复运行').props.onClick())
    expect(api.recover).not.toHaveBeenCalled()
    vi.mocked(api.recoveryPlan!).mockResolvedValueOnce(accepted('reviewed-3'))
    await act(async()=>button(renderer,'检查核验决定').props.onClick())
    const latestReview={baseDigest:'digest-1',decisions:[{executionId:'action',action:'redo',evidence:'再次核对，采用最新说明'}]}
    expect(api.recoveryPlan).toHaveBeenLastCalledWith('source',latestReview)
    let finish!:(value:WorkflowRun)=>void
    vi.mocked(api.recover!).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
    const confirm=button(renderer,'确认创建恢复运行').props.onClick
    act(()=>{void confirm();void confirm()})
    expect(api.recover).toHaveBeenCalledExactlyOnceWith('source',undefined,'reviewed-3',latestReview,expect.any(String))
    expect(reviewSelect(renderer).props.disabled).toBe(true)
    expect(evidence().props.disabled).toBe(true);expect(close).not.toHaveBeenCalled()
    await act(async()=>finish({...run,id:'restored',status:'success'}))
    expect(close).toHaveBeenCalledOnce()
  })
  it('treats the note as optional: an empty note is omitted and the decision is checked',async()=>{
    const {store,api,run,plan}=fixture();plan.allowed=false;plan.items=[{...plan.items[0]!,executionId:'action',action:'blocked',reviewable:true,reviewCanComplete:false}]
    const renderer=await render(<RecoveryPreview store={store} run={run} mode="recover" onClose={()=>{}}/>)
    act(()=>selectDecision(renderer,'redo'))
    act(()=>renderer.root.findByProps({'aria-label':'核验说明 action'}).props.onChange({target:{value:' \n\t '}}))
    vi.mocked(api.recoveryPlan!).mockResolvedValueOnce({...plan,planDigest:'reviewed-empty',allowed:true,blockedReasons:[],items:[{...plan.items[0]!,action:'rerun'}]})
    await act(async()=>button(renderer,'检查核验决定').props.onClick())
    expect(api.recoveryPlan).toHaveBeenLastCalledWith('source',{baseDigest:'digest-1',decisions:[{executionId:'action',action:'redo'}]})
    expect(reviewStatus(renderer)).toContain('核验通过')
    expect(button(renderer,'确认创建恢复运行').props.disabled).toBe(false)
  })
  it('rejects overlong evidence locally but preserves a meaningful Host rejection for valid-length input',async()=>{
    const {store,api,run,plan}=fixture();plan.allowed=false;plan.items=[{...plan.items[0]!,executionId:'action',action:'blocked',reviewable:true,reviewCanComplete:false}]
    const renderer=await render(<RecoveryPreview store={store} run={run} mode="recover" onClose={()=>{}}/>),evidence=()=>renderer.root.findByProps({'aria-label':'核验说明 action'})
    act(()=>selectDecision(renderer,'redo'))
    for(const [value,message]of [[' '+ '字'.repeat(4001)+' ','回执或核验说明不能超过 4000 个字符。']]){
      act(()=>evidence().props.onChange({target:{value}}))
      await act(async()=>button(renderer,'检查核验决定').props.onClick())
      expect(JSON.stringify(renderer.toJSON())).toContain(message)
      expect(reviewStatus(renderer)).toContain('核验未通过')
      expect(button(renderer,'确认创建恢复运行').props.disabled).toBe(true)
      expect(api.recoveryPlan).toHaveBeenCalledTimes(1)
    }
    const valid='字'.repeat(4000)
    act(()=>evidence().props.onChange({target:{value:valid}}))
    vi.mocked(api.recoveryPlan!).mockRejectedValueOnce(new Error('核验依据已变化，请重新核验。'))
    await act(async()=>button(renderer,'检查核验决定').props.onClick())
    expect(api.recoveryPlan).toHaveBeenCalledTimes(2)
    expect(api.recoveryPlan).toHaveBeenLastCalledWith('source',{baseDigest:'digest-1',decisions:[{executionId:'action',action:'redo',evidence:valid}]})
    expect(JSON.stringify(renderer.toJSON())).toContain('核验依据已变化，请重新核验。')
    expect(reviewStatus(renderer)).toContain('核验未通过')
    expect(api.recover).not.toHaveBeenCalled()
  })
  it('explains invalid completed output locally and sends only a parsed JSON object to the Host',async()=>{
    const {store,api,run,plan}=fixture();plan.allowed=false;plan.items=[{...plan.items[0]!,executionId:'action',action:'blocked',reviewable:true,reviewCanComplete:true}]
    const renderer=await render(<RecoveryPreview store={store} run={run} mode="recover" onClose={()=>{}}/>)
    act(()=>selectDecision(renderer,'completed'))
    act(()=>renderer.root.findByProps({'aria-label':'核验说明 action'}).props.onChange({target:{value:'已核实外部回执'}}))
    const output=()=>renderer.root.findByProps({'aria-label':'核验输出 action'})
    for(const value of ['{','[]','null','42']){
      act(()=>output().props.onChange({target:{value}}))
      await act(async()=>button(renderer,'检查核验决定').props.onClick())
      expect(JSON.stringify(renderer.toJSON())).toContain(value==='{'?'已核实的输出不是有效 JSON，请检查引号、逗号和括号。':'请提供已核实的 JSON 对象输出。')
      expect(reviewStatus(renderer)).toContain('核验未通过')
      expect(api.recoveryPlan).toHaveBeenCalledTimes(1)
      expect(button(renderer,'确认创建恢复运行').props.disabled).toBe(true)
    }
    act(()=>output().props.onChange({target:{value:'{"verified":true,"count":0}'}}))
    vi.mocked(api.recoveryPlan!).mockResolvedValueOnce({...plan,planDigest:'completed-reviewed',allowed:true,blockedReasons:[],items:[{...plan.items[0]!,action:'reuse'}]})
    await act(async()=>button(renderer,'检查核验决定').props.onClick())
    expect(api.recoveryPlan).toHaveBeenLastCalledWith('source',{baseDigest:'digest-1',decisions:[{executionId:'action',action:'completed',evidence:'已核实外部回执',output:{verified:true,count:0}}]})
    expect(reviewStatus(renderer)).toContain('核验通过')
    expect(button(renderer,'确认创建恢复运行').props.disabled).toBe(false)
    expect(api.recover).not.toHaveBeenCalled()
  })
  it('reports a rejected Host plan and never treats a returned blocked plan as review success',async()=>{
    const {store,api,run,plan}=fixture();plan.allowed=false;plan.items=[{...plan.items[0]!,executionId:'action',action:'blocked',reviewable:true,reviewCanComplete:false}]
    const renderer=await render(<RecoveryPreview store={store} run={run} mode="recover" onClose={()=>{}}/>)
    act(()=>selectDecision(renderer,'redo'))
    act(()=>renderer.root.findByProps({'aria-label':'核验说明 action'}).props.onChange({target:{value:'已核对'}}))
    vi.mocked(api.recoveryPlan!).mockResolvedValueOnce({...plan,planDigest:'still-blocked',blockedReasons:['仍需核查外部回执']})
    await act(async()=>button(renderer,'检查核验决定').props.onClick())
    expect(reviewStatus(renderer)).toContain('核验未通过')
    expect(JSON.stringify(renderer.toJSON())).toContain('仍需核查外部回执')
    expect(reviewSelect(renderer).props.value).toBe('redo')
    expect(button(renderer,'确认创建恢复运行').props.disabled).toBe(true)
    await act(async()=>button(renderer,'确认创建恢复运行').props.onClick())
    expect(api.recover).not.toHaveBeenCalled()
  })
  it('resets a passed review and its form on recheck, then uses the newly returned base plan',async()=>{
    const {store,api,run,plan}=fixture();plan.allowed=false;plan.items=[{...plan.items[0]!,executionId:'action',action:'blocked',reviewable:true,reviewCanComplete:false}]
    const renderer=await render(<RecoveryPreview store={store} run={run} mode="recover" onClose={()=>{}}/>),evidence=()=>renderer.root.findByProps({'aria-label':'核验说明 action'})
    act(()=>selectDecision(renderer,'redo'));act(()=>evidence().props.onChange({target:{value:'先前核验说明'}}))
    vi.mocked(api.recoveryPlan!).mockResolvedValueOnce({...plan,planDigest:'reviewed-old',allowed:true,blockedReasons:[],items:[{...plan.items[0]!,action:'rerun'}]})
    await act(async()=>button(renderer,'检查核验决定').props.onClick())
    expect(reviewStatus(renderer)).toContain('核验通过')
    expect(button(renderer,'确认创建恢复运行').props.disabled).toBe(false)
    vi.mocked(api.recoveryPlan!).mockResolvedValueOnce({...plan,planDigest:'new-base'})
    await act(async()=>button(renderer,'重新核验').props.onClick())
    expect(api.recoveryPlan).toHaveBeenLastCalledWith('source')
    expect(reviewSelect(renderer).props.value).toBe('');expect(evidence().props.value).toBe('')
    expect(reviewStatus(renderer)).toContain('待核验');expect(reviewStatus(renderer)).not.toContain('核验通过')
    expect(button(renderer,'检查核验决定').props.disabled).toBe(true)
    expect(button(renderer,'确认创建恢复运行').props.disabled).toBe(true)
    act(()=>selectDecision(renderer,'redo'));act(()=>evidence().props.onChange({target:{value:'重新核验说明'}}))
    vi.mocked(api.recoveryPlan!).mockResolvedValueOnce({...plan,planDigest:'reviewed-new',allowed:true,blockedReasons:[],items:[{...plan.items[0]!,action:'rerun'}]})
    await act(async()=>button(renderer,'检查核验决定').props.onClick())
    expect(api.recoveryPlan).toHaveBeenLastCalledWith('source',{baseDigest:'new-base',decisions:[{executionId:'action',action:'redo',evidence:'重新核验说明'}]})
    expect(reviewStatus(renderer)).toContain('核验通过')
    expect(api.recover).not.toHaveBeenCalled()
  })
  it('requires a separate explicit full-rerun confirmation and never labels it reuse',async()=>{
    const {store,api,run}=fixture(),governance=await render(<RunGovernance store={store} run={run}/>)
    expect(button(governance,'按快照重跑')).toBeUndefined();expect(button(governance,'创建恢复运行')).toBeDefined()
    const renderer=await render(<RecoveryPreview store={store} run={run} mode="rerun" onClose={()=>{}}/>)
    expect(api.rerun).not.toHaveBeenCalled();expect(api.recoveryPlan).not.toHaveBeenCalled();expect(JSON.stringify(renderer.toJSON())).toContain('全部节点重新执行')
    await act(async()=>button(renderer,'确认全部重新执行').props.onClick());expect(api.rerun).toHaveBeenCalledOnce()
  })
})

describe('Agent process and manual repair',()=>{
  it('shows only returned host events and blocks unsupported steering',async()=>{
    const {store,api}=fixture();api.agentProcess=vi.fn(async()=>({taskId:'native-task',status:'running',canSteer:false,unavailableReason:'宿主未提供当前任务 steering',events:[{id:'event-1',taskId:'native-task',at:'2026-10-16T10:00:00Z',kind:'tool',summary:'读取了指定文档'}],messages:[]}));api.followupAgent=vi.fn()
    const renderer=await render(<AgentProcessPanel store={store} runId="source" executionId="agent"/>)
    const text=JSON.stringify(renderer.toJSON());expect(text).toContain('读取了指定文档');expect(text).toContain('宿主未提供当前任务 steering');expect(text).not.toContain('思考中')
    expect(button(renderer,'发送补充指令').props.disabled).toBe(true);expect(renderer.root.findByProps({'aria-label':'Agent 补充指令'}).props.disabled).toBe(true)
  })
  it('retains a stable message id for retry, changes it for changed content, and updates accepted run state',async()=>{
    const {store,api,run}=fixture();api.agentProcess=vi.fn(async()=>({taskId:'native-task',status:'running',canSteer:true,events:[],messages:[]}));api.followupAgent=vi.fn().mockRejectedValueOnce(new Error('暂时不可达')).mockRejectedValueOnce(new Error('暂时不可达')).mockResolvedValue({...run,status:'success'})
    const renderer=await render(<AgentProcessPanel store={store} runId="source" executionId="agent"/>),input=()=>renderer.root.findByProps({'aria-label':'Agent 补充指令'})
    act(()=>input().props.onChange({target:{value:'补充约束'}}));await act(async()=>button(renderer,'发送补充指令').props.onClick())
    const first=vi.mocked(api.followupAgent).mock.calls[0]![3];expect(first).toMatch(/^[a-f0-9-]{36}$/);expect(input().props.value).toBe('补充约束')
    await act(async()=>button(renderer,'发送补充指令').props.onClick());expect(vi.mocked(api.followupAgent).mock.calls[1]![3]).toBe(first)
    act(()=>input().props.onChange({target:{value:'修改后的补充约束'}}));await act(async()=>button(renderer,'发送补充指令').props.onClick());expect(vi.mocked(api.followupAgent).mock.calls[2]![3]).not.toBe(first);expect(input().props.value).toBe('');expect(store.getSnapshot().run?.status).toBe('success')
  })
  it('does not allow plain resume when an Agent output is waiting for manual repair',async()=>{
    const {store,api,run}=fixture();run.status='paused';run.executions=[{nodeId:'agent',executionId:'agent-execution',number:'a-2',title:'Agent',status:'waiting',repair:{waiting:true,candidate:{answer:42},limit:2,attempts:[]}}];api.resume=vi.fn()
    const renderer=await render(<RunToolbar store={store} working={false} onExecute={()=>{}} onAction={()=>{}}/>)
    expect(renderer.root.findByProps({'aria-label':'继续运行'}).props.disabled).toBe(true);expect(renderer.root.findAllByType('span').some(item=>item.children.includes('待修正'))).toBe(true)
    await expect(store.control('resume',run.id)).rejects.toThrow('待修正');expect(api.resume).not.toHaveBeenCalled()
  })
  it('preserves rejected manual edits and resumes only after host validation accepts an object',async()=>{
    const {store,api,run}=fixture(),execution={nodeId:'agent',executionId:'agent-execution',number:'a-2',title:'Agent',status:'waiting' as const,repair:{waiting:true,candidate:{answer:42},limit:2,reason:'answer 应为字符串',attempts:[{taskId:'repair-task',error:'类型错误',candidate:{answer:42}}]}}
    api.acceptRepairOutput=vi.fn().mockRejectedValueOnce(new Error('answer 应为字符串')).mockResolvedValue({...run,status:'success'})
    const renderer=await render(<RepairOutputEditor store={store} runId="source" execution={execution}/>),input=()=>renderer.root.findByProps({'aria-label':'修正后的输出 JSON'})
    act(()=>input().props.onChange({target:{value:'[]'}}));await act(async()=>button(renderer,'确认修正输出并继续').props.onClick());expect(api.acceptRepairOutput).not.toHaveBeenCalled();expect(JSON.stringify(renderer.toJSON())).toContain('须为 JSON 对象')
    act(()=>input().props.onChange({target:{value:'{"answer":42}'}}));await act(async()=>button(renderer,'确认修正输出并继续').props.onClick());expect(input().props.value).toBe('{"answer":42}');expect(JSON.stringify(renderer.toJSON())).toContain('answer 应为字符串')
    act(()=>input().props.onChange({target:{value:'{"answer":"42"}'}}));await act(async()=>button(renderer,'确认修正输出并继续').props.onClick());expect(api.acceptRepairOutput).toHaveBeenLastCalledWith('source','agent-execution',{answer:'42'});expect(store.getSnapshot().run?.status).toBe('success')
  })
  it('rejects primitives and incomplete JSON before submitting a repair',()=>{
    for(const text of ['null','42','"text"','[]','{'])expect(()=>parseRepairOutput(text)).toThrow()
    expect(parseRepairOutput('{"confirmed":false}')).toEqual({confirmed:false})
  })
})

describe('paused run revision preview',()=>{
  function revisionFixture(){
    const value=fixture(),{store,api,run,plan}=value;run.status='paused'
    const revisionPlan:WorkflowRunRevisionPlan={...plan,planDigest:'revision-digest',baseRevision:1,targetRevision:2,invalidNodeIds:[run.graph.nodes[1]!.id],changes:[{nodeId:run.graph.nodes[1]!.id,title:'修改模板',before:{text:'before'},after:{text:'after'}}]}
    api.previewRunRevision=vi.fn(async()=>revisionPlan);api.applyRunRevision=vi.fn(async()=>({...run,status:'paused',activeRevision:2}));api.resume=vi.fn()
    store.update({sessionId:'session-one'})
    return{...value,revisionPlan}
  }
  it('previews a frozen canvas candidate and applies that same candidate without automatically resuming',async()=>{
    const {store,api,run}=revisionFixture(),renderer=await render(<RunGovernance store={store} run={run}/>),original=structuredClone(store.getSnapshot().workflow!)
    await act(async()=>button(renderer,'将当前画布应用到本次运行').props.onClick())
    expect(api.previewRunRevision).toHaveBeenCalledWith(run.id,original,'session-one');expect(api.applyRunRevision).not.toHaveBeenCalled()
    const text=JSON.stringify(renderer.toJSON());expect(text).toContain('修改模板');expect(text).toContain('保留并复用');expect(text).toContain('继续后重新执行');expect(text).toContain('结果完整且依赖未变')
    act(()=>store.update({workflow:{...original,description:'窗口打开后的新修改'}}))
    await act(async()=>button(renderer,'确认应用并保持暂停').props.onClick())
    expect(api.applyRunRevision).toHaveBeenCalledWith(run.id,original,'revision-digest','session-one');expect(api.resume).not.toHaveBeenCalled();expect(store.getSnapshot().run).toMatchObject({id:run.id,status:'paused',activeRevision:2});expect(store.getSnapshot().workflow?.description).toBe('窗口打开后的新修改')
    expect(JSON.stringify(renderer.toJSON())).toContain('修订已应用，本次运行仍暂停')
  })
  it('cancels after read-only preview without changing the run',async()=>{
    const {store,api,run}=revisionFixture(),close=vi.fn(),applied=vi.fn(),renderer=await render(<RunRevisionPreview store={store} run={run} candidate={structuredClone(run.graph)} sessionId="session-one" onClose={close} onApplied={applied}/>),before=structuredClone(store.getSnapshot().run)
    act(()=>button(renderer,'取消').props.onClick());expect(close).toHaveBeenCalledOnce();expect(api.applyRunRevision).not.toHaveBeenCalled();expect(api.resume).not.toHaveBeenCalled();expect(applied).not.toHaveBeenCalled();expect(store.getSnapshot().run).toEqual(before)
  })
  it('shows host rejection reasons and keeps blocked plans disabled',async()=>{
    const {store,api,run,revisionPlan}=revisionFixture();revisionPlan.allowed=false;revisionPlan.blockedReasons=['固定节点不允许修改'];revisionPlan.items[0]!.action='blocked'
    const renderer=await render(<RunRevisionPreview store={store} run={run} candidate={run.graph} onClose={()=>{}} onApplied={()=>{}}/>)
    expect(JSON.stringify(renderer.toJSON())).toContain('固定节点不允许修改');expect(button(renderer,'确认应用并保持暂停').props.disabled).toBe(true)
    await act(async()=>button(renderer,'确认应用并保持暂停').props.onClick());expect(api.applyRunRevision).not.toHaveBeenCalled()
  })
  it('disables confirmation when a paused run resumes while the preview is open',async()=>{
    const {store,api,run}=revisionFixture(),renderer=await render(<RunRevisionPreview store={store} run={run} candidate={run.graph} onClose={()=>{}} onApplied={()=>{}}/>)
    act(()=>store.update({library:{...store.getSnapshot().library,runs:[{...run,status:'running'}]}}))
    expect(button(renderer,'确认应用并保持暂停').props.disabled).toBe(true);await act(async()=>button(renderer,'确认应用并保持暂停').props.onClick());expect(api.applyRunRevision).not.toHaveBeenCalled()
  })
  it('retains the exact candidate after server validation failure for read-only rechecking',async()=>{
    const {store,api,run}=revisionFixture(),candidate=structuredClone(run.graph),close=vi.fn();vi.mocked(api.applyRunRevision!).mockRejectedValue(new Error('计划已过期，请重新核验'))
    const renderer=await render(<RunRevisionPreview store={store} run={run} candidate={candidate} onClose={close} onApplied={()=>{}}/>)
    await act(async()=>button(renderer,'确认应用并保持暂停').props.onClick());expect(close).not.toHaveBeenCalled();expect(JSON.stringify(renderer.toJSON())).toContain('计划已过期')
    act(()=>store.update({workflow:{...candidate,title:'后续编辑'}}));await act(async()=>button(renderer,'重新核验同一修订').props.onClick());expect(api.previewRunRevision).toHaveBeenLastCalledWith(run.id,candidate,undefined);expect(api.resume).not.toHaveBeenCalled()
  })
  it.each(['running','budget_waiting','success'] as const)('does not expose revision application for a %s run',async status=>{
    const {store,run}=revisionFixture();run.status=status
    const renderer=await render(<RunGovernance store={store} run={run}/>);expect(button(renderer,'将当前画布应用到本次运行')).toBeUndefined()
  })
  it('does not expose revision application while manual output repair is pending',async()=>{
    const {store,run}=revisionFixture();run.executions=[{nodeId:'agent',number:'a-2',title:'Agent',status:'waiting',repair:{waiting:true,candidate:{},limit:0,attempts:[]}}]
    const renderer=await render(<RunGovernance store={store} run={run}/>);expect(button(renderer,'将当前画布应用到本次运行')).toBeUndefined()
  })
})


describe('usage-only run statistics',()=>{
  it.each(['zh-CN','en'] as const)('shows normalized old JSON usage with %s usage labels',async locale=>{
    const {store,run}=fixture()
    const loaded=normalizeRun(JSON.parse(JSON.stringify({...run,budget:{spentTokens:1234,reservedTokens:90000,unknownTokens:777,unknownCalls:2,calls:3,agentTasks:1,allocations:{}},budgetRootRunId:'root'})))
    act(()=>setLocale(locale))
    try {
      const renderer=await render(<RunGovernance store={store} run={loaded}/>),text=JSON.stringify(renderer.toJSON())
      expect(text).toContain(locale==='en'?'Token usage':'Token 用量');expect(text).toContain('1,234')
      expect(text).toContain(locale==='en'?'Calls with unknown usage':'未知用量调用')
      for(const removed of ['预算','额度','费用','budget','cost','90,000'])expect(text.toLowerCase()).not.toContain(removed)
    } finally {act(()=>setLocale('zh-CN'))}
  })
  it('reports known actual tokens and unknown calls without displaying limits or reservations',async()=>{
    const {store,run}=fixture();run.usage={spentTokens:1234,reservedTokens:4321,unknownTokens:9999,unknownCalls:2,calls:3,agentTasks:1,limit:5000,allocations:{}}
    const renderer=await render(<RunGovernance store={store} run={run}/>),text=JSON.stringify(renderer.toJSON())
    expect(text).toContain('Token 用量');expect(text).toContain('1,234');expect(text).toContain('未知用量调用')
    expect(text).not.toContain('待返回用量回执')
    for(const removed of ['预算','预留','额度','4,321','9,999','5,000','确认增加'])expect(text).not.toContain(removed)
    expect(renderer.root.findAllByType('input')).toHaveLength(0)
  })
  it('counts actual pending receipts separately from unknown calls even on a terminal run',async()=>{
    const {store,run}=fixture();run.status='success';run.usage={spentTokens:42,reservedTokens:90000,unknownTokens:0,unknownCalls:1,calls:4,agentTasks:0,allocations:{pendingA:{tokens:40000,status:'reserved'},pendingB:{tokens:50000,status:'reserved'},unknown:{tokens:0,status:'unknown'},done:{tokens:0,status:'settled',usage:42}}}
    const renderer=await render(<RunGovernance store={store} run={run}/>),rows=renderer.root.findByType('dl').children.filter((child):child is ReactTestInstance=>typeof child!=='string')
    const value=(label:string)=>{const index=rows.findIndex(row=>renderedText(row)===label);return renderedText(rows[index+1]!)}
    expect(value('待返回用量回执')).toBe('2');expect(value('未知用量调用')).toBe('1');expect(value('已报告实际用量')).toBe('42')
    const text=JSON.stringify(renderer.toJSON());for(const removed of ['90,000','40,000','50,000','预算','额度','预留'])expect(text).not.toContain(removed)
  })
  it('does not infer pending receipts from old token amounts when allocation records are missing',async()=>{
    const {store,run}=fixture();run.usage={spentTokens:9,reservedTokens:90000,unknownTokens:0,unknownCalls:0,calls:1,agentTasks:0,allocations:undefined as never}
    const renderer=await render(<RunGovernance store={store} run={run}/>),text=JSON.stringify(renderer.toJSON())
    expect(text).not.toContain('待返回用量回执');expect(text).not.toContain('90,000');expect(text).toContain('已报告实际用量')
  })
  it('keeps historical budget-waiting runs understandable without adjustment actions',async()=>{
    const {store,run}=fixture();run.status='budget_waiting';store.update({library:{...store.getSnapshot().library,runs:[run]}})
    const renderer=await render(<RunGovernance store={store} run={run}/>),text=JSON.stringify(renderer.toJSON())
    expect(text).toContain('此旧运行已暂停');expect(text).not.toContain('额度');expect(text).not.toContain('预算')
    const toolbar=await render(<RunToolbar store={store} working={false} onExecute={()=>{}} onAction={()=>{}}/>)
    expect(toolbar.root.findByProps({'aria-label':'停止'})).toBeDefined()
  })
})


it('shows legacy quota compatibility notices in run details without blocking recovery',async()=>{
  const {store,run}=fixture();run.graph.executionPolicy={maxAgentTasks:1,tokenBudget:1,perTaskTokens:1}
  const renderer=await render(<RunGovernance store={store} run={run}/>)
  const text=JSON.stringify(renderer.toJSON())
  for(const field of ['maxAgentTasks','tokenBudget','perTaskTokens'])expect(text).toContain(field)
  expect(text).toContain('已不生效');expect(button(renderer,'创建恢复运行').props.disabled).toBe(false)
})
