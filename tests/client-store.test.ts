import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowStore } from '../src/client/store.ts'
import { makeWorkflow, type WorkflowAPI, type LibrarySnapshot, type Workflow, type WorkflowRun } from '../src/shared/types.ts'
import { remapNodeConfig } from '../src/client/copy.ts'
function fixture(){
  const flow=makeWorkflow('workspace','Example',true);flow.revision=1
  const library:LibrarySnapshot={workflows:[flow],workspaces:[{id:'workspace',name:'Project'}],presets:[],runs:[]}
  const api={list:vi.fn(async()=>structuredClone(library)),get:vi.fn(async()=>structuredClone(flow)),save:vi.fn(async(raw:string,revision:number)=>({...JSON.parse(raw),revision:revision+1})),models:vi.fn(async()=>[]),start:vi.fn()} as unknown as WorkflowAPI
  const store=new WorkflowStore(api)
  return {flow,library,api,store}
}
afterEach(()=>vi.useRealTimers())
describe('workflow editor persistence',()=>{
  it('does not start a run when its latest draft failed to save',async()=>{
    const {store,api}=fixture();await store.load();await store.open('id')
    store.edit({...store.getSnapshot().workflow!,title:'unsaved'})
    vi.mocked(api.save).mockRejectedValueOnce(new Error('disk full'))
    await expect(store.execute()).rejects.toThrow('disk full')
    expect(api.start).not.toHaveBeenCalled();expect(store.getSnapshot().saveState).toBe('error');expect(store.getSnapshot().workflow?.title).toBe('unsaved');store.dispose()
  })
  it('serializes edits made during an in-flight write using the new revision',async()=>{
    const {store,api}=fixture();await store.load();await store.open('id')
    let release!:(value:Workflow)=>void
    vi.mocked(api.save).mockImplementationOnce(()=>new Promise(resolve=>release=resolve))
    store.edit({...store.getSnapshot().workflow!,title:'first'})
    const saving=store.flush()
    const first=structuredClone(store.getSnapshot().workflow!)
    store.edit({...first,title:'second'})
    release({...first,revision:2});await saving
    expect(vi.mocked(api.save).mock.calls.map(call=>call[1])).toEqual([1,2]);expect(store.getSnapshot().workflow?.title).toBe('second');expect(store.getSnapshot().workflow?.revision).toBe(3);store.dispose()
  })
  it('redo restores the saved edit and stable node IDs without recreating nodes',async()=>{
    const {store,flow}=fixture();await store.load();await store.open('id')
    const moved=structuredClone(flow);moved.nodes[0]!.x+=50;store.edit(moved);store.undo();expect(store.getSnapshot().workflow?.nodes[0]?.x).toBe(flow.nodes[0]?.x);store.redo();expect(store.getSnapshot().workflow?.nodes[0]?.id).toBe(flow.nodes[0]?.id);expect(store.getSnapshot().workflow?.nodes[0]?.x).toBe(moved.nodes[0]?.x);await store.flush();store.dispose()
  })
  it('adopts an Agent edit only when the local draft is clean',async()=>{
    vi.useFakeTimers();const {store,library,api}=fixture();await store.load();await store.open('id')
    library.workflows[0]={...library.workflows[0]!,title:'Agent edit',revision:2};await vi.advanceTimersByTimeAsync(3000);expect(store.getSnapshot().workflow?.title).toBe('Agent edit')
    store.edit({...store.getSnapshot().workflow!,title:'local pending'});vi.mocked(api.save).mockRejectedValue(new Error('revision conflict'));library.workflows[0]={...library.workflows[0]!,title:'another Agent edit',revision:3};await vi.advanceTimersByTimeAsync(3000);expect(store.getSnapshot().workflow?.title).toBe('local pending');expect(store.getSnapshot().saveState).toBe('error');store.dispose()
  })
  it('protects the current graph when a running record is not the displayed record',async()=>{
    const {store,flow,library}=fixture();library.runs=[{id:'active',workflowId:flow.id,workspaceId:'workspace',workflowTitle:flow.title,sourceRevision:1,graph:flow,status:'running',inputs:{},outputs:{},executions:[],startedAt:new Date().toISOString()}];await store.load();await store.open('id');store.update({run:undefined});expect(()=>store.edit({...flow,title:'cannot overwrite'})).toThrow('停止当前运行');store.dispose()
  })
  it('ignores an old navigation after a newer workflow has opened and been edited',async()=>{
    const {store,api,flow}=fixture();await store.load()
    const a={...structuredClone(flow),id:'A',title:'A'},b={...structuredClone(flow),id:'B',title:'B'}
    let returnA!:(flow:Workflow)=>void,returnB!:(flow:Workflow)=>void
    vi.mocked(api.get).mockImplementation(id=>new Promise(resolve=>{if(id==='A')returnA=resolve;else returnB=resolve}))
    const first=store.open('A');await Promise.resolve();const second=store.open('B');await Promise.resolve()
    returnB(b);await second;store.edit({...store.getSnapshot().workflow!,title:'Edited B'})
    returnA(a);await first;expect(store.getSnapshot().workflow?.id).toBe('B');expect(store.getSnapshot().workflow?.title).toBe('Edited B')
    await store.flush();expect(JSON.parse(vi.mocked(api.save).mock.calls.at(-1)![0]).title).toBe('Edited B');store.dispose()
  })
  it('never adopts an old library result after saving a new revision',async()=>{
    vi.useFakeTimers();const {store,api,flow}=fixture();await store.load();await store.open(flow.id)
    let oldList!:(library:LibrarySnapshot)=>void
    vi.mocked(api.list).mockImplementationOnce(()=>new Promise(resolve=>oldList=resolve))
    await vi.advanceTimersByTimeAsync(3000)
    store.edit({...store.getSnapshot().workflow!,title:'Saved revision 2'});await store.flush()
    oldList({workflows:[flow],presets:[],runs:[],workspaces:[]});await Promise.resolve();await Promise.resolve()
    expect(store.getSnapshot().workflow?.revision).toBe(2);expect(store.getSnapshot().workflow?.title).toBe('Saved revision 2');expect(store.getSnapshot().undo).toHaveLength(1);store.dispose()
  })
  it('copies only actual node references and preserves text-shaped IDs in field names and ordinary prose',()=>{
    const config={fields:[{name:'text',label:'a text field',required:true,defaultValue:'a'}],text:'plain a and text; {{text.text}}; {{ a.text }}; {{input.text}}; {{external.text}}',prompt:'provider a: {{a.text}}',variable:'a.text',outputName:'text',model:{provider:'a',model:'text'},value:'a'}
    const copy=remapNodeConfig(config,new Map([['a','new-a'],['text','new-text']]))
    expect(copy.text).toBe('plain a and text; {{new-text.text}}; {{ new-a.text }}; {{input.text}}; {{external.text}}');expect(copy.prompt).toBe('provider a: {{new-a.text}}');expect(copy.variable).toBe('new-a.text');expect(copy.fields).toEqual(config.fields);expect(copy.model).toEqual(config.model);expect(copy.value).toBe('a');expect(copy.outputName).toBe('text')
  })
  it('does not let an old running response restore a cancelled run',async()=>{
    vi.useFakeTimers();const {store,api,flow}=fixture();await store.load();await store.open(flow.id)
    const running:WorkflowRun={id:'run',workflowId:flow.id,workspaceId:flow.workspaceId,workflowTitle:flow.title,sourceRevision:flow.revision,graph:flow,status:'running',inputs:{text:'input'},outputs:{},executions:[],startedAt:new Date().toISOString()}
    let oldPoll!:(run:WorkflowRun)=>void
    api.start=vi.fn(async()=>running);api.run=vi.fn(()=>new Promise(resolve=>oldPoll=resolve));api.cancel=vi.fn(async()=>({...running,status:'cancelled'}))
    await store.execute();await vi.advanceTimersByTimeAsync(700);await store.cancel();oldPoll(running);await Promise.resolve();await Promise.resolve()
    expect(store.getSnapshot().run?.status).toBe('cancelled');store.dispose()
  })
})

