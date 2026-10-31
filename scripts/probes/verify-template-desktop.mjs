#!/usr/bin/env node
// Read-only acceptance verification. Never runs a workflow, model or business tool.
// Only the independently named evidence output is written (exclusive creation).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const defaultEvidence = path.join(repo, 'docs/evidence/template-fill-desktop-20261019')
const names = ['primary', 'holdout', 'revised', 'invalid', 'recovery']
const usage = `Read-only template-fill Desktop verification

node scripts/probes/verify-template-desktop.mjs --case primary|holdout|revised|invalid|recovery
  [--evidence-dir DIR] [--run-id ID] [--source-run-id ID]
  [--source-baseline FILE] [--out NEW_FILE]

Reads DIR/cases.json, workflows.json, graphon-runs.json, and the explicitly
declared independent tmp workspace output file. It never executes business work.
--run-id selects one exact run when matching inputs have several historical runs.
--source-run-id pins the expected failed source for recovery (optional).
--source-baseline is required to prove source immutability before recovery passes.
It accepts a prior graphon-runs.json snapshot, a single run, or this script's
sourceSnapshot/runSnapshot evidence. Capture the failed source BEFORE recovery.
With only a failed recovery source present, the script returns pending and includes
sourceSnapshot for a later --source-baseline comparison.
--out must not exist. Otherwise a timestamp + UUID evidence file is created in DIR.
Exit status: 0 passed; 2 pending (not run, unfinished, or missing proof); 1 failed.
Nonempty lines are compared exactly in order/count after trimming each line.
File SHA-256 must equal the actual write argument AND template text SHA-256.
No successful verdict is written for an absent artifact or unexecuted run.
`
const sha = value => crypto.createHash('sha256').update(value).digest('hex')
const canonical = value => JSON.stringify(order(value))
function order(value) { return Array.isArray(value) ? value.map(order) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, order(item)])) : value }
const equal = (left, right) => canonical(left) === canonical(right)
const lines = text => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
const withoutEvents = run => { const { events: _, ...snapshot } = run; return snapshot }
function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') return { help: true }
    const key = argv[i]
    if (!['--case', '--evidence-dir', '--run-id', '--source-run-id', '--source-baseline', '--out'].includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Invalid argument: ${key}; use --help`)
    if (options[key] !== undefined) throw new Error(`Duplicate argument: ${key}`)
    options[key] = argv[++i]
  }
  if (!names.includes(options['--case'])) throw new Error('--case is required; use --help')
  return options
}
function regular(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected regular non-symlink file: ${file}`)
  return stat
}
function readJson(file) { regular(file); return JSON.parse(fs.readFileSync(file, 'utf8')) }
function absent(file) { try { fs.lstatSync(file); return false } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return true; throw error } }
function safeArtifact(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe artifact path in cases.json')
  const target = path.resolve(root, relative)
  for (let current = root; current !== target;) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Artifact path traverses symlink: ${current}`) } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error }
    const rest = path.relative(current, target).split(path.sep); current = path.join(current, rest[0])
  }
  if (!absent(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Artifact is a symlink')
  return target
}
function bindings(run, spec, root) {
  const entries = Object.entries(run.inputs ?? {})
  const records = entries.filter(([, value]) => { try { return typeof value === 'string' && equal(JSON.parse(value), spec.records) } catch { return false } })
  const thresholds = entries.filter(([, value]) => typeof value === 'string' && value.trim() !== '' && Number(value) === spec.threshold)
  const outputs = entries.filter(([, value]) => typeof value === 'string' && value && path.resolve(root, value) === path.resolve(root, spec.outputPath))
  if ([records, thresholds, outputs].some(group => group.length !== 1)) return undefined
  const keys = [records[0][0], thresholds[0][0], outputs[0][0]]
  return new Set(keys).size === 3 ? { records: keys[0], threshold: keys[1], outputPath: keys[2] } : undefined
}
function runFromBaseline(value, id) {
  if (Array.isArray(value)) return value.find(run => run.id === id)
  if (value?.sourceSnapshot?.id === id) return value.sourceSnapshot
  if (value?.runSnapshot?.id === id) return value.runSnapshot
  if (value?.id === id) return value
  if (Array.isArray(value?.runs)) return value.runs.find(run => run.id === id)
}

function verify(options) {
  const dir = path.resolve(options['--evidence-dir'] ?? defaultEvidence), caseName = options['--case']
  const result = { schemaVersion: 1, checkedAt: new Date().toISOString(), case: caseName, verdict: 'pending', passed: false, checks: [], inputs: {}, limitations: ['Host/Graphon execution records and artifact bytes are inspected; no syscall tracing or independent model audit is claimed.'] }
  const check = (name, pass, detail) => { result.checks.push({ name, status: pass ? 'passed' : 'failed', ...(detail === undefined ? {} : { detail }) }); return pass }
  const pending = (name, detail) => result.checks.push({ name, status: 'pending', detail })
  const finish = () => { result.verdict = result.checks.some(item => item.status === 'failed') ? 'failed' : result.checks.some(item => item.status === 'pending') ? 'pending' : 'passed'; result.passed = result.verdict === 'passed'; return result }
  try {
    const files = ['cases.json', 'workflows.json', 'graphon-runs.json']
    if (files.some(file => absent(path.join(dir, file)))) { pending('evidenceSnapshots', 'cases.json, workflows.json and graphon-runs.json must all exist'); return finish() }
    const [cases, workflows, runs] = files.map(file => { const full = path.join(dir, file), raw = fs.readFileSync(full); regular(full); result.inputs[file] = { path: full, sha256: sha(raw) }; return JSON.parse(raw.toString('utf8')) })
    if (!Array.isArray(workflows) || !Array.isArray(runs)) throw new Error('workflows.json and graphon-runs.json must be arrays')
    const spec = caseName === 'invalid' ? cases.invalidCase : caseName === 'recovery' ? cases.recoveryCase : cases.cases?.find(item => item.name === caseName)
    if (!spec || !Array.isArray(spec.records) || !Number.isFinite(spec.threshold)) throw new Error('Missing/invalid case specification')
    const root = path.resolve(cases.workspace), temporaryRoots = [...new Set(['/private/tmp', fs.realpathSync(os.tmpdir())])]
    if (!path.isAbsolute(cases.workspace) || !temporaryRoots.some(base => root.startsWith(base + path.sep)) || fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory()) throw new Error('Expected a real independent tmp workspace, without symbolic-link root')
    const artifact = safeArtifact(root, spec.outputPath); result.workspace = root; result.expected = spec; result.artifact = { path: artifact, exists: !absent(artifact) }
    const owned = new Map(workflows.filter(flow => typeof flow.title === 'string' && flow.title.startsWith(cases.workflowTitle)).map(flow => [flow.id, flow]))
    if (!owned.size) { pending('savedWorkflow', 'No saved acceptance workflow in workflows.json'); return finish() }
    check('uniqueRunIds', new Set(runs.map(run => run.id)).size === runs.length)
    let matching = runs.filter(run => owned.has(run.workflowId) && bindings(run, spec, root))
    if (options['--run-id']) matching = matching.filter(run => run.id === options['--run-id'])
    if (caseName === 'recovery') matching = matching.filter(run => !!run.sourceRunId)
    if (!matching.length) {
      if (caseName === 'recovery') {
        const sources = runs.filter(run => owned.has(run.workflowId) && !run.sourceRunId && bindings(run, spec, root) && (!options['--source-run-id'] || run.id === options['--source-run-id']))
        if (sources.length === 1) {
          const source = sources[0]; result.sourceSnapshot = withoutEvents(source); result.sourceSnapshotSha256 = sha(canonical(result.sourceSnapshot))
          check('failedSourceReadyForBaseline', source.status === 'failed' && !!source.endedAt)
          const write = source.graph?.nodes?.find(node => node.kind === 'tool' && node.config?.toolId === 'native:write'), record = source.executions?.find(record => record.nodeId === write?.id)
          check('sourceWriteActuallyFailed', record?.status === 'failed' && !!record.startedAt && record.attempt > 0 && !!record.error)
          check('sourceFailureArtifactAbsent', absent(artifact))
        }
      }
      pending('matchingRun', options['--run-id'] ? 'Selected run does not exist or does not match the case/owned workflow' : 'No corresponding actual run yet'); return finish()
    }
    if (matching.length !== 1) { pending('unambiguousRun', `Matching run IDs: ${matching.map(run => run.id).join(', ')}; select --run-id`); return finish() }
    const run = matching[0], current = owned.get(run.workflowId), nodes = run.graph?.nodes ?? [], execution = id => run.executions?.filter(record => record.nodeId === id)
    result.runSnapshot = withoutEvents(run); result.runId = run.id; result.inputBindings = bindings(run, spec, root)
    check('workflowOwnership', run.graph?.id === run.workflowId && run.graph?.workspaceId === run.workspaceId && current.workspaceId === run.workspaceId && Number.isInteger(run.sourceRevision) && run.sourceRevision <= current.revision)
    check('graphonEngine', run.engine?.name === 'graphon' && typeof run.engine.version === 'string' && Number.isInteger(run.engine.protocol) && run.engine.protocol > 0, run.engine)
    check('fiveNodes', nodes.length === 5 && new Set(nodes.map(node => node.id)).size === 5 && ['input', 'code', 'template', 'tool', 'output'].every(kind => nodes.filter(node => node.kind === kind).length === 1))
    const sequence = ['input', 'code', 'template', 'tool', 'output'].map(kind => nodes.find(node => node.kind === kind))
    if (sequence.some(node => !node)) return finish()
    const [input, code, template, write, output] = sequence
    check('nativeWriteAndPureJavaScript', write.config?.toolId === 'native:write' && (!code.config?.language || code.config.language === 'javascript') && nodes.every(node => !node.config?.body))
    check('exactSequentialEdges', run.graph.edges?.length === 4 && sequence.slice(1).every((node, i) => run.graph.edges.some(edge => edge.source === sequence[i].id && edge.target === node.id && (!edge.port || edge.port === 'default'))))
    check('uniqueExecutionInstances', run.executions?.length === 5 && sequence.every(node => execution(node.id)?.length === 1 && (execution(node.id)[0].executionId ?? node.id) === node.id))
    if (!run.executions || sequence.some(node => execution(node.id)?.length !== 1)) return finish()
    const records = sequence.map(node => execution(node.id)[0]), byKind = Object.fromEntries(sequence.map((node, i) => [node.kind, records[i]]))
    result.executions = sequence.map((node, i) => ({ kind: node.kind, cache: node.config?.cache ?? 'default', ...records[i] }))
    const budget = run.usage ?? run.budget
    check('noBusinessModelCalls', !!budget && ['spentTokens', 'reservedTokens', 'unknownTokens', 'unknownCalls', 'agentTasks', 'calls'].every(key => budget[key] === 0) && records.every(record => !record.subagentId && !record.childRunId && !record.repairTaskIds?.length), budget)
    const events = run.events ?? []
    check('ownedMonotoneEvents', events.length > 0 && events.every((event, i) => event.runId === run.id && event.id === `${run.id}:${event.seq}` && Number.isSafeInteger(event.seq) && event.seq > (events[i - 1]?.seq ?? 0)))
    const terminal = ['success', 'failed', 'cancelled', 'interrupted'].includes(run.status)
    if (!terminal) { pending('terminalRun', `Actual status: ${run.status}`); return finish() }
    check('terminalEventMatches', !!run.endedAt && Number.isFinite(Date.parse(run.startedAt)) && Date.parse(run.endedAt) >= Date.parse(run.startedAt) && events.at(-1)?.status === run.status && records.every(record => events.at(-1)?.executions?.some(item => item.executionId === (record.executionId ?? record.nodeId) && item.status === record.status)))
    const actual = record => !!record.startedAt && !!record.endedAt && record.attempt > 0 && !record.reusedFromRunId && Date.parse(record.startedAt) >= Date.parse(run.startedAt) && Date.parse(record.endedAt) >= Date.parse(record.startedAt) && events.some(event => event.executions?.some(item => item.executionId === (record.executionId ?? record.nodeId) && item.status === 'running'))
    if (caseName === 'invalid') {
      check('invalidRunFailed', run.status === 'failed' && !!run.error && equal(run.outputs, {}))
      check('invalidInputAndCodeActuallyExecuted', byKind.input.status === 'success' && actual(byKind.input) && byKind.code.status === 'failed' && !!byKind.code.error && actual(byKind.code))
      check('invalidSuccessorsNeverExecuted', [byKind.template, byKind.tool, byKind.output].every(record => record.status === 'skipped' && !record.startedAt && !record.attempt && !record.reusedFromRunId))
      check('invalidArtifactAbsent', absent(artifact)); return finish()
    }
    check('successfulRun', run.status === 'success' && !run.error && records.every(record => record.status === 'success' && record.data !== undefined))
    if (caseName !== 'recovery') check('allFiveActuallyExecuted', !run.sourceRunId && records.every(actual))
    if (caseName === 'recovery') {
      if (spec.expectedSourceRevision !== undefined) check('explicitExpectedSourceRevision', Number.isInteger(spec.expectedSourceRevision) && run.sourceRevision === spec.expectedSourceRevision, { expected: spec.expectedSourceRevision, actual: run.sourceRevision })
      if (spec.expectedCurrentRevisionAtRecovery !== undefined) check('explicitExpectedCurrentRevisionAtRecovery', Number.isInteger(spec.expectedCurrentRevisionAtRecovery) && current.revision === spec.expectedCurrentRevisionAtRecovery, { expected: spec.expectedCurrentRevisionAtRecovery, actual: current.revision })
      const source = runs.find(item => item.id === run.sourceRunId)
      check('expectedSourceIdentity', !!source && source.id !== run.id && (!options['--source-run-id'] || source.id === options['--source-run-id']))
      if (!source) return finish()
      result.sourceSnapshot = withoutEvents(source); result.sourceSnapshotSha256 = sha(canonical(result.sourceSnapshot))
      check('sourceStillFailed', source.status === 'failed' && !!source.endedAt && source.workflowId === run.workflowId && source.workspaceId === run.workspaceId)
      check('frozenGraphAndInputs', equal(run.graph, source.graph) && run.sourceRevision === source.sourceRevision && equal(run.inputs, source.inputs) && equal(run.toolConstraints, source.toolConstraints) && equal(run.dependencySnapshots, source.dependencySnapshots) && equal(run.dependencyRolePrompts, source.dependencyRolePrompts) && equal(run.rolePrompts, source.rolePrompts) && equal(run.environment, source.environment))
      if (!options['--source-baseline']) pending('sourceHistoryUnchanged', 'Provide --source-baseline captured before recovery; current failed status alone does not prove immutability')
      else {
        const file = path.resolve(options['--source-baseline']), baseline = readJson(file), prior = runFromBaseline(baseline, source.id)
        const capturedAt = baseline.checkedAt ?? baseline.capturedAt ?? fs.statSync(file).mtime.toISOString()
        result.inputs.sourceBaseline = { path: file, sha256: sha(fs.readFileSync(file)), capturedAt }
        const capturedBeforeRecovery = file !== path.join(dir, 'graphon-runs.json') && Number.isFinite(Date.parse(capturedAt)) && Date.parse(capturedAt) < Date.parse(run.startedAt)
        check('baselinePredatesRecovery', capturedBeforeRecovery, 'A current/after-recovery snapshot cannot prove source immutability')
        check('sourceHistoryUnchanged', capturedBeforeRecovery && !!prior && equal(withoutEvents(prior), withoutEvents(source)))
      }
      check('freshRecoveryIdentity', run.systemVariables?.workflow_run_id === run.id && run.systemVariables?.workflow_run_id !== source.systemVariables?.workflow_run_id)
      const review = run.recoveryReview, decision = review?.decisions?.find(item => item.executionId === write.id)
      check('explicitWriteRedoRecorded', review?.sourceRunId === source.id && /^[a-f0-9]{64}$/.test(review?.baseDigest ?? '') && Number.isFinite(Date.parse(review?.confirmedAt)) && decision?.action === 'redo' && !!decision.evidence?.trim())
      result.reuse = records.map(record => ({ nodeId: record.nodeId, classification: record.reusedFromRunId ? 'reused' : actual(record) ? 'executed' : 'unproven' }))
      for (const [i, record] of records.entries()) {
        if (!record.reusedFromRunId) { check(`recoveryExecuted:${record.nodeId}`, actual(record)); continue }
        const prior = source.executions.find(item => (item.executionId ?? item.nodeId) === (record.executionId ?? record.nodeId))
        check(`recoveryCacheReceipt:${record.nodeId}`, record.reusedFromRunId === source.id && prior?.status === 'success' && prior.data !== undefined && equal(record.data, prior.data) && equal(record.output, prior.output) && record.startedAt === prior.startedAt && record.endedAt === prior.endedAt && record.attempt === prior.attempt && !events.some(event => event.executions?.some(item => item.executionId === record.nodeId && item.status === 'running')))
        check(`recoveryCacheEligible:${record.nodeId}`, sequence[i].config.cache !== 'never' && (['input', 'template', 'output'].includes(sequence[i].kind) || sequence[i].kind === 'code' && sequence[i].config.cache === 'reuse'))
      }
      const sourceWrite = source.executions.find(record => record.nodeId === write.id)
      check('writeFailedThenReallyRetried', sourceWrite?.status === 'failed' && !!sourceWrite.startedAt && sourceWrite.attempt > 0 && !!sourceWrite.error && actual(byKind.tool) && byKind.tool.status === 'success')
      check('outputWasNotPriorCache', !byKind.output.reusedFromRunId && source.executions.find(record => record.nodeId === output.id)?.status === 'skipped')
    }
    if (absent(artifact)) { check('outputArtifact', false, 'Terminal run has no expected output file'); return finish() }
    regular(artifact); const bytes = fs.readFileSync(artifact), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    result.artifact = { path: artifact, exists: true, bytes: bytes.length, sha256: sha(bytes), nonemptyLines: lines(text) }
    check('exactNonemptyLines', Array.isArray(spec.expectedLines) && spec.expectedLines.length > 0 && equal(lines(text), spec.expectedLines), { expected: spec.expectedLines, actual: lines(text) })
    const sent = JSON.parse(byKind.tool.input ?? 'null')
    check('writeArgumentUsesCasePath', typeof sent?.file_path === 'string' && !!sent.file_path && path.resolve(root, sent.file_path) === artifact)
    check('artifactHashEqualsWriteArgument', typeof sent?.content === 'string' && sha(Buffer.from(sent.content)) === sha(bytes))
    check('artifactHashEqualsTemplateText', typeof byKind.template.data?.text === 'string' && sha(Buffer.from(byKind.template.data.text)) === sha(bytes))
    if (spec.expectedSha256 !== undefined) check('explicitExpectedFileHash', result.artifact.sha256 === spec.expectedSha256)
    const outputName = output.config.outputName ?? 'result'
    check('actualOutputMirror', typeof byKind.output.data?.text === 'string' && Object.keys(run.outputs ?? {}).length === 1 && run.outputs[outputName] === byKind.output.data.text && !!run.outputs[outputName].trim())
  } catch (error) { check('verificationError', false, error instanceof Error ? error.message : String(error)) }
  return finish()
}

let options
try { options = parseArgs(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exitCode = 1 }
if (options?.help) process.stdout.write(usage)
else if (options) {
  const result = verify(options), directory = path.resolve(options['--evidence-dir'] ?? defaultEvidence)
  const output = options['--out'] ? path.resolve(options['--out']) : path.join(directory, `${options['--case']}-verification-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.json`)
  try { fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); console.log(JSON.stringify({ ...result, evidenceFile: output }, null, 2)); process.exitCode = result.passed ? 0 : result.verdict === 'pending' ? 2 : 1 }
  catch (error) { console.error(`Evidence output was not written: ${error.message}`); process.exitCode = 1 }
}
