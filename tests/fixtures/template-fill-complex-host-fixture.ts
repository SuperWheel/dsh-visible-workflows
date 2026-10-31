import {moduleCheck} from './planning-module-check.ts'
// Production Cordis Host, template compiler, publication, adapters and Graphon.
// Native tools, HTTP fetch and SDK LLM streams are explicit local doubles.
// No provider, network connection, Desktop state or user file is accessed.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import VisibleWorkflowService from '../../src/host/index.ts'
import { templateIdForTool } from '../../src/shared/planning-node-templates.ts'
import type { PlanningAgentInput } from '../../src/host/planning/agent.ts'
import { deepDesktopBundle } from './template-fill-complex-import-fixtures.ts'
import { DOCUMENT_V2_TEXT, documentWire, dynamicChildWire, dynamicRootWire } from './t05-desktop-recovery-forms.ts'
import type { WorkflowRun } from '../../src/shared/types.ts'

const group = process.argv[2]
const directory = mkdtempSync(join(tmpdir(), 'template-complex-host-'))
const ctx = new Context()
const main: any = {
  id: 'main', ctx,
  session: { id: 'main', header: { cwd: directory }, requestHeader: () => ({ config: { provider: 'fixture', model: 'offline', reasoningEffort: 'none' } }) },
  options: { provider: 'fixture', model: 'offline', reasoningEffort: 'none' },
}
const nativeCalls: { name: string; arguments: any }[] = []
const fetchCalls: { url: string; method: string; body: unknown }[] = []
const modelCalls: any[] = []
const observations: any[] = []
let responseMode = 'valid'
let modelText = '{"answer":"checked"}'
let trialReviewQuestions = 0
let trialOutcome: 'completed' | 'failed' = 'completed'
let trialExecutions = 0
let planningCalls = 0
let authoring: (input: PlanningAgentInput) => unknown
const nativeDefinitions = [
  { name: 'fixture_lookup', description: 'Return opaque JSON text inside the native value wrapper.', parameters: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false } },
  { name: 'fixture_emit', description: 'Write a numeric receipt in this isolated fixture only.', parameters: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'], additionalProperties: false } },
]
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, options) => {
  const address = String(url)
  assert.ok(address.startsWith('https://fixture.invalid/'), 'Unexpected outbound URL')
  fetchCalls.push({ url: address, method: String(options?.method), body: options?.body })
  const body = responseMode === 'http-error' ? { error: 'fixture rejection' } : address.includes('/direct/') ? { amount: 7 } : { amount: 11 }
  return new Response(JSON.stringify(body), { status: responseMode === 'http-error' ? 503 : 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'fixture-private' } })
}
const provisions = [
  ctx.provide('agents', { get: (id: string) => id === main.id ? main : undefined, list: () => [main], roots: () => [main],withInitiator:async(_parent:any,operation:()=>Promise<unknown>)=>operation() }),
  ctx.provide('workspaceRegistry', { list: () => [{ id: 'workspace', title: 'Complex offline fixture', path: directory, sessionIds: ['main'] }] }),
  ctx.provide('llm', {
    listProviders: () => [{ id: 'fixture', name: 'Offline SDK double' }],
    listModels: async () => [{ id: 'offline', name: 'Offline SDK double' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'none' }] } }),
    stream: async function* (request: any) {
      modelCalls.push(request)
      yield { type: 'text-delta', index: 0, text: modelText }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }),
  ctx.provide('typert', {}),
  ctx.provide('planMode', { get: () => ({ active: false }) }),
  ctx.provide('userQuestions', { ask: async (request: any) => ({ answers: [{ id: request.questions[0].id, selected: [request.questions[0].id.startsWith('trial-review-') ? (trialReviewQuestions++, '确认，继续生成') : '否，不设预算上限'] }] }) }),
]
const promptFiber = ctx.plugin(SystemPrompt, {})
await promptFiber
const toolsFiber = ctx.plugin(ToolRuntime, { mode: 'native' })
await toolsFiber
assert.equal(toolsFiber.state, 2)
for (const definition of nativeDefinitions) {
  ctx.tools.register(defineTool({
    ...definition,
    parameters: definition.parameters.properties,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args: any, exec: any) => {
      assert.equal(exec.agent, main)
      nativeCalls.push({ name: definition.name, arguments: structuredClone(args) })
      if (definition.name === 'fixture_lookup') {
        return responseMode === 'missing-field' ? { other: true } : { text: JSON.stringify({ count: responseMode === 'wrong-type' ? 'wrong' : args.count }) }
      }
      writeFileSync(join(directory, 'receipt.json'), JSON.stringify(args))
      return { accepted: args.amount }
    },
  } as any))
}
const fiber = ctx.plugin(VisibleWorkflowService, { stateDirectory: directory, planningCompiler: 'template-fill' })
await fiber
assert.equal(fiber.state, 2)
const service: any = fiber.ctx.get('visibleWorkflows')!
const runtime = service.runtime
service.planner.options.driver.generate = async (input: PlanningAgentInput) => {
  input.beforeStep?.(120, undefined)
  input.beforeSubmission?.()
  assert.ok(input.compiler && input.templateQuery)
  const compiled = input.compiler.submit(authoring(input))
  assert.equal(compiled.ok, true, JSON.stringify(compiled))
  if (!compiled.ok) throw Error('Fixture failed template compilation')
  return { output: compiled.value, steps: 1, usage: { totalTokens: 10 } }
}
const tool = async (name: string, args: unknown) => {
  const registered: any = ctx.tools.get(name)
  const result=JSON.parse(await registered.execute(args, { agent: main, signal: new AbortController().signal }))
  if(['visible_workflow_plan','visible_workflow_plan_answer'].includes(name)&&result.delivery?.mode==='background'){
    const trial=result.taskId.startsWith('trial-')
    if(trial&&result.trialState==='preparing'){assert.equal(result.delivery.protocolVersion,1);assert.equal(result.execution,undefined);assert.equal(result.planningTaskId,undefined)}
    if(result.state==='queued'){assert.equal(result.delivery.protocolVersion,1);assert.equal(result.candidate,undefined);assert.equal(result.receipt,undefined)}
    await (trial?service.trials:service.planner).active.get(result.taskId)?.done
    return JSON.parse(await ctx.tools.get('visible_workflow_plan_get')!.execute({task_id:result.taskId,include_candidates:true},{agent:main,signal:new AbortController().signal}))
  }
  return result
}
async function publish(id: string, wire: unknown) {
  authoring = () => wire
  const preview = await tool('visible_workflow_plan', { request_json: JSON.stringify({ requestId: id, operation: 'create', moduleCheck, instruction: 'Compose this isolated complex fixture', preview: true, execution: { mode: 'design-only' } }) })
  assert.equal(preview.state, 'ready', JSON.stringify(preview))
  const result = await tool('visible_workflow_plan_publish', { task_id: preview.taskId, revision: preview.revision, candidate_digest: preview.candidateDigest })
  assert.equal(result.state, 'published', JSON.stringify(result))
  return result.receipt.workflowId as string
}
function wire(title: string, forms: any[], nodes: string[]) {
  return { submission: { mode: 'create', title, forms, chains: [{ key: 'main', nodes }], coverage: { R1: nodes.slice(1) } } }
}
async function run(id: string, inputs: Record<string, string>, label: string) {
  const started = JSON.parse(await service.start(id, JSON.stringify(inputs), 'main'))
  const done: WorkflowRun = await runtime.settle(started.id)
  assert.equal(done.engine?.name, 'graphon')
  const events = readFileSync(join(directory, 'runs', `${done.id}.events.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(events.length > 0)
  assert.equal(events.at(-1).status, done.status)
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1))
  assert.ok(events.every(event => event.runId === done.id && event.id === `${done.id}:${event.seq}`))
  assert.deepEqual(events.at(-1).executions, done.executions.map(record => ({ executionId: record.executionId ?? record.nodeId, status: record.status })))
  observations.push({ label, eventCount: events.length, terminalEventMatched: true, id: done.id, workflowId: done.workflowId, status: done.status, outputs: done.outputs, error: done.error ?? null, engine: done.engine, executions: done.executions.map(record => ({ nodeId: record.nodeId, status: record.status, childRunId: record.childRunId ?? null })), usage: done.usage })
  return done
}
try {
  if (group === 'multi-tool') {
    const id = await publish('multi-tool', wire('Opaque wrapper and second tool', [
      { key: 'start', template: 'input', values: { fields: [{ name: 'count', label: 'Count', type: 'number', required: true }] } },
      { key: 'lookup', template: templateIdForTool('native:fixture_lookup'), values: { inputs: { count: '{{input.count}}' } } },
      { key: 'decode', template: 'code', values: { language: 'javascript', inputs: { raw: '{{lookup.value}}' }, code: 'function main(inputs) { if (!inputs.raw || typeof inputs.raw.text !== "string") throw Error("Missing explicit text field"); return {payload: JSON.parse(inputs.raw.text)}; }', outputSchema: [{ name: 'payload', type: 'object', required: true }] } },
      { key: 'emit', template: templateIdForTool('native:fixture_emit'), values: { inputs: { amount: '{{decode.payload.count}}' } } },
      { key: 'result', template: 'output', values: { text: '{{emit.value}}', outputName: 'result' } },
    ], ['start', 'lookup', 'decode', 'emit', 'result']))
    assert.equal(nativeCalls.length, 0, 'Planning and publication must not execute tools')
    for (const count of [3, 8]) {
      const done = await run(id, { count: String(count) }, count === 3 ? 'primary' : 'holdout')
      assert.equal(done.status, 'success', done.error)
      assert.deepEqual(JSON.parse(done.outputs.result!), { accepted: count })
      assert.deepEqual(JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8')), { amount: count })
    }
    for (const mode of ['missing-field', 'wrong-type']) {
      responseMode = mode
      const before = nativeCalls.filter(call => call.name === 'fixture_emit').length
      const done = await run(id, { count: '5' }, mode)
      assert.equal(done.status, 'failed')
      assert.deepEqual(done.outputs, {})
      assert.equal(nativeCalls.filter(call => call.name === 'fixture_emit').length, before, 'Invalid runtime input must be rejected before the second action')
      assert.match(done.error!, mode === 'missing-field' ? /Missing explicit text field/ : /参数|number/)
    }
    assert.equal(nativeCalls.filter(call => call.name === 'fixture_lookup').length, 4)
    assert.equal(nativeCalls.filter(call => call.name === 'fixture_emit').length, 2)
  } else if (group === 'http-structured') {
    const imported = JSON.parse(await service.importSwagger('workspace', JSON.stringify({ openapi: '3.0.0', info: { title: 'Fixture API' }, servers: [{ url: 'https://fixture.invalid' }], paths: { '/items/{key}': { get: { summary: 'Fixture amount', parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }] } } } })))
    const id = await publish('http-structured', wire('HTTP Swagger structured model', [
      { key: 'start', template: 'input', values: { fields: [{ name: 'key', label: 'Key', required: true }] } },
      { key: 'direct', template: 'http', values: { url: 'https://fixture.invalid/direct/{{input.key}}', method: 'GET' } },
      { key: 'check', template: 'code', values: { language: 'javascript', inputs: { status: '{{direct.status_code}}', value: '{{direct.json}}' }, code: 'function main(inputs) { if (inputs.status !== 200 || !inputs.value || typeof inputs.value.amount !== "number") throw Error("HTTP business contract rejected"); return {amount: inputs.value.amount}; }', outputSchema: [{ name: 'amount', type: 'number', required: true }] } },
      { key: 'swagger', template: templateIdForTool(imported[0].id), values: { inputs: { key: '{{input.key}}' } } },
      { key: 'extract', template: 'llm', values: { prompt: 'Evaluate {{check.amount}} and {{swagger.json.amount}} for {{input.key}}', model: { provider: 'fixture', model: 'offline' }, effort: 'none', outputSchema: [{ name: 'answer', type: 'string', required: true }] } },
      { key: 'result', template: 'output', values: { text: '{{extract.answer}}', outputName: 'result' } },
    ], ['start', 'direct', 'check', 'swagger', 'extract', 'result']))
    for (const [key, expected] of [['A', 'verified-A'], ['a/b', 'verified-holdout']]) {
      modelText = JSON.stringify({ answer: expected })
      const done = await run(id, { key: key! }, key === 'A' ? 'primary' : 'holdout')
      assert.equal(done.status, 'success', done.error)
      assert.equal(done.outputs.result, expected)
      assert.equal(done.usage?.unknownCalls, 1, 'Missing SDK usage remains unknown')
      const direct = done.executions.find(record => record.nodeId === done.graph.nodes.find(node => node.kind === 'http')!.id)!
      assert.equal(direct.data?.status_code, 200)
      assert.equal(Object.hasOwn(direct.data?.headers as object, 'set-cookie'), false)
    }
    assert.ok(fetchCalls.some(call => call.url.endsWith('/items/a%2Fb')))
    assert.equal(modelCalls[0].messages[0].content[0].text, 'Evaluate 7 and 11 for A')
    assert.equal(modelCalls[1].messages[0].content[0].text, 'Evaluate 7 and 11 for a/b')
    responseMode = 'http-error'
    const callsBefore = modelCalls.length
    const rejected = await run(id, { key: 'bad-http' }, 'http-error')
    assert.equal(rejected.status, 'failed')
    assert.match(rejected.error!, /HTTP business contract rejected/)
    assert.equal(modelCalls.length, callsBefore)
    responseMode = 'valid'
    modelText = '{"answer":42}'
    const malformed = await run(id, { key: 'bad-llm' }, 'malformed-model-structure')
    assert.equal(malformed.status, 'failed')
    assert.deepEqual(malformed.outputs, {})
    assert.match(malformed.error!, /answer.*string|answer.*字符串/)
    assert.equal(modelCalls.length, 3)
    assert.ok(modelCalls.every(call => call.provider === 'fixture' && call.model === 'offline'))
  } else if (group === 'subworkflow') {
    const childId = await publish('child', wire('Deterministic child', [
      { key: 'start', template: 'input', values: { fields: [{ name: 'count', label: 'Count', type: 'number', required: true }] } },
      { key: 'double', template: 'code', values: { language: 'javascript', code: 'function main(inputs) { if (inputs.count < 0) throw Error("Negative count rejected"); return {value: inputs.count * 2}; }', inputs: { count: '{{input.count}}' }, outputSchema: [{ name: 'value', type: 'number', required: true }] } },
      { key: 'result', template: 'output', values: { text: '{{double.value}}', outputName: 'result' } },
    ], ['start', 'double', 'result']))
    const parentId = await publish('parent', wire('Frozen child caller', [
      { key: 'start', template: 'input', values: { fields: [{ name: 'count', label: 'Count', type: 'number', required: true }] } },
      { key: 'child', template: templateIdForTool(`workflow:${childId}`), values: { inputs: { count: '{{input.count}}' } } },
      { key: 'result', template: 'output', values: { text: '{{child.outputs.result}}', outputName: 'result' } },
    ], ['start', 'child', 'result']))
    for (const [count, expected] of [[4, '8'], [9, '18'], [-1, null]]) {
      const done = await run(parentId, { count: String(count) }, expected === null ? 'child-failure' : count === 4 ? 'primary' : 'holdout')
      assert.equal(done.status, expected === null ? 'failed' : 'success')
      if (expected === null) assert.deepEqual(done.outputs, {})
      else assert.equal(done.outputs.result, expected)
      assert.ok(done.dependencySnapshots?.[childId], 'Parent must retain the frozen child graph')
      const call = done.executions.find(record => record.childRunId)!
      assert.ok(call?.childRunId)
      const child: WorkflowRun = JSON.parse(await service.run(call.childRunId))
      assert.equal(child.rootRunId, done.id)
      assert.equal(child.workflowId, childId)
      assert.equal(child.status, done.status)
      assert.notEqual(child.id, done.id)
    }
    const blocked = await publish('human-child', wire('Human is independently runnable', [
      { key: 'start', template: 'input', values: { fields: [] } },
      { key: 'review', template: 'human', values: { prompt: 'Review', fields: [], actions: [{ id: 'ok', label: 'OK' }] } },
      { key: 'result', template: 'output', values: { text: 'checked', outputName: 'result' } },
    ], ['start', 'review', 'result']))
    const choice = service.catalog.list('workspace', 'main').find((tool: any) => tool.id === `workflow:${blocked}`)
    assert.equal(choice.available, false)
    assert.match(choice.unavailableReason, /人工介入/)
  } else if (group === 'deep-subworkflow') {
    const { child, parent } = deepDesktopBundle(directory)
    await service.save(JSON.stringify(child), 0)
    await service.save(JSON.stringify(parent), 0)
    const cases = [
      { label: 'primary', inputs: { records: '[3,-2,0,4]', rounds: '2', threshold: '2' }, expected: '[6,0,0,8]' },
      { label: 'holdout', inputs: { records: '[1,5,2]', rounds: '3', threshold: '2' }, expected: '[0,15,0]' },
      { label: 'invalid', inputs: { records: '[1,"wrong",3]', rounds: '2', threshold: '0' }, expected: null },
    ]
    for (const sample of cases) {
      const done = await run(parent.id, sample.inputs, sample.label)
      assert.equal(done.status, sample.expected === null ? 'failed' : 'success', done.error)
      if (sample.expected === null) {
        assert.deepEqual(done.outputs, {})
        assert.match(done.error!, /finite numbers/)
      } else assert.equal(done.outputs.result, sample.expected)
      const caller = done.executions.find(record => record.childRunId)!
      const nested: WorkflowRun = JSON.parse(await service.run(caller.childRunId))
      assert.equal(nested.rootRunId, done.id)
      assert.equal(nested.workflowId, child.id)
      assert.equal(nested.status, done.status)
      assert.equal(nested.outputs.result ?? null, sample.expected)
      if (sample.expected !== null) assert.ok(nested.executions.length > 50)
      observations.push({ label: sample.label + '-deep-child', id: nested.id, rootRunId: nested.rootRunId, status: nested.status, outputs: nested.outputs, executionCount: nested.executions.length, engine: nested.engine })
    }
  } else if (group === 'dynamic-child-recovery') {
    const childId = await publish('dynamic-child', wire('Dynamic clock inside child', [
      { key: 'start', template: 'input', values: { fields: [{ name: 'marker', label: 'Marker', required: true }] } },
      { key: 'clock', template: templateIdForTool('builtin:time.timestamp'), values: { inputs: {} } },
      { key: 'result', template: 'output', values: { text: '{{input.marker}}:{{clock.seconds}}', outputName: 'result' } },
    ], ['start', 'clock', 'result']))
    const rootId = await publish('dynamic-root', wire('Explicit cached dynamic caller', [
      { key: 'start', template: 'input', values: { fields: [{ name: 'marker', label: 'Marker', required: true }] } },
      { key: 'child', template: templateIdForTool(`workflow:${childId}`), values: { inputs: { marker: '{{input.marker}}' }, cache: 'reuse' } },
      { key: 'result', template: 'output', values: { text: '{{child.outputs.result}}', outputName: 'result' } },
    ], ['start', 'child', 'result']))
    for (const marker of ['A', 'holdout']) {
      const beforeSeconds = Math.floor(Date.now() / 1000)
      const source = await run(rootId, { marker }, marker === 'A' ? 'primary' : 'holdout')
      assert.equal(source.status, 'success', source.error)
      const seconds = Number(source.outputs.result!.slice(marker.length + 1))
      assert.ok(source.outputs.result!.startsWith(marker + ':'))
      assert.ok(seconds >= beforeSeconds && seconds <= Math.floor(Date.now() / 1000))
      const original = service.storage.run(source.id)
      const call = source.executions.find(record => record.childRunId)!
      const base = JSON.parse(await service.recoveryPlan(source.id, ''))
      assert.equal(base.allowed, false, 'Caller cache must not hide a frozen dynamic dependency')
      const count = service.storage.runs().length
      await assert.rejects(service.recover(source.id, 'main', base.planDigest, ''), /不能自动重放/)
      assert.equal(service.storage.runs().length, count)
      const completed = { baseDigest: base.planDigest, decisions: [{ executionId: call.executionId ?? call.nodeId, action: 'completed', evidence: 'A fixture claim is not current clock evidence', output: { text: 'old' } }] }
      await assert.rejects(service.recoveryPlan(source.id, JSON.stringify(completed)), /绕过失效规则/)
      const review = { baseDigest: base.planDigest, decisions: [{ executionId: call.executionId ?? call.nodeId, action: 'redo', evidence: 'Explicit offline fixture authorizes a fresh child execution' }] }
      const plan = JSON.parse(await service.recoveryPlan(source.id, JSON.stringify(review)))
      assert.equal(plan.allowed, true)
      const started = JSON.parse(await service.recover(source.id, 'main', plan.planDigest, JSON.stringify(review)))
      const recovered = await runtime.settle(started.id)
      assert.equal(recovered.status, 'success', recovered.error)
      const newCall = recovered.executions.find((record: any) => record.childRunId)!
      assert.notEqual(newCall.childRunId, call.childRunId)
      assert.equal(newCall.reusedFromRunId, undefined)
      assert.deepEqual(service.storage.run(source.id), original)
      observations.push({ label: marker + '-explicit-redo', id: recovered.id, sourceRunId: recovered.sourceRunId, childRunId: newCall.childRunId, priorChildRunId: call.childRunId, status: recovered.status, engine: recovered.engine })
    }
    observations.push({ label: 'automatic-replay-and-forged-completion', kind: 'request-rejection', status: 'failed', rejectedBeforeNewRun: true })
  } else if (group === 'desktop-recovery-rehearsal') {
    // The Desktop T05.8.3 / T05.9.3 operator path: stop at human review, then 创建恢复运行.
    const started = async (id: string, inputs: Record<string, string>) => {
      const waiting: WorkflowRun = await runtime.settle(JSON.parse(await service.start(id, JSON.stringify(inputs), 'main')).id)
      assert.equal(waiting.status, 'waiting', waiting.error)
      return waiting
    }
    const cancelled = async (run: WorkflowRun) => {
      const stopped: WorkflowRun = JSON.parse(await service.cancel(run.id))
      assert.equal(stopped.status, 'cancelled')
      return runtime.settle(run.id) as Promise<WorkflowRun>
    }
    const approved = async (run: WorkflowRun) => {
      assert.equal(run.status, 'waiting', run.error)
      const done: WorkflowRun = await runtime.settle(JSON.parse(await service.answer(run.id, JSON.stringify({ __action: 'approve' }))).id)
      assert.equal(done.status, 'success', done.error)
      return done
    }
    const childId = await publish('t05-8-3-child', dynamicChildWire())
    const rootId = await publish('t05-8-3-root', dynamicRootWire(childId))
    for (const marker of ['A', 'holdout']) {
      const source = await cancelled(await started(rootId, { marker }))
      const call = source.executions.find(record => record.childRunId)!
      assert.equal(call.status, 'success')
      const sourceSeconds = Number(JSON.parse(await service.run(call.childRunId!)).outputs.result.slice(marker.length + 1))
      const original = service.storage.run(source.id), count = service.storage.runs().length
      const base = JSON.parse(await service.recoveryPlan(source.id, ''))
      assert.equal(base.allowed, false, 'Caller cache must not hide a frozen dynamic dependency')
      await assert.rejects(service.recover(source.id, 'main', base.planDigest, ''), /不能自动重放/)
      const executionId = call.executionId ?? call.nodeId
      const forged = { baseDigest: base.planDigest, decisions: [{ executionId, action: 'completed', evidence: '测试：沿用旧结果', output: { text: 'old' } }] }
      await assert.rejects(service.recoveryPlan(source.id, JSON.stringify(forged)), /绕过失效规则/)
      assert.equal(service.storage.runs().length, count)
      const redo = { baseDigest: base.planDigest, decisions: [{ executionId, action: 'redo', evidence: '测试：允许重新取当前时间' }] }
      const plan = JSON.parse(await service.recoveryPlan(source.id, JSON.stringify(redo)))
      assert.equal(plan.allowed, true)
      const recovered = await approved(await runtime.settle(JSON.parse(await service.recover(source.id, 'main', plan.planDigest, JSON.stringify(redo))).id))
      const newCall = recovered.executions.find(record => record.childRunId)!
      assert.notEqual(newCall.childRunId, call.childRunId)
      assert.equal(newCall.reusedFromRunId, undefined)
      assert.equal(recovered.sourceRunId, source.id)
      const seconds = Number(recovered.outputs.result!.slice(marker.length + 1))
      assert.ok(recovered.outputs.result!.startsWith(marker + ':') && seconds >= sourceSeconds)
      assert.deepEqual(service.storage.run(source.id), original)
      observations.push({ label: marker === 'A' ? 'primary' : 'holdout', kind: 'dynamic-child', id: recovered.id, sourceRunId: source.id, sourceStatus: source.status, childRunId: newCall.childRunId, priorChildRunId: call.childRunId, sourceSeconds, seconds, status: recovered.status })
    }
    const documentId = await publish('t05-9-3-document', documentWire())
    const v1Text = service.storage.get(documentId).nodes.find((node: any) => node.kind === 'output')!.config.text
    for (const [label, text] of [['primary', 'seller_id,seller_city,seller_state\nx1,campinas,SP\n'], ['holdout', '独立输入：42\n']] as const) {
      const outputText = (text: string) => { const library = service.storage.get(documentId), next = structuredClone(library); next.nodes.find((node: any) => node.kind === 'output')!.config.text = text; service.storage.save(next, library.revision) }
      if (label === 'holdout') outputText(v1Text)
      const upload = JSON.stringify({ name: 'sellers.csv', mimeType: 'text/csv', base64: Buffer.from(text).toString('base64') })
      const source = await cancelled(await started(documentId, { file: upload }))
      outputText(DOCUMENT_V2_TEXT)
      const original = service.storage.run(source.id)
      // A document read has no content fingerprint: the operator must explicitly allow its redo.
      const base = JSON.parse(await service.recoveryPlan(source.id, ''))
      assert.equal(base.allowed, false)
      const blocked = base.items.filter((item: any) => item.action === 'blocked')
      assert.deepEqual(blocked.map((item: any) => source.executions.find(row => (row.executionId ?? row.nodeId) === item.executionId)?.nodeId), [source.graph.nodes.find(node => node.kind === 'document')!.id])
      const redo = JSON.stringify({ baseDigest: base.planDigest, decisions: blocked.map((item: any) => ({ executionId: item.executionId, action: 'redo', evidence: '测试：附件按冻结快照重新读取' })) })
      const plan = JSON.parse(await service.recoveryPlan(source.id, redo))
      assert.equal(plan.allowed, true, JSON.stringify(plan.blockedReasons))
      const recovered = await approved(await runtime.settle(JSON.parse(await service.recover(source.id, 'main', plan.planDigest, redo)).id))
      assert.equal(recovered.outputs.result, 'v1:' + text)
      assert.equal(recovered.sourceRevision, source.sourceRevision)
      assert.ok(service.storage.get(documentId).revision > source.sourceRevision)
      const oldRef = JSON.parse(source.inputs.file!), freshRef = JSON.parse(recovered.inputs.file!)
      assert.notEqual(freshRef.workflowFileId, oldRef.workflowFileId)
      assert.deepEqual(service.storage.readAttachment(recovered.id, freshRef.workflowFileId), service.storage.readAttachment(source.id, oldRef.workflowFileId))
      assert.throws(() => service.storage.readAttachment(recovered.id, oldRef.workflowFileId), /不属于本次运行/)
      assert.deepEqual(service.storage.run(source.id), original)
      observations.push({ label, kind: 'attachment', id: recovered.id, sourceRunId: source.id, sourceRevision: source.sourceRevision, libraryRevision: service.storage.get(documentId).revision, priorFileId: oldRef.workflowFileId, fileId: freshRef.workflowFileId, output: recovered.outputs.result, status: recovered.status })
    }
    const missing = await cancelled(await started(documentId, { file: JSON.stringify({ name: 'temporary.csv', mimeType: 'text/csv', base64: Buffer.from('a,b\n1,2\n').toString('base64') }) }))
    const fileId = JSON.parse(missing.inputs.file!).workflowFileId, count = service.storage.runs().length
    renameSync(join(directory, 'attachments', missing.id, `${fileId}.json`), join(directory, `${fileId}.aside.json`))
    const base = JSON.parse(await service.recoveryPlan(missing.id, ''))
    const redo = JSON.stringify({ baseDigest: base.planDigest, decisions: base.items.filter((item: any) => item.action === 'blocked').map((item: any) => ({ executionId: item.executionId, action: 'redo', evidence: '测试：附件缺失' })) })
    const plan = JSON.parse(await service.recoveryPlan(missing.id, redo))
    await assert.rejects(service.recover(missing.id, 'main', plan.planDigest, redo), /附件不存在/)
    assert.equal(service.storage.runs().length, count)
    observations.push({ label: 'missing-attachment', kind: 'request-rejection', status: 'failed', rejectedBeforeNewRun: true })
  } else if (group === 'verified-trial-human') {
    writeFileSync(join(directory, 'input.json'), '{"name":"Ada"}')
    service.planner.options.driver.generate = async (input: PlanningAgentInput) => {
      planningCalls++
      input.beforeStep?.(120, undefined)
      input.beforeSubmission?.()
      assert.ok(input.compiler)
      if (input.purpose === 'author') assert.ok(input.templateQuery)
      const prompt = JSON.parse(input.prompt)
      let submission: any
      if (input.purpose === 'distill') {
        assert.equal(prompt.source.kind, 'verified-trial')
        assert.ok(prompt.trial.receiptDigest)
        submission = { mode: 'distill', procedure: {
          goal: 'Reusable reviewed greeting', parameters: [{ name: 'name', description: 'Current name' }],
          rules: ['Use this run input, keep the required human review'],
          steps: [{ id: 'S1', title: 'Review greeting', instruction: 'Generate Hello name and ask a human to confirm the greeting', dependsOn: [], evidenceRefs: prompt.conversation.records.map((record: any) => record.id), requiresReview: true, specRefs: ['trialTask.task'] }],
          excluded: [], reviewItems: ['Confirm the greeting is appropriate'],
        } }
      } else {
        assert.equal(input.purpose, 'author')
        submission = {
          mode: 'create', title: 'Reviewed trial template', forms: [
            { key: 'start', template: 'input', values: { fields: [{ name: 'name', label: 'Name', required: true }] } },
            { key: 'review', template: 'human', values: { prompt: 'Review Hello {{input.name}}', fields: [], actions: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] } },
            { key: 'result', template: 'output', values: { text: 'Hello {{input.name}}', outputName: 'result' } },
          ], chains: [{ key: 'prefix', nodes: ['start', 'review'] }],
          links: [{ key: 'approved', source: 'review', target: 'result', port: 'approve' }],
          coverage: { R1: ['review', 'result'], S1: ['review', 'result'] },
        }
      }
      const result = input.compiler.submit({ submission })
      assert.equal(result.ok, true, JSON.stringify(result))
      if (!result.ok) throw Error('Trial template compilation failed')
      return { output: result.value, steps: 1, usage: { totalTokens: 10 } }
    }
    service.trials.options.driver.run = async (input: any) => {
      trialExecutions++
      input.authorize()
      input.onPrepared?.({ toolDigest: 'a'.repeat(64), tools: [...input.tools] })
      input.onStep?.()
      const prompt = JSON.parse(input.prompt), path = prompt.artifacts[0].path
      const actualName = JSON.parse(readFileSync(join(directory, 'input.json'), 'utf8')).name
      const content = { text: responseMode === 'wrong-artifact' ? 'WRONG' : 'Hello ' + actualName }
      writeFileSync(join(directory, path), JSON.stringify(content))
      const events = [
        { seq: 0, type: 'turn/start', turn: 0 },
        { seq: 1, type: 'user/message', source: 'host', text: 'Frozen greeting fixture', truncated: false },
        { seq: 2, type: 'tool/call', turn: 0, callId: 'write-1', toolName: 'fixture_emit', text: JSON.stringify({ path, content }), truncated: false },
        { seq: 3, type: 'tool/result', turn: 0, callId: 'write-1', text: JSON.stringify(content), truncated: false, isError: false },
        { seq: 4, type: 'assistant/message', turn: 0, text: 'Artifact is ready for independent verification', truncated: false, interrupted: false },
        { seq: 5, type: 'turn/end', turn: 0, completed: true },
      ]
      for (const event of events) input.onEvent?.(event)
      return { childId: input.childId, stopReason: trialOutcome, outcome: trialOutcome, summary: 'Offline artifact driver', questions: [], events, steps: 1, usage: { totalTokens: 12 }, evidenceIncomplete: false }
    }
    const request = (id: string) => ({ requestId: id, operation: 'create', moduleCheck, instruction: 'Extract a reusable greeting with human review', execution: { mode: 'execute-first', task: 'Read input.json and emit Hello name, retaining a human review', tools: ['fixture_emit'], inputs: ['input.json'], artifacts: [{ path: id + '.json', format: 'json', requireChanged: true, checks: [{ kind: 'json-equals', pointer: '/text', value: 'Hello Ada' }] }], reviewItems: ['Confirm the greeting is appropriate'] }, optimizationTarget: { maxModelCalls: 0, maxAgentCalls: 0 } })
    const plan = async (id: string) => tool('visible_workflow_plan', { request_json: JSON.stringify(request(id)) })
    // The trial is the agent's rehearsal: no review card, generate, then the Host runs the saved workflow once.
    const trial = await plan('reviewed')
    assert.equal(trial.state, 'published', JSON.stringify(trial))
    assert.equal(trial.trialState, 'ready')
    assert.equal(trial.verification.verdict, 'needs-review')
    assert.ok(trial.diagnostics.some((row: any) => row.code === 'TRIAL_CHECK_WARNINGS'))
    assert.equal(trial.planning.source.kind, 'verified-trial')
    assert.ok(trial.planning.provenanceDigest)
    assert.deepEqual(trial.planning.procedure.reviewItems, ['Confirm the greeting is appropriate'])
    assert.equal(trial.planning.firstRun.status, 'recorded')
    assert.equal(trial.planning.firstRun.run.status, 'waiting')
    assert.equal(trialReviewQuestions, 0)
    assert.equal(trialExecutions, 1)
    assert.equal((await plan('reviewed')).taskId, trial.taskId)
    assert.equal(trialExecutions, 1, 'A valid verified trial is not replayed')
    const workflowId = trial.planning.receipt.workflowId
    // The first run has no name yet; it waits for input like any user start would, so clear it before the samples.
    assert.deepEqual(trial.planning.firstRun.run.waiting.missingFields.map((field: any) => field.name), ['name'])
    assert.equal(JSON.parse(await service.cancel(trial.planning.firstRun.runId)).status, 'cancelled')
    for (const name of ['Ada', '小明']) {
      const waiting = await run(workflowId, { name }, name === 'Ada' ? 'primary-waiting' : 'holdout-waiting')
      assert.equal(waiting.status, 'waiting')
      assert.equal(waiting.humanPrompt, 'Review Hello ' + name)
      await assert.rejects(service.answer(waiting.id, JSON.stringify({ __action: 'invented' })), /有效的人工操作/)
      const resumed = JSON.parse(await service.answer(waiting.id, JSON.stringify({ __action: 'approve' })))
      const done = await runtime.settle(resumed.id)
      assert.equal(done.status, 'success', done.error)
      assert.equal(done.outputs.result, 'Hello ' + name)
      observations.push({ label: name === 'Ada' ? 'primary' : 'holdout', id: done.id, status: done.status, outputs: done.outputs, engine: done.engine })
    }
    responseMode = 'wrong-artifact'
    const warned = await plan('wrong-artifact')
    assert.equal(warned.trialState, 'ready')
    assert.equal(warned.verification.verdict, 'failed')
    assert.ok(warned.diagnostics.some((row: any) => row.code === 'TRIAL_CHECK_WARNINGS'))
    assert.ok(warned.planningTaskId)
    observations.push({ label: 'wrong-artifact', kind: 'trial-verification', status: 'generated-with-warnings', planningTaskCreated: true })
    const beforeFailure = planningCalls
    trialOutcome = 'failed'
    const failed = await plan('execution-failed')
    assert.equal(failed.trialState, 'failed')
    assert.ok(failed.diagnostics.some((row: any) => row.code === 'TRIAL_EXECUTION_FAILED'))
    assert.equal(failed.planningTaskId, undefined)
    assert.equal(planningCalls, beforeFailure)
    assert.equal(trialReviewQuestions, 0)
    observations.push({ label: 'execution-failed', kind: 'trial-execution', status: 'failed', planningTaskCreated: false })
  } else throw Error('Unknown fixture group')
  assert.equal(fetchCalls.length === 0, group !== 'http-structured')
  assert.equal(modelCalls.length === 0, group !== 'http-structured')
  console.log(JSON.stringify({ passed: true, group, observations, nativeCalls, fetchCalls, sdkModelCalls: modelCalls.length, trialExecutions, planningCalls, externalModelCalls: 0, networkConnections: 0, boundary: 'Production Host/ToolRuntime/defineTool/template compiler/adapters/Graphon; tool bodies, fetch transport and SDK model streams are offline doubles' }))
} finally {
  await fiber.dispose()
  await toolsFiber.dispose()
  await promptFiber.dispose()
  for (const dispose of provisions.reverse()) await dispose()
  globalThis.fetch = originalFetch
  rmSync(directory, { recursive: true, force: true })
}
