import { describe, expect, it } from 'vitest'
import { planningCandidateIssues, planningNodeOutputType } from '../src/shared/planning-projection.ts'
import { compilePlanningChain, planningChainDigest } from '../src/shared/planning-chain.ts'
import { buildPlanningToolOutputs } from '../src/shared/planning-tool-outputs.ts'
import type { PlanningContext } from '../src/shared/planning-types.ts'
import type { InputField, NodeConfig, WorkflowNode } from '../src/shared/types.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'

const node = (id: string, kind: WorkflowNode['kind'], config: NodeConfig): WorkflowNode => ({ id, kind, config, title: id, number: id, x: 0, y: 0, fixed: false })
const field = (name: string, type: InputField['type']): InputField => ({ name, type, label: name, required: true })
const schema = (name: string, type: NonNullable<NodeConfig['outputSchema']>[number]['type']) => [{ name, type, required: true }]
function toolContext(producer: WorkflowNode, expression: string, type: string): PlanningContext {
  const context = templateContext()
  context.operation = 'revise'; context.workflow.revision = 1
  const start = producer.kind === 'input' ? producer : context.workflow.nodes[0]!
  const consume = node('consume', 'tool', { toolId: 'api:echo', inputs: { value: expression } })
  context.workflow.nodes = producer.kind === 'input' ? [start, consume] : [start, producer, consume]
  context.workflow.edges = context.workflow.nodes.slice(1).map((item, index) => ({ id: 'edge-' + index, source: context.workflow.nodes[index]!.id, target: item.id }))
  context.tools = [{ id: 'api:echo', name: 'Echo', description: '', available: true, providerId: 'test', providerName: 'Test', category: 'swagger',
    inputSchema: { type: 'object', properties: { value: { type } }, required: ['value'], additionalProperties: false } }]
  return context
}
const argumentIssues = (context: PlanningContext) => {
  const issues = planningCandidateIssues(context.workflow, context)
  expect(issues.filter(issue => issue.code === 'INVALID_WORKFLOW')).toEqual([])
  return issues.filter(issue => issue.code === 'INVALID_TOOL_ARGUMENTS')
}

