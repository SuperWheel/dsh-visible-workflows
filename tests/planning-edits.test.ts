import { describe, expect, it } from 'vitest'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { compileOptimizationEdits, compilePlanningEdits, optimizationEditsSchema, parseOptimizationEdits, parsePlanningEdits, planningEditDigest, planningEditsSchema, planningEditView } from '../src/shared/planning-edits.ts'
import { optimizationReplacementIssues } from '../src/host/planning/optimization.ts'
import type { PlanningContext } from '../src/shared/planning-types.ts'
import type { NodeKind, Workflow, WorkflowNode } from '../src/shared/types.ts'

const node = (id: string, kind: NodeKind, config: WorkflowNode['config']): WorkflowNode => ({ id, kind, config, title: id, number: id, x: 50, y: 25, fixed: false })
function context(): PlanningContext {
  const workflow: Workflow = {
    id: 'flow', workspaceId: 'workspace', title: '流程', description: '保留的业务说明', revision: 4, createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T01:00:00.000Z',
    nodes: [node('start', 'input', { fields: [{ name: 'text', label: '文本', required: true, type: 'text' }] }), node('write', 'template', { text: '{{input.text}}', inputs: { greeting: '你好' } }), node('end', 'output', { text: '{{write.text}}', outputName: 'result' })],
    edges: [{ id: 'e1', source: 'start', target: 'write' }, { id: 'e2', source: 'write', target: 'end' }], notes: [],
    executionPolicy: { tokenBudget: 10000 }, budgetDecision: { mode: 'limited', decidedAt: '2026-10-17T00:00:00.000Z' },
  }
  return { workflow, operation: 'revise', targetNodeIds: [], nodeIds: ['new-node', 'inner-start', 'inner-end'], subagentIds: ['new-agent'], environmentIds: ['new-env'], model: { provider: 'test', model: 'model' }, tools: [] }
}
const envelope = (ctx: PlanningContext, edits: unknown[] = []) => ({ protocolVersion: 1, baseDigest: planningEditDigest(ctx.workflow), outcome: 'candidate', edits })

