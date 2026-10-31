import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { statWorkspaceFile } from '../src/host/file-stat.ts'
import { ToolCatalog } from '../src/host/tool-catalog.ts'
import { builtinToolOperation } from '../src/shared/tool-operation-contract.ts'
import { BUILTIN_TOOLS } from '../src/shared/builtin-tools.ts'

const dirs:string[]=[]
afterEach(()=>{for(const path of dirs.splice(0))rmSync(path,{recursive:true,force:true})})
function workspace(files:Record<string,string|Buffer>):string{
  const root=mkdtempSync(join(tmpdir(),'file-stat-'));dirs.push(root)
  for(const [path,content] of Object.entries(files)){mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),content)}
  return root
}
const stat=(root:string,path:string)=>statWorkspaceFile(root,path,new AbortController().signal)

describe('builtin:file.stat',()=>{
  it('counts the bytes on disk, BOM and CR included, which decoded text loses (Desktop r48)',async()=>{
    const root=workspace({'data/a.csv':'﻿id,name\r\n1,甲\r\n','b.txt':'a\nb\nc','c.txt':'a\rb\r','d.txt':'a\r\nb\nc\r','e.txt':''})
    expect(await stat(root,'data/a.csv')).toEqual({text:'data/a.csv：19 字节，2 行，行尾 crlf，有 UTF-8 BOM',path:'data/a.csv',name:'a.csv',bytes:19,lines:2,lineEnding:'crlf',endsWithNewline:true,bom:true})
    expect(await stat(root,'b.txt')).toMatchObject({bytes:5,lines:3,lineEnding:'lf',endsWithNewline:false,bom:false})
    expect(await stat(root,'c.txt')).toMatchObject({lines:2,lineEnding:'cr',endsWithNewline:true})
    expect(await stat(root,'d.txt')).toMatchObject({lines:3,lineEnding:'mixed'})
    expect(await stat(root,'e.txt')).toMatchObject({bytes:0,lines:0,lineEnding:'none',endsWithNewline:false})
    expect(await stat(root,join(root,'b.txt'))).toMatchObject({path:'b.txt',bytes:5})
  })
  it('keeps a CRLF split across read chunks as one line break',async()=>{
    const root=workspace({'big.txt':Buffer.concat([Buffer.alloc(64*1024-1,0x61),Buffer.from('\r\nz\r\n')])})
    expect(await stat(root,'big.txt')).toMatchObject({lines:2,lineEnding:'crlf'})
  })
  it('refuses files outside the workspace, links out of it, directories and missing files',async()=>{
    const outside=workspace({'secret.txt':'x'}),root=workspace({'dir/a.txt':'a'})
    symlinkSync(join(outside,'secret.txt'),join(root,'link.txt'))
    await expect(stat(root,'../x.txt')).rejects.toThrow('只能统计当前工作区内的文件')
    await expect(stat(root,join(outside,'secret.txt'))).rejects.toThrow('只能统计当前工作区内的文件')
    await expect(stat(root,'link.txt')).rejects.toThrow('符号链接越界')
    await expect(stat(root,'dir')).rejects.toThrow('不是普通文件')
    await expect(stat(root,'none.txt')).rejects.toThrow('文件不存在')
  })
  it('runs through the catalog against the run workspace and declares a known read-only contract',async()=>{
    const root=workspace({'a.csv':'x\n'}),catalog=new ToolCatalog({directory:workspace({}),workflows:()=>[],nativeTools:()=>[],executeNative:async()=>({}),runWorkflow:async()=>({}),http:async()=>({}),workspaceRoot:id=>{expect(id).toBe('w');return root}})
    const request={workspaceId:'w',runId:'r',signal:new AbortController().signal} as Parameters<ToolCatalog['execute']>[2]
    expect(await catalog.execute('builtin:file.stat',{path:'a.csv'},request)).toMatchObject({bytes:2,lines:1})
    await expect(catalog.execute('builtin:file.stat',{},request)).rejects.toThrow('工具参数无效')
    const contract=builtinToolOperation(BUILTIN_TOOLS.find(tool=>tool.id==='builtin:file.stat')!)
    expect(contract).toMatchObject({status:'known',source:'plugin-builtin',declaration:{sourceId:'builtin-tool:file.stat',scope:{owner:'none',target:'canonical-filesystem-path'},action:{kind:'other'}}})
    expect(contract.status==='known'&&contract.declaration.stateEffects.join()).toContain('不修改文件')
  })
})
