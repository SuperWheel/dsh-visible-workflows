import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JsonValue, NodeGraph } from '../shared/types.ts'
import { ensureGraphonEnvironment } from './graphon-environment.ts'

export interface GraphonNodeResult { data: Record<string, JsonValue>; selectedPort?: string; activePorts?: string[]; control?: 'pause' | 'exit_loop' }
export interface GraphonResult { status: 'success' | 'paused' | 'exit_loop' | 'failed' | 'cancelled'; error?: string }
export interface TokenEstimate { tokens: number; encoding: string; estimated: true }
interface Pending {
  resolve: (value: any) => void
  reject: (error: Error) => void
  node?: (nodeId: string, signal: AbortSignal) => Promise<GraphonNodeResult>
  skipped?: (nodeId: string) => void
  calls: Set<Promise<void>>
  controller: AbortController
  signal: AbortSignal
  cleanup: () => void
}

function packageDirectory(): string {
  let path = dirname(fileURLToPath(import.meta.url))
  for (let n = 0; n < 8; n++) {
    const manifest = join(path, 'package.json')
    if (existsSync(manifest)) {
      try { if (JSON.parse(readFileSync(manifest, 'utf8')).name === 'dsh-visible-dynamic-workflows') return path } catch {}
    }
    const parent = dirname(path); if (parent === path) break; path = parent
  }
  throw new Error('无法定位工作流运行时安装目录，请重新安装插件')
}

/** One private local engine per plugin lifecycle. Node effects remain in the authenticated host. */
export class GraphonBridge {
  private child?: ChildProcessWithoutNullStreams
  private starting?: Promise<void>
  private readonly lifetime = new AbortController()
  private readonly pending = new Map<string, Pending>()
  private readonly activeCalls = new Map<Promise<void>, AbortController>()
  private closed = false
  private ready?: { resolve: () => void; reject: (error: Error) => void }
  readonly engine = { name: 'graphon' as const, version: '0.7.0', protocol: 1 }
  constructor(private readonly directory: string, private readonly options: { assetsDirectory?: string; bridgePath?: string; verifyRuntimeContents?: boolean } = {}) {}

