import {createHash} from 'node:crypto'
import {existsSync,readFileSync} from 'node:fs'
import {describe,expect,it,vi} from 'vitest'
import {parsePlanningEntry} from '../src/host/planning/entry.ts'
import {planningCreateRequestSkeletons} from '../src/host/planning/command-brief.ts'
import {planningModuleHint} from '../src/host/planning/module-hint.ts'
import type {PlanningTask} from '../src/host/planning/service.ts'
import * as modules from '../src/shared/planning-business-modules.ts'
import {parsePlanningRequest} from '../src/shared/planning-schema.ts'
import {TemplateFillingCompiler} from '../src/shared/planning-template-compiler.ts'
import {templateIdForTool} from '../src/shared/planning-node-templates.ts'
import {templateContext} from './fixtures/planning-compiler/template.ts'
import {moduleCheck} from './fixtures/planning-module-check.ts'
import {r16Fixture,r16Tools} from './fixtures/planning-compiler/r16.ts'

const base={requestId:'route-check',operation:'create',instruction:'只设计流程',execution:{mode:'design-only'}}
function rejection(value:unknown,readOnly=false){try{parsePlanningEntry(value,readOnly)}catch(error){return (error as Error).message}throw Error('expected rejection')}
describe('T23.19 explicit module route entry',()=>{
  it.each([undefined,{checked:[],notApplicable:'无适用模块'}, {...moduleCheck,checked:[moduleCheck.checked[0]]},
    {...moduleCheck,checked:[...moduleCheck.checked,'extra@1.0.0']},{...moduleCheck,checked:[moduleCheck.checked[0],moduleCheck.checked[0]]},
    {...moduleCheck,checked:['wrong@1.0.0',moduleCheck.checked[1]]},{...moduleCheck,notApplicable:''},{...moduleCheck,notApplicable:'   '},
    {...moduleCheck,notApplicable:'x'.repeat(401)},{...moduleCheck,checked:'not an array'},{...moduleCheck,notApplicable:5},
  ])('rejects an absent or invalid route audit %j with catalog and actionable skeleton',invalid=>{
    const message=rejection({...base,moduleCheck:invalid}),feedback=JSON.parse(message.slice(message.indexOf('{')))
    expect(message).toMatch(/^MODULE_CHECK_REQUIRED：设计新建前请逐个对照/)
    for(const module of modules.businessModuleCatalog()){
      expect(message).toContain(`${module.id}@${module.version}`);expect(message).toContain(module.applicability)
    }
    expect(feedback.module).toEqual(planningCreateRequestSkeletons().module)
    expect(feedback.moduleInstanceKeyRule).toBe(planningCreateRequestSkeletons().moduleInstanceKeyRule)
    expect(message).not.toMatch(/"code":|"path":/)
  })
  it('requires a route audit for read-only and execute-first too, and combines both omissions',()=>{
    expect(rejection(base,true)).toContain('MODULE_CHECK_REQUIRED')
    expect(rejection({...base,execution:planningCreateRequestSkeletons().executeFirst.execution})).toContain('MODULE_CHECK_REQUIRED')
    const message=rejection({...base,execution:undefined})
    expect(message).toMatch(/^EXECUTION_SPEC_REQUIRED/);expect(message).toContain('MODULE_CHECK_REQUIRED')
    const feedback=JSON.parse(message.slice(message.indexOf('{')))
    expect(feedback.executionOptions).toHaveProperty('executeFirst.execution.artifacts')
    for(const execution of [feedback.executionOptions.designOnly.execution,feedback.executionOptions.executeFirst.execution])
      expect(()=>parsePlanningEntry({...base,moduleCheck,execution},false)).not.toThrow()
  })
  it('accepts exact sets in any order and checks no reason semantics',()=>{
    const check={checked:[...moduleCheck.checked].reverse(),notApplicable:'  任意理由  '}
    expect(parsePlanningEntry({...base,moduleCheck:check},false).request.moduleCheck).toEqual({...check,notApplicable:'任意理由'})
    expect(()=>parsePlanningEntry({...base,moduleCheck:{...moduleCheck,notApplicable:'x'.repeat(400)}},true)).not.toThrow()
  })
  it('does not gate module, partial, edit, revise or source/internal requests',()=>{
    const module=modules.businessModuleCatalog()[0]!
    expect(()=>parsePlanningEntry({...base,handoff:{version:1,mode:'module',module:{moduleId:module.id,version:module.version,instanceKey:'table',parameters:module.parameterExample}}},false)).not.toThrow()
    const revise={requestId:'revise',operation:'revise',instruction:'修改',targetWorkflowId:'flow',expectedRevision:1}
    for(const handoff of [undefined,{version:1,mode:'edit',changes:[{op:'set-title',nodeId:'node',value:'标题'}]},
      {version:1,mode:'partial',changes:[],unresolved:[{nodeId:'node',fields:['text'],question:'正文'}]}])
      expect(()=>parsePlanningEntry({...revise,...(handoff?{handoff}:{})},false)).not.toThrow()
    const source={...base,execution:undefined,preview:true,source:{kind:'verified-trial',trialId:'trial-source'}}
    expect(()=>parsePlanningEntry(source,false)).not.toThrow()
    // Shared/internal request parsing deliberately has no current-catalog gate.
    expect(parsePlanningRequest({requestId:'internal',operation:'create',instruction:'内部设计'})).not.toHaveProperty('moduleCheck')
  })
  it('does not require an audit for an empty business catalog',()=>{
    const spy=vi.spyOn(modules,'businessModuleCatalog').mockReturnValue([])
    try{expect(()=>parsePlanningEntry(base,false)).not.toThrow()}finally{spy.mockRestore()}
  })
})

