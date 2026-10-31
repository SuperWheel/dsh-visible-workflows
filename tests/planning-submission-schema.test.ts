import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { assertObjectJsonSchema, validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { AUTHORING_TITLE_GUIDANCE } from '../src/shared/planning-authoring-core.ts'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { CommandIntakeCompiler } from '../src/host/planning/command-intake.ts'
import { RepairSession, submissionSchema, type SubmissionCompiler } from '../src/shared/planning-repair.ts'
import { planningOneOf, submissionSchemaIssues } from '../src/shared/planning-submission-schema.ts'
import { hostRepairCheckpointSchema } from '../src/shared/planning-continuation.ts'
import { createOptimizationCompiler } from '../src/shared/planning-optimization-compiler.ts'
import { createProcedureCompiler } from '../src/shared/planning-procedure-compiler.ts'
import { planningEditDigest } from '../src/shared/planning-edits.ts'
import { templateFieldSchema } from '../src/shared/planning-node-templates.ts'
import { r12Compiler, r12Fixture, r12FixtureNames } from './fixtures/planning-compiler/r12.ts'
import { filling, templateContext } from './fixtures/planning-compiler/template.ts'

// Mirror the Host boundary with the compiler's shared budget, no model or IO effects.
function submit(compiler: SubmissionCompiler, value: unknown) {
  const issues = submissionSchemaIssues(compiler.nextSchema ?? compiler.schema, value)
  if (!issues.length) issues.push(...submissionSchemaIssues(compiler.schema, value))
  return issues.length ? compiler.rejectWire(value, issues) : compiler.submit(value)
}
function fixture(mode: 'compact-repair' | 'template-fill', edit = false) {
  const context = templateContext()
  if (edit) { context.operation = 'revise'; context.workflow.revision = 1 }
  const compiler = mode === 'compact-repair' ? new WorkflowAuthoringCompiler(context) : new TemplateFillingCompiler(context)
  let value: any
  if (edit) value = { submission: { mode: 'edit', updates: { n2: { [mode === 'compact-repair' ? 'set' : 'values']: { text: '新结果' } } }, coverage: { R1: ['n2'] } } }
  else {
    value = filling()
    if (mode === 'compact-repair') {
      value.submission.nodes = value.submission.forms.map(({ template, values, ...form }: any) => ({ ...form, kind: template, config: values }))
      delete value.submission.forms
    }
  }
  return { compiler, value }
}
function requiredPaths(schema: JsonSchemaNode, value: any, parts: (string | number)[] = []): (string | number)[][] {
  if (schema.oneOf) {
    const matching = schema.oneOf.filter(branch => !validateJsonSchemaValue(branch, value).length)
    expect(matching).toHaveLength(1)
    return requiredPaths(matching[0]!, value, parts)
  }
  if (schema.type === 'object') return [
    ...(schema.required ?? []).map(key => [...parts, key]),
    ...Object.entries(schema.properties ?? {}).flatMap(([key, child]) => Object.hasOwn(value, key) ? requiredPaths(child, value[key], [...parts, key]) : []),
  ]
  if (schema.type === 'array' && schema.items) return value.flatMap((entry: unknown, index: number) => requiredPaths(schema.items!, entry, [...parts, index]))
  return []
}
// Produce a schema-valid probe, preferring the nested intake design and repair
// branches so the SDK traverses the actual contracts advertised after failure.
function schemaProbe(schema: JsonSchemaNode): unknown {
  if (schema.oneOf) return schemaProbe(schema.oneOf.find(branch => branch.properties?.mode?.const === 'design') ?? schema.oneOf.find(branch => branch.properties?.mode?.const === 'repair') ?? schema.oneOf[0]!)
  if (Object.hasOwn(schema, 'const')) return schema.const
  if (schema.enum) return schema.enum[0]
  if (schema.type === 'object') return Object.fromEntries((schema.required ?? []).map(key => [key, schemaProbe(schema.properties![key]!)]))
  if (schema.type === 'array') return schema.items ? [schemaProbe(schema.items)] : []
  if (schema.type === 'string') return 'probe'
  if (schema.type === 'number' || schema.type === 'integer') return 1
  if (schema.type === 'boolean') return false
  return null
}
function assertAdvertisable(compiler: SubmissionCompiler) {
  for (const schema of [compiler.schema, compiler.nextSchema ?? compiler.schema]) {
    assertObjectJsonSchema(schema)
    expect(validateJsonSchemaValue(schema, schemaProbe(schema))).toEqual([])
  }
}
describe('planner submission Schema/compiler contract', () => {
  for (const mode of ['compact-repair', 'template-fill'] as const) for (const edit of [false, true]) for (const intake of [false, true]) {
    const make = () => {
      const { compiler: author, value } = fixture(mode, edit)
      return intake ? { compiler: new CommandIntakeCompiler(author, () => ({}), false), value: { submission: { mode: 'design', plan: value.submission } } } : { compiler: author, value }
    }
    it(`${mode} ${edit ? 'edit' : 'create'} ${intake ? 'intake' : 'direct'} agrees on every advertised required field`, () => {
      const { compiler, value } = make()
      for (const schema of [compiler.schema, compiler.nextSchema]) {
        assertObjectJsonSchema(schema)
        expect(validateJsonSchemaValue(schema, value)).toEqual([])
        const paths = requiredPaths(schema, value)
        expect(paths.length).toBeGreaterThan(1)
        for (const path of paths) {
          const missing = structuredClone(value)
          const parent = path.slice(0, -1).reduce((item: any, key) => item[key], missing)
          delete parent[path.at(-1)!]
          expect(validateJsonSchemaValue(schema, missing), path.join('/')).not.toEqual([])
          expect(submit(make().compiler, missing), path.join('/')).toMatchObject({ ok: false, feedback: { remainingSubmissions: 2 } })
        }
      }
      expect(submit(compiler, value).ok).toBe(true)
    })
    it(`${mode} ${edit ? 'edit' : 'create'} ${intake ? 'intake' : 'direct'} advertises SDK-supported initial and repair schemas`, () => {
      const { compiler, value } = make()
      assertAdvertisable(compiler)
      const body = intake ? value.submission.plan : value.submission
      if (edit) body.updates.n2[mode === 'compact-repair' ? 'set' : 'values'].text = '{{missing.text}}'
      else body[mode === 'compact-repair' ? 'nodes' : 'forms'][1][mode === 'compact-repair' ? 'config' : 'values'].text = '{{missing.text}}'
      expect(compiler.submit(value).ok).toBe(false)
      assertAdvertisable(compiler)
    })
  }
  it('emits an SDK-supported repair-only schema for the production optimization compiler', () => {
    const context = templateContext(), compiler = createOptimizationCompiler(context, context.workflow, { maxSubmissions: 3 })
    assertAdvertisable(compiler)
    expect(compiler.submit({ submission: { baseDigest: planningEditDigest(context.workflow), outcome: 'candidate', replacements: [] } }).ok).toBe(false)
    assertAdvertisable(compiler)
    const repair = compiler.nextSchema.properties!.submission!
    expect(repair).not.toHaveProperty('oneOf')
    expect(repair.properties!.mode).toEqual({ type: 'string', const: 'repair' })
    expect(validateJsonSchemaValue(compiler.nextSchema, { submission: { mode: 'unchanged' } })).not.toEqual([])
  })
  it('emits SDK-supported initial and repair schemas for distillation', () => {
    const evidence = { version: 1 as const, sessionId: 'recorded', fromSeq: 1, throughSeq: 1, records: [{ id: 'e1', seq: 1, kind: 'user' as const, text: 'task', status: 'statement' as const, truncated: false }], warnings: [], digest: 'a'.repeat(64) }
    const compiler = createProcedureCompiler(evidence, undefined)
    assertAdvertisable(compiler)
    expect(compiler.submit({ submission: { mode: 'distill', procedure: { goal: 'task', parameters: [], rules: [], steps: [], excluded: [], reviewItems: [] } } }).ok).toBe(false)
    assertAdvertisable(compiler)
  })
  it('collapses single selected template and nested field alternatives at their sources', () => {
    const context = templateContext();context.workflow.nodes = [];context.workflow.edges = []
    const compiler = new TemplateFillingCompiler(context, { prefetch: ['template'] })
    assertAdvertisable(compiler)
    const fields = templateFieldSchema({ type: 'object', properties: { choice: { oneOf: [{ type: 'string', const: 'kept' }] } }, required: ['choice'], additionalProperties: false })
    assertObjectJsonSchema(fields)
    expect(validateJsonSchemaValue(fields, { choice: 'kept' })).toEqual([])
    expect(validateJsonSchemaValue(fields, { choice: 'other' })).not.toEqual([])
    expect(validateJsonSchemaValue(fields, { choice: 'kept', extra: true })).not.toEqual([])
    const branch: JsonSchemaNode = { type: 'string', const: 'kept' }
    expect(planningOneOf([branch])).toEqual(branch)
    expect(() => planningOneOf([])).toThrow('不能为空')
    expect(() => templateFieldSchema({ const: 'other', oneOf: [branch] })).toThrow('不能与其他字段约束混用')
  })
  it.each(['compact-repair', 'template-fill'] as const)('requires an explicit title in %s even without the agent gate', mode => {
    const { compiler, value } = fixture(mode)
    delete value.submission.title
    const rejected = compiler.submit(value)
    expect(rejected).toMatchObject({ ok: false, feedback: { allowedPaths: ['/title'] } })
    expect(compiler.snapshot().document).not.toHaveProperty('title')
  })
  for (const mode of ['compact-repair', 'template-fill'] as const) for (const requestedTitle of [undefined, 'T23 基线：成绩分级统计']) {
    it(`${mode} shares the required ${requestedTitle ? 'requested' : 'free'} title contract between SDK and Host`, () => {
      const make = () => mode === 'template-fill' ? new TemplateFillingCompiler(templateContext(), { requestedTitle }) : new WorkflowAuthoringCompiler(templateContext(), { requestedTitle })
      const initial = make(), contract = requestedTitle === undefined ? { type: 'string' } : { type: 'string', const: requestedTitle }
      for (const schema of [initial.schema, initial.nextSchema]) {
        assertObjectJsonSchema(schema)
        const create = schema.properties!.submission!.oneOf![0]!
        expect(create.properties!.title).toEqual(contract)
        expect(create.required).toContain('title')
      }
      expect(initial.instructions).toContain(AUTHORING_TITLE_GUIDANCE)
      const good = fixture(mode).value;good.submission.title = requestedTitle ?? '模型提出的名称'
      for (const invalid of [undefined, ...(requestedTitle ? ['另一个名称'] : [])]) for (const throughGate of [true, false]) {
        const compiler = make(), value = structuredClone(good)
        if (invalid === undefined) delete value.submission.title
        else value.submission.title = invalid
        const before = structuredClone(value)
        // The Host fills only an omitted requested title; a wrong one stays for the contract to reject.
        const filled = compiler.fillKnown!(value)
        if (invalid === undefined && requestedTitle) expect(filled).toEqual({ submission: { ...value.submission, title: requestedTitle } })
        else expect(filled).toBe(value)
        const rejected = throughGate ? submit(compiler, value) : compiler.submit(value)
        expect(rejected).toMatchObject({ ok: false, feedback: { remainingSubmissions: 2, issues: [expect.objectContaining({ code: 'COMPILER_TOOL_SCHEMA_INVALID', message: expect.stringContaining('title') })] } })
        expect(value).toEqual(before)
        expect(compiler.snapshot().document).toEqual(throughGate ? undefined : expect.not.objectContaining({ title: good.submission.title }))
        // Wire rejection retains no draft; direct compiler rejection is repaired in place.
        const corrected = throughGate ? good : { submission: { mode: 'repair', draftRevision: compiler.snapshot().revision, patches: [{ op: invalid === undefined ? 'add' : 'replace', path: '/title', value: good.submission.title }] } }
        expect(submit(compiler, corrected)).toMatchObject({ ok: true, value: { candidate: { title: good.submission.title } } })
      }
      expect(submit(initial, good)).toMatchObject({ ok: true, value: { candidate: { title: good.submission.title } } })
    })
    it(`${mode} ignores requestedTitle for EDIT`, () => {
      const context = templateContext();context.operation = 'revise';context.workflow.revision = 1
      const compiler = mode === 'template-fill' ? new TemplateFillingCompiler(context, { requestedTitle }) : new WorkflowAuthoringCompiler(context, { requestedTitle })
      const plain = mode === 'template-fill' ? new TemplateFillingCompiler(context) : new WorkflowAuthoringCompiler(context)
      expect(compiler.schema).toEqual(plain.schema);expect(compiler.nextSchema).toEqual(plain.nextSchema)
      expect(compiler.instructions).toBe(plain.instructions)
      const value = fixture(mode, true).value;value.submission.title = '明确修改的名称'
      const untitled = structuredClone(value);delete untitled.submission.title
      expect(compiler.fillKnown!(untitled)).toBe(untitled)
      expect(submit(compiler, value)).toMatchObject({ ok: true, value: { candidate: { title: '明确修改的名称' } } })
    })
  }
  it('replays verbatim r11/r14 grade-stat submissions with the requested title contract', () => {
    const title = 'T23 基线：成绩分级统计'
    for (const run of ['r11', 'r14']) {
      const bytes = readFileSync(new URL(`./fixtures/planning-compiler/t23-${run}-rejected-args.json`, import.meta.url))
      if (run === 'r14') {
        expect(createHash('sha256').update(bytes).digest('hex')).toBe('0d6e6c606de44da3fdaa08e9a5e78057d8d4ad3d5c60eac23e6a67b3e40fb978')
        const session = new URL('../.test-data/t23/r14/731943eb-e535-4030-8ee9-72035f7eae97.jsonl', import.meta.url)
        if (existsSync(session)) {
          const event = readFileSync(session, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).find(row => row.seq === 15)
          expect(bytes.toString()).toBe(event.data.arguments)
        }
      }
      const original = JSON.parse(bytes.toString()), before = structuredClone(original)
      const compiler = new TemplateFillingCompiler(templateContext(), { requestedTitle: title })
      compiler.queryTemplates(['input', 'code', 'template', 'output'])
      expect(submit(compiler, original)).toMatchObject({ ok: false, feedback: { draftRevision: 0, remainingSubmissions: 2, issues: [expect.objectContaining({ code: 'COMPILER_TOOL_SCHEMA_INVALID', message: expect.stringContaining('value.submission.title') })] } })
      expect(compiler.snapshot().document).toBeUndefined()
      const corrected = structuredClone(original);corrected.submission.title = title
      expect(submit(compiler, corrected)).toMatchObject({ ok: true, value: { candidate: { title } } })
      expect(original).toEqual(before)
    }
  })
  it.each([
    { mode: 'request', request: { execution: { mode: 'execute-first' } } },
    { mode: 'return-to-main', reason: '需要定位已有图' },
    { mode: 'needs-input', questions: [{ id: 'format', question: '输出格式？' }] },
  ])('checks every required field of intake route $mode', submission => {
    const make = () => new CommandIntakeCompiler(fixture('template-fill').compiler, () => ({ execution: { mode: 'execute-first' } }), false)
    const compiler = make(), value = { submission }
    expect(validateJsonSchemaValue(compiler.schema, value)).toEqual([])
    for (const path of requiredPaths(compiler.schema, value)) {
      const missing: any = structuredClone(value)
      const parent = path.slice(0, -1).reduce((item: any, key) => item[key], missing)
      delete parent[path.at(-1)!]
      expect(submit(make(), missing), path.join('/')).toMatchObject({ ok: false, feedback: { remainingSubmissions: 2 } })
    }
    expect(submit(compiler, value).ok).toBe(true)
  })
  it('keeps the SDK exact-oneOf rule even when multiple branches individually validate', () => {
    const issues = submissionSchemaIssues({ oneOf: [{ type: 'object' }, { type: 'object' }] }, {})
    expect(issues).toEqual([expect.objectContaining({ message: expect.stringContaining('matched 2') })])
  })
  it('replays the verbatim r11 arguments against the recorded SDK schema with actionable title feedback', () => {
    const original = JSON.parse(readFileSync(new URL('./fixtures/planning-compiler/t23-r11-rejected-args.json', import.meta.url), 'utf8'))
    const tool = JSON.parse(readFileSync(new URL('./fixtures/planning-compiler/t23-r11-structured-output-tool.json', import.meta.url), 'utf8'))
    const compiler = new TemplateFillingCompiler(templateContext())
    compiler.queryTemplates(['input', 'code', 'template'])
    expect(validateJsonSchemaValue(tool.parameters, original)).toEqual([expect.stringContaining('oneOf')])
    const issues = submissionSchemaIssues(tool.parameters, original)
    expect(issues).toContainEqual(expect.objectContaining({ code: 'COMPILER_TOOL_SCHEMA_INVALID', message: expect.stringContaining('value.submission.title') }))
    expect(compiler.rejectWire(original, issues)).toMatchObject({ ok: false, feedback: { draftRevision: 0, remainingSubmissions: 2 } })
    expect(compiler.snapshot().document).toBeUndefined()
    const corrected = structuredClone(original);corrected.submission.title = '成绩分级'
    expect(validateJsonSchemaValue(tool.parameters, corrected)).toEqual([])
    const accepted = submit(compiler, corrected)
    expect(accepted).toMatchObject({ ok: true, value: { candidate: { title: '成绩分级' } } })
    expect(original.submission).not.toHaveProperty('title')
    expect(compiler.snapshot().submissions).toBe(2)
  })
  it('preserves verbatim r12 evidence and diagnoses only the selected mode/op/path', () => {
    const hashes: Record<string, string> = {
      "initial-args": "426644f58a42e0299b46279d3b49f1017eba7c446cb21740c54fa39332b483da",
      "feedback": "5102b61b4ee2c444b1451bc2800d1cedf466c79440c0677f8c62fb114b4ea048",
      "repair-rejected-args": "f21460e776e3c6cbf63f994b8c2bd357d8e0a4122c6524772826253b7c3741ad",
      "repair-structured-output-tool": "acc6357df23b7d77e0e2d69d42d8ed5e2c3e5137a57145038807ff4577f9c6e8"
}
    for (const name of r12FixtureNames) {
      const copy = readFileSync(new URL(`./fixtures/planning-compiler/t23-r12-${name}.json`, import.meta.url))
      const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
      expect(digest(copy)).toBe(hashes[name])
      const original = new URL(`../.test-data/t23/r12-${name}.json`, import.meta.url)
      if (existsSync(original)) expect(digest(copy)).toBe(digest(readFileSync(original)))
    }
    const tool = r12Fixture('repair-structured-output-tool'), wire = r12Fixture('repair-rejected-args')
    const issues = submissionSchemaIssues(tool.parameters, wire)
    expect(issues.length).toBeGreaterThan(0); expect(issues.length).toBeLessThanOrEqual(8)
    const messages = issues.map(issue => issue.message).join('\n')
    expect(messages).toContain('value.submission.patches[0].value.approvedMsg')
    expect(messages).not.toMatch(/must be "(?:add|remove|needs-input)"|oneOf\[|questions/)
    const outside = structuredClone(wire)
    outside.submission.patches = [{ op: 'replace', path: '/outside', value: 1 }, { op: 'add', path: '/other', value: 2 }]
    const denied = submissionSchemaIssues(tool.parameters, outside)
    expect(denied).toHaveLength(2)
    expect(denied.map(issue => issue.message).join('\n').match(/allowed paths:/g)).toHaveLength(1)
    expect(denied[0]!.message).toContain('op/path pair')
    const noisy = structuredClone(wire)
    noisy.submission.patches[0].value = Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['fresh' + i, {}]))
    expect(submissionSchemaIssues(tool.parameters, noisy)).toHaveLength(8)
  })
  it('lets the r12 repair reach the real compiler and retain its own review feedback', () => {
    const compiler = r12Compiler(), initial = submit(compiler, r12Fixture('initial-args'))
    expect(initial.ok).toBe(false)
    if (initial.ok) throw Error('expected r12 review feedback')
    const recorded = JSON.parse(r12Fixture('feedback')[0].message.content[0].text)
    // r12 has no draft read and its target existence test is only paths.not_empty.
    const writePaths=['/formsByKey/writeDraftFile/values/inputs/file_path','/formsByKey/writeTarget/values/inputs/file_path']
    expect(initial.feedback.issues.map(issue => [issue.code, issue.path])).toEqual([
      ...writePaths.map(path=>['FILE_WRITE_NEEDS_READ',path]),
      ...recorded.issues.map((issue: any) => [issue.code, issue.path]),
    ])
    expect(initial.feedback.issues.slice(0,2).map(issue=>issue.nodeId)).toEqual(['allocated-6','allocated-11'])
    // New diagnostics reorder the same repair roots; only T24's /modules root is added.
    expect(initial.feedback.allowedPaths.filter(path=>path!=='/modules').sort()).toEqual([...recorded.allowedPaths].sort())
    expect(initial.feedback.allowedPaths).toContain('/modules')
    const wire = r12Fixture('repair-rejected-args')
    assertObjectJsonSchema(compiler.nextSchema)
    expect(submissionSchemaIssues(compiler.nextSchema, wire)).toEqual([])
    const compiled = vi.spyOn(compiler, 'submit'), rejected = vi.spyOn(compiler, 'rejectWire')
    const second = submit(compiler, wire)
    expect(compiled).toHaveBeenCalledOnce(); expect(rejected).not.toHaveBeenCalled()
    expect(second).toMatchObject({ ok: false, feedback: { draftRevision: 2, remainingSubmissions: 1 } })
    if (second.ok) throw Error('expected compiler review feedback')
    expect(second.feedback.issues.map(issue=>[issue.code,issue.path])).toEqual([
      ...writePaths.map(path=>['FILE_WRITE_NEEDS_READ',path]),
      ...recorded.issues.map((issue:any)=>[issue.code,issue.path]),
      ['REVIEW_BEFORE_EFFECT','/formsByKey/writeTarget/values/inputs/file_path'],
    ])
    expect(second.feedback.issues.slice(0,2).map(issue=>issue.nodeId)).toEqual(['allocated-6','allocated-11'])
    expect((compiler.snapshot().document as any).formsByKey).toHaveProperty('approvedMsg')
  })
  for (const mode of ['compact-repair', 'template-fill'] as const) for (const edit of [false, true]) {
    it(`${mode} ${edit ? 'edit' : 'create'} compiler-accepted object extensions and descendant patches pass the advertised repair contract`, () => {
      for (let index = 0; index < 6; index++) for (const descendant of [false, true]) {
        const context = templateContext()
        if (edit) { context.operation = 'revise'; context.workflow.revision = 1 }
        const compiler = mode === 'compact-repair' ? new WorkflowAuthoringCompiler(context) : new TemplateFillingCompiler(context)
        const form = mode === 'template-fill', list = form ? 'forms' : 'nodes', root = `/${edit ? 'add' + (form ? 'Forms' : 'Nodes') : list}ByKey`
        const key = `generated${index}`, bad = 'bad key', body = form ? { template: 'template', values: { text: 'new' } } : { kind: 'template', config: { text: 'new' } }
        const wire: any = edit ? { submission: { mode: 'edit', [form ? 'addForms' : 'addNodes']: [{ key: bad, ...body }], addLinks: [{ key: 'incoming', source: 'n1', target: key }, { key: 'outgoing', source: key, target: 'n2' }], coverage: { R1: [key] } } } : filling()
        if (!edit) {
          if (!form) { wire.submission.nodes = wire.submission.forms.map(({ template, values, ...item }: any) => ({ ...item, kind: template, config: values })); delete wire.submission.forms }
          wire.submission[list][1].key = bad
          wire.submission.chains[0].nodes[1] = key
          wire.submission[list][2][form ? 'values' : 'config'].text = `{{${key}.text}}`
          wire.submission.coverage.R1[0] = key
        }
        const rows = wire.submission[edit ? (form ? 'addForms' : 'addNodes') : list]
        wire.submission[root.slice(1)] = Object.fromEntries(rows.map(({ key, ...entry }: any) => [key, entry]))
        delete wire.submission[edit ? (form ? 'addForms' : 'addNodes') : list]
        const first = compiler.submit(wire)
        expect(first.ok).toBe(false)
        if (first.ok) throw Error('expected invalid record key')
        expect(first.feedback.allowedPaths).toContain(root)
        const current = structuredClone(compiler.snapshot().document as any)[root.slice(1)]
        const replacement = { ...current, [key]: current[bad] }; delete replacement[bad]
        const patches = descendant ? [{ op: 'remove', path: `${root}/${bad}` }, { op: 'add', path: `${root}/${key}`, value: current[bad] }] : [{ op: 'replace', path: root, value: replacement }]
        const repair = { submission: { mode: 'repair', draftRevision: first.feedback.draftRevision, patches } }
        assertObjectJsonSchema(compiler.nextSchema)
        expect(submissionSchemaIssues(compiler.nextSchema, repair), JSON.stringify(repair)).toEqual([])
        const compile = vi.spyOn(compiler, 'submit'), rejectWire = vi.spyOn(compiler, 'rejectWire')
        expect(submit(compiler, repair).ok).toBe(true)
        expect(compile).toHaveBeenCalledOnce(); expect(rejectWire).not.toHaveBeenCalled()
      }
    })
  }
  it('uses draft shapes only as hints, including empty arrays and changes of scalar/object types', () => {
    for (const old of [42, { oldKey: 'old', nested: { old: true } }, [], ['old']]) for (const value of [{ newKey: { nested: true } }, [], [1, { newKey: true }], 'correct', null]) {
      if (JSON.stringify(old) === JSON.stringify(value)) continue
      const c = new RepairSession(submissionSchema({ type: 'object', properties: { value: {} }, required: ['value'] }), { maxSubmissions: 3, roots: () => ['/value'], compile: doc => { if (JSON.stringify(doc.value) === JSON.stringify(old)) throw Error('repair'); return doc } })
      c.submit({ submission: { value: old } })
      const repair = { submission: { mode: 'repair', draftRevision: 1, patches: [{ op: 'replace', path: '/value', value }] } }
      expect(submissionSchemaIssues(c.nextSchema, repair)).toEqual([])
      expect(submit(c, repair).ok).toBe(true)
    }
  })
  it('charges wire rejection to the existing budget, never invokes compile/unique repair, and restores the budget', () => {
    const compile = vi.fn(() => 'accepted'), uniqueRepair = vi.fn()
    const options = { maxSubmissions: 3, resumeScope: 'test', contractDigest: 'a'.repeat(64), roots: () => ['/title'], compile, uniqueRepair }
    const schema = submissionSchema({ type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false })
    const compiler = new RepairSession(schema, options)
    expect(submit(compiler, { submission: {} })).toMatchObject({ ok: false, feedback: { remainingSubmissions: 2 } })
    const checkpoint = hostRepairCheckpointSchema.parse(compiler.checkpoint())
    expect(checkpoint).toMatchObject({ state: 'clarification', submissions: 1, revision: 0 })
    expect(checkpoint).not.toHaveProperty('document')
    const resumed = new RepairSession(schema, { ...options, resume: checkpoint })
    expect(submit(resumed, { submission: { title: 42 } })).toMatchObject({ ok: false, feedback: { remainingSubmissions: 1 } })
    expect(submit(resumed, { submission: {}, unexpected: true })).toMatchObject({ ok: false, feedback: { remainingSubmissions: 0 } })
    expect(() => submit(resumed, { submission: { title: 'explicit' } })).toThrow('上限')
    expect(compile).not.toHaveBeenCalled();expect(uniqueRepair).not.toHaveBeenCalled()
  })
  it('keeps intake route rejections within the outer three submissions without spending the nested author budget', () => {
    const { compiler: author } = fixture('template-fill'), validate = vi.fn(() => ({}))
    const intake = new CommandIntakeCompiler(author, validate, false)
    for (let i = 0; i < 3; i++) expect(submit(intake, { submission: { mode: 'return-to-main' } })).toMatchObject({ ok: false, feedback: { remainingSubmissions: 2 - i } })
    expect(() => submit(intake, { submission: { mode: 'return-to-main', reason: '结束' } })).toThrow('三次')
    expect(author.snapshot().submissions).toBe(0);expect(validate).not.toHaveBeenCalled()
  })
})
