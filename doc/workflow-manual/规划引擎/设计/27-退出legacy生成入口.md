# 27、退出 legacy 生成入口（T13）

## 1、背景

2026-10-26 T12 完成，新建规划任务默认改为 template-fill，compact-repair 保留为回退。用户随即要求接着做 T13，原话：“可以，接着做 T13”。

T13 的要求有三条：
- 先列出真实入口、配置、CLI 与库的使用方、测试夹具的依赖清单；
- 再停止新任务选择旧生成协议；
- 历史任务的读取、回执核对和用量结算继续保留，删除的只能是已没有调用的生成逻辑。

## 2、legacy 是什么

任务没有 `compilerMode` 时就是 legacy。这时规划的三个阶段都不带编译器调用模型，由模型直接输出旧协议，Host 事后一次性解析：

| 阶段 | legacy 做法 | 编译器模式做法 |
| --- | --- | --- |
| 作者 | 输出 `planningEditsSchema`（局部编辑意图）；Host 用 `compilePlanningEdits` 解析，失败了整轮重来（`candidateAttempts` 计数） | `TemplateFillingCompiler` 或 `WorkflowAuthoringCompiler`，同一会话内有限修补 |
| 优化 | 输出 `optimizationEditsSchema`；Host 用 `compileOptimizationEdits` 解析 | `createOptimizationCompiler` |
| 提炼 | 输出 `retrospectiveOutputSchema`，过程以 `procedureJson` 字符串给出 | `createProcedureCompiler`（`submission.mode=distill`） |

`compilePlanningEdits`、`compileOptimizationEdits`、`planningEditView`、`planningNodeRefs` 同时是 compact-repair 与 template-fill 的内核，**不能删**。只为 legacy 存在的，是上表左列的“不带编译器调用 + 事后解析”这层接线。

## 3、依赖清单（2026-10-26 核对）

### 3.1、产品入口与配置

| 位置 | 现状 |
| --- | --- |
| Host 配置 `planningCompiler`（[index.ts](../../../../src/host/index.ts)） | 仍接受 `legacy`；默认 `template-fill` |
| 规划服务 `start()`（[service.ts](../../../../src/host/planning/service.ts)） | 服务层未配置模式时按 `legacy`；命令受理和 partial 交接已强制改用 compact-repair |
| 作者、优化、提炼三处的无编译器分支 | `service.ts` 作者循环、`optimize()`、`distill()`；agent.ts 按用途选旧输出 Schema |
| legacy 作者提示 `prompt()`、草稿缓存 `drafts` | 只给无编译器作者路径用 |
| CLI `workflow-compile` | 只支持 compact-repair / template-fill，**不受影响** |
| 包导出（`.`、`./client`） | 不导出规划服务的模式选择，**不受影响** |
| Desktop 用户数据 | profile 配置为 template-fill；存储里 10-23—10-26 的 55 个任务中，53 个是 template-fill，另 2 个中断时还没选模式；**没有在途的 legacy 任务** |

### 3.2、脚本

| 位置 | 用途 |
| --- | --- |
| [workflow-compiler.ts](../../../../scripts/benchmarks/workflow-compiler.ts) | 早期编译器对照基准的 legacy 组，用 `compilerMode:'legacy'` 截取旧提示；历史证据已存档 |

### 3.3、测试

模拟“停用 legacy”（服务层默认改为 compact-repair）后全量运行：14 个文件、113 个测试失败。原因是这些测试的替身模型按旧协议直接输出结果，并不是在测 legacy 本身。

| 文件 | 失败数 | 主要内容 |
| --- | ---: | --- |
| planning-service.test.ts | 57 | 规划生命周期、澄清、发布、优化、取消、恢复 |
| planning-v002-service.test.ts | 20 | v0.0.2 提炼、优化、回归 |
| planning-edits-integration.test.ts | 12 | 局部编辑经服务端到端 |
| trial-path.test.ts | 9 | 试做路径到提炼 |
| planning-host-audit-regressions / planning-admission-faults | 3 / 3 | Host 审计回归、模型准入故障 |
| trial-service.test.ts | 2 | 试做服务 |
| 7 个 Host 夹具测试 | 各 1 | 夹具里写了 `planningCompiler:'legacy'`（global-workflow、planning-entry、planning-host、planning-model-source、planning-startup、retrospective、trial），另有 workflow-scope-host、planning-config-rollback-host |

