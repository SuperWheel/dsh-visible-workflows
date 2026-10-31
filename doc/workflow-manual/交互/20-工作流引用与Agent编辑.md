# 工作流引用与Agent编辑

[返回总索引](../README.md) · [交互索引](./README.md)

核验口径：2026-10-17 对当前源码作静态核对。生成、修改和批注已接入专用规划后端；本地自动测试及仍待完成的真实模型、安装后 Web/桌面验收见[规划引擎验收边界](../规划引擎/11-验收范围与当前限制.md)。

## 入口与状态

- 聊天输入 @ 可搜索当前工作区未归档工作流；选择后插入原生引用，点击引用打开该工作流。
- 主页「让 Agent 创建」或画布「交给 Agent」打开需求框，提交按钮写入聊天草稿。
- 缺少准确协作会话时弹选择框，可选同工作区对话或新建；目标对话已有未提交工作流需求时拒绝覆盖。

## 操作步骤

1. @ 已有流程并补充任务；默认按流程执行，明确要求修改时改定义。
2. 从画布交给 Agent 时绑定原 ID，先读取最新定义，再把 `expectedRevision` 和修改要求交给规划工具；生成新流程时先分配唯一 ID。
3. 发送聊天后，DSH Agent 调用 `visible_workflow_plan`。信息不足时转达澄清问题；新图按真实 `created` 回执确认保存，已有图按 `proposed` 回执显示待接受提案。预览只返回候选，保存和接受都不自动执行。

## 调用链与边界

`InputTriggerSource('@') → candidates/onPick/codec.serialize`；`askGenerate → chat.insertGenerateRequest → slash/input-insert-text`。用户发送后，新建、修改与批注进入 `visible_workflow_plan`；任务查询、回答、取消和显式发布分别使用四个配套工具。明确提供完整当前 JSON 时仍可调用 `visible_workflow_save`；业务执行继续使用 `visible_workflow_run`，执行不要求主 Agent 必须参与。

Graphon 不理解自然语言、创建画布或选择工具目录。固定节点有宿主硬校验，Agent 不能修改、删除或绕过，需用户手动修改/解锁。规划候选具备最多两轮修正，已有修改提案沿用当前差异检查与接受流程；专门的规划进度/澄清 UI 尚未接入，当前通过主 Agent 转达。

规划生成与业务运行是不同生命周期，不能把候选修正当作运行中的节点重试。详细流程见[规划引擎索引](../规划引擎/README.md)。

## 源码与验证证据

源码：[chat-bridge.tsx](../../../src/client/chat-bridge.tsx)、[app.tsx](../../../src/client/app.tsx)、[navigation.ts](../../../src/client/navigation.ts)、[index.tsx](../../../src/client/index.tsx)。

- [chat-bridge.test.ts](../../../tests/chat-bridge.test.ts)：工作区候选、稳定ID、生成准入与草稿隔离。
- [navigation.test.ts](../../../tests/navigation.test.ts)：会话关联保护。
- [workflow-navigation.test.ts](../../../tests/workflow-navigation.test.ts)：后台生成仅通知。
- [宿主入口与 Agent 工具](../../../src/host/index.ts)：实际保存、模型与固定节点边界。

本次没有真实主 Agent 对话或模型调用；自动测试模拟的是 SDK 边界。

关联：[节点批注与聊天草稿](./17-节点批注与聊天草稿.md)、[执行与停止](./15-执行与停止.md)、[撤销重做与自动保存](./08-撤销重做与自动保存.md)。
