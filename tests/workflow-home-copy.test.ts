import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyWorkflowCard } from '../src/client/workflow-home-copy.ts'
import { WorkflowStore } from '../src/client/store.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { exportWorkflowJson, importWorkflowJson, parseWorkflowPackage } from '../src/shared/workflow-format.ts'
import { makeWorkflow, type WorkflowAPI } from '../src/shared/types.ts'

const stores:WorkflowStore[]=[],hosts:WorkflowStorage[]=[],directories:string[]=[]
afterEach(()=>{stores.splice(0).forEach(store=>store.dispose());hosts.splice(0).forEach(host=>host.close());directories.splice(0).forEach(path=>rmSync(path,{recursive:true,force:true}))})
function fixture(referenced=true){
  const directory=mkdtempSync(join(tmpdir(),'workflow-home-copy-'));directories.push(directory)
  const host=new WorkflowStorage(directory);hosts.push(host)
  const editing=host.save(makeWorkflow('editing-workspace','Unrelated editor',true),0)
  let source=host.save(makeWorkflow('card-workspace','Selected card',true),0)
  host.savePreset({id:'source-role',name:'Source local role',prompt:'Source local prompt',scope:'workflow',workflowId:source.id,revision:0})
  host.savePreset({id:'unused-source-role',name:'Unused source role',prompt:'Unused local prompt',scope:'workflow',workflowId:source.id,revision:0})
  host.savePreset({id:'foreign-role',name:'Other workflow role',prompt:'FOREIGN PRIVATE ROLE',scope:'workflow',workflowId:editing.id,revision:0})
  if(referenced){source.nodes[1]!.kind='llm';source.nodes[1]!.config={model:{provider:'test',model:'model'},prompt:'{{input.text}}',rolePresetId:'source-role'}}
  source.environmentVariables=[{id:'number',name:'COUNT',type:'number',value:42},{id:'string',name:'LABEL',type:'string',value:'Retain this value'},{id:'secret',name:'TOKEN',type:'secret'}]
  source.subAgents=[{id:'source-agent',number:'agent-1',name:'Source identity',prompt:'Source role snapshot',sessionId:'local-source-conversation',rolePresetId:'source-role',rolePresetRevision:1}]
  source.editor={viewport:{x:700,y:800,scale:.6},annotations:[{id:'source-note',number:1,nodeIds:[source.nodes[0]!.id],text:'Selected card annotation'}]}
  source=host.save(source,source.revision)
  const library=()=>({workflows:host.workflows(''),presets:host.presets(),runs:[],workspaces:[{id:'editing-workspace',name:'Editor'},{id:'card-workspace',name:'Cards'}]})
  const api={get:vi.fn(async(id:string)=>host.get(id)),save:vi.fn(async(raw:string,revision:number)=>host.save(JSON.parse(raw),revision)),list:vi.fn(async()=>library()),models:vi.fn(async()=>[]),presets:vi.fn(async()=>host.presets()),importPackage:vi.fn(async(raw:string,workspace:string)=>{const bundle=importWorkflowJson(raw,workspace);return host.importBundle(bundle.workflow,bundle.presets,undefined,bundle.workflows)})} as unknown as WorkflowAPI
  const store=new WorkflowStore(api);stores.push(store);store.update({workflow:editing,page:'library',sessionId:'current-conversation',loading:false,library:library()});store.edit({...editing,title:'Unrelated unsaved edits'})
  return {host,editing,source,api,store}
}

