import { describe, expect, it } from 'vitest'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { nodeCapabilityCatalog } from '../src/shared/node-capabilities.ts'
import { parsePlannerOutput, parsePlanningRequest, plannerOutputSchema } from '../src/shared/planning-schema.ts'
import { materializePlanningCandidate, planningCandidateIssues, projectWorkflow } from '../src/shared/planning-projection.ts'
import type { PlanningContext, PlanningProjection } from '../src/shared/planning-types.ts'
import { NODE_LABELS, type NodeKind, type Workflow, type WorkflowNode } from '../src/shared/types.ts'
import { parseWorkflowPackage, exportWorkflowJson } from '../src/shared/workflow-format.ts'

const node = (id: string, kind: NodeKind, config: WorkflowNode['config']): WorkflowNode => ({ id, kind, config, title: id, number: id, x: 50, y: 25, fixed: false })
function baseline(): Workflow {
  return { id: 'flow', workspaceId: 'workspace', title: '流程', description: '', revision: 4, createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T01:00:00.000Z',
    nodes: [node('start', 'input', { fields: [{ name: 'text', label: '文本', required: true, type: 'text' }] }), node('write', 'template', { text: '{{input.text}}' }), node('end', 'output', { text: '{{write.text}}', outputName: 'result' })],
    edges: [{ id: 'e1', source: 'start', target: 'write' }, { id: 'e2', source: 'write', target: 'end' }], notes: [],
    executionPolicy: { tokenBudget: 10000 }, budgetDecision: { mode: 'limited', decidedAt: '2026-10-17T00:00:00.000Z' },
  }
}
function context(flow = baseline()): PlanningContext {
  return { workflow: flow, operation: 'revise', targetNodeIds: [], nodeIds: ['new-node', 'inner-start', 'inner-end'], subagentIds: ['new-agent'], environmentIds: ['new-env'], model: { provider: 'test', model: 'model' }, tools: [] }
}
const candidate = (projection: PlanningProjection, ctx = context()) => materializePlanningCandidate(JSON.stringify(projection), ctx)
const codes = (flow: Workflow, ctx: PlanningContext) => planningCandidateIssues(flow, ctx).map(issue => issue.code)

describe('planner request and output envelope', () => {
  it('requires a persisted revision for updates and allows only unused reserved identities for create', () => {
    expect(parsePlanningRequest({ requestId: 'r', operation: 'create', instruction: '创建' }).operation).toBe('create')
    expect(() => parsePlanningRequest({ requestId: 'r', operation: 'revise', instruction: '改图', targetWorkflowId: 'flow' })).toThrow()
    expect(() => parsePlanningRequest({ requestId: 'r', operation: 'create', instruction: '创建', expectedRevision: 1 })).toThrow()
    expect(parsePlanningRequest({ requestId: 'r', operation: 'create', instruction: '创建', targetWorkflowId: 'reserved-new-id', expectedRevision: 0 }).targetWorkflowId).toBe('reserved-new-id')
    expect(() => parsePlanningRequest({ requestId: 'r', operation: 'revise', instruction: '改图', targetWorkflowId: 'flow', expectedRevision: 0 })).toThrow()
    expect(() => parsePlanningRequest({ requestId: 'r', operation: 'create', instruction: '创建', targetNodeIds: ['node'] })).toThrow()
    expect(() => parsePlanningRequest({ requestId: 'r', operation: 'create', instruction: '创建', workspaceId: 'forged' })).toThrow()
  })
  it('uses a valid DSH envelope and separates candidates from clarification', () => {
    assertObjectJsonSchema(plannerOutputSchema)
    const output = { outcome: 'candidate', graphJson: '{}', summary: '候选', assumptions: [], questions: [], requirementCoverage: [] }
    expect(validateJsonSchemaValue(plannerOutputSchema, output)).toEqual([])
    expect(parsePlannerOutput(output)).toEqual(output)
    expect(() => parsePlannerOutput({ ...output, outcome: 'needs-input' })).toThrow()
    expect(parsePlannerOutput({ ...output, outcome: 'needs-input', graphJson: '', questions: [{ id: 'q1', question: '输出什么？', options: ['文本', 'JSON'] }] }).outcome).toBe('needs-input')
  })
})

