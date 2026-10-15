# Dify 风格细化验收

日期：2026-10-15。范围：依据用户提供的 Dify 截图和现场界面研究，细化节点卡片、配置面板、输入区、提示词组件、菜单及便签；保留 DeepSeekHarness 宿主样式和既有工作流功能。

当前状态：**真实 DeepSeekHarness Web、自动化检查与桌面端复验均通过；桌面已安装本轮构建。** 本轮完成界面细化，不代表完成全部 Dify 功能。

实施依据：[DESIGN.md](../DESIGN.md) 第 10 节为本轮组件基线，覆盖此前冲突的数值；[Dify 界面现场研究](Dify界面现场研究.md) 记录实际观察范围、测量值及未覆盖部分。

## 1. 设计变化与保留行为

| 区域 | 本轮变化 | 保留的行为 |
| --- | --- | --- |
| 节点卡片 | 收敛圆角、边框、图标比例；模型摘要使用浅灰条；标题、编号、摘要和说明形成明确层级 | 多选仅边框高亮；稳定节点 ID、结构编号、端口、运行状态继续使用原数据 |
| 配置面板 | 标题原位编辑；固定节点改为头部锁按钮；帮助与关闭使用紧凑图标；固定头部与滚动正文分开 | 面板避开顶部动作区；原有节点配置、固定规则、撤销和运行保护继续生效 |
| 输入与菜单 | 统一浅灰底、32px 字段、紧凑菜单行、DSH 字体和主题；选中、悬停、禁用、焦点使用统一层级 | 模型继续默认跟随 DSH；错误和不可用原因持续可见；菜单保留真实操作 |
| 提示词 | SYSTEM 与 USER 内嵌卡片；真实复制、展开编辑和字符数；字段旁问号帮助 | SYSTEM 仅展示角色预设，修改仍在设置中；USER 展开与原字段同步；运行中禁止编辑，允许复制和查看 |
| 便签 | 淡纸色、轻顶条、正文优先；操作条浮在纸面外；标题、粗体、列表、行内代码使用轻量 Markdown | 原始文本保留；支持连接节点、拖动、调整大小、删除及撤销；不与发送给 Agent 的临时注释混淆 |
| SVG 导出 | 与画布共享便签解析；保留文字格式、列表编号、段落、纸色、顶条和圆角 | 不执行 HTML；保留连接线和裁切；使用纯 SVG，不依赖 HTML foreignObject |

深浅色从 DSH 主题变量派生。复制和展开按钮不模拟未实现的功能；未加入假 Jinja、视觉、发布或模型执行入口。

## 2. Dify 现场参考证据

通过 Tabbit CLI 研究用户已打开的 Dify Cloud 中文工作流。共保存 **13 张参考图**；未修改模型、输入或流程内容，未运行、发布或安装工具，结束时恢复原页面与 95% 缩放。

| # | 参考对象 | 截图 |
| --- | --- | --- |
| 1 | LLM 节点、配置面板与提示词卡片 | [LLM 画面](../artifacts/screenshots/dify-reference-llm-middle.png) |
| 2 | 节点目录及分组 | [节点目录](../artifacts/screenshots/dify-reference-node-catalog.png) |
| 3 | 工具目录及分类 | [工具目录](../artifacts/screenshots/dify-reference-tool-catalog.png) |
| 4 | 工具提供方展开 | [时间工具展开](../artifacts/screenshots/dify-reference-tool-expanded.png) |
| 5 | 节点更多菜单 | [更多菜单](../artifacts/screenshots/dify-reference-node-more.png) |
| 6 | 节点右键菜单 | [右键菜单](../artifacts/screenshots/dify-reference-node-context.png) |
| 7 | 模型选择下拉 | [模型下拉](../artifacts/screenshots/dify-reference-model-dropdown.png) |
| 8 | 便签悬停 | [便签悬停](../artifacts/screenshots/dify-reference-sticky-hover.png) |
| 9 | 便签选中及浮动工具条 | [便签选中](../artifacts/screenshots/dify-reference-sticky-selected.png) |
| 10 | 开始节点配置 | [开始节点](../artifacts/screenshots/dify-reference-start-panel.png) |
| 11 | 结束节点配置 | [结束节点](../artifacts/screenshots/dify-reference-end-panel.png) |
| 12 | LLM 高级配置 | [高级配置](../artifacts/screenshots/dify-reference-advanced.png) |
| 13 | 研究结束后的恢复状态 | [恢复状态](../artifacts/screenshots/dify-reference-restored.png) |

工具目录首图包含加载中状态；节点更多截图包含打开动画。尺寸与最终底色以现场研究文档中的 computed style 为准，不把单张截图的过渡状态作为设计数值。

## 3. 真实 DeepSeekHarness Web 验收

