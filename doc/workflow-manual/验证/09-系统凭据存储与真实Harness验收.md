# 系统凭据存储与真实 Harness 验收

日期：2026-10-17。对象：现有可视化工作流插件、新增 macOS OS Secret 后端、用户已安装的 DeepSeek Harness Desktop。**本轮已完成真实原生保存及 JSON 导出再导入验证；修复原生子 Agent 的工作区继承后，真实主/子 Agent 均成功读取声明，结果没有原值字段，两条会话均完成。首轮失败记录保留。查看、编辑、删除、固定 HTTP 消费与 Windows 实机验证尚未完成。**

本轮采用[变量级保护边界](../原理/11-Secret变量级保护边界.md)，没有恢复[已停止的全局接管实验](08-早期接管与严格Node隔离验收.md)，也没有把旧全局 gate 改为通过。密钥保存在系统凭据库，工作流接口只提供声明、引用、状态和受控业务结果；不承诺对同一系统账户下任意本机代码绝对保密。

## 1. 结果与证据范围

| 验收项 | 当前结果 | 证据和限制 |
| --- | --- | --- |
| 在真实 Desktop 安装现有插件的新版本 | 已安装 | 正常插件目录更新；3 个 profile 配置文件哈希一致，没有切换启动树、禁用其他插件或新建替代 Host |
| macOS 原生组件启动 | 通过 | Swift 构建、严格签名检查；正常用户上下文合法 probe 返回 `available:true`。probe 没有访问 Keychain 或触发系统认证 |
| 用户实际保存测试值 | 已完成，具备 UI 佐证 | 用户两次明确确认完成系统认证，原生管理窗口已关闭；原工作流的 1 项待配置提示随后消失。用户口头确认和 UI 状态分别记录，未仅以确认代替业务结果 |
| 更新插件并重启后的配置状态 | 被动状态保持 | 原流程没有 Secret 缺失红标或右侧缺失清单，执行按钮可点击；系统凭据组件就绪、管理按钮可用。未再次打开原生窗口，不证明重启后管理认证或原值读取已验收 |
| 用户查看已有值、编辑和删除 | 未验收 | 源码有原生操作入口；本轮只实际保存，不能写作 CRUD 全部通过 |
| 实际 JSON 导出再导入 | 20/20 检查通过 | 已配置流程经真实保存面板导出，再经真实导入 UI 创建新流程；新流程重新显示 Secret 缺失提示 |
| 原有用户流程 | 7 个定义哈希未变 | 安装后原 30 个文件未变化；随后授权创建/导入验收流程，新库整体哈希会改变，因此另以原 7 个定义的哈希核对保留情况 |
| 主 Agent 的 `visible_workflow_get` | 通过声明读取 | 真实主会话返回 6 个公开声明字段，没有 `value`；没有向 Agent 提供原值读取方法 |
| 首个原生子 Agent | 创建成功，读取失败 | 实际调用 `visible_workflow_get` 时工作区归属校验拒绝；这是兼容问题，不能把拒绝误记为“子 Agent 正常使用且 Secret 已隔离” |
| 修复后的原生子 Agent 重试 | 实际成功并完成 | 新子会话使用官方原生 subagent，读取结果仅有 6 个公开声明字段；`valueFieldsPresent:false`、`workspaceDenied:false`，会话 `completed` |
| 普通变量及无凭据 HTTP 回归 | 自动测试通过 | 可选且未使用的 Secret 不要求 OS 后端可用，普通 HTTP 仍能执行；不等于所有其他插件均已逐一实测 |
| 固定 DeepSeek 凭据消费 | 未实机调用 | 当前只有固定目标和状态码输出协议，没有完成真实认证请求验收，也未宣称支持任意 API 插值 |
| Windows | 源码候选 | 未编译、未验证 Credential Manager、Hello、原生 UI 或真实 Agent；不由 macOS 的结果开放 Windows |

