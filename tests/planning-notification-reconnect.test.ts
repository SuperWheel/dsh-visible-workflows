import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

it('recovers a lost production Host journal response over a real socket and deduplicates client notifications', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', new URL('./fixtures/planning-notification-reconnect-fixture.ts', import.meta.url).pathname], { timeout: 15_000, maxBuffer: 1_000_000 })
  expect(JSON.parse(stdout.trim())).toEqual({ ok: true, realSocketDrop: true, lostResponseCursor: 2, replayCursor: 4, createdNotifications: 1, proposalRefreshes: 1, repeatedRecordDeduplicated: true, remountDeduplicated: true, revokedDuringWaitDenied: true, revokedResponseContainsTask: false, maxInFlight: 1, modelCalls: 0, desktop: false })
}, 20_000)
