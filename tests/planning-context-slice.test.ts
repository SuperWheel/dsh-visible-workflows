import { describe,expect,it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { planningContextSlice, type PlanningContextSelection } from '../src/shared/planning-context-slice.ts'
import { PlanningContextReader } from '../src/shared/planning-context-reader.ts'
import { buildPlanningToolOutputs } from '../src/shared/planning-tool-outputs.ts'
import { authoringContext } from '../src/shared/planning-authoring-context.ts'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { prefetchedTemplateIds, planningTemplateCatalog } from '../src/host/planning/template-catalog.ts'
import { templateContext, filling } from './fixtures/planning-compiler/template.ts'
import type { WorkflowNode } from '../src/shared/types.ts'
import { NODE_SEMANTICS, queryWorkflowSemantics } from '../src/shared/workflow-semantics.ts'
function fixture(){
  const c=templateContext();c.operation='revise';c.workflow.revision=4
  const node=(id:string,title=id,config:Record<string,unknown>={text:'literal'}):WorkflowNode=>({id,title,kind:'template',number:'3',x:0,y:0,fixed:false,config})
  c.workflow.nodes=[node('up'),node('target','重名',{text:'{{up.text}}'}),node('down','重名',{text:'{{target.text}}'}),node('unrelated')]
  c.workflow.edges=[{id:'a',source:'up',target:'target'},{id:'b',source:'target',target:'down'}];c.targetNodeIds=['target']
  return c
}
function select(c:ReturnType<typeof fixture>,selection:PlanningContextSelection){(c as any).contextSelection=selection;return c}
describe('shared planning dependency slice and exact reads',()=>{
  it('limits presentation edits to identity and the requested field',()=>{
    const c=select(fixture(),{targetFields:{target:['title']}}),slice=planningContextSlice(c)
    expect(slice.readNodeIds).toEqual(['target']);expect(slice.editableNodeIds).toEqual(['target'])
    const view=authoringContext(c,'改名').graph!;expect(view.nodes).toHaveLength(1);expect(view.nodes[0]!.config).toEqual({})
  })
  it('includes transitive upstream contracts and affected downstream only when required',()=>{
    const c=select(fixture(),{targetFields:{target:['text']}})
    expect(planningContextSlice(c).readNodeIds).toEqual(['up','target'])
    expect(planningContextSlice(c,{targetFields:{target:['text']},outputChanged:true}).readNodeIds).toEqual(['up','target','down'])
    expect(planningContextSlice(c,{targetFields:{target:['text']},outputChanged:true}).editableNodeIds).toEqual(['target'])
  })
  it('includes each necessary Host tool output guarantee once without promoting observed samples',()=>{
    const c=fixture();c.workflow.nodes[0]!.kind='tool';c.workflow.nodes[0]!.config={toolId:'native:read',inputs:{}}
    c.tools=[{id:'native:read',name:'read',description:'read',available:true,providerId:'p',providerName:'p',category:'plugin',inputSchema:{type:'object'}}]
    c.toolOutputs=buildPlanningToolOutputs(c.tools)
    const result=authoringContext(c,'修改文本').toolOutputContracts!
    expect(result).toHaveLength(1);expect(result[0]!.toolId).toBe('native:read');expect(result[0]!.guarantee.fields).toHaveProperty('value')
    expect(result[0]).not.toHaveProperty('observations')
  })
  it('keeps container ancestors, loop descendants and cross-scope data contracts',()=>{
    const c=fixture(),inner=c.workflow.nodes[1]!,container={...c.workflow.nodes[3]!,id:'loop',kind:'loop' as const,config:{body:{nodes:[inner],edges:[]}}}
    c.workflow.nodes=[c.workflow.nodes[0]!,container,c.workflow.nodes[2]!];c.workflow.edges=[]
    const slice=planningContextSlice(c,{targetFields:{target:['text']}})
    expect(slice.readNodeIds).toEqual(['up','loop','target']);expect(slice.reasons.loop).toContain('container-contract')
    expect(planningContextSlice(c,{targetNodeIds:['loop']}).readNodeIds).toContain('target')
  })
  it('conservatively expands unresolved dynamic dependencies and rejects missing targets',()=>{
    const c=fixture();c.workflow.nodes[1]!.config.text='{{ inputs[selector] }}'
    expect(planningContextSlice(c).readNodeIds).toHaveLength(4);expect(planningContextSlice(c).conservative).toBe(true)
    expect(()=>planningContextSlice(c,{targetNodeIds:['deleted']})).toThrow('已删除')
  })
  it('returns ambiguous exact-title candidates without choosing and never treats display number as identity',()=>{
    const reader=new PlanningContextReader(fixture(),{scopeIdentity:'workspace:flow'})
    const result=reader.search({query:'重名'},4)
    expect(result.ambiguous).toBe(true);expect(result.candidates.map(n=>n.nodeId)).toEqual(['target','down'])
    expect(reader.search({nodeId:'target'}).candidates[0]!.reasons).toEqual(['exact-id'])
    expect(reader.search({nodeId:'3'}).candidates).toEqual([])
  })
  it('shares dependency traversal for batched aliases and checks revision and scope identity',()=>{
    const reader=new PlanningContextReader(fixture(),{scopeIdentity:'workspace:flow'})
    const result=reader.read({keys:['n2'],expectedRevision:4,selection:{targetFields:{target:['text']}}})
    expect(result.readNodeIds).toEqual(['up','target']);expect(result.nodes.map(n=>n.key)).toEqual(['n1','n2'])
    expect(()=>reader.read({keys:['n2'],expectedRevision:3})).toThrow('版本')
    expect(()=>reader.read({nodeIds:['target'],expectedIdentity:{...reader.identity,scopeIdentity:'other'}})).toThrow('范围')
    expect(()=>reader.read({nodeIds:['deleted']})).toThrow('已删除')
  })
  it('bounds task cache, returns copies, and rechecks access even on hits',()=>{
    let allowed=true,checks=0
    const reader=new PlanningContextReader(fixture(),{scopeIdentity:'workspace:flow',maxEntries:2,assertCurrent:()=>{checks++;if(!allowed)throw new Error('access expired')}})
    const first=reader.read({keys:['n2']});first.nodes[0]!.title='tampered'
    expect(reader.read({keys:['n2']}).nodes[0]!.title).toBe('up');expect(reader.stats().hits).toBe(1)
    reader.search({nodeId:'up'});reader.search({nodeId:'down'});expect(reader.stats().entries).toBe(2)
    allowed=false;expect(()=>reader.search({nodeId:'down'})).toThrow('access expired');expect(checks).toBe(5)
  })
  it('invalidates cached aliases on content, movement, deletion, permissions and tool contract changes',()=>{
    const c=fixture(),reader=new PlanningContextReader(c,{scopeIdentity:'workspace:flow'}),identity={...reader.identity}
    reader.read({keys:['n2']});c.workflow.nodes.splice(1,1);c.workflow.edges=[];c.workflow.nodes[1]!.config.text='no old reference';c.targetNodeIds=[];reader.rebind(c)
    expect(reader.stats().entries).toBe(0);expect(reader.identity.digest).not.toBe(identity.digest)
    expect(()=>reader.read({keys:['n2'],expectedIdentity:identity})).toThrow('变化')
    const current={...reader.identity};reader.rebind(c,{scopeIdentity:'restricted:flow'});expect(reader.identity.scopeIdentity).toBe('restricted:flow')
    expect(()=>reader.read({keys:['n2'],expectedIdentity:current})).toThrow('范围')
    const before=reader.identity.digest;c.tools.push({id:'t',name:'t',description:'v2',available:true,providerId:'p',providerName:'p',category:'plugin',inputSchema:{type:'object'}});reader.rebind(c);expect(reader.identity.digest).not.toBe(before)
  })
  it('preserves stable identity across container movement and invalidates revision and contract changes',()=>{
    const c=fixture(),reader=new PlanningContextReader(c,{scopeIdentity:'workspace:flow',contractVersion:'v1'}),old=reader.identity
    const target=c.workflow.nodes.splice(1,1)[0]!,container=c.workflow.nodes[2]!
    container.kind='loop';container.config={body:{nodes:[target],edges:[]}};c.workflow.edges=[];c.workflow.revision=5
    reader.rebind(c)
    expect(reader.search({nodeId:'target',containerId:'unrelated'},5).candidates).toEqual([expect.objectContaining({nodeId:'target',scope:['unrelated']})])
    expect(()=>reader.read({nodeIds:['target'],expectedRevision:4})).toThrow('版本')
    expect(()=>reader.read({nodeIds:['target'],expectedIdentity:old})).toThrow('变化')
    const digest=reader.identity.digest;reader.rebind(c,{scopeIdentity:'workspace:flow',contractVersion:'v2'})
    expect(reader.identity.digest).not.toBe(digest);expect(reader.stats().entries).toBe(0)
  })
  it('does not cache oversize results or retain cache across independent readers',()=>{
    const c=fixture(),a=new PlanningContextReader(c,{scopeIdentity:'a',maxBytes:1}),b=new PlanningContextReader(c,{scopeIdentity:'a'})
    a.read({keys:['n2']});a.read({keys:['n2']});expect(a.stats()).toMatchObject({entries:0,hits:0,misses:2});expect(b.stats().entries).toBe(0)
  })
  it('keeps explicit field schema narrow after acquiring additional read-only template metadata',()=>{
    const c=select(fixture(),{targetFields:{target:['text']}}),compiler=new TemplateFillingCompiler(c,{prefetch:['input','output','template','llm','http','code']})
    const initial=(compiler.nextSchema.properties!.submission as any).oneOf[0].properties.updates.properties.n2
    expect(initial.oneOf).toBeUndefined();expect(initial.properties.template).toBeUndefined()
    const before=structuredClone(compiler.nextSchema)
    expect(compiler.queryTemplates(['code']).entries[0]!.id).toBe('code')
    const schema=compiler.nextSchema,edit=(schema.properties!.submission as any).oneOf[0],update=edit.properties.updates.properties.n2
    expect(schema).toEqual(before);expect(update.oneOf).toBeUndefined();expect(update.properties.template).toBeUndefined()
    expect(update.properties.values.properties).toEqual({text:expect.any(Object)})
    expect(validateJsonSchemaValue(schema,{submission:{mode:'edit',updates:{n2:{values:{text:'Allowed text edit'}}},coverage:{R1:['n2']}}})).toEqual([])
    expect(validateJsonSchemaValue(schema,{submission:{mode:'edit',updates:{n2:{template:'code',values:{code:'return 1'},unset:['text']}},coverage:{R1:['n2']}}}).length).toBeGreaterThan(0)
    expect(validateJsonSchemaValue(schema,{submission:{mode:'edit',updates:{n2:{values:{url:'not text'}}},coverage:{R1:['n2']}}}).length).toBeGreaterThan(0)
  })
  it('routes a unique template chain repair through the same revision and submission budget',()=>{
    const wire=filling();wire.submission.forms[1]={key:'greet',template:'classifier',values:{prompt:'Classify',classes:[{id:'yes',label:'Yes',description:'Yes'}]}}
    wire.submission.forms[2].values.text='classified';wire.submission.links=[{key:'classified',source:'greet',target:'result',port:'yes'}]
    const compiler=new TemplateFillingCompiler(templateContext(),{prefetch:['input','output','classifier']})
    expect(compiler.submit(wire).ok).toBe(false)
    const before=compiler.snapshot().document as any,result=compiler.repairUnique()
    expect(result?.ok).toBe(true);expect(compiler.snapshot().submissions).toBe(2)
    expect((compiler.snapshot().document as any).linksByKey).toEqual(before.linksByKey)
    expect((compiler.snapshot().document as any).chainsByKey.main.nodes).toEqual(['start','greet'])
  })
  it('prefetches explicit necessary templates and avoids unrelated graph kinds when a target exists',()=>{
    const c=select(fixture(),{templateIds:['code']});c.workflow.nodes[3]!.kind='http';c.workflow.nodes[3]!.config={url:'https://example.com'}
    const ids=prefetchedTemplateIds(planningTemplateCatalog(c),c,'改目标文本')
    expect(ids).toContain('code');expect(ids).not.toContain('http')
  })
})

describe('nested planning contract boundaries',()=>{
  it('does not advertise descendants of a fixed container as editable',()=>{
    const c=fixture(),child=c.workflow.nodes[1]!
    c.workflow.nodes=[{...c.workflow.nodes[3]!,id:'locked',kind:'loop',fixed:true,config:{body:{nodes:[child],edges:[]}}},c.workflow.nodes[0]!];c.workflow.edges=[]
    const slice=planningContextSlice(c,{targetNodeIds:['target'],targetFields:{target:['text']}})
    expect(slice.readNodeIds).toContain('target');expect(slice.editableNodeIds).toEqual([])
    const projected=authoringContext(select(c,{targetFields:{target:['text']}}),'改字段').graph!.nodes.find(node=>node.title==='重名')!
    expect(projected.editable).toBe(false)
  })
  it('propagates exported nested loop state changes to outer consumers',()=>{
    const c=fixture(),base=c.workflow.nodes[0]!,node=(id:string,kind:typeof base.kind,config:typeof base.config)=>({...base,id,kind,title:id,config})
    const body={nodes:[node('inner-start','input',{fields:[]}),node('update','assigner',{assignments:[{name:'count',operation:'set',value:1}]}),node('inner-out','output',{text:'processed',outputName:'result'})],edges:[{id:'i1',source:'inner-start',target:'update'},{id:'i2',source:'update',target:'inner-out'}]}
    c.workflow.nodes=[node('outer','loop',{maxIterations:1,initialVariables:{count:0},body}),node('consumer','template',{text:'{{outer.result.count}}'})];c.workflow.edges=[{id:'outer-edge',source:'outer',target:'consumer'}];c.targetNodeIds=['update']
    for(const selection of [{targetFields:{update:['assignments']}},{targetFields:{update:['assignments']},outputChanged:true}]){
      const slice=planningContextSlice(c,selection)
      expect(slice.readNodeIds).toContain('consumer');expect(slice.reasons.outer).toContain('container-output-contract');expect(slice.editableNodeIds).toEqual(['update'])
    }
  })
  it('retains legal downstream ports when branch contract fields change',()=>{
    const c=fixture();c.workflow.nodes[1]!.kind='classifier';c.workflow.nodes[1]!.config={prompt:'route',classes:[{id:'old',label:'Old',description:'old'}]}
    const slice=planningContextSlice(c,{targetFields:{target:['classes']}})
    expect(slice.readNodeIds).toContain('down');expect(slice.editableNodeIds).toEqual(['target'])
  })
  it('treats a mixed valid and unterminated interpolation as a conservative dependency',()=>{
    const c=fixture();c.workflow.nodes[1]!.config.text='{{up.text}} broken {{'
    expect(planningContextSlice(c,{targetFields:{target:['text']}})).toMatchObject({readNodeIds:['up','target','down','unrelated'],conservative:true})
  })
})

describe('field-scoped node reads',()=>{
  it('attaches one source-derived text contract per target kind and only local binding names',()=>{
    const c=fixture();c.workflow.nodes[1]!.config.inputs={name:'private business value'}
    const result=new PlanningContextReader(c,{scopeIdentity:'workspace:flow'}).read({nodeIds:['target','down'],selection:{targetFields:{target:['text'],down:['text']}}})
    expect(result.semanticContracts).toHaveLength(1)
    const contract=result.semanticContracts![0]!
    expect(contract).toMatchObject({kind:'template',editField:'text',fields:{text:NODE_SEMANTICS.template.fields.text,inputs:NODE_SEMANTICS.template.fields.inputs},outputs:NODE_SEMANTICS.template.outputs,rules:NODE_SEMANTICS.template.rules})
    expect(contract.syntax).toEqual({statements:NODE_SEMANTICS.template.syntax!.statements,filters:NODE_SEMANTICS.template.syntax!.filters,rules:NODE_SEMANTICS.template.syntax!.rules})
    expect(contract.references.rules).toEqual((queryWorkflowSemantics({topics:['references']}).topics.references as any).rules)
    expect(contract).not.toHaveProperty('schema');expect(contract).not.toHaveProperty('example');expect(contract.syntax).not.toHaveProperty('examples')
    expect(result.textBindings).toEqual([{nodeId:'target',key:'n2',kind:'template',localInputKeys:['name']},{nodeId:'down',key:'n3',kind:'template',localInputKeys:[]}])
    expect(result.nodes.find(node=>node.key==='n2')!.config).toEqual({text:'{{n1.text}}'})
    expect(JSON.stringify(result.textBindings)).not.toContain('private business value')
    expect(result.editableNodeIds).toEqual(['target'])
  })
  it('does not add text contracts for non-text fields, unselected dependencies or other node kinds',()=>{
    const c=fixture(),reader=new PlanningContextReader(c,{scopeIdentity:'workspace:flow'})
    const title=reader.read({nodeIds:['target'],selection:{targetFields:{target:['title']}}})
    expect(title).not.toHaveProperty('semanticContracts');expect(title).not.toHaveProperty('textBindings')
    expect(title.nodes[0]!.config).toEqual({})
    expect(reader.read({nodeIds:['target']})).not.toHaveProperty('semanticContracts')
    c.workflow.nodes[1]!.kind='code';c.workflow.nodes[1]!.config={code:'return {}'}
    const code=new PlanningContextReader(c,{scopeIdentity:'workspace:flow'}).read({nodeIds:['target'],selection:{targetFields:{target:['code']}}})
    expect(code).not.toHaveProperty('semanticContracts');expect(code.editableNodeIds).toEqual(['target'])
    expect(reader.search({nodeId:'target'})).not.toHaveProperty('semanticContracts')
  })
  it('crops target configuration fields and keeps different field selections separate in cache',()=>{
    const c=fixture();c.workflow.nodes[1]!.config.prompt='unrequested business prompt'
    const reader=new PlanningContextReader(c,{scopeIdentity:'workspace:flow',cacheScope:'session-workflow'})
    const text=reader.read({nodeIds:['target'],selection:{targetFields:{target:['text']}}})
    expect(text.nodes.find(node=>node.key==='n2')!.config).toEqual({text:'{{n1.text}}'})
    const title=reader.read({nodeIds:['target'],selection:{targetFields:{target:['title']}}})
    expect(title.nodes.find(node=>node.key==='n2')!.config).toEqual({});expect(title.readNodeIds).toEqual(['target'])
    const full=reader.read({nodeIds:['target']})
    expect(full.nodes.find(node=>node.key==='n2')!.config).toHaveProperty('prompt','unrequested business prompt');expect(reader.stats().scope).toBe('session-workflow')
    expect(reader.read({nodeIds:['target'],selection:{targetFields:{target:['text']}}}).nodes).toEqual(text.nodes)
  })
})
