# Host 确定性修复：错位字段与节点说明

> 状态：2026-10-23 用户批准（改动 A 采用 A3 节点备注）。约束沿用 T23：不降低思考强度，不改模型，不放宽提交上限和修复次数，Host 校验不减少。

## 1、为什么做

### 1.1、数据来源

统计脚本 `.test-data/repair-stats.py` 读取 `.test-data/**/events.jsonl` 中全部基准运行（T09／T10／T21／复验，8 类需求 × 两种规划模式），去重后得到 480 次有效运行。每次运行都记录了每轮修复的错误码、路径、Host 提示、模型补丁和每次调用耗时。不调用模型。

### 1.2、更正：容器组装已经实现

上一轮汇报把"容器结构由 Host 自动组装"列为待实施，这是错的。2026-10-21 的提交 4624248 已经实现：
- 节点 scope 由 `{container, nodes}` chain 推导；
- 容器内缺少 input 时，Host 生成 `hostEntry` 并自动接线。

按这次提交前后切分，模板填写模式（Desktop 实际使用，`cordis.patch.yml` 中 `planningCompiler: template-fill`）的结构类错误从 4/42 降到 4/198。剩下的 4 次也不是缺入口，而是字段放错层级。

### 1.3、4624248 之后仍需修复的情况

修复耗时指首次提交之后的全部模型时间。

| 模式 | 错误 | 运行数 | 修复耗时合计／中位 | 结果 |
| --- | --- | --- | --- | --- |
| 整图修复 compact-repair（代码默认） | 节点上多写 `description`（`Unrecognized key: "description"`） | 32／199（16%） | 2046 s／64 s | 全部一轮修好 |
| 整图修复 | 把容器内部写成 `config.body` 嵌套图 | 2／199 | 280 s／140 s | 修好 |
| 整图修复 | 其他（别名重名等语义问题） | 8／199 | 1250 s／32 s | 修好 |
| 模板填写 template-fill（Desktop） | 配置字段写在 `values` 外（`/updates/n30/text`），或把 `container` 写进表单 | 4／198（2%） | 816 s／200 s | **2 次失败** |
| 模板填写 | 其他字段问题 | 5／198 | 122 s／26 s | 修好 |

### 1.4、关键观察：反馈已经精准，模型仍改不对

模板填写的 4 次错位，Host 都准确说出了位置和改法，例如："把 text 移到 `/updates/n30/values/text`，并删除 `/updates/n30/text`"。但模型两次都把补丁写回原处（`replace /updates/n30/text`），被判"补丁没有修改任何内容"，最后以"同一草稿和错误重复，停止重试"失败。

另有一次，Host 的提示本身自相矛盾：
1. 第一轮说"把 container 移到 values/container"；
2. 模型照做后，第二轮又报 `values` 不认识 `container`。

`container` 的正确位置是 chain。这条矛盾提示出现在 10-22 的 replicate-r5。当前代码（`planning-template-compiler.ts` 第 244 行）已改为指向 `chains[].container`，但还没有回放测试锁定。

**结论：** 这些错误的改法唯一且无损，Host 已经知道答案。让模型再思考一轮，不但花 60–200 秒，还可能改错。应由 Host 直接修复，不再交给模型。

## 2、原则

1. **能唯一、无损确定的改法由 Host 做。** "唯一"指只有一种结果能通过检查，并且不改变用户或模型表达的业务含义。"无损"指不丢弃会影响执行的信息。两项都满足才由 Host 修，否则照常反馈给模型。
2. **单一合同不变。** Host 不接受对外 Schema 拒绝的值。它把提交改写成合同内的等价形式，再走同一套 Schema 与编译检查；改写过程记入修复摘要和指标（`host-unique-repair`）。
3. **复用现有通道。** 沿用 `RepairSession.repairUnique()` 事务：同一草稿版本、同一提交额度、同一 allowedPaths。不新增"自动接受"旁路。
4. **提示与修复一致。** Host 的提示只能指向一个确实能通过检查的位置；不能先叫模型把字段放到 A，再拒绝 A。

