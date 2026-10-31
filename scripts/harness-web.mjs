import { spawn } from 'node:child_process'
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const secretField = /^(?:(?:x[-_])?api[-_]?key|(?:access[-_]?|refresh[-_]?)?token|password|(?:client[-_]?)?secret|authorization)$/i
const referenceField = /^(?:apiKeyEnv|credentialRef)$/
const credentialRef = /^[A-Za-z_][A-Za-z0-9_]*$/

function assertNoInlineCredentials(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (secretField.test(key)) throw new Error('模型配置含内联凭证，请先将其存入 DSH 凭证管理；不会生成验收配置。')
    if (/url$/i.test(key) && typeof item === 'string') {
      try {
        const url = new URL(item)
        if (url.username || url.password || [...url.searchParams.keys()].some(name => secretField.test(name))) throw new Error('模型地址含凭证；不会生成验收配置。')
      } catch (error) { if (error instanceof Error && error.message.includes('不会生成')) throw error }
    }
    assertNoInlineCredentials(item)
  }
}

/** Copy only model routing and selection, never desktop UI/plugin state or credentials. */
export function modelProfileOverrides(entries) {
  if (!Array.isArray(entries)) throw new Error('DSH profile 必须是配置列表。')
  return entries.filter(entry => entry && typeof entry === 'object' && (entry.id === 'agent-default-model' || /^llm-/.test(entry.id ?? '')) && entry.config && typeof entry.config === 'object').map(entry => {
    assertNoInlineCredentials(entry.config)
    return { id: entry.id, ...(entry.name ? { name: entry.name } : {}), config: structuredClone(entry.config) }
  })
}

/** Return reference names only. Values are resolved separately into child-process memory. */
export function modelCredentialRefs(overrides) {
  const refs = new Set()
  const visit = value => {
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if (referenceField.test(key) && typeof item === 'string') {
        if (!credentialRef.test(item)) throw new Error('模型凭证引用格式无效。')
        refs.add(item)
      }
      visit(item)
    }
  }
  visit(overrides)
  return [...refs]
}

/** Preserve explicit launch overrides; borrow only references used by model routes. */
export function modelCredentialEnvironment(refs, stored, inherited = process.env) {
  const env = { ...inherited }
  for (const ref of refs) {
    if (!env[ref]?.trim() && typeof stored.get(ref) === 'string' && stored.get(ref).trim()) env[ref] = stored.get(ref)
  }
  return env
}

/** Host startup can print a browser access token. Never forward it to tool or log output. */
export function redactHostOutput(value, secrets = []) {
  let text = String(value).replace(/([?&](?:token|access_token|auth|key)=)[^&\s]+/gi, '$1[REDACTED]').replace(/(authorization\s*:\s*bearer\s+)\S+/gi, '$1[REDACTED]')
  for (const secret of secrets.filter(value => typeof value === 'string' && value.length > 0).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]')
  return text
}

export function pipeSafe(stream, destination, secrets) {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    pending += chunk
    const lines = pending.split('\n'); pending = lines.pop() ?? ''
    for (const line of lines) destination.write(`${redactHostOutput(line, secrets)}\n`)
  })
  stream.on('end', () => { if (pending) destination.write(redactHostOutput(pending, secrets)) })
}

export async function startHarnessWeb(args = process.argv.slice(2)) {
  const options = { 'source-home': join(homedir(), '.dsh'), 'source-profile': 'desktop', port: '5188' }
  for (let i = 0; i < args.length; i++) {
    const name = args[i]?.replace(/^--/, '')
    if (name === 'dry-run') { options[name] = true; continue }
    if (!['host-bin', 'source-home', 'source-profile', 'port'].includes(name) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('用法：node scripts/harness-web.mjs --host-bin /绝对路径/dsh/lib/bin.js [--port 5188] [--dry-run]')
    options[name] = args[++i]
  }
  if (!options['host-bin']) throw new Error('请通过 --host-bin 指定已安装的真正 DeepSeekHarness CLI。')
  const port = Number(options.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Web 端口必须在 1024–65535 之间。')
  if (!/^[A-Za-z0-9_-]+$/.test(options['source-profile'])) throw new Error('来源 profile 名称无效。')
  const hostBin = await realpath(resolve(options['host-bin'])), hostRequire = createRequire(hostBin)
  const { parseDocument } = hostRequire('yaml')
  const credentialModule = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-credentials-local')).href)
  const sourceHome = resolve(options['source-home']), targetHome = join(root, '.cache/harness-web-test')
  if (sourceHome === targetHome) throw new Error('验收环境必须与来源 DSH 环境分开。')
  const sourceProfile = join(sourceHome, 'profiles', options['source-profile'], 'cordis.patch.yml')
  const document = parseDocument(await readFile(sourceProfile, 'utf8'), { prettyErrors: false })
  if (document.errors.length) throw new Error('DSH 模型配置 YAML 无法解析；不会输出原文。')
  const overrides = modelProfileOverrides(document.toJS()), refs = modelCredentialRefs(overrides)
  let stored = new Map()
  try { stored = credentialModule.parseCredentialsDocument(await readFile(join(sourceHome, '.credentials.yaml'), 'utf8'), 'DSH 凭证管理').refs }
  catch (error) { if (error?.code !== 'ENOENT') throw new Error('无法读取来源 DSH 凭证管理；不会输出原文。') }
  const env = modelCredentialEnvironment(refs, stored)
  const secrets = refs.map(ref => env[ref]).filter(Boolean)
  const overlay = `${JSON.stringify(overrides, null, 2)}\n`
  // Defend against a credential accidentally appearing under an unrecognized field.
  if (secrets.some(secret => overlay.includes(secret) || overlay.includes(JSON.stringify(secret).slice(1, -1)))) throw new Error('模型配置含凭证值；不会写入验收目录。')
  const selection = overrides.find(entry => entry.id === 'agent-default-model')?.config
  process.stdout.write(redactHostOutput(`DeepSeekHarness Web：复用 ${overrides.filter(entry => entry.id !== 'agent-default-model').length} 项模型配置、${refs.filter(ref => env[ref]).length} 项已接入凭证；默认模型 ${selection?.provider ?? '宿主默认'}/${selection?.model ?? '宿主默认'}。\n`, secrets))
  if (options['dry-run']) return
  await mkdir(targetHome, { recursive: true })
  const patch = join(targetHome, 'model-profile.patch.yml')
  await writeFile(patch, overlay, { mode: 0o600 })
  const child = spawn(process.execPath, [hostBin, '--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', String(port), '--no-open'], { cwd: root, env: { ...env, DSH_HOME: targetHome }, stdio: ['inherit', 'pipe', 'pipe'] })
  pipeSafe(child.stdout, process.stdout, secrets); pipeSafe(child.stderr, process.stderr, secrets)
  const stop = signal => child.kill(signal)
  const onInt = () => stop('SIGINT'), onTerm = () => stop('SIGTERM')
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm)
  await new Promise((accept, reject) => { child.once('error', () => reject(new Error('无法启动 DeepSeekHarness Web。'))); child.once('exit', code => { process.exitCode = code ?? 1; accept() }) })
  process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startHarnessWeb().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'DeepSeekHarness Web 启动失败。'}\n`); process.exitCode = 1 })
