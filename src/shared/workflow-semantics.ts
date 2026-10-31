import { z } from 'zod'
import { NODE_LABELS, type JsonValue, type NodeKind } from './types.ts'
import { nodeCapabilityCatalog } from './node-capabilities.ts'
import { REVIEW_BEFORE_EFFECT_GUIDANCE } from './planning-review.ts'

/** Descriptions supplement the live validator; they never introduce another JSON format. */
export const WORKFLOW_SEMANTIC_TOPICS = ['workflow', 'references', 'edges', 'subAgents', 'environment', 'execution', 'containers'] as const
const kinds = Object.keys(NODE_LABELS) as [NodeKind, ...NodeKind[]]
export const workflowSemanticsQuerySchema = z.object({
  kinds: z.array(z.enum(kinds)).max(5).optional().describe('按需选择最多 5 种节点；省略只返回节点索引，不返回全部 schema'),
  topics: z.array(z.enum(WORKFLOW_SEMANTIC_TOPICS)).max(7).optional().describe('需要补充理解的字段主题'),
  includeSchema: z.boolean().optional().describe('true 时附带所选节点的当前校验 schema；不是整份目录'),
}).strict()
export type WorkflowSemanticsQuery = z.infer<typeof workflowSemanticsQuerySchema>
type Description = {
  purpose: string; fields: Record<string, string>; outputs: Record<string, string>
  example: Record<string, unknown>; rules: string[]
  createExample?:Record<string,unknown>
  builtinTools?: { toolId: string; inputs: Record<string, string>; outputs: Record<string, string>; example: { inputs: Record<string, JsonValue>; expected: Record<string, JsonValue>; clock?: string; file?: string } }[]
  syntax?: { statements: Record<string, string>; filters: Record<string, string>; rules: string[]; examples: { title: string; input: Record<string, JsonValue>; config: { text: string }; expected: string }[] }
}

// Read-only semantic metadata, not additional node config fields. The examples
// are checked against executeBuiltin/renderDataTemplate in workflow-semantics.test.
const dateOutputs = {
  text: 'string：指定时区的 YYYY-MM-DD HH:mm:ss 文本，不含 UTC 偏移。',
  datetime: 'string：同 text，是本地时间文本；不能直接传给要求 Z/UTC 偏移的日期参数。',
  iso: 'string：同一时刻的 UTC ISO 8601 字符串，结尾为 Z。',
  timezone: 'string：实际使用的 IANA 时区；默认 UTC。',
  timestamp: 'number：Unix 秒时间戳（向下取整），不是毫秒。',
}
const exampleClock = '2000-01-01T00:00:00.000Z'
const exampleDate = { text: '2000-01-01 08:00:00', datetime: '2000-01-01 08:00:00', iso: exampleClock, timezone: 'Asia/Shanghai', timestamp: 946684800 }
const builtinTools: NonNullable<Description['builtinTools']> = [
  { toolId: 'builtin:time.now', inputs: { timezone: '可选 IANA 时区字符串，默认 UTC。' }, outputs: dateOutputs, example: { inputs: { timezone: 'Asia/Shanghai' }, clock: exampleClock, expected: exampleDate } },
  { toolId: 'builtin:time.timestamp', inputs: {}, outputs: { text: 'string：Unix 秒时间戳文本。', seconds: 'number：Unix 秒时间戳（向下取整）。', milliseconds: 'number：Unix 毫秒时间戳。' }, example: { inputs: {}, clock: exampleClock, expected: { text: '946684800', seconds: 946684800, milliseconds: 946684800000 } } },
  { toolId: 'builtin:time.from_timestamp', inputs: { timestamp: '必填 number：Unix 时间戳。', unit: '可选 seconds/milliseconds，默认 seconds。', timezone: '可选 IANA 时区，默认 UTC。' }, outputs: dateOutputs, example: { inputs: { timestamp: 946684800000, unit: 'milliseconds', timezone: 'Asia/Shanghai' }, expected: exampleDate } },
  { toolId: 'builtin:time.convert_timezone', inputs: { datetime: '必填 string：带 Z 或 ±HH:mm UTC 偏移的日期时间；不能传不带偏移的本地 datetime 输出，应传 iso。', timezone: '必填 string：目标 IANA 时区。' }, outputs: dateOutputs, example: { inputs: { datetime: exampleClock, timezone: 'Asia/Shanghai' }, expected: exampleDate } },
  { toolId: 'builtin:time.weekday', inputs: { datetime: '可选带 Z/UTC 偏移的日期时间；省略取当前时刻。', timezone: '可选 IANA 时区，默认 UTC。' }, outputs: { text: 'string：中文星期文本，如 星期六。', weekday: 'string：同 text。', timezone: 'string：实际 IANA 时区。' }, example: { inputs: { datetime: exampleClock, timezone: 'UTC' }, expected: { text: '星期六', weekday: '星期六', timezone: 'UTC' } } },
  { toolId: 'builtin:json.parse', inputs: { text: '必填 string：有效 JSON 文本。' }, outputs: { text: 'string：解析值的紧凑 JSON 文本。', value: 'JSON：解析后的原生值，可为对象、数组、数字、布尔、字符串或 null。', json: 'JSON：同 value。' }, example: { inputs: { text: '{"items":[{"title":"示例"}]}' }, expected: { text: '{"items":[{"title":"示例"}]}', value: { items: [{ title: '示例' }] }, json: { items: [{ title: '示例' }] } } } },
  { toolId: 'builtin:json.stringify', inputs: { value: '必填任意 JSON 值。', pretty: '可选 boolean；true 使用 2 空格缩进，默认紧凑文本。' }, outputs: { text: 'string：序列化后的 JSON 文本；不返回 value/json。' }, example: { inputs: { value: { name: '示例' }, pretty: true }, expected: { text: '{\n  "name": "示例"\n}' } } },
  { toolId: 'builtin:json.select', inputs: { value: '必填 JSON 值，通常对象或数组。', path: '必填点分隔路径，如 items.0.title；不存在或原型属性会报错。' }, outputs: { text: 'string：选中字符串原样返回，其他值序列化为 JSON 文本。', value: 'JSON：选中值原生类型；不返回 json。' }, example: { inputs: { value: { items: [{ title: '示例' }] }, path: 'items.0.title' }, expected: { text: '示例', value: '示例' } } },
  { toolId: 'builtin:json.merge', inputs: { left: '必填 JSON 对象。', right: '必填 JSON 对象；同名键覆盖 left，仅浅合并。' }, outputs: { text: 'string：合并对象的紧凑 JSON 文本。', value: 'object：合并对象；不返回 json。' }, example: { inputs: { left: { count: 1, detail: { a: 1 } }, right: { detail: { b: 2 } } }, expected: { text: '{"count":1,"detail":{"b":2}}', value: { count: 1, detail: { b: 2 } } } } },
  { toolId: 'builtin:file.stat', inputs: { path: '必填 string：工作区相对路径，常用 {{input.字段}} 或迭代中的 item。' }, outputs: { text: 'string：一句话摘要。', path: 'string：工作区相对路径。', name: 'string：文件名（不含目录），表格里列文件名用它。', bytes: 'number：文件真实字节数，含 BOM 和行尾。', lines: 'number：行数；末尾换行不多算一行。', lineEnding: 'string：lf/crlf/cr/mixed/none。', endsWithNewline: 'boolean：是否以换行结尾。', bom: 'boolean：是否有 UTF-8 BOM。' }, example: { file: '\uFEFFid,name\r\n1,甲\r\n', inputs: { path: 'data/a.csv' }, expected: { text: 'data/a.csv：19 字节，2 行，行尾 crlf，有 UTF-8 BOM', path: 'data/a.csv', name: 'a.csv', bytes: 19, lines: 2, lineEnding: 'crlf', endsWithNewline: true, bom: true } } },
  { toolId: 'builtin:html.extract_text', inputs: { html: '必填 HTML 字符串；支持上游 {{节点.text}} 缓存全文。', statusCode: '可选 HTTP 状态码，非 2xx 返回 http_error。', contentType: '可选响应类型，非 HTML 返回 not_html。', maxChars: '可选正文字符上限，默认 20000，最大 200000。', url: '可选页面地址，原样输出。', headers: '可选响应头；未指定 contentType 时从中读取，缺失时尝试提取。' }, outputs: { status: 'ok/http_error/not_html/empty。', title: '页面标题。', text: '可读正文。', truncated: '标题或正文是否达到字符限制而截断。', httpStatus: '仅提供 statusCode 时输出原状态码。', url: '仅提供 url 时原样输出。' }, example: { inputs: { html: '<title>示例</title><main>正文</main>', statusCode: 200, url: 'https://example.com/' }, expected: { status: 'ok', title: '示例', text: '正文', truncated: false, httpStatus: 200, url: 'https://example.com/' } } },
  { toolId: 'builtin:html.select', inputs: { html: '必填 HTML 字符串；支持上游 {{节点.text}} 缓存全文。', items: '必填记录 CSS 选择器。', baseUrl: '可选页面地址，用于补全 href/src。', fields: '必填 1–20 个字段，值为 {selector?,attr} 或 {selector?,text:true}。', limit: '可选记录数，默认 100，最大 500。' }, outputs: { items: '记录数组；无法绝对化的链接保留原值并在记录 _unresolvedLinks 中标记字段名。', count: '返回记录数。', text: 'items 的紧凑 JSON 文本。' }, example: { inputs: { html: '<a href="/repo">仓库</a>', items: 'a', fields: { name: { text: true }, link: { attr: 'href' } }, baseUrl: 'https://example.com/' }, expected: { items: [{ name: '仓库', link: 'https://example.com/repo' }], count: 1, text: '[{"name":"仓库","link":"https://example.com/repo"}]' } } },
]
// Planner teaching only: validators and runtime retain legacy reference and alias support.
export const CANONICAL_INPUT_GUIDANCE='工作流输入字段统一用 {{input.字段}}；条件左值及列表来源等裸路径统一用 input.字段，不随创建或编辑的入口 key 改变。'
export const CANONICAL_TEMPLATE_GUIDANCE='template.text 直接引用 {{input.字段}} 或 {{上游节点key.字段}}，循环和过滤器也直接使用上游路径；无需通过 inputs 重命名上游值。template.inputs 无需填写，循环局部变量由 for 声明。'
export const TEMPLATE_RENDER_BOUNDARY_GUIDANCE='过滤器、for、if 仅在 template.text 生效；其他可插值字段只支持普通 {{path}}，格式化先接 template 节点，或引用已格式化字段（如容器的 .text）。来源字段仍用裸路径，代码源码和其他字面字段不展开插值。'
export const CANONICAL_EXIT_GUIDANCE='CREATE 根入口 key 用 start；根层只有一个输出节点时 key 用 result；多个分支输出节点各取不同 key（如 passed、failed），无需声明 result；没有输出节点时不声明 result。start 和已声明的 result 复用预留身份，未声明的预留节点由 Host 移除。运行输出名只由 outputName 决定；互斥分支可共用 outputName，同时激活的输出须不同名。EDIT 已有节点沿用 n1/n2。'

