import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { planningEditView } from '../src/shared/planning-edits.ts'
import { templateContext, filling } from './fixtures/planning-compiler/template.ts'

const fixture=JSON.parse(readFileSync(new URL('./fixtures/planning-compiler/desktop-topology-errors.json',import.meta.url),'utf8'))
const sample=()=>structuredClone(fixture.wire)
const compiler=()=>new TemplateFillingCompiler(templateContext(),{prefetch:['input','output','if','human']})
const feedback=(result:ReturnType<TemplateFillingCompiler['submit']>)=>{if(result.ok)throw Error('Expected repairable topology error');return result.feedback}
const promotedContainer=()=>{
  const context=templateContext(),baseline=new TemplateFillingCompiler(context).submit(filling())
  if(!baseline.ok)throw Error(JSON.stringify(baseline.feedback))
  context.workflow=baseline.value.candidate!;context.workflow.revision=1;context.operation='revise'
  const containerKey='n'+planningEditView(context).nodes.find(n=>n.kind==='template')!.ref.slice(1)
  const wire={submission:{mode:'edit',updates:{[containerKey]:{template:'loop',values:{maxIterations:1,initialVariables:{},outputVariable:'inner.text'},unset:['text']}},
    addForms:[
      {key:'innerStart',template:'input',scope:[containerKey],values:{fields:[]}},
      {key:'inner',template:'template',scope:[containerKey],values:{text:'inside'}},
      {key:'innerEnd',template:'output',scope:[containerKey],values:{text:'{{inner.text}}',outputName:'result'}},
    ],addLinks:[{key:'innerEntry',source:'innerStart',target:'inner',scope:[containerKey]},{key:'innerExit',source:'inner',target:'innerEnd',scope:[containerKey]}],coverage:{R1:[containerKey,'inner']}}}
  return {context,containerKey,wire}
}

