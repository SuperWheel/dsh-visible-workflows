import { describe, expect, it } from 'vitest'
import { exportWorkflowJson, exportWorkflowPackage, importWorkflowJson, parseWorkflowPackage, WORKFLOW_PACKAGE_MAX_BYTES } from '../src/shared/workflow-format.ts'
import { allNodes, parseWorkflow } from '../src/shared/workflow-validation.ts'
import { makeWorkflow, NODE_LABELS, type NodeConfig, type NodeGraph, type NodeKind, type Workflow, type WorkflowNode } from '../src/shared/types.ts'

const role={id:'reviewer',name:'检查员',prompt:'检查完整性',revision:4}
const model={provider:'deepseek',model:'deepseek-chat'}
function node(kind:NodeKind,id:string,config:NodeConfig={}):WorkflowNode{return {id,kind,number:id,title:`${kind}节点`,x:-120.25+id.length,y:211.125-id.length,fixed:id.length%2===0,config}}
function connect(nodes:WorkflowNode[]):NodeGraph['edges']{return nodes.slice(0,-1).map((source,index)=>({id:`edge-${source.id}`,source:source.id,target:nodes[index+1]!.id,...(source.kind==='if'?{port:'yes'}:source.kind==='classifier'?{port:'question'}:source.kind==='human'?{port:'continue'}:{})}))}
function completeFixture():Workflow {
  const flow=makeWorkflow('original','所有节点及嵌套布局')
  const loopNodes=[node('input','loop-input',{fields:[]}),node('code','loop-code',{language:'javascript',code:'return {value: 1}',inputs:{value:'{{env.region}}'}}),node('exit_loop','loop-exit')]
  const iterationNodes=[node('input','iteration-input',{fields:[]}),node('template','iteration-template',{text:'{{item.name}} {{env.region}}'}),node('output','iteration-output',{text:'{{iteration-template.text}}',outputName:'item'})]
  flow.environmentVariables=[{id:'region',name:'REGION',type:'string',value:'cn',required:true},{id:'count',name:'COUNT',type:'number',value:3},{id:'private',name:'API_KEY',type:'secret'}]
  const llm={model,rolePresetId:role.id,prompt:'处理 {{producer.text}} / {{env.region}}',inputs:{value:'{{producer.text}}'}}
  flow.nodes=[
    node('input','start',{fields:[{name:'text',label:'文本',required:true,type:'paragraph',defaultValue:'测试'},{name:'items',label:'数组',required:false,type:'json',defaultValue:'[]'}]}),
    node('template','producer',{text:'{{input.text}} {{env.region}}',inputs:{literal:'producer.text'}}),
    node('llm','llm',{...llm,outputSchema:[{name:'answer',type:'string',required:true}]}),
    node('if','branch',{cases:[{id:'yes',logic:'and',conditions:[{variable:'producer.text',operator:'not_empty',value:'{{env.region}}'}]}]}),
    node('agent','agent',{model,prompt:llm.prompt,inputs:llm.inputs,subagentId:'worker',tools:['native:time'],maxSteps:5,timeoutMs:50000,verification:{minTextLength:2},cache:'reuse'}),
    node('knowledge','knowledge',{query:'{{producer.text}}',sources:['data/reference.txt'],topK:3,threshold:.5}),
    node('classifier','classifier',{...llm,classes:[{id:'question',label:'问题',description:'需要回答的问题'}]}),
    node('human','human',{prompt:'审核 {{producer.text}}',fields:[{name:'comment',label:'意见',required:true,defaultValue:'{{producer.text}}'}],actions:[{id:'continue',label:'继续'},{id:'reject',label:'驳回'}],timeoutSeconds:60}),
    node('iteration','iteration',{iterator:'input.items',outputVariable:'iteration-template.text',body:{nodes:iterationNodes,edges:connect(iterationNodes)},parallel:true,concurrency:3,errorMode:'remove'}),
    node('loop','loop',{body:{nodes:loopNodes,edges:connect(loopNodes)},initialVariables:{value:'{{producer.text}}'},maxIterations:3,until:{variable:'loop-code.value',operator:'gte',value:'1'},outputVariable:'loop-code.value'}),
    node('code','code',{language:'python',code:'def main(value):\n return {"text": value}',inputs:{value:'{{producer.text}}'},outputSchema:[{name:'text',type:'string'}],timeoutMs:1200}),
    node('aggregator','aggregator',{groups:[{name:'combined',variables:['producer.text','code.text']}]}),
    node('document','document',{source:'input.file',documentMode:'tool',toolId:'mcp:document',documentSourceKey:'file',documentTextPath:'data.text',inputs:{source:'{{producer.text}}'}}),
    node('assigner','assigner',{assignments:[{name:'answer',operation:'set',value:{data:'{{producer.text}}',literal:'producer.text'}}]}),
    node('extractor','extractor',{...llm,parameters:[{name:'answer',type:'string',description:'答案',required:true}]}),
    node('http','http',{url:'https://example.invalid/{{env.region}}',method:'POST',headers:{'X-Region':'{{env.region}}'},bodyText:'{{producer.text}}',timeoutMs:1000}),
    node('list','list',{listSource:'input.items',filter:{variable:'item.name',operator:'contains',value:'{{producer.text}}'},sort:'asc',limit:2}),
    node('tool','tool',{toolId:'mcp:search',inputs:{query:'{{producer.text}}'}}),
    node('output','finish',{text:'{{producer.text}} {{sys.workflow_id}}',outputName:'answer'}),
  ]
  flow.subAgents=[{id:'worker',number:'agent-1',name:'检查员',prompt:role.prompt}]
  flow.edges=connect(flow.nodes)
  flow.notes=[{id:'note',text:'画布便签',x:-300.5,y:600.125,width:360,height:220,color:'purple',anchorNodeId:'producer'}]
  flow.executionPolicy={repairMode:'confirm',maxConcurrentAgents:3,maxAgentTasks:20,tokenBudget:10000,perTaskTokens:2000,maxRepairAttempts:1}
  flow.editor={viewport:{x:-123.5,y:678.25,scale:.65},scopePath:['loop'],annotations:[{id:'annotation',number:1,text:'调整内部代码',nodeIds:['loop-code'],position:{x:12.5,y:-99.25,scopePath:['loop']}}]}
  return flow
}

