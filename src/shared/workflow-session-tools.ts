export const WORKFLOW_SESSION_TOOL_NODES = {
  workflow_http_request: {kind:'http'},
  workflow_html_extract_text: {kind:'tool',toolId:'builtin:html.extract_text'},
  workflow_html_select: {kind:'tool',toolId:'builtin:html.select'},
  workflow_file_stat: {kind:'tool',toolId:'builtin:file.stat'},
} as const
export type WorkflowSessionToolName = keyof typeof WORKFLOW_SESSION_TOOL_NODES
export const WORKFLOW_SESSION_TOOL_NAMES:readonly WorkflowSessionToolName[] = Object.keys(WORKFLOW_SESSION_TOOL_NODES) as WorkflowSessionToolName[]
export const isWorkflowSessionTool = (name:string):name is WorkflowSessionToolName => Object.hasOwn(WORKFLOW_SESSION_TOOL_NODES,name)
const WORKFLOW_SESSION_TOOL_SOURCE = '网页类步骤优先使用 workflow_http_request／workflow_html_select／workflow_html_extract_text：它们与工作流 HTTP 请求和 HTML 处理节点同源；'
// The trial records the path; the main agent only declares the tools and leaves the probing to the trial.
// read hands back decoded text without BOM or CR, so sizes counted from it are wrong (Desktop r48).
const FILE_STAT_GUIDANCE = '要文件的字节数或行数用 workflow_file_stat（与内置工具 builtin:file.stat 同源），不要从 read 读到的文本推算：BOM 和 CR 已被去掉。'
// A listing the trial ran becomes the workflow's own listing; files named one by one stay fixed (Desktop r49).
const DIRECTORY_TRIAL_GUIDANCE = '任务要处理一个目录下全部或每个文件时，先用 glob 列出（目录写进 pattern，如 data/*.csv，不另传 path），再对列出的每个文件逐个处理；任务点名了具体文件就只处理这些。'
const DIRECTORY_PLAN_GUIDANCE = '需求是目录下全部或每个文件时，execution.task 写目录和匹配模式（如 data/*.csv）并说明逐个处理，不要换成当前看到的文件名；execution.tools 加 glob；execution.inputs 只写具体文件路径，不写匹配模式。'
export const WORKFLOW_SESSION_TOOL_GUIDANCE = WORKFLOW_SESSION_TOOL_SOURCE+'记录实际地址、选择器和字段，供生成工作流时照搭节点。'+FILE_STAT_GUIDANCE+DIRECTORY_TRIAL_GUIDANCE
export const WORKFLOW_SESSION_TOOL_PLAN_GUIDANCE = WORKFLOW_SESSION_TOOL_SOURCE+'用 visible_workflow_plan 自己声明 execution 新建网页任务时（visible_workflow_create 由 Host 选工具），execution.tools 写 workflow_http_request 和 workflow_html_select 或 workflow_html_extract_text，声明了产物文件时再加 write，回读核对再加 read；不必先自己试抓，试做会用它们跑通并记录地址、选择器和字段。网页抓取对应 http 节点类型，不在 visible_workflow_tools 工具目录里。'+FILE_STAT_GUIDANCE+'需要这些数字时 execution.tools 加 workflow_file_stat。'+DIRECTORY_PLAN_GUIDANCE
