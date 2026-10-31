import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowTemplateLibrary } from '../src/host/template-library.ts'
import { exportWorkflowJson, exportWorkflowPackage, importWorkflowJson } from '../src/shared/workflow-format.ts'
import { makeWorkflow, type Workflow } from '../src/shared/types.ts'
import { bindNodeSubagent, createWorkflowSubagent } from '../src/shared/workflow-subagents.ts'

const directories:string[]=[],stores:WorkflowStorage[]=[]
function directory(){const value=mkdtempSync(join(tmpdir(),'workflow-scope-store-'));directories.push(value);return value}
function storage(path=directory()){const value=new WorkflowStorage(path);stores.push(value);return value}
function caller(workspaceId:string,title:string,scope?:Workflow['scope']):Workflow{
  const flow=makeWorkflow(workspaceId,title,true);if(scope)flow.scope=scope
  flow.nodes[1]!.kind='agent';flow.nodes[1]!.config={prompt:'执行',tools:[]}
  bindNodeSubagent(flow,flow.nodes[1]!.id,createWorkflowSubagent(flow,title))
  return flow
}
afterEach(()=>{for(const value of stores.splice(0))value.close();for(const value of directories.splice(0))rmSync(value,{recursive:true,force:true})})

describe('workflow scope storage boundaries',()=>{
  it('keeps management ownership filtering and exposes only active project or explicit global definitions',()=>{
    const store=storage(),own=store.save(makeWorkflow('project-a','own'),0),other=store.save(makeWorkflow('project-b','other'),0)
    const global=store.save({...makeWorkflow('project-b','shared'),scope:'global'},0),archived=store.save({...makeWorkflow('project-c','archived shared'),scope:'global'},0)
    store.remove(archived.id,archived.revision)
    expect(store.workflows('project-a').map(flow=>flow.id)).toEqual([own.id])
    expect(store.workflows().map(flow=>flow.id)).toEqual([own.id,other.id,global.id])
    expect(store.visibleWorkflows('project-a').map(flow=>flow.id)).toEqual([own.id,global.id])
    expect(store.visibleWorkflows('project-b').map(flow=>flow.id)).toEqual([other.id,global.id])
    expect(store.visibleWorkflows('unrelated').map(flow=>flow.id)).toEqual([global.id])
    expect(store.visibleWorkflows('')).toEqual([])
    const detached=store.visibleWorkflows('project-a');detached[0]!.title='mutated';expect(store.get(own.id).title).toBe('own')
  })
  it('allows user scope changes while rejecting agent promotion, demotion and new global creation',()=>{
    const store=storage(),legacy=store.save(makeWorkflow('project-a'),0),file=join(store.directory,'library.json')
    const before=readFileSync(file,'utf8')
    expect(store.save({...legacy,scope:'workspace'},legacy.revision,'agent')).toEqual(legacy)
    expect(readFileSync(file,'utf8')).toBe(before)
    expect(()=>store.save({...legacy,scope:'global'},legacy.revision,'agent')).toThrow('Agent 不能更改')
    expect(()=>store.save({...makeWorkflow('project-a'),scope:'global'},0,'agent')).toThrow('Agent 不能更改')
    expect(readFileSync(file,'utf8')).toBe(before)
    const global=store.save({...legacy,scope:'global'},legacy.revision)
    expect(global.scope).toBe('global')
    for(const scope of ['workspace',undefined] as const)expect(()=>store.save({...global,scope},global.revision,'agent')).toThrow('Agent 不能更改')
    const edited=store.save({...global,title:'agent content edit'},global.revision,'agent')
    expect(edited.scope).toBe('global');expect(edited.title).toBe('agent content edit')
    expect(store.save({...edited,scope:'workspace'},edited.revision).scope).toBe('workspace')
    expect(()=>store.save({...edited,workspaceId:'project-b'},edited.revision)).toThrow()
  })
  it('downgrades direct bundle imports and child definitions, retaining an overwrite target scope',()=>{
    const store=storage(),source={...makeWorkflow('target'),scope:'global' as const},child={...makeWorkflow('target'),scope:'global' as const}
    const imported=store.importBundle(source,[],undefined,[child])
    expect(imported.scope).toBe('workspace');expect(store.get(child.id).scope).toBe('workspace')
    expect(source.scope).toBe('global');expect(child.scope).toBe('global')
    for(const scope of ['global','workspace',undefined] as const){
      const target=store.save({...makeWorkflow('target'),...(scope?{scope}:{})},0),incoming={...makeWorkflow('target'),scope:'global' as const}
      const overwritten=store.importBundle(incoming,[],{workflowId:target.id,expectedRevision:target.revision})
      expect(overwritten.id).toBe(target.id);expect(overwritten.scope).toBe(scope)
    }
  })
  it('binds local subagents but never mutates or traverses another project global owner graph',()=>{
    const store=storage(),global=caller('owner','shared','global'),privateChild=store.save(caller('owner','private child'),0)
    global.nodes[1]!.config.tools=[`workflow:${privateChild.id}`]
    const savedGlobal=store.save(global,0),local=store.save(caller('caller','local'),0),root=caller('caller','root')
    root.nodes[1]!.config.tools=[`workflow:${local.id}`,`workflow:${savedGlobal.id}`]
    const savedRoot=store.save(root,0),beforeGlobal=store.get(savedGlobal.id),beforeChild=store.get(privateChild.id)
    const bound=store.bindSubagents(savedRoot.id,savedRoot.revision,'caller-session')
    expect(bound.subAgents![0]!.sessionId).toBe('caller-session')
    expect(store.get(local.id).subAgents![0]!.sessionId).toBe('caller-session')
    expect(store.get(savedGlobal.id)).toEqual(beforeGlobal);expect(store.get(privateChild.id)).toEqual(beforeChild)
  })
  it('clears every saved global subagent session while retaining project-local bindings',()=>{
    const store=storage(),global=caller('owner','global','global')
    global.subAgents![0]!.sessionId='owner-session'
    global.subAgents!.push(createWorkflowSubagent(global,'unused','unused-session'))
    const saved=store.save(global,0)
    expect(saved.subAgents!.every(agent=>agent.sessionId===undefined)).toBe(true)
    expect(global.subAgents!.map(agent=>agent.sessionId)).toEqual(['owner-session','unused-session'])
    const submitted=structuredClone(saved);submitted.subAgents![0]!.sessionId='caller-session'
    expect(store.save(submitted,saved.revision,'agent')).toEqual(saved)
    const local=caller('owner','local');local.subAgents![0]!.sessionId='owner-session'
    expect(store.save(local,0).subAgents![0]!.sessionId).toBe('owner-session')
  })
  it('binds legacy global roots for independent sessions without changing their graph or revision',()=>{
    const path=directory(),legacy=caller('owner','legacy global','global');legacy.revision=1
    legacy.subAgents![0]!.sessionId='legacy-owner-session';legacy.nodes[1]!.fixed=true
    writeFileSync(join(path,'library.json'),JSON.stringify({schema:2,workflows:[legacy],presets:[]}))
    const store=storage(path),before=store.get(legacy.id),file=join(path,'library.json'),bytes=readFileSync(file,'utf8')
    for(const sessionId of ['owner-new-session','other-project-session']){
      const bound=store.bindSubagents(legacy.id,legacy.revision,sessionId)
      expect(bound.subAgents![0]!.sessionId).toBe(sessionId);expect(bound.revision).toBe(legacy.revision)
      expect(store.get(legacy.id)).toEqual(before);expect(readFileSync(file,'utf8')).toBe(bytes)
    }
    expect(()=>store.bindSubagents(legacy.id,legacy.revision+1,'other')).toThrow('已被修改')
    const edited=store.save({...before,title:'agent content edit'},before.revision,'agent')
    expect(edited.subAgents![0]!.sessionId).toBeUndefined();expect(edited.title).toBe('agent content edit')
    const forbidden=structuredClone(edited);forbidden.subAgents![0]!.prompt='changed fixed role'
    expect(()=>store.save(forbidden,edited.revision,'agent')).toThrow('子 Agent 定义不能由 Agent 修改')
  })
  it('skips same-project global child persistence and traversal when binding local roots',()=>{
    const store=storage(),global=caller('owner','global','global'),foreign=store.save(caller('foreign','foreign private'),0)
    global.nodes[1]!.config.tools=[`workflow:${foreign.id}`]
    const savedGlobal=store.save(global,0),root=caller('owner','local root')
    root.nodes[1]!.config.tools=[`workflow:${savedGlobal.id}`]
    const savedRoot=store.save(root,0),beforeGlobal=store.get(savedGlobal.id),beforeForeign=store.get(foreign.id)
    expect(store.bindSubagents(savedRoot.id,savedRoot.revision,'owner-session').subAgents![0]!.sessionId).toBe('owner-session')
    expect(store.get(savedGlobal.id)).toEqual(beforeGlobal);expect(store.get(foreign.id)).toEqual(beforeForeign)
    for(const sessionId of ['owner-session','other-project-session'])expect(store.bindSubagents(savedGlobal.id,savedGlobal.revision,sessionId).subAgents![0]!.sessionId).toBe(sessionId)
    expect(store.get(savedGlobal.id)).toEqual(beforeGlobal);expect(store.get(foreign.id)).toEqual(beforeForeign)
  })
  it('rejects private cross-project dependencies atomically before persisting any local bindings',()=>{
    const store=storage(),privateChild=store.save(caller('other','private'),0),root=caller('caller','root')
    root.nodes[1]!.config.tools=[`workflow:${privateChild.id}`]
    const saved=store.save(root,0),before=readFileSync(join(store.directory,'library.json'),'utf8')
    expect(()=>store.bindSubagents(saved.id,saved.revision,'caller-session')).toThrow('非全局')
    expect(readFileSync(join(store.directory,'library.json'),'utf8')).toBe(before)
  })
})

