# 23、HTTP 原样响应与网页处理节点

状态：用户 2026-10-24 审阅同意（“同意你的提案”），实施中。实现完成后，与 `37d3823`（试做证据门槛）一起打包为 r23，安装前另行请用户批准。

## 1、为什么改

用户在审阅 `web-extract` 时指出两点：

1. **节点功能必须与菜单描述一致。** 菜单和配置面板里，“HTTP 请求”的描述是“发送普通 HTTP 请求”。`web-extract@1.0.0` 却给它加了隐藏的 `responseMode:'static-html-text'`：画布上看是普通 GET 节点，实际不返回响应，而是在节点内部提取 `status/title/text`，并丢掉源码。这属于“写的是一个功能，实施出来是另一个结果”，必须纠正。
2. **抓取结果应保留原样，处理放到后续节点；上限应提高。** 但大响应不能长期堆在本地，占用要可控、可设置。

用户决定（2026-10-24）：

- 采用“临时缓存文件 + 容量上限自动清理 + 设置页可调”方案，使用默认值：
  - 单次下载上限 10 MB；
  - 超过 256 KB 的正文进入缓存；
  - 缓存总上限 200 MB。
- 允许新增 `htmlparser2` 与 `css-select` 两个依赖。
- 不采用纯内存：暂停（人工审核）或 Desktop 重启后数据会丢，多个并发运行的内存也不可控。

## 2、目标与不做的事

目标：

- HTTP 请求节点原样返回响应：状态码、响应头和完整正文；能解析为 JSON 时照常提供 `json`。不做提取、裁剪或格式转换。
- 网页处理由**可见、名称如实**的后续节点完成。
- 大响应不进入运行记录正文，按容量自动清理，用户可在设置里调整。

不做：

- 不改变 256 KB 以内响应的行为。现有工作流的输出、引用和运行记录保持不变。
- 不放宽其他节点的上限：节点输出 1 MB、代码节点输入 2 MB、QuickJS 内存 32 MB 均不变。
- 不把缓存放进用户工作区，也不把缓存全文发给远端或写入节点日志。
- 试做阶段 Agent 使用的 DSH `web_fetch` 不受本设计影响。它的截断由宿主工具决定。

## 3、HTTP 请求节点

- 普通 HTTP 请求的下载上限由 2 MB 提高到 **10 MB**，按解压后字节计。超限时节点失败，报“响应超过 10 MB 上限”，不返回半截正文。
- 输出字段保持现状：`status_code`、`headers`（仍过滤 `set-cookie` 等敏感头）、`text`、`body`，以及可解析时的 `json`。
- 删除 `responseMode:'static-html-text'`：
  - 规划侧 schema、存储 schema、执行适配器和 `static-html-text.ts` 中的这一分支全部移除；
  - 用户库和编辑状态已核对，没有任何节点使用该模式（`library.json`、`editor-state.json` 计数均为 0）；
  - 万一出现残留节点，按未知字段校验失败并明确报错，不静默当作普通请求运行。
- 请求超时、禁止自动重定向、禁止内嵌凭据、只允许 http(s) 等现有安全约束不变。

## 4、大响应缓存

### 4.1 存储形式

- **什么进缓存：** 正文超过 256 KB 时写入缓存。`text`、`body` 指向同一个缓存条目；`json` 不再预解析进输出，下游引用时才解析。
- **节点输出里存什么：** 只存一个小引用，例如 `{"$cachedBody":{"id":…,"bytes":…,"sha256":…,"contentType":…}}`，外加开头 2000 字符的预览。这样 1 MB 输出检查和运行记录都只计这个引用，不再重复存整份 HTML。
- **存在哪里：** `~/.dsh/visible-dynamic-workflows/http-cache/<runId>/<id>.body` 保存原始字节，旁边的 `<id>.json` 保存元数据（runId、节点、尝试次数、字节数、sha256、类型、创建时间）。目录权限 0700、文件 0600，拒绝符号链接，身份校验沿用附件目录（`attachments/<runId>`）的做法。
- **读取校验：** 每次读取都核对字节数和 sha256，不一致即报错，不使用被改动的内容。

### 4.2 下游如何拿到完整内容

- 当模板或参数引用 `{{http节点.text}}`／`.body`／`.json` 时，Host 从缓存读出完整内容交给下游，行为与直接放在输出里一致。
- 下游节点自己的上限照常生效。例如：
  - 模板节点的输出若因此超过 1 MB，就失败；
  - 代码节点的输入超过 2 MB，会报“输入过大”，并提示先用“HTML 处理”节点缩小数据。
- “HTML 处理”内置工具若参数恰好是对某个缓存正文的单一引用，Host 直接把缓存句柄交给工具，不经过模板展开。这些工具在 Host（Node.js）内执行，可处理完整的 10 MB。
- 引用只在同一次运行内有效。跨运行引用会被拒绝，并提示重跑抓取节点。

### 4.3 自动清理

> **作用域修订（用户 2026-10-24 选择“全局设置”）：** 缓存目录由所有工作流共用，因此两项设置都是**全局设置**，放在 DSH 原生“设置 → 工作流”页（与界面语言、保存模式同页，`WorkflowSettingsSection`，遵循 DESIGN.md §5.4），不再出现在各工作流的“执行策略”中。下文“高级设置 → 执行策略”的位置以此为准作废；T24.4a 中按工作流保存、取最小值的实现由 T24.4b 迁移。已保存在工作流定义中的 `httpCache*` 字段读取时忽略，不报错。