const templateSyntax: NonNullable<Description['syntax']> = {
  statements: {
    interpolation: '上游值直接用 {{input.name}}、{{fetch.value.rows[0].title}}；for 声明的局部变量用 {{row.title}}。支持字符串、数字、布尔、null 和有效 JSON 数组/对象字面量。',
    for: '{% for row in fetch.value.rows %}...{% else %}空列表...{% endfor %}；数组遍历值，对象遍历键。else 可省略。循环体局部变量 loop.index 从 1 开始，loop.index0 从 0 开始，loop.first/loop.last 为布尔值。',
    if: '{% if condition %}...{% elif other %}...{% else %}...{% endif %}；elif/else 可省略。条件支持 or、and、not、is defined、==、!=、>=、<=、>、<、in；运算符两边留空格，数值大小比较两侧必须为 number，in 用于数组包含或字符串子串。',
    filter: '{{input.text | trim | upper}}；用 | 串联过滤器，参数写在括号中，如 default("暂无")、join(", ")。',
    comment: '{# 此注释不输出 #}。',
  },
  filters: {
    default: 'default(fallback, boolean?)：未定义时使用 fallback；第二参数 true 时也替换 null/false/0/空字符串；不会绕过禁止的跨作用域引用。',
    upper: '转大写文本。', lower: '转小写文本。', trim: '去掉文本首尾空白。',
    length: '数组项数、对象自有键数或文本长度。', join: 'join(separator?)：连接数组项，默认空分隔符，要求数组。',
    first: '数组第一项或文本首字符；空值结果未定义，可再接 default。', last: '数组末项或文本末字符。',
    tojson: '转紧凑 JSON 文本；字符串也保留 JSON 引号，未定义转 null。',
    replace: 'replace(old, new)：替换文本中全部匹配子串，不是正则表达式。',
    sort: '返回排序后的数组副本，适用于可比较的同类标量；不支持 attribute/key 参数或对象字段排序，对象排序用 code 节点。',
  },
  rules: [
    '返回值始终是节点的 text。',
    '不提供 set、macro、import、函数调用、算术表达式、动态下标或任意 Jinja 扩展；日期格式化先用内置时间工具，复杂数据变换用 code。',
    '缺失变量直接插值会报错，可选值用 default 或 is defined；if 的空数组为假，空对象按 JavaScript 真值为真。',
    '每个 for 最多 1000 项；嵌套最多 20 层、处理步骤最多 10000、输出最多 400000 字符。循环变量和 loop 仅在循环体可用。',
    '以下 input 是固定工作流输入夹具，不是节点 config 字段；config 仅展示直接引用的正文及预期文本，未经用户任务执行。',
  ],
  examples: [
    { title: 'Markdown 表格循环、条件与可选简介', input: { projects: [{ repo: 'demo/alpha', stars: 120, description: '  A | B  ' }, { repo: 'demo/beta', stars: 5 }] }, config: {
      text: '| 排名 | 项目 | Stars | 简介 |\n| --- | --- | --- | --- |\n{% for project in input.projects %}| {{loop.index}} | {{project.repo}}{% if project.stars >= 100 %} ★{% endif %} | {{project.stars}} | {{project.description | default("暂无") | trim | replace("|", "/")}} |\n{% else %}暂无项目\n{% endfor %}',
    }, expected: '| 排名 | 项目 | Stars | 简介 |\n| --- | --- | --- | --- |\n| 1 | demo/alpha ★ | 120 | A / B |\n| 2 | demo/beta | 5 | 暂无 |\n' },
    { title: '空集合、elif 与已定义检查', input: { projects: [], mode: 'daily' }, config: { text: '{# 报告模式 #}{% if input.title is defined %}{{input.title}}{% elif input.mode == "daily" and not input.projects %}今日无项目{% else %}项目报告{% endif %}\n{% for project in input.projects %}{{project.repo}}{% else %}空列表{% endfor %}' }, expected: '今日无项目\n空列表' },
    { title: '全部过滤器及其组合', input: { name: '  AbA  ', values: [3, 1, 2], empty: '', metadata: { ok: true } }, config: { text: '{{input.name | trim | upper | replace("A", "X")}};{{input.name | trim | lower}};{{input.values | length}};{{input.values | sort | join(",")}};{{input.values | first}};{{input.values | last}};{{input.metadata | tojson}};{{input.missing | default("暂无")}};{{input.empty | default("空", true)}}' }, expected: 'XBX;aba;3;1,2,3;3;2;{"ok":true};暂无;空' },
    { title: '循环序号、首尾标记与数组下标', input: { names: ['甲', '乙'] }, config: { text: '{{input.names[0]}}/{% for name in input.names %}{{loop.index0}}:{{name}}{% if loop.first %}(首){% endif %}{% if loop.last %}(尾){% endif %};{% endfor %}' }, expected: '甲/0:甲(首);1:乙(尾);' },
  ],
}
const modelFields = {
  prompt: '本节点任务提示词；仅普通 {{path}} 插值，格式化先接 template。通过 {{input.字段}} 或上游稳定 ID 引用输入。不是子 Agent 的共享角色。',
  model: '可选 {provider,model}，必须来自实际模型目录；省略沿用宿主选择，不臆造模型名称。',
  effort: '模型支持的思考强度 ID；省略沿用当前宿主配置。',
}
const inputMapping = '业务参数映射。值可为 JSON 字面量或普通 {{上游ID.字段}} 插值；格式化先接 template。整个值仅含一个引用时保留数字、对象、数组等类型，拼接文本则变成字符串。裸字符串 node.field 不会在此自动当引用。'
const parameters = '结构化字段声明数组：name 是下游引用键，type 为 string/number/boolean/object/array，description 解释字段，required 表示必填。不要写 JSON Schema 对象替代这个数组。'
/** What an upload field carries at run time, and how its content is read. */
export const ATTACHMENT_SHAPE = '运行时上传的附件对象 {name,mimeType,size}（另有 Host 内部文件身份）；不含正文，也没有 path 字段，不能当文件路径传给 read 等读文件工具。'
export const ATTACHMENT_READ_RULE = '读取上传附件（type=file/files）的正文用 document 节点：source 写裸路径 input.字段（如 input.file），documentMode=local 读 txt/md/csv/tsv/json/yaml/xml/html/log，其他格式选 tool 或 agent 模式。'
const inputFields = '表单字段数组：name 为稳定业务键；label 为显示名；required 为必需布尔值；type 为 text/paragraph/number/boolean/select/json/file/files（省略 text）；defaultValue 始终是字符串，number/boolean/json 写其文本表示；options 仅 select；hidden 隐藏已有默认值字段。'
const condition = '条件对象 {variable,operator,value?}。variable 用裸路径 input.name 或 node-id.field；operator 取当前 schema 枚举；value 是字符串，仅普通插值，格式化先接 template；运行时按左值类型比较。'
const body = 'Host 保存的内部子图；CREATE 不填写此字段。内部节点独立声明，以 container chain 归属和排序；详查 containers。'
const outputFields = { text: '最终文本；结构化输出也保留此字段。' }
const containerExample=(kind:'loop'|'iteration')=>({mode:'create',title:'容器声明示例',nodes:[
  {key:'start',kind:'input',config:{fields:kind==='iteration'?[{name:'items',label:'项目',type:'json',required:true}]:[]}},
  {key:'repeat',kind,config:kind==='iteration'?{iterator:'input.items',outputVariable:'innerResult.text'}:{maxIterations:2,outputVariable:'innerResult.text'}},
  {key:'innerResult',kind:'template',config:{text:kind==='iteration'?'{{item}}':'{{index}}'}},
  {key:'result',kind:'output',config:{text:'{{repeat.text}}',outputName:'result'}},
],chains:[{key:'main',nodes:['start','repeat','result']},{key:'bodyChain',container:'repeat',nodes:['innerResult']}],coverage:{R1:['repeat','innerResult','result']}})

