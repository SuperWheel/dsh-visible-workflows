import { z } from 'zod'
import { planningModuleCheckSchema } from '../../shared/planning-schema.ts'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { CompilerError, compilerJson, needsInputSchema, needsInputWireSchema, type CompilerIssue, type SubmissionCompiler, type SubmissionResult } from '../../shared/planning-repair.ts'
import type { CompiledAuthoring } from '../../shared/planning-authoring.ts'

export const commandIntakeSchema=z.object({brief:z.string().max(200_000),rawRequirement:z.string().min(1).max(100_000),readOnly:z.boolean(),
  moduleCheck:planningModuleCheckSchema.optional(),
  decision:z.record(z.string(),z.unknown()).optional(),linkedTaskId:z.string().min(1).max(160).optional(),
  returned:z.string().max(4000).optional()}).strict()
export type CommandIntake=z.infer<typeof commandIntakeSchema>
export type CommandIntakeResult={kind:'command-request';request:Record<string,unknown>}|{kind:'command-return';reason:string}|{kind:'command-design';compiled:CompiledAuthoring}

/** One isolated activation chooses a route and, for design-only, authors its graph.
 * Execute-first must pass the existing trial boundary before evidence-based design.
 */
export class CommandIntakeCompiler implements SubmissionCompiler<CommandIntakeResult> {
  readonly schema:ObjectJsonSchema
  readonly instructions:string
  private attempts=0
  get nextSchema():ObjectJsonSchema {
    const schema=structuredClone(this.schema)
    const alternatives=(schema.properties!.submission as {oneOf:any[]}).oneOf
    alternatives[3].properties.plan=this.author.nextSchema?.properties?.submission??this.author.schema.properties!.submission
    return schema
  }
  constructor(readonly author:SubmissionCompiler<CompiledAuthoring>,private validateRequest:(value:unknown)=>Record<string,unknown>,readOnly:boolean) {
    this.schema={type:'object',properties:{submission:{oneOf:[
      {type:'object',properties:{mode:{const:'request',type:'string'},request:{type:'object',additionalProperties:true}},required:['mode','request'],additionalProperties:false},
      {type:'object',properties:{mode:{const:'return-to-main',type:'string'},reason:{type:'string'}},required:['mode','reason'],additionalProperties:false},
      needsInputWireSchema,
      {type:'object',properties:{mode:{const:'design',type:'string'},moduleCheck:{type:'object',properties:{checked:{type:'array',items:{type:'string'}},notApplicable:{type:'string'}},required:['checked','notApplicable'],additionalProperties:false},plan:author.schema.properties!.submission},required:['mode','plan'],additionalProperties:false},
    ]}},required:['submission'],additionalProperties:false}
    this.instructions='你是命令需求的唯一规划者。先读 Host 简报，再理解原始需求。不得 fork 或执行。修改已有图、不是新建或目标不明时提交 mode:return-to-main,reason；不要自行选择或修改已有图。缺必要信息提交 mode:needs-input,questions,summary，问题交真人。完整模块匹配时提交 mode:request,request（标准 visible_workflow_plan 请求，handoff 使用 S02 module 合同）。新建默认 execute-first：request.execution={mode:"execute-first",task,tools,inputs,artifacts,reviewItems}；只冻结用户授权范围，缺少验收条件先问真人。仅用户明确只设计时使用 design-only；不得把失败改成只设计。'+
      (readOnly?'Host 已确认只读／计划权限，直接设计预览。':'用户明确只设计且模块不覆盖时，')+
      '在同一子 Agent 内完成设计，提交 mode:design,moduleCheck,plan；moduleCheck 按简报逐个检查全部模块并说明不适用理由，plan 为下述创作 submission 的正文。模块外的新业务在本次完整设计中保留固定模块行为；不向主 Agent 重述需求让其重新设计。使用用户指定标题。mode:request 的身份和原始 instruction 由 Host 固定，不可变更。路由合同错误可在剩余次数内更正同一路由；design 的修复仍包在 mode:design,plan 中。\n'+author.instructions
  }
  rejectWire(value:unknown,issues:CompilerIssue[]):SubmissionResult<CommandIntakeResult> {
    compilerJson(value)
    if(++this.attempts>3)throw new CompilerError('PLANNING_REPAIR_LIMIT','命令受理最多提交三次',undefined,true)
    return {ok:false,feedback:{status:'repairable',draftRevision:this.attempts,issues:structuredClone(issues),fragments:{},allowedPaths:[],remainingSubmissions:3-this.attempts}}
  }
  submit(value:unknown):SubmissionResult<CommandIntakeResult> {
    if(++this.attempts>3)throw new Error('命令受理最多提交三次')
    try{
      const {submission}=z.object({submission:z.record(z.string(),z.unknown())}).strict().parse(compilerJson(value))
      if(submission.mode==='request'){
        const row=z.object({mode:z.literal('request'),request:z.unknown()}).strict().parse(submission)
        const request=this.validateRequest(row.request)
        if((request.execution as {mode?:string}|undefined)?.mode!=='execute-first'&&(request.handoff as {mode?:string}|undefined)?.mode!=='module')throw new Error('完整设计须在同一子 Agent 内用 mode:design 提交；不再启动第二个设计会话')
        return {ok:true,value:{kind:'command-request',request}}
      }
      if(submission.mode==='return-to-main'){
        const row=z.object({mode:z.literal('return-to-main'),reason:z.string().min(1).max(4000)}).strict().parse(submission)
        return {ok:true,value:{kind:'command-return',reason:row.reason}}
      }
      if(submission.mode==='needs-input'){
        const row=needsInputSchema.parse(submission)
        return {ok:true,value:{kind:'command-design',compiled:{output:{outcome:'needs-input',graphJson:'',summary:row.summary,questions:row.questions,assumptions:[],requirementCoverage:[]},issues:[]}}}
      }
      const row=z.object({mode:z.literal('design'),moduleCheck:z.unknown().optional(),plan:z.unknown()}).strict().parse(submission)
      // Validate execution policy before accepting any authored candidate.
      this.validateRequest({execution:{mode:'design-only'},...(row.moduleCheck!==undefined?{moduleCheck:row.moduleCheck}:{})})
      const compiled=this.author.submit({submission:row.plan})
      return compiled.ok?{ok:true,value:{kind:'command-design',compiled:compiled.value}}:{ok:false,feedback:{...compiled.feedback,remainingSubmissions:Math.min(compiled.feedback.remainingSubmissions,3-this.attempts)}}
    }catch(error){
      if(error instanceof CompilerError&&error.fatal)throw error
      return {ok:false,feedback:{status:'repairable',draftRevision:this.attempts,issues:[{code:'COMMAND_INTAKE_INVALID',message:error instanceof Error?error.message:String(error),allowedPaths:[]}],fragments:{},allowedPaths:[],remainingSubmissions:3-this.attempts}}
    }
  }
}
