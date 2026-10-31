import { setImmediate } from 'node:timers/promises'

/** Host-only static HTML scan. No DOM, scripts, selectors or QuickJS bindings.
 * Every input character is scanned a bounded number of times, including malformed
 * tags. Accumulators retain only the bounded public title/text, not raw markup. */
export async function extractStaticHtml(html:string,signal?:AbortSignal,maxChars=20000):Promise<{title:string;text:string;truncated:boolean}> {
  signal?.throwIfAborted()
  if(!Number.isInteger(maxChars)||maxChars<1||maxChars>200000)throw Error('maxChars 须为 1–200000 的整数')
  const entities:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',copy:'©',reg:'®',hellip:'…',ndash:'–',mdash:'—',lsquo:'‘',rsquo:'’',ldquo:'“',rdquo:'”',bull:'•',middot:'·',trade:'™',euro:'€',pound:'£',yen:'¥',cent:'¢'}
  const decode=(s:string)=>s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi,(all,key:string)=>{
    if(key[0]!=='#')return Object.hasOwn(entities,key)?entities[key]!:all
    const n=key[1]!.toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1))
    return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):'�'
  })
  type Part='title'|'main'|'article'|'body'
  const parts:Record<Part,string>={title:'',main:'',article:'',body:''}
  const overflow={title:false,main:false,article:false,body:false}
  const depth={head:0,title:0,main:0,article:0,body:0},seen={main:false,article:false}
  const append=(key:Part,value:string)=>{
    if(overflow[key])return
    const limit=key==='title'?500:maxChars,previous=parts[key]
    // One extra unit keeps trailing whitespace from consuming the final slot.
    let clean=decode(value).replace(/\s+/g,' ')
    if(!previous||previous.endsWith(' '))clean=clean.replace(/^ /,'')
    if((previous+clean).trimEnd().length>limit)overflow[key]=true
    parts[key]=(previous+clean).slice(0,limit+1)
  }
  const block=/^(address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|td|th|tr|ul)$/
  let skip='',skipDepth=0,index=0,nextYield=16384,textEnd=-1
  while(index<html.length){
    if(index>=nextYield){signal?.throwIfAborted();await setImmediate();signal?.throwIfAborted();nextYield=index+16384}
    if(html[index]!=='<'){
      if(textEnd<index){const end=html.indexOf('<',index);textEnd=end<0?html.length:end}
      const next=textEnd
      let stop=Math.min(next,index+16384)
      if(stop<next){const entity=html.lastIndexOf('&',stop);if(entity>index&&stop-entity<32)stop=entity}
      if(!skip){
        const token=html.slice(index,stop)
        if(depth.title)append('title',token)
        if(!depth.head&&!depth.title)for(const key of ['main','article','body'] as const)if(depth[key])append(key,token)
      }
      index=stop;continue
    }
    textEnd=-1
    if(html.startsWith('<!--',index)){const end=html.indexOf('-->',index+4),stop=end<0?html.length:end+3;while(index+16384<stop){index+=16384;signal?.throwIfAborted();await setImmediate();signal?.throwIfAborted()}index=stop;continue}
    const start=index++
    if(!/[a-z/!]/i.test(html[index]??'')){
      if(!skip){if(depth.title)append('title','<');if(!depth.head&&!depth.title)for(const key of ['main','article','body'] as const)if(depth[key])append(key,'<')}
      continue
    }
    let quote=''
    for(;index<html.length;index++){
      if(index>=nextYield){signal?.throwIfAborted();await setImmediate();signal?.throwIfAborted();nextYield=index+16384}
      const c=html[index]!
      if(quote){if(c===quote)quote=''}else if(c==='"'||c==="'")quote=c;else if(c==='>'){index++;break}
    }
    const token=html.slice(start,index),tag=/^<(\/?)\s*([a-z][a-z0-9:-]*)\b/i.exec(token)
    if(!tag)continue
    const closing=!!tag[1],name=tag[2]!.toLowerCase(),selfClosing=/\/>$/.test(token)
    if(skip){
      if(name===skip){if(closing){if(--skipDepth===0)skip=''}else if((skip==='template'||skip==='svg')&&!selfClosing)skipDepth++}
      continue
    }
    if(['script','style','noscript','template','svg'].includes(name)&&!closing){if(!selfClosing){skip=name;skipDepth=1}continue}
    if(Object.hasOwn(depth,name)){
      const key=name as keyof typeof depth
      if(closing)depth[key]=Math.max(0,depth[key]-1);else{depth[key]++;if(name==='main'||name==='article')seen[name]=true}
    }
    if(block.test(name)&&!depth.head)for(const key of ['main','article','body'] as const)if(depth[key])append(key,' ')
  }
  signal?.throwIfAborted()
  const key=seen.main?'main':seen.article?'article':'body'
  return {title:parts.title.trimEnd().slice(0,500),text:parts[key].trimEnd().slice(0,maxChars),truncated:overflow.title||overflow[key]}
}
