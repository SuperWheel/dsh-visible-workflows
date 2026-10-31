import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { graphIssues } from '../src/host/validation.ts'
import { makeWorkflow, type NodeGraph, type Workflow, type WorkflowNode } from '../src/shared/types.ts'
import { assertReferenceAllowed, createReferenceScopePlan, referenceScopeIssues, visibleReferenceVariables, withReferenceVariables } from '../src/shared/reference-scope.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'

const n=(id:string,kind:WorkflowNode['kind'],config:WorkflowNode['config']={}):WorkflowNode=>({id,kind,config,number:id,title:id,x:0,y:0,fixed:false})
const e=(source:string,target:string)=>({id:`${source}_${target}`,source,target})
function flow(nodes:WorkflowNode[],edges:NodeGraph['edges']):Workflow{return {...makeWorkflow('workspace','引用作用域'),nodes,edges}}
const start=()=>n('start','input',{fields:[{name:'text',label:'文本',required:false}]})
const running:{runtime:WorkflowRuntime;directory:string}[]=[]
afterEach(async()=>{for(const {runtime,directory} of running.splice(0)){await runtime.close();rmSync(directory,{recursive:true,force:true})}})

describe('execution dependency reference scope',()=>{
  it('names the node that runs a tool when a reference is rooted at the tool name',()=>{
    const graph=flow([start(),n('fetch','tool',{toolId:'native:glob',inputs:{pattern:'*.csv'}}),n('each','iteration',{iterator:'glob.value.paths',body:{nodes:[n('child_start','input')],edges:[]},outputVariable:'child_start.text'})],[e('start','fetch'),e('fetch','each')])
    const issue=referenceScopeIssues(graph,{strictMissing:true}).find(item=>item.code==='INVALID_REFERENCE')
    expect(issue?.message).toContain('glob 是工具名，不是节点；引用调用它的节点 fetch，例如 fetch.value.paths')
    graph.nodes[2]!.config.iterator='missing.value'
    expect(referenceScopeIssues(graph,{strictMissing:true}).find(item=>item.code==='INVALID_REFERENCE')?.message).not.toContain('工具名')
  })
  it('rejects a sibling result even when that branch happens to finish first',()=>{
    const graph=flow([start(),n('sibling','template',{text:'private'}),n('consumer','output',{text:'{{sibling.text}}'})],[e('start','sibling'),e('start','consumer')])
    expect(graphIssues(graph,true).some(issue=>issue.nodeId==='consumer'&&issue.message.includes('sibling'))).toBe(true)
    expect(graphIssues(graph,false)).toEqual([])
  })
  it('rejects reading a parent container result before its body completes',()=>{
    const body={nodes:[n('child_start','input'),n('child','template',{text:'{{container.result}}'})],edges:[e('child_start','child')]}
    const graph=flow([start(),n('container','iteration',{iterator:'[]',body,outputVariable:'child.text'}),n('out','output',{text:'{{container.result}}'})],[e('start','container'),e('container','out')])
    expect(graphIssues(graph,true).some(issue=>issue.nodeId==='child'&&issue.message.includes('container'))).toBe(true)
  })
  it('permits transitive same-level ancestors and outer ancestors inherited before entering a body',()=>{
    const body={nodes:[n('child_start','input'),n('child','template',{text:'{{upstream.text}}/{{item}}/{{index}}'})],edges:[e('child_start','child')]}
    const graph=flow([start(),n('upstream','template',{text:'ok'}),n('container','iteration',{iterator:'[1]',body,outputVariable:'child.text'}),n('out','output',{text:'{{container.result}}'})],[e('start','upstream'),e('upstream','container'),e('container','out')])
    expect(referenceScopeIssues(graph)).toEqual([])
    const plan=createReferenceScopePlan(graph)
    expect([...plan.nodes.get('child')!.nodeIds].sort()).toEqual(['child_start','start','upstream'])
    expect(plan.completedBodies.get('container')!.nodeIds.has('child')).toBe(true)
    expect(plan.nodes.get('out')!.nodeIds.has('child')).toBe(false)
  })
  it('rejects child leakage and outer or inner siblings without dependency edges',()=>{
    const body={nodes:[n('child_start','input'),n('child_sibling','template',{text:'secret'}),n('child','template',{text:'{{outer_sibling.text}}/{{child_sibling.text}}'})],edges:[e('child_start','child_sibling'),e('child_start','child')]}
    const graph=flow([start(),n('outer_sibling','template',{text:'secret'}),n('container','iteration',{iterator:'[1]',body,outputVariable:'child.text'}),n('out','output',{text:'{{child.text}}'})],[e('start','outer_sibling'),e('start','container'),e('container','out')])
    const issues=referenceScopeIssues(graph)
    expect(issues.filter(issue=>issue.nodeId==='child').map(issue=>issue.message).join(' ')).toContain('outer_sibling')
    expect(issues.filter(issue=>issue.nodeId==='child').map(issue=>issue.message).join(' ')).toContain('child_sibling')
    expect(issues.some(issue=>issue.nodeId==='out'&&issue.message.includes('child.text'))).toBe(true)
  })
  it('keeps named template inputs, nested for locals, JSON filters and optional values valid',()=>{
    const text='{% for row in json | default([]) %}{% if optional is defined and row.name %}{{row.name|upper}}{% elif other %}{{"sibling.text"}}{% endif %}{% for entry in row.items %}{{entry|default("x")}}:{{loop.index}}{% endfor %}{% endfor %}{{missing|default("done")}}'
    const graph=flow([start(),n('sibling','template',{text:'secret'}),n('consumer','template',{inputs:{json:[{name:'A',items:['B']}]},text})],[e('start','sibling'),e('start','consumer')])
    expect(referenceScopeIssues(graph)).toEqual([])
  })
  it('does not let optional template syntax disguise a known forbidden node',()=>{
    const graph=flow([start(),n('sibling','template',{text:'secret'}),n('consumer','template',{text:'{{sibling.text|default("fallback")}}{% if sibling.text is defined %}x{% endif %}'})],[e('start','sibling'),e('start','consumer')])
    expect(referenceScopeIssues(graph).filter(issue=>issue.nodeId==='consumer')).toHaveLength(2)
  })
  it('checks both operands when a template condition compares a filtered value to a sibling result',()=>{
    const graph=flow([start(),n('sibling','template',{text:'secret'}),n('consumer','template',{text:'{% if input.text|default("") == sibling.text %}x{% endif %}'})],[e('start','sibling'),e('start','consumer')])
    expect(referenceScopeIssues(graph)).toHaveLength(1)
    expect(referenceScopeIssues(graph)[0]!.message).toContain('sibling.text')
  })
  it('permits a named input or loop local to shadow an unrelated node ID without reading that node',()=>{
    const graph=flow([start(),n('sibling','template',{text:'secret'}),n('consumer','template',{inputs:{sibling:'safe',items:['safe']},text:'{{sibling}}{% for sibling in items %}{{sibling}}{% endfor %}'})],[e('start','sibling'),e('start','consumer')])
    expect(referenceScopeIssues(graph)).toEqual([])
  })
  it('checks an empty for fallback against enclosing locals rather than the absent item',()=>{
    const text='{% for outer in [{}] %}{% for sibling in [] %}{{sibling.text}}{% else %}{{outer}}/{{loop.index}}/{{sibling.text|default("fallback")}}{% endfor %}{% endfor %}'
    const graph=flow([start(),n('sibling','template',{text:'secret'}),n('loop','template',{text:'secret'}),n('consumer','template',{text})],[e('start','sibling'),e('start','loop'),e('start','consumer')])
    const issues=referenceScopeIssues(graph)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.message).toContain('sibling.text')
    expect(graphIssues(graph,false)).toEqual([])
  })
  it('restores a shadowed named input in a for fallback',()=>{
    const text='{% for sibling in [] %}{{sibling.text}}{% else %}{{sibling.text}}{% endfor %}'
    const graph=flow([start(),n('sibling','template',{text:'secret'}),n('consumer','template',{inputs:{sibling:{text:'safe'}},text})],[e('start','sibling'),e('start','consumer')])
    expect(referenceScopeIssues(graph)).toEqual([])
  })
  it('never interprets code, input default text, metadata or literal iterator contents as references',()=>{
    const body={nodes:[n('child_start','input'),n('child','template',{text:'{{item}}'})],edges:[e('child_start','child')]}
    const graph=flow([n('start','input',{fields:[{name:'text',label:'{{sibling.text}}',required:false,defaultValue:'{{sibling.text}}'}]}),n('sibling','template',{text:'secret'}),n('consumer','code',{code:'function main(){return {text:"{{sibling.text}}"}}',inputs:{text:'literal'},outputSchema:[{name:'text',type:'string',description:'{{sibling.text}}'}]}),n('container','iteration',{iterator:'["{{sibling.text}}"]',body,outputVariable:'child.text'})],[e('start','sibling'),e('start','consumer'),e('consumer','container')])
    expect(referenceScopeIssues(graph)).toEqual([])
    graph.nodes[2]!.config.inputs={text:'{{sibling.text}}'}
    expect(referenceScopeIssues(graph).some(issue=>issue.nodeId==='consumer')).toBe(true)
  })
  it.each(['item','index'])('rejects %s outside its produced scope',name=>{
    const graph=flow([start(),n('consumer','template',{text:`{{${name}}}`})],[e('start','consumer')])
    expect(referenceScopeIssues(graph)).toHaveLength(1)
  })
  it('leaves fully missing nodes and variables to normal runtime failure rather than defeating iteration error modes',()=>{
    const graph=flow([start(),n('consumer','template',{text:'{{missing.text}}/{{vars.missing}}'})],[e('start','consumer')])
    expect(referenceScopeIssues(graph)).toEqual([])
  })
  it('keeps list filter item and index local to the per-item predicate',()=>{
    const graph=flow([start(),n('list','list',{listSource:'[1,2]',filter:{variable:'item',operator:'gt',value:'{{index}}'}})],[e('start','list')])
    expect(referenceScopeIssues(graph)).toEqual([])
  })
  it('allows loop initialization and completed body fields for until/output without leaking inner variables outward',()=>{
    const body={nodes:[n('child_start','input'),n('writer','assigner',{assignments:[{name:'count',operation:'add',value:1}]}),n('child','template',{text:'{{vars.count}}/{{index}}'})],edges:[e('child_start','writer'),e('writer','child')]}
    const graph=flow([start(),n('container','loop',{initialVariables:{count:0},body,until:{variable:'vars.count',operator:'gte',value:'1'},outputVariable:'child.text'}),n('out','output',{text:'{{container.variables.count}}'})],[e('start','container'),e('container','out')])
    expect(referenceScopeIssues(graph)).toEqual([])
    graph.nodes[2]!.config.text='{{vars.count}}'
    expect(referenceScopeIssues(graph).some(issue=>issue.nodeId==='out')).toBe(true)
  })
  it('allows earlier assignment statements but rejects future or unrelated variable producers',()=>{
    const assign=n('writer','assigner',{assignments:[{name:'first',operation:'set',value:1},{name:'second',operation:'set',value:'{{vars.first}}'}]})
    const graph=flow([start(),n('sibling','assigner',{assignments:[{name:'secret',operation:'set',value:1}]}),assign,n('out','output',{text:'{{vars.second}}'})],[e('start','sibling'),e('start','writer'),e('writer','out')])
    expect(referenceScopeIssues(graph)).toEqual([])
    assign.config.assignments![0]!.value='{{vars.second}}'
    expect(referenceScopeIssues(graph).some(issue=>issue.nodeId==='writer')).toBe(true)
    assign.config.assignments![0]!.value='{{vars.secret}}'
    expect(referenceScopeIssues(graph).some(issue=>issue.nodeId==='writer')).toBe(true)
  })
  it('preserves mutually exclusive aggregator candidates and unknown optional values, but rejects actual unrelated nodes',()=>{
    const graph=flow([start(),n('left','template',{text:'a'}),n('right','template',{text:'b'}),n('unrelated','template',{text:'secret'}),n('merge','aggregator',{groups:[{name:'picked',variables:['left.optional','right.optional','removed.optional']}]})],[e('start','left'),e('start','right'),e('start','unrelated'),e('left','merge'),e('right','merge')])
    expect(referenceScopeIssues(graph)).toEqual([])
    graph.nodes[4]!.config.groups![0]!.variables.push('unrelated.text')
    expect(referenceScopeIssues(graph)).toHaveLength(1)
  })
  it('checks semantic URL/header/source mappings while preserving literal paths',()=>{
    const graph=flow([start(),n('sibling','template',{text:'secret'}),n('request','http',{url:'http://localhost/{{sibling.text}}',headers:{Authorization:'{{sibling.text}}'}}),n('document','document',{source:'report.md'})],[e('start','sibling'),e('start','request'),e('request','document')])
    expect(referenceScopeIssues(graph).filter(issue=>issue.nodeId==='request')).toHaveLength(2)
    expect(referenceScopeIssues(graph).some(issue=>issue.nodeId==='document')).toBe(false)
    graph.nodes[3]!.config.source='sibling.text'
    expect(referenceScopeIssues(graph).some(issue=>issue.nodeId==='document')).toBe(true)
  })
  it('runtime guard is independent of arrival order and filters bare vars without mutating its plan',()=>{
    const graph=flow([start(),n('sibling','assigner',{assignments:[{name:'secret',operation:'set',value:1}]}),n('writer','assigner',{assignments:[{name:'visible',operation:'set',value:2}]}),n('consumer','template',{text:'x'})],[e('start','sibling'),e('start','writer'),e('writer','consumer')])
    const context=createReferenceScopePlan(graph).nodes.get('consumer')!
    expect(()=>assertReferenceAllowed('sibling.text',context,{allowMissing:true})).toThrow('作用域')
    expect(()=>assertReferenceAllowed('writer.visible',context)).not.toThrow()
    expect(()=>assertReferenceAllowed('removed.value',context,{allowMissing:true})).not.toThrow()
    expect(()=>assertReferenceAllowed('vars.secret',context)).toThrow('作用域')
    expect(visibleReferenceVariables({secret:1,visible:2},context)).toEqual({visible:2})
    const local=withReferenceVariables(context,['local'])
    expect(()=>assertReferenceAllowed('vars.local',local)).not.toThrow()
    expect(context.variables.has('local')).toBe(false)
  })
  it('reads the dependency assignment value rather than an identically named value from a completed sibling',async()=>{
    const graph=flow([start(),n('allowed','assigner',{assignments:[{name:'count',operation:'set',value:1}]}),n('unrelated','assigner',{assignments:[{name:'count',operation:'set',value:2}]}),n('consumer','output',{text:'{{vars.count}}'})],[e('start','allowed'),e('start','unrelated'),e('allowed','consumer')])
    const directory=mkdtempSync(join(tmpdir(),'reference-scope-')),storage=new WorkflowStorage(directory),runtime=new WorkflowRuntime(storage,{generate:async()=>{throw new Error('No model requests allowed')}})
    running.push({runtime,directory})
    const saved=storage.save(graph,0),done=await runtime.settle(runtime.start(saved.id,{}).id)
    expect(done.status).toBe('success')
    expect(done.executions.find(record=>record.nodeId==='unrelated')?.data?.count).toBe(2)
    expect(done.outputs.result).toBe('1')
  })
})
