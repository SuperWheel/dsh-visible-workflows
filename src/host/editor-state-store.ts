import { assertExistingWorkflowNumbers, normalizePlanningWorkflowNumbers } from '../shared/numbering.ts'
import { appendPlanningReceipt, planningCommitSchema, planningReceiptSchema, type PlanningCommit, type PlanningReceipt } from './planning/receipt.ts'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JsonValue, Workflow, WorkflowDraft, WorkflowProposal } from '../shared/types.ts'
import { parseWorkflow, protectFixedNodes } from './validation.ts'
import type { WorkflowStorage } from './storage.ts'
import { workflowDefinitionContent } from '../shared/workflow-content.ts'

const definitionDigest=(flow:Parameters<typeof workflowDefinitionContent>[0])=>createHash('sha256').update(workflowDefinitionContent(flow)).digest('hex')

const safeId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(value)
// Draft names may be unfinished while typing. Their shape is bounded and strict;
// unlike public variables, a Secret draft has no value or credential-binding field.
const environmentDraftBase={id:z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/),name:z.string().max(80),description:z.string().max(2000).optional(),required:z.boolean().optional()}
const secretDraftSchema=z.object({...environmentDraftBase,type:z.literal('secret'),configured:z.literal(false).optional()}).strict()
const SECRET_DRAFT_ERROR='Secret 草稿只能保存声明，不能包含变量值、凭据绑定或其他额外字段'
const ENVIRONMENT_DRAFT_ERROR='环境变量草稿格式无效，请检查字段类型和内容长度'
const environmentDraftSchema=z.discriminatedUnion('type',[
  z.object({...environmentDraftBase,type:z.literal('string'),configured:z.boolean().optional(),value:z.string().max(400000).optional()}).strict(),
  z.object({...environmentDraftBase,type:z.literal('number'),configured:z.boolean().optional(),value:z.string().max(400000).optional()}).strict(),
  secretDraftSchema,
])

