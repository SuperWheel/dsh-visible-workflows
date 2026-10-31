interface HeadingBounds { left:number; top:number; width:number; height:number; minWidth?:number }
interface ActionBounds { fullWidth:number; iconWidth:number; compactWidth:number; height:number }
export type CanvasChromeMode='full'|'icons'|'overflow'
const size=(value:number)=>Number.isFinite(value)?Math.max(0,value):0

/** Top controls use the whole canvas width; an inspector only occludes the canvas below them. */
export function canvasChromeLayout(width:number,heading:HeadingBounds|undefined,actions:ActionBounds) {
  const inset=12,clearance=12,available=Math.max(0,size(width)-inset*2)
  const fullWidth=size(actions.fullWidth),iconWidth=size(actions.iconWidth),compactWidth=size(actions.compactWidth)
  const minimumHeadingWidth=size(heading?.minWidth??128)
  const mode:CanvasChromeMode=!heading||available-fullWidth-clearance>=minimumHeadingWidth?'full':available-iconWidth-clearance>=minimumHeadingWidth?'icons':'overflow'
  const actionWidth=mode==='full'?fullWidth:mode==='icons'?iconWidth:compactWidth
  const headingMaxWidth=Math.max(0,Math.min(348,available-actionWidth-clearance))
  const headingBottom=heading?size(heading.top)+size(heading.height):0
  return {mode,headingMaxWidth,actionsTop:inset,inspectorTop:Math.max(headingBottom,inset+size(actions.height))+clearance}
}
