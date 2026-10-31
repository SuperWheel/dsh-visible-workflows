import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeWorkflow, type Workflow, type WorkflowNode, type WorkflowRun } from '../src/shared/types.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { createExecutionAdapters, httpRequest } from '../src/host/execution-adapters.ts'
import { ToolCatalog } from '../src/host/tool-catalog.ts'
import { changedNodeIds, latestRunFor, matchTargets, requestQuotes, sampleValue, numberDraftRevisions, wrapFlatNodeForms } from '../src/host/revise-locate.ts'

const instances:{runtime:WorkflowRuntime;directory:string}[]=[]
afterEach(async()=>{for(const {runtime,directory} of instances.splice(0)){await runtime.close();rmSync(directory,{recursive:true,force:true})}})
const node=(id:string,kind:WorkflowNode['kind'],config:WorkflowNode['config']={}):WorkflowNode=>({id,kind,config,number:id,title:id,fixed:false,x:0,y:0})
const edge=(source:string,target:string)=>({id:`${source}_${target}`,source,target})
const code=(body:string,inputs:Record<string,string>={})=>({language:'javascript' as const,code:`function main(inputs){${body}}`,inputs,outputSchema:[{name:'rows',type:'array' as const,required:true}]})
const table='| 文件名 | 字节数 |\n| --- | --- |\n{% for item in stat.rows %}| {{item.name}} | {{item.bytes}} |\n{% endfor %}'
const E_REQUEST='修改已保存的工作流「T18 CSV 统计 r55」：Markdown 表格在「字节数」后面增加一列「扩展名」（例如 csv），其他保持不变，只改需要改的节点。'

function setup(){
  const directory=mkdtempSync(join(tmpdir(),'revise-replay-')),storage=new WorkflowStorage(directory)
  const catalog=new ToolCatalog({directory,workflows:id=>storage.workflows(id),nativeTools:()=>[],executeNative:async()=>{throw new Error('no tools in this fixture')},runWorkflow:async()=>{throw new Error('no child workflows')},http:httpRequest})
  const runtime=new WorkflowRuntime(storage,{generate:async()=>{throw new Error('no model calls in a replay')}},createExecutionAdapters({catalog,workspaceRoot:()=>directory}))
  instances.push({runtime,directory})
  const saved=storage.save({...makeWorkflow('audit'),title:'CSV 统计',nodes:[
    node('start','input'),
    node('stat','code',code("return {rows:[{name:'a.csv',bytes:10},{name:'notes',bytes:3}]}")),
    node('table','template',{text:table}),
    node('out','output',{text:'{{table.text}}',outputName:'result'}),
  ],edges:[edge('start','stat'),edge('stat','table'),edge('table','out')]},0)
  return {storage,runtime,saved}
}
/** Desktop r61 E's change: a code node adds ext, the table reads it with one more column, a model step reads the table. */
function candidate(saved:Workflow,ext:string):Workflow{
  const flow=structuredClone(saved)
  flow.nodes=[...flow.nodes.filter(item=>item.id!=='table'&&item.id!=='out'),
    node('ext','code',code(ext,{rows:'{{stat.rows}}'})),
    node('table','template',{text:'| 文件名 | 字节数 | 扩展名 |\n| --- | --- | --- |\n{% for item in ext.rows %}| {{item.name}} | {{item.bytes}} | {{item.ext}} |\n{% endfor %}'}),
    node('out','output',{text:'{{table.text}}',outputName:'result'}),
    node('summary','llm',{prompt:'{{table.text}}'}),
  ]
  flow.edges=[edge('start','stat'),edge('stat','ext'),edge('ext','table'),edge('table','out'),edge('table','summary')]
  return flow
}
const ADD_EXT="return {rows:inputs.rows.map(function(row){var dot=row.name.lastIndexOf('.');return Object.assign({},row,{ext:dot>0?row.name.slice(dot+1):''})})}"

