import { annotationEditorStyles } from './annotation-editor.tsx'
import { hostQuestionStyles } from './host-question-style.ts'
import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import remoteContribution from 'dsh-visible-dynamic-workflows/remote'
import type { WorkflowAPI } from '../shared/types.ts'
import type { WorkflowStore } from './store.ts'
import { WorkflowViews, workflowEntrySession } from './navigation.ts'
import { bindWorkflowSidebarEntry, setWorkflowSidebarFullscreen } from './sidebar-presentation.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { WorkflowApp, type WorkflowNavigation } from './app.tsx'
import { createChatBridge } from './chat-bridge.tsx'
import { WorkflowIcon } from './icons.tsx'
import { styles } from './styles.ts'
import { WorkflowSettingsSection } from './forms.tsx'
import { installWorkflowMotion } from './workflow-motion.ts'
import { bindPlanningUi, PlanningCanvasVisibility, type PlanningUiCursor } from './planning-ui.ts'

const ID='dsh-visible-dynamic-workflows',KIND='visible-workflows'
// A native sidebar can remount when changing presentation. Publication receipts
// already shown in this renderer must not be replayed by a fresh component.
const planningCursors=new Map<string,PlanningUiCursor>()
const unwrap=<T,>(result:RemoteResult<T>):T=>{if(!result.ok)throw new Error(result.error.message);return result.value}
const json=<T,>(result:RemoteResult<string>):T=>JSON.parse(unwrap(result)) as T
export const inject=['slots','layout','sidebarRightTabs','sidebarRight','remote','sessions','uiSession','conversation','inputTriggers','workspaces','uiWorkspace']
export function apply(ctx:Context):void{
  ctx.effect(()=>ctx.remote.$mount(remoteContribution),'visible-workflows:remote')
  ctx.inject(['remote.visibleWorkflows'],scope=>{
    let stage='remote scope'
    try {
    const remote=scope.remote.visibleWorkflows
    const api:WorkflowAPI={
      inspectReadiness:async(workflow,session='')=>json(await remote.inspectReadiness(JSON.stringify(workflow),session)),
      exportArchive:async(workflow,includeValues=false,session='')=>unwrap(await remote.exportArchive(JSON.stringify(workflow),includeValues,session)),
      previewArchive:async(base64,workspace,options={},session='')=>json(await remote.previewArchive(base64,workspace,JSON.stringify(options),session)),
      importArchive:async(base64,workspace,options={},session='')=>json(await remote.importArchive(base64,workspace,JSON.stringify(options),session)),
      openSecretManager:async(workflowId,variableId,sessionId='')=>{unwrap(await remote.openSecretManager(workflowId,variableId,sessionId))},
      secretBoundary:async()=>json(await remote.secretBoundary()),
      tools:async(workspaceId='',sessionId='')=>json(await remote.tools(workspaceId,sessionId)),importSwagger:async(id,raw)=>json(await remote.importSwagger(id,raw)),
      list:async id=>json(await remote.list(id)),get:async id=>json(await remote.get(id)),
      save:async(raw,revision)=>json(await remote.save(raw,revision)),remove:async(id,revision)=>{unwrap(await remote.deleteWorkflow(id,revision))},
      httpCacheSettings:async()=>json(await remote.httpCacheSettings()),saveHttpCacheSettings:async raw=>json(await remote.saveHttpCacheSettings(raw)),
      presets:async()=>json(await remote.presets()),savePreset:async raw=>json(await remote.savePreset(raw)),deletePreset:async id=>json(await remote.deletePreset(id)),
      models:async()=>json(await remote.models()),start:async(id,inputs,sessionId='',requestId)=>json(await remote.start(id,inputs,sessionId,requestId)),answer:async(id,inputs)=>json(await remote.answer(id,inputs)),
      run:async id=>json(await remote.run(id)),cancel:async id=>json(await remote.cancel(id)),
      stopNode:async(runId,executionId)=>json(await remote.stopNode(runId,executionId)),
      pause:async id=>json(await remote.pause(id)),resume:async id=>json(await remote.resume(id)),
      recoveryPlan:async(id,review)=>json(await remote.recoveryPlan(id,review?JSON.stringify(review):'')),
      agentProcess:async(runId,executionId)=>json(await remote.agentProcess(runId,executionId)),
      followupAgent:async(runId,executionId,prompt,messageId)=>json(await remote.followupAgent(runId,executionId,prompt,messageId)),
      acceptRepairOutput:async(runId,executionId,output)=>json(await remote.acceptRepairOutput(runId,executionId,JSON.stringify(output))),
      confirmRepairOutput:async(runId,executionId,attempts)=>json(await remote.confirmRepairOutput(runId,executionId,attempts)),
      previewRunRevision:async(runId,workflow,session='')=>json(await remote.previewRunRevision(runId,JSON.stringify(workflow),session)),
      applyRunRevision:async(runId,workflow,planDigest,session='')=>json(await remote.applyRunRevision(runId,JSON.stringify(workflow),planDigest,session)),
      recover:async(id,session='',planDigest='',review,requestId)=>json(await remote.recover(id,session,planDigest,review?JSON.stringify(review):'',requestId)),rerun:async(id,session='',requestId)=>json(await remote.rerun(id,session,requestId)),
      importPackage:async(raw,workspace,options={},session='')=>json(await remote.importPackage(raw,workspace,JSON.stringify(options),session)),
      previewImport:async(raw,workspace,options={},session='')=>json(await remote.previewImport(raw,workspace,JSON.stringify(options),session)),
      proposals:async id=>json(await remote.proposals(id)),propose:async(raw,revision)=>json(await remote.propose(raw,revision)),resolveProposal:async(id,decision,revision)=>json(await remote.resolveProposal(id,decision,revision)),
      drafts:async(id,session='')=>json(await remote.drafts(id,session)),saveDraft:async(raw,revision)=>json(await remote.saveDraft(raw,revision)),removeDraft:async(id,revision)=>{unwrap(await remote.removeDraft(id,revision))},
      archivedTemplates:async()=>json(await remote.archivedTemplates()),restoreTemplate:async(id,revision)=>json(await remote.restoreTemplate(id,revision)),
      templates:async()=>json(await remote.templates()),saveTemplate:async(id,title,selection)=>json(await remote.saveTemplate(id,title,selection===undefined?undefined:JSON.stringify(selection))),renameTemplate:async(id,title,revision)=>json(await remote.renameTemplate(id,title,revision)),removeTemplate:async(id,revision)=>{unwrap(await remote.removeTemplate(id,revision))},useTemplate:async(id,workspace)=>json(await remote.useTemplate(id,workspace)),
      archived:async workspace=>{const all=await remote.archived();const values=json<import('../shared/types.ts').Workflow[]>(all);return workspace?values.filter(value=>value.workspaceId===workspace):values},restore:async id=>json(await remote.restore(id)),
    }
    const views=new WorkflowViews(api)
    const canvasVisibility=new Map<string,PlanningCanvasVisibility>()
    const visibilityFor=(sessionId:string)=>{let value=canvasVisibility.get(sessionId);if(!value){value=new PlanningCanvasVisibility();canvasVisibility.set(sessionId,value)}return value}
    const store=views.getSnapshot().store
    let openNativeSettings:(()=>void)|undefined
    function NativeSettingsNavigation({open}:{open?:()=>void}){
      useEffect(()=>{openNativeSettings=open;return()=>{if(openNativeSettings===open)openNativeSettings=undefined}},[open])
      return null
    }
    // Reuse the shell-owned store instance, as the official sidebar.settings renderer does.
    // Binding through a root slot gives us its actions without creating stores or changing shell DOM.
    scope.effect(()=>scope.slots.inject('settings.section',()=>scope.slots.inject('shell.overlay',()=>{
      const ledger:Pick<SlotCore,'entriesOfSlot'>=scope.slots
      const handle=ledger.entriesOfSlot('sidebar.settings')[0]?.store
      if(!handle||typeof handle==='function'||typeof handle.spec?.actions?.openSection!=='function')return()=>{}
      const dispose=scope.slots.register({name:'shell.overlay',id:`${ID}.settings-navigation`,store:handle,inject:actions=>({open:typeof actions.openSection==='function'?()=>actions.openSection(KIND):undefined})},NativeSettingsNavigation)
      return()=>{openNativeSettings=undefined;dispose()}
    })))
    const openSettings=()=>{if(openNativeSettings)openNativeSettings();else store.update({error:'原生设置尚未就绪，请从 Harness 设置打开“工作流”。'})}
    const sessions=(workspaceId:string)=>{
      const catalog=scope.sessions.list.getSnapshot(),workspaces=scope.workspaces.list.getSnapshot()
      const workspace=workspaces.items.find(w=>w.workspaceId===workspaceId)
      return (workspace?.sessionIds||[]).filter(id=>!workspaces.archivedSessionIds.includes(id)&&catalog.byId[id]&&!catalog.byId[id]!.parentId)
        .map(id=>({id,title:catalog.byId[id]!.blank?'新会话':catalog.byId[id]!.displayTitle}))
    }
    const showConversation=async(sessionId:string)=>{
      scope.uiWorkspace.openSession(sessionId as SessionId)
      // Wait for the exact target's host-owned sidebar store, never a last-session fallback.
      await new Promise<void>((resolve,reject)=>{
        const started=Date.now()
        const ready=()=>{
          if(scope.sidebarRight.mounted.getSnapshot()===sessionId){
            requestAnimationFrame(()=>{if(scope.sidebarRight.mounted.getSnapshot()!==sessionId){reject(new Error('对话已切换，请重新打开工作流。'));return}scope.sidebarRight.openTab(KIND);resolve()});return
          }
          if(Date.now()-started>4000){reject(new Error('目标对话尚未就绪，请重试。'));return}
          setTimeout(ready,30)
        };ready()
      })
    }
    let entryRequest=0
    const openManagement=async()=>{
      const request=++entryRequest
      const sessionId=await workflowEntrySession({selectedSession:()=>scope.uiSession.adapter.current.getSnapshot().key,isBlankSession:id=>!!scope.sessions.list.getSnapshot().byId[id as SessionId]?.blank,startSession:()=>scope.uiWorkspace.startSession()},()=>request===entryRequest)
      if(request!==entryRequest||!sessionId)return
      views.management(sessionId)
      await showConversation(sessionId)
    }
    const navigationFor=(viewStore:WorkflowStore,fullscreen=false):WorkflowNavigation=>({
      getSessionId:()=>{const id=views.associatedSession(viewStore),flow=viewStore.getSnapshot().workflow;return id&&(!flow||flow.scope==='global'||sessions(flow.workspaceId).some(s=>s.id===id))?id:undefined},
      toFull:()=>{viewStore.captureViewport();const id=viewStore.getSnapshot().sessionId;if(id)setWorkflowSidebarFullscreen(scope.sidebarRight,id,fullscreen,true)},
      toSide:()=>{viewStore.captureViewport();const id=viewStore.getSnapshot().sessionId;if(id)setWorkflowSidebarFullscreen(scope.sidebarRight,id,fullscreen,false)},
      openChat:async sessionId=>{await views.attach(viewStore,sessionId);await showConversation(sessionId)},
      openSettings,sessions,
      createSession:async workspaceId=>scope.sessions.create({workspaceId:workspaceId as WorkspaceId}),
    })
    stage='chat bridge'
    const chat=createChatBridge(scope,{listWorkflows:async()=>{const library=await api.list('');store.update({library});return library.workflows},getWorkflow:id=>api.get(id),openWorkflow:(id,sessionId,reason)=>{
      if(reason==='generated'){void views.generated(id,sessionId).catch(e=>views.session(sessionId).update({error:String(e)}));return}
      const target=views.session(sessionId),signal=scope.layout.beginNavigation()
      void target.open(id).then(()=>{if(!signal.aborted)return showConversation(sessionId)}).catch(e=>target.update({error:String(e)}))
    }})
    stage='styles and slot registration'
    scope.effect(()=>{
      const style=document.createElement('style');style.dataset.plugin=ID;style.textContent=styles+annotationEditorStyles+hostQuestionStyles;document.head.append(style)
      const stopMotion=installWorkflowMotion(document)
      return()=>{++entryRequest;stopMotion();style.remove();chat.dispose();views.dispose()}
    })
    function Settings(){return <WorkflowSettingsSection store={store}/>}
    scope.effect(()=>scope.slots.inject('settings.section',()=>scope.slots.register({name:'settings.section',id:KIND,order:45,label:'工作流'},Settings)))
    // Compatibility for a click before the row's capture binding mounts, or an
    // external request for the registered panel id. No editor lives in main.
    function Main(){
      useLayoutEffect(()=>{void openManagement().catch(e=>store.update({error:String(e)}))},[])
      return null
    }
    function Sidebar({sessionId,useTabInfo}:PropsRuntime<'sidebar.right.pane.tab'>){
      useSyncExternalStore(views.subscribe,views.getSnapshot,views.getSnapshot)
      const viewStore=views.session(sessionId),info=useTabInfo()
      useLayoutEffect(()=>info.tab.visible?visibilityFor(sessionId).mount():undefined,[sessionId,info.tab.visible])
      return <div style={{height:'100%',minHeight:0}}><WorkflowApp store={viewStore} mode="side" navigation={navigationFor(viewStore,info.sidebar.fullscreen)} chat={chat}/></div>
    }
    function PlanningSync({sessionId}:PropsRuntime<'conversation.input.dock'>){
      useSyncExternalStore(views.subscribe,views.getSnapshot,views.getSnapshot)
      const viewStore=views.session(sessionId)
      useEffect(()=>{
        let cursor=planningCursors.get(sessionId)
        if(!cursor){cursor={cursor:0};planningCursors.set(sessionId,cursor)}
        return bindPlanningUi({sessionId,store:viewStore,cursor,canvasVisibility:visibilityFor(sessionId),api:{
          eventDrivenUpdates:true,
          setPlanningContext:async(id,context)=>{unwrap(await remote.setPlanningContext(id,JSON.stringify(context)))},
          planningUpdates:async(id,afterSequence,epoch)=>json(await remote.planningUpdates(id,afterSequence,epoch??'',20_000)),
        },workspaceId:()=>{
          const matches=scope.workspaces.list.getSnapshot().items.filter(item=>item.sessionIds.includes(sessionId))
          return matches.length===1?matches[0]!.workspaceId:undefined
        },onCreated:(id,session)=>views.generated(id,session),onError:error=>viewStore.update({error}),onRecover:message=>{if(viewStore.getSnapshot().error===message)viewStore.update({error:''})}})
      },[viewStore,sessionId])
      // Keep the resident event consumer without adding content above chat.
      // Published changes use the existing proposal notice and review dialog.
      return null
    }
    function Header({sessionId}:PropsRuntime<'conversation.session.header.utilities'>){
      const state=useSyncExternalStore(views.session(sessionId).subscribe,views.session(sessionId).getSnapshot,views.session(sessionId).getSnapshot)
      return <Tooltip label={state.pendingWorkflow?'工作流已就绪，点击查看':'打开工作流'} side="bottom" portal><Button size="sm" aria-label={state.pendingWorkflow?'查看已生成工作流':'打开工作流'} onClick={()=>{const viewStore=views.session(sessionId);if(state.pendingWorkflow)void viewStore.open(state.pendingWorkflow.id).then(()=>{viewStore.update({pendingWorkflow:undefined});scope.sidebarRight.openTab(KIND)});else scope.sidebarRight.openTab(KIND)}}><WorkflowIcon size={16}/>{state.pendingWorkflow&&<span className="vdw-ready-dot"/>}</Button></Tooltip>
    }
    function PanelIcon({size}:PropsRuntime<'sidebar.panellist'>){
      const ref=useRef<HTMLSpanElement>(null)
      useLayoutEffect(()=>{
        const icon=ref.current
        if(!icon)return
        return bindWorkflowSidebarEntry(icon,()=>{void openManagement().catch(e=>store.update({error:String(e)}))})
      },[])
      return <span ref={ref} style={{display:'contents'}}><WorkflowIcon size={size}/></span>
    }
    scope.effect(()=>scope.slots.inject('main',()=>scope.slots.register({name:'main',key:ID},Main)))
    scope.effect(()=>scope.slots.inject('sidebar.panellist',()=>scope.slots.register({name:'sidebar.panellist',id:ID,order:35,label:'工作流'},PanelIcon)))
    scope.effect(()=>scope.sidebarRightTabs.register({id:ID,kind:KIND,title:()=> '工作流',guide:[{id:ID,order:26,title:()=> '工作流',description:()=> '创建、编辑和运行工作流',icon:()=> <WorkflowIcon/>}]}))
    scope.effect(()=>scope.slots.inject('sidebar.right.pane.tab',()=>scope.slots.register({name:'sidebar.right.pane.tab',key:ID},Sidebar)))
    scope.effect(()=>scope.slots.inject('conversation.session.header.utilities',()=>scope.slots.register({name:'conversation.session.header.utilities',id:ID,order:-19},Header)))
    scope.effect(()=>scope.slots.inject('conversation.input.dock',()=>scope.slots.register({name:'conversation.input.dock',id:`${ID}.planning-sync`,order:20},PlanningSync)))
    } catch(error) {
      console.error(`[visible-workflows] failed at ${stage}`,error)
      throw error
    }
  })
}
