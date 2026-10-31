/** Complete only a short missing closing suffix. JSON.parse remains the grammar
 * check: no commas, quotes, values or mismatched brackets are ever repaired. */
export function completeToolArgumentJson(raw:string):string {
  try{JSON.parse(raw);return raw}catch(original){
    const stack:string[]=[];let quoted=false,escaped=false
    for(const char of raw){
      if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue}
      if(char==='"')quoted=true
      else if(char==='{'||char==='[')stack.push(char==='{'?'}':']')
      else if(char==='}'||char===']'){if(stack.pop()!==char)throw original}
    }
    if(quoted||!stack.length||stack.length>3)throw original
    const completed=raw+stack.reverse().join('')
    try{JSON.parse(completed);return completed}catch{throw original}
  }
}
export function parseToolArguments(raw:string):unknown {return JSON.parse(completeToolArgumentJson(raw))}