## 2. 安装和数据保留

首次 OS 后端安装包为插件 `dsh-visible-dynamic-workflows@0.0.1`，427 个文件，34,306,444 字节，归档 SHA-256：

```text
2b93a7ff289cb7629266f2fe82a85e904326f5858b139f4a22b4547f66bce624
```

随后修复原生子 Agent 工作区继承并重新构建安装，第二包为 430 个文件、34,307,863 字节，SHA-256：

```text
36db6374ed26c74ac2275b702430343fe807dfb7c548b557e674b473c853125d
```

两次都安装在现有 Desktop 的插件目录；配置文件 `package.json`、`cordis.patch.yml`、`cordis.yml` 与安装基线逐项一致。验证人员只读取这些文件的哈希，没有在报告中复制配置内容或凭据库。第二次构建成功并完成 10 个相关测试文件、87 项回归，随后真实重试成功；这组定向回归不是对旧 1240 项历史全量结果的替代或简单累加。

安装后原 30 个工作流文件内容不变。完成后续 UI 操作时，验收流程及其导入副本增加到现有库中；[迁移检查](OS凭据证据/desktop-transfer-validation.json)继续按原始实体哈希确认 7 个原有工作流不变，不能要求整个库仍与新建流程前字节相同。

证据：[首次安装](OS凭据证据/first-plugin-installation.json)、[首次包和 profile](OS凭据证据/package-and-profile-summary.json)、[第二次安装](OS凭据证据/second-plugin-installation.json)、[第二次包和 profile](OS凭据证据/second-package-and-profile-summary.json)、[安装前文件基线](OS凭据证据/data-before-install.json)、[安装后 30 文件结果](OS凭据证据/data-after-install.json)、[原实体哈希](OS凭据证据/original-entity-hashes.json)。

## 3. 原生保存与状态变化

真实画布通过环境变量管理入口打开独立原生窗口，用户自行完成系统认证并保存测试值。主 Agent 没有输入、读取或记录 Secret 原值。保存后原生窗口关闭，画布待处理清单从 1 项 Secret 配置问题变为不再显示该问题。

这里的结论是“实际保存操作有用户确认和随后状态变化佐证”，不是从 `available:true` 推导存储成功。系统启动 probe 只检查组件与认证能力；实际保存由用户完成的原生操作与被动配置状态另行证明。此次没有为了报告读取 Keychain 内容，没有将原值写入源码、日志、JSON 证据或聊天。

独立原生窗口的显示、编辑、删除、并发保存/删除 CAS、重启后 ACL 行为仍须逐项验收。仅删除画布变量声明不会自动删除系统凭据项目；当前需在原生管理中删除值，不宣称声明删除已完成凭据撤销。

证据：[真实 UI 保存观察](OS凭据证据/desktop-user-save-observation.json)。该文件为协调 Agent 的实机 UI 观察摘要，明确注明来源和未验收项；它不是自动化读取密钥后生成的证明。

第二次插件安装并重启后，真实 UI 再次打开同一源流程：3 个节点、关联便签、1 条节点批注和 75% 视口均保留；没有 Secret 缺失红标或右侧缺失清单，执行按钮保持可点击。环境变量与系统变量仍为图标入口，环境面板显示系统凭据库已就绪且管理按钮可用，画布没有原值。本次只检查被动状态，未打开原生窗口、未读取 Keychain 原值，也未重新完成查看/编辑/删除或消费认证。证据：[重启后观察](OS凭据证据/desktop-post-restart-observation.json)。

## 4. JSON 往返保留画布，Secret 重新待配置

已配置源流程 ID 为 `162878e8-e655-4572-a573-5649b6100d15`；真实 UI 导入副本 ID 为 `ddb9340b-2880-478e-8abc-055f5446a725`。导出文件经现有 `parseWorkflowPackage()` 重新解析成功。Secret 仅保留 `id/name/description/required/revision/type`，不包含原值、本机绑定或授权。

