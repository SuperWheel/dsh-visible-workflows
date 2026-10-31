# 早期接管与严格 Node 隔离验收

> 源码清理说明（2026-10-17）：本页所述旧全局隔离实验代码已归档并从当前源码移除，以下实现与测试结论保留为历史记录；失效的源码链接改记原路径，不代表这些入口仍可使用。清理后的构建、安装与验收进度见[当前验收记录](10-DSH021适配与Secret管理请求验收.md)。

日期：2026-10-17。对象：当前工作区源码、已安装 DeepSeek Harness 0.2.0-rc.2、macOS arm64、Harness 内置 Node 24.18.1 / Electron 44.0.0。沿用原画布、节点批注、环境变量入口与 JSON/ZIP 格式。

**本路线已按用户最新要求停止，本文保留为历史实验记录，不再作为 Secret 功能的发布前置条件。三次生产尝试均已回滚，当前普通 Desktop、新会话与 CLI Worker 入口已恢复。第三次已验证原画布、缺失配置弹窗和真实 JSON 导出，但新会话失败，因此整轮未通过；Secret 仍未开放。**

后续范围调整为工作流变量接口层：用户可正常读取、写入、编辑和删除自己的 Secret，Agent 只获得不透明引用，受控执行节点在后端使用值。不得以此功能改造或限制 DSH、其他插件、普通变量或用户操作；不再追求对同一用户下任意本机原生插件代码的全面隔离。以下全局启动接管、固定消费者图、服务停用及第九 companion 的后续扩展均已停止，原测试结果只说明对应实验的实际结果。

用户随后选择使用系统凭据能力，新方向为 macOS Keychain / Windows Credential Manager 和独立原生管理窗口，支持用户查看、编辑、删除及正常粘贴。普通系统环境变量不作为 Secret 存储；Windows Credential Manager 不等于 Windows Hello 认证，Windows 实机尚未验证。新接线仍在实现，详见[变量级保护边界](../原理/11-Secret变量级保护边界.md)。

[返回手册](../README.md) · [前轮组件验收](07-免签名隔离接线与组件验收.md) · [Secret 与导入导出](06-Secret隔离与导入导出兼容验收.md) · Host 接线说明（原路径 `host-extensions/dsh-secret-isolation/BOOTSTRAP-INTEGRATION.md`，已移除）

## 1. 本轮修正了什么结论

| 前轮结论或未决问题 | 本轮证据 | 当前结论 |
| --- | --- | --- |
| 普通 profile 插件没有外部 prepare 入口，因此必须修改上游启动器 | 实际 Loader 支持唯一根入口先安装边界、再延迟 import 原消费者；真实 `desktop-host.main → runProfile → boot` 探针收到 ready IPC | 上游 prepare 接口是可选路线。普通 YAML 同级顺序仍不是屏障；首次生产切换暴露欢迎页兼容问题，已回滚，不能把 ready IPC 当成桌面可用 |
| 禁止 `posix_spawn` 后 Electron/Node 不兼容 | 相同严格规则下，Harness 内置 Node 与普通 Node 的合成固定 worker 共 24 个场景通过 | 旧启动失败未复现，不能再归因于这条限制。没有删除 fork、setsid、setpgid、posix_spawn 拒绝规则 |
| 原 Harness 直接进程退出能否代表全部工作负载退出 | 严格 worker 使用 guardian/watchdog、独立状态通道及退出确认；guardian 崩溃时即使探针观察到无残留，Host 仍拒绝宣告完成 | 固定、禁止派生进程的 worker 已有可信封装。不能扩大成任意 shell、CLI 或 MCP 已受控 |
| ZIP、自动文件读取等是否仍绕过公共 fs | 分别为官方 skills/文件引用、工作流资料与证据、ZIP 读写/清理接入受限文件效果 | 已完成对应组件及主／子 Agent 合成文件拒读验证；原消费者图在显式关闭未适配能力后完成 scratch 启动。生产切换与真实凭据验收仍未完成 |

