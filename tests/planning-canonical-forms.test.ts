import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freezePair, runPairArm, type PairConfig } from '../scripts/benchmarks/template-fill-paired.ts'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { queryPlanningTemplates } from '../src/host/planning/template-catalog.ts'
import { CANONICAL_INPUT_GUIDANCE, CANONICAL_TEMPLATE_GUIDANCE, CANONICAL_EXIT_GUIDANCE, TEMPLATE_RENDER_BOUNDARY_GUIDANCE } from '../src/shared/workflow-semantics.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'
import { WorkflowRuntime, type AdapterRequest } from '../src/host/runtime.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { runJavaScript } from '../src/host/execution-adapters.ts'
import { makeWorkflow, type Workflow, type WorkflowNode, type JsonValue } from '../src/shared/types.ts'

const config = JSON.parse(readFileSync(new URL('../scripts/benchmarks/t09-config.json', import.meta.url), 'utf8')) as PairConfig
const resources: { path: string; runtime: WorkflowRuntime; storage: WorkflowStorage }[] = []
afterEach(async () => { for (const { path, runtime, storage } of resources.splice(0)) { await runtime.close(); storage.close(); rmSync(path, { recursive: true, force: true }) } })
function node(id: string, kind: WorkflowNode['kind'], config: WorkflowNode['config']): WorkflowNode {
  return { id, kind, config, title: id, number: id, x: 0, y: 0, fixed: false }
}
function setup() {
  const path = mkdtempSync(join(tmpdir(), 'dsh-canonical-')), storage = new WorkflowStorage(path)
  const calls: { kind: string; inputs: Record<string, JsonValue> }[] = [], prompts: string[] = []
  const runtime = new WorkflowRuntime(storage, { async generate(request) { prompts.push(request.prompt); return request.prompt } }, {
    async execute(kind, request: AdapterRequest) {
      calls.push({ kind, inputs: request.inputs })
      if (kind === 'code') return runJavaScript(request.node.config.code!, request.inputs, request.signal)
      return { text: JSON.stringify(request.inputs) }
    },
  })
  resources.push({ path, runtime, storage }); return { storage, runtime, calls, prompts }
}
async function execute(flow: Workflow, inputs: Record<string, string>) {
  const env = setup(), saved = env.storage.save(flow, 0), run = await env.runtime.settle(env.runtime.start(saved.id, inputs).id)
  expect(run.status, JSON.stringify(run.executions)).toBe('success')
  return { ...env, run }
}
function compile(arm: string, submission: any, context = templateContext()) {
  const compiler = arm === 'compact-repair' ? new WorkflowAuthoringCompiler(context) : new TemplateFillingCompiler(context)
  const value = structuredClone(submission)
  if (arm === 'template-fill') {
    if (value.nodes) { value.forms = value.nodes.map(({ kind, config, ...row }: any) => ({ ...row, template: kind, values: config })); delete value.nodes }
    if (value.updates) for (const update of Object.values(value.updates) as any[]) { update.values = update.set; delete update.set }
  }
  const result = compiler.submit({ submission: value })
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok) throw Error('Compilation failed')
  return result.value.candidate!
}

describe('T21.1 canonical planner teaching', () => {
  it.each(config.cases)('assembles canonical first requests for both arms: $id', async item => {
    const frozen = freezePair({ ...config, repeats: 1, cases: [item] })
    for (const slot of frozen.schedule) {
      let body: any
      await runPairArm(frozen, slot, { async request(request) { body = request; return { error: 'OFFLINE_CAPTURE_ONLY' } } }, async () => { throw Error('No oracle in capture') })
      const system = body.messages[0].content, prompt = JSON.parse(body.messages[1].content), teaching = JSON.stringify(body)
      expect(body.messages.map((m: any) => m.content).join('\n').split(TEMPLATE_RENDER_BOUNDARY_GUIDANCE)).toHaveLength(2)
      expect(prompt.rules).toContain(TEMPLATE_RENDER_BOUNDARY_GUIDANCE)
      for (const conflict of ['所有字段支持过滤器', 'output.text 支持过滤器', 'prompt 支持 for', 'tool.inputs 支持过滤器']) expect(teaching).not.toContain(conflict)
      for (const rule of [CANONICAL_INPUT_GUIDANCE, CANONICAL_TEMPLATE_GUIDANCE, CANONICAL_EXIT_GUIDANCE]) {
        expect(system).toContain(rule); expect(prompt.rules).toContain(rule)
      }
      for (const conflict of ['默认出口用 result', '默认输出 key=result', '新建 start/result 绑定', '创建 key=start/result', '{{start.name}}', '{{start.score}}', '或直接写 {{input.name}}', '或先通过 config.inputs 映射局部变量', '模板局部变量使用 inputs']) expect(teaching).not.toContain(conflict)
      const schema = JSON.stringify(body.tools[0].function.parameters)
      expect(schema).toContain('多个分支输出节点各取不同 key')
      const semantics = prompt.runtimeSemantics ?? prompt.semantics
      const semantic = semantics.nodes.find((n: any) => n.kind === 'template')
      expect(semantic?.example).toEqual({ text: '你好，{{input.name}}！' })
      for (const example of semantic.syntax.examples) { expect(example.config).not.toHaveProperty('inputs'); expect(example.input).toBeDefined() }
      if (slot.arm === 'template-fill') {
        expect(prompt.templateAccess).toContain('正文直接引用上游路径')
        const template = prompt.templateCatalog.prefetched.entries.find((t: any) => t.id === 'template')
        expect(template.rules).toContain(CANONICAL_TEMPLATE_GUIDANCE)
        expect(template.descriptions.inputs).toContain('无需填写')
      }
    }
  })
  it('teaches the same rules in full catalog recovery and repair feedback', () => {
    const compiler = new TemplateFillingCompiler(templateContext())
    const query = queryPlanningTemplates(compiler, ['input', 'template', 'output'])
    expect(query.entries.find(t => t.id === 'template')!.rules).toContain(CANONICAL_TEMPLATE_GUIDANCE)
    expect(JSON.stringify(query)).not.toContain('{{start.name}}')
    const bad = { mode: 'create', title: 'bare name', nodes: [
      { key: 'start', kind: 'input', config: { fields: [{ name: 'name', label: 'Name', required: true }] } },
      { key: 'result', kind: 'template', config: { text: '{{name}}' } },
    ], chains: [{ key: 'main', nodes: ['start', 'result'] }], coverage: { R1: ['result'] } }
    const result = new WorkflowAuthoringCompiler(templateContext()).submit({ submission: bad })
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).toContain('input.name')
    expect(JSON.stringify(result)).not.toContain('或先通过 config.inputs')
  })
})

