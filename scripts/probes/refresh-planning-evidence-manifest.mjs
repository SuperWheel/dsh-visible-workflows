// Update a local acceptance manifest from actual task.childId values, then
// optionally collect one snapshot. No polling, model calls or live writes.
// Usage: node scripts/probes/refresh-planning-evidence-manifest.mjs MANIFEST [OUTPUT]
// Existing root/session/workflow scope remains immutable. New roots require an
// explicit human/parent-reviewed manifest edit; no session directories are listed.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const [manifestArg, outputArg] = process.argv.slice(2)
if (!manifestArg) throw new Error('Pass an existing local acceptance manifest')
const manifestFile = path.resolve(manifestArg)
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const cache = path.join(repo, '.cache/planning-entry-20261018-live')
const localFile = file => {
  if (path.dirname(file) !== cache || !file.endsWith('.json')) throw new Error('Evidence output must be a JSON file in the current acceptance cache')
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Evidence file cannot be a symbolic link')
}
localFile(manifestFile)
if (outputArg) {localFile(path.resolve(outputArg));if(fs.existsSync(path.resolve(outputArg)))throw new Error('Use a new snapshot filename; existing evidence is immutable')}
const manifest = JSON.parse(fs.readFileSync(manifestFile,'utf8'))
const ids = /^[A-Za-z0-9_-]{1,160}$/
if (!Array.isArray(manifest.workflowIds) || !manifest.workflowIds.length || manifest.workflowIds.some(id=>!ids.test(id)) || !Array.isArray(manifest.sessions)) throw new Error('Invalid allowlist')
const roots = new Map(manifest.sessions.filter(s=>s.role==='root').map(s=>[s.id,s]))
if (!roots.size || [...roots.values()].some(s=>!ids.test(s.id)||!path.isAbsolute(s.file)||path.basename(path.dirname(s.file))!==s.id||path.basename(s.file)!=='session.v4.jsonl.zstd')) throw new Error('Invalid explicit root file')
const tasksFile = path.join(manifest.stateDirectory,'planning/tasks.json')
if (!path.isAbsolute(tasksFile)||fs.lstatSync(tasksFile).isSymbolicLink()) throw new Error('Invalid planning state path')
const tasks=JSON.parse(fs.readFileSync(tasksFile,'utf8')).tasks.filter(t=>roots.has(t.sessionId)&&t.workspaceId===manifest.workspaceId&&manifest.workflowIds.includes(t.context?.workflow.id??t.request?.targetWorkflowId))
const added=[]
for(const task of tasks){
  if(!task.childId)continue
  if(!ids.test(task.childId))throw new Error('Invalid child ID in admitted task')
  const prior=manifest.sessions.find(s=>s.id===task.childId)
  if(prior){if(prior.role!=='planner'||prior.parentId!==task.sessionId)throw new Error('Child manifest conflicts with task owner');continue}
  const root=roots.get(task.sessionId),child={id:task.childId,role:'planner',parentId:task.sessionId,file:path.join(path.dirname(path.dirname(root.file)),task.childId,'session.v4.jsonl.zstd')}
  manifest.sessions.push(child);added.push({id:child.id,parentId:child.parentId,taskId:task.id})
}
if(added.length)fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n')
if(outputArg){
  const output=execFileSync(process.execPath,[path.join(repo,'scripts/probes/collect-planning-live-evidence.mjs'),manifestFile],{encoding:'utf8',maxBuffer:16_000_000})
  JSON.parse(output)
  fs.writeFileSync(path.resolve(outputArg),output,{flag:'wx'})
}
console.log(JSON.stringify({manifest:manifestFile,rootIds:[...roots.keys()],workflowIds:manifest.workflowIds,addedChildren:added,matchingTaskIds:tasks.map(t=>t.id),...(outputArg?{snapshot:path.resolve(outputArg)}:{})},null,2))
