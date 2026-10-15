import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWorkflow, type NodeGraph, type Workflow, type WorkflowNode } from '../src/shared/types.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime, type ModelBackend, type ExecutionAdapters } from '../src/host/runtime.ts'
import { assertGraph, parseWorkflow } from '../src/host/validation.ts'
import { renumberWorkflow } from '../src/shared/numbering.ts'
import { createExecutionAdapters, httpRequest } from '../src/host/execution-adapters.ts'
import { ToolCatalog } from '../src/host/tool-catalog.ts'

const contexts:{path:string;runtime:WorkflowRuntime}[]=[]
const noModel:ModelBackend={generate:async()=>{throw new Error('确定性测试不得调用模型')}}
const model={provider:'test',model:'bounded'}
function setup(backend=noModel,adapters?:ExecutionAdapters){const path=mkdtempSync(join(tmpdir(),'expanded-workflow-')),storage=new WorkflowStorage(path),runtime=new WorkflowRuntime(storage,backend,adapters);contexts.push({path,runtime});return{storage,runtime,path}}
function n(id:string,kind:WorkflowNode['kind'],config:WorkflowNode['config']={}):WorkflowNode{return{id,kind,config,number:id,title:id,x:0,y:0,fixed:false}}
function graph(nodes:WorkflowNode[],edges?:NodeGraph['edges']):Workflow{const f=makeWorkflow('ws');return{...f,nodes,edges:edges??nodes.slice(1).map((v,i)=>({id:`e${i}`,source:nodes[i]!.id,target:v.id}))}}
const input=()=>n('start','input',{fields:[{name:'text',label:'文本',required:false}]})
function body(middle:WorkflowNode):NodeGraph{return{nodes:[n('child_in','input',{fields:[]}),middle],edges:[{id:'child_edge',source:'child_in',target:middle.id}]}}
async function execute(f:Workflow,inputs:Record<string,string>={},backend=noModel){const {storage,runtime}=setup(backend),saved=storage.save(f,0);return runtime.settle(runtime.start(saved.id,inputs).id)}
afterEach(async()=>{vi.useRealTimers();for(const c of contexts.splice(0)){await c.runtime.close();rmSync(c.path,{recursive:true,force:true})}})

