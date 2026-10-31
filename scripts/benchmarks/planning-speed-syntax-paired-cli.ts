/** Offline preparation by default. Only explicit --run starts the private transport. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareSyntaxExperiment, runSyntaxExperiment, validateSyntaxManifest, type SyntaxManifest, type SyntaxProvider } from './planning-speed-syntax-paired.ts'
import type { ProviderResponse } from './template-fill-paired.ts'

class PrivateSyntaxBridge implements SyntaxProvider {
  private readonly child
  private pending?: { resolve(value: ProviderResponse): void; timer: ReturnType<typeof setTimeout> }
  private stopped = false
  constructor(bridgePath: string) {
    // Reuse the unchanged v3 private transport. It already captures finish.
    this.child = spawn('python3', [bridgePath], { stdio: ['pipe', 'pipe', 'ignore'] })
    createInterface({ input: this.child.stdout }).on('line', line => {
      const pending = this.pending; if (!pending) return
      clearTimeout(pending.timer); this.pending = undefined
      try { assert.ok(Buffer.byteLength(line) < 8_000_000); pending.resolve(JSON.parse(line)) } catch { pending.resolve({ error: 'ProviderError' }); this.close() }
    })
    const exited = () => { this.stopped = true; const pending = this.pending; this.pending = undefined; if (pending) { clearTimeout(pending.timer); pending.resolve({ error: 'ProviderError' }) } }
    this.child.on('error', exited); this.child.on('exit', exited); this.child.stdin.on('error', exited)
  }
  request(body: Record<string, any>): Promise<ProviderResponse> {
    if (this.stopped) return Promise.resolve({ error: 'ProviderError' })
    assert.equal(this.pending, undefined, 'Serial syntax experiment only')
    return new Promise(resolve => {
      this.pending = { resolve, timer: setTimeout(() => { const pending = this.pending; this.pending = undefined; pending?.resolve({ error: 'TimeoutError' }); this.close() }, 260_000) }
      this.child.stdin.write(JSON.stringify(body) + '\n')
    })
  }
  close() { this.stopped = true; const pending = this.pending; this.pending = undefined; if (pending) { clearTimeout(pending.timer); pending.resolve({ error: 'ProviderError' }) }; this.child.stdin.end(); this.child.kill() }
}
export async function syntaxMain(args = process.argv.slice(2)) {
  assert.ok(args.every(arg => arg === '--prepare' || arg === '--run' || /^--(?:out|manifest|source-v3|prereg)=/.test(arg)), 'Unknown syntax experiment argument')
  const value = (name: string) => args.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3)
  if (!args.includes('--prepare') && !args.includes('--run')) { console.log('No provider started. --prepare is offline development only. Finalize with planning-speed-syntax-snapshot.mjs after source stability; only the isolated snapshot CLI may perform a separately authorized --run. Do not overlap Desktop/main model work.'); return }
  assert.ok(!(args.includes('--prepare') && args.includes('--run')), 'Preparation and dispatch are separate operations')
  const output = value('out'); assert.ok(output, 'A new explicit --out directory is required')
  if (args.includes('--prepare')) {
    assert.ok(!value('manifest'), 'Prepare does not execute a manifest')
    const manifest = await prepareSyntaxExperiment(output, value('source-v3'), value('prereg'))
    console.log(JSON.stringify({ prepared: resolve(output), digest: manifest.digest, expectedRequests: 10, maximumRequests: 30, actualProviderRequests: 0 })); return
  }
  assert.ok(!value('source-v3') && !value('prereg'), 'Run uses only the frozen manifest')
  const source = value('manifest'); assert.ok(source, 'Run requires an explicit frozen --manifest')
  const manifest = JSON.parse(readFileSync(resolve(source), 'utf8')) as SyntaxManifest
  validateSyntaxManifest(manifest) // No credential-capable process before frozen validation.
  assert.ok(manifest.runtimeSnapshot, 'Real run requires a finalized isolated snapshot; source preparation is offline only')
  const destination = resolve(output); mkdirSync(destination, { mode: 0o700 })
  writeFileSync(join(destination, 'run-registration.json'), JSON.stringify({ manifestPath: resolve(source), manifestDigest: manifest.digest, startedAt: new Date().toISOString(), expectedRequests: 10, maximumRequests: 30, promptOnlyHandoff: true, servicePartialValidated: false, overlapPolicy: 'Caller must separately schedule after Desktop/main model work; this CLI does not verify server concurrency.' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  const provider = new PrivateSyntaxBridge(manifest.runtimeSnapshot?.bridgePath??resolve('scripts/benchmarks/planning-speed-provider-bridge.py')), cancel = () => provider.close()
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
  try {
    const report = await runSyntaxExperiment(manifest, provider, { onEvent: event => {
      appendFileSync(join(destination, 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 })
      if (event.type === 'arm-end') console.log(JSON.stringify({ repeat: event.result.repeat, arm: event.result.arm, status: event.result.status, reasonCode: event.result.reasonCode, requests: event.result.requests }))
    } })
    writeFileSync(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); provider.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await syntaxMain()
