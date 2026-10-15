import { z } from 'zod'
import { CANVAS_NOTE_SIZE, type Workflow, type WorkflowNode, type ValidationIssue, type NodeGraph, type JsonValue } from '../shared/types.ts'

const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/, '身份只能包含字母、数字、下划线或连字符')
const fieldName = z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).refine(v => !['constructor', 'prototype', '__proto__'].includes(v))
const json: z.ZodType<JsonValue> = z.lazy(() => z.union([z.string().max(400000), z.number().finite(), z.boolean(), z.null(), z.array(json).max(10000), z.record(z.string().max(1000).refine(v => !['constructor', 'prototype', '__proto__'].includes(v)), json)]))
const mapping = z.record(fieldName, json)
export const inputFieldSchema = z.object({ name: fieldName, label: z.string().max(200), required: z.boolean(), defaultValue: z.string().max(200000).optional(), type: z.enum(['text','paragraph','number','boolean','select','json','file','files']).optional(), options: z.array(z.string().max(1000)).max(100).optional(), hidden: z.boolean().optional() }).strict()
const model = z.object({ provider: z.string().min(1).max(256), model: z.string().min(1).max(256) }).strict()
const text = z.string().max(400000)
const modelFields = { prompt: text.default(''), model: model.optional(), effort: z.string().min(1).max(128).optional(), rolePresetId: identifier.optional() }
const condition = z.object({ variable: z.string().max(400), operator: z.enum(['contains','not_contains','equals','not_equals','not_empty','empty','starts_with','ends_with','gt','gte','lt','lte']), value: text.optional() }).strict()
const parameter = z.object({ name: fieldName, type: z.enum(['string','number','boolean','object','array']), description: z.string().max(2000).optional(), required: z.boolean().optional() }).strict()
const nodeSchema = z.object({ id: identifier, number: z.string().max(100), kind: z.enum(['input','template','llm','if','output','agent','knowledge','classifier','human','iteration','loop','exit_loop','code','aggregator','document','assigner','extractor','http','list','tool']), title: z.string().min(1).max(200), x: z.number().finite(), y: z.number().finite(), fixed: z.boolean(), config: z.record(z.string(), z.unknown()) }).strict()
const edgeSchema = z.object({ id: identifier, source: identifier, target: identifier, port: identifier.optional() }).strict()
const graphSchema = z.object({ nodes: z.array(nodeSchema).min(1).max(200), edges: z.array(edgeSchema).max(1000) }).strict()
const configs = {
  input: z.object({ fields: z.array(inputFieldSchema).max(40).default([]) }).strict(),
  template: z.object({ text: text.default(''), inputs: mapping.optional() }).strict(),
  llm: z.object({ ...modelFields, inputs: mapping.optional(), outputSchema: z.array(parameter).max(40).optional() }).strict(),
  if: z.object({ variable: z.string().max(400).default(''), operator: condition.shape.operator.default('not_empty'), value: text.optional(), cases: z.array(z.object({ id: identifier, logic: z.enum(['and','or']).optional(), conditions: z.array(condition).min(1).max(30) }).strict()).max(20).optional() }).strict(),
  output: z.object({ text: text.default(''), outputName: fieldName.default('result'), inputs: mapping.optional() }).strict(),
  agent: z.object({ ...modelFields, tools: z.array(z.string().max(256)).max(30).default([]), inputs: mapping.optional(), maxSteps: z.number().int().min(1).max(20).default(6) }).strict(),
  knowledge: z.object({ query: text.default(''), sources: z.array(text).max(20).default([]), topK: z.number().int().min(1).max(50).default(5), threshold: z.number().min(0).max(1).optional(), inputs: mapping.optional() }).strict(),
  classifier: z.object({ ...modelFields, classes: z.array(z.object({ id: identifier, label: z.string().min(1).max(200), description: text.optional() }).strict()).max(20).default([]), inputs: mapping.optional() }).strict(),
  human: z.object({ prompt: text.default(''), fields: z.array(inputFieldSchema).max(40).default([]), actions: z.array(z.object({ id: identifier, label: z.string().min(1).max(200) }).strict()).min(1).max(20).default([{id:'continue',label:'继续'}]), timeoutSeconds: z.number().int().min(1).max(2592000).optional() }).strict(),
  iteration: z.object({ iterator: z.string().max(400).default(''), body: graphSchema.optional(), outputVariable: z.string().max(400).default(''), errorMode: z.enum(['terminate','null','remove']).default('terminate'), parallel: z.boolean().default(false), concurrency: z.number().int().min(1).max(10).default(3) }).strict(),
  loop: z.object({ body: graphSchema.optional(), maxIterations: z.number().int().min(1).max(100).default(10), until: condition.optional(), initialVariables: mapping.default({}), outputVariable: z.string().max(400).optional() }).strict(),
  exit_loop: z.object({}).strict(),
  code: z.object({ language: z.enum(['javascript','python']).default('javascript'), code: text.default(''), inputs: mapping.default({}), outputSchema: z.array(parameter).max(40).optional(), timeoutMs: z.number().int().min(100).max(30000).default(5000) }).strict(),
  aggregator: z.object({ groups: z.array(z.object({ name: fieldName, variables: z.array(z.string().min(1).max(400)).min(1).max(40) }).strict()).max(40).default([]) }).strict(),
  document: z.object({ source: text.default(''), documentMode: z.enum(['local','tool','agent']).default('local'), documentSourceKey: fieldName.optional(), documentTextPath: z.string().min(1).max(400).refine(v=>v.split('.').every(k=>k.length>0&&!['__proto__','prototype','constructor'].includes(k)),'文本路径包含无效字段').optional(), toolId: z.string().max(256).optional(), inputs: mapping.optional(), ...modelFields, tools: z.array(z.string().min(1).max(256)).max(30).optional(), maxSteps: z.number().int().min(2).max(20).optional() }).strict(),
  assigner: z.object({ assignments: z.array(z.object({ name: fieldName, operation: z.enum(['set','clear','add','subtract','multiply','divide','append','extend','pop','shift']), value: json.optional() }).strict()).max(40).default([]) }).strict(),
  extractor: z.object({ ...modelFields, parameters: z.array(parameter).max(40).default([]), inputs: mapping.optional() }).strict(),
  http: z.object({ url: text.default(''), method: z.enum(['GET','HEAD','POST','PUT','PATCH','DELETE']).default('GET'), headers: z.record(z.string().max(200), z.string().max(10000)).default({}), bodyText: text.optional(), timeoutMs: z.number().int().min(100).max(120000).default(30000), inputs: mapping.optional() }).strict(),
  list: z.object({ listSource: z.string().max(400).default(''), filter: condition.optional(), sort: z.enum(['asc','desc']).optional(), limit: z.number().int().min(1).max(20).optional() }).strict(),
  tool: z.object({ toolId: z.string().max(256).default(''), inputs: mapping.default({}) }).strict(),
}
export const canvasNoteSchema = z.object({
  id: identifier, text: z.string().max(20000), x: z.number().finite(), y: z.number().finite(),
  width: z.number().finite().min(CANVAS_NOTE_SIZE.minWidth).max(CANVAS_NOTE_SIZE.maxWidth).optional(),
  height: z.number().finite().min(CANVAS_NOTE_SIZE.minHeight).max(CANVAS_NOTE_SIZE.maxHeight).optional(),
  color: z.enum(['yellow','blue','green','purple','neutral']).optional(), anchorNodeId: identifier.optional(),
}).strict()
export const workflowSchema = graphSchema.extend({
  id: identifier, workspaceId: z.string().min(1).max(160), title: z.string().min(1).max(200), description: z.string().max(10000), revision: z.number().int().nonnegative(),
  notes: z.array(canvasNoteSchema).max(200),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), archived: z.boolean().optional(),
}).strict()
export const presetSchema = z.object({ id: identifier, name: z.string().min(1).max(100), prompt: z.string().max(100000), revision: z.number().int().nonnegative() }).strict()
export const inputsSchema = z.record(z.string().regex(/^(?:[A-Za-z][A-Za-z0-9_]*|__action)$/), z.string().max(3_000_000)).refine(v => JSON.stringify(v).length <= 4_000_000, '一次输入最多 4 MB').refine(v => Object.keys(v).length <= 41, '最多 40 个输入')

