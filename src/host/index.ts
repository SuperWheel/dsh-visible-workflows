import { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import type {} from '@deepseek-ai/dsh-sandbox'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { JsonValue, ToolChoice, LibrarySnapshot, Workflow } from '../shared/types.ts'
import { WorkflowStorage } from './storage.ts'
import { WorkflowRuntime } from './runtime.ts'
import { harnessModels, modelCatalog } from './llm.ts'
import { allNodes, parseWorkflow } from './validation.ts'
import { ToolCatalog } from './tool-catalog.ts'
import { createExecutionAdapters, httpRequest } from './execution-adapters.ts'
import type { AdapterRequest } from './runtime.ts'
import { isModelNode, resolveHarnessModelDefaults } from './model-defaults.ts'
import { ensureGraphonEnvironment } from './graphon-environment.ts'
import { graphonRuntimeDirectory } from './graphon.ts'

export interface Config { stateDirectory?: string }
declare module '@deepseek-ai/cordis' { interface Context { visibleWorkflows: VisibleWorkflowService } }
declare module '@deepseek-ai/dsh-typert-protocol' { interface RemoteErrorDetailsMap { 'visible-workflows/unavailable': { reason: string } } }
const failure = (error: unknown) => { const reason = error instanceof Error ? error.message : String(error); return new RemoteError('visible-workflows/unavailable', reason, { reason }) }
const readJSON = (text: string): unknown => { if (Buffer.byteLength(text, 'utf8') > 4_000_000) throw new Error('提交内容过大'); return JSON.parse(text) }
const effortRanks: Record<string, number> = { off: 0, none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6, ultra: 7 }

/** Plugin-owned persistence and graph execution exposed through Harness's authenticated Gateway. */
export class VisibleWorkflowService extends TypertRemoteService {
  static inject = ['llm', 'tools', 'workspaceRegistry', 'systemPrompt', 'typert', 'agents']
  static Config: schema<Config> = schema.object({ stateDirectory: schema.string() })
  private readonly storage: WorkflowStorage
  private readonly runtime: WorkflowRuntime
  private readonly catalog: ToolCatalog
  private readonly runContexts = new Map<string, { agent?: Agent; exec?: ToolRunContext; ancestors: string[] }>()
  constructor(ctx: Context, config: Config) {
    super(ctx, 'visibleWorkflows', { namespace: 'visibleWorkflows' })
    this.storage = new WorkflowStorage(config.stateDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'visible-dynamic-workflows'))
    this.catalog = new ToolCatalog({ directory:this.storage.directory, workflows:id=>this.storage.workflows(id), nativeTools:(id,session)=>this.nativeTools(id,session), executeNative:(id,args,request)=>this.executeNative(id,args,request), runWorkflow:(id,args,request)=>this.runNested(id,args,request), http:httpRequest })
    this.runtime = new WorkflowRuntime(this.storage, harnessModels(ctx.llm), createExecutionAdapters({ catalog:this.catalog, readAttachment:(runId,fileId)=>this.storage.readAttachment(runId,fileId), workspaceRoot:id=>{this.workspace(id);return this.ctx.workspaceRegistry.list().find(w=>w.id===id)!.path}, sessionForRun:id=>this.runContexts.get(id)?.agent?.id,
      pythonExecutable:async signal=>(await ensureGraphonEnvironment({directory:graphonRuntimeDirectory(this.storage.directory),signal})).python,
      // Cordis get() is its documented optional-service lookup; absence must not disable JS/builtin workflows.
      confinePython:async(argv,root,signal)=>{const sandbox=ctx.get('sandbox');if(!sandbox)throw new Error('宿主尚未启用文件沙箱，Python 不可执行');const confined=await sandbox.confine(argv,{mode:'read-only',workspaceRoot:root},signal);if(confined.enforcement!=='full')throw new Error('Python 需要完整文件沙箱，当前平台仅部分支持');return confined.argv}
    }))
    ctx.effect(() => () => this.runtime.close(), 'visible-workflows:lifetime')
    this.registerTools()
    // These are workflow template examples, not Harness prompt variables.
    ctx.effect(() => ctx.systemPrompt.section({ name: 'visible-workflows:guide', order: 85, interpolate: false, text:
      '工作流插件提供可视画布与独立执行器。用户明确要求生成/修改工作流时使用 visible_workflow_save；生成草稿不会执行。用户明确要求用工作流完成任务时使用 visible_workflow_run。读取与检查可用 visible_workflow_list/visible_workflow_get/visible_workflow_status。支持 input/template/llm/if/output/agent/knowledge/classifier/human/iteration/loop/exit_loop/code/aggregator/document/assigner/extractor/http/list/tool。工具节点创建前用 visible_workflow_tools 读取真实目录，严禁编造工具ID。代码 main(inputs) 返回JSON对象；JS为隔离纯计算，Python为受限纯数据语法；知识检索是工作区文件关键词检索。容器子图存config.body={nodes,edges}。模板引用用 {{input.字段名}} 和 {{稳定节点ID.text}}。不得修改或绕过固定节点；用户应在画布明确修改或解除固定。信息不足的运行会产生 waiting 记录，由插件询问框补齐。普通任务先完成交付，仅在适合复用时最后一句建议转换，未经用户选择不自动生成。' }), 'visible-workflows:guide')
  }
  private workspace(id: string): void { if (!this.ctx.workspaceRegistry.list().some(w => w.id === id)) throw new Error('工作区不存在，请在宿主中选择有效工作区') }
  private agentWorkspace(agent: Agent): string {
    const workspace = this.ctx.workspaceRegistry.list().find(w => w.path === agent.session.header.cwd && w.sessionIds.includes(agent.id))
    if (!workspace) throw new Error('此对话尚未归属有效工作区，请先选择工作区')
    return workspace.id
  }
  private assertMutable(agent: Agent): void {
    if (agent.ctx.get('planMode')?.get(agent).active) throw new Error('当前为规划模式，请先退出规划模式再保存或执行工作流')
    if (agent.ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode === 'read-only') throw new Error('当前为只读权限，不能保存或启动工作流')
  }
  private ownedFlow(id: string, agent: Agent): Workflow {
    const flow = this.storage.get(id)
    if (flow.workspaceId !== this.agentWorkspace(agent)) throw new Error('只能操作当前对话工作区的工作流')
    return flow
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
      const ids=node.kind==='tool'||(node.kind==='document'&&node.config.documentMode==='tool')?[node.config.toolId??'']:node.kind==='agent'||(node.kind==='document'&&node.config.documentMode==='agent')?node.config.tools??[]:[]
      if(ids.some(id=>id.startsWith('native:')))return true
      for(const id of ids.filter(id=>id.startsWith('workflow:'))){
        const nested=this.storage.get(id.slice(9))
        if(nested.workspaceId!==flow.workspaceId)throw new Error('不能调用其他工作区的工作流')
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
      const tools = node.kind === 'tool' || (node.kind === 'document' && node.config.documentMode === 'tool') ? [node.config.toolId ?? ''] : node.kind === 'agent' || (node.kind === 'document' && node.config.documentMode === 'agent') ? node.config.tools ?? [] : []
      for (const id of tools.filter(id => id.startsWith('workflow:'))) {
        const child = this.storage.get(id.slice(9))
        if (child.workspaceId !== flow.workspaceId) throw new Error('不能调用其他工作区的工作流')
        if (this.needsModelDefaults(child, seen)) return true
      }
    }
    return false
  }
  private nativeTools(workspaceId:string,sessionId?:string):ToolChoice[] {
    let agent:Agent|undefined
    try{agent=this.sessionAgent(workspaceId,sessionId)}catch{return []}
    if(!agent)return []
    return this.ctx.tools.schemas(agent).filter(t=>!t.name.startsWith('visible_workflow_')).map(t=>{const mcp=t.name.startsWith('mcp__'),provider=mcp?t.name.split('__')[1]??'MCP':'harness';return {id:`native:${t.name}`,name:t.name,description:t.description,providerId:`native:${provider}`,providerName:mcp?provider:'Harness 已注册工具',category:mcp?'mcp':'plugin',inputSchema:JSON.parse(JSON.stringify(t.parameters)) as Record<string,JsonValue>,available:true}})
  }
  private async executeNative(name:string,args:Record<string,JsonValue>,request:AdapterRequest):Promise<Record<string,JsonValue>> {
    const binding=this.runContexts.get(request.runId)
    if(!binding?.agent)throw new Error('宿主工具需要有效对话权限；请打开当前工作区对话后执行工作流')
    const {agent,exec}=binding
    if(this.ctx.agents.get(agent.id)!==agent)throw new Error('对话权限上下文已结束，请重新打开当前工作区对话后运行')
    if(this.agentWorkspace(agent)!==request.workspaceId)throw new Error('对话已切换工作区，不能继续调用工具')
    this.assertMutable(agent)
    if(name.startsWith('visible_workflow_')||!this.ctx.tools.get(name,agent))throw new Error('此工具不在当前对话可用范围内')
    const result=await this.ctx.tools.execute({name,arguments:args,agent,signal:request.signal,callId:ToolCallId(randomUUID()),...(exec&&!exec.signal.aborted?{parent:exec.token,rootCallId:exec.rootCallId}:{})})
    if(result.isError)throw new Error(`工具调用失败：${result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')}`)
    return {text:typeof result.value==='string'?result.value:JSON.stringify(result.value),value:result.value}
  }
  private async runNested(id:string,args:Record<string,JsonValue>,request:AdapterRequest):Promise<Record<string,JsonValue>> {
    const flow=this.storage.get(id),parent=this.storage.run(request.runId),binding=this.runContexts.get(request.runId),ancestors=binding?.ancestors??[parent.workflowId]
    if(flow.workspaceId!==request.workspaceId)throw new Error('不能执行其他工作区的工作流')
    if(allNodes(flow).some(n=>n.kind==='human'))throw new Error('包含人工介入的工作流须独立运行，目前不能作为子工作流工具')
    if(ancestors.includes(id)||ancestors.length>=8)throw new Error('工作流递归调用或超过 8 层限制')
    const fields=flow.nodes.find(n=>n.kind==='input')?.config.fields??[]
    if(fields.some(f=>f.required&&args[f.name]===undefined&&f.defaultValue===undefined))throw new Error('子工作流缺少必填输入，请在工具参数中补齐')
    const inputs=Object.fromEntries(Object.entries(args).map(([k,v])=>[k,typeof v==='string'?v:JSON.stringify(v)])),run=this.runtime.start(id,inputs,parent.modelDefaults)
    this.runContexts.set(run.id,{...binding,ancestors:[...ancestors,id]})
    const abort=()=>{void this.runtime.cancel(run.id).catch(()=>{})};request.signal.addEventListener('abort',abort,{once:true})
    try {if(request.signal.aborted)abort();const done=await this.runtime.settle(run.id);if(done.status==='waiting'){await this.runtime.cancel(done.id);throw new Error('子工作流需要人工输入，请单独运行并处理询问框')}if(done.status!=='success')throw new Error(done.error??`子工作流 ${done.status}`);return {text:JSON.stringify(done.outputs),outputs:done.outputs,run_id:done.id}}
    finally{request.signal.removeEventListener('abort',abort);this.runContexts.delete(run.id)}
  }
  private async agentSave(raw: unknown, revision: number, agent: Agent, signal: AbortSignal): Promise<Workflow> {
    signal.throwIfAborted()
    this.assertMutable(agent)
    const workspaceId = this.agentWorkspace(agent), flow = parseWorkflow(raw)
    if (flow.workspaceId !== workspaceId) throw new Error('工作流必须属于当前对话工作区；请使用 visible_workflow_list 返回的 workspaceId')
    const previous = revision ? this.ownedFlow(flow.id, agent) : undefined
    const current = agent.session.requestHeader()?.config ?? agent.options
    for (const node of allNodes(flow).filter(isModelNode)) {
      const prior = previous && allNodes(previous).find(n => n.id === node.id)
      if (prior && JSON.stringify(prior.config) === JSON.stringify(node.config)) continue
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
        if (!cap || (requested !== cap && (!(requested in effortRanks) || !(cap in effortRanks) || effortRanks[requested]! > effortRanks[cap]!))) throw new Error('自动选择的思考强度不能超过当前 Agent；无法比较的强度只能沿用当前值')
      }
      const info = await this.ctx.llm.resolveModelInfo(node.config.model.provider, node.config.model.model, signal)
      if (node.config.effort && !info.reasoning?.efforts.some(e => e.id === node.config.effort)) throw new Error('此节点的思考强度不受模型支持')
    }
    signal.throwIfAborted(); this.assertMutable(agent)
    if (this.agentWorkspace(agent) !== workspaceId) throw new Error('当前对话工作区已变化，请重新读取工作流')
    return this.storage.save(flow, revision, 'agent')
  }
  /** @param workspaceId - Empty means all registered workspaces. @returns Library snapshot JSON. */
  @Remote('list')
  async list(workspaceId: string): Promise<string> {
    try { if (workspaceId) this.workspace(workspaceId); const value: LibrarySnapshot = { workflows: this.storage.workflows(workspaceId), presets: this.storage.presets(), runs: this.storage.runs(workspaceId), workspaces: this.ctx.workspaceRegistry.list().map(w => ({ id: w.id, name: w.title, directory: w.path })) }; return JSON.stringify(value) } catch(e) { throw failure(e) }
  }
  /** @param workspaceId - Workspace identity. @param sessionId - Optional conversation permission scope. @returns Actual tool catalog JSON. */
  @Remote('tools') async tools(workspaceId:string,sessionId:string):Promise<string> {try{if(workspaceId)this.workspace(workspaceId);return JSON.stringify(this.catalog.list(workspaceId,sessionId))}catch(e){throw failure(e)}}
  /** @param workspaceId - Workspace identity. @param definitionJson - OpenAPI 3 or Swagger 2 document. @returns Imported operations JSON. */
  @Remote('importSwagger') async importSwagger(workspaceId:string,definitionJson:string):Promise<string>{try{this.workspace(workspaceId);return JSON.stringify(this.catalog.importSwagger(workspaceId,definitionJson))}catch(e){throw failure(e)}}
  /** @param id - Workflow identity. @returns Workflow JSON. */
  @Remote('get') async get(id: string): Promise<string> { try { return JSON.stringify(this.storage.get(id)) } catch(e) { throw failure(e) } }
  /** @param json - Complete workflow draft. @param expectedRevision - Revision seen by the editor. @returns Saved workflow JSON. */
  @Remote('save') async save(json: string, expectedRevision: number): Promise<string> { try { const flow = parseWorkflow(readJSON(json)); this.workspace(flow.workspaceId); return JSON.stringify(this.storage.save(flow, expectedRevision)) } catch(e) { throw failure(e) } }
  /** @param id - Workflow identity. @param expectedRevision - Revision seen by the editor. */
  @Remote('deleteWorkflow') async deleteWorkflow(id: string, expectedRevision: number): Promise<void> { try { this.storage.remove(id, expectedRevision) } catch(e) { throw failure(e) } }
  /** @returns Prompt-only preset list JSON. */
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
  @Remote('start') async start(id: string, inputsJson: string, sessionId:string): Promise<string> {
    try {
      const flow = this.storage.get(id); this.workspace(flow.workspaceId)
      const agent = this.sessionAgent(flow.workspaceId, sessionId)
      if (!agent && this.requiresNativeContext(flow)) throw new Error('此工作流使用宿主工具，需要当前工作区已初始化的对话权限；请先在该对话发送消息再运行')
      if (agent) this.assertMutable(agent)
      const defaults = this.needsModelDefaults(flow) ? await resolveHarnessModelDefaults(this.ctx, flow.workspaceId, sessionId, agent) : undefined
      const run = this.runtime.start(id, readJSON(inputsJson), defaults)
      this.runContexts.set(run.id, { agent, ancestors: [id] })
      if (run.status === 'running') void this.runtime.settle(run.id).then(done => { if (done.status !== 'waiting') this.runContexts.delete(run.id) }).catch(() => this.runContexts.delete(run.id))
      return JSON.stringify(run)
    } catch(e) { throw failure(e) }
  }
  /** @param runId - Waiting run identity. @param inputsJson - Answers to missing required fields. @returns Resumed run snapshot JSON. */
  @Remote('answer') async answer(runId: string, inputsJson: string): Promise<string> { try { return JSON.stringify(this.runtime.answer(runId, readJSON(inputsJson))) } catch(e) { throw failure(e) } }
  /** @param id - Run identity. @returns Persisted run including actual node results. */
  @Remote('run') async run(id: string): Promise<string> { try { const run=this.storage.run(id);if(!['running','waiting'].includes(run.status))this.runContexts.delete(id);return JSON.stringify(run) } catch(e) { throw failure(e) } }
  /** @param id - Run identity. @returns Final state after cooperative cancellation settles. */
  @Remote('cancel') async cancel(id: string): Promise<string> { try { const run=await this.runtime.cancel(id);this.runContexts.delete(id);return JSON.stringify(run) } catch(e) { throw failure(e) } }

  private registerTools(): void {
    const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
    this.ctx.effect(() => this.ctx.tools.register(defineTool({ name: 'visible_workflow_list', description: '列出当前对话工作区的可视工作流、角色预设及 workspaceId；只读。', parameters: {}, output, isConcurrencySafe: () => true, execute: async (_args, exec) => { if (!exec.agent) throw new Error('需要当前对话'); const id = this.agentWorkspace(exec.agent); return JSON.stringify({ workspaceId: id, workflows: this.storage.workflows(id), presets: this.storage.presets() }) } })), 'visible-workflows:tool-list')
    this.ctx.effect(()=>this.ctx.tools.register(defineTool({name:'visible_workflow_tools',description:'读取当前工作区真实工具目录及参数 schema，生成工具或 Agent 节点前调用；不可编造工具 ID。',parameters:{},output,isConcurrencySafe:()=>true,execute:async(_args,exec)=>{if(!exec.agent)throw new Error('需要当前对话');return JSON.stringify(this.catalog.list(this.agentWorkspace(exec.agent),exec.agent.id))}})),'visible-workflows:tool-catalog')
    this.ctx.effect(() => this.ctx.tools.register(defineTool({ name: 'visible_workflow_get', description: '读取当前工作区一个工作流的完整节点与稳定身份，修改前调用。', parameters: { id: { type: 'string', required: true } }, output, isConcurrencySafe: () => true, execute: async (args, exec) => { if (!exec.agent) throw new Error('需要当前对话'); return JSON.stringify(this.ownedFlow(args.id, exec.agent)) } })), 'visible-workflows:tool-get')
    this.ctx.effect(() => this.ctx.tools.register(defineTool({ name: 'visible_workflow_save', description: '用户明确要求时创建或修改可视工作流草稿，不执行。json 是完整 Workflow：{id,workspaceId,title,description,revision,nodes,edges,notes,createdAt,updatedAt}；新流程 expected_revision=0，ID 用唯一字母数字下划线连字符，时间用 ISO。节点 {id,number,kind,title,x,y,fixed,config}；kind 支持 input/template/llm/if/output/agent/knowledge/classifier/human/iteration/loop/exit_loop/code/aggregator/document/assigner/extractor/http/list/tool。工具先调用 visible_workflow_tools；tool.config={toolId,inputs}；code.config={language:javascript|python,code,inputs}，main(inputs)返回对象；http.config={url,method,headers,bodyText}；document.config={source:工作区文件路径或变量}；knowledge.config={sources:路径数组,query,topK}；agent.config={prompt,model,effort,tools:工具ID数组,maxSteps}；iteration.config={iterator:列表变量,outputVariable,body:{nodes,edges}}；loop.config={maxIterations,until,initialVariables,body}。人工节点human.config={prompt,fields,actions:[{id,label}]}；分支if.config.cases=[{id,logic:and|or,conditions:[{variable,operator,value}]}（边port为case.id或false）。input.config={fields:[{name,label,required,defaultValue?}]}；template.config={text}；llm.config={prompt,model?:{provider,model},effort?,rolePresetId?}；if.config={variable,operator:equals|contains|not_empty,value?}；output.config={text,outputName}。边 {id,source,target,port?}，if 出口 port 必须 true/false；notes {id,text,x,y}。模板引用 {{input.字段名}} 或 {{稳定节点ID.text}}；if.variable 不带括号。新 LLM 默认沿用当前 Agent 模型及不超过当前思考强度。严禁修改、删除或绕过固定节点；保存前先读最新版本。', parameters: { json: { type: 'string', required: true }, expected_revision: { type: 'integer', required: true } }, output, execute: async (args, exec) => { if (!exec.agent) throw new Error('需要当前对话'); exec.signal.throwIfAborted(); return JSON.stringify(await this.agentSave(readJSON(args.json), args.expected_revision, exec.agent, exec.signal)) } })), 'visible-workflows:tool-save')
    this.ctx.effect(() => this.ctx.tools.register(defineTool({ name: 'visible_workflow_run', description: '用户明确要求执行时，使用与独立执行按钮相同的运行器执行当前工作区已保存工作流。inputs_json 是声明输入的 JSON 对象；缺失必填字段返回 waiting，由插件询问框补齐。完整输入时等待真实结果，不修改原流程。', parameters: { id: { type: 'string', required: true }, inputs_json: { type: 'string', required: true } }, output, execute: async (args, exec) => {
      if (!exec.agent) throw new Error('需要当前对话'); this.assertMutable(exec.agent); const flow = this.ownedFlow(args.id, exec.agent); exec.signal.throwIfAborted()
      const defaults = this.needsModelDefaults(flow) ? await resolveHarnessModelDefaults(this.ctx, flow.workspaceId, exec.agent.id, exec.agent, true) : undefined
      exec.signal.throwIfAborted(); this.assertMutable(exec.agent)
      const run = this.runtime.start(args.id, readJSON(args.inputs_json), defaults)
      this.runContexts.set(run.id,{agent:exec.agent,ancestors:[args.id],...(run.status==='waiting'?{}:{exec})})
      if (run.status === 'waiting') return JSON.stringify(run)
      const abort = () => { void this.runtime.cancel(run.id).catch(() => {}) }; exec.signal.addEventListener('abort', abort, { once: true })
      try { if (exec.signal.aborted) abort(); return JSON.stringify(await this.runtime.settle(run.id)) } finally { exec.signal.removeEventListener('abort', abort);const current=this.storage.run(run.id);if(current.status==='waiting')this.runContexts.set(run.id,{agent:exec.agent,ancestors:[args.id]});else this.runContexts.delete(run.id) }
    } })), 'visible-workflows:tool-run')
    this.ctx.effect(() => this.ctx.tools.register(defineTool({ name: 'visible_workflow_status', description: '读取当前工作区一个运行的真实状态、节点输出与错误。', parameters: { run_id: { type: 'string', required: true } }, output, isConcurrencySafe: () => true, execute: async (args, exec) => { if (!exec.agent) throw new Error('需要当前对话'); const run = this.storage.run(args.run_id); if (run.workspaceId !== this.agentWorkspace(exec.agent)) throw new Error('运行不属于当前工作区'); return JSON.stringify(run) } })), 'visible-workflows:tool-status')
    this.ctx.effect(() => this.ctx.tools.register(defineTool({ name: 'visible_workflow_cancel', description: '用户要求停止时取消当前工作区的一次工作流运行，等待取消完成。', parameters: { run_id: { type: 'string', required: true } }, output, execute: async (args, exec) => { if (!exec.agent) throw new Error('需要当前对话'); const run = this.storage.run(args.run_id); if (run.workspaceId !== this.agentWorkspace(exec.agent)) throw new Error('运行不属于当前工作区'); return JSON.stringify(await this.runtime.cancel(run.id)) } })), 'visible-workflows:tool-cancel')
  }
}
export default VisibleWorkflowService
