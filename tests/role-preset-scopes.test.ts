import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeWorkflow, type RolePreset, type Workflow } from '../src/shared/types.ts'
import { presetSchema } from '../src/shared/workflow-validation.ts'
import { rolePresetAvailable, rolePresetsForWorkflow } from '../src/shared/role-presets.ts'
import { createWorkflowSubagent } from '../src/shared/workflow-subagents.ts'
import { exportWorkflowJson, importWorkflowJson, parseWorkflowPackage } from '../src/shared/workflow-format.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { prepareWorkflowImport } from '../src/host/workflow-import.ts'
import { inspectWorkflowReadiness } from '../src/host/workflow-readiness.ts'

const directories:string[]=[],stores:WorkflowStorage[]=[],runtimes:WorkflowRuntime[]=[]
function directory(){const path=mkdtempSync(join(tmpdir(),'workflow-role-scopes-'));directories.push(path);return path}
function storage(){const result=new WorkflowStorage(directory());stores.push(result);return result}
function withRole(flow:Workflow,id:string):Workflow {const next=structuredClone(flow);next.nodes[1]!.kind='llm';next.nodes[1]!.config={model:{provider:'test',model:'model'},prompt:'{{input.text}}',rolePresetId:id};return next}
const global:RolePreset={id:'global',name:'旧全局角色',prompt:'global role',revision:0}
const scoped=(id:string,workflowId:string):RolePreset=>({id,name:id,prompt:`private ${id}`,summary:'工作流角色概述',scope:'workflow',workflowId,revision:0})
afterEach(async()=>{for(const runtime of runtimes.splice(0))await runtime.close();for(const store of stores.splice(0))store.close();for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true})})

