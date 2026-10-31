# 主 Agent 早交接与命令简报（T23）

## 1、问题

T22 之后，T20 建图的规划子 Agent 已为 0，受理到保存只需 0.3 s，但从发送命令到回合结束仍要 7 分 9 秒。r8 主 Agent 的会话记录（`.test-data/t23/`，不入库）逐轮拆开如下，思考强度均为 Max，模型 GLM-5.3-Flash。

表 1-1 r8 主 Agent 逐轮耗时（2026-10-23 08:37:59 发送）

| 轮次 | 耗时 | 输出 Token | 在做什么 |
| --- | --- | --- | --- |
| 1 | 183.7 s | 9,367 | **调用任何工具之前**猜测模块内容、在 module／partial／design-only 之间反复权衡，然后才去查目录 |
| 2 | 84.0 s | 5,260 | 读完三份目录（工作流清单 49.9 KB 含全部节点、工具目录 49.8 KB 共 55 个工具、模块目录 3.1 KB），把需求逐条对到模块，提交规划 |
| 3—4 | 26.9 s | 975 | 等待、读取已保存的图 |
| 5 | 116.8 s | 5,459 | 逐节点复查 Host 已验证的 22 节点图；因模块把标题定成“审核后写入 t20-review.txt”而不是用户给的名字，反复考虑要不要改名 |
| 6 | 17.2 s | 694 | 写总结 |

r7（经子 Agent 路由）同样是第 1 轮 177.3 s 盲想，其后 8 次 `plan_wait`（每次最多 60 s），其中 2 次被 DSH 判为“重复相同调用”。

结论：

- **最大的一块是“没看信息就先想”。** 第 1 轮 35k 字思考里，大部分在猜模块里有没有探测和读取、该走哪条路由；这些查一下目录就知道。
- **第二块是复查已验证的东西。** 模块实现已经过离线校验和 Host 完整检查，主 Agent 又用 2 分钟逐节点核对。
- **第三块是用户已定的事被重新讨论。** 标题用户已经给了，Host 没有用，引出一轮权衡。
- 读目录本身很快（缓存命中、预填只要几秒），问题是读完要在 100 KB 里找出相关部分。

## 2、为什么不用 fork 继承主 Agent

用户提出把主 Agent 分支一份给子 Agent，让子 Agent 继承主 Agent 的思考。评估后不采用，与[文档 10](10-子Agent长响应优化研究与实施建议.md) §3.1、表 7-1 和 S02.4 的结论一致：

- fork 复制的是对话历史（文本和工具结果），继承不到思考。GLM、DeepSeek 这类接口在多轮对话中本就不回传上一轮推理。
- 慢在生成思考 Token，不在读输入。前缀缓存只省预填；规划子 Agent 的系统提示和工具集与主 Agent 不同，前缀对不上；为了命中缓存保留主 Agent 工具，又会失去规划器的工具隔离（`src/host/planning/agent.ts` 要求 `inheritsParentContext=false`）。
- r7 子 Agent 只发 2 次请求，不重查目录；它的 18k Token 思考花在手抄配方，给它主历史不会减少。

用户真正要的两点——理解只做一次、不占主 Agent 上下文——用“早交接”更直接：需求一进来就交给独立的规划子 Agent，主 Agent 不先理解。fork 只保留为有条件的对照实验，需用户另行同意真实调用。

## 3、原理

- **先给信息，再让模型想。** 模型在缺信息时会用思考去猜。能由 Host 确定提供的目录、模块合同，在第一轮请求里就给出精简版本，而不是让模型先想再查。
- **理解只做一次。** 需求由谁理解，就由谁设计；不让主 Agent 理解完再转述给子 Agent，也不让子 Agent 重新理解一遍。
- **已验证的不再复查。** Host 已完整校验的模块实例，以回执说明验证范围，不要求模型逐节点再核对。
- **用户已定的不再讨论。** 用户给出的名称、模式等明确决定直接采用，不交给模型权衡。
- **不降低思考强度。** 只减少需要猜和要权衡的内容，不改模型和强度（[T22 原则](17-审核写入模块与配方唯一写法.md)）。

## 4、改法

- **T23.1 命令简报。** `/dsh-visible-workflows` 带需求时，Host 预取并附上精简简报：工作区、模块目录（id@版本、适用条件、参数、固定行为与人工环节说明）、工作流索引（id、标题、版本、节点数，不含节点）、一张路由表（各路由何时用、用户明确只设计时才 design-only）。简报由 Host 生成，供 T23.2 的子 Agent 和回退时的主 Agent 共用；完整目录仍可查询。
- **T23.2 直接受理（早交接）。** 命令带需求时，Host 立即以原始需求和简报受理一个规划任务，由独立上下文的规划子 Agent（不 fork）判断路由：
  - 参数齐全且匹配模块 → 填参数，Host 实例化，0 次额外设计；
  - 需要设计 → 同一子 Agent 继续设计，模块外部分局部补全；
  - 缺必要信息 → needs-input，经现有机制由主 Agent 问真人；
  - 不是新建（如修改已有图、目标不明）→ 交回主 Agent，带简报按现行路径处理。

  主 Agent 收到的跟进消息只含需求和 taskId，职责为等待、转达问题、汇报结果。执行模式规则不变：默认 execute-first，用户明确只设计时 design-only。不得修改用户未指定的已有图。
- **T23.3 采用用户给的标题。** 规划请求可带明确标题；模块新建时优先使用，未给时沿用现有默认标题。不改变模块固定实现及其摘要。
- **T23.4 模块回执。** 模块路由发布后，结果附带回执：模块与版本、参数值、固定实现摘要、已通过的检查（含 REVIEW_BEFORE_EFFECT）、固定行为与人工环节说明。指引说明模块结果凭回执汇报，不必读整图复查；用户要求核对时照常可读。
- **T23.5 等待不重复。** `plan_wait` 增加事件游标参数，后续等待从上次看到的事件继续，返回新增进度，避免相同参数的重复调用；先核实 DSH 对单次工具调用时长的限制，若允许再评估提高单次等待上限。

## 5、验证

- 离线：简报内容与大小、路由分流（模块／设计／needs-input／交回主 Agent）、用户已定的模式和标题不被改写、旧请求和旧记录照常可读、模块摘要不变、等待游标幂等。
- Desktop，思考强度 Max 不变，每项各跑一次并记录发送→保存、发送→回合结束、主 Agent 与子 Agent 的请求数和输出 Token：
  - 同一 T20 需求，与 r8 的 4 分 28 秒／7 分 9 秒对比；
  - 一个不能被模块覆盖、需要子 Agent 设计的新建需求。安装前先在 r8 上跑一次作基线。
- 不另跑配对基准；以 Desktop 绝对耗时和调用数判断。

## 6、后续

- **T24 扩充模块库。** 按 T23 实测和文档 10 §4.2 的候选，把常见结构逐个沉淀为已验证模块。
- **T25 骨架先交、尽早校验。** 子 Agent 先提交节点清单与连接骨架，Host 立即检查后再填配置，避免整图交上去才发现协议错误。

两项在 T23 测量后再定范围。


## 7、实施结果

- 命令简报由同一 Host builder 生成，供 intake 和交回主 Agent 的路径共用。模块资料来自注册表；工作流仅投影身份、标题、版本和节点数。当前 2 个模块加 8 个工作流为 4,397 字节，测试要求小于 6,500 字节。明确标记 Host 内容，不混入用户原话。
- `commandEarlyHandoff` 默认开启。带需求时立即受理后台规划任务，冻结原始需求、简报及调用模型；主 Agent 只收到原始需求和等待通知。请求身份由工作区、主会话和命令调用身份确定。关闭开关后，恢复原来的 command → followup，空命令路径不变。
- T23.2（b）采用同一次独立 activation 完成路由和设计。`CommandIntakeCompiler` 包装原 compact-repair／template-fill 编译器；只设计及只读预览的开放新建不再启动第二个设计会话。完整模块沿用 S02 module 合同，由 Host 实例化；缺信息沿用原 needs-input；已有图修改或目标不明时返回原路径和简报。没有 fork，仍要求 `inheritsParentContext=false`；模型与思考强度不变。
- execute-first 继续使用原试做入口，冻结任务、允许工具、输入、产物及验收条件。它的试做和证据提炼阶段仍分开：原生 `structured_output` 接受即结束 activation，可信试做证据也只能在真实执行并验收后产生。未把试做前的设计当成证据提炼，未绕过权限或改成 design-only。开放设计本身不采用 intake 再交第二个 planner 的备用方案。
- 新建模块时 `PlanningRequest.title` 优先；省略时保持原默认标题。表格模块的 `parameters.title` 仍控制表格正文标题，不受工作流名覆盖。两模块固定实现摘要不变；历史请求、任务及发布回执无需新增字段，离线重启验证保留原记录字节。
- 模块发布视图的 `receipt.verification` 包含模块版本、实际参数、固定实现摘要、结构／引用／权限／模块来源／工具前置条件／REVIEW_BEFORE_EFFECT 检查及固定行为、人审说明。不改变旧存储回执合同。主 Agent 凭回执汇报，用户要求核对时才读整图。命令任务支持原 turn-join；等待、回答、发布和取消保留真实关联任务的身份与权限。
- `plan_wait` 新增 `event_cursor`，按任务、主会话和工作区绑定，仅返回未见事件。静默超时也返回新游标，后续调用参数不同。取消等待不取消任务。已检查安装的 DSH SDK 类型：`dsh-tools/lib/types/index.d.ts` 152–158 行公开可选 `timeoutMs`，省略表示无声明期限，由独立工具超时策略执行；未找到完整调用链可安全延长的保证，保留 60 秒上限。
- 离线覆盖模块／同会话设计／needs-input／交回主 Agent、两种编译器、只读预览、幂等、忙碌主会话的 join、游标、旧记录启动及关闭开关后的原行为。未调用真实模型，未安装插件，未改用户 profile。Desktop T23.6 留待单独验收。
- 最终 `npm run typecheck`、`npm run build` 各运行一次并通过。定向回归 15 个文件、262 项通过。回环端口预检在沙箱内返回 `EPERM`，唯一一次全量 `npm test` 因此在沙箱外运行：252 个文件中 251 通过、1 失败；3,309 项中 3,308 通过、1 失败。失败为旧 model-source 夹具仍假定命令延后模型选择；将其明确设为关闭早交接的回退合同后，与新 intake／join 一起单独复验，3 个文件、19 项全部通过。按要求未运行第二次全量，不把定向复验写成全量重新通过。
- 复核（2026-10-23）：修正夹具后在沙箱外重跑一次 `npm run typecheck` 与全量 `npm test`，252 个文件、3,309 项全部通过。

