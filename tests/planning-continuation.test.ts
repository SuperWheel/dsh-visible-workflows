import { describe,expect,it,vi } from 'vitest'
import { assertObjectJsonSchema,validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { CompilerError,RepairSession,submissionSchema } from '../src/shared/planning-repair.ts'
import { hostRepairCheckpointSchema,sealRepairCheckpoint } from '../src/shared/planning-continuation.ts'
import { filling,templateContext } from './fixtures/planning-compiler/template.ts'
import { r28,r28Filling,r28Repair,r28Corrected } from './fixtures/planning-compiler/r28.ts'
import { submissionSchemaIssues } from '../src/shared/planning-submission-schema.ts'
const scope=JSON.stringify(['workspace','main-session','task-1','author'])
const question={submission:{mode:'needs-input',questions:[{id:'format',question:'确认输出形式',options:['文本']}],summary:'等待补充信息'}}
const badFilling=()=>{const wire=filling();wire.submission.forms[1].values.text=42;return wire}
const fix={submission:{mode:'repair',draftRevision:1,patches:[{op:'replace',path:'/formsByKey/greet/values/text',value:'你好 {{input.name}}'}]}}
const reverseKeys=(value:any):any=>Array.isArray(value)?value.map(reverseKeys):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reverseKeys(item)])):value

