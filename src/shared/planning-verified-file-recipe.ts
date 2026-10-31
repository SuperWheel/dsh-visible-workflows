import type { FragmentRecipe } from './planning-module-fragment-contract.ts'
import { EXACT_TARGET_EXISTS_CODE } from './tool-operation-contract.ts'

// Frozen tool-fs resolved defaults. offset/limit are also explicit on BOTH reads.
// maxLineLength/maxBytes belong to SDK registration, not read argument slots.
export const VERIFIED_READ_WINDOW={offset:1,limit:2000,maxLineLength:2000,maxBytes:50*1024} as const

// Keep this predicate identical to isReviewedFileWriteTarget (parity-tested).
export const VERIFIED_TARGET_CODE=String.raw`function main(inputs){
  const target=inputs.target;
  if(typeof target!=="string"||!target||target.startsWith("/")||target.startsWith(".dsh-drafts/")||/[{}\\\x00:()*?\[\]!]/.test(target)||!target.split("/").every(p=>p&&p!=="."&&p!==".."))throw new Error("写入目标无效：须为工作区根相对文件路径，禁止绝对路径、空段、.、..、反斜杠、冒号、NUL、花括号、通配符和 .dsh-drafts/。");
  return {target};
}`

// Plain JavaScript shared verbatim with the Host-owned QuickJS node. Buffer and
// TextEncoder are unavailable there; utf8Bytes matches Buffer.byteLength even
// for unpaired UTF-16 surrogates (replacement character).
export const READ_WINDOW_CODE=String.raw`function utf8Bytes(text) {
  let bytes=0;
  for(let i=0;i<text.length;i++){
    const c=text.charCodeAt(i);
    if(c<128)bytes++;
    else if(c<2048)bytes+=2;
    else if(c>=0xd800&&c<=0xdbff&&i+1<text.length&&text.charCodeAt(i+1)>=0xdc00&&text.charCodeAt(i+1)<=0xdfff){bytes+=4;i++;}
    else bytes+=3;
  }
  return bytes;
}
function expectedReadWindow(chunks,request,displayPath) {
  const acc={lines:[],totalLines:0,outputBytes:0,truncatedByBytes:false};
  const lineBufferCap=request.maxLineLength+1;
  let lineBuffer="";
  function appendToLineBuffer(segment){
    if(lineBuffer.length>=lineBufferCap)return;
    lineBuffer+=segment;
    if(lineBuffer.length>lineBufferCap)lineBuffer=lineBuffer.slice(0,lineBufferCap);
  }
  function flushLine(){
    const rawLine=lineBuffer.endsWith("\r")?lineBuffer.slice(0,-1):lineBuffer;
    lineBuffer="";
    acc.totalLines++;
    if(acc.truncatedByBytes||acc.totalLines<request.offset||acc.lines.length>=request.limit)return;
    const text=rawLine.length>request.maxLineLength?rawLine.substring(0,request.maxLineLength)+"... (line truncated to "+request.maxLineLength+" chars)":rawLine;
    const bytes=utf8Bytes(text)+(acc.lines.length>0?1:0);
    if(acc.outputBytes+bytes>request.maxBytes){acc.truncatedByBytes=true;return;}
    acc.outputBytes+=bytes;
    acc.lines.push({number:acc.totalLines,text});
  }
  for(const chunk of chunks){
    let startPos=0,newlinePos;
    while((newlinePos=chunk.indexOf("\n",startPos))!==-1){
      appendToLineBuffer(chunk.slice(startPos,newlinePos));flushLine();startPos=newlinePos+1;
    }
    appendToLineBuffer(chunk.slice(startPos));
  }
  if(lineBuffer.length>0)flushLine();
  if(!acc.truncatedByBytes&&request.offset>acc.totalLines&&!(acc.totalLines===0&&request.offset===1))throw new Error('offset '+request.offset+' is out of range for "'+displayPath+'" ('+acc.totalLines+' lines)');
  return {lines:acc.lines,totalLines:acc.totalLines,truncatedByBytes:acc.truncatedByBytes};
}`

