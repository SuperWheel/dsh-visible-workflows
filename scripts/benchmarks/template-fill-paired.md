# T08 配对驱动与 T09 使用方法

## 1、默认与无模型验收

默认只打印帮助。只有 `--run` 才可能创建既有供应商桥接；`--fixture` 和 `--self-test` 不读取凭据、不启动供应商。

```sh
npm run bench:template-paired
npm run bench:template-paired -- --self-test
npm run bench:template-paired -- --fixture --out=.test-data/t08-fixture --repeat=2
npm run bench:template-paired -- --fixture --out=.test-data/t08-fixture --repeat=2 --resume
```

输出父目录必须已存在，新实验目录必须不存在。续跑重用完全相同的参数和源码；已完成实验再次续跑不创建提供者，不追加结果或调用。schema 1 的旧实验不含逐调用回执，不能由本版本补造续跑记录，旧产物保留。

## 2、不可变清单与恢复

`manifest.json` 冻结 schema 2 的 `definition` 和完整 `schedule`：源码摘要、模型、思考设置、温度、输出上限、上下文工具与输出合同快照、需求、样本、试做来源与成本、请求／目录／提交上限及 AB/BA 顺序。CLI 每次重新摘要整个 `src`、`scripts/benchmarks`、Graphon 桥接、运行时归档、依赖清单与锁文件；恢复时先比较清单再允许创建桥接。不能用原目录重做不同配置。

`events.jsonl` 是唯一恢复依据，包含：

1. 发送前 `call-start`：槽位、请求编号、公开请求摘要、实际字节计数。
2. 返回后立即 `call-end`：公开助手消息、实际用量或未知、传输墙钟、显式超时／错误。不等待编译、业务 oracle 或整个尝试完成。
3. 可恢复的原始阶段观测，以及尝试终态 `result`。

逐行带序号、前行摘要和清单摘要；完整写入后 `fsync` 才推进。启动恢复只截掉未换行的尾部，完整行损坏、重复事件或清单不符均拒绝。活进程锁阻止第二写入者；原本地进程已退出时可续跑。进程停机不写成 CPU 或真人等待。

恢复会重放已持久化公开回执以重建相同编译器／修复状态，不重发已完成调用，不重置次数上限。若还需新请求，第一次请求用 `public-transcript-v1` 将已完成的公开消息与最新反馈作为用户数据冷续接，避免依赖已丢失且不落盘的私有思考。该协议也写入调用记录，后续恢复可确定性重建。恢复后丢失连续墙钟的尝试，完整 design／total 墙钟为 `null`，不会被伪装成完整计时配对。

若只有 `call-start` 而没有完整 `call-end`，不能知道远端是否执行／计费：保留一个 `interrupted` 失败和未知用量，不自动重发。已经落盘的 `result` 直接复用。`summary.json` 是可重新生成的派生文件，不是恢复依据。

## 3、计量与统计

复用 `src/host/planning/metrics.ts` 的 `PlanningMetricRecorder`、`planningMetricSchema`、`planningUsageReceipt` 和重复内容计数。模型往返、装配、目录查询、编译提交、业务 oracle、追加落盘分别记录。准入、真人等待、供应商 queue／prefill 和模型内部生成耗时不可见时为 `null`／`status=unknown`。

传入 `ProviderResponse.metrics` 时，原样验证并保留审计已有的 `span:final-validation`、`span:provenance-validation`、`span:readiness`、`span:optimization`、`span:optimization-validation`、`span:graphon-regression`、`span:publish-readiness`、`span:publish`、`span:persist` 等 Host 跨度。受控编译器没有经过这些 Host 阶段时记录 unknown；不会把 `compiler.submit` 或工具总耗时冒充这些阶段或 CPU。嵌套跨度不相加解释总墙钟。

每个尝试的持久化跨度覆盖结果写入前已观测的日志 IO。实验级 `journalPersistence` 只汇总已被后续日志持久化的 fsync 观测；终末及重启边界上无法自记录的写入由 `journalPersistenceUnknownWrites` 单列，避免完成后恢复重算时偷偷改变计量。最终 summary 自身的写入不在该跨度内。

`summary.layers` 每层各有两组的计划／尝试／成功／失败／超时／中断／未运行／修复数、实际报告 Token、已知与未知用量调用数、失败计入后的每成功任务成本。`pairedSuccessfulCases` 为双方成功数，`pairedTimedCases` 为总耗时可观测的成功配对数；`pairedMedianDesignWallRatio` 是创作耗时比，`pairedMedianTotalWallRatio` 另计共同业务 oracle。比值均为 template-fill / compact-repair。总成本中任一尝试耗时未知时，该成功分摊耗时与用量也未知，不当作零。

输入／输出／推理／缓存各 Token 项保留其可观测性，字节不换算 Token。夹具中的 Token 数字只验证运算，不是真实供应商用量。

