import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { z } from 'zod'
import { validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { nodeCapabilityCatalog } from '../src/shared/node-capabilities.ts'
import { NODE_SEMANTICS, queryWorkflowSemantics, WORKFLOW_SEMANTIC_TOPICS } from '../src/shared/workflow-semantics.ts'
import { workflowNodeConfigSchema, parseWorkflow, graphIssues } from '../src/shared/workflow-validation.ts'
import { makeWorkflow, NODE_LABELS, type JsonValue, type NodeKind, type WorkflowNode } from '../src/shared/types.ts'
import { materializePlanningCandidate } from '../src/shared/planning-projection.ts'
import { runJavaScript } from '../src/host/execution-adapters.ts'
import { BUILTIN_TOOLS, executeBuiltin } from '../src/host/tool-catalog.ts'
import { executeHtml, isHtmlTool } from '../src/host/html-tools.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { statWorkspaceFile } from '../src/host/file-stat.ts'
import { renderDataTemplate } from '../src/host/template.ts'
import { AuthoringCore, normalizeAuthoring } from '../src/shared/planning-authoring-core.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'

async function statExample(path: string, content: string) {
  const root = mkdtempSync(join(tmpdir(), 'semantics-file-'))
  try { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); return await statWorkspaceFile(root, path, new AbortController().signal) }
  finally { rmSync(root, { recursive: true, force: true }) }
}
// Use the exact snapshot function called by DSH's tool-output boundary, rather
// than JSON.stringify (which silently ignores Zod's hidden protocol metadata).
const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools'))
const { snapshotJsonValue } = await import(sdkRequire.resolve('@deepseek-ai/dsh-util-values'))

function propertyNames(schema: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(schema.properties ?? {}), ...(['anyOf', 'oneOf', 'allOf'] as const).flatMap(key => ((schema[key] ?? []) as Record<string, unknown>[]).flatMap(propertyNames))])]
}
// Materialize only the Host-owned layout fields, as the production projection adapter does.
function savedConfig(value: Record<string, unknown>): Record<string, unknown> {
  if (!value.body) return value
  const body = value.body as {nodes: {config: Record<string, unknown>}[]; edges: Record<string, unknown>[]}
  return { ...value, body: { nodes: body.nodes.map((node, index) => ({ ...node, number: `a-${index + 1}`, x: 0, y: 0, fixed: false, config: savedConfig(node.config) })), edges: body.edges.map((edge, index) => ({ ...edge, id: `edge-${index}` })) } }
}

