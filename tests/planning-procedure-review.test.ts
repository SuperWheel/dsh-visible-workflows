import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { createProcedureCompiler } from '../src/shared/planning-procedure-compiler.ts'
import { parseTaskProcedure, taskSpecificationRefs, type ConversationEvidence, type TaskProcedure } from '../src/shared/retrospective.ts'
import { conversationEvidenceDigest } from '../src/host/planning/conversation-evidence.ts'
import { WorkflowPlanningService } from '../src/host/planning/service.ts'
import { ModelAdmission } from '../src/host/run-usage.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'

const recorded=JSON.parse(readFileSync(new URL('./fixtures/planning-compiler/desktop-empty-review-evidence.json',import.meta.url),'utf8'))
function inputs(){
  const data={version:1 as const,sessionId:'trial-child',fromSeq:1,throughSeq:6,records:Array.from({length:6},(_,i)=>({id:'e'+(i+1),seq:i+1,kind:i%2?'tool-result' as const:'tool-call' as const,text:i%2?'artifact receipt':'artifact operation',toolName:i<2||i>3?'read':'write',callId:'call-'+Math.floor(i/2),status:'reported-success' as const,truncated:false})),warnings:[]}
  const evidence:ConversationEvidence={...data,digest:conversationEvidenceDigest(data)}
  const trialTask={task:'Read, write and read back an artifact',inputs:['input.json'],artifacts:[{path:'output.json',format:'json' as const,checks:[{kind:'json-type' as const,pointer:'',value:'object' as const}]}],reviewItems:['每次运行保留真人核对产物是否合适。']}
  const procedure:TaskProcedure={goal:'Reusable artifact processing',parameters:[],rules:[],steps:[
    {id:'s1',title:'Read input',instruction:'Read input',dependsOn:[],evidenceRefs:['e1','e2'],requiresReview:false},
    {id:'s2',title:'Write artifact',instruction:'Write artifact',dependsOn:['s1'],evidenceRefs:['e3','e4'],requiresReview:false},
    {id:'s3',title:'Read back and review',instruction:'Read back the artifact; require human review on each future run.',dependsOn:['s2'],evidenceRefs:['e5','e6'],requiresReview:true,specRefs:['trialTask.reviewItems[0]']},
  ],excluded:[],reviewItems:trialTask.reviewItems}
  return {evidence,trialTask,procedure}
}

