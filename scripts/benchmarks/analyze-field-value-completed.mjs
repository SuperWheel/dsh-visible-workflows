/** Read-only V6 analysis. No bridge, model, network, GUI or profile access.
 * Live files are read only after the caller explicitly confirms completion. */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'

export const EXPECTED_MANIFEST='989ede57e0bae6b0510e05e1d6828ca880eb151c1b2d0c5ab0e254120329fd59'
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
export const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const fileHash=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0
const count=value=>Number.isSafeInteger(value)&&value>=0
const code=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(value)?value:null
export const median=values=>{if(!values.length)return null;const a=[...values].sort((x,y)=>x-y),i=Math.floor(a.length/2);return a.length%2?a[i]:(a[i-1]+a[i])/2}
const stats=values=>{const a=values.filter(finite);return {observed:a.length,total:a.length?a.reduce((x,y)=>x+y,0):null,median:median(a),min:a.length?Math.min(...a):null,max:a.length?Math.max(...a):null}}
const slotKey=slot=>slot.repeat+slot.arm
const callKey=(slot,request)=>slotKey(slot)+':'+request
const same=(left,right)=>digest(left)===digest(right)
const usageFields=['promptTokens','completionTokens','reasoningTokens','cachedPromptTokens','cacheWriteTokens','totalTokens']
const safeEventTypes=new Set(['call-start','call-end','catalog-query','compiler-submission','tool-parse','arm-end'])
const forbidden=new Set(['reasoning_content','thinking','arguments','fragments','messages','credentials','api_key','apiKey','Authorization','authorization'])
function forbiddenKeys(value){if(!value||typeof value!=='object')return false;return Object.entries(value).some(([key,item])=>forbidden.has(key)||forbiddenKeys(item))}

export function verifyManifest(manifest){
 const {digest:actual,...body}=manifest
 assert.equal(actual,EXPECTED_MANIFEST,'Unexpected manifest; do not substitute or re-freeze a completed batch')
 assert.equal(digest(body),actual,'Frozen manifest digest changed')
 assert.equal(manifest.kind,'single-treatment-field-value-v6')
 assert.equal(manifest.preregistration.thresholds.localPairedMedianWallReductionMin,.2)
 assert.equal(manifest.schedule.map(row=>row.arm).join(''),'ABBAABBAAB')
 assert.deepEqual(manifest.preregistration.limits,{maxRequestsPerArm:8,maxSubmissionsPerArm:3,maxCatalogCallsPerArm:20,maxRequestsTotal:30,privateTransportDeadlineMs:260000})
 const hashes=manifest.hashes.map(file=>({path:file.path,expected:file.sha256,actual:fileHash(file.path)}))
 assert.ok(hashes.every(file=>file.expected===file.actual),'Frozen runtime/source hash mismatch')
 return {manifestDigest:actual,filesChecked:hashes.length,allFrozenHashesMatch:true}
}

