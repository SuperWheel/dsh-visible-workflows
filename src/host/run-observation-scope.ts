// Per-run ownership of the SDK filesystem observation policy.
//
// `@deepseek-ai/dsh-fs-observation-policy` keys observed present/absent/version
// state by `actor.agent.session` and exposes no owner hook. Host native tools
// must execute with the conversation Agent (permissions, scope, availability,
// audit and parent/rootCallId all derive from that identity), so every workflow
// run of one conversation would share — and leak into — that conversation's
// observations. The policy README documents the `fs/*-intent` waterfalls as
// first-registered-wins single slots; this module seats a decider directly in
// front of the policy's own listener (pass-through wrappers such as the SDK's
// workspace-changes recorder prepend themselves too, and must keep wrapping
// whatever decides), and replaces a decision only when the slot right behind
// it is held by that policy plugin itself:
//  - calls dispatched for a run decide from that run's own ledger;
//  - conversation calls on a target a run has observed decide from the
//    conversation's own observations, because the SDK map now holds the run's.
// Decisions mirror the SDK gate exactly, and the provider still performs the
// atomic version/no-clobber check, so a read followed by an external change in
// the same owner is still rejected. Any other decider keeps its own semantics.
// Ledgers are memory only, like the SDK's.

/** Cordis plugin name exported by `@deepseek-ai/dsh-fs-observation-policy`. */
export const OBSERVATION_POLICY_PLUGIN = 'fs-observation-policy'
/** Never equal to a provider version: guarded mutations fail stale until re-read. */
export const UNRECORDED_OBSERVATION = 'visible-workflows:unrecorded-conversation-observation'
/** SDK `FsTarget` subset used for keying and the policy's own messages. */
export type ObservedTarget = { targetKey: string; displayPath: string }
/** SDK observation record: confirmed absence or presence at a provider version. */
export type Observation = { kind: 'absent' } | { kind: 'present'; version: unknown }
/** Opaque SDK event actor: the registry-minted tool execution. */
export type ObservationActor = { callId?: unknown; token?: unknown; parent?: unknown; agent?: { session?: unknown }; signal?: AbortSignal } | undefined
type Next = () => Promise<unknown>
type IntentName = 'fs/write-intent' | 'fs/edit-intent'
type ErrorClass = new (message: string, code: string) => Error
type Hook = { ctx?: { fiber?: { name?: string } } }
/** The Cordis surface this module needs: the policy's events, plus slot inspection. */
export interface ObservationContext {
  on(name: IntentName, listener: (target: ObservedTarget, actor: ObservationActor, next: Next) => Promise<unknown>, options: { prepend: true }): () => void
  on(name: 'fs/observed', listener: (target: ObservedTarget, observation: Observation, actor: ObservationActor) => void, options: { prepend: true }): () => void
  on(name: 'tools/execute', listener: (exec: ObservationActor, next: () => unknown) => unknown, options: { prepend: true }): () => void
  on(name: 'session/created', listener: (session: object) => void): () => void
  on(name: 'internal/dispatch', listener: (type: string, name: string, args: readonly unknown[]) => void): () => void
  waterfall(name: IntentName, target: ObservedTarget, actor: ObservationActor, next: () => undefined): Promise<unknown>
  readonly fiber: object
  readonly events: { readonly _hooks: Readonly<Record<string, Hook[] | undefined>> }
}
type Ledger = Map<string, Observation>
type Call = { ledger: Ledger; tokens: Set<unknown> }
type Conversation = { observed: Ledger; tainted: Set<string>; complete: boolean }

