import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeWorkflow, type WorkflowNode, type Workflow } from '../src/shared/types.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'

const contexts: { path: string; runtime: WorkflowRuntime }[] = []
const node = (id: string, kind: WorkflowNode['kind'], config: WorkflowNode['config'] = {}): WorkflowNode => ({ id, kind, config, number: id, title: id, fixed: false, x: 0, y: 0 })
const edge = (source: string, target: string, port?: string) => ({ id: `${source}_${target}`, source, target, ...(port ? { port } : {}) })
function setup(nodes: WorkflowNode[], edges: Workflow['edges']) {
  const path = mkdtempSync(join(tmpdir(), 'output-conflict-')), storage = new WorkflowStorage(path), runtime = new WorkflowRuntime(storage, { generate: async () => { throw new Error('No model calls allowed') } })
  contexts.push({ path, runtime })
  const saved = storage.save({ ...makeWorkflow('audit'), nodes, edges }, 0)
  return { storage, runtime, saved }
}
afterEach(async () => { for (const { path, runtime } of contexts.splice(0)) { await runtime.close(); rmSync(path, { recursive: true, force: true }) } })

describe('named workflow outputs', () => {
  it('fails explicitly before a second active output overwrites the first', async () => {
    const { runtime, saved } = setup([node('start', 'input'), node('first', 'output', { text: 'first', outputName: 'result' }), node('second', 'output', { text: 'second', outputName: 'result' })], [edge('start', 'first'), edge('first', 'second')])
    const done = await runtime.settle(runtime.start(saved.id, {}).id)
    expect(done.status).toBe('failed')
    expect(done.error).toContain('输出名称「result」重复')
    expect(done.outputs).toEqual({ result: 'first' })
    expect(done.executions.find(record => record.nodeId === 'second')?.status).toBe('failed')
    expect(done.executions.find(record => record.nodeId === 'second')?.data).toBeUndefined()
  })

  it('allows the same name in mutually exclusive branches', async () => {
    const { runtime, saved } = setup([node('start', 'input', { fields: [{ name: 'flag', label: 'Flag', type: 'boolean', required: true }] }), node('choose', 'if', { variable: 'input.flag', operator: 'equals', value: 'true' }), node('yes', 'output', { text: 'yes' }), node('no', 'output', { text: 'no' })], [edge('start', 'choose'), edge('choose', 'yes', 'true'), edge('choose', 'no', 'false')])
    for (const [flag, expected] of [['true', 'yes'], ['false', 'no']]) {
      const done = await runtime.settle(runtime.start(saved.id, { flag: flag! }).id)
      expect(done.status).toBe('success')
      expect(done.outputs).toEqual({ result: expected })
    }
  })

  it('reconstructs outputs after Human Input without treating cached replay as a conflict', async () => {
    const { runtime, saved } = setup([node('start', 'input'), node('first', 'output', { text: 'stable', outputName: 'before' }), node('human', 'human', { fields: [], actions: [{ id: 'go', label: 'Continue' }] }), node('last', 'output', { text: 'done', outputName: 'after' })], [edge('start', 'first'), edge('first', 'human'), edge('human', 'last')])
    const run = await runtime.settle(runtime.start(saved.id, {}).id)
    expect(run.status).toBe('waiting')
    const done = await runtime.settle(runtime.answer(run.id, { __action: 'go' }).id)
    expect(done.status).toBe('success')
    expect(done.outputs).toEqual({ before: 'stable', after: 'done' })
  })

  it('keeps child output names local to their iteration scope', async () => {
    const body = { nodes: [node('child_start', 'input'), node('child_output', 'output', { text: '{{item}}', outputName: 'result' })], edges: [edge('child_start', 'child_output')] }
    const { runtime, saved } = setup([node('start', 'input'), node('iteration', 'iteration', { iterator: '[1,2]', body, outputVariable: 'child_output.text' }), node('out', 'output', { text: '{{iteration.text}}', outputName: 'result' })], [edge('start', 'iteration'), edge('iteration', 'out')])
    const done = await runtime.settle(runtime.start(saved.id, {}).id)
    expect(done.status).toBe('success')
    expect(done.outputs).toEqual({ result: '["1","2"]' })
  })
})