/** Pure function: retains all ten planned arms and does not modify raw evidence. */
export function analyzeReport(manifest,report,events,initialRequests){
 const errors=[],require=(condition,code)=>{if(!condition)errors.push(code)}
 require(report.manifestDigest===manifest.digest,'REPORT_MANIFEST_MISMATCH')
 require(Array.isArray(report.results)&&report.results.length===10,'PLANNED_ARMS_NOT_TEN')
 require(!forbiddenKeys(report)&&!forbiddenKeys(events),'FORBIDDEN_PAYLOAD_KEY')
 const rows=report.results??[],knownCatalog=new Set(JSON.parse(initialRequests.A.messages[1].content).templateCatalog.templates.map(row=>row.id))
 require(report.sharedCompilerCompletionValidated===true&&report.serviceLifecycleValidated===false&&report.nativeSdkValidated===false,'EXPERIMENT_BOUNDARY_CHANGED')
 for(let i=0;i<rows.length;i++){
  const row=rows[i],expected=manifest.schedule[i]
  require(expected&&row.repeat===expected.repeat&&row.arm===expected.arm&&row.position===expected.position,'SCHEDULE_OR_ORDER_MISMATCH')
  require(['success','failed','not-run'].includes(row.status),'UNKNOWN_ARM_STATUS')
  require(count(row.requests)&&row.requests<=8&&row.calls?.length===row.requests,'REQUEST_COUNT_INVALID')
  require(count(row.submissions)&&row.submissions<=3&&count(row.repairs)&&row.repairs<=row.submissions,'SUBMISSION_COUNT_INVALID')
  require(count(row.catalogCalls)&&row.catalogCalls<=21,'QUERY_COUNT_INVALID')
  require(row.status==='not-run'?row.totalWallMs===null&&row.requests===0:finite(row.totalWallMs),'ARM_WALL_INVALID')
  if(row.status==='success')require(row.oracle?.passed===true&&row.oracle.unrelatedUnchanged===true&&row.oracle.samples?.length===4&&row.oracle.samples.every(s=>s.passed===true)&&row.candidateSameAsBase===false,'SUCCESS_ORACLE_INVALID')
  for(let j=0;j<(row.calls??[]).length;j++){
   const call=row.calls[j];require(call.request===j+1&&finite(call.roundTripMs)&&Number.isFinite(Date.parse(call.at)),'CALL_ID_OR_TIME_INVALID')
   require(count(call.inputBytes)&&count(call.messageBytes)&&count(call.schemaBytes),'CALL_BYTES_INVALID')
   for(const field of usageFields)require(call.usage?.[field]===null||count(call.usage?.[field]),'USAGE_COUNTER_INVALID')
   require(call.providerQueueMs===null&&call.providerPrefillMs===null,'UNOBSERVED_PROVIDER_INTERNAL_TIME_CHANGED')
  }
  for(const query of row.queries??[])require((query.knownIds??[]).every(id=>knownCatalog.has(id))&&(query.prefetchedHits??[]).every(id=>knownCatalog.has(id)),'QUERY_NONPUBLIC_ID')
  require((row.queries??[]).length===Math.min(row.catalogCalls,20),'QUERY_JOURNAL_COUNT_INVALID')
  require((row.submissionEvents??[]).length===row.submissions,'SUBMISSION_JOURNAL_COUNT_INVALID')
  const first=row.calls?.[0],frozen=manifest.initialBodyDigests[row.arm]
  require(!first||typeof frozen==='string','FROZEN_FIRST_REQUEST_UNBOUND')
 }
 const calls=rows.flatMap(row=>row.calls??[])
 require(report.totalRequests===calls.length&&report.totalRequests<=30,'BATCH_REQUEST_COUNT_INVALID')
 const starts=events.filter(event=>event.type==='call-start'),ends=events.filter(event=>event.type==='call-end'),arms=events.filter(event=>event.type==='arm-end')
 require(events.every(event=>safeEventTypes.has(event.type)),'UNKNOWN_EVENT_TYPE')
 require(starts.length===calls.length&&ends.length===calls.length&&arms.length===10,'EVENT_CARDINALITY_MISMATCH')
 const seenStart=new Map(),seenEnd=new Map(),seenArm=new Map();let active=null
 for(const event of events){
  if(event.type==='call-start'){const key=callKey(event.slot,event.request);require(active===null&&!seenStart.has(key),'NON_SERIAL_OR_DUPLICATE_START');active=key;seenStart.set(key,event)}
  if(event.type==='call-end'){const key=callKey(event.slot,event.call.request);require(active===key&&!seenEnd.has(key),'END_WITHOUT_ACTIVE_START');active=null;seenEnd.set(key,event)}
  if(event.type==='arm-end'){const key=slotKey(event.result);require(!seenArm.has(key),'DUPLICATE_ARM_END');seenArm.set(key,event)}
 }
 require(active===null,'UNSETTLED_CALL_IN_FINAL_JOURNAL')
 for(const row of rows){require(seenArm.has(slotKey(row))&&same(seenArm.get(slotKey(row)).result,row),'ARM_EVENT_REPORT_MISMATCH');for(const call of row.calls??[]){const key=callKey(row,call.request),start=seenStart.get(key),end=seenEnd.get(key);require(end&&same(end.call,call),'CALL_EVENT_REPORT_MISMATCH');require(start&&['at','request','messageBytes','schemaBytes','inputBytes'].every(field=>start[field]===call[field]),'CALL_START_METADATA_MISMATCH')}}
 require(same(arms.map(event=>slotKey(event.result)),rows.map(slotKey)),'ARM_JOURNAL_ORDER_MISMATCH')
 for(const row of rows){for(const [type,field,eventField]of [['catalog-query','queries','query'],['compiler-submission','submissionEvents','submission']])require(same(events.filter(event=>event.type===type&&slotKey(event.slot)===slotKey(row)).map(event=>event[eventField]),row[field]??[]),'TOOL_JOURNAL_REPORT_MISMATCH')}
 const pairs=Array.from({length:5},(_,repeat)=>{
  const A=rows.find(row=>row.repeat===repeat&&row.arm==='A'),B=rows.find(row=>row.repeat===repeat&&row.arm==='B')
  const valid=A?.status==='success'&&B?.status==='success'&&finite(A.totalWallMs)&&A.totalWallMs>0&&finite(B.totalWallMs)
  return {repeat,order:repeat%2?'BA':'AB',AStatus:A?.status??'missing',BStatus:B?.status??'missing',AReason:code(A?.reasonCode),BReason:code(B?.reasonCode),AWallMs:A?.totalWallMs??null,BWallMs:B?.totalWallMs??null,localWallReduction:valid?1-B.totalWallMs/A.totalWallMs:null,ARequests:A?.requests??null,BRequests:B?.requests??null,requestDifference:A&&B?B.requests-A.requests:null,AQueries:A?.catalogCalls??null,BQueries:B?.catalogCalls??null,ARepairs:A?.repairs??null,BRepairs:B?.repairs??null,repairDifference:A&&B?B.repairs-A.repairs:null}
 })
 const groups=['A','B'].map(arm=>{
  const members=rows.filter(row=>row.arm===arm),armCalls=members.flatMap(row=>row.calls??[])
  const usage=Object.fromEntries(usageFields.map(field=>{const values=armCalls.map(call=>call.usage?.[field]??null),known=values.filter(count);return [field,{knownSum:known.length?known.reduce((a,b)=>a+b,0):null,unknownCalls:values.length-known.length,total:known.length===values.length&&known.length?known.reduce((a,b)=>a+b,0):null}]}))
  const wall=stats(members.map(row=>row.totalWallMs)),provider=stats(armCalls.map(call=>call.roundTripMs)),compiler=stats(members.filter(row=>row.status!=='not-run').map(row=>row.compilerMs))
  return {
   arm,planned:members.length,
   success:members.filter(row=>row.status==='success').length,
   failed:members.filter(row=>row.status==='failed').length,
   notRun:members.filter(row=>row.status==='not-run').length,
   ...Object.fromEntries(['requests','repairs','submissions'].map(field=>[field,members.reduce((sum,row)=>sum+row[field],0)])),
   queries:members.reduce((sum,row)=>sum+row.catalogCalls,0),
   oracleSamples:members.reduce((sum,row)=>sum+(row.oracle?.samples?.length??0),0),
   oracleSamplesPassed:members.reduce((sum,row)=>sum+(row.oracle?.samples?.filter(s=>s.passed).length??0),0),
   successfulWallMs:stats(members.filter(row=>row.status==='success').map(row=>row.totalWallMs)),
   allAttemptedWallMs:wall,providerRoundTripMs:provider,
   ...Object.fromEntries(['providerRequestMs','firstObservedDeltaMs','firstValidTextMs','firstValidToolArgumentsMs'].map(field=>[field,stats(armCalls.map(call=>call[field]))])),
   compilerMs:compiler,
   providerRoundTripFractionOfAttemptedWall:wall.total>0&&provider.total!==null?provider.total/wall.total:null,
   compactLocalJsonInputBytes:stats(armCalls.map(call=>call.inputBytes)),
   localSchemaBytes:stats(armCalls.map(call=>call.schemaBytes)),usage,
   cacheCalls:{knownZero:armCalls.filter(call=>call.usage?.cachedPromptTokens===0).length,reportedHit:armCalls.filter(call=>count(call.usage?.cachedPromptTokens)&&call.usage.cachedPromptTokens>0).length,unknown:armCalls.filter(call=>call.usage?.cachedPromptTokens===null).length},
   firstCalls:members.map(row=>({repeat:row.repeat,status:row.status,inputBytes:row.calls?.[0]?.inputBytes??null,schemaBytes:row.calls?.[0]?.schemaBytes??null,cachedPromptTokens:row.calls?.[0]?.usage?.cachedPromptTokens??null})),
   queryObservations:members.flatMap(row=>(row.queries??[]).map(query=>({repeat:row.repeat,request:query.request,status:['success','error'].includes(query.status)?query.status:null,knownIds:(query.knownIds??[]).filter(id=>knownCatalog.has(id)),unknownIdCount:query.unknownIdCount,prefetchedHits:(query.prefetchedHits??[]).filter(id=>knownCatalog.has(id)),responseBytes:query.responseBytes,schemaDigestBefore:query.schemaDigestBefore,schemaDigestAfter:query.schemaDigestAfter}))),
   submissionStatuses:members.flatMap(row=>(row.submissionEvents??[]).map(s=>({repeat:row.repeat,request:s.request,status:s.status,mode:s.mode,revision:s.revision??null,issues:(s.issues??[]).map(issue=>({code:code(issue.code),path:issue.path,actualType:issue.actualType}))})))
  }
 })
 const good=pairs.filter(pair=>pair.localWallReduction!==null),paired=median(good.map(pair=>pair.localWallReduction)),requestDelta=groups[1].requests-groups[0].requests,repairDelta=groups[1].repairs-groups[0].repairs
 const gates={allFivePairsPassed:good.length===5,noObservedSuccessRegression:groups[1].success>=groups[0].success,noAggregateRequestIncrease:requestDelta<=0,noPerPairRequestIncrease:pairs.every(pair=>pair.requestDifference!==null&&pair.requestDifference<=0),noRepairIncrease:repairDelta<=0,localWallReduction20Percent:paired!==null&&paired>=.2}
 for(const [name,value]of Object.entries(gates))require(report.summary?.gates?.[name]===value,'DRIVER_GATE_RECALCULATION_MISMATCH')
 require(report.summary?.pairedMedianLocalWallReduction===paired,'DRIVER_PAIRED_MEDIAN_MISMATCH')
 return {manifestDigest:manifest.digest,evidenceAudit:{passed:errors.length===0,errorCodes:[...new Set(errors)],serializedDriverOrderOnly:true,serverConcurrency:null},plannedPairs:5,plannedArms:10,resultsRetained:rows.length,totalRequests:calls.length,pairs,groups,successfulPairs:good.length,pairedMedianLocalWallReduction:paired,pairedLocalWallReductionRange:good.length?{min:Math.min(...good.map(pair=>pair.localWallReduction)),max:Math.max(...good.map(pair=>pair.localWallReduction))}:null,aggregateRequestDifference:requestDelta,aggregateRepairDifference:repairDelta,gates,allFrozenLocalGatesPassed:errors.length===0&&Object.values(gates).every(Boolean),mainAgentEndToEnd:null,desktopEndToEnd:null,providerQueueMs:null,providerPrefillMs:null,providerConfirmedEffectiveSettings:null,cacheFlushPerformed:false,cacheCausalSpeedup:null,tokenTotalProvenance:'Driver normalized usage; total may fall back to reported prompt+completion. No tokens inferred from bytes.',byteBoundary:'inputBytes and schemaBytes are compact local Node JSON counts. Python default json.dumps transport projection differs; no actual HTTP wire dump was captured.',sampleScope:'One preregistered exploratory five-pair local provider harness batch. No resampling, replacement trials, production P95 or full Main/Desktop inference.'}
}