## 8、Desktop 实测：早交接被否定（r9，2026-10-23）

同一模型、Max 强度，各跑一次。原始记录在本地 `.test-data/t23/`，不入库。

表 8-1 r8 与 r9（早交接开启）对比

| 需求 | r8 | r9 |
| --- | --- | --- |
| T20 审核写入 | 7 分 9 秒，成功（模块路由） | **13 分 22 秒，失败**（PLANNING_REPAIR_LIMIT） |
| 成绩分级统计（需设计） | 3 分 8 秒 | 5 分 59 秒 |

- **T20 失败是实现缺陷。** 子 Agent 认出了模块，但 `mode:request` 是自由对象，它只能猜整个规划请求：没带 `handoff.module`，又在 design-only 里加了多余字段，被拒。拒绝反馈与设计修复同格式，诱导它用补丁修请求，再被拒。路由与设计共用 3 次提交，剩 1 次时它改为手工设计审核写入结构（320 s，正是 T22 消除的手抄），最后一次提交即触上限。
- **成绩分级变慢是方案问题。** 子 Agent 同时负责理解、选路由和设计，首步思考 144 s；r8 是主 Agent 理解 62 s 后交出提炼指令，子 Agent 设计只要 32 s。主 Agent 未参与理解，保存后又用 127 s 对照原始需求复核（r8 为 33 s）。
- **等待游标有效。** 每次等待约 9 s，未再出现重复调用告警。

处置：经用户同意，Desktop 配置加 `commandEarlyHandoff: false`，回到 r8 路径并保留标题、回执与游标。

## 9、新学到的原理

- **理解成本不会因换人而消失。** 谁理解需求都要付出这份思考；省下来的只能是空想、写错和重复核对。
- **提炼过的指令让下游更快。** 主 Agent 把需求整理成明确指令，缩小了子 Agent 的选择范围；合并成一个角色反而扩大了单次决策空间（T21 原理的又一例）。
- **核对的成本跟着理解走。** 没参与理解的一方要从头核对；回执能替代的只是结构检查，不是语义理解。
- **新路由必须有专用合同。** 让模型手写通用请求等于让它猜；每条路由只给它需要填的字段，并与其他阶段分开计数。

## 10、第二版改法

保留“主 Agent 理解、子 Agent 设计”的分工，只去掉主 Agent 的浪费：

- **T23.7 简报给主 Agent。** `commandEarlyHandoff` 默认改为关闭。命令带需求时，跟进消息附上同一份 Host 简报（模块目录、工作流索引），并给出新建请求的准确骨架（必填字段、design-only／execute-first／module 三种写法各一份），不再重复系统指引中的规则。
- **T23.8 设计路由回执。** 设计路由发布后同样附带回执：需求覆盖、已通过的检查、假设与未决项。主 Agent 凭回执汇报，用户要求核对时才读整图。
- **T23.9 早交接缺陷留档。** 早交接保持关闭；若以后再评估，先给模块路由专用合同、路由与设计分开计数、反馈格式与提交格式一致。本轮不修。
- **验证：** 离线回归；Desktop 重跑 T20 与成绩分级两个需求，对比 r8（7 分 9 秒、3 分 8 秒）。


## 11、第二版实施结果

- **T23.7：** `commandEarlyHandoff` 默认关闭，显式 `true` 保留 intake。普通命令的首段原文和 `source.kind=user` 不变，第二段单独标记 Host，附同一模块目录、工作流索引及 design-only／execute-first／module 三种新建请求骨架；骨架以真实 `parsePlanningEntry`、规划 schema 和两模块参数合同回归校验，省略非必填项，标题另列为可选字段。空命令不变。
- 简报路由文字缩为 `visible-workflows:guide` 指针，不再重复路由规则。2 个模块、8 个工作流加骨架为 **4,604 字节**，测试预算仍为 6,500 字节；不含工作流节点配置。
- **T23.8：** 非模块、子 Agent 创作的设计发布后，publish／wait／get 视图统一附 `receipt.verification`：创作覆盖映射、实际通过的 Host 检查、假设及未决项（含人工复核和资源就绪问题）。检查与候选摘要绑定；来源和优化检查仅在实际执行相应校验时记录。明确声明仅为 Host 结构检查，覆盖声明不是业务行为证明。
- 新任务才启用可选 `designChecks`，历史记录缺省保持缺省，不追补验证结论；存储 receipt 合同不变，重启和切换编译器保留回执及原文件字节。系统指引合并为一处“模块与设计均凭验证回执汇报，用户要求核对才读整图”。
- 定向回归：13 个文件、188 项全部通过；开发中曾有 2 项旧夹具把视图回执等同存储回执，已改为分别核对并复验通过。最终 `npm run typecheck`、`npm run build` 各一次通过。沙箱内回环端口预检返回 `EPERM`，唯一一次全量 `npm test` 在沙箱外运行：252 个文件中 251 通过、1 失败；3,312 项中 3,311 通过、1 失败。失败是另一处旧 Host 夹具把存储回执与视图回执直接比较；修正为分别核对后，4 个文件、7 项定向复验全部通过。未重跑全量，不将复验写作全量通过。
- 未调用真实模型、未安装插件、未改用户 profile，未暂存、提交或推送。T23.6 Desktop 复测和 T23.9 早交接缺陷修复均未执行、未勾选。
- 复核（2026-10-23）：修正夹具后在沙箱外重跑一次 `npm run typecheck` 与全量 `npm test`，252 个文件、3,312 项全部通过。

## 12、第二版 Desktop 实测（r10，2026-10-23）

同一模型、Max 强度、早交接关闭，各跑一次。原始记录在本地 `.test-data/t23/`。

表 12-1 r8 与 r10 对比

| 需求 | r8 发送→结束 | r10 发送→结束 | 变化 |
| --- | --- | --- | --- |
| T20 审核写入（模块路由） | 7 分 9 秒 | **4 分 56 秒** | −31%；发送→提交规划 4 分 12 秒→2 分 46 秒 |
| 成绩分级统计（子 Agent 设计） | 3 分 8 秒 | **2 分 48 秒** | −11% |

- 两次规划请求都一次通过校验（r8 基线漏写 `operation`、查了无效主题）；标题按用户给的保存。
- 模块路由保存后主 Agent 凭回执汇报，不再逐节点复查；设计路由的回执也被采用。
- **仍剩的浪费：**
  - T20 首轮仍思考 113 s，大部分在猜 `producer.text` 的模板语法（`{{#if}}`、`{% if %}` 还是直接拼接）。简报只写“可引用 reviewBase/reviewNote”，没有给一份填好的参数示例。
  - 保存后主 Agent 用约 85 s 读工作流清单、grep、脚本，核对“已有 T05／T20 图未被修改”。回执没有说明本次对工作区的改动范围。
  - 简报 JSON 显示在用户消息气泡里（与原话同一条消息），界面不友好。
- 成绩分级的子 Agent 本次单步 70 s（r8 为 32 s），属同一需求的单次波动；只有一次样本，不作结论。

## 13、第三版改法（2026-10-23 用户批准）

- **T23.10 简报不进用户气泡。** 简报只在 `/dsh-visible-workflows` 带需求时由 Host 生成，与用户原话同一条消息会显示在气泡里。改为放入 SDK 支持的、模型可见但界面不作为用户原话显示的上下文通道；用户气泡只显示原话。须以 SDK 类型或源码为依据选择通道。
- **T23.11 模块参数示例。** 模块目录为每个模块附一份填好的参数示例（含 `producer.text` 的真实模板写法：首轮固定初稿、退回轮拼入 reviewBase／reviewNote）。示例须经模块参数合同校验、能实例化，并测试模板在首轮和退回轮的渲染结果。
- **T23.12 回执写明工作区改动范围。** 发布回执附本任务对工作区的改动：新建／修改了哪张图；其他工作流在受理时与发布时的版本是否一致，不一致的如实列出、不归因于本任务。主 Agent 凭此汇报“未修改已有图”，不再读清单核对。
- 验证：离线回归；Desktop 重跑 T20 与成绩分级，对比 r10（4 分 56 秒、2 分 48 秒）与 r8。

## 14、第三版实施结果