## 3、改动 A：节点 `description`（原第 2 项）

**现状：** 整图修复模式的 CREATE 节点对象只允许 `key/kind/title/config/scope`（`planning-authoring-core.ts` 的 `node` 与 `nodeWire` 都是严格对象）。工作流顶层有 `description`，模型常在节点上也写一份。T23.14 之后，这类提交在 SDK 线上校验阶段就被拒；而 `repairUnique` 只在编译阶段失败时运行（`agent.ts` 的 `!schemaIssues.length` 条件），所以目前不会自动修。

**方案（用户选定 A3，2026-10-23）：** 节点新增可选的"备注"字段，规划时模型写的 `description` 存为备注；不写也没有问题。

1. **数据：** `WorkflowNode` 增加可选 `note?: string`，最多 2000 字。它只是说明，不参与执行。
   - 存储校验、导入导出、复制工作流、模板保存都保留该字段。
   - 运行时忽略它。
   - 模块的 `implementationDigest` 不纳入备注（固定实现不变）。
2. **界面：** 节点设置面板（Inspector）增加"备注"多行输入框，用户可以自己写和修改。卡片上是否显示"有备注"标记，暂不做。
3. **规划合同（两种模式一致）：**
   - **整图修复：** CREATE 节点和 EDIT 的 `addNodes` 接受可选 `description`，`updates` 可以设置或清除它。
   - **模板填写：** 表单和更新同样接受。
   - **共同规则：** 对外 Schema 与 Host 检查共用同一合同；Host 把它落为 `node.note`。
   - **字段说明：** 写明"节点备注，仅作说明，不影响执行；可省略"。
4. **编辑上下文：** 修改已有图时，目标节点的已有备注作为只读信息提供给规划子 Agent，单条最多截断到 300 字。非目标节点的备注不下发，避免增加 token。
5. **固定节点：** 允许修改备注。固定规则约束的是执行行为，备注不影响执行。
6. **回退旧版本：** 旧版插件（r18 及以前）的存储校验是严格对象（`workflow-validation.ts` 的 `nodeSchema` 使用 `.strict()`），读到 `note` 会拒绝整张图。因此提供一个独立的维护脚本：
   - 默认只演练（dry-run），列出带备注的图和节点；
   - 加 `--apply` 时先备份 `library.json`，再去掉所有 `note`；
   - 回退前先运行它。安装脚本的 rollback 流程会提示这一步，但不会自动改用户数据。

- **曾考虑：** A1 接收后丢弃；A2 转成画布便签。用户最后选择 A3：信息保留，又不占画布。
- **不采用：** 只在提示里写"节点不要写 description"。这类错误是系统性的，16% 的运行都犯，提示难以根除。

**预期：** 整图修复模式少掉约 16% 运行的一轮修复，每次 30–100 秒。Desktop 当前用模板填写，不直接受益；受益的是代码默认配置和回退路径。

## 4、改动 B：错位字段自动归位（原第 1 项的剩余部分）

Host 在两种模式下都识别以下情况，并生成唯一补丁：

| 情况 | 判定条件（全部满足才修） | Host 补丁 |
| --- | --- | --- |
| B1：模板填写中，配置字段写在表单或更新的顶层（`/formsByKey/K/text`、`/updates/K/text`） | 该字段名属于此节点模板的 `values` 字段；`values` 中没有该字段，或已有值与其完全相同 | 把值移到 `values/<字段>`，删除顶层字段 |
| B2：表单顶层或 `values` 中写了 `container` | `container` 指向已声明的 loop／iteration 节点；该节点当前没有内部 chain，或只有一条内部 chain 且本节点不在其他 chain 中 | 删除表单里的 `container`。若容器还没有内部 chain，新建 `{container, nodes:[本节点]}`；若已有一条，把本节点追加到其末尾 |
| B3：整图修复中，容器 `config.body` 写成嵌套图（可选，见 §5） | — | — |

**任一条件不满足**（例如多个候选位置、值冲突、chain 顺序有歧义）时不自动修，照常反馈。B2 的反馈只指向 chain 的写法，不能建议写进 `values`。即使不实施 B2 的自动修复，也要用 replicate-r5 的原始提交写一个回放测试，锁定当前提示指向 chain。

