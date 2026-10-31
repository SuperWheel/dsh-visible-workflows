/** Offline S08 baseline. Synthetic graph only; no model, runtime, UI or business tools. */
import { mkdirSync,writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import type { PlanningContext } from '../../src/shared/planning-types.ts'
import type { NodeGraph,WorkflowNode } from '../../src/shared/types.ts'
import { allNodes } from '../../src/shared/workflow-validation.ts'
import { authoringGraphContext } from '../../src/shared/planning-authoring-context.ts'
import { PlanningContextReader,type PlanningNodeQuery } from '../../src/shared/planning-context-reader.ts'

const node=(id:string,title:string,kind:WorkflowNode['kind']='template',config:WorkflowNode['config']={text:'固定说明 '.repeat(30)}):WorkflowNode=>({id,title,kind,config,number:'999',x:0,y:0,fixed:false})
export function createNodeSearchBenchmarkFixture():PlanningContext {
  const titles=[['clean-orders','清洗订单'],['summarize-stock','汇总库存'],['save-summary-a','保存结果'],['check-amount','校验金额'],['build-daily','生成日报'],['format-output','格式化输出'],['filter-empty','过滤缺失记录'],['parse-csv','解析CSV'],['calc-total','计算总额'],['deduplicate','去重订单'],['exchange','汇率换算'],['merge-lines','合并明细']]
  let body:NodeGraph={nodes:[node('deep-check','深层校验'),node('deep-save','保存结果'),node('invoice-check','发票异常检查'),node('deep-format','深层格式化'),node('deep-clean','深层清洗'),node('deep-total','深层汇总'),node('deep-review','深层复核'),node('deep-typed','结构化结果','code',{language:'javascript',code:'return {count: 1}',inputs:{},outputSchema:[{name:'count',type:'number',required:true}]}),node('deep-final','深层最终结果')],edges:[]}
  for(let depth=5;depth>=1;depth--)body={nodes:[node(`scope-${depth}`,`容器${depth}`,'loop',{maxIterations:1,initialVariables:{},outputVariable:'deep-final.text',body})],edges:[]}
  const nodes=[node('start','库存输入','input',{fields:[{name:'stock',label:'库存',required:true}]}),...titles.map(([id,title])=>node(id!,title!)),node('read-file','读取库存文件','tool',{toolId:'native:read-json',inputs:{path:'inventory.json'}}),node('save-summary-b','保存结果','tool',{toolId:'native:write-json',inputs:{path:'summary.json',text:'fixed'}}),node('route-stock','库存分支','if',{variable:'summarize-stock.text',operator:'not_empty',value:''}),...body.nodes,node('result','最终输出','output',{text:'done',outputName:'result'})]
  return {operation:'revise',targetNodeIds:[],nodeIds:[],subagentIds:[],environmentIds:[],model:{provider:'offline',model:'no-model'},tools:[],workflow:{id:'node-search-31',workspaceId:'synthetic-search',title:'31节点精确检索合成夹具',description:'只用于离线定位和上下文读取，不执行',revision:7,createdAt:'2026-10-19T00:00:00.000Z',updatedAt:'2026-10-19T00:00:00.000Z',nodes,edges:[],notes:[]}}
}
interface FixedQuery {id:string;query:PlanningNodeQuery;expectedIds:string[];ambiguous?:boolean;limitation?:string}
export const NODE_SEARCH_QUERIES:readonly FixedQuery[]=[
  {id:'stable-id',query:{nodeId:'calc-total'},expectedIds:['calc-total']},
  {id:'chinese-title',query:{query:'汇总库存'},expectedIds:['summarize-stock']},
  {id:'duplicate-title',query:{query:'保存结果'},expectedIds:['save-summary-a','save-summary-b','deep-save'],ambiguous:true},
  {id:'deep-container-title',query:{query:'保存结果',containerId:'scope-5'},expectedIds:['deep-save']},
  {id:'tool-id',query:{kind:'tool',toolId:'native:read-json'},expectedIds:['read-file']},
  {id:'field-and-container',query:{field:'outputSchema',containerId:'scope-5'},expectedIds:['deep-typed']},
  {id:'ancestor-container',query:{query:'深层最终结果',containerId:'scope-1'},expectedIds:['deep-final']},
  {id:'container-id',query:{nodeId:'scope-3'},expectedIds:['scope-3']},
  {id:'chinese-deep-title',query:{query:'发票异常检查'},expectedIds:['invoice-check']},
  {id:'display-number-is-not-id',query:{nodeId:'999'},expectedIds:[]},
  {id:'deleted-id',query:{nodeId:'deleted-node'},expectedIds:[]},
  {id:'semantic-paraphrase',query:{query:'把库存落盘'},expectedIds:[],limitation:'自然语言同义改写不保证召回；需名称、工具ID、字段、容器或稳定ID确认。'},
  {id:'duplicate-plus-kind',query:{query:'保存结果',kind:'tool'},expectedIds:['save-summary-b']},
  {id:'chinese-token-combination',query:{query:'库存 汇总'},expectedIds:['summarize-stock']},
  {id:'container-kind-ambiguity',query:{kind:'loop'},expectedIds:['scope-1','scope-2','scope-3','scope-4','scope-5'],ambiguous:true},
]
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value))
const measure=<T>(run:()=>T)=>{const started=performance.now(),value=run();return {value,ms:performance.now()-started}}
const sameIds=(actual:readonly string[],expected:readonly string[])=>JSON.stringify([...actual].sort())===JSON.stringify([...expected].sort())
const errorText=(run:()=>unknown)=>{try{run();return undefined}catch(error){return error instanceof Error?error.message:String(error)}}
export function runNodeSearchBenchmark(){
  const context=createNodeSearchBenchmarkFixture(),construction=measure(()=>new PlanningContextReader(context,{scopeIdentity:'synthetic-search:node-search-31',contractVersion:'node-search-fixture-v1'})),reader=construction.value
  const rows=NODE_SEARCH_QUERIES.map(item=>{
    const cold=measure(()=>reader.search(item.query,7)),warm=measure(()=>reader.search(item.query,7)),ids=cold.value.candidates.map(node=>node.nodeId)
    const decision=cold.value.ambiguous?'refuse-ambiguous':ids.length===1?'one-candidate':'no-candidate'
    return {id:item.id,query:item.query,expectedIds:item.expectedIds,actualIds:ids,total:cold.value.total,correct:sameIds(ids,item.expectedIds)&&cold.value.ambiguous===!!item.ambiguous,decision,searchRounds:1,returnedBytes:bytes(cold.value),coldMs:cold.ms,warmMs:warm.ms,warmMatches:JSON.stringify(cold.value)===JSON.stringify(warm.value),...(item.limitation?{limitation:item.limitation}:{})}
  })
  const requested=['clean-orders','deep-final','deep-save'],selection={targetFields:Object.fromEntries(requested.map(id=>[id,['title']]))}
  const batch=measure(()=>reader.read({nodeIds:requested,expectedRevision:7,expectedIdentity:reader.identity,selection})),batchWarm=measure(()=>reader.read({nodeIds:requested,expectedRevision:7,expectedIdentity:reader.identity,selection}))
  const singles=measure(()=>requested.map(id=>reader.read({nodeIds:[id],expectedRevision:7,selection})))
  const stats=reader.stats(),moved=structuredClone(context),old=reader.identity
  const deep=allNodes(moved.workflow).find(n=>n.id==='scope-5')!.config.body!,target=deep.nodes.splice(deep.nodes.findIndex(n=>n.id==='deep-final'),1)[0]!
  moved.workflow.nodes.splice(moved.workflow.nodes.length-1,0,target);moved.workflow.revision=8;reader.rebind(moved)
  const movedResult=reader.search({nodeId:'deep-final'},8),oldScope=reader.search({nodeId:'deep-final',containerId:'scope-5'},8),staleIdentityError=errorText(()=>reader.read({nodeIds:['deep-final'],expectedIdentity:old}))
  moved.workflow.nodes=moved.workflow.nodes.filter(n=>n.id!=='deep-final');moved.workflow.revision=9;reader.rebind(moved)
  const deleted=reader.search({nodeId:'deep-final'},9),deletedReadError=errorText(()=>reader.read({nodeIds:['deep-final'],expectedRevision:9})),staleRevisionError=errorText(()=>reader.read({nodeIds:['clean-orders'],expectedRevision:7}))
  const supported=rows.filter(row=>!('limitation'in row)),ambiguous=rows.filter(row=>row.decision==='refuse-ambiguous')
  return {protocolVersion:1,generatedAt:new Date().toISOString(),scope:'offline-synthetic-only',fixture:{nodeCount:allNodes(context.workflow).length,maxContainerDepth:5,workflowRevision:7,duplicateTitle:'保存结果',duplicateCount:3},
    measurement:{readerConstructionMs:construction.ms,clock:'performance.now',cacheScope:'task',modelCalls:0,toolExecutions:0,uiRuns:0,notes:'单次本地基线；冷表示该查询首次本地缓存缺失，热表示同一读取器重复同一查询。不是供应商KV缓存或完整规划延迟。'},
    queries:rows,summary:{queries:rows.length,supportedQueries:supported.length,supportedCorrect:supported.filter(row=>row.correct).length,querySetCorrect:rows.filter(row=>row.correct).length,ambiguityRefusals:ambiguous.length,wrongAutomaticSelections:rows.filter(row=>row.decision==='one-candidate'&&!row.correct).length,unresolvedSemanticQueries:rows.filter(row=>'limitation'in row).length,searchRounds:rows.length,returnedBytes:rows.reduce((sum,row)=>sum+row.returnedBytes,0),coldSearchMs:rows.reduce((sum,row)=>sum+row.coldMs,0),warmSearchMs:rows.reduce((sum,row)=>sum+row.warmMs,0)},
    batch:{requestedNodeIds:requested,requestCount:requested.length,readRounds:1,returnedNodes:batch.value.nodes.length,readNodeIds:batch.value.readNodeIds,responseBytes:bytes(batch.value),nodeRowsBytes:bytes(batch.value.nodes),coldMs:batch.ms,warmMs:batchWarm.ms,fullGraphNodeRowsBytes:bytes(authoringGraphContext(context)),individualReadRounds:requested.length,individualReturnedNodes:singles.value.reduce((sum,value)=>sum+value.nodes.length,0),individualResponseBytes:singles.value.reduce((sum,value)=>sum+bytes(value),0),individualMs:singles.ms,sameDependencyUnion:sameIds(batch.value.readNodeIds,[...new Set(singles.value.flatMap(value=>value.readNodeIds))])},cache:stats,
    mutationChecks:{movedStableIdPreserved:movedResult.candidates[0]?.nodeId==='deep-final',movedScopeUpdated:movedResult.candidates[0]?.scope.length===0&&oldScope.candidates.length===0,staleIdentityRejected:!!staleIdentityError,deletedNotFound:deleted.candidates.length===0,deletedReadRejected:!!deletedReadError,staleRevisionRejected:!!staleRevisionError,errors:{staleIdentityError,deletedReadError,staleRevisionError}},
    s09Decision:{status:'evaluated-deferred',introduceVectors:false,basis:'固定集中精确与结构查询均返回预期集合，歧义均拒绝自动选择；同义改写样例明确未命中。当前单个语义缺口不足以证明向量索引可改善总体正确率或延迟，本批暂不引入。',limit:'本结果只覆盖15个固定合成查询，不代表开放语义检索或真实业务数据召回；新语义需求需另建有标注样本，再与本基线比较。'}}
}
function markdown(report:ReturnType<typeof runNodeSearchBenchmark>){
  const s=report.summary,b=report.batch
  return `# S08 精确节点检索固定基线\n\n1、范围与方法\n\n31 个合成节点，5 层容器，3 个“保存结果”重名节点；图版本为 7。只运行本地查找、依赖切片与批量读取，模型、业务工具和界面调用均为 0。本次数据是单次本地基线，不代表模型生成或完整规划提速。\n\n2、查询结果\n\n| 指标 | 结果 |\n| --- | --- |\n| 固定查询数 | ${s.queries} |\n| 精确／结构查询符合预期 | ${s.supportedCorrect}/${s.supportedQueries} |\n| 歧义拒绝自动选择 | ${s.ambiguityRefusals}/${s.ambiguityRefusals} |\n| 错误自动选择 | ${s.wrongAutomaticSelections} |\n| 明示的语义改写未命中 | ${s.unresolvedSemanticQueries} |\n| 单查询读取轮次 | 1 |\n| 冷查询总计 | ${s.coldSearchMs.toFixed(3)} ms |\n| 热查询总计 | ${s.warmSearchMs.toFixed(3)} ms |\n| 查询响应总字节 | ${s.returnedBytes} |\n\n冷／热只区分同一任务内的本地缓存；未测供应商 KV 复用。各项原始毫秒值和返回候选保存在 [node-search-results.json](./node-search-results.json)。\n\n3、批量读取与身份失效\n\n一次批量请求读取 ${b.requestCount} 个稳定 ID，返回 ${b.returnedNodes} 个节点（含容器合同），${b.responseBytes} 字节；按单节点读取为 ${b.individualReadRounds} 轮，共返回 ${b.individualReturnedNodes} 行、${b.individualResponseBytes} 字节。两种读取的依赖并集一致。批量冷读 ${b.coldMs.toFixed(3)} ms、热读 ${b.warmMs.toFixed(3)} ms；单节点分读合计 ${b.individualMs.toFixed(3)} ms，不以单次微小耗时差宣称稳定加速。\n\n移动保留稳定 ID 并更新容器范围，删除不返回旧节点；旧版本与旧内容身份均被拒绝。完整 Host 图与最终校验不由切片替代。\n\n4、S09 决定\n\n评估完成，本批暂不引入向量索引。14 项精确／结构查询均符合固定预期，2 项歧义均明确拒绝自动选择；“把库存落盘”没有命中，不将其假装成成功的语义检索。一个语义改写缺口不足以证明新索引能提升总体正确率或延迟。当前需要名称、工具 ID、字段、容器或稳定 ID 确认目标；后续若真实查询持续出现语义缺口，再用有标注样本比较召回、误选、维护与延迟成本。\n\n5、复现\n\n\`pnpm --config.verify-deps-before-run=false exec node --import tsx scripts/benchmarks/planning-node-search.ts\`\n`
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const report=runNodeSearchBenchmark(),directory=resolve(process.argv[2]??'docs/evidence/planning-speed-20261019')
  mkdirSync(directory,{recursive:true});writeFileSync(resolve(directory,'node-search-results.json'),JSON.stringify(report,null,2)+'\n');writeFileSync(resolve(directory,'node-search-baseline.md'),markdown(report))
  console.log(JSON.stringify({summary:report.summary,batch:report.batch,mutationChecks:report.mutationChecks,s09Decision:report.s09Decision},null,2))
  if(report.summary.supportedCorrect!==report.summary.supportedQueries||report.summary.wrongAutomaticSelections||!report.batch.sameDependencyUnion||Object.entries(report.mutationChecks).some(([key,value])=>key!=='errors'&&value!==true))process.exitCode=1
}