export function main(args=process.argv.slice(2)){
 assert.ok(args.includes('--completed-confirmed'),'Refuse live/interim reads: root must explicitly confirm the unique run completed')
 assert.ok(args.every(arg=>arg==='--completed-confirmed'||/^--(?:manifest|run-dir|out)=/.test(arg)),'Unknown analysis argument')
 const arg=name=>args.find(value=>value.startsWith('--'+name+'='))?.slice(name.length+3)
 assert.ok(arg('manifest')&&arg('run-dir')&&arg('out'),'Explicit manifest, completed run directory and new output directory required')
 const manifestPath=resolve(arg('manifest')),runDir=resolve(arg('run-dir')),out=resolve(arg('out'))
 assert.ok(!existsSync(out),'Analysis output must be a new directory; do not overwrite conclusions')
 const manifest=JSON.parse(readFileSync(manifestPath,'utf8')),freeze=verifyManifest(manifest)
 const registration=JSON.parse(readFileSync(join(runDir,'run-registration.json'),'utf8'))
 assert.equal(registration.manifestDigest,manifest.digest,'Run registration digest mismatch')
 const reportPath=join(runDir,'report.json'),eventPath=join(runDir,'events.jsonl')
 assert.ok(existsSync(reportPath),'Completed final report required; no interim reconstruction or early conclusion')
 const report=JSON.parse(readFileSync(reportPath,'utf8')),events=readFileSync(eventPath,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line))
 const initialRequests=JSON.parse(readFileSync(join(resolve(manifestPath,'..'),'public-initial-requests.json'),'utf8'))
 const analysis=analyzeReport(manifest,report,events,initialRequests),provenancePath=join(resolve(manifest.runtimeSnapshot.sourceRoot,'..'),'snapshot-provenance.json')
 const provenance=JSON.parse(readFileSync(provenancePath,'utf8'))
 const drift=provenance.originals.flatMap(file=>{const actual=existsSync(file.path)?fileHash(file.path):null;return actual===file.sha256?[]:[{path:file.path,frozenSha256:file.sha256,currentSha256:actual}]})
 const artifacts={manifest:{path:manifestPath,sha256:fileHash(manifestPath)},registration:{path:join(runDir,'run-registration.json'),sha256:fileHash(join(runDir,'run-registration.json'))},report:{path:reportPath,sha256:fileHash(reportPath)},events:{path:eventPath,sha256:fileHash(eventPath)}}
 mkdirSync(out,{recursive:false})
 writeFileSync(join(out,'analysis.json'),JSON.stringify({...analysis,freeze,artifacts,currentSourceComparison:{observedAt:new Date().toISOString(),drift,installedDesktopVerified:false,note:'Frozen V6-v4 includes completed S11 local-template reference fix and corrected value protocol catalog guide. Subsequent current-source drift is listed independently; local provider and complete Main/Desktop conclusions remain separate.'}},null,2)+'\n',{flag:'wx'})
 console.log(JSON.stringify({analysisDirectory:out,evidenceAuditPassed:analysis.evidenceAudit.passed,allFrozenLocalGatesPassed:analysis.allFrozenLocalGatesPassed,successfulPairs:analysis.successfulPairs,pairedMedianLocalWallReduction:analysis.pairedMedianLocalWallReduction}))
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main()
