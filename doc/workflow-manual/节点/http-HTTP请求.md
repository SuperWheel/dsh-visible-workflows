# HTTP 请求（http）

[返回手册总索引](../README.md) · [节点执行矩阵](README.md)

类型身份：`http`。常见别名：受限宿主 fetch。核验日期：2026-10-16。

## 用途

向用户配置的HTTP(S)地址发起一次真实请求，并保留响应状态和正文。

## 输入与配置

- url、method、headers、bodyText均可引用上游值；`timeoutMs`100–120000，保存默认30000ms，新节点UI通常10000ms。
- 节点保存配置及UI支持GET/HEAD/POST/PUT/PATCH/DELETE；底层适配函数还接受OPTIONS，但正常节点schema未开放它。

## 输出

- text/body为UTF-8响应正文，status_code为状态码，headers过滤敏感字段；正文可解析JSON时增加json。

## Graphon 与具体执行者

Graphon调度；TS先渲染请求配置，执行适配器使用Node fetch（redirect=manual），按取消/超时信号读取有界响应。并非Graphon自带HTTP节点，也不是通过模型“模拟请求”。

共同边界：Graphon 接收当前层的节点 ID、kind 和连线；具体配置、变量作用域、模型凭证及节点副作用仍由已认证 DSH Host 持有。详见[节点共同执行规则](README.md#共同执行规则)。

## 前置条件与限制

- 只允许无URL内嵌用户名/密码的HTTP(S)地址；GET/HEAD不发送body。请求体/响应约2MB，响应之后仍受外层节点约1MB限制。
- 不自动跟随重定向；302、4xx、5xx作为真实status_code返回，不自动判失败/重试。需在下游if显式判断。
- 只支持文本body与响应，没有二进制下载/文件上传、多部分表单、OAuth向导或完整Dify认证配置。
- 未见独立域名/IP白名单或私网拦截；可请求localhost。不能将“受限”描述为网络沙箱；使用范围由用户配置及宿主环境决定。

## 源码与现有验证

- [真实 fetch 与响应边界](../../../src/host/execution-adapters.ts#L14)。
- [运行时请求映射](../../../src/host/runtime.ts#L408)。
- [可保存method列表](../../../src/shared/workflow-validation.ts#L46)。
- [测试：本机HTTP server真实POST与302不跳转、过滤set-cookie；不访问外网](../../../tests/tool-adapters.test.ts#L86)。
- [测试：OpenAPI使用同一HTTP适配契约（HTTP测试替身）](../../../tests/tool-adapters.test.ts#L23)。

本轮已统一运行相关自动测试，并以[20类型集成链](../../../tests/graphon-capability-audit.test.ts)验证真实Graphon调度；模型响应使用明示替身，不等于用户真实服务或生产解析质量已通过。Python用户代码等变体以[验证范围](../验证/01-验证范围与结果.md)为准；未调用收费模型或外网MCP。

## 相关节点

[工具](tool-工具.md)、[条件分支](if-条件分支.md)、[代码执行](code-代码执行.md)