// A small structural example, not a second file-write recipe. File observation,
// draft persistence and commit semantics belong to the versioned module.
export const REVIEW_CREATE_EXAMPLE={mode:'create',title:'审核容器声明片段（文件写入请用模块）',nodes:[
  {key:'start',kind:'input',config:{fields:[]}},
  {key:'reviewLoop',kind:'loop',config:{maxIterations:3,initialVariables:{stopped:false},until:{variable:'vars.stopped',operator:'equals',value:'true'}}},
  {key:'produce',kind:'template',config:{text:'待审核正文'}},
  {key:'reviewGate',kind:'human',config:{prompt:'请在表单正文中修改并审核',fields:[{name:'content',label:'正文',type:'paragraph',required:false,defaultValue:'{{produce.text}}'}],actions:[{id:'approve',label:'通过'},{id:'reject',label:'退回'}]}},
  {key:'stop',kind:'assigner',config:{assignments:[{name:'stopped',operation:'set',value:true}]}},
  {key:'rejected',kind:'output',config:{text:'not-approved'}},
  {key:'result',kind:'output',config:{text:'{{reviewLoop.text}}',outputName:'result'}},
],chains:[{key:'main',nodes:['start','reviewLoop','result']},{key:'review',container:'reviewLoop',nodes:['produce','reviewGate']},{key:'approved',container:'reviewLoop',nodes:['stop']},{key:'rejectedChain',container:'reviewLoop',nodes:['rejected']}],links:[{key:'yes',source:'reviewGate',target:'stop',port:'approve'},{key:'no',source:'reviewGate',target:'rejected',port:'reject'}],coverage:{R1:['reviewLoop','reviewGate','result']}}

