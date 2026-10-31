# 条件分支（if）

[返回手册总索引](../README.md) · [节点执行矩阵](README.md)

类型身份：`if`。常见别名：IF／ELIF／ELSE。核验日期：2026-10-16。

## 用途

对已存在的类型化变量做确定性判断，不消耗模型调用。

## 输入与配置

- 新版 `cases[]`：每组 id、logic=and/or、conditions[]；按列表顺序匹配首组，未命中走 false。最多 20 组，每组 1–30 条。
- 兼容简版 variable/operator/value，出口 true/false。比较变量使用稳定路径，值可包含引用。
- 支持空/非空、等于/不等于、包含/不包含、开头/结尾以及数值大小比较。

## 输出

- `text`、`branch`：命中出口 ID；`result` 仅表示出口是否字面等于 true。新版自定义 case 命中时 result 可能仍为 false，应读取 branch。

## Graphon 与具体执行者

TS matches 比较变量，按首命中选择 selectedPort；Graphon 负责该出口的边激活、其他路径跳过及汇合依赖。不是调用 LLM 的分类器。

共同边界：Graphon 接收当前层的节点 ID、kind 和连线；具体配置、变量作用域、模型凭证及节点副作用仍由已认证 DSH Host 持有。详见[节点共同执行规则](README.md#共同执行规则)。

## 前置条件与限制

- 空值定义为 null、空字符串或空数组；false 与 0 不当作空。不存在的变量会失败，非空判断也不会吞掉不存在字段。
- 数值比较要求合法数字；等值按 JSON 序列化比较。只选择首个匹配 case，不是所有 true 分支并行。
- 普通连线必须无环；循环请用 loop 容器。IF 出口必须使用声明 ID/false 或兼容 true/false。

## 源码与现有验证

- [比较语义](../../../src/host/runtime.ts#L68)。
- [分支选择](../../../src/host/runtime.ts#L298)。
- [出口与无环校验](../../../src/shared/workflow-validation.ts#L104)。
- [测试：类型化 boolean 与顺序 ELIF 首命中](../../../tests/runtime-expanded.test.ts#L25)。
- [测试：跳过支路和拓扑汇合](../../../tests/runtime.test.ts#L60)。
- [测试：循环连线和错误条件出口拒绝](../../../tests/runtime.test.ts#L82)。

本轮已统一运行相关自动测试，并以[20类型集成链](../../../tests/graphon-capability-audit.test.ts)验证真实Graphon调度；模型响应使用明示替身，不等于用户真实服务或生产解析质量已通过。Python用户代码等变体以[验证范围](../验证/01-验证范围与结果.md)为准；未调用收费模型或外网MCP。

## 相关节点

[问题分类器](classifier-问题分类器.md)、[变量聚合器](aggregator-变量聚合器.md)、[循环](loop-循环.md)