/** Identity changes are intentional; restore only generated identities to compare
 * every remaining field, including all nested configs and exact coordinates. */
function restoreIdentities(imported:Workflow,original:Workflow,roles:Map<string,string>=new Map()):Workflow {
  const identities=new Map<string,string>([[imported.id,original.id],...roles])
  for(const [index,item] of allNodes(imported).entries())identities.set(item.id,allNodes(original)[index]!.id)
  const edges=(graph:NodeGraph):NodeGraph['edges']=>[...graph.edges,...graph.nodes.flatMap(item=>item.config.body?edges(item.config.body):[])]
  for(const [index,item] of edges(imported).entries())identities.set(item.id,edges(original)[index]!.id)
  for(const [index,item] of (imported.subAgents??[]).entries())identities.set(item.id,original.subAgents![index]!.id)
  for(const [index,item] of imported.notes.entries())identities.set(item.id,original.notes[index]!.id)
  for(const [index,item] of (imported.environmentVariables??[]).entries())identities.set(item.id,original.environmentVariables![index]!.id)
  for(const [index,item] of (imported.editor?.annotations??[]).entries())identities.set(item.id,original.editor!.annotations![index]!.id)
  let json=JSON.stringify(imported)
  for(const [generated,source] of identities)json=json.replaceAll(generated,source)
  const restored=JSON.parse(json) as Workflow
  restored.workspaceId=original.workspaceId;restored.createdAt=original.createdAt;restored.updatedAt=original.updatedAt;restored.revision=original.revision
  for(const [index,item] of (restored.environmentVariables??[]).entries())if(original.environmentVariables![index]!.revision===undefined)delete item.revision;else item.revision=original.environmentVariables![index]!.revision
  return restored
}

