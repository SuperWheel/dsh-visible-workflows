# 循环（loop）

[返回手册总索引](../README.md) · [节点执行矩阵](README.md)

类型身份：`loop`。常见别名：Loop 容器；含内部 input/output 边界。核验日期：2026-10-16。

## 用途

重复执行子图，维护 vars 状态，在每轮结束后检查条件，或遇退出节点、次数上限结束。

## 输入与配置

- `body`：独立子图；`initialVariables`：合并继承变量与初始化映射。
- `maxIterations` 1–100（默认 10）；`until` 可选且每轮执行后检查。
- `outputVariable` 可选：最后一轮子节点路径；未设则输出结束时变量对象。

## 输出

- `text`、`result`/`json` 最终结果；`variables` 结束变量对象；`iterations` 实际轮数。

## Graphon 与具体执行者

Graphon 调度容器；TS 按轮次递归调用 Graphon 子图，所有轮次共享同一 vars 对象，各轮 values 从外层复制，index 从 0 开始。assigner 更新 vars。Graphon 不在普通图中接受回边。

共同边界：Graphon 接收当前层的节点 ID、kind 和连线；具体配置、变量作用域、模型凭证及节点副作用仍由已认证 DSH Host 持有。详见[节点共同执行规则](README.md#共同执行规则)。

## 前置条件与限制

- 是先执行至少一轮再检查 until；不会因为初始 until 已成立而零轮退出。
- input、output 是子图边界，loop-start、loop-end 不是独立 NodeKind，也没有单独的循环结束节点配置。
- 达到次数上限即结束并返回结果，不视为“必须满足 until”失败。输出选择上一轮未产生的变量仍可能失败。
- 并非无限循环；普通图回边被验证拒绝。嵌套层数保存最多 5，运行总步骤最多 5000。
- 退出只作用于最近捕获控制信号的 loop；嵌套 iteration 的三种失败策略均透传退出，退出内层 loop 后外层仍可继续。

## 源码与现有验证

- [修复前嵌套退出证据](../验证/边界与存量流程证据.json)：历史缺陷及[修复说明](../验证/问题/01-迭代吞掉退出循环.md)。
- [修复回归：退出最近 loop、并发清理、人工恢复](../../../tests/nested-loop-control.test.ts)。
- [循环与变量共享](../../../src/host/runtime.ts)。
- [循环 schema](../../../src/host/validation.ts)。
- [普通图无环及嵌套约束](../../../src/host/validation.ts)。
- [测试：变量累加与条件提前退出](../../../tests/runtime-expanded.test.ts)。
- [测试：退出当前循环并让外层接收状态](../../../tests/runtime-expanded.test.ts)。
- [测试：缓存退出与人工恢复不重放](../../../tests/runtime-expanded.test.ts)。
- [测试：实际循环第三轮退出](../../../tests/expanded-flows.test.ts)。

初次审计已统一运行相关自动测试，并以[20类型集成链](../../../tests/graphon-capability-audit.test.ts)验证真实Graphon调度；模型响应使用明示替身，不等于用户真实服务或生产解析质量已通过。Python用户代码等变体以[验证范围](../验证/01-验证范围与结果.md)为准；未调用收费模型或外网MCP。本次新增修复的最终统一结果及宿主界面验收另行汇总。

## 相关节点

[用户输入](input-用户输入.md)、[输出](output-输出.md)、[变量赋值](assigner-变量赋值.md)、[退出循环](exit_loop-退出循环.md)、[迭代](iteration-迭代.md)
