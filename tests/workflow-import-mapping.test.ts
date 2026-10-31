import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareWorkflowImport } from '../src/host/workflow-import.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { exportWorkflowJson, workflowDependencies } from '../src/shared/workflow-format.ts'
import { parseWorkflowImportOptions, type WorkflowImportCatalog, type WorkflowImportOptions } from '../src/shared/workflow-import.ts'
import { makeWorkflow, newId, type RolePreset, type Workflow, type WorkflowRun } from '../src/shared/types.ts'

const dirs:string[]=[],stores:WorkflowStorage[]=[]
function directory(){const value=mkdtempSync(join(tmpdir(),'workflow-import-'));dirs.push(value);return value}
function catalog(overrides:Partial<WorkflowImportCatalog>={}):WorkflowImportCatalog{return {models:['A','B','C'].map(model=>({provider:'host',model,label:model,efforts:[]})),tools:['A','B','C'].map(name=>({id:`builtin:${name}`,name,description:name,providerId:'builtin',providerName:'builtin',category:'plugin',inputSchema:{type:'object'},available:true})),workflows:[],presets:[],...overrides}}
function agents():Workflow{
  const flow=makeWorkflow('origin'),input=flow.nodes[0]!,output=flow.nodes[1]!
  const middle=['A','B'].map((id,index)=>({id:`agent-${id}`,number:`a-${index+2}`,kind:'document' as const,title:id,x:200+index*300,y:0,fixed:false,config:{source:'input.text',documentMode:'agent' as const,model:{provider:'host',model:id},tools:[`builtin:${id}`],rolePresetId:id}}))
  flow.nodes=[input,...middle,output];flow.edges=flow.nodes.slice(1).map((node,index)=>({id:newId(),source:flow.nodes[index]!.id,target:node.id}));output.config.text='{{agent-B.text}}';return flow
}
const bundled:RolePreset[]=['A','B'].map(id=>({id,name:id,prompt:`role ${id}`,revision:0}))
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})

