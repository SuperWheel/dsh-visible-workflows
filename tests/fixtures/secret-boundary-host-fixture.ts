import { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import VisibleWorkflowService from '../../src/host/index.ts'
import { makeWorkflow } from '../../src/shared/types.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

const directory = mkdtempSync(join(tmpdir(), 'secret-host-contract-')), ctx = new Context()
const definitions = new Map<string, any>(), value = 'synthetic-no-real-secret', path = '/private/fixture-credential-path'
let credentialReads = 0
class LocalCredentialProvider { resolve() { credentialReads++; return value }; describe() { credentialReads++; return { configured: true } }; privatePath = path }
const agent = { id: 'session', ctx, session: { id: 'session', header: { id: 'session', cwd: directory } } }
const prompt = ctx.plugin(SystemPrompt, {}); await prompt
const disposers = [
  ctx.provide('llm', {}), ctx.provide('typert', {}), ctx.provide('agents', { get: (id: string) => id === agent.id ? agent : undefined, isOwnedBy: () => false }),
  ctx.provide('credentials', new LocalCredentialProvider()), ctx.provide('sandbox', { confine() { throw new Error('must not probe by execution') } }),
  ctx.provide('workspaceRegistry', { list: () => [{ id: 'workspace', title: 'Fixture', path: directory, sessionIds: ['session'] }] }),
  ctx.provide('tools', { register(definition: any) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) }, schemas: () => [], guard() {}, restrict() {} }),
]
const fiber = ctx.plugin(VisibleWorkflowService, { stateDirectory: directory }); await fiber
try {
  assert.equal(fiber.state, 2)
  const service = fiber.ctx.get('visibleWorkflows')!, flow = makeWorkflow('workspace')
  flow.environmentVariables = [{ id: 'secret', name: 'TOKEN', type: 'secret' }]
  const saved = JSON.parse(await service.save(JSON.stringify(flow), 0))
  const poisoned = { ...saved, environmentVariables: [{ ...flow.environmentVariables[0], value }] }
  await assert.rejects(service.save(JSON.stringify(poisoned), saved.revision))
  const exec = { agent, signal: new AbortController().signal }
  await assert.rejects(definitions.get('visible_workflow_save').execute({ json: JSON.stringify(poisoned), expected_revision: saved.revision }, exec))
  const draft={id:'draft',workflowId:saved.id,workspaceId:'workspace',kind:'editor',updatedAt:'',payload:{environmentDraft:{id:'secret',name:'TOKEN',type:'secret',configured:false,binding:{value}}}}
  await assert.rejects(service.saveDraft(JSON.stringify(draft),0))
  assert.equal(await service.drafts(saved.id,''),'[]')
  await assert.rejects(service.propose(JSON.stringify(poisoned),saved.revision))
  const outputs = [await service.get(saved.id), await service.list('workspace'), await service.secretBoundary(), await definitions.get('visible_workflow_get').execute({ id: saved.id }, exec), await definitions.get('visible_workflow_list').execute({}, exec)]
  for (const output of outputs) { assert.ok(!output.includes(value)); assert.ok(!output.includes(path)) }
  const report = JSON.parse(outputs[2]!); assert.equal(report.available, false); assert.equal(report.schemaVersion, 4); assert.equal(report.mode, 'os-credential-store'); assert.equal(report.arbitraryLocalCodeIsolation, false)
  assert.equal([...definitions.keys()].some(name => /secret|credential/i.test(name)), false)
  assert.equal(credentialReads, 0)
  console.log(JSON.stringify({ ok: true, credentialReads, rawValueExposed: false }))
} finally { await fiber.dispose(); for (const dispose of disposers.reverse()) await dispose(); await prompt.dispose(); rmSync(directory, { recursive: true, force: true }) }
