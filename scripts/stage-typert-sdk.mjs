import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'

/**
 * The official generator indexes declaration ownership through aggregate project
 * references. Published SDKs have lib declarations rather than workspace src,
 * so register the exact SDK closure loaded by the checked Host program as
 * declaration-only projects. Do not trim augmentations: Remote resources and
 * error maps must retain every contributor in the same face.
 */
export function stageTypertSdk(root, stage) {
  const configPath = join(root, 'tsconfig.host-build.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, { noEmit: true }, configPath)
  if (parsed.errors.length) throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'))
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
  const packages = new Map()
  const rootsByDirectory = new Map()
  for (const source of program.getSourceFiles()) {
    if (!source.isDeclarationFile || !source.fileName.includes('node_modules')) continue
    let directory = dirname(realpathSync(source.fileName))
    const visited = []
    let found
    while (true) {
      if (rootsByDirectory.has(directory)) { found = rootsByDirectory.get(directory); break }
      visited.push(directory)
      const manifestPath = join(directory, 'package.json')
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (typeof manifest.name === 'string' && manifest.name.startsWith('@deepseek-ai/dsh-')) found = { root: directory, manifest }
        break
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
    for (const directory of visited) rootsByDirectory.set(directory, found)
    if (!found) continue
    const previous = packages.get(found.manifest.name)
    if (previous && previous.root !== found.root) throw new Error(`Multiple SDK copies in Host type graph: ${found.manifest.name}`)
    packages.set(found.manifest.name, found)
  }
  if (!packages.has('@deepseek-ai/dsh-typert-protocol')) throw new Error('Host type graph did not load the Typert protocol')
  // Public declaration exports can pull further augmentations into the face
  // when the analyzer resolves a cross-package symbol. Include their installed
  // SDK dependency closure as owners too, without making them emitted roots.
  const queue = [...packages.values()]
  for (const current of queue) {
    const require = createRequire(join(current.root, 'package.json'))
    const dependencies = { ...current.manifest.dependencies, ...current.manifest.peerDependencies }
    for (const name of Object.keys(dependencies).sort()) {
      if (!name.startsWith('@deepseek-ai/dsh-') || packages.has(name)) continue
      let manifestPath
      try { manifestPath = require.resolve(`${name}/package.json`) }
      catch (error) {
        if (error.code === 'MODULE_NOT_FOUND' && current.manifest.peerDependenciesMeta?.[name]?.optional === true) continue
        throw error
      }
      const dependency = { root: dirname(realpathSync(manifestPath)), manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) }
      packages.set(name, dependency)
      queue.push(dependency)
    }
  }
  const paths = {}, references = []
  for (const { root: sourceRoot, manifest } of [...packages.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))) {
    const packageRoot = join(stage, 'packages', manifest.name.slice('@deepseek-ai/'.length))
    mkdirSync(packageRoot, { recursive: true })
    cpSync(join(sourceRoot, 'lib'), join(packageRoot, 'declarations'), { recursive: true })
    // Keep each published package's third-party resolution environment. All DSH
    // declarations still resolve through the staged paths below; this link only
    // reads installed dependencies and never writes to the package manager store.
    symlinkSync(resolve(sourceRoot, '../..'), join(packageRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    const staged = structuredClone(manifest)
    for (const [subpath, target] of Object.entries(staged.exports ?? {})) {
      if (!target || typeof target !== 'object' || typeof target.types !== 'string' || !target.types.startsWith('./lib/')) continue
      const declaration = target.types.replace('./lib/', './declarations/')
      if (!existsSync(join(packageRoot, declaration))) throw new Error(`Missing published SDK declaration: ${manifest.name}${subpath.slice(1)}`)
      staged.exports[subpath] = { types: declaration, default: declaration }
      const specifier = manifest.name + (subpath === '.' ? '' : subpath.slice(1))
      paths[specifier] = [`./${relative(stage, resolve(packageRoot, declaration)).split('\\').join('/')}`]
    }
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify(staged))
    writeFileSync(join(packageRoot, 'tsconfig.host.json'), JSON.stringify({ include: ['declarations/**/*.d.ts'] }))
    references.push({ path: `./${relative(stage, packageRoot).split('\\').join('/')}/tsconfig.host.json` })
  }
  return { paths, references }
}
