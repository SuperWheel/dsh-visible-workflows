// Two real processes, synthetic temporary storage, deterministic filesystem barriers.
import fs from 'node:fs'
import assert from 'node:assert/strict'
import {syncBuiltinESMExports} from 'node:module'
import {spawn} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
const script=fileURLToPath(import.meta.url)
const waitSync=predicate=>{const until=Date.now()+8000;while(!predicate()){if(Date.now()>until)throw Error('barrier timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)}}
if(process.argv[2]==='worker'){
  const [role,directory]=process.argv.slice(3),lock=join(directory,'host.lock')
  const originalRead=fs.readFileSync,originalOpen=fs.openSync
  let observed=false
  fs.readFileSync=function(path,...args){
    const value=originalRead.call(this,path,...args)
    if(String(path)===lock&&!observed){
      observed=true
      fs.writeFileSync(join(directory,role+'.read'),'read')
      if(role==='A')waitSync(()=>fs.existsSync(join(directory,'B.attempted')))
      else {fs.writeFileSync(join(directory,'B.attempted'),'read stale lock');waitSync(()=>fs.existsSync(join(directory,'A.acquired')))}
    }
    return value
  }
  fs.openSync=function(path,...args){
    try{return originalOpen.call(this,path,...args)}catch(error){
      if(role==='B'&&String(path)===join(directory,'host.lock.recovery')&&error.code==='EEXIST')fs.writeFileSync(join(directory,'B.attempted'),'gate contended')
      throw error
    }
  }
  syncBuiltinESMExports()
  const {WorkflowStorage}=await import('../../src/host/storage.ts')
  let storage
  try{storage=new WorkflowStorage(directory);fs.writeFileSync(join(directory,role+'.acquired'),String(process.pid));process.send({role,pid:process.pid,acquired:true})}
  catch(error){process.send({role,pid:process.pid,acquired:false,error:String(error)})}
  const close=()=>{storage?.close();process.exit(0)}
  process.on('message',close);process.on('disconnect',close)
}else{
  const directory=fs.mkdtempSync(join(tmpdir(),'dsh-lock-recovery-')),workers=[]
  const start=role=>{
    const child=spawn(process.execPath,['--import','tsx',script,'worker',role,directory],{stdio:['ignore','ignore','pipe','ipc']});workers.push(child)
    return new Promise((resolve,reject)=>{
      let stderr='';child.stderr.on('data',data=>stderr+=data)
      const timer=setTimeout(()=>reject(Error('worker timeout: '+stderr)),10000)
      child.once('message',value=>{clearTimeout(timer);resolve(value)})
      child.once('error',error=>{clearTimeout(timer);reject(error)})
      child.once('exit',code=>{clearTimeout(timer);if(code)reject(Error('worker failed: '+stderr))})
    })
  }
  try{
    const stalePid=2147483647
    assert.throws(()=>process.kill(stalePid,0),error=>error.code==='ESRCH')
    fs.writeFileSync(join(directory,'host.lock'),JSON.stringify({pid:stalePid,token:'stale-owner'}))
    const a=start('A'),until=Date.now()+8000
    while(!fs.existsSync(join(directory,'A.read'))){if(Date.now()>until)throw Error('A did not observe stale lock');await new Promise(resolve=>setTimeout(resolve,5))}
    const owners=await Promise.all([a,start('B')])
    assert.equal(owners.filter(owner=>owner.acquired).length,1)
    const winner=owners.find(owner=>owner.acquired);process.kill(winner.pid,0)
    assert.equal(JSON.parse(fs.readFileSync(join(directory,'host.lock'),'utf8')).pid,winner.pid)
    const {WorkflowStorage}=await import('../../src/host/storage.ts')
    assert.throws(()=>new WorkflowStorage(directory),/其他 Host 占用/)
    console.log(JSON.stringify({singleOwner:true,liveOwnerPreserved:true,owners}))
  }finally{
    await Promise.all(workers.map(child=>new Promise(resolve=>{
      if(child.exitCode!==null){resolve();return}
      const timer=setTimeout(()=>child.kill(),1000)
      child.once('exit',()=>{clearTimeout(timer);resolve()})
      if(child.connected)child.send('close');else child.kill()
    })))
    fs.rmSync(directory,{recursive:true,force:true})
  }
}
