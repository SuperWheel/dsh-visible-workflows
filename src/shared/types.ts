import type { HttpCacheSettings } from './http-cache-settings.ts'
/** Stable graph identities are used in references; numbers are presentation only. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type NodeKind = 'input' | 'template' | 'llm' | 'if' | 'output' | 'agent' | 'knowledge' | 'classifier' | 'human' | 'iteration' | 'loop' | 'exit_loop' | 'code' | 'aggregator' | 'document' | 'assigner' | 'extractor' | 'http' | 'list' | 'tool'
export interface InputField { name: string; label: string; required: boolean; defaultValue?: string; type?: 'text' | 'paragraph' | 'number' | 'boolean' | 'select' | 'json' | 'file' | 'files'; options?: string[]; hidden?: boolean }
export interface ModelRef { provider: string; model: string }
export interface EnvironmentVariableDefinition { id: string; name: string; description?: string; required?: boolean; revision?: number }
/** Secret declarations deliberately have no value, provider handle or authorization fields. */
export type EnvironmentVariable = EnvironmentVariableDefinition & (
  { type: 'string'; value?: string } | { type: 'number'; value?: number } | { type: 'secret'; value?: never }
)
/** Portable, workflow-owned identity. A native task/session id is recorded separately per execution. */
export interface WorkflowSubagent {
  id:string; number:string; name:string; prompt:string
  /** Local main-conversation binding; removed from exported/imported packages. */
  sessionId?:string
  /** Optional preset provenance. Execution always uses the saved prompt snapshot. */
  rolePresetId?:string; rolePresetRevision?:number
}
export interface WorkflowExecutionPolicy {
  /** Legacy metadata; ignored. Cache settings are global. */
  httpCacheLimitMB?: number
  httpCacheImmediateCleanup?: boolean
  repairMode?: 'confirm'|'auto'; maxConcurrentAgents?: number; maxRepairAttempts?: number
  /** @deprecated Read-only legacy fields; no execution quota is enforced. */
  maxAgentTasks?: number; tokenBudget?: number; perTaskTokens?: number
}
export interface WorkflowSystemVariables { [key:string]:JsonValue; workflow_id: string; workflow_run_id: string; workspace_id: string; session_id: string | null; timestamp: number }
/** The host selection frozen when a run starts; saved node overrides remain independent. */
export interface WorkflowModelDefaults { model: ModelRef; effort?: string; source: 'session' | 'harness' }
export type ConditionOperator = 'contains' | 'not_contains' | 'equals' | 'not_equals' | 'not_empty' | 'empty' | 'starts_with' | 'ends_with' | 'gt' | 'gte' | 'lt' | 'lte'
export interface Condition { variable: string; operator: ConditionOperator; value?: string }
export interface ConditionCase { id: string; logic?: 'and' | 'or'; conditions: Condition[] }
export type LogicGateOperator = 'IF' | 'AND' | 'OR' | 'NOT' | 'NAND' | 'NOR' | 'XOR' | 'XNOR'
export interface LogicGateInput { value:JsonValue; predicate?:'boolean'|'truthy'|'falsy'|'nonEmpty' }
export interface LogicGateConfig { operator:LogicGateOperator; inputs:LogicGateInput[] }
export interface NodeGraph { nodes: WorkflowNode[]; edges: WorkflowEdge[] }
export interface ParameterField { name: string; type: 'string' | 'number' | 'boolean' | 'object' | 'array'; description?: string; required?: boolean }
export interface VariableAssignment { name: string; operation: 'set' | 'clear' | 'add' | 'subtract' | 'multiply' | 'divide' | 'append' | 'extend' | 'pop' | 'shift'; value?: JsonValue }
/** Public selectors only. Native broker authorization is never stored in a workflow. */
export interface CredentialOperation { secretVariableId: string; operationId: 'deepseek.account-status.v1' }
/** Values in inputs are literals; an entire {{variable}} expression preserves its JSON type. */
export interface NodeConfig {
  fields?: InputField[]; text?: string; prompt?: string; model?: ModelRef; effort?: string; rolePresetId?: string
  /** References Workflow.subAgents, never a native Harness session. */
  subagentId?:string
  variable?: string; operator?: ConditionOperator; value?: string; outputName?: string
  inputs?: Record<string, JsonValue>; outputSchema?: ParameterField[]
  cases?: ConditionCase[]; classes?: { id: string; label: string; description?: string }[]
  logicGate?: LogicGateConfig
  actions?: { id: string; label: string }[]; timeoutSeconds?: number
  body?: NodeGraph; iterator?: string; outputVariable?: string; errorMode?: 'terminate' | 'null' | 'remove'
  parallel?: boolean; concurrency?: number; maxIterations?: number; until?: Condition; initialVariables?: Record<string, JsonValue>
  groups?: { name: string; variables: string[] }[]; assignments?: VariableAssignment[]
  parameters?: ParameterField[]; listSource?: string; filter?: Condition; sort?: 'asc' | 'desc'; limit?: number
  // Adapter configuration is validated by the Host and selected adapter.
  toolId?: string; tools?: string[]; query?: string; source?: string; sources?: string[]; topK?: number; threshold?: number
  /** Document parsers are explicit; omitted mode preserves lightweight local text extraction. */
  documentMode?: 'local' | 'tool' | 'agent'; documentSourceKey?: string; documentTextPath?: string
  language?: 'javascript' | 'python'; code?: string; url?: string; method?: string
  headers?: Record<string,string>; bodyText?: string; timeoutMs?: number; maxSteps?: number
  /** HTTP-only alternative to direct URL/method/headers/body/inputs; receives no raw Secret. */
  credentialOperation?: CredentialOperation
  verification?: { requiredFiles?: string[]; requiredReadFiles?: string[]; requiredChangedFiles?: string[]; minTextLength?: number }
  cache?: 'never' | 'reuse'
}
export interface WorkflowNode {
  id: string; number: string; kind: NodeKind; title: string; note?: string
  x: number; y: number; fixed: boolean; config: NodeConfig
}
export interface WorkflowEdge { id: string; source: string; target: string; port?: string }
export type CanvasNoteColor = 'yellow' | 'blue' | 'green' | 'purple' | 'neutral'
export const CANVAS_NOTE_SIZE = { width:280, height:180, minWidth:160, minHeight:100, maxWidth:1200, maxHeight:900 } as const
/** Coordinates stay absolute; anchorNodeId only adds a visual, non-executable attachment. */
export interface CanvasNote { id: string; text: string; x: number; y: number; width?: number; height?: number; color?: CanvasNoteColor; anchorNodeId?: string }
/** Portable editing context only; contains no session, receipt or authorization. */
export interface WorkflowEditorState {
  viewport?: {x:number;y:number;scale:number}
  scopePath?: string[]
  annotations?: {id:string;number:number;nodeIds:string[];text:string;position?:{x:number;y:number;scopePath:string[]}}[]
}
export interface WorkflowModuleInstance {
  instanceKey:string;moduleId:string;version:string;implementationDigest:string;parametersDigest:string
  parameters:Record<string,JsonValue>;roles:Record<string,string>;scope:string[]
  /** Boundary connections are a comparison snapshot, never an authorization. */
  edges:{source:string;target:string;port?:string}[]
}
export interface Workflow {
  id: string; workspaceId: string; title: string; description: string; revision: number
  /** Definition visibility only. Omission preserves the original workspace-only behavior. */
  scope?: 'workspace' | 'global'
  nodes: WorkflowNode[]; edges: WorkflowEdge[]; notes: CanvasNote[]
  createdAt: string; updatedAt: string; archived?: boolean
  moduleInstances?: WorkflowModuleInstance[]
  environmentVariables?: EnvironmentVariable[]
  executionPolicy?: WorkflowExecutionPolicy
  /** @deprecated Retained verbatim in existing graphs; no budget choice or gate. */
  budgetDecision?:{mode:'limited'|'unlimited';decidedAt:string}
  subAgents?:WorkflowSubagent[]
  editor?: WorkflowEditorState
}
export interface RolePreset { id: string; name: string; prompt: string; revision: number;summary?:string;scope?:'global'|'workflow';workflowId?:string }
export interface WorkspaceChoice { id: string; name: string; directory?: string }
export interface ModelChoice { provider: string; model: string; label: string; efforts: { id: string; label: string }[] }
export interface ToolChoice { id: string; name: string; description: string; providerId: string; providerName: string; author?: string; category: 'plugin' | 'swagger' | 'workflow' | 'mcp'; inputSchema: Record<string,JsonValue>; available: boolean; unavailableReason?: string; operationContract?: import('./tool-operation-schema.ts').ToolOperationContract }
export type RunStatus = 'waiting' | 'running' | 'paused' | 'pausing' | 'budget_waiting' | 'success' | 'failed' | 'cancelled' | 'interrupted'
export interface AgentTaskEvent { id:string; taskId:string; at:string; kind:'status'|'step'|'tool'|'message'|'error'; summary:string }
export interface AgentSupplementMessage { id:string; taskId:string; text:string; createdAt:string; status:'accepted'|'rejected'; allocationId?:string; nativeMessageId?:string; error?:string }
export interface AgentNativeTaskView {
  taskId:string; executionId:string; status:string; startedAt:string; endedAt?:string; steps:number
  usage?:{totalTokens:number;inputTokens?:number;outputTokens?:number}
  lifecycle?:{
    activation?:{runId:string;provider:string;local:boolean;startedAt:string;endedAt?:string;stopReason?:string}
    cleanup:'pending'|'completed'|'failed'|'unverified';activationDisposed?:boolean;ownedParentDisposed?:boolean
    childRegisteredAfterCleanup?:boolean;ownedParentRegisteredAfterCleanup?:boolean;errors:string[]
  }
}
export interface AgentProcessView { taskId?:string; status:string; canSteer:boolean; unavailableReason?:string; events:AgentTaskEvent[]; messages:AgentSupplementMessage[]; nativeTasks?:AgentNativeTaskView[] }
export interface WorkflowRecoveryPlan { sourceRunId:string; planDigest:string; allowed:boolean; blockedReasons:string[]; invalidNodeIds:string[]; items:{executionId:string;nodeId:string;title:string;action:'reuse'|'rerun'|'blocked';reason:string;reviewable?:boolean;reviewCanComplete?:boolean}[] }
export interface WorkflowRunRevisionPlan extends WorkflowRecoveryPlan { baseRevision:number;targetRevision:number;changes:{nodeId:string;title:string;before:JsonValue;after:JsonValue}[] }
export interface WorkflowRunRevision { revision:number;capturedAt:string;sourceRevision:number;graph:Workflow;executions:NodeExecution[];environment?:Record<string,JsonValue>;rolePrompts?:Record<string,string>;toolConstraints?:Record<string,string>;dependencySnapshots?:Record<string,Workflow>;dependencyRolePrompts?:Record<string,Record<string,string>>;snapshotDigest?:string }
export interface NodeExecution {
  fileEvidence?: import('./file-evidence.ts').FileEvidenceState
  nodeId: string; number: string; title: string
  status: 'pending' | 'running' | 'waiting' | 'success' | 'failed' | 'skipped' | 'cancelled'
  startedAt?: string; endedAt?: string; input?: string; output?: string; error?: string
  model?: ModelRef; effort?: string; rolePrompt?: string
  executionId?: string; parentNodeId?: string; iteration?: number; data?: Record<string, JsonValue>; selectedPort?: string
  tokenEstimate?: { tokens: number; encoding: string; estimated: true }
  subagentDefinitionId?:string
  subagentId?: string; childRunId?: string; repairTaskIds?: string[]; tokenUsage?: number; attempt?: number; reusedFromRunId?: string
  verification?: { status: 'passed' | 'failed' | 'unverified'; reasons: string[] }
  agentEvents?:AgentTaskEvent[]
  agentMessages?:AgentSupplementMessage[]
  repairAttemptsUsed?:number
  repair?:{mode?:'confirm'|'auto';usedAttempts?:number;waiting:boolean;candidate:JsonValue;limit:number;attempts:{attempt?:number;taskId?:string;error:string;candidate?:JsonValue}[];reason?:string;resolvedAt?:string}
  runRevision?:number
  reusedAtRevision?:number
}
/** Provider-reported usage and receipt state; historical estimates are inert. */
export interface RunUsage {
  spentTokens: number; reservedTokens: number; unknownTokens: number; unknownCalls: number
  agentTasks: number; calls: number; limit?: number
  allocations: Record<string,{tokens:number;status:'reserved'|'settled'|'unknown';usage?:number}>
}
export interface WorkflowRun {
  /** Persisted atomically with the accepted run, before any execution. */
  requestReceipt?: { requestId:string; parametersDigest:string; sessionId?:string; runId:string }
  compatibilityWarnings?: ValidationIssue[]
  recoveryReview?: import('./recovery-review.ts').RecoveryReview & {confirmedAt:string;sourceRunId:string}
  id: string; workflowId: string; workspaceId: string; workflowTitle: string; sourceRevision: number
  graph: Workflow; status: RunStatus; inputs: Record<string,string>; outputs: Record<string,string>
  executions: NodeExecution[]; startedAt: string; endedAt?: string; error?: string
  missingFields?: InputField[]
  waitingNodeId?: string; waitingExecutionId?: string; humanPrompt?: string; humanActions?: { id: string; label: string }[]; waitingSince?: string
  rolePrompts?: Record<string,string>
  modelDefaults?: WorkflowModelDefaults
  environment?: Record<string, JsonValue>
  systemVariables?: Record<string, JsonValue>
  sourceRunId?: string
  activeRevision?:number
  revisionHistory?:WorkflowRunRevision[]
  repairAuthorization?: { source:'agent-tool'|'user-diagnostics' }
  /** Root run identity shared by child concurrency, usage, pause and recovery. */
  rootRunId?: string
  snapshotDigest?: string
  toolConstraints?: Record<string,string>
  dependencySnapshots?: Record<string, Workflow>
  dependencyRolePrompts?: Record<string, Record<string,string>>
  /** New runs never set a limit or reserve Tokens. */
  usage?: RunUsage
  engine?: { name: 'graphon'; version: string; protocol: number }
}
export interface LibrarySnapshot { workflows: Workflow[]; presets: RolePreset[]; runs: WorkflowRun[]; workspaces: WorkspaceChoice[] }
export interface ValidationIssue { nodeId?: string; message: string }
export const NODE_LABELS: Record<NodeKind,string> = { input:'用户输入', template:'模板转换', llm:'大语言模型', if:'条件分支', output:'输出', agent:'Agent', knowledge:'知识检索', classifier:'问题分类器', human:'人工介入', iteration:'迭代', loop:'循环', exit_loop:'退出循环', code:'代码执行', aggregator:'变量聚合器', document:'文档提取器', assigner:'变量赋值', extractor:'参数提取器', http:'HTTP 请求', list:'列表操作', tool:'工具' }
export const newId = (): string => globalThis.crypto.randomUUID()

