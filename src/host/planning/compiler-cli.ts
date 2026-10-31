#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { TemplateFillingCompiler } from '../../shared/planning-template-compiler.ts'
import { WorkflowAuthoringCompiler } from '../../shared/planning-authoring.ts'
import { createProcedureCompiler } from '../../shared/planning-procedure-compiler.ts'
import { compilerJson, type SubmissionCompiler } from '../../shared/planning-repair.ts'
import { submissionSchemaIssues } from '../../shared/planning-submission-schema.ts'
import { parseWorkflow } from '../../shared/workflow-validation.ts'
import { exportWorkflowPackage } from '../../shared/workflow-format.ts'
import { validateConversationEvidence } from './conversation-evidence.ts'
import { templateQuerySchema, queryPlanningTemplates } from './template-catalog.ts'

// NDJSON: first line is a trusted Host binding; subsequent lines are submission envelopes.
// A process owns exactly one session. No model, graph execution, publication or file writes.
if(process.argv.includes('--help')){console.log('workflow_compile: NDJSON on stdin. First line: {context:<Host PlanningContext>,compilerMode?:"compact-repair"|"template-fill"} or {purpose:"distill",evidence,trialTask}. Following lines: {submission:{...}}. Template metadata query: {query:{ids:["code"]}}; does not consume a submission. No model or publication.');process.exit(0)}
let compiler:SubmissionCompiler|undefined
let accepted=false
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
  try{
    if(Buffer.byteLength(line)>1_000_000)throw Error('Input exceeds 1 MB')
    const input=compilerJson(JSON.parse(line))
    if(!compiler){
      if(input.purpose==='distill')compiler=createProcedureCompiler(validateConversationEvidence(input.evidence),input.trialTask)
      else{
        const context=input.context
        if(!context||!['create','revise'].includes(context.operation))throw Error('First line requires Host context')
        context.workflow=parseWorkflow(context.workflow)
        for(const name of ['nodeIds','subagentIds','environmentIds','targetNodeIds'])if(!Array.isArray(context[name])||context[name].length>500||context[name].some((v:unknown)=>typeof v!=='string'))throw Error('Invalid Host identity pool')
        if(!Array.isArray(context.tools)||!context.model?.provider||!context.model?.model)throw Error('Invalid Host catalog/model context')
        if(input.compilerMode!==undefined&&!['compact-repair','template-fill'].includes(input.compilerMode))throw Error('Unknown compiler mode')
        compiler=input.compilerMode==='template-fill'?new TemplateFillingCompiler(context,{requiredCoverageIds:input.requiredCoverageIds}):new WorkflowAuthoringCompiler(context,{requiredCoverageIds:input.requiredCoverageIds})
      }
      console.log(JSON.stringify({tool:'workflow_compile',status:'bound',schema:compiler.nextSchema??compiler.schema,instructions:compiler.instructions,...(compiler instanceof TemplateFillingCompiler?{templateCatalog:compiler.catalog()}:{} )}))
      continue
    }
    if(compiler instanceof TemplateFillingCompiler&&input.query!==undefined){
      if(Object.keys(input).length!==1)throw Error('Template query cannot be combined with a submission')
      const query=templateQuerySchema.parse(input.query)
      console.log(JSON.stringify({tool:'workflow_compile',status:'templates',...queryPlanningTemplates(compiler,query.ids),schema:compiler.nextSchema}))
      continue
    }
    const issues=submissionSchemaIssues(compiler.nextSchema??compiler.schema,input)
    const result=issues.length?compiler.rejectWire(input,issues):compiler.submit(input)
    if(result.ok){
      accepted=true
      const value=result.value as any
      console.log(JSON.stringify({tool:'workflow_compile',status:'accepted',...value,...(value.candidate?{package:exportWorkflowPackage(value.candidate)}:{})}))
      break
    }
    console.log(JSON.stringify({tool:'workflow_compile',...result.feedback,schema:compiler.nextSchema??compiler.schema}))
    if(!result.feedback.remainingSubmissions){process.exitCode=1;break}
  }catch(error){
    console.log(JSON.stringify({tool:'workflow_compile',status:'failed',code:(error as any)?.code??'INVALID_INPUT',message:error instanceof Error?error.message:String(error)}))
    process.exitCode=1;break
  }
}
if(!accepted&&!process.exitCode){
  console.log(JSON.stringify({tool:'workflow_compile',status:'failed',code:'INCOMPLETE_INPUT',message:'输入在编译接受结果之前结束'}))
  process.exitCode=1
}
