import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { cases, contextFor } from '../scripts/benchmarks/workflow-compiler.ts';
import { freezePair, pairedSchedule, runPairArm, runPaired, summarizePairs, type PairConfig, type PairProvider, type PairResult } from '../scripts/benchmarks/template-fill-paired.ts';
import { PairJournal, PairJournalError, runDurablePaired } from '../scripts/benchmarks/template-fill-paired-journal.ts';
import { fixtureFeedback, greetingSubmission } from '../scripts/benchmarks/template-fill-paired-self-test.ts';
import { main } from '../scripts/benchmarks/template-fill-paired-cli.ts';

// CLI routing is checked with a local oracle stub; the standalone self-test runs Graphon.
vi.mock('../scripts/benchmarks/workflow-compiler.ts', async original => ({ ...await original<typeof import('../scripts/benchmarks/workflow-compiler.ts')>(), oracle: async () => ({ passed: true }) }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn(() => { throw Error('External processes forbidden'); }) }));
const roots: string[] = [];
const directory = () => join(roots[roots.push(mkdtempSync('/private/tmp/t08-journal-')) - 1]!, 'experiment');
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const configuration = (): PairConfig => {
  const item = cases.find(row => row.id === 'greeting')!;
  return { repeats: 2, model: { provider: 'offline-fixture', model: 'not-a-provider', reasoningEffort: 'max', temperature: 0.2, maxOutputTokens: 8192 }, limits: { maxModelRequests: 3, maxSubmissions: 3, maxCatalogCalls: 3 }, cases: [{ ...item, context: contextFor(item) }], implementationHashes: { fixture: 'a'.repeat(64) } };
};
const oracle = async () => ({ passed: true });
function repairProvider() {
  return { request: vi.fn(async (body: Record<string, unknown>, slot: any) => {
    const feedback = fixtureFeedback(body);
    const args = feedback ? { submission: { mode: 'repair', draftRevision: JSON.parse(feedback.content).draftRevision, patches: [{ op: 'add', path: '/title', value: 'fixed' }] } } : greetingSubmission(slot.arm, true);
    return { message: { role: 'assistant', reasoning_content: 'PRIVATE-REASONING-MUST-NOT-PERSIST', tool_calls: [{ id: slot.arm + (feedback ? 2 : 1), function: { name: 'structured_output', arguments: JSON.stringify(args) } }] }, usage: feedback ? { total_tokens: 12, prompt_tokens: 8, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } } : null };
  }) } satisfies PairProvider;
}