**两种拒绝都要覆盖：** 错位字段可能在线上 Schema 阶段被拒，也可能在编译阶段被拒，Codex 需逐一确认。线上阶段被拒时，Host 先用同一判定生成补丁，补丁结果同时通过对外 Schema 和编译检查，才算一次 Host 修复。

## 5、改动 C（可选）：整图修复的 `config.body` 展开

只在以下情况展开：
- `body.nodes` 的 id 互不重复，也不与已声明 key 冲突；
- `body.edges` 两端都在 body 内，且恰好构成一条从头到尾的单链（或只有一个节点）；
- 没有 port。

展开方式：内部节点提升为同级声明，加一条 `{container, nodes:[按边顺序]}` chain，删除 `config.body`。其余形状仍反馈。

这项只覆盖 2／199 次运行。如果实施成本明显高于 A、B，可以不做。

## 6、不做的事

- 不对别名重名、业务语义、审核结构等改法不唯一的错误做自动修复。审核结构交给模块（T24）。
- 不放宽提交上限，不跳过任何检查，不降低思考强度。
- 不改 Desktop 的规划模式配置。

## 7、验收

1. **离线回放（主要证据，不调模型）：** 从 `events.jsonl` 的 `submissionsLog` 取出上表中失败或需修复的原始首次提交，逐字放进当前编译器：
   - 改动 A：带 `description` 的首次提交直接被接受，或经一次 Host 修复后被接受；
   - 改动 B：4 次错位提交经 Host 修复后被接受；
   - 两项的候选图都与"模型修好后的版本"在语义上一致。

   回放夹具保存原始字节的 SHA-256。
2. **单元测试：** 每种判定的正例和反例，包括值冲突、多个候选位置、指向非容器节点、已有多条内部 chain、`description` 超长。修复摘要和 `host-unique-repair` 指标都有记录。修复仍占用提交额度。
3. **回归：** 定向测试、全量 vitest、typecheck、build。
4. **真实模型复测（另行批准）：** 用模板填写和整图修复两种模式各跑 container、local-edit、large-edit、web-process 若干次，看修复轮次和失败率。这一步要调用真实模型，需要你单独批准，本方案不默认执行。

## 8、预期收益（如实）

- **Desktop（模板填写）：** 受影响的约 2% 运行，每次省 60–200 秒，并避免其中一半的失败。平均到每次规划只省几秒，价值主要在于去掉偶发的长耗时和失败。
- **整图修复：** 约 16% 运行少一轮修复，是两项里整体收益最大的；但它不是你 Desktop 当前所用的模式。
- **成本：** A 很小；B 中等，需要处理线上 Schema 阶段的拒绝；C 可选。

## 9、任务拆分（建议编号 T26）

- T26.1 改动 A：节点备注字段 `note`，包括数据、校验、导入导出、Inspector 输入框、两种规划合同的 `description`→`note`，以及回退用的去备注脚本。
- T26.2 改动 B：B1／B2 唯一修复，修正 `container` 的提示；线上拒绝与编译拒绝都适用。
- T26.3 改动 C（可选）：单链 `config.body` 展开。
- T26.4 离线回放与回归；真实复测待用户另行批准。


## 10、T26 实施

2026-10-23：T26.1、T26.2、T26.4 离线完成，Desktop 待验。未调用真实模型，未修改冻结 manifests、基准配置、历史 evidence、probes、Desktop profile 或安装脚本；未提交 Git。

### 10.1 节点备注与统一合同

