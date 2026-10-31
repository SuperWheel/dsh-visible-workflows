import { isWorkflowSessionTool } from '../shared/workflow-session-tools.ts'
import { registerWorkflowSessionTools } from './workflow-session-tools.ts'
import { createTemplateBinding, templateIdForTool } from '../shared/planning-node-templates.ts'
import { assertPlanningToolOutputsUnchanged, buildPlanningToolOutputs, type TrustedToolOutputSchema } from '../shared/planning-tool-outputs.ts'
import { registeredToolOperation, operationDigest } from '../shared/tool-operation-contract.ts'
import { bindWorkflowSubagentsForRun } from '../shared/workflow-subagents.ts'
import { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { PlanningTurnJoin, planningJoinDisposition, type PlanningJoinView } from './planning/task-join.ts'
import { PlanningAnswerError } from './planning/input-state.ts'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-sandbox'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { homedir } from 'node:os'
import { statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { JsonValue, ModelRef, ToolChoice, LibrarySnapshot, Workflow, WorkflowNode, WorkflowProposal, WorkflowRun } from '../shared/types.ts'
import { makeWorkflow } from '../shared/types.ts'
import { workflowScope, workflowVisibleInWorkspace } from '../shared/workflow-scope.ts'
import { rolePresetAvailable } from '../shared/role-presets.ts'
import { workflowForExecution } from './workflow-scope.ts'
import type { PlanningContext, PlanningRequest } from '../shared/planning-types.ts'
import { parsePlanningRequest } from '../shared/planning-schema.ts'
import { normalizePlanningEditToolChanges } from '../shared/planning-edit-tool.ts'
import { optimizationTargetSchema } from '../shared/planning-optimization.ts'
import { queryWorkflowSemantics } from '../shared/workflow-semantics.ts'
import { createPlanningAgent, type PlanningSubagentService } from './planning/agent.ts'
import { collectConversationEvidence, type ConversationQuery } from './planning/conversation-evidence.ts'
import { WorkflowPlanningService, planningDigest, runsOnceAfterSave, type PlanningCaller, type PlanningTask } from './planning/service.ts'
import type { PlanningCommit } from './planning/receipt.ts'
import { registerWorkflowPlanningCommand, type CurrentPlanningTarget } from './planning/command.ts'
import { PlanningUIState } from './planning/ui-state.ts'
import { buildPlanningCommandBrief, moduleVerificationReceipt, designVerificationReceipt, workspaceChangeVerification } from './planning/command-brief.ts'
import { PLANNING_ROUTE_GUIDANCE, PLANNING_MODULE_HINT_GUIDANCE } from './planning/command-brief.ts'
import { currentTargetView, firstRunRunView, planningOptimizationView, planningTaskView, planningWaitView, trialInstruction, trialUsageView } from './host-views.ts'
import { parsePlanningEntry } from './planning/entry.ts'
import { planningWaitDelta } from './planning/wait-cursor.ts'
import { planningBackgroundRuntime } from './planning/background.ts'
import { PlanningContextReader, type PlanningReaderOptions } from '../shared/planning-context-reader.ts'
import { businessModuleCatalog } from '../shared/planning-business-modules.ts'
import { createTrialAgent, normalizeTrialEntryTools, trialToolNames, validateTrialEntryTools } from './planning/trial-agent.ts'
import { buildCreateEntry, CREATE_TOOL_DESCRIPTION } from './planning/create-entry.ts'
import { MAIN_CHAT_GUIDE } from './planning/main-guide.ts'
import { WorkflowTrialService, type PlanningTrial } from './planning/trial-service.ts'
import { WorkflowStorage } from './storage.ts'
import { WorkflowRuntime, HumanPause, type WorkflowReplayStep } from './runtime.ts'
import { changedNodeIds, dataSources, latestRunFor, matchTargets, numberDraftRevisions, requestQuotes, runResults, sampleValue, wrapFlatNodeForms } from './revise-locate.ts'
import { compilePlanningChain } from '../shared/planning-chain.ts'
import { planningNodeRefs } from '../shared/planning-edits.ts'
import { harnessModels, modelCatalog } from './llm.ts'
import { allNodes, parseWorkflow } from './validation.ts'
import { ToolCatalog, toolCatalogView } from './tool-catalog.ts'
import { createExecutionAdapters, httpRequest } from './execution-adapters.ts'
import type { AdapterRequest } from './runtime.ts'
import { isModelNode, liveSessionModelDefaults, resolveHarnessModelDefaults } from './model-defaults.ts'
import { ensureGraphonEnvironment } from './graphon-environment.ts'
import { graphonRuntimeDirectory } from './graphon.ts'
import { createNativeAgentExecutor, type NativeSubagentService, type NativeAgentExecutor } from './native-agent.ts'
import { WorkflowTemplateLibrary } from './template-library.ts'
import { parseWorkflowTemplateSelection } from '../shared/workflow-template-selection.ts'
import { WorkflowEditorState } from './editor-state-store.ts'
import { prepareWorkflowImport } from './workflow-import.ts'
import { createWorkflowArchive, materializeWorkflowArchive, parseWorkflowArchive } from './workflow-package-archive.ts'
import { inspectWorkflowReadiness, assertWorkflowReady, needsReadinessModelDefaults } from './workflow-readiness.ts'
import { parseWorkflowImportOptions } from '../shared/workflow-import.ts'
import { WORKFLOW_PACKAGE_MAX_BYTES } from '../shared/workflow-format.ts'
import { ModelAdmission } from './run-usage.ts'
import { ProtectedBrokerError } from './secret-broker-protocol.ts'
import { OSSecretBroker } from './os-secret-broker.ts'
import { assertCurrentSecretRuntime } from './secret-runtime-compatibility.ts'
import { PROTECTED_OPERATION } from '../shared/protected-secret.ts'
import { resolveAgentWorkspace } from './agent-workspace.ts'
import { workflowAgentOwner } from './agent-owner.ts'
import { RunObservationScopes, type ObservationContext } from './run-observation-scope.ts'
import type { WorkflowQuestion, WorkflowQuestionAnswer } from './user-questions.ts'

type NativeToolSchema=ReturnType<Context['tools']['schemas']>[number]
const LIVE_RUN_STATUSES:readonly string[]=['running','waiting','pausing','paused','budget_waiting']
export interface Config { stateDirectory?: string; planningCompiler?:'legacy'|'compact-repair'|'template-fill'; commandEarlyHandoff?:boolean }
declare module '@deepseek-ai/cordis' { interface Context { visibleWorkflows: VisibleWorkflowService } }
declare module '@deepseek-ai/dsh-typert-protocol' { interface RemoteErrorDetailsMap { 'visible-workflows/unavailable': { reason: string } } }
const failure = (error: unknown) => { const reason = error instanceof Error ? error.message : String(error); return new RemoteError('visible-workflows/unavailable', reason, { reason }) }
// Revision handoffs, formerly in the standing guide (T31.6).
const PLAN_HANDOFF_GUIDANCE='handoff 写法：确定字段可用 {version:1,mode:edit,changes:[{op:set-config,nodeId,field,value}或{op:unset-config,nodeId,field}或{op:set-title,nodeId,value}]}（优先直接用 visible_workflow_edit），已理解的决定不要交子Agent重做；需要局部推理用 {version:1,mode:partial,changes:已确定修改,unresolved:[{nodeId,fields:[字段],question:仅未决问题}],constraints?,evidenceRefs?}，只补未决字段；version:2 可加 completion:[{nodeId,field,require:changed或present}]，义务须来自明确需求且属于 unresolved 字段，changed 要求字段存在且不同于原基线，present 只要求存在，version:1 保留幂等语义，不得静默降版丢失义务。写入后回读核对不算审核，不选 reviewed-file-write；需要模块外业务节点时由规划子Agent保留固定模块行为并补全业务逻辑，已有模块实例只用 partial 补未决字段。'
const readJSON = (text: string,maxBytes=4_000_000): unknown => { if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('提交内容过大'); return JSON.parse(text) }
/** Desktop r65 E: a chain written as JSON text lost a bracket; say where, and that an object needs no escaping. */
const readJSONText = (name: string, text: string, maxBytes: number): unknown => {
  try { return readJSON(text, maxBytes) } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    const at = Number(/position (\d+)/.exec(error.message)?.[1])
    throw new Error(`${name} 是 JSON 文本，解析失败：${error.message}${Number.isFinite(at) ? '；出错位置附近：' + JSON.stringify(text.slice(Math.max(0, at - 60), at + 20)) : ''}。${name} 直接传对象（不写成字符串），就不用自己转义`)
  }
}
/** T31.5: a structured parameter, or the same value as JSON text under `<name>_json`; one of the two. */
const jsonArg = (args: Record<string, unknown>, name: string, maxBytes: number, required = true): unknown => {
  const value = args[name], text = args[name + '_json']
  if (value !== undefined && text !== undefined) throw new Error(`${name} 与 ${name}_json 只传一个`)
  // Desktop r61 E: the main chat passed chain as JSON text; read it the same as name_json.
  if (typeof value === 'string' && /^\s*\{/.test(value)) return readJSONText(name, value, maxBytes)
  if (value !== undefined) { if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) throw new Error('提交内容过大'); return value }
  if (typeof text === 'string') return readJSONText(name, text, maxBytes)
  if (required) throw new Error(`缺少 ${name}（对象）`)
  return undefined
}
const LOCATE_TOOL_DESCRIPTION='修改已保存工作流的第一步。workflow 填用户说的标题或工作流 ID，request 原样填用户原话。Host 一次返回：目标工作流和版本；按原话引号里的文字或节点标题对上的目标节点（与 visible_workflow_nodes 同格式）；目标节点和它读取的上游节点在最近一次运行里的真实输出样例（没有运行记录时 Host 先执行一次）；以目标为锚绑定好的链段和 code 模板。据此直接写 operations 交给 visible_workflow_splice，不必再 list、nodes、tools 或自己调用工具查看字段。'
const LOCATE_RUN_WAIT_MS=180_000
const runSessionId=(run:WorkflowRun):string|undefined=>typeof run.systemVariables?.session_id==='string'?run.systemVariables.session_id:undefined
const agentTaskIds=(record:WorkflowRun['executions'][number]):string[]=>[...(record.repairTaskIds??[])].reverse().concat(record.subagentId??[])
const ownsExecution=(taskExecutionId:string,executionId:string):boolean=>taskExecutionId===executionId||taskExecutionId.startsWith(`${executionId}/repair/`)
const toolModeNode=(node:WorkflowNode):boolean=>node.kind==='tool'||(node.kind==='document'&&node.config.documentMode==='tool')
const nodeToolRefs=(node:WorkflowNode):string[]=>toolModeNode(node)?[node.config.toolId??'']:node.kind==='agent'||(node.kind==='document'&&node.config.documentMode==='agent')?node.config.tools??[]:[]
const nodeToolIds=(node:WorkflowNode):string[]=>[node.config.toolId,...(node.config.tools??[])].filter((id):id is string=>!!id)
const effortRanks: Record<string, number> = { off: 0, none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6, ultra: 7 }
// Ignore only view navigation. In particular, retain reviewed node numbers,
// annotations and version metadata rather than renumbering the definition.
const planningBaselineDigest=(flow:Workflow):string=>{
  const {editor,...content}=flow
  const definitionEditor=Object.fromEntries(Object.entries(editor??{}).filter(([key])=>key!=='viewport'&&key!=='scopePath'))
  return planningDigest({...content,...(Object.keys(definitionEditor).length?{editor:definitionEditor}:{})})
}
const assertTemplateBindingCurrent=(binding:NonNullable<PlanningTask['templateBinding']>,candidate:Workflow,context:PlanningContext,currentTools:readonly ToolChoice[]):void=>{
  const templateTools=currentTools.map(tool=>{
    if(context.tools.find(before=>before.id===tool.id)?.operationContract)return tool
    const {operationContract:_,...historical}=tool
    return historical
  })
  const latest=createTemplateBinding(templateTools,context.toolOutputs)
  const before=new Map(binding.templates.map(t=>[t.id,t])),after=new Map(latest.templates.map(t=>[t.id,t]))
  const ids=new Set(allNodes(candidate).map(node=>node.kind==='tool'?templateIdForTool(node.config.toolId??''):node.kind))
  for(const id of ids)if(!before.has(id)||!after.has(id)||planningDigest(before.get(id))!==planningDigest(after.get(id)))
    throw new Error('TEMPLATE_CONTRACT_CONFLICT：使用的节点或工具模板已变化，请重新规划')
}
// Preserve reviewed execution settings and inert legacy metadata on edits.
// New graphs never acquire retired budget fields from model-supplied JSON.
const retainReviewedSettings=(flow:Workflow,previous:Workflow|undefined):void=>{
  if(previous){
    if(previous.executionPolicy!==undefined)flow.executionPolicy=structuredClone(previous.executionPolicy)
    else delete flow.executionPolicy
    if(previous.budgetDecision!==undefined)flow.budgetDecision={...previous.budgetDecision}
    else delete flow.budgetDecision
  }else{
    delete flow.budgetDecision
    if(flow.executionPolicy){
      delete flow.executionPolicy.tokenBudget
      delete flow.executionPolicy.perTaskTokens
      delete flow.executionPolicy.maxAgentTasks
    }
  }
}
const bindAgentSubagents=(flow:Workflow,previous:Workflow|undefined,ownerId:string):void=>{
  if(workflowScope(flow)==='global')for(const definition of flow.subAgents??[])delete definition.sessionId
  else{
    bindWorkflowSubagentsForRun(flow,ownerId)
    for(const definition of flow.subAgents??[]){
      const old=previous?.subAgents?.find(item=>item.id===definition.id)
      if(old?.sessionId&&old.sessionId!==ownerId)throw new Error('不能复用其他主对话的子 Agent 身份，请创建新身份')
    }
  }
}
const applyNodeModelDefaults=(node:WorkflowNode,prior:WorkflowNode|undefined,current:{provider?:string;model?:string;reasoningEffort?:string}):ModelRef=>{
  if (!node.config.model) {
    if (!current.provider || !current.model) throw new Error('当前 Agent 的模型尚不可确定，请先在节点配置中选择模型')
    node.config.model = { provider: current.provider, model: current.model }
  }
  const sameCurrent = node.config.model.provider === current.provider && node.config.model.model === current.model
  const samePrior = prior?.config.model?.provider === node.config.model.provider && prior?.config.model?.model === node.config.model.model
  if (!sameCurrent && !samePrior) throw new Error('自动生成默认使用当前 Agent 模型，其他模型请由用户在节点中选择')
  if (!node.config.effort && sameCurrent) node.config.effort = current.reasoningEffort
  if (node.config.effort && node.config.effort !== prior?.config.effort) {
    if (!sameCurrent) throw new Error('其他模型的思考强度请由用户手动选择')
    const requested = node.config.effort, cap = current.reasoningEffort
    if (!cap || (requested !== cap && (!(requested in effortRanks) || !(cap in effortRanks) || effortRanks[requested]! > effortRanks[cap]!)))
      throw new Error('自动选择的思考强度不能超过当前 Agent；无法比较的强度只能沿用当前值')
  }
  return node.config.model
}
const conversationPlanningRequestSchema=z.object({requestId:z.string(),instruction:z.string(),
  fromSeq:z.number().int().nonnegative().optional(),throughSeq:z.number().int().nonnegative().optional(),
  optimizationTarget:optimizationTargetSchema.optional()}).strict()

/** Plugin-owned persistence and graph execution exposed through Harness's authenticated Gateway. */
export class VisibleWorkflowService extends TypertRemoteService {
  static inject = ['llm', 'tools', 'workspaceRegistry', 'systemPrompt', 'typert', 'agents']
  static Config: schema<Config> = schema.object({ stateDirectory: schema.string(),
    planningCompiler: schema.union([schema.const('legacy'),schema.const('compact-repair'),schema.const('template-fill')]).default('template-fill'),
    commandEarlyHandoff:schema.boolean().default(false) })
  private readonly storage: WorkflowStorage
  private readonly runtime: WorkflowRuntime
  private readonly catalog: ToolCatalog
  private readonly editor: WorkflowEditorState
  private readonly templatesLibrary: WorkflowTemplateLibrary
  private readonly nativeAgent: NativeAgentExecutor
  private readonly secretBroker: OSSecretBroker
  private readonly planner: WorkflowPlanningService
  private readonly trials: WorkflowTrialService
  /** Puts the workflow session tools into one agent's scope; see registerWorkflowSessionTools. */
  private enableSessionTools?: (agent: Agent, options?: { guidance?: boolean }) => void
  private readonly planningUI = new PlanningUIState()
  private readonly planningJoin = new PlanningTurnJoin()
  private readonly planningReaders = new Map<string,PlanningContextReader>()
  /** T37.5: the chain binding the newest locate gave each main chat per workflow; a splice then sends only operations. */
  private readonly locatedChains = new Map<string,{revision:number;binding:Record<string,unknown>}>()
  private readonly modelAdmission = new ModelAdmission(8)
  private readonly runContexts = new Map<string, { agent?: Agent; exec?: ToolRunContext; ancestors: string[] }>()
  private readonly observations: RunObservationScopes
  constructor(ctx: Context, config: Config) {
    super(ctx, 'visibleWorkflows', { namespace: 'visibleWorkflows' })
    assertCurrentSecretRuntime(ctx)
    this.secretBroker = new OSSecretBroker()
    ctx.effect(() => () => this.secretBroker.close(), 'visible-workflows:secret-lifetime')
    this.storage = new WorkflowStorage(config.stateDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'visible-dynamic-workflows'))
    try {
    // Register immediately after acquisition; constructor failures also release synchronously below.
    ctx.effect(() => () => this.runtime ? this.runtime.close() : this.storage.close(), 'visible-workflows:lifetime')
    this.editor = new WorkflowEditorState(this.storage,proposal=>this.planner?.proposalBase(proposal))
    this.templatesLibrary = new WorkflowTemplateLibrary(this.storage.directory)
    this.catalog = new ToolCatalog({ directory:this.storage.directory, sessionForRun:id=>this.runContexts.get(id)?.agent?.id, workflows:id=>this.storage.visibleWorkflows(id),
      nativeTools:(id,session)=>this.nativeTools(id,session), executeNative:(id,args,request)=>this.executeNative(id,args,request), runWorkflow:(id,args,request)=>this.runNested(id,args,request), http:httpRequest,
      workspaceRoot:id=>{this.workspace(id);return ctx.workspaceRegistry.list().find(w=>w.id===id)!.path} })
    const nativeAgent=createNativeAgentExecutor({ctx,catalog:this.catalog,childForId:id=>ctx.agents.get(SessionId(id)),
      subagents:()=> (ctx as unknown as {get(name:string):unknown}).get('subagents') as NativeSubagentService|undefined,
      parentForRun:id=>this.runContexts.get(id)?.agent,
      createParent:async request=>{
        this.workspace(request.workspaceId)
        return ctx.agents.create({sessionId:SessionId(randomUUID()),meta:{cwd:ctx.workspaceRegistry.list().find(w=>w.id===request.workspaceId)!.path},
          agentOptions:{provider:request.node.config.model?.provider,model:request.node.config.model?.model,...(request.node.config.effort?{reasoningEffort:ReasoningEffortId(request.node.config.effort)}:{})},
          signal:request.signal,
          setup:async agentCtx=>{const presets=(ctx as unknown as {get(name:string):unknown}).get('agentPresets') as {mount(ctx:Context,id?:string):Promise<unknown>}|undefined;if(presets)await presets.mount(agentCtx)}})
      },
      nativeTools:agent=>ctx.tools.schemas(agent).map(tool=>tool.name)})
    this.nativeAgent=nativeAgent
    this.runtime = new WorkflowRuntime(this.storage, harnessModels(ctx.llm), createExecutionAdapters({ nativeAgent,catalog:this.catalog, readAttachment:(runId,fileId)=>this.storage.readAttachment(runId,fileId),
      workspaceRoot:id=>{this.workspace(id);return this.ctx.workspaceRegistry.list().find(w=>w.id===id)!.path}, sessionForRun:id=>this.runContexts.get(id)?.agent?.id,
      secretPreflight:(flow,signal)=>this.secretPreflight(flow,signal),
      protectedHttp:request=>this.protectedHttp(request),
      pythonExecutable:async signal=>(await ensureGraphonEnvironment({directory:graphonRuntimeDirectory(this.storage.directory),signal})).python,
      // Cordis get() is its documented optional-service lookup; absence must not disable JS/builtin workflows.
      confinePython:async(argv,root,signal)=>{
        const sandbox=ctx.get('sandbox')
        if(!sandbox)throw new Error('宿主尚未启用文件沙箱，Python 不可执行')
        const confined=await sandbox.confine(argv,{mode:'read-only',workspaceRoot:root},signal)
        if(confined.enforcement!=='full')throw new Error('Python 需要完整文件沙箱，当前平台仅部分支持')
        return confined.argv
      }
    }),(run,signal)=>this.assertRunReady(run,signal),{admission:this.modelAdmission})
    ctx.effect(()=>()=>this.planningUI.dispose(),'visible-workflows:planning-ui-lifetime')
    this.planner = new WorkflowPlanningService({
      backgroundRuntime:planningBackgroundRuntime(ctx,ctx.agents),
      onUpdate:task=>this.planningUI.record(task),
      askQuestions:async(task,caller)=>{
        const questions=(ctx as unknown as {get(name:string):unknown}).get('userQuestions') as {ask(request:{agent:Agent;signal:AbortSignal;questions:WorkflowQuestion[]}):Promise<WorkflowQuestionAnswer>}|undefined
        // Keep the pending batch answerable when the optional native UI is absent.
        if(!questions)return undefined
        this.authorizePlanning(task,caller,!task.preview)
        const batch=task.output!.questions
        const result=await questions.ask({agent:caller.parent,signal:caller.signal,
          questions:batch.map(question=>({id:question.id,header:'工作流规划',question:question.question,...(question.options.length?{options:question.options.map(label=>({label}))}:{})}))})
        return result.answers.map(answer=>{
          const text=answer.custom?.trim()
          if(text&&answer.selected.length||answer.selected.length>1)throw new Error('每个问题请选择一个选项或填写文字')
          return {questionId:answer.id,answer:text||answer.selected[0]||''}
        })
      },
      directory:this.storage.directory, admission:this.modelAdmission,
      compilerMode:config.planningCompiler??'template-fill',
      commandRequest:(task,value,caller)=>this.commandIntakeRequest(task,value,caller),
      commandSubmit:async(request,caller)=>JSON.parse(await this.planningEntry(request,caller)),
      driver:createPlanningAgent({ctx,childForId:id=>ctx.agents.get(SessionId(id)),subagents:()=>ctx.get('subagents') as unknown as PlanningSubagentService|undefined}),
      context:(request,caller)=>this.planningContext(request,caller),
      authorize:(task,caller,write)=>this.authorizePlanning(task,caller,write),
      readiness:(candidate,caller)=>this.readinessFor(candidate,caller.sessionId),
      publish:(candidate,task,caller,commit)=>this.publishPlanning(candidate,task,caller,commit),
      runCreated:(task,caller,started)=>this.runCreatedTrial(task,caller,started),
      receipt:key=>this.storage.planningReceipt(key)??this.editor.planningReceipt(key),
      retainReceiptBase:receipt=>receipt.kind==='proposed'&&this.editor.needsPlanningBase(receipt.proposalId!),
      workspaceRevisions:caller=>this.planningWorkspaceRevisions(caller.workspaceId),
    })
    this.trials = new WorkflowTrialService({
      backgroundRuntime:planningBackgroundRuntime(ctx,ctx.agents),onUpdate:trial=>this.planningUI.recordTrial(trial),
      directory:this.storage.directory,admission:this.modelAdmission,
      driver:createTrialAgent({ctx,childForId:id=>ctx.agents.get(SessionId(id)),subagents:()=>ctx.get('subagents') as unknown as PlanningSubagentService|undefined,isKnownChild:id=>this.trials?.isKnownChild(id)??false,prepareChild:agent=>this.enableSessionTools?.(agent,{guidance:false})}),
      resolve:caller=>{
        this.assertMutable(caller.parent)
        const current=this.planningModel(caller)
        const workspace=ctx.workspaceRegistry.list().find(item=>item.id===caller.workspaceId)
        if(!workspace?.path)throw new Error('试做需要有效的当前工作区目录')
        return {workspaceRoot:workspace.path,model:{provider:current.provider,model:current.model},...(current.reasoningEffort?{effort:current.reasoningEffort}:{}),policyDigest:this.trialPolicyDigest(caller.parent)}
      },
      authorize:(trial,caller,execute)=>this.authorizeTrial(trial,caller,execute),
      plan:(request,caller)=>this.planner.start(request,caller),

    })
    ctx.effect(() => () => this.trials.close(), 'visible-workflows:trial-lifetime')
    ctx.effect(() => () => this.planner.close(), 'visible-workflows:planning-lifetime')
    this.registerTools()
    // Each run (and child run) owns its file observations; see run-observation-scope.ts.
    this.observations=new RunObservationScopes(ctx as unknown as ObservationContext)
    ctx.effect(()=>{const disposers=this.observations.listeners();return ()=>{for(const dispose of disposers)dispose()}},'visible-workflows:run-observations')
    // Release a run's context and ledger at its persisted terminal transition,
    // whichever path caused it. A settle() callback would read a later status:
    // an early answer/resume made it running again and lost the live binding.
    ctx.effect(()=>this.storage.onRunSaved(run=>{if(!LIVE_RUN_STATUSES.includes(run.status))this.releaseRun(run.id)}),'visible-workflows:run-release')
    ctx.effect(()=>ctx.on('agent/pre-step',async({agent,turn,messages},next)=>{
      const decision=await next()
      this.planningJoin.begin(agent,turn,messages)
      return decision
    }),'visible-workflows:join-turn')
    ctx.effect(()=>ctx.on('agent/inbox/inserted',({agent,message})=>{
      if(agent.inbox.nextStep.some(item=>item.id===message.id))this.planningJoin.interrupt(agent)
    }),'visible-workflows:join-input')
    ctx.effect(()=>ctx.on('agent/turn-stopping',async({agent,turn,signal})=>{
      await this.planningJoin.stopping(agent,turn,signal,{
        read:(id,workspace)=>this.readPlanningJoin(id,this.joinCaller(agent,signal,workspace)),
        wait:(id,workspace,waitSignal)=>this.waitPlanningTask(id,this.joinCaller(agent,waitSignal,workspace),60_000),
      })
    }),'visible-workflows:join-stop')
    registerWorkflowPlanningCommand(ctx, {
      authorize:(agent,signal)=>{this.planningCaller({agent,signal});this.enableSessionTools?.(agent)},
      brief:({agent,signal})=>{const caller=this.planningCaller({agent,signal});return buildPlanningCommandBrief(caller.workspaceId,this.storage.visibleWorkflows(caller.workspaceId))},
      ...(config.commandEarlyHandoff!==true?{}:{intake:async({agent,signal,rawInput,commandId})=>{
        const caller=this.backgroundPlanningCaller(this.planningCaller({agent,signal},'selection'))
        const brief=buildPlanningCommandBrief(caller.workspaceId,this.storage.visibleWorkflows(caller.workspaceId))
        const readOnly=this.planningReadOnly(agent),requestId='command-'+planningDigest([caller.workspaceId,caller.sessionId,commandId])
        const task=await this.planner.start({requestId,operation:'create',instruction:rawInput,preview:readOnly},caller,{background:true,commandIntake:{brief,rawRequirement:rawInput,readOnly}})
        this.planningJoin.trackCommand(agent,caller.workspaceId,JSON.parse(this.planningView(task)))
        return {taskId:task.id}
      }}),
    })
    // These are workflow template examples, not Harness prompt variables.
    ctx.effect(() => ctx.systemPrompt.section({ name: 'visible-workflows:guide', order: 85, interpolate: false, text:MAIN_CHAT_GUIDE }), 'visible-workflows:guide')
    } catch(error) {
      this.rollbackInitialization()
      throw error
    }
  }
  private rollbackInitialization():void{
      // No execution is dispatched during construction. Abort any initialized
      // components before releasing the lock, even when Cordis disposal is delayed.
      try {
        this.planningUI.dispose()
        void this.trials?.close().catch(()=>{})
        void this.planner?.close().catch(()=>{})
        void this.runtime?.close().catch(()=>{})
        this.secretBroker.close()
      } finally { this.storage.close() }
  }
  private async secretPreflight(flow:Workflow,signal:AbortSignal):Promise<void>{
    const ids=new Set((flow.environmentVariables??[]).filter(v=>v.type==='secret'&&v.required).map(v=>v.id))
    for(const node of allNodes(flow))if(node.config.credentialOperation)ids.add(node.config.credentialOperation.secretVariableId)
    for(const variableId of ids){
      if(!flow.environmentVariables?.some(v=>v.id===variableId&&v.type==='secret'))throw new ProtectedBrokerError('invalid_request')
      const status=await this.secretBroker.status({workspaceId:flow.workspaceId,workflowId:flow.id,variableId,nodeId:'environment'},signal)
      if(status.state!=='configured')throw new ProtectedBrokerError('item_missing')
      if(allNodes(flow).some(node=>node.config.credentialOperation?.secretVariableId===variableId)&&status.authorization!=='authorized')throw new ProtectedBrokerError('authorization_required')
    }
  }
  private async protectedHttp(request:AdapterRequest){
    // Resolve the frozen run definition, never a caller-supplied credential binding.
    const run=this.storage.run(request.runId),operation=request.node.config.credentialOperation
    if(run.workspaceId!==request.workspaceId||operation?.operationId!==PROTECTED_OPERATION||
      !allNodes(run.graph).some(n=>n.id===request.node.id&&n.config.credentialOperation?.secretVariableId===operation.secretVariableId)||
      !run.graph.environmentVariables?.some(v=>v.type==='secret'&&v.id===operation.secretVariableId))throw new ProtectedBrokerError('invalid_request')
    return this.secretBroker.execute({workspaceId:run.workspaceId,workflowId:run.workflowId,variableId:operation.secretVariableId,nodeId:request.node.id},request.signal)
  }
  private async assertRunReady(run:WorkflowRun,signal:AbortSignal):Promise<void>{
    signal.throwIfAborted()
    assertWorkflowReady(await this.readinessFor(run.graph,runSessionId(run),run))
    signal.throwIfAborted()
  }
  private commandIntakeRequest(task:PlanningTask,value:unknown,caller:PlanningCaller):Record<string,unknown>{
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('命令受理须提交标准规划请求')
    const request=value as Record<string,unknown>,requestId=task.request.requestId+'-plan'
    if(request.operation!==undefined&&request.operation!=='create'||request.targetWorkflowId!==undefined||request.source!==undefined||request.targetNodeIds!==undefined||
      request.requestId!==undefined&&request.requestId!==requestId||
      request.instruction!==undefined&&request.instruction!==task.request.instruction)throw new Error('命令 intake 只受理原始需求的新建；已有图交回主 Agent，不更改身份或原始需求')
    const submitted={...request,requestId,operation:'create',instruction:task.request.instruction}
    const parsed=parsePlanningEntry(submitted,this.planningReadOnly(caller.parent))
    if(parsed.request.moduleCheck&&task.commandIntake)task.commandIntake.moduleCheck=parsed.request.moduleCheck
    return submitted
  }
  private async publishPlanning(candidate:Workflow,task:PlanningTask,caller:PlanningCaller,commit:PlanningCommit):Promise<void>{
    const revision=task.request.operation==='revise'?task.request.expectedRevision!:0
    const recordPublished=()=>{if(task.workspaceSnapshot)task.workspaceSnapshot.published=this.planningWorkspaceRevisions(caller.workspaceId)}
    await this.agentSave(candidate,revision,caller.parent,caller.signal,commit,()=>this.authorizePlanning(task,caller,true),this.planningModel(caller),recordPublished)
  }
  private workspace(id: string): void { if (!this.ctx.workspaceRegistry.list().some(w => w.id === id)) throw new Error('工作区不存在，请在宿主中选择有效工作区') }
  private agentWorkspace(agent: Agent): string {
    const workspaceId = resolveAgentWorkspace(agent, this.ctx.workspaceRegistry.list(), this.ctx.agents)
    if (!workspaceId) throw new Error('此对话尚未归属有效工作区，请先选择工作区')
    return workspaceId
  }
  private assertMutable(agent: Agent): void {
    if (agent.ctx.get('planMode')?.get(agent).active) throw new Error('当前为规划模式，请先退出规划模式再保存或执行工作流')
    if (agent.ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode === 'read-only') throw new Error('当前为只读权限，不能保存或启动工作流')
  }
  private planningCaller(exec: Pick<ToolRunContext,'agent'|'signal'>,modelSource:'request'|'selection'='request'): PlanningCaller {
    if(!exec.agent)throw new Error('需要当前主对话')
    const owner=workflowAgentOwner(exec.agent,this.ctx.agents)
    if(owner!==exec.agent)throw new Error('工作流规划须从主对话发起，不能递归委派')
    const caller:PlanningCaller={parent:owner,sessionId:owner.id,workspaceId:this.agentWorkspace(owner),signal:exec.signal,modelSource}
    if(modelSource==='selection')caller.modelSelection=this.planningModel(caller)
    return caller
  }
  private planningModel(caller:PlanningCaller):{provider:string;model:string;reasoningEffort?:string} {
    // A detached task keeps the initiating turn's exact model, even if the next
    // turn's picker changes. Liveness, policy and tool access are checked separately.
    if(caller.modelSource==='background'){
      if(!caller.modelSelection)throw new Error('后台规划缺少受理时冻结的模型')
      return {...caller.modelSelection}
    }
    const selected=liveSessionModelDefaults(this.ctx,caller.parent,caller.modelSource!=='selection')
    if(!selected)throw new Error('当前主对话模型尚不可确定，请先选择模型后重新规划')
    const current={...selected.model,...(selected.effort?{reasoningEffort:selected.effort}:{})}
    if(caller.modelSelection&&JSON.stringify(current)!==JSON.stringify(caller.modelSelection))throw new Error('规划模型上下文已变化，请重新规划')
    return current
  }
  private backgroundPlanningCaller(caller:PlanningCaller):PlanningCaller{
    // Freeze the selected model before the foreground request context disappears.
    const selection=this.planningModel(caller)
    return {...caller,modelSource:'background',modelSelection:selection}
  }
  private planningReader(workflowId:string,revision:number,caller:PlanningCaller):PlanningContextReader{
    const assertCurrent=()=>{
      caller.signal.throwIfAborted()
      if(this.ctx.agents.get(SessionId(caller.sessionId))!==caller.parent)throw new Error('主对话已关闭')
      const current=this.ownedFlow(workflowId,caller.parent)
      if(current.revision!==revision)throw new Error('REVISION_CONFLICT：请重新定位节点')
      this.assertPlanningCanvas(caller,workflowId,revision)
    }
    assertCurrent()
    const workflow=this.ownedFlow(workflowId,caller.parent),tools=this.catalog.list(caller.workspaceId,caller.sessionId)
    const context:PlanningContext={workflow,operation:'revise',targetNodeIds:[],
      nodeIds:allNodes(workflow).map(node=>node.id),subagentIds:(workflow.subAgents??[]).map(item=>item.id),environmentIds:(workflow.environmentVariables??[]).map(item=>item.id),
      tools,toolOutputs:buildPlanningToolOutputs(tools,{schemas:this.planningOutputSchemas(tools,caller.parent)}),model:{provider:'read-only',model:'read-only'}}
    const key=JSON.stringify([caller.workspaceId,caller.sessionId,workflowId]),options={scopeIdentity:key,cacheScope:'session-workflow' as const,assertCurrent}
    return this.cachePlanningReader(key,context,options)
  }
  private cachePlanningReader(key:string,context:PlanningContext,options:PlanningReaderOptions):PlanningContextReader{
    let reader=this.planningReaders.get(key)
    if(reader){reader.rebind(context,options);this.planningReaders.delete(key)}
    else reader=new PlanningContextReader(context,options)
    this.planningReaders.set(key,reader)
    while(this.planningReaders.size>16)this.planningReaders.delete(this.planningReaders.keys().next().value!)
    return reader
  }
  private currentPlanningTarget(caller:PlanningCaller):CurrentPlanningTarget|undefined {
    this.assertPlanningCallerCurrent(caller)
    const selected=this.planningUI.current(caller.sessionId)
    if(!selected?.workflowId)return undefined
    const flow=this.ownedFlow(selected.workflowId,caller.parent)
    if(flow.revision!==selected.revision)throw new Error('当前画布版本已变化，请刷新后重新规划')
    return {workflowId:flow.id,title:flow.title,revision:flow.revision,dirty:selected.dirty}
  }
  private assertPlanningCanvas(caller:PlanningCaller,workflowId:string,revision:number):void {
    const selected=this.planningUI.forWorkflow(caller.sessionId,workflowId)
    if(selected&&(selected.dirty||selected.revision!==revision))throw new Error('当前画布有未保存修改或版本已变化，请先保存或还原后重新规划')
  }
  private assertPlanningCallerCurrent(caller:PlanningCaller):void {
    const verified=this.planningCaller({agent:caller.parent,signal:caller.signal})
    if(verified.sessionId!==caller.sessionId||verified.workspaceId!==caller.workspaceId)throw new Error('规划权限上下文已变化')
  }
  private workflowIdTaken(id:string):boolean {
    return [...this.storage.workflows(),...this.storage.archived()].some(flow=>flow.id===id)
  }
  private planningReadOnly(agent:Agent):boolean {
    return !!agent.ctx.get('planMode')?.get(agent).active||agent.ctx.get('sandboxPolicy')?.resolve({session:agent.session}).mode==='read-only'
  }
  private trialPolicyDigest(agent:Agent):string {
    return planningDigest({plan:agent.ctx.get('planMode')?.get(agent).active??false,sandbox:agent.ctx.get('sandboxPolicy')?.resolve({session:agent.session})??null})
  }
  private authorizeTrial(trial:PlanningTrial,caller:PlanningCaller,execute:boolean):void {
    const verified=this.planningCaller({agent:caller.parent,signal:caller.signal})
    if(verified.sessionId!==trial.rootSessionId||verified.workspaceId!==trial.workspaceId)throw new Error('试做权限上下文已变化')
    if(!execute)return
    this.assertMutable(caller.parent)
    const workspaceRoot=this.ctx.workspaceRegistry.list().find(item=>item.id===caller.workspaceId)?.path
    if(workspaceRoot!==trial.workspaceRoot||this.trialPolicyDigest(caller.parent)!==trial.policyDigest)throw new Error('TRIAL_AUTHORITY_CHANGED：试做工作区或权限已改变，已停止继续动作')
    const current=this.planningModel(caller)
    if(current.provider!==trial.model.provider||current.model!==trial.model.model||current.reasoningEffort!==trial.effort)throw new Error('TRIAL_MODEL_CHANGED：试做模型上下文已改变')
    if(trial.request.targetWorkflowId&&this.workflowIdTaken(trial.request.targetWorkflowId))throw new Error('REVISION_CONFLICT：新工作流预留身份已存在，不启动试做')
  }
  private trialView(trial:PlanningTrial,caller:PlanningCaller,includeCandidates=false):string {
    const found=trial.verified?this.planner.findRequest(`trial-plan-${trial.id.slice(6)}`,caller):undefined
    const planned=found&&(!trial.planningTaskId||found.id===trial.planningTaskId)?found:undefined
    const planningUnavailable=trial.planningTaskId&&!planned?'规划任务不存在或已清理；试做回执仍保留，不自动重新执行。':undefined
    return JSON.stringify({delivery:trial.delivery,engineVersion:'0.0.2',build:'R7',taskId:trial.id,requestId:trial.request.requestId,
      state:planned?.state??trial.state,trialState:trial.state,revision:trial.revision,childId:trial.childId,
      execution:trial.execution,summarySource:'agent-claim',warnings:trial.verified?.evidence.warnings,verification:trial.verification,humanReview:trial.humanReview,diagnostics:trial.diagnostics,receiptDigest:trial.receiptDigest,
      ...(planningUnavailable?{planningTaskId:trial.planningTaskId,planningUnavailable}:{}),
      usage:trialUsageView(trial),
      ...(planned?{planningTaskId:planned.id,planning:JSON.parse(this.planningView(planned,includeCandidates))}:{}),
      instruction:trialInstruction(trial,!!planned)})
  }
  private async planningEntry(value:unknown,caller:PlanningCaller):Promise<string> {
    const parsed=parsePlanningEntry(value,this.planningReadOnly(caller.parent))
    if(parsed.execution?.mode==='execute-first'){
      const request=parsed.request,{mode:_,...trialSpec}=parsed.execution
      if(this.planningReadOnly(caller.parent)){
        const task=await this.planner.start({requestId:request.requestId,operation:'create',...(request.moduleCheck?{moduleCheck:request.moduleCheck}:{}),
          instruction:request.instruction+'\n当前仅有只读/计划权限，请根据以下任务资料设计预览，不声称试做、验收或回归已发生：'+JSON.stringify(trialSpec),
          preview:true,...(request.title?{title:request.title}:{}),...(request.targetWorkflowId?{targetWorkflowId:request.targetWorkflowId}:{})},
          this.backgroundPlanningCaller(caller),{background:true})
        const view={...JSON.parse(this.planningView(task)),executionMode:'design-only',note:'当前为只读或计划模式，仅生成设计预览，没有执行试做、业务验收或证据驱动优化。'}
        return this.observePlanningResult(JSON.stringify(view),caller)
      }
      this.assertMutable(caller.parent)
      trialSpec.tools=normalizeTrialEntryTools(caller.parent,trialSpec.tools)
      validateTrialEntryTools(caller.parent,trialSpec.tools,trialSpec.artifacts.length>0,/https?:\/\//i.test(trialSpec.task))
      const trial=await this.trials.start({requestId:request.requestId,instruction:request.instruction,spec:trialSpec,
        ...(request.moduleCheck?{moduleCheck:request.moduleCheck}:{}),...(request.title?{title:request.title}:{}),
        ...(request.targetWorkflowId?{targetWorkflowId:request.targetWorkflowId}:{}),...(request.optimizationTarget?{optimizationTarget:request.optimizationTarget}:{})},
        this.backgroundPlanningCaller(caller),{background:true})
      return this.observePlanningResult(this.trialView(trial,caller),caller)
    }
    const request=parsed.request
    if(this.planningReadOnly(caller.parent))request.preview=true
    if(request.operation==='revise'&&!request.preview)this.assertNoPendingRevision(request.requestId,request.targetWorkflowId!,request.expectedRevision!,caller)
    return this.observePlanningResult(this.planningView(await this.planner.start(request,this.backgroundPlanningCaller(caller),{background:true})),caller)
  }
  /**
   * Desktop r65 E: a second proposal on the same revision from the same chat; accepting either one makes the other
   * unacceptable, yet the main chat told the user to accept both. A retry with the same requestId is not a second one.
   */
  private assertNoPendingRevision(requestId:string,workflowId:string,revision:number,caller:PlanningCaller):void {
    const pending=new Set(this.editor.proposals(workflowId).filter(proposal=>proposal.status==='pending').map(proposal=>proposal.id))
    const earlier=this.planner.revisions(caller.sessionId,workflowId,revision).find(task=>task.request.requestId!==requestId&&(task.state!=='published'||task.receipt?.kind==='proposed'&&pending.has(task.receipt.proposalId!)))
    if(!earlier)return
    const proposalId=earlier.state==='published'?earlier.receipt?.proposalId:undefined
    throw new Error(`REVISION_PENDING：本对话已在这个工作流 v${revision} 上交过修改${proposalId?`，提案 ${proposalId} 待用户接受`:`（任务 ${earlier.id} 还在生成）`}。同一版本的提案只能接受一个：接受其中一个后，其余都会因版本变化失效，所以 Host 不再生成第二个。请如实告诉用户：先在画布上接受或拒绝${proposalId?'这个提案':'上一个提案（生成后）'}；还要别的改动时，接受后基于新版本再改，或者拒绝后把全部改动放进同一次 visible_workflow_splice 重新提交（链段外的节点用 update，target 写它的 key）。`)
  }
  private authorizePlanning(task:PlanningTask,caller:PlanningCaller,write:boolean):void {
    const verified=this.planningCaller({agent:caller.parent,signal:caller.signal})
    if(verified.sessionId!==task.sessionId||verified.workspaceId!==task.workspaceId)throw new Error('规划权限上下文已变化')
    if(task.request.source?.kind==='verified-trial')this.assertTrialSourceUnchanged(task,task.request.source.trialId,caller)
    // Preview reads reuse frozen metadata, so visibility and its exact baseline
    // must remain current even though they require no mutable permission.
    // Ordinary historical receipt/status reads retain their existing contract.
    let currentWorkflow:Workflow|undefined
    if(task.request.operation==='revise'&&(write||task.preview)){
      currentWorkflow=this.ownedFlow(task.request.targetWorkflowId!,caller.parent)
      if(currentWorkflow.revision!==task.request.expectedRevision||task.context&&planningBaselineDigest(currentWorkflow)!==planningBaselineDigest(task.context.workflow))throw new Error('REVISION_CONFLICT：工作流已变化，请重新规划')
    }
    if(!write)return
    this.assertMutable(caller.parent)
    if(currentWorkflow)this.assertPlanningCanvas(caller,currentWorkflow.id,currentWorkflow.revision)
    else if(task.context&&task.receipt?.kind!=='created'&&this.workflowIdTaken(task.context.workflow.id))throw new Error('REVISION_CONFLICT：新工作流身份已被使用')
    if(task.context)this.assertPlanningContractsCurrent(task,task.context,caller)
  }
  private assertTrialSourceUnchanged(task:PlanningTask,trialId:string,caller:PlanningCaller):void {
    const source=this.trials.resolveEvidence(trialId,caller),context=task.context
    if(context&&(planningDigest(source.trial)!==planningDigest(context.trial)||planningDigest(source.trialTask)!==planningDigest(context.trialTask)||
      planningDigest(source.trialProcedure??null)!==planningDigest(context.trialProcedure??null)||
      context.trialReport&&planningDigest(source.trialReport)!==planningDigest(context.trialReport)||
      source.conversation.digest!==context.conversation?.digest))throw new Error('试做验收来源已变化，不能继续规划或发布')
  }
  private assertPlanningContractsCurrent(task:PlanningTask,context:PlanningContext,caller:PlanningCaller):void {
    const current=this.planningModel(caller)
    if(current.provider!==context.model.provider||current.model!==context.model.model||current.reasoningEffort!==context.effort)throw new Error('规划模型上下文已变化，请重新规划')
    const currentTools=this.catalog.list(caller.workspaceId,caller.sessionId)
    const used=task.candidate?allNodes(task.candidate).flatMap(node=>nodeToolIds(node)):[]
    for(const id of new Set(used)){
      const before=context.tools.find(tool=>tool.id===id)?.operationContract
      if(before&&operationDigest(before)!==operationDigest(currentTools.find(tool=>tool.id===id)?.operationContract??null))throw new Error(`TOOL_OPERATION_CONTRACT_CONFLICT：工具操作来源或版本已变化：${id}；请重新规划`)
    }
    if(context.toolOutputs)assertPlanningToolOutputsUnchanged(context.toolOutputs,currentTools,used,this.planningOutputSchemas(currentTools,caller.parent))
    if(task.compilerMode==='template-fill'&&task.templateBinding&&task.candidate)assertTemplateBindingCurrent(task.templateBinding,task.candidate,context,currentTools)
    if(task.candidate){
      const fresh=new Map(currentTools.map(tool=>[tool.id,tool]))
      for(const id of new Set(used)){
        const before=context.tools.find(tool=>tool.id===id),after=fresh.get(id)
        if(before&&after&&planningDigest(before.inputSchema)!==planningDigest(after.inputSchema))throw new Error('TOOL_CATALOG_CONFLICT：工具参数定义已变化，请重新规划')
      }
    }
  }
  private async planningContext(request:PlanningRequest,caller:PlanningCaller):Promise<PlanningContext>{
    // History is selected by the live root's identity, never by a model-supplied
    // session id. The generic planning route uses this same guarded collector.
    let conversation:PlanningContext['conversation']
    let trial:PlanningContext['trial']
    let trialTask:PlanningContext['trialTask'],trialReport:PlanningContext['trialReport'],trialProcedure:unknown
    if(request.source?.kind==='verified-trial')({conversation,trial,trialTask,trialReport,trialProcedure}=this.trials.resolveEvidence(request.source.trialId,caller))
    else if(request.source){
      const query=(this.ctx as unknown as {get(name:string):unknown}).get('sessionQuery') as ConversationQuery|undefined
      if(!query||typeof query.observeSession!=='function')throw new Error('CONVERSATION_QUERY_UNAVAILABLE：宿主未提供当前会话历史读取能力，暂不能从本次任务生成工作流')
      const guardedQuery:ConversationQuery={observeSession:async(id,options)=>{
        const observation=await query.observeSession(id,options)
        try{
          // Revalidate before the lazy events getter materializes any history.
          this.assertPlanningCallerCurrent(caller)
          caller.signal.throwIfAborted()
          return observation
        }catch(error){observation[Symbol.dispose]();throw error}
      }}
      conversation=await collectConversationEvidence(guardedQuery,{sessionId:caller.sessionId,source:request.source,signal:caller.signal})
      this.assertPlanningCallerCurrent(caller)
      caller.signal.throwIfAborted()
    }
    const current=this.planningModel(caller)
    if(!current.provider||!current.model)throw new Error('当前主 Agent 模型尚不可确定，请先选择模型')
    const model={provider:current.provider,model:current.model}
    if(!request.handoff||request.handoff.mode==='partial')await this.ctx.llm.resolveModelInfo(model.provider,model.model,caller.signal)
    const workflow=this.planningBaseline(request,caller)
    const nodes=allNodes(workflow),targetNodeIds=request.targetNodeIds??[]
    if(targetNodeIds.some(id=>!nodes.some(node=>node.id===id)))throw new Error('目标节点已变化，请重新选择节点')
    caller.signal.throwIfAborted()
    this.assertPlanningCallerCurrent(caller)
    const pool=(ids:string[],count:number,maximum:number)=>[...ids,...Array.from({length:Math.max(0,Math.min(count,maximum-ids.length))},()=>randomUUID())]
    const tools=structuredClone(this.catalog.list(caller.workspaceId,caller.sessionId))
    const toolOutputs=buildPlanningToolOutputs(tools,{schemas:this.planningOutputSchemas(tools,caller.parent),conversation})
    return {workflow,operation:request.operation,targetNodeIds,
      nodeIds:pool(nodes.map(node=>node.id),60,500),subagentIds:pool((workflow.subAgents??[]).map(item=>item.id),20,500),environmentIds:pool((workflow.environmentVariables??[]).map(item=>item.id),20,200),
      tools,toolOutputs,model,...(current.reasoningEffort?{effort:current.reasoningEffort}:{}),...(conversation?{conversation}:{}),
      ...(trial?{trial,trialTask,trialReport,...(trialProcedure!==undefined?{trialProcedure}:{})}:{})}
  }
  private planningBaseline(request:PlanningRequest,caller:PlanningCaller):Workflow {
    if(request.operation==='revise'){
      const workflow=structuredClone(this.ownedFlow(request.targetWorkflowId!,caller.parent))
      if(workflow.revision!==request.expectedRevision)throw new Error('REVISION_CONFLICT：请读取工作流最新版本')
      this.assertPlanningCanvas(caller,workflow.id,workflow.revision)
      // Keep the exact stored baseline frozen for revision/digest checks.
      return workflow
    }
    const workflow=makeWorkflow(caller.workspaceId,'Agent 生成的工作流')
    if(request.targetWorkflowId)workflow.id=request.targetWorkflowId
    if(this.workflowIdTaken(workflow.id))throw new Error('REVISION_CONFLICT：新工作流身份已存在')
    return workflow
  }
  private planningOutputSchemas(tools:readonly ToolChoice[],agent:Agent):TrustedToolOutputSchema[]{
    return tools.flatMap(tool=>{
      if(!tool.available||!tool.id.startsWith('native:'))return []
      const name=tool.id.slice(7),schema=this.ctx.tools.get(name,agent)?.output?.schema
      return schema?[{toolId:tool.id,sourceId:`native-tool:${name}`,version:'sdk-canonical-output-v1',valuePath:'value' as const,schema:{...schema}}]:[]
    })
  }
  private planningWorkspaceRevisions(workspaceId:string):Record<string,number> {
    return Object.fromEntries([...this.storage.visibleWorkflows(workspaceId),...this.storage.archived().filter(flow=>flow.workspaceId===workspaceId||workflowScope(flow)==='global')].map(flow=>[flow.id,flow.revision]))
  }
  private firstRunView(task:PlanningTask):unknown{
    if(!task.firstRun)return undefined
    if(!task.firstRun.runId)return task.firstRun
    try{
      const run=this.storage.run(task.firstRun.runId)
      if(run.workspaceId!==task.workspaceId||run.workflowId!==task.receipt?.workflowId)throw new Error('首次运行归属不一致')
      return {...task.firstRun,run:firstRunRunView(run)}
    }catch{return {...task.firstRun,unavailable:'运行记录不存在或已清理；不自动重跑。'}}
  }
  private async runCreatedTrial(task:PlanningTask,caller:PlanningCaller,started:(runId:string)=>void):Promise<void>{
    if(task.receipt?.kind!=='created'||!runsOnceAfterSave(task.request)||!task.firstRun)throw new Error('仅试做或模块直建的新建回执可以发起首次运行')
    this.assertMutable(caller.parent);caller.signal.throwIfAborted()
    // T30.2: generation holds nothing; the first run holds the workspace while it runs.
    const release=await this.trials.holdFirstRun(caller.workspaceId,caller.sessionId,caller.signal)
    try{await this.startFirstRun(task,caller,started)}finally{release()}
  }
  private async startFirstRun(task:PlanningTask,caller:PlanningCaller,started:(runId:string)=>void):Promise<void>{
    if(task.receipt?.kind!=='created'||!task.firstRun)throw new Error('仅试做新建回执可以发起首次运行')
    const id=task.receipt.workflowId,inputs={},requestId=task.firstRun.requestId,requestParameters={operation:'start',id,inputs}
    let run=this.runtime.requestRun(requestId,caller.workspaceId,caller.sessionId,requestParameters)
    if(!run){
      let flow=workflowForExecution(this.ownedFlow(id,caller.parent),caller.workspaceId)
      if(flow.revision!==task.receipt.revision)throw new Error('新图版本已改变，未启动首次运行')
      flow=this.bindSavedSubagents(flow,caller.sessionId)
      assertWorkflowReady(await this.readinessFor(flow,caller.sessionId))
      const current=this.planningModel(caller),defaults=this.needsModelDefaults(flow)?{model:{provider:current.provider,model:current.model},effort:current.reasoningEffort,source:'session' as const}:undefined
      caller.signal.throwIfAborted();this.authorizePlanning(task,caller,true)
      if(this.ownedFlow(id,caller.parent).revision!==flow.revision)throw new Error('首次运行前工作流版本已改变')
      run=this.runtime.start(id,inputs,defaults,{requestId,requestParameters,sourceGraph:flow,sessionId:caller.sessionId,repairAuthorization:{source:'agent-tool'},freezeTools:flows=>this.freezeTools(flows,caller.sessionId)})
      this.bindRun(run.id,{agent:caller.parent,ancestors:[id]})
    }
    const runId=run.id
    const cancel=()=>{void this.runtime.cancel(runId).catch(()=>{})}
    caller.signal.addEventListener('abort',cancel,{once:true})
    try{started(runId);if(caller.signal.aborted)cancel();await this.runtime.settle(runId)}catch(error){await this.runtime.cancel(runId);throw error}finally{caller.signal.removeEventListener('abort',cancel)}
  }
  /** T37: one call gives the main chat the target, the real data around it and a bound chain. */
  private async locateRevision(workflow:string,request:string,exec:Pick<ToolRunContext,'agent'|'signal'>){
    const caller=this.planningCaller(exec),ref=workflow.trim().replace(/^@/,''),flows=this.storage.visibleWorkflows(caller.workspaceId)
    const byId=flows.filter(flow=>flow.id===ref),byTitle=byId.length?byId:flows.filter(flow=>flow.title.trim()===ref)
    const found=byTitle.length?byTitle:flows.filter(flow=>ref&&(flow.title.includes(ref)||ref.includes(flow.title.trim())))
    if(found.length!==1)return {state:found.length?'ambiguous':'not-found',candidates:found.map(flow=>({id:flow.id,title:flow.title,revision:flow.revision})),
      instruction:found.length?'有多个工作流对得上，请用户选一个，再用它的 ID 调用':'没有对得上的工作流；用 visible_workflow_list 让用户选'}
    const flow=this.ownedFlow(found[0]!.id,caller.parent),reader=this.planningReader(flow.id,flow.revision,caller)
    const quotes=requestQuotes(request,flow.title),targets=matchTargets(flow,request,quotes),refs=planningNodeRefs(flow)
    const key=(id:string)=>{const value=refs.get(id);return value?'n'+value.slice(1):id}
    let run=latestRunFor(this.storage.runs(caller.workspaceId),flow),ranNow:{runId?:string;note:string}|undefined
    if(!run){ranNow=await this.locateRun(flow.id,exec);run=latestRunFor(this.storage.runs(caller.workspaceId),flow)}
    const results=run?runResults(run):new Map<string,Record<string,JsonValue>>(),nodes=new Map(allNodes(flow).map(node=>[node.id,node]))
    const sampled=[...new Set(targets.flatMap(({node})=>[...dataSources(flow,node),node.id]))]
    const samples=sampled.map(id=>({nodeId:id,key:key(id),title:nodes.get(id)!.title,kind:nodes.get(id)!.kind,...(results.has(id)?{output:sampleValue(results.get(id))}:{output:null,note:'这次运行没有它的结果'})}))
    const anchor=targets.find(({node})=>flow.nodes.some(item=>item.id===node.id))?.node.id
    let chain:{chainNodes:{alias:string;nodeId:string}[]}&Record<string,unknown>|undefined,chainError:string|undefined
    // Desktop r62/r63 E: copying the binding back went wrong in a new way each time; the Host keeps it and the main chat sends operations.
    if(anchor)try{
      const {nodes:chainNodes,templateCatalog,rules:chainRules,draftRevision:_,...binding}=reader.chain({anchorNodeId:anchor},flow.revision,['code']) as ReturnType<PlanningContextReader['chain']>&{templateCatalog?:{templates:unknown[]}}
      const located=JSON.stringify([caller.sessionId,flow.id])
      this.locatedChains.delete(located);this.locatedChains.set(located,{revision:flow.revision,binding})
      while(this.locatedChains.size>32)this.locatedChains.delete(this.locatedChains.keys().next().value!)
      chain={chainNodes,chainRules,...(templateCatalog?{codeTemplate:templateCatalog.templates[0]}:{})}
    }catch(error){chainError=error instanceof Error?error.message:String(error)}
    const aliasOf=(id:string)=>{const alias=chain?.chainNodes.find(item=>item.nodeId===id)?.alias;return alias?{alias}:{}}
    return {
      workflow:{id:flow.id,title:flow.title,revision:flow.revision},quotes,
      targets:targets.map(({node,matched})=>({nodeId:node.id,key:key(node.id),title:node.title,kind:node.kind,matched,...aliasOf(node.id)})),
      ...(targets.length?{nodes:reader.read({nodeIds:targets.map(({node})=>node.id),expectedRevision:flow.revision,selection:{targetNodeIds:targets.map(({node})=>node.id)}})}
        :{outline:allNodes(flow).map(node=>({nodeId:node.id,key:key(node.id),title:node.title,kind:node.kind}))}),
      run:run?{runId:run.id,status:run.status,startedAt:run.startedAt,revision:run.sourceRevision,ranNow:!!ranNow?.runId}:null,...(ranNow?{runNote:ranNow.note}:{}),
      samples,...chain,...(chainError?{chainError}:{}),
      next:targets.length
        ?'值里引用节点用 key（如 {{n5.result}}）。上游样例里已有的字段直接 update 目标；样例里没有的字段，在目标前 insert 一个 code 节点（inputs 引用上游数组，返回 {rows: 每行加新字段}，outputSchema 写 rows，key 用描述性名字），再 update 目标改读新 key。visible_workflow_splice 的 chain 只写 {operations:[…]}（draftRevision 从 0 起，target 用 chainNodes 的别名），基线、锚点等绑定字段由 Host 按这次定位补齐；targets 里没有 alias 的目标在链段外，要改就在同一次 splice 里 update，target 写它的 key；一个需求只交一个提案。Host 先用这次运行的真实数据回放改动的节点，结果随返回。'
        :'原话里没有对上节点的文字：从 outline 选目标，用 visible_workflow_nodes 读取、visible_workflow_chain 取链段。',
    }
  }
  /** User decision 2026-10-30: a workflow with no run record is run once, so the locate pack can show real data. */
  private async locateRun(id:string,exec:Pick<ToolRunContext,'agent'|'signal'>):Promise<{runId?:string;note:string}>{
    const agent=exec.agent!;this.assertMutable(agent)
    const owner=workflowAgentOwner(agent,this.ctx.agents),workspaceId=this.agentWorkspace(agent)
    let flow=workflowForExecution(this.ownedFlow(id,agent),workspaceId)
    const required=(flow.nodes.find(node=>node.kind==='input')?.config.fields??[]).filter(field=>field.required).map(field=>field.name)
    if(required.length)return {note:'没有运行记录；工作流需要输入（'+required.join('、')+'），Host 没有替用户执行，样例为空'}
    const requestId=`locate-${id}-${flow.revision}`,requestParameters={operation:'start',id,inputs:{}}
    let run=this.runtime.requestRun(requestId,workspaceId,owner.id,requestParameters)
    if(!run){
      flow=this.bindSavedSubagents(flow,owner.id)
      assertWorkflowReady(await this.readinessFor(flow,owner.id))
      const defaults=this.needsModelDefaults(flow)?await resolveHarnessModelDefaults(this.ctx,flow.workspaceId,agent.id,agent,true):undefined
      exec.signal.throwIfAborted();this.assertMutable(agent)
      if(this.ownedFlow(id,agent).revision!==flow.revision)throw new Error('工作流版本已变化，请重新定位')
      run=this.runtime.start(id,{},defaults,{requestId,requestParameters,sourceGraph:flow,sessionId:owner.id,repairAuthorization:{source:'agent-tool'},freezeTools:flows=>this.freezeTools(flows,agent.id)})
      this.bindRun(run.id,{agent,ancestors:[id]})
    }
    const runId=run.id
    let timer:ReturnType<typeof setTimeout>|undefined,stop:(()=>void)|undefined
    const settled=await Promise.race([
      this.runtime.settle(runId).then(()=>true),
      new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),LOCATE_RUN_WAIT_MS);stop=()=>resolve(false);exec.signal.addEventListener('abort',stop,{once:true})}),
    ]).finally(()=>{clearTimeout(timer);if(stop)exec.signal.removeEventListener('abort',stop)})
    exec.signal.throwIfAborted()
    const status=this.storage.run(runId).status
    return {runId,note:settled?`没有运行记录，Host 已执行一次（${status}）`:`没有运行记录，Host 已开始执行，${LOCATE_RUN_WAIT_MS/1000} 秒内未结束，样例只含已完成的节点`}
  }
  /** T37: compile a decided chain here and rerun its changed nodes on the newest run; undefined when there is nothing to replay. */
  private async replayChain(workflowId:string,revision:number,chain:unknown,caller:PlanningCaller):Promise<{runId:string;steps:WorkflowReplayStep[]}|undefined>{
    let context:PlanningContext,candidate:Workflow|undefined
    try{
      // The read-only context holds only used IDs; new nodes need fresh ones, as in the planning entry.
      const read=this.planningReader(workflowId,revision,caller).snapshot(revision),fresh=(ids:string[],count:number)=>[...ids,...Array.from({length:count},()=>randomUUID())]
      context={...read,nodeIds:fresh(read.nodeIds,60),subagentIds:fresh(read.subagentIds,20),environmentIds:fresh(read.environmentIds,20)}
      const result=compilePlanningChain(chain,context)
      if(result.issues.length)return undefined
      candidate=result.candidate
    }catch{return undefined} // The planning entry reports the same problem.
    if(!candidate)return undefined
    const source=latestRunFor(this.storage.runs(caller.workspaceId),context.workflow),changed=changedNodeIds(context.workflow,candidate)
    if(!source||!changed.size)return undefined
    return {runId:source.id,steps:await this.runtime.replay(source,workflowForExecution(candidate,caller.workspaceId),changed,caller.signal)}
  }
  private planningView(task:PlanningTask,includeCandidates=false,includeMetrics=false):string {
    this.planningUI.record(task)
    const evidence=task.context?.conversation
    const report=task.optimization
    const verification=moduleVerificationReceipt(task)??designVerificationReceipt(task),workspaceChanges=workspaceChangeVerification(task)
    const optimization=planningOptimizationView(report,includeCandidates)
    const views={input:this.planner.inputState(task),firstRun:this.firstRunView(task),evidence,optimization,verification,workspaceChanges}
    return JSON.stringify(planningTaskView(task,views,includeCandidates,includeMetrics))
  }
  private observePlanningResult(value:string,caller:PlanningCaller):string {
    const view=JSON.parse(value) as PlanningJoinView
    if(typeof view.taskId==='string'&&Number.isSafeInteger(view.revision))this.planningJoin.observe(caller.parent,caller.workspaceId,view)
    return value
  }
  private joinCaller(agent:Agent,signal:AbortSignal,workspaceId:string):PlanningCaller {
    signal.throwIfAborted()
    if(this.ctx.agents.get(agent.id)!==agent)throw new Error('规划等待的主对话已关闭或变化')
    const caller=this.planningCaller({agent,signal})
    if(caller.workspaceId!==workspaceId)throw new Error('规划等待的工作区已变化')
    return caller
  }
  private readPlanningJoin(id:string,caller:PlanningCaller):PlanningJoinView {
    this.joinCaller(caller.parent,caller.signal,caller.workspaceId)
    if(id.startsWith('trial-')){
      const view=JSON.parse(this.trialView(this.trials.get(id,caller),caller)) as PlanningJoinView
      return view.planning?{...view,preview:view.planning.preview,joinActive:this.planner.isActive(view.planning.taskId,caller)}:view
    }
    const task=this.planner.get(id,caller)
    if(task.commandIntake?.linkedTaskId){
      const linked=this.readPlanningJoin(task.commandIntake.linkedTaskId,caller)
      return {...linked,taskId:id,commandTaskId:id,linkedTaskId:linked.taskId} as PlanningJoinView
    }
    return {...JSON.parse(this.planningView(task)),events:task.events,joinActive:this.planner.isActive(id,caller)} as PlanningJoinView
  }
  private commandActionTask(id:string,caller:PlanningCaller):string {
    if(id.startsWith('trial-'))return id
    return this.planner.get(id,caller).commandIntake?.linkedTaskId??id
  }
  private async cancelPlanningTask(id:string,caller:PlanningCaller):Promise<string>{
    // Drain an in-flight intake before reading its link, closing the admission/cancel race.
    if(!id.startsWith('trial-')&&this.planner.get(id,caller).commandIntake&&this.planner.isActive(id,caller))await this.planner.cancel(id,caller)
    const actionId=this.commandActionTask(id,caller)
    if(!actionId.startsWith('trial-'))return this.planningView(await this.planner.cancel(actionId,caller))
    const trial=await this.trials.cancel(actionId,caller)
    const linked=trial.planningTaskId?this.planner.get(trial.planningTaskId,caller):this.planner.findRequest(`trial-plan-${trial.id.slice(6)}`,caller)
    if(linked&&!['published','cancelled'].includes(linked.state))await this.planner.cancel(linked.id,caller)
    return this.trialView(trial,caller)
  }
  private async waitPlanningTask(id:string,caller:PlanningCaller,waitMs:number):Promise<PlanningJoinView> {
    if(!Number.isSafeInteger(waitMs)||waitMs<0||waitMs>60_000)throw new Error('规划任务等待时间须为0至60000毫秒')
    // Capture the cursor before reading the task. A racing state transition is
    // then either visible in that read or wakes the subsequent subscription.
    let journal=this.planningUI.updates(caller.workspaceId,caller.sessionId,0)
    const until=Date.now()+waitMs
    while(true){
      const view=this.readPlanningJoin(id,caller)
      if(planningJoinDisposition(view)||Date.now()>=until)return view
      journal=await this.planningUI.waitUpdates(caller.workspaceId,caller.sessionId,journal.cursor,journal.epoch,Math.min(20_000,Math.max(0,until-Date.now())),caller.signal)
    }
  }
  private ownedFlow(id: string, agent: Agent): Workflow {
    const flow = this.storage.get(id)
    if (!workflowVisibleInWorkspace(flow,this.agentWorkspace(agent))) throw new Error('只能操作当前对话工作区或全局范围的工作流')
    return flow
  }
  private executionWorkspace(flow:Workflow,sessionId?:string):string {
    if(workflowScope(flow)!=='global'||!sessionId)return flow.workspaceId
    const agent=this.ctx.agents?.get(SessionId(sessionId))
    if(agent)return this.agentWorkspace(agent)
    const matches=this.ctx.workspaceRegistry.list().filter(workspace=>workspace.sessionIds.includes(SessionId(sessionId)))
    if(matches.length!==1)throw new Error('当前对话的工作区不可确定，请重新打开工作区对话后运行全局工作流')
    return matches[0]!.id
  }
  private sessionAgent(workspaceId:string,sessionId?:string):Agent|undefined {
    if(!sessionId)return undefined
    const agent=this.ctx.agents?.get(SessionId(sessionId))
    // An opened conversation may not have initialized an Agent yet. Independent nodes do not need one.
    if(!agent)return undefined
    // Full-page workflows can belong to another workspace than the visible chat.
    // Never borrow its permissions; native tools are preflighted separately.
    try {if(this.agentWorkspace(agent)!==workspaceId)return undefined}catch{return undefined}
    return agent
  }
  private requiresNativeContext(flow:Workflow,seen=new Set<string>()):boolean {
    if(seen.has(flow.id))return false
    seen.add(flow.id)
    for(const node of allNodes(flow)){
      const ids=nodeToolRefs(node)
      if(toolModeNode(node)&&ids.some(id=>id.startsWith('native:')))return true
      for(const id of ids.filter(id=>id.startsWith('workflow:'))){
        const nested=workflowForExecution(this.storage.get(id.slice(9)),flow.workspaceId)
        if(this.requiresNativeContext(nested,seen))return true
      }
    }
    return false
  }
  private needsModelDefaults(flow: Workflow, seen = new Set<string>()): boolean {
    if (seen.has(flow.id)) return false
    seen.add(flow.id)
    for (const node of allNodes(flow)) {
      if (isModelNode(node) && (!node.config.model || node.config.effort === undefined)) return true
      const tools = nodeToolRefs(node)
      for (const id of tools.filter(id => id.startsWith('workflow:'))) {
        const child = workflowForExecution(this.storage.get(id.slice(9)),flow.workspaceId)
        if (this.needsModelDefaults(child, seen)) return true
      }
    }
    return false
  }
  private freezeTools(flows:Workflow[],sessionId?:string):Record<string,string>{
    const ids=[...new Set(flows.flatMap(flow=>allNodes(flow).flatMap(node=>nodeToolIds(node))))]
    return this.catalog.constraints(flows[0]!.workspaceId,ids,sessionId)
  }
  private nativeTools(workspaceId:string,sessionId?:string):ToolChoice[] {
    let agent:Agent|undefined
    try{agent=this.sessionAgent(workspaceId,sessionId)}catch{return []}
    if(!agent)return []
    const bound=agent
    return this.ctx.tools.schemas(bound).filter(t=>t.name!=='run_code'&&!t.name.startsWith('visible_workflow_')&&!isWorkflowSessionTool(t.name)).map(t=>this.nativeToolChoice(t,bound))
  }
  private nativeToolChoice(t:NativeToolSchema,agent:Agent):ToolChoice {
    const mcp=t.name.startsWith('mcp__'),provider=mcp?t.name.split('__')[1]??'MCP':'harness'
    return {id:`native:${t.name}`,name:t.name,description:t.description,providerId:`native:${provider}`,providerName:mcp?provider:'Harness 已注册工具',category:mcp?'mcp':'plugin',
      inputSchema:JSON.parse(JSON.stringify(t.parameters)) as Record<string,JsonValue>,available:true,operationContract:registeredToolOperation(`native:${t.name}`,this.ctx.tools.get(t.name,agent))}
  }
  private async executeNative(name:string,args:Record<string,JsonValue>,request:AdapterRequest):Promise<Record<string,JsonValue>> {
    const binding=this.runContexts.get(request.runId)
    if(!binding?.agent)throw new Error('宿主工具需要有效对话权限；请打开当前工作区对话后执行工作流')
    const {agent,exec}=binding
    if(this.ctx.agents.get(agent.id)!==agent)throw new Error('对话权限上下文已结束，请重新打开当前工作区对话后运行')
    if(this.agentWorkspace(agent)!==request.workspaceId)throw new Error('对话已切换工作区，不能继续调用工具')
    this.assertMutable(agent)
    if(name.startsWith('visible_workflow_')||!this.ctx.tools.get(name,agent))throw new Error('此工具不在当前对话可用范围内')
    const callId=ToolCallId(randomUUID())
    // A call can finish after its run turned terminal (cancel); release again then.
    const result=await this.observations.dispatch(request.runId,callId,()=>this.ctx.tools.execute({name,arguments:args,agent,signal:request.signal,callId,...(exec&&!exec.signal.aborted?{parent:exec.token,rootCallId:exec.rootCallId}:{})}))
      .finally(()=>{try{if(!LIVE_RUN_STATUSES.includes(this.storage.run(request.runId).status))this.observations.release(request.runId)}catch{}})
    if(result.isError)throw new Error(`工具调用失败：${result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')}`)
    return {text:typeof result.value==='string'?result.value:JSON.stringify(result.value),value:result.value}
  }
  private releaseRun(id:string):void{this.runContexts.delete(id);this.observations.release(id)}
  /** Bind a freshly started run; one already terminal at return has no later transition to release it. */
  private bindRun(id:string,binding:{agent?:Agent;ancestors:string[]}):void{this.runContexts.set(id,binding);if(!LIVE_RUN_STATUSES.includes(this.storage.run(id).status))this.releaseRun(id)}
  private async runNested(id:string,args:Record<string,JsonValue>,request:AdapterRequest):Promise<Record<string,JsonValue>> {
    const parent=this.storage.run(request.runId),flow=parent.dependencySnapshots?.[id],binding=this.runContexts.get(request.runId),ancestors=binding?.ancestors??[parent.workflowId]
    if(!flow)throw new Error('运行快照缺少子工作流，不能回退到最新定义')
    if(flow.workspaceId!==request.workspaceId)throw new Error('不能执行其他工作区的工作流')
    if(allNodes(flow).some(n=>n.kind==='human'))throw new Error('包含人工介入的工作流须独立运行，目前不能作为子工作流工具')
    if(ancestors.includes(id)||ancestors.length>=8)throw new Error('工作流递归调用或超过 8 层限制')
    const fields=flow.nodes.find(n=>n.kind==='input')?.config.fields??[]
    if(fields.some(f=>f.required&&args[f.name]===undefined&&f.defaultValue===undefined))throw new Error('子工作流缺少必填输入，请在工具参数中补齐')
    const inputs=Object.fromEntries(Object.entries(args).map(([k,v])=>[k,typeof v==='string'?v:JSON.stringify(v)]))
    const run=request.childRunId?this.runtime.resume(request.childRunId):this.runtime.start(id,inputs,parent.modelDefaults,{sourceGraph:flow,toolConstraints:parent.toolConstraints,sessionId:runSessionId(parent),
      rolePrompts:parent.dependencyRolePrompts?.[id]??{},dependencySnapshots:parent.dependencySnapshots??{},dependencyRolePrompts:parent.dependencyRolePrompts??{},rootRunId:parent.rootRunId??parent.id})
    request.onChild?.(run.id)
    this.runContexts.set(run.id,{...binding,ancestors:[...ancestors,id]})
    const abort=()=>{void this.runtime.cancel(run.id).catch(()=>{})};request.signal.addEventListener('abort',abort,{once:true})
    try {
      if(request.signal.aborted)abort()
      const done=await this.runtime.settle(run.id)
      if(done.status==='waiting'){await this.runtime.cancel(done.id);throw new Error('子工作流需要人工输入，请单独运行并处理询问框')}
      if(done.status==='paused')throw new HumanPause()
      if(done.status!=='success')throw new Error(done.error??`子工作流 ${done.status}`)
      return {text:JSON.stringify(done.outputs),outputs:done.outputs,run_id:done.id}
    }
    finally{request.signal.removeEventListener('abort',abort);if(!['paused','budget_waiting'].includes(this.storage.run(run.id).status))this.releaseRun(run.id)}
  }
  private async agentSave(raw: unknown, revision: number, agent: Agent, signal: AbortSignal, commit?:PlanningCommit, beforeCommit?:()=>void,
    planningModel?:{provider:string;model:string;reasoningEffort?:string},afterCommit?:()=>void): Promise<Workflow|WorkflowProposal> {
    signal.throwIfAborted()
    this.assertMutable(agent)
    const workspaceId = this.agentWorkspace(agent), flow = parseWorkflow(raw)
    const previous = revision ? this.ownedFlow(flow.id, agent) : undefined
    if (flow.workspaceId !== (previous?.workspaceId??workspaceId)) throw new Error('不能变更工作流所属工作区；新流程须使用当前对话工作区')
    if(flow.scope!==undefined&&workflowScope(flow)!==workflowScope(previous??{}))throw new Error('请在工作流管理菜单中显式修改作用范围，Agent 不能修改范围')
    if(previous?.scope!==undefined)flow.scope=previous.scope
    if (revision === 0 && this.workflowIdTaken(flow.id)) throw new Error('工作流已存在，请读取最新版本后提交修改，不得以新流程覆盖。')
    retainReviewedSettings(flow,previous)
    const owner=workflowAgentOwner(agent,this.ctx.agents)
    bindAgentSubagents(flow,previous,owner.id)
    const current = planningModel ?? agent.session.requestHeader()?.config ?? agent.options
    for (const node of allNodes(flow).filter(isModelNode)) {
      const prior = previous && allNodes(previous).find(n => n.id === node.id)
      if (prior && JSON.stringify(prior.config) === JSON.stringify(node.config)) continue
      const model = applyNodeModelDefaults(node, prior, current)
      const info = await this.ctx.llm.resolveModelInfo(model.provider, model.model, signal)
      if (node.config.effort && !info.reasoning?.efforts.some(e => e.id === node.config.effort)) throw new Error('此节点的思考强度不受模型支持')
    }
    signal.throwIfAborted(); this.assertMutable(agent)
    if (this.agentWorkspace(agent) !== workspaceId) throw new Error('当前对话工作区已变化，请重新读取工作流')
    if (workflowAgentOwner(agent,this.ctx.agents)!==owner) throw new Error('当前主对话已变化，请重新读取工作流')
    // Recheck the exact planning owner after model awaits; no await may
    // intervene between this check and the atomic graph/proposal write.
    beforeCommit?.()
    const saved=previous?this.editor.propose(flow,revision,commit):this.storage.save(flow, revision, 'agent',commit)
    // Capture publication-time workspace facts synchronously with the commit,
    // before any other async task can change a workflow.
    afterCommit?.()
    return saved
  }
  /** @param sessionId - Native conversation identity. @param contextJson - Untrusted selected-canvas hint; never permission. */
  @Remote('setPlanningContext') async setPlanningContext(sessionId:string,contextJson:string):Promise<void>{
    try{this.planningUI.set(sessionId,readJSON(contextJson,4_000))}catch(e){throw failure(e)}
  }
  /** @param sessionId - Native root conversation identity. @param afterSequence - Last consumed journal cursor. @param epoch - Last consumed Host journal identity. @param waitMs - Optional event wait, 0 to 20000 ms; defaults to immediate compatibility. @returns Real progress and published receipts for this live root and workspace. */
  @Remote('planningUpdates') async planningUpdates(sessionId:string,afterSequence:number,epoch:string,waitMs?:number):Promise<string>{
    try{
      const agent=this.ctx.agents.get(SessionId(sessionId))
      if(!agent)return JSON.stringify({epoch:'unavailable',cursor:0,items:[]})
      // This resident poll runs in every conversation. A root conversation whose
      // workspace is not (yet) resolvable is a normal state: no data, no error banner.
      if(workflowAgentOwner(agent,this.ctx.agents)===agent){try{this.agentWorkspace(agent)}catch{return JSON.stringify({epoch:'unavailable',cursor:0,items:[]})}}
      const caller=this.planningCaller({agent,signal:new AbortController().signal})
      const result=await this.planningUI.waitUpdates(caller.workspaceId,caller.sessionId,afterSequence,epoch,waitMs)
      // Waiting may outlive the root or its workspace ownership. Never deliver a stale owner's data.
      if(this.ctx.agents.get(SessionId(sessionId))!==agent)throw new Error('当前主对话已关闭或变化')
      const current=this.planningCaller({agent,signal:new AbortController().signal})
      if(current.parent!==caller.parent||current.workspaceId!==caller.workspaceId||current.sessionId!==caller.sessionId)throw new Error('当前主对话或工作区已变化')
      return JSON.stringify(result)
    }catch(e){throw failure(e)}
  }
  /** @param sessionId - Live root conversation. @param taskId - Planning task owned by that root. */
  @Remote('cancelPlanning') async cancelPlanning(sessionId:string,taskId:string):Promise<string>{
    try{
      const agent=this.ctx.agents.get(SessionId(sessionId))
      if(!agent)throw new Error('当前主对话已关闭')
      const caller=this.planningCaller({agent,signal:new AbortController().signal})
      return await this.cancelPlanningTask(taskId,caller)
    }catch(e){throw failure(e)}
  }
  /** @param workspaceId - Empty means all registered workspaces. @returns Library snapshot JSON. */
  @Remote('list')
  async list(workspaceId: string): Promise<string> {
    try {
      if (workspaceId) this.workspace(workspaceId)
      const value: LibrarySnapshot = { workflows: this.storage.workflows(workspaceId), presets: this.storage.presets(), runs: this.storage.runs(workspaceId),
        workspaces: this.ctx.workspaceRegistry.list().map(w => ({ id: w.id, name: w.title, directory: w.path })) }
      return JSON.stringify(value)
    } catch(e) { throw failure(e) }
  }
  /** @param workspaceId - Workspace identity. @param sessionId - Optional conversation permission scope. @returns Actual tool catalog JSON. */
  @Remote('tools') async tools(workspaceId:string,sessionId:string):Promise<string> {try{if(workspaceId)this.workspace(workspaceId);return JSON.stringify(this.catalog.list(workspaceId,sessionId))}catch(e){throw failure(e)}}
  /** @param workspaceId - Workspace identity. @param definitionJson - OpenAPI 3 or Swagger 2 document. @returns Imported operations JSON. */
  @Remote('importSwagger') async importSwagger(workspaceId:string,definitionJson:string):Promise<string>{try{this.workspace(workspaceId);return JSON.stringify(this.catalog.importSwagger(workspaceId,definitionJson))}catch(e){throw failure(e)}}
  /** @param id - Workflow identity. @returns Workflow JSON. */
  @Remote('get') async get(id: string): Promise<string> { try { return JSON.stringify(this.storage.get(id)) } catch(e) { throw failure(e) } }
  /** @param json - Complete workflow draft. @param expectedRevision - Revision seen by the editor. @returns Saved workflow JSON. */
  @Remote('save') async save(json: string, expectedRevision: number): Promise<string> {
    try { const flow = parseWorkflow(readJSON(json,WORKFLOW_PACKAGE_MAX_BYTES)); this.workspace(flow.workspaceId); return JSON.stringify(this.storage.save(flow, expectedRevision)) } catch(e) { throw failure(e) }
  }
  /** @param id - Workflow identity. @param expectedRevision - Revision seen by the editor. */
  @Remote('deleteWorkflow') async deleteWorkflow(id: string, expectedRevision: number): Promise<void> { try { this.storage.remove(id, expectedRevision) } catch(e) { throw failure(e) } }
  /** @returns Prompt-only preset list JSON. */
  @Remote('httpCacheSettings') async httpCacheSettings():Promise<string> {return JSON.stringify(this.storage.httpCacheSettings())}
  @Remote('saveHttpCacheSettings') async saveHttpCacheSettings(json:string):Promise<string> {try{return JSON.stringify(this.storage.saveHttpCacheSettings(readJSON(json)))}catch(e){throw failure(e)}}
  @Remote('presets') async presets(): Promise<string> { return JSON.stringify(this.storage.presets()) }
  /** @param json - Preset identity, revision, name and prompt. @returns Updated list JSON. */
  @Remote('savePreset') async savePreset(json: string): Promise<string> { try { return JSON.stringify(this.storage.savePreset(readJSON(json))) } catch(e) { throw failure(e) } }
  /** @param id - Preset identity. @returns Updated list JSON. */
  @Remote('deletePreset') async deletePreset(id: string): Promise<string> { try { return JSON.stringify(this.storage.deletePreset(id)) } catch(e) { throw failure(e) } }
  /** @returns Exact models and model-specific effort choices from registered adapters. */
  @Remote('models') async models(): Promise<string> {
    try {
      const { choices, failures } = await modelCatalog(this.ctx.llm)
      if (failures.length) this.ctx.logger.warn(`工作流模型目录部分不可用：${failures.join('；')}`)
      if (!choices.length && failures.length) throw new Error(failures.join('；'))
      return JSON.stringify(choices)
    } catch(e) { throw failure(e) }
  }
  /** @param id - Workflow identity. @param inputsJson - Input field values. @param sessionId - Optional conversation permission context. @returns Running or waiting run snapshot JSON. */
  private bindSavedSubagents(flow:Workflow,sessionId?:string):Workflow {
    if(workflowScope(flow)==='global'||flow.workspaceId!==this.storage.get(flow.id).workspaceId){bindWorkflowSubagentsForRun(flow,sessionId);return flow}
    return this.storage.bindSubagents(flow.id,flow.revision,sessionId)
  }
  /** All run request receipts share the same owner and absent-session namespace. */
  private runRequestSession(sessionId:string|undefined,agent?:Agent):string|undefined{
    return (agent?workflowAgentOwner(agent,this.ctx.agents).id:sessionId)||undefined
  }
  @Remote('start') async start(id: string, inputsJson: string, sessionId:string, requestId?:string): Promise<string> {
    try {
      let flow = this.storage.get(id);flow=workflowForExecution(flow,this.executionWorkspace(flow,sessionId));this.workspace(flow.workspaceId)
      const agent = this.sessionAgent(flow.workspaceId, sessionId)
      const mainSession=this.runRequestSession(sessionId,agent)
      if (!agent && this.requiresNativeContext(flow)) throw new Error('此工作流使用宿主工具，需要当前工作区已初始化的对话权限；请先在该对话发送消息再运行')
      if (agent) this.assertMutable(agent)
      const inputs=readJSON(inputsJson),requestParameters={operation:'start',id,inputs}
      const prior=this.runtime.requestRun(requestId,flow.workspaceId,mainSession,requestParameters)
      if(prior)return JSON.stringify(prior)
      flow=this.bindSavedSubagents(flow,mainSession)
      assertWorkflowReady(await this.readinessFor(flow,mainSession))
      const defaults = this.needsModelDefaults(flow) ? await resolveHarnessModelDefaults(this.ctx, flow.workspaceId, sessionId, agent) : undefined
      if(agent){this.assertMutable(agent);if(this.agentWorkspace(agent)!==flow.workspaceId)throw new Error('对话工作区已变化，请重新检查后运行')}
      const current=this.storage.get(id)
      if(current.revision!==flow.revision||!workflowVisibleInWorkspace(current,flow.workspaceId))throw new Error('工作流范围或版本已变化，请重新检查后运行')
      const run = this.runtime.start(id, inputs, defaults,{requestId,requestParameters,sourceGraph:flow,sessionId:mainSession,freezeTools:flows=>this.freezeTools(flows,agent?.id)})
      this.bindRun(run.id, { agent, ancestors: [id] })
      return JSON.stringify(run)
    } catch(e) { throw failure(e) }
  }
  /** @param runId - Waiting run identity. @param inputsJson - Answers to missing required fields. @returns Resumed run snapshot JSON. */
  @Remote('answer') async answer(runId: string, inputsJson: string): Promise<string> {
    try {
      const source=this.storage.run(runId)
      assertWorkflowReady(await this.readinessFor(source.graph,runSessionId(source),source))
      return JSON.stringify(this.runtime.answer(runId, readJSON(inputsJson)))
    } catch(e) { throw failure(e) }
  }
  /** @param id - Run identity. @returns Persisted run including actual node results. */
  @Remote('run') async run(id: string): Promise<string> { try { const run=this.storage.run(id);if(!LIVE_RUN_STATUSES.includes(run.status))this.releaseRun(id);return JSON.stringify(run) } catch(e) { throw failure(e) } }
  /** @param id - Run identity. @returns Final state after cooperative cancellation settles. */
  @Remote('cancel') async cancel(id: string): Promise<string> { try { const run=await this.runtime.cancel(id);this.releaseRun(id);return JSON.stringify(run) } catch(e) { throw failure(e) } }

  /** @returns Secret isolation capability report without credential values or references. */
  @Remote('secretBoundary') async secretBoundary():Promise<string>{return JSON.stringify(await this.secretBroker.report())}
  /** @param workflowId - Saved workflow identity. @param variableId - Secret declaration identity. */
  @Remote('openSecretManager') async openSecretManager(workflowId:string,variableId:string,sessionId?:string):Promise<void>{
    try{
      const saved=this.storage.get(workflowId),flow=workflowForExecution(saved,this.executionWorkspace(saved,sessionId));this.workspace(flow.workspaceId)
      if(!flow.environmentVariables?.some(v=>v.id===variableId&&v.type==='secret'))throw new ProtectedBrokerError('invalid_request')
      await this.secretBroker.manage({workspaceId:flow.workspaceId,workflowId:flow.id,variableId,nodeId:'environment'})
    }catch(e){throw failure(e instanceof ProtectedBrokerError?e:new ProtectedBrokerError('internal_error'))}
  }
  /** @returns Archived definitions JSON. */
  @Remote('archived') async archived():Promise<string>{return JSON.stringify(this.storage.archived())}
  /** @param id - Archived workflow. @returns Restored definition JSON. */
  @Remote('restore') async restore(id:string):Promise<string>{try{return JSON.stringify(this.storage.restore(id))}catch(e){throw failure(e)}}
  private async readinessFor(flow:Workflow,sessionId?:string,run?:WorkflowRun){
    if(!run)flow=workflowForExecution(flow,this.executionWorkspace(flow,sessionId))
    this.workspace(flow.workspaceId)
    const agent=this.sessionAgent(flow.workspaceId,sessionId),{choices}=await modelCatalog(this.ctx.llm),workflows=this.storage.visibleWorkflows(flow.workspaceId).map(candidate=>workflowForExecution(candidate,flow.workspaceId))
    const modelDefaults=run?run.modelDefaults:needsReadinessModelDefaults(flow,workflows)?await resolveHarnessModelDefaults(this.ctx,flow.workspaceId,sessionId,agent):undefined
    return inspectWorkflowReadiness(flow,{sessionId:agent?workflowAgentOwner(agent,this.ctx.agents).id:sessionId,
      catalog:{models:choices,tools:this.catalog.list(flow.workspaceId,agent?.id),workflows,presets:this.storage.presets()},
      workspaceRoot:this.ctx.workspaceRegistry.list().find(workspace=>workspace.id===flow.workspaceId)!.path,modelDefaults,
      // Current ToolRuntime exposes definitions without verifiable provider ownership.
      // Keep this consistent with the executor until the Host supplies an attested binding.
      canVerifyFileReads:()=>false,
      secretStatus:(candidate,variableId)=>this.secretReadiness(candidate,variableId),
      ...(run?{dependencySnapshots:run.dependencySnapshots??{},rolePrompts:run.rolePrompts??{},dependencyRolePrompts:run.dependencyRolePrompts??{}}:{})})
  }
  private async secretReadiness(candidate:Workflow,variableId:string):Promise<'configured'|'missing'|'unavailable'|'authorization_required'>{
    try{
      const status=await this.secretBroker.status({workspaceId:candidate.workspaceId,workflowId:candidate.id,variableId,nodeId:'environment'})
      return status.state==='missing'?'missing':allNodes(candidate).some(node=>node.config.credentialOperation?.secretVariableId===variableId)&&status.authorization!=='authorized'?'authorization_required':'configured'
    }catch{return 'unavailable'}
  }
  /** @param workflowJson - Editable workflow definition. @param sessionId - Current tool permission context. @returns Passive current-Host configuration report JSON. */
  @Remote('inspectReadiness') async inspectReadiness(workflowJson:string,sessionId:string):Promise<string>{
    try{return JSON.stringify(await this.readinessFor(parseWorkflow(readJSON(workflowJson,WORKFLOW_PACKAGE_MAX_BYTES)),sessionId))}catch(e){throw failure(e)}
  }
  private async prepareImport(text:string,workspaceId:string,optionsJson:string,sessionId:string){
    this.workspace(workspaceId)
    const options=parseWorkflowImportOptions(readJSON(optionsJson||'{}')),agent=this.sessionAgent(workspaceId,sessionId)
    if(agent)this.assertMutable(agent)
    const {choices}=await modelCatalog(this.ctx.llm)
    const catalog={models:choices,tools:this.catalog.list(workspaceId,agent?.id),workflows:this.storage.workflows(workspaceId),presets:this.storage.presets()}
    const value=await prepareWorkflowImport(text,workspaceId,options,catalog,this.ctx.workspaceRegistry.list().find(workspace=>workspace.id===workspaceId)!.path)
    return {value,options}
  }
  /** @param text - Versioned package. @param workspaceId - Target workspace. @param optionsJson - Mapping and optional overwrite revision. @param sessionId - Tool permission context. @returns Import dependency preview JSON. */
  @Remote('previewImport') async previewImport(text:string,workspaceId:string,optionsJson:string,sessionId:string):Promise<string>{
    try{return JSON.stringify((await this.prepareImport(text,workspaceId,optionsJson,sessionId)).value.preview)}catch(e){throw failure(e)}
  }
  /** @param workflowJson - Current workflow definition. @param includeEnvironmentValues - Explicit inclusion of ordinary values. @param sessionId - Permission context. @returns ZIP in base64; no credentials or local authorization. */
  @Remote('exportArchive') async exportArchive(workflowJson:string,includeEnvironmentValues:boolean,sessionId:string):Promise<string>{
    try{
      const flow=parseWorkflow(readJSON(workflowJson,8_000_000));this.workspace(flow.workspaceId)
      const source=this.storage.get(flow.id);if(source.workspaceId!==flow.workspaceId)throw new Error('导出流程不属于当前工作区')
      const agent=this.sessionAgent(flow.workspaceId,sessionId);if(agent)this.assertMutable(agent)
      const root=this.ctx.workspaceRegistry.list().find(workspace=>workspace.id===flow.workspaceId)!.path
      return (await createWorkflowArchive(flow,root,{includeEnvironmentValues,presets:this.storage.presets(),workflows:this.storage.workflows(flow.workspaceId)})).toString('base64')
    }catch(e){throw failure(e)}
  }
  /** @param encoded - ZIP base64. @param workspaceId - Target workspace. @param optionsJson - Mapping and overwrite revision. @param sessionId - Permission context. @returns Structural preview without writing files. */
  @Remote('previewArchive') async previewArchive(encoded:string,workspaceId:string,optionsJson:string,sessionId:string):Promise<string>{
    try{
      const archive=parseWorkflowArchive(encoded),{value}=await this.prepareImport(JSON.stringify(archive.pkg),workspaceId,optionsJson,sessionId)
      value.preview.warnings.push(`流程包附带 ${archive.files.length} 个资料文件；导入时放入工作区的新目录，原文件不被覆盖。`)
      return JSON.stringify(value.preview)
    }catch(e){throw failure(e)}
  }
  /** @param encoded - ZIP base64. @param workspaceId - Target workspace. @param optionsJson - Mapping and overwrite revision. @param sessionId - Permission context. @returns Saved workflow, with bundled assets bound in the destination. */
  @Remote('importArchive') async importArchive(encoded:string,workspaceId:string,optionsJson:string,sessionId:string):Promise<string>{
    let installed:{text:string;cleanup():Promise<void>}|undefined
    try{
      // Authorize and validate every definition before creating any destination files.
      const archive=parseWorkflowArchive(encoded),preflight=await this.prepareImport(JSON.stringify(archive.pkg),workspaceId,optionsJson,sessionId)
      if(!preflight.value.preview.canImport)throw new Error(preflight.value.preview.errors.join('\n')||'流程包无法导入')
      const root=this.ctx.workspaceRegistry.list().find(workspace=>workspace.id===workspaceId)!.path
      installed=await materializeWorkflowArchive(encoded,root)
      const {value,options}=await this.prepareImport(installed.text,workspaceId,optionsJson,sessionId)
      if(!value.preview.canImport||!value.workflow||!value.presets)throw new Error(value.preview.errors.join('\n')||'流程包无法导入')
      return JSON.stringify(this.storage.importBundle(value.workflow,value.presets,options.overwrite,value.workflows))
    }catch(e){await installed?.cleanup();throw failure(e)}
  }
  /** @param text - Versioned package. @param workspaceId - Target workspace. @param optionsJson - Mapping and optional overwrite revision. @param sessionId - Tool permission context. @returns Imported definition JSON. */
  @Remote('importPackage') async importPackage(text:string,workspaceId:string,optionsJson:string,sessionId:string):Promise<string>{
    try{
      const {value,options}=await this.prepareImport(text,workspaceId,optionsJson,sessionId)
      if(!value.preview.canImport||!value.workflow||!value.presets)throw new Error('工作流结构或导入选项无效，请重新检查导入')
      return JSON.stringify(this.storage.importBundle(value.workflow,value.presets,options.overwrite,value.workflows))
    }catch(e){throw failure(e)}
  }
  /** @param id - Running job. @returns Pause request snapshot JSON. */
  @Remote('pause') async pause(id:string):Promise<string>{try{return JSON.stringify(await this.runtime.pause(id))}catch(e){throw failure(e)}}
  /** @param id - Paused job. @returns Resumed snapshot JSON. */
  @Remote('resume') async resume(id:string):Promise<string>{
    try{
      this.bindSavedContext(id)
      const source=this.storage.run(id)
      assertWorkflowReady(await this.readinessFor(source.graph,runSessionId(source),source))
      return JSON.stringify(this.runtime.resume(id))
    }catch(e){throw failure(e)}
  }
  /** @param id - Historical run. @param sessionId - Current permission context. @param planDigest - Confirmed recovery plan digest. @returns Recovered run JSON. */
  @Remote('recover') async recover(id:string,sessionId:string,planDigest:string,reviewJson:string,requestId?:string):Promise<string>{
    try{if(!planDigest)throw new Error('请先查看恢复预览并确认');return await this.recoverRun(id,'resume',sessionId,planDigest,reviewJson?readJSON(reviewJson):undefined,requestId)}catch(e){throw failure(e)}
  }
  /** @param id - Historical run. @returns Read-only reuse and rerun plan JSON. */
  @Remote('recoveryPlan') async recoveryPlan(id:string,reviewJson:string):Promise<string>{
    try{const run=this.storage.run(id);this.workspace(run.workspaceId);return JSON.stringify(this.runtime.recoveryPlan(id,reviewJson?readJSON(reviewJson):undefined))}catch(e){throw failure(e)}
  }
  /** @param id - Historical run. @param sessionId - Current permission context. @returns New snapshot run JSON. */
  @Remote('rerun') async rerun(id:string,sessionId:string,requestId?:string):Promise<string>{try{return await this.recoverRun(id,'rerun',sessionId,undefined,undefined,requestId)}catch(e){throw failure(e)}}
  /** @param runId - Running workflow. @param executionId - Exact node invocation identity. @returns Current run JSON; task teardown continues cooperatively. */
  @Remote('stopNode') async stopNode(runId:string,executionId:string):Promise<string>{try{
    const run=this.storage.run(runId);this.workspace(run.workspaceId)
    const record=run.executions.find(item=>(item.executionId??item.nodeId)===executionId)
    if(!record||record.status!=='running')throw new Error('该执行实例当前没有活动 Agent')
    if(!agentTaskIds(record).some(id=>this.nativeAgent.stop(id)))throw new Error('该 Agent 已结束或尚未启动，请刷新运行状态')
    return JSON.stringify(this.storage.run(runId))
  }catch(e){throw failure(e)}}
  /** @param runId - Owning workflow run. @param executionId - Exact node invocation. @returns Public task process and stored audit JSON. */
  @Remote('agentProcess') async agentProcess(runId:string,executionId:string):Promise<string>{try{
    const {run,record,active,taskIds}=this.agentRecord(runId,executionId)
    const nativeTasks=taskIds.flatMap(id=>{
      const task=this.nativeAgent.inspect(id)
      if(!task||task.runId!==runId||!ownsExecution(task.executionId,executionId))return []
      const {taskId,status,startedAt,endedAt,steps,usage,lifecycle}=task
      return [{taskId,executionId:task.executionId,status,startedAt,endedAt,steps,usage,lifecycle}]
    }).slice(0,3)
    return JSON.stringify({taskId:active?.taskId??taskIds[0],status:active?.status??record.status,canSteer:!!active?.canSteer&&run.status==='running'&&record.status==='running',
      unavailableReason:active?.unavailableReason??(run.status==='running'&&active?.canSteer?undefined:'仅运行中的原任务可接收补充；已完成任务不会重新打开'),
      events:record.agentEvents??[],messages:record.agentMessages??[],nativeTasks})
  }catch(e){throw failure(e)}}
  /** @param runId - Owning workflow run. @param executionId - Exact active node invocation. @param prompt - User supplemental instruction. @param messageId - Stable idempotency identity. @returns Updated run JSON. */
  @Remote('followupAgent') async followupAgent(runId:string,executionId:string,prompt:string,messageId:string):Promise<string>{try{
    this.bindSavedContext(runId)
    const {run,record,active}=this.agentRecord(runId,executionId)
    const prior=record.agentMessages?.find(item=>item.id===messageId)
    if(prior?.status==='accepted'){if(prior.text!==prompt)throw new Error('消息身份冲突');return JSON.stringify(run)}
    if(!active?.canSteer||run.status!=='running'||record.status!=='running')throw new Error(active?.unavailableReason??'原任务已结束或无法补充指令')
    return JSON.stringify(await this.runtime.supplementAgent(runId,executionId,active.taskId,prompt,messageId,authorization=>this.nativeAgent.steer(active.taskId,{id:messageId,text:prompt},authorization)))
  }catch(e){throw failure(e)}}
  /** @param runId - Verification-paused run. @param executionId - Paused output identity. @param outputJson - User-corrected structured output. @returns Validated continuation JSON. */
  @Remote('acceptRepairOutput') async acceptRepairOutput(runId:string,executionId:string,outputJson:string):Promise<string>{
    try{this.bindSavedContext(runId);return JSON.stringify(await this.runtime.acceptRepairOutput(runId,executionId,readJSON(outputJson)))}catch(e){throw failure(e)}
  }
  /** @param runId - Paused run. @param executionId - Existing failed output. @param expectedAttempts - Observed used repair attempts. @returns Paused result after one authorized output-only repair. */
  @Remote('confirmRepairOutput') async confirmRepairOutput(runId:string,executionId:string,expectedAttempts:number):Promise<string>{
    try{this.bindSavedContext(runId);return JSON.stringify(await this.runtime.confirmRepairOutput(runId,executionId,expectedAttempts))}catch(e){throw failure(e)}
  }
  /** @param runId - Paused run identity. @param workflowJson - Candidate graph captured by the user. @param sessionId - Current caller. @returns Read-only revision and invalidation preview JSON. */
  @Remote('previewRunRevision') async previewRunRevision(runId:string,workflowJson:string,sessionId:string):Promise<string>{try{
    this.authorizeRunRevision(runId,sessionId)
    return JSON.stringify(this.runtime.previewRunRevision(runId,readJSON(workflowJson,WORKFLOW_PACKAGE_MAX_BYTES),flows=>this.freezeTools(flows,this.runContexts.get(runId)?.agent?.id)))
  }catch(e){throw failure(e)}}
  /** @param runId - Paused run identity. @param workflowJson - The exact previewed candidate. @param planDigest - Confirmed immutable plan. @param sessionId - Current caller. @returns New paused revision JSON. */
  @Remote('applyRunRevision') async applyRunRevision(runId:string,workflowJson:string,planDigest:string,sessionId:string):Promise<string>{try{
    this.authorizeRunRevision(runId,sessionId)
    return JSON.stringify(this.runtime.applyRunRevision(runId,readJSON(workflowJson,WORKFLOW_PACKAGE_MAX_BYTES),planDigest,flows=>this.freezeTools(flows,this.runContexts.get(runId)?.agent?.id)))
  }catch(e){throw failure(e)}}
  private authorizeRunRevision(runId:string,sessionId:string):void {
    const source=this.storage.run(runId);this.workspace(source.workspaceId);this.bindSavedContext(runId)
    const agent=this.sessionAgent(source.workspaceId,sessionId);if(agent)this.assertMutable(agent)
  }
  private agentRecord(runId:string,executionId:string){
    const run=this.storage.run(runId);this.workspace(run.workspaceId)
    const record=run.executions.find(item=>(item.executionId??item.nodeId)===executionId)
    if(!record)throw new Error('运行实例不存在')
    const taskIds=agentTaskIds(record),active=taskIds.map(id=>this.nativeAgent.inspect(id)).find(task=>task?.runId===runId&&ownsExecution(task.executionId,executionId)&&task.status==='running')
    return {run,record,taskIds,active}
  }
  /** @param id - Run identity. @param tokens - Additional tokens. @returns Updated ledger JSON. */
  private bindSavedContext(id:string):void{
    const run=this.storage.run(id);this.workspace(run.workspaceId)
    const session=run.systemVariables?.session_id,agent=this.sessionAgent(run.workspaceId,typeof session==='string'?session:undefined)
    if(session&&!agent)throw new Error('原会话的执行上下文不可用，请重新选择会话并从历史快照创建新运行')
    if(agent)this.assertMutable(agent)
    this.runContexts.set(id,{agent,ancestors:[run.workflowId]})
  }
  private async recoverRun(id:string,mode:'resume'|'rerun',sessionId:string,planDigest?:string,review?:unknown,requestId?:string):Promise<string>{
    const currentAgent=sessionId?this.ctx.agents.get(SessionId(sessionId)):undefined,sessionOwner=this.runRequestSession(sessionId,currentAgent)
    const retained=this.runtime.recoveryReceipt(id,mode,sessionOwner,planDigest,review,requestId)
    const source=retained??this.storage.run(id);this.workspace(source.workspaceId)
    const agent=this.sessionAgent(source.workspaceId,sessionId);if(agent)this.assertMutable(agent)
    const owner=this.runRequestSession(sessionId,agent)
    const prior=this.runtime.requestRun(requestId,source.workspaceId,owner,{operation:'recover',id,mode,planDigest,review})
    if(prior)return JSON.stringify(prior)
    assertWorkflowReady(await this.readinessFor(source.graph,sessionId,source))
    const run=this.runtime.recover(id,mode,owner,planDigest,review,requestId)
    this.runContexts.set(run.id,{agent,ancestors:[run.workflowId]});return JSON.stringify(run)
  }
  /** @param workflowId - Workflow identity. @returns Proposed changes JSON. */
  @Remote('proposals') async proposals(workflowId:string):Promise<string>{try{return JSON.stringify(this.editor.proposals(workflowId))}catch(e){throw failure(e)}}
  /** @param json - Candidate definition. @param revision - Current revision. @returns New pending proposal JSON. */
  @Remote('propose') async propose(json:string,revision:number):Promise<string>{
    try{const flow=parseWorkflow(readJSON(json,WORKFLOW_PACKAGE_MAX_BYTES));this.workspace(flow.workspaceId);return JSON.stringify(this.editor.propose(flow,revision))}catch(e){throw failure(e)}
  }
  /** @param id - Proposal identity. @param decision - Accept or reject. @param revision - Viewed base revision. @returns Resolved proposal JSON. */
  @Remote('resolveProposal') async resolveProposal(id:string,decision:'accept'|'reject',revision:number):Promise<string>{try{return JSON.stringify(this.editor.resolve(id,decision,revision))}catch(e){throw failure(e)}}
  /** @param workflowId - Workflow identity. @param sessionId - Editing session. @returns Draft list JSON. */
  @Remote('drafts') async drafts(workflowId:string,sessionId:string):Promise<string>{try{return JSON.stringify(this.editor.drafts(workflowId,sessionId||undefined))}catch(e){throw failure(e)}}
  /** @param json - Non-secret editor draft. @param expectedRevision - Draft version read by this editor, zero for creation. @returns Saved draft JSON. */
  @Remote('saveDraft') async saveDraft(json:string,expectedRevision:number):Promise<string>{try{return JSON.stringify(this.editor.saveDraft(readJSON(json,WORKFLOW_PACKAGE_MAX_BYTES),expectedRevision))}catch(e){throw failure(e)}}
  /** @param id - Draft identity. @param expectedRevision - Draft version read by this editor. */
  @Remote('removeDraft') async removeDraft(id:string,expectedRevision:number):Promise<void>{try{this.editor.removeDraft(id,expectedRevision)}catch(e){throw failure(e)}}

  /** @returns Archived personal template metadata JSON. */
  @Remote('archivedTemplates') async archivedTemplates():Promise<string>{try{return JSON.stringify(this.templatesLibrary.archived())}catch(e){throw failure(e)}}
  /** @param id - Archived template. @param revision - Expected revision. @returns Restored template JSON. */
  @Remote('restoreTemplate') async restoreTemplate(id:string,revision:number):Promise<string>{try{return JSON.stringify(this.templatesLibrary.restore(id,revision))}catch(e){throw failure(e)}}
  /** @returns Built-in and personal template metadata JSON. */
  @Remote('templates') async templates():Promise<string>{try{return JSON.stringify(this.templatesLibrary.list())}catch(e){throw failure(e)}}
  /** @param workflowId - Source definition. @param title - Template name. @param selectionJson - Optional viewed scope, selected nodes and source revision. @returns Personal template JSON. */
  @Remote('saveTemplate') async saveTemplate(workflowId:string,title:string,selectionJson?:string):Promise<string>{try{
    const flow=this.storage.get(workflowId);this.workspace(flow.workspaceId)
    const selection=selectionJson===undefined?undefined:parseWorkflowTemplateSelection(readJSON(selectionJson,100_000))
    return JSON.stringify(this.templatesLibrary.save(flow,{title,presets:this.storage.presets(),selection}))
  }catch(e){throw failure(e)}}
  /** @param id - Personal template. @param title - New name. @param revision - Expected revision. @returns Template JSON. */
  @Remote('renameTemplate') async renameTemplate(id:string,title:string,revision:number):Promise<string>{try{return JSON.stringify(this.templatesLibrary.rename(id,title,revision))}catch(e){throw failure(e)}}
  /** @param id - Personal template. @param revision - Expected revision. */
  @Remote('removeTemplate') async removeTemplate(id:string,revision:number):Promise<void>{try{this.templatesLibrary.remove(id,revision)}catch(e){throw failure(e)}}
  /** @param id - Template identity. @param workspaceId - Target execution workspace. @returns New workflow JSON. */
  @Remote('useTemplate') async useTemplate(id:string,workspaceId:string):Promise<string>{
    try{this.workspace(workspaceId);const value=this.templatesLibrary.instantiate(id,workspaceId);return JSON.stringify(this.storage.importBundle(value.workflow,value.presets,undefined,value.workflows))}catch(e){throw failure(e)}
  }

  private planningGetView(taskId:string,caller:PlanningCaller,includeCandidates:boolean,includeMetrics:boolean):string {
    if(taskId.startsWith('trial-'))return this.trialView(this.trials.get(taskId,caller),caller,includeCandidates)
    if(this.planner.get(taskId,caller).commandIntake?.linkedTaskId)return JSON.stringify(this.readPlanningJoin(taskId,caller))
    return this.planningView(this.planner.get(taskId,caller),includeCandidates,includeMetrics)
  }
  private rejectedAnswerView(actionId:string,caller:PlanningCaller,error:PlanningAnswerError):string {
    const current=this.planner.get(actionId,caller)
    return JSON.stringify({...JSON.parse(this.planningView(current)),answer:{accepted:false,code:error.code,retryable:error.retryable,nextAction:error.nextAction,message:error.message}})
  }
  private registerTools(): void {
    this.enableSessionTools=registerWorkflowSessionTools(this.ctx,this.storage,exec=>{
      if(!exec.agent)throw new Error('需要当前对话')
      if(this.ctx.agents.get(exec.agent.id)!==exec.agent)throw new Error('对话权限上下文已结束，请重新打开当前对话')
      this.assertMutable(exec.agent)
      return {sessionId:exec.agent.id,workspaceId:this.agentWorkspace(exec.agent)}
    },id=>{this.workspace(id);return this.ctx.workspaceRegistry.list().find(w=>w.id===id)!.path})
    // Any plugin tool call puts the session tools in that conversation from then on.
    this.ctx.effect(()=>this.ctx.on('tools/execute',(exec,next)=>{if(exec.agent&&exec.name.startsWith('visible_workflow_'))this.enableSessionTools?.(exec.agent);return next()}),'visible-workflows:session-tools-enable')
    const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
    this.ctx.effect(()=>this.ctx.tools.register(defineTool({name:'visible_workflow_plan_wait',description:'在当前主对话内按task_id事件等待规划或试做的真实状态，默认55000ms，最多60000ms；后续调用传上次返回的event_cursor，只返回新增events；超时也返回新游标，勿重复相同参数；不轮询模型、不启动/重试/发布/接受/执行业务。受理后必须等待并核验再final。waiting不是成功，须继续同task等待；needs-input按input路由交真人，native-pending等待原Host问题且不复制ask_user_question、不调用plan_answer或猜revision；settling等清理，manual才转达并提交真人答案。ready仅是候选可审阅，published按receipt区分创建或待接受提案，失败如实报告。取消此等待只解除等待，停止任务用plan_cancel。',
      parameters:{task_id:{type:'string',required:true},wait_ms:{type:'integer'},event_cursor:{type:'string',description:'上次返回的事件游标；省略、空字符串或纯空白均从头返回事件。其他无效值会报错，请不带event_cursor重试或使用最近一次返回的cursor。'}},output,execute:async(args,exec)=>{
      const caller=this.planningCaller(exec),scope={taskId:args.task_id,sessionId:caller.sessionId,workspaceId:caller.workspaceId}
      if(args.event_cursor!==undefined)planningWaitDelta({taskId:args.task_id},scope,args.event_cursor)
      const view=await this.waitPlanningTask(args.task_id,caller,args.wait_ms??55_000)
      return this.observePlanningResult(JSON.stringify(planningWaitView(view,scope,args.event_cursor)),caller)
    }})),'visible-workflows:tool-plan-wait')
    this.ctx.effect(()=>this.ctx.tools.register(defineTool({name:'visible_workflow_from_conversation',description:'用户明确要求把当前对话刚完成的任务整理成可复用工作流时调用。request={requestId:稳定请求ID,instruction:要提炼的任务及复用要求,fromSeq?:历史起始事件序号,throughSeq?:历史截止事件序号,optimizationTarget?:{maxModelCalls?:图级模型调用目标,maxAgentCalls?:图级Agent调用目标}}；目标仅在用户明确要求时提供，不是运行授权或金额。范围须来自当前会话真实事件，未知时省略。仅采集当前主对话已闭合的任务历史，不接受sessionId，不包含当前反推回合，不读取子会话或文件正文。v0.0.2先提炼方法、可变输入、人工环节与证据缺口，生成当前JSON基线，再尝试至多两轮确定性替换并用Graphon回放历史样本，返回优化前后对比；缺样本、回放失败或超目标保留有效候选；不保存、不执行业务。通过正常对话向用户展示source、procedure、sourceMap、warnings和optimization前后统计、替换理由、回放范围及未达目标原因，不把片段回放称为全流程验证；遇awaiting_input先按input路由：native-pending等待原Host真人问题，settling等待清理，manual才转达问题并用当前revision的plan_answer续接，不重复原生提问或猜revision。明确要求保存后才调用plan_publish。',
      parameters:{request:{type:'json'},request_json:{type:'string'}},output,execute:async(args,exec)=>{
      const caller=this.planningCaller(exec),input=conversationPlanningRequestSchema.parse(jsonArg(args,'request',200_000))
      const request=parsePlanningRequest({requestId:input.requestId,operation:'create',instruction:input.instruction,preview:true,
        ...(input.optimizationTarget?{optimizationTarget:input.optimizationTarget}:{}),
        source:{kind:'current-conversation',...(input.fromSeq!==undefined?{fromSeq:input.fromSeq}:{}),...(input.throughSeq!==undefined?{throughSeq:input.throughSeq}:{})}})
      return this.observePlanningResult(this.planningView(await this.planner.start(request,this.backgroundPlanningCaller(caller),{background:true})),caller)
    }})),'visible-workflows:tool-from-conversation')
    this.ctx.effect(()=>this.ctx.tools.register(defineTool({name:'visible_workflow_plan',description:'确定字段新值优先用visible_workflow_edit；确定结构变更用visible_workflow_chain及visible_workflow_splice；已验证模块用handoff.mode=module；审核后写文件选reviewed-file-write@1.0.0，parameters={target:字面量根相对路径,producer:{text:正文模板（可引用reviewBase/reviewNote）},maxIterations:3}；完整参数由Host展开，0额外规划调用，模块外业务仍用partial/子Agent局部设计。仅未决字段用handoff.mode=partial保留已知决定。受理立即返回taskId，不等于候选成功；不要高频查询或换requestId重提。新建默认先由Agent演练，Host记录冻结检查结果（失败或无法核验也继续），再提炼、生成并保存新图，Host自动运行一次后交用户审阅。request={requestId:稳定ID,operation:create,instruction:完整需求,execution:{mode:execute-first,task:本次真实任务,tools:[原生工具名称],inputs:[工作区相对输入文件],artifacts:[{path:相对产物路径,format:json|text,requireChanged:true,checks:[{kind:json-equals,pointer:/字段,value:预期JSON值}或{kind:json-type,pointer:/字段,value:object|array|string|number|boolean|null}或{kind:json-length,pointer:/列表,value:数量}或{kind:text-includes,value:必要文本}]}],reviewItems?:[最终报告备注，不是运行时人工审核]},optimizationTarget?:{maxModelCalls,maxAgentCalls}}。tools从visible_workflow_tools读取native:后的名称，网页步骤另选会话工具workflow_http_request及workflow_html_select/workflow_html_extract_text，要文件字节数或行数另选workflow_file_stat；验收条件在执行前冻结，不猜用户资料或预期结果。只在缺少必要信息或授权时原生询问，不为reviewItems提问；明确只设计时execution:{mode:design-only}。试做调用真实工具并继承当前权限，产生实际产物；生成后保存新图并自动运行一次；proposed修订提案不自动运行。用户已经完成的任务用from_conversation，不重复执行。修改仍operation:revise,targetWorkflowId,expectedRevision,targetNodeIds?，不传execution，不重新试做。结果taskId可能是trial-身份，planningTaskId才用于后续plan_answer/publish；检查verification与planning.optimization。真正缺信息或授权时使用真人问答；执行失败、取消、超时后不得换ID自动重做。相同requestId返回原记录，优化目标未达保留候选，不能绕过引擎直接save。'+PLANNING_ROUTE_GUIDANCE+PLANNING_MODULE_HINT_GUIDANCE+PLAN_HANDOFF_GUIDANCE,
      parameters:{request:{type:'json'},request_json:{type:'string'}},output,execute:async(args,exec)=>{
      return this.planningEntry(jsonArg(args,'request',200_000),this.planningCaller(exec))
    }})),'visible-workflows:tool-plan')
    this.ctx.effect(()=>this.ctx.tools.register(defineTool({name:'visible_workflow_create',description:CREATE_TOOL_DESCRIPTION,
      parameters:{title:{type:'string',required:true},request:{type:'string',required:true},attempt:{type:'integer'},
        // Also admits the artifact shape {path,checks:[…]} copied from visible_workflow_plan; buildCreateEntry checks each row.
        checks:{type:'array',items:{type:'object',additionalProperties:false,properties:{kind:{type:'string'},value:{type:'json'},pointer:{type:'string'},path:{type:'string'},
          checks:{type:'array',items:{type:'object',additionalProperties:false,properties:{kind:{type:'string',required:true},value:{type:'json',required:true},pointer:{type:'string'}}}},
          requireChanged:{type:'boolean',description:'忽略：Host 只冻结产物存在'},format:{type:'string',description:'忽略：Host 按扩展名判断'}}}}},
      output,execute:async(args,exec)=>{
      const caller=this.planningCaller(exec),root=this.ctx.workspaceRegistry.list().find(item=>item.id===caller.workspaceId)?.path
      const fileKind=(path:string)=>{
        const full=root&&resolve(root,path)
        if(!full||relative(root,full).startsWith('..'))return 'missing' as const
        try{const stat=statSync(full);return stat.isFile()?'file' as const:stat.isDirectory()?'directory' as const:'missing' as const}catch{return 'missing' as const}
      }
      return this.planningEntry(buildCreateEntry(args,{workspaceId:caller.workspaceId,sessionId:caller.sessionId,offeredTools:trialToolNames(caller.parent),fileKind,digest:planningDigest}),caller)
    }})),'visible-workflows:tool-create')
    this.ctx.effect(()=>this.ctx.tools.register(defineTool({name:'visible_workflow_edit',description:'将主 Agent 已确定的字段修改直接交给共享编译、校验和提案机制，0额外规划模型。稳定nodeId+expected_revision；set-config/unset-config的field是config直属字段名，例如text、code、inputs；兼容单层config.text写法，不接受嵌套路径。set-config的对象/数组整体替换，未指定字段保留。不可改body/kind/身份/执行策略/连线；确定的结构插入/替换/删除用visible_workflow_chain及visible_workflow_splice，未决逻辑用plan.handoff.partial。新值必须已按用户要求确定，不猜测。返回taskId仅代表受理，进度由界面更新，最终proposed才表示待接受提案。',
      parameters:{request_id:{type:'string',required:true},workflow_id:{type:'string',required:true},expected_revision:{type:'integer',required:true},instruction:{type:'string',required:true},
        preview:{type:'boolean'},target_node_ids:{type:'array',items:{type:'string'}},changes:{type:'array',required:true,items:{oneOf:[
      {type:'object',additionalProperties:false,properties:{op:{type:'string',const:'set-config',required:true},nodeId:{type:'string',required:true},field:{type:'string',required:true},value:{type:'json',required:true}}},
      {type:'object',additionalProperties:false,properties:{op:{type:'string',const:'unset-config',required:true},nodeId:{type:'string',required:true},field:{type:'string',required:true}}},
      {type:'object',additionalProperties:false,properties:{op:{type:'string',const:'set-title',required:true},nodeId:{type:'string',required:true},value:{type:'string',required:true}}},
    ]}}},output,execute:async(args,exec)=>this.planningEntry({requestId:args.request_id,operation:'revise',targetWorkflowId:args.workflow_id,expectedRevision:args.expected_revision,instruction:args.instruction,
      ...(args.preview===undefined?{}:{preview:args.preview}),...(args.target_node_ids?{targetNodeIds:args.target_node_ids}:{}),
      handoff:{version:1,mode:'edit',changes:normalizePlanningEditToolChanges(args.changes)}},this.planningCaller(exec))})),'visible-workflows:tool-edit')
    this.ctx.effect(()=>this.ctx.tools.register(defineTool({name:'visible_workflow_chain',description:'只读定位同一scope的局部顺序段，返回版本绑定临时别名、稳定ID和边界；只需一个anchor_node_id，不必重传旧链。分支边插入须给entry_edge_id或exit_edge_id。template_ids按需读取最多5个节点种类或真实工具ID的填写模板，Host注入fixed字段。#仅表示顺序展开，不代表分支；明确分支边需指定edge，多入口多出口或跨scope歧义须显式规划，不猜测连线。',
      parameters:{workflow_id:{type:'string',required:true},expected_revision:{type:'integer',required:true},anchor_node_id:{type:'string',required:true},
        chain_key:{type:'string'},entry_edge_id:{type:'string'},exit_edge_id:{type:'string'},template_ids:{type:'array',items:{type:'string'}}},
      output,isConcurrencySafe:()=>true,execute:async(args,exec)=>{
      const reader=this.planningReader(args.workflow_id,args.expected_revision,this.planningCaller(exec))
      const templateIds=z.array(z.string().min(1).max(160)).max(5).parse(args.template_ids??[])
      const boundary=(args.entry_edge_id||args.exit_edge_id)?{boundary:{...(args.entry_edge_id?{entryEdgeId:args.entry_edge_id}:{}),...(args.exit_edge_id?{exitEdgeId:args.exit_edge_id}:{})}}:{}
      return JSON.stringify(reader.chain({anchorNodeId:args.anchor_node_id,...(args.chain_key?{chainKey:args.chain_key}:{}),...boundary},args.expected_revision,templateIds))
    }})),'visible-workflows:tool-chain')
    this.ctx.effect(()=>this.ctx.tools.register(defineTool({name:'visible_workflow_splice',description:'确定的节点插入/修改/替换/删除直接编译为原审核提案，0额外规划模型。用 visible_workflow_locate 定位后，chain 只写 operations（需要时加 exports），基线、锚点等绑定字段由 Host 按本对话最近一次定位补齐；否则 chain 取 chain 读回的version/baseDigest/baseRevision/chainKey/anchorNodeId/scope/boundary，加operations与exports；不回传nodes。每操作draftRevision从0递增，target用临时别名；insert有position:before|after，insert/replace的nodes仅填key/template/values/title?；update用target+values就地改已有节点字段（ID不变，values可引用同一operations里新增的key）；链段外的节点（如分支后面的核对节点）也用update，target写它的key（n+数字），和其他操作合成一个提案。insert后原别名仍指原节点。exports显式指定被删除输出到新key字段的映射。新节点要被已有节点引用时，同一operations里先insert新节点再update引用它的已有节点（不用replace、不需exports），合成一个提案；新key用描述性名字，n+数字是Host给已有节点的名字；分两次提交时后一次看不到未接受的新节点。Host分配ID、接边、更新合法引用并校验，绝不猜分支或数据依赖。代码节点 main(inputs) 返回JSON对象（JS隔离纯计算，Python受限纯数据语法）；知识检索是工作区文件关键词检索；容器内部节点独立声明，用{container,nodes}归属和排序。',
      parameters:{request_id:{type:'string',required:true},workflow_id:{type:'string',required:true},expected_revision:{type:'integer',required:true},instruction:{type:'string',required:true},
        chain:{type:'json'},chain_json:{type:'string'},preview:{type:'boolean'},target_node_ids:{type:'array',items:{type:'string'}}},
      output,execute:async(args,exec)=>{
        const caller=this.planningCaller(exec),raw=jsonArg(args,'chain',160_000)
        // Desktop r62 E: the main chat copied locate's alias list and rules into chain; they are read-only context, not part of the request.
        const given=numberDraftRevisions(wrapFlatNodeForms(raw&&typeof raw==='object'&&!Array.isArray(raw)?(({chainNodes:_nodes,chainRules:_rules,codeTemplate:_template,...rest})=>rest)(raw as Record<string,unknown>):raw))
        // T37.5: fields the main chat left out come from its newest locate of this workflow at this revision; fields it wrote are kept and checked as usual.
        const located=this.locatedChains.get(JSON.stringify([caller.sessionId,args.workflow_id]))
        const chain=given&&typeof given==='object'&&located?.revision===args.expected_revision?{...located.binding,...given as Record<string,unknown>}:given
        // Checked before the replay too: a second proposal goes back without rerunning anything.
        if(!args.preview)this.assertNoPendingRevision(args.request_id,args.workflow_id,args.expected_revision,caller)
        // T37: rerun the changed nodes on the last run's real data first; a failure goes back before any proposal exists.
        const replay=await this.replayChain(args.workflow_id,args.expected_revision,chain,caller)
        if(replay?.steps.some(step=>step.status==='failed'))return JSON.stringify({state:'replay-failed',replay,
          instruction:'用最近一次运行的真实数据回放改动的节点没通过，没有生成提案。只改失败的节点（同一 chain 重新提交，draftRevision 从 0 起），其余操作保持不变。'})
        const result=await this.planningEntry({requestId:args.request_id,operation:'revise',targetWorkflowId:args.workflow_id,expectedRevision:args.expected_revision,instruction:args.instruction,
          ...(args.preview===undefined?{}:{preview:args.preview}),...(args.target_node_ids?{targetNodeIds:args.target_node_ids}:{}),
          handoff:{version:3,mode:'chain',chain}},caller)
        return replay?JSON.stringify({...JSON.parse(result),replay}):result
      }})),'visible-workflows:tool-splice')
    this.ctx.effect(()=>this.ctx.tools.register(defineTool({name:'visible_workflow_locate',description:LOCATE_TOOL_DESCRIPTION,
      parameters:{workflow:{type:'string',required:true},request:{type:'string',required:true}},
      output,execute:async(args,exec)=>JSON.stringify(await this.locateRevision(String(args.workflow),String(args.request),exec))})),'visible-workflows:tool-locate')
    this.ctx.effect(()=>this.ctx.tools.register(defineTool({name:'visible_workflow_modules',description:'读取不可变版本业务模块、参数槽位、输入输出、适用条件与独立验证范围。Host复制固定实现，Agent只填参数。当前支持structured-result-table@1.0.0结构化表格、reviewed-file-write@1.0.0审核后写文件的新建及有提交来源的实例参数更新；固定实现、版本、实例ID与基线必须匹配，不证明用户数据已验收。显式只设计时用plan execution:{mode:design-only},handoff:{version:1,mode:module,module:{moduleId,version,instanceKey,parameters}}。',
      parameters:{},output,isConcurrencySafe:()=>true,execute:async(_args,exec)=>{this.planningCaller(exec);exec.signal.throwIfAborted();return JSON.stringify(businessModuleCatalog())}})),'visible-workflows:tool-modules')
    this.ctx.effect(()=>this.ctx.tools.register(defineTool({name:'visible_workflow_nodes',description:'按当前图版本精确定位或批量读取节点及必要依赖。优先node_id；否则query/kind/tool_id/field/container_id组合筛选，歧义返回多个候选而不默选。返回稳定ID，展示key只在返回版本有效。node_id加fields或node_ids走字段读取，fields可裁剪目标config直属字段。读取template/output的text时已附必要semanticContracts和当前inputs键名，按此合同使用，不必重复dictionary；其它未覆盖语义再按需查词典。不是修改入口，不授予依赖节点写权限。',
      parameters:{workflow_id:{type:'string',required:true},expected_revision:{type:'integer',required:true},node_id:{type:'string'},query:{type:'string'},kind:{type:'string'},tool_id:{type:'string'},
        field:{type:'string'},container_id:{type:'string'},node_ids:{type:'array',items:{type:'string'}},fields:{type:'array',items:{type:'string'}}},
      output,isConcurrencySafe:()=>true,execute:async(args,exec)=>{
      const reader=this.planningReader(args.workflow_id,args.expected_revision,this.planningCaller(exec))
      if(args.node_ids||(args.node_id&&args.fields!==undefined)){
        const nodeIds=z.array(z.string().min(1)).min(1).max(200).parse(args.node_ids??[args.node_id])
        return JSON.stringify(reader.read({nodeIds,expectedRevision:args.expected_revision,selection:{targetNodeIds:nodeIds,...(args.fields?{targetFields:Object.fromEntries(nodeIds.map(id=>[id,args.fields!]))}:{})}}))
      }
      return JSON.stringify(reader.search({nodeId:args.node_id,query:args.query,kind:args.kind,toolId:args.tool_id,field:args.field,containerId:args.container_id},args.expected_revision))
    }})),'visible-workflows:tool-nodes')
    this.ctx.effect(()=>this.ctx.tools.register(defineTool({name:'visible_workflow_plan_get',description:'读取当前主对话规划任务、v0.0.2优化前后对比和真实回执；include_candidates=true时还返回保留的原始及各轮候选，默认省略重复图以节约上下文；include_metrics=true附安全计时、字节和SDK合同摘要，不含原始请求或私有推理。不执行业务。',
      parameters:{task_id:{type:'string',required:true},include_candidates:{type:'boolean'},include_metrics:{type:'boolean'}},output,isConcurrencySafe:()=>true,execute:async(args,exec)=>{
        const caller=this.planningCaller(exec)
        return this.observePlanningResult(this.planningGetView(args.task_id,caller,args.include_candidates===true,args.include_metrics===true),caller)
      }})),'visible-workflows:tool-plan-get')
    this.ctx.effect(()=>this.ctx.tools.register(defineTool({name:'visible_workflow_plan_answer',description:'仅最新get/wait的input.manualAnswerAllowed=true（mode=manual）时，提交真人原样答案继续同task。native-pending由Host原问题接收答案，不能复制ask_user_question或调用本工具；settling须等待状态更新。answers_json=[{questionId,answer}]须答当前所有问题，revision只能来自最新读回，不猜值。answer.accepted=false时按code/retryable=false/nextAction处理，不能修猜revision重试或代答。',
      parameters:{task_id:{type:'string',required:true},revision:{type:'integer',required:true},answers:{type:'json'},answers_json:{type:'string'}},output,execute:async(args,exec)=>{
        const caller=this.planningCaller(exec),actionId=this.commandActionTask(args.task_id,caller)
        try{return this.observePlanningResult(this.planningView(await this.planner.answer(actionId,args.revision,jsonArg(args,'answers',40_000),this.backgroundPlanningCaller(caller))),caller)}
        catch(error){
          if(!(error instanceof PlanningAnswerError))throw error
          return this.observePlanningResult(this.rejectedAnswerView(actionId,caller,error),caller)
        }
      }})),'visible-workflows:tool-plan-answer')
    this.ctx.effect(()=>this.ctx.tools.register(defineTool({name:'visible_workflow_plan_cancel',description:'用户要求停止规划时取消任务，并等待规划子Agent清理；与业务工作流取消分开。',
      parameters:{task_id:{type:'string',required:true}},output,execute:async(args,exec)=>{
        const caller=this.planningCaller(exec)
        return this.observePlanningResult(await this.cancelPlanningTask(args.task_id,caller),caller)
      }})),'visible-workflows:tool-plan-cancel')
    this.ctx.effect(()=>this.ctx.tools.register(defineTool({name:'visible_workflow_plan_publish',description:'用户要求保存已预览候选时提交当前候选。须有可写权限，revision及candidate_digest来自最新规划状态；创建保存可编辑图，修改提交待接受提案；execute-first来源的新图由Host运行一次并返回firstRun，其余不执行。',
      parameters:{task_id:{type:'string',required:true},revision:{type:'integer',required:true},candidate_digest:{type:'string',required:true}},output,execute:async(args,exec)=>{
        const caller=this.planningCaller(exec)
        return this.observePlanningResult(this.planningView(await this.planner.publish(this.commandActionTask(args.task_id,caller),args.revision,args.candidate_digest,caller)),caller)
      }})),'visible-workflows:tool-plan-publish')
    this.ctx.effect(() => this.ctx.tools.register(defineTool({ name: 'visible_workflow_list', description: '列出当前对话工作区与全局范围的可视工作流（ID、标题、版本、节点数）、角色预设及当前 workspaceId；按精确工作流 ID 引用，只读。完整定义用 visible_workflow_get；修改已保存工作流先用 visible_workflow_locate。',
      parameters: {}, output, isConcurrencySafe: () => true, execute: async (_args, exec) => {
        if (!exec.agent) throw new Error('需要当前对话')
        const id = this.agentWorkspace(exec.agent),flows=this.storage.visibleWorkflows(id),visibleIds=new Set(flows.map(flow=>flow.id))
        // Desktop r61 E: full graphs came to 50k characters; get or nodes read a definition.
        const workflows=flows.map(flow=>({id:flow.id,title:flow.title,revision:flow.revision,scope:workflowScope(flow),nodeCount:allNodes(flow).length,updatedAt:flow.updatedAt,...(flow.description?{description:flow.description.slice(0,120)}:{})}))
        return JSON.stringify({ workspaceId: id, workflows, presets: this.storage.presets().filter(preset=>rolePresetAvailable(preset)||!!preset.workflowId&&visibleIds.has(preset.workflowId)&&rolePresetAvailable(preset,preset.workflowId)) })
      } })), 'visible-workflows:tool-list')
    this.ctx.effect(()=>this.ctx.tools.register(defineTool({name:'visible_workflow_dictionary',description:'只读查询本项目当前 Workflow JSON 语义词典：节点功能、config 字段含义和类型、真实输出路径、合法示例、连线和变量作用域。无参数返回紧凑索引；query 示例 {"kinds":["input","template","output"],"topics":["references"],"includeSchema":true}。按需要查询节点和主题，不必读源码或猜字段。词典不是生成/保存入口；字段新值已确定用 visible_workflow_edit，未决逻辑或新建用 visible_workflow_plan。',
      parameters:{query:{type:'json'},query_json:{type:'string'}},output,isConcurrencySafe:()=>true,execute:async(args,exec)=>{
        if(!exec.agent)throw new Error('需要当前对话');exec.signal.throwIfAborted()
        return JSON.stringify(queryWorkflowSemantics(jsonArg(args,'query',8000,false)??{}))
      }})),'visible-workflows:tool-dictionary')
    this.ctx.effect(()=>this.ctx.tools.register(defineTool({name:'visible_workflow_tools',description:'读取当前工作区真实工具目录，生成工具或 Agent 节点前调用；不可编造工具 ID。无参数返回紧凑目录（id、名称、简介，不可用时注明）；ids 返回这些工具的完整参数 schema 和操作合同。工作流字段和节点语义请用 visible_workflow_dictionary 查询。',
      parameters:{ids:{type:'array',items:{type:'string'}},include_workflows:{type:'boolean'}},output,isConcurrencySafe:()=>true,execute:async(args,exec)=>{
        if(!exec.agent)throw new Error('需要当前对话');return JSON.stringify(toolCatalogView(this.catalog.list(this.agentWorkspace(exec.agent),exec.agent.id),args.ids,args.include_workflows===true))
      }})),'visible-workflows:tool-catalog')
    this.ctx.effect(()=>this.ctx.tools.register(defineTool({name:'visible_workflow_current',description:'用户说优化这个workflow且没有明确@工作流ID时，读取当前主对话画布选中目标。只读提示；不是权限。没有选择或多窗口歧义时请用户明确选择；dirty时先保存或还原。局部任务用返回的身份与版本调用visible_workflow_nodes；全图任务才读取完整定义。确定字段新值用visible_workflow_edit，未决逻辑用visible_workflow_plan的partial合同。',
      parameters:{},output,isConcurrencySafe:()=>true,execute:async(_args,exec)=>{
      const target=this.currentPlanningTarget(this.planningCaller(exec))
      return JSON.stringify(currentTargetView(target))
    }})),'visible-workflows:tool-current')
    this.ctx.effect(() => this.ctx.tools.register(defineTool({ name: 'visible_workflow_get', description: '按精确 ID 读取当前工作区或全局工作流的完整定义与稳定身份。用于全图任务或核对未知／过期版本；已有目标和版本的局部修改优先用visible_workflow_nodes读取必要字段，无需先读取整图。全局仅共享定义，不授权其所属项目的文件、Secret 或工具。',
      parameters: { id: { type: 'string', required: true } }, output, isConcurrencySafe: () => true,
      execute: async (args, exec) => { if (!exec.agent) throw new Error('需要当前对话'); return JSON.stringify(this.ownedFlow(args.id, exec.agent)) } })), 'visible-workflows:tool-get')
    this.ctx.effect(() => this.ctx.tools.register(defineTool({ name: 'visible_workflow_save', description: '保存明确提供的当前完整 Workflow JSON，或提交已有图的修改提案；自然语言生成及需要推理的修改使用 visible_workflow_plan，确定的字段修改使用 visible_workflow_edit，即使规划失败也不能自行绕过；此入口只保存用户明确提供的完整 JSON，不是失败后的自动回退。字段解释查询 visible_workflow_dictionary。此入口不执行工作流。仅支持当前字段：agent 节点 config.subagentId 引用 workflow.subAgents 的 id，config.prompt 是节点任务；不得使用 agent.config.rolePresetId。新建 expected_revision=0；修改须最新 revision，固定节点受保护。节点配置以当前JSON字段说明及共用schema为准；模板引用 {{input.字段名}} 或 {{稳定节点ID.text}}。',
      parameters: { json: { type: 'string', required: true }, expected_revision: { type: 'integer', required: true } }, output, execute: async (args, exec) => {
        if (!exec.agent) throw new Error('需要当前对话'); exec.signal.throwIfAborted()
        return JSON.stringify(await this.agentSave(readJSON(args.json,WORKFLOW_PACKAGE_MAX_BYTES), args.expected_revision, exec.agent, exec.signal))
      } })), 'visible-workflows:tool-save')
    this.ctx.effect(() => this.ctx.tools.register(defineTool({ name: 'visible_workflow_run', description: '用户明确要求执行时，按精确 ID 执行当前工作区或全局范围已保存工作流。全局定义仅使用当前对话工作区的文件、Secret 与工具权限，不借用定义所属项目的资源。inputs_json 是声明输入的 JSON 对象；缺失必填字段返回 waiting，由插件询问框补齐。完整输入时立即返回后台运行身份；用visible_workflow_status查询实际结果，用visible_workflow_cancel停止，不修改原流程。',
      parameters: { id: { type: 'string', required: true }, inputs_json: { type: 'string', required: true }, request_id:{type:'string',description:'稳定请求身份；重试沿用原值，修改参数须使用新身份。'} }, output, execute: async (args, exec) => {
      if (!exec.agent) throw new Error('需要当前对话'); this.assertMutable(exec.agent)
      const owner=workflowAgentOwner(exec.agent,this.ctx.agents),workspaceId=this.agentWorkspace(exec.agent)
      let flow=workflowForExecution(this.ownedFlow(args.id, exec.agent),workspaceId);exec.signal.throwIfAborted()
      const inputs=readJSON(args.inputs_json),requestParameters={operation:'start',id:args.id,inputs}
      const prior=this.runtime.requestRun(args.request_id,workspaceId,owner.id,requestParameters)
      if(prior)return JSON.stringify(prior)
      flow=this.bindSavedSubagents(flow,owner.id)
      assertWorkflowReady(await this.readinessFor(flow,owner.id))
      const defaults = this.needsModelDefaults(flow) ? await resolveHarnessModelDefaults(this.ctx, flow.workspaceId, exec.agent.id, exec.agent, true) : undefined
      exec.signal.throwIfAborted(); this.assertMutable(exec.agent)
      const current=this.ownedFlow(args.id,exec.agent)
      if(current.revision!==flow.revision||this.agentWorkspace(exec.agent)!==workspaceId)throw new Error('工作流范围、版本或对话工作区已变化，请重新读取后运行')
      const run = this.runtime.start(args.id, inputs, defaults,
        {requestId:args.request_id,requestParameters,sourceGraph:flow,sessionId:owner.id,repairAuthorization:{source:'agent-tool'},freezeTools:flows=>this.freezeTools(flows,exec.agent!.id)})
      this.bindRun(run.id,{agent:exec.agent,ancestors:[args.id]})
      return JSON.stringify(run)
    } })), 'visible-workflows:tool-run')
    this.ctx.effect(() => this.ctx.tools.register(defineTool({ name: 'visible_workflow_status', description: '读取当前工作区一个运行的真实状态、节点输出与错误。',
      parameters: { run_id: { type: 'string', required: true } }, output, isConcurrencySafe: () => true, execute: async (args, exec) => {
        if (!exec.agent) throw new Error('需要当前对话'); const run = this.storage.run(args.run_id)
        if (run.workspaceId !== this.agentWorkspace(exec.agent)) throw new Error('运行不属于当前工作区'); return JSON.stringify(run)
      } })), 'visible-workflows:tool-status')
    this.ctx.effect(() => this.ctx.tools.register(defineTool({ name: 'visible_workflow_cancel', description: '用户要求停止时取消当前工作区的一次工作流运行，等待取消完成。',
      parameters: { run_id: { type: 'string', required: true } }, output, execute: async (args, exec) => {
        if (!exec.agent) throw new Error('需要当前对话'); const run = this.storage.run(args.run_id)
        if (run.workspaceId !== this.agentWorkspace(exec.agent)) throw new Error('运行不属于当前工作区'); return JSON.stringify(await this.runtime.cancel(run.id))
      } })), 'visible-workflows:tool-cancel')
  }
}
export default VisibleWorkflowService
