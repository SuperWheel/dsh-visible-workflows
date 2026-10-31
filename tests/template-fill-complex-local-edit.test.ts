import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { planningEditView } from '../src/shared/planning-edits.ts'
import { templateAuthoringContext } from '../src/host/planning/template-catalog.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { createExecutionAdapters } from '../src/host/execution-adapters.ts'
import { ToolCatalog } from '../src/host/tool-catalog.ts'
import { cases, contextFor } from '../scripts/benchmarks/workflow-compiler.ts'

// Existing benchmark large-edit input is reused. No model or provider is started.
function baseline() {
  const context = contextFor(cases.find(item => item.id === 'large-edit')!)
  context.workflow.workspaceId = 'workspace'
  context.workflow.environmentVariables = [{ id: 'rate', name: 'Rate', type: 'number', value: 2, description: 'Preserve unrelated metadata' }]
  context.workflow.notes = [{ id: 'note', text: 'Preserve this note', x: 17, y: 29, width: 220, height: 130 } as any]
  return context
}
describe('template-fill actual local editing on the existing large graph', () => {
  it('changes one selected template, preserves all other fields and executes two independent inputs', async () => {
    const context = baseline(), directory = mkdtempSync(join(tmpdir(), 'template-large-edit-'))
    const storage = new WorkflowStorage(directory)
    const catalog = new ToolCatalog({ directory, workflows: () => [], nativeTools: () => [], executeNative: async () => { throw Error('No native calls') }, runWorkflow: async () => { throw Error('No nested calls') }, http: async () => { throw Error('No network') } })
    const runtime = new WorkflowRuntime(storage, { generate: async () => { throw Error('No models') } }, createExecutionAdapters({ catalog, workspaceRoot: () => directory }))
    try {
      // Persist the baseline through production validation rather than assuming
      // fixture revision 7 exists on disk.
      context.workflow.revision = 0
      context.workflow = storage.save(context.workflow, 0)
      const original = structuredClone(context.workflow)
      const focused = templateAuthoringContext(context, 'Only change the selected last template')
      expect(focused.graph!.nodes.filter(row => 'values' in row && row.values)).toHaveLength(1)
      const ref = planningEditView(context).targetNodeRefs[0]!, key = 'n' + ref.slice(1)
      const compiled = new TemplateFillingCompiler(context).submit({ submission: { mode: 'edit', updates: { [key]: { values: { text: '结果：{{input.text}}' } } }, coverage: { R1: [key] } } })
      if (!compiled.ok) throw Error(JSON.stringify(compiled.feedback))
      const candidate = compiled.value.candidate!
      const restored = structuredClone(candidate), target = restored.nodes.find(row => row.id === 'target')!
      target.config = structuredClone(original.nodes.find(row => row.id === 'target')!.config)
      expect(restored).toEqual(original)
      expect(storage.get(original.id)).toEqual(original)
      const saved = storage.save(candidate, original.revision, 'agent')
      const observations = []
      for (const [text, expected] of [['甲', '结果：甲'], ['乙', '结果：乙']]) {
        const done = await runtime.settle(runtime.start(saved.id, { text: text! }).id)
        expect(done.status, done.error).toBe('success')
        expect(done.outputs.result).toBe(expected)
        expect(done.engine?.name).toBe('graphon')
        observations.push({ id: done.id, status: done.status, outputs: done.outputs, nodes: done.graph.nodes.length, engine: done.engine })
      }
      if (process.env.T05_COMPLEX_EVIDENCE_DIR) {
        mkdirSync(process.env.T05_COMPLEX_EVIDENCE_DIR, { recursive: true })
        writeFileSync(join(process.env.T05_COMPLEX_EVIDENCE_DIR, 'large-local-edit.json'), JSON.stringify({ passed: true, unchangedFieldsDeepEqual: true, targetId: 'target', observations, modelCalls: 0 }, null, 2) + '\n')
      }
    } finally {
      await runtime.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 45_000)
  it('rejects an edit to an unselected sibling in the same large graph', () => {
    const context = baseline(), view = planningEditView(context)
    const sibling = view.nodes.find(row => row.ref !== view.targetNodeRefs[0] && row.kind === 'template')!
    const before = structuredClone(context.workflow)
    expect(() => new TemplateFillingCompiler(context).submit({ submission: { mode: 'edit', updates: { ['n' + sibling.ref.slice(1)]: { values: { text: 'Forbidden rewrite' } } }, coverage: { R1: ['n' + sibling.ref.slice(1)] } } })).toThrow()
    expect(context.workflow).toEqual(before)
  })
})
