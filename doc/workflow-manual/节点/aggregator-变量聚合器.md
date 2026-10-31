# 变量聚合器（aggregator）

[返回手册总索引](../README.md) · [节点执行矩阵](README.md)

类型身份：`aggregator`。常见别名：互斥分支汇合。核验日期：2026-10-16。

## 用途

把不同互斥分支的一个可用变量统一到组名称，保留 false、0、空字符串等合法值。

## 输入与配置

- `groups[]`：每组 name 和候选变量路径 variables[]；最多40组，每组1–40个路径。

## 输出

- 各组名对应的原 JSON 值；`json` 为组结果对象；text 为首值字符串或整个组对象的 JSON 文本。

## Graphon 与具体执行者

Graphon 处理分支激活、跳过路径与汇合就绪；TS 逐个候选读取变量，只忽略 MissingValue，每组要求恰好一个存在的值。

共同边界：Graphon 接收当前层的节点 ID、kind 和连线；具体配置、变量作用域、模型凭证及节点副作用仍由已认证 DSH Host 持有。详见[节点共同执行规则](README.md#共同执行规则)。

## 前置条件与限制

- 自定义输出/组/变量字段应避免与本节点附加的 text、json、variables 等协议字段重名；实现的对象展开与后置写入可能覆盖同名字段，不是无限制自定义命名空间。
- 这是互斥选择，不是并行结果 merge/join。0个或2个以上有效值都失败；false/0/空字符串/对象/null若字段存在均计为一个有效值。
- 只忽略不存在或未产出路径，不忽略任意执行错误。不能自动等待未连接上游或按“第一个非空”选择。
- 没有自动类型统一或多组重名防覆盖的额外语义，组名应唯一。

## 源码与现有验证

- [聚合实现](../../../src/host/runtime.ts#L357)。
- [聚合 schema](../../../src/shared/workflow-validation.ts#L42)。
- [变量读取 MissingValue](../../../src/host/runtime.ts#L26)。
- [测试：保留 false 并拒绝两个并行可用候选](../../../tests/runtime-expanded.test.ts#L49)。
- [测试：Graphon 跳过支路不阻塞汇合](../../../tests/runtime.test.ts#L60)。

本轮已统一运行相关自动测试，并以[20类型集成链](../../../tests/graphon-capability-audit.test.ts)验证真实Graphon调度；模型响应使用明示替身，不等于用户真实服务或生产解析质量已通过。Python用户代码等变体以[验证范围](../验证/01-验证范围与结果.md)为准；未调用收费模型或外网MCP。

## 相关节点

[条件分支](if-条件分支.md)、[问题分类器](classifier-问题分类器.md)、[列表操作](list-列表操作.md)
