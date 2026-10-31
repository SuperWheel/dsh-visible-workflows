# 退出循环（exit_loop）

[返回手册总索引](../README.md) · [节点执行矩阵](README.md)

类型身份：`exit_loop`。常见别名：Exit Loop；不等于 loop-end。核验日期：2026-10-16。

## 用途

在循环体中立即请求退出当前循环，将控制权返回容器后的节点。

## 输入与配置

- 无执行配置，config 必须为空对象；由图的摆放位置确定所属循环。

## 输出

- 执行记录为 success、text=退出循环；不作为普通数据加工节点向后继续运行。循环容器仍输出其最终变量与轮数。

## Graphon 与具体执行者

TS 抛出 ExitLoop 控制信号，桥接返回 control=exit_loop；Graphon 暂停本图并回报该控制结果，由最近 TS loop 捕获后结束。成功缓存再次恢复时仍抛退出信号，防止人工恢复多执行后续节点。

共同边界：Graphon 接收当前层的节点 ID、kind 和连线；具体配置、变量作用域、模型凭证及节点副作用仍由已认证 DSH Host 持有。详见[节点共同执行规则](README.md#共同执行规则)。

## 前置条件与限制

- 只能位于 loop 内部，包括验证器继承的嵌套 inLoop 范围；根流程或纯 iteration 内使用会拒绝。
- 当前画布没有出端口；不是普通 output，也不是可独立命名的 loop-end。
- 在 loop 内嵌套 iteration 时，terminate/null/remove 均透传退出信号，直到最近 loop 捕获；退出该 loop 后允许其外层继续。
- 并发项退出会停止派发并取消未完成同伴，不把同伴取消错误覆盖为本次退出失败；已完成副作用不会回滚。

## 源码与现有验证

- [修复前嵌套退出证据](../验证/边界与存量流程证据.json)：历史缺陷及[修复说明](../验证/问题/01-迭代吞掉退出循环.md)。
- [修复回归：所有迭代失败策略与并发、最近循环、恢复和取消](../../../tests/nested-loop-control.test.ts)。
- [信号产生与转换](../../../src/host/runtime.ts)。
- [退出位置与捕获](../../../src/host/runtime.ts)。
- [inLoop 验证](../../../src/host/validation.ts)。
- [测试：退出当前循环](../../../tests/runtime-expanded.test.ts)。
- [测试：人工恢复后缓存退出仍终止](../../../tests/runtime-expanded.test.ts)。
- [测试：循环外 Exit Loop 被拒绝](../../../tests/runtime-expanded.test.ts)。

初次审计已统一运行相关自动测试，并以[20类型集成链](../../../tests/graphon-capability-audit.test.ts)验证真实Graphon调度；模型响应使用明示替身，不等于用户真实服务或生产解析质量已通过。Python用户代码等变体以[验证范围](../验证/01-验证范围与结果.md)为准；未调用收费模型或外网MCP。本次新增修复的最终统一结果及宿主界面验收另行汇总。

## 相关节点

[循环](loop-循环.md)、[迭代](iteration-迭代.md)、[输出](output-输出.md)
