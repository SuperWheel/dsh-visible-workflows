/** Stable graph identities are used in references; numbers are presentation only. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type NodeKind = 'input' | 'template' | 'llm' | 'if' | 'output' | 'agent' | 'knowledge' | 'classifier' | 'human' | 'iteration' | 'loop' | 'exit_loop' | 'code' | 'aggregator' | 'document' | 'assigner' | 'extractor' | 'http' | 'list' | 'tool'
export interface InputField { name: string; label: string; required: boolean; defaultValue?: string; type?: 'text' | 'paragraph' | 'number' | 'boolean' | 'select' | 'json' | 'file' | 'files'; options?: string[]; hidden?: boolean }
export interface ModelRef { provider: string; model: string }
/** The host selection frozen when a run starts; saved node overrides remain independent. */
export interface WorkflowModelDefaults { model: ModelRef; effort?: string; source: 'session' | 'harness' }
export type ConditionOperator = 'contains' | 'not_contains' | 'equals' | 'not_equals' | 'not_empty' | 'empty' | 'starts_with' | 'ends_with' | 'gt' | 'gte' | 'lt' | 'lte'
export interface Condition { variable: string; operator: ConditionOperator; value?: string }
export interface ConditionCase { id: string; logic?: 'and' | 'or'; conditions: Condition[] }
export interface NodeGraph { nodes: WorkflowNode[]; edges: WorkflowEdge[] }
export interface ParameterField { name: string; type: 'string' | 'number' | 'boolean' | 'object' | 'array'; description?: string; required?: boolean }
export interface VariableAssignment { name: string; operation: 'set' | 'clear' | 'add' | 'subtract' | 'multiply' | 'divide' | 'append' | 'extend' | 'pop' | 'shift'; value?: JsonValue }
/** Values in inputs are literals; an entire {{variable}} expression preserves its JSON type. */
export interface NodeConfig {
  fields?: InputField[]; text?: string; prompt?: string; model?: ModelRef; effort?: string; rolePresetId?: string
  variable?: string; operator?: ConditionOperator; value?: string; outputName?: string
  inputs?: Record<string, JsonValue>; outputSchema?: ParameterField[]
  cases?: ConditionCase[]; classes?: { id: string; label: string; description?: string }[]
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
}
export interface WorkflowNode {
  id: string; number: string; kind: NodeKind; title: string
  x: number; y: number; fixed: boolean; config: NodeConfig
}
export interface WorkflowEdge { id: string; source: string; target: string; port?: string }
export type CanvasNoteColor = 'yellow' | 'blue' | 'green' | 'purple' | 'neutral'
export const CANVAS_NOTE_SIZE = { width:280, height:180, minWidth:160, minHeight:100, maxWidth:1200, maxHeight:900 } as const
/** Coordinates stay absolute; anchorNodeId only adds a visual, non-executable attachment. */
export interface CanvasNote { id: string; text: string; x: number; y: number; width?: number; height?: number; color?: CanvasNoteColor; anchorNodeId?: string }
export interface Workflow {
  id: string; workspaceId: string; title: string; description: string; revision: number
  nodes: WorkflowNode[]; edges: WorkflowEdge[]; notes: CanvasNote[]
  createdAt: string; updatedAt: string; archived?: boolean
}
export interface RolePreset { id: string; name: string; prompt: string; revision: number }
export interface WorkspaceChoice { id: string; name: string; directory?: string }
export interface ModelChoice { provider: string; model: string; label: string; efforts: { id: string; label: string }[] }
export interface ToolChoice { id: string; name: string; description: string; providerId: string; providerName: string; author?: string; category: 'plugin' | 'swagger' | 'workflow' | 'mcp'; inputSchema: Record<string,JsonValue>; available: boolean; unavailableReason?: string }
export type RunStatus = 'waiting' | 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted'
export interface NodeExecution {
  nodeId: string; number: string; title: string
  status: 'pending' | 'running' | 'waiting' | 'success' | 'failed' | 'skipped' | 'cancelled'
  startedAt?: string; endedAt?: string; input?: string; output?: string; error?: string
  model?: ModelRef; effort?: string; rolePrompt?: string
  executionId?: string; parentNodeId?: string; iteration?: number; data?: Record<string, JsonValue>; selectedPort?: string
  tokenEstimate?: { tokens: number; encoding: string; estimated: true }
}
export interface WorkflowRun {
  id: string; workflowId: string; workspaceId: string; workflowTitle: string; sourceRevision: number
  graph: Workflow; status: RunStatus; inputs: Record<string,string>; outputs: Record<string,string>
  executions: NodeExecution[]; startedAt: string; endedAt?: string; error?: string
  missingFields?: InputField[]
  waitingNodeId?: string; waitingExecutionId?: string; humanPrompt?: string; humanActions?: { id: string; label: string }[]; waitingSince?: string
  rolePrompts?: Record<string,string>
  modelDefaults?: WorkflowModelDefaults
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
  tools(workspaceId?: string, sessionId?: string): Promise<ToolChoice[]>
  importSwagger(workspaceId: string, definitionJson: string): Promise<ToolChoice[]>
  list(workspaceId: string): Promise<LibrarySnapshot>
  get(id: string): Promise<Workflow>
  save(json: string, expectedRevision: number): Promise<Workflow>
  remove(id: string, expectedRevision: number): Promise<void>
  presets(): Promise<RolePreset[]>
  savePreset(json: string): Promise<RolePreset[]>
  deletePreset(id: string): Promise<RolePreset[]>
  models(): Promise<ModelChoice[]>
  start(id: string, inputsJson: string, sessionId?: string): Promise<WorkflowRun>
  answer(runId: string, inputsJson: string): Promise<WorkflowRun>
  run(id: string): Promise<WorkflowRun>
  cancel(id: string): Promise<WorkflowRun>
}
