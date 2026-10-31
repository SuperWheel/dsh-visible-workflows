/** Offline partitioning and read-only journal merging. Never constructs a provider. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { jsonDigest } from '../../src/shared/planning-repair.ts';
import { arms, freezePair, pairedSchedule, slotKey, validateFrozenPair, type FrozenPair, type PairConfig, type PairedCase, type PairResult, type Slot } from './template-fill-paired.ts';

const caseKey = (item: PairedCase) => `${item.sourceLayer ?? 'direct'}:${item.id}`;
const resultCaseKey = (slot: Slot) => `${slot.sourceLayer}:${slot.caseId}`;
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** A process may need multiple rectangular configs to balance arbitrary case counts. */
export function partitionPairConfig(base: PairConfig, count: number): PairConfig[][] {
  freezePair(base);
  const total = base.cases.length * base.repeats;
  assert.ok(Number.isSafeInteger(count) && count > 0 && count <= total, 'Shard count must be between 1 and the number of case/repeat pairs');
  const shards: PairConfig[][] = [];
  let offset = 0;
  for (let shard = 0; shard < count; shard++) {
    let remaining = Math.floor(total / count) + (shard < total % count ? 1 : 0);
    const parts: PairConfig[] = [];
    while (remaining) {
      const index = Math.floor(offset / base.repeats);
      const repeat = offset % base.repeats;
      const repeats = Math.min(remaining, base.repeats - repeat);
      const part = structuredClone(base);
      part.firstRepeat = (base.firstRepeat ?? 0) + repeat;
      part.repeats = repeats;
      part.cases = [structuredClone(base.cases[index]!)];
      // Selection must not reset the index used by AB/BA alternation.
      part.cases[0]!.scheduleIndex = base.cases[index]!.scheduleIndex ?? index;
      parts.push(part);
      offset += repeats;
      remaining -= repeats;
    }
    shards.push(parts);
  }
  return shards;
}

export interface ShardPlan {
  schema: 1;
  base: PairConfig;
  shards: { config: string; out: string }[][];
}