- **设置项：** 在原生“设置 → 工作流”的自动保存间隔之后新增两行，保存到 Host 插件数据：
  - “HTTP 响应缓存上限（MB）”：默认 200 MB，整数范围 20–5000 MB；数字输入框在失焦／Enter 时立即应用；
  - “运行结束后立即清理 HTTP 响应缓存”：默认关闭，下拉选择开启／关闭，立即应用。
  - 沿用 `vdw-preference-row`、Input／Select，无保存按钮；错误就近显示，页脚区分浏览器设置与本机工作流数据。
- **清理时机：**
  - 每写入一个新条目时检查总量；
  - 运行进入终态（完成、失败、取消）时检查；
  - Host 启动时检查一次。
- **清理顺序：**
  - 先删最早结束的运行的缓存，直到总量不超过上限；
  - 运行中、等待中、暂停中、预算等待中的运行一律不删；
  - 开启“立即清理”时，运行一进入终态就删除该运行的全部缓存。
- **随运行历史一并删除：** 运行历史已有“保留最近 200 次已结束运行”的规则。运行记录被淘汰时，对应缓存与附件目录一起删除。
- **清理后的显示：** 运行历史与节点详情中显示“响应正文已清理（原大小、sha256）”，预览仍保留。重新处理需要重跑，不尝试恢复。
- **单条超上限：** 单个响应比当前上限还大（例如上限设为 20 MB 时两条 10 MB 同时运行）时，正在运行的条目仍保留到该运行结束，结束后按规则清理。设置页注明“正在运行的数据不受上限约束”。

## 5、HTML 处理节点（内置工具）

在内置工具中新增“HTML 处理”组，在画布上就是普通工具节点，沿用现有工具节点样式，不新增节点类型或外观。名称与描述如实反映功能：

| 工具 | 菜单描述 | 输入 | 输出 |
| --- | --- | --- | --- |
| `builtin:html.extract_text` 提取网页正文 | 从 HTML 中提取标题和可读正文，不执行脚本。 | `html`；可选 `statusCode`、`contentType`、`maxChars`（默认 20000，最大 200000） | `status`（ok／http_error／not_html／empty）、`title`、`text`、`truncated` |
| `builtin:html.select` 提取网页列表/链接 | 按 CSS 选择器提取多条记录的文本或属性；链接按页面地址补成绝对地址。 | `html`、`baseUrl`、`items`（选择器）、`fields`（字段名 → `{selector?, attr? 或 text}`，最多 20 个）、`limit`（默认 100，最大 500） | `items`、`count`、`text`（JSON 文本） |

实现要点：

- 用 `htmlparser2` 解析、`css-select` 选取。两者固定版本，通过 `alwaysBundle` 打进插件包，不进入 Desktop 依赖锁，安装脚本流程不变。新增依赖前核对来源、许可证（MIT／BSD-2）与包哈希。
- 正文提取沿用现有 `extractStaticHtml` 的扫描规则，从 http 适配器移到这个工具里，提取结果标明是否截断（`truncated`）。实体解码与正文回退的已知差异（文档 22 §17 缺口①）照旧记录，不在此宣称修复。
- 链接字段（`attr:'href'` 或 `src`）用 `baseUrl` 解析成绝对地址；无法解析的保留原值，并在该条记录中标注。这补上了文档 22 §17 缺口①中的“丢失 anchor href”。
- 所有解析每处理 64 KB 让出一次事件循环，可被取消。输出仍受 1 MB 节点输出上限约束，超过时失败，不静默截断。

### 5.1 菜单与配置面板设计（用户 2026-10-24 要求：按 DESIGN.md 统一设计，并参照其他节点菜单）

HTML 处理节点完全沿用现有内置工具（“时间”“JSON 处理”）的呈现路径，不新增菜单结构、控件或视觉样式。依据为 DESIGN.md §4 组件尺寸、§5.1 节点菜单、§5.2 工具菜单、§5.3 节点配置与运行详情。

- **入口位置（§5.2 三层结构）：**
  - 节点菜单 → “工具”标签 → 提供方“HTML 处理”。它与“时间”“JSON 处理”并列，归类“工具插件”，来源显示“工作流内置”，操作数显示 2。
  - 展开后是两个操作行：“提取网页正文”“提取网页列表/链接”。每行可展开“参数说明”，按名称／类型／必填排版（复用 `SchemaDescription`）。
  - 点击操作即添加一个真正可配置的工具节点。
- **命名与说明的写法与现有内置工具一致：**
  - 操作名为 4–8 字的动宾短语；
  - 说明为一句话，以句号结尾，写明做什么、不做什么；
  - 参数名用小写英文（与 `timezone`、`text`、`path` 等一致），参数说明用中文，必要时给“例如 …”。
- **说明文案：**
  - 提取网页正文：“从 HTML 中提取页面标题和可读正文，不执行脚本，不访问网络。”
  - 提取网页列表/链接：“按 CSS 选择器从 HTML 中提取多条记录的文本或属性；链接按页面地址补成绝对地址，不访问网络。”
  - 两条说明都在菜单行悬停／焦点时完整显示（§5.1），选中后在配置面板“具体工具操作”下方完整显示（§5.3）。
- **配置面板（§5.3）：**
  - 沿用工具节点现有面板：“具体工具操作”下拉显示“HTML 处理 / 提取网页正文”，下方是逐个参数字段（`SchemaParameters`，必填带 `*`，帮助文字即参数说明），再往下是“完整参数 JSON”编辑器。
  - 不为这两个工具写专用表单。
  - 常用参数排在前面：`html`（必填，提示“通常引用上游 HTTP 请求节点的 {{节点.text}}”）、`items`、`baseUrl`；可选参数在后。
  - `fields` 是对象，用现有 JSON 输入方式，参数说明中给出完整示例：`{"name":{"selector":"h2 a","text":true},"link":{"selector":"h2 a","attr":"href"}}`。
