import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canDeferRunSecretCheck, fillRunEnvironment, missingRunEnvironment, prepareRunEnvironment, RunEnvironmentDialog } from '../src/client/run-environment.tsx'
import { archiveImpact } from '../src/client/archive-impact.tsx'
import { makeWorkflow, type Workflow, type WorkflowAPI } from '../src/shared/types.ts'
import { WorkflowStore } from '../src/client/store.ts'
import { localSecretBoundaryReport, nativeSecretBoundaryReport, unavailableSecretBoundaryReport } from '../src/shared/secret-boundary.ts'
import { osSecretStorageReport } from '../src/shared/os-secret-storage.ts'
vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Input:'input',Modal:({children,footer,...props}:any)=><modal-mock {...props}>{children}{footer}</modal-mock>,Tooltip:({children}:any)=>children,Menu:()=>null}))
const renderers:ReactTestRenderer[]=[],stores:WorkflowStore[]=[]
afterEach(()=>{for(const item of renderers.splice(0))act(()=>item.unmount());for(const store of stores.splice(0))store.dispose()})
function fixture(){const flow=makeWorkflow('workspace','配置补齐',true);flow.revision=1;flow.environmentVariables=[{id:'base',type:'string',name:'BASE',required:true},{id:'count',type:'number',name:'COUNT',required:true}];return flow}
describe('run environment preflight',()=>{
  it('accepts explicit empty string and numeric zero without changing existing values',()=>{
    const flow=fixture();flow.environmentVariables!.push({id:'existing',type:'string',name:'EXISTING',value:'keep'})
    const next=fillRunEnvironment(flow,{base:'',count:'0',existing:'replace'})
    expect(missingRunEnvironment(next)).toEqual([]);expect(next.environmentVariables).toMatchObject([{value:'',revision:1},{value:0,revision:1},{value:'keep'}]);expect(flow.environmentVariables![0]).not.toHaveProperty('value')
    expect(()=>fillRunEnvironment(flow,{count:'0'})).toThrow('请填写');expect(()=>fillRunEnvironment(flow,{base:'',count:''})).toThrow('有限数值');expect(()=>fillRunEnvironment(flow,{base:'',count:'Infinity'})).toThrow('有限数值')
  })
  it('does not turn a required Secret into a normal input',()=>{
    const flow=fixture();flow.environmentVariables!.push({id:'secret',type:'secret',name:'KEY',required:true})
    expect(()=>fillRunEnvironment(flow,{base:'',count:'1',secret:'never'})).toThrow('不能将原值加入普通变量')
  })
  it('defers only Secret presence checks while leaving the required declaration and raw-value ban intact',()=>{
    const flow=fixture();flow.environmentVariables!.push({id:'secret',type:'secret',name:'KEY',required:true})
    expect(missingRunEnvironment(flow).map(variable=>variable.id)).toEqual(['base','count','secret'])
    expect(missingRunEnvironment(flow,true).map(variable=>variable.id)).toEqual(['base','count'])
    const filled=fillRunEnvironment(flow,{base:'public',count:'0',secret:'must-not-be-saved'},true)
    expect(filled.environmentVariables!.find(variable=>variable.id==='secret')).toEqual({id:'secret',type:'secret',name:'KEY',required:true})
    expect(JSON.stringify(filled)).not.toContain('must-not-be-saved')
  })
  it('refreshes a required Secret probe before running and never trusts a graph field or legacy ready flag',async()=>{
    const flow=fixture();flow.environmentVariables=[{id:'secret',type:'secret',name:'KEY',required:true}]
    const legacy=unavailableSecretBoundaryReport({credentials:'local-file',sandbox:'file-policy-only',toolGuard:'present',broker:'missing'})
    const ready=nativeSecretBoundaryReport(legacy,{ok:true,available:true,code:'available'}),closed=nativeSecretBoundaryReport(legacy,{ok:true,available:false,code:'signing_untrusted'})
    const load=vi.fn(async()=>closed),store=new WorkflowStore({secretBoundary:load,openSecretManager:async()=>{}} as unknown as WorkflowAPI);stores.push(store)
    store.update({workflow:flow,sessionId:'session',secretBoundaryState:'ready',secretBoundaryReport:ready})
    expect(canDeferRunSecretCheck(store)).toBe(true)
    const checked=await prepareRunEnvironment(store,{workflowId:flow.id,sessionId:'session'})
    expect(load).toHaveBeenCalledOnce();expect(checked.deferSecretCheck).toBe(false);expect(checked.missing).toEqual(flow.environmentVariables)
    store.update({secretBoundaryState:'ready',secretBoundaryReport:{...legacy,available:true} as never})
    expect(canDeferRunSecretCheck(store)).toBe(false)
    const noManager=new WorkflowStore({secretBoundary:async()=>ready} as unknown as WorkflowAPI);stores.push(noManager);noManager.update({workflow:flow,secretBoundaryState:'ready',secretBoundaryReport:ready})
    expect(canDeferRunSecretCheck(noManager)).toBe(false)
  })
  it('accepts only a currently ready OS report and refreshes it before deferring the Secret check',async()=>{
    const flow=fixture();flow.environmentVariables=[{id:'secret',type:'secret',name:'KEY',required:true}]
    const ready=osSecretStorageReport('macos',{ok:true,available:true,code:'available'})
    const closed=osSecretStorageReport('macos',{ok:true,available:false,code:'keychain_failed'})
    const load=vi.fn(async()=>closed),start=vi.fn(),store=new WorkflowStore({secretBoundary:load,openSecretManager:async()=>{},start} as unknown as WorkflowAPI);stores.push(store)
    store.update({workflow:flow,sessionId:'session',secretBoundaryState:'ready',secretBoundaryReport:ready})
    expect(canDeferRunSecretCheck(store)).toBe(true)
    store.update({secretBoundaryState:'loading'});expect(canDeferRunSecretCheck(store)).toBe(false)
    store.update({secretBoundaryState:'ready'})
    const checked=await prepareRunEnvironment(store,{workflowId:flow.id,sessionId:'session'})
    expect(load).toHaveBeenCalledOnce();expect(checked.deferSecretCheck).toBe(false);expect(checked.missing).toEqual(flow.environmentVariables)
    expect(start).not.toHaveBeenCalled();expect(store.getSnapshot().workflow?.environmentVariables).toEqual(flow.environmentVariables)
    const noManager=new WorkflowStore({secretBoundary:async()=>ready} as unknown as WorkflowAPI);stores.push(noManager)
    noManager.update({workflow:flow,secretBoundaryState:'ready',secretBoundaryReport:ready});expect(canDeferRunSecretCheck(noManager)).toBe(false)
  })
  it('does not admit legacy components or inconsistent OS reports just because the UI state says ready',()=>{
    const legacy=unavailableSecretBoundaryReport({credentials:'local-file',sandbox:'file-policy-only',toolGuard:'present',broker:'unverified'})
    const components=localSecretBoundaryReport(legacy,{phase:'components-only',executor:'available',brokerPackage:'verified',globalEnforcement:false,processLifetime:'unverified'})
    const closed=osSecretStorageReport('macos',{ok:true,available:false,code:'broker_missing'})
    const store=new WorkflowStore({openSecretManager:async()=>{}} as unknown as WorkflowAPI);stores.push(store)
    for(const report of [legacy,components,{...components,available:true,status:'available'},{...closed,available:true,status:'available'}]){
      store.update({secretBoundaryState:'ready',secretBoundaryReport:report as never});expect(canDeferRunSecretCheck(store)).toBe(false)
    }
  })
  it('a ready OS component still leaves missing credential bindings to Host readiness and never starts a run',async()=>{
    const flow=fixture();flow.environmentVariables=[{id:'secret',type:'secret',name:'KEY',required:true}]
    const ready=osSecretStorageReport('macos',{ok:true,available:true,code:'available'}),start=vi.fn()
    const inspect=vi.fn(async(workflow:Workflow)=>({workflowId:workflow.id,revision:workflow.revision,canRun:false,issues:[{id:'missing-secret',kind:'secret',action:'environment',message:'KEY 尚未配置',variableId:'secret'}]}))
    const store=new WorkflowStore({secretBoundary:async()=>ready,openSecretManager:async()=>{},inspectReadiness:inspect,start,save:async(raw:string,revision:number)=>({...JSON.parse(raw),revision:revision+1})} as unknown as WorkflowAPI);stores.push(store)
    store.update({workflow:flow,sessionId:'session'})
    const checked=await prepareRunEnvironment(store,{workflowId:flow.id,sessionId:'session'})
    expect(checked.deferSecretCheck).toBe(true);expect(checked.missing).toEqual([])
    await expect(store.execute({},checked.intent)).rejects.toThrow('1 项待处理配置')
    expect(inspect).toHaveBeenCalledOnce();expect(start).not.toHaveBeenCalled();expect(store.getSnapshot().workflow?.environmentVariables).toEqual(flow.environmentVariables)
  })
  it.each(['session','workflow','configuration'])('rejects a changed %s while checking native readiness',async changed=>{
    const flow=fixture();flow.environmentVariables!.push({id:'secret',type:'secret',name:'KEY',required:true})
    let release!:(value:any)=>void,entered!:()=>void;const enteredPromise=new Promise<void>(resolve=>{entered=resolve}),response=new Promise<any>(resolve=>{release=resolve})
    const store=new WorkflowStore({secretBoundary:async()=>{entered();return response},openSecretManager:async()=>{}} as unknown as WorkflowAPI);stores.push(store);store.update({workflow:flow,sessionId:'session'})
    const pending=prepareRunEnvironment(store,{workflowId:flow.id,sessionId:'session'});await enteredPromise
    if(changed==='session')store.update({sessionId:'another'})
    else store.update({workflow:{...flow,...(changed==='workflow'?{id:'another'}:{title:'changed while checking'})}})
    release(nativeSecretBoundaryReport(unavailableSecretBoundaryReport({credentials:'missing',sandbox:'missing',toolGuard:'missing',broker:'missing'}),{ok:true,available:true,code:'available'}))
    await expect(pending).rejects.toThrow(/已变化/)
  })
  it.each(['native','os'] as const)('offers recheck and lets a ready %s broker handle required Secret checks after ordinary fields are filled',async backend=>{
    const flow=fixture();flow.environmentVariables!.push({id:'secret',type:'secret',name:'KEY',required:true})
    const legacy=unavailableSecretBoundaryReport({credentials:'missing',sandbox:'missing',toolGuard:'missing',broker:'missing'}),probe={ok:true,available:true,code:'available'} as const,ready=backend==='os'?osSecretStorageReport('macos',probe):nativeSecretBoundaryReport(legacy,probe)
    const save=vi.fn(async(raw:string,revision:number)=>({...JSON.parse(raw),revision:revision+1})),start=vi.fn(async()=>({id:'run',workflowId:flow.id,status:'success',executions:[]})),load=vi.fn(async()=>ready)
    const store=new WorkflowStore({inspectReadiness:async(workflow:Workflow)=>({workflowId:workflow.id,revision:workflow.revision,canRun:true,issues:[]}),save,start,secretBoundary:load,openSecretManager:async()=>{}} as unknown as WorkflowAPI);stores.push(store);store.update({workflow:flow,sessionId:'session',library:{workflows:[flow],runs:[],presets:[],workspaces:[]}})
    let ui!:ReactTestRenderer;act(()=>{ui=create(<RunEnvironmentDialog store={store} workflow={flow} sessionId="session" onClose={()=>{}} onStarted={()=>{}}/>)});renderers.push(ui)
    const proceed=()=>ui.root.findAllByType('button').find(button=>button.children.includes('保存并继续运行'))!
    expect(proceed().props.disabled).toBe(true)
    await act(async()=>ui.root.findAllByType('button').find(button=>button.children.includes('重新检查 Secret 可用性'))!.props.onClick())
    expect(proceed().props.disabled).toBe(false)
    expect(ui.root.findAllByProps({'aria-label':'运行配置 KEY'})).toHaveLength(0)
    act(()=>{ui.root.findByProps({'aria-label':'运行配置 BASE'}).props.onChange({target:{value:'public'}});ui.root.findByProps({'aria-label':'运行配置 COUNT'}).props.onChange({target:{value:'0'}})})
    await act(async()=>proceed().props.onClick())
    expect(load).toHaveBeenCalledTimes(2);expect(start).toHaveBeenCalledExactlyOnceWith(flow.id,'{}','session',expect.any(String))
    expect(JSON.parse(save.mock.calls[0]![0]).environmentVariables.at(-1)).toEqual({id:'secret',type:'secret',name:'KEY',required:true})
  })
  it('saves once and continues the original run intent only after ordinary values are complete',async()=>{
    const flow=fixture(),save=vi.fn(async(raw:string,revision:number)=>({...JSON.parse(raw),revision:revision+1})),start=vi.fn(async()=>({id:'run',workflowId:flow.id,status:'success',executions:[]}))
    const store=new WorkflowStore({inspectReadiness:async(workflow:Workflow)=>({workflowId:workflow.id,revision:workflow.revision,canRun:true,issues:[]}),save,start} as unknown as WorkflowAPI);stores.push(store);store.update({workflow:flow,sessionId:'session',library:{workflows:[flow],runs:[],presets:[],workspaces:[]}})
    const close=vi.fn(),started=vi.fn();let ui!:ReactTestRenderer
    act(()=>{ui=create(<RunEnvironmentDialog store={store} workflow={flow} sessionId="session" onClose={close} onStarted={started}/>)});renderers.push(ui)
    expect(start).not.toHaveBeenCalled()
    act(()=>{ui.root.findByProps({'aria-label':'运行配置 BASE'}).props.onChange({target:{value:'ok'}});ui.root.findByProps({'aria-label':'运行配置 COUNT'}).props.onChange({target:{value:'2'}})})
    const button=ui.root.findAllByType('button').find(item=>item.children.includes('保存并继续运行'))!
    await act(async()=>{button.props.onClick();button.props.onClick();await Promise.resolve();await Promise.resolve()})
    expect(save).toHaveBeenCalledOnce();expect(start).toHaveBeenCalledExactlyOnceWith(flow.id,'{}','session',expect.any(String));expect(started).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce()
  })
  it('rejects a stale flow or changed conversation instead of running another context',async()=>{
    const flow=fixture(),start=vi.fn(),save=vi.fn(),store=new WorkflowStore({inspectReadiness:async(workflow:Workflow)=>({workflowId:workflow.id,revision:workflow.revision,canRun:true,issues:[]}),save,start} as unknown as WorkflowAPI);stores.push(store);store.update({workflow:flow,sessionId:'changed'})
    let ui!:ReactTestRenderer;act(()=>{ui=create(<RunEnvironmentDialog store={store} workflow={flow} sessionId="original" onClose={()=>{}} onStarted={()=>{}}/>)});renderers.push(ui)
    await act(async()=>ui.root.findAllByType('button').find(item=>item.children.includes('保存并继续运行'))!.props.onClick())
    expect(save).not.toHaveBeenCalled();expect(start).not.toHaveBeenCalled();expect(JSON.stringify(ui.toJSON())).toContain('流程或对话已变化')
  })
})
it('archive preview finds nested callers and distinguishes retained history from active runs',()=>{
  const flow=fixture(),caller=makeWorkflow('workspace','调用者');caller.nodes[0]!.config.body={nodes:[{...caller.nodes[0]!,id:'nested',config:{tools:[`workflow:${flow.id}`]},kind:'agent'}],edges:[]}
  const runs=[{id:'done',workflowId:flow.id,status:'success'},{id:'paused',workflowId:flow.id,status:'paused'}] as any
  const impact=archiveImpact(flow,{workflows:[flow,caller],runs,presets:[],workspaces:[]})
  expect(impact.references.map(item=>item.id)).toEqual([caller.id]);expect(impact.runs).toHaveLength(2);expect(impact.active.map(item=>item.id)).toEqual(['paused'])
})
