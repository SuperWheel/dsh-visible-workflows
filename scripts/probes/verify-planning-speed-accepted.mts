// Artifact-only verification after an explicitly requested scoped collection.
// Never reads user profile, invokes a model, polls, or operates UI.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {renumberWorkflow} from '../../src/shared/numbering.ts'
import {SCOPE,REPO,noSymlinks,readBytes} from './collect-planning-speed-desktop.mjs'
const LIVE=path.join(REPO,'docs/evidence/planning-speed-20261019/desktop-live')
const PUBLICATION=path.join(LIVE,'20261019T135142741Z-e27205')
const CREATED=path.join(LIVE,'20261019T135905816Z-3d2ec1')
const IDS={large:'d10eea42-f9f2-4533-9f81-c9d9273fa555',deep:'b62bef53-4cb9-402a-9c54-2fd6ede0a3c4',module:'s10-module-table-20261019'}
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v
export const digest=(v:any)=>crypto.createHash('sha256').update((JSON.stringify(canonical(v))??'undefined')).digest('hex')
const equal=(a:any,b:any)=>digest(a)===digest(b)
const read=(file:string)=>JSON.parse(readBytes(file))
export function savedCandidateCheck(candidate:any,saved:any,budget:any,expectedRevision:number,createdMetadata?:{createdAt:string}){
  assert.equal(candidate.id,saved.id);assert.equal(candidate.workspaceId,SCOPE.workspaceId);assert.equal(saved.workspaceId,SCOPE.workspaceId)
  assert.equal(budget.budgetDecision?.mode,'unlimited','Only the exact previously recorded human budget is accepted')
  const expected=renumberWorkflow(structuredClone(candidate))
  expected.budgetDecision=structuredClone(budget.budgetDecision)
  if(budget.executionPolicy===undefined)delete expected.executionPolicy
  else expected.executionPolicy=structuredClone(budget.executionPolicy)
  expected.revision=expectedRevision;expected.updatedAt=saved.updatedAt
  if(createdMetadata)expected.createdAt=createdMetadata.createdAt
  const numberChanges=expected.nodes.flatMap((n:any)=>{const before=candidate.nodes.find((row:any)=>row.id===n.id);return before?.number===n.number?[]:[{id:n.id,before:before?.number,expected:n.number}]})
  return {passed:equal(expected,saved),expectedRevision,actualRevision:saved.revision,expectedDefinitionSha256:digest(expected),savedDefinitionSha256:digest(saved),exactFrozenHumanBudget:equal(saved.budgetDecision,budget.budgetDecision)&&equal(saved.executionPolicy??null,budget.executionPolicy??null),productionNumberChanges:numberChanges,allowedTransformations:['Exact frozen human unlimited budgetDecision and executionPolicy','Production renumberWorkflow output, not arbitrary number removal','Expected accepted revision or created revision','Saved updatedAt',...(createdMetadata?['Exact previously recorded creation receipt storage createdAt']:[])],layoutOrNavigationIgnored:false}
}
const parseRows=(value:any)=>{try{return JSON.parse(value)}catch{return undefined}}
export function checkCase(runs:any[],saved:any,inputs:any,expected:string,revision:number,count?:number){
  const matches=runs.filter(r=>r.workflowId===saved.id&&r.workspaceId===SCOPE.workspaceId&&r.sourceRevision===revision&&Object.entries(inputs).every(([key,value])=>key==='rows'?equal(parseRows(r.inputs?.rows),parseRows(value)):r.inputs?.[key]===value))
  const observations=matches.map(r=>{const code=saved.nodes.find((n:any)=>n.kind==='code'),actualCount=count===undefined?undefined:r.executions.find((e:any)=>e.nodeId===code?.id)?.data?.count,graphMatches=equal(r.graph.nodes,saved.nodes)&&equal(r.graph.edges,saved.edges),ledgerZero=['calls','agentTasks','unknownCalls','spentTokens'].every(k=>r.budget?.[k]===0);return {runId:r.id,status:r.status,sourceRevision:r.sourceRevision,engine:r.engine?.name,actual:r.outputs?.result,actualCount,graphNodesAndEdgesMatchSaved:graphMatches,budgetLedger:r.budget?Object.fromEntries(['calls','agentTasks','unknownCalls','spentTokens'].map(k=>[k,r.budget[k]])):null,ledgerZero,passed:r.status==='success'&&r.engine?.name==='graphon'&&r.outputs?.result===expected&&graphMatches&&ledgerZero&&(count===undefined||actualCount===count)}})
  return {inputs,expected,expectedRevision:revision,expectedCount:count,status:matches.length?'observed':'not-observed',observations,passed:matches.length>0&&observations.every(r=>r.passed)}
}
export function verifyAccepted(snapshotDirectory:string){
  const directory=path.resolve(snapshotDirectory);assert(directory.startsWith(LIVE+'/'),'Use a scoped S10 collector directory');noSymlinks(directory)
  const summary=read(path.join(directory,'summary.json'));assert.equal(summary.workspaceId,SCOPE.workspaceId);assert.equal(summary.rootSessionId,'session-2bd02909-2c81-4d50-af8d-1cfb4bc26e4d')
  const workflows=read(path.join(directory,'workflows.json')),proposals=read(path.join(directory,'proposals.json')),runs=read(path.join(directory,'runs.json'))
  const frozenTasks=read(path.join(PUBLICATION,'planning.json')),budgets=read(path.join(PUBLICATION,'publication-and-metrics-observation.json')).proposalStatuses
  const createdWorkflow=read(path.join(CREATED,'workflows.json')).find((f:any)=>f.id===IDS.module)
  const moduleTask=read(path.join(CREATED,'planning.json')).find((t:any)=>t.receipt?.workflowId===IDS.module)
  const requested=[{name:'large31',id:IDS.large,revision:2},{name:'deep',id:IDS.deep,revision:2}]
  const definitions=requested.map(row=>{const task=frozenTasks.find((t:any)=>t.receipt?.workflowId===row.id),saved=workflows.find((f:any)=>f.id===row.id),budget=budgets.find((b:any)=>b.workflowId===row.id),proposal=proposals.find((p:any)=>p.id===task.receipt.proposalId);assert(saved&&budget&&proposal,'Need exact saved workflow, frozen budget and scoped proposal');return {case:row.name,workflowId:row.id,proposalId:proposal.id,proposalStatus:proposal.status,proposalAccepted:proposal.status==='accepted',savedMatchesAcceptedProposal:equal(saved,proposal.candidate),...savedCandidateCheck(task.candidate,saved,budget,row.revision)}})
  const module=workflows.find((f:any)=>f.id===IDS.module);assert(module)
  const moduleCheck={case:'module-created',workflowId:IDS.module,revision:module.revision,provenance:moduleTask.moduleProvenance,unchangedFromCreatedSnapshot:equal(module,createdWorkflow),...savedCandidateCheck(moduleTask.candidate,module,{budgetDecision:createdWorkflow.budgetDecision,executionPolicy:createdWorkflow.executionPolicy},1,{createdAt:createdWorkflow.createdAt})}
  const oracle=read(path.join(REPO,'docs/evidence/planning-speed-20261019/desktop-prepare/oracle.json'))
  const cases=[...oracle.large.map((c:any)=>({case:'large31:'+c.inputs.text,...checkCase(runs,workflows.find((f:any)=>f.id===IDS.large),c.inputs,c.after,2)})),...oracle.deep.map((c:any)=>({case:'deep:'+c.id,...checkCase(runs,workflows.find((f:any)=>f.id===IDS.deep),c.inputs,JSON.stringify(c.after),2)})),...oracle.module.map((c:any)=>({case:'module:'+c.id,...checkCase(runs,module,c.inputs,c.before,1,JSON.parse(c.inputs.rows).length)}))]
  return {stage:'artifact-only-accepted-and-runtime-oracles',sourceSnapshot:path.relative(REPO,directory),scope:SCOPE,definitions,moduleCheck,cases,passed:definitions.every(r=>r.passed&&r.proposalAccepted&&r.savedMatchesAcceptedProposal)&&moduleCheck.passed&&moduleCheck.unchangedFromCreatedSnapshot&&cases.every(c=>c.passed),limits:['Only the fixed frozen human budget, exact production renumbering, revision and updatedAt transformations are permitted.','Layout/navigation changes are reported as mismatches, not silently waived.','Only actual sourceRevision 2 accepted runs and module revision1 runs count; old baseline runs are excluded.','A missing or running sample is not passed; no model/UI/profile operation or polling performed.']}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{assert(process.argv.length===4&&process.argv[2]==='--snapshot','Usage: node --import tsx scripts/probes/verify-planning-speed-accepted.mts --snapshot SCOPED_DIRECTORY');const report=verifyAccepted(process.argv[3]);fs.writeFileSync(path.join(process.argv[3],'accepted-runtime-oracles.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({passed:report.passed,definitions:report.definitions,moduleCheck:report.moduleCheck,cases:report.cases.map(c=>({case:c.case,status:c.status,passed:c.passed}))},null,2));if(!report.passed)process.exitCode=1}catch(error){console.error(JSON.stringify({status:'failed',reason:'ACCEPTED_ORACLE_INPUT_OR_SCOPE_INVALID',errorType:error?.name??'Error'}));process.exitCode=1}}
