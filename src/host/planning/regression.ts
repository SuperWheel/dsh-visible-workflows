import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  optimizationRegressionCaseSchema,
  type OptimizationEvidenceRef, type OptimizationRegressionCase,
  type OptimizationRegressionCaseResult, type OptimizationRegressionReport,
} from '../../shared/planning-optimization.ts'
import type { ConversationEvidence, ConversationEvidenceRecord } from '../../shared/retrospective.ts'
import { createReferenceScopePlan, referenceScopeIssues } from '../../shared/reference-scope.ts'
import { makeWorkflow, type JsonValue, type Workflow, type WorkflowNode } from '../../shared/types.ts'
import { runJavaScript } from '../execution-adapters.ts'
import { WorkflowRuntime, type ExecutionAdapters, type ModelBackend } from '../runtime.ts'
import { WorkflowStorage } from '../storage.ts'
import { assertGraph, parseWorkflow } from '../validation.ts'
import { validateConversationEvidence } from './conversation-evidence.ts'

type Data = Record<string, JsonValue>
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor'])
export const PLANNING_REGRESSION_LIMITS = { cases: 20, upstreamNodes: 20, caseMs: 5000, totalMs: 30_000 } as const
const limitations = [
  '仅回放 template 或 JavaScript code 目标及累计替换的确定性上游；其他上游只用完整根输出记录。使用现有 WorkflowRuntime 和 Graphon，不调用真实模型、网络、业务工具或文件操作。',
  '样本来自完整工具记录的 reported-success，表示工具曾报告成功，不等于业务结果已独立验证。',
  '通过只证明所选记录样本的完整节点输出一致；不证明全图分支、业务语义、其他输入、性能或生产环境稳定性。',
  '缺失、截断、脱敏、合成或不支持的证据不计入自动替换准入；原始输入和输出不进入回归报告。',
  '每轮最多回放 20 个样本，单样本最多 20 个上游节点；累计替换身份最多 40 个，超过样本依赖范围的情况保留候选并标记跳过。',
  '工作时限之外可能需要等待现有 Graphon 启动或取消清理完成；不会遗留后台业务执行。',
]
class IneligibleCase extends Error {}
const canonical = (value: JsonValue): string => JSON.stringify(value, (_key, item: unknown) =>
  item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
const digest = (value: JsonValue): string => createHash('sha256').update(canonical(value)).digest('hex')
const object = (value: unknown): value is Data => value !== null && typeof value === 'object' && !Array.isArray(value)
function assertJson(value: unknown, depth = 0): asserts value is JsonValue {
  if (depth > 32) throw new IneligibleCase('证据数据嵌套超过回放限制')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object') throw new IneligibleCase('证据不是有限 JSON 数据')
  for (const [key, item] of Object.entries(value)) {
    if (unsafeKeys.has(key)) throw new IneligibleCase('证据包含不安全字段')
    assertJson(item, depth + 1)
  }
}

/** A recorded argument is eligible only with its complete successful result.
 * Conversely, a result is not a shortcut around missing/truncated arguments. */
function successfulRecord(evidence: ConversationEvidence, id: string, resultOnly: boolean): ConversationEvidenceRecord {
  const record = evidence.records.find(item => item.id === id)
  if (!record || !['tool-call', 'tool-result'].includes(record.kind) || resultOnly && record.kind !== 'tool-result'
    || record.truncated || record.status !== 'reported-success' || !record.callId || !record.toolName)
    throw new IneligibleCase('引用不是完整且报告成功的工具证据')
  const pair = evidence.records.filter(item => item.callId === record.callId && item.toolName === record.toolName)
  const calls = pair.filter(item => item.kind === 'tool-call'), results = pair.filter(item => item.kind === 'tool-result')
  if (calls.length !== 1 || results.length !== 1 || calls[0]!.seq >= results[0]!.seq
    || pair.some(item => item.truncated || item.status !== 'reported-success'))
    throw new IneligibleCase('工具调用与结果未形成唯一完整成功配对')
  if (pair.some(item => /\[(?:REDACTED|OMITTED)\b/.test(item.text))) throw new IneligibleCase('脱敏或省略记录不能充当完整回归样本')
  return record
}

function recordedValue(evidence: ConversationEvidence, ref: OptimizationEvidenceRef, resultOnly = false): JsonValue {
  const record = successfulRecord(evidence, ref.evidenceId, resultOnly)
  let value: JsonValue
  try { value = JSON.parse(record.text) as JsonValue } catch { throw new IneligibleCase('证据正文不是完整 JSON，不能猜测或修补回归数据') }
  assertJson(value)
  if (ref.pointer) for (const encoded of ref.pointer.slice(1).split('/')) {
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~')
    if (unsafeKeys.has(key) || value === null || typeof value !== 'object' || !Object.hasOwn(value, key))
      throw new IneligibleCase('证据 JSON pointer 不存在或不安全')
    value = (value as Data)[key]!
  }
  return structuredClone(value)
}

/** Match the original runtime's complete LLM output, including text/json mirrors.
 * A nested Agent.json or arbitrary raw object cannot impersonate this contract. */
function assertBaselineOutput(node: WorkflowNode | undefined, value: Data): void {
  if (!node || node.kind !== 'llm') throw new IneligibleCase('第一阶段仅接受原始 LLM 节点完整输出契约，Agent 或其他原节点不能自动替换')
  const fields = node.config.outputSchema ?? []
  if (!fields.length) {
    if (Object.keys(value).length !== 1 || typeof value.text !== 'string') throw new IneligibleCase('原始普通 LLM 输出必须是完整 {text:string} 对象')
    return
  }
  if (fields.some(field => field.name === 'text' || field.name === 'json')) throw new IneligibleCase('原始 outputSchema 与 text/json 运行输出保留字段冲突，本阶段不自动替换')
  if (typeof value.text !== 'string' || !object(value.json)) throw new IneligibleCase('结构化 LLM 输出必须保留完整 text 与 json 镜像')
  let parsed: unknown
  try { parsed = JSON.parse(value.text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')) }
  catch { throw new IneligibleCase('结构化 LLM 的 text 不能还原对应 JSON') }
  assertJson(parsed)
  if (!object(parsed) || canonical(parsed) !== canonical(value.json)) throw new IneligibleCase('结构化 LLM 的 text 与 json 镜像不一致')
  for (const field of fields) {
    if (!Object.hasOwn(value.json, field.name)) {
      if (field.required !== false) throw new IneligibleCase('完整输出缺少原始 outputSchema 必填字段')
      continue
    }
    const item = value.json[field.name], type = Array.isArray(item) ? 'array' : item === null ? 'null' : typeof item
    if (type !== field.type) throw new IneligibleCase('完整输出不符合原始 outputSchema 字段类型')
  }
  const mirrored = new Set([...Object.keys(value.json), 'text', 'json'])
  if (Object.keys(value).length !== mirrored.size || Object.keys(value).some(key => !mirrored.has(key))
    || Object.entries(value.json).some(([key, item]) => !['text', 'json'].includes(key) && (!Object.hasOwn(value, key) || canonical(value[key]!) !== canonical(item))))
    throw new IneligibleCase('结构化 LLM 输出未保留所有顶层字段与 json 的镜像关系')
}

function assertPureReplacement(target: WorkflowNode): void {
  if (target.kind !== 'template' && !(target.kind === 'code' && (target.config.language ?? 'javascript') === 'javascript'))
    throw new IneligibleCase('第一阶段仅支持主图中的 template 或 JavaScript code 替换节点')
  if (target.config.verification?.requiredFiles?.length || target.config.verification?.requiredReadFiles?.length || target.config.verification?.requiredChangedFiles?.length)
    throw new IneligibleCase('带业务文件验收的节点不在纯数据回放范围内')
  // Explicit state cannot be reconstructed from a text transcript. Do not
  // silently substitute a new run ID, clock, environment or mutable variables.
  const references = JSON.stringify({ inputs: target.config.inputs, text: target.kind === 'template' ? target.config.text : undefined })
  if (/\b(?:sys|env|vars|item|index)(?:[.\[]|\s*\}\})/.test(references))
    throw new IneligibleCase('节点依赖未冻结的系统、环境或容器变量，不能进行单节点回放')
}

function prepareCase(baseline: Workflow, workflow: Workflow, replacementIds: ReadonlySet<string>, evidence: ConversationEvidence, item: OptimizationRegressionCase): { graph: Workflow; rawInputs: Record<string, string>; expected: Data } {
  const target = workflow.nodes.find(node => node.id === item.nodeId)
  if (!target || !replacementIds.has(target.id)) throw new IneligibleCase('回归目标必须属于 Host 提供的累计替换集合')
  const plan = createReferenceScopePlan(workflow), upstream = plan.nodes.get(target.id)!.nodeIds
  const retained = workflow.nodes.filter(node => node.id === target.id || replacementIds.has(node.id) && upstream.has(node.id))
  const retainedIds = new Set(retained.map(node => node.id))
  for (const node of retained) assertPureReplacement(node)
  const input = workflow.nodes.find(node => node.kind === 'input')
  if (!input || input.config.fields?.some(field => field.type === 'file' || field.type === 'files'))
    throw new IneligibleCase('缺少主图输入或包含业务附件输入，不能进行纯数据回放')
  const values = item.workflowInputs ? recordedValue(evidence, item.workflowInputs) : {}
  if (!object(values) || Object.values(values).some(value => typeof value !== 'string'))
    throw new IneligibleCase('workflowInputs 必须引用完整的字符串字段对象')
  if (item.expected.pointer !== '') throw new IneligibleCase('expected 只允许完整工具结果根对象，不能选择 Agent.json 或其他局部字段')
  const expected = recordedValue(evidence, item.expected, true)
  if (!object(expected)) throw new IneligibleCase('expected 必须引用完整节点输出对象，不接受局部标量比较')
  assertBaselineOutput(baseline.nodes.find(node => node.id === target.id), expected)
  const entries = Object.entries(item.upstreamOutputs ?? {})
  if (entries.length > PLANNING_REGRESSION_LIMITS.upstreamNodes) throw new IneligibleCase('上游记录节点超过回放限制')
  for (const [, ref] of entries) if (ref.pointer !== '') throw new IneligibleCase('upstreamOutputs 只允许完整工具结果根对象，不能用局部字段伪装节点输出')
  const seeds: WorkflowNode[] = entries.flatMap(([id, ref]) => {
    const source = workflow.nodes.find(node => node.id === id)
    if (!source || !upstream.has(id) || id === input.id || source.config.body)
      throw new IneligibleCase('上游样本必须对应原主图中的真实上游非容器节点，输入节点请用 workflowInputs')
    // A previous replacement is executable code, never a recorded constant.
    // Ignore an unnecessary old fixture; the real config is retained below.
    if (retainedIds.has(id)) return []
    if ([...plan.nodes.get(id)!.nodeIds].some(ancestor => retainedIds.has(ancestor)))
      throw new IneligibleCase('累计替换路径中夹有只能用记录替代的未替换节点，无法证明组合回归')
    const output = recordedValue(evidence, ref, true)
    if (!object(output)) throw new IneligibleCase('上游样本必须是完整输出对象')
    const original = baseline.nodes.find(node => node.id === source.id)
    if (original?.kind === 'llm') assertBaselineOutput(original, output)
    return [{ ...structuredClone(source), kind: 'code' as const, fixed: false, config: {
      language: 'javascript', inputs: {}, code: `function main(inputs) { return ${JSON.stringify(output)}; }`,
    } }]
  })
  if (seeds.length + retained.length > PLANNING_REGRESSION_LIMITS.upstreamNodes + 1) throw new IneligibleCase('累计替换片段超过回放节点限制')
  const output: WorkflowNode = { id: randomUUID(), number: '', title: '回归输出', kind: 'output', fixed: false, x: 0, y: 0, config: { text: '已完成节点回放', outputName: 'result' } }
  const nodes = [structuredClone(input), ...seeds, ...structuredClone(retained), output]
  const edges = seeds.map(seed => ({ id: randomUUID(), source: input.id, target: seed.id }))
  for (const node of retained) {
    const ancestors = plan.nodes.get(node.id)!.nodeIds
    const parents = [input, ...seeds, ...retained].filter(candidate => ancestors.has(candidate.id))
    if (!parents.length) throw new IneligibleCase('无法从记录重建累计替换节点的上游依赖')
    for (const parent of parents) edges.push({ id: randomUUID(), source: parent.id, target: node.id })
  }
  edges.push({ id: randomUUID(), source: target.id, target: output.id })
  // Keep the candidate's config and original input declarations intact. Only
  // antecedent outputs are substituted; no config.inputs fixups are permitted.
  const graph = parseWorkflow({ ...makeWorkflow('planning-regression', '规划节点样本回放'), nodes, edges })
  const invalid = referenceScopeIssues(graph, { strictMissing: true })
  if (invalid.length) throw new IneligibleCase('候选保留的变量映射缺少已记录的上游依赖或引用无效')
  assertGraph(graph, true)
  return { graph, rawInputs: values as Record<string, string>, expected }
}

export interface PlanningRegressionOptions {
  /** Original graph before any optimization round; never the selected candidate. */
  baseline: Workflow
  workflow: Workflow
  /** Host-computed cumulative replacement IDs, including previous rounds. */
  replacementNodeIds: readonly string[]
  evidence: ConversationEvidence
  cases: readonly OptimizationRegressionCase[]
  signal: AbortSignal
  /** Host work deadline; may be shortened but never extends the 30 second cap. */
  timeoutMs?: number
  /** Trusted Host-only location of immutable Graphon assets. Never an agent field. */
  runtimeDirectory?: string
}

/** Runs existing runtime semantics in a disposable store. No host catalog,
 * credentials, native agents, workspace paths or readiness callbacks are wired. */
export async function runPlanningRegression(options: PlanningRegressionOptions): Promise<OptimizationRegressionReport> {
  const results: OptimizationRegressionCaseResult[] = []
  const report = (extra?: string): OptimizationRegressionReport => ({
    scope: 'node-transform', evidenceSource: 'recorded',
    status: results.some(item => item.status === 'cancelled') ? 'cancelled'
      : results.some(item => item.status === 'timeout') ? 'timeout'
      : results.some(item => item.status === 'failed') ? 'failed'
      : !results.length || results.some(item => item.status === 'skipped') ? 'skipped' : 'passed',
    cases: results, passedRecorded: results.filter(item => item.status === 'passed').length,
    limitations: [...limitations, ...(extra ? [extra] : [])],
  })
  if (!Array.isArray(options.cases) || options.cases.length > PLANNING_REGRESSION_LIMITS.cases)
    return report('请求超过单轮 20 个回归样本限制；未截断执行。')
  let cases: OptimizationRegressionCase[], evidence: ConversationEvidence, workflow: Workflow, baseline: Workflow, replacementIds: ReadonlySet<string>
  try {
    cases = options.cases.map(item => optimizationRegressionCaseSchema.parse(item))
    if (new Set(cases.map(item => item.id)).size !== cases.length) throw new Error('duplicate')
    evidence = validateConversationEvidence(options.evidence)
    workflow = parseWorkflow(options.workflow); assertGraph(workflow)
    baseline = parseWorkflow(options.baseline); assertGraph(baseline)
    if (!Array.isArray(options.replacementNodeIds) || !options.replacementNodeIds.length || options.replacementNodeIds.length > 40
      || new Set(options.replacementNodeIds).size !== options.replacementNodeIds.length) throw new Error('replacement identities')
    replacementIds = new Set(options.replacementNodeIds)
    if (canonical(baseline.edges as unknown as JsonValue) !== canonical(workflow.edges as unknown as JsonValue)
      || baseline.id !== workflow.id || canonical(baseline.nodes.map(node => node.id)) !== canonical(workflow.nodes.map(node => node.id))
      || baseline.nodes.some(node => !replacementIds.has(node.id) && canonical(node as unknown as JsonValue) !== canonical(workflow.nodes.find(item => item.id === node.id)! as unknown as JsonValue))
      || options.replacementNodeIds.some(id => !baseline.nodes.some(node => node.id === id && node.kind === 'llm')))
      throw new Error('unverified baseline or cumulative scope')
  } catch { return report('回归请求、证据摘要或当前 Workflow 结构无效；未执行任何节点。') }
  const timeout = options.timeoutMs === undefined ? PLANNING_REGRESSION_LIMITS.totalMs
    : Math.max(1, Math.min(PLANNING_REGRESSION_LIMITS.totalMs, Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1))
  const deadline = Date.now() + timeout
  let directory: string | undefined, runtime: WorkflowRuntime | undefined
  const backend: ModelBackend = { generate: async () => { throw new Error('回归回放禁止调用模型') } }
  const adapters: ExecutionAdapters = { execute: async (kind, request) => {
    if (kind !== 'code' || request.node.config.language !== 'javascript') throw new Error('回归回放禁止外部副作用')
    return runJavaScript(request.node.config.code ?? '', request.inputs, request.signal, request.node.config.timeoutMs)
  } }
  try {
    for (const item of cases) {
      const base = { id: item.id, nodeId: item.nodeId }
      if (options.signal.aborted) { results.push({ ...base, status: 'cancelled', reason: '回归已取消，未启动此样本' }); continue }
      if (Date.now() >= deadline) { results.push({ ...base, status: 'timeout', reason: '本轮回归工作时限已到，保留候选与既有报告' }); continue }
      let prepared: ReturnType<typeof prepareCase>
      try { prepared = prepareCase(baseline, workflow, replacementIds, evidence, item) }
      catch (error) { results.push({ ...base, status: 'skipped', reason: error instanceof IneligibleCase ? error.message : '无法构造安全且有效的单节点回放图' }); continue }
      const expectedDigest = digest(prepared.expected)
      let timer: ReturnType<typeof setTimeout> | undefined, expired = false, cancelled = false
      let abort: (() => void) | undefined
      try {
        if (!runtime) { directory = mkdtempSync(join(tmpdir(), 'dsh-planning-regression-')); runtime = new WorkflowRuntime(new WorkflowStorage(directory), backend, adapters, undefined, { runtimeDirectory: options.runtimeDirectory }) }
        const run = runtime.start(prepared.graph.id, prepared.rawInputs, undefined, { sourceGraph: prepared.graph })
        const current = runtime
        const cancellation = new Promise<never>((_resolve, reject) => {
          abort = () => { cancelled = options.signal.aborted; void current.cancel(run.id).catch(() => {}); reject(new Error('regression stopped')) }
          timer = setTimeout(() => { expired = true; abort!() }, Math.max(1, Math.min(PLANNING_REGRESSION_LIMITS.caseMs, deadline - Date.now())))
          options.signal.addEventListener('abort', abort, { once: true })
          if (options.signal.aborted) abort()
        })
        const settled = await Promise.race([current.settle(run.id), cancellation])
        if (settled.status !== 'success') {
          results.push({ ...base, expectedDigest, status: settled.status === 'waiting' ? 'skipped' : 'failed', reason: settled.status === 'waiting' ? '冻结样本未提供全部必填输入' : '节点未通过 Graphon 回放；不展示可能包含业务数据的原始执行异常' })
        } else {
          const actual = settled.executions.find(record => record.nodeId === item.nodeId)?.data
          if (!actual) results.push({ ...base, expectedDigest, status: 'failed', reason: '回放没有产生目标节点的完整输出' })
          else {
            const actualDigest = digest(actual), equal = canonical(actual) === canonical(prepared.expected)
            results.push({ ...base, expectedDigest, actualDigest, status: equal ? 'passed' : 'failed', reason: equal ? '所选记录样本的完整节点输出一致' : '完整节点输出与记录期望不同，不能自动接受替换' })
          }
        }
      } catch {
        results.push({ ...base, expectedDigest, status: cancelled || options.signal.aborted ? 'cancelled' : expired ? 'timeout' : 'failed', reason: cancelled || options.signal.aborted ? '回归已取消' : expired ? '单样本或本轮回归达到工作时限' : '隔离回放未完成；未调用真实模型或外部业务工具' })
        // A timed-out engine is closed before another case can start, so late
        // callbacks cannot contaminate a later report or outlive this function.
        if (runtime) { await runtime.close(); runtime = undefined }
        if (directory) { rmSync(directory, { recursive: true, force: true }); directory = undefined }
      } finally {
        if (timer) clearTimeout(timer)
        if (abort) options.signal.removeEventListener('abort', abort)
      }
    }
  } finally {
    try { await runtime?.close() } finally { if (directory) rmSync(directory, { recursive: true, force: true }) }
  }
  return report()
}
