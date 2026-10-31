import type { JsonValue } from './types.ts'

export class CachedBodyError extends Error {}
export const HTTP_CACHE_THRESHOLD=262144
export const HTTP_DOWNLOAD_LIMIT=10_000_000
export type CachedBody={ $cachedBody:{id:string;runId:string;bytes:number;sha256:string;contentType:string;preview:string;evicted?:boolean} }
export function isCachedBody(value:unknown):value is CachedBody {
  if(!value||typeof value!=='object'||Array.isArray(value))return false
  const ref=(value as CachedBody).$cachedBody
  return !!ref&&typeof ref==='object'&&typeof ref.id==='string'&&typeof ref.runId==='string'&&Number.isSafeInteger(ref.bytes)&&ref.bytes>=0&&typeof ref.sha256==='string'&&typeof ref.contentType==='string'&&typeof ref.preview==='string'
}
export function mapCachedBodies(value:JsonValue,visit:(ref:CachedBody)=>JsonValue):JsonValue {
  if(isCachedBody(value))return visit(value)
  if(Array.isArray(value))return value.map(item=>mapCachedBodies(item,visit))
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,mapCachedBodies(item,visit)]))
  return value
}