/** UI editing state is separate from definitions and execution snapshots. Never accepts credential input. */
export class WorkflowEditorState {
  private readonly file:string
  private state:{proposals:WorkflowProposal[];drafts:WorkflowDraft[];planningReceipts?:PlanningReceipt[]}={proposals:[],drafts:[]}
  constructor(private storage:WorkflowStorage,private planningBase?:(proposal:WorkflowProposal)=>Workflow|undefined){
    this.file=join(storage.directory,'editor-state.json')
    if(existsSync(this.file)){
      if(lstatSync(this.file).isSymbolicLink())throw new Error('编辑状态文件不能是符号链接')
      const value=JSON.parse(readFileSync(this.file,'utf8'))
      if(!Array.isArray(value.proposals)||!Array.isArray(value.drafts))throw new Error('编辑状态格式无效')
      this.state={planningReceipts:value.planningReceipts?.map((receipt:unknown)=>planningReceiptSchema.parse(receipt)),proposals:value.proposals.map((p:WorkflowProposal)=>({...p,candidate:parseWorkflow(p.candidate)})),drafts:value.drafts.map((d:unknown)=>this.parseDraft(d,1))}
    }
  }
  private baseDigest(proposal:WorkflowProposal):string|undefined{
    if(proposal.baseDefinitionDigest)return proposal.baseDefinitionDigest
    // Older requests can recover their exact baseline from a verified planning
    // commit. An unlinked or missing record never authorizes a stale proposal.
    const base=this.planningBase?.(proposal)
    return base?.id===proposal.workflowId&&base.revision===proposal.baseRevision&&base.workspaceId===proposal.candidate.workspaceId?definitionDigest(base):undefined
  }
  private persist(next:typeof this.state):void{
    const serialized=JSON.stringify(next)
    if(Buffer.byteLength(serialized)>16_000_000)throw new Error('编辑草稿和提案超过容量，请先清理已处理记录')
    const temp=join(this.storage.directory,`editor-${randomUUID()}.tmp`)
    writeFileSync(temp,serialized,{encoding:'utf8',mode:0o600,flag:'wx'});renameSync(temp,this.file);this.state=next
  }
  needsPlanningBase(proposalId:string):boolean{return this.state.proposals.some(proposal=>proposal.id===proposalId&&proposal.status==='pending'&&!proposal.baseDefinitionDigest)}
  planningReceipt(key:string):PlanningReceipt|undefined{return structuredClone(this.state.planningReceipts?.find(receipt=>receipt.key===key))}
  propose(value:unknown,revision:number,commit?:PlanningCommit):WorkflowProposal{
    if(commit){planningCommitSchema.parse(commit);if(this.planningReceipt(commit.key))throw new Error('规划提交已完成，请读取提交回执')}
    const submitted=parseWorkflow(value),prior=this.storage.get(submitted.id)
    if(prior.workspaceId!==submitted.workspaceId||prior.revision!==revision)throw new Error('工作流版本或工作区已变化，请重新生成提案')
    assertExistingWorkflowNumbers(submitted,prior)
    const candidate=normalizePlanningWorkflowNumbers(submitted,prior)
    protectFixedNodes(prior,candidate)
    const proposal:WorkflowProposal={id:randomUUID(),workflowId:candidate.id,baseRevision:revision,baseDefinitionDigest:definitionDigest(prior),candidate,status:'pending',createdAt:new Date().toISOString()}
    const pending=this.state.proposals.filter(p=>p.status==='pending')
    if(pending.length>=100)throw new Error('待处理提案已达100条，请先处理已有提案')
    const old=[...this.state.proposals.filter(p=>p.status!=='pending').slice(-Math.max(0,99-pending.length)),...pending]
    this.persist({...this.state,proposals:[...old,proposal],...(commit?{planningReceipts:appendPlanningReceipt(this.state.planningReceipts,{...commit,kind:'proposed',workflowId:proposal.workflowId,revision:proposal.baseRevision,proposalId:proposal.id})}:{})});return structuredClone(proposal)
  }
  proposals(workflowId:string):WorkflowProposal[]{const flow=this.storage.get(workflowId);return structuredClone(this.state.proposals.filter(p=>p.workflowId===workflowId).map(proposal=>proposal.status==='pending'&&proposal.baseRevision!==flow.revision&&this.baseDigest(proposal)===definitionDigest(flow)?{...proposal,canAcceptAtRevision:flow.revision}:proposal))}
  resolve(id:string,decision:'accept'|'reject',revision:number):WorkflowProposal{
    const proposal=this.state.proposals.find(p=>p.id===id)
    if(!proposal)throw new Error('修改提案不存在')
    if(proposal.status!=='pending')return structuredClone(proposal)
    const next=structuredClone(proposal)
    if(decision==='accept'){
      const prior=this.storage.get(proposal.workflowId)
      // Definition persistence may have succeeded before editor-state failed.
      // Finish that acceptance without saving or advancing its revision again.
      if((revision===prior.revision||revision===proposal.baseRevision)&&definitionDigest(prior)===definitionDigest(proposal.candidate))next.candidate=prior
      else{
        if(revision!==prior.revision||(revision!==proposal.baseRevision&&this.baseDigest(proposal)!==definitionDigest(prior)))throw new Error('工作流已被修改，提案基础版本已过期，请重新比较后生成提案')
        protectFixedNodes(prior,proposal.candidate)
        // Accepting an optimization does not implicitly unlock protected nodes.
        const candidate=structuredClone(proposal.candidate)
        for(const key of ['viewport','scopePath'] as const){
          if(prior.editor?.[key]!==undefined)candidate.editor={...candidate.editor,[key]:prior.editor[key]}
          else if(candidate.editor)delete candidate.editor[key]
        }
        next.candidate=this.storage.saveReviewedCandidate(candidate,revision)
      }
      next.status='accepted'
    }else if(decision==='reject')next.status='rejected'
    else throw new Error('无效的提案操作')
    this.persist({...this.state,proposals:this.state.proposals.map(p=>p.id===id?next:p)});return structuredClone(next)
  }
  private parseDraft(raw:unknown,legacyRevision=0):WorkflowDraft{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('草稿格式无效')
    const d=raw as WorkflowDraft
    if(!safeId(d.id)||!safeId(d.workflowId)||!safeId(d.workspaceId)||(d.sessionId!==undefined&&!safeId(d.sessionId))||d.kind!=='editor')throw new Error('草稿身份无效')
    if(!d.payload||typeof d.payload!=='object'||Array.isArray(d.payload))throw new Error('草稿内容无效')
    const allowed=new Set(['environmentDraft','generateDraft','generateTargetId','generateRequestId','annotationDraft','annotationBatch','selected','scopePath'])
    if(Object.keys(d.payload).some(k=>!allowed.has(k)))throw new Error('草稿含有不支持的字段')
    if(Object.hasOwn(d.payload,'generateRequestId')&&!safeId(d.payload.generateRequestId))throw new Error('需求草稿身份无效')
    if(Object.hasOwn(d.payload,'environmentDraft')&&!environmentDraftSchema.safeParse(d.payload.environmentDraft).success){
      const environment=d.payload.environmentDraft
      throw new Error(environment&&typeof environment==='object'&&!Array.isArray(environment)&&environment.type==='secret'?SECRET_DRAFT_ERROR:ENVIRONMENT_DRAFT_ERROR)
    }
    const inspect=(v:JsonValue,depth:number):void=>{
      if(depth>30)throw new Error('草稿嵌套过深')
      if(!v||typeof v!=='object')return
      if(!Array.isArray(v)&&v.type==='secret'&&!secretDraftSchema.safeParse(v).success)throw new Error(SECRET_DRAFT_ERROR)
      for(const [key,value] of Object.entries(v)){if(['__proto__','prototype','constructor','secretValue','password','credential'].includes(key))throw new Error('草稿含有受限字段');inspect(value as JsonValue,depth+1)}
    };inspect(d.payload,0)
    if(JSON.stringify(d.payload).length>500_000)throw new Error('编辑草稿超过容量')
    const revision=d.revision??legacyRevision
    if(!Number.isSafeInteger(revision)||revision<0)throw new Error('草稿版本无效')
    return {id:d.id,workflowId:d.workflowId,workspaceId:d.workspaceId,...(d.sessionId?{sessionId:d.sessionId}:{}),kind:'editor',payload:structuredClone(d.payload),revision,updatedAt:typeof d.updatedAt==='string'?d.updatedAt:''}
  }
  drafts(workflowId:string,sessionId?:string):WorkflowDraft[]{this.storage.get(workflowId);return structuredClone(this.state.drafts.filter(d=>d.workflowId===workflowId&&(d.sessionId??'')===(sessionId??'')))}
  saveDraft(value:unknown,expectedRevision:number):WorkflowDraft{
    const draft=this.parseDraft(value),flow=this.storage.get(draft.workflowId)
    if(flow.workspaceId!==draft.workspaceId)throw new Error('草稿工作区不匹配')
    const previous=this.state.drafts.find(d=>d.id===draft.id)
    if(previous&&(previous.workflowId!==draft.workflowId||previous.sessionId!==draft.sessionId))throw new Error('草稿身份不能跨流程或会话复用')
    const scoped=this.state.drafts.find(d=>d.workflowId===draft.workflowId&&(d.sessionId??'')===(draft.sessionId??''))
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision!==(previous?.revision??0)||(scoped&&scoped.id!==draft.id))throw new Error('草稿已被其他窗口修改，请保留本地内容并重新读取后处理冲突')
    if(previous&&JSON.stringify(previous.payload)===JSON.stringify(draft.payload))return structuredClone(previous)
    if(!previous&&this.state.drafts.length>=100)throw new Error('编辑草稿已达 100 条，请先清理已完成的草稿')
    if(expectedRevision>=Number.MAX_SAFE_INTEGER)throw new Error('草稿版本超出范围')
    const saved={...draft,revision:expectedRevision+1,updatedAt:new Date().toISOString()}
    this.persist({...this.state,drafts:[...this.state.drafts.filter(d=>d.id!==draft.id),saved]});return structuredClone(saved)
  }
  removeDraft(id:string,expectedRevision:number):void{
    const previous=this.state.drafts.find(d=>d.id===id)
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision!==(previous?.revision??0))throw new Error('草稿已被其他窗口修改，不能清除新版本')
    if(previous)this.persist({...this.state,drafts:this.state.drafts.filter(d=>d.id!==id)})
  }
}
