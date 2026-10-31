import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { build } from 'tsdown'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'
import { stageTypertSdk } from './stage-typert-sdk.mjs'
import { verifyTypertBuild } from './verify-typert-build.mjs'

const root = resolve('.')
// Build the OS credential helper explicitly; plugin builds never replace it.
if (process.platform === 'darwin' && !existsSync('native/os-secret-broker/dist/integrity.json')) throw new Error('Build the OS credential component with node native/os-secret-broker/build.mjs first.')
// A plugin without its private runtime cannot execute any workflow. Fail the
// build before producing an apparently installable but incomplete package.
const runtimeManifests = readdirSync('runtime-assets').filter(name => /^(macos-arm64|windows-x64)\.json$/.test(name))
if (!runtimeManifests.length) throw new Error('Build the prebuilt Graphon runtime before packaging')
for (const file of runtimeManifests) {
  const runtime = JSON.parse(readFileSync(join('runtime-assets', file), 'utf8'))
  if (!/^graphon-core-0\.7\.0-(macos-arm64|windows-x64)\.tar\.gz$/.test(runtime.archive)) throw new Error('Invalid runtime archive name')
  const bytes = readFileSync(join('runtime-assets', runtime.archive))
  if (bytes.length !== runtime.archiveBytes || createHash('sha256').update(bytes).digest('hex') !== runtime.sha256) throw new Error('Graphon runtime integrity check failed')
}
// Discard only generated outputs so old entry points cannot leak into packages.
rmSync(join(root, 'lib'), { recursive: true, force: true })
rmSync(join(root, '.cache/typert'), { recursive: true, force: true })
const tsc = (project) =>
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', project], { stdio: 'inherit' })
tsc('tsconfig.host-build.json')
await build({
  entry: { 'html-tools': 'lib/types/host/html-tools.js', index: 'lib/types/host/index.js', compiler: 'lib/types/shared/workflow-compiler.js', 'workflow-compile': 'lib/types/host/planning/compiler-cli.js' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  deps: { alwaysBundle: ['htmlparser2', 'css-select'] },
  clean: false,
  sourcemap: true,
  dts: false,
  outputOptions: { entryFileNames: '[name].js' },
})
// Keep the emitted source entry usable without external HTML parser packages.
writeFileSync('lib/types/host/html-tools.js', "export * from '../../html-tools.js'\n")
// The published generator requires a packages/* workspace inventory. Stage our
// single package at build time; no Harness source checkout is needed by users.
const stage = join(root, '.cache/typert')
const owner = join(stage, 'packages/workflows')
mkdirSync(owner, { recursive: true })
cpSync('src', join(owner, 'src'), { recursive: true })
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const stagedManifest = structuredClone(manifest)
stagedManifest.exports['.'] = { types: './src/host/index.ts', default: './src/host/index.ts' }
writeFileSync(join(owner, 'package.json'), JSON.stringify(stagedManifest))
cpSync('lib/types', join(owner, 'lib/types'), { recursive: true })
if (!existsSync(join(stage, 'node_modules')))
  symlinkSync(join(root, 'node_modules'), join(stage, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
writeFileSync(
  join(owner, 'tsconfig.host.json'),
  JSON.stringify({
    ...JSON.parse(readFileSync('tsconfig.base.json')),
    include: ['src/host/**/*.ts', 'src/shared/**/*.ts'],
  }),
)
const sdk = stageTypertSdk(root, stage)
writeFileSync(
  join(stage, 'tsconfig.host.json'),
  JSON.stringify({
    compilerOptions: {
      ...JSON.parse(readFileSync('tsconfig.base.json')).compilerOptions,
      paths: sdk.paths,
    },
    files: [],
    references: [
      { path: './packages/workflows/tsconfig.host.json' },
      ...sdk.references,
    ],
  }),
)
const generator = new WorkspaceTypertGenerator(stage, { checkDiagnostics: false })
const artifacts = generator.generate([manifest.name], ['host'])
if (artifacts.length !== 1 || !artifacts[0].remote) throw new Error('Missing generated Host/Remote contract')
const artifact = artifacts[0]
writeFileSync('lib/typert.host.js', artifact.js)
writeFileSync('lib/typert.host.d.ts', artifact.dts)
writeFileSync('lib/typert.remote-client.js', artifact.remote.js)
writeFileSync('lib/typert.remote-client.d.ts', artifact.remote.dts)
writeFileSync('lib/typert.remote-client.d.ts.map', artifact.remote.dtsMap)
if (process.argv.includes('--host-only')) process.exit(0)
tsc('tsconfig.client.json')
await build({
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  platform: 'browser',
  loader: { '.png': 'dataurl' },
  format: 'cjs',
  clean: false,
  dts: false,
  sourcemap: true,
  deps: {
    // The generated 0.2.1 Remote artifact uses this browser-safe lazy helper;
    // it is an npm subpath, not a renderer module-loader seed.
    alwaysBundle: ['zod', 'dsh-visible-dynamic-workflows/remote', '@deepseek-ai/dsh-typert-protocol/remote-info'],
    neverBundle: [
      'react',
      'react-dom',
      'react/jsx-runtime',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
  },
  outputOptions: {
    banner: 'window.__ModuleLoader__.load({ id: "dsh-visible-dynamic-workflows", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
    entryFileNames: '[name].js',
  },
})
console.log(JSON.stringify({ typertBuild: await verifyTypertBuild(root) }))
