import { DEFAULT_HTTP_CACHE_SETTINGS, httpCacheSettingsSchema, type HttpCacheSettings } from '../shared/http-cache-settings.ts'
import { HttpBodyCache, type HttpCacheOwner } from './http-cache.ts'
import { isCachedBody, mapCachedBodies, type CachedBody } from '../shared/http-cache.ts'
import { appendPlanningReceipt, planningCommitSchema, planningReceiptSchema, type PlanningCommit, type PlanningReceipt } from './planning/receipt.ts'
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { JsonValue, RolePreset, Workflow, WorkflowRun } from '../shared/types.ts'
import { renumberWorkflow, assertExistingWorkflowNumbers, assertReviewedWorkflowNumbers } from '../shared/numbering.ts'
import { allNodes, assertGraph, parseWorkflow, presetSchema, protectFixedNodes } from './validation.ts'
import { bindWorkflowSubagentsForRun } from '../shared/workflow-subagents.ts'
import { assertRolePresetScope, rolePresetsForWorkflow } from '../shared/role-presets.ts'
import { workflowScope, workflowVisibleInWorkspace } from '../shared/workflow-scope.ts'
import { normalizeRun, runStorageAliases } from '../shared/run-compatibility.ts'
import { workflowDefinitionContent } from '../shared/workflow-content.ts'

