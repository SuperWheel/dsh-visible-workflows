# 模板转换（template）

[返回手册总索引](../README.md) · [节点执行矩阵](README.md)

类型身份：`template`。常见别名：有限 Jinja 兼容模板。核验日期：2026-10-16。

## 用途

把具名输入或上游值格式化成文本，支持受限循环、条件与常用过滤器。

## 输入与配置

- `text` 模板；可选 `inputs`：具名类型化映射。模板优先从具名输入、局部变量和稳定节点引用读取。
- 支持 {{表达式}}、{% for ... %}/{% if/elif/else ... %} 与注释；过滤器 default/upper/lower/trim/length/join/first/last/tojson/replace/sort。

## 输出

- 仅 `{text:string}`。没有自动结构化 result；需要 JSON 对象请使用 code 或内置 JSON 工具。

## Graphon 与具体执行者

Graphon 调度；TS renderDataTemplate 解析有限数据表达式并迭代处理，不 eval JavaScript、不启动 Python/Jinja 环境。

共同边界：Graphon 接收当前层的节点 ID、kind 和连线；具体配置、变量作用域、模型凭证及节点副作用仍由已认证 DSH Host 持有。详见[节点共同执行规则](README.md#共同执行规则)。

## 前置条件与限制

- 不是完整 Jinja2：无宏、import、任意调用/运算、对象原型访问或自定义过滤器。未知标签/过滤器明确报错。
- 可选缺失值需 default；嵌套最多20层、处理最多10000步、单循环1000项、输出400000字符。
- output 节点只支持普通插值，不具有本节点所有模板控制语法。

## 源码与现有验证

- [有限模板解析器](../../../src/host/template.ts#L3)。
- [具名映射与模板调用](../../../src/host/runtime.ts#L386)。
- [配置编辑器](../../../src/client/node-config.tsx#L36)。
- [测试：for/if/default/具名对象以及拒绝构造器调用](../../../tests/runtime-expanded.test.ts#L44)。
- [测试：模板输出持久化](../../../tests/runtime.test.ts#L29)。
- [测试：编号变动不破坏稳定引用](../../../tests/runtime.test.ts#L69)。

本轮已统一运行相关自动测试，并以[20类型集成链](../../../tests/graphon-capability-audit.test.ts)验证真实Graphon调度；模型响应使用明示替身，不等于用户真实服务或生产解析质量已通过。Python用户代码等变体以[验证范围](../验证/01-验证范围与结果.md)为准；未调用收费模型或外网MCP。

## 相关节点

[输出](output-输出.md)、[代码执行](code-代码执行.md)、[工具](tool-工具.md)
