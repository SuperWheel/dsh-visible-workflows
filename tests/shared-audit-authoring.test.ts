import { describe, it, expect } from 'vitest'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { compileHandoffChanges } from '../src/shared/planning-handoff.ts'
import { sealRepairCheckpoint } from '../src/shared/planning-continuation.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'
import type { PlanningContext } from '../src/shared/planning-types.ts'

// Regression tests for the 2026-10-20 shared planning audit (authoring/repair).
const localContext = (): PlanningContext => {
  const ctx = templateContext(); ctx.operation = 'revise'; ctx.workflow.revision = 1
  ctx.workflow.nodes.splice(1, 0, { id: 'tmpl', kind: 'template', title: 'T', number: '3', x: 1, y: 1, fixed: false, config: { inputs: { n1: 'LOCAL' }, text: '{{n1}}' } })
  ctx.workflow.edges = [{ id: 'e1', source: 'host-start', target: 'tmpl' }, { id: 'e2', source: 'tmpl', target: 'host-end' }]
  ctx.targetNodeIds = ['tmpl']
  return ctx
}
const edit = (change: unknown) => ({ submission: { mode: 'edit', updates: { n2: change }, coverage: { R1: ['n2'] } } })

describe('local template variables survive a text-only patch (LOCAL_ALIAS)', () => {
  it('keeps an existing input alias when only text is set', () => {
    const result = new WorkflowAuthoringCompiler(localContext()).submit(edit({ set: { text: '{{n1}}!' } }))
    if (!result.ok) throw Error(JSON.stringify(result.feedback))
    expect(result.value.candidate!.nodes.find(n => n.id === 'tmpl')!.config).toEqual({ text: '{{n1}}!', inputs: { n1: 'LOCAL' } })
  })
  it('rewrites the alias to the node once unset removes the local input', () => {
    const result = new WorkflowAuthoringCompiler(localContext()).submit(edit({ set: { text: '{{n1.text}}!' }, unset: ['inputs'] }))
    if (!result.ok) throw Error(JSON.stringify(result.feedback))
    expect(result.value.candidate!.nodes.find(n => n.id === 'tmpl')!.config).toEqual({ text: '{{host-start.text}}!' })
  })
  it('treats a local declared by the same patch as local', () => {
    const result = new WorkflowAuthoringCompiler(localContext()).submit(edit({ set: { text: '{{n1}} {{other}}', inputs: { n1: 'A', other: 'B' } } }))
    if (!result.ok) throw Error(JSON.stringify(result.feedback))
    expect(result.value.candidate!.nodes.find(n => n.id === 'tmpl')!.config.text).toBe('{{n1}} {{other}}')
  })
  it('keeps locals in field handoffs', () => {
    const result = compileHandoffChanges({ version: 1, mode: 'edit', constraints: [], evidenceRefs: [], changes: [{ op: 'set-config', nodeId: 'tmpl', field: 'text', value: '{{n1}}?' }] }, localContext())
    expect(result.issues).toEqual([])
    expect(result.candidate!.nodes.find(n => n.id === 'tmpl')!.config).toEqual({ text: '{{n1}}?', inputs: { n1: 'LOCAL' } })
  })
})

describe('template repair stays field-scoped (REPAIR_ALLOWED / REPAIR_RESULT)', () => {
  it('allows only the invalid field and rejects edits to valid fields', () => {
    const compiler = new TemplateFillingCompiler(localContext())
    const bad = compiler.submit(edit({ values: { text: 42, inputs: { n1: 'KEEP' } } }))
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.feedback.allowedPaths).toEqual(['/updates/n2/values/text'])
    const widened = compiler.submit({ submission: { mode: 'repair', draftRevision: 1, patches: [
      { op: 'replace', path: '/updates/n2/values/text', value: 'correct' },
      { op: 'replace', path: '/updates/n2/values/inputs/n1', value: 'CHANGED_VALID' },
      { op: 'add', path: '/updates/n2/title', value: 'UNRELATED TITLE' },
    ] } })
    expect(widened.ok).toBe(false)
    if (!widened.ok) expect(widened.feedback.issues[0]!.code).toBe('PATCH_SCOPE')
    const repaired = compiler.submit({ submission: { mode: 'repair', draftRevision: 1, patches: [{ op: 'replace', path: '/updates/n2/values/text', value: 'correct' }] } })
    if (!repaired.ok) throw Error(JSON.stringify(repaired.feedback))
    const tmpl = repaired.value.candidate!.nodes.find(n => n.id === 'tmpl')!
    expect(tmpl.title).toBe('T')
    expect(tmpl.config).toEqual({ text: 'correct', inputs: { n1: 'KEEP' } })
  })
})

