import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertPlanningToolOutputsUnchanged, buildPlanningToolOutputs, parsePlanningToolOutputSnapshot, PREVIOUS_BUILTIN_OUTPUTS, validatePlanningToolOutputs, type TrustedToolOutputSchema } from '../src/shared/planning-tool-outputs.ts'
import type { ToolChoice } from '../src/shared/types.ts'
import { BUILTIN_TOOLS } from '../src/shared/builtin-tools.ts'
import type { ConversationEvidence } from '../src/shared/retrospective.ts'
import { conversationEvidenceDigest } from '../src/host/planning/conversation-evidence.ts'
import { createTemplateBinding, templateIdForTool } from '../src/shared/planning-node-templates.ts'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { WorkflowPlanningService, type PlanningCaller } from '../src/host/planning/service.ts'
import { ModelAdmission } from '../src/host/run-usage.ts'
import { templateContext, filling } from './fixtures/planning-compiler/template.ts'

const tool:ToolChoice={id:'native:lookup',name:'lookup',description:'返回文本',providerId:'native:example',providerName:'example',category:'plugin',available:true,inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}}
const schema:TrustedToolOutputSchema={toolId:tool.id,sourceId:'native-tool:lookup',version:'sdk-canonical-output-v1',valuePath:'value',schema:{type:'string'}}
function evidence():ConversationEvidence {
  const value:Omit<ConversationEvidence,'digest'>={version:1,sessionId:'session',fromSeq:1,throughSeq:3,records:[
    {id:'e1',seq:1,kind:'user',text:'查一条记录',status:'statement',truncated:false},
    {id:'e2',seq:2,kind:'tool-call',toolName:'lookup',callId:'call-1',text:'{"query":"sensitive-input-not-for-catalog"}',status:'reported-success',truncated:false},
    {id:'e3',seq:3,kind:'tool-result',toolName:'lookup',callId:'call-1',text:'{"displayOnly":{"total":3},"secretLiteral":"never-copy-this-value"}',status:'reported-success',truncated:false},
  ],warnings:[]}
  return {...value,digest:conversationEvidenceDigest(value)}
}
function redigest(value:ConversationEvidence):ConversationEvidence{return {...value,digest:conversationEvidenceDigest(value)}}
const dirs:string[]=[],services:WorkflowPlanningService[]=[]
afterEach(async()=>{await Promise.all(services.splice(0).map(service=>service.close()));for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})

