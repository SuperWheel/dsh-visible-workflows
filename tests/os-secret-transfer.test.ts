import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OSSecretBroker, OSSecretError } from '../src/host/os-secret-broker.ts'
import { createExecutionAdapters } from '../src/host/execution-adapters.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { ToolCatalog } from '../src/host/tool-catalog.ts'
import { prepareWorkflowImport } from '../src/host/workflow-import.ts'
import { createWorkflowArchive, materializeWorkflowArchive, parseWorkflowArchive, writeWorkflowZip } from '../src/host/workflow-package-archive.ts'
import { inspectWorkflowReadiness } from '../src/host/workflow-readiness.ts'
import { osSecretStorageReport, parseOSSecretStorageReport } from '../src/shared/os-secret-storage.ts'
import { PROTECTED_OPERATION, type BrokerRequest, type BrokerScope } from '../src/shared/protected-secret.ts'
import { parseSecretBoundaryReport } from '../src/shared/secret-boundary.ts'
import { exportWorkflowJson, parseWorkflowPackage } from '../src/shared/workflow-format.ts'
import type { WorkflowImportCatalog } from '../src/shared/workflow-import.ts'
import { environmentSnapshot } from '../src/shared/workflow-variables.ts'
import { makeWorkflow, type Workflow } from '../src/shared/types.ts'
import { allNodes } from '../src/shared/workflow-validation.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'os-secret-transfer-'))
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}
function storage() {
  const store = new WorkflowStorage(directory())
  cleanups.push(() => store.close())
  return store
}
function catalog(workflows: Workflow[] = []): WorkflowImportCatalog { return { workflows, models: [], tools: [], presets: [] } }
function protectedFlow(workspaceId = 'source'): Workflow {
  const flow = makeWorkflow(workspaceId, 'OS credential transfer fixture', true)
  flow.nodes[0]!.config.fields = []
  flow.environmentVariables = [
    { id: 'credential', name: 'API_KEY', type: 'secret', required: true, revision: 4 },
    { id: 'region', name: 'REGION', type: 'string', value: 'cn', revision: 2 },
  ]
  const http = flow.nodes[1]!
  http.kind = 'http'; http.title = '受控账户检查'; http.x = 340.25; http.y = -80.5
  http.config = { credentialOperation: { secretVariableId: 'credential', operationId: PROTECTED_OPERATION } }
  flow.nodes[2]!.config = { text: `{{${http.id}.status_code}}`, outputName: 'result' }
  flow.notes = [{ id: 'note', text: '迁移后重新配置', x: 320.25, y: 200.5, width: 280, height: 140, color: 'yellow', anchorNodeId: http.id }]
  flow.editor = { viewport: { x: -10.25, y: 25.5, scale: .75 }, scopePath: [], annotations: [{ id: 'annotation', number: 1, nodeIds: [http.id], text: '仅返回状态码', position: { x: 480.5, y: 40.25, scopePath: [] } }] }
  return flow
}
const scope = (flow: Workflow, variableId = flow.environmentVariables![0]!.id, nodeId = 'environment'): BrokerScope => ({ workspaceId: flow.workspaceId, workflowId: flow.id, variableId, nodeId })
const scopeKey = (value: BrokerScope) => JSON.stringify([value.workspaceId, value.workflowId, value.variableId])

/** Only native transport is doubled. This registry contains presence metadata,
 * never a test credential. It does not prove native authentication or Keychain. */
