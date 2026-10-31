/** Offline journal guard: no provider construction, calls or journal writes.
 * Usage: node --import tsx scripts/benchmarks/replay-code-inputs.mjs /private/tmp/code-input-replay.json
 * Add --scan-only to rerun just the literal-read audit.
 * Sequential replay retains the old replay-alias accounting. Independently
 * materializing the final document also checks attempts accepted early today. */
import {readFileSync,writeFileSync,readdirSync} from 'node:fs'
import {join,relative} from 'node:path'
import {createHash} from 'node:crypto'
import {cases,contextFor,oracle} from './workflow-compiler.ts'
import {WorkflowAuthoringCompiler} from '../../src/shared/planning-authoring.ts'
import {TemplateFillingCompiler} from '../../src/shared/planning-template-compiler.ts'
import {normalizeAuthoring} from '../../src/shared/planning-authoring-core.ts'
import {planningEditView} from '../../src/shared/planning-edits.ts'
import {codeInputReads} from '../../src/shared/planning-code-inputs.ts'
import {applyRepair} from '../../src/shared/planning-repair.ts'
const baseline=['t09-par/shard-1','t09-par/shard-2b','t09-par/shard-3','t09-par/shard-4','t10-rerun/web-process','t10-rerun-2/container','layered-par/shard-1','layered-par/shard-2','layered-par/shard-3','layered-par/shard-4','layered-edit-rerun/local-edit','layered-edit-rerun/large-edit'].map(p=>'.test-data/'+p+'/events.jsonl')
const required=[...baseline,...[1,2,3,4].map(i=>`.test-data/narrow-par/shard-${i}/events.jsonl`)]
const discover=directory=>readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?discover(join(directory,entry.name)):entry.name==='events.jsonl'?[join(directory,entry.name)]:[])
const journals=[...new Set([...required,...discover('.test-data').map(p=>relative('.',p))])]
const results=[],flagged=new Map(),successfulHits=[],pending=[],oracleCache=new Map()
const checked=(candidate,item)=>{const key=hash([candidate,item.id]);if(!oracleCache.has(key))oracleCache.set(key,oracle(candidate,item));return oracleCache.get(key)}
let attempts=0,codeNodes=0
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function normalize(value){
  const doc=normalizeAuthoring(value)
  for(const name of ['forms','addForms'])if(Array.isArray(doc[name])){
    const keys=doc[name].map(n=>n?.key)
    if(keys.every(k=>typeof k==='string')&&new Set(keys).size===keys.length){doc[name+'ByKey']=Object.fromEntries(doc[name].map(({key,...rest})=>[key,rest]));delete doc[name]}
  }
  return doc
}
function scan(value,meta,where,path=''){
  if(!value||typeof value!=='object')return
  if(value.kind==='code'||value.template==='code'){
    const config=value.config??value.values??{},reads=codeInputReads(config.code,config.language)
    codeNodes++
    const missing=reads?.names.filter(name=>!Object.hasOwn(config.inputs??{},name))??[]
    if(missing.length){
      const key=path.split('/').at(-1),digest=hash(config),id=hash([meta.journal,meta.line,key,digest])
      const row=flagged.get(id)??{...meta,node:value.key??value.id??key,parameter:reads.parameter,missing,configSha256:digest,occurrences:[]}
      row.occurrences.push(where+':'+path);flagged.set(id,row)
      if(meta.status==='success')successfulHits.push({...meta,node:row.node,where,path,missing})
    }
  }
  for(const [key,child]of Object.entries(value))if(key!=='config'&&key!=='values'||child?.body)scan(child,meta,where,path+'/'+key)
}
const compilerFor=r=>{
  const item=cases.find(c=>c.id===r.caseId)
  if(!item)throw Error('Unknown case '+r.caseId)
  const context=contextFor(item),compiler=r.arm==='template-fill'?new TemplateFillingCompiler(context):new WorkflowAuthoringCompiler(context)
  if(compiler instanceof TemplateFillingCompiler)compiler.queryTemplates(compiler.catalog().templates.map(t=>t.id))
  return {compiler,item}
}
for(const journal of journals){
  const lines=readFileSync(journal,'utf8').trim().split('\n')
  for(const [index,line]of lines.entries()){
    const event=JSON.parse(line).event,r=event?.kind==='result'?event.result:null
    if(!r)continue
    attempts++
    const meta={journal,line:index+1,caseId:r.caseId,arm:r.arm,repeat:r.repeat,status:r.status}
    let document,materializationError
    for(const [i,entry]of (r.submissionsLog??[]).entries()){
      try{
        const value=entry.submission
        if(value.mode!=='repair'&&document!==undefined){scan(normalize(value),meta,'rejected-resubmission-'+i);continue}
        document=value.mode==='repair'?normalize(applyRepair(document,value.patches,value.patches.map(p=>p.path))):normalize(value)
        document.mode??=cases.find(c=>c.id===r.caseId)?.edit?'edit':'create'
        materializationError=undefined
        scan(document,meta,'submission-'+i)
        if(document.mode==='edit'){
          const item=cases.find(c=>c.id===r.caseId),view=item?planningEditView(contextFor(item)):undefined
          for(const [key,change]of Object.entries(document.updates??{})){
            const old=view?.nodes.find(n=>'n'+n.ref.slice(1)===key),kind=change.kind??change.template??old?.kind
            if(kind!=='code'||!['code','inputs'].some(field=>Object.hasOwn(change.set??change.values??{},field)||change.unset?.includes(field)))continue
            const config={...old?.config,...change.set,...change.values};for(const field of change.unset??[])delete config[field]
            scan({kind,config},meta,'submission-'+i,'/updates/'+key)
          }
        }
      }catch(error){materializationError=String(error)}
    }
    if(r.candidate)scan(r.candidate,meta,'candidate')
    if(r.status!=='success'||process.argv.includes('--scan-only'))continue
    pending.push(async()=>{
    const row={...meta,originalSubmissions:r.submissionsLog.length,sequential:{passed:false},final:{passed:false}}
    try{
      const {compiler,item}=compilerFor(r)
      let result
      for(const [i,submission]of r.submissionsLog.entries()){
        result=compiler.submit(submission)
        if(!result.ok){const hits=result.feedback.issues.filter(i=>i.code==='CODE_INPUT_UNMAPPED');if(hits.length)successfulHits.push({...meta,where:'sequential',issues:hits})}
        if(result.ok&&i!==r.submissionsLog.length-1)throw Error('Accepted before FINAL submission at '+(i+1))
      }
      if(!result?.ok)row.sequential.issues=result?.feedback.issues.map(({code,path,message})=>({code,path,message}))
      else{row.sequential.accepted=true;row.sequential.oracle=await checked(result.value.candidate,item);row.sequential.passed=row.sequential.oracle.passed;if(row.sequential.passed)delete row.sequential.oracle}
    }catch(error){row.sequential.error=String(error)}
    try{
      if(materializationError)throw Error(materializationError)
      const {compiler,item}=compilerFor(r),result=compiler.submit({submission:document})
      if(!result.ok){row.final.issues=result.feedback.issues.map(({code,path,message})=>({code,path,message}));const hits=result.feedback.issues.filter(i=>i.code==='CODE_INPUT_UNMAPPED');if(hits.length)successfulHits.push({...meta,where:'final',issues:hits})}
      else{row.final.accepted=true;row.final.oracle=await checked(result.value.candidate,item);row.final.passed=row.final.oracle.passed;if(row.final.passed)delete row.final.oracle}
    }catch(error){row.final.error=String(error)}
    results.push(row);console.log(JSON.stringify({journal,line:index+1,caseId:r.caseId,arm:r.arm,repeat:r.repeat,sequential:row.sequential.passed,final:row.final.passed}))
    })
  }
}
let next=0
await Promise.all(Array.from({length:4},async()=>{while(next<pending.length)await pending[next++]()}))
const totals=rows=>({total:rows.length,sequentialAccepted:rows.filter(r=>r.sequential.accepted).length,sequentialPassed:rows.filter(r=>r.sequential.passed).length,finalAccepted:rows.filter(r=>r.final.accepted).length,finalPassed:rows.filter(r=>r.final.passed).length,exceptions:rows.filter(r=>!r.sequential.passed||!r.final.passed)})
const summary={journals:journals.length,attempts,codeNodeObservations:codeNodes,baseline:totals(results.filter(r=>baseline.includes(r.journal))),required:totals(results.filter(r=>required.includes(r.journal))),all:totals(results),successfulCodeInputHits:successfulHits.length,flagged:[...flagged.values()]}
if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify({summary,results,successfulHits},null,2)+'\n')
console.log('SUMMARY '+JSON.stringify(summary))
if(successfulHits.length)process.exitCode=1