describe('portable workflow JSON roundtrip',()=>{
  it('roundtrips all 20 node kinds, nested graph configs, branch ports, precise coordinates, notes and editor context',()=>{
    const original=completeFixture(),pkg=exportWorkflowPackage(original,{includeEnvironmentValues:true,presets:[role]})
    expect(new Set(allNodes(original).map(item=>item.kind))).toEqual(new Set(Object.keys(NODE_LABELS)))
    const imported=importWorkflowJson(JSON.stringify(pkg),'target')
    expect(restoreIdentities(imported.workflow,pkg.workflow,new Map([[imported.presets[0]!.id,role.id]]))).toEqual(pkg.workflow)
    expect(imported.workflow.editor?.viewport).toEqual(original.editor?.viewport)
    expect(imported.workflow.editor?.annotations?.[0]?.position?.scopePath).toEqual([imported.workflow.nodes.find(item=>item.kind==='loop')!.id])
    expect(imported.presets[0]!.prompt).toBe(role.prompt)
  })
  it('keeps environment, node, workflow and role identity spaces separate even when their IDs collide',()=>{
    const flow=makeWorkflow('original',undefined,true),producer=flow.nodes[1]!
    flow.id='same';producer.id='same';flow.edges[0]!.target='same';flow.edges[1]!.source='same'
    producer.kind='llm';producer.config={prompt:'{{env.env}} {{env.same}} {{env.sys}} {{input.same.value}}',rolePresetId:'same'}
    flow.environmentVariables=[{id:'env',name:'ENVIRONMENT',type:'string',value:'a'},{id:'same',name:'VALUE',type:'string',value:'b'},{id:'sys',name:'SYSTEM',type:'string',value:'c'}]
    flow.nodes[2]!.config.text='{{same.env.same}} {{env.same}} {{sys.workflow_id}}'
    const imported=importWorkflowJson(exportWorkflowJson(flow,{includeEnvironmentValues:true,presets:[{...role,id:'same'}]}),'target')
    const next=imported.workflow,env=next.environmentVariables!,agent=next.nodes[1]!
    expect(new Set([next.id,agent.id,env[1]!.id,imported.presets[0]!.id]).size).toBe(4)
    expect(agent.config.rolePresetId).toBe(imported.presets[0]!.id)
    expect(agent.config.prompt).toBe(`{{env.${env[0]!.id}}} {{env.${env[1]!.id}}} {{env.${env[2]!.id}}} {{input.same.value}}`)
    expect(next.nodes[2]!.config.text).toBe(`{{${agent.id}.env.same}} {{env.${env[1]!.id}}} {{sys.workflow_id}}`)
  })
  it('rewrites bare and bracket references while preserving template local scopes and quoted literal data',()=>{
    const flow=makeWorkflow('original',undefined,true),producer=flow.nodes[1]!
    producer.id='producer';flow.edges[0]!.target='producer';flow.edges[1]!.source='producer'
    producer.config={text:'producer.text',inputs:{literal:'producer.text'}}
    const output=flow.nodes[2]!;output.kind='template';output.config={text:`{{producer["text"]}} {{producer}} {{input.producer.text}} {% for producer in input.items %}{{producer.text}}{% else %}{{producer.text}}{% endfor %} {{producer.text}} {{"producer.text"}} {# {{producer.text}} #}`}
    const imported=importWorkflowJson(exportWorkflowJson(flow),'target').workflow,id=imported.nodes[1]!.id
    expect(imported.nodes[2]!.config.text).toBe(`{{${id}["text"]}} {{${id}}} {{input.producer.text}} {% for producer in input.items %}{{producer.text}}{% else %}{{${id}.text}}{% endfor %} {{${id}.text}} {{"producer.text"}} {# {{producer.text}} #}`)
    output.config.inputs={producer:'{{producer.text}}'};output.config.text='{{producer.text}}'
    const local=importWorkflowJson(exportWorkflowJson(flow),'target').workflow
    expect(local.nodes[2]!.config.text).toBe('{{producer.text}}')
    expect(local.nodes[2]!.config.inputs?.producer).toBe(`{{${local.nodes[1]!.id}.text}}`)
  })
  it('uses template comment/local rules only in template text, while simple prompt interpolation remains active',()=>{
    const flow=makeWorkflow('original',undefined,true),producer=flow.nodes[1]!
    producer.id='producer';flow.edges[0]!.target='producer';flow.edges[1]!.source='producer'
    flow.nodes[2]!.kind='agent';flow.nodes[2]!.config={prompt:'{# {{producer.text}} #} {% for producer in input.items %}{{producer.text}}{% endfor %}',inputs:{literal:'{% if producer.text %}',data:'{# {{producer.text}} #}'},tools:[]}
    const imported=importWorkflowJson(exportWorkflowJson(flow),'target').workflow,id=imported.nodes[1]!.id
    expect(imported.nodes[2]!.config.prompt).toBe(`{# {{${id}.text}} #} {% for producer in input.items %}{{${id}.text}}{% endfor %}`)
    expect(imported.nodes[2]!.config.inputs).toEqual({literal:'{% if producer.text %}',data:`{# {{${id}.text}} #}`})
  })
  it('enforces the same UTF-8 size and JSON-depth constraints before export and import',()=>{
    const flow=makeWorkflow('original'),text='中'.repeat(200000)
    flow.nodes=[flow.nodes[0]!,...Array.from({length:14},(_,index)=>node('template',`large-${index}`,{text})),flow.nodes[1]!];flow.edges=connect(flow.nodes)
    expect(()=>exportWorkflowJson(flow)).toThrow('8 MB')
    expect(()=>exportWorkflowPackage(flow)).toThrow('8 MB')
    expect(()=>parseWorkflowPackage(' '.repeat(WORKFLOW_PACKAGE_MAX_BYTES+1))).toThrow('8 MB')
    const small=makeWorkflow('original',undefined,true)
    let deep:any='value';for(let at=0;at<35;at++)deep={nested:deep}
    small.nodes[1]!.config.inputs={deep}
    expect(()=>exportWorkflowJson(small)).toThrow('嵌套')
    expect(()=>parseWorkflowPackage('['.repeat(34)+'0'+']'.repeat(34))).toThrow('嵌套')
  })
  it('rejects broken graph export and forged editor fields without treating incomplete node config as corruption',()=>{
    const flow=makeWorkflow('original')
    flow.edges[0]!.target='missing'
    expect(()=>exportWorkflowJson(flow)).toThrow('连线引用')
    const valid=makeWorkflow('original');valid.nodes[1]!.kind='http';valid.nodes[1]!.config={}
    expect(importWorkflowJson(exportWorkflowJson(valid),'target').workflow.nodes[1]!.kind).toBe('http')
    expect(()=>parseWorkflow({...valid,editor:{annotations:[{id:'note',number:1,text:'说明',nodeIds:['missing']}]}})).toThrow('批注引用')
    expect(()=>parseWorkflow({...valid,editor:{scopePath:[valid.nodes[0]!.id]}})).toThrow('容器')
    expect(()=>parseWorkflow({...valid,editor:{viewport:{x:0,y:0,scale:8}}})).toThrow()
    expect(()=>parseWorkflow({...valid,editor:{annotations:[{id:'note',number:1,text:'说明',nodeIds:[],receipt:'forged'}]}})).toThrow()
  })
})