describe('current Workflow projection', () => {
  it('roundtrips execution semantics into the current export without exposing authority', () => {
    const ctx = context(), before = structuredClone(ctx.workflow), projected = projectWorkflow(ctx.workflow)
    expect(projected).not.toHaveProperty('workspaceId')
    expect(projected).not.toHaveProperty('executionPolicy')
    expect(projected.nodes[0]).not.toHaveProperty('fixed')
    const next = candidate(projected, ctx)
    expect(planningCandidateIssues(next, ctx)).toEqual([])
    expect(next.executionPolicy).toEqual(before.executionPolicy)
    expect(next.createdAt).toBe(before.createdAt)
    expect(next.edges).toEqual(before.edges)
    expect(next.nodes.map(item => [item.id, item.x, item.y])).toEqual(before.nodes.map(item => [item.id, item.x, item.y]))
    expect(parseWorkflowPackage(exportWorkflowJson(next)).formatVersion).toBe(2)
    expect(ctx.workflow).toEqual(before)
  })
  it.each(['workspaceId', 'revision', 'createdAt', 'executionPolicy', 'budgetDecision', 'formatVersion', 'runtime', 'editor'])(`rejects model-owned %s`, key => {
    const ctx = context()
    expect(() => candidate({ ...projectWorkflow(ctx.workflow), [key]: {} } as PlanningProjection, ctx)).toThrow()
  })
  it('rejects node metadata and arbitrary new identities', () => {
    const ctx = context(), projected = projectWorkflow(ctx.workflow)
    expect(() => candidate({ ...projected, nodes: projected.nodes.map((item, index) => index ? item : { ...item, fixed: false }) }, ctx)).toThrow()
    projected.nodes[1]!.id = 'invented'
    expect(() => candidate(projected, ctx)).toThrow('UNALLOCATED_NODE_ID')
  })
  it('preserves saved subagent bindings and role provenance while exposing only editable fields', () => {
    const ctx = context(); ctx.workflow.subAgents = [{ id: 'worker', number: 'agent-5', name: '分析员', prompt: '角色', sessionId: 'session', rolePresetId: 'role', rolePresetRevision: 7 }]
    ctx.workflow.nodes[1] = node('write', 'agent', { subagentId: 'worker', prompt: '{{input.text}}' })
    const projected = projectWorkflow(ctx.workflow)
    expect(Object.keys(projected.subAgents![0]!).sort()).toEqual(['id', 'name', 'prompt'])
    expect(candidate(projected, ctx).subAgents).toEqual(ctx.workflow.subAgents)
    const malicious = structuredClone(projected); Object.assign(malicious.subAgents![0]!, { sessionId: 'forged' })
    expect(() => candidate(malicious, ctx)).toThrow()
    projected.nodes[1]!.config.rolePresetId = 'legacy-role'
    expect(() => candidate(projected, ctx)).toThrow('rolePresetId')
  })
  it('allocates approved subagents and environment IDs, but rejects Secret values and revisions', () => {
    const ctx = context(), projected = projectWorkflow(ctx.workflow)
    projected.subAgents = [{ id: 'new-agent', name: '检查员', prompt: '核对内容' }]
    projected.environmentVariables = [{ id: 'new-env', name: 'KEY', type: 'secret' }]
    expect(candidate(projected, ctx).subAgents![0]!.number).toBe('agent-1')
    expect(() => candidate({ ...projected, environmentVariables: [{ ...projected.environmentVariables[0]!, value: 'secret' }] } as PlanningProjection, ctx)).toThrow()
    expect(() => candidate({ ...projected, environmentVariables: [{ ...projected.environmentVariables[0]!, revision: 1 }] } as PlanningProjection, ctx)).toThrow()
    projected.subAgents[0]!.id = 'forged'
    expect(() => candidate(projected, ctx)).toThrow('UNALLOCATED_SUBAGENT_ID')
  })
  it('materializes nested bodies with the same identities and node contract', () => {
    const ctx = context(), projected = projectWorkflow(ctx.workflow)
    projected.nodes[1] = { id: 'write', kind: 'loop', title: '循环', config: { maxIterations: 2, body: { nodes: [{ id: 'inner-start', kind: 'input', title: '入口', config: { fields: [] } }, { id: 'inner-end', kind: 'output', title: '出口', config: { text: '结束' } }], edges: [{ source: 'inner-start', target: 'inner-end' }] } } }
    projected.nodes[2]!.config.text = '完成'
    const next = candidate(projected, ctx)
    expect(next.nodes[1]!.config.body!.nodes[0]!.number).toContain(':')
    expect(codes(next, ctx)).toEqual([])
    expect(projectWorkflow(next).nodes[1]!.config.body!.nodes[0]).not.toHaveProperty('x')
  })
  it('allocates collision-free numbers to inserted nodes without renumbering the saved canvas', () => {
    const ctx = context(); ctx.workflow.nodes = [ctx.workflow.nodes[0]!, ctx.workflow.nodes[2]!]
    ctx.workflow.nodes[0]!.number = 'a-1'; ctx.workflow.nodes[1]!.number = 'a-2'; ctx.workflow.nodes[1]!.config.text = '{{input.text}}'
    ctx.workflow.edges = [{ id: 'saved-edge', source: 'start', target: 'end' }]
    const before = structuredClone(ctx.workflow), projected = projectWorkflow(ctx.workflow)
    projected.nodes.push({ id: 'new-node', kind: 'template', title: '整理', config: { text: '{{input.text}}' } })
    projected.nodes[1]!.config.text = '{{new-node.text}}'
    projected.edges = [{ source: 'start', target: 'new-node' }, { source: 'new-node', target: 'end' }]
    const next = candidate(projected, ctx)
    expect(codes(next, ctx)).toEqual([])
    expect(next.nodes.map(item => [item.id, item.number])).toEqual([['start', 'a-1'], ['end', 'a-2'], ['new-node', 'a-3']])
    expect(next.nodes.slice(0, 2).map(({ number, x, y }) => ({ number, x, y }))).toEqual(before.nodes.map(({ number, x, y }) => ({ number, x, y })))
    expect(ctx.workflow).toEqual(before)
    const reordered = candidate({ ...projected, nodes: [...projected.nodes].reverse(), edges: [...projected.edges].reverse() }, ctx)
    expect(Object.fromEntries(reordered.nodes.map(item => [item.id, item.number]))).toEqual(Object.fromEntries(next.nodes.map(item => [item.id, item.number])))
  })
  it('preserves saved nested numbers and prefixes new descendants with the saved container number', () => {
    const ctx = context(); ctx.workflow.nodes[0]!.number = 'a-1'; ctx.workflow.nodes[2]!.number = 'a-8'; ctx.workflow.nodes[2]!.config.text = '完成'
    ctx.workflow.nodes[1] = { ...node('write', 'loop', { maxIterations: 2, body: { nodes: [
      { ...node('child-start', 'input', { fields: [] }), number: 'a-7:a-1' },
      { ...node('child-end', 'output', { text: '完成', outputName: 'result' }), number: 'a-7:a-2' },
    ], edges: [{ id: 'saved-inner-edge', source: 'child-start', target: 'child-end' }] } }), number: 'a-7' }
    const before = structuredClone(ctx.workflow), projected = projectWorkflow(ctx.workflow), body = projected.nodes[1]!.config.body!
    body.nodes.push({ id: 'new-node', kind: 'template', title: '内部处理', config: { text: '完成' } })
    body.edges = [{ source: 'child-start', target: 'new-node' }, { source: 'new-node', target: 'child-end' }]
    const next = candidate(projected, ctx)
    expect(codes(next, ctx)).toEqual([])
    expect(next.nodes[1]!.number).toBe('a-7')
    expect(next.nodes[1]!.config.body!.nodes.map(item => item.number)).toEqual(['a-7:a-1', 'a-7:a-2', 'a-7:a-3'])
    expect(next.nodes[1]!.config.body!.nodes.slice(0, 2)).toEqual(before.nodes[1]!.config.body!.nodes)
  })
  it('propagates a new container collision correction to all new nested prefixes', () => {
    const ctx = context(); ctx.workflow.nodes = [ctx.workflow.nodes[0]!, ctx.workflow.nodes[2]!]
    ctx.workflow.nodes[0]!.number = 'a-1'; ctx.workflow.nodes[1]!.number = 'a-2'; ctx.workflow.nodes[1]!.config.text = '完成'
    ctx.workflow.edges = [{ id: 'saved-edge', source: 'start', target: 'end' }]
    const projected = projectWorkflow(ctx.workflow)
    projected.nodes.push({ id: 'new-node', kind: 'loop', title: '循环', config: { maxIterations: 2, body: { nodes: [
      { id: 'inner-start', kind: 'input', title: '子入口', config: { fields: [] } },
      { id: 'inner-end', kind: 'output', title: '子出口', config: { text: '完成' } },
    ], edges: [{ source: 'inner-start', target: 'inner-end' }] } } })
    projected.edges = [{ source: 'start', target: 'new-node' }, { source: 'new-node', target: 'end' }]
    const next = candidate(projected, ctx), container = next.nodes.find(item => item.id === 'new-node')!
    expect(codes(next, ctx)).toEqual([])
    expect(container.number).toBe('a-3')
    expect(container.config.body!.nodes.map(item => item.number)).toEqual(['a-3:a-1', 'a-3:a-2'])
  })
  it('rejects prototype keys and full Workflow/package payloads', () => {
    const ctx = context()
    expect(() => materializePlanningCandidate(JSON.stringify(ctx.workflow), ctx)).toThrow()
    expect(() => materializePlanningCandidate('{"constructor":{}}', ctx)).toThrow('不安全')
    expect(() => materializePlanningCandidate(exportWorkflowJson(ctx.workflow), ctx)).toThrow()
  })
})

