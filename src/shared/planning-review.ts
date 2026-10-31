import type { NodeGraph, Workflow, WorkflowNode } from './types.ts'
import type { PlanningContext, PlanningIssue } from './planning-types.ts'
import { executionConditions } from './reference-scope.ts'
import { validateToolOperation } from './tool-operation-contract.ts'
import { parseWorkflow } from './workflow-validation.ts'
import { REVIEW_DRAFT_PREFIX, reviewDraftPath } from './planning-review-path.ts'
import { toolObservationProven } from './planning-tool-preconditions.ts'
export { REVIEW_DRAFT_PREFIX, reviewDraftPath } from './planning-review-path.ts'

export const REVIEW_BEFORE_EFFECT_GUIDANCE='至少两个 actions 的 human 是审核关卡。新建或明确修改的图：审核前文件写入只能写 .dsh-drafts/{{sys.workflow_run_id}}/<目标相对路径>，草稿保留。目标在审核 loop 前只观察一次：覆盖路径精确 read，首建路径精确不存在探测；通过后直接写，禁止循环内或批准后重读目标，以免刷新 SDK 版本观察、隐藏审核期间的外部改动。human 使用 paragraph 字段 content，defaultValue={{生成节点.text}}；提示必须说明文件只供查看，文件编辑不用于提交，修改须在表单内完成。正式写入 content={{审核节点.content}}，只能由该关卡 approve（或明确通过按钮 ID）出口独占控制，default 每次回答都触发，不能提交。草稿、human、拒绝修改放入 loop（maxIterations 默认显式填 3）；拒绝经 assigner 同时保存 note 和表单 content，下一轮生成 inputs 显式引用 vars.reviewNote 与 vars.reviewBase。提交成功才设置 approved=true、stopped=true，以 vars.stopped 结束；超限返回 not-approved。SDK 用已观察版本 replaceIfVersion 或 createIfAbsent 原子保护目标，冲突时普通 tool 没有错误分支，运行失败并显示 SDK 错误，不能宣称已输出 conflict 或自动重读重试。观察仅在内存；重启后已有目标写入会被 createIfAbsent 拒绝，仍不存在的目标可首建。native:bash、非 GET/HEAD 的 HTTP/Swagger 等不可撤回动作必须在批准后。未知工具不推定安全；不要求完整正文/版本读取工具，不用 bash 绕过 SDK，本规则不授予权限。'

const gate=(n:WorkflowNode)=>n.kind==='human'&&(n.config.actions?.length??0)>=2
// Only explicit positive IDs/labels count; arbitrary action IDs need a clear label.
export const reviewApprovePorts=(n:WorkflowNode)=>(n.config.actions??[]).filter(a=>
  !/reject|deny|cancel|退|拒|不通过|不同意|未通过|取消/i.test(a.id+' '+a.label)&&
  (/^(?:approve|approved|accept|confirm|yes|ok)$/i.test(a.id)||/^(?:通过|批准|同意|确认提交|核对通过|审核通过|approve|accept|confirm)$/i.test(a.label))).map(a=>a.id).filter(id=>!['default','timeout'].includes(id))
const samePath=(a:unknown,b:unknown)=>typeof a==='string'&&typeof b==='string'&&a.replace(/^(\.\/)+/,'')===b.replace(/^(\.\/)+/,'')
const definition=(n:WorkflowNode)=>JSON.stringify({kind:n.kind,config:{...n.config,body:undefined}})
const edgeKey=(e:NodeGraph['edges'][number])=>JSON.stringify([e.source,e.target,e.port??'default'])