- **T23.10：** 简报改放 Agent 局部、`interpolate:false` 的 system-prompt section。SDK 支持按 scope 注册 section、按请求 signal 求值（`node_modules/@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts:37–58、242–250`）；system 与 user 是独立消息角色（`node_modules/@deepseek-ai/dsh-llm/lib/types/message.d.ts:134–145`）。以命令消息 ID 匹配 `agent/pre-step` 接纳批次（`node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:293–310`），在该命令已接纳回合的每个步骤保留同一份简报，按相同 turn 与 signal 绑定且字节稳定；回合结束／停止、取消、Agent 释放、丢弃或插件卸载时清理，进入其他 turn 或 signal 前也清理，排队命令不投到忙碌的前一回合。用户消息沿用 `/dsh-visible-workflows` 加原有 separator 与 rawInput：rawInput 已含前导空白时原样拼接，否则补一个空格；`source.kind=user`；空命令与显式早交接路径不变。
- **界面依据：** SDK 将用户正文列为 `UserMessageNode.content`（`node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/types/client/contract/records.d.ts:45–52`），系统提示另走请求检查快照（同包 `request-inspection.d.ts:5–18`）；编译客户端也单独解释 `system/message`（同包 `lib/client.js:1674–1738`）。因此简报不再进入用户正文；系统提示仍可留在 SDK 的请求检查／日志中，不宣称完全不可查看。安装包未提供 Desktop 目标的完整渲染定义，本轮未作 Desktop 实测。
- **T23.11：** 共用模块目录新增 `parameterExample`，简报和 `visible_workflow_modules` 同源。审核写入用 `{% if reviewBase or reviewNote %}{{reviewBase}}\n修改意见：{{reviewNote}}{% else %}这是固定初稿。{% endif %}`；真实路径是 `src/shared/planning-reviewed-file-module.ts:18–21` → `src/host/runtime.ts:680–683` → `src/host/template.ts:4–6、43–49、58–66` 的受限 Jinja 引擎。首轮无变量及空字符串均输出固定初稿，退回轮组合表单正文与意见；两示例通过参数合同、Host 模块实例化及渲染回归，固定实现摘要未变。2 模块加 8 工作流简报为 **4,953 字节**，仍小于 **6,500 字节**，预算未提高。
- **T23.12：** 新建任务受理时冻结 `id → revision`，发布时与原子保存同步采集第二端点；包括当前工作区与全局可见流程、归档流程，排除其他工作区私有流程。视图 `receipt.verification.workspaceChanges` 列出本任务创建的图、其他图的两端版本、是否一致及变化 ID；新增／消失用 `null` 表示，其他变化明确不归因于本任务。后续 get／wait 和重启沿用冻结端点，不把发布后的编辑算进来。存储 receipt 格式不变；旧发布／待发布任务缺少快照仍可加载、发布且省略此节，崩溃恢复缺少发布端点时也不猜测。系统指引仅增加一处凭本节报告“已有工作流未修改”。
- **验证边界：** 仅离线夹具、真实 SDK 提示组装和隔离 Host／存储回归；无真实模型调用、插件安装或用户 profile 改动。T23.13 Desktop 复测保留未勾选。
- **检查结果：** 最终定向 `npx vitest run` 为 12 文件、103 项全部通过；最终 `npm run typecheck`、`npm run build` 通过。沙箱回环预检 `EPERM` 后，唯一一次全量 `npm test` 在沙箱外运行：253 文件中 252 通过、1 失败，3,326 项中 3,325 通过、1 失败。失败为 `planning-config-rollback-host` 模拟旧记录时未删除新快照字段；补删并明确断言缺省后，仅运行 `npx vitest run tests/planning-config-rollback-host.test.ts`，1 文件、3 项全部通过。未再跑全量，不将定向修复复验写作全量重新通过。未暂存、提交或推送。
- **复核修正：** 简报改为覆盖完整命令回合，恢复原有 separator 兼容逻辑；同回合多步骤字节一致、下一回合隔离及停止／结束／取消／释放的定向回归为 4 文件、29 项全部通过，`npm run typecheck` 通过。本次复核未运行全量测试或构建。
- 复核（2026-10-23）：简报生命周期与分隔符修正后，在沙箱外重跑一次 `npm run typecheck` 与全量 `npm test`，253 个文件、3,331 项全部通过。

## 15、第三版 Desktop 实测（r11，2026-10-23）

- **用户气泡只显示原话**：两次截图确认没有 JSON／Host 数据，简报只在系统提示中。
- **T20：发送→结束 3 分 5 秒**（r10 4 分 56 秒，r8 7 分 9 秒）。首轮思考 64 s（r10 为 113 s），发送→提交规划 2 分 9 秒；保存即时，主 Agent 直接按回执 `workspaceChanges` 汇报“其他 16 张图未变”，不再读清单核对。首轮仍调用了一次 `visible_workflow_modules`（3.9 KB）。
- **成绩分级：未保存，PERMISSION_BLOCKED。** 原因不是权限，也与第三版改动无关：
  - 规划子 Agent 的提交漏了 `title`。r8、r10 的同一需求都带了 `title`，这次属模型单次遗漏。
  - Host 编译器容许缺 `title` 并通过编译；但 SDK 按工具 JSON Schema（第一分支 `required: title, forms, coverage`）校验参数时拒绝。
  - `src/host/planning/agent.ts` 把“编译通过但工具结果被拒”记为不可修复的 `COMPILER_COMMIT_REJECTED`，并被 `isPermissionFailure` 归为权限失败。子 Agent 没有修复机会，主 Agent 据此告诉用户“需要解除权限”，误导。
- **原理：Host 校验与对外 Schema 必须是同一份合同。** 二者宽严不一时，模型一次小遗漏就变成不可修复的失败，还被误报成权限问题。

## 16、T23.14 实施结果

- **SDK 校验来源：** 安装的 `@deepseek-ai/dsh-subagent@0.2.1-rc.1/lib/types/structured.js:63–68` 使用 `validateJsonSchemaValue(schema, args)`，失败抛 `ToolArgsError`（`INVALID_ARGS`）。它来自 `node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js:574–575`，是 SDK 自带校验器，不是 Ajv；该文件 `440–442` 要求 `oneOf` 恰好匹配一个分支。
- **编译前统一合同：** Host 对原始参数同时校验本次模型请求实际声明的 Schema（首轮／修复轮均保留快照）和 SDK 固定终结工具 Schema，复用上述校验器；展开分支诊断以指出 `title` 等缺失／错误字段。失败走同一提交计数与观察回调，不编译、不暂存、不自动修复、不改变原草稿；首次更正后仍可重交初始声明，已有草稿仍按原修复合同提交。无草稿失败的检查点复用现有 `clarification` 状态保存已用预算，无新增存储版本。
- **标题决策：** 通用 CREATE 的 `title` 保持必填，移除模板编译器从 description／summary／固定文本补标题的行为，空白标题也返回修复诊断。`required` 从核心 Zod 创作合同推导，模板仅将 nodes 映射为 forms，避免再维护两份必填列表。T23.3 的 `PlanningRequest.title` 优先规则针对模块新建，继续保留；它不使通用创作提交的 title 变为可选。未放宽其他字段、修复范围或预算。
- **失败分类：** 晚到的 SDK `INVALID_ARGS` 仍不接受候选，明确提示“工具参数未通过 SDK 工具 Schema 校验”，保留 `COMPILER_COMMIT_REJECTED`；新失败进入 `failed`，不再映射 `PERMISSION_BLOCKED`。真实权限与清理失败规则保留；旧记录原有的 blocked／PERMISSION_BLOCKED 可照常读取，不改写历史诊断。
- **离线回归：** r11 原始参数及工具 Schema 逐字复制为测试夹具（与 `.test-data/t23` 原件 SHA-256 一致）；缺 title 返回可修复反馈，显式补标题后在真实 SDK 终结工具运行时接受。覆盖 compact-repair／template-fill 的 create、edit 与 intake 各路由必填字段、当前／固定 Schema 差异、预算与检查点恢复、晚到的真实 SDK 拒绝、历史任务及 Host 启动。未调用真实模型，Desktop 成绩分级复验仍待单独执行。
- **修复轮补正：** 优化器的 repair-only 曾生成单分支 `oneOf`，属于生产缺陷；SDK 结构断言要求至少两支（`dsh-tools/lib/types/json-schema.js:230–234`），终结工具仍按注册时的固定 Schema 校验（`dsh-subagent/lib/types/structured.js:63–68`）。现从生成处统一折叠单分支，补齐所有模式初始／修复轮的 SDK 断言及参数验证，保留实际广告 Schema 校验，不忽略结构错误。
- 复核（2026-10-23）：单分支 oneOf 在 schema 生成处折叠为该分支本身（`planningOneOf`），所有对外广告的提交 schema 均经 SDK 结构断言与值校验；外层 wire 拒绝计入同一提交预算且不改草稿。全量 `npm test`（254 文件 / 3368 测试）与 typecheck 全部通过。


## 17、r12 结果与修复轮合同回退

- **安装与证据：** r12 已安装，安装产物 SHA-256 前缀为 `e68271a4…`。本地记录位于 `.test-data/t23/r12/` 及同目录的 `r12-*.json` 会话提取副本；不改写原件。
- **成绩分级（grade-stats）：** 14:23:30→14:26:55，共 **3 分 25 秒**；规划子 Agent 90 s，首次提交即接受。r11 的漏标题问题已修复，本次未进入修复轮。
- **T20 失败：** 主 Agent 第 1 步 127 s，随后选择 design-only 设计路由。规划子 Agent 第 1 步 336 s，首次提交收到 3 条 `REVIEW_BEFORE_EFFECT` 可修复反馈。第 2 步 327 s，提交替换 `/formsByKey`、`/chainsByKey`、`/linksByKey`、`/description`、`/summary`、`/coverage` 等路径的补丁，并引入新节点 key；这些修改处于反馈的 allowedPaths 内。
- **失败位置：** Host 在编译前执行本轮对外声明的 Schema 校验。`fragmentSchema(current)` 把旧草稿对象封闭为 `additionalProperties:false`，只准旧 key，因而拒绝新 key，返回 `COMPILER_TOOL_SCHEMA_INVALID`。错误包展开所有提交分支与补丁分支，累计 40 条诊断。第 3 步继续思考 370 s，随后触发总时长保护中止；主 Agent 又询问用户是否重新规划。
- **根因与合同原则：** 已执行校验的对外修复 Schema，必须覆盖修复合同（allowedPaths 加编译器）接受的所有值。**“收窄只能用于提示，执行的合同只能放宽到与编译器一致”**。T23.14 把原先仅作提示的收窄 Schema 变成强制检查，却没有增加这一包含关系的性质测试；标题修复成功不代表修复轮合同一致。

## 18、T23.15 实施

