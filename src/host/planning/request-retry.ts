/** A failed model request ran no tool; the SDK re-runs the same step over the same durable history.
 * Output glitches (truncated tool JSON, closed stream, empty reply) and transient transport failures
 * qualify. Quota, credential, context and other failures stay terminal. */
const RETRYABLE_REQUEST_CODES = ['MALFORMED_RESPONSE', 'STREAM_CLOSED', 'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']
type RetryAction = { readonly kind: 'retry' } | undefined

/** At most one re-request per model step. A downstream policy may apply its backoff first, but its
 * decision never widens this bound; the caller still counts the retry as a step and checks limits. */
export function requestRetryGate() {
  const retried = new Set<string>()
  return async (failure: { readonly code: string } | undefined, identity: { readonly turn?: number; readonly step?: number }, next: () => Promise<RetryAction>): Promise<boolean> => {
    if (!failure || !RETRYABLE_REQUEST_CODES.includes(failure.code.toUpperCase())) return false
    const key = JSON.stringify([identity.turn, identity.step])
    if (retried.has(key)) return false
    retried.add(key)
    await next()
    return true
  }
}