- **画布节点（§5.5）：** 标准工具节点，宽 256。摘要显示“HTML 处理 / 操作名”，与其他工具节点一致。
- **输出约定：** 与其他内置工具一致，输出都带 `text` 字段，可用 `{{节点.text}}` 直接引用：
  - 正文提取的 `text` 是正文；
  - 列表提取的 `text` 是 JSON 文本，结构化结果在 `items`。
- **运行详情：** 沿用工具节点的输入／输出浅背景数据区（§5.3）。输入里的大段 HTML 只显示大小与开头预览，与 §4 的缓存预览一致。
- **验收：**
  - 在 Desktop 中逐项对照“时间”“JSON 处理”的同级菜单：分组、行高、说明显示方式、参数说明排版和配置面板字段顺序；
  - 截图记录在 DESIGN.md 新增的第 32 节；
  - 不一致之处按现有组件修正，不另起样式。

## 6、`web-extract` 模块改版

- 新版本 `web-extract@1.1.0` 由两个可见节点组成：HTTP 请求（GET，原样返回）→ 提取网页正文。
- 出口端口保持 `status/httpStatus/title/text/url`：
  - `httpStatus` 取自 HTTP 节点的 `status_code`；
  - `status` 由提取节点根据状态码、内容类型和正文给出；
  - 超过 10 MB 时由 HTTP 节点失败。原 `too_large` 状态改为节点失败，并如实写进模块说明。
- `1.0.0` 从目录移除：它依赖已删除的隐藏模式，且只安装在 r21/r22 测试包里，用户库中没有实例。实现摘要重新固定，两套编译器的 `fragmentContract()` 和请求字节夹具同步更新。
- 规划简报中 HTTP 节点的说明改为“原样返回响应；超过 256 KB 的正文由 Host 缓存，下游引用自动取全文”，并加入两条 HTML 处理工具的说明。若简报超过 8000 字节预算，先压缩措辞，不提高预算、不删减规则。

## 7、测试与验收

离线测试：

- **缓存：**
  - 写入、读取及 sha256 校验；
  - 篡改后拒绝；
  - 拒绝跨运行引用；
  - 按上限从最早结束的运行开始清理；
  - 运行中和暂停中的运行不清理；
  - “立即清理”开关；
  - Host 启动时清理；
  - 运行记录淘汰时一并删除；
  - 清理后的显示状态。
- **HTTP：**
  - 256 KB 内行为与现状逐字一致（回归）；
  - 535 KB（GitHub Trending 实测样本）与 2.9 MB（维基百科样本）走缓存；
  - 超过 10 MB 失败；
  - 隐藏模式残留节点会报错。
- **HTML 处理：**
  - 正文提取与现有提取器对同一批样本结果一致；
  - 选择器、属性与绝对链接；
  - 畸形 HTML；
  - 10 MB 页面的耗时与取消；
  - 输出超过 1 MB 时失败。
- **规划：**
  - 两套编译器编译 `web-extract@1.1.0`；
  - 模块实例自校验；
  - 简报预算；
  - T24.3 回放中 Trending 用例改用 `html.select` 取回仓库链接，缺口① 的链接部分转为通过。
- 全量测试通过后打包。

Desktop 验收（r23，安装需用户批准）：

- **A：** GitHub Trending → HTTP 请求（走缓存）→ 提取网页列表/链接 → 整理为 Markdown → 写入并回读核对。核对节点显示与实际输出一致，链接为绝对地址。
- 一次 2–3 MB 页面运行，确认超过 2 MB 的页面可用。
- 在设置里把缓存上限调到 20 MB、开启“立即清理”各跑一次，确认缓存目录按规则清理，运行历史显示“已清理”。
- 随后继续原计划的 C（改输出路径）与 B（`list-map`）。

## 8、T24.4a 实现记录

实施日期：2026-10-24。范围为本设计第 1–4 节及第 7 节的 HTTP／缓存离线测试；第 5–6 节的 HTML 工具及 `web-extract@1.1.0` 留待 T24.4b。未安装 Desktop、未提交或推送，未勾选 `tasks.md`。

### 8.1、变更文件与行为

