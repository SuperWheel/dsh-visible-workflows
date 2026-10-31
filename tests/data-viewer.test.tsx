import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataViewer, inspectData } from '../src/client/data-viewer.tsx'
import { ExecutionDetails, executionDuration } from '../src/client/execution-details.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Tooltip:({children}:{children:React.ReactNode})=><>{children}</>,Modal:({children,open}:{children:React.ReactNode;open:boolean})=>open?<div role="dialog">{children}</div>:null}))
const renderers: ReactTestRenderer[] = []
function render(element: React.ReactElement) { let r!:ReactTestRenderer;act(()=>{r=create(element)});renderers.push(r);return r }
afterEach(()=>{renderers.splice(0).forEach(r=>act(()=>r.unmount()));vi.unstubAllGlobals()})
describe('structured run values',()=>{
  it.each([false,true])('shows cached size, digest and retained preview with eviction=%s',evicted=>{
    const value={$cachedBody:{id:'entry',runId:'run',bytes:535000,sha256:'abc123',contentType:'text/html',preview:'<main>preview</main>',evicted}}
    const r=render(<DataViewer title="响应" value={value}/>),text=JSON.stringify(r.toJSON())
    expect(text).toContain(evicted?'响应正文已清理':'响应正文已缓存');expect(text).toContain('535,000');expect(text).toContain('abc123');expect(text).toContain('<main>preview</main>')
  })
  it('distinguishes plain text, missing values and JSON data without discarding falsy values',()=>{
    expect(inspectData('Hello, Harness').structured).toBe(false)
    expect(inspectData('{"count":0,"ok":false,"empty":"","nothing":null}').structured).toBe(true)
    const r=render(<DataViewer title="结构化输出" value={{count:0,ok:false,empty:'',nothing:null}}/>),text=JSON.stringify(r.toJSON())
    expect(text).toContain('vdw-data-number');expect(text).toContain('vdw-data-boolean');expect(text).toContain('vdw-data-null')
    expect(text).toContain('false');expect(text).toContain('\\"\\"')
  })
  it('collapses nested values until requested and bounds the initial rows for large arrays',()=>{
    const value={nested:{answer:'revealed'},items:Array.from({length:101},(_,i)=>i)},r=render(<DataViewer title="输出" value={value}/>)
    expect(JSON.stringify(r.toJSON())).not.toContain('revealed')
    const folds=r.root.findAllByProps({className:'vdw-data-fold'})
    act(()=>folds[0]!.props.onClick());expect(JSON.stringify(r.toJSON())).toContain('revealed')
    act(()=>folds[1]!.props.onClick());expect(r.root.findByProps({className:'vdw-data-more'}).children.join('')).toContain('共 101 项')
    expect(r.root.findAllByProps({className:'vdw-data-row'})).toHaveLength(43)
  })
  it('copies the full original JSON even when display is folded or paginated',async()=>{
    const raw=' {"values": ['+Array.from({length:101},(_,i)=>i).join(',')+']} ',writeText=vi.fn(async()=>{})
    vi.stubGlobal('navigator',{clipboard:{writeText}})
    const r=render(<DataViewer title="输出" value={raw}/>)
    await act(async()=>{await r.root.findByProps({'aria-label':'复制输出'}).props.onClick()})
    expect(writeText).toHaveBeenCalledWith(raw);expect(r.root.findByProps({role:'status'}).children).toEqual(['已复制'])
  })
  it('switches to numbered highlighted JSON and reports clipboard failure without removing the payload',async()=>{
    vi.stubGlobal('navigator',{clipboard:{writeText:vi.fn(async()=>{throw new Error('denied')})}})
    const r=render(<DataViewer title="输出" value={{answer:42}}/>)
    act(()=>r.root.findAllByType('button').find(b=>b.children.includes('JSON'))!.props.onClick())
    expect(r.root.findAllByProps({className:'vdw-data-line-numbers'})).toHaveLength(1)
    expect(r.root.findAllByProps({className:'vdw-syntax-property'}).length).toBeGreaterThan(0)
    await act(async()=>{await r.root.findByProps({'aria-label':'复制输出'}).props.onClick()})
    expect(r.root.findByProps({role:'status'}).children.join('')).toContain('复制失败')
    expect(JSON.stringify(r.toJSON())).toContain('answer')
  })
  it('shows the original JSON without rounding integers beyond safe precision',()=>{
    const raw='{"id":9007199254740993}',r=render(<DataViewer title="输出" value={raw}/>)
    expect(inspectData(raw).fieldsSafe).toBe(false)
    expect(JSON.stringify(r.toJSON())).toContain('9007199254740993')
    expect(JSON.stringify(r.toJSON())).not.toContain('9007199254740992')
  })
  it('opens data in the shared workspace and keeps the selected JSON view after closing',()=>{
    const r=render(<DataViewer title="结构化输出" value={{text:'保留原始值',count:0}}/>)
    act(()=>r.root.findByProps({'aria-label':'展开结构化输出'}).props.onClick())
    const expanded=r.root.findByProps({'aria-label':'结构化输出（展开）'})
    act(()=>expanded.findAllByType('button').find(b=>b.children.includes('JSON'))!.props.onClick())
    expect(expanded.findAllByProps({className:'vdw-data-line-numbers'})).toHaveLength(1)
    expect(JSON.stringify(r.toJSON())).toContain('保留原始值')
    act(()=>r.root.findByProps({'aria-label':'关闭展开结构化输出'}).props.onClick())
    expect(r.root.findAllByProps({role:'dialog'})).toHaveLength(0)
    expect(r.root.findAllByType('button').find(b=>b.children.includes('JSON'))!.props['aria-pressed']).toBe(true)
  })
  it('uses the same real execution values for node detail and run detail with localized status and bounded duration',()=>{
    const r=render(<ExecutionDetails execution={{nodeId:'n',title:'输出',number:'a-3',status:'success',input:'',output:'0',data:{text:'0'},startedAt:'2026-10-16T00:00:00Z',endedAt:'2026-10-16T00:00:00.032Z'}}/>)
    expect(r.root.findByProps({className:'vdw-result-status','data-status':'success'}).children).toContain('已完成')
    expect(r.root.findAllByType(DataViewer).map(d=>d.props.value)).toEqual(['','0',{text:'0'}])
    expect(executionDuration('not-a-date','2026-10-16')).toBeUndefined()
    expect(executionDuration('2026-10-16T00:00:01Z','2026-10-16T00:00:00Z')).toBeUndefined()
    expect(executionDuration('2026-10-16T00:00:00Z','2026-10-16T00:00:00.032Z')).toBe('32 ms')
  })
})
