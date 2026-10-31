import { describe, expect, it } from 'vitest'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { optimizationEvidenceRefSchema, optimizationOutputSchema, optimizationReportSchema, parseOptimizationOutput, parseOptimizationTarget, type OptimizationRegressionReport } from '../src/shared/planning-optimization.ts'
import { evaluateOptimizationTarget, optimizationReplacementIssues, optimizationStats, selectOptimizationCandidate } from '../src/host/planning/optimization.ts'
import type { NodeKind, Workflow, WorkflowNode } from '../src/shared/types.ts'

const node = (id: string, kind: NodeKind, config: WorkflowNode['config'] = {}): WorkflowNode => ({ id, kind, config, title: id, number: id, x: 0, y: 0, fixed: false })
const flow = (middle = node('transform', 'llm', { prompt: '{{input.text}}' })): Workflow => ({
  id: 'flow', workspaceId: 'workspace', title: '任务', description: '', revision: 1, createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z', notes: [],
  nodes: [node('start', 'input', { fields: [{ name: 'text', label: '文本', required: true }] }), middle, node('end', 'output', { text: '{{transform.text}}', outputName: 'result' })],
  edges: [{ id: 'e1', source: 'start', target: 'transform' }, { id: 'e2', source: 'transform', target: 'end' }],
})
const replacement = [{ nodeId: 'transform', reason: '规则明确的文本转换使用模板' }]
const optimized = (): Workflow => flow(node('transform', 'template', { text: '{{input.text}}' }))
const digest = 'a'.repeat(64)
const passed = (): OptimizationRegressionReport => ({ scope:'node-transform', evidenceSource:'recorded', status: 'passed', passedRecorded: 1, limitations: ['仅证明记录样本一致'], cases: [{ id: 'case1', nodeId: 'transform', status: 'passed', expectedDigest: digest, actualDigest: digest }] })

describe('v0.0.2 optimization contracts', () => {
  it('accepts only explicit nonnegative planned call targets, not runtime budgets', () => {
    expect(parseOptimizationTarget({ maxModelCalls: 0, maxAgentCalls: 2 })).toEqual({ maxModelCalls: 0, maxAgentCalls: 2 })
    for (const value of [{}, { maxModelCalls: -1 }, { maxModelCalls: 1.5 }, { tokenBudget: 1000 }, { maxModelCalls: 1, money: 2 }]) expect(() => parseOptimizationTarget(value)).toThrow()
  })
  it('requires safe evidence pointers without literal expected values', () => {
    expect(optimizationEvidenceRefSchema.parse({ evidenceId: 'e12', pointer: '/value/a~1b/~0key' }).pointer).toContain('~1')
    for (const pointer of ['value', '/__proto__', '/constructor', '/prototype', '/bad~2escape', '/bad~']) expect(() => optimizationEvidenceRefSchema.parse({ evidenceId: 'e12', pointer })).toThrow()
    expect(() => parseOptimizationOutput({ outcome: 'candidate', graphJson: '{}', summary: '改用模板', replacements: replacement, regressionCases: [{ id: 'c', nodeId: 'transform', expected: { value: { text: '伪造' } } }] })).toThrow()
  })
  it('keeps DSH structured output compatible and permits a genuinely unverified proposal', () => {
    assertObjectJsonSchema(optimizationOutputSchema)
    const value = { outcome: 'candidate', graphJson: '{}', summary: '候选缺少可回放证据', replacements: replacement, regressionCases: [] }
    expect(validateJsonSchemaValue(optimizationOutputSchema, value)).toEqual([])
    expect(parseOptimizationOutput(value)).toEqual(value)
    expect(() => parseOptimizationOutput({ ...value, outcome: 'unchanged' })).toThrow()
    expect(parseOptimizationOutput({ outcome: 'unchanged', graphJson: '', summary: '已经为确定性步骤', replacements: [], regressionCases: [] }).outcome).toBe('unchanged')
  })
  it('rejects duplicate cases, undeclared nodes and excessive replay evidence', () => {
    const c = { id: 'c', nodeId: 'transform', expected: { evidenceId: 'e2', pointer: '' } }
    const value = { outcome: 'candidate', graphJson: '{}', summary: '改用模板', replacements: replacement, regressionCases: [c] }
    expect(() => parseOptimizationOutput({ ...value, regressionCases: [c, c] })).toThrow()
    expect(() => parseOptimizationOutput({ ...value, regressionCases: [{ ...c, nodeId: 'end' }] })).toThrow()
    expect(() => parseOptimizationOutput({ ...value, regressionCases: Array.from({ length: 21 }, (_, i) => ({ ...c, id: `c${i}` })) })).toThrow()
  })
})

