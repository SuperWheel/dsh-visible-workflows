import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'
import { z } from 'zod'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const relativePath = z.string().min(1).max(512).refine(isSafeRuntimePath, 'Unsafe runtime path')
const manifestSchema = z.object({
  schemaVersion: z.literal(1), platform: z.enum(['macos-arm64', 'windows-x64']),
  graphonVersion: z.literal('0.7.0'), pythonVersion: z.literal('3.12.15'),
  archive: z.string().regex(/^graphon-core-0\.7\.0-(macos-arm64|windows-x64)\.tar\.gz$/),
  sha256: hash, archiveBytes: z.number().int().positive().max(60_000_000),
  expandedFileBytes: z.number().int().positive().max(200_000_000),
  fileCount: z.number().int().positive().max(20_000), pythonExecutable: relativePath,
  pythonExecutableSha256: hash, dependencyManifest: z.literal('core-dependencies.json'),
  dependencyManifestSha256: hash,
  tokenizer: z.object({ encoding: z.literal('cl100k_base'), path: relativePath, sha256: hash, estimatedForUnmatchedModels: z.literal(true) }).strict(),
  packages: z.array(z.object({ name: z.string().regex(/^[a-z0-9-]+$/), version: z.string().min(1) }).strict()).length(28),
  verification: z.object({ mode: z.string(), executed: z.boolean(), result: z.unknown().optional() }).strict(),
  lockSha256: hash,
  omittedInterpreterAliases: z.array(relativePath).max(100).optional(),
}).strict()

export type GraphonPlatform = 'macos-arm64' | 'windows-x64'
export type GraphonRuntimeManifest = z.infer<typeof manifestSchema>
export interface GraphonEnvironment {
  python: string
  /** Sanitized complete spawn environment. Do not merge ambient PYTHON* values back in. */
  env: Record<string, string>
  directory: string
  platform: GraphonPlatform
  manifestDigest: string
  tokenizer: { encoding: 'cl100k_base'; path: string; sha256: string; estimatedForUnmatchedModels: true }
}
export interface GraphonEnvironmentOptions { directory: string; assetsDirectory?: string; signal?: AbortSignal }

export function resolveGraphonPlatform(platform: string = process.platform, arch: string = process.arch): GraphonPlatform {
  if (platform === 'darwin' && arch === 'arm64') return 'macos-arm64'
  if (platform === 'win32' && arch === 'x64') return 'windows-x64'
  throw new Error(`此平台尚无经过校验的 Graphon 运行时：${platform}/${arch}；不会改用系统 Python`)
}

export function isSafeRuntimePath(value: string): boolean {
  if (!value || value.startsWith('/') || /[\\:\0]/.test(value)) return false
  return value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))
}

export function validateGraphonManifest(value: unknown, platform: GraphonPlatform): GraphonRuntimeManifest {
  const manifest = manifestSchema.parse(value)
  if (manifest.platform !== platform || manifest.archive !== `graphon-core-0.7.0-${platform}.tar.gz`) throw new Error('Graphon 运行时平台与当前系统不一致')
  if (manifest.pythonExecutable !== (platform === 'macos-arm64' ? 'python/bin/python3.12' : 'python/python.exe')) throw new Error('Graphon Python 入口不符合固定运行时约定')
  const names = new Set(manifest.packages.map(p => p.name))
  const expected = new Set(['annotated-types','anyio','attrs','certifi','charset-normalizer','graphon','h11','httpcore','httpx','idna','jinja2','json-repair','jsonschema','jsonschema-specifications','markupsafe','orjson','pydantic','pydantic-core','pydantic-extra-types','pyyaml','referencing','regex','requests','rpds-py','tiktoken','typing-extensions','typing-inspection','urllib3'])
  if (names.size !== expected.size || [...expected].some(name => !names.has(name))) throw new Error('Graphon 核心依赖清单不符合受控分发约定')
  if (!manifest.tokenizer.path.startsWith('tokenizer-cache/')) throw new Error('Graphon 编码资源路径无效')
  return manifest
}

export function graphonSpawnEnvironment(directory: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !key.toUpperCase().startsWith('PYTHON') && !['LD_PRELOAD','LD_LIBRARY_PATH','DYLD_INSERT_LIBRARIES','DYLD_LIBRARY_PATH','DYLD_FRAMEWORK_PATH'].includes(key.toUpperCase())) env[key] = value
  }
  return { ...env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', TIKTOKEN_CACHE_DIR: join(directory, 'tokenizer-cache'), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }
}

