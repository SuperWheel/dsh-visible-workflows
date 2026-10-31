import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, type Stats } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, parse, resolve } from 'node:path'
import { parseWorkflow } from '../src/host/validation.ts'
import { workflowDefinitionContent } from '../src/shared/workflow-content.ts'
import type { Workflow } from '../src/shared/types.ts'

type ObjectValue = Record<string, unknown>
type Reference = { path: string; relation: string; id?: string }
type Finding = { code: string; reason: string; suggestedAction: string; details?: ObjectValue }
export interface DiagnosticRecord {
  path: string
  kind: string
  identity: ObjectValue
  references: Reference[]
  size: number | null
  modifiedAt: string | null
  observation: 'observed' | 'possibly-writing' | 'unreadable'
  findings: Finding[]
}
export interface StorageDiagnosticReport {
  version: 1
  directory: string
  readOnly: true
  complete: boolean
  consistency: 'observed' | 'possibly-writing'
  host: { pid?: number; state: 'absent' | 'alive' | 'dead' | 'unknown' }
  summary: { records: number; findings: number; byCode: Record<string, number> }
  records: DiagnosticRecord[]
}
const object = (v: unknown): v is ObjectValue => !!v && typeof v === 'object' && !Array.isArray(v)
const safeId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(v)
const generation = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v)
const runStatuses = new Set(['waiting', 'running', 'paused', 'pausing', 'budget_waiting', 'success', 'failed', 'cancelled', 'interrupted'])
const executionStatuses = new Set(['pending', 'running', 'waiting', 'success', 'failed', 'skipped', 'cancelled'])
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const stamp = (s: Stats) => [s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs].join(':')
const code = (e: unknown) => (e as NodeJS.ErrnoException).code ?? 'UNKNOWN'
const backup = '停止写入后备份整个存储目录及本清单，核对身份与引用，再按第 13 篇人工处理；诊断不修改文件。'

