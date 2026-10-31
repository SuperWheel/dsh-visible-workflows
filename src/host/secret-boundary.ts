import { unavailableSecretBoundaryReport, type SecretBoundaryReport } from '../shared/secret-boundary.ts'

export interface SecretBoundaryContext { get(name: string): unknown }

function service(ctx: SecretBoundaryContext, name: string): unknown {
  try { return ctx.get(name) } catch { return undefined }
}
function hasMethods(value: unknown, names: readonly string[]): boolean {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false
  try { return names.every(name => typeof (value as Record<string, unknown>)[name] === 'function') } catch { return false }
}
function isLocalCredentialProvider(value: unknown): boolean {
  try { return Object.getPrototypeOf(value)?.constructor?.name === 'LocalCredentialProvider' } catch { return false }
}

/**
 * Inspect the actual registered services without resolving, enumerating or reading credentials.
 * No child processes, filesystem reads, provider methods, self-reported readiness or raw diagnostics.
 */
export function inspectSecretBoundary(ctx: SecretBoundaryContext): SecretBoundaryReport {
  const credentials = service(ctx, 'credentials'), sandbox = service(ctx, 'sandbox'), tools = service(ctx, 'tools'), broker = service(ctx, 'workflowSecretBroker')
  return unavailableSecretBoundaryReport({
    credentials: !hasMethods(credentials, ['resolve', 'describe']) ? 'missing' : isLocalCredentialProvider(credentials) ? 'local-file' : 'unverified',
    sandbox: !sandbox ? 'missing' : hasMethods(sandbox, ['confine']) ? 'file-policy-only' : 'unverified',
    toolGuard: hasMethods(tools, ['guard', 'restrict']) ? 'present' : 'missing',
    broker: broker ? 'unverified' : 'missing',
  })
}
