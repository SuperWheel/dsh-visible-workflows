import { describe,it,expect } from 'vitest'
import { z } from 'zod'
import { assertSupportedJsonSchema,validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { CompilerError,RepairSession,submissionSchema } from '../src/shared/planning-repair.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'

const branchWire=()=>({submission:{mode:'create',title:'Explicit routes',nodes:[
  {key:'start',kind:'input',config:{fields:[{name:'route',label:'Route',required:true}]}},
  {key:'choose',kind:'if',config:{variable:'input.route',operator:'equals',value:'yes'}},
  {key:'good',kind:'template',config:{text:'yes'}},
  {key:'failed',kind:'template',config:{text:'no'}},
  {key:'result',kind:'output',config:{text:'done',outputName:'result'}},
],chains:[{key:'entry',nodes:['start','choose','good']},{key:'goodEnd',nodes:['good','result']},{key:'failedEnd',nodes:['failed','result']}],links:[
  {key:'yes',source:'choose',target:'good',port:'true'},
  {key:'no',source:'choose',target:'failed',port:'false'},
],coverage:{R1:['choose','result']}}})
const requireFailure=(result:any)=>{if(result.ok)throw Error('Expected failed submission');return result.feedback}
describe('bounded local repair contracts',()=>{
  it('describes exact expected/actual type and narrows next wire schema to current revision and local typed slot',()=>{
    const compiler=new WorkflowAuthoringCompiler(templateContext()),wire:any=branchWire()
    wire.submission.nodes[2].config.text=123
    const feedback=requireFailure(compiler.submit(wire))
    expect(feedback.allowedPaths).toEqual(['/nodesByKey/good/config/text'])
    expect(feedback.issues[0]).toMatchObject({path:'/nodesByKey/good/config/text',actualType:'number',expected:{type:'string'}})
    const schema:any=compiler.nextSchema,repair=schema.properties.submission.oneOf.find((branch:any)=>branch.properties.mode.const==='repair')
    expect(()=>assertSupportedJsonSchema(schema)).not.toThrow()
    expect(repair.properties.draftRevision.const).toBe(1)
    const replacements=repair.properties.patches.items.oneOf.filter((branch:any)=>branch.properties.op.const==='replace'&&branch.properties.path.const)
    expect(replacements).toHaveLength(1)
    expect(replacements[0].properties.path.const).toBe('/nodesByKey/good/config/text')
    expect(replacements[0].properties.value.type).toBe('string')
    expect(validateJsonSchemaValue(schema,{submission:{mode:'repair',draftRevision:1,patches:[{op:'replace',path:'/nodesByKey/good/config/text',value:'correct'}]}})).toEqual([])
    expect(replacements[0].properties.value).toEqual({type:'string'})
    requireFailure(compiler.submit({submission:{mode:'repair',draftRevision:1,patches:[{op:'replace',path:'/nodesByKey/failed/config/text',value:'outside'}]}}))
    expect((compiler.snapshot().document as any).nodesByKey.failed.config.text).toBe('no')
  })
  it('reuses a declared explicit route without guessing branch intent, preserves normal edges and untouched data',()=>{
    const compiler=new WorkflowAuthoringCompiler(templateContext()),wire=branchWire()
    const packet=requireFailure(compiler.submit(wire)),before:any=compiler.snapshot().document
    expect(packet.issues.map((issue:any)=>issue.code)).toEqual(['BRANCH_PORT'])
    const result=compiler.repairUnique()
    expect(result?.ok).toBe(true)
    const after:any=compiler.snapshot().document
    expect(after.linksByKey).toEqual(before.linksByKey)
    expect(after.nodesByKey).toEqual(before.nodesByKey)
    expect(after.chainsByKey).toEqual({...before.chainsByKey,entry:{nodes:['start','choose']}})
    expect(compiler.snapshot().submissions).toBe(2)
    if(result?.ok)expect(result.value.candidate!.edges).toHaveLength(5)
  })
  it('leaves unresolved routing and unprovable multi-segment splitting to a bounded model repair',()=>{
    const compiler=new WorkflowAuthoringCompiler(templateContext()),wire=branchWire()
    wire.submission.links=wire.submission.links.filter(edge=>edge.key!=='yes')
    const packet=requireFailure(compiler.submit(wire)),before=compiler.snapshot()
    expect(packet.allowedPaths).toContain('/linksByKey')
    expect(compiler.repairUnique()).toBeUndefined();expect(compiler.snapshot()).toEqual(before)
    const contracts=JSON.stringify(compiler.nextSchema)
    expect(()=>assertSupportedJsonSchema(compiler.nextSchema)).not.toThrow()
    expect(contracts).toContain('"enum":["true","false"]')
    expect(contracts).toContain('"additionalProperties":true')
    const split=new WorkflowAuthoringCompiler(templateContext()),multiple=branchWire()
    multiple.submission.chains[0]!.nodes.push('result')
    requireFailure(split.submit(multiple));expect(split.repairUnique()).toBeUndefined()
  })
  it('accepts fresh link-map keys beyond the old draft and finite repair examples',()=>{
    for(let index=0;index<6;index++){
      const compiler=new WorkflowAuthoringCompiler(templateContext()),wire=branchWire()
      wire.submission.links=wire.submission.links.filter(edge=>edge.key!=='yes')
      const feedback=requireFailure(compiler.submit(wire))
      expect(feedback.allowedPaths).toContain('/linksByKey')
      const links=(compiler.snapshot().document as any).linksByKey
      const repair={submission:{mode:'repair',draftRevision:1,patches:[
        {op:'replace',path:'/chainsByKey/entry',value:{nodes:['start','choose']}},
        {op:'replace',path:'/linksByKey',value:{...links,['fresh'+index]:{source:'choose',target:'good',port:'true'}}},
      ]}}
      expect(validateJsonSchemaValue(compiler.nextSchema,repair)).toEqual([])
      expect(compiler.submit(repair).ok).toBe(true)
    }
  })
  it('keeps automatic repairs inside the existing submission budget and validates again after repair',()=>{
    const limited=new WorkflowAuthoringCompiler(templateContext(),{maxSubmissions:1})
    requireFailure(limited.submit(branchWire()))
    expect(()=>limited.repairUnique()).toThrow('上限')
    const compiler=new WorkflowAuthoringCompiler(templateContext(),{validate:()=>[{code:'BUSINESS_RULE',message:'business constraint still fails'}]})
    requireFailure(compiler.submit(branchWire()))
    const second=compiler.repairUnique()
    expect(second?.ok).toBe(false)
    if(second&&!second.ok)expect(second.feedback.issues[0]!.code).toBe('BUSINESS_RULE')
  })
  it('does not turn a unique structural enum into an automatic semantic choice',()=>{
    const schema=z.object({route:z.enum(['approve'])})
    const compiler=new RepairSession(submissionSchema({type:'object'}),{maxSubmissions:3,roots:()=>['/route'],compile:document=>schema.parse(document)})
    const packet=requireFailure(compiler.submit({submission:{route:'reject'}}))
    expect(packet.issues[0]!.expected).toEqual({enum:['approve']})
    expect(compiler.repairUnique()).toBeUndefined()
    expect(compiler.snapshot().submissions).toBe(1)
  })
  it('locates unknown edge references and invalid explicit ports as independent finite choices',()=>{
    const compiler=new WorkflowAuthoringCompiler(templateContext()),wire=branchWire()
    wire.submission.chains[0]!.nodes=['start','choose']
    wire.submission.links[0]!.port='invented'
    wire.submission.links[1]!.target='unknown'
    const packet=requireFailure(compiler.submit(wire))
    expect(packet.allowedPaths).toEqual(['/linksByKey/yes/port','/linksByKey/no/target'])
    expect(packet.issues[0]).toMatchObject({code:'INVALID_PORT',candidates:['true','false'],actualType:'string'})
    expect(packet.issues[1].candidates).toContain('failed')
    expect(compiler.repairUnique()).toBeUndefined()
    expect(()=>assertSupportedJsonSchema(compiler.nextSchema)).not.toThrow()
  })
  it('runs Host rules through revision, scope and stall enforcement',()=>{
    const compiler=new RepairSession(submissionSchema({type:'object'}),{maxSubmissions:4,roots:()=>['/text','/protected'],compile:()=>{throw new CompilerError('BAD','invalid','/text')},uniqueRepair:()=>({patches:[{op:'replace',path:'/protected',value:'changed'}],reason:'invalid rule'})})
    requireFailure(compiler.submit({submission:{text:'bad',protected:'keep'}}))
    const packet=requireFailure(compiler.repairUnique())
    expect(packet.issues[0]!.code).toBe('PATCH_SCOPE')
    expect((compiler.snapshot().document as any).protected).toBe('keep')
    expect(()=>compiler.repairUnique()).toThrow('重复')
  })
})
