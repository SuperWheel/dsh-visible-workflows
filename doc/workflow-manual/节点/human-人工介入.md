# 人工介入（human）

[返回手册总索引](../README.md) · [节点执行矩阵](README.md)

类型身份：`human`。常见别名：Human Input／人工确认。核验日期：2026-10-16。

## 用途

保存运行检查点，等待用户填写表单并选择明确操作，或到超时出口。

## 输入与配置

- `prompt` 支持变量；`fields[]` 与 input 同类，可使用渲染后的默认值。
- `actions[]`：稳定 id/label，1–20 项；`timeoutSeconds` 1–2592000，未设时运行器按 259200 秒（3 天）等待。

## 输出

- 表单类型化字段、text JSON，以及 __action_id、__action_value、__rendered_content。
- 正常操作同时激活所选动作 ID 出口及稳定 default 出口（界面为「常规继续」，说明为「任一常规行动后」）；超时只选 timeout，没有 timeout 边则运行失败。
- 画布按行动原顺序、default、timeout 展示出口。修改名称保留合法默认边；删除行动仅移除该行动边，不误删显式或省略 port 的 default 边。

## Graphon 与具体执行者

TS 记录 waitingNodeId/waitingExecutionId 与实际表单，桥接把 pause 交给 Graphon 释放当前图。用户回答后重建图，成功步骤用持久 data 回放给引擎，不重新执行其外部副作用。定时器与恢复由 TS 管理。

共同边界：Graphon 接收当前层的节点 ID、kind 和连线；具体配置、变量作用域、模型凭证及节点副作用仍由已认证 DSH Host 持有。详见[节点共同执行规则](README.md#共同执行规则)。

## 前置条件与限制

- 无字段也会暂停，不是空表单自动通过；多动作必须选择有效 __action。
- 同一次等待不能重复答复；嵌套顺序容器可恢复，含 human 的并行 iteration 明确拒绝。
- 包含 human 的工作流不能作为 workflow: 工具被另一工作流调用；须独立运行。
- 检查点缓存不等于外部工具权限持久化；重启后的 native/MCP 调用仍需有效宿主会话上下文，不能据持久运行文件推断权限仍在。

## 源码与现有验证

- [端口与配置保边回归](../../../tests/human-ports.test.tsx)、[画布实际 default 连边](../../../tests/canvas-ports.test.ts)。
- [初次契约差异与修复说明](../验证/问题/04-人工默认出口契约.md)。
- [答复/检查点/超时](../../../src/host/runtime.ts)。
- [运行暂停](../../../src/host/runtime.ts)。
- [成功步骤复用](../../../src/host/runtime.ts)。
- [子工作流限制](../../../src/host/index.ts)。
- [测试：工具后暂停、重启恢复不重放；无字段与超时出口](../../../tests/runtime-expanded.test.ts)。
- [测试：循环内人工暂停保持变量与已完成工具](../../../tests/runtime-expanded.test.ts)。
- [测试：含 human 的工作流工具不可用](../../../tests/tool-adapters.test.ts)。

初次审计已统一运行相关自动测试，并以[20类型集成链](../../../tests/graphon-capability-audit.test.ts)验证真实Graphon调度；模型响应使用明示替身，不等于用户真实服务或生产解析质量已通过。Python用户代码等变体以[验证范围](../验证/01-验证范围与结果.md)为准；未调用收费模型或外网MCP。本次新增修复的最终统一结果及宿主界面验收另行汇总。

## 相关节点

[用户输入](input-用户输入.md)、[迭代](iteration-迭代.md)、[循环](loop-循环.md)、[工具](tool-工具.md)
