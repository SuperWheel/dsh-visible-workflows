# 输出（output）

[返回手册总索引](../README.md) · [节点执行矩阵](README.md)

类型身份：`output`。常见别名：End／结束节点；容器内部输出。核验日期：2026-10-16。

## 用途

将选定文本或变量声明为流程结果。它不是“立即终止所有支路”的全局停止命令。

## 输入与配置

- `text`：支持普通 `{{变量路径}}` 插值；`inputs` 可将具名数据合入本节点局部 input。
- `outputName`：根流程结果名称，默认 result。

## 输出

- 节点输出 `{text:string}`。根层写入 `run.outputs[outputName]`；子流程输出保留在子层节点结果中，需由容器 outputVariable 显式收集。

## Graphon 与具体执行者

Graphon 按依赖调度普通桥接节点；TS runtime 插值文本、记录节点结果，并且仅在非容器内部时写 run.outputs。其他仍激活的分支继续执行。

共同边界：Graphon 接收当前层的节点 ID、kind 和连线；具体配置、变量作用域、模型凭证及节点副作用仍由已认证 DSH Host 持有。详见[节点共同执行规则](README.md#共同执行规则)。

## 前置条件与限制

- 画布不提供 output 的出端口，但运行器逻辑不是全局 abort；不得用“结束”推断其他并行支路被取消。
- 第二个实际激活的同名根输出在执行渲染和写入前失败，保留第一个结果；多个都会激活的根产物使用不同 outputName 或先汇总。
- 互斥分支可以共享输出名；子层输出不写根结果字典；人工恢复时同一成功输出的缓存重放不算新冲突。
- 输出是文本；对象/数组插值会 JSON 序列化。这里没有模板节点完整的 for/if 语法。
- 没有独立 NodeKind=end 或 loop-end；内部 input/output 仍是相同类型。

## 源码与现有验证

- [输出写入与桥接结果](../../../src/host/runtime.ts)。
- [修复回归：同名根输出冲突、互斥分支、人工恢复、子层隔离](../../../tests/output-collision.test.ts)。
- [修复前历史与当前冲突契约](../验证/问题/03-同名输出覆盖.md)。
- [文本渲染](../../../src/host/runtime.ts)。
- [画布端口约束](../../../src/client/nodes.ts)。
- [测试：执行模板并保留结果，重开存储仍可读取](../../../tests/runtime.test.ts)。
- [测试：分支只产生被激活输出](../../../tests/runtime-expanded.test.ts)。
- [测试：循环结果返回容器外输出](../../../tests/expanded-flows.test.ts)。

初次审计已统一运行相关自动测试，并以[20类型集成链](../../../tests/graphon-capability-audit.test.ts)验证真实Graphon调度；模型响应使用明示替身，不等于用户真实服务或生产解析质量已通过。Python用户代码等变体以[验证范围](../验证/01-验证范围与结果.md)为准；未调用收费模型或外网MCP。本次新增修复的最终统一结果及宿主界面验收另行汇总。

## 相关节点

[用户输入](input-用户输入.md)、[模板转换](template-模板转换.md)、[迭代](iteration-迭代.md)、[循环](loop-循环.md)