07 文档保留其当时的调查和测试记录。涉及上述两项历史结论时，以本页的新证据为准。

## 2. 真实组件验证范围

下表“通过”只对应这一行列出的组件、配置和输入，不代表生产保护模式可用或 Secret 已开放。测试资料、受保护文件和攻击标记均为合成数据，没有读取真实密钥，没有调用模型。

| 验证对象 | 实际执行与结果 | 证据及限制 |
| --- | --- | --- |
| 单根启动屏障 | 实际已安装 boot、Loader、Include、Tools 和私有 LocalSubprocessRuntime；消费者 import 发生在边界 active 之后，保留原配置，准备失败阻断消费者 | [root-entry.json](早期接管与严格Node证据/root-entry.json)；scratch 激活树，`desktopActivated:false`、`secretReady:false` |
| Desktop 启动链 | 实际 `desktop-host.main` 与 `runProfile`，仅将固定 TCP 端口替换为 `listen(0)` 选出的临时端口；`bootActive:true`、`readyIpcReceived:true`、退出 0 | [desktop-main.json](早期接管与严格Node证据/desktop-main.json)；scratch 官方 profile。Office 返回明确不可用，未适配消费者被显式禁用；这不是完整生产配置运行验收 |
| 原生产消费者图的 scratch 启动 | 实际已安装 `desktop-host.main → runProfile`，在内存中组合原 190 行 profile 配置，完整核验运行时后再从固定入口 URL 加载原消费者；`bootActive:true`、`readyIpcReceived:true`、无 fatal/超时、退出 0、启动未就绪列表为空 | [desktop-full-graph.json](早期接管与严格Node证据/desktop-full-graph.json)；运行时完整核验耗时 1,959 ms。沿用原模块图并显式关闭下列未适配能力，不表示 190 个插件全部启用；使用 scratch HOME/数据/端口，未改生产 profile、未调用模型，Secret 仍关闭 |
| 欢迎页设置修复后的消费者图 | 复用固定哈希的官方设置表单投影与秘密脱敏，仅提供活动配置的只读描述；实际 Desktop main 欢迎页读取所需的 `settings/describe`、`llm/listConfigurableProviders`、`credentials/describe`、`account/getState` 四项 RPC 通过，启动无 fatal、退出 0 | [desktop-full-graph-with-welcome.json](早期接管与严格Node证据/desktop-full-graph-with-welcome.json)；运行时核验 2,358 ms，未记录配置值。该探针仍使用 scratch Host，没有验证生产 renderer、画布或模型；完整桌面验收另行进行 |
| 客户端声明依赖闭包 | 在实际注册的 62 个客户端入口与经官方源码哈希核验的 9 个静态根入口之间检查声明依赖，缺失项为空；欢迎页四项 RPC 继续通过 | [修复后报告](早期接管与严格Node证据/desktop-client-dependencies-fixed.json)。仅停用缺少终端 provider 的 `ui-sidebar-terminal`；没有虚构 provider。此项是声明依赖检查，尚未执行真实 renderer，不替代界面验收；[原始缺失依赖报告](早期接管与严格Node证据/desktop-client-dependencies-before.json) 另存 |
| 主／子 Agent 组件继承 | 实际 boot、Loader、SessionProjection、SandboxPolicy、AgentLoop、spawn-in-process 与 Tools 创建 3 个 Agent；工作流子 Agent 获得 1 次准确绑定，内置 timestamp 桥实际执行；其他 scope、同名替换、执行器篡改、取消及撤销均拒绝 | [agent-inheritance.json](早期接管与严格Node证据/agent-inheritance.json)；7/7，模型请求 0，结束时 Agent 剩余 0。这是组件授权与继承验证，不是 OS 受限执行、真实模型或生产 Desktop 凭据拒读验收 |
| 主／子 Agent 的真实文件拒读 | 实际官方 `read` 工具经当前可信组合 → 严格监护 → MXC → 官方 FsLocal 执行；主 Agent 与原生工作流子 Agent 都能读取普通文件，均拒绝保护文件的绝对路径及工作区 symlink，返回值不含合成保护标记 | [agent-files-isolation.json](早期接管与严格Node证据/agent-files-isolation.json)；9/9，20 次受控文件 worker 启动、60 个观察进程无残留，Agent 剩余 0。创建子 Agent 后在模型调用前取消；这是实际组件与 OS 的合成路径验收，不是真实密钥或生产 Desktop 全路径验收 |
| Node 严格策略兼容 | Harness 内置 Node、普通 Node 各 12 个场景，共 24 个；含文件、线程、FD7、取消、超时及崩溃 | [node-compat.json](早期接管与严格Node证据/node-compat.json)；普通 Node 的动态库与 OpenSSL 配置有单独约束，生产固定 worker 优先复用 Harness 内置 Node |
| Host 严格监护封装 | 正常与 FD7 完成、超时、取消均收到可信 `quiescent` 和退出确认；guardian 崩溃路径按预期拒绝完成 | [strict-node-launcher.json](早期接管与严格Node证据/strict-node-launcher.json)；5 类场景。崩溃案例的 `confirmed:false` 是失败关闭结果，不能算成功执行 |
| IPC、GUI 服务与继承 FD | 实际 Harness Node、严格 launcher 和合成 N-API worker；普通文件可读，保护文件、IPv4/IPv6/Unix socket、额外继承的文件/socket FD 被拒绝；WindowServer active、剪贴板、LaunchServices 与 SecurityServer 在无隔离时可用、隔离后拒绝，系统 logger 保留 | [ipc-gui.json](早期接管与严格Node证据/ipc-gui.json)；14/14，7 个观察进程无残留。`com.apple.windowserver.session` 在外部对照中已不可用，因此没有把它计为有效拒绝或兼容性证明；这也不是全部 GUI 自动化和任意 IPC 通道的证明 |
| Graphon 缓存完整性 | 实际 Harness 加载固定哈希归档并执行工作流；同一 Bridge 下次启动拒绝已修改的 Python 文件和额外 `.pth`，攻击哨兵未执行 | [graphon-integrity.json](早期接管与严格Node证据/graphon-integrity.json)；3/3，固定归档 2,626 个文件，观察子进程 1 个且无残留，模型请求 0。每次新建 Graphon 子进程重验内容；这是可信运行时完整性检查，不把 Python 直接启动描述成严格 Node worker 的 OS 沙箱 |
| 现有 Desktop Graphon 缓存兼容 | 只读核查现有缓存中的 2,626 个分发文件、允许的 `ready.json` 及 340 个目录；缺失、额外文件、内容、大小、类型、链接、owner、mode 差异均为 0 | [existing-graphon-cache.json](早期接管与严格Node证据/existing-graphon-cache.json)；`strictCompatible:true`。当前缓存可复用，无需为接入保护模式重建工作流或清理数据；未运行 Python、修改缓存或开放 Secret，后续运行仍逐次复核 |
| 工作流文件效果 | 生产构建的 document worker 读取普通资料、准备解析器输入、生成文件证据；真实 FsLocal 使用严格受管 worker；保护路径 symlink 拒读，撤销后保留引用不可再用 | [workflow-files.json](早期接管与严格Node证据/workflow-files.json)；5/5，8 个操作启动，保护标记未泄露 |
| 工作区与不可变路径政策 | 不可变目录别名、尚未创建的不可变文件别名在启动前拒绝；含运行时别名的正常工作区可读，受保护文件仍拒绝 | [workspace-policy.json](早期接管与严格Node证据/workspace-policy.json)；4/4，6 次启动，观察到的 18 个进程无残留 |
| 官方自动文件读取 | 保留官方 skill 目录/正文、bundled trustedHost 分支、文件引用排序与 AGENTS.md 逻辑；将直接 fs 效果换为受限 provider，阻断保护目录 symlink 与缓存路径替换 | [automatic-files.json](早期接管与严格Node证据/automatic-files.json)；7/7，52 个一次性 MXC 文件 worker。该组早于严格监护接线，不作为该接线的退出证明；原生文件 watcher 明确关闭 |
| 普通 HTTP 效果 | 官方完整 URL/IP/DNS 校验、真实 Undici 地址固定直连；私网、回环、映射 IPv6、混合 DNS、DNS64/NAT64 拒绝，公共 HTTPS IP 请求成功 | [public-http.json](早期接管与严格Node证据/public-http.json)；7/7，本机 IPC/代理陷阱请求数 0。没有携带凭据，也不代表网络 MCP 已覆盖 |
| ZIP 文件效果 | 真实 Harness、严格监护与 MXC 中导出公开附件、导入、清理；即便请求声称保护目录是工作区，读取/写入仍拒绝；持有正确 owner receipt 也不能清理受保护目录 | [workflow-archive.json](早期接管与严格Node证据/workflow-archive.json)；8/8，9 个操作 worker，监护器失败 0，保护标记未泄露 |

