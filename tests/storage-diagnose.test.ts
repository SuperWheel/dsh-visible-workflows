import { afterEach, describe, expect, it, vi } from 'vitest'
import { constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { makeWorkflow } from '../src/shared/types.ts'

const fault = vi.hoisted(() => ({ shortRead: false, deny: '', vanished: '', opens: [] as number[] }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
    openSync: (path: Parameters<typeof fs.openSync>[0], flags: Parameters<typeof fs.openSync>[1], ...rest: unknown[]) => {
      fault.opens.push(flags as number)
      if (String(path) === fault.vanished) throw Object.assign(new Error('vanished'), { code: 'ENOENT' })
      if (String(path) === fault.deny) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return fs.openSync(path, flags, ...(rest as []))
    },
    readSync: (...args: Parameters<typeof fs.readSync>) => fault.shortRead ? 0 : fs.readSync(...args),
  }
})
const { diagnoseStorage } = await import('../scripts/storage-diagnostics.ts')
const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks(); fault.shortRead = false; fault.deny = ''; fault.vanished = ''; fault.opens = []
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const fresh = () => {
  const path = mkdtempSync('/private/tmp/t15-storage-'); directories.push(path); return path
}
const put = (root: string, name: string, value: unknown, raw = false) => {
  const path = join(root, name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, raw ? value as string : JSON.stringify(value))
  return path
}
const flow = () => ({ ...makeWorkflow('synthetic', '合成工作流', true), revision: 1 })
const run = (id = randomUUID()) => {
  const graph = flow()
  return { id, graph, workflowId: graph.id, workspaceId: graph.workspaceId, status: 'success', inputs: {}, outputs: {}, executions: [], startedAt: '2026-10-21T00:00:00Z' }
}
const event = (runId: string, seq: number) => ({ id: `${runId}:${seq}`, runId, seq, status: 'success', executions: [] })
const library = (root: string, workflows: unknown[] = []) => put(root, 'library.json', { schema: 2, workflows, presets: [] })
const codes = (report: ReturnType<typeof diagnoseStorage>) => report.records.flatMap(r => r.findings.map(f => f.code))

// Snapshot every directory, link and exact file byte; atime is deliberately excluded because read-only opens may update it.
function tree(root: string): unknown[] {
  const result: unknown[] = []
  const visit = (path: string) => {
    const meta = lstatSync(path)
    result.push({ path, mode: meta.mode, size: meta.size, ino: meta.ino, mtime: meta.mtimeMs, ctime: meta.ctimeMs,
      bytes: meta.isFile() ? readFileSync(path).toString('base64') : undefined,
      link: meta.isSymbolicLink() ? readlinkSync(path) : undefined })
    if (meta.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name))
  }
  visit(root); return result
}
function scan(root: string) {
  const before = tree(root)
  fault.opens = []
  const result = diagnoseStorage(root)
  expect(tree(root)).toEqual(before)
  for (const flags of fault.opens) {
    expect(flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND)).toBe(0)
    expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
  }
  return result
}

