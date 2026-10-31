export interface AnnotationAnchor { left: number; right: number; top: number; bottom: number }
export function annotationPlacement(anchor: AnnotationAnchor, popup: { width: number; height: number }, viewport: { width: number; height: number }, margin = 16, gap = 10) {
  const y = (anchor.top + anchor.bottom) / 2
  const rightStart = Math.max(anchor.left, anchor.right) + gap, leftEnd = Math.min(anchor.left, anchor.right) - gap
  const rightSpace = viewport.width - margin - rightStart, leftSpace = leftEnd - margin
  const side = rightSpace >= popup.width ? 'right' : leftSpace >= popup.width ? 'left' : rightSpace >= leftSpace ? 'right' : 'left'
  const desiredLeft = side === 'right' ? rightStart : leftEnd - popup.width
  const left = Math.max(margin, Math.min(desiredLeft, viewport.width - margin - popup.width))
  const top = Math.max(margin, Math.min(y - popup.height / 2, viewport.height - margin - popup.height))
  return { left, top, side } as const
}

/** Reserve only the capsules that exist: '+' always, and '…' only when targets overflow. */
export function visibleAnnotationTargets(widths: readonly number[], availableWidth: number, gap = 6, addWidth = 28, moreWidth = 28): number {
  if (!widths.length) return 0
  if (widths.reduce((sum, width) => sum + width, 0) + widths.length * gap + addWidth <= availableWidth) return widths.length
  let occupied = addWidth + moreWidth + gap, count = 0
  for (let index = 0; index < widths.length - 1; index++) {
    occupied += widths[index]! + gap
    if (occupied > availableWidth) break
    count++
  }
  return count
}
