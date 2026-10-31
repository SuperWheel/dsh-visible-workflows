import { z } from 'zod'
import {
  brokerCodeSchema,
  brokerRequestSchema,
  BROKER_MESSAGES,
  type BrokerCode,
  type BrokerProbe,
  type BrokerRequest,
} from '../shared/protected-secret.ts'

const failureSchema = z.object({ ok: z.literal(false), code: brokerCodeSchema }).strict()
const probeSchema = z.object({ ok: z.literal(true), available: z.boolean(), code: brokerCodeSchema })
  .strict().refine(reply => reply.available === (reply.code === 'available'))

export class ProtectedBrokerError extends Error {
  constructor(readonly code: BrokerCode) { super(BROKER_MESSAGES[code]) }
}

/** The wire contract accepts public scope and fixed operations, never raw credentials. */
export function encodeBrokerRequest(value: unknown): string {
  const parsed = brokerRequestSchema.safeParse(value)
  if (!parsed.success) throw new ProtectedBrokerError('invalid_request')
  return JSON.stringify(parsed.data) + '\n'
}

/** Never forward arbitrary diagnostic strings, headers, bodies or provider objects. */
export function decodeBrokerResponse(command: BrokerRequest['command'], raw: string):
  BrokerProbe | { ok: true; state: 'configured' | 'missing' | 'saved' | 'deleted' } | { ok: true; status_code: number } {
  if (Buffer.byteLength(raw) > 4096) throw new ProtectedBrokerError('invalid_response')
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new ProtectedBrokerError('invalid_response') }
  const failure = failureSchema.safeParse(value)
  if (failure.success) throw new ProtectedBrokerError(failure.data.code === 'available' ? 'invalid_response' : failure.data.code)
  const schema = command === 'probe' ? probeSchema
    : command === 'execute' ? z.object({ ok: z.literal(true), status_code: z.number().int().min(200).max(599) }).strict()
      : z.object({ ok: z.literal(true), state: command === 'status' ? z.enum(['configured', 'missing']) : z.enum(['saved', 'deleted']) }).strict()
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new ProtectedBrokerError('invalid_response')
  return parsed.data
}
