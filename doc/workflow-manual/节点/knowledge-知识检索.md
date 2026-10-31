# 知识检索（knowledge）

[返回手册总索引](../README.md) · [节点执行矩阵](README.md)

类型身份：`knowledge`。常见别名：本地关键词检索。核验日期：2026-10-16。

## 用途

从当前工作区的指定文本文件中找出与查询词重叠的片段，供后续 LLM 引用。

## 输入与配置

- `query` 支持上游变量；`sources[]` 为工作区路径，保存 schema 最多 20 个。
- `topK`、`threshold`：UI 和实际结果最多 20，threshold 为 0–1 词项命中比例。

## 输出

- `text`：附来源名的片段拼接；`results` 与 `result`：{source,content,score} 数组；`method:"local_keyword"`；`count`。

## Graphon 与具体执行者

Graphon 调度后，TS knowledge adapter 用 extractDocument 读 UTF-8 文件；按每 800 字符起步取最长 1000 字符块。查询拆成英文数字词或单个中日韩汉字；命中词种类/查询词种类计分，排序截取。没有调用模型或 Graphon 原生知识库。

共同边界：Graphon 接收当前层的节点 ID、kind 和连线；具体配置、变量作用域、模型凭证及节点副作用仍由已认证 DSH Host 持有。详见[节点共同执行规则](README.md#共同执行规则)。

## 前置条件与限制

- 不是向量检索、embedding、reranker、Dify 知识库/数据集连接器或语义召回；轻量分词计数也不会把它变为向量检索。
- 只能读取本地轻量文本后缀；PDF/DOCX/图片应先通过 document 的工具/Agent 路径解析并自行落为支持来源，当前节点不会自动委托解析。
- 空查询、无检索词、无来源会失败；无匹配返回空数组。源码适配器接受最多 50 个来源，但正常保存 schema 已收紧至 20；schema 的 TopK 50 不代表实际返回 50。
- 本轮20类型全链路以真实Graphon及生产适配器跑通本地关键词检索；仍未发现专门覆盖完整排名/TopK的用例，不能标为语义检索验收。

## 源码与现有验证

- [20类型实际引擎与生产适配器全链路](../../../tests/graphon-capability-audit.test.ts)：真实本地文件知识检索已通过Graphon路径。
- [关键词分块与评分](../../../src/host/execution-adapters.ts#L251)。
- [保存配置上限](../../../src/shared/workflow-validation.ts#L35)。
- [UI 明示关键词与 TopK 上限](../../../src/client/node-config.tsx#L28)。
- [测试：共用文本读取、附件数组和工作区越界保护（不等于检索排名覆盖）](../../../tests/tool-adapters.test.ts#L63)。
- [测试：共用轻量文件格式/UTF-8/二进制边界](../../../tests/document-adapters.test.ts#L25)。

本轮已统一运行相关自动测试，并以[20类型集成链](../../../tests/graphon-capability-audit.test.ts)验证真实Graphon调度；模型响应使用明示替身，不等于用户真实服务或生产解析质量已通过。Python用户代码等变体以[验证范围](../验证/01-验证范围与结果.md)为准；未调用收费模型或外网MCP。

## 相关节点

[文档提取器](document-文档提取器.md)、[大语言模型](llm-大语言模型.md)、[列表操作](list-列表操作.md)