describe('bounded internal edit transport', () => {
  it('uses official DSH-compatible wire schemas and strict per-operation validation', () => {
    assertObjectJsonSchema(planningEditsSchema)
    assertObjectJsonSchema(optimizationEditsSchema)
    const ctx = context(), wire = envelope(ctx, [{ op: 'update-node', node: '@2', configSet: { text: '完成' } }])
    expect(validateJsonSchemaValue(planningEditsSchema, wire)).toEqual([])
    expect(parsePlanningEdits(wire).questions).toEqual([])
    expect(() => parsePlanningEdits({ ...wire, graphJson: '{}' })).toThrow()
    expect(() => parsePlanningEdits(envelope(ctx, [{ op: 'update-node', node: '@2', id: 'forged', configSet: {} }]))).toThrow()
    expect(() => parsePlanningEdits(envelope(ctx, [{ op: 'update-node', node: '@2', configSet: { body: { nodes: [], edges: [] } } }]))).toThrow('body')
  })
  it('advertises exact per-operation required and allowed fields instead of a permissive flat union', () => {
    const ctx = context()
    for (const edit of [
      { op: 'add-node', key: 'format', kind: 'template', title: '格式化', config: { text: '{{input.text}}' } },
      { op: 'update-node', node: '@2', configSet: { text: '{{input.text}}' } },
      { op: 'connect', source: '@1', target: '@3' },
    ]) expect(validateJsonSchemaValue(planningEditsSchema, envelope(ctx, [edit]))).toEqual([])
    for (const edit of [
      { op: 'add-node', key: 'format', kind: 'template', title: '格式化', config: {}, configSet: { text: 'cannot discard' } },
      { op: 'add-node', key: 'format', kind: 'template', title: '格式化' },
      { op: 'update-node', node: '@2', config: { text: 'cannot discard' }, key: 'format' },
      { op: 'set-workflow', configSet: { description: 'cannot discard' } },
      { op: 'update-node', node: '@1', config: { fields: [{ name: 'text', label: '文本', required: true }] }, key: 'noop' },
      { op: 'connect', source: '@1', target: '@3', config: {}, key: 'edge' },
    ]) {
      expect(validateJsonSchemaValue(planningEditsSchema, envelope(ctx, [edit]))).not.toEqual([])
      expect(() => parsePlanningEdits(envelope(ctx, [edit]))).toThrow()
    }
  })
  it('defaults nonblocking empty output while refusing fabricated questions and coverage', () => {
    const ctx = context()
    const result = compilePlanningEdits({ ...envelope(ctx), summary: '  ' }, ctx)
    expect(result.output.summary).toBeTruthy()
    expect(result.output.requirementCoverage).toEqual([])
    expect(() => compilePlanningEdits({ ...envelope(ctx), outcome: 'needs-input' }, ctx)).toThrow()
    expect(() => compilePlanningEdits({ ...envelope(ctx), outcome: 'needs-input', questions: [{ id: 'q', question: ' ' }] }, ctx)).toThrow()
    const clarification = compilePlanningEdits({ ...envelope(ctx), outcome: 'needs-input', questions: [{ id: 'q', question: '输出文件格式是什么？' }] }, ctx)
    expect(clarification.candidate).toBeUndefined()
    expect(clarification.output).toMatchObject({ graphJson: '', questions: [{ id: 'q', options: [] }] })
    expect(() => compilePlanningEdits({ ...envelope(ctx), requirementCoverage: [{ requirementId: 'R1', nodeIds: ['@404'] }] }, ctx)).toThrow('EDIT_UNKNOWN_REFERENCE')
  })
  it('defaults only omitted protocol version without accepting incompatible versions or losing the base lock', () => {
    const ctx = context(), { protocolVersion: _version, ...author } = envelope(ctx, [{ op: 'update-node', node: '@2', configSet: { text: '完成' } }])
    const optimizer = { baseDigest: author.baseDigest, outcome: 'unchanged' }
    expect(validateJsonSchemaValue(planningEditsSchema, author)).toEqual([])
    expect(validateJsonSchemaValue(optimizationEditsSchema, optimizer)).toEqual([])
    expect(parsePlanningEdits(author).protocolVersion).toBe(1)
    expect(parseOptimizationEdits(optimizer).protocolVersion).toBe(1)
    expect(compilePlanningEdits(author, ctx)).toEqual(compilePlanningEdits({ ...author, protocolVersion: 1 }, ctx))
    expect(compileOptimizationEdits(optimizer, ctx)).toEqual(compileOptimizationEdits({ ...optimizer, protocolVersion: 1 }, ctx))
    for (const version of [0, 2, '1', null]) {
      expect(() => parsePlanningEdits({ ...author, protocolVersion: version })).toThrow()
      expect(() => parseOptimizationEdits({ ...optimizer, protocolVersion: version })).toThrow()
    }
    expect(() => compilePlanningEdits({ ...author, baseDigest: '0'.repeat(64) }, ctx)).toThrow('EDIT_BASE_CONFLICT')
    expect(() => compileOptimizationEdits({ ...optimizer, baseDigest: '0'.repeat(64) }, ctx)).toThrow('EDIT_BASE_CONFLICT')
    const { baseDigest: _digest, ...unlocked } = author
    expect(() => compilePlanningEdits(unlocked, ctx)).toThrow()
  })
  it('rejects dangerous keys before assignment and bounds depth, size and operations', () => {
    const ctx = context(), wire = JSON.stringify(envelope(ctx, [{ op: 'update-node', node: '@2', configSet: { text: 'ok' } }]))
    expect(() => parsePlanningEdits(wire.replace('"text":"ok"', '"__proto__":{"polluted":true}'))).toThrow('EDIT_UNSAFE_KEY')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    let nested: unknown = 'x'; for (let i = 0; i < 35; i++) nested = { next: nested }
    expect(() => parsePlanningEdits(envelope(ctx, [{ op: 'update-node', node: '@2', configSet: { inputs: nested } }]))).toThrow('EDIT_DEPTH_LIMIT')
    expect(() => parsePlanningEdits({ ...envelope(ctx), summary: '中'.repeat(400_000) })).toThrow('EDIT_SIZE_LIMIT')
    expect(() => parsePlanningEdits(envelope(ctx, Array.from({ length: 201 }, () => ({ op: 'set-workflow', title: 'x' }))))).toThrow()
  })
})