| 内容 | 实际结果 |
| --- | --- |
| 节点与边 | 3 个节点、2 条边；类型和标题保留，节点身份全部重新生成 |
| 节点位置 | `(90,180)`、`(340.25,160.5)`、`(710,180)` 完整保留 |
| 视口 | `x:40, y:30, scale:0.75` 完整保留 |
| 便签 | 1 条；文字、颜色、位置和尺寸保留，节点锚点改指向新节点 |
| 节点批注 | 1 条；文字、编号和位置保留，关联节点 ID 改为新节点 |
| Secret | 声明元数据保留，变量 ID 重新生成；固定凭据操作改指向新变量 |
| 输出引用与连线 | 输出表达式和边端点均改指向新节点 |
| 导入后状态 | 新画布重新出现待配置提示，已保存的源 Secret 未迁移、未自动绑定到副本 |

20 项检查全部通过。该实机结果证明 JSON 导出/导入与 OS 后端的作用域兼容；本轮没有另行在真实 UI 导出 ZIP。ZIP 与 Secret 声明、附件、missing/unavailable 状态的兼容由自动测试覆盖，应与真实 JSON 验收分开表述。

证据：[真实导出 JSON](OS凭据证据/desktop-configured-secret.workflow.json)、[导出结构检查](OS凭据证据/export-check.json)、[20 项迁移检查](OS凭据证据/desktop-transfer-validation.json)。

## 5. 主 Agent、首轮失败及修复后原生重试

主会话 `session-9d7a7b32-47a9-4795-89d6-0b288507a0f6` 实际调用 `visible_workflow_get` 成功。工具结果中的 Secret 声明仅有 `id`、`name`、`description`、`required`、`revision`、`type` 六个字段，未出现 `value`。这证明本次声明读取接口不交付值，不是对所有 shell、其他插件或界面读取方式的 OS 隔离证明。

同一主会话实际创建了原生子 Agent `c26e9df7-81a9-4e27-a935-60a88363e2ca`，父子关系已记录。子 Agent 发起同一 `visible_workflow_get` 后返回工作区归属错误，未取得成功的声明结果。父会话随后 `send_message` 也出现错误。应将它作为待修复的原生子会话上下文兼容问题保留，不能用“没返回密钥”掩盖正常读取功能未通过。

修复后，主会话第二次调用 `visible_workflow_get` 成功，调用 ID 为 `call_4dc766063b044e8799c0bee9`。随后通过真实 `subagent` 调用 `call_846aaccf6865458cb15714b8` 创建新子会话 `228b0b71-fa53-4276-9b5a-43bfd6375f87`，原生任务 handle 为 `subagent_01YtEXMnbGxjCdHTdcVzUBVC`。

新子会话的 `visible_workflow_get` 调用 `call_98c9455ecb744628a871bf54` 成功。父、子返回均仅有六个声明字段，`valueFieldsPresent:false`、`workspaceDenied:false`；主会话新一轮和子会话均记录 `completed`，UI 最终报告约 31 秒完成。至此，本次实际父子调用和声明读取路径通过，不将结果扩张成任意系统工具无法访问同账户数据，亦不代表执行了带凭据的业务请求。

修复使用真实运行时父子关系继承已注册工作区，不采信任意持久化 parent 字段、同 ID 替身或子 Agent 自报 cwd。另有 7/7 官方组件验证覆盖伪造父标识、跨工作区 cwd、同 ID 对象替换和工作区注销后的拒绝；该组件验证没有模型请求，与实机重试分开归档。

证据：[首轮主 Agent](OS凭据证据/main-agent-first.json)、[首轮子 Agent 失败](OS凭据证据/child-agent-first-failed.json)、[主会话完成重试](OS凭据证据/main-agent-retry-completed.json)、[新子会话完成](OS凭据证据/child-agent-retry-completed.json)、[实机重试观察](OS凭据证据/desktop-agent-retry-observation.json)、[官方组件工作区验证](OS凭据证据/native-agent-workspace-components.json)。证据仅抽取工具名、调用 ID、成败、声明字段和父子关系，不复制完整聊天、库或 Secret。

