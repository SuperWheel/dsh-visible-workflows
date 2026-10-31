import { describe,expect,it } from 'vitest'
import { compilePlanningChain, planningChainDigest, planningChainView, createChainDraft, applyChainSplice, confirmChainDraft, compareChainAliases } from '../src/shared/planning-chain.ts'
import { planningChainRequestSchema, type PlanningChainRequest } from '../src/shared/planning-chain-contract.ts'
import { compileHandoffChanges, planningHandoffSchema, handoffSelection } from '../src/shared/planning-handoff.ts'
import type { PlanningContext } from '../src/shared/planning-types.ts'
import { createTemplateBinding } from '../src/shared/planning-node-templates.ts'
import { buildPlanningToolOutputs } from '../src/shared/planning-tool-outputs.ts'
import { allNodes } from '../src/shared/workflow-validation.ts'
import { planningNodeRefs } from '../src/shared/planning-edits.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'

const form=(key:string,text=key)=>({key,template:'template',values:{text}})
function context():PlanningContext {
  const context=templateContext();context.operation='revise';context.workflow.revision=7
  context.workflow.nodes.splice(1,0,{id:'old-text-node',kind:'template',number:'a-2',title:'Old text',x:300,y:200,fixed:false,config:{text:'Old'}})
  context.workflow.nodes[0]!.number='a-1';context.workflow.nodes[2]!.number='a-3'
  context.workflow.nodes[2]!.config.text='{{old-text-node.text}}'
  context.workflow.edges=[{id:'entry-original',source:'host-start',target:'old-text-node'},{id:'exit-original',source:'old-text-node',target:'host-end'}]
  context.targetNodeIds=['old-text-node','host-end'];return context
}
function request(context:PlanningContext,operations:unknown[],extra:Record<string,unknown>={}):PlanningChainRequest {
  return planningChainRequestSchema.parse({version:1,baseDigest:planningChainDigest(context.workflow),baseRevision:context.workflow.revision,chainKey:'a',anchorNodeId:'old-text-node',operations,...extra})
}
describe('versioned hierarchical chain draft',()=>{
  it('implements the attachment example, recursive replacement, deletion and final numeric mapping',()=>{
    let draft=createChainDraft({chainKey:'a',baseDigest:'a'.repeat(64),baseRevision:7,nodeIds:['first','second','third']})
    draft=applyChainSplice(draft,{op:'replace',draftRevision:0,target:'a-2',nodes:[form('one'),form('two'),form('three')]})
    expect(draft.active.map(entry=>entry.alias)).toEqual(['a-1','a-2#1','a-2#2','a-2#3','a-3'])
    draft=applyChainSplice(draft,{op:'delete',draftRevision:1,target:'a-2#2'})
    draft=applyChainSplice(draft,{op:'replace',draftRevision:2,target:'a-2#3',nodes:[form('four'),form('five')]})
    expect(confirmChainDraft(draft).mapping).toEqual({'a-1':'a-1','a-2#1':'a-2','a-2#3#1':'a-3','a-2#3#2':'a-4','a-3':'a-5'})
    expect(draft.retired).toEqual(['a-2','a-2#2','a-2#3']);expect(draft.aliasWrites).toBe(8)
    expect(()=>applyChainSplice(draft,{op:'delete',draftRevision:3,target:'a-2'})).toThrow('目标已删除')
    expect(()=>applyChainSplice(draft,{op:'delete',draftRevision:1,target:'a-3'})).toThrow('旧草稿版本')
  })
  it('orders #2 before #10 and recursive descendants numerically; refuses invalid or cross-chain aliases',()=>{
    expect(compareChainAliases('a-2#2','a-2#10')).toBeLessThan(0)
    expect(compareChainAliases('a-2#3#1','a-2#10')).toBeLessThan(0)
    expect(compareChainAliases('a-99999999999999999','a-100000000000000000')).toBeLessThan(0)
    expect(()=>compareChainAliases('a-2','b-2')).toThrow('不同链')
    expect(()=>compareChainAliases('a-02','a-2')).toThrow('语法')
  })
  it('retains stable identity in before/after expansions, never revives empty parents or reuses deleted keys',()=>{
    const initial=createChainDraft({chainKey:'a',baseDigest:'a'.repeat(64),baseRevision:1,nodeIds:['old']})
    const before=applyChainSplice(initial,{op:'insert',draftRevision:0,target:'a-1',position:'before',nodes:[form('new')]})
    expect(before.active.map(entry=>[entry.alias,entry.nodeId??entry.form!.key])).toEqual([['a-1#1','new'],['a-1#2','old']])
    const after=applyChainSplice(initial,{op:'insert',draftRevision:0,target:'a-1',position:'after',nodes:[form('new')]})
    expect(after.active.map(entry=>entry.nodeId??entry.form!.key)).toEqual(['old','new'])
    const gone=applyChainSplice(before,{op:'replace',draftRevision:1,target:'a-1#1',nodes:[]})
    expect(()=>applyChainSplice(gone,{op:'insert',draftRevision:2,target:'a-1#2',position:'after',nodes:[form('new')]})).toThrow('不能复用')
    const empty=applyChainSplice(gone,{op:'delete',draftRevision:2,target:'a-1#2'})
    expect(confirmChainDraft(empty).entries).toEqual([]);expect(initial.active[0]!.alias).toBe('a-1')
  })
})
describe('Host chain compiler through the canonical proposal materializer',()=>{
  it('discovers order from UUID edges even when numbers and storage order disagree; never uses display numbers as topology',()=>{
    const ctx=context();ctx.workflow.nodes.reverse();ctx.workflow.nodes.find(node=>node.id==='old-text-node')!.number='strange-99'
    const view=planningChainView(ctx,{anchorNodeId:'old-text-node'})
    expect(view.nodes.map(node=>node.nodeId)).toEqual(['host-start','old-text-node','host-end'])
    expect(view.nodes.map(node=>node.alias)).toEqual(['a-1','a-2','a-3']);expect(view.nodes[1]!.actualNumber).toBe('strange-99')
  })
  it('compiles the attachment sequence and exports the consumed old output explicitly; keeps original IDs, numbers and metadata',()=>{
    const ctx=context(),before=structuredClone(ctx)
    const operation=request(ctx,[{op:'replace',draftRevision:0,target:'a-2',nodes:[form('one'),form('two'),form('three')]},{op:'delete',draftRevision:1,target:'a-2#2'},{op:'replace',draftRevision:2,target:'a-2#3',nodes:[form('four'),form('five')]}],{exports:[{from:{nodeId:'old-text-node',field:'text'},to:{key:'five',field:'text'}}]})
    const result=compilePlanningChain(operation,ctx)
    expect(result.issues).toEqual([]);expect(result.chain.mapping.map(row=>row.temporaryAlias)).toEqual(['a-1','a-2#1','a-2#3#1','a-2#3#2','a-3'])
    expect(result.chain.mapping.map(row=>row.standardAlias)).toEqual(['a-1','a-2','a-3','a-4','a-5'])
    const output=result.candidate!.nodes.find(node=>node.id==='host-end')!,last=result.chain.mapping[3]!
    expect(output.config.text).toBe(`{{${last.nodeId}.text}}`);expect(output.number).toBe('a-3')
    expect(result.candidate!.nodes.find(node=>node.id==='host-start')).toEqual(ctx.workflow.nodes[0])
    expect(result.candidate!.revision).toBe(7);expect(result.candidate!.editor).toEqual(ctx.workflow.editor);expect(ctx).toEqual(before)
    expect(new Set(result.chain.mapping.map(row=>row.actualNumber)).size).toBe(5)
    expect(result.chain.mapping[4]!.actualNumber).toBe('a-3')
  })
  it('adds a node and points the existing consumer at it in one splice, so nothing waits on an unaccepted proposal (Desktop r59 E)',()=>{
    const ctx=context(),operation=request(ctx,[
      {op:'insert',draftRevision:0,target:'a-2',position:'before',nodes:[form('ext','csv')]},
      {op:'replace',draftRevision:1,target:'a-2#2',nodes:[form('table','Old | {{ext.text}}')]},
    ],{exports:[{from:{nodeId:'old-text-node',field:'text'},to:{key:'table',field:'text'}}]})
    const result=compilePlanningChain(operation,ctx)
    expect(result.issues).toEqual([])
    const ext=result.candidate!.nodes.find(node=>node.config.text==='csv')!,table=result.candidate!.nodes.find(node=>String(node.config.text).startsWith('Old |'))!
    expect(table.config.text).toBe(`Old | {{${ext.id}.text}}`)
    expect(result.candidate!.nodes.find(node=>node.id==='host-end')!.config.text).toBe(`{{${table.id}.text}}`)
    expect(result.candidate!.nodes.some(node=>node.id==='old-text-node')).toBe(false)
  })
  it.each([
    ['insert, then update by the original alias',[{op:'insert',draftRevision:0,target:'a-2',position:'before',nodes:[form('extRow','csv')]},{op:'update',draftRevision:1,target:'a-2',values:{text:'Old | {{extRow.text}}'}}]],
    ['update, then insert',[{op:'update',draftRevision:0,target:'a-2',values:{text:'Old | {{extRow.text}}'}},{op:'insert',draftRevision:1,target:'a-2',position:'before',nodes:[form('extRow','csv')]}]],
  ])('adds a node and changes the existing consumer in place in one splice: %s (Desktop r60 E)',(_label,operations)=>{
    const ctx=context(),result=compilePlanningChain(request(ctx,operations),ctx)
    expect(result.issues).toEqual([])
    const ext=result.candidate!.nodes.find(node=>node.config.text==='csv')!,old=result.candidate!.nodes.find(node=>node.id==='old-text-node')!
    expect(old.config.text).toBe(`Old | {{${ext.id}.text}}`);expect(old.title).toBe('Old text')
    expect(result.candidate!.nodes.find(node=>node.id==='host-end')!.config.text).toBe('{{old-text-node.text}}')
    expect(result.candidate!.edges.find(edge=>edge.target===ext.id)!.source).toBe('host-start')
    expect(result.candidate!.edges.find(edge=>edge.source===ext.id)!.target).toBe('old-text-node')
  })
  it('changes a node outside the chain by its Host key or ID in the same splice, so one candidate holds every change (Desktop r65 E)',()=>{
    const ctx=context()
    // A parallel check beside the chain: the start fans out and the end fans in, so the chain is the old text node alone.
    ctx.workflow.nodes.push({id:'side-check',kind:'template',number:'a-4',title:'Check',x:600,y:400,fixed:false,config:{text:'check'}})
    ctx.workflow.edges.push({id:'side-in',source:'host-start',target:'side-check'},{id:'side-out',source:'side-check',target:'host-end'})
    ctx.targetNodeIds=[]
    const refs=planningNodeRefs(ctx.workflow),key=(id:string)=>'n'+refs.get(id)!.slice(1)
    expect(planningChainView(ctx,{anchorNodeId:'old-text-node'}).nodes.map(row=>row.nodeId)).toEqual(['old-text-node'])
    for(const target of [key('side-check'),'side-check']){
      const result=compilePlanningChain(request(ctx,[{op:'insert',draftRevision:0,target:'a-1',position:'before',nodes:[form('extRow','csv')]},
        {op:'update',draftRevision:1,target:key('old-text-node'),values:{text:'Old | {{extRow.text}}'}},{op:'update',draftRevision:2,target,values:{text:'check ext'}}]),ctx)
      expect(result.issues).toEqual([])
      const ext=result.candidate!.nodes.find(node=>node.config.text==='csv')!
      expect(result.candidate!.nodes.find(node=>node.id==='old-text-node')!.config.text).toBe(`Old | {{${ext.id}.text}}`)
      expect(result.candidate!.nodes.find(node=>node.id==='side-check')!.config.text).toBe('check ext')
      expect(result.candidate!.edges.filter(edge=>edge.source==='side-check'||edge.target==='side-check').map(edge=>edge.id).sort()).toEqual(['side-in','side-out'])
    }
    expect(()=>compilePlanningChain(request(ctx,[{op:'update',draftRevision:0,target:'n99',values:{text:'x'}},{op:'delete',draftRevision:1,target:'a-1'},{op:'update',draftRevision:2,target:key('old-text-node'),values:{text:'y'}}]),ctx))
      .toThrow(expect.objectContaining({code:'CHAIN_TARGET_INACTIVE',message:expect.stringMatching(/update 的目标 n99 不是链段别名，也不是已有节点的 key.*另外，update 的目标 n\d+ 已在本次修改中删除或替换/)}))
    expect(()=>compilePlanningChain(request(ctx,[{op:'update',draftRevision:0,target:'side-check',values:{body:{nodes:[],edges:[]}}}]),ctx)).toThrow('不能整体改 body')
    ctx.targetNodeIds=['old-text-node']
    expect(()=>compilePlanningChain(request(ctx,[{op:'update',draftRevision:0,target:key('side-check'),values:{text:'z'}}]),ctx)).toThrow(expect.objectContaining({code:'CHAIN_TARGET_SCOPE'}))
  })
  it('reports every gone target with the aliases in use, and every key that takes a Host name, in one message (Desktop r60 E)',()=>{
    const ctx=context()
    expect(()=>compilePlanningChain(request(ctx,[{op:'replace',draftRevision:0,target:'a-2',nodes:[form('table')]},{op:'insert',draftRevision:1,target:'a-2',position:'before',nodes:[form('n1')]}]),ctx))
      .toThrow(expect.objectContaining({code:'CHAIN_TARGET_INACTIVE',message:expect.stringMatching(/目标已删除、已展开或不属于当前草稿：a-2；当前可用：a-1、a-2#1（新增 table）、a-3.*另外，新模板 key n1 与已有 Host 别名冲突/)}))
  })
  it('inserts while retaining the original UUID and protects unrelated edge IDs, scopes and numbers',()=>{
    const ctx=context(),operation=request(ctx,[{op:'insert',draftRevision:0,target:'a-2',position:'before',nodes:[form('new')]}])
    const result=compilePlanningChain(operation,ctx),old=result.candidate!.nodes.find(node=>node.id==='old-text-node')!
    expect(old).toEqual(ctx.workflow.nodes[1]);expect(result.candidate!.edges.find(edge=>edge.source==='old-text-node'&&edge.target==='host-end')!.id).toBe('exit-original')
    expect(result.chain.mapping.find(row=>row.nodeId==='old-text-node')!.temporaryAlias).toBe('a-2#2')
    expect(result.candidate!.nodes.every(node=>!node.config.body)).toBe(true)
  })
  it('deletes an unconsumed producer and mechanically bypasses only its selected boundaries',()=>{
    const ctx=context();ctx.workflow.nodes[2]!.config.text='Constant'
    const result=compilePlanningChain(request(ctx,[{op:'delete',draftRevision:0,target:'a-2'}]),ctx)
    expect(result.candidate!.nodes.map(node=>node.id)).toEqual(['host-start','host-end'])
    expect(result.candidate!.edges).toMatchObject([{source:'host-start',target:'host-end'}])
    expect(result.issues).toEqual([])
  })
  it('supports selected branch-edge insertion without changing the other branch edge or original port',()=>{
    const ctx=context();ctx.targetNodeIds=['old-text-node']
    ctx.workflow.nodes[2]!.config.text='Constant'
    ctx.workflow.nodes.splice(1,0,{id:'router',kind:'if',number:'a-1-branch',title:'Router',x:150,y:0,fixed:false,config:{variable:'input.flag',operator:'equals',value:'yes'}})
    ctx.workflow.edges=[{id:'to-router',source:'host-start',target:'router'},{id:'true-edge',source:'router',target:'old-text-node',port:'true'},{id:'false-edge',source:'router',target:'host-end',port:'false'},{id:'exit-original',source:'old-text-node',target:'host-end'}]
    const view=planningChainView(ctx,{anchorNodeId:'old-text-node',boundary:{entryEdgeId:'true-edge'}})
    expect(view.nodes.map(node=>node.nodeId)).toEqual(['old-text-node'])
    // The merge endpoint is outside the safe segment and remains unchanged.
    const result=compilePlanningChain(request(ctx,[{op:'insert',draftRevision:0,target:'a-1',position:'before',nodes:[form('chosen')]}],{boundary:{entryEdgeId:'true-edge'}}),ctx)
    expect(result.candidate!.edges.find(edge=>edge.id==='false-edge')).toEqual(ctx.workflow.edges[2])
    const added=result.chain.mapping.find(row=>row.nodeId!=='old-text-node')!
    expect(result.candidate!.edges).toContainEqual(expect.objectContaining({source:'router',target:added.nodeId,port:'true'}))
    expect(result.candidate!.edges.find(edge=>edge.id==='exit-original')).toEqual(ctx.workflow.edges[3])
  })
  it('requires explicit edge selection for merges; refuses deletion with unmapped external boundaries and arbitrary ordering',()=>{
    const ctx=context();ctx.workflow.edges.push({id:'second-entry',source:'host-start',target:'old-text-node',port:'other'})
    expect(()=>planningChainView(ctx,{anchorNodeId:'old-text-node'})).toThrow('多个边')
    expect(()=>compilePlanningChain(request(ctx,[{op:'delete',draftRevision:0,target:'a-1'}],{nodeIds:['old-text-node'],boundary:{entryEdgeId:'entry-original'}}),ctx)).toThrow('未映射外部边')
    expect(()=>planningChainView(context(),{anchorNodeId:'old-text-node',nodeIds:['old-text-node','host-start']})).toThrow('顺序段')
    expect(()=>planningChainView(context(),{anchorNodeId:'old-text-node',boundary:{entryEdgeId:'missing'}})).toThrow('不在该片段边界')
  })
  it('rejects stale baselines, stale draft revisions and inactive parents before applying mutations',()=>{
    const ctx=context(),before=structuredClone(ctx),operation=request(ctx,[{op:'delete',draftRevision:0,target:'a-2'}])
    operation.baseRevision--;expect(()=>compilePlanningChain(operation,ctx)).toThrow('旧工作流版本')
    operation.baseRevision++;operation.baseDigest='f'.repeat(64);expect(()=>compilePlanningChain(operation,ctx)).toThrow('旧工作流版本')
    expect(()=>compilePlanningChain(request(ctx,[{op:'insert',draftRevision:0,target:'a-2',position:'after',nodes:[form('one')]},{op:'delete',draftRevision:0,target:'a-2#1'}]),ctx)).toThrow('旧草稿版本')
    // An insert keeps a-2 naming the node it was inserted next to; only a replaced or deleted alias is gone (Desktop r60 E).
    expect(()=>compilePlanningChain(request(ctx,[{op:'replace',draftRevision:0,target:'a-2',nodes:[form('one')]},{op:'delete',draftRevision:1,target:'a-2'}]),ctx)).toThrow('目标已删除')
    expect(ctx).toEqual(before)
  })
  it('refuses cycles, fixed incident boundaries and deletion without an explicit authorized target',()=>{
    const cyclic=context();cyclic.workflow.edges.push({id:'cycle',source:'host-end',target:'host-start'})
    expect(()=>planningChainView(cyclic,{anchorNodeId:'old-text-node'})).toThrow('循环')
    const fixed=context();fixed.workflow.nodes[0]!.fixed=true
    const view=planningChainView(fixed,{anchorNodeId:'old-text-node'})
    const target=view.nodes.find(node=>node.nodeId==='old-text-node')!.alias
    expect(()=>compilePlanningChain(request(fixed,[{op:'insert',draftRevision:0,target,position:'before',nodes:[form('one')]}]),fixed)).toThrow('固定')
    const empty=context();empty.targetNodeIds=[];empty.workflow.nodes[2]!.config.text='Constant'
    expect(()=>compilePlanningChain(request(empty,[{op:'delete',draftRevision:0,target:'a-2'}]),empty)).toThrow('明确授权目标范围')
  })
  it('rejects fixed targets, fixed ancestors, unauthorized consumers and cross-scope fragments',()=>{
    const ctx=context();ctx.workflow.nodes[1]!.fixed=true
    expect(()=>compilePlanningChain(request(ctx,[{op:'insert',draftRevision:0,target:'a-2',position:'after',nodes:[form('one')]}]),ctx)).toThrow('固定节点')
    ctx.workflow.nodes[1]!.fixed=false;ctx.targetNodeIds=['old-text-node']
    expect(()=>compilePlanningChain(request(ctx,[{op:'replace',draftRevision:0,target:'a-2',nodes:[form('one')]}],{exports:[{from:{nodeId:'old-text-node',field:'text'},to:{key:'one',field:'text'}}]}),ctx)).toThrow('消费者不在授权范围')
    const nested=context(),body={nodes:nested.workflow.nodes.slice(1),edges:[nested.workflow.edges[1]!]}
    nested.workflow.nodes=[nested.workflow.nodes[0]!,{id:'container',kind:'loop',number:'a-2',title:'Fixed loop',fixed:true,x:0,y:0,config:{body}}];nested.workflow.edges=[]
    const view=planningChainView(nested,{anchorNodeId:'old-text-node'})
    expect(view.scope).toEqual(['container'])
    expect(()=>compilePlanningChain(request(nested,[{op:'delete',draftRevision:0,target:'a-1'}]),nested)).toThrow('固定节点')
    expect(()=>planningChainView(nested,{anchorNodeId:'old-text-node',nodeIds:['host-start','old-text-node']})).toThrow('同一 scope')
  })
  it('requires exports for consumers and refuses dynamic/literal rewriting, unproven fields, nested paths and incompatible types',()=>{
    const ctx=context(),operation=[{op:'replace',draftRevision:0,target:'a-2',nodes:[form('one')]}],mapping={exports:[{from:{nodeId:'old-text-node',field:'text'},to:{key:'one',field:'text'}}]}
    expect(()=>compilePlanningChain(request(ctx,operation),ctx)).toThrow('需要明确 exports')
    ctx.workflow.nodes[2]!.config.text='{{old-text-node[dynamic]}}'
    expect(()=>compilePlanningChain(request(ctx,operation,mapping),ctx)).toThrow('合法静态引用语法')
    ctx.workflow.nodes[2]!.config.text='{{old-text-node.text.unknown}}'
    expect(()=>compilePlanningChain(request(ctx,operation,mapping),ctx)).toThrow('嵌套输出路径')
    ctx.workflow.nodes[2]!.config.text='{{old-text-node.text}}'
    expect(()=>compilePlanningChain(request(ctx,operation,{exports:[{from:{nodeId:'old-text-node',field:'text'},to:{key:'one',field:'missing'}}]}),ctx)).toThrow('类型明确')
    expect(()=>compilePlanningChain(request(ctx,[{op:'replace',draftRevision:0,target:'a-2',nodes:[{key:'number',template:'code',values:{code:'function main() { return { count: 1 }; }',outputSchema:[{name:'count',type:'number',required:true}]}}]}],{exports:[{from:{nodeId:'old-text-node',field:'text'},to:{key:'number',field:'count'}}]}),ctx)).toThrow('类型不一致')
  })
  it('rewrites bracket, template conditions/filter arguments and selectors using the existing grammar, then validates upstream scope',()=>{
    const ctx=context();ctx.workflow.nodes[2]!.kind='template';ctx.workflow.nodes[2]!.config={text:'{% if old-text-node.text is defined %}{{old-text-node["text"] | default(old-text-node.text)}}{% endif %}'}
    const result=compilePlanningChain(request(ctx,[{op:'replace',draftRevision:0,target:'a-2',nodes:[form('one')]}],{exports:[{from:{nodeId:'old-text-node',field:'text'},to:{key:'one',field:'text'}}]}),ctx)
    expect(result.candidate!.nodes.find(node=>node.id==='host-end')!.config.text).toContain(`${result.chain.mapping[1]!.nodeId}.text is defined`)
    expect(result.candidate!.nodes.find(node=>node.id==='host-end')!.config.text).not.toContain('old-text-node')
    expect(allNodes(result.candidate!).map(node=>node.id)).toContain(result.chain.mapping[1]!.nodeId)
  })
  it.each([{kind:'llm',field:'text',declaredType:'number'},{kind:'llm',field:'json',declaredType:'number'},{kind:'agent',field:'text',declaredType:'number'},{kind:'agent',field:'json',declaredType:'number'},{kind:'agent',field:'steps',declaredType:'string'}] as const)('uses runtime $kind.$field wrapper type before a colliding declaration',({kind,field,declaredType})=>{
    const ctx=context();ctx.workflow.nodes[1]!.kind=kind;ctx.workflow.nodes[1]!.config={prompt:'Return structured data',outputSchema:[{name:field,type:declaredType,required:true}]}
    ctx.workflow.nodes[2]!.config.text=`{{old-text-node.${field}}}`
    const operation={op:'replace',draftRevision:0,target:'a-2',nodes:[{key:'replacement',template:'code',values:{code:'function main() { return {}; }',outputSchema:[{name:'value',type:declaredType,required:true}]}}]}
    expect(()=>compilePlanningChain(request(ctx,[operation],{exports:[{from:{nodeId:'old-text-node',field},to:{key:'replacement',field:'value'}}]}),ctx)).toThrow('类型不一致')
  })
  it('accepts the real string LLM wrapper and validated ordinary business outputs while ignoring colliding raw declarations',()=>{
    const ctx=context();ctx.workflow.nodes[1]!.kind='llm';ctx.workflow.nodes[1]!.config={prompt:'Return JSON',outputSchema:[{name:'text',type:'number',required:true}]}
    const result=compilePlanningChain(request(ctx,[{op:'replace',draftRevision:0,target:'a-2',nodes:[form('replacement')]}],{exports:[{from:{nodeId:'old-text-node',field:'text'},to:{key:'replacement',field:'text'}}]}),ctx)
    expect(result.issues).toEqual([])
    ctx.workflow.nodes[1]!.config={prompt:'Return JSON',outputSchema:[{name:'count',type:'number',required:true}]};ctx.workflow.nodes[2]!.config.text='{{old-text-node.count}}'
    const business=compilePlanningChain(request(ctx,[{op:'replace',draftRevision:0,target:'a-2',nodes:[{key:'replacement',template:'code',values:{code:'function main() { return { count: 1 }; }',outputSchema:[{name:'count',type:'number',required:true}]}}]}],{exports:[{from:{nodeId:'old-text-node',field:'count'},to:{key:'replacement',field:'count'}}]}),ctx)
    expect(business.issues).toEqual([])
  })
  it('uses exact builtin field sets and requires a Host schema for native value instead of treating rendered shape as authority',()=>{
    const targetContext=context();targetContext.tools=[{id:'builtin:time.weekday',name:'Weekday',description:'Weekday',available:true,inputSchema:{type:'object',properties:{}}}]
    const clockTemplate=createTemplateBinding(targetContext.tools).templates.find(template=>template.fixed.toolId==='builtin:time.weekday')!.id
    const clock={op:'replace',draftRevision:0,target:'a-2',nodes:[{key:'clock',template:clockTemplate,values:{inputs:{}}}]}
    expect(()=>compilePlanningChain(request(targetContext,[clock],{exports:[{from:{nodeId:'old-text-node',field:'text'},to:{key:'clock',field:'iso'}}]}),targetContext)).toThrow('类型明确')
    expect(compilePlanningChain(request(targetContext,[clock],{exports:[{from:{nodeId:'old-text-node',field:'text'},to:{key:'clock',field:'text'}}]}),targetContext).issues).toEqual([])
    const ctx=context();ctx.workflow.nodes[1]!.kind='tool';ctx.workflow.nodes[1]!.config={toolId:'builtin:time.weekday',inputs:{}}
    ctx.tools=[{id:'builtin:time.weekday',name:'Weekday',description:'Weekday',available:true,inputSchema:{type:'object',properties:{}}}]
    ctx.workflow.nodes[2]!.config.text='{{old-text-node.timestamp}}'
    const number={key:'replacement',template:'code',values:{code:'function main() { return { count: 1 }; }',outputSchema:[{name:'count',type:'number',required:true}]}}
    expect(()=>compilePlanningChain(request(ctx,[{op:'replace',draftRevision:0,target:'a-2',nodes:[number]}],{exports:[{from:{nodeId:'old-text-node',field:'timestamp'},to:{key:'replacement',field:'count'}}]}),ctx)).toThrow('类型明确')
    ctx.workflow.nodes[1]!.config={toolId:'native:lookup',inputs:{}};ctx.tools=[{id:'native:lookup',name:'Lookup',description:'Lookup',available:true,inputSchema:{type:'object',properties:{}}}]
    ctx.workflow.nodes[2]!.config.text='{{old-text-node.value}}'
    const operation={op:'replace',draftRevision:0,target:'a-2',nodes:[form('replacement')]},mapping={exports:[{from:{nodeId:'old-text-node',field:'value'},to:{key:'replacement',field:'text'}}]}
    expect(()=>compilePlanningChain(request(ctx,[operation],mapping),ctx)).toThrow('类型明确')
    ctx.toolOutputs=buildPlanningToolOutputs(ctx.tools,{schemas:[{toolId:'native:lookup',sourceId:'native-tool:lookup',version:'v1',valuePath:'value',schema:{type:'string'}}]})
    expect(compilePlanningChain(request(ctx,[operation],mapping),ctx).issues).toEqual([])
  })
  it('injects fixed tool IDs from templates and rejects raw graph/identity fields in the external contract',()=>{
    expect(()=>planningChainRequestSchema.parse({...request(context(),[{op:'delete',draftRevision:0,target:'a-2'}]),edges:[]})).toThrow()
    expect(()=>request(context(),[{op:'replace',draftRevision:0,target:'a-2',nodes:[{key:'raw',kind:'template',config:{text:'raw'}}]}])).toThrow()
    const ctx=context();ctx.tools=[{id:'native:example',name:'Example',description:'Test',available:true,inputSchema:{type:'object',properties:{},additionalProperties:false}}]
    const bindingId=createTemplateBinding(ctx.tools).templates.find(template=>template.fixed.toolId==='native:example')!.id
    const operation={op:'insert',draftRevision:0,target:'a-2',position:'after',nodes:[{key:'native',template:bindingId,values:{inputs:{}}}]}
    const result=compilePlanningChain(request(ctx,[operation]),ctx)
    expect(result.candidate!.nodes.find(node=>node.kind==='tool')!.config.toolId).toBe('native:example')
    expect(()=>compilePlanningChain(request(ctx,[{...operation,nodes:[{key:'native',template:bindingId,values:{toolId:'native:evil',inputs:{}}}]}]),ctx)).toThrow('固定字段')
  })
  it('routes version 3 chain handoffs to the pure compiler without widening selection or using another save path',()=>{
    const ctx=context(),chain=request(ctx,[{op:'insert',draftRevision:0,target:'a-2',position:'after',nodes:[form('one')]}])
    const handoff=planningHandoffSchema.parse({version:3,mode:'chain',chain})
    if(handoff.mode!=='chain')throw Error('schema')
    expect(handoffSelection(handoff)).toEqual({targetNodeIds:['old-text-node'],topologyChanged:true,outputChanged:true})
    expect(compileHandoffChanges(handoff,ctx).candidate).toEqual(compilePlanningChain(chain,ctx).candidate)
  })
})
