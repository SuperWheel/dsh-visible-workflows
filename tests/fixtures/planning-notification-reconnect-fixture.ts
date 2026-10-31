// Offline production-boundary integration: real loopback socket loss, production
// Host Remote method + journal + client binder, synthetic Agent ownership/tasks.
// No Desktop, installed profile, model, planning child, workflow run or mutation.
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import VisibleWorkflowService from '../../src/host/index.ts'
import { PlanningUIState } from '../../src/host/planning/ui-state.ts'
import { bindPlanningUi, type PlanningUiCursor } from '../../src/client/planning-ui.ts'
import type { PlanningTask } from '../../src/host/planning/service.ts'
import type { PlanningPublicationUpdates } from '../../src/shared/planning-ui.ts'
import type { EditorState } from '../../src/client/store.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const host = Object.create(VisibleWorkflowService.prototype) as any
const state = new PlanningUIState(), owner = { id: 'main', session: { id: 'main' } }
let workspace = 'workspace'
Object.defineProperty(host, 'ctx', { value: { agents: { get: (id: string) => id === owner.id ? owner : undefined, roots: () => [owner], list: () => [owner] } } })
host.planningUI = state; host.agentWorkspace = () => workspace
const epoch = state.updates('workspace', 'main', 0).epoch
const firstWaiting = deferred<void>(), dropped = deferred<void>(), replayed = deferred<void>(), nextWaiting = deferred<void>(), denied = deferred<void>(), clientDenied = deferred<void>()
let dropNext = true, requests = 0, inFlight = 0, maxInFlight = 0, lostResponseCursor = 0
let deniedBody = '', dispose: (() => void) | undefined
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://localhost')
  requests++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
  const after = Number(url.searchParams.get('after'))
  const waiting = host.planningUpdates('main', after, url.searchParams.get('epoch') ?? '', 2_000)
  if (requests === 1) firstWaiting.resolve()
  if (after === 4) nextWaiting.resolve()
  try {
    const body = await waiting
    if (dropNext) {
      dropNext = false; lostResponseCursor = JSON.parse(body).cursor
      // The Host has produced the response, but the client receives no bytes.
      req.socket.destroy(); dropped.resolve(); return
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(body)
  } catch (error) {
    deniedBody = error instanceof Error ? error.message : String(error)
    res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: deniedBody }))
    denied.resolve()
  } finally { inFlight-- }
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const address = server.address(); assert(address && typeof address !== 'string')
function updates(after: number, afterEpoch: string): Promise<PlanningPublicationUpdates> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: address.port, path: `/?after=${after}&epoch=${encodeURIComponent(afterEpoch)}`, method: 'GET', agent: false }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk })
      res.on('end', () => { try { if (res.statusCode !== 200) throw new Error(JSON.parse(body).error); resolve(JSON.parse(body)) } catch (error) { reject(error) } })
    })
    req.on('error', reject); req.end()
  })
}
function published(id: string, kind: 'created' | 'proposed'): PlanningTask {
  return { id, sessionId: 'main', workspaceId: 'workspace', revision: 1, state: 'published', updatedAt: '2026-10-20T00:00:00Z', request: {}, events: [], context: { workflow: { id: 'flow' } },
    receipt: { kind, key: (kind === 'created' ? 'a' : 'b').repeat(64), digest: 'c'.repeat(64), workflowId: 'flow', revision: 1, ...(kind === 'proposed' ? { proposalId: 'proposal' } : {}) } } as PlanningTask
}
const cursor: PlanningUiCursor = { cursor: 0, epoch }, errors: string[] = []
let created = 0, refreshed = 0
const snapshot = { workflow: { id: 'flow' }, sessionId: 'main', page: 'canvas' } as EditorState
const store = { getSnapshot: () => snapshot, subscribe: () => () => {}, hasUnsavedChanges: () => false, refreshProposals: async () => { refreshed++; if (refreshed === 1) replayed.resolve() } }
const binding = () => bindPlanningUi({ sessionId: 'main', store, cursor, workspaceId: () => 'workspace', clientId: 'offline-client',
  api: { eventDrivenUpdates: true, setPlanningContext: async () => {}, planningUpdates: (_session, after, afterEpoch) => updates(after, afterEpoch) },
  onCreated: () => { created++ }, onError: message => { errors.push(message); if (/工作区/.test(message)) clientDenied.resolve() } })
try {
  dispose = binding(); await firstWaiting.promise
  state.record(published('created-task', 'created')); state.record(published('proposed-task', 'proposed'))
  await dropped.promise
  // The first receipt wakes the wait immediately; the second is retained too.
  assert.equal(lostResponseCursor, 2); assert.equal(cursor.cursor, 0); assert.equal(created, 0); assert.equal(refreshed, 0)
  await replayed.promise
  // A remount shares the consumed cursor, while the original socket was lost.
  dispose(); dispose = binding(); await nextWaiting.promise
  assert.equal(cursor.cursor, 4); assert.equal(created, 1); assert.equal(refreshed, 1)
  // Repeated reads/records and reconnect never duplicate either publication.
  state.record(published('created-task', 'created')); state.record(published('proposed-task', 'proposed'))
  assert.equal(state.updates('workspace', 'main', 0, epoch).cursor, 4)
  workspace = 'revoked-workspace'
  state.record({ ...published('private-task', 'created'), revision: 2, receipt: undefined, state: 'authoring' } as PlanningTask)
  await denied.promise
  await clientDenied.promise
  assert.match(deniedBody, /工作区/); assert(!deniedBody.includes('private-task'))
  assert.equal(cursor.cursor, 4); assert.equal(created, 1); assert.equal(refreshed, 1)
  assert(errors.some(value => /socket|hang up|reset|fetch/i.test(value)))
  assert.equal(maxInFlight, 1)
  console.log(JSON.stringify({ ok: true, realSocketDrop: true, lostResponseCursor, replayCursor: cursor.cursor, createdNotifications: created, proposalRefreshes: refreshed, repeatedRecordDeduplicated: true, remountDeduplicated: true, revokedDuringWaitDenied: true, revokedResponseContainsTask: false, maxInFlight, modelCalls: 0, desktop: false }))
} finally {
  dispose?.(); state.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
}