describe('Host-owned identity and exact reference assembly', () => {
  it('preserves all untouched fields, host authority and edge identities on a local edit', () => {
    const ctx = context(), before = structuredClone(ctx.workflow)
    ctx.workflow.subAgents = [{ id: 'agent', number: 'agent-7', name: '角色', prompt: '原提示词', sessionId: 'local-session', rolePresetId: 'role', rolePresetRevision: 3 }]
    ctx.workflow.environmentVariables = [{ id: 'secret', name: 'KEY', type: 'secret', revision: 2 }]
    const result = compilePlanningEdits(envelope(ctx, [{ op: 'update-node', node: '@2', configSet: { text: '完成 {{input.text}}' } }]), ctx)
    expect(result.issues).toEqual([])
    expect(result.candidate).toMatchObject({ id: before.id, workspaceId: before.workspaceId, revision: before.revision, description: before.description, executionPolicy: before.executionPolicy, budgetDecision: before.budgetDecision, edges: before.edges, subAgents: ctx.workflow.subAgents, environmentVariables: ctx.workflow.environmentVariables })
    expect(result.candidate!.nodes[1]).toEqual({ ...before.nodes[1], config: { ...before.nodes[1]!.config, text: '完成 {{input.text}}' } })
    expect(ctx.workflow.nodes).toEqual(before.nodes)
    const view = planningEditView(ctx)
    expect(view.nodes[2]!.config.text).toBe('{{@2.text}}')
    expect(JSON.stringify(view)).not.toContain('local-session')
    expect(view.subAgents[0]).not.toHaveProperty('rolePresetId')
  })
  it('allocates stable IDs from pools and maps forward references and coverage exactly', () => {
    const ctx = context(), wire = { ...envelope(ctx, [
      { op: 'update-node', node: '@3', configSet: { text: '{{+format.text}}' } },
      { op: 'disconnect', source: '@2', target: '@3' },
      { op: 'add-node', key: 'format', kind: 'template', title: '整理', config: { text: '普通 @2 与 +format 保留；{{@2.text}}' } },
      { op: 'connect', source: '@2', target: '+format' }, { op: 'connect', source: '+format', target: '@3' },
    ]), requirementCoverage: [{ requirementId: 'R1', nodeIds: ['@1', '+format', '@3'], note: '记录对应节点' }] }
    const a = compilePlanningEdits(wire, ctx), b = compilePlanningEdits(wire, ctx)
    expect(a).toEqual(b)
    expect(a.issues).toEqual([])
    expect(a.candidate!.nodes[3]).toMatchObject({ id: 'new-node', config: { text: '普通 @2 与 +format 保留；{{write.text}}' } })
    expect(a.candidate!.nodes[2]!.config.text).toBe('{{new-node.text}}')
    expect(a.output.requirementCoverage[0]!.nodeIds).toEqual(['start', 'new-node', 'end'])
  })
  it('rejects unknown aliases, duplicate declarations, conflicting patches and cross-scope edges without mutating baseline', () => {
    const ctx = context(), before = structuredClone(ctx)
    expect(() => compilePlanningEdits(envelope(ctx, [{ op: 'update-node', node: '@2', configSet: { text: '{{@20.text}}' } }]), ctx)).toThrow('EDIT_UNKNOWN_REFERENCE')
    expect(() => compilePlanningEdits(envelope(ctx, [{ op: 'update-node', node: '@2', configSet: { text: '{{@02.text}}' } }]), ctx)).toThrow('EDIT_INVALID_REFERENCE')
    const add = { op: 'add-node', key: 'work', kind: 'template', title: '工作', config: { text: 'x' } }
    expect(() => compilePlanningEdits(envelope(ctx, [add, add]), ctx)).toThrow('EDIT_DUPLICATE_KEY')
    expect(() => compilePlanningEdits(envelope(ctx, [{ op: 'update-node', node: '@2', configSet: { text: 'x' }, configUnset: ['text'] }]), ctx)).toThrow('EDIT_CONFLICTING_CONFIG')
    expect(() => compilePlanningEdits(envelope(ctx, [{ op: 'connect', source: '@1', target: '+missing' }]), ctx)).toThrow('EDIT_UNKNOWN_REFERENCE')
    expect(ctx).toEqual(before)
  })
  it('binds aliases to current draft digest, allowing view navigation but not semantic or layout drift', () => {
    const ctx = context(), wire = envelope(ctx, [{ op: 'update-node', node: '@2', title: '新名称' }])
    const viewOnly = structuredClone(ctx.workflow); viewOnly.editor = { viewport: { x: 20, y: 10, scale: 0.5 }, scopePath: [] }
    expect(planningEditDigest(viewOnly)).toBe(wire.baseDigest)
    const changed = structuredClone(ctx.workflow); changed.nodes[0]!.x++
    expect(() => compilePlanningEdits(wire, ctx, changed)).toThrow('EDIT_BASE_CONFLICT')
    const result = compilePlanningEdits(wire, ctx)
    expect(() => compilePlanningEdits(wire, ctx, result.candidate)).toThrow('EDIT_BASE_CONFLICT')
    const next = { ...wire, baseDigest: planningEditDigest(result.candidate!), edits: [{ op: 'update-node', node: '@2', configSet: { text: '修复完成' } }] }
    expect(compilePlanningEdits(next, ctx, result.candidate).candidate!.nodes[1]!.title).toBe('新名称')
  })
  it('translates bracket env references and all template operands while preserving quoted literals and local loop names', () => {
    const ctx = context(); ctx.workflow.environmentVariables = [{ id: 'prefix', name: 'PREFIX', type: 'string', value: 'hello' }]
    ctx.workflow.nodes[1]!.config = { text: `{{env['prefix']}} {{input.text}}` }
    expect(planningEditView(ctx).nodes[1]!.config.text).toBe('{{env.@e1}} {{input.text}}')
    const text = `{% if @1.text == env['@e1'] or @1.text is defined %}{{ @1.text | default(env["@e1"]) }} {{"@1.text"}}{% endif %}`
    const result = compilePlanningEdits(envelope(ctx, [{ op: 'update-node', node: '@2', configSet: { text } }]), ctx)
    expect(result.candidate!.nodes[1]!.config.text).toBe(`{% if start.text == env.prefix or start.text is defined %}{{ start.text | default(env.prefix) }} {{"@1.text"}}{% endif %}`)
    ctx.workflow.nodes[1]!.config = { text: '{% for start in input.items %}{{start.text}}{% endfor %}{{start.text}}' }
    expect(planningEditView(ctx).nodes[1]!.config.text).toBe('{% for start in input.items %}{{start.text}}{% endfor %}{{@1.text}}')
    ctx.workflow.nodes[1]!.config = { inputs: { start: 'local' }, text: '{{start}} {{input.text}}' }
    expect(planningEditView(ctx).nodes[1]!.config.text).toBe('{{start}} {{input.text}}')
  })
  it('does not treat arbitrary business field names as structural selectors or identities', () => {
    const ctx = context(), inputs = { variable: '@1', subagentId: 'literal', secretVariableId: '@e1', code: 'plain @2', nested: { variable: '{{@1.text}}' } }
    const result = compilePlanningEdits(envelope(ctx, [{ op: 'update-node', node: '@2', configSet: { inputs } }]), ctx)
    expect(result.candidate!.nodes[1]!.config.inputs).toEqual({ ...inputs, nested: { variable: '{{start.text}}' } })
    expect(ctx.workflow.nodes[1]!.config.inputs).toEqual({ greeting: '你好' })
  })
})

