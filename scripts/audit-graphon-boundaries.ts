/** Read-only audit of saved graphs plus isolated, deterministic boundary probes. */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { makeWorkflow, type NodeGraph, type Workflow, type WorkflowNode } from '../src/shared/types.ts'
import { parseWorkflow, graphIssues, allNodes } from '../src/host/validation.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { ToolCatalog } from '../src/host/tool-catalog.ts'
import { createExecutionAdapters, httpRequest } from '../src/host/execution-adapters.ts'
import { bindNodeSubagent, createWorkflowSubagent } from '../src/shared/workflow-subagents.ts'
import { nativeAgentSdkAuditDouble } from './fixtures/native-agent-sdk-audit-double.ts'

process.env.DSH_WORKFLOW_RUNTIME_DIRECTORY ??= resolve('.cache/graphon-test-runtime')
const node = (id: string, kind: WorkflowNode['kind'], config: WorkflowNode['config'] = {}): WorkflowNode => ({ id, kind, config, title: id, number: id, x: 0, y: 0, fixed: false })
const edge = (source: string, target: string, port?: string) => ({ id: `${source}_${target}`, source, target, ...(port ? { port } : {}) })
const flow = (nodes: WorkflowNode[], edges?: NodeGraph['edges']): Workflow => ({ ...makeWorkflow('audit', 'Isolated boundary probe'), nodes, edges: edges ?? nodes.slice(1).map((current, i) => edge(nodes[i]!.id, current.id)) })
async function execute(graph: Workflow) {
  const directory = await mkdtemp(join(tmpdir(), 'graphon-boundary-')), storage = new WorkflowStorage(directory)
  const runtime = new WorkflowRuntime(storage, { generate: async () => { throw new Error('Audit cannot call external models') } })
  try {
    const saved = storage.save(graph, 0)
    let started
    try { started = runtime.start(saved.id, {}) }
    catch (error) {
      // Reference preflight may deliberately reject an invalid probe before
      // spawning Graphon. Record that boundary instead of losing later probes.
      return { status: 'rejected', phase: 'start-validation', engineStarted: false, outputs: {}, error: error instanceof Error ? error.message : String(error), completedOutputs: 0 }
    }
    const run = await runtime.settle(started.id)
    return { engine: run.engine, status: run.status, outputs: run.outputs, error: run.error, completedOutputs: run.executions.filter(record => graph.nodes.find(current => current.id === record.nodeId)?.kind === 'output' && record.status === 'success').length }
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }) }
}

const probes: Record<string, unknown> = {}
const start = () => node('start', 'input', { fields: [] })
// This exercises production Graphon/native-adapter/builtin code; the host lifecycle and model result are explicit doubles.
{
  const directory=await mkdtemp(join(tmpdir(),'graphon-native-sdk-audit-')),storage=new WorkflowStorage(directory)
  const catalog=new ToolCatalog({directory,workflows:()=>[],nativeTools:()=>[],executeNative:async()=>{throw new Error('No external tools in audit')},runWorkflow:async()=>{throw new Error('No external workflow in audit')},http:httpRequest})
  const native=nativeAgentSdkAuditDouble(catalog),runtime=new WorkflowRuntime(storage,{generate:async()=>{throw new Error('No real model calls in SDK audit')}},createExecutionAdapters({catalog,nativeAgent:native.execute,workspaceRoot:()=>directory}))
  try{
    const graph=flow([start(),node('agent','agent',{model:{provider:'audit',model:'explicit-sdk-double'},prompt:'AUDIT_AGENT',tools:['builtin:json.parse'],maxSteps:2}),node('out','output',{text:'{{agent.text}}'})])
    bindNodeSubagent(graph,'agent',createWorkflowSubagent(graph,'Audit native agent'))
    const saved=storage.save(graph,0)
    const run=await runtime.settle(runtime.start(saved.id,{}).id)
    probes.nativeAgentLifecycle={status:run.status,error:run.error,engine:run.engine,outputs:run.outputs,...native.observations,subagentId:run.executions.find(record=>record.nodeId==='agent')?.subagentId}
  }finally{await runtime.close();await rm(directory,{recursive:true,force:true})}
}
probes.siblingReferenceWithoutDependency = await execute(flow([start(), node('a', 'template', { text: 'from-a' }), node('b', 'template', { text: '{{a.text}}' }), node('out', 'output', { text: '{{b.text}}' })], [edge('start', 'a'), edge('start', 'b'), edge('b', 'out')]))
probes.duplicateOutputName = await execute(flow([start(), node('a', 'output', { text: 'first', outputName: 'result' }), node('b', 'output', { text: 'second', outputName: 'result' })], [edge('start', 'a'), edge('start', 'b')]))
probes.fullJinjaMacro = await execute(flow([start(), node('macro', 'template', { text: '{% macro greet() %}hi{% endmacro %}{{ greet() }}' }), node('out', 'output', { text: '{{macro.text}}' })]))
for (const errorMode of ['terminate', 'null', 'remove'] as const) {
  const inner: NodeGraph = { nodes: [node('item_start', 'input'), node('inner_exit', 'exit_loop')], edges: [edge('item_start', 'inner_exit')] }
  const body: NodeGraph = { nodes: [node('loop_start', 'input'), node('iteration', 'iteration', { iterator: '[1]', body: inner, outputVariable: 'inner_exit.text', errorMode })], edges: [edge('loop_start', 'iteration')] }
  probes[`exitLoopInsideIteration_${errorMode}`] = await execute(flow([start(), node('loop', 'loop', { maxIterations: 3, initialVariables: {}, body }), node('out', 'output', { text: '{{loop.iterations}}' })]))
}

