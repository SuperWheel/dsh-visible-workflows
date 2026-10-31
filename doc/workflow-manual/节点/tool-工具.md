# 工具（tool）

[返回手册总索引](../README.md) · [节点执行矩阵](README.md)

类型身份：`tool`。常见别名：内置工具／插件工具／MCP／OpenAPI／子工作流。核验日期：2026-10-16。

## 用途

直接调用一个已存在的具体工具操作，不经过模型决定。

## 输入与配置

- `toolId`：从真实工具目录选择；`inputs`：具名 JSON 参数，完整 `{{引用}}` 保留类型。

## 输出

- 输出依具体操作而定。内置工具通常带 text 及结构化字段；宿主工具适配统一返回 text/value；子工作流返回 text/outputs/run_id。
- 下游引用需依据真实目录 schema 或成功运行结果，不能一律假定 result/json 等字段存在。

## Graphon 与具体执行者

Graphon 调度 tool 桥接节点；TS ToolCatalog 按 builtin:/native:/workflow:/swagger: 前缀分派。native 实际调用 ctx.tools.execute 并带 Agent、取消信号及可用的父调用上下文；并非菜单假执行。

共同边界：Graphon 接收当前层的节点 ID、kind 和连线；具体配置、变量作用域、模型凭证及节点副作用仍由已认证 DSH Host 持有。详见[节点共同执行规则](README.md#共同执行规则)。

## 前置条件与限制

- 9 个内置时间/JSON 操作可以独立执行；native/MCP 必须已安装注册且处于当前会话可用范围，不能凭名称生成工具。
- MCP 目录不等于插件自带 MCP 服务器或 Dify Marketplace；无连接/权限不会静默换工具。
- OpenAPI 只导入 JSON、文档内 $ref、有限 body 类型；请求参数校验为实现支持的子集，不是完整 JSON Schema。
- 工作流工具仅同工作区，禁止递归和超过 8 层调用；包含 human 的子工作流不可作为工具。父取消传递给子运行，子模型继承父运行快照。
- 没有节点级自动重试；真实副作用由工具服务负责，插件不承诺撤销外部调用。

## 源码与现有验证

- [真实目录与执行路由](../../../src/host/tool-catalog.ts#L86)。
- [native 权限与调用](../../../src/host/index.ts#L112)。
- [子工作流执行边界](../../../src/host/index.ts#L130)。
- [OpenAPI 导入](../../../src/host/tool-catalog.ts#L67)。
- [测试：内置时间/JSON、OpenAPI 导入与工作区持久化](../../../tests/tool-adapters.test.ts#L14)。
- [测试：真实宿主 scoped native dispatch，非外网 MCP 实调](../../../tests/runtime-sdk-contract.test.ts#L74)。
- [测试：真实 Cordis 服务与子工作流模型冻结](../../../tests/runtime-model-defaults.test.ts#L76)。

本轮已统一运行相关自动测试，并以[20类型集成链](../../../tests/graphon-capability-audit.test.ts)验证真实Graphon调度；模型响应使用明示替身，不等于用户真实服务或生产解析质量已通过。Python用户代码等变体以[验证范围](../验证/01-验证范围与结果.md)为准；未调用收费模型或外网MCP。

## 相关节点

[工具调用 Agent](agent-工具调用Agent.md)、[HTTP 请求](http-HTTP请求.md)、[文档提取器](document-文档提取器.md)
