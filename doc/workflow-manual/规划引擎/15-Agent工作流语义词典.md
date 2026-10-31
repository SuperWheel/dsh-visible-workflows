# Agent 工作流语义词典

> 此文件由共享语义模块生成，不维护另一套 JSON 契约。修改 `src/shared/workflow-semantics.ts` 后运行 `node --import tsx scripts/generate-workflow-dictionary.ts`；检查同步状态用 `node --import tsx scripts/generate-workflow-dictionary.ts --check`。

[返回规划引擎索引](README.md) · [唯一 JSON 字段标准](../原理/10-JSON字段与导入导出.md) · [JSON 投影与宿主补齐](03-JSON投影与宿主补齐.md)

## 1、接入方式与使用边界

主对话 Agent 使用 `visible_workflow_dictionary`，规划子 Agent 使用 `planner_node_catalog`；两者调用同一共享模块。无参数只返回紧凑索引，按需查询最多 5 种节点和指定主题；仅需要严格类型、枚举或范围时增加 `includeSchema:true`。字段 schema 来自编辑器、导入器使用的 `workflowNodeConfigSchema`，容器只移除由 Host 补齐的投影元数据。

主对话调用示例：

```json
{
  "query_json": "{\"kinds\":[\"input\",\"template\",\"output\"],\"topics\":[\"references\"],\"includeSchema\":true}"
}
```

规划子 Agent 使用等价的 kinds/topics/includeSchema 参数。节点词典只说明如何表达；自然语言新建与修改仍走规划引擎，不能因读取词典或规划失败就绕过校验直接保存。词典例子仅是配置片段，未执行，也不是可直接导入或保存的完整工作流。

先通过索引选择节点，再查询 kinds（每次最多 5 个）/topics；必要时 includeSchema:true。例子只是配置片段，未执行，不是可直接保存的完整 Workflow；节点/Agent/工具 ID 是示意，须替换为冻结上下文中的合法 ID。

- 唯一当前 JSON 标准；规划提交精简投影，Host 补齐保存元数据。

- 模板引用是 {{稳定ID.字段}}，输入是 {{input.字段}}，不带 #。

- 生成图不执行任务；不确定字段、工具参数或输出路径先查询，不猜测、不绕开规划校验直接保存。

## 2、节点选择索引

| kind | 显示名 | 功能 |
| --- | --- | --- |
| `input` | 用户输入 | 定义运行开始时的用户表单；每层图的唯一入口。 |
| `template` | 模板转换 | 确定性文本模板，适合固定 Markdown 排版；不调用模型或工具。 |
| `llm` | 大语言模型 | 一次模型生成/总结/翻译，不调用工具；需要网页获取或写文件时另接工具节点或 Agent。 |
| `if` | 条件分支 | 确定性条件路由；三种互斥配置模式：单条件、多 cases、logicGate。 |
| `output` | 输出 | 把文本作为工作流运行结果展示；不负责落盘写文件。 |
| `agent` | Agent | 通过宿主原生子 Agent 执行有工具的任务，适合检索、读写文件和多步任务。 |
| `knowledge` | 知识检索 | 对工作区已存在文本资料做本地关键词片段检索；不是互联网搜索或向量数据库。 |
| `classifier` | 问题分类器 | 调用模型，从已声明类别中选一个并按类别 ID 路由。 |
| `human` | 人工介入 | 运行中暂停并询问真人，收到表单与操作选择后继续。 |
| `iteration` | 迭代 | 对数组逐项执行内部子图，并按输入顺序汇集结果。 |
| `loop` | 循环 | 有次数上限的重复子图，使用 vars 持续维护循环状态；先执行再检查 until。 |
| `exit_loop` | 退出循环 | 结束最近一层 loop 的当前执行；不用于结束整个根工作流。 |
| `code` | 代码执行 | 执行纯数据转换，必须实现同步 main(inputs) 并返回 JSON 对象。 |
| `aggregator` | 变量聚合器 | 把互斥分支输出合并成统一字段；每个组必须恰好一个分支实际有值。 |
| `document` | 文档提取器 | 从已有工作区文件或上传附件提取文本；按 local/tool/agent 选择真实解析器。 |
| `assigner` | 变量赋值 | 有序更新 vars 状态，常用于 loop 累加；不是修改任意节点配置。 |
| `extractor` | 参数提取器 | 调用模型从文本提取结构化字段；提取失败以状态字段返回，需显式分支。 |
| `http` | HTTP 请求 | 发起一次 HTTP(S) 请求，返回真实响应；与受保护凭据操作互斥。 |
| `list` | 列表操作 | 对数组依次筛选、排序、截取，不调用模型。 |
| `tool` | 工具 | 按真实工具目录参数调用一次工具；适合确定的网页获取、写文件及独立子工作流。 |

## 3、字段主题

### 3.1、workflow

**fields**

| 字段 | 含义 |
| --- | --- |
| `title` | 工作流显示名称。 |
| `description` | 工作流用途与前提说明。 |
| `nodes` | 当前图层节点数组。 |
| `edges` | 当前图层有向连线数组。 |
| `subAgents` | 工作流内子 Agent 定义；详查 subAgents。 |
| `environmentVariables` | 普通变量或 Secret 声明；详查 environment。 |
| `id` | 稳定工作流 ID，Host 分配/保留。 |
| `workspaceId` | 真实工作区 ID，Host 冻结。 |
| `revision` | 保存版本，用于乐观并发校验，不能当格式版本。 |
| `scope` | workspace/global 可见范围；不是权限授予。 |
| `notes` | 画布便签，不参与运行。 |
| `editor` | viewport、scopePath、annotations 画布编辑状态。 |
| `createdAt` | Host 保存的创建 ISO 时间。 |
| `updatedAt` | Host 保存的更新 ISO 时间。 |
| `archived` | 本地归档状态。 |
| `executionPolicy` | 运行并发与有限修复策略；详查 execution。 |

**nodeFields**

| 字段 | 含义 |
| --- | --- |
| `id` | 稳定节点 ID，规划只用原有或预分配 ID。 |
| `kind` | 20 种精确英文枚举之一。 |
| `title` | 显示标题。 |
| `config` | 本 kind 独有配置。 |
| `number` | Host 展示编号，不用于引用。 |
| `x` | Host 布局横坐标。 |
| `y` | Host 布局纵坐标。 |
| `fixed` | Host 固定编辑保护，不得移除。 |

**planningFields**：`title`、`description`、`nodes`、`edges`、`subAgents?`、`environmentVariables?`

**format**

| 字段 | 含义 |
| --- | --- |
| `format` | dsh-visible-workflow |
| `formatVersion` | 2 |
| `runtime` | {"engine":"graphon","protocol":1} |
| `workflow` | 完整 Workflow |
| `workflows` | 随包独立子流程数组 |
| `presets` | 角色预设数组 |
| `dependencies` | 外部依赖声明数组 |

- 模型规划投影不是导入包；节点只写 id/kind/title/config，连线不写 id，容器同样规则。Host 补齐布局、版本与身份。
- 不支持旧 JSON 字段、旧格式迁移或任意扩展字段。未知必填资源须询问或标待配置，不能假称可运行。

### 3.2、references

