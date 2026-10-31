# Secret 隔离可行性与当前安全边界

日期：2026-10-17。范围：现有 PRD v0.0.2、插件源码、已安装 DeepSeekHarness 0.2.0-rc.2 SDK 与 macOS 签名信息。未读取真实密钥、未修改宿主配置、未建立凭据库。

**当前仍未交付可保管和使用 Secret 的安全提供方。** 本轮交付的是能力核查报告、ENV 面板的动态不可用原因，以及禁止 Secret 进入普通数据通道的回归验证。报告里“检测到接口”不等于“隔离已通过”；不得把这些检查项记为安全保管验收。

## 1. 已确认的现状

| 位置 | 可复核事实 | 对实现的约束 |
| --- | --- | --- |
| [PRD v0.0.2](../PRD-v0.0.2.md)第 6 节 | Agent 不可读范围包括主 Agent、节点 Agent、审查/修复任务及工具、文件和运行通道 | 只限制工作流子 Agent 不足以满足完整要求 |
| [变量状态](../src/shared/workflow-variables.ts) | Secret 声明不可配置或使用；普通环境快照排除 Secret | 未建立可信提供方前继续关闭录入和消费 |
| [变量 schema](../src/shared/workflow-validation.ts) | Secret 只接受声明字段，不接受 value、binding、ciphertext 等材料 | 导入、保存和 Agent 提案不能成为旁路 |
| [原生子 Agent](../src/host/native-agent.ts) | 独立上下文、原生工具过滤、child-scoped 约束已接入 | 不据此推断主 Agent、后台 shell 或其他工具受到同等约束 |
| 已安装 `dsh-credentials` README | 有 resolve/describe/set/unset 和按 scope 管理的 record 接口 | 可以复用状态与管理契约，不能默认把 resolve 结果交给通用 Host |
| 已安装 `dsh-credentials-local` README 第 12、115、212 行 | 本地凭据文件仅属主可读，但同 UID Agent 仍可读取；未随附 Keychain/KMS 提供方 | chmod、隐藏路径、普通 `.env` 都不是 Agent 隔离 |
| 已安装 `dsh-sandbox-local/lib/index.js` 第 67—74 行 | macOS profile 为 allow default 加 deny file-write，并允许部分写入根 | 当前 read-only 不限制读密钥，也没有建立进程和 IPC 隔离 |
| 已安装 `dsh-fs-sandbox` README 第 12 行 | 限制文件写入与编辑，保留本地文件读取行为 | 文件工具仍需额外安全边界 |
| 已安装 `dsh-tools` 类型定义 | 存在 restrict 和单调拒绝 guard；scope 注册与继承过滤有不同语义 | 真实调用入口和所有受管路径必须验证，不能只检查 UI 工具列表 |

安装包证据位于 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 内 `dsh/node_modules/@deepseek-ai/` 的对应包。只检查安装代码和文档；未读取任何用户凭据文件。

主应用可执行文件显示 Hardened Runtime 标记，同时含 `allow-jit`、`allow-unsigned-executable-memory`、`disable-library-validation` entitlement。这些不是已存在漏洞的证明，但足以说明不能只凭“应用已签名”把通用 Node/Electron 解释器认定为独占可信的明文密钥消费者。

## 2. 本轮能力报告

[Host 检查器](../src/host/secret-boundary.ts)通过实际 Cordis `ctx.get()` 获取注册服务，核对凭据、沙箱、工具 guard 的接口形状，并识别已知本地凭据类；不调用凭据解析、枚举、读取、写入或沙箱执行方法。

[公开数据契约](../src/shared/secret-boundary.ts)只返回时间、闭合枚举和由枚举生成的固定检查文案，不返回提供方实例、凭据名称/路径/值、原始异常或可兑换授权。未知服务或候选 broker 自报可用一律视为未核验。

公开方法 `secretBoundary()` 的 `available` 在本版本只能为 `false`。ENV 面板显示检测到的基础接口、缺少或未通过的部分，并允许重新检查；始终没有 Secret 值输入框。画布右上 ENV/系统变量的纯图标入口保持原样。

这份报告是只读诊断；它不探测正在运行的 Agent 是否已成功突破隔离，也不声称已经完成攻防测试。

## 3. 最小可落地架构

推荐新增独立 Swift 原生凭据代理，由它完成存储、可信录入、授权、认证 HTTP 和输出投影。现有画布、变量声明和运行器可保留。

```text
ENV 面板 → 打开原生安全管理界面 → Secret Broker → Keychain
                                      ↑
工作流运行器 → 绑定标识 + 有界调用参数 ───┘
                                      ↓
                 固定目标 HTTPS 请求 → 允许的业务结果
```

最低接口为状态查询、打开原生管理界面和执行限定请求。**不得提供 getSecret、decrypt、rawResolve、任意 URL fetch、任意代码或任意命令接口。** 原值不进入通用 Node Host、Graphon、子 Agent、代码节点、环境变量、命令行、stdout、日志或持久运行记录。

| 部分 | 最小实现 |
| --- | --- |
| 存储 | Keychain 访问权限仅授予专用原生 broker；不授予 shell、`security`、Node 或通用解释器 |
| 录入 | broker 自己的原生安全输入界面；输入值不返回网页或插件 JS；保存后不提供明文回读 |
| 授权 | broker 自己确认真实协议、域名/端口、路径/operation、方法、认证槽位、业务字段和期限；不接受 caller 的 `approved=true` |
| 消费 | broker 自己发起限定 HTTPS；首批仅 Bearer/API-Key 认证头；禁止 Secret 通用插值和任意请求体注入 |
| 返回 | 声明过的业务字段白名单；拦截已知凭据回显；不返回原始响应、认证头、网络诊断和异常堆栈 |
| 撤销 | 立即阻止新调用；已发出请求如实记录，不能假称撤回 |
| 失败 | 签名、Keychain、授权、目标或输出检查不通过即拒绝；不回退到 local provider、进程环境或其他账户 |

