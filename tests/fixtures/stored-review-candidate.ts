import { makeWorkflow } from '../../src/shared/types.ts'
import { planningDigest, type PlanningTask } from '../../src/host/planning/service.ts'
import { parseWorkflow } from '../../src/shared/workflow-validation.ts'

/** Historical T05 shape: the file write precedes the human review. No execution. */
export function storedReviewCandidate(state:'ready'|'publishing'|'published'):PlanningTask{
  const baseline=makeWorkflow('workspace','Historical review',true)
  let candidate=structuredClone(baseline)
  const [input,write,output]=candidate.nodes
  write!.kind='tool';write!.config={toolId:'native:write',inputs:{file_path:'t05-greeting.json',content:'Hello Ada'}}
  output!.config={text:'done'}
  candidate.nodes.splice(2,0,{id:'review',kind:'human',title:'Review',number:'a-4',x:500,y:0,fixed:false,config:{fields:[],actions:[{id:'approve',label:'Approve'},{id:'reject',label:'Reject'}]}})
  candidate.edges=[{id:'e1',source:input!.id,target:write!.id},{id:'e2',source:write!.id,target:'review'},{id:'e3',source:'review',target:output!.id,port:'approve'},{id:'e4',source:'review',target:output!.id,port:'reject'}]
  candidate=parseWorkflow(candidate)
  const request={requestId:'historical-review',operation:'create' as const,instruction:'Write a greeting and review it'},candidateDigest=planningDigest(candidate)
  const task:PlanningTask={engineVersion:'0.0.2',id:'historical-review',request,requestDigest:planningDigest(request),workspaceId:'workspace',sessionId:'main',preview:false,state,revision:5,createdAt:baseline.createdAt,updatedAt:baseline.updatedAt,
    context:{workflow:baseline,operation:'create',targetNodeIds:[],nodeIds:['review'],subagentIds:[],environmentIds:[],tools:[{id:'native:write',name:'write',description:'Offline write schema',providerId:'native',providerName:'Offline',category:'plugin',inputSchema:{type:'object',properties:{file_path:{type:'string'},content:{type:'string'}},required:['file_path','content']},available:true}],model:{provider:'fixture',model:'offline'}},candidate,candidateDigest,
    diagnostics:[],childAttempts:1,steps:1,spentTokens:0,unknownTokens:0,reservedTokens:0,usageAccountingVersion:2,observedInputBytes:0,unknownUsageCalls:0,pendingUsageCalls:0,candidateAttempts:1,questionRounds:0,answers:[],events:[]}
  if(state!=='ready'){
    task.commit={key:planningDigest([task.id,candidateDigest,request.operation]),digest:candidateDigest}
    if(state==='published')task.receipt={...task.commit,kind:'created',workflowId:candidate.id,revision:1}
  }
  return task
}