- 工作流输入字段统一用 {{input.字段}}；条件左值及列表来源等裸路径统一用 input.字段，不随创建或编辑的入口 key 改变。
- 其他上游值用 {{稳定节点ID.字段}}；禁止 # 包裹、a-1 展示编号、中文节点名。
- 过滤器、for、if 仅在 template.text 生效；其他可插值字段只支持普通 {{path}}，格式化先接 template 节点，或引用已格式化字段（如容器的 .text）。来源字段仍用裸路径，代码源码和其他字面字段不展开插值。
- 配置 inputs 的整值引用保留 JSON 类型；普通字符串插值产生文本。条件 variable、iterator、listSource、outputVariable、aggregator.variables 使用裸路径。
- 普通 prompt/输出 text 中的映射键用 {{input.键}}；映射会覆盖同名工作流输入，避免同名覆盖。
- template.text 直接引用 {{input.字段}} 或 {{上游节点key.字段}}，循环和过滤器也直接使用上游路径；无需通过 inputs 重命名上游值。template.inputs 无需填写，循环局部变量由 for 声明。
- 只能读取依赖链上游实际输出；连线不会自动把所有数据复制到 inputs。分支未执行的节点没有结果，先路由或用互斥聚合。
- 节点没有统一 result/output/data 包装；按节点词典中的 outputs 和已声明业务字段引用。代码按 main 返回键；工具按真实返回契约。
- Secret 不能通过 env 插值到模型、代码或工具输入；角色正文不是插值模板。

**examples**

```json
{
  "input": "{{input.name}}",
  "templateDirect": {
    "text": "你好，{{input.name}}"
  },
  "templateOutput": "{{greeting.text}}",
  "typedArray": {
    "items": "{{fetch.json.items}}"
  },
  "condition": {
    "variable": "fetch.status_code",
    "operator": "equals",
    "value": "200"
  }
}
```

### 3.3、edges

**fields**

| 字段 | 含义 |
| --- | --- |
| `source` | 当前层起点稳定 ID。 |
| `target` | 当前层终点稳定 ID，不能为 input。 |
| `port` | 起点实际出口，普通节点省略表示 default。 |
| `id` | 完整保存的连线身份，由 Host 补齐；规划省略。 |

**ports**

| 字段 | 含义 |
| --- | --- |
| `ordinary` | ["default"] |
| `if` | ["true","false"] |
| `ifCases` | ["cases[].id","false"] |
| `classifier` | ["classes[].id"] |
| `human` | ["actions[].id","default","timeout"] |

- 每层恰好一个 input；节点须从入口可达。
- 必须是有向无环图；使用 loop 表达循环，禁止跨容器连线。
- 数据引用必须与依赖边一致；声明引用本身不会建立执行先后。

### 3.4、subAgents

**fields**

| 字段 | 含义 |
| --- | --- |
| `id` | 工作流内身份 ID，规划使用预分配池。 |
| `name` | 工作流内唯一显示名称。 |
| `prompt` | 共享角色正文，字面文字不展开变量。 |
| `number` | Host 分配 agent-N 展示编号。 |
| `sessionId` | Host 本地主对话绑定，不是可迁移配置。 |
| `rolePresetId` | Host 记录的预设来源；角色执行使用保存的正文快照。 |
| `rolePresetRevision` | Host 记录的预设快照版本。 |

**example**

```json
{
  "subAgents": [
    {
      "id": "report-agent",
      "name": "报告整理员",
      "prompt": "根据已取得的资料整理报告，不编造事实。"
    }
  ],
  "nodeConfig": {
    "subagentId": "report-agent",
    "prompt": "整理：{{input.text}}",
    "tools": []
  }
}
```

- 规划只输出 id/name/prompt，节点 agent 用 config.subagentId 绑定。
- 共享身份不代表复用上次原生任务记忆；每次执行创建独立任务。
- sessionId/rolePresetId/rolePresetRevision 不随可移植导出保留。

### 3.5、environment

**fields**

| 字段 | 含义 |
| --- | --- |
| `id` | 稳定变量身份，env 引用用此 ID；规划来自预分配池。 |
| `name` | 显示和业务名称，不能代替 id 引用。 |
| `type` | string/number/secret。 |
| `description` | 用途说明。 |
| `required` | 运行前是否必须配置。 |
| `value` | 仅 string/number 可有，类型须匹配；secret 绝不能出现 value。 |
| `revision` | Host 保存版本，规划省略。 |

**example**

```json
{
  "environmentVariables": [
    {
      "id": "report-language",
      "name": "REPORT_LANGUAGE",
      "type": "string",
      "value": "中文"
    }
  ],
  "reference": "{{env.report-language}}"
}
```

- 系统变量用 sys.workflow_id / sys.workflow_run_id / sys.workspace_id / sys.session_id / sys.timestamp，由 Host 提供，不能在 Workflow 写 systemVariables。
- Secret 仅声明，由真人本机配置和授权；不能传 value、句柄、状态、密文或授权。
- 普通值导出默认去除，可由用户显式选择包含；Secret 永远只导出声明。

### 3.6、execution

**fields**

| 字段 | 含义 |
| --- | --- |
| `executionPolicy.maxConcurrentAgents` | 运行并发上限 1–8。 |
| `executionPolicy.repairMode` | confirm/auto；auto 还须宿主可信授权。 |
| `executionPolicy.maxRepairAttempts` | 每节点允许的有限模型修复次数，0–2。 |

- 以上字段由 Host 设置维护，不放进模型生成投影。
- 规划用量仅记录，不以累计 Token 或估算量截断；规划仍有防循环次数、总超时和用户取消。
- 生成、预览、保存图不会执行网页抓取或文件写入；发布成功以真实 receipt 为准。
- 执行始终保留权限、并发、循环、取消信号和节点超时边界。

### 3.7、containers

- loop/iteration 使用 config.body={nodes,edges}，没有 bodyGraph/children/loop-start/loop-end 替代结构。
- 各层有唯一 input；嵌套节点 ID 在整个工作流唯一；规划内部节点 ID 同样来自预分配池。
- 内部 input.字段 仍指工作流输入，并继承容器开始前的上游数据；iteration 另提供 item/index，loop 提供 index/vars。内部 input 不是 item 的自动副本。
- 内部输出由 outputVariable 选择并成为容器的 result；父图只能引用容器输出，不能引用内部节点。
- 所有层普通边仍无环；最大嵌套 5 层，整图含内部节点最多 500。

**example**

```json
{
  "iteration": {
    "iterator": "input.items",
    "body": {
      "nodes": [
        {
          "id": "inner-start",
          "kind": "input",
          "title": "内部入口",
          "config": {
            "fields": []
          }
        },
        {
          "id": "inner-result",
          "kind": "template",
          "title": "内部结果",
          "config": {
            "text": "{{item}}"
          }
        },
        {
          "id": "inner-end",
          "kind": "output",
          "title": "内部出口",
          "config": {
            "text": "{{inner-result.text}}",
            "outputName": "result"
          }
        }
      ],
      "edges": [
        {
          "source": "inner-start",
          "target": "inner-result"
        },
        {
          "source": "inner-result",
          "target": "inner-end"
        }
      ]
    },
    "outputVariable": "inner-result.text",
    "errorMode": "terminate",
    "parallel": false,
    "concurrency": 3
  }
}
```

## 4、节点字段、输出和例子

### 4.1、用户输入（input）

定义运行开始时的用户表单；每层图的唯一入口。

**config 字段**

| 字段 | 含义 |
| --- | --- |
| `fields` | 表单字段数组：name 为稳定业务键；label 为显示名；required 为必需布尔值；type 为 text/paragraph/number/boolean/select/json/file/files（省略 text）；defaultValue 始终是字符串，number/boolean/json 写其文本表示；options 仅 select；hidden 隐藏已有默认值字段。 |
| `verification` | 可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。 |
| `cache` | never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | 输入对象的 JSON 文本；若字段名本身为 text，则此键是该业务输入值。 |
| `<fields[].name>` | 每个已声明输入直接输出在顶层，按 type 转为原生 JSON 类型；不是 fields.name 或 result.name。 |

**配置例子**

```json
{
  "fields": [
    {
      "name": "name",
      "label": "姓名",
      "required": true,
      "type": "text"
    }
  ]
}
```

- 工作流输入字段统一用 {{input.字段}}；条件左值及列表来源等裸路径统一用 input.字段，不随创建或编辑的入口 key 改变。
- 手动运行且无需用户参数也必须保留一个 fields:[] 的 input。

### 4.2、模板转换（template）

