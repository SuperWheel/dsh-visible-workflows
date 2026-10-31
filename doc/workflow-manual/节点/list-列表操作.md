# 列表操作（list）

[返回手册总索引](../README.md) · [节点执行矩阵](README.md)

类型身份：`list`。常见别名：筛选／排序／截取。核验日期：2026-10-16。

## 用途

对类型化数组进行确定性筛选、排序和前N项截取。

## 输入与配置

- `listSource`：数组引用或JSON数组字面量，最多1000项。
- 可选filter采用条件比较并在每项scope暴露item/index；sort为asc/desc；limit可选且保存schema为1–20。

## 输出

- text JSON、result/json数组；first_record/last_record为原类型首尾值，空数组为null。

## Graphon 与具体执行者

Graphon调度；TS listReference读取数组后依次filter→sort→slice，保留JSON类型，不调用模型或Graphon内置列表节点。

共同边界：Graphon 接收当前层的节点 ID、kind 和连线；具体配置、变量作用域、模型凭证及节点副作用仍由已认证 DSH Host 持有。详见[节点共同执行规则](README.md#共同执行规则)。

## 前置条件与限制

- 排序仅同类型string/number/boolean；对象、混合类型、数组元素不能直接排序，无对象字段排序选项。
- limit在UI显示默认20，但未写入config.limit时运行器不截取；不得将界面展示值当作已保存行为。
- first_record/last_record是动态JSON类型，不恒为字符串；不存在item字段的filter会失败而非忽略。
- 没有去重、分组、SQL样式查询或无限大数组流式处理；复杂变换用code，逐项模型/工具任务用iteration。

## 源码与现有验证

- [列表引用与1000项限制](../../../src/host/runtime.ts#L60)。
- [筛选排序截取](../../../src/host/runtime.ts#L378)。
- [可保存limit](../../../src/shared/workflow-validation.ts#L47)。
- [测试：类型保持、筛选降序截取、空数组首尾null](../../../tests/runtime-expanded.test.ts#L39)。
- [测试：首尾字段按成功输出推断动态类型](../../../tests/variable-browser.test.tsx#L20)。
- [测试：实际代码结果进入列表后再迭代](../../../tests/expanded-flows.test.ts#L21)。

本轮已统一运行相关自动测试，并以[20类型集成链](../../../tests/graphon-capability-audit.test.ts)验证真实Graphon调度；模型响应使用明示替身，不等于用户真实服务或生产解析质量已通过。Python用户代码等变体以[验证范围](../验证/01-验证范围与结果.md)为准；未调用收费模型或外网MCP。

## 相关节点

[迭代](iteration-迭代.md)、[代码执行](code-代码执行.md)、[条件分支](if-条件分支.md)
