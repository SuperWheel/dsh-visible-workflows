// Local, reviewable package replacement. Default is read-only review. The real
// Desktop must be closed; this script never quits it or edits profile settings.
// Path/metadata checks detect changed inputs; they are not an OS boundary against
// concurrent hostile mutation of writable parent directories.
import { readFile, mkdir, lstat, realpath, rename, rm, readdir, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

export function currentWorkflowPackageFiles(packed) {
  const selected = [
    'lib/index.js', 'lib/client.js', 'lib/typert.host.js', 'lib/typert.remote-client.js',
    'native/os-secret-broker/dist/integrity.json',
    'native/os-secret-broker/dist/Workflow OS Secret Broker.app/Contents/MacOS/WorkflowOSSecretBroker',
  ]
  if (!Array.isArray(packed?.files) || selected.some(path => !packed.files.some(row => row?.path === path))) throw Error('Incomplete package: current workflow and OS credential components required')
  return selected
}

export async function assertCanonicalDirectory(path) {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== resolve(path)) throw Error('Unexpected directory location')
}

export async function readRegularFile(path, maximumBytes = 256 * 1024 * 1024) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1) throw Error('Unexpected linked or special file')
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maximumBytes) throw Error('File exceeds bounded read')
    const buffer = Buffer.alloc(before.size + 1)
    let count = 0
    while (count < buffer.length) { const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count); if (!bytesRead) break; count += bytesRead }
    const bytes = buffer.subarray(0, count), after = await handle.stat(), current = await lstat(path)
    if (count !== before.size || current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error('File changed while reading')
    return bytes
  } finally { await handle.close() }
}

export async function fingerprint(root) {
  await assertCanonicalDirectory(root)
  const rows = []
  async function walk(path, rel = '') {
    await assertCanonicalDirectory(path)
    for (const name of (await readdir(path)).sort()) {
      const p = join(path, name), r = rel ? `${rel}/${name}` : name, stat = await lstat(p)
      if (stat.isSymbolicLink()) throw Error('Unexpected symbolic link in package')
      if (stat.isDirectory()) await walk(p, r)
      else if (stat.isFile()) rows.push([r, sha(await readRegularFile(p)), stat.mode & 0o777])
      else throw Error('Unexpected special package file')
    }
  }
  await walk(root)
  await assertCanonicalDirectory(root)
  return sha(JSON.stringify(rows))
}

async function exists(path) {
  try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

export async function writeRecord(path, record) {
  await assertCanonicalDirectory(dirname(path))
  if (await exists(path)) await readRegularFile(path)
  const temporary = join(dirname(path), `.workflow-record-${randomUUID()}`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(record, null, 2) + '\n')
    await handle.sync()
  } catch (error) { await rm(temporary, { force: true }); throw error }
  finally { await handle.close() }
  try { await rename(temporary, path) } finally { await rm(temporary, { force: true }) }
}

function siblingPath(path, target, kind) {
  return typeof path === 'string' && dirname(path) === dirname(target) && new RegExp(`^\\.workflow-${kind}-${uuid}$`, 'i').test(basename(path))
}

// Recovery deliberately accepts only exact journal identities and hashes. All
// changed or ambiguous trees remain in place for inspection; no newer work is
// deleted. This also handles interruption between the two installation renames.
export async function rollbackInstallation({ target, recordPath, requireStopped }) {
  requireStopped()
  await assertCanonicalDirectory(dirname(target))
  await assertCanonicalDirectory(dirname(recordPath))
  const record = JSON.parse((await readRegularFile(recordPath)).toString('utf8'))
  if (record.target !== target || !['prepared', 'installed', 'rollback-prepared', 'rolled-back'].includes(record.state) || !siblingPath(record.backup, target, 'backup') || !digest(record.beforeSha256) || !digest(record.installedSha256) || (record.retired !== undefined && !siblingPath(record.retired, target, 'retired'))) throw Error('Invalid installation record')
  const targetHash = await exists(target) ? await fingerprint(target) : null
  const backupHash = await exists(record.backup) ? await fingerprint(record.backup) : null
  if (backupHash !== null && backupHash !== record.beforeSha256) throw Error('Backup changed; preserve existing work')
  if (record.state === 'rolled-back') {
    if (targetHash !== record.beforeSha256 || backupHash !== null) throw Error('Rolled-back package changed; preserve existing work')
    return { ...record, alreadyRolledBack: true }
  }
  // Prepared before the first rename, or restored before the final journal write.
  if (targetHash === record.beforeSha256 && backupHash === null) {
    const result = { ...record, state: 'rolled-back', rolledBackAt: new Date().toISOString() }
    await writeRecord(recordPath, result)
    return result
  }
  if (backupHash === null || (targetHash !== null && targetHash !== record.installedSha256)) throw Error('Installation changed; preserve newer work')
  if (record.retired && await exists(record.retired) && await fingerprint(record.retired) !== record.installedSha256) throw Error('Retired package changed; preserve newer work')
  const retired = record.retired ?? join(dirname(target), `.workflow-retired-${randomUUID()}`)
  if (targetHash !== null && await exists(retired)) throw Error('Retired package already exists')
  requireStopped()
  await assertCanonicalDirectory(dirname(target))
  if ((await exists(target) ? await fingerprint(target) : null) !== targetHash || await fingerprint(record.backup) !== backupHash) throw Error('Recovery inputs changed')
  const pending = { ...record, state: 'rollback-prepared', ...(targetHash !== null || record.retired ? { retired } : {}) }
  await writeRecord(recordPath, pending)
  if (targetHash !== null) await rename(target, retired)
  try { await rename(record.backup, target) } catch (error) {
    if (targetHash !== null && !await exists(target)) await rename(retired, target)
    throw error
  }
  if (await fingerprint(target) !== record.beforeSha256) throw Error('Restored package changed; preserve existing work')
  const result = { ...pending, state: 'rolled-back', rolledBackAt: new Date().toISOString() }
  await writeRecord(recordPath, result)
  return result
}