export function makeWorkflow(workspaceId: string, title = '新工作流', sample = false): Workflow {
  const now = new Date().toISOString()
  const a = newId(), b = newId(), c = newId()
  return {
    id:newId(),workspaceId,title,description:sample?'输入一段文字，按模板生成结果；无需模型即可运行。':'',revision:0,createdAt:now,updatedAt:now,
    nodes:[
      {id:a,number:'a-1',kind:'input',title:'接收文本',x:90,y:180,fixed:false,config:{fields:[{name:'text',label:'输入文本',required:true}]}},
      ...(sample ? [{id:b,number:'a-2',kind:'template' as const,title:'整理结果',x:400,y:180,fixed:false,config:{text:'处理结果\n\n{{input.text}}'}}] : []),
      {id:c,number:sample?'a-3':'a-2',kind:'output',title:'输出结果',x:sample?710:400,y:180,fixed:false,config:{text:sample?`{{${b}.text}}`:'{{input.text}}',outputName:'result'}}
    ],edges:sample?[{id:newId(),source:a,target:b},{id:newId(),source:b,target:c}]:[{id:newId(),source:a,target:c}],notes:[]
  }
}

/** Minimal renderer-side API; transport results are unwrapped by the adapter. */
export interface WorkflowAPI {
  exportArchive?(workflow:Workflow,includeEnvironmentValues?:boolean,sessionId?:string):Promise<string>
  previewArchive?(base64:string,workspaceId:string,options?:import('./workflow-import.ts').WorkflowImportOptions,sessionId?:string):Promise<import('./workflow-import.ts').WorkflowImportPreview>
  importArchive?(base64:string,workspaceId:string,options?:import('./workflow-import.ts').WorkflowImportOptions,sessionId?:string):Promise<Workflow>
  inspectReadiness?(workflow:Workflow,sessionId?:string):Promise<import('./workflow-import.ts').WorkflowReadiness>
  openSecretManager?(workflowId: string, variableId: string, sessionId?:string): Promise<void>
  secretBoundary?(): Promise<import('./secret-boundary.ts').SecretBoundaryReport>
  tools(workspaceId?: string, sessionId?: string): Promise<ToolChoice[]>
  importSwagger(workspaceId: string, definitionJson: string): Promise<ToolChoice[]>
  list(workspaceId: string): Promise<LibrarySnapshot>
  get(id: string): Promise<Workflow>
  save(json: string, expectedRevision: number): Promise<Workflow>
  remove(id: string, expectedRevision: number): Promise<void>
  httpCacheSettings():Promise<HttpCacheSettings>
  saveHttpCacheSettings(json:string):Promise<HttpCacheSettings>
  presets(): Promise<RolePreset[]>
  savePreset(json: string): Promise<RolePreset[]>
  deletePreset(id: string): Promise<RolePreset[]>
  models(): Promise<ModelChoice[]>
  start(id: string, inputsJson: string, sessionId?: string, requestId?:string): Promise<WorkflowRun>
  answer(runId: string, inputsJson: string): Promise<WorkflowRun>
  run(id: string): Promise<WorkflowRun>
  cancel(id: string): Promise<WorkflowRun>
  stopNode?(runId:string,executionId:string):Promise<WorkflowRun>
  pause?(id: string): Promise<WorkflowRun>
  resume?(id: string): Promise<WorkflowRun>
  recoveryPlan?(id:string,review?:import('./recovery-review.ts').RecoveryReview):Promise<WorkflowRecoveryPlan>
  recover?(id: string, sessionId?: string, planDigest?:string,review?:import('./recovery-review.ts').RecoveryReview,requestId?:string): Promise<WorkflowRun>
  agentProcess?(runId:string,executionId:string):Promise<AgentProcessView>
  followupAgent?(runId:string,executionId:string,prompt:string,messageId:string):Promise<WorkflowRun>
  confirmRepairOutput?(runId:string,executionId:string,expectedAttempts:number):Promise<WorkflowRun>
  acceptRepairOutput?(runId:string,executionId:string,output:Record<string,JsonValue>):Promise<WorkflowRun>
  previewRunRevision?(runId:string,workflow:Workflow,sessionId?:string):Promise<WorkflowRunRevisionPlan>
  applyRunRevision?(runId:string,workflow:Workflow,planDigest:string,sessionId?:string):Promise<WorkflowRun>
  rerun?(id: string, sessionId?: string,requestId?:string): Promise<WorkflowRun>
  importPackage?(json: string, workspaceId: string, options?:import('./workflow-import.ts').WorkflowImportOptions, sessionId?:string): Promise<Workflow>
  previewImport?(json:string,workspaceId:string,options?:import('./workflow-import.ts').WorkflowImportOptions,sessionId?:string):Promise<import('./workflow-import.ts').WorkflowImportPreview>
  proposals?(workflowId: string): Promise<WorkflowProposal[]>
  propose?(json: string, expectedRevision: number): Promise<WorkflowProposal>
  resolveProposal?(id: string, action: 'accept'|'reject', expectedRevision: number): Promise<WorkflowProposal>
  drafts?(workflowId: string, sessionId?: string): Promise<WorkflowDraft[]>
  saveDraft?(json: string, expectedRevision: number): Promise<WorkflowDraft>
  removeDraft?(id: string, expectedRevision: number): Promise<void>
  archived?(workspaceId?:string): Promise<Workflow[]>
  restore?(id:string): Promise<Workflow>
  templates?(): Promise<WorkflowTemplate[]>
  saveTemplate?(workflowId:string,title:string,selection?:import('./workflow-template-selection.ts').WorkflowTemplateSelection): Promise<WorkflowTemplate>
  renameTemplate?(id:string,title:string,expectedRevision:number): Promise<WorkflowTemplate>
  removeTemplate?(id:string,expectedRevision:number): Promise<void>
  useTemplate?(id:string,workspaceId:string): Promise<Workflow>
  archivedTemplates?(): Promise<WorkflowTemplate[]>
  restoreTemplate?(id:string,expectedRevision:number): Promise<WorkflowTemplate>
}
export interface WorkflowThumbnail { nodes:{id:string;kind:NodeKind;x:number;y:number}[];edges:{source:string;target:string}[] }
export interface WorkflowTemplate { id:string;scope:'builtin'|'personal';title:string;description:string;revision:number;createdAt:string;updatedAt:string;thumbnail?:WorkflowThumbnail }
export interface WorkflowProposal {
  id:string; workflowId:string; baseRevision:number; candidate:Workflow; status:'pending'|'accepted'|'rejected'; summary?:string; createdAt:string
  /** Host-generated baseline, separate from the Workflow JSON contract. */
  baseDefinitionDigest?:string
  /** Host verified that only view navigation changed at this exact revision. */
  canAcceptAtRevision?:number
}
export interface WorkflowDraft { id:string; workflowId:string; workspaceId:string; sessionId?:string; kind:'editor'; payload:JsonValue; revision:number; updatedAt:string }