## 4、方案（2026-10-26 用户确认：“可以，按推荐做法做，交给 Codex 改测试，有一些已经不用的测试顺便帮我给删除”）

1. **停止选择。** 新任务不再进入 legacy。
   - Host 配置仍接受 `legacy` 这个值，避免旧配置文件让插件加载失败，但按 compact-repair 运行，并在模式选择记录里注明原因。
   - 服务层未配置模式时，也按 compact-repair。
2. **在途旧任务。** 已冻结为 legacy、尚未结束的任务（等待回答、可恢复等），恢复时直接结束为失败，诊断写明“旧生成协议已退役，请重新发起”；记录、回执和用量保持可读。用户数据里当前没有这样的任务。
3. **迁移测试。** 113 个测试改为 compact-repair 的提交写法；它们原本测的服务行为保持不变。只验证旧协议本身的测试随旧接线删除；其他已经不再对应现行代码的测试（被测功能已删除或已被新测试完整覆盖）一并删除，逐个记下理由。7 个夹具改为显式写明新模式。
4. **删除旧接线。**
   - 删除作者、优化、提炼三处的无编译器分支，以及只供它们用的 `prompt()`、`drafts` 和 agent 里的旧输出 Schema 选择；内核编译函数保留。
   - 旧基准脚本的 legacy 组下线，历史证据不动。
5. **验收。**
   - 新请求一律不进入已删路径；
   - 旧 legacy 记录可读、可核对回执、可结算用量；
   - 全量回归、类型检查、构建通过；
   - 只删已无调用的代码。

不调用真实模型，不需要安装验收：Desktop 本来就用 template-fill。

## 5、实施结果

### 5.1、入口与历史记录

- 服务层缺省配置和显式 `legacy` 都按 compact-repair 创建新任务。冻结选择记录保留 `requestedMode:legacy`、`effectiveMode:compact-repair`、`reason:legacy-retired`；Host 的任务查询也返回模式及选择记录。Host 配置仍接受 `legacy`，默认值仍是 template-fill。
- 冻结上下文但没有 `compilerMode` 的未完成旧任务，在启动恢复、回答或生成入口结束为 `failed`，诊断为 `PLANNING_LEGACY_RETIRED`：旧生成协议已退役，请重新发起该请求。没有重新调用模型，也不接受旧问题的回答。
- 原子提交回执的恢复仍优先处理；已发布、失败等历史终态不因协议退役而重新生成。旧选择记录、回执核对、历史用量字段和重启时未结算调用的处理继续保留。回归检查了已发布旧记录的原文件没有被改写。
- 作者、优化、提炼都通过各自的 SubmissionCompiler。作者的三轮重新生成、提炼的原始输出重试，以及三阶段不带编译器调用后再解析的接线已删除。修补发生在同一编译会话中；提交上限、真人澄清、取消、发布、恢复、来源映射和用量断言继续覆盖。
- `prompt()`、`drafts`、agent 的旧输出 Schema 回退及其三段旧角色提示、基准脚本的 `legacyPrompt()` 和 A 组已删除。基准的 B/C/D 组保留；C 组直接组装共享编辑视图并使用 RepairSession，不再借服务调用旧入口。历史证据没有修改。
- 已核对剩余调用，保留 `compilePlanningEdits`、`compileOptimizationEdits`、`planningEditView`、`planningNodeRefs` 及三个共享输出 Schema。优化提交被拒绝时，仍从编译器快照保留合法节点的替换理由和诊断，供后续优化与审计使用。

### 5.2、测试迁移与删除清单