允许 fork 的固定进程组实验另有失败证据：10 轮并发 fork 取消中 2 轮仍有后代存活。因此没有将这条实验路线用于通用进程接线。[失败报告](早期接管与严格Node证据/fixed-group-failed.json) 与 [后续清理复核](早期接管与严格Node证据/fixed-group-post-cleanup.json) 分开归档；兜底清理不会把失败改写为通过。

首次完整图验证保留 15 个明确限制项，没有用伪造服务将它们标成可用：`plugin-manager`、`tool-plugin-manager`、`hmr`、`client-hmr`、`config-editor`、`cordis-host-runner`、`workspace-changes`、`settings`、`cordis-inspect-providers`、`ui-deliverables`、`terminal-controller`、`directory-picker`、`office-to-pdf`、`cliworker-now`、`dsh-external-workflow`。欢迎页修复后，将 `settings` 替换为受限只读 companion，其余 14 项继续禁用；客户端启动修复再停用 `ui-sidebar-terminal`，最新候选仍为 15 个明确限制项。设置写入、准备配置文档和原生打开入口仍拒绝。插件安装/配置写入/热更新、运行时检查、变更及交付物卡片、原生终端/目录选择、Office 与未适配外部执行能力暂不可用；原配置保留。探针另关闭 `desktop-product-telemetry` 和 `product-analytics`。报告中的停止阶段 `inactiveConsumers` 记录来自 ready 后主动 shutdown，不改写成启动失败，也不删除这些原始记录。

