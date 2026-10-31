import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWorkflow, newId, type WorkflowRun } from '../src/shared/types.ts'
import { WorkflowStorage } from '../src/host/storage.ts'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

const directories: string[] = [], stores: WorkflowStorage[] = []
function directory() { const path = mkdtempSync(join(tmpdir(), 'workflow-event-sequence-')); directories.push(path); return path }
function open(path = directory()) { const store = new WorkflowStorage(path); stores.push(store); return store }
function run(storage: WorkflowStorage): WorkflowRun {
  const graph = storage.save(makeWorkflow('workspace', 'Audit sequence'), 0)
  return { id: newId(), workflowId: graph.id, workspaceId: graph.workspaceId, workflowTitle: graph.title, sourceRevision: graph.revision, graph, status: 'paused', inputs: { text: 'original input' }, outputs: {}, executions: [], startedAt: new Date().toISOString() }
}
const eventFile = (storage: WorkflowStorage, id: string) => join(storage.directory, 'runs', `${id}.events.jsonl`)
function events(storage: WorkflowStorage, id: string): { id?: string; seq?: number; runId: string; status: string }[] { return readFileSync(eventFile(storage, id), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
afterEach(() => { for (const storage of stores.splice(0)) storage.close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); vi.mocked(readFileSync).mockClear() })

describe('stable append-only run event identities', () => {
  it('assigns increasing IDs, does not append no-op saves, and keeps audit fields out of run results', () => {
    const storage = open(), value = run(storage)
    storage.saveRun(value); value.outputs = { result: 'original result' }; storage.saveRun(value); storage.saveRun(value)
    expect(events(storage, value.id).map(item => [item.seq, item.id])).toEqual([[1, `${value.id}:1`], [2, `${value.id}:2`]])
    expect(storage.run(value.id)).toEqual(value)
    expect(JSON.parse(readFileSync(join(storage.directory, 'runs', `${value.id}.json`), 'utf8'))).toEqual(value)
    expect(value).not.toHaveProperty('seq'); expect(value).not.toHaveProperty('eventId')
  })

  it('continues across restarts including the existing interrupted-run audit event without replaying results', () => {
    const path = directory(), storage = open(path), value = run(storage)
    value.status = 'running'; value.outputs = { receipt: 'already recorded' }; storage.saveRun(value); storage.close()
    const reopened = open(path), interrupted = reopened.run(value.id)
    expect(interrupted.status).toBe('interrupted'); expect(interrupted.outputs).toEqual(value.outputs); expect(interrupted.graph).toEqual(value.graph)
    expect(events(reopened, value.id).map(item => [item.seq, item.status])).toEqual([[1, 'running'], [2, 'interrupted']])
    interrupted.error = 'Reviewed interruption'; reopened.saveRun(interrupted); reopened.close()
    const again = open(path), latest = again.run(value.id); latest.error = 'Additional audit detail'; again.saveRun(latest)
    const rows = events(again, value.id)
    expect(rows.map(item => item.seq)).toEqual([1, 2, 3, 4]); expect(new Set(rows.map(item => item.id)).size).toBe(4)
    expect(again.run(value.id).outputs).toEqual(value.outputs)
  })

  it('preserves old rows byte-for-byte and reserves their positions even when the old file has no trailing newline', () => {
    const path = directory(), storage = open(path), value = run(storage)
    storage.saveRun(value); storage.close()
    const legacy = ['paused', 'running', 'paused'].map(status => JSON.stringify({ at: '2026-10-16T00:00:00.000Z', runId: value.id, status, executions: [] })).join('\n')
    writeFileSync(eventFile(storage, value.id), legacy)
    const reopened = open(path), next = reopened.run(value.id); next.error = 'Continue legacy audit'; reopened.saveRun(next)
    const text = readFileSync(eventFile(reopened, value.id), 'utf8'), rows = events(reopened, value.id)
    expect(text.startsWith(`${legacy}\n`)).toBe(true)
    expect(rows.slice(0, 3).every(row => row.seq === undefined && row.id === undefined)).toBe(true)
    expect(rows[3]).toMatchObject({ seq: 4, id: `${value.id}:4` })
    reopened.close(); const again = open(path), last = again.run(value.id); last.error = 'Restart legacy audit'; again.saveRun(last)
    expect(events(again, value.id).at(-1)).toMatchObject({ seq: 5, id: `${value.id}:5` })
  })

  it('uses the existing sequence high-water mark rather than the physical row count', () => {
    const path = directory(), storage = open(path), value = run(storage)
    storage.saveRun(value); storage.close()
    writeFileSync(eventFile(storage, value.id), [
      { runId: value.id, status: 'paused' },
      { id: `${value.id}:40`, seq: 40, runId: value.id, status: 'paused' },
      { runId: value.id, status: 'paused' },
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    const reopened = open(path), next = reopened.run(value.id); next.error = 'Append after mixed rows'; reopened.saveRun(next)
    expect(events(reopened, value.id).at(-1)).toMatchObject({ seq: 42, id: `${value.id}:42` })
  })

  it('numbers each run independently and respects the existing exclusive Host lock', () => {
    const storage = open(), a = run(storage), b = run(storage)
    storage.saveRun(a); storage.saveRun(b)
    a.error = 'a2'; storage.saveRun(a); b.error = 'b2'; storage.saveRun(b); a.error = 'a3'; storage.saveRun(a)
    expect(events(storage, a.id).map(row => row.seq)).toEqual([1, 2, 3])
    expect(events(storage, b.id).map(row => row.seq)).toEqual([1, 2])
    expect(new Set([...events(storage, a.id), ...events(storage, b.id)].map(row => row.id)).size).toBe(5)
    expect(() => new WorkflowStorage(storage.directory)).toThrow('其他 Host 占用')
  })

  it('reads an existing event history once per Host and caches subsequent append positions', () => {
    const path = directory(), storage = open(path), value = run(storage)
    storage.saveRun(value); storage.close()
    const reopened = open(path), file = eventFile(reopened, value.id), next = reopened.run(value.id)
    const reads = () => vi.mocked(readFileSync).mock.calls.filter(args => args[0] === file).length
    expect(reads()).toBe(0)
    next.error = 'first append'; reopened.saveRun(next); expect(reads()).toBe(1)
    for (let i = 0; i < 5; i++) { next.error = `append ${i}`; reopened.saveRun(next) }
    expect(reads()).toBe(1)
    expect(events(reopened, value.id).map(row => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
})