## 4、verified-trial 来源层

`PairConfig.cases[]` 可用相同 `id` 建立 `sourceLayer=direct` 与 `sourceLayer=verified-trial` 两个来源层；缺省为 direct。每层分别配对与统计，混合层不生成顶层混合性能结论。

verified-trial 条目必须带 Host 解析出的 `context.trial` 回执、`context.trialTask`、`context.conversation` 及 `trialUsage`：

```json
{
  "sourceLayer": "verified-trial",
  "trialUsage": {
    "wallMs": null,
    "reportedTokens": null,
    "knownCalls": 0,
    "unknownCalls": 1
  }
}
```

上述字段应与正常案例的 `id/instruction/context/samples` 合并，不能单独用作完整案例。回执与试做证据由调用者从已验证的 Host 产物导入；基准不会启动试做，也不会替代 trial-service 认证。相同试做证据作为两组共同来源输入。相同 `trialUsage.wallMs` 同时计入该层两组的 design／total 比值与成功分摊耗时与用量，缺失则两边未知。试做 Token／已知和未知调用单列为分摊量，不把共享回执说成重复实际调用。

## 5、T09 执行示例（本任务未执行）

已准备 `scripts/benchmarks/t09-config.json`，完整类型见 `PairConfig`。设置 `repeats=3`、8 类各 1 例、仅 `direct` 来源层；每例带同一共享 oracle 的 `samples` 与冻结 `PlanningContext`。内置共 10 例（原有 6 例加网页、工具包装、结构化 LLM、容器 4 例）；T09 选 greeting、web-process、tool-wrapper、structured-llm、branch、container、local-edit、large-edit，不选额外的 sum/report。默认 CLI 参数不是这份实验配置。8 案例 × 2 组 × 3 次是 48 次创作尝试；若另加完整 verified-trial 层则是 96 次，应另列计划数。

模型固定 `zai-coding-cn / glm-5.3-flash`，沿用当前配对 CLI 默认 `reasoningEffort=max`、`temperature=0.2`、`maxOutputTokens=8192`；请求体固定 `thinking.type=enabled`。请求／目录／提交上限沿用 CLI 的 `8/20/3`。生产来源是 `src/host/planning/service.ts` 的 `MAX_CHILD_STEPS=8`（单子任务）、`MAX_STEPS=24`（整个任务）及候选提交上限 3；`agent.ts` 按 `input.maxSteps` 拦截模型步骤。**生产没有单独的目录调用次数上限常量**，20 只是当前基准 CLI 的目录保护值，不能宣称 `8/20/3` 全部等同生产限制；本次准备不修改生产代码。生产的目录分页／单次图查询条数也不是目录调用次数上限。

网页 oracle 拦截 `fixture.invalid` 并返回固定 HTML，不执行 HTTP；工具 oracle 返回确定性 native `value/text` 包装；结构化 LLM oracle 用纯函数返回 JSON，不调用模型；容器执行真实嵌套 Graphon 图。编辑 oracle 对照冻结基图检查无关节点、节点顺序与全部连线。它们验证有限业务样本和结构，不证明真实网页抓取、工具插件或 LLM 推理质量。顺序预览不创建实验目录／manifest；配置的 `implementationHashes` 留空，由 CLI 在后续已提交源码上填入实际完整摘要再创建不可变清单。

下面仅示范后续明确执行 T09 时的命令：

```sh
# 先离线核对配置与完整配对顺序，不创建供应商。
mkdir -p .test-data
node --import tsx --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs"; import {freezePair,pairedSchedule} from "./scripts/benchmarks/template-fill-paired.ts"; const frozen=freezePair(JSON.parse(readFileSync("scripts/benchmarks/t09-config.json","utf8"))); const preview=JSON.stringify(pairedSchedule(frozen),null,2); console.log(preview); writeFileSync(".test-data/t09-schedule-preview.json",preview+"\n");'

# 审阅并提交后，从该 committed HEAD 执行；输出父目录须已存在。
# 实际源码摘要由 CLI 自动填入；本任务没有运行下面两条真实模式命令。
npm run bench:template-paired -- --run --config=scripts/benchmarks/t09-config.json --out=.test-data/t09-frozen
npm run bench:template-paired -- --run --config=scripts/benchmarks/t09-config.json --out=.test-data/t09-frozen --resume
```

现有桥接只支持 `zai-coding-cn / glm-5.3-flash`，其他模型会在创建桥接前拒绝。供应商实际生效的 effort 与内部等待仍取决于可获得的回执，配置值不能证明服务端生效。T09 门槛保持原清单：业务／兼容用例通过、模板最终成功数不低于精简组、双方成功配对中位比 ≤0.90、计入失败后的成功分摊耗时不恶化。受控编译器与原生 Desktop 时间分别报告；本轮无模型结果不能代替 T09 实测。