function metadataBroker(initial: BrokerScope[] = [], initialAuthorizations: BrokerScope[] = []) {
  const broker = new OSSecretBroker(), configured = new Set(initial.map(scopeKey)), authorized = new Set(initialAuthorizations.map(scopeKey))
  const invoke = vi.spyOn(broker as unknown as { invoke(request: BrokerRequest, signal?: AbortSignal): Promise<unknown> }, 'invoke')
    .mockImplementation(async (request, signal) => {
      signal?.throwIfAborted()
      if (request.command === 'probe') return { ok: true, available: true, code: 'available' }
      if (request.command === 'status') {
        const present = configured.has(scopeKey(request.scope))
        return { ok: true, state: present ? 'configured' : 'missing', authorization: present && authorized.has(scopeKey(request.scope)) ? 'authorized' : 'required' }
      }
      if (request.command === 'execute') {
        if (!configured.has(scopeKey(request.scope))) throw new OSSecretError('item_missing')
        if (!authorized.has(scopeKey(request.scope))) throw new OSSecretError('authorization_required')
        return { ok: true, status_code: 204 }
      }
      throw new Error('Native management must not be opened by transfer or readiness')
    })
  cleanups.push(() => broker.close())
  return { broker, configured, authorized, invoke }
}
// Match the Host's passive readiness mapping: component availability and a
// configured value are not authorization to execute a protected operation.
const readinessStatus = (broker: OSSecretBroker) => async (flow: Workflow, id: string) => {
  const status = await broker.status(scope(flow, id))
  return status.state === 'missing' ? 'missing' : allNodes(flow).some(node => node.config.credentialOperation?.secretVariableId === id) && status.authorization !== 'authorized' ? 'authorization_required' : 'configured'
}
const checkedAt = '2026-10-17T10:00:00.000Z'
const availableReport = () => osSecretStorageReport('macos', { ok: true, available: true, code: 'available' }, checkedAt)

describe('OS Secret schema 4 is a metadata report, never a credential or authorization', () => {
  it('rebuilds display text from closed fields through both parsers', () => {
    const report = availableReport(), marker = 'synthetic-untrusted-diagnostic-do-not-display'
    const untrusted = { ...report, summary: marker, checks: report.checks.map(check => ({ ...check, label: marker, detail: marker, status: 'missing' as const })).reverse() }
    for (const parse of [parseOSSecretStorageReport, parseSecretBoundaryReport]) {
      const result = parse(untrusted)
      expect(result).toEqual(report)
      expect(JSON.stringify(result)).not.toContain(marker)
      expect(result).toMatchObject({ schemaVersion: 4, protection: 'workflow-interfaces', arbitraryLocalCodeIsolation: false })
    }
  })

  it.each([
    ['extra root value', (value: any) => { value.value = 'synthetic' }],
    ['extra native binding', (value: any) => { value.nativeProbe.binding = 'synthetic' }],
    ['extra check grant', (value: any) => { value.checks[0].grant = true }],
    ['duplicate check', (value: any) => { value.checks[1] = { ...value.checks[0] } }],
    ['unknown probe code', (value: any) => { value.nativeProbe.code = 'untrusted-diagnostic' }],
    ['inconsistent probe', (value: any) => { value.nativeProbe.available = false }],
    ['inconsistent report', (value: any) => { value.status = 'unavailable' }],
    ['unverified Windows backend', (value: any) => { value.platform = 'windows' }],
    ['whole device guarantee', (value: any) => { value.arbitraryLocalCodeIsolation = true }],
    ['broader protection claim', (value: any) => { value.protection = 'all-processes' }],
  ])('rejects %s instead of accepting an expanded capability', (_name, change) => {
    const report = structuredClone(availableReport()); change(report)
    expect(() => parseOSSecretStorageReport(report)).toThrow()
    expect(() => parseSecretBoundaryReport(report)).toThrow()
  })

  it('keeps Windows explicitly unavailable and does not equate availability with a binding', async () => {
    const report = parseSecretBoundaryReport(osSecretStorageReport('windows', { ok: true, available: false, code: 'unsupported_platform' }, checkedAt))
    expect(report.available).toBe(false)
    expect(report.summary).toContain('实机验收')
    expect(() => osSecretStorageReport('windows', { ok: true, available: true, code: 'available' }, checkedAt)).toThrow()
    const flow = protectedFlow(), { broker, invoke } = metadataBroker()
    expect(availableReport().available).toBe(true)
    expect(await broker.status(scope(flow))).toEqual({ state: 'missing', authorization: 'required' })
    expect(invoke.mock.calls.map(([request]) => request.command)).toEqual(['status'])
  })
})