  private async start(): Promise<void> {
    if (this.closed) throw new Error('工作流引擎已关闭')
    if (this.starting) return this.starting
    this.starting = this.boot().catch(error => { this.starting = undefined; throw error })
    return this.starting
  }
  private async boot(): Promise<void> {
    const root = packageDirectory()
    const runtime = await ensureGraphonEnvironment({ directory: this.directory, assetsDirectory: this.options.assetsDirectory ?? join(root, 'runtime-assets'), signal: this.lifetime.signal, verifyRuntimeContents: this.options.verifyRuntimeContents })
    this.lifetime.signal.throwIfAborted()
    const script = this.options.bridgePath ?? join(root, 'runtime', 'graphon_bridge', 'main.py')
    if (!existsSync(script)) throw new Error('工作流引擎文件缺失，请重新安装插件')
    const env = { ...runtime.env }
    const child = spawn(runtime.python, ['-I', '-B', '-u', script], { env, cwd: runtime.directory, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    let buffer = '', diagnostics = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-3000) })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 4_000_000) { this.fail(new Error('工作流引擎响应超限')); return }
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        try { this.receive(JSON.parse(line)) } catch { this.fail(new Error('工作流引擎返回了无效协议消息')) }
      }
    })
    child.on('error', error => this.fail(new Error(`工作流引擎无法启动：${error.message}`)))
    child.on('exit', code => {
      if (this.child !== child) return
      this.fail(new Error(`工作流引擎已退出（${code ?? '信号'}）${diagnostics ? `：${diagnostics.trim()}` : ''}`))
    })
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => this.fail(new Error('工作流引擎启动超时，请重试或重新安装插件')), 20_000)
      this.ready = { resolve: () => { clearTimeout(timer); this.ready = undefined; resolveReady() }, reject: error => { clearTimeout(timer); this.ready = undefined; reject(error) } }
    })
  }
  private send(message: object): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error('工作流引擎连接已关闭')
    const line = JSON.stringify(message)
    if (line.length > 4_000_000) throw new Error('工作流引擎请求超限')
    this.child.stdin.write(`${line}\n`, error => { if (error) this.fail(new Error(`工作流引擎写入失败：${error.message}`)) })
  }
  private receive(message: any): void {
    if (!message || typeof message.type !== 'string') throw new Error('invalid frame')
    if (message.type === 'ready') {
      if (message.engine !== 'graphon' || message.version !== this.engine.version || message.protocol !== this.engine.protocol) { this.fail(new Error('工作流引擎版本与插件不匹配')); return }
      this.ready?.resolve(); return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return // Late replies to cancelled/closed requests never start new work.
    if (message.type === 'call') {
      if (!pending.node || typeof message.callId !== 'string' || typeof message.nodeId !== 'string') throw new Error('invalid call')
      const action = Promise.resolve().then(() => { pending.signal.throwIfAborted(); return pending.node!(message.nodeId, pending.signal) }).then(
        result => { if (this.pending.has(message.id)) this.send({ type: 'result', id: message.id, callId: message.callId, ...result }) },
        error => { if (this.pending.has(message.id)) this.send({ type: 'result', id: message.id, callId: message.callId, error: error instanceof Error ? error.message : String(error) }) },
      ).catch(error => this.fail(error instanceof Error ? error : new Error(String(error))))
      pending.calls.add(action); this.activeCalls.set(action, pending.controller)
      void action.finally(() => { pending.calls.delete(action); this.activeCalls.delete(action) }); return
    }
    if (message.type === 'skipped') { if (typeof message.nodeId === 'string') pending.skipped?.(message.nodeId); return }
    if (message.type === 'tokens') {
      if (typeof message.error === 'string') { pending.cleanup(); this.pending.delete(message.id); pending.reject(new Error(message.error)); return }
      if (!Number.isSafeInteger(message.count) || message.count < 0 || typeof message.encoding !== 'string' || message.estimated !== true) throw new Error('invalid token count')
      pending.cleanup(); this.pending.delete(message.id); pending.resolve({ tokens: message.count, encoding: message.encoding, estimated: true }); return
    }
    if (message.type === 'error') {
      const error = new Error(String(message.error ?? '工作流引擎请求失败'))
      pending.controller.abort(error); pending.cleanup(); this.pending.delete(message.id); pending.reject(error); return
    }
    if (message.type === 'complete') {
      if (!['success', 'paused', 'exit_loop', 'failed', 'cancelled'].includes(message.status)) throw new Error('invalid status')
      if (message.status === 'failed' || message.status === 'cancelled') pending.controller.abort(new Error(String(message.error ?? '工作流引擎执行失败')))
      pending.cleanup(); this.pending.delete(message.id)
      void Promise.allSettled([...pending.calls]).then(() => pending.resolve({ status: message.status, error: message.error })); return
    }
    throw new Error('unknown frame')
  }
  private fail(error: Error): void {
    this.ready?.reject(error)
    const child = this.child; this.child = undefined; this.starting = undefined
    // The user's signal is deliberately untouched: an engine failure must remain
    // a failed run, while host model/tool callbacks receive cancellation promptly.
    for (const controller of this.activeCalls.values()) controller.abort(error)
    for (const request of this.pending.values()) { request.controller.abort(error); request.cleanup(); request.reject(error) }
    this.pending.clear(); child?.kill()
  }
  private async request<T>(frame: object, signal: AbortSignal, node?: Pending['node'], skipped?: Pending['skipped']): Promise<T> {
    signal.throwIfAborted(); await this.start(); signal.throwIfAborted()
    const id = randomUUID()
    return new Promise<T>((resolveRequest, reject) => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const abort = () => {
        try { this.send({ type: 'cancel', id }) } catch {}
        timer = setTimeout(() => {
          const current = this.pending.get(id); if (!current) return
          current.cleanup(); this.pending.delete(id); reject(new Error('运行已取消'))
        }, 3000)
      }
      const cleanup = () => { signal.removeEventListener('abort', abort); if (timer) clearTimeout(timer) }
      this.pending.set(id, { resolve: resolveRequest, reject, node, skipped, cleanup, calls: new Set(), controller, signal: AbortSignal.any([signal, controller.signal]) })
      signal.addEventListener('abort', abort, { once: true })
      try { this.send({ ...frame, id }); if (signal.aborted) abort() } catch (error) { cleanup(); this.pending.delete(id); reject(error) }
    })
  }
  async execute(graph: NodeGraph, signal: AbortSignal, node: NonNullable<Pending['node']>, skipped: NonNullable<Pending['skipped']>, options:{maxWorkers?:number}={}): Promise<GraphonResult> {
    const maxWorkers=options.maxWorkers??3
    if(!Number.isInteger(maxWorkers)||maxWorkers<1||maxWorkers>8)throw new Error('图执行并发数必须在 1–8 之间')
    return this.request({ type: 'execute', maxWorkers, graph: { nodes: graph.nodes.map(n => ({ id: n.id, kind: n.kind })), edges: graph.edges.map(e => ({ id: e.id, source: e.source, target: e.target, ...(e.port ? { port: e.port } : {}) })) } }, signal, node, skipped)
  }
  async countTokens(text: string, signal: AbortSignal): Promise<TokenEstimate> { return this.request({ type: 'count_tokens', text }, signal) }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true; this.lifetime.abort()
    const child = this.child
    const stopped = child && child.exitCode === null && child.signalCode === null
      ? new Promise<void>(resolve => {
          const force = setTimeout(() => child.kill('SIGKILL'), 2000)
          child.once('close', () => { clearTimeout(force); resolve() })
        }) : Promise.resolve()
    this.fail(new Error('工作流引擎已关闭'))
    await Promise.all([stopped, Promise.allSettled([...this.activeCalls.keys()])])
  }
}

export function graphonRuntimeDirectory(storageDirectory: string): string {
  // Tests share only immutable runtime files; workflow state remains isolated.
  return process.env.DSH_WORKFLOW_RUNTIME_DIRECTORY ? resolve(process.env.DSH_WORKFLOW_RUNTIME_DIRECTORY) : join(storageDirectory, 'graphon-runtime')
}
