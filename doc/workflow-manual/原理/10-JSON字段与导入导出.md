# JSON 字段与导入导出

核对日期：2026-10-21。本文定义本项目唯一受支持的工作流 JSON 结构：`formatVersion: 2`、`runtime.engine: "graphon"`、`runtime.protocol: 1`，以及下文规定的字段。导入、导出、编辑保存和 Agent 生成共用这套字段与校验规则，不接受旧包版本或自动迁移旧字段；本文明确列出的历史字段仅只读兼容，不生效，也不批量重写旧图。它是文件格式说明；实机验收结论以对应验收记录为准，不把格式校验通过等同于所有模型、工具都能执行。

[返回手册](../README.md) · [导入导出操作与待处理提示](../交互/23-JSON导入导出与待处理.md) · [节点类型索引](../节点/README.md) · [核心字段总览](#11-核心字段总览) · [完整示例](#122-子-agent普通变量与执行策略示例)

Agent 辅助生成复用本文的 Workflow 和节点配置。模型只输出允许编辑的字段投影，Host 补齐身份、坐标和版本后走同一校验和保存路径；投影不能直接当导入包使用。具体见[JSON 投影与宿主补齐](../规划引擎/03-JSON投影与宿主补齐.md)。

## 1. 这份 JSON 保存什么

工作流 JSON 是一份完整的流程定义。它记录节点是什么、节点之间怎样连接、每个节点怎样配置、在画布上放在哪里，以及需要哪些外部资源。循环和迭代的内部节点直接放在容器配置中；被调用的独立工作流放在包内的 `workflows` 集合中。

模型服务、工具连接、Secret 密钥和本机授权属于运行环境。JSON 记录需要什么，导入到另一环境后由真实 Harness 重新核对。缺少值或资源的流程可以保存在原画布中，待处理项全部解决前不能运行。不存在另一个“草稿区”。

| 内容 | JSON 中的处理方式 |
| --- | --- |
| 节点、连线、节点配置 | 完整保存；配置按节点类型校验 |
| 节点坐标、便签、视口、普通节点批注 | 保存；导入后重建身份及关联 |
| 独立子工作流 | 导出时从当前工作区收集可用的调用依赖，去重后随包保存；未找到的目标保留引用 |
| 角色预设 | 保存已找到且被流程使用的全局角色，以及随包流程自己的局部预设库；没有找到的角色保留待配置引用；选区模板只携带实际使用的角色 |
| 子 Agent 定义与提示词 | `subAgents[]` 保存编号、名称及角色提示词；Agent 节点用 `config.subagentId` 引用，同一身份可用于多个节点 |
| 普通环境变量值 | 默认不带值；用户勾选后可包含 |
| Secret | 只带声明与受控用途，不带值、句柄、配置状态或授权 |
| 系统变量 | 仅保留引用，实际值由目标宿主运行时生成 |
| 固定资料文件 | JSON 保存文件槽位与依赖；完整 ZIP 流程包可携带工作区内可读取的资料 |
| 运行日志、执行结果、续跑快照 | 不属于此交换格式；导入不是恢复某一次运行 |
| 聊天会话、已发送批注回执、本机身份 | 不导出 |

### 1.1 核心字段总览

本节汇总当前字段含义。详细类型、默认值和限制以各节字段表为准；可选字段省略表示当前格式允许的未配置状态，不是另一套版本或旧字段别名。

| 字段路径或对象 | 当前含义 | 保存、导出与导入规则 |
| --- | --- | --- |
| `workflow.subAgents[]`，以及随包子流程的 `subAgents[]` | 工作流内可复用的子 Agent 定义清单 | 保存 `id`、`number`、`name`、`prompt`；导出带完整角色正文；导入/另存为重建定义 ID |
| Agent 节点 `config.subagentId` | 对子 Agent 定义的引用 | 与所在工作流 `subAgents[].id` 对应；导入同步改写，不能填写实际执行任务 ID |
| Agent 节点 `config.prompt` | 本节点任务提示词 | 与共享角色文本分开保存；支持普通变量模板，导入时按引用规则改写 |
| `subAgents[].sessionId` | 本地主对话绑定 | 本地保存；导出移除，导入也清除外带绑定，由目标宿主重新绑定 |
| `subAgents[].rolePresetId`、`rolePresetRevision` | 本地预设来源记录 | 卡片选择预设后保存来源及角色正文快照；导出/导入移除来源，保留正文；Agent 节点自身不接受 `config.rolePresetId` |
| `workflow.budgetDecision` | 已退役的历史元数据，仅只读兼容 | 旧图的 `mode`、`decidedAt` 仍可读取和随包保留；不生效，不为新图生成，不作为授权 |
| `workflow.executionPolicy` | 执行策略：输出修复方式、并发上限、修复轮次上限 | 高级设置只编辑现行策略；其中 `tokenBudget`、`perTaskTokens`、`maxAgentTasks` 为已退役字段，仅只读保留且不生效，见第 8 节 |
| `environmentVariables[].type/value` | `string` / `number` / `secret` 三种声明 | 普通 JSON 导出默认去掉普通值，勾选才包含；另存为保留普通值。Secret 始终没有 `value` |
| `NodeExecution.subagentDefinitionId` | 运行记录中的子 Agent 定义身份 | 与该运行冻结图中的定义对应；不属于导入导出包 |
| `NodeExecution.subagentId` | 实际原生任务 ID | 与节点配置中的同名字段含义不同；不随流程定义导出 |
| 保存模式、自动保存间隔、检查中/已保存状态 | 属于客户端偏好或即时状态 | 不新增 `autoSave`、`saveState`、`canRun` 等可导入字段；视口仍保存于 `editor.viewport` |

包版本固定为 `formatVersion: 2`，Graphon 桥接协议固定为 `runtime.protocol: 1`。`formatVersion`、工作流保存版本 `revision`、附件清单的 `version` 和 DSH 客户端版本彼此独立，不能互相替代。本文不维护旧包版本结构或迁移教程；明确列出的历史字段只读兼容，不恢复其原有控制行为；历史验收记录只说明当时的行为，不构成当前格式承诺。

## 2. 顶层结构与版本

| 字段 | 类型 | 必需性与含义 |
| --- | --- | --- |
| `format` | string | 必需，固定为 `dsh-visible-workflow` |
| `formatVersion` | integer | 必需，只允许 `2`；其他版本拒绝导入，不自动转换 |
| `runtime` | object | 必需，执行协议声明；只允许 `engine: "graphon"`、`protocol: 1` |
| `workflow` | Workflow | 必需，用户导入后首先打开的主流程 |
| `workflows` | Workflow[] | 独立子流程集合；省略时按空数组处理，最多 50 个；规范导出始终写出此数组，无子流程时为 `[]` |
| `presets` | RolePreset[] | 必需，角色预设集合，允许为空，最多 200 个 |
| `dependencies` | Dependency[] | 必需，依赖清单，允许为空，最多 2,000 项；不能用它伪造资源已配置或已授权 |

更改版本号不能让旧字段成为合法字段。包版本、主体和每类节点配置分别校验；只有同时符合本文结构的文件才可导入。缺少可选配置与使用不支持的旧字段是不同情况，前者按第 11.2 节保留为待处理，后者直接拒绝。第 8 节明确列出的已退役字段仍可解析，但只读保留且不生效。

顶层、工作流、节点及各类配置采用明确字段的校验。拼错字段名、随意增加 `systemVariables`、`ready`、`authorized` 等字段，不会被当作可信运行状态接收。`inputs` 等明确允许任意业务键的映射除外，但仍受 JSON 类型和危险字段限制。

## 3. 工作流主体 Workflow

主流程和 `workflows` 中的子流程使用同一套结构。

| 字段 | 类型 | 说明与限制 |
| --- | --- | --- |
| `id` | string | 流程身份。1–160 个字母、数字、下划线或连字符；包内流程身份不能重复 |
| `workspaceId` | string | 所属工作区，1–160 字符。导出写成 `import-required`，导入替换为用户选定的目标工作区 |
| `title` | string | 名称，1–200 字符 |
| `description` | string | 说明，最多 10,000 字符，允许空字符串 |
| `revision` | integer | 非负版本号。导出归零；导入后的保存版本由目标存储生成 |
| `nodes` | WorkflowNode[] | 当前这一层的节点，1–200 个 |
| `edges` | WorkflowEdge[] | 当前这一层的连线，最多 1,000 条 |
| `notes` | CanvasNote[] | 主画布便签，最多 200 个，允许空数组 |
| `createdAt`、`updatedAt` | string | 必需，ISO 日期时间；新建导入后由目标环境重新记录 |
| `archived` | boolean | 可选，本地归档状态。导出和创建导入时移除 |
| `environmentVariables` | array | 可选，环境变量声明，最多 200 个 |
| `executionPolicy` | object | 可选，执行策略及只读兼容的已退役字段，见第 8 节 |
| `budgetDecision` | object | 可选，已退役的历史元数据，仅只读兼容且不生效；不为新图生成，见第 8.1 节 |
| `subAgents` | WorkflowSubagent[] | 可选，最多 500 个工作流内子 Agent 定义，见第 5.2 节 |
| `editor` | object | 可选，画布视角和普通节点批注，见第 6 节 |

单个工作流包含所有容器内部节点后，总节点数最多 500。每个工作流的容器嵌套最多 5 层。每层仍独立遵守节点和连线数量限制。

### 3.1 节点 WorkflowNode

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 稳定身份，格式同工作流 ID。同一工作流内，包括嵌套节点，不能重复；不能占用 `env`、`sys` |
| `number` | string | 展示编号，最多 100 字符。保存时可重新编号；不能把它当作变量引用依据 |
| `kind` | string | 精确的节点类型，下文列出 20 类；不能用中文显示名替代 |
| `title` | string | 显示名称，1–200 字符 |
| `x`、`y` | number | 所属画布中的坐标，必须为有限数字，可为负数和小数。内部节点使用其容器画布的坐标 |
| `fixed` | boolean | 是否固定；保留固定状态，具体编辑权限由宿主执行 |
| `config` | object | 此节点类型的配置，不同 `kind` 允许的键不同 |

节点坐标会原样保留。字体、窗口尺寸、节点内容变化仍可能影响最终屏幕占用尺寸，因此 JSON 保证坐标数据，不保证像截图一样逐像素相同。

### 3.2 连线 WorkflowEdge

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 当前图内唯一的连线身份 |
| `source` | string | 起点节点 ID，必须存在于当前这一层 |
| `target` | string | 终点节点 ID，必须存在于当前这一层；不能指向输入节点 |
| `port` | string | 可选，起点出口。省略通常表示 `default` |

普通节点使用 `default`。条件节点使用 `true`、`false`，多条件分支使用条件 ID 和 `false`；逻辑门使用 `true`、`false`。分类节点使用类别 ID。人工节点使用操作 ID，并支持 `default`、`timeout`。不能把连线接到不存在的出口。

不能跨容器直接连线，也不能用普通连线形成环；重复的起点、终点和出口组合会被拒绝。循环逻辑通过循环容器表达。连线曲线的控制点不保存，客户端根据端点与出口重新绘制。

## 4. config 公共字段

本节中的公共字段也有适用范围。写到不支持它的节点中，会被严格校验拒绝。

### 4.1 模型字段

适用于 `llm`、`agent`、`classifier`、`extractor`、`document`。

| 字段 | 类型 | 默认与限制 |
| --- | --- | --- |
| `prompt` | string | 省略时为空字符串，最多 400,000 字符；对 Agent 节点是本节点的任务提示词，不是共享角色文本 |
| `model` | object | 可选，形如 `{"provider":"提供方身份","model":"模型身份"}`；两值各 1–256 字符 |
| `effort` | string | 可选，1–128 字符；必须对应目标模型支持的思考强度 |
| `rolePresetId` | string | 仅 `llm`、`classifier`、`extractor`、`document` 可选，引用角色 ID，不以角色名称匹配；`agent` 节点禁止此字段，其角色只由 `subAgents[]` 定义提供 |

省略 `model` 表示节点没有显式覆盖；实际执行可采用当前 Harness 的可信默认模型。目标宿主没有可用默认值时，会出现待处理提示。导入时不会把不相同的模型静默当成原模型。

### 4.2 输入与输出字段声明

`inputs` 是业务参数映射：键为字段名，值可以是字符串、有限数字、布尔、null、数组或对象。完整的 `{{引用}}` 可以传递对象或数组；混在文本中的引用生成字符串。普通字符串不会自动变成引用。

业务字段名以字母开头，只含字母、数字和下划线，最多 80 字符。JSON 值中的字符串最多 400,000 字符，数组最多 10,000 项；禁止危险对象键。

`outputSchema` 和 `parameters` 使用下列字段声明，单组最多 40 项：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | 业务字段名 |
| `type` | string | `string`、`number`、`boolean`、`object`、`array` |
| `description` | string | 可选，最多 2,000 字符 |
| `required` | boolean | 可选，是否要求结果包含该字段 |

输入节点和人工节点的 `fields` 最多 40 项，每项结构如下：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | 业务字段名 |
| `label` | string | 展示标签，最多 200 字符 |
| `required` | boolean | 必需，是否必须由运行输入提供 |
| `defaultValue` | string | 可选，最多 200,000 字符；数字、布尔、JSON 等值在执行时按类型解析 |
| `type` | string | 可选：`text`、`paragraph`、`number`、`boolean`、`select`、`json`、`file`、`files` |
| `options` | string[] | 可选，最多 100 项，每项最多 1,000 字符 |
| `hidden` | boolean | 可选；不能与 `required: true` 同时使用 |

`file`、`files` 字段的已上传默认值不会随导出迁移，目标用户在运行时重新上传。

### 4.3 变量引用语法

当前唯一标准为 `{{input.name}}` 或 `{{稳定节点ID.name}}`，不支持 `{{#稳定节点ID.name#}}`。显示编号 `a-1` 不能替代节点 ID。输入节点声明 `name` 后，其输出的顶层 `name` 即为用户填写值。

模板节点可通过 `config.inputs` 将上游字段映射为局部变量，例如 `{"name":"{{真实输入节点ID.name}}"}`，随后在 `config.text` 使用 `你好，{{name}}`。输出节点引用该模板的 `{{真实模板节点ID.text}}`。示例中的 ID 必须替换为图中真实上游节点 ID。

规划候选发布前拒绝带 `#` 包裹的引用和必需表达式中不存在的节点 ID；校验失败交回规划子任务修正。显式 `default` 等可选值语义保留，字段内容仍由运行时校验。本次补强不新增其他系统的变量语法或旧版本兼容。

### 4.4 验收与缓存

全部节点配置均可携带以下可选字段；是否执行特定验收仍由实际节点适配器决定。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `verification.requiredFiles` | string[] | 验收时要求存在的文件 |
| `verification.requiredReadFiles` | string[] | 要求读取的资料文件，完整流程包可携带其内容 |
| `verification.requiredChangedFiles` | string[] | 要求产生改动的文件 |
| `verification.minTextLength` | integer | 最少输出文本长度，1–400,000 |
| `cache` | string | `never` 或 `reuse` |

每种文件路径数组最多 30 项，每项 1–4,000 字符。绝对路径会改为待重新绑定的标记。输出位置要求可以保留，但不会把以前生成的输出产物作为资料附带。`reuse` 只表达缓存策略，不把旧运行结果装入 JSON。

## 5. 全部 20 类节点配置

表中的“可选”表示格式允许省略，未必表示运行时可以缺少。缺少执行必需配置时，画布会提示待处理。

| kind | 名称 | 专属配置、默认值及限制 |
| --- | --- | --- |
| `input` | 用户输入 | `fields`，默认 `[]`。输入值在本次运行时收集，不写入导出文件作为历史输入 |
| `template` | 模板转换 | `text` 默认 `""`，最多 400,000 字符；可选 `inputs`。支持的模板语法见[变量说明](07-变量与稳定身份.md) |
| `llm` | 大语言模型 | 模型公共字段；可选 `inputs`、`outputSchema` |
| `if` | 条件分支 | `variable` 默认 `""`，最多 400 字符；`operator` 默认 `not_empty`；可选 `value`、`cases`、`logicGate`，详见下表 |
| `output` | 输出 | `text` 默认 `""`；`outputName` 默认 `result`，必须是业务字段名；可选 `inputs` |
| `agent` | Agent | `prompt`、可选 `model`、`effort`；禁止节点 `rolePresetId`；可选 `subagentId`，引用工作流 `subAgents[].id`，未选择时为待配置，不是原生任务 ID；`tools` 默认 `[]`，最多 30 个工具 ID，每个最多 256 字符；`maxSteps` 默认 6，范围 1–20；可选 `timeoutMs`，100–3,600,000 毫秒；可选 `inputs`、`outputSchema` |
| `knowledge` | 知识检索 | `query` 默认 `""`；`sources` 默认 `[]`，最多 20 个资料来源字符串；`topK` 默认 5，范围 1–50；可选 `threshold`，0–1；可选 `inputs`。资料来源是文件来源，不等于随意执行模板表达式 |
| `classifier` | 问题分类器 | 模型公共字段；`classes` 默认 `[]`，最多 20 项；每项含 `id`、`label`（1–200 字符）、可选 `description`（最多 400,000 字符）；可选 `inputs` |
| `human` | 人工介入 | `prompt` 默认 `""`；`fields` 默认 `[]`；`actions` 默认 `[{"id":"continue","label":"继续"}]`，1–20 项；每项含 `id`、`label`（1–200 字符）；可选 `timeoutSeconds`，1–2,592,000 秒 |
| `iteration` | 迭代 | `iterator`、`outputVariable` 默认 `""`，各最多 400 字符；可选 `body`；`errorMode` 为 `terminate`（默认）、`null`、`remove`；`parallel` 默认 false；`concurrency` 默认 3，范围 1–10 |
| `loop` | 循环 | 可选 `body`、`until`、`outputVariable`（最多 400 字符）；`maxIterations` 默认 10，范围 1–100；`initialVariables` 默认 `{}` |
| `exit_loop` | 退出循环 | 无专属配置；只能放在循环内部，也可以位于该循环内部的嵌套容器中 |
| `code` | 代码执行 | `language` 为 `javascript`（默认）或 `python`；`code` 默认 `""`，最多 400,000 字符；`inputs` 默认 `{}`；可选 `outputSchema`；`timeoutMs` 默认 5,000，范围 100–30,000 毫秒 |
| `aggregator` | 变量聚合器 | `groups` 默认 `[]`，最多 40 组；每组含 `name` 和 `variables`；`variables` 为 1–40 个引用字符串，每个 1–400 字符 |
| `document` | 文档提取器 | `source` 默认 `""`；`documentMode` 为 `local`（默认）、`tool`、`agent`；可选 `documentSourceKey`、`documentTextPath`（1–400 字符的安全路径）、`toolId`、`inputs`；支持模型公共字段；可选 `tools`（最多 30 项，每项 1–256 字符）、`maxSteps`（2–20） |
| `assigner` | 变量赋值 | `assignments` 默认 `[]`，最多 40 项；每项含 `name`、`operation`、可选 JSON `value`。操作为 `set`、`clear`、`add`、`subtract`、`multiply`、`divide`、`append`、`extend`、`pop`、`shift` |
| `extractor` | 参数提取器 | 模型公共字段；`parameters` 默认 `[]`，最多 40 项；可选 `inputs` |
| `http` | HTTP 请求 | 普通模式：`url` 默认 `""`；`method` 为 `GET`（默认）、`HEAD`、`POST`、`PUT`、`PATCH`、`DELETE`；`headers` 默认 `{}`，键最多 200 字符、值最多 10,000 字符；可选 `bodyText`、`inputs`；`timeoutMs` 默认 30,000，范围 100–120,000 毫秒。受控凭据模式见第 7 节 |
| `list` | 列表操作 | `listSource` 默认 `""`，最多 400 字符；可选 `filter`；可选 `sort: "asc"` 或 `"desc"`；可选 `limit`，1–20 |
| `tool` | 工具 | `toolId` 默认 `""`，最多 256 字符；`inputs` 默认 `{}`。`workflow:<流程ID>` 表示调用独立子工作流 |

### 5.1 条件、分类及循环体的内部结构

| 对象 | 字段与规则 |
| --- | --- |
| 单条 Condition | `variable`（最多 400 字符）、`operator`、可选 `value`（最多 400,000 字符） |
| Condition.operator | `contains`、`not_contains`、`equals`、`not_equals`、`not_empty`、`empty`、`starts_with`、`ends_with`、`gt`、`gte`、`lt`、`lte` |
| `cases` 项 | `id`、可选 `logic: "and" / "or"`、`conditions`（1–30 条）；整个 `cases` 最多 20 项 |
| `logicGate` | `operator` 为 `IF`、`AND`、`OR`、`NOT`、`NAND`、`NOR`、`XOR`、`XNOR`；`inputs` 为 1–32 项，每项含 JSON `value` 和可选 `predicate: "boolean" / "truthy" / "falsy" / "nonEmpty"`。还会按运算符检查输入数量等规则 |
| `body` | `{ "nodes": [...], "edges": [...] }`，字段结构与主图一致；内部图不能再直接增加 `notes`、`editor` 等工作流级字段 |

`logicGate` 与非空 `cases` 不能同时配置。分类、人工操作和条件出口的身份必须保持唯一。分支标签只用于显示，连线使用出口 ID。

### 5.2 WorkflowSubagent：身份、角色与节点任务

共享角色放在工作流内，节点保存具体任务与身份引用。字段大小写固定为工作流的 `subAgents` 和节点的 `subagentId`。

| 字段 | 类型 | 含义、限制与导入规则 |
| --- | --- | --- |
| `id` | string | 必需，格式同流程 ID；工作流内唯一。导入、另存为生成新身份，所有节点的 `config.subagentId` 同步改写 |
| `number` | string | 必需，形式为 `agent-1`、`agent-2` 等，正整数编号，最多 100 字符；工作流内唯一，导入保留，不与节点 `number` 混用 |
| `name` | string | 必需，去除首尾空白后 1—100 字符；工作流内唯一，导入保留 |
| `prompt` | string | 必需，0—100,000 字符；子 Agent 的角色提示词快照，空字符串表示不额外设置角色。保存与导出完整正文 |
| `sessionId` | string | 本地可选绑定，表示所属主对话；导出、导入与另存为均移除，目标环境重新建立绑定。不是可移植的会话授权 |
| `rolePresetId` | string | 本地可选，记录选择角色预设的来源；导出和导入移除，运行不依赖原预设存在 |
| `rolePresetRevision` | integer | 本地可选，来源预设的非负版本；与来源 ID 一并移除，便于本地提示“更新预设内容” |

`subAgents` 是角色定义表，`workflows` 是独立子工作流集合，两者不可互换。绑定某个定义的多个 Agent 节点共享它的角色提示词，但每个节点保留自己的任务 `config.prompt`、输入、工具、模型与执行限制。

下面是结构片段，需放入第 3 节所述的完整 Workflow 中：

```json
{
  "subAgents": [
    {
      "id": "research-agent",
      "number": "agent-1",
      "name": "资料分析员",
      "prompt": "根据提供的资料整理事实，区分原文信息与推断。"
    }
  ],
  "nodes": [
    {
      "id": "analysis-node",
      "number": "a-2",
      "kind": "agent",
      "title": "分析资料",
      "x": 400,
      "y": 180,
      "fixed": false,
      "config": {
        "subagentId": "research-agent",
        "prompt": "请分析：{{input.text}}",
        "tools": [],
        "maxSteps": 6
      }
    }
  ]
}
```

角色 `subAgents[].prompt` 作为字面角色文本，不展开节点或环境变量；节点的任务 `config.prompt` 沿用变量模板规则。看似读取 Secret 的 `{{env.<密钥ID>}}` 也会被拒绝，不能把密钥插入角色或任务。

选择预设会复制提示词；预设库之后的修改不会自动跟随。点击“更新预设内容”才显式更新本地快照。直接修改角色文本会转为自定义文本。启动运行时再次冻结本次角色，不改已开始的任务。

一个可复用定义不等于一个可继续的原生任务。运行记录中的 `subagentDefinitionId` 指向这个定义；原有 `NodeExecution.subagentId` 仍是该次原生任务的 ID，二者不会写进同一个字段。运行记录不是导出定义的一部分，每次执行创建独立原生任务。

### 5.3 子 Agent 定义与缺失配置

Agent 节点只使用 `subagentId` 引用工作流内定义。导入、打开、保存和 Host 绑定不把节点预设字段转换为定义，也不因缺少引用自动创建身份。JSON 解析本身不建立主对话绑定。

| 当前配置情况 | 处理规则 |
| --- | --- |
| 尚未填写 `subagentId` | 保留节点任务、模型、工具和限制，列为待配置；用户选择或新建定义后才能运行 |
| 已有有效 `subagentId` | 保留已有定义及节点引用，不重复创建身份；不能把同名但不同 ID 的角色自动合并 |
| 已有 `subagentId`，但清单中没有对应定义 | 保留为可导入、可保存的待配置节点；运行前必须在卡片重新选择或创建定义 |
| Agent 节点携带 `config.rolePresetId` | 不属于当前 Agent 配置，拒绝解析；是否同时有 `subagentId` 不影响拒绝结果 |

上述规则同样适用于循环和迭代内部的 Agent 节点。需要复用时，由用户在卡片中选择同一个定义。清单放在所属 Workflow 顶层，不能放进 `config.body`。独立子工作流有自己的定义表，不能引用调用方的定义 ID。

角色正文是随工作流携带的公开配置，主 Agent 可以读取；不能将 API 密钥放入 `subAgents[].prompt` 或节点任务提示词。子 Agent 预设来源在导出时清除后，其角色正文已完整保留，不需要再依赖顶层 `presets[]` 中的同一预设；顶层预设集合用于 `llm`、`classifier`、`extractor`、`document` 的合法预设引用。

### 5.4 定义 ID 与执行任务 ID 的区别

| 位置 | 指向什么 | 能否放入导入导出包 |
| --- | --- | --- |
| `workflow.subAgents[].id` | 工作流内角色定义 | 可以；导入时重建 |
| `workflow.nodes[].config.subagentId` | 上述定义 ID | 可以；跟随定义映射 |
| `run.executions[].subagentDefinitionId` | 本次执行使用的冻结定义 ID | 不可以；只在运行记录中 |
| `run.executions[].subagentId` | 本次实际创建的 Harness 原生任务 | 不可以；不能用于恢复另一台设备的会话 |

例如，两个节点都可以设置 `config.subagentId: "research-agent"`，各自使用不同任务提示词。执行时它们分别创建原生任务，运行记录的 `subagentDefinitionId` 相同、实际 `subagentId` 不同。相同定义代表角色配置复用，不自动继承前一次任务的对话记忆。

以下仅是运行记录字段片段，不能直接添加到 Workflow 或节点 `config`：

```json
{
  "nodeId": "analysis-node",
  "subagentDefinitionId": "research-agent",
  "subagentId": "native-task-for-this-execution"
}
```

## 6. 便签、视口和节点批注

### 6.1 CanvasNote

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 唯一便签身份 |
| `text` | string | 便签文字，最多 20,000 字符 |
| `x`、`y` | number | 有限坐标 |
| `width`、`height` | number | 可选。宽 160–1,200，高 100–900；未指定时由画布默认展示 |
| `color` | string | 可选：`yellow`、`blue`、`green`、`purple`、`neutral` |
| `anchorNodeId` | string | 可选，当前主画布节点 ID。解析发现挂靠节点已不存在时，解除挂靠并保留便签 |

便签不会作为执行节点。挂靠关系只是画布关联。

### 6.2 Workflow.editor

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `viewport` | object | 可选，`x`、`y` 表示视角平移，`scale` 表示缩放；坐标有限，缩放范围 0.1–4 |
| `scopePath` | string[] | 可选，从主图逐层进入容器的节点 ID 路径，最多 5 层；每一级必须是存在且有内部图的容器 |
| `annotations` | array | 可选，最多 200 条普通节点批注 |

每条批注包含 `id`、正整数 `number`、`nodeIds`、`text`，可选 `position`。`nodeIds` 最多 500 项，必须存在、不能重复；`text` 最多 20,000 字符。`position` 包含有限的 `x`、`y` 和有效的 `scopePath`。

导入会生成新的批注 ID，并同步更新节点关联与容器路径。不会把旧会话身份、发送状态、回执或授权一起导入。批注文字由用户自行填写，分享前仍应检查是否写入了私人信息。

## 7. 环境变量、系统变量与 Secret

### 7.1 环境变量声明

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 稳定引用身份；引用写成 `env.<id>`，重命名不改变它 |
| `name` | string | 展示名称，最多 80 字符，以字母或下划线开头，后续允许字母、数字、下划线 |
| `type` | string | `string`（字符型）、`number`（数字型）、`secret`（密钥）；三种在界面中显式提供 |
| `description` | string | 可选，最多 2,000 字符 |
| `required` | boolean | 可选，是否要求运行前配置 |
| `revision` | integer | 可选，非负；导入后归零 |
| `value` | string / number | 只允许普通变量；必须符合 `type`。字符串最多 400,000 字符，数字必须有限 |

同一流程的变量 ID 和名称分别不能重复。缺省 `value` 表示未配置；`""` 和 `0` 是已经提供的合法值，不等同于缺省。被实际节点引用的未配置普通变量也需要处理，不能仅凭 `required` 未勾选就认为可运行。未使用且非必需的变量可以保留未配置。

数字型的值必须是 JSON 数字，例如 `0` 或 `3.5`；`"0"` 是字符串，不能作为数字型的值。未配置时省略 `value`，不要写 `null`，也不要把界面中文类型名写入 `type`。

字符型与数字型可被 Agent 读取、传入提示词和工具；只有密钥受隔离保护。普通类型不因 Secret 存储组件不可用而禁用。界面入口为左工具栏“高级设置 → 环境变量”。

Secret 不允许携带 `value`、`binding`、`ciphertext`、`state` 等额外字段。导入新流程、覆盖旧流程及包内子流程时都重建 Secret 声明身份，目标端必须独立配置，不会复用源端或被覆盖流程的凭据绑定。导出、导入均不把 Secret 当普通字符串处理，也不将它放入 Agent 提示词或普通输出。

### 7.2 Secret 的受控用途

当前 HTTP 节点提供受控凭据模式：

`credentialOperation` 包含 `secretVariableId` 和 `operationId`；前者必须指向此流程声明的 Secret，后者当前只支持 `deepseek.account-status.v1`。它是限定用途的操作声明，不是任意 HTTP 密钥插值接口。

受控模式不能同时携带普通 HTTP 的 `url`、`method`、`headers`、`bodyText`、`inputs`、`timeoutMs`。原生代理在目标环境管理凭据并核验授权。JSON 不携带真实密钥，不允许文件中的某个布尔值绕过本地配置或认证。

如果目标宿主无法核验受保护通道或该 Secret 的配置状态，流程保持待处理，不能回退到网页明文输入。普通环境变量面板也不是存储 API 密钥的替代入口。

### 7.3 系统变量

系统变量在 JSON 中仅以引用出现，不存在可由用户导入的 `systemVariables` 值表。

界面将此页放在“高级设置 → 全局变量”。这是原 `sys` 系统变量的展示入口名称，JSON 命名空间及只读含义不变。

| 引用 | 类型 | 来源 |
| --- | --- | --- |
| `sys.workflow_id` | string | 当前目标工作流身份 |
| `sys.workflow_run_id` | string | 本次运行身份 |
| `sys.workspace_id` | string | 目标工作区身份 |
| `sys.session_id` | string / null | 发起运行的可信会话，没有会话时为 null |
| `sys.timestamp` | number | 运行开始时的 Unix 秒数 |

`sys.user_id`、`sys.app_id` 当前尚无受支持的可信映射，不能据其他产品截图推断本项目已经支持。环境变量与系统变量只读，输入、赋值和模板局部变量不能覆盖 `env`、`sys` 命名空间。

## 8. 执行策略 executionPolicy

| 字段 | 类型 / 范围 | 含义 |
| --- | --- | --- |
| `repairMode` | `confirm` / `auto` | 输出修复方式；独立运行默认先确认，自动模式仍须宿主可信授权 |
| `maxConcurrentAgents` | integer，1–8 | 运行模型活动的并发上限，也用于每层 Graphon worker 数，默认 3；该层有人工或赋值节点时 worker 为 1；模型还受共享准入限制 |
| `maxAgentTasks` | integer，1–1,000 | 已退役字段，仅只读兼容且不生效；旧值不再限制任务数，不为新图生成 |
| `tokenBudget` | integer，1–100,000,000 | 已退役字段，仅只读兼容且不生效；旧值不再限制 Token 用量，不为新图生成 |
| `perTaskTokens` | integer，1–1,000,000 | 已退役字段，仅只读兼容且不生效；旧值不再预留 Token 或限制输出，不为新图生成 |
| `maxRepairAttempts` | integer，0–2 | 每节点累计修复次数上限，默认 2；0 表示关闭；根图与当前图共同约束 |

全部可选。新图仅使用 `repairMode`、`maxConcurrentAgents` 和 `maxRepairAttempts`，高级设置也只提供这三项。实际 Token 用量与未知用量调用仅作性能计量，不参与调用准入。宿主权限、并发、步数、循环、超时和有限修复保护仍有效。

表中的已退役字段类型和范围仅用于解析旧图，不代表仍存在对应控制；检测到这些字段时提供非阻断兼容提示，不影响图保存或执行。不要为新图填写或生成这些字段，也不要使用 `0`、`-1`、`null` 或字符串作为其数值哨兵值，旧数据仍须通过原有类型校验。

### 8.1 历史元数据 budgetDecision（只读兼容）

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `mode` | `limited` / `unlimited` | 旧记录的模式枚举，仅只读保留；两种值均无执行控制或授权作用 |
| `decidedAt` | string | 旧记录必需的 ISO 日期时间，仅只读保留，不触发问答或配置更新 |

`budgetDecision` 已退役。旧图可读取并保留该对象，新图不生成；规划与对话入口不再进行对应问答。该对象不改变任何现行执行策略，也不能授予权限。兼容读取不批量改写已有图或运行，详见[资源保护与并发的旧数据兼容](../规划引擎/07-资源保护与并发.md#旧数据兼容)。

手动/自动保存及保存间隔属于当前客户端的设置，不写入这份 JSON；当前默认自动保存，每 5 分钟保存有变化的流程。

### 8.2 旧字段的只读兼容与新图规则

| 场景 | 历史元数据与已退役字段 | 当前行为 |
| --- | --- | --- |
| 读取已有图 | 保留 `budgetDecision` 和 `executionPolicy.tokenBudget/perTaskTokens/maxAgentTasks` | 只读兼容且不生效；不批量改写文件 |
| 导入、导出或另存为旧图 | 允许随流程定义保留原值 | 保留不代表恢复控制；不携带旧运行用量、运行快照或授权 |
| Agent 修改已有图 | Host 保留原图执行策略与历史元数据 | 模型不能改写；其中已退役字段仍不生效 |
| Agent 生成新图 | Host 去除模型提交的上述历史字段 | 新图不生成这些字段，现行策略由宿主控制 |
| 高级设置保存 | 仅编辑输出修复方式、并发上限和修复轮次上限 | 已有历史字段只读保留，没有编辑入口 |

旧运行状态 `budget_waiting` 不属于本流程定义交换格式；运行详情将其显示为“旧运行已暂停”，仍可按暂停条件继续或停止。新运行不产生此状态，读取旧记录不批量改写数据。实际用量记录见[运行记录与版本](08-运行记录与版本.md)。

## 9. 角色、依赖和独立子流程

### 9.1 RolePreset

角色预设必需字段为 `id`、`name`、`prompt`、`revision`。`name` 为 1–100 字符，`prompt` 最多 100,000 字符，`revision` 为非负整数。包内角色身份不能重复。

可选 `summary` 为最多 240 字符的概述；`scope` 仅为 `global` 或 `workflow`，缺省等同 `global`。`scope: "workflow"` 必须同时提供所属流程 `workflowId`；全局预设不得带 `workflowId`。局部预设只能由其所属流程使用，不能通过手写引用或导入映射跨流程访问。

完整导出保留随包流程各自的局部预设库（包括尚未被节点引用的预设），不携带其他流程的局部角色；片段模板只保留片段实际使用的预设。复制和导入同时重建角色身份与 `workflowId`，覆盖导入则归属覆盖目标。

随包角色导入时创建新身份，所有对应 `rolePresetId` 一起更新。未附带且未在目标环境匹配到的角色不会被虚构，也不会导致节点丢失；其引用保留为待处理项。

### 9.2 Dependency

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `kind` | string | `model`、`tool`、`workflow`、`file`、`role` |
| `id` | string | 依赖标识，最多 512 字符。模型通常为 `provider/model`，独立流程为 `workflow:<id>` |
| `label` | string | 展示说明，最多 1,000 字符 |

导出会从实际节点配置生成清单。目标宿主仍从节点配置重新计算依赖，并读取真实模型、工具、角色、流程和文件目录；删掉清单中的某一项不能让缺失资源变成可用。

依赖的匹配结果、用户选择的导入映射和当前 `canRun` 状态不属于可授权的包内字段。运行前会再次核对，避免把旧导入检查当成永久保证。

外部固定资料必须在启动前可读取。若某个资料路径恰好是当前节点的上游依赖通过 `verification.requiredFiles` 或 `verification.requiredChangedFiles` 声明的产物，可以由上游在本次运行中提供；这时仍检查工作区路径与父目录边界，执行到读取节点时继续验证实际文件。兄弟支路、下游节点或不同路径的产物声明，不能解除当前资料缺失提示。运行时输入和用户上传的附件另由运行入口收集。

### 9.3 workflows 与 body 的区别

- `body` 属于当前循环或迭代节点，是当前流程的一部分，直接保存内部节点和连线。
- `workflows` 是独立工作流定义，供 `toolId` 或 Agent 的 `tools` 中的 `workflow:<id>` 调用。
- 导出收集当前工作区中能找到、未归档且被调用的子流程，继续收集它们的依赖。同一个子流程只收一次，不会把整个工作流库打包。
- 导入主流程、随包子流程和角色时作为一组写入；所有包内调用更新为目标环境中的新 ID。
- 未找到的外部目标保留原调用要求，导入后提示配置。随包定义之间的循环调用会拒绝导入；运行时还会核对调用层数、输入参数及子流程自身的配置。

### 9.4 本机文件字段与保留键

JSON 导出及所有 JSON/ZIP 导入都会清理本机文件授权，不能通过省略 `dependencies` 绕过。规则如下：

- 节点 `source`、`sources` 中的绝对路径置空；文件验证字段中的绝对路径改为需要重新绑定的占位值。
- 递归遍历 `config.inputs`、`initialVariables` 和每条 `assignments.value`：移除保留键 `workflowFileId`、`base64`，将保留键 `path` 的绝对路径值置空。
- `file`、`files` 类型输入字段的 `defaultValue` 移除；由目标环境重新选择或上传文件。

上述容器中的同名业务 JSON 键也会被处理，应改用其他字段名。这是明确的文件引用清理，不是对所有字符串的敏感信息识别；普通提示词、批注和 ZIP 资料正文不会因此被扫描或改写。ZIP 中获准附带的公开资料通过附件清单与实际字节单独迁移。

## 10. 完整 ZIP 流程包

完整流程包仍使用同一份 `workflow.json` 作为流程定义，另外增加 `attachments.json` 和 `files/` 中的实际资料。

```text
流程.workflow.zip
├── workflow.json
├── attachments.json
└── files/
    ├── 1/参考资料.txt
    └── 2/产品说明.md
```

### 10.1 attachments.json

顶层固定为 `format: "dsh-workflow-attachments"`、`version: 1`，`files` 为附件数组，最多 200 项。每项字段如下：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `workflowId` | string | 文件槽位所属的主流程或随包子流程 ID |
| `nodeId` | string | 该流程内引用附件的节点 ID |
| `field` | string | `source`、`sources`、`requiredReadFiles` |
| `index` | integer | 数组字段的零起始位置；`source` 不允许带此字段，数组字段必须带 |
| `name` | string | 清单校验允许 1–255 字符；实际导出和落盘先替换不安全字符，再按最多 180 个 UTF-8 字节截断，避免中文长文件名超出文件系统限制 |
| `path` | string | ZIP 内的资料路径，位于 `files/` 下，最多 512 字符 |
| `size` | integer | 文件字节数，必须与实际内容一致 |
| `sha256` | string | 64 位小写十六进制内容摘要，必须与文件实际内容一致 |

目前附带文档节点的固定来源、知识节点的资料文件，以及 `requiredReadFiles` 所声明的阅读资料。运行时用户上传的附件、模型服务、工具实现及之前生成的输出文件不在此范围。

### 10.2 文件大小与目标位置

| 项目 | 上限 |
| --- | --- |
| `workflow.json` | 8,000,000 字节，UTF-8 字节数 |
| 单个资料文件 | 8,000,000 字节 |
| 资料总大小 | 16,000,000 字节 |
| ZIP 文件 | 32,000,000 字节 |
| ZIP 项目数 | 最多 202 项：两个说明文件加最多 200 个资料文件 |

导出只读取当前工作区内允许读取的普通资料文件。读取失败会说明具体流程、节点和原因，用户仍可改用 JSON 导出，稍后重新选择文件。

如果资料由上游节点在运行时生成、导出时还不存在，JSON 可以保留产物声明和读取关系。当前 ZIP 导出需要读取实际资料，因此会提示改用 JSON，不会凭空生成附件，也不会把这种未生成产物悄悄当成已附带文件。JSON 导入后的运行前检查仍按第 9 节的上游产物规则判断。

导入会验证 ZIP 路径、重复项、大小、CRC 和内容摘要，拒绝加密项、链接、越界路径、未声明文件等。资料写入目标工作区中新建的 `workflow-assets-<随机ID>/` 目录，文件槽位改成该目录中的相对路径。落盘名称由序号前缀与经过 180 UTF-8 字节限制的安全文件名组成；该限制针对文件名，不改变文件内容。不会沿用原电脑绝对路径，也不会覆盖目标工作区已有文件。

资料写入或后续导入失败时，会清理本次新建资料目录；不会把新目录路径当成原机器上的文件授权。

## 11. 身份、引用与导入校验

### 11.1 导入为什么要重建 ID

导入相同文件两次应得到互不覆盖的新流程。因此流程、节点、连线、环境变量、子 Agent 定义、随包角色、便签和普通批注会生成新的身份。节点显示编号可以重新排列；子 Agent 的独立展示编号保留。

所有有效引用一起更新：连线端点、普通节点变量引用、`env.<id>`、`rolePresetId`、`subagentId`、`credentialOperation.secretVariableId`、便签挂靠、批注节点、容器路径以及包内 `workflow:<id>`。

节点、环境变量、子 Agent 定义和角色使用独立身份映射。即使它们的原始 ID 都叫 `same`，也不会混绑。`env`、`sys`、`input` 等引用根不会被当成普通节点重命名；引用中后面的业务属性名也不会误改。

重写只作用于执行器会解析的引用位置。代码正文、普通说明、普通 JSON 字面量和引号中的文本保持不变；模板具名输入及 `for` 局部变量遵守各自作用域。不能依靠全文件字符串替换来修改节点身份。

### 11.2 缺失值与损坏结构的区别

| 情况 | 导入/保存行为 | 运行行为 |
| --- | --- | --- |
| 模型、工具、外部角色、子 Agent 定义或文件尚未配置 | 保留节点及配置要求，可导入画布、继续保存 | 当前宿主检查后列为待处理，未解决前禁止运行 |
| 普通变量已声明但未填写值 | 保留声明，可导入与保存 | 被引用或标记必需时阻止运行 |
| 运行时上传文件、运行输入待提供 | 保存字段要求 | 启动时向用户收集，不能复用原文件的上传授权 |
| JSON 语法错误、未知节点、字段类型错误 | 拒绝导入并指出问题 | 不进入执行 |
| 不受支持的包版本或 Agent 节点 `config.rolePresetId` | 拒绝导入，不自动迁移 | 不进入执行 |
| 连线指向不存在的节点、非法出口、重复身份或普通连线环 | 拒绝导入 | 不通过“待填写”跳过结构约束 |
| 伪造系统值、Secret 明文或不允许的 Secret 引用 | 拒绝 | 不因导入草稿而放宽隔离规则 |

缺失配置红色三角和右侧清单由宿主重新计算。不会将文件中某个 `ready: true` 当成检查结论。关闭画布后重新打开，还会依据保存的定义和当前宿主资源重新检查。

### 11.3 限制与保证范围

导入与导出共用 8 MB、JSON 最多 32 层、安全字段、结构和集合数量限制。数据结构校验、包内关系校验、宿主依赖检查与实际运行是不同步骤：一个文件可以格式正确，也可以是仍待配置的流程。

这些检查不证明提示词会产生正确答案、第三方工具必定成功、远端服务永远可达，或任意文件内容都能解析。具体能力由目标 Harness、节点适配器和当前资源决定。

## 12. 两份完整的可导入示例

### 12.1 无模型依赖的基础示例

下面的当前格式示例包含输入、模板、输出三个节点，节点坐标、一张便签、普通环境变量、画布视角和一条批注。不依赖模型或工具。导入后流程身份会更新，`region` 的引用也会同步更新。

这个例子主动包含普通变量值；界面默认导出时不会带该值，用户需要勾选相应选项或在导入后填写。

```json
{
  "format": "dsh-visible-workflow",
  "formatVersion": 2,
  "runtime": { "engine": "graphon", "protocol": 1 },
  "workflow": {
    "id": "example-flow",
    "workspaceId": "import-required",
    "title": "JSON 导入示例",
    "description": "输入文本，加上地区说明后输出。",
    "revision": 0,
    "createdAt": "2026-10-17T00:00:00.000Z",
    "updatedAt": "2026-10-17T00:00:00.000Z",
    "nodes": [
      {
        "id": "start",
        "number": "a-1",
        "kind": "input",
        "title": "输入文本",
        "x": 80,
        "y": 160,
        "fixed": false,
        "config": {
          "fields": [
            { "name": "text", "label": "文本", "required": true, "type": "text" }
          ]
        }
      },
      {
        "id": "format-text",
        "number": "a-2",
        "kind": "template",
        "title": "整理内容",
        "x": 400.5,
        "y": 160,
        "fixed": false,
        "config": { "text": "地区：{{env.region}}\n内容：{{input.text}}" }
      },
      {
        "id": "finish",
        "number": "a-3",
        "kind": "output",
        "title": "输出结果",
        "x": 720,
        "y": 160,
        "fixed": false,
        "config": { "text": "{{format-text.text}}", "outputName": "result" }
      }
    ],
    "edges": [
      { "id": "edge-1", "source": "start", "target": "format-text" },
      { "id": "edge-2", "source": "format-text", "target": "finish" }
    ],
    "notes": [
      {
        "id": "note-1",
        "text": "地区从环境变量中读取。",
        "x": 400,
        "y": -60,
        "width": 280,
        "height": 160,
        "color": "yellow",
        "anchorNodeId": "format-text"
      }
    ],
    "environmentVariables": [
      { "id": "region", "name": "REGION", "type": "string", "required": true, "value": "中国" }
    ],
    "editor": {
      "viewport": { "x": 32, "y": 40, "scale": 1 },
      "scopePath": [],
      "annotations": [
        {
          "id": "annotation-1",
          "number": 1,
          "nodeIds": ["format-text"],
          "text": "后续可修改这里的输出措辞。",
          "position": { "x": 450, "y": 320, "scopePath": [] }
        }
      ]
    }
  },
  "workflows": [],
  "presets": [],
  "dependencies": []
}
```

### 12.2 子 Agent、普通变量与执行策略示例

下面是包含子 Agent、普通变量与现行执行策略的完整导入文件，不包含已退役字段。它显式携带普通变量值；Secret 只有一个未使用、非必需的声明，没有 `value`。角色正文已经随 `subAgents[]` 保存，因此 `presets` 可以为空；没有显式模型覆盖，因此 `dependencies` 也为空，目标宿主仍必须提供可用模型，空依赖清单不代表无需检查运行环境。

导入后会重建节点、子 Agent 与变量 ID，任务中的 `env` 和输出节点引用随之更新；角色正文、展示编号、执行策略和坐标保留。这个示例用于当前格式与导入身份映射说明，不代表模型一定按提示词产出正确内容。

```json
{
  "format": "dsh-visible-workflow",
  "formatVersion": 2,
  "runtime": {
    "engine": "graphon",
    "protocol": 1
  },
  "workflow": {
    "id": "agent-example-flow",
    "workspaceId": "import-required",
    "title": "子 Agent 与执行策略示例",
    "description": "共享角色与节点任务分开保存，包含普通变量和未使用的 Secret 声明。",
    "revision": 0,
    "createdAt": "2026-10-17T00:00:00.000Z",
    "updatedAt": "2026-10-17T00:00:00.000Z",
    "nodes": [
      {
        "id": "start",
        "number": "a-1",
        "kind": "input",
        "title": "输入资料",
        "x": 80,
        "y": 180,
        "fixed": false,
        "config": {
          "fields": [
            {
              "name": "text",
              "label": "待整理资料",
              "required": true,
              "type": "text"
            }
          ]
        }
      },
      {
        "id": "analysis-node",
        "number": "a-2",
        "kind": "agent",
        "title": "分析资料",
        "x": 400,
        "y": 180,
        "fixed": false,
        "config": {
          "subagentId": "research-agent",
          "prompt": "按 {{env.style}} 风格分析资料：{{input.text}}。附加示例数：{{env.extra-count}}。",
          "tools": [],
          "maxSteps": 6,
          "outputSchema": [
            {
              "name": "text",
              "type": "string",
              "required": true
            }
          ]
        }
      },
      {
        "id": "finish",
        "number": "a-3",
        "kind": "output",
        "title": "输出结果",
        "x": 720,
        "y": 180,
        "fixed": false,
        "config": {
          "text": "{{analysis-node.text}}",
          "outputName": "result"
        }
      }
    ],
    "edges": [
      {
        "id": "edge-1",
        "source": "start",
        "target": "analysis-node"
      },
      {
        "id": "edge-2",
        "source": "analysis-node",
        "target": "finish"
      }
    ],
    "notes": [],
    "subAgents": [
      {
        "id": "research-agent",
        "number": "agent-1",
        "name": "资料分析员",
        "prompt": "根据提供的资料整理事实，区分原文信息与推断。"
      }
    ],
    "environmentVariables": [
      {
        "id": "style",
        "name": "OUTPUT_STYLE",
        "type": "string",
        "required": true,
        "value": "简洁"
      },
      {
        "id": "extra-count",
        "name": "EXTRA_EXAMPLES",
        "type": "number",
        "required": true,
        "value": 0
      },
      {
        "id": "optional-api-key",
        "name": "API_KEY",
        "type": "secret",
        "required": false,
        "description": "仅演示声明；本示例未引用此密钥。"
      }
    ],
    "executionPolicy": {
      "repairMode": "confirm",
      "maxConcurrentAgents": 1,
      "maxRepairAttempts": 2
    },
    "editor": {
      "viewport": {
        "x": 30,
        "y": 20,
        "scale": 0.75
      },
      "scopePath": [],
      "annotations": [
        {
          "id": "annotation-1",
          "number": 1,
          "nodeIds": [
            "analysis-node"
          ],
          "text": "角色在子 Agent 清单中，任务在节点中。",
          "position": {
            "x": 420,
            "y": 105,
            "scopePath": []
          }
        }
      ]
    }
  },
  "workflows": [],
  "presets": [],
  "dependencies": []
}
```

## 13. 实现与验证入口

既有格式与往返验证覆盖定义 ID 映射、任务中的普通变量引用、数字 `0`、坐标/视口/批注保留，以及默认导出移除普通值、显式带值导出仍不携带 Secret 值。本次按当前源码更新现行策略与旧字段只读兼容说明；4 个 JSON 代码块语法通过，第 12 节两份完整示例均不包含已退役字段。本次未重新运行模型或往返测试，语法检查不代表模型调用验收。

- [当前 JSON 格式、导出与身份映射](../../../src/shared/workflow-format.ts)
- [工作流、20 类节点和编辑信息的校验](../../../src/shared/workflow-validation.ts)
- [环境变量与系统变量声明](../../../src/shared/workflow-variables.ts)
- [Host 导入依赖匹配](../../../src/host/workflow-import.ts)
- [Host 运行前待处理检查](../../../src/host/workflow-readiness.ts)
- [ZIP 文件与资料清单](../../../src/host/workflow-package-archive.ts)
- [20 类节点、坐标、批注、子流程和身份冲突往返测试](../../../tests/workflow-json-roundtrip.test.ts)
- [格式、环境变量与存储测试](../../../tests/workflow-v2-format-storage.test.ts)
- [子 Agent 身份、主对话绑定与预设快照](../../../src/shared/workflow-subagents.ts)
- [现行策略与旧字段只读保留](../../../src/shared/types.ts)、[Host 保存边界](../../../src/host/index.ts)
- [子 Agent 提示词、绑定与导入身份回归](../../../tests/workflow-subagents.test.ts)
- [执行策略设置](../../../src/client/execution-policy.tsx)、[运行用量与共享并发](../../../src/host/run-usage.ts)
- [本轮保存、菜单与身份迭代及待实机项](../验证/11-保存高级设置与子Agent定义迭代.md)

相关：[导入导出操作](../交互/23-JSON导入导出与待处理.md) · [变量与稳定身份](07-变量与稳定身份.md) · [画布便签](../交互/18-便签与节点连接.md) · [节点批注](../交互/17-节点批注与聊天草稿.md)
