import { describe,it,expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createRequire } from 'node:module'
import { readFileSync,readdirSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPlanningAgent,type PlanningSubagentService } from '../src/host/planning/agent.ts'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { r12Compiler,r12Fixture } from './fixtures/planning-compiler/r12.ts'
import { templateContext,filling } from './fixtures/planning-compiler/template.ts'
import { r28Filling,r28Repair,r28Corrected } from './fixtures/planning-compiler/r28.ts'
import { CompilerError,RepairSession,submissionSchema } from '../src/shared/planning-repair.ts'

// Integration against the installed SDK's real scope, registry, terminal tool and capture.
// Only managed activation scheduling and model generation are doubles. No network.
const toolRequire=createRequire(import.meta.resolve('@deepseek-ai/dsh-tools'))
const {createScope}=await import(pathToFileURL(toolRequire.resolve('@deepseek-ai/dsh-scope')).href)
const peers=readdirSync(resolve('node_modules/.pnpm')).filter(name=>name.startsWith('@deepseek-ai+dsh-subagent@0.2.1-rc.1_'))
if(peers.length!==1)throw Error('Native compiler integration requires one pinned subagent SDK version')
const {attachStructuredRuntime}=await import(pathToFileURL(join(resolve('node_modules/.pnpm'),peers[0]!,'node_modules/@deepseek-ai/dsh-subagent/lib/types/structured.js')).href)

