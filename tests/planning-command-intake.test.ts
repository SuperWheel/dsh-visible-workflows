import {moduleCheck} from './fixtures/planning-module-check.ts'
import {describe,it,expect,vi} from 'vitest'
import {CommandIntakeCompiler} from '../src/host/planning/command-intake.ts'
import {WorkflowAuthoringCompiler} from '../src/shared/planning-authoring.ts'
import {CompilerError} from '../src/shared/planning-repair.ts'
import {templateContext} from './fixtures/planning-compiler/template.ts'
import {parsePlanningEntry} from '../src/host/planning/entry.ts'
import {assertObjectJsonSchema,validateJsonSchemaValue} from '@deepseek-ai/dsh-tools'

function fixture(){
  const author=new WorkflowAuthoringCompiler(templateContext()),validate=vi.fn((value:unknown)=>{
    const request={requestId:'command-plan',operation:'create',instruction:'用户只设计的需求',...(value as Record<string,unknown>)}
    parsePlanningEntry(request,false);return request
  })
  return {author,validate,compiler:new CommandIntakeCompiler(author,validate,false)}
}
const create={mode:'create',title:'自定义流程',nodes:[{key:'start',kind:'input',config:{fields:[]}},{key:'text',kind:'template',config:{text:'内容'}},{key:'result',kind:'output',config:{text:'{{text.text}}',outputName:'result'}}],chains:[{key:'main',nodes:['start','text','result']}],coverage:{R1:['text','result']}}
describe('isolated command intake compiler',()=>{
  it('uses an SDK-valid schema and authors within the same submission compiler',()=>{
    const {compiler,author}=fixture(),value={submission:{mode:'design',moduleCheck,plan:create}}
    assertObjectJsonSchema(compiler.schema)
    validateJsonSchemaValue(compiler.schema,value)
    const result=compiler.submit(value)
    expect(result.ok).toBe(true)
    if(result.ok&&result.value.kind==='command-design')expect(result.value.compiled.candidate!.title).toBe('自定义流程')
    expect(author.snapshot().submissions).toBe(1)
  })
  it('rejects design submissions missing the shared module audit before compiling',()=>{
    const {compiler,author}=fixture()
    const result=compiler.submit({submission:{mode:'design',plan:create}})
    expect(result).toMatchObject({ok:false,feedback:{issues:[expect.objectContaining({code:'COMMAND_INTAKE_INVALID',message:expect.stringContaining('MODULE_CHECK_REQUIRED')})]}})
    expect(author.snapshot().submissions).toBe(0)
  })
  it('keeps missing information in the existing needs-input result contract',()=>{
    const {compiler}=fixture(),result=compiler.submit({submission:{mode:'needs-input',questions:[{id:'file',question:'文件路径？'}]}})
    expect(result).toMatchObject({ok:true,value:{kind:'command-design',compiled:{output:{outcome:'needs-input',questions:[{id:'file',question:'文件路径？',options:[]}]}}}})
  })
  it('carries a return reason without creating or revising a graph',()=>{
    const {compiler,author}=fixture()
    expect(compiler.submit({submission:{mode:'return-to-main',reason:'已有图目标不明'}})).toEqual({ok:true,value:{kind:'command-return',reason:'已有图目标不明'}})
    expect(author.snapshot().submissions).toBe(0)
  })
  it('requires full design in the same activation and preserves the ordinary execute-first gate',()=>{
    const {compiler}=fixture()
    const first=compiler.submit({submission:{mode:'request',request:{}}})
    expect(first).toMatchObject({ok:false,feedback:{remainingSubmissions:2}})
    const second=compiler.submit({submission:{mode:'request',request:{moduleCheck,execution:{mode:'design-only'}}}})
    expect(second).toMatchObject({ok:false,feedback:{remainingSubmissions:1}})
    if(!second.ok)expect(second.feedback.issues[0]!.message).toContain('同一子 Agent')
    expect(compiler.submit({submission:{mode:'return-to-main',reason:'交回定位'}}).ok).toBe(true)
    expect(()=>compiler.submit({submission:{mode:'return-to-main',reason:'超出'}})).toThrow(/三次/)
  })
  it('preserves fatal compiler authority failures instead of offering a repair',()=>{
    const {author,validate}=fixture()
    vi.spyOn(author,'submit').mockImplementation(()=>{throw new CompilerError('FORBIDDEN','权限已撤销',undefined,true)})
    const compiler=new CommandIntakeCompiler(author,validate,false)
    expect(()=>compiler.submit({submission:{mode:'design',moduleCheck,plan:create}})).toThrow(/权限已撤销/)
  })
})
describe('execute-first entry placement',()=>{
  it('moves top-level reviewItems into the trial spec instead of rejecting the request (Desktop r34)',()=>{
    const execution={mode:'execute-first',task:'本次真实任务',tools:['read','write'],artifacts:[{path:'result.txt',format:'text',checks:[{kind:'text-includes',value:'必要文本'}]}]}
    const parsed=parsePlanningEntry({requestId:'r34',operation:'create',instruction:'需求',moduleCheck,reviewItems:['最终报告备注'],execution},false)
    expect(parsed.execution).toMatchObject({mode:'execute-first',reviewItems:['最终报告备注']});expect(parsed.request).not.toHaveProperty('reviewItems')
    expect(()=>parsePlanningEntry({requestId:'r34',operation:'create',instruction:'需求',moduleCheck,reviewItems:['a'],execution:{...execution,reviewItems:['b']}},false)).toThrow()
  })
})
