import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cases, contextFor } from '../scripts/benchmarks/workflow-compiler.ts';
import { jsonDigest } from '../src/shared/planning-repair.ts';
import { freezePair, pairedSchedule, skipped, slotKey, validateFrozenPair, type FrozenPair, type PairConfig, type PairResult } from '../scripts/benchmarks/template-fill-paired.ts';
import { main, mergePairShards, partitionPairConfig, summarizeShardResults, writePairShards, type ShardPlan } from '../scripts/benchmarks/template-paired-shards.ts';
import { PairJournal } from '../scripts/benchmarks/template-fill-paired-journal.ts';

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn(() => { throw Error('No external processes in shard tests'); }) }));

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks(); });
const temporary = () => { const root = mkdtempSync('/tmp/template-paired-shards-'); roots.push(root); return root; };
const config = (count = 1, repeats = 5): PairConfig => ({
  repeats,
  model: { provider: 'offline-fixture', model: 'no-model', reasoningEffort: 'high', temperature: 0.2, maxOutputTokens: 8192 },
  limits: { maxModelRequests: 3, maxSubmissions: 3, maxCatalogCalls: 3 },
  implementationHashes: { fixture: 'a'.repeat(64) },
  cases: cases.slice(0, count).map(item => ({ id: item.id, instruction: item.instruction, context: contextFor(item), samples: item.samples }))
});
const resultFor = (slot: ReturnType<typeof pairedSchedule>[number]): PairResult => ({
  ...skipped(slot, 'offline result fixture'), status: 'success', reason: null,
  requests: 2, repairs: 1, submissions: 2,
  timing: { ...skipped(slot, '').timing, designWallMs: slot.arm === 'compact-repair' ? 100 : 50, totalWallMs: slot.arm === 'compact-repair' ? 200 : 120 },
  usage: { reportedTokens: 10, knownCalls: 1, unknownCalls: 1 }
});

function writeResults(directory: string, frozen: FrozenPair, results = pairedSchedule(frozen).map(resultFor)) {
  mkdirSync(directory);
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(frozen));
  let previous = '';
  const lines = results.map((result, index) => {
    const payload = { at: 1, sequence: index + 1, previous, manifestDigest: frozen.digest, event: { kind: 'result', result }, previousPersistMs: null };
    previous = jsonDigest(payload);
    return JSON.stringify({ ...payload, digest: previous });
  });
  writeFileSync(join(directory, 'events.jsonl'), lines.join('\n') + '\n');
}

function fixture(base = config(), count = 5) {
  const root = temporary();
  const parts = partitionPairConfig(base, count).flat();
  const directories = parts.map((part, index) => {
    const directory = join(root, `out-${index}`);
    writeResults(directory, freezePair(part));
    return directory;
  });
  return { base, directories, parts, root };
}

describe('absolute paired repeat scheduling', () => {
  it('preserves the HEAD c2774c8 T09 manifest digest for absent and zero firstRepeat', () => {
    const base: PairConfig = JSON.parse(readFileSync('scripts/benchmarks/t09-config.json', 'utf8'));
    const digest = 'd548ad1563cea37809af5400ede5019a4bcf11704b572347a8003307c4436ae5';
    expect(freezePair(base).digest).toBe(digest);
    const zero = freezePair({ ...base, firstRepeat: 0 });
    expect(zero.digest).toBe(digest);
    expect(zero.definition).not.toHaveProperty('firstRepeat');
    validateFrozenPair(zero);
  });

  it('uses absolute repeats and the same arm order as a full schedule', () => {
    const base = config(3);
    const full = pairedSchedule(freezePair(base));
    const selected = pairedSchedule(freezePair({ ...base, firstRepeat: 2, repeats: 1 }));
    expect(selected).toEqual(full.filter(slot => slot.repeat === 2));
    const union = [0, 2, 3].flatMap((firstRepeat, index) => pairedSchedule(freezePair({ ...base, firstRepeat, repeats: [2, 1, 2][index]! })));
    expect(union).toEqual(full);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, null, '2'])('rejects invalid firstRepeat %s', firstRepeat => {
    expect(() => freezePair({ ...config(), firstRepeat: firstRepeat as number })).toThrow('Invalid firstRepeat');
  });

  it('validates original case indices', () => {
    for (const index of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const base = config(); base.cases[0]!.scheduleIndex = index;
      expect(() => freezePair(base)).toThrow('Invalid case scheduleIndex');
    }
  });

  it('persists absolute repeat labels and resumes without changing the manifest', () => {
    const frozen = freezePair({ ...config(), firstRepeat: 2, repeats: 1 });
    const directory = join(temporary(), 'journal');
    const journal = new PairJournal(directory, frozen);
    try { pairedSchedule(frozen).map(resultFor).forEach(result => journal.complete(result)); }
    finally { journal.close(); }
    const resumed = new PairJournal(directory, frozen, true);
    try {
      expect([...resumed.results.values()].map(result => result.repeat)).toEqual([2, 2]);
      expect(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))).toEqual(frozen);
    } finally { resumed.close(); }
  });
});