describe('T15 non-destructive storage diagnosis', () => {
  it('accepts an empty directory without creating a store or acquiring a lock', () => {
    const root = fresh(), result = scan(root)
    expect(result).toMatchObject({ readOnly: true, complete: true, host: { state: 'absent' }, summary: { findings: 0 } })
    expect(readdirSync(root)).toEqual([])
  })

  it('separates historical orphans, owned references, unused files and damaged owner snapshots', () => {
    const root = fresh(), owned = run(), corrupt = randomUUID(), orphan = randomUUID(), fileId = randomUUID(), unused = randomUUID()
    const snapshot = { ...owned, inputs: { file: JSON.stringify({ workflowFileId: fileId }) } }
    put(root, `runs/${owned.id}.json`, snapshot)
    put(root, `runs/${corrupt}.json`, '{broken', true)
    for (const [id, file] of [[owned.id, fileId], [owned.id, unused], [corrupt, fileId], [orphan, fileId]]) put(root, `attachments/${id}/${file}.json`, { runId: id, name: 'fixture.txt', base64: 'eA==' })
    const result = scan(root), orphanRows = result.records.filter(r => r.findings.some(f => f.code === 'orphan-attachment'))
    expect(orphanRows).toHaveLength(1)
    expect(orphanRows[0].identity.runId).toBe(orphan)
    const referenced = result.records.find(r => r.kind === 'attachment' && r.identity.runId === owned.id && r.identity.fileId === fileId)!
    expect(referenced.references).toEqual(expect.arrayContaining([expect.objectContaining({ relation: 'workflowFileId', id: fileId })]))
    expect(referenced.findings).toEqual([])
    expect(codes(result)).toContain('unreferenced-attachment')
    expect(result.records.find(r => r.kind === 'attachment' && r.identity.runId === corrupt)?.findings).toEqual([])
    for (const row of result.records.filter(r => r.findings.length)) {
      expect(row.size).toBeTypeOf('number'); expect(row.modifiedAt).toBeTypeOf('string')
      for (const finding of row.findings) { expect(finding.reason.length).toBeGreaterThan(0); expect(finding.suggestedAction.length).toBeGreaterThan(0) }
    }
  })

  it('reports dead PIDs and mismatched recovery tokens without removing either lock', () => {
    const root = fresh()
    put(root, 'host.lock', { pid: 12345, token: 'host-token' }); put(root, 'host.lock.recovery', { pid: 12346, token: 'recovery-token' })
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(), { code: 'ESRCH' }) })
    const result = scan(root)
    expect(result.host.state).toBe('dead')
    expect(result.summary.byCode).toMatchObject({ 'dead-lock-owner': 2, 'lock-token-mismatch': 2, 'recovery-gate-present': 1 })
    expect(probe.mock.calls.every(args => args[1] === 0)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('host-token')
  })

  it.each(['host.lock', 'host.lock.recovery', 'runs', 'attachments', 'planning', 'editor-state.json', 'library.json'])('does not follow a symlink at %s', name => {
    const root = fresh(), outside = fresh()
    put(outside, 'sentinel', 'external marker', true)
    symlinkSync(outside, join(root, name))
    const outsideBefore = tree(outside), result = scan(root)
    expect(codes(result)).toContain('symbolic-link')
    expect(result.complete).toBe(false)
    expect(tree(outside)).toEqual(outsideBefore)
    expect(JSON.stringify(result)).not.toContain('external marker')
    expect(fault.opens).toHaveLength(0)
  })

  it('rejects a redirected root and a redirected ancestor without reading their targets', () => {
    const root = fresh(), outside = fresh(), link = join(root, 'link')
    mkdirSync(join(outside, 'store')); symlinkSync(outside, link)
    const before = tree(outside)
    expect(codes(diagnoseStorage(link))).toContain('symbolic-link')
    expect(codes(diagnoseStorage(join(link, 'store')))).toContain('read-error')
    expect(tree(outside)).toEqual(before)
    expect(fault.opens).toHaveLength(0)
  })

  it.each(['runs/r.json', 'runs/r.events.jsonl', 'runs/r.events.quarantine.jsonl', 'attachments/r/file.json'])('does not open a nested linked file at %s', name => {
    const root = fresh(), outside = fresh(), target = put(outside, 'sentinel', 'unread external bytes', true)
    mkdirSync(join(root, name, '..'), { recursive: true }); symlinkSync(target, join(root, name))
    const before = tree(outside), result = scan(root)
    expect(codes(result)).toContain('symbolic-link')
    expect(JSON.stringify(result)).not.toContain('unread external bytes')
    expect(tree(outside)).toEqual(before)
    expect(fault.opens).toHaveLength(0)
  })

  it('reports scalar locks and malformed proposal identities without hiding them or coercing objects', () => {
    const root = fresh()
    library(root)
    put(root, 'host.lock', null); put(root, 'host.lock.recovery', [])
    put(root, 'editor-state.json', { drafts: [], proposals: [{ id: {}, workflowId: { toString: null }, candidate: null }] })
    const result = scan(root)
    expect(result.summary.byCode['invalid-lock']).toBe(2)
    expect(codes(result)).toContain('invalid-proposal')
  })

  it('reports a live lock as possibly writing, including invalid bytes, without acquiring a lock', () => {
    const root = fresh()
    put(root, 'host.lock', { pid: process.pid, token: 'live' }); put(root, 'runs/broken.json', '{', true)
    const result = scan(root)
    expect(result).toMatchObject({ host: { state: 'alive' }, consistency: 'possibly-writing' })
    expect(result.records.find(r => r.kind === 'run-snapshot')).toMatchObject({ observation: 'possibly-writing', findings: [expect.objectContaining({ code: 'invalid-json' })] })
    expect(result.summary.byCode['dead-lock-owner']).toBeUndefined()
  })

  it('keeps permission-denied PID ownership unknown, and rejects malformed lock identities', () => {
    const root = fresh()
    put(root, 'host.lock', { pid: 12345, token: 'x' }); put(root, 'host.lock.recovery', { pid: -1 })
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(), { code: 'EPERM' }) })
    const result = scan(root)
    expect(result.host.state).toBe('unknown')
    expect(codes(result)).toEqual(expect.arrayContaining(['unknown-lock-owner', 'invalid-lock']))
    expect(codes(result)).not.toContain('dead-lock-owner')
  })

  it('inventories damaged snapshots, torn event tails, committed bad rows and F25 quarantine evidence', () => {
    const root = fresh(), valid = run()
    put(root, `runs/${valid.id}.json`, valid)
    put(root, 'runs/truncated.json', '{"id":', true)
    put(root, 'runs/mismatch.json', run())
    const prefix = JSON.stringify(event(valid.id, 1)) + '\n', tail = '{"runId":"残'
    put(root, `runs/${valid.id}.events.jsonl`, prefix + tail, true)
    put(root, 'runs/middle.events.jsonl', JSON.stringify(event('middle', 1)) + '\nINVALID\n' + JSON.stringify(event('middle', 2)) + '\n', true)
    put(root, `runs/${valid.id}.events.quarantine.jsonl`, JSON.stringify({ runId: valid.id, byteOffset: Buffer.byteLength(prefix), detectedAt: '2026-10-21T00:00:00Z', bytesBase64: Buffer.from(tail).toString('base64') }) + '\n', true)
    const result = scan(root)
    expect(codes(result)).toEqual(expect.arrayContaining(['invalid-json', 'invalid-run-snapshot', 'truncated-tail', 'invalid-jsonl-row', 'quarantined-event-tail', 'event-without-snapshot']))
    const preserved = result.records.flatMap(r => r.findings).find(f => f.code === 'quarantined-event-tail')!
    expect(preserved.details).toMatchObject({ originalByteOffset: Buffer.byteLength(prefix), preservedBytes: Buffer.byteLength(tail) })
    expect(JSON.stringify(result)).not.toContain(Buffer.from(tail).toString('base64'))
  })

  it('accepts legacy events and a complete final row without newline but reports duplicate sequences and invalid quarantine identities', () => {
    const root = fresh(), value = run()
    put(root, `runs/${value.id}.json`, value)
    put(root, `runs/${value.id}.events.jsonl`, JSON.stringify({ runId: value.id, status: 'success' }) + '\n' + JSON.stringify(event(value.id, 2)), true)
    expect(scan(root).summary.findings).toBe(0)
    put(root, `runs/${value.id}.events.jsonl`, [event(value.id, 2), event(value.id, 2), event('wrong', 3)].map(v => JSON.stringify(v)).join('\n') + '\n', true)
    put(root, `runs/${value.id}.events.quarantine.jsonl`, JSON.stringify({ runId: value.id, byteOffset: -1, bytesBase64: '?' }) + '\n', true)
    expect(codes(scan(root))).toEqual(expect.arrayContaining(['invalid-event-sequence', 'event-identity-mismatch', 'invalid-quarantine-record']))
  })

  it('checks tasks, background and trials generations, including ignored corrupt journals', () => {
    const root = fresh(), gen = randomUUID(), old = randomUUID()
    for (const name of ['planning/tasks', 'planning/background', 'trials/planning/tasks']) {
      put(root, name + '.json', { version: 1, tasks: [{ id: 'task' }], journal: gen })
      put(root, name + '.journal', JSON.stringify({ generation: old }) + '\nBAD\n{"id":', true)
    }
    const result = scan(root)
    expect(result.summary.byCode).toMatchObject({ 'planning-generation-mismatch': 3, 'invalid-jsonl-row': 3, 'truncated-tail': 3 })
  })

  it('allows a lazy absent journal and repeated updates but exposes missing snapshots, invalid headers and snapshots', () => {
    const root = fresh(), gen = randomUUID()
    put(root, 'planning/tasks.json', { version: 1, tasks: [{ id: 'task' }], journal: gen })
    expect(scan(root).summary.findings).toBe(0)
    put(root, 'planning/tasks.journal', [JSON.stringify({ generation: gen }), '{"id":"task"}', '{"id":"task"}'].join('\n') + '\n', true)
    expect(scan(root).summary.findings).toBe(0)
    put(root, 'planning/background.journal', 'invalid header\n', true)
    put(root, 'trials/planning/tasks.json', { version: 2, tasks: [] })
    expect(codes(scan(root))).toEqual(expect.arrayContaining(['journal-without-snapshot', 'invalid-journal-header', 'invalid-planning-snapshot']))
  })

  it('identifies the F26 partial acceptance, mismatched accepted versions and missing workflows', () => {
    const root = fresh(), candidate = { ...flow(), title: '候选已保存', revision: 2 }
    library(root, [candidate])
    const proposal = { id: randomUUID(), workflowId: candidate.id, baseRevision: 1, status: 'pending', candidate: { ...candidate, revision: 1 }, createdAt: '2026-10-21T00:00:00Z' }
    const missing = flow()
    put(root, 'editor-state.json', { drafts: [], proposals: [proposal,
      { ...proposal, id: randomUUID(), status: 'accepted', candidate: { ...candidate, title: '冲突' } },
      { ...proposal, id: randomUUID(), workflowId: missing.id, candidate: missing },
    ] })
    const result = scan(root)
    expect(codes(result)).toEqual(expect.arrayContaining(['pending-candidate-already-saved', 'accepted-proposal-mismatch', 'proposal-workflow-missing']))
    expect(result.records.find(r => r.kind === 'editor-state')?.references).toHaveLength(3)
  })

  it('does not flag accepted proposals after later definition edits or viewport-only changes', () => {
    const root = fresh(), candidate = flow(), current = { ...candidate, title: '后续正常编辑', revision: 2 }
    library(root, [current])
    const proposal = { id: randomUUID(), workflowId: candidate.id, baseRevision: 0, status: 'accepted', candidate }
    put(root, 'editor-state.json', { drafts: [], proposals: [proposal] })
    expect(scan(root).summary.findings).toBe(0)
    library(root, [{ ...candidate, editor: { viewport: { x: 5, y: 5, scale: 1 }, scopePath: [] } }])
    expect(scan(root).summary.findings).toBe(0)
  })

  it('does not call an attachment orphaned when the run directory cannot be read', () => {
    const root = fresh(), outside = fresh(), id = randomUUID()
    symlinkSync(outside, join(root, 'runs'))
    put(root, `attachments/${id}/${randomUUID()}.json`, { runId: id, name: 'x', base64: '' })
    const result = scan(root)
    expect(codes(result)).toContain('attachment-reference-unknown')
    expect(codes(result)).not.toContain('orphan-attachment')
  })

  it('reports unreadable files and continues inspecting other components', () => {
    const root = fresh(), id = randomUUID()
    fault.deny = library(root)
    put(root, `runs/${id}.json`, '{}', true)
    expect(codes(scan(root))).toEqual(expect.arrayContaining(['read-error', 'invalid-run-snapshot']))
  })

  it('treats a short concurrent read as possibly writing without throwing or changing bytes', () => {
    const root = fresh()
    library(root); fault.shortRead = true
    const result = scan(root)
    expect(result.consistency).toBe('possibly-writing')
    expect(result.complete).toBe(true)
    expect(codes(result)).toContain('possibly-writing')
  })

  it('reports a file disappearing between inspection and open as possibly writing rather than a scan failure', () => {
    const root = fresh()
    fault.vanished = library(root)
    const result = scan(root)
    expect(result).toMatchObject({ complete: true, consistency: 'possibly-writing' })
    expect(codes(result)).toContain('possibly-writing')
    expect(codes(result)).not.toContain('read-error')
  })

  it('bounds oversized snapshot reads', () => {
    const root = fresh()
    library(root)
    // Sparse oversized fixture, without allocating 32 MB of source data.
    mkdirSync(join(root, 'runs'))
    put(root, 'runs/large.json', '', true); truncateSync(join(root, 'runs/large.json'), 32_000_001)
    expect(codes(scan(root))).toContain('size-limit')
  })

  it('exposes JSON-only CLI output and requires an explicit directory', () => {
    const root = fresh()
    library(root)
    const before = tree(root)
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/storage-diagnose.ts', root], { encoding: 'utf8' })
    expect(JSON.parse(output)).toMatchObject({ directory: root, readOnly: true, complete: true })
    expect(tree(root)).toEqual(before)
    expect(() => execFileSync(process.execPath, ['--import', 'tsx', 'scripts/storage-diagnose.ts'], { stdio: 'pipe' })).toThrow()
  })
})

