import { describe,expect,it } from 'vitest'
import { assertSupportedJsonSchema,validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { allNodes } from '../src/shared/workflow-validation.ts'
import { cases,contextFor,oracle } from '../scripts/benchmarks/workflow-compiler.ts'

const container=():any=>({mode:'create',title:'容器链',nodes:[
  {key:'start',kind:'input',config:{fields:[{name:'items',label:'items',type:'json',required:true}]}},
  {key:'iter',kind:'iteration',config:{iterator:'start.items',outputVariable:'fmt.text',parallel:false,errorMode:'terminate'}},
  {key:'fmt',kind:'template',config:{text:'项：{{item}}'}},
  {key:'json_text',kind:'template',config:{text:'{{arr | tojson}}',inputs:{arr:'{{iter.result}}'}}},
  {key:'result',kind:'output',config:{text:'{{json_text.text}}',outputName:'result'}},
],chains:[{key:'main',nodes:['start','iter','json_text','result']},{key:'body',container:'iter',nodes:['fmt']}],coverage:{R1:['iter','fmt','result']}})
const wire=(doc:any,template:boolean)=>({submission:template?Object.fromEntries(Object.entries(doc).map(([key,value])=>key==='nodes'?['forms',(value as any[]).map(({kind,config,...node})=>({...node,template:kind,values:config}))]:[key,value])):doc})
const setup=(template:boolean,caseId='container')=>{
  const item=cases.find(c=>c.id===caseId)!,context=contextFor(item),compiler=template?new TemplateFillingCompiler(context,{resumeScope:'create-chain-test'}):new WorkflowAuthoringCompiler(context,{resumeScope:'create-chain-test'})
  if(compiler instanceof TemplateFillingCompiler)compiler.queryTemplates(['input','output','template','iteration','loop','if'])
  return {item,compiler}
}
const rejected=(result:ReturnType<WorkflowAuthoringCompiler['submit']>)=>{if(result.ok)throw Error('Expected repair');return result.feedback}
const accepted=(result:ReturnType<WorkflowAuthoringCompiler['submit']>)=>{if(!result.ok)throw Error(JSON.stringify(result.feedback));return result.value.candidate!}

for(const template of [false,true])describe(`${template?'template-fill':'compact-repair'} CREATE chains`,()=>{
  const compile=async(doc:any,caseId='container')=>{
    const {compiler,item}=setup(template,caseId),input=wire(doc,template)
    expect(()=>assertSupportedJsonSchema(compiler.nextSchema)).not.toThrow()
    expect(validateJsonSchemaValue(compiler.nextSchema,input)).toEqual([])
    const flow=accepted(compiler.submit(input)),checked=await oracle(flow,item)
    expect(checked.passed,JSON.stringify(checked)).toBe(true)
    expect(checked.results.length).toBeGreaterThan(0);expect(checked.probeResults.length).toBeGreaterThan(0)
    return {flow,compiler}
  }
  it('infers the singleton interior and generates an uncovered empty entry; legacy entry remains equivalent',async()=>{
    const doc=container(),{flow,compiler}=await compile(doc),body=flow.nodes.find(n=>n.kind==='iteration')!.config.body!
    expect(body.nodes.map(n=>n.kind).sort()).toEqual(['input','template'])
    const entry=body.nodes.find(n=>n.kind==='input')!,fmt=body.nodes.find(n=>n.kind==='template')!
    expect(entry.config).toEqual({fields:[]});expect(body.edges.map(e=>[e.source,e.target])).toEqual([[entry.id,fmt.id]])
    expect((compiler.snapshot().document as any)[template?'formsByKey':'nodesByKey']).not.toHaveProperty('hostEntry1')
    doc.nodes.push({key:'legacyEntry',kind:'input',scope:['iter'],config:{fields:[]}})
    doc.nodes.find((n:any)=>n.key==='fmt').scope=['iter'];doc.chains[1]={key:'body',nodes:['legacyEntry','fmt']}
    const legacy=accepted(setup(template).compiler.submit(wire(doc,template))),legacyBody=legacy.nodes.find(n=>n.kind==='iteration')!.config.body!
    expect(legacyBody.nodes.map(n=>n.kind).sort()).toEqual(body.nodes.map(n=>n.kind).sort())
    expect(legacyBody.edges).toHaveLength(1)
    expect(allNodes(legacy).filter(n=>n.kind==='input')).toHaveLength(2)
  })
  it('resolves nested containers independently of chain order',async()=>{
    const doc=container();doc.nodes.find((n:any)=>n.key==='iter').config.outputVariable='innerLoop.result'
    doc.nodes.push({key:'innerLoop',kind:'loop',config:{maxIterations:1,initialVariables:{},outputVariable:'fmt.text'}})
    doc.chains=[{key:'deep',container:'innerLoop',nodes:['fmt']},{key:'body',container:'iter',nodes:['innerLoop']},doc.chains[0]]
    const {flow}=await compile(doc),outer=flow.nodes.find(n=>n.kind==='iteration')!.config.body!,inner=outer.nodes.find(n=>n.kind==='loop')!.config.body!
    expect(outer.nodes.filter(n=>n.kind==='input')).toHaveLength(1);expect(inner.nodes.filter(n=>n.kind==='input')).toHaveLength(1)
    expect(inner.nodes.some(n=>n.kind==='template')).toBe(true)
  })
  it('propagates interior scope through branch links to a fixed point',async()=>{
    const doc=container();doc.nodes.push({key:'choose',kind:'if',config:{logicGate:{operator:'IF',inputs:[{value:true}]}}},{key:'again',kind:'if',config:{logicGate:{operator:'IF',inputs:[{value:true}]}}})
    doc.chains[1]={key:'body',container:'iter',nodes:['choose']}
    doc.links=[{key:'lastTrue',source:'again',target:'fmt',port:'true'},{key:'lastFalse',source:'again',target:'fmt',port:'false'},{key:'yes',source:'choose',target:'again',port:'true'},{key:'no',source:'choose',target:'again',port:'false'}]
    const {flow}=await compile(doc),body=flow.nodes.find(n=>n.kind==='iteration')!.config.body!
    expect(body.nodes.map(n=>n.kind).sort()).toEqual(['if','if','input','template'])
    expect(body.edges.filter(e=>e.source===body.nodes.find(n=>n.kind==='input')!.id)).toHaveLength(1)
  })
  it('expresses fan-out and merge using multiple chains and deduplicates overlapping sequence edges',async()=>{
    const doc:any={mode:'create',title:'并行汇合',nodes:[{key:'start',kind:'input',config:{fields:[{name:'name',label:'name',required:true}]}},{key:'left',kind:'template',config:{text:'你好，'}},{key:'right',kind:'template',config:{text:'{{input.name}}！'}},{key:'merged',kind:'template',config:{text:'{{left.text}}{{right.text}}'}},{key:'result',kind:'output',config:{text:'{{merged.text}}',outputName:'result'}}],chains:[{key:'left',nodes:['start','left','merged','result']},{key:'right',nodes:['start','right','merged','result']}],coverage:{R1:['left','right','merged','result']}}
    const {flow}=await compile(doc,'greeting');expect(flow.edges).toHaveLength(5)
  })
  it('locates missing ports, ordinary port sources, scope contradictions, conflicting chains, empty interiors and cross-scope links',()=>{
    const root=template?'formsByKey':'nodesByKey',check=(doc:any,code:string,path:string)=>{
      const {compiler}=setup(template),packet=rejected(compiler.submit(wire(doc,template)))
      expect(packet.issues.some(i=>i.code===code&&i.path===path),JSON.stringify(packet.issues)).toBe(true)
      expect(()=>assertSupportedJsonSchema(compiler.nextSchema)).not.toThrow()
      return {compiler,packet}
    }
    let doc=container();doc.links=[{key:'bad',source:'start',target:'fmt'}];check(doc,'LINK_PORT_REQUIRED','/linksByKey/bad');check(doc,'EDGE_SCOPE','/linksByKey/bad')
    doc=container();doc.links=[{key:'bad',source:'start',target:'iter',port:'default'}];check(doc,'LINK_SOURCE_PORT','/linksByKey/bad')
    doc=container();doc.nodes.find((n:any)=>n.key==='fmt').scope=[]
    // Template metadata conflicts now name the owning chain in the same issue.
    const scopeCode=template?'TEMPLATE_FIELDS':'NODE_SCOPE_MISMATCH',mismatch=check(doc,scopeCode,`/${root}/fmt/scope`)
    expect(mismatch.packet.issues.find(i=>i.code===scopeCode)!.message).toContain(template?'chains[].container':'推导 scope=["iter"]')
    if(template)expect(mismatch.packet.allowedPaths).toContain('/chainsByKey/body')
    doc=container();doc.chains.push({key:'wrong',nodes:['start','fmt']});check(doc,'CHAIN_SCOPE_CONFLICT','/chainsByKey/body')
    doc=container();doc.nodes=doc.nodes.filter((n:any)=>n.key!=='fmt');doc.chains.pop();doc.coverage.R1=['iter','result']
    const empty=check(doc,'CONTAINER_ENTRY',`/${root}/iter/${template?'values':'config'}`)
    const repair={submission:{mode:'repair',draftRevision:1,patches:[{op:'add',path:`/${root}/repairNode1`,value:{[template?'template':'kind']:'template',[template?'values':'config']:{text:'项：{{item}}'}}},{op:'replace',path:`/${root}/iter/${template?'values':'config'}`,value:{...doc.nodes.find((n:any)=>n.key==='iter').config,outputVariable:'repairNode1.text'}},{op:'add',path:'/chainsByKey/repair1',value:{container:'iter',nodes:['repairNode1']}}]}}
    expect(validateJsonSchemaValue(empty.compiler.nextSchema,repair)).toEqual([])
    expect(empty.compiler.submit(repair).ok).toBe(true)
    doc=container();doc.links=[{key:'badScope',source:'choose',target:'fmt',port:'true',scope:[]}];doc.nodes.push({key:'choose',kind:'if',config:{variable:'item',operator:'not_empty'}});doc.chains[1].nodes=['choose','fmt']
    check(doc,'EDGE_SCOPE','/linksByKey/badScope')
  })
  it('keeps singleton container membership when an explicit branch route needs chain repair',()=>{
    const doc=container();doc.nodes.push({key:'choose',kind:'if',config:{logicGate:{operator:'IF',inputs:[{value:true}]}}})
    doc.chains[1].nodes=['choose','fmt'];doc.links=[{key:'yes',source:'choose',target:'fmt',port:'true'},{key:'no',source:'choose',target:'fmt',port:'false'}]
    const {compiler}=setup(template),packet=rejected(compiler.submit(wire(doc,template))),before=compiler.snapshot()
    expect(packet.issues.map(i=>[i.code,i.path])).toEqual([['BRANCH_PORT','/chainsByKey/body/nodes/0']])
    expect(compiler.repairUnique()).toBeUndefined();expect(compiler.snapshot()).toEqual(before)
  })
  it('allocates collision-free hostEntry keys and connects all interior roots',()=>{
    const doc=container();doc.nodes.push({key:'hostEntry1',kind:'template',config:{text:'extra'}});doc.chains.push({key:'extra',container:'iter',nodes:['hostEntry1']})
    const {compiler}=setup(template),flow=accepted(compiler.submit(wire(doc,template))),body=flow.nodes.find(n=>n.kind==='iteration')!.config.body!
    expect(body.nodes.filter(n=>n.kind==='input')).toHaveLength(1)
    expect(body.edges.filter(e=>e.source===body.nodes.find(n=>n.kind==='input')!.id)).toHaveLength(2)
    expect(allNodes(flow)).toHaveLength(doc.nodes.length+1)
    expect(compiler.checkpoint()!.reservations?.nodes).toHaveProperty('+hostEntry2')
  })
})