describe('T37 replay of a revised chain on the last run (Desktop r61 E)',()=>{
  it('reruns the added code node and the changed table on recorded rows, stops at the model step and saves nothing',async()=>{
    const {storage,runtime,saved}=setup(),source=await runtime.settle(runtime.start(saved.id,{}).id)
    expect(source.status).toBe('success')
    const next=candidate(saved,ADD_EXT),before=storage.runs().length
    const steps=await runtime.replay(source,next,changedNodeIds(saved,next),new AbortController().signal)
    expect(steps.map(step=>[step.nodeId,step.status])).toEqual([['ext','success'],['table','success'],['out','success'],['summary','not-replayed']])
    expect(steps[1]!.output).toEqual({text:'| 文件名 | 字节数 | 扩展名 |\n| --- | --- | --- |\n| a.csv | 10 | csv |\n| notes | 3 |  |\n'})
    expect(steps[3]!.reason).toContain('有副作用或需要模型')
    expect(storage.runs().length).toBe(before)
    expect(storage.run(source.id).executions.find(record=>record.nodeId==='table')!.data!.text).not.toContain('扩展名')
  })
  it('reports the failing node and does not run its readers on stale data',async()=>{
    const {runtime,saved}=setup(),source=await runtime.settle(runtime.start(saved.id,{}).id)
    const next=candidate(saved,"throw new Error('ext broke')")
    const steps=await runtime.replay(source,next,changedNodeIds(saved,next),new AbortController().signal)
    expect(steps[0]).toMatchObject({nodeId:'ext',status:'failed',error:expect.stringContaining('ext broke')})
    expect(steps[1]).toMatchObject({nodeId:'table',status:'not-replayed',reason:'上游没有可用结果：ext'})
    // An unchanged reader of a node that did not run is left out; the new model step is still listed.
    expect(steps.map(step=>step.nodeId)).toEqual(['ext','table','summary'])
  })
})

describe('T37 locate pack helpers',()=>{
  it('takes the quoted words of E without the workflow title and finds the table that holds them',()=>{
    const quotes=requestQuotes(E_REQUEST,'T18 CSV 统计 r55')
    expect(quotes).toEqual(['字节数','扩展名'])
    const flow={...makeWorkflow('audit'),nodes:[node('start','input'),node('table','template',{text:table}),node('write','tool',{toolId:'builtin:file.write',inputs:{content:'{{table.text}}'}})],edges:[]}
    expect(matchTargets(flow,E_REQUEST,quotes).map(({node,matched})=>[node.id,matched])).toEqual([['table',['字节数']]])
    expect(matchTargets(flow,'把 write 改成追加',[]).map(({node})=>node.id)).toEqual(['write'])
  })
  it('keeps a few rows of a recorded result and drops the JSON text copy',()=>{
    const rows=Array.from({length:5},(_,index)=>({name:`f${index}.csv`,bytes:index}))
    expect(sampleValue({text:JSON.stringify(rows),result:rows,json:rows})).toEqual({result:[...rows.slice(0,3),'…共 5 项']})
    expect(sampleValue({text:'x'.repeat(1300)})).toEqual({text:'x'.repeat(1200)+'…（共 1300 字）'})
  })
  it('prefers a run of the current revision, then the newest, and skips runs with no node results',()=>{
    const flow={...makeWorkflow('audit'),id:'w',revision:3}
    const run=(id:string,revision:number,startedAt:string,ok=true)=>({id,workflowId:'w',sourceRevision:revision,startedAt,executions:ok?[{nodeId:'a',number:'a',title:'a',status:'success',data:{text:'x'}}]:[]}) as unknown as WorkflowRun
    expect(latestRunFor([run('old',2,'2026-10-30T02:00:00Z'),run('cur',3,'2026-10-30T01:00:00Z')],flow)?.id).toBe('cur')
    expect(latestRunFor([run('cur-empty',3,'2026-10-30T03:00:00Z',false),run('old',2,'2026-10-30T02:00:00Z')],flow)?.id).toBe('old')
  })
  it('moves a new node written flat on an insert into nodes, and leaves every other shape to the contract (Desktop r64 E)',()=>{
    const values={language:'javascript',code:'function main(inputs){return {rows:[]}}'}
    const update={op:'update',draftRevision:1,target:'a-1',values:{text:'x'}}
    expect(wrapFlatNodeForms({operations:[{op:'insert',draftRevision:0,target:'a-1',position:'before',key:'rows_with_ext',template:'code',title:'补充扩展名字段',values},update]})).toEqual({operations:[
      {op:'insert',draftRevision:0,target:'a-1',position:'before',nodes:[{key:'rows_with_ext',template:'code',values,title:'补充扩展名字段'}]},update]})
    const mixed={op:'insert',draftRevision:0,target:'a-1',position:'before',key:'x',template:'code',values,nodes:[]},keyless={op:'replace',draftRevision:0,target:'a-1',template:'code',values}
    expect(wrapFlatNodeForms({operations:[mixed,keyless]})).toEqual({operations:[mixed,keyless]})
    expect(wrapFlatNodeForms('not a chain')).toBe('not a chain')
  })
  it('numbers operations that all left out draftRevision in the order given, and leaves a partly numbered list alone (Desktop r65 E)',()=>{
    const operations=[{op:'insert',target:'a-1',position:'before',nodes:[]},{op:'update',target:'a-1',values:{text:'x'}},{op:'update',target:'n9',values:{code:'y'}}]
    expect((numberDraftRevisions({operations}) as any).operations.map((operation:any)=>operation.draftRevision)).toEqual([0,1,2])
    const partly={operations:[{...operations[0],draftRevision:0},operations[1]]}
    expect(numberDraftRevisions(partly)).toBe(partly)
  })
})
