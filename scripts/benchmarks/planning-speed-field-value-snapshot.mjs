/** Explicit offline snapshot builder. Never starts a credential/provider process. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, symlinkSync, unlinkSync, chmodSync, realpathSync } from 'node:fs'
import { resolve, dirname, relative, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'tsdown'
import ts from 'typescript'
import { createRequire, isBuiltin } from 'node:module'

const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const root = resolve('.')
const runner = 'scripts/benchmarks/planning-speed-field-value-paired.ts'
const cli = 'scripts/benchmarks/planning-speed-field-value-paired-cli.ts'
const bridge = 'scripts/benchmarks/planning-speed-provider-bridge.py'
const defaultV3 = 'docs/evidence/planning-speed-20261019/s10-frozen-v3-20261019/manifest.json'
const defaultPrereg = 'docs/evidence/planning-completion-20261020/performance/preregistration.json'
function closure(entries) {
  const files = new Set()
  const visit = path => {
    if (files.has(path)) return
    files.add(path)
    if (!path.endsWith('.ts')) return
    for (const match of readFileSync(path, 'utf8').matchAll(/(?:from\s*|import\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const base = resolve(dirname(path), match[1]), dependency = [base, base + '.ts', join(base, 'index.ts')].find(path => existsSync(path))
      assert.ok(dependency, 'Cannot snapshot local import: ' + base); visit(dependency)
    }
  }
  entries.forEach(path => visit(resolve(path))); return [...files].sort()
}
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)])
}
function moduleSpecifiers(path) {
  if(!/\.[cm]?[jt]s$/.test(path))return []
  const source=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),specs=[]
  const visit=node=>{
    if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))specs.push(node.moduleSpecifier.text)
    if(ts.isCallExpression(node)&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0])&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&/^(?:__)?require(?:\$\d+)?$/.test(node.expression.text)))specs.push(node.arguments[0].text)
    ts.forEachChild(node,visit)
  }
  visit(source);return specs
}
/** Copy the exact external SDK module closure without bundling away its package
 * boundaries (some modules read their own package.json via import.meta.url). */
