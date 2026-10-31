type Token={text:string;value?:string;kind:'word'|'string'|'symbol'|'opaque';at:number}
const identifier=/^[A-Za-z_$][\w$]*$/
/** A deliberately small lexer, not a language validator. Opaque/ambiguous uses
 * abandon the node instead of guessing at bindings, aliases or mutations. */
function tokens(source:string,python:boolean):Token[]|undefined{
  const out:Token[]=[]
  for(let i=0;i<source.length;){
    const at=i,c=source[i]!,next=source[i+1]
    if(/\s/.test(c)){i++;continue}
    if(python&&c==='#'||!python&&c==='/'&&next==='/'){while(i<source.length&&source[i]!=='\n')i++;continue}
    if(!python&&c==='/'&&next==='*'){const end=source.indexOf('*/',i+2);i=end<0?source.length:end+2;continue}
    if(c==='"'||c==="'"||!python&&c==='`'){
      const triple=python&&source.slice(i,i+3)===c.repeat(3),quote=triple?c.repeat(3):c
      i+=quote.length;const start=i;let escaped=false,closed=false
      while(i<source.length){
        if(source[i]==='\\'){escaped=true;i+=2;continue}
        if(source.slice(i,i+quote.length)===quote){closed=true;break}
        i++
      }
      const content=source.slice(start,i)
      if(c==='`'&&content.includes('${')||python&&out.at(-1)?.kind==='word'&&/f/i.test(out.at(-1)!.text))return
      out.push({text:quote+content+quote,value:content,kind:!escaped&&closed&&!triple&&c!=='`'?'string':'opaque',at});i+=closed?quote.length:0;continue
    }
    if(!python&&c==='/'){
      // Only expression-prefix positions unambiguously start a regexp. A
      // truncated regexp consumes the tail, retaining earlier literal reads.
      if(!['(','[','=',':',',','return','=>','!','&&','||','?',';','{'].includes(out.at(-1)?.text??''))return
      i++;let bracket=false
      while(i<source.length){
        if(source[i]==='\\'){i+=2;continue}
        if(source[i]==='[')bracket=true
        if(source[i]===']')bracket=false
        if(source[i++]==='/'&&!bracket)break
      }
      while(/[a-z]/i.test(source[i]??'')&&i<source.length)i++
      out.push({text:'',kind:'opaque',at});continue
    }
    const word=/^[A-Za-z_$][\w$]*/.exec(source.slice(i))?.[0]
    if(word){out.push({text:word,kind:'word',at});i+=word.length;continue}
    if(c==='\\'||c.charCodeAt(0)>127)return
    const symbol=/^(?:>>>=|<<=|>>=|\?\?=|&&=|\|\|=|===|!==|\*\*=|>>>|\.\.\.|=>|==|!=|<=|>=|\+\+|--|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|&&|\|\||\?\?|\?\.|:=|\*\*)/.exec(source.slice(i))?.[0]??c
    out.push({text:symbol,kind:'symbol',at});i+=symbol.length
  }
  return out
}
const intrinsic=new Set(['__proto__','constructor','prototype','toString','toLocaleString','valueOf','hasOwnProperty','isPrototypeOf','propertyIsEnumerable','__defineGetter__','__defineSetter__','__lookupGetter__','__lookupSetter__'])
/** Literal first-parameter reads only. Any other use of that identifier (whole
 * object, dynamic key, assignment, shadow binding, spread) skips the node. */
