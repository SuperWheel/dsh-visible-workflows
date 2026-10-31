# 系统凭据存储组件

这是现有工作流插件的独立原生 Secret 后端。macOS 实现使用当前用户默认／登录 Keychain 的独立 service；Windows 源码候选见 [windows](windows/README.md)，尚未启用或完成实机验证。不修改 DSH、其他插件、普通环境变量、文件工具、shell、MCP、GUI 或网络权限，不依赖旧全局 isolation gate。

**2026-10-17 当前状态：持久授权源码及并发撤销修复已完成，管理窗口一次本人认证，后续已授权的固定请求无需逐次弹窗。原生组件已冻结并通过协议与拒绝路径检查；合并后的最终包已安装于真实 DSH 0.2.1-rc.1；用户一次保存并授权后，两次固定请求均未再次认证并返回 401，真实 JSON 往返也确认副本不继承密钥或授权。此前逐次授权版的 CRUD 与本版授权复用分别记录；本版未重复人工撤销、修改、删除或重启。**

## 能力与边界

- 用户通过原生窗口查看、显示／隐藏、编辑、粘贴、保存和删除 Secret。打开管理窗口时进行一次系统本人认证，该窗口内的保存、授权、撤销与删除复用这次身份确认，不再由应用逐操作重复认证。macOS 使用 `deviceOwnerAuthentication`，允许系统提供 Touch ID 或账户密码回退；程序不采集系统密码。
- 自动使用须由用户在原生窗口明确选择“保存并授权自动使用”。授权仅对应本工作流、本变量及固定请求目标，可持续有效直到手动撤销；修改凭据或目标后需要重新授权。Host 的可用状态或 Agent 传入的公开 ID 不构成授权。
- 后台 `execute` 不打开窗口、不发起系统认证；没有匹配的有效授权时直接返回 `authorization_required`，不发送网络请求。Host 将缺少值与缺少授权分别引导为待配置，用户仍可编辑和保存画布。
- 普通原值为 1–2048 UTF-8 字节，拒绝 NUL，允许 Unicode、空格及标点。存储不套用 API token 格式。固定 Bearer 消费器另按 RFC 6750 token 字符规则验证，拒绝 CR/LF 等非法 header 内容。
- 值仅在原生进程内出现；Host 和 Agent 只有声明、公开引用及状态。没有 `resolve`、`getSecret` 或返回原值的 RPC。stdin、FD3、stdout、argv、环境变量、完整性清单都不含值。
- 用户主动显示值后，屏幕、辅助功能或其他同用户程序可能看到它。此实现承诺工作流接口与数据流不提供直接读取，不承诺防御同 UID 任意代码、被攻陷的 Host 或用户主动复制／显示后的外部读取。普通 Keychain ACL 与 ad-hoc Hardened Runtime 不是全局隔离证明。
- 旧 `native/local-secret-broker`、发行签名 `native/secret-broker` 及全局隔离实验代码已归档移除，历史验收记录保留。当前后端不会自动迁移、读取或删除旧 service 的凭据；新 service 下只有用户明确创建的变量值。旧版已保存的值也不会自动取得本版的自动使用授权。

## 原生管理窗口

管理窗口只提供以下五个动作；值与授权均由已完成本人认证的原生会话处理，不接收调用方提供的“已认证”布尔值。

| 按钮 | 行为 |
| --- | --- |
| 仅保存 | 保存当前值，先撤销旧自动使用授权并轮换凭据 epoch；即使文本未变也不会保留旧授权 |
| 保存并授权自动使用 | 在同一窗口保存值，再对新的 epoch 和明确显示的固定目标授权；校验 Bearer 语法 |
| 撤销自动使用 | 保留凭据值，移除自动使用授权，后续执行必须重新授权 |
| 删除 | 经过原生删除确认后删除值与授权；不重复发起本人认证，不删除工作流变量声明 |
| 关闭 | 不提交编辑、不保存新授权；窗口会话随关闭失效 |

“仅保存”支持通用密码格式；“保存并授权自动使用”还要求满足固定 Bearer 消费格式。授权不扩大为任意 API、URL、请求头或工具权限。撤销不能撤回已经发出的网络请求；发送前与并发撤销的检查已完成源码修复和原生断言，尚未列为实机已通过。

## macOS 原生产物

| 项目 | 约定 |
| --- | --- |
| bundle | `dist/Workflow OS Secret Broker.app` |
| executable | `Contents/MacOS/WorkflowOSSecretBroker` |
| bundle ID / Keychain service | `com.deepseekharness.workflow.os-secret-broker` |
| 自动使用授权 service | `com.deepseekharness.workflow.os-secret-broker.automatic-use-authorization` |
| 最低系统 | macOS 15，构建机 arm64 或 x86_64 |
| 完整性清单 | `dist/integrity.json`：version、identifier、完整文件 path/size/sha256 集合 |
| 编入 Host 的摘要 | `src/host/os-secret-manifest.ts` 中 `OS_SECRET_BROKER_MANIFEST_SHA256` |
| 签名 | 本机 ad-hoc Hardened Runtime；不冒充 Developer ID 或 DP Keychain 专属访问组 |

