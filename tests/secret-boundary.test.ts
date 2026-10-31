import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { inspectSecretBoundary } from '../src/host/secret-boundary.ts'
import { parseSecretBoundaryReport } from '../src/shared/secret-boundary.ts'
import { makeWorkflow, type EnvironmentVariable, type NodeConfig, type NodeKind } from '../src/shared/types.ts'
import { assertGraph, parseWorkflow } from '../src/shared/workflow-validation.ts'
import { environmentSnapshot } from '../src/shared/workflow-variables.ts'
import { exportWorkflowJson, importWorkflowJson } from '../src/shared/workflow-format.ts'
import { environmentDraft, environmentFromDraft, environmentMetadata } from '../src/client/workflow-variables.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowEditorState } from '../src/host/editor-state-store.ts'

const secret: EnvironmentVariable = { id: 'private-id', name: 'API_TOKEN', type: 'secret' }
const fixtureValue = 'synthetic-secret-must-not-cross-boundary'
const context = (services: Record<string, unknown>) => ({ get: (name: string) => services[name] })
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose() })

describe('Secret capability report is evidence-bounded', () => {
  it('detects registered interface shapes without reading credentials or invoking services', () => {
    const resolve = vi.fn(() => fixtureValue), describe = vi.fn(), confine = vi.fn(), ready = vi.fn(() => true)
    class LocalCredentialProvider { resolve = resolve; describe = describe; privatePath = '/private/never-expose'; value = fixtureValue }
    const report = inspectSecretBoundary(context({ credentials: new LocalCredentialProvider(), sandbox: { confine }, tools: { guard() {}, restrict() {} }, workflowSecretBroker: { ready, available: true, secret: fixtureValue } }))
    expect(report).toMatchObject({ available: false, status: 'unavailable', observations: { credentials: 'local-file', sandbox: 'file-policy-only', toolGuard: 'present', broker: 'unverified' } })
    expect(report.checks.find(check => check.id === 'credentials')?.detail).toContain('不能阻止')
    expect(report.checks.find(check => check.id === 'sandbox')?.detail).toContain('read-only 不等于')
    for (const spy of [resolve, describe, confine, ready]) expect(spy).not.toHaveBeenCalled()
    expect(JSON.stringify(report)).not.toContain(fixtureValue)
    expect(JSON.stringify(report)).not.toContain('/private/never-expose')
  })
  it('fails closed when services are absent, throw or expose hostile diagnostics', () => {
    const report = inspectSecretBoundary({ get: () => { throw new Error(fixtureValue) } })
    expect(report.observations).toEqual({ credentials: 'missing', sandbox: 'missing', toolGuard: 'missing', broker: 'missing' })
    expect(JSON.stringify(report)).not.toContain(fixtureValue)
    const hostile = new Proxy({}, { get: () => { throw new Error(fixtureValue) } })
    expect(inspectSecretBoundary(context({ credentials: hostile, sandbox: hostile })).available).toBe(false)
  })
  it('rejects forged availability/material and reconstructs safe display text', () => {
    const report = inspectSecretBoundary(context({}))
    expect(() => parseSecretBoundaryReport({ ...report, available: true })).toThrow()
    expect(() => parseSecretBoundaryReport({ ...report, credentialPath: '/private/example' })).toThrow()
    expect(() => parseSecretBoundaryReport({ ...report, observations: { ...report.observations, broker: 'verified' } })).toThrow()
    const projected = parseSecretBoundaryReport({ ...report, summary: fixtureValue, checks: report.checks.map(check => ({ ...check, label: fixtureValue, detail: fixtureValue })) })
    expect(JSON.stringify(projected)).not.toContain(fixtureValue)
  })
})

describe('Secret cannot enter ordinary workflow channels', () => {
  it.each(['value', 'secretRef', 'binding', 'credential', 'ciphertext', 'password', 'providerPath', 'configured'])('rejects %s in a Secret declaration before storage or import/export', key => {
    const flow = makeWorkflow('workspace')
    const poisoned = { ...flow, environmentVariables: [{ ...secret, [key]: fixtureValue }] }
    expect(() => parseWorkflow(poisoned)).toThrow()
    expect(() => exportWorkflowJson(poisoned as typeof flow, { includeEnvironmentValues: true })).toThrow()
    const envelope = JSON.parse(exportWorkflowJson(flow)); envelope.workflow = poisoned
    expect(() => importWorkflowJson(JSON.stringify(envelope), 'workspace')).toThrow()
  })
  it('keeps metadata, editable drafts, exported declarations and snapshots free of latent Secret values', () => {
    const latent = { ...secret, value: fixtureValue } as EnvironmentVariable
    expect(environmentMetadata([latent])).toEqual([])
    const draft = environmentDraft(latent)
    expect(draft).toMatchObject({ value: '', configured: false })
    expect(environmentFromDraft({ ...draft, value: fixtureValue, configured: true }, [])).not.toHaveProperty('value')
    const flow = makeWorkflow('workspace'); flow.environmentVariables = [secret]
    expect(environmentSnapshot(flow)).toEqual({})
    expect(JSON.parse(exportWorkflowJson(flow, { includeEnvironmentValues: true })).workflow.environmentVariables).toEqual([secret])
    expect(() => environmentSnapshot({ environmentVariables: [{ ...secret, required: true }] })).toThrow('系统凭据库')
  })
  it.each<[NodeKind, NodeConfig]>([
    ['template', { text: '{{env.private-id}}' }],
    ['template', { text: '{% if env.private-id %}leak{% endif %}' }],
    ['llm', { prompt: '{{env.private-id}}' }],
    ['agent', { prompt: 'read', tools: [], inputs: { value: '{{env.private-id}}' } }],
    ['code', { language: 'javascript', code: 'function main(inputs){return inputs}', inputs: { value: '{{env.private-id}}' } }],
    ['http', { url: 'https://example.invalid/', headers: { Authorization: 'Bearer {{env.private-id}}' } }],
    ['tool', { toolId: 'builtin:json.stringify', inputs: { value: '{{env.private-id}}' } }],
    ['output', { text: '{{env.private-id}}' }],
  ])('rejects handwritten Secret use in %s fields', (kind, config) => {
    const flow = makeWorkflow('workspace', 'boundary', true); flow.environmentVariables = [secret]
    flow.nodes[1]!.kind = kind; flow.nodes[1]!.config = config
    expect(() => assertGraph(parseWorkflow(flow))).toThrow('Secret')
  })
  it('rejects raw Secret material in persisted editor drafts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workflow-secret-boundary-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const storage = new WorkflowStorage(directory); cleanup.push(() => storage.close())
    const flow = storage.save(makeWorkflow('workspace'), 0), editor = new WorkflowEditorState(storage)
    const base = { id: 'draft', workflowId: flow.id, workspaceId: flow.workspaceId, kind: 'editor', updatedAt: '' }
    for (const payload of [{ environmentDraft: { type: 'secret', value: fixtureValue } }, { environmentDraft: { credential: fixtureValue } }, { environmentDraft: { password: fixtureValue } }]) {
      expect(() => editor.saveDraft({ ...base, payload }, 0)).toThrow()
    }
    expect(editor.drafts(flow.id)).toEqual([])
  })
})

describe('production Host Secret API/tool surface', () => {
  it('rejects injected material through actual public methods and registered Agent tools', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', new URL('./fixtures/secret-boundary-host-fixture.ts', import.meta.url).pathname], { timeout: 15_000 })
    expect(JSON.parse(stdout.trim())).toEqual({ ok: true, credentialReads: 0, rawValueExposed: false })
  })
})