async function exercise(blockFinal=false,invalidWireType=false,templateFill=false,automatic?:'success'|'revoked',r11=false,lateSchemaReject=false,r12=false,requestedTitle?:string,t26=false,r28Replay=false,titleMissing=false){
  const ctx=new Context(),sections:any[]=[],provided=ctx.provide('systemPrompt',{tools:()=>()=>{},section:(s:any)=>{sections.push(s);return()=>{}},getSectionOrder:()=>90} as any)
  const fiber=ctx.plugin(ToolRuntime,{mode:'native'});await fiber
  let executionContext!:Context
  const consumer=ctx.inject(['tools','systemPrompt'],c=>{executionContext=c});await consumer
  const parent:any={id:'parent',session:{header:{delegationDepth:0}}};let child:any,scope:any
  let authorityChecks=0
  const metricEvents:any[]=[],toolResults:any[]=[],captures:any[]=[],compiler=r12?r12Compiler():templateFill||r11||t26||r28Replay?new TemplateFillingCompiler(templateContext(),{requestedTitle,...(r28Replay?{resumeScope:'r28-offline-author'}:{})}):new RepairSession(submissionSchema({type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}),{
    maxSubmissions:3,roots:()=>['/text'],compile:value=>{if(value.text!=='valid')throw new CompilerError('INVALID','text must be valid','/text');return {canonical:'validated'}},
    ...(automatic?{uniqueRepair:()=>({patches:[{op:'replace' as const,path:'/text',value:'valid'}],reason:'trusted fixture rule with a known target value'})}:{}),
  })
  if(blockFinal)ctx.on('tools/post-execute',async(exec,result,next)=>exec.name!=='structured_output'||result.isError?next():{kind:'block',feedback:[{type:'text',text:'Denied by final Host policy'}]})
  const service:PlanningSubagentService={
    getProvider:()=>({inheritsParentContext:false,capabilities:{agentOptions:true,outputSchema:true,depthLimit:true}}),
    startActivation:async spec=>{
      child={id:spec.childId,session:{id:spec.childId,header:{parentSession:parent.id},deriveMessages:()=>[]},cancel:()=>{}}
      scope=createScope(executionContext,child);child.ctx=scope.ctx
      // Deliberate SDK/Host drift tests the last-resort non-acceptance path.
      const nativeSchema=structuredClone(spec.request.outputSchema)
      if(requestedTitle)expect(nativeSchema.properties!.submission!.oneOf![0]!.properties!.title).toEqual({type:'string',const:requestedTitle})
      if(lateSchemaReject){nativeSchema.properties!.sdkOnly={type:'string'};nativeSchema.required=[...nativeSchema.required!,'sdkOnly']}
      const native=attachStructuredRuntime(child.ctx,nativeSchema,()=>true)
      ctx.emit('agent/created',{agent:child,source:'startup'} as any)
      const result=(async()=>{
        const first=r28Replay?r28Filling():r12?r12Fixture('initial-args'):r11?JSON.parse(readFileSync(new URL('./fixtures/planning-compiler/t23-r11-rejected-args.json',import.meta.url),'utf8')):templateFill||t26?filling():{submission:{text:invalidWireType?42:'invalid'}}
        if(r28Replay){
          const queried=await child.ctx.tools.execute({callId:'query',name:'planner_node_templates',arguments:{ids:['if']},agent:child,signal:spec.signal})
          expect(queried.isError).toBe(false);expect(compiler.snapshot().submissions).toBe(0)
        }
        if(titleMissing)delete first.submission.title
        if(t26){first.submission.forms[1].text=first.submission.forms[1].values.text;delete first.submission.forms[1].values.text}
        if(templateFill){
          first.submission.forms[1].values.text=42
          const queried=await child.ctx.tools.execute({callId:'query',name:'planner_node_templates',arguments:{ids:['template']},agent:child,signal:spec.signal})
          expect(queried.isError).toBe(false)
        }
        if(r11){
          const queried=await child.ctx.tools.execute({callId:'query',name:'planner_node_templates',arguments:{ids:['input','code','template']},agent:child,signal:spec.signal})
          expect(queried.isError).toBe(false)
        }
        const rejected=await child.ctx.tools.execute({callId:'first',name:'structured_output',arguments:first,agent:child,signal:spec.signal})
        toolResults.push(rejected);captures.push(native.captured())
        if(automatic||t26)return {stopReason:'completed',structured:native.captured()?.value,output:[]}
        const feedback=JSON.parse(rejected.error.message)
        if(r28Replay){
          expect(feedback).toMatchObject({draftRevision:0,remainingSubmissions:2,issues:[{code:'COMPILER_TOOL_SCHEMA_INVALID'}]})
          const wrong=await child.ctx.tools.execute({callId:'second',name:'structured_output',arguments:r28Repair(),agent:child,signal:spec.signal})
          toolResults.push(wrong);captures.push(native.captured())
          expect(JSON.parse(wrong.error.message)).toMatchObject({draftRevision:0,remainingSubmissions:1,issues:[{code:'PATCH_NO_DRAFT'}]})
          expect(compiler.checkpoint!()).toMatchObject({state:'clarification',revision:0,submissions:2,issues:[]})
          const accepted=await child.ctx.tools.execute({callId:'third',name:'structured_output',arguments:r28Corrected(),agent:child,signal:spec.signal})
          toolResults.push(accepted);captures.push(native.captured())
          return {stopReason:'completed',structured:native.captured()?.value,output:[]}
        }
        const wireFailure=feedback.issues.some((issue:any)=>issue.code==='COMPILER_TOOL_SCHEMA_INVALID')
        if(titleMissing)expect(feedback.issues.map((issue:any)=>issue.path)).not.toContain('/title')
        let repaired:any
        if(r12){
          // Both writes lack a proven observation; preserve the historical review findings too.
          expect(feedback.issues.map((issue:any)=>issue.code)).toEqual(['FILE_WRITE_NEEDS_READ','FILE_WRITE_NEEDS_READ',...Array(3).fill('REVIEW_BEFORE_EFFECT')])
          expect(feedback.issues.slice(0,2).map((issue:any)=>[issue.nodeId,issue.path])).toEqual([
            ['allocated-6','/formsByKey/writeDraftFile/values/inputs/file_path'],
            ['allocated-11','/formsByKey/writeTarget/values/inputs/file_path'],
          ])
          repaired=r12Fixture('repair-rejected-args')
        }else if(wireFailure){
          expect(feedback.remainingSubmissions).toBe(2);expect(compiler.snapshot().revision).toBe(0)
          expect(compiler.snapshot().document).toBeUndefined()
          repaired=structuredClone(first)
          if(r11){expect(JSON.stringify(feedback)).toContain('value.submission.title');repaired.submission.title=requestedTitle??'成绩分级'}
          else if(templateFill)repaired.submission.forms[1].values.text='valid'
          else repaired.submission.text='valid'
        }else repaired={submission:{mode:'repair',draftRevision:feedback.draftRevision,patches:[{op:'replace',path:templateFill?'/formsByKey/greet/values/text':'/text',value:'valid'}]}}
        const accepted=await child.ctx.tools.execute({callId:'second',name:'structured_output',arguments:repaired,agent:child,signal:spec.signal})
        toolResults.push(accepted);captures.push(native.captured())
        return {stopReason:'completed',structured:native.captured()?.value,output:[]}
      })()
      return{childId:child.id,result,dispose:async()=>{await result.catch(()=>{});await scope.dispose()}}
    },
  }
  try{
    const driver=createPlanningAgent({ctx,subagents:()=>service,childForId:()=>child})
    const pending=driver.generate({parent,model:{provider:'offline',model:'double'},prompt:'test',signal:new AbortController().signal,tools:[],maxSteps:3,compiler,onMetric:metric=>metricEvents.push(metric),beforeSubmission:()=>{authorityChecks++;if(automatic==='revoked'&&authorityChecks===2)throw new CompilerError('AUTHORITY_REVOKED','authority changed',undefined,true)},...(compiler instanceof TemplateFillingCompiler?{templateQuery:(ids:readonly string[])=>compiler.queryTemplates(ids)}:{})})
    if(r28Replay){
      expect((await pending).output).toHaveProperty('candidate.nodes.length',3)
      expect(toolResults.map(result=>!!result.isError)).toEqual([true,true,false])
      expect(captures.slice(0,2)).toEqual([undefined,undefined]);expect(captures[2].value).toEqual(r28Corrected())
      expect(compiler.snapshot().submissions).toBe(3)
      expect(metricEvents.filter(metric=>metric.phase==='compile')).toHaveLength(3)
      expect(metricEvents.filter(metric=>metric.phase==='host-unique-repair')).toHaveLength(0)
      return
    }
    if(automatic==='revoked'){
      await expect(pending).rejects.toMatchObject({code:'AUTHORITY_REVOKED'})
      expect(authorityChecks).toBe(2);expect(compiler.snapshot().submissions).toBe(1)
      expect(metricEvents.filter(metric=>metric.phase==='host-unique-repair')).toHaveLength(0)
      return
    }
    if(r12){
      await expect(pending).rejects.toMatchObject({code:'PLANNING_OUTPUT_INCOMPLETE'})
      expect(toolResults).toHaveLength(2)
      const feedback=JSON.parse(toolResults[1].error.message)
      expect(feedback).toMatchObject({draftRevision:2,remainingSubmissions:1})
      expect(feedback.issues.map((issue:any)=>issue.code)).toEqual(['FILE_WRITE_NEEDS_READ','FILE_WRITE_NEEDS_READ',...Array(4).fill('REVIEW_BEFORE_EFFECT')])
      expect(feedback.issues.slice(0,2).map((issue:any)=>[issue.nodeId,issue.path])).toEqual([
        ['allocated-6','/formsByKey/writeDraftFile/values/inputs/file_path'],
        ['allocated-11','/formsByKey/writeTarget/values/inputs/file_path'],
      ])
      expect((compiler.snapshot().document as any).formsByKey).toHaveProperty('approvedMsg')
      expect(captures).toEqual([undefined,undefined])
      expect(metricEvents.filter(metric=>metric.phase==='compile')).toHaveLength(2)
      return
    }
    if(lateSchemaReject)await expect(pending).rejects.toMatchObject({code:'COMPILER_COMMIT_REJECTED',message:'工具参数未通过 SDK 工具 Schema 校验，未接受候选'})
    else if(blockFinal)await expect(pending).rejects.toMatchObject({code:'COMPILER_COMMIT_REJECTED'})
    else if(templateFill||r11||t26)expect((await pending).output).toHaveProperty('candidate.nodes.length',3)
    else expect((await pending).output).toEqual({canonical:'validated'})
    if(t26){
      expect(toolResults).toHaveLength(1)
      expect(compiler.snapshot().submissions).toBe(2)
      expect(metricEvents.filter(metric=>metric.phase==='host-unique-repair')).toHaveLength(1)
      expect(metricEvents.filter(metric=>metric.phase==='submission')).toHaveLength(2)
      if(blockFinal||lateSchemaReject){expect(toolResults[0].isError).toBe(true);expect(captures[0]).toBeUndefined()}
      else {expect(toolResults[0].concludesTurn).toBe(true);expect(captures[0].value.submission.forms[1]).not.toHaveProperty('text');expect(captures[0].value.submission.forms[1].values.text).toBe('你好 {{input.name}}')}
      return
    }
    if(automatic){
      expect(toolResults).toHaveLength(1);expect(toolResults[0].isError).toBe(false);expect(toolResults[0].concludesTurn).toBe(true)
      expect(authorityChecks).toBe(2);expect(compiler.snapshot().submissions).toBe(2)
      expect(metricEvents.filter(metric=>metric.phase==='host-unique-repair')).toHaveLength(1)
      expect(metricEvents.filter(metric=>metric.phase==='repair')).toHaveLength(0)
      expect(metricEvents.filter(metric=>metric.phase==='repair-required')).toHaveLength(1)
      return
    }
    expect(toolResults[0].isError).toBe(true);expect(toolResults[0].concludesTurn).not.toBe(true);expect(captures[0]).toBeUndefined()
    if(blockFinal||lateSchemaReject){expect(toolResults[1].isError).toBe(true);expect(captures[1]).toBeUndefined()}
    else{expect(toolResults[1].isError).toBe(false);expect(toolResults[1].concludesTurn).toBe(true);expect(captures[1]?.value.submission.mode).toBe(templateFill?'create':invalidWireType||r11?undefined:'repair')}
    expect(compiler.snapshot().submissions).toBe(2)
    if(titleMissing)expect(captures[1].value.submission.title).toBe(requestedTitle)
    if(lateSchemaReject){expect(toolResults[1].error.info.code).toBe('INVALID_ARGS');expect(metricEvents.some(metric=>metric.phase==='compiler-accepted')).toBe(false)}
  }finally{await scope?.dispose();await consumer.dispose();await fiber.dispose();provided()}
}
describe('native DSH terminal compiler gate',()=>{
  it('replays r28 template query, schema-invalid create and draftless repair through the native terminal',async()=>{await exercise(false,false,false,undefined,false,false,false,undefined,false,true)})
  it('T26: strict wire rejection repairs once through the real SDK terminal, with two submission slots',async()=>{await exercise(false,false,false,undefined,false,false,false,undefined,true)})
  it('T26: repaired wire still obeys final native policy',async()=>{await exercise(true,false,false,undefined,false,false,false,undefined,true)})
  it('T26: repaired wire rejected by terminal schema drift cannot commit',async()=>{await exercise(false,false,false,undefined,false,true,false,undefined,true)})

  it('commits a unique Host repair in one native tool call, meters it separately, and rechecks authority',async()=>{await exercise(false,false,false,'success')})
  it('does not apply a unique Host repair after live authority changes',async()=>{await exercise(false,false,false,'revoked')})
  it('queries templates and repairs filling fields through the real terminal runtime',async()=>{await exercise(false,false,true)})
  it('does not accept a template candidate rejected by final native policy',async()=>{await exercise(true,false,true)})
  it('keeps rejected input nonterminal and commits only a validated native repair',async()=>{await exercise()})
  it('does not capture a success blocked by final native post-execute policy',async()=>{await exercise(true)})
  it('rejects invalid wire types before drafting and accepts a corrected resubmission',async()=>{await exercise(false,true)})
  it('replays r11 missing title as repairable and accepts the explicitly titled resubmission',async()=>{await exercise(false,false,false,undefined,true)})
  it('advertises request.title as const and accepts the matching name through the real SDK runtime',async()=>{await exercise(false,false,false,undefined,true,false,false,'T23 基线：成绩分级统计')})
  it('fills an omitted requested title before the schema gate and dispatches the filled value',async()=>{await exercise(false,false,true,undefined,false,false,false,'T24 r41：列表逐条写入',false,false,true)})
  it('replays r12 through the native Host gate into compiler review feedback, never schema rejection',async()=>{await exercise(false,false,false,undefined,false,false,true)})
  it('keeps an unexpected real SDK Schema rejection non-accepted and names the tool-argument failure',async()=>{await exercise(false,false,false,undefined,false,true)})
})