账户身份为 canonical sorted JSON `{namespace, schema:2, scope:{workspaceId,workflowId,variableId}}` 的 SHA-256。nodeId 仅作调用显示；operation 不属于值的存储身份。变量改名不换身份；导入重新生成变量和流程身份，因此必须重新配置并授权。值的 payload 包含 schema、scope、binding、epoch、value；epoch 参与更新／删除比较，冲突返回 `busy`，不无条件覆盖。

自动使用授权作为独立 Keychain 项目保存，包含 schema、scope、binding、credentialEpoch 和 targetFingerprint。目标指纹由原生固定的 operation、HTTP method、endpoint、认证方式及“只返回状态码”的输出策略生成；调用方不能自行提供目标指纹。任一绑定不匹配都不复用旧授权。授权记录不写入工作流 JSON、运行快照或导出包，也不返回 Host/Agent；公开接口只返回 `authorized` 或 `required` 状态。

macOS 的传统 SecKeychain/ACL API 存在 deprecated 编译警告。当前选择是系统默认文件型 Keychain；它不等同于发行签名 broker 的 Data Protection Keychain。保存和删除的实际 CAS 行为仍须在真实系统中验收。

## 协议

stdin 为单个不超过 8192 字节的 UTF-8 JSON，写完关闭。沿用请求 version 1 和固定操作消费，严格拒绝未知键与原值字段。

```json
{"version":1,"command":"probe"}
```

```json
{"version":1,"command":"manage","operation":"deepseek.account-status.v1","scope":{"workspaceId":"workspace","workflowId":"workflow","variableId":"variable","nodeId":"environment"}}
```

`command` 允许 `status`、`manage`、`execute`；公开标识为 1–128 个 ASCII 字母、数字或 `._:-`。scope 不是调用者身份或使用授权。

| 命令 | 输出 |
| --- | --- |
| probe | `{ok:true,available:boolean,code}`；只校验本组件代码、系统证书根和认证可用性，不打开 UI、不查询 Keychain、不执行认证 |
| status | `{ok:true,state:"configured"\|"missing",authorization:"authorized"\|"required"}`；读取值的存在/epoch 属性及非密钥授权记录，禁止 Keychain 弹框，不取凭据 value；missing 必须搭配 required |
| manage | `{ok:true,state:"saved"\|"authorized"\|"revoked"\|"deleted"\|"unchanged",authorization:"authorized"\|"required"}`；saved/deleted/revoked 必须是 required，authorized 必须是 authorized；关闭返回 unchanged 及当时授权状态 |
| execute | `{ok:true,status_code:number}`；有效授权通过后只返回 HTTP 状态码；无授权返回固定错误，不发起 UI 或网络 |
| 失败 | `{ok:false,code:"固定枚举"}`；不返回原始异常或用户数据 |

FD3 使用继承 Unix socket，校验 `LOCAL_PEERPID == getppid()`。原生先发送 `{version:1,challenge}`，父进程返回 `{version:1,challenge,requestHash,parentPid}`；requestHash 为 stdin 完整字节的 SHA-256。父进程保持 FD3 打开。断开、额外数据或父进程退出终止操作。此绑定只防止请求混用并提供取消通道，不证明其他同用户程序不能自行发起请求。

请求侧没有 `authorize`、`revoke` 或明文写入命令；授权与撤销仅由 `manage` 内本人确认的动作触发。返回 `authorization` 是状态报告，不是可转移的授权凭证。`probe.available:true` 也不意味着某个变量已有值或已获自动使用授权。

stderr 关闭；core dump 禁用；整个进程 180 秒截止。父端还需对返回值执行严格 schema 和输出上限校验，并等待进程退出。取消不能撤回已经发出的 HTTP 请求。

## 固定消费者

兼容 operation `deepseek.account-status.v1`：原生自己向 `https://api.deepseek.com/user/balance` 发 GET 并注入 Bearer；调用方不能传 URL、headers、method、body、代理或代码。准确目标在原生管理窗口授权时显示；后续有效授权内的执行直接运行，不逐次弹窗。未配置、授权缺失/失效或系统凭据不可访问时明确失败，不退回逐次认证或普通 HTTP。

保留固定系统 TLS 根验证、禁跳转、禁缓存与 cookie、禁代理继承、无自动重试和网络截止。收到状态头立即取消正文，不向 Host/Agent 返回余额、header、错误正文或 token。Host 的 `ok` 如由 2xx 推导，仅表示 HTTP 成功，不代表余额充足。此组件还不是任意 HTTP Secret 插值器。

## 构建和已完成验证

```sh
node native/os-secret-broker/build.mjs
ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' native/os-secret-broker/tests/verify.mjs
```

