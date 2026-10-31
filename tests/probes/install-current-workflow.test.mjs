import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rename, rm, symlink, link, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { assertCanonicalDirectory, fingerprint, rollbackInstallation, unpackVerifiedArchive, writeRecord } from './install-current-workflow.mjs'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workflow-install-review-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = join(root, 'plugin'), backup = join(root, `.workflow-backup-${randomUUID()}`), source = join(root, 'candidate'), recordPath = join(root, 'record.json')
  await mkdir(target); await mkdir(source)
  await writeFile(join(target, 'entry.js'), 'old bundle')
  await writeFile(join(source, 'entry.js'), 'new bundle')
  const record = { target, backup, beforeSha256: await fingerprint(target), installedSha256: await fingerprint(source), state: 'prepared' }
  const options = { target, recordPath, requireStopped() {} }
  return { root, target, backup, source, recordPath, record, options }
}

for (const point of ['before-first-rename', 'between-renames', 'after-second-rename']) test(`prepared recovery: ${point}`, async t => {
  const f = await fixture(t)
  if (point !== 'before-first-rename') await rename(f.target, f.backup)
  if (point === 'after-second-rename') await rename(f.source, f.target)
  await writeRecord(f.recordPath, f.record)
  const result = await rollbackInstallation(f.options)
  assert.equal(result.state, 'rolled-back')
  assert.equal(await fingerprint(f.target), f.record.beforeSha256)
  if (point === 'after-second-rename') assert.equal(await fingerprint(result.retired), f.record.installedSha256)
  assert.equal((await rollbackInstallation(f.options)).alreadyRolledBack, true)
})

test('installed recovery retains the retired candidate', async t => {
  const f = await fixture(t)
  await rename(f.target, f.backup); await rename(f.source, f.target)
  await writeRecord(f.recordPath, { ...f.record, state: 'installed' })
  const result = await rollbackInstallation(f.options)
  assert.equal(await readFile(join(f.target, 'entry.js'), 'utf8'), 'old bundle')
  assert.equal(await readFile(join(result.retired, 'entry.js'), 'utf8'), 'new bundle')
})

test('rollback interruption after retiring candidate is recoverable', async t => {
  const f = await fixture(t), retired = join(f.root, `.workflow-retired-${randomUUID()}`)
  await rename(f.target, f.backup); await rename(f.source, retired)
  await writeRecord(f.recordPath, { ...f.record, state: 'rollback-prepared', retired })
  const result = await rollbackInstallation(f.options)
  assert.equal(await fingerprint(f.target), f.record.beforeSha256)
  assert.equal(await fingerprint(result.retired), f.record.installedSha256)
})

for (const which of ['target', 'backup']) test(`recovery rejects a ${which} root symlink before any rename`, async t => {
  const f = await fixture(t)
  await rename(f.target, f.backup); await rename(f.source, f.target)
  const external = join(f.root, 'unrelated')
  await rename(f[which], external); await symlink(external, f[which])
  await writeRecord(f.recordPath, { ...f.record, state: 'installed' })
  await assert.rejects(rollbackInstallation(f.options), /Unexpected directory location/)
  assert.equal((await lstat(f[which])).isSymbolicLink(), true)
  assert.equal(await readFile(join(external, 'entry.js'), 'utf8'), which === 'target' ? 'new bundle' : 'old bundle')
})

test('canonical parent is required even when the target leaf is an ordinary directory', async t => {
  const f = await fixture(t), alias = join(f.root, 'alias')
  await symlink(f.root, alias)
  await assert.rejects(assertCanonicalDirectory(join(alias, 'plugin')), /Unexpected directory location/)
  await assert.rejects(rollbackInstallation({ ...f.options, target: join(alias, 'plugin') }), /Unexpected directory location/)
})

test('an arbitrary sibling name containing the backup prefix is rejected', async t => {
  const f = await fixture(t), backup = join(f.root, 'unrelated.workflow-backup-copy')
  await rename(f.target, backup); await rename(f.source, f.target)
  await writeRecord(f.recordPath, { ...f.record, backup, state: 'installed' })
  await assert.rejects(rollbackInstallation(f.options), /Invalid installation record/)
  assert.equal(await readFile(join(f.target, 'entry.js'), 'utf8'), 'new bundle')
})

for (const which of ['target', 'backup']) test(`recovery preserves later changes in ${which}`, async t => {
  const f = await fixture(t)
  await rename(f.target, f.backup); await rename(f.source, f.target)
  await writeRecord(f.recordPath, { ...f.record, state: 'installed' })
  await writeFile(join(f[which], 'entry.js'), 'later user edit')
  await assert.rejects(rollbackInstallation(f.options), /preserve/)
  assert.equal(await readFile(join(f[which], 'entry.js'), 'utf8'), 'later user edit')
  assert.equal((JSON.parse(await readFile(f.recordPath, 'utf8'))).state, 'installed')
})

test('record updates reject symbolic links rather than overwriting their destination', async t => {
  const f = await fixture(t), victim = join(f.root, 'keep.json')
  await writeFile(victim, 'keep'); await symlink(victim, f.recordPath)
  await assert.rejects(writeRecord(f.recordPath, f.record))
  assert.equal(await readFile(victim, 'utf8'), 'keep')
})

test('package fingerprints reject multiply linked files', async t => {
  const f = await fixture(t)
  await link(join(f.target, 'entry.js'), join(f.root, 'external-alias.js'))
  await assert.rejects(fingerprint(f.target), /linked or special/)
})

test('recovery leaves trees untouched when Desktop is not stopped', async t => {
  const f = await fixture(t)
  await writeRecord(f.recordPath, f.record)
  await assert.rejects(rollbackInstallation({ ...f.options, requireStopped() { throw Error('DESKTOP_STOP_REQUIRED') } }), /DESKTOP_STOP_REQUIRED/)
  assert.equal(await fingerprint(f.target), f.record.beforeSha256)
})

test('extraction consumes the verified bytes after archive pathname replacement', async t => {
  const f = await fixture(t), archive = join(f.root, 'package.tgz'), stage = join(f.root, 'stage')
  await mkdir(stage)
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', f.root, 'candidate'])
  const verified = await readFile(archive)
  await writeFile(archive, 'changed after verification')
  unpackVerifiedArchive(verified, stage)
  assert.equal(await readFile(join(stage, 'candidate/entry.js'), 'utf8'), 'new bundle')
})