- **保留 Host 双重校验：** 原始参数仍先通过本次模型请求实际声明的 Schema 和 SDK 固定终结工具 Schema，再交编译器；不关闭检查，不改变提交预算、模型或思考强度。
- **草稿形状只作提示：** 旧片段不再决定强制 value 类型或数组元素类型。形状提示中的对象允许新 key，且不把旧 key 列为必填；字段删除、空数组、新对象和值类型纠正均由编译器判定。`issue.expected`、`contracts`、`candidates` 仍提供有来源的类型合同；SDK 子集不能无损表达的合同使用上界并保留说明，避免联合类型转换引入 exact-oneOf 重叠。转换保留 JSON Schema 默认开放对象语义。
- **修正有来源合同中的过度封闭：** chain/link 映射允许有限示例之外的新 key；完成义务对象描述最低必填内容，允许同时提供其他字段，编译器继续校验类型、完成义务和授权范围。严格类型对象的实际封闭合同仍保留。
- **合法子路径也须可达：** SDK 子集无法表达 JSON Pointer 前缀。精确路径保留类型合同；补充一般路径分支，用字符串与精确路径枚举的 exact-oneOf 排除已列出的路径，避免分支重叠。一般分支允许合法新子路径进入编译器；`applyRepair` 仍负责路径、存在性及 allowedPaths 检查，越界补丁不能修改草稿。移除／替换等操作也不再根据旧形状猜测后续同批补丁的目标状态。
- **诊断定向且有界：** SDK 校验器仍独立决定通过或失败；诊断按提交 `mode` 和补丁 `op+path` 选分支，只展开对应字段。未允许的组合只列一次允许路径；最多 8 条，保留 exact-oneOf 多分支同时匹配的错误。
- **回归证据：** 四份 r12 JSON 逐字复制为 `tests/fixtures/planning-compiler/t23-r12-*.json`，测试固定 SHA-256，原件存在时另核对副本与原件摘要。真实编译器产生与记录一致的首轮 3 条审核问题；同一 Host 门禁及真实 SDK 原生终结工具回放中，原 r12 修复进入编译器，返回 **4 条 `REVIEW_BEFORE_EFFECT`**（仍为可修复，revision=2、剩余 1 次），没有 `COMPILER_TOOL_SCHEMA_INVALID`，没有接受或保存候选。工具目录仅在离线测试中重建所用 native 工具标识及开放参数槽，不代表完整 Desktop 环境复现。
- **性质测试：** compact-repair／template-fill 的 CREATE、EDIT 各生成多组对象根替换和新增子路径补丁；只要编译器接受，声明的 nextSchema 也接受，并确认调用 submit 而非 rejectWire。另覆盖草稿形状变化、真实类型合同、原 r12 拒绝包定向诊断及越界编译器拒绝。
- **请求摘要边界：** 旧 T10／T21 摘要夹具与冻结清单保持原字节。首轮与查目录请求摘要不变；修复轮因合同放宽而改变，在测试中单独固定 T23.15 的新摘要，不覆盖历史摘要。
- **检查结果：** 最终定向 `npx vitest run` 为 9 文件、237 项全部通过；`npm run typecheck`、`npm run build` 通过；四份 r12 副本与本地原件逐字及 SHA-256 一致，`git diff --check` 通过。
- **验证边界：** 本轮只有离线检查，无真实模型调用、安装、提交或推送；T23.15 的 Desktop 真实复验仍待单独执行。
- 复核（2026-10-23）：沙箱外全量 `npm test`（254 文件／3379 项）与 typecheck 全部通过。

## 19、r13 Desktop 实测（2026-10-23）

安装 `artifacts/v0.0.2-audit-20261023-r13`（4e7ea49，SHA-256 `50cab51e…`），GLM-5.3-Flash、Max，各开新对话。会话副本在 `.test-data/t23/r13/`。两次气泡都只显示原话。

| 需求 | r8 | r10 | r11 | r12 | r13 |
| --- | --- | --- | --- | --- | --- |
| T20 发送→结束 | 7:09 | 4:56 | 3:05 | 失败（总时长保护） | 5:54 |
| 成绩分级 发送→结束 | 3:08 | 2:48 | 被 Schema 拦截 | 3:25 | 5:45 |

- **T20 走模块路线：** 主 Agent 第 1 步想了 212 秒（推理约 3.4 万字），之后查模块目录、目标文件和工作流清单；第 2 步 80 秒提交 `reviewed-file-write` 模块请求，Host 当即实例化（规划子 Agent 0 次）；第 4 步 52 秒汇报。r12 同一需求走的是设计路线（更正：r11 走的是模块路线，见 §26）。路线选择和第 1 步思考时长在运行间波动很大（r11 64 秒、r12 127 秒、r13 212 秒）。
- **T23.15 修复路径未在 Desktop 触发：** T20 走模块路线，成绩分级一次通过，两次都没有修复轮。离线回放仍是 T23.15 的唯一证据。
- **成绩分级变慢的三个来源：** ① 主 Agent 第 1 步（86 秒）提交的请求漏了 `execution`，Host 返回 `EXECUTION_SPEC_REQUIRED`；第 2 步又想 80 秒才补上 `design-only`。② 第一次等待调用传了空字符串 `event_cursor`，Host 报 `Unexpected end of JSON input`，多一步约 8 秒。③ 最终汇报 85 秒（首字 47 秒）。规划子 Agent 本身 92 秒、一次接受，和 r12 的 90 秒相当。
- **结论：** 合同修复（T23.14／T23.15）没有再造成失败；剩下的时间主要是主 Agent 的思考时长波动和两处可避免的往返。
- **待办（未开始）：** `EXECUTION_SPEC_REQUIRED` 错误改为附带按用户原话可选的请求骨架，让主 Agent 一次补齐；空字符串 `event_cursor` 按未传处理；主 Agent 第 1 步思考时长波动需多次采样才能判断，不凭单次下结论。

## 20、T23.16 实施

- **先给信息再想：** r13 的两次额外往返来自缺少可填写的执行合同和空 cursor 解码错误。错误必须携带完成下一步所需的信息，让主 Agent 只补缺失字段，不必重新推导合同；本次不调整模型、思考强度、提交预算或路由规则。
- **缺 execution 的紧凑反馈：** 新建请求仍抛出 `EXECUTION_SPEC_REQUIRED`（工具现有返回是文本，没有专用结构化错误通道）。短中文说明后附紧凑 JSON，回显本请求的 `requestId`、`operation` 和已提供的 `title`，附 `executionOptions.designOnly`／`executeFirst` 两个可复制的 `{execution:…}` 片段；保留原请求的其他字段，只补 `execution`，不重复整段需求。execute-first 骨架包含实际必填的 `task`、`tools`、`artifacts` 及其 `path`、`format`、`checks` 示例；按真实任务填写，必要信息缺失时原生询问。
- **骨架单一来源：** 错误直接调用 `src/host/planning/command-brief.ts` 的 `planningCreateRequestSkeletons()`，与命令简报的 `createRequestSkeletons` 来自同一函数，只投影两种 execution 片段；没有第二份手写字段合同。测试逐项比较反馈与真实命令简报，并把两个片段补回原请求交同一入口校验。
- **不替用户选择模式：** Host 不从需求文字推断 design-only；即使 r13 请求原文已写“只设计”，遗漏显式 `execution` 仍须补齐。仅用户明确说“只设计／不要执行／先不要执行”时使用 design-only；试做失败不得自动切换。只读／计划模式的原有预览边界不变。
- **cursor 行为与声明一致：** 省略、空字符串、纯空白 `event_cursor` 均返回当前视图中的全部事件并生成新 cursor；有效 cursor 仍只返回未见事件，静默等待也更新 cursor。其他畸形值在长度、base64url、JSON、Schema 校验后统一返回中文“规划事件游标无效”，提示不带 `event_cursor` 重新调用或使用最近一次返回的 cursor，不暴露原始 JSON／Zod 异常。原有任务、主会话和工作区绑定检查保留。`visible_workflow_plan_wait` 的参数描述同步说明缺省语义与错误恢复方式。
- **r13 原始请求回归：** 从 `.test-data/t23/r13/session-e69c3ba4-167b-4b70-989a-d5eaea2c7cc2.jsonl` 的首个 `visible_workflow_plan` 调用（seq=20）提取未经重排或格式化的 `data.arguments` 字符串，逐字节保存为 `tests/fixtures/planning-compiler/t23-r13-initial-args.json`（1,319 字节，SHA-256 `eb28c3dcef33cad9ab048c16f43664965926792306b8468ff7bb531b6b585842`）。测试固定摘要，原会话副本存在时另核对原参数字节；不改写会话原件。覆盖反馈身份／标题、必填字段、短消息、空白 cursor 等价、畸形值中文恢复提示及真实 Host 工具参数声明与执行路径。
- **验证边界：** T23.16 离线已完成，Desktop 验证待做；本轮无真实模型调用、安装、提交或推送，不把离线通过等同于 Desktop 耗时改善。
- 复核（2026-10-23）：沙箱外全量 `npm test`（255 文件／3394 项）与 typecheck 全部通过。

## 21、r14 Desktop 实测（2026-10-23）

安装 `artifacts/v0.0.2-audit-20261023-r14`（4e0365e，SHA-256 `e37600d9…`），会话副本在 `.test-data/t23/r14/`。气泡均只显示原话。

- **T20 成功，3:29**（r13 5:54）：模块路线，主 Agent 第 1 步 94 秒（r13 212 秒）；首个请求漏 `execution`，看到 T23.16 的骨架反馈后 12 秒补齐（r13 同类往返 80 秒）。新图 `837233c9…`，已有图均未改。
- **成绩分级失败（模型服务）：** 主 Agent 漏 `execution`，16 秒补齐；规划子 Agent 首交 92 秒内漏 `title`，Host 返回可修复反馈（T23.14 行为正确，剩余 2 次）；修复步思考约 68 秒时模型服务连接被终止（`PLANNING_PROVIDER_ERROR`／`TRANSPORT: terminated`），SDK 已显示"已重试模型请求（2/5）"仍失败，任务终止。主 Agent 以原生问题询问是否重试，未作答。
- **结论：** T23.16 的两处往返收敛在两次请求中都生效；本轮失败来自模型服务，不是插件合同。成绩分级需补一次样本。
- **观察（未开始）：** 规划子 Agent 在成绩分级两次（r11、r14）漏 `title`，每次多一轮修复；命令简报把 `title` 列为"可省略"，而子 Agent 的提交 Schema 要求必填，两处说法应统一。


## 22、T23.17 实施