describe.each(['compact-repair', 'template-fill'])('%s accepts existing and canonical forms', arm => {
  it('compiles external pipes and leaves an untouched executable legacy output literal alone during EDIT', async () => {
    const flow = compile(arm, { mode: 'create', title: 'literal pipes', nodes: [
      { key: 'start', kind: 'input', config: { fields: [{ name: 'text', label: 'Text', required: true }] } },
      { key: 'format', kind: 'template', config: { text: '{{input.text}}' } },
      { key: 'result', kind: 'output', config: { text: '| A | B | {{format.text}}', outputName: 'result' } },
    ], chains: [{ key: 'main', nodes: ['start', 'format', 'result'] }], coverage: { R1: ['result'] } })
    expect((await execute(flow, { text: 'ok' })).run.outputs).toEqual({ result: '| A | B | ok' })
    // Old graphs can intentionally display template-looking statements literally.
    flow.nodes.find(n => n.kind === 'output')!.config.text = '| A | B | {% if literal %}'
    const context = templateContext(); context.workflow = flow; context.operation = 'revise'
    const index = flow.nodes.findIndex(n => n.kind === 'template'); context.targetNodeIds = [flow.nodes[index]!.id]
    const edited = compile(arm, { mode: 'edit', updates: { ['n' + (index + 1)]: { set: { text: 'changed' } } }, coverage: { R1: ['n' + (index + 1)] } }, context)
    expect((await execute({ ...edited, revision: 0 }, { text: 'ok' })).run.outputs).toEqual({ result: '| A | B | {% if literal %}' })
  })
  it.each(['input', 'start'])('compiles and runs %s references, direct typed template loops and legacy aliases', async root => {
    const flow = compile(arm, { mode: 'create', title: 'references', nodes: [
      { key: 'start', kind: 'input', config: { fields: [{ name: 'text', label: 'Text', required: true }, { name: 'items', label: 'Items', type: 'json', required: true }] } },
      { key: 'direct', kind: 'template', config: { text: `{{${root}.text}}:{% for row in ${root}.items %}{{row | upper}}{% endfor %}:{{${root}.items | length}}` } },
      { key: 'legacy', kind: 'template', config: { inputs: { text: `{{${root}.text}}` }, text: '{{text}}' } },
      { key: 'result', kind: 'output', config: { text: '{{direct.text}}/{{legacy.text}}', outputName: 'result' } },
    ], chains: [{ key: 'main', nodes: ['start', 'direct', 'legacy', 'result'] }], coverage: { R1: ['result'] } })
    expect((await execute(flow, { text: 'ok', items: '["a","b"]' })).run.outputs).toEqual({ result: 'ok:AB:2/ok' })
    const ctx = templateContext(); ctx.workflow = flow; ctx.operation = 'revise'
    const index = flow.nodes.findIndex(n => n.kind === 'template'); ctx.targetNodeIds = [flow.nodes[index]!.id]
    const edited = compile(arm, { mode: 'edit', updates: { ['n' + (index + 1)]: { set: { text: '{{n1.text}}' } } }, coverage: { R1: ['n' + (index + 1)] } }, ctx)
    expect((await execute({ ...edited, revision: 0 }, { text: 'edited', items: '[]' })).run.outputs).toEqual({ result: 'edited/edited' })
  })
  it.each([[], ['result'], ['other'], ['passed', 'failed'], ['result', 'failed']].map(keys => ({ keys })))('accepts output keys $keys without repair and removes omitted scaffold', async ({ keys }) => {
    const branching = keys.length > 1
    const flow = compile(arm, { mode: 'create', title: 'exits', nodes: [
      { key: 'start', kind: 'input', config: { fields: [{ name: 'score', label: 'Score', required: true, type: 'number' }] } },
      ...(branching ? [{ key: 'check', kind: 'if', config: { variable: keys.includes('result') ? 'start.score' : 'input.score', operator: 'gte', value: '60' } }] : []),
      ...keys.map(key => ({ key, kind: 'output', config: { text: key, outputName: 'result' } })),
    ], chains: branching ? [{ key: 'main', nodes: ['start', 'check'] }] : keys.length ? [{ key: 'main', nodes: ['start', keys[0]] }] : [],
    ...(branching ? { links: keys.map((key, i) => ({ key: 'route' + i, source: 'check', target: key, port: i ? 'false' : 'true' })) } : {}), coverage: { R1: ['start', ...keys] } })
    expect(flow.nodes.some(n => n.id === 'host-end')).toBe(keys.includes('result'))
    for (const score of ['70', '30']) expect((await execute(flow, { score })).run.outputs).toEqual(keys.length ? { result: keys[branching && score === '30' ? 1 : 0] } : {})
  })
})

