import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { cases, contextFor, oracle } from '../scripts/benchmarks/workflow-compiler.ts'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { planningTemplateSyntaxIssues } from '../src/shared/planning-template-syntax.ts'
import { planningCandidateIssues } from '../src/shared/planning-projection.ts'
import { parseWorkflow } from '../src/shared/workflow-validation.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'
import type { NodeConfig, NodeKind, WorkflowNode } from '../src/shared/types.ts'

// Minimal graph submissions from read-only .test-data/t21-paired/shard-3-part-2/events.jsonl,
// call-end container/template-fill repeats 0..4. No journal/model response metadata.
const recordings = JSON.parse(readFileSync(new URL('./fixtures/t21-container-submissions.json', import.meta.url), 'utf8')) as { repeat: number; submission: any }[]
const item = cases.find(c => c.id === 'container')!
const arms = ['compact-repair', 'template-fill'] as const
function compiler(arm: typeof arms[number], context = contextFor(item)) {
  if (arm === 'compact-repair') return new WorkflowAuthoringCompiler(context)
  const result = new TemplateFillingCompiler(context)
  result.queryTemplates(result.catalog().templates.map(t => t.id))
  return result
}
function wire(arm: typeof arms[number], submission: any) {
  const s = structuredClone(submission)
  if (arm === 'compact-repair') {
    s.nodes = s.forms.map(({ template, values, ...rest }: any) => ({ ...rest, kind: template, config: values }))
    delete s.forms
  }
  return { submission: s }
}

describe.each(arms)('%s rejects template syntax before runtime', arm => {
  it.each(recordings.filter(r => [0, 3].includes(r.repeat)))('replays failing repeat $repeat with an exact repair path, then repairs explicitly', async recording => {
    const c = compiler(arm), input = wire(arm, recording.submission), before = structuredClone(input)
    const result = c.submit(input)
    expect(input).toEqual(before)
    expect(result.ok).toBe(false)
    if (result.ok) throw Error('Expected compile issue')
    const path = arm === 'template-fill' ? '/formsByKey/result/values/text' : '/nodesByKey/result/config/text'
    expect(result.feedback.issues).toEqual([expect.objectContaining({ code: 'TEMPLATE_SYNTAX_UNSUPPORTED', path,
      message: 'output.text 不支持过滤器；容器结果用 {{iterate.text}}（已是 JSON 文本），或先接 template 节点做 tojson；此字段只支持普通 {{path}} 插值。' })])
    expect(result.feedback.allowedPaths).toContain(path)
    expect(c.snapshot().document).not.toBeUndefined()
    const patches = recording.repeat === 0 ? [{ op: 'replace', path, value: '{{iterate.text}}' }] : [
      { op: 'add', path: arm === 'template-fill' ? '/formsByKey/formatted' : '/nodesByKey/formatted', value: arm === 'template-fill'
        ? { template: 'template', values: { text: '{{iterate.result | tojson}}' } }
        : { kind: 'template', config: { text: '{{iterate.result | tojson}}' } } },
      { op: 'replace', path: '/chainsByKey/main/nodes', value: ['start', 'iterate', 'formatted', 'result'] },
      { op: 'replace', path, value: '{{formatted.text}}' },
    ]
    const repaired = c.submit({ submission: { mode: 'repair', draftRevision: result.feedback.draftRevision, patches } })
    expect(repaired.ok, JSON.stringify(repaired)).toBe(true)
    if (!repaired.ok) throw Error('Repair failed')
    expect((await oracle(repaired.value.candidate!, item)).passed).toBe(true)
  })
  it.each(recordings.filter(r => [1, 2, 4].includes(r.repeat)))('preserves successful repeat $repeat and its full business oracle', async recording => {
    const result = compiler(arm).submit(wire(arm, recording.submission))
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) throw Error('Compile failed')
    expect((await oracle(result.value.candidate!, item)).passed).toBe(true)
  })
  it('maps an EDIT issue to the precise updated field and permits its repair', () => {
    const context = templateContext(); context.operation = 'revise'; context.targetNodeIds = ['host-end']
    const c = compiler(arm, context)
    const result = c.submit({ submission: { mode: 'edit', updates: { n2: { [arm === 'template-fill' ? 'values' : 'set']: { text: '{{input.items | tojson}}' } } }, coverage: { R1: ['n2'] } } })
    expect(result.ok).toBe(false)
    if (result.ok) throw Error('Expected compile issue')
    const path = '/updates/n2/' + (arm === 'template-fill' ? 'values' : 'set') + '/text'
    expect(result.feedback.issues.find(i => i.code === 'TEMPLATE_SYNTAX_UNSUPPORTED')?.path).toBe(path)
    expect(c.submit({ submission: { mode: 'repair', draftRevision: result.feedback.draftRevision, patches: [{ op: 'replace', path, value: 'A | B' }] } }).ok).toBe(true)
  })
})

