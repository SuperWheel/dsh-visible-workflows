import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { OS_SECRET_BROKER_MANIFEST_SHA256 } from './os-secret-manifest.ts'

export const OS_SECRET_BROKER_BUNDLE = 'Workflow OS Secret Broker.app'
export const OS_SECRET_BROKER_EXECUTABLE = 'Contents/MacOS/WorkflowOSSecretBroker'
/** Bundled lib/index.js resource layout. Tests pass their fixture root explicitly. */
export function osSecretPackageRoot() { return fileURLToPath(new URL('../native/os-secret-broker/dist/', import.meta.url)) }

const fileSchema = z.object({
  path: z.string().max(512).regex(/^Contents\/[A-Za-z0-9_. /-]+$/).refine(value => !value.split('/').some(part => !part || part === '.' || part === '..')),
  size: z.number().int().nonnegative().max(16_777_216), sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
const manifestSchema = z.object({ version: z.literal(1), identifier: z.literal('com.deepseekharness.workflow.os-secret-broker'), files: z.array(fileSchema).min(3).max(32) }).strict()

async function regularBytes(file: string, maxSize: number) {
  const before = await lstat(file)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxSize || (before.mode & 0o022) !== 0) throw new Error('unverified')
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.nlink !== 1) throw new Error('unverified')
    // A concurrently grown file must not cause an unbounded allocation/read.
    const buffer = Buffer.alloc(before.size + 1)
    let count = 0
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count)
      if (!bytesRead) break
      count += bytesRead
    }
    const data = buffer.subarray(0, count)
    const after = await handle.stat()
    if (data.length !== before.size || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('unverified')
    return data
  } finally { await handle.close() }
}

/** Public diagnostic: file integrity only, never a grant or whole-Host readiness. */
export async function inspectOSSecretPackage(root = osSecretPackageRoot()): Promise<'verified' | 'missing' | 'unverified'> {
  const bundle = path.join(root, OS_SECRET_BROKER_BUNDLE), manifestPath = path.join(root, 'integrity.json')
  try { await lstat(bundle); await lstat(manifestPath) } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unverified' }
  try {
    if (!OS_SECRET_BROKER_MANIFEST_SHA256 || !/^[a-f0-9]{64}$/.test(OS_SECRET_BROKER_MANIFEST_SHA256)) return 'unverified'
    const manifestBytes = await regularBytes(manifestPath, 16_384)
    if (createHash('sha256').update(manifestBytes).digest('hex') !== OS_SECRET_BROKER_MANIFEST_SHA256) return 'unverified'
    const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')))
    const expected = new Map(manifest.files.map(file => [file.path, file]))
    if (expected.size !== manifest.files.length || !expected.has(OS_SECRET_BROKER_EXECUTABLE) || !expected.has('Contents/Info.plist') || !expected.has('Contents/_CodeSignature/CodeResources')) return 'unverified'
    const expectedDirectories = new Set([''])
    for (const file of expected.keys()) { let directory = path.posix.dirname(file); while (directory !== '.') { expectedDirectories.add(directory); directory = path.posix.dirname(directory) } }
    const actualRoot = await realpath(bundle)
    const seen = new Set<string>()
    async function walk(relative: string): Promise<void> {
      const directory = path.join(bundle, relative), stat = await lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || !expectedDirectories.has(relative)) throw new Error('unverified')
      if (await realpath(directory) !== path.join(actualRoot, relative)) throw new Error('unverified')
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(name)
        else {
          const record = expected.get(name)
          if (!record || entry.isSymbolicLink() || !entry.isFile()) throw new Error('unverified')
          const bytes = await regularBytes(path.join(bundle, name), record.size)
          if (bytes.length !== record.size || createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw new Error('unverified')
          seen.add(name)
        }
      }
    }
    await walk('')
    if (seen.size !== expected.size || !((await lstat(path.join(bundle, OS_SECRET_BROKER_EXECUTABLE))).mode & 0o111)) return 'unverified'
    return 'verified'
  } catch { return 'unverified' }
}