describe('shared output type audit regressions', () => {
  it('WRAPPER_TYPE: keeps llm.text a string despite a numeric business field named text', () => {
    const context = toolContext(node('gen', 'llm', { prompt: 'Return JSON', model: { provider: 'offline', model: 'test' }, outputSchema: schema('text', 'number') }), '{{gen.text}}', 'string')
    expect(planningCandidateIssues(context.workflow, context)).toEqual([])
    context.tools[0]!.inputSchema.properties = { value: { type: 'number' } }
    expect(argumentIssues(context)).toEqual([expect.objectContaining({ code: 'INVALID_TOOL_ARGUMENTS', message: expect.stringContaining('引用类型 string 与工具要求 number 不符') })])
  })

  it.each(['{{host-start.text}}', '{{input.text}}'])('INPUT_TEXT_TYPE: preserves a numeric input text field through %s', expression => {
    const context = toolContext(node('host-start', 'input', { fields: [field('text', 'number')] }), expression, 'number')
    expect(planningCandidateIssues(context.workflow, context)).toEqual([])
    // runtime.resolve clones a whole-token reference; it does not stringify it.
    context.tools[0]!.inputSchema.properties = { value: { type: 'string' } }
    expect(argumentIssues(context)).toEqual([expect.objectContaining({ code: 'INVALID_TOOL_ARGUMENTS', message: expect.stringContaining('引用类型 number 与工具要求 string 不符') })])
  })

  it('ATTACHMENT_SHAPE: names the document node when an upload reaches a path argument or a missing attachment field', () => {
    const context = toolContext(node('host-start', 'input', { fields: [field('attachment', 'file')] }), '{{input.attachment}}', 'string')
    expect(argumentIssues(context)).toEqual([expect.objectContaining({ message: expect.stringMatching(/引用类型 object 与工具要求 string 不符：input\.attachment 是运行时上传的附件对象.*document 节点/) })])
    context.workflow.nodes[1]!.config.inputs = { value: '{{input.attachment.path}}' }
    expect(planningCandidateIssues(context.workflow, context)).toEqual([expect.objectContaining({ code: 'INVALID_ATTACHMENT_REFERENCE', nodeId: 'consume', message: expect.stringContaining('input.attachment.path 不存在') })])
    context.workflow.nodes[1]!.config.inputs = { value: '{{input.attachment.name}}' }
    expect(planningCandidateIssues(context.workflow, context)).toEqual([])
  })

  it('still treats interpolation inside surrounding text as a string', () => {
    const context = toolContext(node('host-start', 'input', { fields: [field('text', 'number')] }), 'Number: {{host-start.text}}', 'string')
    expect(argumentIssues(context)).toEqual([])
    context.tools[0]!.inputSchema.properties = { value: { type: 'number' } }
    expect(argumentIssues(context)).toHaveLength(1)
  })

  it.each([
    ['input', 'text', { fields: [field('text', 'number')] }, 'number'],
    ['input', 'json', { fields: [field('json', 'boolean')] }, 'boolean'],
    ['input', 'steps', { fields: [field('steps', 'text')] }, 'string'],
    ['input', 'text', { fields: [] }, 'string'],
    ['input', 'attachment', { fields: [field('attachment', 'file')] }, 'object'],
    ['input', 'attachments', { fields: [field('attachments', 'files')] }, 'array'],
    ['human', 'count', { prompt: 'Reply', fields: [field('count', 'number')] }, 'number'],
    ['human', 'text', { prompt: 'Reply', fields: [field('text', 'number')] }, 'string'],
    ['human', '__action_id', { prompt: 'Reply', fields: [] }, 'string'],
    ['llm', 'json', { outputSchema: schema('json', 'number') }, 'object'],
    ['llm', 'count', { outputSchema: schema('count', 'number') }, 'number'],
    ['agent', 'text', { outputSchema: schema('text', 'number') }, 'string'],
    ['agent', 'json', { outputSchema: schema('json', 'number') }, 'object'],
    ['agent', 'steps', { outputSchema: schema('steps', 'string') }, 'number'],
    ['agent', 'count', { outputSchema: schema('count', 'number') }, 'number'],
    ['extractor', 'text', { parameters: schema('text', 'number') }, 'string'],
    ['extractor', '__is_success', { parameters: [] }, 'number'],
    ['extractor', '__reason', { parameters: [] }, 'string'],
    ['extractor', 'json', { parameters: schema('json', 'number') }, 'object'],
    ['extractor', 'count', { parameters: schema('count', 'number') }, 'number'],
    ['code', 'text', { code: 'function main() { return { text: 1 }; }', outputSchema: schema('text', 'number') }, 'number'],
    ['code', 'json', { outputSchema: schema('json', 'boolean') }, 'boolean'],
    ['code', 'steps', { outputSchema: schema('steps', 'string') }, 'string'],
    ['template', 'text', { text: 'Text' }, 'string'],
    ['output', 'text', { text: 'Text' }, 'string'],
  ] satisfies [WorkflowNode['kind'], string, NodeConfig, string][])('uses runtime %s.%s type', (kind, name, config, expected) => {
    const producer = node('producer', kind, config)
    expect(planningNodeOutputType(producer, name)).toBe(expected)
    const context = toolContext(producer, `{{producer.${name}}}`, expected)
    expect(argumentIssues(context)).toEqual([])
    context.tools[0]!.inputSchema.properties = { value: { type: expected === 'string' ? 'number' : 'string' } }
    expect(argumentIssues(context)).toHaveLength(1)
  })

  it.each([
    ['code', 'text', {}], ['code', 'json', {}], ['code', 'steps', {}],
    ['llm', 'json', {}], ['template', 'steps', {}], ['output', 'json', {}],
    ['input', 'payload', { fields: [field('payload', 'json')] }],
    ['input', 'text', { fields: [{ ...field('text', 'number'), required: false }] }],
    ['extractor', 'invented', { parameters: [] }],
    ['tool', 'text', { toolId: 'api:unknown' }],
    ['agent', 'repair_attempts', {}],
  ] satisfies [WorkflowNode['kind'], string, NodeConfig][])('defers unknown %s.%s types without inventing a mismatch', (kind, name, config) => {
    const producer = node('producer', kind, config)
    expect(planningNodeOutputType(producer, name)).toBeUndefined()
    expect(argumentIssues(toolContext(producer, `{{producer.${name}}}`, 'boolean'))).toEqual([])
  })

  it('uses only adapter contracts and Host schemas for tool return types', () => {
    const native = node('native', 'tool', { toolId: 'native:lookup' })
    expect(planningNodeOutputType(native, 'text')).toBe('string')
    expect(planningNodeOutputType(native, 'value')).toBeUndefined()
    const context = toolContext(native, '{{native.value}}', 'string')
    context.tools.push({ ...context.tools[0]!, id: 'native:lookup', inputSchema: { type: 'object', properties: {} } })
    context.toolOutputs = buildPlanningToolOutputs(context.tools, { schemas: [{ toolId: 'native:lookup', sourceId: 'native-tool:lookup', version: 'v1', valuePath: 'value', schema: { type: 'number' } }] })
    expect(argumentIssues(context)).toHaveLength(1)
    expect(planningNodeOutputType(node('builtin', 'tool', { toolId: 'builtin:time.weekday' }), 'timestamp')).toBeUndefined()
    expect(planningNodeOutputType(node('workflow', 'tool', { toolId: 'workflow:child' }), 'outputs')).toBe('object')
  })

  it.each(['human', 'extractor', 'code'] as const)('uses the same numeric %s business field type for chain exports', kind => {
    const context = templateContext()
    context.operation = 'revise'; context.workflow.revision = 1
    const config: NodeConfig = kind === 'human' ? { prompt: 'Reply', fields: [field('count', 'number')], actions: [{ id: 'ok', label: 'OK' }] }
      : kind === 'extractor' ? { prompt: 'Extract', model: context.model, parameters: schema('count', 'number') }
      : { code: 'function main() { return { count: 1 }; }', outputSchema: schema('count', 'number') }
    context.workflow.nodes.splice(1, 0, node('producer', kind, config))
    context.workflow.nodes[2]!.config.text = '{{producer.count}}'
    context.workflow.edges = [{ id: 'entry', source: 'host-start', target: 'producer' }, { id: 'exit', source: 'producer', target: 'host-end' }]
    context.targetNodeIds = ['producer', 'host-end']
    const request = { version: 1, baseDigest: planningChainDigest(context.workflow), baseRevision: 1, chainKey: 'a', anchorNodeId: 'producer',
      operations: [{ op: 'replace', draftRevision: 0, target: 'a-2', nodes: [{ key: 'replacement', template: 'code', values: { code: 'function main() { return { count: 1 }; }', outputSchema: schema('count', 'number') } }] }],
      exports: [{ from: { nodeId: 'producer', field: 'count' }, to: { key: 'replacement', field: 'count' } }] }
    const result = compilePlanningChain(request, context)
    expect(result.issues).toEqual([])
    const replacement = result.candidate!.nodes.find(item => item.kind === 'code')!
    expect(result.candidate!.nodes.find(item => item.id === 'host-end')!.config.text).toBe(`{{${replacement.id}.count}}`)
    request.operations[0]!.nodes[0]!.values.outputSchema = schema('count', 'string')
    expect(() => compilePlanningChain(request, context)).toThrow('类型不一致')
  })
})
