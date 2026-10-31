import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../scripts/benchmarks/template-fill-paired-cli.ts';
import { AntigravityPairProvider, agyVersion } from '../scripts/benchmarks/antigravity-paired-provider.ts';
import { runDurablePaired } from '../scripts/benchmarks/template-fill-paired-journal.ts';
import type { PairConfig } from '../scripts/benchmarks/template-fill-paired.ts';

vi.mock('../scripts/benchmarks/antigravity-paired-provider.ts', () => ({ agyVersion: vi.fn(() => '1.4.5'), AntigravityPairProvider: vi.fn(class { request = vi.fn(); }) }));
vi.mock('../scripts/benchmarks/template-fill-paired-journal.ts', () => ({ runDurablePaired: vi.fn(async (frozen, _directory, factory) => { factory(); return { manifestDigest: frozen.digest, summary: {} }; }) }));
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.clearAllMocks(); vi.restoreAllMocks(); });
it('routes an explicit Gemini run to the offline injected provider and freezes actual version/model', async () => {
  const root = mkdtempSync('/tmp/paired-agy-cli-'); roots.push(root); vi.spyOn(console, 'log').mockImplementation(() => {});
  await main(['--run', '--config=scripts/benchmarks/gemini-config.json', `--out=${join(root, 'out')}`]);
  expect(agyVersion).toHaveBeenCalledOnce(); expect(AntigravityPairProvider).toHaveBeenCalledWith({ model: 'gemini-3.8-flash-high', effort: 'high' });
  const frozen = vi.mocked(runDurablePaired).mock.calls[0]![0];
  expect(frozen.definition.model).toMatchObject({ cliVersion: '1.4.5', temperature: null, maxOutputTokens: null });
  expect(Object.keys(frozen.definition.implementationHashes)).toContain('scripts/benchmarks/antigravity-paired-provider.ts');
});
it('rejects a changed installed version before constructing a provider or starting a run', async () => {
  vi.mocked(agyVersion).mockReturnValueOnce('1.4.6');
  await expect(main(['--run', '--config=scripts/benchmarks/gemini-config.json', '--out=/tmp/unused-agy-output'])).rejects.toThrow('agy version differs');
  expect(AntigravityPairProvider).not.toHaveBeenCalled(); expect(runDurablePaired).not.toHaveBeenCalled();
});
it('retains the exact ZAI provider/model assertion and does not query agy for invalid configs', async () => {
  const root = mkdtempSync('/tmp/paired-agy-cli-'); roots.push(root);
  for (const change of [{ provider: 'other' }, { model: 'another-glm' }]) {
    const config: PairConfig = JSON.parse(readFileSync('scripts/benchmarks/t09-config.json', 'utf8'));
    Object.assign(config.model, change); const path = join(root, 'config.json'); writeFileSync(path, JSON.stringify(config));
    await expect(main(['--run', `--config=${path}`, `--out=${join(root, 'out')}`])).rejects.toThrow('Transport does not support');
  }
  expect(agyVersion).not.toHaveBeenCalled(); expect(runDurablePaired).not.toHaveBeenCalled();
});