原先按旧协议返回原始结果的替身模型改为向 `input.compiler` 提交 `submission`。共用夹具仍可用标准图描述预期业务变化，再转换成 compact 的 create/edit、chains/links、coverage 提交；提炼提交 procedure 对象，优化提交受编译器约束的替换。CREATE 夹具使用未发布的起止基线和 Host 预留身份池。原有状态、回执、真人问题、发布、取消、恢复、优化、提炼和用量检查继续保留。

没有删除测试文件。实际删除了三个 `it` 声明，参数展开后共四项：

| 文件 | 测试名称 | 删除理由 |
| --- | --- | --- |
| tests/planning-agent.test.ts | does not accept a legacy author graph even when the graph JSON is valid | 只验证 agent 无编译器时选择旧 Schema 拒绝 graphJson 的接线；该回退已删除，共享 Schema 拒绝完整图和编译器提交校验已有独立覆盖。 |
| tests/planning-edits-integration.test.ts | rejects a stale base digest and repairs against the unchanged trusted draft | 只验证旧作者输入中的 baseDigest 与重新调用模型；compact 作者不暴露此字段，底层摘要绑定继续由 planning-edits 的内核测试覆盖。 |
| tests/planning-edits-integration.test.ts | uses explicit nested scope without moving or dropping the container (scope supplied=true) | 旧 update-node 的显式 scope 接线已退出；改为一个真实 compact 提交测试，验证按冻结 key 推导嵌套 scope，保留容器、内部连线和未改配置。 |
| tests/planning-edits-integration.test.ts | uses explicit nested scope without moving or dropping the container (scope supplied=false) | 仅验证旧协议省略 scope 会失败；compact 更新按冻结 key 推导 scope，不再有这项生成合同，新的嵌套提交测试覆盖当前行为。 |

另有三项测试仅更名并迁移，未计入删除：

- planning-compiler-selection：名称中的 `compact/legacy mode` 改为 `compact mode`，同时增加 legacy 映射断言。
- planning-service：`retaining diagnostics in the next prompt` 改为 `retaining diagnostics in the same session`，仍检查三次提交上限、保留诊断和不发布。
- planning-service：`current-view reference` 改为 `current compiler key`，仍检查错误引用在修补前不被改写，随后按合法 key 修补。

新增九项：上述一个嵌套 key 测试、七项模式选择与旧任务恢复/回答/历史记录测试、一个真实 Host 的旧配置映射测试。净增加五项。

### 5.3、验收记录

修改前先完成全量基线：

```text
 Test Files  3 failed | 274 passed (277)
      Tests  3 failed | 3818 passed (3821)
```

修改后全量运行（退出码 1）：

```text
 Test Files  3 failed | 274 passed (277)
      Tests  3 failed | 3823 passed (3826)
```

前后都是 277 个测试文件；总测试数由 3821 增至 3826，通过数由 3818 增至 3823。删除四项、增加九项，净增加五项。失败仍为下列三个基线沙箱权限错误，没有新增失败。

`npm run -s typecheck` 通过（退出码 0）；`npm run -s build` 通过（退出码 0），Host / Client 构建及 Typert 合同核对均完成。最终只补齐了文档和代码缩进，并再次运行类型检查。

基线的三个失败都来自沙箱禁止监听 `127.0.0.1`，错误为 `listen EPERM`：

- graphon-capability-audit.test.ts：executes all 20 kinds through the real engine and production adapters using explicit model/SDK doubles。
- tool-adapters.test.ts：uses actual HTTP responses, preserves status and never follows credential-bearing redirects。
- planning-notification-reconnect.test.ts：recovers a lost production Host journal response over a real socket and deduplicates client notifications。

没有绕过权限限制，没有真实模型调用、网络安装或 Desktop 操作；未提交 Git commit。

提交前在沙箱外复跑（覆盖 Codex 最后一处 service.ts 修改）：`npm run -s typecheck` 通过；全量 `npx vitest run` 为 `Tests  1 failed | 3825 passed (3826)`，上面三项 `listen EPERM` 均通过。唯一失败是 auxiliary-driver-smoke.test.ts 的审计脚本子进程在全量并发下 20 秒超时，单独重跑通过（`Tests  1 passed (1)`），与本任务无关。