export async function findGraphonAssetsDirectory(moduleURL: string = import.meta.url): Promise<string> {
  let current = dirname(await realpath(fileURLToPath(moduleURL)))
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(join(current, 'package.json'), 'utf8')) as { name?: unknown }
      if (pkg.name === 'dsh-visible-dynamic-workflows') return join(current, 'runtime-assets')
    } catch (error) { if (!isMissing(error) && !(error instanceof SyntaxError)) throw error }
    const parent = dirname(current)
    if (parent === current) throw new Error('未找到插件内置的 Graphon 运行时资源目录')
    current = parent
  }
}

function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
function checkAbort(signal?: AbortSignal): void { signal?.throwIfAborted() }
async function regularFile(path: string): Promise<void> {
  const entry = await lstat(path)
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`运行时文件必须为普通文件：${basename(path)}`)
}
async function digestFile(path: string, signal?: AbortSignal): Promise<string> {
  await regularFile(path)
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) { checkAbort(signal); digest.update(chunk as Buffer) }
  return digest.digest('hex')
}
async function assertPrivateChild(root: string, child: string): Promise<string> {
  if (!isSafeRuntimePath(child)) throw new Error('非法运行时子路径')
  let target = root
  for (const part of child.split('/')) {
    target = join(target, part)
    const entry = await lstat(target)
    if (entry.isSymbolicLink()) throw new Error('Graphon 私有运行时中禁止符号链接')
  }
  return target
}
async function prepareDirectory(directory: string): Promise<string> {
  const requested = resolve(directory)
  // Canonicalize platform aliases (for example macOS /var), but reject the
  // caller's state directory itself being a link to a different location.
  await mkdir(dirname(requested), { recursive: true, mode: 0o700 })
  const parent = await realpath(dirname(requested))
  const target = join(parent, basename(requested))
  await mkdir(target, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
  const info = await lstat(target)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Graphon 状态目录不能是符号链接或普通文件')
  if (process.getuid && info.uid !== process.getuid()) throw new Error('Graphon 状态目录不属于当前用户')
  if (process.platform !== 'win32') await chmod(target, 0o700)
  return target
}

/** Extract only the regular-file USTAR subset emitted by our pinned builder. */
export async function extractGraphonArchive(archive: string, target: string, manifest: GraphonRuntimeManifest, signal?: AbortSignal): Promise<void> {
  const targetEntry = await lstat(target)
  if (targetEntry.isSymbolicLink() || !targetEntry.isDirectory()) throw new Error('Graphon 解压目录必须为私有普通目录')
  await regularFile(archive)
  if ((await stat(archive)).size !== manifest.archiveBytes || await digestFile(archive, signal) !== manifest.sha256) throw new Error('Graphon 运行时压缩包校验失败')
  const source = createReadStream(archive), stream = createGunzip()
  source.on('error', error => stream.destroy(error))
  source.pipe(stream)
  const iterator = stream[Symbol.asyncIterator]()
  let buffered = Buffer.alloc(0), total = 0, files = 0
  const seen = new Set<string>()
  const take = async (size: number): Promise<Buffer> => {
    while (buffered.length < size) {
      checkAbort(signal)
      const next = await iterator.next()
      if (next.done) throw new Error('Graphon 运行时压缩包被截断')
      buffered = Buffer.concat([buffered, next.value as Buffer])
    }
    const part = buffered.subarray(0, size)
    buffered = buffered.subarray(size)
    return part
  }
  try {
    for (;;) {
      checkAbort(signal)
      const header = await take(512)
      if (header.every(byte => byte === 0)) { if (!(await take(512)).every(byte => byte === 0)) throw new Error('无效的 tar 结束标记'); break }
      const stringAt = (start: number, length: number) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
      const octal = (start: number, length: number): number => {
        const raw = stringAt(start, length).trim()
        if (!/^[0-7]+$/.test(raw)) throw new Error('不支持的 tar 数值格式')
        return Number.parseInt(raw, 8)
      }
      const expectedChecksum = octal(148, 8)
      let checksum = 0
      for (let i = 0; i < header.length; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!
      if (checksum !== expectedChecksum || stringAt(257, 5) !== 'ustar') throw new Error('Graphon tar 头校验失败')
      const prefix = stringAt(345, 155), name = [prefix, stringAt(0, 100)].filter(Boolean).join('/')
      if (!isSafeRuntimePath(name) || seen.has(name)) throw new Error('Graphon tar 包含非法或重复路径')
      if (header[156] !== 0 && header[156] !== 48) throw new Error('Graphon tar 不允许符号链接、硬链接或设备条目')
      const size = octal(124, 12), mode = octal(100, 8)
      total += size; files++
      if (!Number.isSafeInteger(size) || size > 50_000_000 || total > manifest.expandedFileBytes || files > manifest.fileCount) throw new Error('Graphon tar 解压大小超出清单限制')
      seen.add(name)
      const destination = join(target, ...name.split('/'))
      let parent = target
      for (const part of name.split('/').slice(0, -1)) {
        parent = join(parent, part)
        await mkdir(parent, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
        const entry = await lstat(parent)
        if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Graphon 解压路径不允许符号链接')
      }
      const handle = await open(destination, 'wx', mode & 0o111 ? 0o700 : 0o600)
      try {
        let remaining = size
        while (remaining) { const chunk = await take(Math.min(remaining, 64 * 1024)); await handle.writeFile(chunk); remaining -= chunk.length }
      } finally { await handle.close() }
      if (size % 512) await take(512 - size % 512)
    }
    if (total !== manifest.expandedFileBytes || files !== manifest.fileCount) throw new Error('Graphon 运行时文件清单与压缩包不一致')
  } finally { source.destroy(); stream.destroy(); await iterator.return?.() }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  checkAbort(signal)
  return new Promise((accept, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const timer = setTimeout(() => { cleanup(); accept() }, ms)
    const abort = () => { clearTimeout(timer); cleanup(); reject(signal?.reason ?? new Error('已取消')) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
async function recoverDeadLock(path: string): Promise<boolean> {
  // Serialize dead-lock recovery. Without this guard two waiters can both see
  // an old PID, then one could delete the other's newly acquired live lock.
  const recoveryPath = `${path}.recovery`
  let handle
  try { handle = await open(recoveryPath, 'wx', 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      try { await regularFile(recoveryPath) } catch (check) { if (!isMissing(check)) throw check }
      return false
    }
    throw error
  }
  try {
    await regularFile(path)
    const lock = JSON.parse(await readFile(path, 'utf8')) as { pid?: number }
    if (typeof lock.pid !== 'number' || !Number.isSafeInteger(lock.pid) || lock.pid <= 0) return false
    try { process.kill(lock.pid, 0) } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { await rm(path); return true }
    }
    return false
  } catch (error) { if (isMissing(error)) return true; if (error instanceof SyntaxError) return false; throw error }
  finally { await handle.close(); await rm(recoveryPath, { force: true }) }
}
async function acquireLock(path: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  const token = randomUUID(), deadline = Date.now() + 180_000
  for (;;) {
    checkAbort(signal)
    try {
      const handle = await open(path, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, time: Date.now() })) }
      catch (error) { await rm(path, { force: true }); throw error }
      finally { await handle.close() }
      return async () => {
        try { await regularFile(path); const lock = JSON.parse(await readFile(path, 'utf8')); if (lock.token === token) await rm(path) } catch (error) { if (!isMissing(error)) throw error }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await recoverDeadLock(path)) continue
      if (Date.now() > deadline) throw new Error('等待 Graphon 私有运行时初始化超时')
      await delay(75, signal)
    }
  }
}

const PROBE = `import importlib.metadata,json,socket,sys\ndef offline(*a,**k): raise RuntimeError('offline runtime probe attempted network')\nsocket.socket.connect=offline\nsocket.socket.connect_ex=offline\nsocket.create_connection=offline\nfrom graphon.graph_engine import GraphEngine\nfrom graphon.graph import Graph\nimport tiktoken\nassert tiktoken.get_encoding('cl100k_base').encode('offline')\nprint(json.dumps({'python':sys.version.split()[0],'graphon':importlib.metadata.version('graphon')}))`
async function probePython(python: string, env: Record<string, string>, signal?: AbortSignal): Promise<void> {
  checkAbort(signal)
  await new Promise<void>((accept, reject) => {
    const child = spawn(python, ['-I', '-B', '-u', '-c', PROBE], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = '', errors = '', failure: Error | undefined
    const stop = (error: Error) => { failure ??= error; child.kill('SIGKILL') }
    const abort = () => stop(new Error('Graphon 运行时初始化已取消'))
    const timer = setTimeout(() => stop(new Error('Graphon 内置 Python 验证超时')), 30_000)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => { output += chunk; if (output.length > 8192) stop(new Error('Python 验证输出异常')) })
    child.stderr.on('data', (chunk: Buffer) => { errors = (errors + chunk).slice(-4096) })
    child.on('error', error => { failure = error })
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (failure) { reject(failure); return }
      if (code !== 0) { reject(new Error(`内置 Graphon 运行时无法启动：${errors.trim() || code}`)); return }
      try {
        const result = JSON.parse(output)
        if (result.python !== '3.12.15' || result.graphon !== '0.7.0') throw new Error('内置 Python/Graphon 版本不一致')
        accept()
      } catch (error) { reject(error) }
    })
    if (signal?.aborted) abort()
  })
}

async function checkInstalled(directory: string, manifest: GraphonRuntimeManifest, manifestDigest: string): Promise<boolean> {
  try {
    const root = await lstat(directory)
    if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('Graphon 运行时目录不能是符号链接')
    const ready = await assertPrivateChild(directory, 'ready.json')
    await regularFile(ready)
    if ((JSON.parse(await readFile(ready, 'utf8')) as { manifestDigest?: string }).manifestDigest !== manifestDigest) return false
    for (const [path, expected] of [[manifest.pythonExecutable, manifest.pythonExecutableSha256], [manifest.dependencyManifest, manifest.dependencyManifestSha256], [manifest.tokenizer.path, manifest.tokenizer.sha256]]) {
      if (await digestFile(await assertPrivateChild(directory, path!)) !== expected) return false
    }
    return true
  } catch (error) { if (isMissing(error)) return false; throw error }
}

export async function ensureGraphonEnvironment(options: GraphonEnvironmentOptions): Promise<GraphonEnvironment> {
  checkAbort(options.signal)
  const platform = resolveGraphonPlatform()
  const assets = await realpath(options.assetsDirectory ?? await findGraphonAssetsDirectory())
  const manifestPath = join(assets, `${platform}.json`)
  await regularFile(manifestPath).catch(error => { if (isMissing(error)) throw new Error(`插件未包含 ${platform} 的 Graphon 运行时；请安装包含该平台资源的版本`); throw error })
  const manifestBytes = await readFile(manifestPath)
  if (manifestBytes.length > 100_000) throw new Error('Graphon 运行时清单过大')
  const manifest = validateGraphonManifest(JSON.parse(manifestBytes.toString('utf8')), platform)
  const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex')
  const base = await prepareDirectory(options.directory)
  const directory = join(base, `${platform}-${manifestDigest.slice(0, 24)}`)
  const result = (): GraphonEnvironment => ({ python: join(directory, ...manifest.pythonExecutable.split('/')), env: graphonSpawnEnvironment(directory), directory, platform, manifestDigest, tokenizer: { ...manifest.tokenizer, path: join(directory, ...manifest.tokenizer.path.split('/')) } })
  if (await checkInstalled(directory, manifest, manifestDigest)) return result()
  const release = await acquireLock(join(base, `${platform}.lock`), options.signal)
  let stage: string | undefined
  try {
    if (await checkInstalled(directory, manifest, manifestDigest)) return result()
    stage = join(base, `.install-${platform}-${randomUUID()}`)
    await mkdir(stage, { mode: 0o700 })
    await extractGraphonArchive(join(assets, manifest.archive), stage, manifest, options.signal)
    for (const [path, expected] of [[manifest.pythonExecutable, manifest.pythonExecutableSha256], [manifest.dependencyManifest, manifest.dependencyManifestSha256], [manifest.tokenizer.path, manifest.tokenizer.sha256]]) {
      if (await digestFile(await assertPrivateChild(stage, path!), options.signal) !== expected) throw new Error('解压后的 Graphon 文件校验失败')
    }
    await probePython(join(stage, manifest.pythonExecutable), graphonSpawnEnvironment(stage), options.signal)
    checkAbort(options.signal)
    await writeFile(join(stage, 'ready.json'), JSON.stringify({ manifestDigest, platform, pythonVersion: manifest.pythonVersion, graphonVersion: manifest.graphonVersion }), { mode: 0o600, flag: 'wx' })
    // The private, digest-named destination is owned solely by this installer.
    await rm(directory, { recursive: true, force: true })
    await rename(stage, directory)
    stage = undefined
    return result()
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true })
    await release()
  }
}
