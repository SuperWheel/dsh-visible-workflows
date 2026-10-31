import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OSSecretBroker, decodeOSSecretResponse } from '../src/host/os-secret-broker.ts'
import { PROTECTED_OPERATION } from '../src/shared/protected-secret.ts'

const io = vi.hoisted(() => ({ spawn: vi.fn(), integrity: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: io.spawn }))
vi.mock('../src/host/os-secret-integrity.ts', () => ({ inspectOSSecretPackage: io.integrity, osSecretPackageRoot: () => '/fixed/bundle', OS_SECRET_BROKER_BUNDLE: 'OS.app', OS_SECRET_BROKER_EXECUTABLE: 'Contents/MacOS/OS' }))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const scope = { workspaceId: 'workspace', workflowId: 'workflow', variableId: 'token', nodeId: 'http' }
const challenge = 'a'.repeat(64)
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
class Child extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter()
  stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  channel = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn() })
  stdio = [this.stdin, this.stdout, this.stderr, this.channel]
  kill = vi.fn(() => { queueMicrotask(() => this.emit('close', null)); return true })
  hello(value: unknown = { version: 1, challenge }) { this.channel.emit('data', Buffer.from(JSON.stringify(value) + '\n')) }
  reply(value: unknown) { this.stdout.emit('data', Buffer.from(JSON.stringify(value))); this.emit('close', 0) }
}
let child: Child
beforeEach(() => { Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' }); child = new Child(); io.spawn.mockReturnValue(child); io.integrity.mockResolvedValue('verified') })
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetAllMocks() })

it('starts without changing Host isolation and sends only public scope over the bounded private channel', async () => {
  vi.stubEnv('PRIVATE_TEST_ENV', 'must-not-be-inherited')
  const broker = new OSSecretBroker(), pending = broker.execute(scope, new AbortController().signal)
  await flush(); child.hello()
  const input = child.stdin.end.mock.calls[0]![0]
  expect(JSON.parse(input)).toEqual({ version: 1, command: 'execute', operation: PROTECTED_OPERATION, scope })
  expect(JSON.parse(child.channel.write.mock.calls[0]![0])).toEqual({ version: 1, challenge, requestHash: createHash('sha256').update(input).digest('hex'), parentPid: process.pid })
  expect(io.spawn.mock.calls[0]).toEqual(['/fixed/bundle/OS.app/Contents/MacOS/OS', [], { shell: false, windowsHide: true, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdio: ['pipe','pipe','pipe','pipe'] }])
  child.reply({ ok: true, status_code: 401 })
  await expect(pending).resolves.toEqual({ ok: false, status_code: 401 })
  expect(child.channel.destroy).toHaveBeenCalledOnce()
})

it.each(['missing', 'unverified'])('does not spawn an unverifiable component: %s', async state => {
  io.integrity.mockResolvedValue(state)
  await expect(new OSSecretBroker().probe()).resolves.toMatchObject({ available: false, code: state === 'missing' ? 'broker_missing' : 'runtime_unsafe' })
  expect(io.spawn).not.toHaveBeenCalled()
})

it('leaves Windows disabled until its actual authentication and credential lifecycle are verified', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  await expect(new OSSecretBroker().report()).resolves.toMatchObject({ schemaVersion: 4, platform: 'windows', available: false, protection: 'workflow-interfaces', arbitraryLocalCodeIsolation: false })
  expect(io.spawn).not.toHaveBeenCalled()
})

it('requires the child handshake even for a successful looking status response', async () => {
  const pending = new OSSecretBroker().status(scope)
  await flush(); child.reply({ ok: true, state: 'configured' })
  await expect(pending).rejects.toMatchObject({ code: 'invalid_response' })
})

it('rejects secret-bearing response fields and raw diagnostics', async () => {
  const pending = new OSSecretBroker().execute(scope, new AbortController().signal)
  await flush(); child.hello(); child.stderr.emit('data', Buffer.from('raw-secret-and-private-path'))
  child.reply({ ok: true, status_code: 200, token: 'raw-secret-and-private-path' })
  await expect(pending).rejects.toMatchObject({ code: 'invalid_response' })
  for (const command of ['probe', 'status', 'manage', 'execute'] as const) {
    expect(() => decodeOSSecretResponse(command, '{"ok":false,"code":"internal_error","detail":"raw-secret"}')).toThrow('安全协议')
  }
  expect(decodeOSSecretResponse('manage', '{"ok":true,"state":"unchanged","authorization":"required"}')).toEqual({ ok: true, state: 'unchanged', authorization: 'required' })
})

it('cancels only the private child and waits for its exit; Host environment and other tools remain untouched', async () => {
  const controller = new AbortController(), broker = new OSSecretBroker(), pending = broker.execute(scope, controller.signal)
  await flush(); child.hello(); controller.abort()
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  expect(child.channel.destroy).toHaveBeenCalledOnce()
  broker.close()
  await expect(broker.probe()).resolves.toMatchObject({ available: false, code: 'cancelled' })
  expect(io.spawn).toHaveBeenCalledOnce()
})

it('rejects caller-supplied raw values before spawning a helper', async () => {
  await expect(new OSSecretBroker().status({ ...scope, value: 'synthetic' } as never)).rejects.toMatchObject({ code: 'invalid_request' })
  expect(io.spawn).not.toHaveBeenCalled()
})


it('keeps configuration and persistent authorization separate and never accepts a legacy status as a grant', async () => {
  const pending = new OSSecretBroker().status(scope)
  await flush(); child.hello(); child.reply({ok:true,state:'configured',authorization:'required'})
  await expect(pending).resolves.toEqual({state:'configured',authorization:'required'})
  for (const state of ['configured','missing']) {
    expect(() => decodeOSSecretResponse('status',JSON.stringify({ok:true,state}))).toThrow('安全协议')
  }
  expect(() => decodeOSSecretResponse('status','{"ok":true,"state":"missing","authorization":"authorized"}')).toThrow('安全协议')
  expect(() => decodeOSSecretResponse('status','{"ok":true,"state":"configured","authorization":"authorized","grant":"injectable"}')).toThrow('安全协议')
})

it('propagates only the closed authorization-required code without opening management or retrying', async () => {
  const pending = new OSSecretBroker().execute(scope,new AbortController().signal)
  await flush(); child.hello(); child.reply({ok:false,code:'authorization_required'})
  await expect(pending).rejects.toMatchObject({code:'authorization_required'})
  expect(io.spawn).toHaveBeenCalledOnce()
  expect(JSON.parse(child.stdin.end.mock.calls[0]![0]).command).toBe('execute')
})

it('validates explicit native authorization and revocation results without carrying grants or values', () => {
  for (const [state,authorization] of [['authorized','authorized'],['revoked','required'],['saved','required'],['deleted','required'],['unchanged','authorized']]) {
    expect(decodeOSSecretResponse('manage',JSON.stringify({ok:true,state,authorization}))).toEqual({ok:true,state,authorization})
  }
  for (const value of [{ok:true,state:'saved',authorization:'authorized'},{ok:true,state:'authorized',authorization:'required'},{ok:true,state:'revoked',authorization:'required',token:'synthetic'}]) {
    expect(() => decodeOSSecretResponse('manage',JSON.stringify(value))).toThrow('安全协议')
  }
})