function recordedTask(){
  const context={...templateContext(),tools:r16Tools()},snapshots:any[]=[]
  const compiler=new TemplateFillingCompiler(context,{onSubmission:snapshot=>snapshots.push(snapshot)})
  compiler.queryTemplates(['input','output','template','if','loop','human','assigner',...context.tools.map(tool=>templateIdForTool(tool.id))])
  for(const name of ['initial-args','repair-args','last-repair-args'] as const)expect(compiler.submit(r16Fixture(name)).ok).toBe(false)
  const snapshot=snapshots.at(-1)
  expect(snapshot.issues.some((issue:any)=>issue.code==='REVIEW_BEFORE_EFFECT'&&issue.path==='/formsByKey/writeFinal/values/inputs/file_path')).toBe(true)
  return {state:'failed',request:{operation:'create'},diagnostics:[{code:'PLANNING_REPAIR_LIMIT',message:'达到上限'}],
    compilerDraft:{purpose:'author',format:'template-fill-v1',baseDigest:'a'.repeat(64),revision:snapshot.revision,document:snapshot.document,issues:snapshot.issues},context} as PlanningTask
}
describe('T23.19 deterministic failure module hint',()=>{
  it('pins byte-identical r16 tool arguments and feedback from the source journal',()=>{
    const rows=[['initial-args',27,'ead8947093cb088819bc1c1b76e79583e3bb38dbb1af9dab5bf6d8a56da979a3'],['repair-args',33,'9629ebc95fb224c7c571e3be359e3d92ffaa608fecb00c431d942c7af75b7b0d'],['feedback',34,'3ad18900f49b3f8d8211a1d352d61b11be072d7b25464a6e0258154135fdbb00'],['last-repair-args',39,'999dedb1ad6815819f2199a3479bbf6a334c32c54feb2e0c238a1b45b30f1a76']] as const
    const source=new URL('../.test-data/t23/r16/6a36294c-d67e-4d49-969f-557d170947e4.jsonl',import.meta.url)
    for(const [name,seq,hash] of rows){
      const bytes=readFileSync(new URL(`./fixtures/planning-compiler/t23-r16-${name}.json`,import.meta.url))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash)
      if(existsSync(source)){
        const row=readFileSync(source,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(row=>row.seq===seq)
        const original=name==='feedback'?row.data.message.content.find((part:any)=>part.type==='text').text:row.data.arguments
        expect(bytes.equals(Buffer.from(original))).toBe(true)
      }
    }
    expect(r16Fixture('feedback').issues.some((issue:any)=>issue.code==='REVIEW_BEFORE_EFFECT'&&issue.path.includes('/writeFinal/'))).toBe(true)
  })
  it('replays all three real submissions, retaining the final failed write diagnostics',()=>{
    const task=recordedTask(),before=structuredClone(task),hint=planningModuleHint(task)!
    expect(hint).toMatchObject({module:'reviewed-file-write@1.0.0',reason:'这些诊断对应模块已固化的结构'})
    expect(hint.applicability).toBe(modules.businessModuleCatalog()[1]!.applicability)
    expect(hint.parameterExample).toEqual(modules.businessModuleCatalog()[1]!.parameterExample)
    expect(()=>parsePlanningEntry(hint.skeleton,false)).not.toThrow()
    expect(task).toEqual(before)
    expect(planningModuleHint({...task,diagnostics:[{code:'PLANNING_DEADLINE_EXCEEDED',message:'截止'}]})).toEqual(hint)
    expect(planningModuleHint({...task,request:{...task.request,operation:'revise'}})).toEqual(hint)
    expect(planningModuleHint({...task,request:{...task.request,source:{kind:'verified-trial',trialId:'trial'}}})).toEqual(hint)
  })
  it('matches compact node and legacy candidate identities as well as template identities',()=>{
    const task=recordedTask(),issue={code:'REVIEW_BEFORE_EFFECT',message:'任意文本',path:'/nodesByKey/write/config/inputs/file_path'}
    const draft={...task.compilerDraft!,format:'compact-v1' as const,issues:[issue],document:{nodesByKey:{write:{kind:'tool',config:{toolId:'native:write'}}}}}
    expect(planningModuleHint({...task,compilerDraft:draft})).toBeDefined()
    const candidate=structuredClone(task.context!.workflow)
    candidate.nodes[0]={...candidate.nodes[0]!,kind:'tool',config:{toolId:'native:write'}}
    expect(planningModuleHint({...task,compilerDraft:undefined,candidate,diagnostics:[{...issue,nodeId:candidate.nodes[0]!.id}]})).toBeDefined()
    expect(planningModuleHint({...task,compilerDraft:undefined,candidate,diagnostics:[{...issue,nodeId:'unknown'}]})).toBeUndefined()
  })
  it('never matches prose, unrelated tools, resolved stale diagnostics or non-design failures',()=>{
    const task=recordedTask(),draft=task.compilerDraft!
    for(const patch of [{state:'ready'},{state:'blocked'},{state:'cancelled'},{request:{operation:'create',handoff:{mode:'module'}}},{request:{operation:'revise',handoff:{mode:'edit'}}},{compilerDraft:{...draft,purpose:'distill'}},
      {compilerDraft:{...draft,issues:[]}}, {compilerDraft:{...draft,issues:[{code:'UNRELATED',message:'REVIEW_BEFORE_EFFECT native:write',path:'/formsByKey/writeFinal/values/inputs/file_path'}]}},
      {compilerDraft:{...draft,issues:[{code:'REVIEW_BEFORE_EFFECT',message:'native:write',path:'/formsByKey/probe/values/inputs/pattern'}]}},
      {compilerDraft:{...draft,issues:[{code:'REVIEW_BEFORE_EFFECT',message:'native:write'}]}},
    ])expect(planningModuleHint({...task,...patch} as PlanningTask)).toBeUndefined()
  })
})