describe('planning-only output guarantees and observations',()=>{
  it('freezes schema provenance separately from the renderer observation and never copies sample values',()=>{
    const conversation=evidence(),snapshot=buildPlanningToolOutputs([tool],{schemas:[schema],conversation})
    expect(validatePlanningToolOutputs(snapshot,[tool],conversation)).toEqual(snapshot)
    const contract=snapshot.contracts[0]!
    expect(contract.guarantee.schema).toMatchObject({...schema,source:'host-tool-definition'})
    expect(contract.observations[0]).toMatchObject({representation:'rendered-tool-result',scope:'this-call-only',sessionId:'session',conversationDigest:conversation.digest,callId:'call-1',callEvidenceId:'e2',resultEvidenceId:'e3',shape:{type:'object',observedProperties:{displayOnly:{type:'object'}}}})
    const text=JSON.stringify(snapshot)
    expect(text).not.toContain('sensitive-input-not-for-catalog');expect(text).not.toContain('never-copy-this-value')
    const template=createTemplateBinding([tool],snapshot).templates.find(item=>item.id===templateIdForTool(tool.id))!
    expect(template.outputs.fields).toEqual({text:expect.any(String),value:expect.any(String)})
    expect(template.outputs.fields).not.toHaveProperty('value.displayOnly');expect(template.outputs.contract?.guarantee.schema?.schema).toEqual({type:'string'})
    expect(template.rules.join(' ')).toContain('不能据其 shape 推断 value')
  })
  it('keeps absent schemas and unknown tool outputs unknown, with no guessed business fields',()=>{
    const unknown={...tool,id:'swagger:unknown',name:'unknown'},snapshot=buildPlanningToolOutputs([unknown])
    const template=createTemplateBinding([unknown],snapshot).templates.find(item=>item.kind==='tool')!
    expect(template.outputs.status).toBe('unknown');expect(template.outputs.fields).toEqual({})
    expect(template.outputs.contract?.guarantee.schema).toBeUndefined();expect(template.outputs.contract?.observations).toEqual([])
    expect(buildPlanningToolOutputs([tool]).contracts[0]!.guarantee.schema).toBeUndefined()
  })
  it('is stable across object key order and blocks used schema/version/removal changes only',()=>{
    const other={...tool,id:'native:other',name:'other'},otherSchema={...schema,toolId:other.id,sourceId:'native-tool:other'}
    const snapshot=buildPlanningToolOutputs([tool,other],{schemas:[schema,otherSchema],conversation:evidence()})
    const reordered={schema:{type:'string'},valuePath:'value' as const,version:schema.version,sourceId:schema.sourceId,toolId:schema.toolId}
    expect(()=>assertPlanningToolOutputsUnchanged(snapshot,[other,tool],[tool.id],[otherSchema,reordered])).not.toThrow()
    for(const changed of [{...schema,version:'sdk-canonical-output-v2'},{...schema,schema:{type:'object'}},undefined]){
      expect(()=>assertPlanningToolOutputsUnchanged(snapshot,[tool,other],[tool.id],changed?[changed,otherSchema]:[otherSchema])).toThrow('输出保证已变化')
    }
    expect(()=>assertPlanningToolOutputsUnchanged(snapshot,[tool,other],[tool.id],[schema,{...otherSchema,version:'changed'}])).not.toThrow()
    expect(()=>assertPlanningToolOutputsUnchanged(snapshot,[other],[tool.id],[otherSchema])).toThrow('输出保证已变化')
  })
  it('retains old binding bytes when output metadata is absent and compiles the enriched binding without changing Workflow',()=>{
    const context=templateContext();context.tools=[tool]
    const old=createTemplateBinding(context.tools),template=old.templates.find(item=>item.kind==='tool')!
    expect(template.outputs).toEqual({status:'partial',source:'adapter-contract',fields:{text:'原始 value 的字符串或 JSON 文本。',value:'原始返回值。内部字段未知；仅凭本包装不能推断 value.text 或 value.result。'}})
    expect(template.outputs).not.toHaveProperty('contract')
    const baseline=new TemplateFillingCompiler(context).submit(filling())
    context.toolOutputs=buildPlanningToolOutputs(context.tools,{schemas:[schema]})
    const enriched=new TemplateFillingCompiler(context).submit(filling())
    expect(enriched.ok).toBe(true);expect(enriched).toEqual(baseline)
    const bound=createTemplateBinding(context.tools,context.toolOutputs)
    expect(bound.catalogDigest).not.toBe(old.catalogDigest)
    expect(()=>new TemplateFillingCompiler(context,{binding:old})).toThrow('冻结模板合同')
  })
  it('does not accept failed, unknown, truncated, unmatched, ambiguous or later calls as samples',()=>{
    const mutations=[
      (v:ConversationEvidence)=>{v.records[2]!.status='failed'},
      (v:ConversationEvidence)=>{v.records[2]!.status='unknown';v.records[2]!.truncated=true},
      (v:ConversationEvidence)=>{v.records[1]!.status='failed'},
      (v:ConversationEvidence)=>{v.records[1]!.status='unknown';v.records[1]!.truncated=true},
      (v:ConversationEvidence)=>{v.records[2]!.callId='other'},
      (v:ConversationEvidence)=>{v.records[2]!.toolName='other'},
      (v:ConversationEvidence)=>{v.records.splice(1,1)},
      (v:ConversationEvidence)=>{v.throughSeq=4;v.records.push({...v.records[2]!,id:'e4',seq:4})},
      (v:ConversationEvidence)=>{[v.records[1]!.kind,v.records[2]!.kind]=['tool-result','tool-call']},
    ]
    for(const mutate of mutations){const value=evidence();mutate(value);expect(buildPlanningToolOutputs([tool],{conversation:redigest(value)}).contracts[0]!.observations).toEqual([])}
    const duplicate={...tool,id:'swagger:duplicate'}
    const unknownNative={...tool,id:'swagger:first'}
    expect(buildPlanningToolOutputs([unknownNative,duplicate],{conversation:evidence()}).contracts.every(c=>!c.observations.length)).toBe(true)
  })
  it('ties sample validation to the exact frozen conversation and rejects digest/protocol/shape tampering',()=>{
    const conversation=evidence(),snapshot=buildPlanningToolOutputs([tool],{schemas:[schema],conversation})
    const changed=redigest({...conversation,sessionId:'another-session'})
    expect(()=>validatePlanningToolOutputs(snapshot,[tool],changed)).toThrow('冻结上下文')
    const copied=structuredClone(snapshot);copied.contracts[0]!.observations[0]!.shape={type:'string'}
    expect(()=>parsePlanningToolOutputSnapshot(copied)).toThrow('摘要')
    expect(()=>parsePlanningToolOutputSnapshot({...snapshot,protocolVersion:2} as any)).toThrow()
    expect(()=>buildPlanningToolOutputs([tool],{conversation:{...conversation,digest:'0'.repeat(64)}})).toThrow('对话摘要')
    expect(()=>validatePlanningToolOutputs(snapshot,[tool])).toThrow('冻结上下文')
  })
  it('rejects unsupported schemas, foreign source identities, unavailable declarations and duplicates',()=>{
    for(const declaration of [
      {...schema,sourceId:'model-asserted'},
      {...schema,valuePath:'result'},
      {...schema,schema:{type:'string',pattern:'x'}},
      {...schema,toolId:'swagger:unknown'},
    ])expect(()=>buildPlanningToolOutputs([tool],{schemas:[declaration as TrustedToolOutputSchema]})).toThrow()
    expect(()=>buildPlanningToolOutputs([{...tool,available:false}],{schemas:[schema]})).toThrow('唯一可用')
    expect(()=>buildPlanningToolOutputs([tool],{schemas:[schema,schema]})).toThrow('唯一可用')
    expect(()=>buildPlanningToolOutputs([tool,tool])).toThrow('身份重复')
  })
  it('bounds observation shape depth and count while retaining the original evidence references',()=>{
    const value=evidence();value.throughSeq=7
    for(let seq=4;seq<=7;seq++)value.records.push({...value.records[seq%2===0?1:2]!,id:`e${seq}`,seq,callId:`call-${Math.floor(seq/2)}`})
    const snapshot=buildPlanningToolOutputs([tool],{conversation:redigest(value)})
    expect(snapshot.contracts[0]!.observations).toHaveLength(2)
    expect(snapshot.contracts[0]!.observations.map(item=>item.resultEvidenceId)).toEqual(['e3','e5'])
    const nested=evidence();nested.records[2]!.text=JSON.stringify({a:{b:{c:{d:{e:'do-not-copy'}}}}})
    const shape=buildPlanningToolOutputs([tool],{conversation:redigest(nested)}).contracts[0]!.observations[0]!.shape as any
    expect(shape.observedProperties.a.observedProperties.b.observedProperties.c.observedProperties.d).toEqual({type:'object'})
    nested.records[2]!.text=JSON.stringify(Object.fromEntries(Array.from({length:50},(_,i)=>['key'+i,i])))
    const wide=buildPlanningToolOutputs([tool],{conversation:redigest(nested)}).contracts[0]!.observations[0]!.shape as any
    expect(Object.keys(wide.observedProperties)).toHaveLength(40)
  })
  it('freezes output metadata atomically and reads it after restart, but refuses tampered context before any child',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'planning-output-contract-'));dirs.push(directory)
    const context=templateContext();context.tools=[tool];context.toolOutputs=buildPlanningToolOutputs(context.tools,{schemas:[schema]})
    const caller={parent:{id:'session'},sessionId:'session',workspaceId:'workspace',signal:new AbortController().signal} as PlanningCaller
    const generate=vi.fn(async(input:any)=>{const result=input.compiler.submit(filling());if(!result.ok)throw Error(JSON.stringify(result.feedback));return {output:result.value,steps:0}})
    const options:ConstructorParameters<typeof WorkflowPlanningService>[0]={directory,compilerMode:'template-fill',admission:new ModelAdmission(1,1),driver:{generate},context:async()=>context,authorize:()=>{},readiness:async flow=>({workflowId:flow.id,revision:0,canRun:true,issues:[]}),publish:async()=>{throw Error('no publish in offline fixture')},receipt:()=>undefined}
    const open=()=>{const service=new WorkflowPlanningService(options);services.push(service);return service}
    const service=open(),request={requestId:'contract',operation:'create',instruction:'生成问候',preview:true}
    const ready=await service.start(request,caller)
    expect(ready.state,JSON.stringify(ready.diagnostics)).toBe('ready');expect(ready.context?.toolOutputs).toEqual(context.toolOutputs)
    // Persist this ready preview as a non-preview fixture; no real publication occurs.
    const stored={...ready,preview:false};const file=join(directory,'planning','tasks.json')
    const {mkdirSync}=await import('node:fs');mkdirSync(join(directory,'planning'),{recursive:true})
    writeFileSync(file,JSON.stringify({version:1,tasks:[stored]}))
    expect(open().get(ready.id,caller).context?.toolOutputs).toEqual(context.toolOutputs)
    const raw=JSON.parse(readFileSync(file,'utf8'));raw.tasks[0].context.toolOutputs.contracts[0].guarantee.schema.version='tampered';writeFileSync(file,JSON.stringify(raw))
    expect(()=>open()).toThrow('摘要')
    const invalid=structuredClone(context);invalid.toolOutputs!.contracts[0]!.observations=[{source:'conversation-evidence'} as any]
    options.directory=mkdtempSync(join(tmpdir(),'planning-output-invalid-'));dirs.push(options.directory);options.context=async()=>invalid;generate.mockClear()
    const failed=await open().start({...request,preview:false},caller)
    expect(failed.state).toBe('failed');expect(failed.context).toBeUndefined();expect(failed.templateBinding).toBeUndefined();expect(generate).not.toHaveBeenCalled()
  })
  it('preserves output contract conflict identity and stops publication without another author call',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'planning-output-publish-'));dirs.push(directory)
    const context=templateContext();context.tools=[tool];context.toolOutputs=buildPlanningToolOutputs(context.tools,{schemas:[schema]})
    const caller={parent:{id:'session'},sessionId:'session',workspaceId:'workspace',signal:new AbortController().signal} as PlanningCaller
    const wire=filling();wire.submission.forms[1]={key:'greet',template:templateIdForTool(tool.id),values:{inputs:{query:'offline'}}};wire.submission.forms[2].values.text='{{greet.value}}'
    const generate=vi.fn(async(input:any)=>{const result=input.compiler.submit(wire);if(!result.ok)throw Error(JSON.stringify(result.feedback));return {output:result.value,steps:0}})
    const service=new WorkflowPlanningService({directory,compilerMode:'template-fill',admission:new ModelAdmission(1,1),driver:{generate},context:async()=>context,authorize:()=>{},readiness:async flow=>({workflowId:flow.id,revision:0,canRun:true,issues:[]}),
      publish:async()=>assertPlanningToolOutputsUnchanged(context.toolOutputs!,context.tools,[tool.id],[{...schema,schema:{type:'object'}}]),receipt:()=>undefined})
    services.push(service)
    const task=await service.start({requestId:'output-conflict',operation:'create',instruction:'查一条记录'},caller)
    expect(task.state).toBe('conflict');expect(task.diagnostics.at(-1)?.code).toBe('TOOL_OUTPUT_CONTRACT_CONFLICT')
    expect(task.candidateAttempts).toBe(1);expect(generate).toHaveBeenCalledOnce();expect(task.receipt).toBeUndefined()
  })
})

