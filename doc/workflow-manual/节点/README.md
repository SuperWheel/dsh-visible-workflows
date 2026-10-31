# 节点执行矩阵

[返回手册总索引](../README.md)

核验日期：2026-10-16。依据当前 NodeKind、保存验证器、Host 运行器和现有测试。这里确认的是本插件的真实可达执行路径，不是 Dify 全功能或 Graphon 原生节点兼容声明。

## 实际类型全集

当前有 **20 种 NodeKind**。Start/End 是 input/output 的视觉或概念别名；loop-start/loop-end 没有独立类型，循环子图使用现有 input/output。

| NodeKind | 原子笔记 | 调度/具体实现 | 核验结论 |
| --- | --- | --- | --- |
| `input` | [用户输入](input-用户输入.md) | Graphon桥接调度 → TS确定性逻辑 | 已找到执行分支及定向测试 |
| `output` | [输出](output-输出.md) | Graphon桥接调度 → TS确定性逻辑 | 已找到执行分支及定向测试 |
| `llm` | [大语言模型](llm-大语言模型.md) | Graphon桥接调度 → TS → DSH模型 | 真实宿主调用路径；模型测试替身覆盖 |
| `agent` | [工具调用 Agent](agent-工具调用Agent.md) | Graphon桥接调度 → TS受限Agent → DSH模型/真实工具 | 需模型和授权工具；非DSH主Agent |
| `tool` | [工具](tool-工具.md) | Graphon桥接调度 → ToolCatalog → 内置/宿主/OpenAPI/子流程 | 需具体工具能力/权限；不是Marketplace全集 |
| `knowledge` | [知识检索](knowledge-知识检索.md) | Graphon桥接调度 → TS文件关键词检索 | 生产适配器经Graphon跑通；缺完整检索排名定向测试 |
| `classifier` | [问题分类器](classifier-问题分类器.md) | Graphon桥接调度 → TS → DSH模型 | 真实宿主调用路径；模型测试替身覆盖 |
| `if` | [条件分支](if-条件分支.md) | Graphon桥接调度 → TS确定性逻辑 | 已找到执行分支及定向测试 |
| `human` | [人工介入](human-人工介入.md) | Graphon桥接调度 → TS确定性逻辑 | 已找到执行分支及定向测试 |
| `iteration` | [迭代](iteration-迭代.md) | Graphon桥接调度 → TS确定性逻辑 | 容器/控制可执行；有嵌套退出组合边界 |
| `loop` | [循环](loop-循环.md) | Graphon桥接调度 → TS确定性逻辑 | 容器/控制可执行；有嵌套退出组合边界 |
| `exit_loop` | [退出循环](exit_loop-退出循环.md) | Graphon桥接调度 → TS确定性逻辑 | 容器/控制可执行；有嵌套退出组合边界 |
| `code` | [代码执行](code-代码执行.md) | Graphon桥接调度 → QuickJS或完整沙箱下受限Python | JS可独立执行；Python需full sandbox |
| `template` | [模板转换](template-模板转换.md) | Graphon桥接调度 → TS确定性逻辑 | 已找到执行分支及定向测试 |
| `aggregator` | [变量聚合器](aggregator-变量聚合器.md) | Graphon桥接调度 → TS确定性逻辑 | 已找到执行分支及定向测试 |
| `document` | [文档提取器](document-文档提取器.md) | Graphon桥接调度 → TS本地/指定工具/受限模型Agent | 复杂解析能力取决于选定工具 |
| `assigner` | [变量赋值](assigner-变量赋值.md) | Graphon桥接调度 → TS确定性逻辑 | 已找到执行分支及定向测试 |
| `extractor` | [参数提取器](extractor-参数提取器.md) | Graphon桥接调度 → TS → DSH模型 | 真实宿主调用路径；模型测试替身覆盖 |
| `http` | [HTTP 请求](http-HTTP请求.md) | Graphon桥接调度 → 宿主Node fetch | 文本HTTP；错误状态需显式判断 |
| `list` | [列表操作](list-列表操作.md) | Graphon桥接调度 → TS确定性逻辑 | 已找到执行分支及定向测试 |

## 共同执行规则

