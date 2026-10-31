import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { cases, contextFor, oracle } from '../scripts/benchmarks/workflow-compiler.ts'
import { WorkflowAuthoringCompiler } from '../src/shared/planning-authoring.ts'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { allNodes } from '../src/shared/workflow-validation.ts'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

// Verbatim submissions/feedback extracted from the immutable T09 journals.
// Provenance (path, SHA-256 and 1-based result line) travels with each fixture.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/t10-authoring/submissions.json', import.meta.url), 'utf8')) as any[]
const fixture = (arm: string, repeat: number, caseId = 'container') => fixtures.find(f => f.arm === arm && f.repeat === repeat && f.caseId === caseId)!
// The one failure left after the first T10 fix, from the rerun journal at e1b6057.
const rerunFailures = JSON.parse(readFileSync(new URL('./fixtures/t10-authoring/rerun-edge-scope.json', import.meta.url), 'utf8')) as any[]
// Template edit failures from the layered-chain rerun at 6fdac64: a config field beside values.
const misplacedFailures = JSON.parse(readFileSync(new URL('./fixtures/t10-authoring/layered-edit-misplaced-field.json', import.meta.url), 'utf8')) as any[]
// Compact branch r2 from the same rerun: a scaffold alias collision followed by five capped requests.
const aliasRunaway = JSON.parse(readFileSync(new URL('./fixtures/t10-authoring/layered-alias-runaway.json', import.meta.url), 'utf8'))
const compilerFor = (f: any) => {
  const context = contextFor(cases.find(c => c.id === f.caseId)!)
  const compiler = f.arm === 'template-fill' ? new TemplateFillingCompiler(context) : new WorkflowAuthoringCompiler(context)
  if (compiler instanceof TemplateFillingCompiler) compiler.queryTemplates(['input', 'output', 'template', 'iteration'])
  return compiler
}
const failed = (result: ReturnType<WorkflowAuthoringCompiler['submit']>) => {
  if (result.ok) throw Error('Expected rejected draft')
  return result.feedback
}
const repair = (compiler: ReturnType<typeof compilerFor>, patches: any[]) => compiler.submit({ submission: { mode: 'repair', draftRevision: compiler.snapshot().revision, patches } })
async function passes(result: ReturnType<WorkflowAuthoringCompiler['submit']>, caseId = 'container') {
  if (!result.ok) throw Error(JSON.stringify(result.feedback))
  const flow = result.value.candidate!
  const checked = await oracle(flow, cases.find(c => c.id === caseId)!)
  expect(checked.passed, JSON.stringify(checked)).toBe(true)
  expect(checked.results.length).toBeGreaterThan(0)
  expect(checked.probeResults.length).toBeGreaterThan(0)
  return { flow, output: result.value.output }
}
function addBodyChain(compiler: ReturnType<typeof compilerFor>, container: string, inner: string, chain = 'repair1') {
  const patches = [{ op: 'add', path: `/chainsByKey/${chain}`, value: { container, nodes: [inner] } }]
  expect(() => assertSupportedJsonSchema(compiler.nextSchema)).not.toThrow()
  expect(validateJsonSchemaValue(compiler.nextSchema, { submission: { mode: 'repair', draftRevision: compiler.snapshot().revision, patches } })).toEqual([])
  return repair(compiler, patches)
}

