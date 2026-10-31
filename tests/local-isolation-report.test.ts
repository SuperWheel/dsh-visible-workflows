import { describe, expect, it } from 'vitest'
import { localSecretBoundaryReport, parseSecretBoundaryReport, unavailableSecretBoundaryReport } from '../src/shared/secret-boundary.ts'

const base = unavailableSecretBoundaryReport({ credentials: 'local-file', sandbox: 'file-policy-only', toolGuard: 'present', broker: 'missing' })
const deployment = { phase: 'components-only', executor: 'available', brokerPackage: 'verified', globalEnforcement: false, processLifetime: 'unverified' } as const

describe('installed local isolation components do not grant credential access', () => {
  it('keeps a verified executor and broker package unavailable', () => {
    const report = localSecretBoundaryReport(base, deployment)
    expect(report).toMatchObject({ schemaVersion: 3, available: false, status: 'unavailable' })
    expect(report.summary).toContain('Secret 仍禁用')
    expect(report.checks.find(check => check.id === 'broker')?.detail).toContain('全部关闭')
    expect(parseSecretBoundaryReport(JSON.parse(JSON.stringify(report)))).toEqual(report)
  })
  it.each([
    { available: true }, { status: 'available' },
    { deployment: { ...deployment, globalEnforcement: true } },
    { deployment: { ...deployment, processLifetime: 'verified' } },
    { deployment: { ...deployment, credential: 'synthetic-secret' } },
  ])('rejects a forged open state or credential field: %j', patch => {
    expect(() => parseSecretBoundaryReport({ ...localSecretBoundaryReport(base, deployment), ...patch })).toThrow()
  })
  it('reconstructs display text and rejects unknown provider data', () => {
    const report = localSecretBoundaryReport(base, deployment)
    const hostile = { ...report, summary: 'synthetic-secret', checks: report.checks.map(check => ({ ...check, label: 'synthetic-secret', detail: 'synthetic-secret' })) }
    expect(JSON.stringify(parseSecretBoundaryReport(hostile))).not.toContain('synthetic-secret')
    expect(() => parseSecretBoundaryReport({ ...report, deployment: { ...deployment, executor: '/private/credential' } })).toThrow()
  })
  it('states the Windows validation boundary without implying support', () => {
    const report = localSecretBoundaryReport(base, { ...deployment, executor: 'windows_unverified', brokerPackage: 'missing' })
    expect(report.available).toBe(false)
    expect(report.checks.find(check => check.id === 'sandbox')?.detail).toContain('Windows 隔离尚未完成实机验证')
  })
})
