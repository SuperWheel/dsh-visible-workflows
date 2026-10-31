# 用户输入（input）

[返回手册总索引](../README.md) · [节点执行矩阵](README.md)

类型身份：`input`。常见别名：Start／开始节点；也用于容器子图入口。核验日期：2026-10-16。

## 用途

声明整条流程的输入字段，并作为每层 Graphon 图的唯一入口。

## 输入与配置

- `fields[]`：`name`、`label`、`required`；可选 `defaultValue`、`type`、`options`、`hidden`。最多 40 个字段。
- 类型为 text、paragraph、number、boolean、select、json、file、files；调用接口先接收字符串，运行器再转为对应 JSON 类型。

## 输出

- 未声明同名字段时，`text` 为全部类型化输入的 JSON 文本；各字段也直接输出。若输入字段本身名为 text，它会覆盖汇总 text（常见文本流程即如此）。始终可用 `{{input.字段名}}` 引用。
- 文件上传转换为本次运行私有附件引用；运行快照不应包含原始 base64。
- 下游拿到的 file 字段是附件对象 `{name, mimeType, size}`（另有 Host 内部文件身份），不含正文，也没有 path；files 字段是这种对象的数组。读正文用[文档提取器](document-文档提取器.md)，`source` 写 `input.字段`。不要把附件对象传给 read 等要求路径字符串的工具，编译器会直接拒绝并提示改用文档提取器（2026-10-26）。

## Graphon 与具体执行者

Graphon 将 kind=input 的桥接节点识别为 ROOT；字段补齐、类型校验与附件入库由 TypeScript WorkflowRuntime 完成。子图 input 复用外层 scope.input，不会再次弹出一套输入表单；item/index/vars 由容器提供。

共同边界：Graphon 接收当前层的节点 ID、kind 和连线；具体配置、变量作用域、模型凭证及节点副作用仍由已认证 DSH Host 持有。详见[节点共同执行规则](README.md#共同执行规则)。

## 前置条件与限制

- 每层图必须恰好一个 input，禁止入边，所有可执行节点须从它可达。
- 缺必填字段创建 waiting 运行，由询问框补齐同一次运行；未知字段、非法布尔/数值/JSON/枚举会拒绝。隐藏字段不可必填。
- 普通字段最多 200000 字符；单次上传合计 2 MB，files 最多 10 个。不是环境变量或密钥管理节点。
- 没有独立 NodeKind=start、loop-start；不要把视觉名称解释成额外运行时实现。

## 源码与现有验证

- [字段协议与配置](../../../src/shared/workflow-validation.ts#L11)。
- [类型化输入及等待恢复](../../../src/host/runtime.ts#L88)。
- [ROOT 映射](../../../runtime/graphon_bridge/main.py#L139)。
- [测试：缺失输入只等待，同一次运行回答后执行且不能重复提交](../../../tests/runtime.test.ts#L42)。
- [测试：拒绝未声明的输入字段](../../../tests/runtime.test.ts#L90)。
- [测试：真实文档适配器处理上传附件；私有引用和日志边界](../../../tests/runtime-expanded.test.ts#L123)。

本轮已统一运行相关自动测试，并以[20类型集成链](../../../tests/graphon-capability-audit.test.ts)验证真实Graphon调度；模型响应使用明示替身，不等于用户真实服务或生产解析质量已通过。Python用户代码等变体以[验证范围](../验证/01-验证范围与结果.md)为准；未调用收费模型或外网MCP。

## 相关节点

[输出](output-输出.md)、[迭代](iteration-迭代.md)、[循环](loop-循环.md)、[文档提取器](document-文档提取器.md)