describe('host-verified import dependency mappings',()=>{
  it('rejects unknown options, targets, duplicate mappings and forged dependency keys',async()=>{
    for(const options of [{unknown:true},{mappings:[{kind:'model',id:'x',target:{provider:'a',model:'b',credential:'hidden'}}]},{overwrite:{workflowId:'target',expectedRevision:0,force:true}}])expect(()=>parseWorkflowImportOptions(options)).toThrow()
    const text=exportWorkflowJson(agents(),{presets:bundled}),root=directory()
    await expect(prepareWorkflowImport(text,'target',{mappings:[{kind:'tool',id:'forged',target:'builtin:A'}]},catalog(),root)).rejects.toThrow('不存在')
    const mapping={kind:'model',id:'host/A',target:{provider:'host',model:'B'}}
    await expect(prepareWorkflowImport(text,'target',{mappings:[mapping,mapping]},catalog(),root)).rejects.toThrow('重复')
  })
  it.each([['B','A'],['B','C']])('maps original identities once for models, tools and roles: A→%s, B→%s',async(first,second)=>{
    const flow=agents(),available=catalog({presets:['A','B','C'].map(id=>({id,name:`local ${id}`,prompt:`local role ${id}`,revision:4}))})
    const mappings:NonNullable<WorkflowImportOptions['mappings']>=[]
    for(const [from,to] of [['A',first],['B',second]])mappings.push({kind:'model',id:`host/${from}`,target:{provider:'host',model:to!}},{kind:'tool',id:`builtin:${from}`,target:`builtin:${to}`},{kind:'role',id:from!,target:to!})
    const result=await prepareWorkflowImport(exportWorkflowJson(flow,{presets:bundled}),'target',{mappings},available,directory())
    expect(result.preview.canImport).toBe(true);expect(result.presets).toEqual([])
    const nodes=result.workflow!.nodes.filter(node=>node.kind==='document')
    expect(nodes.map(node=>node.config.model?.model)).toEqual([first,second])
    expect(nodes.map(node=>node.config.tools)).toEqual([[`builtin:${first}`],[`builtin:${second}`]])
    expect(nodes.map(node=>node.config.rolePresetId)).toEqual([first,second])
    expect(result.workflow!.nodes.at(-1)!.config.text).toBe(`{{${nodes[1]!.id}.text}}`)
  })
  it('does not accidentally rebind a mapped local role whose ID collides with another bundled role',async()=>{
    const result=await prepareWorkflowImport(exportWorkflowJson(agents(),{presets:bundled}),'target',{mappings:[{kind:'role',id:'A',target:'B'}]},catalog({presets:[{id:'B',name:'local',prompt:'local B',revision:2}]}),directory())
    expect(result.preview.canImport).toBe(true)
    const nodes=result.workflow!.nodes.filter(node=>node.kind==='document')
    expect(nodes[0]!.config.rolePresetId).toBe('B')
    expect(nodes[1]!.config.rolePresetId).not.toBe('B')
    expect(result.presets).toHaveLength(1);expect(result.presets![0]!.prompt).toBe('role B')
  })
  it('rechecks current catalogs at import time and excludes inaccessible cross-workspace workflows',async()=>{
    const flow=makeWorkflow('origin',undefined,true),child=makeWorkflow('target'),foreign=makeWorkflow('elsewhere')
    flow.nodes[1]!.kind='tool';flow.nodes[1]!.config={toolId:'workflow:old',inputs:{}}
    const text=exportWorkflowJson(flow),mapping={mappings:[{kind:'workflow' as const,id:'workflow:old',target:`workflow:${child.id}`}]} as const
    const available=catalog({workflows:[child,foreign]})
    const valid=await prepareWorkflowImport(text,'target',mapping,available,directory())
    expect(valid.preview.canImport).toBe(true)
    expect(valid.preview.dependencies[0]!.choices.map(choice=>choice.id)).not.toContain(`workflow:${foreign.id}`)
    const changed=await prepareWorkflowImport(text,'target',mapping,catalog(),directory())
    expect(changed.preview.canImport).toBe(false);expect(changed.workflow).toBeUndefined()
    const self=await prepareWorkflowImport(text,'target',{...mapping,overwrite:{workflowId:child.id,expectedRevision:child.revision}},available,directory())
    expect(self.preview.canImport).toBe(false)
  })
  it('tracks each file slot independently, strips absolute paths and permits future output files only',async()=>{
    const root=directory();mkdirSync(join(root,'docs'));writeFileSync(join(root,'docs/a.md'),'a');writeFileSync(join(root,'docs/b.md'),'b')
    const flow=makeWorkflow('origin',undefined,true),node=flow.nodes[1]!
    node.kind='knowledge';node.config={sources:['/private/a.md','/private/b.md'],query:'find',verification:{requiredFiles:['/private/result.txt']}}
    const text=exportWorkflowJson(flow)
    expect(text).not.toContain('/private/');expect(workflowDependencies(flow).filter(item=>item.kind==='file')).toHaveLength(3)
    const options:WorkflowImportOptions={mappings:[{kind:'file',id:`file-${node.id}-sources-0`,target:'docs/a.md'},{kind:'file',id:`file-${node.id}-sources-1`,target:'docs/b.md'},{kind:'file',id:`file-${node.id}-requiredFiles-0`,target:'output/new/result.txt'}]}
    const prepared=await prepareWorkflowImport(text,'target',options,catalog(),root)
    expect(prepared.preview.canImport).toBe(true)
    expect(prepared.workflow!.nodes[1]!.config.sources).toEqual(['docs/a.md','docs/b.md'])
    expect(prepared.workflow!.nodes[1]!.config.verification!.requiredFiles).toEqual(['output/new/result.txt'])
    options.mappings![0]!.target='docs/missing.md'
    const missing=await prepareWorkflowImport(text,'target',options,catalog(),root)
    expect(missing.preview.canImport).toBe(false);expect(missing.preview.dependencies.find(item=>item.id.endsWith('sources-0'))?.message).toContain('不存在')
  })
  it('blocks traversal, external symlinks and dangling symlinks even for nonexistent output paths',async()=>{
    const root=directory(),outside=directory();writeFileSync(join(outside,'private.txt'),'private');symlinkSync(outside,join(root,'outside'));symlinkSync(join(outside,'missing'),join(root,'dangling'))
    const flow=makeWorkflow('origin',undefined,true);flow.nodes[1]!.config.verification={requiredFiles:['result.txt']}
    const text=exportWorkflowJson(flow),id=`file-${flow.nodes[1]!.id}-requiredFiles-0`
    for(const path of ['../private.txt',join(outside,'private.txt'),'outside/new/result.txt','dangling/result.txt']){
      const prepared=await prepareWorkflowImport(text,'target',{mappings:[{kind:'file',id,target:path}]},catalog(),root)
      expect(prepared.preview.canImport,path).toBe(false);expect(prepared.workflow).toBeUndefined()
    }
  })
  it('keeps existence, read-evidence and changed-file slots distinct during export and mapping',async()=>{
    const root=directory();writeFileSync(join(root,'source.md'),'read me')
    const flow=makeWorkflow('origin',undefined,true),node=flow.nodes[1]!
    node.config.verification={requiredFiles:['/old/result.md'],requiredReadFiles:['/old/source.md'],requiredChangedFiles:['/old/changed.md']}
    const text=exportWorkflowJson(flow);expect(text).not.toContain('/old/')
    const options:WorkflowImportOptions={mappings:[{kind:'file',id:`file-${node.id}-requiredFiles-0`,target:'new/result.md'},{kind:'file',id:`file-${node.id}-requiredReadFiles-0`,target:'source.md'},{kind:'file',id:`file-${node.id}-requiredChangedFiles-0`,target:'new/changed.md'}]}
    const prepared=await prepareWorkflowImport(text,'target',options,catalog(),root)
    expect(prepared.preview.canImport).toBe(true)
    expect(prepared.workflow!.nodes[1]!.config.verification).toEqual({requiredFiles:['new/result.md'],requiredReadFiles:['source.md'],requiredChangedFiles:['new/changed.md']})
    options.mappings![1]!.target='new/not-yet-read.md'
    expect((await prepareWorkflowImport(text,'target',options,catalog(),root)).preview.canImport).toBe(false)
  })
  it('keeps runtime file uploads deferred without importing upload handles or authorization',async()=>{
    const flow=makeWorkflow('origin');flow.nodes[0]!.config.fields=[{name:'file',label:'资料',required:true,type:'file',defaultValue:'private-handle'}];flow.nodes[1]!.config.text='done'
    const text=exportWorkflowJson(flow),prepared=await prepareWorkflowImport(text,'target',{},catalog(),directory())
    expect(text).not.toContain('private-handle');expect(prepared.preview.canImport).toBe(true)
    expect(prepared.preview.dependencies).toContainEqual(expect.objectContaining({kind:'file',status:'deferred'}))
    expect(prepared.workflow!.nodes[0]!.config.fields![0]!.defaultValue).toBeUndefined()
  })
})