## 3. 本轮实现与撤销修复

- 单根入口恢复原 profile 的配置与解析关系，先安装公共 fs/subprocess/sandbox 边界，再加载审核过的消费者。固定模块和实际依赖仍须纳入完整性清单及 OS 防写范围，入口文件哈希不能单独证明整个依赖图可信。
- `createStrictNodeLauncher` 只接受登记过的固定 worker、固定脚本参数及受限 Node flags。策略编译本身也受监护；状态通道与 worker 数据分离。不能确认退出时，封闭后续启动并撤销组合。
- 普通文件、工作流资料/证据和 ZIP 操作分别通过固定效果入口运行。工作区权限来自已注册工作区，不能因请求传入某个 `cwd`、root 或 JSON 路径就授权。
- 修复了“文件读取开始后撤销，Promise 完成时仍交付结果”的问题。同步结果、Promise 成功/异常及 AsyncIterable 每个片段交付前都会复查；取消迭代器的异常不透传。
- 显式撤销与受保护服务替换共用可信 `onRevoke` 停机路径：取消组合 lifetime、关闭 gate、停止严格 launcher 和公共进程，再移除 facade。重复或重入撤销共用一次停机，不相互等待造成死锁；未确认停机继续拒绝使用。
- 补齐 Cordis `set()` 静默替换的防护：seal 时冻结真实服务登记记录，保存隔离 scope、登记记录、服务值、owner 和 check 的身份；已接管的工具 guard、文件/进程效果和报告查询复核身份，发现改变即撤销。只冻结登记记录，工具注册和服务自身正常状态仍可变化。当前没有发现 Agent 可达这一 setter 的实际路径；此加固不等于在同一 Host 进程中隔离任意恶意原生代码。
- Graphon 从同一份已核验的归档字节派生目录/文件/type/mode/size/hash 完整清单，拒绝符号链接、非独占文件及额外文件。坏缓存直接拒绝执行；固定运行时资产仍须纳入启动完整性清单与 OS 防写范围。前后元数据复核不被描述成面对同 UID 恶意并发改写的原子快照。

