import { describe, expect, it } from 'vitest'
import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { handoffCompletionPlan, completionCandidateIssues } from '../src/shared/planning-completion.ts'
import { compileHandoffChanges, handoffCandidateIssues, handoffSelection, planningHandoffSchema } from '../src/shared/planning-handoff.ts'
import { singleFieldValueEligible } from '../src/shared/planning-field-value.ts'
import { templateContext } from './fixtures/planning-compiler/template.ts'

function fixture(fields = ['text']) {
  const context = templateContext(); context.operation = 'revise'; context.workflow.revision = 1
  context.workflow.nodes.splice(1, 0, { id: 'value-target', kind: 'template', title: 'Kept', number: '3', x: 100, y: 0, fixed: false, config: { text: 'PENDING', inputs: { keep: 1 } } })
  context.workflow.nodes[2]!.config.text = '{{value-target.text}}'
  context.workflow.edges = [{ id: 'a', source: 'host-start', target: 'value-target' }, { id: 'b', source: 'value-target', target: 'host-end' }]
  context.targetNodeIds = ['value-target']
  const handoff = planningHandoffSchema.parse({ version: 2, mode: 'partial', changes: [{ op: 'set-title', nodeId: 'value-target', value: 'Decided title' }], unresolved: [{ nodeId: 'value-target', fields, question: 'Fill only these fields' }], completion: fields.map(field => ({ nodeId: 'value-target', field, require: 'changed' })) })
  const before = structuredClone(context), decided = compileHandoffChanges(handoff, context).candidate!, completion = handoffCompletionPlan(handoff, context, decided)!
  const authorContext = { ...context, workflow: decided, contextSelection: handoffSelection(handoff) }
  const options = { completion, requiredCoverageIds: ['R1'], resumeScope: 'workspace/session/value-task', validate: (candidate: any) => [...completionCandidateIssues(completion, candidate), ...handoffCandidateIssues(handoff, decided, candidate)] }
  const make = (singleFieldValue = true, resume?: any) => new TemplateFillingCompiler(authorContext, { ...options, singleFieldValue, ...(resume ? { resume } : {}) })
  return { context, before, handoff, decided, completion, make }
}
const complete = (value: unknown) => ({ submission: { mode: 'complete-field', value } })
const edit = (text: unknown) => ({ submission: { mode: 'edit', updates: { n2: { values: { text } } }, coverage: { R1: ['n2'] } } })
const question = { submission: { mode: 'needs-input', questions: [{ id: 'choice', question: 'Choose the business value' }] } }
const repair = (value: unknown, revision = 1, path = '/updates/n2/values/text') => ({ submission: { mode: 'repair', draftRevision: revision, patches: [{ op: 'replace', path, value }] } })

