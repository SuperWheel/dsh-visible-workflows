# 参数提取器（extractor）

[返回手册总索引](../README.md) · [节点执行矩阵](README.md)

类型身份：`extractor`。常见别名：模型参数提取。核验日期：2026-10-16。

## 用途

由模型从文本提取预声明字段，并将解析/类型失败转换为显式成功标记供下游判断。

## 输入与配置

- prompt、inputs、DSH模型/强度/角色；`parameters[]`：name/type/description/required，最多40项，类型为string/number/boolean/object/array。

## 输出

- 成功：声明字段、text原始响应、json对象、`__is_success:1`、`__reason:""`。
- 模型已成功返回但JSON/字段/类型校验失败：text原始响应、`__is_success:0`、__reason；不能假定声明字段或json存在。

## Graphon 与具体执行者

Graphon 调度；TS 附加参数提取system指令并调用DSH模型，然后做顶层字段校验。与LLM结构化输出不同，解析失败在此节点转为数据输出，不直接将整条运行标failed。

共同边界：Graphon 接收当前层的节点 ID、kind 和连线；具体配置、变量作用域、模型凭证及节点副作用仍由已认证 DSH Host 持有。详见[节点共同执行规则](README.md#共同执行规则)。

## 前置条件与限制

- 自定义输出/组/变量字段应避免与本节点附加的 text、json、variables 等协议字段重名；实现的对象展开与后置写入可能覆盖同名字段，不是无限制自定义命名空间。
- 模型提供方失败/取消仍是节点执行失败；只有返回后的参数解析/校验失败被转成标记。
- 必填默认true（仅显式false可缺失），校验非完整JSON Schema；不自动纠错重试。
- 下游宜先用if检查 __is_success，再引用字段；__is_success为number而非boolean。默认DSH模型和角色规则与LLM一致。

## 源码与现有验证

- [提取与失败标记](../../../src/host/runtime.ts#L390)。
- [顶层类型校验](../../../src/host/runtime.ts#L109)。
- [参数 schema](../../../src/shared/workflow-validation.ts#L45)。
- [测试：必填字段/类型错误产生标记，合法提取成功](../../../tests/runtime-expanded.test.ts#L34)。
- [测试：提取成功标记为number而非boolean](../../../tests/variable-browser.test.tsx#L20)。
- [测试：共用模型提供方错误与取消边界](../../../tests/runtime-llm.test.ts#L17)。

本轮已统一运行相关自动测试，并以[20类型集成链](../../../tests/graphon-capability-audit.test.ts)验证真实Graphon调度；模型响应使用明示替身，不等于用户真实服务或生产解析质量已通过。Python用户代码等变体以[验证范围](../验证/01-验证范围与结果.md)为准；未调用收费模型或外网MCP。

## 相关节点

[大语言模型](llm-大语言模型.md)、[条件分支](if-条件分支.md)、[模板转换](template-模板转换.md)
