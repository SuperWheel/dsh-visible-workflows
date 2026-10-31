import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const cursorSchema=z.object({version:z.literal(1),taskId:z.string(),sessionId:z.string(),workspaceId:z.string(),
  events:z.record(z.string(),z.number().int().nonnegative().safe()),waitId:z.string().uuid()}).strict()
type Scope={taskId:string;sessionId:string;workspaceId:string}

function parseCursor(after:string) {
  try{
    if(after.length>16_000||!/^[A-Za-z0-9_-]+$/.test(after))throw new Error()
    const bytes=Buffer.from(after,'base64url')
    // Buffer decoding is permissive; reject ignored characters and noncanonical bits.
    if(bytes.toString('base64url')!==after)throw new Error()
    return cursorSchema.parse(JSON.parse(bytes.toString('utf8')))
  }catch{
    throw new Error('规划事件游标无效（event_cursor）；请不带 event_cursor 重新调用，或使用最近一次返回的 cursor。')
  }
}

/** Cursor is data, never authority. Every wait still reads through planningCaller.
 * A fresh waitId also makes a quiet timeout's next call distinct in the SDK.
 */
export function planningWaitDelta(view:Record<string,any>,scope:Scope,after?:string) {
  let seen:Record<string,number>={}
  if(after!==undefined&&after.trim()!==''){
    const cursor=parseCursor(after)
    if(cursor.taskId!==scope.taskId||cursor.sessionId!==scope.sessionId||cursor.workspaceId!==scope.workspaceId)throw new Error('规划事件游标不属于当前任务或主对话')
    seen=cursor.events
  }
  const next={...seen}
  const project=(row:Record<string,any>):Record<string,any>=>{
    const key=row.linkedTaskId??row.taskId
    const events=(row.events??[]) as {sequence:number}[]
    if(events.length)next[key]=Math.max(seen[key]??0,...events.map(event=>event.sequence))
    return {...row,...(row.events?{events:events.filter(event=>event.sequence>(seen[key]??0))}:{}),...(row.planning?{planning:project(row.planning)}:{})}
  }
  return {...project(view),event_cursor:Buffer.from(JSON.stringify({...scope,version:1,events:next,waitId:randomUUID()})).toString('base64url')}
}
