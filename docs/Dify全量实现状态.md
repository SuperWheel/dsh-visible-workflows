# Dify 全量实现状态与差异矩阵

核对日期：2026-10-15。本文以 DESIGN 改版开始时的实现审查为基础，已回填小地图、视口裁剪、设置，以及本轮注释、便签、浮动面板与 SVG 的官方 Web 实测事实；它不是全量功能验收报告。后续改动须继续回填对应条目，不能把尚未验收的能力视为已完成。

**目前已经具备可独立执行的工作流编辑器及 20 类节点的运行分支，但尚未全面对标 Dify。** 主要欠缺集中在完整画布操作、类型与变量系统、普通分支并行调度、调试缓存、错误恢复、版本发布、DSL、触发器、片段和多人协作。知识检索、Agent、模板、代码等已有真实执行子集，也存在明确语义差异。

既定目标仍是完整对标。本文不把缺项从范围中删除，不以“后端依赖”“后续版本”替代待实现需求，也不把节点菜单、按钮、截图或自动化测试数量等同于全量功能完成。

**最新修复：190 tests / 19 files、build/typecheck 通过。** 普通聊天的 `visible-workflows:guide` 变量解析错误已修复，未指定节点模型时默认跟随 DSH。官方 Web 默认模型交互及纯数据循环验收后，更新并重启 Desktop，安装文件哈希一致。未发送真实模型请求；见 [普通消息与默认模型修复](普通消息与默认模型修复.md)。

此前注释便签阶段构建 **build/typecheck 通过，175 tests / 17 files 通过**。同一包已通过官方 UI 更新 Desktop，并完成原生退出、保留窗口后重启。Web 与 Desktop 已分别验证便签、浮动面板和独立执行的具体项目；解锁后 Desktop 单条及末条注释删除复验也已完成，**不代表全部验收通过**。聊天入口初次复验误点两次造成两条先后删除，已说明并恢复；随后节点入口单次删除明确 3→2，末条删除保留独立正文，最终原文 `1`、`2` 及 a-3 引用核对正常。注释引用重启后不恢复仍是已知缺口。该次续验没有改源码或包、未重跑测试，175/17 与包 SHA-256 `d2d998e3b6deaf974103adc74c8cf59d150862fc91f2e7ccd00764800f6de743` 为该阶段历史构建结果。证据见 [注释便签与浮动面板验收](注释便签与浮动面板验收.md)；此前的 130 tests / 13 files 及桌面普通流程、设置和侧栏验收仍保留于 [设计改版与动态渲染验收](设计改版与动态渲染验收.md)。

## 1 核对基线与判定方式

### 1.1 官方基线

