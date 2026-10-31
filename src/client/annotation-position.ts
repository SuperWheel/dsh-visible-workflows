/** One temporary annotation marker in a particular canvas graph's world coordinates. */
export interface AnnotationPosition { x:number; y:number; scopePath:string[] }

export function isAnnotationPosition(value:unknown):value is AnnotationPosition {
  if(!value||typeof value!=='object'||Array.isArray(value))return false
  const position=value as Record<string,unknown>
  return typeof position.x==='number'&&Number.isFinite(position.x)&&typeof position.y==='number'&&Number.isFinite(position.y)
    &&Array.isArray(position.scopePath)&&Array.from(position.scopePath).every(id=>typeof id==='string')
}

export function cloneAnnotationPosition(position:AnnotationPosition):AnnotationPosition {
  return {x:position.x,y:position.y,scopePath:[...position.scopePath]}
}