describe('builtin output versions (Desktop r50)',()=>{
  const builtins=BUILTIN_TOOLS.filter(item=>item.id==='builtin:file.stat')
  const frozenWith=(fields:Record<string,string>)=>buildPlanningToolOutputs(builtins,{builtinFields:new Map([['builtin:file.stat',fields]])})
  it('loads a task frozen with a builtin\'s previous output fields and asks for replanning only when it is published',()=>{
    const old=frozenWith({...PREVIOUS_BUILTIN_OUTPUTS['builtin:file.stat']![0]!})
    expect(validatePlanningToolOutputs(old,builtins).digest).toBe(old.digest)
    expect(()=>assertPlanningToolOutputsUnchanged(old,builtins,['builtin:file.stat'])).toThrow('使用的工具输出保证已变化：builtin:file.stat')
    expect(()=>assertPlanningToolOutputsUnchanged(old,builtins,[])).not.toThrow()
  })
  it('still rejects builtin fields that no version ever declared',()=>{
    expect(()=>validatePlanningToolOutputs(frozenWith({text:'string：伪造。'}),builtins)).toThrow('工具输出合同或样本不属于冻结上下文')
  })
  it('pins every builtin output contract: record the old fields in PREVIOUS_BUILTIN_OUTPUTS before changing one',()=>{
    const pinned=Object.fromEntries(buildPlanningToolOutputs(BUILTIN_TOOLS).contracts.map(contract=>[contract.toolId,contract.guarantee.digest.slice(0,12)]))
    expect(pinned).toMatchSnapshot()
  })
})
