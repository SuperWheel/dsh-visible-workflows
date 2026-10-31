import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWorkflow, type Workflow, type WorkflowNode } from '../src/shared/types.ts'
import { exportWorkflowJson, isFileReference, workflowDependencies } from '../src/shared/workflow-format.ts'
import { inspectWorkflowReadiness, assertWorkflowReady, needsReadinessModelDefaults, type WorkflowReadinessContext } from '../src/host/workflow-readiness.ts'
import { prepareWorkflowImport } from '../src/host/workflow-import.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { PROTECTED_OPERATION } from '../src/shared/protected-secret.ts'

const dirs:string[]=[],stores:WorkflowStorage[]=[],runtimes:WorkflowRuntime[]=[]
function directory(){const path=mkdtempSync(join(tmpdir(),'workflow-readiness-'));dirs.push(path);return path}
function context(overrides:Partial<WorkflowReadinessContext>={}):WorkflowReadinessContext{return {workspaceRoot:directory(),catalog:{models:[{provider:'host',model:'configured',label:'Configured',efforts:[]}],tools:[],presets:[],workflows:[]},...overrides}}
function middle(flow:Workflow,kind:WorkflowNode['kind'],config:WorkflowNode['config']):WorkflowNode{if(kind==='agent'){config={...config,subagentId:'worker'};flow.subAgents=[{id:'worker',number:'agent-1',name:'测试员',prompt:''}]}const input=flow.nodes[0]!,output=flow.nodes.at(-1)!,node={id:'middle',kind,config,number:'a-2',title:'待配置节点',x:-12.5,y:77.25,fixed:false};flow.nodes=[input,node,output];flow.edges=[{id:'first',source:input.id,target:node.id},{id:'last',source:node.id,target:output.id}];output.config.text='done';return node}
afterEach(async()=>{for(const runtime of runtimes.splice(0))await runtime.close();for(const storage of stores.splice(0))storage.close();for(const path of dirs.splice(0))rmSync(path,{recursive:true,force:true})})

