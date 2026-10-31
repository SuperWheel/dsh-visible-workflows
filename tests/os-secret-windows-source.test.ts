import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../native/os-secret-broker/windows/${path}`, import.meta.url), 'utf8')

// Packaging/surface regression guards, deliberately NOT described as native Windows execution tests.
describe('Windows OS Secret candidate remains unverified and narrowly scoped', () => {
  it('keeps the shipping default closed before native access with no runtime toggle', () => {
    const project = read('WorkflowSecretBroker.csproj')
    const program = read('Sources/Program.cs')
    expect(project).toContain("<WindowsAcceptanceBuild Condition=\"'$(WindowsAcceptanceBuild)' == ''\">false</WindowsAcceptanceBuild>")
    const gate = program.slice(program.indexOf('#if !WINDOWS_ACCEPTANCE_BUILD'), program.indexOf('#else'))
    expect(gate).toContain('"windows_unverified", Available: false')
    expect(gate).toContain('BrokerResponse.Failure("windows_unverified")')
    expect(gate).not.toContain('CredentialStore.')
    expect(gate).not.toContain('SystemAuthorization.')
    expect(program).not.toContain('GetEnvironmentVariable')
  })

  it('retains an actual desktop authentication API and a value-free response type', () => {
    const authorization = read('Sources/SystemAuthorization.cs')
    expect(authorization).toContain('UserConsentVerifierInterop.RequestVerificationForWindowAsync(')
    expect(authorization).toContain('owner.Handle, message')
    expect(authorization).toContain('UserConsentVerificationResult.Verified')
    const protocol = read('Sources/Protocol.cs')
    const response = protocol.slice(protocol.indexOf('internal sealed record BrokerResponse('))
    expect([...response.matchAll(/JsonPropertyName\("([^"]+)"\)/g)].map(match => match[1])).toEqual([
      'ok', 'code', 'available', 'state', 'status_code',
    ])
    expect(protocol).toContain('name is not ("status" or "manage" or "execute")')
  })

  it('fixes the only network consumer and never reads the response body', () => {
    const transport = read('Sources/ControlledTransport.cs')
    expect(transport).toContain('https://api.deepseek.com/user/balance')
    expect(transport).toContain('AllowAutoRedirect = false')
    expect(transport).toContain('UseProxy = false')
    expect(transport).toContain('HttpCompletionOption.ResponseHeadersRead')
    expect(transport).not.toMatch(/ReadAs(?:String|ByteArray|Stream)Async|ServerCertificateCustomValidationCallback/)
    const window = read('Sources/SecretWindow.cs')
    expect(window).not.toContain('Console.')
    expect(read('Sources/CredentialStore.cs')).not.toContain('File.Write')
  })
})
