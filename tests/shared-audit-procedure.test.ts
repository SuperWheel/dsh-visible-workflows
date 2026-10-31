import { describe, expect, it } from 'vitest'
import { createProcedureCompiler } from '../src/shared/planning-procedure-compiler.ts'
import { parseTaskProcedure, type ConversationEvidence, type TaskProcedure } from '../src/shared/retrospective.ts'

function inputs() {
  const evidence: ConversationEvidence = {
    version: 1, sessionId: 'audit', fromSeq: 1, throughSeq: 4, digest: 'a'.repeat(64), warnings: [],
    records: Array.from({ length: 4 }, (_, i) => ({
      id: `e${i + 1}`, seq: i + 1, kind: 'tool-result', text: 'Observed event', status: 'reported-success', truncated: false,
    })),
  }
  const procedure: TaskProcedure = {
    goal: 'Retain the observed method', parameters: [{ name: 'input', description: 'Source material' }], rules: ['Keep provenance'],
    steps: [
      { id: 's1', title: 'Read', instruction: 'Read input', dependsOn: [], evidenceRefs: ['e1'], requiresReview: false },
      { id: 's2', title: 'Write', instruction: 'Write output', dependsOn: ['s1'], evidenceRefs: ['e2'], requiresReview: true },
    ],
    excluded: [
      { evidenceRefs: ['e3'], reason: 'Intermediate output' },
      { evidenceRefs: ['e4'], reason: 'Repeated explanation' },
    ],
    reviewItems: ['Check the output each time'],
  }
  return { evidence, procedure }
}

describe('procedure audit: duplicate evidence references', () => {
  it.each([
    ['steps', 0], ['steps', 1], ['excluded', 0], ['excluded', 1],
  ] as const)('repairs only %s/%i/evidenceRefs and preserves the rest of the submission', (collection, index) => {
    const { evidence, procedure } = inputs(), valid = structuredClone(procedure)
    const refs = procedure[collection][index]!.evidenceRefs
    refs.push(refs[0]!, refs[0]!)
    const submission = { mode: 'distill', procedure, summary: 'Keep this summary' }
    const original = structuredClone(submission), path = `/procedure/${collection}/${index}/evidenceRefs`
    const compiler = createProcedureCompiler(evidence, undefined)
    const failed = compiler.submit({ submission })
    if (failed.ok) throw Error('Duplicate references accepted')
    expect(failed.feedback.status).toBe('repairable')
    expect(failed.feedback.issues).toEqual([{
      code: 'DUPLICATE_EVIDENCE_REFS', message: '步骤或排除项的证据引用重复', path, allowedPaths: [path], actualType: 'array',
    }])
    expect(failed.feedback.allowedPaths).toEqual([path])
    expect(failed.feedback.allowedPaths).not.toContain('/procedure')
    expect(failed.feedback.fragments).toEqual({ [path]: refs })
    expect(compiler.snapshot().document).toEqual(original)
    const fixed = compiler.submit({ submission: {
      mode: 'repair', draftRevision: failed.feedback.draftRevision,
      patches: [{ op: 'replace', path: failed.feedback.allowedPaths[0], value: [...new Set(refs)] }],
    } })
    if (!fixed.ok) throw Error(JSON.stringify(fixed.feedback))
    expect(JSON.parse(fixed.value.procedureJson)).toEqual(valid)
    expect(fixed.value).toMatchObject({ outcome: 'procedure', summary: original.summary, questions: [] })
    expect(compiler.snapshot().document).toEqual({ ...original, procedure: valid })
    expect(submission).toEqual(original)
    expect(parseTaskProcedure(valid, evidence)).toEqual(valid)
  })

  it('rejects edits outside the diagnosed array without changing the draft, then accepts a local removal', () => {
    const { evidence, procedure } = inputs(), valid = structuredClone(procedure)
    procedure.steps[0]!.evidenceRefs.push('e1')
    const compiler = createProcedureCompiler(evidence, undefined, { maxSubmissions: 3 })
    const failed = compiler.submit({ submission: { mode: 'distill', procedure } })
    if (failed.ok) throw Error('Duplicate references accepted')
    const before = compiler.snapshot().document
    const rejected = compiler.submit({ submission: {
      mode: 'repair', draftRevision: failed.feedback.draftRevision,
      patches: [
        { op: 'remove', path: '/procedure/steps/0/evidenceRefs/1' },
        { op: 'replace', path: '/procedure/goal', value: 'Unrequested change' },
      ],
    } })
    if (rejected.ok) throw Error('Out-of-scope repair accepted')
    expect(rejected.feedback.issues[0]!.code).toBe('PATCH_SCOPE')
    expect(rejected.feedback.allowedPaths).toEqual(failed.feedback.allowedPaths)
    expect(compiler.snapshot().document).toEqual(before)
    const fixed = compiler.submit({ submission: {
      mode: 'repair', draftRevision: rejected.feedback.draftRevision,
      patches: [{ op: 'remove', path: '/procedure/steps/0/evidenceRefs/1' }],
    } })
    if (!fixed.ok) throw Error(JSON.stringify(fixed.feedback))
    expect(JSON.parse(fixed.value.procedureJson)).toEqual(valid)
  })

  it.each(['steps', 'excluded'] as const)('keeps direct host validation throwing an Error with a relative %s path', collection => {
    const { evidence, procedure } = inputs()
    procedure[collection][1]!.evidenceRefs.push(procedure[collection][1]!.evidenceRefs[0]!)
    expect(() => parseTaskProcedure(procedure, evidence)).toThrow('步骤或排除项的证据引用重复')
    try {
      parseTaskProcedure(procedure, evidence)
      throw Error('Duplicate references accepted')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect(error).toMatchObject({ code: 'DUPLICATE_EVIDENCE_REFS', path: [collection, 1, 'evidenceRefs'] })
    }
  })

  it('allows the same event in different explanations', () => {
    const { evidence, procedure } = inputs()
    procedure.steps[1]!.evidenceRefs.push('e1')
    procedure.excluded[0]!.evidenceRefs.push('e1')
    expect(parseTaskProcedure(procedure, evidence)).toEqual(procedure)
    expect(createProcedureCompiler(evidence, undefined).submit({ submission: { mode: 'distill', procedure } }).ok).toBe(true)
  })
})