describe('candidate graph and scope validation', () => {
  it.each(['{{#start.text#}}', '{{invented-node.text}}', '{{vars.unknown}}'])('rejects unusable required references %s before publication', reference => {
    const ctx = context(), projected = projectWorkflow(ctx.workflow)
    projected.nodes[1]!.config = { text: '收到 {{value}}', inputs: { value: reference } }
    expect(codes(candidate(projected, ctx), ctx)).toContain('INVALID_REFERENCE')
  })
  it('rejects hash-wrapped references in template expressions and output text', () => {
    const ctx = context(), projected = projectWorkflow(ctx.workflow)
    projected.nodes[1]!.config.text = '{{#start.text#}}'
    projected.nodes[2]!.config.text = '{{#write.text#}}'
    const issues = planningCandidateIssues(candidate(projected, ctx), ctx)
    expect(issues.filter(issue => issue.code === 'INVALID_REFERENCE').map(issue => issue.nodeId)).toEqual(['write', 'end'])
    expect(issues.some(issue => issue.message.includes('{{节点ID.字段}}'))).toBe(true)
  })
  it.each(['{{optional | default("默认")}}', '{% if optional is defined %}{{optional}}{% else %}默认{% endif %}', '{% if input.text | default(optional) %}有值{% endif %}', '{% if not optional is defined %}默认{% else %}{{optional.text}}{% endif %}'])('preserves optional template values in %s', text => {
    const ctx = context(), projected = projectWorkflow(ctx.workflow)
    projected.nodes[1]!.config.text = text
    expect(codes(candidate(projected, ctx), ctx)).toEqual([])
  })
  it.each(['{% if true %}{{invented-node.text}}{% endif %}', '{% if optional is defined %}有值{% else %}{{optional.text}}{% endif %}', '{% if optional is defined %}{{unrelated.text}}{% endif %}'])('does not exempt unguarded missing references in %s', text => {
    const ctx = context(), projected = projectWorkflow(ctx.workflow)
    projected.nodes[1]!.config.text = text
    expect(codes(candidate(projected, ctx), ctx)).toContain('INVALID_REFERENCE')
  })
  it('protects fixed nodes and their incident edges', () => {
    const ctx = context(); ctx.workflow.nodes[1]!.fixed = true
    const projected = projectWorkflow(ctx.workflow); projected.nodes[1]!.config.text = '改写'
    expect(codes(candidate(projected, ctx), ctx)).toContain('FIXED_NODE_CHANGED')
  })
  it('does not turn a no-op fixed container into a false positive', () => {
    const ctx = context(); ctx.workflow.nodes[1] = { ...node('write', 'loop', { maxIterations: 2, body: { nodes: [node('inner-start', 'input', { fields: [] }), node('inner-end', 'output', { text: '完成' })], edges: [{ id: 'inner-edge', source: 'inner-start', target: 'inner-end' }] } }), fixed: true };ctx.workflow.nodes[2]!.config.text = '完成'
    expect(codes(candidate(projectWorkflow(ctx.workflow), ctx), ctx)).toEqual([])
  })
  it('checks identity pools and local bindings even if a caller skips materialization', () => {
    const ctx = context(), next = structuredClone(ctx.workflow)
    next.subAgents = [{ id: 'forged-agent', number: 'agent-1', name: '伪造', prompt: '', sessionId: 'forged-session' }]
    next.environmentVariables = [{ id: 'forged-env', name: 'BAD', type: 'string', value: 'x', revision: 3 }]
    expect(codes(next, ctx)).toEqual(expect.arrayContaining(['UNALLOCATED_SUBAGENT_ID', 'UNALLOCATED_ENVIRONMENT_ID', 'HOST_METADATA_CHANGED']))
  })
  it('rejects moving an unrelated node into the requested container', () => {
    const ctx = context(); ctx.targetNodeIds = ['write']
    ctx.workflow.nodes[1] = node('write', 'loop', { maxIterations: 2, body: { nodes: [node('inner-start', 'input', { fields: [] }), node('inner-end', 'output', { text: '完成' })], edges: [{ id: 'inner-edge', source: 'inner-start', target: 'inner-end' }] } });ctx.workflow.nodes[2]!.config.text = '完成'
    const projected = projectWorkflow(ctx.workflow), moved = projected.nodes.pop()!
    projected.nodes[1]!.config.body!.nodes.push(moved)
    projected.nodes[1]!.config.body!.edges.push({ source: 'inner-end', target: 'end' })
    projected.edges.pop()
    expect(codes(candidate(projected, ctx), ctx)).toContain('TARGET_SCOPE_VIOLATION')
  })
  it('requires an explicit target for deletion and preserves annotations on allowed deletion', () => {
    const ctx = context(); ctx.workflow.editor = { annotations: [{ id: 'a1', number: 1, nodeIds: ['write'], text: '保留说明' }] }
    const projected = projectWorkflow(ctx.workflow); projected.nodes.splice(1, 1); projected.nodes[1]!.config.text = '完成'; projected.edges = [{ source: 'start', target: 'end' }]
    expect(codes(candidate(projected, ctx), ctx)).toContain('TARGET_SCOPE_VIOLATION')
    ctx.targetNodeIds = ['write', 'end']
    const next = candidate(projected, ctx)
    expect(codes(next, ctx)).not.toContain('TARGET_SCOPE_VIOLATION')
    expect(next.editor!.annotations![0]).toMatchObject({ text: '保留说明', nodeIds: [] })
  })
  it('rejects changes outside an explicitly requested node scope', () => {
    const ctx = context(); ctx.targetNodeIds = ['write']
    const projected = projectWorkflow(ctx.workflow); projected.nodes[2]!.config.text = '范围外修改'
    expect(codes(candidate(projected, ctx), ctx)).toContain('TARGET_SCOPE_VIOLATION')
  })
  it.each(['{{env.rate}}', "{{env['rate']}}", '{{env["rate"]}}'])('protects shared environment values referenced as %s', reference => {
    const ctx = context(); ctx.targetNodeIds = ['end']
    ctx.workflow.environmentVariables = [{ id: 'rate', name: 'RATE', type: 'string', value: 'before' }]
    ctx.workflow.nodes[1]!.config.text = reference
    const projected = projectWorkflow(ctx.workflow)
    expect(codes(candidate(projected, ctx), ctx)).toEqual([])
    projected.environmentVariables![0]!.value = 'after'
    expect(codes(candidate(projected, ctx), ctx)).toContain('TARGET_SCOPE_VIOLATION')
    ctx.workflow.nodes[1]!.fixed = true
    expect(codes(candidate(projected, ctx), ctx)).toContain('FIXED_NODE_CHANGED')
  })
  it('rejects cycles, unreachable nodes, bad ports and cross-branch references', () => {
    const ctx = context(), projected = projectWorkflow(ctx.workflow)
    projected.edges = [{ source: 'start', target: 'write' }, { source: 'write', target: 'end', port: 'invented' }, { source: 'end', target: 'write' }]
    expect(codes(candidate(projected, ctx), ctx)).toContain('INVALID_GRAPH')
    projected.edges = [{ source: 'start', target: 'write' }]
    expect(codes(candidate(projected, ctx), ctx)).toContain('UNREACHABLE_NODE')
    projected.edges = [{ source: 'start', target: 'write' }, { source: 'start', target: 'end' }]
    expect(codes(candidate(projected, ctx), ctx)).toContain('REFERENCE_OUT_OF_SCOPE')
  })
})

