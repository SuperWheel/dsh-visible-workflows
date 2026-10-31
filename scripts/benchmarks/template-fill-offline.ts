/** Offline preparation cost only. Never calls a provider or executes a workflow. */
import { writeFileSync } from 'node:fs'
import { cases,contextFor } from './workflow-compiler.ts'
import { WorkflowAuthoringCompiler } from '../../src/shared/planning-authoring.ts'
import { TemplateFillingCompiler } from '../../src/shared/planning-template-compiler.ts'
import { authoringContext } from '../../src/shared/planning-authoring-context.ts'
import { planningTemplateCatalog,prefetchedTemplateIds,templateAuthoringContext } from '../../src/host/planning/template-catalog.ts'

const median=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(values.length/2);return sorted.length%2?sorted[middle]!:(sorted[middle-1]!+sorted[middle]!)/2}
const records=[]
for(const item of cases){
  const context=contextFor(item),arms=[]
  for(const mode of ['compact-repair','template-fill']){
    const times:number[]=[];let bytes=0
    for(let iteration=0;iteration<11;iteration++){
      const started=performance.now(),binding=mode==='template-fill'?planningTemplateCatalog(context):undefined
      const compiler=binding?new TemplateFillingCompiler(context,{binding,prefetch:prefetchedTemplateIds(binding,context,item.instruction)}):new WorkflowAuthoringCompiler(context)
      const prompt={...(binding?templateAuthoringContext(context,item.instruction):authoringContext(context,item.instruction)),
        ...(compiler instanceof TemplateFillingCompiler?{templateCatalog:compiler.catalog(),rules:compiler.instructions}:{}),
        requirement:{id:'R1',text:item.instruction},requiredCoverageIds:['R1'],answers:[]}
      bytes=Buffer.byteLength(JSON.stringify({prompt,outputSchema:compiler.nextSchema}))
      if(iteration)times.push(performance.now()-started)
    }
    arms.push({mode,promptAndSchemaBytes:bytes,medianPreparationMs:median(times)})
  }
  records.push({case:item.id,arms,payloadRatio:arms[1]!.promptAndSchemaBytes/arms[0]!.promptAndSchemaBytes})
}
const report={scope:'Offline UTF-8 size of prompt plus structured_output schema; excludes common system prompts, catalog tool declarations, history, provider latency and model generation. Preparation measured 10 repetitions after one warmup. Not tokens, bills or planning performance.',externalModelCalls:0,records,pairedMedianPayloadRatio:median(records.map(r=>r.payloadRatio))}
const output=process.argv.find(arg=>arg.startsWith('--out='))?.slice(6)
if(output)writeFileSync(output,JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report,null,2))