describe('persistent incomplete canvas and current Host readiness',()=>{
  it('only resolves model defaults for the actual dependency closure and tolerates absent children',()=>{
    const pure=makeWorkflow('workspace'),model=makeWorkflow('workspace');middle(model,'agent',{prompt:'model'})
    expect(needsReadinessModelDefaults(pure,[model])).toBe(false)
    const caller=middle(pure,'tool',{toolId:'workflow:absent',inputs:{}})
    expect(needsReadinessModelDefaults(pure,[model])).toBe(false)
    caller.config.toolId=`workflow:${model.id}`;expect(needsReadinessModelDefaults(pure,[model])).toBe(true)
    expect(needsReadinessModelDefaults(pure,[model],{})).toBe(false)
    model.nodes[1]!.config.model={provider:'host',model:'configured'};model.nodes[1]!.config.effort='low'
    expect(needsReadinessModelDefaults(pure,[model])).toBe(false)
  })
  it('imports missing model/tool/role/file dependencies without dropping definitions, and finds them again after reopening',async()=>{
    const flow=makeWorkflow('original'),node=middle(flow,'document',{source:'input.text',documentMode:'agent',model:{provider:'absent',model:'model'},tools:['native:absent'],rolePresetId:'external-role',verification:{requiredReadFiles:['docs/missing.md']}})
    flow.environmentVariables=[{id:'ordinary',name:'API_BASE',type:'string',required:true}]
    node.config.prompt='Use {{env.ordinary}}'
    const ctx=context(),prepared=await prepareWorkflowImport(exportWorkflowJson(flow),'target',{},ctx.catalog,ctx.workspaceRoot)
    expect(prepared.preview.canImport).toBe(true);expect(prepared.preview.dependencies.filter(item=>item.status==='missing')).toHaveLength(4)
    const path=directory(),storage=new WorkflowStorage(path),saved=storage.importBundle(prepared.workflow,prepared.presets!);storage.close()
    const reopened=new WorkflowStorage(path);stores.push(reopened);const restored=reopened.get(saved.id),report=await inspectWorkflowReadiness(restored,ctx)
    expect(restored.nodes[1]).toMatchObject({x:node.x,y:node.y,config:{model:node.config.model,tools:node.config.tools,rolePresetId:'external-role'}})
    expect(report.canRun).toBe(false);expect(new Set(report.issues.map(issue=>issue.kind))).toEqual(new Set(['model','tool','role','file','environment','configuration']))
    expect(report.issues.every(issue=>issue.nodeId===restored.nodes[1]!.id)).toBe(true)
    expect(()=>assertWorkflowReady(report)).toThrow('不能运行')
    expect(reopened.save(restored,restored.revision).id).toBe(saved.id)
  })

  it('clears blockers only after real node configurations, environment values and files are supplied',async()=>{
    const flow=makeWorkflow('workspace'),node=middle(flow,'agent',{model:{provider:'host',model:'configured'},tools:[],prompt:'Use {{env.value}}',verification:{requiredReadFiles:['source.md']}})
    flow.environmentVariables=[{id:'value',name:'BASE',type:'string'},{id:'unused',name:'UNUSED',type:'string'}]
    const ctx=context({canVerifyFileReads:()=>true});expect((await inspectWorkflowReadiness(flow,ctx)).canRun).toBe(false)
    writeFileSync(join(ctx.workspaceRoot,'source.md'),'source');flow.environmentVariables[0]!.value='local'
    expect(await inspectWorkflowReadiness(flow,ctx)).toEqual({workflowId:flow.id,revision:flow.revision,canRun:true,issues:[]})
    node.config.model={provider:'different',model:'configured'}
    expect((await inspectWorkflowReadiness(flow,ctx)).issues).toContainEqual(expect.objectContaining({kind:'model',nodeId:node.id}))
  })

  it('uses configured Harness defaults without silently substituting an explicit missing model',async()=>{
    const flow=makeWorkflow('workspace'),node=middle(flow,'agent',{prompt:'test',tools:[]}),ctx=context({modelDefaults:{model:{provider:'host',model:'configured'},source:'harness'}})
    expect((await inspectWorkflowReadiness(flow,ctx)).canRun).toBe(true);expect(node.config.model).toBeUndefined()
    node.config.model={provider:'missing',model:'configured'}
    expect((await inspectWorkflowReadiness(flow,ctx)).issues.some(issue=>issue.kind==='model')).toBe(true)
  })

  it('validates the inherited default reasoning effort before enabling Run',async()=>{
    const flow=makeWorkflow('workspace');middle(flow,'agent',{prompt:'test',tools:[]})
    const ctx=context({modelDefaults:{model:{provider:'host',model:'configured'},effort:'unsupported',source:'harness'}})
    expect((await inspectWorkflowReadiness(flow,ctx)).issues).toContainEqual(expect.objectContaining({kind:'model',field:'effort',message:expect.stringContaining('DSH 默认')}))
  })

  it('does not treat literal text or code mentioning an optional environment name as a missing reference',async()=>{
    const flow=makeWorkflow('workspace');middle(flow,'code',{language:'javascript',code:'function main(){return {text:"env.optional"}}',inputs:{example:'env.optional'}})
    flow.environmentVariables=[{id:'optional',name:'OPTIONAL',type:'string'}]
    expect((await inspectWorkflowReadiness(flow,context())).canRun).toBe(true)
  })

  it.each(['{# {{env.optional}} #} fixed','{{ "env.optional" }}'])('does not count a template comment or quoted literal as an environment read: %s',async text=>{
    const flow=makeWorkflow('workspace');middle(flow,'template',{text})
    flow.environmentVariables=[{id:'optional',name:'OPTIONAL',type:'string'}]
    expect((await inspectWorkflowReadiness(flow,context())).canRun).toBe(true)
  })

  it.each(['{{env.optional}}','{{ env["optional"] }}','{{ "literal" | replace("literal", env.optional) }}'])('still reports a real template environment read: %s',async text=>{
    const flow=makeWorkflow('workspace'),node=middle(flow,'template',{text})
    flow.environmentVariables=[{id:'optional',name:'OPTIONAL',type:'string'}]
    expect((await inspectWorkflowReadiness(flow,context())).issues).toContainEqual(expect.objectContaining({kind:'environment',nodeId:node.id,dependencyId:'optional'}))
  })

  it('accepts a document source automatically injected into its tool parameter but still reports other required parameters',async()=>{
    const flow=makeWorkflow('workspace'),node=middle(flow,'document',{source:'source.txt',documentMode:'tool',toolId:'builtin:parser',documentSourceKey:'file',inputs:{format:'text'}}),ctx=context()
    writeFileSync(join(ctx.workspaceRoot,'source.txt'),'source')
    ctx.catalog.tools=[{id:'builtin:parser',name:'Parser',description:'Fixture',providerId:'fixture',providerName:'Fixture',category:'plugin',available:true,inputSchema:{type:'object',required:['file','format'],properties:{file:{type:'string'},format:{type:'string'}}}}]
    expect((await inspectWorkflowReadiness(flow,ctx)).canRun).toBe(true)
    delete node.config.inputs!.format
    const report=await inspectWorkflowReadiness(flow,ctx)
    expect(report.issues).toContainEqual(expect.objectContaining({kind:'configuration',field:'inputs.format'}))
    expect(report.issues.some(issue=>issue.field==='inputs.file')).toBe(false)
  })

  it('treats an iteration item as a document source reference, not a missing static file',async()=>{
    const flow=makeWorkflow('workspace'),node=middle(flow,'document',{source:'item'}),ctx=context()
    expect(isFileReference('item',flow)).toBe(true);expect(isFileReference('item.path',flow)).toBe(true);expect(isFileReference('items.csv',flow)).toBe(false)
    expect((await inspectWorkflowReadiness(flow,ctx)).issues.some(issue=>issue.kind==='file'&&issue.nodeId===node.id)).toBe(false)
    expect(workflowDependencies(flow).some(item=>item.kind==='file')).toBe(false)
    node.config.source='items.csv'
    expect((await inspectWorkflowReadiness(flow,ctx)).issues).toContainEqual(expect.objectContaining({kind:'file',nodeId:node.id}))
  })

  it('blocks an empty knowledge-source configuration before runtime dispatch',async()=>{
    const flow=makeWorkflow('workspace'),node=middle(flow,'knowledge',{sources:[],query:'example'})
    expect((await inspectWorkflowReadiness(flow,context())).issues).toContainEqual(expect.objectContaining({nodeId:node.id,kind:'file',field:'sources'}))
  })

  it('allows an exact declared upstream output as a runtime file source, never sibling, downstream or unrelated paths',async()=>{
    const flow=makeWorkflow('workspace'),input=flow.nodes[0]!,output=flow.nodes[1]!,writer:WorkflowNode={id:'writer',kind:'tool',number:'a-2',title:'Write artifact',x:0,y:0,fixed:false,config:{toolId:'builtin:writer',inputs:{},verification:{requiredChangedFiles:['out/report.txt']}}},reader:WorkflowNode={id:'reader',kind:'document',number:'a-3',title:'Read artifact',x:0,y:0,fixed:false,config:{source:'out/report.txt',verification:{requiredReadFiles:['out/report.txt']}}}
    flow.nodes=[input,writer,reader,output];flow.edges=[{id:'a',source:input.id,target:writer.id},{id:'b',source:writer.id,target:reader.id},{id:'c',source:reader.id,target:output.id}];output.config.text='done'
    const ctx=context({canVerifyFileReads:()=>true});ctx.catalog.tools=[{id:'builtin:writer',name:'Write',description:'Fixture',providerId:'fixture',providerName:'Fixture',category:'plugin',available:true,inputSchema:{type:'object'}}]
    expect((await inspectWorkflowReadiness(flow,ctx)).canRun).toBe(true)
    reader.config.source='out/different.txt';expect((await inspectWorkflowReadiness(flow,ctx)).issues).toContainEqual(expect.objectContaining({nodeId:reader.id,kind:'file',field:'source'}))
    reader.config.source='out/report.txt';flow.edges=[{id:'a',source:input.id,target:writer.id},{id:'b',source:input.id,target:reader.id},{id:'c',source:reader.id,target:output.id}]
    expect((await inspectWorkflowReadiness(flow,ctx)).issues).toContainEqual(expect.objectContaining({nodeId:reader.id,kind:'file',field:'source'}))
    flow.edges=[{id:'a',source:input.id,target:reader.id},{id:'b',source:reader.id,target:writer.id},{id:'c',source:writer.id,target:output.id}]
    expect((await inspectWorkflowReadiness(flow,ctx)).issues).toContainEqual(expect.objectContaining({nodeId:reader.id,kind:'file',field:'source'}))
  })

  it('reports child workflow configuration on its calling node and respects historical snapshots',async()=>{
    const root=makeWorkflow('workspace'),child=makeWorkflow('workspace'),caller=middle(root,'tool',{toolId:`workflow:${child.id}`,inputs:{text:'hello'}})
    const bad=middle(child,'code',{language:'javascript',code:''}),ctx=context();ctx.catalog.workflows=[child]
    const report=await inspectWorkflowReadiness(root,ctx)
    expect(report.issues).toContainEqual(expect.objectContaining({workflowId:child.id,nodeId:caller.id,message:expect.stringContaining('请填写代码')}))
    const frozen=structuredClone(child);frozen.nodes.find(node=>node.id===bad.id)!.config.code='function main(inputs){return {ok:true}}'
    expect((await inspectWorkflowReadiness(root,{...ctx,dependencySnapshots:{[child.id]:frozen}})).canRun).toBe(true)
    ctx.catalog.workflows=[];expect((await inspectWorkflowReadiness(root,ctx)).issues).toContainEqual(expect.objectContaining({kind:'workflow',nodeId:caller.id}))
  })

  it('checks required Secret metadata without invoking execution or requesting its value',async()=>{
    const flow=makeWorkflow('workspace'),node=middle(flow,'http',{credentialOperation:{operationId:PROTECTED_OPERATION,secretVariableId:'secret'}})
    flow.environmentVariables=[{id:'secret',name:'TOKEN',type:'secret'}]
    const status=vi.fn(async()=> 'missing' as const),ctx=context({secretStatus:status})
    expect((await inspectWorkflowReadiness(flow,ctx)).issues).toContainEqual(expect.objectContaining({kind:'secret',nodeId:node.id,action:'environment'}))
    expect(status).toHaveBeenCalledWith(expect.objectContaining({id:flow.id}),'secret')
    const unauthorized=await inspectWorkflowReadiness(flow,{...ctx,secretStatus:async()=> 'authorization_required'})
    expect(unauthorized.canRun).toBe(false)
    expect(unauthorized.issues).toContainEqual(expect.objectContaining({kind:'secret',nodeId:node.id,action:'environment',message:expect.stringContaining('尚未授权自动使用')}))
    expect((await inspectWorkflowReadiness(flow,{...ctx,secretStatus:async()=> 'configured'})).canRun).toBe(true)
    expect((await inspectWorkflowReadiness(flow,{...ctx,secretStatus:async()=>{throw new Error('private diagnostic')}})).issues[0]!.message).not.toContain('private diagnostic')
    expect(JSON.stringify(flow)).not.toContain('value')
  })

  it('rechecks runtime launches after waiting for inputs and prevents any adapter side effect',async()=>{
    const storage=new WorkflowStorage(directory()),execute=vi.fn(async()=>({text:'must not run'})),preflight=vi.fn(async()=>{throw new Error('工具已失效，不能运行')})
    const runtime=new WorkflowRuntime(storage,{generate:async()=>{throw new Error('must not call model')}},{execute},preflight);runtimes.push(runtime)
    const flow=makeWorkflow('workspace');middle(flow,'tool',{toolId:'native:example',inputs:{}});const saved=storage.save(flow,0)
    const waiting=runtime.start(saved.id,{});expect(waiting.status).toBe('waiting');expect(preflight).not.toHaveBeenCalled()
    runtime.answer(waiting.id,{text:'provided'});const failed=await runtime.settle(waiting.id)
    expect(failed.status).toBe('failed');expect(failed.error).toContain('不能运行');expect(preflight).toHaveBeenCalledOnce();expect(execute).not.toHaveBeenCalled()
  })

  it('atomically imports bundled child workflows and preserves missing resources inside them',async()=>{
    const parent=makeWorkflow('source'),child=makeWorkflow('source'),call=middle(parent,'tool',{toolId:`workflow:${child.id}`,inputs:{text:'hello'}})
    middle(child,'llm',{model:{provider:'missing',model:'model'},rolePresetId:'missing-role'})
    const ctx=context(),prepared=await prepareWorkflowImport(exportWorkflowJson(parent,{workflows:[child]}),'target',{},ctx.catalog,ctx.workspaceRoot)
    expect(prepared.preview.canImport).toBe(true);expect(prepared.workflows).toHaveLength(1)
    expect(prepared.workflow!.nodes[1]!.config.toolId).toBe(`workflow:${prepared.workflows![0]!.id}`)
    const storage=new WorkflowStorage(directory());stores.push(storage)
    const saved=storage.importBundle(prepared.workflow,prepared.presets!,undefined,prepared.workflows)
    expect(storage.workflows('target')).toHaveLength(2)
    const report=await inspectWorkflowReadiness(saved,{...ctx,catalog:{...ctx.catalog,workflows:storage.workflows('target')}})
    expect(report.issues).toContainEqual(expect.objectContaining({kind:'model',nodeId:saved.nodes[1]!.id,workflowId:prepared.workflows![0]!.id}))
    expect(call.config.toolId).toBe(`workflow:${child.id}`)
    const count=storage.workflows().length
    expect(()=>storage.importBundle({...prepared.workflow,id:'another'},[],undefined,prepared.workflows)).toThrow('全新')
    expect(storage.workflows()).toHaveLength(count)
  })

  it('maps duplicate node identities in different bundled file scopes independently',async()=>{
    const parent=makeWorkflow('source'),child=makeWorkflow('source');middle(parent,'agent',{model:{provider:'host',model:'configured'},tools:[`workflow:${child.id}`],verification:{requiredReadFiles:['parent.md']}})
    middle(child,'document',{source:'child.md'})
    const ctx=context();writeFileSync(join(ctx.workspaceRoot,'parent-local.md'),'parent');writeFileSync(join(ctx.workspaceRoot,'child-local.md'),'child')
    const result=await prepareWorkflowImport(exportWorkflowJson(parent,{workflows:[child]}),'target',{mappings:[{kind:'file',id:'file-middle-requiredReadFiles-0',target:'parent-local.md'},{kind:'file',id:`workflow-${child.id}:file-middle-source`,target:'child-local.md'}]},ctx.catalog,ctx.workspaceRoot)
    expect(result.preview.canImport).toBe(true)
    expect(result.workflow!.nodes[1]!.config.verification?.requiredReadFiles).toEqual(['parent-local.md'])
    expect(result.workflows![0]!.nodes[1]!.config.source).toBe('child-local.md')
  })
})
