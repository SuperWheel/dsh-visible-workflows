import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { buildRecoveryPlan } from '../src/host/recovery-plan.ts'
import { initializeUsage } from '../src/host/run-usage.ts'
import { normalizeRun } from '../src/shared/run-compatibility.ts'
import { makeWorkflow, type WorkflowRun } from '../src/shared/types.ts'

const directories: string[] = [], stores: WorkflowStorage[] = [], runtimes: WorkflowRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const temporary = () => { const directory = mkdtempSync(join(tmpdir(), 'run-usage-compatibility-')); directories.push(directory); return directory }
const open = (directory: string) => { const store = new WorkflowStorage(directory); stores.push(store); return store }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function fixture() {
  const directory = temporary(), storage = open(directory), graph = storage.save(makeWorkflow('workspace', 'Usage compatibility', true), 0)
  const root: WorkflowRun = { id: 'root', workflowId: graph.id, workspaceId: graph.workspaceId, workflowTitle: graph.title, sourceRevision: graph.revision, graph, status: 'paused', inputs: { text: 'original' }, outputs: {}, executions: [], startedAt: '2026-10-21T00:00:00Z' }
  initializeUsage(root).spentTokens = 17
  const child: WorkflowRun = { ...structuredClone(root), id: 'child', rootRunId: root.id }
  storage.saveRun(root); storage.saveRun(child)
  return { directory, storage, root, child }
}
function putLegacy(directory: string, run: WorkflowRun) {
  const { usage, rootRunId, ...rest } = run
  // Deliberately old-only, formatted JSON and events, bypassing today's writer.
  writeFileSync(join(directory, 'runs', run.id + '.json'), JSON.stringify({ ...rest, budget: usage, ...(rootRunId ? { budgetRootRunId: rootRunId } : {}) }, null, 2) + '\n')
  writeFileSync(join(directory, 'runs', run.id + '.events.jsonl'), JSON.stringify({ id: `${run.id}:1`, seq: 1, at: run.startedAt, runId: run.id, status: run.status, executions: [], budget: usage }) + '\n')
}
// Pre-T19 revision; a shallow clone without it skips the rollback rehearsal.
const R3_REVISION = 'eae2c9c6dc6ced92b9bf88fa5b507d50463a7d96'
const hasRevision = (revision: string) => { try { execFileSync('git', ['cat-file', '-e', `${revision}^{commit}`], { stdio: 'ignore' }); return true } catch { return false } }
const bytes = (directory: string, run: WorkflowRun) => ['.json', '.events.jsonl'].map(suffix => readFileSync(join(directory, 'runs', run.id + suffix)))

