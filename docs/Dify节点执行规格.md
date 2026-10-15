# Dify 节点、数据与执行对齐规格

| 项目 | 基线 |
| --- | --- |
| 阅读日期 | 2026-10-14 |
| 手册范围 | Dify 官方滚动手册英文 Cloud 与 Self-Host 的 Workflow / Chatflow 节点目录、起点、触发、人工输入、执行与调试正文 |
| 固定代码参照 | [Dify 1.17.1](https://github.com/langgenius/dify/tree/1.17.1)，用于核对节点类型和部分字段；不声称已逐行审计执行器 |
| 文档状态 | 对齐要求和开发验收规格，所有验收均未执行；不是功能已经实现的报告 |
| 与主 PRD 的关系 | 用户已确认的独立执行、Agent 授权、固定节点、模型强度、提示词预设及运行快照优先；差异必须显式记录 |

本文使用三种标签：**官方**是已读正文或固定版本代码中的事实；**项目要求**是落实用户全面对标后的功能要求；**项目补齐**是为交互与执行一致性补充的设计，不能反称为 Dify 原有规则。目录覆盖不等于某一部署环境已启用全部能力；Cloud 配额和自部署环境变量不能混用。

## 1 覆盖总表与不能遗漏的变化

官方节点目录的 18 项，加上 User Input、Human Input，全部在下表映射；Agent 分为 Classic / New 两项，Loop 正文中的 Exit Loop 单独列项。共 **22 个 NODE 项、6 个 TRG 项、10 个 DATA 项、12 个 EXEC 项**。Start 与 Trigger 的总览属于起点规则，不伪装成额外执行节点。Iteration Start、Loop Start 等自动生成结构标记在 DATA10 列出。

重要对齐规则：

- **Output 原名 End，现在可选，也不是“立即停止整个流程”的节点。** 无 Output 的运行可以成功但不返回结果；执行过的多个 Output 共同组成输出。
- **变量聚合器用于互斥分支**，并行分支的结果合并用 Code 或 Template 等后续处理节点。
- **User Input 与自动触发起点互斥**；触发型流程支持多个触发入口，Schedule 最多一个。
- **Human Input 是运行中的等待节点**；不能用运行前补参询问框替代它，也不能因为主 Agent 未启动就不可用。
- **重试原节点与 Agent 修改流程后修复是两层机制**。后者默认两轮，不等于把 Dify 节点重试次数也改为两次。
- 手册已包含 **New Agent beta**、模型配置环境变量、JSON Schema 输入、人工输入文件字段等；不能只按较早截图实现。

## 2 节点规格

每项的验收样例同时要求：画布可配置、保存后再打开不丢失、独立执行可运行、Agent 调用使用相同执行语义、错误能定位到稳定节点身份。表中“输入”与“输出”是产品级数据契约，不宣称为 DeepSeekHarness 已存在的 API 字段。

### NODE01 用户输入 User Input

- **输入与配置：** 每张图最多一个；字段有名称、用户标签、类型、必填；支持短文本、段落、选项、数字、复选框、JSON 对象及可选 Schema、单文件、文件列表。支持非文件字段隐藏并预填，与必填互斥，可设默认值。
- **输出：** 配置的具名输入；Chatflow 有 `userinput.query`；`userinput.files` 在 Workflow 为遗留兼容字段，新增流程优先具名文件字段。
- **边界：** 短文本手册上限 256 字符，段落无该长度限制；文件输入只收集文件，不解析内容。隐藏值不是秘密，不用于保存密钥。缺必填、类型或 Schema 不符时不开始运行。
- **验收：** 文本、布尔、JSON 和文件组合输入能被下游引用；已有输入不重复询问；缺项弹出用户已确认的询问框，补齐后继续同次调用。
- **来源：** [User Input](https://docs.dify.ai/en/cloud/use-dify/nodes/user-input)。

### NODE02 大语言模型 LLM

- **输入与配置：** 模型提供方/模型/支持的生成参数；直接配置或引用 LLM 类型环境变量；Chat 模型的 System/User/Assistant 消息、Completion 文本；变量和 Jinja2；检索上下文；视觉文件与细节档；结构化输出可视编辑、JSON Schema、AI 辅助生成；Chatflow 节点记忆。
- **输出：** 文本、结构化结果及模型实际返回的文件；支持流式输出。支持推理标签分离时将答案与 `reasoning_content` 分开，不要求模型提供其未公开的内部思考。
- **边界：** 供应商/模型能力决定字段；非原生结构化输出不能当作绝对可靠 JSON。空提示、无模型、失效变量、凭据或请求失败需定位。模型失败可走配置的重试/默认值/错误分支。
- **验收：** 一个检索上下文流程、一个 Schema 输出流程、一个多模态流程；用不支持视觉/结构化的模型时给出能力错误，不伪造支持；引用环境模型配置的节点新运行更新、旧运行快照不变。
- **项目要求：** 自动选择沿用主 Agent 模型及强度上限；手动逐节点覆盖；角色预设只注入提示词，不能代替模型配置环境变量。
- **来源：** [LLM](https://docs.dify.ai/en/cloud/use-dify/nodes/llm)。

### NODE03 知识检索 Knowledge Retrieval

- **输入与配置：** 文本查询；至少一个多模态知识库时可图像查询；选择一个或多个知识库；节点层重排、Top K、分数阈值、手动/自动元数据过滤。加权重排要求全部知识库为 High Quality；含图像时需适配多模态重排。
- **输出：** `result` 数组，含片段内容、标题、元数据；图像附件通过 `files` 进入结果。
- **边界：** 知识库层检索与节点层筛选是两层配置；普通重排模型可能排除图像。Cloud 查询图片每张不超过 2 MB，自部署可配。不可用知识库、限流、空结果分别处理，空结果不能编造命中。
- **验收：** 两库并检索后重排；元数据限定只命中指定文档；零命中；视觉库返回图像并交给支持视觉的 LLM，来源信息保持。
- **来源：** [Cloud](https://docs.dify.ai/en/cloud/use-dify/nodes/knowledge-retrieval)、[Self-Host](https://docs.dify.ai/en/self-host/use-dify/nodes/knowledge-retrieval)。

### NODE04 输出 Output

- **输入与配置：** 每个 Output 至少一个具名输出，来源是上游变量，可拖动排序；支持字符串、数字、整数、布尔、对象、文件及相应数组。
- **输出：** 所有实际执行的 Output 合并为最终结果；无 Output 的路径可以成功但没有返回数据。
- **边界：** 不停止并行分支。重复输出名后执行覆盖先执行，存在并行顺序差异；作为 Workflow 工具时 `text/files/json` 是保留名。输出定义顺序与执行先后不是同一概念。
- **验收：** 两并行 Output 都保留结果；一个输出先完成不会取消另一分支；无 Output 运行显示“执行完成，无返回数据”；重复名称显示冲突提示并解释兼容行为。
- **来源：** [Output](https://docs.dify.ai/en/cloud/use-dify/nodes/output)。

### NODE05 回答 Answer〔Chatflow 条件能力〕

- **输入与配置：** 固定文字、Markdown、上游变量、图片和文件；允许流程中多个 Answer。
- **输出：** 面向会话的内容流；按回答模板中变量出现的顺序输出，遇到未就绪变量等待。
- **边界：** Dify 仅 Chatflow 使用，Workflow 用 Output；“在聊天中调用一次工作流”不自动变成每条消息触发的 Chatflow。单节点测试不支持 Answer。
- **验收：** 模板 A 后 B 与 B 后 A 的流式等待顺序不同；多 Answer 分阶段交付；会话上下文清晰绑定。
- **项目要求：** 保留节点能力，在有显式会话执行上下文时启用；无会话时说明要求，不静默把普通 Workflow 改成常驻聊天机器人。
- **来源：** [Answer](https://docs.dify.ai/en/cloud/use-dify/nodes/answer)、[Workflow & Chatflow](https://docs.dify.ai/en/cloud/use-dify/build/workflow-chatflow)。

### NODE06 经典智能体 Classic Agent

- **输入与配置：** Function Calling / ReAct 及可安装策略；兼容模型；任务 Query、指令、上游上下文；可用工具、描述、凭据、参数自动生成或手工绑定；最大迭代数、记忆窗口。
- **输出：** 最终回答、工具结果、迭代/状态与结构化 Agent 日志；只展示模型和策略实际提供的执行信息。
- **边界：** 策略不受支持、工具缺失/未授权、参数不合法或迭代上限需区分。一个节点内的工具决策不授权修改画布、固定节点或全局预设。
- **验收：** 两工具完成任务，工具参数一项由模型生成、一项固定；达到迭代上限退出；未选择的工具不能被调用。
- **来源：** [Agent / Classic](https://docs.dify.ai/en/cloud/use-dify/nodes/agent#classic-agent)。官方文中 `auto: false` 对应自动生成的示例命名易误解，产品文案按含义写，工程参数须以选定策略 schema 核对。

### NODE07 新智能体 New Agent〔beta、Workflow〕

- **输入与配置：** 邀请已发布 Agent 或创建节点专用 Agent；任务与能力配置分开；共享 Agent 可跳转管理，转副本后解除跟随；可声明具名输出。能力含模型、提示词、技能、文件、工具及环境配置，运行在独立环境中。
- **输出：** 默认 `text`，另有用户声明的具名值/文件。两个节点使用同一 Agent 时执行环境仍彼此独立，传数据必须声明输出。
- **边界：** 当前手册 beta 且仅 Workflow。文本变量插入当前官方实现截断到 2,000 字符，长内容应传文件；Cloud 返回单文件 50 MB，自部署可配。Agent 管理不是本项目“角色预设”。
- **验收：** 节点专用与共享 Agent 的更新关系不同；两个节点不能互读未传递的运行文件；声明文件能被下游消费；提示词预设仍只能在设置中编辑且不包含模型/工具。
- **项目补齐：** 共享 Agent 及能力在启动时快照，避免本次运行途中被统一更新；本项目文件/沙箱实现与容量可另设计，但差异必须显示，不能只用普通 LLM 节点冒充此能力。
- **来源：** [Agent / New](https://docs.dify.ai/en/cloud/use-dify/nodes/agent#new-agent)、[Build an Agent](https://docs.dify.ai/en/cloud/use-dify/build/new-agent/build)、[1.17.1 类型](https://github.com/langgenius/dify/blob/1.17.1/web/app/components/workflow/nodes/agent-v2/types.ts)。

**关联能力基线：** 官方 Cloud 能力管理支持技能包 `.zip/.skill`（含 `SKILL.md`）、文件、工具及环境变量；当前手册列出 20 GB 环境存储、单次运行 1 小时/500 次模型请求、回复文件 50 MB。构建对话的 Apply/Discard、持久文件与正式运行临时文件属于共享 Agent 能力管理，不能误写为“角色预设”。本项目若复用宿主 Agent，应逐项声明等效能力与不同限额；单独建设 Dify 的 Agents 管理产品不由本节点名称自动推定。

### NODE08 问题分类 Question Classifier

- **输入与配置：** 文本变量、分类模型、类别标题与类别描述、额外分类说明。
- **输出：** 命中类别对应路径；`class_name` 是描述，`class_label` 是画布标题。
- **边界：** 标题与描述独立修改；仅选中的分支执行。正文仍示例 `sys.query`，新 User Input 文档为 `userinput.query`，兼容层需映射，不能产生悬空引用。
- **验收：** 以确定样例分到售后/使用/其他三类；更改画布短标题不改模型收到的详细描述；分类请求失败不能误落到任意分支。
- **来源：** [Question Classifier](https://docs.dify.ai/en/cloud/use-dify/nodes/question-classifier)。

### NODE09 条件分支 If-Else

- **输入与配置：** 上游变量、IF、多 ELIF、ELSE；文本包含/不包含、开头/结尾、相等/不等、空/非空、数值比较；同条件组 AND/OR。
- **输出：** 按顺序匹配的单条路径，未命中使用 ELSE。
- **边界：** 只提供与变量类型兼容的比较，缺失、null 与空值规则必须可测试；不要把并行分叉当互斥判断。
- **验收：** 两个条件同时为真时只走先匹配分支；全部为假走 ELSE；AND/OR 与空值样例结果正确。
- **来源：** [If-Else](https://docs.dify.ai/en/cloud/use-dify/nodes/ifelse)。

### NODE10 迭代 Iteration

- **输入与配置：** 数组、内部子流程、汇集的输出变量；顺序或并行模式；每项可引用当前元素及从 0 开始的 index；并发手册上限 10。
- **输出：** 每项运行结果组成数组；失败模式有终止、保留 null 继续、剔除失败结果。
- **边界：** 内部变量作用域隔离；顺序模式可逐项通过 Answer 流式输出。保留 null 与剔除失败会改变输出对应关系，不能混同。
- **验收：** `[1,2,3]` 中第二项失败，三种策略分别停止、得到 `[r1,null,r3]`、得到 `[r1,r3]`；并行不超配置并发，空数组不调用内部节点。空数组行为为项目补齐测试。
- **来源：** [Iteration](https://docs.dify.ai/en/cloud/use-dify/nodes/iteration)。

### NODE11 循环 Loop

- **输入与配置：** 循环变量与初始值、内部流程、终止条件、最大次数。
- **输出：** 随轮次更新的循环变量，结束后对外可读。
- **边界：** 每轮依赖上一轮，不能用无状态并行 Iteration 替代。满足终止条件、到最大次数或触发 Exit Loop 任一条件退出；未设条件时仍受次数上限约束。未被处理的子节点错误终止循环。
- **验收：** 计数/改写流程跨轮保留状态，条件提前满足停止；永不满足时到上限停止；每轮输出和错误可追溯。
- **来源：** [Loop](https://docs.dify.ai/en/cloud/use-dify/nodes/loop)、[Handle Errors](https://docs.dify.ai/en/cloud/use-dify/build/predefined-error-handling-logic)。

### NODE12 退出循环 Exit Loop

- **输入与配置：** 在 Loop 内的指定控制路径插入退出节点。
- **输出与边界：** 命中后终止所属循环；不等于取消整个工作流或其他并行分支。循环外不能作为普通结束节点使用。
- **验收：** 第三轮通过 If-Else 命中退出，第三轮后的循环内步骤不继续；外层下游按循环最终值继续。
- **来源：** [Loop](https://docs.dify.ai/en/cloud/use-dify/nodes/loop)、[1.17.1 LoopEnd 类型](https://github.com/langgenius/dify/blob/1.17.1/web/app/components/workflow/types.ts)。循环内精确调度顺序需固定版本运行用例核验。

### NODE13 代码 Code

- **输入与配置：** Python / JavaScript、具名输入映射、代码、声明输出及类型；失败重试、默认值/错误分支。
- **输出：** 返回对象需包含声明的输出且通过类型和容量校验。
- **边界：** 自部署默认字符串 400,000 字符、数值 int64 范围/浮点精度 20 位、嵌套 5 层，数组数量另有配置；不能把“19 位整数”误作任意 19 位都合法。运行依赖沙箱及预装包，未安装包必须报错。网络策略见差异表，不直接继承主机全部能力。
- **验收：** 两语言同样例、返回缺字段/错类型、嵌套越界、超长输出、包缺失、沙箱不可用分别可识别；临时失败重试后成功。
- **来源：** [Code Cloud](https://docs.dify.ai/en/cloud/use-dify/nodes/code)、[Code Self-Host](https://docs.dify.ai/en/self-host/use-dify/nodes/code)。

### NODE14 模板 Template

- **输入与配置：** 具名变量与 Jinja2 模板；嵌套字段、条件、循环、过滤器、默认值。
- **输出：** 渲染后的字符串；官方默认长度 400,000，自部署可配置。
- **边界：** 非法模板或超过上限需明确错误。Chatflow 可渲染受支持的表单与快捷回复按钮；不等同任意 HTML/脚本执行，字段校验能力以官方支持为准。
- **验收：** 把检索结果数组渲染成报告；缺可选字段用 default；错语法失败；会话表单可选择 JSON/文本提交，快捷按钮发送消息或打开链接。
- **项目要求：** 本项目缺参数时优先使用已确认的宿主询问框，不被模板表单改为在聊天文本中连续追问；兼容导入的 Chatflow 表单属于另一个能力。
- **来源：** [Template](https://docs.dify.ai/en/cloud/use-dify/nodes/template)。

**会话组件子能力对照：**

| 组件 | 配置和提交 | 边界验收 |
| --- | --- | --- |
| form/label | `data-format=json` 返回 JSON，否则逐行文本；label 对应字段名 | 表单内空行可能终止 Markdown HTML 块，需有预览错误提示 |
| input/textarea | 字段名、值、占位符；text/password/email/number 为字符串，checkbox 为布尔；date/datetime/time、select、hidden、多行文本 | `name` 必须以英文字母开头并匹配字母/数字/下划线/连字符；不把数字输入字符串误作已校验数值；非法类型显示不支持 |
| 选项/复选框 | select 的 `data-options` 为字符串 JSON 数组；checkbox 用 `checked`、`data-tip` | 空/非法选项不能产生伪有效提交 |
| 表单按钮 | variant 为 primary/warning/secondary/secondary-accent/ghost/ghost-accent/tertiary；size 为 small/medium/large | 表单按钮执行提交，忽略只属于快捷按钮的 message/link；非法样式回退 |
| 独立快捷按钮 | `data-message` 发送用户下一条消息，`data-link` 打开链接，链接优先 | 无动作时不运行；表单与快捷回复都不能视为授权修改任意固定节点 |

HTML5 `required/min/max/pattern` 在官方此渲染器不强制执行；节点运行仍需自己的 schema 校验。密码/邮箱可能被浏览器自动填充，不能当成宿主秘密输入功能。[官方组件规则](https://docs.dify.ai/en/cloud/use-dify/nodes/template#interactive-forms)

### NODE15 变量聚合器 Variable Aggregator

- **输入与配置：** 来自互斥分支的同类型变量；可设置多个聚合组。
- **输出：** 实际执行分支中有值的变量；每组独立输出。支持字符串、数字、对象、布尔、数组、文件。
- **边界：** 不是拼接数组或收集全部并行输出的节点；并行合并用 Code / Template。变量为合法空串或 false 时不能误认成“该分支未执行”。
- **验收：** IF/ELSE 两分支分别产出同类型结果，只执行一条时汇合不等待另一条；多组类型分别检查；false/0/空串保留。假值样例为项目补齐。
- **来源：** [Variable Aggregator](https://docs.dify.ai/en/cloud/use-dify/nodes/variable-aggregator)。

### NODE16 文档提取 Document Extractor

- **输入与配置：** 单文件或文件数组。
- **输出：** `text`；单文件为字符串，多文件为字符串数组。支持文本/Markdown/HTML、PDF 文本层、Office、表格、邮件、EPUB/VTT/JSON/YAML/Properties 等文档；表格转 Markdown。
- **边界：** 图片、音视频或纯扫描件不能仅凭此节点假定具备 OCR/转录；自部署部分 DOC/PPT/EPUB/ODT 处理依赖 Unstructured 服务。大文本需由后续流程分块。
- **验收：** 文字 PDF、含表格 DOCX、XLSX、邮件各一份；批量结果和文件顺序对应；损坏/加密/无文字层/依赖缺失有明确结果，不能返回伪成功空文本。
- **来源：** [Cloud](https://docs.dify.ai/en/cloud/use-dify/nodes/doc-extractor)、[Self-Host](https://docs.dify.ai/en/self-host/use-dify/nodes/doc-extractor)。

### NODE17 变量赋值 Variable Assigner

- **输入与配置：** 可写变量及来源，支持一节点多项赋值；字符串/数值/布尔/对象的覆写、清空、常量设置；数字算术；同类型数组覆写、清空、追加、扩展、移除首尾。
- **输出与范围：** 更新会话变量，跨同一会话轮次保留；Loop 示例亦用赋值更新循环变量。不能修改本次运行不可变输入或已执行节点历史输出。
- **边界：** 会话变量写入仅有会话上下文时可用；循环局部写入不因此依赖聊天 Agent；跨会话隔离。UI 显示名与遗留 `variable-assigner` / `assigner` 类型标识有历史兼容差异，导入须按版本解析。
- **验收：** 同会话第二轮读到第一轮写入，另一会话读不到；数组 append 与 extend 不混淆；循环累加生效，普通上游结果不可就地篡改。
- **来源：** [Variable Assigner](https://docs.dify.ai/en/cloud/use-dify/nodes/variable-assigner)、[Loop](https://docs.dify.ai/en/cloud/use-dify/nodes/loop)、[1.17.1 节点类型](https://github.com/langgenius/dify/blob/1.17.1/web/app/components/workflow/types.ts)。

### NODE18 参数提取 Parameter Extractor

- **输入与配置：** 文本、模型、参数名称/类型/说明/必填，可从工具快速导入；提取指令，Function/Tool Call 或提示词模式；会话记忆按上下文启用。
- **输出：** 各具名参数；`__is_success` 为 1/0，`__reason` 为失败说明。
- **边界：** 支持字符串、数值、布尔、数组、对象；缺必填不能仅因模型输出了一个 JSON 就标成功；模型能力影响提取可靠性。
- **验收：** 自然语言提取日期和数量；缺必填或错类型失败；从工具导入的 Schema 与工具调用参数一致。
- **来源：** [Parameter Extractor](https://docs.dify.ai/en/cloud/use-dify/nodes/parameter-extractor)。

### NODE19 HTTP 请求

- **输入与配置：** GET/HEAD/POST/PUT/PATCH/DELETE；URL、Headers、Query、Body（JSON/Form/Binary/Raw）、变量引用；无认证或 API Key 的 Basic/Bearer/自定义头；连接/读取/写入超时、SSL 校验、重试、错误处理。
- **输出：** Body、状态码、Headers、文件和大小信息；二进制结果能作为文件下传。
- **边界：** Secret 环境变量在请求与运行日志中遮蔽；配置合法不等于请求成功；认证错误、下载失败、超时、响应超限需分开。官方错误页提到 10 MB 响应限制，部署基线需实测。
- **验收：** JSON API、文件上传/下载、超时/限流、无效 URL；密钥不出现在日志。写入成功但回执丢失时不得因自动修复无判断重复执行。
- **来源：** [HTTP Request](https://docs.dify.ai/en/cloud/use-dify/nodes/http-request)、[Error Types](https://docs.dify.ai/en/cloud/use-dify/debug/error-type)。

### NODE20 列表操作 List Operator

- **输入与配置：** 字符串、数字、文件、布尔数组；过滤、升降序、取前 N（手册 1—20）；文件支持类型、MIME、扩展名、大小、名称、传输来源等条件。
- **输出：** `result`、`first_record`、`last_record`。
- **边界：** 不默认宣称支持任意对象数组任意字段；空数组首尾值处理需规格化，排序同值时的稳定性需实现测试。
- **验收：** 混合文档和图片按类型分路；排序后取前两项；零命中不误取原数组首项。
- **来源：** [List Operator](https://docs.dify.ai/en/cloud/use-dify/nodes/list-operator)。

### NODE21 工具 Tool

- **输入与配置：** 选择具体工具操作、凭据及 schema 定义的参数；支持插件工具、Swagger/OpenAPI、自有 Workflow 工具及 MCP 工具。
- **输出：** 以所选工具 schema 为准，包括文字、JSON、文件；不能假定每个工具都只有文本输出。
- **边界：** Dify 当前 MCP 导入手册限定 HTTP transport；支持认证、动态/自定义 OAuth、额外 Headers 与超时。工具更新/移除和跨工作区凭据缺失需可检测；Workflow 工具只支持 User Input 起点，Chatflow 不可直接当工具。
- **验收：** 四类工具各一条可执行链；工具缺失、参数错型、授权失败、文件不可读分别提示；MCP 同标识依赖迁移正确。
- **项目要求：** 已安装 Dify 工具不自动等于宿主工具可用，适配与依赖检查必须真实；调用其他流程的递归/循环依赖须校验并给出深度/运行预算（项目补齐）。
- **来源：** [Tool Node](https://docs.dify.ai/en/cloud/use-dify/nodes/tools)、[Dify Tools](https://docs.dify.ai/en/cloud/use-dify/workspace/tools)。

### NODE22 人工输入 Human Input

- **输入与配置：** 表单内容中的 Markdown 和上游变量；段落、选项、单文件/文件列表字段；行动按钮标题与 ID、分支；交付渠道与超时。选项支持静态列表或上游字符串数组，段落支持静态或变量预填。
- **输出：** 各字段值、`__action_id`、`__action_value`、`__rendered_content`；行动选择对应后续路径。
- **边界：** 到达节点后暂停等待，首次有效回答结束等待；默认三天超时，可接超时分支，否则结束；只有段落可选，其他字段必填。节点内文件输入不是开始节点的同一份上传状态。
- **验收：** 审阅并修改文本、选择行动后从当前位置恢复；两次并发提交仅首次生效；超时后不接受旧回答；等待时可关闭画布再回来。
- **项目要求：** 宿主询问框是桌面交付渠道，与执行前补参弹框区分；节点具备独立等待/恢复能力。Email 等官方交付渠道需单独真实适配，不因桌面弹框存在就标全部完成。
- **来源：** [Human Input](https://docs.dify.ai/en/cloud/use-dify/nodes/human-input)。详细执行规则见 EXEC02—EXEC04。

## 3 起点、触发与调度

| ID | 官方能力与字段 | 项目执行规则及错误边界 | 验收样例 | 来源 |
| --- | --- | --- | --- | --- |
| TRG01 | Start 分 User Input / Trigger，画布中互斥；Chatflow 仅 User Input；User Input 最多一个 | 改起点后重新校验下游变量；不能保留已失效的输入引用 | 用户输入改 Webhook 后提示原变量映射，不让运行读到旧缓存 | [Start](https://docs.dify.ai/en/cloud/use-dify/nodes/start) |
| TRG02 | Schedule：小时/日/周/月可视配置，周/月多选；5 位 cron、时区、未来 5 次执行预览；每流程最多一个；更新 `sys.timestamp`、无节点输出 | 时区随配置保存；按所选时区预览。DST、机器离线错过触发、重叠运行策略作为项目补齐：必须可见，不擅自承诺补跑 | 每周两日、月末、cron；单步立即执行，Test Run 等下次调度；预览与触发时刻一致 | [Schedule](https://docs.dify.ai/en/cloud/use-dify/nodes/trigger/schedule-trigger)、[1.17.1 时区字段](https://github.com/langgenius/dify/blob/1.17.1/web/app/components/workflow/nodes/trigger-schedule/types.ts) |
| TRG03 | Integration：选择插件事件与订阅；OAuth/API Key 自动建订阅，或手工回调 URL；输出由插件决定不可随意修改；每集成每工作区官方最多 10 订阅 | 订阅、授权、所需事件或插件失效时不显示“已启用”；自部署需可从外网访问的回调基址 | 测试监听收到事件启动一次；不在测试监听时不捕获草稿事件；订阅更新展示引用流程 | [Integration Trigger](https://docs.dify.ai/en/cloud/use-dify/nodes/trigger/plugin-trigger)、[Self-Host](https://docs.dify.ai/en/self-host/use-dify/nodes/trigger/plugin-trigger) |
| TRG04 | Webhook：正式/测试 URL；HTTP 方法与 Content-Type；Query/Header/Body 抽取字段、类型、必填；定制 200—399 响应及响应体；系统 400/404/413/500 | 必填缺失/方法或媒体类型不匹配拒绝触发；Header 总是字符串、连字符在输出改下划线；响应为触发确认，不保证后续流程业务成功 | 四类正文格式、Header 和 Query 映射；缺项不启动；测试地址与正式地址隔离；正文文件类型差异见第 6 节 | [Webhook](https://docs.dify.ai/en/cloud/use-dify/nodes/trigger/webhook-trigger) |
| TRG05 | 多触发可独立成图，也可共用下游；Run all triggers 测试时第一个激活后忽略其他；发布后可独立启停，停用事件被忽略；日志记录触发来源 | 不把“测试首个胜出”误作正式环境多个事件永远只运行一次。共用下游按当前实际触发入口运行，变量映射保持明确 | 两入口分别触发得到两次可追踪记录；一次“全部测试监听”只接受首个事件；停用后不接受事件 | [Trigger](https://docs.dify.ai/en/cloud/use-dify/nodes/trigger/overview) |
| TRG06 | 官方仅 User Input 起点可发布普通 WebApp/API/MCP 或被复用为工具；Schedule 单步可立即运行，Webhook/Integration 测试需要监听 | **项目差异：所有受支持流程都保留独立“执行”按钮。** 触发型点击执行时选择入口、提供测试事件（已有足够信息时直接用），用同一执行器执行本次流程；这不启用正式订阅/调度，不要求主 Agent。明确标注手动测试或事件重放；重放可能真的调用下游工具，不能假称无副作用 | 主 Agent 关闭仍可用样例 payload 完成事件流程；日志标记手动来源；不修改启停状态；信息不足只弹询问框 | [Start](https://docs.dify.ai/en/cloud/use-dify/nodes/start)、[Schedule](https://docs.dify.ai/en/cloud/use-dify/nodes/trigger/schedule-trigger)、主 PRD 已确认独立执行 |

**Webhook 类型矩阵（手册）：** JSON 支持字符串/数字/布尔/对象及相应非文件数组；urlencoded 支持标量字符串/数字/布尔及相应数组；multipart 支持上述标量、数组及单文件/文件数组；text/plain 支持标量字符串/数字/布尔。1.17.1 后端与文件数组存在差异，不得在未验证前声称全通过。

**Schedule 的解析边界：** 五字段分别为分钟、小时、月内日、月、星期；月内日与星期同时指定时按“任一符合”触发。官方支持 `* , - / L ?`，星期 0/7 都代表星期日，以及 `@yearly/@monthly/@weekly/@daily/@hourly` 预置表达式。可视设置与 cron 往返、月末与最后一个星期五必须测试，不能只支持固定间隔后宣称支持完整 Schedule。[Schedule 官方规则](https://docs.dify.ai/en/cloud/use-dify/nodes/trigger/schedule-trigger)

## 4 变量、文件与依赖

| ID | 数据要求 | 验收与边界 | 来源/状态 |
| --- | --- | --- | --- |
| DATA01 | 类型：string/number/integer/boolean/object/file 及具类型数组；Secret、LLM 配置属于环境配置类型；字段选择器按兼容类型过滤 | 不用字符串拼接代替有类型传递；运行前错型可定位 | [Key Concepts](https://docs.dify.ai/en/learn/key-concepts)、[1.17.1 类型](https://github.com/langgenius/dify/blob/1.17.1/web/app/components/workflow/types.ts) |
| DATA02 | 作用域：输入/节点输出是本次运行值；环境配置独立；会话变量只在同会话跨轮保留；循环变量在循环中可写 | 两并发运行同名变量互不覆盖；会话状态不能泄漏到另一会话 | [Key Concepts](https://docs.dify.ai/en/learn/key-concepts)、[Loop](https://docs.dify.ai/en/cloud/use-dify/nodes/loop) |
| DATA03 | 变量选择支持下拉与 `/` 插入；可读上游值；并行分支不能互读对方结果，汇合后的节点才能读所有已完成相关分支 | 改连线导致不可达引用时标记，禁止读取“上次运行恰好有值”的缓存 | [Orchestration Logic](https://docs.dify.ai/en/cloud/use-dify/build/orchestrate-node) |
| DATA04 | 系统变量对应用户、应用、流程、运行、时间；Chatflow 加会话身份和轮次 | 使用本项目实际身份映射；流程身份与本次运行身份必须不同；不伪造 Dify ID | [Key Concepts](https://docs.dify.ai/en/learn/key-concepts) |
| DATA05 | 文件值保存身份、名称、类型、大小和传输来源，文件内容按能力处理 | 移动/删除/跨工作区复制后校验引用；二进制不当字符串塞给普通节点；过期 URL 要求恢复资源 | [User Input](https://docs.dify.ai/en/cloud/use-dify/nodes/user-input)、[HTTP](https://docs.dify.ai/en/cloud/use-dify/nodes/http-request)；失效策略为项目补齐 |
| DATA06 | Secret 与普通隐藏字段分离，日志遮蔽；导出流程不携带秘密值；目标工作区重新绑定资源 | 导出/错误消息/请求日志均不回显秘密；引用失效不自动取其他同名凭据 | [Key Concepts](https://docs.dify.ai/en/learn/key-concepts)、[HTTP](https://docs.dify.ai/en/cloud/use-dify/nodes/http-request) |
| DATA07 | 共享 LLM 模型配置、共享 Agent、角色提示词预设是三个独立对象 | 统一更新未来运行；当前启动快照不变；用户固定节点不能被 Agent 通过修改共享配置绕过 | [LLM](https://docs.dify.ai/en/cloud/use-dify/nodes/llm)、[Agent](https://docs.dify.ai/en/cloud/use-dify/nodes/agent)；运行快照为项目已确认规则 |
| DATA08 | 结构化 Schema 与实际返回校验分离；只在成功通过后允许下游依赖 | 参数提取失败或 LLM 产出畸形 JSON 能走错误逻辑；可选缺失与必填缺失不同 | [LLM](https://docs.dify.ai/en/cloud/use-dify/nodes/llm)、[Parameter Extractor](https://docs.dify.ai/en/cloud/use-dify/nodes/parameter-extractor) |
| DATA09 | 输入/输出、变量快照、图版本、迭代索引、错误、有效模型/角色/工具依赖能关联同次运行 | 注释发送后删除的是临时序号，不能连带丢失执行引用；显示编号变化不能改变节点身份 | 主 PRD 已确认；项目数据要求 |
| DATA10 | 自动结构标记包括 Start Placeholder、Iteration Start、Loop Start/Loop End；Knowledge Pipeline 的 DataSource/Knowledge Index 属于另一种专用编排语境 | 自动入口不计作额外业务节点、不可随意孤立；不把知识入库节点装饰进普通工作流然后宣称可运行；专用管线能力在总对照表单列 | [1.17.1 节点枚举](https://github.com/langgenius/dify/blob/1.17.1/web/app/components/workflow/types.ts)；专用管线全文非本文深读范围 |

## 5 运行、人工输入、调试和错误

| ID | 规格 | 验收样例 | 来源/状态 |
| --- | --- | --- | --- |
| EXEC01 | User Input 工作流按需启动，串行等前置、并行调度可运行分支、互斥只选一路；官方单执行路径最多 50 节点 | 50 与 51 个串行节点边界；宽图不按“总节点50”误拦；本项目容量扩大需记录差异 | [Orchestration Logic](https://docs.dify.ai/en/cloud/use-dify/build/orchestrate-node) |
| EXEC02 | 人工输入节点：Markdown/变量表单、段落/选项/单文件/文件列表；按钮标题和行动身份、分支；可静态或数组驱动选项；输出字段、`__action_id`、`__action_value`、`__rendered_content` | 审阅、编辑、退回三分支；预填内容正确；点击一次只恢复一次 | [Human Input](https://docs.dify.ai/en/cloud/use-dify/nodes/human-input) |
| EXEC03 | Human Input 可 WebApp/API 或 Email 交付；第一份回答关闭请求；默认超时3天，接超时分支或无分支结束；触发型不支持官方 WebApp 交付 | 双人同时提交只有首个生效；超时后迟到回答不重启；文件变量下传，渲染文本只显示占位符 | [Human Input](https://docs.dify.ai/en/cloud/use-dify/nodes/human-input)。项目桌面优先询问框适配；Email/外部交付依赖必须真实接入 |
| EXEC04 | 运行前补参询问与图中 Human Input 分开：前者补输入，后者是已经执行到某一步后等待；都可不启动主 Agent | 前置节点已完成后等待人工输入，恢复不重新做已完成步骤；关闭询问框保留等待状态（项目补齐） | 主 PRD、[Human Input](https://docs.dify.ai/en/cloud/use-dify/nodes/human-input) |
| EXEC05 | LLM/HTTP/Code/Tool 默认失败终止；可配置类型匹配默认值或错误分支；错误输出含 `error_type/error_message` | 强制工具失败分别走三种策略；默认值错型不允许保存为有效配置 | [Handle Errors](https://docs.dify.ai/en/cloud/use-dify/build/predefined-error-handling-logic) |
| EXEC06 | 原节点重试保持图/配置不变；Code/HTTP 手册最多10次、间隔最多5000ms；其他类型按能力 schema，不把范围无依据通用化 | 网络暂错按配置重试；明示重试次数与 Agent 修复轮数不同；重试用尽再走错误策略 | [Code](https://docs.dify.ai/en/cloud/use-dify/nodes/code)、[HTTP](https://docs.dify.ai/en/cloud/use-dify/nodes/http-request) |
| EXEC07 | Loop 未处理子错误立即停止；Iteration 分终止/留null/移除失败输出。已由子节点默认值/错误分支处理的故障是否继续，需按有效结果区分 | 同一异常分别放 Loop 与三种 Iteration，结果与运行状态一致；显示部分失败数量 | [Handle Errors](https://docs.dify.ai/en/cloud/use-dify/build/predefined-error-handling-logic) |
| EXEC08 | Agent 修复是项目增加的一层：工作流预设错误处理先执行，尚未恢复的故障再按 A/B 设置；B默认，默认同故障最多2轮；固定节点保护、运行版本不覆盖原流程 | 节点重试2次并不消耗“修复2轮”；修复改名/替代节点不清零同一故障；达到上限暂停 | 主 PRD 已确认两轮/权限；层级顺序为项目补齐 |
| EXEC09 | 单节点与逐步运行；使用缓存变量调试；Answer/End(Output)不支持官方单节点测试；Last Run记录输入/输出/时间/错误 | 修改测试缓存后仅下游使用新值，原节点 Last Run 不变；恢复单项原值、清空全部缓存 | [Single Node](https://docs.dify.ai/en/cloud/use-dify/debug/step-run)、[Variable Inspector](https://docs.dify.ai/en/cloud/use-dify/debug/variable-inspect) |
| EXEC10 | 运行历史含 Result（Workflow）、Detail、Tracing，节点 Last Run；显示节点顺序、分支、轮次和耗时，来源和配置快照可追踪 | 重跑同图保留两次独立记录；图修改后历史仍可还原当时输入配置 | [Run History](https://docs.dify.ai/en/cloud/use-dify/debug/history-and-logs)；快照为项目已确认 |
| EXEC11 | 错误至少区分参数/类型/引用、模型或工具依赖、网络连接、限流/配额、沙箱、容量/深度、授权/文件失败；不要把所有失败归为“Agent出错” | 每类固定故障用例均显示可理解原因、节点位置与可操作恢复入口；日志保留原类型 | [Error Types](https://docs.dify.ai/en/cloud/use-dify/debug/error-type) |
| EXEC12 | 项目暂停/停止/恢复与图编辑分离；外部写入和消息发送不由Undo撤销；结果未知的外部动作先核对回执/幂等身份；执行中配置变更只影响后续启动的节点尝试 | 崩溃后恢复不重复已确认外部写入；撤销图编辑不删除真实执行日志；普通视图切换不中止运行 | 项目补齐，需工程验证持久化与工具幂等，官方手册未承诺任意中断无损恢复 |

**Human Input 的官方文件边界：** Cloud 图片 10 MB、文档/其他 15 MB、音频 50 MB、视频 100 MB，文件列表最多 10；只有段落可选，选项/单文件/文件列表必须填完才可行动。Self-Host 各值由环境变量配置。本项目若采用不同限制应在字段旁明确显示，不能以旧缓存绕过验证。

## 6 已发现的手册/版本差异与落实方式

| 差异 | 已有证据 | 对产品和开发的处理 |
| --- | --- | --- |
| 最新滚动手册不等于某 tag 文档快照 | 手册页面无统一版本锁定；代码以 1.17.1 固定 | 基线同时记录阅读日期、环境与代码 tag；新能力纳入清单，逐项实测后标通过，不能把手册新增全认定已在每个部署开放 |
| End / Output 命名滞后 | Output正文明确已更名且可选；Answer和Single Node部分仍称End | UI叫“输出”；导入保留 `end` 类型兼容；不把End字面解释为全局停止 |
| `sys.query` / `userinput.query` | 分类页使用前者，User Input正文使用后者 | 新流程使用最新具名输入；旧DSL变量需要版本迁移或显式兼容映射 |
| Webhook 文件数组 | 正文 multipart声称Array[File]；[1.17.1 后端类型](https://github.com/langgenius/dify/blob/1.17.1/api/core/workflow/nodes/trigger_webhook/entities.py)允许 FILE而未列ARRAY_FILE；代码另含application/octet-stream而正文矩阵未列 | 文件数组与二进制触发作为差异用例，未经运行证据不能标支持；项目要满足手册矩阵需实现并验证适配，不能只依据前端类型枚举 |
| Code 网络与数值范围 | Cloud称网络禁止；Self-Host既写strict sandbox又说明默认外连经SSRF代理，可设SANDBOX_ENABLE_NETWORK=false；数值明示int64 | 本项目明确沙箱网络策略并测试；不复制相互冲突文句；不将任何19位整数都视为合法 |
| 文件格式依赖 | Cloud列可处理格式；Self-Host DOC/PPT/EPUB/ODT可能依赖Unstructured | 依赖未配必须显示不可执行原因；不能用“支持该后缀”取代实际提取验收 |
| LLM context类型 | 检索/LLM正文支持知识片段上下文；错误类型页概述写context只接受字符串 | 区分检索结构适配与普通文本变量，按节点schema/实测验证；错误页解释不是唯一类型依据 |
| New Agent隔离与部署 | Cloud强调独立sandbox；Self-Host说明社区环境不构成不可信用户间强化隔离边界 | 节点数据隔离仍须验收；不把社区自部署描述成已证明的多租户安全沙箱；本项目不自动继承云存储/运行限额 |
| Agent V2共享能力与角色预设 | Dify能力对象包含模型/技能/工具/文件；用户已确定角色预设只有提示词 | 两对象分开，UI与数据均不混用；模型强度仍遵守用户规则 |
| Chatflow专有能力 | Answer、会话变量、节点记忆、HTML会话组件有会话上下文要求 | 保留能力映射但条件启用；普通对话@一次性流程不改变其执行类别，不扩大为独立聊天平台建设 |
| 自动触发与独立执行 | 官方触发型不能当普通UserInput工作流发布；用户要求所有流程可点击执行 | 采用TRG06手动事件执行适配；正式触发开关、订阅和发布版本与测试运行独立 |

## 7 阅读证据与仍需工程验证的部分

本轮读取官方正文共 **61 个页面副本**：Cloud 36 篇，Self-Host 对照 25 篇；另外读取官方 `llms.txt`、Cloud/Self-Host 索引，并读取 1.17.1 类型定义作交叉核对。Cloud 与 Self-Host 的 25 篇节点页面做了内容对比，**11 篇存在环境或能力描述差异**。这不是“读完 Dify 全站手册”的声明。

### 7.1 正文清单

以下目录均从 [官方 llms 索引](https://docs.dify.ai/llms.txt) 进入。相同节点的 Self-Host 地址为将 `/en/cloud/` 替换为 `/en/self-host/`；链接正文已经比较，不能只依据两个目录标题推断一致。

| 已读页面组 | 页面（直达链接） | 数量 |
| --- | --- | --- |
| 常用节点 | [LLM](https://docs.dify.ai/en/cloud/use-dify/nodes/llm)、[Knowledge Retrieval](https://docs.dify.ai/en/cloud/use-dify/nodes/knowledge-retrieval)、[Answer](https://docs.dify.ai/en/cloud/use-dify/nodes/answer)、[Output](https://docs.dify.ai/en/cloud/use-dify/nodes/output)、[Agent](https://docs.dify.ai/en/cloud/use-dify/nodes/agent)、[Question Classifier](https://docs.dify.ai/en/cloud/use-dify/nodes/question-classifier)、[If-Else](https://docs.dify.ai/en/cloud/use-dify/nodes/ifelse)、[Iteration](https://docs.dify.ai/en/cloud/use-dify/nodes/iteration)、[Loop](https://docs.dify.ai/en/cloud/use-dify/nodes/loop) | Cloud9 + Self-Host9 |
| 数据与工具节点 | [Code](https://docs.dify.ai/en/cloud/use-dify/nodes/code)、[Template](https://docs.dify.ai/en/cloud/use-dify/nodes/template)、[Variable Aggregator](https://docs.dify.ai/en/cloud/use-dify/nodes/variable-aggregator)、[Document Extractor](https://docs.dify.ai/en/cloud/use-dify/nodes/doc-extractor)、[Variable Assigner](https://docs.dify.ai/en/cloud/use-dify/nodes/variable-assigner)、[Parameter Extractor](https://docs.dify.ai/en/cloud/use-dify/nodes/parameter-extractor)、[HTTP](https://docs.dify.ai/en/cloud/use-dify/nodes/http-request)、[List Operator](https://docs.dify.ai/en/cloud/use-dify/nodes/list-operator)、[Tools](https://docs.dify.ai/en/cloud/use-dify/nodes/tools) | Cloud9 + Self-Host9 |
| 起点与人工输入 | [Start](https://docs.dify.ai/en/cloud/use-dify/nodes/start)、[User Input](https://docs.dify.ai/en/cloud/use-dify/nodes/user-input)、[Trigger](https://docs.dify.ai/en/cloud/use-dify/nodes/trigger/overview)、[Schedule](https://docs.dify.ai/en/cloud/use-dify/nodes/trigger/schedule-trigger)、[Integration](https://docs.dify.ai/en/cloud/use-dify/nodes/trigger/plugin-trigger)、[Webhook](https://docs.dify.ai/en/cloud/use-dify/nodes/trigger/webhook-trigger)、[Human Input](https://docs.dify.ai/en/cloud/use-dify/nodes/human-input) | Cloud7 + Self-Host7 |
| 编排与调试 | [Workflow & Chatflow](https://docs.dify.ai/en/cloud/use-dify/build/workflow-chatflow)、[Orchestration Logic](https://docs.dify.ai/en/cloud/use-dify/build/orchestrate-node)、[Handle Errors](https://docs.dify.ai/en/cloud/use-dify/build/predefined-error-handling-logic)、[Single Node](https://docs.dify.ai/en/cloud/use-dify/debug/step-run)、[Variable Inspector](https://docs.dify.ai/en/cloud/use-dify/debug/variable-inspect)、[Run History](https://docs.dify.ai/en/cloud/use-dify/debug/history-and-logs)、[Error Types](https://docs.dify.ai/en/cloud/use-dify/debug/error-type) | Cloud7 |
| 关联能力 | [Key Concepts](https://docs.dify.ai/en/learn/key-concepts)、[Dify Tools](https://docs.dify.ai/en/cloud/use-dify/workspace/tools)、[New Agent Overview](https://docs.dify.ai/en/cloud/use-dify/build/new-agent/overview)、[Build an Agent](https://docs.dify.ai/en/cloud/use-dify/build/new-agent/build) | 4 |

### 7.2 不能用阅读替代的验证

1. 没有在 Dify Cloud 账户或本地 1.17.1 实例执行上述样例，不能标“全部通过”或“已证明严格兼容”。
2. 当前手册不是完整 API/DSL Schema；凭据、工具/模型插件字段随依赖变化。发布前需固定依赖版本并导入真实样例，校验序列化、执行和错误语义。
3. Webhook 文件数组、Loop 内赋值细节、输出同名并发顺序、空结果、沙箱网络等差异需专门用例，不以推断补成 Dify 事实。
4. 节点工具/检索/文档解析真实接入、触发服务公网可达与常驻调度、人工输入恢复、持久化和并发竞态，均是工程交付条件，不能由画布原型替代。
5. 官方知识管线专用节点、独立发布/计费/团队管理不在本文节点正文深读范围；主能力矩阵需单列其与“全面对标画布”的关联，不得默默删项。
6. 本文所有 NODE/TRG/DATA/EXEC 编号是验收追踪编号，不是用户画布上的结构编号，也不是实现 API。
