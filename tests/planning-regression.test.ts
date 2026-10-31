import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { makeWorkflow, type ParameterField, type Workflow, type WorkflowNode } from '../src/shared/types.ts'
import type { ConversationEvidence, ConversationEvidenceRecord } from '../src/shared/retrospective.ts'
import type { OptimizationRegressionCase } from '../src/shared/planning-optimization.ts'
import { conversationEvidenceDigest } from '../src/host/planning/conversation-evidence.ts'
import { runPlanningRegression, type PlanningRegressionOptions } from '../src/host/planning/regression.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'

const ref = (pointer = '', evidenceId = 'e5') => ({ evidenceId, pointer })
function fixture(expected: unknown = { text: '你好 Ada' }, source: unknown = { name: 'Ada' }, args: unknown = {}): ConversationEvidence {
  const records: ConversationEvidenceRecord[] = [
    { id: 'e1', seq: 1, kind: 'user', status: 'statement', text: '请整理姓名问候', truncated: false },
    { id: 'e2', seq: 2, kind: 'tool-call', status: 'reported-success', text: '{}', callId: 'source-call', toolName: 'recorded-source', truncated: false },
    { id: 'e3', seq: 3, kind: 'tool-result', status: 'reported-success', text: JSON.stringify(source), callId: 'source-call', toolName: 'recorded-source', truncated: false },
    { id: 'e4', seq: 4, kind: 'tool-call', status: 'reported-success', text: JSON.stringify(args), callId: 'target-call', toolName: 'recorded-transform', truncated: false },
    { id: 'e5', seq: 5, kind: 'tool-result', status: 'reported-success', text: JSON.stringify(expected), callId: 'target-call', toolName: 'recorded-transform', truncated: false },
  ]
  const value = { version: 1 as const, sessionId: 'completed-conversation', fromSeq: 1, throughSeq: 5, records, warnings: [] }
  return { ...value, digest: conversationEvidenceDigest(value) }
}
function node(id: string, kind: WorkflowNode['kind'], config: WorkflowNode['config']): WorkflowNode {
  return { id, number: '', title: id, kind, config, fixed: false, x: 0, y: 0 }
}
function workflow(target = node('transform', 'template', { inputs: { name: '{{source.name}}' }, text: '你好 {{name}}' })): Workflow {
  const nodes = [node('start', 'input', { fields: [] }), node('source', 'tool', { toolId: 'must-not-call' }), target, node('out', 'output', { text: '{{transform.text}}', outputName: 'result' })]
  return { ...makeWorkflow('original-workspace', '原业务工作流'), nodes, edges: nodes.slice(1).map((item, index) => ({ id: `edge-${index}`, source: nodes[index]!.id, target: item.id })) }
}
function baselineFor(flow: Workflow, ids = ['transform'], outputSchema?: ParameterField[]): Workflow {
  const baseline = structuredClone(flow)
  for (const item of baseline.nodes) if (ids.includes(item.id)) { item.kind = 'llm'; item.config = { prompt: '历史模型变换', ...(outputSchema ? { outputSchema } : {}) } }
  return baseline
}
const sample = (): OptimizationRegressionCase => ({ id: 'recorded-1', nodeId: 'transform', upstreamOutputs: { source: ref('', 'e3') }, expected: ref() })
function replay(flow = workflow(), evidence = fixture(), cases = [sample()], signal = new AbortController().signal, timeoutMs?: number, baseline = baselineFor(flow), replacementNodeIds = ['transform']) {
  return runPlanningRegression({ baseline, workflow: flow, replacementNodeIds, evidence, cases, signal, timeoutMs })
}
function resign(evidence: ConversationEvidence) { evidence.digest = conversationEvidenceDigest(evidence); return evidence }
let ownedStores = new Set<string>(), afterStart: (() => void) | undefined
const originalStart = WorkflowRuntime.prototype.start
beforeEach(() => {
  ownedStores = new Set(); afterStart = undefined
  vi.spyOn(WorkflowRuntime.prototype, 'start').mockImplementation(function (this: WorkflowRuntime, ...args: Parameters<typeof originalStart>) {
    ownedStores.add(this.storage.directory)
    const run = originalStart.apply(this, args); afterStart?.(); return run
  })
})
afterEach(() => { vi.restoreAllMocks(); for (const directory of ownedStores) expect(existsSync(directory), `本次回放目录未清理: ${directory}`).toBe(false) })

