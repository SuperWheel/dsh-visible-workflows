import {createHash} from 'node:crypto'
import {describe,expect,it} from 'vitest'
import {buildCreateEntry,CREATE_TOOL_DESCRIPTION,requestPaths,requestTools} from '../src/host/planning/create-entry.ts'
import {parsePlanningEntry} from '../src/host/planning/entry.ts'

// The user's own requests from the Desktop r52 acceptance (A then B).
const A='新建工作流「T18 CSV 统计 r52」：统计工作区 t05-recovery 目录下每个 .csv 文件（不含子目录）的行数和文件大小（字节），把结果整理成 Markdown 表格（列：文件名、行数、字节数），保存为工作区文件 t05-recovery/out/csv-stats.md（已存在时覆盖），写入后回读核对。保存后运行一次，并告诉我每个节点的结果。'
const B='新建工作流「T18 CSV 校验和 r52」：用 shasum -a 256 计算工作区 t05-recovery 目录下每个 .csv 文件（不含子目录）的 SHA-256，把结果整理成 Markdown 表格（列：文件名、SHA-256），保存为工作区文件 t05-recovery/out/csv-sha256.md（已存在时覆盖），写入后回读核对。保存后运行一次，并告诉我每个节点的结果。'
const offered=['read','write','edit','glob','grep','bash','web_fetch','workflow_http_request','workflow_html_select','workflow_html_extract_text','workflow_file_stat','todo_write']
const files:Record<string,'file'|'directory'>={'t05-recovery':'directory','t05-recovery/out/csv-stats.md':'file','data/in.csv':'file'}
const facts={workspaceId:'ws',sessionId:'s1',offeredTools:offered,fileKind:(path:string)=>files[path]??'missing' as const,
  digest:(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')}
const admitted=(value:Record<string,unknown>)=>parsePlanningEntry(value,false)

describe('fast create entry (T31)',()=>{
  it('turns the r52 requests into trial requests the ordinary gate admits',()=>{
    const a=buildCreateEntry({title:'T18 CSV 统计 r52',request:A},facts) as any
    expect(a.execution).toEqual({mode:'execute-first',task:A,tools:['read','write','edit','glob','grep','workflow_file_stat'],inputs:[],
      artifacts:[{path:'t05-recovery/out/csv-stats.md',format:'text',checks:[],requireChanged:false}]})
    expect(a).toMatchObject({operation:'create',instruction:A,title:'T18 CSV 统计 r52',requestId:expect.stringMatching(/^create-[0-9a-f]{32}$/)})
    expect(a.moduleCheck.notApplicable).toContain('Host 按需求关键词预判')
    expect(admitted(a).execution).toMatchObject({mode:'execute-first'})
    const b=buildCreateEntry({title:'T18 CSV 校验和 r52',request:B},facts) as any
    expect(b.execution.tools).toEqual(['read','write','edit','glob','grep','bash','workflow_file_stat'])
    expect(b.execution.artifacts.map((row:any)=>row.path)).toEqual(['t05-recovery/out/csv-sha256.md'])
    admitted(b)
  })
  it('keeps the request ID for the same request and changes it only on a requested retry',()=>{
    const id=(input:object)=>(buildCreateEntry({title:'t',request:A,...input},facts) as any).requestId
    expect(id({})).toBe(id({}));expect(id({attempt:2})).not.toBe(id({}))
  })
  it('reads existing files as inputs, written files as artifacts, and leaves patterns and web addresses to the task',()=>{
    expect(requestPaths('把 data/in.csv 的内容整理后写入 out/r.md，再统计 data/*.csv',facts.fileKind)).toEqual({inputs:['data/in.csv'],artifacts:['out/r.md']})
    expect(requestPaths('读取 https://example.com/a.html 的标题，保存到 out/t.json',facts.fileKind)).toEqual({inputs:[],artifacts:['out/t.json']})
    expect(requestPaths('覆盖写入 data/in.csv',facts.fileKind)).toEqual({inputs:[],artifacts:['data/in.csv']})
    expect(requestTools('抓取 https://example.com 的标题保存到 out/t.md',offered)).toEqual(['read','write','edit','glob','grep','workflow_http_request','workflow_html_select','workflow_html_extract_text','workflow_file_stat'])
    expect(requestTools('用 todo_write 记下进度后写入 out/t.md',offered)).toContain('todo_write')
  })
  it('asks for a save location when the request names no file to write',()=>{
    expect(()=>buildCreateEntry({title:'t',request:'统计 t05-recovery 下每个 csv 的行数'},facts)).toThrow(/^CREATE_ARTIFACT_UNKNOWN：/)
  })
  it('copies the checks the user wrote onto the artifact they name',()=>{
    const one=buildCreateEntry({title:'t',request:A,checks:[{kind:'text-includes',value:'文件名'}]},facts) as any
    expect(one.execution.artifacts[0].checks).toEqual([{kind:'text-includes',value:'文件名'}]);admitted(one)
    const two='把 data/in.csv 整理后写入 out/a.md，摘要写入 out/b.md'
    expect(()=>buildCreateEntry({title:'t',request:two,checks:[{kind:'text-includes',value:'x'}]},facts)).toThrow(/^CREATE_CHECK_PATH_REQUIRED：/)
    expect((buildCreateEntry({title:'t',request:two,checks:[{path:'out/b.md',kind:'text-includes',value:'x'}]},facts) as any).execution.artifacts[1].checks).toHaveLength(1)
    expect(()=>buildCreateEntry({title:'t',request:A,checks:[{kind:'text-includes'}]},facts)).toThrow(/^CREATE_CHECK_INVALID：/)
  })
  it('expands checks written in the artifact shape and leaves requireChanged to the Host (Desktop r53 B)',()=>{
    const path='t05-recovery/out/csv-sha256.md',wrote=[{kind:'text-includes',value:'文件名'},{kind:'text-includes',value:'SHA-256'}]
    const entry=buildCreateEntry({title:'t',request:B,checks:[{path,requireChanged:true,checks:wrote}]},facts) as any
    expect(entry.execution.artifacts).toEqual([{path,format:'text',checks:wrote,requireChanged:false}]);admitted(entry)
    expect(()=>buildCreateEntry({title:'t',request:B,checks:[{path,checks:[{kind:'text-includes'}]}]},facts)).toThrow(/^CREATE_CHECK_INVALID：checks\[0\]\.checks\[0\] /)
    expect(()=>buildCreateEntry({title:'t',request:B,checks:[{path,kind:'text-includes',value:'x',checks:wrote}]},facts)).toThrow(/^CREATE_CHECK_INVALID：checks\[0\] /)
    expect(CREATE_TOOL_DESCRIPTION).toContain('不是验收条件，不要据此编 checks')
  })
  it('instantiates the review module when the request gives the target and a fixed draft, else leaves review to generation',()=>{
    const module=buildCreateEntry({title:'周报',request:'写一份周报，内容为「本周完成：无」，每轮人工审核后再写入 reports/week.md'},facts) as any
    expect(module.handoff.module).toEqual({moduleId:'reviewed-file-write',version:'1.0.0',instanceKey:'review',
      parameters:{target:'reports/week.md',producer:{text:'{% if reviewBase or reviewNote %}{{reviewBase}}{% else %}本周完成：无{% endif %}'},maxIterations:3}})
    expect(admitted(module).execution).toEqual({mode:'design-only'})
    const open=buildCreateEntry({title:'周报',request:'汇总 data/in.csv 写成周报，每轮人工审核后再写入 reports/week.md'},facts) as any
    expect(open.execution.mode).toBe('execute-first');expect(open.moduleCheck.notApplicable).toContain('审核后再写')
  })
  it('still instantiates the review module when the main chat restates the fixed draft as a text check (Desktop r57 D)',()=>{
    const request='写一份周报，内容为「本周完成：T34 回归测试」，每轮人工审核后再写入工作区文件 reports/r57-week.md。保存后运行一次，并告诉我每个节点的结果。'
    const restated=buildCreateEntry({title:'T34 周报审核 r57',request,checks:[{kind:'text-includes',path:'reports/r57-week.md',value:'本周完成：T34 回归测试'}]},facts) as any
    expect(restated.handoff.module).toMatchObject({moduleId:'reviewed-file-write',parameters:{target:'reports/r57-week.md'}})
    expect(admitted(restated).execution).toEqual({mode:'design-only'})
    // No trial, but the Host still runs the saved module once (Desktop r59 D).
    expect(admitted(restated).request.runAfterSave).toBe(true)
    const other=buildCreateEntry({title:'周报',request,checks:[{kind:'text-includes',value:'下周计划'}]},facts) as any
    expect(other.handoff).toBeUndefined();expect(other.execution.artifacts[0].checks).toEqual([{kind:'text-includes',value:'下周计划'}])
  })
})
