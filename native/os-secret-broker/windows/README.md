# Windows 工作流 Secret 后端（待实机验收）

本目录是独立候选实现，不修改 Harness Host、Agent 的工具权限、其他插件、系统环境变量或旧隔离代码。**默认构建对所有凭据操作返回 `windows_unverified`；当前不能作为已可用的 Windows 功能发布。** 本轮开发机是 macOS，没有 .NET SDK，尚未编译或运行这些 C# 文件。

## 1. 保存与使用边界

- 保存位置是当前 Windows 用户的 **Credential Manager 通用凭据**，不是普通环境变量、JSON、`.env` 或工作流文件。采用本机持久化，不主动启用跨设备漫游。
- 名称按工作区、工作流、变量 ID 生成；节点 ID、操作 ID 不决定变量归属。导入到新的工作流不会自动获得旧工作流的凭据。
- Agent、Host 请求及响应只有声明、标识、状态；协议没有 `read`、`resolve`、`getSecret` 或原值返回接口。
- 用户通过单独的 WinForms 原生窗口查看、编辑、粘贴、保存、删除。查看现值、保存和删除分别请求系统验证；认证成功后才执行该动作。输入默认遮罩，可由用户显隐，复制粘贴不被插件禁用。
- 消费器固定为 `GET https://api.deepseek.com/user/balance`。窗口显示目标，经系统验证后读取凭据并在此进程中设置 Bearer 请求头，只返回 `status_code`。不读取响应体、不跟随重定向、不使用代理或 Cookie、不回退到文件、不自动重试。
- 普通保存值支持 1–2048 UTF-8 字节，允许 Unicode、空格和标点，拒绝 NUL。固定 HTTP 消费器在使用时另校验 RFC 6750 `b64token` 格式，通用密码不因不符合 Bearer 格式而无法保存。

**保护范围须准确理解：** Credential Manager 的读权限取决于当前登录令牌，并非每个通用凭据自带 Windows Hello 访问控制。此实现用系统验证约束本应用的管理和消费路径，无法阻止同一 Windows 用户下任意本机代码直接调用 `CredReadW`。不能据此声称任意 shell 权限的主 Agent/子 Agent 在 OS 层绝对读不到。这个限制也不能通过把值改放普通环境变量解决。[Microsoft CredReadW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw)

