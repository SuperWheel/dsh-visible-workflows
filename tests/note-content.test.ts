import { describe, expect, it, vi } from 'vitest'
import { noteContentSvg, parseNoteContent } from '../src/client/note-content.ts'
import { svgForWorkflow } from '../src/client/canvas.tsx'
import { makeWorkflow } from '../src/shared/types.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Menu:'menu',Tooltip:'span'}))

describe('shared canvas note formatting and SVG export',()=>{
 it('shares headings, inline styles and ordered list starts without evaluating HTML',()=>{
  expect(parseNoteContent('## 说明\r\n\r\n**重要**，保留 `x`\r\n下一行\r\n\r\n7. 阅读\r\n8. <img src=x>')).toEqual([
   {kind:'heading',content:[{kind:'text',text:'说明'}]},
   {kind:'paragraph',content:[{kind:'strong',text:'重要'},{kind:'text',text:'，保留 '},{kind:'code',text:'x'},{kind:'text',text:'\n下一行'}]},
   {kind:'list',ordered:true,start:7,items:[[{kind:'text',text:'阅读'}],[{kind:'text',text:'<img src=x>'}]]},
  ])
 })
 it('preserves formatting in the exported workflow without raw Markdown or HTML injection',()=>{
  const flow=makeWorkflow('w'),text='# 说明\n\n**重要**：保留 `input_text`\n\n- 第一步\n\n7. 阅读\n8. 确认\n\n<script>alert("a&b")</script>'
  flow.notes=[{id:'n',x:10,y:20,text,width:420,height:500,color:'yellow'}]
  const before=JSON.stringify(flow),svg=svgForWorkflow(flow)
  expect(svg).not.toContain('# 说明');expect(svg).not.toContain('**重要**');expect(svg).not.toContain('`input_text`')
  expect(svg).toMatch(/font-size="15" font-weight="600"[^>]*>说明<\/text>/)
  expect(svg).toMatch(/font-size="14" font-weight="600"[^>]*>重要<\/text>/)
  expect(svg).toMatch(/font-family="monospace"[^>]*>input_text<\/text>/)
  expect(svg).toContain('>•</text>');expect(svg).toContain('>7.</text>');expect(svg).toContain('>8.</text>')
  expect(svg).toContain('&lt;');expect(svg).toContain('&amp;');expect(svg).not.toContain('<script>');expect(svg).not.toContain('<foreignObject')
  expect(svg).toContain('clip-path="url(#note-clip-0)"');expect(svg).toContain('#ffe975 14%')
  expect(JSON.stringify(flow)).toBe(before)
 })
 it('keeps line breaks, long words and code within the note content width',()=>{
  const svg=noteContentSvg(parseNoteContent('abcdefghij\n`1234567890`'),80,'#222',(text)=>Array.from(text).length*8)
  expect(svg).toContain('>abcdef</text>');expect(svg).toContain('>ghij</text>')
  expect(svg).toContain('>12345</text>');expect(svg).toContain('>67890</text>')
  expect(svg).toContain('y="39"');expect(svg).toContain('y="62"');expect(svg).toContain('y="85"');expect(svg).toContain('y="108"')
  const rects=[...svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)]
  expect(rects.length).toBe(2);expect(rects.every(match=>Number(match[1])+Number(match[2])<=64)).toBe(true)
 })
 it('applies the same block spacing and font metrics as visible headings and paragraphs',()=>{
  const measure=vi.fn((text:string)=>text.length*7)
  const svg=noteContentSvg(parseNoteContent('# 标题\n\n**正文**\n\n下一段'),280,'#222',measure)
  expect(svg).toMatch(/y="39"[^>]*font-size="15" font-weight="600"[^>]*>标题/)
  expect(svg).toMatch(/y="74"[^>]*font-size="14" font-weight="600"[^>]*>正文/)
  expect(svg).toMatch(/y="111"[^>]*>下一段/)
  expect(measure).toHaveBeenCalledWith('正文',{fontSize:14,weight:600,code:false})
 })
})