export function unpackVerifiedArchive(bytes, stage) {
  // Extract the already verified bytes. Reopening an archive pathname would
  // permit replacement after its integrity check.
  execFileSync('/usr/bin/tar', ['-xzf', '-', '-C', stage], { input: bytes, stdio: ['pipe', 'pipe', 'pipe'] })
}

function requireDesktopStopped() {
  const commands = execFileSync('/bin/ps', ['-A', '-o', 'comm='], { encoding: 'utf8' })
  if (commands.split('\n').some(s => s.trim() === '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness')) throw Error('DESKTOP_STOP_REQUIRED')
}

async function main() {
  const mode = process.argv[2] ?? 'review'
  if (!['review', 'install', 'rollback'].includes(mode)) throw Error('Use review, install or rollback')
  const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  const evidenceName = process.argv[3] ?? 'secret-bootstrap-20261017'
  if (!/^(?:secret-bootstrap|os-secret|planning-entry)-[0-9]{8}(?:-[a-z0-9]+)?$/.test(evidenceName)) throw Error('Invalid evidence directory')
  const evidence = join(repo, '.cache', evidenceName), recordPath = join(evidence, 'plugin-installation.json')
  const target = join(homedir(), '.dsh/profiles/desktop/node_modules/dsh-visible-dynamic-workflows')
  const profile = dirname(dirname(target))
  const configHashes = async () => Object.fromEntries(await Promise.all(['package.json', 'cordis.patch.yml', 'cordis.yml'].map(async file => [file, sha(await readFile(join(profile, file)))])))
  await assertCanonicalDirectory(dirname(target))
  await assertCanonicalDirectory(evidence)
  if (mode === 'rollback') {
    const record = await rollbackInstallation({ target, recordPath, requireStopped: requireDesktopStopped })
    console.log(JSON.stringify({ state: 'rolled-back', package: target, retired: record.retired, alreadyRolledBack: record.alreadyRolledBack ?? false, profileUnchanged: JSON.stringify(await configHashes()) === JSON.stringify(record.profile) }))
    return
  }
  const [packed] = JSON.parse((await readRegularFile(join(evidence, 'package.json'))).toString('utf8'))
  if (packed.name !== 'dsh-visible-dynamic-workflows' || !/^[a-z0-9.-]+\.tgz$/.test(packed.filename)) throw Error('Invalid local package metadata')
  const archive = join(evidence, packed.filename), bytes = await readRegularFile(archive)
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== packed.integrity) throw Error('Package integrity mismatch')
  const beforeSha256 = await fingerprint(target), profileHashes = await configHashes()
  const selected = currentWorkflowPackageFiles(packed)
  if (mode === 'review') {
    console.log(JSON.stringify({ mode, target, archive, archiveSha256: sha(bytes), size: bytes.length, files: packed.files.length, beforeSha256, profile: profileHashes, requiredStopped: true, secretReady: false }, null, 2))
    return
  }
  requireDesktopStopped()
  // An unresolved journal must be recovered or reviewed before another install.
  if (await exists(recordPath)) {
    const previous = JSON.parse((await readRegularFile(recordPath)).toString('utf8'))
    if (previous.state !== 'rolled-back') throw Error('Existing installation journal requires recovery')
  }
  const stage = join(dirname(target), `.workflow-stage-${randomUUID()}`), backup = join(dirname(target), `.workflow-backup-${randomUUID()}`)
  await mkdir(stage, { mode: 0o700 })
  let prepared = false
  try {
    unpackVerifiedArchive(bytes, stage)
    const source = join(stage, 'package')
    await assertCanonicalDirectory(source)
    const manifest = JSON.parse((await readRegularFile(join(source, 'package.json'))).toString('utf8'))
    if (manifest.name !== packed.name || manifest.version !== packed.version) throw Error('Unpacked identity mismatch')
    for (const file of selected) if (sha(await readRegularFile(join(source, file))) !== sha(await readRegularFile(join(repo, file)))) throw Error('Build changed after packing')
    const installedSha256 = await fingerprint(source)
    requireDesktopStopped()
    if (await fingerprint(target) !== beforeSha256 || JSON.stringify(await configHashes()) !== JSON.stringify(profileHashes)) throw Error('Installation inputs changed')
    const record = { state: 'prepared', at: new Date().toISOString(), target, backup, beforeSha256, installedSha256, profile: profileHashes, archiveSha256: sha(bytes) }
    await writeRecord(recordPath, record)
    prepared = true
    await rename(target, backup)
    await rename(source, target)
    if (await fingerprint(target) !== installedSha256) throw Error('Installation verification failed')
    await writeRecord(recordPath, { ...record, state: 'installed' })
    console.log(JSON.stringify({ state: 'installed', target, backup, installedSha256, profileUnchanged: JSON.stringify(await configHashes()) === JSON.stringify(profileHashes), secretReady: false }))
  } catch (error) {
    if (prepared) {
      try { await rollbackInstallation({ target, recordPath, requireStopped: requireDesktopStopped }) }
      catch { throw new AggregateError([error], 'Installation failed; recovery unconfirmed, existing trees preserved') }
    }
    throw error
  } finally {
    await assertCanonicalDirectory(stage)
    await rm(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
