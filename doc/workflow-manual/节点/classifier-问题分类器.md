# 问题分类器（classifier）

[返回手册总索引](../README.md) · [节点执行矩阵](README.md)

类型身份：`classifier`。常见别名：模型分类分支。核验日期：2026-10-16。

## 用途

让模型从预先定义的类别中选出一个稳定类别 ID，并只激活对应分支。

## 输入与配置

- `prompt`、`inputs`、DSH 模型/强度/角色；`classes[]` 中的 id、label、可选 description。最多 20 类，执行时至少一类且 ID 不重复。

## 输出

- `text` 与 `class_label` 为类别名称；`class_id` 为稳定出口；`class_name` 为 description，未填时为名称。
- 运行记录 selectedPort=类别 ID；Graphon 依该出口激活边。

## Graphon 与具体执行者

TS runtime 拼分类 system 指令，模型必须返回 {"class_id":"ID"}。插件校验为已定义类别后，把 selectedPort 反馈给 Graphon 的桥接分支节点处理激活/跳过。

共同边界：Graphon 接收当前层的节点 ID、kind 和连线；具体配置、变量作用域、模型凭证及节点副作用仍由已认证 DSH Host 持有。详见[节点共同执行规则](README.md#共同执行规则)。

## 前置条件与限制

- 默认 DSH 模型/强度、角色快照与 LLM 一致；未指定有效模型无法执行。
- 模型格式错误或未知类别直接失败，不回退第一类或虚构“其他”；若需其他类须明确配置。
- 不是无需模型的条件判断，也不是多标签同时命中；没有自动 JSON 修复重试。

## 源码与现有验证

- [分类提示与输出校验](../../../src/host/runtime.ts#L390)。
- [桥接分支映射](../../../runtime/graphon_bridge/main.py#L107)。
- [分类配置与出口验证](../../../src/shared/workflow-validation.ts#L104)。
- [测试：分类必须返回已定义 ID，未知 ID 明确失败](../../../tests/runtime-expanded.test.ts#L29)。
- [测试：共用宿主模型流/取消/强度契约](../../../tests/runtime-llm.test.ts#L17)。

本轮已统一运行相关自动测试，并以[20类型集成链](../../../tests/graphon-capability-audit.test.ts)验证真实Graphon调度；模型响应使用明示替身，不等于用户真实服务或生产解析质量已通过。Python用户代码等变体以[验证范围](../验证/01-验证范围与结果.md)为准；未调用收费模型或外网MCP。

## 相关节点

[条件分支](if-条件分支.md)、[大语言模型](llm-大语言模型.md)、[变量聚合器](aggregator-变量聚合器.md)
