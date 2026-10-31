// Read-only acceptance for the synthetic PRD2 fixture executed in the real Desktop.
// It reads only the selected run and that run's two native child sessions.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import zlib from 'node:zlib'

const [runId] = process.argv.slice(2)
if (!runId || !/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Pass the real smoke run UUID')
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const root = process.cwd(), cache = path.join(root, '.cache/prd2-native-validation')
const state = path.join(os.homedir(), '.dsh/visible-dynamic-workflows')
const profile = path.join(os.homedir(), '.dsh/profiles/desktop')
const run = read(path.join(state, 'runs', `${runId}.json`))
if (run.workflowId !== '3b2ac60b-9f97-4ce7-a2a5-fdd2c8a7e391') throw new Error('Not the synthetic native Agent fixture')
const agents = run.executions.filter(execution => execution.subagentId)
if (agents.length !== 2) throw new Error('Expected two actual native child IDs')
const children = agents.map(execution => {
  const id = execution.subagentId
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid child identity')
  const sessionFile = path.join(os.homedir(), '.dsh/sessions/-'+path.join(os.homedir(),'Documents','deepseek-harness-default-workspace').replaceAll('/','-')+'--', id, 'session.v4.jsonl.zstd')
  const bytes = fs.readFileSync(sessionFile)
  let offset = 0, text = ''
  while (offset < bytes.length) {
    const frame = zlib.zstdDecompressSync(bytes.subarray(offset), { info: true })
    if (!frame.engine.bytesWritten) throw new Error('Invalid session frame')
    offset += frame.engine.bytesWritten
    text += frame.buffer.toString('utf8')
  }
  const rows = text.trim().split('\n').map(line => JSON.parse(line)), header = rows[0]
  const descriptor = rows.find(row => row.type === 'subagent/descriptor')?.data
  if (header.id !== id || header.origin !== 'subagent' || !descriptor?.label?.includes(`[${runId}/`)) throw new Error('Child does not belong to this run')
  const calls = rows.filter(row => row.type === 'tool/call').map(row => ({ name: row.data.name, callId: row.data.callId, arguments: row.data.arguments }))
  const results = rows.filter(row => row.type === 'tool/result').map(row => ({ callId: row.data.message.toolCallId, isError: row.data.message.isError ?? false, content: row.data.message.content }))
  return {
    taskId: id, executionId: execution.executionId, title: execution.title,
    parentSession: header.parentSession, origin: header.origin, delegationDepth: header.delegationDepth,
    provider: descriptor.provider, startedAt: execution.startedAt, endedAt: execution.endedAt,
    requestToolLists: rows.filter(row => row.type === 'request/header').map(row => row.data.header.tools.map(tool => tool.name)),
    calls, results, output: execution.data?.text, tokenUsage: execution.tokenUsage,
    sessionSha256: hash(sessionFile),
  }
})
const a = children.find(child => child.title.includes('Agent A')), b = children.find(child => child.title.includes('Agent B'))
if (!a || !b) throw new Error('Missing fixture Agent')
const sameNames = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
// The user edited a pre-existing copy while using the Desktop between installation
// windows. Preserve that latest revision; the initial baseline remains archived.
const oldLibrary = read(path.join(cache, 'before-final/library.json')), library = read(path.join(state, 'library.json'))
const oldHistory = read(path.join(cache, 'before-final/history-hashes.json'))
const installBaseline = read(path.join(cache, 'before-second-install.json'))
const build = read(path.join(cache, 'build-final.json')), tests = read(path.join(cache, 'vitest-final.json'))
const installedFiles = Object.fromEntries(Object.keys(build.packageMatchesBuild).map(file => [file, hash(path.join(root, file)) === hash(path.join(profile, 'node_modules/dsh-visible-dynamic-workflows', file))]))
const retainedFlows = Object.fromEntries(oldLibrary.workflows.map(flow => [flow.id, JSON.stringify(flow) === JSON.stringify(library.workflows.find(current => current.id === flow.id))]))
const retainedHistory = Object.fromEntries(Object.entries(oldHistory).map(([file, expected]) => [file, hash(path.join(state, file)) === expected]))
const profilePreserved = Object.fromEntries(['cordis.yml', 'cordis.patch.yml'].map(file => [file, hash(path.join(profile, file)) === installBaseline.hashes[file]]))
const nativeChecks = {
  terminalSuccess: run.status === 'success',
  expectedCombinedResult: run.outputs?.result === 'native-A-ok | native-B-ok',
  aToolWhitelist: a.requestToolLists.length > 0 && a.requestToolLists.every(names => sameNames(names, ['structured_output', 'workflow_bound_tool_1'])),
  bToolWhitelist: b.requestToolLists.length > 0 && b.requestToolLists.every(names => sameNames(names, ['structured_output'])),
  aTimeToolCalledOnce: a.calls.filter(call => call.name === 'workflow_bound_tool_1').length === 1,
  aTimeToolSucceeded: a.calls.filter(call => call.name === 'workflow_bound_tool_1').every(call => a.results.some(result => result.callId === call.callId && !result.isError)),
  noUnexpectedCalls: a.calls.every(call => ['structured_output', 'workflow_bound_tool_1'].includes(call.name)) && b.calls.every(call => call.name === 'structured_output'),
  distinctNativeChildren: a.taskId !== b.taskId && children.every(child => child.provider === 'spawn'),
  sameExpectedParent: a.parentSession === b.parentSession && a.parentSession === run.systemVariables?.session_id,
  concurrentExecution: Math.max(Date.parse(a.startedAt), Date.parse(b.startedAt)) < Math.min(Date.parse(a.endedAt), Date.parse(b.endedAt)),
  settledUsage: run.usage?.reservedTokens === 0 && run.usage?.unknownTokens === 0 && run.usage?.agentTasks === 2 && run.usage?.spentTokens === children.reduce((total, child) => total + child.tokenUsage, 0),
  noSecretRuntimeValue: !JSON.stringify(run.environment).includes('SECRET_BOUNDARY_ONLY'),
}
const checks = { ...nativeChecks, installedMatchesBuild: Object.values(installedFiles).every(Boolean), packageMatchesBuild: Object.values(build.packageMatchesBuild).every(Boolean), originalFlowsPreserved: Object.values(retainedFlows).every(Boolean), originalPresetsPreserved: JSON.stringify(oldLibrary.presets) === JSON.stringify(library.presets), originalHistoryPreserved: Object.values(retainedHistory).every(Boolean), currentHostConfigurationPreserved: Object.values(profilePreserved).every(Boolean), fullTestsPassed: tests.success && tests.numFailedTests === 0 }
const report = {
  checkedAt: new Date().toISOString(), checks, allChecksPassed: Object.values(checks).every(Boolean),
  fixture: { workflowId: run.workflowId, runId, startedAt: run.startedAt, endedAt: run.endedAt, status: run.status, outputs: run.outputs, modelDefaults: run.modelDefaults },
  children, usage: run.usage, build, installedFiles,
  installation: { previousHostPid: installBaseline.host.pid, newHostPid: read(path.join(state, 'host.lock')).pid, profilePreserved },
  dataPreservation: { originalFlowCount: oldLibrary.workflows.length, retainedFlows, originalHistoryFileCount: Object.keys(oldHistory).length, retainedHistory, drafts: 'not compared; no baseline captured' },
  tests: { files: tests.testResults.length, passedTests: tests.numPassedTests, failedTests: tests.numFailedTests },
  failedFirstAttempt: read(path.join(cache, 'attempt-1.json')),
  limitations: ['Secret secure storage and controlled consumption remain unavailable', 'Trusted production file-read attestation remains unavailable', 'This smoke does not verify live cancellation, steering, output repair or recovery', 'No real secrets were used'],
}
const destination = path.join(root, 'artifacts/prd2-native-agent-verification.json')
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ destination, checks, children: children.map(child => ({ taskId: child.taskId, output: child.output, requestToolLists: child.requestToolLists })), usage: run.usage }, null, 2))
if (!report.allChecksPassed) process.exitCode = 1