describe('run field transition', () => {
  it.each(['paused', 'budget_waiting'] as const)('normalizes old-only %s runs without changing snapshot/event/library bytes or hashes', status => {
    const f = fixture(); f.storage.close()
    for (const run of [f.root, f.child]) { run.status = status; putLegacy(f.directory, run) }
    const before = [f.root, f.child].flatMap(run => bytes(f.directory, run)), library = readFileSync(join(f.directory, 'library.json'))
    for (let restart = 0; restart < 2; restart++) {
      const storage = open(f.directory)
      expect(storage.run('root').usage?.spentTokens).toBe(17)
      expect(storage.run('child').rootRunId).toBe('root')
      expect(storage.run('child')).not.toHaveProperty('budget')
      expect(storage.run('child')).not.toHaveProperty('budgetRootRunId')
      expect(storage.runs().map(run => run.usage?.spentTokens)).toEqual([17, 17])
      expect([f.root, f.child].flatMap(run => bytes(f.directory, run))).toEqual(before)
      expect([f.root, f.child].flatMap(run => bytes(f.directory, run)).map(hash)).toEqual(before.map(hash))
      expect(readFileSync(join(f.directory, 'library.json'))).toEqual(library)
      storage.close()
    }
  })

  it.each(['running', 'pausing'] as const)('persists the interruption of old-only %s runs once, with new names, aliases and the old events kept as prefix', status => {
    const f = fixture(); f.storage.close()
    for (const run of [f.root, f.child]) { run.status = status; putLegacy(f.directory, run) }
    const before = [f.root, f.child].map(run => bytes(f.directory, run)[1]!)
    const storage = open(f.directory)
    for (const [index, id] of ['root', 'child'].entries()) {
      expect(storage.run(id).status).toBe('interrupted')
      const persisted = JSON.parse(readFileSync(join(f.directory, 'runs', id + '.json'), 'utf8'))
      expect(persisted.status).toBe('interrupted'); expect(persisted.usage.spentTokens).toBe(17); expect(persisted.budget).toEqual(persisted.usage)
      if (id === 'child') { expect(persisted.rootRunId).toBe('root'); expect(persisted.budgetRootRunId).toBe('root') }
      const events = readFileSync(join(f.directory, 'runs', id + '.events.jsonl'))
      expect(events.subarray(0, before[index]!.length)).toEqual(before[index])
      expect(JSON.parse(events.toString().trim().split('\n').at(-1)!)).toMatchObject({ seq: 2, status: 'interrupted', usage: persisted.usage, budget: persisted.usage })
    }
    storage.close()
    const snapshots = [f.root, f.child].flatMap(run => bytes(f.directory, run))
    open(f.directory).close()
    expect([f.root, f.child].flatMap(run => bytes(f.directory, run))).toEqual(snapshots)
  })

  it('keeps current fields when both are present, including empty root identity', () => {
    const f = fixture(), legacyUsage = { ...f.root.usage!, spentTokens: 999 }
    const run = normalizeRun({ ...f.child, rootRunId: '', budget: legacyUsage, budgetRootRunId: 'wrong-root' })
    expect(run.usage?.spentTokens).toBe(17); expect(run.rootRunId).toBe('')
    expect(run).not.toHaveProperty('budget'); expect(run).not.toHaveProperty('budgetRootRunId')
  })

  it('uses old-only child coordination for recovery, resume protection and root cancel cascade; saves synchronized aliases', async () => {
    const f = fixture(); f.storage.close(); putLegacy(f.directory, f.root); putLegacy(f.directory, f.child)
    const storage = open(f.directory), runtime = new WorkflowRuntime(storage, { generate: async () => { throw Error('No model calls') } }); runtimes.push(runtime)
    const source = storage.run('child'), before = bytes(f.directory, f.child)
    expect(buildRecoveryPlan(storage.run('root'), 'resume')).toEqual(buildRecoveryPlan(f.root, 'resume'))
    expect(buildRecoveryPlan(source, 'resume').blockedReasons.join(' ')).toContain('所属根运行')
    expect(() => runtime.resume('child')).toThrow('所属根运行')
    expect(bytes(f.directory, f.child)).toEqual(before)
    await runtime.cancel('root')
    for (const id of ['root', 'child']) {
      expect(storage.run(id).status).toBe('cancelled')
      expect(storage.run(id).usage?.spentTokens).toBe(17)
      const persisted = JSON.parse(readFileSync(join(f.directory, 'runs', id + '.json'), 'utf8'))
      expect(persisted.usage).toEqual(persisted.budget)
      if (id === 'child') expect(persisted.rootRunId).toBe(persisted.budgetRootRunId)
    }
    expect(readFileSync(join(f.directory, 'runs', 'child.events.jsonl')).subarray(0, before[1]!.length)).toEqual(before[1])
  })

  it('persists new names and rollback aliases in snapshots and appended events, while reads expose only new names', () => {
    const f = fixture(), persisted = JSON.parse(bytes(f.directory, f.child)[0]!.toString())
    expect(persisted.usage.spentTokens).toBe(17); expect(persisted.rootRunId).toBe('root')
    expect(persisted.budget).toEqual(persisted.usage); expect(persisted.budgetRootRunId).toBe(persisted.rootRunId)
    const event = JSON.parse(bytes(f.directory, f.child)[1]!.toString().trim())
    expect(event.usage).toEqual(persisted.usage); expect(event.budget).toEqual(event.usage)
    expect(event.rootRunId).toBe('root'); expect(event.budgetRootRunId).toBe('root')
    f.storage.close(); expect(open(f.directory).run('child')).toEqual(f.child)
  })

  it.skipIf(!hasRevision(R3_REVISION))('rehearses actual r3 readers: aliases retain usage and child guards/cancel; omitting them loses both', async () => {
    const f = fixture(); f.storage.close()
    const checkout = temporary()
    cpSync(resolve('src'), join(checkout, 'src'), { recursive: true })
    symlinkSync(resolve('node_modules'), join(checkout, 'node_modules'), 'dir')
    writeFileSync(join(checkout, 'package.json'), '{"type":"module"}')
    // Fixed pre-T19 revision: never silently replace rollback evidence with the
    // new implementation when this test is run after T19 is committed.
    const revision = R3_REVISION
    for (const file of ['storage.ts', 'runtime.ts', 'run-usage.ts', 'recovery-plan.ts'])
      writeFileSync(join(checkout, 'src', 'host', file), execFileSync('git', ['show', `${revision}:src/host/${file}`]))
    const script = join(checkout, 'rehearse.ts')
    writeFileSync(script, `
      import assert from 'node:assert/strict'
      import { WorkflowStorage } from './src/host/storage.ts'
      import { WorkflowRuntime } from './src/host/runtime.ts'
      import { initializeUsage } from './src/host/run-usage.ts'
      import { buildRecoveryPlan } from './src/host/recovery-plan.ts'
      const storage = new WorkflowStorage(process.argv[2])
      const runtime = new WorkflowRuntime(storage, {generate:async()=>{throw Error('No model calls')}})
      try {
        const expectedAliases = process.argv[3] === 'aliases'
        assert.equal(initializeUsage(storage.run('root')).spentTokens, expectedAliases ? 17 : 0)
        assert.equal(buildRecoveryPlan(storage.run('child'),'resume').blockedReasons.some(r=>r.includes('所属根运行')), expectedAliases)
        if(expectedAliases) assert.throws(()=>runtime.resume('child'), /所属根运行/)
        await runtime.cancel('root')
        assert.equal(storage.run('child').status, expectedAliases ? 'cancelled' : 'paused')
        console.log(JSON.stringify({ok:true,expectedAliases}))
      } finally {await runtime.close();storage.close()}
    `)
    const execute = async (mode: string) => {
      const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', script, f.directory, mode], { timeout: 20_000 })
      expect(JSON.parse(stdout.trim())).toEqual({ ok: true, expectedAliases: mode === 'aliases' })
    }
    await execute('aliases')
    // Negative control proves old optional reads do not crash but silently lose
    // usage and fail to coordinate children when legacy names are omitted.
    for (const run of [f.root, f.child]) writeFileSync(join(f.directory, 'runs', run.id + '.json'), JSON.stringify(run))
    await execute('no-aliases')
  }, 30_000)
})