describe('Host-bound planning checkpoints and delta continuation',()=>{
  it.each(['live','restore-before-repair','restore-after-repair'] as const)('keeps the r28 schema rejection and draftless repair checkpoint valid: %s',path=>{
    const context=templateContext(),observe=vi.fn()
    let compiler=new TemplateFillingCompiler(context,{resumeScope:scope,onSubmission:observe})
    compiler.queryTemplates(['if'])
    expect(compiler.checkpoint()).toMatchObject({state:'empty',submissions:0})
    const initial=r28Filling(),issues=submissionSchemaIssues(compiler.nextSchema,initial)
    expect(issues).toHaveLength(1);expect(issues[0]!.message).toContain('conditions[1].gte')
    expect(compiler.rejectWire(initial,issues)).toMatchObject({ok:false,feedback:{draftRevision:0,remainingSubmissions:2}})
    expect(compiler.checkpoint()).toMatchObject(r28.checkpoint)
    if(path==='restore-before-repair')compiler=new TemplateFillingCompiler(context,{resumeScope:scope,resume:JSON.parse(JSON.stringify(compiler.checkpoint())),onSubmission:observe})
    const repaired=compiler.submit(r28Repair())
    expect(repaired).toMatchObject({ok:false,feedback:{draftRevision:0,remainingSubmissions:1,allowedPaths:[],issues:[{code:'PATCH_NO_DRAFT',message:expect.stringContaining('create')}]}})
    const saved=compiler.checkpoint()!
    expect(saved).toMatchObject({state:'clarification',revision:0,submissions:2,issues:[]})
    expect(saved).not.toHaveProperty('document');expect(hostRepairCheckpointSchema.safeParse(saved).success).toBe(true)
    expect(observe.mock.calls[1]![0]).toMatchObject({document:r28Repair().submission,issues:[{code:'PATCH_NO_DRAFT'}],checkpoint:saved})
    if(path==='restore-after-repair')compiler=new TemplateFillingCompiler(context,{resumeScope:scope,resume:JSON.parse(JSON.stringify(saved)),onSubmission:observe})
    expect(compiler.continuation()).toMatchObject({hasDraft:false,remainingSubmissions:1,unresolved:[]})
    expect(validateJsonSchemaValue(compiler.nextSchema,r28Corrected())).toEqual([])
    expect(compiler.submit(r28Corrected()).ok).toBe(true)
    expect(compiler.checkpoint()).toMatchObject({state:'accepted',revision:1,submissions:3})
    expect(()=>compiler.submit(r28Corrected())).toThrow('已经接受')
  })
  it('rejects a draftless repair with a positive revision and preserves the original cap after restore',()=>{
    const context=templateContext(),compiler=new TemplateFillingCompiler(context,{resumeScope:scope})
    compiler.queryTemplates(['if']);compiler.rejectWire(r28Filling(),submissionSchemaIssues(compiler.nextSchema,r28Filling()))
    expect(compiler.submit(r28Repair(1))).toMatchObject({ok:false,feedback:{issues:[{code:'PATCH_NO_DRAFT'}],remainingSubmissions:1}})
    const resumed=new TemplateFillingCompiler(context,{resumeScope:scope,resume:compiler.checkpoint()!})
    expect(()=>resumed.submit(r28Repair(1))).toThrow('同一草稿和错误重复')
    expect(resumed.checkpoint()).toMatchObject({submissions:3,maxSubmissions:3,issues:[]})
    expect(()=>resumed.submit(r28Corrected())).toThrow('达到本阶段提交与修复上限')
  })
  it('retains a failed draft across needs-input and resumes only the local repair with the cumulative budget',()=>{
    const context=templateContext(),firstObserve=vi.fn(),compiler=new TemplateFillingCompiler(context,{resumeScope:scope,onSubmission:firstObserve})
    expect(compiler.submit(badFilling()).ok).toBe(false)
    const draft=compiler.snapshot().document
    expect(compiler.submit(question).ok).toBe(true)
    const saved=compiler.checkpoint()!
    expect(saved).toMatchObject({state:'clarification',revision:1,submissions:2,maxSubmissions:3,document:draft})
    expect(firstObserve.mock.calls[1]![0]).toMatchObject({document:question.submission,checkpoint:saved})
    const observe=vi.fn(),resumed=new TemplateFillingCompiler(context,{resumeScope:scope,resume:JSON.parse(JSON.stringify(saved)),onSubmission:observe})
    expect(observe).not.toHaveBeenCalled();expect(resumed.snapshot().submissions).toBe(2)
    const delta=resumed.continuation()!
    expect(delta).toMatchObject({kind:'draft-repair',hasDraft:true,draftRevision:1,submissions:2,remainingSubmissions:1})
    expect(delta.unresolved).toContain('/formsByKey/greet/values/text')
    expect(JSON.stringify(delta)).not.toContain('formsByKey":{"start"')
    assertObjectJsonSchema(resumed.nextSchema);expect(validateJsonSchemaValue(resumed.nextSchema,fix)).toEqual([])
    const accepted=resumed.submit(fix);expect(accepted.ok).toBe(true);expect(resumed.snapshot().submissions).toBe(3)
    expect(observe).toHaveBeenCalledTimes(1);expect((resumed.snapshot().document as any).formsByKey.start).toEqual((draft as any).formsByKey.start)
    expect(resumed.checkpoint()!.state).toBe('accepted')
  })
  it('does not invent a compiled draft when clarification was the first submission',()=>{
    const context=templateContext(),compiler=new TemplateFillingCompiler(context,{resumeScope:scope})
    expect(compiler.submit(question).ok).toBe(true)
    const saved=compiler.checkpoint()!
    expect(saved).toMatchObject({state:'clarification',revision:0,submissions:1,issues:[]});expect(saved).not.toHaveProperty('document')
    const resumed=new TemplateFillingCompiler(context,{resumeScope:scope,resume:saved})
    expect(resumed.continuation()).toMatchObject({kind:'initial-clarification',hasDraft:false,unresolved:[],remainingSubmissions:2})
    expect(resumed.continuation()).not.toHaveProperty('feedback')
    expect(resumed.submit(filling()).ok).toBe(true);expect(resumed.snapshot().submissions).toBe(2)
  })
  it('restores the queried template set and change candidates under its catalog digest',()=>{
    const context=templateContext(),compiler=new TemplateFillingCompiler(context,{resumeScope:scope,prefetch:['input','output','template']})
    compiler.queryTemplates(['code','http']);compiler.submit(question)
    const saved=compiler.checkpoint()!,resumed=new TemplateFillingCompiler(context,{resumeScope:scope,resume:saved,prefetch:['input']})
    expect(resumed.checkpoint()!.loadedContracts).toEqual(saved.loadedContracts)
    expect(resumed.catalog().prefetched.entries.map(entry=>entry.id)).toEqual(saved.loadedContracts!.templateIds)
    expect(resumed.continuation()!.contracts.loaded?.changeTemplateIds).toEqual(['code','http'])
  })
  it('rejects task ownership, context, schema, tool-contract and total-limit drift',()=>{
    const context=templateContext(),compiler=new TemplateFillingCompiler(context,{resumeScope:scope});compiler.submit(badFilling());const saved=compiler.checkpoint()!
    expect(()=>new TemplateFillingCompiler(context,{resume:saved})).toThrow('范围与合同')
    expect(()=>new TemplateFillingCompiler(context,{resumeScope:'other-task',resume:saved})).toThrow('不能复用')
    for(const change of [(c:typeof context)=>{c.workflow.revision++},(c:typeof context)=>{c.model.model='changed'},(c:typeof context)=>{c.workflow.workspaceId='other'},(c:typeof context)=>{c.tools.push({id:'native:new',name:'new',description:'new contract',providerId:'p',providerName:'p',category:'plugin',available:true,inputSchema:{type:'object'}})}]){
      const changed=structuredClone(context);change(changed)
      expect(()=>new TemplateFillingCompiler(changed,{resumeScope:scope,resume:saved})).toThrow()
    }
    expect(()=>new TemplateFillingCompiler(context,{resumeScope:scope,resume:saved,maxSubmissions:4})).toThrow('总提交次数上限')
    expect(()=>new WorkflowAuthoringCompiler(context,{resumeScope:scope,resume:saved})).toThrow('不能复用')
  })
  it('rejects corrupted or valid-candidate forgery and never imports model checkpoints',()=>{
    const context=templateContext(),compiler=new TemplateFillingCompiler(context,{resumeScope:scope});compiler.submit(badFilling());const saved=compiler.checkpoint()!
    const tampered=structuredClone(saved);(tampered.document as any).formsByKey.greet.values.text='forged'
    expect(()=>new TemplateFillingCompiler(context,{resumeScope:scope,resume:tampered})).toThrow('损坏或无效')
    const {digest:_,...body}=tampered,resealed=sealRepairCheckpoint(body)
    expect(()=>new TemplateFillingCompiler(context,{resumeScope:scope,resume:resealed})).toThrow('禁止重新开放')
    expect(hostRepairCheckpointSchema.safeParse({...saved,submissions:0}).success).toBe(false)
    const resumed=new TemplateFillingCompiler(context,{resumeScope:scope,resume:saved})
    const injected=resumed.submit({submission:{...fix.submission,checkpoint:saved}})
    expect(injected.ok).toBe(false);expect(resumed.snapshot().document).toEqual(saved.document)
  })
  it('derives current repair authority again even if saved issue claims are resealed',()=>{
    const context=templateContext(),compiler=new TemplateFillingCompiler(context,{resumeScope:scope});compiler.submit(badFilling());const saved=compiler.checkpoint()!
    const {digest:_,...body}=saved,claimed=sealRepairCheckpoint({...body,issues:[{code:'FAKE',message:'overwrite the whole graph',allowedPaths:['/coverage']}]})
    const resumed=new TemplateFillingCompiler(context,{resumeScope:scope,resume:claimed}),delta=resumed.continuation()!
    expect(delta.feedback!.issues[0]!.code).not.toBe('FAKE');expect(delta.unresolved).not.toContain('/coverage')
    const denied=resumed.submit({submission:{mode:'repair',draftRevision:1,patches:[{op:'replace',path:'/coverage',value:{R1:['start']}}]}})
    expect(denied.ok).toBe(false);if(!denied.ok)expect(denied.feedback.issues[0]!.code).toBe('PATCH_SCOPE')
    expect(resumed.submit(fix).ok).toBe(true)
  })
  it('preserves attempt exhaustion and repeated-failure detection across fresh compiler instances',()=>{
    const context=templateContext(),compiler=new TemplateFillingCompiler(context,{resumeScope:scope});compiler.submit(badFilling())
    const resumed=new TemplateFillingCompiler(context,{resumeScope:scope,resume:compiler.checkpoint()!})
    const denied={submission:{mode:'repair',draftRevision:1,patches:[{op:'replace',path:'/coverage',value:{R1:['start']}}]}}
    expect(resumed.submit(denied).ok).toBe(false)
    const again=new TemplateFillingCompiler(context,{resumeScope:scope,resume:reverseKeys(resumed.checkpoint()!)})
    expect(()=>again.submit(denied)).toThrow('同一草稿和错误重复')
    const exhausted=again.checkpoint()!;expect(exhausted.submissions).toBe(3)
    const last=new TemplateFillingCompiler(context,{resumeScope:scope,resume:exhausted})
    expect(()=>last.submit(fix)).toThrow('达到本阶段提交与修复上限');expect(last.snapshot().submissions).toBe(3)
  })
  it('uses canonical content identity while preserving local Host authorization checks',()=>{
    const context=templateContext(),compiler=new TemplateFillingCompiler(context,{resumeScope:scope});compiler.submit(badFilling())
    expect(()=>new TemplateFillingCompiler(reverseKeys(context),{resumeScope:scope,resume:reverseKeys(compiler.checkpoint()!)})).not.toThrow()
    let allowed=true;const compile=vi.fn((document:unknown)=>{if(!allowed)throw new CompilerError('COMPILER_FORBIDDEN','current permission revoked',undefined,true);return z.object({value:z.string()}).parse(document)})
    const schema=submissionSchema({type:'object'}),options={maxSubmissions:3,resumeScope:scope,contractDigest:'a'.repeat(64),roots:()=>['/value'],compile}
    const generic=new RepairSession(schema,options);generic.submit({submission:{value:42}})
    const before=compile.mock.calls.length,saved=generic.checkpoint()!;allowed=false
    expect(()=>new RepairSession(schema,{...options,resume:saved})).toThrow('current permission revoked');expect(compile).toHaveBeenCalledTimes(before+1)
  })
  it('supports the compact frontend with the same Host checkpoint contract',()=>{
    const context=templateContext(),compiler=new WorkflowAuthoringCompiler(context,{resumeScope:scope}),wire=filling()
    const compact={submission:{...wire.submission,nodes:wire.submission.forms.map(({template,values,...row}:any)=>({...row,kind:template,config:values}))}};delete compact.submission.forms;compact.submission.nodes[1].config.text=42
    expect(compiler.submit(compact).ok).toBe(false);compiler.submit(question)
    const resumed=new WorkflowAuthoringCompiler(context,{resumeScope:scope,resume:compiler.checkpoint()!})
    expect(resumed.continuation()!.unresolved).toContain('/nodesByKey/greet/config/text')
    expect(resumed.submit({submission:{mode:'repair',draftRevision:1,patches:[{op:'replace',path:'/nodesByKey/greet/config/text',value:'hello'}]}}).ok).toBe(true)
    expect(resumed.snapshot().submissions).toBe(3)
  })
})