export function parseWorkflow(value: unknown): Workflow {
  const raw = workflowSchema.parse(value)
  let count = 0
  function parseNodes(nodes: (typeof raw.nodes[number] | WorkflowNode)[], depth: number): WorkflowNode[] {
    if (depth > 5) throw new Error('子流程嵌套不能超过 5 层')
    return nodes.map(node => {
      if (++count > 500) throw new Error('一个工作流最多 500 个节点（含子流程）')
      const config = configs[node.kind].parse(node.config) as WorkflowNode['config']
      if (config.body) config.body = { ...config.body, nodes: parseNodes(config.body.nodes, depth + 1) }
      return { ...node, config }
    })
  }
  const nodes=parseNodes(raw.nodes,0),canvasIds=new Set(nodes.map(node=>node.id))
  // Removing an anchor (including an Agent patch) must not remove its persistent explanation.
  const notes=raw.notes.map(note=>{if(!note.anchorNodeId||canvasIds.has(note.anchorNodeId))return note;const {anchorNodeId:_,...detached}=note;return detached})
  return { ...raw, nodes, notes }
}
export function allNodes(graph: NodeGraph): WorkflowNode[] { return graph.nodes.flatMap(node => [node, ...(node.config.body ? allNodes(node.config.body) : [])]) }

