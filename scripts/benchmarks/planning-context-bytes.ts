/** Materialized local context/schema bytes. No provider SDK request or model execution. */
import { createHash } from 'node:crypto'
import { existsSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs'
import { dirname,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TemplateFillingCompiler } from '../../src/shared/planning-template-compiler.ts'
import { authoringContext } from '../../src/shared/planning-authoring-context.ts'
import { createNodeSearchBenchmarkFixture } from './planning-node-search.ts'
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value))
const sha=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex')
const defaults=`${process.env.HOME}/.dsh/profiles/desktop/node_modules/dsh-visible-dynamic-workflows/lib/compiler.js`
export async function planningContextByteEvidence(baselinePath=defaults){
  const prefetch=['input','output','template','llm','http','code'],base=createNodeSearchBenchmarkFixture()
  const available=existsSync(baselinePath),baseline=available?await import(pathToFileURL(baselinePath).href):undefined
  const sources=['src/shared/planning-authoring-context.ts','src/shared/planning-template-compiler.ts','src/shared/planning-context-slice.ts'].map(path=>({path,sha256:sha(resolve(path))}))
  const oldFiles=available?[baselinePath,...[...readFileSync(baselinePath,'utf8').matchAll(/from ["'](\.\/[^"']+)["']/g)].map(match=>resolve(dirname(baselinePath),match[1]!))].filter(existsSync).map(path=>({path,sha256:sha(path)})):[]
  const cases=[{id:'one-target-text',ids:['calc-total']},{id:'twelve-targets-text',ids:['clean-orders','summarize-stock','save-summary-a','check-amount','build-daily','format-output','filter-empty','parse-csv','calc-total','deduplicate','exchange','merge-lines']}].map(item=>{
    const context=structuredClone(base);context.targetNodeIds=item.ids;context.contextSelection={targetNodeIds:item.ids,targetFields:Object.fromEntries(item.ids.map(id=>[id,['text']]))}
    const currentCompiler=new TemplateFillingCompiler(context,{prefetch}),currentContext=authoringContext(context,'仅修改指定节点的 text 字段，保留其他字段与身份。')
    const current={context:currentContext,modelSchema:currentCompiler.nextSchema,nativeTerminalSchema:currentCompiler.schema}
    const priorCompiler=baseline?new baseline.TemplateFillingCompiler(context,{prefetch}):undefined
    const prior=baseline?{context:baseline.authoringContext(context,'仅修改指定节点的 text 字段，保留其他字段与身份。'),modelSchema:priorCompiler.nextSchema,nativeTerminalSchema:priorCompiler.schema}:undefined
    const count=(value:any)=>({graphNodes:value.context.graph?.nodes.length??0,contextBytes:bytes(value.context),modelSchemaBytes:bytes(value.modelSchema),nativeTerminalSchemaBytes:bytes(value.nativeTerminalSchema)})
    return {id:item.id,targetCount:item.ids.length,hostGraphNodes:31,prefetch,counts:{current:count(current),...(prior?{installedBaseline:count(prior)}:{})},current,...(prior?{installedBaseline:prior}:{})}
  })
  return {protocolVersion:1,generatedAt:new Date().toISOString(),scope:'materialized-local-json-only',modelCalls:0,baseline:{available,path:baselinePath,kind:available?'actual-read-only-installed-compiler':'unavailable-no-reconstructed-baseline',files:oldFiles,limitation:'安装包来源记录不证明当前运行Host的模式；本次仅导入其纯compiler API计算相同合成输入。'},currentSources:sources,cases,
    limit:'只比较相同31节点合成图与相同预取列表。nativeTerminalSchema为注册工具固定上界；modelSchema为nextSchema本地序列化。没有新的SDK端点请求，因此不证明实际发送字节、模型往返、耗时或供应商KV缓存。'}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const report=await planningContextByteEvidence(process.argv[2]??defaults),directory=resolve('docs/evidence/planning-speed-20261019')
  mkdirSync(directory,{recursive:true});writeFileSync(resolve(directory,'context-schema-bytes.json'),JSON.stringify(report,null,2)+'\n')
  const rows=report.cases.map(item=>{const current=item.counts.current,old=item.counts.installedBaseline;return `| ${item.id} | ${old?.graphNodes??'未知'} / ${current.graphNodes} | ${old?.contextBytes??'未知'} / ${current.contextBytes} | ${old?.modelSchemaBytes??'未知'} / ${current.modelSchemaBytes} | ${old?.nativeTerminalSchemaBytes??'未知'} / ${current.nativeTerminalSchemaBytes} |`}).join('\n')
  writeFileSync(resolve(directory,'context-schema-bytes.md'),`# 当前切片与Schema本地字节对照\n\n1、来源边界\n\n${report.baseline.available?'旧侧为只读导入已安装包的实际纯 compiler API，入口与依赖文件 SHA256 已记入原始JSON；新侧为当前源码。':'未找到旧包，旧侧保持未知，不重建历史算法作为真实基线。'}两侧使用相同31节点合成图、相同目标与预取列表。完整Host图均保留31节点，未执行模型或业务工具。\n\n2、结果\n\n各单元格顺序为旧安装包／当前源码；字节为UTF-8序列化长度。\n\n| 场景 | 模型上下文节点数 | 上下文JSON字节 | model nextSchema字节 | 固定native terminalSchema字节 |\n| --- | --- | --- | --- | --- |\n${rows}\n\n3、解释与限制\n\n同类型text修改的当前nextSchema不包含未查询的换型分支。旧侧与新侧均为真实API构造结果，原始context/schema完整保存在 [context-schema-bytes.json](./context-schema-bytes.json)。当前native terminalSchema仍保留Host最终校验所用的固定上界；其字节不等于模型看到的nextSchema。这里没有发起新的SDK端点请求，不能声称实际发送量、模型耗时或供应商KV缓存已验证；安装包也不证明正在运行的Host选择了哪个模式。\n\n4、复现\n\n\`pnpm --config.verify-deps-before-run=false exec node --import tsx scripts/benchmarks/planning-context-bytes.ts\`\n`)
  console.log(JSON.stringify({baseline:report.baseline,cases:report.cases.map(({id,counts})=>({id,counts})),limit:report.limit},null,2))
}
