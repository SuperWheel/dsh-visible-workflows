import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { ToolCatalog } from '../src/host/tool-catalog.ts'
import { createExecutionAdapters } from '../src/host/execution-adapters.ts'
import { templateIdForTool } from '../src/shared/planning-node-templates.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'
import type { ToolChoice, WorkflowRun } from '../src/shared/types.ts'

const resources: { directory: string; runtime: WorkflowRuntime }[] = []
const evidence: unknown[] = []
const noModel = { generate: async (): Promise<never> => { throw Error('No model in this offline recovery test') } }
function graph(forms: any[], tools: ToolChoice[] = []) {
  const context = templateContext()
  context.tools = tools
  const compiled = new TemplateFillingCompiler(context).submit({ submission: { mode: 'create', title: 'Recovery composition', forms, chains: [{ key: 'main', nodes: forms.map(form => form.key) }], coverage: { R1: forms.slice(1).map(form => form.key) } } })
  if (!compiled.ok) throw Error(JSON.stringify(compiled.feedback))
  return compiled.value.candidate!
}
function setup(directory = mkdtempSync(join(tmpdir(), 'template-complex-recovery-')), choices: ToolChoice[] = [], action = async () => ({ text: 'receipt' })) {
  const storage = new WorkflowStorage(directory)
  const catalog = new ToolCatalog({ directory, workflows: () => storage.workflows(), nativeTools: () => choices, executeNative: action, runWorkflow: async () => { throw Error('No child call in this fixture') }, http: async () => { throw Error('No network') } })
  const runtime = new WorkflowRuntime(storage, noModel, createExecutionAdapters({ catalog, workspaceRoot: () => directory, readAttachment: (runId, fileId) => storage.readAttachment(runId, fileId) }))
  resources.push({ directory, runtime })
  return { directory, storage, runtime, catalog }
}
function record(label: string, run: WorkflowRun) {
  evidence.push({ label, id: run.id, sourceRunId: run.sourceRunId ?? null, sourceRevision: run.sourceRevision, status: run.status, engine: run.engine, outputs: run.outputs, executions: run.executions.map(row => ({ nodeId: row.nodeId, status: row.status, reusedFromRunId: row.reusedFromRunId ?? null })) })
}
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.runtime.close()
    rmSync(resource.directory, { recursive: true, force: true })
  }
  if (process.env.T05_COMPLEX_EVIDENCE_DIR) {
    mkdirSync(process.env.T05_COMPLEX_EVIDENCE_DIR, { recursive: true })
    writeFileSync(join(process.env.T05_COMPLEX_EVIDENCE_DIR, 'recovery.json'), JSON.stringify({ boundary: 'Real template compiler/storage/adapters/Graphon; native body is a double; cold restart restores a synthetic durable in-flight snapshot, not a killed OS process', observations: evidence }, null, 2) + '\n')
  }
})

const documentForms = [
  { key: 'start', template: 'input', values: { fields: [{ name: 'file', label: 'Attachment', type: 'file', required: true }] } },
  { key: 'document', template: 'document', values: { source: 'input.file' } },
  { key: 'result', template: 'output', values: { text: '{{document.text}}', outputName: 'result' } },
]
describe('template-fill uploaded documents and explicit frozen recovery', () => {
  it.each([{ label: 'primary', text: 'Alpha\nBeta' }, { label: 'holdout', text: '独立输入：42' }])('$label rematerializes private attachments into a new run and retains the source graph', async sample => {
    const test = setup()
    const saved = test.storage.save(graph(documentForms), 0)
    const upload = JSON.stringify({ name: 'input.txt', mimeType: 'text/plain', base64: Buffer.from(sample.text).toString('base64') })
    const source = await test.runtime.settle(test.runtime.start(saved.id, { file: upload }).id)
    expect(source.status, source.error).toBe('success')
    expect(source.outputs.result).toBe(sample.text)
    const sourceBefore = test.storage.run(source.id)
    const updated = structuredClone(saved)
    updated.nodes.find(node => node.kind === 'output')!.config.text = 'LATEST LIBRARY MUST NOT BE USED'
    test.storage.save(updated, saved.revision)
    const recovered = await test.runtime.settle(test.runtime.recover(source.id, 'rerun').id)
    record(sample.label + '-source', source)
    record(sample.label + '-recovered', recovered)
    expect(recovered.status, recovered.error).toBe('success')
    expect(recovered.outputs.result).toBe(sample.text)
    expect(recovered.sourceRevision).toBe(1)
    expect(test.storage.get(saved.id).revision).toBe(2)
    expect(recovered.sourceRunId).toBe(source.id)
    expect(test.storage.run(source.id)).toEqual(sourceBefore)
    const oldRef = JSON.parse(source.inputs.file!), freshRef = JSON.parse(recovered.inputs.file!)
    expect(freshRef.workflowFileId).not.toBe(oldRef.workflowFileId)
    expect(test.storage.readAttachment(source.id, oldRef.workflowFileId)).toEqual(test.storage.readAttachment(recovered.id, freshRef.workflowFileId))
    expect(() => test.storage.readAttachment(recovered.id, oldRef.workflowFileId)).toThrow('不属于本次运行')
    expect(JSON.stringify(recovered)).not.toContain(JSON.parse(upload).base64)
    expect(recovered.executions.every(row => !row.reusedFromRunId)).toBe(true)
  })
  it('rejects a missing source attachment before creating a new recovery run', async () => {
    const test = setup(), saved = test.storage.save(graph(documentForms), 0)
    const source = await test.runtime.settle(test.runtime.start(saved.id, { file: JSON.stringify({ name: 'input.txt', base64: Buffer.from('temporary').toString('base64') }) }).id)
    const fileId = JSON.parse(source.inputs.file!).workflowFileId
    unlinkSync(join(test.directory, 'attachments', source.id, `${fileId}.json`))
    const before = test.storage.runs().length
    expect(() => test.runtime.recover(source.id, 'rerun')).toThrow('附件不存在')
    expect(test.storage.runs()).toHaveLength(before)
    record('missing-attachment-source', test.storage.run(source.id))
  })
})