describe('checkpoint keeps key → Host ID reservations (IDENTITY_AFTER_RESUME)', () => {
  it('resumes with the same IDs as the uninterrupted compiler', () => {
    const options = { maxSubmissions: 4, resumeScope: 'audit-resume' }
    const compiler = new WorkflowAuthoringCompiler(templateContext(), options)
    const first = compiler.submit({ submission: { mode: 'create', title: 'test', nodes: [
      { key: 'start', kind: 'input', config: { fields: [] } },
      { key: 'first', kind: 'template', title: 'FIRST', config: { text: 'one' } },
      { key: 'second', kind: 'template', title: 'SECOND', config: { text: 'two' } },
      { key: 'result', kind: 'output', config: { text: 'done' } },
    ], chains: [{ key: 'main', nodes: ['start', 'first', 'second', 'result'] }, { key: 'cycle', nodes: ['result', 'second'] }], coverage: { R1: ['second'] } } })
    expect(first.ok).toBe(false)
    const second = compiler.submit({ submission: { mode: 'repair', draftRevision: 1, patches: [{ op: 'remove', path: '/nodesByKey/first' }, { op: 'replace', path: '/chainsByKey/main/nodes', value: ['start', 'second', 'result'] }] } })
    expect(second.ok).toBe(false)
    const checkpoint = compiler.checkpoint()!
    expect(checkpoint.reservations?.nodes['+second']).toBe('allocated-1')
    const resumed = new WorkflowAuthoringCompiler(templateContext(), { ...options, resume: checkpoint })
    const patch = { submission: { mode: 'repair', draftRevision: 2, patches: [{ op: 'remove', path: '/chainsByKey/cycle' }] } }
    const a = compiler.submit(patch), b = resumed.submit(patch)
    if (!a.ok || !b.ok) throw Error('repair failed')
    const id = (r: typeof a) => r.ok ? r.value.candidate!.nodes.find(n => n.title === 'SECOND')!.id : ''
    expect(id(a)).toBe('allocated-1')
    expect(id(b)).toBe('allocated-1')
  })
  it('rejects checkpointed reservations outside the current Host pool', () => {
    const options = { maxSubmissions: 4, resumeScope: 'audit-resume' }
    const compiler = new WorkflowAuthoringCompiler(templateContext(), options)
    compiler.submit({ submission: { mode: 'create', title: 't', nodes: [{ key: 'start', kind: 'input', config: { fields: [] } }, { key: 'x', kind: 'template', config: { text: 'x' } }, { key: 'result', kind: 'output', config: { text: '' } }], chains: [{ key: 'm', nodes: ['start', 'x', 'result'] }, { key: 'cycle', nodes: ['result', 'x'] }], coverage: { R1: ['x'] } } })
    const { digest: _, ...body } = compiler.checkpoint()!
    expect(body.reservations?.nodes['+x']).toMatch(/^allocated-/)
    for (const forged of ['host-start', 'outside-pool']) {
      const checkpoint = sealRepairCheckpoint({ ...body, reservations: { ...body.reservations!, nodes: { ...body.reservations!.nodes, '+x': forged } } })
      expect(() => new WorkflowAuthoringCompiler(templateContext(), { ...options, resume: checkpoint })).toThrow('身份池')
    }
  })
})

describe('only template text treats inputs keys as locals', () => {
  it('still rewrites an llm prompt reference whose root equals an inputs key', () => {
    const ctx = localContext()
    ctx.workflow.nodes[1] = { ...ctx.workflow.nodes[1]!, kind: 'llm', config: { prompt: 'x', inputs: { n1: 'LOCAL' }, model: { provider: 'offline', model: 'test' } } }
    const result = new WorkflowAuthoringCompiler(ctx).submit(edit({ set: { prompt: '{{n1.text}}' } }))
    if (!result.ok) throw Error(JSON.stringify(result.feedback))
    expect(result.value.candidate!.nodes.find(n => n.id === 'tmpl')!.config.prompt).toBe('{{host-start.text}}')
  })
})

describe('template update shape errors stay field-scoped', () => {
  it('opens only the invalid title, not the valid values', () => {
    const compiler = new TemplateFillingCompiler(localContext())
    const bad = compiler.submit(edit({ title: 42, values: { text: 'KEEP' } }))
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.feedback.allowedPaths).toEqual(['/updates/n2/title'])
    const widened = compiler.submit({ submission: { mode: 'repair', draftRevision: 1, patches: [{ op: 'replace', path: '/updates/n2/title', value: 'Fixed' }, { op: 'replace', path: '/updates/n2/values/text', value: 'CHANGED' }] } })
    expect(widened.ok).toBe(false)
    const repaired = compiler.submit({ submission: { mode: 'repair', draftRevision: 1, patches: [{ op: 'replace', path: '/updates/n2/title', value: 'Fixed' }] } })
    if (!repaired.ok) throw Error(JSON.stringify(repaired.feedback))
    const tmpl = repaired.value.candidate!.nodes.find(n => n.id === 'tmpl')!
    expect([tmpl.title, tmpl.config.text]).toEqual(['Fixed', 'KEEP'])
  })
})
