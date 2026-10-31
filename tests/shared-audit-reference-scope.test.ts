import { describe, expect, it } from 'vitest'
import { graphIssues } from '../src/host/validation.ts'
import { assertReferenceAllowed, createReferenceScopePlan, referenceScopeIssues } from '../src/shared/reference-scope.ts'
import type { NodeGraph, Workflow, WorkflowNode } from '../src/shared/types.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'

const node=(id:string,kind:WorkflowNode['kind'],config:WorkflowNode['config']={}):WorkflowNode=>({id,kind,config,title:id,number:id,x:0,y:0,fixed:false})
const edge=(source:string,target:string,port?:string)=>({id:`${source}-${target}-${port??'default'}`,source,target,...(port?{port}:{})})
function flow(nodes:WorkflowNode[],edges:NodeGraph['edges']):Workflow {return {...templateContext().workflow,nodes,edges}}
function branch(kind:WorkflowNode['kind']='if',config:WorkflowNode['config']={variable:'input.flag',operator:'equals',value:'yes'},ports=['true','false']):Workflow {
  return flow([
    node('start','input',{fields:[{name:'flag',label:'标记',required:true}]}),node('cond',kind,config),
    node('left','template',{text:'left'}),node('right','template',{text:'right'}),node('merge','output',{text:'{{left.text}}'}),
  ],[edge('start','cond'),edge('cond','left',ports[0]),edge('cond','right',ports[1]),edge('left','merge'),edge('right','merge')])
}
function unsafe(graph:Workflow,id='merge',reference='left.text') {
  for(const issues of [referenceScopeIssues(graph,{strictMissing:true}),graphIssues(graph,true)]){
    expect(issues.some(issue=>issue.nodeId===id&&issue.message.includes(reference)&&issue.message.includes('某些分支下不可用')&&issue.message.includes('聚合'))).toBe(true)
  }
}
function safe(graph:Workflow) {
  expect(referenceScopeIssues(graph,{strictMissing:true})).toEqual([])
  expect(graphIssues(graph,true)).toEqual([])
}