describe('JSON/ZIP migrations retain declarations but create new OS credential identities', () => {
  const forgedAuthorizations = [
    { field: 'grant', value: { approved: true, operation: PROTECTED_OPERATION } },
    { field: 'authorization', value: 'authorized' },
    { field: 'approved', value: true },
  ]

  it.each(forgedAuthorizations)('rejects forged JSON Secret $field instead of importing an authorization', async ({ field, value }) => {
    const source = protectedFlow(), root = directory(), { configured, authorized, invoke } = metadataBroker([scope(source)], [scope(source)])
    const pkg = JSON.parse(exportWorkflowJson(source, { includeEnvironmentValues: true }))
    pkg.workflow.environmentVariables[0][field] = value
    const text = JSON.stringify(pkg)
    expect(() => parseWorkflowPackage(text)).toThrow(/Unrecognized key/)
    await expect(prepareWorkflowImport(text, 'target', {}, catalog(), root)).rejects.toThrow(/Unrecognized key/)
    expect(configured).toEqual(new Set([scopeKey(scope(source))]))
    expect(authorized).toEqual(new Set([scopeKey(scope(source))]))
    expect(invoke).not.toHaveBeenCalled()
    expect(readdirSync(root)).toEqual([])
  })

  it.each(forgedAuthorizations)('rejects forged ZIP Secret $field before writing attachments or authorizing use', async ({ field, value }) => {
    const source = protectedFlow(), sourceRoot = directory(), targetRoot = directory(), { configured, authorized, invoke } = metadataBroker([scope(source)], [scope(source)])
    writeFileSync(join(sourceRoot, 'instructions.txt'), 'Public attachment fixture.')
    source.nodes[1]!.config.verification = { requiredReadFiles: ['instructions.txt'] }
    const bytes = await createWorkflowArchive(source, sourceRoot, { includeEnvironmentValues: true })
    const valid = parseWorkflowArchive(bytes.toString('base64'))
    expect(valid.files).toHaveLength(1)
    const pkg = JSON.parse(valid.entries.get('workflow.json')!.toString('utf8'))
    pkg.workflow.environmentVariables[0][field] = value
    valid.entries.set('workflow.json', Buffer.from(JSON.stringify(pkg)))
    // Rebuild correct ZIP checksums: rejection must come from the Secret schema.
    const forged = writeWorkflowZip(valid.entries).toString('base64')
    expect(() => parseWorkflowArchive(forged)).toThrow(/Unrecognized key/)
    await expect(materializeWorkflowArchive(forged, targetRoot)).rejects.toThrow(/Unrecognized key/)
    expect(configured).toEqual(new Set([scopeKey(scope(source))]))
    expect(authorized).toEqual(new Set([scopeKey(scope(source))]))
    expect(invoke).not.toHaveBeenCalled()
    expect(readdirSync(targetRoot)).toEqual([])
  })

  it.each([
    { workspaceId: 'source', overwrite: false },
    { workspaceId: 'target', overwrite: false },
    { workspaceId: 'source', overwrite: true },
    { workspaceId: 'target', overwrite: true },
  ])('requires a new binding for $workspaceId, overwrite=$overwrite', async ({ workspaceId, overwrite }) => {
    const source = protectedFlow(), store = storage(), prior = store.save(protectedFlow(workspaceId), 0), root = directory()
    const { broker, configured, authorized, invoke } = metadataBroker([scope(source), scope(prior)], [scope(source), scope(prior)])
    const options = overwrite ? { overwrite: { workflowId: prior.id, expectedRevision: prior.revision } } : {}
    const prepared = await prepareWorkflowImport(exportWorkflowJson(source, { includeEnvironmentValues: true }), workspaceId, options, catalog([prior]), root)
    expect(prepared.preview.canImport).toBe(true)
    const imported = store.importBundle(prepared.workflow, prepared.presets!, options.overwrite)
    const importedScope = scope(imported)
    expect(imported.workspaceId).toBe(workspaceId)
    expect(imported.id).toBe(overwrite ? prior.id : prepared.workflow!.id)
    expect(imported.id).not.toBe(source.id)
    expect(importedScope.variableId).not.toBe(scope(source).variableId)
    expect(imported.nodes[1]!.config.credentialOperation).toEqual({ secretVariableId: importedScope.variableId, operationId: PROTECTED_OPERATION })
    const context = { workspaceRoot: root, catalog: catalog(), secretStatus: readinessStatus(broker) }
    const missing = await inspectWorkflowReadiness(imported, context)
    expect(missing.canRun).toBe(false)
    expect(missing.issues).toEqual([expect.objectContaining({ kind: 'secret', nodeId: imported.nodes[1]!.id, dependencyId: importedScope.variableId })])
    expect(store.save(imported, imported.revision)).toEqual(imported)
    expect(await broker.status(scope(source))).toEqual({ state: 'configured', authorization: 'authorized' })
    expect(await broker.status(scope(prior))).toEqual({ state: 'configured', authorization: 'authorized' })
    // A source report, old target and same variable name provide no authorization.
    expect(parseSecretBoundaryReport(availableReport()).available).toBe(true)
    expect(await broker.status(importedScope)).toEqual({ state: 'missing', authorization: 'required' })
    expect(authorized.has(scopeKey(importedScope))).toBe(false)
    configured.add(scopeKey(importedScope))
    expect(await broker.status(importedScope)).toEqual({ state: 'configured', authorization: 'required' })
    const unapproved = await inspectWorkflowReadiness(imported, context)
    expect(unapproved.canRun).toBe(false)
    expect(unapproved.issues[0]!.message).toContain('尚未授权自动使用')
    authorized.add(scopeKey(importedScope))
    expect((await inspectWorkflowReadiness(imported, context)).canRun).toBe(true)
    authorized.delete(scopeKey(importedScope))
    expect((await inspectWorkflowReadiness(imported, context)).canRun).toBe(false)
    expect(await broker.status(importedScope)).toEqual({ state: 'configured', authorization: 'required' })
    configured.delete(scopeKey(importedScope))
    expect((await inspectWorkflowReadiness(imported, context)).canRun).toBe(false)
    expect(invoke.mock.calls.every(([request]) => request.command === 'status')).toBe(true)
    expect(environmentSnapshot(imported, true)).toEqual({ [imported.environmentVariables![1]!.id]: 'cn' })
    expect(imported.nodes.map(node => [node.kind, node.x, node.y])).toEqual(source.nodes.map(node => [node.kind, node.x, node.y]))
    expect(imported.notes[0]).toEqual({ ...source.notes[0], id: expect.any(String), anchorNodeId: imported.nodes[1]!.id })
    expect(imported.editor).toEqual({ ...source.editor, annotations: [{ ...source.editor!.annotations![0], id: expect.any(String), nodeIds: [imported.nodes[1]!.id] }] })
    const persisted = JSON.parse(readFileSync(join(store.directory, 'library.json'), 'utf8')).workflows.find((flow: Workflow) => flow.id === imported.id)
    expect(persisted.environmentVariables[0]).toEqual({ id: importedScope.variableId, name: 'API_KEY', type: 'secret', required: true, revision: 0 })
  })

  it('keeps ZIP files and the canvas usable while OS status is missing or unavailable', async () => {
    const source = protectedFlow(), sourceRoot = directory(), targetRoot = directory()
    writeFileSync(join(sourceRoot, 'instructions.txt'), 'Public attachment fixture.')
    source.nodes[1]!.config.verification = { requiredReadFiles: ['instructions.txt'] }
    const bytes = await createWorkflowArchive(source, sourceRoot, { includeEnvironmentValues: true })
    const parsed = parseWorkflowArchive(bytes.toString('base64'))
    expect(parsed.pkg.workflow.environmentVariables![0]).toEqual(source.environmentVariables![0])
    expect(parsed.pkg.workflow.environmentVariables![0]).not.toHaveProperty('value')
    const materialized = await materializeWorkflowArchive(bytes.toString('base64'), targetRoot)
    const prepared = await prepareWorkflowImport(materialized.text, 'target', {}, catalog(), targetRoot)
    const imported = prepared.workflow!, { broker, configured, authorized, invoke } = metadataBroker([scope(source)], [scope(source)])
    expect(prepared.preview.canImport).toBe(true)
    expect(readFileSync(join(targetRoot, imported.nodes[1]!.config.verification!.requiredReadFiles![0]!), 'utf8')).toBe('Public attachment fixture.')
    const context = { workspaceRoot: targetRoot, catalog: catalog(), secretStatus: readinessStatus(broker), canVerifyFileReads: () => true }
    expect((await inspectWorkflowReadiness(imported, context)).issues).toEqual([expect.objectContaining({ kind: 'secret', nodeId: imported.nodes[1]!.id })])
    invoke.mockRejectedValueOnce(new OSSecretError('keychain_failed'))
    expect((await inspectWorkflowReadiness(imported, context)).issues).toEqual([expect.objectContaining({ kind: 'secret', nodeId: imported.nodes[1]!.id })])
    const importedKey = scopeKey(scope(imported))
    expect(authorized.has(importedKey)).toBe(false)
    configured.add(importedKey)
    expect((await inspectWorkflowReadiness(imported, context)).issues).toEqual([expect.objectContaining({ kind: 'secret', message: expect.stringContaining('尚未授权自动使用') })])
    authorized.add(importedKey)
    expect((await inspectWorkflowReadiness(imported, context)).canRun).toBe(true)
    authorized.delete(importedKey)
    expect((await inspectWorkflowReadiness(imported, context)).canRun).toBe(false)
    expect(imported.editor!.viewport).toEqual(source.editor!.viewport)
    const exported = exportWorkflowJson(imported)
    expect(parseWorkflowPackage(exported).workflow.environmentVariables![0]).not.toHaveProperty('value')
    expect(exported).not.toMatch(/"authorization"|"authorized"/)
    await materialized.cleanup()
    expect(readdirSync(targetRoot)).toEqual([])
  })
})