环境：官方 DeepSeekHarness Web，`http://127.0.0.1:5188/`，隔离的 Web 测试 profile。未用独立预览壳代替宿主验收。

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 节点与面板层级 | 节点卡片、浅灰字段、标题原位编辑、紧凑动作和说明入口完成检查 | [Web 最终画面](../artifacts/screenshots/dify-ui-web-final.jpg) |
| 提示词编辑 | USER 原字段与展开编辑同步；复制可用；修改可撤销；SYSTEM 角色提示词保持只读 | [提示词组件](../artifacts/screenshots/dify-ui-web-prompts.jpg) |
| 帮助入口 | 点击查看说明；帮助使用宿主 Tooltip，支持键盘访问、Esc/Tab 关闭；模型异常说明常显 | [提示词与说明](../artifacts/screenshots/dify-ui-web-prompts.jpg) |
| 便签 | Markdown 展示、节点连接、拖动、删除与撤销通过；绑定和原有内容未被样式改动替代 | [画布与便签](../artifacts/screenshots/dify-ui-web-final.jpg) |
| 固定节点 | 头部锁切换可用，切换后的撤销通过 | [节点配置](../artifacts/screenshots/dify-ui-web-final.jpg) |
| 工具菜单 | 工具目录的分层、紧凑控件和实际操作入口完成检查 | [工具目录](../artifacts/screenshots/dify-ui-web-tools.jpg) |
| 真实工作流执行 | 通过既有 Graphon 执行层运行循环流程，最终计数为 **3**，执行轮数为 **3** | [Graphon 运行结果](../artifacts/screenshots/dify-ui-web-run.jpg) |
| SVG 导出 | 从 Web 工具栏实际下载 SVG，XML 有效，标题与粗体保留，正文没有原始 Markdown 标记 | [导出文件](../artifacts/dify-ui-evidence/web-canvas-export.svg) |
| 深色主题 | 检查节点、面板、字段和便签的深色呈现；检查后恢复“跟随系统” | [深色画面](../artifacts/screenshots/dify-ui-web-dark.jpg) |

截图记录代表画面状态；编辑、复制、撤销和实际运行结果同时经过交互验证，不能仅凭截图推导全部行为。

## 4. 自动化与构建

| 检查 | 结果 |
| --- | --- |
| 完整自动化测试 | **25 个测试文件、234 项测试通过** |
| TypeScript typecheck | 通过 |
| 插件 build | 通过 |
| 提示词行为 | 展开同步、变量表达式保留、只读/运行保护、复制成功与失败反馈、字符计数、重要错误可见 |
| 便签与导出行为 | 原位编辑、取消、单次保存、删除不复活、连接/脱离、批量尺寸变更；共享 Markdown 解析、SVG 格式与换行、HTML 转义和源数据不变 |

完整检查日志：[测试结果](../.cache/dify-ui-tests-final.log)、[构建结果](../.cache/dify-ui-build-final.log)。Web 的实际 Graphon 循环执行补充运行回归证据，未将单元测试作为真实宿主验证的替代。

## 5. 安装包

桌面更新使用本地预构建安装包，保留现有 Graphon 运行环境和插件版本号；本轮不发布远端版本。

- 文件：[dsh-visible-dynamic-workflows-0.1.0-dify-ui-macos-arm64.tgz](../artifacts/dsh-visible-dynamic-workflows-0.1.0-dify-ui-macos-arm64.tgz)
- 平台：macOS Apple Silicon。
- 大小：**31,673,432 bytes**。
- SHA-256：`3b98c9a6f87750b6a28fdb81d3e07e001c6bde280e6a508eaead95764605051f`。

文件大小和 SHA-256 已对实际安装包复核。此前 Graphon 接入与平台边界见 [Graphon 轻量接入验收](Graphon轻量接入验收.md)。

## 6. 桌面端验收

通过 DeepSeekHarness 官方插件管理界面更新并启用，实际界面已加载新样式。安装后的 `lib/client.js`、`lib/index.js` SHA-256 与本地构建一致。未修改另外两个已启用插件。

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 卡片与面板 | 标题原位编辑、头部锁按钮、浅灰字段、紧凑图标及浮动便签样式已在桌面渲染 | [桌面卡片](../artifacts/screenshots/dify-ui-desktop-cards.png) |
| 字段说明 | 点击「输入变量映射说明」显示说明，Esc 收起 | 原生桌面操作检查 |
| 便签 | 在验收副本编辑标题、粗体、列表；删除后消失，撤销恢复，再撤销还原原始文字与绑定 | [编辑后的便签](../artifacts/screenshots/dify-ui-desktop-cards.png) |
| 节点/工具目录 | 页签切换正常；时间提供方可展开五个操作；分类、搜索和操作说明层级正常 | [桌面工具目录](../artifacts/screenshots/dify-ui-desktop-tools.png) |
| 实际执行 | 验收副本四节点全部完成；输入文本经过模板进入最终结果，时间分支完成 | [桌面运行结果](../artifacts/screenshots/dify-ui-desktop-run.png) |
| 数据保留 | 更新前后两个工作流及预设完全相同；测试后原流程完全未变，副本仅版本号/更新时间增加，节点、连线、便签内容及绑定与测试前一致 | [验收摘要](../artifacts/dify-ui-evidence/desktop-verification.json) |

本轮桌面运行 ID：`ae0ef976-003f-4770-8c0d-fe26569f7a5f`；状态 `success`；引擎为 Graphon `0.7.0`。输入为普通验收文本，无付费模型调用。便签样式截图在临时 Markdown 编辑期间保存，验收完成后已通过撤销恢复副本原文字。

## 7. 本轮边界

1. 便签采用安全轻量 Markdown，支持标题、粗体、列表和行内代码；**不是 Dify 的所见即所得富文本编辑器**，不包含其全部字号、斜体、删除线、链接等工具。
2. SVG 与画布共享内容语义和主要样式，导出换行使用浏览器字体测量；不同 SVG 查看器的字体可用性仍可能影响最终排版。
3. Dify 参考研究只覆盖现场文档所列菜单和已有节点；没有逐个验收 Dify 所有节点、工具、发布、失败重试及全部高级选项。
4. 本轮是既有插件的界面细化与相关回归，**未宣称已完成全部 Dify 功能复刻**。功能缺口继续以 [Dify 画布能力对照](Dify画布能力对照.md) 为准。
5. macOS Apple Silicon 安装包已构建；本轮未新增 Windows 或其他平台的桌面运行验收，也未借界面改版替代外部付费模型或 MCP 服务的专门验证。