- **问题与两处不一致：** r11、r14 的成绩分级首交都漏了工作流级 `title`，各增加一次完整修复轮；r14 的额外修复在约 68 秒思考后遇到模型连接终止。命令简报却将请求 `title` 写成“工作流名称（可省略）”；规划器说明只列节点级 `title?`，工作流级必填仅存在于 Schema。T23.14 的拒绝行为正确，缺的是思考前提供的一致合同。
- **主 Agent 合同：** 简报与 `visible-workflows:guide` 统一要求：用户已给出的工作流名称必须原样作为 `request.title` 传入，仅用户没有命名时省略。模块正文的 `parameters.title` 仍只控制正文标题。
- **传递链路：** `entry.ts`／`planning-schema.ts` 已保留请求名称；execute-first 的 trial-service 也已传入后续创建请求。此前通用创作路径在 service 创建编译器时未传名称，创作上下文也没有该字段。现在 service 将 CREATE 的 `request.title` 显式作为 `AuthoringOptions.requestedTitle` 传给共享核心；核心生成 `{type:"string",const:请求名称}`，模板编译器沿用该合同。agent 的原生终结工具及每轮实际广告 Schema 都读取编译器 Schema，因此规划器在首轮即看到准确名称。没有请求名称时，工作流级 `title` 仍为必填自由字符串。
- **Host 同一合同：** 核心直接编译和局部修复使用与广告 Schema 相同的 title 字段合同及 SDK 校验辅助函数；漏填或异名返回可修复的 `COMPILER_TOOL_SCHEMA_INVALID`，指向 `title`／`/title`。不覆盖模型提交的名称，不从 description、summary、基线或需求文字补猜。标题与其他形状／保留字错误合并反馈，保留各自修复路径，避免标题预检遮蔽同轮应修字段。外层 wire 拒绝仍不生成草稿，直接编译失败仍保留原草稿供 repair。EDIT 不绑定请求名称；字段值专用 EDIT、优化和模块既有语义保持不变。
- **短说明先行：** template-fill 与 compact-repair／authoring core 的 CREATE 说明统一增加一句：“CREATE 工作流级 title 必填；请求给出名称时必须同名，节点级 title 可选。” 仅 CREATE 添加，避免改变 EDIT 请求字节。
- **离线回归：** 覆盖简报／guide 文案、入口→service→规划器 const Schema→Host 检查，SDK Schema 结构断言与参数验证、漏填／异名／同名、无请求名称的必填自由字符串、直接编译及 repair、EDIT 不变，以及真实 SDK 原生终结工具接受同名提交。r11 原夹具不变；r14 首交参数从 `.test-data/t23/r14/731943eb-e535-4030-8ee9-72035f7eae97.jsonl` 的 seq=15 逐字复制为新增夹具（2,779 字节，SHA-256 `0d6e6c606de44da3fdaa08e9a5e78057d8d4ad3d5c60eac23e6a67b3e40fb978`），两个漏 title 首交仍给可修复反馈，显式补同名后接受。
- **请求摘要：** T10／T21 历史夹具、冻结清单和 `t09-config.json` 保持原字节。CREATE 的新增说明和标题诊断改变首轮、查目录及修复请求字节，在 `t10-authoring-feedback.test.ts` 明确固定 T23.17 新摘要；EDIT 仍核对原首轮／查目录及 T23.15 修复摘要。
- **检查结果：** 首轮两组定向回归共 18 文件、437 项通过。全量 `npx vitest run` 为 255 文件、3,402 项通过／4 项失败：`graphon-capability-audit`、`planning-notification-reconnect`、`tool-adapters` 三项因 `listen EPERM 127.0.0.1` 受沙箱限制；`planning-audit-regressions` 暴露标题预检遮蔽其他错误，已修复并与相关提交／服务／原生 SDK／摘要回归复验（5 文件、196 项通过）。修复后两组定向复验共 19 文件、454 项全部通过，`npm run typecheck`、`npm run build`、`git diff --check` 通过；全量未重跑，三项端口测试留待沙箱外执行，未绕过权限。原始证据、历史摘要夹具、冻结清单、`tests/probes` 与 `~/.dsh` 未修改。
- **原则与边界：** 必填字段要在说明里说出来，用户给出的名称是授权不是猜测。T23.17 只有离线实现与验证，Desktop 验证待做；没有真实模型调用、安装、提交或推送，不降低思考强度，不据离线结果声称实际耗时改善。
- 复核（2026-10-23）：沙箱外全量 `npm test`（255 文件／3406 项）与 typecheck 全部通过。

## 23、r15 Desktop 实测（2026-10-23）

安装 `artifacts/v0.0.2-audit-20261023-r15`（80f7b88，SHA-256 `0a387fe4…`），会话副本在 `.test-data/t23/r15/`。两次都成功，气泡只显示原话，已有图均未改。

| 需求 | r8 | r10 | r11 | r12 | r13 | r14 | r15 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T20 | 7:09 | 4:56 | 3:05 | 失败 | 5:54 | 3:29 | 4:29 |
| 成绩分级 | 3:08 | 2:48 | 被拦 | 3:25 | 5:45 | 模型服务中断 | 4:32 |

- **T23.17 生效：** 成绩分级主 Agent 首个请求就带 `title` 和 `execution`；规划子 Agent 77 秒首交即接受，没有修复轮。
- **T20（模块路线）：** 主 Agent 第 1 步 80 秒，第 2 步 104 秒；首个请求的 `instanceKey` 超过 24 字符被入口拒绝（原始 Zod 报错），24 秒后缩短重交；Host 直接实例化，汇报 51 秒。
- **成绩分级剩余耗时：** 主 Agent 第 1 步 94 秒，并调用 `visible_workflow_list`（55 KB）核对重名，而简报里已有工作流清单；保存后又用 `visible_workflow_nodes` 读回节点核对（约 56 秒）再汇报。
- **待办候选（未开始）：** ① 简报的模块骨架和参数示例写明 `instanceKey` 长度与格式，入口错误改为可读的一句话；② 简报已含工作流清单时，说明无需再调 `visible_workflow_list` 核对重名；③ 回执已含结构检查与变更范围时，保存后不必读回节点。三项都是"信息先给到"，不降低思考强度。主 Agent 第 1 步 80–212 秒的波动仍需多次采样。


## 24、T23.18 实施

- **§23 的三个可避免往返：** r15 T20 首个模块请求的 `t20-review-file-write-r15` 为 25 字符，超过 instanceKey 上限，原始 Zod JSON 报错后多一次重交；成绩分级在已有命令索引时仍读取约 55 KB 的工作流清单，保存后又读取节点约 56 秒。这些是应在思考前明确提供的合同和验证事实，不以降低 reasoning effort 解决。
- **模块身份合同前置：** 导出 instanceKey 长度常量、由该常量生成的原有正则和中文说明；命令请求骨架旁及模块 `parameterExample` 旁引用同一说明：英文字母开头，只含英文字母、数字、下划线和连字符，1–24 字符。说明置于骨架外，不把说明字段混入严格请求。入口仍由原 Zod Schema 拒绝畸形值，每个问题输出带完整字段路径的中文规则句；联合结构仅在分支明确匹配时定向展示，不推断或修正输入，不改变 Host 门禁。r15 原始请求在本地副本存在时直接只读回放，固定 25 字符案例另有独立回归。
- **索引范围已核实：** 普通命令、早交接 brief 和 `visible_workflow_list` 都调用 `storage.visibleWorkflows(workspaceId)`，包含命令时刻当前工作区及 global 的未归档工作流，不包含其他工作区私有图。brief 仅投影 `id/title/revision/nodeCount`，可按名称／ID 查找，新建不覆盖同名图，无需再次 list 核对重名。global 已包含，不能将“需要 global”写成必然重查理由；需要刷新索引或完整图内容时再按需查询。真实 Host 回归对比命令简报与 list 的投影，并覆盖 global、私有、归档和同名图。
- **发布事实足够汇报：** 模块与设计 `receipt.verification` 增加 `graph`，包含本次回执的 workflowId、revision、保存／提案状态、候选 digest、节点总数及每节点 `title/kind`（含容器内部节点）。这些来自现成候选和匹配发布回执，不再读存储、不返回配置正文、不改变持久化 receipt 的合同。仅 published 且回执身份／digest 匹配时投影；设计继续要求匹配的已记录检查，模块继续要求固定实现来源匹配，旧记录缺证据时不补造。created 的 revision 是本次保存版本，proposed 的 revision 是提案基线版本，候选摘要不表示修改已保存，也不表示之后的实时状态。
- **简报与 guide 同源：** 共用简短索引说明和回执汇报说明。可以依据保存身份、节点摘要、`checksPassed` 和 `workspaceChanges` 汇报，无需再读节点；用户要求节点细节才用 `visible_workflow_nodes`，要求完整图才读完整候选。保留覆盖声明／假设／未决项和模块固定行为说明；“已有图未修改”仍须以已有的工作区版本比较为依据，缺失时不作断言。比较范围准确注明当前工作区及 global（含归档），其他图的并发变化不归因于本任务。
- **请求摘要与定向检查：** 9 文件／131 项定向回归通过，包含两种编译模式的真实 Host 入口、r15 原请求、发布／恢复证据、工作区索引及 T10 请求摘要。CREATE／EDIT 请求摘要均沿用既有固定值，无需新增 digest；历史夹具保持原字节。`npm run typecheck`、`npm run build` 和 `git diff --check` 通过。
- **全量尝试：** `npx vitest run` 共 255 文件／3,421 项：252 文件／3,418 项通过，3 项因 `listen EPERM 127.0.0.1` 受沙箱限制，分别为 `graphon-capability-audit.test.ts` 的 20 种节点集成检查、`planning-notification-reconnect.test.ts` 的真实 socket 重连检查、`tool-adapters.test.ts` 的 HTTP 响应与凭据重定向检查。无其他失败，未提权或绕过；这三项留待用户在沙箱外验证。
- **原则与边界：** 延续 §9“先给信息再想”：前置信息经过 Host 验证与提炼，Host 校验始终权威。本轮不改模型、reasoning effort、修复次数或发布授权，不改历史请求摘要夹具、冻结 manifests、`t09-config.json`、`docs/evidence` 原件、`tests/probes` 或 `~/.dsh`。仅离线实施，Desktop 验证待做，不以离线通过宣称真实耗时改善。
- 复核（2026-10-23）：沙箱外全量 `npm test`（255 文件／3421 项）与 typecheck 全部通过。回执节点摘要按全部节点列出，超大图时需再评估是否截断。

