# 大语言模型（llm）

[返回手册总索引](../README.md) · [节点执行矩阵](README.md)

类型身份：`llm`。常见别名：LLM。核验日期：2026-10-16。

## 用途

使用 DSH 已配置提供方完成一次文本生成，可选对返回 JSON 做字段与类型校验。

## 输入与配置

- `prompt`、可选 `inputs`；`model:{provider,model}`、`effort`、`rolePresetId`。
- `outputSchema[]`：最多 40 个字段，类型 string/number/boolean/object/array，可标必填；未显式 required=false 的字段按必填处理。

## 输出

- 普通模式仅 `{text}`；结构化模式增加解析后顶层字段和 `json`，text 仍是模型原始返回。
- 运行记录可存近似 tokenEstimate；并未输出 Dify 的 reasoning_content、usage 等完整模型元数据。

## Graphon 与具体执行者

Graphon 调度；TS runtime 渲染提示词、拼角色 system、调用轻量分词估计后，经 harnessModels → ctx.llm.stream 执行真实模型。模型流聚合成最终文本，当前不是向下游逐 token 传递。

共同边界：Graphon 接收当前层的节点 ID、kind 和连线；具体配置、变量作用域、模型凭证及节点副作用仍由已认证 DSH Host 持有。详见[节点共同执行规则](README.md#共同执行规则)。

## 前置条件与限制

- 自定义输出/组/变量字段应避免与本节点附加的 text、json、variables 等协议字段重名；实现的对象展开与后置写入可能覆盖同名字段，不是无限制自定义命名空间。
- 默认模型取本工作区当前会话选择，缺省时取 DSH 默认；启动时冻结到运行副本，显式节点模型/强度不被覆盖。没有有效配置时明确失败，不另建 API Key 或悄悄选目录第一项。
- 仅同模型且节点 effort 未指定时继承快照强度；宿主能力校验不支持的强度会拒绝。Agent 生成/修改另受当前 Agent 强度上限约束，见节点矩阵的模型规则。
- 只发送一个 user 文本消息及 system 角色提示词；没有独立 temperature/max_tokens、vision、消息列表或原生 tool-call 配置。
- JSON 校验为顶层字段/类型检查，不是完整 JSON Schema；无效 JSON/必填缺失使 LLM 节点失败，无自动修复重试。模型断流、max-tokens 或非 stop 完成不会伪报成功。

## 源码与现有验证

- [模型执行](../../../src/host/runtime.ts#L390)。
- [宿主模型调用契约](../../../src/host/llm.ts#L23)。
- [默认模型和强度继承](../../../src/host/model-defaults.ts#L26)。
- [自动生成强度上限](../../../src/host/index.ts#L149)。
- [测试：真实 SDK 形状测试替身：文本流完成、断流、取消和不支持强度](../../../tests/runtime-llm.test.ts#L17)。
- [测试：会话/DSH 默认、显式覆盖、嵌套与等待快照](../../../tests/runtime-model-defaults.test.ts#L23)。
- [测试：UI 不擅自填首项或丢失用户显式选择](../../../tests/model-settings.test.tsx#L38)。
- [测试：统一预设更新只影响未来运行](../../../tests/runtime.test.ts#L109)。

本轮已统一运行相关自动测试，并以[20类型集成链](../../../tests/graphon-capability-audit.test.ts)验证真实Graphon调度；模型响应使用明示替身，不等于用户真实服务或生产解析质量已通过。Python用户代码等变体以[验证范围](../验证/01-验证范围与结果.md)为准；未调用收费模型或外网MCP。

## 相关节点

[工具调用 Agent](agent-工具调用Agent.md)、[问题分类器](classifier-问题分类器.md)、[参数提取器](extractor-参数提取器.md)