describe('expanded canvas graph editing',()=>{
  it('persists the active session as execution context without invoking a main Agent',async()=>{
    const {store,api,flow}=fixture();await store.load();await store.open(flow.id);store.update({sessionId:'conversation-id'})
    api.start=vi.fn(async()=>({id:'r',workflowId:flow.id,workspaceId:flow.workspaceId,workflowTitle:flow.title,sourceRevision:1,graph:flow,status:'success',inputs:{},outputs:{},executions:[],startedAt:''}))
    await store.execute({text:'example'});expect(api.start).toHaveBeenCalledWith(flow.id,'{"text":"example"}','conversation-id');store.dispose()
  })
  it('creates saveable node configurations for every selectable node kind',async()=>{
    const {newNode,NODE_DEFINITIONS}=await import('../src/client/nodes.ts')
    const {parseWorkflow}=await import('../src/host/validation.ts')
    for(const entry of NODE_DEFINITIONS){const flow=makeWorkflow('workspace');flow.nodes.push(newNode(entry.kind));expect(()=>parseWorkflow(flow),entry.kind).not.toThrow()}
  })
  it('copies nested container identities and every internal reference while preserving external literals',async()=>{
    const {newNode,allNodes}=await import('../src/client/nodes.ts'),{copyNodes}=await import('../src/client/copy.ts')
    const container=newNode('iteration'),inner=container.config.body!,template=inner.nodes.find(n=>n.kind==='template')!
    const nested=newNode('loop');inner.nodes.push(nested)
    template.config.text=`{{${inner.nodes[0]!.id}.json.payload}} / {{external.text}} / plain input text`
    const human=newNode('human');human.config.fields![0]!.defaultValue=`{{${template.id}.text}}`;inner.nodes.push(human)
    const doc=newNode('document');doc.config.source=`${template.id}.json.file`;inner.nodes.push(doc)
    const source={nodes:[container],edges:[]},copy=copyNodes(source),before=allNodes(source),after=allNodes(copy)
    expect(after).toHaveLength(before.length);expect(after.every(n=>!before.some(o=>o.id===n.id))).toBe(true)
    const outTemplate=after.find(n=>n.title===template.title)!,outInput=after.find(n=>n.kind==='input')!
    expect(outTemplate.config.text).toBe(`{{${outInput.id}.json.payload}} / {{external.text}} / plain input text`)
    expect(after.find(n=>n.kind==='human')!.config.fields![0]!.defaultValue).toBe(`{{${outTemplate.id}.text}}`)
    expect(after.find(n=>n.kind==='document')!.config.source).toBe(`${outTemplate.id}.json.file`)
    const ids=new Set(after.map(n=>n.id));expect(copy.nodes[0]!.config.body!.edges.every(e=>ids.has(e.source)&&ids.has(e.target))).toBe(true)
    expect(copy.nodes[0]!.config.outputVariable).not.toBe(container.config.outputVariable)
    expect(container.config.body!.nodes.find(n=>n.id===template.id)!.config.text).toContain(inner.nodes[0]!.id)
  })
  it('edits a nested graph without overwriting the surrounding graph and restores it through undo',async()=>{
    const {newNode,graphAt,replaceGraph}=await import('../src/client/nodes.ts'),{store,flow}=fixture();flow.nodes.push(newNode('iteration'));await store.load();await store.open(flow.id)
    const outer=store.getSnapshot().workflow!,container=outer.nodes.at(-1)!,body=graphAt(outer,[container.id]),extra=newNode('template')
    store.edit({...outer,...replaceGraph(outer,[container.id],{...body,nodes:[...body.nodes,extra]})})
    expect(store.getSnapshot().workflow!.nodes.map(n=>n.id)).toEqual(outer.nodes.map(n=>n.id))
    expect(graphAt(store.getSnapshot().workflow!,[container.id]).nodes.at(-1)!.id).toBe(extra.id)
    store.undo();expect(graphAt(store.getSnapshot().workflow!,[container.id]).nodes).toHaveLength(body.nodes.length);await store.flush();store.dispose()
  })
})