撤销的 Promise/流交付与重入行为由 `host-isolation-boundary.test.ts`、`workflow-composition-lifecycle.test.ts` 覆盖。后者使用真实 Cordis 与边界组合，但监护器停机证明层为明确替身；不把它计作新的 OS 攻击验收。真实严格监护证据见第 2 节。

普通 HTTP 保留 `text/body/status_code/headers/json` 返回契约，使用独立直连 dispatcher，手动处理重定向，限制请求与响应正文为 2,000,000 字节，过滤连接控制/代理头和敏感响应头。本机 DNS 会将 `example.com` 解析为 benchmarking fake-IP；官方策略正确拒绝，因此正向联网使用证书有效的 `https://1.1.1.1/cdn-cgi/trace`。这不证明 fake-IP/代理网络兼容，也不会自动降级到代理。

## 4. JSON、ZIP 与画布兼容

| 项目 | 本轮保留或新增的规则 |
| --- | --- |
| 可视化结构 | 节点类型、节点坐标、视口、便签和节点批注继续按原 schema 往返；ZIP 探针验证了坐标/视口/批注及文件槽位迁移 |
| Secret | JSON/ZIP 只迁移声明与受控操作引用；导入产生目标变量身份，不能继承来源或被覆盖流程的凭据授权。普通变量是否带值仍由导出选项控制 |
| 文件本体 | JSON 保留依赖声明并清理来源机绑定；ZIP 在受限 worker 中读取和写入实际附件，保留 SHA-256、节点/字段/索引绑定校验 |
| 既有上限 | ZIP 32 MB、单文件 8 MB、附件总计 16 MB、最多 200 个附件；新增进程协议以 48,000,000 字节限制 JSON/base64 总量，没有放宽 ZIP 格式本身 |
| 失败与清理 | Host 生成随机 `workflow-assets-UUID` 与 owner receipt，闭包绑定可信 root。receipt 不进入 workflow JSON；内部目录标记只用于回滚身份检查。取消后先确认旧 worker 已退出，再以新的受限 worker 清理；无法确认时明确失败关闭 |
| 缺失配置 | 仍可直接导入画布、保存未完成工作流；节点警告和右侧待处理清单保留，点击运行后提示先处理缺失值。没有额外草稿区，也没有改成直接禁用执行按钮 |

本轮导入导出与隔离专项为 6 个测试文件、47 项全部通过，覆盖 JSON 往返、依赖映射、Secret 迁移、缺失配置 UI、隔离运行时及准确绑定的工作流工具。生产画布、批注和历史的 [30 个文件切换前哈希基线](早期接管与严格Node证据/desktop-state-before.json) 已与 [首次失败启动及回滚后结果](早期接管与严格Node证据/desktop-state-after-first-rollback.json) 对照，30 个文件全部未变。这证明该次失败尝试没有改动这些文件，尚不能宣称保护模式中的生产 UI 和导入导出验收完成。

