import { describe,expect,it } from 'vitest'
import { planningContextSlice } from '../src/shared/planning-context-slice.ts'
import { PlanningContextReader } from '../src/shared/planning-context-reader.ts'
import { authoringGraphContext } from '../src/shared/planning-authoring-context.ts'
import type { WorkflowNode } from '../src/shared/types.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'

const selection={targetNodeIds:['n2'],targetFields:{n2:['text']}}
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value))
function chain(text='{{sys.timestamp}}'){
  const context=templateContext();context.operation='revise';context.workflow.revision=1
  context.workflow.nodes=Array.from({length:30},(_,i)=>({
    id:'n'+i,kind:i===0?'input':'template',title:'node'+i,number:'a-'+(i+1),x:i,y:0,fixed:false,
    config:i===0?{fields:[]}:{text:i===1?text:'X'.repeat(1000)},
  }))
  context.workflow.edges=Array.from({length:29},(_,i)=>({id:'e'+i,source:'n'+i,target:'n'+(i+1)}))
  context.targetNodeIds=['n2'];return context
}
function read(context:ReturnType<typeof chain>){
  return new PlanningContextReader(context,{scopeIdentity:'audit'}).read({nodeIds:['n2'],selection})
}
describe('shared audit: bounded planning dependency context',()=>{
  it('keeps sys references as small as the literal control in the 30-node reproduction',()=>{
    const context=chain(),slice=planningContextSlice(context,selection),result=read(context),literal=read(chain('fixed'))
    expect(slice).toMatchObject({conservative:false,readNodeIds:['n0','n1','n2'],editableNodeIds:['n2']})
    expect(result.nodes).toHaveLength(3);expect(result.readNodeIds).toEqual(literal.readNodeIds)
    expect(Math.abs(bytes(result)-bytes(literal))).toBeLessThan(100)
    const fullBytes=bytes({...result,nodes:authoringGraphContext(context)})
    expect(bytes(result)).toBeLessThan(fullBytes*0.25)
    console.info('context slice bytes',JSON.stringify({sys:{nodes:result.nodes.length,bytes:bytes(result)},literal:{nodes:literal.nodes.length,bytes:bytes(literal)}}))
  })
  it.each(['{{env.region}}','{{env["region"]}}','{{input.name}}','{{inputs.name}}'])(
    'does not expand known namespace %s',text=>{
      expect(planningContextSlice(chain(text),selection)).toMatchObject({conservative:false,readNodeIds:['n0','n1','n2']})
    },
  )
  it('uses static reference paths and ignores node-like text inside literals',()=>{
    const context=chain('{{n10["text"] | default("n29.text")}}')
    context.workflow.edges=[]
    context.workflow.nodes[2]!.config.text='{{n1.text}}'
    expect(planningContextSlice(context,selection)).toMatchObject({conservative:false,readNodeIds:['n1','n2','n10']})
  })
  it('resolves local template inputs and for locals without treating them as node references',()=>{
    const context=chain('{% for row in rows %}{% if row.active %}{{row.name | default("n29.text")}}/{{loop.index}}{% endif %}{% else %}{{fallback}}{% endfor %}')
    context.workflow.nodes[1]!.config.inputs={rows:'{{n0.rows}}',fallback:'empty'}
    expect(planningContextSlice(context,selection)).toMatchObject({conservative:false,readNodeIds:['n0','n1','n2']})
    context.workflow.edges=[]
    context.workflow.nodes[2]!.config={inputs:{n29:'{{n0.text}}',literal:'n28'},text:'{{n29}} {{n29.name}} {{literal}}'}
    expect(planningContextSlice(context,selection)).toMatchObject({conservative:false,readNodeIds:['n0','n2']})
  })
  it('does not let template locals mask dependencies in input mappings',()=>{
    const context=chain();context.workflow.edges=[]
    context.workflow.nodes[2]!.config={inputs:{n29:'{{n29.text}}'},text:'{{n29}}'}
    expect(planningContextSlice(context,selection)).toMatchObject({conservative:false,readNodeIds:['n2','n29']})
  })
  it('recognizes loop state and iteration item/index using the compiled reference scope',()=>{
    const context=chain(),node=(id:string,kind:WorkflowNode['kind'],config:WorkflowNode['config']):WorkflowNode=>({id,kind,config,title:id,number:id,x:0,y:0,fixed:false})
    context.workflow.nodes=[node('loop','loop',{initialVariables:{count:0},body:{
      nodes:[node('each','iteration',{iterator:'input.rows',body:{nodes:[node('n2','template',{text:'{{vars.count}} {{item.name}} {{index}}'})],edges:[]}})],edges:[],
    }}),node('unrelated','template',{text:'literal'})]
    context.workflow.edges=[]
    expect(planningContextSlice(context,selection)).toMatchObject({conservative:false,readNodeIds:['loop','each','n2']})
    context.workflow.nodes[0]!.config.body!.nodes[0]!.config.body!.nodes[0]!.config.text='{{vars.missing}}'
    expect(planningContextSlice(context,selection).conservative).toBe(true)
  })
  it('recognizes variables written by preceding assignments without hiding a forward read',()=>{
    const context=chain();context.workflow.nodes[1]!.kind='assigner'
    context.workflow.nodes[1]!.config={assignments:[{name:'count',operation:'set',value:1},{name:'next',operation:'set',value:'{{vars.count}}'}]}
    context.workflow.nodes[2]!.config.text='{{vars.next}}'
    expect(planningContextSlice(context,selection)).toMatchObject({conservative:false,readNodeIds:['n0','n1','n2']})
    context.workflow.nodes[1]!.config.assignments!.reverse()
    expect(planningContextSlice(context,selection).conservative).toBe(true)
  })
  it.each(['{{inputs[selector]}}','{{n0.text + missing}}','{{n0.text}} {{missing.value}}','{{sys.timestamp}} broken {{','{{system.timestamp}}'])(
    'retains full conservative coverage for unresolved expression %s',text=>{
      const slice=planningContextSlice(chain(text),selection)
      expect(slice.conservative).toBe(true);expect(slice.readNodeIds).toHaveLength(30)
      expect(slice.editableNodeIds).toEqual(['n2'])
    },
  )
  it('returns contracts for non-targets on fallback, retaining target config and declared outputs/ports',()=>{
    const context=chain('{{inputs[selector]}}'),prompt='PRIVATE_PROMPT'.repeat(1000)
    context.workflow.nodes[28]!.kind='classifier'
    context.workflow.nodes[28]!.config={prompt,classes:[{id:'yes',label:'Yes',description:prompt},{id:'no',label:'No'}]}
    context.workflow.nodes[29]!.kind='code'
    context.workflow.nodes[29]!.config={code:'PRIVATE_CODE'.repeat(1000),outputSchema:[{name:'total',type:'number',description:prompt,required:true}]}
    context.workflow.nodes[2]!.config.prompt='TARGET_PROMPT'
    const reader=new PlanningContextReader(context,{scopeIdentity:'audit'}),result=reader.read({nodeIds:['n2'],selection})
    expect(result.conservative).toBe(true);expect(result.nodes).toHaveLength(30)
    const classifier=result.nodes.find(node=>node.key==='n29')!,code=result.nodes.find(node=>node.key==='n30')!
    expect(classifier).toMatchObject({nodeId:'n28',number:'a-29',kind:'classifier',title:'node28',contractOnly:true,ports:['yes','no'],config:{}})
    expect(code).toMatchObject({nodeId:'n29',outputs:{total:'number'},ports:['default'],config:{}})
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PROMPT');expect(JSON.stringify(result)).not.toContain('PRIVATE_CODE')
    expect(result.nodes.find(node=>node.key==='n3')!.config).toEqual({text:'X'.repeat(1000)})
    const full=reader.read({nodeIds:['n2']})
    expect(full.nodes.find(node=>node.key==='n3')!.config).toEqual(context.workflow.nodes[2]!.config)
    expect(full.nodes.find(node=>node.key==='n3')).not.toHaveProperty('contractOnly')
    const fullBytes=bytes({...result,nodes:authoringGraphContext(context)})
    expect(bytes(result)).toBeLessThan(fullBytes*0.25)
    console.info('conservative context bytes',JSON.stringify({nodes:result.nodes.length,contracts:bytes(result),fullSnapshot:fullBytes}))
    classifier.title='mutated';expect(reader.read({nodeIds:['n2'],selection}).nodes.find(node=>node.key==='n29')!.title).toBe('node28')
  })
})

describe('shared audit: fallback contract summaries use runtime output types',()=>{
  it('keeps wrapper types over same-named declarations',()=>{
    const context=chain('{{inputs[selector]}}')
    context.workflow.nodes[27]!.kind='human'
    context.workflow.nodes[27]!.config={prompt:'p',fields:[{name:'text',label:'T',type:'number',required:true}],actions:[{id:'ok',label:'OK'}]}
    context.workflow.nodes[28]!.kind='llm'
    context.workflow.nodes[28]!.config={prompt:'p',model:{provider:'offline',model:'x'},outputSchema:[{name:'json',type:'number',required:true},{name:'score',type:'number',required:true}]}
    const result=read(context)
    expect(result.conservative).toBe(true)
    expect(result.nodes.find(node=>node.nodeId==='n27')).toMatchObject({contractOnly:true,outputs:{text:'string'}})
    expect(result.nodes.find(node=>node.nodeId==='n28')).toMatchObject({contractOnly:true,outputs:{text:'string',json:'object',score:'number'}})
  })
})