- `WorkflowNode.note?: string` 为非执行元数据，最多 2000 个 UTF-16 码元，与现有 Zod 字符串及 textarea 长度约定一致。工作流严格校验、规划投影、落图和编辑操作均保留该字段。
- compact 的 CREATE `nodes`／EDIT `addNodes`，template-fill 的 CREATE `forms`／EDIT `addForms` 接受可选 `description`。两种模式的 `updates` 均用字符串设置、`null` 清除，未提及时保留原备注；字段描述共用 `planning-node-note.ts`。当前 SDK 支持的 JSON Schema 子集没有 `maxLength`，故对外字段说明明确 2000 上限，由同一编译流程的 Zod 强制校验；没有另设宽松提交合同或接受超长备注。
- 编辑上下文只把目标节点已有备注作为只读 `note` 下发，每条截断至 300；非目标节点不下发。请求中的修改仍使用 `description`。固定节点可改备注，其执行字段、边和作用域保护保持；固定容器的递归执行比较排除内部节点备注，避免误报。
- 全仓检索 `WorkflowNode`、节点映射及重建位置：`workflow-format` 的导出、导入与新 ID 复制，Host 工作流库、模板库，客户端复制／布局／编号均已通过整对象克隆或展开保留字段，无须另加重复映射。逐字段重建的规划投影与编辑落图已补齐。运行时不读取备注作为执行配置，Graphon 调度只取节点 id/kind；模块 implementationDigest 的定义只取执行字段，两个既有摘要保持为 `97ab7ab7732fc5cc1f22bce41bcce0b280401042345e18106513385bb9a53419`、`e44821bd615c8343e0729cbde3540d63be5eef7ebf9d29123a2cd0b1fc747751`。

### 10.2 Inspector 位置与设计规范

已完整阅读根目录 `DESIGN.md`，按 §3、§4、§5.3、§9.4、§15 及后续侧栏、表单、展开编辑修订实现。备注放在节点设置页正文第一项，紧邻上方标题、用途说明和页签：它是所有节点共有的信息，先于类型专属执行参数；不挤入紧凑标题栏，也不新增画布标签。

复用现有 `PromptEditor` 的字段标题、`HelpButton`、`vdw-prompt-editor/header/body`、字符计数、复制按钮、占位文字、边框与聚焦样式，以及 `ExpandedEditorShell` 的展开／收起、焦点管理、ESC 与滚动行为。该组件增加可省略的 role，以显示“备注”而非 SYSTEM/USER；增加 `maxLength` 同时约束紧凑和展开视图。紧凑框用既有 rows 参数设为 3 行，展开沿用现有长文本编辑器。未新增 CSS、颜色或像素尺寸，字号、间距、深色主题、只读和禁用态沿用组件与侧栏变量；中英文标签、帮助、占位文案进入 i18n-messages。

规范未单列“节点备注”控件，采用最接近的既有长文本字段及展开编辑规则；未发现需覆盖现行规则的冲突。组件交互已离线测试，真实 Desktop 中英文、深浅主题和侧栏视觉验收仍待执行。

### 10.3 B1／B2 及线上拒绝路径

B1 仅将属于该节点模板 values 的字段归位：目标缺失则移动，值完全相同则删外层重复项；不覆盖冲突值、不移动元数据或模板固定字段。旧有静默归位改为显式反馈后由 RepairSession 提交补丁，因此可记录修复摘要及额度。

B2 只接受已声明的 loop/iteration，且只有零条或一条内部 chain。本节点已在该唯一内部 chain 时只删除冗余声明，否则新建单节点内部 chain 或追加到末尾。多个候选位置、非容器、自包含、多条内部 chain、节点位于别的 chain、多个未排序待归位节点均不自动修复。原始 replicate-r5 使用单元素数组 `container:["iterate"]`，实施额外允许这种唯一指向，拒绝多元素数组。EDIT 合同没有添加内部 chains 的表单结构，故 B2 仅对 CREATE forms 生效；EDIT 配置错位仍适用 B1。提示明确指向 `chains[].container`，不建议写进 values。

T23.14 后表单／更新顶层是严格对象，原始错位提交会先被对外 Schema 拒绝。实施路径如下：

