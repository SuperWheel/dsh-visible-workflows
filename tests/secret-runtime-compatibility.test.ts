import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { assertCurrentSecretRuntime } from '../src/host/secret-runtime-compatibility.ts'

const context = (services: Record<string, unknown>) => ({ root: { get: (name: string) => services[name] } }) as unknown as Context

describe('current OS credential runtime compatibility', () => {
  it('keeps ordinary Host providers available without a retired service', () => {
    const resolve = vi.fn(() => { throw Error('must not read credentials') })
    expect(() => assertCurrentSecretRuntime(context({ credentials: { resolve }, sandbox: {}, tools: {}, subprocess: {} }))).not.toThrow()
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each(['secretIsolationBoundary', 'workflowIsolation'])('rejects an installed retired %s service before execution', name => {
    const report = vi.fn(() => ({ phase: 'active' })), assertActive = vi.fn()
    expect(() => assertCurrentSecretRuntime(context({ [name]: Object.freeze({ version: 1, report, assertActive }) }))).toThrow('已停用的全局 Secret 隔离组件')
    expect(report).not.toHaveBeenCalled()
    expect(assertActive).not.toHaveBeenCalled()
  })

  it('does not accept a complete old composition as credential authority', () => {
    const execute = vi.fn()
    expect(() => assertCurrentSecretRuntime(context({ secretIsolationBoundary: { report: () => ({ phase: 'active' }) }, workflowIsolation: Object.freeze({ version: 1, broker: { execute } }) }))).toThrow('已停用')
    expect(execute).not.toHaveBeenCalled()
  })
})