| 文件 | 变更 |
| --- | --- |
| `src/host/execution-adapters.ts` | 普通 HTTP 原样返回；解压后超过 10,000,000 字节失败并取消读取，错误为“响应超过 10 MB 上限”；保留敏感响应头过滤、超时、手动重定向、方法与 URL 校验。超过 262144 字节时通过 Host 回调写缓存，先于 UTF-8 解码与 JSON 解析保存原始字节。JavaScript／Python 输入仍限 2 MB，错误提示先用 HTML 处理节点。 |
| `src/shared/http-cache.ts`、`src/host/http-cache.ts` | 定义引用、阈值及缓存错误；保存 `.body` 原始字节和 `.json` 身份元数据。目录 0700、文件 0600；拒绝目录／文件符号链接，文件读取使用 `O_NOFOLLOW` 并核对 inode、字节数、sha256。引用含 runId，跨运行拒绝并要求重跑抓取节点。 |
| `src/host/storage.ts` | 提供 Host 内部 `cacheHttpBody`／`readCachedBody`；写入、运行保存与启动时清理，历史淘汰一并删除缓存。按最早结束顺序淘汰，保护 running／waiting／pausing／paused／budget_waiting。详情投影按文件是否仍在显示 evicted，不把全文写进运行快照、事件或客户端载荷。 |
| `src/host/runtime.ts`、`src/host/template.ts` | `.text`／`.body` 透明读取，`.json` 按需解析，缓存损坏错误不会被模板的可选值回退吞掉。HTTP 存储表示接受原 1 MB 检查，下游实际输出先检查再压缩回引用；完整正文回显仍只存引用。最低文本长度按真实正文验证。暂停／重启后的同次运行可继续读取。人工节点界面只能显示预览，引用缓存全文时明确报错；其他下游节点（模型、Agent、HTTP、外部工具等）照常拿到全文（见 8.4 复核修正）。 |
| `src/shared/types.ts`、`src/shared/workflow-validation.ts` | 删除隐藏 responseMode 类型／存储分支；旧节点含该字段时明确报错。增加缓存策略字段及 20–5000 MB 范围校验。 |
| `src/shared/planning-authoring-core.ts`、`src/shared/planning-module-fragment-contract.ts`、删除 `src/shared/planning-web-extract-recipe.ts` | 删除依赖隐藏模式的内部校验例外、1.0.0 recipe、参数契约、摘要与目录项。其余四个模块的固定摘要不变。 |
| `src/host/planning/command-brief.ts` | HTTP 简报说明原样响应、256 KB 缓存与透明引用；移除旧模块后，八工作流夹具简报为 7821 字节，仍小于 8000 字节。 |
| `src/client/execution-policy.tsx`、`src/client/data-viewer.tsx` | 沿用现有 Field／Input／Select 和 DataViewer 样式；新增上限、立即清理设置，显示大小、sha256、2000 字符预览及“响应正文已清理（原大小…）”。 |
| `tests/http-cache.test.ts`、`tests/runtime-web-extract-size.test.ts` | 覆盖完整性、权限、身份、配额顺序、所有活动状态、终态立即清理、启动、保留 200 次历史、大小边界、解压计数、无半截响应、恢复和日志隔离。HTTP 全用 stub fetch，无互联网。原 `extractStaticHtml` 取消／畸形 HTML 回归继续执行。 |
| `tests/data-viewer.test.tsx`、`tests/role-presets-panel.test.tsx`、`tests/advanced-settings.test.tsx`、`tests/os-secret-transfer.test.ts` | 验证缓存／已清理展示、设置范围与保存，更新普通 HTTP 的精确回调参数断言；Secret 隔离断言保持不变。 |
| `tests/planning-{list-map,extract-validate,verified-file,web-extract}-fragment.test.ts`、`tests/t24-fragment-replay.test.ts`、`tests/t10-authoring-feedback.test.ts`、`tests/fixtures/t24/web-extract-request-digests.json` | 活跃模块数精确改为四；重录 8 案例共 24 个离线请求摘要，继续精确比对；旧 web-extract 专属案例按下节暂挂，不放宽其他 oracle。 |

### 8.2、实现细节与待续边界

- **策略作用域：** 现有“执行策略”随工作流定义保存，没有全局策略存储。本次沿用该结构。HTTP 缓存目录共用，因此总量采用各工作流**显式保存上限的最小值**；没有显式上限时为 200 MB。使用当前保存定义，修改上限不会被旧运行快照中的旧配额锁住。立即清理采用本次运行冻结的策略；设置页仍说明配置用于后续新运行，并注明共享配额和“正在运行的数据不受上限约束”。容量计入正文与元数据文件。
- **引用与工具接口：** `text`、`body` 指向同一 `{$cachedBody:{id,runId,bytes,sha256,contentType,preview}}`；预览放在引用内部而非另设顶层字段。`json` 不存入大响应输出。下一任务的 Host HTML 工具在识别参数为单一正文引用后，可直接调用 `WorkflowStorage.readCachedBody(runId, ref): Buffer`，需要文本时自行 UTF-8 解码；该接口没有注册为 Remote 方法或公开工具，读取必经身份与完整性验证。
- **限额不变：** 通用节点输出 1 MB、代码输入 2 MB、QuickJS 32 MB 及规划限制不变。检查时发现现有 `renderDataTemplate` 还有更严格的 **400000 字符**限制，本次保留，不将其放宽为 1 MB。小于等于 262144 字节的 HTTP 输出没有新增缓存字段。
- **全文回显：** 下游若原样回显完整缓存正文，或给完整正文加前后缀，通过其原有输出大小检查后仍以缓存引用保存，以保持恢复能力并避免在日志／客户端泄漏全文。执行阶段用于识别全文的临时读取记录在暂停或运行结束后释放。
- **暂挂案例：** `planning-web-extract-fragment.test.ts` 的旧 1.0.0 专属套件（11 项）标为 pending T24.4b；`t24-fragment-replay.test.ts` 的 web-process CREATE、原样本／反事实、两编译器参数 EDIT 用两个 todo 明确记录，原隐藏提取器的反例回放另有 1 项 skip。Trending 的普通 HTTP／站点解析器回放继续执行；没有将其宣称为 `html.select` 验收。其他模块及严格原请求 oracle 继续执行。
- **保留与禁止项：** `src/host/static-html-text.ts` 的提取函数保留；未新增 HTML 工具或解析依赖。未改冻结 manifest、`scripts/benchmarks/t09-config.json`、`docs/evidence` 原件、`tests/probes`、`cordis.patch.yml`，未访问 `~/.dsh` 或 Desktop 配置。

### 8.3、离线验证与限制

最终命令、计数与日志如下。所有大日志位于未跟踪的 `.test-data/`；没有真实工作流模型调用、互联网抓取或 Desktop 操作。

