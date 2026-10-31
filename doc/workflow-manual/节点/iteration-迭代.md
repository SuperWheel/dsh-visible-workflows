# 迭代（iteration）

[返回手册总索引](../README.md) · [节点执行矩阵](README.md)

类型身份：`iteration`。常见别名：For-each 容器。核验日期：2026-10-16。

## 用途

遍历数组，每项运行同一子图，按输入顺序收集指定结果。

## 输入与配置

- `iterator`：数组变量或 JSON 数组字面量，最多 1000 项；`body:{nodes,edges}` 每层恰好一个 input。
- `outputVariable` 必填：子层稳定节点 ID 的输出路径；`parallel`、`concurrency`（1–10）。
- `errorMode`：terminate 终止、null 保留空值、remove 移除失败项。

## 输出

- `text`：结果 JSON 文本；`result`/`json` 数组；`errors`：失败 index/error 列表。空数组输出 [] 且不调用子节点。

## Graphon 与具体执行者

外层 Graphon 调度容器桥接节点；TS 为各项建立 item、index、拷贝 values/variables 的子作用域，并递归调用 Graphon 执行 body。并行由 TS worker 池控制，不是把 iteration 自动替换成 Dify 原生节点。

共同边界：Graphon 接收当前层的节点 ID、kind 和连线；具体配置、变量作用域、模型凭证及节点副作用仍由已认证 DSH Host 持有。详见[节点共同执行规则](README.md#共同执行规则)。

## 前置条件与限制

- 按输入下标写结果，完成先后不改变输出顺序；每项变量默认隔离，不是共享累加器。
- 并行 body 任意深度包含 human 会拒绝；顺序 human 暂停后从缓存恢复已成功步骤。
- errorMode 只处理单项错误，不自动重试。terminate 时会取消其他在途 worker；null/remove 继续收集。
- exit_loop、人工暂停与用户取消是控制信号，不转成普通项失败；三种 errorMode 均传播退出信号到最近 loop。并发退出会停止派发新项并取消未完成同伴，已完成副作用不回滚。
- 总运行至多 5000 个节点步骤；最终结果也受约 1 MB 节点 JSON 限制。

## 源码与现有验证

- [修复前嵌套退出证据](../验证/边界与存量流程证据.json)：初次审计中 null/remove 曾吞退出信号，保留为历史。
- [修复回归：三策略顺序/并发、同伴取消、最近 loop、人工恢复、用户取消](../../../tests/nested-loop-control.test.ts)。
- [修复说明](../验证/问题/01-迭代吞掉退出循环.md)。
- [实际容器实现](../../../src/host/runtime.ts)。
- [限制和子图验证](../../../src/host/validation.ts)。
- [缺省子图构建](../../../src/client/nodes.ts)。
- [测试：三种失败模式、并发上限、结果顺序、空数组](../../../tests/runtime-expanded.test.ts)。
- [测试：嵌套模型与 waiting 快照](../../../tests/runtime-model-defaults.test.ts)。
- [测试：实际 JS→列表→迭代→人工→内置时间工具](../../../tests/expanded-flows.test.ts)。

初次审计已统一运行相关自动测试，并以[20类型集成链](../../../tests/graphon-capability-audit.test.ts)验证真实Graphon调度；模型响应使用明示替身，不等于用户真实服务或生产解析质量已通过。Python用户代码等变体以[验证范围](../验证/01-验证范围与结果.md)为准；未调用收费模型或外网MCP。本次新增修复的最终统一结果及宿主界面验收另行汇总。

## 相关节点

[用户输入](input-用户输入.md)、[输出](output-输出.md)、[循环](loop-循环.md)、[退出循环](exit_loop-退出循环.md)、[变量赋值](assigner-变量赋值.md)
