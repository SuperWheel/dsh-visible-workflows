# 配对基准的离线分片与合并

`PairConfig.firstRepeat` 是可选的非负安全整数，默认 0。`repeats` 仍表示次数；调度范围是 `firstRepeat` 到 `firstRepeat + repeats - 1`，上界必须能用安全整数表示。AB/BA 使用绝对 repeat，日志也记录绝对 repeat。缺省或 0 不写入冻结定义，保持原有配置的 digest。源码摘要仍由运行器按现有规则核验。

以下命令把 `web-process` 的 5 次重复分成 5 个进程的配置。工具只写配置与计划、打印命令，不启动模型：

```sh
node --import tsx scripts/benchmarks/template-paired-shards.ts split \
  --config=scripts/benchmarks/t09-config.json \
  --cases=web-process --repeats=5 --shards=5 --out=/tmp/web-process-shards
```

输出目录必须不存在，父目录须已存在。在项目根目录执行打印的 5 行进程命令，即可分别运行 repeat 0、1、2、3、4。每个配置有独立结果目录；需要恢复时给该配置的运行命令加 `--resume`。此工具本身不运行打印的命令。

省略 `--cases`、`--repeats` 时沿用原配置。提供 `--cases` 时按原有顺序选出案例，形成新的基础实验，再分片。支持原配置非零的 `firstRepeat`。

分配以 `(case, repeat)` 为单位，各进程的数量最多相差 1，`--shards` 范围为 1 到总 pair 数。每个配置只包含一个案例的连续 repeat 区间；当均衡分配跨越案例边界时，一个进程会得到多个配置，打印命令用 `&&` 串行执行这些配置。例如 3 案例 × 3 repeats 分给 2 进程时，pair 数为 5 和 4，需要每进程两个配置。任意数量不能总用恰好 N 个矩形配置均分。

配置只改 `cases`、`firstRepeat`、`repeats`。分片案例内的可选 `scheduleIndex` 保存基础实验的原始案例 index，避免单独取出奇数 index 案例后 AB/BA 翻转；普通配置不需要填写。模型、限制和案例的其他内容保持不变。

所有进程结束后，运行打印的合并命令，或显式执行：

```sh
node --import tsx scripts/benchmarks/template-paired-shards.ts merge \
  --plan=/tmp/web-process-shards/plan.json \
  --out=/tmp/web-process-shards/combined-summary.json \
  /tmp/web-process-shards/shard-{1,2,3,4,5}
```

合并只读各结果目录的 `manifest.json` 和 `events.jsonl`，不修改日志、不获取写锁，也不调用模型。要求计划中的每个 `(sourceLayer, case, repeat, arm)` 恰好出现一次，拒绝重复、缺失、异常 arm 顺序、未完成日志、摘要链损坏，以及模型、限制、源码摘要或其他冻结内容不一致。必须提供 `plan.json`，才能检测整个首片或尾片缺失。基础配置的源码摘要为空时，以运行器填入的共同摘要为准；有摘要时还必须与基础配置一致。目标 summary 文件必须不存在。

summary 沿用 `docs/evidence/t09-paired-20261021/merge.py` 的字段：`attempts`、`arms`、`cases`、`pairs`、`pairedSuccessful`、`pairedMedianDesignWallRatio`、`pairedMedianTotalWallRatio`。逐 arm 汇总成功、状态、requests、repairs、submissions、reportedTokens、knownCalls、unknownCalls、包含失败成本的 design/total wall per success，以及成功项 design wall 中位数。逐 case 分母使用实际计划次数；`pairs.repeat` 为绝对 repeat 的字符串，比值为 template-fill / compact-repair。缺失耗时保持 `null`，零分母不生成比值；全部 Token 未知时为 `null`，部分已知时汇总已报告数并保留 unknownCalls。墙钟字段与原合并脚本一样使用结果中的原始 `timing` 字段。

## Gemini 独立实验（Antigravity CLI）

`scripts/benchmarks/gemini-config.json` 沿用 T09 的 8 个案例、3 repeats 和全部限制，单独使用 `antigravity-cli` / `gemini-3.8-flash-high`。可把新实验配置的 model 改成 `gemini-3.8-flash-medium` 或 `gemini-3.8-flash-low`，每个模型使用独立计划与输出目录；禁止把 Gemini 和 GLM 或不同 Gemini 变体的数据合并。合并显式拒绝 provider/model 不一致。原 T09 配置和冻结 digest `d548ad1563cea37809af5400ede5019a4bcf11704b572347a8003307c4436ae5` 保持不变。

先做 1 case × 1 repeat 的 smoke test（两个 arm，各自仍允许原有限次修复）。以下 split 命令仅准备，不调用模型；只有之后执行打印的 `--run` 命令才消耗账户：

```sh
node --import tsx scripts/benchmarks/template-paired-shards.ts split \
  --config=scripts/benchmarks/gemini-config.json \
  --cases=greeting --repeats=1 --shards=1 --out=/tmp/gemini-smoke
# 检查配置后，手动执行上一步打印的运行命令：
npm run bench:template-paired -- --run \
  --config=/tmp/gemini-smoke/shard-1.json --out=/tmp/gemini-smoke/shard-1
node --import tsx scripts/benchmarks/template-paired-shards.ts merge \
  --plan=/tmp/gemini-smoke/plan.json --out=/tmp/gemini-smoke/combined-summary.json \
  /tmp/gemini-smoke/shard-1
```