export const NODE_SEMANTICS: Readonly<Record<NodeKind, Description>> = {
  input: {
    purpose: '定义运行开始时的用户表单；每层图的唯一入口。',
    fields: { fields: inputFields },
    outputs: { text: '输入对象的 JSON 文本；若字段名本身为 text，则此键是该业务输入值。', '<fields[].name>': '每个已声明输入直接输出在顶层，按 type 转为原生 JSON 类型；不是 fields.name 或 result.name。', '<file 字段>': ATTACHMENT_SHAPE, '<files 字段>': '同 file 字段的附件对象数组。' },
    example: { fields: [{ name: 'name', label: '姓名', required: true, type: 'text' }] },
    rules: [CANONICAL_INPUT_GUIDANCE, '手动运行且无需用户参数也必须保留一个 fields:[] 的 input。', ATTACHMENT_READ_RULE],
  },
  template: {
    purpose: '确定性文本模板，适合固定 Markdown 排版；不调用模型或工具。',
    fields: { text: '模板正文，支持 {{变量}}、for/else、if/elif/else 和 11 种过滤器，完整语法和可渲染例子见本节点 syntax；不是任意 JavaScript/Jinja 环境。', inputs: '无需填写；上游值直接在 text 中引用，循环局部变量由 for 声明。' },
    outputs: { text: '渲染后的字符串；此节点不会自动写文件。' },
    example: { text: '你好，{{input.name}}！' },
    syntax: templateSyntax,
    rules: [CANONICAL_TEMPLATE_GUIDANCE, '输出路径是 template-id.text，不是 template-id.result。'],
  },
  llm: {
    purpose: '一次模型生成/总结/翻译，不调用工具；需要网页获取或写文件时另接工具节点或 Agent。',
    fields: { ...modelFields, rolePresetId: '可选已有角色预设 ID；不是自由角色正文。', inputs: inputMapping + ' 映射键在 prompt 中用 {{input.键}}。', outputSchema: parameters },
    outputs: { ...outputFields, '<outputSchema[].name>': '配置结构化输出时校验并展开到顶层。', json: '仅配置结构化输出时提供解析对象；普通文本模式不能依赖 json。' },
    example: { prompt: '把以下文本翻译为中文：{{input.text}}' }, rules: ['默认不指定 model/effort，让 Host 使用真实配置。', '需要结构化字段时声明 outputSchema，不能假定模型自然语言自动变成可引用字段。'],
  },
  if: {
    purpose: '确定性条件路由；三种互斥配置模式：单条件、多 cases、logicGate。',
    fields: { variable: '单条件左值裸路径，例如 input.score。', operator: '单条件比较运算，取 schema 中的 operator 枚举。', value: '单条件右值文本，仅普通插值，格式化先接 template；not_empty/empty 无需填写。', cases: '有序分支数组 {id,logic?:and|or,conditions:Condition[]}，先命中先走，无命中走 false。conditions 每项只含 {variable,operator,value?}，例如 {variable:"input.count",operator:"gte",value:"1"}；gte/gt/lte/lt 是 operator 的取值，不能另写 gte:true 等属性。', logicGate: '逻辑门 {operator:IF|AND|OR|NOT|NAND|NOR|XOR|XNOR,inputs:[{value:JSON,predicate?:boolean|truthy|falsy|nonEmpty}]}，value 可用普通完整引用；格式化先接 template；不要与 cases 混用。' },
    outputs: { text: '选中的出口 ID。', branch: '选中的出口 ID。', result: '单条件/逻辑门布尔结果；cases 模式不要用 result 判断是否命中，检查 branch。', inputs: '仅 logicGate 返回已解析输入数组。', operands: '仅 logicGate 返回布尔操作数数组。' },
    example: { variable: 'input.score', operator: 'gte', value: '60' },
    rules: ['连线 port 必须 true/false；cases 模式为 cases[].id/false。', '多个独立条件不是并行执行控制；无环依赖仍由 edges 描述。'],
  },
  output: {
    purpose: '把文本作为工作流运行结果展示；不负责落盘写文件。',
    fields: { text: '输出文本或上游字符串引用。仅普通 {{path}} 插值；格式化先接 template，或引用容器 .text（已是 JSON 文本）。', outputName: '根运行 outputs 中的业务键，默认 result；同时激活的多个 output 必须不同名。', inputs: inputMapping + ' 映射键以 {{input.键}} 使用。' },
    outputs: { text: '当前节点的输出文本；outputName 只影响运行级 outputs 的键。' },
    example: { text: '{{format.text}}', outputName: 'report' },
    rules: [CANONICAL_EXIT_GUIDANCE, 'output.text 不执行过滤器/for/if；先接 template 格式化，或直接引用容器 .text（已是 JSON 文本）。', '生成 Markdown 文件必须通过真实写文件工具；接 output 只能展示。', '下游引用当前节点用 node-id.text，而不是 node-id.report。'],
  },
  agent: {
    purpose: '通过宿主原生子 Agent 执行有工具的任务，适合检索、读写文件和多步任务。',
    fields: { ...modelFields, subagentId: 'workflow.subAgents[].id，必需先定义身份；不是原生任务 ID，也不是 agent-N 展示编号。', outputSchema: parameters, tools: '真实目录中获准的工具 ID 白名单；空数组表示无工具。不要猜测 native/mcp ID，先查工具目录参数 schema。', inputs: inputMapping, maxSteps: '本节点原生任务的模型步骤上限，1–20，默认 6；不是节点数量。', timeoutMs: '可选节点执行超时毫秒，100–3600000；只限制本节点执行时长，与规划阶段的时间上限无关。' },
    outputs: { ...outputFields, json: '结构化最终结果对象。', steps: '此次原生任务步骤数。', '<outputSchema[].name>': '配置的结构化业务字段，校验后可直接引用。' },
    example: { subagentId: 'report-agent', prompt: '整理输入内容：{{input.text}}', tools: [], maxSteps: 6 },
    rules: ['同时创建 subAgents:[{id:"report-agent",name:"报告整理员",prompt:"按事实整理资料"}]；规划 ID 必须来自预分配池。', '共享角色来自 subAgents[].prompt；本节点具体任务来自 config.prompt。agent 配置不接受 rolePresetId。', '工具调用仍受宿主权限限制；声明 tools 不等于授权，不得使用委派/工作流调用工具绕开画布。'],
  },
  knowledge: {
    purpose: '对工作区已存在文本资料做本地关键词片段检索；不是互联网搜索或向量数据库。',
    fields: { query: '检索文本，仅普通插值；格式化先接 template。', sources: '真实工作区资料路径数组；不能填写 URL 冒充知识库。', topK: '期望最多返回条数（schema 1–50，当前执行器最多取 20）。', threshold: '0–1 关键词命中比例阈值，不是向量余弦分数。', inputs: inputMapping },
    outputs: { text: '带来源的命中片段拼接。', results: '命中数组，每项 {source,content,score}。', result: '同 results 数组。', method: '固定 local_keyword。', count: '命中数量。' },
    example: { query: '{{input.query}}', sources: ['notes.md'], topK: 5 },
    rules: ['资料路径由用户确认，缺失资料留为待配置；不要假定已有文件。'],
  },
  classifier: {
    purpose: '调用模型，从已声明类别中选一个并按类别 ID 路由。',
    fields: { ...modelFields, rolePresetId: '已有角色预设 ID。', inputs: inputMapping, classes: '类别数组 {id,label,description?}；id 是连线 port，label 是显示名，description 辅助分类。' },
    outputs: { text: '选中类别 label。', class_id: '选中的 classes[].id。', class_label: '选中类别 label。', class_name: '类别 description，未填则 label。' },
    example: { prompt: '判断输入是问题还是反馈：{{input.text}}', classes: [{ id: 'question', label: '问题' }, { id: 'feedback', label: '反馈' }] },
    rules: ['每个分支连线 port 使用类别 ID，不用类别文字或 true/false。'],
  },
  human: {
    purpose: '运行中暂停并询问真人，收到表单与操作选择后继续。',
    fields: { prompt: '询问正文，仅普通插值；格式化先接 template。', fields: inputFields + ' 此处 defaultValue 支持普通插值，格式化先接 template。', actions: '操作按钮数组 {id,label}，id 是选中出口；至少一个，默认 continue。', timeoutSeconds: '可选等待秒数；超时只有连接 timeout 出口才可按该分支继续。' },
    outputs: { text: '回答对象 JSON 文本。', '<fields[].name>': '用户回答的顶层类型化字段。', __action_id: '选中按钮 ID，超时为 timeout。', __action_value: '选中按钮 label。', __rendered_content: '当时展示的询问正文。' },
    example: { prompt: '是否发布这份报告？', fields: [], actions: [{ id: 'approve', label: '同意' }, { id: 'reject', label: '拒绝' }] },
    rules: ['普通回答同时激活选中 action 和 default；超时仅 timeout。', '不能放入并行 iteration。'],
  },
  iteration: {
    purpose: '对数组逐项执行内部子图，并按输入顺序汇集结果。',
    fields: { iterator: '数组裸引用路径或 JSON 数组文本，例如 fetch.json.items；最多 1000 项。', body, outputVariable: '必填内部节点输出裸路径，例如 inner-result.text；不能指向兄弟容器。', errorMode: 'terminate 遇单项错误终止；null 保留空项；remove 删除失败项；不是自动重试。', parallel: '是否并行处理各项，默认 false。', concurrency: 'parallel=true 时最大并行项数，1–10，默认 3。' },
    outputs: { text: '结果数组 JSON 文本。', result: '收集的类型化数组。', json: '同 result。', errors: '失败项 {index,error} 数组。' },
    example: { iterator: 'input.items', outputVariable: 'innerResult.text', errorMode: 'terminate', parallel: false, concurrency: 3 },
    createExample:containerExample('iteration'),
    rules: ['子图中的当前项为 item（对象可 item.name），下标为 index；不是 input.item。', '父图不能直接引用 inner-result；类型化数组用 iteration-id.result，JSON 文本用 iteration-id.text。', '取消、人为暂停、exit_loop 不是可忽略的单项普通错误。'],
  },
  loop: {
    purpose: '有次数上限的重复子图，使用 vars 持续维护循环状态；先执行再检查 until。',
    fields: { body, maxIterations: '最多执行轮数 1–100，默认 10；达到上限即返回当前结果。', until: condition + ' 每轮结束后成立则退出。', initialVariables: '初始化 vars 的 JSON 映射，仅普通插值，格式化先接 template；assigner 在循环内更新。', outputVariable: '可选最后一轮内部节点裸输出路径；省略返回最终变量对象。' },
    outputs: { text: '最终结果文本或 JSON 文本。', result: 'outputVariable 选中的值，或最终 vars。', json: '同 result。', variables: '最终循环状态对象。', iterations: '实际执行轮数。' },
    example: { initialVariables: {}, maxIterations: 2, outputVariable: 'innerResult.text' },
    createExample:containerExample('loop'),
    rules: ['普通 edges 不允许环；循环必须使用此容器。', '没有 loop-start/loop-end NodeKind，内部仍是 input/output。', 'exit_loop 只退出最近的 loop。'],
  },
  exit_loop: {
    purpose: '结束最近一层 loop 的当前执行；不用于结束整个根工作流。', fields: {}, outputs: { text: '执行记录会记录退出循环；不要依赖之后未执行节点的字段。' }, example: {}, rules: ['仅允许处于 loop 内（可隔着 iteration）。', 'config 不需要自造 target/condition；需要条件时前接 if。'],
  },
  code: {
    purpose: '执行纯数据转换，必须实现同步 main(inputs) 并返回 JSON 对象。',
    fields: { language: 'javascript（默认）或 python；不是 shell。', code: '源码正文，不展开 {{变量}}；通过 inputs 读取已绑定数据。', inputs: inputMapping, outputSchema: parameters, timeoutMs: 'schema 允许 100–30000ms，当前执行器上限 JavaScript 3000ms/Python 10000ms。' },
    outputs: { '<main 返回对象的键>': '返回对象原样成为节点输出；不会自动添加 result 或 text。建议用 outputSchema 声明供下游发现。' },
    example: { language: 'javascript', inputs: { text: '{{input.text}}' }, code: 'function main(inputs) { return { result: inputs.text.trim() }; }', outputSchema: [{ name: 'result', type: 'string', required: true }], timeoutMs: 3000 },
    rules: ['JavaScript 不提供 fs、process、fetch、网络、模块导入、异步 Promise。获取网页/写文件用工具或 Agent。', 'Python 是受限纯数据方言，不允许任意 import/第三方包；无可用强制沙箱会拒绝。'],
  },
  aggregator: {
    purpose: '把互斥分支输出合并成统一字段；每个组必须恰好一个分支实际有值。',
    fields: { groups: '数组 {name,variables:string[]}，name 是输出键，variables 是各互斥上游的裸路径，如 ["yes.text","no.text"]。' },
    outputs: { '<groups[].name>': '该组唯一已产生结果的值，保留 JSON 类型。', text: '首值为字符串时取首值，否则结果对象 JSON。', json: '各组结果对象。' },
    example: { groups: [{ name: 'answer', variables: ['yes.text', 'no.text'] }] },
    rules: ['不是 concat/join。多条同时成功的普通并行分支不能用此节点汇总；改用 template/code。', '已知的非上游/跨容器引用仍被拒绝。'],
  },
  document: {
    purpose: '从已有工作区文件或上传附件提取文本；按 local/tool/agent 选择真实解析器。',
    fields: { ...modelFields, source: '工作区相对路径、上传文件引用或文件列表引用；不等于网页抓取 URL。上传附件或路径参数都写裸路径 input.字段（如 input.file）。', documentMode: 'local 轻量 UTF-8；tool 调用指定解析工具；agent 使用受限文档 Agent。', documentSourceKey: 'tool 模式工具接收文件来源的参数名，默认 source。', documentTextPath: 'tool 模式结果中正文字符串的点分路径，默认 text。', toolId: 'tool 模式真实工具 ID，需目录确认其参数/输出。', inputs: inputMapping, rolePresetId: 'agent 模式可选已有角色预设 ID。', tools: 'agent 模式允许的真实读取/解析工具 ID。', maxSteps: 'agent 模式步骤数 2–20，默认 6。' },
    outputs: { text: '提取的正文；local 模式为文件原文（去掉开头 BOM），不带行号，可直接交给写入节点原样另存。', source: '文件名或名称数组。', characters: '提取字符数。', documents: '多文件模式的各文档结果（仅适用模式返回）。', steps: 'agent 模式步骤数。', parser: 'agent 模式值为 agent。' },
    example: { source: 'notes.md', documentMode: 'local' },
    rules: ['local 仅文本格式，不能当作 PDF/DOCX/OCR 通用解析器；需要已连接且可用的解析工具。', ATTACHMENT_READ_RULE, 'local 输出的 text 已去掉开头的 UTF-8 BOM；文件字节数或行数用 builtin:file.stat 统计，不要从 text 推算。'],
  },
  assigner: {
    purpose: '有序更新 vars 状态，常用于 loop 累加；不是修改任意节点配置。',
    fields: { assignments: '数组 {name,operation,value?}；name 为 vars 的键，不带 vars.；operation 为 set/clear/add/subtract/multiply/divide/append/extend/pop/shift；value 为 JSON/普通引用，格式化先接 template。' },
    outputs: { '<assignments[].name>': '本次写入的新值。', variables: '本次改变的键值对象。', text: '改变对象 JSON 文本。', json: '同 variables。' },
    example: { assignments: [{ name: 'count', operation: 'set', value: 1 }] },
    rules: ['下游通过 {{vars.count}} 或 {{assign-id.count}} 引用；依赖必须有连线。', '算术要求已存在数值；append/extend/pop/shift 要求数组；并行 iteration 的状态按项隔离。'],
  },
  extractor: {
    purpose: '调用模型从文本提取结构化字段；提取失败以状态字段返回，需显式分支。',
    fields: { ...modelFields, rolePresetId: '已有角色预设 ID。', parameters, inputs: inputMapping },
    outputs: { ...outputFields, __is_success: '1 为提取并校验成功，0 为失败。', __reason: '失败原因；成功为空字符串。', '<parameters[].name>': '仅成功时输出的字段。', json: '仅成功时提供解析对象。' },
    example: { prompt: '从文本提取姓名，不要编造：{{input.text}}', parameters: [{ name: 'name', type: 'string', required: true }] },
    rules: ['下游访问必需字段前检查 __is_success；节点本身完成不代表每个业务字段都存在。'],
  },
  http: {
    purpose: '发起一次 HTTP(S) 请求，返回真实响应；与受保护凭据操作互斥。',
    fields: { url: '直接请求 URL，仅普通插值，格式化先接 template；无浏览器渲染。', method: 'GET/HEAD/POST/PUT/PATCH/DELETE，默认 GET。', headers: '请求头字符串映射，仅普通插值，格式化先接 template；禁止把 Secret 明文写入。', bodyText: '请求体文本，仅普通插值，格式化先接 template；GET/HEAD 不发送。', timeoutMs: '直接请求超时毫秒，100–120000，默认 30000。', inputs: inputMapping, credentialOperation: '受保护模式仅 {secretVariableId,operationId:"deepseek.account-status.v1"}；该模式禁止 url/method/headers/bodyText/inputs/timeoutMs，并且仍需用户在本机配置授权。' },
    outputs: { text: '直接请求响应正文 UTF-8。', body: '同 text。', bytes: '响应正文字节数（解压后）；统计大小直接用它。', status_code: '真实 HTTP 状态码。', headers: '过滤敏感字段后的响应头。', json: '仅直接响应能解析 JSON 时提供。', ok: '仅受保护凭据操作的布尔摘要；该模式不返回正文或 Secret。' },
    example: { url: 'https://example.com/data.json', method: 'GET', headers: {}, timeoutMs: 30000 },
    rules: ['不自动跟随重定向；4xx/5xx 仍返回 status_code，应由 if 检查。', 'HTTP 节点输出完整正文（最多 10 MB，超过则报错，不截断）；代码节点输入上限 2 MB，大网页先用 HTML 处理节点提取需要的内容，再交给代码节点，不要把整页 text/body 交给代码节点。', '需要登录、浏览器渲染或复杂抓取时查询真实工具能力；不在规划阶段访问网页。'],
  },
  list: {
    purpose: '对数组依次筛选、排序、截取，不调用模型。',
    fields: { listSource: '数组裸引用路径或 JSON 数组文本；最多 1000 项。', filter: condition + ' 条件内部可用 item、index。', sort: '可选 asc/desc，仅同类型字符串/数字/布尔值；不是对象字段排序。', limit: '可选取前 N 项，1–20；省略不截取。' },
    outputs: { text: '结果 JSON 文本。', result: '类型化结果数组。', json: '同 result。', first_record: '第一项原类型值，空数组为 null。', last_record: '最后一项原类型值，空数组为 null。' },
    example: { listSource: 'input.items', limit: 10 }, rules: ['对象按 star 等字段排序需使用 code；不要臆造 sortBy 字段。'],
  },
  tool: {
    purpose: '按真实工具目录参数调用一次工具；适合确定的网页获取、写文件及独立子工作流。',
    fields: { toolId: '当前工具目录中的精确 ID，不等于显示名。用工具目录按需查看 inputSchema/可用状态。', inputs: inputMapping + ' 键名与工具 inputSchema 一致；不是 args 或 parameters 字段。' },
    outputs: { text: 'native: 工具为原始 value 的字符串或 JSON 文本；workflow: 工具为子运行 outputs 的 JSON 文本；内置/API 工具按各自契约。', value: 'native: 工具的原始结构化返回值，访问业务字段须用 tool-node.value.字段；若 value 本身是 JSON 文本则先用 builtin:json.parse。', outputs: '仅 workflow: 工具提供子流程按 outputName 命名的结果映射。', run_id: '仅 workflow: 工具提供本次子运行 ID。', '<内置/API 工具专有字段>': '内置 JSON 工具按其契约提供 value/json 等；OpenAPI 工具同 HTTP 响应。不能假设所有工具都有 result/json。' },
    example: { toolId: 'builtin:json.parse', inputs: { text: '{{input.text}}' } },
    builtinTools,
    rules: ['必须先查询当前真实工具目录和必填参数；示例是已内置 JSON 解析器，不代表任意工具都接受 text。', 'builtinTools 是当前 12 个内置工具的语义说明，不是 config 新字段；调用时仍只写 {toolId,inputs}。内置输出直接位于节点顶层，例如 {{clock.iso}}、{{clock.datetime}}、{{parsed.value.items}}。', 'builtinTools.example.expected 仅为固定输入的预期结果；clock 仅标记测试所用固定时刻，file 是示例假定的文件内容，不是工具参数。time.now/timestamp 的真实结果以实际运行时钟为准。', 'workflow:ID 调用子工作流也经工具目录验证，不能构造递归调用。'],
  },
}

