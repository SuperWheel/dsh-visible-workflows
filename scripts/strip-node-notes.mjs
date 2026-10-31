#!/usr/bin/env node
// 回退旧版前显式运行；不发现 Desktop profile，不读取默认目录。
import { readFileSync, writeFileSync, renameSync, lstatSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function stripNodeNotes(root, apply = false) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('必须提供显式存储根路径')
  const file = join(resolve(root), 'library.json')
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('library.json 必须为普通文件')
  const original = readFileSync(file), library = JSON.parse(original.toString('utf8'))
  if (!Array.isArray(library.workflows)) throw new Error('library.json 缺少 workflows 数组')
  const found = [], moduleInstances = []
  for (const workflow of library.workflows) {
    const visit = graph => {
      for (const node of graph.nodes ?? []) {
        if (Object.hasOwn(node, 'note')) {
          found.push({ workflowId: workflow.id, workflowTitle: workflow.title, nodeId: node.id, nodeTitle: node.title })
          delete node.note
        }
        if (node.config?.body) visit(node.config.body)
      }
    }
    visit(workflow)
    if (Object.hasOwn(workflow, 'moduleInstances')) {
      moduleInstances.push({ workflowId: workflow.id, workflowTitle: workflow.title, instanceCount: Array.isArray(workflow.moduleInstances) ? workflow.moduleInstances.length : null })
      delete workflow.moduleInstances
    }
  }
  let backup
  if (apply && (found.length || moduleInstances.length)) {
    backup = file + '.before-strip-node-notes-' + Date.now() + '-' + process.pid + '.bak'
    writeFileSync(backup, original, { flag: 'wx', mode: 0o600 })
    // 先完成备份；检测演练期间并发修改，禁止覆盖别的写入。
    if (!readFileSync(file).equals(original)) throw new Error('library.json 已变化，停止写入；备份已保留')
    const temp = file + '.strip-node-notes-' + process.pid + '.tmp'
    writeFileSync(temp, JSON.stringify(library, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(temp, file)
  }
  return { mode: apply ? 'apply' : 'dry-run', file, nodes: found, moduleInstances, ...(backup ? { backup } : {}) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), roots = args.filter(arg => !arg.startsWith('--'))
  if (roots.length !== 1 || args.some(arg => arg.startsWith('--') && arg !== '--apply')) {
    console.error('用法：node scripts/strip-node-notes.mjs <显式存储根路径> [--apply]。先停止使用该存储的插件；默认仅列出含备注或模块实例记录的图和节点。')
    process.exitCode = 1
  } else {
    try { console.log(JSON.stringify(stripNodeNotes(roots[0], args.includes('--apply')), null, 2)) }
    catch (error) { console.error(error.message); process.exitCode = 1 }
  }
}