确定性文本模板，适合固定 Markdown 排版；不调用模型或工具。

**config 字段**

| 字段 | 含义 |
| --- | --- |
| `text` | 模板正文，支持 {{变量}}、for/else、if/elif/else 和 11 种过滤器，完整语法和可渲染例子见本节点 syntax；不是任意 JavaScript/Jinja 环境。 |
| `inputs` | 无需填写；上游值直接在 text 中引用，循环局部变量由 for 声明。 |
| `verification` | 可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。 |
| `cache` | never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | 渲染后的字符串；此节点不会自动写文件。 |

**配置例子**

```json
{
  "text": "你好，{{input.name}}！"
}
```

- template.text 直接引用 {{input.字段}} 或 {{上游节点key.字段}}，循环和过滤器也直接使用上游路径；无需通过 inputs 重命名上游值。template.inputs 无需填写，循环局部变量由 for 声明。
- 输出路径是 template-id.text，不是 template-id.result。

**模板语法（词典说明，不是 config 新字段）**

| 字段 | 含义 |
| --- | --- |
| `interpolation` | 上游值直接用 {{input.name}}、{{fetch.value.rows[0].title}}；for 声明的局部变量用 {{row.title}}。支持字符串、数字、布尔、null 和有效 JSON 数组/对象字面量。 |
| `for` | {% for row in fetch.value.rows %}...{% else %}空列表...{% endfor %}；数组遍历值，对象遍历键。else 可省略。循环体局部变量 loop.index 从 1 开始，loop.index0 从 0 开始，loop.first/loop.last 为布尔值。 |
| `if` | {% if condition %}...{% elif other %}...{% else %}...{% endif %}；elif/else 可省略。条件支持 or、and、not、is defined、==、!=、&gt;=、&lt;=、&gt;、&lt;、in；运算符两边留空格，数值大小比较两侧必须为 number，in 用于数组包含或字符串子串。 |
| `filter` | {{input.text \| trim \| upper}}；用 \| 串联过滤器，参数写在括号中，如 default("暂无")、join(", ")。 |
| `comment` | {# 此注释不输出 #}。 |

**支持的过滤器**

| 字段 | 含义 |
| --- | --- |
| `default` | default(fallback, boolean?)：未定义时使用 fallback；第二参数 true 时也替换 null/false/0/空字符串；不会绕过禁止的跨作用域引用。 |
| `upper` | 转大写文本。 |
| `lower` | 转小写文本。 |
| `trim` | 去掉文本首尾空白。 |
| `length` | 数组项数、对象自有键数或文本长度。 |
| `join` | join(separator?)：连接数组项，默认空分隔符，要求数组。 |
| `first` | 数组第一项或文本首字符；空值结果未定义，可再接 default。 |
| `last` | 数组末项或文本末字符。 |
| `tojson` | 转紧凑 JSON 文本；字符串也保留 JSON 引号，未定义转 null。 |
| `replace` | replace(old, new)：替换文本中全部匹配子串，不是正则表达式。 |
| `sort` | 返回排序后的数组副本，适用于可比较的同类标量；不支持 attribute/key 参数或对象字段排序，对象排序用 code 节点。 |

- 返回值始终是节点的 text。
- 不提供 set、macro、import、函数调用、算术表达式、动态下标或任意 Jinja 扩展；日期格式化先用内置时间工具，复杂数据变换用 code。
- 缺失变量直接插值会报错，可选值用 default 或 is defined；if 的空数组为假，空对象按 JavaScript 真值为真。
- 每个 for 最多 1000 项；嵌套最多 20 层、处理步骤最多 10000、输出最多 400000 字符。循环变量和 loop 仅在循环体可用。
- 以下 input 是固定工作流输入夹具，不是节点 config 字段；config 仅展示直接引用的正文及预期文本，未经用户任务执行。

**Markdown 表格循环、条件与可选简介**

**固定工作流输入夹具与节点配置（input 不属于 config）**

```json
{
  "input": {
    "projects": [
      {
        "repo": "demo/alpha",
        "stars": 120,
        "description": "  A | B  "
      },
      {
        "repo": "demo/beta",
        "stars": 5
      }
    ]
  },
  "config": {
    "text": "| 排名 | 项目 | Stars | 简介 |\n| --- | --- | --- | --- |\n{% for project in input.projects %}| {{loop.index}} | {{project.repo}}{% if project.stars >= 100 %} ★{% endif %} | {{project.stars}} | {{project.description | default(\"暂无\") | trim | replace(\"|\", \"/\")}} |\n{% else %}暂无项目\n{% endfor %}"
  }
}
```

**预期渲染文本（固定示例输入）**

```text
| 排名 | 项目 | Stars | 简介 |
| --- | --- | --- | --- |
| 1 | demo/alpha ★ | 120 | A / B |
| 2 | demo/beta | 5 | 暂无 |

```

**空集合、elif 与已定义检查**

**固定工作流输入夹具与节点配置（input 不属于 config）**

```json
{
  "input": {
    "projects": [],
    "mode": "daily"
  },
  "config": {
    "text": "{# 报告模式 #}{% if input.title is defined %}{{input.title}}{% elif input.mode == \"daily\" and not input.projects %}今日无项目{% else %}项目报告{% endif %}\n{% for project in input.projects %}{{project.repo}}{% else %}空列表{% endfor %}"
  }
}
```

**预期渲染文本（固定示例输入）**

```text
今日无项目
空列表
```

**全部过滤器及其组合**

**固定工作流输入夹具与节点配置（input 不属于 config）**

```json
{
  "input": {
    "name": "  AbA  ",
    "values": [
      3,
      1,
      2
    ],
    "empty": "",
    "metadata": {
      "ok": true
    }
  },
  "config": {
    "text": "{{input.name | trim | upper | replace(\"A\", \"X\")}};{{input.name | trim | lower}};{{input.values | length}};{{input.values | sort | join(\",\")}};{{input.values | first}};{{input.values | last}};{{input.metadata | tojson}};{{input.missing | default(\"暂无\")}};{{input.empty | default(\"空\", true)}}"
  }
}
```

**预期渲染文本（固定示例输入）**

```text
XBX;aba;3;1,2,3;3;2;{"ok":true};暂无;空
```

**循环序号、首尾标记与数组下标**

**固定工作流输入夹具与节点配置（input 不属于 config）**

```json
{
  "input": {
    "names": [
      "甲",
      "乙"
    ]
  },
  "config": {
    "text": "{{input.names[0]}}/{% for name in input.names %}{{loop.index0}}:{{name}}{% if loop.first %}(首){% endif %}{% if loop.last %}(尾){% endif %};{% endfor %}"
  }
}
```

**预期渲染文本（固定示例输入）**

```text
甲/0:甲(首);1:乙(尾);
```

### 4.3、大语言模型（llm）

一次模型生成/总结/翻译，不调用工具；需要网页获取或写文件时另接工具节点或 Agent。

**config 字段**

| 字段 | 含义 |
| --- | --- |
| `prompt` | 本节点任务提示词；仅普通 {{path}} 插值，格式化先接 template。通过 {{input.字段}} 或上游稳定 ID 引用输入。不是子 Agent 的共享角色。 |
| `model` | 可选 {provider,model}，必须来自实际模型目录；省略沿用宿主选择，不臆造模型名称。 |
| `effort` | 模型支持的思考强度 ID；省略沿用当前宿主配置。 |
| `rolePresetId` | 可选已有角色预设 ID；不是自由角色正文。 |
| `inputs` | 业务参数映射。值可为 JSON 字面量或普通 {{上游ID.字段}} 插值；格式化先接 template。整个值仅含一个引用时保留数字、对象、数组等类型，拼接文本则变成字符串。裸字符串 node.field 不会在此自动当引用。 映射键在 prompt 中用 {{input.键}}。 |
| `outputSchema` | 结构化字段声明数组：name 是下游引用键，type 为 string/number/boolean/object/array，description 解释字段，required 表示必填。不要写 JSON Schema 对象替代这个数组。 |
| `verification` | 可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。 |
| `cache` | never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | 最终文本；结构化输出也保留此字段。 |
| `<outputSchema[].name>` | 配置结构化输出时校验并展开到顶层。 |
| `json` | 仅配置结构化输出时提供解析对象；普通文本模式不能依赖 json。 |

**配置例子**

```json
{
  "prompt": "把以下文本翻译为中文：{{input.text}}"
}
```

- 默认不指定 model/effort，让 Host 使用真实配置。
- 需要结构化字段时声明 outputSchema，不能假定模型自然语言自动变成可引用字段。

### 4.4、条件分支（if）

确定性条件路由；三种互斥配置模式：单条件、多 cases、logicGate。

**config 字段**

| 字段 | 含义 |
| --- | --- |
| `variable` | 单条件左值裸路径，例如 input.score。 |
| `operator` | 单条件比较运算，取 schema 中的 operator 枚举。 |
| `value` | 单条件右值文本，仅普通插值，格式化先接 template；not_empty/empty 无需填写。 |
| `cases` | 有序分支数组 {id,logic?:and\|or,conditions:Condition[]}，先命中先走，无命中走 false。conditions 使用条件对象。 |
| `logicGate` | 逻辑门 {operator:IF\|AND\|OR\|NOT\|NAND\|NOR\|XOR\|XNOR,inputs:[{value:JSON,predicate?:boolean\|truthy\|falsy\|nonEmpty}]}，value 可用普通完整引用；格式化先接 template；不要与 cases 混用。 |
| `verification` | 可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。 |
| `cache` | never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | 选中的出口 ID。 |
| `branch` | 选中的出口 ID。 |
| `result` | 单条件/逻辑门布尔结果；cases 模式不要用 result 判断是否命中，检查 branch。 |
| `inputs` | 仅 logicGate 返回已解析输入数组。 |
| `operands` | 仅 logicGate 返回布尔操作数数组。 |

**配置例子**

```json
{
  "variable": "input.score",
  "operator": "gte",
  "value": "60"
}
```

- 连线 port 必须 true/false；cases 模式为 cases[].id/false。
- 多个独立条件不是并行执行控制；无环依赖仍由 edges 描述。

### 4.5、输出（output）

把文本作为工作流运行结果展示；不负责落盘写文件。

**config 字段**

| 字段 | 含义 |
| --- | --- |
| `text` | 输出文本或上游字符串引用。仅普通 {{path}} 插值；格式化先接 template，或引用容器 .text（已是 JSON 文本）。 |
| `outputName` | 根运行 outputs 中的业务键，默认 result；同时激活的多个 output 必须不同名。 |
| `inputs` | 业务参数映射。值可为 JSON 字面量或普通 {{上游ID.字段}} 插值；格式化先接 template。整个值仅含一个引用时保留数字、对象、数组等类型，拼接文本则变成字符串。裸字符串 node.field 不会在此自动当引用。 映射键以 {{input.键}} 使用。 |
| `verification` | 可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。 |
| `cache` | never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | 当前节点的输出文本；outputName 只影响运行级 outputs 的键。 |

**配置例子**

```json
{
  "text": "{{format.text}}",
  "outputName": "report"
}
```

- CREATE 根入口 key 用 start；根层只有一个输出节点时 key 用 result；多个分支输出节点各取不同 key（如 passed、failed），无需声明 result；没有输出节点时不声明 result。start 和已声明的 result 复用预留身份，未声明的预留节点由 Host 移除。运行输出名只由 outputName 决定；互斥分支可共用 outputName，同时激活的输出须不同名。EDIT 已有节点沿用 n1/n2。
- output.text 不执行过滤器/for/if；先接 template 格式化，或直接引用容器 .text（已是 JSON 文本）。
- 生成 Markdown 文件必须通过真实写文件工具；接 output 只能展示。
- 下游引用当前节点用 node-id.text，而不是 node-id.report。

### 4.6、Agent（agent）

通过宿主原生子 Agent 执行有工具的任务，适合检索、读写文件和多步任务。

**config 字段**

| 字段 | 含义 |
| --- | --- |
| `prompt` | 本节点任务提示词；仅普通 {{path}} 插值，格式化先接 template。通过 {{input.字段}} 或上游稳定 ID 引用输入。不是子 Agent 的共享角色。 |
| `model` | 可选 {provider,model}，必须来自实际模型目录；省略沿用宿主选择，不臆造模型名称。 |
| `effort` | 模型支持的思考强度 ID；省略沿用当前宿主配置。 |
| `subagentId` | workflow.subAgents[].id，必需先定义身份；不是原生任务 ID，也不是 agent-N 展示编号。 |
| `outputSchema` | 结构化字段声明数组：name 是下游引用键，type 为 string/number/boolean/object/array，description 解释字段，required 表示必填。不要写 JSON Schema 对象替代这个数组。 |
| `tools` | 真实目录中获准的工具 ID 白名单；空数组表示无工具。不要猜测 native/mcp ID，先查工具目录参数 schema。 |
| `inputs` | 业务参数映射。值可为 JSON 字面量或普通 {{上游ID.字段}} 插值；格式化先接 template。整个值仅含一个引用时保留数字、对象、数组等类型，拼接文本则变成字符串。裸字符串 node.field 不会在此自动当引用。 |
| `maxSteps` | 本节点原生任务的模型步骤上限，1–20，默认 6；不是节点数量。 |
| `timeoutMs` | 可选节点执行超时毫秒，100–3600000；只限制本节点执行时长，与规划阶段的时间上限无关。 |
| `verification` | 可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。 |
| `cache` | never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | 最终文本；结构化输出也保留此字段。 |
| `json` | 结构化最终结果对象。 |
| `steps` | 此次原生任务步骤数。 |
| `<outputSchema[].name>` | 配置的结构化业务字段，校验后可直接引用。 |

**配置例子**

```json
{
  "subagentId": "report-agent",
  "prompt": "整理输入内容：{{input.text}}",
  "tools": [],
  "maxSteps": 6
}
```

- 同时创建 subAgents:[{id:"report-agent",name:"报告整理员",prompt:"按事实整理资料"}]；规划 ID 必须来自预分配池。
- 共享角色来自 subAgents[].prompt；本节点具体任务来自 config.prompt。agent 配置不接受 rolePresetId。
- 工具调用仍受宿主权限限制；声明 tools 不等于授权，不得使用委派/工作流调用工具绕开画布。

### 4.7、知识检索（knowledge）

对工作区已存在文本资料做本地关键词片段检索；不是互联网搜索或向量数据库。

**config 字段**

| 字段 | 含义 |
| --- | --- |
| `query` | 检索文本，仅普通插值；格式化先接 template。 |
| `sources` | 真实工作区资料路径数组；不能填写 URL 冒充知识库。 |
| `topK` | 期望最多返回条数（schema 1–50，当前执行器最多取 20）。 |
| `threshold` | 0–1 关键词命中比例阈值，不是向量余弦分数。 |
| `inputs` | 业务参数映射。值可为 JSON 字面量或普通 {{上游ID.字段}} 插值；格式化先接 template。整个值仅含一个引用时保留数字、对象、数组等类型，拼接文本则变成字符串。裸字符串 node.field 不会在此自动当引用。 |
| `verification` | 可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。 |
| `cache` | never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | 带来源的命中片段拼接。 |
| `results` | 命中数组，每项 {source,content,score}。 |
| `result` | 同 results 数组。 |
| `method` | 固定 local_keyword。 |
| `count` | 命中数量。 |

**配置例子**

```json
{
  "query": "{{input.query}}",
  "sources": [
    "notes.md"
  ],
  "topK": 5
}
```

- 资料路径由用户确认，缺失资料留为待配置；不要假定已有文件。

### 4.8、问题分类器（classifier）

调用模型，从已声明类别中选一个并按类别 ID 路由。

**config 字段**

| 字段 | 含义 |
| --- | --- |
| `prompt` | 本节点任务提示词；仅普通 {{path}} 插值，格式化先接 template。通过 {{input.字段}} 或上游稳定 ID 引用输入。不是子 Agent 的共享角色。 |
| `model` | 可选 {provider,model}，必须来自实际模型目录；省略沿用宿主选择，不臆造模型名称。 |
| `effort` | 模型支持的思考强度 ID；省略沿用当前宿主配置。 |
| `rolePresetId` | 已有角色预设 ID。 |
| `inputs` | 业务参数映射。值可为 JSON 字面量或普通 {{上游ID.字段}} 插值；格式化先接 template。整个值仅含一个引用时保留数字、对象、数组等类型，拼接文本则变成字符串。裸字符串 node.field 不会在此自动当引用。 |
| `classes` | 类别数组 {id,label,description?}；id 是连线 port，label 是显示名，description 辅助分类。 |
| `verification` | 可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。 |
| `cache` | never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | 选中类别 label。 |
| `class_id` | 选中的 classes[].id。 |
| `class_label` | 选中类别 label。 |
| `class_name` | 类别 description，未填则 label。 |

**配置例子**

```json
{
  "prompt": "判断输入是问题还是反馈：{{input.text}}",
  "classes": [
    {
      "id": "question",
      "label": "问题"
    },
    {
      "id": "feedback",
      "label": "反馈"
    }
  ]
}
```

- 每个分支连线 port 使用类别 ID，不用类别文字或 true/false。

### 4.9、人工介入（human）

运行中暂停并询问真人，收到表单与操作选择后继续。

**config 字段**

| 字段 | 含义 |
| --- | --- |
| `prompt` | 询问正文，仅普通插值；格式化先接 template。 |
| `fields` | 表单字段数组：name 为稳定业务键；label 为显示名；required 为必需布尔值；type 为 text/paragraph/number/boolean/select/json/file/files（省略 text）；defaultValue 始终是字符串，number/boolean/json 写其文本表示；options 仅 select；hidden 隐藏已有默认值字段。 此处 defaultValue 支持普通插值，格式化先接 template。 |
| `actions` | 操作按钮数组 {id,label}，id 是选中出口；至少一个，默认 continue。 |
| `timeoutSeconds` | 可选等待秒数；超时只有连接 timeout 出口才可按该分支继续。 |
| `verification` | 可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。 |
| `cache` | never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | 回答对象 JSON 文本。 |
| `<fields[].name>` | 用户回答的顶层类型化字段。 |
| `__action_id` | 选中按钮 ID，超时为 timeout。 |
| `__action_value` | 选中按钮 label。 |
| `__rendered_content` | 当时展示的询问正文。 |

**配置例子**

```json
{
  "prompt": "是否发布这份报告？",
  "fields": [],
  "actions": [
    {
      "id": "approve",
      "label": "同意"
    },
    {
      "id": "reject",
      "label": "拒绝"
    }
  ]
}
```

- 普通回答同时激活选中 action 和 default；超时仅 timeout。
- 不能放入并行 iteration。

### 4.10、迭代（iteration）

对数组逐项执行内部子图，并按输入顺序汇集结果。

**config 字段**

| 字段 | 含义 |
| --- | --- |
| `iterator` | 数组裸引用路径或 JSON 数组文本，例如 fetch.json.items；最多 1000 项。 |
| `body` | 独立子图 {nodes,edges}，每层一个 input。规划节点仅 {id,kind,title,config}，连线仅 {source,target,port?}；完整保存元数据由 Host 补齐。详查 containers。 |
| `outputVariable` | 必填内部节点输出裸路径，例如 inner-result.text；不能指向兄弟容器。 |
| `errorMode` | terminate 遇单项错误终止；null 保留空项；remove 删除失败项；不是自动重试。 |
| `parallel` | 是否并行处理各项，默认 false。 |
| `concurrency` | parallel=true 时最大并行项数，1–10，默认 3。 |
| `verification` | 可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。 |
| `cache` | never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | 结果数组 JSON 文本。 |
| `result` | 收集的类型化数组。 |
| `json` | 同 result。 |
| `errors` | 失败项 {index,error} 数组。 |

**配置例子**

```json
{
  "iterator": "input.items",
  "body": {
    "nodes": [
      {
        "id": "inner-start",
        "kind": "input",
        "title": "内部入口",
        "config": {
          "fields": []
        }
      },
      {
        "id": "inner-result",
        "kind": "template",
        "title": "内部结果",
        "config": {
          "text": "{{item}}"
        }
      },
      {
        "id": "inner-end",
        "kind": "output",
        "title": "内部出口",
        "config": {
          "text": "{{inner-result.text}}",
          "outputName": "result"
        }
      }
    ],
    "edges": [
      {
        "source": "inner-start",
        "target": "inner-result"
      },
      {
        "source": "inner-result",
        "target": "inner-end"
      }
    ]
  },
  "outputVariable": "inner-result.text",
  "errorMode": "terminate",
  "parallel": false,
  "concurrency": 3
}
```

- 子图中的当前项为 item（对象可 item.name），下标为 index；不是 input.item。
- 父图不能直接引用 inner-result；类型化数组用 iteration-id.result，JSON 文本用 iteration-id.text。
- 取消、人为暂停、exit_loop 不是可忽略的单项普通错误。

### 4.11、循环（loop）

有次数上限的重复子图，使用 vars 持续维护循环状态；先执行再检查 until。

**config 字段**

| 字段 | 含义 |
| --- | --- |
| `body` | 独立子图 {nodes,edges}，每层一个 input。规划节点仅 {id,kind,title,config}，连线仅 {source,target,port?}；完整保存元数据由 Host 补齐。详查 containers。 |
| `maxIterations` | 最多执行轮数 1–100，默认 10；达到上限即返回当前结果。 |
| `until` | 条件对象 {variable,operator,value?}。variable 用裸路径 input.name 或 node-id.field；operator 取当前 schema 枚举；value 是字符串，仅普通插值，格式化先接 template；运行时按左值类型比较。 每轮结束后成立则退出。 |
| `initialVariables` | 初始化 vars 的 JSON 映射，仅普通插值，格式化先接 template；assigner 在循环内更新。 |
| `outputVariable` | 可选最后一轮内部节点裸输出路径；省略返回最终变量对象。 |
| `verification` | 可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。 |
| `cache` | never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | 最终结果文本或 JSON 文本。 |
| `result` | outputVariable 选中的值，或最终 vars。 |
| `json` | 同 result。 |
| `variables` | 最终循环状态对象。 |
| `iterations` | 实际执行轮数。 |

**配置例子**

```json
{
  "body": {
    "nodes": [
      {
        "id": "inner-start",
        "kind": "input",
        "title": "内部入口",
        "config": {
          "fields": []
        }
      },
      {
        "id": "inner-result",
        "kind": "template",
        "title": "内部结果",
        "config": {
          "text": "{{index}}"
        }
      },
      {
        "id": "inner-end",
        "kind": "output",
        "title": "内部出口",
        "config": {
          "text": "{{inner-result.text}}",
          "outputName": "result"
        }
      }
    ],
    "edges": [
      {
        "source": "inner-start",
        "target": "inner-result"
      },
      {
        "source": "inner-result",
        "target": "inner-end"
      }
    ]
  },
  "initialVariables": {},
  "maxIterations": 2,
  "outputVariable": "inner-result.text"
}
```

- 普通 edges 不允许环；循环必须使用此容器。
- 没有 loop-start/loop-end NodeKind，内部仍是 input/output。
- exit_loop 只退出最近的 loop。

### 4.12、退出循环（exit_loop）

结束最近一层 loop 的当前执行；不用于结束整个根工作流。

**config 字段**

| 字段 | 含义 |
| --- | --- |
| `verification` | 可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。 |
| `cache` | never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | 执行记录会记录退出循环；不要依赖之后未执行节点的字段。 |

**配置例子**

```json
{}
```

- 仅允许处于 loop 内（可隔着 iteration）。
- config 不需要自造 target/condition；需要条件时前接 if。

### 4.13、代码执行（code）

执行纯数据转换，必须实现同步 main(inputs) 并返回 JSON 对象。

**config 字段**

| 字段 | 含义 |
| --- | --- |
| `language` | javascript（默认）或 python；不是 shell。 |
| `code` | 源码正文，不展开 {{变量}}；通过 inputs 读取已绑定数据。 |
| `inputs` | 业务参数映射。值可为 JSON 字面量或普通 {{上游ID.字段}} 插值；格式化先接 template。整个值仅含一个引用时保留数字、对象、数组等类型，拼接文本则变成字符串。裸字符串 node.field 不会在此自动当引用。 |
| `outputSchema` | 结构化字段声明数组：name 是下游引用键，type 为 string/number/boolean/object/array，description 解释字段，required 表示必填。不要写 JSON Schema 对象替代这个数组。 |
| `timeoutMs` | schema 允许 100–30000ms，当前执行器上限 JavaScript 3000ms/Python 10000ms。 |
| `verification` | 可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。 |
| `cache` | never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `<main 返回对象的键>` | 返回对象原样成为节点输出；不会自动添加 result 或 text。建议用 outputSchema 声明供下游发现。 |

**配置例子**

```json
{
  "language": "javascript",
  "inputs": {
    "text": "{{input.text}}"
  },
  "code": "function main(inputs) { return { result: inputs.text.trim() }; }",
  "outputSchema": [
    {
      "name": "result",
      "type": "string",
      "required": true
    }
  ],
  "timeoutMs": 3000
}
```

- JavaScript 不提供 fs、process、fetch、网络、模块导入、异步 Promise。获取网页/写文件用工具或 Agent。
- Python 是受限纯数据方言，不允许任意 import/第三方包；无可用强制沙箱会拒绝。

### 4.14、变量聚合器（aggregator）

把互斥分支输出合并成统一字段；每个组必须恰好一个分支实际有值。

**config 字段**

| 字段 | 含义 |
| --- | --- |
| `groups` | 数组 {name,variables:string[]}，name 是输出键，variables 是各互斥上游的裸路径，如 ["yes.text","no.text"]。 |
| `verification` | 可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。 |
| `cache` | never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `<groups[].name>` | 该组唯一已产生结果的值，保留 JSON 类型。 |
| `text` | 首值为字符串时取首值，否则结果对象 JSON。 |
| `json` | 各组结果对象。 |

**配置例子**

```json
{
  "groups": [
    {
      "name": "answer",
      "variables": [
        "yes.text",
        "no.text"
      ]
    }
  ]
}
```

- 不是 concat/join。多条同时成功的普通并行分支不能用此节点汇总；改用 template/code。
- 已知的非上游/跨容器引用仍被拒绝。

### 4.15、文档提取器（document）

从已有工作区文件或上传附件提取文本；按 local/tool/agent 选择真实解析器。

**config 字段**

| 字段 | 含义 |
| --- | --- |
| `prompt` | 本节点任务提示词；仅普通 {{path}} 插值，格式化先接 template。通过 {{input.字段}} 或上游稳定 ID 引用输入。不是子 Agent 的共享角色。 |
| `model` | 可选 {provider,model}，必须来自实际模型目录；省略沿用宿主选择，不臆造模型名称。 |
| `effort` | 模型支持的思考强度 ID；省略沿用当前宿主配置。 |
| `source` | 工作区相对路径、上传文件引用或文件列表引用；不等于网页抓取 URL。 |
| `documentMode` | local 轻量 UTF-8；tool 调用指定解析工具；agent 使用受限文档 Agent。 |
| `documentSourceKey` | tool 模式工具接收文件来源的参数名，默认 source。 |
| `documentTextPath` | tool 模式结果中正文字符串的点分路径，默认 text。 |
| `toolId` | tool 模式真实工具 ID，需目录确认其参数/输出。 |
| `inputs` | 业务参数映射。值可为 JSON 字面量或普通 {{上游ID.字段}} 插值；格式化先接 template。整个值仅含一个引用时保留数字、对象、数组等类型，拼接文本则变成字符串。裸字符串 node.field 不会在此自动当引用。 |
| `rolePresetId` | agent 模式可选已有角色预设 ID。 |
| `tools` | agent 模式允许的真实读取/解析工具 ID。 |
| `maxSteps` | agent 模式步骤数 2–20，默认 6。 |
| `verification` | 可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。 |
| `cache` | never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | 提取的正文。 |
| `source` | 文件名或名称数组。 |
| `characters` | 提取字符数。 |
| `documents` | 多文件模式的各文档结果（仅适用模式返回）。 |
| `steps` | agent 模式步骤数。 |
| `parser` | agent 模式值为 agent。 |

**配置例子**

```json
{
  "source": "notes.md",
  "documentMode": "local"
}
```

- local 仅文本格式，不能当作 PDF/DOCX/OCR 通用解析器；需要已连接且可用的解析工具。

### 4.16、变量赋值（assigner）

有序更新 vars 状态，常用于 loop 累加；不是修改任意节点配置。

**config 字段**

| 字段 | 含义 |
| --- | --- |
| `assignments` | 数组 {name,operation,value?}；name 为 vars 的键，不带 vars.；operation 为 set/clear/add/subtract/multiply/divide/append/extend/pop/shift；value 为 JSON/普通引用，格式化先接 template。 |
| `verification` | 可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。 |
| `cache` | never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `<assignments[].name>` | 本次写入的新值。 |
| `variables` | 本次改变的键值对象。 |
| `text` | 改变对象 JSON 文本。 |
| `json` | 同 variables。 |

**配置例子**

```json
{
  "assignments": [
    {
      "name": "count",
      "operation": "set",
      "value": 1
    }
  ]
}
```

- 下游通过 {{vars.count}} 或 {{assign-id.count}} 引用；依赖必须有连线。
- 算术要求已存在数值；append/extend/pop/shift 要求数组；并行 iteration 的状态按项隔离。

### 4.17、参数提取器（extractor）

调用模型从文本提取结构化字段；提取失败以状态字段返回，需显式分支。

**config 字段**

| 字段 | 含义 |
| --- | --- |
| `prompt` | 本节点任务提示词；仅普通 {{path}} 插值，格式化先接 template。通过 {{input.字段}} 或上游稳定 ID 引用输入。不是子 Agent 的共享角色。 |
| `model` | 可选 {provider,model}，必须来自实际模型目录；省略沿用宿主选择，不臆造模型名称。 |
| `effort` | 模型支持的思考强度 ID；省略沿用当前宿主配置。 |
| `rolePresetId` | 已有角色预设 ID。 |
| `parameters` | 结构化字段声明数组：name 是下游引用键，type 为 string/number/boolean/object/array，description 解释字段，required 表示必填。不要写 JSON Schema 对象替代这个数组。 |
| `inputs` | 业务参数映射。值可为 JSON 字面量或普通 {{上游ID.字段}} 插值；格式化先接 template。整个值仅含一个引用时保留数字、对象、数组等类型，拼接文本则变成字符串。裸字符串 node.field 不会在此自动当引用。 |
| `verification` | 可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。 |
| `cache` | never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | 最终文本；结构化输出也保留此字段。 |
| `__is_success` | 1 为提取并校验成功，0 为失败。 |
| `__reason` | 失败原因；成功为空字符串。 |
| `<parameters[].name>` | 仅成功时输出的字段。 |
| `json` | 仅成功时提供解析对象。 |

**配置例子**

```json
{
  "prompt": "从文本提取姓名，不要编造：{{input.text}}",
  "parameters": [
    {
      "name": "name",
      "type": "string",
      "required": true
    }
  ]
}
```

- 下游访问必需字段前检查 __is_success；节点本身完成不代表每个业务字段都存在。

### 4.18、HTTP 请求（http）

发起一次 HTTP(S) 请求，返回真实响应；与受保护凭据操作互斥。

**config 字段**

| 字段 | 含义 |
| --- | --- |
| `url` | 直接请求 URL，仅普通插值，格式化先接 template；无浏览器渲染。 |
| `method` | GET/HEAD/POST/PUT/PATCH/DELETE，默认 GET。 |
| `headers` | 请求头字符串映射，仅普通插值，格式化先接 template；禁止把 Secret 明文写入。 |
| `bodyText` | 请求体文本，仅普通插值，格式化先接 template；GET/HEAD 不发送。 |
| `timeoutMs` | 直接请求超时毫秒，100–120000，默认 30000。 |
| `inputs` | 业务参数映射。值可为 JSON 字面量或普通 {{上游ID.字段}} 插值；格式化先接 template。整个值仅含一个引用时保留数字、对象、数组等类型，拼接文本则变成字符串。裸字符串 node.field 不会在此自动当引用。 |
| `credentialOperation` | 受保护模式仅 {secretVariableId,operationId:"deepseek.account-status.v1"}；该模式禁止 url/method/headers/bodyText/inputs/timeoutMs，并且仍需用户在本机配置授权。 |
| `verification` | 可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。 |
| `cache` | never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | 直接请求响应正文 UTF-8。 |
| `body` | 同 text。 |
| `status_code` | 真实 HTTP 状态码。 |
| `headers` | 过滤敏感字段后的响应头。 |
| `json` | 仅直接响应能解析 JSON 时提供。 |
| `ok` | 仅受保护凭据操作的布尔摘要；该模式不返回正文或 Secret。 |

**配置例子**

```json
{
  "url": "https://example.com/data.json",
  "method": "GET",
  "headers": {},
  "timeoutMs": 30000
}
```

- 不自动跟随重定向；4xx/5xx 仍返回 status_code，应由 if 检查。
- 需要登录、浏览器渲染或复杂抓取时查询真实工具能力；不在规划阶段访问网页。

### 4.19、列表操作（list）

对数组依次筛选、排序、截取，不调用模型。

**config 字段**

| 字段 | 含义 |
| --- | --- |
| `listSource` | 数组裸引用路径或 JSON 数组文本；最多 1000 项。 |
| `filter` | 条件对象 {variable,operator,value?}。variable 用裸路径 input.name 或 node-id.field；operator 取当前 schema 枚举；value 是字符串，仅普通插值，格式化先接 template；运行时按左值类型比较。 条件内部可用 item、index。 |
| `sort` | 可选 asc/desc，仅同类型字符串/数字/布尔值；不是对象字段排序。 |
| `limit` | 可选取前 N 项，1–20；省略不截取。 |
| `verification` | 可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。 |
| `cache` | never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | 结果 JSON 文本。 |
| `result` | 类型化结果数组。 |
| `json` | 同 result。 |
| `first_record` | 第一项原类型值，空数组为 null。 |
| `last_record` | 最后一项原类型值，空数组为 null。 |

**配置例子**

```json
{
  "listSource": "input.items",
  "limit": 10
}
```

- 对象按 star 等字段排序需使用 code；不要臆造 sortBy 字段。

### 4.20、工具（tool）

按真实工具目录参数调用一次工具；适合确定的网页获取、写文件及独立子工作流。

**config 字段**

| 字段 | 含义 |
| --- | --- |
| `toolId` | 当前工具目录中的精确 ID，不等于显示名。用工具目录按需查看 inputSchema/可用状态。 |
| `inputs` | 业务参数映射。值可为 JSON 字面量或普通 {{上游ID.字段}} 插值；格式化先接 template。整个值仅含一个引用时保留数字、对象、数组等类型，拼接文本则变成字符串。裸字符串 node.field 不会在此自动当引用。 键名与工具 inputSchema 一致；不是 args 或 parameters 字段。 |
| `verification` | 可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。 |
| `cache` | never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | native: 工具为原始 value 的字符串或 JSON 文本；workflow: 工具为子运行 outputs 的 JSON 文本；内置/API 工具按各自契约。 |
| `value` | native: 工具的原始结构化返回值，访问业务字段须用 tool-node.value.字段；若 value 本身是 JSON 文本则先用 builtin:json.parse。 |
| `outputs` | 仅 workflow: 工具提供子流程按 outputName 命名的结果映射。 |
| `run_id` | 仅 workflow: 工具提供本次子运行 ID。 |
| `<内置/API 工具专有字段>` | 内置 JSON 工具按其契约提供 value/json 等；OpenAPI 工具同 HTTP 响应。不能假设所有工具都有 result/json。 |

**配置例子**

```json
{
  "toolId": "builtin:json.parse",
  "inputs": {
    "text": "{{input.text}}"
  }
}
```

- 必须先查询当前真实工具目录和必填参数；示例是已内置 JSON 解析器，不代表任意工具都接受 text。
- builtinTools 是当前 9 个内置工具的语义说明，不是 config 新字段；调用时仍只写 {toolId,inputs}。内置输出直接位于节点顶层，例如 {{clock.iso}}、{{clock.datetime}}、{{parsed.value.items}}。
- builtinTools.example.expected 仅为固定输入的预期结果；clock 仅标记测试所用固定时刻，不是工具参数。time.now/timestamp 的真实结果以实际运行时钟为准。
- workflow:ID 调用子工作流也经工具目录验证，不能构造递归调用。

**内置工具输出契约（词典说明，不是 config 新字段）**

以下仅描述当前内置工具；输出字段直接位于工具节点顶层。示例结果来自固定输入，含 clock 的例子按指定测试时刻解释；clock/expected 均不是工具参数，也不代表已执行用户任务。

**builtin:time.now**

**inputs 参数**

| 字段 | 含义 |
| --- | --- |
| `timezone` | 可选 IANA 时区字符串，默认 UTC。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | string：指定时区的 YYYY-MM-DD HH:mm:ss 文本，不含 UTC 偏移。 |
| `datetime` | string：同 text，是本地时间文本；不能直接传给要求 Z/UTC 偏移的日期参数。 |
| `iso` | string：同一时刻的 UTC ISO 8601 字符串，结尾为 Z。 |
| `timezone` | string：实际使用的 IANA 时区；默认 UTC。 |
| `timestamp` | number：Unix 秒时间戳（向下取整），不是毫秒。 |

**调用配置例子**

```json
{
  "toolId": "builtin:time.now",
  "inputs": {
    "timezone": "Asia/Shanghai"
  }
}
```

测试固定时刻：`2000-01-01T00:00:00.000Z`。

**预期输出**

```json
{
  "text": "2000-01-01 08:00:00",
  "datetime": "2000-01-01 08:00:00",
  "iso": "2000-01-01T00:00:00.000Z",
  "timezone": "Asia/Shanghai",
  "timestamp": 946684800
}
```

**builtin:time.timestamp**

**inputs 参数**

| 字段 | 含义 |
| --- | --- |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | string：Unix 秒时间戳文本。 |
| `seconds` | number：Unix 秒时间戳（向下取整）。 |
| `milliseconds` | number：Unix 毫秒时间戳。 |

**调用配置例子**

```json
{
  "toolId": "builtin:time.timestamp",
  "inputs": {}
}
```

测试固定时刻：`2000-01-01T00:00:00.000Z`。

**预期输出**

```json
{
  "text": "946684800",
  "seconds": 946684800,
  "milliseconds": 946684800000
}
```

**builtin:time.from_timestamp**

**inputs 参数**

| 字段 | 含义 |
| --- | --- |
| `timestamp` | 必填 number：Unix 时间戳。 |
| `unit` | 可选 seconds/milliseconds，默认 seconds。 |
| `timezone` | 可选 IANA 时区，默认 UTC。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | string：指定时区的 YYYY-MM-DD HH:mm:ss 文本，不含 UTC 偏移。 |
| `datetime` | string：同 text，是本地时间文本；不能直接传给要求 Z/UTC 偏移的日期参数。 |
| `iso` | string：同一时刻的 UTC ISO 8601 字符串，结尾为 Z。 |
| `timezone` | string：实际使用的 IANA 时区；默认 UTC。 |
| `timestamp` | number：Unix 秒时间戳（向下取整），不是毫秒。 |

**调用配置例子**

```json
{
  "toolId": "builtin:time.from_timestamp",
  "inputs": {
    "timestamp": 946684800000,
    "unit": "milliseconds",
    "timezone": "Asia/Shanghai"
  }
}
```

**预期输出**

```json
{
  "text": "2000-01-01 08:00:00",
  "datetime": "2000-01-01 08:00:00",
  "iso": "2000-01-01T00:00:00.000Z",
  "timezone": "Asia/Shanghai",
  "timestamp": 946684800
}
```

**builtin:time.convert_timezone**

**inputs 参数**

| 字段 | 含义 |
| --- | --- |
| `datetime` | 必填 string：带 Z 或 ±HH:mm UTC 偏移的日期时间；不能传不带偏移的本地 datetime 输出，应传 iso。 |
| `timezone` | 必填 string：目标 IANA 时区。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | string：指定时区的 YYYY-MM-DD HH:mm:ss 文本，不含 UTC 偏移。 |
| `datetime` | string：同 text，是本地时间文本；不能直接传给要求 Z/UTC 偏移的日期参数。 |
| `iso` | string：同一时刻的 UTC ISO 8601 字符串，结尾为 Z。 |
| `timezone` | string：实际使用的 IANA 时区；默认 UTC。 |
| `timestamp` | number：Unix 秒时间戳（向下取整），不是毫秒。 |

**调用配置例子**

```json
{
  "toolId": "builtin:time.convert_timezone",
  "inputs": {
    "datetime": "2000-01-01T00:00:00.000Z",
    "timezone": "Asia/Shanghai"
  }
}
```

**预期输出**

```json
{
  "text": "2000-01-01 08:00:00",
  "datetime": "2000-01-01 08:00:00",
  "iso": "2000-01-01T00:00:00.000Z",
  "timezone": "Asia/Shanghai",
  "timestamp": 946684800
}
```

**builtin:time.weekday**

**inputs 参数**

| 字段 | 含义 |
| --- | --- |
| `datetime` | 可选带 Z/UTC 偏移的日期时间；省略取当前时刻。 |
| `timezone` | 可选 IANA 时区，默认 UTC。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | string：中文星期文本，如 星期六。 |
| `weekday` | string：同 text。 |
| `timezone` | string：实际 IANA 时区。 |

**调用配置例子**

```json
{
  "toolId": "builtin:time.weekday",
  "inputs": {
    "datetime": "2000-01-01T00:00:00.000Z",
    "timezone": "UTC"
  }
}
```

**预期输出**

```json
{
  "text": "星期六",
  "weekday": "星期六",
  "timezone": "UTC"
}
```

**builtin:json.parse**

**inputs 参数**

| 字段 | 含义 |
| --- | --- |
| `text` | 必填 string：有效 JSON 文本。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | string：解析值的紧凑 JSON 文本。 |
| `value` | JSON：解析后的原生值，可为对象、数组、数字、布尔、字符串或 null。 |
| `json` | JSON：同 value。 |

**调用配置例子**

```json
{
  "toolId": "builtin:json.parse",
  "inputs": {
    "text": "{\"items\":[{\"title\":\"示例\"}]}"
  }
}
```

**预期输出**

```json
{
  "text": "{\"items\":[{\"title\":\"示例\"}]}",
  "value": {
    "items": [
      {
        "title": "示例"
      }
    ]
  },
  "json": {
    "items": [
      {
        "title": "示例"
      }
    ]
  }
}
```

**builtin:json.stringify**

**inputs 参数**

| 字段 | 含义 |
| --- | --- |
| `value` | 必填任意 JSON 值。 |
| `pretty` | 可选 boolean；true 使用 2 空格缩进，默认紧凑文本。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | string：序列化后的 JSON 文本；不返回 value/json。 |

**调用配置例子**

```json
{
  "toolId": "builtin:json.stringify",
  "inputs": {
    "value": {
      "name": "示例"
    },
    "pretty": true
  }
}
```

**预期输出**

```json
{
  "text": "{\n  \"name\": \"示例\"\n}"
}
```

**builtin:json.select**

**inputs 参数**

| 字段 | 含义 |
| --- | --- |
| `value` | 必填 JSON 值，通常对象或数组。 |
| `path` | 必填点分隔路径，如 items.0.title；不存在或原型属性会报错。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | string：选中字符串原样返回，其他值序列化为 JSON 文本。 |
| `value` | JSON：选中值原生类型；不返回 json。 |

**调用配置例子**

```json
{
  "toolId": "builtin:json.select",
  "inputs": {
    "value": {
      "items": [
        {
          "title": "示例"
        }
      ]
    },
    "path": "items.0.title"
  }
}
```

**预期输出**

```json
{
  "text": "示例",
  "value": "示例"
}
```

**builtin:json.merge**

**inputs 参数**

| 字段 | 含义 |
| --- | --- |
| `left` | 必填 JSON 对象。 |
| `right` | 必填 JSON 对象；同名键覆盖 left，仅浅合并。 |

**输出字段**

| 字段 | 含义 |
| --- | --- |
| `text` | string：合并对象的紧凑 JSON 文本。 |
| `value` | object：合并对象；不返回 json。 |

**调用配置例子**

```json
{
  "toolId": "builtin:json.merge",
  "inputs": {
    "left": {
      "count": 1,
      "detail": {
        "a": 1
      }
    },
    "right": {
      "detail": {
        "b": 2
      }
    }
  }
}
```

**预期输出**

```json
{
  "text": "{\"count\":1,\"detail\":{\"b\":2}}",
  "value": {
    "count": 1,
    "detail": {
      "b": 2
    }
  }
}
```

## 5、来源与验证

- [共享语义词典](../../../src/shared/workflow-semantics.ts)：运行时工具和本页使用同一描述源。
- [当前节点与 Workflow 校验](../../../src/shared/workflow-validation.ts)：字段类型、默认值、上限和未知字段拒绝。
- [按需 schema 投影](../../../src/shared/node-capabilities.ts)：复用当前校验器，不建立替代 JSON 标准。
- [生成投影与 Host 补齐](../../../src/shared/planning-projection.ts)：可编辑字段、身份、布局和版本边界。
- [引用依赖作用域](../../../src/shared/reference-scope.ts)：稳定 ID、上游、容器与 Secret 边界。
- [节点运行](../../../src/host/runtime.ts)与[具体适配器](../../../src/host/execution-adapters.ts)：实际执行、返回值与限制。
- [宿主工具和子工作流包装](../../../src/host/index.ts)：native 工具 value/text 与子流程 outputs/run_id。
- [语义测试](../../../tests/workflow-semantics.test.ts)：20 种配置示例和当前 schema 一致、字段说明覆盖、输入引用投影校验、真实隔离 JavaScript 返回对象。

- [内置工具执行器](../../../src/host/tool-catalog.ts)：当前 9 个 builtin 工具的参数及实际输出结构。
- [模板解释器](../../../src/host/template.ts)：循环、条件、过滤器和执行边界。
- 语义测试还调用真实 `executeBuiltin` 和 `renderDataTemplate` 验证本页的固定输入例子；时间相关示例使用固定测试时钟，属于本地确定性验收。

自动测试与词典字段一致性不代表任意真实模型、网页或工具的业务结果已通过验证。外部资源可用性仍以当前宿主目录、就绪检查及实际运行结果为准。
