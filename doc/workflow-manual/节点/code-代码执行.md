# 代码执行（code）

[返回手册总索引](../README.md) · [节点执行矩阵](README.md)

类型身份：`code`。常见别名：JavaScript／受限 Python。核验日期：2026-10-16。

## 用途

在明确隔离边界内执行纯数据转换函数 main(inputs)，返回 JSON 对象。

## 输入与配置

- `language`、`code`、`inputs`、可选 `outputSchema`、`timeoutMs`。配置 schema 允许至 30000ms，但实际/UI 上限为 JavaScript 3000ms、Python 10000ms。
- JavaScript 入口 `function main(inputs){return {result:...}}`；Python 仅允许 `def main(inputs): ...`。

## 输出

- main 返回对象本身；不是固定自动包裹 result。输出 schema 只验证声明顶层字段；下游按实际字段引用。

## Graphon 与具体执行者

Graphon 只调度。JavaScript 在 quickjs-emscripten 独立 VM 中运行：32MB 内存、512KB 栈、无宿主绑定/模块加载器。Python 使用已预构建的解释器，经 DSH 文件沙箱 full enforcement 封装，再执行受 AST 白名单限制的纯数据方言。两者均非 Graphon 内执行用户代码。

共同边界：Graphon 接收当前层的节点 ID、kind 和连线；具体配置、变量作用域、模型凭证及节点副作用仍由已认证 DSH Host 持有。详见[节点共同执行规则](README.md#共同执行规则)。

## 前置条件与限制

- JS 不暴露 fs/process/网络，拒绝 async/Promise、非对象、非 JSON 返回值；代码额外限制 100000 字符。
- Python 无 import、属性反射、任意函数调用/嵌套函数，只有列出的纯数据内置函数；CPU 3 秒、尝试内存 256MB、进程超时最多 10 秒。
- 预构建 Python 解决免手装环境，不等于自动具备安全沙箱；缺 sandbox 或 enforcement非full则拒绝执行，绝不退回裸 Python。
- 不是 Dify sandbox 服务或任意第三方 Python 包环境；需要解析库/外部 I/O 时用明确工具。外层节点输出还有约 1 MB 限制。

## 源码与现有验证

- [JS VM 与 Python 方言](../../../src/host/execution-adapters.ts#L27)。
- [真实代码分派](../../../src/host/execution-adapters.ts#L240)。
- [宿主完整沙箱前置](../../../src/host/index.ts#L48)。
- [UI 实际超时](../../../src/client/nodes.ts#L126)。
- [测试：真实 QuickJS 运行、超时、拒绝宿主 I/O/Promise/非JSON](../../../tests/tool-adapters.test.ts#L51)。
- [测试：只执行可信 Python 验证器拒绝 import/反射](../../../tests/tool-adapters.test.ts#L71)。
- [测试：预构建绝对解释器路径仍必须经过 sandbox gate；不是完整沙箱成功实测](../../../tests/tool-adapters.test.ts#L76)。
- [测试：真实 JS 与图运行器连通](../../../tests/expanded-flows.test.ts#L21)。

本轮已统一运行相关自动测试，并以[20类型集成链](../../../tests/graphon-capability-audit.test.ts)验证真实Graphon调度；模型响应使用明示替身，不等于用户真实服务或生产解析质量已通过。Python用户代码等变体以[验证范围](../验证/01-验证范围与结果.md)为准；未调用收费模型或外网MCP。

## 相关节点

[模板转换](template-模板转换.md)、[工具](tool-工具.md)、[文档提取器](document-文档提取器.md)