- 已确认的环境限制：首次全量运行中 `graphon-capability-audit.test.ts`、`planning-notification-reconnect.test.ts` 各 1 项，以及 `tool-adapters.test.ts` 的真实本地 HTTP 服务测试 1 项，均因 `listen EPERM: operation not permitted 127.0.0.1` 无法验证。没有提权或绕过；后续复跑排除这三个文件，再单独运行 tool-adapters 的其余 9 项。
- 一次只读 `ps` 查询也被沙箱拒绝，已停止该查询。它不属于功能验证证据。
- React 组件验证覆盖真实 DataViewer／执行策略组件的渲染结构与交互；没有 Desktop 截图或实际安装验收。打包、安装及 T24.4b 的 HTML 工具／模块运行仍待后续任务。


| 最终检查 | 精确结果 | 日志 |
| --- | --- | --- |
| `npm run typecheck` | 3 个 TypeScript 阶段通过，退出码 0 | `.test-data/t24.4a-typecheck-final.log` |
| `npm run build` | 构建通过，退出码 0；52 个 Remote 方法的 Host／Client schema 一致 | `.test-data/t24.4a-build-final.log` |
| `npm test -- --exclude tests/graphon-capability-audit.test.ts --exclude tests/planning-notification-reconnect.test.ts --exclude tests/tool-adapters.test.ts` | 262 文件通过、1 文件暂挂；**3635 通过、0 失败、12 skipped、2 todo** | `.test-data/t24.4a-acceptance.log` |
| `./node_modules/.bin/vitest run tests/http-cache.test.ts tests/runtime-web-extract-size.test.ts tests/data-viewer.test.tsx tests/role-presets-panel.test.tsx tests/advanced-settings.test.tsx` | 5 文件、**70 通过、0 失败**，覆盖最终代码；其中缓存 18、HTTP／Runtime 29、组件 23 | `.test-data/t24.4a-core-acceptance.log` |
| `./node_modules/.bin/vitest run tests/tool-adapters.test.ts -t '^(?!.*uses actual HTTP responses, preserves status and never follows credential-bearing redirects).*'` | **9 通过、0 失败、1 skipped**；仅排除已遭沙箱拒绝的监听用例 | `.test-data/t24.4a-adapters-final.log` |
| `./node_modules/.bin/vitest run tests/role-presets-panel.test.tsx tests/advanced-settings.test.tsx tests/repair-policy-client.test.tsx tests/os-secret-transfer.test.ts` | **45 通过、0 失败** | `.test-data/t24.4a-policy-final.log` |
| `node --import tsx .test-data/t24.4a-capture.ts` | 8 个离线案例、24 个请求摘要；0 次 provider 调用 | `.test-data/t24.4a-capture.log` |
| `git diff --check` | 0 个空白错误 | 命令直接验证 |

最终核心回归包含在全套加载后补入的 Host 内置 JSON 透明读取案例，以及最终的字面替换／长 Content-Type 边界修复；上表测试数存在覆盖重叠，不能直接相加。Host 内置工具在本地执行，外部工具和客户端节点直接读取缓存引用仍受全文隔离约束。

迭代过程也保留了失败记录，没有以跳过断言掩盖：初次 HTTP／缓存定向测试为 36 通过、1 失败（新测试误以为模板上限为 1 MB）；规划定向为 154 通过、1 失败、12 skipped、2 todo（简报精确字节预期由 7842 更新为 7821）；首次未排除文件的 `npm test` 为 3631 通过、7 失败、12 skipped、2 todo，其中 3 项为上述沙箱限制，其余 4 项已通过精确回调参数、默认关闭字段省略语义及帮助文案 mock 修正。后续新增验证用例曾误向 HTTP 配置填写不允许的 outputSchema，已删除这项测试输入并保留原 schema；最低正文长度校验单独覆盖。没有放宽这些既有契约。

### 8.4、复核（沙箱外，2026-10-24）

- 全量 `npx vitest run`（不排除监听测试）：**265 文件通过、1 文件暂挂；3648 通过、0 失败、12 skipped、2 todo**。Codex 排除的三个监听文件在沙箱外全部通过。
- **修正一处偏离设计：**
  - 实现原先禁止模型、分类器、提取器、Agent、知识检索、文档、HTTP 和外部工具节点引用超过 256 KB 的缓存正文。这与本文 §4.2 “下游引用自动取全文”不符，也比原行为倒退：此前 256–470 KB 的页面可以直接交给模型。
  - 修正后只有人工节点继续拒绝，因为人工界面只能显示预览，不能如实呈现全文。其他节点照常拿到全文。
  - 运行记录、日志和客户端载荷在保存时仍统一替换为引用与预览（`redactCachedText`），不增加存储占用。
  - 新增测试：下游 HTTP POST 收到完整 535 KB 正文，运行记录中不含全文。
- 设置作用域（§8.2 “各工作流上限取最小值”）提交用户决定，见 tasks.md T24.4a 备注。

## 9、T24.4b 实现记录

实施日期：2026-10-24。完成全局缓存设置、两项 Host HTML 内置工具及 `web-extract@1.1.0`。本节替代 §8.2 的逐工作流策略和暂挂说明；§8 保留为 T24.4a 的历史记录。未勾选 `tasks.md`，未提交／推送，未使用 Desktop 或真实模型。

### 9.1、文件与行为

