import { afterEach,describe,expect,it } from 'vitest'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowEditorState } from '../src/host/editor-state-store.ts'
import { compilePlanningChain,planningChainView } from '../src/shared/planning-chain.ts'
import { normalizePlanningWorkflowNumbers,renumberWorkflow } from '../src/shared/numbering.ts'
import { allNodes } from '../src/shared/workflow-validation.ts'
import { PlanningContextReader } from '../src/shared/planning-context-reader.ts'
import type { Workflow,WorkflowNode } from '../src/shared/types.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'
const directories:string[]=[],stores:WorkflowStorage[]=[]
afterEach(()=>{for(const storage of stores.splice(0))storage.close();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true})})
const node=(id:string,kind:WorkflowNode['kind'],config:WorkflowNode['config'],fixed=false):WorkflowNode=>({id,kind,config,fixed,title:id,number:'unassigned',x:10,y:20})
function fixture(nested=false){
  const directory=mkdtempSync(join(tmpdir(),'chain-acceptance-'));directories.push(directory)
  const storage=new WorkflowStorage(directory);stores.push(storage)
  const context=templateContext(),flow=context.workflow
  const main=node('old-text','template',{text:'Old'}),input=node('entry','input',{fields:[]}),output=node('result','output',{text:'Constant',outputName:'result'})
  if(nested){
    const locked=node('locked-inner','template',{text:'Fixed'},true),inner=[input,locked,main,output]
    const container=node('container','loop',{maxIterations:1,initialVariables:{},body:{nodes:inner,edges:inner.slice(1).map((item,i)=>({id:'inner-edge-'+i,source:inner[i]!.id,target:item.id}))}})
    const root=[node('root-entry','input',{fields:[]}),container,node('unrelated-fixed','template',{text:'Unrelated'},true),node('root-result','output',{text:'Constant',outputName:'root_result'})]
    flow.nodes=root;flow.edges=root.slice(1).map((item,i)=>({id:'root-edge-'+i,source:root[i]!.id,target:item.id}))
    flow.editor={viewport:{x:12,y:34,scale:1.25},scopePath:['container']}
  }else{flow.nodes=[input,main,output];flow.edges=[{id:'entry-edge',source:'entry',target:'old-text'},{id:'exit-edge',source:'old-text',target:'result'}]}
  const saved=storage.save(flow,0);context.operation='revise';context.workflow=saved;context.targetNodeIds=['old-text']
  const view=planningChainView(context,{anchorNodeId:'old-text'}),target=view.nodes.find(item=>item.nodeId==='old-text')!.alias
  const compiled=compilePlanningChain({version:1,baseDigest:view.baseDigest,baseRevision:view.baseRevision,anchorNodeId:'old-text',operations:[{op:'insert',draftRevision:0,target,position:'after',nodes:[{key:'first',template:'template',values:{text:'First'}},{key:'second',template:'template',values:{text:'Second'}}]}]},context)
  expect(compiled.issues).toEqual([])
  const editor=new WorkflowEditorState(storage)
  return {directory,storage,context,compiled,editor,saved}
}
const definition=(flow:Workflow)=>{const value=structuredClone(flow);delete (value as Partial<Workflow>).revision;delete (value as Partial<Workflow>).updatedAt;if(value.editor){delete value.editor.viewport;delete value.editor.scopePath;if(!Object.keys(value.editor).length)delete value.editor}return value}
describe('real chain proposal acceptance persists the reviewed candidate numbering',()=>{
  it.each([false,true])('preserves candidate, alias map, old identities and fixed/unrelated scopes (nested=%s)',nested=>{
    const f=fixture(nested),candidate=structuredClone(f.compiled.candidate!),proposal=f.editor.propose(candidate,f.saved.revision)
    expect(proposal.candidate).toEqual(candidate)
    let normalized=candidate
    for(let i=0;i<3;i++){normalized=normalizePlanningWorkflowNumbers(normalized,f.saved);expect(normalized).toEqual(candidate)}
    const accepted=f.editor.resolve(proposal.id,'accept',f.saved.revision),saved=f.storage.get(candidate.id)
    expect(accepted.status).toBe('accepted');expect(definition(saved)).toEqual(definition(candidate));expect(accepted.candidate).toEqual(saved)
    expect(saved.revision).toBe(candidate.revision+1)
    const old=new Map(allNodes(f.saved).map(item=>[item.id,item])),actual=new Map(allNodes(saved).map(item=>[item.id,item]))
    for(const mapping of f.compiled.chain.mapping)expect(actual.get(mapping.nodeId)!.number).toBe(mapping.actualNumber)
    for(const [id,previous]of old){const current=actual.get(id)!;expect(current.number).toBe(previous.number);expect(current.x).toBe(previous.x);expect(current.y).toBe(previous.y);if(previous.fixed)expect(current).toEqual(previous)}
    if(nested){expect(saved.edges).toEqual(f.saved.edges);expect(saved.editor!.viewport).toEqual(f.saved.editor!.viewport);expect(saved.editor!.scopePath).toEqual(['container'])}
    if(nested)for(const mapping of f.compiled.chain.mapping)expect(mapping.actualNumber.startsWith(actual.get('container')!.number+':')).toBe(true)
    expect(f.editor.resolve(proposal.id,'accept',saved.revision)).toEqual(accepted)
    f.storage.close();const reopened=new WorkflowStorage(f.directory);stores.push(reopened)
    expect(reopened.get(saved.id)).toEqual(saved)
    expect(new WorkflowEditorState(reopened).proposals(saved.id)[0]!.candidate).toEqual(saved)
  })
  it('rejects forged existing/new numbering and never enables reviewed storage through input JSON',()=>{
    const f=fixture(),forged=structuredClone(f.compiled.candidate!)
    forged.nodes.find(item=>item.id==='old-text')!.number='forged-99'
    expect(()=>f.editor.propose(forged,f.saved.revision)).toThrow('已有节点编号')
    const changed=structuredClone(f.compiled.candidate!);changed.nodes.find(item=>item.id==='allocated-0')!.number='forged-new-99'
    expect(()=>f.storage.saveReviewedCandidate(changed,f.saved.revision)).toThrow('Host 规范器')
    expect(()=>f.storage.save({...f.compiled.candidate!,reviewed:true},f.saved.revision,'agent')).toThrow()
    expect(f.storage.get(f.saved.id)).toEqual(f.saved)
  })
  it('preserves existing subagent number authority and fixed nested content at proposal creation',()=>{
    const f=fixture(true),withRole=structuredClone(f.saved)
    withRole.subAgents=[{id:'existing-role',number:'agent-1',name:'Role',prompt:'Role prompt'}]
    const saved=f.storage.save(withRole,f.saved.revision,'user'),forged=structuredClone(saved)
    forged.subAgents![0]!.number='agent-999'
    expect(()=>f.editor.propose(forged,saved.revision)).toThrow('子 Agent 编号')
    const modified=structuredClone(saved);allNodes(modified).find(item=>item.id==='locked-inner')!.config.text='Changed'
    expect(()=>f.editor.propose(modified,saved.revision)).toThrow('固定')
    expect(f.storage.get(saved.id)).toEqual(saved)
  })
  it('preserves the latest saved navigation while accepting the same reviewed definition',()=>{
    const f=fixture(true),proposal=f.editor.propose(f.compiled.candidate!,f.saved.revision),current=structuredClone(f.saved)
    current.editor={...current.editor,viewport:{x:50,y:60,scale:.5},scopePath:[]}
    const navigation=f.storage.save(current,f.saved.revision,'user')
    const accepted=f.editor.resolve(proposal.id,'accept',navigation.revision)
    expect(definition(accepted.candidate)).toEqual(definition(f.compiled.candidate!))
    expect(accepted.candidate.editor!.viewport).toEqual(current.editor!.viewport);expect(accepted.candidate.editor!.scopePath).toEqual([])
  })
  it.each([false,true])('persists post-acceptance navigation without changing the reviewed number map or definition version (nested=%s)',nested=>{
    const f=fixture(nested),proposal=f.editor.propose(f.compiled.candidate!,f.saved.revision),accepted=f.editor.resolve(proposal.id,'accept',f.saved.revision).candidate
    const navigation=structuredClone(accepted);navigation.editor={...navigation.editor,viewport:{x:500,y:600,scale:.5},scopePath:[]}
    const saved=f.storage.save(navigation,accepted.revision,'user')
    expect(saved.revision).toBe(accepted.revision);expect(saved.updatedAt).toBe(accepted.updatedAt)
    expect(definition(saved)).toEqual(definition(accepted));expect(saved.editor).toEqual(navigation.editor)
    for(const mapping of f.compiled.chain.mapping)expect(allNodes(saved).find(item=>item.id===mapping.nodeId)!.number).toBe(mapping.actualNumber)
    const forged=structuredClone(saved);forged.editor!.viewport={x:600,y:600,scale:.5};allNodes(forged).find(item=>item.id==='old-text')!.number='forged-77'
    expect(()=>f.storage.save(forged,saved.revision,'user')).toThrow('已有节点编号')
    expect(f.storage.get(saved.id)).toEqual(saved)
  })
  it.each(['user','agent'] as const)('retains ordinary %s save numbering behavior after a reviewed insertion',actor=>{
    const f=fixture(),proposal=f.editor.propose(f.compiled.candidate!,f.saved.revision)
    const accepted=f.editor.resolve(proposal.id,'accept',f.saved.revision).candidate
    expect(allNodes(accepted).map(item=>item.number)).not.toEqual(allNodes(renumberWorkflow(accepted)).map(item=>item.number))
    const saved=f.storage.save(accepted,accepted.revision,actor)
    expect(saved.nodes.map(item=>item.number)).toEqual(renumberWorkflow(accepted).nodes.map(item=>item.number))
  })
  it('rejects accepting an old number map after a definition-equivalent manual renumber, even at the same revision',()=>{
    const f=fixture(),first=f.editor.propose(f.compiled.candidate!,f.saved.revision),accepted=f.editor.resolve(first.id,'accept',f.saved.revision).candidate
    const changed=structuredClone(accepted);changed.nodes.find(item=>item.id==='old-text')!.title='New title'
    const pending=f.editor.propose(changed,accepted.revision),manual=f.storage.save(accepted,accepted.revision,'user')
    expect(manual.revision).toBe(accepted.revision)
    expect(manual.nodes.map(item=>item.number)).not.toEqual(pending.candidate.nodes.map(item=>item.number))
    expect(()=>f.editor.resolve(pending.id,'accept',manual.revision)).toThrow(/编号|number/)
    expect(f.storage.get(manual.id)).toEqual(manual);expect(f.editor.proposals(manual.id).find(item=>item.id===pending.id)!.status).toBe('pending')
  })
  it('invalidates cached actual numbers and chain digests after a same-revision ordinary renumber, while allowing pure navigation',()=>{
    const f=fixture(),proposal=f.editor.propose(f.compiled.candidate!,f.saved.revision),accepted=f.editor.resolve(proposal.id,'accept',f.saved.revision).candidate
    const context={...f.context,workflow:accepted},reader=new PlanningContextReader(context,{scopeIdentity:'owner/flow',cacheScope:'session-workflow'})
    const before=reader.chain({anchorNodeId:'old-text'},accepted.revision),identity=reader.identity
    const staleRequest={version:1,baseDigest:before.baseDigest,baseRevision:before.baseRevision,anchorNodeId:'old-text',operations:[{op:'insert',draftRevision:0,target:before.nodes.find(item=>item.nodeId==='old-text')!.alias,position:'after',nodes:[{key:'later',template:'template',values:{text:'Later'}}]}]}
    const manual=f.storage.save(accepted,accepted.revision,'user')
    expect(manual.revision).toBe(accepted.revision)
    context.workflow=manual;reader.rebind(context)
    const current=reader.chain({anchorNodeId:'old-text'},manual.revision)
    expect(reader.identity.digest).not.toBe(identity.digest);expect(current.baseDigest).not.toBe(before.baseDigest)
    expect(current.nodes.find(item=>item.nodeId==='result')!.actualNumber).not.toBe(before.nodes.find(item=>item.nodeId==='result')!.actualNumber)
    expect(()=>compilePlanningChain(staleRequest,context)).toThrow('显示编号已变化')
    const navigation=structuredClone(manual);navigation.editor={viewport:{x:100,y:200,scale:1},scopePath:[]};context.workflow=f.storage.save(navigation,manual.revision)
    expect(planningChainView(context,{anchorNodeId:'old-text'}).baseDigest).toBe(current.baseDigest)
    expect(compilePlanningChain({...staleRequest,baseDigest:current.baseDigest},context).issues).toEqual([])
  })
})
