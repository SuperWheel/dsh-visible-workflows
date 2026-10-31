import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Input, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { makeWorkflow, type Workflow, type WorkflowRun } from '../shared/types.ts'
import { AnnotationEditor } from './annotation-editor.tsx'
import { enumerateAnnotationNodes, resolveAnnotationNodes } from './annotation-nodes.ts'
import type { AnnotationPosition } from './annotation-position.ts'
import { Canvas, type CanvasAnnotation } from './canvas.tsx'
import { allNodes, graphAt, replaceGraph } from './nodes.ts'
import { RunQuestion, questionKey } from './run-question.tsx'
import { Field, NodePanel, Select } from './forms.tsx'
import { Glyph, WorkflowIcon } from './icons.tsx'
import { ExecutionDetails, ExecutionSummary, RunOutputs, StatusBadge, runStatusLabel } from './execution-details.tsx'
import { orderedExecutions } from './execution-order.ts'
import { useWorkflowStore, ACTIVE_RUN_STATUSES, type WorkflowStore } from './store.ts'
import { EditorHeading } from './editor-heading.tsx'
import { WorkflowLeaveDialog } from './workflow-leave-dialog.tsx'
import { WorkflowRequestDialog } from './workflow-request-dialog.tsx'
import { HomeWorkflowManagementDialog } from './home-workflow-management-dialog.tsx'
import type { WorkflowRequestSnapshot } from './chat-bridge.tsx'
import { workflowVisibleInWorkspace } from '../shared/workflow-scope.ts'
import { AdvancedSettingsPanel, type AdvancedSettingsTab } from './advanced-settings.tsx'
import { exportWorkflowJson } from '../shared/workflow-format.ts'
import { WorkflowTransfer } from './workflow-transfer.tsx'
import { canvasAnnotations, withoutPortableAnnotation } from './portable-annotations.ts'
import { RunGovernance, RunToolbar } from './run-governance.tsx'
import { AgentExecutionActions } from './agent-execution-actions.tsx'
import { ProposalReview } from './proposal-review.tsx'
import { WorkflowArchive } from './workflow-archive.tsx'
import { WorkflowLibraryPanel } from './workflow-library-panel.tsx'
import { WorkflowHomeCard } from './workflow-home-card.tsx'
import { copyWorkflowCard } from './workflow-home-copy.ts'
import { useLocale } from './i18n.ts'
import { prepareRunEnvironment, RunEnvironmentDialog } from './run-environment.tsx'
import { ArchiveImpact, archiveImpact } from './archive-impact.tsx'
import { WorkflowReadinessNotice, nodeScopePath } from './workflow-readiness.tsx'
import { ProposalNotice } from './proposal-notice.tsx'
import type { WorkflowReadinessIssue } from '../shared/workflow-import.ts'

