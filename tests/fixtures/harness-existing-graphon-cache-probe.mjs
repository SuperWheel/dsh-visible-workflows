// Read-only production-cache compatibility check. The expected inventory is
// extracted ONLY from the installed archive whose hash matches the pinned local
// distribution. No cache file is changed and no Python process is executed.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { extractGraphonArchive, validateGraphonManifest, verifyGraphonRuntimeContents } from '../../src/host/graphon-environment.ts'

assert(process.versions.electron, 'Installed Harness Node required')
const assets = `${process.env.HOME}/.dsh/profiles/desktop/node_modules/dsh-visible-dynamic-workflows/runtime-assets`
const base = `${process.env.HOME}/.dsh/visible-dynamic-workflows/graphon-runtime`
const platform = 'macos-arm64', sha = value => createHash('sha256').update(value).digest('hex')
const bytes = await readFile(path.join(assets, `${platform}.json`)), local = await readFile(path.resolve('runtime-assets', `${platform}.json`))
assert.equal(sha(bytes), sha(local), 'Installed manifest must match the reviewed distribution')
const manifest = validateGraphonManifest(JSON.parse(bytes), platform), manifestDigest = sha(bytes)
const archive = path.join(assets, manifest.archive), target = path.join(base, `${platform}-${manifestDigest.slice(0,24)}`)
const expectedRoot = await mkdtemp('/private/tmp/dsh-graphon-readonly-')
const signal = AbortSignal.timeout(60000)
const hashFile = async filename => { const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) { signal.throwIfAborted(); hash.update(chunk) } return hash.digest('hex') }
const scan = async root => {
  const entries = new Map()
  async function walk(relative = '') {
    signal.throwIfAborted()
    const filename = path.join(root, relative), info = await lstat(filename)
    const type = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
    entries.set(relative, { type, info })
    if (type === 'directory') for (const name of await readdir(filename)) await walk(relative ? `${relative}/${name}` : name)
  }
  await walk(); return entries
}
let report
try {
  await extractGraphonArchive(archive, expectedRoot, manifest, signal)
  const expected = await scan(expectedRoot), actual = await scan(target)
  const difference = { missingFiles: 0, missingDirectories: 0, extraFiles: 0, extraDirectories: 0, changedFileContents: 0, changedFileSizes: 0, wrongTypes: 0, symlinks: 0, hardlinkedFiles: 0, invalidOwners: 0, invalidModes: 0 }
  const extraFileExtensions = {}, actualCounts = { files: 0, directories: 0, other: 0 }
  for (const [relative, entry] of actual) {
    actualCounts[entry.type === 'file' ? 'files' : entry.type === 'directory' ? 'directories' : 'other']++
    if (entry.type === 'symlink') difference.symlinks++
    if (entry.type === 'file' && entry.info.nlink !== 1) difference.hardlinkedFiles++
    if (entry.info.uid !== process.getuid()) difference.invalidOwners++
    const match = expected.get(relative)
    if (!match && relative !== 'ready.json') {
      if (entry.type === 'directory') difference.extraDirectories++
      else { difference.extraFiles++; const extension = path.extname(relative); const key = ['.pyc','.py','.pth'].includes(extension) ? extension : 'other'; extraFileExtensions[key] = (extraFileExtensions[key] ?? 0)+1 }
    }
    if (match && entry.type !== match.type) difference.wrongTypes++
    const mode = entry.type === 'directory' ? 0o700 : match?.info.mode & 0o7777 || 0o600
    if ((entry.info.mode & 0o7777) !== mode) difference.invalidModes++
    // Never inspect contents of additional files; only known distribution paths.
    if (match?.type === 'file' && entry.type === 'file' && entry.info.nlink === 1) {
      if (entry.info.size !== match.info.size) difference.changedFileSizes++
      else if (await hashFile(path.join(target, relative)) !== await hashFile(path.join(expectedRoot, relative))) difference.changedFileContents++
    }
  }
  for (const [relative, entry] of expected) if (!actual.has(relative)) difference[entry.type === 'directory' ? 'missingDirectories' : 'missingFiles']++
  let strictCompatible = false, strictError
  try { await verifyGraphonRuntimeContents(archive, target, manifest, manifestDigest, signal); strictCompatible = true }
  catch (error) { strictError = error instanceof Error && error.message.startsWith('Graphon ') ? error.message : 'STRICT_VERIFICATION_FAILED' }
  report = { at: new Date().toISOString(), scope: 'Read-only existing Desktop Graphon cache; no Python execution, cache mutation or Secret gate', node: process.versions.node, electron: process.versions.electron, manifestDigest, archiveSha256: manifest.sha256, expectedFileCount: manifest.fileCount, expectedDirectoryCount: [...expected.values()].filter(entry => entry.type === 'directory').length, actualCounts, difference, extraFileExtensions, strictCompatible, ...(strictError ? { strictError } : {}), sourceSha256: sha(await readFile(path.resolve('src/host/graphon-environment.ts'))), productionModified: false, pythonExecuted: false }
} finally { await rm(expectedRoot, { recursive: true, force: true }) }
const output = path.resolve('.cache/existing-graphon-cache'); await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2)+'\n')
console.log(JSON.stringify(report)); if (!report.strictCompatible) process.exitCode = 1