完整实验准备如下。在项目根目录分别执行打印的 4 行进程命令，各行内部的 parts 串行运行；全部完成后执行打印的 merge 命令：

```sh
node --import tsx scripts/benchmarks/template-paired-shards.ts split \
  --config=scripts/benchmarks/gemini-config.json --shards=4 --out=/tmp/gemini-full
```

驱动在 `--run` 时只用 `~/.local/bin/agy --version` 查询版本，并要求等于配置中的 `model.cliVersion`（示例为 `1.4.5`）。版本、模型、effort 和空值控制参数进入冻结 manifest；安装版本变更时，应显式更新新实验配置并重新分片，不覆盖既有 manifest。温度和输出 Token 上限无法控制，因此都冻结为 `null`。

每个 attempt 的 cwd 是新建的空临时目录，同一 attempt 的修复继续使用此目录和已观察的 `conversation_id`。实际调用（通过 argv 数组执行，无 shell、无命令行凭据）为：

```text
~/.local/bin/agy --model gemini-3.8-flash-high --output-format stream-json --sandbox --disable-slash-commands --print-timeout 240000ms --json-schema '<当前 structured_output.function.parameters 的 JSON>' [--conversation <已观察的 conversation_id>] --print '<本轮提示词>'
```

首轮提示词分别用 `[BEGIN SYSTEM MESSAGE]`、`[BEGIN USER MESSAGE]` 和 `[END MESSAGE]` 分隔，内容以 JSON 字符串保留边界；后续只发送新编译反馈，用 `[BEGIN COMPILER FEEDBACK MESSAGE]` 分隔，不重发系统消息或历史回复。每轮使用最新 submission schema，最终 JSON 对象或 `result.response` 字符串转换成 `structured_output` 的 arguments，继续使用现有 `parseToolArguments` 和编译器。未暴露规划器的 catalog/graph 工具；若 agent 使用自身工具或请求权限，会立即终止该调用并记为 `harness-invalid`。禁止使用 `--dangerously-skip-permissions`；stdin 关闭，不交互批准。

`harness-invalid` 保留日志、原因、调用成本和状态计数，但从模型成功率分母、失败数、每成功项墙钟成本和配对比值中剔除；分片汇总的 `arms.attempts` 与 case 分母也剔除它，顶层 `attempts` 仍是全部计划结果数。Token、requests 等传输计数保留已发生的开销。超时仍按现有 `timeout` 统计。完成的结果可以正常 `--resume`；进程重启后的未完成 Gemini attempt 不伪造同一会话恢复，若需要继续调用则记为 `harness-invalid`，原因是会话连续性不可恢复。已中断且没有回执的调用沿用 `interrupted`，不会重发。

墙钟从 CLI 启动到退出，包含启动开销；`firstDeltaMs` 是首次 agent 文本或最终结果的可见输出时刻（不把 init 当作模型首输出），不是纯模型 TTFT。原始 JSONUsage 的 `total_tokens` 不含 cache read；适配器保留 `agyRaw` 并把明确报告的 cache read 加入规范化总量，单轮多个 response step 的用量只在全部可知时求和。不认识或缺失用量保持 `null`，不会当成 0；provider queue/prefill、纯生成耗时仍未知。

该实验有明确差异：agy 自带 agent system prompt，基准系统消息只是用户提示词中的一段；JSON schema final output 与 GLM 原生 tool calling 不同；不能使用基准 catalog 工具；CLI 启动开销可能稀释 template-fill / compact-repair 的耗时比；没有 temperature / maxOutputTokens 控制；usage 可能未知。因此它只用于单独的跨模型探索，不替代 GLM gate，也不能证明差异只来自模型。

离线夹具采用本地 `cliworker-now/src/host/native-agy.mjs` 与 `native-response.mjs` 的原生事件/用量形状；未调用真实模型。首次真实 smoke test 需要逐项核实：

- 当前 CLI print 模式实际发出的 init/step_update/result envelope、model 与 conversation_id 字段是否匹配；未知事件应明确 harness-invalid。
- `--json-schema` 是否产生 JSON 字符串 `result.response` 或对象 `result.structured_output`，是否直接适配两个 arm 的 schema，且没有 agent 工具调用/权限请求。
- 跨进程 `--conversation` 是否保留原会话，并能在 schema 更新后仅靠新反馈完成 repair；单次无修复的 smoke 无法证明此项，需要一个实际触发修复的授权案例。
- `--sandbox` 在空 cwd 中是否仍无额外工具、权限、插件行为（1.4.5 实测：init 只列出 `ask_custom_permission`；`--mode plan` 在禁用 slash 命令时无效，已移除；带档位的模型名不能再传 `--effort`）；权限提示的真实事件/stderr 形状是否被识别。
- Token usage 字段、cache 含义及多 response step 的用量范围；缺失时应保持 unknown。首次输出和墙钟记录是否正常，CLI 启动开销有多大。
- 真实账户的 Gemini 选型、启动、鉴权、限流和超时退出行为；帮助/模型列表及离线测试不能证明这些运行行为。