| 文件 | 实现 |
| --- | --- |
| `src/shared/http-cache-settings.ts`、`src/host/storage.ts`、`src/host/http-cache.ts` | 新增全局 schema，默认 200 MB／关闭，20–5000 MB 整数；与角色预设等全局数据一起存入插件 `library.json`，支持校验后的部分更新。写缓存、运行终态、Host 启动清理均读取当前全局值，删除旧的逐工作流最小配额和运行开始快照语义。活动运行保护保持不变。 |
| `src/host/index.ts`、`src/shared/types.ts`、`src/client/index.tsx` | 沿用 JSON Remote 模式新增 `httpCacheSettings`／`saveHttpCacheSettings`；Host／Client 共 54 个方法 schema 一致。 |
| `src/shared/workflow-validation.ts`、`src/client/execution-policy.tsx` | 旧工作流中的两个 `httpCache*` 字段兼容读取、忽略并在规范化时移除；即使字段类型不符也不阻止工作流加载。执行策略不再显示、解释或写入它们。类型中的旧字段仅作迁移兼容标记。 |
| `src/client/http-cache-settings.tsx`、`src/client/forms.tsx` | 原生 `WorkflowSettingsSection` 自动保存间隔之后按顺序增加两个 `vdw-preference-row`；复用 Input／Select，失焦／Enter 与选项变更立即应用，错误就近显示，无 Save 按钮。中英文页脚准确区分浏览器保存的语言／保存设置和 Host 保存的 HTTP 缓存设置。未修改角色预设页。 |
| `src/shared/builtin-tools.ts`、`src/host/tool-catalog.ts`、`src/client/nodes.ts`、`src/shared/workflow-semantics.ts` | 共享原有内置工具定义，增加 provider `builtin:html`／“HTML 处理”、两个操作及 §5.1 完整描述、字段示例。复用工具菜单、`SchemaDescription`、`SchemaParameters`／具体操作面板；画布摘要同样显示提供方／操作名，无新样式或专用表单。语义词典同步列出 11 个内置工具及可执行 HTML 示例。 |
| `src/host/html-tools.ts`、`src/host/static-html-text.ts` | Node.js 执行，正文提取复用原扫描规则，支持 `maxChars` 与 `truncated`、状态分类。CSS 提取支持字段文本／属性、相对链接、畸形 HTML、字段 20 个和记录 500 个上限；无法绝对化的字段保留原值，并在该记录的 `_unresolvedLinks` 数组中列出字段名。解析分块、遍历和长文本读取可让出事件循环／取消；输出超过既有 1 MB 上限失败。 |
| `src/host/runtime.ts`、`src/host/tool-catalog.ts` | 仅两项 HTML 工具的 `html` 参数在恰为单一缓存正文引用时传递句柄，Host 通过 `readCachedBody(runId, ref)` 验证后读全文；其他表达式仍走普通解析。仅这些工具的 HTML 参数放行至 HTTP 的 10 MB，其他参数／工具继续原校验。代码 2 MB、QuickJS、规划节点及修复次数等限制未改。 |
| `src/shared/planning-web-extract-recipe.ts`、`src/shared/planning-module-fragment-contract.ts` | 恢复 `web-extract@1.1.0` 目录及契约，两个可见普通节点：HTTP GET 原样响应 → HTML 正文工具。公开五个端口，HTTP 超过 10 MB 直接失败；没有隐藏响应模式。固定摘要见下节，两编译器契约逐字节相同，实例自校验及脱离行为保留。 |
| `src/host/planning/command-brief.ts` | 加入模块及两个 HTML 操作的简报，通过压缩索引／回执措辞保持原规则；八工作流夹具为 7946 字节，8000 字节预算不变。 |
| `scripts/build.mjs` | 两个依赖列入 `alwaysBundle`；HTML 执行器也生成独立 bundle，类型输出目录中同名 JS 转发至 bundle，避免发布目录的编译中间产物残留外部依赖导入。 |
| `package.json`、`pnpm-lock.yaml` | 协调方经用户批准在沙箱外安装的精确 devDependencies 与锁文件变更，本实现未再安装或修改；运行时 `dependencies` 与 HEAD 完全相同。 |
| `tests/http-cache.test.ts`、`tests/http-cache-settings.test.tsx`、`tests/role-presets-panel.test.tsx`、`tests/advanced-settings.test.tsx`、`tests/workflow-i18n.test.tsx` | 全局存储与 API、旧字段容错、各清理触发、当前设置读取；原生设置行顺序、即时应用、范围／API 错误、页脚及旧执行策略移除。 |
| `tests/html-tools.test.ts`、`tests/html-tools-ui.test.tsx`、`tests/runtime-web-extract-size.test.ts`、`tests/workflow-semantics.test.ts` | 样本提取规则一致性、状态／截断、CSS／属性／链接／畸形 HTML／限制；10 MB 调度与取消、1 MB 失败、缓存句柄、535 KB HTTP → select → template；实际菜单／参数说明／配置字段顺序与时间／JSON 工具对照。 |
| `tests/planning-{web-extract,list-map,extract-validate,verified-file}-fragment.test.ts`、`tests/planning-command-brief.test.ts` | 恢复 11 项 web-extract 测试；两编译器、摘要、端口、实例验证、超过 10 MB 的 HTTP 失败与精确简报字节／预算；其他模块仅更新目录项数量。 |
| `tests/t24-fragment-replay.test.ts` | 恢复 web-process CREATE／EDIT 和反例，移除 T24.4a 的 2 todo／1 skip，32 项通过。Trending HTTP 回放使用 `html.select` 提取仓库 href，补上链接缺口；实体解码和正文回退差异仍由反例记录，不宣称等价。 |
| `tests/t10-authoring-feedback.test.ts`、`tests/fixtures/t24/web-extract-1.1-request-digests.json` | 新建 1.1.0 的 8 案例／24 请求摘要夹具并精确比较，保留全部旧请求字节夹具及证据原件。 |