## 6. 自动验证及其边界

| 检查 | 结果 | 实际验证的内容 |
| --- | --- | --- |
| `tests/os-secret-transfer.test.ts` | 20/20 | schema 4 严格字段和安全文案；同/跨 workspace、新建/覆盖身份不继承；ZIP missing/unavailable；快照/运行结果只含引用和状态；普通 HTTP 不受可选 Secret 后端影响 |
| 与既有 transfer/runtime 合跑 | 3 文件、31/31 | 包含上述 20 项，不重复累加；实际 `WorkflowRuntime` 和执行适配器，原生 transport 使用无凭据状态模拟 |
| 子 Agent 修复相关回归 | 10 文件、87/87 | 复核工作区归属及相关 Secret 接口；与前述单独运行存在重叠，不将 87 与 31 简单相加 |
| Host 接口与 SDK 夹具回归 | 5 文件、87/87 | 补齐 3 个旧夹具缺失的 Agent/Session 身份字段后通过；生产工作区校验没有放宽。覆盖 Host Secret 工具、SDK 契约、模型默认值、聊天桥和工作区身份，与其他测试存在重叠 |
| 已安装官方组件工作区验证 | 7/7 | 真实官方 Agent/原生 spawn，模型首轮之前阻挡，`modelRequests:0`；伪造父关系和跨工作区拒绝，正常子关系继承 |
| 原生协议/身份/值格式断言 | 35 项 | 实际 Swift 代码，包含变量作用域、普通密码与 Bearer 语法边界；不读 Keychain |
| 真实原生进程协议拒绝 | 6 条 | 缺私有通道、错误摘要、关闭通道、额外环境变量、夹带原值和 resolve 请求均拒绝，进程确认退出 |
| 真实合法 probe | 1 条 | 普通用户上下文 `available:true/code:available`，无认证、UI、Keychain 或网络 |
| Windows 静态检查 | 3 项源码回归 | 只验证默认未开放和声明输出面，不代表 C# 编译或 Windows API 已运行 |

上述测试的模拟和真实部分已分别列出。schema 4 的 `mode:os-credential-store`、`protection:workflow-interfaces`、`arbitraryLocalCodeIsolation:false` 不能升级成旧全局隔离报告；客户端对远端任意文案重新生成安全文本，不采信夹带原值、binding、grant 或广泛保护声明。

证据：[原生协议与 probe](OS凭据证据/native-protocol-and-probe.json)、[87 项定向回归](OS凭据证据/targeted-tests-agent.log)、[第二次构建](OS凭据证据/build-agent.log)、[本轮摘要](OS凭据证据/verification-summary.json)、[归档清单与 SHA-256](OS凭据证据/manifest.json)。

补充回归日志：[Host 接口与 SDK 夹具最终结果](OS凭据证据/host-fixture-regression-final.log)。此前两项失败来自旧夹具缺少 `session.id`，修正夹具后 5 文件全部通过；不把这次夹具修正写作真实桌面再次更新。

## 7. 待补验收

1. 用户完成原生查看、编辑、删除、取消、并发冲突与重启后的管理路径；只使用明确授权的测试值。
2. 用户授权固定 DeepSeek 认证请求，核验目标、取消和限定输出；不以公开 probe 或 HTTP 模拟代替。
3. Windows 编译、默认关闭、系统认证、Credential Manager 管理与真实 Agent 分别验收；参见 [Windows 候选说明](../../../native/os-secret-broker/windows/README.md)。

[手册索引](../README.md) · [Secret 变量级边界](../原理/11-Secret变量级保护边界.md) · [JSON 字段说明](../原理/10-JSON字段与导入导出.md)