describe('grounded tool contracts and same-source node catalog', () => {
  function toolContext(): PlanningContext {
    const ctx = context()
    ctx.workflow.nodes[1] = node('write', 'tool', { toolId: 'native:lookup', inputs: { count: 2, mode: 'short' } })
    ctx.tools = [{ id: 'native:lookup', name: '查询', description: '', providerId: 'native', providerName: '宿主', category: 'plugin', available: true,
      inputSchema: { type: 'object', properties: { count: { type: 'integer' }, mode: { type: 'string', enum: ['short', 'long'] } }, required: ['count', 'mode'], additionalProperties: false } }]
    return ctx
  }
  it('validates required keys, primitive types, enums and additional fields without executing tools', () => {
    const ctx = toolContext(), projected = projectWorkflow(ctx.workflow)
    expect(codes(candidate(projected, ctx), ctx)).toEqual([])
    for (const inputs of [{ mode: 'short' }, { count: '2', mode: 'short' }, { count: 2, mode: 'invalid' }, { count: 2, mode: 'short', extra: true }]) {
      projected.nodes[1]!.config.inputs = inputs
      expect(codes(candidate(projected, ctx), ctx)).toContain('INVALID_TOOL_ARGUMENTS')
    }
  })
  it('distinguishes unavailable real tools from hallucinated tools', () => {
    const ctx = toolContext(); ctx.tools[0]!.available = false
    const projected = projectWorkflow(ctx.workflow)
    expect(codes(candidate(projected, ctx), ctx)).not.toContain('UNKNOWN_TOOL_ID')
    ctx.tools = []
    expect(codes(candidate(projected, ctx), ctx)).not.toContain('UNKNOWN_TOOL_ID')
    projected.nodes[1]!.config.toolId = 'invented:tool'
    expect(codes(candidate(projected, ctx), ctx)).toContain('UNKNOWN_TOOL_ID')
  })
  it('checks the static fields alongside dynamic inputs and rejects known type mismatches', () => {
    const ctx = toolContext(), projected = projectWorkflow(ctx.workflow)
    projected.nodes[1]!.config.inputs = { count: '{{input.text}}', mode: 'short' }
    expect(codes(candidate(projected, ctx), ctx)).toContain('INVALID_TOOL_ARGUMENTS')
    projected.nodes[1]!.config.inputs = { count: 2, mode: '{{input.text}}' }
    expect(codes(candidate(projected, ctx), ctx)).not.toContain('INVALID_TOOL_ARGUMENTS')
  })
  it('checks known dynamic types against every oneOf branch before deferring runtime values', () => {
    const ctx = toolContext(), projected = projectWorkflow(ctx.workflow)
    ctx.tools[0]!.inputSchema = { type: 'object', properties: { arg: { oneOf: [{ type: 'number' }, { type: 'boolean' }] } }, required: ['arg'], additionalProperties: false }
    projected.nodes[1]!.config.inputs = { arg: '{{input.text}}' }
    expect(codes(candidate(projected, ctx), ctx)).toContain('INVALID_TOOL_ARGUMENTS')
    ctx.tools[0]!.inputSchema = { type: 'object', properties: { arg: { oneOf: [{ type: 'number' }, { type: 'string', enum: ['short', 'long'] }] } }, required: ['arg'], additionalProperties: false }
    expect(codes(candidate(projected, ctx), ctx)).not.toContain('INVALID_TOOL_ARGUMENTS')
  })
  it('refuses unsupported tool schema constraints instead of silently ignoring them', () => {
    const ctx = toolContext(); ctx.tools[0]!.inputSchema.minimum = 2
    expect(codes(candidate(projectWorkflow(ctx.workflow), ctx), ctx)).toContain('TOOL_SCHEMA_UNSUPPORTED')
  })
  it('describes every existing node kind from its actual validator, including strict Agent roles', () => {
    const catalog = nodeCapabilityCatalog()
    expect(catalog.map(item => item.kind)).toEqual(Object.keys(NODE_LABELS))
    const agent = catalog.find(item => item.kind === 'agent')!.schema
    expect((agent.properties as Record<string, unknown>).subagentId).toBeDefined()
    expect((agent.properties as Record<string, unknown>).rolePresetId).toBeUndefined()
    expect(catalog.find(item => item.kind === 'http')!.schema.anyOf).toHaveLength(2)
    const loop = catalog.find(item => item.kind === 'loop')!.schema as { properties: { body: { properties: { nodes: { items: { required: string[]; properties: Record<string, unknown> } } } } } }
    expect(loop.properties.body.properties.nodes.items.required).toEqual(['id', 'kind', 'title', 'config'])
    expect(loop.properties.body.properties.nodes.items.properties).not.toHaveProperty('x')
  })
})