describe('atomic revision-checked overwrite import',()=>{
  it('preserves target identity and existing run snapshots, while rebuilding node/Secret identities and committing new roles once',async()=>{
    const storage=new WorkflowStorage(directory());stores.push(storage)
    const target=storage.save(makeWorkflow('target','existing'),0),before:WorkflowRun={id:newId(),workflowId:target.id,workspaceId:'target',workflowTitle:target.title,sourceRevision:target.revision,graph:target,status:'running',inputs:{text:'original'},outputs:{},executions:[],startedAt:new Date().toISOString()}
    storage.saveRun(before)
    const flow=agents();flow.environmentVariables=[{id:'secret-from-file',name:'API_KEY',type:'secret'}]
    const options={overwrite:{workflowId:target.id,expectedRevision:target.revision}},prepared=await prepareWorkflowImport(exportWorkflowJson(flow,{presets:bundled}),'target',options,catalog({workflows:[target]}),directory())
    expect(prepared.preview.canImport).toBe(true)
    const saved=storage.importBundle(prepared.workflow,prepared.presets!,options.overwrite)
    expect(saved).toMatchObject({id:target.id,revision:target.revision+1,createdAt:target.createdAt,title:flow.title})
    expect(saved.nodes[1]!.id).not.toBe(flow.nodes[1]!.id)
    expect(saved.environmentVariables![0]!.id).not.toBe('secret-from-file');expect(saved.environmentVariables![0]).not.toHaveProperty('value')
    expect(storage.run(before.id)).toEqual(before);expect(storage.presets()).toHaveLength(2)
    const disk=readFileSync(join(storage.directory,'library.json'),'utf8')
    expect(()=>storage.importBundle(prepared.workflow,prepared.presets!,options.overwrite)).toThrow('已被修改')
    expect(readFileSync(join(storage.directory,'library.json'),'utf8')).toBe(disk)
  })
  it('rejects cross-workspace and archived overwrite targets without modifying the library',()=>{
    const storage=new WorkflowStorage(directory());stores.push(storage)
    const target=storage.save(makeWorkflow('other'),0),candidate=makeWorkflow('target')
    expect(()=>storage.importBundle(candidate,[],{workflowId:target.id,expectedRevision:target.revision})).toThrow('不属于')
    storage.remove(target.id,target.revision)
    expect(()=>storage.importBundle({...candidate,workspaceId:'other'},[],{workflowId:target.id,expectedRevision:target.revision+1})).toThrow('归档')
  })
})
