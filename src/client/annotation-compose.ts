export const ANNOTATION_LINE_HEIGHT=22
export const ANNOTATION_MAX_TEXT_HEIGHT=110
// Compact: border 2 + left/right padding 16/7 + gap 8 + arrow 34.
export const ANNOTATION_COMPACT_RESERVED=67
// Optional delete control 32 + its gap before the arrow 8.
export const ANNOTATION_COMPACT_DELETE_RESERVED=40
// Expanded: border 2 + left/right padding 12/12.
export const ANNOTATION_EXPANDED_RESERVED=26

export function annotationComposeLayout(compactHeight:number,expandedHeight=compactHeight,lineHeight=ANNOTATION_LINE_HEIGHT) {
  const multiline=compactHeight>lineHeight+1,contentHeight=multiline?expandedHeight:compactHeight
  return {multiline,height:Math.max(multiline?lineHeight*2:lineHeight,Math.min(ANNOTATION_MAX_TEXT_HEIGHT,contentHeight)),overflowY:contentHeight>ANNOTATION_MAX_TEXT_HEIGHT?'auto' as const:'hidden' as const}
}

/** A nonanimated mirror reads real wrapping at the pill's stable input width.
 * The card may use its full width without making the threshold oscillate. */
export function measureAnnotationCompose(field:HTMLTextAreaElement,mirror:HTMLTextAreaElement|null,compose:HTMLElement|null,hasDelete=false) {
  const width=compose?.getBoundingClientRect().width??0
  const reserved=ANNOTATION_COMPACT_RESERVED+(hasDelete?ANNOTATION_COMPACT_DELETE_RESERVED:0)
  if(!mirror||width<=reserved)return annotationComposeLayout(field.scrollHeight)
  const measure=(reserved:number)=>{mirror.style.width=`${Math.max(1,width-reserved)}px`;return mirror.scrollHeight}
  const compactHeight=measure(reserved)
  return annotationComposeLayout(compactHeight,compactHeight>ANNOTATION_LINE_HEIGHT+1?measure(ANNOTATION_EXPANDED_RESERVED):compactHeight)
}
