/** --prepare and help are offline. --run requires a frozen manifest and a NEW output directory. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareSpeedExperiment, runSpeedStage, validateSpeedManifest, type SpeedManifest, type SpeedProvider, type SpeedStage } from './planning-speed-paired.ts'
import type { ProviderResponse } from './template-fill-paired.ts'

class PrivateSpeedBridge implements SpeedProvider {
  private readonly child
  private pending?: { resolve: (value: ProviderResponse) => void; timer: ReturnType<typeof setTimeout> }
  private stopped = false
  constructor() {
    this.child = spawn('python3', [resolve('scripts/benchmarks/planning-speed-provider-bridge.py')], { stdio: ['pipe', 'pipe', 'ignore'] })
    createInterface({ input: this.child.stdout }).on('line', line => {
      const pending = this.pending
      if (!pending) return
      clearTimeout(pending.timer); this.pending = undefined
      try { assert.ok(Buffer.byteLength(line) < 8_000_000); pending.resolve(JSON.parse(line)) }
      catch { pending.resolve({ error: 'Invalid private transport receipt' }); this.close() }
    })
    const exited = () => { this.stopped = true; const pending = this.pending; this.pending = undefined; if (pending) { clearTimeout(pending.timer); pending.resolve({ error: 'Private transport exited; usage unknown' }) } }
    this.child.on('error', exited); this.child.on('exit', exited); this.child.stdin.on('error', exited)
  }
  request(body: Record<string, unknown>): Promise<ProviderResponse> {
    if (this.stopped) return Promise.resolve({ error: 'Private transport stopped' })
    assert.equal(this.pending, undefined, 'Only one serial provider request may be active')
    return new Promise(resolve => {
      const timer = setTimeout(() => { const pending = this.pending; this.pending = undefined; pending?.resolve({ error: 'Private transport deadline; partial usage unavailable' }); this.close() }, 260_000)
      this.pending = { resolve, timer }; this.child.stdin.write(JSON.stringify(body) + '\n')
    })
  }
  close() { this.stopped = true; const pending = this.pending; this.pending = undefined; if (pending) { clearTimeout(pending.timer); pending.resolve({ error: 'Private transport cancelled; partial usage unknown' }) }; this.child.stdin.end(); this.child.kill() }
}

export async function speedMain(args = process.argv.slice(2)) {
  const allowed = args.every(arg => arg === '--prepare' || arg === '--run' || /^--(?:out|manifest|baseline|stage)=/.test(arg))
  assert.ok(allowed, 'Unknown benchmark argument')
  const value = (name: string) => args.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3)
  if (!args.includes('--prepare') && !args.includes('--run')) {
    console.log('No provider started. Offline: --prepare --out=NEW_FREEZE_DIRECTORY [--baseline=INSTALLED_COMPILER]. Later explicit run: --run --manifest=FROZEN/manifest.json --stage=initial|combined --out=NEW_RESULTS_DIRECTORY. Each stage is separate; never starts both automatically.')
    return
  }
  assert.equal(args.includes('--prepare') && args.includes('--run'), false, 'Prepare and run are separate operations')
  const output = value('out'); assert.ok(output, 'A fresh explicit --out directory is required')
  if (args.includes('--prepare')) {
    assert.ok(!value('manifest') && !value('stage'), 'Prepare freezes both stages without dispatch')
    const manifest = await prepareSpeedExperiment(output, value('baseline'))
    console.log(JSON.stringify({ prepared: resolve(output), digest: manifest.digest, initialExpectedRequests: 15, combinedExpectedRequests: 10, actualProviderRequests: 0 }))
    return
  }
  assert.ok(!value('baseline'), 'Run uses only the baseline in its frozen manifest')
  const source = value('manifest'), stage = value('stage'); assert.ok(source && (stage === 'initial' || stage === 'combined'), 'Run requires frozen --manifest and explicit --stage=initial|combined')
  const manifest = JSON.parse(readFileSync(resolve(source), 'utf8')) as SpeedManifest
  validateSpeedManifest(manifest) // Validate before any directory mutation or credential-capable process.
  const destination = resolve(output); mkdirSync(destination, { mode: 0o700 })
  writeFileSync(join(destination, 'run-registration.json'), JSON.stringify({ manifestPath: resolve(source), manifestDigest: manifest.digest, stage, startedAt: new Date().toISOString(), expectedRequests: manifest.stages[stage].expectedModelRequests, maximumRequests: 30, measurementBoundary: manifest.measurementBoundary }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  const provider = new PrivateSpeedBridge(), cancel = () => provider.close()
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
  try {
    const report = await runSpeedStage(manifest, stage as SpeedStage, provider, event => {
      appendFileSync(join(destination, 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 })
      const entry = event as { type: string; result?: { caseId: string; repeat: number; arm: string; status: string; requests: number } }
      if (entry.type === 'arm-end') console.log(JSON.stringify({ caseId: entry.result!.caseId, repeat: entry.result!.repeat, arm: entry.result!.arm, status: entry.result!.status, requests: entry.result!.requests }))
    })
    writeFileSync(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); provider.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await speedMain()