1. `rejectWire` 仍计入一次提交，原值只暂存，不接受为候选、不写入草稿；已有失败草稿时不借新拒绝去修旧草稿。
2. `repairUnique` 对原值运行相同诊断与唯一规则，补丁仍受诊断 allowedPaths 限制。修复视图还原成对外数组形式后，必须同时通过本次下发 Schema、固定终端 Schema，以及全部编译／Host 检查；预检不保留节点 ID 预留副作用。缺字段、拼错字段、冲突或无唯一解仍照常反馈。
3. 证明通过后，进入同一个 RepairSession `mode:repair` 事务，再次检查 revision、scope、重复修复、额度及编译结果；首交加修复共占两次提交，没有增加上限。普通编译拒绝沿用原有事务语义，失败补丁仍提供正常反馈并受重复修复检查。
4. 原生 SDK 的 `exec.arguments` 只读，因此采用规划子 Agent 私有 `structured_output.execute` 适配器，用该调用 token 绑定已验证的修复值，再交给原生 execute。保留原生工具、参数 Schema、输出 Schema、next、guard、policy、终端验证、capture 和提交确认链；原始参数不被修改。适配器消费前再次检查权限、取消及两份 Schema，结束时恢复原 execute。未通过的原值不会交给终端接受，也没有隐藏替代提交工具。
5. 记录额外一次 submission、`host-unique-repair` 指标，并将 Host 生成的修复摘要写进提交观察记录和任务事件。已用仓库安装的真实 ToolRuntime／structured runtime（模型激活为离线替身）验证 capture、终端合同变化与最后权限阻断均不被绕过。

### 10.4 原始回放来源与 SHA-256

通过 `python3 -I .test-data/repair-stats.py` 检查历史统计。从 events.jsonl 的原始 JSON 文本截取提交、完整 submissionsLog、feedback 和成功 candidate，从对应 manifest 截取 context，保留 UTF-8 原始字节，不经 JSON 重排或补字段。入库目录为 `tests/fixtures/t26/`；来源路径、1-based 行号及所有文件 SHA-256 见 `sources.json`，测试还固定该索引自身的 SHA-256，防止仅更新索引就改变回放基线。

| 夹具 | 原始 events.jsonl（均在 .test-data 下） | 行号 | 首交 SHA-256 |
| --- | --- | --- | --- |
| layered-local-edit | `layered-par/shard-4/events.jsonl` | 42 | `2f2728df6c17ea551f95cfc593ef38e7e77caf148832cc890921bb7b4e12cee7` |
| layered-large-edit | `layered-par/shard-4/events.jsonl` | 73 | `187915a816e5a45a9bbd3d370ea4479531d2e0838551c737ee7cadb27e074c76` |
| replicate-container | `replicate-r5/retry-429/shard-6/events.jsonl` | 33 | `4b052bbca14b45a11d9048b2b9bbcc56e2dc83c4372fa5f442285590f7c648f6` |
| replicate-large-edit | `replicate-r5/retry-429/shard-8/events.jsonl` | 81 | `4310352d17786e53256f7aa860cd81b7c42e22f4f8c6fba29882b1b3c27eb220` |
| compact-web-process | `t21-paired-r2/shard-1-part-2/events.jsonl` | 33 | `0bb674edd27bf8242a6a3ccefaabbb572b0d0f89316270c11f090c143b3d406a` |
| compact-branch | `t21-paired-r2/shard-4-part-1/events.jsonl` | 25 | `f8ba7cf1157a4003cc1479c60f46ae8663e89c4143418a10740060068c41edfa` |
| compact-container | `t21-paired-r2/shard-4-part-2/events.jsonl` | 37 | `68ff41aafd6bb53b14c6284f5583f6fbf54e790f0a91ad950b0b2653b924783f` |

3 组 compact 原始首交直接通过，description 落为 note；4 组 template-fill 原始首交各经一次 Host 唯一修复通过，同时覆盖 Schema 拒绝与编译拒绝。语义比较包括节点类型、配置和连线，忽略 id 与坐标。

与设计验收的差异：layered-par local-edit／large-edit 历史运行最终失败，没有“模型修好后的候选”。这两组依据原始明确 text 修改及基线图独立构造期望；其余 5 组与原始成功 candidate 对比。没有把缺失的成功结果伪造为历史证据。T26 合同新增备注说明后，当前请求摘要另存 `compact-request-digests.json`；原冻结快照及 manifests 未改。

### 10.5 回退步骤