describe('required references across exclusive and parallel branches',()=>{
  it('rejects a one-sided required output after an exclusive merge',()=>{
    const graph=branch()
    unsafe(graph)
    // Runtime access still uses the may-scope, including optional candidates.
    const scope=createReferenceScopePlan(graph).nodes.get('merge')!
    expect(scope.nodeIds.has('left')).toBe(true)
    expect(scope.mustNodeIds!.has('left')).toBe(false)
    expect(()=>assertReferenceAllowed('left.text',scope)).not.toThrow()
    expect(graphIssues(graph,false)).toEqual([])
  })
  it.each(['template','tool','if'] as const)('checks required %s references as well as output text',kind=>{
    const graph=branch(),merge=graph.nodes.find(n=>n.id==='merge')!
    merge.kind=kind
    merge.config=kind==='template'?{text:'{{left.text}}'}:kind==='tool'?{toolId:'builtin:json.stringify',inputs:{value:'{{left.text}}'}}:{variable:'left.text',operator:'not_empty'}
    unsafe(graph)
  })
  it.each([
    ['cases',{cases:[{id:'match',conditions:[{variable:'input.flag',operator:'equals',value:'yes'}]}]},['match','false']],
    ['logic gate',{logicGate:{operator:'IF',inputs:[{value:'{{input.flag}}',predicate:'truthy'}]}},['true','false']],
  ] as const)('handles exclusive if %s exits',(_name,config,ports)=>{
    unsafe(branch('if',structuredClone(config) as WorkflowNode['config'],[...ports]))
  })
  it('handles classifier categories as mutually exclusive',()=>{
    unsafe(branch('classifier',{model:{provider:'offline',model:'test'},prompt:'分类',classes:[{id:'a',label:'甲'},{id:'b',label:'乙'}]},['a','b']))
  })
  it('handles human action exits as mutually exclusive',()=>{
    unsafe(branch('human',{actions:[{id:'approve',label:'通过'},{id:'reject',label:'拒绝'}]},['approve','reject']))
  })
  it('preserves human default plus action fan-out and separates timeout',()=>{
    const graph=branch('human',{actions:[{id:'approve',label:'通过'}]},['default','approve'])
    safe(graph)
    graph.nodes.push(node('timed_out','template',{text:'timeout'}))
    graph.edges.push(edge('cond','timed_out','timeout'),edge('timed_out','merge'))
    unsafe(graph)
  })
  it('permits a same-branch consumer and a producer before the split',()=>{
    const graph=branch()
    graph.nodes.push(node('same_branch','template',{text:'{{left.text}}'}))
    graph.edges.push(edge('left','same_branch'))
    graph.nodes.find(n=>n.id==='merge')!.config.text='{{start.flag}}/{{cond.branch}}'
    safe(graph)
  })
  it('permits all results when ordinary outgoing edges run in parallel',()=>{
    const graph=branch()
    graph.nodes.find(n=>n.id==='cond')!.kind='template'
    graph.nodes.find(n=>n.id==='cond')!.config={text:'fork'}
    graph.edges=graph.edges.map(e=>e.source==='cond'?edge(e.source,e.target):e)
    graph.nodes.find(n=>n.id==='merge')!.config.text='{{left.text}}/{{right.text}}'
    safe(graph)
  })
  it('recognizes parallel edges sharing one exclusive port',()=>{
    const graph=branch()
    graph.edges=graph.edges.filter(e=>e.target!=='right').concat(edge('cond','right','true'))
    graph.nodes.find(n=>n.id==='merge')!.config.text='{{left.text}}/{{right.text}}'
    safe(graph)
  })
  it('preserves optional default/defined references and aggregator candidates',()=>{
    const graph=branch(),merge=graph.nodes.find(n=>n.id==='merge')!
    merge.kind='template'
    merge.config={text:'{{left.text|default("fallback")}}{% if right.text is defined %}{{right.text}}{% endif %}'}
    safe(graph)
    merge.kind='aggregator';merge.config={groups:[{name:'picked',variables:['left.text','right.text']}]}
    graph.nodes.push(node('out','output',{text:'{{merge.picked}}'}));graph.edges.push(edge('merge','out'))
    safe(graph)
  })
  it('still rejects optional reads from a sibling with no dependency edge',()=>{
    const graph=branch(),merge=graph.nodes.find(n=>n.id==='merge')!
    graph.edges=graph.edges.filter(e=>!(e.source==='left'&&e.target==='merge'))
    merge.kind='template';merge.config={text:'{{left.text|default("fallback")}}'}
    expect(referenceScopeIssues(graph,{strictMissing:true})).toEqual([expect.objectContaining({nodeId:'merge',message:expect.stringContaining('上游依赖作用域')})])
  })
  it('does not treat optional template syntax as making fallback arguments optional',()=>{
    const graph=branch(),merge=graph.nodes.find(n=>n.id==='merge')!
    merge.kind='template';merge.config={text:'{{left.text|default(right.text)}}'}
    unsafe(graph,'merge','right.text')
  })
  it('tracks conditional variable writes and accepts coverage by both branches',()=>{
    const graph=branch(),left=graph.nodes.find(n=>n.id==='left')!,right=graph.nodes.find(n=>n.id==='right')!
    left.kind='assigner';left.config={assignments:[{name:'picked',operation:'set',value:'left'}]}
    graph.nodes.find(n=>n.id==='merge')!.config.text='{{vars.picked}}'
    unsafe(graph,'merge','vars.picked')
    right.kind='assigner';right.config={assignments:[{name:'picked',operation:'set',value:'right'}]}
    safe(graph)
  })
  it('retains must-availability through nested exclusive merges',()=>{
    const graph=branch()
    graph.nodes.push(node('inner_cond','if',{variable:'input.flag',operator:'not_empty'}),node('inner_left','template',{text:'inner'}))
    graph.edges=graph.edges.filter(e=>!(e.source==='left'&&e.target==='merge')).concat(edge('left','inner_cond'),edge('inner_cond','inner_left','true'),edge('inner_cond','merge','false'),edge('inner_left','merge'))
    unsafe(graph)
    graph.nodes.find(n=>n.id==='merge')!.config.text='{{start.flag}}'
    safe(graph)
  })
})