export const VERIFIED_COMPARE_CODE=READ_WINDOW_CODE+String.raw`
function main(inputs){
  if(typeof inputs.content!=="string")throw new Error("写入正文必须为字符串");
  const content=inputs.content,request=inputs.window;
  const expected=expectedReadWindow([content],request,inputs.target);
  const rawLines=content.split("\n");
  if(rawLines[rawLines.length-1]==="")rawLines.pop();
  // At exactly maxLineLength the SDK can hide a longer suffix when its
  // capped buffer ends in CR. Treat that boundary conservatively as unchecked.
  const partial=request.offset!==1||rawLines.some(line=>(line.endsWith("\r")?line.slice(0,-1):line).length>=request.maxLineLength)||expected.totalLines>request.limit||utf8Bytes(content)>request.maxBytes||expected.truncatedByBytes;
  const actual=inputs.readback,write=inputs.write||{};
  const complete=actual&&Array.isArray(actual.lines)&&Number.isInteger(actual.totalLines)&&actual.totalLines>=0&&actual.offset===request.offset&&actual.lines.length===actual.totalLines;
  const matches=complete&&actual.totalLines===expected.totalLines&&actual.lines.length===expected.lines.length&&actual.lines.every((line,i)=>line&&line.number===expected.lines[i].number&&line.text===expected.lines[i].text);
  const observedPartial=actual&&Array.isArray(actual.lines)&&Number.isInteger(actual.totalLines)&&actual.lines.length<actual.totalLines;
  const check=partial||observedPartial?"unchecked":matches?"window-match":"mismatch";
  return {
    path:typeof write.path==="string"?write.path:inputs.target,
    operation:write.operation==="create"?"created":write.operation==="update"?"updated":inputs.existed?"updated":"created",
    check,
    checkNote:check==="unchecked"?"内容触及行长或超过单窗行数/字节上限，未完整核对。":check==="mismatch"?"回读窗口与预期不符。":"窗口一致；不证明精确相等，CR/换行格式及末尾换行差异不可见。"
  };
}`

export function verifiedFileWriteRecipe(parameters:Record<string,unknown>):FragmentRecipe {
  const target=parameters.target,content=parameters.content
  const read={toolId:'native:read',inputs:{file_path:target,offset:VERIFIED_READ_WINDOW.offset,limit:VERIFIED_READ_WINDOW.limit},cache:'never'}
  return {
    entry:'validate',exit:'compare',
    nodes:{
      validate:{kind:'code',title:'校验写入目标路径',config:{language:'javascript',code:VERIFIED_TARGET_CODE,inputs:{target},outputSchema:[{name:'target',type:'string',required:true}]}},
      probe:{kind:'tool',config:{toolId:'native:glob',inputs:{pattern:target},cache:'never'}},
      exists:{kind:'code',config:{language:'javascript',code:EXACT_TARGET_EXISTS_CODE,inputs:{listing:'{{probe.value}}',target},outputSchema:[{name:'exists',type:'boolean',required:true}]}},
      present:{kind:'if',config:{variable:'exists.exists',operator:'equals',value:'true'}},
      prior:{kind:'tool',config:structuredClone(read)},
      write:{kind:'tool',config:{toolId:'native:write',inputs:{file_path:target,content},cache:'never'}},
      readback:{kind:'tool',config:structuredClone(read)},
      compare:{kind:'code',config:{language:'javascript',code:VERIFIED_COMPARE_CODE,inputs:{target,content,window:{...VERIFIED_READ_WINDOW},existed:'{{exists.exists}}',write:'{{write.value}}',readback:'{{readback.value}}'},outputSchema:[{name:'path',type:'string',required:true},{name:'operation',type:'string',required:true},{name:'check',type:'string',required:true},{name:'checkNote',type:'string',required:true}],timeoutMs:1500}},
    },
    chains:{probe:{nodes:['validate','probe','exists','present']},overwrite:{nodes:['prior','write']},verify:{nodes:['write','readback','compare']}},
    links:{yes:{source:'present',target:'prior',port:'true'},no:{source:'present',target:'write',port:'false'}},
  }
}
