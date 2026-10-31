import type { NodeGraph, NodeKind, Workflow, WorkflowNode } from '../../shared/types.ts'
import type { PlanningIssue } from '../../shared/planning-types.ts'
import type { OptimizationRegressionReport, OptimizationReplacement, OptimizationStats, OptimizationTarget, OptimizationTargetEvaluation } from '../../shared/planning-optimization.ts'

const directModelKinds = new Set<NodeKind>(['llm', 'classifier', 'extractor'])
const pureKinds = new Set<NodeKind>(['input', 'template', 'if', 'output', 'aggregator', 'assigner', 'list'])
const builtinTools = new Set(['builtin:time.now', 'builtin:time.timestamp', 'builtin:time.from_timestamp', 'builtin:time.convert_timezone', 'builtin:time.weekday', 'builtin:json.parse', 'builtin:json.stringify', 'builtin:json.select', 'builtin:json.merge'])
const isPure = (node: WorkflowNode): boolean => pureKinds.has(node.kind) || node.kind === 'code' && node.config.language !== 'python' || node.kind === 'tool' && ['builtin:json.parse', 'builtin:json.stringify', 'builtin:json.select', 'builtin:json.merge'].includes(node.config.toolId ?? '')
const nodesOf = (graph: NodeGraph): WorkflowNode[] => graph.nodes.flatMap(node => [node, ...(node.config.body ? nodesOf(node.config.body) : [])])

/** Nominal graph calls only. No Token, price, provider retry or latency estimate. */
export function optimizationStats(workflow: Workflow): OptimizationStats {
  const nodes = nodesOf(workflow), modelReasons = new Set<string>(), agentReasons = new Set<string>()
  const unknown = (reason: string): void => { modelReasons.add(reason); agentReasons.add(reason) }
  for (const node of nodes) {
    if (node.config.body || ['iteration', 'loop'].includes(node.kind)) unknown(`节点 ${node.id} 含嵌套或迭代，执行次数不能由节点数确定`)
    if (['if', 'classifier', 'human', 'exit_loop'].includes(node.kind)) unknown(`节点 ${node.id} 包含条件或人工路径，图级计划调用次数未知`)
    if (node.kind === 'agent') modelReasons.add(`节点 ${node.id} 的 Agent 内部模型步骤未知`)
    if (node.kind === 'document' && node.config.documentMode === 'agent') unknown(`节点 ${node.id} 的文档 Agent 和所用工具调用次数未知`)
    if (node.kind === 'tool' && !builtinTools.has(node.config.toolId ?? '') || node.kind === 'document' && node.config.documentMode === 'tool') unknown(`节点 ${node.id} 调用外部工具，其内部模型或 Agent 调用未知`)
    if (node.kind === 'http' || node.kind === 'code' && node.config.language === 'python') unknown(`节点 ${node.id} 可访问外部服务，无法静态证明内部调用成本`)
    if (node.config.verification && (node.kind === 'agent' || workflow.executionPolicy?.repairMode === 'auto')) unknown(`节点 ${node.id} 的验收修复可能产生额外调用`)
  }
  const agentNodes = nodes.filter(node => node.kind === 'agent').length
  return {
    totalNodes: nodes.length,
    modelNodes: nodes.filter(node => directModelKinds.has(node.kind) || node.kind === 'agent' || node.kind === 'document' && node.config.documentMode === 'agent').length,
    agentNodes,
    deterministicNodes: nodes.filter(isPure).length,
    plannedModelCalls: modelReasons.size ? null : nodes.filter(node => directModelKinds.has(node.kind)).length,
    plannedAgentCalls: agentReasons.size ? null : agentNodes,
    unknownReasons: [...new Set([...modelReasons, ...agentReasons])],
  }
}