构建只编译、打包、ad-hoc hardened 签名、严格验签并生成摘要，不安装、不运行管理窗口、不认证、不访问 Keychain。每次重建原生组件后必须同步重建 Host；不能从旁置可变清单自行建立信任。

以下是 2026-10-17 **此前逐次授权版本**的组件历史结果，不代表当前持久授权版本已通过相同实机检查：

- Swift 编译和 strict 签名校验。
- 35 项原生协议、变量身份、UTF-8 边界和 Bearer 消费语法断言。
- 静态源码契约检查：probe 在 Keychain 分支之前返回、只检查认证可用性；标准原生 Edit menu 包含 paste/cut/copy/selectAll/undo，没有拦截其他应用键盘或剪贴板。
- 6 条真实原生拒绝路径：缺 FD3、错误摘要、关闭通道、额外环境变量、请求夹带 value、请求 resolve。
- 正常用户上下文的合法绑定 probe 返回 `available:true/code:available`；工具沙箱中的 probe 曾为 `runtime_unsafe`，不把沙箱结果推广为桌面可用性。
- 上述 7 个直接原生子进程均收到 close；没有运行有效 status/manage/execute，没有认证、Keychain 读写、UI 或网络。

历史脱敏结果见[原生协议与 probe 记录](../../doc/workflow-manual/验证/OS凭据证据/native-protocol-and-probe.json)。该版本原生二进制 SHA-256 为 `321be3c6ca3fa2175afdc155ab9b25b674566994042fd4c7c6ef0eee5e1c0115`；清单 SHA-256 为 `538d992cfc77903db4979c35b41d3e6b5403fe41645cdf28d9746eace297523c`。这些是历史产物身份，不能用作当前持久授权构建的 pin。

后续已在正常 DeepSeek Harness Desktop 安装本后端，用户自行完成系统认证并保存测试值；原生窗口关闭后，源流程的 Secret 待配置提示消失。插件再次更新并重启后，同一流程仍没有缺失提示，系统凭据组件和管理按钮可用；画布、节点批注及 JSON 往返保持，真实主/原生子 Agent 的流程读取仅返回六个声明字段、不含原值。详见[系统凭据存储与真实 Harness 验收](../../doc/workflow-manual/验证/09-系统凭据存储与真实Harness验收.md)。这与上面的独立 probe 测试是两组证据；probe 本身仍未触发认证或访问 Keychain。

随后在 DSH `0.2.1-rc.1` 完成逐次授权版本的查看、编辑、重新打开核对新值、删除和固定 HTTP 请求。用户本人确认管理动作，实际请求返回 `{ok:false,status_code:401}`，删除后恢复缺失提示且按钮点击弹窗阻止新运行；未记录原值。401 是测试值被目标拒绝，不能称为有效 API 密钥认证成功。证据见[DSH 0.2.1 分阶段验收](../../doc/workflow-manual/验证/10-DSH021适配与Secret管理请求验收.md)及其[脱敏目录](../../doc/workflow-manual/验证/DSH021证据/README.md)。

当前持久授权源码及并发撤销修复已完成并冻结。原生二进制 SHA-256 为 `c8851634b17c6eee3e73ad8572cec17fa6f924dccaae07ad4cc67ffe9b63c073`，清单 SHA-256 为 `d045aacdf64cd3947c42a1b8b8661d093b99867590fcb81a8b49ce647c9c3ef4`；对应 10 组检查通过，包含 74 项原生断言和 7 个确认退出的子进程。该次合法 probe 在工具沙箱返回 `runtime_unsafe`，检查未进行系统认证、Keychain 读写、UI 或网络，不能作为 Desktop 已就绪的证据。

持久授权最终包已在真实 DSH 0.2.1-rc.1 安装。用户确认一次管理认证及“保存并授权自动使用”，随后两次固定请求均未再次认证，耗时 1.677 秒、0.988 秒，只返回 `{ok:false,status_code:401}`；假值的 401 证明请求完成，不是有效密钥认证成功。真实导出再导入保留画布结构、坐标、视口、便签和批注，副本没有值或授权，点击执行弹缺失提示且无 run。原流程的假测试值和授权保留；本包未再次运行真实主/子 Agent 模型调用。

为减少用户重复交互，没有在本包另做人工撤销、修改后授权、删除或重启；撤销、凭据/目标变更失效等由原生与工作流回归覆盖，不能写成这些路径实机通过。CAS 并发、ACL 变化、系统账户密码回退与 Windows 仍无完整实机结论。证据详见[本轮分阶段验收](../../doc/workflow-manual/验证/10-DSH021适配与Secret管理请求验收.md)。插件包 SHA-256 为 `b12b90a7d9022e5805ea758d7649cc784e63b12a12ed10a865fbfccf3cf59a9e`，与上述原生摘要分别标识不同产物。本说明在打包后补充实际结果；已安装包保留冻结时的文档副本，不因文档收尾重新构建或打包。
