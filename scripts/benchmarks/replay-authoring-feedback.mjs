/** Offline success-output guard. Snapshot HEAD first, then compare after edits.
 * node --import tsx scripts/benchmarks/replay-authoring-feedback.mjs <out.json> [baseline.json] [--template-source=<git-ref>]
 * Journals are read-only; no provider, oracle process or network is constructed. */
import {readFileSync,writeFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {isDeepStrictEqual} from 'node:util'
import {execFileSync} from 'node:child_process'
import ts from 'typescript'
import {normalizeAuthoring} from '../../src/shared/planning-authoring-core.ts'
import {applyRepair} from '../../src/shared/planning-repair.ts'
import {cases,contextFor} from './workflow-compiler.ts'
import {WorkflowAuthoringCompiler} from '../../src/shared/planning-authoring.ts'
import {TemplateFillingCompiler} from '../../src/shared/planning-template-compiler.ts'
// Optional old template source runs against unchanged shared dependencies, so
// both snapshots see the same contexts and current legacy topology validation.
const ref=process.argv.find(arg=>arg.startsWith('--template-source='))?.split('=')[1]
let TemplateCompiler=TemplateFillingCompiler
if(ref){
  const source=execFileSync('git',['show',ref+':src/shared/planning-template-compiler.ts'],{encoding:'utf8'})
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ESNext}}).outputText.replace(/from (['"])([^'"]+)\1/g,(_all,_quote,path)=>'from '+JSON.stringify(path.startsWith('.')?new URL('../../src/shared/'+path.slice(2),import.meta.url).href:import.meta.resolve(path)))
  TemplateCompiler=(await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'))).TemplateFillingCompiler
}
function normalize(input){
  const doc=normalizeAuthoring(input)
  for(const name of ['forms','addForms'])if(Array.isArray(doc[name])&&!Object.hasOwn(doc,name+'ByKey')){
    const keys=doc[name].map(form=>form?.key)
    if(keys.every(key=>typeof key==='string')&&new Set(keys).size===keys.length){doc[name+'ByKey']=Object.fromEntries(doc[name].map(({key,...form})=>[key,form]));delete doc[name]}
  }
  return doc
}
const discover=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?discover(join(dir,e.name)):e.name==='events.jsonl'?[join(dir,e.name)]:[])
const journals=discover('.test-data').sort(),rows=[]
let results=0,successfulSubmissions=0
for(const journal of journals)for(const [index,line]of readFileSync(journal,'utf8').trim().split('\n').entries()){
  const event=JSON.parse(line).event,r=event?.kind==='result'?event.result:undefined
  if(!r)continue
  results++
  if(r.status!=='success')continue
  successfulSubmissions+=r.submissionsLog?.length??0
  const row={id:journal+':'+(index+1),caseId:r.caseId,arm:r.arm,repeat:r.repeat,submissions:r.submissionsLog?.length??0}
  try{
    const item=cases.find(c=>c.id===r.caseId)
    if(!item)throw Error('Unknown case '+r.caseId)
    const compilerFor=()=>{
      const context=contextFor(item),compiler=r.arm==='template-fill'?new TemplateCompiler(context):new WorkflowAuthoringCompiler(context)
      if(r.arm==='template-fill')compiler.queryTemplates(compiler.catalog().templates.map(t=>t.id))
      return compiler
    }
    const compiler=compilerFor()
    let result
    for(const [i,submission]of r.submissionsLog.entries()){
      result=compiler.submit(submission)
      if(result.ok){row.acceptedAt=i+1;row.value=result.value;break}
    }
    if(!result?.ok)row.issues=result?.feedback.issues
    // Independently materialize the final historical draft, even when today's
    // compiler accepts before an old repair or no longer permits that old path.
    let document
    for(const entry of r.submissionsLog){
      const value=entry.submission
      if(value.mode!=='repair'&&document!==undefined)continue
      document=value.mode==='repair'?normalize(applyRepair(document,value.patches,value.patches.map(p=>p.path))):normalize(value)
      document.mode??=item.edit?'edit':'create'
    }
    const final=compilerFor().submit({submission:document})
    if(final.ok)row.finalValue=final.value
    else row.finalIssues=final.feedback.issues
  }catch(error){row.error=String(error)}
  rows.push(row)
}
const baselinePath=process.argv[3]?.startsWith('--')?undefined:process.argv[3]
const baseline=baselinePath?JSON.parse(readFileSync(baselinePath,'utf8')):undefined
const regressions=[],changes=[],newlyAccepted=[]
if(baseline)for(const before of baseline.rows){
  const after=rows.find(row=>row.id===before.id)
  for(const key of ['value','finalValue']){
    if(before[key]&&!after?.[key])regressions.push({id:before.id,kind:key,issues:after?.issues,error:after?.error})
    else if(before[key]&&!isDeepStrictEqual(before[key],after[key])){
      const normalized=structuredClone(after[key])
      normalized.candidate.title=before[key].candidate.title
      const graph=JSON.parse(normalized.output.graphJson);graph.title=JSON.parse(before[key].output.graphJson).title;normalized.output.graphJson=JSON.stringify(graph)
      const titleOnly=isDeepStrictEqual(before[key],normalized)
      changes.push({id:before.id,kind:key,caseId:after.caseId,arm:after.arm,beforeAt:before.acceptedAt,afterAt:after.acceptedAt,titleOnly})
    }
    else if(!before[key]&&after?.[key])newlyAccepted.push({id:after.id,kind:key})
  }
}
const summary={journals:journals.length,results,successfulAttempts:rows.length,successfulSubmissions,sequentialAccepted:rows.filter(r=>r.value).length,finalAccepted:rows.filter(r=>r.finalValue).length,
  unaccepted:rows.filter(r=>!r.value||!r.finalValue).map(({value,finalValue,issues,finalIssues,...r})=>({...r,sequentialIssues:issues?.map(({code,path})=>({code,path})),finalIssues:finalIssues?.map(({code,path})=>({code,path}))})),
  regressions:regressions.length,changed:changes.length,titleOnlyChanges:changes.filter(c=>c.titleOnly).length,newlyAccepted:newlyAccepted.length}
writeFileSync(process.argv[2],JSON.stringify({summary,rows,regressions,changes,newlyAccepted},null,2)+'\n')
console.log(JSON.stringify(summary,null,2))
if(regressions.length||changes.some(c=>!c.titleOnly))process.exitCode=1
