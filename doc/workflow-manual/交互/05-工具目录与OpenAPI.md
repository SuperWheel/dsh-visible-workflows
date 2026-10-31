# 工具目录与OpenAPI

[返回总索引](../README.md) · [交互索引](./README.md)

核验口径：2026-10-16 对当前源码作静态核对；相关自动测试已在本轮统一运行，结果见[验证报告](../验证/01-验证范围与结果.md)。本轮没有新增 Web/桌面全套手工复验。

## 入口与状态

- 节点目录「工具」页按全部、工具插件、Swagger API、工作流、MCP 分类；支持搜索、排序、提供方展开、参数说明、刷新与重试。
- 不可用工具仍能查看说明，但「添加」禁用并显示原因。
- 宿主暴露导入能力时显示「导入 OpenAPI」。

## 操作步骤

1. 展开提供方，阅读具体操作及参数；选择操作后添加真实工具节点。
2. 在节点配置中填写 Schema 参数或完整参数 JSON。
3. 导入时粘贴 OpenAPI 3 / Swagger 2 JSON；成功后切到 Swagger 类别并刷新目录。

## 调用链与边界

`ToolsPicker → api.tools(workspaceId,sessionId)`；选择时写入真实 `toolId` 及 Schema 中声明的默认值。`api.importSwagger → remote.importSwagger`，客户端先校验 JSON 语法，宿主负责契约解析。

工具目录不是 Graphon 自带插件市场；执行时由 DSH 工具权限及适配器提供能力。MCP 出现在可用目录才可选择；不会因画布有工具卡片就安装 MCP。Agent 工具授权和文档解析来源沿用同一真实目录，不静默换工具。

工作流作为工具被另一个流程调用时，当前宿主要求参数补齐；子流程若进入人工等待，会取消该子运行并报“请单独运行并处理询问框”，不能推断为自动嵌套显示子流程询问框。

## 源码与验证证据

源码：[node-picker.tsx](../../../src/client/node-picker.tsx)、[node-config.tsx](../../../src/client/node-config.tsx)、[index.tsx](../../../src/client/index.tsx)。

- [node-picker.test.tsx](../../../tests/node-picker.test.tsx)：操作与参数绑定、不可用工具阻止添加。
- [tool-adapters.test.ts](../../../tests/tool-adapters.test.ts)：宿主真实工具契约。
- [document-config.test.tsx](../../../tests/document-config.test.tsx)：解析工具配置与来源。
- [宿主子工作流调用](../../../src/host/index.ts)：参数完整性及人工等待边界。

OpenAPI 导入弹窗及目录刷新完整 UI 流程未在本次实机复验。

关联：[节点目录与添加](./04-节点目录与添加.md)、[节点配置与变量引用](./11-节点配置与变量引用.md)、[工作流引用与Agent编辑](./20-工作流引用与Agent编辑.md)。
