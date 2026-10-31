import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AntigravityPairProvider, agyUsage, agyVersion } from '../scripts/benchmarks/antigravity-paired-provider.ts';
import { freezePair, pairedSchedule, runPairArm, type PairConfig, type Slot } from '../scripts/benchmarks/template-fill-paired.ts';
import { runDurablePaired, PairJournal } from '../scripts/benchmarks/template-fill-paired-journal.ts';
import { greetingSubmission } from '../scripts/benchmarks/template-fill-paired-self-test.ts';

const executable = resolve('tests/fixtures/paired-agy/agy'), roots: string[] = [], providers: AntigravityPairProvider[] = [];
const config = (): PairConfig => JSON.parse(readFileSync('scripts/benchmarks/gemini-config.json', 'utf8'));
const slot: Slot = { sourceLayer: 'direct', caseId: 'greeting', repeat: 0, arm: 'compact-repair', position: 0 };
const body = () => ({ model: 'gemini-3.8-flash-high', messages: [{ role: 'system', content: 'Design only.' }, { role: 'user', content: 'Frozen task.' }],
  tools: [{ function: { name: 'structured_output', parameters: { type: 'object', properties: { submission: { type: 'object' } } } } }, { function: { name: 'planner_node_catalog', parameters: {} } }] });
function setup(scenario = 'success', outputs?: unknown[], timeoutMs = 3000) {
  const root = mkdtempSync('/tmp/paired-agy-test-'); roots.push(root);
  const plan = join(root, 'plan.json'), log = join(root, 'calls.jsonl');
  writeFileSync(plan, JSON.stringify({ scenario, outputs }));
  vi.stubEnv('FAKE_AGY_PLAN', plan); vi.stubEnv('FAKE_AGY_LOG', log);
  const provider = new AntigravityPairProvider({ executable, temporaryRoot: root, timeoutMs }); providers.push(provider);
  return { root, plan, provider, calls: () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}
afterEach(() => { providers.splice(0).forEach(provider => provider.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.unstubAllEnvs(); });

describe('offline Antigravity paired transport', () => {
  it.each(['success', 'structured', 'final-usage', 'finish'])('maps %s to unchanged submission arguments, native usage and observable timings', async scenario => {
    const output = greetingSubmission(slot.arm), { provider, calls } = setup(scenario, [output]);
    expect(agyVersion(executable)).toBe('1.4.5');
    const request = body(), response = await provider.request(request, slot);
    expect(response.error).toBeUndefined();
    expect(response.message?.tool_calls[0].function).toEqual({ name: 'structured_output', arguments: JSON.stringify(output) });
    expect(response.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, total_tokens: 17 });
    expect(response.firstDeltaMs).toBeGreaterThanOrEqual(0); expect(response.firstValidTextMs).toBe(response.firstDeltaMs);
    expect(response.requestMs).toBeGreaterThanOrEqual(response.firstDeltaMs!);
    const [call] = calls(), args: string[] = call.args;
    expect(call.entries).toEqual([]); expect(call.cwd).not.toBe(process.cwd());
    expect(args).toEqual(expect.arrayContaining(['--sandbox', '--disable-slash-commands', '--output-format', 'stream-json', '--print-timeout', '3000ms']));
    // agy 1.4.5 rejects --effort with a tiered model id; plan mode is a no-op without slash commands.
    expect(args).not.toContain('--effort'); expect(args).not.toContain('--mode');
    expect(args).not.toContain('--dangerously-skip-permissions'); expect(args).not.toContain('--continue');
    expect(args[args.indexOf('--json-schema') + 1]).toBe(JSON.stringify(request.tools[0]!.function.parameters));
    expect(args.at(-1)).toContain('[BEGIN SYSTEM MESSAGE]\n"Design only."'); expect(args.at(-1)).toContain('[BEGIN USER MESSAGE]\n"Frozen task."');
    provider.close(); expect(existsSync(call.cwd)).toBe(false);
  });

  it('continues the same isolated conversation for two compiler repair turns, sending only new feedback', async () => {
    const { provider, calls } = setup('success', [greetingSubmission(slot.arm, true),
      { submission: { mode: 'repair', draftRevision: 1, patches: [{ op: 'remove', path: '/title' }] } },
      { submission: { mode: 'repair', draftRevision: 2, patches: [{ op: 'add', path: '/title', value: 'fixed' }] } }]);
    const base = config(); base.repeats = 1; base.cases = base.cases.slice(0, 1);
    const result = await runPairArm(freezePair(base), slot, provider, async () => ({ passed: true }));
    expect(result).toMatchObject({ status: 'success', requests: 3, submissions: 3, repairs: 2 });
    expect(result.feedback).toHaveLength(2); expect(result.usage).toEqual({ reportedTokens: 51, knownCalls: 3, unknownCalls: 0 });
    for (const call of result.calls) {
      expect(call.providerRequestMs).toBeGreaterThan(0); expect(call.roundTripWallMs).toBeGreaterThanOrEqual(call.providerRequestMs!);
      expect(call.providerFirstDeltaMs).toBeGreaterThanOrEqual(0); expect(call.tokenUsage).toMatchObject({ totalTokens: 17 });
    }
    const log = calls(); expect(log).toHaveLength(3); expect(new Set(log.map(call => call.cwd)).size).toBe(1);
    for (const [index, call] of log.entries()) {
      expect(call.args).not.toContain('--dangerously-skip-permissions');
      if (!index) { expect(call.entries).toEqual([]); continue; }
      expect(call.args[call.args.indexOf('--conversation') + 1]).toBe(`fake-${call.cwd.split('/').at(-1)}`);
      expect(call.args.at(-1)).toContain('[BEGIN COMPILER FEEDBACK MESSAGE]');
      expect(call.args.at(-1)).not.toContain('[BEGIN SYSTEM MESSAGE]'); expect(call.args.at(-1)).not.toContain('Frozen task.');
      expect(call.args.at(-1)).toContain(`\\"draftRevision\\":${index}`);
    }
    const old = log[0].cwd;
    await provider.request(body(), { ...slot, arm: 'template-fill', position: 1 });
    expect(existsSync(old)).toBe(false); expect(calls()[3].entries).toEqual([]); expect(calls()[3].args).not.toContain('--conversation');
  });

  it.each(['tool', 'permission', 'stderr-permission', 'unknown-event', 'wrong-model', 'wrong-conversation', 'malformed'])('rejects %s as harness-invalid, persists it and excludes it from model success/failure', async scenario => {
    const { provider, root } = setup(scenario);
    const base = config(); base.repeats = 1; base.cases = base.cases.slice(0, 1);
    const frozen = freezePair(base), directory = join(root, 'journal');
    const report = await runDurablePaired(frozen, directory, () => provider, async () => { throw Error('oracle must not run'); });
    expect(report.results.every(row => row.status === 'harness-invalid' && row.submissions === 0 && row.reason?.startsWith('Antigravity harness-invalid:'))).toBe(true);
    expect(report.summary.groups.every(group => group.harnessInvalid === 1 && group.failed === 0 && group.attempted === 0 && group.successRate === null)).toBe(true);
    const resumed = new PairJournal(directory, frozen, true);
    try { expect([...resumed.results.values()].map(row => row.status)).toEqual(['harness-invalid', 'harness-invalid']); } finally { resumed.close(); }
  });

  it('times out offline, kills the process, records wall time and keeps unknown usage', async () => {
    const { provider } = setup('timeout', undefined, 150);
    const response = await provider.request(body(), slot);
    expect(response).toMatchObject({ timedOut: true, usage: null, firstDeltaMs: null }); expect(response.requestMs).toBeGreaterThanOrEqual(100);
    expect((await provider.request(body(), slot)).harnessInvalid).toBe(true);
  });

  it('preserves missing usage as unknown through the compiler', async () => {
    const { provider } = setup('missing-usage', [greetingSubmission(slot.arm)]);
    const base = config(); base.repeats = 1; base.cases = base.cases.slice(0, 1);
    const result = await runPairArm(freezePair(base), slot, provider, async () => ({ passed: true }));
    expect(result.status).toBe('success'); expect(result.calls[0]!.usage).toBeNull(); expect(result.usage).toEqual({ reportedTokens: null, knownCalls: 0, unknownCalls: 1 });
  });

  it('refuses an effort that contradicts the model tier without starting the CLI', async () => {
    const { root } = setup();
    const provider = new AntigravityPairProvider({ executable, model: 'gemini-3.8-flash-high', effort: 'max', temporaryRoot: root }); providers.push(provider);
    const response = await provider.request({ ...body(), model: 'gemini-3.8-flash-high' }, slot);
    expect(response.harnessInvalid).toBe(true); expect(response.error).toContain('model tier high differs'); expect(existsSync(process.env.FAKE_AGY_LOG!)).toBe(false);
  });

  it.each(['medium', 'low'])('maps configurable Gemini %s to the explicit CLI model', async variant => {
    const { root, calls } = setup(), model = `gemini-3.8-flash-${variant}`;
    const provider = new AntigravityPairProvider({ executable, model, temporaryRoot: root }); providers.push(provider);
    const response = await provider.request({ ...body(), model }, slot);
    expect(response.error).toBeUndefined(); expect(calls()[0].args).toEqual(expect.arrayContaining(['--model', model]));
  });

  it('records a CLI startup failure as harness-invalid without exposing raw diagnostics', async () => {
    const { root } = setup(), provider = new AntigravityPairProvider({ executable: join(root, 'missing-agy'), temporaryRoot: root }); providers.push(provider);
    expect(await provider.request(body(), slot)).toMatchObject({ harnessInvalid: true, error: 'Antigravity harness-invalid: CLI could not start', usage: null });
  });

  it('refuses cold transcript recovery instead of silently starting another conversation', async () => {
    const { provider } = setup(); const request = body();
    request.messages[1]!.content = JSON.stringify({ resumeProtocol: 'public-transcript-v1' });
    expect(await provider.request(request, slot)).toMatchObject({ harnessInvalid: true });
  });

  it('validates honest controls/model/version and freezes a separate experiment with unchanged cases/limits', () => {
    const base = config(), glm = JSON.parse(readFileSync('scripts/benchmarks/t09-config.json', 'utf8'));
    expect(base.cases).toEqual(glm.cases); expect(base.limits).toEqual(glm.limits); expect(base.repeats).toBe(glm.repeats);
    expect(freezePair(glm).digest).toBe('d548ad1563cea37809af5400ede5019a4bcf11704b572347a8003307c4436ae5');
    const frozen = freezePair(base); expect(frozen.digest).not.toBe(freezePair(glm).digest);
    expect(frozen.definition.model).toMatchObject({ provider: 'antigravity-cli', cliVersion: '1.4.5', temperature: null, maxOutputTokens: null });
    expect(pairedSchedule(frozen)).toHaveLength(48);
    for (const variant of ['medium', 'low']) expect(freezePair({ ...base, model: { ...base.model, model: `gemini-3.8-flash-${variant}` } }).digest).not.toBe(frozen.digest);
    expect(freezePair({ ...base, model: { ...base.model, cliVersion: '1.4.6' } }).digest).not.toBe(frozen.digest);
    for (const change of [{ temperature: 0.2 }, { maxOutputTokens: 8192 }, { cliVersion: undefined }, { model: 'glm-5.3-flash' }]) expect(() => freezePair({ ...base, model: { ...base.model, ...change } })).toThrow();
  });

  it('rejects malformed usage without inventing a zero or including unreported cache counts', () => {
    for (const usage of [undefined, {}, { total_tokens: 10 }, { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, total_tokens: 9 }]) expect(agyUsage(usage)).toBeNull();
    expect(agyUsage({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, total_tokens: 0 })).toMatchObject({ total_tokens: 0 });
  });
});