/** Exceeding a design target is a comparison result, never an execution error. */
export function evaluateOptimizationTarget(stats: OptimizationStats, target?: OptimizationTarget): OptimizationTargetEvaluation {
  if (!target) return { status: 'not_set', reasons: [] }
  const reasons: string[] = [], unknown: string[] = []
  for (const [label, observed, maximum] of [
    ['模型', stats.plannedModelCalls, target.maxModelCalls], ['子 Agent', stats.plannedAgentCalls, target.maxAgentCalls],
  ] as const) {
    if (maximum === undefined) continue
    if (observed === null) unknown.push(`${label}计划调用次数未知，不能确认满足 ${maximum} 次目标`)
    else if (observed > maximum) reasons.push(`${label}计划调用 ${observed} 次，超过 ${maximum} 次目标`)
  }
  if (reasons.length) return { status: 'over_target', reasons: [...reasons, ...unknown] }
  if (unknown.length) return { status: 'unknown', reasons: unknown }
  return { status: 'within_target', reasons: ['已满足可静态核对的图级计划调用目标；不代表提供商实际请求、费用或整体业务质量已验证'] }
}

const equal = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equal(value, right[index]))
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>, keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]))
}

/** Diagnostic paths only: never copy potentially sensitive field values. */
function changedPaths(left: unknown, right: unknown, prefix = ''): string[] {
  const paths: string[] = []
  const visit = (a: unknown, b: unknown, path: string): void => {
    if (paths.length >= 8 || equal(a, b)) return
    if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
      const before = a as Record<string, unknown>, after = b as Record<string, unknown>
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const child = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
        if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key)) paths.push(child)
        else visit(before[key], after[key], child)
        if (paths.length >= 8) break
      }
    } else paths.push(path)
  }
  visit(left, right, prefix)
  return paths
}

/** The only nodes phase one may replace. Even a tool-free native Agent exposes implicit json/steps
 * fields and a subagent execution contract that a node-local replay cannot preserve. */
export const optimizableNode = (node: WorkflowNode): boolean =>
  node.kind === 'llm' && !node.fixed && node.config.verification === undefined && node.config.body === undefined && node.config.toolId === undefined && !(node.config.tools?.length)