describe('recorded empty review evidence contract',()=>{
  it('explains the real standalone s4 failure at the exact leaf without broadening its region',()=>{
    const {evidence,trialTask,procedure}=inputs(),wire=structuredClone(recorded.wire)
    wire.procedure={...procedure,steps:[...procedure.steps.map(step=>({...step,requiresReview:false,specRefs:[]})),recorded.emptyReviewStep]}
    const c=createProcedureCompiler(evidence,trialTask)
    assertObjectJsonSchema(c.schema)
    // SDK has no minItems keyword. The wire states the minimum, while Host
    // enforces cardinality; no unsupported keyword may block every request.
    const initial=(c.schema.properties!.submission!.oneOf![0] as any).properties.procedure
    expect(initial.properties.steps.items.properties.evidenceRefs.description).toContain('至少1')
    expect(initial.properties.steps.items.properties.requiresReview.description).toContain('未来')
    expect(validateJsonSchemaValue(c.schema,{submission:wire})).toEqual([])
    const failed=c.submit({submission:wire});if(failed.ok)throw Error('Empty observed step accepted')
    expect(failed.feedback.issues).toHaveLength(1)
    expect(failed.feedback.issues[0]!.path).toBe('/procedure/steps/3/evidenceRefs')
    expect(failed.feedback.issues[0]!.message).toContain('至少1')
    expect(failed.feedback.issues[0]!.message).toContain('specRefs')
    expect(failed.feedback.issues[0]!.message).toContain('已执行')
    expect(failed.feedback.allowedPaths).toEqual(['/procedure/steps/3/evidenceRefs'])
    expect(failed.feedback.fragments).toEqual({'/procedure/steps/3/evidenceRefs':[]})
    const before=c.snapshot().document
    const rejected=c.submit({submission:{mode:'repair',draftRevision:1,patches:[
      {op:'replace',path:'/procedure/steps/3/evidenceRefs',value:['e5','e6']},
      {op:'replace',path:'/procedure/steps/3/instruction',value:'Unrequested change'},
      {op:'replace',path:'/procedure/excluded',value:[]},
    ]}})
    if(rejected.ok)throw Error('Extra patch accepted')
    expect(rejected.feedback.issues[0]!.code).toBe('PATCH_SCOPE')
    expect(c.snapshot().document).toEqual(before)
  })
  it('permits a leaf-only repair using actual artifact events and preserves future review constraints',()=>{
    const {evidence,trialTask,procedure}=inputs(),c=createProcedureCompiler(evidence,trialTask)
    procedure.steps[2]!.evidenceRefs=[]
    const failed=c.submit({submission:{mode:'distill',procedure}});if(failed.ok)throw Error('Expected missing events')
    const before=c.snapshot().document as any
    const fixed=c.submit({submission:{mode:'repair',draftRevision:1,patches:[{op:'replace',path:'/procedure/steps/2/evidenceRefs',value:['e5','e6']}]}})
    if(!fixed.ok)throw Error(JSON.stringify(fixed.feedback))
    const result=JSON.parse(fixed.value.procedureJson)
    expect(result.steps[2]).toEqual({...before.procedure.steps[2],evidenceRefs:['e5','e6']})
    expect(result.steps.slice(0,2)).toEqual(before.procedure.steps.slice(0,2))
    expect(result.reviewItems).toEqual(trialTask.reviewItems)
    expect(()=>parseTaskProcedure(result,evidence,taskSpecificationRefs(trialTask))).not.toThrow()
    result.steps[2].specRefs=['trialTask.reviewItems[99]']
    expect(()=>parseTaskProcedure(result,evidence,taskSpecificationRefs(trialTask))).toThrow('规范')
    result.steps[2].specRefs=['trialTask.reviewItems[0]'];result.steps[2].evidenceRefs=['e999']
    expect(()=>parseTaskProcedure(result,evidence,taskSpecificationRefs(trialTask))).toThrow('证据')
  })
  it('allows an explicit clarification instead of inventing review events or escaping the repair region',()=>{
    const {evidence,trialTask,procedure}=inputs(),c=createProcedureCompiler(evidence,trialTask)
    procedure.steps.push(structuredClone(recorded.emptyReviewStep))
    const failed=c.submit({submission:{mode:'distill',procedure}});if(failed.ok)throw Error('Expected missing events')
    const result=c.submit({submission:{mode:'needs-input',summary:'没有独立的已执行人工复核事件，不能补造。',questions:[{id:'review-source',question:'是否将未来人工复核义务保留在有产物事件的业务步骤上？',options:['保留未来复核约束']}]}})
    expect(result.ok).toBe(true)
    if(!result.ok)throw Error(JSON.stringify(result.feedback))
    expect(result.value.outcome).toBe('needs-input')
    expect(result.value.procedureJson).toBe('')
    expect(c.snapshot().submissions).toBe(2)
    expect((c.snapshot().document as any).procedure).toBeUndefined()
  })
  it.each([true,false])('keeps explicit runtime review but does not gate final rehearsal notes (runtime review: %s)',async runtimeReview=>{
    const {evidence,trialTask,procedure}=inputs(),directory=mkdtempSync(join(tmpdir(),'procedure-review-')),context=templateContext()
    procedure.steps[2]!.requiresReview=runtimeReview
    procedure.steps[2]!.instruction=runtimeReview?'用户要求未来每次运行人工审核产物':'回读结果；最终报告列出质量备注'
    Object.assign(context,{conversation:evidence,trialTask,trial:{trialId:'trial',rootSessionId:'parent',childSessionId:evidence.sessionId,workspaceId:'workspace',specDigest:'1'.repeat(64),verificationDigest:'2'.repeat(64),evidenceDigest:evidence.digest,receiptDigest:'3'.repeat(64)}})
    const generate=vi.fn(async(input:any)=>{
      if(input.purpose==='distill'){
        expect(JSON.parse(input.prompt).instruction).toContain('未来每次')
        const result=input.compiler.submit({submission:{mode:'distill',procedure}})
        if(!result.ok)throw Error(JSON.stringify(result.feedback))
        return {output:result.value,steps:0}
      }
      const wire={submission:{mode:'create',title:'Artifact with required human review',forms:[
        {key:'start',template:'input',values:{fields:[]}},
        {key:'artifact',template:'template',values:{text:'artifact'}},
        {key:'result',template:'output',values:{text:'{{artifact.text}}',outputName:'result'}},
      ],chains:[{key:'main',nodes:['start','artifact','result']}],coverage:{R1:['artifact','result'],s1:['artifact'],s2:['artifact'],s3:['artifact']}}}
      const failed=input.compiler.submit(wire)
      if(!runtimeReview){expect(failed.ok).toBe(true);if(!failed.ok)throw Error(JSON.stringify(failed.feedback));return {output:failed.value,steps:0}}
      expect(failed.ok).toBe(false);expect(failed.feedback.issues.some((i:any)=>i.code==='REVIEW_REQUIRED')).toBe(true)
      const result=input.compiler.submit({submission:{mode:'repair',draftRevision:failed.feedback.draftRevision,patches:[
        {op:'add',path:'/formsByKey/review',value:{template:'human',values:{prompt:trialTask.reviewItems[0],fields:[],actions:[{id:'continue',label:'Confirm'}]}}},
        {op:'replace',path:'/chainsByKey/main/nodes',value:['start','artifact','review','result']},
        {op:'replace',path:'/coverage/s3',value:['artifact','review']},
      ]}})
      if(!result.ok)throw Error(JSON.stringify(result.feedback))
      return {output:result.value,steps:0}
    })
    const publish=vi.fn(),service=new WorkflowPlanningService({directory,compilerMode:'template-fill',driver:{generate},admission:new ModelAdmission(1,1),context:async()=>context,authorize(){},readiness:async flow=>({workflowId:flow.id,revision:flow.revision,canRun:true,issues:[]}),publish,receipt:()=>undefined})
    try{
      const task=await service.start({requestId:'future-review',operation:'create',instruction:runtimeReview?'每次运行必须人工审核产物':'自动完成，最后向我报告',preview:true,source:{kind:'verified-trial',trialId:'trial'}},{workspaceId:'workspace',sessionId:'parent',parent:{id:'parent'} as Agent,signal:new AbortController().signal})
      expect(task.state,JSON.stringify(task.diagnostics)).toBe('ready')
      expect(task.procedure!.steps[2]).toEqual(procedure.steps[2])
      if(runtimeReview){
        const human=task.candidate!.nodes.find(n=>n.kind==='human')!
        expect(human.config.prompt).toBe(trialTask.reviewItems[0])
        expect(task.sourceMap!.find(m=>m.stepId==='s3')!.nodeIds).toContain(human.id)
      }else expect(task.candidate!.nodes.some(n=>n.kind==='human')).toBe(false)
      expect(task.sourceMap!.find(m=>m.stepId==='s3')!.evidenceRefs).toEqual(['e5','e6'])
      expect(task.distillationAttempts).toBe(1);expect(task.candidateAttempts).toBe(runtimeReview?2:1)
      expect(generate).toHaveBeenCalledTimes(2);expect(publish).not.toHaveBeenCalled()
    }finally{await service.close();rmSync(directory,{recursive:true,force:true})}
  })
})

it('reports unknown rehearsal evidence without forcing runtime review or notes, preserving conversation review requirements',()=>{
  const {evidence,trialTask,procedure}=inputs()
  evidence.records[0]!.status='unknown';evidence.records[0]!.truncated=true
  procedure.steps.forEach(step=>{step.requiresReview=false})
  expect(()=>parseTaskProcedure(procedure,evidence,taskSpecificationRefs(trialTask))).toThrow('必须标记复核')
  expect(()=>parseTaskProcedure(procedure,evidence,taskSpecificationRefs(trialTask),true)).not.toThrow()
  expect(createProcedureCompiler(evidence,trialTask).submit({submission:{mode:'distill',procedure}}).ok).toBe(true)
  procedure.reviewItems=[]
  expect(parseTaskProcedure(procedure,evidence,taskSpecificationRefs(trialTask),true).reviewItems).toEqual([])
  expect(createProcedureCompiler(evidence,trialTask).submit({submission:{mode:'distill',procedure}}).ok).toBe(true)
})