describe('typed data, classification and deterministic transforms',()=>{
  it('typed boolean condition and ordered ELIF select only first matching branch',async()=>{
    const f=graph([n('in','input',{fields:[{name:'flag',label:'开关',type:'boolean',required:true}]}),n('if','if',{cases:[{id:'first',conditions:[{variable:'input.flag',operator:'equals',value:'false'}]},{id:'second',conditions:[{variable:'input.flag',operator:'not_empty'}]}]}),n('first','output',{text:'first',outputName:'one'}),n('second','output',{text:'second',outputName:'two'})],[{id:'e1',source:'in',target:'if'},{id:'e2',source:'if',target:'first',port:'first'},{id:'e3',source:'if',target:'second',port:'second'}])
    const run=await execute(f,{flag:'false'});expect(run.status).toBe('success');expect(run.outputs).toEqual({one:'first'});expect(run.executions.find(e=>e.nodeId==='second')?.status).toBe('skipped')
  })
  it('classifier validates model-selected ID instead of falling back to arbitrary category',async()=>{
    const f=graph([input(),n('classify','classifier',{model,prompt:'{{input.text}}',classes:[{id:'help',label:'使用',description:'如何使用'},{id:'refund',label:'售后',description:'退货退款'}]}),n('help','output',{text:'帮助',outputName:'help'}),n('refund','output',{text:'退款',outputName:'refund'})],[{id:'e1',source:'start',target:'classify'},{id:'e2',source:'classify',target:'help',port:'help'},{id:'e3',source:'classify',target:'refund',port:'refund'}])
    expect((await execute(f,{text:'退款'},{generate:async()=>'{"class_id":"refund"}'})).outputs).toEqual({refund:'退款'})
    const failed=await execute(f,{}, {generate:async()=>'{"class_id":"invented"}' });expect(failed.status).toBe('failed');expect(failed.error).toContain('类别 ID')
  })
  it('parameter extraction checks required fields and types and exposes success flag',async()=>{
    const f=graph([input(),n('extract','extractor',{model,prompt:'{{input.text}}',parameters:[{name:'count',type:'number',required:true}]}),n('out','output',{text:'{{extract.__is_success}}:{{extract.__reason}}'})])
    const invalid=await execute(f,{}, {generate:async()=>'{"count":"two"}'});expect(invalid.outputs.result).toContain('0:参数 count 应为 number')
    const valid=await execute(f,{}, {generate:async()=>'{"count":2}'});expect(valid.outputs.result).toBe('1:')
  })
  it('list filtering sorting and limiting preserve typed values and empty boundaries',async()=>{
    const f=graph([n('in','input',{fields:[{name:'items',label:'项',type:'json',required:true}]}),n('list','list',{listSource:'input.items',filter:{variable:'item',operator:'gte',value:'2'},sort:'desc',limit:2}),n('out','output',{text:'{{list.result}} / {{list.first_record}} / {{list.last_record}}'})])
    expect((await execute(f,{items:'[1,3,2,4]'})).outputs.result).toBe('[4,3] / 4 / 3')
    expect((await execute(f,{items:'[]'})).outputs.result).toBe('[] / null / null')
  })
  it('template loops conditions default and named object input are rendered without eval',async()=>{
    const f=graph([input(),n('template','template',{inputs:{items:[{name:'Ada'},{name:'Lin'}],meta:{'display-name':'test'}},text:'{% for entry in items %}{% if loop.first %}First: {% endif %}{{entry.name|upper}};{% endfor %}{{ missing | default("done") }} {{meta["display-name"]}}'}),n('out','output',{text:'{{template.text}}'})])
    const run=await execute(f);expect(run.status).toBe('success');expect(run.outputs.result).toBe('First: ADA;LIN;done test')
    f.nodes[1]!.config.text='{{constructor.constructor("return process")()}}';expect((await execute(f)).status).toBe('failed')
  })
  it('aggregator preserves false from executed branch and rejects merging parallel alternatives',async()=>{
    const f=graph([input(),n('condition','if',{variable:'input.text',operator:'equals',value:'yes'}),n('left','llm',{model,prompt:'left',outputSchema:[{name:'value',type:'boolean'}]}),n('right','llm',{model,prompt:'right',outputSchema:[{name:'value',type:'boolean'}]}),n('merge','aggregator',{groups:[{name:'picked',variables:['left.value','right.value']}]}),n('out','output',{text:'{{merge.picked}}'})],[{id:'e1',source:'start',target:'condition'},{id:'e2',source:'condition',target:'left',port:'true'},{id:'e3',source:'condition',target:'right',port:'false'},{id:'e4',source:'left',target:'merge'},{id:'e5',source:'right',target:'merge'},{id:'e6',source:'merge',target:'out'}])
    const run=await execute(f,{text:'yes'},{generate:async()=>'{"value":false}'});expect(run.outputs.result).toBe('false')
    f.edges=f.edges.filter(e=>e.source!=='condition');f.edges.push({id:'p1',source:'start',target:'left'},{id:'p2',source:'start',target:'right'});expect((await execute(f,{}, {generate:async()=>'{"value":false}'})).error).toContain('实际为 2')
  })
})