## 25、r16 Desktop 实测（2026-10-23）

安装 `artifacts/v0.0.2-audit-20261023-r16`（505cacc，SHA-256 `7be6e70c…`），会话副本在 `.test-data/t23/r16/`。

| 需求 | r10 | r11 | r12 | r13 | r14 | r15 | r16 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T20 | 4:56 | 3:05 | 失败 | 5:54 | 3:29 | 4:29 | 失败（29:55 后提问） |
| 成绩分级 | 2:48 | 被拦 | 3:25 | 5:45 | 服务中断 | 4:32 | **2:51** |

- **成绩分级 2:51（本系列最快之一）：** 主 Agent 第 1 步 69 秒后首个请求即带 `title` 和 `execution`，没有调用 `visible_workflow_list`；规划子 Agent 首交接受；保存后没有读回节点，29 秒据回执汇报。T23.16–T23.18 都生效。
- **T20 走了设计路线并失败：** 主 Agent 第 1 步 75 秒，推理约 1.1 万字里一次也没有提到模块，直接发设计请求（简报和模块目录都在系统提示里）。规划子 Agent 两次都卡在 `REVIEW_BEFORE_EFFECT` 结构诊断，修复轮用满（`PLANNING_REPAIR_LIMIT`）；主 Agent 第二次把诊断写进指令重试仍失败，最后以原生问题询问是否第三次尝试，未作答。没有保存任何图。
- **路线选择不稳定是 T20 的主因：** 同一请求 r12／r16 走设计路线（均失败），r8、r10、r11、r13、r14、r15 走模块路线（全部成功，0 规划子 Agent；更正见 §26）。现在简报里的路线规则只写"见 visible-workflows:guide"，模块适用条件放在目录里，主 Agent 不一定先对照。
- **候选（未开始）：** 简报顶部直接给出路线规则：先逐项对照 `modules[].applicability`，符合则用模块骨架，只有没有模块覆盖时才走设计路线；不靠 Host 猜测语义，Host 仍按原合同校验。设计路线对审核写文件这类需求的修复失败属于 T25（骨架先交）范围。

## 26、r8–r16 全面复盘（2026-10-23）

数据来源：`.test-data/t23/` 下全部主对话与规划子 Agent 会话副本，逐条由会话日志计算（不依赖界面报告）。同一配置每个需求只测 1 次，下面的时长差异只有在幅度很大时才可下结论。

### 26.1 逐轮结果

| 轮次 | 变更 | T20 路线 | T20 结果 | 成绩分级结果 |
| --- | --- | --- | --- | --- |
| r8 基线 | T22 模块 | 模块 | 7:09 | 3:08（两次入口报错往返） |
| r9 | 早交接 v1 | 早交接 | 13:22 失败 | 5:59 |
| r10 | 简报＋骨架＋设计回执 | 模块 | 4:56 | 2:48 |
| r11 | 隐藏简报＋参数示例＋变更范围 | 模块 | 3:05 | 被 Schema 拦（漏 title） |
| r12 | T23.14 合同统一 | 设计 | 失败（修复轮被封闭 Schema 拦、超时） | 3:25 |
| r13 | T23.15 修复合同放宽 | 模块 | 5:54（第 1 步 213 秒） | 5:45（漏 execution 80 秒、空游标） |
| r14 | T23.16 往返收敛 | 模块 | 3:29 | 模型服务中断 |
| r15 | T23.17 title 合同 | 模块 | 4:29（instanceKey 往返） | 4:32（多余 list、读回节点） |
| r16 | T23.18 预给信息 | 设计 | 失败（两次修复轮用满） | **2:51** |

### 26.2 时间花在哪里

- **主 Agent 第 1 步是最大的固定成本：** 50–213 秒，同一请求波动 3 倍以上（T20：64、113、127、184、213、93、80、75 秒）。这是 Max 思考强度下的理解和路线决策，不能靠降强度压缩，只能靠"先给信息"减少需要推导的内容。
- **规划子 Agent：** 成绩分级首交即接受时稳定在 70–92 秒；T20 走设计路线时单步 300–370 秒、需要多轮修复，且 3 次中 2 次失败（r9A 的早交接版本也失败）。
- **可避免的往返（已修）：** 漏 `execution`（80 秒→12–16 秒，T23.16）、空游标（T23.16）、漏 `title`（整轮修复，T23.17）、`instanceKey` 超长（T23.18）、多余 `visible_workflow_list` 与保存后读回节点（T23.18）。r16 成绩分级 2:51 说明这些修复叠加有效。
- **汇报步：** 29–117 秒，回执信息越完整越短（r16 29 秒）。
- **等待轮询：** 设计路线长任务里主 Agent 每 55 秒醒来一次，单次约 8–10 秒、约 1 千新输入 token；不增加墙钟时间（任务结束时等待会立即返回），只增加 token。

### 26.3 失败分类

| 类别 | 出现 | 根因 | 状态 |
| --- | --- | --- | --- |
| 交接设计错误 | r9 | 理解成本搬到子 Agent、共享提交上限 | 早交接默认关闭 |
| 合同不一致 | r11、r12 | Host 检查与对外 Schema 两套标准；修复轮 Schema 比合同严 | T23.14／T23.15 已修 |
| 说明与 Schema 不一致 | r11、r14 | 简报说 title 可省略、子 Agent 说明没写必填 | T23.17 已修 |
| 模型服务 | r14 | `TRANSPORT: terminated`，SDK 已重试 | 外部因素，不改插件 |
| **路线选择** | r12、r16 | T20 完全符合 `reviewed-file-write` 模块，主 Agent 却走设计路线；r16 第 1 步推理 1.1 万字未提及模块 | **未修** |
| 设计路线难以收敛 | r12、r16 | 设计路线要手工重建模块已固化的审核结构（初始变量、拒绝双存、只从通过出口写目标），修复 3 次用满 | T25 范围 |
| 失败后的重试方向 | r16 | 设计路线失败后，主 Agent 把诊断写进指令再走设计路线，又耗 14 分钟；失败信息里没有提示"这正是某模块固化的结构" | **未修** |

### 26.4 原则补充

- **路线决策必须显式：** 规则写在别处（guide）而决策在第 1 步的长推理里做，模型可能根本不触发这条规则。把"先对照模块适用条件"变成请求里必须填写的字段，Host 只核对是否逐个对照了目录中的全部模块，不判断语义。
- **失败信息要指向更短的路：** 诊断如果对应某个模块已固化的结构，就在失败结果里说明，让下一次重试改走模块路线，而不是带着诊断重走设计路线。
- **单次样本不下结论：** 路线选择是随机的。验证路线修复时，T20 至少连续测 3 次。

## 27、T23.19 方案：路线决策显式化与失败指路

1. **简报顶部给路线规则：** 一句话放在简报最前面——新建先逐个对照 `modules[].applicability`；符合则用模块骨架（Host 实例化，0 规划调用）；只有没有模块适用时才走设计路线。
2. **设计路线的请求必须带 `moduleCheck`：** 无 `handoff` 的新建请求（design-only 与 execute-first）填写 `moduleCheck:{checked:[目录中全部 id@version], notApplicable:"为什么都不适用"}`。Host 只核对 `checked` 与当前模块目录完全一致，不判断理由；缺失或不一致时用一句中文拒绝，并附模块目录的适用条件和模块骨架（先给信息）。只作用于主 Agent 的入口，Host 内部发起的规划（如试做后设计）不受影响。
3. **设计失败时指向模块：** 设计任务失败（含修复次数用满）且剩余诊断属于某模块已固化的结构（例如文件写入节点上的 `REVIEW_BEFORE_EFFECT` 对应 `reviewed-file-write@1.0.0`）时，失败视图附 `moduleHint`（模块、对应理由、参数示例、模块骨架）。映射由模块目录声明，Host 不猜语义；是否改走模块由主 Agent 按规则决定，不自动切换。
4. **验证：** 离线测试覆盖三项；r17 在 Desktop 连续跑 T20 三次、成绩分级一次，看路线是否稳定走模块、成绩分级是否保持。

不做的事：不降低思考强度；不让 Host 按文本相似度替主 Agent 选路线；设计路线本身的收敛问题留给 T25。


## 28、T23.19 实施

### 28.1 路线规则与入口检查

- `buildPlanningCommandBrief` 将共享的 `PLANNING_ROUTE_GUIDANCE` 放在首字段 `routeRule`，guide 以同一常量开头：先逐个检查 `modules[].applicability`，有适用模块即使用模块骨架（Host 实例化，0 次规划调用），全部不适用才设计。两种设计骨架的 `moduleCheck.checked` 均由当前目录派生。
- `parsePlanningEntry` 对 `operation=create`、无 `handoff`、无 `source` 且业务模块目录非空的请求检查 `moduleCheck`，包括 design-only、execute-first 和只读预览。`checked` 必须与目录全部 `id@version` 集合完全相等，不多、不少、不重复；`notApplicable` 去除首尾空白后为 1–400 字符。Host 不评判理由语义。
- 拒绝先给可读中文，再给紧凑目录（模块身份与 applicability）、复用的模块请求骨架、共享 instanceKey 规则及 moduleCheck 填写形状。执行模式与 moduleCheck 同时缺失时，一次反馈同时说明两项；只有 execution 缺失时保留 T23.16 的恢复信息。T23.18 的字段路径／中文错误保持原检查。
- module、partial、edit、普通 revise 与证据驱动优化无需此字段。共享的内部请求 schema 只将 moduleCheck 作为可选审计字段，不执行当前目录集合检查，历史请求和已保存摘要保持原样。

### 28.2 审计与调用边界