describe('T10 exact T09 journal regressions (offline, production compilers and oracle)', () => {
  it('template r0: legacy singleton chain feedback exposes container-chain repair and whole-chain deletion', async () => {
    const f = fixture('template-fill', 0), compiler = compilerFor(f)
    const first = failed(compiler.submit(f.submissionsLog[0]))
    expect(f.feedback[0].issues[0].message).toContain('>=2')
    expect(first.allowedPaths).toContain('/chainsByKey/inner-line')
    expect(JSON.stringify(compiler.nextSchema)).toContain('container')
    expect(first.issues.some(i => i.message.includes('Host 自动'))).toBe(true)
    // Replay the exact second submission: deleting only nodes leaves an empty chain.
    const second = failed(compiler.submit(f.submissionsLog[1]))
    expect(second.allowedPaths).toContain('/chainsByKey/inner-line')
    // Replay the exact third submission: removing the optional chain must not
    // leave a dangling /chainsByKey/inner-line/nodes repair obligation.
    const third = failed(compiler.submit(f.submissionsLog[2]))
    expect(third.issues.some(i => i.code === 'PATCH_SCOPE')).toBe(false)
    expect(third.allowedPaths).not.toContain('/chainsByKey/inner-line/nodes')
    expect(third.issues.some(i => i.code === 'CONTAINER_ENTRY')).toBe(true)
    expect(() => repair(compiler, [])).toThrow('上限')
    const fresh = compilerFor(f)
    fresh.submit(f.submissionsLog[0])
    const accepted = await passes(addBodyChain(fresh, 'iterateItems', 'generateItemLine', 'inner-line'))
    expect(accepted.output.requirementCoverage[0]!.nodeIds).toContain(allNodes(accepted.flow).find(n => n.kind === 'template')!.id)
  })

  for (const repeat of [0, 1]) it(`compact r${repeat}: exact body rejection; one bounded flattening repair compiles and passes oracle`, async () => {
    const f = fixture('compact-repair', repeat), compiler = compilerFor(f)
    const first = failed(compiler.submit(f.submissionsLog[0]))
    const original = f.submissionsLog[0].submission
    const container = original.nodes.find((n: any) => n.kind === 'iteration')
    const body = container.config.body
    expect(first.issues[0]!.code).toBe('CONTAINER_BODY_AUTHORING')
    expect(first.issues[0]!.message).toContain(`scope=["${container.key}"]`)
    expect(first.allowedPaths).toContain(`/nodesByKey/${body.nodes[1].id}`)
    const config = { ...container.config }; delete config.body
    const patches = [
      { op: 'replace', path: `/nodesByKey/${container.key}/config`, value: config },
      ...body.nodes.map(({ id, ...node }: any) => ({ op: 'add', path: `/nodesByKey/${id}`, value: { ...node, scope: [container.key] } })),
      { op: 'add', path: '/chainsByKey/repair1', value: { nodes: body.nodes.map((n: any) => n.id) } },
      { op: 'replace', path: '/coverage/R1', value: [...new Set([...original.coverage.R1, ...body.nodes.map((n: any) => n.id)])] },
    ]
    // All repair paths and value fields are discoverable through the next tool schema.
    const schema = JSON.stringify(compiler.nextSchema)
    expect(schema).toContain(`/nodesByKey/${body.nodes[1].id}`)
    expect(schema).toContain('scope')
    expect(() => assertSupportedJsonSchema(compiler.nextSchema)).not.toThrow()
    expect(validateJsonSchemaValue(compiler.nextSchema, { submission: { mode: 'repair', draftRevision: 1, patches } })).toEqual([])
    const accepted = await passes(repair(compiler, patches))
    const innerId = allNodes(accepted.flow).find(n => n.kind === 'template' && n.config.text === '项：{{item}}')!.id
    expect(accepted.output.requirementCoverage[0]!.nodeIds).toContain(innerId)
    expect(compiler.snapshot().submissions).toBe(2)
    // A forbidden, malformed raw body is still a diagnostic, never a crash in
    // the feedback generator or an implicitly accepted nested graph.
    for (const body of [{ nodes: 'wrong' }, { nodes: [null] }]) {
      const malformed = structuredClone(f.submissionsLog[0])
      malformed.submission.nodes.find((n: any) => n.kind === 'iteration').config.body = body
      expect(failed(compilerFor(f).submit(malformed)).issues[0]!.code).toBe('CONTAINER_BODY_AUTHORING')
    }
  })

  for (const repeat of [0, 1]) it(`compact r${repeat}: exact removal of body reports addressable missing children instead of /nodes dead end`, () => {
    const f = fixture('compact-repair', repeat), compiler = compilerFor(f)
    compiler.submit(f.submissionsLog[0])
    const second = failed(compiler.submit(f.submissionsLog[1]))
    expect(second.issues.some(i => i.code === 'CONTAINER_ENTRY')).toBe(true)
    expect(second.allowedPaths).toContain('/chainsByKey/repair1')
    expect(second.issues.find(i => i.code === 'CONTAINER_ENTRY')!.message).toContain('不要手写 repairNode 入口')
    expect(second.issues.some(i => i.path === '/nodes')).toBe(false)
    const third = failed(compiler.submit(f.submissionsLog[2]))
    expect(third.remainingSubmissions).toBe(0)
  })

  for (const repeat of [1, 2]) it(`template r${repeat}: exact bad chain metadata then container-chain repair; preserve original map`, async () => {
    const f = fixture('template-fill', repeat), compiler = compilerFor(f)
    expect(failed(compiler.submit(f.submissionsLog[0])).issues[0]!.message).toContain('description')
    const second = failed(compiler.submit(f.submissionsLog[1]))
    expect(second.issues.some(i => i.code === 'CONTAINER_ENTRY')).toBe(true)
    expect(second.allowedPaths).not.toContain('/formsByKey')
    expect(second.allowedPaths).not.toContain('/chainsByKey')
    expect(JSON.stringify(compiler.nextSchema)).toContain('"template"')
    const original = f.submissionsLog[0].submission
    const container = original.forms.find((n: any) => n.template === 'iteration')
    const inner = original.forms.find((n: any) => n.scope?.[0] === container.key)
    await passes(addBodyChain(compiler, container.key, inner.key))
    // The exact r2 third submission overwrites the entire forms/chains maps;
    // targeted feedback now rejects it without destroying surviving declarations.
    if (repeat === 2) {
      const replay = compilerFor(f)
      replay.submit(f.submissionsLog[0]); replay.submit(f.submissionsLog[1])
      const before = replay.snapshot().document
      expect(failed(replay.submit(f.submissionsLog[2])).issues[0]!.code).toBe('PATCH_SCOPE')
      expect(replay.snapshot().document).toEqual(before)
    }
  })

  it('compact r2: T26 preserves descriptions and repairs only the still-invalid chain scope', async () => {
    const f = fixture('compact-repair', 2), compiler = compilerFor(f)
    const first=failed(compiler.submit(f.submissionsLog[0]))
    expect(first.issues).toHaveLength(1);expect(first.issues[0]!.path).toBe('/chainsByKey/inner-flow')
    const result=await passes(repair(compiler,f.submissionsLog[1].submission.patches.filter((patch:any)=>patch.path==='/chainsByKey/inner-flow')))
    expect(allNodes(result.flow).some(node=>node.note)).toBe(true)
  })

  it('web-process: T26 accepts original descriptions on the first submission and passes oracle', async () => {
    const f = fixture('compact-repair', 1, 'web-process'), compiler = compilerFor(f)
    expect(f.feedback[1].issues[0].code).toBe('DUPLICATE_KEY')
    const result=await passes(compiler.submit(f.submissionsLog[0]), 'web-process')
    expect(allNodes(result.flow).some(node=>node.note)).toBe(true)
  })

  it('branch layered r2: the first create submission with start/n1/n2/n3 compiles and passes oracle', async () => {
    const f = aliasRunaway, compiler = compilerFor(f)
    expect(f.feedback[0].issues[0].code).toBe('DUPLICATE_KEY')
    await passes(compiler.submit(f.submissionsLog[0]), 'branch')
  })
  it('template rerun r1: a cross-scope link is named by path so removing it compiles and passes oracle', async () => {
    const f = rerunFailures.find(r => r.arm === 'template-fill' && r.repeat === 1)!, compiler = compilerFor(f)
    expect(f.feedback[2].issues[0].code).toBe('EDGE_SCOPE')
    expect(f.feedback[2].issues[0].path).toBeUndefined()
    failed(compiler.submit(f.submissionsLog[0]))
    // The link is reported with the container entry, so one repair round can fix both.
    const second = failed(compiler.submit(f.submissionsLog[1]))
    expect(f.feedback[1].issues.map((i: any) => i.code)).toEqual(['CONTAINER_ENTRY'])
    expect(second.issues.map(i => i.code).sort()).toEqual(['CONTAINER_ENTRY', 'EDGE_SCOPE', 'LINK_PORT_REQUIRED', 'NODE_SCOPE_MISMATCH'])
    expect(second.allowedPaths).toContain('/linksByKey/inner-entry')
    const third = failed(compiler.submit(f.submissionsLog[2]))
    expect(third.issues.map(i => i.code)).toEqual(['LINK_PORT_REQUIRED', 'EDGE_SCOPE'])
    expect(third.issues.find(i => i.code === 'EDGE_SCOPE')!.path).toBe('/linksByKey/inner-entry')
    expect(third.issues.find(i => i.code === 'EDGE_SCOPE')!.message).toContain('start(scope=[]) → fmt(scope=["iter"])')
    expect(third.allowedPaths).toContain('/linksByKey/inner-entry')
    // The same third submission plus removing the named link fits the three-submit cap.
    const fresh = compilerFor(f)
    fresh.submit(f.submissionsLog[0]); fresh.submit(f.submissionsLog[1])
    await passes(repair(fresh, [...f.submissionsLog[2].submission.patches, { op: 'remove', path: '/linksByKey/inner-entry' }]))
  })
  for (const caseId of ['local-edit', 'large-edit']) it(`template ${caseId}: a field written beside values is moved into values and passes oracle`, async () => {
    const f = misplacedFailures.find(r => r.caseId === caseId)!, compiler = compilerFor(f)
    const target = Object.keys(f.submissionsLog[0].submission.updates)[0]!, path = `/updates/${target}`
    expect(f.feedback[0].allowedPaths).toEqual([`${path}/text`])
    // T26 records a scoped Host repair and charges the same submission budget.
    failed(compiler.submit(f.submissionsLog[0]))
    const repaired=compiler.repairUnique();expect(repaired).toBeDefined()
    await passes(repaired!, caseId)
    expect(compiler.snapshot().submissions).toBe(2)
  })
})