describe('public Desktop topology failure diagnostics',()=>{
  it('collects scope-as-chain and implicit branch-edge errors in one precise packet',()=>{
    const packet=feedback(compiler().submit(sample()))
    expect(packet.issues.map(i=>[i.code,i.path])).toEqual([
      ['LINK_PORT_REQUIRED','/linksByKey/entry'],
      ['UNKNOWN_REFERENCE','/formsByKey/review/scope/0'],
      ['BRANCH_PORT','/chainsByKey/main/nodes/1'],
    ])
    expect(packet.issues[1]!.message).toContain('chain key')
    expect(packet.issues[2]!.message).toContain('choose → review')
    expect(packet.issues[2]!.message).toContain('隐式')
    expect(packet.issues[2]!.message).toContain('字符串')
    expect(packet.allowedPaths).toEqual(['/linksByKey/entry','/chainsByKey','/formsByKey/review/scope','/chainsByKey/main'])
    expect(Object.keys(packet.fragments)).toEqual(packet.allowedPaths)
    expect(JSON.stringify(packet.fragments)).not.toContain('Confirm')
    expect(packet.fragments['/linksByKey/entry']).toEqual({source:'start',target:'choose'})
  })
  it('repairs both failures once, preserves explicit string ports and all untouched fields and bindings',()=>{
    const c=compiler(),wire=sample();feedback(c.submit(wire))
    const before=c.snapshot().document as any
    const result=c.submit({submission:{mode:'repair',draftRevision:1,patches:[
      {op:'remove',path:'/formsByKey/review/scope'},
      {op:'replace',path:'/chainsByKey/main',value:{nodes:['start','choose']}},
      {op:'remove',path:'/linksByKey/entry'},
    ]}})
    if(!result.ok)throw Error(JSON.stringify(result.feedback))
    const after=c.snapshot().document as any
    const {entry:_,...branchLinks}=before.linksByKey
    expect(after.linksByKey).toEqual(branchLinks)
    expect(after.formsByKey).toEqual({...before.formsByKey,review:{...before.formsByKey.review,scope:undefined}})
    expect(after.coverage).toEqual(before.coverage)
    expect(after.title).toEqual(before.title)
    expect(c.snapshot().submissions).toBe(2)
    expect(result.value.candidate!.nodes.find(n=>n.kind==='if')!.id).toBe('allocated-0')
    expect(result.value.candidate!.edges.filter(e=>e.port).map(e=>e.port)).toEqual(['true','false','approve','reject'])
  })
  it('does not authorize changing already explicit legal links to boolean ports',()=>{
    const c=compiler();feedback(c.submit(sample()))
    const before=c.snapshot().document
    const packet=feedback(c.submit({submission:{mode:'repair',draftRevision:1,patches:[{op:'replace',path:'/linksByKey/yes/port',value:true}]}}))
    expect(packet.issues[0]!.code).toBe('PATCH_SCOPE')
    expect(c.snapshot().document).toEqual(before)
    const wire=sample();delete wire.submission.forms[2].scope;delete wire.submission.chains
    wire.submission.links[1].port=true
    const invalid=feedback(compiler().submit(wire))
    expect(invalid.issues.some(i=>i.path==='/linksByKey/yes/port'&&i.code==='INVALID_FIELDS')).toBe(true)
  })
  it('deduplicates ordinary sequence edges expressed with overlapping chains',()=>{
    const wire=filling();wire.submission.chains.push({key:'duplicate',nodes:['start','greet']})
    const result=compiler().submit(wire);if(!result.ok)throw Error(JSON.stringify(result.feedback))
    expect(result.value.candidate!.edges).toHaveLength(2)
  })
  it('also locates classifier chain edges while preserving explicit class-id routing',()=>{
    const wire=filling();wire.submission.forms[1]={key:'greet',template:'classifier',values:{prompt:'Classify',classes:[{id:'yes',label:'Yes',description:'Yes'}]}}
    wire.submission.links=[{key:'classified',source:'greet',target:'result',port:'yes'}]
    const c=new TemplateFillingCompiler(templateContext(),{prefetch:['input','output','classifier']})
    const packet=feedback(c.submit(wire))
    expect(packet.issues.map(i=>[i.code,i.path])).toEqual([['BRANCH_PORT','/chainsByKey/main/nodes/1']])
    expect(packet.allowedPaths).toEqual(['/chainsByKey/main'])
    wire.submission.forms[2].values.text='classified'
    wire.submission.chains[0].nodes=['start','greet']
    const result=new TemplateFillingCompiler(templateContext()).submit(wire)
    if(!result.ok)throw Error(JSON.stringify(result.feedback))
    expect(result.value.candidate!.edges.map(e=>e.port).filter(Boolean)).toEqual(['yes'])
  })
  it('reports each offending chain and supports moving its branch edge into links',()=>{
    const wire=sample();delete wire.submission.forms[2].scope;delete wire.submission.links
    wire.submission.chains=[{key:'entry',nodes:['start','choose','review']},{key:'other',nodes:['choose','failed']}]
    const packet=feedback(compiler().submit(wire))
    expect(packet.issues.map(i=>i.path)).toEqual(['/chainsByKey/entry/nodes/1','/chainsByKey/other/nodes/0'])
    expect(packet.allowedPaths).toContain('/linksByKey')
    expect(packet.allowedPaths).not.toContain('/formsByKey')
  })
  it('preserves legitimate container scope during a partial edit with a new nested node',()=>{
    const context=templateContext(),wire=filling()
    wire.submission.forms[1]={key:'greet',template:'loop',values:{maxIterations:1,initialVariables:{},outputVariable:'inside.text'}}
    wire.submission.forms.push(
      {key:'innerStart',template:'input',scope:['greet'],values:{fields:[]}},
      {key:'inside',template:'template',scope:['greet'],values:{text:'inside'}},
      {key:'innerEnd',template:'output',scope:['greet'],values:{text:'{{inside.text}}',outputName:'result'}},
    )
    wire.submission.chains.push({key:'nested',nodes:['innerStart','inside','innerEnd']})
    const baseline=new TemplateFillingCompiler(context).submit(wire)
    if(!baseline.ok)throw Error(JSON.stringify(baseline.feedback))
    context.workflow=baseline.value.candidate!;context.workflow.revision=1;context.operation='revise'
    const view=planningEditView(context),key=(kind:string)=>'n'+view.nodes.find(n=>n.kind===kind)!.ref.slice(1)
    const loopKey=key('loop'),insideKey=key('template'),endKey='n'+view.nodes.find(n=>n.kind==='output'&&n.scope.length)!.ref.slice(1)
    const before=structuredClone(context.workflow)
    const edited=new TemplateFillingCompiler(context).submit({submission:{mode:'edit',
      updates:{[insideKey]:{values:{text:'changed'}}},
      addForms:[{key:'extra',template:'template',scope:[loopKey],values:{text:`{{${insideKey}.text}}`}}],
      removeLinks:[{source:insideKey,target:endKey}],
      addLinks:[{key:'beforeExtra',source:insideKey,target:'extra',scope:[loopKey]},{key:'afterExtra',source:'extra',target:endKey,scope:[loopKey]}],
      coverage:{R1:['extra',insideKey]},
    }})
    if(!edited.ok)throw Error(JSON.stringify(edited.feedback))
    const after=edited.value.candidate!,oldLoop=before.nodes.find(n=>n.kind==='loop')!,newLoop=after.nodes.find(n=>n.kind==='loop')!
    expect(after.nodes.filter(n=>n.kind!=='loop')).toEqual(before.nodes.filter(n=>n.kind!=='loop'))
    expect({...newLoop.config,body:undefined}).toEqual({...oldLoop.config,body:undefined})
    expect(newLoop.config.body!.nodes).toHaveLength(4)
    expect(newLoop.config.body!.nodes.find(n=>n.kind==='template'&&n.id===oldLoop.config.body!.nodes.find(n=>n.kind==='template')!.id)!.config.text).toBe('changed')
    expect(context.workflow).toEqual(before)
  })
  it('uses the same edit effective kind when a template becomes a loop containing new forms',()=>{
    const {context,wire}=promotedContainer(),before=structuredClone(context.workflow)
    const result=new TemplateFillingCompiler(context).submit(wire)
    if(!result.ok)throw Error(JSON.stringify(result.feedback))
    const container=result.value.candidate!.nodes.find(n=>n.kind==='loop')!
    expect(container.config.body!.nodes.map(n=>n.kind)).toEqual(['input','template','output'])
    expect(container.id).toBe(before.nodes.find(n=>n.kind==='template')!.id)
    expect(context.workflow).toEqual(before)
  })
  it('rejects children scoped to a loop changed into a template in the same edit',()=>{
    const {context,wire,containerKey}=promotedContainer()
    // This is a valid saved loop baseline; the next edit removes its container kind.
    const saved=new TemplateFillingCompiler(context).submit(wire)
    if(!saved.ok)throw Error(JSON.stringify(saved.feedback))
    context.workflow=saved.value.candidate!;context.workflow.revision=2
    const packet=feedback(new TemplateFillingCompiler(context).submit({submission:{mode:'edit',
      updates:{[containerKey]:{template:'template',values:{text:'plain'},unset:['maxIterations','initialVariables','outputVariable']}},
      addForms:[{key:'extra',template:'template',scope:[containerKey],values:{text:'invalid scope'}}],coverage:{R1:[containerKey]},
    }}))
    expect(packet.issues.map(i=>[i.code,i.path])).toEqual([['INVALID_SCOPE','/addFormsByKey/extra/scope/0']])
    expect(packet.allowedPaths).toEqual(['/addFormsByKey/extra/scope'])
  })
  it('rejects non-container scope with a local path and exposes consistent schema guidance',()=>{
    const wire=filling();wire.submission.forms[1].scope=['start']
    const c=compiler(),packet=feedback(c.submit(wire))
    expect(packet.issues[0]!.path).toBe('/formsByKey/greet/scope/0')
    expect(packet.issues[0]!.message).toContain('容器')
    expect(packet.allowedPaths).toEqual(['/formsByKey/greet/scope'])
    for(const schema of [c.schema,new WorkflowAuthoringCompiler(templateContext()).schema]){
      const text=JSON.stringify(schema)
      expect(text).toContain('chain key')
      expect(text).toContain('loop/iteration')
      expect(text).toContain('字符串')
    }
  })
})