- 普通任务保存在 `task.request.moduleCheck`；execute-first 保存在 trial 请求并带入后续规划请求；命令 intake 的直接设计保存在 `task.commandIntake.moduleCheck`。审计字段不加入普通设计、试做或提炼子 Agent 的提示。
- 已追溯两处外部入口：`index.ts` 的命令 `commandRequest` 与普通 `planningEntry` 都调用 `parsePlanningEntry`。显式早交接的 `mode:design` 信封新增 moduleCheck，并在交给创作编译器前调用同一入口；不为旧测试绕过闸门。
- 内部路径仍直接调用 `WorkflowPlanningService.start`：trial-service 的 `this.options.plan` 经 Host 回调进入服务；from-conversation 的已完成任务提炼直接进入服务；命令受理初始任务也直接进入服务。内部请求无需人为补齐新主 Agent 决策。

### 28.3 失败到模块提示

- `businessModuleCatalog` 声明 `diagnosticCoverage`：`reviewed-file-write@1.0.0` 覆盖 `code=REVIEW_BEFORE_EFFECT`、节点类型 `tool`、工具 ID `native:write`。未声明覆盖的模块不产生提示；T20/T22 固定实现及版本摘要未变。
- 新增 `planningModuleHint`，仅对失败的设计任务投影视图，不修改任务、候选或路线。优先使用最后一次 author 草稿的诊断及节点：compact 根据 `/nodesByKey/...` 的 kind/toolId；template-fill 根据 `/formsByKey/...` 的确定性工具模板身份。无编译草稿时，根据最后输出的 Host 图投影或候选与诊断 nodeId 匹配。不是文字相似度匹配，也不扫描之前已修好的轮次。
- 修复次数用满和 deadline 仍保留最后诊断，因此同样可以获得 `{module,reason,applicability,parameterExample,skeleton}`。`planningView` 统一提供给 `visible_workflow_plan_get` 与 `visible_workflow_plan_wait`，含链接任务的终态视图。无关失败、未失败任务、直接 module/edit/chain 失败和非 author 阶段均不提示。
- guide 明确：失败带 moduleHint 时，主 Agent 仍须核对 applicability；符合则改用模块路线，不重复设计。Host 不自动切换，也不替用户批准新业务动作。

### 28.4 离线验证与证据

- 新增入口集合、错误／部分／多余／重复 ID、空理由／超长理由、目录为空、只读／执行优先及组合缺失测试；模块、修改、partial 和内部请求保持兼容。现有新建入口 fixture 明确补充 moduleCheck，不改变历史 JSON 证据。
- r16 来源为 `.test-data/t23/r16/6a36294c-d67e-4d49-969f-557d170947e4.jsonl`。从 seq 27／33／39 的 `data.arguments` 和 seq 34 的工具反馈文本逐字节复制至 `tests/fixtures/planning-compiler/t23-r16-*.json`；seq 40 只有“最后诊断已保存”的错误文字，末次诊断由三次原始提交经过当前真实编译器离线重放取得。
- SHA-256 固定如下（存在本地原始会话时另做字节一致比较）：
  - initial-args：`ead8947093cb088819bc1c1b76e79583e3bb38dbb1af9dab5bf6d8a56da979a3`
  - repair-args：`9629ebc95fb224c7c571e3be359e3d92ffaa608fecb00c431d942c7af75b7b0d`
  - feedback：`3ad18900f49b3f8d8211a1d352d61b11be072d7b25464a6e0258154135fdbb00`
  - last-repair-args：`999dedb1ad6815819f2199a3479bbf6a334c32c54feb2e0c238a1b45b30f1a76`
- 真实 Host 注册工具配合确定性驱动替身覆盖 get／wait 的修复上限、deadline 和无关失败；另验证请求审计可恢复、不进入普通 planner 提示，内部 trial 仍完成既有调用链。定向回归同时覆盖模块固定摘要、审核语义和 T23.17 请求摘要；没有修改原摘要 fixture。
- 验证命令：定向 `npx vitest run`、`npm run typecheck`、`npm run build`、`git diff --check`，并尝试完整 `npx vitest run`；实际结果及可能的沙箱缺口列于本次交付报告。未进行真实模型调用或 Desktop 验收。

### 28.5 与 §27 的实施差异及后续

- 简报保持原有 JSON 形状，将路线句放在首字段值，而非在 JSON 前插入非 JSON 文本；原因是命令受理、returned 回退和存储恢复都直接解析该 JSON。阅读顺序仍先见路线规则。
- 补充了命令 intake 的 `mode:design` 外层字段与 trial 的审计传播；这是落实共用入口且不丢失决策记录所需的接线，不改变执行模式、修复次数或思考强度。
- 失败提示也允许已有设计／partial 或试做后 author 阶段的确定性诊断匹配，但只给建议，是否适用仍由主 Agent 判断；非设计直达路线不提示。
- **状态：离线完成，Desktop r17 待办（T20 ×3）。** 按 §27 另跑成绩分级一次，验证路线稳定性及既有成绩分级时长；离线成功不代表三次真实路线选择已经验收。
- 复核（2026-10-23）：沙箱外全量 `npm test`（256 文件／3441 项）与 typecheck 全部通过。骨架里 `notApplicable` 的占位文字若被原样照抄也会通过——Host 按设计只核对集合，不判断理由。

## 29、r17 Desktop 实测（2026-10-23）

安装 r17（T23.19，归档 sha `2da4b8f5…0382`）后，在验收工作区新建对话，连续跑 T20 三次、成绩分级一次。模型均为 GLM-5.3-Flash／Max，思考强度未调整。会话副本在 `.test-data/t23/r17/`（不提交）。

| 运行 | 总时长 | 路线 | 主 Agent 各步（秒） | 结果 |
| --- | --- | --- | --- | --- |
| r17a T20 | 4:35（275 s） | 模块，0 次规划调用 | 122／99／7／46 | 成功，新图已保存 |
| r17b T20 | 4:08（248 s） | 模块，0 次规划调用 | 141／54／11／41 | 成功，22 节点 |
| r17c T20 | 6:29（389 s） | 模块，0 次规划调用 | 148／72／7／45／15／51／15／36 | 成功，22 节点；发布后额外核验 145 s |
| 成绩分级 | 2:32（152 s） | 设计（moduleCheck 两模块均判不适用） | 36／25／6／29 | 成功，4 节点，历来最快 |

### 29.1 结论

- **路线稳定：** T20 三次都先调 `visible_workflow_modules`，再用模块骨架提交，Host 直接实例化 `reviewed-file-write@1.0.0`，没有一次走设计路线。r12、r16 那种设计路线 + `PLANNING_REPAIR_LIMIT` 的失败没有再出现。成绩分级按 moduleCheck 逐个排除两个模块后走设计路线，理由正确。
- **入口与回执：** 四次都没有入口拒绝、title 缺失、instanceKey 超长或空 cursor 的往返。T23.14–T23.19 的修复都已生效。
- **与基线比：** T20 三次的中位数 275 s，r8 是 429 s（约 −36%）；成绩分级 152 s，r8 是 188 s。

### 29.2 剩余耗时

1. **主 Agent 第 1 步 122–148 s，约 25k 字推理。** 推理大多在调用模块目录之前推测模块语义，例如首轮初稿与 reviewBase／reviewNote 怎样拼、探测和草稿写入由谁负责。这些答案就在目录的 `parameters.description` 和 `fixedBehaviours` 里；简报其实已含 `parameters`、`parameterExample`、`fixedBehaviours`，问题是第 1 步不可见，第 2 步才进入系统提示。成绩分级第 1 步只有 36 s，说明这是 T20 专有的"信息未前置"成本，与路线判断本身无关。
2. **第 2 步 54–99 s。** 读完目录后对照需求逐条构造参数，推理 7k–19k 字。
3. **r17c 发布后核验 145 s。** 需求要求表单"注明文件编辑不用于提交"。固定实现节点的 config 不对外暴露，回执里也没有这句文案，主 Agent 便重读节点三次，又对 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 做了两次 grep（第一次 exit 2 报错），最终仍未逐字确认。根因：模块固定行为的可核验事实没有进回执，主 Agent 只能自己找。

### 29.3 后续候选（未实施，待定）

- **T23.20a 模块契约前置：** 简报给出每个模块的参数说明和 `fixedBehaviours`（含审核表单固定文案）。目标是第 1 步直接提交模块请求，把第 1、2 步合并，并省去目录调用。
- **T23.20b 模块回执带固定行为事实：** created 回执对模块实例给出固定实现覆盖的需求点和关键文案，主 Agent 凭回执汇报，不需要也不应翻查应用安装包。
- 两项都属于"先给信息再想"，不降低思考强度。T24（扩充模块库）、T25（骨架先交）照旧排在 T23 之后。

**状态：** T23.19 Desktop 验收通过，T20 三次稳定走模块路线，成绩分级保持。


## 30、T23.20 实施

### 30.1 首步不可见的根因与证据

- 本次核对 `.test-data/t23/r12` 至 `r17` 中有 `system/message` 的全部 14 份主会话：第 1 步均无 Host 命令简报，第 2 步才出现。没有系统提示记录的空会话不计入样本。r12–r16 尚无 `routeRule` 字段，故跨版本核对使用简报的 `source` 标识，不能只查 `routeRule`。
- r17 代表证据：`.test-data/t23/r17/session-b780f1ea-bab8-453a-bd3d-2c8b3f45153e.jsonl`，任务所引第 10 行 step1 无 `routeRule`、第 27 行 step2 才有。这里对应从 0 计数的行索引；本地副本按通常从 1 计数为第 11／28 行，事件 seq 分别为 9／26。原始证据未改动。
- `bindCommandBrief` 原来在 `agent/pre-step` 的 `await next()` 后才注册 system section，此时首步 assembly 已生成，因此注册只能影响后续步骤。原测试先 pre-step、再 assemble，未覆盖真实时序。
- 首先新增首步回归：真实 `SystemPrompt` 先 assemble，再受理消息。原代码下测试失败，期望 `{"routeRule":"首步必须可见"}`，实际为空字符串；修复后通过。

### 30.2 SDK 依据与所选判定

依据本仓库安装的 `@deepseek-ai/*@0.2.1-rc.1`，路径均在 `node_modules/.pnpm/` 下相应包目录：

