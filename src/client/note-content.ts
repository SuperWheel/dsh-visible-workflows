/** Shared safe subset of note formatting. This parser never evaluates HTML or links. */
export interface NoteInline { kind:'text'|'strong'|'code'; text:string }
export type NoteBlock = {kind:'heading';content:NoteInline[]} | {kind:'paragraph';content:NoteInline[]} | {kind:'list';ordered:boolean;start:number;items:NoteInline[][]}

export function parseNoteInline(text:string):NoteInline[]{
 return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map(part=>part.startsWith('**')&&part.endsWith('**')?{kind:'strong',text:part.slice(2,-2)}:part.startsWith('`')&&part.endsWith('`')?{kind:'code',text:part.slice(1,-1)}:{kind:'text',text:part})
}
export function parseNoteContent(text:string):NoteBlock[]{
 const lines=text.replace(/\r\n?/g,'\n').split('\n'),blocks:NoteBlock[]=[]
 const heading=(line:string)=>/^(#{1,3})\s+(.+)$/.exec(line)
 const list=(line:string)=>/^\s*(?:([-*•])|([0-9]+)[.)])\s+(.+)$/.exec(line)
 for(let index=0;index<lines.length;){
  const line=lines[index]!
  if(!line.trim()){index++;continue}
  const title=heading(line)
  if(title){blocks.push({kind:'heading',content:parseNoteInline(title[2]!)});index++;continue}
  const first=list(line)
  if(first){
   const ordered=!!first[2],items:NoteInline[][]=[]
   while(index<lines.length){const item=list(lines[index]!);if(!item||!!item[2]!==ordered)break;items.push(parseNoteInline(item[3]!));index++}
   blocks.push({kind:'list',ordered,start:ordered?Number(first[2]):1,items});continue
  }
  const paragraph=[line];index++
  while(index<lines.length&&lines[index]!.trim()&&!heading(lines[index]!)&&!list(lines[index]!)){paragraph.push(lines[index]!);index++}
  blocks.push({kind:'paragraph',content:parseNoteInline(paragraph.join('\n'))})
 }
 return blocks
}

export interface NoteTextStyle {fontSize:number;weight:400|600;code:boolean}
export type NoteTextMeasure=(text:string,style:NoteTextStyle)=>number
const escapeXML=(text:string)=>text.replace(/[<>&"']/g,char=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[char]!))
const estimateText:NoteTextMeasure=(text,style)=>Array.from(text).reduce((sum,char)=>sum+(style.code ? .6 : /\s/.test(char) ? .33 : char.codePointAt(0)!>255 ? 1 : .55)*style.fontSize,0)

/** Pure SVG keeps the exported note readable in viewers without HTML foreignObject support.
 * Padding, type sizes, line height and block margins mirror the canvas note stylesheet.
 * The browser supplies its actual font metrics; the fallback supports headless exports/tests.
 */
export function noteContentSvg(blocks:readonly NoteBlock[],width:number,foreground:string,measure:NoteTextMeasure=estimateText):string{
 const result:string[]=[],lineHeight=23,contentWidth=Math.max(1,width-32),color=escapeXML(foreground)
 let top=22,previousMargin=0
 const paragraph=(parts:readonly NoteInline[],heading=false,indent=0,marker?:string)=>{
  const left=16+indent,right=16+contentWidth,baseStyle:NoteTextStyle={fontSize:heading?15:14,weight:heading?600:400,code:false}
  let x=left,y=top,lineHasContent=false
  const nextLine=()=>{x=left;y+=lineHeight;lineHasContent=false}
  const place=(text:string,style:NoteTextStyle)=>{
   if(!text)return
   const padding=style.code?4:0,textWidth=measure(text,style),itemWidth=textWidth+padding*2
   if(lineHasContent&&x+itemWidth>right)nextLine()
   // A single long word/code span may wrap; shorter words stay intact like the canvas.
   if(itemWidth>right-left&&Array.from(text).length>1){
    let fragment=''
    for(const character of Array.from(text)){
     if(fragment&&measure(fragment+character,style)+padding*2>right-left){place(fragment,style);nextLine();fragment=''}
     fragment+=character
    }
    place(fragment,style);return
   }
   if(style.code)result.push(`<rect x="${x}" y="${y+1}" width="${itemWidth}" height="20" rx="4" fill="${color}" fill-opacity=".05"/>`)
   result.push(`<text x="${x+padding}" y="${y+17}" fill="${color}" font-size="${style.fontSize}" font-weight="${style.weight}"${style.code?' font-family="monospace"':''} xml:space="preserve">${escapeXML(text)}</text>`)
   x+=itemWidth;lineHasContent=true
  }
  if(marker)result.push(`<text x="${left-6}" y="${top+17}" text-anchor="end" fill="${color}" font-size="14">${escapeXML(marker)}</text>`)
  for(const part of parts){
   const style:NoteTextStyle={fontSize:part.kind==='code'?12:baseStyle.fontSize,weight:part.kind==='strong'?600:baseStyle.weight,code:part.kind==='code'}
   // Code gets one background per run; ordinary whitespace and explicit newlines are retained.
   const tokens=part.kind==='code'?part.text.split(/(\n)/):part.text.match(/\n|[^\S\n]+|[\p{L}\p{N}_]+|[^\s]/gu)||[]
   for(const token of tokens){if(token==='\n'){nextLine();continue}place(token,style)}
  }
  top=y+lineHeight
 }
 blocks.forEach((block,index)=>{
  top+=index?Math.max(previousMargin,block.kind==='heading'?16:0):0
  if(block.kind==='list'){
   block.items.forEach((item,itemIndex)=>{if(itemIndex)top+=2;paragraph(item,false,20,block.ordered?`${block.start+itemIndex}.`:'•')})
  }else paragraph(block.content,block.kind==='heading')
  previousMargin=block.kind==='heading'?12:14
 })
 return result.join('')
}
