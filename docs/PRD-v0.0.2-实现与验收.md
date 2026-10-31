# PRD v0.0.2 实现与验收记录

> 2026-10-21 说明：工作流预算系统已于 2026-10-20 移除（见 [S12](<../doc/workflow-manual/规划引擎/设计/tasks-规划提速与上下文复用.md>)）。本文涉及预算问答、额度、增额或费用的内容仅为历史记录，不再执行；Token 用量只作性能计量保留。

更新日期：2026-10-17。依据：[PRD v0.0.2](../PRD-v0.0.2.md)及当前工作区源码。本文保留第一、第二轮历史交付证据，另行记录本轮增量代码与待验收项。改造继续使用现有 DeepSeekHarness 插件，不代表另建了一套替代产品，也不代表 PRD v0.0.2 已全部验收通过。

**最新部署（2026-10-17 11:22）：本地 MXC 最小执行器、文件/MCP 接口组件和本地凭据代理已装入现有真实 Desktop，画布、节点批注及 ENV/SYS 纯图标保留。全套 1,028 项测试经回环权限复验通过；重启后普通文本流程实际运行成功。当前只部署组件，完整主/子 Agent 隔离仍未完成，Secret 保持禁用。新阻断项为后台脱组进程生命周期、全局入口接管、CLI/MCP 网络与终端适配及 Windows 实机验证，不能继续仅归因于缺 Developer ID。详见 [本地隔离组件部署与阻断项](Secret本地隔离组件部署与阻断项.md)。以下各轮记录为历史证据。**

**原生签名分支历史进度（2026-10-17 续作）：保留原插件、画布、节点批注和 ENV/SYS 纯图标，新增随包分发的原生 Secret 代理、受控 HTTP 模式、必填凭据预检及恢复时重新授权。当前机器无有效发行签名，诊断构建保持禁止录入和使用；真实密钥存储、系统生物认证和主/子 Agent 攻击验收尚未通过。此前真实双 Agent 调用和 79 文件/743 项测试属于上一轮证据，不冒充本轮 Secret 验收。新增实现、部署前提与本轮结果见 [Secret 代理接入与验收](Secret受保护凭据代理接入与验收.md)。**