接收认证的服务属于用户批准的信任边界。任意服务端变换后的秘密内容无法靠通用字符串替换保证检测；只允许经过明确输出契约审查的消费者。

## 4. Ad-hoc 签名原型能做什么

不必等待长期 Developer ID 才能编写并验证原生原型，但不能把“做了 ad-hoc codesign”直接等同于可靠的 Agent 隔离。

可以在专用测试 helper 上启用 Hardened Runtime、关闭调试与加载任意代码的 entitlement，使用精确代码身份核对文件完整性，并研究传统 Keychain ACL 对该可信应用的访问控制。每次更换二进制须重新核对 designated requirement/CDHash 与实际 ACL，不得只信任可被任意人重复签出的 bundle identifier。

Apple 推荐新实现优先采用 `SecItem` 和 Data Protection Keychain；其访问组来自代码签名 entitlement。传统文件 Keychain 的 ACL 和现代访问组不是同一个机制，原型需要明确采用哪一个，不能把命令行 Keychain 成功存取当作访问组隔离验收。[Apple TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)、[Keychain 访问组](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps)。

必须逐项处理以下绕过问题：

| 攻击路径 | 需要的防线 |
| --- | --- |
| 同 UID Agent 直接运行同一个可信 broker | Keychain ACL 会认出同一个程序，不能识别启动意图。程序绝不能有明文输出模式；管理动作只能由原生可信 UI 完成 |
| 将恶意 helper 重签为相同标识 | 核对实际代码要求/精确代码身份；变更后失效并重新授权。签名检查不能只比 identifier |
| 修改普通磁盘 grant JSON | 普通文件中的授权不是权威。授权由 broker 保护保存；或由仅 broker 可用的完整性密钥认证，回放、版本与撤销也需检查 |
| 给 Node 注入脚本后调用 IPC | 不把 Node 签名视为插件身份。传入 workspaceId/nodeId/runId 只是数据，不能证明来源 |
| 伪造 Unix socket 客户端、PID 或 actor | 需要真实进程身份校验；同 UID 与本地 token 文件不足。XPC 可核验对端的代码要求，但仍需限制可信客户端本身的解释能力 |
| 用辅助功能、浏览器调试或系统自动化点击授权 | 可信管理界面及人类确认必须防止受管 Agent 自助授权；必要时采用系统用户存在校验，并验证 Agent 无法代替完成 |
| 通过 broker 的合法请求回显密钥 | 固定服务/操作、受信任输出契约、业务字段白名单及回显拦截共同约束 |
| 任意本机进程使用已有 grant 反复执行 | 不透明 ID 不是使用权限。需可信运行票据或每次明确原生确认，不能仅凭持有 ID 免确认 |

XPC 的 peer requirement 能对消息来源执行代码身份检查；它不能自动区分通用解释器中的可信插件代码和 Agent 注入脚本。[Apple XPC peer requirements](https://developer.apple.com/documentation/xpc/xpc_connection_set_peer_requirement)。

## 5. 无需修改宿主的受限模式与需要宿主支持的部分

**可先作为独立插件扩展原型实现：** broker 持有密钥，每次执行在自己的原生界面展示实际目标/操作并取得确认，然后自己完成请求，只返回业务结果。主 Host 不持有 Secret，也不签发免确认授权。这样无需先改写画布或整个宿主，但仍要验证 broker 签名/ACL、原生确认不可由受管 Agent 绕过、调用输出和失效行为，才可开放真实录入。

**透明后台使用需要额外可信入口：** 若一次授权后要让工作流无人值守执行，需由可信原生控制器签发绑定调用者、运行、节点、参数、时效和重放规则的票据，或使用有同等保证的代理授权机制。普通 Node RPC、项目内 token 文件、可编辑 grant 或 Agent 提交的 ID 不满足这一点。可以新增原生配套组件，而不必重写宿主全部功能；但当前插件尚没有该可信组件。

当前“主 Agent 仍有任意本机命令能力”的条件下，不能宣称一个 TypeScript 插件能隔离同 UID 的所有进程。产品承诺针对受管 Agent 通道，不包含已控制操作系统管理员或恶意宿主插件；同样不能用这一威胁模型排除产品实际开放的 shell/MCP/自动化旁路。

## 6. 交付与测试边界

[Secret 回归](../tests/secret-boundary.test.ts)覆盖：服务不存在/异常、伪造 provider 可用声明、报告字段白名单、Secret schema、元数据、手写引用、导入导出、运行快照和草稿拒绝。

[真实 Cordis Host 夹具](../tests/fixtures/secret-boundary-host-fixture.ts)加载生产 Host 类，调用公共 get/list/save/secretBoundary 及实际注册的 Agent get/list/save 工具，验证注入 Secret 材料被拒绝、没有触发凭据读取、返回中没有测试值或测试凭据路径。它使用模拟凭据服务与随机临时目录，不是安全存储或真实模型攻击验收。

未来 broker 必须使用专用合成密钥和受控 HTTPS 服务完成真实宿主验收：主 Agent/子 Agent 的文件、shell、Keychain 命令、伪造 IPC、grant 篡改、重签名、Node 注入、动态目标、回显、撤销与重启。未完成前继续禁止真实 Secret 录入，不能只凭单元测试解除阻断。