describe('planned calls and target assessment', () => {
  it('compares graph-level counts without claiming token, money or timing savings', () => {
    expect(optimizationStats(flow())).toEqual({ totalNodes: 3, modelNodes: 1, agentNodes: 0, deterministicNodes: 2, plannedModelCalls: 1, plannedAgentCalls: 0, unknownReasons: [] })
    expect(optimizationStats(optimized())).toMatchObject({ totalNodes: 3, modelNodes: 0, deterministicNodes: 3, plannedModelCalls: 0 })
    expect(evaluateOptimizationTarget(optimizationStats(flow()), { maxModelCalls: 0 }).status).toBe('over_target')
    expect(evaluateOptimizationTarget(optimizationStats(optimized()), { maxModelCalls: 0 }).status).toBe('within_target')
    expect(evaluateOptimizationTarget(optimizationStats(flow())).status).toBe('not_set')
  })
  it('keeps Agent model steps unknown while counting known native activations', () => {
    const stats = optimizationStats(flow(node('transform', 'agent', { tools: [], prompt: '格式化', subagentId: 'writer' })))
    expect(stats).toMatchObject({ modelNodes: 1, agentNodes: 1, plannedModelCalls: null, plannedAgentCalls: 1 })
    expect(evaluateOptimizationTarget(stats, { maxModelCalls: 10 }).status).toBe('unknown')
    expect(evaluateOptimizationTarget(stats, { maxAgentCalls: 1 }).status).toBe('within_target')
    expect(evaluateOptimizationTarget(stats, { maxAgentCalls: 0, maxModelCalls: 10 }).status).toBe('over_target')
  })
  it.each(['if', 'classifier', 'human', 'loop', 'iteration'] as const)('marks %s path counts unknown', kind => {
    const stats = optimizationStats(flow(node('transform', kind)))
    expect(stats.plannedModelCalls).toBeNull()
    expect(stats.plannedAgentCalls).toBeNull()
    expect(evaluateOptimizationTarget(stats, { maxModelCalls: 100 }).status).toBe('unknown')
  })
  it('does not treat external tools, document agents or arbitrary builtin names as zero calls', () => {
    for (const middle of [node('transform', 'tool', { toolId: 'workflow:other' }), node('transform', 'tool', { toolId: 'builtin:unknown' }), node('transform', 'document', { documentMode: 'agent' }), node('transform', 'http', { url: 'https://api.example.test' })]) expect(optimizationStats(flow(middle)).plannedModelCalls).toBeNull()
    expect(optimizationStats(flow(node('transform', 'tool', { toolId: 'builtin:json.parse' }))).plannedModelCalls).toBe(0)
  })
})

