import { BUILTIN_TOOLS } from '../shared/builtin-tools.ts'
import { nodePorts, branchTop, nodeSize } from '../shared/canvas-layout.ts'
export { isModelNode, isContainer, nodePorts, branchTop, nodeSize } from '../shared/canvas-layout.ts'
import { newId, NODE_LABELS, type NodeKind, type NodeConfig, type NodeGraph, type WorkflowNode } from '../shared/types.ts'
import { t } from './i18n.ts'
export interface NodeDefinition { kind:NodeKind; group:string; icon:string; color:string; description:string }
export const NODE_DEFINITIONS:NodeDefinition[]=[
 {kind:'agent',group:'基础',icon:'✦',color:'violet',description:'根据任务自主选择已授权工具，在限定步骤内完成任务。'},
 {kind:'llm',group:'基础',icon:'✧',color:'blue',description:'默认使用 DSH 已配置的模型，也可为此节点指定模型；结合角色提示词和输入生成内容。'},
 {kind:'knowledge',group:'基础',icon:'▤',color:'green',description:'从指定的知识来源检索相关片段，供下游模型引用。'},
 {kind:'output',group:'基础',icon:'↗',color:'orange',description:'声明流程结果并输出内容。其他并行分支继续执行。'},
 {kind:'classifier',group:'问题理解',icon:'⑂',color:'blue',description:'通过模型理解输入，并路由到一个匹配的问题类别。'},
 {kind:'if',group:'逻辑',icon:'⑂',color:'cyan',description:'按顺序检查条件组，执行第一个匹配分支或 ELSE。'},
 {kind:'human',group:'逻辑',icon:'♙',color:'green',description:'暂停运行，等待用户填写表单并选择后续行动。'},
 {kind:'iteration',group:'逻辑',icon:'▣',color:'violet',description:'遍历输入数组，对每一项运行内部流程并收集输出。'},
 {kind:'loop',group:'逻辑',icon:'↻',color:'violet',description:'重复执行内部流程，直到条件成立或达到次数上限。'},
 {kind:'code',group:'转换',icon:'{ }',color:'blue',description:'用 JavaScript 或 Python 处理具名输入，返回结构化结果。'},
 {kind:'template',group:'转换',icon:'⊞',color:'blue',description:'用模板和变量将上游数据转换为文本。'},
 {kind:'aggregator',group:'转换',icon:'⋈',color:'cyan',description:'合并互斥分支，取实际执行分支的变量值。'},
 {kind:'document',group:'转换',icon:'▤',color:'green',description:'从一个或多个文档提取文字，保留输入文件顺序。'},
 {kind:'assigner',group:'转换',icon:'≔',color:'cyan',description:'设置或更新运行变量，用于传递状态或控制循环。'},
 {kind:'extractor',group:'转换',icon:'⊡',color:'blue',description:'使用模型从文本中提取符合指定类型的参数。'},
 {kind:'http',group:'工具',icon:'⊕',color:'orange',description:'发送普通 HTTP 请求，或通过受保护凭据代理执行固定操作。'},
 {kind:'list',group:'工具',icon:'≡',color:'cyan',description:'过滤、排序和截取数组，输出列表及首尾记录。'},
 {kind:'input',group:'开始',icon:'▷',color:'blue',description:'定义执行时的输入字段，缺少必填信息时询问用户。'},
 {kind:'tool',group:'工具',icon:'⚒',color:'orange',description:'运行宿主中可用的具体工具操作，参数由工具定义。'},
 {kind:'exit_loop',group:'逻辑',icon:'⇥',color:'violet',description:'退出当前循环，将控制权交回容器外的下一步。'},
]
export const definition=(kind:NodeKind)=>{const value=NODE_DEFINITIONS.find(d=>d.kind===kind)!;return {...value,group:t(value.group),description:t(value.description)}}
export function initialConfig(kind:NodeKind):NodeConfig {
 switch(kind){
 case 'input':return {fields:[{name:'text',label:'输入文本',required:true,type:'paragraph'}]}
 case 'llm':return {prompt:'请处理以下内容：\n{{input.text}}'}
 case 'agent':return {prompt:'完成以下任务：\n{{input.text}}',tools:[],maxSteps:6}
 case 'knowledge':return {query:'{{input.text}}',sources:[],topK:3,threshold:0}
 case 'classifier':return {prompt:'{{input.text}}',classes:[{id:'class_1',label:'类别 1',description:''},{id:'class_2',label:'类别 2',description:''}]}
 case 'if':return {cases:[{id:'true',logic:'and',conditions:[{variable:'input.text',operator:'not_empty'}]}]}
 case 'human':return {prompt:'请检查以下内容后继续。\n{{input.text}}',fields:[{name:'feedback',label:'修改意见',required:false,type:'paragraph'}],actions:[{id:'approve',label:'通过'},{id:'revise',label:'需要修改'}],timeoutSeconds:259200}
 case 'iteration':{const body=initialBody('{{item}}');return {iterator:'input.items',body,outputVariable:`${body.nodes.at(-1)!.id}.text`,errorMode:'terminate',parallel:false,concurrency:1}}
 case 'loop':return {body:initialBody('{{vars.count}}'),initialVariables:{count:0},maxIterations:10,until:{variable:'vars.count',operator:'gte',value:'10'}}
 case 'exit_loop':return {}
 case 'code':return {language:'javascript',inputs:{text:'{{input.text}}'},code:'function main(inputs) {\n  return { result: inputs.text };\n}',outputSchema:[{name:'result',type:'string',required:true}],timeoutMs:3000}
 case 'template':return {text:'{{input.text}}',inputs:{}}
 case 'aggregator':return {groups:[{name:'output',variables:['input.text']}]}
 case 'document':return {source:'{{input.file}}',documentMode:'local'}
 case 'assigner':return {assignments:[{name:'count',operation:'add',value:1}]}
 case 'extractor':return {prompt:'从以下内容提取指定参数：\n{{input.text}}',parameters:[{name:'result',type:'string',description:'需要提取的内容',required:true}]}
 case 'http':return {method:'GET',url:'',headers:{},bodyText:'',timeoutMs:10000}
 case 'list':return {listSource:'input.items',limit:20}
 case 'tool':return {toolId:'',inputs:{}}
 case 'output':return {text:'{{input.text}}',outputName:'result'}
 }
}
export function newNode(kind:NodeKind,x=90,y=160,config?:NodeConfig):WorkflowNode{return{id:newId(),number:'u-1',kind,title:NODE_LABELS[kind],x,y,fixed:false,config:config||initialConfig(kind)}}
function initialBody(text:string):NodeGraph {const a=newNode('input',70,100,{fields:[]}),b=newNode('template',390,100,{text}),c=newNode('output',710,100,{text:`{{${b.id}.text}}`,outputName:'result'});return{nodes:[a,b,c],edges:[{id:newId(),source:a.id,target:b.id},{id:newId(),source:b.id,target:c.id}]}}
export function nodeSummary(n:WorkflowNode):string{
 const c=n.config
 switch(n.kind){
 case 'input':return c.fields?.map(f=>`${f.label}${f.required?' *':''}`).join(' · ')||t('无额外输入','No additional inputs')
 case 'llm':return c.prompt||t('填写任务提示词','Enter a task prompt')
 case 'agent':return t('{count} 个工具 · 最多 {steps} 步','{count} tools · up to {steps} steps',{count:c.tools?.length||0,steps:c.maxSteps||6})
 case 'knowledge':return t('{count} 个来源 · Top {top}','{count} sources · Top {top}',{count:c.sources?.length||0,top:Math.min(c.topK||3,20)})
 case 'classifier':return t('{count} 个分类 · {prompt}','{count} classes · {prompt}',{count:c.classes?.length||0,prompt:c.prompt||t('配置输入','Configure input')})
 case 'if':return c.logicGate?t('{gate} · {count} 个输入','{gate} · {count} inputs',{gate:c.logicGate.operator,count:c.logicGate.inputs.length}):c.cases?.map(c=>c.conditions.map(v=>v.variable).join(c.logic==='or'?' / ':' & ')).join(' · ')||c.variable||t('配置判断条件','Configure conditions')
 case 'human':return c.prompt||t('等待用户确认','Awaiting user confirmation')
 case 'iteration':return `${c.iterator||t('选择数组','Select an array')} · ${c.parallel?t('并行','Parallel'):t('顺序','Sequential')}`
 case 'loop':return t('最多 {count} 次 · {condition}','Up to {count} iterations · {condition}',{count:c.maxIterations||10,condition:c.until?.variable||t('配置退出条件','Configure exit condition')})
 case 'exit_loop':return t('退出当前循环','Exit current loop')
 case 'code':return `${c.language==='python'?'Python':'JavaScript'} · ${Object.keys(c.inputs||{}).join(', ')||t('定义输入变量','Define inputs')}`
 case 'aggregator':return t('{count} 组 · 互斥分支汇合','{count} groups · exclusive branch merge',{count:c.groups?.length||0})
 case 'document':return `${c.documentMode==='agent'?'Agent':c.documentMode==='tool'?t('指定工具'):t('轻量本地')} · ${c.source||t('选择文件变量','Select a file variable')}`
 case 'assigner':return c.assignments?.map(a=>`vars.${a.name} ${a.operation}`).join(' · ')||t('定义赋值','Define assignments')
 case 'extractor':return c.parameters?.map(p=>p.name).join(', ')||t('定义待提取参数','Define extraction fields')
 case 'http':return c.credentialOperation?t('受控凭据 · DeepSeek 账户连接检查','Protected credential · DeepSeek connection check'):`${c.method||'GET'} ${c.url||t('填写请求地址','Enter request URL')}`
 case 'list':return `${c.listSource||t('选择数组','Select an array')} · ${c.limit?t('前 {count} 项','First {count} items',{count:c.limit}):t('全部')}`
 case 'tool':{const tool=BUILTIN_TOOLS.find(tool=>tool.id===c.toolId);return tool?`${tool.providerName} / ${tool.name}`:c.toolId||t('选择工具操作')}
 default:return c.text||t('配置内容','Configure content')
 }
}
export function allNodes(graph:NodeGraph):WorkflowNode[]{return graph.nodes.flatMap(n=>[n,...(n.config.body?allNodes(n.config.body):[])])}
export function graphAt(graph:NodeGraph,path:string[]):NodeGraph {for(const id of path){const body=graph.nodes.find(n=>n.id===id)?.config.body;if(!body)return graph;graph=body}return graph}
export function replaceGraph(graph:NodeGraph,path:string[],next:NodeGraph):NodeGraph {if(!path.length)return next;return{...graph,nodes:graph.nodes.map(n=>n.id===path[0]&&n.config.body?{...n,config:{...n.config,body:replaceGraph(n.config.body,path.slice(1),next)}}:n)}}
export function portY(node:WorkflowNode,port:string){const ports=nodePorts(node),index=ports.findIndex(p=>p.id===port);return ['if','classifier','human'].includes(node.kind)?branchTop(node)+16+Math.max(0,index)*32:nodeSize(node).height/2}
/** Only dependency ancestors are available; a container's children stay in its scope. */
export function availableNodes(flow:NodeGraph,path:string[],targetId:string):WorkflowNode[]{
 const visible=new Map<string,WorkflowNode>()
 const ancestors=(graph:NodeGraph,target:string)=>{const ids=new Set<string>(),queue=[target];while(queue.length){const id=queue.pop()!;for(const edge of graph.edges.filter(e=>e.target===id))if(!ids.has(edge.source)&&edge.source!==target){ids.add(edge.source);queue.push(edge.source)}}for(const n of graph.nodes)if(ids.has(n.id))visible.set(n.id,n)}
 let graph=flow
 for(const id of path){const container=graph.nodes.find(n=>n.id===id);if(!container?.config.body)return [];ancestors(graph,id);graph=container.config.body}
 ancestors(graph,targetId)
 return [...visible.values()]
}
/** Fields come from the runtime contract or actual data, never a universal .text assumption. */
export function outputFields(node:WorkflowNode,data?:Record<string,import('../shared/types.ts').JsonValue>):string[]{
 const c=node.config
 let fields:string[]
 switch(node.kind){
 case 'code':fields=(c.outputSchema||[]).map(p=>p.name);break
 case 'tool':fields=[];break
 case 'llm':fields=['text',...(c.outputSchema||[]).map(p=>p.name)];break
 case 'agent':fields=['text','json','steps',...(c.outputSchema||[]).map(p=>p.name)];break
 case 'knowledge':fields=['text','results','result','method','count'];break
 case 'classifier':fields=['text','class_id','class_label','class_name'];break
 case 'if':fields=['text','result','branch'];break
 case 'human':fields=['text',...(c.fields||[]).map(f=>f.name),'__action_id','__action_value','__rendered_content'];break
 case 'iteration':fields=['text','result','errors'];break
 case 'loop':fields=['text','result','variables','iterations',...Object.keys(c.initialVariables||{}).map(key=>`variables.${key}`)];break
 case 'aggregator':fields=['text',...(c.groups||[]).map(g=>g.name)];break
 case 'assigner':fields=['text','variables',...(c.assignments||[]).map(a=>a.name)];break
 case 'extractor':fields=['text','__is_success','__reason',...(c.parameters||[]).map(p=>p.name)];break
 case 'http':if(c.credentialOperation)return ['ok','status_code'];fields=['text','body','bytes','status_code','headers'];break
 case 'list':fields=['text','result','first_record','last_record'];break
 case 'exit_loop':fields=[];break
 case 'input':fields=['text',...(c.fields||[]).map(f=>f.name)];break
 default:fields=['text']
 }
 return [...new Set([...fields,...Object.keys(data||{})])]
}
export function codeTimeout(language?:'javascript'|'python'){return language==='python'?10000:3000}
