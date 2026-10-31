import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRecoveryPlan } from '../src/host/recovery-plan.ts'
import { reviewedRecovery } from '../src/host/recovery-review.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { makeWorkflow, type NodeConfig, type NodeKind, type Workflow, type WorkflowNode, type WorkflowRun } from '../src/shared/types.ts'

const node = (id: string, kind: NodeKind, config: NodeConfig): WorkflowNode => ({ id, kind, config, title: id, number: id, x: 0, y: 0, fixed: false })
const flow = (id: string, work: WorkflowNode): Workflow => ({ id, workspaceId: 'w', title: id, description: '', revision: 1, createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z', notes: [], nodes: [node(`${id}-input`, 'input', { fields: [] }), work, node(`${id}-output`, 'output', { text: `{{${work.id}.text}}` })], edges: [{ id: `${id}-in`, source: `${id}-input`, target: work.id }, { id: `${id}-out`, source: work.id, target: `${id}-output` }] })
const source = (graph: Workflow, dependencySnapshots: Record<string, Workflow> = {}): WorkflowRun => ({ id: 'historical', workflowId: graph.id, workspaceId: 'w', workflowTitle: graph.title, sourceRevision: 1, graph, dependencySnapshots, status: 'failed', inputs: {}, outputs: {}, startedAt: '2026-10-18T00:00:00Z', executions: graph.nodes.map(n => ({ nodeId: n.id, executionId: n.id, title: n.title, number: n.number, status: 'success', data: { text: 'historical' }, output: 'historical', startedAt: '2026-10-18T00:00:00Z' })) })
const work = (run: WorkflowRun) => buildRecoveryPlan(run, 'resume').items.find(item => item.nodeId === run.graph.nodes[1]!.id)!
const cases: { name: string; kind: NodeKind; config: NodeConfig }[] = [
  { name: 'timestamp', kind: 'tool', config: { toolId: 'builtin:time.timestamp', inputs: {} } },
  { name: 'weekday without datetime', kind: 'tool', config: { toolId: 'builtin:time.weekday', inputs: {} } },
  { name: 'current time', kind: 'tool', config: { toolId: 'builtin:time.now' } },
  { name: 'knowledge', kind: 'knowledge', config: { query: 'fixed', sources: ['notes.txt'] } },
  { name: 'document', kind: 'document', config: { source: 'notes.txt' } },
  { name: 'protected credential', kind: 'http', config: { credentialOperation: { secretVariableId: 'token', operationId: 'deepseek.account-status.v1' } } },
  { name: 'random code', kind: 'code', config: { code: 'function main() { return { value: Math.random() } }' } },
  { name: 'file input', kind: 'input', config: { fields: [{ name: 'file', label: 'File', type: 'file', required: true }] } },
  { name: 'required file', kind: 'template', config: { text: 'fixed', verification: { requiredFiles: ['result.txt'] } } },
  { name: 'required read', kind: 'template', config: { text: 'fixed', verification: { requiredReadFiles: ['source.txt'] } } },
  { name: 'required change', kind: 'template', config: { text: 'fixed', verification: { requiredChangedFiles: ['result.txt'] } } },
]

describe('dynamic evidence cannot be hidden by a cached caller', () => {
  it.each(cases)('invalidates direct $name and propagates through child, grandchild and containers', ({ kind, config }) => {
    const direct = source(flow('direct', node('dynamic', kind, { ...config, cache: 'reuse' })))
    expect(work(direct).action).toBe(['tool', 'http', 'document'].includes(kind) ? 'blocked' : 'rerun')
    for (const wrapped of [false, true]) {
      const leaf = node('dynamic', kind, { ...config, cache: 'reuse' })
      const grandchild = flow('grandchild', wrapped ? node('container', 'iteration', { iterator: '[1]', body: { nodes: [leaf], edges: [] } }) : leaf)
      const child = flow('child', node('call-grandchild', 'tool', { toolId: 'workflow:grandchild', cache: 'reuse' }))
      for (const callerKind of ['tool', 'agent'] as const) {
        const root = flow('root', node('caller', callerKind, { ...(callerKind === 'tool' ? { toolId: 'workflow:child' } : { tools: ['workflow:child'] }), cache: 'reuse' }))
        const run = source(root, { child, grandchild }), before = JSON.stringify(run), plan = buildRecoveryPlan(run, 'resume')
        expect(plan.allowed).toBe(false); expect(work(run)).toMatchObject({ action: 'blocked', reviewCanComplete: false, reason: expect.stringContaining('已完成的外部操作不能自动重放') })
        expect(plan.items.find(item => item.nodeId === 'root-output')?.action).toBe('rerun')
        expect(JSON.stringify(run)).toBe(before); expect(buildRecoveryPlan(run, 'resume').planDigest).toBe(plan.planDigest)
      }
    }
  })
  it('allows cached deterministic child results, including weekday with fixed datetime and timestamp conversion', () => {
    for (const leaf of [node('fixed', 'template', { text: 'fixed' }), node('fixed', 'tool', { toolId: 'builtin:time.weekday', inputs: { datetime: '2026-10-18T00:00:00Z' } }), node('fixed', 'tool', { toolId: 'builtin:time.from_timestamp', inputs: { timestamp: 0 } })]) {
      const child = flow('child', leaf), root = flow('root', node('caller', 'tool', { toolId: 'workflow:child', cache: 'reuse' })), run = source(root, { child })
      expect(work(run).action).toBe('reuse'); expect(buildRecoveryPlan(run, 'resume').allowed).toBe(true)
    }
  })
  it('treats an Agent current-clock capability as dynamic even if config inputs happen to specify a datetime', () => {
    const run = source(flow('root', node('caller', 'agent', { tools: ['builtin:time.weekday'], inputs: { datetime: '2026-10-18T00:00:00Z' }, cache: 'reuse' })))
    expect(work(run).action).toBe('blocked')
  })
  it('does not let caller caching override an explicit child cache prohibition', () => {
    const child = flow('child', node('fixed', 'template', { text: 'fixed', cache: 'never' })), run = source(flow('root', node('caller', 'tool', { toolId: 'workflow:child', cache: 'reuse' })), { child })
    expect(work(run)).toMatchObject({ action: 'blocked', reason: expect.stringContaining('禁止结果复用') })
  })
  it('fails closed without a child snapshot and terminates cycles without guessing reusability', () => {
    const root = flow('root', node('caller', 'tool', { toolId: 'workflow:child', cache: 'reuse' })), run = source(root)
    expect(work(run)).toMatchObject({ action: 'blocked', reason: expect.stringContaining('缺少冻结快照') })
    run.dependencySnapshots = { child: flow('child', node('cycle', 'tool', { toolId: 'workflow:child', cache: 'reuse' })) }
    expect(work(run)).toMatchObject({ action: 'blocked', reason: expect.stringContaining('递归调用') })
  })
  it('uses frozen child roles and never treats a parent run identity as the identity of a new child run', () => {
    const child = flow('child', node('role', 'llm', { cache: 'reuse' })), root = flow('root', node('caller', 'tool', { toolId: 'workflow:child', cache: 'reuse' })), run = source(root, { child })
    run.dependencyRolePrompts = { child: { role: 'Time {{sys.timestamp}}' } }; run.systemVariables = { workflow_run_id: 'historical', timestamp: 1 }
    const plan = buildRecoveryPlan(run, 'resume', root, { systemVariables: run.systemVariables })
    expect(plan.items.find(item => item.nodeId === 'caller')).toMatchObject({ action: 'blocked', reviewCanComplete: false })
  })
  it('requires explicit redo for a completed dynamic caller and does not authorize it through a manual completion receipt', () => {
    const child = flow('child', node('clock', 'tool', { toolId: 'builtin:time.timestamp' })), run = source(flow('root', node('caller', 'tool', { toolId: 'workflow:child', cache: 'reuse' })), { child }), base = reviewedRecovery(run).plan
    const decision = { executionId: 'caller', evidence: 'User checked prior receipt' }
    expect(() => reviewedRecovery(run, { baseDigest: base.planDigest, decisions: [{ ...decision, action: 'completed', output: { text: 'old' } }] })).toThrow('绕过失效规则')
    const redo = reviewedRecovery(run, { baseDigest: base.planDigest, decisions: [{ ...decision, action: 'redo' }] }).plan
    expect(redo.allowed).toBe(true); expect(redo.items.find(item => item.nodeId === 'caller')?.action).toBe('rerun')
  })
  it('binds identity preservation to the confirmation digest as well as the plan decision', () => {
    const run = source(flow('root', node('identity', 'template', { text: '{{sys.timestamp}}', cache: 'reuse' }))); run.systemVariables = { workflow_run_id: 'historical', timestamp: 1 }
    const fresh = buildRecoveryPlan(run, 'resume'), same = buildRecoveryPlan(run, 'resume', run.graph, { systemVariables: run.systemVariables })
    expect(fresh.items.find(item => item.nodeId === 'identity')?.action).toBe('rerun'); expect(same.items.find(item => item.nodeId === 'identity')?.action).toBe('reuse')
    expect(same.planDigest).not.toBe(fresh.planDigest)
    expect(buildRecoveryPlan(run, 'resume', run.graph, { systemVariables: run.systemVariables }).planDigest).toBe(same.planDigest)
  })
  it.each([false, true])('runtime recovery enforces dynamic=%s before launching an adapter, and only explicit redo can repeat it', async dynamic => {
    const directory = mkdtempSync(join(tmpdir(), 'recovery-dynamic-runtime-')), storage = new WorkflowStorage(directory)
    let calls = 0
    const runtime = new WorkflowRuntime(storage, { generate: async () => { throw new Error('No model calls') } }, { execute: async () => { calls++; return { text: 'fresh' } } })
    try {
      const child = makeWorkflow('w', 'Child', true), graph = makeWorkflow('w', 'Root', true)
      child.nodes[1]!.kind = dynamic ? 'tool' : 'template'; child.nodes[1]!.config = dynamic ? { toolId: 'builtin:time.timestamp', cache: 'reuse' } : { text: 'fixed' }
      graph.nodes[1]!.kind = 'tool'; graph.nodes[1]!.config = { toolId: `workflow:${child.id}`, cache: 'reuse', inputs: { text: '{{input.text}}' } }
      const saved = storage.save(graph, 0), run = source(saved, { [child.id]: child }); run.inputs = { text: 'fixed' }
      run.executions[0]!.data = { text: 'fixed' }; run.executions[2]!.status = 'failed'; delete run.executions[2]!.data
      storage.saveRun(run)
      const original = storage.run(run.id), base = runtime.recoveryPlan(run.id), caller = graph.nodes[1]!.id
      if (dynamic) {
        expect(() => runtime.recover(run.id, 'resume', undefined, base.planDigest)).toThrow('不能自动重放'); expect(calls).toBe(0)
        const review = { baseDigest: base.planDigest, decisions: [{ executionId: caller, action: 'redo', evidence: 'Checked old result; rerun approved for this test' }] }, plan = runtime.recoveryPlan(run.id, review)
        const done = await runtime.settle(runtime.recover(run.id, 'resume', undefined, plan.planDigest, review).id)
        expect(done.status).toBe('success'); expect(done.outputs.result).toBe('fresh'); expect(calls).toBe(1)
      } else {
        const done = await runtime.settle(runtime.recover(run.id, 'resume', undefined, base.planDigest).id)
        expect(done.status).toBe('success'); expect(done.outputs.result).toBe('historical'); expect(calls).toBe(0)
      }
      expect(storage.run(run.id)).toEqual(original)
    } finally { await runtime.close(); rmSync(directory, { recursive: true, force: true }) }
  })
})