describe('portable workflow scope boundaries',()=>{
  it('exports visible global dependencies as project definitions and rechecks hand-written package scopes on import',()=>{
    const root=caller('caller','root','global'),global=caller('owner','shared','global'),privateOther=caller('other','private')
    root.nodes[1]!.config.tools=[`workflow:${global.id}`,`workflow:${privateOther.id}`]
    const pkg=exportWorkflowPackage(root,{workflows:[global,privateOther]})
    expect(pkg.workflows.map(flow=>flow.id)).toEqual([global.id])
    expect([pkg.workflow,...pkg.workflows].map(flow=>flow.scope)).toEqual(['workspace','workspace'])
    pkg.workflow.scope='global';pkg.workflows[0]!.scope='global'
    const imported=importWorkflowJson(JSON.stringify(pkg),'destination')
    expect([imported.workflow,...imported.workflows].every(flow=>flow.scope==='workspace'&&flow.workspaceId==='destination')).toBe(true)
    expect(root.scope).toBe('global');expect(global.scope).toBe('global')
  })
  it('creates project-scoped template instances even from a global source definition',()=>{
    const library=new WorkflowTemplateLibrary(directory()),flow={...makeWorkflow('owner'),scope:'global' as const}
    const saved=library.save(flow),raw=JSON.parse(library.get(saved.id).packageJson)
    expect(raw.workflow.scope).toBe('workspace')
    const instance=library.instantiate(saved.id,'target')
    expect(instance.workflow.scope).toBe('workspace');expect(instance.workflow.workspaceId).toBe('target')
    const imported=importWorkflowJson(exportWorkflowJson(flow),'target').workflow
    expect(imported.scope).toBe('workspace')
  })
})