describe('branch availability in container scopes',()=>{
  function nested():Workflow {
    const body=branch()
    return flow([node('outer_start','input',{fields:[]}),node('container','iteration',{iterator:'[1]',body:{nodes:body.nodes,edges:body.edges},outputVariable:'merge.text'}),node('out','output',{text:'{{container.result}}'})],[edge('outer_start','container'),edge('container','out')])
  }
  it('rejects a one-sided merge read inside a body',()=>{unsafe(nested())})
  it('permits dominating outer data inside the body',()=>{
    const graph=nested()
    graph.nodes.find(n=>n.id==='container')!.config.body!.nodes.find(n=>n.id==='merge')!.config.text='{{outer_start.text}}/{{start.flag}}/{{item}}/{{index}}'
    safe(graph)
  })
  it('checks a container output selector against all body executions',()=>{
    const graph=nested(),container=graph.nodes.find(n=>n.id==='container')!
    container.config.body!.nodes.find(n=>n.id==='merge')!.config.text='safe'
    container.config.outputVariable='left.text'
    unsafe(graph,'container')
  })
  it('does not turn conditional outer results into guarantees when inherited',()=>{
    const graph=branch(),merge=graph.nodes.find(n=>n.id==='merge')!
    merge.kind='iteration';merge.config={iterator:'[1]',outputVariable:'child.text',body:{nodes:[node('child_start','input',{fields:[]}),node('child','template',{text:'{{left.text}}'})],edges:[edge('child_start','child')]}}
    unsafe(graph,'child')
    merge.config.body!.nodes.find(n=>n.id==='child')!.config.text='{{start.flag}}'
    safe(graph)
  })
  it('checks loop until variables while preserving initialized variables',()=>{
    const graph=nested(),container=graph.nodes.find(n=>n.id==='container')!,left=container.config.body!.nodes.find(n=>n.id==='left')!
    left.kind='assigner';left.config={assignments:[{name:'count',operation:'set',value:1}]}
    container.kind='loop';container.config.iterator=undefined
    container.config.outputVariable='merge.text';container.config.until={variable:'vars.count',operator:'gte',value:'1'}
    container.config.body!.nodes.find(n=>n.id==='merge')!.config.text='safe'
    unsafe(graph,'container','vars.count')
    container.config.initialVariables={count:0}
    safe(graph)
  })
})

describe('container outputs on Exit Loop routes', () => {
  const n = (id: string, kind: WorkflowNode['kind'], config: Record<string, unknown> = {}): WorkflowNode => ({ id, kind, config, title: id, number: id, x: 0, y: 0, fixed: false } as WorkflowNode)
  const flow = (exit: boolean) => {
    const value = templateContext().workflow
    const body = { nodes: [n('item_input', 'input', { fields: [] }), n('choose', 'if', { variable: 'item', operator: 'equals', value: '1' }), exit ? n('leave', 'exit_loop') : n('leave', 'template', { text: 'other' }), n('keep', 'template', { text: 'kept' })],
      edges: [{ id: 'b1', source: 'item_input', target: 'choose' }, { id: 'b2', source: 'choose', target: 'leave', port: 'true' }, { id: 'b3', source: 'choose', target: 'keep', port: 'false' }] }
    value.nodes = [n('start', 'input', { fields: [] }), n('iterate', 'iteration', { iterator: '[1,2]', body, outputVariable: 'keep.text', errorMode: 'terminate', parallel: false, concurrency: 1 }), n('result', 'output', { text: '{{iterate}}', outputName: 'result' })]
    value.edges = [{ id: 'a', source: 'start', target: 'iterate' }, { id: 'b', source: 'iterate', target: 'result' }]
    return value
  }
  it('accepts an output produced on every route that does not exit', () => {
    expect(referenceScopeIssues(flow(true), { strictMissing: true }).filter(issue => issue.message.includes('keep.text'))).toEqual([])
  })
  it('still rejects an output skipped by a route that completes normally', () => {
    expect(referenceScopeIssues(flow(false), { strictMissing: true }).map(issue => issue.message).join()).toContain('keep.text 在某些分支下不可用')
  })
})

describe('loop output versus until on Exit Loop routes', () => {
  const n = (id: string, kind: WorkflowNode['kind'], config: Record<string, unknown> = {}): WorkflowNode => ({ id, kind, config, title: id, number: id, x: 0, y: 0, fixed: false } as WorkflowNode)
  const loop = (config: Record<string, unknown>) => {
    const value = templateContext().workflow
    const body = { nodes: [n('pass_in', 'input', { fields: [] }), n('choose', 'if', { variable: 'sys.timestamp', operator: 'not_empty' }), n('leave', 'exit_loop'), n('keep', 'template', { text: 'kept' })],
      edges: [{ id: 'b1', source: 'pass_in', target: 'choose' }, { id: 'b2', source: 'choose', target: 'leave', port: 'true' }, { id: 'b3', source: 'choose', target: 'keep', port: 'false' }] }
    value.nodes = [n('start', 'input', { fields: [] }), n('repeat', 'loop', { maxIterations: 3, initialVariables: {}, body, ...config }), n('result', 'output', { text: '{{repeat.text}}', outputName: 'result' })]
    value.edges = [{ id: 'a', source: 'start', target: 'repeat' }, { id: 'b', source: 'repeat', target: 'result' }]
    return value
  }
  it('rejects a loop output that the exiting pass never produced', () => {
    expect(referenceScopeIssues(loop({ outputVariable: 'keep.text' }), { strictMissing: true }).map(issue => issue.message).join()).toContain('keep.text 在某些分支下不可用')
  })
  it('accepts until, which is not evaluated on an exiting pass', () => {
    expect(referenceScopeIssues(loop({ until: { variable: 'keep.text', operator: 'not_empty' } }), { strictMissing: true })).toEqual([])
  })
})