1. `dsh-plan-mode/lib/index.js:17–20` 明确选定状态先进入 proposed step assembly，再在接受后的 `agent/pre-step` 记录；同一步请求重试复用原 assembly。其 151–175 行使用常驻 section 和 `text(context)` 读取待定状态。
2. `dsh-system-prompt/lib/types/index.d.ts:37–58` 的基础 `AssembleContext` 只有可选 scope/signal，无待受理 messages、turn 或 step；`lib/index.js:356–398` 在 assemble 中执行 section provider 并生成文本快照。
3. `dsh-agent/lib/types/runtime-types.d.ts` 合并扩展 `AssembleContext.agent`；`dsh-agent/lib/index.js:291–297` 的 `assembleContextFor(agent, signal)` 同时给出 `agent`、`scope: agent`、本回合 signal。`runtime-types.d.ts:293–310` 定义 pre-step 的 messages 是该步从 inbox 取出的消息，turn 是所属回合，signal 是当前回合取消信号。command RPC signal 不代表回合寿命。
4. `runtime-types.d.ts` 的 AgentStatus/followup 合同规定：空闲无活动 driver，waking delivery 同步进入 running，followup 是各自独立的普通回合。`runMaintenance` 则可能保持公开 idle 且暂存后续输入，因此还必须检查 inbox 两个队列为空。
5. `dsh-session/lib/types/types.d.ts:257–280` 规定 turn/start 先于领取消息与 pre-step；拒绝、空输入、取消可形成无 step 的回合，最后 turn/end。`lib/index.js:1573–1592` 同步提交日志后通知观察者。`agent/inbox/claimed` 合同明确拒绝后不另发 discarded，因此不能仅依赖 discarded 清理。

实施选择：

- 在 followup 前同步注册 section，默认返回空文本。仅当此刻 `agent.status === 'idle'` 且 `inbox.nextTurn`、`inbox.nextStep` 都为空，才允许预挂紧接着的 turn/start；绑定至首次匹配本 agent、`scope === agent`、非 aborted 回合 signal 的组装。无 agent/scope/signal 的诊断组装不取得简报。
- `pre-step` 同时检查原消息 ID 在 payload 和最终 enter.messages 中；成功后将 turn/signal 冻结为 active。简报文本在命令时刻生成一次，各步复用，不重新读取目录。不同 agent、scope、turn、signal 不继承；command RPC 结束不影响已排队回合。
- reject、消息丢弃或替换、异常、abort、turn-stopping、turn/end、Agent dispose 和插件卸载均清除 section。若丢弃或卸载夹在首步组装与受理之间，已生成快照不能撤回，故仅保留一次受理守卫，拒绝该快照，并在受理／abort／回合边界释放；不让旧简报随替换消息进入模型。
- 简报仍是 `interpolate:false` 的 system section；用户气泡只保留原命令文本，模板引用不在 Host 简报中被插值。

**残余限制：** 组装上下文没有消息 ID，不能安全地把新命令简报预挂到正在运行的旧回合；现有安装也不含 agent-loop 的具体 driver，未以完整真实 Agent 驱动验收。因此忙碌 Agent、已有 parked inbox、连续排队的后续命令继续采用精确消息获准后激活：该命令首步仍无简报，第二步起可见。没有等待 whenIdle、改用 inject 或越过受理门禁。离线使用真实 `SystemPrompt` 和 `assembleContextFor`，driver 替身遵循上述顺序；首步实际注入及耗时收益须由 Desktop r18 核实。

### 30.3 模块固定事实与一致性

- `planning-business-modules.ts` 的 `reviewedFileFixedFacts()` 调用原 `reviewedFileGraph()`，直接提取 reviewGate 的完整提示、fields（含 name/label/type/defaultValue 等原字段）、actions，以及 draftWrite 的草稿路径／正文来源、commit 的提交正文来源。没有复制一份审核提示常量，也没有改固定配方。
- 目录 `fixedFacts.reviewPromptPattern` 逐字保留“文件只供查看，文件编辑不用于提交；修改须在表单正文中完成。拒绝时填写修改意见。”。`<parameters.target>` 是明确标注的目录占位符，替换为目标路径后就是实例提示；`{{sys.workflow_run_id}}` 和 `{{produce.text}}`／`{{reviewGate.content}}` 等引用保持原样，使用固定配方角色名。未声明的字段属性不凭空补默认值。
- 简报 `modules[].fixedFacts` 和模块回执 `fixedFacts` 共用模块目录投影。回执原有 published、候选摘要、实现摘要和 diagnostics 门禁全部保留；`structured-result-table` 不添加审核事实。
- `PLANNING_RECEIPT_GUIDANCE` 明确模块固定行为与文案以回执 fixedBehaviours/fixedFacts 为准，核验这些事实不要重读节点、不要检索应用安装目录或源码。回执仍不证明业务已执行或 Desktop 验收。
- 两个 implementationDigest 保持 `97ab7ab7732fc5cc1f22bce41bcce0b280401042345e18106513385bb9a53419` 与 `e44821bd615c8343e0729cbde3540d63be5eef7ebf9d29123a2cd0b1fc747751`。测试比较目录／简报／回执同一份事实，以两个目标路径逐字对照配方，再将真实编译实例引用还原成角色名核对字段、actions、草稿和写入配置；原摘要锁定测试继续通过。含 8 个工作流索引的简报仍满足原 8 KB 上限。

### 30.4 验证命令与交付边界

```sh
npx vitest run tests/planning-command.test.ts -t 'T23.20'
npx vitest run tests/planning-command.test.ts tests/planning-command-brief.test.ts tests/planning-reviewed-file-module.test.ts tests/planning-business-modules.test.ts tests/planning-review.test.ts tests/planning-module-routing.test.ts tests/planning-command-intake.test.ts tests/planning-command-intake-host.test.ts
npm run typecheck
npm run build
npx vitest run
git diff --check
```

测试覆盖空闲首步、后续冻结、回合结束、新 signal、scope 隔离、忙碌旧回合、两个排队命令、parked inbox、拒绝、替换、组装前后丢弃／abort、turn-stopping、dispose 和组装后插件卸载。旧 Host 夹具同步补齐真实组装的 agent/scope，不以缺少 scope 的替身行为代表 SDK。

验证结果（2026-10-23）：

- 定向 8 个文件／185 项通过；`npm run typecheck`、`npm run build`、`git diff --check` 通过。
- 完整 `npx vitest run`：256 个文件中 253 个通过、3 个失败；3460 项中 3457 项通过、3 项失败。失败均为 `listen EPERM: operation not permitted 127.0.0.1`，分别是 `tests/graphon-capability-audit.test.ts`、`tests/planning-notification-reconnect.test.ts`、`tests/tool-adapters.test.ts` 的本地监听测试。沙箱外仅复跑这三个文件的请求未获批准，故保留为环境验证缺口，不能称全量通过。
- 本次日志：`/tmp/t23-20-vitest-targeted.log`、`/tmp/t23-20-vitest-full.log`（临时文件，不纳入仓库）。
- 复核（2026-10-23）：沙箱外全量 `npx vitest run`（256 文件／3460 项）与 typecheck 全部通过，上述 3 个 EPERM 文件在沙箱外通过。

**T23.20 离线已完成，Desktop r18 待验，T23 整体未完成。** 未进行真实模型调用，没有降低思考强度、修复次数或校验；未改 frozen manifests、T09 配置、docs/evidence 原件、tests/probes 或 cordis.patch.yml；不提交或推送。

## 31、r18 Desktop 实测（2026-10-23）

安装 r18（T23.20，归档 sha `b708fc8b…c069`）后，在验收工作区新建对话，跑 T20 两次、成绩分级一次。模型为 GLM-5.3-Flash／Max，思考强度未调整。会话副本在 `.test-data/t23/r18/`（不提交）。

| 运行 | 总时长 | 路线 | 主 Agent 各步（秒） | 工具调用 | 第 1 步有简报 |
| --- | --- | --- | --- | --- | --- |
| r18a T20 | 1:54（114 s） | 模块，0 次规划调用 | 80／4／30 | plan → plan_wait | 是 |
| r18b T20 | 2:37（158 s） | 模块，0 次规划调用 | 104／7／47 | plan → plan_wait | 是 |
| 成绩分级 | 2:10（131 s） | 设计（moduleCheck 两模块理由正确） | 56／6／22 | plan → plan_wait | 是 |

### 31.1 结论

- **首步简报生效：** 三次会话第 1 步的 system/message 都带 Host 命令简报，r12–r17 的 14 次全部没有。主 Agent 不再调用 `visible_workflow_modules`，第 1 步直接提交请求，主 Agent 只剩 3 步。
- **第 1 步耗时下降：** T20 从 r17 的 122–148 s（约 25k 字推理）降到 80–104 s（约 14k–17k 字），原来的第 2 步（54–99 s）整步消失。
- **保存后不再翻查：** r18a 汇报写明“固定行为（回执 fixedFacts 核对）”，按回执确认审核提示中“文件编辑不用于提交”。两次 T20 都没有重读节点，也没有检索应用安装目录。
- **与基线比：** T20 r8 为 429 s，r18 为 114／158 s（−63%～−73%）；成绩分级 r8 为 188 s，r18 为 131 s（−30%）。全部一次成功，无入口拒绝、问题卡片或错误。

### 31.2 剩余耗时与边界

- 第 1 步 56–104 s 是主 Agent 读需求、对照模块参数并写出完整请求的推理，属于“理解只做一次”的必要成本。继续压缩只能靠更多模块或更短的请求形状（T24／T25），不靠降低思考强度。
- 发布后的汇报步 22–47 s，以输出汇报文本为主。
- §30.2 的残余限制未在本轮触发（三次都在空闲新对话中发命令）；忙碌或排队时首步仍可能没有简报。
- 样本为 T20 两次、成绩分级一次。路线稳定性另有 r17 的三次 T20 支撑。

**状态：T23.20 Desktop r18 通过；T23 于 2026-10-23 经用户确认完成。** 后续提速转入 T24（扩充模块库）／T25（骨架先交），范围另定。
