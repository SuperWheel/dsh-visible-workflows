import { describe, expect, test, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { chmod, link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { extractGraphonArchive, ensureGraphonEnvironment, findGraphonAssetsDirectory, graphonSpawnEnvironment, isSafeRuntimePath, resolveGraphonPlatform, validateGraphonManifest, verifyGraphonRuntimeContents, type GraphonRuntimeManifest } from '../src/host/graphon-environment.ts'

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
  const bytes = tar(entries); await mkdir(output, { mode: 0o700 }); await writeFile(path, bytes)
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
  test('keeps only required operating-system environment and removes loader injection', () => {
    const env = graphonSpawnEnvironment('/private/runtime', { PATH: '/bin', SystemRoot: 'C:\\Windows', PYTHONPATH: '/bad', PYTHONHOME: '/bad', pythonstartup: '/bad', LD_PRELOAD: '/bad', DYLD_INSERT_LIBRARIES: '/bad' })
    expect(env.PATH).toBe(process.platform === 'win32' ? '' : '/usr/bin:/bin:/usr/sbin:/sbin'); expect(env.SystemRoot).toBe('C:\\Windows')
    expect(env.PYTHONPATH).toBeUndefined(); expect(env.PYTHONHOME).toBeUndefined(); expect(env.pythonstartup).toBeUndefined(); expect(env.LD_PRELOAD).toBeUndefined(); expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined()
    expect(env.TIKTOKEN_CACHE_DIR).toBe('/private/runtime/tokenizer-cache')
    expect(env.PYTHONNOUSERSITE).toBe('1')
  })
  test('does not pass Host credentials, proxies, shell hooks or account directories to the scheduler', () => {
    const env = graphonSpawnEnvironment('/private/runtime', {
      OPENAI_API_KEY: 'synthetic-canary', CUSTOM_PROVIDER_CREDENTIAL: 'synthetic-canary',
      AWS_SECRET_ACCESS_KEY: 'synthetic-canary', DSH_TOKEN: 'synthetic-canary',
      HTTP_PROXY: 'synthetic-canary', HTTPS_PROXY: 'synthetic-canary', NODE_OPTIONS: 'synthetic-canary',
      BASH_ENV: 'synthetic-canary', HOME: '/host/account', TMPDIR: '/host/tmp',
      LANG: 'zh_CN.UTF-8', LC_ALL: 'en_US.UTF-8',
    })
    expect(JSON.stringify(env)).not.toContain('synthetic-canary')
    expect(env).toMatchObject({ HOME: '/private/runtime', TMPDIR: '/private/runtime', TEMP: '/private/runtime', TMP: '/private/runtime', LANG: 'zh_CN.UTF-8', LC_ALL: 'en_US.UTF-8' })
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

describe('Graphon strict complete-cache verification', () => {
  async function installed() {
    const f = await archiveFixture([
      { name: 'python/lib/python3.12/site-packages/example.py', body: 'original' },
      { name: 'python/lib/python3.12/os.py', body: 'stdlib' },
      { name: 'python/lib/python3.12/__pycache__/os.pyc', body: 'compiled' },
      { name: 'python/lib/libpython.dylib', body: 'native' },
    ])
    await extractGraphonArchive(f.path, f.output, f.manifest)
    await writeFile(join(f.output, 'ready.json'), JSON.stringify({ manifestDigest: 'fixed-digest' }), { mode: 0o600 })
    return { ...f, verify: () => verifyGraphonRuntimeContents(f.path, f.output, f.manifest, 'fixed-digest') }
  }
  test('accepts exactly the verified archive including expected pyc and native libraries', async () => {
    const f = await installed()
    await expect(f.verify()).resolves.toBeUndefined()
  })
  test.each(['python/lib/python3.12/site-packages/example.py', 'python/lib/python3.12/os.py', 'python/lib/python3.12/__pycache__/os.pyc', 'python/lib/libpython.dylib'])('rejects same-size changes in %s', async name => {
    const f = await installed(), target = join(f.output, name), original = await readFile(target)
    await writeFile(target, Buffer.alloc(original.length, 88))
    await expect(f.verify()).rejects.toThrow('文件内容不符')
  })
  test.each(['python/lib/python3.12/site-packages/extra.pth', 'python/lib/python3.12/site-packages/sitecustomize.py', 'python/lib/python3.12/__pycache__/extra.pyc', 'unrelated.txt'])('rejects the additional file %s', async name => {
    const f = await installed()
    await writeFile(join(f.output, name), 'synthetic', { mode: 0o600 })
    await expect(f.verify()).rejects.toThrow('额外文件')
  })
  test('rejects missing archive entries and additional empty directories', async () => {
    const f = await installed(), target = join(f.output, 'python/lib/libpython.dylib')
    await rm(target)
    await expect(f.verify()).rejects.toThrow('文件集合不完整')
    const clean = await installed()
    await mkdir(join(clean.output, 'empty'), { mode: 0o700 })
    await expect(clean.verify()).rejects.toThrow('额外目录')
  })
  test.each(['symbolic', 'hard'])('rejects %s links even when content matches', async type => {
    const f = await installed(), target = join(f.output, 'python/lib/libpython.dylib'), outside = join(f.root, 'outside')
    await writeFile(outside, 'native', { mode: 0o600 }); await rm(target)
    if (type === 'symbolic') await symlink(outside, target)
    else await link(outside, target)
    await expect(f.verify()).rejects.toThrow('拒绝链接')
  })
  test.skipIf(process.platform === 'win32')('rejects unexpected file, directory and ready permissions', async () => {
    for (const name of ['python/lib/libpython.dylib', 'python/lib', 'ready.json']) {
      const f = await installed()
      await chmod(join(f.output, name), 0o777)
      await expect(f.verify()).rejects.toThrow('文件权限')
    }
  })
  test.skipIf(!process.getuid)('rejects a different file owner', async () => {
    const f = await installed(), uid = process.getuid!()
    const spy = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1)
    try { await expect(f.verify()).rejects.toThrow('文件所有者') } finally { spy.mockRestore() }
  })
  test('requires ready state and refuses an unauthenticated archive as the baseline', async () => {
    const f = await installed()
    await writeFile(join(f.output, 'ready.json'), JSON.stringify({ manifestDigest: 'wrong' }))
    await expect(f.verify()).rejects.toThrow('安装状态不符')
    await expect(verifyGraphonRuntimeContents(f.path, f.output, { ...f.manifest, sha256: '0'.repeat(64) }, 'wrong')).rejects.toThrow('压缩包校验失败')
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
  test('strict reuse rejects changed Python modules and extra pth without reinstalling', async () => {
    const root = await temporary(), directory = join(root, 'private')
    const options = { directory, assetsDirectory: assets, verifyRuntimeContents: true }
    const a = await ensureGraphonEnvironment(options)
    expect((await ensureGraphonEnvironment(options)).directory).toBe(a.directory)
    const target = join(a.directory, 'python/lib/python3.12/site-packages/graphon/graph_engine/graph_engine.py'), original = await readFile(target)
    expect(original.length).toBeGreaterThan(0)
    await writeFile(target, Buffer.alloc(original.length, 88))
    await expect(ensureGraphonEnvironment(options)).rejects.toThrow('文件内容不符')
    // Plain mode retains its previous three-file check. The cache is synthetic.
    expect((await ensureGraphonEnvironment({ directory, assetsDirectory: assets })).directory).toBe(a.directory)
    await writeFile(target, original)
    const extra = join(a.directory, 'python/lib/python3.12/site-packages/extra.pth')
    await writeFile(extra, 'import synthetic_missing_module', { mode: 0o600 })
    await expect(ensureGraphonEnvironment(options)).rejects.toThrow('额外文件')
    expect(await readFile(extra, 'utf8')).toBe('import synthetic_missing_module')
  }, 60_000)
  test('a caller can cancel while another installer owns a live lock', async () => {
    const root = await temporary(), directory = join(root, 'private'); await mkdir(directory)
    await writeFile(join(directory, 'macos-arm64.lock'), JSON.stringify({ pid: process.pid, token: 'owned elsewhere' }))
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('stop waiting')), 100)
    try { await expect(ensureGraphonEnvironment({ directory, assetsDirectory: assets, signal: controller.signal })).rejects.toThrow('stop waiting') }
    finally { clearTimeout(timer) }
    expect(JSON.parse(await readFile(join(directory, 'macos-arm64.lock'), 'utf8')).token).toBe('owned elsewhere')
  })
})