export function writePairShards(base: PairConfig, count: number, directory: string): { plan: ShardPlan; commands: string[] } {
  const shards = partitionPairConfig(base, count);
  const root = resolve(directory);
  mkdirSync(root, { mode: 0o700 });
  const plan: ShardPlan = { schema: 1, base: structuredClone(base), shards: [] };
  for (const [index, parts] of shards.entries()) {
    plan.shards.push(parts.map((part, partIndex) => {
      const name = `shard-${index + 1}${parts.length > 1 ? `-part-${partIndex + 1}` : ''}`;
      const config = join(root, `${name}.json`), out = join(root, name);
      writeFileSync(config, JSON.stringify(part, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      return { config, out };
    }));
  }
  writeFileSync(join(root, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return {
    plan,
    commands: plan.shards.map(parts => parts.map(part => `npm run bench:template-paired -- --run ${shellQuote(`--config=${part.config}`)} ${shellQuote(`--out=${part.out}`)}`).join(' && '))
  };
}

function commonDefinition({ cases: _cases, firstRepeat: _firstRepeat, repeats: _repeats, ...common }: PairConfig) {
  return common;
}

function caseDefinition({ scheduleIndex: _scheduleIndex, ...item }: PairedCase) {
  return item;
}

/** Verify the chain without acquiring a writer lock or truncating unfinished logs. */
function readShardResults(directory: string, frozen: FrozenPair): PairResult[] {
  const schedule = new Map(pairedSchedule(frozen).map(slot => [slotKey(slot), slot]));
  const bytes = readFileSync(join(directory, 'events.jsonl'), 'utf8');
  assert.ok(!bytes || bytes.endsWith('\n'), 'Incomplete journal tail');
  let previous = '', sequence = 0;
  const results = new Map<string, PairResult>();
  for (const raw of bytes.split('\n').filter(Boolean)) {
    const line = JSON.parse(raw);
    const { digest, ...payload } = line;
    assert.equal(line.sequence, ++sequence, 'Journal sequence changed');
    assert.equal(line.previous, previous, 'Journal chain changed');
    assert.equal(line.manifestDigest, frozen.digest, 'Journal manifest changed');
    assert.equal(jsonDigest(payload), digest, 'Journal row changed');
    previous = digest;
    const event = line.event;
    assert.ok(['result', 'call-start', 'call-end', 'duration'].includes(event.kind), 'Unknown journal event');
    const slot: Slot = event.kind === 'result' ? event.result : event.slot;
    const key = slotKey(slot);
    assert.deepEqual(schedule.get(key), { sourceLayer: slot.sourceLayer, caseId: slot.caseId, repeat: slot.repeat, arm: slot.arm, position: slot.position }, 'Unknown journal slot');
    assert.ok(!results.has(key), `Duplicate result or event after result: ${key}`);
    if (event.kind === 'result') {
      assert.ok(['success', 'failed', 'timeout', 'interrupted', 'not-run', 'harness-invalid'].includes(event.result.status), 'Invalid result status');
      results.set(key, event.result);
    }
  }
  assert.equal(results.size, schedule.size, `Gap in shard results: ${directory}`);
  return [...results.values()];
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const known = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0;
const ratio = (a: number | null, b: number | null) => known(a) && a! > 0 && known(b) ? b! / a! : null;

/** The T09 merge.py field names, with missing observations preserved as null. */
export function summarizeShardResults(results: PairResult[]) {
  const armSummary = Object.fromEntries(arms.map(arm => {
    const rows = results.filter(row => row.arm === arm), valid = rows.filter(row => row.status !== 'harness-invalid'), successes = valid.filter(row => row.status === 'success');
    const sum = (field: 'repairs' | 'requests' | 'submissions') => rows.reduce((total, row) => total + row[field], 0);
    const cost = (field: 'designWallMs' | 'totalWallMs') => successes.length && valid.every(row => known(row.timing[field]))
      ? valid.reduce((total, row) => total + row.timing[field]!, 0) / successes.length : null;
    const tokens = rows.map(row => row.usage.reportedTokens).filter((value): value is number => value !== null);
    return [arm, {
      attempts: valid.length, success: successes.length,
      ...(valid.length < rows.length ? { harnessInvalid: rows.length - valid.length } : {}),
      statuses: Object.fromEntries([...new Set(rows.map(row => row.status))].map(status => [status, rows.filter(row => row.status === status).length])),
      repairs: sum('repairs'), requests: sum('requests'), submissions: sum('submissions'),
      reportedTokens: tokens.length ? tokens.reduce((total, value) => total + value, 0) : null,
      knownCalls: rows.reduce((total, row) => total + row.usage.knownCalls, 0),
      unknownCalls: rows.reduce((total, row) => total + row.usage.unknownCalls, 0),
      designWallPerSuccessMs: cost('designWallMs'), totalWallPerSuccessMs: cost('totalWallMs'),
      medianDesignWallSuccessMs: successes.every(row => known(row.timing.designWallMs)) ? median(successes.map(row => row.timing.designWallMs!)) : null
    }];
  }));
  const caseKeys = [...new Set(results.map(resultCaseKey))];
  const multipleLayers = new Set(results.map(row => row.sourceLayer)).size > 1;
  const label = (row: Slot) => multipleLayers ? resultCaseKey(row) : row.caseId;
  const cases = Object.fromEntries(caseKeys.map(key => {
    const rows = results.filter(row => resultCaseKey(row) === key);
    return [label(rows[0]!), {
      ...Object.fromEntries(arms.map(arm => {
        const selected = rows.filter(row => row.arm === arm);
        return [arm, `${selected.filter(row => row.status === 'success').length}/${selected.filter(row => row.status !== 'harness-invalid').length}`];
      })),
      failures: rows.filter(row => row.status !== 'success' && row.status !== 'harness-invalid').map(row => `${row.arm} r${row.repeat} ${row.status}: ${String(row.reason).slice(0, 80)}`),
      ...(rows.some(row => row.status === 'harness-invalid') ? { harnessInvalid: rows.filter(row => row.status === 'harness-invalid').map(row => `${row.arm} r${row.repeat}: ${row.reason}`) } : {})
    }];
  }));
  const pairs: { case: string; repeat: string; crMs: number | null; tfMs: number | null; ratio: number | null }[] = [];
  const designRatios: number[] = [], totalRatios: number[] = [];
  const bySlot = new Map(results.map(row => [slotKey(row), row]));
  for (const compact of results.filter(row => row.arm === 'compact-repair' && row.status === 'success')) {
    const template = bySlot.get(slotKey({ ...compact, arm: 'template-fill' }));
    if (!template || template.status !== 'success') continue;
    const design = ratio(compact.timing.designWallMs, template.timing.designWallMs);
    const total = ratio(compact.timing.totalWallMs, template.timing.totalWallMs);
    if (design !== null) designRatios.push(design);
    if (total !== null) totalRatios.push(total);
    pairs.push({ case: label(compact), repeat: String(compact.repeat),
      crMs: known(compact.timing.designWallMs) ? Math.round(compact.timing.designWallMs!) : null,
      tfMs: known(template.timing.designWallMs) ? Math.round(template.timing.designWallMs!) : null,
      ratio: design === null ? null : Math.round(design * 1000) / 1000 });
  }
  return { attempts: results.length, arms: armSummary, cases, pairs, pairedSuccessful: pairs.length,
    pairedMedianDesignWallRatio: median(designRatios), pairedMedianTotalWallRatio: median(totalRatios) };
}

/** Base/plan is required: shard manifests alone cannot reveal a missing whole shard. */
export function mergePairShards(base: PairConfig, directories: string[]) {
  assert.ok(directories.length > 0, 'Provide shard output directories');
  const expected = freezePair(base);
  const slots = new Map(pairedSchedule(expected).map(slot => [slotKey(slot), slot]));
  const cases = new Map(expected.definition.cases.map((item, index) => [caseKey(item), { item, index: item.scheduleIndex ?? index }]));
  let common: ReturnType<typeof commonDefinition> | undefined;
  const results = new Map<string, PairResult>();
  for (const directory of directories) {
    const frozen: FrozenPair = readJson(join(directory, 'manifest.json'));
    validateFrozenPair(frozen);
    assert.equal(frozen.definition.model.provider, expected.definition.model.provider, 'Cannot mix providers');
    assert.equal(frozen.definition.model.model, expected.definition.model.model, 'Cannot mix models');
    common ??= commonDefinition(frozen.definition);
    assert.deepEqual(commonDefinition(frozen.definition), common, 'Shard model/limits/implementation hashes or definition mismatch');
    // The real runner replaces config hashes with its actual source hashes.
    const baseCommon = commonDefinition(expected.definition);
    if (!Object.keys(base.implementationHashes).length) baseCommon.implementationHashes = common.implementationHashes;
    assert.deepEqual(common, baseCommon, 'Shard definition differs from the base');
    for (const [index, item] of frozen.definition.cases.entries()) {
      const original = cases.get(caseKey(item));
      assert.ok(original, 'Unknown shard case');
      assert.deepEqual(caseDefinition(item), caseDefinition(original.item), 'Shard case definition changed');
      assert.equal((item.scheduleIndex ?? index) % 2, original.index % 2, 'Shard case arm order changed');
    }
    for (const result of readShardResults(directory, frozen)) {
      const key = slotKey(result);
      assert.ok(!results.has(key), `Duplicate case/repeat/arm: ${key}`);
      const { sourceLayer, caseId, repeat, arm, position } = result;
      assert.deepEqual(slots.get(key), { sourceLayer, caseId, repeat, arm, position }, 'Unexpected case/repeat/arm or arm order');
      results.set(key, result);
    }
  }
  assert.equal(results.size, slots.size, 'Gap in merged case/repeat/arm coverage');
  return summarizeShardResults([...slots.keys()].map(key => results.get(key)!));
}

export function main(args = process.argv.slice(2)) {
  const [command, ...options] = args;
  if (!command || command === '--help') {
    console.log('Offline only. split --config=BASE.json --shards=N --out=NEW_DIRECTORY [--cases=id,...] [--repeats=N]\nmerge --plan=DIRECTORY/plan.json --out=SUMMARY.json SHARD_OUT...\nEach printed line is one process; run its parts sequentially. No model runs are launched.');
    return;
  }
  assert.ok(command === 'split' || command === 'merge', 'Use split or merge');
  const flags = new Map<string, string>(), directories: string[] = [];
  for (const option of options) {
    if (!option.startsWith('--')) { directories.push(option); continue; }
    const match = /^--([a-z]+)=(.+)$/.exec(option);
    assert.ok(match && !flags.has(match[1]!), 'Invalid or duplicate option');
    assert.ok((command === 'split' ? ['config', 'shards', 'out', 'cases', 'repeats'] : ['plan', 'out']).includes(match[1]!), 'Unknown option');
    flags.set(match[1]!, match[2]!);
  }
  assert.ok(flags.has('out'), 'Provide --out');
  if (command === 'split') {
    assert.ok(flags.has('config') && flags.has('shards') && !directories.length, 'Provide --config and --shards');
    const base: PairConfig = readJson(resolve(flags.get('config')!));
    if (flags.has('cases')) {
      const ids = flags.get('cases')!.split(',');
      assert.ok(new Set(ids).size === ids.length && ids.every(id => base.cases.some(item => item.id === id)), 'Unknown or duplicate case');
      // This selection defines a new base experiment; partitioning preserves its indices.
      base.cases = base.cases.filter(item => ids.includes(item.id));
    }
    if (flags.has('repeats')) base.repeats = Number(flags.get('repeats'));
    const { plan, commands } = writePairShards(base, Number(flags.get('shards')), flags.get('out')!);
    commands.forEach((line, index) => console.log(`# Process ${index + 1}\n${line}`));
    console.log(`# Merge after all processes finish:\nnode --import tsx scripts/benchmarks/template-paired-shards.ts merge ${shellQuote(`--plan=${resolve(flags.get('out')!, 'plan.json')}`)} ${shellQuote(`--out=${resolve(flags.get('out')!, 'combined-summary.json')}`)} ${plan.shards.flat().map(part => shellQuote(part.out)).join(' ')}`);
  } else {
    assert.ok(flags.has('plan'), 'Provide --plan to check complete coverage');
    const plan: ShardPlan = readJson(resolve(flags.get('plan')!));
    assert.equal(plan.schema, 1, 'Unknown shard plan');
    const summary = mergePairShards(plan.base, directories.map(directory => resolve(directory)));
    writeFileSync(resolve(flags.get('out')!), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(summary, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main();
