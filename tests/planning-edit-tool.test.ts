import { describe, expect, it } from 'vitest'
import { normalizePlanningEditToolChanges } from '../src/shared/planning-edit-tool.ts'
import { planningHandoffSchema } from '../src/shared/planning-handoff-contract.ts'
import { compileHandoffChanges } from '../src/shared/planning-handoff.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'

const change = (field: string, op = 'set-config', value: unknown = 'Updated') => ({ op, nodeId: 'target', field, ...(op === 'set-config' ? { value } : {}) })
const handoff = (changes: unknown) => planningHandoffSchema.parse({ version: 1, mode: 'edit', changes })
function context() {
  const ctx = templateContext(); ctx.operation = 'revise'; ctx.workflow.revision = 1
  ctx.workflow.nodes.splice(1, 0, { id: 'target', kind: 'template', title: 'Target', number: '3', x: 100, y: 0, fixed: false, config: { text: 'Before', inputs: { old: 'kept until replaced' } } })
  ctx.workflow.edges = [{ id: 'in', source: 'host-start', target: 'target' }, { id: 'out', source: 'target', target: 'host-end' }]
  ctx.targetNodeIds = ['target']
  return ctx
}
function compile(changes: unknown, ctx = context()) {
  const parsed = handoff(normalizePlanningEditToolChanges(changes))
  if (parsed.mode !== 'edit') throw Error('Expected edit')
  return compileHandoffChanges(parsed, ctx).candidate!
}

describe('native edit tool config field alias', () => {
  it('normalizes exactly one prefix for set/unset without mutating arguments or widening canonical handoffs', () => {
    const input = [change('config.text'), change('config.inputs', 'unset-config')], before = structuredClone(input)
    expect(normalizePlanningEditToolChanges(input)).toEqual([change('text'), change('inputs', 'unset-config')])
    expect(input).toEqual(before)
    expect(() => handoff(input)).toThrow()
    expect(normalizePlanningEditToolChanges([{ op: 'set-title', nodeId: 'target', value: 'config.text' }])).toEqual([{ op: 'set-title', nodeId: 'target', value: 'config.text' }])
  })
  it('keeps nested, malformed and protected fields rejected and canonical duplicate checks active', () => {
    for (const field of ['config.', 'config.config.text', 'config.inputs.name', 'config["text"]', '/config/text', ' config.text', 'config.text ', 'config.text\n', 'config.body', 'config.constructor', 'config.prototype', 'config.__proto__']) {
      expect(() => handoff(normalizePlanningEditToolChanges([change(field)])), field).toThrow()
    }
    expect(() => handoff(normalizePlanningEditToolChanges([change('text'), change('config.text', 'unset-config')]))).toThrow('冲突')
  })
  it('uses the same shared compilation and whole-field replacement for aliases and bare fields', () => {
    for (const value of ['Updated', { name: 'New object' }]) {
      const field = typeof value === 'string' ? 'text' : 'inputs'
      const bare = compile([change(field, 'set-config', value)]), alias = compile([change('config.' + field, 'set-config', value)])
      expect(alias).toEqual(bare)
      expect(alias.nodes.find(node => node.id === 'target')!.config[field]).toEqual(value)
    }
    const ctx = context(); ctx.targetNodeIds = ['host-start']
    const fields = [{ name: 'replacement', label: 'Replacement', required: false }]
    const bare = [{ op: 'set-config', nodeId: 'host-start', field: 'fields', value: fields }]
    expect(compile(bare, ctx)).toEqual(compile([{ ...bare[0], field: 'config.fields' }], ctx))
    expect(compile([change('config.inputs', 'unset-config')]).nodes.find(node => node.id === 'target')!.config.inputs).toBeUndefined()
  })
  it('preserves shared type, metadata, fixed-node and target-scope guards', () => {
    expect(() => compile([change('config.text', 'set-config', 123)])).toThrow()
    for (const field of ['kind', 'id', 'fixed']) expect(() => compile([change('config.' + field)])).toThrow()
    const fixed = context(); fixed.workflow.nodes.find(node => node.id === 'target')!.fixed = true
    expect(() => compile([change('config.text')], fixed)).toThrow('固定节点')
    const outside = context(); outside.targetNodeIds = ['host-start']
    expect(() => compile([change('config.text')], outside)).toThrow('授权范围')
  })
})