文件元数据、owner marker、哈希和 realpath 检查是额外核对，不宣称它们独自解决可变父目录的 TOCTOU。保护目录不能被读取、写入或清理的保证依赖实际 OS 限制。异常中断若没有足够回滚证明，会报告未确认；不通过 Host 直接 fs 补做越界清理。

JSON/ZIP 格式兼容、Secret 重新配置与运行授权是三件分别验证的事情。包能正确打开并保留画布，不代表目标端密钥已配置或全局隔离已就绪。

## 5. 生产状态与未完成验收

| 状态 | 当前结论 |
| --- | --- |
| 生产 Desktop 配置 | 第三次尝试后也已回滚，普通 Desktop 重新启动且新会话创建成功，CLI Worker 入口恢复；全局接管路线停止。普通 Workflow 包保留，helper 仅为已安装文件，不代表全局边界仍在运行。未替换已签名 `app.asar` |
| 原画布与历史基线 | library、editor-state 和 run/event 历史等 30 个文件在三次回滚后均全部与原哈希一致；第三次原流程实际画布及真实 JSON 导出也已核对 |
| 完整消费者图 | 原 190 行配置在 scratch Host 中启动及欢迎页读取 RPC 通过；设置为受限只读实现，加上终端侧栏后的 15 个未适配条目明确禁用，客户端声明依赖闭包通过；仍不能据此宣称生产桌面全部可用 |
| 当前构建链 | 已加入严格监护资产、固定文件/ZIP worker 和可信组合模块；同一份 410 文件、34,230,786 字节安装包已安装为普通 Workflow 插件及固定 helper，二者内容指纹一致；这不是保护模式启动验收 |
| Secret gate | 继续关闭。没有将报告字段、合成检查器或组件成功结果用作 `ready=true` 授权 |
| 主／子 Agent | 此全局实验没有完成真实凭据端到端验收。新方向只验证工作流接口不向 Agent 返回 Secret 原值，以及受控节点的后端注入 |
| 通用执行 | 前述实验模式曾限制通用 shell/PTC、CLI、PTY、网络 MCP、Office/GUI 等能力；当前生产配置已恢复，不以这些限制作为变量级 Secret 的实现要求 |
| 凭据操作 | 本轮没有录入真实密钥、进行真实生物认证、访问真实钥匙串项或执行带凭据的 DeepSeek 请求 |
| 跨平台 | 以上真实 OS 结果仅属于本机 macOS arm64；不扩张成 Windows、Intel Mac 或其他系统版本通过 |

首次失败说明完整消费者图收到 ready IPC，仍不能证明欢迎页所需的远程调用可用。[欢迎页错误日志](早期接管与严格Node证据/first-desktop-welcome-failure.log) 保留实际 RPC 错误与 `settingsAndReference` 调用栈，[首次切换与回滚记录](早期接管与严格Node证据/first-profile-cutover-rollback.json) 保留配置哈希、部署身份和回滚时间；日志自身不证明依赖诊断。修复后 [新的只读部署核验](早期接管与严格Node证据/review-with-settings.json) 已检查 8 个固定文件和 6,896 个运行时文件，待处理项为空；这只是部署准入。第二次切换继续验证真实 renderer、原画布与导入导出、旧进程清理、主／子 Agent 与其他会话继承、可达工具/回调、GUI/IPC/调试边界及原生凭据生命周期。只有这些必要门槛在真实运行中成立，才能开放 Secret。

第二次启动已越过欢迎页，但 [客户端启动日志](早期接管与严格Node证据/second-desktop-client-boot-failure.log) 明确记录唯一未激活项 `@deepseek-ai/dsh-client-ui-sidebar-terminal` 正在等待 `webTerminals`。这说明禁用 Host 终端效果时，还须同步移除依赖该服务的客户端入口。已正常退出并完成 [第二次 profile 回滚](早期接管与严格Node证据/second-profile-cutover-rollback.json)，[回滚后 30 个原数据文件](早期接管与严格Node证据/desktop-state-after-second-rollback.json) 仍全部未变。随后核查其余客户端依赖；不以伪造服务填补空缺，也不将看到插件加载窗口记为界面可用。