`UserConsentVerifierInterop.RequestVerificationForWindowAsync` 使用本窗口 HWND，请求 Windows 配置的 Hello、PIN 或可用验证设备，未收集用户登录密码，也没有把普通确认按钮当作认证。桌面互操作 API 的文档最低版本是 Windows Build 22000，因此本候选目标为 Windows 11。[Microsoft 桌面验证接口](https://learn.microsoft.com/en-us/windows/win32/api/userconsentverifierinterop/nf-userconsentverifierinterop-iuserconsentverifierinterop-requestverificationforwindowasync)

`status` 仅返回存在与否。但 Win32 `CredReadW` 没有只取元数据的标志，因此系统会把凭据块放进本原生进程；代码不把它解码成字符串，立即清零并释放。查看和消费才会将值解码。不要将 `status` 描述成“操作系统完全没有加载原值”。.NET 字符串和原生文本控件也无法提供所有内存副本可靠擦除的保证；程序会清空输入框、撤销历史及可控字节缓冲区，不宣称内存取证隔离。

## 2. 文件

| 文件 | 职责 |
| --- | --- |
| `Sources/Program.cs` | 有界标准输入、默认未验收门禁、只输出协议响应 |
| `Sources/Protocol.cs` | version 1 严格请求字段、重复键拒绝、变量身份、无原值响应类型 |
| `Sources/SecretValue.cs` | 版本化 UTF-8 凭据块、字节上限、消费器格式校验 |
| `Sources/CredentialStore.cs` | `CredReadW` / `CredWriteW` / `CredDeleteW`，不提供文件后备 |
| `Sources/SystemAuthorization.cs` | 真正的 Windows 桌面系统验证 API |
| `Sources/SecretWindow.cs` | 用户管理与执行确认窗口 |
| `Sources/ControlledTransport.cs` | 固定 HTTPS 操作，仅取状态码 |
| `tests/ProtocolTests.csproj` | 不依赖 Windows 的实际 C# 协议及值编码自测 |
| `tests/Verify-DefaultClosed.ps1` | Windows 默认构建的关闭状态检查，不访问真凭据 |
| `../../../tests/os-secret-windows-source.test.ts` | 在当前仓库运行的静态发布门禁和输出面回归检查 |

## 3. Host 协议

输入仅为一条 UTF-8 JSON，最大 8192 字节。关闭标准输入表示请求结束。拒绝额外属性、重复键、任意目标 URL、命令行参数和原值字段。

```json
{"version":1,"command":"probe"}
```

`status` / `manage` / `execute` 使用相同形状：

```json
{
  "version": 1,
  "command": "status",
  "operation": "deepseek.account-status.v1",
  "scope": {
    "workspaceId": "workspace-id",
    "workflowId": "workflow-id",
    "variableId": "variable-id",
    "nodeId": "node-id"
  }
}
```

成功响应分别为 `{"ok":true,"available":true,"code":"available"}`、`{"ok":true,"state":"configured"}`（或 `missing`）、`{"ok":true,"state":"saved"}`（或 `deleted`、`unchanged`）、`{"ok":true,"status_code":200}`。失败仅含 `ok:false` 和枚举错误码，不传异常消息、响应头、响应体或 Secret。

**默认构建**的 probe 为 `{"ok":true,"code":"windows_unverified","available":false}`；其他合法操作返回 `{"ok":false,"code":"windows_unverified"}`。解析失败仍为 `invalid_request`。`biometric_unavailable` 沿用现有协议码，在本后端含义是系统验证不可用，并不表示只允许生物认证。

## 4. 构建与验证

需 Windows 11、.NET 8 SDK、Windows 桌面构建组件。WinForms 的 TFM 提供所用 WinRT C# 互操作类，不需要把 UWP 的调用方式移植到桌面。[Microsoft .NET 桌面互操作说明](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/winrt-com-interop-csharp)

以下命令在仓库根目录的 PowerShell 执行：

```powershell
dotnet run --project native/os-secret-broker/windows/tests/ProtocolTests.csproj
dotnet publish native/os-secret-broker/windows/WorkflowSecretBroker.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:WindowsAcceptanceBuild=false -o native/os-secret-broker/windows/dist/win-x64
pwsh -File native/os-secret-broker/windows/tests/Verify-DefaultClosed.ps1 -BrokerPath native/os-secret-broker/windows/dist/win-x64/WorkflowSecretBroker.exe
```

默认包始终关闭，不允许靠环境变量、运行时参数或工作流 JSON 将它启用。为后续 Windows 实机验收，开发者可另编译显式候选包，**不能用此包替换默认发布包或仅凭编译成功放开 Host readiness**：

```powershell
dotnet publish native/os-secret-broker/windows/WorkflowSecretBroker.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:WindowsAcceptanceBuild=true -o native/os-secret-broker/windows/dist/acceptance-win-x64
```

凭据块上限为 2048 字节加版本前缀，低于 Windows 通用凭据 2560 字节限制。`CRED_PERSIST_LOCAL_MACHINE` 在这里是同一用户同一台机器的后续登录会话可用，不代表机器上所有用户都能读取。[Microsoft CREDENTIALW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw)

## 5. 放开 Windows 支持前的实机验收

| 项目 | 当前状态 | 必须收集的证据 |
| --- | --- | --- |
| C# 协议及编码测试 | 未执行；本机没有 .NET SDK | 实际 .NET 运行结果；未知字段、重复键、超长、Unicode、Bearer 格式、响应字段检查 |
| Windows 构建 | 未执行 | Windows SDK/.NET 版本、构建输出、包哈希 |
| 默认关闭 | 仅源码检查 | 默认包五种请求结果；不弹认证窗、不访问凭据 |
| 系统认证 | 未执行 | Hello/PIN 正常、取消、未配置、失败、关闭窗口；无假确认降级 |
| 用户管理 | 未执行 | 用合成值保存/查看/复制/编辑/替换/删除，未授权动作没有变化；Unicode 与长度边界 |
| 受控消费 | 未执行 | 明确授权的测试凭据、固定目标、取消与超时、拒绝重定向；只返回状态码 |
| 主/子 Agent | 未执行 | 工作流工具、提示词、日志、快照和导出只有引用；两条真实 Harness 调用链分别验收 |
| 原项目兼容 | 未执行 | 现有画布、节点批注、JSON 位置/引用、缺失值提示、其他插件功能与正常 DSH 对话 |

验收过程中不要向聊天、标准输出、日志或报告复制凭据。用户系统认证应由用户完成。只有以上证据齐备后，另行审查 Host 的 Windows readiness；本目录当前没有设置任何启用标记。