function copyRuntimePackages(specifiers,runtime) {
  const visited=new Set(),packages=new Map()
  const visit=(specifier,from)=>{
    if(isBuiltin(specifier))return
    const entry=createRequire(from).resolve(specifier)
    if(visited.has(entry))return;visited.add(entry)
    if(!specifier.startsWith('.')){
      const name=specifier.startsWith('@')?specifier.split('/').slice(0,2).join('/'):specifier.split('/')[0]
      let packageRoot=dirname(realpathSync(entry))
      while(!existsSync(join(packageRoot,'package.json'))||JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8')).name!==name){const parent=dirname(packageRoot);assert.notEqual(parent,packageRoot,'Cannot locate runtime package '+name);packageRoot=parent}
      if(packages.has(name))assert.equal(packages.get(name),packageRoot,'Conflicting runtime package versions: '+name)
      else {packages.set(name,packageRoot);const destination=join(runtime,'node_modules',name);mkdirSync(dirname(destination),{recursive:true});cpSync(packageRoot,destination,{recursive:true,dereference:true,filter:path=>{const name=path.split('/').at(-1);return path===packageRoot||name!=='node_modules'&&!name.startsWith('.')}})}
    }
    for(const dependency of moduleSpecifiers(entry))visit(dependency,entry)
  }
  for(const specifier of specifiers)visit(specifier,resolve(runner))
  return [...packages].map(([name,source])=>({name,source,version:JSON.parse(readFileSync(join(source,'package.json'),'utf8')).version}))
}
export async function buildFieldValueSnapshot(output, sourceV3 = defaultV3, prereg = defaultPrereg) {
  const directory = resolve(output), sourceRoot = join(directory, 'source'), runtime = join(directory, 'runtime')
  mkdirSync(directory, { mode: 0o700 }); mkdirSync(sourceRoot, { mode: 0o700 }); mkdirSync(runtime, { mode: 0o700 })
  const v3 = JSON.parse(readFileSync(resolve(sourceV3), 'utf8'))
  const sourceFiles = closure([runner, cli])
  const additions = [resolve(bridge), resolve(sourceV3), resolve(prereg), resolve(prereg.replace(/\.json$/, '.md')), resolve('package.json'), resolve('scripts/benchmarks/planning-speed-field-value-snapshot.mjs')]
  const originals = [...new Set([...sourceFiles, ...additions])].map(path => ({ path, sha256: sha(path) }))
  for (const file of originals) {
    const local = relative(root, file.path); assert.ok(!local.startsWith('..'), 'Snapshot input must be in the repository')
    const destination = join(sourceRoot, local); mkdirSync(dirname(destination), { recursive: true }); copyFileSync(file.path, destination, 1)
  }
  // Preserve the historical baseline bytes as facts; not executed by v4.
  for (const file of v3.baseline.files) {
    assert.equal(sha(file.frozen), file.sha256, 'Historical v3 baseline changed')
    const destination = join(sourceRoot, relative(root, file.frozen)); mkdirSync(dirname(destination), { recursive: true }); copyFileSync(file.frozen, destination, 1)
  }
  // Resolve installed build dependencies only while bundling. This symlink is
  // removed before the snapshot can be used, and is never a runtime dependency.
  const link = join(sourceRoot, 'node_modules'); symlinkSync(join(root, 'node_modules'), link, 'dir')
  try {
    await build({ entry: { driver: join(sourceRoot, runner), run: join(sourceRoot, cli) }, outDir: runtime, platform: 'node', target: 'node22', format: 'esm', clean: false, dts: false, sourcemap: true, deps: { alwaysBundle: ['zod'] }, outputOptions: { entryFileNames: '[name].mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' } })
  } finally { unlinkSync(link) }
  const external=new Set()
  for (const path of walk(runtime).filter(path => path.endsWith('.mjs'))) {
    for(const specifier of moduleSpecifiers(path))if(!isBuiltin(specifier)&&!specifier.startsWith('.'))external.add(specifier)
  }
  const runtimePackages=copyRuntimePackages(external,runtime)
  for (const file of originals) assert.equal(sha(file.path), file.sha256, 'Product/source changed during snapshot: ' + file.path)
  const tsdownPackage = JSON.parse(readFileSync(join(root, 'node_modules/tsdown/package.json'), 'utf8'))
  const snapshot = { sourceRoot, driverPath: join(runtime, 'driver.mjs'), cliPath: join(runtime, 'run.mjs'), bridgePath: join(sourceRoot, bridge), bundler: 'tsdown@' + tsdownPackage.version, workspaceNpmDependencies: false, files: [...walk(sourceRoot), ...walk(runtime)].sort().map(path => ({ path, sha256: sha(path) })) }
  const frozenDriver = await import(pathToFileURL(snapshot.driverPath).href)
  const manifest = await frozenDriver.prepareFieldValueExperiment(join(directory, 'frozen'), sourceV3, prereg, snapshot)
  frozenDriver.validateFieldValueManifest(manifest)
  for (const file of originals) assert.equal(sha(file.path), file.sha256, 'Product/source changed before snapshot completed: ' + file.path)
  writeFileSync(join(directory, 'snapshot-provenance.json'), JSON.stringify({ kind: 'offline-source-and-runtime-snapshot', actualProviderRequests: 0, originals, historicalV3: { manifestPath: resolve(sourceV3), manifestDigest: v3.digest }, copiedSources: snapshot.files, runtimePackages, bundler: snapshot.bundler, workspaceNpmDependencies: false, runtimeDependencyPolicy:'Bundled zod plus copied exact SDK package closure; no workspace node_modules at execution.', sourceStabilityBeforeAfter: true, manifestDigest: manifest.digest }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  for (const path of walk(directory)) chmodSync(path, 0o444)
  return { directory, manifestPath: join(directory, 'frozen/manifest.json'), cliPath: snapshot.cliPath, driverPath: snapshot.driverPath, digest: manifest.digest, actualProviderRequests: 0 }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), value = name => args.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3)
  assert.ok(args.every(arg => /^--(?:out|source-v3|prereg)=/.test(arg)), 'Snapshot preparation only; no run option')
  assert.ok(value('out'), 'A new explicit --out directory is required')
  console.log(JSON.stringify(await buildFieldValueSnapshot(value('out'), value('source-v3'), value('prereg'))))
}