describe('bounded deterministic replacement and evidence selection', () => {
  it('selects a verified pure replacement and leaves caller objects unchanged', () => {
    const baseline = flow(), candidate = optimized(), before = structuredClone({ baseline, candidate })
    expect(selectOptimizationCandidate(baseline, candidate, replacement, passed(), { maxModelCalls: 0 })).toMatchObject({ accepted: true, diagnostics: [], targetEvaluation: { status: 'within_target' } })
    expect({ baseline, candidate }).toEqual(before)
  })
  it('accepts a verified improvement even if other nodes still exceed the target', () => {
    const baseline = flow(), candidate = optimized()
    baseline.nodes.push(node('remaining', 'llm', { prompt: '摘要' })); candidate.nodes.push(node('remaining', 'llm', { prompt: '摘要' }))
    const result = selectOptimizationCandidate(baseline, candidate, replacement, passed(), { maxModelCalls: 0 })
    expect(result.accepted).toBe(true)
    expect(result.targetEvaluation.status).toBe('over_target')
  })
  it('keeps the baseline without complete full-output evidence', () => {
    expect(selectOptimizationCandidate(flow(), optimized(), replacement).accepted).toBe(false)
    for (const report of [
      { ...passed(), status: 'failed' as const }, { ...passed(), passedRecorded: 0 },
      { ...passed(), scope:undefined }, { ...passed(), evidenceSource:undefined },
      { ...passed(), cases: [{ ...passed().cases[0]!, actualDigest: 'b'.repeat(64) }] },
      { ...passed(), cases: [{ ...passed().cases[0]!, actualDigest: undefined, expectedDigest: undefined }] },
    ]) expect(selectOptimizationCandidate(flow(), optimized(), replacement, report).accepted).toBe(false)
  })
  it('requires every case to pass rather than accepting one passing case per node', () => {
    const report = passed(); report.passedRecorded = 2; report.cases.push({ ...report.cases[0]!, id: 'c2', actualDigest: 'b'.repeat(64) })
    expect(selectOptimizationCandidate(flow(), optimized(), replacement, report).accepted).toBe(false)
  })
  it('retains every Agent source even with explicit empty tools and passing local evidence', () => {
    for (const config of [{ prompt: 'x' }, { tools: [], prompt: 'x' }, { tools: ['native:write'], prompt: 'x' }, { tools: [], verification: { minTextLength: 1 } }]) {
      const baseline = flow(node('transform', 'agent', config)), result = selectOptimizationCandidate(baseline, optimized(), replacement, passed())
      expect(result.accepted).toBe(false)
      expect(result.diagnostics.some(issue => issue.code === 'OPTIMIZATION_SOURCE_UNSAFE' && issue.message.includes('人工复核'))).toBe(true)
    }
  })
  it('rejects Agent replacements that would discard implicit steps or json used downstream', () => {
    for (const reference of ['{{transform.steps}}', '{{transform.json}}']) {
      const baseline = flow(node('transform', 'agent', { tools: [], prompt: '处理文本', subagentId: 'worker' }))
      baseline.nodes[2]!.config.text = reference
      const candidate = structuredClone(baseline)
      candidate.nodes[1] = node('transform', 'template', { text: '{{input.text}}' })
      expect(selectOptimizationCandidate(baseline, candidate, replacement, passed()).diagnostics.some(issue => issue.code === 'OPTIMIZATION_SOURCE_UNSAFE')).toBe(true)
      candidate.nodes[1] = node('transform', 'code', { language: 'javascript', code: 'function main(inputs) { return {text: "x", json: {text: "x"}, steps: 1}; }' })
      expect(selectOptimizationCandidate(baseline, candidate, replacement, passed()).accepted).toBe(false)
    }
  })
  it('rejects fixed or file-verifying LLM sources', () => {
    const baseline = flow()
    baseline.nodes[1]!.fixed = true
    expect(optimizationReplacementIssues(baseline, optimized(), replacement).some(issue => issue.code === 'OPTIMIZATION_SOURCE_UNSAFE')).toBe(true)
    baseline.nodes[1]!.fixed = false; baseline.nodes[1]!.config.verification = { minTextLength: 1 }
    expect(optimizationReplacementIssues(baseline, optimized(), replacement).some(issue => issue.code === 'OPTIMIZATION_SOURCE_UNSAFE')).toBe(true)
  })
  it('rejects topology, metadata, input schema, other node and authority changes', () => {
    const mutations = [
      (candidate: Workflow) => { candidate.title = '不同任务' },
      (candidate: Workflow) => { candidate.edges = [] },
      (candidate: Workflow) => { candidate.executionPolicy = { tokenBudget: 1 } },
      (candidate: Workflow) => { candidate.nodes[0]!.config.fields = [] },
      (candidate: Workflow) => { candidate.nodes[1]!.title = '新标题' },
      (candidate: Workflow) => { candidate.nodes.push(node('extra', 'output')) },
    ]
    for (const mutate of mutations) { const candidate = optimized(); mutate(candidate); expect(optimizationReplacementIssues(flow(), candidate, replacement).length).toBeGreaterThan(0) }
  })
  it('permits declared kind/config replacement but identifies a rewritten workflow description', () => {
    const baseline = flow()
    baseline.description = 'input→普通 llm→output，先保留业务基线'
    const candidate = structuredClone(baseline)
    candidate.nodes[1]!.kind = 'template'
    candidate.nodes[1]!.config = { inputs: { text: '{{input.text}}' }, text: '{{text}}' }
    expect(optimizationReplacementIssues(baseline, candidate, replacement)).toEqual([])
    candidate.description = 'input→确定性 template→output，已消除模型调用'
    const before = structuredClone({ baseline, candidate })
    const issues = optimizationReplacementIssues(baseline, candidate, replacement)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ code: 'OPTIMIZATION_SCOPE_CHANGED', path: '/description' })
    expect(issues[0]!.message).toContain('/description')
    expect(selectOptimizationCandidate(baseline, candidate, replacement, passed()).accepted).toBe(false)
    expect({ baseline, candidate }).toEqual(before)
  })
  it('pinpoints changed edge and node metadata without relaxing either scope', () => {
    const candidate = optimized()
    candidate.edges[0]!.target = 'end'
    candidate.nodes[1]!.title = '擅自改标题'
    candidate.nodes[2]!.config.outputName = 'different'
    const issues = optimizationReplacementIssues(flow(), candidate, replacement)
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'OPTIMIZATION_SCOPE_CHANGED', path: '/edges/0/target' }),
      expect.objectContaining({ code: 'OPTIMIZATION_SCOPE_CHANGED', nodeId: 'transform', path: '/nodes/1/title' }),
      expect.objectContaining({ code: 'OPTIMIZATION_UNDECLARED_CHANGE', nodeId: 'end', path: '/nodes/2/config/outputName' }),
    ]))
    const reordered = optimized()
    reordered.nodes.reverse()
    expect(optimizationReplacementIssues(flow(), reordered, replacement)).toContainEqual(expect.objectContaining({ code: 'OPTIMIZATION_SCOPE_CHANGED', path: '/nodes/0/id' }))
  })
  it('escapes diagnostic JSON paths, omits values and bounds long diagnostic messages', () => {
    const baseline = flow(), candidate = optimized()
    baseline.nodes[2]!.config.inputs = { 'a/b~c': 'private-before' }
    candidate.nodes[2]!.config.inputs = { 'a/b~c': 'private-after' }
    const issue = optimizationReplacementIssues(baseline, candidate, replacement)[0]!
    expect(issue.path).toBe('/nodes/2/config/inputs/a~1b~0c')
    expect(issue.message).not.toContain('private-')
    for (let i = 0; i < 8; i++) candidate.nodes[2]!.config.inputs[`${i}${'x'.repeat(1500)}`] = 'private-extra'
    const bounded = optimizationReplacementIssues(baseline, candidate, replacement)[0]!
    expect(bounded.message.length).toBeLessThanOrEqual(4000)
    expect(bounded.message).toMatch(/…$/)
    expect(bounded.message).not.toContain('private-')
  })
  it('preserves declared output types instead of removing validation to save model calls',()=>{
    const baseline=flow();baseline.nodes[1]!.config.outputSchema=[{name:'text',type:'string',required:true}]
    expect(optimizationReplacementIssues(baseline,optimized(),replacement).some(issue=>issue.code==='OPTIMIZATION_OUTPUT_CONTRACT_CHANGED')).toBe(true)
    const candidate=flow(node('transform','code',{language:'javascript',inputs:{text:'{{input.text}}'},code:'function main(inputs) { const json = {text: inputs.text}; return {text: JSON.stringify(json), json}; }',outputSchema:baseline.nodes[1]!.config.outputSchema}))
    expect(optimizationReplacementIssues(baseline,candidate,replacement)).toEqual([])
    candidate.nodes[1]!.config.outputSchema=[{name:'text',type:'string',required:false}]
    expect(optimizationReplacementIssues(baseline,candidate,replacement).some(issue=>issue.code==='OPTIMIZATION_OUTPUT_CONTRACT_CHANGED')).toBe(true)
  })
  it('rejects a structured LLM template even if raw config copies outputSchema',()=>{
    const baseline=flow();baseline.nodes[1]!.config.outputSchema=[{name:'count',type:'number',required:true}]
    const candidate=optimized();candidate.nodes[1]!.config.outputSchema=structuredClone(baseline.nodes[1]!.config.outputSchema)
    expect(optimizationReplacementIssues(baseline,candidate,replacement).some(issue=>issue.code==='OPTIMIZATION_OUTPUT_CONTRACT_CHANGED')).toBe(true)
    expect(selectOptimizationCandidate(baseline,candidate,replacement,passed()).accepted).toBe(false)
  })
  it('rejects Python, HTTP and leftover agent/tool configuration in replacement nodes', () => {
    for (const replacementNode of [node('transform', 'code', { language: 'python', code: 'result={}' }), node('transform', 'http', { url: 'https://example.test' }), node('transform', 'template', { text: 'x', subagentId: 'worker' })]) expect(optimizationReplacementIssues(flow(), flow(replacementNode), replacement).some(issue => issue.code === 'OPTIMIZATION_TARGET_UNSAFE')).toBe(true)
    expect(optimizationReplacementIssues(flow(), flow(node('transform', 'code', { language: 'javascript', code: 'return {text: inputs.text}' })), replacement)).toEqual([])
  })
  it('validates stored report candidates with the current Workflow contract', () => {
    const candidate = flow(), stats = optimizationStats(candidate), targetEvaluation = evaluateOptimizationTarget(stats)
    const report = { engineVersion: '0.0.2', baseline: { candidate, stats, targetEvaluation }, selected: { stats, targetEvaluation }, selection: 'baseline', attempts: [], stopReason: 'already-deterministic' }
    expect(optimizationReportSchema.parse(report).baseline.candidate.id).toBe('flow')
    expect(() => optimizationReportSchema.parse({ ...report, baseline: { ...report.baseline, candidate: { ...candidate, nodes: [{ id: 'x', kind: 'unknown' }] } } })).toThrow()
  })
})
