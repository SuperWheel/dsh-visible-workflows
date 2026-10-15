import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { JsonValue, RolePreset, Workflow, WorkflowRun } from '../shared/types.ts'
import { renumberWorkflow } from '../shared/numbering.ts'
import { allNodes, assertGraph, parseWorkflow, presetSchema, protectFixedNodes } from './validation.ts'

interface StoreState { schema: 1; workflows: Workflow[]; presets: RolePreset[]; runs: WorkflowRun[] }
const clone = <T>(v: T): T => structuredClone(v)

/** This plugin alone owns this private directory. Every mutation is a single atomic JSON replacement. */
export class WorkflowStorage {
  private state: StoreState = { schema: 1, workflows: [], presets: [], runs: [] }
  private readonly file: string
  private readonly lock: string
  private readonly token = randomUUID()
  private closed = false

  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (lstatSync(directory).isSymbolicLink()) throw new Error('工作流存储目录不能是符号链接')
    chmodSync(directory, 0o700)
    this.file = join(directory, 'library.json'); this.lock = join(directory, 'host.lock')
    if (existsSync(this.lock)) {
      if (lstatSync(this.lock).isSymbolicLink()) throw new Error('工作流锁文件无效')
      const owner = JSON.parse(readFileSync(this.lock, 'utf8')) as { pid?: number }
      if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0) throw new Error('工作流锁文件无效，请检查存储目录')
      try { process.kill(owner.pid!, 0); throw new Error('工作流存储已由其他 Host 占用') }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e }
      rmSync(this.lock)
    }
    writeFileSync(this.lock, JSON.stringify({ pid: process.pid, token: this.token }), { flag: 'wx', mode: 0o600 })
    try {
      if (existsSync(this.file)) {
        if (lstatSync(this.file).isSymbolicLink()) throw new Error('工作流存储文件不能是符号链接')
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as StoreState
        if (raw.schema !== 1 || !Array.isArray(raw.workflows) || !Array.isArray(raw.presets) || !Array.isArray(raw.runs)) throw new Error('工作流存储格式无效')
        this.state = { schema: 1, workflows: raw.workflows.map(parseWorkflow), presets: raw.presets.map(v => presetSchema.parse(v)), runs: raw.runs }
        for (const run of this.state.runs) {
          parseWorkflow(run.graph)
          if (!run.id || !Array.isArray(run.executions) || !run.inputs || !run.outputs) throw new Error('运行记录格式无效')
          if (run.status === 'running') {
            run.status = 'interrupted'; run.error = 'Host 已重新启动；未自动重放可能产生费用的节点'; run.endedAt = new Date().toISOString()
            for (const exec of run.executions) if (exec.status === 'running') { exec.status = 'failed'; exec.error = '执行被中断'; exec.endedAt = run.endedAt }
          }
        }
        this.persist(this.state)
      }
    } catch (error) { this.release(); throw error }
  }

  private persist(next: StoreState): void {
    if (this.closed) throw new Error('工作流存储已关闭')
    const temp = join(this.directory, `library-${randomUUID()}.tmp`)
    let fd: number | undefined
    try {
      fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); closeSync(fd); fd = undefined
      renameSync(temp, this.file)
      this.state = next
    } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) rmSync(temp) }
  }
  workflows(workspaceId: string = ''): Workflow[] { return clone(this.state.workflows.filter(w => !workspaceId || w.workspaceId === workspaceId)) }
  get(id: string): Workflow { const w = this.state.workflows.find(w => w.id === id); if (!w) throw new Error('工作流不存在或已删除'); return clone(w) }
  save(value: unknown, expectedRevision: number, actor: 'user' | 'agent' = 'user'): Workflow {
    const flow = parseWorkflow(value); assertGraph(flow)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('版本号无效')
    const prior = this.state.workflows.find(w => w.id === flow.id)
    if ((prior?.revision ?? 0) !== expectedRevision || (!prior && expectedRevision !== 0)) throw new Error('工作流已被修改，请刷新后再保存，避免覆盖其他修改')
    if (prior && this.state.runs.some(r => r.workflowId === flow.id && ['running', 'waiting'].includes(r.status))) throw new Error('当前版本暂不支持运行中改图，请先结束或取消运行，再保存修改')
    if (prior && flow.workspaceId !== prior.workspaceId) throw new Error('不能直接变更工作流所属工作区，请复制为新流程')
    if (prior && actor === 'agent') protectFixedNodes(prior, flow)
    const now = new Date().toISOString()
    const saved: Workflow = { ...renumberWorkflow(flow), revision: expectedRevision + 1, createdAt: prior?.createdAt ?? now, updatedAt: now }
    const next = clone(this.state); next.workflows = next.workflows.filter(w => w.id !== saved.id); next.workflows.push(saved)
    this.persist(next); return clone(saved)
  }
  remove(id: string, expectedRevision: number): void {
    const flow = this.get(id)
    if (flow.revision !== expectedRevision) throw new Error('工作流版本已变化，请刷新后再删除')
    if (this.state.runs.some(r => r.workflowId === id && ['running', 'waiting'].includes(r.status))) throw new Error('请先取消此工作流的当前运行')
    const next = clone(this.state); next.workflows = next.workflows.filter(w => w.id !== id); this.persist(next)
  }
  presets(): RolePreset[] { return clone(this.state.presets) }
  savePreset(value: unknown): RolePreset[] {
    const preset = presetSchema.parse(value), prior = this.state.presets.find(p => p.id === preset.id)
    if ((prior?.revision ?? 0) !== preset.revision) throw new Error('预设已被修改，请刷新后再保存')
    const next = clone(this.state); next.presets = next.presets.filter(p => p.id !== preset.id); next.presets.push({ ...preset, revision: preset.revision + 1 })
    this.persist(next); return this.presets()
  }
  deletePreset(id: string): RolePreset[] {
    if (this.state.workflows.some(w => allNodes(w).some(n => n.config.rolePresetId === id))) throw new Error('此预设仍被工作流使用，请先在节点配置中取消选择')
    const next = clone(this.state); next.presets = next.presets.filter(p => p.id !== id); this.persist(next); return this.presets()
  }
  runs(workspaceId: string = ''): WorkflowRun[] {
    return clone(this.state.runs.filter(r => !workspaceId || r.workspaceId === workspaceId).reverse().sort((a, b) => b.startedAt.localeCompare(a.startedAt)))
  }
  run(id: string): WorkflowRun { const r = this.state.runs.find(r => r.id === id); if (!r) throw new Error('运行记录不存在'); return clone(r) }
  saveRun(run: WorkflowRun): void {
    const next = clone(this.state)
    const ix = next.runs.findIndex(r => r.id === run.id)
    if (ix >= 0) next.runs[ix] = clone(run); else next.runs.push(clone(run))
    // Keep all active runs and the latest 200 finished runs.
    const finished = next.runs.filter(r => !['running', 'waiting'].includes(r.status)).sort((a,b) => b.startedAt.localeCompare(a.startedAt))
    const keep = new Set(finished.slice(0, 200).map(r => r.id))
    next.runs = next.runs.filter(r => ['running', 'waiting'].includes(r.status) || keep.has(r.id))
    this.persist(next)
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
  close(): void { if (this.closed) return; this.release(); this.closed = true }
}