/** v0.0.2 phase one replaces individual pure operations, never graph topology. */
export function optimizationReplacementIssues(baseline: Workflow, candidate: Workflow, replacements: readonly OptimizationReplacement[]): PlanningIssue[] {
  const issues: PlanningIssue[] = [], ids = new Set(replacements.map(item => item.nodeId))
  const issue = (code: string, message: string, nodeId?: string, path?: string): void => { issues.push({ code, message, ...(nodeId ? { nodeId } : {}), ...(path !== undefined ? { path } : {}) }) }
  const changed = (code: string, message: string, before: unknown, after: unknown, prefix = '', nodeId?: string): void => {
    const paths = changedPaths(before, after, prefix)
    const detail = `${message}；差异 JSON 路径（最多 8 项）：${paths.join('、')}`
    issue(code, detail.length > 4000 ? `${detail.slice(0, 3999)}…` : detail, nodeId, paths[0] !== undefined && paths[0].length <= 2000 ? paths[0] : undefined)
  }
  if (!replacements.length || ids.size !== replacements.length) issue('OPTIMIZATION_REPLACEMENTS_INVALID', '替换说明必须非空且节点身份唯一')
  const { nodes: beforeNodes, ...before } = baseline, { nodes: afterNodes, ...after } = candidate
  if (!equal(before, after)) changed('OPTIMIZATION_SCOPE_CHANGED', '第一阶段优化必须保留连线、工作流元数据、参数、子 Agent 定义和执行策略；按原图恢复这些字段，优化说明写入 summary', before, after)
  if (!equal(beforeNodes.map(node => node.id), afterNodes.map(node => node.id))) changed('OPTIMIZATION_SCOPE_CHANGED', '第一阶段优化必须保留顶层节点身份与顺序', beforeNodes.map(({ id }) => ({ id })), afterNodes.map(({ id }) => ({ id })), '/nodes')
  const afterById = new Map(afterNodes.map(node => [node.id, node]))
  for (const [index, node] of beforeNodes.entries()) {
    const next = afterById.get(node.id)
    if (!next) continue
    if (!ids.has(node.id)) {
      if (!equal(node, next)) changed('OPTIMIZATION_UNDECLARED_CHANGE', '未声明替换的节点不可改变', node, next, `/nodes/${index}`, node.id)
      continue
    }
    if (!optimizableNode(node))
      issue('OPTIMIZATION_SOURCE_UNSAFE', node.kind === 'agent'
        ? '第一阶段不自动替换 Agent：即使 tools:[]，仍有原生子 Agent 的 text/json/steps 输出与执行合同，需要人工复核；保留原候选'
        : '只能自动替换未固定、无验收副作用要求的顶层 LLM 节点', node.id)
    if (next.kind !== 'template' && !(next.kind === 'code' && (next.config.language === undefined || next.config.language === 'javascript')))
      issue('OPTIMIZATION_TARGET_UNSAFE', '第一阶段仅允许替换为模板或隔离 JavaScript 节点', node.id)
    if (node.config.outputSchema?.length && (next.kind !== 'code' || !equal(node.config.outputSchema, next.config.outputSchema)))
      issue('OPTIMIZATION_OUTPUT_CONTRACT_CHANGED', '结构化 LLM 必须替换为保留同一 outputSchema 的 JavaScript 代码节点，并保持完整 text/json/业务字段输出；模板不能承载结构化输出合同', node.id)
    const { kind: _kind, config: _config, ...metadata } = node, { kind: _nextKind, config: _nextConfig, ...nextMetadata } = next
    if (!equal(metadata, nextMetadata)) changed('OPTIMIZATION_SCOPE_CHANGED', '替换不得改变节点身份、标题、位置或固定状态', metadata, nextMetadata, `/nodes/${index}`, node.id)
    if (next.config.verification !== undefined || next.config.body !== undefined || next.config.toolId !== undefined || next.config.tools !== undefined || next.config.subagentId !== undefined)
      issue('OPTIMIZATION_TARGET_UNSAFE', '确定性替换不得携带工具、子 Agent、容器或外部验收配置', node.id)
  }
  for (const id of ids) if (!beforeNodes.some(node => node.id === id)) issue('OPTIMIZATION_SOURCE_MISSING', '替换必须指向已存在的顶层节点', id)
  return issues
}

/** Only recorded full-output replay may select a replacement automatically. */
export function selectOptimizationCandidate(
  baseline: Workflow, candidate: Workflow, replacements: readonly OptimizationReplacement[], regression?: OptimizationRegressionReport, target?: OptimizationTarget,
): { accepted: boolean; diagnostics: PlanningIssue[]; stats: OptimizationStats; targetEvaluation: OptimizationTargetEvaluation } {
  const diagnostics = optimizationReplacementIssues(baseline, candidate, replacements), stats = optimizationStats(candidate)
  const ids = new Set(replacements.map(item => item.nodeId)), cases = regression?.cases ?? []
  if (!regression || regression.scope !== 'node-transform' || regression.evidenceSource !== 'recorded' || regression.status !== 'passed' || !cases.length || regression.passedRecorded !== cases.length || cases.some(item => item.status !== 'passed' || item.expectedDigest === undefined || item.expectedDigest !== item.actualDigest) || new Set(cases.map(item => item.id)).size !== cases.length || cases.some(item => !ids.has(item.nodeId)))
    diagnostics.push({ code: 'OPTIMIZATION_REGRESSION_UNVERIFIED', message: '只有完整记录证据的全部回归案例通过，才可自动选择替换；保留原候选' })
  for (const id of ids) if (!cases.some(item => item.nodeId === id && item.status === 'passed' && item.expectedDigest !== undefined && item.expectedDigest === item.actualDigest))
    diagnostics.push({ code: 'OPTIMIZATION_EVIDENCE_MISSING', message: '每个替换节点至少需要一条完整输出匹配的真实证据回放', nodeId: id })
  return { accepted: diagnostics.length === 0, diagnostics, stats, targetEvaluation: evaluateOptimizationTarget(stats, target) }
}
