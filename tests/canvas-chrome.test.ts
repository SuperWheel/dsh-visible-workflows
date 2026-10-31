import { describe,expect,it } from 'vitest'
import { canvasChromeLayout } from '../src/client/canvas-chrome.ts'

describe('aligned floating canvas chrome',()=>{
  const heading={left:12,top:12,width:250,height:38},actions={fullWidth:390,iconWidth:250,compactWidth:102,height:38}
  it('keeps both sides on the same row and shortens the title before hiding actions',()=>{
    expect(canvasChromeLayout(960,heading,actions)).toEqual({mode:'full',headingMaxWidth:348,actionsTop:12,inspectorTop:62})
    expect(canvasChromeLayout(576,heading,actions)).toEqual({mode:'full',headingMaxWidth:150,actionsTop:12,inspectorTop:62})
  })
  it('uses icon controls before replacing secondary actions with overflow',()=>{
    expect(canvasChromeLayout(480,heading,actions)).toEqual({mode:'icons',headingMaxWidth:194,actionsTop:12,inspectorTop:62})
  })
  it('preserves readable title space when save buttons consume heading width',()=>{
    const withSave={...heading,minWidth:238}
    expect(canvasChromeLayout(576,withSave,actions)).toMatchObject({mode:'icons',headingMaxWidth:290})
    expect(canvasChromeLayout(480,withSave,actions)).toMatchObject({mode:'overflow',headingMaxWidth:342})
    expect(canvasChromeLayout(664,withSave,actions)).toMatchObject({mode:'full',headingMaxWidth:238})
  })
  it('keeps execution and overflow in one row when the complete group cannot fit',()=>{
    expect(canvasChromeLayout(360,heading,actions)).toEqual({mode:'overflow',headingMaxWidth:222,actionsTop:12,inspectorTop:62})
    expect(canvasChromeLayout(360,heading,{...actions,fullWidth:168}).mode).toBe('full')
  })
  it('keeps every mode on the same 38px row',()=>{
    for(const width of [960,480,360])expect(canvasChromeLayout(width,heading,actions)).toMatchObject({actionsTop:12,inspectorTop:62})
  })
  it('leaves clearance beneath nested breadcrumbs without moving the right group down',()=>{
    for(const width of [960,480,360])expect(canvasChromeLayout(width,{...heading,height:74},actions)).toMatchObject({actionsTop:12,inspectorTop:98})
  })
  it('uses measured boundaries and finite geometry without depending on inspector width',()=>{
    const boundary=24+actions.fullWidth+12+128
    expect(canvasChromeLayout(boundary,heading,actions)).toMatchObject({mode:'full',headingMaxWidth:128})
    expect(canvasChromeLayout(boundary-1,heading,actions).mode).toBe('icons')
    const iconBoundary=24+actions.iconWidth+12+128
    expect(canvasChromeLayout(iconBoundary,heading,actions)).toMatchObject({mode:'icons',headingMaxWidth:128})
    expect(canvasChromeLayout(iconBoundary-1,heading,actions).mode).toBe('overflow')
    expect(canvasChromeLayout(200,heading,{...actions,compactWidth:96}).headingMaxWidth).toBe(68)
    expect(canvasChromeLayout(500,undefined,{fullWidth:168,iconWidth:128,compactWidth:102,height:38})).toEqual({mode:'full',headingMaxWidth:296,actionsTop:12,inspectorTop:62})
    expect(canvasChromeLayout(100,undefined,actions).mode).toBe('full')
  })
  it('bounds missing or non-finite measured dimensions without generating invalid CSS values',()=>{
    for(const width of [0,-1,Number.NaN,Number.POSITIVE_INFINITY]){
      const layout=canvasChromeLayout(width,{...heading,top:Number.NaN,height:Number.POSITIVE_INFINITY},{fullWidth:Number.NaN,iconWidth:Number.POSITIVE_INFINITY,compactWidth:-20,height:Number.NaN})
      expect(layout.mode).toBe('overflow')
      expect(layout.headingMaxWidth).toBe(0)
      expect([layout.actionsTop,layout.inspectorTop].every(value=>Number.isFinite(value)&&value>=0)).toBe(true)
    }
  })
})
