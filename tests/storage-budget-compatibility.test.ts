import {afterEach,describe,expect,it} from 'vitest'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {WorkflowStorage} from '../src/host/storage.ts'
import {initializeUsage,recordUsageCall,settleUsage} from '../src/host/run-usage.ts'
import {makeWorkflow,type Workflow,type WorkflowRun} from '../src/shared/types.ts'

const directories:string[]=[],stores:WorkflowStorage[]=[]
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true})})
const open=(directory:string)=>{const store=new WorkflowStorage(directory);stores.push(store);return store}
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'storage-legacy-usage-'));directories.push(directory)
  const store=open(directory),graph=store.save(makeWorkflow('workspace'),0)
  return {directory,store,graph}
}
const run=(graph:Workflow,status:WorkflowRun['status']):WorkflowRun=>({id:randomUUID(),workflowId:graph.id,workspaceId:graph.workspaceId,workflowTitle:graph.title,sourceRevision:graph.revision,graph:structuredClone(graph),status,inputs:{},outputs:{},executions:[],startedAt:'2026-10-19T00:00:00.000Z'})
const legacyUsage=():NonNullable<WorkflowRun['usage']>=>({spentTokens:17,reservedTokens:300,unknownTokens:23,unknownCalls:2,agentTasks:1,calls:4,limit:1,allocations:{pending:{tokens:200,status:'reserved'},settled:{tokens:9,status:'settled',usage:17},unknown:{tokens:11,status:'unknown'}}})
const disk=(directory:string,id:string)=>({run:readFileSync(join(directory,'runs',id+'.json')),events:readFileSync(join(directory,'runs',id+'.events.jsonl'))})

describe('inert historical budget storage and live interruption',()=>{
  it('does not rewrite terminal or parked snapshots/events to settle old estimates, even after two restarts',()=>{
    const f=fixture(),statuses:WorkflowRun['status'][]=['success','failed','cancelled','interrupted','waiting','paused','budget_waiting']
    const values=statuses.map(status=>({...run(f.graph,status),usage:legacyUsage()}))
    for(const value of values)f.store.saveRun(value)
    const before=values.map(value=>disk(f.directory,value.id)),library=readFileSync(join(f.directory,'library.json'))
    f.store.close()
    for(let restart=0;restart<2;restart++){
      const reopened=open(f.directory)
      values.forEach((value,index)=>{expect(reopened.run(value.id)).toEqual(value);expect(disk(f.directory,value.id)).toEqual(before[index])})
      expect(readFileSync(join(f.directory,'library.json'))).toEqual(library)
      reopened.close()
    }
  })

  it.each(['running','pausing'] as const)('interrupts genuinely %s work once while leaving its old usage ledger exact',status=>{
    const f=fixture(),value=run(f.graph,status)
    value.usage=legacyUsage()
    value.executions=[{nodeId:f.graph.nodes[0]!.id,number:'1',title:'Already complete',status:'success',tokenUsage:17},{nodeId:f.graph.nodes[1]!.id,number:'2',title:'In flight',status:'running'}]
    f.store.saveRun(value)
    const previous=disk(f.directory,value.id),eventsBefore=previous.events.toString().trim().split('\n')
    f.store.close()
    const reopened=open(f.directory),interrupted=reopened.run(value.id)
    expect(interrupted.status).toBe('interrupted');expect(interrupted.endedAt).toBeDefined()
    expect(interrupted.usage).toEqual(value.usage)
    expect(interrupted.executions[0]).toEqual(value.executions[0])
    expect(interrupted.executions[1]).toMatchObject({status:'failed',error:'执行被中断',endedAt:interrupted.endedAt})
    const current=disk(f.directory,value.id),eventsAfter=current.events.toString().trim().split('\n')
    expect(eventsAfter.slice(0,-1)).toEqual(eventsBefore);expect(eventsAfter).toHaveLength(eventsBefore.length+1)
    reopened.close()
    const second=open(f.directory)
    expect(second.run(value.id)).toEqual(interrupted);expect(disk(f.directory,value.id)).toEqual(current)
  })

  it('round-trips the new zero-reservation usage ledger without inventing unknown tokens or a limit',()=>{
    const f=fixture(),value=run(f.graph,'success'),state=initializeUsage(value)
    const known=recordUsageCall(value,true),unknown=recordUsageCall(value,false),pending=recordUsageCall(value,false)
    settleUsage(value,known.id,{totalTokens:7});settleUsage(value,unknown.id,undefined)
    expect(state).not.toHaveProperty('limit')
    expect(state).toMatchObject({spentTokens:7,reservedTokens:0,unknownTokens:0,unknownCalls:1,calls:3,agentTasks:1})
    expect(state.allocations[pending.id]).toEqual({tokens:0,status:'reserved'})
    expect(state.allocations[unknown.id]).not.toHaveProperty('usage')
    f.store.saveRun(value);const before=disk(f.directory,value.id);f.store.close()
    const reopened=open(f.directory)
    expect(reopened.run(value.id)).toEqual(value);expect(disk(f.directory,value.id)).toEqual(before)
  })
})