**最新方向：用户明确选择纯本地、Mac / Windows 通用隔离，并提出插件安装不应依赖管理员授权。独立系统服务账户方案暂不进入安装；新增 [免管理员路线评估](Secret跨平台隔离方案与开源调研.md#9-免管理员安装限制-agent-执行权限的候选路线)，重点核查 Harness 能否统一限制主/子 Agent 的全部工具执行入口，MXC 为待验证候选。远端方案不作为前置步骤。本轮未替换 Desktop；代码冻结结果为 82 个文件 / 835 项通过及完整构建通过，免管理员双平台隔离尚未实现或实机验收。**

**后续评估更新（2026-10-17）：用户增加轻量化要求。已完成 [真实宿主入口、MXC 与 CLI/MCP 兼容评估](Secret本地免管理员隔离实测与轻量化评估.md)：确认全局工具 guard 可复用，也发现读取/搜索/MCP 启动旁路。Mac 普通用户 12 项合成探针通过，真实内嵌 Node 双向管道通过；仅停止 MXC 外层时会遗留子进程，需要修正启动适配。Windows 免管理员依赖系统能力且尚未实机验证，Intel Mac 缺已查版本发行物。轻量化已有 executor 体积和 Mac 热启动测量，完整凭据服务仍待实现和测量。本次未修改宿主权限或插件运行代码，Secret 禁用状态不变；上述历史自动测试不作为本次隔离验收。**

第二轮历史结果为：65 个文件、618 项自动测试通过，Host / Client 编译和完整构建通过；当时最终包已装入原 Desktop，新 Host PID 22531，历史快照运行 891 毫秒；原 2 个流程、角色列表及最初 10 条运行深比较一致，新增 3 条验收记录。这些证据完整保留在第 5.2、6.4 节，**不覆盖 2026-10-17 本轮新增代码**。

本文的“已实现”表示可以在当前源码中定位对应行为；自动测试和真实宿主验收分别记录。开发预览、模拟 SDK、单元测试、历史版本截图均不能代替本轮真实宿主证据。

## 1. 改造范围与现有数据保护

本轮继续使用原插件的管理主页、画布、节点与连线、配置面板、容器子图、节点批注、便签、固定节点、撤销重做和运行详情。新的能力接入这些入口，不另建一套独立工作流画布。

| 保留对象 | 本轮处理 | 验收边界 |
| --- | --- | --- |
| 已有工作区和流程 | 保留工作区归属、流程 ID、节点 ID、连线和现有定义；新增字段可选，旧流程可以读取 | 第一轮真实库升级前后 2 个流程深比较完全一致；角色预设列表也一致，本库前后均为 0 项 |
| 节点批注与便签 | 沿用现有编辑及定位交互；增加按流程、会话保存的编辑草稿 | 自动测试覆盖草稿与既有交互；Desktop 重启恢复仍须现场验证 |
| 固定节点 | 保留后端保护；Agent 不得通过更改关联环境变量或角色预设绕过执行配置保护 | 不以用户点击“接受提案”隐式解除固定保护 |
| 活动运行 | 编辑保存不会自动改变活动快照；第二轮增加“已排空并暂停的根运行 → 差异预览 → 显式确认修订” | 确认才更新本次运行的快照并保存旧修订，原 run ID、输入、系统身份和预算保留；应用后仍暂停 |
| 旧 `library.json` | schema 1 校验后生成可恢复备份，再迁移到 schema 2；失败保留原文件，重复迁移不重复创建对象 | 真实库已迁移到 schema 2，自动备份与升级前副本字节一致；未在真实库演练回退 |
| 运行历史与文件 | 运行快照和事件独立保存；流程删除改为归档，支持恢复；本轮增加归档影响提示 | 历史证据保留；本轮最终基线 18 个运行/事件文件哈希一致，新增真实复验记录独立保存 |
| 旧文档与验收记录 | 保留为历史版本证据 | 旧版本“已完成”不自动适用于本轮新增能力 |

本轮最终数据保留基线采用 [before-final/library.json](../.cache/prd2-native-validation/before-final/library.json) 和 [历史文件哈希清单](../.cache/prd2-native-validation/before-final/history-hashes.json)：**4 个流程、18 个历史文件，最终安装后全部保持一致**。期间用户自行将“桌面验收 · 文本处理 副本”由 r10 编辑为 r11、5 个节点；最终比较保留这些用户编辑，没有按旧的 3 流程基线回滚。4 个流程中包括本任务首次导入的独立验收流程，18 个历史文件中包括首次失败尝试；其记录均保留。既有草稿没有捕获重启前基线，不能据此宣称草稿字节一致。

环境变量和系统变量入口按用户补充要求设计为**两个独立图标按钮，不展示文字**；鼠标悬停说明用途，同时保留可访问名称。入口位于画布工具栏，支持未选中节点时打开。

## 2. PRD 分期状态

| PRD 阶段 | 当前实现 | 状态与剩余门槛 |
| --- | --- | --- |
| P0-A 定义与变量基础 | 正式 JSON 包、版本检查、迁移备份、普通/系统变量、稳定引用；本轮增加逐项依赖映射、覆盖导入版本校验和普通必填变量补全 | 本轮真实新建导入、导出预览、双图标和系统变量通过；普通变量编辑闭环、映射切换与覆盖导入仍未现场验收 |
| P0-B Secret 可行性与隔离 | 原有受控操作接入本地代理与私有 gate；最小 MXC、文件/MCP 组件及包完整性检查已部署，v3 报告明确关闭原因 | **仅组件部署。全局入口和后台进程生命周期未完成；Windows、真实凭据/生物认证和主子 Agent 攻击验收未通过。Secret 禁用** |
| P0-C 原生任务与快照 | 原生 spawn、实例/任务 ID、控制及快照；首次组装前绑定桥接工具，工作流子任务改用原生工具呈现，并在执行和模型提示两处限制白名单 | 最终自动回归及真实双 Agent 并行、工具绑定、身份和用量结算通过，见第 6.5 节；真实取消、超时及追加指令仍未现场验收。子任务限制不能证明 Secret 全宿主隔离 |
| P1 执行治理与编辑 | 原有并发、预算、暂停、补充指令、提案与运行修订；本轮增加可选 Agent 超时、草稿 CAS 和 A/B 修复授权分支 | 已包含在本轮 79 文件、743 项通过及完整构建中；真实模型交互分别验收。工作区独立 Token 总配额、完整原生会话查看与公平调度保证未交付 |
| P2 可靠复用 | 原有恢复计划、模板、逻辑门及说明导出；本轮增加外部动作人工判定、文件存在/内容变更证据与原生读回执检查 | 文件证据保存与运行验证已接入；生产可信读取工具认证仍缺失。恢复对文件依赖保守失效，尚未接入按当前指纹比较的复用；无通用服务回执查询或幂等机制 |

## 3. 逐项实现对照

### 3.1 JSON、画布入口与普通环境变量

| PRD 条目 | 当前行为 | 限制或待验收项 | 代码依据 |
| --- | --- | --- | --- |
| FMT-01 唯一执行定义 | 画布仍以 `Workflow` JSON 为执行定义；交换包保留布局。执行语义摘要排除名称、坐标、便签、编辑 revision、定义更新时间及节点/边序列化顺序，递归依赖采用同一规则 | 执行配置、稳定身份、固定标志、连线、策略及有效角色/工具/模型/变量/输入/系统上下文仍参与摘要；这不是外部文件或服务内容指纹 | [workflow-format.ts](../src/shared/workflow-format.ts)、[recovery-plan.ts](../src/host/recovery-plan.ts) |
| FMT-02 文件内容与排除项 | 导出图、布局、便签、说明、策略、变量声明、角色和依赖清单；普通变量默认不带值；不包含运行历史、受管附件句柄或 Secret 值 | 用户自行写进普通提示词、代码、HTTP 配置的敏感文本不因此成为 Secret，不能宣称通用敏感信息自动清理 | [workflow-format.ts](../src/shared/workflow-format.ts) |
| FMT-03 导入导出 | 默认新身份导入并重写内部引用；提供模型、工具、角色、子流程及逐文件槽位映射。覆盖须显式选择目标并校验 revision；提交时再次核验依赖、版本和固定节点，图与新增角色原子写入；导入不执行 | 文件含来源及三类验收路径，均要求目标工作区重新核验；运行附件重新上传。外部子流程映射到目标工作区已有流程，不递归嵌入全部资产；新界面待真实宿主验收 | [workflow-format.ts](../src/shared/workflow-format.ts)、[workflow-import.ts](../src/host/workflow-import.ts)、[workflow-transfer.tsx](../src/client/workflow-transfer.tsx)、[storage.ts](../src/host/storage.ts) |
| FMT-04 迁移与说明 | schema 1 备份、校验和原子迁移；定义与运行记录分离；支持单份 Markdown 说明导出 | Markdown 是说明视图，不是第二个执行来源；不支持任意 Markdown 反向导入 | [storage.ts](../src/host/storage.ts)、[workflow-format.ts](../src/shared/workflow-format.ts) |
| UI-01 右上角入口 | 两个独立纯图标按钮、Tooltip、可访问名称；支持面板开关；真实 Desktop 全窗和窄侧栏均确认无文字标签 | 原生悬停 Tooltip 未专门人工确认；多选、运行中及键盘焦点等组合仍待验收 | [canvas.tsx](../src/client/canvas.tsx)、[variable-panels.tsx](../src/client/variable-panels.tsx) |
| UI-02 统一选择器 | 普通 `env` 与受支持 `sys` 纳入引用候选；Secret 不提供通用引用 | 手写表达式仍由后端校验；Secret 只在 HTTP 受控操作配置中选择声明，不能成为模板变量 | [variable-browser.tsx](../src/client/variable-browser.tsx)、[reference-scope.ts](../src/shared/reference-scope.ts) |
| ENV-01 作用域 | 变量属于流程定义；运行启动后冻结普通值；引用使用 `env.<稳定 ID>` | 当前没有独立部署环境覆盖层；普通变量对流程及 Agent 可读，不用于密码存储 | [workflow-variables.ts](../src/shared/workflow-variables.ts) |
| ENV-02 类型 | String、Number 有类型校验；空字符串与未配置区分；Secret 仅声明 | 不把宿主模型配置或截图中的 LLM 类型照搬成普通变量类型 | [workflow-validation.ts](../src/shared/workflow-validation.ts)、[workflow-variables.ts](../src/client/workflow-variables.ts) |
| ENV-03 面板 | 增删改、搜索、必填、说明、状态、稳定引用复制和引用节点定位 | 被引用变量不能直接删除；Secret 不展示值录入控件 | [variable-panels.tsx](../src/client/variable-panels.tsx) |
| ENV-04 缺失与变更 | 执行前展示缺失的必需普通变量，补齐并版本校验保存后再启动；防重复提交，校验原流程及会话未切换。重命名保持稳定引用；模板和默认导出不带值 | 补全值是可被 Agent 读取的普通配置。代理就绪时必需 Secret 转交 Host 预检；缺少可信就绪报告仍阻断，网页无原值录入框；普通值变更不自动改变活动快照 | [run-environment.tsx](../src/client/run-environment.tsx)、[store.ts](../src/client/store.ts)、[workflow-variables.ts](../src/shared/workflow-variables.ts) |

### 3.2 Secret 与系统变量

| PRD 条目 | 当前行为 | 限制或待验收项 | 代码依据 |
| --- | --- | --- | --- |
| SEC-01 保密前提 | 保留宿主能力只读检查；新增 v2 闭合原生 probe 报告，状态文案由已知枚举重建；旧 v1 仍拒绝伪造可用状态 | 当前诊断返回 `signing_untrusted`；probe 就绪不代表凭据已配置或隔离验收通过。跨平台部署另见方案，尚未实施 | [报告契约](../src/shared/secret-boundary.ts)、[原生代理](../src/host/protected-secret-broker.ts)、[跨平台设计](Secret跨平台隔离方案与开源调研.md) |
| SEC-02 权限矩阵 | Secret 声明不允许 `value`、可兑换绑定等额外材料；普通节点和手写引用均拒绝；新增固定受控操作声明 | 普通通道拒绝和代码结构不等于已通过主/子 Agent 隔离验收；原生真实正向消费未验证 | [workflow-validation.ts](../src/shared/workflow-validation.ts)、[reference-scope.ts](../src/shared/reference-scope.ts) |
| SEC-03 受控消费 | HTTP 固定操作 `deepseek.account-status.v1`；与 URL/headers/body/inputs 互斥；只返回 HTTP 状态，运行及恢复前预检 | 当前诊断不可用；作用域 ID 不是可信身份；跨平台后端与服务端授权尚未实现 | [受控协议](../src/shared/protected-secret.ts)、[执行适配](../src/host/execution-adapters.ts)、[原生接入验收](Secret受保护凭据代理接入与验收.md) |
| SEC-04 泄露处理 | 导出、草稿及快照拒绝 Secret 值和绑定材料；原生桥接采用闭合字段与固定错误；首个操作不向 Host 交付上游 body/headers | 不是通用敏感文本识别；其他业务响应的输出契约尚未实现。编码回显、TLS 及 UI 捕获等真实攻击验收未完成 | [workflow-format.ts](../src/shared/workflow-format.ts)、[editor-state-store.ts](../src/host/editor-state-store.ts)、[原生代理](../src/host/protected-secret-broker.ts) |
| SEC-05 轮换撤销 | 原生代码增加认证后的版本核验与更新/删除；受控节点及递归调用方恢复时不复用授权，重新执行需批准 | 真实条目读写与并发攻击待验收；删除不能收回已发出的请求；跨平台策略撤销尚未实现 | [恢复计划](../src/host/recovery-plan.ts)、[原生接入验收](Secret受保护凭据代理接入与验收.md) |
| SYS-01 只读系统面板 | 展示类型、说明、运行时值或未生成状态；字段不能通过输入或图定义覆盖 | 非所有宿主身份字段都有可信映射 | [variable-panels.tsx](../src/client/variable-panels.tsx)、[workflow-variables.ts](../src/shared/workflow-variables.ts) |
| SYS-02 首批字段 | 支持 `workflow_id`、`workflow_run_id`、`workspace_id`、`session_id`、`timestamp`；独立运行的 `session_id` 为 null | `user_id`、`app_id` 明示暂不支持且不可引用，不生成虚构身份 | [workflow-variables.ts](../src/shared/workflow-variables.ts) |
| SYS-03 生命周期 | 暂停继续和同一运行的显式修订保留原系统身份；快照重跑、恢复生成新 run ID 和时间并记录来源运行 | 跨调用者使用当前会话授权；完整跨会话真实宿主用例待验收 | [runtime.ts](../src/host/runtime.ts)、[index.ts](../src/host/index.ts) |

### 3.3 原生 Agent、调度、预算与恢复

| PRD 条目 | 当前行为 | 限制或待验收项 | 代码依据 |
| --- | --- | --- | --- |
| AGT-01 原生 Agent | Agent 节点委托宿主 `spawn`，独立上下文与结构化输出；在 `agent/created`、首次提示组装前注册桥接。仅当前子任务调用 `presentAs('native')`，执行 guard 拒绝 `run_code` 和白名单外工具；同步过滤模型工具 schema 与提示区段，防止子作用域自注册工具绕过继承过滤 | 空业务工具修复只保留 `structured_output`；父 Agent 的 PTC 不变。缺少受控创建/guard/工具呈现能力或实际工具未进入请求时拒绝；不静默回退。模拟回归不代替修正后的真实模型工具验收 | [native-agent.ts](../src/host/native-agent.ts)、[native-agent.test.ts](../tests/native-agent.test.ts) |
| AGT-02 任务管理 | 按实例展示原生/修复任务 ID、实际事件摘要与补充指令，精确停止及取消传播；本轮增加可选 `timeoutMs` 严格校验与配置入口，启用默认 300000 ms，范围 100～3600000 ms | 旧流程不配置超时时保持原行为；超时取消不保证撤销外部动作。不是完整原生会话或推理轨迹；提供方不支持或已开始提交时拒绝补充。真实模型生命周期待验 | [native-agent.ts](../src/host/native-agent.ts)、[node-config.tsx](../src/client/node-config.tsx)、[agent-execution-actions.tsx](../src/client/agent-execution-actions.tsx) |
| SCH-01 统一调度 | Graphon 主图分支可并行；模型准入同时受单 Host 进程 8 个、同工作区 4 个、根运行策略默认 3 个且最高 8 个的限制；子流程共享根账本，取消移除等待项 | 含人工/赋值的图保守串行；不是工作区 Token 总配额或公平调度承诺，也不是跨 Host 的分布式限额 | [graphon.ts](../src/host/graphon.ts)、[main.py](../runtime/graphon_bridge/main.py)、[run-budget.ts](../src/host/run-budget.ts)、[runtime.ts](../src/host/runtime.ts) |
| BUD-01 预算模型 | 总 Token 调度预算、单任务预留、Agent 任务数、并发及修复策略；修复和补充指令单独准入。补充指令与原任务共享根账本，按原生任务最终累计 usage 合并结算，不重复计入原任务消耗 | 仅为调度预算，不是费用或 Token 严格硬上限；无余量不投递，缺 usage 保留未知占额；补充指令不重置原任务步数、工具权限或模型输出限制 | [run-budget.ts](../src/host/run-budget.ts)、[runtime.ts](../src/host/runtime.ts)、[native-agent.ts](../src/host/native-agent.ts) |
| AGT-03 补充指令幂等 | 客户端生成消息 UUID，重试同一内容保留 UUID；宿主在异步计数前后检查重复提交与任务状态，同一消息不重复投递或占额；相同 ID 搭配不同内容拒绝 | “已接收”不保证原任务最终消费；原生层记录排队、消费或任务结束时未消费的结果。仅作用于本执行器仍受管的任务 | [agent-execution-actions.tsx](../src/client/agent-execution-actions.tsx)、[runtime.ts](../src/host/runtime.ts)、[native-agent.ts](../src/host/native-agent.ts) |
| BUD-02 未知用量 | 缺失回执保持占用；重启后的未结算预留转为待确认，不释放成新额度；用户可增加预算 | 不凭空推算缺失总量，不宣称已发请求成本可撤销；没有自动确认未知外部消耗的机制 | [run-budget.ts](../src/host/run-budget.ts)、[storage.ts](../src/host/storage.ts) |
| RUN-01 状态与控制 | 后台运行、等待输入、暂停中、已暂停、等待预算、取消和终态；暂停停止后继准入并等待在途任务结束；输出修复耗尽以 `paused` 和实例 `repair.waiting` 表达 | 有待纠正输出时禁用并拒绝普通继续，避免重放原动作；不新增伪造的 `repair_waiting` 运行状态，也不承诺立刻撤销外部动作 | [runtime.ts](../src/host/runtime.ts)、[run-governance.tsx](../src/client/run-governance.tsx) |
| REC-01 不可变快照 | 冻结图、输入、模型默认配置、角色提示词、递归子流程、普通环境变量及系统上下文；工具契约在消费前检查漂移；执行语义摘要排除展示字段，显式修订时保留旧快照 | 无会话时无法冻结的原生工具仍依赖执行时授权与能力检查；真实宿主工具变更仍须现场验证；摘要不代替外部内容核验 | [runtime.ts](../src/host/runtime.ts)、[recovery-plan.ts](../src/host/recovery-plan.ts)、[tool-catalog.ts](../src/host/tool-catalog.ts) |
| REC-02 三种继续 | 原运行暂停继续；按旧定义新建重跑；从终态新建带 `sourceRunId` 的恢复运行 | 不恢复任意 JavaScript/模型内部调用栈；子运行从所属根运行恢复 | [runtime.ts](../src/host/runtime.ts) |
| REC-03 复用与失效 | 逐实例展示复用/重做/阻断和依赖传播；确认携带摘要，宿主重算拒绝过期计划。所有三类文件验收要求及动态文件输入均保守判定不可默认缓存 | 文件执行证据已有指纹，但 `compareFileEvidence` 尚未接入恢复计划；不会因为存在旧指纹就复用，也未提供当前文件变化的完整差异理由。无通用外部服务状态缓存 | [recovery-plan.ts](../src/host/recovery-plan.ts)、[file-evidence.ts](../src/host/file-evidence.ts)、[recovery-preview.tsx](../src/client/recovery-preview.tsx) |
| REC-04 副作用 | 未确认或将重做的外部动作阻止自动恢复。新增按实例选择“已完成／允许重做／放弃”，要求依据；完成结果经 JSON/输出校验，标为用户确认但业务未独立验证。核验附带计划摘要，只写新恢复记录，不改来源历史 | 失效的已成功结果、动态身份或上游变化不能借“已完成”绕过；配置文件证据的节点不能用手填输出跳过验证。允许重做可能重复动作；仍无通用逐工具意图/幂等键账本或服务回执自动查询 | [recovery-review.ts](../src/host/recovery-review.ts)、[recovery-plan.ts](../src/host/recovery-plan.ts)、[recovery-preview.tsx](../src/client/recovery-preview.tsx) |
| VER-01 验证与修复 | 结构、最小长度及 `requiredFiles`；新增必读 `requiredReadFiles`、必要变更 `requiredChangedFiles`。按实例保存前后有界文件指纹和原生读取回执，详情显示验证状态、路径、hash、大小及回执身份，不保存文件正文 | 文件存在不等于已读；内容变化不证明由 Agent 引起。只有受信任工具的同一原生任务完整成功回执链可认证已读；当前 Host 未提供 `trustedFileReadTools`，生产必读资料保持未验证并阻断。拒绝越界、符号链接、超限或读取中变化的证据 | [file-evidence.ts](../src/host/file-evidence.ts)、[execution-adapters.ts](../src/host/execution-adapters.ts)、[native-agent.ts](../src/host/native-agent.ts)、[execution-details.tsx](../src/client/execution-details.tsx) |
| VER-01 A/B 修复策略 | A 先确认；B 仅在 Agent 工具发起等已记录授权范围内自动修复。独立运行默认先确认；已完成任务的无效输出使用空工具修复，默认最多两轮、可设 0～2；次数在投递前持久化，修复共享根预算 | 一次确认只授权一次修复，完成后保持暂停，后继仍需明确继续；人工修正沿 VER-02 规则。`user-diagnostics` 授权类型有代码分支，尚无单独的用户排查授权界面；不把重新命名任务作为次数重置，不重放原动作 | [runtime.ts](../src/host/runtime.ts)、[native-agent.ts](../src/host/native-agent.ts)、[execution-policy.tsx](../src/client/execution-policy.tsx) |
| VER-02 人工纠正 | 展示输出不合格原因、候选 JSON 和修复尝试；用户可停止，或提交修正对象。宿主重新校验结构、长度及已配置文件要求，通过后复用原节点结果且不重发原动作 | 根运行无其他待纠正输出时可继续；子运行纠正后保持 `paused`，不会独立启动，须由继续根运行统一恢复。校验失败保留暂停和用户编辑。运行修订仍是“应用后保持暂停”；通用修复器和真实模型链路未验收 | [agent-execution-actions.tsx](../src/client/agent-execution-actions.tsx)、[runtime.ts](../src/host/runtime.ts) |

### 3.4 编辑、逻辑门、资产和兼容性

| PRD 条目 | 当前行为 | 限制或待验收项 | 代码依据 |
| --- | --- | --- | --- |
| EDT-01 修改提案 | Agent 修改已有流程先产生提案；用户查看变化、接受或拒绝；版本冲突保留提案；后端固定保护持续生效 | 接受流程提案不自动改变活动运行；应用本次运行须另行满足暂停修订条件并确认 | [editor-state-store.ts](../src/host/editor-state-store.ts)、[proposal-review.tsx](../src/client/proposal-review.tsx) |
| EDT-02 草稿与批注 | 保留批注及草稿语义，按流程/会话隔离；保存和删除携带 `expectedRevision`，拒绝过期写入及删除；客户端冲突保留本地编辑。旧草稿缺 revision 时按 1 读取；相同内容不增版本、不重写 | CAS 防并发覆盖，不自动合并冲突；Secret 值不得保存或恢复。Desktop 多窗口冲突、重启、发送批次清理和原生聊天联动仍需现场复验 | [editor-drafts.ts](../src/client/editor-drafts.ts)、[editor-state-store.ts](../src/host/editor-state-store.ts)、[store.ts](../src/client/store.ts) |
| EDT-03 本次运行修订 | 已排空、无待纠正输出和活动子运行的暂停根运行可预览当前画布；客户端固定打开时的候选，展示差异与逐实例处理原因；确认同一候选和摘要后保存旧快照、递增 `activeRevision`、按计划复用结果并保持暂停 | 原 run ID、输入、系统变量和预算账本保留；不能借修订重置总预算、修改固定节点或自动重放副作用。仅展示修改不写数据；最多保存 20 次修订，不承诺任意历史回滚 | [run-revision-preview.tsx](../src/client/run-revision-preview.tsx)、[runtime.ts](../src/host/runtime.ts) |
| LOG-01 布尔逻辑 | 条件节点增加 IF/AND/OR/NOT/NAND/NOR/XOR/XNOR；默认严格 Boolean；显式谓词可转换；记录选中分支 | IF/NOT 限一项，其余 2–32 项；不存在隐式自然语言判断；保留旧条件节点定义 | [logic-gates.ts](../src/shared/logic-gates.ts)、[logic-gate-editor.tsx](../src/client/logic-gate-editor.tsx) |
| LIB-01 资产分层 | 内置只读模板、个人模板和工作区流程；模板使用创建新身份；角色一起原子导入；普通值默认不随模板保存 | 当前内置为两个确定性示例；依赖仍需目标工作区重新配置，不继承源运行身份或权限 | [template-library.ts](../src/host/template-library.ts)、[workflow-templates.tsx](../src/client/workflow-templates.tsx) |
| LIB-02 写入与删除 | 定义与草稿版本校验及原子写入，无变化不写；事件追加并保留稳定序号。归档前展示当前库中引用流程、待结束运行和保留历史数量；宿主再次拒绝归档有活动运行的流程；流程与个人模板可恢复 | 影响展示基于已加载库，不是跨客户端的实时依赖事务；归档不删除外部文件，恢复不恢复任何 Secret 授权。事件依赖单 Host 写锁，不是完整事件溯源系统 | [storage.ts](../src/host/storage.ts)、[editor-state-store.ts](../src/host/editor-state-store.ts)、[archive-impact.tsx](../src/client/archive-impact.tsx)、[template-library.ts](../src/host/template-library.ts) |
| COMP-01 宿主兼容 | 以 DeepSeekHarness 0.2.0-rc.2、macOS Apple Silicon 为接入基线；前两轮真实 Desktop 冷启动和确定性快照证据保留 | 本轮更新安装及真实 Agent 结论另行验收；Windows/Linux、其他原生提供方及插件/MCP 工具未全面验收 | [native-agent.ts](../src/host/native-agent.ts)、[index.ts](../src/host/index.ts) |

## 4. 前两轮重点修复的执行边界

本表保留前两轮已记录的边界及回归依据。第一轮全量结果见第 5.1 节；第二轮当时最终 65 文件、618 项全部通过的结果见第 5.2 节。本轮新增功能另见第 5.4 节，不能直接沿用这些历史通过数。

| 场景 | 当前防护 | 自动测试依据 |
| --- | --- | --- |
| 外部写入成功，下游失败后创建恢复运行 | 检测到成功动作将被重做时拒绝自动恢复，不因其缺少缓存而悄悄重放 | `run-governance.test.ts`：completed external action / downstream failed |
| 外部操作发出后失败或回执不明 | 先要求核验外部结果，不能自动重试该动作 | `run-governance.test.ts`：unconfirmed side effects |
| 并行迭代正在执行时暂停 | 停止准入，等待在途实例完成；不会把普通暂停当作错误而取消同批实例；继续时保留已完成结果 | `run-governance.test.ts`：pause drains parallel iteration tasks |
| 根运行暂停时子工作流仍有后继工具节点 | 节点准入同时检查根运行暂停状态，避免纯计算或工具节点绕过父级暂停 | [runtime.ts](../src/host/runtime.ts)；专门回归及真实宿主结果由主任务补充 |
| Graphon 退出后模型回调晚到 | 回调失效，不允许晚到成功覆盖失败/取消，不在存储关闭后追加结果 | `graphon-bridge.test.ts` 的三项失败与晚回调回归 |
| 多任务争用最后预算 | 原子预留，已结算 allocation 不重复结算；排队取消不会启动模型 | `run-governance.test.ts`：budget admission and settlement |
| 宿主重启时仍有活动预算预留 | 转为未知消费并保留占用，活动运行标记中断；重复读取不重复增加未知量 | `workflow-v2-format-storage.test.ts`：unreceipted reservations |
| 输出修复会导致原动作重放 | 修复仅处理已完成任务的无效输出，使用新建空工具任务；失败/未完成的动作任务不会自动重做 | `native-agent.test.ts`：output repair / incomplete action task |
| 运行期间工具定义发生变化 | 内置工具、可解析原生工具及 OpenAPI 契约纳入快照，参数路由或 schema 漂移时拒绝消费；子流程使用冻结定义及约束 | `tool-constraints.test.ts` 五项回归，已包含在第一轮全量通过结果中 |
| Agent 通过环境变量或角色间接改固定节点 | 后端检查关联变量与角色变化，提案接受仍执行固定保护 | `workflow-v2-format-storage.test.ts`、既有固定节点测试 |
| 预览后来源结果、预算或候选执行内容变化 | 确认时重新计算摘要，拒绝旧计划；预览和关闭不执行工作流 | `recovery-plan.test.ts`、`runtime-v2-continuation.test.ts`、`runtime-revision.test.ts`、`run-governance-client.test.tsx` |
| 仅移动、改名或编辑便签 | 不改变执行语义摘要；不会仅因展示变化建立运行修订 | `recovery-plan.test.ts`、`runtime-revision.test.ts` |
| 某个迭代实例失败或前轮循环结果失效 | 使用执行实例依赖区分各轮，保留不受影响的成功实例；后续依赖失效；不能借移除节点掩盖未知副作用 | `recovery-plan.test.ts` 的容器实例及副作用用例 |
| 补充指令重复提交、计数期间任务结束或预算不足 | UUID 去重、异步准入前后复核状态；不足不投递；明确投递前拒绝释放对应预留，最终累计 usage 不重复结算，未知用量保留 | `runtime-v2-continuation.test.ts`、`native-agent.test.ts`、`run-governance-client.test.tsx` |
| 输出修复达到上限或修复额度不足 | 保留候选与尝试并暂停，普通继续被拒绝；人工校验失败仍暂停，通过后不重发原 Agent 动作 | `runtime-v2-continuation.test.ts`、`native-agent.test.ts`、`run-governance-client.test.tsx` |
| 暂停后修改本次运行 | 要求根运行已排空，保护固定节点并核验摘要；保留旧快照、身份、输入和预算，应用后不自动启动 | `runtime-revision.test.ts`、`run-governance-client.test.tsx` |
| 同工作区多个根运行同时请求模型 | 共享工作区并发限制，其他工作区在进程额度内仍可准入；取消的等待项不占后续容量 | `runtime-v2-continuation.test.ts` 的工作区准入用例 |
| 重启后追加事件或读取旧格式日志 | 按该运行已有序号高位续接，保持历史行字节不变；独立运行各自计数，复用现有 Host 排他锁 | `run-event-sequence.test.ts` |

## 5. 自动测试与构建证据

### 5.1 第一轮自动测试与构建结果

主任务在第一轮完成旧 Agent 审计 fixture 更新及新增回归后，报告结果为：**57 个测试文件、527 项测试全部通过，0 项失败；第一轮构建通过。** 该结果替代第一轮此前未全绿的检查点，仅证明当时自动测试与构建状态；不覆盖第二轮新增源码，也不替代真实 Desktop 或真实模型验收。

本文本次更新只修改文档，没有重新运行完整测试。以下保留第一轮已执行的分组验证及对应覆盖；分组可能与完整 suite 重叠，**不能将各组数字相加作为总测试数**。

| 验证层 | 第一轮证据 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| JSON、变量、迁移、存储 | `tests/workflow-v2-format-storage.test.ts` 15 项通过的阶段记录 | 类型、Secret 拒绝路径、稳定身份重写、迁移回退、不变不写、归档、重启预算占用 | 真实桌面库已经迁移或 Secret 可以安全消费 |
| 逻辑门 | `tests/logic-gates.test.ts` 11 项通过的阶段记录 | 真值、输入约束及接入实际执行语义 | 所有用户流程都已实测 |
| Graphon 并行 | `tests/graphon-parallel.test.ts` 4 项通过的阶段记录 | 真正引擎扇出/汇总、暂停排空、取消、不新增后继、并发值限制 | 真实模型吞吐或性能指标 |
| Python 桥接 | `tests/graphon-python/test_bridge.py` 14 项通过的阶段记录 | 当前准备好的 Python/Graphon 桥接行为 | 其他平台运行时兼容 |
| 模板存储及界面 | `tests/template-library.test.ts` 与 `tests/workflow-templates.test.tsx` 合计 8 项通过 | 只读内置模板、新流程身份、角色原子导入、归档恢复、创建不执行 | 模板对话框已在本轮真实 Desktop 完成验收 |
| 原生 Agent 适配 | `tests/native-agent.test.ts` 使用 SDK 形状的模拟宿主，无真实模型请求 | 任务身份、能力拒绝、工具范围、取消、结构输出、有限修复、usage 处理 | 已安装的真实 spawn 提供方或付费模型实际成功 |
| 运行治理 | `tests/run-governance.test.ts` 与 `tests/graphon-bridge.test.ts` 有预算、快照、副作用、暂停和晚回调回归 | 对应确定性边界 | 任意中断点无损恢复或任意外部操作幂等 |
| 工具契约快照 | `tests/tool-constraints.test.ts` 5 项，通过且包含在最终全量结果中 | 内置契约校验、OpenAPI 参数路由变化、原生 schema 漂移、冻结子流程调用 | 无可信宿主身份时已经获得授权，或真实插件实现语义永不改变 |
| 客户端回归 | `tests/workflow-v2-client.test.tsx` 及既有画布、批注、侧栏、选择器测试 | 组件状态、草稿隔离、JSON 检查及兼容行为 | 真实宿主布局、Tooltip、原生焦点或重启行为 |

可复核命令（使用现有依赖，不触发重新安装）：

```sh
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc -p tsconfig.host-build.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit
node scripts/build.mjs
```

第一轮完整构建包含 Host TypeScript 编译、Remote 声明生成和 Client TypeScript 编译，当时均通过。构建成功本身不表示插件已安装到用户当前 Desktop。

**第一轮构建与回归记录（历史证据）：**

| 项目 | 结果 |
| --- | --- |
| 完整自动测试 | 2026-10-16，57 个文件、527 项通过，0 项失败；主任务第一轮运行结果 |
| 旧 Agent 审计 fixture | 已按原生 Agent 适配更新，最终全量测试通过 |
| Host / Client 类型编译及 Remote 声明 | 最终完整构建通过；构建脚本包含两端 TypeScript 编译及声明生成 |
| 第一轮包 | [dsh-visible-dynamic-workflows-0.0.1-prd-v2-final-macos-arm64.tgz](../artifacts/dsh-visible-dynamic-workflows-0.0.1-prd-v2-final-macos-arm64.tgz) |
| 包大小 | 32,072,268 字节；第一轮文档记录时已核对 |
| 包 SHA-256 | `139e7ec8d3a240a80c4ee6dd8c440ac0e6508b9cf4b91ee3fa13dfb882726381`；第一轮已计算并核对 |
| 打包内容与真实安装内容一致性 | 第一轮 `lib/index.js`、`lib/client.js`、`runtime/graphon_bridge/main.py` 的本地文件、包成员与 Desktop 副本三方 SHA-256 一致；详见第 6 节。这不是第二轮当前安装的哈希证明 |

### 5.2 第二轮最终回归与构建

第二轮在现有画布和运行详情中增量接入新能力。下表记录该轮新增或更新的回归覆盖；这些测试文件后续仍可能继续扩展，历史总数只对应当时日志。SDK、模型和外部动作使用明确测试替身；Graphon 集成回归执行实际图引擎。

| 能力 | 对应回归 | 覆盖重点 |
| --- | --- | --- |
| 恢复计划与语义摘要 | [recovery-plan.test.ts](../tests/recovery-plan.test.ts) | 布局/名称/便签不影响执行摘要；冻结的有效上下文和结果影响确认摘要；逐实例、迭代/循环失效及外部动作阻断 |
| 恢复确认与预算 | [runtime-v2-continuation.test.ts](../tests/runtime-v2-continuation.test.ts) | 只读预览、拒绝旧计划、复用确定性结果、补充指令重复提交、累计 usage 只结算一次、未知占额和工作区并发 |
| 原生过程与指令 | [native-agent.test.ts](../tests/native-agent.test.ts) | 所属任务访问、实际事件投影、原任务追加、不可补充状态、稳定消息/预算身份、不重开已结束任务 |
| 修复暂停与人工输出 | [runtime-v2-continuation.test.ts](../tests/runtime-v2-continuation.test.ts)、[native-agent.test.ts](../tests/native-agent.test.ts) | 修复耗尽/禁用/预算限制，候选与尝试保存，人工验证失败保留暂停，通过后不重放原动作 |
| 同一运行修订 | [runtime-revision.test.ts](../tests/runtime-revision.test.ts) | 根运行排空、固定保护、旧快照历史、预算和输入保留、摘要过期拒绝、展示变化不建立修订、应用后仍暂停 |
| 运行详情交互 | [run-governance-client.test.tsx](../tests/run-governance-client.test.tsx) | 预览后才确认、阻断禁用、失败重试、普通继续不能绕过待纠正输出、修订候选不随窗口外编辑改变 |
| 事件序号 | [run-event-sequence.test.ts](../tests/run-event-sequence.test.ts) | 稳定 ID、无变化不追加、重启续接、旧行不重写、已有高位序号及 Host 锁 |
| Agent 输出配置与引用 | [agent-config.test.tsx](../tests/agent-config.test.tsx)、[variable-browser.test.tsx](../tests/variable-browser.test.tsx) | 沿既有配置面板编辑结构化字段，保存前即可选择引用；保留真实默认 `text/json/steps` 类型，不把旧 `tool_results` 当稳定契约 |

| 第二轮最终验收项 | 状态 |
| --- | --- |
| 最终全量测试文件数、用例数及失败数 | 2026-10-16 23:41，65 个文件、618 项通过，0 失败；[测试日志](../.cache/prd-v2-host/full-suite-final.log) |
| 最终 Host / Client 类型编译及完整构建 | 通过；包含两端 TypeScript、Remote 生成和打包编译；[构建日志](../.cache/prd-v2-host/build-final.log) |
| 最终包路径、大小、SHA-256 及安装文件比对 | 最终包 `dsh-visible-dynamic-workflows-0.0.1-prd-v2-verified-macos-arm64.tgz`，32,159,870 字节；SHA-256 `25f62ad59538e4013e51dac45c24f7ece73b0c161b381daa3a0d6ee6ccfd5011`；包内全部 lib 文件及执行桥与本地/安装副本一致 |
| 第二轮真实 Desktop 安装、冷启动、界面及执行 | 最终包已安装，新 Host PID 22531；存量数据及确定性执行通过，详见第 6.4 节 |

### 5.3 PRD 验收编号覆盖

本表区分当前代码覆盖与实际宿主证据；第一轮 UI 覆盖见第 6.1～6.3 节，第二轮构建与宿主核验见第 5.2、6.4 节。本轮最终自动结果见第 5.4 节，最终现场结果见第 6.5 节。

| PRD 验收编号 | 当前覆盖与状态 |
| --- | --- |
| AC-01 | 迁移成功、失败、重复执行有自动测试；真实 schema 2 迁移、原 2 个流程/预设/10 条运行保持不变和备份一致性已核实 |
| AC-02～04 | JSON 往返、协议拒绝、说明导出及逐项依赖映射、revision 覆盖导入已有实现和回归；映射依赖目标宿主，子流程资产不递归随包；本轮真实新身份导入通过；逐项映射和覆盖仍未现场验收 |
| AC-05 | 真实 Desktop 全窗与窄侧栏双入口均为纯图标；面板打开通过；Tooltip 原生悬停、多选、运行中及完整键盘组合未专门验收 |
| AC-06 | 普通变量类型、重命名、重复名和引用反馈有自动测试 |
| AC-07 | 普通必填缺失可在执行前补全，保存后继续原流程/会话并防重复提交；必需 Secret 无输入框且继续阻断；补全值为普通流程配置 |
| AC-08～16 | 声明及不安全路径拒绝、只读能力报告、严格 Secret 草稿白名单与错误不反射已有代码和回归；报告固定不可用。真实保管、授权使用、回显净化、轮换撤销尚未实现和验收，P0-B 保持阻断 |
| AC-17～18 | sys 只读、禁止伪造、null 与不支持字段已实现并测试；真实 Desktop 确认只读 7 字段；独立无会话运行未在本轮现场复验 |
| AC-19 | 真实 Desktop 按历史 v27 快照重跑生成新 run ID 并保留 sourceRunId；跨会话真实授权与恢复仍需现场验收 |
| AC-20～21 | 原生适配及同一执行器入口已有代码和模拟回归；首次真实双任务创建成功但桥接工具验收失败。修正后的原生双任务、精确工具清单、实际调用及结果已通过第 6.5 节真实复验；主 Agent 工具发起场景未单独现场验收 |
| AC-22～24 | 并发、排队取消、原子预算、未知 usage、修复计费有回归；真实双任务并行与 usage 结算通过；排队取消、补充指令、预算不足及修复计费未现场验收 |
| AC-25～27 | 暂停排空、快照、不重复结算、晚回调和重启读取有自动测试；真实 Desktop 安装后冷启动、旧运行读取及新快照运行通过；执行中退出、暂停/继续及未知预算的真实宿主场景未验 |
| AC-28 | 逐实例预览、失效传播与摘要确认已实现；执行阶段新增文件指纹。恢复中含文件要求的结果仍保守失效，尚未接入当前指纹比较复用；外部服务动态数据不默认缓存 |
| AC-29 | 自动重放阻止及“已完成／允许重做／放弃”人工判定已实现；过期计划、失效上下文及文件证据不能被手填结果绕过。通用动作意图/幂等键登记和服务回执自动查询未交付 |
| AC-30 | 结构、长度、文件存在与内容变更可验证，详情显示证据；必读需可信原生完整成功回执。生产 `trustedFileReadTools` 未提供，未知工具回执只能标未验证并阻断，不计真实阅读验收通过 |
| AC-31 | 本轮补入 A/B 与授权范围、持久累计次数、一次修复确认和空工具限制；独立运行先确认，一次确认结束仍暂停；默认两轮且共享预算。真实模型修复链路待验 |
| AC-32 | 提案接受/拒绝、revision 冲突、固定保护有回归；第二轮增加暂停根运行的差异预览、确认修订、旧快照历史和预算保留，应用后仍暂停 |
| AC-33 | 持久草稿、会话隔离、保存/删除 CAS、旧数据兼容及冲突保留本地内容有回归；Desktop 多窗口、重开及成功发送批次清理待验 |
| AC-34 | 八种逻辑门真值、输入及分支执行已有测试 |
| AC-35 | 模板分层、独立复制、归档恢复有自动测试；真实 Desktop 展示 2 个只读内置模板和个人模板区通过；未执行创建、归档或恢复 |
| AC-36 | 不支持能力明确报错、无静默本地 Agent 回退已有模拟验证；实际宿主及其他平台需分别记录 |

### 5.4 本轮最终自动回归与构建（2026-10-17）

本轮最终 [Vitest JSON 结果](../.cache/prd2-native-validation/vitest-final.json)包含 **79 个测试文件、743 项测试全部通过，0 项失败**；文件数依据 `testResults.length`，不是 JSON 中包含嵌套分组的 suite 数。主任务确认 Host / Client 类型检查、Remote 生成及完整构建通过；[构建包核对记录](../.cache/prd2-native-validation/build-final.json)记录包与本地构建文件一致。首次 739 项通过检查点及真实失败经过保留为过程证据，不能代替这里的最终回归或真实复验。本次文档更新只读核对结果与源码，未调用模型、读取真实秘密或操作 Desktop。

| 本轮增量 | 可定位的回归 | 明确边界 |
| --- | --- | --- |
| Agent 可选超时及原生适配 | [agent-timeout.test.ts](../tests/agent-timeout.test.ts)、[agent-config.test.tsx](../tests/agent-config.test.tsx)、[native-agent.test.ts](../tests/native-agent.test.ts) | 严格范围、旧配置兼容、首次组装前桥接、并发子任务隔离、own-scope 委派工具拒绝、子任务原生呈现、run_code guard 与提示过滤、仅 structured_output 修复；SDK 形状模拟不证明最终真实模型生命周期 |
| 草稿 CAS 与原有编辑 | [draft-concurrency.test.ts](../tests/draft-concurrency.test.ts)、[client-store.test.ts](../tests/client-store.test.ts)、[chat-bridge.test.ts](../tests/chat-bridge.test.ts) | 旧 revision 读取、并发冲突、过期删除、内容未变不写、保留本地编辑和批注行为 |
| 依赖映射与覆盖导入 | [workflow-import-mapping.test.ts](../tests/workflow-import-mapping.test.ts)、[workflow-import-client.test.tsx](../tests/workflow-import-client.test.tsx) | 模型/工具/角色/子流程及逐文件映射、目标路径、版本冲突和显式覆盖；无生产导入结论 |
| 普通配置补全与归档影响 | [run-preflight-client.test.tsx](../tests/run-preflight-client.test.tsx) | 必填补全、流程/会话变化拒绝、防重复启动、Secret 阻断、引用及活动运行提示 |
| Secret 不可用报告与拒绝路径 | [secret-boundary.test.ts](../tests/secret-boundary.test.ts)、[secret-boundary-panel.test.tsx](../tests/secret-boundary-panel.test.tsx)、[secret-draft-schema.test.ts](../tests/secret-draft-schema.test.ts)、[Host 夹具](../tests/fixtures/secret-boundary-host-fixture.ts) | 真实 Host 类配模拟服务及临时数据；严格声明字段、值/嵌套绑定拒绝、固定错误不反射、旧草稿和普通值兼容；不读取凭据，不接受提供方自报安全。不是 vault、真实隔离攻击或授权服务调用验收 |
| A/B 修复策略 | [runtime-repair-policy.test.ts](../tests/runtime-repair-policy.test.ts)、[repair-policy-client.test.tsx](../tests/repair-policy-client.test.tsx) | 授权分支、单次确认、暂停排空、空工具、次数及共享预算；无真实模型结论 |
| 文件与读取证据 | [file-evidence.test.ts](../tests/file-evidence.test.ts)、[file-evidence-ui.test.tsx](../tests/file-evidence-ui.test.tsx)、[runtime-file-evidence.test.ts](../tests/runtime-file-evidence.test.ts) | 临时真实文件与实际运行适配器；原生提供方和可信工具认证为显式替身。覆盖前后 hash、完整读取链、缺证据阻断、修复保留原证据及 UI 不展示正文 |
| 外部动作人工判定 | [recovery-review.test.ts](../tests/recovery-review.test.ts)、[run-governance-client.test.tsx](../tests/run-governance-client.test.tsx) | 只读来源、摘要冲突、动态上下文、手填输出限制及显式重做；不代表第三方服务已被独立核实 |

| 本轮最终汇总项 | 状态 |
| --- | --- |
| 最终全量测试及日志 | 79 文件、743 项通过，0 失败；[vitest-final.json](../.cache/prd2-native-validation/vitest-final.json) |
| Host / Client 类型检查、Remote 生成及完整构建 | 最终完整构建通过；包含本轮原生工具边界与严格草稿修正 |
| 最终包、大小、SHA-256 和安装文件一致性 | [prd2-native-verified 包](../artifacts/dsh-visible-dynamic-workflows-0.0.1-prd2-native-verified-macos-arm64.tgz)，32,274,555 字节，SHA-256 `4ebcb93b2d6e4a9937334011a8664751ace40675a42a3213ec8e3145dc5cf12b`；包、本地构建及安装副本 6 个关键文件一致，见第 6.5 节 |
| 原流程、角色、历史运行、批注和草稿的数据保留 | 最终基线 4 个流程、18 个历史文件及角色列表全部一致，保留用户副本 r11/5 节点；原画布和连接便签已打开确认，既有草稿无基线不作完整性结论 |
| 真实宿主与真实 Agent 验收 | 第 6.5 节记录真实双 Agent 成功、工具调用与预算，不从模拟宿主推断 |

## 6. 真实 DeepSeekHarness Desktop 验收

**以下保留前两轮真实宿主历史证据；本轮新增能力的验收位置见第 6.5 节。** 第一轮指定项目通过；第二轮最终安装及确定性执行核验通过，范围见第 6.4 节，其余场景仍按未验记录。第 6.1～6.3 节的“当前”“本轮”和文件哈希均指第一轮验收时点，不能证明后续代码已安装。历史复核没有修改流程定义或发送模型请求，开发预览不计入真实宿主证据。

### 6.1 第一轮安装与数据完整性

最终包已安装到 `~/.dsh/profiles/desktop/node_modules/dsh-visible-dynamic-workflows`，Desktop 正常冷启动。以下 3 个关键文件的本地构建文件、最终 tgz 内文件和已安装文件逐一比较，全部字节一致：

| 文件 | 三方一致的 SHA-256 |
| --- | --- |
| `lib/index.js` | `dcf3bc5ca5acec87debbf031214179fc33b8f5f9b3d88e03abec42336993fdee` |
| `lib/client.js` | `777faa2f53db09d25355a5f248f88d5f43fa8e34ac6a7ab832aa669ef51136d7` |
| `runtime/graphon_bridge/main.py` | `df6613bd08a15ec4588b31b3c81d7eb7e2905458fd0498507bc82298ba32dc8f` |

升级前副本为 `.cache/prd-v2-host/library-before.json`，迁移自动备份为 `~/.dsh/visible-dynamic-workflows/library.schema-1.backup.json`。两份文件均为 41,447 字节，SHA-256 均为 `4d77efbb065c30bf3d23300ce86f20473480cf1d421679aee9a941989156174e`，字节完全相同。

| 数据对象 | 只读复核结果 |
| --- | --- |
| 存储协议 | 从 schema 1 迁移到 schema 2 |
| 原流程定义 | 前后均为 2 个，整个 workflows 数组深比较完全一致，包含身份、revision、节点、连线及便签 |
| 角色预设 | 前后均为 0 项，列表完全一致；不能据此声称真实非空预设迁移已现场验证 |
| 原运行 | 原 10 条运行按 ID 读取独立运行文件后逐条深比较完全一致 |
| 新运行 | 只新增 1 条历史快照重跑，当前运行总数 11 |
| 未发送批注草稿 | 本轮未进行真实重启恢复验收；不能由流程定义一致推断聊天草稿完整性 |

完整字段检查、各旧运行的规范化摘要、截图摘要及文件三方哈希记录在 [Desktop 验收 JSON](../artifacts/prd-v2-desktop-verification.json)。其中完整性通过仅指记录的文件和数据检查，不代表全部 PRD 通过。

### 6.2 第一轮已验界面与执行

| 项目 | 实际结果 | 仍未覆盖 |
| --- | --- | --- |
| 现有画布与便签 | 打开原“桌面验收 · 文本处理”流程；画布、原节点和连接便签正常显示；定义未改变 | 本轮未重新操作批注发送、删除或撤销链路 |
| 环境/系统入口 | 全窗和窄侧栏右上角均为两个独立纯图标按钮，无文字标签；可打开面板 | Tooltip 有实现及自动测试，原生 hover 未专门人工确认；多选、运行中和键盘组合未全部覆盖 |
| 环境变量面板 | String / Number / Secret 类型选择器正常工作；表单最终取消 | 未保存新增普通变量，未现场完成引用、重命名、删除与实际运行闭环 |
| Secret 不可用 | 无明文值入口，并明确提示不可配置 | 不等于凭据保险库可用；未验证获准服务调用或泄露防护全链路 |
| 系统变量面板 | 7 个字段只读；5 个受支持字段与 2 个暂不支持字段按协议展示；旧运行未记录值明确显示“此历史运行未记录” | 本轮快照重跑绑定了现有会话，未现场复验独立运行 null 会话 |
| 执行策略与预算 | 对话框正常展示 5 项输入，未更改数值 | 未现场触发预算耗尽或增加预算 |
| JSON 导出 | 对话框正常展示 `formatVersion` 包、原图、便签和依赖 | 未下载、导入或覆盖流程 |
| 模板库 | 正常展示 2 个只读内置模板及个人模板区 | 未创建模板实例、个人模板、归档或恢复 |
| 历史快照重跑 | 原 v27 的 input → template → output 三节点流程成功，953 ms，3 个执行实例均成功；账本的已耗、预留、未知、调用及 Agent 任务数均为 0 | 不涉及 LLM、原生 Agent、外部写入或暂停/继续，不能替代其验收 |
| 当前原图校验 | 当前原定义仍为 v32，保留进入本轮前已存在的未连线 `builtin:time.now` 节点；直接执行被图校验拒绝，未擅自连线或删除 | 当前 v32 图未被修复，不声明其可以直接成功运行 |

快照重跑 ID 为 `572df84a-388c-4cae-8f4e-1388b1a06be6`，来源运行 ID 为 `912e4889-e399-4fe0-b3e4-969861288ac7`。新运行图与来源 v27 图完全一致，输出与来源运行一致，并生成自己的系统 run ID；这证明历史定义重跑与当前 v32 原图相互独立。953 ms 是此次确定性样例实测值，不是性能承诺。

截图：[系统变量与现有画布](../artifacts/prd-v2-desktop-system-variables.png)、[快照重跑成功及零模型账本](../artifacts/prd-v2-desktop-snapshot-success.png)、[窄侧栏双图标](../artifacts/prd-v2-desktop-sidebar-icons.png)。截图各自只支持所展示的状态；类型选择和未保存表单的结论另依据主任务现场操作记录。

### 6.3 第一轮未覆盖的真实宿主验收

真实原生 Agent/模型生命周期、运行中的暂停继续与取消、未知预算下宿主退出、跨会话权限、提案接受/拒绝、未发送草稿重启恢复、JSON 导入及模板创建/归档恢复仍未在本轮 Desktop 完整验证。所有本轮打开的修改表单均取消，原流程定义保持不变。

本轮没有通过生产服务写入或付费模型调用来补验，也不从未测试推断通过。其他平台及系统性能基线尚未测量，不提供未经测量的帧率、延迟或大图规模保证。

### 6.4 第二轮最终安装与数据核验

第二轮中途试跑 `1035507d-fb1c-46c6-bc85-9ac2f16f05a5` 仍由旧 Host PID `11155` 执行，虽然界面和磁盘文件已更新，但缺少新版 `activeRevision` 与事件 `seq`；这一记录明确排除在最终新版引擎证据之外。随后正常退出应用，确认旧 PID 不再存活、Host 锁已释放，再启动真实 Desktop，新 Host PID 为 `22531`。

| 最终核验项 | 结果与边界 |
| --- | --- |
| 安装对象 | 原 `dsh-visible-dynamic-workflows` 插件、原 Desktop profile、原工作流库；未创建替代环境 |
| 最终包 | [verified 构建包](../artifacts/dsh-visible-dynamic-workflows-0.0.1-prd-v2-verified-macos-arm64.tgz)，版本仍为 0.0.1 |
| 文件完整性 | tgz 内全部 lib 文件、package.json、Graphon bridge 均与本地和已安装副本哈希一致 |
| 原有数据 | 2 个流程、角色预设列表、最初 10 条历史运行深比较一致，schema 1 备份字节一致；流程仍为原 v32，没有修改原未连接节点 |
| 新增记录 | 共 3 条确定性验收记录，真实库共 13 条；没有新增流程或模型调用 |
| 最终新版运行 | `85fe9196-a741-4c05-ae3b-eeb8d5c2123f`，源定义 v27，成功，耗时 891 毫秒；3 个节点均成功；图及输出与来源一致 |
| 新引擎标记 | `activeRevision=1`；新增事件含递增 seq 和唯一 `runId:seq`，终态与预算一致；新的 sys 运行身份正确 |
| 界面范围 | 原画布与便签保留，双变量图标和面板可用；快照重跑确认弹窗及真实执行通过；阶段截图仅作为对应时点 UI 证据 |
| 未现场覆盖 | 真模型 Agent 生命周期、补充指令、带外部动作的暂停/恢复/修订、Secret 隔离、原生悬停 Tooltip 等仍不以确定性重跑代替验收 |

最终实际界面截图：[新版宿主运行成功](../artifacts/prd-v2-final-desktop-success.png)。

最终只读核验报告：[prd-v2-final-verification.json](../artifacts/prd-v2-final-verification.json)，所有核验项通过，无失败项。可复现命令：

```sh
python3 .cache/prd-v2-host/verify-final.py artifacts/dsh-visible-dynamic-workflows-0.0.1-prd-v2-verified-macos-arm64.tgz --expected-run-id 85fe9196-a741-4c05-ae3b-eeb8d5c2123f --previous-host-pid 11155
```

最后新增两个专项回归文件：[native-repair-pause.test.ts](../tests/native-repair-pause.test.ts)、[runtime-nested-repair.test.ts](../tests/runtime-nested-repair.test.ts)。分别防止已完成 Agent 动作在修复准入遇暂停时重放，以及子运行纠正后脱离根预算独立续跑；均包含在最终 618 项通过结果中。

### 6.5 本轮真实宿主最终验收（2026-10-17）

使用原 `/Applications/DeepSeek Harness.app` 0.2.0-rc.2、原 Desktop profile、原插件与原工作流库；通过插件管理更新包，正常退出确认旧 Host PID `16855` 已消失、锁已释放，再启动得到新 PID `23848`。没有另建替代宿主，也没有调整主会话模型或工具权限。

| 验收对象 | 实际证据与边界 |
| --- | --- |
| 最终包 | [本轮构建包](../artifacts/dsh-visible-dynamic-workflows-0.0.1-prd2-native-verified-macos-arm64.tgz)，32,274,555 字节，SHA-256 `4ebcb93b2d6e4a9937334011a8664751ace40675a42a3213ec8e3145dc5cf12b`，版本保持 0.0.1 |
| 安装一致性 | `lib/index.js`、`lib/client.js`、两个 Remote JS、Graphon bridge、README 的本地构建、tgz 和安装副本逐字节一致；最新 `cordis.yml` 和含四个 answer-order 扩展的 `cordis.patch.yml` 哈希不变 |
| 原资产保留 | 最终基线 4 个流程深比较一致，包含用户刚编辑的副本 r11/5 节点；角色数组一致；18 个旧运行/事件文件逐项哈希一致。原“桌面验收 · 文本处理”v41 的画布与连接便签再次现场打开确认 |
| 真实运行 | `6c2287d0-8c84-4a68-97f1-ea02cec47650`；从现有画布执行，2026-10-17 09:46:26 开始，10.8 秒结束；使用会话默认 `zai-coding-cn / glm-5.3-flash`、Low，最终 `native-A-ok` 与 `native-B-ok` 正确汇总 |
| 子 Agent A | `90834cf0-0ae2-4016-9a55-8c6cbdac1177`；实际请求工具为 `structured_output` 和 `workflow_bound_tool_1`，后者对应 `builtin:time.now`，真实调用一次且结果成功；用量 4,597 Token |
| 子 Agent B | `1a740ab8-99f5-4ffc-aed4-209e8d10a548`；实际请求仅含 `structured_output`，无行动工具；用量 2,126 Token |
| 原生身份与并行 | 两个持久会话均为 `origin=subagent`、provider `spawn`、depth 1，descriptor 绑定同一 run ID 和各自执行实例；父会话均为 `session-2533647e-0f74-4164-9f69-7eeac486f2e6`；执行时间重叠；请求及调用没有 `subagent` 或 `run_code` |
| 预算 | 实际累计 6,723 Token，调用/任务 2/2，两项分配均 settled，预留 0、未知消耗 0；与原生会话用量一致。不是费用硬上限或性能承诺 |
| 环境与系统变量 | 双图标仍无可见文字；实际打开两面板。Secret 诊断显示真实本地 provider、隔离缺口及 broker 缺失；编辑声明没有密钥输入框，随后取消。系统面板展示本次真实 run/workflow/workspace/session/timestamp，另两字段明确不支持 |
| JSON | 首次通过原宿主导入验收 JSON 为新身份流程，未改原流程；最终包导出预览保留图、便签和 Secret 声明，不带授权或值。目标工作区下拉在本轮自动化点击/键盘操作后未观察到展开，尚未定位是自动化事件还是真实界面问题；因此逐项映射、切换工作区和覆盖导入不记为现场通过 |
| 未现场覆盖 | 真实取消/超时/补充指令、主 Agent 工具发起运行、A/B 模型修复、暂停恢复/修订、普通变量补全、多窗口草稿冲突及重启恢复、原生 Tooltip 悬停、归档恢复。上述仍只按各自代码及自动回归证据记录 |

机器可读证据：[本轮真实 Agent 验收 JSON](../artifacts/prd2-native-agent-verification.json)，19 项只读核对全部通过；该通过仅覆盖脚本中明确列出的范围。只读复核命令：

```sh
node scripts/verify-native-agent-smoke.mjs 6c2287d0-8c84-4a68-97f1-ea02cec47650
```

截图：[真实双 Agent 和预算](../artifacts/prd2-native-agent-success.png)、[真实 Secret 能力报告](../artifacts/prd2-secret-boundary-desktop.png)、[原画布和连接便签](../artifacts/prd2-original-canvas-retained.png)。没有使用真实 Secret；这不是安全凭据保管或资料读取认证验收。

### 6.6 首次真实运行失败证据与后续修正

2026-10-17 在原 Desktop 导入新的“PRD2 · 原生双 Agent 验收”流程，通过原画布直接执行。原有三个流程未用于改造或试跑。运行 `2f5cfc31-362c-4862-b7ed-074c38a2b57b` 使用宿主 GLM-5.3-Flash / Low，创建两个原生 `spawn` 会话，11.3 秒结束、实际使用 5,752 Token。

无工具节点返回 `native-B-ok`；带时间工具节点明确报告未获得配置的工具。因此运行虽以结构成功结束，**本次工具桥接验收失败**。真实子会话的 `request/header` 只含 `structured_output` 与宿主自带 `subagent`，未含配置的时间桥接工具。问题分别是注册时机晚于首轮工具清单生成，以及 SDK 对子作用域自行注册的委派工具不应用继承工具过滤。后续复验必须核对模型实际工具清单、实际工具调用、输出、子任务身份及预算，不能只看运行状态。

上述失败记录保留，不改写为成功。代码已将桥接配置提前到 `agent/created`、首轮提示组装之前，并按精确子 Agent 身份注册执行 guard；在模型请求组装时再次过滤工具 schema 和相关提示区段，覆盖 own-scope 新注册的委派工具。并发子任务、首轮工具可见性及未授权派生工具拒绝已纳入最终自动回归；修正后的新运行通过第 6.5 节现场复验，首次运行仍保留为失败证据。

随后只读审查发现宿主 `run_code` 的 Node 执行环境可直接使用 Node API，不能把它视为仅调用选定业务工具的传输通道；仅过滤其内部工具调用不足以保证节点白名单。本轮修正仅对受管工作流子 Agent 调用 `presentAs('native')`，在实际执行 guard 中明确拒绝 `run_code`，并过滤 PTC 提示与非白名单工具 schema。没有业务工具的输出修复仅呈现 `structured_output`；父 Agent 原有 PTC 不变。缺少必要能力、冲突的子作用域工具呈现或授权工具未进入实际请求时失败关闭。该限制不构成全宿主文件/进程隔离，也不解除 Secret 阻断。

## 7. 尚未交付的关键能力

1. **Secret 安全保管与授权消费仍是阻断项。** 本地代理、固定目标、输出投影、原生录入代码及私有许可组件已部署，但缺少全局入口接管、后台后代生命周期、CLI/MCP 全路径和 Windows 的实机验收。未录入或读取真实凭据，不能把组件完整性检查当作安全授权。详见本轮部署记录。
2. **生产原生文件工具认证尚未接入。** `trustedFileReadTools` 默认未提供；仅凭工具名称/schema、文件存在或模型自述均不能认证已读。必须由 Host 验证实际工具实现后提供可信映射，再取得真实任务完整成功回执；未知回执继续标为未验证并阻断。
3. **外部状态核验还有受限范围。** 外部动作人工判定已实现，但无通用逐工具意图/幂等键记录和第三方回执自动查询。文件前后指纹已用于执行验收，恢复仍对文件依赖保守失效；按当前指纹复用尚未接入。该策略满足“不忽略动态依赖”的安全边界，不代表通用内容缓存已交付。
4. **其余真实交互验收未全部覆盖。** 最终安装、真实双 Agent 及工具调用、预算和数据保留已通过；草稿多窗口/重启、导入覆盖、修复/恢复、取消和追加指令仍须分别验收。真实 JSON 工作区下拉经自动化未观察到展开，其原因尚未定位，不能用离线组件测试代替真实选择验证。独立“用户已要求排查”的自动修复授权入口亦未单独提供，当前可执行授权路径主要是 Agent 工具发起。
5. **扩展范围仍有限。** 逐项映射与 revision 覆盖导入已实现，不再列为缺失；子流程资产递归打包、完整原生会话重放、工作区独立 Token 总配额、公平调度及其他系统验收未交付。它们与 PRD 必须阻断的 Secret/可信读取条件分开记录，不能以当前有限能力推断支持。

交付结论限于已列出的源码实现及有明确轮次的验证证据。P0-B 继续单独标为阻断，上述未交付及未现场验收的缺口继续保留，不能将 PRD v0.0.2 整体写成全部完成。