export class RunObservationScopes {
  private readonly runs = new Map<string, Ledger>()
  private readonly calls = new Map<unknown, Call>()
  private readonly tokens = new Map<unknown, Call>()
  // The conversation's own observations, consulted only for targets a run has
  // overwritten in the SDK's session-keyed map.
  private conversations = new WeakMap<object, Conversation>()
  // Sessions announced after installation: every SDK observation of theirs was seen here.
  private born = new WeakSet<object>()
  // The policy fiber whose state the ledgers mirror; a new one starts empty.
  private policy: object | undefined
  private policyFresh = false
  // Per actor: each intent dispatch's arguments with the policy fiber that sat right
  // behind this module when it snapshotted its listeners. Reseating changes later
  // dispatches only. Cordis appends that dispatch's own `next` to the same array.
  private snapshots = new WeakMap<object, Array<{ args: readonly unknown[]; successor: object | undefined }>>()
  constructor(private readonly ctx: ObservationContext) {}
  /** Register the prepended deciders and observers; each disposer unregisters one listener. */
  listeners(): Array<() => void> {
    const disposers = [
      this.ctx.on('session/created', session => { this.born.add(session) }),
      // Emitted synchronously right before a dispatch snapshots its listeners.
      this.ctx.on('internal/dispatch', (_type, name, args) => {
        if (name !== 'fs/write-intent' && name !== 'fs/edit-intent') return
        const actor = args[1]
        if (typeof actor !== 'object' || actor === null) return
        let pending = this.snapshots.get(actor)
        if (!pending) { pending = []; this.snapshots.set(actor, pending) }
        pending.push({ args, successor: this.slotPolicy(name) })
      }),
      // Bind ancestry at the execution boundary, before any nested dispatch.
      this.ctx.on('tools/execute', (exec, next) => { this.seat(); this.callFor(exec); return next() }, { prepend: true }),
      this.ctx.on('fs/write-intent', (target, actor, next) => this.writeIntent(target, actor, next), { prepend: true }),
      this.ctx.on('fs/edit-intent', (target, actor, next) => this.editIntent(target, actor, next), { prepend: true }),
      this.ctx.on('fs/observed', (target, observation, actor) => this.observe(target, observation, actor), { prepend: true }),
    ]
    this.seat()
    // A policy already installed (even behind another decider) may know conversation
    // observations made before this point.
    this.policy = this.installedPolicy()
    this.policyFresh = !this.policy
    return disposers
  }
  /** Attribute one Host-dispatched tool call, and its nested sub-dispatches, to a run. */
  async dispatch<T>(runId: string, callId: unknown, execute: () => Promise<T>): Promise<T> {
    let ledger = this.runs.get(runId)
    if (!ledger) { ledger = new Map(); this.runs.set(runId, ledger) }
    // A call outliving release keeps its own ledger object and cannot resurrect the run's entry.
    const call: Call = { ledger, tokens: new Set() }
    this.calls.set(callId, call)
    try { return await execute() } finally {
      this.calls.delete(callId)
      for (const token of call.tokens) this.tokens.delete(token)
    }
  }
  /** Drop a run's observations once it reaches a terminal state. */
  release(runId: string): void { this.runs.delete(runId) }
  /** Whether a run still holds a ledger; diagnostics and tests only. */
  holds(runId: string): boolean { return this.runs.has(runId) }
  /** The installed observation policy fiber, wherever it sits in the slot. Tracks its
   * incarnation only; deciding still requires it to be right behind this module. */
  private installedPolicy(): object | undefined {
    return (this.ctx.events._hooks['fs/write-intent'] ?? []).find(hook => hook.ctx?.fiber?.name === OBSERVATION_POLICY_PLUGIN)?.ctx?.fiber
  }
  /** Move this module's intent listeners right in front of the policy's. Listeners
   * registered ahead of the policy still run first: a wrapper wraps the decision, and
   * a foreign decider keeps deciding. A dispatch already under way keeps its order. */
  private seat(): void {
    for (const name of ['fs/write-intent', 'fs/edit-intent'] as const) {
      const hooks = this.ctx.events._hooks[name]
      if (!hooks) continue
      const own = hooks.findIndex(hook => hook.ctx?.fiber === this.ctx.fiber)
      const policy = hooks.findIndex(hook => hook.ctx?.fiber?.name === OBSERVATION_POLICY_PLUGIN)
      if (own < 0 || policy < 0 || own === policy - 1) continue
      const [record] = hooks.splice(own, 1)
      hooks.splice(own < policy ? policy - 1 : policy, 0, record!)
    }
  }
  /** The observation policy fiber holding the slot right behind this module, if any. */
  private slotPolicy(name: IntentName | 'fs/observed'): object | undefined {
    const hooks = this.ctx.events._hooks[name] ?? [], own = hooks.findIndex(hook => hook.ctx?.fiber === this.ctx.fiber)
    const fiber = own < 0 ? undefined : hooks[own + 1]?.ctx?.fiber
    return fiber?.name === OBSERVATION_POLICY_PLUGIN ? fiber : undefined
  }
  /** Track the policy incarnation; a reloaded policy cleared its state, so ours restarts too. */
  private sync(fiber: object | undefined): void {
    if (!fiber || fiber === this.policy) return
    // Clear in place: an active call and its run keep sharing one registered ledger.
    if (this.policy) { for (const ledger of this.runs.values()) ledger.clear(); for (const call of this.calls.values()) call.ledger.clear() }
    this.conversations = new WeakMap(); this.born = new WeakSet()
    this.policy = fiber; this.policyFresh = true
  }
  private callFor(actor: ObservationActor): Call | undefined {
    const call = (actor?.callId !== undefined ? this.calls.get(actor.callId) : undefined) ?? (actor?.parent !== undefined ? this.tokens.get(actor.parent) : undefined)
    if (call && actor?.token !== undefined) { call.tokens.add(actor.token); this.tokens.set(actor.token, call) }
    return call
  }
  private conversation(actor: ObservationActor): Conversation | undefined {
    const owner = actor?.agent?.session
    if (typeof owner !== 'object' || owner === null) return undefined
    let state = this.conversations.get(owner)
    if (!state) { state = { observed: new Map(), tainted: new Set(), complete: this.policyFresh || this.born.has(owner) }; this.conversations.set(owner, state) }
    return state
  }
  /** Decide from a ledger when the SDK policy holds the slot; otherwise leave the slot untouched. */
  /** The policy fiber behind this module in the snapshot of the dispatch that passed `next`. */
  private successor(name: IntentName, actor: ObservationActor, next: Next): object | undefined {
    const pending = actor ? this.snapshots.get(actor) : undefined
    const index = pending?.findIndex(entry => entry.args[entry.args.length - 1] === next) ?? -1
    return index < 0 ? this.slotPolicy(name) : pending!.splice(index, 1)[0]!.successor
  }
  private decision(name: IntentName, target: ObservedTarget, actor: ObservationActor, next: Next): { prior: Observation | undefined } | undefined {
    this.sync(this.installedPolicy())
    if (!this.successor(name, actor, next)) return undefined
    const call = this.callFor(actor)
    if (call) return { prior: call.ledger.get(target.targetKey) }
    const state = this.conversation(actor)
    if (!state?.tainted.has(target.targetKey)) return undefined
    const prior = state.observed.get(target.targetKey)
    // Unrecorded history is not "never observed": require a fresh read instead of guessing.
    return { prior: prior ?? (state.complete ? undefined : { kind: 'present', version: UNRECORDED_OBSERVATION }) }
  }
  private async writeIntent(target: ObservedTarget, actor: ObservationActor, next: Next): Promise<unknown> {
    const decided = this.decision('fs/write-intent', target, actor, next)
    if (!decided) return next()
    const prior = decided.prior
    return prior?.kind === 'present' ? { kind: 'replaceIfVersion', version: prior.version } : { kind: 'createIfAbsent' }
  }
  private async editIntent(target: ObservedTarget, actor: ObservationActor, next: Next): Promise<unknown> {
    const decided = this.decision('fs/edit-intent', target, actor, next)
    if (!decided) return next()
    const prior = decided.prior
    if (prior?.kind === 'present') return { version: prior.version }
    // Let the policy itself reject an ownerless actor, then reuse its error class
    // so tool-fs remediation still recognizes the failure.
    let unobserved: Error
    try { await this.ctx.waterfall('fs/edit-intent', target, { signal: actor?.signal }, () => undefined); return next() }
    catch (error) {
      if ((error as { code?: unknown })?.code !== 'FS_NOT_OBSERVED') throw error
      unobserved = error as Error
    }
    if (!prior) throw unobserved
    throw new (unobserved.constructor as ErrorClass)(`cannot edit "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  }
  private observe(target: ObservedTarget, observation: Observation, actor: ObservationActor): void {
    this.sync(this.installedPolicy())
    const call = this.callFor(actor), state = this.conversation(actor)
    if (call) {
      call.ledger.set(target.targetKey, observation)
      // The SDK gate records this run observation under the conversation session too.
      state?.tainted.add(target.targetKey)
      return
    }
    if (!state) return
    state.observed.set(target.targetKey, observation)
    // The SDK entry is the conversation's own again; let the gate decide.
    state.tainted.delete(target.targetKey)
  }
}
