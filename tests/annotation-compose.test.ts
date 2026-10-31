import { describe, expect, it } from 'vitest'
import { annotationComposeLayout, measureAnnotationCompose } from '../src/client/annotation-compose.ts'

describe('注释实际折行测量',()=>{
  it('始终用胶囊输入宽度决定卡片状态，卡片内容使用展开后的宽度',()=>{
    let width=400
    const reads:number[]=[],mirror={style:{width:''},get scrollHeight(){const measured=Number.parseFloat(this.style.width);reads.push(measured);return measured<350?44:22}}
    const field={scrollHeight:110},compose={getBoundingClientRect:()=>({width})}
    const measure=()=>measureAnnotationCompose(field as HTMLTextAreaElement,mirror as HTMLTextAreaElement,compose as HTMLElement)
    expect(measure()).toEqual({multiline:true,height:44,overflowY:'hidden'})
    expect(measure()).toEqual({multiline:true,height:44,overflowY:'hidden'})
    expect(reads).toEqual([333,374,333,374])
    width=500
    expect(measure()).toEqual({multiline:false,height:22,overflowY:'hidden'})
    expect(reads.at(-1)).toBe(433)
    width=300
    expect(measure()).toEqual({multiline:true,height:44,overflowY:'hidden'})
  })
  it('软折行和显式换行都在五行后滚动，短回一行恢复原高度',()=>{
    expect(annotationComposeLayout(22)).toEqual({multiline:false,height:22,overflowY:'hidden'})
    expect(annotationComposeLayout(44,22)).toEqual({multiline:true,height:44,overflowY:'hidden'})
    expect(annotationComposeLayout(110)).toEqual({multiline:true,height:110,overflowY:'hidden'})
    expect(annotationComposeLayout(176)).toEqual({multiline:true,height:110,overflowY:'auto'})
    expect(annotationComposeLayout(22)).toEqual({multiline:false,height:22,overflowY:'hidden'})
  })
  it('单行删除及间距占用40px，展开卡片仍按完整正文宽度测量',()=>{
    const reads:number[]=[],mirror={style:{width:''},get scrollHeight(){const width=Number.parseFloat(this.style.width);reads.push(width);return width<320?44:22}}
    const field={scrollHeight:22},compose={getBoundingClientRect:()=>({width:400})}
    const measure=(hasDelete:boolean)=>measureAnnotationCompose(field as HTMLTextAreaElement,mirror as HTMLTextAreaElement,compose as HTMLElement,hasDelete)
    expect(measure(false)).toEqual({multiline:false,height:22,overflowY:'hidden'})
    expect(measure(true)).toEqual({multiline:true,height:44,overflowY:'hidden'})
    expect(reads).toEqual([333,293,374])
    expect(measure(false)).toEqual({multiline:false,height:22,overflowY:'hidden'})
  })
})