describe('scope and protected declaration boundaries', () => {
  it('assembles nested operations while preserving an existing body during parent config edits', () => {
    const ctx = context()
    const first = compilePlanningEdits(envelope(ctx, [
      { op: 'update-node', node: '@2', kind: 'loop', configUnset: ['text', 'inputs'], configSet: { maxIterations: 2 } },
      { op: 'update-node', node: '@3', configSet: { text: '完成' } },
      { op: 'add-node', key: 'start', scope: ['@2'], kind: 'input', title: '子入口', config: { fields: [] } },
      { op: 'add-node', key: 'end', scope: ['@2'], kind: 'output', title: '子出口', config: { text: '完成' } },
      { op: 'connect', source: '+start', target: '+end', scope: ['@2'] },
    ]), ctx)
    expect(first.issues).toEqual([])
    const body = structuredClone(first.candidate!.nodes[1]!.config.body)
    const next = compilePlanningEdits({ ...envelope(ctx, [{ op: 'update-node', node: '@2', configSet: { maxIterations: 3 } }]), baseDigest: planningEditDigest(first.candidate!) }, ctx, first.candidate)
    expect(next.candidate!.nodes[1]!.config.body).toEqual(body)
    expect(planningEditView(ctx, first.candidate).nodes.find(item => item.title === '子入口')!.scope).toEqual(['@2'])
    expect(() => compilePlanningEdits({ ...envelope(ctx, [{ op: 'connect', source: '@1', target: '@3' }]), baseDigest: planningEditDigest(first.candidate!) }, ctx, first.candidate)).toThrow('EDIT_EDGE_SCOPE_MISMATCH')
  })
  it('keeps original target and fixed protections on repaired drafts', () => {
    const ctx = context(); ctx.targetNodeIds = ['write']
    expect(compilePlanningEdits(envelope(ctx, [{ op: 'update-node', node: '@3', title: '越界' }]), ctx).issues.some(issue => issue.code === 'TARGET_SCOPE_VIOLATION')).toBe(true)
    ctx.targetNodeIds = []; ctx.workflow.nodes[1]!.fixed = true
    expect(compilePlanningEdits(envelope(ctx, [{ op: 'update-node', node: '@2', configSet: { text: '越界' } }]), ctx).issues.some(issue => issue.code === 'FIXED_NODE_CHANGED')).toBe(true)
    ctx.workflow.nodes[1]!.fixed = false
    const removed = compilePlanningEdits(envelope(ctx, [{ op: 'remove-node', node: '@2' }, { op: 'connect', source: '@1', target: '@3' }, { op: 'update-node', node: '@3', configSet: { text: '完成' } }]), ctx)
    expect(removed.issues.some(issue => issue.code === 'TARGET_SCOPE_VIOLATION')).toBe(true)
  })
  it('supports declarations with stable aliases and rejects Secret value, type, revision and local binding writes', () => {
    const ctx = context()
    const result = compilePlanningEdits(envelope(ctx, [
      { op: 'add-subagent', key: 'worker', name: '处理员', prompt: '处理输入' },
      { op: 'add-environment', key: 'label', name: 'PREFIX', type: 'string', value: '结果' },
      { op: 'update-node', node: '@2', kind: 'agent', configUnset: ['text'], configSet: { subagentId: '+a:worker', prompt: '{{env.+e:label}} {{input.text}}' } },
    ]), ctx)
    expect(result.issues).toEqual([])
    expect(result.candidate!.nodes[1]!.config).toMatchObject({ subagentId: 'new-agent', prompt: '{{env.new-env}} {{input.text}}' })
    expect(() => compilePlanningEdits(envelope(ctx, [{ op: 'add-environment', key: 'key', name: 'KEY', type: 'secret', value: 'hidden' }]), ctx)).toThrow('EDIT_SECRET_VALUE_FORBIDDEN')
    ctx.workflow.environmentVariables = [{ id: 'secret', name: 'KEY', type: 'secret', revision: 4 }]
    expect(() => compilePlanningEdits(envelope(ctx, [{ op: 'update-environment', variable: '@e1', value: 'hidden' }]), ctx)).toThrow('EDIT_SECRET_VALUE_FORBIDDEN')
    for (const extra of [{ type: 'string' }, { revision: 99 }, { ciphertext: 'hidden' }]) expect(() => compilePlanningEdits(envelope(ctx, [{ op: 'update-environment', variable: '@e1', ...extra }]), ctx)).toThrow()
    expect(() => compilePlanningEdits(envelope(ctx, [{ op: 'add-subagent', key: 'worker', name: '角色', prompt: '提示', sessionId: 'forged' }]), ctx)).toThrow()
  })
})