describe('global and workflow-owned agent presets',()=>{
  it('treats legacy roles as global and validates scope ownership without accepting contradictory metadata',()=>{
    expect(presetSchema.parse(global)).toEqual(global)
    const local=scoped('local','flow-a')
    expect(rolePresetAvailable(global,'flow-b')).toBe(true)
    expect(rolePresetsForWorkflow([global,local],'flow-a')).toEqual([global,local])
    expect(rolePresetsForWorkflow([global,local],'flow-b')).toEqual([global])
    expect(rolePresetAvailable(local)).toBe(false)
    for(const invalid of [{...global,scope:'workflow'},{...global,scope:'global',workflowId:'flow-a'},{...global,workflowId:'flow-a'},{...global,scope:'session'},{...local,extra:true}])expect(()=>presetSchema.parse(invalid)).toThrow()
    expect(()=>createWorkflowSubagent(makeWorkflow('ws'),'A',undefined,local)).toThrow('不属于当前工作流')
  })

  it('enforces scoped saves and prevents moving an in-use role into another workflow',()=>{
    const store=storage(),a=store.save(makeWorkflow('ws','A',true),0),b=store.save(makeWorkflow('ws','B',true),0)
    store.savePreset(global);store.savePreset(scoped('role-a',a.id))
    expect(()=>store.savePreset(scoped('unknown','missing'))).toThrow('所属工作流不存在')
    expect(()=>store.save(withRole(b,'role-a'),b.revision)).toThrow('属于其他工作流')
    const bound=store.save(withRole(a,'role-a'),a.revision)
    expect(()=>store.savePreset({...scoped('role-a',b.id),revision:1})).toThrow('属于其他工作流')
    store.savePreset({...scoped('role-a',a.id),summary:'新概述',revision:1})
    expect(store.presets(a.id).find(role=>role.id==='role-a')).toMatchObject({summary:'新概述',revision:2})
    expect(store.presets(b.id).map(role=>role.id)).toEqual(['global'])
    expect(store.get(a.id).revision).toBe(bound.revision)
  })

  it('blocks forged foreign roles in readiness and runtime snapshots before any model request',async()=>{
    const store=storage(),a=store.save(makeWorkflow('ws','A',true),0),b=store.save(makeWorkflow('ws','B',true),0)
    store.savePreset(scoped('role-a',a.id))
    const forged=withRole(b,'role-a'),catalog={models:[{provider:'test',model:'model',label:'Test',efforts:[]}],tools:[],workflows:[a,b],presets:store.presets()}
    const readiness=await inspectWorkflowReadiness(forged,{catalog,workspaceRoot:store.directory})
    expect(readiness.issues.some(issue=>issue.kind==='role'&&issue.message.includes('不属于当前工作流'))).toBe(true)
    let calls=0;const runtime=new WorkflowRuntime(store,{generate:async()=>{calls++;return 'unexpected'}});runtimes.push(runtime)
    expect(()=>runtime.start(b.id,{},undefined,{sourceGraph:forged})).toThrow('角色预设不存在或不属于当前工作流')
    expect(calls).toBe(0)
  })

  it('exports only owned local libraries and remaps every local owner and role reference on copy',()=>{
    const a=withRole(makeWorkflow('ws','A',true),'a-role'),b=withRole(makeWorkflow('ws','B',true),'b-role')
    a.nodes[2]!.kind='tool';a.nodes[2]!.config={toolId:`workflow:${b.id}`}
    const roles=[global,scoped('a-role',a.id),scoped('a-unused',a.id),scoped('b-role',b.id),scoped('foreign','other-flow')]
    const text=exportWorkflowJson(a,{presets:roles,workflows:[b]}),pkg=parseWorkflowPackage(text)
    expect(pkg.presets.map(role=>role.id)).toEqual(['a-role','a-unused','b-role'])
    expect(text).not.toContain('private foreign');expect(text).not.toContain('global role')
    const copied=importWorkflowJson(text,'new-ws'),owners=new Set([copied.workflow.id,...copied.workflows.map(flow=>flow.id)])
    expect(copied.presets.every(role=>role.scope==='workflow'&&owners.has(role.workflowId!))).toBe(true)
    const own=copied.presets.find(role=>role.workflowId===copied.workflow.id&&role.name==='a-role')!
    expect(copied.workflow.nodes[1]!.config.rolePresetId).toBe(own.id)
    expect(copied.workflows[0]!.nodes[1]!.config.rolePresetId).toBe(copied.presets.find(role=>role.name==='b-role')!.id)
    expect(()=>exportWorkflowJson(withRole(a,'foreign'),{presets:roles})).toThrow('属于其他工作流')
  })

  it('rebases imported local libraries onto an overwrite target atomically',()=>{
    const store=storage(),target=store.save(makeWorkflow('ws','Target',true),0),source=withRole(makeWorkflow('origin','Source',true),'source-role')
    const imported=importWorkflowJson(exportWorkflowJson(source,{presets:[scoped('source-role',source.id)]}),'ws')
    const saved=store.importBundle(imported.workflow,imported.presets,{workflowId:target.id,expectedRevision:target.revision})
    expect(saved.id).toBe(target.id)
    expect(store.presets().find(role=>role.id===saved.nodes[1]!.config.rolePresetId)?.workflowId).toBe(target.id)
    expect(()=>store.importBundle({...imported.workflow,id:'fresh'},[{...imported.presets[0]!,id:'another',workflowId:'outside'}])).toThrow('不属于随包工作流')
  })

  it('does not offer another workflow role for new imports and permits target-local roles only for that overwrite',async()=>{
    const store=storage(),target=store.save(makeWorkflow('ws','Target',true),0),other=store.save(makeWorkflow('ws','Other',true),0)
    store.savePreset(scoped('target-role',target.id));store.savePreset(scoped('foreign-role',other.id));store.savePreset(global)
    const source=withRole(makeWorkflow('origin','Source',true),'missing-role'),text=exportWorkflowJson(source),catalog={models:[{provider:'test',model:'model',label:'Test',efforts:[]}],tools:[],workflows:store.workflows('ws'),presets:store.presets()}
    const fresh=await prepareWorkflowImport(text,'ws',{},catalog,store.directory)
    expect(fresh.preview.dependencies.find(item=>item.kind==='role')!.choices.map(choice=>choice.id)).toEqual(['global'])
    const mapped=await prepareWorkflowImport(text,'ws',{overwrite:{workflowId:target.id,expectedRevision:target.revision},mappings:[{kind:'role',id:'missing-role',target:'target-role'}]},catalog,store.directory)
    expect(mapped.preview.canImport).toBe(true)
    expect(mapped.preview.dependencies.find(item=>item.kind==='role')!.choices.map(choice=>choice.id)).toEqual(['target-role','global'])
    expect(store.importBundle(mapped.workflow!,mapped.presets!,{workflowId:target.id,expectedRevision:target.revision}).nodes[1]!.config.rolePresetId).toBe('target-role')
  })
})