2026-10-14 读取官方 `releases/latest` 时，最新稳定开源版本为 **1.17.1**，`draft=false`、`prerelease=false`，发布时间为 **2026-09-10 10:04:06 UTC**。本次验收回填沿用该基线，没有重新查询版本。[官方发布 API](https://api.github.com/repos/langgenius/dify/releases/latest)、[1.17.1 发布说明](https://github.com/langgenius/dify/releases/tag/1.17.1)。

同时复核当前滚动手册中的 LLM、Agent、Human Input、Iteration、Loop、HTTP、文档提取、编排、错误处理、变量检查、版本、片段、快捷键与发布页面。其余逐项范围承接 [Dify画布能力对照.md](Dify画布能力对照.md) 的 **76 项**和 [Dify节点执行规格.md](Dify节点执行规格.md) 的 **50 项**；两份文档是需求基线，不是完成清单。本轮没有重新声称已通读既有规格中全部 61 页，也没有操作用户的 Dify 画布。

Cloud 滚动手册、开源稳定版本和部署条件分别记录。例如 Cloud 的历史恢复等能力存在套餐条件，项目应提供已约定的等价能力，不照搬收费墙；普通工作流、Chatflow、New Agent、知识管线不能混为同一种画布。[版本控制](https://docs.dify.ai/en/cloud/use-dify/build/version-control)、[Agent](https://docs.dify.ai/en/cloud/use-dify/nodes/agent)。

1.17.1 特别需要纳入验收的变化包括方向键移动及连续操作合并撤销、Human Input 进入 Iteration/Loop、人工超时正确分支、重复暂停恢复、全部 Output 的工具输出声明、布尔循环退出条件。当前实现覆盖其中部分场景，不据此推定整个版本等价。[版本说明](https://github.com/langgenius/dify/releases/tag/1.17.1)。

### 1.2 状态、源码与证据

| 标记 | 含义 |
| --- | --- |
| 已实现 | 该行所限定的配置、保存和真实行为已闭环；仍须按证据栏区分自动化与实机验收。 |
| 部分 | 有真实实现，但仍缺该项中的语义、交互、类型、异常路径或验收。 |
| 未实现 | 尚无对应的端到端能力；类似菜单或邻近能力不计入。 |
| 依赖 | 与上述状态并列使用：执行需要模型、沙箱、文档解析器、授权上下文或外部服务；未满足时应明确失败。 |

下表源码缩写指向具体文件及函数；引用函数名是为了避免并行设计修改引起行号漂移。

| 缩写 | 源码位置与重点 |
| --- | --- |
| TYPE | [src/shared/types.ts](../src/shared/types.ts)：`NodeKind`、`NodeConfig`、`Workflow`、`WorkflowRun`、`WorkflowAPI`。 |
| VAL | [src/host/validation.ts](../src/host/validation.ts)：`configs`、`graphIssues`、`topologicalNodes`、`protectFixedNodes`。 |
| RUN | [src/host/runtime.ts](../src/host/runtime.ts)：`reference`、`typedInputs`、`validateObject`、`start`、`answer`、`executeGraph`、`executeNode`。 |
| STORE | [src/host/storage.ts](../src/host/storage.ts)：`save`、`saveRun`、`stageAttachment`、`readAttachment`、预设管理。 |
| HOST | [src/host/index.ts](../src/host/index.ts)：`agentSave`、`registerTools`、`start`、`executeNative`、`runNested`。 |
| MODEL | [src/host/llm.ts](../src/host/llm.ts)：宿主模型目录与 `harnessModels`。 |
| ADAPT | [src/host/execution-adapters.ts](../src/host/execution-adapters.ts)：HTTP、QuickJS、Python、文档、本地检索、Agent 执行。 |
| TOOL | [src/host/tool-catalog.ts](../src/host/tool-catalog.ts)：内置工具、OpenAPI 导入、宿主工具及工作流工具目录。 |
| TPL | [src/host/template.ts](../src/host/template.ts)：有界模板解释器 `renderDataTemplate`。 |
| CANVAS | [src/client/canvas.tsx](../src/client/canvas.tsx)：选择、移动、连接、菜单、整理、缩放、`svgForWorkflow`。 |
| VIEW | [src/client/viewport.ts](../src/client/viewport.ts)、[mini-map.tsx](../src/client/mini-map.tsx)、[layout.ts](../src/client/layout.ts)、[inspector-viewport.ts](../src/client/inspector-viewport.ts)：视口裁剪、小地图、实际尺寸整理及浮动面板避让。 |
| NOTE | [src/client/notes.ts](../src/client/notes.ts)、[sticky-note.tsx](../src/client/sticky-note.tsx)：便签编辑、尺寸、颜色、稳定节点锚点与跟随。 |
| APP | [src/client/app.tsx](../src/client/app.tsx)：管理页、画布入口、注释和补参弹窗、`RunPanel`。 |
| FORM | [src/client/forms.tsx](../src/client/forms.tsx)、[src/client/node-config.tsx](../src/client/node-config.tsx)：`NodePanel`、`SpecificConfig`、`WorkflowSettingsSection`。 |
| NODES | [src/client/nodes.ts](../src/client/nodes.ts)、[src/client/node-picker.tsx](../src/client/node-picker.tsx)：节点分类、默认值、端口、上游变量展示。 |
| EDIT | [src/client/store.ts](../src/client/store.ts)：自动保存、冲突、撤销重做、运行轮询；[copy.ts](../src/client/copy.ts)：递归复制及引用重映射。 |
| CHAT | [src/client/chat-bridge.tsx](../src/client/chat-bridge.tsx)、[annotation-editor.tsx](../src/client/annotation-editor.tsx)：原生聊天 `@`、草稿注释、统一注释编辑器、临时序号与发送回执。 |
| NUM | [src/shared/numbering.ts](../src/shared/numbering.ts)：结构重编号；稳定 UUID 不变。 |

证据编码：

| 编码 | 已有证据及边界 |
| --- | --- |
| T1 | [runtime.test.ts](../tests/runtime.test.ts)：基础执行、分支、输入、取消、固定节点、版本等。 |
| T2 | [runtime-expanded.test.ts](../tests/runtime-expanded.test.ts)：类型条件、模型响应校验、模板、聚合、人工暂停/超时/恢复、迭代、循环、300 KB 附件、嵌套身份与固定节点。部分模型测试使用可控响应，不能证明真实模型服务可用。 |
| T3 | [tool-adapters.test.ts](../tests/tool-adapters.test.ts)、[expanded-flows.test.ts](../tests/expanded-flows.test.ts)：真实 JS、HTTP、文档、内置工具及综合流程；Agent 决策测试不是真实模型调用。 |
| T4 | [runtime-llm.test.ts](../tests/runtime-llm.test.ts)、[runtime-sdk-contract.test.ts](../tests/runtime-sdk-contract.test.ts)、[runtime-numbering.test.ts](../tests/runtime-numbering.test.ts)、[chat-bridge.test.ts](../tests/chat-bridge.test.ts)：SDK、模型适配、编号、草稿协议。 |
| T5 | [canvas-interaction.test.ts](../tests/canvas-interaction.test.ts)、[notes.test.ts](../tests/notes.test.ts)、[sticky-note.test.tsx](../tests/sticky-note.test.tsx)、[inspector-viewport.test.ts](../tests/inspector-viewport.test.ts)、[annotation-editor.test.ts](../tests/annotation-editor.test.ts)、[client-store.test.ts](../tests/client-store.test.ts)：选择互斥、V/H、节点/便签方向键及 Shift 大步长、连续操作事务、编辑切换、便签跟随、面板避让及动画手动停止等回归；不能代替全部真实键盘操作验收。 |
| W | 上轮官方 Harness Web `http://127.0.0.1:5188`：节点/工具页、OpenAPI 导入、保存连线、代码→排序→迭代→人工确认→时间工具、循环三次退出、真实 HTTP 问候、容器编辑撤销、注释清理及 Undo/Redo。 |
| W2 | 前次设计改版的官方 Harness Web：200 混合节点/199 连线在 1041×977 页面、约 761×909 画布、scale=1 下初始挂载 6 节点/9 连线，点击小地图中部后 12 节点/13 连线；小地图点击、拖动、键盘、收起/展开通过；原生设置中角色预设新增/修改通过；独立循环输出计数 3、轮数 3。由主验收任务回传，未声称 FPS 或 1000 节点实机性能。 |
| W3 | 本轮官方 Harness Web：两条注释删除一条、删除最后引用保留聊天正文；便签新增、原位编辑及失焦保存、拖动、缩放、换色、锚点跟随、删除后撤销、重开保留；浮动面板避让和遮挡节点居中；SVG 下载解析得到 2 张便签、1 条锚点线及蓝色；独立循环实际输出计数 3、轮数 3。详见本轮验收报告。 |
| D | 上轮官方 Desktop：安装启用、全 B 主页与画布、独立文本流程、侧栏展开、节点/工具菜单、`@` 入草稿、注释双入口、清空草稿。桌面原生草稿 Undo 仍待进一步确认。 |
| D2 | 本轮同包 Desktop 已通过官方 UI 更新、原生退出保留窗口后重启；便签成功保存至 v27，连接 a-2「整理结果」后拖动节点，节点与便签均横移 +80 px、纵移 -60 px；便签删除后一次撤销恢复正文及连接。a-3 配置浮层上下避让、顶部位置不变、小地图/缩放左移与节点居中有截图；独立执行成功输出「处理结果\n\n便签与节点联动验证通过。」。两条旧未发送注释重启后引用未恢复，已从只读 WAL 找回并通过 UI 重建。解锁后的删除续验：节点入口单次删除第三条明确 3→2；末条删除后按钮/全部序号消失、独立正文保留；最终 UI 核对原文 1/2 及 a-3 引用，保留两条。聊天入口初次误点两次及恢复过程见主验收报告。续验未发送，流程保持进入时的 v30。 |
| S | 本轮源码审查。说明存在实现或缺口，不代替行为测试。 |

本轮 **175 tests / 17 files、build/typecheck** 的通过结果由主验收任务回传；本文更新没有另行重跑。早期 102 tests / 9 files 记录见 [MVP验收说明.md](MVP验收说明.md) 和 [本轮交付状态.md](本轮交付状态.md)，不作为本轮通过数量。独立 preview 只用于组件调试，不能作为宿主验收。真实模型、Windows、Web 文件上传仍未完成实测。

W3 浮动面板实测：画布宽 761 px，顶部操作区底边为 y=118.5，面板顶边 y=130.5，间隔 12 px；面板右边 x=1041 与内容区右边一致，底边 y=965 距内容区底边 y=977 为 12 px。面板左边 x=681，小地图与底部控件右边均为 x=669，保留 12 px 横向间距。选中被面板遮挡的节点后，画布将其移入剩余区域中心；相关按钮为 28 px。V/H、节点及便签的方向键操作目前有自动化回归，本轮没有据此声称已完成 Web 键盘实测。

**草稿重启持久化缺口：**宿主只保留草稿纯文本，插件注释引用存在 `sessionStorage`，本轮原生退出重启后未恢复两条未发送注释的引用。此次从只读 WAL 找回原文并通过 UI 重建属于人工恢复证据，不是产品已能自动恢复。Web 与 Desktop 单条及末条删除现已分别验证；删除复验通过不消除跨重启持久化缺口。真实模型完整发送链路仍未验收。

## 2 画布、菜单与编辑体验：76 项

### 2.1 基础画布 CAN

当前指针、手形、连线、选择和整理已有实用实现；Dify 的快捷键、对齐、便签、导出等不能用这些基础操作替代。[官方快捷键](https://docs.dify.ai/en/cloud/use-dify/build/shortcut-key)。

| ID | 状态 | 当前行为与差异 | 源码 / 已有证据 | 补齐后的验收要求 |
| --- | --- | --- | --- | --- |
| CAN-01 | 部分 | 节点与工具选择器可创建真实节点，按容器约束类型；缺完整空白处入口和 Snippets。 | NODES、CANVAS；W/D | 工具栏、空白右键均可添加同一能力；非法上下文说明原因。 |
| CAN-02 | 已实现 | 指针/手形按钮与 V/H 快捷键切换同步，输入区域不触发模式切换。 | CANVAS；T5。V/H 尚未做本轮 Web 键盘实测。 | 双布局补充实机键盘回归，确认按钮状态与模式同步。 |
| CAN-03 | 已实现（基础选择） | 单选、Shift 多选、框选、批量移动，使用高亮边框而非勾选框；节点、连线与便签选择互斥，修复残留便签选择导致误删。 | CANVAS；T5、W/D 部分 | 两种布局下多选只显示边框；批量拖动后保存、重开、撤销。 |
| CAN-04 | 部分 | 菜单复制副本、删除，含嵌套 UUID/引用重映射；未形成系统剪贴板复制/粘贴及跨流程粘贴闭环。 | CANVAS、EDIT；T4 | Cmd/Ctrl+C/V/D、跨流程粘贴、外部变量映射、删除后恢复分别测试。 |
| CAN-05 | 部分 | 节点右键、右上多选操作可用；连线和空白上下文菜单不全。 | CANVAS；W/D 部分 | 四种目标各有准确菜单，空白处菜单不携带过期节点目标。 |
| CAN-06 | 部分 | 注释、固定、配置/说明、复制、删除可达；缺单节点运行、换类型的完整能力。 | CANVAS、FORM；S | 类型切换验证字段/端口迁移，单节点执行绑定调试引擎。 |
| CAN-07 | 部分 | 端口添加连线、选边删除；保存校验端口和 DAG；缺拖拽重接、即时类型/引用检查。 | CANVAS、VAL；W | 重接后引用失效可定位；撤销恢复原端点，不丢身份。 |
| CAN-08 | 部分 | 可按实际卡片尺寸自动排列并撤销，保留节点身份与连线；附着便签随节点调整，适应视图包含便签。复杂容器/分支质量未全面验证。 | CANVAS、VIEW、NOTE、EDIT；T5、S | 大分支及多层容器无覆盖，结果可读；执行语义不变。 |
| CAN-09 | 未实现 | 未见六方向对齐及横/纵均匀分布。 | CANVAS；S | 八种操作逐个核对结果和单步撤销。 |
| CAN-10 | 部分 | 有放大、缩小、适应视图和比例显示；手动操作会停止面板避让动画；缺完整固定比例菜单及对应快捷键。 | CANVAS、VIEW；T5、W3 | 固定比例、鼠标锚点缩放、容器尺寸变化保持可用。 |
| CAN-11 | 部分 | 位图小地图、视口框、点击/拖动定位、键盘移动、显隐已 Web 实测；本轮 Web 随浮动面板左移留出 12 px，Desktop 左移避让有截图。小地图内直接缩放、更窄布局及桌面大图压力验收仍需补齐。 | CANVAS、VIEW；W2/W3、D2 | 主视口缩放投影一致；小地图缩放、窄侧栏和桌面操作逐项验证。 |
| CAN-12 | 部分 | SVG 导出当前图层，包含负坐标、便签文字/尺寸/颜色及锚点连线；真实下载解析得到 2 张便签、1 条锚点线及蓝色。缺 PNG/JPEG、当前视图/整图选择及完整样式保真。 | CANVAS `svgForWorkflow`、NOTE；T5、W3 | 负坐标、便签、分支、嵌套图、长文字均无裁切；导出不改图。 |
| CAN-13 | 部分 | 已有纯文本便签新增、原位编辑及失焦保存、拖动、调整尺寸、换色、节点锚点跟随、删除撤销和重开保留；修复编辑切换及误选删除。Desktop 已验 v27 保存、与节点同幅移动及一次撤销恢复正文/连接。仍缺富文本、作者显示及单张便签复制/副本。锚点跟随是本项目增强。 | APP、CANVAS、NOTE、TYPE；T5、W3、D2 | 补齐其余属性与复制语义；全部便签属性持久化，移动/编辑可撤销，双布局实机回归。 |
| CAN-14 | 未实现 | 便签未实现富文本格式与链接编辑。 | TYPE、APP；S | 格式与链接保存后保留；导出可读。 |
| CAN-15 | 部分 | 用户本地修改有 60 步快照撤销/重做；节点及便签连续方向键操作在 keyup/失焦时合为一次事务，拖动和尺寸调整也以完整操作提交。外部 Agent 更新刷新仍会清空本地历史，缺 Agent 批次撤销。 | EDIT、CANVAS、NOTE；T4/T5、W、W3 便签删除撤销 | 用户/Agent 改动统一成可解释事务；撤销图编辑不撤销外部执行。 |
| CAN-16 | 部分 | 已有基本焦点/Enter、Delete、节点及便签方向键移动、Shift 大步长和 keyup 事务；输入区域不移动画布对象。评论对象及其键盘移动未实现。 | CANVAS、NOTE；T5；本轮方向键/Shift 仍待 Web 键盘实测。 | 长按方向键仅一条撤销记录；补评论操作及双布局真实键盘验收。 |
| CAN-17 | 未实现 | 工作流主页搜索已存在，但当前画布节点搜索、Shift 变量关联高亮未闭环。 | APP、CANVAS；S | 搜索定位含容器内节点；变量关联按稳定引用高亮。 |
| CAN-18 | 部分 | 有保存中/失败/已保存及 revision；缺保存时间、发布状态、完整离线恢复。 | APP、EDIT；W | 失败不能显示成功；冲突刷新保留可恢复草稿；发布状态独立于保存。 |

### 2.2 编排与复用 BLD

Dify 片段包含输入提取、草稿、发布、版本与插入副本，不能把“复制几个节点”算作片段完成。[官方片段](https://docs.dify.ai/en/cloud/use-dify/build/snippet)。

| ID | 状态 | 当前行为与差异 | 源码 / 已有证据 | 补齐后的验收要求 |
| --- | --- | --- | --- | --- |
| BLD-01 | 部分 | 独立 Workflow 可运行；没有 Chatflow 的会话轮次与 Answer 语义。 | TYPE、RUN；T1、W/D | Workflow 与 Chatflow 起点、状态、调用契约分别通过。 |
| BLD-02 | 部分 | DAG/互斥分支真实执行，但普通 DAG 是拓扑顺序逐节点 await；非真正并发。运行时没有完整上游可达引用验证。 | RUN `executeGraph/reference`、VAL；T1/T2 | 独立慢分支实际并行；兄弟分支不能越界读取，汇合后可读。 |
| BLD-03 | 部分 | Iteration/Loop 子图可编辑、运行、返回主图；以进入子画布编辑替代 Dify 原位容器，缺完整容器调试体验。 | TYPE、RUN、APP；T2/T3、W | 复制、移动、跨容器引用及所有异常分支统一验证。 |
| BLD-04 | 部分 | Host 已校验基础图/字段并报错；没有聚合插件、模型、变量问题的 Checklist 定位界面。 | VAL、APP；T1/T2 | 同时缺多项时一次列齐，可点到对应节点/字段。 |
| BLD-05 | 部分 | 已有本次输入、节点输出、run/loop 的 vars；缺环境配置、Secret、会话变量、统一全局变量管理。 | TYPE、RUN、FORM；S | 配置/运行/会话作用域隔离，类型匹配、秘密遮蔽。 |
| BLD-06 | 未实现 | 无选区提取为 Snippet、外部依赖转输入。 | TYPE/API、EDIT；S | 选区保留内部连线，外部依赖自动映射，不能遗漏工具依赖。 |
| BLD-07 | 未实现 | 无片段库、新建、DSL 导入和独立编辑页。 | TYPE/API、APP；S | 三种创建入口得到相同可编辑对象。 |
| BLD-08 | 未实现 | 无片段草稿/发布/历史存储。 | STORE、TYPE；S | 仅发布版进入选择器，草稿修改不影响既有使用方。 |
| BLD-09 | 未实现 | 没有片段插入和输入绑定；普通复制不是该能力。 | EDIT、TYPE；S | 插入后产生独立 UUID，修改源片段不改变副本。 |
| BLD-10 | 部分 | 可复制完整流程并递归重建节点及引用；UI 默认仍在原工作区，缺跨工作区依赖映射。 | APP、EDIT；S | 副本独立运行；跨区缺模型/工具/文件逐项处理。 |
| BLD-11 | 部分 / 依赖模型 | 原生聊天草稿、结构化生成/修改工具已接通；真实模型生成/修改未实测，运行中动态改图未实现。 | CHAT、HOST；T4、W/D 草稿 | 真实 Agent 从需求生成可执行图，局部修改命中稳定身份，固定节点受保护。 |
| BLD-12 | 部分 | 配置与描述可进入；节点单步运行、工具所属工作流跳转等入口未完整。 | FORM、CANVAS、TOOL；S | 帮助、定位、运行使用真实目标；不显示无处理器菜单。 |

### 2.3 调试与错误 DBG

查看日志不等于变量检查器；Dify 的缓存值可编辑后用于下游调试，且不覆盖原节点 Last Run。[变量检查器](https://docs.dify.ai/en/cloud/use-dify/debug/variable-inspect)。

| ID | 状态 | 当前行为与差异 | 源码 / 已有证据 | 补齐后的验收要求 |
| --- | --- | --- | --- | --- |
| DBG-01 | 部分 | 执行按钮和 Agent 工具使用同一运行器；无完整 Test Run 入口模式/快捷键。 | HOST、RUN、APP；T1、W/D | 快捷键与按钮相同；保存失败和缺输入有明确结果。 |
| DBG-02 | 未实现 | 无单节点执行 API；节点菜单不能以全流程运行冒充。 | TYPE/API、RUN；S | 支持节点独立补参和执行；Output/Answer 按规格禁用。 |
| DBG-03 | 未实现 | 恢复人工暂停用内部 checkpoint，不是用户可操作的调试缓存和逐步运行。 | RUN、TYPE/API；S | 单节点结果进入调试缓存，继续下游不重复上游副作用。 |
| DBG-04 | 部分 | RunPanel/节点上次运行可看输入输出和结构化结果；缺集中变量检查器、类型树与完整作用域浏览。 | APP、FORM；W 部分 | 可定位每个变量来源、类型、范围及当前值。 |
| DBG-05 | 未实现 | 无测试缓存编辑，运行记录是只读结果。 | TYPE/API、FORM；S | 编辑缓存影响下游，原 Last Run 不变。 |
| DBG-06 | 未实现 | 无单项恢复和清空全部调试缓存。 | TYPE/API；S | 恢复原值与清空缓存有不同且可验证的效果。 |
| DBG-07 | 部分 | 有运行选择、步骤状态、输入输出和结果；缺完整 Result/Detail/Tracing、时间线和可视图快照回看。 | APP `RunPanel`、STORE；W/D | 分支、轮次、耗时、工具/模型配置与同次运行对应。 |
| DBG-08 | 部分 | 节点面板有“上次运行”，展示实际输入输出及 data；迭代多次详情、耗时/Token 等不完整。 | FORM、RUN；S | 节点运行记录可按 run/轮次切换，不能把最后一项代表全部迭代。 |
| DBG-09 | 部分 | 默认异常停止已实现；缺节点级默认值与失败分支配置/执行。 | RUN、VAL；T1/T2 | 同一错误按停止、默认值、失败分支分别得到预期结果。 |
| DBG-10 | 部分 | 有 error 字符串；未统一提供结构化 `error_type/error_message` 可引用变量。 | TYPE、RUN；S | 错误分支可按类型分流，原始原因可追踪。 |
| DBG-11 | 部分 | 运行/等待/取消状态真实，停止可中断；触发监听状态未实现。 | RUN、APP；T1/T2、W/D | 运行、人工等待、事件监听能分别停止，状态不可混用。 |
| DBG-12 | 部分 | Iteration 三种错误策略和 Loop 子错停止已有执行语义；节点级恢复及 Agent 修复尚缺。 | RUN；T2/T3 | 检查部分失败计数，已被节点错误分支处理的异常不能重复计失败。 |

### 2.4 版本与 DSL

当前 revision 用于乐观锁，运行 graph 用于快照。二者不能替代草稿、发布版与版本恢复。[官方版本控制](https://docs.dify.ai/en/cloud/use-dify/build/version-control)。

| ID | 状态 | 当前行为与差异 | 源码 / 已有证据 | 补齐后的验收要求 |
| --- | --- | --- | --- | --- |
| VER-01 | 部分 | 有最新流程 revision 与运行快照；无发布版本对象。 | TYPE、STORE、RUN；T1 | 三种定义版本与运行来源可区分，不覆盖历史快照。 |
| VER-02 | 未实现 | 保存即更新可执行定义；无显式发布/生效版本管理。 | STORE、TYPE/API；S | 草稿保存不自动成为发布版本；新旧调用使用明确版本。 |
| VER-03 | 未实现 | 无版本作者/命名/说明/筛选。 | TYPE、APP；S | 多作者、多命名版本可筛选并查看信息。 |
| VER-04 | 未实现 | 无历史恢复到草稿。 | TYPE/API；S | 恢复前后均可追溯，不能丢当前草稿。 |
| VER-05 | 未实现 | 无历史定义版本删除规则；200 条已完成 run 保留策略不是版本管理。 | STORE；S | 草稿/当前发布版保护，引用中的运行快照保留。 |
| VER-06 | 部分 | 每次运行冻结 graph/角色提示词；运行及人工等待时禁止保存改图。尚不能保存本次修改版并由用户合回原流程。 | RUN、STORE；T1/T2 | 运行中局部变更、前后节点尝试、最终差异选择全部可追踪。 |
| DSL-01 | 未实现 | 没有可执行 YAML DSL 导入导出；SVG 仅为视图，内部 JSON 工具协议也不是 Dify DSL。 | TYPE/API、CANVAS；S | 导出导入到干净环境，执行语义及资源映射一致。 |
| DSL-02 | 未实现 | 无 DSL 导出秘密排除界面；已有私有附件存储不能替代秘密管理。 | TYPE、STORE；S | 测试秘密默认不出现在导出、日志或错误中。 |
| DSL-03 | 未实现 | 无 DSL 版本迁移/兼容检查；严格拒绝未知内部节点只覆盖内部 schema。 | VAL；S | 旧版、未知节点、缺插件分别给真实定位和迁移结果。 |
| DSL-04 | 未实现 | 无历史版或片段 DSL 导出。 | TYPE/API；S | 指定 v1 时不能导出当前 v2；导入身份独立。 |
| DSL-05 | 未实现 | 无导入/跨区复制依赖映射清单。 | TYPE/API、APP；S | 缺依赖保留图并阻止误执行，不静默切模型或凭据。 |

### 2.5 协作、触发、发布与交叉验收

本项目临时 Agent 注释与 Dify 持久画布评论是不同对象。已有乐观锁只防止覆盖，不是多人实时协作。Dify 的发布还包括对外 Web/API/嵌入/MCP，不能用本机 Harness 开发服务器替代。[发布概览](https://docs.dify.ai/en/cloud/use-dify/publish/README)。

| ID | 状态 | 当前行为与差异 | 源码 / 已有证据 | 补齐后的验收要求 |
| --- | --- | --- | --- | --- |
| COL-01 | 未实现 | 无多人实时编辑服务/角色协议；revision 冲突拒绝覆盖仅是基础保护。 | STORE、TYPE；S | 两用户同图同时修改、冲突、断连恢复实测。 |
| COL-02 | 未实现 | 无协作者光标或显隐。 | TYPE、CANVAS；S | 光标实时位置与用户对应，不影响个人画布状态。 |
| COL-03 | 未实现 | 无持久画布评论、空白评论和 C 模式。 | TYPE、CANVAS；S | 节点外评论可添加、定位、编辑、保存。 |
| COL-04 | 未实现 | Agent 草稿注释不承担跨版本评论。 | TYPE、CHAT；S | 评论锚点跨版本保持或明确标记目标已删除。 |
| COL-05 | 未实现 | 无评论读写/解决权限。 | TYPE/API；S | 读者可看、编辑者可写，服务端验证权限。 |
| COL-06 | 未实现 / 依赖通知服务 | 无成员 @、通知和收件人授权模型。 | TYPE/API；S | 测试成员收到准确通知，重复事件不重复发送。 |
| COL-07 | 未实现 | 无评论/协作者光标显隐选项。 | CANVAS；S | 隐藏仅影响显示，不删除数据。 |
| COL-08 | 未实现 / 依赖协作服务 | 无协作同步、重连、消息容量和多用户撤销策略。 | TYPE/API、EDIT；S | 断网、大图、重连与本地未保存修改共同验收。 |
| TRG-01 | 部分 | 只有用户输入起点；无 Trigger 起点及 Chatflow 区分。 | TYPE、VAL；S | 起点转换处理失效变量，互斥规则明确。 |
| TRG-02 | 未实现 / 依赖调度及事件服务 | 无 Schedule/Integration/Webhook 节点与调度。 | TYPE、RUN；S | 三类事件触发真实独立运行并保存来源。 |
| TRG-03 | 未实现 | 无已发布触发开关。 | TYPE/API；S | 停用事件不启动，重启后的有效版本一致。 |
| TRG-04 | 未实现 | 无多触发测试监听与首事件胜出。 | RUN；S | 一次测试仅首事件启动，正式模式各事件按规则运行。 |
| TRG-05 | 未实现 | 当前 run 没有触发来源结构。 | TYPE；S | 手动、定时、集成、Webhook 来源可追踪。 |
| TRG-06 | 未实现 | 触发型手动测试/事件重放未接入；独立执行按钮目前仅适用输入起点。 | RUN、TYPE；S | 按本项目约定可独立补测试事件，明确实际副作用，不伪造正式触发。 |
| PUB-01 | 未实现 / 依赖发布服务 | 无 Web App/API/嵌入发布端点。 | TYPE/API、HOST；S | 发布版本、访问控制、真实外部调用与运行记录对应。 |
| PUB-02 | 未实现 / 依赖 MCP 服务 | 可以调用宿主暴露的工具，不等于把本工作流发布为 MCP Server。 | TOOL、HOST；S | 外部 MCP 客户端列举/执行指定版本，凭据可撤销。 |
| PUB-03 | 未实现 | 无 CSV 批量执行及结果文件导出。 | TYPE/API、APP；S | 每行独立状态，部分失败可下载核对，文件值可用。 |
| PUB-04 | 部分 / 依赖宿主及外部服务 | 复用宿主模型/工具目录，并有本地文件检索；未实现完整知识库、插件市场、团队资源管理。 | MODEL、TOOL、ADAPT；S、W 部分 | 每个资源模块单列接入、权限和生命周期验收，不能靠工具列表替代。 |
| XAT-01 | 部分 | 全 B 与侧栏使用同一工作流状态；基础编辑/展开已有历史实机验证。本轮 Web 已验浮动面板距顶栏/底边/旁侧控件各 12 px、28 px 按钮及遮挡节点移入剩余区域；Desktop 已截图验证 a-3 浮层上下避让、顶部不变、小地图/缩放左移及节点居中。 | APP、EDIT、VIEW、客户端入口；W/D、W2/W3、D2 | 窄侧栏、展开、收回时目标/草稿/运行不丢失；继续补更窄布局和其他未覆盖场景。 |
| XAT-02 | 部分 | 鼠标基本可达，V/H、节点/便签方向键和 Shift 大步长已有测试；全部快捷键、焦点与菜单键盘能力仍未覆盖。 | CANVAS、FORM、NOTE；T5、S | 所有约定快捷键、焦点、菜单键盘操作逐项实机验证。 |
| XAT-03 | 部分 | 持久便签与临时 Agent 注释分别存储；Web 与 Desktop 均已验证单条/末条删除、清引用保留正文。Desktop 单次节点入口操作明确 3→2，最终原两条正文与 a-3 引用保留；初次聊天入口误点两次已说明并恢复。原生重启仍丢失注释引用，缺持久协作评论。 | TYPE、NOTE、CHAT；T4/T5、W/D、W3、D2 | 补齐未发送注释引用的重启持久化；三对象生命周期互不影响；完成真实发送链路。 |
| XAT-04 | 部分 | 运行保存 graph 快照且编辑暂禁用；历史图可视回看、运行中版本调整未完成。 | RUN、STORE、APP；T1/T2 | 当前图、历史图、本次版本切换时始终说明执行对象。 |
| XAT-05 | 部分 / 依赖实际环境 | 多种依赖失败明确报错，不伪造输出；缺统一 preflight、错误分类与所有真实模型/平台验收。 | VAL、MODEL、ADAPT；T1/T2/T3 | 缺插件、超时、沙箱、无权限、文件失效等均给可定位原因。 |

## 3 逐节点可执行差异：22 项

“20 个内部 kind”不是“Dify 全部节点完成”。下表按既有 NODE01—NODE22 核对；User Input 和 Trigger 分开，经典 Agent 和 New Agent 分开，Chatflow Answer 不被文本 Output 替代。

| ID / 能力 | 状态 | 已有真实行为 | 尚缺语义或依赖 | 源码 / 验收 |
| --- | --- | --- | --- | --- |
| NODE01 用户输入 | 部分 | 文本、段落、数值、布尔、选项、JSON、单/多文件；不足弹窗，足够直接执行；上传转私有附件引用。 | 缺完整 JSON Schema、类型选择器、文件接受规则/资源管理；hidden 有后端字段但 UI 配置不完整。 | RUN `typedInputs/prepareInputs`、FORM、VAL；T1/T2、D 文本。补 Web 文件上传、错型/选项/隐藏字段验收。 |
| NODE02 LLM | 部分 / 依赖宿主模型 | 明确 provider/model、effort、角色提示词、变量插值；Host 消费真实模型流并检查完成标记；可校验平面结构字段。 | 尚无真实模型验收；缺多消息、生成参数、共享 LLM 配置、视觉/文件、上下文引用、完整 JSON Schema、会话记忆、前端流式及节点重试/失败分支。 | MODEL、RUN、FORM；T4 为适配测试。须真实模型调用验证费用/取消/错误与结构输出。 |
| NODE03 知识检索 | 部分 / 依赖文档 | 读取工作区文件，分块关键词匹配，返回来源、分数、TopK/阈值结果。 | 不是 Dify 知识库检索；缺索引管理、向量/混合、rerank、元数据过滤、多模态、知识库权限/API；schema TopK 可到 50，但适配器实际截断 20。 | ADAPT `knowledge`；S。须真实语料检索与权限/无结果/依赖失败验收。 |
| NODE04 Output | 部分 | 文本模板输出，按名称收集多条已执行结果；不全局终止其他路径。 | 缺类型化多输出/文件结果；同名输出可后写覆盖，当前校验未拒绝冲突。 | RUN `executeGraph/output`、VAL；T1、W/D。补两并行同名输出、互斥同名策略、文件输出验收。 |
| NODE05 Answer | 未实现 | 无独立 kind。 | 缺 Chatflow 多段流式回复、引用与会话消息语义。 | TYPE；S。须独立会话流验收。 |
| NODE06 经典 Agent | 部分 / 依赖模型与工具权限 | 有界 JSON 决策循环，显式工具白名单，执行真实工具、返回结果，遵循角色提示词。 | 未对齐 Dify 策略插件、Function Calling/ReAct 配置与工具变量完整契约；无真实模型 Agent 联调。 | ADAPT `agent`、TOOL、HOST；T3 控制响应。须真实工具循环和拒绝未授权工具。 |
| NODE07 New Agent | 未实现 / 依赖 Agent 能力服务 | 当前 agent kind 为上述本项目执行循环。 | 无 New Agent 共享定义/版本、独立环境、记忆、文件及其组合能力契约。 | TYPE、ADAPT；S。不得将经典/自有 Agent 更名即记完成。 |
| NODE08 问题分类 | 部分 / 依赖模型 | 真实生成接口返回 JSON，校验类别 ID，只走匹配出口；不合法响应失败。 | 缺完整模型参数、记忆/多模态等配置；真实分类模型未验。 | RUN `classifier`；T2 控制响应。补真实分类、未知类别与空输入。 |
| NODE09 条件分支 | 部分 | IF/ELIF/ELSE、AND/OR、首匹配、常见字符串/空值/数值/布尔条件；真实分支跳过。 | 缺完整类型驱动操作符、变量选择器、静态引用验证及更复杂嵌套条件。 | RUN `matches`、FORM；T2、W。补各类型真/假/不存在矩阵。 |
| NODE10 Iteration | 部分 | 有真实子流程、item/index、顺序/并发上限 10、结果保序、空数组、终止/null/移除三策略。 | 并行迭代含 Human Input 明确拒绝；缺完整容器调试、输出类型校验、Dify 全参数；最大数组 1000 为本项目容量。 | RUN `iteration`；T2/T3、W。补嵌套人工、失败/取消/并行副作用边界。 |
| NODE11 Loop | 部分 | 跨轮变量、最大轮数、结束条件、Exit Loop；真实执行/人工暂停后恢复。 | 上限 100、条件配置/变量声明较简；缺全量容器调试和完整节点恢复策略。 | RUN `loop`；T2/T3、W 三次退出，W3 再次实际输出计数 3、轮数 3。补多变量、多层循环及终止优先级。 |
| NODE12 Exit Loop | 已实现（核心退出） | 只允许循环内；停止当前循环并交回外层；恢复 checkpoint 时保留终止含义。 | 与全量容器/调试联动仍随 NODE11 补齐。 | VAL、RUN；T2/T3、W。已有当前循环退出、恢复不误继续测试。 |
| NODE13 Code | 部分 / 依赖 Python 沙箱 | JS 在 QuickJS 无宿主 IO 环境执行同步 main(inputs)；Python 纯数据 AST 白名单且必须有宿主文件沙箱；返回对象。 | 不是 Dify 完整 Python/JS 运行环境；不支持任意库/async；配置超时与底层有效上限需统一；缺重试/错误分支。 | ADAPT、VAL；T3、W JS。Python 完整宿主链及 Windows 未验。 |
| NODE14 Template | 部分 | 有界变量、if/elif/else、for、常用过滤器与命名输入，避免 eval。 | 仅 Jinja 兼容子集，非完整 Jinja2；缺宏、完整表达式/过滤器、成熟语法编辑提示。 | TPL、RUN；T2。须逐条支持矩阵与不支持语法错误提示。 |
| NODE15 变量聚合 | 部分 | 按组从执行过的互斥分支取一个值，保留 false/0/空值；拒绝多个有效候选。 | 缺静态同类型检查与可视类型选择器；不同分支类型到运行时才可能暴露问题。 | RUN `aggregator`；T2。补各类型分支合流及冲突定位。 |
| NODE16 文档提取 | 部分 / 外部解析 | 本地文本/HTML；PDF/Office/OCR 通过显式工具/MCP或 Agent 路由；工作区与附件归属检查、工具参数与文本路径校验。 | 不内置完整解析生态；复杂格式的保真度取决于所选服务；多文件 text 仍为拼接字符串。 | ADAPT；文档适配与界面测试15项、300KB回归；真实外部解析服务仍需逐项验收。 |
| NODE17 变量赋值 | 部分 | run/loop vars 支持设置、清空、算术、数组操作，暂停恢复重放赋值而不重复工具。 | 无持久会话变量、类型化目标选择及完整 Dify 操作契约；并行迭代副本变量不回写外层。 | RUN `assigner`；T2/T3。补会话隔离、所有操作类型错误。 |
| NODE18 参数提取 | 部分 / 依赖模型 | 平面字段定义、类型/必填检查，返回 __is_success/__reason；失败不伪造所需字段。 | 无完整嵌套 schema、模型工具模式和真实模型验收；失败标记仍需用户接分支处理。 | RUN `extractor/validateObject`；T2。补真实数据提取、缺失与错型下游保护。 |
| NODE19 HTTP | 部分 / 依赖网络 | method/URL/headers/raw body/总超时，真实请求和 JSON/body/status/headers；不自动跟随重定向。 | 缺认证管理、Query 表单、multipart/binary 上传、文件下载值、分连接读写超时、SSL 选项、重试/默认值/失败分支。输入输出还受节点 1 MB 上限。 | ADAPT `httpRequest`、FORM；T3、W HTTP200。补所有正文/认证/文件/状态策略。 |
| NODE20 列表操作 | 部分 | 真实数组过滤、同类型基本值排序、取前 N、首尾值、空数组。 | 缺完整文件属性筛选、类型驱动字段、复合条件及所有官方输出配置；limit 最大 20。 | RUN `list`；T2/T3、W。补文件列表、对象/空值和稳定排序契约。 |
| NODE21 Tool | 部分 / 依赖工具环境 | 9 个时间/JSON 内置工具、OpenAPI/Swagger JSON、宿主实际工具、可调用工作流；原生工具走 ctx.tools.execute 权限。 | 不是完整 Dify 插件市场/MCP 服务管理；OpenAPI 仅部分 schema/认证能力；含人工暂停的工作流目前不能作为工具；原生工具要求正确对话权限上下文。 | TOOL、HOST；T3、W 导入/调用。补安装/授权/更新失效、复杂 schema、取消及真实插件/MCP。 |
| NODE22 Human Input | 部分 | 暂停持久化、渲染提示词和默认字段、动作分支、默认三天超时、超时分支、首个有效回答恢复；无字段仍需选择。 | 提示内容主要按纯文本显示；缺完整 Markdown 表单、动态选项、官方输出字段、Email/API/WebApp 外部交付；并行迭代不支持人工节点。 | RUN `human/answer/armTimeout`、RunQuestion；T2、W。补多端竞争回答、多个表单、全部字段和外部交付。 |

以上节点差异分别参照：[LLM](https://docs.dify.ai/en/cloud/use-dify/nodes/llm)、[Iteration](https://docs.dify.ai/en/cloud/use-dify/nodes/iteration)、[Loop](https://docs.dify.ai/en/cloud/use-dify/nodes/loop)、[Human Input](https://docs.dify.ai/en/cloud/use-dify/nodes/human-input)、[HTTP](https://docs.dify.ai/en/cloud/use-dify/nodes/http-request)、[文档提取](https://docs.dify.ai/en/cloud/use-dify/nodes/doc-extractor)。其他节点具体合同与对应官方链接见既有 [节点规格](Dify节点执行规格.md)。

## 4 触发、数据与运行合同：28 项

这里的 `TRG01` 等无连字符编号来自节点规格；上节 `TRG-01` 等来自画布对照，分别保留以便追踪，不合并删项。

### 4.1 起点与调度

| ID | 状态 | 可执行差异 | 源码 / 验收 |
| --- | --- | --- | --- |
| TRG01 | 部分 | 每层运行图要求一个 input；无 Trigger 起点和 Chatflow 类型。 | VAL、TYPE；须验证起点转换与旧变量清理。 |
| TRG02 | 未实现 / 依赖调度 | 无 cron、时区、执行预览、错过/重叠触发策略。 | TYPE、RUN；须定时实际触发和 DST/离线边界测试。 |
| TRG03 | 未实现 / 依赖插件事件 | 无订阅、OAuth/API Key 事件授权及集成回调。 | TYPE、TOOL；工具执行不算事件订阅。 |
| TRG04 | 未实现 / 依赖 Webhook 服务 | 无正式/测试 URL、请求字段抽取、验证和响应策略。 | TYPE/API；须错误请求不创建 run，测试与正式隔离。 |
| TRG05 | 未实现 | 无多个触发图入口、测试首事件胜出与独立启停。 | RUN、TYPE；须分别验证测试与正式事件并发语义。 |
| TRG06 | 未实现 | 保留项目独立执行触发流程的目标，但当前无事件样例补参/重放。 | RUN、APP；未来须询问框补事件、标记手动来源且不改变正式启停。 |

### 4.2 变量、文件与资源

| ID | 状态 | 可执行差异 | 源码 / 验收 |
| --- | --- | --- | --- |
| DATA01 | 部分 | JsonValue 和精确 {{ref}} 可保留 JSON 类型；缺 file/具类型数组/整数完整 schema 与类型过滤选择器。 | TYPE、RUN、FORM；T2。须结构化传递和保存前错型定位。 |
| DATA02 | 部分 | 每次运行/循环作用域独立，迭代复制变量；缺环境与会话持久作用域。 | RUN；T2。须同名变量跨 run/会话不互相覆盖。 |
| DATA03 | 部分 | UI 展示上游可用变量，但主配置多为手输路径；运行时引用并未完整限制祖先关系。 | NODES `availableNodes`、FORM、RUN `reference`；须删/改连线后标错，兄弟分支引用被拒绝。 |
| DATA04 | 未实现 | run/workflow/workspace 在元数据中存在，但无规范可引用 sys 变量族。 | TYPE、RUN；须映射真实身份而非伪造 Dify ID。 |
| DATA05 | 部分 | 附件按 run/fileId 存私有目录，run 仅保存元数据，读取校验归属；工作区路径有 realpath 约束。 | STORE、ADAPT；T2 300 KB。缺文件资源生命周期、全部节点文件传递及远程 URL 恢复。 |
| DATA06 | 未实现 | 无 Secret 类型/凭据引用与系统性日志脱敏；隐藏输入不是秘密。 | TYPE、VAL、ADAPT；须测试 HTTP 密钥、错误、导出、工具日志均不泄漏。 |
| DATA07 | 部分 | 角色预设仅名称/提示词，设置统一修改、节点下拉引用；运行冻结提示词。共享模型配置与共享 Agent 尚无独立对象。 | STORE、FORM、RUN；T1/T4。须固定保护与未来运行更新均成立。 |
| DATA08 | 部分 | LLM/代码平面输出与提取字段有实际校验；缺完整 JSON Schema/嵌套限制与错误路由。 | RUN `validateObject`、VAL；T2。须必填/可选/畸形 JSON 三类分别测试。 |
| DATA09 | 部分 | 运行图、稳定 UUID、编号、模型配置、角色提示词、节点数据和迭代索引关联；实际工具有效配置与完整追踪 UI 不足。 | RUN、TYPE、NUM、CHAT；T2/T4。须改图后查看旧 run 不混入新配置。 |
| DATA10 | 部分 | 子图以普通 input 代表入口；无自动 Iteration/Loop Start/End/Placeholder 完整结构模型，也无知识入库管线。 | NODES `initialBody`、TYPE；须专用结构节点不可错误删除/孤立，知识管线单列验收。 |

### 4.3 执行、恢复与调试

| ID | 状态 | 可执行差异 | 源码 / 验收 |
| --- | --- | --- | --- |
| EXEC01 | 部分 | 串行/互斥真实，普通分支不并发；当前每层≤200、总≤500、嵌套≤5、步骤≤5000，而非官方单路径 50 限制。 | RUN、VAL；T1/T2。须明确容量差异，补 50/51 路径、宽图及真实并行。 |
| EXEC02 | 部分 | 人工字段、动作、预填与文件可用；无完整 Markdown/动态选项、官方 __action_id/__action_value/__rendered_content 契约。 | RUN `answer`、RunQuestion；T2、W。须三分支及文件下传一致。 |
| EXEC03 | 部分 / 依赖外部交付 | 当前宿主弹窗有首答保护与超时；无 Email/API/WebApp 表单交付。 | RUN、APP；T2。须双人竞争、迟到提交、断线重连及邮件实际投递。 |
| EXEC04 | 已实现（独立补参与人工暂停） | 起始补参和图中人工等待分开；无须主 Agent；恢复复用已成功步骤，关弹窗仍可继续。 | RUN、APP；T1/T2、W/D 文本。含原生工具的重启恢复权限仍受依赖边界限制。 |
| EXEC05 | 部分 | 默认失败终止；无可配置默认值/失败分支及结构错误变量。 | RUN、VAL；须每种节点三策略测试。 |
| EXEC06 | 未实现 | 无节点原地重试次数/间隔字段和执行器。 | TYPE、RUN；须区分网络重试与 Agent 修复轮数，验证用尽再走错误策略。 |
| EXEC07 | 部分 | Loop 错误终止、Iteration 三种处理已存在；尚无“子节点先恢复，再由容器判断”的完整层次。 | RUN；T2。须嵌套默认值/错误分支后不误计失败。 |
| EXEC08 | 未实现 | A/B 故障处理设置、B 默认、同故障最多两轮 Agent 修复未实现。 | TYPE/API、RUN、设置页；须固定节点不可绕过，改名不重置故障预算。 |
| EXEC09 | 未实现 | 无单节点/逐步执行及可编辑调试缓存；Last Run 展示只是基础。 | TYPE/API、FORM；须缓存编辑不污染原记录。 |
| EXEC10 | 部分 | 实际 run 独立存储、冻结图、输入输出和步骤；缺完整结果/详情/追踪、耗时可视、历史画布。 | STORE、RUN、APP；W/D。须同图重跑、旧图查看、轮次切换。 |
| EXEC11 | 部分 | 各适配器有具体中文错误，但以字符串为主；无完整统一错误类型与可操作恢复入口。 | ADAPT、MODEL、RUN；T1/T2/T3。须错误类固定样例覆盖，而非统称 Agent 错误。 |
| EXEC12 | 部分 | 支持取消、人工暂停持久恢复；异常关闭后的普通 running 标记 interrupted，不自动重放。无任意断点恢复/幂等回执协议；执行中禁止编辑。 | STORE、RUN、HOST；T1/T2。须未知外部结果先查回执，不能重复发送/写入。 |

这些执行差异按 [编排逻辑](https://docs.dify.ai/en/cloud/use-dify/build/orchestrate-node)、[错误处理](https://docs.dify.ai/en/cloud/use-dify/build/predefined-error-handling-logic)、[人工输入](https://docs.dify.ai/en/cloud/use-dify/nodes/human-input) 区分官方语义与项目增加的动态调整规则。

## 5 本项目亮点：保留能力与未闭环部分

| 项目已确认需求 | 当前状态与下一步 |
| --- | --- |
| 主 Agent 可选，流程能独立执行 | 基础和确定性适配器已闭环，Desktop/Web 有真实执行；宿主原生工具仍依赖对应对话权限，不能静默借用其他 Agent。需在资源选择及 preflight 明示。 |
| 主 Agent 生成、手工编辑、自然语言调整共用一张图 | 工具与编辑器共用存储/runtime；草稿引用已接通；真实模型生成/修改仍待验，不允许据工具注册宣称自动生成成功。 |
| 编号随结构变化，引用身份稳定 | NUM 保存/编辑重编号，含子图，UUID 与模板引用保持；须继续补嵌套拆分、合流、复制与删除后的可解释展示。 |
| 右上操作与右键添加注释；聊天“n 条注释”与画布序号双向编辑 | Web 与 Desktop 已验单条删除及末条清引用保留正文。Desktop 从节点序号 3 单次删除明确 3→2；聊天入口初次误点两次导致两条先后删除，已向用户说明并恢复，不判定为产品单次重复删除。最终聊天列表核对原文 1/2 与同一 a-3 引用，关闭后保留两条。重启引用自动恢复仍缺失，人工恢复不计产品修复；旧版桌面原生草稿 Undo、真实模型发送链路仍待验。 |
| 固定节点保护；用户明确要求修改时可有限授权 | 默认 Agent 修改/删除/绕过固定节点被拒绝，用户手工可编辑；“一次授权”可信票据尚无实现，不能仅凭 Agent 传参解除保护。 |
| 用户/Agent 修改可撤销重做 | 用户本地编辑可用，节点/便签连续键盘操作已按 keyup/失焦合并事务；Web 便签删除后撤销恢复已通过。Agent 外部刷新尚未进入同一事务历史。需要确定跨版本冲突与撤销作用范围，外部真实副作用不由 Undo 撤销。 |
| 运行中 Agent 调整先保存本次版，用户选择是否更新原流程 | 当前直接禁止运行中改图，属于未满足；需本次派生版本、节点尝试边界、变更预览与合回原流程完整协议。 |
| 模型默认同执行 Agent，思考强度不超过当前上限 | HOST 有模型与强度上限校验，用户可手动选节点模型；缺省节点跟随当前工作区对话选择或宿主默认模型，启动冻结并覆盖容器与子工作流。190 项回归及 Web 跟随菜单已验；真实模型和不同 provider effort 映射未全部验。未知强度不擅自排序。 |
| 角色预设只保留提示词，在设置统一维护 | 当前名称/提示词管理和节点下拉已实现，更新只影响后续启动；前次设计改版已在原生设置中 Web 实测新增/修改。不能将其扩成未经用户要求的模型/工具/强度组合预设。 |
| 明确工作流意图直接进入，否则交付后才建议转换 | 有工具描述和生成草稿入口；缺真实 Agent 端到端行为验收，建议/接受/拒绝不能靠静态文案记完成。 |
| 询问框补充信息，足够执行则不追问 | 起始输入与人工节点均有询问框；还需涵盖权限授权、运行后保存和错误处理设置等尚未实现的决策。 |
| `@` 调用工作流 | 原生候选和草稿引用已 Desktop 验证；发送后 Agent 真正执行的完整链路尚未实测。 |
| 主页卡片、工作区与状态筛选、全 B/侧栏 | 入口和基本状态已有实机证据；本轮 Web/Desktop 浮动面板与控件避让的具体项目已测。筛选缺等待等完整状态、长标题/大量卡片/空状态及新菜单的双布局回归仍应补齐。 |

## 6 本轮 DESIGN 与后续实现的验收约束

设计改版应覆盖完整能力的信息结构；当前未实现的能力仍留在设计和任务矩阵里。设计稿上的入口可标明对应状态，不在运行产品中放置会被误认为可用的无处理器菜单。

1. **菜单按对象区分。** 画布空白、节点、连线、多选、便签、评论、容器、工具、流程卡片、版本和运行记录分别设计。多选仅高亮边框；批量操作位于当前画布右上，右键提供同一动作。
2. **节点配置需要类型与依赖信息。** 自由输入 JSON/UUID 路径只是现状，不作为最终交互。设计变量选择器、模型能力参数、Secret、输出 Schema、文件资源、错误策略、重试、调试和运行结果；无法执行的依赖说明原因与恢复入口。
3. **运行控制与画布编辑分开。** 设计独立执行、停止、人工等待、事件监听、调试缓存和动态本次版本状态，不能将不同状态统一命名为运行中。普通分支并行、重试和 Agent 修复应由实际执行器支持后验收。
4. **版本与持久对象分开。** 草稿、发布版、运行快照、本次派生版、片段、便签、协作评论、临时 Agent 注释各有身份和生命周期。发送成功只清临时注释标号。
5. **样式使用宿主体系，布局参考 Dify。** 复用 DeepSeekHarness 字体、菜单、间距、表单、设置框与焦点规范；设计 B 全窗和右侧栏两套宽度状态，不能只在独立 preview 截图判断通过。
6. **完成条件以结果验收。** 每项须经历可配置→保存重开→真实执行/操作→异常路径→撤销或恢复→官方 Web/桌面对应验收。代码存在、菜单出现、测试用了 mock、截图好看均不能跳过其余环节。

本轮优先需追踪的运行正确性问题（仅审查记录，未改代码）：

| 问题 | 影响 | 定位与验收 |
| --- | --- | --- |
| 普通 DAG 分支串行；运行时缺完整祖先引用限制 | 图上并行含义与实际调度不一致；某些越界引用可能因排序碰巧成功。 | RUN `executeGraph/reference`、VAL；两个耗时分支与兄弟引用反例。 |
| 两个执行到的 Output 同名会覆盖 | 运行显示成功但结果可能丢失。 | RUN `run.outputs[name]`、VAL；必须选择拒绝冲突或显式多值契约。 |
| 知识 TopK、代码超时、输出容量存在分层上限差异 | 配置允许的数值未必是实际生效值。 | VAL、ADAPT、RUN；UI 展示有效能力范围，边界值实测。 |
| Human Input 输出字段/多文件提取契约与 Dify 不同 | 直接复用 Dify 思路配置下游可能取不到变量或错型。 | RUN `answer`、ADAPT `extractDocument`；用规范字段与 array[string] 回归。 |
| Secret 与统一脱敏尚缺 | HTTP/工具输入中的敏感值可能成为普通配置或日志内容。 | TYPE、ADAPT、RUN；测试假密钥覆盖错误、日志及未来导出。 |
| 原生工具权限上下文只存内存 | 人工暂停后重启虽能恢复确定性步骤，后续原生工具仍可能缺原对话权限。 | HOST `runContexts`、RUN 恢复；重启后重新绑定正确授权，不借用其他会话。 |
| 未发送注释引用未跨原生重启持久保存 | 宿主保留纯文本，但插件 `sessionStorage` 引用在重启后消失，原文与节点关系不能自动恢复。 | CHAT、D2；应持久化草稿引用并核对聊天/工作流身份，原生退出重启后自动恢复；人工从 WAL 找回不计功能完成。 |

此前加入的视口裁剪只影响绘制，不能改变完整图、连接、执行、导出或引用。已有 W2 的 200 节点 DOM 挂载数证明视口裁剪生效；1000 节点只用于几何单元测试，不是运行容量或实机性能承诺。每层 200 节点、全图 500 节点等 Host 上限未调整，仍须与配置和错误提示一致。没有测量 FPS，不作流畅帧率承诺。

## 7 已有实机证据索引

这些图片仅支持各自已描述的行为，不能证明全量对标。

- [本轮注释、便签与浮动面板验收](注释便签与浮动面板验收.md)：前轮 175 tests / 17 files、官方 Web 操作、面板几何测量、真实循环与 SVG 解析；同包 Desktop 已通过便签联动/撤销、面板避让及独立运行。解锁后单条及末条删除复验完成，操作误差已说明并恢复；重启草稿引用持久化仍缺失。本次未改源码或包、未重跑测试。
- [桌面聊天入口三条列表](../artifacts/screenshots/harness-desktop-annotation-editor.png)、[末条删除后正文保留](../artifacts/screenshots/harness-desktop-annotation-delete-last.png)、[原两条注释恢复并核对](../artifacts/screenshots/harness-desktop-annotations-restored.png)。
- [本轮桌面便签与浮层](../artifacts/screenshots/harness-desktop-notes-panel.png)、[本轮桌面便签联动独立执行](../artifacts/screenshots/harness-desktop-notes-run.png)。
- [前次设计改版与动态渲染验收](设计改版与动态渲染验收.md)：小地图、视口裁剪、设置及此前桌面验证，不能代替本轮桌面验收。
- [官方 Web 节点菜单](../artifacts/screenshots/harness-node-picker.png)、[工具菜单](../artifacts/screenshots/harness-tools-picker.png)。
- [人工暂停](../artifacts/screenshots/harness-human-pause.png)、[综合流程运行](../artifacts/screenshots/harness-expanded-run.png)、[OpenAPI 结果](../artifacts/screenshots/harness-openapi-result.png)。
- [桌面独立执行](../artifacts/screenshots/harness-desktop-run.png)、[桌面节点菜单](../artifacts/screenshots/harness-desktop-node-picker.png)。
- [桌面注释双入口](../artifacts/screenshots/harness-desktop-annotation.png)、[桌面清空草稿后的注释清理](../artifacts/screenshots/harness-desktop-annotation-cleared.png)。

本次矩阵更新只修改本文；测试及实机事实由主验收任务回传，不表示本审查另行执行。未修改 runtime/UI 或用户 Dify 流程。

## 2026-10-15 Graphon 执行层更新

已接入原版 Graphon 0.7.0 GraphEngine 进行调度、分支与合流；现有 DSH 节点适配、容器业务与持久快照保留。此更新不等于 Dify 全部节点语义、原生容器、原生检查点或插件市场兼容。执行环境及本轮宿主验收见 [Graphon轻量接入验收](Graphon轻量接入验收.md)。