/** Structural validation also runs on save; incomplete node fields remain editable drafts. */
export function graphIssues(flow: Workflow, executable = false): ValidationIssue[] {
  const issues: ValidationIssue[] = [], ids = allNodes(flow).map(n => n.id)
  if (new Set(ids).size !== ids.length) issues.push({message:'节点身份重复（包括子流程）'})
  if (new Set(flow.notes.map(n => n.id)).size !== flow.notes.length) issues.push({message:'便签身份重复'})
  const canvasNodeIds = new Set(flow.nodes.map(n=>n.id))
  for(const note of flow.notes) if(note.anchorNodeId&&!canvasNodeIds.has(note.anchorNodeId)) issues.push({message:`便签 ${note.id} 连接了当前画布不存在的节点`})
  function inspect(graph: NodeGraph, inLoop = false): void {
    const nodes = new Map(graph.nodes.map(n => [n.id,n])), inputs = graph.nodes.filter(n => n.kind === 'input')
    if (executable && inputs.length !== 1) issues.push({message:'运行时每层图必须有且只有一个用户输入节点'})
    if (new Set(graph.edges.map(e => e.id)).size !== graph.edges.length) issues.push({message:'连线身份重复'})
    const pairs = new Set<string>()
    for (const edge of graph.edges) {
      const source = nodes.get(edge.source), target = nodes.get(edge.target)
      if (!source || !target) { issues.push({message:'连线引用了不存在的节点（跨容器请使用输出变量）'}); continue }
      const pair = JSON.stringify([edge.source,edge.target,edge.port ?? 'default'])
      if (pairs.has(pair)) issues.push({message:'存在重复连线'}); pairs.add(pair)
      if (target.kind === 'input') issues.push({nodeId:target.id,message:'用户输入节点不能有上游连线'})
      const ports = source.kind === 'if' ? source.config.cases?.length ? [...source.config.cases.map(c => c.id),'false'] : ['true','false'] : source.kind === 'classifier' ? source.config.classes?.map(c=>c.id) ?? [] : source.kind === 'human' ? ['default','timeout',...(source.config.actions?.map(a=>a.id) ?? ['continue'])] : ['default']
      if (!ports.includes(edge.port ?? 'default')) issues.push({nodeId:source.id,message:source.kind==='if'&&!source.config.cases?.length?'条件节点的连线须选择 true 或 false 出口':`连线出口无效，可选：${ports.join('、')}`})
    }
    try { topologicalNodes(graph) } catch { issues.push({message:'图存在循环连线，请使用循环节点容器'}) }
    const reachable = new Set(inputs.map(n=>n.id)); let changed=true
    while(changed) {changed=false; for(const edge of graph.edges) if(reachable.has(edge.source)&&!reachable.has(edge.target)){reachable.add(edge.target);changed=true}}
    for(const node of graph.nodes) {
      const c=node.config, issue=(message:string)=>issues.push({nodeId:node.id,message})
      if(executable&&!reachable.has(node.id)) issue('节点未连接到用户输入入口')
      if(['input','human'].includes(node.kind)) {
        if(new Set(c.fields?.map(f=>f.name)).size!==(c.fields?.length??0)) issue('输入字段名称重复')
        if(c.fields?.some(f=>f.hidden&&f.required)) issue('隐藏字段不能同时必填')
      }
      if(executable&&['llm','agent','classifier','extractor'].includes(node.kind)&&!c.model) issue('请选择此节点的模型')
      if(executable&&node.kind==='if'&&!c.cases?.length&&!c.variable?.trim()) issue('条件节点尚未选择变量')
      if(executable&&node.kind==='classifier'&&!c.classes?.length) issue('请至少配置一个类别')
      if(node.kind==='classifier'&&new Set(c.classes?.map(x=>x.id)).size!==c.classes?.length) issue('分类出口身份重复')
      if(node.kind==='human'&&new Set(c.actions?.map(x=>x.id)).size!==c.actions?.length) issue('人工操作身份重复')
      if(node.kind==='exit_loop'&&!inLoop) issue('退出循环只能放在循环内部')
      if(executable&&['iteration','loop'].includes(node.kind)&&!c.body) issue('请配置可执行子流程')
      if(executable&&node.kind==='iteration'&&(!c.iterator||!c.outputVariable)) issue('请选择迭代数组和输出变量')
      if(executable&&node.kind==='list'&&!c.listSource) issue('请选择列表变量')
      if(executable&&node.kind==='http'&&!c.url) issue('请填写请求 URL')
      if(executable&&node.kind==='tool'&&!c.toolId) issue('请选择具体工具')
      if(executable&&node.kind==='code'&&!c.code?.trim()) issue('请填写代码')
      if(executable&&node.kind==='aggregator'&&!c.groups?.length) issue('请配置聚合组')
      if(executable&&node.kind==='document'&&!c.source) issue('请选择文件来源')
      if(executable&&node.kind==='document'&&c.documentMode==='tool'&&!c.toolId) issue('请选择文档解析工具')
      if(executable&&node.kind==='document'&&c.documentMode==='agent') {
        if(!c.model) issue('请配置 DSH 默认模型或选择文档解析模型')
        if(!c.tools?.length) issue('请为文档 Agent 选择至少一个能读取文件的工具')
      }
      if(c.body) inspect(c.body,inLoop||node.kind==='loop')
    }
  }
  inspect(flow); return issues
}
export function assertGraph(flow: Workflow, executable = false): void {
  const issues=graphIssues(flow,executable)
  if(issues.length) throw new Error(issues.map(i=>`${i.nodeId?`${i.nodeId}: `:''}${i.message}`).join('\n'))
}
export function topologicalNodes(flow: NodeGraph): WorkflowNode[] {
  const pending=new Map(flow.nodes.map(n=>[n.id,0]))
  for(const edge of flow.edges) if(pending.has(edge.target)&&pending.has(edge.source)) pending.set(edge.target,pending.get(edge.target)!+1)
  const queue=flow.nodes.filter(n=>pending.get(n.id)===0),result:WorkflowNode[]=[]
  for(let i=0;i<queue.length;i++) {const node=queue[i]!;result.push(node);for(const edge of flow.edges.filter(e=>e.source===node.id)){if(!pending.has(edge.target))continue;const count=pending.get(edge.target)!-1;pending.set(edge.target,count);if(count===0)queue.push(flow.nodes.find(n=>n.id===edge.target)!)}}
  if(result.length!==flow.nodes.length)throw new Error('图存在循环')
  return result
}

