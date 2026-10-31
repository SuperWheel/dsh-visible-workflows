import { setImmediate } from 'node:timers/promises'
import { Parser, DomHandler } from 'htmlparser2'
import { compile } from 'css-select'
import { HTTP_DOWNLOAD_LIMIT, isCachedBody, type CachedBody } from '../shared/http-cache.ts'
import type { JsonValue } from '../shared/types.ts'
import { extractStaticHtml } from './static-html-text.ts'

type Data=Record<string,JsonValue>
type DomNode=DomHandler['dom'][number]
type Element=Extract<DomNode,{attribs:unknown}>
const isTag=(node:DomNode):node is Element=>'attribs' in node
export const isHtmlTool=(id:string)=>id==='builtin:html.extract_text'||id==='builtin:html.select'
const object=(value:unknown):value is Data=>!!value&&typeof value==='object'&&!Array.isArray(value)
const integer=(value:JsonValue|undefined,fallback:number,max:number,name:string)=>{const n=value??fallback;if(typeof n!=='number'||!Number.isInteger(n)||n<1||n>max)throw Error(`${name} 须为 1–${max} 的整数`);return n}
const pause=async(signal?:AbortSignal)=>{signal?.throwIfAborted();await setImmediate();signal?.throwIfAborted()}
// Iterative traversal avoids recursion on malformed/deep markup. Both traversal
// and text collection yield independently of the parser's input chunks.
async function* walk(root:DomNode,signal?:AbortSignal):AsyncGenerator<DomNode>{
  let node:DomNode|null='children' in root?root.children[0]??null:null,count=0
  while(node){if(++count%1024===0)await pause(signal);yield node
    if('children' in node&&node.children.length){node=node.children[0]!;continue}
    while(node&&node!==root&&!node.next)node=node.parent
    if(!node||node===root)break
    node=node.next
  }
  signal?.throwIfAborted()
}
async function textContent(root:DomNode,signal?:AbortSignal):Promise<string>{
  const parts:string[]=[]
  for await(const node of walk(root,signal))if(node.type==='text')for(let i=0;i<node.data.length;i+=16384){parts.push(node.data.slice(i,i+16384));if(i+16384<node.data.length)await pause(signal)}
  return parts.join('').replace(/\s+/g,' ').trim()
}
export async function executeHtml(id:string,args:Data,signal?:AbortSignal,read?:(ref:CachedBody)=>Buffer):Promise<Data>{
  signal?.throwIfAborted()
  const cached=isCachedBody(args.html)
  let html=args.html
  if(isCachedBody(html)){if(!read)throw Error('HTTP 缓存正文读取不可用，请重跑抓取节点');html=read(html).toString('utf8')}
  if(typeof html!=='string')throw Error('html 必须为 HTML 字符串')
  if(!cached&&Buffer.byteLength(html)>HTTP_DOWNLOAD_LIMIT)throw Error('HTML 超过 10 MB 上限')
  let result:Data
  if(id==='builtin:html.extract_text'){
    const maxChars=integer(args.maxChars,20000,200000,'maxChars'),code=args.statusCode
    if(code!==undefined&&(typeof code!=='number'||!Number.isInteger(code)||code<100||code>599))throw Error('statusCode 须为 100–599 的整数')
    const contentType=args.contentType??(object(args.headers)?Object.entries(args.headers).find(([name])=>name.toLowerCase()==='content-type')?.[1]:undefined)
    const status=code!==undefined&&(Number(code)<200||Number(code)>=300)?'http_error':contentType!==undefined&&!/^(text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(String(contentType))?'not_html':undefined
    const extracted=status?{title:'',text:'',truncated:false}:await extractStaticHtml(html,signal,maxChars)
    result={status:status??(extracted.text?'ok':'empty'),...extracted,...(code!==undefined?{httpStatus:code}:{}),...(args.url!==undefined?{url:args.url}:{})}
  }else{
    const limit=integer(args.limit,100,500,'limit')
    if(typeof args.items!=='string'||!args.items.trim())throw Error('items 须为非空 CSS 选择器')
    if(!object(args.fields)||Object.keys(args.fields).length<1||Object.keys(args.fields).length>20)throw Error('fields 须包含 1–20 个字段')
    const fields=Object.entries(args.fields).map(([name,spec])=>{
      if(['__proto__','prototype','constructor','_unresolvedLinks'].includes(name)||!name)throw Error('fields 字段名无效或使用保留名称 _unresolvedLinks')
      if(!object(spec)||Object.keys(spec).some(k=>!['selector','attr','text'].includes(k))||spec.selector!==undefined&&(typeof spec.selector!=='string'||!spec.selector.trim())||!((typeof spec.attr==='string'&&!!spec.attr&&spec.text===undefined)||(spec.text===true&&spec.attr===undefined)))throw Error('fields 每项须为 {selector?, attr} 或 {selector?, text:true}')
      return {name,selector:spec.selector as string|undefined,attr:spec.attr as string|undefined}
    })
    const handler=new DomHandler(),parser=new Parser(handler,{decodeEntities:true})
    for(let i=0;i<html.length;i+=16384){parser.write(html.slice(i,i+16384));await pause(signal)}parser.end()
    const root=handler.root,match=compile<DomNode,Element>(args.items,{cacheResults:false}),items:Data[]=[]
    // Validate all selectors even for an empty result set.
    for(const field of fields)if(field.selector)compile(field.selector,{cacheResults:false})
    for await(const node of walk(root,signal)){
      if(!isTag(node)||!match(node))continue
      const record:Data={},unresolved:string[]=[]
      for(const field of fields){
        let target:Element|undefined=node
        if(field.selector){target=undefined;const predicate=compile<DomNode,Element>(field.selector,{context:[node],cacheResults:false})
          for await(const child of walk(node,signal))if(isTag(child)&&predicate(child)){target=child;break}
        }
        let value=target?(field.attr?target.attribs[field.attr]??'':await textContent(target,signal)):''
        if(value&&field.attr&&['href','src'].includes(field.attr.toLowerCase()))try{value=new URL(value,typeof args.baseUrl==='string'?args.baseUrl:undefined).href}catch{unresolved.push(field.name)}
        record[field.name]=value
      }
      if(unresolved.length)record._unresolvedLinks=unresolved
      items.push(record)
      // Fail before accumulating hundreds of enormous records; never truncate.
      if(JSON.stringify(items).length>1_000_000)throw Error('节点输出超过 1 MB 限制')
      if(items.length===limit)break
      await pause(signal)
    }
    result={items,count:items.length,text:JSON.stringify(items)}
  }
  signal?.throwIfAborted()
  if(JSON.stringify(result).length>1_000_000)throw Error('节点输出超过 1 MB 限制')
  return result
}
