# 文档提取器（document）

[返回手册总索引](../README.md) · [节点执行矩阵](README.md)

类型身份：`document`。常见别名：轻量本地／指定工具或 MCP／文档 Agent。核验日期：2026-10-16。

## 用途

把当前工作区文件或私有上传附件转为文字；复杂格式交给已选工具，避免把重型解析栈塞入插件。

## 输入与配置

- `source`：工作区路径、文件变量或列表；`documentMode` 默认 local。读上传附件或路径参数时写裸路径 `input.字段`（如 `input.file`）。
- tool 模式：`toolId`、`documentSourceKey`（默认 source）、`documentTextPath`（默认 text）、额外 inputs。
- agent 模式：DSH model/effort/rolePresetId、prompt、明确授权的 tools、maxSteps 2–20（默认6）。

## 输出

- 共同字段 text/source/characters；本地文件数组额外 documents[]；Agent 额外 steps/parser="agent"。
- local 模式的 text 是文件原文（去掉开头 BOM），不带行号，可以直接交给写入节点原样另存。试做读输入文件时，照试做生成的骨架用的就是这个节点（[设计 26 §6.1](../规划引擎/设计/26-照试做搭骨架.md)）。
- source 是名称或名称列表。上传 base64 不写入模型提示、解析结果或可读错误。

## Graphon 与具体执行者

Graphon 调度 TS document adapter。local 严格读 UTF-8 文本；tool 校验目录及参数后实际调用指定工具，按结果路径取字符串；agent 通过 DSH 模型生成严格 JSON，只能调用所选工具，宿主用来源占位符替换真正路径/附件，所有来源确实被工具读取后才接受最终文字。

共同边界：Graphon 接收当前层的节点 ID、kind 和连线；具体配置、变量作用域、模型凭证及节点副作用仍由已认证 DSH Host 持有。详见[节点共同执行规则](README.md#共同执行规则)。

## 前置条件与限制

- local 仅 txt/md/markdown/csv/tsv/json/yaml/yml/xml/html/htm/log；HTML只做轻量去脚本/样式/标签，不是浏览器渲染。PDF/DOCX/图片/OCR须工具具备能力。
- 本地路径校验 realpath，禁止符号链接越出工作区；本地单文件≤10MB，来源1–20个，上传合计≤2MB；经input上传时 files另受10个限制。
- native/MCP 必须连接且有本工作区会话权限。目录不可用时先停止，不读取附件、不悄悄替换解析器。参数名、JSON结果路径、字符串类型都严格校验。
- 受限文档 Agent 不是直接派给 DSH 主 Agent。不能只根据文件名提交猜测答案；需先读全部来源，但解析文字的语义忠实性仍需外部解析器/模型实际验收。
- 工具模式不会自动装解析依赖；文档 Agent 达步数上限或工具失败不会重试已执行操作。

## 源码与现有验证

- [来源校验与本地读取](../../../src/host/execution-adapters.ts#L80)。
- [工具/Agent解析实际路径](../../../src/host/execution-adapters.ts#L171)。
- [UI解析来源与参数](../../../src/client/node-config.tsx#L54)。
- [测试：本地格式、真实路径、schema、结果路径、附件隔离、取消（MCP测试替身）](../../../tests/document-adapters.test.ts#L24)。
- [测试：工具实际适配路由/来源占位符、拒绝伪造最终答复与漏读来源](../../../tests/document-adapters.test.ts#L82)。
- [测试：模式切换保留显式模型/工具且缺失工具不替换](../../../tests/document-config.test.tsx#L18)。
- [测试：生产适配器端到端提取300KB文本附件](../../../tests/runtime-expanded.test.ts#L123)。

本轮已统一运行相关自动测试，并以[20类型集成链](../../../tests/graphon-capability-audit.test.ts)验证真实Graphon调度；模型响应使用明示替身，不等于用户真实服务或生产解析质量已通过。Python用户代码等变体以[验证范围](../验证/01-验证范围与结果.md)为准；未调用收费模型或外网MCP。

## 相关节点

[工具](tool-工具.md)、[工具调用 Agent](agent-工具调用Agent.md)、[知识检索](knowledge-知识检索.md)、[用户输入](input-用户输入.md)
