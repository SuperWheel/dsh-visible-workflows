export interface TooltipRect {left:number;right:number;top:number;bottom:number}
const area=(a:TooltipRect,b:TooltipRect)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top))
/** Prefer the requested side, but keep neighboring controls and viewport edges clear. */
export function tooltipSide(anchor:TooltipRect,size:{width:number;height:number},viewport:{width:number;height:number},obstacles:TooltipRect[],preferred:'top'|'bottom'='bottom'):'top'|'bottom'{
  const left=Math.max(12,Math.min((anchor.left+anchor.right-size.width)/2,viewport.width-12-size.width)),right=left+size.width
  const score=(side:'top'|'bottom')=>{const top=side==='top'?anchor.top-8-size.height:anchor.bottom+8,bubble={left,right,top,bottom:top+size.height};const clipped=area(bubble,bubble)-area(bubble,{left:12,right:viewport.width-12,top:12,bottom:viewport.height-12});return clipped*100+obstacles.reduce((sum,obstacle)=>sum+area(bubble,obstacle),0)+(side===preferred?0:1)}
  return score('top')<score('bottom')?'top':'bottom'
}
