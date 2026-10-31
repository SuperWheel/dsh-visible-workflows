import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve, dirname, relative, extname } from 'node:path'

const root = resolve('doc/workflow-manual'), entry = resolve(root, 'README.md'), errors = [], links = new Map()
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const result = []
  for (const item of entries) {
    const path = resolve(directory, item.name)
    if (item.isDirectory()) result.push(...await files(path))
    else if (extname(path) === '.md') result.push(path)
  }
  return result
}
const pages = await files(root)
for (const path of pages) {
  const content = await readFile(path, 'utf8'), withoutCode = content.replace(/```[^\n]*\n[\s\S]*?```/g, '')
  if (!/^# .+/m.test(content)) errors.push(`${relative(root, path)}: missing title`)
  const targets = []
  for (const match of withoutCode.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, '')
    if (/^(?:https?:|mailto:|nowledgemem:)/.test(raw) || raw.startsWith('#')) continue
    const [file, anchor] = raw.split('#'), target = resolve(dirname(path), decodeURIComponent(file))
    if (/\s/.test(raw) && !match[1].startsWith('<')) errors.push(`${relative(root, path)}: unescaped space in ${raw}`)
    try {
      if (!(await stat(target)).isFile()) throw new Error('not a file')
      const line = anchor?.match(/^L(\d+)(?:-L?\d+)?$/)
      if (line && Number(line[1]) > (await readFile(target, 'utf8')).split('\n').length) errors.push(`${relative(root, path)}: stale source line ${raw}`)
      if (target.startsWith(root + '/') && target.endsWith('.md')) targets.push(target)
    } catch { errors.push(`${relative(root, path)}: missing ${raw}`) }
  }
  links.set(path, targets)
}
const visited = new Set(), walk = path => { if (visited.has(path)) return; visited.add(path); for (const target of links.get(path) ?? []) walk(target) }
walk(entry)
for (const page of pages) if (!visited.has(page)) errors.push(`unindexed: ${relative(root, page)}`)
const kinds = [...(await readFile('src/shared/types.ts', 'utf8')).match(/^export type NodeKind = (.+)$/m)[1].matchAll(/'([^']+)'/g)].map(match => match[1])
const nodePages = pages.filter(path => dirname(path) === resolve(root, '节点') && !path.endsWith('/README.md'))
for (const kind of kinds) if (!nodePages.some(path => path.split('/').at(-1).startsWith(`${kind}-`))) errors.push(`missing NodeKind: ${kind}`)
if (nodePages.length !== kinds.length) errors.push(`node page count ${nodePages.length} does not match NodeKind ${kinds.length}`)
console.log(JSON.stringify({ success: !errors.length, markdownPages: pages.length, indexedPages: visited.size, nodeKinds: kinds.length, nodePages: nodePages.length, errors }, null, 2))
if (errors.length) process.exitCode = 1