/** Agent cannot edit fixed node semantics, remove it, reroute its incident edges or introduce a new bypass. */
export function protectFixedNodes(before: Workflow, after: Workflow): void {
  const hasFixed = (n: WorkflowNode): boolean => n.fixed || !!n.config.body && allNodes(n.config.body).some(child => child.fixed)
  const semantics = (n: WorkflowNode, whole: boolean) => { const { body, ...outer } = n.config; return JSON.stringify({ kind: n.kind, title: n.title, fixed: n.fixed, config: whole ? n.config : outer }) }
  for (const node of before.nodes.filter(hasFixed)) {
    const next = after.nodes.find(n => n.id === node.id)
    if (!next || semantics(node, node.fixed) !== semantics(next, node.fixed)) throw new Error(`节点 ${node.number} 已固定，请由用户在画布中修改或解除固定`)
    const incident = (flow: Workflow) => flow.edges.filter(e => e.source === node.id || e.target === node.id).map(e => JSON.stringify([e.source, e.target, e.port ?? 'default'])).sort()
    if (JSON.stringify(incident(before)) !== JSON.stringify(incident(after))) throw new Error(`不能改变固定节点 ${node.number} 的连接关系`)
    const bypass = (flow: Workflow): Set<string> => {
      const reached = new Set(flow.nodes.filter(n => n.kind === 'input' && n.id !== node.id).map(n => n.id))
      let changed = true
      while (changed) { changed = false; for (const e of flow.edges) if (e.target !== node.id && reached.has(e.source) && !reached.has(e.target)) { reached.add(e.target); changed = true } }
      return reached
    }
    const oldBypass = bypass(before), newBypass = bypass(after)
    if (before.nodes.some(n => n.kind !== 'input' && n.id !== node.id && !oldBypass.has(n.id) && newBypass.has(n.id))) throw new Error(`不能新增绕过固定节点 ${node.number} 的路径`)
    if (after.nodes.some(n => n.kind === 'output' && !before.nodes.some(b => b.id === n.id) && newBypass.has(n.id))) throw new Error(`不能新增绕过固定节点 ${node.number} 的输出`)
  }
  for (const node of before.nodes) if (node.config.body && allNodes(node.config.body).some(n => n.fixed)) {
    const next = after.nodes.find(n => n.id === node.id)
    if (!next?.config.body) throw new Error(`不能删除包含固定节点的容器 ${node.number}`)
    protectFixedNodes({ ...before, ...node.config.body, notes: [] }, { ...after, ...next.config.body, notes: [] })
  }

}