interface StoreState { httpCacheSettings?:HttpCacheSettings; planningReceipts?:PlanningReceipt[]; schema: 2; workflows: Workflow[]; presets: RolePreset[]; runs: WorkflowRun[] }
const clone = <T>(v: T): T => structuredClone(v)
function clearGlobalSubagentSessions(flow:Workflow):void {
  if(workflowScope(flow)==='global')for(const agent of flow.subAgents??[])delete agent.sessionId
}
/** Definitions use atomic replacement; run snapshots and append-only events are separate. */
export class WorkflowStorage {
  private readonly httpCache:HttpBodyCache
  private readonly sessionHttpOwners=new Map<string,HttpCacheOwner>()
  private readonly hydratedBodies=new Map<string,Map<string,CachedBody>>()
  private state: StoreState = { schema: 2, workflows: [], presets: [], runs: [] }
  private readonly file: string
  private readonly lock: string
  private readonly token = randomUUID()
  private closed = false
  private readonly runEventHeads = new Map<string,{seq:number;needsNewline:boolean}>()
  private readonly runSaved = new Set<(run:WorkflowRun)=>void>()

  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (lstatSync(directory).isSymbolicLink()) throw new Error('工作流存储目录不能是符号链接')
    chmodSync(directory, 0o700)
    this.file = join(directory, 'library.json'); this.lock = join(directory, 'host.lock')
    this.httpCache=new HttpBodyCache(directory,()=>[...this.state.runs,...this.sessionHttpOwners.values()],()=>this.httpCacheSettings())
    this.acquireLock()
    try {
      if (existsSync(this.file)) {
        if (lstatSync(this.file).isSymbolicLink()) throw new Error('工作流存储文件不能是符号链接')
        const original=readFileSync(this.file,'utf8')
        const raw = JSON.parse(original) as {httpCacheSettings?:HttpCacheSettings;schema:number;workflows:Workflow[];presets:RolePreset[];runs?:WorkflowRun[];planningReceipts?:PlanningReceipt[]}
        if(raw.schema!==2)throw new Error('不支持此工作流存储版本；仅支持当前 schema: 2，不提供旧版迁移；原文件保持不变')
        if (!Array.isArray(raw.workflows) || !Array.isArray(raw.presets)) throw new Error('工作流存储格式无效')
        const runs=this.loadRuns()
        this.state = { httpCacheSettings:raw.httpCacheSettings===undefined?undefined:httpCacheSettingsSchema.parse(raw.httpCacheSettings), planningReceipts:raw.planningReceipts?.map(receipt=>planningReceiptSchema.parse(receipt)), schema: 2, workflows: raw.workflows.map(parseWorkflow), presets: raw.presets.map(v => presetSchema.parse(v)), runs }
        for (const run of this.state.runs) {
          parseWorkflow(run.graph)
          if (!run.id || !Array.isArray(run.executions) || !run.inputs || !run.outputs) throw new Error('运行记录格式无效')
          // Usage is an inert receipt ledger. A
          // restart cannot turn estimated reservations into reported use or
          // rewrite old run/event history. Only live execution is interrupted.
          if (['running','pausing'].includes(run.status)||run.executions.some(exec=>exec.status==='running')) {
            run.status = 'interrupted'; run.error = 'Host 已重新启动；未自动重放可能有外部副作用的节点'; run.endedAt = new Date().toISOString()
            for (const exec of run.executions) if (exec.status === 'running') { exec.status = 'failed'; exec.error = '执行被中断'; exec.endedAt = run.endedAt }
            this.writeRun(run);this.appendRunEvent(run)
          }
        }
      }
      this.httpCache.cleanup()
    } catch (error) { this.release(); throw error }
  }

  private acquireLock():void {
    // Serialize every acquisition, including stale takeover. Never remove a
    // recovery gate on a stale observation: that would recreate the same race.
    const gate=join(this.directory,'host.lock.recovery')
    let fd:number
    try{fd=openSync(gate,'wx',0o600)}catch(error){
      if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('工作流存储正在取得锁；若恢复进程已退出，请确认无 Host 正在恢复后检查 host.lock.recovery')
      throw error
    }
    try{
      writeFileSync(fd,JSON.stringify({pid:process.pid,token:this.token}))
      if(existsSync(this.lock)){
        const identity=lstatSync(this.lock)
        if(identity.isSymbolicLink()||!identity.isFile())throw new Error('工作流锁文件无效')
        const content=readFileSync(this.lock,'utf8'),owner=JSON.parse(content) as {pid?:number}
        if(!Number.isSafeInteger(owner.pid)||owner.pid!<=0)throw new Error('工作流锁文件无效，请检查存储目录')
        try{process.kill(owner.pid!,0);throw new Error('工作流存储已由其他 Host 占用')}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error}
        const current=lstatSync(this.lock)
        if(current.isSymbolicLink()||current.dev!==identity.dev||current.ino!==identity.ino||readFileSync(this.lock,'utf8')!==content)throw new Error('工作流锁身份已变化，请重试')
        rmSync(this.lock)
      }
      writeFileSync(this.lock,JSON.stringify({pid:process.pid,token:this.token}),{flag:'wx',mode:0o600})
    }finally{closeSync(fd);rmSync(gate)}
  }
  private atomicWrite(file:string,value:unknown):void {
    if(this.closed)throw new Error('工作流存储已关闭')
    const content=JSON.stringify(value)
    if(existsSync(file)){
      if(lstatSync(file).isSymbolicLink())throw new Error('工作流存储文件不能是符号链接')
      if(readFileSync(file,'utf8')===content)return
    }
    const temp=join(this.directory,`write-${randomUUID()}.tmp`)
    let fd:number|undefined
    try{fd=openSync(temp,'wx',0o600);writeFileSync(fd,content);fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temp,file)}
    finally{if(fd!==undefined)closeSync(fd);if(existsSync(temp))rmSync(temp)}
  }
  private persist(next:StoreState):void {
    this.atomicWrite(this.file,{...(next.httpCacheSettings?{httpCacheSettings:next.httpCacheSettings}:{}),schema:2,workflows:next.workflows,presets:next.presets,...(next.planningReceipts?{planningReceipts:next.planningReceipts}:{})})
    this.state=next
  }
  private runDirectory():string {
    const directory=join(this.directory,'runs')
    if(existsSync(directory)&&lstatSync(directory).isSymbolicLink())throw new Error('运行存储目录无效')
    if(!existsSync(directory))mkdirSync(directory,{mode:0o700})
    return directory
  }
  private runFile(id:string):string {
    if(!/^[A-Za-z0-9_-]{1,160}$/.test(id))throw new Error('运行身份无效')
    return join(this.runDirectory(),`${id}.json`)
  }
  private loadRuns():WorkflowRun[]{
    return readdirSync(this.runDirectory()).filter(name=>name.endsWith('.json')).map(name=>{
      const file=join(this.runDirectory(),name)
      if(lstatSync(file).isSymbolicLink())throw new Error('运行存储文件不能是符号链接')
      const run=normalizeRun(JSON.parse(readFileSync(file,'utf8')) as WorkflowRun)
      if(!/^[A-Za-z0-9_-]{1,160}$/.test(run.id)||name!==`${run.id}.json`)throw new Error('运行记录身份与文件不一致')
      return run
    })
  }
  private writeRun(run:WorkflowRun):void {
    this.atomicWrite(this.runFile(run.id),{...run,...runStorageAliases(run)})
  }
  private appendRunEvent(run:WorkflowRun):void {
    const file=join(this.runDirectory(),`${run.id}.events.jsonl`)
    if(existsSync(file)&&lstatSync(file).isSymbolicLink())throw new Error('运行事件文件无效')
    let head=this.runEventHeads.get(run.id)
    if(!head){
      let existing=existsSync(file)?readFileSync(file):Buffer.alloc(0)
      let seq=0
      for(let offset=0;offset<existing.length;){
        const newline=existing.indexOf(10,offset),end=newline<0?existing.length:newline
        const start=offset,line=existing.subarray(start,end).toString('utf8')
        offset=end+1
        if(!line.trim())continue
        let prior:{runId?:unknown;seq?:unknown}
        try{prior=JSON.parse(line) as typeof prior}catch{
          if(newline>=0)throw new Error('运行事件日志格式无效，不能确定下一事件序号')
          const quarantine=join(this.runDirectory(),`${run.id}.events.quarantine.jsonl`)
          if(existsSync(quarantine)&&lstatSync(quarantine).isSymbolicLink())throw new Error('运行事件隔离文件无效')
          const record={runId:run.id,byteOffset:start,detectedAt:new Date().toISOString(),bytesBase64:existing.subarray(start).toString('base64')}
          // Preserve exact bytes durably before discarding only the torn tail.
          const quarantineFd=openSync(quarantine,'a',0o600)
          try{appendFileSync(quarantineFd,JSON.stringify(record)+'\n');fsyncSync(quarantineFd)}finally{closeSync(quarantineFd)}
          const fd=openSync(file,'r+')
          try{ftruncateSync(fd,start);fsyncSync(fd)}finally{closeSync(fd)}
          existing=existing.subarray(0,start)
          break
        }
        if(!prior||typeof prior!=='object'||Array.isArray(prior)||prior.runId!==run.id)throw new Error('运行事件日志身份无效')
        if(prior.seq===undefined)seq++ // Legacy rows keep their bytes and reserve one position.
        else if(typeof prior.seq==='number'&&Number.isSafeInteger(prior.seq)&&prior.seq>0)seq=Math.max(seq,prior.seq)
        else throw new Error('运行事件日志序号无效')
        if(!Number.isSafeInteger(seq))throw new Error('运行事件序号超出安全范围')
      }
      head={seq,needsNewline:existing.length>0&&existing[existing.length-1]!==10};this.runEventHeads.set(run.id,head)
    }
    const seq=head.seq+1
    if(!Number.isSafeInteger(seq))throw new Error('运行事件序号超出安全范围')
    const event={id:`${run.id}:${seq}`,seq,at:new Date().toISOString(),runId:run.id,status:run.status,executions:run.executions.map(item=>({executionId:item.executionId??item.nodeId,status:item.status,subagentId:item.subagentId})),usage:run.usage,rootRunId:run.rootRunId,...runStorageAliases(run)}
    const prefix=head.needsNewline?'\n':''
    // The Host lock owns this synchronous append. Reserve before I/O so even a
    // failed fsync/retry cannot append the same identity twice in this Host.
    head.seq=seq
    const fd=openSync(file,'a',0o600)
    try{appendFileSync(fd,prefix+JSON.stringify(event)+'\n');head.needsNewline=false;fsyncSync(fd)}finally{closeSync(fd)}
  }
  workflows(workspaceId: string = ''): Workflow[] { return clone(this.state.workflows.filter(w => !w.archived&&(!workspaceId || w.workspaceId === workspaceId))) }
  visibleWorkflows(workspaceId:string):Workflow[]{return clone(this.state.workflows.filter(flow=>workflowVisibleInWorkspace(flow,workspaceId)))}
  get(id: string): Workflow { const w = this.state.workflows.find(w => w.id === id&&!w.archived); if (!w) throw new Error('工作流不存在或已删除'); return clone(w) }
  /** Bind project definitions atomically; global definitions bind only detached run graphs. */
  bindSubagents(id:string,expectedRevision:number,sessionId?:string):Workflow {
    const root=this.get(id),changes=new Map<string,Workflow>(),seen=new Set<string>()
    if(root.revision!==expectedRevision)throw new Error('工作流已被修改，请重新运行')
    if(workflowScope(root)==='global'){
      clearGlobalSubagentSessions(root);bindWorkflowSubagentsForRun(root,sessionId);assertGraph(root)
      return root
    }
    const visit=(flow:Workflow,path:string[])=>{
      if(path.includes(flow.id)||path.length>=8)throw new Error('工作流递归调用或超过 8 层限制')
      if(seen.has(flow.id))return;seen.add(flow.id)
      const before=JSON.stringify(flow)
      bindWorkflowSubagentsForRun(flow,sessionId);assertGraph(flow)
      if(before!==JSON.stringify(flow))changes.set(flow.id,{...flow,revision:flow.revision+1,updatedAt:new Date().toISOString()})
      for(const node of allNodes(flow))for(const tool of [node.config.toolId,...node.config.tools??[]])if(tool?.startsWith('workflow:')){
        const child=this.get(tool.slice(9));if(!workflowVisibleInWorkspace(child,root.workspaceId))throw new Error('不能引用其他工作区的非全局工作流')
        // Shared definitions bind only detached run graphs, including calls
        // originating from the global definition's own project.
        if(workflowScope(child)==='global'||child.workspaceId!==root.workspaceId)continue
        visit(child,[...path,flow.id])
      }
    }
    visit(root,[])
    if(changes.size){const next=clone(this.state);next.workflows=next.workflows.map(flow=>changes.get(flow.id)??flow);this.persist(next)}
    return this.get(id)
  }
  planningReceipt(key:string):PlanningReceipt|undefined{return clone(this.state.planningReceipts?.find(receipt=>receipt.key===key))}
  save(value: unknown, expectedRevision: number, actor: 'user' | 'agent' = 'user', commit?:PlanningCommit): Workflow {
    return this.saveDefinition(value,expectedRevision,actor,commit,false)
  }
  /** Host-only acceptance entry. No input JSON field or public save flag can enable it. */
  saveReviewedCandidate(value:unknown,expectedRevision:number):Workflow {
    return this.saveDefinition(value,expectedRevision,'agent',undefined,true)
  }
  private saveDefinition(value:unknown,expectedRevision:number,actor:'user'|'agent',commit:PlanningCommit|undefined,reviewed:boolean):Workflow {
    if(commit){planningCommitSchema.parse(commit);if(expectedRevision!==0||this.planningReceipt(commit.key))throw new Error('规划提交已完成或版本无效，请读取提交回执')}
    const flow = parseWorkflow(value);clearGlobalSubagentSessions(flow);assertGraph(flow);assertRolePresetScope(flow,this.state.presets)
    if(flow.archived)throw new Error('请使用归档操作，不得通过普通保存更改归档状态')
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('版本号无效')
    const prior = this.state.workflows.find(w => w.id === flow.id)
    if(commit&&prior)throw new Error('规划创建必须使用全新的工作流身份，请重新生成候选')
    if ((prior?.revision ?? 0) !== expectedRevision || (!prior && expectedRevision !== 0)) throw new Error('工作流已被修改，请刷新后再保存，避免覆盖其他修改')
    if (prior && flow.workspaceId !== prior.workspaceId) throw new Error('不能直接变更工作流所属工作区，请复制为新流程')
    if(actor==='agent'&&workflowScope(flow)!==(prior?workflowScope(prior):'workspace'))throw new Error('Agent 不能更改工作流的项目或全局范围')
    if (prior && actor === 'agent') {const before=clone(prior);clearGlobalSubagentSessions(before);protectFixedNodes(before, flow)}
    if(prior?.archived)throw new Error('工作流已归档，请先恢复')
    if(reviewed){if(!prior)throw new Error('已审核候选只能接受到已有工作流');assertReviewedWorkflowNumbers(flow,prior)}
    // A pan/zoom/scope autosave after acceptance must not renumber the reviewed
    // graph. Require an actual navigation change, the same definition and exact
    // current numbers; an explicit numbering edit or ordinary save keeps its
    // existing normalization behavior.
    const navigationChanged=prior&&JSON.stringify([prior.editor?.viewport,prior.editor?.scopePath])!==JSON.stringify([flow.editor?.viewport,flow.editor?.scopePath])
    const navigationOnly=navigationChanged&&workflowDefinitionContent(prior)===workflowDefinitionContent(flow)
    if(navigationOnly)assertExistingWorkflowNumbers(flow,prior)
    const normalized=reviewed||navigationOnly?flow:renumberWorkflow(flow)
    if(prior){const comparable=(value:Workflow)=>{const {revision:_,updatedAt:__,scope:___,...content}=value;return JSON.stringify({scope:workflowScope(value),...content})};if(comparable(prior)===comparable({...normalized,createdAt:prior.createdAt}))return clone(prior)}
    // Persist navigation without creating a new definition version. Identical
    // autosaves already returned above; real edits still advance the CAS revision.
    const viewOnly=prior&&workflowDefinitionContent(prior)===workflowDefinitionContent(normalized)
    const now = new Date().toISOString()
    const saved: Workflow = { ...normalized, revision: viewOnly?prior.revision:expectedRevision + 1, createdAt: prior?.createdAt ?? now, updatedAt: viewOnly?prior.updatedAt:now }
    const next = clone(this.state); next.workflows = next.workflows.filter(w => w.id !== saved.id); next.workflows.push(saved)
    if(commit)next.planningReceipts=appendPlanningReceipt(next.planningReceipts,{...commit,kind:'created',workflowId:saved.id,revision:saved.revision})
    this.persist(next); return clone(saved)
  }
  remove(id: string, expectedRevision: number): void {
    const flow = this.get(id)
    if (flow.revision !== expectedRevision) throw new Error('工作流版本已变化，请刷新后再删除')
    if (this.state.runs.some(r => r.workflowId === id && ['running', 'waiting','pausing','paused','budget_waiting'].includes(r.status))) throw new Error('请先取消此工作流的当前运行')
    const next = clone(this.state); next.workflows=next.workflows.map(w=>w.id===id?{...w,archived:true,revision:w.revision+1,updatedAt:new Date().toISOString()}:w); this.persist(next)
  }
  archived(workspaceId:string=''):Workflow[]{return clone(this.state.workflows.filter(flow=>flow.archived&&(!workspaceId||flow.workspaceId===workspaceId)))}
  restore(id:string):Workflow{const prior=this.state.workflows.find(flow=>flow.id===id&&flow.archived);if(!prior)throw new Error('归档工作流不存在');const next=clone(this.state);next.workflows=next.workflows.map(flow=>flow.id===id?{...flow,archived:false,revision:flow.revision+1,updatedAt:new Date().toISOString()}:flow);this.persist(next);return this.get(id)}
  /** Imported role definitions and their new workflow commit together or not at all. */
  importBundle(value:unknown,roles:unknown[],overwrite?:{workflowId:string;expectedRevision:number},additionalWorkflows:unknown[]=[]):Workflow{
    const flow=parseWorkflow(value),children=additionalWorkflows.map(parseWorkflow),flows=[flow,...children],presets=roles.map(value=>presetSchema.parse(value));for(const candidate of flows){candidate.scope='workspace';assertGraph(candidate)}
    if(new Set(flows.map(value=>value.id)).size!==flows.length||flows.some(candidate=>candidate.revision!==0||candidate.archived||candidate.workspaceId!==flow.workspaceId||this.state.workflows.some(value=>value.id===candidate.id)))throw new Error('导入必须使用全新的工作流身份')
    const prior=overwrite?this.state.workflows.find(value=>value.id===overwrite.workflowId):undefined
    if(overwrite){
      if(!prior||prior.archived||prior.workspaceId!==flow.workspaceId)throw new Error('覆盖目标不存在、已归档或不属于目标工作区')
      if(!Number.isSafeInteger(overwrite.expectedRevision)||overwrite.expectedRevision<0||prior.revision!==overwrite.expectedRevision)throw new Error('工作流已被修改，请刷新版本后重新检查导入，导入草稿不会被覆盖')
    }
    if(new Set(presets.map(preset=>preset.id)).size!==presets.length||presets.some(preset=>preset.revision!==0||this.state.presets.some(value=>value.id===preset.id)))throw new Error('导入角色身份重复或未重建')
    if(presets.some(preset=>preset.scope==='workflow'&&!flows.some(flow=>flow.id===preset.workflowId)))throw new Error('导入预设不属于随包工作流')
    for(const candidate of flows)assertRolePresetScope({...candidate,id:prior&&candidate.id===flow.id?prior.id:candidate.id},[...this.state.presets,...presets.map(preset=>preset.scope==='workflow'&&prior&&preset.workflowId===flow.id?{...preset,workflowId:prior.id}:preset)])
    // Missing external roles remain explicit references in an editable canvas.
    // Host readiness and runtime snapshot validation block their execution.
    const now=new Date().toISOString(),saved={...renumberWorkflow(flow),scope:prior?prior.scope:'workspace' as const,id:prior?.id??flow.id,revision:(prior?.revision??0)+1,createdAt:prior?.createdAt??now,updatedAt:now},next=clone(this.state)
    if(prior)next.workflows=next.workflows.map(value=>value.id===prior.id?saved:value)
    else next.workflows.push(saved)
    next.workflows.push(...children.map(child=>({...renumberWorkflow(child),revision:1,createdAt:now,updatedAt:now})))
    if(prior)for(const candidate of next.workflows.filter(candidate=>candidate.id===saved.id||children.some(child=>child.id===candidate.id)))for(const node of allNodes(candidate)){if(node.config.toolId===`workflow:${flow.id}`)node.config.toolId=`workflow:${prior.id}`;if(node.config.tools)node.config.tools=node.config.tools.map(id=>id===`workflow:${flow.id}`?`workflow:${prior.id}`:id)}
    next.presets.push(...presets.map(preset=>({...preset,...(preset.scope==='workflow'&&prior&&preset.workflowId===flow.id?{workflowId:prior.id}:{}),revision:1})));this.persist(next);return clone(next.workflows.find(candidate=>candidate.id===saved.id)!)
  }
  httpCacheSettings():HttpCacheSettings {return clone(this.state.httpCacheSettings??DEFAULT_HTTP_CACHE_SETTINGS)}
  saveHttpCacheSettings(value:unknown):HttpCacheSettings {
    const patch=httpCacheSettingsSchema.partial().parse(value),settings=httpCacheSettingsSchema.parse({...this.httpCacheSettings(),...patch})
    this.persist({...this.state,httpCacheSettings:settings});return this.httpCacheSettings()
  }
  presets(workflowId?:string): RolePreset[] { return clone(workflowId===undefined?this.state.presets:rolePresetsForWorkflow(this.state.presets,workflowId)) }
  savePreset(value: unknown, actor:'user'|'agent'='user'): RolePreset[] {
    const preset = presetSchema.parse(value), prior = this.state.presets.find(p => p.id === preset.id)
    if(preset.scope==='workflow'&&!this.state.workflows.some(flow=>flow.id===preset.workflowId&&!flow.archived))throw new Error('预设所属工作流不存在或已归档')
    for(const flow of this.state.workflows)assertRolePresetScope(flow,[preset])
    if ((prior?.revision ?? 0) !== preset.revision) throw new Error('预设已被修改，请刷新后再保存')
    if(prior&&prior.name===preset.name&&prior.prompt===preset.prompt&&prior.summary===preset.summary&&prior.scope===preset.scope&&prior.workflowId===preset.workflowId)return this.presets()
    if(actor==='agent'&&prior&&prior.prompt!==preset.prompt&&this.state.workflows.some(flow=>allNodes(flow).some(node=>node.fixed&&(node.config.rolePresetId===preset.id||(node.config.body&&allNodes(node.config.body).some(child=>child.config.rolePresetId===preset.id))))))throw new Error('此角色预设被固定节点使用，请由用户修改')
    const next = clone(this.state); next.presets = next.presets.filter(p => p.id !== preset.id); next.presets.push({ ...preset, revision: preset.revision + 1 })
    this.persist(next); return this.presets()
  }
  deletePreset(id: string): RolePreset[] {
    if (this.state.workflows.some(w => allNodes(w).some(n => n.config.rolePresetId === id))) throw new Error('此预设仍被工作流使用，请先在节点配置中取消选择')
    const next = clone(this.state); next.presets = next.presets.filter(p => p.id !== id); this.persist(next); return this.presets()
  }
  runs(workspaceId: string = ''): WorkflowRun[] {
    return this.state.runs.filter(r => !workspaceId || r.workspaceId === workspaceId).toReversed().sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(run=>this.presentRun(run))
  }
  run(id: string): WorkflowRun { const r = this.state.runs.find(r => r.id === id); if (!r) throw new Error('运行记录不存在'); return this.presentRun(r) }
  saveRun(run: WorkflowRun): void {
    if(this.closed)throw new Error('工作流存储已关闭')
    run=normalizeRun(this.redactCachedText(run.id,run))
    parseWorkflow(run.graph)
    const previous=this.state.runs.find(item=>item.id===run.id)
    if(previous&&JSON.stringify(previous)===JSON.stringify(run))return
    const next = clone(this.state)
    const ix = next.runs.findIndex(r => r.id === run.id)
    if (ix >= 0) next.runs[ix] = clone(run); else next.runs.push(clone(run))
    // Keep all active runs and the latest 200 finished runs.
    const finished = next.runs.filter(r => !['running', 'waiting','pausing','paused','budget_waiting'].includes(r.status)).sort((a,b) => b.startedAt.localeCompare(a.startedAt))
    const keep = new Set(finished.slice(0, 200).map(r => r.id))
    next.runs = next.runs.filter(r => ['running', 'waiting','pausing','paused','budget_waiting'].includes(r.status) || keep.has(r.id))
    this.writeRun(run);this.appendRunEvent(run)
    for(const prior of [...this.state.runs,run])if(!next.runs.some(item=>item.id===prior.id))this.removeRunArtifacts(prior.id)
    this.state=next
    this.httpCache.cleanup()
    for(const listener of this.runSaved)try{listener(this.presentRun(run))}catch{}
  }
  /** Observe every persisted run transition. @returns Disposer for the listener. */
  onRunSaved(listener:(run:WorkflowRun)=>void):()=>void{this.runSaved.add(listener);return ()=>{this.runSaved.delete(listener)}}
  private removeRunArtifacts(id:string):void {
    // Validate identity before constructing paths, including a newly inserted
    // historical run that falls outside the retention window immediately.
    this.runFile(id)
    for(const suffix of ['.json','.events.jsonl','.events.quarantine.jsonl']){
      const file=join(this.runDirectory(),`${id}${suffix}`)
      if(existsSync(file)&&!lstatSync(file).isSymbolicLink())rmSync(file)
    }
    this.runEventHeads.delete(id)
    this.httpCache.remove(id)
    this.hydratedBodies.delete(id)
    const base=join(this.directory,'attachments'),directory=join(base,id)
    // Attachments belong exclusively to this run. Do not traverse redirected
    // parents or run directories; recursive removal unlinks child symlinks.
    if(existsSync(base)&&!lstatSync(base).isSymbolicLink()&&existsSync(directory)&&!lstatSync(directory).isSymbolicLink())rmSync(directory,{recursive:true})
  }
  /** Transient cache owners never enter workflow history or the run journal. */
  beginSessionHttpCacheOwner(runId?:string):string {
    if(this.closed)throw new Error('工作流存储已关闭')
    if(runId){const owner=this.sessionHttpOwners.get(runId);if(!owner)throw new Error('会话 HTTP 缓存身份已失效');owner.status='running';delete owner.endedAt;return runId}
    const id=randomUUID();this.sessionHttpOwners.set(id,{id,status:'running',startedAt:new Date().toISOString()});return id
  }
  finishSessionHttpCacheOwner(runId:string):void {
    const owner=this.sessionHttpOwners.get(runId);if(!owner)return
    owner.status='success';owner.endedAt=new Date().toISOString();this.releaseCachedReads(runId);this.httpCache.cleanup()
  }
  cacheHttpBody(runId:string,nodeId:string,attempt:number,bytes:Uint8Array,contentType:string):CachedBody {
    if(this.closed)throw new Error('工作流存储已关闭')
    return this.httpCache.write(runId,nodeId,attempt,bytes,contentType)
  }
  /** Host-only hook for a builtin HTML tool's exact-reference argument. No Remote API. */
  readCachedBody(runId:string,ref:CachedBody):Buffer {
    const bytes=this.httpCache.read(runId,ref),known=this.hydratedBodies.get(runId)??new Map<string,CachedBody>()
    known.set(bytes.toString('utf8'),ref);this.hydratedBodies.set(runId,known);return bytes
  }
  compactCachedData(runId:string,value:JsonValue,nodeId:string,attempt:number):JsonValue {
    const known=this.hydratedBodies.get(runId)
    if(typeof value==='string'){
      const ref=known?.get(value);if(ref)return ref
      if(known&&[...known.keys()].some(text=>text.length>2000&&value.includes(text)))return this.cacheHttpBody(runId,nodeId,attempt,Buffer.from(value),'text/plain')
      return value
    }
    if(isCachedBody(value))return value
    if(Array.isArray(value))return value.map(item=>this.compactCachedData(runId,item,nodeId,attempt))
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,this.compactCachedData(runId,item,nodeId,attempt)]))
    return value
  }
  releaseCachedReads(runId:string):void {this.hydratedBodies.delete(runId)}
  /** Keep expanded HTTP text out of persisted records, client payloads and logs. */
  redactCachedText<T>(runId:string,value:T):T {
    const known=this.hydratedBodies.get(runId);if(!known?.size)return value
    const json=JSON.stringify(value,(_key,item)=>{
      if(typeof item!=='string')return item
      for(const [text,ref]of known){if(!text)continue;const preview=JSON.stringify(ref);item=item.replaceAll(text,()=>preview);const escaped=JSON.stringify(text).slice(1,-1);if(escaped!==text)item=item.replaceAll(escaped,()=>JSON.stringify(preview).slice(1,-1))}
      return item
    })
    return JSON.parse(json) as T
  }
  private presentRun(run:WorkflowRun):WorkflowRun {
    const present=(ref:CachedBody)=>({...ref,$cachedBody:{...ref.$cachedBody,evicted:!this.httpCache.available(run.id,ref)}})
    const display=(value:JsonValue):JsonValue=>{
      if(typeof value==='string'&&value.includes('"$cachedBody"')){try{return JSON.stringify(mapCachedBodies(JSON.parse(value) as JsonValue,present))}catch{return value}}
      return mapCachedBodies(value,present)
    }
    const copy=clone(run)
    for(const [key,value]of Object.entries(copy.outputs))copy.outputs[key]=display(value) as string
    for(const record of copy.executions){
      if(record.data)record.data=display(record.data) as typeof record.data
      if(record.input)record.input=display(record.input) as string
      if(record.output)record.output=display(record.output) as string
      if(isCachedBody(record.data?.text))record.output=JSON.stringify(record.data.text)
    }
    return copy
  }
  /** Upload bytes stay private and never enter Remote run payloads or node logs. */
  stageAttachment(runId: string, value: JsonValue): JsonValue {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('文件输入必须为文件对象')
    if (typeof value.workflowFileId === 'string') {
      const file = this.readAttachment(runId, value.workflowFileId)
      return { name: file.name, mimeType: file.mimeType, workflowFileId: value.workflowFileId, size: Buffer.from(file.base64, 'base64').length }
    }
    if (typeof value.path === 'string' && typeof value.base64 !== 'string') return { path: value.path }
    if (typeof value.name !== 'string' || !value.name || value.name.length > 256 || typeof value.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64) || value.base64.length % 4 !== 0) throw new Error('文件需要有效 name 与 base64 内容')
    const bytes = Buffer.from(value.base64, 'base64')
    if (bytes.length > 2 * 1024 * 1024) throw new Error('单个上传文件不能超过 2 MB')
    const directory = this.attachmentDirectory(runId, true)
    if (readdirSync(directory).reduce((sum, name) => sum + statSync(join(directory, name)).size, 0) + value.base64.length > 30_000_000) throw new Error('本次运行的附件累计超过 20 MB')
    const id = randomUUID(), mimeType = typeof value.mimeType === 'string' ? value.mimeType.slice(0, 256) : 'application/octet-stream'
    writeFileSync(join(directory, `${id}.json`), JSON.stringify({ runId, name: value.name, mimeType, base64: value.base64 }), { flag: 'wx', mode: 0o600 })
    return { name: value.name, mimeType, workflowFileId: id, size: bytes.length }
  }
  readAttachment(runId: string, fileId: string): { name: string; mimeType: string; base64: string } {
    this.run(runId) // The caller must refer to a real run; directory ownership is part of the identity.
    if (!/^[a-f0-9-]{36}$/.test(fileId)) throw new Error('附件身份无效')
    const file = join(this.attachmentDirectory(runId, false), `${fileId}.json`)
    if (!existsSync(file) || lstatSync(file).isSymbolicLink() || statSync(file).size > 3_000_000) throw new Error('附件不存在、超限或不属于本次运行')
    const value = JSON.parse(readFileSync(file, 'utf8')) as { runId: string; name: string; mimeType: string; base64: string }
    if (value.runId !== runId || typeof value.name !== 'string' || typeof value.base64 !== 'string') throw new Error('附件不属于本次运行')
    return { name: value.name, mimeType: value.mimeType, base64: value.base64 }
  }
  private attachmentDirectory(runId: string, create: boolean): string {
    if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('附件运行身份无效')
    const base = join(this.directory, 'attachments'), directory = join(base, runId)
    if (existsSync(base) && lstatSync(base).isSymbolicLink()) throw new Error('附件存储目录无效')
    if (create && !existsSync(base)) mkdirSync(base, { mode: 0o700 })
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error('附件存储目录无效')
    if (create && !existsSync(directory)) mkdirSync(directory, { mode: 0o700 })
    if (!existsSync(base) || !existsSync(directory) || lstatSync(base).isSymbolicLink() || lstatSync(directory).isSymbolicLink()) throw new Error('附件存储目录无效')
    return directory
  }
  private release(): void {
    if (existsSync(this.lock)) {
      const owner = JSON.parse(readFileSync(this.lock, 'utf8')) as { token: string }
      if (owner.token === this.token) rmSync(this.lock)
    }
  }
  close(): void { if (this.closed) return;try{if(this.sessionHttpOwners.size){this.sessionHttpOwners.clear();this.httpCache.cleanup()}}finally{this.release();this.closed = true;this.runEventHeads.clear();this.hydratedBodies.clear()} }
}