describe('procedure audit: other invalid inputs retain their validation', () => {
  const invalid: { name: string; change: (procedure: TaskProcedure) => void; message: string; code: string; path?: string }[] = [
    { name: 'missing event', change: p => { p.steps[0]!.evidenceRefs = ['e999'] }, message: '不存在', code: 'INVALID_EVIDENCE_REFS', path: '/procedure/steps/0/evidenceRefs' },
    { name: 'empty references', change: p => { p.steps[0]!.evidenceRefs = [] }, message: '至少1', code: 'INVALID_PROCEDURE_FIELDS', path: '/procedure/steps/0/evidenceRefs' },
    { name: 'duplicate step identity', change: p => { p.steps[1]!.id = 's1' }, message: '方法步骤身份重复', code: 'INVALID_CANDIDATE' },
    { name: 'duplicate parameter identity', change: p => { p.parameters.push({ ...p.parameters[0]! }) }, message: '方法参数身份重复', code: 'INVALID_CANDIDATE' },
    { name: 'missing dependency', change: p => { p.steps[1]!.dependsOn = ['missing'] }, message: '步骤依赖缺失', code: 'INVALID_CANDIDATE' },
    { name: 'dependency cycle', change: p => { p.steps[0]!.dependsOn = ['s2'] }, message: '方法步骤依赖存在循环', code: 'INVALID_CANDIDATE' },
    { name: 'unknown specification', change: p => { p.steps[0]!.specRefs = ['trialTask.task'] }, message: '不存在或重复的任务规范', code: 'INVALID_CANDIDATE' },
    { name: 'missing review items', change: p => { p.reviewItems = [] }, message: '具体复核项', code: 'INVALID_CANDIDATE' },
    { name: 'unaccounted event', change: p => { p.excluded.pop() }, message: '静默遗漏', code: 'UNCOVERED_EVIDENCE', path: '/procedure/excluded' },
  ]
  it.each(invalid)('still rejects $name', ({ change, message, code, path }) => {
    const { evidence, procedure } = inputs()
    change(procedure)
    expect(() => parseTaskProcedure(procedure, evidence)).toThrow(message)
    const failed = createProcedureCompiler(evidence, undefined).submit({ submission: { mode: 'distill', procedure } })
    if (failed.ok) throw Error('Invalid procedure accepted')
    expect(failed.feedback.issues[0]).toMatchObject({ code, ...(path ? { path } : {}) })
  })
})

describe('procedure audit: several duplicate arrays', () => {
  it('reports every duplicate array at once so one repair fits the default budget', () => {
    const { evidence, procedure } = inputs(), valid = structuredClone(procedure)
    procedure.steps[0]!.evidenceRefs.push('e1'); procedure.excluded[1]!.evidenceRefs.push('e4')
    const compiler = createProcedureCompiler(evidence, undefined)
    const failed = compiler.submit({ submission: { mode: 'distill', procedure } })
    if (failed.ok) throw Error('Duplicate references accepted')
    expect(failed.feedback.allowedPaths).toEqual(['/procedure/steps/0/evidenceRefs', '/procedure/excluded/1/evidenceRefs'])
    const fixed = compiler.submit({ submission: { mode: 'repair', draftRevision: failed.feedback.draftRevision, patches: [
      { op: 'replace', path: '/procedure/steps/0/evidenceRefs', value: ['e1'] },
      { op: 'replace', path: '/procedure/excluded/1/evidenceRefs', value: ['e4'] },
    ] } })
    if (!fixed.ok) throw Error(JSON.stringify(fixed.feedback))
    expect(JSON.parse(fixed.value.procedureJson)).toEqual(valid)
  })
})