最新候选已只停用该终端侧栏入口，并补齐声明依赖预检中的官方静态根，62 个动态入口加 9 个静态根的缺失依赖列表为空；早期预检未纳入静态根的原始报告保留，不将其中所有缺失项都解释为产品故障。[客户端修复后的部署核验](早期接管与严格Node证据/review-client-fixed.json) 仍为 8 个固定文件、6,896 个运行时文件、待处理项为空。下一次真实窗口与画布结果另行记录。

第三次真实窗口与原画布已打开，原 Secret 流程的 3 个节点、75% 视口、便签、节点批注、环境/系统变量图标和右侧待处理列表均保留。执行按钮可点击，点击后提示先处理缺失配置且没有启动运行；原生 SavePanel 成功导出 JSON。随后创建新会话返回 `agent-preset/invalid`，因此整轮仍未通过。已正常退出并完成 [第三次回滚](早期接管与严格Node证据/third-profile-cutover-rollback.json)，恢复普通桌面后新会话成功，标准模式和 `GLM 5.3 Flash` 选择器可见，CLI Worker 入口恢复；没有把这一恢复验证记作模型调用成功。[UI 观察摘要](早期接管与严格Node证据/third-desktop-ui-observation.json) 明确标注来自协调代理的实际界面观察，没有伪造截图或工具原始报告。

[真实 JSON 导出](早期接管与严格Node证据/desktop-protected-export.workflow.json) 通过 [20 项只读核验](早期接管与严格Node证据/desktop-protected-export-validation.json)：3 节点、2 条边、1 便签、1 批注及 `{x:40,y:30,scale:0.75}` 视口与原流程完全对应；仅 `workspaceId` 和流程 `revision` 按可迁移格式清理。Secret 只有声明，没有值和凭据绑定，受控操作仍引用正确变量。内存中调用现有导入器后，各身份重新生成，节点/批注/便签引用和 Secret 操作引用正确改写；这不是一次真实 UI 导入或运行。[第三次回滚后对照](早期接管与严格Node证据/desktop-state-after-third-rollback.json) 再次确认 30 个原文件全部未变。

随后用户明确要求只保护变量接口、保持 DSH 与其他插件正常能力，全局路线停止。第九个 `protected-presets.mjs` 的部署脚本准入与旧七/八文件回滚测试已完成，但从未部署；不继续扩大固定模块白名单，不把其完成作为新方案要求。

## 6. 回归与证据索引

| 检查 | 结果与统计口径 |
| --- | --- |
| 本轮已构建源码的全量首轮 | 121 个测试文件、1,240 项；1,238 项通过，2 项因监听 `127.0.0.1` 返回 `EPERM` 失败，没有跳过或待办 |
| 监听权限复验 | 对应的 2 个测试文件、11 项全部通过；两项首轮失败均包含在这 11 项中 |
| 去重后的最终结果 | 121 个文件、1,240 项全部通过，失败 0、跳过 0、待办 0。按文件、完整用例名和同名实例序号替换复验结果，保留参数化实例，不能重复加总 11 项 |
| 构建与类型检查 | `node scripts/build.mjs` 退出 0；Host、Client、隔离扩展 TypeScript 检查通过，Host/Client/固定文件 worker/固定 ZIP worker/隔离入口与原生监护资产完成构建 |

[回归、构建与源码哈希摘要](早期接管与严格Node证据/verification-summary.json) 保存首轮和复验报告的 SHA-256、两项原始失败名称、去重口径、构建日志哈希、构建文件哈希及当前关键源码哈希。构建退出码来自同轮命令完成结果，日志文本自身不含退出码；源码哈希是归档时快照，不当作可重现构建证明。首轮原报告仍保持失败状态，没有被改写成通过。