export function codeInputReads(code:unknown,language:unknown='javascript'):{parameter:string;names:string[]}|undefined{
  if(typeof code!=='string'||!['javascript','python'].includes(String(language)))return
  const python=language==='python',all=tokens(code,python)
  if(!all)return
  const signatures:{parameter:string;body:number;header:number}[]=[]
  for(let i=0;i<all.length;i++){
    const text=(n:number)=>all[n]?.text,word=(n:number)=>all[n]?.kind==='word'&&identifier.test(text(n)??'')
    let open:number|undefined
    if(python&&text(i)==='def'&&text(i+1)==='main'&&text(i+2)==='(')open=i+2
    if(!python&&text(i)==='function'&&text(i+1)==='main'&&text(i+2)==='(')open=i+2
    if(!python&&text(i)==='main'&&text(i-1)!=='.'&&text(i-1)!=='?.'&&text(i+1)==='='){
      if(text(i+2)==='function'&&text(i+3)==='(')open=i+3
      else if(text(i+2)==='('&&text(i+5)==='=>')open=i+2
      else if(word(i+2)&&text(i+3)==='=>')signatures.push({parameter:text(i+2)!,body:i+4,header:i})
    }
    // Defaults, annotations, multiple parameters and destructured parameters
    // are deliberately outside this check's proof boundary.
    if(open!==undefined&&word(open+1)&&text(open+2)===')'&&(python?text(open+3)===':':text(open+3)==='{'||text(open+3)==='=>'))signatures.push({parameter:text(open+1)!,body:open+4,header:i})
  }
  if(signatures.length!==1)return
  const {parameter,body,header}=signatures[0]!
  let end=all.length,start=body
  if(!python){
    if(all[start]?.text==='{'||all[start-1]?.text==='{'){
      if(all[start]?.text==='{')start++
      let depth=1
      for(let i=start;i<all.length;i++){if(all[i]!.text==='{')depth++;if(all[i]!.text==='}'&&!--depth){end=i;break}}
    }else{
      let depth=0
      for(let i=start;i<all.length;i++){
        const token=all[i]!.text
        if(depth===0&&[';',','].includes(token)){end=i;break}
        if(['(','[','{'].includes(token))depth++
        if([')',']','}'].includes(token)&&--depth<0)return
      }
    }
  }else{
    const lineStart=code.lastIndexOf('\n',all[header]!.at)+1,indent=all[header]!.at-lineStart
    for(let i=start;i<all.length;i++){
      const at=all[i]!.at,line=code.lastIndexOf('\n',at)+1
      if(line>lineStart&&at-line<=indent){end=i;break}
    }
  }
  const t=all.slice(start,end),names=new Set<string>()
  if(t.some((token,i)=>token.kind==='word'&&t[i-1]?.text!=='.'&&['eval','exec','with','delete','del'].includes(token.text)))return
  for(let i=0;i<t.length;i++)if(/^(?:=|\+=|-=|\*=|\*\*=|\/=|%=|&&=|\|\|=|\?\?=|&=|\|=|\^=|<<=|>>=|>>>=)$/.test(t[i]!.text)&&['}',']',')'].includes(t[i-1]?.text??'')){
    const close=t[i-1]!.text,open=close==='}'?'{':close===']'?'[':'(';let depth=1,j=i-2
    for(;j>=0;j--){if(t[j]!.text===close)depth++;if(t[j]!.text===open&&!--depth)break}
    if(t.slice(j+1,i-1).some(token=>token.kind==='word'&&token.text===parameter))return
  }
  if(python)for(let i=0;i<t.length;i++)if(t[i]!.text==='='){
    const line=code.lastIndexOf('\n',t[i]!.at)+1
    if(t.slice(0,i).some(token=>token.at>=line&&token.kind==='word'&&token.text===parameter))return
  }
  for(let i=0;i<t.length;i++){
    if(t[i]!.kind!=='word'||t[i]!.text!==parameter)continue
    const prev=t[i-1]?.text,next=t[i+1]?.text
    if(prev==='.'||prev==='?.'||prev==='delete'||prev==='del'||prev==='++'||prev==='--')return
    let name:string|undefined,after=i+1
    if(!python&&next==='.'&&t[i+2]?.kind==='word'){
      name=t[i+2]!.text;after=i+3
      if(intrinsic.has(name)||t[after]?.text==='(')return
    }else if(next==='['&&t[i+2]?.kind==='string'&&t[i+3]?.text===']'){
      name=t[i+2]!.value;after=i+4
    }else if(python&&next==='.'&&t[i+2]?.text==='get'&&t[i+3]?.text==='('&&t[i+4]?.kind==='string'&&[',',')'].includes(t[i+5]?.text??'')){
      name=t[i+4]!.value;after=i+5
    }else if(!python&&prev==='='&&t[i-2]?.text==='}'){
      let open=i-3;while(open>=0&&t[open]!.text!=='{')open--
      if(open<1||!['const','let','var'].includes(t[open-1]!.text))return
      const parts=t.slice(open+1,i-2);let at=0
      while(at<parts.length){
        const key=parts[at++]!;if(key.kind!=='word')return
        if(parts[at]?.text===':'){at++;if(parts[at++]?.kind!=='word')return}
        if(at<parts.length&&parts[at++]?.text!==',')return
        if(!intrinsic.has(key.text)&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key.text))names.add(key.text)
      }
      if(![';',undefined].includes(t[i+1]?.text)&&!code.slice(t[i]!.at+parameter.length,t[i+1]!.at).includes('\n'))return
      continue
    }else return
    // Property writes/deletes cannot prove a missing input; mutating the
    // parameter's object also invalidates later apparent reads.
    if(/^(?:.*=|\+\+|--|:|in|of)$/.test(t[after]?.text??'')&&!['==','===','!=','!==','<=','>='].includes(t[after]?.text??''))return
    if(name!==undefined&&!intrinsic.has(name)&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name))names.add(name)
  }
  return {parameter,names:[...names]}
}
