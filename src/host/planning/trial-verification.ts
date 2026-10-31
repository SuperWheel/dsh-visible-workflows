import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  TRIAL_LIMITS, parsePlanningTrialSpec, trialFileSnapshotSchema, trialVerificationReportSchema,
  type PlanningTrialSpec, type TrialCheckResult, type TrialFileFingerprint, type TrialFileSnapshot, type TrialVerificationReport,
} from '../../shared/planning-trial.ts'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export const planningTrialSpecDigest = (spec: PlanningTrialSpec): string => hash(canonical(parsePlanningTrialSpec(spec)))
const reportDigest = (report: Omit<TrialVerificationReport, 'digest'>): string => hash(canonical(report))
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
const inside = (root: string, target: string) => { const path = relative(root, target); return !!path && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`) }
async function noLinks(root: string, path: string): Promise<Stats | undefined> {
  const parts = path.split('/'); let target = root
  for (let i = 0; i < parts.length; i++) {
    target = resolve(target, parts[i]!); let stat: Stats
    try { stat = await lstat(target) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (stat.isSymbolicLink()) throw new Error('文件路径含符号链接')
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error('文件父级不是目录')
    if (i === parts.length - 1) return stat
  }
}
function selectedJson(value: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (!pointer) return { found: true, value }
  for (const token of pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!value || typeof value !== 'object' || (Array.isArray(value) && !/^(?:0|[1-9]\d*)$/.test(token)) || !Object.hasOwn(value, token)) return { found: false }
    value = (value as Record<string, unknown>)[token]
  }
  return { found: true, value }
}
function evaluateChecks(artifact: PlanningTrialSpec['artifacts'][number], bytes: Uint8Array): TrialCheckResult[] {
  let text: string, json: unknown
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return artifact.checks.map((check, index) => ({ index, kind: check.kind, status: 'failed', reason: '产物不是有效 UTF-8 文本' })) }
  if (artifact.format === 'json') {
    try { json = JSON.parse(text) } catch { return artifact.checks.map((check, index) => ({ index, kind: check.kind, status: 'failed', reason: '产物不是有效 JSON' })) }
  }
  return artifact.checks.map((check, index): TrialCheckResult => {
    try {
      if (check.kind === 'text-includes') return { index, kind: check.kind, status: text.includes(check.value) ? 'passed' : 'failed', reason: '按冻结的文本包含条件检查；未返回文件正文' }
      const selected = selectedJson(json, check.pointer)
      if (!selected.found) return { index, kind: check.kind, status: 'failed', reason: '指定 JSON Pointer 不存在' }
      const value = selected.value
      let passed: boolean
      if (check.kind === 'json-type') passed = (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value) === check.value
      else if (check.kind === 'json-length') passed = (Array.isArray(value) ? value.length : typeof value === 'string' ? Array.from(value).length : -1) === check.value
      else passed = canonical(value) === canonical(check.value)
      return { index, kind: check.kind, status: passed ? 'passed' : 'failed', reason: check.kind === 'json-length' ? '检查数组元素或字符串 Unicode 码点数量' : '按冻结的 JSON 条件检查；未返回字段值' }
    } catch { return { index, kind: check.kind, status: 'unverified', reason: 'JSON 结构超出安全比较能力，需人工复核' } }
  })
}

/** Host-only, bounded file capture. No plaintext is returned or persisted. */
export async function captureTrialFiles(options: { workspaceRoot: string; spec: PlanningTrialSpec; signal?: AbortSignal; authorize: () => void }): Promise<TrialFileSnapshot> {
  const { signal } = options, spec = parsePlanningTrialSpec(options.spec)
  let authorizationFailed = false
  const authorize = () => { try { options.authorize() } catch (error) { authorizationFailed = true; throw error } }
  signal?.throwIfAborted(); authorize()
  const root = await realpath(options.workspaceRoot), files: Record<string, TrialFileFingerprint> = Object.create(null)
  const artifacts = new Map(spec.artifacts.map(item => [item.path, item])); let consumed = 0
  for (const path of [...spec.inputs, ...artifacts.keys()]) {
    signal?.throwIfAborted(); authorize(); let handle: FileHandle | undefined
    try {
      const before = await noLinks(root, path)
      if (!before) { files[path] = { path, status: 'missing', reason: '文件不存在' }; continue }
      if (!before.isFile()) throw new Error('验收目标不是普通文件')
      if (before.size > TRIAL_LIMITS.fileBytes || consumed + before.size > TRIAL_LIMITS.totalBytes) throw new Error('试做文件超过单文件 4 MiB 或合计 16 MiB 上限')
      const target = resolve(root, path), actual = await realpath(target)
      if (!inside(root, actual) || actual !== target) throw new Error('文件不在已确认的工作区路径内')
      handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      const opened = await handle.stat(), checked = await noLinks(root, path)
      if (!opened.isFile() || !checked || !sameFile(before, opened) || !sameFile(opened, checked)) throw new Error('文件在校验和读取之间发生变化')
      const bytes = Buffer.alloc(opened.size); let offset = 0
      while (offset < bytes.length) {
        signal?.throwIfAborted(); authorize()
        const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset)
        if (!bytesRead) throw new Error('文件在读取时长度变化')
        offset += bytesRead
      }
      consumed += offset
      const final = await handle.stat(), latest = await noLinks(root, path), finalPath = await realpath(target)
      if (!latest || !sameFile(opened, final) || !sameFile(final, latest) || finalPath !== target) throw new Error('文件在读取过程中发生变化')
      signal?.throwIfAborted(); authorize()
      const artifact = artifacts.get(path)
      files[path] = { path, status: 'present', sha256: hash(bytes), size: bytes.length, ...(artifact ? { checks: evaluateChecks(artifact, bytes) } : {}) }
    } catch (error) {
      if (authorizationFailed) throw error
      signal?.throwIfAborted(); authorize()
      const reason = error instanceof Error && !('code' in error) ? error.message : '文件读取失败，未保留底层路径或内容'
      files[path] = { path, status: 'unverified', reason: reason.slice(0, 1000) }
    } finally { await handle?.close(); signal?.throwIfAborted(); authorize() }
  }
  return trialFileSnapshotSchema.parse({ version: 1, specDigest: planningTrialSpecDigest(spec), workspaceRootDigest: hash(root), files })
}

/** Deterministic checks establish only the frozen acceptance conditions. */
export function verifyTrialArtifacts(options: { spec: PlanningTrialSpec; before: TrialFileSnapshot; after: TrialFileSnapshot }): TrialVerificationReport {
  const spec = parsePlanningTrialSpec(options.spec), before = trialFileSnapshotSchema.parse(options.before), after = trialFileSnapshotSchema.parse(options.after), specDigest = planningTrialSpecDigest(spec)
  if (before.specDigest !== specDigest || after.specDigest !== specDigest || before.workspaceRootDigest !== after.workspaceRootDigest) throw new Error('试做规范或工作区与冻结快照不一致')
  const paths = [...spec.inputs, ...spec.artifacts.map(item => item.path)].sort()
  for (const snapshot of [before, after]) if (canonical(Object.keys(snapshot.files).sort()) !== canonical(paths) || Object.entries(snapshot.files).some(([path, file]) => file.path !== path)) throw new Error('试做文件快照与冻结路径集合不一致')
  const inputs: TrialVerificationReport['inputs'] = spec.inputs.map(path => {
    const a = before.files[path]!, b = after.files[path]!
    if (a.status === 'unverified' || b.status === 'unverified') return { path, status: 'unverified', reason: '输入前后指纹不可验证' }
    if (a.status !== 'present' || b.status !== 'present') return { path, status: 'failed', reason: '冻结输入缺失或被删除' }
    return { path, status: a.sha256 === b.sha256 ? 'passed' : 'failed', reason: a.sha256 === b.sha256 ? '输入内容保持不变；不证明模型已读取或理解' : '试做修改了冻结的只读输入' }
  })
  const artifacts: TrialVerificationReport['artifacts'] = spec.artifacts.map(artifact => {
    const a = before.files[artifact.path]!, b = after.files[artifact.path]!, checks = b.checks ?? []
    if (a.status === 'unverified' || b.status === 'unverified') return { path: artifact.path, status: 'unverified', checks, reason: '产物前后文件状态不可验证' }
    if (b.status !== 'present') return { path: artifact.path, status: 'failed', checks, reason: '执行后产物不存在' }
    const changed = a.status === 'missing' || a.sha256 !== b.sha256
    if (checks.length !== artifact.checks.length || checks.some((check, index) => check.index !== index || check.kind !== artifact.checks[index]!.kind)) return { path: artifact.path, status: 'unverified', changed, checks, reason: '缺少与冻结规范对应的检查结果' }
    const status = (artifact.requireChanged && !changed) || checks.some(check => check.status === 'failed') ? 'failed' : checks.some(check => check.status === 'unverified') ? 'unverified' : 'passed'
    return { path: artifact.path, status, changed, checks, reason: artifact.requireChanged && !changed ? '要求内容改变，但仅重写或时间戳变化不满足条件' : changed ? '产物内容已改变或从缺失变为存在' : '既有文件满足检查；不声称由本次试做生成' }
  })
  const results = [...inputs, ...artifacts]
  const verdict = results.some(item => item.status === 'failed') ? 'failed' : results.some(item => item.status === 'unverified') || spec.reviewItems.length ? 'needs-review' : 'passed'
  const report: Omit<TrialVerificationReport, 'digest'> = { version: 1, specDigest, verdict, inputs, artifacts, before, after, reviewItems: spec.reviewItems, limitations: ['只验证事先冻结的文件条件；工具或模型自述不证明业务成功。', '文件内容变化不证明由哪个进程写入，也不证明输入已被模型读取或理解。'] }
  return trialVerificationReportSchema.parse({ ...report, digest: reportDigest(report) })
}

export function validateTrialVerificationReport(value: unknown): TrialVerificationReport {
  const report = trialVerificationReportSchema.parse(value), { digest, ...unsigned } = report
  if (digest !== reportDigest(unsigned) || report.before.specDigest !== report.specDigest || report.after.specDigest !== report.specDigest || report.before.workspaceRootDigest !== report.after.workspaceRootDigest) throw new Error('试做文件验收摘要不匹配')
  const results = [...report.inputs, ...report.artifacts]
  const expected = results.some(item => item.status === 'failed') ? 'failed' : results.some(item => item.status === 'unverified') || report.reviewItems.length ? 'needs-review' : 'passed'
  // An artifact frozen with no stated check passes on existence alone (T31); Desktop r54 A failed here.
  if (!report.artifacts.length || report.verdict !== expected || report.artifacts.some(item => item.status === 'passed' && (report.after.files[item.path]?.status !== 'present' || item.checks.some(check => check.status !== 'passed')))) throw new Error('试做验收状态与逐项检查不一致')
  return report
}