旧版严格 nodeSchema 不认识 note，回退插件前须先停止使用该存储的插件，再在新版本源码中显式运行独立脚本（不要依赖 `.cache/audit-*` 安装脚本）：

```sh
node scripts/strip-node-notes.mjs /明确指定的存储根目录
node scripts/strip-node-notes.mjs /明确指定的存储根目录 --apply
```

第一条默认 dry-run，仅列出含备注的工作流与节点；第二条先把 library.json 原字节备份为同目录 `library.json.before-strip-node-notes-时间戳-进程号.bak`，再递归删除所有节点（含容器内）的 note。脚本不发现或读取默认 Desktop profile，不传路径即报错。恢复备注可在停止插件后用该备份恢复 library.json。测试全部使用临时目录，覆盖 dry-run 不写、apply、字节级备份、递归及重复运行。

### 10.6 改动文件

- 数据与规划：`src/shared/types.ts`、`workflow-validation.ts`、新增 `planning-node-note.ts`、`planning-types.ts`、`planning-projection.ts`、`planning-edits.ts`、`planning-context-slice.ts`、`planning-authoring-context.ts`、`planning-authoring-core.ts`、`planning-authoring.ts`、`planning-template-compiler.ts`、`planning-repair.ts`（后续省略项均位于 src/shared）。
- Host：`src/host/planning/agent.ts`、`service.ts`。
- 前端：`src/client/forms.tsx`、`prompt-editor.tsx`、`i18n-messages.ts`。
- 维护与验证：新增 `scripts/strip-node-notes.mjs`、`tests/planning-t26.test.ts`、`tests/fixtures/t26/`；更新 `tests/planning-native-compiler.test.ts`、`prompt-editor.test.tsx`、`t10-authoring-feedback.test.ts`、`t10-authoring-regressions.test.ts`。
- 文档：本节及同目录 `tasks.md`。未修改 workflow-format／模板库代码，它们已有整对象保留路径，本轮通过新增回归验证。

### 10.7 验证与残余限制

最终验证（均离线，无真实模型）：

| 命令／范围 | 结果 |
| --- | --- |
| `npx vitest run tests/planning-t26.test.ts tests/planning-edits.test.ts tests/planning-native-compiler.test.ts tests/planning-bounded-repair.test.ts tests/planning-business-modules.test.ts tests/planning-command-brief.test.ts` | 6 文件、102 项通过，含备注合同、7 组原始回放、B1/B2 正反例、原生 SDK 终端／权限检查、额度／scope／stall、回退脚本与两个冻结模块摘要 |
| `npx vitest run tests/t10-authoring-feedback.test.ts tests/prompt-editor.test.tsx` | 2 文件、52 项通过，含既有反馈与请求字节回归、备注紧凑／展开编辑、清除、长度、只读／禁用交互 |
| `npm run build` | 通过；52 个 remote methods，Host／Client schemas match |
| `npm run typecheck` | 构建完成后单独执行通过 |
| `git diff --check` | 通过 |
| `npx vitest run` | 完整运行 257 文件、3494 项：254 文件／3491 项通过，3 文件各 1 项失败；未跳过或减少测试 |

全量的 3 项失败均为沙箱 `listen EPERM: operation not permitted 127.0.0.1`：`tests/graphon-capability-audit.test.ts`、`tests/tool-adapters.test.ts` 的本地 HTTP 用例、`tests/planning-notification-reconnect.test.ts` 的真实 socket 子进程用例。不能记作通过，需要在允许监听端口的环境复验。最终构建、类型检查、全量测试按顺序执行，排除了构建清理 lib 与类型检查并行造成的临时生成文件竞争。

T26.3 未实施：递归嵌套 body 的安全展开涉及节点 ID 提升、引用与作用域重写，成本显著高于本轮备注／错位归位；按 §5 可选范围跳过，仅覆盖 2／199 次运行的收益不足以扩大本轮改动。既有拒绝与反馈保留。真实模型复测、Desktop 安装和视觉验收均未执行，留待用户验证；没有改动运行配置、Host 校验或修复限额。