function node(kind: NodeKind, config: NodeConfig, id = 'consumer'): WorkflowNode {
  return { id, kind, config, title: id, number: id, x: 0, y: 0, fixed: false }
}
const filtered = '{{input.text | upper}}'
const consumers: { kind: NodeKind; config: NodeConfig; path: string }[] = [
  { kind: 'output', config: { text: filtered }, path: '/config/text' },
  ...(['llm', 'agent', 'classifier', 'extractor'] as const).map(kind => ({ kind, config: { prompt: filtered }, path: '/config/prompt' })),
  ...(['tool', 'http', 'code', 'template'] as const).map(kind => ({ kind, config: { inputs: { value: { nested: [filtered] } } }, path: '/config/inputs/value/nested/0' })),
  { kind: 'tool', config: { inputs: { value: { 'a/b~c.d': filtered } } }, path: '/config/inputs/value/a~1b~0c.d' },
  { kind: 'human', config: { prompt: filtered }, path: '/config/prompt' },
  { kind: 'human', config: { fields: [{ name: 'text', label: 'Text', required: true, defaultValue: filtered }] }, path: '/config/fields/0/defaultValue' },
  { kind: 'knowledge', config: { query: filtered }, path: '/config/query' },
  { kind: 'document', config: { documentMode: 'agent', prompt: filtered }, path: '/config/prompt' },
  { kind: 'document', config: { source: filtered }, path: '/config/source' },
  { kind: 'http', config: { url: filtered }, path: '/config/url' },
  { kind: 'http', config: { headers: { 'x-test': filtered } }, path: '/config/headers/x-test' },
  { kind: 'http', config: { bodyText: filtered }, path: '/config/bodyText' },
  { kind: 'if', config: { variable: 'input.text', value: filtered }, path: '/config/value' },
  { kind: 'if', config: { cases: [{ id: 'yes', conditions: [{ variable: 'input.text', operator: 'equals', value: filtered }] }] }, path: '/config/cases/0/conditions/0/value' },
  { kind: 'if', config: { logicGate: { operator: 'IF', inputs: [{ value: filtered }] } }, path: '/config/logicGate/inputs/0/value' },
  { kind: 'list', config: { listSource: 'input.items', filter: { variable: 'item', operator: 'equals', value: filtered } }, path: '/config/filter/value' },
  { kind: 'iteration', config: { iterator: 'input.items | first' }, path: '/config/iterator' },
  { kind: 'list', config: { listSource: '{{input.items | first}}' }, path: '/config/listSource' },
  { kind: 'loop', config: { initialVariables: { seed: filtered } }, path: '/config/initialVariables/seed' },
  { kind: 'loop', config: { until: { variable: 'vars.ok', operator: 'equals', value: filtered } }, path: '/config/until/value' },
  { kind: 'assigner', config: { assignments: [{ name: 'text', operation: 'set', value: filtered }] }, path: '/config/assignments/0/value' },
  { kind: 'aggregator', config: { groups: [{ name: 'text', variables: ['format.text | upper'] }] }, path: '/config/groups/0/variables/0' },
  { kind: 'loop', config: { outputVariable: 'format.text | upper', body: { nodes: [], edges: [] } }, path: '/config/outputVariable' },
]
describe('shared planning validation follows runtime rendering consumers', () => {
  it.each(consumers)('$kind $path rejects filters with a concrete fix', ({ kind, config, path }) => {
    const context = templateContext(), flow = { ...context.workflow, nodes: [node(kind, config)] }
    expect(planningTemplateSyntaxIssues(flow, context)).toEqual([expect.objectContaining({ code: 'TEMPLATE_SYNTAX_UNSUPPORTED', nodeId: 'consumer', path, message: expect.stringContaining('先接 template') })])
  })
  it.each(['{% for x in input.items %}x{% endfor %}', '{% if input.ok %}yes{% endif %}', '{# hidden #}', '{{input.text + 1}}', '{{input.text is defined}}', '{{"literal"}}'])('rejects template-only syntax %s', text => {
    const context = templateContext()
    expect(planningTemplateSyntaxIssues({ ...context.workflow, nodes: [node('output', { text })] }, context)[0]?.path).toBe('/config/text')
  })
  it('allows plain interpolation, typed inputs, external pipes, rich template text and literal fields', () => {
    const context = templateContext(), literal = filtered + ' {% if x %} {# comment #}'
    const flow = { ...context.workflow, nodes: [
      node('output', { text: '| A | B |\n{{input.text}}', inputs: { value: '{{input.items}}' } }),
      node('template', { text: literal }), node('code', { code: `function main(inputs) { return {text:${JSON.stringify(literal)}} }` }),
      node('input', { fields: [{ name: 'text', label: literal, required: true, defaultValue: literal }] }),
      node('list', { listSource: JSON.stringify([literal]) }),
      node('iteration', { iterator: JSON.stringify([literal]) }),
      node('document', { source: 'literal-{% if x %}.md' }),
    ] }
    expect(planningTemplateSyntaxIssues(flow, context)).toEqual([])
  })
  it('does not gate untouched historical nodes, but checks changed, targeted, added and nested nodes', () => {
    const context = templateContext(); context.operation = 'revise'
    context.workflow.nodes.push(node('output', { text: filtered }))
    context.workflow = parseWorkflow(context.workflow)
    const flow = structuredClone(context.workflow)
    expect(planningTemplateSyntaxIssues(flow, context)).toEqual([])
    // The shared candidate path also leaves this legacy syntax alone.
    expect(planningCandidateIssues(flow, context).filter(i => i.code === 'TEMPLATE_SYNTAX_UNSUPPORTED')).toEqual([])
    flow.nodes.find(n => n.id === 'consumer')!.config.text += '!'
    expect(planningTemplateSyntaxIssues(flow, context)).toHaveLength(1)
    context.targetNodeIds = ['consumer']
    expect(planningTemplateSyntaxIssues(context.workflow, context)).toHaveLength(1)
    context.targetNodeIds = []
    const parent = node('loop', { body: { nodes: [node('output', { text: filtered }, 'child')], edges: [] } }, 'parent')
    expect(planningTemplateSyntaxIssues({ ...flow, nodes: [parent] }, context)[0]?.nodeId).toBe('child')
    context.workflow.nodes.push(structuredClone(parent))
    context.workflow = parseWorkflow(context.workflow)
    expect(planningTemplateSyntaxIssues(context.workflow, context)).toEqual([])
    const changed = structuredClone(context.workflow); changed.nodes.find(n => n.id === 'parent')!.config.maxIterations = 2
    expect(planningTemplateSyntaxIssues(changed, context)[0]?.nodeId).toBe('child')
  })
})
