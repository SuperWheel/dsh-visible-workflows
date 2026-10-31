import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { planningEditView } from '../src/shared/planning-edits.ts'
import type { PlanningContext } from '../src/shared/planning-types.ts'
import type { Workflow, WorkflowRun } from '../src/shared/types.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { ToolCatalog } from '../src/host/tool-catalog.ts'
import { createExecutionAdapters } from '../src/host/execution-adapters.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'

// Real production compiler, QuickJS adapters, storage and Graphon. No mocked
// container scheduler, planning model, native tools or external HTTP is used.
const contexts: { directory: string; runtime: WorkflowRuntime }[] = []
type RunEvent = { id: string; runId: string; seq: number; status: string; executions: { executionId: string; status: string }[] }
const evidence: { case: string; run: WorkflowRun; events: RunEvent[] }[] = []
function recordEvidence(name: string, storage: WorkflowStorage, run: WorkflowRun) {
  const events = readFileSync(join(storage.directory, 'runs', `${run.id}.events.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line) as RunEvent)
  expect(events.length).toBeGreaterThan(1)
  expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index + 1))
  expect(events.every(event => event.runId === run.id && event.id === `${run.id}:${event.seq}`)).toBe(true)
  expect(events.at(-1)?.status).toBe(run.status)
  expect(events.at(-1)?.executions).toEqual(run.executions.map(record => ({ executionId: record.executionId ?? record.nodeId, status: record.status })))
  evidence.push({ case: name, run, events })
}
afterEach(async () => { for (const { directory, runtime } of contexts.splice(0)) { await runtime.close(); rmSync(directory, { recursive: true, force: true }) } })
afterAll(() => {
  const directory = process.env.DSH_COMPLEX_EVIDENCE_DIR
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 't05-complex-container-runs.json'), JSON.stringify({ capturedAt: new Date().toISOString(), scope: 'Production template compiler + real Graphon/QuickJS; synthetic inputs; no model/native/network execution. Assertion verdict belongs to the accompanying Vitest report.', cases: evidence }, null, 2) + '\n', { flag: 'wx' })
})

const createCode = 'function main(inputs) { return { delta: inputs.item }; }'
const revisedCode = 'function main(inputs) { return { delta: inputs.item - inputs.threshold }; }'
function wire(): any {
  return { submission: { mode: 'create', title: 'Bounded repeated threshold totals', forms: [
    { key: 'start', template: 'input', values: { fields: [{ name: 'records', label: 'JSON numbers', type: 'paragraph', required: true }, { name: 'rounds', label: 'Rounds', type: 'number', required: true }, { name: 'threshold', label: 'Threshold', type: 'number', required: true }] } },
    { key: 'parse', template: 'code', values: { language: 'javascript', inputs: { records: '{{input.records}}', rounds: '{{input.rounds}}' }, code: 'function main(inputs) { var records = JSON.parse(inputs.records); if (!Array.isArray(records) || records.some(function (v) { return typeof v !== "number" || !Number.isFinite(v); })) throw new Error("records must be finite numbers"); if (!Number.isInteger(inputs.rounds) || inputs.rounds < 1 || inputs.rounds > 5) throw new Error("rounds must be 1..5"); return { records: records }; }', outputSchema: [{ name: 'records', type: 'array', required: true }] } },
    { key: 'batches', template: 'iteration', values: { iterator: 'parse.records', outputVariable: 'repeat.variables.sum', errorMode: 'terminate' } },
    { key: 'result', template: 'output', values: { text: '{{batches.result}}', outputName: 'result' } },
    { key: 'batchEntry', template: 'input', scope: ['batches'], values: { fields: [] } },
    { key: 'repeat', template: 'loop', scope: ['batches'], values: { initialVariables: { sum: 0, count: 0 }, maxIterations: 5, until: { variable: 'vars.count', operator: 'gte', value: '{{input.rounds}}' } } },
    { key: 'batchExit', template: 'output', scope: ['batches'], values: { text: '{{repeat.variables.sum}}', outputName: 'batch' } },
    { key: 'roundEntry', template: 'input', scope: ['batches', 'repeat'], values: { fields: [] } },
    { key: 'gate', template: 'if', scope: ['batches', 'repeat'], values: { variable: 'item', operator: 'gt', value: '{{input.threshold}}' } },
    { key: 'accept', template: 'code', scope: ['batches', 'repeat'], values: { language: 'javascript', inputs: { item: '{{item}}', threshold: '{{input.threshold}}' }, code: createCode, outputSchema: [{ name: 'delta', type: 'number', required: true }] } },
    { key: 'reject', template: 'code', scope: ['batches', 'repeat'], values: { language: 'javascript', code: 'function main() { return { delta: 0 }; }', outputSchema: [{ name: 'delta', type: 'number', required: true }] } },
    { key: 'merge', template: 'aggregator', scope: ['batches', 'repeat'], values: { groups: [{ name: 'delta', variables: ['accept.delta', 'reject.delta'] }] } },
    { key: 'increment', template: 'assigner', scope: ['batches', 'repeat'], values: { assignments: [{ name: 'sum', operation: 'add', value: '{{merge.delta}}' }, { name: 'count', operation: 'add', value: 1 }] } },
    { key: 'roundExit', template: 'output', scope: ['batches', 'repeat'], values: { text: '{{vars.sum}}', outputName: 'round' } },
  ], chains: [
    { key: 'main', nodes: ['start', 'parse', 'batches', 'result'] },
    { key: 'batch', nodes: ['batchEntry', 'repeat', 'batchExit'] },
    { key: 'roundPrefix', nodes: ['roundEntry', 'gate'] },
    { key: 'roundSuffix', nodes: ['merge', 'increment', 'roundExit'] },
    { key: 'takeMerge', container: 'repeat', nodes: ['accept', 'merge'] }, { key: 'skipMerge', container: 'repeat', nodes: ['reject', 'merge'] },
  ], links: [
    { key: 'take', source: 'gate', target: 'accept', port: 'true' }, { key: 'skip', source: 'gate', target: 'reject', port: 'false' },
  ], coverage: { R1: ['parse', 'batches', 'repeat', 'gate', 'accept', 'reject', 'increment', 'result'] } } }
}
function accepted(result: ReturnType<TemplateFillingCompiler['submit']>): Workflow {
  if (!result.ok) throw new Error(JSON.stringify(result.feedback))
  if (!result.value.candidate) throw new Error('Expected candidate')
  return result.value.candidate
}
function setup(graph: Workflow) {
  const directory = mkdtempSync(join(tmpdir(), 'template-complex-')), storage = new WorkflowStorage(directory)
  const unexpected = async (): Promise<never> => { throw new Error('No native, network or model calls allowed') }
  const catalog = new ToolCatalog({ directory, workflows: () => [], nativeTools: () => [], executeNative: unexpected, runWorkflow: unexpected, http: unexpected })
  const runtime = new WorkflowRuntime(storage, { generate: unexpected }, createExecutionAdapters({ catalog, workspaceRoot: () => directory }))
  contexts.push({ directory, runtime }); return { storage, runtime, graph: storage.save(graph, 0) }
}
const scenarios = [
  { name: 'primary', records: [3, -2, 0, 4], rounds: 2, threshold: 2, expected: [6, 0, 0, 8], revised: [2, 0, 0, 4] },
  { name: 'holdout', records: [1, 5, 2], rounds: 3, threshold: 2, expected: [0, 15, 0], revised: [0, 9, 0] },
]
const inputs = (sample: typeof scenarios[number]) => ({ records: JSON.stringify(sample.records), rounds: String(sample.rounds), threshold: String(sample.threshold) })
function verifyBusiness(run: WorkflowRun, expected: number[], sample: typeof scenarios[number]) {
  expect(run.status, run.error).toBe('success'); expect(run.engine).toMatchObject({ name: 'graphon', protocol: 1 })
  expect(JSON.parse(run.outputs.result!)).toEqual(expected)
  expect(run.usage).toMatchObject({ calls: 0, agentTasks: 0, spentTokens: 0, unknownCalls: 0 })
  const batches = run.graph.nodes.find(node => node.kind === 'iteration')!, repeat = batches.config.body!.nodes.find(node => node.kind === 'loop')!
  expect(run.executions.find(record => record.nodeId === batches.id)!.data!.result).toEqual(expected)
  const gates = repeat.config.body!.nodes.find(node => node.kind === 'if')!, increments = repeat.config.body!.nodes.find(node => node.kind === 'assigner')!
  const gateRuns = run.executions.filter(record => record.nodeId === gates.id), incrementRuns = run.executions.filter(record => record.nodeId === increments.id)
  expect(gateRuns).toHaveLength(sample.records.length * sample.rounds); expect(incrementRuns).toHaveLength(sample.records.length * sample.rounds)
  for (let i = 0; i < sample.records.length; i++) {
    const iteration = `${batches.id}[${i}]/${repeat.id}`
    expect(run.executions.find(record => record.executionId === iteration)?.data).toMatchObject({ iterations: sample.rounds, variables: { count: sample.rounds, sum: expected[i] } })
    const perItem = gateRuns.filter(record => record.executionId!.startsWith(iteration + '['))
    expect(perItem.map(record => record.selectedPort)).toEqual(Array(sample.rounds).fill(sample.records[i]! > sample.threshold ? 'true' : 'false'))
  }
  expect(run.executions.filter(record => record.status === 'skipped')).toHaveLength(sample.records.length * sample.rounds)
  expect(run.executions.filter(record => record.status === 'success').every(record => !!record.startedAt && record.attempt === 1 && !record.reusedFromRunId)).toBe(true)
}

describe('template-fill real nested iteration / loop / branch execution', () => {
  it.each(scenarios)('$name produces independently expected per-record repeated totals', async sample => {
    const graph = accepted(new TemplateFillingCompiler(templateContext()).submit(wire())), test = setup(graph)
    const run = await test.runtime.settle(test.runtime.start(test.graph.id, inputs(sample)).id); recordEvidence(sample.name, test.storage, run)
    verifyBusiness(run, sample.expected, sample)
  })
  it('rejects an out-of-contract business input before any nested batch work or final output', async () => {
    const graph = accepted(new TemplateFillingCompiler(templateContext()).submit(wire())), test = setup(graph)
    const run = await test.runtime.settle(test.runtime.start(test.graph.id, { records: '[1, "wrong", 3]', rounds: '2', threshold: '0' }).id); recordEvidence('invalid-records', test.storage, run)
    expect(run.status).toBe('failed'); expect(run.error).toContain('finite numbers'); expect(run.outputs).toEqual({})
    const parse = run.graph.nodes.find(node => node.kind === 'code')!, batch = run.graph.nodes.find(node => node.kind === 'iteration')!
    expect(run.executions.find(record => record.nodeId === parse.id)).toMatchObject({ status: 'failed', attempt: 1 })
    expect(run.executions.find(record => record.nodeId === batch.id)).toMatchObject({ status: 'skipped' })
    expect(run.executions.some(record => record.executionId?.includes('['))).toBe(false)
  })
})

describe('template-fill local edits inside nested containers execute new behavior', () => {
  it.each(scenarios)('$name edits only the selected nested code and produces independently expected excess totals', async sample => {
    const original = accepted(new TemplateFillingCompiler(templateContext()).submit(wire())), test = setup(original), baseline = test.storage.get(test.graph.id)
    const nested = baseline.nodes.find(node => node.kind === 'iteration')!.config.body!.nodes.find(node => node.kind === 'loop')!.config.body!
    const target = nested.nodes.find(node => node.kind === 'code' && node.config.code === createCode)!
    const context: PlanningContext = { ...templateContext(), workflow: baseline, operation: 'revise', targetNodeIds: [target.id] }
    const ref = planningEditView(context).targetNodeRefs[0]!
    const edit = { submission: { mode: 'edit', updates: { ['n' + ref.slice(1)]: { values: { code: revisedCode } } }, coverage: { R1: ['n' + ref.slice(1)] } } }
    const candidate = accepted(new TemplateFillingCompiler(context).submit(edit))
    const restored = structuredClone(candidate), restore = (graph: { nodes: Workflow['nodes'] }) => { for (const node of graph.nodes) { if (node.id === target.id) node.config.code = createCode; if (node.config.body) restore(node.config.body) } }; restore(restored)
    expect(restored).toEqual(baseline); expect(test.storage.get(test.graph.id)).toEqual(baseline)
    const saved = test.storage.save(candidate, baseline.revision, 'agent'), run = await test.runtime.settle(test.runtime.start(saved.id, inputs(sample)).id)
    recordEvidence('nested-revise-' + sample.name, test.storage, run); verifyBusiness(run, sample.revised, sample)
    expect(JSON.parse(run.outputs.result!)).not.toEqual(sample.expected)
  })
  it('rejects a mutation to an unselected nested sibling without changing the stored graph', () => {
    const original = accepted(new TemplateFillingCompiler(templateContext()).submit(wire())), test = setup(original), baseline = test.storage.get(test.graph.id)
    const nested = baseline.nodes.find(node => node.kind === 'iteration')!.config.body!.nodes.find(node => node.kind === 'loop')!.config.body!, codes = nested.nodes.filter(node => node.kind === 'code')
    const context: PlanningContext = { ...templateContext(), workflow: baseline, operation: 'revise', targetNodeIds: [codes[0]!.id] }, ref = planningEditView(context).nodes.find(node => node.kind === 'code' && node.config.code === codes[1]!.config.code)!.ref
    expect(() => new TemplateFillingCompiler(context).submit({ submission: { mode: 'edit', updates: { ['n' + ref.slice(1)]: { values: { code: revisedCode } } }, coverage: { R1: ['n' + ref.slice(1)] } } })).toThrow()
    expect(test.storage.get(test.graph.id)).toEqual(baseline)
  })
})