describe('Human Input durable checkpoints',()=>{
  it('pauses after earlier tool, snapshots rendered defaults, resumes after restart without duplicate side effects',async()=>{
    let calls=0;const adapters:ExecutionAdapters={execute:async()=>{calls++;return{text:'external result'}}}
    const {storage,runtime,path}=setup(noModel,adapters)
    const f=storage.save(graph([input(),n('tool','tool',{toolId:'test-effect'}),n('human','human',{prompt:'确认 {{tool.text}}',fields:[{name:'review',label:'审核',required:true,defaultValue:'{{tool.text}}'}],actions:[{id:'approve',label:'通过'},{id:'reject',label:'退回'}]}),n('out','output',{text:'{{human.review}}'})]),0)
    const first=await runtime.settle(runtime.start(f.id,{}).id);expect(first.status).toBe('waiting');expect(first.humanPrompt).toBe('确认 external result');expect(first.missingFields?.[0]?.defaultValue).toBe('external result');expect(calls).toBe(1)
    await runtime.close();const reopened=new WorkflowStorage(path),continued=new WorkflowRuntime(reopened,noModel,adapters);contexts.push({path,runtime:continued})
    expect(()=>continued.answer(first.id,{review:'ok'})).toThrow('有效的人工操作')
    const done=await continued.settle(continued.answer(first.id,{review:'ok',__action:'approve'}).id)
    expect(done.status).toBe('success');expect(done.outputs.result).toBe('ok');expect(calls).toBe(1)
    expect(()=>continued.answer(first.id,{review:'again',__action:'approve'})).toThrow('不再等待')
  })
  it('human without fields still pauses and routes selected action only',async()=>{
    const {storage,runtime}=setup(),f=storage.save(graph([input(),n('human','human',{fields:[],actions:[{id:'yes',label:'确认'},{id:'no',label:'取消'}]}),n('yes','output',{text:'yes',outputName:'yes'}),n('no','output',{text:'no',outputName:'no'})],[{id:'e1',source:'start',target:'human'},{id:'e2',source:'human',target:'yes',port:'yes'},{id:'e3',source:'human',target:'no',port:'no'}]),0)
    const run=await runtime.settle(runtime.start(f.id,{}).id);expect(run.status).toBe('waiting');expect(run.missingFields).toEqual([])
    expect((await runtime.settle(runtime.answer(run.id,{__action:'no'}).id)).outputs).toEqual({no:'no'})
  })
  it('timeout follows its own port and never follows a normal default path',async()=>{
    vi.useFakeTimers()
    const {storage,runtime}=setup(),f=storage.save(graph([input(),n('human','human',{fields:[],timeoutSeconds:1,actions:[{id:'ok',label:'继续'}]}),n('normal','output',{text:'normal',outputName:'normal'}),n('timeout','output',{text:'timeout',outputName:'timeout'})],[{id:'e1',source:'start',target:'human'},{id:'e2',source:'human',target:'normal'},{id:'e3',source:'human',target:'timeout',port:'timeout'}]),0)
    const waiting=await runtime.settle(runtime.start(f.id,{}).id);expect(waiting.status).toBe('waiting');await vi.advanceTimersByTimeAsync(1001)
    const done=await runtime.settle(waiting.id);expect(done.status).toBe('success');expect(done.outputs).toEqual({timeout:'timeout'})
  })
})