it('cold reopening an in-flight action marks interrupted, blocks replay and rejects contract drift before dispatch', async () => {
  const choice: ToolChoice = { id: 'native:fixture_action', name: 'fixture_action', description: 'Frozen action contract', available: true, category: 'plugin', providerId: 'fixture', providerName: 'Offline double', inputSchema: { type: 'object', properties: {} } }
  const choices = [choice]
  let actions = 0
  const action = async () => { actions++; return { text: 'receipt-' + actions } }
  const test = setup(undefined, choices, action)
  const saved = test.storage.save(graph([
    { key: 'start', template: 'input', values: { fields: [] } },
    { key: 'action', template: templateIdForTool(choice.id), values: { inputs: {} } },
    { key: 'result', template: 'output', values: { text: '{{action.text}}', outputName: 'result' } },
  ], choices), 0)
  const source = await test.runtime.settle(test.runtime.start(saved.id, {}, undefined, { sessionId: 'fixture', toolConstraints: test.catalog.constraints('workspace', [choice.id], 'fixture') }).id)
  expect(source.status, source.error).toBe('success')
  expect(actions).toBe(1)
  // Freeze a crash-shaped state only after the real initial run is fully closed.
  // This is a deterministic storage-reopen test, not a claim of OS crash testing.
  const inFlight = structuredClone(source), step = inFlight.executions.find(row => row.nodeId === saved.nodes.find(node => node.kind === 'tool')!.id)!
  inFlight.status = 'running'
  inFlight.outputs = {}
  delete inFlight.endedAt
  step.status = 'running'
  delete step.endedAt
  delete step.data
  delete step.output
  test.storage.saveRun(inFlight)
  await test.runtime.close()
  const restarted = setup(test.directory, choices, action)
  const interrupted = restarted.storage.run(source.id)
  expect(interrupted.status).toBe('interrupted')
  expect(actions).toBe(1)
  const original = structuredClone(interrupted), base = restarted.runtime.recoveryPlan(source.id)
  expect(base.allowed).toBe(false)
  expect(() => restarted.runtime.recover(source.id, 'resume', undefined, base.planDigest)).toThrow()
  expect(actions).toBe(1)
  const review = { baseDigest: base.planDigest, decisions: [{ executionId: step.executionId ?? step.nodeId, action: 'redo', evidence: 'Offline fixture explicitly authorizes one repeated action' }] }
  const reviewed = restarted.runtime.recoveryPlan(source.id, review)
  expect(reviewed.allowed).toBe(true)
  choices[0]!.description = 'Changed contract'
  const rejected = await restarted.runtime.settle(restarted.runtime.recover(source.id, 'resume', undefined, reviewed.planDigest, review).id)
  expect(rejected.status).toBe('failed')
  expect(rejected.error).toContain('工具定义已变化')
  expect(actions).toBe(1)
  choices[0]!.description = 'Frozen action contract'
  const recovered = await restarted.runtime.settle(restarted.runtime.recover(source.id, 'resume', undefined, reviewed.planDigest, review).id)
  expect(recovered.status, recovered.error).toBe('success')
  expect(recovered.outputs.result).toBe('receipt-2')
  expect(actions).toBe(2)
  expect(restarted.storage.run(source.id)).toEqual(original)
  record('cold-interrupted', interrupted)
  record('contract-drift-rejected', rejected)
  record('explicit-redo', recovered)
})
