// Real installed Harness Electron/Node, actual pinned Graphon archive, synthetic
// private cache only. No profile activation, no model calls, no real credentials.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WorkflowRuntime } from '../../src/host/runtime.ts'
import { WorkflowStorage } from '../../src/host/storage.ts'
import { makeWorkflow } from '../../src/shared/types.ts'

assert(process.versions.electron, 'Run with the actual installed Harness executable')
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-graphon-integrity-')))
process.env.DSH_WORKFLOW_RUNTIME_DIRECTORY = path.join(fixture, 'engine')
const evidence = path.resolve('.cache/graphon-strict-integrity'), results = [], ownedPids = new Set()
let runtime, modelRequests = 0, residualCount = 0, runtimeDirectory, archiveFileCount, residualInspection = true
const hardDeadline = setTimeout(() => { void runtime?.close().finally(() => process.exit(124)) }, 75_000)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const check = async (name, task) => {
  try { await task(); results.push({ name, pass: true }) }
  catch (error) { results.push({ name, pass: false, diagnostic: String(error?.message ?? error).slice(0, 400) }) }
}
const rememberChild = () => { const child = runtime.graphon.child; if (child?.pid) ownedPids.add(child.pid); return child }
try {
  const storage = new WorkflowStorage(path.join(fixture, 'workflow'))
  runtime = new WorkflowRuntime(storage, { generate: async () => { modelRequests++; throw Error('MODEL_REQUEST_FORBIDDEN') } }, undefined, undefined, { verifyRuntimeContents: true })
  const graph = storage.save(makeWorkflow('synthetic-workspace', 'Strict Graphon integrity', true), 0)
  await check('real_archive_and_strict_workflow_execute_successfully', async () => {
    const result = await runtime.settle(runtime.start(graph.id, { text: 'synthetic public input' }).id)
    assert.equal(result.status, 'success'); assert.equal(result.outputs.result, '处理结果\n\nsynthetic public input')
    const child = rememberChild(); assert(child)
    runtimeDirectory = child.spawnargs[0].replace(/\/python\/bin\/python3\.12$/, '')
    assert(runtimeDirectory.startsWith(fixture))
    const stopped = once(child, 'close'); child.kill('SIGTERM'); await stopped
    assert.equal(runtime.graphon.child, undefined)
  })
  if (!runtimeDirectory) throw Error('Successful baseline required before mutation probes')
  const modulePath = path.join(runtimeDirectory, 'python/lib/python3.12/site-packages/graphon/graph_engine/graph_engine.py')
  const original = await readFile(modulePath); assert(original.length > 0)
  await check('next_child_rejects_existing_python_content_tampering', async () => {
    await writeFile(modulePath, Buffer.alloc(original.length, 88))
    const result = await runtime.settle(runtime.start(graph.id, { text: 'never executed' }).id)
    assert.equal(result.status, 'failed'); assert.match(JSON.stringify(result), /文件内容不符/)
    assert.equal(runtime.graphon.child, undefined)
  })
  await writeFile(modulePath, original)
  await check('next_child_rejects_additional_pth_before_python_start', async () => {
    const sentinel = path.join(fixture, 'pth-executed')
    await writeFile(path.join(runtimeDirectory, 'python/lib/python3.12/site-packages/extra.pth'), `import pathlib; pathlib.Path(${JSON.stringify(sentinel)}).write_text('synthetic')\n`, { mode: 0o600 })
    const result = await runtime.settle(runtime.start(graph.id, { text: 'never executed' }).id)
    assert.equal(result.status, 'failed'); assert.match(JSON.stringify(result), /额外文件/)
    assert.equal(runtime.graphon.child, undefined)
    await assert.rejects(readFile(sentinel), { code: 'ENOENT' })
  })
} finally {
  await runtime?.close()
  // Observe only synthetic children known to this probe. Manual cleanup is not
  // counted as runtime lifecycle proof; close() must have reaped them already.
  for (const pid of ownedPids) {
    try { if (execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid='], { encoding: 'utf8' }).trim()) residualCount++ } catch (error) { if (error.status !== 1) residualInspection = false }
  }
  await rm(fixture, { recursive: true, force: true }); clearTimeout(hardDeadline)
  const manifestPath = path.resolve('runtime-assets/macos-arm64.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  archiveFileCount = manifest.fileCount
  const sourceHashes = Object.fromEntries(await Promise.all(['src/host/graphon-environment.ts', 'src/host/graphon.ts', 'src/host/runtime.ts', 'tests/fixtures/harness-graphon-integrity-probe.mjs'].map(async name => [name, sha(await readFile(name))])))
  const report = { installedHarness: process.execPath, node: process.versions.node, electron: process.versions.electron, archiveSha256: manifest.sha256, archiveFileCount, sourceHashes, results, modelRequests, observedChildCount: ownedPids.size, residualCount, residualInspection, fixtureRemoved: true, productionActivated: false }
  await mkdir(evidence, { recursive: true }); await writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ results, modelRequests, observedChildCount: ownedPids.size, residualCount, residualInspection, fixtureRemoved: true }))
}
if (results.length !== 3 || results.some(result => !result.pass) || modelRequests || residualCount || !residualInspection) process.exitCode = 1
