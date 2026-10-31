import type { JsonValue, ToolChoice } from './types.ts'
type Data=Record<string,JsonValue>
const objectSchema = (properties: Data, required: string[] = []): Data => ({type:'object',properties,required})
const str = (description: string): Data => ({type:'string',description})
const builtin = (id:string,name:string,provider:string,description:string,inputSchema:Data):ToolChoice => ({id:`builtin:${id}`,name,description,providerId:`builtin:${provider}`,providerName:provider==='time'?'时间':provider==='html'?'HTML 处理':provider==='file'?'文件':'JSON 处理',category:'plugin',author:'工作流内置',available:true,inputSchema})
const tz = { timezone: str('IANA 时区，例如 Asia/Shanghai；默认 UTC') }
export const BUILTIN_TOOLS: ToolChoice[] = [
  builtin('time.now','当前时间','time','获取当前时间，可指定 IANA 时区。',objectSchema(tz)),
  builtin('time.timestamp','当前时间戳','time','返回 Unix 秒和毫秒时间戳。',objectSchema({})),
  builtin('time.from_timestamp','时间戳转换','time','将 Unix 时间戳转为日期时间。',objectSchema({timestamp:{type:'number'},unit:{type:'string',enum:['seconds','milliseconds']},...tz},['timestamp'])),
  builtin('time.convert_timezone','时区转换','time','将带时区的 ISO 日期时间转换到指定时区。',objectSchema({datetime:str('含 Z 或 UTC 偏移的 ISO 日期时间'),...tz},['datetime','timezone'])),
  builtin('time.weekday','星期几','time','返回日期所在星期；日期默认当前时刻。',objectSchema({datetime:str('含时区的 ISO 日期时间；不填为现在'),...tz})),
  builtin('json.parse','解析 JSON','json','将 JSON 文本解析为结构化值。',objectSchema({text:str('JSON 文本')},['text'])),
  builtin('json.stringify','生成 JSON 文本','json','将 JSON 值序列化为文本。',objectSchema({value:{},pretty:{type:'boolean'}},['value'])),
  builtin('json.select','读取 JSON 路径','json','通过点分隔键或数组下标读取 JSON 字段。',objectSchema({value:{},path:str('例如 items.0.title')},['value','path'])),
  builtin('json.merge','合并 JSON 对象','json','浅合并对象；右侧同名字段覆盖左侧。',objectSchema({left:{type:'object'},right:{type:'object'}},['left','right'])),
  builtin('file.stat','文件信息','file','统计当前工作区内一个文件的字节数、行数、行尾类型和 UTF-8 BOM；只读，不返回内容。',objectSchema({path:str('工作区相对路径，例如 data/a.csv')},['path'])),
  builtin('html.extract_text','提取网页正文','html','从 HTML 中提取页面标题和可读正文，不执行脚本，不访问网络。',objectSchema({html:str('HTML 正文，通常引用上游 HTTP 请求节点的 {{节点.text}}'),statusCode:{type:'number',description:'可选 HTTP 状态码，例如 200；非 2xx 返回 http_error。'},contentType:str('可选响应类型，例如 text/html；非 HTML 返回 not_html。'),maxChars:{type:'number',description:'正文字符上限，默认 20000，最大 200000；超出时 truncated 为 true。'},url:str('可选页面地址，原样输出为 url，例如 https://example.com/page。'),headers:{type:'object',description:'可选上游 HTTP 响应头，例如 {{节点.headers}}；未指定 contentType 时从中读取内容类型，缺失时仍尝试提取。'}},['html'])),
  builtin('html.select','提取网页列表/链接','html','按 CSS 选择器从 HTML 中提取多条记录的文本或属性；链接按页面地址补成绝对地址，不访问网络。',objectSchema({html:str('HTML 正文，通常引用上游 HTTP 请求节点的 {{节点.text}}'),items:str('记录的 CSS 选择器，例如 article.Box-row'),baseUrl:str('页面地址，用于补全 href/src，例如 https://github.com/trending；无法解析时保留原值并在记录的 _unresolvedLinks 中列出字段名。'),fields:{type:'object',description:'1–20 个字段，每项为 {selector?, attr} 或 {selector?, text:true}；省略 selector 使用当前记录。例如 {"name":{"selector":"h2 a","text":true},"link":{"selector":"h2 a","attr":"href"}}'},limit:{type:'number',description:'最多返回记录数，默认 100，最大 500。'}},['html','items','fields'])),
]
