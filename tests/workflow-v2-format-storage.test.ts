import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeWorkflow, newId, type WorkflowRun } from '../src/shared/types.ts'
import { assertGraph, parseWorkflow, protectFixedNodes } from '../src/host/validation.ts'
import { exportWorkflowJson, importWorkflowJson } from '../src/shared/workflow-format.ts'
import { assertNoSystemOverrides, createSystemVariables, environmentSnapshot, environmentVariableStatus } from '../src/shared/workflow-variables.ts'
import { WorkflowStorage } from '../src/host/storage.ts'

const directories:string[]=[],stores:WorkflowStorage[]=[]
function directory(){const value=mkdtempSync(join(tmpdir(),'workflow-v2-store-'));directories.push(value);return value}
function store(path=directory()){const value=new WorkflowStorage(path);stores.push(value);return value}
function run(graph=makeWorkflow('workspace')):WorkflowRun{return {id:newId(),workflowId:graph.id,workspaceId:graph.workspaceId,workflowTitle:graph.title,sourceRevision:graph.revision,graph,status:'running',inputs:{text:'test'},outputs:{},executions:[],startedAt:new Date().toISOString()}}
afterEach(()=>{for(const value of stores.splice(0))value.close();for(const value of directories.splice(0))rmSync(value,{recursive:true,force:true})})

