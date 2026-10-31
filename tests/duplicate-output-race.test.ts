import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWorkflow, type WorkflowNode } from '../src/shared/types.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime, type ModelBackend } from '../src/host/runtime.ts'

const contexts:{path:string;runtime:WorkflowRuntime}[]=[]
const noModel:ModelBackend={generate:async()=>{throw new Error('确定性测试不得调用模型')}}
function n(id:string,kind:WorkflowNode['kind'],config:WorkflowNode['config']={}):WorkflowNode{return{id,kind,config,number:id,title:id,x:0,y:0,fixed:false}}
/** In-process engine double: the start node runs first, then every parallel
 * branch is dispatched before any of them completes, like two Graphon workers
 * finishing together. The first error fails the graph and aborts in-flight
 * callbacks exactly as the bridge does on a failed `complete` frame. */
function parallelEngine(runtime:WorkflowRuntime,order:string[]){
  ;(runtime as any).graphon={engine:{name:'graphon',version:'0.7.0',protocol:1},close:async()=>{},countTokens:async()=>({tokens:1,encoding:'mock',estimated:true}),
    execute:async(graph:any,signal:AbortSignal,call:any)=>{
      const controller=new AbortController(),abort=()=>controller.abort(signal.reason);signal.addEventListener('abort',abort,{once:true})
      try{
        await call(graph.nodes[0].id,controller.signal)
        let failure:string|undefined
        const calls=order.map(id=>Promise.resolve(call(id,controller.signal)).catch((error:unknown)=>{failure??=error instanceof Error?error.message:String(error);controller.abort(new Error(failure))}))
        await Promise.allSettled(calls)
        return failure?{status:'failed',error:failure}:{status:'success'}
      }finally{signal.removeEventListener('abort',abort)}
    }}
}
afterEach(async()=>{for(const context of contexts.splice(0)){await context.runtime.close();rmSync(context.path,{recursive:true,force:true})}})

describe('duplicate root output names',()=>{
  for(const order of [['a','b'],['b','a']])it(`fail deterministically with exactly one completed output when both branches finish together (${order.join(' then ')})`,async()=>{
    const path=mkdtempSync(join(tmpdir(),'duplicate-output-')),storage=new WorkflowStorage(path),runtime=new WorkflowRuntime(storage,noModel)
    contexts.push({path,runtime})
    const flow=makeWorkflow('ws','duplicate output race',true)
    flow.nodes=[n('start','input',{fields:[]}),n('a','output',{text:'first',outputName:'result'}),n('b','output',{text:'second',outputName:'result'})]
    flow.edges=[{id:'start_a',source:'start',target:'a'},{id:'start_b',source:'start',target:'b'}]
    storage.save(flow,0);parallelEngine(runtime,order)
    const run=await runtime.settle(runtime.start(flow.id,{}).id)
    const [winner,loser]=order as [string,string],record=(id:string)=>run.executions.find(item=>item.nodeId===id)!
    expect(run.status).toBe('failed')
    expect(run.error).toContain('输出名称「result」重复')
    expect(run.executions.filter(item=>item.nodeId!=='start'&&item.status==='success').map(item=>item.nodeId)).toEqual([winner])
    expect(record(loser)).toMatchObject({status:'failed'})
    expect(record(loser).error).toContain('重复')
    expect(run.outputs).toEqual({result:winner==='a'?'first':'second'})
  })
})
