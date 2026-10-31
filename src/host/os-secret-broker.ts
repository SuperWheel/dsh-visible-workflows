import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { z } from 'zod'
import { decodeBrokerResponse, encodeBrokerRequest, ProtectedBrokerError } from './secret-broker-protocol.ts'
import { PROTECTED_OPERATION, type BrokerCode, type BrokerProbe, type BrokerRequest, type BrokerScope } from '../shared/protected-secret.ts'
import { OS_SECRET_MESSAGES, osSecretStorageReport } from '../shared/os-secret-storage.ts'
import { inspectOSSecretPackage, osSecretPackageRoot, OS_SECRET_BROKER_BUNDLE, OS_SECRET_BROKER_EXECUTABLE } from './os-secret-integrity.ts'

const helloSchema = z.object({ version: z.literal(1), challenge: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const authorizationSchema = z.enum(['authorized', 'required'])
const statusSchema = z.object({ ok: z.literal(true), state: z.enum(['configured', 'missing']), authorization: authorizationSchema }).strict().refine(value => value.state !== 'missing' || value.authorization === 'required')
const manageSchema = z.object({ ok: z.literal(true), state: z.enum(['saved', 'deleted', 'unchanged', 'authorized', 'revoked']), authorization: authorizationSchema }).strict().refine(value => !['saved', 'deleted', 'revoked'].includes(value.state) || value.authorization === 'required').refine(value => value.state !== 'authorized' || value.authorization === 'authorized')
export type OSSecretStatus = { state: 'configured' | 'missing'; authorization: 'authorized' | 'required' }
export class OSSecretError extends ProtectedBrokerError {
  constructor(code: BrokerCode) { super(code); this.message = OS_SECRET_MESSAGES[code] }
}
export function decodeOSSecretResponse(command: BrokerRequest['command'], raw: string) {
  if (Buffer.byteLength(raw) > 4096) throw new OSSecretError('invalid_response')
  if (command === 'manage' || command === 'status') {
    let value: unknown
    try { value = JSON.parse(raw) } catch { throw new OSSecretError('invalid_response') }
    if (command === 'status') {
      const parsed = statusSchema.safeParse(value)
      if (parsed.success) return parsed.data
    } else {
      const parsed = manageSchema.safeParse(value)
      if (parsed.success) return parsed.data
    }
    if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== false) throw new OSSecretError('invalid_response')
  }
  try { return decodeBrokerResponse(command, raw) }
  catch (error) { throw new OSSecretError(error instanceof ProtectedBrokerError ? error.code : 'invalid_response') }
}

/**
 * Variable-only OS credential backend. It changes no Host provider or process
 * policy. FD3 binds a request to its child lifetime; it is NOT proof that other
 * code running under the same OS account cannot access the credential store.
 * No method returns a credential; plaintext exists only inside native UI/use.
 */
export class OSSecretBroker {
  private readonly lifetime = new AbortController()
  private readonly binary = join(osSecretPackageRoot(), OS_SECRET_BROKER_BUNDLE, OS_SECRET_BROKER_EXECUTABLE)
  private terminating = 0
  private terminationUnproved = false
  close() { this.lifetime.abort() }

  private async invoke(request: BrokerRequest, externalSignal?: AbortSignal) {
    const input = encodeBrokerRequest(request)
    if (process.platform !== 'darwin') throw new OSSecretError('unsupported_platform')
    const signal = externalSignal ? AbortSignal.any([externalSignal, this.lifetime.signal]) : this.lifetime.signal
    signal.throwIfAborted()
    if (this.terminationUnproved || this.terminating) throw new OSSecretError('busy')
    const integrity = await inspectOSSecretPackage()
    if (integrity !== 'verified') throw new OSSecretError(integrity === 'missing' ? 'broker_missing' : 'runtime_unsafe')
    if (signal.aborted) throw new OSSecretError('cancelled')
    const digest = createHash('sha256').update(input).digest('hex')
    return new Promise<ReturnType<typeof decodeOSSecretResponse>>((accept, reject) => {
      let settled = false, closed = false, permitted = false, helloSeen = false
      let stdout = '', handshake = '', size = 0
      let acknowledgeTermination: (() => void) | undefined
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(this.binary, [], { shell: false, windowsHide: true,
          env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
      } catch { reject(new OSSecretError('broker_missing')); return }
      const channel = child.stdio[3] as Duplex | null
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); channel?.destroy() }
      const fail = (code: BrokerCode) => {
        if (settled) return
        settled = true; cleanup()
        if (closed) { reject(new OSSecretError(code)); return }
        this.terminating++
        let reaped = false
        const finish = (proved: boolean) => {
          if (reaped) return
          reaped = true; clearTimeout(reapTimer); this.terminating--
          if (!proved) this.terminationUnproved = true
          reject(new OSSecretError(proved ? code : 'busy'))
        }
        const reapTimer = setTimeout(() => finish(false), 3000)
        acknowledgeTermination = () => finish(true)
        try { child.kill('SIGKILL') } catch { /* Close, not kill(), confirms exit. */ }
      }
      const abort = () => fail('cancelled')
      const timer = setTimeout(() => fail('timeout'), ['probe', 'status'].includes(request.command) ? 10_000 : 180_000)
      signal.addEventListener('abort', abort, { once: true })
      if (!channel) { fail('internal_error'); return }
      channel.on('error', () => fail('internal_error'))
      channel.on('data', (chunk: Buffer) => {
        if (settled) return
        if (helloSeen || Buffer.byteLength(handshake) + chunk.length > 2048) { fail('invalid_response'); return }
        handshake += chunk.toString('utf8')
        if (!handshake.includes('\n')) return
        if (!handshake.endsWith('\n') || handshake.indexOf('\n') !== handshake.length - 1) { fail('invalid_response'); return }
        helloSeen = true
        let hello
        try { hello = helloSchema.parse(JSON.parse(handshake)) } catch { fail('invalid_response'); return }
        if (signal.aborted) { abort(); return }
        permitted = true
        channel.write(JSON.stringify({ version: 1, challenge: hello.challenge, requestHash: digest, parentPid: process.pid }) + '\n')
      })
      child.stdout!.on('data', (chunk: Buffer) => {
        if (settled) return
        size += chunk.length
        if (size > 4096) fail('invalid_response'); else stdout += chunk.toString('utf8')
      })
      // Discard diagnostic content. Never return arbitrary native text to tools.
      child.stderr!.on('data', (chunk: Buffer) => { if (!settled && (size += chunk.length) > 4096) fail('invalid_response') })
      child.stdout!.on('error', () => fail('internal_error'))
      child.stderr!.on('error', () => fail('internal_error'))
      child.stdin!.on('error', () => fail('internal_error'))
      child.on('error', () => fail('broker_missing'))
      child.on('close', code => {
        closed = true; acknowledgeTermination?.()
        if (settled) return
        if (code !== 0 || !permitted) { fail('invalid_response'); return }
        let response
        try { response = decodeOSSecretResponse(request.command, stdout) }
        catch (error) { fail(error instanceof ProtectedBrokerError ? error.code : 'invalid_response'); return }
        settled = true; cleanup(); accept(response)
      })
      try { child.stdin!.end(input) } catch { fail('internal_error') }
      if (signal.aborted) abort()
    })
  }

  async probe(signal?: AbortSignal): Promise<BrokerProbe> {
    try { return await this.invoke({ version: 1, command: 'probe' }, signal) as BrokerProbe }
    catch (error) { return { ok: true, available: false, code: error instanceof ProtectedBrokerError ? error.code : this.lifetime.signal.aborted || signal?.aborted ? 'cancelled' : 'internal_error' } }
  }
  async report() { return osSecretStorageReport(process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'unsupported', await this.probe()) }
  async status(scope: BrokerScope, signal?: AbortSignal): Promise<OSSecretStatus> {
    const result = statusSchema.parse(await this.invoke({ version: 1, command: 'status', operation: PROTECTED_OPERATION, scope }, signal))
    return { state: result.state, authorization: result.authorization }
  }
  async manage(scope: BrokerScope): Promise<void> { await this.invoke({ version: 1, command: 'manage', operation: PROTECTED_OPERATION, scope }) }
  async execute(scope: BrokerScope, signal: AbortSignal): Promise<{ ok: boolean; status_code: number }> {
    const result = await this.invoke({ version: 1, command: 'execute', operation: PROTECTED_OPERATION, scope }, signal) as { status_code: number }
    return { ok: result.status_code >= 200 && result.status_code < 300, status_code: result.status_code }
  }
}
