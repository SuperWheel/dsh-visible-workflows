import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NODE_LABELS, type NodeKind } from '../src/shared/types.ts'
import { queryWorkflowSemantics, WORKFLOW_SEMANTIC_TOPICS } from '../src/shared/workflow-semantics.ts'

const target = fileURLToPath(new URL('../doc/workflow-manual/规划引擎/15-Agent工作流语义词典.md', import.meta.url))
const cell = (value: unknown) => String(value).replaceAll('|', '\\|').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '<br>')
const table = (values: Record<string, unknown>) => ['| 字段 | 含义 |', '| --- | --- |', ...Object.entries(values).map(([key, value]) => `| \`${key}\` | ${cell(typeof value === 'string' ? value : JSON.stringify(value))} |`)].join('\n')
const json = (value: unknown) => '```json\n' + JSON.stringify(value, null, 2) + '\n```'
const index = queryWorkflowSemantics()
const parts = [
  '# Agent 工作流语义词典',
  '> 此文件由共享语义模块生成，不维护另一套 JSON 契约。修改 `src/shared/workflow-semantics.ts` 后运行 `node --import tsx scripts/generate-workflow-dictionary.ts`；检查同步状态用 `node --import tsx scripts/generate-workflow-dictionary.ts --check`。',
  '[返回规划引擎索引](README.md) · [唯一 JSON 字段标准](../原理/10-JSON字段与导入导出.md) · [JSON 投影与宿主补齐](03-JSON投影与宿主补齐.md)',
  '## 1、接入方式与使用边界',
  '主对话 Agent 使用 `visible_workflow_dictionary`，规划子 Agent 使用 `planner_node_catalog`；两者调用同一共享模块。无参数只返回紧凑索引，按需查询最多 5 种节点和指定主题；仅需要严格类型、枚举或范围时增加 `includeSchema:true`。字段 schema 来自编辑器、导入器使用的 `workflowNodeConfigSchema`，容器只移除由 Host 补齐的投影元数据。',
  '主对话调用示例：',
  json({ query_json: JSON.stringify({ kinds: ['input', 'template', 'output'], topics: ['references'], includeSchema: true }) }),
  '规划子 Agent 使用等价的 kinds/topics/includeSchema 参数。节点词典只说明如何表达；自然语言新建与修改仍走规划引擎，不能因读取词典或规划失败就绕过校验直接保存。词典例子仅是配置片段，未执行，也不是可直接导入或保存的完整工作流。',
  index.usage,
  ...index.coreRules.map(rule => `- ${rule}`),
  '## 2、节点选择索引',
  ['| kind | 显示名 | 功能 |', '| --- | --- | --- |', ...index.nodeIndex!.map(node => `| \`${node.kind}\` | ${node.label} | ${cell(node.purpose)} |`)].join('\n'),
  '## 3、字段主题',
]
for (const [at, topic] of WORKFLOW_SEMANTIC_TOPICS.entries()) {
  const content = queryWorkflowSemantics({ topics: [topic] }).topics[topic] as Record<string, unknown>
  parts.push(`### 3.${at + 1}、${topic}`)
  for (const [key, value] of Object.entries(content)) {
    if (key === 'rules') parts.push((value as string[]).map(rule => `- ${rule}`).join('\n'))
    else if (Array.isArray(value)) parts.push(`**${key}**：${value.map(item => `\`${String(item)}\``).join('、')}`)
    else if (['example', 'examples'].includes(key)) parts.push(`**${key}**`, json(value))
    else parts.push(`**${key}**`, table(value as Record<string, unknown>))
  }
}
parts.push('## 4、节点字段、输出和例子')
for (const [at, kind] of (Object.keys(NODE_LABELS) as NodeKind[]).entries()) {
  const node = queryWorkflowSemantics({ kinds: [kind] }).nodes![0]!
  parts.push(`### 4.${at + 1}、${node.label}（${kind}）`, node.purpose, '**config 字段**', table(node.fields), '**输出字段**', table(node.outputs), '**配置例子**', json(node.example), node.rules.map(rule => `- ${rule}`).join('\n'))
  if (node.syntax) {
    parts.push('**模板语法（词典说明，不是 config 新字段）**', table(node.syntax.statements), '**支持的过滤器**', table(node.syntax.filters), node.syntax.rules.map(rule => `- ${rule}`).join('\n'))
    for (const example of node.syntax.examples) parts.push(`**${example.title}**`, '**固定工作流输入夹具与节点配置（input 不属于 config）**', json({input:example.input,config:example.config}), '**预期渲染文本（固定示例输入）**', '```text\n' + example.expected + '\n```')
  }
  if (node.builtinTools) {
    parts.push('**内置工具输出契约（词典说明，不是 config 新字段）**', '以下仅描述当前内置工具；输出字段直接位于工具节点顶层。示例结果来自固定输入，含 clock 的例子按指定测试时刻解释；clock/expected 均不是工具参数，也不代表已执行用户任务。')
    for (const tool of node.builtinTools) parts.push(`**${tool.toolId}**`, '**inputs 参数**', table(tool.inputs), '**输出字段**', table(tool.outputs), '**调用配置例子**', json({ toolId: tool.toolId, inputs: tool.example.inputs }), ...(tool.example.clock ? [`测试固定时刻：\`${tool.example.clock}\`。`] : []), '**预期输出**', json(tool.example.expected))
  }
}
parts.push('## 5、来源与验证',
  '- [共享语义词典](../../../src/shared/workflow-semantics.ts)：运行时工具和本页使用同一描述源。\n- [当前节点与 Workflow 校验](../../../src/shared/workflow-validation.ts)：字段类型、默认值、上限和未知字段拒绝。\n- [按需 schema 投影](../../../src/shared/node-capabilities.ts)：复用当前校验器，不建立替代 JSON 标准。\n- [生成投影与 Host 补齐](../../../src/shared/planning-projection.ts)：可编辑字段、身份、布局和版本边界。\n- [引用依赖作用域](../../../src/shared/reference-scope.ts)：稳定 ID、上游、容器与 Secret 边界。\n- [节点运行](../../../src/host/runtime.ts)与[具体适配器](../../../src/host/execution-adapters.ts)：实际执行、返回值与限制。\n- [宿主工具和子工作流包装](../../../src/host/index.ts)：native 工具 value/text 与子流程 outputs/run_id。\n- [语义测试](../../../tests/workflow-semantics.test.ts)：20 种配置示例和当前 schema 一致、字段说明覆盖、输入引用投影校验、真实隔离 JavaScript 返回对象。',
  '- [内置工具执行器](../../../src/host/tool-catalog.ts)：当前 9 个 builtin 工具的参数及实际输出结构。\n- [模板解释器](../../../src/host/template.ts)：循环、条件、过滤器和执行边界。\n- 语义测试还调用真实 `executeBuiltin` 和 `renderDataTemplate` 验证本页的固定输入例子；时间相关示例使用固定测试时钟，属于本地确定性验收。',
  '自动测试与词典字段一致性不代表任意真实模型、网页或工具的业务结果已通过验证。外部资源可用性仍以当前宿主目录、就绪检查及实际运行结果为准。')
const content = parts.join('\n\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== content) throw new Error('Agent 工作流语义词典文档与共享模块不同步，请重新生成')
  process.stdout.write('工作流语义词典文档已同步\n')
} else {
  writeFileSync(target, content)
  process.stdout.write(`已生成 ${target}\n`)
}