describe('Agent workflow semantic dictionary', () => {
  it('defaults to compact discovery, never the full JSON schema catalog', () => {
    const result = queryWorkflowSemantics()
    expect(result.nodeIndex?.map(item => item.kind)).toEqual(Object.keys(NODE_LABELS))
    expect(result.topicIndex).toEqual(WORKFLOW_SEMANTIC_TOPICS)
    expect(result.nodes).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('"schema"')
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(15_000)
  })
  it('selects topics and nodes explicitly and rejects invalid/unbounded queries', () => {
    const result = queryWorkflowSemantics({ kinds: ['template', 'output', 'template'], topics: ['references'] })
    expect(result.nodes?.map(item => item.kind)).toEqual(['template', 'output'])
    expect(Object.keys(result.topics)).toEqual(['references'])
    expect(result.nodes?.every(item => !('schema' in item))).toBe(true)
    for (const query of [{ kinds: ['http_request'] }, { topics: ['legacy'] }, { kinds: Object.keys(NODE_LABELS) }, { all: true }, null]) expect(() => queryWorkflowSemantics(query)).toThrow()
  })
  it('removes Zod-only metadata and passes the actual SDK lossless tool-result boundary', () => {
    const raw = z.toJSONSchema(workflowNodeConfigSchema('input'), { io: 'input', unrepresentable: 'any' })
    expect(Object.hasOwn(raw, '~standard')).toBe(true)
    expect(snapshotJsonValue(raw)).toBeUndefined()
    for (const kind of Object.keys(NODE_LABELS) as NodeKind[]) {
      const result = queryWorkflowSemantics({ kinds: [kind], includeSchema: true, topics: ['references'] })
      expect(Reflect.ownKeys(result.nodes![0]!.schema!)).not.toContain('~standard')
      expect(snapshotJsonValue(result)).toEqual(JSON.parse(JSON.stringify(result)))
    }
    // Reproduce both failing calls captured in the actual preview conversation.
    for (const query of [
      { kinds: ['input', 'tool', 'http', 'llm'], includeSchema: true },
      { kinds: ['template', 'output'], topics: ['references', 'edges'], includeSchema: true },
    ]) expect(snapshotJsonValue(queryWorkflowSemantics(query))).toBeDefined()
  })
  it.each(Object.keys(NODE_LABELS) as NodeKind[])('%s documents every accepted config key and provides an example matching the current schema', kind => {
    const entry = queryWorkflowSemantics({ kinds: [kind], includeSchema: true }).nodes![0]!
    const current = nodeCapabilityCatalog([kind],{authoring:true})[0]!.schema
    expect(entry.schema).toEqual(current)
    expect(Object.keys(entry.fields).sort()).toEqual(propertyNames(current).sort())
    expect(validateJsonSchemaValue(current as JsonSchemaNode, entry.example)).toEqual([])
    expect(workflowNodeConfigSchema(kind).safeParse(savedConfig(entry.example)).success).toBe(true)
    expect(entry.purpose.length).toBeGreaterThan(10)
    expect(Object.keys(entry.outputs).length).toBeGreaterThan(0)
  })
  it('does not expose mutable singleton metadata or live user values', () => {
    const first = queryWorkflowSemantics({ kinds: ['input'], topics: ['environment'] })
    first.nodes![0]!.example.fields = ['mutated']
    first.nodes![0]!.rules.push('mutated')
    expect(queryWorkflowSemantics({ kinds: ['input'] }).nodes![0]!.example).toEqual(NODE_SEMANTICS.input.example)
    expect(queryWorkflowSemantics({ kinds: ['input'] }).nodes![0]!.rules).not.toContain('mutated')
    expect(JSON.stringify(first.topics)).not.toContain('ciphertext')
  })
  it('greeting examples materialize into one valid current graph without the old hash reference bug', () => {
    const base = makeWorkflow('workspace'), now = base.createdAt
    const projection = {
      title: '语义词典示例', description: '测试数据',
      nodes: [
        { id: 'start', kind: 'input', title: '输入', config: NODE_SEMANTICS.input.example },
        { id: 'format', kind: 'template', title: '模板', config: NODE_SEMANTICS.template.example },
        { id: 'end', kind: 'output', title: '输出', config: NODE_SEMANTICS.output.example },
      ], edges: [{ source: 'start', target: 'format' }, { source: 'format', target: 'end' }],
    }
    const candidate = materializePlanningCandidate(JSON.stringify(projection), { workflow: base, operation: 'create', targetNodeIds: [], nodeIds: ['start', 'format', 'end'], subagentIds: [], environmentIds: [], tools: [], model: { provider: 'fixture', model: 'fixture' } })
    expect(graphIssues(parseWorkflow(candidate), true)).toEqual([])
    expect(candidate.nodes[2]!.config.outputName).toBe('report')
    expect(candidate.nodes[2]!.config.text).toBe('{{format.text}}')
    expect(candidate.createdAt).toBe(now)
  })
  it('code example really returns its declared field without an extra output wrapper', async () => {
    const config = NODE_SEMANTICS.code.example as WorkflowNode['config']
    expect(await runJavaScript(config.code!, { text: '  hello  ' }, new AbortController().signal, config.timeoutMs)).toEqual({ result: 'hello' })
  })
  it('tool lookup supplies all current builtin contracts without adding node config fields', () => {
    const entry = queryWorkflowSemantics({ kinds: ['tool'], includeSchema: true }).nodes![0]!
    expect(entry.builtinTools?.map(tool => tool.toolId)).toEqual(BUILTIN_TOOLS.map(tool => tool.id))
    expect(entry.fields).not.toHaveProperty('builtinTools')
    expect(entry.builtinTools?.find(tool => tool.toolId === 'builtin:time.now')?.outputs).toHaveProperty('iso')
  })
  it.each(BUILTIN_TOOLS)('$id documented example runs with exactly its declared output fields', async choice => {
    const tool = queryWorkflowSemantics({ kinds: ['tool'] }).nodes![0]!.builtinTools!.find(tool => tool.toolId === choice.id)!
    expect(Object.keys(tool.inputs).sort()).toEqual(Object.keys(choice.inputSchema.properties ?? {}).sort())
    expect(workflowNodeConfigSchema('tool').safeParse({ toolId: tool.toolId, inputs: tool.example.inputs }).success).toBe(true)
    try {
      if (tool.example.clock) { vi.useFakeTimers(); vi.setSystemTime(new Date(tool.example.clock)) }
      const output = tool.example.file !== undefined ? await statExample(String(tool.example.inputs.path), tool.example.file) : isHtmlTool(tool.toolId) ? await executeHtml(tool.toolId, tool.example.inputs) : executeBuiltin(tool.toolId, tool.example.inputs)
      expect(output).toEqual(tool.example.expected)
      expect(Object.keys(output).sort()).toEqual(Object.keys(tool.outputs).sort())
    } finally { vi.useRealTimers() }
  })
  it.each(NODE_SEMANTICS.template.syntax!.examples)('template grammar example really renders: $title', example => {
    const entry = queryWorkflowSemantics({ kinds: ['template'], includeSchema: true }).nodes![0]!
    expect(entry.syntax!.examples).toContainEqual(example)
    expect(entry.fields).not.toHaveProperty('syntax')
    expect(workflowNodeConfigSchema('template').safeParse(example.config).success).toBe(true)
    const rendered = renderDataTemplate(example.config.text, name => {
      let value: JsonValue = {input:example.input}
      for (const key of name.split('.')) {
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error(`测试输入缺少 ${name}`)
        value = (value as Record<string, JsonValue>)[key]!
      }
      return value
    })
    expect(rendered).toEqual(example.expected)
  })
  it('container examples teach CREATE declarations and compile with valid internal output boundaries', () => {
    for (const kind of ['loop', 'iteration'] as const) {
      const example = NODE_SEMANTICS[kind].createExample!
      const flow=new AuthoringCore(templateContext()).compile(normalizeAuthoring(example)).candidate!
      const container=flow.nodes.find(node=>node.kind===kind)!,body=container.config.body!
      expect(NODE_SEMANTICS[kind].example).not.toHaveProperty('body')
      expect(body.nodes.filter(node => node.kind === 'input')).toHaveLength(1)
      expect(body.nodes.some(node => `${node.id}.text` === container.config.outputVariable)).toBe(true)
    }
  })
  it('teaches the review module and a canonical CREATE fragment without runtime bodies or explicit scopes',()=>{
    const result=queryWorkflowSemantics({kinds:['human','loop','iteration'],topics:['containers'],includeSchema:true})
    const review=result.nodes!.find(node=>node.kind==='human')!.reviewBeforeEffect!
    expect(review).not.toHaveProperty('recipe');expect(review.module).toContain('reviewed-file-write@1.0.0')
    expect(JSON.stringify(result)).not.toContain('config.body')
    const scan=(value:unknown):void=>{if(!value||typeof value!=='object')return;expect(value).not.toHaveProperty('body');for(const entry of Object.values(value))scan(entry)}
    scan(result)
    expect(new AuthoringCore(templateContext()).compile(normalizeAuthoring(review.createExample)).issues).toEqual([])
    for(const node of review.createExample.nodes)expect(node).not.toHaveProperty('scope')
  })
})