### 9.2、依赖来源、摘要与实现细节

最初沙箱内安装探测因 npm DNS／ENOTFOUND 失败后停止，没有绕过。协调方随后明确通知：审阅者已获用户批准，使用项目 pnpm store 在沙箱外安装并通过 import smoke test；本任务继续使用现成依赖，未再运行安装命令。下表来源为该批准记录、已安装包许可证及 `pnpm-lock.yaml` 的 npm integrity；前两项为直接开发依赖，其余为传递依赖。空的 `.test-data/t24.4b-dependencies` 已删除。

| npm 包／精确版本 | 许可证 | 锁文件 integrity |
| --- | --- | --- |
| `htmlparser2@12.0.0` | MIT | `sha512-Tz7u1i95/g2x2jz81+x0FBVhBhY5aRTvD3tXXdFaljuNdzDLJ8UGNRrTcj2cgQvAg3iW/h77Fz15nLW0L0CrZw==` |
| `css-select@7.0.0` | BSD-2-Clause | `sha512-snmjEVXy+1LnwXdxhYvTMj1d9tOh4HxkA1YmoayVBeeyR2C14Pum7fcxJIm4SswYspVy866eYNwlH6xC3/VH5g==` |
| `boolbase@2.0.0` | ISC | `sha512-DkVaaQHymRhpYEYo9x1oo7Q7B0Y6KJUsjm3c9eTyFDby4MHLBTwZ6ZDWBel5zrYxj1WsZgC5oLpiz+93MluXeA==` |
| `css-what@8.0.0` | BSD-2-Clause | `sha512-DH0Bqq3DNp5tdOReuNyAA+Ev4Y2GS5FMbZpeTLP6C4CDi0h5nL0BmUPChXw3o/qbHLDWHl49sbNqQVY7bMSDdw==` |
| `dom-serializer@3.1.1` | MIT | `sha512-4MEa38/QexBob6gFNwu+EGdWvhJ1OKuNwdYY3Y3NyeWDQfnGeDYQUDfIRzWu5B5gsv03so2Uxd28YC6zrsx3Lw==` |
| `domelementtype@3.0.0` | BSD-2-Clause | `sha512-umCQid3jKbDmVjx8jGaW7uUykm4DEUeyV21hPxNMo2nV955DhUThwqyOIDtreepP31hl84X7G5U9ZfsWvIB3Pg==` |
| `domhandler@6.0.1` | BSD-2-Clause | `sha512-gYzvtM72ZtxQO0T048kd6HWSbbGCNOUwcnfQ01cqIJ4X2IYKFFHZ5mKvrQETcFXxsRObZulDaKmy//R7TPtsBg==` |
| `domutils@4.0.2` | BSD-2-Clause | `sha512-qI4JLRKnSzqFqr7hAlS5xQDusBCjKSEG4t4+7aNrIQMHBcsC2TGEhuyABJdYkgSewL57PNLYEiibY2iPKhKpaA==` |
| `entities@8.1.0` | BSD-2-Clause | `sha512-kxL7msIffSuh9aaFAMD7rxAIuTRMAHMeBtgHW2yUdWw732ZNh4MehkF2gdjvtdmikkaIP9bFDDJOPlsvm7avrA==` |
| `nth-check@3.0.1` | BSD-2-Clause | `sha512-GX0gsdbGVCgnRgbeGaubfjpBXyYRWOOCVeYh08bSQvDZqxz5ndXs1OTfAt/h36G1xvI94YIspsI0sVFqAV9+RQ==` |

- `web-extract@1.1.0` 的 `implementationDigest` 固定为 `5f8002af6ebe28c1656ee0ef9b3167320bbcffc21b95c1874d6c3b90257b2928`；其他四个模块摘要保持不变。
- 为让双节点 recipe 如实处理缺失 Content-Type 的响应、并从唯一出口暴露原有端口，正文工具增加可选 `headers`／`url` 输入，条件输出 `httpStatus`／`url`。显式 `contentType` 优先，否则从 `headers` 大小写不敏感读取；`httpStatus` 原值来自 HTTP `status_code`。这是 §5 简表之外的兼容补充，没有新增隐藏节点。
- `_unresolvedLinks` 是记录内的保留字段；用户 fields 不得占用它或原型相关名称。`fields` 的 `attr` 与 `text:true` 必须二选一。
- 解析以 16384 个 UTF-16 单元分块（UTF-8 不超过约 64 KB），遍历每 1024 节点让出，长文本分块让出，并在相关边界检查 AbortSignal。这是协作式取消；CSS 库内部的单次选择器判断不是可抢占的实时执行保证。
- 缓存句柄按原始响应字节验证 10 MB；UTF-8 解码产生的替换字符不会引入额外的正文限制。普通字符串参数按 UTF-8 字节检查 10 MB。通用节点输出继续执行原 1 MB 序列化长度上限；唯一有意截断为正文提取的 `maxChars`，并返回 `truncated`。
- 最终产物扫描覆盖 `lib` 中 265 个 JS／MJS 文件，没有任何 `htmlparser2`／`css-select` 外部 import／require；bundle 内包含两库实现。没有触碰 Desktop 依赖锁。
- 单独 10,000,000 字节 select 样本（一个链接加空白）测量为 81.69 ms，1 ms 定时器触发 70 次，最大间隙 13.36 ms；仅代表本机本次样本，不作为所有 CSS 的时延保证。记录在 `.test-data/t24.4b-artifact-check.json`。

