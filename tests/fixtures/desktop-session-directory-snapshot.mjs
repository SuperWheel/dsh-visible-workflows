// Names, sizes and mtimes only. Never opens any session history body.
import { readdir, lstat, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'

const base = path.resolve('.cache/secret-bootstrap-20261017/desktop-session-directory-baseline.json')
const root = path.join(homedir(), '.dsh/sessions')
const sessions = []
for (const project of await readdir(root, { withFileTypes:true })) {
  if (!project.isDirectory() || project.isSymbolicLink()) continue
  for (const session of await readdir(path.join(root, project.name), { withFileTypes:true })) {
    if (!session.isDirectory() || session.isSymbolicLink() || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(session.name)) continue
    const directory = path.join(root,project.name,session.name)
    const files = []
    for (const name of await readdir(directory)) if (/^session\.v[1-9][0-9]*\.jsonl(?:\.zstd)?$/.test(name)) {
      const stat = await lstat(path.join(directory,name))
      if (stat.isFile() && !stat.isSymbolicLink()) files.push({name,size:stat.size,mtimeMs:stat.mtimeMs})
    }
    sessions.push({id:session.name, project:project.name, files:files.sort((a,b)=>a.name.localeCompare(b.name))})
  }
}
if (process.argv[2] === '--capture') {
  await mkdir(path.dirname(base),{recursive:true})
  await writeFile(base,JSON.stringify({at:new Date().toISOString(),sessions},null,2)+'\n')
  console.log(JSON.stringify({status:'captured',count:sessions.length,sessionBodiesRead:0,baseline:base}))
} else if (process.argv[2] === '--diff') {
  const old = JSON.parse(await readFile(base,'utf8'))
  const oldById = new Map(old.sessions.map(row=>[row.project+'/'+row.id,row]))
  const added = [], changed = []
  for (const row of sessions) {
    const previous=oldById.get(row.project+'/'+row.id)
    if (!previous) added.push(row.id)
    else if (JSON.stringify(previous.files)!==JSON.stringify(row.files)) changed.push(row.id)
  }
  console.log(JSON.stringify({status:'metadata_only',baselineAt:old.at,newSessionIds:added,changedSessionIds:changed,sessionBodiesRead:0,tagNotYetVerified:true}))
} else {
  console.log(JSON.stringify({status:'pending',reason:'Use --capture before UI session creation and --diff after creation',sessionBodiesRead:0}))
  process.exitCode=2
}