const commonFields = {
  verification: '可选验收规则：requiredFiles 文件必须存在；requiredReadFiles 要求受信完整读取回执；requiredChangedFiles 要求前后内容哈希变化；minTextLength 要求最终文本最少字符数。文件路径相对工作区，规划/保存不会执行这些验收。',
  cache: 'never 或 reuse，控制恢复时可否复用；实际是否复用还取决于 Host 的依赖、文件及副作用检查。',
}

const topics = {
  workflow: {
    fields: {
      title: '工作流显示名称。', description: '工作流用途与前提说明。', nodes: '当前图层节点数组。', edges: '当前图层有向连线数组。',
      subAgents: '工作流内子 Agent 定义；详查 subAgents。', environmentVariables: '普通变量或 Secret 声明；详查 environment。',
      id: '稳定工作流 ID，Host 分配/保留。', workspaceId: '真实工作区 ID，Host 冻结。', revision: '保存版本，用于乐观并发校验，不能当格式版本。',
      scope: 'workspace/global 可见范围；不是权限授予。', notes: '画布便签，不参与运行。', editor: 'viewport、scopePath、annotations 画布编辑状态。',
      createdAt: 'Host 保存的创建 ISO 时间。', updatedAt: 'Host 保存的更新 ISO 时间。', archived: '本地归档状态。',
      executionPolicy: '运行并发与有限修复策略；详查 execution。',
    },
    nodeFields: { id: '稳定节点 ID，规划只用原有或预分配 ID。', kind: '20 种精确英文枚举之一。', title: '显示标题。', config: '本 kind 独有配置。', number: 'Host 展示编号，不用于引用。', x: 'Host 布局横坐标。', y: 'Host 布局纵坐标。', fixed: 'Host 固定编辑保护，不得移除。' },
    planningFields: ['title', 'description', 'nodes', 'edges', 'subAgents?', 'environmentVariables?'],
    format: { format: 'dsh-visible-workflow', formatVersion: 2, runtime: { engine: 'graphon', protocol: 1 }, workflow: '完整 Workflow', workflows: '随包独立子流程数组', presets: '角色预设数组', dependencies: '外部依赖声明数组' },
    rules: ['模型规划投影不是导入包；节点只写 id/kind/title/config，连线不写 id，容器同样规则。Host 补齐布局、版本与身份。', '不支持旧 JSON 字段、旧格式迁移或任意扩展字段。未知必填资源须询问或标待配置，不能假称可运行。'],
  },
  references: {
    rules: [CANONICAL_INPUT_GUIDANCE, '其他上游值用 {{稳定节点ID.字段}}；禁止 # 包裹、a-1 展示编号、中文节点名。', TEMPLATE_RENDER_BOUNDARY_GUIDANCE, '配置 inputs 的整值引用保留 JSON 类型；普通字符串插值产生文本。条件 variable、iterator、listSource、outputVariable、aggregator.variables 使用裸路径。', '普通 prompt/输出 text 中的映射键用 {{input.键}}；映射会覆盖同名工作流输入，避免同名覆盖。', CANONICAL_TEMPLATE_GUIDANCE, '只能读取依赖链上游实际输出；连线不会自动把所有数据复制到 inputs。分支未执行的节点没有结果，先路由或用互斥聚合。', '节点没有统一 result/output/data 包装；按节点词典中的 outputs 和已声明业务字段引用。代码按 main 返回键；工具按真实返回契约。', 'Secret 不能通过 env 插值到模型、代码或工具输入；角色正文不是插值模板。'],
    examples: { input: '{{input.name}}', templateDirect: { text: '你好，{{input.name}}' }, templateOutput: '{{greeting.text}}', typedArray: { items: '{{fetch.json.items}}' }, condition: { variable: 'fetch.status_code', operator: 'equals', value: '200' } },
  },
  edges: {
    fields: { source: '当前层起点稳定 ID。', target: '当前层终点稳定 ID，不能为 input。', port: '起点实际出口，普通节点省略表示 default。', id: '完整保存的连线身份，由 Host 补齐；规划省略。' },
    ports: { ordinary: ['default'], if: ['true', 'false'], ifCases: ['cases[].id', 'false'], classifier: ['classes[].id'], human: ['actions[].id', 'default', 'timeout'] },
    rules: ['每层恰好一个 input；节点须从入口可达。', '必须是有向无环图；使用 loop 表达循环，禁止跨容器连线。', '数据引用必须与依赖边一致；声明引用本身不会建立执行先后。'],
  },
  subAgents: {
    fields: { id: '工作流内身份 ID，规划使用预分配池。', name: '工作流内唯一显示名称。', prompt: '共享角色正文，字面文字不展开变量。', number: 'Host 分配 agent-N 展示编号。', sessionId: 'Host 本地主对话绑定，不是可迁移配置。', rolePresetId: 'Host 记录的预设来源；角色执行使用保存的正文快照。', rolePresetRevision: 'Host 记录的预设快照版本。' },
    example: { subAgents: [{ id: 'report-agent', name: '报告整理员', prompt: '根据已取得的资料整理报告，不编造事实。' }], nodeConfig: { subagentId: 'report-agent', prompt: '整理：{{input.text}}', tools: [] } },
    rules: ['规划只输出 id/name/prompt，节点 agent 用 config.subagentId 绑定。', '共享身份不代表复用上次原生任务记忆；每次执行创建独立任务。', 'sessionId/rolePresetId/rolePresetRevision 不随可移植导出保留。'],
  },
  environment: {
    fields: { id: '稳定变量身份，env 引用用此 ID；规划来自预分配池。', name: '显示和业务名称，不能代替 id 引用。', type: 'string/number/secret。', description: '用途说明。', required: '运行前是否必须配置。', value: '仅 string/number 可有，类型须匹配；secret 绝不能出现 value。', revision: 'Host 保存版本，规划省略。' },
    example: { environmentVariables: [{ id: 'report-language', name: 'REPORT_LANGUAGE', type: 'string', value: '中文' }], reference: '{{env.report-language}}' },
    rules: ['系统变量用 sys.workflow_id / sys.workflow_run_id / sys.workspace_id / sys.session_id / sys.timestamp，由 Host 提供，不能在 Workflow 写 systemVariables。', 'Secret 仅声明，由真人本机配置和授权；不能传 value、句柄、状态、密文或授权。', '普通值导出默认去除，可由用户显式选择包含；Secret 永远只导出声明。'],
  },
  execution: {
    fields: { 'executionPolicy.maxConcurrentAgents': '运行并发上限 1–8。', 'executionPolicy.repairMode': 'confirm/auto；auto 还须宿主可信授权。', 'executionPolicy.maxRepairAttempts': '每节点允许的有限模型修复次数，0–2。' },
    rules: ['以上字段由 Host 设置维护，不放进模型生成投影。', '规划用量仅记录，不以累计 Token 或估算量截断；规划仍有防循环次数、总超时和用户取消。', '生成、预览、保存图不会执行网页抓取或文件写入；发布成功以真实 receipt 为准。', '执行始终保留权限、并发、循环、取消信号和节点超时边界。'],
  },
  containers: {
    rules: ['CREATE 的 loop/iteration 内部节点与容器同列独立声明，用 {key,container,nodes} chain 排序；不填写 scope 或嵌套运行图。没有 bodyGraph/children/loop-start/loop-end 替代结构。', '各层运行图有唯一 input；CREATE 缺入口时由 Host 自动补齐，内部业务节点使用独立 key。', '内部 input.字段 仍指工作流输入，并继承容器开始前的上游数据；iteration 另提供 item/index，loop 提供 index/vars。内部 input 不是 item 的自动副本。', '内部输出由 outputVariable 选择并成为容器的 result；父图只能引用容器输出，不能引用内部节点。', '所有层普通边仍无环；最大嵌套 5 层，整图含内部节点最多 500。'],
    example: containerExample('iteration'),
  },
} as const

