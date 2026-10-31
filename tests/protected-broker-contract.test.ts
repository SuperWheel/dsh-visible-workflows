import { describe, expect, it } from 'vitest'
import { decodeBrokerResponse, encodeBrokerRequest, ProtectedBrokerError } from '../src/host/secret-broker-protocol.ts'
import { PROTECTED_OPERATION, type BrokerRequest, type BrokerScope } from '../src/shared/protected-secret.ts'

const canary = 'synthetic-only-secret-not-allowed-in-protocol'
const scope: BrokerScope = { workspaceId: 'workspace-1', workflowId: 'workflow-1', variableId: 'secret-1', nodeId: 'node-1' }
const request = (command: 'status' | 'manage' | 'execute' = 'execute') => ({ version: 1, command, operation: PROTECTED_OPERATION, scope: { ...scope } })

function expectSafeFailure(action: () => unknown, code = 'invalid_response') {
  let error: unknown
  try { action() } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(ProtectedBrokerError)
  expect(error).toMatchObject({ code })
  expect(String(error)).not.toContain(canary)
}

describe('protected broker protocol does not carry authority or secret material', () => {
  it('encodes only the fixed operation and public scope, independently of caller object identity', () => {
    const source = request()
    const encoded = encodeBrokerRequest(source)
    source.scope.nodeId = 'changed-after-encoding'
    expect(JSON.parse(encoded)).toEqual(request())
    expect(encoded.endsWith('\n')).toBe(true)
    expect(encodeBrokerRequest({ version: 1, command: 'probe' })).toBe('{"version":1,"command":"probe"}\n')
  })

  it.each(['value', 'secret', 'secretRef', 'binding', 'grant', 'approved', 'authorization', 'url', 'headers', 'body', 'executable', 'env'])('rejects caller-supplied %s in the wire contract', key => {
    expectSafeFailure(() => encodeBrokerRequest({ ...request(), [key]: canary }), 'invalid_request')
  })

  it.each(['../outside', '/absolute', 'with space', 'line\nbreak', '', 'x'.repeat(129)])('rejects malformed scope identity %j without reflecting it', identity => {
    expectSafeFailure(() => encodeBrokerRequest({ ...request(), scope: { ...scope, variableId: identity } }), 'invalid_request')
  })

  it('rejects legacy, arbitrary, reflected and overloaded commands', () => {
    for (const hostile of [
      { ...request(), version: 0 },
      { ...request(), command: 'resolve' },
      { ...request(), command: 'decrypt' },
      { ...request(), operation: 'http.fetch' },
      { ...request(), scope: { ...scope, credential: canary } },
      { version: 1, command: 'probe', scope },
      { ...request(), scope: { ...scope, runId: 'caller-controlled-not-an-approval' } },
    ]) expectSafeFailure(() => encodeBrokerRequest(hostile), 'invalid_request')
  })

  it('keeps each encoded request bound to its explicit workflow and node context', () => {
    const firstWire = JSON.parse(encodeBrokerRequest(request('status')))
    const nextScope = { ...scope, workflowId: 'other-workflow', nodeId: 'other-node' }
    const secondWire = JSON.parse(encodeBrokerRequest({ ...request('status'), scope: nextScope }))
    expect(firstWire.scope).toEqual(scope)
    expect(secondWire.scope).toEqual(nextScope)
  })
})

describe('native replies cannot introduce raw responses or spoof permission', () => {
  it.each<BrokerRequest['command']>(['probe', 'status', 'manage', 'execute'])('rejects extra material in a successful %s reply', command => {
    const valid = command === 'probe' ? { ok: true, available: false, code: 'signing_untrusted' }
      : command === 'execute' ? { ok: true, status_code: 200 }
        : { ok: true, state: command === 'status' ? 'configured' : 'saved' }
    for (const key of ['value', 'body', 'headers', 'diagnostics', 'binding', 'grant', 'message']) {
      expectSafeFailure(() => decodeBrokerResponse(command, JSON.stringify({ ...valid, [key]: canary })))
    }
  })

  it('requires probe availability and reason to agree', () => {
    expect(decodeBrokerResponse('probe', '{"ok":true,"available":false,"code":"signing_untrusted"}')).toEqual({ ok: true, available: false, code: 'signing_untrusted' })
    for (const reply of [
      { ok: true, available: true, code: 'signing_untrusted' },
      { ok: true, available: false, code: 'available' },
      { ok: false, code: 'available' },
      { ok: true, available: true, code: canary },
    ]) expectSafeFailure(() => decodeBrokerResponse('probe', JSON.stringify(reply)))
  })

  it('uses only fixed error messages for a native denial', () => {
    expectSafeFailure(() => decodeBrokerResponse('execute', '{"ok":false,"code":"authentication_failed"}'), 'authentication_failed')
    for (const reply of [{ ok: false, code: canary }, { ok: false, code: 'authentication_failed', message: canary }, { error: canary }]) {
      expectSafeFailure(() => decodeBrokerResponse('execute', JSON.stringify(reply)))
    }
  })

  it('rejects wrong-command replies, text diagnostics, multiple JSON replies and oversized output', () => {
    for (const raw of [canary, '{}\n{}', JSON.stringify({ ok: true, state: 'configured' }), JSON.stringify({ ok: true, status_code: 200 }) + ' '.repeat(4096)]) {
      expectSafeFailure(() => decodeBrokerResponse('execute', raw))
    }
    expectSafeFailure(() => decodeBrokerResponse('manage', '{"ok":true,"state":"configured"}'))
    expectSafeFailure(() => decodeBrokerResponse('status', '{"ok":true,"state":"saved"}'))
  })

  it.each([null, '200', 199, 600, 200.5, true])('rejects malformed HTTP status %j', status_code => {
    expectSafeFailure(() => decodeBrokerResponse('execute', JSON.stringify({ ok: true, status_code })))
  })
})