- 每个节点在 Python Graphon 中都映射为自定义 `BridgeNode(dsh:bridge)`。没有为这20种类型加载 Graphon/Dify 内置 LLM、文档、Agent 等节点注册表。Graphon负责边激活、依赖就绪、跳过路径传播；具体节点回调由 TS WorkflowRuntime 与适配器执行。
- 保存图：每层1–200节点、最多1000边；含子图最多500节点、嵌套最多5层。可执行图每层恰好一个input、节点须入口可达、禁止普通连线回环，跨容器用输出变量。运行最多同时4条且同流程不允许重叠未结束运行，单次最多5000个执行记录。
- 数据引用使用稳定节点ID，完整 `{{变量}}` 作为输入映射时保留JSON类型，字符串中插值会序列化。显示编号或局部编号变化不改变身份。变量值不存在会明确失败，不伪造空结果。
- 模型运行前可做轻量分词估计，记录为estimated；它不是提供方实际usage或账单，也不替代知识检索索引。
- 运行使用保存流程的独立图快照及角色提示词快照。人工暂停恢复会把已成功结果回放给新Graphon图，不重放成功的外部调用。普通失败/中断没有自动恢复执行或通用重试配置；“新运行”可能再次产生工具副作用。
- 外层节点结果JSON最多约1000000字符；部分适配器还有2MB字节/字符限制，实际取较早触发的限制，不能只引用较大的内层限额。取消/引擎失败会向在途模型与适配器传播信号，但不承诺撤销已经完成的外部副作用。

## 模型与思考强度规则

1. 手动画布启动：节点显式model优先；否则读取本工作区当前会话选择（pending优先）或DSH默认模型。effort只有未指定且模型相同时才继承。值冻结于本次运行，保存草稿继续保持“跟随DSH”。
2. Agent自动创建/修改：默认使用当前请求Agent模型。新选其他模型拒绝，用户手动节点覆盖可保留；新思考强度不能超过当前Agent强度，无法排序的强度只允许沿用当前值。并非模型自己可以突破上限自由选路。
3. 模型调用统一经ctx.llm；不新增插件API Key配置、不私自安装提供方、不故障转移到别的模型。能力目录失效、强度不支持或流未完整完成会明确失败。
4. 角色预设只含提示词，模型/强度独立。运行启动快照决定本轮角色。普通模型节点未来运行读取最新预设；Agent 节点的子 Agent 卡片保存独立角色快照，预设修改后需显式更新，见[Agent 定义](agent-工具调用Agent.md)。

## 需明确保留的缺口

- **Dify原生节点实现为0/20，插件自定义可达分支为20/20。** 这不表示“不可运行”，而是运行责任在TS插件及宿主适配器；Graphon原生调度成功不等于Dify配置/输出兼容。
- 没有start/end/loop-start/loop-end额外NodeKind，没有通用重试、失败分支、任意Python依赖安装、向量知识库或Dify完整模型消息/输出参数面。
- knowledge采用关键词，已有20类型全链路通过Graphon的生产适配器测试，但仍缺专用完整检索排名用例；Python仅看到拒绝不安全语法与sandbox gate测试，不能标为全部平台安全执行已验收。
- 外层loop中内嵌iteration采用null/remove时，exit_loop控制信号会被单项catch当作错误；当前文档记录为待修复组合边界，不能用普通退出测试替代该场景。
- 文件/MCP解析、模型生成及宿主权限依赖真实配置。测试替身证明调用协议与拒绝边界，不证明用户当前外部服务可用、解析准确或实际收费调用已通过。

## 追溯入口

- [NodeKind与配置协议](../../../src/shared/types.ts#L3)、[保存及执行图验证](../../../src/shared/workflow-validation.ts#L86)。
- [统一运行器及Graphon回调](../../../src/host/runtime.ts#L233)、[Python桥接节点](../../../runtime/graphon_bridge/main.py#L81)、[只发送ID/kind/边的桥接协议](../../../src/host/graphon.ts#L155)。
- [默认模型解析](../../../src/host/model-defaults.ts#L26)、[Agent生成限制](../../../src/host/index.ts#L149)、[宿主模型流](../../../src/host/llm.ts#L23)。
- [生产适配器](../../../src/host/execution-adapters.ts#L235)、[工具目录](../../../src/host/tool-catalog.ts#L86)、[节点配置UI](../../../src/client/node-config.tsx#L19)。
- [20类型实际引擎与生产适配器全链路测试](../../../tests/graphon-capability-audit.test.ts)：实际Graphon、QuickJS、本地文件检索/文档、本地HTTP与内置工具；模型为受控替身。人工暂停恢复未重复已成功模型/步骤。
- [嵌套退出与存量流程边界证据](../验证/边界与存量流程证据.json)：loop内嵌iteration时，terminate实际1轮退出，null/remove实际3轮；这是已复现边界，而非仅静态推测。
- 其他离线执行与协议用例见各原子页；本轮未运行真实收费模型或外网MCP。
