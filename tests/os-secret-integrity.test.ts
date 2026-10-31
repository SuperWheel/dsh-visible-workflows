import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inspectOSSecretPackage, OS_SECRET_BROKER_BUNDLE, OS_SECRET_BROKER_EXECUTABLE } from '../src/host/os-secret-integrity.ts'

const pin = vi.hoisted(() => ({ value: null as string | null }))
vi.mock('../src/host/os-secret-manifest.ts', () => ({ get OS_SECRET_BROKER_MANIFEST_SHA256() { return pin.value } }))
let root: string
let entries: { path: string; size: number; sha256: string }[]
const bundlePath = (name: string) => join(root, OS_SECRET_BROKER_BUNDLE, name)
function writeManifest(extra: Record<string, unknown> = {}, updateTrustedPin = false) {
  const data = JSON.stringify({ version: 1, identifier: 'com.deepseekharness.workflow.os-secret-broker', files: entries, ...extra }) + '\n'
  writeFileSync(join(root, 'integrity.json'), data, { mode: 0o600 })
  // This is a test-only generated trust anchor, not caller-provided production data.
  if (updateTrustedPin) pin.value = createHash('sha256').update(data).digest('hex')
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'os-secret-integrity-'))
  entries = [OS_SECRET_BROKER_EXECUTABLE, 'Contents/Info.plist', 'Contents/_CodeSignature/CodeResources'].map((path, index) => {
    mkdirSync(join(root, OS_SECRET_BROKER_BUNDLE, path.slice(0, path.lastIndexOf('/'))), { recursive: true, mode: 0o700 })
    const bytes = Buffer.from(`synthetic-bundle-member-${index}`)
    writeFileSync(bundlePath(path), bytes, { mode: index === 0 ? 0o700 : 0o600 })
    return { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  writeManifest({}, true)
})
afterEach(() => { rmSync(root, { recursive: true, force: true }); pin.value = null })

describe('OS credential component file integrity', () => {
  it('verifies the exact complete artifact with a separate trusted manifest pin', async () => {
    await expect(inspectOSSecretPackage(root)).resolves.toBe('verified')
  })
  it('never treats a self-described manifest as its own authority', async () => {
    pin.value = null
    await expect(inspectOSSecretPackage(root)).resolves.toBe('unverified')
  })
  it('rejects replacement of both a bundle file and its untrusted manifest hash', async () => {
    writeFileSync(bundlePath(OS_SECRET_BROKER_EXECUTABLE), 'replacement')
    entries[0] = { ...entries[0]!, size: 11, sha256: createHash('sha256').update('replacement').digest('hex') }
    writeManifest()
    await expect(inspectOSSecretPackage(root)).resolves.toBe('unverified')
  })
  it.each([OS_SECRET_BROKER_EXECUTABLE, 'Contents/Info.plist', 'Contents/_CodeSignature/CodeResources'])('covers runtime member %s, not just executable existence', async path => {
    writeFileSync(bundlePath(path), 'synthetic-bundle-member-x')
    await expect(inspectOSSecretPackage(root)).resolves.toBe('unverified')
  })
  it.each(['Contents/injected.js', 'Contents/.injected'])('rejects added file %s', async name => {
    writeFileSync(bundlePath(name), 'extra')
    await expect(inspectOSSecretPackage(root)).resolves.toBe('unverified')
  })
  it('rejects an unexpected empty directory', async () => {
    mkdirSync(bundlePath('Contents/injected'))
    await expect(inspectOSSecretPackage(root)).resolves.toBe('unverified')
  })
  it('rejects a symlink even when it points to matching bytes', async () => {
    const source = join(root, 'matching-copy')
    writeFileSync(source, 'synthetic-bundle-member-0')
    rmSync(bundlePath(OS_SECRET_BROKER_EXECUTABLE)); symlinkSync(source, bundlePath(OS_SECRET_BROKER_EXECUTABLE))
    await expect(inspectOSSecretPackage(root)).resolves.toBe('unverified')
  })
  it('rejects a hardlink and broadly writable member', async () => {
    linkSync(bundlePath(OS_SECRET_BROKER_EXECUTABLE), join(root, 'hardlink'))
    await expect(inspectOSSecretPackage(root)).resolves.toBe('unverified')
    rmSync(join(root, 'hardlink')); chmodSync(bundlePath('Contents/Info.plist'), 0o666)
    await expect(inspectOSSecretPackage(root)).resolves.toBe('unverified')
  })
  it('rejects traversal, duplicate and additional manifest fields even with a fixture pin', async () => {
    writeManifest({ approved: true }, true)
    await expect(inspectOSSecretPackage(root)).resolves.toBe('unverified')
    entries.push(entries[0]!); writeManifest({}, true)
    await expect(inspectOSSecretPackage(root)).resolves.toBe('unverified')
    entries.pop(); entries[0]!.path = 'Contents/../../outside'; writeManifest({}, true)
    await expect(inspectOSSecretPackage(root)).resolves.toBe('unverified')
  })
  it('reports a missing package or manifest without errors or launch', async () => {
    rmSync(join(root, 'integrity.json'))
    await expect(inspectOSSecretPackage(root)).resolves.toBe('missing')
  })
})