/** Planning only: no storage/runtime hook, no graph rewrites and no safety grants. */
export function planningReviewIssues(workflow:Workflow,context:PlanningContext):PlanningIssue[] {
  const flatten=(g:NodeGraph):WorkflowNode[]=>g.nodes.flatMap(n=>[n,...(n.config.body?flatten(n.config.body):[])])
  if(!flatten(workflow).some(gate))return []
  // Defaults are semantic, not user edits; normalize both sides before scoping.
  workflow=parseWorkflow(workflow)
  const baseline=parseWorkflow(context.workflow),old=new Map(flatten(baseline).map(n=>[n.id,n])),contracts=new Map(context.tools.map(t=>[t.id,t.operationContract?validateToolOperation(t.operationContract,t.id):undefined]))
  const gateSignature=(g:NodeGraph)=>flatten(g).filter(gate).map(n=>[n.id,definition(n)])
  const reviewChanged=JSON.stringify(gateSignature(workflow))!==JSON.stringify(gateSignature(baseline))
  const operation=(n:WorkflowNode)=>{const c=contracts.get(n.config.toolId??'');return c?.status==='known'?c.declaration.action:undefined}
  const filePath=(n:WorkflowNode)=>operation(n)?.kind==='file-write'?(operation(n) as {pathInput:string}).pathInput:['native:write','native:edit'].includes(n.config.toolId??'')?'file_path':undefined
  const readPath=(n:WorkflowNode)=>operation(n)?.kind==='file-read'?(operation(n) as {pathInput:string}).pathInput:n.config.toolId==='native:read'?'file_path':undefined
  const isTool=(n:WorkflowNode)=>n.kind==='tool'||n.kind==='document'&&n.config.documentMode==='tool'
  const irreversible=(n:WorkflowNode)=>n.kind==='http'?!['GET','HEAD'].includes(n.config.method??'GET'):isTool(n)&&(n.config.toolId==='native:bash'||/^swagger:[^:]+:(?!get:|head:)[^:]+:/i.test(n.config.toolId??''))
  const issues:PlanningIssue[]=[],report=(n:WorkflowNode,path:string,message:string)=>issues.push({code:'REVIEW_BEFORE_EFFECT',nodeId:n.id,path,message:`节点 ${n.id} / ${path}：${message}`})
  const visit=(graph:NodeGraph,before:NodeGraph|undefined,approved:boolean,loop:WorkflowNode|undefined,changedParent=false,entries:{graph:NodeGraph;consumerId:string}[]=[])=>{
    const conditions=executionConditions(graph),byId=new Map(graph.nodes.map(n=>[n.id,n])),gates=graph.nodes.filter(gate),cache=new Map<string,Set<string>>()
    const ancestors=(id:string)=>{const cached=cache.get(id);if(cached)return cached;const found=new Set<string>(),pending=graph.edges.filter(e=>e.target===id).map(e=>e.source);for(let i=0;i<pending.length;i++){const id=pending[i]!;if(found.has(id))continue;found.add(id);pending.push(...graph.edges.filter(e=>e.target===id).map(e=>e.source))}cache.set(id,found);return found}
    const required=(consumer:WorkflowNode,producer:WorkflowNode)=>ancestors(consumer.id).has(producer.id)&&conditions.implies(conditions.active(consumer.id),conditions.active(producer.id))
    const oldEdges=new Set(before?.edges.map(edgeKey)??[]),nextEdges=new Set(graph.edges.map(edgeKey)),changed=new Set(graph.nodes.filter(n=>!old.has(n.id)||definition(n)!==definition(old.get(n.id)!)).map(n=>n.id))
    for(const e of [...graph.edges,...(before?.edges??[])])if(!oldEdges.has(edgeKey(e))||!nextEdges.has(edgeKey(e)))changed.add(e.target)
    const gateChanged=gates.some(n=>changed.has(n.id))||(before?.nodes.some(n=>gate(n)&&!byId.has(n.id))??false)
    for(const node of graph.nodes){
      const upstream=ancestors(node.id)
      const affected=context.operation==='create'||changedParent||gateChanged||changed.has(node.id)||[...upstream].some(id=>changed.has(id))||context.targetNodeIds.includes(node.id)
      const approval=gates.filter(g=>upstream.has(g.id)).reduce((proof,g)=>reviewApprovePorts(g).reduce((p,port)=>conditions.union(p,conditions.route(g.id,port)),proof),0)
      const afterApprove=approved||approval!==0&&conditions.implies(conditions.active(node.id),approval)
      if(affected&&node.kind==='loop'&&node.config.body?.nodes.some(n=>isTool(n)&&filePath(n)&&reviewDraftPath(n.config.inputs?.[filePath(n)!]))){
        const exit=graph.nodes.find(n=>n.kind==='if'&&n.config.variable===`${node.id}.variables.approved`&&n.config.operator==='equals'&&n.config.value==='true'&&required(n,node))
        if(node.config.initialVariables?.approved!==false||node.config.initialVariables?.stopped!==false||!exit||!graph.nodes.some(n=>n.kind==='output'&&/not-approved|未通过|未批准/.test(n.config.text??'')&&ancestors(n.id).has(exit.id)&&conditions.implies(conditions.active(n.id),conditions.route(exit.id,'false'))))
          report(node,'config.initialVariables','审核循环初始化 approved=false、stopped=false；循环外显式按 loop.variables.approved 分流，未批准的超限路径到 not-approved 输出，不能宣称提交成功。')
      }
      if(node.config.body)visit(node.config.body,old.get(node.id)?.config.body,afterApprove,node.kind==='loop'?node:loop,affected,[...entries,{graph,consumerId:node.id}])
      const path=isTool(node)?filePath(node):undefined
      if(!affected||!path&&!irreversible(node))continue
      if(path&&node.kind==='document'){report(node,'config.documentMode','文档工具模式会替换来源参数，不能证明草稿或目标路径；文件动作须使用显式 tool 节点。');continue}
      const target=path?node.config.inputs?.[path]:undefined,draft=reviewDraftPath(target)
      if(path&&draft&&!irreversible(node)){
        if(!loop)report(node,`config.inputs.${path}`,'草稿、审核和带 note 的修改须在有上限的 loop 内，maxIterations 默认显式填 3。')
        const review=gates.find(g=>required(g,node)),form=review?.config.fields?.find(f=>f.type==='paragraph'&&f.defaultValue===node.config.inputs?.content)
        const revision=review&&form&&['note',form.name].every(field=>graph.nodes.some(n=>n.kind==='assigner'&&required(n,review)&&(n.config.assignments??[]).some(a=>
          a.operation==='set'&&a.value===`{{${review.id}.${field}}}`&&
          (review.config.actions??[]).filter(a=>!reviewApprovePorts(review).includes(a.id)).every(a=>conditions.implies(conditions.route(review.id,a.id),conditions.active(n.id)))&&
          graph.nodes.some(p=>required(node,p)&&JSON.stringify(p.config.inputs??{}).includes(`{{vars.${a.name}}}`)))))
        if(!review||!revision)report(node,`config.inputs.${path}`,'草稿必须通向同一 loop 内的审核；每个拒绝 action 经 assigner 同时保存 note 和表单 content，下一轮生成 inputs 显式引用保存的意见和正文作为修改基础。')
        if(node.config.cache==='reuse')report(node,'config.cache','草稿写入不可复用历史缓存。')
        continue
      }
      if(!afterApprove){report(node,path?`config.inputs.${path}`:node.kind==='http'?'config.method':'config.toolId',`${path?'文件目标 '+String(target):'不可撤回动作'} 可能在批准前或拒绝/default/timeout 路径执行。文件先写 ${REVIEW_DRAFT_PREFIX}<目标相对路径>；正式写入和不可撤回动作仅连接 human 的明确通过 action 出口，禁止旁路汇合。`);continue}
      if(!path)continue
      if(node.config.cache==='reuse')report(node,'config.cache','正式提交不可复用历史缓存。')
      if(!loop||loop.config.until?.variable!=='vars.stopped'||loop.config.until.operator!=='equals'||loop.config.until.value!=='true'||!graph.nodes.some(n=>n.kind==='assigner'&&required(n,node)&&conditions.implies(conditions.active(node.id),conditions.active(n.id))&&['approved','stopped'].every(name=>n.config.assignments?.some(a=>a.name===name&&a.operation==='set'&&a.value===true))))
        report(node,`config.inputs.${path}`,'正式提交须在审核 loop 内，提交后设置 approved=true、stopped=true，until=vars.stopped equals true，确保只提交一次；循环外按 approved 分流，超限结束于 not-approved。')
      const content=node.config.inputs?.content,match=typeof content==='string'?/^\{\{([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\}\}$/.exec(content):undefined
      const review=match&&gates.find(g=>g.id===match[1]&&required(node,g)&&conditions.implies(conditions.active(node.id),reviewApprovePorts(g).reduce((p,port)=>conditions.union(p,conditions.route(g.id,port)),0)))
      const field=review?.config.fields?.find(f=>f.name===match?.[2]&&f.type==='paragraph'),source=field?.defaultValue&&/^\{\{([A-Za-z0-9_-]+)\.text\}\}$/.exec(field.defaultValue)?.[1],producer=source&&byId.get(source)
      const draftWrite=review&&graph.nodes.find(w=>isTool(w)&&filePath(w)&&samePath(w.config.inputs?.[filePath(w)!],REVIEW_DRAFT_PREFIX+String(target).replace(/^(\.\/)+/,''))&&required(review,w)&&w.config.inputs?.content===field?.defaultValue)
      if(!review||!field||!producer||!required(review,producer)||!draftWrite)
        report(node,'config.inputs.content','content 必须直接引用独占批准本次提交的 human paragraph 字段（如 {{reviewGate.content}}）；字段 defaultValue={{生成节点.text}}，对应草稿写相同生成正文，不能回读草稿或引用旧正文。')
      if(review&&!/文件.*(?:不用于提交|不.*采用|不.*生效)/.test(review.config.prompt??''))
        report(review,'config.prompt','明确提示：文件只供查看，文件编辑不用于提交；修改须在表单正文中完成。')
      const entry=entries.find(e=>e.consumerId===loop?.id)
      if(!entry||!toolObservationProven(entry.graph,entry.consumerId,node,context,true,true))
        report(node,`config.inputs.${path}`,'目标观察必须在审核 loop 之前：覆盖分支精确 read，首建分支使用精确不存在探测；在 loop 入口汇合后保留同一 run 的 SDK 观察，不在循环内补读。')
      // Any target read/probe/write in the loop can refresh the retained version.
      // Reject even a sibling observer: it may run while the human is waiting.
      const refresh=loop&&flatten(loop.config.body!).find(n=>n.id!==node.id&&isTool(n)&&(
        readPath(n)&&samePath(n.config.inputs?.[readPath(n)!],target)||filePath(n)&&samePath(n.config.inputs?.[filePath(n)!],target)||n.config.toolId==='native:glob'&&samePath(n.config.inputs?.pattern,target)))
      if(refresh)report(refresh,'config.inputs','审核 loop 内禁止重新观察或改写正式目标（包括批准到提交之间）；删除该读／探测／写节点，保留 loop 前的原始 SDK 版本观察，批准后直接提交。')
    }
  }
  visit(workflow,baseline,false,undefined,reviewChanged)
  return issues
}