定向回归包含文件 Promise/流撤销、组合停机、HTTP、ZIP/Secret 往返、工作区别名及既有画布和缺失配置行为。47 项导入导出/Secret 专项与全量回归存在重叠，不重复计数；真实组件探针独立记录，不能加到 1,240 项回归数量中，也不能据此开放 Secret。摘要保留此前 1,218 项回归的历史记录。

历史安装与切换脚本另有 15 项插件包恢复测试、11 项固定 helper 测试、33 项 profile 切换/恢复测试，全部在临时目录通过，不计入上面的 Vitest 总数。helper 与插件测试共用一次 26 项报告，不能把其中 15 项再加一次。profile 测试包含并发 stale lock 恢复互斥、旧锁删除前后中断均拒绝自动继续、保留后续配置修改、prepared journal 恢复，以及固定 helper 根和 worker 路径准入。最后一版实验脚本要求第九文件且允许精确旧七/八文件 journal 恢复；它没有生产部署，路线已停止。此前只读 review 正确拒绝过期运行时清单，三次实际尝试和回滚均另存；这些实验脚本不再作为变量级方案的发布要求。

新增 [只读设置适配 6 项测试](早期接管与严格Node证据/readonly-settings-tests.tap) 全部通过，覆盖固定源码、同一树及活动配置、嵌套与数组 Secret 脱敏、所有写入/文档迁移入口拒绝，以及撤销和身份歧义失败关闭。这 6 项同样独立于上述 Vitest 回归统计。

上述构建的全量回归、真实 Agent 两组组件复验和原消费者图 scratch 启动均已完成。此前 `typert-loader` 命中旧依赖的问题来自探针的 base URL 与 runtime scope 错配，二者一致映射后通过；生产 driver 继续使用原 profile base/scope。首次实际安装包 SHA-256 为 `752044906c7ecb1c7a8d7ff2f7a3d469cb44ec12ed62728d77c997a272398d1c`，普通插件的 [实际安装记录](早期接管与严格Node证据/plugin-installation.json) 与 [固定 helper 安装记录](早期接管与严格Node证据/helper-installation.json) 分别归档。欢迎页兼容修复采用新增固定 companion 的方案，后续候选生成与生产复验尚在进行，本报告不提前宣称最终完成。

固定 helper 位于 `~/.dsh/dsh-runtimes/visible-workflow-isolation/<包 SHA-256>/package`，内容只来自与当前已安装插件完全一致的已核验 npm 包，它不是另一个 Host 或替代画布。这样固定 worker 不必从被保护的 profile 目录加载，整个 profile 的 Agent 读取拒绝规则保持不变。helper 安装默认只读 review，显式 install 才建立哈希目录；已有完全一致副本可复用，未知内容、symlink/hardlink 或与插件不一致均拒绝。正式候选须以这些实际安装路径重新生成 preflight/完整性清单；cutover apply 还会核查受管 SHA 根及三个固定 worker 的归属，不能用仓库组件候选代替生产部署候选。

证据目录：[早期接管与严格 Node 证据](早期接管与严格Node证据/manifest.json)。清单记录原始路径、字节数和 SHA-256，组件 JSON 与生产数据哈希基线按原字节归档，包含失败反例；另列派生的回归/构建摘要。不改写原报告中的 `secretReady:false`、限制或失败字段。

主要代码入口：可信组合（原路径 `host-extensions/dsh-secret-isolation/workflow-composition.ts`，已移除）、严格 launcher（原路径 `host-extensions/dsh-secret-isolation/strict-node-launcher.ts`，已移除）、HTTP 适配（原路径 `host-extensions/dsh-secret-isolation/public-http-adapter.ts`，已移除）、ZIP 效果（原路径 `src/host/isolation/workflow-archive-effects.ts`，已移除）、ZIP worker（原路径 `src/host/isolation/workflow-archive-worker.ts`，已移除）。
