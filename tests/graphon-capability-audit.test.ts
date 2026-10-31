import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NODE_LABELS, makeWorkflow, type NodeGraph, type WorkflowNode } from '../src/shared/types.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime, type ModelRequest } from '../src/host/runtime.ts'
import { createExecutionAdapters, httpRequest } from '../src/host/execution-adapters.ts'
import { ToolCatalog } from '../src/host/tool-catalog.ts'
import { nativeAgentSdkAuditDouble } from '../scripts/fixtures/native-agent-sdk-audit-double.ts'

const contexts: { directory: string; runtime: WorkflowRuntime }[] = []
const model = { provider: 'audit', model: 'controlled-no-network' }
const node = (id: string, kind: WorkflowNode['kind'], config: WorkflowNode['config'] = {}): WorkflowNode => ({ id, kind, config, title: id, number: id, x: 0, y: 0, fixed: false })
const edge = (source: string, target: string, port?: string) => ({ id: `${source}_${target}`, source, target, ...(port ? { port } : {}) })

afterEach(async () => {
  for (const { directory, runtime } of contexts.splice(0)) { await runtime.close(); rmSync(directory, { recursive: true, force: true }) }
})

describe('Graphon full node-kind integration audit', () => {
  it('executes all 20 kinds through the real engine and production adapters using explicit model/SDK doubles', async () => {
    const server = createServer((request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ method: request.method, verified: true })) })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const directory = mkdtempSync(join(tmpdir(), 'graphon-all-kinds-')), storage = new WorkflowStorage(directory)
    writeFileSync(join(directory, 'knowledge.md'), 'Graphon workflow audit: local document and keyword retrieval.')
    const requests: ModelRequest[] = [], backend = { generate: async (request: ModelRequest) => {
      requests.push(request)
      if (request.prompt === 'AUDIT_CLASSIFY') return '{"class_id":"yes"}'
      if (request.prompt === 'AUDIT_EXTRACT') return '{"count":2}'
      if (request.prompt === 'AUDIT_LLM') return '{"value":7}'
      throw new Error('Unexpected model request; no external model is allowed')
    } }
    const catalog = new ToolCatalog({ directory, workflows: () => [], nativeTools: () => [], executeNative: async () => { throw new Error('No external tools allowed') }, runWorkflow: async () => { throw new Error('No external workflows allowed') }, http: httpRequest })
    const native=nativeAgentSdkAuditDouble(catalog)
    const runtime = new WorkflowRuntime(storage, backend, createExecutionAdapters({ catalog, nativeAgent:native.execute,workspaceRoot: () => directory }))
    contexts.push({ directory, runtime })
    try {
      const iteration: NodeGraph = { nodes: [node('item_start', 'input'), node('item_text', 'template', { text: '{{item}}' })], edges: [edge('item_start', 'item_text')] }
      const loop: NodeGraph = {
        nodes: [node('loop_start', 'input'), node('increment', 'assigner', { assignments: [{ name: 'count', operation: 'add', value: 1 }] }), node('loop_check', 'if', { variable: 'vars.count', operator: 'gte', value: '2' }), node('loop_exit', 'exit_loop'), node('loop_continue', 'template', { text: '{{vars.count}}' })],
        edges: [edge('loop_start', 'increment'), edge('increment', 'loop_check'), edge('loop_check', 'loop_exit', 'true'), edge('loop_check', 'loop_continue', 'false')],
      }
      const prefix = [
        node('start', 'input', { fields: [] }),
        node('code', 'code', { language: 'javascript', code: 'function main(){return {numbers:[3,1,2]}}', outputSchema: [{ name: 'numbers', type: 'array' }] }),
        node('list', 'list', { listSource: 'code.numbers', sort: 'asc' }),
        node('template', 'template', { text: 'numbers={{list.text}}' }),
        node('llm', 'llm', { model, prompt: 'AUDIT_LLM', outputSchema: [{ name: 'value', type: 'number' }] }),
        node('agent', 'agent', { model, prompt: 'AUDIT_AGENT', subagentId:'worker', tools: ['builtin:json.parse'], maxSteps: 3 }),
        node('knowledge', 'knowledge', { sources: ['knowledge.md'], query: 'workflow', topK: 1 }),
        node('document', 'document', { source: 'knowledge.md', documentMode: 'local' }),
        node('http', 'http', { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/audit`, method: 'POST', bodyText: '{"audit":true}' }),
        node('tool', 'tool', { toolId: 'builtin:json.parse', inputs: { text: '{"ok":true}' } }),
        node('condition', 'if', { variable: 'llm.value', operator: 'equals', value: '7' }),
      ]
      const flow = makeWorkflow('audit', 'All 20 node kinds')
      flow.subAgents=[{id:'worker',number:'agent-1',name:'测试员',prompt:''}]
      flow.nodes = [...prefix,
        node('yes', 'template', { text: 'selected' }), node('no', 'template', { text: 'unselected' }),
        node('merge', 'aggregator', { groups: [{ name: 'chosen', variables: ['yes.text', 'no.text'] }] }),
        node('classify', 'classifier', { model, prompt: 'AUDIT_CLASSIFY', classes: [{ id: 'yes', label: 'Match' }, { id: 'no', label: 'Other' }] }),
        node('extract', 'extractor', { model, prompt: 'AUDIT_EXTRACT', parameters: [{ name: 'count', type: 'number', required: true }] }),
        node('iteration', 'iteration', { iterator: 'list.result', body: iteration, outputVariable: 'item_text.text', parallel: true, concurrency: 2 }),
        node('loop', 'loop', { initialVariables: { count: 0 }, maxIterations: 5, body: loop }),
        node('human', 'human', { fields: [], actions: [{ id: 'approve', label: 'Continue' }] }),
        node('output', 'output', { text: '{{merge.chosen}} / {{extract.count}} / {{loop.variables.count}} / {{agent.text}}' }),
      ]
      flow.edges = [...prefix.slice(1).map((current, index) => edge(prefix[index]!.id, current.id)), edge('condition', 'yes', 'true'), edge('condition', 'no', 'false'), edge('yes', 'merge'), edge('no', 'merge'), edge('merge', 'classify'), edge('classify', 'extract', 'yes'), edge('extract', 'iteration'), edge('iteration', 'loop'), edge('loop', 'human'), edge('human', 'output', 'approve')]
      const saved = storage.save(flow, 0), started = runtime.start(saved.id, {})
      const waiting = await runtime.settle(started.id)
      expect(waiting.status).toBe('waiting')
      const completedBeforeAnswer = waiting.executions.filter(record => record.status === 'success').map(record => [record.executionId, record.startedAt])
      const requestCount = requests.length
      const done = await runtime.settle(runtime.answer(started.id, { __action: 'approve' }).id)
      expect(done.engine).toEqual({ name: 'graphon', version: '0.7.0', protocol: 1 })
      expect(done.status).toBe('success')
      expect(done.outputs.result).toBe('selected / 2 / 2 / agent verified')
      expect(requests).toHaveLength(requestCount)
      expect(native.observations).toMatchObject({starts:1,toolCalls:1,disposed:1,externalModelCalls:0})
      expect(done.executions.find(record=>record.nodeId==='agent')?.subagentId).toBe('audit-native-1')
      expect(done.executions.find(record => record.nodeId === 'no')?.status).toBe('skipped')
      expect(done.executions.find(record => record.nodeId === 'iteration')?.data?.result).toEqual(['1', '2', '3'])
      expect(done.executions.find(record => record.nodeId === 'knowledge')?.data?.method).toBe('local_keyword')
      expect(done.executions.find(record => record.nodeId === 'document')?.data?.text).toContain('Graphon workflow audit')
      expect(done.executions.find(record => record.nodeId === 'http')?.data?.json).toEqual({ method: 'POST', verified: true })
      expect(done.executions.find(record => record.nodeId === 'tool')?.data).toHaveProperty('json.ok', true)
      for (const [executionId, startedAt] of completedBeforeAnswer) expect(done.executions.find(record => record.executionId === executionId)?.startedAt).toBe(startedAt)
      const kinds = new Map<string, WorkflowNode['kind']>()
      const collect = (graph: NodeGraph) => { for (const current of graph.nodes) { kinds.set(current.id, current.kind); if (current.config.body) collect(current.config.body) } }
      collect(saved)
      const executedKinds = new Set(done.executions.filter(record => record.status === 'success').map(record => kinds.get(record.nodeId)))
      expect([...executedKinds].sort()).toEqual(Object.keys(NODE_LABELS).sort())
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })
})