describe('containers execute actual nested graphs',()=>{
  it.each(['terminate','null','remove'] as const)('iteration failure mode %s has its declared result',async errorMode=>{
    const inner:NodeGraph={nodes:[n('child_in','input',{fields:[]}),n('check','if',{variable:'item',operator:'equals',value:'2'}),n('bad','template',{text:'{{not_found.text}}'}),n('good','template',{text:'result-{{item}}'}),n('merge','aggregator',{groups:[{name:'result',variables:['bad.text','good.text']} ]})],edges:[{id:'i1',source:'child_in',target:'check'},{id:'i2',source:'check',target:'bad',port:'true'},{id:'i3',source:'check',target:'good',port:'false'},{id:'i4',source:'bad',target:'merge'},{id:'i5',source:'good',target:'merge'}]}
    const f=graph([input(),n('iterate','iteration',{iterator:'[1,2,3]',body:inner,outputVariable:'merge.result',errorMode}),n('out','output',{text:'{{iterate.result}}'})])
    const run=await execute(f)
    if(errorMode==='terminate')expect(run.status).toBe('failed')
    else expect(JSON.parse(run.outputs.result!)).toEqual(errorMode==='null'?['result-1',null,'result-3']:['result-1','result-3'])
  })
  it('parallel iteration honors concurrency and preserves input order',async()=>{
    let active=0,max=0
    const backend:ModelBackend={generate:async request=>{active++;max=Math.max(active,max);await new Promise(r=>setTimeout(r,request.prompt==='0'?20:2));active--;return request.prompt}}
    const f=graph([input(),n('iterate','iteration',{iterator:'[0,1,2,3]',parallel:true,concurrency:2,body:body(n('call','llm',{model,prompt:'{{item}}'})),outputVariable:'call.text'}),n('out','output',{text:'{{iterate.result}}'})])
    expect((await execute(f,{},backend)).outputs.result).toBe('["0","1","2","3"]');expect(max).toBe(2)
  })
  it('empty iteration does not invoke any child',async()=>{
    const f=graph([input(),n('iterate','iteration',{iterator:'[]',body:body(n('call','llm',{model,prompt:'must not call'})),outputVariable:'call.text'}),n('out','output',{text:'{{iterate.result}}'})]);const run=await execute(f);expect(run.outputs.result).toBe('[]');expect(run.executions.some(e=>e.nodeId==='call')).toBe(false)
  })
  it('loop retains variables and exits by condition before maximum',async()=>{
    const f=graph([input(),n('loop','loop',{initialVariables:{count:0},maxIterations:10,until:{variable:'vars.count',operator:'gte',value:'3'},body:body(n('increment','assigner',{assignments:[{name:'count',operation:'add',value:1}]}))}),n('out','output',{text:'{{loop.variables.count}} / {{loop.iterations}}'})]);const run=await execute(f);expect(run.status).toBe('success');expect(run.outputs.result).toBe('3 / 3');expect(run.executions.filter(e=>e.nodeId==='increment')).toHaveLength(3)
  })
  it('Exit Loop stops only current loop and outer downstream receives final state',async()=>{
    const inner:NodeGraph={nodes:[n('child_in','input',{fields:[]}),n('increment','assigner',{assignments:[{name:'count',operation:'add',value:1}]}),n('check','if',{variable:'vars.count',operator:'gte',value:'2'}),n('exit','exit_loop',{}),n('after','template',{text:'not after exit'})],edges:[{id:'a',source:'child_in',target:'increment'},{id:'b',source:'increment',target:'check'},{id:'c',source:'check',target:'exit',port:'true'},{id:'d',source:'check',target:'after',port:'false'}]}
    const run=await execute(graph([input(),n('loop','loop',{initialVariables:{count:0},maxIterations:10,body:inner}),n('out','output',{text:'{{loop.variables.count}}'})]));expect(run.outputs.result).toBe('2');expect(run.executions.filter(e=>e.nodeId==='increment')).toHaveLength(2)
  })
  it('cached Exit Loop remains terminal when a later Human Input resumes the workflow',async()=>{
    let calls=0;const {storage,runtime}=setup(noModel,{execute:async()=>({text:String(++calls)})})
    const inner:NodeGraph={nodes:[n('child_in','input',{fields:[]}),n('call','tool',{toolId:'count'}),n('exit','exit_loop')],edges:[{id:'a',source:'child_in',target:'call'},{id:'b',source:'call',target:'exit'}]}
    const f=storage.save(graph([input(),n('loop','loop',{initialVariables:{},maxIterations:5,body:inner}),n('human','human',{fields:[],actions:[{id:'go',label:'继续'}]}),n('out','output',{text:'{{loop.iterations}}'})]),0)
    const waiting=await runtime.settle(runtime.start(f.id,{}).id);expect(calls).toBe(1)
    const done=await runtime.settle(runtime.answer(waiting.id,{__action:'go'}).id);expect(done.status).toBe('success');expect(done.outputs.result).toBe('1');expect(calls).toBe(1)
  })
  it('Human pause inside loop resumes checkpoint without repeating previous tools or losing variables',async()=>{
    let calls=0;const {storage,runtime}=setup(noModel,{execute:async()=>({text:String(++calls)})})
    const inner:NodeGraph={nodes:[n('child_in','input',{fields:[]}),n('call','tool',{toolId:'count'}),n('increment','assigner',{assignments:[{name:'count',operation:'add',value:1}]}),n('human','human',{prompt:'轮次 {{index}}',fields:[],actions:[{id:'go',label:'继续'}]})],edges:[{id:'a',source:'child_in',target:'call'},{id:'b',source:'call',target:'increment'},{id:'c',source:'increment',target:'human'}]}
    const f=storage.save(graph([input(),n('loop','loop',{initialVariables:{count:0},maxIterations:2,body:inner}),n('out','output',{text:'{{loop.variables.count}}'})]),0)
    let run=await runtime.settle(runtime.start(f.id,{}).id);expect(run.humanPrompt).toBe('轮次 0');expect(calls).toBe(1)
    run=await runtime.settle(runtime.answer(run.id,{__action:'go'}).id);expect(run.humanPrompt).toBe('轮次 1');expect(calls).toBe(2)
    run=await runtime.settle(runtime.answer(run.id,{__action:'go'}).id);expect(run.outputs.result).toBe('2');expect(calls).toBe(2)
  })
})

