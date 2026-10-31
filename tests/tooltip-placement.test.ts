import {describe,expect,it} from 'vitest'
import {tooltipSide} from '../src/client/tooltip-placement.ts'
const anchor={left:400,right:480,top:55,bottom:83},size={width:80,height:26},viewport={width:1015,height:977}
describe('action tooltip avoids neighboring controls',()=>{
 it('prefers below when both sides are clear',()=>expect(tooltipSide(anchor,size,viewport,[])).toBe('bottom'))
 it('moves above a readiness header instead of covering its controls',()=>expect(tooltipSide(anchor,size,viewport,[{left:300,right:700,top:100,bottom:142}])).toBe('top'))
 it('keeps below when the top would cover a host tab',()=>expect(tooltipSide(anchor,size,viewport,[{left:300,right:700,top:0,bottom:38}])).toBe('bottom'))
 it('keeps long descriptions within the viewport',()=>expect(tooltipSide({...anchor,top:20,bottom:48},{width:300,height:86},viewport,[],'top')).toBe('bottom'))
 it('moves above controls near the bottom of the window',()=>expect(tooltipSide({...anchor,top:930,bottom:958},size,viewport,[])).toBe('top'))
})
