import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parsePlanningTrialSpec, TRIAL_LIMITS } from '../src/shared/planning-trial.ts'
import { captureTrialFiles, planningTrialSpecDigest, validateTrialVerificationReport, verifyTrialArtifacts } from '../src/host/planning/trial-verification.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'planning-trial-')); roots.push(root)
  const spec = parsePlanningTrialSpec({ task: 'Read the input and create a greeting.', tools: ['read', 'write'], inputs: ['input.json'], artifacts: [{ path: 'output.json', format: 'json', requireChanged: true, checks: [{ kind: 'json-equals', pointer: '/text', value: '你好，Ada！' }] }], reviewItems: [], ...overrides })
  await writeFile(join(root, 'input.json'), JSON.stringify({ name: 'Ada' }))
  const capture = (authorize = () => {}) => captureTrialFiles({ workspaceRoot: root, spec, authorize })
  return { root, spec, capture }
}
describe('trial verification', () => {
  it('checks a new artifact and unchanged inputs without retaining file bodies', async () => {
    const f = await setup(), before = await f.capture()
    await writeFile(join(f.root, 'output.json'), JSON.stringify({ text: '你好，Ada！', confidentialBusinessData: 'never-return-the-file-body' }))
    const report = verifyTrialArtifacts({ spec: f.spec, before, after: await f.capture() })
    expect(report.verdict).toBe('passed'); expect(report.artifacts[0]?.changed).toBe(true)
    expect(JSON.stringify(report)).not.toContain('never-return-the-file-body')
    expect(JSON.stringify(report)).not.toContain('你好，Ada！')
    expect(validateTrialVerificationReport(JSON.parse(JSON.stringify(report)))).toEqual(report)
    expect(() => validateTrialVerificationReport({ ...report, verdict: 'failed' })).toThrow('摘要')
  })
  it('rejects changed inputs and failed artifact conditions', async () => {
    const f = await setup(), before = await f.capture()
    await writeFile(join(f.root, 'input.json'), '{"name":"Grace"}')
    await writeFile(join(f.root, 'output.json'), '{"text":"wrong"}')
    const report = verifyTrialArtifacts({ spec: f.spec, before, after: await f.capture() })
    expect(report.verdict).toBe('failed'); expect(report.inputs[0]?.status).toBe('failed'); expect(report.artifacts[0]?.checks[0]?.status).toBe('failed')
  })
  it('keeps required-change and existing-file semantics explicit', async () => {
    const f = await setup()
    await writeFile(join(f.root, 'output.json'), '{"text":"你好，Ada！"}')
    const before = await f.capture()
    await writeFile(join(f.root, 'output.json'), '{"text":"你好，Ada！"}')
    expect(verifyTrialArtifacts({ spec: f.spec, before, after: await f.capture() }).verdict).toBe('failed')
    const spec = parsePlanningTrialSpec({ ...f.spec, artifacts: f.spec.artifacts.map(a => ({ ...a, requireChanged: false })) })
    const capture = () => captureTrialFiles({ workspaceRoot: f.root, spec, authorize() {} })
    const report = verifyTrialArtifacts({ spec, before: await capture(), after: await capture() })
    expect(report.verdict).toBe('passed'); expect(report.artifacts[0]).toMatchObject({ changed: false, reason: expect.stringContaining('既有文件') })
  })
  it('requires review when frozen qualitative requirements remain', async () => {
    const f = await setup({ reviewItems: ['语气是否合适由用户确认'] }), before = await f.capture()
    await writeFile(join(f.root, 'output.json'), '{"text":"你好，Ada！"}')
    expect(verifyTrialArtifacts({ spec: f.spec, before, after: await f.capture() }).verdict).toBe('needs-review')
  })
  it.each(['../outside.json', '/tmp/output.json', 'x\\output.json', 'a//b.json', '.env', 'a/.env.local', '.ssh/id_rsa', '.git/config', '.dsh/state.json', '.codex/history.json', '.aws/credentials', 'credentials.json', 'private.key'])('rejects unsafe or sensitive path %s before file access', path => {
    expect(() => parsePlanningTrialSpec({ task: 'task', tools: ['write'], artifacts: [{ path, format: 'json', checks: [{ kind: 'json-type', pointer: '', value: 'object' }] }] })).toThrow()
  })
  it('freezes only existence when no check is stated (T31: the user wrote none)', async () => {
    const f = await setup(), spec = parsePlanningTrialSpec({ ...f.spec, inputs: [], artifacts: [{ path: 'output.json', format: 'json', checks: [] }] })
    const capture = () => captureTrialFiles({ workspaceRoot: f.root, spec, authorize() {} }), before = await capture()
    expect(verifyTrialArtifacts({ spec, before, after: await capture() }).artifacts[0]).toMatchObject({ status: 'failed', reason: '执行后产物不存在' })
    await writeFile(join(f.root, 'output.json'), '{}')
    const report = verifyTrialArtifacts({ spec, before, after: await capture() })
    expect(report).toMatchObject({ verdict: 'passed', artifacts: [{ status: 'passed', checks: [] }] })
    // Desktop r54 A: the stored report must survive its own consistency check.
    expect(validateTrialVerificationReport(report)).toEqual(report)
  })
  it('rejects overlapping paths, executable predicates and prototype pointers', () => {
    const base = { task: 'task', tools: ['write'], artifacts: [{ path: 'out.json', format: 'json', checks: [{ kind: 'json-type', pointer: '', value: 'object' }] }] }
    expect(() => parsePlanningTrialSpec({ ...base, inputs: ['out.json'] })).toThrow('重复')
    expect(() => parsePlanningTrialSpec({ ...base, artifacts: [{ ...base.artifacts[0], checks: [{ kind: 'exec', value: 'return true' }] }] })).toThrow()
    expect(() => parsePlanningTrialSpec({ ...base, artifacts: [{ ...base.artifacts[0], checks: [{ kind: 'json-type', pointer: '/__proto__', value: 'object' }] }] })).toThrow()
  })
  it('rejects symlink leaves and symlink directories even inside the workspace', async () => {
    const f = await setup(), before = await f.capture()
    await writeFile(join(f.root, 'real.json'), '{"text":"你好，Ada！"}')
    await symlink(join(f.root, 'real.json'), join(f.root, 'output.json'))
    const after = await f.capture()
    expect(after.files['output.json']?.status).toBe('unverified')
    expect(verifyTrialArtifacts({ spec: f.spec, before, after }).verdict).toBe('needs-review')
    await mkdir(join(f.root, 'real')); await writeFile(join(f.root, 'real/result.json'), '{}'); await symlink(join(f.root, 'real'), join(f.root, 'link'))
    const spec = parsePlanningTrialSpec({ ...f.spec, artifacts: [{ path: 'link/result.json', format: 'json', checks: [{ kind: 'json-type', pointer: '', value: 'object' }] }] })
    expect((await captureTrialFiles({ workspaceRoot: f.root, spec, authorize() {} })).files['link/result.json']?.status).toBe('unverified')
  })
  it('rejects nonregular and oversized files without returning their content', async () => {
    const f = await setup(); await mkdir(join(f.root, 'output.json'))
    expect((await f.capture()).files['output.json']?.status).toBe('unverified')
    await rm(join(f.root, 'output.json'), { recursive: true }); await writeFile(join(f.root, 'output.json'), Buffer.alloc(TRIAL_LIMITS.fileBytes + 1, 65))
    expect((await f.capture()).files['output.json']?.status).toBe('unverified')
  })
  it('propagates cancellation and permission revocation rather than certifying a partial read', async () => {
    const f = await setup(); let calls = 0
    await expect(f.capture(() => { if (++calls > 2) throw new Error('revoked') })).rejects.toThrow('revoked')
    calls = 0
    await expect(f.capture(() => { if (++calls === 3) throw new Error('one-shot denial') })).rejects.toThrow('one-shot denial')
    const controller = new AbortController(); controller.abort(new Error('cancelled'))
    await expect(captureTrialFiles({ workspaceRoot: f.root, spec: f.spec, signal: controller.signal, authorize() {} })).rejects.toThrow('cancelled')
  })
  it('binds verification to the frozen spec, paths and workspace', async () => {
    const f = await setup(), before = await f.capture()
    expect(() => verifyTrialArtifacts({ spec: { ...f.spec, task: 'changed task' }, before, after: before })).toThrow('规范')
    expect(() => verifyTrialArtifacts({ spec: f.spec, before, after: { ...before, workspaceRootDigest: 'f'.repeat(64) } })).toThrow('工作区')
    expect(() => verifyTrialArtifacts({ spec: f.spec, before, after: { ...before, files: {} } })).toThrow('路径集合')
    expect(planningTrialSpecDigest({ ...f.spec })).toBe(planningTrialSpecDigest(JSON.parse(JSON.stringify(f.spec))))
  })
  it('uses exact JSON pointers, structural equality, types and array/Unicode lengths', async () => {
    const f = await setup({ artifacts: [{ path: 'output.json', format: 'json', checks: [
      { kind: 'json-equals', pointer: '/a~1b/~0name', value: { b: 2, a: 1 } },
      { kind: 'json-type', pointer: '/list', value: 'array' }, { kind: 'json-length', pointer: '/list', value: 2 },
      { kind: 'json-length', pointer: '/emoji', value: 1 }, { kind: 'json-type', pointer: '/nullable', value: 'null' },
    ] }] }), before = await f.capture()
    await writeFile(join(f.root, 'output.json'), JSON.stringify({ 'a/b': { '~name': { a: 1, b: 2 } }, list: [1, 2], emoji: '😀', nullable: null }))
    expect(verifyTrialArtifacts({ spec: f.spec, before, after: await f.capture() }).verdict).toBe('passed')
  })
  it('checks text and rejects malformed JSON without echoing it', async () => {
    const f = await setup({ artifacts: [{ path: 'output.json', format: 'text', checks: [{ kind: 'text-includes', value: 'Report' }] }] }), before = await f.capture()
    await writeFile(join(f.root, 'output.json'), 'Report: private-value')
    const report = verifyTrialArtifacts({ spec: f.spec, before, after: await f.capture() })
    expect(report.verdict).toBe('passed'); expect(JSON.stringify(report)).not.toContain('private-value')
    const g = await setup(), initial = await g.capture(); await writeFile(join(g.root, 'output.json'), '{private-value')
    const invalid = verifyTrialArtifacts({ spec: g.spec, before: initial, after: await g.capture() })
    expect(invalid.verdict).toBe('failed'); expect(JSON.stringify(invalid)).not.toContain('private-value')
  })
})