describe('uploaded files remain private run-owned references',()=>{
  it('extracts a 300 KB uploaded document through the production adapter and keeps upload bytes out of logs',async()=>{
    const path=mkdtempSync(join(tmpdir(),'uploaded-document-')),storage=new WorkflowStorage(path)
    const catalog=new ToolCatalog({directory:path,workflows:id=>storage.workflows(id),nativeTools:()=>[],executeNative:async()=>{throw new Error('no native tools')},runWorkflow:async()=>{throw new Error('no nested workflow')},http:httpRequest})
    const runtime=new WorkflowRuntime(storage,noModel,createExecutionAdapters({catalog,workspaceRoot:()=>path,readAttachment:(runId,fileId)=>storage.readAttachment(runId,fileId)}));contexts.push({path,runtime})
    const f=storage.save(graph([n('in','input',{fields:[{name:'file',label:'文件',required:true,type:'file'}]}),n('doc','document',{source:'input.file'}),n('out','output',{text:'{{doc.characters}}'})]),0)
    const content='source-data-'.repeat(25000),base64=Buffer.from(content).toString('base64')
    const done=await runtime.settle(runtime.start(f.id,{file:JSON.stringify({name:'large.txt',mimeType:'text/plain',base64})}).id)
    expect(done.status).toBe('success');expect(done.outputs.result).toBe('300000');expect(done.executions.find(e=>e.nodeId==='doc')?.data?.text).toBe(content);expect(JSON.stringify(done)).not.toContain(base64.slice(0,500));expect(done.executions.find(e=>e.nodeId==='doc')?.input).toContain('workflowFileId')
  })
  it('accepts a 300 KB file as metadata and never returns base64 in the run',async()=>{
    const {storage,runtime}=setup(),content='source-data-'.repeat(25000),base64=Buffer.from(content).toString('base64')
    const f=storage.save(graph([n('in','input',{fields:[{name:'file',label:'文件',required:true,type:'file'}]}),n('out','output',{text:'{{input.file.name}} / {{input.file.size}}'})]),0)
    const done=await runtime.settle(runtime.start(f.id,{file:JSON.stringify({name:'large.txt',mimeType:'text/plain',base64})}).id)
    expect(done.status).toBe('success');expect(done.outputs.result).toBe('large.txt / 300000');expect(JSON.stringify(done).length).toBeLessThan(10000);expect(JSON.stringify(done)).not.toContain(base64.slice(0,500))
    const ref=JSON.parse(done.inputs.file!) as {workflowFileId:string};expect(Buffer.from(storage.readAttachment(done.id,ref.workflowFileId).base64,'base64').toString()).toBe(content)
    const second=await runtime.settle(runtime.start(f.id,{file:JSON.stringify({name:'other.txt',mimeType:'text/plain',base64:Buffer.from('other').toString('base64')})}).id)
    expect(()=>storage.readAttachment(second.id,ref.workflowFileId)).toThrow('不属于本次运行')
    expect(()=>runtime.start(f.id,{file:JSON.stringify(ref)})).toThrow()
  })
})

describe('nested schema and protections',()=>{
  it('numbering is unique across body boundaries and keeps UUID references stable',()=>{
    const f=graph([input(),n('loop','loop',{maxIterations:1,body:body(n('template','template',{text:'{{start.text}}'}))}),n('out','output',{text:'{{loop.text}}'})]);const numbered=renumberWorkflow(f),child=numbered.nodes[1]!.config.body!;const numbers=[...numbered.nodes,...child.nodes].map(n=>n.number);expect(new Set(numbers).size).toBe(numbers.length);expect(child.nodes[1]!.config.text).toBe('{{start.text}}');expect(child.nodes[1]!.id).toBe('template')
  })
  it('duplicate nested UUIDs and Exit Loop outside loop are rejected',()=>{
    const f=graph([input(),n('iteration','iteration',{iterator:'[]',outputVariable:'start.text',body:body(n('start','template',{text:'bad'}))})]);expect(()=>assertGraph(parseWorkflow(f),true)).toThrow('身份重复')
    expect(()=>assertGraph(graph([input(),n('exit','exit_loop')]),true)).toThrow('循环内部')
  })
  it('fixed nested node cannot be edited or bypassed by removing/changing its container',()=>{
    const {storage}=setup(),fixed=n('fixed','template',{text:'locked'});fixed.fixed=true
    const saved=storage.save(graph([input(),n('loop','loop',{initialVariables:{},maxIterations:2,body:body(fixed)})]),0)
    const edited=structuredClone(saved);edited.nodes[1]!.config.body!.nodes[1]!.config.text='changed';expect(()=>storage.save(edited,1,'agent')).toThrow('已固定')
    const count=structuredClone(saved);count.nodes[1]!.config.maxIterations=1;expect(()=>storage.save(count,1,'agent')).toThrow('已固定')
    const removed=structuredClone(saved);removed.nodes=removed.nodes.filter(n=>n.id!=='loop');removed.edges=[];expect(()=>storage.save(removed,1,'agent')).toThrow('已固定')
  })
})