describe('v2 variables and namespace boundaries',()=>{
  it('accepts typed ordinary values and rejects secret value, binding or unknown material',()=>{
    const flow=makeWorkflow('workspace')
    for(const extra of [{value:'secret'}, {binding:'opaque'}, {ciphertext:'encrypted'}, {state:'configured'}])expect(()=>parseWorkflow({...flow,environmentVariables:[{id:'secret-id',name:'API_KEY',type:'secret',...extra}]})).toThrow()
    const parsed=parseWorkflow({...flow,environmentVariables:[{id:'str',name:'_BASE',type:'string',value:''},{id:'num',name:'COUNT',type:'number',value:0},{id:'secret',name:'KEY',type:'secret'}]})
    expect(environmentSnapshot(parsed)).toEqual({str:'',num:0})
    expect(environmentVariableStatus(parsed.environmentVariables![2]!)).toBe('unavailable')
    expect(()=>parseWorkflow({...flow,environmentVariables:[{id:'num',name:'COUNT',type:'number',value:'3'}]})).toThrow()
  })
  it('stable env references survive names changing and reject missing or secret references before save',()=>{
    const flow=makeWorkflow('workspace',undefined,true)
    flow.environmentVariables=[{id:'stable-id',name:'OLD',type:'string',value:'ok'},{id:'private',name:'TOKEN',type:'secret'}]
    flow.nodes[1]!.config.text='{{env.stable-id}} {{sys.workflow_id}}'
    expect(()=>assertGraph(flow)).not.toThrow()
    flow.environmentVariables[0]!.name='NEW'
    expect(()=>assertGraph(flow)).not.toThrow()
    for(const reference of ['env.OLD','env','env.private','sys.user_id','sys.constructor']){flow.nodes[1]!.config.text=`{{${reference}}}`;expect(()=>assertGraph(flow)).toThrow()}
  })
  it('rejects duplicate declarations and required missing values',()=>{
    const flow=makeWorkflow('workspace')
    flow.environmentVariables=[{id:'one',name:'VALUE',type:'string',required:true},{id:'two',name:'VALUE',type:'number'}]
    expect(()=>assertGraph(flow)).toThrow('名称重复')
    flow.environmentVariables.pop()
    expect(()=>environmentSnapshot(flow)).toThrow('尚未配置')
  })
  it('rejects input identity spoofing and builds a trusted stable system snapshot',()=>{
    for(const key of ['sys','sys.workflow_run_id','env','env.key'])expect(()=>assertNoSystemOverrides({[key]:'fake'})).toThrow('不得覆盖')
    const value=createSystemVariables({workflowId:'flow',workspaceId:'ws',runId:'run',startedAt:'2026-10-16T00:00:00.999Z'})
    expect(value).toEqual({workflow_id:'flow',workspace_id:'ws',workflow_run_id:'run',session_id:null,timestamp:1792108800})
    expect(()=>createSystemVariables({workflowId:'flow',workspaceId:'',runId:'run',startedAt:'invalid'})).toThrow()
  })
  it('prevents agents bypassing fixed config through referenced environment changes',()=>{
    const before=makeWorkflow('workspace',undefined,true)
    before.environmentVariables=[{id:'stable',name:'VALUE',type:'string',value:'old'}]
    before.nodes[1]!.fixed=true;before.nodes[1]!.config.text='{{env.stable}}'
    const after=structuredClone(before);after.environmentVariables![0]!.value='new'
    expect(()=>protectFixedNodes(before,after)).toThrow('环境变量不能由 Agent 修改')
  })
})
describe('v2 portable JSON',()=>{
  it('roundtrips graph references, env IDs, roles, nested edges and note anchors to fresh identities',()=>{
    const flow=makeWorkflow('workspace',undefined,true)
    flow.environmentVariables=[{id:'region',name:'REGION',type:'string',value:'cn'},{id:'secret',name:'KEY',type:'secret'}]
    flow.nodes[1]!.config.text='{{env.region}} {{input.text}}'
    flow.notes=[{id:'note',text:'说明',x:1,y:2,anchorNodeId:flow.nodes[1]!.id}]
    const imported=importWorkflowJson(exportWorkflowJson(flow,{includeEnvironmentValues:true}),'other-workspace').workflow
    expect(imported.id).not.toBe(flow.id);expect(imported.workspaceId).toBe('other-workspace')
    expect(imported.nodes[2]!.config.text).toBe(`{{${imported.nodes[1]!.id}.text}}`)
    expect(imported.nodes[1]!.config.text).toContain(`env.${imported.environmentVariables![0]!.id}`)
    expect(imported.environmentVariables![0]!.value).toBe('cn')
    expect(imported.notes[0]!.anchorNodeId).toBe(imported.nodes[1]!.id)
    expect(imported.edges[0]!.target).toBe(imported.nodes[1]!.id)
    expect(()=>assertGraph(imported,true)).not.toThrow()
  })
  it('excludes ordinary values by default and strips managed attachment handles and local paths',()=>{
    const flow=makeWorkflow('workspace',undefined,true)
    flow.environmentVariables=[{id:'region',name:'REGION',type:'string',value:'not-shared'}]
    flow.nodes[1]!.kind='document';flow.nodes[1]!.config={source:'/private/private-document.txt',inputs:{file:{path:'/private/private-document.txt',workflowFileId:'host-handle',base64:'c2VjcmV0'}}}
    const json=exportWorkflowJson(flow)
    expect(json).not.toContain('not-shared');expect(json).not.toContain('/private/');expect(json).not.toContain('host-handle');expect(json).not.toContain('c2VjcmV0')
    expect(JSON.parse(json).dependencies).toContainEqual(expect.objectContaining({kind:'file'}))
  })
  it('bundles role prompts and preserves missing role declarations for later configuration',()=>{
    const flow=makeWorkflow('workspace',undefined,true)
    flow.nodes[1]!.kind='llm';flow.nodes[1]!.config={prompt:'review',rolePresetId:'reviewer',model:{provider:'host',model:'model'}}
    const pending=importWorkflowJson(exportWorkflowJson(flow),'target')
    expect(pending.workflow.nodes[1]!.config.rolePresetId).toBe('reviewer')
    expect(pending.presets).toEqual([])
    expect(pending.warnings.join('\n')).toContain('缺少角色预设')
    const imported=importWorkflowJson(exportWorkflowJson(flow,{presets:[{id:'reviewer',name:'Reviewer',prompt:'Be exact',revision:3}]}),'target')
    expect(imported.presets[0]!.id).not.toBe('reviewer');expect(imported.workflow.nodes[1]!.config.rolePresetId).toBe(imported.presets[0]!.id);expect(imported.presets[0]!.prompt).toBe('Be exact')
  })
  it('rewrites executable references without changing code, literal data or explanatory text',()=>{
    const flow=makeWorkflow('workspace',undefined,true),producer=flow.nodes[1]!.id
    flow.title=`${producer}.text`;flow.nodes[1]!.kind='code';flow.nodes[1]!.config={language:'javascript',code:`function main(){return {text:'${producer}.text'}}`,inputs:{literal:`${producer}.text`}}
    const imported=importWorkflowJson(exportWorkflowJson(flow),'target').workflow
    expect(imported.title).toBe(flow.title);expect(imported.nodes[1]!.config.code).toBe(flow.nodes[1]!.config.code);expect(imported.nodes[1]!.config.inputs?.literal).toBe(`${producer}.text`)
    expect(imported.nodes[2]!.config.text).toBe(`{{${imported.nodes[1]!.id}.text}}`)
  })
  it('rejects future versions, unknown node config, forged runtime contexts and excessive depth',()=>{
    const data=JSON.parse(exportWorkflowJson(makeWorkflow('workspace')))
    expect(()=>importWorkflowJson(JSON.stringify({...data,formatVersion:3}),'target')).toThrow('不支持')
    expect(()=>importWorkflowJson(JSON.stringify({...data,systemVariables:{user_id:'forged'}}),'target')).toThrow()
    data.workflow.nodes[0].config.unknown='hidden'
    expect(()=>importWorkflowJson(JSON.stringify(data),'target')).toThrow()
    expect(()=>importWorkflowJson('['.repeat(34)+'0'+']'.repeat(34),'target')).toThrow('嵌套')
  })
})
describe('current-only storage and durable records',()=>{
  it('rejects schema 1 without rewriting, backing up or moving its data',()=>{
    const path=directory(),flow=makeWorkflow('workspace'),prior=run(flow);prior.status='success'
    const original=JSON.stringify({schema:1,workflows:[flow],presets:[],runs:[prior]});writeFileSync(join(path,'library.json'),original)
    expect(()=>new WorkflowStorage(path)).toThrow('仅支持当前 schema: 2')
    expect(readFileSync(join(path,'library.json'),'utf8')).toBe(original)
    for(const file of ['library.schema-1.backup.json','runs','host.lock'])expect(existsSync(join(path,file))).toBe(false)
  })
  it('leaves unsupported data untouched and releases the host lock for a current file',()=>{
    const path=directory(),original=JSON.stringify({schema:1,workflows:[{id:'broken'}],presets:[],runs:[]});writeFileSync(join(path,'library.json'),original)
    expect(()=>new WorkflowStorage(path)).toThrow();expect(readFileSync(join(path,'library.json'),'utf8')).toBe(original)
    writeFileSync(join(path,'library.json'),JSON.stringify({schema:2,workflows:[],presets:[]}));expect(()=>store(path)).not.toThrow()
  })
  it('no-op saves preserve revision and file mtime; run events never rewrite definitions',()=>{
    const storage=store(),flow=storage.save(makeWorkflow('workspace'),0),library=join(storage.directory,'library.json'),before=statSync(library).mtimeMs
    expect(storage.save(flow,flow.revision).revision).toBe(flow.revision)
    const value=run(flow);storage.saveRun(value);value.status='success';storage.saveRun(value);storage.saveRun(value)
    expect(statSync(library).mtimeMs).toBe(before)
    expect(readFileSync(join(storage.directory,'runs',`${value.id}.events.jsonl`),'utf8').trim().split('\n')).toHaveLength(2)
  })
  it('archives deletion and restores stable identity without touching independent run history',()=>{
    const storage=store(),flow=storage.save(makeWorkflow('workspace'),0),value=run(flow);value.status='success';storage.saveRun(value)
    storage.remove(flow.id,flow.revision);expect(storage.workflows()).toHaveLength(0);expect(()=>storage.get(flow.id)).toThrow()
    expect(storage.archived('workspace')[0]!.id).toBe(flow.id);expect(storage.run(value.id).id).toBe(value.id)
    expect(storage.restore(flow.id).id).toBe(flow.id);expect(storage.workflows()).toHaveLength(1)
  })
  it('interrupts active work without changing historical usage estimates after restart',()=>{
    const path=directory(),storage=store(path),flow=storage.save(makeWorkflow('workspace'),0),value=run(flow)
    value.usage={spentTokens:200,reservedTokens:700,unknownTokens:100,unknownCalls:1,agentTasks:2,calls:3,limit:1000,allocations:{settled:{tokens:200,status:'settled',usage:200},pending:{tokens:500,status:'reserved'},unknown:{tokens:100,status:'unknown'}}}
    storage.saveRun(value);storage.close()
    const reopened=store(path),restored=reopened.run(value.id)
    expect(restored.status).toBe('interrupted');expect(restored.usage).toEqual(value.usage)
    reopened.close();expect(store(path).run(value.id).usage).toEqual(value.usage)
  })
})