describe('optimizer can only replace explicitly named node implementations', () => {
  function optimizationFixture() {
    const ctx = context(); ctx.workflow.nodes[1]!.kind = 'llm'; ctx.workflow.nodes[1]!.config = { prompt: '{{input.text}}' }
    const wire = { protocolVersion: 1, baseDigest: planningEditDigest(ctx.workflow), outcome: 'candidate', replacements: [{ node: '@2', kind: 'template', config: { text: '{{input.text}}' }, reason: '记录样本表明只需要原样返回文本', evidenceCases: [{ id: 'case1', workflowInputs: { evidenceId: 'e1', pointer: '/input' }, expected: { evidenceId: 'e1', pointer: '/output' } }] }] }
    return { ctx, wire }
  }
  it('leaves metadata, title, topology and other nodes byte-equivalent and maps evidence refs without inventing data', () => {
    const { ctx, wire } = optimizationFixture(), result = compileOptimizationEdits(wire, ctx)
    expect(result.issues).toEqual([])
    expect(optimizationReplacementIssues(ctx.workflow, result.candidate!, result.output.replacements)).toEqual([])
    expect(result.candidate).toEqual({ ...ctx.workflow, nodes: [ctx.workflow.nodes[0], { ...ctx.workflow.nodes[1]!, kind: 'template', config: { text: '{{input.text}}' } }, ctx.workflow.nodes[2]] })
    expect(result.output.regressionCases).toEqual([{ ...wire.replacements[0]!.evidenceCases[0], nodeId: 'write' }])
    expect(() => compileOptimizationEdits({ ...wire, description: '越权改写' }, ctx)).toThrow()
    expect(() => compileOptimizationEdits({ ...wire, replacements: [{ ...wire.replacements[0], title: '改名' }] }, ctx)).toThrow()
    expect(() => compileOptimizationEdits({ ...wire, edits: [{ op: 'remove-node', node: '@1' }] }, ctx)).toThrow()
  })
  it('does not execute source strings or fabricate evidence; old output and unknown refs are rejected', () => {
    const { ctx, wire } = optimizationFixture()
    const source = 'throw new Error("never execute @2 or {{@2.text}}")'
    const result = compileOptimizationEdits({ ...wire, replacements: [{ ...wire.replacements[0], kind: 'code', config: { language: 'javascript', code: source }, evidenceCases: [] }] }, ctx)
    expect(result.candidate!.nodes[1]!.config.code).toBe(source)
    expect(result.output.regressionCases).toEqual([])
    expect(() => compileOptimizationEdits({ ...wire, graphJson: '{}' }, ctx)).toThrow()
    expect(() => compileOptimizationEdits({ ...wire, replacements: [{ ...wire.replacements[0], node: '@20' }] }, ctx)).toThrow('EDIT_UNKNOWN_REFERENCE')
    expect(() => compileOptimizationEdits({ ...wire, replacements: [...wire.replacements, ...wire.replacements] }, ctx)).toThrow('EDIT_OPTIMIZATION_SCOPE')
    expect(() => compileOptimizationEdits({ ...wire, replacements: [{ ...wire.replacements[0], config: { body: {} } }] }, ctx)).toThrow('body')
  })
})
