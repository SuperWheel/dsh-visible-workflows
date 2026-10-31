import {describe,expect,it} from 'vitest'
import {BUILTIN_TOOLS,toolCatalogView} from '../src/host/tool-catalog.ts'
import {tools} from './fixtures/t18-tools.ts'

describe('visible_workflow_tools view (Desktop r49)',()=>{
  const catalog=[...tools(),...BUILTIN_TOOLS,{...BUILTIN_TOOLS[0]!,id:'mcp:x:y',name:'y',description:'Off. More text.',available:false,unavailableReason:'未连接'}]
  it('lists every tool compactly: no schemas or contracts, first sentence only',()=>{
    const view=toolCatalogView(catalog) as any
    expect(view.tools).toHaveLength(catalog.length)
    expect(JSON.stringify(view)).not.toContain('inputSchema')
    expect(JSON.stringify(view)).not.toContain('operationContract')
    expect(view.tools.find((tool:any)=>tool.id==='builtin:file.stat')).toEqual({id:'builtin:file.stat',name:'文件信息',description:'统计当前工作区内一个文件的字节数、行数、行尾类型和 UTF-8 BOM；只读，不返回内容。'})
    expect(view.tools.find((tool:any)=>tool.id==='mcp:x:y')).toEqual({id:'mcp:x:y',name:'y',description:'Off.',available:false,unavailableReason:'未连接'})
    expect(view.detail).toContain('ids')
    expect(JSON.stringify(view).length).toBeLessThan(JSON.stringify(catalog).length/3)
  })
  it('leaves saved workflows out unless asked, and says how many there are (T31.6)',()=>{
    const flow={...BUILTIN_TOOLS[0]!,id:'workflow:w1',name:'测试流程',description:'在当前工作区执行此流程定义。',category:'workflow' as const}
    const hidden=toolCatalogView([...catalog,flow]) as any
    expect(hidden.tools.some((tool:any)=>tool.id==='workflow:w1')).toBe(false)
    expect(hidden.detail).toContain('另有 1 个已保存工作流')
    const shown=toolCatalogView([...catalog,flow],undefined,true) as any
    expect(shown.tools.at(-1).id).toBe('workflow:w1');expect(shown.detail).not.toContain('已保存工作流')
    expect((toolCatalogView([...catalog,flow],['workflow:w1']) as any).tools).toEqual([flow])
  })
  it('returns the full entries for the ids asked for and names the unknown ones',()=>{
    const view=toolCatalogView(catalog,['native:glob','builtin:nope']) as any
    expect(view.tools).toEqual(catalog.filter(tool=>tool.id==='native:glob'))
    expect(view.missing).toEqual(['builtin:nope'])
  })
})