describe('planning regression uses the real Graphon runtime with recorded data only', () => {
  it('replays a template with original input mapping and does not invoke its upstream model', async () => {
    const flow = workflow(), original = structuredClone(flow), evidence = fixture(), originalEvidence = structuredClone(evidence)
    const result = await replay(flow, evidence)
    expect(result.status).toBe('passed'); expect(result.passedRecorded).toBe(1)
    expect(result.scope).toBe('node-transform'); expect(result.evidenceSource).toBe('recorded')
    expect(result.cases[0]?.actualDigest).toBe(result.cases[0]?.expectedDigest)
    expect(result.limitations.join(' ')).toContain('不证明全图')
    expect(JSON.stringify(result)).not.toContain('Ada')
    expect(flow).toEqual(original); expect(evidence).toEqual(originalEvidence); expect(ownedStores.size).toBe(1)
  })

  it('reuses only Host-provided immutable Graphon assets while deleting the private run store', async () => {
    const flow = workflow()
    const result = await runPlanningRegression({ baseline: baselineFor(flow), replacementNodeIds: ['transform'], workflow: flow, evidence: fixture(), cases: [sample()], signal: new AbortController().signal, runtimeDirectory: resolve('.cache/graphon-test-runtime') })
    expect(result.status).toBe('passed'); expect(ownedStores.size).toBe(1)
  })

  it('executes JavaScript in the existing isolated VM with no host network, process or file bindings', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'))
    try {
      const flow = workflow(node('transform', 'code', { language: 'javascript', inputs: { name: '{{source.name}}' }, code: 'function main(inputs) { return { text: inputs.name + ":" + [typeof fetch, typeof process, typeof require].join(",") }; }' }))
      const result = await replay(flow, fixture({ text: 'Ada:undefined,undefined,undefined' }))
      expect(result.status).toBe('passed'); expect(fetch).not.toHaveBeenCalled()
    } finally { fetch.mockRestore() }
  })

  it('uses original typed workflow inputs and escaped JSON pointer paths', async () => {
    const flow = workflow(node('transform', 'code', { language: 'javascript', inputs: { n: '{{input.n}}' }, code: 'function main(inputs) { return { text: String(inputs.n + 1) }; }' }))
    flow.nodes[0]!.config.fields = [{ name: 'n', label: '数字', type: 'number', required: true }]
    const evidence = fixture({ text: '3' }, {}, { 'sample/key': { '~raw': { n: '2' } } })
    const result = await replay(flow, evidence, [{ id: 'typed', nodeId: 'transform', workflowInputs: ref('/sample~1key/~0raw', 'e4'), expected: ref() }])
    expect(result.status).toBe('passed')
  })

  it('compares complete output objects and rejects added candidate fields', async () => {
    const flow = workflow(node('transform', 'code', { language: 'javascript', inputs: { name: '{{source.name}}' }, code: 'function main(inputs) { return { text: inputs.name, count: 1 }; }' }))
    const failed = await replay(flow, fixture({ text: 'Ada' }))
    expect(failed.status).toBe('failed'); expect(failed.passedRecorded).toBe(0)
    expect(failed.cases[0]?.actualDigest).not.toBe(failed.cases[0]?.expectedDigest)
  })

  it('requires the original baseline and cumulative replacements rather than guessing them', async () => {
    const result = await runPlanningRegression({ workflow: workflow(), evidence: fixture(), cases: [sample()], signal: new AbortController().signal } as PlanningRegressionOptions)
    expect(result.status).toBe('skipped'); expect(ownedStores.size).toBe(0)
  })

  it('rejects Agent.json and any nested expected/upstream pointer masquerading as full output', async () => {
    const evidence = fixture({ text: '{"text":"你好 Ada"}', json: { text: '你好 Ada' }, steps: 1 })
    const nested = await replay(workflow(), evidence, [{ ...sample(), expected: ref('/json') }])
    expect(nested.status).toBe('skipped'); expect(nested.cases[0]?.reason).toContain('完整工具结果根对象')
    const upstream = await replay(workflow(), fixture(undefined, { json: { name: 'Ada' } }), [{ ...sample(), upstreamOutputs: { source: ref('/json', 'e3') } }])
    expect(upstream.status).toBe('skipped')
    const flow = workflow(), baseline = baselineFor(flow); baseline.nodes[2]!.kind = 'agent'; baseline.nodes[2]!.config = { prompt: '', tools: [] }
    expect((await replay(flow, evidence, [sample()], new AbortController().signal, undefined, baseline)).status).toBe('skipped')
  })

  it('validates structured LLM text/json/field mirrors using the original outputSchema', async () => {
    const outputSchema: ParameterField[] = [{ name: 'count', type: 'number', required: true }]
    const flow = workflow(node('transform', 'code', { language: 'javascript', inputs: {}, outputSchema, code: 'function main(inputs) { return { count: 1, text: JSON.stringify({count:1}), json: {count:1} }; }' }))
    const baseline = baselineFor(flow, ['transform'], outputSchema)
    const passed = await replay(flow, fixture({ json: { count: 1 }, text: '{"count":1}', count: 1 }), [sample()], new AbortController().signal, undefined, baseline)
    expect(passed.status).toBe('passed')
    for (const expected of [{ count: 1 }, { count: '1', text: '{"count":"1"}', json: { count: '1' } }, { count: 2, text: '{"count":1}', json: { count: 1 } }, { count: 1, text: '{"count":2}', json: { count: 1 } }, { count: 1, text: '{"count":1}' }]) {
      expect((await replay(flow, fixture(expected), [sample()], new AbortController().signal, undefined, baseline)).status).toBe('skipped')
    }
  })

  it('rejects reserved text/json business field collisions in the original schema', async () => {
    for (const name of ['text', 'json']) {
      const flow = workflow(), baseline = baselineFor(flow, ['transform'], [{ name, type: 'string' }])
      expect((await replay(flow, fixture(), [sample()], new AbortController().signal, undefined, baseline)).status).toBe('skipped')
    }
  })

  it('executes previously replaced upstream config instead of hiding it behind its old sample output', async () => {
    const flow = workflow(node('transform', 'template', { text: '{{source.text}}!' }))
    flow.nodes[1] = node('source', 'template', { text: 'wrong new value' })
    const baseline = baselineFor(flow, ['source', 'transform']), evidence = fixture({ text: 'old recorded value!' }, { text: 'old recorded value' })
    const failed = await replay(flow, evidence, [sample()], new AbortController().signal, undefined, baseline, ['source', 'transform'])
    expect(failed.status).toBe('failed'); expect(failed.passedRecorded).toBe(0)
    flow.nodes[1]!.config.text = 'old recorded value'
    const passed = await replay(flow, evidence, [sample()], new AbortController().signal, undefined, baseline, ['source', 'transform'])
    expect(passed.status).toBe('passed')
  })

  it('does not inject a recorded answer when a replaced ancestor lacks its real input', async () => {
    const flow = workflow(node('transform', 'template', { text: '{{source.text}}!' }))
    flow.nodes[1] = node('source', 'template', { text: '{{input.missing}}' })
    const result = await replay(flow, fixture({ text: 'old!' }, { text: 'old' }), [sample()], new AbortController().signal, undefined, baselineFor(flow, ['source', 'transform']), ['source', 'transform'])
    expect(result.status).not.toBe('passed'); expect(result.passedRecorded).toBe(0)
  })

  it('does not claim combined success when an unchanged recorded node hides effects of a replaced ancestor', async () => {
    const flow = workflow(node('transform', 'template', { text: '{{source.text}}!' }))
    flow.nodes.splice(1, 0, node('earlier', 'template', { text: 'changed input' }))
    flow.edges = flow.nodes.slice(1).map((item, index) => ({ id: `edge-${index}`, source: flow.nodes[index]!.id, target: item.id }))
    const result = await replay(flow, fixture({ text: 'old!' }, { text: 'old' }), [sample()], new AbortController().signal, undefined, baselineFor(flow, ['earlier', 'transform']), ['earlier', 'transform'])
    expect(result.status).toBe('skipped'); expect(result.cases[0]?.reason).toContain('无法证明组合回归')
  })

  it('does not rewrite a wrong candidate config.inputs to make the sample pass', async () => {
    const flow = workflow(); flow.nodes[2]!.config.inputs = { name: '{{source.missing}}' }
    const result = await replay(flow)
    expect(result.status).toBe('failed'); expect(result.passedRecorded).toBe(0)
    expect(flow.nodes[2]!.config.inputs).toEqual({ name: '{{source.missing}}' })
  })

  it('skips unprovided upstream data and rejects arbitrary non-ancestor fixtures', async () => {
    const missing = await replay(workflow(), fixture(), [{ ...sample(), upstreamOutputs: {} }])
    expect(missing.status).toBe('skipped'); expect(missing.cases[0]?.reason).toContain('上游依赖')
    const unrelated = await replay(workflow(), fixture(), [{ ...sample(), upstreamOutputs: { out: ref('', 'e3') } }])
    expect(unrelated.status).toBe('skipped'); expect(unrelated.cases[0]?.reason).toContain('真实上游')
  })

  it.each(['truncated', 'failed', 'missing-call', 'redacted', 'non-json', 'missing-path', 'scalar-expectation'] as const)('rejects %s evidence instead of inventing a passing fixture', async scenario => {
    const evidence = fixture(), item = sample()
    if (scenario === 'truncated') { evidence.records[4]!.truncated = true; evidence.records[4]!.status = 'unknown' }
    if (scenario === 'failed') { evidence.records[4]!.status = 'failed'; evidence.records[3]!.status = 'failed' }
    if (scenario === 'missing-call') evidence.records.splice(3, 1)
    if (scenario === 'redacted') evidence.records[4]!.text = '{"text":"你好 [REDACTED]"}'
    if (scenario === 'non-json') evidence.records[4]!.text = 'Task completed successfully.'
    if (scenario === 'missing-path') item.workflowInputs = ref('/missing', 'e4')
    if (scenario === 'scalar-expectation') evidence.records[4]!.text = '"你好 Ada"'
    const result = await replay(workflow(), resign(evidence), [item])
    expect(result.status).toBe('skipped'); expect(result.passedRecorded).toBe(0)
  })

  it('rejects forged evidence digests and unsafe pointer keys before executing', async () => {
    const evidence = fixture(); evidence.records[2]!.text = '{}'
    expect((await replay(workflow(), evidence)).status).toBe('skipped')
    const result = await replay(workflow(), fixture(), [{ ...sample(), expected: ref('/constructor/prototype') }])
    expect(result.status).toBe('skipped'); expect(result.cases).toEqual([])
  })

  it.each(['llm', 'http', 'python', 'file-input', 'file-verification', 'system-variable'] as const)('does not run unsupported %s effects', async scenario => {
    const flow = workflow()
    if (scenario === 'llm') flow.nodes[2] = node('transform', 'llm', { prompt: 'do not call' })
    if (scenario === 'http') flow.nodes[2] = node('transform', 'http', { url: 'https://must-not-call.example/' })
    if (scenario === 'python') flow.nodes[2] = node('transform', 'code', { language: 'python', code: 'def main(inputs): return {}' })
    if (scenario === 'file-input') flow.nodes[0]!.config.fields = [{ name: 'file', label: '文件', type: 'file', required: false }]
    if (scenario === 'file-verification') flow.nodes[2]!.config.verification = { requiredFiles: ['/must-not-read'] }
    if (scenario === 'system-variable') flow.nodes[2]!.config.inputs = { name: '{{sys.run_id}}' }
    const result = await replay(flow)
    expect(result.status).toBe('skipped'); expect(result.passedRecorded).toBe(0)
  })

  it('keeps missing required inputs explicit instead of guessing defaults', async () => {
    const flow = workflow(); flow.nodes[0]!.config.fields = [{ name: 'name', label: '姓名', required: true }]
    const result = await replay(flow)
    expect(result.status).toBe('skipped'); expect(result.cases[0]?.reason).toContain('必填输入')
  })

  it('returns cancellation and deadline reports and removes temporary stores', async () => {
    const controller = new AbortController(); controller.abort()
    const cancelled = await replay(workflow(), fixture(), [sample()], controller.signal)
    expect(cancelled.status).toBe('cancelled')
    const timed = await replay(workflow(), fixture(), [sample()], new AbortController().signal, 1)
    expect(timed.status).toBe('timeout'); expect(timed.passedRecorded).toBe(0)
  })

  it('cancels an already launched Graphon replay before returning and cleans its private store', async () => {
    const controller = new AbortController(); afterStart = () => queueMicrotask(() => controller.abort())
    const result = await replay(workflow(), fixture(), [sample()], controller.signal)
    expect(ownedStores.size).toBe(1); expect(result.status).toBe('cancelled'); expect(result.passedRecorded).toBe(0)
  })

  it('reports each recorded sample and never calls a mixed suite fully passed', async () => {
    const evidence = fixture()
    evidence.records.push(
      { id: 'e6', seq: 6, kind: 'tool-call', status: 'reported-success', text: '{}', callId: 'second-target', toolName: 'recorded-transform', truncated: false },
      { id: 'e7', seq: 7, kind: 'tool-result', status: 'reported-success', text: '{"text":"different"}', callId: 'second-target', toolName: 'recorded-transform', truncated: false },
    ); evidence.throughSeq = 7
    const result = await replay(workflow(), resign(evidence), [sample(), { ...sample(), id: 'recorded-2', expected: ref('', 'e7') }])
    expect(result.status).toBe('failed'); expect(result.passedRecorded).toBe(1)
    expect(result.cases.map(item => item.status)).toEqual(['passed', 'failed'])
  })

  it('does not silently truncate an oversized suite or treat no cases as proof', async () => {
    const oversized = await replay(workflow(), fixture(), Array.from({ length: 21 }, (_, index) => ({ ...sample(), id: `case-${index}` })))
    expect(oversized.status).toBe('skipped'); expect(oversized.cases).toEqual([])
    expect((await replay(workflow(), fixture(), [])).status).toBe('skipped')
  })
})
