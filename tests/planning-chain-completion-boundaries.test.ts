import {describe,expect,it} from 'vitest'
import {applyChainSplice,createChainDraft} from '../src/shared/planning-chain-draft.ts'
import {chainSpliceSchema,planningChainRequestSchema} from '../src/shared/planning-chain-contract.ts'
import {compilePlanningChain,planningChainView} from '../src/shared/planning-chain.ts'
import {createChainBenchmarkContext} from '../scripts/benchmarks/planning-chain-splice.ts'
const form=(key:string)=>({key,template:'template',values:{text:key}})
describe('S11 production resource and failed-splice boundaries',()=>{
  it('rejects duplicate stable identities and duplicate new keys without changing the draft',()=>{
    expect(()=>createChainDraft({chainKey:'a',baseDigest:'a'.repeat(64),baseRevision:1,nodeIds:['old','old']})).toThrow('身份')
    const draft=createChainDraft({chainKey:'a',baseDigest:'a'.repeat(64),baseRevision:1,nodeIds:['old']}),before=structuredClone(draft)
    expect(()=>applyChainSplice(draft,{op:'replace',draftRevision:0,target:'a-1',nodes:[form('same'),form('same')]})).toThrow('key')
    expect(draft).toEqual(before)
  })
  it('stops recursive expansion at 24 levels without mutating the last valid draft',()=>{
    let draft=createChainDraft({chainKey:'a',baseDigest:'a'.repeat(64),baseRevision:1,nodeIds:['old']})
    for(let i=0;i<23;i++)draft=applyChainSplice(draft,{op:'replace',draftRevision:i,target:draft.active[0]!.alias,nodes:[form('n'+i)]})
    const before=structuredClone(draft)
    expect(()=>applyChainSplice(draft,{op:'replace',draftRevision:23,target:draft.active[0]!.alias,nodes:[form('tooDeep')]})).toThrow('24')
    expect(draft).toEqual(before)
  })
  it('rejects 201 forms or operations at the external contract before compilation',()=>{
    const operation={op:'replace',draftRevision:0,target:'a-1',nodes:Array.from({length:201},(_,i)=>form('n'+i))}
    expect(chainSpliceSchema.safeParse(operation).success).toBe(false)
    expect(planningChainRequestSchema.safeParse({version:1,chainKey:'a',baseDigest:'a'.repeat(64),baseRevision:1,anchorNodeId:'old',operations:Array.from({length:201},()=>({op:'delete',draftRevision:0,target:'a-1'}))}).success).toBe(false)
  })
  it('preserves named inputs and template loop locals shadowing a replaced node identity',()=>{
    const context=createChainBenchmarkContext(31),old=context.targetNodeIds[0]!,target=context.workflow.nodes.find(n=>n.id===old)!
    target.id='producer';context.targetNodeIds=['producer']
    for(const edge of context.workflow.edges){if(edge.source===old)edge.source='producer';if(edge.target===old)edge.target='producer'}
    const consumer=context.workflow.nodes[16]!,text='{{producer}}{% for producer in items %}{{producer}}{% endfor %}'
    consumer.config={inputs:{producer:'local',items:['x']},text}
    const view=planningChainView(context,{anchorNodeId:'producer'})
    const result=compilePlanningChain(planningChainRequestSchema.parse({version:1,baseDigest:view.baseDigest,baseRevision:view.baseRevision,anchorNodeId:'producer',operations:[{op:'replace',draftRevision:0,target:view.nodes.find(n=>n.nodeId==='producer')!.alias,nodes:[form('replacement')]}]}),context)
    expect(result.issues).toEqual([])
    expect(result.candidate!.nodes.find(n=>n.id===consumer.id)!.config).toEqual(consumer.config)
  })
  it.each([
    ['dynamic local indexing','{{producer[dynamic]}}',{producer:'local'}],
    ['quoted identity literal','{{"producer"}}',{producer:'local'}],
    ['plain identity literal','producer {{producer}}',{producer:'local'}],
    ['unknown command','{% unknown producer %}{{producer}}',{producer:'local'}],
    ['unbalanced loop','{% for producer in items %}{{producer}}',{items:['x']}],
    ['mismatched block','{% for producer in items %}{{producer}}{% endif %}',{items:['x']}],
    ['reference after loop scope','{% for producer in items %}{{producer}}{% endfor %}{{producer.text}}',{items:['x']}],
    ['empty loop fallback scope','{% for producer in items %}{{producer}}{% else %}{{producer.text}}{% endfor %}',{items:[]}],
    ['unclosed filter argument','{{producer | default( }}',{producer:'local'}],
    ['empty loop iterable','{% for producer in  %}{{producer}}{% endfor %}',{producer:'local'}],
    ['duplicate else','{% for producer in items %}{{producer}}{% else %}{{producer}}{% else %}{{producer}}{% endfor %}',{producer:'local',items:['x']}],
    ['elif after else','{% if true %}{{producer}}{% else %}{{producer}}{% elif true %}{{producer}}{% endif %}',{producer:'local'}],
    ['unmatched template close','{{producer}} }}',{producer:'local'}],
    ['trailing empty filter argument','{{producer | default("x",) }}',{producer:'local'}],
    ['unreliable neighboring expression','{{producer}} {{other | default( }}',{producer:'local'}],
  ] as const)('continues refusing %s without a proven static mapping',(_name,text,inputs)=>{
    const context=createChainBenchmarkContext(31),old=context.targetNodeIds[0]!,target=context.workflow.nodes.find(n=>n.id===old)!
    target.id='producer';context.targetNodeIds=['producer']
    for(const edge of context.workflow.edges){if(edge.source===old)edge.source='producer';if(edge.target===old)edge.target='producer'}
    context.workflow.nodes[16]!.config={inputs:structuredClone(inputs),text}
    const before=structuredClone(context.workflow),view=planningChainView(context,{anchorNodeId:'producer'})
    expect(()=>compilePlanningChain(planningChainRequestSchema.parse({version:1,baseDigest:view.baseDigest,baseRevision:view.baseRevision,anchorNodeId:'producer',operations:[{op:'replace',draftRevision:0,target:view.nodes.find(n=>n.nodeId==='producer')!.alias,nodes:[form('replacement')]}]}),context)).toThrow()
    expect(context.workflow).toEqual(before)
  })
  it('does not treat removed identities inside arbitrary code as template locals',()=>{
    const context=createChainBenchmarkContext(31),old=context.targetNodeIds[0]!,consumer=context.workflow.nodes[16]!
    consumer.kind='code';consumer.config={code:'// '+old+'\nfunction main(){return {text:"ok"}}',outputSchema:[{name:'text',type:'string',required:true}]}
    const view=planningChainView(context,{anchorNodeId:old})
    expect(()=>compilePlanningChain(planningChainRequestSchema.parse({version:1,baseDigest:view.baseDigest,baseRevision:view.baseRevision,anchorNodeId:old,operations:[{op:'replace',draftRevision:0,target:view.nodes.find(n=>n.nodeId===old)!.alias,nodes:[form('replacement')]}]}),context)).toThrow('合法静态引用语法')
  })
  it.each([150,500])('rejects exceeding the real per-scope/total graph limit (baseline=%i)',total=>{
    const context=createChainBenchmarkContext(total),anchorNodeId=context.targetNodeIds[0]!,view=planningChainView(context,{anchorNodeId}),before=structuredClone(context)
    const count=total===150?51:1
    context.nodeIds=Array.from({length:count},(_,i)=>'fresh-'+i)
    const request=planningChainRequestSchema.parse({version:1,baseDigest:view.baseDigest,baseRevision:view.baseRevision,anchorNodeId,operations:[{op:'insert',draftRevision:0,target:view.nodes.find(n=>n.nodeId===anchorNodeId)!.alias,position:'after',nodes:Array.from({length:count},(_,i)=>form('n'+i))}]})
    let rejected=false
    try{const result=compilePlanningChain(request,context);rejected=result.issues.length>0||!result.candidate}catch{rejected=true}
    expect(rejected).toBe(true)
    expect(context.workflow).toEqual(before.workflow)
  })
})