const libraries: unknown[] = []
async function executeSafeCopy(graph: Workflow, issues: string[]) {
  if (issues.length) return { status: 'not-run', reason: 'saved-graph-has-executable-validation-issues' }
  const nodes = allNodes(graph)
  if (nodes.some(current => ['llm', 'agent', 'classifier', 'extractor', 'document', 'knowledge', 'http'].includes(current.kind) || current.kind === 'code' && current.config.language === 'python' || current.kind === 'tool' && !/^builtin:(time\.|json\.)/.test(current.config.toolId ?? ''))) return { status: 'not-run', reason: 'requires-external-model-tool-file-context-or-python-sandbox' }
  const directory = await mkdtemp(join(tmpdir(), 'graphon-saved-copy-')), storage = new WorkflowStorage(directory)
  const catalog = new ToolCatalog({ directory, workflows: () => [], nativeTools: () => [], executeNative: async () => { throw new Error('External tools are disabled during copy audit') }, runWorkflow: async () => { throw new Error('External workflow is disabled during copy audit') }, http: httpRequest })
  const runtime = new WorkflowRuntime(storage, { generate: async () => { throw new Error('External models are disabled during copy audit') } }, createExecutionAdapters({ catalog, workspaceRoot: () => directory }))
  try {
    const values = (fields: NonNullable<WorkflowNode['config']['fields']>) => Object.fromEntries(fields.filter(field => field.required).map(field => [field.name, field.defaultValue ?? (field.type === 'number' ? '1' : field.type === 'boolean' ? 'true' : field.type === 'json' ? '{}' : field.type === 'select' ? field.options?.[0] ?? '' : 'Graphon isolated audit')]))
    const copy = { ...structuredClone(graph), revision: 0 }, saved = storage.save(copy, 0)
    let run = await runtime.settle(runtime.start(saved.id, values(saved.nodes.find(current => current.kind === 'input')?.config.fields ?? [])).id), answers = 0
    while (run.status === 'waiting' && answers < 10) {
      const action = run.humanActions?.[0]?.id
      if (!action) break
      run = await runtime.settle(runtime.answer(run.id, { ...values(run.missingFields ?? []), __action: action }).id); answers++
    }
    return { status: run.status, engine: run.engine, successfulSteps: run.executions.filter(record => record.status === 'success').length, humanAnswers: answers, outputKeys: Object.keys(run.outputs), ...(run.error ? { error: run.error } : {}), isolation: 'temporary-copy-original-library-not-written' }
  } catch (error) { return { status: 'failed', error: error instanceof Error ? error.message : String(error) } }
  finally { await runtime.close(); await rm(directory, { recursive: true, force: true }) }
}
const args = process.argv.slice(2)
let output = resolve('doc/workflow-manual/验证/边界与存量流程证据.json')
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output') { output = resolve(args[++i]!); continue }
  if (args[i] !== '--library' || !args[i + 1]) throw new Error('Usage: node --import tsx scripts/audit-graphon-boundaries.ts [--library path] [--output path]')
  const path = resolve(args[++i]!), before = await readFile(path), library = JSON.parse(before.toString()) as { workflows: unknown[] }
  const graphs: unknown[] = []
  for (const [index, raw] of library.workflows.entries()) {
    try {
      const graph = parseWorkflow(raw), nodes = allNodes(graph), issues = graphIssues(graph, true)
      const reachable = new Set<string>(), visit = (id: string) => { if (reachable.has(id)) return; reachable.add(id); for (const link of graph.edges) if (link.source === id) visit(link.target) }
      graph.nodes.filter(current => current.kind === 'input').forEach(current => visit(current.id))
      graphs.push({ index: index + 1, title: graph.title, revision: graph.revision, rootNodes: graph.nodes.length, totalNodes: nodes.length, kinds: [...new Set(nodes.map(current => current.kind))].sort(), validSchema: true, executableIssues: issues.map(issue => issue.message), unreachableRootNodes: graph.nodes.filter(current => !reachable.has(current.id)).map(current => ({ number: current.number, kind: current.kind })), execution: await executeSafeCopy(graph, issues.map(issue => issue.message)) })
    } catch (error) { graphs.push({ index: index + 1, validSchema: false, error: error instanceof Error ? error.message : String(error) }) }
  }
  const after = await readFile(path)
  libraries.push({ libraryIndex: libraries.length + 1, sha256: createHash('sha256').update(before).digest('hex'), unchanged: before.equals(after), workflows: graphs })
}
const report = { schema: 1, date: new Date().toISOString().slice(0,10), graphon: '0.7.0', scope: 'isolated-real-engine-boundary-probes-and-safe-saved-graph-copies-original-libraries-read-only', externalModelCalls: 0, libraries, probes }
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
