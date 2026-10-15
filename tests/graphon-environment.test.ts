import { describe, expect, test, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { extractGraphonArchive, ensureGraphonEnvironment, findGraphonAssetsDirectory, graphonSpawnEnvironment, isSafeRuntimePath, resolveGraphonPlatform, validateGraphonManifest, type GraphonRuntimeManifest } from '../src/host/graphon-environment.ts'

const assets = resolve('runtime-assets')
const roots: string[] = []
async function temporary() { const root = await mkdtemp(join(tmpdir(), 'graphon-env-')); roots.push(root); return root }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function actualManifest(): Promise<GraphonRuntimeManifest> { return JSON.parse(await readFile(join(assets, 'macos-arm64.json'), 'utf8')) as GraphonRuntimeManifest }
function tar(entries: Array<{ name: string; body?: string; type?: string }>): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '')
    const h = Buffer.alloc(512)
    h.write(entry.name, 0, 100); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116)
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.fill(32, 148, 156)
    h.write(entry.type ?? '0', 156); h.write('ustar\0', 257); h.write('00', 263)
    const sum = [...h].reduce((a, b) => a + b, 0); h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(h, body, Buffer.alloc((512 - body.length % 512) % 512))
  }
  blocks.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(blocks))
}
async function archiveFixture(entries: Array<{ name: string; body?: string; type?: string }>) {
  const root = await temporary(), output = join(root, 'output'), path = join(root, 'runtime.tar.gz')
  const bytes = tar(entries); await mkdir(output); await writeFile(path, bytes)
  const manifest = { ...await actualManifest(), archiveBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), fileCount: entries.length, expandedFileBytes: entries.reduce((s, e) => s + Buffer.byteLength(e.body ?? ''), 0) }
  return { root, output, path, manifest }
}

describe('Graphon private runtime boundaries', () => {
  test('selects only shipped native platforms; never chooses system Python', () => {
    expect(resolveGraphonPlatform('darwin', 'arm64')).toBe('macos-arm64')
    expect(resolveGraphonPlatform('win32', 'x64')).toBe('windows-x64')
    expect(() => resolveGraphonPlatform('linux', 'x64')).toThrow('不会改用系统 Python')
    expect(() => resolveGraphonPlatform('darwin', 'x64')).toThrow()
  })
  test('cleans Python and dynamic loader injection while preserving ordinary host environment', () => {
    const env = graphonSpawnEnvironment('/private/runtime', { PATH: '/bin', SystemRoot: 'C:\\Windows', PYTHONPATH: '/bad', PYTHONHOME: '/bad', pythonstartup: '/bad', LD_PRELOAD: '/bad', DYLD_INSERT_LIBRARIES: '/bad' })
    expect(env.PATH).toBe('/bin'); expect(env.SystemRoot).toBe('C:\\Windows')
    expect(env.PYTHONPATH).toBeUndefined(); expect(env.PYTHONHOME).toBeUndefined(); expect(env.pythonstartup).toBeUndefined(); expect(env.LD_PRELOAD).toBeUndefined(); expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined()
    expect(env.TIKTOKEN_CACHE_DIR).toBe('/private/runtime/tokenizer-cache')
    expect(env.PYTHONNOUSERSITE).toBe('1')
  })
  test('rejects traversal, Windows aliases, alternate streams and reserved device names', () => {
    for (const value of ['../outside','/absolute','a//b','a/./b','a/../b','a\\b','C:/x','a/file:stream','a/NUL','a/com1.py','a/trailing.','a/trailing ']) expect(isSafeRuntimePath(value), value).toBe(false)
    expect(isSafeRuntimePath('python/lib/python3.12/site-packages/graphon/__init__.py')).toBe(true)
  })
  test('requires fixed platform, core dependency set and isolated resource paths', async () => {
    const m = await actualManifest()
    expect(validateGraphonManifest(m, 'macos-arm64').packages).toHaveLength(28)
    expect(() => validateGraphonManifest(m, 'windows-x64')).toThrow()
    expect(() => validateGraphonManifest({ ...m, pythonExecutable: '../python' }, 'macos-arm64')).toThrow()
    expect(() => validateGraphonManifest({ ...m, tokenizer: { ...m.tokenizer, path: 'python/encoding' } }, 'macos-arm64')).toThrow()
    expect(() => validateGraphonManifest({ ...m, packages: m.packages.map((p, i) => i ? p : { name: 'transformers', version: '5' }) }, 'macos-arm64')).toThrow('受控')
  })
  test('finds the package root from source and generated host module locations', async () => {
    expect(await findGraphonAssetsDirectory()).toBe(assets)
  })
  test('extracts only digest-verified ordinary files into the private stage', async () => {
    const f = await archiveFixture([{ name: 'python/hello.txt', body: 'verified runtime' }])
    await extractGraphonArchive(f.path, f.output, f.manifest)
    expect(await readFile(join(f.output, 'python/hello.txt'), 'utf8')).toBe('verified runtime')
    expect(await readdir(f.output)).toEqual(['python'])
  })
  test('refuses corrupted archives before writing files', async () => {
    const f = await archiveFixture([{ name: 'python/test', body: 'x' }])
    await expect(extractGraphonArchive(f.path, f.output, { ...f.manifest, sha256: '0'.repeat(64) })).rejects.toThrow('校验失败')
    expect(await readdir(f.output)).toEqual([])
  })
  test('refuses tar traversal and links even when the gzip digest matches', async () => {
    for (const entry of [{ name: '../escape', body: 'x' }, { name: 'python/link', type: '2', body: '' }, { name: 'python/hard', type: '1', body: '' }]) {
      const f = await archiveFixture([entry])
      await expect(extractGraphonArchive(f.path, f.output, f.manifest)).rejects.toThrow()
      expect(existsSync(join(f.root, 'escape'))).toBe(false)
    }
  })
  test('refuses duplicate files and expansion beyond declared bounds', async () => {
    const duplicate = await archiveFixture([{ name: 'python/x', body: '1' }, { name: 'python/x', body: '2' }])
    await expect(extractGraphonArchive(duplicate.path, duplicate.output, duplicate.manifest)).rejects.toThrow('重复')
    const oversized = await archiveFixture([{ name: 'python/y', body: 'long' }])
    await expect(extractGraphonArchive(oversized.path, oversized.output, { ...oversized.manifest, expandedFileBytes: 1 })).rejects.toThrow('大小')
  })
  test('never follows preexisting stage directory links while creating parents', async () => {
    const f = await archiveFixture([{ name: 'python/nested/file', body: 'x' }])
    const outside = join(f.root, 'outside'); await mkdir(outside)
    await symlink(outside, join(f.output, 'python'))
    await expect(extractGraphonArchive(f.path, f.output, f.manifest)).rejects.toThrow('符号链接')
    expect(await readdir(outside)).toEqual([])
  })
  test('honors cancellation before extraction or environment creation', async () => {
    const controller = new AbortController(); controller.abort(new Error('cancelled by test'))
    await expect(ensureGraphonEnvironment({ directory: '/unused', signal: controller.signal })).rejects.toThrow('cancelled by test')
    const f = await archiveFixture([{ name: 'python/x', body: 'x' }])
    await expect(extractGraphonArchive(f.path, f.output, f.manifest, controller.signal)).rejects.toThrow('cancelled by test')
    expect(await readdir(f.output)).toEqual([])
  })
})

describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('actual macOS prebuilt runtime', () => {
  test('concurrent preparation produces one atomic ready environment and reuses it', async () => {
    const root = await temporary(), directory = join(root, 'private')
    await mkdir(directory)
    await writeFile(join(directory, 'macos-arm64.lock'), JSON.stringify({ pid: 2_000_000_000, token: 'abandoned installation' }))
    const [a, b] = await Promise.all([ensureGraphonEnvironment({ directory, assetsDirectory: assets }), ensureGraphonEnvironment({ directory, assetsDirectory: assets })])
    expect(a.python).toBe(b.python)
    expect(a.python).toContain('/python/bin/python3.12')
    expect(a.env.TIKTOKEN_CACHE_DIR).toBe(join(a.directory, 'tokenizer-cache'))
    expect(JSON.parse(await readFile(join(a.directory, 'ready.json'), 'utf8')).manifestDigest).toBe(a.manifestDigest)
    expect((await readdir(directory)).filter(name => name.startsWith('.install-') || name.endsWith('.lock'))).toEqual([])
    const next = await ensureGraphonEnvironment({ directory, assetsDirectory: assets }); expect(next.directory).toBe(a.directory)
  }, 60_000)
  test('rejects a symlink state directory and does not fall back to PATH', async () => {
    const root = await temporary(), target = join(root, 'target'), linked = join(root, 'linked')
    await mkdir(target); await symlink(target, linked)
    await expect(ensureGraphonEnvironment({ directory: linked, assetsDirectory: assets })).rejects.toThrow('符号链接')
    expect(await readdir(target)).toEqual([])
  })
  test('a caller can cancel while another installer owns a live lock', async () => {
    const root = await temporary(), directory = join(root, 'private'); await mkdir(directory)
    await writeFile(join(directory, 'macos-arm64.lock'), JSON.stringify({ pid: process.pid, token: 'owned elsewhere' }))
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('stop waiting')), 100)
    try { await expect(ensureGraphonEnvironment({ directory, assetsDirectory: assets, signal: controller.signal })).rejects.toThrow('stop waiting') }
    finally { clearTimeout(timer) }
    expect(JSON.parse(await readFile(join(directory, 'macos-arm64.lock'), 'utf8')).token).toBe('owned elsewhere')
  })
})