/** Only read descriptors are opened. No store constructors, lock acquisition or recovery routines. */
export function diagnoseStorage(input: string): StorageDiagnosticReport {
  const root = resolve(input)
  const report: StorageDiagnosticReport = {
    version: 1, directory: root, readOnly: true, complete: true, consistency: 'observed',
    host: { state: 'absent' }, summary: { records: 0, findings: 0, byCode: {} }, records: [],
  }
  const observed = new Map<string, { meta: Stats; record: DiagnosticRecord }>()
  const absent = new Set<string>()
  const add = (r: DiagnosticRecord, c: string, reason: string, details?: ObjectValue, action = backup) => {
    r.findings.push({ code: c, reason, suggestedAction: action, ...(details ? { details } : {}) })
  }
  const changed = (r: DiagnosticRecord) => {
    r.observation = 'possibly-writing'; report.consistency = 'possibly-writing'
    if (!r.findings.some(f => f.code === 'possibly-writing')) add(r, 'possibly-writing', '可能在写入：读取期间文件或目录身份、大小、修改时间发生变化。', undefined, '保留本次观察，待写入结束后重新诊断；不能据此删除或修复。')
  }
  const record = (path: string, kind: string, identity: ObjectValue = {}): DiagnosticRecord => {
    const r: DiagnosticRecord = { path, kind, identity, references: [], size: null, modifiedAt: null, observation: 'observed', findings: [] }
    report.records.push(r)
    return r
  }
  // Reject redirected ancestors as well as leaf symlinks. Never follow links found in the inventory.
  const assertParents = (path: string) => {
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      const meta = lstatSync(parent)
      const prior = observed.get(parent)
      if (prior && stamp(meta) !== stamp(prior.meta)) throw Object.assign(new Error(), { code: 'CHANGED_PARENT' })
      if (!meta.isDirectory() || meta.isSymbolicLink()) throw Object.assign(new Error(), { code: 'UNSAFE_PARENT' })
      if (parent === parse(parent).root) break
    }
  }
  const inspect = (path: string, kind: string, identity: ObjectValue = {}, optional = false): DiagnosticRecord | undefined => {
    let r: DiagnosticRecord | undefined
    try {
      assertParents(path)
      const meta = lstatSync(path)
      r = record(path, kind, { ...identity, device: meta.dev, inode: meta.ino })
      r.size = meta.size; r.modifiedAt = meta.mtime.toISOString()
      observed.set(path, { meta, record: r })
      if (meta.isSymbolicLink()) { add(r, 'symbolic-link', '路径是符号链接，未读取链接目标。'); report.complete = false }
      else if (!meta.isFile() && !meta.isDirectory()) { add(r, 'unsupported-file', '路径不是普通文件或目录，未打开。'); report.complete = false }
      return r
    } catch (e) {
      if (code(e) === 'ENOENT' && optional) { absent.add(path); return undefined }
      r ??= record(path, kind, identity)
      if (code(e) === 'CHANGED_PARENT' || (code(e) === 'ENOENT' && observed.has(root))) { changed(r); return r }
      r.observation = 'unreadable'; report.complete = false
      add(r, 'read-error', '路径无法安全读取，不能视为不存在。', { errorCode: code(e) })
      return r
    }
  }
  const file = (r: DiagnosticRecord | undefined, limit = 32_000_000): Buffer | undefined => {
    if (!r || !observed.has(r.path) || r.observation === 'unreadable' || r.findings.some(f => ['symbolic-link', 'unsupported-file'].includes(f.code))) return undefined
    let fd: number | undefined
    try {
      const before = observed.get(r.path)!.meta
      if (!before.isFile()) { add(r, 'unexpected-directory', '此记录应为普通文件，未递归读取。'); report.complete = false; return }
      if (before.size > limit) { add(r, 'size-limit', '文件超过有界诊断读取上限，内容未检查。', { limit }); report.complete = false; return }
      assertParents(r.path)
      fd = openSync(r.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const opened = fstatSync(fd)
      if (!opened.isFile() || stamp(opened) !== stamp(before)) { changed(r); return }
      assertParents(r.path)
      // Read only the observed size: a growing log cannot make the read unbounded.
      const bytes = Buffer.alloc(opened.size)
      let offset = 0
      while (offset < bytes.length) {
        const n = readSync(fd, bytes, offset, bytes.length - offset, offset)
        if (!n) break
        offset += n
      }
      if (offset !== bytes.length || stamp(fstatSync(fd)) !== stamp(opened) || stamp(lstatSync(r.path)) !== stamp(opened)) changed(r)
      return bytes.subarray(0, offset)
    } catch (e) {
      if (['ENOENT', 'ELOOP', 'CHANGED_PARENT'].includes(code(e))) { changed(r); return }
      report.complete = false; r.observation = 'unreadable'
      add(r, 'read-error', '只读打开或读取失败，内容未能完整检查。', { errorCode: code(e) })
    } finally { if (fd !== undefined) closeSync(fd) }
  }
  const json = (r: DiagnosticRecord | undefined): unknown => {
    const bytes = file(r)
    if (!bytes) return undefined
    try { return JSON.parse(bytes.toString('utf8')) }
    catch { add(r!, 'invalid-json', 'JSON 损坏或截断，保留原始字节；可能在写入时需重查。'); return undefined }
  }
  const list = (path: string, kind: string, optional = true): string[] => {
    const r = inspect(path, kind, {}, optional)
    if (!r || r.findings.length) return []
    try {
      if (!observed.get(path)!.meta.isDirectory()) { add(r, 'unexpected-file', '此路径应为目录。'); report.complete = false; return [] }
      assertParents(join(path, '_'))
      return readdirSync(path).sort()
    } catch (e) {
      if (['ENOENT', 'CHANGED_PARENT'].includes(code(e))) changed(r)
      else { report.complete = false; add(r, 'read-error', '目录无法完整枚举。', { errorCode: code(e) }) }
      return []
    }
  }
  const lines = (r: DiagnosticRecord, visit: (row: unknown, line: number, offset: number) => void, limit = 128_000_000) => {
    const bytes = file(r, limit)
    if (!bytes) return
    let line = 0
    for (let start = 0; start < bytes.length;) {
      const newline = bytes.indexOf(10, start), end = newline < 0 ? bytes.length : newline
      const text = bytes.subarray(start, end).toString('utf8'); line++
      if (text.trim()) {
        let row: unknown
        try { row = JSON.parse(text) }
        catch { add(r, newline < 0 ? 'truncated-tail' : 'invalid-jsonl-row', newline < 0 ? '末行未终止且无法解析，可能是截断或正在追加。' : '已终止的中间行无法解析，不应跳过。', { line, byteOffset: start }); start = end + 1; continue }
        visit(row, line, start)
      }
      start = end + 1
    }
  }

  // Root is required; optional missing components are a normal empty store.
  list(root, 'storage-directory', false)
  const rootRecord = report.records[0]
  if (rootRecord.findings.length) return finish()

  const locks: { r: DiagnosticRecord; value: ObjectValue }[] = []
  for (const name of ['host.lock', 'host.lock.recovery']) {
    const r = inspect(join(root, name), 'lock', { lock: name }, true), value = json(r)
    if (!r) continue
    if (name === 'host.lock') report.host.state = 'unknown'
    if (name.endsWith('.recovery')) add(r, 'recovery-gate-present', '恢复门锁存在：可能正在取得 Host 锁，也可能是崩溃遗留。')
    if (!object(value)) {
      if (value !== undefined) add(r, 'invalid-lock', '锁 JSON 不是对象，不能判定所有权。')
      continue
    }
    const validPid = typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= 2147483647
    if (!validPid || typeof value.token !== 'string' || !value.token) { add(r, 'invalid-lock', '锁缺少有效的正 PID 或非空 token，不能判定所有权。'); continue }
    r.identity = { ...r.identity, pid: value.pid, tokenDigest: digest(value.token) }
    let state: 'alive' | 'dead' | 'unknown' = 'alive'
    try { process.kill(value.pid as number, 0) }
    catch (e) { state = code(e) === 'ESRCH' ? 'dead' : 'unknown' }
    r.identity.processState = state
    if (name === 'host.lock') report.host = { pid: value.pid as number, state }
    if (state === 'dead') add(r, 'dead-lock-owner', '锁记录的 PID 已不存在；这只是失效所有者证据，不授权自动删锁。')
    if (state === 'unknown') add(r, 'unknown-lock-owner', '无法确认 PID 存活状态，权限拒绝不能解释为进程已退出。')
    locks.push({ r, value })
  }
  if (locks.length === 2 && locks[0].value.token !== locks[1].value.token) {
    for (const lock of locks) {
      lock.r.references.push({ path: locks.find(l => l !== lock)!.r.path, relation: 'other-lock' })
      add(lock.r, 'lock-token-mismatch', 'Host 锁与恢复门锁 token 不一致；接管中的短暂窗口也会出现，不能单凭此项判断哪一方错误。')
    }
  }

  const libraryRecord = inspect(join(root, 'library.json'), 'library', {}, true), library = json(libraryRecord)
  const workflows = new Map<string, Workflow>()
  let libraryValid = false
  if (library !== undefined) {
    if (!object(library) || library.schema !== 2 || !Array.isArray(library.workflows) || !Array.isArray(library.presets)) add(libraryRecord!, 'invalid-library', 'library 结构或 schema 不符合当前存储合同。')
    else {
      libraryValid = true
      for (const raw of library.workflows) {
        try {
          const flow = parseWorkflow(raw)
          if (workflows.has(flow.id)) throw new Error()
          workflows.set(flow.id, flow)
        } catch { libraryValid = false; add(libraryRecord!, 'invalid-workflow', 'library 含无效或重复身份的工作流，提案比较可能不完整。') }
      }
    }
  }

  const runPaths = new Map<string, string>(), runReferences = new Map<string, Reference[]>()
  const runNames = list(join(root, 'runs'), 'runs-directory')
  const runDirectory = report.records.find(r => r.path === join(root, 'runs'))
  const runListingKnown = !runDirectory || !runDirectory.findings.length
  const validRuns = new Set<string>()
  // Ownership depends on snapshot presence, not successful parsing; never mark a damaged owner orphaned.
  for (const name of runNames.filter(n => n.endsWith('.json'))) runPaths.set(name.slice(0, -5), join(root, 'runs', name))
  const findAttachments = (value: unknown, runId: string, path: string) => {
    if (!value || typeof value !== 'object') return
    const pending = [value]
    while (pending.length) {
      const item = pending.pop()!
      if (object(item) && typeof item.workflowFileId === 'string') {
        const key = `${runId}/${item.workflowFileId}`
        if (!runReferences.has(key)) runReferences.set(key, [{ path, relation: 'workflowFileId', id: item.workflowFileId }])
      }
      for (const child of Object.values(item)) if (child && typeof child === 'object') pending.push(child)
    }
  }
  for (const name of runNames) {
    const path = join(root, 'runs', name)
    if (name.endsWith('.json')) {
      const runId = name.slice(0, -5), r = inspect(path, 'run-snapshot', { runId })!, value = json(r)
      r.references.push({ path: join(root, 'attachments', runId), relation: 'owns-attachments', id: runId })
      if (value !== undefined) {
        try {
          if (!object(value) || !safeId(value.id) || value.id !== runId || !Array.isArray(value.executions) || !object(value.inputs) || !object(value.outputs) || !runStatuses.has(value.status as string) || typeof value.workflowId !== 'string' || typeof value.workspaceId !== 'string' || value.executions.some(e => !object(e) || typeof e.nodeId !== 'string' || !executionStatuses.has(e.status as string))) throw new Error()
          const graph = parseWorkflow(value.graph)
          if (graph.id !== value.workflowId || graph.workspaceId !== value.workspaceId) throw new Error()
          validRuns.add(runId)
          r.identity.workflowId = value.workflowId
          findAttachments(value, runId, path)
          // File input references are JSON strings in real run snapshots.
          for (const raw of Object.values(value.inputs)) if (typeof raw === 'string' && raw.includes('"workflowFileId"')) {
            try { findAttachments(JSON.parse(raw), runId, path) } catch { /* Ordinary free text is not an attachment declaration. */ }
          }
        } catch { add(r, 'invalid-run-snapshot', '运行快照身份、图或执行记录结构无效；附件所有权仍按快照路径保留。') }
      }
    } else if (name.endsWith('.events.jsonl') || name.endsWith('.events.quarantine.jsonl')) {
      const quarantine = name.endsWith('.events.quarantine.jsonl'), runId = name.replace(/\.events(?:\.quarantine)?\.jsonl$/, '')
      const r = inspect(path, quarantine ? 'run-event-quarantine' : 'run-events', { runId })!
      r.references.push({ path: join(root, 'runs', `${runId}.json`), relation: 'run-snapshot', id: runId })
      if (!runPaths.has(runId)) add(r, 'event-without-snapshot', '事件或隔离文件没有对应运行快照。')
      let head = 0
      lines(r, (row, line, byteOffset) => {
        if (!object(row) || row.runId !== runId) { add(r, 'event-identity-mismatch', '事件记录 runId 与文件身份不一致。', { line, byteOffset }); return }
        if (quarantine) {
          const valid = Number.isSafeInteger(row.byteOffset) && (row.byteOffset as number) >= 0 && typeof row.detectedAt === 'string' && Number.isFinite(Date.parse(row.detectedAt)) && typeof row.bytesBase64 === 'string' && row.bytesBase64.length > 0 && row.bytesBase64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(row.bytesBase64) && Buffer.from(row.bytesBase64, 'base64').toString('base64') === row.bytesBase64
          add(r, valid ? 'quarantined-event-tail' : 'invalid-quarantine-record', valid ? 'F25 已保留被截断尾部的原始字节、原偏移与发现时间；不是待删除的普通日志。' : 'F25 截断隔离记录结构无效。', { line, byteOffset, ...(valid ? { originalByteOffset: row.byteOffset, detectedAt: row.detectedAt, preservedBytes: Buffer.byteLength(row.bytesBase64 as string, 'base64') } : {}) })
        } else {
          if (row.seq === undefined) { head++; return } // Supported legacy events reserve one position.
          if (!Number.isSafeInteger(row.seq) || (row.seq as number) <= head || (row.id !== undefined && row.id !== `${runId}:${row.seq}`)) add(r, 'invalid-event-sequence', '事件序号非正整数、倒退／重复，或 id 与序号不一致。', { line, byteOffset })
          if (typeof row.seq === 'number') head = Math.max(head, row.seq)
        }
      })
    } else inspect(path, 'unrecognized-run-file')
  }

  for (const runId of list(join(root, 'attachments'), 'attachments-directory')) {
    const directory = join(root, 'attachments', runId)
    const names = list(directory, 'attachment-run-directory', false)
    const owner = runPaths.get(runId)
    for (const name of names) {
      const fileId = name.replace(/\.json$/, ''), r = inspect(join(directory, name), 'attachment', { runId, fileId })!
      r.references.push({ path: owner ?? join(root, 'runs', `${runId}.json`), relation: owner ? 'owner-snapshot-present' : 'owner-snapshot-absent', id: runId }, ...(runReferences.get(`${runId}/${fileId}`) ?? []))
      if (!owner && runListingKnown) add(r, 'orphan-attachment', '附件所属 runId 没有运行快照引用；历史孤儿候选，需停写后复查。')
      if (!owner && !runListingKnown) add(r, 'attachment-reference-unknown', '运行目录未能完整枚举，不能判断附件是否为孤儿。')
      if (owner && validRuns.has(runId) && !runReferences.has(`${runId}/${fileId}`)) add(r, 'unreferenced-attachment', '所属运行仍存在，但快照中没有此 workflowFileId；仍保留运行所有权，不等同于无主附件。')
      const value = json(r)
      if (value !== undefined && (!object(value) || value.runId !== runId || typeof value.name !== 'string' || typeof value.base64 !== 'string')) add(r, 'invalid-attachment', '附件内容身份或基本结构与所属目录不一致。')
    }
    if (!owner && runListingKnown && !names.length) {
      const r = observed.get(directory)?.record
      if (r && !r.findings.length) add(r, 'orphan-attachment-directory', '空附件目录没有对应运行快照。')
    }
  }

  for (const base of [root, join(root, 'trials')]) {
    const planningDirectory = join(base, 'planning')
    const planningNames = list(planningDirectory, 'planning-directory')
    for (const name of base === root ? ['tasks', 'background'] : ['tasks']) {
      const path = join(planningDirectory, `${name}.json`), journalPath = join(planningDirectory, `${name}.journal`)
      const snapshotRecord = planningNames.includes(`${name}.json`) ? inspect(path, 'planning-snapshot', { store: name }) : undefined
      const snapshot = json(snapshotRecord)
      const ids = new Set<string>()
      if (snapshot !== undefined) {
        if (!object(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.tasks) || snapshot.tasks.length > 100 || Object.keys(snapshot).some(k => !['version', 'tasks', 'journal'].includes(k)) || (snapshot.journal !== undefined && !generation(snapshot.journal))) add(snapshotRecord!, 'invalid-planning-snapshot', '规划快照版本、任务列表、代次或字段不符合合同。')
        else {
          snapshotRecord!.identity.generation = snapshot.journal ?? null
          for (const row of snapshot.tasks) {
            if (!object(row) || typeof row.id !== 'string' || ids.has(row.id)) add(snapshotRecord!, 'invalid-planning-row', '规划快照任务缺少字符串身份或身份重复。')
            else ids.add(row.id)
          }
        }
      }
      if (!planningNames.includes(`${name}.journal`)) continue // A generation's journal starts lazily.
      const r = inspect(journalPath, 'planning-journal', { store: name })!
      r.references.push({ path, relation: 'planning-snapshot' })
      if (!snapshotRecord) add(r, 'journal-without-snapshot', '规划日志没有对应快照，当前读取器不会重放此日志。')
      let headerSeen = false
      lines(r, (row, line, byteOffset) => {
        if (line === 1) {
          headerSeen = true
          if (!object(row) || !generation(row.generation)) { add(r, 'invalid-journal-header', '规划日志缺少有效的代次头。'); return }
          r.identity.generation = row.generation
          if (object(snapshot) && row.generation !== snapshot.journal) add(r, 'planning-generation-mismatch', '日志代次与快照不一致；读取器忽略旧代次，可能是压缩窗口或遗留日志，不能强行合并。', { snapshotGeneration: typeof snapshot.journal === 'string' ? snapshot.journal : null, journalGeneration: row.generation })
        } else if (!object(row) || typeof row.id !== 'string') add(r, 'invalid-planning-row', '规划日志任务缺少字符串身份。', { line, byteOffset })
      })
      if (!headerSeen) add(r, 'invalid-journal-header', '规划日志为空或首行不能作为代次头解析。')
    }
  }

  const editorRecord = inspect(join(root, 'editor-state.json'), 'editor-state', {}, true), editor = json(editorRecord)
  if (editor !== undefined) {
    if (!object(editor) || !Array.isArray(editor.proposals) || !Array.isArray(editor.drafts)) add(editorRecord!, 'invalid-editor-state', 'editor-state 缺少提案或草稿数组。')
    else for (const proposal of editor.proposals) {
      if (!object(proposal)) { add(editorRecord!, 'invalid-proposal', '提案不是对象。'); continue }
      const details = Object.fromEntries(['id', 'workflowId', 'status'].map(key => [key === 'id' ? 'proposalId' : key, typeof proposal[key] === 'string' ? proposal[key].slice(0, 160) : null]))
      editorRecord!.references.push({ path: join(root, 'library.json'), relation: 'proposal-workflow', ...(typeof proposal.workflowId === 'string' ? { id: proposal.workflowId.slice(0, 160) } : {}) })
      try {
        const candidate = parseWorkflow(proposal.candidate)
        if (!safeId(proposal.id) || candidate.id !== proposal.workflowId || !Number.isSafeInteger(proposal.baseRevision) || (proposal.baseRevision as number) < 0 || !['pending', 'accepted', 'rejected'].includes(proposal.status as string)) throw new Error()
        const current = workflows.get(candidate.id)
        if (!libraryValid) { add(editorRecord!, 'proposal-comparison-unavailable', 'library 不可用，提案与定义的一致性待确认。', details); continue }
        if (!current) { add(editorRecord!, 'proposal-workflow-missing', '提案引用的工作流在 library 中不存在。', details); continue }
        const same = workflowDefinitionContent(candidate) === workflowDefinitionContent(current)
        if (proposal.status === 'pending' && same) add(editorRecord!, 'pending-candidate-already-saved', 'pending 候选与 library 定义相同：可能为 F26 接受后状态未落盘，也可能是无改动提案；须核对后从正常接受入口重试。', { ...details, baseRevision: proposal.baseRevision, libraryRevision: current.revision })
        if (proposal.status === 'accepted' && (current.revision < candidate.revision || (current.revision === candidate.revision && !same))) add(editorRecord!, 'accepted-proposal-mismatch', 'accepted 提案候选与 library 的同版本定义不一致，或 library 版本落后；更高版本的后续编辑不据此报错。', { ...details, candidateRevision: candidate.revision, libraryRevision: current.revision })
      } catch { add(editorRecord!, 'invalid-proposal', '提案身份、状态、基础版本或候选图无效。', details) }
    }
  }

  return finish()

  function finish(): StorageDiagnosticReport {
    for (const [path, { meta, record: r }] of observed) {
      try { assertParents(path); if (stamp(lstatSync(path)) !== stamp(meta)) changed(r) }
      catch { changed(r) }
    }
    for (const path of absent) {
      try { assertParents(path); lstatSync(path); changed(record(path, 'appeared-during-scan')) }
      catch (e) {
        if (code(e) === 'CHANGED_PARENT') changed(record(path, 'changed-parent-during-scan'))
        else if (code(e) !== 'ENOENT') { report.complete = false; add(record(path, 'unreadable-path'), 'read-error', '复核缺失路径失败。', { errorCode: code(e) }) }
      }
    }
    if (report.host.state === 'alive' || report.consistency === 'possibly-writing') {
      report.consistency = 'possibly-writing'
      for (const r of report.records) if (r.findings.length && r.observation !== 'unreadable') r.observation = 'possibly-writing'
    }
    for (const r of report.records) for (const f of r.findings) report.summary.byCode[f.code] = (report.summary.byCode[f.code] ?? 0) + 1
    report.summary.records = report.records.length
    report.summary.findings = Object.values(report.summary.byCode).reduce((sum, n) => sum + n, 0)
    return report
  }
}