describe('runtime-consistent variable hints',()=>{
  it('uses declared code outputs and actual tool data instead of inventing a text field',async()=>{
    const {newNode,outputFields}=await import('../src/client/nodes.ts')
    const code=newNode('code');expect(outputFields(code)).toEqual(['result']);expect(outputFields(code,{result:'value'})).not.toContain('text')
    const tool=newNode('tool');expect(outputFields(tool)).toEqual([]);expect(outputFields(tool,{answer:0,json:{ok:true}})).toEqual(['answer','json'])
    expect(outputFields(newNode('list'))).toContain('first_record');expect(outputFields(newNode('http'))).toContain('status_code')
    expect(outputFields(newNode('classifier'))).toContain('class_id');expect(outputFields(newNode('human'))).toContain('__action_id')
  })
  it('offers only connected current-scope and ancestor dependencies, never children of another container',async()=>{
    const {newNode,availableNodes}=await import('../src/client/nodes.ts')
    const flow=makeWorkflow('workspace'),pre=newNode('code'),iteration=newNode('iteration'),other=newNode('loop'),after=newNode('output')
    flow.nodes=[flow.nodes[0]!,pre,iteration,other,after];flow.edges=[{id:'e1',source:flow.nodes[0]!.id,target:pre.id},{id:'e2',source:pre.id,target:iteration.id},{id:'e3',source:iteration.id,target:after.id}]
    const body=iteration.config.body!,innerOutput=body.nodes.at(-1)!,visible=availableNodes(flow,[iteration.id],innerOutput.id)
    expect(visible.map(n=>n.id)).toContain(pre.id);expect(visible.map(n=>n.id)).toContain(body.nodes[1]!.id)
    expect(visible.map(n=>n.id)).not.toContain(iteration.id);expect(visible.map(n=>n.id)).not.toContain(after.id)
    for(const child of other.config.body!.nodes)expect(visible.map(n=>n.id)).not.toContain(child.id)
    const outside=availableNodes(flow,[],after.id).map(n=>n.id);expect(outside).toContain(iteration.id)
    for(const child of body.nodes)expect(outside).not.toContain(child.id)
  })
  it('keeps the factory and language bounds within the actual execution adapter timeout',async()=>{
    const {newNode,codeTimeout}=await import('../src/client/nodes.ts')
    expect(newNode('code').config.timeoutMs).toBeLessThanOrEqual(codeTimeout('javascript'))
    expect(codeTimeout('javascript')).toBe(3000);expect(codeTimeout('python')).toBe(10000)
  })
})
