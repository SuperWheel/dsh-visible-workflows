/** Explicit opt-in CLI. Default/help and --self-test never construct the credential bridge. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { cases, contextFor, oracle } from './workflow-compiler.ts';
import { freezePair, type PairConfig, type PairProvider, type ProviderResponse } from './template-fill-paired.ts';
import { runDurablePaired } from './template-fill-paired-journal.ts';
import { fixtureFeedback, greetingSubmission, pairedSelfTest } from './template-fill-paired-self-test.ts';
import { AntigravityPairProvider, agyVersion } from './antigravity-paired-provider.ts';

class ExistingPrivateBridge implements PairProvider {
  private readonly child;
  private pending: {
    resolve: (result: ProviderResponse) => void;
    timer: ReturnType<typeof setTimeout>;
  } | undefined;
  private closed = false;
  constructor() {
    this.child = spawn('python3', [resolve('scripts/benchmarks/provider-bridge.py')], { stdio: ['pipe', 'pipe', 'ignore'] });
    createInterface({ input: this.child.stdout }).on('line', line => {
      const pending = this.pending;
      if (!pending)
        return;
      clearTimeout(pending.timer);
      this.pending = undefined;
      try {
        assert.ok(Buffer.byteLength(line) < 8 * 1024 * 1024);
        const response: ProviderResponse = JSON.parse(line);
        if (response.error === 'TimeoutError') response.timedOut = true;
        pending.resolve(response);
      }
      catch {
        pending.resolve({ error: 'Invalid private bridge response' });
        this.child.kill();
      }
    });
    const failed = () => {
      this.closed = true;
      const pending = this.pending;
      this.pending = undefined;
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve({ error: 'Private bridge exited' });
      }
    };
    this.child.on('error', failed);
    this.child.on('exit', failed);
    this.child.stdin.on('error', failed);
  }
  request(body: Record<string, unknown>): Promise<ProviderResponse> {
    if (this.closed)
      return Promise.resolve({ error: 'Private bridge is closed' });
    assert.equal(this.pending, undefined, 'Serial requests only');
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        this.closed = true;
        this.child.kill();
        resolve({ error: 'Private bridge deadline exceeded', timedOut: true });
      }, 260000);
      this.pending = { resolve, timer };
      this.child.stdin.write(JSON.stringify(body) + '\n');
    });
  }
  close() {
    this.closed = true;
    this.child.stdin.end();
    this.child.kill();
  }
}

/** Hash the whole implementation tree, not a hand-maintained dependency subset. */
export function implementationHashes() {
  const paths: string[] = [];
  const collect = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile()) paths.push(path);
    }
  };
  for (const directory of ['src', 'scripts/benchmarks', 'runtime/graphon_bridge', 'runtime-assets']) collect(directory);
  paths.push('package.json', 'pnpm-lock.yaml', 'node_modules/@deepseek-ai/dsh-tools/package.json', 'node_modules/zod/package.json');
  return Object.fromEntries(paths.sort().map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
}

const fixtureProvider = (): PairProvider => ({
  async request(body, slot) {
    const feedback = fixtureFeedback(body);
    const args = feedback ? { submission: { mode: 'repair', draftRevision: JSON.parse(feedback.content).draftRevision, patches: [{ op: 'add', path: '/title', value: '离线问候' }] } } : greetingSubmission(slot.arm, true);
    return { message: { role: 'assistant', tool_calls: [{ id: `${slot.arm}-${feedback ? 2 : 1}`, function: { name: 'structured_output', arguments: JSON.stringify(args) } }] }, usage: null };
  }
});

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--self-test') {
    console.log(JSON.stringify(await pairedSelfTest(), null, 2));
    return;
  }
  if (!args.includes('--run') && !args.includes('--fixture')) {
    console.log('No provider started. --self-test: local compiler + Graphon checks. --fixture --out=NEW_DIRECTORY [--repeat=N] [--resume]: durable no-model greeting fixture. Real experiment: --run --out=NEW_DIRECTORY [--repeat=N] [--cases=greeting,sum,...] [--config=CONFIG.json] [--resume]. ZAI or Antigravity starts only with --run, after manifest validation. Gemini requires --config=scripts/benchmarks/gemini-config.json and is a separate experiment.');
    return;
  }
  for (const arg of args)
    assert.ok(['--run', '--fixture', '--resume'].includes(arg) || /^--(?:out|repeat|cases|config)=/.test(arg), 'Unknown argument');
  assert.ok(!(args.includes('--run') && args.includes('--fixture')), 'Choose fixture or real provider');
  const outputArg = args.find(arg => arg.startsWith('--out='))?.slice(6);
  assert.ok(outputArg, 'Runs require an explicit --out directory');
  const fixture = args.includes('--fixture');
  const repeats = Number(args.find(arg => arg.startsWith('--repeat='))?.slice(9) ?? '2');
  const selectedIds = args.find(arg => arg.startsWith('--cases='))?.slice(8).split(',') ?? (fixture ? ['greeting'] : cases.map(item => item.id));
  assert.ok(selectedIds.length && new Set(selectedIds).size === selectedIds.length && selectedIds.every(id => cases.some(item => item.id === id)), 'Unknown or duplicate case');
  const configPath = args.find(arg => arg.startsWith('--config='))?.slice(9);
  assert.ok(!configPath || !args.some(arg => /^--(?:repeat|cases)=/.test(arg)), 'Config controls its own cases and repeats');
  const config: PairConfig = configPath ? JSON.parse(readFileSync(resolve(configPath), 'utf8')) : {
    repeats,
    model: { provider: fixture ? 'offline-fixture' : 'zai-coding-cn', model: fixture ? 'not-a-provider' : 'glm-5.3-flash', reasoningEffort: 'max', temperature: 0.2, maxOutputTokens: 8192 },
    limits: { maxModelRequests: 8, maxSubmissions: 3, maxCatalogCalls: 20 },
    cases: selectedIds.map(id => {
      const item = cases.find(item => item.id === id)!;
      return { id: item.id, instruction: item.instruction, context: contextFor(item), samples: item.samples };
    }),
    implementationHashes: {}
  };
  const antigravity = !fixture && config.model.provider === 'antigravity-cli';
  assert.ok(fixture ? config.model.provider === 'offline-fixture' && config.cases.every(item => item.id === 'greeting') : antigravity || config.model.provider === 'zai-coding-cn' && config.model.model === 'glm-5.3-flash', 'Transport does not support the configured provider/model');
  freezePair(config); // Validate before even querying CLI metadata.
  if (antigravity) assert.equal(agyVersion(), config.model.cliVersion, 'agy version differs from config; freeze the installed version explicitly');
  // Freeze actual source and transitive local implementation on every invocation;
  // resume compares it with the immutable on-disk manifest before bridge creation.
  config.implementationHashes = implementationHashes();
  const frozen = freezePair(config);
  const report = await runDurablePaired(frozen, resolve(outputArg), fixture ? fixtureProvider : antigravity ? () => new AntigravityPairProvider({ model: config.model.model, effort: config.model.reasoningEffort }) : () => new ExistingPrivateBridge(), async (flow, item) => oracle(flow, item), {
    resume: args.includes('--resume'),
    onResult: result => { console.log(JSON.stringify({ sourceLayer: result.sourceLayer, caseId: result.caseId, repeat: result.repeat, arm: result.arm, status: result.status, requests: result.requests })); }
  });
  console.log(JSON.stringify({ manifestDigest: report.manifestDigest, summary: report.summary }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
