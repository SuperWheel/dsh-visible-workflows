import {moduleCheck} from './fixtures/planning-module-check.ts'
import {createHash} from 'node:crypto'
import {existsSync,readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'
import {buildPlanningCommandBrief} from '../src/host/planning/command-brief.ts'
import {parsePlanningEntry} from '../src/host/planning/entry.ts'
import {BUSINESS_MODULE_INSTANCE_KEY_MAX_LENGTH,BUSINESS_MODULE_INSTANCE_KEY_RULE} from '../src/shared/planning-business-module-contract.ts'

const fixture=new URL('./fixtures/planning-compiler/t23-r13-initial-args.json',import.meta.url)
const originalRequest=()=>JSON.parse(JSON.parse(readFileSync(fixture,'utf8')).request_json)

describe('T23.18 readable entry and handoff rejection',()=>{
  const request=()=>({requestId:'module-rule',operation:'create',instruction:'只设计',execution:{mode:'design-only'},handoff:{version:1,mode:'module',module:{moduleId:'reviewed-file-write',version:'1.0.0',instanceKey:'review',parameters:{target:'report.txt',producer:{text:'正文'}}}}})
  function rejected(value:unknown){
    try{parsePlanningEntry(value,false)}catch(error){
      const message=(error as Error).message
      expect(message).not.toMatch(/^\s*\[/)
      expect(message).not.toContain('"code":')
      expect(message).not.toContain('"path":')
      return message
    }
    throw Error('Malformed entry must remain rejected')
  }
  it.each(['t20-review-file-write-r15','a'.repeat(BUSINESS_MODULE_INSTANCE_KEY_MAX_LENGTH+1),'1start','_start','含中文','a.b','a b',''])('rejects instanceKey %j with one exact Chinese rule',instanceKey=>{
    const value=request();value.handoff.module.instanceKey=instanceKey
    const before=structuredClone(value)
    expect(rejected(value)).toBe(`handoff.module.instanceKey：${BUSINESS_MODULE_INSTANCE_KEY_RULE}。`)
    expect(value).toEqual(before)
  })
  it('reports each actual issue with its path and rule, including module parameter refinements',()=>{
    const value=request();value.handoff.module.instanceKey='1bad';value.handoff.module.parameters.target='../outside.txt'
    const message=rejected({...value,title:'x'.repeat(161)})
    expect(message.split('\n')).toHaveLength(3)
    expect(message).toContain('title：数值过大：期望 string <=160 字符。')
    expect(message).toContain(`handoff.module.instanceKey：${BUSINESS_MODULE_INSTANCE_KEY_RULE}。`)
    expect(message).toContain('handoff.module.parameters.target：目标必须是字面量工作区根相对文件路径，不能是草稿目录或通配符。')
  })
  it.each([
    {instanceKey:7}, {version:'2.0.0'}, {moduleId:'unknown'}, {parameters:{target:'report.txt',producer:{}}},
  ])('keeps type, literal, discriminator and nested required-field rejections readable: %j',patch=>{
    const value=request()
    const message=rejected({...value,handoff:{...value.handoff,module:{...value.handoff.module,...patch}}})
    expect(message).toMatch(/handoff\.module/)
    expect(message).toMatch(/必须|期望|符合/)
  })
  it('replays the original r15 overlong key when local evidence is available without altering it',()=>{
    const source=new URL('../.test-data/t23/r15/session-cad44f5c-94c8-4b14-96a1-dd1b28b302ba.jsonl',import.meta.url)
    if(!existsSync(source))return
    const bytes=readFileSync(source),call=bytes.toString().split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(row=>row.type==='tool/call'&&row.data.name==='visible_workflow_plan')
    expect(call.seq).toBe(31)
    const value=JSON.parse(JSON.parse(call.data.arguments).request_json)
    expect(value.handoff.module.instanceKey).toBe('t20-review-file-write-r15')
    expect(rejected(value)).toBe(`handoff.module.instanceKey：${BUSINESS_MODULE_INSTANCE_KEY_RULE}。`)
    expect(readFileSync(source).equals(bytes)).toBe(true)
  })
})
function missingExecutionFeedback(request:Record<string,unknown>) {
  try{parsePlanningEntry(request,false)}catch(error){
    expect(error).toBeInstanceOf(Error)
    const message=(error as Error).message
    expect(message).toMatch(/^EXECUTION_SPEC_REQUIRED/)
    return {message,feedback:JSON.parse(message.slice(message.indexOf('{')))}
  }
  throw new Error('missing execution must fail closed')
}

describe('T23.16 missing execution feedback',()=>{
  it('preserves the first r13 tool call arguments byte for byte',()=>{
    const bytes=readFileSync(fixture)
    const digest=createHash('sha256').update(bytes).digest('hex')
    expect(digest).toBe('eb28c3dcef33cad9ab048c16f43664965926792306b8468ff7bb531b6b585842')
    const source=new URL('../.test-data/t23/r13/session-e69c3ba4-167b-4b70-989a-d5eaea2c7cc2.jsonl',import.meta.url)
    if(existsSync(source)){
      const call=readFileSync(source,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line))
        .find(row=>row.type==='tool/call'&&row.data.name==='visible_workflow_plan')
      expect(call?.seq).toBe(20)
      expect(bytes.equals(Buffer.from(call.data.arguments,'utf8'))).toBe(true)
    }
  })
  it('returns both exact command brief execution skeletons and the original identity',()=>{
    const request={...originalRequest(),moduleCheck},before=structuredClone(request)
    // The r13 instruction itself says design-only; Host must still require an explicit mode.
    expect(request).not.toHaveProperty('execution')
    const {message,feedback}=missingExecutionFeedback(request)
    const skeletons=JSON.parse(buildPlanningCommandBrief('workspace',[])).createRequestSkeletons
    expect(feedback).toEqual({requestId:request.requestId,operation:request.operation,executionOptions:{
      designOnly:{execution:skeletons.designOnly.execution},executeFirst:{execution:skeletons.executeFirst.execution},
    }})
    expect(message).toContain('仅用户明确“只设计/不要执行/先不要执行”')
    expect(message).toContain('Host不推断模式')
    expect(message).toContain('必要信息缺失时原生询问')
    expect(message).toContain('试做失败不得自动切换design-only')
    expect(message.length).toBeLessThan(800)
    expect(message).not.toContain(request.instruction)
    for(const option of Object.values(feedback.executionOptions)){
      const corrected={...request,...(option as {execution:unknown})}
      expect(()=>parsePlanningEntry(corrected,false)).not.toThrow()
    }
    expect(request).toEqual(before)
  })
  it('echoes the supplied title and exposes all required execute-first fields',()=>{
    const request={...originalRequest(),moduleCheck,title:'原请求标题'}
    const {feedback}=missingExecutionFeedback(request)
    expect(feedback).toMatchObject({requestId:request.requestId,operation:'create',title:request.title})
    const {execution}=feedback.executionOptions.executeFirst
    expect(execution).toMatchObject({mode:'execute-first',task:expect.any(String),tools:['read','write'],
      artifacts:[{path:expect.any(String),format:'text',checks:[{kind:'text-includes',value:expect.any(String)}]}]})
    for(const key of ['task','tools','artifacts']){
      const incomplete={...execution};delete incomplete[key]
      expect(()=>parsePlanningEntry({...request,execution:incomplete},false)).toThrow()
    }
  })
})
