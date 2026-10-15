import { annotationEditorStyles } from './annotation-editor.tsx'
import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
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
import { WorkflowViews } from './navigation.ts'
import { adaptWorkflowFullscreen, type WorkflowSidebarPresentation } from './sidebar-presentation.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { WorkflowApp, type WorkflowNavigation } from './app.tsx'
import { createChatBridge } from './chat-bridge.tsx'
import { WorkflowIcon } from './icons.tsx'
import { styles } from './styles.ts'
import { WorkflowSettingsSection } from './forms.tsx'

const ID='dsh-visible-dynamic-workflows',KIND='visible-workflows'
const unwrap=<T,>(result:RemoteResult<T>):T=>{if(!result.ok)throw new Error(result.error.message);return result.value}
const json=<T,>(result:RemoteResult<string>):T=>JSON.parse(unwrap(result)) as T
export const inject=['slots','layout','sidebarRightTabs','sidebarRight','remote','sessions','conversation','inputTriggers','workspaces','uiWorkspace']
export function apply(ctx:Context):void{
  ctx.effect(()=>ctx.remote.$mount(remoteContribution),'visible-workflows:remote')
  ctx.inject(['remote.visibleWorkflows'],scope=>{
    let stage='remote scope'
    try {
    const remote=scope.remote.visibleWorkflows
    const api:WorkflowAPI={
      tools:async(workspaceId='',sessionId='')=>json(await remote.tools(workspaceId,sessionId)),importSwagger:async(id,raw)=>json(await remote.importSwagger(id,raw)),
      list:async id=>json(await remote.list(id)),get:async id=>json(await remote.get(id)),
      save:async(raw,revision)=>json(await remote.save(raw,revision)),remove:async(id,revision)=>{unwrap(await remote.deleteWorkflow(id,revision))},
      presets:async()=>json(await remote.presets()),savePreset:async raw=>json(await remote.savePreset(raw)),deletePreset:async id=>json(await remote.deletePreset(id)),
      models:async()=>json(await remote.models()),start:async(id,inputs,sessionId='')=>json(await remote.start(id,inputs,sessionId)),answer:async(id,inputs)=>json(await remote.answer(id,inputs)),
      run:async id=>json(await remote.run(id)),cancel:async id=>json(await remote.cancel(id)),
    }
    const views=new WorkflowViews(api)
    const store=views.getSnapshot().store
    let expanding=false
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
    const navigationFor=(viewStore:WorkflowStore,originSessionId?:string):WorkflowNavigation=>({
      getSessionId:()=>{const id=views.associatedSession(viewStore),flow=viewStore.getSnapshot().workflow;return id&&(!flow||sessions(flow.workspaceId).some(s=>s.id===id))?id:undefined},
      returnToConversation:!!originSessionId,
      toFull:()=>{const id=viewStore.getSnapshot().sessionId;if(id){views.expand(id);expanding=true;scope.layout.selectPanel(ID as MainPanelId)}},
      toSide:()=>{viewStore.captureViewport();const id=originSessionId||viewStore.getSnapshot().sessionId;if(id)void showConversation(id).catch(e=>viewStore.update({error:String(e)}))},
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
      const style=document.createElement('style');style.dataset.plugin=ID;style.textContent=styles+annotationEditorStyles;document.head.append(style)
      let previousPanel=scope.layout.panelInfo.getSnapshot().activePanelId
      const unsubscribe=scope.layout.panelInfo.subscribe(()=>{const next=scope.layout.panelInfo.getSnapshot().activePanelId;if(next===previousPanel)return;previousPanel=next;if(next===ID){if(expanding)expanding=false;else views.management()}})
      return()=>{style.remove();unsubscribe();chat.dispose();views.dispose()}
    })
    function Settings(){return <WorkflowSettingsSection store={store}/>}
    scope.effect(()=>scope.slots.inject('settings.section',()=>scope.slots.register({name:'settings.section',id:KIND,order:45,label:'工作流'},Settings)))
    function Main(){const view=useSyncExternalStore(views.subscribe,views.getSnapshot,views.getSnapshot);return <WorkflowApp key={view.originSessionId||'manager'} store={view.store} mode="full" navigation={navigationFor(view.store,view.originSessionId)} chat={chat}/>}
    function Sidebar({sessionId,useTabInfo}:PropsRuntime<'sidebar.right.pane.tab'>){
      useSyncExternalStore(views.subscribe,views.getSnapshot,views.getSnapshot)
      const viewStore=views.session(sessionId),info=useTabInfo()
      const previous=useRef<WorkflowSidebarPresentation>()
      useLayoutEffect(()=>{
        const current={sessionId,tabId:info.tab.id,visible:info.tab.visible,fullscreen:info.sidebar.fullscreen,width:window.innerWidth}
        const before=previous.current;previous.current=current
        if(info.tab.signal.aborted)return
        adaptWorkflowFullscreen(before,current,scope.sidebarRight,()=>{
          views.expand(sessionId);expanding=true;scope.layout.selectPanel(ID as MainPanelId)
        })
      })
      return <div style={{height:'100%',minHeight:0}}><WorkflowApp store={viewStore} mode="side" navigation={navigationFor(viewStore)} chat={chat}/></div>
    }
    function Header({sessionId}:PropsRuntime<'conversation.session.header.utilities'>){
      const state=useSyncExternalStore(views.session(sessionId).subscribe,views.session(sessionId).getSnapshot,views.session(sessionId).getSnapshot)
      return <Tooltip label={state.pendingWorkflow?'工作流已就绪，点击查看':'打开工作流'} side="bottom" portal><Button size="sm" aria-label={state.pendingWorkflow?'查看已生成工作流':'打开工作流'} onClick={()=>{const viewStore=views.session(sessionId);if(state.pendingWorkflow)void viewStore.open(state.pendingWorkflow.id).then(()=>{viewStore.update({pendingWorkflow:undefined});scope.sidebarRight.openTab(KIND)});else scope.sidebarRight.openTab(KIND)}}><WorkflowIcon size={16}/>{state.pendingWorkflow&&<span className="vdw-ready-dot"/>}</Button></Tooltip>
    }
    function PanelIcon({size}:PropsRuntime<'sidebar.panellist'>){
      const ref=useRef<HTMLSpanElement>(null)
      useEffect(()=>{
        // The host owns this row/button. Observe its explicit activation so a
        // repeated click on the already-selected panel still returns home.
        const button=ref.current?.closest('button')
        const activate=()=>views.management()
        button?.addEventListener('click',activate)
        return()=>button?.removeEventListener('click',activate)
      },[])
      return <span ref={ref} style={{display:'contents'}}><WorkflowIcon size={size}/></span>
    }
    scope.effect(()=>scope.slots.inject('main',()=>scope.slots.register({name:'main',key:ID},Main)))
    scope.effect(()=>scope.slots.inject('sidebar.panellist',()=>scope.slots.register({name:'sidebar.panellist',id:ID,order:35,label:'工作流'},PanelIcon)))
    scope.effect(()=>scope.sidebarRightTabs.register({id:ID,kind:KIND,title:()=> '工作流',guide:[{id:ID,order:26,title:()=> '工作流',description:()=> '创建、编辑和运行工作流',icon:()=> <WorkflowIcon/>}]}))
    scope.effect(()=>scope.slots.inject('sidebar.right.pane.tab',()=>scope.slots.register({name:'sidebar.right.pane.tab',key:ID},Sidebar)))
    scope.effect(()=>scope.slots.inject('conversation.session.header.utilities',()=>scope.slots.register({name:'conversation.session.header.utilities',id:ID,order:-19},Header)))
    } catch(error) {
      console.error(`[visible-workflows] failed at ${stage}`,error)
      throw error
    }
  })
}
