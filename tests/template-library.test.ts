import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkflowTemplateLibrary } from '../src/host/template-library.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { makeWorkflow } from '../src/shared/types.ts'

const directories:string[]=[]
function create(){const directory=mkdtempSync(join(tmpdir(),'workflow-templates-'));directories.push(directory);return new WorkflowTemplateLibrary(directory)}
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true})})
describe('layered workflow templates',()=>{
  it('keeps builtins read-only and creates independent workspace identities without execution',()=>{
    const library=create(),builtin=library.list().filter(template=>template.scope==='builtin')
    expect(builtin).toHaveLength(2)
    expect(()=>library.rename(builtin[0]!.id,'changed',1)).toThrow('只读');expect(()=>library.remove(builtin[0]!.id,1)).toThrow('只读')
    const first=library.instantiate(builtin[0]!.id,'ws-1'),second=library.instantiate(builtin[0]!.id,'ws-2')
    expect(first.workflow.id).not.toBe(second.workflow.id);expect(first.workflow.nodes[0]!.id).not.toBe(second.workflow.nodes[0]!.id)
    expect(first.workflow.workspaceId).toBe('ws-1');expect(second.workflow.workspaceId).toBe('ws-2');expect(first.workflow.revision).toBe(0)
  })
  it('stores personal definitions without values, attachments, runs or credential bindings',()=>{
    const library=create(),flow=makeWorkflow('private-workspace',undefined,true)
    flow.environmentVariables=[{id:'base',name:'PUBLIC_BASE',type:'string',value:'not-in-template'},{id:'key',name:'KEY',type:'secret'}]
    const saved=library.save(flow,{title:'个人模板'}),raw=readFileSync(join(library.directory,'templates.json'),'utf8')
    expect(saved.scope).toBe('personal');expect(raw).not.toContain('not-in-template');expect(raw).not.toContain('private-workspace');expect(statSync(join(library.directory,'templates.json')).mode&0o777).toBe(0o600)
    const restored=new WorkflowTemplateLibrary(library.directory),instance=restored.instantiate(saved.id,'current')
    expect(instance.workflow.title).toBe('个人模板');expect(instance.workflow.environmentVariables![0]!.value).toBeUndefined();expect(instance.workflow.environmentVariables![1]!.type).toBe('secret')
  })
  it('renames with optimistic locking, archives recoverably, and never changes an existing instance',()=>{
    const library=create(),saved=library.save(makeWorkflow('ws'),{title:'old'}),instance=library.instantiate(saved.id,'ws')
    const renamed=library.rename(saved.id,'new',1);expect(renamed.revision).toBe(2);expect(instance.workflow.title).toBe('old')
    expect(()=>library.remove(saved.id,1)).toThrow('刷新');expect(library.instantiate(saved.id,'ws').workflow.title).toBe('new')
    library.remove(saved.id,2);expect(library.list().some(template=>template.id===saved.id)).toBe(false);expect(()=>library.instantiate(saved.id,'ws')).toThrow('归档')
    const archived=library.archived()[0]!;expect(library.restore(archived.id,archived.revision).title).toBe('new')
  })
  it('reads historical templates without enforcing current graph contracts and still rejects invalid new instances',()=>{
    const library=create(),saved=library.save(makeWorkflow('ws',undefined,true)),file=join(library.directory,'templates.json')
    const stored=JSON.parse(readFileSync(file,'utf8')),record=stored.templates[0],bundle=JSON.parse(record.packageJson)
    // Older conditional templates may have used the default exit. Current
    // graphs require an explicit true/false port, but evidence stays readable.
    bundle.workflow.nodes[1].kind='if';bundle.workflow.nodes[1].config={logicGate:{operator:'IF',inputs:[{value:'true'}]}}
    record.packageJson=JSON.stringify(bundle);writeFileSync(file,JSON.stringify(stored))
    const before=readFileSync(file,'utf8'),restored=new WorkflowTemplateLibrary(library.directory)
    expect(restored.list()).toContainEqual(expect.objectContaining({id:saved.id}))
    expect(restored.get(saved.id).packageJson).toBe(record.packageJson)
    expect(()=>restored.instantiate(saved.id,'current')).toThrow('true 或 false')
    expect(readFileSync(file,'utf8')).toBe(before)
  })
  it('embeds needed role definitions and imports graph plus roles in one atomic library transaction',()=>{
    const library=create(),flow=makeWorkflow('ws',undefined,true)
    flow.nodes[1]!.kind='llm';flow.nodes[1]!.config={prompt:'review',rolePresetId:'role'}
    const pending=library.save(flow),pendingBundle=library.instantiate(pending.id,'pending-target')
    expect(pendingBundle.workflow.nodes[1]!.config.rolePresetId).toBe('role');expect(pendingBundle.presets).toEqual([]);expect(pendingBundle.warnings.some(message=>message.includes('缺少角色'))).toBe(true)
    const saved=library.save(flow,{presets:[{id:'role',name:'Reviewer',prompt:'Review precisely',revision:4}]}),bundle=library.instantiate(saved.id,'target'),storage=new WorkflowStorage(join(library.directory,'workspace'))
    try{const imported=storage.importBundle(bundle.workflow,bundle.presets);expect(storage.presets()[0]!.id).toBe(imported.nodes[1]!.config.rolePresetId);expect(storage.presets()[0]!.revision).toBe(1);expect(()=>storage.importBundle(bundle.workflow,bundle.presets)).toThrow('全新');expect(storage.workflows()).toHaveLength(1);expect(storage.presets()).toHaveLength(1)}finally{storage.close()}
  })
})