describe('portable workflow dependency bundles',()=>{
  function caller(title:string):Workflow{const flow=makeWorkflow('original',title,true);flow.nodes[1]!.kind='agent';flow.nodes[1]!.config={prompt:'执行',tools:[]};return flow}
  it('bundles the reachable dependency closure once and remaps each workflow target atomically',()=>{
    const root=caller('root'),left=caller('left'),right=caller('right'),shared=caller('shared'),unrelated=caller('unrelated')
    root.nodes[1]!.config.tools=[`workflow:${left.id}`,`workflow:${right.id}`]
    left.nodes[1]!.config.tools=[`workflow:${shared.id}`]
    right.nodes[1]!.kind='tool';right.nodes[1]!.config={toolId:`workflow:${shared.id}`,inputs:{}}
    shared.nodes[1]!.kind='document';shared.nodes[1]!.config={source:'input.text',documentMode:'agent',prompt:'{{env.secret_name}}',tools:['missing:tool'],rolePresetId:'missing-role'}
    shared.environmentVariables=[{id:'secret_name',name:'LABEL',type:'string',required:true}]
    const pkg=exportWorkflowPackage(root,{workflows:[root,left,right,shared,unrelated]})
    expect(pkg.formatVersion).toBe(2);expect(pkg.workflows.map(flow=>flow.title)).toEqual(['left','shared','right'])
    expect(pkg.dependencies.some(item=>item.id==='missing-role')).toBe(true)
    const imported=importWorkflowJson(JSON.stringify(pkg),'target'),byTitle=new Map([imported.workflow,...imported.workflows].map(flow=>[flow.title,flow]))
    expect(imported.workflows).toHaveLength(3)
    expect(imported.workflow.nodes[1]!.config.tools).toEqual([`workflow:${byTitle.get('left')!.id}`,`workflow:${byTitle.get('right')!.id}`])
    expect(byTitle.get('left')!.nodes[1]!.config.tools).toEqual([`workflow:${byTitle.get('shared')!.id}`])
    expect(byTitle.get('right')!.nodes[1]!.config.toolId).toBe(`workflow:${byTitle.get('shared')!.id}`)
    expect(byTitle.get('shared')!.nodes[1]!.config.rolePresetId).toBe('missing-role')
    expect(imported.warnings.join('\n')).toContain('缺少角色预设')
    expect([imported.workflow,...imported.workflows].every(flow=>flow.workspaceId==='target')).toBe(true)
  })
  it('keeps unresolved current targets and rejects v1 without migration',()=>{
    const root=caller('root');root.nodes[1]!.config.tools=['workflow:missing-target']
    const v2=exportWorkflowPackage(root)
    const {workflows:_,...legacy}=v2
    const imported=importWorkflowJson(JSON.stringify(v2),'target')
    expect(imported.workflows).toEqual([])
    expect(imported.workflow.nodes[1]!.config.tools).toEqual(['workflow:missing-target'])
    expect(()=>parseWorkflowPackage(JSON.stringify({...legacy,formatVersion:1}))).toThrow('仅支持当前 formatVersion: 2')
    expect(()=>importWorkflowJson(JSON.stringify({...v2,formatVersion:1}),'target')).toThrow('仅支持当前 formatVersion: 2')
  })
  it('rejects dependency cycles, duplicate workflow identities and duplicate embedded roles',()=>{
    const root=caller('root'),child=caller('child')
    root.nodes[1]!.config.tools=[`workflow:${child.id}`];child.nodes[1]!.config.tools=[`workflow:${root.id}`]
    expect(()=>exportWorkflowPackage(root,{workflows:[child]})).toThrow('循环调用')
    child.nodes[1]!.config.tools=[]
    const pkg=exportWorkflowPackage(root,{workflows:[child]})
    expect(()=>parseWorkflowPackage(JSON.stringify({...pkg,workflows:[...pkg.workflows,...pkg.workflows]}))).toThrow('重复的工作流身份')
    expect(()=>parseWorkflowPackage(JSON.stringify({...pkg,presets:[role,role]}))).toThrow('角色预设身份重复')
  })
})
