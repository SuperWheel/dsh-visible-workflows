import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphonBridge, graphonRuntimeDirectory } from '../src/host/graphon.ts'
import type { NodeGraph, WorkflowNode } from '../src/shared/types.ts'

const instances:{bridge:GraphonBridge;directory:string}[]=[]
const deferred=<T=void>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes});return {promise,resolve}}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
function setup(){const directory=mkdtempSync(join(tmpdir(),'graphon-parallel-')),bridge=new GraphonBridge(graphonRuntimeDirectory(directory));instances.push({bridge,directory});return bridge}
function graph(paths:[string,string][]):NodeGraph{
  const names=[...new Set(paths.flat())]
  return {nodes:names.map(id=>({id,kind:id==='start'?'input':'tool',title:id,number:id,x:0,y:0,fixed:false,config:{}} as WorkflowNode)),edges:paths.map(([source,target],index)=>({id:`edge-${index}`,source,target}))}
}
afterEach(async()=>{for(const instance of instances.splice(0)){await instance.bridge.close();rmSync(instance.directory,{recursive:true,force:true})}})
describe('Graphon bounded branch workers',()=>{
  it('starts independent branches concurrently and joins only after both commit',async()=>{
    const bridge=setup(),started=deferred(),release=deferred(),called:string[]=[],completed:string[]=[]
    const work=bridge.execute(graph([['start','left'],['start','right'],['left','join'],['right','join']]),new AbortController().signal,async id=>{
      called.push(id)
      if(id==='left'||id==='right'){if(called.includes('left')&&called.includes('right'))started.resolve();await release.promise;completed.push(id)}
      if(id==='join')expect(completed.sort()).toEqual(['left','right'])
      return {data:{id}}
    },()=>{}, {maxWorkers:2})
    await started.promise;expect(called).not.toContain('join');release.resolve()
    expect((await work).status).toBe('success');expect(called.filter(id=>id==='join')).toHaveLength(1)
  })
  it('pause drains in-flight work without aborting it and does not admit downstream tasks',async()=>{
    const bridge=setup(),both=deferred(),release=deferred(),called:string[]=[],signals:AbortSignal[]=[]
    let finished=false
    const work=bridge.execute(graph([['start','slow'],['start','pause'],['slow','later'],['pause','other']]),new AbortController().signal,async(id,signal)=>{
      called.push(id)
      if(id==='slow'||id==='pause'){signals.push(signal);if(called.includes('slow')&&called.includes('pause'))both.resolve();await both.promise}
      if(id==='pause')return {data:{},control:'pause'}
      if(id==='slow')await release.promise
      return {data:{id}}
    },()=>{}, {maxWorkers:2}).then(result=>{finished=true;return result})
    await both.promise;await delay(150)
    expect(finished).toBe(false);expect(signals.every(signal=>!signal.aborted)).toBe(true)
    release.resolve();expect((await work).status).toBe('paused');expect(called).not.toContain('later');expect(called).not.toContain('other')
  })
  it('cancellation aborts both active callbacks and does not start their successors',async()=>{
    const bridge=setup(),controller=new AbortController(),both=deferred(),called:string[]=[],signals:AbortSignal[]=[]
    const work=bridge.execute(graph([['start','left'],['start','right'],['left','join'],['right','join']]),controller.signal,async(id,signal)=>{
      called.push(id)
      if(id==='left'||id==='right'){signals.push(signal);if(signals.length===2)both.resolve();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}
      return {data:{id}}
    },()=>{}, {maxWorkers:2})
    await both.promise;controller.abort(new Error('cancel test'));expect((await work).status).toBe('failed');expect(signals.every(signal=>signal.aborted)).toBe(true);expect(called).not.toContain('join')
  })
  it('rejects invalid concurrency before starting the engine',async()=>{
    const bridge=setup()
    for(const maxWorkers of [0,9,1.5])await expect(bridge.execute(graph([['start','end']]),new AbortController().signal,async()=>({data:{}}),()=>{},{maxWorkers})).rejects.toThrow('1–8')
  })
})