describe('Host fixed single-field v2 value protocol', () => {
  it('shares the canonical materializer and changed guard; value and legacy envelopes yield the same candidate and immutable baseline', () => {
    const f = fixture(), compiler = f.make(), old = f.make(false)
    assertObjectJsonSchema(compiler.schema); assertObjectJsonSchema(compiler.nextSchema)
    expect(compiler.catalog().prefetched.fields).toContain('submission.value')
    expect(old.catalog().prefetched.fields).toContain('values schema')
    expect(validateJsonSchemaValue(compiler.schema, complete('Completed'))).toEqual([])
    expect(validateJsonSchemaValue(compiler.nextSchema, edit('Completed')).length).toBeGreaterThan(0)
    const a = compiler.submit(complete('Completed')), b = old.submit(edit('Completed'))
    if (!a.ok || !b.ok) throw Error('Expected valid candidates')
    a.value.candidate!.updatedAt = b.value.candidate!.updatedAt
    expect(a.value).toEqual(b.value); expect(f.context).toEqual(f.before)
    expect(a.value.candidate!.nodes[1]).toMatchObject({ id: 'value-target', title: 'Decided title', config: { text: 'Completed', inputs: { keep: 1 } } })
  })
  it.each(['PENDING', 42, '{{missing.text}}'])('retains exact repair authority for invalid value %s, canonical draft, revision and finite submissions', value => {
    const f = fixture(), compiler = f.make()
    assertObjectJsonSchema(compiler.schema);assertObjectJsonSchema(compiler.nextSchema)
    expect(validateJsonSchemaValue(compiler.nextSchema, complete('Completed'))).toEqual([])
    const result = compiler.submit(complete(value))
    expect(result.ok).toBe(false); if (result.ok) throw Error('Expected rejection')
    const legacy=f.make(false).submit(edit(value)); if(legacy.ok)throw Error('Expected matching legacy rejection')
    expect(result.feedback.allowedPaths).toEqual(legacy.feedback.allowedPaths)
    expect(compiler.snapshot().document).toEqual(edit(value).submission)
    assertObjectJsonSchema(compiler.nextSchema)
    const fieldPath='/updates/n2/values/text',root=result.feedback.allowedPaths.find(path=>fieldPath===path||fieldPath.startsWith(path+'/'))!
    const replacement=fieldPath.slice(root.length).split('/').filter(Boolean).reduceRight<unknown>((child,key)=>({[key]:child}),'Completed')
    expect(validateJsonSchemaValue(compiler.nextSchema, repair(replacement,1,root))).toEqual([])
    expect(validateJsonSchemaValue(compiler.nextSchema, complete('Retry')).length).toBeGreaterThan(0)
    const escaped=f.make(); escaped.submit(complete(value))
    try { const denied=escaped.submit(repair('Escape',1,'/updates/n2/title')); expect(denied.ok).toBe(false) } catch(error) { expect((error as any).code).toMatch(/PATCH_|HANDOFF_DECISION_CONFLICT/) }
    expect(() => compiler.submit(complete('Retry'))).toThrow('已有失败草稿')
    const resumed = f.make(true, compiler.checkpoint())
    expect(resumed.continuation()).toMatchObject({ hasDraft: true, remainingSubmissions: 2, unresolved: result.feedback.allowedPaths })
    expect(resumed.submit(repair('Completed')).ok).toBe(true)
    expect(f.context).toEqual(f.before)
  })
  it('rejects extra envelope/field, unknown business target and undefined value instead of dropping them', () => {
    for (const value of [{ ...complete('x'), extra: true }, { submission: { ...complete('x').submission, node: 'other' } }, { submission: { mode: 'complete-field' } }, complete(undefined), edit('x')]) {
      const compiler = fixture().make(); expect(() => compiler.submit(value)).toThrow(); expect(compiler.snapshot().submissions).toBe(0)
    }
  })
  it('keeps human questions and no-draft resume without replacing the answer or submission allowance', () => {
    const f = fixture(), compiler = f.make(); expect(compiler.submit(question).ok).toBe(true)
    const resumed = f.make(true, compiler.checkpoint())
    expect(resumed.continuation()).toMatchObject({ kind: 'initial-clarification', hasDraft: false, remainingSubmissions: 2 })
    expect(validateJsonSchemaValue(resumed.nextSchema, complete('Human chosen'))).toEqual([])
    expect(resumed.submit(complete('Human chosen')).ok).toBe(true)
    expect(resumed.snapshot().submissions).toBe(2)
  })
  it('reads old canonical clarification drafts and preserves old frontends and multi-field routing', () => {
    const f = fixture(), old = f.make(false); old.submit(edit('PENDING')); old.submit(question)
    const resumed = f.make(true, old.checkpoint()); expect(resumed.submit(repair('Complete')).ok).toBe(true)
    expect(singleFieldValueEligible(f.handoff, ['R1'])).toBe(true)
    expect(singleFieldValueEligible(f.handoff, ['R1', 'S1'])).toBe(false)
    const multi = fixture(['text', 'inputs']); expect(singleFieldValueEligible(multi.handoff, ['R1'])).toBe(false)
    expect(() => multi.make()).toThrow('一个明确完成义务')
    expect(multi.make(false).fieldValueMode).toBe(false)
    const { completion: _, ...v1 } = f.handoff as any; v1.version = 1
    expect(singleFieldValueEligible(planningHandoffSchema.parse(v1), ['R1'])).toBe(false)
  })
})
