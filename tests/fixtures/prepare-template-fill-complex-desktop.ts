// Prepare synthetic import/request artifacts only. Does not write a profile,
// install, start UI, execute workflows or call a planning/business model.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { deepContainerWire, deepDesktopBundle, largeDesktopBaseline } from './template-fill-complex-import-fixtures.ts'
import { exportWorkflowPackage, importWorkflowJson, parseWorkflowPackage } from '../../src/shared/workflow-format.ts'

const directory = resolve('docs/evidence/backend-batch2-20261019/t05/desktop-fixtures')
mkdirSync(directory, { recursive: true })
const files: Record<string, string> = {}
function save(name: string, value: unknown) {
  const text = JSON.stringify(value, null, 2) + '\n'
  writeFileSync(join(directory, name), text)
  files[name] = createHash('sha256').update(text).digest('hex')
}
const deep = deepDesktopBundle(directory)
save('deep-container.filling.json', deepContainerWire())
save('deep-parent.filling.json', deep.parentWire)
save('deep-container.workflow.json', exportWorkflowPackage(deep.child))
save('deep-subworkflow-bundle.workflow.json', deep.bundle)
save('large-local-edit-baseline.workflow.json', exportWorkflowPackage(largeDesktopBaseline(), { includeEnvironmentValues: true }))
for (const name of ['deep-container.workflow.json', 'deep-subworkflow-bundle.workflow.json', 'large-local-edit-baseline.workflow.json']) {
  const content = readFileSync(join(directory, name), 'utf8')
  parseWorkflowPackage(content)
  importWorkflowJson(content, 'synthetic-import-validation')
}
save('deep-cases.json', [
  { id: 'primary', inputs: { records: '[3,-2,0,4]', rounds: '2', threshold: '2' }, expectedOutputs: { result: '[6,0,0,8]' } },
  { id: 'holdout', inputs: { records: '[1,5,2]', rounds: '3', threshold: '2' }, expectedOutputs: { result: '[0,15,0]' } },
  { id: 'invalid', inputs: { records: '[1,"wrong",3]', rounds: '2', threshold: '0' }, expectedStatus: 'failed', expectedErrorIncludes: 'finite numbers', expectedOutputs: {} },
])
save('large-local-edit-cases.json', {
  baselineNodes: 31, targetBeforeImport: { id: 'target', title: 'target', kind: 'template', text: '原文 {{input.text}}' },
  instruction: '仅修改标题为 target 的模板节点，把 text 改为“结果：{{input.text}}”。先读取导入后的实际工作流 ID、revision 与 target 节点 ID，使用 operation=revise、expectedRevision 和 targetNodeIds；其余节点、配置、边、notes、环境变量和身份保持不变。先返回待接受提案，不直接写入。',
  oracle: '接受后导出图，将唯一目标 text 还原后，与接受前基线逐字段深相等；不允许只比较节点数。',
  cases: [{ inputs: { text: '甲' }, expectedOutputs: { result: '结果：甲' } }, { inputs: { text: '乙' }, expectedOutputs: { result: '结果：乙' } }],
})
const trial = {
  requestId: 'synthetic-t05-desktop-reviewed-greeting', operation: 'create',
  instruction: '完成本次姓名问候文件并请真人核对，再从已通过检查的试做提炼可复用工作流。生成流程以 name 为可变输入，每次把 JSON 问候写入 t05-greeting.json，保留每次运行的人工复核节点。先预览。',
  execution: {
    mode: 'execute-first', task: '读取 t05-input.json 中 name 字段，写入 t05-greeting.json，JSON 对象仅需 text 字段，值严格为 Hello 加空格加本次 name；不读取其他文件。',
    tools: ['read', 'write'], inputs: ['t05-input.json'],
    artifacts: [{ path: 't05-greeting.json', format: 'json', requireChanged: true, checks: [{ kind: 'json-equals', pointer: '/text', value: 'Hello Ada' }] }],
    reviewItems: ['请真人核对问候语与姓名是否合适；生成的工作流必须保留当次真人复核。'],
  }, optimizationTarget: { maxModelCalls: 0, maxAgentCalls: 0 },
}
save('verified-trial.request.json', trial)
save('verified-trial-cases.json', {
  synthetic: true,
  basis: 'The production Host request shape and greeting artifact checks are reused from the verified-trial-human offline fixture; real native tools replace the explicitly offline execution driver.',
  preparation: [{ path: 't05-input.json', content: { name: 'Ada' } }],
  exactToolRequirement: 'Before real execution confirm current native names read and write exist in the actual session. If they differ, root must resolve exact names and regenerate this frozen request before the first trial; no silent alias or fallback.',
  primaryTrial: { expectedFile: 't05-greeting.json', jsonEquals: { text: 'Hello Ada' }, reviewRequired: true },
  holdoutWorkflowRun: { inputs: { name: '小明' }, expectedText: 'Hello 小明', expectedArtifact: { path: 't05-greeting.json', jsonEquals: { text: 'Hello 小明' }, mustChangeFromPrimary: true }, humanReviewRequired: true },
  failureChecks: ['Decline human review: no downstream author/publish and no automatic replay.', 'Artifact with text WRONG: verification fails before distillation.', 'Repeat the exact requestId: reuse owned trial receipt; do not redo writes.'],
  prompt: '在当前独立验收工作区，先确认已准备 t05-input.json={"name":"Ada"} 且本会话确有 read/write。按 verified-trial.request.json 完整调用 visible_workflow_plan；人工质量复核和预算问题交由真人选择。只预览，不代答、不换 requestId 重做；完成后展示 source/procedure/candidate 与 receipt 状态。真人允许发布后，用生成流程的姓名输入“小明”作独立样本，保留人工介入；不要把单个文件检查称为泛化证明。',
  boundary: 'Synthetic preparation only; no real trial/model/native execution or Desktop result is asserted here. The offline generated graph checks greeting output and human gating; its file-write equivalence is not established, so the real holdout artifact check is required separately.',
})
save('manifest.json', { synthetic: true, generatedAt: new Date().toISOString(), preparationOnly: true, providerCalls: 0, workflowRuns: 0, importParsingPassed: true, generatedFrom: ['tests/template-fill-complex-containers.test.ts#wire/createCode', 'tests/template-fill-complex-local-edit.test.ts#baseline', 'tests/fixtures/template-fill-complex-host-fixture.ts#verified-trial-human'], files, notes: ['Import the deep subworkflow bundle as one package so import remaps the dependency identities together.', 'The standalone deep-container package is optional; importing it separately does not rebind a previously imported parent.', 'Large graph import remaps IDs. Resolve the actual target ID by the unique node title target before asking for a scoped proposal.', 'Only synthetic inputs/configuration are in these artifacts; no profile or user state was read.'] })
console.log(JSON.stringify({ prepared: true, directory, synthetic: true, providerCalls: 0, workflowRuns: 0, files }))