describe('existing execution adapters and snapshots with the OS Secret facade', () => {
  function runtimeFixture(denyUse: boolean, authorize = true) {
    const store = storage(), saved = store.save(protectedFlow('workspace'), 0)
    const { broker, configured, authorized, invoke } = metadataBroker([scope(saved)], authorize ? [scope(saved)] : [])
    if (denyUse) {
      const transport = invoke.getMockImplementation()!
      invoke.mockImplementation(async (request, signal) => {
        if (request.command === 'execute') throw new OSSecretError('authentication_failed')
        return transport(request, signal)
      })
    }
    const ordinaryHttp = vi.fn(async () => { throw new Error('Protected requests must not use generic HTTP') })
    const backend = { generate: vi.fn(async () => { throw new Error('No model expected') }) }
    const tools = new ToolCatalog({ directory: store.directory, workflows: () => [], nativeTools: () => [], executeNative: async () => ({}), runWorkflow: async () => ({}), http: ordinaryHttp })
    // Fixture glue follows Host's scope contract; native transport/Host RPC
    // authorization are separate suites, not claimed by this runtime test.
    const adapters = createExecutionAdapters({ catalog: tools, workspaceRoot: () => store.directory, requestHttp: ordinaryHttp,
      secretPreflight: async (flow, signal) => {
        const status = await broker.status(scope(flow), signal)
        if (status.state !== 'configured') throw new OSSecretError('item_missing')
        if (allNodes(flow).some(node => node.config.credentialOperation?.secretVariableId === scope(flow).variableId) && status.authorization !== 'authorized') throw new OSSecretError('authorization_required')
      },
      protectedHttp: request => broker.execute(scope(saved, request.node.config.credentialOperation!.secretVariableId, request.node.id), request.signal),
    })
    const runtime = new WorkflowRuntime(store, backend, adapters)
    cleanups.push(() => runtime.close())
    return { store, saved, broker, configured, authorized, invoke, runtime, ordinaryHttp, backend }
  }

  it('persists only operation refs and bounded results, preserving ordinary environment values', async () => {
    const fixture = runtimeFixture(false), started = fixture.runtime.start(fixture.saved.id, {})
    const done = await fixture.runtime.settle(started.id)
    expect(done.status).toBe('success')
    expect(done.outputs).toEqual({ result: '204' })
    expect(done.environment).toEqual({ region: 'cn' })
    expect(done.graph.environmentVariables![0]).toEqual(fixture.saved.environmentVariables![0])
    const http = done.executions.find(execution => execution.nodeId === fixture.saved.nodes[1]!.id)!
    expect(JSON.parse(http.input!)).toEqual({ credentialOperation: { secretVariableId: 'credential', operationId: PROTECTED_OPERATION } })
    expect(http.data).toEqual({ ok: true, status_code: 204 })
    expect(fixture.invoke.mock.calls.map(([request]) => request.command)).toEqual(['status', 'execute'])
    const request = fixture.invoke.mock.calls[1]![0]
    expect(request).toEqual({ version: 1, command: 'execute', operation: PROTECTED_OPERATION, scope: scope(fixture.saved, 'credential', fixture.saved.nodes[1]!.id) })
    expect(fixture.ordinaryHttp).not.toHaveBeenCalled()
    expect(fixture.backend.generate).not.toHaveBeenCalled()
    const snapshot = fixture.store.run(done.id)
    expect(snapshot.environment).toEqual({ region: 'cn' })
    expect(snapshot.graph.environmentVariables![0]).not.toHaveProperty('value')
    expect(parseWorkflowPackage(exportWorkflowJson(snapshot.graph, { includeEnvironmentValues: true })).workflow.environmentVariables![0]).not.toHaveProperty('value')
  })

  it('retains native failure handling even when passive status reports an existing grant', async () => {
    const fixture = runtimeFixture(true), started = fixture.runtime.start(fixture.saved.id, {})
    const done = await fixture.runtime.settle(started.id)
    expect(done.status).toBe('failed')
    expect(done.error).toBe(new OSSecretError('authentication_failed').message)
    expect(done.outputs).toEqual({})
    expect(done.environment).toEqual({ region: 'cn' })
    expect(fixture.invoke.mock.calls.map(([request]) => request.command)).toEqual(['status', 'execute'])
    expect(fixture.ordinaryHttp).not.toHaveBeenCalled()
    expect(fixture.backend.generate).not.toHaveBeenCalled()
  })

  it('blocks a configured Secret before native use until it is authorized', async () => {
    const fixture = runtimeFixture(false, false), started = fixture.runtime.start(fixture.saved.id, {})
    const done = await fixture.runtime.settle(started.id)
    expect(done.status).toBe('failed')
    expect(done.error).toBe(new OSSecretError('authorization_required').message)
    expect(done.outputs).toEqual({})
    expect(fixture.invoke.mock.calls.map(([request]) => request.command)).toEqual(['status'])
    expect(fixture.ordinaryHttp).not.toHaveBeenCalled()
    expect(fixture.backend.generate).not.toHaveBeenCalled()
    expect(fixture.store.run(done.id).environment).toEqual({ region: 'cn' })
    expect(fixture.store.run(done.id).graph.environmentVariables![0]).not.toHaveProperty('value')
  })

  it('reuses an existing grant across runs, then blocks the next run after revocation', async () => {
    const fixture = runtimeFixture(false)
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = fixture.runtime.start(fixture.saved.id, {}), done = await fixture.runtime.settle(started.id)
      expect(done.status).toBe('success')
      expect(done.outputs).toEqual({ result: '204' })
      expect(JSON.stringify(fixture.store.run(done.id))).not.toMatch(/"authorization"|"authorized"/)
    }
    fixture.authorized.delete(scopeKey(scope(fixture.saved)))
    const started = fixture.runtime.start(fixture.saved.id, {}), done = await fixture.runtime.settle(started.id)
    expect(done.status).toBe('failed')
    expect(done.error).toBe(new OSSecretError('authorization_required').message)
    expect(fixture.configured.has(scopeKey(scope(fixture.saved)))).toBe(true)
    expect(fixture.invoke.mock.calls.map(([request]) => request.command)).toEqual(['status', 'execute', 'status', 'execute', 'status'])
    expect(fixture.ordinaryHttp).not.toHaveBeenCalled()
    expect(fixture.backend.generate).not.toHaveBeenCalled()
  })

  it('still rejects a revoked grant at native use after a successful passive preflight', async () => {
    const fixture = runtimeFixture(false), transport = fixture.invoke.getMockImplementation()!
    fixture.invoke.mockImplementation(async (request, signal) => {
      if (request.command === 'execute') fixture.authorized.delete(scopeKey(request.scope))
      return transport(request, signal)
    })
    const started = fixture.runtime.start(fixture.saved.id, {}), done = await fixture.runtime.settle(started.id)
    expect(done.status).toBe('failed')
    expect(done.error).toBe(new OSSecretError('authorization_required').message)
    expect(done.outputs).toEqual({})
    expect(fixture.invoke.mock.calls.map(([request]) => request.command)).toEqual(['status', 'execute'])
    expect(fixture.ordinaryHttp).not.toHaveBeenCalled()
    expect(fixture.backend.generate).not.toHaveBeenCalled()
    expect(fixture.store.run(done.id).environment).toEqual({ region: 'cn' })
    expect(fixture.store.run(done.id).graph.environmentVariables![0]).not.toHaveProperty('value')
  })

  it('does not require an OS backend for an unused optional Secret or an ordinary HTTP request', async () => {
    const store = storage(), flow = protectedFlow('workspace'), { broker, invoke } = metadataBroker()
    flow.environmentVariables![0]!.required = false
    flow.nodes[1]!.config = { url: 'https://example.invalid/{{env.region}}', method: 'GET', headers: { 'X-Region': '{{env.region}}' } }
    const saved = store.save(flow, 0)
    invoke.mockRejectedValue(new OSSecretError('unsupported_platform'))
    const ready = await inspectWorkflowReadiness(saved, { catalog: catalog(), workspaceRoot: store.directory, secretStatus: readinessStatus(broker) })
    expect(ready.canRun).toBe(true)
    const ordinaryHttp = vi.fn(async () => ({ status_code: 200, body: 'Public response' }))
    const preflight = vi.fn(async () => { throw new OSSecretError('unsupported_platform') })
    const tools = new ToolCatalog({ directory: store.directory, workflows: () => [], nativeTools: () => [], executeNative: async () => ({}), runWorkflow: async () => ({}), http: ordinaryHttp })
    const runtime = new WorkflowRuntime(store, { generate: async () => { throw new Error('No model expected') } }, createExecutionAdapters({ catalog: tools, workspaceRoot: () => store.directory, requestHttp: ordinaryHttp, secretPreflight: preflight }))
    cleanups.push(() => runtime.close())
    const started = runtime.start(saved.id, {}), done = await runtime.settle(started.id)
    expect(done.status).toBe('success')
    expect(done.outputs).toEqual({ result: '200' })
    expect(done.environment).toEqual({ region: 'cn' })
    expect(ordinaryHttp).toHaveBeenCalledExactlyOnceWith('https://example.invalid/cn', 'GET', { 'X-Region': 'cn' }, undefined, expect.any(AbortSignal), 30_000, expect.any(Function))
    expect(preflight).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })
})
