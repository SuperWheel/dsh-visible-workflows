import { describe,it,expect } from 'vitest'
import { compileHandoffChanges,handoffCandidateIssues,handoffSelection,planningHandoffSchema,type PlanningHandoff } from '../src/shared/planning-handoff.ts'
import type { PlanningContext } from '../src/shared/planning-types.ts'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { deepContainerWire } from './fixtures/template-fill-complex-import-fixtures.ts'
import { allNodes } from '../src/shared/workflow-validation.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'

const ids={input:'a1e0d001-0000-4000-8000-000000000001',text:'a1e0d001-0000-4000-8000-000000000002',output:'a1e0d001-0000-4000-8000-000000000003'}
function context():PlanningContext{
  const ctx=templateContext();ctx.operation='revise';ctx.workflow.revision=1
  ctx.workflow.nodes=[
    {id:ids.input,kind:'input',number:'1',title:'Input',fixed:false,x:0,y:0,config:{fields:[{name:'name',label:'Name',required:true},{name:'unused',label:'Optional',required:false}]}},
    {id:ids.text,kind:'template',number:'2',title:'Before',fixed:false,x:200,y:0,config:{text:'Before',inputs:{name:`{{${ids.input}.name}}`,untouched:'keep'}}},
    {id:ids.output,kind:'output',number:'3',title:'Output',fixed:false,x:400,y:0,config:{text:`{{${ids.text}.text}}`,outputName:'result'}},
  ]
  ctx.workflow.edges=[{id:'entry',source:ids.input,target:ids.text},{id:'exit',source:ids.text,target:ids.output}]
  return ctx
}
const handoff=(value:unknown):Exclude<PlanningHandoff,{mode:'module'}>=>{
  const parsed=planningHandoffSchema.parse(value);if(parsed.mode==='module')throw Error('Expected field handoff');return parsed
}
const edit=(changes:unknown[])=>handoff({version:1,mode:'edit',changes,constraints:['保留既有结构'],evidenceRefs:['explicit-user-decision']})
describe('typed parent planning handoff through the canonical materializer',()=>{
  it('derives nested update scopes from the current graph without widening target or fixed-ancestor authority',()=>{
    const fixture=templateContext(),built=new TemplateFillingCompiler(fixture,{prefetch:['input','output','code','iteration','loop','if','assigner','aggregator']}).submit(deepContainerWire())
    if(!built.ok)throw Error(JSON.stringify(built.feedback))
    const ctx={...fixture,operation:'revise' as const,workflow:{...built.value.candidate!,revision:1}},nodes=allNodes(ctx.workflow)
    const target=nodes.find(n=>n.kind==='code'&&n.config.code?.includes('delta: inputs.item'))!,container=ctx.workflow.nodes.find(n=>n.kind==='iteration')!
    ctx.targetNodeIds=[target.id]
    const before=structuredClone(ctx.workflow),decision=edit([{op:'set-title',nodeId:target.id,value:'Nested decided'},{op:'set-config',nodeId:target.id,field:'code',value:'function main(inputs) { return { delta: inputs.item - inputs.threshold }; }'}])
    const result=compileHandoffChanges(decision,ctx);expect(result.issues).toEqual([])
    const restored=structuredClone(result.candidate!),actual=allNodes(restored).find(n=>n.id===target.id)!
    expect(actual.title).toBe('Nested decided');expect(actual.config.code).toContain('inputs.item - inputs.threshold')
    Object.assign(actual,structuredClone(nodes.find(n=>n.id===target.id)!));restored.updatedAt=before.updatedAt;expect(restored).toEqual(before)
    ctx.targetNodeIds=[container.id];expect(()=>compileHandoffChanges(decision,ctx)).toThrow('授权范围')
    ctx.targetNodeIds=[target.id];container.fixed=true
    const blocked=compileHandoffChanges(decision,ctx);expect(blocked.issues.some(issue=>issue.code==='FIXED_NODE_CHANGED')).toBe(true)
    expect(ctx.workflow.nodes.find(n=>n.id===container.id)!.fixed).toBe(true)
    expect(allNodes(ctx.workflow).find(n=>n.id===target.id)!.title).not.toBe('Nested decided')
  })

  it('compiles precise field changes without invoking an agent; preserves unrelated graph and Host state',()=>{
    const ctx=context(),before=structuredClone(ctx),decision=edit([
      {op:'set-title',nodeId:ids.text,value:'After'},
      {op:'set-config',nodeId:ids.text,field:'text',value:'Hello'},
    ])
    const compiled=compileHandoffChanges(decision,ctx),candidate=compiled.candidate!
    expect(compiled.issues).toEqual([])
    expect(candidate.nodes.find(node=>node.id===ids.text)).toMatchObject({title:'After',config:{text:'Hello',inputs:{untouched:'keep'}}})
    expect(candidate.nodes.filter(node=>node.id!==ids.text)).toEqual(ctx.workflow.nodes.filter(node=>node.id!==ids.text))
    expect(candidate.edges).toEqual(ctx.workflow.edges)
    expect(candidate.revision).toBe(ctx.workflow.revision)
    expect(ctx).toEqual(before)
    expect(handoffSelection(decision)).toEqual({targetNodeIds:[ids.text],targetFields:{[ids.text]:['title','text']},outputChanged:false})
  })
  it('replaces submitted arrays and objects atomically, preserves unspecified fields and supports explicit deletion',()=>{
    const ctx=context(),decision=edit([
      {op:'set-config',nodeId:ids.input,field:'fields',value:[{name:'name',label:'Renamed',required:true}]},
      {op:'set-config',nodeId:ids.text,field:'inputs',value:{only:'new'}},
    ])
    const candidate=compileHandoffChanges(decision,ctx).candidate!
    expect(candidate.nodes.find(node=>node.id===ids.input)!.config.fields).toEqual([{name:'name',label:'Renamed',required:true}])
    expect(candidate.nodes.find(node=>node.id===ids.text)!.config.inputs).toEqual({only:'new'})
    expect(candidate.nodes.find(node=>node.id===ids.text)!.config.text).toBe('Before')
    const deleted=compileHandoffChanges(edit([{op:'unset-config',nodeId:ids.text,field:'inputs'}]),ctx).candidate!
    expect(deleted.nodes.find(node=>node.id===ids.text)!.config).not.toHaveProperty('inputs')
  })
  it('resolves stable UUID references through Host aliases without changing the final reference target',()=>{
    const candidate=compileHandoffChanges(edit([{op:'set-config',nodeId:ids.text,field:'text',value:`Hello {{${ids.input}.name}}`}]),context()).candidate!
    expect(candidate.nodes.find(node=>node.id===ids.text)!.config.text).toBe(`Hello {{${ids.input}.name}}`)
    expect(candidate.nodes.find(node=>node.id===ids.output)!.config.text).toBe(`{{${ids.text}.text}}`)
  })
  it('rejects fixed, missing and unauthorized targets; rejects illegal field values without mutating baseline',()=>{
    const ctx=context(),decision=edit([{op:'set-config',nodeId:ids.text,field:'text',value:'changed'}])
    ctx.targetNodeIds=[ids.output]
    expect(()=>compileHandoffChanges(decision,ctx)).toThrow('授权范围')
    ctx.targetNodeIds=[];ctx.workflow.nodes.find(node=>node.id===ids.text)!.fixed=true
    expect(()=>compileHandoffChanges(decision,ctx)).toThrow('固定节点')
    ctx.workflow.nodes.find(node=>node.id===ids.text)!.fixed=false
    const before=structuredClone(ctx.workflow)
    expect(()=>compileHandoffChanges(edit([{op:'set-config',nodeId:'missing',field:'text',value:'bad'}]),ctx)).toThrow('不存在')
    expect(()=>compileHandoffChanges(edit([{op:'set-config',nodeId:ids.text,field:'text',value:123}]),ctx)).toThrow()
    expect(ctx.workflow).toEqual(before)
    expect(()=>planningHandoffSchema.parse({version:1,mode:'edit',changes:[{op:'set-config',nodeId:ids.text,field:'body',value:{}}]})).toThrow()
    expect(()=>edit([{op:'set-config',nodeId:ids.text,field:'text',value:'a'},{op:'unset-config',nodeId:ids.text,field:'text'}])).toThrow('冲突')
  })
  it('points a field change at a node only an unaccepted proposal adds to one splice instead (Desktop r59 E)',()=>{
    const pending='7f265899-5fda-4428-850d-23077f515ff3'
    const result=compileHandoffChanges(edit([{op:'set-config',nodeId:ids.text,field:'text',value:`{% for item in ${pending}.rows %}{{item.ext}}{% endfor %}`}]),context())
    expect(result.issues).toEqual([expect.objectContaining({code:'INVALID_REFERENCE',message:expect.stringMatching(new RegExp(`节点引用 ${pending}\\.rows 不存在.*visible_workflow_splice.*先 insert 新节点，再 update`))})])
  })
  it('permits only unresolved fields after applying decided changes and protects every other semantic field',()=>{
    const ctx=context(),decision=handoff({version:1,mode:'partial',changes:[{op:'set-title',nodeId:ids.text,value:'Decided title'}],unresolved:[{nodeId:ids.text,fields:['text'],question:'Fill the greeting text'}]})
    const decided=compileHandoffChanges(decision,ctx).candidate!,candidate=structuredClone(decided)
    candidate.nodes.find(node=>node.id===ids.text)!.config.text='Completed';candidate.updatedAt='2026-10-19T00:00:00.000Z'
    expect(handoffCandidateIssues(decision,decided,candidate)).toEqual([])
    candidate.nodes.find(node=>node.id===ids.text)!.title='Changed decided title'
    expect(handoffCandidateIssues(decision,decided,candidate)[0]!.code).toBe('HANDOFF_DECISION_CONFLICT')
    const topology=structuredClone(decided);topology.edges=[]
    expect(handoffCandidateIssues(decision,decided,topology)[0]!.code).toBe('HANDOFF_DECISION_CONFLICT')
    const host=structuredClone(decided);host.revision++
    expect(handoffCandidateIssues(decision,decided,host)[0]!.code).toBe('HANDOFF_DECISION_CONFLICT')
    expect(()=>planningHandoffSchema.parse({version:1,mode:'partial',changes:[{op:'set-config',nodeId:ids.text,field:'text',value:'decided'}],unresolved:[{nodeId:ids.text,fields:['text'],question:'Conflict'}]})).toThrow('重叠')
  })
  it('combines multiple unresolved questions on one stable node without losing earlier authorized fields',()=>{
    const ctx=context(),decision=handoff({version:1,mode:'partial',changes:[],unresolved:[
      {nodeId:ids.text,fields:['text'],question:'Fill text'},
      {nodeId:ids.text,fields:['inputs'],question:'Fill inputs'},
    ]})
    const decided=compileHandoffChanges(decision,ctx).candidate!,candidate=structuredClone(decided)
    candidate.nodes.find(node=>node.id===ids.text)!.config.text='Completed'
    candidate.nodes.find(node=>node.id===ids.text)!.config.inputs={next:'answer'}
    expect(handoffCandidateIssues(decision,decided,candidate)).toEqual([])
  })
})