### 9.3、离线验证与未验证边界

所有 HTTP 测试使用 stub fetch；无真实模型调用或互联网抓取。大日志及临时脚本在未跟踪 `.test-data/`。下列测试有覆盖重叠，计数不可相加。

| 最终检查／专项命令 | 精确结果 | 日志 |
| --- | --- | --- |
| `npm run build` | 退出码 0；54 个 Remote 方法 Host／Client schema 一致 | `.test-data/t24.4b-build-final.log` |
| `npm run typecheck` | 3 个 TypeScript 阶段通过，退出码 0 | `.test-data/t24.4b-typecheck-final.log` |
| `npm test -- --exclude tests/graphon-capability-audit.test.ts --exclude tests/planning-notification-reconnect.test.ts --exclude tests/tool-adapters.test.ts` | **266 文件、3676 通过、0 失败、0 skipped、0 todo**，325.27 秒；覆盖最终实现 | `.test-data/t24.4b-full-final.log` |
| `./node_modules/.bin/vitest run tests/tool-adapters.test.ts -t '^(?!.*uses actual HTTP responses, preserves status and never follows credential-bearing redirects).*'` | **1 文件、9 通过、0 失败、1 skipped**；只排除已知监听用例 | `.test-data/t24.4b-adapters-final.log` |
| `./node_modules/.bin/vitest run tests/html-tools.test.ts tests/html-tools-ui.test.tsx tests/runtime-web-extract-size.test.ts tests/http-cache.test.ts tests/http-cache-settings.test.tsx tests/planning-web-extract-fragment.test.ts tests/planning-command-brief.test.ts tests/t10-authoring-feedback.test.ts` | **8 文件、155 通过、0 失败**；其后的扫描分块／迁移断言等补充由最终全套覆盖 | `.test-data/t24.4b-core.log` |
| `./node_modules/.bin/vitest run tests/t24-fragment-replay.test.ts` | **1 文件、32 通过、0 失败、0 skipped／todo** | `.test-data/t24.4b-replay.log` |
| `./node_modules/.bin/vitest run tests/advanced-settings.test.tsx tests/workflow-i18n.test.tsx tests/workflow-semantics.test.ts tests/planning-verified-file-fragment.test.ts` | **4 文件、71 通过、0 失败** | `.test-data/t24.4b-regressions.log` |
| `node --import tsx .test-data/t24.4b-capture.ts` | **8 离线案例、24 请求摘要、0 provider 调用** | `.test-data/t24.4b-capture.log` |
| `node .test-data/t24.4b-artifact-check.mjs` | 运行时 dependencies 与 HEAD 相同；两个精确开发依赖版本正确；扫描 265 个产物脚本，外部 HTML 依赖导入 0 项；10 MB 执行样本通过 | `.test-data/t24.4b-artifact-check.json` |
| `git diff --check` | 退出码 0，0 空白错误 | 直接验证 |

首轮完整离线回归为 3670 通过、6 失败：旧简报字节预期 1 项、旧执行策略控件预期 1 项、设置页 mock 缺新 API 1 项、语义词典缺 HTML 条目／示例 3 项；均已修复并由最终全套复验，没有删除断言或提高预算。另一次同时运行 build 与 typecheck 时，build 清理生成目录导致 typecheck 临时找不到 Remote 类型；构建完成后顺序重跑 typecheck 已通过。

环境边界：此前 T24.4a 已确认的 `listen EPERM` 三个监听测试，本次未再尝试或绕过；完整离线命令排除两个监听专属文件和 `tool-adapters` 文件，再单独验证后者非监听的 9 项。Desktop 菜单视觉／截图、安装、真实网站与真实模型运行均未验证。没有新增 DESIGN.md 截图章节来冒充 Desktop 验收。

保留限制：未修改冻结 manifests、`scripts/benchmarks/t09-config.json`、`docs/evidence` 原件、`tests/probes`、`cordis.patch.yml`；未访问 Desktop 或 `~/.dsh`。实体解码／正文回退的历史差异继续保留，不计作本任务修复。

### 9.x、复核（沙箱外，2026-10-24）

- 全量 `npx vitest run`（含三个监听测试）：**269 文件、3688 项全部通过**。
- 依赖由复核者在沙箱外安装，用户已批准；Codex 沙箱无法访问 npm 源，按约定停止，没有绕过。安装方式与范围：
  - pnpm 使用项目原有的 store，`--ignore-scripts`，精确版本；
  - `package.json` 只新增两行 devDependencies，键的顺序未改；
  - 锁文件中的 integrity 与 npm 源一致。
- 真实页面实测（2026-10-24 下载的 GitHub Trending，567 KB）：
  - `html.select`（`article.Box-row`；字段：`h2 a` 文本、`h2 a@href`、`p`）用 23 ms 取出 10 条，链接均为 `https://github.com/<owner>/<repo>` 绝对地址，名称和描述正确；
  - `html.extract_text` 用 15 ms 返回 status ok、页面标题、11381 字正文，`truncated=false`。
- 界面复核：
  - 两个缓存设置位于 `WorkflowSettingsSection`，在“自动保存间隔”之后，沿用 `vdw-preference-row`、Input 和 Select，修改立即生效；
  - 页脚文案如实区分浏览器存储和本机工作流数据；
  - 内置工具画布摘要统一为“提供方 / 操作名”，“时间”“JSON 处理”节点同样改为这种写法，与 §5.1 “摘要与其他工具节点一致”相符。
- Desktop 验收仍待 r23 安装，安装需用户批准。