describe('home card copy with workflow-local role libraries',()=>{
  it.each([true,false])('copies owned local roles, including unused roles, through atomic import (referenced=%s)',async(referenced)=>{
    const {host,editing,source,api,store}=fixture(referenced)
    const copied=await copyWorkflowCard(store,source,'Selected card copy')
    expect(api.importPackage).toHaveBeenCalledOnce()
    const [raw,workspace,options,session]=vi.mocked(api.importPackage!).mock.calls[0]!
    expect(workspace).toBe(source.workspaceId);expect(options).toEqual({});expect(session).toBe('current-conversation')
    const portable=parseWorkflowPackage(raw)
    expect(portable.workflow.title).toBe('Selected card copy');expect(raw).not.toContain('Unrelated unsaved edits');expect(raw).not.toContain('FOREIGN PRIVATE ROLE')
    expect(portable.presets.map(role=>role.name).sort()).toEqual(['Source local role','Unused source role'])
    const own=host.presets(copied.id).filter(role=>role.scope==='workflow')
    expect(own.map(role=>role.name).sort()).toEqual(['Source local role','Unused source role'])
    expect(own.every(role=>role.workflowId===copied.id&&!['source-role','unused-source-role'].includes(role.id))).toBe(true)
    if(referenced)expect(copied.nodes[1]!.config.rolePresetId).toBe(own.find(role=>role.name==='Source local role')!.id)
    expect(copied.id).not.toBe(source.id);expect(copied.nodes[0]!.id).not.toBe(source.nodes[0]!.id)
    expect(copied.environmentVariables).toEqual(expect.arrayContaining([expect.objectContaining({name:'COUNT',type:'number',value:42}),expect.objectContaining({name:'LABEL',type:'string',value:'Retain this value'})]))
    expect(copied.environmentVariables!.find(variable=>variable.type==='secret')).not.toHaveProperty('value')
    expect(copied.subAgents![0]).toMatchObject({name:'Source identity',prompt:'Source role snapshot'});expect(copied.subAgents![0]).not.toHaveProperty('sessionId');expect(copied.subAgents![0]).not.toHaveProperty('rolePresetId')
    expect(copied.editor?.viewport).toEqual(source.editor!.viewport);expect(copied.editor?.annotations?.[0]?.nodeIds).toEqual([copied.nodes[0]!.id])
    expect(host.get(editing.id).title).toBe('Unrelated unsaved edits');expect(host.get(source.id)).toEqual(source)
    expect(store.getSnapshot().workflow?.id).toBe(copied.id);expect(store.getSnapshot().saveState).toBe('saved')
    // Only preserving the unrelated editor uses save(); the copied definition and
    // local preset library commit together through importBundle instead.
    expect(api.save).toHaveBeenCalledOnce();expect(vi.mocked(api.save).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.importPackage!).mock.invocationCallOrder[0]!)
  })
  it('refreshes remapped local preset IDs before Save As exposes its new graph',async()=>{
    const {source,host,api,store}=fixture()
    await store.open(source.id);vi.mocked(api.save).mockClear()
    store.edit({...store.getSnapshot().workflow!,title:'Unsaved source content'})
    const raw=exportWorkflowJson({...store.getSnapshot().workflow!,title:'Saved as copy'},{includeEnvironmentValues:true,presets:store.getSnapshot().library.presets,workflows:store.getSnapshot().library.workflows})
    await store.saveAs(raw)
    const current=store.getSnapshot().workflow!,role=store.getSnapshot().library.presets.find(role=>role.id===current.nodes[1]!.config.rolePresetId)
    expect(current.id).not.toBe(source.id);expect(current.title).toBe('Saved as copy')
    expect(role).toMatchObject({scope:'workflow',workflowId:current.id,name:'Source local role'})
    expect(store.getSnapshot().library.presets.some(role=>role.workflowId===current.id&&role.name==='Unused source role')).toBe(true)
    expect(host.get(source.id).title).toBe(source.title);expect(api.save).not.toHaveBeenCalled();expect(store.getSnapshot().libraryWarning).toBeUndefined()
  })
  it('keeps a committed Save As successful when both asset catalog refreshes fail',async()=>{
    const {source,host,api,store}=fixture();await store.open(source.id)
    const raw=exportWorkflowJson({...source,title:'Committed copy'},{presets:store.getSnapshot().library.presets})
    vi.mocked(api.list).mockRejectedValueOnce(new Error('Catalog offline'));vi.mocked(api.presets).mockRejectedValueOnce(new Error('Roles offline'))
    await expect(store.saveAs(raw)).resolves.toBeUndefined()
    expect(host.workflows('').some(workflow=>workflow.title==='Committed copy')).toBe(true)
    expect(store.getSnapshot().workflow?.title).toBe('Committed copy');expect(store.getSnapshot().libraryWarning).toContain('流程已保存')
    expect(api.importPackage).toHaveBeenCalledOnce()
  })
  it('does not create a copy when saving the previous editor fails',async()=>{
    const {host,source,api,store}=fixture();vi.mocked(api.save).mockRejectedValueOnce(new Error('Source save conflict'))
    await expect(copyWorkflowCard(store,source,'Should not be created')).rejects.toThrow('Source save conflict')
    expect(api.importPackage).not.toHaveBeenCalled();expect(host.workflows('')).toHaveLength(2);expect(store.getSnapshot().workflow?.title).toBe('Unrelated unsaved edits')
  })
  it('preserves edits made while copying and records the successfully created copy',async()=>{
    const {source,api,store,host}=fixture(),realImport=api.importPackage!.bind(api)
    let release!:()=>void,started!:()=>void;const entered=new Promise<void>(resolve=>started=resolve)
    vi.mocked(api.importPackage!).mockImplementationOnce(async(...args)=>{started();await new Promise<void>(resolve=>release=resolve);return realImport(...args)})
    const copying=copyWorkflowCard(store,source,'Independent copy'),rejected=expect(copying).rejects.toThrow('副本已创建')
    await entered;const editing=store.getSnapshot().workflow!;store.edit({...editing,title:'New edits while waiting'});release();await rejected
    expect(store.getSnapshot().workflow?.title).toBe('New edits while waiting');expect(store.getSnapshot().saveState).toBe('dirty')
    expect(host.workflows('').some(workflow=>workflow.title==='Independent copy')).toBe(true);expect(store.getSnapshot().library.workflows.some(workflow=>workflow.title==='Independent copy')).toBe(true)
    expect(api.save).toHaveBeenCalledOnce()
  })
})
