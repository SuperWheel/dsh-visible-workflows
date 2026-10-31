import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkflowRun } from '../shared/types.ts'
import { parseWorkflow } from './validation.ts'

export function runRequestDigest(value:unknown):string{
  const canonical=JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0)):item)
  return createHash('sha256').update(canonical).digest('hex')
}
const key=(workspaceId:string,sessionId:string|undefined,requestId:string)=>runRequestDigest([workspaceId,sessionId??null,requestId])
/** Owned by WorkflowStorage's Host lock. Independent of the 200-run history retention. */
export class RunRequestStore {
  private readonly directory:string
  private readonly rows=new Map<string,WorkflowRun>()
  constructor(directory:string){
    this.directory=join(directory,'run-requests')
    if(!existsSync(this.directory))return
    this.assertDirectory()
    for(const name of readdirSync(this.directory).filter(name=>name.endsWith('.json'))){
      const file=join(this.directory,name)
      if(!/^[a-f0-9]{64}\.json$/.test(name)||lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile())throw new Error('运行请求回执路径无效')
      const run=JSON.parse(readFileSync(file,'utf8')) as WorkflowRun,receipt=run.requestReceipt
      if(!validRequestId(run.id)||typeof run.workspaceId!=='string'||!receipt||(receipt.sessionId!==undefined&&typeof receipt.sessionId!=='string')||!validRequestId(receipt.requestId)||receipt.runId!==run.id||!/^[a-f0-9]{64}$/.test(receipt.parametersDigest)||key(run.workspaceId,receipt.sessionId,receipt.requestId)+'.json'!==name||!Array.isArray(run.executions)||!run.inputs||!run.outputs)throw new Error('运行请求回执格式无效')
      parseWorkflow(run.graph)
      this.rows.set(name.slice(0,-5),run)
    }
  }
  private assertDirectory():void{const meta=lstatSync(this.directory);if(meta.isSymbolicLink()||!meta.isDirectory())throw new Error('运行请求回执目录无效')}
  get(workspaceId:string,sessionId:string|undefined,requestId:string):WorkflowRun|undefined{
    const row=this.rows.get(key(workspaceId,sessionId,requestId));return row?structuredClone(row):undefined
  }
  find(requestId:string,sessionId:string|undefined,match:(run:WorkflowRun)=>boolean):WorkflowRun|undefined{
    const row=[...this.rows.values()].find(run=>run.requestReceipt?.requestId===requestId&&run.requestReceipt.sessionId===sessionId&&match(run));return row?structuredClone(row):undefined
  }
  /** Keep admission plus the latest terminal receipt; ordinary progress stays in the run store. */
  save(run:WorkflowRun):void{
    const receipt=run.requestReceipt
    if(!receipt)return
    const identity=key(run.workspaceId,receipt.sessionId,receipt.requestId),prior=this.rows.get(identity)
    if(prior&&(prior.id!==run.id||prior.requestReceipt!.parametersDigest!==receipt.parametersDigest))throw new Error('REQUEST_ID_CONFLICT：运行请求回执身份冲突')
    if(prior&&['running','waiting','paused','pausing','budget_waiting'].includes(run.status))return
    mkdirSync(this.directory,{recursive:true,mode:0o700});this.assertDirectory()
    const file=join(this.directory,identity+'.json'),temp=join(this.directory,`write-${randomUUID()}.tmp`)
    if(existsSync(file)&&lstatSync(file).isSymbolicLink())throw new Error('运行请求回执路径无效')
    let fd:number|undefined
    try{
      fd=openSync(temp,'wx',0o600);writeFileSync(fd,JSON.stringify(run));fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temp,file)
      this.rows.set(identity,structuredClone(run))
    }finally{if(fd!==undefined)closeSync(fd);if(existsSync(temp))rmSync(temp)}
  }
}
export const validRequestId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value)
