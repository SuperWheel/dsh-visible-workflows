import { CachedBodyError } from '../shared/http-cache.ts'
import type { JsonValue } from '../shared/types.ts'
import { ReferenceScopeError } from '../shared/reference-scope.ts'

/** Bounded Jinja-compatible data expressions. No JavaScript evaluation, calls, imports, or property prototypes. */
export function renderDataTemplate(source:string,lookup:(name:string)=>JsonValue):string {
  const tokens=source.split(/(\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\})/g).filter(Boolean)
  let operations=0
  type Locals=Record<string,JsonValue>
  const stringify=(v:JsonValue|undefined):string=>v===undefined?'':typeof v==='string'?v:JSON.stringify(v)
  const split=(text:string,separator:string):string[]=>{
    const out:string[]=[];let depth=0,quote='',start=0
    for(let i=0;i<text.length;i++){const c=text[i]!;if(quote){if(c==='\\'){i++;continue}if(c===quote)quote='';continue}if(c==='"'||c==="'"){quote=c;continue}if(c==='('||c==='['||c==='{')depth++;if(c===')'||c===']'||c==='}')depth--;if(depth===0&&text.slice(i,i+separator.length)===separator){out.push(text.slice(start,i).trim());start=i+separator.length;i+=separator.length-1}}
    out.push(text.slice(start).trim());return out
  }
  const read=(expr:string,locals:Locals):JsonValue|undefined=>{
    const text=expr.trim(),filters=split(text,'|')
    if(filters.length>1){let value=read(filters[0]!,locals);for(const f of filters.slice(1)){const match=f.match(/^([a-z_]+)(?:\((.*)\))?$/);if(!match)throw new Error(`模板过滤器语法无效：${f}`);const args=match[2]?split(match[2],',').map(a=>read(a,locals)):[]
      switch(match[1]){
        case 'default':if(value===undefined||(args[1]===true&&!value))value=args[0]??'';break
        case 'upper':value=stringify(value).toUpperCase();break
        case 'lower':value=stringify(value).toLowerCase();break
        case 'trim':value=stringify(value).trim();break
        case 'length':value=value&&typeof value==='object'?Object.keys(value).length:stringify(value).length;break
        case 'join':if(!Array.isArray(value))throw new Error('join 过滤器要求数组');value=value.map(stringify).join(stringify(args[0]??''));break
        case 'first':value=Array.isArray(value)?value[0]:stringify(value).at(0);break
        case 'last':value=Array.isArray(value)?value.at(-1):stringify(value).at(-1);break
        case 'tojson':value=JSON.stringify(value??null);break
        case 'replace':value=stringify(value).split(stringify(args[0]??'')).join(stringify(args[1]??''));break
        case 'sort':if(!Array.isArray(value))throw new Error('sort 过滤器要求数组');value=[...value].sort((a,b)=>a===b?0:a!<b!?-1:1);break
        default:throw new Error(`当前模板不支持过滤器 ${match[1]}`)
      }
    }return value}
    if(text==='true'||text==='True')return true;if(text==='false'||text==='False')return false;if(['none','None','null'].includes(text))return null
    if(/^-?\d+(?:\.\d+)?$/.test(text))return Number(text)
    if((text.startsWith('"')&&text.endsWith('"'))||(text.startsWith("'")&&text.endsWith("'"))){if(text[0]==='"')return JSON.parse(text) as string;return text.slice(1,-1).replace(/\\'/g,"'").replace(/\\n/g,'\n').replace(/\\\\/g,'\\')}
    if(text.startsWith('[')||text.startsWith('{')){try{return JSON.parse(text) as JsonValue}catch{throw new Error('模板常量必须为有效 JSON')}}
    const path=text.replace(/\[['"]([A-Za-z0-9_-]+)['"]\]/g,'.$1').replace(/\[(\d+)\]/g,'.$1')
    if(!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(path))throw new Error(`模板表达式不支持：${text}`)
    const [root,...parts]=path.split('.')
    if(Object.prototype.hasOwnProperty.call(locals,root!)){let value:JsonValue|undefined=locals[root!];for(const part of parts){if(['__proto__','prototype','constructor'].includes(part)||value===null||typeof value!=='object'||!Object.prototype.hasOwnProperty.call(value,part))return undefined;value=(value as Record<string,JsonValue>)[part]}return value}
    try{return lookup(path)}catch(error){if(error instanceof ReferenceScopeError||error instanceof CachedBodyError)throw error;return undefined}
  }
  const truth=(expr:string,locals:Locals):boolean=>{
    const ors=split(expr,' or ');if(ors.length>1)return ors.some(v=>truth(v,locals))
    const ands=split(expr,' and ');if(ands.length>1)return ands.every(v=>truth(v,locals))
    if(expr.startsWith('not '))return !truth(expr.slice(4),locals)
    if(expr.endsWith(' is defined'))return read(expr.slice(0,-11),locals)!==undefined
    for(const op of [' == ',' != ',' >= ',' <= ',' > ',' < ',' in ']){const pair=split(expr,op);if(pair.length===2){const a=read(pair[0]!,locals),b=read(pair[1]!,locals);if(op===' == ')return JSON.stringify(a)===JSON.stringify(b);if(op===' != ')return JSON.stringify(a)!==JSON.stringify(b);if(op===' in ')return Array.isArray(b)?b.some(v=>JSON.stringify(v)===JSON.stringify(a)):typeof b==='string'&&b.includes(stringify(a));if(typeof a!=='number'||typeof b!=='number')throw new Error('模板比较要求数值');return op===' >= '?a>=b:op===' <= '?a<=b:op===' > '?a>b:a<b}}
    const value=read(expr,locals);return Array.isArray(value)?value.length>0:!!value
  }
  const tag=(token:string)=>token.startsWith('{%')?token.slice(2,-2).trim():''
  const block=(start:number,end:number,locals:Locals,depth:number):string=>{
    if(depth>20)throw new Error('模板嵌套超过 20 层');let result=''
    for(let i=start;i<end;i++){
      if(++operations>10000)throw new Error('模板超过 10000 个处理步骤')
      const token=tokens[i]!
      if(token.startsWith('{#'))continue
      if(token.startsWith('{{')){const value=read(token.slice(2,-2),locals);if(value===undefined)throw new Error(`模板变量 ${token.slice(2,-2).trim()} 不存在，请用 default 处理可选值`);result+=stringify(value)}
      else if(token.startsWith('{%')){
        const command=tag(token),isFor=command.startsWith('for '),isIf=command.startsWith('if ')
        if(!isFor&&!isIf)throw new Error(`当前模板不支持标签 ${command}`)
        let nesting=0,close=-1;const branches:{at:number;condition?:string}[]=[{at:i,condition:isIf?command.slice(3):undefined}]
        for(let j=i+1;j<end;j++){const t=tag(tokens[j]!);if(t.startsWith('for ')||t.startsWith('if '))nesting++;else if(t==='endfor'||t==='endif'){if(nesting===0){if(t!==(isFor?'endfor':'endif'))throw new Error('模板结束标签不匹配');close=j;break}nesting--}else if(nesting===0&&(t==='else'||t.startsWith('elif ')))branches.push({at:j,condition:t==='else'?undefined:t.slice(5)})}
        if(close<0)throw new Error(`模板 ${isFor?'for':'if'} 缺少结束标签`)
        if(isFor){const match=command.match(/^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+)$/);if(!match)throw new Error('for 模板格式为 for item in list');const value=read(match[2]!,locals),items=Array.isArray(value)?value:value&&typeof value==='object'?Object.keys(value):undefined;if(!items)throw new Error('模板 for 输入必须为数组或对象');if(items.length>1000)throw new Error('模板循环最多 1000 项');if(items.length===0&&branches.length>1)result+=block(branches[1]!.at+1,close,locals,depth+1);for(let n=0;n<items.length;n++)result+=block(i+1,branches[1]?.at??close,{...locals,[match[1]!]:items[n]!,loop:{index:n+1,index0:n,first:n===0,last:n===items.length-1}},depth+1)}
        else for(let n=0;n<branches.length;n++){const b=branches[n]!;if(b.condition===undefined||truth(b.condition,locals)){result+=block(b.at+1,branches[n+1]?.at??close,locals,depth+1);break}}
        i=close
      }else result+=token
      if(result.length>400000)throw new Error('模板输出超过 400000 字符')
    }
    return result
  }
  return block(0,tokens.length,{},0)
}