it.each(['input', 'entry'])('resolves %s across every runtime reference consumer and nested containers', async root => {
  const flow = makeWorkflow('workspace', 'reference consumers')
  const ref = (field: string) => `{{${root}.${field}}}`
  const body = (prefix: string) => ({ nodes: [node(prefix + 'Input', 'input', { fields: [] }), node(prefix + 'Text', 'template', { text: ref('text') })], edges: [{ id: prefix + 'Edge', source: prefix + 'Input', target: prefix + 'Text' }] })
  const inner = body('inner'), outer = body('outer')
  outer.nodes.push(node('nested', 'iteration', { iterator: root + '.items', body: inner, outputVariable: 'innerText.text' }))
  outer.edges.push({ id: 'nestedEdge', source: 'outerText', target: 'nested' })
  flow.nodes = [
    node('entry', 'input', { fields: [{ name: 'text', label: 'Text', required: true }, { name: 'items', label: 'Items', type: 'json', required: true }, { name: 'score', label: 'Score', type: 'number', required: true }] }),
    node('format', 'template', { text: ref('text') }), node('model', 'llm', { prompt: ref('text'), model: { provider: 'offline', model: 'test' } }),
    node('tool', 'tool', { toolId: 'builtin:json.stringify', inputs: { value: ref('items') } }),
    node('http', 'http', { url: 'https://example.invalid/' + ref('text'), method: 'POST', bodyText: ref('text'), headers: { 'x-test': ref('text') } }),
    node('code', 'code', { code: 'function main(inputs){ return {text:inputs.text, items:inputs.items}; }', inputs: { text: ref('text'), items: ref('items') } }),
    node('list', 'list', { listSource: root + '.items', filter: { variable: root + '.score', operator: 'gte', value: '60' } }),
    node('each', 'iteration', { iterator: root + '.items', body: outer, outputVariable: 'nested.result' }),
    node('repeat', 'loop', { body: body('repeat'), initialVariables: { seed: ref('score') }, maxIterations: 3, until: { variable: root + '.score', operator: 'gte', value: '60' }, outputVariable: 'repeatText.text' }),
    node('check', 'if', { variable: root + '.score', operator: 'gte', value: '60' }),
    node('result', 'output', { text: ref('text'), outputName: 'result' }),
  ]
  flow.edges = flow.nodes.slice(1).map((n, i) => ({ id: 'e' + i, source: flow.nodes[i]!.id, target: n.id, ...(flow.nodes[i]!.kind === 'if' ? { port: 'true' } : {}) }))
  const { run, calls, prompts } = await execute(flow, { text: 'ok', items: '[1,2]', score: '70' })
  expect(run.outputs).toEqual({ result: 'ok' }); expect(prompts).toEqual(['ok'])
  expect(calls).toEqual([
    { kind: 'tool', inputs: { value: [1, 2] } },
    { kind: 'http', inputs: { url: 'https://example.invalid/ok', body: 'ok', headers: { 'x-test': 'ok' } } },
    { kind: 'code', inputs: { text: 'ok', items: [1, 2] } },
  ])
  const data = (id: string) => run.executions.find(e => e.nodeId === id)!.data
  expect(data('code')).toEqual({ text: 'ok', items: [1, 2] })
  expect(data('list')!.result).toEqual([1, 2]); expect(data('each')!.result).toEqual([['ok', 'ok'], ['ok', 'ok']])
  expect(data('repeat')).toMatchObject({ result: 'ok', iterations: 1, variables: { seed: 70 } })
})