describe('T08 durable no-model experiment', () => {
  it('resumes after a completed attempt; completed attempts and usage are not counted twice', async () => {
    const path = directory(), frozen = freezePair(configuration()), provider = repairProvider();
    await expect(runDurablePaired(frozen, path, () => provider, oracle, { onResult: () => { throw Error('fixture interruption'); } })).rejects.toThrow('fixture interruption');
    expect(provider.request).toHaveBeenCalledTimes(2);
    const before = readFileSync(join(path, 'events.jsonl'), 'utf8');
    expect(JSON.parse(before.trim().split('\n').at(-1)!).event.kind).toBe('result');
    const report = await runDurablePaired(frozen, path, () => provider, oracle, { resume: true });
    expect(provider.request).toHaveBeenCalledTimes(8);
    expect(report.results).toHaveLength(4);
    expect(report.results.every(row => row.repairs === 1 && row.submissions === 2)).toBe(true);
    expect(report.summary.groups.every(group => group.succeeded === 2 && group.reportedTokens === 24 && group.unknownUsageCalls === 2)).toBe(true);
    const factory = vi.fn(() => { throw Error('Must not construct provider'); });
    const final = await runDurablePaired(frozen, path, factory, oracle, { resume: true });
    expect(factory).not.toHaveBeenCalled();
    expect(final.results).toEqual(report.results);
    expect(readFileSync(join(path, 'events.jsonl'), 'utf8').startsWith(before)).toBe(true);
    expect(readFileSync(join(path, 'events.jsonl'), 'utf8')).not.toContain('PRIVATE-REASONING');
  });

  it('persists each completed call before processing, then replays it without transport or an extra repair allowance', async () => {
    const path = directory(), frozen = freezePair(configuration()), provider = repairProvider(), journal = new PairJournal(path, frozen);
    const slot = pairedSchedule(frozen)[0]!;
    try {
      await expect(runPairArm(frozen, slot, provider, oracle, {
        duration: journal.duration.bind(journal),
        request: async (...args) => { await journal.request(...args); throw new PairJournalError('fixture stop after receipt fsync'); }
      })).rejects.toThrow('fixture stop');
    } finally { journal.close(); }
    expect(provider.request).toHaveBeenCalledTimes(1);
    const rows = readFileSync(join(path, 'events.jsonl'), 'utf8').trim().split('\n').map(row => JSON.parse(row));
    expect(rows.filter(row => row.event.kind === 'call-end')).toHaveLength(1);
    const report = await runDurablePaired(frozen, path, () => provider, oracle, { resume: true });
    expect(provider.request).toHaveBeenCalledTimes(8);
    const resumedBody = provider.request.mock.calls[1]![0];
    expect((resumedBody.messages as any[]).slice(0, 2).map(message => message.role)).toEqual(['system', 'user']);
    expect(JSON.parse((resumedBody.messages as any[])[1].content).resumeProtocol).toBe('public-transcript-v1');
    expect((resumedBody.messages as any[])[1].content).not.toContain('PRIVATE-REASONING');
    expect(report.results[0]).toMatchObject({ status: 'success', requests: 2, submissions: 2, repairs: 1, usage: { reportedTokens: 12, knownCalls: 1, unknownCalls: 1 } });
    expect(report.results[0]!.calls[1]!.tokenUsage).toMatchObject({ inputTokens: 8, outputTokens: 4, cacheReadTokens: 2, reasoningTokens: null });
  });

  it('preserves original request bytes when replay omits private reasoning', async () => {
    const path = directory(), frozen = freezePair(configuration()), provider = repairProvider(), journal = new PairJournal(path, frozen);
    try {
      await expect(runPairArm(frozen, pairedSchedule(frozen)[0]!, provider, oracle, {
        duration: journal.duration.bind(journal),
        request: async (...args) => {
          const receipt = await journal.request(...args);
          if (args[2] === 2) throw new PairJournalError('fixture stop after second receipt');
          return receipt;
        }
      })).rejects.toThrow('second receipt');
    } finally { journal.close(); }
    const starts = readFileSync(join(path, 'events.jsonl'), 'utf8').trim().split('\n').map(row => JSON.parse(row).event).filter(row => row.kind === 'call-start');
    expect(starts).toHaveLength(2);
    const report = await runDurablePaired(frozen, path, () => provider, oracle, { resume: true });
    expect(provider.request).toHaveBeenCalledTimes(8);
    expect(report.results[0]!.calls.map(call => call.inputBytes)).toEqual(starts.map(row => row.payload.inputBytes));
    expect(report.results[0]!.calls.map(call => call.messageBytes)).toEqual(starts.map(row => row.payload.messageBytes));
    expect(report.results[0]!.resumed).toBe(true);
    expect(report.results[0]!.timing.totalWallMs).toBeNull();
  });

  it('cold-converts the next dispatch after two interruptions without replay marking a live continuation', async () => {
    const path = directory(), config = configuration(); config.repeats = 1;
    const frozen = freezePair(config), slot = pairedSchedule(frozen)[0]!;
    const bodies: Record<string, any>[] = [];
    const provider: PairProvider = { async request(body, current) {
      bodies.push(structuredClone(body));
      if ((body.messages as any[]).some(message => message.role === 'assistant' && !message.reasoning_content))
        return { error: 'Missing reasoning history', status: 400 };
      return { message: { role: 'assistant', reasoning_content: 'PRIVATE-REASONING-MUST-NOT-PERSIST',
        ...(bodies.length <= 2 ? { content: 'Continue designing' } : { tool_calls: [{ id: current.arm, function: { name: 'structured_output', arguments: JSON.stringify(greetingSubmission(current.arm)) } }] }) } };
    } };
    for (const stopAt of [1, 2]) {
      const journal = new PairJournal(path, frozen, stopAt > 1);
      try {
        await expect(runPairArm(frozen, slot, provider, oracle, {
          recovered: journal.recovered.bind(journal), duration: journal.duration.bind(journal),
          request: async (...args) => {
            const receipt = await journal.request(...args);
            if (args[2] === stopAt) throw new PairJournalError('fixture stop after receipt');
            return receipt;
          }
        })).rejects.toThrow('fixture stop');
      } finally { journal.close(); }
    }
    expect(bodies).toHaveLength(2);
    const report = await runDurablePaired(frozen, path, () => provider, oracle, { resume: true });
    expect(report.results.every(result => result.status === 'success' && !result.stopProvider)).toBe(true);
    expect(report.results[0]).toMatchObject({ requests: 3, resumed: true });
    expect(bodies).toHaveLength(4); // three unique calls for the resumed arm, one for the other arm
    expect(bodies[2]!.messages.map((message: any) => message.role)).toEqual(['system', 'user']);
    expect(JSON.parse(bodies[2]!.messages[1].content)).toMatchObject({ resumeProtocol: 'public-transcript-v1' });
    expect(readFileSync(join(path, 'events.jsonl'), 'utf8')).not.toContain('PRIVATE-REASONING');
  });

  it('does not reissue an admitted call with no durable receipt; preserves unknown duration and usage', async () => {
    const path = directory(), config = configuration(); config.repeats = 1;
    const frozen = freezePair(config), journal = new PairJournal(path, frozen), provider = repairProvider();
    try {
      await expect(runPairArm(frozen, pairedSchedule(frozen)[0]!, provider, oracle, {
        duration: journal.duration.bind(journal),
        request: (body, slot, index) => journal.request(body, slot, index, async () => { throw new PairJournalError('process disappeared'); })
      })).rejects.toThrow('process disappeared');
    } finally { journal.close(); }
    const report = await runDurablePaired(frozen, path, () => provider, oracle, { resume: true });
    expect(provider.request).toHaveBeenCalledTimes(2); // only the other arm
    expect(report.results[0]).toMatchObject({ status: 'interrupted', requests: 1, usage: { unknownCalls: 1 }, timing: { designWallMs: null, totalWallMs: null } });
    expect(report.results[0]!.calls[0]!.roundTripWallMs).toBeNull();
    expect(report.summary.groups[0]).toMatchObject({ failed: 1, interrupted: 1, unknownUsageCalls: 1 });
  });

  it.each(['model', 'effort', 'output', 'requirement', 'tools', 'repair', 'source', 'order'])('refuses a changed frozen %s before provider construction', async change => {
    const path = directory(), config = configuration();
    new PairJournal(path, freezePair(config)).close();
    if (change === 'model') config.model.model += '-changed';
    if (change === 'effort') config.model.reasoningEffort = 'low';
    if (change === 'output') config.model.maxOutputTokens--;
    if (change === 'requirement') config.cases[0]!.instruction += 'changed';
    if (change === 'tools') config.cases[0]!.context.tools.push({ id: 'changed' } as any);
    if (change === 'repair') config.limits.maxSubmissions--;
    if (change === 'source') config.implementationHashes.fixture = 'b'.repeat(64);
    if (change === 'order') config.repeats++;
    const factory = vi.fn(() => repairProvider());
    await expect(runDurablePaired(freezePair(config), path, factory, oracle, { resume: true })).rejects.toThrow('Frozen experiment changed');
    expect(factory).not.toHaveBeenCalled();
  });

  it('protects the frozen AB/BA order itself', () => {
    const frozen = structuredClone(freezePair(configuration()));
    frozen.schedule.reverse();
    expect(() => pairedSchedule(frozen)).toThrow('Frozen experiment changed');
  });

  it('recovers an unterminated tail but rejects complete corruption and a second live writer', async () => {
    const path = directory(), frozen = freezePair(configuration()), first = new PairJournal(path, frozen);
    expect(() => new PairJournal(path, frozen, true)).toThrow('live writer');
    first.close();
    appendFileSync(join(path, 'events.jsonl'), '{"torn":"中');
    const report = await runDurablePaired(frozen, path, repairProvider, oracle, { resume: true });
    expect(report.results.every(row => row.status === 'success')).toBe(true);
    appendFileSync(join(path, 'events.jsonl'), '{}\n');
    await expect(runDurablePaired(frozen, path, repairProvider, oracle, { resume: true })).rejects.toThrow('sequence changed');
  });

  it('recovers a dead local writer without removing an active writer lock', () => {
    const path = directory(), frozen = freezePair(configuration());
    new PairJournal(path, frozen).close();
    writeFileSync(join(path, 'writer.lock'), '99999999');
    const recovered = new PairJournal(path, frozen, true);
    expect(readFileSync(join(path, 'writer.lock'), 'utf8')).toBe(String(process.pid));
    recovered.close();
  });

  it('serializes concurrent stale-lock recovery so only one writer dispatches', async () => {
    // Run actual local Node workers; the provider is an append-only offline stub.
    const { spawn: spawnWorker } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const root = mkdtempSync('/private/tmp/t08-lock-race-'); roots.push(root);
    const path = join(root, 'experiment'), frozen = freezePair(configuration());
    new PairJournal(path, frozen).close();
    writeFileSync(join(path, 'writer.lock'), '99999999');
    const marker = (id: number, name: string) => join(root, `${id}-${name}`);
    const script = `
      import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      import { PairJournal } from './scripts/benchmarks/template-fill-paired-journal.ts';
      const [path, root, id] = process.argv.slice(1);
      const marker = name => root + '/' + id + '-' + name;
      const wait = name => { const deadline = Date.now() + 10000; while (!existsSync(marker(name))) {
        if (Date.now() > deadline) throw Error('Barrier timeout: ' + name);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      } };
      const probe = process.kill.bind(process);
      process.kill = (pid, signal) => { if (pid === 99999999) { writeFileSync(marker('probe'), ''); wait('release'); } return probe(pid, signal); };
      let journal;
      try {
        const frozen = JSON.parse(readFileSync(path + '/manifest.json', 'utf8'));
        journal = new PairJournal(path, frozen, true);
        await journal.request({ tools: [], messages: [{ role: 'system', content: 'fixture' }, { role: 'user', content: 'fixture' }] }, frozen.schedule[0], 1, async () => {
          appendFileSync(root + '/dispatches.log', id + '\\n'); return { message: { role: 'assistant', content: 'fixture' } };
        });
        writeFileSync(marker('acquired'), ''); wait('finish');
      } catch (error) { writeFileSync(marker('error'), error.message); }
      finally { journal?.close(); }
    `;
    const workers: ReturnType<typeof spawnWorker>[] = [];
    const exits: Promise<unknown>[] = [];
    const launch = (id: number) => {
      const worker = spawnWorker(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script, path, root, String(id)], { cwd: process.cwd(), stdio: 'ignore' });
      workers.push(worker);
      exits.push(new Promise((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject); }));
    };
    try {
      launch(1);
      await vi.waitFor(() => expect(existsSync(marker(1, 'probe'))).toBe(true), { timeout: 5000 });
      launch(2);
      await vi.waitFor(() => expect(existsSync(marker(2, 'probe')) || existsSync(marker(2, 'error'))).toBe(true), { timeout: 5000 });
      // Both old PID probes can observe the dead owner before the first replaces it.
      writeFileSync(marker(1, 'release'), '');
      await vi.waitFor(() => {
        if (existsSync(marker(1, 'error'))) throw Error(readFileSync(marker(1, 'error'), 'utf8'));
        expect(existsSync(marker(1, 'acquired'))).toBe(true);
      }, { timeout: 5000 });
      const writerPid = readFileSync(join(path, 'writer.lock'), 'utf8');
      writeFileSync(marker(2, 'release'), '');
      await vi.waitFor(() => expect(existsSync(marker(2, 'acquired')) || existsSync(marker(2, 'error'))).toBe(true), { timeout: 5000 });
      expect(existsSync(marker(2, 'acquired'))).toBe(false);
      expect(readFileSync(marker(2, 'error'), 'utf8')).toMatch(/recovery already in progress|live writer/);
      expect(readFileSync(join(path, 'writer.lock'), 'utf8')).toBe(writerPid);
      expect(readFileSync(join(root, 'dispatches.log'), 'utf8').trim().split('\n')).toEqual(['1']);
    } finally {
      for (const id of [1, 2]) for (const name of ['release', 'finish']) writeFileSync(marker(id, name), '');
      for (const worker of workers) if (worker.exitCode === null) worker.kill('SIGKILL');
      await Promise.all(exits);
    }
    const recovered = new PairJournal(path, frozen, true); // the one writer's hash chain is intact
    recovered.close();
  }, 20000);

  it('resumes the fail-stop policy without dispatching skipped attempts', async () => {
    const path = directory(), frozen = freezePair(configuration());
    const provider = { request: vi.fn(async () => ({ error: 'fixture auth denial', status: 401 })) };
    await expect(runDurablePaired(frozen, path, () => provider, oracle, { onResult: () => { throw Error('fixture stop'); } })).rejects.toThrow('fixture stop');
    const factory = vi.fn(() => { throw Error('Must not construct provider after denial'); });
    const report = await runDurablePaired(frozen, path, factory, oracle, { resume: true });
    expect(factory).not.toHaveBeenCalled();
    expect(provider.request).toHaveBeenCalledTimes(1);
    expect(report.results.map(row => row.status)).toEqual(['failed', 'not-run', 'not-run', 'not-run']);
    expect(report.results.slice(1).every(row => row.requests === 0 && row.calls.length === 0 && row.timing.totalWallMs === null)).toBe(true);
  });

  it('retains timeout, failure, repair and actual Tokens in the journal and failure-inclusive cost', async () => {
    const config = configuration(), path = directory();
    const provider = repairProvider();
    const report = await runDurablePaired(freezePair(config), path, () => ({ request: (body, slot) => slot.repeat === 0 && slot.arm === 'compact-repair' ? Promise.resolve({ error: 'fixture timeout', timedOut: true, usage: { total_tokens: 3 } }) : provider.request(body, slot) }), oracle);
    expect(report.results.map(row => row.status)).toEqual(['timeout', 'success', 'success', 'success']);
    expect(report.summary.groups[0]).toMatchObject({ attempted: 2, succeeded: 1, failed: 1, timedOut: 1, repairs: 1, reportedTokens: 15, knownUsageCalls: 2, unknownUsageCalls: 1 });
    const compact = report.results.filter(row => row.arm === 'compact-repair');
    expect(report.summary.groups[0]!.totalWallMsPerSuccessIncludingFailures).toBe(compact.reduce((sum, row) => sum + row.timing.totalWallMs!, 0));
    expect(report.summary.pairedSuccessfulCases).toBe(1);
    expect(report.summary.journalPersistence.durationMs).toBeGreaterThan(0);
  });

  it('imports Host spans without summing nested work or inventing CPU, queue and human timings', async () => {
    const config = configuration(); config.repeats = 1;
    const provider = repairProvider();
    const report = await runPaired(freezePair(config), { async request(body, slot) { return { ...await provider.request(body, slot), metrics: [{ phase: 'span:readiness', at: 1, durationMs: 20 }, { phase: 'span:optimization', at: 1, durationMs: 30 }, { phase: 'admission-wait', at: 1, durationMs: 2 }] }; } }, oracle);
    expect(report.results[0]!.metrics.some(row => row.phase === 'span:readiness' && row.durationMs === 20)).toBe(true);
    expect(report.results[0]!.metrics.some(row => row.phase === 'span:publish' && row.status === 'unknown')).toBe(true);
    expect(report.results[0]!.timing).toMatchObject({ admissionWaitMs: 4, humanWaitMs: null, modelGenerationMs: null });
    expect(report.results[0]!.calls[0]).toMatchObject({ providerQueueMs: null, providerPrefillMs: null });
  });

  it('stratifies direct and verified-trial and charges the same trial cost to both arms', async () => {
    const config = configuration(); config.repeats = 1;
    const verified = structuredClone(config.cases[0]!);
    verified.sourceLayer = 'verified-trial';
    verified.context.trial = { trialId: 'fixture-trial', rootSessionId: 'fixture-root', childSessionId: 'fixture-child', workspaceId: 'fixture-workspace', specDigest: 's', verificationDigest: 'v', evidenceDigest: 'e', receiptDigest: 'r' };
    verified.context.conversation = { fixture: true } as any;
    verified.context.trialTask = { fixture: true } as any;
    verified.trialUsage = { wallMs: 100, reportedTokens: 9, knownCalls: 1, unknownCalls: 2 };
    config.cases.push(verified);
    const provider = repairProvider();
    const report = await runPaired(freezePair(config), provider, oracle);
    expect(report.results).toHaveLength(4);
    const trialPrompts = provider.request.mock.calls.filter(([, slot]) => slot.sourceLayer === 'verified-trial').map(([body]) => JSON.parse((body.messages as any[])[1].content).source);
    expect(trialPrompts).toHaveLength(4);
    expect(trialPrompts.every(source => source.kind === 'verified-trial' && source.receipt.trialId === 'fixture-trial' && source.evidence.fixture)).toBe(true);
    // Deterministic synthetic durations verify arithmetic independently of host speed.
    for (const row of report.results) { row.timing.designWallMs = row.arm === 'compact-repair' ? 10 : 5; row.timing.totalWallMs = row.timing.designWallMs; }
    const summary = summarizePairs(report.results);
    expect(summary.groups).toEqual([]); // no mixed-layer performance claim
    expect(summary.layers.map(layer => layer.pairedSuccessfulCases)).toEqual([1, 1]);
    expect(summary.layers[0]!.pairedMedianDesignWallRatio).toBe(0.5);
    expect(summary.layers[1]!.pairedMedianDesignWallRatio).toBe(105 / 110);
    expect(summary.layers[1]!.groups.map(group => group.totalWallMsPerSuccessIncludingFailures)).toEqual([110, 105]);
    expect(summary.layers[1]!.groups.map(group => group.trialReportedTokens)).toEqual([9, 9]);
    expect(summary.layers[1]!.groups.map(group => group.trialUnknownUsageCalls)).toEqual([2, 2]);
    report.results.find(row => row.sourceLayer === 'verified-trial')!.trialUsage!.wallMs = null;
    expect(summarizePairs(report.results).layers[1]!.pairedMedianDesignWallRatio).toBeNull();
  });

  it('rejects a verified label without frozen Host provenance and cost', () => {
    const config = configuration(); config.cases[0]!.sourceLayer = 'verified-trial';
    expect(() => freezePair(config)).toThrow('Verified trial requires');
  });

  it.each([100, null])('includes trial wall %s in design cost per success including failures', async wallMs => {
    const report = await runPaired(freezePair(configuration()), repairProvider(), oracle);
    const rows = report.results.filter(row => row.arm === 'compact-repair');
    for (const row of rows) {
      row.sourceLayer = 'verified-trial';
      row.timing.designWallMs = 10;
      row.trialUsage = { wallMs, reportedTokens: null, knownCalls: 0, unknownCalls: 1 };
    }
    expect(summarizePairs(rows).groups[0]!.designWallMsPerSuccessIncludingFailures).toBe(wallMs === null ? null : 110);
    rows[1]!.status = 'failed';
    expect(summarizePairs(rows).groups[0]!.designWallMsPerSuccessIncludingFailures).toBe(wallMs === null ? null : 220);
  });

  it('CLI fixture creates and resumes durable results without constructing a credential bridge', async () => {
    const path = directory(), log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await main(['--fixture', `--out=${path}`, '--repeat=1']);
      const before = readFileSync(join(path, 'events.jsonl'), 'utf8');
      await main(['--fixture', `--out=${path}`, '--repeat=1', '--resume']);
      expect(readFileSync(join(path, 'events.jsonl'), 'utf8')).toBe(before);
      expect(JSON.parse(readFileSync(join(path, 'summary.json'), 'utf8')).groups.every((group: any) => group.succeeded === 1 && group.unknownUsageCalls === 2)).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});