/** Field-read supplement from the same semantic source, without schemas or examples. */
export function workflowTextFieldContract(kind:'template'|'output') {
  const semantic=NODE_SEMANTICS[kind]
  return structuredClone({kind,editField:'text',fields:{text:semantic.fields.text,inputs:semantic.fields.inputs},outputs:semantic.outputs,
    ...(semantic.syntax?{syntax:{statements:semantic.syntax.statements,filters:semantic.syntax.filters,rules:semantic.syntax.rules}}:{}),
    references:{rules:topics.references.rules},rules:semantic.rules})
}

/** Read-only, bounded discovery. Default response is an index, never every schema. */
export function queryWorkflowSemantics(query: unknown = {}) {
  const parsed = workflowSemanticsQuerySchema.parse(query)
  const selected = [...new Set(parsed.kinds ?? [])]
  const schemas = parsed.includeSchema ? new Map(nodeCapabilityCatalog(selected,{authoring:true}).map(item => [item.kind, item.schema])) : undefined
  return {
    contract: { format: 'dsh-visible-workflow', formatVersion: 2, engine: 'graphon', protocol: 1 },
    usage: '先通过索引选择节点，再查询 kinds（每次最多 5 个）/topics；必要时 includeSchema:true。例子只是配置片段，未执行，不是可直接保存的完整 Workflow；节点/Agent/工具 ID 是示意，须替换为冻结上下文中的合法 ID。',
    coreRules: ['唯一当前 JSON 标准；规划提交精简投影，Host 补齐保存元数据。', '模板引用是 {{稳定ID.字段}}，输入是 {{input.字段}}，不带 #。', '生成图不执行任务；不确定字段、工具参数或输出路径先查询，不猜测、不绕开规划校验直接保存。'],
    ...(!selected.length ? { nodeIndex: kinds.map(kind => ({ kind, label: NODE_LABELS[kind], purpose: NODE_SEMANTICS[kind].purpose })) } : {}),
    topicIndex: WORKFLOW_SEMANTIC_TOPICS,
    ...(selected.length ? { nodes: selected.map(kind => ({ kind, label: NODE_LABELS[kind], ...structuredClone(NODE_SEMANTICS[kind]), fields: { ...Object.fromEntries(Object.entries(NODE_SEMANTICS[kind].fields).filter(([key])=>key!=='body')), ...commonFields }, ...(kind==='human'?{reviewBeforeEffect:{guidance:REVIEW_BEFORE_EFFECT_GUIDANCE,module:'审核后写文件优先使用 reviewed-file-write@1.0.0；通过 visible_workflow_modules 读取参数，Host 展开固定配方。',createExample:structuredClone(REVIEW_CREATE_EXAMPLE)}}:{}), ...(schemas ? { schema: schemas.get(kind)! } : {}) })) } : {}),
    topics: Object.fromEntries([...new Set(parsed.topics ?? [])].map(topic => [topic, structuredClone(topics[topic])])),
    sources: ['src/shared/workflow-validation.ts', 'src/shared/planning-projection.ts', 'src/shared/reference-scope.ts', 'src/host/runtime.ts', 'src/host/execution-adapters.ts', 'src/host/tool-catalog.ts', 'src/host/template.ts', 'doc/workflow-manual/原理/10-JSON字段与导入导出.md'],
  }
}
