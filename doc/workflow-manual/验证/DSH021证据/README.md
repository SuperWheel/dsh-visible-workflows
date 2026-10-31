# DSH 0.2.1 适配与 Secret 验收证据

日期：2026-10-17。以下记录由本轮实际安装、限定字段检查、测试摘要及用户确认整理，供[第 10 篇验收报告](../10-DSH021适配与Secret管理请求验收.md)引用。它们不包含系统凭据原值、完整 profile 快照、原始日志、完整运行文件或聊天会话。

| 文件 | 内容与证据边界 |
| --- | --- |
| [首次适配安装](first-installation.json) | 首次包、安装前后树及 profile 哈希；路径改为 `$DSH_HOME`，不包含配置正文 |
| [请求入口修复后的安装](preflight-fix-installation.json) | 第二包及安装身份；该包完成本轮 HTTP 401 验收，不代表后续旧方案清理产物 |
| [Typert 协议核对](typert-build-verification.json) | 50 个 Remote 方法、双端 schema、SDK owner 和产物哈希 |
| [定向回归摘要](regression-summary.json) | 19 文件/272 项和另一次 3 文件/38 项结果；含来源日志哈希，不复制原始日志，不将两次计数相加 |
| [查看、修改与数据保留](desktop-crud-progress.json) | 用户确认重开显示新值；另 7 个流程哈希不变；源 v6 结构、持久化视口和首轮请求入口误拦记录 |
| [真实 HTTP 401 运行](http-401-run.json) | 一次真实运行的身份、时间、状态码和字段检查；不包含输入原值或响应正文 |
| [原生删除与缺失引导](delete-acceptance.json) | 用户确认删除，画布恢复 1 项缺失提示，执行按钮可点击并弹缺失对话框，无新运行；源定义保留 |
| [Desktop 阶段观察](desktop-stage-observation.json) | 协调 Agent 的界面观察与用户明确确认；区分已完成、未另做的导出往返以及新授权/清理事项 |
| [profile 元数据同步](profile-metadata-sync.json) | 插件 source/lock 更新的前后哈希、限定字段及事务检查结果；其他插件语义不变，未收录完整 profile |
| [持久授权产品决策](persistent-authorization-decision.json) | 用户已选一次授权持续有效、手动撤销及凭据/目标变更后重新授权；并关联已完成的实机范围与未重复人工路径 |
| [全量回归首次摘要](full-regression-initial-summary.json) | 保留 96 文件/992 项中 990 项通过、2 项 localhost EPERM 的首次结果；同时注明后续复跑已解决 |
| [localhost 许可复跑](localhost-regression-rerun-summary.json) | 仅对受影响的两文件复跑，11 项全部通过；与原全量计数重叠 |
| [最终授权回归摘要](final-authorization-regression-summary.json) | 加入 6 项导入伪造字段用例后，5 文件/84 项通过；不与其他组简单相加 |
| [冻结的持久授权原生检查](persistent-native-verification.json) | 10 组、74 断言、7 个确认退出子进程；沙箱 probe 为 runtime_unsafe，无认证、Keychain 或网络 |
| [持久授权完整构建](persistent-build-verification.json) | Host/client 构建、50 个双端 Remote 方法及旧生成入口移除核对 |
| [持久授权新包](persistent-package-verification.json) | 363 文件新包、归档摘要、OS 后端存在及旧资产列表为空 |
| [持久授权真实安装](persistent-installation.json) | 原 Desktop 插件目录实际安装；UI/授权结果以独立证据核对 |
| [持久授权包来源同步](persistent-profile-metadata-sync.json) | 仅本插件 source/integrity 更新，SDK 与其他依赖不变；不包含 profile 正文 |
| [旧方案源码清理摘要](retired-source-cleanup-summary.json) | 68 路径/325 文件归档移除、保留能力与阶段测试；构建与实际安装另有记录 |
| [授权前桌面观察](persistent-desktop-before-authorization.json) | 真实画布、图标、组件 ready；pending 只表示授权前时点，不是最终状态 |
| [新包数据保留](persistent-data-preserved.json) | 以源 v6 为基线，安装后原 8 份定义哈希不变 |
| [一次授权实机验收](persistent-authorization-acceptance.json) | 用户保存并授权后连续两次无再次认证；当前假值和授权保留；未重复人工路径单列 |
| [第一次自动请求](persistent-http-first-run.json) | 1.677 秒、状态 401、只有操作引用和状态结果，无值进入运行环境 |
| [第二次自动请求](persistent-http-second-run.json) | 0.988 秒、状态 401、再次执行未认证；不是有效 API 密钥认证成功 |
| [新包真实 JSON 往返](persistent-json-roundtrip.json) | 副本结构、引用、位置、视口保留，缺值/授权；可点击执行并弹提示，无副本 run |
| [证据文件清单](manifest.json) | 此目录证据文件的字节数与 SHA-256；用于识别当前归档内容 |

JSON 时间戳使用 UTC；报告正文按 Asia/Shanghai 写出用户当地时间。公开 UUID 只用于关联本次验收实体，不作为读取凭据的授权。用户在原生窗口查看与编辑的确认不能扩展为任意本机代码隔离结论；401 表明收到真实身份拒绝响应，不代表测试值是有效 API 密钥。

本目录分别保留逐次授权阶段的 CRUD/HTTP 与新包持久授权的独立证据。新包已实机验证一次授权、两次自动请求及 JSON 往返；未重复人工撤销、修改后授权、删除、重启或真实主/子 Agent 模型调用。相关回归和历史结果不能替代这些未重复路径。

[返回验收报告](../10-DSH021适配与Secret管理请求验收.md) · [手册索引](../../README.md)