export interface WorkflowNavigation {
  toFull:()=>void;toSide:()=>void;openChat:(sessionId:string)=>Promise<void>|void;openSettings:()=>void;getSessionId:()=>string|undefined
  returnToConversation?:boolean
  sessions?:(workspaceId:string)=>{id:string;title:string}[]
  createSession?:(workspaceId:string)=>Promise<string>
}
export interface AnnotationBridge {
  stageAnnotation(sessionId:string,workflow:Workflow,nodeIds:string[],text:string,annotationId?:string,position?:AnnotationPosition):Promise<unknown>
  deleteAnnotation(sessionId:string,id:string):Promise<void>
  insertGenerateRequest(sessionId:string,text:string,workflow?:Pick<Workflow,'id'|'workspaceId'|'title'|'scope'>):Promise<boolean>
  getGenerateRequest?(sessionId:string,targetWorkflowId?:string):WorkflowRequestSnapshot|undefined
  insertWorkflow(sessionId:string,workflow:Workflow):Promise<unknown>
  getAnnotations(workflowId:string,sessionId?:string):readonly CanvasAnnotation[]
  subscribe(fn:()=>void):()=>void
}
export interface WorkflowAppProps {store:WorkflowStore;mode:'full'|'side';navigation:WorkflowNavigation;chat?:AnnotationBridge}
const statusLabel = runStatusLabel
export function WorkflowApp({store,mode,navigation,chat}:WorkflowAppProps){
  const {t}=useLocale()
  const state=useWorkflowStore(store),flow=state.workflow,sessionId=navigation.getSessionId()
  const search=state.search||'',setSearch=(search:string)=>store.update({search}),workspace=state.workspaceFilter&&state.library.workspaces.some(item=>item.id===state.workspaceFilter)?state.workspaceFilter:'all',setWorkspace=(workspaceFilter:string)=>store.update({workspaceFilter}),filter=state.statusFilter||'all',setFilter=(statusFilter:string)=>store.update({statusFilter})
  const configId=state.configId||'',setConfigId=(configId:string)=>store.update({configId,...(configId?{variablePanel:undefined,logs:false}:{})}),logs=state.logs||false,setLogs=(logs:boolean)=>store.update({logs,...(logs?{variablePanel:undefined,configId:''}:{})})
  const [advancedTab,setAdvancedTab]=useState<AdvancedSettingsTab>()
  const [saveAsTitle,setSaveAsTitle]=useState<string>()
  const [leaveWorkflowId,setLeaveWorkflowId]=useState<string>(),[leaveError,setLeaveError]=useState('')
  const [libraryTab,setLibraryTab]=useState<'templates'|'import'>()
  const [cardExport,setCardExport]=useState<Workflow>()
  const [managedWorkflow,setManagedWorkflow]=useState<Workflow>()
  const [templateSelection,setTemplateSelection]=useState<{title:string;nodeIds:string[];scopePath:string[]}>()
  const [templateFeedback,setTemplateFeedback]=useState('')
  useEffect(()=>{if(state.variablePanel){setAdvancedTab(state.variablePanel);store.update({variablePanel:undefined})}},[state.variablePanel])
  useEffect(()=>{setAdvancedTab(undefined);setLibraryTab(undefined);setTemplateSelection(undefined);setLeaveWorkflowId(undefined);setLeaveError('')},[flow?.id])
  const [questionDismissed,setQuestionDismissed]=useState('')
  const [pendingRun,setPendingRun]=useState<{workflow:Workflow;sessionId?:string}>()
  const [sessionChoice,setSessionChoice]=useState<{workspaceId:string;resolve:(id:string|undefined)=>void}>(),[chosenSession,setChosenSession]=useState('new')
  const ensureSession=async(workspaceId:string)=>{
    const id=navigation.getSessionId(),sessions=navigation.sessions?.(workspaceId)||[]
    if(id&&(sessions.some(s=>s.id===id)||flow?.scope==='global'))return id
    setChosenSession('new')
    const chosen=await new Promise<string|undefined>(resolve=>setSessionChoice({workspaceId,resolve}))
    if(!chosen)throw new Error('已取消选择对话，需求仍保留。')
    return chosen
  }
  const [transfer,setTransfer]=useState<'import'|'export'>(),[review,setReview]=useState(false),[archive,setArchive]=useState(false)
  const libraryBody=useRef<HTMLDivElement>(null),[libraryScrolled,setLibraryScrolled]=useState(false)
  useEffect(()=>{setLibraryScrolled((libraryBody.current?.scrollTop??0)>0)},[state.page,flow?.id])
  const [create,setCreate]=useState<{title:string;workspace:string;sample:boolean}>(),[deleting,setDeleting]=useState<Workflow>()
  const annotation=state.annotationDraft,setAnnotation=(annotationDraft:typeof annotation)=>store.update({annotationDraft})
  const root=useRef<HTMLDivElement>(null)
  const [annotationHidden,setAnnotationHidden]=useState(false),[generateHidden,setGenerateHidden]=useState(true)
  const [annotationAnchor,setAnnotationAnchor]=useState<Pick<DOMRect,'left'|'right'|'top'|'bottom'>>()
  const beginAnnotation=(draft:NonNullable<typeof annotation>,anchor?:Pick<DOMRect,'left'|'right'|'top'|'bottom'>)=>{
    setAnnotationHidden(false)
    const pin=draft.id?Array.from(root.current?.querySelectorAll<HTMLButtonElement>('.vdw-annotation-pin')||[]).find(element=>element.getAttribute('data-annotation-id')===draft.id):undefined
    const element=pin||root.current?.querySelector('.vdw-node.is-selected')||root.current?.querySelector('.vdw-selection-actions')
    const rect=element?.getBoundingClientRect()
    setAnnotationAnchor(anchor??(rect?{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom}:undefined))
    setAnnotation(draft)
  }
  const generate=state.generateDraft,setGenerate=(generateDraft:typeof generate)=>store.update({generateDraft})
  const scopePath=state.scopePath,setScopePath=(scopePath:string[])=>store.update({scopePath})
  useEffect(()=>{if(!flow)return;let graph=flow;const valid:string[]=[];for(const id of scopePath){const n=graph.nodes.find(n=>n.id===id);if(!n?.config.body)break;valid.push(id);graph={...flow,...n.config.body}}if(valid.length!==scopePath.length){setScopePath(valid);setConfigId('');store.update({selected:[]})}},[flow,scopePath])
  const [working,setWorking]=useState(false),[localError,setLocalError]=useState(''),[questionInputs,setQuestionInputs]=useState<Record<string,string>>({})
  const [annotationRev,setAnnotationRev]=useState(0)
  useEffect(()=>chat?.subscribe(()=>setAnnotationRev(v=>v+1)),[chat])
  const stagedRequest=sessionId?chat?.getGenerateRequest?.(sessionId,state.generateTargetId):undefined
  useEffect(()=>{
    if(!state.generateRequestId||!sessionId||!chat?.getGenerateRequest)return
    const item=chat.getGenerateRequest(sessionId,state.generateTargetId)
    if(!item)store.update({generateDraft:undefined,generateRequestId:undefined})
  },[annotationRev,state.generateRequestId,sessionId,state.generateTargetId,chat,store])
  const annotations=flow?canvasAnnotations(flow,chat&&sessionId?chat.getAnnotations(flow.id,sessionId):[]):[]
  const busy=state.library.runs.some(r=>r.workflowId===flow?.id&&ACTIVE_RUN_STATUSES.includes(r.status))
  const scopeGraph=flow?graphAt(flow,scopePath):undefined
  const scopedFlow=flow&&scopeGraph?{...flow,...scopeGraph,notes:scopePath.length?[]:flow.notes}:undefined
  const node=scopeGraph?.nodes.find(n=>n.id===configId)
  const showReadiness=state.readinessState==='error'||!!state.readiness?.issues.length
  const showDetails=!!node||logs
  const locateIssue=(issue:WorkflowReadinessIssue)=>{
    if(issue.workflowId&&issue.workflowId!==flow?.id&&state.library.workflows.some(candidate=>candidate.id===issue.workflowId&&!candidate.archived)){
      void act(async()=>{await store.open(issue.workflowId!);if(issue.action==='environment')store.update({variablePanel:'environment',configId:'',logs:false})});return
    }
    if(issue.action==='environment'){store.update({variablePanel:'environment',configId:'',logs:false});return}
    if(issue.nodeId&&flow){const path=nodeScopePath(flow,issue.nodeId);if(path){store.update({scopePath:path,selected:[issue.nodeId],configId:issue.nodeId,variablePanel:undefined,logs:false});return}}
    navigation.openSettings()
  }
  const scopeNodes=flow?allNodes(flow):[]
  const annotationNodes=flow?enumerateAnnotationNodes(flow,scopePath):[]
  const enterScope=(id:string)=>{setScopePath([...scopePath,id]);setConfigId('');store.update({selected:[],viewport:{x:24,y:40,scale:.75}})}
  const editScoped=(next:Workflow)=>{if(!flow)return;edit({...flow,...replaceGraph(flow,scopePath,next),notes:scopePath.length?flow.notes:next.notes})}
  const act=async(fn:()=>Promise<unknown>)=>{setLocalError('');setWorking(true);try{await fn()}catch(e){setLocalError(String(e))}finally{setWorking(false)}}
  const edit=(next:Workflow)=>{try{store.edit(next)}catch(e){setLocalError(String(e))}}
  const returnToLibrary=async(workflowId:string)=>{
    store.captureViewport()
    await store.flushForNavigation()
    if(store.getSnapshot().workflow?.id!==workflowId)throw new Error(t('工作流已变化，请在当前画布重试。','The workflow changed. Please try again in the current canvas.'))
    store.update({page:'library'})
  }
  const requestBack=()=>{
    if(working||!flow)return
    setLocalError('');setLeaveError('')
    if(store.hasUnsavedChanges()){setLeaveWorkflowId(flow.id);return}
    void act(()=>returnToLibrary(flow.id))
  }
  const confirmLeave=async(discard:boolean)=>{
    if(working||!leaveWorkflowId)return
    const id=leaveWorkflowId
    setWorking(true);setLeaveError('')
    try{
      if(store.getSnapshot().workflow?.id!==id)throw new Error(t('工作流已变化，请在当前画布重试。','The workflow changed. Please try again in the current canvas.'))
      if(discard)await store.discardAndLeave()
      else {await store.save();await returnToLibrary(id)}
      setLeaveWorkflowId(undefined)
    }catch(error){setLeaveError(error instanceof Error?error.message:String(error))}
    finally{setWorking(false)}
  }
  const currentSession=()=>{const id=navigation.getSessionId();if(!id)throw new Error('请先打开一个对话，再将需求提交到聊天草稿。');return id}
  const submitAnnotation=async(text:string,nodeIds:string[])=>{
    if(!chat||!flow||!annotation)throw new Error('当前页面未连接原生聊天，无法提交注释。')
    const sourceId=flow.id,annotationId=annotation.id,portable=flow.editor?.annotations?.find(note=>note.id===annotationId)
    const assertContext=()=>{const current=store.getSnapshot();if(current.workflow?.id!==sourceId||!current.annotationDraft||current.annotationDraft.id!==annotationId)throw new Error('工作流或批注已变化，请返回原流程后重新提交');if(nodeIds.some(id=>!allNodes(current.workflow!).some(node=>node.id===id)))throw new Error('批注引用的节点已变化，请重新选择节点');return current.workflow!}
    assertContext()
    setAnnotation({...annotation,text,nodeIds})
    const targetSession=await ensureSession(flow.workspaceId);assertContext();await navigation.openChat(targetSession)
    const submitted=assertContext();if(store.getSnapshot().sessionId!==targetSession)throw new Error('协作对话已变化，请重新提交')
    await chat.stageAnnotation(targetSession,submitted,nodeIds,text,portable?undefined:annotationId,annotation.position)
    if(portable&&annotationId){
      const current=store.getSnapshot().workflow
      if(current?.id===sourceId){if(JSON.stringify(current.editor?.annotations?.find(note=>note.id===annotationId))===JSON.stringify(portable))store.edit(withoutPortableAnnotation(current,annotationId))}
      else{
        // A successful handoff may finish after navigation. Remove only the
        // unchanged source annotation, using its own revision, never the new canvas.
        const source=await store.api.get(sourceId),remaining=source.editor?.annotations?.find(note=>note.id===annotationId)
        if(remaining&&JSON.stringify(remaining)===JSON.stringify(portable)){
          const saved=await store.api.save(JSON.stringify(withoutPortableAnnotation(source,annotationId)),source.revision)
          const latest=store.getSnapshot();store.update({library:{...latest.library,workflows:latest.library.workflows.map(item=>item.id===saved.id?saved:item)}})
        }
      }
    }
    const current=store.getSnapshot()
    if(current.workflow?.id===sourceId&&current.annotationDraft&&current.annotationDraft.id===annotationId&&current.annotationDraft.text===text&&JSON.stringify(current.annotationDraft.nodeIds)===JSON.stringify(nodeIds))setAnnotation(undefined)
  }
  const deleteAnnotation=async(id:string)=>{
    const latest=store.getSnapshot().workflow
    if(latest?.editor?.annotations?.some(note=>note.id===id)){store.edit(withoutPortableAnnotation(latest,id));setAnnotation(undefined);return}
    if(!chat)throw new Error('当前页面未连接原生聊天。')
    await chat.deleteAnnotation(currentSession(),id)
  }
  function askGenerate(){
    setGenerateHidden(false);setLocalError('')
    const target=state.page==='canvas'?flow:undefined,id=navigation.getSessionId(),staged=id?chat?.getGenerateRequest?.(id,target?.id):undefined
    if(staged){store.update({generateDraft:staged.text,generateTargetId:target?.id,generateRequestId:staged.id});return}
    if(state.generateDraft!==undefined&&state.generateTargetId===target?.id&&!state.generateRequestId)return
    store.update({generateTargetId:target?.id,generateRequestId:undefined,generateDraft:''})
  }
  const submitGenerate=()=>act(async()=>{
    if(!chat)throw new Error(t('当前页面未连接原生聊天。','This view is not connected to native chat.'))
    const source=store.getSnapshot(),text=source.generateDraft??'',targetId=source.generateTargetId
    const changed=()=>new Error(t('工作流或需求已变化，请在当前画布重新提交。','The workflow or requirements changed. Submit again from the current canvas.'))
    const assertSource=()=>{
      const current=store.getSnapshot()
      if(current.workflow?.id!==source.workflow?.id||current.page!==source.page||current.sessionId!==source.sessionId||current.generateTargetId!==targetId||current.generateDraft!==text)throw changed()
    }
    await store.flush()
    assertSource()
    const target=targetId?store.getSnapshot().library.workflows.find(item=>item.id===targetId):undefined
    if(targetId&&!target)throw new Error(t('目标工作流已变化，请重新打开需求菜单。','The target workflow changed. Reopen the requirements menu.'))
    const workspaceId=target?.workspaceId||(workspace==='all'?state.library.workspaces[0]?.id:workspace)
    if(!workspaceId)throw new Error(t('请先选择工作区。','Select a workspace first.'))
    if(!state.library.workspaces.some(item=>item.id===workspaceId))throw new Error(t('该工作流所属的工作区已不在宿主中（可能已被移除），请重新添加该目录或另存到其他工作区。','The workflow\'s workspace is no longer in the host (it may have been removed). Add the folder again or save a copy to another workspace.'))
    const id=await ensureSession(workspaceId);assertSource();await navigation.openChat(id)
    const assertDestination=()=>{
      const current=store.getSnapshot()
      // Explicit attachment transfers this editor and its requirements together.
      // A different canvas or active conversation must never inherit ours.
      if(current.workflow?.id!==source.workflow?.id||current.page!==source.page||current.sessionId!==id||navigation.getSessionId()!==id)throw changed()
      if(current.generateTargetId!==targetId||current.generateDraft!==text)throw changed()
    }
    assertDestination()
    // Canvas edits can occur while the native conversation is mounting. Include
    // those edits in the persisted revision before handing its stable ID to Agent.
    await store.flush();assertDestination()
    const latestTarget=targetId?store.getSnapshot().library.workflows.find(item=>item.id===targetId):undefined
    if(targetId&&!latestTarget)throw changed()
    if(!await chat.insertGenerateRequest(id,text,latestTarget))throw new Error(t('聊天草稿暂时无法接收，请回到对话后重试。','The chat draft is unavailable. Return to the conversation and try again.'))
    assertDestination()
    const staged=chat.getGenerateRequest?.(id,targetId)
    store.update({generateDraft:text,generateTargetId:targetId,generateRequestId:staged?.id});setGenerateHidden(true)
  })

  const flows=state.library.workflows.filter(w=>(workspace==='all'||workflowVisibleInWorkspace(w,workspace))&&`${w.title} ${w.description}`.toLowerCase().includes(search.toLowerCase())&&(filter==='all'||state.library.runs.find(r=>r.workflowId===w.id)?.status===filter))
  const question=state.run?.status==='waiting'&&questionKey(state.run)!==questionDismissed?state.run:undefined
  const pendingProposals=state.proposals?.filter(proposal=>proposal.status==='pending')??[]
  return <div ref={root} className={`vdw vdw-${mode}`} data-testid="workflow-app" onKeyDownCapture={event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'&&state.page==='canvas'&&flow){event.preventDefault();event.stopPropagation();if(event.shiftKey)setSaveAsTitle(`${flow.title} 副本`);else void act(()=>store.save())}}}>
    {state.page==='library'||!flow?<>
      <header className="vdw-library-heading"><div><h1>{t('工作流','Workflows')}</h1><p>{t('创建、管理和复用你的流程','Create, manage and reuse your workflows')}</p></div><div className="vdw-actions vdw-home-actions"><Tooltip label={t('从模板创建','Create from template')} portal side="bottom"><Button data-workflow-library-trigger aria-label={t('从模板创建','Create from template')} icon={<Glyph name="arrange"/>} onClick={()=>setLibraryTab('templates')}><span className="vdw-home-action-label">{t('从模板创建','Create from template')}</span></Button></Tooltip><Tooltip label={t('导入工作流','Import workflow')} portal side="bottom"><Button data-workflow-library-trigger aria-label={t('导入工作流','Import workflow')} icon={<Glyph name="upload"/>} onClick={()=>setLibraryTab('import')}><span className="vdw-home-action-label">{t('导入 JSON','Import JSON')}</span></Button></Tooltip><Tooltip label={t('新建工作流','New workflow')} portal side="bottom"><Button variant="primary" aria-label={t('新建工作流','New workflow')} icon={<Glyph name="plus"/>} disabled={working} onClick={()=>setCreate({title:t('新工作流','New workflow'),workspace:workspace==='all'?state.library.workspaces[0]?.id||'':workspace,sample:false})}><span className="vdw-home-action-label">{t('新建工作流','New workflow')}</span></Button></Tooltip></div></header>
      <div className="vdw-library-controls"><Input aria-label={t('搜索工作流','Search workflows')} icon={<Glyph name="search"/>} placeholder={t('搜索工作流','Search workflows')} value={search} onChange={event=>setSearch(event.target.value)}/><div className="vdw-library-filters"><Select label={t('筛选工作流','Filter workflows')} value={filter} options={[{id:'all',label:t('筛选：全部状态','All statuses')},{id:'success',label:t('最近运行已完成','Last run completed')},{id:'failed',label:t('最近运行失败','Last run failed')},{id:'running',label:t('运行中','Running')},...(store.api.archived?[{id:'archived',label:t('已归档工作流','Archived workflows')}]:[])]} onChange={value=>{if(value==='archived')setArchive(true);else setFilter(value)}}/><Select label={t('工作区筛选','Filter workspace')} value={workspace} options={[{id:'all',label:t('全部工作区','All workspaces')},...state.library.workspaces.map(workspace=>({id:workspace.id,label:workspace.name}))]} onChange={setWorkspace}/></div></div>
      <span className="vdw-library-loading" role="status" aria-live="polite">{state.loading?t('正在加载工作流…','Loading workflows…'):''}</span>
      <div className={`vdw-library-divider${libraryScrolled?' is-scrolled':''}`} aria-hidden="true"/>
      <div ref={libraryBody} className="vdw-library-body" aria-busy={state.loading} onScroll={event=>setLibraryScrolled(event.currentTarget.scrollTop>0)}>
        {!!flows.length&&<div className="vdw-flow-grid">{flows.map(workflow=><WorkflowHomeCard key={workflow.id} workflow={workflow} workspaceName={workflow.scope==='global'?t('全局','Global'):state.library.workspaces.find(item=>item.id===workflow.workspaceId)?.name||t('工作区','Workspace')} status={statusLabel[state.library.runs.find(run=>run.workflowId===workflow.id)?.status||'']||t('尚未运行','Not run yet')} onOpen={()=>void act(()=>store.open(workflow.id))} onManage={()=>setManagedWorkflow(structuredClone(workflow))} onArchive={()=>setDeleting(workflow)} onExport={()=>setCardExport(structuredClone(workflow))} onCopy={()=>void act(()=>copyWorkflowCard(store,workflow,t('{title} 副本','{title} copy',{title:workflow.title})))}/>)}</div>}
        {!state.loading&&!flows.length&&<div className="vdw-empty"><WorkflowIcon size={40}/><h2>{state.library.workflows.length?t('没有符合条件的工作流','No matching workflows'):t('从一个流程开始','Start with a workflow')}</h2><p>{state.library.workflows.length?t('调整搜索或筛选条件，再试一次。','Adjust your search or filters and try again.'):t('手动搭建，或在对话中让 Agent 帮你创建。','Build one yourself or ask the Agent in your conversation.')}</p><div className="vdw-actions">{state.library.workflows.length?<Button onClick={()=>{setSearch('');setWorkspace('all');setFilter('all')}}>{t('清除筛选','Clear filters')}</Button>:<><Button variant="outline" disabled={working} onClick={()=>setCreate({title:'本地文本处理示例',workspace:state.library.workspaces[0]?.id||'',sample:true})}>{t('创建可运行示例','Create runnable example')}</Button><Button onClick={askGenerate}>{t('让 Agent 创建','Ask Agent to create')}</Button></>}</div></div>}
      </div>
    </>:<>
      <div className="vdw-editor-body">
        <EditorHeading title={flow.title} revision={flow.revision} saveState={state.saveState} savedAt={state.savedAt} onSave={()=>void act(()=>store.save())} onSaveAs={()=>setSaveAsTitle(`${flow.title} 副本`)} onBack={requestBack} management={{workflowId:flow.id,title:flow.title,description:flow.description,scope:flow.scope,workspaceId:flow.workspaceId,workspaceName:state.library.workspaces.find(item=>item.id===flow.workspaceId)?.name||flow.workspaceId,nodeCount:scopeNodes.length,edgeCount:flow.edges.length+scopeNodes.reduce((sum,item)=>sum+(item.config.body?.edges.length||0),0),updatedAt:flow.updatedAt,revision:flow.revision,onSaveDetails:async(title,description,scope)=>{const current=store.getSnapshot().workflow;if(!current||current.id!==flow.id)throw new Error(t('工作流已变化，请在当前画布重试。','The workflow changed. Please try again in the current canvas.'));store.edit({...current,title,description,scope:scope??'workspace'});await store.save()},onExport:()=>{store.captureViewport();setLibraryTab(undefined);setTransfer('export')}}} breadcrumb={!!scopePath.length&&<div className="vdw-scope-breadcrumb"><Button size="sm" onClick={()=>{setScopePath([]);setConfigId('');store.update({selected:[]})}}>{t("工作流","Workflow")}</Button>{scopePath.map((id,i)=><span key={id}> / <Button size="sm" onClick={()=>{setScopePath(scopePath.slice(0,i+1));setConfigId('');store.update({selected:[]})}}>{scopeNodes.find(n=>n.id===id)?.title||'内部流程'}</Button></span>)}<small>{t("内部变量：item / index / vars","Internal variables: item / index / vars")}</small></div>}/>
        <Canvas key={`${flow.id}/${scopePath.join('/')}`} registerViewport={store.registerViewport} inspectorOpen={showDetails} readinessIssues={state.readiness?.issues} advancedTab={advancedTab} onAdvanced={()=>{setLibraryTab(undefined);setAdvancedTab(advancedTab?undefined:'environment')}} onCloseAdvanced={()=>setAdvancedTab(undefined)} advancedSettings={advancedTab&&<AdvancedSettingsPanel store={store} tab={advancedTab} onTabChange={setAdvancedTab} onClose={()=>setAdvancedTab(undefined)} onLocate={id=>{const path=nodeScopePath(flow,id);if(path){setAdvancedTab(undefined);setScopePath(path);store.update({selected:[id],configId:id,logs:false})}}}/>} onJson={intent=>{store.captureViewport();if(intent==='import'){setTransfer(undefined);setLibraryTab('import')}else setTransfer('export')}} onTemplates={()=>{setTransfer(undefined);setLibraryTab('templates')}} libraryOpen={!!libraryTab} onCloseLibrary={()=>setLibraryTab(undefined)} libraryPanel={libraryTab&&<WorkflowLibraryPanel store={store} annotations={annotations} initialTab={libraryTab} onClose={()=>setLibraryTab(undefined)}/>} onCreateTemplate={store.api.saveTemplate?()=>setTemplateSelection({title:`${flow.title} 模板`,nodeIds:[...state.selected],scopePath:[...scopePath]}):undefined} inspectorNodeId={node?.id} viewport={state.viewport} onViewport={viewport=>store.update({viewport})} workflow={scopedFlow!} onAgent={askGenerate} executionActions={<RunToolbar store={store} working={working} onAction={fn=>void act(fn)} onExecute={()=>{setQuestionInputs({});setQuestionDismissed('');setLogs(true);store.update({sessionId:navigation.getSessionId()});void act(async()=>{const current=await prepareRunEnvironment(store,{workflowId:flow.id,sessionId:store.getSnapshot().sessionId});if(current.missing.length){setPendingRun({workflow:structuredClone(current.workflow),sessionId:current.sessionId});return}await store.execute({},current.intent)})}}/>} nested={!!scopePath.length} api={store.api} sessionId={sessionId} inLoop={scopePath.some(id=>scopeNodes.find(n=>n.id===id)?.kind==='loop')} onEnter={enterScope} selected={state.selected} disabled={false} canUndo={!!state.undo.length} canRedo={!!state.redo.length} onSelect={selected=>{store.update({selected});if(selected.length!==1)setConfigId('')}} onEdit={editScoped} onConfigure={setConfigId} scopePath={scopePath} pendingAnnotation={annotation?.position?{id:annotation.id||'new',text:annotation.text,nodeIds:annotation.nodeIds,position:annotation.position,number:annotations.find(a=>a.id===annotation.id)?.number??Math.max(0,...annotations.map(a=>a.number))+1}:undefined} onAnnotate={({position,anchorRect})=>beginAnnotation({text:'',nodeIds:state.selected.filter(id=>scopeGraph?.nodes.some(node=>node.id===id)),position},anchorRect)} annotations={[...annotations]} onEditAnnotation={(id,rect)=>{if(annotation&&(annotation.id||'new')===id){beginAnnotation(annotation,rect);return}const a=annotations.find(a=>a.id===id);if(a)beginAnnotation({id,text:a.text,nodeIds:a.nodeIds,position:a.position},rect)}} onUndo={()=>store.undo()} onRedo={()=>store.redo()} onRunDetails={()=>{setLogs(!logs);setConfigId('')}}/>{(showDetails||showReadiness||pendingProposals.length>0)&&<div className={`vdw-editor-dock ${showDetails?'has-details':''}`}>{pendingProposals.length>0?<div className="vdw-editor-notices"><ProposalNotice count={pendingProposals.length} onReview={()=>setReview(true)}/><WorkflowReadinessNotice store={store} onLocate={locateIssue}/></div>:<WorkflowReadinessNotice store={store} onLocate={locateIssue}/>}{node&&<NodePanel key={node.id} node={node} flow={scopedFlow!} onEdit={editScoped} onEnter={()=>enterScope(node.id)} store={store} disabled={false} onClose={()=>setConfigId('')} onSettings={navigation.openSettings}/>} {logs&&!node&&<RunPanel store={store} onClose={()=>setLogs(false)} onAnswer={()=>setQuestionDismissed('')}/>}</div>}</div>
    </>}
    {pendingRun&&<RunEnvironmentDialog store={store} workflow={pendingRun.workflow} sessionId={pendingRun.sessionId} onClose={()=>setPendingRun(undefined)} onStarted={()=>setLogs(true)}/>}
    {libraryTab&&(state.page==='library'||!flow)&&<WorkflowLibraryPanel store={store} annotations={annotations} initialTab={libraryTab} presentation="home" onClose={()=>setLibraryTab(undefined)}/>}
    {managedWorkflow&&<HomeWorkflowManagementDialog open revision={managedWorkflow.revision} onClose={()=>setManagedWorkflow(undefined)} details={{workflowId:managedWorkflow.id,title:managedWorkflow.title,description:managedWorkflow.description,workspaceId:managedWorkflow.workspaceId,workspaceName:state.library.workspaces.find(item=>item.id===managedWorkflow.workspaceId)?.name||managedWorkflow.workspaceId,scope:managedWorkflow.scope,revision:managedWorkflow.revision,nodeCount:allNodes(managedWorkflow).length,edgeCount:managedWorkflow.edges.length+allNodes(managedWorkflow).reduce((sum,node)=>sum+(node.config.body?.edges.length||0),0),updatedAt:managedWorkflow.updatedAt,onSaveDetails:async(title,description,scope)=>{const current=await store.api.get(managedWorkflow.id);const saved=await store.api.save(JSON.stringify({...current,title,description,scope:scope??'workspace'}),current.revision);setManagedWorkflow(saved);const latest=store.getSnapshot();store.update({library:{...latest.library,workflows:latest.library.workflows.map(item=>item.id===saved.id?saved:item)},...(latest.workflow?.id===saved.id?{workflow:saved}:{})})},onExport:()=>{setCardExport(managedWorkflow);setManagedWorkflow(undefined)}}}/>}
    {cardExport&&<WorkflowTransfer store={store} sourceWorkflow={cardExport} presentation="home" initialMode="export" onClose={()=>setCardExport(undefined)}/>}
    {archive&&<WorkflowArchive store={store} onClose={()=>setArchive(false)}/>}
    {review&&flow&&<ProposalReview store={store} onClose={()=>setReview(false)}/>}
    {transfer&&<WorkflowTransfer store={store} annotations={annotations} initialMode={transfer} onClose={()=>setTransfer(undefined)}/>}
    {templateSelection&&flow&&<Modal open title={t("创建个人模板","Create personal template")} closeLabel={t("关闭创建模板","Close template creation")} className="vdw-modal" onClose={()=>!working&&setTemplateSelection(undefined)} footer={<><Button disabled={working} onClick={()=>setTemplateSelection(undefined)}>{t("取消","Cancel")}</Button><Button variant="primary" disabled={working||!templateSelection.title.trim()} onClick={()=>void act(async()=>{if(!store.api.saveTemplate)throw new Error(t("当前宿主不支持保存模板","The host does not support saving templates"));await store.flush();const current=store.getSnapshot().workflow;if(!current||current.id!==flow.id)throw new Error(t("工作流已切换，请重新选择节点","The workflow changed. Select the nodes again."));await store.api.saveTemplate(current.id,templateSelection.title.trim(),{nodeIds:templateSelection.nodeIds,scopePath:templateSelection.scopePath,expectedRevision:current.revision});setTemplateSelection(undefined);setTemplateFeedback(t("已创建个人模板","Personal template created"));setLibraryTab('templates')})}>{working?t('正在保存','Saving'):t('创建模板','Create template')}</Button></>}><Field label={t("模板名称","Template name")}><Input data-modal-autofocus aria-label={t("模板名称","Template name")} maxLength={200} value={templateSelection.title} disabled={working} onChange={event=>setTemplateSelection({...templateSelection,title:event.target.value})}/></Field><p className="vdw-muted">{t('保存选中的 {count} 个节点及其内部连线。普通变量值、Secret 凭据和运行记录不随模板保存。','Save the {count} selected nodes and their internal edges. Regular variable values, Secret credentials and run history are excluded.',{count:templateSelection.nodeIds.length})}</p>{localError&&<p role="alert" className="vdw-error">{localError}</p>}</Modal>}
    {templateFeedback&&<div className="vdw-navigation-notice" role="status"><span>{templateFeedback}</span><Button size="sm" aria-label={t("关闭模板保存提示","Close template notification")} onClick={()=>setTemplateFeedback('')}><Glyph name="close"/></Button></div>}
    {state.libraryWarning&&<div className="vdw-navigation-notice" role="status"><span>{state.libraryWarning}</span><Button size="sm" aria-label={t('关闭资源目录提示','Close resource catalog notice')} onClick={()=>store.update({libraryWarning:undefined})}><Glyph name="close"/></Button></div>}
    {state.pendingWorkflow&&<div className="vdw-navigation-notice" role="status"><span>{t('工作流已就绪 · {title}','Workflow ready · {title}',{title:state.pendingWorkflow.title})}</span><Button size="sm" onClick={()=>void act(async()=>{await store.open(state.pendingWorkflow!.id);store.update({pendingWorkflow:undefined})})}>{t("查看工作流","View workflow")}</Button><Button size="sm" aria-label={t("关闭工作流完成提示","Close workflow completion notice")} onClick={()=>store.update({pendingWorkflow:undefined})}><Glyph name="close"/></Button></div>}
    {(state.error||localError)&&<div className="vdw-error-banner" role="alert"><span>{localError||state.error}</span>{state.saveState==='error'&&<Button size="sm" onClick={()=>void act(()=>store.save())}>重试保存</Button>}<Button size="sm" aria-label="关闭错误提示" onClick={()=>{setLocalError('');store.update({error:''})}}><Glyph name="close"/></Button></div>}
    {saveAsTitle!==undefined&&flow&&<Modal open title={t("工作流另存为","Save workflow as")} closeLabel={t("关闭另存为","Close save as")} className="vdw-modal" onClose={()=>!working&&setSaveAsTitle(undefined)} footer={<><Button disabled={working} onClick={()=>setSaveAsTitle(undefined)}>{t("取消","Cancel")}</Button><Button variant="primary" disabled={working||!saveAsTitle.trim()} onClick={()=>void act(async()=>{store.captureViewport();const current=store.getSnapshot();if(!current.workflow)throw new Error('请先打开工作流');const source={...current.workflow,title:saveAsTitle.trim(),editor:{...current.workflow.editor,viewport:current.viewport,scopePath:current.scopePath,annotations:annotations.map(({id,number,nodeIds,text,position})=>({id,number,nodeIds,text,...(position?{position}:{})}))}};await store.saveAs(exportWorkflowJson(source,{includeEnvironmentValues:true,presets:current.library.presets,workflows:current.library.workflows}));setSaveAsTitle(undefined)})}>{working?t('保存中…','Saving…'):t('另存为','Save as')}</Button></>}><Field label={t("新工作流名称","New workflow name")}><Input data-modal-autofocus aria-label={t("另存为工作流名称","New workflow name")} value={saveAsTitle} onChange={event=>setSaveAsTitle(event.target.value)}/></Field><p className="vdw-muted">{t("保存当前画布为独立工作流，保留节点、布局、批注和普通变量。密钥仅复制声明，新流程需要重新配置和授权。","Save the current canvas as a separate workflow, retaining nodes, layout, annotations and regular variables. Only Secret declarations are copied; values and permissions must be configured again.")}</p>{localError&&<p role="alert" className="vdw-error">{localError}</p>}</Modal>}
    {create&&<Modal open title={t("新建工作流","New workflow")} closeLabel={t("关闭新建工作流","Close new workflow")} onClose={()=>!working&&setCreate(undefined)} className="vdw-modal" footer={<><Button onClick={()=>setCreate(undefined)}>{t("取消","Cancel")}</Button><Button variant="primary" disabled={working||!create.title.trim()||!create.workspace} onClick={()=>void act(async()=>{await store.create(makeWorkflow(create.workspace,create.title.trim(),create.sample));setCreate(undefined)})}>{working?t('创建中…','Creating…'):t('创建','Create')}</Button></>}><Field label={t("名称","Name")}><Input data-modal-autofocus aria-label={t("工作流名称","Workflow name")} value={create.title} onChange={e=>setCreate({...create,title:e.target.value})}/></Field><Field label={t("工作区","Workspace")}><Select label={t("选择工作区","Select workspace")} value={create.workspace} options={state.library.workspaces.map(w=>({id:w.id,label:w.name}))} onChange={workspace=>setCreate({...create,workspace})}/></Field>{create.sample&&<p className="vdw-muted">{t("示例使用输入、模板和输出节点，可直接运行，无需模型。","The example uses input, template and output nodes and can run without a model.")}</p>}{!state.library.workspaces.length&&<p className="vdw-error">{t("请先在 DeepSeekHarness 添加工作区，然后刷新。","Add a workspace in DeepSeekHarness, then refresh.")}</p>}{localError&&<p className="vdw-error" role="alert">{localError}</p>}</Modal>}
    {deleting&&<Modal open title={t("归档工作流","Archive workflow")} closeLabel={t("关闭归档确认","Close archive confirmation")} className="vdw-modal" onClose={()=>!working&&setDeleting(undefined)} footer={<><Button onClick={()=>setDeleting(undefined)}>{t("取消","Cancel")}</Button><Button variant="primary" disabled={working||!!archiveImpact(deleting,state.library).active.length} onClick={()=>void act(async()=>{await store.api.remove(deleting.id,deleting.revision);setDeleting(undefined);await store.load()})}>{t("移入归档","Archive")}</Button></>}><p>{t('将「{title}」移入归档？可从管理页的“已归档”中恢复。运行记录与外部文件保留。','Archive “{title}”? You can restore it from Archived on the workflow home. Run history and external files are retained.',{title:deleting.title})}</p><ArchiveImpact flow={deleting} library={state.library}/></Modal>}
    {leaveWorkflowId&&flow?.id===leaveWorkflowId&&<WorkflowLeaveDialog workflowTitle={flow.title} working={working} error={leaveError} onCancel={()=>{if(!working){setLeaveWorkflowId(undefined);setLeaveError('')}}} onDiscard={()=>confirmLeave(true)} onSave={()=>confirmLeave(false)}/> }
    {annotation&&!annotationHidden&&flow&&!sessionChoice&&<AnnotationEditor open title={annotation.id?t('编辑注释','Edit annotation'):t('添加注释','Add annotation')} initialId={annotation.id||'new'} saveLabel={t("提交到草稿","Add to draft")} disabled={working} annotations={[{id:annotation.id||'new',number:annotations.find(a=>a.id===annotation.id)?.number??Math.max(0,...annotations.map(a=>a.number))+1,text:annotation.text,nodes:resolveAnnotationNodes(flow,annotation.nodeIds),workflowTitle:flow.title}]} availableNodes={annotationNodes} anchorRect={annotationAnchor} onClose={()=>setAnnotationHidden(true)} onDraftChange={(_id,text,nodeIds)=>setAnnotation({...annotation,text,nodeIds})} onSave={async(_id,text,nodeIds)=>submitAnnotation(text,nodeIds)} onDelete={annotation.id?deleteAnnotation:undefined} onDiscard={!annotation.id?()=>{const current=store.getSnapshot();if(current.workflow?.id!==flow.id||current.annotationDraft!==annotation)throw new Error(t('工作流或注释已变化，请在当前画布重试。','The workflow or annotation changed. Try again in the current canvas.'));setAnnotation(undefined)}:undefined}/>}

    {generate!==undefined&&!generateHidden&&!sessionChoice&&<WorkflowRequestDialog open value={generate} target={state.generateTargetId?state.library.workflows.find(item=>item.id===state.generateTargetId):undefined} working={working||stagedRequest?.status==='sending'} submitted={!!stagedRequest} error={localError} onChange={setGenerate} onClose={()=>setGenerateHidden(true)} onSubmit={submitGenerate}/>}
    {sessionChoice&&<Modal open title={t("选择协作对话","Select a conversation")} closeLabel={t("取消选择对话","Cancel conversation selection")} className="vdw-modal" onClose={()=>{sessionChoice.resolve(undefined);setSessionChoice(undefined)}} footer={<><Button onClick={()=>{sessionChoice.resolve(undefined);setSessionChoice(undefined)}}>{t("取消","Cancel")}</Button><Button variant="primary" onClick={()=>void act(async()=>{const id=chosenSession==='new'?await navigation.createSession?.(sessionChoice.workspaceId):chosenSession;if(!id)throw new Error(t("无法新建对话，请先在 Harness 中打开对话。","A conversation could not be created. Open a conversation in Harness first."));sessionChoice.resolve(id);setSessionChoice(undefined)})}>{t("继续","Continue")}</Button></>}><p className="vdw-muted">{t("选择工作流所属工作区中的对话。需求只加入草稿，由你决定何时发送。","Choose a conversation in the workflow workspace. Requirements are added to its draft for you to send.")}</p><Field label={t("协作对话","Conversation")}><Select label={t("协作对话","Conversation")} value={chosenSession} options={[{id:'new',label:'新建对话'},...(navigation.sessions?.(sessionChoice.workspaceId)||[]).map(s=>({id:s.id,label:s.title}))]} onChange={setChosenSession}/></Field>{localError&&<p className="vdw-error">{localError}</p>}</Modal>}
    {question&&<RunQuestion run={question} working={working} error={localError} onClose={()=>setQuestionDismissed(questionKey(question))} onCancel={()=>void act(()=>store.cancel())} onAnswer={values=>void act(()=>store.answer(values))}/>}

  </div>
}
function RunPanel({store,onClose,onAnswer}:{store:WorkflowStore;onClose:()=>void;onAnswer:()=>void}){
  const {t}=useLocale()
  const state=useWorkflowStore(store),[expanded,setExpanded]=useState(''),run=state.run
  const history=state.library.runs.filter(r=>r.workflowId===state.workflow?.id)
  return <aside className="vdw-run-panel" aria-label={t("运行详情","Run details")}><header><strong>{t("运行详情","Run details")}</strong><Button size="sm" aria-label={t("关闭运行详情","Close run details")} onClick={onClose}><Glyph name="close"/></Button></header><div className="vdw-config-body"><div className="vdw-run-overview">{!!history.length&&<Select label={t("选择运行记录","Select run history")} value={run?.id||''} options={history.map(r=>({id:r.id,label:`${new Date(r.startedAt).toLocaleTimeString('zh-CN')} · ${statusLabel[r.status]}`}))} onChange={id=>store.selectRun(id)}/>} {run&&<ExecutionSummary execution={run} revision={run.sourceRevision}/>}</div>{!run?<div className="vdw-empty"><p>{t("还没有运行记录","No runs yet")}</p><small>{t("点击执行，查看实际输入、输出与节点状态。","Execute the workflow to view actual inputs, outputs and node status.")}</small></div>:<><RunGovernance key={run.id} store={store} run={run}/>{run.status==='waiting'&&<Button variant="primary" onClick={onAnswer}>{t("补充信息","Provide information")}</Button>}{run.error&&<p className="vdw-error" role="alert">{run.error}</p>}{orderedExecutions(run).map(e=><div className="vdw-execution" key={e.executionId||e.nodeId}><button aria-expanded={expanded===(e.executionId||e.nodeId)} onClick={()=>setExpanded(expanded===(e.executionId||e.nodeId)?'':(e.executionId||e.nodeId))}><Glyph name={expanded===(e.executionId||e.nodeId)?"chevron-down":"chevron-right"} size={14}/><span>{e.number} {e.title}{e.iteration!==undefined?` · 第 ${e.iteration+1} 项`:""}</span><StatusBadge status={e.status}/></button>{expanded===(e.executionId||e.nodeId)&&<div className="vdw-execution-details"><ExecutionDetails execution={e}/>{(e.subagentId||e.repair)&&<AgentExecutionActions store={store} runId={run.id} execution={e}/>}</div>}</div>)}{!!Object.keys(run.outputs).length&&<RunOutputs run={run}/>}</>}</div></aside>
}