describe('offline shard writer', () => {
  it('balances all pair counts while preserving coverage, absolute repeats and original case parity', () => {
    for (let caseCount = 1; caseCount <= 4; caseCount++) {
      for (let repeats = 1; repeats <= 5; repeats++) {
        const base = { ...config(caseCount, repeats), firstRepeat: 2 };
        const full = pairedSchedule(freezePair(base));
        for (let count = 1; count <= caseCount * repeats; count++) {
          const shards = partitionPairConfig(base, count);
          const loads = shards.map(parts => parts.reduce((total, part) => total + part.cases.length * part.repeats, 0));
          expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(1);
          const scheduled = shards.flat().flatMap(part => pairedSchedule(freezePair(part)));
          expect(scheduled).toHaveLength(full.length);
          expect(new Map(scheduled.map(slot => [slotKey(slot), slot]))).toEqual(new Map(full.map(slot => [slotKey(slot), slot])));
          for (const part of shards.flat()) {
            const { cases: _cases, firstRepeat: _firstRepeat, repeats: _repeats, ...other } = part;
            const { cases: _baseCases, firstRepeat: _baseFirst, repeats: _baseRepeats, ...baseOther } = base;
            expect(other).toEqual(baseOther);
          }
        }
      }
    }
  });

  it('writes five single-repeat web-process configs and commands without running anything', () => {
    const directory = join(temporary(), "shards with 'quotes'");
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    main(['split', '--config=scripts/benchmarks/t09-config.json', '--cases=web-process', '--repeats=5', '--shards=5', `--out=${directory}`]);
    const plan: ShardPlan = JSON.parse(readFileSync(join(directory, 'plan.json'), 'utf8'));
    expect(plan.shards).toHaveLength(5);
    expect(plan.base.cases.map(item => item.id)).toEqual(['web-process']);
    plan.shards.forEach((parts, index) => {
      expect(parts).toHaveLength(1);
      const part = JSON.parse(readFileSync(parts[0]!.config, 'utf8'));
      expect(part).toMatchObject({ cases: [{ id: 'web-process', scheduleIndex: 0 }], firstRepeat: index, repeats: 1 });
      expect(log.mock.calls[index]![0]).toContain('npm run bench:template-paired -- --run');
      expect(log.mock.calls[index]![0]).toContain("'\\''");
    });
  });

  it('writes multiple sequential configs only when a balanced process crosses a case boundary', () => {
    const { plan, commands } = writePairShards(config(3, 3), 2, join(temporary(), 'shards'));
    expect(plan.shards).toHaveLength(2);
    expect(plan.shards.map(parts => parts.length)).toEqual([2, 2]);
    expect(commands.every(command => command.includes(' && '))).toBe(true);
    expect(plan.shards.flat().map(part => JSON.parse(readFileSync(part.config, 'utf8')).repeats)).toEqual([3, 2, 1, 3]);
  });

  it.each([0, -1, 1.5, 6])('rejects impossible shard counts %s', count => {
    const directory = join(temporary(), 'shards');
    expect(() => writePairShards(config(), count, directory)).toThrow('Shard count');
  });
});

