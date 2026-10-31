# 变量赋值（assigner）

[返回手册总索引](../README.md) · [节点执行矩阵](README.md)

类型身份：`assigner`。常见别名：Variable Assigner。核验日期：2026-10-16。

## 用途

修改当前作用域 vars，用于循环状态、数值累计和数组更新。

## 输入与配置

- `assignments[]`：name、operation、可选 value，最多40项。
- 操作 set/clear/add/subtract/multiply/divide/append/extend/pop/shift；value 支持 JSON 字面量或变量引用。

## 输出

- 各变更字段、`variables`（只含本次变更）、`json`、text JSON；后续可用 `{{vars.name}}`。

## Graphon 与具体执行者

Graphon 调度；TS 顺序执行 assignments 并更新 scope.variables。循环轮次共享 vars；迭代每项克隆 vars。人工恢复时，已成功 assigner 的缓存 variables 重新应用到当前重建作用域，不重放外部操作。

共同边界：Graphon 接收当前层的节点 ID、kind 和连线；具体配置、变量作用域、模型凭证及节点副作用仍由已认证 DSH Host 持有。详见[节点共同执行规则](README.md#共同执行规则)。

## 前置条件与限制

- 自定义输出/组/变量字段应避免与本节点附加的 text、json、variables 等协议字段重名；实现的对象展开与后置写入可能覆盖同名字段，不是无限制自定义命名空间。
- 数值运算两侧必须为数字且结果有限，除零会失败；数组操作要求已有数组，extend还要求value数组。
- clear 根据旧值类型设为[]/空串/0/false/{}/null；pop/shift返回更新数组，不返回被移除项。
- 不是修改输入字段、上游节点结果或保存全局会话变量；根运行/子作用域之间的持久语义由容器决定。没有事务或并发共享变量锁。

## 源码与现有验证

- [变量赋值实现](../../../src/host/runtime.ts#L362)。
- [恢复时缓存变量回放](../../../src/host/runtime.ts#L281)。
- [赋值 schema](../../../src/shared/workflow-validation.ts#L44)。
- [测试：循环累计共享变量](../../../tests/runtime-expanded.test.ts#L98)。
- [测试：人工恢复仍保留变量且不重放工具](../../../tests/runtime-expanded.test.ts#L112)。
- [测试：真实循环状态链](../../../tests/expanded-flows.test.ts#L36)。

本轮已统一运行相关自动测试，并以[20类型集成链](../../../tests/graphon-capability-audit.test.ts)验证真实Graphon调度；模型响应使用明示替身，不等于用户真实服务或生产解析质量已通过。Python用户代码等变体以[验证范围](../验证/01-验证范围与结果.md)为准；未调用收费模型或外网MCP。

## 相关节点

[循环](loop-循环.md)、[迭代](iteration-迭代.md)、[代码执行](code-代码执行.md)
