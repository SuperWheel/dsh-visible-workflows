// Actual Cordis injection + installed SDK projection fold, with inert model I/O.
import { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import VisibleWorkflowService from '../../src/host/index.ts'
import { resolveHarnessModelDefaults } from '../../src/host/model-defaults.ts'
import { makeWorkflow, newId, type WorkflowRun } from '../../src/shared/types.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

const require = createRequire(import.meta.url), sdkRequire = createRequire(require.resolve('@deepseek-ai/dsh-api-session-controller'))
const { default: Projections } = await import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-session-projection')).href)
const { installModelSelectionProjection } = await import(pathToFileURL(join(dirname(require.resolve('@deepseek-ai/dsh-api-session-controller')), 'types/model-selection-projection.js')).href)
const directory = mkdtempSync(join(tmpdir(), 'workflow-host-defaults-')), ctx = new Context(), calls: any[] = [], registered: any[] = []
const sessionId = SessionId('cold-session'), workspaceId = 'workspace'
let defaultSelection = { provider: 'harness', model: 'default', reasoningEffort: 'medium' }
const header = { config: { provider: 'old', model: 'old', reasoningEffort: 'high' }, adapterDefaults: { reasoningEffort: true } }
const pending = { provider: 'selected', model: 'current' }
let events: any[] = [{ seq: 0, type: 'request/header', data: { reason: 'initial', header } }, { seq: 1, type: 'model/selection', data: pending }]
const agents = new Map<string, any>()
const provisions = [
  ctx.provide('llm', { listModels: async (provider: string) => [{ id: provider === 'harness' ? 'default' : provider === 'selected' ? 'current' : 'old' }], resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }, { id: 'medium' }] } }), stream: async function* (request: any) { calls.push(request); yield { type: 'text-delta', text: 'fixture result' }; yield { type: 'finish', reason: { kind: 'stop' } } } }),
  ctx.provide('agents', { get: (id: string) => agents.get(id) }),
  ctx.provide('workspaceRegistry', { list: () => [{ id: workspaceId, title: 'Test', path: directory, sessionIds: [sessionId] }, { id: 'other', title: 'Other', path: join(directory, 'other'), sessionIds: [] }] }),
  ctx.provide('systemPrompt', { section: () => () => {} }), ctx.provide('typert', {}),
  ctx.provide('tools', { register: (tool: unknown) => { registered.push(tool); return () => {} }, schemas: () => [] }),
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ ...defaultSelection }) }),
  ctx.provide('sessionController', { inspect: async () => ({ meta: { id: sessionId, cwd: directory }, inheritedEventCount: 0, events }) }),
]
const projectionFiber = ctx.plugin(Projections); await projectionFiber; installModelSelectionProjection(ctx)
const fiber = ctx.plugin(VisibleWorkflowService, { stateDirectory: directory }); await fiber
assert.equal(fiber.state, 2)
const service = fiber.ctx.get('visibleWorkflows')!
const flow = (workspace = workspaceId) => { const graph = makeWorkflow(workspace, 'default fixture', true); graph.nodes[1]!.kind = 'llm'; graph.nodes[1]!.config = { prompt: '{{input.text}}' }; return graph }
const start = async (id: string, session = '', inputs = '{"text":"test"}') => JSON.parse(await service.start(id, inputs, session)) as WorkflowRun
const settle = async (id: string) => { for (let i = 0; i < 1500; i++) { const run = JSON.parse(await service.run(id)) as WorkflowRun; if (run.status !== 'running') return run; await new Promise<void>(resolve => setTimeout(resolve, 10)) } throw new Error('not settled') }
try {
  const host = flow(); await service.save(JSON.stringify(host), 0)
  const hostRun = await start(host.id); assert.equal((await settle(hostRun.id)).status, 'success'); assert.deepEqual(hostRun.modelDefaults, { model: { provider: 'harness', model: 'default' }, effort: 'medium', source: 'harness' })
  const cold = flow(); await service.save(JSON.stringify(cold), 0)
  const coldRun = await start(cold.id, sessionId); assert.equal((await settle(coldRun.id)).status, 'success'); assert.deepEqual(coldRun.modelDefaults, { model: { provider: 'selected', model: 'current' }, source: 'session' }); assert.equal(agents.size, 0)
  const other = flow('other'); await service.save(JSON.stringify(other), 0)
  const otherRun = await start(other.id, sessionId); assert.equal((await settle(otherRun.id)).status, 'success'); assert.equal(otherRun.modelDefaults?.source, 'harness')
  const live = { id: sessionId, ctx, session: { header: { cwd: directory }, requestHeader: () => header, snapshotEvents: () => events, inheritedEventCount: 0 } }
  agents.set(sessionId, live)
  const selected = await resolveHarnessModelDefaults(fiber.ctx, workspaceId, sessionId, live as any, true)
  assert.deepEqual(selected, { model: { provider: 'old', model: 'old' }, effort: 'high', source: 'session' })
  agents.clear()
  const pure = makeWorkflow(workspaceId, 'pure', true); await service.save(JSON.stringify(pure), 0)
  const removeDefault = provisions.splice(provisions.length - 2, 1)[0]!; await removeDefault()
  const removeController = provisions.pop()!; await removeController()
  const pureRun = await start(pure.id, sessionId); assert.equal((await settle(pureRun.id)).status, 'success')
  const missing = flow(); await service.save(JSON.stringify(missing), 0); await assert.rejects(start(missing.id), /DSH 也未配置默认模型/)
  provisions.push(ctx.provide('agentDefaultModel', { currentSelection: () => ({ ...defaultSelection }) }))
  // A parent without model nodes still captures its called workflow's default.
  const child = flow(); await service.save(JSON.stringify(child), 0)
  const parent = makeWorkflow(workspaceId, 'parent'), toolId = newId(); parent.nodes.splice(1, 0, { id: toolId, kind: 'tool', number: '', title: 'child', x: 200, y: 0, fixed: false, config: { toolId: `workflow:${child.id}`, inputs: { text: '{{input.text}}' } } }); parent.edges = [{ id: newId(), source: parent.nodes[0]!.id, target: toolId }, { id: newId(), source: toolId, target: parent.nodes.at(-1)!.id }]; parent.nodes.at(-1)!.config.text = `{{${toolId}.text}}`
  await service.save(JSON.stringify(parent), 0)
  const waiting = await start(parent.id, '', '{}'); assert.equal(waiting.status, 'waiting'); assert.equal(waiting.modelDefaults?.model.model, 'default')
  defaultSelection = { provider: 'later', model: 'changed', reasoningEffort: 'high' }
  await service.answer(waiting.id, '{"text":"same snapshot"}')
  const done = await settle(waiting.id); assert.equal(done.status, 'success'); assert.equal(calls.at(-1).provider, 'harness'); assert.equal(calls.at(-1).model, 'default')
  assert.equal(JSON.parse(await service.get(child.id)).nodes[1].config.model, undefined)
  console.log(JSON.stringify({ ok: true, cases: ['host-default', 'cold-pending', 'cross-workspace-default', 'live-current-request', 'pure-without-default-services', 'nested-workflow-frozen-default'] }))
} finally { await fiber.dispose(); await projectionFiber.dispose(); for (const dispose of provisions.reverse()) await dispose(); rmSync(directory, { recursive: true, force: true }) }