describe('strict shard merge', () => {
  it('splits and merges Gemini separately, excluding harness-invalid from model denominators and costs', () => {
    const base: PairConfig = JSON.parse(readFileSync('scripts/benchmarks/gemini-config.json', 'utf8'));
    const { directories, root, parts } = fixture(base, 4);
    expect(mergePairShards(base, directories)).toMatchObject({ attempts: 48, pairedSuccessful: 24 });
    const frozen = freezePair(parts[0]!), rows = pairedSchedule(frozen).map(resultFor);
    rows[0]!.status = 'harness-invalid'; rows[0]!.reason = 'Antigravity harness-invalid: agent invoked a tool'; rows[0]!.timing.designWallMs = 99999;
    const replaced = join(root, 'invalid'); writeResults(replaced, frozen, rows);
    const summary = mergePairShards(base, [replaced, ...directories.slice(1)]);
    expect(summary.arms['compact-repair']).toMatchObject({ attempts: 23, success: 23, harnessInvalid: 1, designWallPerSuccessMs: 100, statuses: { success: 23, 'harness-invalid': 1 } });
    expect(summary.cases.greeting).toMatchObject({ 'compact-repair': '2/2', harnessInvalid: [expect.stringContaining('agent invoked a tool')] });
    expect(summary.pairedSuccessful).toBe(23);
  });

  it.each(['provider', 'model'])('refuses mixing Gemini and GLM or Gemini variants: %s', field => {
    const base: PairConfig = JSON.parse(readFileSync('scripts/benchmarks/gemini-config.json', 'utf8'));
    const { directories, root, parts } = fixture(base, 4), changed = structuredClone(parts[0]!);
    if (field === 'provider') changed.model = { provider: 'zai-coding-cn', model: 'glm-5.3-flash', reasoningEffort: 'max', temperature: 0.2, maxOutputTokens: 8192 };
    else changed.model.model = 'gemini-3.8-flash-low';
    const other = join(root, 'other'); writeResults(other, freezePair(changed));
    expect(() => mergePairShards(base, [other, ...directories.slice(1)])).toThrow(`Cannot mix ${field}s`);
  });

  it('matches the T09 metrics shape with absolute pairs and dynamic case denominators', () => {
    const { base, directories } = fixture();
    const summary = mergePairShards(base, directories.toReversed());
    expect(summary).toMatchObject({ attempts: 10, cases: { greeting: { 'compact-repair': '5/5', 'template-fill': '5/5', failures: [] } },
      pairedSuccessful: 5, pairedMedianDesignWallRatio: 0.5, pairedMedianTotalWallRatio: 0.6 });
    expect(summary.arms['compact-repair']).toEqual({ attempts: 5, success: 5, statuses: { success: 5 }, repairs: 5, requests: 10, submissions: 10,
      reportedTokens: 50, knownCalls: 5, unknownCalls: 5, designWallPerSuccessMs: 100, totalWallPerSuccessMs: 200, medianDesignWallSuccessMs: 100 });
    expect(summary.pairs.map(pair => pair.repeat)).toEqual(['0', '1', '2', '3', '4']);
    expect(summary.pairs[0]).toEqual({ case: 'greeting', repeat: '0', crMs: 100, tfMs: 50, ratio: 0.5 });
  });

  it('merges multi-case partitions without changing original case arm orders', () => {
    const { base, directories } = fixture({ ...config(3, 3), firstRepeat: 7 }, 2);
    expect(mergePairShards(base, directories)).toMatchObject({ attempts: 18, pairedSuccessful: 9 });
  });

  it('rejects a selected odd-index case whose original index was lost', () => {
    const { base, parts, directories, root } = fixture(config(2, 2), 2);
    const part = structuredClone(parts[1]!);
    delete part.cases[0]!.scheduleIndex;
    const changed = join(root, 'wrong-order'); writeResults(changed, freezePair(part));
    expect(() => mergePairShards(base, [directories[0]!, changed])).toThrow('Shard case arm order changed');
  });

  it('rejects extra absolute repeats outside the planned range', () => {
    const { base, parts, directories, root } = fixture();
    const extra = join(root, 'extra');
    writeResults(extra, freezePair({ ...parts[0]!, firstRepeat: 5 }));
    expect(() => mergePairShards(base, [...directories, extra])).toThrow('Unexpected case/repeat/arm');
  });

  it('rejects duplicate output directories and overlapping complete shards', () => {
    const { base, directories, root, parts } = fixture();
    expect(() => mergePairShards(base, [...directories, directories[0]!])).toThrow('Duplicate');
    const duplicate = join(root, 'duplicate'); writeResults(duplicate, freezePair(parts[0]!));
    expect(() => mergePairShards(base, [...directories, duplicate])).toThrow('Duplicate');
  });

  it('rejects missing whole shards, including the first and last repeat', () => {
    const { base, directories } = fixture();
    for (const missing of [0, 2, 4]) expect(() => mergePairShards(base, directories.filter((_, index) => index !== missing))).toThrow('Gap');
  });

  it('rejects missing and duplicate result events inside a shard', () => {
    const { base, parts, directories, root } = fixture();
    const frozen = freezePair(parts[0]!), results = pairedSchedule(frozen).map(resultFor);
    const missing = join(root, 'missing'); writeResults(missing, frozen, results.slice(1));
    expect(() => mergePairShards(base, [missing, ...directories.slice(1)])).toThrow('Gap');
    const duplicate = join(root, 'duplicate'); writeResults(duplicate, frozen, [...results, results[0]!]);
    expect(() => mergePairShards(base, [duplicate, ...directories.slice(1)])).toThrow('Duplicate');
  });

  it.each(['model', 'limits', 'implementationHashes', 'case'])('rejects mismatched %s even with valid new manifest/journal digests', field => {
    const { base, parts, directories, root } = fixture();
    const part = structuredClone(parts[1]!);
    if (field === 'model') part.model.temperature = 0.4;
    if (field === 'limits') part.limits.maxModelRequests = 4;
    if (field === 'implementationHashes') part.implementationHashes.fixture = 'b'.repeat(64);
    if (field === 'case') part.cases[0]!.instruction += ' changed';
    const changed = join(root, 'changed'); writeResults(changed, freezePair(part));
    expect(() => mergePairShards(base, [directories[0]!, changed, ...directories.slice(2)])).toThrow(/mismatch|definition changed/);
  });

  it('accepts runner-populated hashes for an empty base but still requires identical hashes across shards', () => {
    const { base, directories } = fixture();
    expect(mergePairShards({ ...base, implementationHashes: {} }, directories).attempts).toBe(10);
    expect(() => mergePairShards({ ...base, implementationHashes: { fixture: 'b'.repeat(64) } }, directories)).toThrow('differs from the base');
  });

  it('rejects corrupt manifests, corrupt journal chains and unterminated tails without modifying input files', () => {
    const { base, directories } = fixture();
    const path = join(directories[0]!, 'events.jsonl'), original = readFileSync(path, 'utf8');
    for (const bytes of [original.replace('"sequence":1', '"sequence":9'), original.replace('"requests":2', '"requests":9'), original.trimEnd()]) {
      writeFileSync(path, bytes);
      expect(() => mergePairShards(base, directories)).toThrow();
      expect(readFileSync(path, 'utf8')).toBe(bytes);
    }
    writeFileSync(path, original);
    const manifest = join(directories[0]!, 'manifest.json'), frozen = JSON.parse(readFileSync(manifest, 'utf8'));
    frozen.schedule[0].repeat = 99; writeFileSync(manifest, JSON.stringify(frozen));
    expect(() => mergePairShards(base, directories)).toThrow('Frozen experiment changed');
  });

  it('writes the summary via merge CLI using the plan for expected coverage', () => {
    const { base, directories, root } = fixture();
    const plan = join(root, 'plan.json'), output = join(root, 'combined.json');
    writeFileSync(plan, JSON.stringify({ schema: 1, base, shards: [] }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    main(['merge', `--plan=${plan}`, `--out=${output}`, ...directories]);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(mergePairShards(base, directories));
  });

  it('retains failure costs, unknown observations, and zero denominators', () => {
    const results = pairedSchedule(freezePair(config(1, 2))).map(resultFor);
    results[0]!.status = 'failed';
    const summary = summarizeShardResults(results);
    expect(summary.arms['compact-repair']!.designWallPerSuccessMs).toBe(200);
    expect(summary.pairedSuccessful).toBe(1);
    results.forEach(row => { row.usage.reportedTokens = null; row.timing.designWallMs = null; row.timing.totalWallMs = null; });
    const unknown = summarizeShardResults(results);
    expect(unknown.arms['compact-repair']).toMatchObject({ reportedTokens: null, designWallPerSuccessMs: null, totalWallPerSuccessMs: null });
    expect(unknown.pairs[0]!.ratio).toBeNull();
    expect(unknown.pairedMedianDesignWallRatio).toBeNull();
    expect(unknown.pairedMedianTotalWallRatio).toBeNull();
    results.forEach(row => { row.timing.designWallMs = 0; row.timing.totalWallMs = 0; });
    expect(summarizeShardResults(results).pairedMedianDesignWallRatio).toBeNull();
  });
});
