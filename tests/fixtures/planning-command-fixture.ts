// Real installed SDK registry + Cordis optional injection. Agent followup is a
// recording double; real wake/turn lifecycle is covered by native acceptance.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { registerWorkflowPlanningCommand } from '../../src/host/planning/command.ts'

const require = createRequire(import.meta.url)
const sdkRequire = createRequire(require.resolve('@deepseek-ai/dsh-plan-mode'))
const { default: CommandRuntime } = await import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-commands')).href)
const ctx = new Context(), logs: { type: string; data: any }[] = [], followups: any[] = []
const agent: any = { id: 'main', ctx, followup: (message: any) => followups.push(message), session: { id: 'main', append: (type: string, data: any) => { logs.push({ type, data }); return logs.length - 1 } } }
const provisions = [ctx.provide('typert', {})]
const registry = ctx.plugin(CommandRuntime); await registry
assert.equal(registry.state, 2)
let authorized = 0
const command = ctx.plugin((scope: Context) => registerWorkflowPlanningCommand(scope, {
  authorize: (owner, signal) => { assert.equal(owner, agent); signal.throwIfAborted(); authorized++ },
})); await command
await new Promise(resolve => setTimeout(resolve, 0))
try {
  const service = registry.ctx.get('commands') as any
  assert.equal(service.list(agent).find((item: any) => item.name === 'dsh-visible-workflows').input.attachments, undefined)
  const signal = new AbortController().signal, input = '/dsh-visible-workflows\n  保持完整需求：A\nB  '
  const result = await service.execute(agent, input, [], signal)
  assert.deepEqual(result.result, { kind: 'success' })
  assert.equal(followups[0].content[0].text, input)
  assert.deepEqual(followups[0].source, { kind: 'user' }); assert.equal(followups[0].role, 'user')
  assert.deepEqual(logs.map(item => item.type), ['command/run', 'command/done'])
  assert.equal(logs[0]!.data.name, 'dsh-visible-workflows')
  assert.deepEqual(logs[0]!.data.source, { kind: 'user' })
  assert.equal(logs[1]!.data.commandId, logs[0]!.data.commandId)
  assert.equal(logs[1]!.data.text, undefined)
  assert.equal(await service.execute(agent, '/unknown-command', [], signal), undefined)
  const bare = await service.execute(agent, '/dsh-visible-workflows', [], signal)
  assert.deepEqual(bare.result, { kind: 'success' }); assert.equal(followups[1].content[0].text, '/dsh-visible-workflows')
  assert.equal(authorized, 2)
  await command.dispose()
  assert.equal(service.find(agent, 'dsh-visible-workflows'), undefined)
  console.log(JSON.stringify({ ok: true, nativeRegistry: true, exactInput: true, exactOwner: true, bareHandoff: true, followups: followups.length, commandOnlyEvents: true, unregister: true }))
} finally { await command.dispose(); await registry.dispose(); for (const dispose of provisions.reverse()) await dispose() }
